> **Closeout update, 2026-09-28:** This branch is merged and retired; its worktree and directory are gone. Deployment is operator-confirmed and the hosted-dev checklist is resolved. See the [closeout record](README.md) for preserved evidence and follow-up scope. The original verdict, merge instructions, and gate results below are historical evidence.

# Handback - send-outcome classification and reconcile (Stage 1)

Build orchestrator: Claude Opus 5.5 (1M context), AUTO mode, 2026-09-26/27.
Spec `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`
(rev 11); plan `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md`
(rev 4). Records for every step live beside this file
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/`).

**MERGE-READY at the head of `feat/send-outcome-reconcile`
(`W:\tmp\send-outcome-reconcile`) - the commit that lands this record (parent
b09c7d8f); the code is final at 52220729 (every later commit is docs only);
110 behind main (8f7f8cb5); UNMERGED (human gate).**

**Post-merge: NO infrastructure, deploy, flag, secret or schema work** (the
attempt record is a new item family in the existing messages table; the new
job name registers like every other; the existing `jobs-dlq-depth` alarm
covers `send.reconcile`). Owed by the human at merge: set
`docs/issues/throw-for-redelivery-defeated-by-job-marker.md` resolved. Next:
Stage 1b (the `retrySend` adoption) in its own worktree; share-skip Branch B
after both. **Owed at the first hosted-dev run** - the checks in
`docs/issues/send-reconcile-hosted-dev-checks.md` (med): the list walk's order
and page bound against real Twilio; **whether the Messages list shows a queued
or accepted message at all, and where rows with a null date_sent sort** (if
unsent messages are unlisted, a message held in Twilio's queue past +240 s is
ruled never_sent and re-driven - a double text); whether the PROD Messaging
Service has Smart Encoding on; link shortening and Advanced Opt-Out.

## 1. Gates on the final code (52220729), quoted

Every gate ran bare from the worktree, output to a file, exit read right after
(`.superpowers/sdd/gates/`, gitignored run state). The code at every gated
commit below is byte-identical to 52220729: `git diff 52220729..b09c7d8f --
. ':(exclude)docs'` is 0 lines, and no test reads anything under `docs/`.

| gate | commit (code 52220729) | result |
|---|---|---|
| `npm run typecheck` | b09c7d8f | `TYPECHECK_EXIT=0`, 0 lines matching `error TS` |
| `npm run smoke` | b09c7d8f | `SMOKE_EXIT=0` - "smoke-dist: OK - 1481 import specifier(s) across 259 emitted file(s) resolve under plain Node." |
| lint gate 5 (86 branch files) | b09c7d8f | `LINT_EXIT=1`, 5 errors + 1 warning, ALL pre-existing by the baseline at the merge base bd752bd0 - **0 new** (below) |
| `npm test` | 1d3bc869 | `NPMTEST_EXIT=0` - app 383 files, 7676 passed / 1 skipped; dashboard 204 files / 3403; e2e-unit 21 / 499; fake-twilio 34 / 268; fake-twilio/web 13 / 111; 0 `[dynamoAdmin]` lines |
| `timeout 1500 npm run e2e`, run 1 | 1d3bc869 | `E2E_EXIT=1` - 287 passed, 2 failed (23.7m) |
| the two failing files ALONE, x2 | 1d3bc869 | `ISO1_EXIT=0` 13 passed (1.3m); `ISO2_EXIT=0` 13 passed (1.3m) |
| `timeout 1500 npm run e2e`, run 2 | 8f945800 | `E2E_EXIT=0` - **289 passed (23.2m)** |

Lint (the final run vs the merge base): `app/src/lib/seed/matrix.ts:134`
`DEADLINE_TYPES` (base :134); `app/test/relayOwner.integration.test.ts:74`
`poolNumbers` (base :74); `app/test/rosterActionsPoll.test.ts:200`
`addActionId` (base :199); `dashboard/src/routes/contact/Timeline.tsx:1580`
set-state-in-effect (base :1577); `e2e/tests/dashboard-next/broadcasts.spec.ts:270`
unused `request` (base :291); warning `app/test/messaging.test.ts:635` unused
eslint-disable (base :582).

**Both e2e runs, reported:** run 1's failures were
`dashboard-next/outbound-mms.spec.ts:517` (the viewer's discrete-wheel zoom
stuck at scale 7, `toBe(8)` at :729) and
`scenarios/landlord-onboarding.spec.ts:98` (the New-property dialog showed
"Couldn't create the property", then `waitForURL` timed out at
`scenarios/steps.ts:1630`). Neither file nor its code path is touched by the
branch; both passed alone twice and in the full re-run; run 1 overlapped known
contention (a read-only reviewer's single-file vitest runs on the shared
DynamoDB Local container, and an issue-filing child). The named-flake list is
empty, so they were not excused: recorded as a sighting in the open
`e2e-scenario-specs-rotate-failures-full-suite` and a new low issue
`e2e-outbound-mms-viewer-wheel-scale-full-suite`. The landlord create's
server-side cause was NOT established (its request's completion line was not
found in the run's log).

Earlier full batteries on intermediate code, all green: 83308e15 (pre-review;
e2e 289, 21.1m), a908f9cb (FW2; e2e 289, 20.1m), 80fe74c1 (FW4; e2e 289,
24.5m).

## 2. Work map

| task | what | status | commits |
|---|---|---|---|
| T1 | send-failure classifier (D1/D2), 20429 throttle | shipped (+FW1-7) | 5008d9ee, 04250da0 |
| T2 | body fingerprint, recipient digest, hashed keys | shipped (+FW1-3) | 94831e84, 782c9796 |
| T4 | `listMessages` / `getMessage`; Twilio timeout = claim TTL | shipped, deviation 1 | d47e3487 |
| T5 | send-attempt record + index, fenced transitions; guardWrite | shipped (+FW1-1 rearm, FW1-5 op token) | 826a74a2, a206a7ce, 349bfef1, 0dd5d4b7 |
| T6 | messages/broadcasts repo closes, adoptions, consistent twins, `unconfirmed` bucket | shipped (+FW1-5 finalize token) | 4497c602, d7b1f6f2, 0b303ad4, 0a7e3950 |
| T3 | typed `sendMessage` errors (D3) | shipped (+FW2-1 hook, FW2-10 pin) | 411b681c, e3b13f6d, af848977 |
| T7 | broadcast fan-out units, claim, brake, re-drive, cap-close | shipped (+FW2) | 7fc1fa5b, f40f585f, a95fbd98, 6cf9bc1e |
| T8 | relay fan-out legs | shipped (+FW2) | 30b6e636, 829d49a7 |
| T9 | relay retry rung | shipped (+FW2) | 6bbe77a8, d594b743 |
| T10 | `send.reconcile` job (all owners) | shipped (+FW1, FW4, FW5) | 346f0b74, be53cc0e, 942f5e5f, f01b5c5a, 9db8fa22, 6ab1370b |
| T13 | dashboard: Not confirmed by code, D20a clock | shipped (+FW2-9) | 8defb6c8, 1f108103 |
| T14 | dashboard: bucket, chip, unconfirmed row | shipped | 216f2fd6, b78186e6 |
| T11 | fake-twilio list/fetch + seams | shipped | 7e021cae, 6766e2a3 |
| T12 | lane seam + four e2e specs | shipped | b8d46e67, 430ff8a7 |
| T15 | issue registry | shipped (+FW3) | 61ea0f7f, af35947a |
| T16 | live self-QA | shipped, 4/4 PASS | b09c7d8f (`self-qa.md`) |
| T17 | drift, gates, handback | this record | - |

Fix waves: FW1 0dd5d4b7..518053ee; FW2 3393d6d9..af848977; FW4
610e46ba..4eef5efa; FW5 4e7a8154, 52220729; FW3 (registry) af35947a. Nothing
in the work map was skipped. The mission's binding watch items held: the
fenced files (`routes/webhooks/twilio.ts`, `jobs/jobs.ts`,
`adapters/sqsJobConsumer.ts`, `jobs/retrySend.ts`, the run-once marker) have
0 diff lines; `send.reconcile` registers without the marker; `world.sent`
keeps its shape; broadcast slots carry no attemptedAt.

## 3. Per-decision conformance (spec rev 11)

Round 1's table (`code-review/r1-conformance.md` section A) with each PARTIAL's
final state:

| item | final | how |
|---|---|---|
| D1 | CONFORMS | was PARTIAL (C-5): a standalone 20429 is retryable, after the 5xx rule - FW1-7 04250da0 |
| D2, D3, D3a, D4, D5, D6, D7 | CONFORMS | as round 1 |
| D7a | CONFORMS | was PARTIAL (C-2, C-3): a failure arm closes the record only once its slot write resolved (FW2-2 b339ee0d); a fence write that throws reaches the prepare catch (FW2-3 f890d711). Residue N-1 (section 7) |
| D8 | CONFORMS for the redriven case | was PARTIAL (C-4): closeRedriven first, slot only if won (FW2-4 c44216cd). The non-atomic gate-then-close window stays a filed residue (`send-attempt-gate-then-close-window`) |
| D8a | CONFORMS | + the re-arm before the provider call (FW1-1 0dd5d4b7, FW2-1 e3b13f6d) - declared deviation R2C-4a below |
| D9, D10, D12, D14, D15, D16, D17, D18, D19, D21, D22, D23 | CONFORMS | as round 1 (D17 with deviation 1; D14 recorded, not built) |
| D11 | CONFORMS, residue | was PARTIAL (C-8): a phone-keyed share recipient is looked up by its own number (FW1-9 6763d51b); the GSI contact reads in heldBy / adoption and D-3 are filed |
| D13 | CONFORMS | was PARTIAL (C-1, F-2): two-sided window and sibling span (FW1-2 782c9796), hash AND media count for every body (FW1-3); never_sent only on a complete walk (FW4-1 610e46ba); a list error mid-walk judges what was read (FW5-1 4e7a8154) |
| D13a, D16a, D20a | CONFORMS | D16a's "C-2/C-3 can block it forever" closed by FW2-2/FW2-3, save N-1 (a double fault) |
| D20 | CONFORMS | was PARTIAL (C-6): the mixed relay chip joins the D20 sentence after the failed legs' reasons (FW2-9 1f108103) |
| RSW #1, #5, #6, #7 | CONFORMS | as round 1 |

Round 2's conformance reviewer re-walked D1-D23 against the fixed code: nothing
BLOCKING or HIGH; FW1-6 PARTIAL (fixed in FW4); every other fix REAL.

## 4. Declared deviations from the spec's wording

The plan's four: (1) D17's `createdAfter` is not a port argument - the job
filters by createdAt; (2) the dashboard's code constants live in
`deliveryStatus.ts`, pinned to the app's by a mirror test; (3) a send site's
post-claim slot write keeps only the slot's own guards, is written before the
fenced `finishAttempt`, and a lost fence is WARN with no rollback; (4) the
continuation payloads keep their `phone#` shapes; the new reconcile owner field
is phone-free.

