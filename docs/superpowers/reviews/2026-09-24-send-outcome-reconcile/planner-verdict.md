> **Closeout update, 2026-09-28:** This branch is merged and retired; its worktree and directory are gone. Deployment is operator-confirmed and the hosted-dev checklist is resolved. See the [closeout record](README.md) for preserved evidence and follow-up scope. The original verdict, merge instructions, and gate results below are historical evidence.

# Planner verdict - send-outcome classification and reconcile (Stage 1)

Date: 2026-09-27 19:20 EDT. Planner: Claude Fable 5.1 (the mission's planner
session). Branch `feat/send-outcome-reconcile` at `W:\tmp\send-outcome-reconcile`.
Code final at 52220729; the orchestrator's handback at 91a66577; this verdict
and its records are docs-only commits on top.

## Verdict

**MERGE-READY, with two decisions for Cameron below.** The branch closes
`throw-for-redelivery-defeated-by-job-marker` for both fan-outs and the relay
retry rung: every attempted recipient now reaches a terminal state or a
reconcile chain, nothing throws under the run-once marker, and an ambiguous
send is resolved by looking the message up at Twilio. Every residue the four
review rounds and my own two reviewers found is filed in the registry (526
issues, 0 warnings); none is a new automatic double text.

## Gates - my own run, on a quiet tree, bare, exit codes read straight after

Logs under `.superpowers/planner-gates/` (gitignored).

| Gate | Result |
|---|---|
| `npm run typecheck` | `TYPECHECK_EXIT=0`, 0 `error TS` |
| `npm run smoke` | `SMOKE_EXIT=0` |
| `npx eslint <86 touched files>` | `LINT_EXIT=1` - the SAME 5 errors + 1 warning as at the merge base bd752bd0 (compared message-by-message against the merge-base run): **0 new** |
| `npm test` | `NPMTEST_EXIT=0`: app 383 files, dashboard 204, e2e-unit 21, fake-twilio 34 + 13; 0 `[dynamoAdmin]` lines |
| `timeout 1500 npm run e2e` (run 1) | `E2E_EXIT=124` at 247/289 - two native group-text delivery specs timed out; see below |
| the two files alone, twice | 2 failed / 1 passed both times (2.5 m each) |
| DynamoDB Local restarted, the two files alone | `ISO3_EXIT=0`, 3 passed (32 s) |
| `timeout 1800 npm run e2e` (run 2, quiet) | **`E2E2_EXIT=0`, 289 passed (20.0 m)** |

What run 1 found: `group-text-per-recipient-delivery.spec.ts:63` and
`group-text-reply-all.spec.ts:45` fail when DynamoDB Local is degraded (the
container was at its 2 GiB heap ceiling and 51% CPU after 21 hours and several
hundred per-file test databases). The mechanism is a PRE-EXISTING
read-modify-write race in `updateRecipientDeliveryStatus`
(`app/src/repos/messagesRepo.ts` - the `delivered` receipt whose condition
fails is dropped, not retried), which this branch does not touch; on a fresh
container the race window closes and the specs pass. Filed as
`group-recipient-delivered-receipt-lost-to-sent-race` (med, pre-existing).
Two lessons recorded: restart DynamoDB Local before a gate run that follows
many per-file test databases, and never let reviewers run database-backed
tests while a gate e2e runs (my run 1 raced my own reviewers, the same
mistake the orchestrator's P3d run made).

## Reviews

The orchestrator's own: four rounds (conformance + plan-blind adversarial,
then focused re-reviews), five fix waves, code frozen after round 4 -
`code-review/r1..r4-*.md`.

Mine, on the handed-back branch (`planner-review/`):

