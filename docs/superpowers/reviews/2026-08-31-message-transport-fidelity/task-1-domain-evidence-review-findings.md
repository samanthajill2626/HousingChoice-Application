# Task 1 domain and evidence review findings

Reviewed range: `7ca5394c..4f5d2fcaf9280829323cc0e5c0d6ed4df0725ae7`
Reviewer verdict: spec compliance PARTIAL; task quality NEEDS_FIX.

## P1 - non-empty ChannelMetadata without a type is silently downgraded

`app/src/adapters/twilioMessageTransport.ts:38-40` classifies a parsed non-empty
metadata object with no `type`, for example `{}`, as absent. The later normalizer
path returns missing evidence rather than a conflict, so authenticated provider
traffic has no safe conflict result to drive the required warning. This violates the
approved evidence rule: unknown or conflicting non-empty evidence stays absent and
emits one safe structured warning.

The reviewer reproduced the behavior with a valid inbound SM SID, E.164 endpoint
and `ChannelMetadata: '{}'`: it returned `missing/unresolved-channel-evidence`.
Add table-driven authenticated and unauthenticated regressions. The authenticated
case must return conflict; the unauthenticated counterpart remains the existing
quiet missing result. The regression must fail if an absent `type` is again treated
as absent metadata.

Disposition: ACCEPT. This is a contained correctness fix in the normalizer and its
focused tests; no product scope, transport semantics or provider routing changes.
