import { naira } from './money';
import { lagosInstant } from './time';
import { draft, nextId } from './ledger';
import { publishLevy, runRecurringAssessment } from './assessment';
import { deliverScheduledPreviews, runReminderJob } from './reminders';
import { markAttemptPending, processPaymentEvent, recordUnresolvedCheck, startAttempt } from './payments';
import type { LedgerState } from './types';

// Fictional demo records. They are built by replaying the real domain
// functions at earlier demo-clock times, so the starting history is exactly
// what the automation would have produced.

export const SCHEMA_VERSION = 1;
export const DEFAULT_CLOCK = lagosInstant('2026-11-24', 10, 0);

function at(s: LedgerState, date: string, hh: number, mm = 0): LedgerState {
  return { ...s, now: lagosInstant(date, hh, mm) };
}

export function emptyState(): LedgerState {
  return {
    schemaVersion: SCHEMA_VERSION,
    now: DEFAULT_CLOCK,
    seq: 0,
    members: [],
    rules: [],
    levies: [],
    charges: [],
    adjustments: [],
    attempts: [],
    payments: [],
    allocations: [],
    receipts: [],
    outbox: [],
    jobRuns: [],
    inbound: [],
    tasks: [],
    audit: [],
  };
}

export function buildFixtures(): LedgerState {
  let s = emptyState();
  s.members = [
    { id: 'mem-a', displayName: 'Member A', status: 'active', joinedOn: '2025-03-01', reminderChannel: 'whatsapp', analyticsId: 'an_7f3a91' },
    { id: 'mem-b', displayName: 'Member B', status: 'active', joinedOn: '2024-06-01', reminderChannel: 'whatsapp', analyticsId: 'an_c2d84e' },
    { id: 'mem-c', displayName: 'Member C', status: 'active', joinedOn: '2025-09-01', reminderChannel: 'email', analyticsId: 'an_51be07' },
    { id: 'mem-d', displayName: 'Member D', status: 'active', joinedOn: '2026-11-15', reminderChannel: 'whatsapp', analyticsId: 'an_9a60f2' },
  ];
  s.rules = [
    { id: 'annual-dues', name: 'Annual dues', amountKobo: naira(20_000), frequency: 'annual', issueDay: '11-01', dueDay: '11-20', firstPeriod: '2026' },
    // Not yet assessed at the default clock: used to demonstrate the recurring job.
    { id: 'monthly-meeting', name: 'Monthly meeting contribution', amountKobo: naira(2_000), frequency: 'monthly', issueDay: '01', dueDay: '28', firstPeriod: '2026-12' },
  ];

  // 1 November: dues assessed and two levies published.
  s = at(s, '2026-11-01', 9);
  s = runRecurringAssessment(s).state;
  const abc = ['mem-a', 'mem-b', 'mem-c'];
  s = publishLevy(s, { name: 'Community project levy', amountKobo: naira(10_000), issueDate: '2026-11-01', dueDate: '2026-11-30', targetMemberIds: abc }).state;
  s = publishLevy(s, { name: 'Welfare contribution', amountKobo: naira(5_000), issueDate: '2026-11-01', dueDate: '2026-12-10', targetMemberIds: abc }).state;
  s = at(s, '2026-11-01', 9, 5);
  s = deliverScheduledPreviews(s).state;

  const chargeOf = (memberId: string, title: string) =>
    s.charges.find((c) => c.memberId === memberId && c.title.startsWith(title))!;

  // 5 November: an opening record of a ₦5,000 part payment by Member A.
  s = at(s, '2026-11-05', 11);
  {
    const d = draft(s);
    const annualA = chargeOf('mem-a', 'Annual dues');
    const id = nextId(d, 'att');
    d.attempts.push({
      id,
      reference: 'CL-OPENING-A',
      memberId: 'mem-a',
      chargeIds: [annualA.id],
      amountKobo: naira(5_000),
      currency: 'NGN',
      status: 'started',
      createdAt: d.now,
      updatedAt: d.now,
      verificationChecks: 0,
    });
    s = processPaymentEvent(d, {
      providerRef: 'SIM-OPENING-0001',
      attemptReference: 'CL-OPENING-A',
      amountKobo: naira(5_000),
      currency: 'NGN',
      status: 'success',
    }).state;
    s.payments[s.payments.length - 1].source = 'opening-record';
  }

  // 8 November: Member B pays everything.
  s = at(s, '2026-11-08', 18, 30);
  {
    const ids = s.charges.filter((c) => c.memberId === 'mem-b').map((c) => c.id);
    const r = startAttempt(s, 'mem-b', ids);
    s = processPaymentEvent(r.state, {
      providerRef: 'SIM-TX-1001',
      attemptReference: r.attempt.reference,
      amountKobo: r.attempt.amountKobo,
      currency: 'NGN',
      status: 'success',
    }).state;
  }

  // 19 November: Member C starts paying annual dues; it never resolves.
  s = at(s, '2026-11-19', 15);
  {
    const r = startAttempt(s, 'mem-c', [chargeOf('mem-c', 'Annual dues').id]);
    s = markAttemptPending(r.state, r.attempt.id);
    s = at(s, '2026-11-20', 9);
    s = recordUnresolvedCheck(s, r.attempt.id);
    s = at(s, '2026-11-21', 9);
    s = runReminderJob(s).state;
    s = at(s, '2026-11-23', 9);
    s = recordUnresolvedCheck(s, r.attempt.id);
    s = runReminderJob(s).state;
  }

  return { ...s, now: DEFAULT_CLOCK };
}
