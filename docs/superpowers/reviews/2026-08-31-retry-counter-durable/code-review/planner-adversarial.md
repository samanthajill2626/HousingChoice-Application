# Planner adversarial review - feat/retry-counter-durable

Plan-blind. Inputs were `git diff main...HEAD` over `app/src`, `app/scripts`,
`dashboard/src`, `e2e/support`, plus free reading of the whole tree. No spec,
plan, handback, or sibling review under `docs/superpowers/` was opened. No test
suite, e2e run or browser was started.

Severity is by consequence if it ships, not by how new the line is - but each
finding says whether it is a regression or a preserved defect.

---

## 1. HIGH - the group-text carve-out preserves a "will retry" promise that is just as false as the relay one it removes

`dashboard/src/routes/contact/deliveryStatus.ts:596-613` (the
`RELAY_ERROR_CODE_REASONS` docblock) states the reason native group text is
excluded from the 30003 override:

> A group text's 30003 retry is real: the 30005/30006 and 21610 arms of the
> webhook each carry a group_text guard and the 30003 arm carries none, so a
> group-text leg reaches the retry enqueue exactly as a 1:1 does.

Reaching the enqueue is not retrying. Follow the enqueue through:

- `app/src/routes/webhooks/twilio.ts:2567` - `enqueueSendRetry({ providerSid,
  conversationId, attempt })`. Correct: no `group_text` guard on the 30003 arm.
- `app/src/jobs/retrySend.ts:200-207` - the job calls
  `sendMessage({ conversationId, ... })`.
- `app/src/services/sendMessage.ts:292-295`:
  ```ts
  if (conversation.type === 'relay_group') throw new RelaySendNotSupportedError(conversationId);
  if (conversation.type === 'group_text') {
    throw new GroupTextSendNotSupportedError(conversationId);
  }
  ```
  `GroupTextSendNotSupportedError extends SendRefusedError`
  (`sendMessage.ts:179-184`).
- `app/src/jobs/retrySend.ts:217-227` - a `SendRefusedError` is caught, logged
  `'retrySend: send refused - retry chain stopped'`, and the job returns.

`enqueueSendRetry` is the ONLY retry enqueue site in the app
(`grep enqueueSendRetry app/src` returns `retrySend.ts:73` and
`twilio.ts:2567`). So there is no code path that re-sends a native group text
after a 30003. The promise is false on that product too.

The argument is unaffected by whether the classic `/status` callback even
resolves a group-text message row: if it does not, no retry is enqueued at all;
if it does, the retry is refused. Both branches end with nothing being re-sent.

Consequence: the branch's own stated harm - "staff read [will retry] as 'leave
this alone, it is still going'" - is left live on native group texts, and is now
pinned by three new tests that will fail anyone who later fixes it:

- `dashboard/src/routes/contact/Timeline.delivery.test.tsx:509-527`
  ("keeps the retry promise on the SAME leg in a native GROUP TEXT")
- `dashboard/src/routes/contact/deliveryStatus.test.ts:1338-1347`
  ("keeps the retry promise on a native group-text rollup")
- `dashboard/src/routes/contact/deliveryStatus.test.ts:1387-1391`
  ("keeps the retry promise everywhere else - 1:1 and native group text")

The fix is one line - add `group_text` to whatever the flag becomes, or gate the
override on "not a 1:1" - but the wrong justification is now written into the
module docblock, `e2e/support/selectors.md`, and the three tests, which is what
makes this HIGH rather than LOW. Preserved defect, newly documented as correct.

**UNVERIFIED**: whether the classic `/status` route is reached at all for a
`group_text` message row. The `conversation?.type === 'group_text'` guards at
`twilio.ts:2633` and `:2691` imply someone believed it is. The finding does not
depend on the answer.

---

## 2. MEDIUM - the close paths are not fault-tolerant, so the guarantee they exist to provide has a hole in exactly the failure mode they are for

`app/src/jobs/broadcastFanOut.ts:265-302` and
`app/src/jobs/relayFanOut.ts:309-337`. Neither `closeBroadcast` nor `closeRelay`
wraps its per-recipient loop. Every write inside is awaited bare:

```ts
for (const contactKey of recipientKeys) {
  if (isTerminal(snapshot.recipients?.[contactKey]?.status)) continue;
  await recordRecipient(repo, payload.broadcastId, contactKey, { status: 'failed', errorCode: code });
  emitBroadcastProgress(events, payload.broadcastId, await repo.bumpStats(...));
}
log.error({ ... }, 'broadcastFanOut: fan-out closed - remaining recipients marked failed');
await finalize(repo, events, payload.broadcastId, log, audit);
```

