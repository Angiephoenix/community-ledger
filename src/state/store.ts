import { useSyncExternalStore } from 'react';
import { buildFixtures, DEFAULT_CLOCK, SCHEMA_VERSION } from '../domain/fixtures';
import type { LedgerState, PaymentAttempt } from '../domain/types';
import { runRecurringAssessment, publishLevy as publishLevyFn, type LevyInput } from '../domain/assessment';
import { runReminderJob, deliverScheduledPreviews } from '../domain/reminders';
import { markAttemptPending, processPaymentEvent, recordUnresolvedCheck, startAttempt, type ProcessResult, type ProviderPaymentEvent } from '../domain/payments';
import { reportDiscrepancy as reportDiscrepancyFn, reviewTask as reviewTaskFn } from '../domain/reports';
import { chargeOutstanding, chargesFor } from '../domain/ledger';
import { createLocalAnalytics, type Surface } from '../adapters/analytics';
import { createPaymentSimulator } from '../adapters/paymentProvider';

// One shared store for every view. Member and officer screens read the same
// LedgerState and call the same domain functions. Only fictional demo data is
// persisted, in this browser's localStorage, under a versioned key.

const STORAGE_KEY = 'community-ledger.demo.v1';

export type Role = 'member' | 'officer';
export interface ViewState {
  role: Role;
  memberId: string;
}

export interface Toast {
  id: number;
  tone: 'good' | 'info' | 'warn';
  text: string;
}

interface AppState {
  ledger: LedgerState;
  view: ViewState;
  toasts: Toast[];
  restoredNotice: string | null;
}

const defaultView: ViewState = { role: 'member', memberId: 'mem-a' };

function load(): AppState {
  const fresh = (notice: string | null): AppState => ({ ledger: buildFixtures(), view: defaultView, toasts: [], restoredNotice: notice });
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh(null);
    const parsed = JSON.parse(raw) as { ledger: LedgerState; view: ViewState };
    if (parsed?.ledger?.schemaVersion !== SCHEMA_VERSION) return fresh('Saved demo data was from an older version, so the demo was reset.');
    return { ledger: parsed.ledger, view: parsed.view ?? defaultView, toasts: [], restoredNotice: null };
  } catch {
    return fresh('Saved demo data could not be read, so the demo was reset.');
  }
}

let state: AppState = load();
const listeners = new Set<() => void>();
let toastId = 0;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ledger: state.ledger, view: state.view }));
  } catch {
    /* storage can be unavailable (private mode); the demo still works in memory */
  }
}

function set(next: Partial<AppState>) {
  state = { ...state, ...next };
  persist();
  listeners.forEach((l) => l());
}

function setLedger(ledger: LedgerState) {
  set({ ledger });
}

export const analytics = createLocalAnalytics(() => state.ledger.now);
export const paymentProvider = createPaymentSimulator();

function distinctIdFor(memberId: string) {
  return state.ledger.members.find((m) => m.id === memberId)?.analyticsId ?? 'an_unknown';
}

export function track(name: Parameters<typeof analytics.capture>[0], surface: Surface, memberId = state.view.memberId) {
  analytics.capture(name, distinctIdFor(memberId), { surface });
}

export function notify(text: string, tone: Toast['tone'] = 'info') {
  const toast = { id: ++toastId, text, tone };
  state = { ...state, toasts: [...state.toasts, toast].slice(-3) };
  listeners.forEach((l) => l());
  setTimeout(() => dismissToast(toast.id), 6000);
}

export function dismissToast(id: number) {
  state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
  listeners.forEach((l) => l());
}

function guard<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Something went wrong.', 'warn');
    return undefined;
  }
}

function deliver(event: ProviderPaymentEvent): ProcessResult {
  const result = processPaymentEvent(state.ledger, event);
  setLedger(result.state);
  if (result.outcome === 'recorded' && result.payment) {
    track('payment confirmed', 'processing (simulated server)', result.payment.memberId);
  }
  return result;
}

