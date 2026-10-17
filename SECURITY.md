# Security policy

This dashboard handles read-only API tokens and an Anthropic Admin key, and shows usage and spend data, so security reports are welcome.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab → Advisories), not in a public issue. Include the affected file or endpoint, steps to reproduce, and the impact you expect.

You can expect an acknowledgement within a few days. Fixes are released as a new version, and reporters are credited unless they prefer otherwise.

## Scope

In scope: the Worker (`src/`), the dashboard (`public/`), and the setup and demo scripts (`scripts/`).

Out of scope: your own Cloudflare Access configuration, the permissions you grant to your API tokens, and vulnerabilities in Cloudflare, Anthropic or OpenAI services themselves.

## Deployment hardening

- Keep the dashboard behind Cloudflare Access with an **Allow** policy. A **Bypass** policy lets requests reach the Worker without a token, and the Worker then refuses them.
- Use the read-only Cloudflare token permissions listed in the README, and rotate any key that may have been exposed.
