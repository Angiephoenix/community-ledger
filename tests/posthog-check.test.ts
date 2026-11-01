import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { analyse, recentEventsQuery } from '../scripts/posthog-check.mjs';

describe('PostHog read-back checks (scripts/verify-posthog.mjs)', () => {
  const p = { schema_version: 1, environment: 'test', is_demo: false, surface: 'server', $process_person_profile: false };
  it('computes the started -> confirmed funnel per opaque id and lists PostHog-added properties', () => {
    const r = analyse([
      ['payment started', 'an_aaa', '2026-11-24T09:00:00Z', JSON.stringify({ ...p, $ip: '[redacted]' })],
      ['payment confirmed', 'an_aaa', '2026-11-24T09:01:00Z', p],
      ['payment started', 'an_bbb', '2026-11-24T09:02:00Z', p],
      ['statement viewed', 'an_bbb', '2026-11-24T09:03:00Z', { ...p, surface: 'member' }],
    ]);
    expect(r.funnel).toEqual({ started: 2, confirmed: 1 });
    expect(r.counts['payment confirmed']).toBe(1);
    expect(r.addedByPostHog).toEqual(['$ip']);
    expect(r.problems).toEqual([]);
  });

  it('flags leaked data and non-opaque ids', () => {
    const r = analyse([['payment started', 'Member A', '2026-11-24T09:00:00Z', { ...p, amount: 1500000 }]]);
    expect(r.problems.join(' ')).toMatch(/unexpected property "amount"/);
    expect(r.problems.join(' ')).toMatch(/not an opaque analytics id/);
  });

  it('only queries test-environment events for the known event names', () => {
    const q = recentEventsQuery(6).query as string;
    expect(q).toContain(`properties.environment = 'test'`);
    expect(q).toContain(`'payment confirmed'`);
    expect(q).toContain('interval 6 hour');
  });
});