Added by the build and the reviews (each adjudicated in its record):

- **ADV-2 / FW1-4**: the reconcile job's own closes write the RECORD first and
  the slot only when that close won (spec D8 says "slot FIRST"); crash safety
  moves to a superseded-exit re-apply of the slot close (ruling A7 extended).
- **S3a / F-2**: the match rule is stricter than written - body hash AND media
  count for every body (safe direction: fewer adoptions, more unresolved).
- **R2C-4**: (a) the re-arm moves the record's attemptedAt after the claim, so
  the relay slot's D20a clock (the claim instant) and the record's differ; (b)
  the lookup window is two-sided [attemptedAt - 60 s, attemptedAt + 90 s]
  instead of D13's "to now"; (c) broadcast's best-effort follow-ups run before
  the record's done/sent (FW2-6); (d) on relay a stranded rejection or refusal
  (a double fault) counts toward the D9 brake, although D9 says a rejection
  resets it.
- **FW4-1 rule (c)** is D13's own bound rule ("a walk that exhausts the bound
  is unresolved", design.md:589; D16 "page bound exceeded"): a recipient with
  more than 5000 messages from one sender and nothing adoptable closes Not
  confirmed and is not re-sent. (Only the unmerged interim af848977 did
  otherwise - the F-1 hazard.)
