# Handback - relay 30003 retry lineage

Branch `feat/relay-30003-retry-lineage`, worktree `W:\tmp\relay-30003-retry-lineage`.
Base `main @ bb54fdaa`; the branch's ONE main sync is merge commit `2af362e2`
(main @ `f82c149c`, 52 commits, no conflicts, one both-sides file:
`Timeline.tsx`). Final battery commit: `cce7e752`. Handed back 2026-09-03.

**MERGE-READY @cce7e752 on feat/relay-30003-retry-lineage (W:\tmp\relay-30003-retry-lineage), 0 behind main at 04:25 (re-checked at handback below), UNMERGED (human gate).** HEAD after this file lands is the same tree plus this docs-only commit.

**Post-merge ops: NONE.** No infrastructure, dependency, migration or
environment work; `app/package.json` unchanged; every new field optional and
self-creating; `E2E_RELAY_RETRY_BACKOFF_MS` exists only in the lane's
`childEnv` and is ignored wherever `JOBS_QUEUE_URL` is set. Nothing is
broken until anything is applied.

## Gates on cce7e752 (bare, from the worktree, exit codes from marker files)

| gate | exit | evidence |
| --- | --- | --- |
| 1 `npm run typecheck` | **0** | `.superpowers/sdd/gate-typecheck.log` |
| 2 `npm test` | **0** | app `Tests 6867 passed / 1 skipped (6868)`; dashboard `3148 passed`; e2e `496 passed`; fake-twilio `245 passed`; fake-twilio-web `111 passed`; 0 `[dynamoAdmin]` lines |
| 3 `npm run smoke` | **0** | |
| 4 `npm run e2e` | **1** = `1 failed / 266 passed (19.7m)` | `.superpowers/sdd/gate-e2e.log`. The one red is `outbound-mms.spec.ts:517` (a) with main's OPEN `e2e-outbound-mms-viewer-trigger-not-visible` signature (`locator.evaluate: Error: trigger is not visible` at `:591`, byte-identical; that issue records it failing in EVERY full run on main alone). Second run, the file ALONE on the same commit: **EXIT 0**, `6 passed (52.1s)`, case (a) `ok` in 6.0s. This branch's own proof `relay-30003-retry.spec.ts` passed in the battery (#137, 19.1s). 0 `[dynamoAdmin]`. Attribution: not this branch - see "Known e2e reds". |
| 5 `npx eslint` on 34 branch files | **1** = BASELINE **1** | HEAD `4 problems (1 error, 3 warnings)`; merge base f82c149c on the same paths `4 problems (1 error, 3 warnings)` - the pre-existing `react-hooks/set-state-in-effect` at `Timeline.tsx` (1328 on main, 1484 here) and three unused-disable warnings in `useRelayThread.ts`. ZERO new. PASS by baseline attribution. Known hole: `scripts/e2e-session.mjs` is `.mjs`, unlinted by config. |

Earlier batteries: on `17bf49a7` (pre fix-waves) gates 1/2/3/5 identical in
kind, gate 4 `266 passed / 1 failed` - the failure attributed below.

## Work map

| item | status |
| --- | --- |
| T1 lineage fields + media-pointer suppression | shipped `814f2997` (D13's gallery rationale corrected - research S6 - suppression built anyway) |
| T2 consistent source read + typed fakes | shipped `6940a63d` (3 MessagesRepo + 4 ConversationsRepo fakes) |
| T3 `sendOneRelayLeg` extraction | shipped `b2b35e81`, 186/186 relay tests identical; deviated: `RelayLegPayload` = a type-only `Pick`, `adapter: MessagingAdapter & CarrierMessageSender` (research S1/S5) |
| T4 status-preserving bump | shipped `1478ca0b`; deviated: preview arg may be `undefined` and the job passes it (research S3) |
| T5 wire fields | shipped `c8b0724d` |
| T6 join, two lifetimes | shipped `6332843b`; deviated: `EffectiveRelayLeg extends RelayRecipientDelivery` (research D1) |
| T7 D20 filter | shipped `5d2feb14` |
| T8 presenter | shipped `e4e8b533`; `retryAware` + `retryRow` options; composed label puts `on retry` first after the dash (B3) |
| T9 positions + ticker | shipped `51b12e13` + `bbe58487`; all three clause counts now six; `unconfirmed` row = today's not-confirmed copy (B1), deciding rung's leg overlaid (B2) |
| T10 hosts | shipped `65bed580` (green at first run; tour harness needed the roster mocks - research D4/D5) |
| E2 (orchestrator) | `845cfa54`: the rendered retry bubble reads `delivered 1/1 on retry` (B4); a clockless rung is `unconfirmed` never `retrying` (B5) |
| T11 retry job | shipped `64773ab3`; deviated per research S2 (no re-close of extraction-written slots), E2 (module-scope backoff) |
| T12 claim + SSE + escalation | shipped `71181d79`; the claim helper returns a value; its own ROOT emit (research S4) |
| T13 severity + `retryClaim` | shipped `c05a25d7`; the outcome union is now THIRTEEN values (spec D23 listed seven) - see "Spec text that trails the tree" |
| T14 browser proof | shipped `a97884f5` (`git mv` to `relay-30003-retry.spec.ts`); lane backoff 3s -> 10s in wave 1 (`742d7b8c`) |
| T15 issues | shipped `3787d818`: both anchors resolved with all nine ACs walked; quiet-hours annotated, not closed; both filed issues stay OPEN with two sentences corrected |

Nothing skipped.

## Reviews and fix waves (all records in this directory)

- Research (3 readers, 27 findings, `research-adjudications.md`): no spec
  decision changed; the plan's two type errors, the wrong-process backoff
  rationale and the backwards preview overwrite were corrected before code.
- R1: spec-conformance (16/17 CONFORMS, 19/20 intentions) + plan-blind
  adversarial (1 HIGH, 5 MED, 4 LOW, 5 NOTE). `code-review-r1-adjudications.md`:
  F1-F10 fixed in wave 1, F11 (the claim-to-enqueue crash window, a spec Sec 9
  residual) FILED as `relay-retry-stranded-claim-window`, Q1-Q5 OPEN, rest
  recorded.
- R2 (fresh re-review): found 4 MEDIUM defects INSIDE wave 1 plus 1 HIGH
  composed from three separately-dispositioned residuals. Wave 2 (9 items,
  `code-review-r2-adjudications.md`): `slot_settled` (WARN) split from
  `slot_ineligible` (ERROR); a thrown claim runs the tail then rethrows so
  Twilio redelivers; the lane override is ignored whenever `JOBS_QUEUE_URL`
  is set; `sendOneRelayLeg` accepts `suppressionChecked` (fan-out
  byte-identical); an `unconfirmed` leg keeps its carrier code at every
  position (Q2 became a fix, amending B1).
- R3 (fresh, scoped): 0 above LOW; all nine wave-2 items REAL; verdict
  merge-ready. Wave 3: the route answers a thrown claim with 500 itself (one
  ERROR line); the chip's not-confirmed reason fenced to retry legs.
- Phase 5 finding P1 (wave 4, `ee2fd8eb`): the job's terminal closes now emit
  `message.persisted` for the root; re-verified live with no reload.

## Open questions for the human (the code follows the spec until answered)

1. **Q1** gate refusals (`retry_group_closed` / `_member_removed` /
   `_number_changed` / `_opted_out`) log at ERROR per the approved D23 set;
   the reviewers argue they are human actions and the 21610 precedent says
   WARN. Log hygiene, not paging (one bucket). One-line change if wanted.
2. **Q3** the destination digest is an unkeyed truncated SHA-256 over
   `<root>|<E164>` (spec D3/D5) and its salt travels beside it, including in
   the browser payload; a NANP pre-image is recoverable. `createHmac` with a
   shared secret is the change. Exposure bounded to authenticated staff who
   already see the roster.
3. **Q4** alarm volume: one `cap_exhausted` ERROR per message per dead
   handset (3 consecutive buckets to page) AND up to four `delivery_failed`
   events per message against `hc-<env>-delivery-failures` (single period) -
   relay now counts like the 1:1 ladder. Redelivery adds more.
4. **1.1 / F11** a crash between the claim's append and the enqueue strands
   the ladder with no alarm (spec Sec 9 residual). Filed with the due-row
   design; W1/W5 restored the on-screen signals but nobody observes the state.
5. **Q5** the rendered retry bubble's chip reads `delivered 1/1 on retry`
   while its own row reads plain `Delivered` (cosmetic).

## Spec text that trails the tree (recorded, not re-litigated)

- D23's `retryClaim` list (7 values) is 13 in code: `+ already_claimed,
  slot_ineligible, slot_settled, code_not_retryable, enqueue_failed,
  claim_failed`. The rule ("every failure line says why no retry is running")
  required them.
- Sec 2 names `routes/dev.ts` as the backoff seam; the tree reads it in
  `jobs/registerHandlers.ts` and the job (the job runs IN-PROCESS in the app
  in the lane; research E1).
- D13's "would triple a photo in the gallery" is not true today (the gallery
  excludes relay threads by name); the suppression is built anyway.
- D16's SSE is extended to job-side terminal closes (P1).

## Residuals (recorded; not defects of the build)

- Hidden retry rows dilute paging (Sec 9); a history page of only hidden rows
  shows "No messages yet." (research D9).
- Rung-1's leg copy is composed at claim time from the current roster (A10);
  the TEAM sender is handled exactly.
- An unclassified send error in the job loses the rung with no close code
  (A11, marker-first like the fan-out).
- The conversation header keeps reading `Open` after an API close until a
  reload (pre-existing; the close route emits no conversation SSE).
- F7 on a versioned slot: the duplicate suppression read is now skipped
  (`suppressionChecked`), so `contact_opted_out` cannot land on a retry row.

## Known e2e reds NOT attributable to this branch (both runs reported)

- Checkpoint on the pre-sync base (`bb54fdaa` + this branch): `outbound-mms.spec.ts` (a) scroll-OFFSET signature (146/112; alone 512/500), fails identically DETACHED at the base with our commits absent. Main closed it the same day (`e06b133c`); the sync carried the fix; the file then passed 6/6.
- Battery on `17bf49a7` (synced): the same case with the "trigger is not visible" signature at `:591` - main's OPEN `e2e-outbound-mms-viewer-trigger-not-visible` ("fails in EVERY full-suite run ... main alone reproduces it"); passed alone twice on that commit (`6 passed (59.9s)`, `6 passed (41.0s)`). Sighting recorded in that issue and in `e2e-scenario-specs-rotate-failures-full-suite`.
- Slice H run 1 and wave-1 run 2 logged a post-pass teardown ERROR for
  `relay-open-stop`'s conversation (`relayFanOut: v1 preflight aggregation
  failed: missing`, reseed racing an in-flight fan-out) - not reproduced in
  the other runs, not this branch's file.

## Self-QA (`self-qa.md`)

Four scenarios measured on a hermetic lane with the 10s override: happy path
at all three positions plus payload and log (Ada 2 legs with the identical
leg copy, Bo exactly 1); the retrying state live; the ladder to cap (four
legs, WARN x3 then ERROR `cap_exhausted`, ticker terminated, all rungs chained
to the root under one digest); the inbound recital (no chip, no duplicate
bubble, `group "Delivery by recipient. Ada Unreach: Delivered on retry"`);
a gate refusal (ERROR `gate_refused`/`retry_group_closed`, no send, group stays
closed). P1 found there, fixed, re-verified on a fresh lane with no reload.
Not exercised live: D4's duplicate-delivery marker (the lane cannot redeliver
- research E6), `enqueue_failed`, `transient_cap`; all unit-proven.

## Issues

- RESOLVED: `relay-30003-retry-lineage`, `relay-30003-classified-transient-retrying`.
- FILED: `relay-retry-stranded-claim-window` (med, open).
- ANNOTATED, still open: `quiet-hours-ungated-automated-paths` (item 3).
- Corrected, still open by founder ruling: `relay-member-key-collapses-two-phones-one-contact`, `relay-inbound-source-has-no-delivery-rollup`.
- Sightings added: `e2e-outbound-mms-viewer-trigger-not-visible`, `e2e-scenario-specs-rotate-failures-full-suite`.

## Size

61 non-merge commits + 1 merge. Code + tests + e2e + scripts + issues:
45 files, +8872 / -421 vs the merge base; with the mission records 91 files,
+23345 / -421. New code files: `app/src/jobs/relayRetryLeg.ts`,
`app/src/lib/relayRetryClaim.ts`, `dashboard/src/routes/contact/relayRetryJoin.ts`
(+ test), `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (renamed).
Recoveries consumed: 0 (no misfires, no deaths).

## Not blocking, my eye

- `RelayRetryClaimOutcome` at thirteen values is the taxonomy's whole
  vocabulary; the log lines are self-describing, but the spec's Sec 6 should
  be updated to match when the docs are stamped.
- The transient sub-ladder (5s/10s) has no lane override and is unit-proven
  only; the 10s lane rung means a transient pass cannot be observed in the
  browser.
