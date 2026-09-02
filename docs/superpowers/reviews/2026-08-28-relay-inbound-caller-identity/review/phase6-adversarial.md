# Phase 6 adversarial review - relay inbound caller identity

**Verdict: PASS**

Reviewed the complete `440dc75e...e8b1e634` diff plan-blind at candidate
`e8b1e634936c7226c7b425d6020b38c9693fca7a`. No must-fix findings.

## Final-candidate delta re-review (1ddea1e6)

**PASS.** Re-reviewed `e8b1e634...1ddea1e6` plan-blind. The only runtime
change replaces `format.ts`'s API-barrel import with its direct pure-types
module import. Both runtime label maps and all imported types are exported by
`api/types.ts`; the replacement removes the API barrel's transitive `.tsx`
dependency and changes neither formatter behavior nor dashboard runtime
values. The other changed file only corrects and closes the related issue
record; it cannot affect build or runtime behavior. The final worktree was
clean and both the delta and complete feature diff passed `git diff --check`.
No must-fix findings.

## Findings

None.

## Attacked but not broken

- **Routing and refusal isolation.** The only new write is reached after the
  existing refusal reason is established, and only for `non_member`
  ([voice.ts](../../app/src/routes/webhooks/voice.ts#L893)). The routing ladder,
  bridge decision, callee selection, and refusal TwiML remain unchanged.
- **Write-shape integrity and idempotency.** `messages.append` rejects any
  external-caller metadata outside an inbound, masked, unknown-author
  non-member call and rejects a contact id without a valid E.164 phone
  ([messagesRepo.ts](../../app/src/repos/messagesRepo.ts#L825)). It remains in
  the existing conditional append transaction, so redelivery cannot overwrite
  the first captured facts.
- **Privacy and failure behavior.** The lookup is restricted to a normalized
  number, stores no number in logs, treats a lookup failure as phone-only, and
  leaves refusal TwiML number-free ([voice.ts](../../app/src/routes/webhooks/voice.ts#L904)).
  The client-facing augmentation is inside the authenticated API and name
  hydration returns the original page if the optional batch read fails
  ([api.ts](../../app/src/routes/api.ts#L2115)).
- **Deleted/missing contacts, paging, and mutation.** The display projection
  includes `deleted_at`; each page batches and deduplicates ids, filters deleted
  results, and maps response copies rather than mutating stored messages
  ([contactsRepo.ts](../../app/src/repos/contactsRepo.ts#L855),
  [api.ts](../../app/src/routes/api.ts#L2131)).
- **Legacy relay and ordinary-call presentation.** The relay mapper forwards no
  media/transcript data. The new presenter wins only for the explicit
  `non_member` reason; all other cards continue through the existing roster and
  state presentation ([useRelayThread.ts](../../dashboard/src/routes/conversation/useRelayThread.ts#L70),
  [Timeline.tsx](../../dashboard/src/routes/contact/Timeline.tsx#L1255)).
- **UI/accessibility.** The caller detail is collapsed by default; its control
  has a card-specific accessible name with seconds (or row-id) disambiguation,
  and the contact link is URL-encoded ([Timeline.tsx](../../dashboard/src/routes/contact/Timeline.tsx#L1275)).
- **Diff hygiene.** `git diff --check` was clean. This review did not run
  competing test suites or alter source, tests, docs, or git state.
