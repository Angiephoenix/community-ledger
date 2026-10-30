# Community Ledger

A dues portal for a community group in Nigeria. This is **milestone 1: a local interactive demo**. Every record is fictional. Payments are simulated and messages are previews only.

> Demo · Fictional records · No real payments. Nothing in this app talks to a payment provider, a messaging service or an analytics service.

## Run it

Requires Node 20.19 or newer (tested with Node 22.22).

```bash
npm install
```

```bash
npm run dev
```

Open the address Vite prints (usually http://localhost:5173).

Other commands:

```bash
npm test            # domain and analytics checks (Vitest)
npm run build       # type-check and production build into dist/
npm run preview     # serve the production build locally
```

`.npmrc` sets `legacy-peer-deps=true` because npm 10.9 crashed while resolving peer dependencies for this package set.

## Demo walkthrough

The demo clock starts at **Tuesday 24 November 2026, 10:00 (Lagos)**. Open **Demo controls** (top right) to switch views, move the clock, deliver payment events and reset.

1. **Officer runs the recurring job.** Switch to *Officer* and select *Run recurring dues*. The December meeting contribution (₦2,000, fictional) is charged once to each eligible member. Run it again: 0 new charges. (This adds ₦2,000 to Member A, so do steps 2–5 from a fresh reset if you want the exact scenario figures.)
2. **Member A sees their dues.** ₦30,000 total: ₦15,000 overdue, ₦15,000 upcoming. Next due 30 November.
3. **Choose what to pay.** Annual dues (₦15,000 remaining) is preselected. Select *Pay ₦15,000*. The payment attempt is saved before the checkout opens.
4. **Simulate payment.** The simulator sends a confirmation. One processing function records the payment, applies it, issues a receipt and cancels the unsent overdue reminder. You then see *Payment received*, the remaining ₦15,000 and *View receipt*.
5. **Deliver the same confirmation again** (Demo controls → *Deliver last confirmation again*). Nothing changes: no second payment, receipt or balance change.
6. **Switch to Officer.** Overview, Members and Reports show the same figures. Reports lists five consistency checks.
7. **Reminders.** *Run reminders*, then run again: no duplicates. Paid charges are skipped. *Prepare message previews* rechecks each message just before simulated delivery. Messages say "Preview only · not sent".

Other cases:
- **Pending/failed**: in the checkout, choose *Simulate a pending payment* or *Simulate a failed payment*. The balance does not change. Reminders for that charge pause for 48 hours, then resume, and the attempt goes to Needs attention.
- **Two payments for one charge**: Demo controls → *Two payments for one charge*. Both payments are kept. The second becomes credit flagged in Needs attention.
- **Special levy**: Officer → Dues → New levy. Pick members, review, publish.
- **Other members**: Member B has paid everything; Member C has an unconfirmed payment; Member D has no dues yet.

## What the main records mean

| Record | What it is |
| --- | --- |
| `DuesRule` | A recurring dues definition, e.g. "Annual dues, ₦20,000, due 20 November". Not a debt. |
| `Levy` | A one-off charge for selected members. |
| `Charge` | One member's debt for one rule period or levy. Has a unique `key` so a rerun can't duplicate it. |
| `PaymentAttempt` | What a member chose to pay, saved before checkout. Pending or failed attempts never reduce debt. |
| `Payment` | A confirmed incoming payment. One per provider transaction reference. |
| `Allocation` | How much of a payment went to which charge. One payment can cover several charges. |
| `Receipt` | Proof that the payment was recorded. Not proof of bank settlement. |
| `OutboxMessage` | A message that would be sent. Milestone 1 only produces previews. |
| `Task` | An item in Needs attention: extra payments, held payments, unconfirmed payments, member reports. |
| `AuditEvent` | A log line for each financial change or job run. |

Balances are never stored. What a member owes is always **charge amount + adjustments − allocations**, computed from these records. Money is stored as **integer kobo** (₦1 = 100 kobo).

## Where the logic lives

| Concern | File |
| --- | --- |
| Money (kobo, formatting, parsing) | `src/domain/money.ts` |
| Dates and Lagos deadlines | `src/domain/time.ts` |
| Balances, charge status, member totals | `src/domain/ledger.ts` |
| Recurring dues job, levies | `src/domain/assessment.ts` |
| Payment attempts and confirmation processing | `src/domain/payments.ts` (`processPaymentEvent`) |
| Reminder job, cancellation, simulated delivery | `src/domain/reminders.ts` |
| Officer report, statement, Needs attention actions | `src/domain/reports.ts` |
| Fictional starting data | `src/domain/fixtures.ts` |
| Analytics events and allowlist | `src/adapters/analytics.ts` (events fired from `src/state/store.ts`, `MemberStatement.tsx`, `ReceiptView.tsx`) |
| Payment provider boundary (simulator) | `src/adapters/paymentProvider.ts` |
| Shared store and local persistence | `src/state/store.ts` |
| Placeholder name, colours, contacts | `src/config/brand.ts` |
| Tests | `tests/ledger.test.ts`, `tests/analytics.test.ts` |

UI components only read state and call store actions; they don't compute money themselves.

## Rules used in the demo

These are demo defaults, not the group's confirmed rules.

- **Overdue** from 00:00 Lagos time on the day after the due date (a charge due 20 November can be paid until the end of 20 November).
- **Due soon** once 75% of the time between issue date and that cutoff has passed (`config.dueSoonFraction`).
- **Paid** takes precedence over any date status. A pending attempt is shown separately and never counts as paid.
- **Allocation**: a payment is applied to the selected charges with the earliest due date first, never beyond what is owed. Any excess is kept as credit for officer review.
- **Held payments**: an unknown reference, wrong amount or non-NGN currency is not applied. It goes to Needs attention.
- **Reminder pause**: 48 hours while a payment is unconfirmed (`config.pendingPauseHours`).
- **Overdue reminders**: at most one per charge per week overdue. Due-soon: one per charge.
- **Recurring job**: assesses the current period and the next one if it opens within 10 days. Members must be active and have joined by the period's issue date.
- Receipts are numbered `RCT-<year>-<n>`.

## Implemented, simulated, missing

**Implemented (working in the browser):** member Overview / Payments / Statement; officer Overview / Members / Dues / Needs attention / Reports; recurring assessment with duplicate prevention; levy creation targeting selected members; payment attempts; confirmation processing with allocation, receipts, duplicate rejection, held events and overpayment credit; reminder job with duplicate prevention, cancellation on payment, bounded pause and recheck before delivery; collection report with consistency checks; printable statement, report and receipt (via the browser's print dialog); audit trail; local analytics adapter with allowlist and inspector; demo clock, reset and view switch; versioned local persistence; empty, pending, failed, all-paid and partial states; phone and desktop layouts.

**Simulated:** payment provider and confirmation events; message delivery (preview only); scheduled jobs (run by button); the view switch (no sign-in).

**Missing (later milestones):** authentication and permissions; Supabase/PostgreSQL; Paystack or any real provider, including signature verification; WhatsApp/email delivery and delivery-failure retries; PostHog; adding or editing members; refunds or carrying credit forward (needs a group rule); waivers/corrections UI (the `Adjustment` record exists and balances honour it, but there is no screen); bank settlement and fee tracking; a dedicated PDF download.

## Next step (milestone 2)

Move the records into Supabase PostgreSQL with unique constraints matching the keys used here (`charges.key`, `payments.provider_ref`, `notification_outbox.key`), add Supabase Auth and row-level policies, and replace the simulator with a server-side Paystack test-mode integration that verifies signatures and re-checks transactions before calling the same processing logic.
