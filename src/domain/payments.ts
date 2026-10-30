import { formatNaira, sumKobo, type Kobo } from './money';
import { lagosDateOf } from './time';
import { audit, chargeOutstanding, draft, memberName, nextId } from './ledger';
import { cancelRemindersForPaidCharges } from './reminders';
import type { Allocation, InboundEvent, LedgerState, Payment, PaymentAttempt, Receipt } from './types';

// Payment processing. A payment attempt records what the member chose to pay
// before checkout. Only a confirmation event, handled by processPaymentEvent,
// can create a payment, allocations and a receipt.

/** The shape a provider confirmation takes after server-side verification. */
export interface ProviderPaymentEvent {
  providerRef: string;
  attemptReference: string;
  amountKobo: Kobo;
  currency: string;
  status: 'success' | 'failed';
}

export function startAttempt(
  state: LedgerState,
  memberId: string,
  chargeIds: string[],
): { state: LedgerState; attempt: PaymentAttempt } {
  if (chargeIds.length === 0) throw new Error('Choose at least one charge to pay.');
  const s = draft(state);
  const charges = chargeIds.map((id) => {
    const c = s.charges.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown charge ${id}`);
    if (c.memberId !== memberId) throw new Error('A member can only pay their own charges.');
    return c;
  });
  const amountKobo = sumKobo(charges.map((c) => chargeOutstanding(s, c)));
  if (amountKobo <= 0) throw new Error('These charges are already paid.');
  const id = nextId(s, 'att');
  const attempt: PaymentAttempt = {
    id,
    reference: `CL-${id.slice(4)}-${memberId.slice(-1).toUpperCase()}`,
    memberId,
    chargeIds: charges.map((c) => c.id),
    amountKobo,
    currency: 'NGN',
    status: 'started',
    createdAt: s.now,
    updatedAt: s.now,
    verificationChecks: 0,
  };
  s.attempts.push(attempt);
  audit(s, 'member (demo)', 'Payment started', `${attempt.reference} · ${formatNaira(amountKobo)} · ${memberName(s, memberId)}`);
  return { state: s, attempt };
}

function findAttempt(s: LedgerState, attemptId: string) {
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a) throw new Error(`Unknown attempt ${attemptId}`);
  return a;
}

/** Provider says the payment is still processing. Balances do not change. */
export function markAttemptPending(state: LedgerState, attemptId: string): LedgerState {
  const s = draft(state);
  const a = findAttempt(s, attemptId);
  if (a.status === 'started') {
    a.status = 'pending';
    a.updatedAt = s.now;
    audit(s, 'simulator', 'Payment pending', `${a.reference} is being checked. Nothing credited.`);
  }
  return s;
}

/** Simulated provider verification that comes back unresolved. */
export function recordUnresolvedCheck(state: LedgerState, attemptId: string): LedgerState {
  const s = draft(state);
  const a = findAttempt(s, attemptId);
  if (a.status === 'pending' || a.status === 'started') {
    a.status = 'pending';
    a.verificationChecks += 1;
    a.updatedAt = s.now;
    audit(s, 'simulator', 'Verification unresolved', `${a.reference}: check ${a.verificationChecks} still unresolved`);
  }
  return s;
}

export type ProcessOutcome = InboundEvent['outcome'];

export interface ProcessResult {
  state: LedgerState;
  outcome: ProcessOutcome;
  payment?: Payment;
  receipt?: Receipt;
  unappliedKobo?: Kobo;
}

function logInbound(s: LedgerState, e: ProviderPaymentEvent, outcome: ProcessOutcome, note: string) {
  s.inbound.push({
    id: nextId(s, 'evt'),
    receivedAt: s.now,
    providerRef: e.providerRef,
    attemptReference: e.attemptReference,
    amountKobo: e.amountKobo,
    currency: e.currency,
    eventStatus: e.status,
    outcome,
    note,
  });
}

function holdEvent(s: LedgerState, e: ProviderPaymentEvent, memberId: string | undefined, reason: string) {
  const key = `held:${e.providerRef}`;
  if (!s.tasks.some((t) => t.key === key)) {
    s.tasks.push({
      id: nextId(s, 'task'),
      key,
      type: 'held-event',
      memberId,
      refId: e.providerRef,
      title: 'Payment held for checking',
      detail: `${reason} Transaction ${e.providerRef}, ${e.currency} ${e.amountKobo} kobo. Nothing was credited.`,
      createdAt: s.now,
      status: 'open',
    });
  }
  logInbound(s, e, 'held', reason);
  audit(s, 'system', 'Payment held', `${e.providerRef}: ${reason}`);
}

/**
 * The single processing function for payment confirmations. In order:
 * ignore repeats of the same provider transaction; check reference, amount and
 * currency; record the payment; allocate it to the chosen charges oldest-due
 * first; keep any excess as credit for officer review; issue one receipt;
 * cancel reminders for charges that are now cleared.
 */
export function processPaymentEvent(state: LedgerState, e: ProviderPaymentEvent): ProcessResult {
  const s = draft(state);

  const existing = s.payments.find((p) => p.providerRef === e.providerRef);
  if (existing) {
    logInbound(s, e, 'duplicate-ignored', `Already recorded as ${existing.id}. No changes made.`);
    audit(s, 'system', 'Duplicate confirmation ignored', e.providerRef);
    return { state: s, outcome: 'duplicate-ignored', payment: existing };
  }

  const attempt = s.attempts.find((a) => a.reference === e.attemptReference);
  if (!attempt) {
    holdEvent(s, e, undefined, 'The payment reference does not match any attempt.');
    return { state: s, outcome: 'held' };
  }

  if (e.status === 'failed') {
    if (attempt.status !== 'confirmed') {
      attempt.status = 'failed';
      attempt.updatedAt = s.now;
    }
    logInbound(s, e, 'attempt-failed', 'Provider reported failure. Balance unchanged.');
    audit(s, 'system', 'Payment failed', `${attempt.reference}: nothing credited`);
    return { state: s, outcome: 'attempt-failed' };
  }

  if (e.currency !== 'NGN') {
    holdEvent(s, e, attempt.memberId, `Unexpected currency ${e.currency}.`);
    return { state: s, outcome: 'held' };
  }
  if (!Number.isSafeInteger(e.amountKobo) || e.amountKobo !== attempt.amountKobo) {
    holdEvent(s, e, attempt.memberId, `Amount ${formatNaira(Math.trunc(e.amountKobo))} does not match the expected ${formatNaira(attempt.amountKobo)}.`);
    return { state: s, outcome: 'held' };
  }

  const payment: Payment = {
    id: nextId(s, 'pay'),
    providerRef: e.providerRef,
    attemptId: attempt.id,
    memberId: attempt.memberId,
    amountKobo: e.amountKobo,
    currency: 'NGN',
    confirmedAt: s.now,
    source: 'simulator',
    feeKobo: null,
    settlement: 'not-tracked',
  };
  s.payments.push(payment);
  attempt.status = 'confirmed';
  attempt.updatedAt = s.now;

  const charges = attempt.chargeIds
    .map((id) => s.charges.find((c) => c.id === id)!)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  let remaining = payment.amountKobo;
  const allocations: Allocation[] = [];
  for (const charge of charges) {
    if (remaining === 0) break;
    const owed = chargeOutstanding(s, charge);
    const amount = Math.min(owed, remaining);
    if (amount === 0) continue;
    const allocation: Allocation = {
      id: nextId(s, 'alc'),
      paymentId: payment.id,
      chargeId: charge.id,
      amountKobo: amount,
      createdAt: s.now,
    };
    s.allocations.push(allocation);
    allocations.push(allocation);
    remaining -= amount;
  }

  if (remaining > 0) {
    s.tasks.push({
      id: nextId(s, 'task'),
      key: `credit:${payment.id}`,
      type: 'unapplied-credit',
      memberId: payment.memberId,
      refId: payment.id,
      title: 'Extra payment kept as credit',
      detail: `${formatNaira(remaining)} of ${payment.providerRef} was more than ${memberName(s, payment.memberId)} owed on the chosen dues. It is held as credit. The group has not decided whether to refund it or carry it forward.`,
      createdAt: s.now,
      status: 'open',
    });
  }

  const receipt: Receipt = {
    id: nextId(s, 'rct'),
    number: `RCT-${lagosDateOf(s.now).slice(0, 4)}-${String(s.receipts.length + 1).padStart(4, '0')}`,
    paymentId: payment.id,
    memberId: payment.memberId,
    issuedAt: s.now,
    amountKobo: payment.amountKobo,
    lines: allocations.map((a) => ({
      chargeId: a.chargeId,
      title: s.charges.find((c) => c.id === a.chargeId)!.title,
      amountKobo: a.amountKobo,
    })),
    unappliedKobo: remaining,
  };
  s.receipts.push(receipt);

  const cancelled = cancelRemindersForPaidCharges(s, attempt.chargeIds, 'Paid before sending');

  // Any "still unconfirmed" task for this attempt is now settled by the system.
  for (const t of s.tasks) {
    if (t.key === `unresolved:${attempt.id}` && t.status === 'open') {
      t.status = 'resolved';
      t.closedAt = s.now;
      t.closeNote = 'Payment confirmed automatically.';
    }
  }

  logInbound(s, e, 'recorded', `Recorded ${payment.id}, receipt ${receipt.number}${remaining ? `, ${formatNaira(remaining)} kept as credit` : ''}.`);
  audit(
    s,
    'system',
    'Payment recorded',
    `${payment.providerRef} · ${formatNaira(payment.amountKobo)} · ${memberName(s, payment.memberId)} · ${allocations.length} allocation(s) · ${cancelled} reminder(s) cancelled`,
  );
  return { state: s, outcome: 'recorded', payment, receipt, unappliedKobo: remaining };
}
