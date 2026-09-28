# Handback - retry-send adoption (send-outcome Stage 1b)

Build orchestrator (AUTO, subagent of the planner), 2026-09-28 00:01-06:40 EDT.
Branch `feat/retry-send-adoption`, worktree `W:\tmp\retry-send-adoption`, cut
from `main@3dbb5740`. Spec revision 5 (approved as is); plan revision 4.
Records: `docs/superpowers/reviews/2026-09-27-retry-send-adoption/`
(`build-research/`, `build/S1..S5-report.md`, `code-review/`, `self-qa.md`,
this file).

**MERGE-READY (gated @a67376d3; the only later commit is this docs-only handback record) on `feat/retry-send-adoption` (`W:\tmp\retry-send-adoption`),
0 behind `main` (main still `3dbb5740`; no sync was needed), UNMERGED (human
gate).** Code final at `1b5ddb01` (last code commit `bb1bbaaa`); every commit
after it is docs only (review records, issue notes, self-QA, this handback).

**Post-merge: NO infra** (no terraform, no secrets, no flags, no schema, no
new dependency). Owed at merge: the human sets `retry-send-lost-under-job-marker`
resolved. Share-skip Branch B starts after this merges and reads spec R10.
SOR's hosted-dev checks (`send-reconcile-hosted-dev-checks` items 1-5) now
cover the `retry_send` owner too and remain a PRECONDITION for relying on any
reconcile in production (spec section 6). Deploy and rollback notes: section 7.

## 1. Work map - per item

| slice | task | status | commits |
|---|---|---|---|
| S1 | T1 repo additions + helpers (retry_root / retry_outcome, the `retrychild#` family + `listRetryChildrenConsistent`, the conditional `annotateRetryPromise`, fakes + parity, `sendMessage` retryRoot, leaf constants, `retryChain.ts`, `retryPromiseWrites.ts`, `planRetryMedia`, payload `deferred`) | SHIPPED, no behavior change | `5880d09c`, `c706e6ff`, `baf315cf` |
| S2 | T2 the `retry_send` owner kind everywhere + the reconcile's fourth owner (11 exhaustive switches, `adoptRetry`, the WITHDRAW in `closeSlot`, the windowed re-drive with REFRESH, `isBroadcastRowFor`'s guard); T3 the lineage exclusion | SHIPPED | `1dc83cf9`, `be8ea0aa`, `c506bd1c` |
| S3 | T4 `messaging.retrySend` on the record (marker WRITE out; `gateFor`; the planner's read-only belt; `retrychild#` supersession; the window; claim -> presign -> send with re-arm -> finish; the arms; deferred once; unknown -> reconcile with the promise refreshed); the 18 registration sites; `retrySendAttempt.test.ts` (test 1 red on main - proven) | SHIPPED | `4bf6e32a` |
| S4 | T5 the manual Retry route (`superseded` / `retry_unresolved` / record `retry_pending`; retryRoot + broadcastId on its append; `ApiRouterDeps.sendAttemptsRepo`; the harness api block); T6 projection + dashboard ("retry not confirmed", hidden Retry, two 409 sentences, the mirror); T7 the ONE `twilio.ts` line | SHIPPED (twilio.ts 1+/1-) | `6ae0bfba`, `d574bd86`, `a7865cfe` |
| S5 | T8 the e2e spec (items 17-19) + `selectors.md`; T9 issue notes, live self-QA, drift, gates, handback | SHIPPED | `597faa72` (spec); `c998412b` (issues); `a67376d3` (self-QA) |
| FW1 | code review round 1 fix wave (C-1, C-2 reconcile half, C-3, C-4, C-5, C-10/A-7, A-1 comment, A-6 key test) | SHIPPED | `5a87b380`, `29e6ef36`, `1b993f00`, `dfff2ba4`, `23abb562`, `bb1bbaaa` |

Net vs `3dbb5740`: code (docs excluded) 41 files, +6838 / -391; with the
branch's docs, 81 files, +17339 / -397 (the docs include the spec and plan
revisions and every review record).

## 2. Gates on the FINAL commit `a67376d3` (bare, bash, from the worktree, quiet tree, DynamoDB Local restarted first)

