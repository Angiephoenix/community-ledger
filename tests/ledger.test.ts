import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../src/domain/fixtures';
import { chargeStatus, memberSummary, chargesFor } from '../src/domain/ledger';
import { naira, formatNaira, parseNairaInput } from '../src/domain/money';
import { dueCutoff, lagosDateOf, lagosInstant, startOfLagosDay } from '../src/domain/time';
import { publishLevy, runRecurringAssessment } from '../src/domain/assessment';
import { markAttemptPending, processPaymentEvent, recordUnresolvedCheck, startAttempt, type ProviderPaymentEvent } from '../src/domain/payments';
import { deliverScheduledPreviews, runReminderJob } from '../src/domain/reminders';
import { collectionReport } from '../src/domain/reports';
import type { LedgerState } from '../src/domain/types';

const A = 'mem-a';
const annualA = (s: LedgerState) => chargesFor(s, A).find((c) => c.title.startsWith('Annual dues'))!;

function successEvent(s: LedgerState, reference: string, providerRef: string): ProviderPaymentEvent {
  const attempt = s.attempts.find((a) => a.reference === reference)!;
  return { providerRef, attemptReference: reference, amountKobo: attempt.amountKobo, currency: 'NGN', status: 'success' };
}

function payAnnualA(s: LedgerState, providerRef = 'SIM-TX-T1') {
  const started = startAttempt(s, A, [annualA(s).id]);
  return processPaymentEvent(started.state, successEvent(started.state, started.attempt.reference, providerRef));
}

describe('money and time', () => {
  it('formats kobo as naira', () => {
    expect(formatNaira(naira(15_000))).toBe('₦15,000');
    expect(formatNaira(150_050)).toBe('₦1,500.50');
    expect(parseNairaInput('10,000')).toBe(1_000_000);
    expect(parseNairaInput('10.5')).toBeNull();
    expect(() => formatNaira(1.5)).toThrow();
  });

  it('uses Lagos day boundaries for deadlines', () => {
    expect(new Date(startOfLagosDay('2026-11-20')).toISOString()).toBe('2026-11-19T23:00:00.000Z');
    expect(new Date(dueCutoff('2026-11-20')).toISOString()).toBe('2026-11-20T23:00:00.000Z');
    expect(lagosDateOf('2026-11-20T23:30:00.000Z')).toBe('2026-11-21');
    // Cross-check the fixed offset against the platform time zone database.
    const viaIntl = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date('2026-11-20T23:30:00Z'));
    expect(viaIntl).toBe('2026-11-21');
  });
});

describe('fixtures (Member A at the default clock)', () => {
  const s = buildFixtures();

  it('matches the scenario figures in kobo', () => {
    const m = memberSummary(s, A);
    expect(m.assessedKobo).toBe(3_500_000);
    expect(m.paidKobo).toBe(500_000);
    expect(m.outstandingKobo).toBe(3_000_000);
    expect(m.overdueKobo).toBe(1_500_000);
    expect(m.upcomingKobo).toBe(1_500_000);
    expect(m.nextDue).toEqual({ date: '2026-11-30', amountKobo: 1_000_000 });
  });

  it('applies the 75% due-soon rule per charge', () => {
    const statuses = Object.fromEntries(chargesFor(s, A).map((c) => [c.title, chargeStatus(s, c)]));
    expect(statuses).toEqual({
      'Annual dues 2026': 'overdue',
      'Community project levy': 'due-soon',
      'Welfare contribution': 'outstanding',
    });
  });

  it('has the other member cases', () => {
    expect(memberSummary(s, 'mem-b').outstandingKobo).toBe(0);
    expect(memberSummary(s, 'mem-b').charges).toHaveLength(3);
    expect(memberSummary(s, 'mem-c').paidKobo).toBe(0);
    expect(memberSummary(s, 'mem-c').openAttempts).toHaveLength(1);
    expect(memberSummary(s, 'mem-d').charges).toHaveLength(0);
  });

  it('starts with an unsent reminder for Member A annual dues', () => {
    const msg = s.outbox.find((m) => m.chargeId === annualA(s).id);
    expect(msg?.status).toBe('scheduled');
  });
});

