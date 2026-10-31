import { describe, expect, it } from 'vitest';
import { createLocalAnalytics, createPostHogCaptureAdapter, sanitize } from '../src/adapters/analytics';
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

describe('PostHog capture adapter (connected test system)', () => {
  it('sends only allowlisted properties, an opaque id and no person profile', async () => {
    const sent: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = createPostHogCaptureAdapter({ host: 'https://eu.i.posthog.com/', apiKey: 'phc_test_key', fetch: fakeFetch });
    a.capture('statement viewed', 'an_7f3a91c2d84e51be', {
      surface: 'member',
      // Things that must never leave the app, even if a caller passes them:
      ...({ name: 'Member A', email: 'a@example.test', amount: 1_500_000, reference: 'CL-123', url: 'https://x/?payment=return&reference=CL-123', note: 'free text' } as object),
    } as { surface: 'member' });
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://eu.i.posthog.com/i/v0/e/');
    expect(sent[0].init.credentials).toBe('omit');
    expect(sent[0].init.referrerPolicy).toBe('no-referrer');
    const body = sent[0].body as { api_key: string; event: string; distinct_id: string; uuid: string; timestamp: string; properties: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'timestamp', 'uuid']);
    expect(body.event).toBe('statement viewed');
    expect(body.distinct_id).toBe('an_7f3a91c2d84e51be');
    expect(body.properties).toEqual({ surface: 'member', schema_version: 1, environment: 'test', is_demo: false, $process_person_profile: false });
    const text = JSON.stringify(body);
    for (const banned of ['Member A', 'example.test', '1500000', 'CL-123', 'payment=return', 'free text', '$current_url', '$referrer', '$ip']) {
      expect(text).not.toContain(banned);
    }
    expect(JSON.stringify(a.outbound())).not.toContain('phc_test_key');
  });

  it('never throws when the network fails', async () => {
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const a = createPostHogCaptureAdapter({ host: 'https://eu.i.posthog.com', apiKey: 'k', fetch: failing });
    expect(() => a.capture('receipt viewed', 'an_x', { surface: 'member' })).not.toThrow();
  });
});
