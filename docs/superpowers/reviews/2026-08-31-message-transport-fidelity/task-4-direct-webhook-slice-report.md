# Task 4 direct and webhook slice report

## Shipped contract

Direct sends now classify immutable requested transport before preparation and
execution, then append schema version 1 with the request and only provider-returned
actual evidence. Authenticated inbound rows append schema version 1 and normalized
actual evidence only. Direct and relay status callbacks resolve stored requests
before normalization, keep status and actual writes independent, and emit one SSE
event when either changed state.

The native-group inbound route now consumes the adapter-owned Group MMS authority;
generic webhook code no longer declares the rail fact itself.

## Commits

- `eea8a4fe feat: record transport on direct message flows`
- `25171778 fix: source native group transport from adapter`

## Focused proof

Task 4 demonstrated red 5/28 for direct changes and full red 14/211 across the
five required files, then green 225/225 using the required focused command.
The compatibility fake suite passed 23/23; app workspace typecheck and focused
ESLint exited 0. The native-group authority fix demonstrated red `1 failed | 61
passed`, then `test/groupTextWebhook.test.ts` green 62/62 and app typecheck exit
0. Initial sandbox Vite `.vite-temp` EPERM runs were pre-execution environment
failures; allowed-environment reruns produced test evidence.

## Review and resolution

The independent implementation review accepted P1: native-group inbound had a
factually correct but architecturally misplaced literal MMS claim. The fix exports
and consumes `nativeGroupInboundActualTransport()` from the group adapter. Fresh
cold re-review passed and proved the signed route test fails if the route reverts
to the prior literal. No new finding remains.

The shared webhook harness and scheduled-send fake changes are limited to additive
carrier sender compatibility methods required by the Task 2 adapter contract.
No relay fan-out, announcements, native-group outbound/receipts, non-live writers,
projections, or UI behavior was changed.