A throttle, a 5xx, or a `ProvisionedThroughputExceeded` on the k-th
`setRecipient` / `bumpStats` aborts the loop. The result:

- recipients 1..k-1 are `failed`, k..n are left `queued`;
- the D10 operator ERROR line - the ONE line that names why - is never written,
  because it is after the loop;
- for broadcast, `finalize` never runs, so the row stays `sending` forever;
- for close C specifically, the `cause` (the enqueue error) is carried only on
  that log line, so the reason the continuation could not be scheduled is lost
  entirely;
- the throw propagates out of the handler, SQS redelivers, and the redelivery
  is suppressed by the per-jobId execution marker
  (`broadcastFanOut.ts:224-229`, `relayFanOut.ts:719-724`) - the branch's own
  TODO says so - so nothing recovers it.

This is the stuck-`sending`, stranded-recipient shape the branch exists to
eliminate, reachable through the code that eliminates it. Main's cap branch had
the same unprotected loop, so it is a preserved defect, not a regression - but
the branch promotes that loop to the single shared close primitive for three
call sites per job and documents it as "all three must leave the SAME terminal
shape", which it cannot guarantee.

Minimum fix: `try`/`catch` per recipient (continue on failure, count the
casualties), and emit the D10 line in a `finally`.

---

## 3. MEDIUM - close C reports "Sending could not be scheduled" on a continuation that may actually be queued

`broadcastFanOut.ts:596-616`, `relayFanOut.ts:1069-1091`. The `try` wraps
`await enqueue(...)` and treats ANY throw as "the queue refused". An SDK throw
after SQS accepted the message - a response timeout, a socket reset on the
`SendMessage` reply, a retry-exhausted error on an idempotent-ish send - is
indistinguishable here from a refusal.

When that happens the code marks every deferred recipient terminal `failed` /
`enqueue_failed` and (broadcast) finalizes. The continuation then arrives,
finds every slot terminal, computes `pending`/`transientRemaining` empty, and
silently no-ops.

No double-send - the terminal skip holds, which is the right priority. But the
operator is told, in the copy this branch added, that sending "could not be
scheduled" for recipients whose retry was in fact scheduled and then discarded
by this job's own close. Given the close writes are unconditional
(`setRecipient` with no `allowedPriorStatuses` - `broadcastsRepo.ts:602-639`),
the close also wins any race against the continuation rather than losing it.

New behavior on this branch (close C did not exist on main).

---

## 4. MEDIUM - `closeRelay`'s terminality guard is both dead and, where it is not dead, unsound

`relayFanOut.ts:310-314`:

```ts
// Both call sites pass an already-non-terminal set; re-checked against
// the pass snapshot so a future caller cannot overwrite a settled slot.
if (isTerminal(snapshot.delivery_recipients?.[key]?.status)) continue;
```

Two problems.

(a) It is dead. `pending` (`relayFanOut.ts:892-894`) and `transientRemaining`
are BOTH derived from the same `snapshot`, so the guard cannot fire for either
existing caller. A test asserting "a settled slot is not overwritten" would pass
against an implementation with no guard at all.

(b) The comment's promise is false for the future caller it is written for.
`isTerminal` on this path (`relayFanOut.ts:175-177`) is
`sent | delivered | failed` - `queued` and `undelivered` are NOT terminal. A
successful relay send writes `status: 'queued'` with a real provider SID
whenever the adapter returns `queued`, which is Twilio's normal create response
(`relayFanOut.ts:1013-1018`), and a real carrier 30003 lands as `undelivered`.
Both read as "open" to this guard. Any caller that passes a set not already
filtered by the same snapshot will overwrite a leg that carries a live SID and a
real carrier code with the synthetic `transient_cap` - destroying the only
record of what the carrier actually said.

The broadcast twin is safer only by accident: `isTerminal` there
(`broadcastFanOut.ts:122-126`) includes `sent`, and a successful broadcast send
always writes `sent`.

Either make the guard a live read (`getById` / `getByTsMsgId` inside the loop,
or a conditional `setRecipientDelivery` with `allowedPriorStatuses`), or delete
it and drop the claim.

---

## 5. MEDIUM - `broadcastBackoffMs`'s docblock is now false, and the branch corrected only its twin

`app/src/jobs/relayFanOut.ts:78-84` was rewritten by this branch to say the live
ladder is "5s then 10s ONLY - pass 3 reaches the cap and closes instead of
enqueueing, which leaves the 20s rung unreachable". Correct.

`app/src/jobs/broadcastFanOut.ts:80-83` was left as:

```ts
/** Exponential backoff for the transient-failure continuation: 5s, 10s, 20s. */
export function broadcastBackoffMs(attempt: number): number {
```

