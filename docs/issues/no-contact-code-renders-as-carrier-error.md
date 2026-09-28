---
id: no-contact-code-renders-as-carrier-error
title: The app-invented no_contact code renders as a fake carrier error, "Delivery failed (error no_contact)"
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-09-25
refs: app/src/jobs/broadcastFanOut.ts:368, dashboard/src/routes/contact/deliveryStatus.ts:913, dashboard/src/routes/contact/deliveryStatus.ts:976, dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31, app/src/services/relayAnnouncements.ts:367
---

**Problem.** When a broadcast recipient has no resolvable contact or phone, the
fan-out marks the slot `failed` with the app-invented code `no_contact`
(`app/src/jobs/broadcastFanOut.ts:368`). The share results row renders a failed
slot's reason through `deliveryReason` (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`).
`deliveryReason` checks the internal-code map first
(`dashboard/src/routes/contact/deliveryStatus.ts:913-934`), which holds
`contact_opted_out`, `transient_cap`, `enqueue_failed` and the relay retry
refusals but not `no_contact`; so the code falls through the carrier maps to the
generic template at `:976` and the row reads "Delivery failed (error
no_contact)" - dressed as a Twilio error number, for a text that was never
attempted.

The same fall-through is reachable by at least one other app-side token: the
relay announcement catch writes `send_failed` onto a member's slot for any
error that carries no provider code - a timeout, a dropped socket, a failed
database write (`app/src/services/relayAnnouncements.ts:367`) - and the relay
leg row then reads "Delivery failed (error send_failed)". The rule the
send-outcome design adopts (D23: "new codes render as prose, never as fake
carrier numbers") covers only the codes that branch adds.

**Partial resolution, verified 2026-09-28.** `feat/share-skip-fix` (Branch A)
has merged and been retired. The share-row `no_contact` case is fixed:
`DeliveryBadge` calls `shareRecipientReason`, whose failed-row special case
returns "No contact or phone on file"
(`dashboard/src/routes/broadcasts/broadcastFormat.ts:162-169`). The original
share-row diagnosis above is historical. This issue remains open for the
relay-slot `send_failed` token and the generic app-code fallback; those were
outside Branch A's scope, and the shared `deliveryReason` map still has no
`send_failed` entry. See the [Branch A closeout](../superpowers/reviews/2026-09-24-share-skip-fix/README.md).

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); not a send - dashboard copy. Add `no_contact` (and any other
app-invented token that can reach a slot) to the internal-code map with prose,
and consider making the generic `(error N)` template apply only to values that
look like provider codes, so the next unmapped token fails safe.

**Related.**
[broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md).
Presentation finding 1 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/presentation-findings.md`.
