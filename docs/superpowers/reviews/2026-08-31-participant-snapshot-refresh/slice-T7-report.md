# T7 - push sender label + voice masked party label

Commit: `c96cbe27` feat(push,voice): sender and party labels prefer the contact;
masked label never unmasks (whisper included)

Files: `app/src/lib/voiceMasking.ts` (new `shortNameFromFull`),
`app/src/routes/webhooks/voice.ts` (`maskedPartyLabel` + both docblocks),
`app/src/routes/webhooks/twilio.ts` (`pushSenderLabel` + docblock),
`app/test/voiceMasking.test.ts` (new), `app/test/voiceWebhook.test.ts`,
`app/test/inboundMessagePush.test.ts`.

## RED

`cd app; npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts
test/inboundMessagePush.test.ts -t "RED|shortNameFromFull"` ->
`Test Files  3 failed (3)` / `Tests  4 failed | 2 passed | 59 skipped (65)`.

```
FAIL test/voiceMasking.test.ts > shortNameFromFull > masks a stored full name the way contactShortName masks a contact
TypeError: (0 , shortNameFromFull) is not a function

FAIL test/voiceWebhook.test.ts > RED: call_party_label prefers the CONTACT (masked) over the stored roster name
AssertionError: expected 'Bob' to be 'Robert R.' // Object.is equality

FAIL test/voiceWebhook.test.ts > RED: a stored full name with no contact is masked in the persisted label AND the spoken whisper
AssertionError: expected 'Bob Builder' to be 'Bob B.' // Object.is equality

FAIL test/inboundMessagePush.test.ts > inbound message push - native group text > RED: the body prefix prefers the CONTACT name over a stale roster name
AssertionError: expected 'Old Ana: hello, looking for a 2 bed' to be 'Ana Reyes: hello, looking for a 2 bed'
```

The whisper assertion (`callerLabel=Alice%20A.`) is unreachable at RED - the
persisted-label expectation fails first in the same test - so it is proven only
by the GREEN run. The 2 passing cases the `-t` filter swept in are T5's
pre-existing `RED: GET /api/calls/:callId hands back a roster with resolved
names` plus the 1:1 redelivery case.

## GREEN

`cd app; npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts
test/inboundMessagePush.test.ts test/founderTriage.test.ts
test/voiceOutbound.test.ts test/inboxFeed.test.ts` ->

```
Test Files  6 passed (6)
     Tests  226 passed (226)
EXITCODE=0
```

`npm run typecheck` from the worktree root, bare -> `EXITCODE=0` (all five
workspaces).

Extra suite beyond the plan's five: `test/inboxFeed.test.ts`, found by
`grep -rln "call_party_label|callerLabel|callPartyLabel" app/test` (the only
other test file that names the field). `grep -rln "pushBroadcasts" app/test`
returns only `inboundMessagePush.test.ts` and the harness, so no other suite
exercises `pushSenderLabel` output. Existing pins hold: `'Bob'` single token,
`'Tenant (Jane D.)'`, `'Unknown caller'`, `'Alice: ...'`.

## The group-push test as landed

The plan's third RED test read `world.conversations.get(GROUP_ID)!` before any
post; `beforeEach` seeds no conversations and the webhook mints the group thread
itself, so that read is `undefined`. Landed form (worklist T7, C-1):

1. `signedTwilioPost(app, SMS_PATH, groupParams())` - creates the thread and
   records broadcast [0].
2. Mutate `world.conversations.get(GROUP_ID)!.participants` so the SENDER member
   carries `contactId: 'c-ana', name: 'Old Ana'` (an aged creation-time
   snapshot). The fake `conversations.getById` returns the stored object, so the
   webhook sees the mutation.
3. Push contact `c-ana` (phone SENDER, firstName `Ana`, lastName `Reyes`).
4. Post again with `groupParams({ MessageSid: 'MMgroup0002' })` - a distinct sid,
   because a same-sid redelivery dedupes and emits no push.
5. Assert `world.pushBroadcasts` has length 2 and broadcast [1]'s payload body,
   not `soleMessagePayload` (which asserts exactly one broadcast).

The sender contact reaches `pushSenderLabel` through the roster contactId
(`twilio.ts:1668-1676`, `getById('c-ana', { consistentRead: true })`), which is
the production path. Only `.body` is asserted; the title is out of scope.

## Divergences from the plan

- Third RED test redesigned as above (worklist correction, not a judgment call).
- `call_party_label` is persisted at `voice.ts:1011` (`callPartyLabel:
  calleeLabel`); the plan's `:985-986` is where `calleeLabel` is computed.
- The stale comment at `voice.ts:123-128` was rewritten (worklist C-8); the plan
  did not quote a replacement, so the new text says `maskedPartyLabel` resolves
  the live contact first and masks the stored roster name as the fallback rung.
- `test/inboxFeed.test.ts` added to the GREEN set (grep, step 4).

## Open worries

- The SPOKEN whisper now says "Bob B." where a stored full roster name used to be
  read out verbatim. Spec S4 accepts it and `voiceWebhook.test.ts` pins it, but
  it is the one user-audible behavior change in this slice - worth naming in the
  handback.
- `shortNameFromFull` masks by LAST whitespace token, so a stored three-token
  name ("Ana Maria Reyes") becomes "Ana R.", and a stored name that is really a
  formatted phone would be masked rather than passed through. Neither shape is
  produced by the writers today (roster names are contact display names), and no
  rung above can emit a phone, but a future writer that stores something other
  than "First Last" would be masked oddly rather than rejected.
- `maskedPartyLabel` now prefers the contact even when the contact's name is
  emptier than the stored one; a contact with no name at all falls through to the
  stored snapshot, so no label got shorter than before except by masking.
