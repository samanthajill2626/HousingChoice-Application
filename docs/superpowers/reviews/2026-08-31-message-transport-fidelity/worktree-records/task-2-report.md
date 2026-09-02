# Task 2 report - adapter transport intents

## Delivered

- Added the narrow `CarrierMessageSender` contract beside `MessagingAdapter`.
- Added frozen, plain, serializable SMS/MMS intents, late preparation, provider
  execution, normalized actual transport, and one safe Twilio conflict warning.
- Kept `sendMessage` as a compatibility wrapper over classify, prepare, and
  execute. The console provider boundary returns requested transport as actual
  without using Twilio evidence normalization.
- Added the equivalent `GroupMessageSender` contract. The Twilio Conversations
  implementation owns requested and actual Group MMS. An optional returned
  `ChannelMessageSid` can corroborate or warn on conflict but cannot originate
  the actual transport.
- Kept `postGroupMessage` as a compatibility wrapper and preserved existing
  rail scoping, participant behavior, media refusal, error translation, and
  post parameters.

## Test-first proof

Required focused red command:

`npm run test -w @housingchoice/app -- test/messaging.test.ts test/groupConversationsAdapter.test.ts`

- Exit: 1
- Result: 2 files failed; 8 tests failed and 98 passed.
- Expected failures named the absent classify/prepare/execute methods, absent
  actual transport, and absent conflict warning.
- A preceding sandboxed attempt also exited 1 at Vite startup with `EPERM` while
  creating `app/node_modules/.vite-temp`; it was rerun with worktree write
  permission and is not counted as the TDD red proof.

Final focused green command:

`npm run test -w @housingchoice/app -- test/messaging.test.ts test/groupConversationsAdapter.test.ts`

- Exit: 0
- Result: 2 files passed; 106 tests passed and 0 failed.

Required app typecheck:

`npm run typecheck -w @housingchoice/app`

- First implementation run exit: 1. The new local logger spies were cast at
  declaration time and therefore typed as `never`; the correction moved the
  cast to the constructor boundary without changing production behavior.
- Final exit: 0.

## Files changed

- `app/src/adapters/messaging.ts`
- `app/src/adapters/groupConversations.ts`
- `app/test/messaging.test.ts`
- `app/test/groupConversationsAdapter.test.ts`

No adapter fake required a change; the narrow carrier interfaces intentionally
avoid widening voice/media-only `MessagingAdapter` and rail-only
`GroupConversationsPort` fakes.

## Commit

`c6e4cbfb refactor: expose carrier transport intents`

## Concerns

- The console compatibility wrapper retains its established `SMconsole-*`
  provider key because existing callers and tests depend on that return field.
  It does not treat that synthetic key as transport evidence: actual transport
  is assigned directly from the console adapter's immutable request intent.
- No unexpected importer, dependency cycle, or contract mismatch was found.