| gate | exit | result |
|---|---|---|
| `npm run typecheck` | 0 | all five workspaces |
| `npm test` | 0 | app 7929 passed / 1 skipped (392 files); dashboard 3520 (209); e2e-ws 499 (21); fake-twilio 275 (34); fake-twilio-web 111 (13); 0 `[dynamoAdmin]` lines |
| `npm run smoke` | 0 | 1511 import specifiers across 264 emitted files resolve under plain Node |
| `timeout 1800 npm run e2e` | 0 | **300 passed (20.9 m)** - main's 297 + this branch's 3; lane 12, torn down, ports free |
| `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 1 | 40 files; ONE error, PRE-EXISTING: `dashboard/src/routes/contact/Timeline.tsx:1595` react-hooks/set-state-in-effect `setNow(fresh)` - the same error at the merge base (`:1580`, proven by linting the merge-base blob via `--stdin`); 15 added lines shift it. 0 NEW errors. |

Earlier full battery at `6c82058c` (before the review): typecheck 0, npm test
0 (app 7920/1 skipped), smoke 0, e2e 0 = 300 passed (21.0 m), lint 0 new.
Per-slice app-vitest checkpoints: S1 7834, S2 7869, S3 7903 (all EXIT 0); S4
7919 + ONE failure = the KNOWN filed flake `tour-reminders-earlier-tie-break-test-ms-race`
(two `Date.now()` reads straddling a millisecond under load; this branch does
not touch the file); it passed ALONE twice (69/69, 69/69) and did not recur in
either full `npm test`; the sighting is appended to the issue (`3b32fb95`).

## 3. Per-decision conformance (full table: `code-review/r1-conformance.md`, 144 rows)

Round 1 (at `6c82058c`): 119 CONFORMS / 6 PARTIAL / 0 MISSING / 12 DEVIATES
(10 declared + 2 undeclared, now declared below) / 7 PENDING (Task 9, since
done); 31 mutation runs, 28 red as expected, 3 diagnostic greens. The six
PARTIAL rows traced to C-1, C-2, C-3; FW1 closed all three (round 2 confirmed
C-1 and C-2's reconcile half real by cold review). The one row still PARTIAL
is S0-3 (Q1) through C-2's JOB half, FILED (section 5).

- Section 0 (two names; root rule incl. the pre-deploy walk; Q1; Q2; Branch
  B's `broadcast_id` + `retry_root` on all three appends; the wontfix kept):
  CONFORMS (S0-3 as above).
- R1-R12: CONFORMS except the declared deviations below. R4: every
  owner-kind switch in `sendReconcile.ts` ends in `unhandledOwner(never)`
  (11 sites) - a new kind is a compile error.
- Inherited SOR D8 / D8a / D13 / D15 / D16: honored (the claim + re-arm;
  record-first closes; the lookup with the lineage exclusion; the status
  mapping; `afterClose` = the retried row's emit).

**Deviations (the handback restates them):**
1. R6 reads ONE attempt record per pressed row (`(retry_attempt ?? 0) + 1`).
2. The ADAPTER's kill switch (`sms_sending_disabled`, classified rejected) takes the REFUSED arm (WARN, `done/refused`).
3. The retried row is read consistently (`getByProviderSidConsistent`).
4. The fenced line is re-worded in ASCII as well as re-leveled (`twilio.ts:3904`).
5. The WITHDRAW map lives in `closeSlot`'s `retry_send` arm (keyed on the code).
6. `guardWrite` answers "resolved", not "fence won": every fenced write captures and logs its own fence answer.
7. **`isBroadcastRowFor` ignores rows with `retry_of`** (`broadcastFanOut.ts:1303`): a share-RETRY row that now carries `broadcast_id` is never the share recipient's own row (at both callers - the broadcast adoption's dedupe and the reconcile's `heldBy`). A CODE change in a file the spec's "In" list does not name. The rollup in `twilio.ts` does not use it (it matches slots by conversationId + tsMsgId, so a retry row always misses - R7's stated cost).
8. R6's "stale" = older than `RETRY_SEND_WINDOW_MS` for every open state (spec item 15's 31 s case answers 409 by R6).
9. The adoption reads `mediaCount` from the record (the job's plan) rather than re-planning.
10. **(the planner's ruling on worklist 24)** A READ-ONLY run-once-marker belt for pre-deploy redeliveries: only when the gate finds NO record, the job reads `getJobExecutionMarker(jobId)` and declines (INFO) a jobId the pre-adoption code already ran (`retrySend.ts:436-454`); the job never writes a marker (test 6d). A dated `TODO(retry-send-lost-under-job-marker)` marks it for removal after the first production deploy + one SQS redelivery window.
11. A third designed step-1 decline: a payload whose `conversationId` differs from the retried row's is refused at WARN with no record (`retrySend.ts:358-366`) - unreachable from the webhook, a deferral or a re-drive; it keeps the owner addressable (round 1 C-6).
Plus two wording notes: C-7 - a PHONE-keyed attempt whose thread number changed follows R1 (unaddressable, left for the sweeper), not R4's digest bullet (R4's rule applies to a resolvable contact-keyed owner; round 2 adds the case is unreachable - a one-to-one thread's `participant_phone` is only rewritten for relay threads); C-8 - spec item 13's `attempt === retry_attempt` clause is proven jointly with the walk's stop at a manual row (defense in depth).

## 4. Reviews, rulings, fix wave

- Build research (Phase 1): the planner's three readers had mapped this exact
  tree; two delta readers (compile/anchor drift; whole-app invariant sweep)
  found three would-be-red items (a typecheck step order, an unused binding at
  gate 5, an untyped stub) and five traps; worklist `build-research/worklist.md`
  (27 items) bound the implementers.
- Round 1 (`code-review/r1-*.md`): conformance (above) + a PLAN-BLIND
  adversarial reviewer (no BLOCKING / HIGH; five probes red on HEAD).
  Adjudications `r1-adjudications.md`. FW1 fixed C-1 (a re-driven record's
  pre-claim decline close now throws instead of stranding), C-2 reconcile half
  (a failed/lost WITHDRAW fails the check so its redelivery re-applies it),
  C-3 (gate-defer test), C-4/C-5 (log text), C-10/A-7 (belt TODO), A-1
  (comment), A-6 (a cross-component test: the route reads the KEY the real job
  writes). Every behavior fix was red with the fix reverted
  (`code-review/fw1-report.md`).
- REJECTED code changes (against the approved spec and Cameron's rulings;
  recorded instead): A-1 (expire the promise early on no-send closes -
  Cameron's wontfix, spec section 0/section 7), A-2 (the route takes a
  conditional write before sending - the spec's named residual; a product
  call), A-3 (skip the rollup for retry rows - the `twilio.ts` fence).
- Round 2 (`code-review/r2-review.md`, a FRESH reviewer): FW1 real; no
  BLOCKING / HIGH / MED; seven LOW/NOTE. The loop CONVERGED - no second fix
  wave. Two contests UPHELD: R2-5 (the wontfix issue stays untouched - the
  longer tails went to `send-reconcile-job-residues`), R2-7 (round 1's premise
  was wrong: a one-line call-site alternative exists - see "your eye").

## 5. Issues filed / noted (`c998412b`)

Dated notes: `retry-send-lost-under-job-marker` (built; the deploy + rollback
notes; the belt and its removal), `accepted-send-lost-when-append-fails`
(piece 2 built for this caller), `manual-retry-double-send-residual-windows`
(gaps mapped; what remains: the in-flight overlap A-2 + R2-6, manual vs
manual, with A-2's suggested fix and its trade-off), `broadcast-30003-retry-never-updates-slot`
(attribution landed; matching is Branch B's; the rollup cost; deviation 7; the
A-3/R2-7 alternative; pre-deploy retry rows carry no `broadcast_id`),
`send-attempt-sweeper` (the `retry_send` key shape and its strand cases incl.
A-4, C-2's job half, C-7, the 30-day TTL residue, the `retrychild#` family;
FW1's relay twin - the same swallowed pre-claim close in SOR's relay rung and
fan-out, where the C-1 shape does not apply because those jobs still claim the
run-once marker first), `send-reconcile-job-residues` (inherited residues; the
lineage reads; pre-deploy children; the mixed fleet; R2-5's longer promise
tails), `send-reconcile-hosted-dev-checks` (this owner rides the same lookup;
item 1 is a precondition). NEW: `retry-promise-write-replay-skips-rerender`
(low; R2-1 + R2-4). A second sighting on `tour-reminders-earlier-tie-break-test-ms-race`
(`3b32fb95`). `one-to-one-retry-promise-outlives-job-decline`: untouched
(wontfix respected).

