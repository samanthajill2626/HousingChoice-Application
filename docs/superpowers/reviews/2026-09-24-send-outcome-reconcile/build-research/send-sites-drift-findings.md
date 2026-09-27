# Build research R2 (send sites) - live-tree drift findings for Tasks 3, 7, 8, 9

Date: 2026-09-26. Reader: R2 "send sites" (read-only). Plan: revision 4
(`docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md`). Tree: HEAD
1280058f; `git diff --stat a9f411f3 HEAD -- app dashboard fake-twilio e2e scripts`
is empty. Byte-exact quotes for the implementers are in the gitignored
reference `.superpowers/sdd/build-send-sites-reference.md` (sections cited as
REF n). The prior research sweep (`research/plan-send-sites-findings.md`
section D) was re-verified line by line at this HEAD and is extended at the end.

Severity: BLOCKING = the step cannot be executed as written or fails its gate;
FIX = wrong name / anchor / pin / omission the implementer must be told;
NOTE = risk or awareness.

Counts: 4 BLOCKING, 21 FIX, 7 NOTE.

Verified correct (no finding): every sendMessage.ts step anchor (:191, :332,
:361, :431-439 with the refusal at :446, :465-475, :479-519, :523-539) and the
From-number local is `sender` (:464, `from ?? config.businessPhoneNumber`);
`toConversationUpdatedEvent(item: ConversationItem)` (lib/events.ts:89);
`touchLastActivity` returns `Promise<ConversationItem>`; the three new error
classes (plan code verbatim) compile under the repo tsconfig and keep `code` /
`status` as own properties (checked with tsc 5.9.3 and node); no suite outside
sendMessage.test.ts asserts a raw provider/DB error through the 1:1 wrapper, so
Task 3 turns nothing else red. broadcastFanOut.ts anchors (parser :124-143,
handler :218-688, closeBroadcast :287-324, loop :373-622, continuation
:642-683, finalize :723-771, TODO block :609-620, `enqueue` import :88,
snapshot :259, claim :349-364, guard :643-651, continuation payload :661-673);
`errorCodeOf` :176-185, `recordRecipient` :709-716, `resolveContact` :692-700,
`emitBroadcastProgress(events, broadcastId, item)` :167-173; the five fences and
codes (`no_contact` failed :381, `opted_out` :396, `unreachable` :406,
`contact_deleted` :422, `no_consent` :439); the five slot `toEqual` pins
(:324, :359, :432-437, :495, :513) are written by the unchanged wholesale
`setRecipient` and stay green; the `setRecipient` spy (:1075-1109) is correctly
listed as red. relayFanOut.ts anchors (parser :152-186, outcome :1234-1245,
unit :1270-1514, `throw err` :1492, execution :1002-1203, closeRelay
:1081-1110, deps :960-970); claim-after-acquire keeps the token-bucket pin
`[[1],[1]]` (relayFanOut.test.ts:2368) and the close-B pin (:999-1037) green;
`handOff` in `runRelayFanOutExecution` can reach `payload.senderKey` /
`senderNameOverride`. relayRetryLeg.ts anchors (parser :252-263, refuseGate
:487-505, sites :532-558 / :586-606 / :674-692, send :626-654, chain :657-803);
the RSW pins (:557-562, :1232-1241) stay green (both closes precede the claim);
`seedRetryRow` :162, `payloadFor` :263, `runHandler` :267, `slotOf` :277,
`BOB_KEY` :95, `minutesAgo` :106, `drainedBucket` :1201; the transient
re-enqueue pin (:927-930 `toEqual`) holds when the parser omits an absent
`redrive` key. `sendOneRelayLeg` has exactly two callers (relayFanOut.ts:1140,
relayRetryLeg.ts:626), so making `sendAttempts`/`owner` required breaks no
other call. The `false`/`''` object spreads typecheck.

---

## Task 3 (typed sendMessage errors)

