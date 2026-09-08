# Fix wave 1 - code review R1's eleven adjudicated items

Implementer record for F1-F11 of
[`code-review-r1-adjudications.md`](./code-review-r1-adjudications.md). Branch
`feat/relay-30003-retry-lineage`, worktree `W:\tmp\relay-30003-retry-lineage`,
base `941c97ae` (the adjudications commit).

Exactly the eleven items, each with a test where the item is behaviour. No
finding outside the fix wave was acted on; no spec decision (D1-D23) moved, and
no STOP condition was hit.

## Commits

| hash | subject |
| --- | --- |
| `3ff90a23` | fix(relay): review R1 - slot_ineligible is WARN, a thrown claim reaches the tail, media-without-store, backoff seam, retry_opted_out |
| `d86b1111` | docs(comments): review R1 - wire-field, presenter-consumer and harness-fake corrections |
| `742d7b8c` | test(e2e): widen the relay retrying window to 10s |
| `17232d34` | docs(issues): file the relay retry stranded-claim window |
| (this file) | docs(records): fix wave 1 report |

Bare `git status` was read before every commit and `.git/MERGE_HEAD` confirmed
absent each time. Explicit paths only, never `git add -A`; nothing amended; no
commit while an e2e run was in flight.

## The eleven items

### F1 - `slot_ineligible` is WARN, not ERROR

- `app/src/routes/webhooks/twilio.ts:405` - `isTerminalRelayLegFailure` keeps
  `slot_ineligible` in the WARN arm beside `claimed`, `already_claimed` and
  `fenced_announcement`. Its docblock gains the fourth load-bearing property
  (three -> four) stating WHY: a slot already reading `delivered` did not end on
  30003 (that is the reordering `ALLOWED_PRIOR` absorbs), and one reading 30007
  ended on 30007 and was logged at its own severity when it did.
- `app/src/routes/webhooks/twilio.ts:333` - the shared-set taxonomy comment's
  RELAY bullet now says WARN covers "a rung is actually claimed OR the leg never
  ended on 30003 at all (slot_ineligible)".
- `research-adjudications.md` S2a - severity sentence amended IN PLACE, one
  sentence, marked "AMENDED by code-review-r1 F1", naming the four WARN
  outcomes.

Tests (`app/test/twilioStatusWebhook.test.ts`):

- `:1345` "keeps a 30003 replayed onto an already-DELIVERED slot at WARN" -
  asserts zero relay ERROR lines, `retryClaim: 'slot_ineligible'` on a WARN
  line, and that the slot still reads `delivered`.
- `:1363` "keeps a 30003 landing on a slot that already reads 30007 at WARN" -
  the same, plus that the stored `errorCode` is still `30007`.

One EXISTING assertion was inverted to match, deliberately:
`app/test/relayRetryClaim.webhook.test.ts` "claims nothing when the slot already
reads a different terminal code" asserted the line at ERROR; it now asserts WARN
plus zero ERROR lines, with a comment pointing at the severity battery.

### F2 - a throw inside the claim must not skip the tail

- `app/src/lib/relayRetryClaim.ts:68` - `RelayRetryClaimOutcome` gains
  `claim_failed`, with a docblock naming the three throwers (the consistent
  read, the roster read behind the leg copy, and `append`'s rethrown condition
  failure) and stating ERROR + its own message.
- `app/src/routes/webhooks/twilio.ts:2914` - the single `claimRelayRetry` call
  site is wrapped in one try/catch. A throw yields `{ outcome: 'claim_failed' }`
  and a separate `log.error` carrying `err` and the log-safe member key, so
  control always reaches the tail. The severity predicate ERRORs it by
  construction (it is not one of the four WARN outcomes): a terminal 30003 with
  no retry running.
- `app/src/routes/webhooks/twilio.ts:2970` - the failure marker takes its own
  message for `claim_failed`, the way `source_unreadable` does.
