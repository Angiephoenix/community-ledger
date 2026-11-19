# Community Ledger

Community Ledger is a dues and payments portal for a community group in Nigeria. Members can see what they owe, pay selected charges, review statements and receipts, and report a payment discrepancy. Officers can issue levies, run recurring dues and reminder previews, review exceptions, and reconcile collections against outstanding balances.

## Try the demo

Use Node.js 22.12+ on the 22.x line, or Node.js 24+.

```bash
npm ci
npm run dev
```

Open the address printed by Vite, usually <http://localhost:5173>. The default demo uses fictional data in your browser and simulated checkout. It requires no account or credentials.

1. As **Member A**, start with ₦30,000 outstanding. Select **Choose what to pay**, leave the ₦15,000 annual dues selected, and simulate a successful payment. Open the receipt and confirm that the outstanding balance is now ₦15,000.
2. In **Demo controls**, choose **Deliver last confirmation again**. The receipt count and balance stay the same.
3. Reset the demo, then choose **Two payments for one charge**. Switch to the **Officer** view and open **Needs attention** to see the credit flagged for review. The **Reports** screen reconciles amounts received, applied and held as credit.

[Member overview](docs/screenshots/01-member-overview-desktop.png) · [Receipt](docs/screenshots/04-receipt-desktop.png) · [Officer review queue](docs/screenshots/08-needs-attention-desktop.png)

## How connected payments work

Supabase Auth identifies the member or officer, and PostgreSQL row-level security scopes what each signed-in account can see. When a member pays, an Edge Function calculates the amount from the selected charges, saves an attempt, and opens Paystack’s hosted test checkout.

The server verifies the transaction with Paystack. A browser redirect alone cannot credit a balance. The webhook handler checks Paystack’s signature and stores the event for processing. The return handler and a scheduled worker cover confirmations that arrive by other paths. Verification checks the reference, amount, currency, status and test environment before posting.

A single PostgreSQL transaction records the payment, allocates it to open charges, issues one receipt, and cancels the corresponding unsent reminder when a charge is paid. Balances are calculated from charges, adjustments and allocations in integer kobo. A repeated confirmation cannot create a second payment for the same provider transaction. When two **different** transactions settle for one charge, the excess remains as credit and an officer gets a review task.

## What was tested

In the hosted Supabase and Paystack test environment, a ₦15,000 payment settled the selected annual dues, reduced the member’s outstanding balance from ₦30,000 to ₦15,000, and produced one ledger receipt. A separate test paid two hosted checkouts for the same ₦5,000 charge. The ledger applied the first payment and held the second as ₦5,000 in unapplied credit, with its own receipt and an officer review task. Declined and closed checkouts left the ledger balance unchanged.

The [test results](docs/TEST-RESULTS.md) cover the hosted runs and remaining verification. The [connected setup guide](docs/CONNECTED-SYSTEM.md) shows how to use your own Supabase project and Paystack test credentials.

## Run the checks

| Command | Coverage |
| --- | --- |
| `npm test` | Demo ledger, connected client behavior, Paystack adapter and tooling against simulated services |
| `npm run test:db` | Migrations, row-level security, payment processing and Edge Function handlers. Set `PG_BIN` to your PostgreSQL 16 binary directory if needed. |
| `npm run check:functions` | Deno type-check for Edge Functions and their tests |
| `npm run typecheck` | TypeScript check for the client and tests |
| `npm run build` | TypeScript check and Vite production build |

The database suite starts a disposable PostgreSQL cluster. It uses fictional seed data and requires no hosted credentials. The Deno checks need access to the locked dependencies on their first run.

## Project layout

| Path | What to find |
| --- | --- |
| [`src/domain/`](src/domain) | Demo rules for dues, balances, allocations, reminders and reports |
| [`src/connected/`](src/connected) | Supabase client, record mapping and payment-return checks |
| [`supabase/functions/`](supabase/functions) | Hosted checkout, signed webhook, return verification and payment worker |
| [`supabase/migrations/`](supabase/migrations) | Ledger tables, access policies and transactional payment posting |
| [`tests/db/`](tests/db) | Access, ledger and payment-pipeline checks |
| [`docs/LEARNING-GUIDE.md`](docs/LEARNING-GUIDE.md) | SQL examples for balances and payment reconciliation |

## Project limits

The connected system runs in test mode with fictional records. Hosted verification still needs an unlinked-account sign-in, a Paystack webhook redelivery, and a second provider verification of a posted payment. Local tests cover duplicate events and unlinked-account permissions. The hosted adjustments table was empty during the access check, so adjustment visibility was verified locally using populated test data.

The payment worker was scheduled on the test project. Dues and reminder jobs are run by an officer, and messages are previews. Handling refunds or applying credit to future dues, bank settlement and fee reconciliation, and live payment processing are outside the current implementation.
