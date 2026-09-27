---
id: unconfirmed-share-invites-resend
title: A share whose texts all ended "Not confirmed" finalizes Failed and drops out of the "Already sent this property" set, so the next share of the property offers those tenants pre-checked
type: bug
severity: med
status: open
area: app/broadcasts
created: 2026-09-27
refs: app/src/jobs/broadcastFanOut.ts:1533, app/src/jobs/broadcastFanOut.ts:158, app/src/repos/broadcastsRepo.ts:716, app/src/routes/broadcasts.ts:521, app/test/helpers/twilioWebhookHarness.ts:3266, dashboard/src/routes/broadcasts/RecipientPreview.tsx:9, dashboard/src/routes/broadcasts/broadcastFormat.ts:78, dashboard/src/routes/broadcasts/BroadcastResults.tsx:52, app/test/broadcastFanOut.test.ts:1538
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding M-1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem.** The branch's per-recipient design takes care NOT to invite a
resend to a tenant whose text the platform could not confirm - the text may
have gone out. The share level and the next share of the same property
contradict it.

1. **The share finalizes `failed`, by design.** `finalize` fails a share
   when no recipient reached sent/delivered and at least one is failed OR
   unconfirmed (`app/src/jobs/broadcastFanOut.ts:1533-1537`) - spec D16a
   (`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`,
   D16a, "so an all-unconfirmed share reads a red Failed pill"). The
   branch's own test pins it for a one-recipient share whose reconcile
   enqueue failed (`app/test/broadcastFanOut.test.ts:1538-1558`: status
   `failed`, `last_error` "Couldn't confirm any text went out",
   `broadcastFanOut.ts:158`). Before the branch an unknown outcome threw and
   the share stayed `sending`.
2. **It reads "Failed".** The pill is "Failed", tone danger, on the list row
   and the results header (`dashboard/src/routes/broadcasts/broadcastFormat.ts:78`,
   `:97-104`) - while the row for the same recipient deliberately drops the
   "open conversation to retry" hint for `send_unconfirmed`
   (`dashboard/src/routes/broadcasts/BroadcastResults.tsx:52-56`).
3. **It drops out of the "Already sent this property" set.**
   `priorRecipientContactIds` skips every broadcast whose status is not
   `sent` or `sending` (`app/src/repos/broadcastsRepo.ts:716`); the preview
   uses that set for `alreadySentThisProperty`
   (`app/src/routes/broadcasts.ts:521-548`), which is what renders a row amber
   and starts it UNCHECKED in the composer
   (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:9-13`). The
   in-memory harness mirrors the rule
   (`app/test/helpers/twilioWebhookHarness.ts:3266-3279`). So a tenant who may
   well have received the text is offered on the next share of the same
   property unflagged and pre-checked, and "Select all" includes them.

Before the branch the same tenant sat in a `sending` share, which the set
DOES count - so for this case the branch moves a tenant from "flagged" to
"not flagged".

**Evidence.** The reviewer's throwaway FakeWorld test (pure unit, no DynamoDB,
deleted afterwards; method in the review file's header): one tenant, an
unknown send outcome, an unresolved reconcile close -> slot
`failed`/`send_unconfirmed`, share `failed`, and
`priorRecipientContactIds('unit-1')` returns an empty set.

**Reach.** Every share in which no recipient was confirmed and at least one
ended `send_unconfirmed` - in practice every one-recipient share (the
matching page's one-to-one send) whose reconcile ends unresolved. A share
with any sent or delivered recipient finalizes `sent`, and its unconfirmed
slots DO count (the set keeps failed slots of `sent` shares). If the
hosted-dev check finds link shortening or Advanced Opt-Out rewriting bodies
([send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md),
item 4), EVERY ambiguous share send ends unresolved, which widens this to
every such one-recipient share.

**Known context.** The share-skip-fix spec already accepts that an
all-failed share "is excluded whole" from the interim "Already sent" rule,
and says Branch B's attempts rule replaces it
(`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md:405-409`). That
tradeoff was reasoned about FAILED texts, which (30003 aside) were never
delivered. An unconfirmed text may have been delivered, so for it the
exclusion errs toward a double text rather than a missed tenant. Branch B
should carry this case explicitly.

**Suggested fix.** Count a recipient whose slot carries `send_unconfirmed`
in the prior-recipients set whatever the broadcast's status - including
`failed` broadcasts - and in any other "reached" notion; change the repo
(`broadcastsRepo.ts:702-745`) and the harness mirror together, as the repo's
comment requires. Optionally (a product call, since spec D10 adds no
broadcast status) present an all-unconfirmed share as something other than
"Failed" - a presentation-only label like share-skip-fix's "Not sent"
(`presentShareLabel`, `broadcastFormat.ts:97-104`).

**What this is NOT.** Not a new automatic double text: a second text needs a
person to send another share of the same property and leave the unflagged
row checked. Not the per-row retry hint, which is already suppressed
correctly. Not a change to the stored status rule (D16a stands); the fix is
in the reader.

**Related.** [send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md),
[outage-brake-burns-ladder-rungs](./outage-brake-burns-ladder-rungs.md),
[send-outcome-dashboard-residues](./send-outcome-dashboard-residues.md).
