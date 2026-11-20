# Community Ledger

Community Ledger is a volunteer project built to help a community manage member dues. Members had no clear way to see which payments had been recorded or what they still owed, and the secretary lacked a reliable record of collections.

The ledger lets members pay dues, check balances, view receipts and report discrepancies. Officers can issue levies, reconcile collections and review payments that need attention.

## Run the demo

Use Node.js 22.12+ on the 22.x line, or Node.js 24+.

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. The demo uses fictional data and simulated payments and runs without credentials.

## Payment handling

Supabase Auth and PostgreSQL row-level security control access. Members pay through Paystack’s hosted test checkout. Supabase Edge Functions verify the payment before the ledger allocates it and issues a receipt.

A repeated confirmation leaves the ledger unchanged. If two distinct payments settle for one charge, the second is recorded as credit, with its own receipt and an officer review task.

## Testing

Hosted tests covered successful payment and allocation, duplicate handling on the return path, excess credit, declined and abandoned checkouts, and a member-reported discrepancy. See the [test results and gaps](docs/TEST-RESULTS.md) and [connected setup guide](docs/CONNECTED-SYSTEM.md).

Run `npm test` for app tests, `npm run test:db` for PostgreSQL and Edge Function tests, and `npm run build` for the production build.
