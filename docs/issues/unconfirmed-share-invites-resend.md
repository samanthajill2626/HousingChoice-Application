---
id: unconfirmed-share-invites-resend
title: A share whose texts all ended "Not confirmed" finalizes Failed and drops out of the "Already sent this property" set, so the next share of the property offers those tenants pre-checked
type: bug
severity: med
status: resolved
area: app/broadcasts
created: 2026-09-27
updated: 2026-09-28
resolved: 2026-09-28
refs: app/src/jobs/broadcastFanOut.ts:1533, app/src/jobs/broadcastFanOut.ts:158, app/src/repos/broadcastsRepo.ts:716, app/src/routes/broadcasts.ts:521, app/test/helpers/twilioWebhookHarness.ts:3266, dashboard/src/routes/broadcasts/RecipientPreview.tsx:9, dashboard/src/routes/broadcasts/broadcastFormat.ts:78, dashboard/src/routes/broadcasts/BroadcastResults.tsx:52, app/test/broadcastFanOut.test.ts:1538
---

**RESOLVED 2026-09-28 (branch `feat/share-sent-outcome`, share-skip Branch B;
UNMERGED at this writing - the merge closes it).** Spec
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` D1 (ONE
per-recipient state; the composer's "Already sent" flag takes its SAFE
reading - reached, pending a live retry, Not confirmed, in flight - over
EVERY share of the unit, whatever its stored status: the stored status is
never read to decide whether a tenant got the property, I1) and D4 (a
finished share's pill derives from its recipients: an all-unconfirmed share
reads "Not confirmed", danger, and `last_error` shows under "Not sent" only).
The stored status rule (SOR D16a) is unchanged; the fix is in the readers, as
suggested below.

- The recipient state service (T2 `5ea5005f`, `a9ed3ab3`); the flag through
  `priorRecipientKeys`, with the repo's interim rule and its harness mirror
  deleted (T8 `56681acc`); the label table and the Retrying chip (T10
  `ab48caf0`). This issue's M-1 shape is pinned by `app/test/broadcastApi.test.ts`
  ("is set for a Not-confirmed slot even when the share finalized failed") and
  end to end by `e2e/tests/dashboard-next/share-sent-outcome.spec.ts` (d)
  (T14 `329d136a`), which also rewrote `send-outcome-reconcile.spec.ts`'s pill
  (Not confirmed) and alert (none) pins. A one-to-one share started from a
  tenant's file reads the same flag.

**Residuals**, each filed or named: a `queued` slot of a finished share with
no send-attempt record reads stranded (never texted) and is not flagged - for
the length of the pass that includes the unclaimed recipients of a share the
route marked failed while its pass still runs
([share-route-failed-pass-unclaimed-read-stranded](./share-route-failed-pass-unclaimed-read-stranded.md));
a stranded `sending` share keeps its in-flight recipients flagged until
[send-attempt-sweeper](./send-attempt-sweeper.md) closes them; a recipient
known to be Not confirmed only from its attempt row can read "Not sent" on the
list after an SSE patch
([share-list-sse-patch-rebucket-and-refresh](./share-list-sse-patch-rebucket-and-refresh.md));
and history reads right only after the post-deploy repair (RUNBOOK "Share
outcomes repair (2026-09-28)" - deploy, census, apply, and only then the next
property blast). The body below keeps its original anchors.

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
