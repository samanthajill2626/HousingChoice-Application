# Planner conformance review - feat/retry-counter-durable (bundle M5)

Independent spec-conformance pass by the mission planner's reviewer, 2026-09-01,
read-only against `W:\tmp\retry-counter-durable` at `175491b9`
(code final `b1d62cfe`). Diff reviewed: `git diff main...HEAD`.

Method: every spec decision D1-D23 and every item in spec Sec 7 walked to the
code and the test that delivers it; then the handback's work-map claims checked
against the diff rather than against its own report. NO test suite, e2e or
Playwright run was started (the planner holds the gates). Where the only
available evidence is a committed record or a gitignored log I read, that is
said so explicitly.

**Verdict: 34 CONFORM / 1 PARTIAL / 0 MISSING.** The one PARTIAL (D6) is a
bounded deviation authorised in the plan and disclosed twice. Nothing blocking.

---

## 1. Decisions D1-D23

### The durable counter (D1-D11)

| id | verdict | evidence |
|---|---|---|
| D1 count in the durable record, claimed BEFORE the work | CONFORMS | `app/src/repos/broadcastsRepo.ts:650-687`, `app/src/repos/messagesRepo.ts:2789-2834`; claimed at `app/src/jobs/broadcastFanOut.ts:326` and `app/src/jobs/relayFanOut.ts:886`, both above the send loop |
| D2 top-level scalar, NOT in a recipient slot | CONFORMS | `BroadcastItem.fanout_attempt` `broadcastsRepo.ts:171-174`; `MessageItem.fanout_attempt` `messagesRepo.ts:875-880`. Proven durable across a wholesale slot write by `app/test/broadcastsRepo.integration.test.ts:566-596` (`setRecipient`) and `:582-596` (`setRecipientDelivery`, chosen deliberately over the child-field writer) |
| D3 scalar, not a per-recipient map | CONFORMS | one `ADD #fa :one` per item; keys are `broadcastId` (`broadcastsRepo.ts:657`) and `conversationId`+`tsMsgId` (`messagesRepo.ts:2797`) - the SOURCE MESSAGE, not the conversation |
| D4 no migration / no backfill | CONFORMS | `ADD` creates from absent; pinned by `broadcastsRepo.integration.test.ts:463-472` and `:474-480` (an item written before the branch claims at 1) |
| D5 atomic claim | CONFORMS | conditional `ADD` + `UPDATED_NEW`, no read-then-write; 8-way concurrency cases at `broadcastsRepo.integration.test.ts:527-539` (broadcasts) and `:541-553` (messages) assert exactly 1..8, distinct. These are DynamoDB Local integration cases, not fake-backed |
| D6 claimed once per pass, after the duplicate guard and only when a send will be attempted | **PARTIAL** | Both named properties HOLD and are tested: duplicate delivery consumes nothing (`broadcastFanOut.test.ts:633-641`, `relayFanOut.test.ts:504-512`), all-terminal pass consumes nothing (`broadcastFanOut.test.ts:660-684`, `relayFanOut.test.ts:790-820`). Claim sits below `putJobExecutionMarker` (`broadcastFanOut.ts:224-235` -> claim `:326`; `relayFanOut.ts:721` -> claim `:886`) and below every early return. **The gap:** a pass whose recipients are all non-terminal but all SKIP inside the loop (opted out / no consent, and on relay also suppression) still spends a rung. Plan Sec 2a pre-authorised this in writing; handback "Recorded deviations" restates it and notes relay is wider. Accepted, not hidden |
| D7 pass count and backoff UNCHANGED from main | CONFORMS | broadcast: main `nextAttempt=(payload.attempt??1)+1`, cap `nextAttempt>3`, backoff `broadcastBackoffMs(nextAttempt)` -> 3 passes, delays 10s/20s. New: cap `claim.attempt>=3` (`broadcastFanOut.ts:583`), backoff `broadcastBackoffMs(claim.attempt+1)` (`:607`) -> identical. Relay: main `fanOutBackoffMs(payload.attempt??1)`, new `fanOutBackoffMs(claim.attempt)` (`relayFanOut.ts:1074`) -> identical. Asserted as LITERALS off the adapter, not re-derived: `[10,20]` (`broadcastFanOut.test.ts:453`) and `[5,10]` (`relayFanOut.test.ts:645`), plus send COUNT 3 on each ladder (`:451`, `:644`) |
| D8 three closes, no recipient left `queued` | CONFORMS | one helper per file - `closeBroadcast` (`broadcastFanOut.ts:265-302`, marks failed + `bumpStats{failed:+1,queued:-1}` + progress + ONE `log.error` + `finalize`) and the deliberately narrower `closeRelay` (`relayFanOut.ts:842-874`). Close A `broadcastFanOut.ts:583-587` / `relayFanOut.ts:1056-1060`; close B `:334-338` / `:898-902`; close C `:611-616` / `:1078-1083`. Each has its own test asserting the SAME terminal shape |
| D9 enqueue failure closes immediately, does not throw | CONFORMS | `try { enqueue } catch { close }` in both files; no rethrow |
| D10 close reason distinguishes exhausted from never-scheduled | CONFORMS | `transient_cap` vs `enqueue_failed` written to the slot; both close tests assert the distinct code, and `deliveryStatus.test.ts:817-819` asserts the two sentences do not converge |
| D11 relay's continuation backoff NOT normalised | CONFORMS | `fanOutBackoffMs(claim.attempt)` - the CURRENT pass - kept beside broadcast's NEXT-step call, with the divergence documented at `relayFanOut.ts:78-84` and `:1071-1073` and pinned by the literal `[5,10]` vs `[10,20]` assertions |