- **Conformance** (`conformance.md`): 0 blocking, 0 high, 1 medium, 7 low.
  Every decision D1-D23 and RSW #1/#5/#6/#7 CONFORMS or DEVIATES-DECLARED;
  one undeclared low deviation (the deferral arms release the record
  `done/retryable` when their slot write failed - safe, now declared in the
  spec's errata); D14 not built by design. The medium (P-1): the hosted-dev
  check "does Twilio's Messages list include a still-queued message?" is a
  PRECONDITION for relying on the reconcile in production - if it does not,
  a message stuck in Twilio's queue past the last check is re-sent.
- **Plan-blind adversarial** (`adversarial.md`): 0 blocking, 1 high, 3
  medium, 6 low; none a new automatic double text. Filed by a docs-only
  child (8 new issues, 6 addenda):
  - H-1 (pre-existing) `deploy-mid-share-strands-remaining-recipients`: a
    worker killed mid-share (10 s drain) leaves the rest of the share with no
    attempt record at all; the sweeper must sweep by share, not by record
    (addendum to `send-attempt-sweeper`).
  - M-1 `unconfirmed-share-invites-resend`: a share whose attempted
    recipients all ended "Not confirmed" finalizes `failed` by design, and
    `priorRecipientContactIds` skips `failed` shares, so the next share of the
    property offers those tenants pre-checked. Fix = one condition in
    `broadcastsRepo.ts:716` (include `failed` broadcasts, whose failed slots
    already count under the interim rule) plus the harness mirror and a
    test. DECISION 1 below.
  - M-2 `outage-brake-burns-ladder-rungs`: each braked pass consumes a
    ladder rung; retryable errors never trip the brake; never-tried
    recipients are labeled "gave up after repeated temporary errors".
  - M-3 `relay-redrive-late-unbounded-and-out-of-order`: a re-drive lands
    about 4 min after the original with no age cap (the 30003 ladder caps at
    15 min); an age cap is a product call.
  - Low: the lane delay seam fires on any stack with no `JOBS_QUEUE_URL`
    (`reconcile-delay-seam-fires-on-local-live-stack`); dead/duplicated
    attempt facts incl. the broadcast claim's hardcoded media count 0
    (`send-attempt-facts-dead-and-duplicated`); the provider's error text
    logged twice, unmasked (`provider-error-text-logged-twice-unmasked`);
    the unbounded sibling read; the `redrive_refused` wording; two avoidable
    consistent reads.

Cost per recipient on the happy path (adversarial review): +4 DynamoDB round
trips for a broadcast recipient, +7 for a relay leg.

## Spec: revision 12 (errata as built)

Section 12 of the spec records every place the build departs from the
approved text, each with its adjudication: the claim RE-ARMED right before
the provider call (round 1 ADV-1; Cameron's ruling HIGH at most, site half
minimal - built as 3 source files, +59/-7, fail closed); the reconcile's own
closes record-first; the two-sided lookup window and the stricter match rule
(media count for every body); `never_sent` only on a complete walk; relay
strands wait for the sweeper; the deferral arms' release; the three blind
pre-claim slot writes; no `attemptedAt` on broadcast slots; the hosted-dev
checks as a precondition.

## Decisions for Cameron

1. **M-1 - fix before merge, or file.** Recommendation: FIX NOW. It is one
   condition plus a mirror and a test, in the small-fix lane, and it removes
   a standing invitation to the double text on every later share of the
   property; the cost is one more typecheck + `npm test` + e2e (~40 min).
   Filing it is defensible too: Branch B's attempts rule replaces this query
   and could carry it.
2. **Second main sync.** The branch is 110 commits behind `main` (8f7f8cb5;
   voicemail-greeting and staff-notes-past-tours merged since the one sync at
   a9f411f3). `git merge-tree` reports 0 conflicts; two files changed on both
   sides (`app/test/helpers/twilioWebhookHarness.ts`,
   `dashboard/src/api/types.ts`). The one-sync rule says report drift, not
   chase it; RSW took a second sync on Cameron's ruling. Recommendation:
   SYNC and re-run the five gates (~45 min) before merging, since a trial
   merge cannot see a semantic conflict in two shared files.

## Merge (after the decisions; the human merges)

```
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/send-outcome-reconcile
```

At merge: set `docs/issues/throw-for-redelivery-defeated-by-job-marker.md`
to resolved. No infrastructure, deploy, flag, secret or schema action is
owed. Before relying on the reconcile in production: run
`send-reconcile-hosted-dev-checks` items 1-5 on hosted dev. Next worktree:
Stage 1b (the `retrySend` adoption onto the send-attempt record), then
share-skip Branch B, which consumes the record.

## Run health

One free infra recovery (the platform's session usage limit cut the
orchestrator at 00:09 and it resumed from the ledger at 01:22); 0 of 2
budget recoveries used; no stalls. Every slice, review round and fix wave is
a committed record under this directory.