export const actions = {
  setView(view: Partial<ViewState>) {
    set({ view: { ...state.view, ...view } });
  },
  dismissRestoredNotice() {
    set({ restoredNotice: null });
  },

  /** Saves the member's choice as a payment attempt before checkout opens. */
  startPayment(chargeIds: string[]): PaymentAttempt | undefined {
    return guard(() => {
      const r = startAttempt(state.ledger, state.view.memberId, chargeIds);
      setLedger(r.state);
      track('payment started', 'processing (simulated server)');
      return r.attempt;
    });
  },

  simulateOutcome(attemptId: string, outcome: 'success' | 'pending' | 'failed'): ProcessResult | 'pending' | undefined {
    return guard(() => {
      const attempt = state.ledger.attempts.find((a) => a.id === attemptId);
      if (!attempt) throw new Error('This payment could not be found.');
      if (outcome === 'pending') {
        setLedger(markAttemptPending(state.ledger, attemptId));
        return 'pending' as const;
      }
      return deliver(paymentProvider.confirmationFor(attempt, outcome));
    });
  },

  checkPending(attemptId: string) {
    guard(() => {
      setLedger(recordUnresolvedCheck(state.ledger, attemptId));
      notify('Simulated check: the payment is still unconfirmed. Nothing was credited.', 'info');
    });
  },

  /** Re-sends the exact last recorded confirmation (same transaction reference). */
  replayLastConfirmation() {
    const last = [...state.ledger.inbound].reverse().find((e) => e.outcome === 'recorded');
    if (!last) {
      notify('No confirmation has been delivered yet.', 'info');
      return;
    }
    const r = deliver({
      providerRef: last.providerRef,
      attemptReference: last.attemptReference,
      amountKobo: last.amountKobo,
      currency: last.currency,
      status: last.eventStatus,
    });
    notify(
      r.outcome === 'duplicate-ignored'
        ? `Repeat of ${last.providerRef} ignored. No new payment, receipt or balance change.`
        : `Unexpected outcome: ${r.outcome}`,
      r.outcome === 'duplicate-ignored' ? 'good' : 'warn',
    );
  },

  /** Scenario D: two separate attempts confirm payment for the same charge. */
  simulateConcurrentPayments() {
    guard(() => {
      const memberId = state.view.memberId;
      const target = chargesFor(state.ledger, memberId).find((c) => chargeOutstanding(state.ledger, c) > 0);
      if (!target) throw new Error('This member has nothing outstanding to pay twice.');
      const a1 = startAttempt(state.ledger, memberId, [target.id]);
      const a2 = startAttempt(a1.state, memberId, [target.id]);
      setLedger(a2.state);
      deliver(paymentProvider.confirmationFor(a1.attempt, 'success'));
      const r2 = deliver(paymentProvider.confirmationFor(a2.attempt, 'success'));
      notify(`Two payments recorded for ${target.title}. The extra one is kept as credit and sent to Needs attention.`, r2.unappliedKobo ? 'good' : 'warn');
    });
  },

  runAssessment() {
    const r = runRecurringAssessment(state.ledger);
    setLedger(r.state);
    notify(`Recurring dues: ${r.state.jobRuns.at(-1)!.summary}.`, 'good');
  },
  runReminders() {
    const r = runReminderJob(state.ledger);
    setLedger(r.state);
    notify(`Reminders: ${r.state.jobRuns.at(-1)!.summary}. Preview only.`, 'good');
  },
  deliverPreviews() {
    const r = deliverScheduledPreviews(state.ledger);
    setLedger(r.state);
    notify(`Simulated delivery: ${r.state.jobRuns.at(-1)!.summary}.`, 'good');
  },
  publishLevy(input: LevyInput) {
    return guard(() => {
      const r = publishLevyFn(state.ledger, input);
      setLedger(r.state);
      notify(`${r.levy.name} published to ${r.created.length} member${r.created.length === 1 ? '' : 's'}.`, 'good');
      return r.levy;
    });
  },
  reviewTask(taskId: string, note: string) {
    guard(() => setLedger(reviewTaskFn(state.ledger, taskId, note)));
  },
  reportDiscrepancy(message: string) {
    return guard(() => {
      setLedger(reportDiscrepancyFn(state.ledger, state.view.memberId, message));
      track('discrepancy reported', 'processing (simulated server)');
      return true;
    });
  },

  setClock(iso: string) {
    if (Number.isNaN(Date.parse(iso))) return;
    setLedger({ ...state.ledger, now: new Date(iso).toISOString() });
  },
  advanceClock(hours: number) {
    setLedger({ ...state.ledger, now: new Date(Date.parse(state.ledger.now) + hours * 3600_000).toISOString() });
  },
  resetClock() {
    setLedger({ ...state.ledger, now: DEFAULT_CLOCK });
  },
  resetDemo() {
    analytics.clear();
    set({ ledger: buildFixtures(), view: defaultView, restoredNotice: null });
    notify('Demo reset to the original fictional records.', 'good');
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

export function useAnalyticsEvents() {
  return useSyncExternalStore(analytics.subscribe, analytics.events);
}