## 6. Live self-QA (`self-qa.md`; screenshots `W:\tmp\retry-send-adoption\.playwright-mcp\qa-rsa-*.png`)

Fresh lane 12, app `c998412b`: item 19 live (the WITHDRAW at the check-2
ERROR; the chip exactly `Undelivered - Phone unreachable - retry not confirmed
(error 30003)`; zero Retry buttons; the press 409 `retry_unresolved`; scoped
log lines WARN/WARN/ERROR with the phone and body in no line; ONE text; no
horizontal overflow at 360 px, measured on the chip and eight ancestors); an
OPEN page re-rendered over SSE from "will retry" to "retry not confirmed"
~0.5 s after the WITHDRAW with no reload and never offered Retry; item 17
(adopted at check 0, the promise refreshed to attempt + 128 s, TWO texts, one
Delivered bubble); the route's guard order live (409 `retry_pending` while the
refreshed promise lived, then `superseded` after it expired). The project
Playwright MCP could not start (its `@latest` wants `chromium-1246`, not
installed; installing is a download the human approves) - the plugin MCP
(Chrome channel) drove it.

## 7. Deploy and rollback notes (no infra; operational)

- DEPLOY: the read-only belt declines, for about ten minutes after the deploy,
  redeliveries of `retrySend` envelopes the pre-adoption code already ran; as
  belt-and-braces, deploy when the worker log shows no `retrySend` failure in
  the preceding ~10 minutes. During a mixed fleet, retry rows appended by old
  instances carry no `retrychild#` pointer and no `broadcast_id` /
  `retry_root`.
