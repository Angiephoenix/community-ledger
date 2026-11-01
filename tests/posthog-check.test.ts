import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { analyse, isSensitiveProperty, loadReviewed, recentEventsQuery, verdict } from '../scripts/posthog-check.mjs';

describe('PostHog read-back checks (scripts/verify-posthog.mjs)', () => {
  const p = { schema_version: 1, environment: 'test', is_demo: false, surface: 'server', $process_person_profile: false };
  it('computes the started -> confirmed funnel per opaque id', () => {
    const r = analyse([
      ['payment started', 'an_aaa', '2026-11-24T09:00:00Z', JSON.stringify(p)],
      ['payment confirmed', 'an_aaa', '2026-11-24T09:01:00Z', p],
      ['payment started', 'an_bbb', '2026-11-24T09:02:00Z', p],
      ['statement viewed', 'an_bbb', '2026-11-24T09:03:00Z', { ...p, surface: 'member' }],
    ]);
    expect(r.funnel).toEqual({ started: 2, confirmed: 1 });
    expect(r.counts['payment confirmed']).toBe(1);
    expect(r.problems).toEqual([]);
  });

  it('flags leaked data and non-opaque ids', () => {
    const r = analyse([['payment started', 'Member A', '2026-11-24T09:00:00Z', { ...p, amount: 1500000 }]]);
    expect(r.problems.join(' ')).toMatch(/sensitive property "amount"/);
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
      expect(verdict(analyse(full))).toMatchObject({ status: 'verified', verified: true, reasons: [] });
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
    expect(r.stdout).toContain('Analytics checks VERIFIED. This does not complete milestone 2');
  });
});

describe('sensitive and PostHog-added properties', () => {
  const p = { schema_version: 1, environment: 'test', is_demo: false, surface: 'server', $process_person_profile: false };
  const at = (m: number) => new Date(Date.UTC(2026, 10, 24, 9, m)).toISOString();
  const journey = (extra: Record<string, unknown> = {}) => [
    ['payment started', 'an_aaa', at(0), { ...p, ...extra }],
    ['payment confirmed', 'an_aaa', at(1), { ...p, ...extra }],
    ['statement viewed', 'an_aaa', at(2), { ...p, surface: 'member', ...extra }],
    ['receipt viewed', 'an_aaa', at(3), { ...p, surface: 'member', ...extra }],
    ['discrepancy reported', 'an_aaa', at(4), { ...p, ...extra }],
  ];
  const reviewedLib = loadReviewed([{ name: '$lib', reason: 'Library name added by PostHog; contains no personal data', reviewedBy: 'Angie Obiesie', reviewedOn: '2026-11-01' }]);

  it('regression: a complete journey with $ip and $email fails instead of verifying', () => {
    const v = verdict(analyse(journey({ $ip: '102.89.1.2', $email: 'member-a@example.test' })));
    expect(v.status).toBe('failed');
    expect(v.verified).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/sensitive property "\$ip"/);
    expect(v.reasons.join(' ')).toMatch(/sensitive property "\$email"/);
  });

  it('sensitive properties fail even with redacted or empty values', () => {
    for (const key of ['$ip', '$email', '$geoip_city_name', '$geoip_country_code', '$current_url', '$pathname', '$referrer', '$host', 'ip', 'email', 'user_email', 'payment_reference', '$raw_user_agent', 'phone_number', 'firstName']) {
      const v = verdict(analyse(journey({ [key]: '' })));
      expect(v.status, key).toBe('failed');
    }
  });

  it('unreviewed PostHog-added properties need review, never verify', () => {
    const v = verdict(analyse(journey({ $lib: 'web' })));
    expect(v.status).toBe('needs-review');
    expect(v.verified).toBe(false);
    expect(v.reasons[0]).toMatch(/\$lib/);
  });

  it('a property accepted by explicit review no longer blocks verification', () => {
    const r = analyse(journey({ $lib: 'web' }), 24, reviewedLib);
    expect(r.reviewedProperties).toEqual(['$lib']);
    expect(verdict(r)).toMatchObject({ status: 'verified', verified: true });
  });

  it('review cannot accept a sensitive property, and needs a reason, reviewer and date', () => {
    expect(() => loadReviewed([{ name: '$ip', reason: 'x', reviewedBy: 'y', reviewedOn: '2026-11-01' }])).toThrow(/sensitive/);
    expect(() => loadReviewed([{ name: '$geoip_city_name', reason: 'x', reviewedBy: 'y', reviewedOn: '2026-11-01' }])).toThrow(/sensitive/);
    expect(() => loadReviewed([{ name: '$lib' }])).toThrow(/missing: reason, reviewedBy, reviewedOn/);
    expect(() => loadReviewed([{ name: '$lib', reason: 'x', reviewedBy: 'y', reviewedOn: 'yesterday' }])).toThrow(/YYYY-MM-DD/);
  });

  it('a sensitive value under a reviewed, harmless-looking name still fails', () => {
    const v = verdict(analyse(journey({ $lib: 'member-a@example.test' }), 24, reviewedLib));
    expect(v.status).toBe('failed');
  });

  it('does not treat the allowlisted properties as sensitive', () => {
    for (const key of ['schema_version', 'environment', 'is_demo', 'surface', 'error_category']) expect(isSensitiveProperty(key), key).toBe(false);
  });

  it('a verified verdict is scoped to analytics only', () => {
    const v = verdict(analyse(journey()));
    expect(v.verified).toBe(true);
    expect(v.scope).toMatch(/analytics checks only/);
  });
});

describe('verify-posthog.mjs exit codes for the new outcomes', () => {
  async function run(results: unknown[], reviewedFile?: string) {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const env: NodeJS.ProcessEnv = { ...process.env, POSTHOG_APP_HOST: `http://127.0.0.1:${port}`, POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'phx_fictional_test_key' };
    if (reviewedFile) env.POSTHOG_REVIEWED_PROPERTIES = reviewedFile;
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const c = spawn(process.execPath, ['scripts/verify-posthog.mjs', '24'], { env });
      let text = '';
      c.stdout.on('data', (d) => (text += d));
      c.stderr.on('data', (d) => (text += d));
      c.on('close', (code) => resolve({ code, text }));
    });
    server.close();
    return out;
  }
  const p = { schema_version: 1, environment: 'test', is_demo: false, surface: 'server', $process_person_profile: false };
  const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000).toISOString();
  const journey = (extra: Record<string, unknown>) => ['payment started', 'payment confirmed', 'statement viewed', 'receipt viewed', 'discrepancy reported']
    .map((e, i) => [e, 'an_aaa', t(i), { ...p, ...extra }]);

  it('$ip and $email exit 2 (failed)', async () => {
    const r = await run(journey({ $ip: '102.89.1.2', $email: 'member-a@example.test' }));
    expect(r.code).toBe(2);
    expect(r.text).toContain('Analytics NOT verified (failed)');
  });

  it('an unreviewed PostHog property exits 4 (needs review)', async () => {
    const r = await run(journey({ $lib: 'web' }));
    expect(r.code).toBe(4);
    expect(r.text).toContain('Analytics NOT verified (needs-review)');
  });

  it('a review file that tries to accept a sensitive property is rejected (exit 1)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'cl-review-')), 'reviewed.json');
    writeFileSync(file, JSON.stringify([{ name: '$ip', reason: 'x', reviewedBy: 'y', reviewedOn: '2026-11-01' }]));
    const r = await run(journey({}), file);
    expect(r.code).toBe(1);
    expect(r.text).toContain('Reviewed-properties file rejected');
  });
});