### What this does not fix (D12)

| id | verdict | evidence |
|---|---|---|
| D12 the `throw`-for-redelivery path stays broken and is FILED | CONFORMS | `docs/issues/throw-for-redelivery-defeated-by-job-marker.md` (new, high). The two false comments claiming a redelivery gets a fresh `jobId` are corrected in place and now carry `TODO(throw-for-redelivery-defeated-by-job-marker):` (`broadcastFanOut.ts:544-554`, `relayFanOut.ts:1000-1011`). Behaviour unchanged, as specified |

### Group rail binding propagation (D13-D18)

| id | verdict | evidence |
|---|---|---|
| D13 re-read before concluding damage | CONFORMS | `reReadUntilBound` `app/src/services/groupRail.ts:334-352`, rungs `[500, 1500]` (`:249`), stops as soon as `missing` empties, RETURNS the list so the caller reassigns |
| D14 BOTH reads that can conclude damage | CONFORMS | validation read `groupRail.ts:569-597` and post-repair read `:631-641`. Post-repair coverage pinned by `groupRailService.test.ts:762-782` (4 reads, waits `[500,1500,500]`) - the read the two false `rail_failed` records came from |
| D15 authority model unchanged; a failed re-read is a failed read | CONFORMS | nothing derived from create-time per-member failures; the point-1 catch records the rail failure and returns (`:578-590`), and the stale list is never reused. Pinned by `groupRailService.test.ts:855-897` (claim released, no repair attempted, no escaped throw) |
| D16 exactly three callers, opted in explicitly | CONFORMS | `jobs/groupRail.ts:65`, `lib/import/convertGroups.ts:436`, `scripts/rail-verify.ts:206`. Repo-wide grep for `awaitBindingPropagation` shows NO other production call site; `services/groupSend.ts:381` and `:425` are untouched in the diff. Flag asserted by `groupRailJob.test.ts:77` and `importConvertGroups.test.ts:508` |
| D17 adopt path excluded | CONFORMS | ladder gated on `!wasAdopted` at both points; `groupRailService.test.ts:785-808` proves an adopted rail ladders on NEITHER read (waits `[]`, exactly 2 reads) |
| D18 no 50386/50437 handling | CONFORMS | none added; filed as `docs/issues/rail-repair-refusal-log-noise.md` |

### Dashboard (D19-D23)

