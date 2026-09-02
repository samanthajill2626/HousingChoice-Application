# Message transport fidelity - implementation drift worklist

Date: 2026-09-01
Branch: `feat/message-transport-fidelity`
Branch base: `5ce9912f4df20af95ec7cd7c6c61e7ed726930ec`

## Outcome

The live inventory found no approved-spec or approved-plan contradiction. The
implementation starts from the branch's documented base and preserves the one final
mainline sync rule. Current `main` has substantial overlapping relay, projection,
seed and dashboard changes, so the final sync is an explicit integration checkpoint,
not a mechanical expectation.

## Current-main overlap

Current `main` changes these planned paths relative to the branch:

- `app/src/jobs/relayFanOut.ts`
- `app/src/services/relayAnnouncements.ts`
- `app/src/routes/api.ts`
- `app/src/routes/contactTimeline.ts`
- `app/src/routes/dev.ts`
- `app/src/lib/seed/lean.ts`
- `app/src/lib/seed/live.ts`
- `app/src/lib/seed/matrix.ts`
- `dashboard/src/api/types.ts`
- `dashboard/src/api/types.test.ts`
- `e2e/tests/dashboard-next/relay-group-view.spec.ts`

The plan already names each production owner. The final merger must preserve current
main behavior and add only versioned transport facts; it must not let a transport
refactor erase current-main relay membership, announcement, seed or presentation
behavior.

## Invariant sweep

The inventory covers every state mutation surface: initial message appends (direct,
broadcast, retry, inbound, relay, native group, announcement, import, seed and dev),
recipient-slot initialization/preflight/attempt/suppression/result paths, direct and
relay callbacks, and native-group receipts. It also covers every reader/renderer:
server projection, raw conversation read, dashboard types, fallback and thread
mappers, all three optimistic hooks, Timeline metadata, disclosure, delivery rollup,
staleness/ticker and browser selectors.

## Binding decisions carried into build

- Status callbacks look up the stored direct message or relay slot before provider
  evidence normalization.
- Schema-absent relay rows do not initialize, preflight or write transport state.
- V1 preflight uses the exact existing sender- and continuation-filtered send set.
- Same-status successes may write first SID/time, actual evidence and transient-error
  cleanup without a status regression.
- Group MMS is adapter-owned authoritative evidence. The UI and generic services do
  not infer transport from type, media, conversation kind or provider fields.
- The delivery UI hides only excluded slots without a suppression code. Optimistic
  carrier bubbles show no transport until a server refetch.

## Implementation reference

The byte-exact live interface and file:line map is retained in the ignored mission
worklist at `.superpowers/sdd/phase1-live-worklist.md`. It is intentionally run state;
this committed record preserves the decisions and integration obligations.
