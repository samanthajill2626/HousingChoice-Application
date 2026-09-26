# Build research - relay slice (S2: Tasks 3-6) - findings

Read-only research against the live tree, worktree `W:\tmp\retry-send-window`,
HEAD `6fb365dd` (code identical to `f49a2fe9`). Plan v3
`docs/superpowers/plans/2026-09-25-retry-send-window.md` (`plan:N`), spec draft
7.3. No source edited, no suite run. Byte-exact quotations, the anchor table,
the caller/consumer lists, the invariant sweep and the per-test vacuity table
are in the gitignored reference
`.superpowers/sdd/build-research-relay-reference.md`.

**Totals: 0 blocker, 0 must-fix, 2 note.**

What checked out (no finding):
- Anchors. Every Old block and insertion anchor in Tasks 3-6 resolves
  byte-for-byte, exactly once, at the cited HEAD line (the three post-edit
  blocks, plan:3237, :3774, :3794, match the Task 3/5 text they quote). Applied
  in plan order in memory (Tasks 1-6, 76 edits), every edit still found exactly
  one match; the "79 lines" shift from Task 3's insert (plan:1364-1442) is
  absorbed because every later edit in `relayRetryLeg.test.ts` is text-anchored.
- Compile and lint. The simulated tree type-checks with 0 diagnostics after
  Task 3, 4, 5 and 6 (repo TypeScript 5.9.3, the `tsconfig.test.json` options;
  0 on the unmodified tree too), and ESLint with the repo config reports 0 new
  messages on the 10 touched relay files.
- Callers. `sendOneRelayLeg` has two callers (`relayFanOut.ts:1140`,
  `relayRetryLeg.ts:575`) and no exhaustive switch over its outcome; only the
  retry job can see `deadline_exceeded`, and Task 6 handles it before
  `relayRetryLeg.ts:618`. `TokenBucketBusyError` is caught only at
  `groupSend.ts:506` today; every other acquire is unbounded. The only
  exhaustive tables are `relayRetryClaim.test.ts:51-88` (Task 4) and
  `relayRetryLeg.test.ts:307-377` (Task 5).
- Preview reads in existing tests. Every relay-claim driver runs on the webhook
  harness, whose four preview reads never throw
  (`twilioWebhookHarness.ts:525-527`, `:631-633`, `:1884-1906`), and every
  existing 30003 fixture is an open group with the member on the roster at the
  callback's `To` (`relayRetryClaim.webhook.test.ts:117-134`, `:195-205`;
  `twilioStatusWebhook.test.ts:1195-1208`, `:1238-1243`), so no existing case
  turns into `claim_failed` or `gate_refused`; they take the D5 fail-open path
  (no slot `sentAt`) and no existing assertion counts WARN lines.
- Logic. The claim reads the conversation today only in `composeRelayLegCopy`
  (`twilio.ts:600`, rung 1, non-team) and never the suppression; the preview's
  repos and helpers are in scope (`twilio.ts:84`, `:528`, `:530`). The job's
  gate order and the pool-number throw position (`relayRetryLeg.ts:491-555`,
  throw `:510-515`) are as the plan states. The acquire (`relayFanOut.ts:1360`)
  sits outside the only try (`:1385`), before the `attempted` write
  (`:1380-1382`), with no catch in the job (`relayRetryLeg.ts:575-598`) after
  the marker (`:350-356`) - the escape path spec D4 describes. The root slot's
  `sentAt` (`relayFanOut.ts:1457`) survives the failure write
  (`messagesRepo.ts:3616-3645`; harness `:1563-1572`) and `slot` is in scope at
  the claim (`twilio.ts:2744`). The production retry job gets the shared bucket
  (`registerHandlers.ts:60`), so Task 6 is not inert.
- Vacuity. Every new fixture meant to exercise the window carries an origin;
  each new test fails before its implementation except the six the plan labels
  as pins; every wall-clock margin is 30 s or more.

## Notes

1. **note - Task 2 / Task 20: two dashboard comments count six stored relay
   lineage values, and this branch stores a seventh.**
   `dashboard/src/api/types.ts:2301-2302` ("Only these FOUR of the six stored
   values are DECLARED") and `:2496` ("The four of the six stored lineage
   values this client PROJECTS") become false once Task 2 (4c, 4e, 4h) and
   Task 4 (5g) store `relay_retry_window_start`, which GET /conversations/:id/messages
   returns as-is. Task 2 (4b) fixes the same count at `messagesRepo.ts:737-740`,
   but no task names these two; the watch item at plan:93 disposes of the
   FIELDS (`:2308-2315`, `:2509-2515`), not the counts.
   `dashboard/src/routes/conversation/useRelayThread.ts:130-132` lists the
   digest and the leg copy as the values that arrive unprojected - incomplete,
   not false. Correction: add the two `types.ts` comments (and optionally the
   `useRelayThread.ts` one) to Task 20's comment work, saying that the window
   origin is stored and deliberately not projected.

2. **note - Tasks 3 and 5: the window gate follows the no-pool-number throw, and
   no test pins that pair.** After Task 3 the order is four gates, then the
   throw ("has no pool number"), then Task 5's step 4b (inserted before the
   media ERROR at HEAD `relayRetryLeg.ts:557`). An OPEN relay group with no pool
   number whose rung is past the window therefore still throws after the
   execution marker (`:350-356`), leaving the rung `queued`, where every other
   windowed rung past the window closes `retry_window_closed`. This matches
   spec D4's wording ("the LAST gate before the send (after the opt-out
   gate)"), and an
   open relay group without a pool number cannot send at all, so it is an edge
   of an anomaly. Correction: say in Task 5 Step 3(f)'s comment that the throw
   precedes the window gate on purpose (or reorder, if the stranding matters),
   and pin whichever order is chosen with a case like Task 3 Step 2's throw test
   plus `windowStart: minutesAgo(16)`.
