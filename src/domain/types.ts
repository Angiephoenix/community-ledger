import type { Kobo } from './money';
import type { Instant, LocalDate } from './time';

// Every record below is fictional demo data held in the browser. In the
// connected version these become PostgreSQL tables with constraints.

export interface Member {
  id: string;
  displayName: string;
  status: 'active' | 'inactive';
  joinedOn: LocalDate;
  /** Where reminder previews would go. 'none' means the member opted out. */
  reminderChannel: 'whatsapp' | 'email' | 'none';
  /** Opaque, purpose-specific analytics id (pseudonymous, not anonymous). */
  analyticsId: string;
}

/** A recurring dues definition. Individual debts are Charges. */
export interface DuesRule {
  id: string;
  name: string;
  amountKobo: Kobo;
  frequency: 'annual' | 'monthly';
  /** annual: 'MM-DD'; monthly: 'DD' */
  issueDay: string;
  /** annual: 'MM-DD'; monthly: 'DD' */
  dueDay: string;
  /** First period this rule applies to: 'YYYY' or 'YYYY-MM'. */
  firstPeriod: string;
}

/** A one-off special levy targeting selected members. */
export interface Levy {
  id: string;
  name: string;
  amountKobo: Kobo;
  issueDate: LocalDate;
  dueDate: LocalDate;
  targetMemberIds: string[];
  status: 'draft' | 'published';
  publishedAt?: Instant;
}

export type ChargeSource =
  | { type: 'rule'; ruleId: string; period: string }
  | { type: 'levy'; levyId: string };

/** One member's assessed debt for one rule/period or levy. */
export interface Charge {
  id: string;
  /** Uniqueness key: a rerun with the same key never creates a second charge. */
  key: string;
  memberId: string;
  source: ChargeSource;
  title: string;
  amountKobo: Kobo;
  issueDate: LocalDate;
  dueDate: LocalDate;
  createdAt: Instant;
}

/** An explicit correction or waiver. Signed: negative reduces the debt. */
export interface Adjustment {
  id: string;
  chargeId: string;
  amountKobo: Kobo;
  reason: string;
  createdAt: Instant;
}

/** The member's intent to pay, saved before checkout opens. */
export interface PaymentAttempt {
  id: string;
  reference: string;
  memberId: string;
  chargeIds: string[];
  amountKobo: Kobo;
  currency: 'NGN';
  status: 'started' | 'pending' | 'confirmed' | 'failed';
  createdAt: Instant;
  updatedAt: Instant;
  verificationChecks: number;
}

/** A confirmed incoming payment. One per provider transaction. */
export interface Payment {
  id: string;
  providerRef: string;
  attemptId: string;
  memberId: string;
  amountKobo: Kobo;
  currency: 'NGN';
  confirmedAt: Instant;
  source: 'simulator' | 'opening-record';
  /** Provider fees are tracked separately from dues; not known in the demo. */
  feeKobo: Kobo | null;
  /** Payment confirmation is not bank settlement; settlement is not tracked yet. */
  settlement: 'not-tracked';
}

/** How much of a payment went to a charge. A payment can cover several charges. */
export interface Allocation {
  id: string;
  paymentId: string;
  chargeId: string;
  amountKobo: Kobo;
  createdAt: Instant;
}

export interface Receipt {
  id: string;
  number: string;
  paymentId: string;
  memberId: string;
  issuedAt: Instant;
  amountKobo: Kobo;
  lines: { chargeId: string; title: string; amountKobo: Kobo }[];
  unappliedKobo: Kobo;
}

export type OutboxKind = 'reminder-due-soon' | 'reminder-overdue' | 'new-charge';

/** Preview-only message queue. Nothing in milestone 1 is ever sent. */
export interface OutboxMessage {
  id: string;
  key: string;
  memberId: string;
  chargeId: string;
  kind: OutboxKind;
  channel: 'whatsapp' | 'email';
  body: string;
  createdAt: Instant;
  status: 'scheduled' | 'cancelled' | 'previewed';
  statusReason?: string;
  updatedAt: Instant;
}

export interface JobRun {
  id: string;
  type: 'assessment' | 'reminders' | 'reminder-delivery' | 'levy-publish';
  ranAt: Instant;
  summary: string;
  details: string[];
}

/** Every payment event that reached the processing function, including repeats. */
export interface InboundEvent {
  id: string;
  receivedAt: Instant;
  providerRef: string;
  attemptReference: string;
  amountKobo: Kobo;
  currency: string;
  eventStatus: 'success' | 'failed';
  outcome: 'recorded' | 'duplicate-ignored' | 'held' | 'attempt-failed';
  note: string;
}

export type TaskType =
  | 'unapplied-credit'
  | 'held-event'
  | 'unresolved-payment'
  | 'invalid-rule'
  | 'discrepancy';

/** An item for officers in Needs attention. */
export interface Task {
  id: string;
  key: string;
  type: TaskType;
  memberId?: string;
  refId?: string;
  title: string;
  detail: string;
  createdAt: Instant;
  status: 'open' | 'reviewed' | 'resolved';
  closedAt?: Instant;
  closeNote?: string;
}

export interface AuditEvent {
  id: string;
  at: Instant;
  actor: 'system' | 'officer (demo)' | 'member (demo)' | 'simulator';
  action: string;
  detail: string;
}

export interface LedgerState {
  schemaVersion: number;
  now: Instant;
  seq: number;
  members: Member[];
  rules: DuesRule[];
  levies: Levy[];
  charges: Charge[];
  adjustments: Adjustment[];
  attempts: PaymentAttempt[];
  payments: Payment[];
  allocations: Allocation[];
  receipts: Receipt[];
  outbox: OutboxMessage[];
  jobRuns: JobRun[];
  inbound: InboundEvent[];
  tasks: Task[];
  audit: AuditEvent[];
}
