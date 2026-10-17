import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { redact } from '../src/collectors/util';

const env = { ENVIRONMENT: 'development', DB: {} as D1Database, ASSETS: {} as Fetcher } as never;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('security', () => {
  it('redacts credentials echoed in upstream errors', () => {
    const body = '{"error":{"message":"Incorrect API key provided: sk-admin-AbCdEfGh1234****wxyz"}} Bearer abc.def.ghi api_key: sk-ant-admin01-SECRET';
    const out = redact(body);
    expect(out).not.toMatch(/AbCdEfGh|wxyz|abc\.def|SECRET/);
    expect(out).toContain('Bearer …');
  });

  it('refuses cross-site POSTs to /api/collect before doing any work', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/collect', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } }), env, ctx);
    expect(res.status).toBe(403);
  });

  it('fails closed with security headers when Access is not configured', async () => {
    const res = await worker.fetch(new Request('https://usage.example.com/api/usage'), { DB: {}, ASSETS: {} } as never, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('ignores the dev bypass on any non-localhost host', async () => {
    const res = await worker.fetch(new Request('https://usage.example.com/api/usage'), env, ctx);
    expect(res.status).toBe(503);
  });
});
