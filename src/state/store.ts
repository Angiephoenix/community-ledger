import { useSyncExternalStore } from 'react';
import { buildFixtures, DEFAULT_CLOCK, emptyState, SCHEMA_VERSION } from '../domain/fixtures';
import type { LedgerState, PaymentAttempt } from '../domain/types';
import { runRecurringAssessment, publishLevy as publishLevyFn, type LevyInput } from '../domain/assessment';
import { runReminderJob, deliverScheduledPreviews } from '../domain/reminders';
import { abandonAttempt, markAttemptPending, processPaymentEvent, recordUnresolvedCheck, startAttempt, type ProcessResult, type ProviderPaymentEvent } from '../domain/payments';
import { reportDiscrepancy as reportDiscrepancyFn, reviewTask as reviewTaskFn } from '../domain/reports';
import { chargeOutstanding, chargesFor, memberSummary } from '../domain/ledger';
import { createLocalAnalytics, createPostHogCaptureAdapter, type Surface } from '../adapters/analytics';
import { appMode, connectedConfig, connectedConfigured } from '../config/mode';
import { createPaymentSimulator } from '../adapters/paymentProvider';

// One shared store for every view. Member and officer screens read the same
// LedgerState.
//   Demo mode: records are fictional demo data, changed by the local domain
//   functions and persisted in this browser's localStorage under a versioned key.
//   Connected mode: records are loaded from Supabase (filtered by row-level
//   security) and every change goes through the server. localStorage is never
//   used for records, and a connection failure shows an error, never demo data.

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

export interface Connection {
  status: 'not-configured' | 'loading' | 'signed-out' | 'unlinked' | 'ready' | 'error';
  message?: string;
  email?: string;
  isOfficer?: boolean;
  /** Figures that differ between this screen and the database's own totals. */
  mismatches?: string[];
  serverChecks?: { label: string; ok: boolean }[];
  returnStatus?: 'checking' | 'confirmed' | 'pending' | 'failed' | 'abandoned' | 'held' | 'checking-unavailable' | 'not-found' | 'started';
}

interface AppState {
  mode: 'demo' | 'connected';
  connection: Connection;
  ledger: LedgerState;
  view: ViewState;
  toasts: Toast[];
  /** Latest action result, kept so Demo controls can show it inline. */
  lastNotice: Toast | null;
  restoredNotice: string | null;
}

const defaultView: ViewState = { role: 'member', memberId: 'mem-a' };

function load(): AppState {
  if (appMode === 'connected') {
    return {
      mode: 'connected',
      connection: { status: connectedConfigured ? 'loading' : 'not-configured' },
      ledger: emptyState(),
      view: { role: 'member', memberId: '' },
      toasts: [],
      lastNotice: null,
      restoredNotice: null,
    };
  }
  const base = { mode: 'demo' as const, connection: { status: 'ready' as const } };
  const fresh = (notice: string | null): AppState => ({ ...base, ledger: buildFixtures(), view: defaultView, toasts: [], lastNotice: null, restoredNotice: notice });
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh(null);
    const parsed = JSON.parse(raw) as { ledger: LedgerState; view: ViewState };
    if (parsed?.ledger?.schemaVersion !== SCHEMA_VERSION) return fresh('Saved demo data was from an older version, so the demo was reset.');
    return { ...base, ledger: parsed.ledger, view: parsed.view ?? defaultView, toasts: [], lastNotice: null, restoredNotice: null };
  } catch {
    return fresh('Saved demo data could not be read, so the demo was reset.');
  }
}

let state: AppState = load();
const listeners = new Set<() => void>();
let toastId = 0;

