# Learning guide: the ledger database and its analytics

This guide uses Community Ledger's own schema. Every SQL example below runs
in the automated tests against the fictional seed data (`tests/db/learning.test.ts`),
so they stay correct as the schema changes. The figures quoted are what the
seed produces at the test clock (Tuesday 24 November 2026, 10:00 Lagos).

Run the examples as the database owner, for example in the Supabase SQL editor
of a **test** project. Row-level security does not apply to the owner, so you see
every member. Section 4 shows how to see what a member would see.

## 1. How money moves through the tables

```
dues_rules / levies  ->  charges            what each member owes, one row per rule period or levy
                          adjustments        signed corrections and waivers (never edits)
member chooses dues  ->  payment_attempts   intent, saved before checkout (+ payment_attempt_charges)
provider confirms    ->  payments           one row per provider transaction
                          allocations        how much of a payment went to which charge
                          receipts           one per payment
```

A balance is never stored. What a member owes on a charge is always:

`charge amount + sum(adjustments) - sum(allocations)`

Money is `bigint` kobo. ₦15,000 is `1500000`.

## 2. Why the constraints exist

| Constraint | What it prevents |
| --- | --- |
| `charges.key` unique | Running the recurring job twice creating a second charge for the same member and period. |
| `payments (provider, provider_ref)` unique | A repeated webhook for the same provider transaction creating a second payment. |
| `amount_kobo > 0` checks | Zero or negative payments, charges and allocations. |
| `allocations_not_over_charge` trigger | Two payments at once both being applied to the same debt (the second becomes credit instead). |
| Append-only triggers on payments, allocations, receipts, adjustments, audit_events | Quietly editing or deleting financial history. Mistakes are corrected with a new adjustment. |
| `currency = 'NGN'`, `environment = 'test'` | A payment in another currency, or from a live account, being posted into this test system. |
| Row-level security on every table | One member reading another member's records through the API. |

## 3. Practical queries

### What each member owes, split into overdue and upcoming

`member_balances` is a view built on `charge_balances`. Both are ordinary SQL you can read in the migration.

```sql
select display_name, outstanding_kobo / 100 as owes_naira, overdue_kobo / 100 as overdue_naira, upcoming_kobo / 100 as upcoming_naira
from public.member_balances
order by display_name;
```

Member A owes ₦30,000: ₦15,000 overdue and ₦15,000 upcoming.

### The same figure from the base tables, with a join

This is what the view does for you. `left join` keeps charges that have no allocations yet.

```sql
select m.display_name,
       sum(c.amount_kobo) - coalesce(sum(a.paid), 0) as outstanding_kobo
from public.members m
join public.charges c on c.member_id = m.id
left join (select charge_id, sum(amount_kobo) as paid from public.allocations group by charge_id) a on a.charge_id = c.id
group by m.display_name
order by m.display_name;
```

Notice that allocations are summed per charge *before* the join. Joining raw
allocation rows to charges and then summing would be fine here, but joining
payments to allocations and summing `payments.amount_kobo` would count a payment
once per charge it covers. Member B's single ₦35,000 payment covers three charges.

### Counting a payment once (the mistake to avoid)

```sql
select
  (select sum(amount_kobo) from public.payments) as received_correctly,
  (select sum(p.amount_kobo) from public.payments p join public.allocations a on a.payment_id = p.id) as received_counted_per_allocation;
```

The first is ₦40,000 (₦5,000 + ₦35,000). The second is ₦110,000, because
Member B's payment appears three times in the join.

### Where each payment went, and any credit left over

```sql
select p.provider_ref, p.amount_kobo,
       coalesce(sum(a.amount_kobo), 0) as allocated_kobo,
       p.amount_kobo - coalesce(sum(a.amount_kobo), 0) as credit_kobo
from public.payments p
left join public.allocations a on a.payment_id = p.id
group by p.id, p.provider_ref, p.amount_kobo
order by p.confirmed_at;
```

### Reconciliation checks

Each row should be empty or true. These mirror the checks on the Reports page.

```sql
-- Payments without exactly one receipt
select p.id from public.payments p left join public.receipts r on r.payment_id = p.id group by p.id having count(r.id) <> 1;
```

```sql
-- Received = applied + credit
select (select sum(amount_kobo) from public.payments)
     = (select sum(amount_kobo) from public.allocations) + (select coalesce(sum(app.payment_unapplied(id)), 0) from public.payments) as balanced;
```

