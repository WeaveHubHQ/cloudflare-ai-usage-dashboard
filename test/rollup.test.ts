import { describe, expect, it } from 'vitest';
import { floorTo, HOUR, rollupAi, rollupCf, totalCf, type AiRow, type CfRow } from '../src/rollup';

const ai = (ts: number, over: Partial<AiRow> = {}): AiRow => ({
  ts, source: 'gateway', app: 'a', gateway: 'g', provider: 'anthropic', model: 'm', key: 'g',
  requests: 1, errors: 0, tokens_in: 10, tokens_out: 5, tokens_cached: 2, cost_usd: 0.01, latency_ms: 100, ...over,
});

describe('rollup', () => {
  it('floors to UTC bucket starts', () => {
    expect(floorTo(3599, HOUR)).toBe(0);
    expect(floorTo(3600, HOUR)).toBe(3600);
  });

  it('sums 5m rows into the hour per key', () => {
    const out = rollupAi([ai(0), ai(300), ai(3300), ai(3600), ai(600, { model: 'other' })], HOUR);
    const h0 = out.find((r) => r.ts === 0 && r.model === 'm')!;
    expect(h0.requests).toBe(3);
    expect(h0.tokens_in).toBe(30);
    expect(h0.cost_usd).toBeCloseTo(0.03);
    expect(out.find((r) => r.ts === 3600)!.requests).toBe(1);
    expect(out.filter((r) => r.model === 'other')).toHaveLength(1);
    expect(out).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const rows = [ai(0), ai(300)];
    rollupAi(rows, HOUR);
    expect(rows[0]).toEqual(ai(0));
  });

  const cf = (ts: number, component: string, units: number): CfRow => ({ ts, app: 'a', component, resource: 'r', units });
  const gauges = new Set(['d1s']);

  it('takes max for gauges and sum for counters', () => {
    const out = rollupCf([cf(0, 'wreq', 5), cf(300, 'wreq', 7), cf(0, 'd1s', 2), cf(300, 'd1s', 3)], HOUR, gauges);
    expect(out.find((r) => r.component === 'wreq')!.units).toBe(12);
    expect(out.find((r) => r.component === 'd1s')!.units).toBe(3);
  });

  it('totals a range: counters summed, gauges averaged', () => {
    const out = totalCf([cf(0, 'wreq', 5), cf(3600, 'wreq', 7), cf(0, 'd1s', 2), cf(3600, 'd1s', 4)], gauges);
    expect(out.find((r) => r.component === 'wreq')!.units).toBe(12);
    expect(out.find((r) => r.component === 'd1s')!.units).toBe(3);
  });
});