- `app/test/relayRetryClaim.test.ts:51` - the exhaustive union test moves to
  twelve ("enumerates exactly the twelve claim outcomes"). The `Record` keyed by
  the union is exhaustive in both directions, so the list cannot drift.

Test: `app/test/relayRetryClaim.webhook.test.ts:618` "reaches the tail with
claim_failed when the claim itself throws" - `messages.append` rejects ONCE;
asserts no retry row, `retryClaim: 'claim_failed'` on an ERROR failure line with
its own message and zero WARN failure lines, a separate diagnostic ERROR
carrying the cause and no phone, the EXISTING SSE for the root firing exactly
once, and `flagPlacementAttention` firing exactly once.

### F3 - intention 14's missing halves

- `app/test/twilioStatusWebhook.test.ts:1382` "leaves a native group-text 30003
  receipt unchanged" - a real `createGroupTextThread` + an appended group leg,
  posted as a signed 30003 receipt (the idiom of the file's existing 30005/21610
  group cases). Asserts zero `delivery_failed` ERROR lines, a WARN line for that
  SID, and that it carries neither `relay` nor `retryClaim`. A group leg
  resolves as a MESSAGE, never through a `relaysid#` pointer, so it never enters
  the relay branch at all.
- The delivered-slot half is F1's `:1345`.
- `seedRelayLeg` gained one option (`slot`) so the member's pre-callback slot can
  be seeded; the default is unchanged.

### F4 - media without a store

- `app/src/jobs/relayRetryLeg.ts:469` - the ERROR twin of
  `relayFanOut.ts:1015-1024`, emitted BEFORE the send when the retry row carries
  attachments and no `MediaStore` is configured. Same wording shape
  ("... has media but no MediaStore - resending body only, media dropped"),
  `event: 'relay_retry_leg'` from the shared `base`, IDs and a count only.

Tests (`app/test/relayRetryLeg.test.ts`):

- `:580` "ERRORs when the retry row carries media and no MediaStore is
  configured" - registers with no store (the lazy `createMediaStore()` path),
  asserts the line's `mediaCount`, its message, that the rung STILL sent, and no
  PII. It asserts `createMediaStore()` is undefined as an explicit precondition
  so it fails loudly rather than silently if `MEDIA_BUCKET` ever appears in the
  test env.
- `:602` "logs no media-without-store ERROR when the row carries no media" - the
  negative fence.

### F5 - one backoff resolution for both topologies

- `app/src/jobs/relayRetryLeg.ts:177` - `resolveRelayRetryBackoff(deps?)`,
  exported, implementing `deps?.backoffMs ?? registered ?? lane env override ??
  relayRetryBackoffMs`. The env parse moved here (`Number.parseInt`, then
  `Number.isInteger && > 0`) - byte-equivalent to the parse it replaces.
- Used by BOTH `enqueueRelayRetryLeg` and `registerRelayRetryLegJobHandler`
  (which resolves once and stores the result, so the in-process lane reads the
  env once and rung 1 still gets the lane value).
- The `registeredBackoffMs` docblock is rewritten to state the two topologies
  truthfully: production's app process registers NO handlers yet is exactly
  where every rung is enqueued, so the store is empty at the only call site; the
  hermetic lane and local dev run both in one process.
- `app/src/jobs/registerHandlers.ts:60` - now
  `registerRelayRetryLegJobHandler({ tokenBucket: deps.tokenBucket })`, with the
  comment saying why the parse is NOT here.

Tests (`app/test/relayRetryLeg.test.ts`, the seam describe):

- `:973` "reads the override on the FREE enqueue when nothing registered" -
  production's topology, which no case covered: env set, nothing registered,
  all three rungs take the override.
- `:979` `it.each(['abc','0','-5','','  '])` "ignores the malformed value %j on
  the free enqueue too" - the malformed guard on the same path.
- The nine existing seam cases are unchanged and green, including "falls back to
  60/120/240 with no registration at all" (nothing registered, env unset) and
  "lets an explicit deps.backoffMs win over the registered one".

### F6 - the e2e retrying window

