> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/build-worklist.md`. This is the original build-time adjudication and drift worklist, preserved verbatim below. Its instructions and anchors describe that stage of the mission; see the [closeout record](README.md) for current status and archive provenance.

# Build worklist - corrections to plan v3, merged from the four research readers

Orchestrator adjudication (2026-09-25/26). Every implementer applies the items for
its tasks IN ADDITION to the plan. The plan's code and anchors are otherwise
verified exact against the live tree (code == f49a2fe9). Full quotations and
sweep tables: `.superpowers/sdd/build-research-{foundation-close,relay,one-to-one,dashboard}-reference.md`.
Findings (committed): `docs/superpowers/reviews/2026-09-24-retry-send-window/build-research-*-findings.md`.

## Rules for every slice (repeat of the binding constraints)

- Build strictly in task order. One writer on the tree. Commit per task as the plan says (explicit paths, `git status` first, no `git add -A`).
- Co-Authored-By trailer names YOUR model, as your session's attribution reminder states (the plan's "Claude Opus 5.5" is that placeholder).
- ASCII on every ADDED line: after each task, `git diff -U0 HEAD -- <files> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0 BEFORE committing (whole-file `tr` for new files). Files with pre-existing non-ASCII: select, never retype.
- Per task: the task's own test files + `npm run typecheck` green. Do NOT run the whole `npm test`, `npm run e2e`, or `npm run smoke` (gates run later by the orchestrator). DynamoDB Local is up (required for every app vitest run).
- Never touch :5174 / :8080. Never use conv-0002 / contact-tenant-0002 (Dario) for anything automated.
- STOP and report (do not force) on an unexpected importer, cycle, contract mismatch or an anchor that does not match after your own earlier edits.
- If low on context: commit what is green, write the slice report, report the next step.

## Slice 1 (Tasks 1-2) - S1 implementer

- No must-fix. Note F7 (harmless): six more `MessagesRepo` doubles exist (`app/test/emailEvents.test.ts:364,:392`; `annotateMessage` doubles in `sendMessage.test.ts:251`, `scheduledSendSuppression.test.ts:293`, `mediaMirrorJob.test.ts:57`, `backfillMediaContentTypes.test.ts:81`) - they stay assignable; typecheck proves it.
- Harness `append` allowlist confirmed at `app/test/helpers/twilioWebhookHarness.ts:1088-1193` - Task 2 must extend it for ALL five new fields (retry_due_at is not an append field; the four append-time fields + relay_retry_window_start).

## Slice 2 (Tasks 3-6) - S2 implementer

