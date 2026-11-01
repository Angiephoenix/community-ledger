import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connectedConfig } from '../config/mode';
import { toLedgerState, type ServerRows } from './mapRows';
import type { LedgerState } from '../domain/types';

// All reads and writes for the connected test system. Reads go through the
// API under the signed-in user's session, so row-level security decides what
// comes back. Writes are database functions or Edge Functions only.

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(connectedConfig.supabaseUrl, connectedConfig.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

export class ConnectionError extends Error {}

async function rows<T = Record<string, unknown>>(p: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new ConnectionError(error.message);
  return data ?? [];
}

export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface Who {
  memberId: string | null;
  displayName: string | null;
  isOfficer: boolean;
}

export async function whoami(): Promise<Who> {
  const r = await rpc<{ member_id: string | null; display_name: string | null; is_officer: boolean }>('whoami');
  return { memberId: r.member_id, displayName: r.display_name, isOfficer: r.is_officer };
}

export interface ServerSnapshot {
  ledger: LedgerState;
  /** Database-computed balances per member, for the consistency check. */
  balances: { memberId: string; outstandingKobo: number; overdueKobo: number; creditKobo: number }[];
  report: { checks: { label: string; ok: boolean }[]; outstanding_kobo: number; collected_kobo: number } | null;
}

export async function loadSnapshot(isOfficer: boolean): Promise<ServerSnapshot> {
  const db = supabase();
  const none = Promise.resolve([] as Record<string, unknown>[]);
  const [clock, members, rules, levies, levyTargets, charges, adjustments, attempts, attemptCharges, payments, allocations, receipts, outbox, tasks, jobRuns, audit, balances] =
    await Promise.all([
      rpc<string>('ledger_clock'),
      rows(db.from('members').select('id, display_name, status, joined_on, reminder_channel, analytics_id')),
      rows(db.from('dues_rules').select('*')),
      isOfficer ? rows(db.from('levies').select('*')) : none,
      isOfficer ? rows(db.from('levy_targets').select('*')) : none,
      rows(db.from('charges').select('*')),
      rows(db.from('adjustments').select('*')),
      rows(db.from('payment_attempts').select('id, reference, member_id, amount_kobo, status, created_at, updated_at, verification_checks')),
      rows(db.from('payment_attempt_charges').select('*')),
      rows(db.from('payments').select('id, provider_ref, attempt_id, member_id, amount_kobo, confirmed_at, source, fee_kobo')),
      rows(db.from('allocations').select('*')),
      rows(db.from('receipts').select('*')),
      isOfficer ? rows(db.from('outbox_messages').select('*')) : none,
      isOfficer ? rows(db.from('tasks').select('*')) : none,
      isOfficer ? rows(db.from('job_runs').select('*').order('ran_at', { ascending: true })) : none,
      isOfficer ? rows(db.from('audit_events').select('*').order('id', { ascending: false }).limit(200)) : none,
      rows(db.from('member_balances').select('member_id, outstanding_kobo, overdue_kobo, credit_kobo')),
    ]);
  const serverRows: ServerRows = {
    clock, members, rules, levies, levyTargets, charges, adjustments, attempts, attemptCharges, payments, allocations, receipts,
    outbox, tasks, jobRuns, audit: [...audit].reverse(),
  };
  return {
    ledger: toLedgerState(serverRows),
    balances: balances.map((b) => ({
      memberId: String(b.member_id),
      outstandingKobo: Number(b.outstanding_kobo),
      overdueKobo: Number(b.overdue_kobo),
      creditKobo: Number(b.credit_kobo),
    })),
    report: isOfficer ? await rpc('collection_report') : null,
  };
}

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(`${connectedConfig.functionsUrl}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: connectedConfig.supabasePublishableKey },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return json;
}

export function startHostedCheckout(chargeIds: string[], payAgain = false) {
  return callFunction<{ ok: boolean; authorizationUrl?: string; reference?: string; message?: string }>('create-checkout', { chargeIds, payAgain });
}

export function checkReturnedPayment(reference: string) {
  return callFunction<{ status: string }>('payment-return', { reference });
}
