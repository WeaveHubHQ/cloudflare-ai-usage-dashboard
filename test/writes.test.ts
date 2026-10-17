import { describe, expect, it } from 'vitest';
import { buildQuery } from '../src/collectors/cloudflare';
import { upsertSql } from '../src/store';

describe('D1 write economy', () => {
  it('upserts only rewrite rows whose values changed', () => {
    const sql = upsertSql('cf_1h', ['ts', 'app', 'component', 'resource', 'units'], ['ts', 'app', 'component', 'resource']);
    expect(sql).toMatch(/ON CONFLICT\(ts,app,component,resource\) DO UPDATE SET units=excluded\.units\s+WHERE cf_1h\.units IS NOT excluded\.units$/);
  });

  it('queries platform datasets hourly and AI datasets at the run grain', () => {
    const q = buildQuery('datetimeFiveMinutes', { start: 0, end: 3600, width: 300 }, ['gw']);
    const dims = (name: string) => q.match(new RegExp(`\\b${name}: \\w+\\([^)]*\\) \\{\\s*(?:count )?dimensions \\{ ts: (\\w+)`))?.[1];
    for (const ds of ['workers', 'd1', 'r2', 'kv', 'queues', 'doreq', 'dodur']) expect(dims(ds)).toBe('datetimeHour');
    expect(dims('gw')).toBe('datetimeFiveMinutes');
    expect(dims('ai')).toBe('datetimeFiveMinutes');
  });
});
