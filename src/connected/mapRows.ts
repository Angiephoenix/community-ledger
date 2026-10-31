import type { LedgerState, OutboxKind, TaskType } from '../domain/types';

// Converts rows read from Supabase (already filtered by row-level security)
// into the LedgerState shape the screens use. Display figures are then
// derived from these authoritative rows and cross-checked against the
// database's own member_balances view (see consistency()).

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v));
const n = (v: unknown) => {
  const x = Number(v);
  if (!Number.isSafeInteger(x)) throw new Error('Unexpected amount from the server');
  return x;
};
const opt = (v: unknown) => (v == null ? undefined : String(v));

export interface ServerRows {
  clock: string;
  members: Row[];
  rules: Row[];
  levies: Row[];
  levyTargets: Row[];
  charges: Row[];
  adjustments: Row[];
  attempts: Row[];
  attemptCharges: Row[];
  payments: Row[];
  allocations: Row[];
  receipts: Row[];
  outbox: Row[];
  tasks: Row[];
  jobRuns: Row[];
  audit: Row[];
}

export function toLedgerState(r: ServerRows): LedgerState {
  const chargeTitle = new Map(r.charges.map((c) => [s(c.id), s(c.title)]));
  return {
    schemaVersion: 1,
    now: new Date(r.clock).toISOString(),
    seq: 0,
    members: r.members.map((m) => ({
      id: s(m.id),
      displayName: s(m.display_name),
      status: m.status === 'inactive' ? 'inactive' : 'active',
      joinedOn: s(m.joined_on),
      reminderChannel: (s(m.reminder_channel) || 'none') as 'whatsapp' | 'email' | 'none',
      analyticsId: s(m.analytics_id),
    })),
    rules: r.rules.map((x) => ({
      id: s(x.id),
      name: s(x.name),
      amountKobo: n(x.amount_kobo),
      frequency: x.frequency === 'monthly' ? 'monthly' : 'annual',
      issueDay: s(x.issue_day),
      dueDay: s(x.due_day),
      firstPeriod: s(x.first_period),
    })),
    levies: r.levies.map((l) => ({
      id: s(l.id),
      name: s(l.name),
      amountKobo: n(l.amount_kobo),
      issueDate: s(l.issue_date),
      dueDate: s(l.due_date),
      targetMemberIds: r.levyTargets.filter((t) => t.levy_id === l.id).map((t) => s(t.member_id)),
      status: l.status === 'draft' ? 'draft' : 'published',
      publishedAt: opt(l.published_at),
    })),
    charges: r.charges.map((c) => ({
      id: s(c.id),
      key: s(c.key),
      memberId: s(c.member_id),
      source: c.source_type === 'levy' ? { type: 'levy', levyId: s(c.levy_id) } : { type: 'rule', ruleId: s(c.rule_id), period: s(c.period) },
      title: s(c.title),
      amountKobo: n(c.amount_kobo),
      issueDate: s(c.issue_date),
      dueDate: s(c.due_date),
      createdAt: s(c.created_at),
    })),
    adjustments: r.adjustments.map((a) => ({ id: s(a.id), chargeId: s(a.charge_id), amountKobo: n(a.amount_kobo), reason: s(a.reason), createdAt: s(a.created_at) })),
    attempts: r.attempts.map((a) => ({
      id: s(a.id),
      reference: s(a.reference),
      memberId: s(a.member_id),
      chargeIds: r.attemptCharges.filter((x) => x.attempt_id === a.id).map((x) => s(x.charge_id)),
      amountKobo: n(a.amount_kobo),
      currency: 'NGN',
      status: s(a.status) as LedgerState['attempts'][number]['status'],
      createdAt: s(a.created_at),
      updatedAt: s(a.updated_at),
      verificationChecks: n(a.verification_checks ?? 0),
    })),
    payments: r.payments.map((p) => ({
      id: s(p.id),
      providerRef: s(p.provider_ref),
      attemptId: s(p.attempt_id),
      memberId: s(p.member_id),
      amountKobo: n(p.amount_kobo),
      currency: 'NGN',
      confirmedAt: s(p.confirmed_at),
      source: p.source === 'opening-record' ? 'opening-record' : 'provider',
      feeKobo: p.fee_kobo == null ? null : n(p.fee_kobo),
      settlement: 'not-tracked',
    })),
    allocations: r.allocations.map((a) => ({ id: s(a.id), paymentId: s(a.payment_id), chargeId: s(a.charge_id), amountKobo: n(a.amount_kobo), createdAt: s(a.created_at) })),
    receipts: r.receipts.map((x) => ({
      id: s(x.id),
      number: s(x.number),
      paymentId: s(x.payment_id),
      memberId: s(x.member_id),
      issuedAt: s(x.issued_at),
      amountKobo: n(x.amount_kobo),
      unappliedKobo: n(x.unapplied_kobo),
      lines: r.allocations
        .filter((a) => a.payment_id === x.payment_id)
        .map((a) => ({ chargeId: s(a.charge_id), title: chargeTitle.get(s(a.charge_id)) ?? 'Dues', amountKobo: n(a.amount_kobo) })),
    })),
    outbox: r.outbox.map((o) => ({
      id: s(o.id),
      key: s(o.key),
      memberId: s(o.member_id),
      chargeId: s(o.charge_id),
      kind: s(o.kind) as OutboxKind,
      channel: o.channel === 'email' ? 'email' : 'whatsapp',
      body: s(o.body),
      createdAt: s(o.created_at),
      status: s(o.status) as 'scheduled' | 'cancelled' | 'previewed',
      statusReason: opt(o.status_reason),
      supersededBy: opt(o.superseded_by),
      updatedAt: s(o.updated_at),
    })),
    jobRuns: r.jobRuns.map((j) => ({
      id: s(j.id),
      type: s(j.type) as LedgerState['jobRuns'][number]['type'],
      ranAt: s(j.ran_at),
      summary: s(j.summary),
      details: Array.isArray(j.details) ? (j.details as unknown[]).map(String) : [],
    })),
    inbound: [],
    tasks: r.tasks.map((t) => ({
      id: s(t.id),
      key: s(t.key),
      type: s(t.type) as TaskType,
      memberId: opt(t.member_id),
      refId: opt(t.ref_id),
      title: s(t.title),
      detail: s(t.detail),
      createdAt: s(t.created_at),
      status: s(t.status) as 'open' | 'reviewed' | 'resolved',
      closedAt: opt(t.closed_at),
      closeNote: opt(t.close_note),
    })),
    audit: r.audit.map((a) => ({
      id: s(a.id),
      at: s(a.at),
      actor: (s(a.actor) || 'system') as LedgerState['audit'][number]['actor'],
      action: s(a.action),
      detail: s(a.detail),
    })),
  };
}