- Build rulings A1-A11 (`build-research/worklist.md`), T10-14, T4-1 and the
  per-key catches in the close loops (C-9) - each recorded where made.
- Spec text drift (D-2, notes only): Sec 8 item 6, Sec 2's broadcast
  `attemptedAt`, D7a "as today", and D8a rev 11's "the broadcast ladder clears
  it" (true only for a pass-1 strand - N-1). The approved spec was not edited.

## 5. Reviews, fix waves and the human's ruling

| round | reviewers | outcome | records |
|---|---|---|---|
| R1 @83308e15 | spec-conformance; plan-blind adversarial | 23/29 CONFORM, 6 PARTIAL; C-1 BLOCKING; ADV-1 CRITICAL (confirmed double send), ADV-2 HIGH, ADV-3/ADV-4 MEDIUM, the rest LOW | `r1-conformance.md`, `r1-adversarial.md`, `r1-adjudications.md` |
| FW1, FW2 | implementers | 19 FIX items; 63/63 and 56/56 mutants killed | `fw1-report.md`, `fw2-report.md` |
| R2 @af848977 | fresh conformance + fresh plan-blind adversarial | nothing BLOCKING/HIGH; F-1 (= R2C-1) early stop could rule never_sent (a double text) - fixed; the rest filed | `r2-*.md` |
| FW4 | implementer | never_sent only on a complete walk; comment/log truth; 17/17 mutants | `fw4-report.md` |
| R3 @4eef5efa | fresh focused | NEW-1 (a list error mid-walk discarded a read orphan), D-2 (log text) - both LOW, fixed | `r3-*.md` |
| FW5 | implementer | 11/11 non-equivalent mutants | `fw5-report.md` |
| R4 @52220729 | fresh focused | FW5 REAL; the final verdict table sound; one LOW logging residue; **no further wave - code final** | `r4-*.md` |

