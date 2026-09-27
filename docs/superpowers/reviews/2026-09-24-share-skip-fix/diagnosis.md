# Diagnosis - Sam's item #5 ("sharing a property one-to-one shows Skipped")

Date: 2026-09-24. Method: one read-only production query (DynamoDB Get/Query/Scan
only, `housingchoice` profile, account 938565869261 asserted before any read,
phones masked, no message bodies). Run on Cameron's explicit go. The tenant Sam
named is not identified in this record (no names, phones or ids).

## Hypotheses and outcome

| # | Hypothesis | Evidence | Outcome |
|---|---|---|---|
| H1 | The Quo import created the tenant's one-to-one conversation with `ai_mode = manual`; every share (sent as automated) is refused | Conversation `ai_mode` manual, stamped by the Quo/Airtable import; every share slot `skipped` + `manual_mode` | CONFIRMED |
| H2 | A breaker trip switched the conversation off | Zero `mode_changed` audit events on the conversation | Ruled out |
| H3 | Two open conversations on the phone; shares land in a different one than Sam types in | Exactly one conversation on the phone | Ruled out |
| H4 | A STOP on the conversation (not the contact) | Conversation and contact both not opted out | Ruled out |
| H5 | `sms_unreachable` set on the contact | Flag absent. Also structurally cannot produce a Skipped slot: the send route and seed resolution drop unreachable contacts before the recipients map exists (a 400 `empty_audience`), except inside a seconds-wide race | Ruled out |
| H6 | No recorded consent | `consent_method` present | Ruled out |
| H7 | A duplicate or soft-deleted contact on the same phone | Exactly one contact on the phone, not deleted | Ruled out |

## Facts found

- Four one-to-one shares (seeds-only broadcasts) between 2026-08-31 and 2026-09-22,
  covering three properties; every recipient slot is `skipped` with reason
  `manual_mode`; every broadcast finalized as `sent`.
- 110 staff sends in the conversation's audit trail, all `automated: false`, all
  accepted. On 2026-09-22 a staff message went out 23 seconds after the refused
  share - consistent with Sam pasting the flyer link by hand (message bodies were
  not read).
- Zero listing-send ledger rows for the tenant: no property ever reached them
  through the app.
- The conversation is still typed `unknown_1to1` although the contact is a tenant.
- The import-created conversation has NO `phone#<E164>` claim item (the lock
  `createOrGetByParticipantPhone` uses to guarantee one conversation per phone).
  Low risk: the claim is read only when the byParticipantPhone GSI fast path
  misses.

## Design consequences (fed into the spec)

- The root cause is data (import default) plus a design mismatch (staff shares sent
  as automated; the switch gating all automation). Both are addressed; the switch
  redesign is deferred to WP2 by Cameron's decision
  ([ai-mode-switch-gates-all-automation](../../../issues/ai-mode-switch-gates-all-automation.md)).
- The mission brief's second candidate cause (`sms_unreachable`) does not fit the
  reported symptoms; the spec still gives unreachable skips their own recorded
  reason because the fan-out can produce one inside the race window.
