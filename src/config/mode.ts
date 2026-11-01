// Which system this build talks to. Set at build time.
//   demo      : the standalone milestone 1 demo (default). Local fictional data.
//   connected : the connected test system (Supabase + payment provider test mode).
// A connected build never falls back to demo data if the server is unreachable.

import { brand } from './brand';

const env = import.meta.env;

export const appMode: 'demo' | 'connected' = env.VITE_APP_MODE === 'connected' ? 'connected' : 'demo';

export const connectedConfig = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined) ?? '',
  supabasePublishableKey: (env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '',
  functionsUrl: ((env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined) ?? '') || ((env.VITE_SUPABASE_URL as string | undefined) ?? '') + '/functions/v1',
  posthogHost: (env.VITE_POSTHOG_HOST as string | undefined) ?? '',
  posthogKey: (env.VITE_POSTHOG_PROJECT_KEY as string | undefined) ?? '',
};

/** Honest labels for the current mode, used wherever payments are described. */
export const modeLabels =
  appMode === 'connected'
    ? {
        notice: brand.testNotice,
        runNow: 'Run now · Test system',
        // Checked against the test project's cron.job on 1 November 2026: the only
        // schedule is the payment worker. Dues and reminders have none.
        runNowHelp:
          'Recurring dues and reminders do not run on a schedule in this test system. Run them here when you need them. Payment confirmations are handled separately by the server’s payment worker.',
        recordsLabel: 'Test system with fictional records',
        trackingScope: 'this test system',
        membersHelp:
          'Fictional test members, with each member’s balance and status. Members and their sign-in accounts are set up by the system administrator; there is no screen to add or edit them yet.',
        payFootnote: 'Test payments only · No real money',
        paymentKind: 'Test payment',
        method: 'Online payment (test mode)',
        receiptBadge: 'Test payment · Test system',
        receiptMoney: 'This is a test system: no real money moved.',
      }
    : {
        notice: brand.demoNotice,
        runNow: 'Run now · Demo',
        runNowHelp: 'Nothing runs on a schedule in this demo. Run each job yourself against the demo clock.',
        recordsLabel: 'Demo with fictional records',
        trackingScope: 'this demo',
        membersHelp: 'Fictional members, with each member’s balance and status. There is no screen to add or edit members in this demo.',
        payFootnote: 'Demo · No real payments',
        paymentKind: 'Simulated',
        method: 'Payment simulator',
        receiptBadge: 'Simulated payment · Demo',
        receiptMoney: 'In this demo no real money moved.',
      };

export const connectedConfigured = Boolean(connectedConfig.supabaseUrl && connectedConfig.supabasePublishableKey);
