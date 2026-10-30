import { sumKobo, type Kobo } from './money';
import { adjustmentsForCharge, allocatedFromPayment, audit, chargeOutstanding, chargeStatus, draft, memberSummary, nextId, unappliedOf, type MemberSummary } from './ledger';
import type { LedgerState, Task } from './types';

// Collection report for officers. Every figure is computed from the same
// records the member views use. Payments are summed from the payments table,
// never from joined allocation rows, so a payment covering three charges is
// counted once.

export interface ChargeGroupRow {
  title: string;
  members: number;
  assessedKobo: Kobo;
  allocatedKobo: Kobo;
  outstandingKobo: Kobo;
  overdueKobo: Kobo;
}

export interface CollectionReport {
  asOf: string;
  assessedKobo: Kobo;
  collectedKobo: Kobo;
  allocatedKobo: Kobo;
  unappliedKobo: Kobo;
  outstandingKobo: Kobo;
  overdueKobo: Kobo;
  pendingAttemptsKobo: Kobo;
  pendingAttempts: number;
  members: MemberSummary[];
  groups: ChargeGroupRow[];
  checks: { label: string; ok: boolean }[];
}

export function collectionReport(s: LedgerState): CollectionReport {
  const assessedKobo = sumKobo(s.charges.map((c) => c.amountKobo + adjustmentsForCharge(s, c.id)));
  const collectedKobo = sumKobo(s.payments.map((p) => p.amountKobo));
  const allocatedKobo = sumKobo(s.allocations.map((a) => a.amountKobo));
  const unappliedKobo = sumKobo(s.payments.map((p) => unappliedOf(s, p)));
  const outstandingKobo = sumKobo(s.charges.map((c) => chargeOutstanding(s, c)));
  const overdueKobo = sumKobo(
    s.charges.filter((c) => chargeStatus(s, c) === 'overdue').map((c) => chargeOutstanding(s, c)),
  );
  const pending = s.attempts.filter((a) => a.status === 'pending' || a.status === 'started');
  const members = s.members.map((m) => memberSummary(s, m.id));

  const byTitle = new Map<string, ChargeGroupRow>();
  for (const c of s.charges) {
    const row = byTitle.get(c.title) ?? {
      title: c.title,
      members: 0,
      assessedKobo: 0,
      allocatedKobo: 0,
      outstandingKobo: 0,
      overdueKobo: 0,
    };
    const owed = chargeOutstanding(s, c);
    row.members += 1;
    row.assessedKobo += c.amountKobo + adjustmentsForCharge(s, c.id);
    row.outstandingKobo += owed;
    row.allocatedKobo += sumKobo(s.allocations.filter((a) => a.chargeId === c.id).map((a) => a.amountKobo));
    if (chargeStatus(s, c) === 'overdue') row.overdueKobo += owed;
    byTitle.set(c.title, row);
  }

  const memberOutstanding = sumKobo(members.map((m) => m.outstandingKobo));
  const memberPayments = sumKobo(members.map((m) => m.paymentsKobo));
  return {
    asOf: s.now,
    assessedKobo,
    collectedKobo,
    allocatedKobo,
    unappliedKobo,
    outstandingKobo,
    overdueKobo,
    pendingAttemptsKobo: sumKobo(pending.map((a) => a.amountKobo)),
    pendingAttempts: pending.length,
    members,
    groups: [...byTitle.values()],
    checks: [
      { label: 'Assessed minus applied payments equals outstanding', ok: assessedKobo - allocatedKobo === outstandingKobo },
      { label: 'Payments received equal applied plus credit', ok: collectedKobo === allocatedKobo + unappliedKobo },
      { label: 'Member statements add up to the group total', ok: memberOutstanding === outstandingKobo },
      { label: 'Each payment counted once', ok: memberPayments === collectedKobo },
      { label: 'One receipt per payment', ok: s.receipts.length === s.payments.length },
    ],
  };
}

export function openTasks(s: LedgerState): Task[] {
  return s.tasks.filter((t) => t.status === 'open');
}

/** Officer marks a task as reviewed. No money moves; the note is kept in the audit trail. */
export function reviewTask(state: LedgerState, taskId: string, note: string): LedgerState {
  const s = draft(state);
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('Unknown task');
  if (t.status !== 'open') return s;
  t.status = 'reviewed';
  t.closedAt = s.now;
  t.closeNote = note.trim() || 'Reviewed. No change to records.';
  audit(s, 'officer (demo)', 'Task reviewed', `${t.title}: ${t.closeNote}`);
  return s;
}

/** A member flags something that looks wrong. Free text stays in the ledger, never in analytics. */
export function reportDiscrepancy(state: LedgerState, memberId: string, message: string): LedgerState {
  const text = message.trim();
  if (!text) throw new Error('Tell us what looks wrong.');
  const s = draft(state);
  const id = nextId(s, 'task');
  s.tasks.push({
    id,
    key: `discrepancy:${id}`,
    type: 'discrepancy',
    memberId,
    title: 'Member reported a problem',
    detail: text.slice(0, 500),
    createdAt: s.now,
    status: 'open',
  });
  audit(s, 'member (demo)', 'Problem reported', 'Sent to Needs attention');
  return s;
}

export interface StatementLine {
  date: string;
  sortKey: string;
  description: string;
  chargedKobo: Kobo;
  paidKobo: Kobo;
  balanceKobo: Kobo;
  receiptId?: string;
}

/**
 * A member's statement: charges and applied payments in date order with a
 * running balance. The closing balance always equals the member's outstanding
 * total. Credit held for review is listed separately.
 */
export function memberStatement(s: LedgerState, memberId: string) {
  const rows: Omit<StatementLine, 'balanceKobo'>[] = [];
  for (const c of s.charges.filter((x) => x.memberId === memberId)) {
    rows.push({ date: c.issueDate, sortKey: `${c.createdAt}|0|${c.id}`, description: c.title, chargedKobo: c.amountKobo, paidKobo: 0 });
    for (const adj of s.adjustments.filter((a) => a.chargeId === c.id)) {
      rows.push({ date: adj.createdAt, sortKey: `${adj.createdAt}|1|${adj.id}`, description: `Adjustment: ${adj.reason}`, chargedKobo: adj.amountKobo, paidKobo: 0 });
    }
  }
  for (const p of s.payments.filter((x) => x.memberId === memberId)) {
    const allocated = allocatedFromPayment(s, p.id);
    const titles = s.allocations
      .filter((a) => a.paymentId === p.id)
      .map((a) => s.charges.find((c) => c.id === a.chargeId)?.title)
      .join(', ');
    if (allocated > 0) {
      rows.push({
        date: p.confirmedAt,
        sortKey: `${p.confirmedAt}|2|${p.id}`,
        description: `Payment received${titles ? ` · ${titles}` : ''}`,
        chargedKobo: 0,
        paidKobo: allocated,
        receiptId: s.receipts.find((r) => r.paymentId === p.id)?.id,
      });
    }
  }
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  let balance = 0;
  const lines: StatementLine[] = rows.map((r) => {
    balance += r.chargedKobo - r.paidKobo;
    return { ...r, balanceKobo: balance };
  });
  const summary = memberSummary(s, memberId);
  const credits = s.payments
    .filter((p) => p.memberId === memberId && unappliedOf(s, p) > 0)
    .map((p) => ({ paymentId: p.id, providerRef: p.providerRef, amountKobo: unappliedOf(s, p), date: p.confirmedAt }));
  return {
    lines,
    closingKobo: balance,
    summary,
    credits,
    agrees: balance === summary.outstandingKobo,
  };
}
