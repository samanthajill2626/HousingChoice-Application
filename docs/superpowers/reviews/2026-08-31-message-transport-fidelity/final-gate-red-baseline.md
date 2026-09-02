# Final gate red-baseline record

## Evidence

- Final root `npm test` at `ffa2669c` exited 1. The app workspace had six deterministic `broadcastFanOut.test.ts` failures and one `groupGuardrailWiring.test.ts` fake-port failure. The dashboard workspace independently had one `Timeline.ticker.test.tsx` expectation failure. Dashboard otherwise passed 496 tests; fake Twilio passed 245; fake web passed 111.
- The required clean-key app rerun repeated the six broadcast failures and the group-port failure before later integration suites. Its later three `ResourceNotFoundException` failures are invalid as attribution evidence because an accidentally overlapping clean-key rerun shared and dropped the same local tables. No source was edited while either suite ran.
- `git diff --quiet main...HEAD -- app/test/broadcastFanOut.test.ts app/src/jobs/broadcastFanOut.ts` exited 0, but detached merged `main` at `7be40139` passed the isolated broadcast file 25/25 under its own clean key. The branch changes the `sendMessage` dependency it uses: sends now go through `classifyMessageTransport` and `sendPreparedMessage`, while the broadcast tests still replace only legacy `adapter.sendMessage`. That made their injected provider errors silently bypassed. The regression is feature-owned even though the broadcast files are unchanged.
- `groupSend.ts:398` now correctly calls the Group MMS transport-preparation boundary. `groupGuardrailWiring.test.ts` supplies an `as never` fake with only the old post method, so its runtime failure is a feature-owned test seam.
- The ticker fixture marked inbound also retained `relay_sender_key: 'team'`, making it an inbound Relay source. The new renderer exposes its recipient state in the collapsed accessibility summary and when revealed; it is therefore tickable. The old silent-case expectation is no longer a valid model of that source.

## Adjudication

| Finding | Ruling | Action |
| --- | --- | --- |
| Broadcast fan-out failures | Accept feature-owned test seam | Update only `broadcastFanOut.test.ts` so its injected errors control `sendPreparedMessage`, retaining exact continuation, terminal, and emitted-event assertions. The filed mainline issue is closed as an invalidated attribution record. |
| Group rail test fake omitted the new transport sender methods | Accept | Extend only the fake with provider-normalized native Group MMS intent, prepared post, and actual MMS result. |
| Inbound Relay ticker test classified a Relay source as a generic inbound silent case | Accept | Move it to an explicit inbound-Relay arming proof, preserving a separate generic inbound silent case. |
| Later clean-key missing-table failures | Environmental invalid run | Do not attribute them; rerun only after all overlapping test processes have stopped if they recur. |
