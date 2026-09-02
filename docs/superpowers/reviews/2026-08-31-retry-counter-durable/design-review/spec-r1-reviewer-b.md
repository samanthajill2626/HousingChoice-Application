# Adversarial design review - retry counters and the cap-and-close branch (R1, reviewer B)

Spec under review: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Repo state: `main@5ce9912f` (worktree `W:\tmp\retry-counter-durable`), read-only.
No tests, no e2e, no Playwright were run. Every claim below cites a line I read.

Summary: the invariant in Sec 1 is real and correctly diagnosed. The MECHANISM
chosen to enforce it does not survive contact with the two records it stores
the counter in (F1), and the relay half's headline guarantee is contradicted by
the state machine the spec says it keeps (F2). Both are structural, not
polish. Sec 3.5 additionally asserts a defect that does not exist in the code
(F3).

---

## F1 [BLOCKING] The durable attempt is stored in a slot that four writers overwrite wholesale - the counter is erased every pass

**What is wrong.** Sec 3.1 puts the durable count inside
`broadcasts.recipients.<contactKey>` and
`messages.delivery_recipients.<memberKey>`. Both slots are written by
whole-slot `SET`s that replace the entire map entry with a caller-constructed
object. Those writers run on the SAME passes the claim is supposed to survive,
so the claimed `attempt` is deleted and re-claimed as 1 forever - which is
exactly the frozen counter the branch exists to unfreeze, moved from the
envelope into DynamoDB.

**Evidence.**

- `app/src/repos/messagesRepo.ts:2781` - `setRecipientDelivery` is
  `UpdateExpression: 'SET delivery_recipients.#mk = :d'`, a full slot replace
  with the caller's object.
- `app/src/repos/broadcastsRepo.ts:615` - `setRecipient` is
  `UpdateExpression: 'SET recipients.#ck = :rec'`, likewise.
- `app/src/jobs/relayFanOut.ts:526` - the transient-defer path calls
  `markRecipient(..., { status: 'queued', errorCode: code })` on every deferred
  recipient, on every pass, immediately before the continuation enqueue at
  `:578`. Same shape at `:512` (refusal), `:519` (30007), `:456` (opt-out),
  `:572` (cap).
- `app/src/jobs/broadcastFanOut.ts:451` and `:482`, both via
  `recordRecipient` -> `broadcasts.setRecipient` at `:541`.
- `app/src/routes/webhooks/twilio.ts:2831-2836` and `:2856-2865` -
  `rollIntoBroadcast` does `{ ...slot, ... }` where `slot` was read earlier, in
  some cases after `delay(statusRetryDelayMs)` (`:2805`). That is a
  read-modify-write over a ~2.5s-stale copy: an `attempt` claimed in between is
  silently discarded.
- `app/src/services/relayAnnouncements.ts:333` - a fifth writer of the relay
  slot the spec never names.

**Why the spec missed it.** Sec 4.7 cites "the lesson already encoded in that
method's spec-15.2b comment" and treats it as protection. That comment
(`messagesRepo.ts:2814-2819`) applies ONLY to
`updateRecipientDeliveryStatus`, which was converted to child-field writes.
`setRecipientDelivery` and `broadcastsRepo.setRecipient` were NOT, and they are
the writers on the retry path. The spec quotes the fix for the one method that
is safe and stores the counter under the two that are not.