But broadcast calls `broadcastBackoffMs(nextAttempt)` where
`nextAttempt = claim.attempt + 1` (`broadcastFanOut.ts:589, 607`), so the only
values ever passed are 2 and 3 - **10s then 20s**. The 5s rung is unreachable,
exactly as the 20s rung is on relay. Two sibling functions with contradictory
docblocks about the same convention is the drift the D7/D11 asymmetry was
already flirting with; leaving one half corrected makes the next reader trust
the wrong one.

Regression in accuracy: on main the same comment was equally wrong, but the
branch establishes the convention of stating the LIVE ladder and then applies it
to one of two sites.

---

## 6. MEDIUM - the binding ladder adds a new way to record a real `rail_failed`

`app/src/services/groupRail.ts:580-592` and `:636-640`. `reReadUntilBound`
issues up to two extra `port.fetchParticipants` calls. A throw from either is
caught (or falls into the repair's catch) and converted to
`recordRailFailure(...)` + `return { status: 'failed', reason }`.

On main those two Twilio calls did not exist, so a 429 / 502 / socket reset at
that instant could not produce a `rail_failed` record. Now it can - and the
change exists specifically to REDUCE false `rail_failed` records (the docblock
cites the 2026-08-13 migration's "2 recorded rail failures"). It trades 81 false
incomplete-roster warnings for a new, smaller class of hard failures, on the
paths that run in bulk (the migration iterates 132 threads; each now makes up to
4 extra Twilio reads).

The D15 reasoning - "a failed re-read is a FAILED READ" - is defensible for the
FIRST read. It is much weaker for a re-read whose only purpose is to improve on
a list we already hold: the pre-ladder behavior (proceed with `participants`,
repair, warn) is strictly available and strictly less destructive than recording
a rail failure. Consider `catch { /* keep the list we have */ }` on the ladder
specifically.

---

## 7. MEDIUM - the two rail-creation products now behave differently, and the untreated one is the path a human watches

`groupRail.ts` (job), `convertGroups.ts:432`, and `rail-verify.ts:201` opt in.
`app/src/services/groupSend.ts:381` and `:425` - the two staff-HTTP paths - do
not, by the docblock's own statement (`groupRail.ts:123-138`).

So a rail created by a staff group send still: reads short of its roster, logs
`group_rail_participants_incomplete`, fires `addParticipants` against members
who are already attached (the "participant already exists" refusals the
docblock counts as harm), and can reach the `group_rail_mb_map_mismatch`
`rail_failed` record - while the same rail created by the background job does
not. Two code paths, one defect, one fix.

The stated reason (the `rail_creating` claim would leak on a throw inside an
HTTP request) is addressed by the ladder's own try/catch at `:581-592`, which is
inside the same claim. Whatever the real blocker is, the asymmetry is now a
standing footgun: "did this rail go through the job or the send?" becomes a
question you must answer before reading a `rail_failed`.

---

## 8. LOW - `awaitBindingPropagation: true` in `rail-verify.ts` is dead configuration by its own comment

`app/scripts/rail-verify.ts:201-206` sets the flag and then explains, in the
same comment, that "every thread this script iterates already carries a rail
sid, so it adopts, and the ladder is skipped on an adopted rail". A flag whose
own comment says it does nothing is a maintenance hazard: the next reader either
deletes it (fine) or concludes the ladder covers the verify path (not fine).
Either drop it or gate the note on the delete-and-recreate branch it actually
serves.

---

## 9. LOW - the close log's `deferred` count overstates

`broadcastFanOut.ts:284` and `relayFanOut.ts:330` log
`deferred: recipientKeys.length` / `memberKeys.length` - the size of the set
PASSED, not the number actually closed. The terminal-guard `continue` above it
is not counted. Today the guard is dead (finding 4), so the numbers agree; the
first caller that passes a mixed set makes the D10 operator line lie about how
many people were failed. Count the closes.

---

## 10. LOW - relay's close leaves the hub message non-terminal while broadcast's finalizes

`relayFanOut.ts:299-303` acknowledges this and points at a filed issue. Worth
recording as a review finding anyway, because the two closes are documented as
leaving "the SAME terminal shape" and they demonstrably do not: after a relay
close A, every leg reads `Failed - Sending gave up after repeated carrier
deferrals` while the message itself still carries `delivery_status: 'queued'`.
A staff member reading the thread sees a message that is simultaneously
un-sent-to-everyone and not failed.

---

## 11. LOW - `enqueue_failed` collides with an existing HTTP error string

`app/src/routes/broadcasts.ts:768` already returns
`res.status(500).json({ error: 'enqueue_failed' })` for a broadcast whose
initial fan-out enqueue failed. The new recipient-slot code reuses the same
token for a different thing (a CONTINUATION enqueue failure, mid-fan-out).
Different namespaces, no functional conflict, but the two are now
indistinguishable to a log/grep search and to anyone writing an alarm on the
string. A distinct token (`continuation_unscheduled`) would cost nothing.

---

## Things checked and found CLEAN

- **No double-send introduced.** Every close writes a terminal slot status, and
  both send loops skip terminal slots before any adapter call
  (`broadcastFanOut.ts:352-353`, `relayFanOut.ts:912-915`). Close C's
  "enqueue may have landed" window (finding 3) resolves to a no-op, not a
  re-send.
- **The claim is atomic and cannot hand two passes the same number.** One
  conditional `ADD` with the cap as the condition
  (`broadcastsRepo.ts:650-679`, `messagesRepo.ts:2789-2833`), aliased name, and
  `UPDATED_NEW` so the recipients map is not shipped back. The
  `capped` / `missing` disambiguation uses a genuinely strongly-consistent
  `GetCommand`. Both files already import `GetCommand` and
  `ConditionalCheckFailedException`.
- **The ladder length is unchanged from main.** Broadcast and relay both still
  run exactly 3 send passes before closing; the enqueued `attempt` values and
  the relay backoff values (`fanOutBackoffMs(claim.attempt)` = 5s, 10s) are
  byte-identical to main's for every reachable chain.
- **The durable counter cannot strand a legitimate second send.** `markSending`
  is conditional on `status = 'draft'` (`broadcastsRepo.ts:564`) and there is no
  reset-to-draft path, so a broadcast is fanned out once; the relay counter is
  keyed on the SOURCE MESSAGE, not the conversation, so a group's next message
  starts a fresh ladder.
- **Only three relay fan-out enqueue sites exist** (`api.ts:1808`,
  `webhooks/twilio.ts:695`, `relayQueuedMessages.ts:93`) and each enqueues one
  chain per source message.
- **`MessagesRepo` / `BroadcastsRepo` gained a required method and every
  implementation was updated.** The only implementors outside the real repos are
  three test fakes (`twilioWebhookHarness.ts:1337, :2758`,
  `scheduledSendSuppression.test.ts:289`, `sendMessage.test.ts:239`), and the
  two live fakes model the real semantics (increment-and-return, refuse at cap
  with the unchanged count, `missing` for an absent item) rather than rubber-
  stamping `claimed` - so the cap tests in the job suites are not vacuous.
- **`rosterKind` defaulting to `'relay'` is safe at every render site.** The
  five `<Timeline>` call sites are `ContactCommsPane` (the contact timeline
  excludes both `relay_group` and `group_text` conversations -
  `contactTimeline.ts:1190`), `ConversationDetail`, `PlacementConversation` and
  `TourConversation` (all relay group threads), and `GroupTextView`, which is the
  one site that passes `rosterKind="group_text"`. No native group text can reach
  the relay default.
- **The relay-pointer early return is real.** `webhooks/twilio.ts:2432-2436`
  returns before the `ErrorCode` switch, so a relay leg's 30003 genuinely
  reaches no retry - the premise of the override is sound even though its
  carve-out is not (finding 1).
- **A broadcast recipient's 30003 really is retried** (it is a 1:1 message with
  `broadcast_id`; `sendMessage` accepts a `tenant_1to1` conversation), so
  `DeliveryBadge`'s no-options call keeping the base copy is correct.
- **Prototype-pollution sweep extended to the new map.** `ownReason` is used for
  `RELAY_ERROR_CODE_REASONS` and the `constructor` / `toString` case is asserted
  with `{ relay: true }` (`deliveryStatus.test.ts:1483`).
- **PII.** The two new ERROR lines carry `broadcastId` / `conversationId` /
  `tsMsgId` / counts / codes only. `err: cause` uses the `err` key, which is
  bound to `serializeLoggedError` (`logSerializers.ts:88-97`) and allowlists
  `instanceof Error` down to type/message/stack/code/status/`$metadata` - the
  axios `config.data` roster leak is structurally unreachable. No phone, name or
  body is logged anywhere in the diff.

## Things NOT checked

- No suites were run (typecheck, unit, e2e, lint) - the planner is running the
  gate battery concurrently and this machine shares one DynamoDB Local
  container.
- The new e2e spec `e2e/tests/.../relay-30003-no-retry-promise.spec.ts` was read
  only as a diff header, not executed.
- Whether Twilio's Conversations service fires the classic `/status` callback
  for a native group-text leg (see finding 1's UNVERIFIED note).
- The `docs/issues/*.md` and `docs/superpowers/**` content, deliberately.
