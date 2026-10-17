import { describe, expect, it } from 'vitest';
import { attribute, loadConfig, matches, UNATTRIBUTED, type DashboardConfig } from '../src/config';

const cfg: DashboardConfig = {
  title: 't', theme: 'neutral', gateways: [],
  apps: [
    { id: 'shop', name: 'Shop', match: { worker: ['shop-*'], d1: ['shop-db'], anthropic_key: ['shop-*'] } },
    { id: 'shop-marketing', name: 'Never wins', match: { worker: ['shop-marketing'] } },
    { id: 'shared', name: 'Shared', shared: true, match: { worker: ['*-site', '*-marketing'] } },
  ],
};

describe('attribution', () => {
  it('matches globs case-insensitively and anchors both ends', () => {
    expect(matches(['shop-*'], 'SHOP-api')).toBe(true);
    expect(matches(['shop-*'], 'myshop-api')).toBe(false);
    expect(matches(['a.b'], 'axb')).toBe(false); // regex metacharacters are literal
  });

  it('first matching app wins, so specific apps beat broad shared patterns', () => {
    expect(attribute(cfg, 'worker', 'shop-marketing')).toBe('shop');
    expect(attribute(cfg, 'worker', 'blog-site')).toBe('shared');
  });

  it('keeps resource kinds separate', () => {
    expect(attribute(cfg, 'd1', 'shop-api')).toBe(UNATTRIBUTED);
    expect(attribute(cfg, 'd1', 'shop-db')).toBe('shop');
  });

  it('matches any of several names (key id or display name)', () => {
    expect(attribute(cfg, 'anthropic_key', 'apikey_01abc', 'shop-prod')).toBe('shop');
    expect(attribute(cfg, 'anthropic_key', 'apikey_01abc', null)).toBe(UNATTRIBUTED);
  });

  it('ships valid profiles with unique app ids and a shared bucket', () => {
    for (const p of ['example']) {
      const c = loadConfig(p);
      const ids = c.apps.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain('shared');
      expect(ids).not.toContain(UNATTRIBUTED);
    }
    expect(() => loadConfig('nope')).toThrow(/Unknown CONFIG_PROFILE/);
  });

  it('example profile attributes its resources', () => {
    const e = loadConfig('example');
    expect(attribute(e, 'worker', 'storefront-api')).toBe('storefront');
    expect(attribute(e, 'gateway', 'support')).toBe('support');
    expect(attribute(e, 'anthropic_key', 'apikey_x', 'support-escalations')).toBe('support');
    expect(attribute(e, 'workers_ai_model', '@cf/baai/bge-base-en-v1.5')).toBe('search');
    expect(attribute(e, 'openai_project', 'proj_x', 'Media Pipeline')).toBe('media');
    expect(attribute(e, 'worker', 'marketing-site')).toBe('shared');
    expect(attribute(e, 'kv', 'unknown-namespace')).toBe(UNATTRIBUTED);
    expect(matches(e.viaGateway?.anthropic_key, 'storefront-gateway')).toBe(true);
  });
});