| id | verdict | evidence |
|---|---|---|
| D19 relay legs stop promising a retry | CONFORMS | `RELAY_ERROR_CODE_REASONS = { '30003': 'Phone unreachable' }` `dashboard/src/routes/contact/deliveryStatus.ts:608-610`, consulted only on `opts.relay` (`:705`) |
| D20 native group text NOT included | CONFORMS | pinned EXPLICITLY, not by default: `deliveryStatus.test.ts:697-704` (`relay:false` and no-opts both keep the em-dash promise), rollup `:394-404`, and the full three-position group-text case `Timeline.delivery.test.tsx:516-537` passing `rosterKind: 'group_text'` |
| D21 all three relay render positions change together | CONFORMS | rollup via `presentRelayDelivery({relay})` (`Timeline.tsx:916`, forwarded whole because `RelayDeliveryOptions extends DeliveryReasonOptions`, `deliveryStatus.ts:344`+`:416`); recital `Timeline.tsx:585-587`; row `:1067-1069`. Both derivations come from the same `rosterKind` prop. Asserted together in `Timeline.delivery.test.tsx:471-507` with a PAGE-WIDE `will retry` negative, and again in the e2e |
| D22 the two app-invented codes render as prose | CONFORMS | `INTERNAL_CODE_REASONS` `deliveryStatus.ts:665-669`, no `(error <code>)` tail; asserted in all four positions - badge `StatChips.test.tsx:139-155`, rollup `deliveryStatus.test.ts:352-380`, row + recital `Timeline.delivery.test.tsx:379-435` |
| D23 one string works in every position, badge included | CONFORMS | same four positions; copy reads as both aggregate and single-row. `enqueue_failed` deliberately names no cause (documented `deliveryStatus.ts:655-658`) |

---

## 2. Spec Sec 7 - what must be proven

| # | verdict | evidence |
|---|---|---|
| 7.1 counter survives a per-recipient status write | CONFORMS | `broadcastsRepo.integration.test.ts:566-596`; the messages case deliberately uses `setRecipientDelivery` (wholesale) rather than `updateRecipientDeliveryStatus` (child fields), which is the only version that would fail a slot-resident design |
| 7.2 concurrent claims cannot collide | CONFORMS | `:527-553`, both repos, 8 parallel claims, DynamoDB Local |
| 7.3 broken enqueue -> terminal, nothing `queued`, no longer "Sending"; RED on main | CONFORMS | `broadcastFanOut.test.ts:499-538` (close C) asserts `enqueue_failed`, `stats.queued 0`, `status !== 'sending'`; relay twin `relayFanOut.test.ts:673-716`. RED evidence is real and I read it: `.superpowers/gates/s2-red-vitest.log` (gitignored) shows `Tests 5 failed | 23 passed` against the UNTOUCHED job, close C among them; `s3-red-vitest.log` is its relay counterpart. Seam is `configureOutboundQueue` with a delay-selective thrower, as the plan required - not `vi.mock` |
| 7.4 all three closes leave the same shape, incl. first-pass envelope and relay INBOUND source | CONFORMS | close B on broadcasts uses a first-pass envelope (`broadcastFanOut.test.ts:463-497`); the relay close B (`relayFanOut.test.ts:621-671`) uses an INBOUND source whose `delivery_recipients` is asserted EMPTY first (`:628`) and then asserts the roster-derived keys `['c-bob','c-carol']` were marked - the vacuity trap spec 7.4 names is explicitly closed |
| 7.5 send count AND delays equal main's, both ladders | CONFORMS | both halves on both ladders (see D7). Delays read off the adapter's `delaySeconds`, never re-derived from `broadcastBackoffMs`/`fanOutBackoffMs` |
| 7.6 a pass that enqueues a continuation does not finalize | CONFORMS | pre-existing continuation test kept and extended (`broadcastFanOut.test.ts:415-420`: still `sending`, now also `fanout_attempt === 1`) |
| 7.7 duplicate claims nothing; a no-send pass consumes no pass | CONFORMS | see D6 row |
| 7.8 a pre-branch item claims successfully | CONFORMS | `broadcastsRepo.integration.test.ts:463-480`, both repos |
| 7.9 rail: propagation resolves without repair; a genuinely unbound member still repairs; post-repair read ladders; adopt path ladders on neither read; groupSend unchanged | CONFORMS | `groupRailService.test.ts:706-1000`. The fixture returns the SHORT list from the create and from early reads (`:686-704`) - the trap the plan warned about is avoided, and the no-repair case asserts `addParticipants` was not called DIRECTLY rather than relying on a throwing default. `groupSend` unchanged is proven by the diff (file untouched) plus the flag-absent service case `:810-828`. NOTE: no test asserts the `rail-verify.ts` call site's flag (script, no suite); the flag is verified by grep only |
| 7.10 relay 30003 in every position; 1:1, group text, email, badge unaffected; group text pinned explicitly | CONFORMS | `Timeline.delivery.test.tsx:471-507` (3 positions + page-wide negative), `:516-537` (group text, all 3), `:577-595` (message-level chip), `Timeline.email.test.tsx:89-116` (EmailCard), `StatChips.test.tsx:127-131` (badge keeps the promise). Precedence media-then-relay pinned at both the pure function (`deliveryStatus.test.ts:713-735`) and the call sites (`Timeline.delivery.test.tsx:544-568`) |
| 7.11 both internal codes as prose in every position, badge included | CONFORMS | four positions, each asserting no `(error ` tail and no raw token |
| E2E (hermetic) relay 30003 shows no retry promise | CONFORMS | `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`. Armed with `setDeliveryOutcome` after settling the create-time intro on BOTH members (`:122-132`) - so it is NOT asserting against an empty `delivery_recipients` map: it asserts `delivered 1/2 - 1 failed - Phone unreachable (error 30003)`, the accessible name, a named failed ROW and a named delivered control row, with `not.toContainText('will retry')` at each. Lean lane, run-unique numbers, no reload (SSE proven) |