**Cameron's ruling on ADV-1 (2026-09-27 ~11:45, via the planner):** "a double
text is annoying, NOT critical" - ADV-1 reclassified HIGH; the repo `rearm()`
kept; the site half MINIMAL or stop-and-file. **It stayed within the ruling:**
e3b13f6d, source 3 files +59/-7 (broadcastFanOut.ts +23/-2, relayFanOut.ts
+23/-5, sendMessage.ts +13/-0; 25 non-comment code lines; no code line
removed), tests 4 files +398/-8; one re-arm per site immediately before the
provider call, failing closed (undefined: no send, the existing takeover
outcome; a throw: the existing prepare deferral). No DynamoDB client timeout
change, no new states or retries. Round 2 (A-1) showed the re-arm NARROWS the
window rather than closing it - the withdrawn claim is corrected in
`r1-adjudications.md` section 7 and the residue is filed.

## 6. Self-QA (T16) - `self-qa.md`

Fresh lane 8, `appCommit 8f945800` (= code 52220729), lean seed, the Playwright
plugin MCP. All four PASS: (1) relay `accept_then_drop` - adopted at check 0,
"Delivered" live without a reload, ONE copy at the fake; (2) share
`drop_before_create` - never_sent at check 2, one re-drive, "Sent", Delivered 1,
Not confirmed 0, ONE copy; (3) `drop_before_create` + `fail-list` x3 - ONE ERROR
(`unresolved`, `provider_unreachable`), "Failed" with the prose alert, Not
confirmed 1, no retry hint, ZERO copies; (4) a relay leg stranded queued with
attemptedAt 16 minutes old reads "Queued - not confirmed" at once, and the
control (no attemptedAt) stays silent ("Sending..."). Measured at 375 px: the
new row inherits a PRE-EXISTING badge overflow that hides the recipient's name
(a Failed/30007 control row is worse) - filed
`share-results-recipient-row-overflows-at-phone-width` (med), not fixed.

## 7. Residues and the registry - for your eye first

The goal "nobody is ever texted twice" holds except in these filed, rare
windows, each held by your ruling (a double text is annoying, not critical):

- **A-1** (`send-attempt-rearm-residues`): the re-arm's own two DynamoDB calls
  have no request timeout; a stall of about 90 s inside them plus a concurrent
  taker (an SQS redelivery) can still send twice. Designed fixes are recorded.
- **Window TRAIL** (same issue): a provider request that trickles past +90 s
  puts its orphan outside the window - never_sent and a re-send.
- **R2C-2** (`send-reconcile-hosted-dev-checks`): if Twilio does not list
  queued messages, a message queued past +240 s is re-driven.
- **A pass-1 broadcast rejection whose slot write threw** is re-driven once
  (a second provider call for a rejected send) - `send-attempt-sweeper`.
- **FW3 filer's reading, unverified** (`send-reconcile-job-residues` item 10):
  a crash between append and slot write plus the number moving to another
  contact inside the window could rule never_sent.

Not a double text, but visible to staff:

- **N-1**: a double fault (a DynamoDB write throwing on a broadcast failure arm
  or hand-off) in pass 2/3 or a re-drive pass leaves the share "Sending" until
  the Stage 2 sweeper - `send-attempt-sweeper` (no sweeper exists yet).
- **Rule (c)**: over 5000 messages from one sender, a genuinely lost send
  closes "Not confirmed" (never re-sent) - the spec's bound rule.
- **The phone-width row overflow** above (pre-existing).