```sql
-- No charge is over-allocated
select c.id, c.title from public.charges c
where (select coalesce(sum(amount_kobo), 0) from public.allocations a where a.charge_id = c.id) > c.amount_kobo + app.charge_adjusted(c.id);
```

### Collection by charge

```sql
select title, count(*) as members, sum(amount_kobo) as charged_kobo,
       sum(app.charge_allocated(id)) as paid_kobo, sum(app.charge_outstanding(id)) as still_owed_kobo
from public.charges
group by title
order by title;
```

### Payments that are still being checked

A pending attempt never reduces debt. After 48 hours it goes to Needs attention.

```sql
select pa.reference, m.display_name, pa.amount_kobo, pa.status, pa.verification_checks, app.now() - pa.created_at as waiting
from public.payment_attempts pa join public.members m on m.id = pa.member_id
where pa.status = 'pending';
```

### The audit trail

```sql
select at, actor, action, detail from public.audit_events order by id desc limit 10;
```

## 4. Seeing what a member sees (row-level security)

The API never runs as the owner. A signed-in member's request runs as the
`authenticated` role with their user id in the request's JWT claims, and the
policies filter every table. You can reproduce that inside a transaction. The
first statement links a temporary account to Member A, and `rollback` undoes
everything:

```sql
begin;
insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'learning-a@example.test');
update public.members set user_id = '11111111-1111-4111-8111-111111111111' where display_name = 'Member A';
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select display_name from public.members;           -- only Member A
select count(*) as other_members_payments from public.payments where member_id <> app.current_member_id();  -- 0
rollback;
```

The direct `update` works only because the owner runs it. Through the API,
every role is refused direct writes; linking accounts is a server-only function.
On a real Supabase project, `auth.users` has more columns. Create accounts with
`scripts/create-test-users.mjs` instead of inserting them by hand. This example
inserts into the minimal test version of that table.

## 5. PostHog: inspecting an event

What is sent (and nothing else):

| Event | Sent by | When |
| --- | --- | --- |
| `payment started` | server | the attempt row commits |
| `payment confirmed` | server | the payment transaction commits; once per payment |
| `discrepancy reported` | server | the member's report is saved (the text is not sent) |
| `statement viewed` | browser | the statement renders |
| `receipt viewed` | browser | a receipt renders |

Each event has a `distinct_id` such as `an_7f3a91c2d84e51be` (the member's opaque
analytics id, pseudonymous rather than anonymous) and only these properties:
`schema_version`, `environment` (`test`), `is_demo` (`false`), `surface` and
`$process_person_profile` (`false`, so no person profile is created). No names,
emails, phone numbers, amounts, payment references, free text or URLs are sent,
and no PostHog script runs in the browser, so there is no autocapture, replay or
automatic URL and device properties.

Server events are delivered by the scheduled `process-payments` function, so they
can appear a minute or so after the payment. Each retry re-sends the same `uuid`
and `timestamp` so PostHog can merge repeats; PostHog says this merging is
eventual and not guaranteed, which is why we also stop duplicates in our own
database first.

To look at events (PostHog's docs, read 31 October 2026):

1. Open the **Activity** tab (`https://eu.posthog.com/events` or `https://us.posthog.com/events`, matching your project's region). It refreshes about every 30 seconds.
2. Find `payment confirmed` and open it. Check the `distinct_id` and that the properties are only the ones listed above.
3. Compare with the outbound payload: in the database, `select event, distinct_id, properties, status from app.analytics_outbox order by occurred_at desc;`.

Before connecting real people, also check PostHog's own project settings for how
it handles IP addresses; that setting is on PostHog's side, not in this code.

## 6. PostHog: the payment funnel

Following PostHog's funnels documentation:

1. **Product analytics** → **+ New insight** → choose **Funnel**.
2. Step 1: event `payment started`. Step 2: event `payment confirmed`.
3. Set the **Conversion window limit** (for example 1 day). Payments not confirmed in that window count as drop-offs.
4. Add a filter so only test-system events count: event property `environment` equals `test`.
5. Optionally **+ Add breakdown** by `surface` to check every step came from the server.

What it can answer: of the members who started a payment, how many finished.
What it can't: why someone stopped, or anything meaningful from a handful of
test payments. Treat test-system numbers as checks that tracking works, not as
research about members.
