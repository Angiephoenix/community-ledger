import { sumKobo, type Kobo } from './money';
import { dueCutoff, startOfLagosDay, lagosDateOf, type Instant, type LocalDate } from './time';
import type { AuditEvent, Charge, LedgerState, Payment, PaymentAttempt } from './types';

// Balances are always derived from the shared records (charges, allocations,
// adjustments). Nothing stores a running balance that could drift.

export const config = {
  /** "Due soon" starts once this share of the issue-to-deadline period has passed. */
  dueSoonFraction: 0.75,
  /** Reminders pause this long while a payment is being checked, then resume. */
  pendingPauseHours: 48,
  /** The recurring job assesses the next period this many days before it opens. */
  assessAheadDays: 10,
};

export type ChargeStatus = 'paid' | 'overdue' | 'due-soon' | 'outstanding';

/** Mutable working copy helper: domain functions clone, change, then return. */
export function draft(state: LedgerState): LedgerState {
  return structuredClone(state);
}

export function nextId(s: LedgerState, prefix: string): string {
  s.seq += 1;
  return `${prefix}-${String(s.seq).padStart(4, '0')}`;
}

export function audit(s: LedgerState, actor: AuditEvent['actor'], action: string, detail: string) {
  s.audit.push({ id: nextId(s, 'aud'), at: s.now, actor, action, detail });
}

export function allocatedToCharge(s: LedgerState, chargeId: string): Kobo {
  return sumKobo(s.allocations.filter((a) => a.chargeId === chargeId).map((a) => a.amountKobo));
}

export function adjustmentsForCharge(s: LedgerState, chargeId: string): Kobo {
  return sumKobo(s.adjustments.filter((a) => a.chargeId === chargeId).map((a) => a.amountKobo));
}

/** What is still owed on a charge. Pending or failed attempts never change this. */
export function chargeOutstanding(s: LedgerState, charge: Charge): Kobo {
  const owed = charge.amountKobo + adjustmentsForCharge(s, charge.id) - allocatedToCharge(s, charge.id);
  if (owed < 0) throw new Error(`Charge ${charge.id} is over-allocated; this should be impossible`);
  return owed;
}

export function chargeStatus(s: LedgerState, charge: Charge, now: Instant = s.now): ChargeStatus {
  if (chargeOutstanding(s, charge) === 0) return 'paid';
  const t = Date.parse(now);
  const start = startOfLagosDay(charge.issueDate);
  const cutoff = dueCutoff(charge.dueDate);
  if (t >= cutoff) return 'overdue';
  const elapsed = (t - start) / (cutoff - start);
  if (elapsed >= config.dueSoonFraction) return 'due-soon';
  return 'outstanding';
}

export function allocatedFromPayment(s: LedgerState, paymentId: string): Kobo {
  return sumKobo(s.allocations.filter((a) => a.paymentId === paymentId).map((a) => a.amountKobo));
}

/** Money received but not applied to any charge (e.g. a second concurrent payment). */
export function unappliedOf(s: LedgerState, payment: Payment): Kobo {
  return payment.amountKobo - allocatedFromPayment(s, payment.id);
}

export function chargesFor(s: LedgerState, memberId: string): Charge[] {
  return s.charges
    .filter((c) => c.memberId === memberId)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
}

export function openAttemptsFor(s: LedgerState, memberId: string): PaymentAttempt[] {
  return s.attempts.filter((a) => a.memberId === memberId && (a.status === 'pending' || a.status === 'started'));
}

export interface ChargeView {
  charge: Charge;
  outstandingKobo: Kobo;
  paidKobo: Kobo;
  status: ChargeStatus;
  /** True when an unconfirmed attempt covers this charge. Does not reduce debt. */
  hasOpenAttempt: boolean;
}

export function chargeView(s: LedgerState, charge: Charge): ChargeView {
  return {
    charge,
    outstandingKobo: chargeOutstanding(s, charge),
    paidKobo: allocatedToCharge(s, charge.id),
    status: chargeStatus(s, charge),
    hasOpenAttempt: s.attempts.some(
      (a) => (a.status === 'pending' || a.status === 'started') && a.chargeIds.includes(charge.id),
    ),
  };
}

export interface MemberSummary {
  memberId: string;
  charges: ChargeView[];
  assessedKobo: Kobo;
  paidKobo: Kobo;
  outstandingKobo: Kobo;
  overdueKobo: Kobo;
  upcomingKobo: Kobo;
  creditKobo: Kobo;
  paymentsKobo: Kobo;
  nextDue: { date: LocalDate; amountKobo: Kobo } | null;
  openAttempts: PaymentAttempt[];
}

export function memberSummary(s: LedgerState, memberId: string): MemberSummary {
  const charges = chargesFor(s, memberId).map((c) => chargeView(s, c));
  const unpaid = charges.filter((c) => c.outstandingKobo > 0);
  const upcoming = unpaid.filter((c) => c.status !== 'overdue');
  const payments = s.payments.filter((p) => p.memberId === memberId);
  let nextDue: MemberSummary['nextDue'] = null;
  if (upcoming.length) {
    const date = upcoming.map((c) => c.charge.dueDate).sort()[0];
    nextDue = {
      date,
      amountKobo: sumKobo(upcoming.filter((c) => c.charge.dueDate === date).map((c) => c.outstandingKobo)),
    };
  }
  return {
    memberId,
    charges,
    assessedKobo: sumKobo(charges.map((c) => c.charge.amountKobo + adjustmentsForCharge(s, c.charge.id))),
    paidKobo: sumKobo(charges.map((c) => c.paidKobo)),
    outstandingKobo: sumKobo(unpaid.map((c) => c.outstandingKobo)),
    overdueKobo: sumKobo(unpaid.filter((c) => c.status === 'overdue').map((c) => c.outstandingKobo)),
    upcomingKobo: sumKobo(upcoming.map((c) => c.outstandingKobo)),
    creditKobo: sumKobo(payments.map((p) => unappliedOf(s, p))),
    paymentsKobo: sumKobo(payments.map((p) => p.amountKobo)),
    nextDue,
    openAttempts: openAttemptsFor(s, memberId),
  };
}

export function today(s: LedgerState): LocalDate {
  return lagosDateOf(s.now);
}

export function memberName(s: LedgerState, memberId: string | undefined): string {
  return s.members.find((m) => m.id === memberId)?.displayName ?? 'Unknown member';
}