**Implies.** Either the claim must live outside the slot (a sibling top-level
map, or a dedicated attribute), or `setRecipientDelivery` /
`setRecipient` / `rollIntoBroadcast` must all be converted to child-field
writes first - a change that touches `twilio.ts` outside the `/status` handler
and is therefore against Sec 2's fence. This must be decided before any code is
written. Sec 7 has no test that would catch it: test 4 ("counter survives a
frozen envelope") replays an envelope but the described stub of `enqueue`
means the site never reaches the writers between passes.

---

## F2 [BLOCKING] "A delivered attempt wins permanently" cannot hold under the forward-only machine Sec 4.7 says it keeps

**What is wrong.** Sec 4.7 states two things at once: (a) "Once any attempt
reaches `delivered`, the effective status is `delivered`", and (b) "The
existing forward-only machine (`updateRecipientDeliveryStatus`) continues to
guard the effective status." Under (b), (a) is unreachable.

**Evidence.**

- `app/src/repos/messagesRepo.ts:120-129` - `ALLOWED_PRIOR` is
  `delivered: ['queued', 'sent']`, `sent: ['queued', 'queued_pending']`.
  `undelivered` is a prior for NOTHING.
- `app/src/routes/webhooks/twilio.ts:2360-2366` - the relay 30003 callback path
  runs `updateRecipientDeliveryStatus(..., mapped, ErrorCode)` with `mapped`
  = `undelivered`, so the slot IS `undelivered` at the moment the retry is
  claimed.
- `app/src/repos/messagesRepo.ts:2805-2812` and `:2846` - the guard both
  in-memory and as a `ConditionExpression`; attempt 2's `sent` and `delivered`
  callbacks are both rejected as regressions.
- `docs/issues/relay-30003-retry-lineage.md` states this in its own problem
  section: "the forward-only delivery state machine then prevents that same
  slot from advancing to `delivered`."

**Compounding.** There is no `retrying` member of `DeliveryStatus`
(`messagesRepo.ts:111-117`), so the spec never says what the effective status
IS while a retry is pending - and the issue's desired behavior ("the dashboard
shows the recipient as retrying") plus Sec 8's "a retry was actually claimed
and is pending" both need that state to exist somewhere. Adding a union member
is not free either: `dashboard/src/routes/contact/deliveryStatus.ts:212-222`
switches exhaustively over `DeliveryStatus` with a `never` default, which makes
a new member a dashboard typecheck failure - inside the file Sec 2 fenced to
"the 30003 copy only".

**Implies.** The spec must decide, explicitly, one of: do not write
`undelivered` when a retry is claimed; widen `ALLOWED_PRIOR` for the relay slot
(and say what that does to the 1:1 and native-group readers of the same table);
or derive the effective status from `attempts` and stop routing it through
`updateRecipientDeliveryStatus`. Each has a different blast radius. As written
the builder cannot satisfy Sec 4.7, test 8, E2E test 11, or the issue's AC 5.

---

## F3 [HIGH] `broadcastFanOut`'s cap branch already calls `finalize()` - "the single most user-visible defect in the bundle" does not exist

**What is wrong.** Sec 3.5's table says the broadcast close must "**call
`finalize()`** - today the continuation returns without finalizing", and the
paragraph under it calls that missing call "the single most user-visible defect
in the bundle and a required part of the fix, not a side effect."

**Evidence.** `app/src/jobs/broadcastFanOut.ts:480-494`: the cap branch marks
each remaining recipient `failed`/`transient_cap`, bumps stats, emits progress,
and calls `await finalize(...)` at `:493` before returning. The `return`
WITHOUT finalize is at `:508-509`, on the continuation-pending path, and it is
correct there - a continuation is genuinely pending.

**What the source issue actually says.**
`docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md` describes
`broadcastFanOut.ts:484` as "the continuation returns WITHOUT calling
`finalize()`", meaning the continuation-pending return. The spec has read that
as a hole in the CLOSE branch. The real defect is one line later: the `enqueue`
at `:496` throws and no path reaches `finalize` - which is what the spec's own
test 3 tests.

**Implies.** A builder told this is required will either add a duplicate
`finalize()` to a branch that has one (double `markSent`/`markFailed` + a second
`broadcast.updated` emit) or lose confidence in the rest of the spec. The
sentence must be corrected to name the throwing enqueue, not a missing call.

---

## F4 [HIGH] The durable claim counts enqueues where `payload.attempt` counts passes - the retry budget grows by one

**What is wrong.** Sec 3.1 guarantees the change "does not change effective
retry budget". Its own mechanism does. `payload.attempt` is the number of the
pass currently RUNNING; the durable claim in Sec 3.3 is taken before the
enqueue of the NEXT pass. With the same cap number those are off by one.

**Evidence.**

- `app/src/jobs/broadcastFanOut.ts:79` `MAX_BROADCAST_ATTEMPTS = 3`; `:479-480`
  `nextAttempt = (payload.attempt ?? 1) + 1; if (nextAttempt > MAX)`. Today:
  pass 1 -> pass 2 -> pass 3, cap fires when pass 3 would enqueue pass 4.
  Three send passes per recipient.
- Sec 3.2's condition is `attempt < cap` with `attribute_not_exists` as zero.
  With `cap = 3`: claim 0->1 (enqueue pass 2), 1->2 (enqueue pass 3), 2->3
  (enqueue pass **4**), 3 fails -> capped on pass 4. Four send passes.
- Same arithmetic at `app/src/jobs/relayFanOut.ts:568-570` against
  `MAX_FANOUT_ATTEMPTS`.
- The 1:1 site does NOT have this skew (`twilio.ts:2557`
  `priorAttempt >= MAX_SEND_RETRY_ATTEMPTS` on a count of retries already
  performed), which is why one uniform "cap" reads as safe and is not.

**Implies.** The spec must state the cap value passed at each site, and Sec 7
needs a test that pins the number of provider sends per recipient before and
after. Otherwise every broadcast and relay recipient silently gets a fourth
send against a registered A2P tier.

---

## F5 [HIGH] The "immediate" close turns a transient enqueue blip into permanent recipient failure, reversing a deliberate policy in the same files

**What is wrong.** Sec 3.3's catch runs `close()` on ANY enqueue throw, with no
distinction between "the queue is permanently broken" and "one SendMessage got
a 500". Today those files deliberately let unknown errors escape so SQS
redelivers the whole envelope and the pass is retried.

**Evidence.**

- `app/src/jobs/broadcastFanOut.ts:456-459` - "Unknown error: leave the
  recipient queued and let the job FAIL so SQS redelivers the whole envelope".
- `app/src/jobs/relayFanOut.ts:531-534` - the identical ruling for relay.
- Sec 3.3's close for broadcast is "mark remaining recipients
  `failed`/`transient_cap`, bump stats, emit progress, and call `finalize()`" -
  terminal. Nothing re-sends after that.

**Also.** Sec 3.3 presents guarantee 1 (structural) and guarantee 2 (immediate)
as "two independent guarantees, deliberately kept both". Guarantee 2 swallows
the throw, so the handler returns normally, SQS deletes the message, and there
IS no redelivery for guarantee 1 to act on. Guarantee 1 is only reachable when
`close()` itself throws or the process dies mid-claim. That is worth keeping,
but it is not the second of two live paths the prose implies, and Sec 7 test 2
exercises only guarantee 2.

**Implies.** Decide whether the enqueue failure is retried at all (e.g. one
in-place retry before closing), and say so. As written, a one-second queue blip
during a 600-recipient broadcast permanently fails every deferred recipient and
stamps the broadcast terminal.

---

## F6 [HIGH] The 1:1 site is in scope with no claim surface, and its existing counter already spans multiple message rows

**What is wrong.** Sec 2 puts `jobs/retrySend.ts` in scope ("the 1:1 chain,
claim-before-enqueue") and Sec 3.5 gives it a close. Sec 3.2 defines the
primitive only "at both repos" - `messagesRepo` (the relay slot) and
`broadcastsRepo` (the recipient slot) - and its signature is
`claimRecipientAttempt(<keys>, memberKey, cap)`. A 1:1 message has no member
key and no per-recipient slot. The spec never says what record the 1:1 claim
writes to.

**Evidence, and why the naive answer is wrong.**

- `app/src/routes/webhooks/twilio.ts:2556` - the 1:1 cap already reads a
  DURABLE value: `message.retry_attempt`. Sec 1's blanket claim that "every
  capped retry loop... advances its attempt counter by writing `attempt + 1`
  into the envelope" is false here; the envelope value is a courier, and the
  cap decision reads DynamoDB.
- `app/src/jobs/retrySend.ts:226-229` - the counter is stamped by
  `annotateMessage` onto the **new** message the retry creates, not onto the
  original.
- Therefore the chain spans N message rows with N provider SIDs, and each
  callback resolves to the row for ITS OWN SID (`twilio.ts:2408`). A claim
  taken on one row is invisible to the next callback unless it is carried
  forward onto the new row - which is precisely what `annotateMessage` does
  today and what a "claim before enqueue" would have to replicate anyway.
- `app/src/jobs/retrySend.ts:66-68` - `parseRetrySendPayload` THROWS when
  `attempt > MAX_SEND_RETRY_ATTEMPTS`. That is a reader making a cap decision
  from the envelope, contradicting Sec 3.3's "the envelope's `attempt`... never
  for the cap decision". It must be reconciled explicitly, not left to a
  builder to notice.

**Implies.** Either drop the 1:1 site (its counter is already durable and its
close - Sec 3.5, "leave the message terminally undelivered" - is already the
current behavior when `enqueueSendRetry` fails), or specify the record, the key
and how the claim survives the row hop. Right now the section names a file with
no design behind it.

---

## F7 [HIGH] The "context-aware 30003" needs a signal that is not on the wire, and cannot be produced inside the one dashboard file Sec 2 allows

**What is wrong.** Sec 8 calls the dashboard change "the only dashboard change"
and scopes it to `dashboard/src/routes/contact/deliveryStatus.ts`. The change
requires knowing "a retry was actually claimed and is pending". That fact does
not reach the browser.

**Evidence.**

- `dashboard/src/routes/contact/deliveryStatus.ts:543-550` - `ERROR_CODE_REASONS`
  is a plain code->string map; `:628-641` `deliveryReason(errorCode, opts)` is a
  pure function of the code plus a `media` boolean.
- Six call sites, none of which have retry state in hand:
  `deliveryStatus.ts:416`, `Timeline.tsx:582`, `:849`, `:1045`, `:1390`,
  `routes/broadcasts/DeliveryBadge.tsx:31`.
- `app/src/routes/contactTimeline.ts:164` and `:424` serialize `retry_of` and
  NOT `retry_attempt`; `dashboard/src/api/types.ts:2325` has `retry_of` only.
  There is no wire field saying a retry is pending, for 1:1 or relay.

**Implies.** Delivering Sec 8 means changing a server route (`contactTimeline.ts`
- not in Sec 2's scope list), the dashboard wire types, and the signature of a
function with six call sites spanning relay bubbles, 1:1 bubbles and the
broadcast badge. That is either scope Sec 2 must admit, or it belongs to
`T-DELIVERY-CHIPS` with the rest. It cannot be "the chip stops lying" inside
one file.

---

## F8 [HIGH] Sec 5.2 and Sec 5.3 give opposite answers for the member the create never refused

**What is wrong.** 5.2: "**Repair** is entered only for members the create
actually refused" and "Members still unbound after the ladder are logged at a
level that does not feed the error alarm" - i.e. the rail proceeds. 5.3: "A
rail that is still short after the ladder and after repair is still a failure."
For a member absent from `failures` who is still unbound after the ladder,
repair is never entered, so the two rules cannot both be applied. One says
proceed and log quietly; the other says record `rail_failed`.

**Evidence and what it costs either way.**

- `app/src/services/groupRail.ts:517-550` - repair is entered on
  `missing.length > 0` today, unconditionally; `:552-560` records `rail_failed`
  when the map is still short after it.
- `:503-507` - the stored map is `buildParticipantMap(participants)`, and
  `:224-231` builds it ONLY from participants with a non-empty `address`. A
  member whose binding has not propagated is not merely "unverified", it is
  ABSENT FROM THE STORED MAP.
- If the branch proceeds with a short map, the rail is finalized and
  `hasActiveGroupRail` reports true for a rail whose receipts for that member
  cannot be attributed - `app/src/services/groupReceipts.ts:376-388` drops them
  as `group_receipt_unknown_participant`. That is the same class of hazard the
  empty-roster guard at `groupRail.ts:303-315` was added to prevent, and it is
  a live cost 5.3 asserts away rather than resolves.
- Nothing in the spec re-reads the map after finalize, so a short map stored
  once is short permanently.

**Implies.** 5.2 and 5.3 must be reconciled in the spec, with the answer stated
for the exact case (create did not refuse, ladder exhausted, still unbound), and
with what gets STORED in the participant map in that case.

---

## F9 [HIGH] E2E test 11 has no time seam - it must wait more than 60 seconds

**What is wrong.** Sec 7 test 11 requires driving a relay leg through
30003 -> retry -> delivered in a hermetic Playwright run. Sec 4.6 fixes the
relay backoff at 60s/120s/240s "identical to the 1:1 policy". The first retry
therefore lands no sooner than 60s after the failing callback.

**Evidence.**

- `app/src/jobs/retrySend.ts:40-42` - `retryBackoffMs` is a module function
  over a hard-coded `60_000`; no dependency, env var or test seam.
- `app/src/jobs/jobs.ts:112-124` - `runAt` becomes real SQS `DelaySeconds`;
  the wait is wall-clock in the hermetic lane too.
- No existing e2e or app test drives `messaging.retrySend` end to end (grep for
  `RETRY_SEND_JOB` / `retryBackoffMs` across `e2e/` and `app/src` outside
  `jobs/retrySend.ts` returns nothing), so there is no precedent to copy.
- AGENTS.md and `docs/issues/` record scenario specs already blowing a 30s
  budget; a >60s in-test wait is not viable.
- The outcome flip itself IS available: `fake-twilio/src/routes/control.ts:79`
  (`POST /control/delivery-outcome` -> `engine.setDeliveryOutcome`) plus the
  `kind: 'fail'` + `failState`/`errorCode` profile at
  `fake-twilio/src/engine/types.ts:21-28`. Only the clock is missing.

**Implies.** The spec must name a seam (an injectable backoff on the relay
retry job, or a test-only override) or the acceptance test the source issue
requires (AC 9) cannot be written. Discovering this during the build is a
mid-branch scope change.

---

## F10 [MEDIUM] `attempts` is an indexed list but the writes are specified as nested child-field updates, which cannot create an element

**What is wrong.** Sec 4.2 models `attempts` as a JSON array; Sec 4.7 says
"Attempt-scoped writes are child-field writes under `attempts`". A DynamoDB
`SET attempts[i].#st = :v` is a validation error when element `i` does not
exist; the element can only be created by an append, and it can only carry its
`sid` after the provider send returns.

**Evidence.** Sec 9 already names the analogous race for the pointer:
"`putRelaySidPointer` is written AFTER the provider send returns, so a fast
callback can outrun it", and `app/src/jobs/relayFanOut.ts:543-548` shows the
order (send -> `markRecipient` -> `putRelaySidPointer`). The attempt ELEMENT has
exactly the same window and is not mentioned. The `/status` single-retry lookup
(`twilio.ts:2415-2432`) covers the POINTER only; it does not wait for a list
element.

**Implies.** A callback for attempt N arriving inside that window has nowhere to
write. Keying `attempts` as a map by `n` (`attempts.#n`) rather than a list
would let a single `SET` create and update the same path and would remove the
index bookkeeping; whichever is chosen, the spec must state the write shape and
the ordering.

---

## F11 [MEDIUM] The relaysid pointer gains `n` with no read-compat rule, while Sec 3.4 forbids a backfill

**What is wrong.** Sec 4.2: "Each `relaysid` pointer gains the attempt number
`n`, so a callback resolves to `(conversationId, tsMsgId, memberKey, n)`."
Sec 3.4 grants read-compat to the slot's missing `attempt` and to in-flight
envelopes, and says "No backfill migration". It says nothing about pointers
already written.

**Evidence.** `app/src/repos/messagesRepo.ts:2889-2903` writes the pointer with
exactly three ref fields; `:2913` reads them back;
`app/src/routes/webhooks/twilio.ts:2353-2357` types the handler's `ptr` as the
same three. Every pointer in every dev, hermetic and prod table today lacks
`n`, and pointers are written per leg per relay message.

**Implies.** State the rule (absent `n` means attempt 1, or means "effective
status only, no attempt write") or the first callback after deploy for any
pre-existing relay leg has undefined behavior.

---

## F12 [MEDIUM] The `missing` outcome is decided by a follow-up read, and `missing` skips the close

**What is wrong.** Sec 3.2 disambiguates a `ConditionalCheckFailedException`
"by a follow-up read into `capped` vs `missing`". Sec 3.3 maps `missing` to
"log; return" and only `capped` to `close()`. A DynamoDB read is eventually
consistent unless `ConsistentRead` is set, and the spec does not set it.

**Implies.** A stale read of a genuinely capped slot yields `missing`, the
handler logs and returns, and nothing closes - reinstating the non-terminal
state the whole branch exists to eliminate, on the exact path the branch is
supposed to make bulletproof. The spec must require a consistent read, or use
`ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` on the conditional update and
never take the second round trip at all.

---

## F13 [MEDIUM] `relay.retrySend` is a new outbound-SMS job that the spec never registers or meters

**What is wrong.** Sec 2 introduces `app/src/jobs/relayRetrySend.ts` as a new
job. Nothing in the spec names the registration site or the A2P token bucket.

**Evidence.** `app/src/jobs/registerHandlers.ts:1-14` is the single source of
truth for handler registration in BOTH entrypoints, and its docblock records a
production incident caused by registering a job in the worker and missing it in
the app's in-process path. `:31-44` documents the metering ruling per job: every
SMS-sending handler draws the shared `tokenBucket` "so the COMBINED outbound
rate stays under the registered A2P tier", with `retrySend` a deliberate,
reasoned exception. `relayFanOut` and `broadcastFanOut` both take it
(`:47-49`).

**Implies.** Add `registerHandlers.ts` to Sec 2's scope and make the metering
call explicitly. An unregistered handler fails every relay retry locally with
"no handler registered" and passes every unit test that registers the handler
directly.

---

## F14 [MEDIUM] An `undelivered` relay leg is not terminal to the fan-out, so a redelivered fan-out envelope can double-send the member a retry is already in flight for

**What is wrong.** Sec 4.8's matrix covers duplicate callbacks, duplicate
deliveries of `relay.retrySend`, concurrent callbacks, out-of-order callbacks,
and other members. It does not cover the fan-out re-sending the SAME member.

**Evidence.** `app/src/jobs/relayFanOut.ts:158-160` - `isTerminal` is
`sent | delivered | failed`; `undelivered` is NOT terminal. `:445-448` - the
resume guard skips only terminal slots, so a redelivered fan-out envelope (SQS
at-least-once, or a continuation carrying that key) re-sends to a member sitting
at `undelivered`. Sec 4.3's duplicate guard is
`putJobExecutionMarker(jobId, ...)`, which is per-jobId and cannot span two
different job types.

**Implies.** Adding a second independent sender for `undelivered` slots without
a shared claim makes double-sends reachable. Either the claim must gate the
fan-out's re-send too, or `undelivered` must become terminal to the fan-out once
a retry is claimed. Note that changing `isTerminal` also changes behavior for
legs with no retry, so it needs its own decision.

---

## F15 [MEDIUM] Sec 8's message-catalog sentence contradicts the documented convention of the file it edits

**What is wrong.** Sec 8 closes: "New operator-facing copy goes through the
message catalog per the repo rule." The file it is editing documents the
opposite for exactly this copy.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:604-608`: "This is
STAFF-FACING dashboard copy, so it lives here beside `ERROR_CODE_REASONS`
rather than in the app's message catalog (which is the single source for
automated MEMBER-facing copy)." The dashboard is a separate workspace and does
not import the app catalog. AGENTS.md's rule is scoped to "new automated
user-facing copy", i.e. what gets TEXTED.

**Also.** Sec 4.4 says a refusal "writes truthful operator-facing copy onto the
row". `RelayRecipientDelivery` (`app/src/repos/messagesRepo.ts:142-149`) has no
copy field, and copy is presenter-owned per the above. What actually goes on the
row is an error code; the spec should say which one, and Sec 8 owns its string.

**Implies.** As written, a builder puts the 30003 chip string in the app catalog
where the dashboard cannot reach it, or invents a copy field on the delivery
slot.

---

## F16 [MEDIUM] The rail re-read ladder adds unbounded latency to a staff HTTP send

**What is wrong.** Sec 5.2 specifies "re-read participants after a short delay,
at most 2 bounded retries" without naming the delay, the total budget, or which
callers pay it.

**Evidence.** `ensureGroupRail` is called inline on the send path at
`app/src/services/groupSend.ts:381` and `:425`, not only from the job
(`app/src/jobs/groupRail.ts:59`) and the importer
(`app/src/lib/import/convertGroups.ts:598`). The first send after a group is
created runs the create branch, so it is the request that pays the ladder.

**Implies.** State the per-retry delay and the total added latency, and say
whether the send path takes the ladder or short-circuits. "A short delay" is not
buildable and not reviewable.

---

## F17 [MEDIUM] The new rail authority is vacuous on the dominant create path, and safe only because of a premise the spec never states

**What is wrong.** Sec 5.2 makes the create's per-member `failures` the
authority: "Members absent from `failures` are attached." On the bulk create
path `failures` is a hard-coded empty array, so it carries no per-member
information at all, and the rule degenerates to "everyone is attached, always" -
which also means "repair is never entered".

**Evidence.** `app/src/adapters/groupConversations.ts:486` returns
`failures: []` unconditionally on the `ConversationWithParticipants` success
path. Only `createWithIndividualAdds` returns real refusals (`:539-541` via
`attach` at `:545-570`). The bulk path is safe today ONLY because it is
documented all-or-nothing (`:503-506`: "the bulk create is all-or-nothing: ONE
rail-ineligible member fails the whole request with no per-member detail"),
after which it falls back to individual adds.

**Implies.** The spec is resting the repair decision on an unstated Twilio
property. State it, and state what happens if the bulk create ever returns
partial success - because in that world Sec 5.2 silently disables the repair
path that `groupRail.ts:509-516` documents was added to stop threads being
stranded permanently.

---

## F18 [MEDIUM] Sec 6's audit is unbounded and its disposition rule collides with Sec 2's fences

**What is wrong.** Sec 6 commits the branch to "a read-only audit over every
provider-status branch in `app/src` (messaging, voice, media, email, group
conversations, job dispatch)" - an open-ended sweep inside a spec with a closed
test list and a fixed set of anchor files - then says "Findings inside M5's
anchor files are fixed here" without defining "anchor files".

**Evidence.** Sec 2 admits `twilio.ts` for the `/status` handler ONLY and
fences `tourReminders.ts` to another branch. A provider-status finding in
`twilio.ts:1223` (the structural no-retry branch) or in `tourReminders.ts` would
be "inside an anchor file" by filename and outside scope by fence. The two
sentences give different answers.

**Implies.** Define the disposition by the Sec 2 fences (in-scope REGION, not
file) and put a bound on the audit - a named file list, or a time box - so it
cannot expand the branch after the plan is written.

---

## F19 [LOW] Sec 3.1's slot sketches are incomplete, and the writers are whole-slot

**What is wrong.** Sec 3.1 shows
`broadcasts.recipients.<contactKey> = { status, errorCode, attempt? }`. The real
record carries more, all of it load-bearing.

**Evidence.** `app/src/repos/broadcastsRepo.ts:117-137` -
`BroadcastRecipient` also has `conversationId`, `tsMsgId` (the delivery-callback
rollup target) and `carrierSentAt` (the "Sending..." vs "Sent" discriminator).

**Implies.** Combined with F1's whole-slot writers, a builder reconstructing a
slot from the spec's sketch drops the rollup keys. Show the real interface or
cite it.

---

## F20 [LOW] The `attempts` lineage ships to the browser uninspected while Sec 8 fences the dashboard from rendering it

**Evidence.** `app/src/routes/contactTimeline.ts:425` forwards whole
`delivery_recipients` slots to the client verbatim;
`dashboard/src/api/types.ts:2145` and `:2353` type them. Adding `attempts`
(up to 3 records per member per message, each with a provider SID and two
timestamps) puts that on every relay bubble's payload, for a UI that Sec 8
explicitly defers to `T-DELIVERY-CHIPS`.

**Implies.** Either strip `attempts` at the route boundary until the chips work
lands, or state that it ships now and is unused. Say which.

---

## F21 [LOW] `ReturnValues: 'UPDATED_NEW'` on a nested path returns the enclosing top-level map

**What is wrong.** Sec 3.2 specifies `ReturnValues: 'UPDATED_NEW'` on a
conditional `ADD` to `recipients.<contactKey>.attempt`. DynamoDB returns updated
attributes at the TOP level, so the response carries the whole `recipients` map
- hundreds of slots on a large broadcast - on every claim.

**Status: UNVERIFIED.** I did not run DynamoDB Local (read-only mission). The
nested-`ADD` mechanism itself IS proven in-repo - `broadcastsRepo.ts:632-671`
does `ADD stats.#sk :v` with `ReturnValues: 'ALL_NEW'` - so the ADD is fine; only
the return-payload size is open.

**Implies.** Pin the actual response shape before writing the primitive, and
return just the number (from a targeted read, or by returning `ALL_NEW` only
where the caller needs it).

---

## F22 [LOW] Sec 10 says "no post-merge obligations" while Sec 6 promises a new issue and Sec 4.2 changes a stored contract

**Evidence.** Sec 6: "Findings outside them are **filed as a new issue** with
`file:line` citations" - that is an obligation. Sec 4.2 adds `n` to the relaysid
pointer, a change to already-persisted records (see F11), which Sec 10's "no
schema migration (new attributes are optional and read-compatible)" covers only
if F11's compat rule is written down.

**Implies.** Sec 10 should list the issue filing and, once F11 is answered, say
so explicitly rather than asserting nothing is owed.

---

## Verified-correct claims (no finding)

Recorded so a later round does not re-litigate them:

- Sec 4.1: the relay pointer branch does return before the generic 30003 branch
  - `app/src/routes/webhooks/twilio.ts:2433-2437`, generic branch at `:2552`.
- Sec 4.1: the 1:1 retry creates a new provider SID and a new persisted message
  row - `app/src/jobs/retrySend.ts:200-207`, `:226-229`.
- Sec 4.6: the 1:1 policy is 60/120/240 with cap 3 -
  `app/src/jobs/retrySend.ts:37-42`, `twilio.ts:2557`.
- Sec 5.1: `buildParticipantMap` skips participants with an empty `address` -
  `app/src/services/groupRail.ts:224-231`; `missingFromMap` at `:264-267`.
- Sec 5.1: `createConversationWithParticipants` returns per-member `failures`
  and `ensureGroupRail` already reads them - `groupRail.ts:456-463`.
- Sec 6: a literal grep for `!== 'success'` across `app/src` returns zero hits
  (verified). `voiceTranscript.ts:271-276` models the correct terminal-default
  shape.
- Sec 8: `ERROR_CODE_REASONS['30003']` is the unconditional
  `'Phone unreachable - will retry'` - `deliveryStatus.ts:544` - and
  `deliveryReason` already appends `(error <code>)` at `:638-640`, so "the final
  error code stays exposed" needs no work.
- Sec 3.2: an atomic conditional `ADD` on a nested numeric attribute is proven
  in-repo - `broadcastsRepo.ts:632-671`.
