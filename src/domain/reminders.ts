import { brand } from '../config/brand';
import { formatNaira } from './money';
import { DAY_MS, dueCutoff, formatDay, lagosDateOf } from './time';
import { audit, chargeOutstanding, chargeStatus, config, draft, nextId } from './ledger';
import type { Charge, LedgerState, OutboxKind, OutboxMessage, PaymentAttempt } from './types';

// Reminder automation. Jobs write to a local outbox. Milestone 1 only ever
// produces previews: no WhatsApp or email provider is connected.

function overdueWeek(charge: Charge, nowMs: number): number {
  return Math.floor((nowMs - dueCutoff(charge.dueDate)) / (7 * DAY_MS));
}

export function reminderKey(charge: Charge, kind: OutboxKind, nowMs: number): string {
  if (kind === 'reminder-overdue') return `${charge.id}:overdue:week-${overdueWeek(charge, nowMs)}`;
  return `${charge.id}:${kind}`;
}

function messageBody(s: LedgerState, charge: Charge, kind: OutboxKind): string {
  const member = s.members.find((m) => m.id === charge.memberId)!;
  const amount = formatNaira(chargeOutstanding(s, charge));
  const when = formatDay(charge.dueDate);
  switch (kind) {
    case 'new-charge':
      return `Hello ${member.displayName}, ${charge.title} of ${amount} has been added to your dues. It is due on ${when}.`;
    case 'reminder-due-soon':
      return `Hello ${member.displayName}, a reminder that ${charge.title} (${amount}) is due on ${when}.`;
    case 'reminder-overdue':
      return `Hello ${member.displayName}, ${charge.title} (${amount}) was due on ${when} and is still open. You can pay it in ${brand.name}.`;
  }
}

/** Adds a scheduled preview unless one with the same key already exists. Mutates `s`. */
export function queueNotification(s: LedgerState, charge: Charge, kind: OutboxKind): OutboxMessage | null {
  const member = s.members.find((m) => m.id === charge.memberId);
  if (!member || member.reminderChannel === 'none') return null;
  const key = reminderKey(charge, kind, Date.parse(s.now));
  if (s.outbox.some((m) => m.key === key)) return null;
  const msg: OutboxMessage = {
    id: nextId(s, 'msg'),
    key,
    memberId: member.id,
    chargeId: charge.id,
    kind,
    channel: member.reminderChannel,
    body: messageBody(s, charge, kind),
    createdAt: s.now,
    status: 'scheduled',
    updatedAt: s.now,
  };
  s.outbox.push(msg);
  return msg;
}

/** An unconfirmed attempt that is still inside the bounded pause window. */
export function pausingAttempt(s: LedgerState, chargeId: string): PaymentAttempt | undefined {
  const now = Date.parse(s.now);
  return s.attempts.find(
    (a) =>
      (a.status === 'pending' || a.status === 'started') &&
      a.chargeIds.includes(chargeId) &&
      now - Date.parse(a.createdAt) < config.pendingPauseHours * 3600_000,
  );
}

/** Mutates `s`: flags unconfirmed attempts older than the pause window for officers. */
export function flagUnresolvedAttempts(s: LedgerState): number {
  const now = Date.parse(s.now);
  let flagged = 0;
  for (const a of s.attempts) {
    if (a.status !== 'pending') continue;
    if (now - Date.parse(a.createdAt) < config.pendingPauseHours * 3600_000) continue;
    const key = `unresolved:${a.id}`;
    if (s.tasks.some((t) => t.key === key)) continue;
    s.tasks.push({
      id: nextId(s, 'task'),
      key,
      type: 'unresolved-payment',
      memberId: a.memberId,
      refId: a.id,
      title: 'Payment still unconfirmed',
      detail: `Attempt ${a.reference} for ${formatNaira(a.amountKobo)} has not been confirmed after ${config.pendingPauseHours} hours. Nothing was credited. Reminders have resumed.`,
      createdAt: s.now,
      status: 'open',
    });
    flagged += 1;
  }
  return flagged;
}

export interface ReminderRunResult {
  state: LedgerState;
  queued: OutboxMessage[];
  duplicatesPrevented: number;
  paused: number;
}

