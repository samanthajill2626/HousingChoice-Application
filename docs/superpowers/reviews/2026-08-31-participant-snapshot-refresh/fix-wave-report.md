# Fix wave 1 - code review round 1 (2026-09-01)

Commit `c895f081` (one commit, both fixes), on top of `d524a263`.
Five files: `app/src/routes/webhooks/twilio.ts`, `app/src/routes/webhooks/voice.ts`,
`app/src/lib/groupTitle.ts`, `app/test/inboundMessagePush.test.ts`,
`app/test/voiceWebhook.test.ts`. Nothing else was touched.

## Fix 1 (C-F1 / A-4) - isDeleted guard on the NAME rung of both labels

TDD. Two RED tests first, run before any source edit:

`cd W:\tmp\participant-snapshot-refresh\app; npx vitest run test/inboundMessagePush.test.ts test/voiceWebhook.test.ts -t "soft-deleted"`

```
 FAIL  test/inboundMessagePush.test.ts > inbound message push - native group text >
   RED: a soft-deleted contact supplies no name - the body prefix falls back to the stored roster name
 AssertionError: expected 'Ana Reyes: hello, looking for a 2 bed' to be 'Old Ana: hello, looking for a 2 bed'
 Expected: "Old Ana: hello, looking for a 2 bed"
 Received: "Ana Reyes: hello, looking for a 2 bed"

 FAIL  test/voiceWebhook.test.ts > inbound masked voice - the bridge (M1.9a) >
   RED: a soft-deleted contact supplies no name - the masked label falls back to the masked stored roster name
 AssertionError: expected 'Robert R.' to be 'Bob B.'
 Expected: "Bob B."
 Received: "Robert R."

 Test Files  2 failed (2)
      Tests  2 failed | 64 skipped (66)
EXIT=1
```

Both fail for the intended reason: the SOFT-DELETED contact's live name wins the
label. No other test in either file changed state.

Change:

- `twilio.ts` `pushSenderLabel` - the live rung is taken only when
  `senderContact !== undefined && !isDeleted(senderContact)`; `isDeleted` added
  to the existing `../../repos/contactsRepo.js` import (that import became a
  multi-line block; no other symbol added or removed).
- `voice.ts` `maskedPartyLabel` - the masked-name rung is
  `(contact !== undefined && !isDeleted(contact) ? contactShortName(contact) : undefined) ?? shortNameFromFull(member?.name)`.
  `isDeleted` was ALREADY imported in `voice.ts` (used by the non-member caller
  identity path), so no import change was needed there.
- The role rungs in `maskedPartyLabel` ('Tenant' / 'Landlord' /
  'the other party') are untouched, per the fix scope.
- Both docblocks now say "NON-DELETED" on the contact rung and name
  `withLiveNames` as the shared rule.

GREEN:

`cd W:\tmp\participant-snapshot-refresh\app; npx vitest run test/inboundMessagePush.test.ts test/voiceWebhook.test.ts test/founderTriage.test.ts test/voiceOutbound.test.ts test/inboxFeed.test.ts`

```
 Test Files  5 passed (5)
      Tests  227 passed (227)
EXIT=0
```

`cd W:\tmp\participant-snapshot-refresh; npm run typecheck` (bare, all five
workspaces) -> `EXIT=0`.

## Fix 2 (A-2) - relayThreadLabel docblock, comment only

`app/src/lib/groupTitle.ts:109-113` no longer claims "so the push title and the
inbox row cannot drift". It now states the contract that holds: the function
renders whatever roster the caller passes and reads no contact; a caller wanting
live names hydrates first (`lib/participantNames`, as `inbox.ts relayRowFor`
does); the push-title call sites in `routes/webhooks/twilio.ts` pass the stored
snapshot by decision (spec "Out": push titles accepted stale).

Comments-only proof - `git diff app/src/lib/groupTitle.ts` before staging, every
changed line inside the `/** ... */` block:

```
- * number -> "Relay group"), extracted from routes/inbox.ts relayRowFor
- * so the push title and the inbox row cannot drift.
+ * number -> "Relay group"), extracted from routes/inbox.ts relayRowFor.
+ *
+ * WHAT IT PROMISES: one PRECEDENCE, not one result. It renders whatever roster
+ * the caller hands it and reads no contact. Since 2026-09-01 a caller that
+ * wants LIVE names hydrates the roster first (lib/participantNames -
+ * routes/inbox.ts relayRowFor does), while the push-title call sites in
+ * routes/webhooks/twilio.ts pass the STORED snapshot by decision (no awaited
+ * read on the webhook ack path; spec "Out": push titles accepted stale). So a
+ * renamed member can read one way in the push title and another in the inbox
+ * row it opens - same chain, different input, deliberately.
```

Two removed lines, ten added, all comment lines; zero code tokens changed. The
`typecheck` above covers the file.

## For the re-reviewer

1. The deletion check is NAME-ONLY, by the fix's scope. A soft-deleted contact
   still supplies its ROLE to `maskedPartyLabel` ('Tenant' / 'Landlord'), and
   still supplies `author` on the persisted call
   (`voice.ts` `authorForContact(callerContact)`) and the group message. Those
   rungs never checked deletion, on this branch or on main; nothing regressed,
   but "a soft-deleted contact supplies no name" is now literally true while
   "supplies nothing" is not.
2. A-2 was fixed at `relayThreadLabel` only, as adjudicated. The same
   hydrated-vs-stored split exists for native group texts
   (`inbox.ts:1205` hydrated vs `twilio.ts` group push title raw), and
   `groupTitle.ts:6-16`'s MODULE header still argues the one-rule case for the
   three surfaces that "disagreed in public". That header is about the rule, not
   the input, so it is not false the way `:113` was - but it is the next place a
   reader would look, and it says nothing about hydration.
3. `pushSenderLabel`'s deleted-contact path now lands on the stored roster name
   and, for a member with no stored name, on the formatted phone - which is the
   pre-flip main behavior for that case, so the guard restores main's outcome
   rather than inventing a third one.
4. The voice RED uses the `seedRelay(world, { participants: [...] })` override
   form with a two-token stored name ('Bob Builder') specifically so the
   fallback proves MASKING (`Bob B.`), not just fallback. The default roster's
   'Bob' would have passed through `shortNameFromFull` unchanged and proved
   less.
5. Not re-run in this wave (unchanged by it and out of the fix-wave scope):
   `npm test`, `npm run smoke`, `npm run e2e`, lint. Gate 5's file list now
   includes the three `app/src` files above.
