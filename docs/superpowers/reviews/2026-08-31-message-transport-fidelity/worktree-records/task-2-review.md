# Task 2 independent review

## Verdict

- Spec compliance: PARTIAL
- Task quality: NEEDS_FIX

## P1 - Group conflict warning leaks a raw `ChannelMessageSid` and omits the requested transport

`app/src/adapters/groupConversations.ts:807-820` writes the complete provider channel SID as
`channelMessageSid` on the conflict warning. It also reports `authoritativeTransport`, but does
not provide the required `requestedTransport`. The Task 2 adapter-warning contract is deliberately
safe: use the normalizer's safe facts (for a SID, only `sidPrefix`) together with the provider SID
and requested transport. The direct Messaging adapter follows that shape at
`app/src/adapters/messaging.ts:730-740`; the Group MMS path does not.

This is reachable whenever a Group MMS post returns a valid `SM...` ChannelMessageSid: the
normalizer observes SMS, the Group MMS rail remains authoritative MMS, and the adapter emits the
warning. The focused empirical test passed on the current code:

`npm run test -w @housingchoice/app -- test/groupConversationsAdapter.test.ts -t "treats ChannelMessageSid only as corroborating or conflicting evidence"`

It passes because `app/test/groupConversationsAdapter.test.ts:399-409` currently requires the raw
full SID on that warning. Replace that assertion with the safe contract: no `channelMessageSid`,
`sidPrefix: 'SM'`, `requestedTransport: 'mms'`, and the existing authoritative/observed values.
That regression fails if the fixed implementation is reverted, because the reverted payload again
contains the raw SID and lacks `requestedTransport`.

## Confirmed areas

- The direct Twilio adapter classifies durable media facts, prepares without reclassification, only
  sends in its execute method, keeps compatibility `sendMessage`, and returns actual only from the
  normalizer.
- Console returns the prepared requested transport directly and does not invoke Twilio normalization.
- The Group MMS result remains authoritative `mms`; `ChannelMessageSid` is used only to corroborate
  or warn on conflict, not to originate the actual result.
- The new narrow interfaces leave existing `MessagingAdapter` and `GroupConversationsPort` fakes
  untouched, so unrelated voice/media and rail-only fakes do not acquire carrier methods.
