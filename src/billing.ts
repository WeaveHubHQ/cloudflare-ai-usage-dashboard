// Cloudflare bill ESTIMATE: usage x list price above the included allowance,
// split across apps in proportion to each app's share of the component's units.
// Cloudflare invoices the account, not apps, so this is attribution, not an invoice.

export interface Component {
  key: string;
  name: string;
  unit: string;
  /** Included units per 30-day month (Workers Paid). */
  included: number;
  /** USD per unit above the allowance. */
  price: number;
  family: string;
  /** Storage is a level (GB-month), not a counter: the allowance does not scale with range length. */
  storage?: boolean;
}

export interface BillRow {
  id: string;
  units: Record<string, number>;
  cost: Record<string, number>;
  total: number;
}

export interface BillComp {
  key: string;
  name: string;
  unit: string;
  family: string;
  incl: number;
  price: number;
  total: number;
  over: number;
  cost: number;
  /** Apps (largest first) whose cumulative usage crossed the allowance. */
  pushers: string[];
}

export interface Bill {
  rows: BillRow[];
  comps: BillComp[];
  usage: number;
  base: number;
  total: number;
  days: number;
}

export function estimateBill(
  unitsByApp: Record<string, Record<string, number>>,
  components: readonly Component[],
  baseFeesMonthly: number,
  days: number,
): Bill {
  const rows: BillRow[] = Object.entries(unitsByApp).map(([id, u]) => ({
    id,
    units: Object.fromEntries(components.map((c) => [c.key, u[c.key] ?? 0])),
    cost: {},
    total: 0,
  }));
  const comps = components.map((c): BillComp => {
    const total = rows.reduce((a, r) => a + r.units[c.key], 0);
    const incl = c.storage ? c.included : (c.included * days) / 30;
    const over = Math.max(0, total - incl);
    const cost = over * c.price;
    const sorted = rows.filter((r) => r.units[c.key] > 0).sort((a, b) => b.units[c.key] - a.units[c.key]);
    let acc = 0;
    const pushers: string[] = [];
    for (const r of sorted) {
      acc += r.units[c.key];
      if (acc > incl) pushers.push(r.id);
    }
    for (const r of rows) {
      const share = total ? (cost * r.units[c.key]) / total : 0;
      r.cost[c.key] = share;
      r.total += share;
    }
    return { key: c.key, name: c.name, unit: c.unit, family: c.family, incl, price: c.price, total, over, cost, pushers };
  });
  const usage = comps.reduce((a, c) => a + c.cost, 0);
  const base = (baseFeesMonthly * days) / 30;
  return { rows, comps, usage, base, total: usage + base, days };
}
