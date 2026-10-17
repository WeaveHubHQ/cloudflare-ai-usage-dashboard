// Defense in depth behind Cloudflare Access: verify the Cf-Access-Jwt-Assertion
// header (RS256, signed by the team's Access certs) and its audience tag, so a
// request that reaches the Worker without passing Access is rejected.

interface Jwk extends JsonWebKey { kid: string }
let certs: { keys: Jwk[]; at: number } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function keysFor(teamDomain: string, forceRefresh = false): Promise<Jwk[]> {
  // Refresh hourly, or at most once a minute when a token names a key we don't have (key rotation).
  if (!certs || Date.now() - certs.at > 3600_000 || (forceRefresh && Date.now() - certs.at > 60_000)) {
    const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!r.ok) throw new Error(`Access certs ${r.status}`);
    certs = { keys: ((await r.json()) as { keys: Jwk[] }).keys, at: Date.now() };
  }
  return certs.keys;
}

/** Returns the verified email, or null if the token is missing or invalid. */
export async function verifyAccess(token: string | null | undefined, teamDomain: string, aud: string): Promise<string | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = json(parts[0]), payload = json(parts[1]);
    if (header.alg !== 'RS256') return null;
    const jwk = (await keysFor(teamDomain)).find((k) => k.kid === header.kid)
      ?? (await keysFor(teamDomain, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const now = Date.now() / 1000;
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!ok || !auds.includes(aud) || typeof payload.exp !== 'number' || payload.exp < now || payload.iss !== `https://${teamDomain}`) return null;
    return payload.email ?? payload.sub ?? 'service-token';
  } catch {
    return null;
  }
}
