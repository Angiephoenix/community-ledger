// Which system this build talks to. Set at build time.
//   demo      : the standalone milestone 1 demo (default). Local fictional data.
//   connected : the connected test system (Supabase + payment provider test mode).
// A connected build never falls back to demo data if the server is unreachable.

import { brand } from './brand';

const env = import.meta.env;

export const appMode: 'demo' | 'connected' = env.VITE_APP_MODE === 'connected' ? 'connected' : 'demo';

export const connectedConfig = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined) ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
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
        runNowHelp: 'Scheduled runs are not set up in this test system yet. Run them here when you need them.',
        payFootnote: 'Test payments only · No real money',
        paymentKind: 'Test payment',
        method: 'Online payment (test mode)',
        receiptBadge: 'Test payment · Test system',
        receiptMoney: 'This is a test system: no real money moved.',
      }
    : {
        notice: brand.demoNotice,
        runNow: 'Run now · Demo',
        runNowHelp: 'In the connected version these run on a schedule. Here you can run them yourself against the demo clock.',
        payFootnote: 'Demo · No real payments',
        paymentKind: 'Simulated',
        method: 'Payment simulator',
        receiptBadge: 'Simulated payment · Demo',
        receiptMoney: 'In this demo no real money moved.',
      };

export const connectedConfigured = Boolean(connectedConfig.supabaseUrl && connectedConfig.supabaseAnonKey);