describe('Scenario A: ordinary payment', () => {
  const s0 = buildFixtures();
  const r = payAnnualA(s0);
  const s = r.state;

  it('records, allocates, updates balances and issues one receipt', () => {
    expect(r.outcome).toBe('recorded');
    const m = memberSummary(s, A);
    expect(m.outstandingKobo).toBe(1_500_000);
    expect(m.overdueKobo).toBe(0);
    expect(chargeStatus(s, annualA(s))).toBe('paid');
    expect(r.receipt?.amountKobo).toBe(1_500_000);
    expect(s.receipts.filter((x) => x.memberId === A)).toHaveLength(2); // opening record + this one
    expect(s.allocations.filter((x) => x.paymentId === r.payment!.id)).toHaveLength(1);
  });

  it('leaves other charges unchanged', () => {
    const others = chargesFor(s, A).filter((c) => !c.title.startsWith('Annual'));
    expect(others.map((c) => memberSummary(s, A).charges.find((v) => v.charge.id === c.id)!.outstandingKobo)).toEqual([
      1_000_000, 500_000,
    ]);
  });

  it('cancels the matching unsent reminder', () => {
    const msg = s.outbox.find((m) => m.chargeId === annualA(s).id)!;
    expect(msg.status).toBe('cancelled');
    expect(msg.statusReason).toBe('Paid before sending');
  });

  it('agrees with the officer report', () => {
    const rep = collectionReport(s);
    expect(rep.checks.every((c) => c.ok)).toBe(true);
    expect(rep.members.find((m) => m.memberId === A)!.outstandingKobo).toBe(1_500_000);
  });
});

describe('Scenario B: duplicate confirmation', () => {
  it('ignores a repeat of the same provider transaction', () => {
    const first = payAnnualA(buildFixtures());
    const attempt = first.state.attempts.find((a) => a.id === first.payment!.attemptId)!;
    const replay = processPaymentEvent(first.state, successEvent(first.state, attempt.reference, 'SIM-TX-T1'));
    expect(replay.outcome).toBe('duplicate-ignored');
    expect(replay.state.payments).toHaveLength(first.state.payments.length);
    expect(replay.state.allocations).toHaveLength(first.state.allocations.length);
    expect(replay.state.receipts).toHaveLength(first.state.receipts.length);
    expect(memberSummary(replay.state, A).outstandingKobo).toBe(1_500_000);
    expect(replay.state.inbound.at(-1)!.outcome).toBe('duplicate-ignored');
  });
});

describe('Scenario C: pending and failed attempts', () => {
  it('never reduces debt', () => {
    let s = buildFixtures();
    const p = startAttempt(s, A, [annualA(s).id]);
    s = markAttemptPending(p.state, p.attempt.id);
    s = recordUnresolvedCheck(s, p.attempt.id);
    expect(memberSummary(s, A).outstandingKobo).toBe(3_000_000);
    const f = startAttempt(s, A, [annualA(s).id]);
    const failed = processPaymentEvent(f.state, { ...successEvent(f.state, f.attempt.reference, 'SIM-TX-F1'), status: 'failed' });
    expect(failed.outcome).toBe('attempt-failed');
    expect(memberSummary(failed.state, A).outstandingKobo).toBe(3_000_000);
    expect(failed.state.payments).toHaveLength(s.payments.length);
  });

  it('pauses reminders for a bounded time only', () => {
    let s = buildFixtures();
    const p = startAttempt(s, A, [chargesFor(s, A).find((c) => c.title.startsWith('Community'))!.id]);
    s = markAttemptPending(p.state, p.attempt.id);
    const run1 = runReminderJob(s);
    expect(run1.paused).toBe(1);
    expect(run1.queued.some((m) => m.memberId === A && m.kind === 'reminder-due-soon')).toBe(false);
    const later = { ...run1.state, now: lagosInstant('2026-11-26', 11) };
    const run2 = runReminderJob(later);
    expect(run2.queued.some((m) => m.memberId === A && m.kind === 'reminder-due-soon')).toBe(true);
    expect(run2.state.tasks.some((t) => t.key === `unresolved:${p.attempt.id}`)).toBe(true);
  });
});