/** Scheduled reminder job: rechecks balances, preferences and history before queuing. */
export function runReminderJob(state: LedgerState): ReminderRunResult {
  const s = draft(state);
  const nowMs = Date.parse(s.now);
  const today = lagosDateOf(s.now);
  const queued: OutboxMessage[] = [];
  const details: string[] = [];
  let duplicatesPrevented = 0;
  let paused = 0;

  const flagged = flagUnresolvedAttempts(s);
  if (flagged) details.push(`${flagged} unconfirmed payment${flagged === 1 ? '' : 's'} sent to Needs attention`);

  for (const member of s.members) {
    const charges = s.charges.filter((c) => c.memberId === member.id && c.issueDate <= today);
    for (const charge of charges) {
      if (chargeOutstanding(s, charge) === 0) continue;
      const status = chargeStatus(s, charge);
      if (status !== 'due-soon' && status !== 'overdue') continue;
      if (member.reminderChannel === 'none') {
        details.push(`${member.displayName} · ${charge.title}: skipped, reminders turned off`);
        continue;
      }
      const kind: OutboxKind = status === 'overdue' ? 'reminder-overdue' : 'reminder-due-soon';
      if (s.outbox.some((m) => m.key === reminderKey(charge, kind, nowMs))) {
        duplicatesPrevented += 1;
        continue;
      }
      const attempt = pausingAttempt(s, charge.id);
      if (attempt) {
        paused += 1;
        details.push(`${member.displayName} · ${charge.title}: paused while payment ${attempt.reference} is checked`);
        continue;
      }
      const msg = queueNotification(s, charge, kind);
      if (msg) {
        queued.push(msg);
        details.push(`${member.displayName} · ${charge.title}: ${kind === 'reminder-overdue' ? 'overdue' : 'due soon'} preview queued`);
      }
    }
  }

  const summary = `${queued.length} new preview${queued.length === 1 ? '' : 's'}, ${duplicatesPrevented} already queued, ${paused} paused`;
  s.jobRuns.push({ id: nextId(s, 'job'), type: 'reminders', ranAt: s.now, summary, details });
  audit(s, 'system', 'Reminder job', summary);
  return { state: s, queued, duplicatesPrevented, paused };
}

/** Mutates `s`: cancels unsent messages for charges that are now fully paid. */
export function cancelRemindersForPaidCharges(s: LedgerState, chargeIds: string[], reason: string): number {
  let cancelled = 0;
  for (const msg of s.outbox) {
    if (msg.status !== 'scheduled' || !chargeIds.includes(msg.chargeId)) continue;
    const charge = s.charges.find((c) => c.id === msg.chargeId);
    if (charge && chargeOutstanding(s, charge) === 0) {
      msg.status = 'cancelled';
      msg.statusReason = reason;
      msg.updatedAt = s.now;
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Simulated delivery step. Rechecks every scheduled message immediately before
 * "delivery". Eligible ones become previews; nothing is actually sent.
 */
export function deliverScheduledPreviews(state: LedgerState): { state: LedgerState; previewed: number; cancelled: number } {
  const s = draft(state);
  let previewed = 0;
  let cancelled = 0;
  for (const msg of s.outbox) {
    if (msg.status !== 'scheduled') continue;
    const charge = s.charges.find((c) => c.id === msg.chargeId);
    const member = s.members.find((m) => m.id === msg.memberId);
    let reason: string | null = null;
    if (!charge || !member) reason = 'Record no longer exists';
    else if (chargeOutstanding(s, charge) === 0) reason = 'Already paid';
    else if (member.reminderChannel === 'none') reason = 'Member turned reminders off';
    else if (msg.kind !== 'new-charge' && pausingAttempt(s, charge.id)) {
      continue; // stays scheduled until the pause window ends
    }
    if (reason) {
      msg.status = 'cancelled';
      msg.statusReason = reason;
      cancelled += 1;
    } else {
      msg.status = 'previewed';
      msg.statusReason = 'Preview only. Not sent: no messaging service is connected.';
      previewed += 1;
    }
    msg.updatedAt = s.now;
  }
  const summary = `${previewed} preview${previewed === 1 ? '' : 's'} ready (not sent), ${cancelled} cancelled on recheck`;
  s.jobRuns.push({ id: nextId(s, 'job'), type: 'reminder-delivery', ranAt: s.now, summary, details: [] });
  audit(s, 'simulator', 'Simulated message delivery', summary);
  return { state: s, previewed, cancelled };
}
