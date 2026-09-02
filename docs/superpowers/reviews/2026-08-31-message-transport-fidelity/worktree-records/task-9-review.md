# Task 9 projection review

Scope reviewed: `6c176c33` against `b3835650`.

Result: PASS / CONFORMS. No P1, P2, or P3 implementation findings.

Evidence:

- `app/src/routes/contactTimeline.ts:424-438` copies the optional version/requested/actual fields by presence and carries the recipient map unchanged. It excludes email only; calls follow the separate call mapper, so neither non-carrier modality gains transport facts.
- `app/src/routes/api.ts:2154-2194` continues to return the repository page directly. Its only per-message change is relay-caller display hydration via `{ ...message, relay_external_caller_display_name }`, which preserves all optional transport and recipient fields. `app/test/conversationHubApi.test.ts:315-357` locks that behavior.
- `dashboard/src/api/types.ts:1549-1558,1622-1634,2129-2365` mirrors the closed transport and aggregation unions locally, extends both wire and timeline message shapes, and adds local-only `optimistic` only to `TimelineMessage`.
- `dashboard/src/routes/contact/buildTimelineFallback.ts:72-79` and `dashboard/src/routes/conversation/useRelayThread.ts:113-126` presence-copy all message fields; Group Text reuses `buildRelayItems`, so it follows the identical path (`useGroupThread.ts:186-189,241`). No mapper derives transport from `type`, media, author, or conversation kind.
- Server/SSE and older-page merges retain whole incoming objects: `dashboard/src/routes/shared/threadPaging.ts:48-55` replaces a same-id stale object with the incoming server object. The contact, relay, and group hooks therefore replace the transport-free optimistic row only after refetch (`useContactTimeline.ts:549-559`, `useRelayThread.ts:478-488`, `useGroupThread.ts:358-368).` `resolveOptimistic` only changes id/status, retaining `optimistic: true` until that refetch.
- Focused evidence: app `test/contactTimeline.test.ts` passed 48/48; dashboard Task 9 tests passed 86/86 across `types`, fallback, contact hook, relay hook, and group hook.

Note: the dispatched filename `docs/superpowers/reviews/2026-08-31-message-transport-fidelity/message-transport-fidelity-worklist.md` is absent. The corresponding tracked `implementation-drift-worklist.md` was reviewed instead; it names the same reader/renderer coverage and records this as an invariant sweep. This is a task-artifact naming discrepancy, not a reachability or behavior defect in `6c176c33`.
