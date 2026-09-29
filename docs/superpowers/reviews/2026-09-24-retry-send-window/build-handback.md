> **Closeout update, 2026-09-28:** This branch is merged and retired; its worktree and directory are gone. Cameron's later answers are recorded in the planner verdict and summarized in the [closeout record](README.md). The original handback below retains its earlier status, questions, and gate results as historical evidence.

# Build handback - feat/retry-send-window

Worktree `W:\tmp\retry-send-window`, branch `feat/retry-send-window`. Every final
gate ran on the code commit `168585b2`; the only later commits are records
(`d6b7bfa4` self-QA, then this handback) - `git diff --name-only 168585b2..HEAD`
lists only files under this folder. Written 2026-09-26. Spec:
`docs/superpowers/specs/2026-09-24-retry-send-window-design.md` (draft 7.3). Plan:
`docs/superpowers/plans/2026-09-25-retry-send-window.md` (v3). Records: this folder.

## Verdict

MERGE-READY @ the handback commit (code @`168585b2`) on `feat/retry-send-window`
(`W:\tmp\retry-send-window`), 0 behind `main` (@`da04d0cb`), UNMERGED (human
gate). Gates 1-4 exited 0; gate 5's only error is PRE-EXISTING by baseline.
NO infra / deploy / secrets / flags / migration / dependency change and no
post-merge op is owed - one deploy NOTE (below): reload open dashboard tabs.

## Main sync (Cameron's ruling: again only if main moved since f49a2fe9)

- `git rev-list --count HEAD..main` at Step 7: 0.
- main had not moved; no second merge.
- Drift at handback (`git rev-list --count HEAD..main` again): 0. Reported, not
  chased.

## Gates (bare, worktree root; exit codes as the tool reported them)

