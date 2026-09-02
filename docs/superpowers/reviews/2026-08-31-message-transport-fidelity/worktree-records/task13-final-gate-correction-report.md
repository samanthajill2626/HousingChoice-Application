# Task 13 final gate correction report

## Scope

- `app/test/groupGuardrailWiring.test.ts`
- `dashboard/src/routes/contact/Timeline.ticker.test.tsx`

## Red proof

- `npm run test -w @housingchoice/app -- groupGuardrailWiring.test.ts` exited 1 after the normal sandbox run reported Vite temporary-file EPERM; the permitted rerun reached Vitest and failed 1 of 6 tests because `port.classifyGroupMessageTransport is not a function`.
- `npm run test -w @housingchoice/dashboard -- Timeline.ticker.test.tsx` exited 1 after the normal sandbox run reported Vite temporary-file EPERM; the permitted rerun reached Vitest and failed 1 of 25 tests because the inbound Relay fixture armed `setInterval` despite the stale silent-case expectation.

## Change

- The group test fake now implements provider-normalized native Group MMS classification, prepared post, and actual-MMS result, and asserts the prepared boundary input plus persisted versioned transport facts.
- The ticker test now proves an inbound Relay source arms, terminates, updates its collapsed accessible recipient summary, and updates its revealed recipient row. A generic inbound fixture explicitly removes `relay_sender_key` and remains silent.

## Green proof

- `npm run test -w @housingchoice/app -- groupGuardrailWiring.test.ts` exited 0: 1 file, 6 tests passed.
- `npm run test -w @housingchoice/dashboard -- Timeline.ticker.test.tsx` exited 0: 1 file, 26 tests passed.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `npm run typecheck -w @housingchoice/dashboard` exited 0.

## Commit

`c561c2af test: align final transport gate seams`.

## Remaining concern

The separate `broadcastFanOut.test.ts` red baseline remains byte-identical to merged main and is intentionally untouched.
