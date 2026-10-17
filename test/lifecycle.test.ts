import { describe, expect, it } from 'vitest';
import { lifecycleFor } from '../src/lifecycle';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('model lifecycle', () => {
  it('flags deprecated models, urgent inside 60 days', () => {
    expect(lifecycleFor('claude-sonnet-4-5-20250929', at('2026-10-16T00:00:00Z'))).toMatchObject({ severity: 'urgent', daysLeft: 45, replacement: 'claude-sonnet-5-5' });
    expect(lifecycleFor('gpt-4o-mini-2024-07-18', at('2026-10-16T00:00:00Z'))?.severity).toBe('deprecated');
  });
  it('becomes retired once the date passes', () => {
    expect(lifecycleFor('claude-sonnet-4-5', at('2026-12-01T00:00:00Z'))?.severity).toBe('retired');
  });
  it('uses the longest matching prefix and ignores unlisted models', () => {
    expect(lifecycleFor('gpt-5-mini-2025-08-07', at('2026-10-16T00:00:00Z'))?.replacement).toBe('gpt-5.6-terra');
    expect(lifecycleFor('gpt-5.6-sol', at('2026-10-16T00:00:00Z'))).toBeNull();
    expect(lifecycleFor('claude-sonnet-5', at('2026-10-16T00:00:00Z'))).toBeNull();
  });
  it('marks active models past their earliest retirement as watch', () => {
    expect(lifecycleFor('claude-haiku-4-5-20251001', at('2026-10-16T00:00:00Z'))?.severity).toBe('watch');
  });
});