- ROLLBACK: pre-branch code cannot read a `retry_send` owner - queued
  `send.reconcile` checks for it dead-letter (pages `jobs-dlq-depth`) and a
  reconcile of another owner to the same recipient can fail for ~5 minutes;
  drain `send.reconcile` before rolling back.
- After C-1 / C-2 a PERSISTENT DynamoDB fault on those two paths now fails the
  delivery and dead-letters after five receives (and pages `jobs-dlq-depth`)
  instead of one swallowed ERROR - by design.

## 8. For Cameron's eye (not blocking)

1. **The rollup line (A-3 / R2-7).** As ruled, the give-up line is INFO - which
   also silences a GENUINE slot miss on a share's OWN row (its only signal). A
   one-line alternative exists at the call site (`twilio.ts:3529`: guard the
   rollup on `message.retry_of === undefined`, and put the give-up line back to
   WARN): no 2.5 s sleep and two broadcast reads per share-retry receipt, and
   genuine misses stay loud. It is a different line from the one you approved,
   so the build kept yours; Branch B would remove the guard when it routes
   retry receipts.
2. **Longer promise tails (A-1).** This branch's REFRESHES (the unknown
   hand-off; the re-drive) mean that after a no-send close (a window-refused
   re-drive, a re-drive enqueue failure, a re-driven run refused/rejected) the
   bubble keeps "will retry", Retry stays hidden and a press gets 409
   `retry_pending` for up to ~4-5 minutes - the accepted wontfix class, longer
   than RSW's ~3 minutes. Recorded in `send-reconcile-job-residues`.
3. **The in-flight overlap (A-2 / R2-6)** stays open by design: a manual press
   whose send is in flight (or ends unknown) while a late automatic retry
   claims - two texts. A route-side conditional write on the record would close
   it, at the cost that a refused press also ends the automatic attempt.
4. **R2-1** (filed): a replayed promise write can skip its SSE re-render
   (stale open bubble until the next refetch; server and route correct).
5. **The belt** is permanent code for a ten-minute window; its removal is a
   dated TODO.
6. The project's Playwright MCP needs `npx @playwright/mcp install-browser
   chrome-for-testing` (a download) before agents can use it again.

## 9. Known flakes and open questions

Known flake seen: `tour-reminders-earlier-tie-break-test-ms-race` (filed,
low) - once in an S4 checkpoint, green alone 2/2, absent from both full
`npm test` runs. Open questions: none. Failure budget: 0 of 2 used; infra
recoveries 0 (no misfire, no death, no wake failure).
