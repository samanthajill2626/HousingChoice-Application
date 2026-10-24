# Spec review r3 - reviewer A (adversarial)

Spec at 2f58ebcb (r3), diffed against e6b5a3cb. Repo read-only; nothing run.
Most of r3 checks out against the code. One finding changes what gets built
(R1); the rest are LOW precision fixes. I contest no adjudication.

Checked and correct:

- The worker CAN emit `conversation.updated` and dashboards receive it. The
  worker bus forwards every AppEventMap name to the app's POST /internal/events
  (`app/src/lib/eventBridge.ts:41-60`, `lib/events.ts:5-16`), and
  `conversation.updated` is in the bridged set (`lib/events.ts:332-343`).
- The W4 loop placement is right. The fan-out loop's switch already
  distinguishes `sent` from `sent_unrecorded` (`app/src/jobs/relayFanOut.ts:1554-1590`),
  and the 30003 retry rung reaches `sendOneRelayLeg` from its own caller
  (`jobs/relayRetryLeg.ts:836`), so a stamp in the loop cannot leak into the
  rung.
- W2's share exception is right: the retried row's `broadcast_id` is in hand
  at `routes/api.ts:1885`.
- The W7 gate is right: the intro handler alone knows whether the body is
  operator-edited (`relayFanOut.ts:1090-1098`) and passes `kind: 'relay.intro'`
  (`relayFanOut.ts:1137`).

---

## R1. MEDIUM - The worker's post-loop `conversation.updated` must be built from a FRESH read: two dashboard consumers apply its `unread_count` directly

r3 says a relay post emits "ONE `conversation.updated` for the thread after its
fan-out loop finishes". Three facts the spec does not address:

- The fan-out job has no event bus today. `relayFanOut.ts` contains no `emit`
  (the only `events.emit` near it is in `services/relayAnnouncements.ts:253-257`).
  The spec should name the new dependency.
- The payload is not ID-only. `toConversationUpdatedEvent` builds it from a
  ConversationItem: `last_activity_at`, `unread_count`, `preview`, roster
  (`lib/events.ts:32-70`). Every current emitter passes the `touched` row
  returned by a write (for example `services/sendMessage.ts:723`,
  `services/groupSend.ts:716`).
- Consumers apply `unread_count` IN PLACE, without re-reading:
  `dashboard/src/routes/conversation/ThreadUnreadToggle.tsx:63-73` calls
  `setCount(event.unread_count)`, and
  `dashboard/src/routes/contact/ContactDetail.tsx:422-430` calls
  `setHasUnread(count > 0)`.

A paced relay fan-out runs for seconds. A builder who emits from the
conversation the job read at its start - the obvious object in scope - will,
whenever a member replies during the loop (unread becomes 1), push a stale
`unread_count: 0`. That flips the thread's unread toggle and the contact page's
unread state to "read" for a message nobody has read.

The spec must say: re-read the conversation (consistent `getById`) immediately
before the emit and build the payload from that. Do NOT call
`touchLastActivity`, which would move the inbox row and preview for a send the
API already touched. The bridge's fire-and-forget delivery
(`eventBridge.ts:47-60`) can still reorder against an app-process emit, but
that is the same exposure every existing worker emitter has, not a new one.

## R2. LOW - "`getRecipientDisplaysByIds` already supports" `consistentRead` is false

The public method takes `opts?: { requireComplete?: boolean }` only
(`app/src/repos/contactsRepo.ts:772`), and its implementation forwards only
`projection` and `requireComplete` (`contactsRepo.ts:1369-1373`). The private
`batchGetByIds` does accept both a projection and `consistentRead`
(`contactsRepo.ts:1027-1056`), so the fix is small. But it is an interface
change, plus a pass-through in `FollowUpsDeps` (`services/followUps.ts:76-83`)
and in every test fake of the method. The spec should say "add" rather than
"already supports", so the plan budgets for it.

## R3. LOW - For W5 and W7, "one event per send" needs the order spelled out, because both paths already emit before they stamp

- Group text: `groupSend` already emits `conversation.updated` from `touched`
  after the post (`services/groupSend.ts:703-716`). If the W5 stamps run after
  that emit, the rule produces a second event; if they run before it, the
  existing event serves. Say "stamp before the existing emit; no new event".
- Relay intro: `sendRelayAnnouncement` emits its `conversation.updated` at
  `relayAnnouncements.ts:253`, BEFORE its member loop (`:266-321`). The W7
  stamps land after it, so the intro needs the post-loop event too, which is R1
  again (fresh read). State it, so W7 is not built to rely on the earlier event.

## R4. LOW - The W6 "after the TwiML is sent" assertion needs a deterministic test hook

Awaiting after `sendTwiml(res, vr)` is sound in Express: the helper never
throws, so nothing reaches the error handler after headers are sent. But
supertest resolves when the response ends, so a test that asserts the stamp
right away races the post-response work. The plan should give the handler a
seam to await (or poll the repo with a bound), or the "stamp after TwiML" test
will be intermittent - the failure class this repo already spends effort
removing.

---

## Contested adjudications

None. The round-2 acceptances match the code I checked.

## Terminal assessment

After R1 is specified, I have nothing further that would change what gets
built. R2-R4 are wording and plan-budget fixes.
