# Task 11 Independent Review

Review target: `edc9865c` against `6f2f38b6`.

## P2: Legacy recipient disclosures gain a false `Unknown` transport

- Evidence: `dashboard/src/routes/contact/Timeline.tsx:1069-1078` unconditionally appends `presentRecipientTransport(row.slot)` to every included delivery row. `dashboard/src/lib/messageTransport.ts:67-76` returns `Unknown` when a slot has neither requested nor actual transport. Existing schema-absent relay fixtures intentionally have exactly that shape; for example `dashboard/src/routes/contact/Timeline.test.tsx:1189-1192` has delivered/sent slots with no transport fields.
- Reproduction: render that existing schema-absent relay source, reveal its bubble, and inspect either recipient row. The prior `Delivered` / `Sent - not confirmed` text becomes `Delivered - Unknown` / `Sent - not confirmed - Unknown`, despite the parent message correctly retaining its legacy `SMS` chip. The disclosure's accessible name receives the same added claim.
- Consequence: this violates the approved legacy-display invariant and makes historical rows look like version-1 messages with an unresolved carrier fact. `Unknown` is reserved for a malformed/unresolved versioned fact; schema-absent recipient maps have no such observation.
- Required correction: distinguish the parent message's schema version at the recipient presenter boundary, returning no recipient transport for schema-absent messages while preserving `Unknown` for version-1 slots with neither fact. Cover a revealed legacy relay/group row and its accessible name.

## Conforming checks

- `Timeline.tsx:831-846` calls the centralized message presenter with mapped fields and optimistic marker; no local carrier fallback reappears.
- `Timeline.tsx:794-800,880-929` uses one filtered recipient set for ticker, opted-out count, rollup input, row ordering, and disclosure. The inbound-relay gate keeps the main chip actual-only while admitting its outbound-leg disclosure.
- `Timeline.tsx:1069-1089` adds transport after, rather than replacing, status/identity/time; selector documentation names the resulting accessible listitem contract.
- Optimistic rows remain chip-free through resolution in both ConversationDetail and GroupTextView coverage; native text-only group MMS is presenter-backed rather than inferred from legacy `type`.
- Focused verification: `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx` exited 0: 3 files, 235 tests.

Verdict: P2 must fix before acceptance.