- `scripts/e2e-session.mjs:269` - `E2E_RELAY_RETRY_BACKOFF_MS: '10000'`, with
  the comment rewritten to say that this value IS the observation window for the
  spec's D16 assertion, and re-pointed at `relayRetryLeg.ts` (F5 moved the read).
- `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` - the two comments naming
  3s corrected (the header's "three seconds after the claim" and the poll's
  "(3s)"), the poll comment gaining the "raise the backoff, never weaken the
  assertion" rule. NO assertion, budget or interval changed; assertion 2's 60s
  still stands.

Both runs green, foreground, from the e2e workspace, lane 9 (`9901/9911/9921/
9931`) confirmed free before each run and after the last:

```
run 1  .superpowers/sdd/e2e-fixwave-run1.log
  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:131:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (18.5s)
  ok 2 [chromium] > tests\dashboard-next\relay-open-stop.spec.ts:114:1 > open-path STOP suppresses relay legs; START resumes them (A2P parity) (14.2s)
  2 passed (46.5s)

run 2  .superpowers/sdd/e2e-fixwave-run2.log
  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:131:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (18.5s)
  ok 2 [chromium] > tests\dashboard-next\relay-open-stop.spec.ts:114:1 > open-path STOP suppresses relay legs; START resumes them (A2P parity) (14.2s)
  2 passed (46.1s)
```

(The reporter's `>` is a U+203A in the logs; rendered ASCII here. `2 passed`
because `--grep "relay leg"` also selects `relay-open-stop.spec.ts` - slice H's
divergence 1.) The retry spec moved 11.7s -> 18.5s and the pair 39.5s -> 46.5s,
which is the seven seconds the wider window costs. Zero `[dynamoAdmin]` lines in
either log.

### F7 - a retry row's slot never carries `contact_opted_out`

- `app/src/jobs/relayRetryLeg.ts:581` - on a `suppressed` outcome the job
  re-persists the slot as `{ status: 'failed', errorCode: 'retry_opted_out' }`
  through `closeTerminally` (the transport-aware `persistRelayRecipientResult`).
  The ERROR log is kept and now carries `closeCode: 'retry_opted_out'`, matching
  the file's contract that `closeCode` appears where the JOB wrote a slot. The
  comment states the reason (`contact_opted_out` is filtered out of
  `presentRelayDelivery`'s denominator at `deliveryStatus.ts:408`, so a
  one-member relay group loses its chip entirely) and the ONE bound below.

Test: `app/test/relayRetryLeg.test.ts:766` "re-stamps a suppressed retry leg as
retry_opted_out, never contact_opted_out" - forces `suppressed` through the
suite's existing `legSend.override`, asserts the slot reads `retry_opted_out`
and not `contact_opted_out`, and that the terminal ERROR names the close code.

### F8 - the two lineage fields DO cross the wire

Comment-only, four sites:

- `dashboard/src/api/types.ts:2302` (`Message`) and `:2502`
  (`TimelineMessage`);
- `dashboard/src/routes/conversation/useRelayThread.ts:130`;
- `app/src/repos/messagesRepo.ts:733` - the same claim in the form "four reach
  the wire", now "the dashboard PROJECTS four ... all six reach the browser".

All four now say the true and useful thing: `GET /conversations/:id/messages`
returns the stored row as-is (D11), so both values arrive in the JSON on every
relay thread load; the client simply does not PROJECT them and neither has a
client use. `app/src/lib/relayRetryClaim.ts` was grepped and carries no such
claim - nothing to correct there.

### F9 - the harness fake's media index

- `app/test/helpers/twilioWebhookHarness.ts:1362` - the fake's
  `listMediaPointers` derivation skips rows carrying `relay_retry_of`, with a
  one-line comment pointing at the real `!isRelayRetryRow` guard in
  `messagesRepo.ts`.