- No must-fix. Every anchor exact; simulated tree typechecks after each of Tasks 3-6.
- Note R2 (RULING: keep the plan's order): after Task 3 the job's order is four gates -> no-pool-number throw -> (Task 5) window gate -> media ERROR. Keep it (spec D4: the window check is the LAST gate before the send). In Task 5 Step 3(f)'s comment state that the pool-number throw precedes the window gate on purpose (an open group with no pool number cannot send at all, and its throw after the marker strands the rung whatever the window says), and ADD one test to `app/test/relayRetryLeg.test.ts` modeled on Task 3 Step 2's throw test plus `windowStart: minutesAgo(16)` pinning that order (throws, rung stays queued, no `retry_window_closed`).
- Note R1 is assigned to Slice 3 (Task 13) - not yours.

## Slice 3 (Tasks 7-13) - S3 implementer

- MUST-FIX O1 (Task 10 Step 8b, plan:6247): the "Review Focus 4" `it(...)` title contains the apostrophe of "person's" inside single quotes - write that title in double quotes.
- MUST-FIX O2 (Task 10 Step 7 (A) and (E)): the quoted old text predates Task 9 and Task 4. When you reach Task 10: (A) the `../../jobs/retrySend.js` import in `twilio.ts` has THREE names after Task 9 (`enqueueSendRetry`, `resolveSendRetryBackoffMs`, plus the existing one) - reduce it to what Task 10's code still uses, and fold `RETRY_PROMISE_WITHDRAWN_AT` into the `../../lib/retrySendWindow.js` import Task 4 already added (never a second import of that module). (E) the old text is Task 9's TWO comment lines ("The retry runs one resolved backoff from now ... scheduled at exactly that instant.") + its two-argument `await enqueueSendRetry(...)` + `break;` - replace all of it, so Task 9's comment does not survive above the decline branch.
- Note O3 (Task 10 header comment of `oneToOneRetryDecision.ts`, plan:5290-5303): reword to "channel checks first (D3a step 1, D11), then the send path's previewable gates in the send path's own order" - the send path checks the kill switch before its channel guards, the decision checks conversation-missing -> group_text -> relay/no-phone -> kill switch. No code change.
- Note O4 (plan:5305-5311): make the comment say that on ANY failed read every send-path refusal is skipped (kill switch, thread opt-out, manual mode included) - the code is right (spec D3a fail-open), the comment under-describes.
- Note O6 (optional, cheap): in the `contact_deleted` webhook row (plan:5639-5654) push a live consenting contact on the same phone BEFORE `c-gone` so the row proves the recorded-recipient path.
- Note R1 (assigned here because Task 13 opens the file): `dashboard/src/api/types.ts:2301-2302` ("Only these FOUR of the six stored values are DECLARED") and `:2496` ("The four of the six stored lineage values this client PROJECTS") - the branch stores a SEVENTH relay lineage value (`relay_retry_window_start`, Task 4), so correct both counts and say the window origin is stored and deliberately not projected. Comment-only.
- Note O5 (accepted risk, no change): Task 10's decision reads (conversation, findByPhone, getById) run before the status write on every 30003 callback including redeliveries, and the awaited decision sits outside the arm's try/catch. Spec-required placement. Do not restructure.
- Note O7: plan:30 cites `scripts/e2e-session.mjs:502`; the real reason a fresh lane is needed is `spawnNode` passing the module-level `childEnv` (`:323-324`, built once at `:109`; `restartBackend` `:589-616`). Conclusion unchanged.

## Slice 4 (Tasks 14-18) - S4 implementer

- No must-fix. All 62 anchors exact; the mirror test's cross-workspace import compiles under `dashboard/tsconfig.json:6-12` and `dashboard/vite.config.ts:116-126` (precedent `mediaTypeMirror.test.ts:27-30`).
- Note D1 (Task 18): the `EmailCard (outbound delivery chip)` describe in `Timeline.email.test.tsx` spans :89-117 (not :116) - replace through :117 so no orphan `});` remains.
- Note D2 (REQUIRED): Tasks 14-18 have no per-commit ASCII step; seven edited files already carry non-ASCII (`deliveryStatus.ts` 21 lines, `Timeline.tsx` 47, `Timeline.test.tsx` 21, `deliveryStatus.test.ts` 7, `broadcastFormat.test.ts` 5, `StatChips.test.tsx` 4, `client.ts` 2). Run the diff-scoped ASCII check before EVERY commit. The ONE non-ASCII character that must go: `deliveryStatus.ts:778` (U+2014 in the current 30003 string). Hazard lines next to edits (select, never retype): `deliveryStatus.ts:773-774`, `deliveryStatus.test.ts:430`, `Timeline.tsx:130`, `:911`, `:1337-1338`, `:1351`, `Timeline.test.tsx:926`, `:928`, `client.ts:1`. Full map: reference file section C.
- Note D3 (Task 17): the rewritten comments in `Timeline.delivery.test.tsx` (plan:8401-8402, :8440) cite `Timeline.tsx:1790` and `:906`, which Task 17 itself moves (~:1873, ~:962) - cite by symbol (the `Timeline` props destructure default and `MessageBubble`'s default) instead of line numbers.
- Note D5 (Task 14): add one `serverClock.test.ts` case where `noteServerDate` gets a `receivedAtMs` DIFFERENT from the pinned `Date.now()` and the estimate reflects it (today every case passes the pinned clock, so an implementation ignoring the parameter would pass).
- Note D6 (optional): the two "ahead of the media map" tests (plan:7835, :8469) cannot observe order (the MMS map has no 30003 entry) - retitle them to what they pin ("media: true does not suppress the promise") or leave as written.
- Note D8 (Task 17, plan:8975-8977): the chip comment must NOT say a native group text "gets no stamp" - under D3a fail-open a group_text row CAN be stamped; what holds is that no screen renders it (`app/src/routes/contactTimeline.ts:1228-1232` skips group_text; `useRelayThread.ts:101-152` drops the field). Word it that way.
- Note D4 (for the gates, not you): the pre-existing lint error moves from `Timeline.tsx:1495` to ~:1572 after Task 17; baseline attribution handles it.
- Note D7 (RULING: accepted residual, no redesign): the server-clock estimate is not monotonic across responses (about a second of jitter); a refetch landing inside that margin right after the tick that expired a promise can re-show "will retry" for up to one more tick. This is the spec's stated error bound (D8: "the Date header's one-second resolution plus one tick"). Slice 5 records it in the Task 20 residual table; no code change.
- Notes D9/D10: no change.

## Slice 5 (Tasks 19-20; Task 21 is the orchestrator's) - S5 implementer

- MUST-FIX F1 (Task 19 Step 1): the probe `rg -n "unreachable \x{2014}" dashboard/src` ALWAYS hits `deliveryStatus.ts:409` (an unrelated docblock). Use `rg -n "Phone unreachable \x{2014}" dashboard/src` (expected: no hit).
- MUST-FIX F2 (Task 20 Step 5(a)): write "(revision 6, @`b93ab376`)" for `feat/send-outcome-reconcile` in `docs/issues/manual-retry-double-send-residual-windows.md`, not revision 5 @616d120d (spec draft 7.3 section 5; plan review R2-2).
- Note F3 (Task 20 Step 9): six modified files, not seven (`docs/issues/INDEX.md` is gitignored).
- Note F4 (Task 20 Step 4): check with `git diff --stat main...HEAD -- docs/issues/relay-retry-stranded-claim-window.md` and `git status --short -- <path>` (both empty), not a bare `git diff --stat`.
- Note D7 residual (from Slice 4's ruling): add to Task 20's residual table (spec section 9 wording): "the dashboard's server-clock estimate can step back about a second between responses, so a refetch landing right after the tick that expired a promise can re-show 'will retry' for up to one more 60-second tick - the spec's stated error bound (D8)".
- Note R1 is handled in Task 13; confirm the `types.ts` comments read right when you do Task 20's comment sweep.

## Orchestrator's own (Task 21 / handback)

- F5: "Filed new" names BOTH `vitest-config-globalsetup-fail-soft-comment` and `manual-retry-double-send-residual-windows` (added on this branch at 613752d1).
- F6: the copy-location `rg` returns three lines after Task 15 (base entry, `RETRY_SCHEDULED_REASONS`, relay map) - record each line by string.
- F2: the handback's Issues bullet says revision 6 @b93ab376.
- D4: gate-5 error line moves (~:1572); attribute by baseline.
- O7: plan:30 line cite (note only).
