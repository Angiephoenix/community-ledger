import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { analyse, recentEventsQuery, verdict } from '../scripts/posthog-check.mjs';

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

  describe('verdict', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 24, 9, m)).toISOString();
    const full = [
      ['payment started', 'an_aaa', at(0), p],
      ['payment confirmed', 'an_aaa', at(1), p],
      ['statement viewed', 'an_aaa', at(2), { ...p, surface: 'member' }],
      ['receipt viewed', 'an_aaa', at(3), { ...p, surface: 'member' }],
      ['discrepancy reported', 'an_aaa', at(4), p],
    ];

    it('zero events is incomplete, never verified', () => {
      const v = verdict(analyse([]));
      expect(v.verified).toBe(false);
      expect(v.status).toBe('incomplete');
      expect(v.reasons).toContain('No test events were received.');
    });

    it('missing required events or no completed funnel is incomplete', () => {
      const onlyStarted = verdict(analyse([full[0]]));
      expect(onlyStarted.status).toBe('incomplete');
      expect(onlyStarted.reasons.join(' ')).toMatch(/payment confirmed/);
      expect(onlyStarted.reasons.join(' ')).toMatch(/No completed payment started -> payment confirmed funnel/);
      // Confirmed before started for that id: no completed funnel.
      const backwards = verdict(analyse([['payment confirmed', 'an_aaa', at(0), p], ['payment started', 'an_aaa', at(5), p], ...full.slice(2)]));
      expect(backwards.status).toBe('incomplete');
      expect(verdict(analyse(full.slice(0, 4))).reasons).toEqual(['Missing required event: discrepancy reported']);
    });

    it('all expected events plus a completed funnel is verified', () => {
      expect(verdict(analyse(full))).toEqual({ status: 'verified', verified: true, reasons: [] });
    });

    it('any leak fails even when everything else is present', () => {
      const leaky = [...full, ['receipt viewed', 'an_aaa', at(6), { ...p, email: 'member-a@example.test' }]];
      const v = verdict(analyse(leaky));
      expect(v.status).toBe('failed');
      expect(v.verified).toBe(false);
    });
  });
});

describe('verify-posthog.mjs end to end against a local stand-in for the query API', () => {
  async function runScript(results: unknown) {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const seen: { auth?: string; path?: string } = {};
    const server = createServer((req, res) => {
      seen.auth = req.headers.authorization;
      seen.path = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(results === undefined ? {} : { results }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ['scripts/verify-posthog.mjs', '24'], {
        env: { ...process.env, POSTHOG_APP_HOST: `http://127.0.0.1:${port}`, POSTHOG_PROJECT_ID: '123', POSTHOG_PERSONAL_API_KEY: 'phx_fictional_test_key' },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    server.close();
    return { ...out, seen };
  }

  it('zero events exits as incomplete and says analytics is not verified', async () => {
    const r = await runScript([]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('Analytics NOT verified (incomplete)');
    expect(r.stdout).not.toContain('phx_fictional_test_key');
    expect(r.seen).toEqual({ auth: 'Bearer phx_fictional_test_key', path: '/api/projects/123/query/' });
  });

  it('a response without result rows is not verified', async () => {
    const r = await runScript(undefined);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('NOT verified');
  });

  it('a complete clean journey exits 0', async () => {
    const p = { schema_version: 1, environment: 'test', is_demo: false, surface: 'server', $process_person_profile: false };
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000).toISOString();
    const r = await runScript([
      ['payment started', 'an_aaa', t(0), p], ['payment confirmed', 'an_aaa', t(1), p],
      ['statement viewed', 'an_aaa', t(2), p], ['receipt viewed', 'an_aaa', t(3), p], ['discrepancy reported', 'an_aaa', t(4), p],
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Analytics VERIFIED.');
  });
});