| # | command | exit | evidence (.superpowers/gates/) |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | final-typecheck.log: no `error TS` |
| 2 | `npm test` | 0 | final-npm-test.log: app `375 passed (375)` files, `7180 passed \| 1 skipped (7181)` tests; dashboard `195 passed (195)`, `3228 passed`; e2e unit `21 passed`, `499 passed`; fake-twilio `34 passed`, `245 passed`; fake-twilio-web `13 passed`, `111 passed`. `[dynamoAdmin]` lines: 0. The 1 skip is `staticSmoke.test.ts`'s pre-existing built-dashboard diagnostic (PASS or SKIP), not this branch's |
| 3 | `npm run smoke` | 0 | final-smoke.log: "smoke-dist: OK - 1430 import specifier(s) across 252 emitted file(s) resolve under plain Node." |
| 4 | `timeout 1500 npm run e2e` | 0 | final-e2e.log: "279 passed (19.2m)"; one-to-one-30003-retry (#113, 13.8s), relay-30003-retry (#146, 18.7s) and share-skip-fix (#165, #166, #167) passed; `[dynamoAdmin]`: 0; lane 6 ports free afterwards |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` (53 files) | 1 | final-eslint.log: ONE error, `dashboard/src/routes/contact/Timeline.tsx:1577:7` `react-hooks/set-state-in-effect` on `setNow(fresh);` - PRE-EXISTING: the same rule on the same statement at `:1495` on main @`da04d0cb` (linted in place through `--stdin --stdin-filename`, p3-eslint-baseline-Timeline.log); moved +80 by Task 17 and +2 by fix-wave C5. No BRANCH error |

Pre-existing lint in a touched file, not fixed here: `dashboard/src/routes/contact/Timeline.tsx`
`react-hooks/set-state-in-effect` (at :1495 on main @da04d0cb). Known hole: gate 5
checked nothing in `scripts/e2e-session.mjs` (`.mjs`; AGENTS.md "Known hole").

The same five gates were also green at `c2322857` before the review (P3: app
7171 + 1 skipped, dashboard 194 / 3225, e2e "279 passed (18.9m)"); the counts
above add the review's 9 app tests (C1 2 rows, A4 7 rows) and the new dashboard
mirror file (3 tests).

## Commits

`git log --oneline --no-merges main..HEAD` before this handback's own commit
(the one merge is `f49a2fe9`, main @`da04d0cb` merged in on 2026-09-25):

```
d6b7bfa4 docs(records): retry send window build - live self-QA on a fresh lane (four scenarios, measured)
168585b2 docs(records): retry send window build - fix wave 1b report (re-review 4.1, F1, N1)
3b081fdb docs(issues): split what spec section 9 accepts from the during-backoff refusals, and note this branch's stale-tab effects (retry-send-window build re-review F1, N1)
ac61485e test(retry-window): pin the ROOT slot on a versioned claim-time GATE decline (retry-send-window build re-review 4.1)
5aa7d1db docs(records): retry send window build - fresh re-review of the fix wave and its adjudications
72e1ae95 docs(records): retry send window build - fix-wave report (C1-C5, A1, A2, A4, A5, A6, A8)
d8aa32b6 docs(retry-send-window): relay-hub note, RUNBOOK wording, residual gap 5, and the job-decline promise issue (retry-send-window build review C2, C3, A1, A2)
d7f2d17a docs(retry-window): two comment corrections - already_claimed after a closed rung, and the conditional Retry (retry-send-window build review A8, C5)
06fb0f65 refactor(retry-window): one app constant for the window-close code, pinned across to the dashboard (retry-send-window build review A6)
57b04c61 refactor(retry-window): remove the dead annotate-after retry lineage (retry-send-window build review A5)
079d5731 refactor(retry-window): one copy of the one-to-one window origin rule (retry-send-window build review A4)
ebe8b50b test(retry-window): assert the versioned root slot is untouched by a window-declined claim (retry-send-window build review C4)
ae50e4c1 test(retry-window): pin the one-to-one retry job's window at its exact boundary (retry-send-window build review C1)
5a6cf53a docs(records): retry send window build review - spec-conformance and plan-blind adversarial findings, orchestrator adjudications
c2322857 docs(records): retry send window build - slice 5 report (Tasks 19-20)
152d3120 docs(retry-send-window): two comment corrections carried from slices 3b and 4 - the retry_due_at doc and the 30005/30006 group-text arm
3a82e690 docs(retry-send-window): close the group-text 30003 promise issue; annotate quiet-hours and ai-mode; reconcile the double-send residuals; selectors prose family and one-to-one row
693dd7ec test(e2e): one-to-one 30003 promises its retry with the failure, hides Retry, then the retry replaces it (retry-send-window)
822ec2e3 docs(records): retry send window build - slice 4 report (Tasks 14-18)
12223364 test(dashboard): every other 30003 reader reads the plain failure (retry-send-window D8)
603f35a7 feat(dashboard): one-to-one bubble promises a retry only while one is scheduled, hides Retry, ticks to expiry (retry-send-window D8, D10, D11, D12)
0fd12e0a feat(dashboard): a window-declined relay rung reads the plain 30003 failure (retry-send-window D8)
b7222692 feat(dashboard): 30003 promises a retry only while one is scheduled (retry-send-window D8, D11, D12)
40fc5c3c feat(dashboard): estimate the server clock and judge the retry promise on it (retry-send-window D8, D10)
198c061c docs(records): retry send window build - slice 3b report (Tasks 10-13)
902c1434 feat(retry-send-window): the contact timeline projects retry_due_at (spec D7)
35bee62a feat(retry-send-window): the manual Retry refuses 409 retry_pending while an automatic retry is scheduled (spec D10, D14)
7d60c233 feat(retry-send-window): the one-to-one retry job checks the window and follows the original send (spec D4, D6, D12, D14)
3c7370ac feat(retry-send-window): the one-to-one 30003 retry is decided before the failure is written (spec D3a, D7, D9, D11, D12)
e2c4abc8 docs(records): retry send window build - slice 3a report (Tasks 7-9)
e7797c88 feat(retry): one-to-one retry backoff lane seam and an explicit-runAt enqueue (retry-send-window D13, D7)
a9484249 feat(send): the send wrapper records automated, the recipient and the retry lineage at append (retry-send-window D6, D14)
5345c9a1 feat(send): previewSendRefusal - a pure preview of the one-to-one send wrapper's refusals, with a parity test (retry-send-window D3a)
f4613e8e docs(records): retry send window build - slice 2 report (Tasks 3-6)
4ceeb3f4 feat(relay-retry): bound a retry rung's wait on the A2P meter by its send window (spec D4, D9)
03ed963c feat(relay-retry): the retry job's send-window gate (spec D2, D4, D5, D9)
d0869276 feat(relay-retry): the claim decides at once - gate preview and send window (spec D2, D3, D5, D9)
ff063dcd feat(relay-retry): one gate evaluator for the retry job and the claim; the pool-number throw follows the gates (spec D3)
f6095e1e docs(records): retry send window build - slice 1 report (Tasks 1-2)
4809b5c2 feat(messages): retry lineage, window origin, send flags and retry_due_at on the message row (retry-send-window D2, D6, D7, D14)
7eb2a13b feat(retry-window): send-window constants and pure helpers (spec D1-D5, D10)
21699632 docs(records): retry send window build research - four read-only drift checks (0 blockers, 4 must-fix precision edits, 22 notes)
6fb365dd docs(plan): retry send window plan v3 - review closed at round 2; spec 7.3; mission block
63cd04cd docs(plan): retry send window plan v2 after review round 1; spec 7.2 section 5 req 6
1c0c7ab3 docs(records): plan review round 1 (two reviewers) + adjudications; spec draft 7.2
d35f3e91 docs(plan): retry send window plan v1 (21 tasks) + spec draft 7.1 precision edits
8b174ad4 docs(records): retry send window plan draft - slice C findings
d763faa6 docs(records): retry send window plan draft - slice A findings
33871ec4 docs(records): retry send window plan draft - slice D findings
5ed66257 docs(records): retry send window plan draft - slice B2 findings
943bc9ff docs(records): retry send window plan draft - slice B1 findings
fd38ba73 docs(spec): retry send window draft 7 - reconciled with share-skip-fix Branch A, D14 retry follows the original send
a688edca docs(spec): retry send window draft 6 - Cameron's gate answers
a8f41a32 docs(spec): retry send window - adopt the proposed phasing, with its condition
7b1e1fdb docs(spec): retry send window - overlap pass against send-outcome-reconcile rev 5
c00585c8 docs(spec): retry send window draft 5 - review closed, for Cameron's gate
3b43a4a3 docs(spec): retry send window draft 4 after review round 3
613752d1 docs(spec): retry send window draft 3 after review round 2; file two residuals
d4446de0 docs(spec): retry send window draft 2 after review round 1; round-1 records
a6c4c01b docs(spec): retry send window - design draft 1, with its research
```

Net line delta vs `main` (`git diff --shortstat main...HEAD`): code (app,
dashboard, e2e, scripts) 54 files, +6225 / -452; of that, non-test source in
`app/src` and `dashboard/src` 20 files, +1686 / -295. Docs and records: 52 files,
+18478 / -8.

## Spec decisions -> tasks -> commits

| decision | tasks | commits |
|---|---|---|
| D1 the 15-minute window | 1, 4, 5, 10, 11 | 7eb2a13b d0869276 03ed963c 3c7370ac 7d60c233; review: ae50e4c1 (job boundary pin) |
| D2 the origin | 2, 4, 11 | 4809b5c2 d0869276 7d60c233; review: 079d5731 (one one-to-one origin helper) |
| D3 the relay claim decides at once | 3, 4 | ff063dcd d0869276; review: ebe8b50b ac61485e (root slot pinned on both declines), 06fb0f65 (one close-code constant) |
| D3a the one-to-one decision before the write | 7, 10 | 5345c9a1 3c7370ac |
| D4 re-check before sending (incl. bounded acquire) | 5, 6, 11 | 03ed963c 4ceeb3f4 7d60c233; review: ae50e4c1 |
| D5 missing origin fails open | 1, 5, 10, 11 | 7eb2a13b 03ed963c 3c7370ac 7d60c233 |
| D6 lineage at append | 2, 8, 11 | 4809b5c2 a9484249 7d60c233; review: 57b04c61 (the annotate-after lineage path removed) |
| D7 the stamp with the failure | 2, 10, 13 | 4809b5c2 3c7370ac 902c1434 |
| D8 what the screen says | 14, 15, 16, 17, 18 | 40fc5c3c b7222692 0fd12e0a 603f35a7 12223364; review: 06fb0f65 (dashboard close-code mirror pin) |
| D9 logging | 4, 5, 10, 11 | d0869276 03ed963c 3c7370ac 7d60c233 |
| D10 manual Retry guard | 12, 14, 17 | 35bee62a 40fc5c3c 603f35a7 |
| D11 native group text | 10, 15, 17 | 3c7370ac b7222692 603f35a7 |
| D12 comments that lied | 2, 8, 10, 11, 15, 17, 20 | 4809b5c2 a9484249 3c7370ac 7d60c233 b7222692 603f35a7 3a82e690 152d3120; review: d7f2d17a |
| D13 seams and fixtures | 9, 19 (+ fixture moves in 4, 10) | e7797c88 693dd7ec (d0869276 3c7370ac) |
| D14 a retry follows the original send | 2, 7, 8, 10, 11, 12 | 4809b5c2 5345c9a1 a9484249 3c7370ac 7d60c233 35bee62a |
| Test intentions 1 / 2 / 3 / 4 / 5 / 6 / 6a / 7 / 8 | 1 / 3-4 / 5-6 / 7, 10 / 11 / 12 / 8 / 14-18 / 19 | 7eb2a13b / ff063dcd d0869276 (+ebe8b50b ac61485e) / 03ed963c 4ceeb3f4 / 5345c9a1 3c7370ac / 7d60c233 (+ae50e4c1) / 35bee62a / a9484249 / 40fc5c3c b7222692 0fd12e0a 603f35a7 12223364 / 693dd7ec |

## Review, fix waves and adjudications

- Build review at `c2322857` (records `build-review-conformance.md`,
  `build-review-adversarial.md`, adjudications `build-review-adjudications.md`):
  conformance CONFORMS WITH GAPS (0 blocker, 0 major, 1 minor, 4 nit); the
  plan-blind adversarial reviewer 0 blocker, 0 major, 2 minor, 8 nit, 5 open
  questions.
- Fix wave (`ae50e4c1..72e1ae95`, report `build-fixwave-report.md`): C1 job
  window boundary pin; C2 relay-hub issue note; C3 RUNBOOK wording; C4 versioned
  root-slot assertion; C5 Timeline comment; A1 gap 5 on
  `manual-retry-double-send-residual-windows` (no code, ruling 4); A2 new issue
  (no code); A4 `oneToOneRetryWindowOrigin` helper; A5 the dead annotate-after
  lineage removed; A6 `RETRY_WINDOW_CLOSED_CODE` + dashboard mirror test; A8
  comment. Every new assertion carries a reverted mutant proof.
- Fresh re-review of the fix wave (`build-rereview.md`, adjudications
  `build-rereview-adjudications.md`): the wave is REAL and behavior-preserving;
  0 blocker, 0 major, 0 minor; NIT N1 (a pre-deploy tab shows the raw
  `retry_window_closed` code on a relay leg - deploy note below), NIT F1 (the new
  job-decline issue overstated what spec section 9 accepted - fixed); challenge
  4.1 (the versioned GATE decline's root slot was unpinned - a surviving mutant;
  fixed); 4.2 (A2's recorded reason corrected); 4.3 (the deploy note completed).
- Fix wave 1b (`ac61485e`, `3b081fdb`, report `build-fixwave-1b-report.md`):
  test and docs only. The orchestrator verified it cold by re-running the
  re-reviewer's surviving mutant itself: 1 failed / 53 passed at the new
  assertion (`+ "actualTransport": "sms"`), reverted, 54 / 54.
- NOTE-only rows (no code, recorded for Cameron's eye): A3 client fallback drops
  `retry_due_at` (pre-existing drift, reachable only on a contact 404; the 409
  guard holds); A7 one extra conversation read per relay claim; A9 the server
  clock keeps the last sample (errs toward a longer promise); A10 mixed versions
  at deploy (deploy note); Q1-Q3, Q5 below. REJECTED: code for A1/Q4 (a reverse
  double-send guard, against ruling 4) and code for A2 (beyond the approved
  spec).

## Live self-QA (`build-selfqa.md`)

Fresh lane 6, lean seed, plugin Playwright MCP (the project MCP's
`chrome-for-testing` binary is not installed; no download was made), measured
from page text, accessible names, API rows and app logs, never reloaded:

- S1 PASS: the one-to-one promise shows 0.8 s after the send and never after a
  plain failure; 0 Retry in the promised bubble; `409 retry_pending`; the
  delivered retry replaces the bubble at 12.2 s with the right lineage.
- S2 PASS, residual measured: a STOP during the backoff made the job refuse
  (`contact_opted_out`, WARN, nothing sent); the promise stayed until the
  ticker flipped it at due + 2 min + 50.4 s - 170 s of "will retry" after the
  job gave up (the filed `one-to-one-retry-promise-outlives-job-decline`).
- S3 PASS: a native group text's 30003 leg reads the plain failure, never "will
  retry", no Retry, no `retry_due_at`.
- S4 PASS: a relay leg whose group closed before its 30003 callback read "Not
  retried - group closed" 0.46 s after the callback, never "Retrying"; server
  WARN `gate_refused` / `retry_group_closed`, no retry job.

## Facts for the planner's Relay for SOR (send-outcome-reconcile) and share-skip-fix Branch B

The planner writes the final "Relay for SOR" block (Cameron's standing instruction, `rulings.md`: one fenced ASCII block, full W:\ paths, Branch A's items for SOR carried unchanged); this section gives it the facts, verbatim from the code.

### Files changed, by area

From `git diff --name-status main...HEAD` (A added, M modified); every file in
that output appears once below.
- Foundation: `app/src/lib/retrySendWindow.ts` (A), `app/src/repos/messagesRepo.ts`,
  `app/test/helpers/twilioWebhookHarness.ts`, their tests:
  `app/test/retrySendWindow.test.ts` (A), `app/test/messaging.integration.test.ts`,
  `app/test/messagesRepoRetryLineage.integration.test.ts`,
  `app/test/twilioWebhookHarnessRetryFields.test.ts` (A)
- Relay: `app/src/lib/relayRetryGates.ts` (A), `app/src/lib/relayRetryClaim.ts`,
  `app/src/routes/webhooks/twilio.ts` (claim), `app/src/jobs/relayRetryLeg.ts`,
  `app/src/jobs/relayFanOut.ts`, tests: `app/test/relayRetryGates.test.ts` (A),
  `app/test/relayRetryClaim.test.ts`, `app/test/relayRetryClaim.webhook.test.ts`,
  `app/test/relayRetryLeg.test.ts`, `app/test/relayFanOut.test.ts`
- One-to-one server: `app/src/services/sendRefusalPreview.ts` (A),
  `app/src/services/oneToOneRetryDecision.ts` (A), `app/src/services/sendMessage.ts`,
  `app/src/jobs/retrySend.ts`, `app/src/routes/webhooks/twilio.ts` (30003 arm),
  `app/src/routes/api.ts`, `app/src/routes/contactTimeline.ts`,
  `scripts/e2e-session.mjs`, tests: `app/test/sendRefusalPreview.test.ts` (A),
  `app/test/helpers/sendRefusalCases.ts` (A), `app/test/oneToOneRetryDecision.test.ts` (A),
  `app/test/retrySendBackoff.test.ts` (A), `app/test/sendMessage.test.ts`,
  `app/test/twilioStatusWebhook.test.ts`, `app/test/apiRoutes.test.ts`,
  `app/test/contactTimeline.test.ts`
- Dashboard: `dashboard/src/api/serverClock.ts` (A), `dashboard/src/api/client.ts`,
  `dashboard/src/api/types.ts`, `dashboard/src/routes/contact/retryPromise.ts` (A),
  `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/contact/relayRetryJoin.ts`,
  `dashboard/src/routes/contact/Timeline.tsx`, Task 18 readers
  (`dashboard/src/routes/broadcasts/StatChips.test.tsx`,
  `dashboard/src/routes/broadcasts/broadcastFormat.test.ts`,
  `dashboard/src/routes/contact/Timeline.email.test.tsx`), tests:
  `dashboard/src/api/serverClock.test.ts` (A),
  `dashboard/src/routes/contact/retryPromise.test.ts` (A),
  `dashboard/src/routes/contact/retryPromiseMirror.test.ts` (A),
  `dashboard/src/routes/contact/relayWindowCloseMirror.test.ts` (A),
  `dashboard/src/routes/contact/deliveryStatus.test.ts`,
  `dashboard/src/routes/contact/relayRetryJoin.test.ts`,
  `dashboard/src/routes/contact/Timeline.delivery.test.tsx`,
  `dashboard/src/routes/contact/Timeline.test.tsx`,
  `dashboard/src/routes/contact/Timeline.ticker.test.tsx`
- Proof and docs: `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` (A),
  `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (comment),
  `e2e/support/selectors.md`, eight `docs/issues/*.md` (listed under Issues),
  the spec and plan, records in this folder
- Other: `RUNBOOK.md` - one phrase (fix-wave C3): the one-to-one wrapper refuses
  "the 30003 retry of an automated text" on a `manual` row, since D14 retries a
  person's text as a person's send.

### New stored fields (exact names)

- `retry_due_at` - on the FAILED one-to-one original. Written by
  `updateDeliveryStatus(sid, status, errorCode, { retryDueAt })` in the SAME
  conditional update as the failure (lands only if the transition does); re-written
  to `RETRY_PROMISE_WITHDRAWN_AT` (`'1970-01-01T00:00:00.000Z'`) through
  `annotateMessage` when the enqueue fails. Equals the retry job's run time.
  Read by the manual Retry guard (`isRetryPromiseLive`, `app/src/lib/retrySendWindow.ts`)
  and, through the contact-timeline projection, by the dashboard's
  `isRetryPromiseLive(retry_due_at, serverNowMs())`.
- `retry_window_start` - on one-to-one AUTOMATIC retry rows only: the chain's
  origin, `oneToOneRetryWindowOrigin(original)` (= `original.retry_window_start ??
  original.provider_ts`, the ONE copy of the rule since fix-wave A4, in
  `app/src/lib/retrySendWindow.ts`), written at append
  (`SendMessageInput.retryWindowStart` -> `NewMessage.retryWindowStart`). A manual
  Retry never copies it.
- `relay_retry_window_start` - on relay retry rows (rungs): rung 1 = the ROOT
  member slot's `sentAt`; rungs 2-3 copy the previous rung's value; written by the
  claim's append (`NewMessage.relayRetryWindowStart`). OPTIONAL in the job's
  lineage check: absent = a rung claimed before this deploy, WARN, no window (D5).
- `automated` - on EVERY one-to-one row `sendMessage` appends, true or false
  (false is written; the input defaults to false). A row without it predates this
  deploy and is treated as automated.
- `recipient_contact_id` - on one-to-one rows `sendMessage` appended with a
  `recipient` (the share fan-out, the retry job, the manual Retry route); a
  composer send passes none (seen live in self-QA S1). Read by the D3a decision,
  `retrySend` and the manual Retry route (missing contact -> phone lookup + WARN).
- Now written AT APPEND instead of annotated after the send: `retry_of`,
  `retry_attempt` (D6). Since fix-wave A5 `MessageAnnotations` has NO
  `retryOf` / `retryAttempt` - `annotateMessage` cannot write lineage at all; SOR
  must append it (the re-reviewer checked SOR's spec: it does not use
  annotate-after lineage).

### The lane seam

`E2E_SEND_RETRY_BACKOFF_MS` = `'10000'`, set in `scripts/e2e-session.mjs`
`childEnv` beside `E2E_RELAY_RETRY_BACKOFF_MS`. Read ONLY by
`resolveSendRetryBackoffMs(attempt)` in `app/src/jobs/retrySend.ts`, honored when
`JOBS_QUEUE_URL` is unset and the value is a positive integer, else
`retryBackoffMs(attempt)` (60/120/240 s). The D3a decision
(`app/src/services/oneToOneRetryDecision.ts`) uses it for the run time and the
window fit, and `enqueueSendRetry(payload, runAt)` schedules at that run time, so
`retry_due_at === runAt` (self-QA S1: 11.2 s after a second-truncated send time).
Branch B and SOR reuse it. `E2E_RETRY_SEND_WINDOW_MS` (optional in D13) was not
built - no e2e needed it.

### New codes and values

- Close code `retry_window_closed` - since fix-wave A6 ONE app constant,
  `RETRY_WINDOW_CLOSED_CODE` (`app/src/lib/retrySendWindow.ts`); `RelayRetryCloseCode`
  (`app/src/jobs/relayRetryLeg.ts`) and the claim's decline types
  (`app/src/routes/webhooks/twilio.ts`) derive from it and every app write,
  compare and log site uses it. Appended closed by the claim and written by the
  job (its window gate, a bounded-acquire timeout, a transient re-run past the
  window). The dashboard's copies (`WINDOW_CLOSED_CODE`, exported from
  `dashboard/src/routes/contact/relayRetryJoin.ts`, and the
  `INTERNAL_CODE_REASONS` key) are pinned to it by
  `dashboard/src/routes/contact/relayWindowCloseMirror.test.ts`. The union also
  takes the gate codes by reference from `RelayRetryGateCode`
  (`app/src/lib/relayRetryGates.ts`).
- Claim outcome `window_closed` (`RelayRetryClaimOutcome`,
  `app/src/lib/relayRetryClaim.ts`, 13 -> 14 values; ERROR). `gate_refused` is
  now produced at claim time and logged WARN (`isTerminalRelayLegFailure`).
  `already_claimed` also answers a duplicate callback for a rung appended CLOSED
  at claim time (documented by fix-wave A8), so on its own it does not mean a
  ladder ran.
- A claim-time decline APPENDS the rung already closed (gate code or
  `retry_window_closed`) in the claim's one append; `closeRetryLegEnqueueFailed`
  (`app/src/routes/webhooks/twilio.ts`) is unchanged and remains the claim's only
  close.
- `sendOneRelayLeg` (`app/src/jobs/relayFanOut.ts`): new arg `sendDeadlineMs?:
  number`; new result `'deadline_exceeded'`, returned BEFORE any `attempted`
  write: the LAST member of `RelayLegSendOutcome.kind`
  (`'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' |
  'transient' | 'deadline_exceeded'`, `relayFanOut.ts:1234-1242`), returned as
  `{ kind: 'deadline_exceeded' }` when the bounded `tokenBucket.acquire` throws
  `TokenBucketBusyError` (`relayFanOut.ts:1398-1402`). The fan-out passes no
  deadline.
- Manual Retry route: `409 { error: 'retry_pending' }`.
- One-to-one decision log values (`OneToOneRetryDeclineReason`):
  `conversation_missing`, `group_text`, `not_one_to_one`, the `SendRefusalCode`
  values (`sms_sending_disabled`, `contact_opted_out`, `contact_deleted`,
  `contact_no_consent`, `manual_mode`), `cap_exhausted`, `window_closed`;
  `failOpen`: `read_failed`, `no_origin`.
- Constants (`app/src/lib/retrySendWindow.ts`): `RETRY_SEND_WINDOW_MS` 15 min,
  `RETRY_JOB_GRACE_MS` 60 s, `RETRY_PROMISE_GRACE_MS` 2 min (mirrored in
  `dashboard/src/routes/contact/retryPromise.ts`, pinned by a test),
  `RETRY_PROMISE_WITHDRAWN_AT`, `RETRY_WINDOW_CLOSED_CODE`; helper
  `oneToOneRetryWindowOrigin`.

### Copy strings and where they live

- "Phone unreachable (error 30003)" - `ERROR_CODE_REASONS['30003']` + the
  `(error <code>)` tail, `dashboard/src/routes/contact/deliveryStatus.ts`:782.
  Every 30003 without a live promise; the relay map keeps its identical entry
  (`RELAY_ERROR_CODE_REASONS`, :865).
- "Phone unreachable - will retry (error 30003)" - `deliveryReason`'s
  `retryScheduled` branch (`RETRY_SCHEDULED_REASONS['30003']`), same file:837.
  Only a one-to-one bubble while `isRetryPromiseLive(retry_due_at, serverNowMs())`
  (Timeline.tsx:794, passed at :1056).
- "Not retried - message too old" - `INTERNAL_CODE_REASONS.retry_window_closed`,
  same file:957. No current surface renders it.
- "A retry is already scheduled for this message." - `sendFailureMessage` case
  `retry_pending`, `dashboard/src/routes/contact/Timeline.tsx`:135.
- Unchanged, now shown at claim time too: "Not retried - group closed", "Not
  retried - no longer in this group", "Not retried - number changed since", "Not
  retried - opted out" (`INTERNAL_CODE_REASONS`). Self-QA S4 saw "Not retried -
  group closed" 0.46 s after the callback.
- On this branch the share results row (`shareRecipientReason`,
  `dashboard/src/routes/broadcasts/broadcastFormat.ts`) shows the base wording
  even while a retry is scheduled (under-promising, never false).

### What SOR must carry (spec section 5), at the code this branch left

1. Any retry it re-drives later runs the same job handler, so the job-time
   window check (D4) bounds it: `relayRetryLeg`'s window gate (last gate, after
   the opt-out gate) and `retrySend`'s strict check after its execution marker.
2. Any path appending a one-to-one retry row carries `retry_of`,
   `retry_attempt`, `retry_window_start`, `automated` and `recipient_contact_id`
   AT APPEND (for a share, consistent with Branch A's `created_via`) - there is
   no annotate-after path for lineage any more (fix-wave A5), and the origin is
   `oneToOneRetryWindowOrigin`.
3. Any path deferring a one-to-one retry, or leaving its outcome pending past
   `retry_due_at`, applies the window to every re-schedule
   (`retryFitsSendWindow`) and keeps the promise and the D10 guard up by
   refreshing `retry_due_at` and emitting `message.persisted` after each refresh.
4. Its issue that an unresolved one-to-one retry leaves "will retry" standing
   changes with D8: the copy now follows `retry_due_at`, so requirement 3 is
   what keeps it truthful.
5. A deadline timeout (`'deadline_exceeded'`) is TERMINAL for a relay retry
   rung: nothing sent, the rung closes `retry_window_closed`; never a `retryable`
   deferral. Re-run the relay job tests (test intention 3) after that merge.
6. The relay job's window closes (the gate and the acquire timeout) are closes
   by a writer other than the recipient's own attempt: under SOR's D8 they read
   the attempt record first and close only if it is absent or
   `done`/`retryable`. The window checks run BEFORE SOR's claim (in `retrySend`
   too). A claim-time decline is a closed APPEND, not a close: no attempt record
   can exist for it.
7. `relayRetryJoin.ts`'s terminal step: SOR's `send_unconfirmed` special case
   and this branch's `retry_window_closed` (no display code, now the exported
   `WINDOW_CLOSED_CODE` pinned by `relayWindowCloseMirror.test.ts`) both survive
   the merge, each with its test.
Joint gap (neither spec closes it): an `unresolved` one-to-one retry leaves the
Retry action live after this branch's guard expired - recorded as gap 4 of
`manual-retry-double-send-residual-windows`. Gap 5 (an enqueue that throws after
SQS accepted the job) is new from the build review and is SOR-relevant: the
claim-based fix under that issue's "Suggested fix" closes gaps 1, 2 and 5 alike.
For Branch B: read the failed message's live `retry_due_at` on the share
results row under D8's rule (never the retry count); reuse the seam above.

## Issues

- Closed: `group-text-30003-leg-retry-promise-unverified`.
- Annotated: `quiet-hours-ungated-automated-paths` (item 3),
  `ai-mode-switch-gates-all-automation` (item 3 delivered for the 30003 retry),
  `relay-hub-message-delivery-status-never-terminal` (dated 2026-09-26 note: its
  premises changed with D8/D11; build review C2),
  `optional-call-outcome-breaks-already-loaded-bundles` (dated 2026-09-26 note:
  this branch's three already-loaded-bundle effects; re-review N1).
- Reconciled with spec section 9: `manual-retry-double-send-residual-windows`
  (revision 5 @616d120d, gap 2's "once the promise has expired", refs as paths);
  gap 5 added by the build review (A1), KEPT under Cameron's ruling 4.
- Filed new: `vitest-config-globalsetup-fail-soft-comment` (low; a stale comment
  found in plan review round 1, filed at 1c0c7ab3);
  `one-to-one-retry-promise-outlives-job-decline` (low improvement; build review
  A2, reworded by re-review F1 - see the open question below).

## Deferred and accepted

- Accepted residuals (spec section 9): pending-reconcile copy; a promise with
  nothing behind it (at most the longest backoff plus RETRY_PROMISE_GRACE_MS,
  6 minutes); a relay claim fault (`claim_failed`, recovered by redelivery); no
  usable origin (D5); a text sent before this deploy (D14); a human action
  reversed inside the backoff (D3); a relay leg's slot written before its claim
  decides (section 1).
- Recorded in issues: the double-send windows (now five gaps);
  the job-decline promise (group (a) accepted by section 9, group (b) newly found).
- Out of scope (spec section 8): a real native group-text retry; alarm
  thresholds and a manual relay retry; polling unconfirmed legs; the share
  results row's copy and its `retry_due_at` read (Branch B); the rest of
  `ai-mode-switch-gates-all-automation` (Work Package 2); retrying 30007; a
  conditional claim for the manual double send; the stranded-claim fix.
- Proven below the e2e layer on purpose (D13): the person's-send retry on a
  manual-mode thread, every declined retry (window, cap, D3a refusals) and the
  relay window. Self-QA added live proof of the ticker expiry (S2), D11 (S3) and
  a claim-time gate decline (S4).
- Deferred during the build: none beyond the NOTE rows above (A3, A7, A9, A10,
  Q1-Q3, Q5).

## Open questions and notes for Cameron

1. OPEN (his call, not blocking the merge): a retry the job refuses because
   something changed DURING the backoff - the member texts STOP, the kill switch
   is turned off, manual mode is set on an automated original's thread, the
   contact is deleted, consent is lost - keeps "will retry" and hides Retry
   until the promise expires: measured live at 170 s (self-QA S2). Spec section
   9 does not cover this group; his gate answer 3 bears on it. The fix is small
   but beyond the approved spec (best-effort withdrawal + an emit on every
   no-send exit after the job's marker), filed in
   `one-to-one-retry-promise-outlives-job-decline`. Fix it now as a follow-up,
   or leave it filed?
2. Watch item (Q1): late carrier 30003s past the window are now one ERROR
   `window_closed` line each. ErrorLogs pages on 5 errors in 5 minutes; a
   broadcast to a few handsets that were off for hours could page. His ruling
   kept alarm thresholds unchanged; flagged, not changed.
3. FYI (A1, gap 5 of the double-send issue): an SQS enqueue that throws after the
   queue actually accepted the job withdraws the promise at once, so a staff
   Retry then double-texts. Kept deliberately under ruling 4 ("I would rather err
   on the side of a double-text than a message not delivered at all").
4. Q2: the property-send results row never learns the retry's outcome (Branch B
   reads `retry_due_at` there). Q3: the relay `claim_failed` recovery relies on
   Twilio redelivering a 5xx'd status callback, and the claim now does three
   more reads before its append.

## Deploy note (not an operator obligation)

After deploying, reload every open dashboard tab - nothing forces a reload
(there is no build-stamp check in `dashboard/src`). Until reloaded, a tab loaded
before the deploy: shows a window-declined relay leg as "Delivery failed (error
retry_window_closed)" (re-review N1); still says "will retry" on every one-to-one
30003 and shows Retry during a live promise, where a press gets the generic
send-failure copy for the new 409 (no double send - the server refuses). And for
at most one backoff after the deploy, retries the OLD webhook scheduled carry no
`retry_due_at`, so the new screen offers Retry during their wait - the
pre-branch double-send behavior (A10). The structural fix is already filed:
`optional-call-outcome-breaks-already-loaded-bundles`.

## Build-time deviations from the plan

- Research worklist edits applied during the build (records
  `build-research-*-findings.md`, slice reports): the R2 pin test (Task 5), O1-O6,
  D1-D8, R1's count corrections, two carried comment corrections (`152d3120`:
  the `types.ts` `retry_due_at` doc and the `twilio.ts` 30005/30006 group-text
  comment), issue dates 2026-09-26.
- The review's fix wave went beyond the plan's code on purpose, each item
  adjudicated in `build-review-adjudications.md`:
  - A5 REMOVED `MessageAnnotations.retryOf` / `retryAttempt`, which the plan's
    self-review had chosen to leave in place as out-of-spec cleanup - the
    adversarial reviewer showed the dead path was a door back to the race D6
    closed, and a repo-wide sweep plus typecheck proved no caller.
  - A4 added `oneToOneRetryWindowOrigin` and A6 added `RETRY_WINDOW_CLOSED_CODE`
    with a dashboard mirror test - behavior-neutral single copies of rules the
    plan had written twice / four times.
  - Tests beyond the plan: the job window's exact boundary (C1), the root slot
    on both claim-time declines (C4, re-review 4.1).
- The plan's gate-log names (`.superpowers/gates/{typecheck,test,smoke,e2e,lint}.log`)
  are `final-*.log` here (and `p3-*.log` for the pre-review run).
- Self-QA used the Claude Playwright plugin MCP instead of the project MCP (its
  browser binary is missing on this machine; installing it needs a download).

## Mission health

Two orchestrator deaths on account usage limits (HTTP 429), each resumed from
this ledger by a fresh orchestrator with no lost work: R1 00:09 (Fable limit,
infra tier, free), R2 ~02:40 (Opus weekly limit, a repeat of the kind - consumed
1 of the 2-recovery budget). The ~02:30 fix-wave dispatch died with R2 and
produced nothing; it was re-dispatched at 11:56. No child needed recovery.