`git grep listMediaPointers app/test` finds four other users:
`mediaPointers.integration.test.ts` and `messagesRepoRetryLineage.integration.
test.ts` (real DynamoDB, not the fake) and `scheduledSendSuppression.test.ts` /
`sendMessage.test.ts` (their own `async () => []` stubs). All four were run and
are green; no suite reads the fake's derivation today, which is why this is a
drift guard rather than a fix.

### F10 - over-claimed presenter consumers

Comment-only, two sites in `dashboard/src/routes/contact/deliveryStatus.ts`:

- `:384` (`retryAware`'s default) and `:554` (the shared all-delivered label) -
  both named "the broadcasts routes" as consumers. Corrected: the other consumer
  is the SAME Timeline rendered with `rosterKind='group_text'`; the broadcasts
  routes import `presentDeliveryStatus` (`broadcasts/broadcastFormat.ts:13`) and
  `deliveryReason` (`broadcasts/DeliveryBadge.tsx:7`) only.

Confirmed by grep: `presentRelayDelivery` / `presentLegDelivery` appear outside
`deliveryStatus.ts` only in `Timeline.tsx` (and `Timeline.test.tsx`). Two OTHER
mentions of the broadcasts routes in that file were checked and left alone
because they are true - `:571` (the module is imported by those routes, so it
must stay a leaf) and `:596` (`presentDeliveryStatus`'s other callers).

### F11 - the stranded-claim window, FILED

- CREATE `docs/issues/relay-retry-stranded-claim-window.md` from `_TEMPLATE.md`
  (type bug, severity med, status open, area `app/messaging-relay`, `refs:` the
  claim's `append` (`twilio.ts:2742`), its dedupe return (`:2795`) and its
  enqueue (`:2803`), plus `messagesRepo.ts`'s `dueRow` (`:714`, written at
  `:2342`)). It carries the full interleaving, why no rung 2 is reachable, the
  durable quiet state the surface shows, the asymmetry with D8's deliberately
  recoverable neighbour, why it is filed rather than fixed (spec Sec 9 paragraph
  1 and the closed anchor's scope), the reviewer's `dueRow` fix, and the
  duplicate-send WARNING in its own paragraph.
- `docs/issues/relay-30003-retry-lineage.md` - one line added to the residuals
  paragraph linking the new issue.
- `npm run issues` bare: **exit 0**, "287 open, 176 closed, 463 total". The
  regenerated `INDEX.md` is gitignored and was NOT staged.

## Gates

| gate | after commit 1 | after commit 2 | final (at `17232d34`) |
| --- | --- | --- | --- |
| `npm run typecheck` (bare, worktree root) | **exit 0** | **exit 0** | **exit 0** |
| named app suites | 238 passed (7 files) | 309 passed (11 files) | 238 passed (7 files) |
| named dashboard suites | 160 passed (2 files) | 160 passed (2 files) | - |
| `npx eslint` on the touched files | exit 0, no output | exit 0 (3 pre-existing warnings) | - |
| ASCII on added lines | **0** every file | **0** every file | **0** every file |

Per-file, quoted from the runner (pass glyphs rendered `[ok]` so this file stays
ASCII):

```
 [ok] test/relayFanOut.test.ts (81 tests) 100ms
 [ok] test/relayWebhook.test.ts (27 tests) 311ms
 [ok] test/relayRetryClaim.webhook.test.ts (28 tests) 343ms
 [ok] test/relayRetryClaim.test.ts (5 tests) 4ms
 [ok] test/twilioStatusWebhook.test.ts (50 tests) 643ms
 [ok] test/registerHandlers.test.ts (1 test) 3ms
 [ok] test/relayRetryLeg.test.ts (46 tests) 53ms

 Test Files  7 passed (7)
      Tests  238 passed (238)
```

```
 [ok] src/routes/contact/relayRetryJoin.test.ts (35 tests) 11ms
 [ok] src/routes/contact/deliveryStatus.test.ts (125 tests) 21ms

 Test Files  2 passed (2)
      Tests  160 passed (160)
```

Movement: `twilioStatusWebhook` 47 -> **50** (F1's two, F3's one),
`relayRetryLeg` 37 -> **46** (F4's two, F7's one, F5's six),
`relayRetryClaim.webhook` 27 -> **28** (F2's one). `relayFanOut` 81,
`relayWebhook` 27, `registerHandlers` 1 and both dashboard suites are unmoved -
nothing in this wave is visible to them.

Commit 2's wider run additionally covered the four `listMediaPointers` users for
F9: 309 passed across 11 files.

The eslint warnings after commit 2 are three "Unused eslint-disable directive"
lines in `useRelayThread.ts` at `:331`, `:333` and `:456` - PRE-EXISTING (the
directives exist four times at the merge base `f82c149c`; this wave touched only
a comment block at `:130`), and warnings, not errors. Exit code 0.

`npm test`, `npm run smoke` and the full `npm run e2e` were deliberately NOT
run; the orchestrator owns the battery. `AWS_ACCESS_KEY_ID` was never exported.
No background command or lane is running.

## Divergences, and things for the orchestrator

1. **F7 has one BOUND, and it is in the code comment.** The re-stamp goes
   through the transport-aware path as adjudicated, and that path is
   `applyRecipientSendResult` for a VERSIONED row - which deliberately preserves
   the FIRST terminal error code (`terminalCurrent && statusSame` refuses the
   overwrite, in the real repo and in the fake alike). So where the extraction
   has already written `contact_opted_out` on a versioned slot, the re-stamp is
   a no-op; the fix lands on the LEGACY shape, which is the ordinary one (every
   relay source written before 2026-09-02 is legacy). Closing the versioned half
   would mean either changing `sendOneRelayLeg`'s signature to take the gate's
   answer (the adversarial review's other proposal, and a change to a shared
   fan-out unit) or adding a force-overwrite repo method - both beyond an
   adjudicated LOW. Recorded here rather than silently half-done.
2. **F1 inverted one existing assertion.** `relayRetryClaim.webhook.test.ts`
   "claims nothing when the slot already reads a different terminal code"
   asserted `slot_ineligible` at ERROR. That IS the behaviour F1 reverses, so
   the assertion moved to WARN plus "zero ERROR lines". No other test changed
   meaning.
3. **F7's ERROR line gained `closeCode`.** The adjudication said "keep the ERROR
   log"; the job now writes a slot on that path, and the file's own log contract
   is that `closeCode` appears wherever the JOB wrote one. Leaving it off would
   have made the contract false. The `refused` / `filtered` arms still carry no
   close code, and the existing test asserting that is unchanged and green.
4. **F5 also added a malformed-value `it.each` on the free-enqueue path.** The
   brief named three new cases; the guard now lives in a second place
   (`laneBackoffOverride`), and a positive case without its negative would leave
   the "a stray env var cannot shorten a real ladder" property unproven on the
   path production actually takes.
5. **Run 2 logged the same teardown ERROR slice H recorded**, and it is still
   not this branch's: `relayFanOut: v1 preflight aggregation failed: missing`
   for `relay-open-stop`'s group, after that spec had already passed - a reseed
   racing an in-flight `relay.fanOut`, swallowed by the in-process adapter. It
   did not appear in run 1. Same signature, same spec, same cause as slice H's
   note; not introduced here (nothing in this wave touches the fan-out).
6. **Gate 5's `.mjs` hole applies again.** `npx eslint scripts/e2e-session.mjs`
   exits 0 having checked NOTHING (the flat config has no base JS block). Do not
   read that zero as a lint pass on that file.
7. **Nothing outside F1-F11 was touched.** The reviews' other findings are OPEN
   questions for the human (Q1-Q5) or recorded residuals (A10-A12, A14, C4, C7)
   and were left exactly as adjudicated. No fenced file changed:
   `relayAnnouncements.ts`, `tourReminders.ts`, `retrySend.ts`, `ALLOWED_PRIOR`,
   `stalenessClockMs`, the rollup outbound gate, `flagPlacementAttention`'s body
   and the 1:1 path are all absent from this wave's diff.
