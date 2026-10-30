import { describe, expect, it } from 'vitest';
import { buildFixtures } from '../src/domain/fixtures';
import { chargeStatus, chargesFor, memberSummary, attemptChargesSettled } from '../src/domain/ledger';
import { lagosInstant } from '../src/domain/time';
import { deliverScheduledPreviews, pausingAttempt, runReminderJob } from '../src/domain/reminders';
import { abandonAttempt, markAttemptPending, processPaymentEvent, recordUnresolvedCheck, startAttempt } from '../src/domain/payments';
import { collectionReport } from '../src/domain/reports';
import type { LedgerState, PaymentAttempt } from '../src/domain/types';

const A = 'mem-a';
const at = (s: LedgerState, date: string, hh = 10): LedgerState => ({ ...s, now: lagosInstant(date, hh) });
const levyA = (s: LedgerState) => chargesFor(s, A).find((c) => c.title.startsWith('Community'))!;
const annualA = (s: LedgerState) => chargesFor(s, A).find((c) => c.title.startsWith('Annual'))!;
const confirm = (s: LedgerState, a: PaymentAttempt, providerRef: string) =>
  processPaymentEvent(s, { providerRef, attemptReference: a.reference, amountKobo: a.amountKobo, currency: 'NGN', status: 'success' });

describe('stale queued reminders', () => {
  it('reviewer reproduction: 24 Nov run, 2 Dec run, delivery gives only the current overdue reminder', () => {
    let s = runReminderJob(buildFixtures()).state;
    const levy = levyA(s);
    expect(s.outbox.find((m) => m.chargeId === levy.id && m.kind === 'reminder-due-soon')?.status).toBe('scheduled');

    s = at(s, '2026-12-02');
    expect(chargeStatus(s, levy)).toBe('overdue');
    const run = runReminderJob(s);
    expect(run.superseded).toBeGreaterThan(0);
    s = deliverScheduledPreviews(run.state).state;

    const levyMsgs = s.outbox.filter((m) => m.chargeId === levy.id);
    const dueSoon = levyMsgs.find((m) => m.kind === 'reminder-due-soon')!;
    expect(dueSoon.status).toBe('cancelled');
    expect(dueSoon.statusReason).toBe('Superseded: the charge is now overdue');
    expect(dueSoon.body).toContain('is due on 30 November'); // history kept as it was queued
    const previewed = levyMsgs.filter((m) => m.kind !== 'new-charge' && m.status === 'previewed');
    expect(previewed).toHaveLength(1);
    expect(previewed[0].kind).toBe('reminder-overdue');
    expect(previewed[0].body).toContain('was due on 30 November');
  });

  it('cancels a due-soon reminder at delivery if the stage changed and the job has not rerun', () => {
    let s = runReminderJob(buildFixtures()).state;
    s = deliverScheduledPreviews(at(s, '2026-12-02')).state;
    const msg = s.outbox.find((m) => m.chargeId === levyA(s).id && m.kind === 'reminder-due-soon')!;
    expect(msg.status).toBe('cancelled');
    expect(msg.statusReason).toMatch(/^Superseded/);
    expect(s.outbox.some((m) => m.chargeId === levyA(s).id && m.kind !== 'new-charge' && m.status === 'previewed')).toBe(false);
  });

  it('keeps one unsent reminder per charge across weekly runs, so no burst builds up', () => {
    let s = buildFixtures();
    for (const day of ['2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22']) {
      s = runReminderJob(at(s, day)).state;
      for (const c of s.charges) {
        expect(s.outbox.filter((m) => m.chargeId === c.id && m.status === 'scheduled').length).toBeLessThanOrEqual(1);
      }
    }
    const annual = annualA(s);
    const history = s.outbox.filter((m) => m.chargeId === annual.id && m.kind === 'reminder-overdue');
    expect(history.length).toBeGreaterThan(2); // weekly history retained
    expect(history.filter((m) => m.statusReason === 'Superseded by a newer weekly reminder').length).toBe(history.length - 1);
    const d = deliverScheduledPreviews(s);
    expect(d.state.outbox.filter((m) => m.chargeId === annual.id && m.status === 'previewed')).toHaveLength(1);
  });

  it('rebuilds wording from the current balance at delivery', () => {
    let s = runReminderJob(buildFixtures()).state;
    const msg = s.outbox.find((m) => m.chargeId === levyA(s).id && m.status === 'scheduled')!;
    s.outbox.find((m) => m.id === msg.id)!.body = 'outdated text';
    s = deliverScheduledPreviews(s).state;
    expect(s.outbox.find((m) => m.id === msg.id)!.body).toBe(
      'Hello Member A, a reminder that Community project levy (₦10,000) is due on 30 November.',
    );
  });

  it('cancels an unsent new-charge notice once the charge is overdue', () => {
    let s = buildFixtures();
    const levyMsg = s.outbox.find((m) => m.kind === 'new-charge')!;
    s.outbox.find((m) => m.id === levyMsg.id)!.status = 'scheduled';
    s = deliverScheduledPreviews(at(s, '2026-12-11')).state;
    expect(s.outbox.find((m) => m.id === levyMsg.id)!.status).toBe('cancelled');
  });

  it('records superseded counts in the audit trail', () => {
    const s = runReminderJob(at(runReminderJob(buildFixtures()).state, '2026-12-02')).state;
    expect(s.audit.at(-1)!.detail).toMatch(/superseded/);
  });
});