**T3-1 FIX - the fixture has NO business number; name the real fixture values.**
`makeFakes` builds `loadConfig({ NODE_ENV: 'test', SEND_BREAKER_MAX_PER_MINUTE: '3', ...overrides.env })`
(app/test/sendMessage.test.ts:382) and `loadConfig(env)` reads only the passed
env (app/src/lib/config.ts:1168), so `sender` is `undefined` and
`facts.sender` is absent. `Fakes` (:41-55) has no `env`, but the OVERRIDES do
(:62). The fake adapter's first SID is `SMfake-1` (:338; providerTs
`2026-06-12T10:00:00.000Z`, status `queued`). There is no exported "live
contact fixture"; the default contact is inline (:80-88) and `participant_phone`
is at :69. Corrected: in the ProviderSendFailedError test pass
`env: { BUSINESS_PHONE_NUMBER: '+15550009999' }` (the file's own idiom, :853-856)
and assert `typed.facts.recipientDigest === recipientDigest('+15550009999', '+15550100001')`
and `typed.facts.sender === '+15550009999'` (or keep the default config and
assert `recipientDigest(undefined, '+15550100001')` with `sender` undefined);
assert `providerSid === 'SMfake-1'`; for "a refusal is NEVER wrapped" use the
file's literal (:777) `contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true }`.
REF 2.

**T3-2 FIX - the Step 3 code needs three type imports the file lacks.**
The blocks declare `let result: SendMessageResult`, `let appended: AppendResult`
and `let touched: ConversationItem | undefined`; sendMessage.ts imports none of
them (:15-45). Corrected: add `type SendMessageResult` to the
`../adapters/messaging.js` import (declared messaging.ts:99), `type AppendResult`
to the `../repos/messagesRepo.js` import (:1259), and `type ConversationItem` to
the `../repos/conversationsRepo.js` import, beside the plan's three imports.

---

## Task 7 (broadcast fan-out)

**T7-1 BLOCKING - a takeover hand-off enqueues IMMEDIATELY; it never reaches `outbound.delayed`.**
`reconcileDelayMs(attemptedAt, 0, now)` is `max(0, attemptedAt + 5000 - now)`,
which is 0 for any record older than 5 s - and a takeover needs one older than
30 s. `enqueue` turns that into `delaySeconds` 0 (app/src/jobs/jobs.ts:112-114),
and the in-process queue dispatches a 0-delay envelope on a macrotask without
recording it (app/src/adapters/scheduler.ts:168-176); with no `send.reconcile`
handler registered, `dispatchJob` throws MalformedJobEnvelopeError (jobs.ts:257-261),
`runDeferred` swallows it and logs ERROR. Tests 5c, 7b and 8 ("ONE reconcile
envelope" by inspecting `outbound.delayed`) cannot pass as written. Fresh
unknowns are fine: tests 1 and 6 see a ~5 s delay (`delaySeconds` 5, the queue
refusal seam fires). Corrected: in every takeover test register a recording
stub before the pass -
`const reconciles: unknown[] = []; defineJobHandler(SEND_RECONCILE_JOB, async (p) => { reconciles.push(p); });`
(import `defineJobHandler` from `../src/jobs/jobs.js`; the file's
`_resetForTests()` in beforeEach/afterEach clears the registry, jobs.ts:346-352)
- then `await outbound.settle()` and assert on `reconciles`. REF 9.

**T7-2 BLOCKING - test 5c "advancing the fake clock" has no clock to advance.**
broadcastFanOut.test.ts uses no `vi.useFakeTimers` / `setSystemTime` /
`configureJobsClock`; the handler reads `Date.now()` / `new Date()` for the
claim's `nowIso` and the gate's `nowMs`, and jobs.ts:60 captures `Date.now` by
reference, so a later fake `Date` would not even reach `enqueue`'s delay.
Corrected: split 5c. (a) First pass: `unknownOn(t-1)` + `handToReconcile`
throws once -> ONE provider call, record still `attempting`, one ERROR with
label `handToReconcile`, and the continuation (`outbound.delayed[0]`) carries
`recipientKeys: ['t-1']`. (b) Drain that continuation with the shift idiom: the
record is still FRESH (milliseconds old), so the claim is `refused` fresh and
the key is carried again - still one provider call. The stale-takeover half is
test 7b (seed the record with `claim(owner, facts, new Date(Date.now() - 31_000).toISOString())`)
plus T7-1's stub.

**T7-3 FIX - `closeBroadcast` must keep using its `code` parameter.**
The plan's cap-close hard-codes `TRANSIENT_CAP_CODE`, but `closeBroadcast` is
also close C with `'enqueue_failed'` (broadcastFanOut.ts:679), pinned by
broadcastFanOut.test.ts:752 (`errorCode` `enqueue_failed`). Corrected:
`closeRecipientIfQueued(payload.broadcastId, key, code, 'failed')`, and for a
`redriven` record `closeRedriven(owner, { outcome: code === ENQUEUE_FAILED_CODE ? 'enqueue_failed' : 'refused', cause: code })`.

**T7-4 FIX - the gate helper and the closures cannot see a narrowed `sendAttempts`.**
`sendAttempts` would be a lazily assigned `let` of `registerBroadcastSendJobHandler`;
a module-level `gateFor(owner, nowMs)` cannot reach it, and inside ANY closure
(`deferSlot`, `brakeIfDue`, `handOff`, a nested `gateFor`) the `??=` narrowing
is lost (TS18048) - the file says so at :265-269 and pins `repo` / `snapshot`
at :270-271 for that reason. Corrected: `gateFor(attempts: SendAttemptsRepo, owner, nowMs)`
(same body, repo as a parameter - Tasks 8 and 9 need that shape too: the relay
unit gets the repo from its args, the loop from `deps`); pin
`const attempts = sendAttempts;` right after the `??=`; inside closures use
`repo`, never the captured `broadcasts`.

**T7-5 FIX - the two existing best-effort writes must stay at ERROR.**
The plan wraps "tokenBucket.acquire(1); milestone; listing-send" each "(WARN)".
The milestone and listing-send catches already log ERROR (:513-516, :534-537)
and broadcastFanOut.test.ts:1068-1071 asserts `atLevel(50)` 'listing-send row
failed'. Corrected: only the NEW acquire wrap logs WARN; keep both existing
catches exactly as they are.

**T7-6 FIX - test scaffolding the sketches omit.**
(a) `const sends: string[] = []` sits at describe scope and is never reset, so
4a's `toHaveLength(3)` counts earlier tests' sends: add a nested
`beforeEach(() => { sends.length = 0; })`. (b) Nest the new describes INSIDE
`describe('broadcast.send (M1.8a)')` (:191): `world`, `logger` and `outbound`
are that describe's `let`s (:192-207). (c) There is no describe-level
`capture`: a test that reads logs uses the file's helper
`const { capture, logger } = capturingLogger();` (:167-170, level info) and
passes it POSITIONALLY: `wireHandler(world, logger, undefined, { BUSINESS_PHONE_NUMBER: '+15550009999' })`
(:120-125; the env reaches both the wrapper and the job). (d) `capture.atLevel(n)`
is an EXACT level match (test/helpers/logCapture.ts:36). REF 4.

**T7-7 FIX - test 3c's setup contradicts the unit block.**
Fence writes go through `guardWrite`, so a throwing fence bump is swallowed
(ERROR, continue) and never reaches the prepare catch. Corrected setup: let a
PREPARE step both make the stored slot terminal and throw, e.g.
`world.conversationsRepo.createOrGetByParticipantPhone = async () => { world.broadcasts.get('bcast-1')!.recipients['t-1'] = { status: 'skipped', errorCode: 'opted_out' }; throw new Error('boom'); };`
(the snapshot's terminal skip already ran; the deferral's `['queued']` prior
then refuses). Expect the slot still `skipped`, t-1 in the continuation, no
throw out of the job.

**T7-8 FIX - `guardWrite(...)` true means "resolved", not "fence won".**
`if (await guardWrite(log, ctx, 'handToReconcile', () => sendAttempts.handToReconcile(owner, ref!))) await handOff(...)`
also hands off when `handToReconcile` RESOLVED `false` (the record was taken
over during a long send; the takeover already enqueued a reconcile for the same
`attemptedAt`). That starts a second chain, and if its enqueue fails it closes
the slot `send_unconfirmed` and the record `unresolved` under a chain that may
be adopting. Corrected, in the unknown arm, the record-phase arm and the
SendAcceptedNotRecordedError arm:
`let handed = false; const wrote = await guardWrite(log, ctx, 'handToReconcile', async () => { handed = await attempts.handToReconcile(owner, ref!, sid); });`
then `wrote && handed` -> `handOff`; `!wrote` -> stranded (deferred, as the
plan says); `wrote && !handed` -> INFO 'hand-off fence lost - the takeover owns
the record', no hand-off, not carried. Tasks 8 and 9 inherit this.

**T7-9 FIX - `closeBroadcast` can still throw out of the job.**
"A gate read that throws is a prepare-phase throw" covers the recipient unit
only; `closeBroadcast` loops outside it, and its per-key gate read and
`closeRecipientIfQueued` (like today's :296-301) throw after the run-once
marker - later keys stay open and `finalize` is skipped. Corrected: wrap each
key's gate + close in try/catch -> ERROR `{ err, broadcastId, recipientKey: safeRecipientKey(key), label: 'capClose' }`,
continue; the one close ERROR line and `finalize` still run.

**T7-10 FIX - dead helpers become NEW lint errors (gate 5).**
Once the classifier replaces `errorCodeOf(err)` (:561), `errorCodeOf`
(:176-185) and `TRANSIENT_CODES` (:110) are unused; `@typescript-eslint/no-unused-vars`
is an error (eslint.config.mjs:32-40) and gate 5 lints touched files.
Corrected: delete both (keep `CARRIER_FILTERED_CODE` / `UNREACHABLE_CODES` only
if the rejected arm still references them).

**T7-11 NOTE - first-pass deferrals are not carried.**
`defer` and `refused & fresh` push only `if (payload.recipientKeys)`. Test 7a
on a FIRST pass therefore sees: no send, slot untouched, NO continuation,
status still `sending` (finalize defers on the queued slot). To observe the
carry, run 7a as a continuation payload.

**T7-12 NOTE - order the terminal skip before the brake check.**
In the pseudo-code the brake check precedes the terminal skip, so after a brake
already-terminal keys are pushed into `recipientKeys` and counted in the
`outage_brake` WARN's `deferred`. Skip terminal keys first (4a still holds).

**T7-13 NOTE - digest destination and sender.**
`createOrGetByParticipantPhone(contact.phone)` matches `participant_phone = :p`
exactly and creates with the same phone (conversationsRepo.ts:1255-1269), so
`contact.phone` equals what sendMessage sends to (sendMessage.ts:355) today;
`conversation.participant_phone ?? contact.phone` is the literal spec-C4 value.
The record's sender equals the wrapper's only because the registrar builds the
wrapper with the job's own `config` (:232-239) and `wireHandler` passes one
config to both (:126-139).

**T7-14 NOTE - names the plan leaves to the implementer.**
`emitBroadcastProgress` takes `events` first and `recordRecipientOutcome`'s
`item` is optional: `if (r.moved && r.item) emitBroadcastProgress(events, payload.broadcastId, r.item)`.
`AdoptDeps` is not defined anywhere in the plan: define and export it from
broadcastFanOut.ts (Task 10 builds it). The `sendReconcile.ts` stub block also
needs `hashRecipientKey`, `RECONCILE_CHECK_DELAYS_MS` and `type SendAttemptOwner`
imports. The header comment is :1-43 (not :1-33). The finalize-log pin
(:368-379) is `toMatchObject`: it is not red without `unconfirmed: 0`. The
retryable arm must not emit (pin :1161-1190 expects one tick).

---

## Task 8 (relay leg and loop)

**T8-1 BLOCKING - test 4's takeover envelope is immediate (as T7-1).**
"takes over a stale attempting one (ONE reconcile envelope, carrying the
continuation)" enqueues at delay 0; relayFanOut.test.ts's queue carries the
capture logger (:209), so the failed dispatch also adds ERROR lines.
Corrected: T7-1's per-test stub handler; assert the stub's payload has
`continuation.senderKey`.

**T8-2 FIX - `closeRelay` must keep using its `code` parameter.**
The plan hard-codes `TRANSIENT_CAP_CODE`; close C passes `'enqueue_failed'`
(relayFanOut.ts:1201), pinned at relayFanOut.test.ts:1074. Corrected:
`closeRelayRecipientIfUnsent(conversationId, tsMsgId, key, { status: 'failed', errorCode: code })`
and the redriven close as T7-3.

**T8-3 FIX - an unlisted red pin: the source-read spy.**
relayFanOut.test.ts:278 spies `listByConversation`, dispatches a payload WITH
`recipientKeys` (:292) and asserts its call order (:297). The plan moves that
read to `listByConversationConsistent` whenever `recipientKeys` is set, so
`invocationCallOrder[0]` is undefined -> red, unless the harness twin delegates
THROUGH the object property. Corrected: either implement the harness twin as
`listByConversationConsistent: (...a) => messagesRepo.listByConversation(...a)`
on the same object (coordinate with Task 6) or re-point this pin at
`listByConversationConsistent`. The versioned re-read `readVersionedSource`
(:1595-1607, eventual `getByTsMsgId`) must switch to `getByTsMsgIdConsistent`
on the same passes.

**T8-4 FIX - test fixtures the sketches get wrong.**
(a) "member 2 of 4": `seedRelay` has THREE members (:64-68) and a legacy
source excludes its sender, leaving two recipients; override `participants`
with five (sender c-alice) or use `seedTeamSource(world, body, fourKeys)` with
`senderKey: TEAM_SENDER_KEY, senderNameOverride: TEAM_SENDER_LABEL` (close A's
shape, :939-963). (b) On a VERSIONED source member 2's slot is not "untouched
except attemptedAt": the unit writes `transportAggregationState: 'attempted'`
before the send (:1425-1427); assert
`toMatchObject({ status: 'queued', attemptedAt, transportAggregationState: 'attempted' })`.
(c) Tests 12 and 13 need media: the main describe's registration (:198-204)
passes no `mediaStore` and the lazy `createMediaStore()` is undefined without
MEDIA_BUCKET, so presign is unreachable there. Put both in the existing
`describe('relay.fanOut media (outbound MMS)')` (:1565), whose registration
passes `mediaStore: world.mediaStore` (:1582) and whose
`seedMediaSource(body, senderKey, media, overrides)` helper seeds media; test 13
makes presign fail once with
`vi.spyOn(world.mediaStore, 'presign').mockRejectedValueOnce(new Error('presign boom'))`
(the claim precedes the presign, :1405-1413). (d) Test 5 must throw the
ADAPTER kill switch, `SmsSendingDisabledError` from
`../src/adapters/messagingErrors.js` (Task 1) - the send wrapper's class of the
same name (sendMessage.ts:91) extends SendRefusedError and takes the refusal
arm. (e) The file registers the handler FOUR times (:198, :1575, :2155, and
the token-bucket describe the plan's test 3 relies on, :2337): every one needs
`sendAttemptsRepo: world.sendAttemptsRepo`, or its lazy default is a REAL
DynamoDB repo.

**T8-5 FIX - an ungated WHOLESALE write can meet an open attempt (invariant).**
The pre-claim deferral (`phase === 'prepare' && ref === undefined`) writes
`persist queued + SEND_RETRYABLE_CODE`; on a LEGACY row that is `markRecipient`
-> `setRecipientDelivery`, a wholesale slot replace (:1667-1679). A pre-claim
throw (suppression read, gate read, acquire, claim) for a member stranded after
a KNOWN send (slot `queued` + sid + sentAt, record `attempting`) erases the sid
and sentAt. The broadcast twin forbids exactly this ("never a blind
setRecipient"). Corrected: on a legacy row write the deferral only when the slot
has no sid (a conditional twin of `closeRelayRecipientIfUnsent` statement 1 with
`queued` + errorCode), or skip the slot write - the member is carried in
`transientRemaining` either way. Versioned rows are safe (child-field writes).

**T8-6 FIX - `closeRelay` can still throw out of the job (as T7-9).**
Wrap each member's gate + close in try/catch -> ERROR with
`safeRecipientKey(key)`, continue; the close ERROR line still runs.

**T8-7 FIX - dead helpers (as T7-10).**
`errorCodeOf` (:1692-1701) and `TRANSIENT_CODES` (:104) become unused; delete
them or gate 5 fails on the touched file.

**T8-8 NOTE - key-only log sites.**
`logSafeMemberKey` takes a MEMBER object (services/relayAnnouncements.ts:157);
`closeRelay` and a hand-off made from it hold only the key string - use
`safeRecipientKey(key)` there (it redacts as `phone#redacted`, the member helper
as `phone-only-member`).

**T8-9 NOTE - the re-drive early-return closes and the preflight residue.**
Close the record FIRST (`closeRedriven`) and write the slot `REDRIVE_REFUSED_CODE`
only when it returned true, or a pass that no longer owns the record closes a
slot another pass may be sending. Four of the early returns are in the HANDLER
(:761-765, :772-778, :779-783, :790-794), before `execution` exists, so the
close needs a `sendAttempts` pin there. The versioned preflight THROWS
(:1540, :1549, :1604, :1634) run before the loop and strand a re-drive pass's
`redriven` record - add them to Task 15's residue list.

---

## Task 9 (relay retry rung)

**T9-1 BLOCKING - the fixed `T0` makes every asserted hand-off immediate.**
The sketches pass `attemptRef: { attemptNo: 1, attemptedAt: T0 }` with
`T0 = '2026-09-26T12:00:00.000Z'`; once the wall clock is past 12:00:05Z on
2026-09-26 (always, in practice) the delay is 0, the envelope is dispatched and
fails (no handler) instead of landing in `outbound.delayed`, and this file's
queue logs that failure into `errorLogs()` (relayRetryLeg.test.ts:229). So
`outbound.delayed ... toEqual([SEND_RECONCILE_JOB])`, `errorLogs() toEqual([])`
and the enqueue-failure test (the refusal seam throws only when
`delaySeconds > 0`) all fail. Corrected: in every test that asserts a hand-off
enqueue use a fresh `const at = new Date().toISOString();` for the attemptRef
(and any seeded record) and assert `attemptedAt: at`; keep `T0` only where no
enqueue is observed (the redrive window / deadline tests). The stale-takeover
test ("taken over into reconcile") is delay 0 by construction: use T7-1's stub.

**T9-2 FIX - every sketch omits `seedRelay(world)` and `register()`.**
Every rung test in the file calls both (e.g. :303-305). Without `register()`
the job has no handler; without `seedRelay` the gate evaluator refuses before
any site under test. The deadline test registers `register({ tokenBucket: await drainedBucket() })`.

**T9-3 FIX - the enqueue-failure test has no record to close.**
"a reconcile enqueue that throws closes the rung unresolved ... record
done/unresolved cause enqueue_failed": `legSend.override` replaces the unit, so
no claim or hand-off happened and `closeFromReconcile` resolves false.
Corrected: drive the REAL unit with an unknown error on the default versioned
row (`world.adapter.sendPreparedMessage = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };`)
plus the delay-selective refusal seam, or seed the record first
(`claim(rungOwner(row), facts, at)` + `handToReconcile(rungOwner(row), { attemptNo: 1, attemptedAt: at })`)
with the same fresh `at` the override returns.

**T9-4 FIX - the transient arm's three closes are ungated (invariant).**
`closeTerminally` at relayRetryLeg.ts:706 (cap), :730 (window reschedule) and
:749 (enqueue failed) write `failed` without the D8 gate. With revision 4's
`deferredByClaim` transient (a FOREIGN open attempt owns the rung record) each
close can overwrite a slot whose attempt may already have sent. Corrected:
route all three through `gateFor(attempts, rungOwner, now)` exactly as
refuseGate (proceed -> the write, plus `closeRedriven` for a redriven record;
defer / skip -> WARN / INFO and return; taken_over -> `handOff`). For the unit's
own retryable the record is `done/retryable` -> proceed, so today's tests are
unchanged.

**T9-5 FIX - `app/test/relayWindowCloseMirror.test.ts` does not exist.**
The mirror test is `dashboard/src/routes/contact/relayWindowCloseMirror.test.ts`;
run from `app/`, the Step 3 vitest filter matches nothing and silently skips
it. Corrected: `cd dashboard; npx vitest run src/routes/contact/relayWindowCloseMirror.test.ts`
(dashboard package.json:11 `"test": "vitest run"`).

**T9-6 FIX - the commit list omits a file Step 2 edits.**
Step 2 deletes "the absent = legacy path branch and its tests' expectations";
any such expectation Task 8 added lives in `app/test/relayFanOut.test.ts`, which
the Task 9 `git add` does not stage. Add it when it changes.

**T9-7 NOTE - new throw points after the run-once marker.**
The gate read at the three sites (:543, :593, :681) throws out of the job like
refuseGate's own writes, the row read (:401), the lineage read (:406), the
conversation read (:532) and the pinned no-pool throw (:567). Name the gate
read in Task 15's pre-claim residue, or wrap it (a throw there must not reach
the `default: never` path - it cannot).

---

## Invariant sweep (re-verified at 1280058f; extends research section D)

Broadcast slot writers in the job after the plan: the five fences -> D8 gate
(`gateFor`), then today's wholesale `setRecipient`; the sent write,
refusal / 30007 / 30005-30006 / rejected / retryable arms, the second-unknown
close and the hand-off enqueue-failure close -> own attempt (after the claim;
deviation 3); `closeBroadcast` -> D8 gate (keep `code`, T7-3; wrap, T7-9); the
pre-claim `deferSlot` -> UNGATED but `recordRecipientOutcome` with `['queued']`
and an empty delta - it can meet a foreign open attempt and only rewrites a bare
`queued` slot, harmless. Outside the job: `markSending` (draft only, before any
attempt), the webhook rollups (routes/webhooks/twilio.ts:3924-3929 `['sent']`,
:3949-3957 `['queued','sent']`, fenced) which match a slot only after a send
wrote `conversationId` + `tsMsgId` and move it forward - they can meet an
`attempting` / `reconciling` record and are harmless (the adoption's
`['queued']` prior then skips); seeds and `buildRecipientsFrom` (create time).

Relay slot writers in the two job files after the plan: suppression arm -> D8
gate; claim-time `attemptedAt`, `attempted` aggregation, every sending-phase
arm, the success record and the second-unknown close -> own attempt; `closeRelay`
-> D8 gate (T8-2, T8-6); refuseGate at three rung sites -> D8 gate; UNGATED and
able to meet an open attempt: the legacy pre-claim deferral (T8-5) and the
rung's three transient-arm `closeTerminally` closes (T9-4); UNGATED and safe:
the versioned preflight (`initializeRecipientDelivery` for absent slots only;
aggregation writes skip `attempted` slots, :1550, :1563-1570). Outside the jobs
(unchanged): status callbacks `updateRecipientDeliveryStatus` /
`setRecipientActualTransport` (forward-only child fields),
`closeRetryLegEnqueueFailed` (claim time, before any rung record exists), the
30003 claim append, team-send / held-send appends (routes/api.ts:1745-1764,
:1823-1853), relay announcements and group-text rows (other owners), the dev
fixture seam (routes/dev.ts:870-1045) and the seeds.

Decision readers added by the plan: `finalize` (any `queued` slot defers),
the two cap-closes (through conditional writes), the gate. The relay
`isTerminal` (:189-191) still treats `undelivered` as open, but a continuation
or re-drive now meets the member's `done/sent` record and the claim refuses, so
no re-send.

Throw points left out of a loop or the job after the plan: broadcast - the
snapshot, unit and up-front / post-loop claim reads after the marker (Sec 9
residue), `closeBroadcast` (T7-9), `finalize`'s read and flip; the recipient
unit is total. Relay fan-out - the handler reads (:761, :786), the preflight
(T8-9), the claims, `closeRelay` (T8-6); the unit is total and the loop gains a
catch. Rung - T9-7's list plus the transient arm's `claimFanoutPass` (:698) and
`closeTerminally` writes; the unit is total.