---

## 3. Handback claims vs the diff

Every work-map row is backed by code in the diff. Spot-checks:

- S0+S1: both repos, both item types, and FOUR fakes updated
  (`twilioWebhookHarness.ts:1337-1352` messages, `:2758-2777` broadcasts;
  `scheduledSendSuppression.test.ts:288-291` and `sendMessage.test.ts:239-242`
  throw `not implemented`, which is what the plan allows for suites that never
  exercise the ladder). **The harness fakes model the REAL semantics** -
  increment-and-return, refuse at cap with the unchanged count, `missing` for an
  absent item - so the cap tests in slices 2 and 3 are not vacuous. The
  broadcasts fake deliberately reads the map ENTRY rather than `getById`'s
  shallow copy, which is what makes the seeded close-B test meaningful.
- S2 cap test: **rewritten, not weakened.** Every original assertion survives
  (`failed`, `transient_cap`, `stats.failed 1`, terminal `status`) and the test
  now drives THREE real passes instead of injecting `attempt: 3`, plus
  `stats.queued 0`, `not 'sending'`, no fourth continuation, exactly one close
  log line, `fanoutAttempt 3`, send count 3 and delays `[10,20]`.
  `broadcastFanOut.test.ts:418-461`.
- S3: relay had no cap test on main; the branch adds close A/B/C, the `missing`
  arm and the no-rung passes.
- S6: 52-site sweep recorded in `provider-status-sweep.md` with per-site
  disposition and a re-verification delta; residue filed as
  `provider-status-unenumerated-defaults` (med). Both false redelivery comments
  corrected.
- S7: anchor issue stamped `resolved` WITH the explicit
  "`retrySend.ts:74` needed no change" note; `rail-binding-propagation-retry`
  updated as PARTIAL naming both live `groupSend` paths; `_CLUSTERS.md` M5
  amended saying the branch did the OPPOSITE of the cluster's routing on both
  counts; `relay-30003-retry-lineage` carries all five design facts spec Sec 8
  obligation 5 names, plus a "reuse the pattern, not the counter" note.

**Recorded deviations, judged:**

1. *Backoff asserted as adapter `delaySeconds` integers rather than milliseconds
   off `runAt`* - SOUND and accurately disclosed. `jobs.ts:112-124` computes
   `delaySeconds = ceil((runAt - now)/1000)` and passes only that to the
   adapter; `runAt` never reaches it, so the plan's wording was impossible as
   written. The substitute still distinguishes a ladder shifted by a step, which
   is the property D7/D11 need.