describe('checkout and pending-payment lifecycle', () => {
  it('an opened checkout is not presented as a payment being checked and does not pause reminders', () => {
    const r = startAttempt(buildFixtures(), A, [levyA(buildFixtures()).id]);
    expect(r.attempt.status).toBe('started');
    expect(memberSummary(r.state, A).pendingAttempts).toHaveLength(0);
    expect(memberSummary(r.state, A).charges.some((c) => c.hasPendingAttempt)).toBe(false);
    expect(pausingAttempt(r.state, levyA(r.state).id)).toBeUndefined();
    expect(runReminderJob(r.state).paused).toBe(0);
  });

  it('closing checkout before submitting marks it abandoned and changes nothing else', () => {
    const r = startAttempt(buildFixtures(), A, [annualA(buildFixtures()).id]);
    const s = abandonAttempt(r.state, r.attempt.id);
    expect(s.attempts.find((a) => a.id === r.attempt.id)!.status).toBe('abandoned');
    expect(memberSummary(s, A).outstandingKobo).toBe(3_000_000);
    expect(memberSummary(s, A).pendingAttempts).toHaveLength(0);
    expect(collectionReport(s).pendingAttempts).toBe(1); // Member C's genuine pending payment only
    expect(s.audit.at(-1)!.action).toBe('Checkout closed');
  });

  it('a genuine pending payment cannot be abandoned and is not counted as paid', () => {
    const r = startAttempt(buildFixtures(), A, [annualA(buildFixtures()).id]);
    let s = markAttemptPending(r.state, r.attempt.id);
    s = abandonAttempt(s, r.attempt.id);
    expect(s.attempts.find((a) => a.id === r.attempt.id)!.status).toBe('pending');
    s = recordUnresolvedCheck(s, r.attempt.id);
    expect(s.attempts.find((a) => a.id === r.attempt.id)!.verificationChecks).toBe(1);
    expect(memberSummary(s, A).outstandingKobo).toBe(3_000_000);
  });

  it('verification checks do not turn an opened checkout into a pending payment', () => {
    const r = startAttempt(buildFixtures(), A, [annualA(buildFixtures()).id]);
    const s = recordUnresolvedCheck(r.state, r.attempt.id);
    expect(s.attempts.find((a) => a.id === r.attempt.id)!.status).toBe('started');
  });

  it('a late confirmation for an abandoned checkout is still recorded as a real payment', () => {
    const r = startAttempt(buildFixtures(), A, [annualA(buildFixtures()).id]);
    const s = abandonAttempt(r.state, r.attempt.id);
    const done = confirm(s, r.attempt, 'SIM-TX-LATE');
    expect(done.outcome).toBe('recorded');
    expect(memberSummary(done.state, A).outstandingKobo).toBe(1_500_000);
  });

  it('dues paid by another attempt show as paid while the earlier pending payment stays unresolved', () => {
    const base = buildFixtures();
    const first = startAttempt(base, A, [annualA(base).id]);
    let s = markAttemptPending(first.state, first.attempt.id);
    const second = startAttempt(s, A, [annualA(s).id]);
    s = confirm(second.state, second.attempt, 'SIM-TX-SECOND').state;

    expect(chargeStatus(s, annualA(s))).toBe('paid');
    const earlier = s.attempts.find((a) => a.id === first.attempt.id)!;
    expect(earlier.status).toBe('pending'); // no invented terminal status
    expect(attemptChargesSettled(s, earlier)).toBe(true);
    expect(memberSummary(s, A).pendingAttempts.map((a) => a.id)).toEqual([first.attempt.id]);
    expect(s.audit.some((e) => e.action === 'Earlier payment still unconfirmed')).toBe(true);

    // If the earlier one is later confirmed, it is kept as credit, not discarded.
    const late = confirm(s, earlier, 'SIM-TX-FIRST');
    expect(late.outcome).toBe('recorded');
    expect(late.unappliedKobo).toBe(1_500_000);
    expect(memberSummary(late.state, A).creditKobo).toBe(1_500_000);
    expect(collectionReport(late.state).checks.every((c) => c.ok)).toBe(true);
  });

  it('flags an old pending payment whose dues were paid elsewhere with accurate wording', () => {
    const base = buildFixtures();
    const first = startAttempt(base, A, [annualA(base).id]);
    let s = markAttemptPending(first.state, first.attempt.id);
    const second = startAttempt(s, A, [annualA(s).id]);
    s = confirm(second.state, second.attempt, 'SIM-TX-SECOND').state;
    s = runReminderJob(at(s, '2026-11-27')).state;
    const task = s.tasks.find((t) => t.key === `unresolved:${first.attempt.id}`)!;
    expect(task.detail).toContain('have since been paid by another payment');
  });
});
