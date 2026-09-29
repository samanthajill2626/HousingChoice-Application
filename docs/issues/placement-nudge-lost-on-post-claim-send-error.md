---
id: placement-nudge-lost-on-post-claim-send-error
title: A placement nudge is lost, and the card reads "Sent", when the send errors after claimSend has stamped sentAt
type: bug
severity: low
status: open
area: app/placements
created: 2026-09-25
refs: app/src/jobs/placementNudges.ts:353, app/src/jobs/placementNudges.ts:660, app/src/jobs/placementNudges.ts:672, app/src/jobs/placementNudges.ts:711, app/src/jobs/placementNudges.ts:844, app/src/jobs/placementNudges.ts:854, app/src/jobs/placementNudges.ts:888, app/src/routes/placementNudges.ts:175
---

**Problem.** The placement nudge poll has the tour reminder poll's shape. It
claims a due nudge with `claimSend` - the `sentAt` stamp - at
`app/src/jobs/placementNudges.ts:660`, sends at `:672`, and rethrows every
non-refusal error at `:711` into the per-row catch (`:353-364`), which logs and
moves on. The claim stays, so the next tick never retries. The operator Send
now path does the same: claim at `:844`, send at `:854`, rethrow at `:888`
(a 500 to the operator).

The errors that reach the rethrow include `sendMessage`'s reads before the
provider call and a Twilio 4xx or 429 - nothing was sent - as well as
ambiguous and post-send failures.

What staff see: the nudge card derives its state from `sentAt` alone
(`app/src/routes/placementNudges.ts:175`), so a nudge that never went out reads
"Sent".

Filed as low (the sweep rated it low-to-medium): the loss is documented as an
accepted tradeoff in the code (`:669-670`, `:705-706`), the ERROR at `:707-710`
is logged, and one nudge is at stake per failure. The false "Sent" is the part
that misleads.

**Suggested fix.** Group: send-shaped - adopt the send-outcome core + the
send-attempt record from `feat/send-outcome-reconcile` (merged at `79b9479e`; see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9): with D3's typed errors a nudge whose send was never attempted can be
released or recorded as not sent, an `unknown` outcome can be reconciled, and
the card can stop reading `sentAt` alone as "Sent". Fix together with
[tour-reminder-lost-on-post-claim-send-error](./tour-reminder-lost-on-post-claim-send-error.md);
the two polls are deliberately parallel.

**Related.**
[tour-reminder-lost-on-post-claim-send-error](./tour-reminder-lost-on-post-claim-send-error.md),
[reminder-state-sent-overstates-delivery](./reminder-state-sent-overstates-delivery.md)
(the refusal variant, tour side only). Sweep finding F7 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
