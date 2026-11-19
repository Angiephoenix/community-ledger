# Connected test results

These results are from the hosted Supabase and Paystack test environment on 8 November 2026. The members, charges and all payments in these scenarios were fictional or test-mode records. Payment and balance results were checked against before-and-after database snapshots. Provider receipts corroborated the three successful test payments.

| Scenario | Observed result |
| --- | --- |
| Annual dues payment | Paystack’s signed success event was stored and processed. Server verification recorded one ₦15,000 payment, one allocation and one ledger receipt. Member outstanding fell from ₦30,000 to ₦15,000. The associated overdue reminder was cancelled before sending. |
| Reopened payment return | Reopening the successful return URL left payments, receipts, allocations and balances unchanged. The app looked up the already-confirmed attempt in the database. |
| Two successful checkouts for one charge | A newer checkout replaced an older unsubmitted attempt in the ledger. Both Paystack checkout pages could still accept payment. The first successful ₦5,000 payment settled the charge. The second produced its own receipt and an officer review task, with the full ₦5,000 held as credit and no additional allocation. |
| Declined and closed checkout | The attempts ended as failed and abandoned. Neither created a payment, allocation or receipt. The member’s balance stayed the same. The close-button retest also confirmed that the app showed the provider-checked status when the user returned. |
| Member-reported discrepancy | Reporting a problem created one officer review task, one audit entry and one analytics event. Payment records and balances stayed the same. |
| Access checks | Four linked members and an officer signed in. The hosted access run returned 222 passes, zero failures and four inconclusive adjustment checks because there were no adjustment rows. Local tests exercise populated adjustments and an unlinked account. Some probes that could change records were left out of the hosted run. |
| Scheduled worker and analytics | The worker ran on the Supabase test schedule. PostHog’s test query returned all five expected events and a completed payment funnel. The verification run found no sensitive properties in those events. |

The webhook acknowledgement is inferred from the handler and the stored event. The Paystack delivery log was outside this check. Reopening a payment return exercised the already-confirmed lookup. A provider re-verification of that payment and a Paystack webhook redelivery remain to be tested in the hosted environment. The unlinked sign-in screen also awaits a hosted run. The older checkout’s replacement reason is stored on the attempt and has no separate audit entry.
