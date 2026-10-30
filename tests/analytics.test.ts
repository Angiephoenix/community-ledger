import { describe, expect, it } from 'vitest';
import { createLocalAnalytics, sanitize } from '../src/adapters/analytics';
import { buildFixtures } from '../src/domain/fixtures';
import { memberStatement } from '../src/domain/reports';

describe('analytics adapter', () => {
  it('drops anything outside the allowlist and marks events as demo', () => {
    const props = sanitize({ surface: 'member', name: 'Member A', amount: 1_500_000, reference: 'CL-1', email: 'x@example.com' });
    expect(props).toEqual({ surface: 'member', schema_version: 1, environment: 'demo', is_demo: true });
  });

  it('stores events locally only', () => {
    const a = createLocalAnalytics(() => '2026-11-24T09:00:00.000Z');
    a.capture('payment started', 'an_test', { surface: 'processing (simulated server)' });
    expect(a.events()).toHaveLength(1);
    expect(a.events()[0].destination).toBe('local only');
  });
});

describe('statement', () => {
  it('closing balance equals the member outstanding total for every member', () => {
    const s = buildFixtures();
    for (const m of s.members) {
      const st = memberStatement(s, m.id);
      expect(st.agrees).toBe(true);
    }
    expect(memberStatement(s, 'mem-a').closingKobo).toBe(3_000_000);
  });
});