describe('Scenario D: two distinct payments for the same charge', () => {
  it('keeps the second as credit and flags it', () => {
    let s = buildFixtures();
    const a1 = startAttempt(s, A, [annualA(s).id]);
    const a2 = startAttempt(a1.state, A, [annualA(s).id]);
    s = a2.state;
    const r1 = processPaymentEvent(s, successEvent(s, a1.attempt.reference, 'SIM-TX-D1'));
    const r2 = processPaymentEvent(r1.state, successEvent(r1.state, a2.attempt.reference, 'SIM-TX-D2'));
    expect(r2.outcome).toBe('recorded');
    expect(r2.unappliedKobo).toBe(1_500_000);
    const m = memberSummary(r2.state, A);
    expect(m.outstandingKobo).toBe(1_500_000);
    expect(m.creditKobo).toBe(1_500_000);
    expect(r2.state.payments.filter((p) => p.providerRef.startsWith('SIM-TX-D'))).toHaveLength(2);
    expect(r2.state.tasks.some((t) => t.type === 'unapplied-credit' && t.status === 'open')).toBe(true);
    const rep = collectionReport(r2.state);
    expect(rep.unappliedKobo).toBe(1_500_000);
    expect(rep.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('payment checks', () => {
  it('holds unexpected amounts, currencies and references', () => {
    const s = buildFixtures();
    const p = startAttempt(s, A, [annualA(s).id]);
    const base = successEvent(p.state, p.attempt.reference, 'SIM-TX-H1');
    for (const bad of [
      { ...base, amountKobo: 100 },
      { ...base, currency: 'USD' },
      { ...base, attemptReference: 'NOPE' },
    ]) {
      const r = processPaymentEvent(p.state, bad);
      expect(r.outcome).toBe('held');
      expect(r.state.payments).toHaveLength(p.state.payments.length);
      expect(r.state.tasks.some((t) => t.type === 'held-event')).toBe(true);
    }
  });

  it('rejects paying another member’s charge', () => {
    const s = buildFixtures();
    expect(() => startAttempt(s, 'mem-b', [annualA(s).id])).toThrow();
  });

  it('counts a payment covering several charges once', () => {
    const s = buildFixtures();
    const ids = chargesFor(s, A).map((c) => c.id);
    const p = startAttempt(s, A, ids);
    const r = processPaymentEvent(p.state, successEvent(p.state, p.attempt.reference, 'SIM-TX-ALL'));
    expect(r.receipt!.lines).toHaveLength(3);
    expect(memberSummary(r.state, A).outstandingKobo).toBe(0);
    const rep = collectionReport(r.state);
    expect(rep.collectedKobo).toBe(naira(5_000) + naira(35_000) + naira(30_000));
    expect(rep.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('Scenario E: recurring job reruns', () => {
  it('assesses a new period once, including only eligible members', () => {
    const s = buildFixtures();
    const run1 = runRecurringAssessment(s);
    const monthly = run1.created.filter((c) => c.source.type === 'rule' && c.source.ruleId === 'monthly-meeting');
    expect(monthly.map((c) => c.memberId).sort()).toEqual(['mem-a', 'mem-b', 'mem-c', 'mem-d']);
    expect(run1.created).toHaveLength(4);
    const run2 = runRecurringAssessment(run1.state);
    expect(run2.created).toHaveLength(0);
    expect(run2.state.charges).toHaveLength(run1.state.charges.length);
  });

  it('targets a levy at selected members only and publishes notices once', () => {
    const s = buildFixtures();
    const r = publishLevy(s, { name: 'Hall repair levy', amountKobo: naira(3_000), issueDate: '2026-11-24', dueDate: '2026-12-15', targetMemberIds: ['mem-a', 'mem-d'] });
    expect(r.created.map((c) => c.memberId)).toEqual(['mem-a', 'mem-d']);
    expect(r.state.outbox.filter((m) => m.kind === 'new-charge' && r.created.some((c) => c.id === m.chargeId))).toHaveLength(2);
    expect(() => publishLevy(s, { name: '', amountKobo: 0, issueDate: '2026-11-24', dueDate: '2026-11-01', targetMemberIds: [] })).toThrow();
  });
});

describe('Scenario F: reminders', () => {
  it('does not duplicate on rerun and excludes cleared dues', () => {
    const s = buildFixtures();
    const run1 = runReminderJob(s);
    expect(run1.queued.length).toBeGreaterThan(0);
    const run2 = runReminderJob(run1.state);
    expect(run2.queued).toHaveLength(0);
    expect(run2.state.outbox).toHaveLength(run1.state.outbox.length);

    const paid = payAnnualA(run2.state).state;
    const run3 = runReminderJob(paid);
    expect(run3.queued.some((m) => m.chargeId === annualA(paid).id)).toBe(false);
    // The levy is still open, so its due-soon reminder remains valid.
    const levyId = chargesFor(paid, A).find((c) => c.title.startsWith('Community'))!.id;
    expect(run3.state.outbox.some((m) => m.chargeId === levyId && m.status === 'scheduled')).toBe(true);
  });

  it('rechecks eligibility immediately before simulated delivery', () => {
    const queued = runReminderJob(buildFixtures()).state;
    const levy = chargesFor(queued, A).find((c) => c.title.startsWith('Community'))!;
    const p = startAttempt(queued, A, [levy.id]);
    const paid = processPaymentEvent(p.state, successEvent(p.state, p.attempt.reference, 'SIM-TX-R1')).state;
    // Reminder was cancelled at payment time; the delivery step must not resurrect it.
    const delivered = deliverScheduledPreviews(paid).state;
    const levyMsg = delivered.outbox.find((m) => m.chargeId === levy.id && m.kind === 'reminder-due-soon')!;
    expect(levyMsg.status).toBe('cancelled');
    expect(delivered.outbox.every((m) => m.status !== 'scheduled' || m.memberId === 'mem-c')).toBe(true);
    expect(delivered.outbox.filter((m) => m.status === 'previewed').every((m) => /Preview only/.test(m.statusReason ?? ''))).toBe(true);
  });
});
