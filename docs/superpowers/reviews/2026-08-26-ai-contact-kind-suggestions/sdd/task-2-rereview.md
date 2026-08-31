# Task 2 fix-wave re-review - persistence and fencing

## Verdict

- **CHANGES REQUIRED**
- Original findings: 1 ADDRESSED, 1 NOT ADDRESSED
- New critical/important findings: 0
- Review was read-only. No tests were run.

## Cold review of the fix diff

The four-file fix diff does not change production runtime code. It changes only the
webhook test harness and three test files. Generic suggestion replacement, extraction
schema/parser/prompt activation, seeds/imports, dependencies, environment, tables, and
infrastructure remain untouched by `fcf65dda..66db467d`.

No separate critical or important defect was found in the newly added harness logic or
tests. The remaining issue below is the incompletely addressed original transaction-
predicate coverage finding, not a new finding.

## Original finding adjudication

### ADDRESSED - HIGH: webhook harness did not advance the classification fence

**Implementation proof:** `app/test/helpers/twilioWebhookHarness.ts:1775-1789` now
computes `changesKind` from supplied non-`undefined` `type` or `role`, applies explicit
`null` as an attribute removal, and then advances the logical
`classification_revision`. Therefore `{ role: null }` increments exactly as the real
repository does. The fake update body has no `await`, so two calls cannot interleave
inside the read/increment/write sequence.

**Regression proof:** `app/test/twilioSmsWebhook.test.ts:32-63` performs sequential kind
writes and observes revisions 1 and 2. It publishes a later suggestion at revision 2,
then drives the older revision-1 guarded delete. The harness implementation at
`app/test/helpers/twilioWebhookHarness.ts:3284-3296` checks the live contact revision
before suggestion identity/deletion, returns `contact_revision_changed`, and the test
asserts that the later suggestion's immutable revision remains current. This closes the
reported stale-route deletion hole.

### NOT ADDRESSED - MEDIUM: legacy condition/helper parity is still not fully executable

Most of the requested cases are now pinned:

- `app/test/extractionRepo.integration.test.ts:233-239` executes exact deletion of a
  legacy row with both `revision` and `runId` absent.
- `app/test/extractionRepo.integration.test.ts:241-253` proves an absent-`runId`
  identity cannot delete a same-time replacement whose `runId` is present.
- `app/test/extractionRepo.integration.test.ts:255-268` proves the legacy condition's
  absent-revision guard preserves a revisioned same-time replacement.
- `app/test/extractionRepo.integration.test.ts:270-280` executes the later numeric
  contact-revision mismatch and preserves the suggestion.
- `app/test/extractionRepo.test.ts:1007-1045` forces a
  `TransactionCanceledException`, returns consistent post-read rows satisfying both
  predicates, asserts both reads are consistent, and proves the original exception is
  rethrown.

However, no guarded-delete transaction test supplies a legacy candidate with a present
`runId`. Every new transaction invocation uses the absent-`runId` identity created at
lines 234, 242, 256, or 272. Consequently the production predicate branch
`#runId = :runId` at `app/src/repos/extractionRepo.ts:298-309` is still never executed.
The mismatch at lines 241-253 exercises only the opposite
`attribute_not_exists(#runId)` branch at `app/src/repos/extractionRepo.ts:286-296`.

This is still load-bearing condition/helper parity: deleting the `#runId = :runId`
clause, binding the wrong value, or otherwise breaking only the present-`runId` branch
would leave all new tests green while allowing a legacy candidate to delete the wrong
same-time row. Add a real DynamoDB case that writes a legacy row with a present `runId`
and successfully deletes it by that exact identity, plus the reverse mismatch (present
candidate versus absent or different live `runId`) so both asymmetric transaction
conditions are executable.

## Counts

- Addressed original findings: 1
- Open original findings: 1
- New critical/important findings: 0