New issues from this branch: `relay-fanout-closes-emit-nothing`,
`send-reconcile-job-residues`, `send-outcome-dashboard-residues` (S6);
`send-attempt-gate-then-close-window`, `broadcast-route-markfailed-blocks-finalize`,
`send-attempt-recipient-hash-unkeyed`, `send-attempt-rearm-residues`,
`send-reconcile-hosted-dev-checks` (FW3);
`share-results-recipient-row-overflows-at-phone-width`,
`e2e-outbound-mms-viewer-wheel-scale-full-suite` (T16/T17). Dated addenda in
`send-attempt-sweeper`, `fanout-close-path-robustness-residues`,
`relay-fanout-closes-emit-nothing`, `throw-for-redelivery-defeated-by-job-marker`
(status left open for you), `e2e-scenario-specs-rotate-failures-full-suite`
and the ten S6 edits. `npm run issues`: 518 total, 0 warnings. No code
`TODO(...)` markers were added.

## 8. Notes and sub-threshold worries

- C-9 (undeclared build deviations, now declared above), C-10 (filed), D-1 (no
  batch read exists), D-4 (the hosted-dev check covers link shortening and
  Advanced Opt-Out), D-6 (the Sec 10 checks) - round 1's notes.
- S5b lane timing (accepted): on the lane the 2 s first check beats the fake's
  2.5 s unknown-SID re-lookup, so early callbacks become regress-skipped no-ops;
  production's 5 s first check does not race that way.
- AGENTS.md's claim that a failing spec "preserves BROWSER-side artifacts only"
  looks stale: the gate's own stdout (redirected to a file) carries the app's
  JSON lines under a `[WebServer]` prefix; worth re-checking before relying on
  either reading.
- The project Playwright MCP's chrome-for-testing binary is not installed on
  this machine (`npx @playwright/mcp install-browser chrome-for-testing`); the
  plugin MCP worked but may only write inside the MAIN checkout's
  `.playwright-mcp\` - this run's artifacts were moved out to the worktree's
  ignored folder afterwards.
- FW3's filer flagged, unedited (docs-only wave): `app/src/lib/guardWrite.ts:4-6`
  still says a lost write is "left to the stale-claim takeover" - the same
  overclaim N-1 corrected elsewhere.
- Round 4's unpinned order (FW5 deviation 2) and the logging residue F-1 are
  filed (`send-reconcile-job-residues` items 13-14).

## 9. Files, commits, delta

100 feature commits with this record (`git log --oneline --no-merges
main..HEAD`): 55 carry code (the list is in section 2 and the fix-wave
records), 45 are records and registry. Against the merge base bd752bd0,
outside `docs/`: 88 files, +19710 / -896 - app/src 19 files +5688/-748,
app/test 39 files +11511/-26, dashboard/src 16 files +952/-69, fake-twilio 8
files +871/-28, e2e 5 files +673/-24, scripts 1 file +15/-1; everything else
is records and registry under `docs/`. App source touched: `adapters/messaging.ts`, `adapters/messagingErrors.ts`
(new), `adapters/twilioHttpClient.ts`, `jobs/broadcastFanOut.ts`,
`jobs/registerHandlers.ts`, `jobs/relayFanOut.ts`, `jobs/relayRetryLeg.ts`,
`jobs/sendReconcile.ts` (new), `lib/guardWrite.ts` (new), `lib/seed/matrix.ts`,
`lib/seed/performance.ts`, `lib/sendAttemptGate.ts` (new),
`lib/sendFingerprint.ts` (new), `lib/sendOutcome.ts` (new), `lib/tables.ts`,
`repos/broadcastsRepo.ts`, `repos/messagesRepo.ts`,
`repos/sendAttemptsRepo.ts` (new), `services/sendMessage.ts`.

## 10. Drift

110 commits behind main (8f7f8cb5): voicemail-greeting and
staff-notes-past-tours merged, plus docs. Not re-merged (the branch's one sync
was a9f411f3). `git merge-tree --write-tree HEAD main` exits 0 - no textual
conflict; two files changed on both sides: `app/test/helpers/twilioWebhookHarness.ts`
and `dashboard/src/api/types.ts`. The gates above ran on the branch as it
stands, not on a merged tree.

## 11. Run health

One INFRA-tier recovery (free): the platform's session usage limit cut the
orchestrator's turn 00:09-01:22 EDT; resumed from the ledger. Budget-consuming
recoveries: 0 of 2. No cold-dispatch misfires. The harness refuses report files
from subagents, so every child returned text and the orchestrator landed each
record as a committed file before marking its step done (the planner's
instruction). No process of this run is left alive; lane 8's ports are free.