2. *Relay dashboard flag shipped as boolean `relay` on `DeliveryReasonOptions`
   rather than `rosterKind` on the bag* - behaviourally identical, disclosed,
   and arguably better scoped (the presenter takes a product hint, not a roster
   taxonomy).
3. *`isDeadRailState` analysed per-consumer and FILED rather than fixed
   in-region* - a second named exception to slice 6's fix-in-region rule, with
   the reasoning written out in the sweep. Sound: fixing one consumer would
   reinstate the healRail loop.
4. *D6's bounded deviation is wider on relay* - disclosed; see D6 above.

**Gate claims corroborated from the (gitignored) logs I read, not re-run:**
`final-g1-typecheck.log` clean; `final-g2-test.log:2071-2072` "347 passed | 1
skipped (348) / 6428 passed | 9 skipped"; `final-g3-smoke.log` "smoke-dist: OK";
`g4-final.log` "263 passed (21.9m)" with `g4-final.exit` 0; `final-g5-eslint.log`
2 errors, and `g5-eslint-baseline.log` shows the SAME 2 at the merge base
(`convertGroups.ts:32`, `Timeline.tsx` set-state-in-effect at :1240 vs :1265) -
gate 5 passes by the AGENTS.md ratchet.

---

## 4. Findings

All LOW. None blocks the merge.

**F1 (LOW) - D6 is PARTIAL: an all-skipped pass still spends a rung.** Plan
Sec 2a authorised it in advance, the handback restates it, and relay's version is
wider because of opt-out suppression. Consequence is a shortened ladder for a
send that was reaching nobody. No action; noted so a future reader does not
re-diagnose it as a defect.

**F2 (LOW) - the rail ladder creates a new `rail_failed` path that main did not
have.** On main a short validation read went straight to repair. With the ladder,
the EXTRA `fetchParticipants` can throw (e.g. a transient 503), and per D15 and
plan 4d a failed re-read is a failed read - so a rail main would have repaired is
now recorded failed. This is mandated behaviour, is tested
(`groupRailService.test.ts:855-897`), and is confined to the three opted-in batch
callers. Worth knowing before the next bulk migration, alongside the ~40s
happy-case cost the issue already records.

**F3 (LOW) - the durable counter persists after a SUCCESSFUL send, so any future
re-drive or replay inherits a spent ladder.** Unreachable today: `markSending` is
draft-only for broadcasts, and `ALLOWED_PRIOR.queued_pending = []` means a
released relay message can never re-enter the flush set (verified in
`relayQueuedMessages.ts:64,89` and `messagesRepo.ts:122`). The handback's
sub-threshold note mentions the re-drive gap but not the counter-inheritance
consequence. Anyone building a re-drive must reset or key past `fanout_attempt`.

**F4 (LOW) - plan slice 3's third-enqueuer confirmation is absent from the build
record.** The plan said "confirm by reading before relying on it". `slice-3.md`
never mentions `relayQueuedMessages`. The R2 conformance reviewer performed it
and the conclusion HOLDS (recorded at `code-review/r2-conformance.md:51-80`); the
reviewer asked for one line in the handback and the handback does not carry it.
Record-keeping only - I re-verified the fact independently above.

**F5 (LOW) - the handback's gate-2 evidence line mislabels the workspaces.**
"347 passed ... app 2891/2891 among them": the 347-file/6428-test run IS the app
workspace; 183 files / 2891 tests is the dashboard. The gate is green either way
(exit 0), but the sentence would mislead someone auditing the counts.

---

## 5. What I could not verify

- **No suite was executed.** Every green claim above is read from the committed
  code, the committed records, or the gitignored gate logs in this worktree. The
  RED-ON-MAIN claims for closes A/B/C are supported by `s2-red-vitest.log` /
  `s3-red-vitest.log`, which I read; I did not reproduce them.
- The live self-QA (`self-qa.md`) is taken as reported; its screenshot lives in
  the main checkout's `.playwright-mcp/`, which I did not open.
- `scripts/rail-verify.ts`'s opt-in has no automated coverage (script). Verified
  by reading the call site only.