function persist() {
  if (state.mode !== 'demo') return; // connected records live only on the server
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

export const analytics =
  appMode === 'connected' && connectedConfig.posthogHost && connectedConfig.posthogKey
    ? createPostHogCaptureAdapter({ host: connectedConfig.posthogHost, apiKey: connectedConfig.posthogKey })
    : createLocalAnalytics(() => state.ledger.now);
// Officers have no member analytics id; use a random id per page load.
const officerSessionId = `an_officer_${Math.random().toString(36).slice(2, 12)}`;
export const paymentProvider = createPaymentSimulator();

function distinctIdFor(memberId: string) {
  if (state.mode === 'connected' && state.view.role === 'officer') return officerSessionId;
  return state.ledger.members.find((m) => m.id === memberId)?.analyticsId ?? 'an_unknown';
}

export function track(name: Parameters<typeof analytics.capture>[0], surface: Surface, memberId = state.view.memberId) {
  analytics.capture(name, distinctIdFor(memberId), { surface });
}

export function notify(text: string, tone: Toast['tone'] = 'info') {
  const toast = { id: ++toastId, text, tone };
  // One message at a time, so notices never stack over tables and reports.
  state = { ...state, toasts: [toast], lastNotice: toast };
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

  /** Checkout closed before a payment was submitted. */
  abandonPayment(attemptId: string) {
    guard(() => setLedger(abandonAttempt(state.ledger, attemptId)));
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
    if (state.mode === 'connected') return void serverAction(async () => `Recurring dues: ${(await (await srv()).rpc<{ summary: string }>('run_recurring_assessment')).summary}.`);
    const r = runRecurringAssessment(state.ledger);
    setLedger(r.state);
    notify(`Recurring dues: ${r.state.jobRuns.at(-1)!.summary}.`, 'good');
  },
  runReminders() {
    if (state.mode === 'connected') return void serverAction(async () => `Reminders: ${(await (await srv()).rpc<{ summary: string }>('run_reminder_job')).summary}. Preview only.`);
    const r = runReminderJob(state.ledger);
    setLedger(r.state);
    notify(`Reminders: ${r.state.jobRuns.at(-1)!.summary}. Preview only.`, 'good');
  },
  deliverPreviews() {
    if (state.mode === 'connected') return void serverAction(async () => `Message previews: ${(await (await srv()).rpc<{ summary: string }>('deliver_reminder_previews')).summary}.`);
    const r = deliverScheduledPreviews(state.ledger);
    setLedger(r.state);
    notify(`Simulated delivery: ${r.state.jobRuns.at(-1)!.summary}.`, 'good');
  },
  publishLevy(input: LevyInput): unknown {
    if (state.mode === 'connected') {
      return serverAction(async () => {
        await (await srv()).rpc('publish_levy', {
          p_name: input.name, p_amount_kobo: input.amountKobo, p_issue_date: input.issueDate, p_due_date: input.dueDate, p_member_ids: input.targetMemberIds,
        });
        return `${input.name.trim()} published to ${input.targetMemberIds.length} member${input.targetMemberIds.length === 1 ? '' : 's'}.`;
      });
    }
    return guard(() => {
      const r = publishLevyFn(state.ledger, input);
      setLedger(r.state);
      notify(`${r.levy.name} published to ${r.created.length} member${r.created.length === 1 ? '' : 's'}.`, 'good');
      return r.levy;
    });
  },
  reviewTask(taskId: string, note: string) {
    if (state.mode === 'connected') return void serverAction(async () => { await (await srv()).rpc('review_task', { p_task_id: taskId, p_note: note }); return 'Marked as reviewed.'; });
    guard(() => setLedger(reviewTaskFn(state.ledger, taskId, note)));
  },
  reportDiscrepancy(message: string): unknown {
    // Connected: the server records the task and its own analytics event (no free text).
    if (state.mode === 'connected') return serverAction(async () => { await (await srv()).rpc('report_discrepancy', { p_message: message }); return 'Thanks. An officer will look at it.'; });
    return guard(() => {
      setLedger(reportDiscrepancyFn(state.ledger, state.view.memberId, message));
      track('discrepancy reported', 'processing (simulated server)');
      return true;
    });
  },

  /** Connected: open the provider's hosted checkout for the chosen dues. */
  async payWithCheckout(chargeIds: string[], payAgain = false) {
    try {
      const r = await (await srv()).startHostedCheckout(chargeIds, payAgain);
      if (r.ok && r.authorizationUrl && r.reference) {
        try {
          sessionStorage.setItem(CHECKOUT_KEY, r.reference);
        } catch {
          /* the return page can still use the reference in the URL */
        }
        window.location.assign(r.authorizationUrl);
        return;
      }
      notify(r.message ?? 'Payments are unavailable right now. Nothing was charged.', 'warn');
      await refresh();
    } catch {
      notify('We could not reach the payment service. Nothing was charged.', 'warn');
    }
  },
  async signIn(email: string, password: string) {
    set({ connection: { status: 'loading' } });
    try {
      const { error } = await (await srv()).supabase().auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        const unreachable = /fetch|network/i.test(error.message);
        set({ connection: { status: unreachable ? 'error' : 'signed-out', message: unreachable ? UNREACHABLE : 'That email and password did not match a test account.' } });
        return;
      }
      await refresh();
    } catch {
      set({ connection: { status: 'error', message: UNREACHABLE } });
    }
  },
  async signOut() {
    await (await srv()).supabase().auth.signOut().catch(() => {});
    set({ ledger: emptyState(), connection: { status: 'signed-out' } });
  },
  retryConnection() {
    void startConnected();
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

// ---------------------------------------------------------------- connected mode

// Loaded only in connected mode, so the demo build carries no Supabase code.
const srv = () => import('../connected/server');

const CHECKOUT_KEY = 'community-ledger.checkout-reference';
const UNREACHABLE = "We can't reach Community Ledger right now. Nothing has been changed. Please try again.";

async function serverAction(fn: () => Promise<string>): Promise<boolean> {
  try {
    const message = await fn();
    await refresh();
    notify(message, 'good');
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    notify(/fetch|network/i.test(msg) || !msg ? UNREACHABLE : msg, 'warn');
    return false;
  }
}

/** Loads the signed-in user's records and checks them against the database's own totals. */
async function refresh() {
  try {
    const who = await (await srv()).whoami();
    if (!who.memberId && !who.isOfficer) {
      set({ ledger: emptyState(), connection: { status: 'unlinked' } });
      return;
    }
    const snap = await (await srv()).loadSnapshot(who.isOfficer);
    const mismatches: string[] = [];
    for (const b of snap.balances) {
      const mine = memberSummary(snap.ledger, b.memberId);
      if (mine.outstandingKobo !== b.outstandingKobo || mine.overdueKobo !== b.overdueKobo || mine.creditKobo !== b.creditKobo) {
        mismatches.push(snap.ledger.members.find((m) => m.id === b.memberId)?.displayName ?? b.memberId);
      }
    }
    const { data } = await (await srv()).supabase().auth.getSession();
    set({
      ledger: snap.ledger,
      view: who.isOfficer ? { role: 'officer', memberId: who.memberId ?? '' } : { role: 'member', memberId: who.memberId ?? '' },
      connection: {
        ...state.connection,
        status: 'ready',
        message: undefined,
        email: data.session?.user.email,
        isOfficer: who.isOfficer,
        mismatches,
        serverChecks: snap.report?.checks,
      },
    });
  } catch {
    set({ connection: { status: 'error', message: UNREACHABLE } });
  }
}

/** After returning from the hosted checkout: ask the server to verify with the provider. */
async function handleReturnFromCheckout() {
  const url = new URL(window.location.href);
  let reference: string | null = null;
  try {
    reference = sessionStorage.getItem(CHECKOUT_KEY);
  } catch {
    /* fall back to the URL */
  }
  reference = reference ?? url.searchParams.get('reference');
  if (!reference && url.searchParams.get('payment') !== 'return') return;
  // Remove the reference from the address bar and history straight away.
  window.history.replaceState(null, '', url.pathname + url.hash);
  if (!reference) return;
  set({ connection: { ...state.connection, returnStatus: 'checking' } });
  try {
    const r = await (await srv()).checkReturnedPayment(reference);
    try {
      sessionStorage.removeItem(CHECKOUT_KEY);
    } catch {
      /* ignore */
    }
    await refresh();
    set({ connection: { ...state.connection, returnStatus: (r.status as Connection['returnStatus']) ?? 'pending' } });
  } catch {
    set({ connection: { ...state.connection, returnStatus: 'checking-unavailable' } });
  }
}

async function startConnected() {
  if (!connectedConfigured) return;
  set({ connection: { status: 'loading' } });
  try {
    const { data, error } = await (await srv()).supabase().auth.getSession();
    if (error || !data.session) {
      set({ connection: { status: 'signed-out' } });
      return;
    }
    await refresh();
    if (state.connection.status === 'ready') await handleReturnFromCheckout();
  } catch {
    set({ connection: { status: 'error', message: UNREACHABLE } });
  }
}

if (appMode === 'connected') void startConnected();

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
