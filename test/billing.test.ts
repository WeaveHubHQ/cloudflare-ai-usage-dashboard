import { describe, expect, it } from 'vitest';
import { estimateBill, type Component } from '../src/billing';

const comps: Component[] = [
  { key: 'wreq', name: 'Requests', unit: 'req', included: 100, price: 1, family: 'workers' },
  { key: 'gb', name: 'Storage', unit: 'GB-mo', included: 10, price: 2, family: 'storage', storage: true },
];

describe('estimateBill', () => {
  it('bills only overage and splits it by unit share', () => {
    const b = estimateBill({ a: { wreq: 150 }, b: { wreq: 50 } }, comps, 5, 30);
    const c = b.comps.find((x) => x.key === 'wreq')!;
    expect(c.over).toBe(100);
    expect(c.cost).toBe(100);
    expect(b.rows.find((r) => r.id === 'a')!.cost.wreq).toBe(75);
    expect(b.rows.find((r) => r.id === 'b')!.cost.wreq).toBe(25);
    expect(b.total).toBe(105);
  });

  it('pro-rates counter allowances and base fees by range, not storage', () => {
    const b = estimateBill({ a: { wreq: 10, gb: 12 } }, comps, 30, 3);
    expect(b.comps[0].incl).toBe(10);
    expect(b.comps[0].cost).toBe(0);
    expect(b.comps[1].incl).toBe(10);
    expect(b.comps[1].cost).toBe(4);
    expect(b.base).toBe(3);
  });

  it('names the apps that pushed a component over its allowance', () => {
    const b = estimateBill({ big: { wreq: 90 }, mid: { wreq: 30 }, tiny: { wreq: 1 } }, comps, 0, 30);
    expect(b.comps[0].pushers).toEqual(['mid', 'tiny']);
  });

  it('attributed shares add up to the component cost', () => {
    const b = estimateBill({ a: { wreq: 123 }, b: { wreq: 456 }, unattributed: { wreq: 7 } }, comps, 0, 30);
    const sum = b.rows.reduce((s, r) => s + r.cost.wreq, 0);
    expect(sum).toBeCloseTo(b.comps[0].cost);
  });
});
