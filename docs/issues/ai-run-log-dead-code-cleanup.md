---
id: ai-run-log-dead-code-cleanup
title: Dead repo methods, a stale error class, an unconsumed retryable flag and two hardening nits
type: debt
severity: low
status: open
area: app/extraction
created: 2026-08-09
refs: app/src/adapters/extraction.ts:146, app/src/repos/extractionRepo.ts:160, app/src/repos/extractionRepo.ts:156, app/src/repos/messagesRepo.ts:680, app/src/routes/suggestions.ts:177, app/src/services/extraction/schema.ts:338, app/src/repos/suggestionResolutionRepo.ts:719
---

**Problem.** Seven small cleanups in the extraction / suggestion-resolution
area, all re-verified at HEAD after the fix wave. Grouped because each is a
few lines and they share one review pass.

- [ ] **`ExtractionRefusedError` is dead and its doc comment is wrong.**
      Declared at `app/src/adapters/extraction.ts:146`; its comment says "the
      class survives as the error the job's temporary unwrap raises" - there is
      no unwrap. `grep -rn ExtractionRefusedError app/src` returns the
      declaration only. The remaining references are
      `app/test/extractionAdapter.test.ts:19/:306-309` (asserting it is an
      `Error`) and a stale comment at `app/test/extractionJob.test.ts:14`. The
      driver now returns `{ ok:false, failure:'refusal' }` instead of throwing.
- [ ] **`extractionRepo.restoreSuggestionIfAbsent` now has ZERO callers
      anywhere.** Declared `app/src/repos/extractionRepo.ts:160`, implemented
      `:569`. It had no `app/src` caller before the fix wave and one test-fake
      caller; W4 rewrote the fake to use the real two-item transaction, and
      `app/test/helpers/suggestionResolutionFake.ts:109` now carries a comment
      saying so. The only remaining uses are its own repo test
      (`app/test/extractionRepo.test.ts:622-624`) and the test doubles forced to
      implement the interface. It is a pure liability now.
- [ ] **`extractionRepo.deleteSuggestion` is declared but never invoked.**
      Declared `:156`, implemented `:532`. Its only `app/src` appearance is
      inside a dependency `Pick<>` at
      `app/src/services/extraction/apply.ts:37`; there are no call sites -
      `routes/contacts.ts` moved to `deleteSuggestionIfCurrent`.
- [ ] **`messagesRepo.getByTsMsgId` has no `app/src` caller.** Declared
      `app/src/repos/messagesRepo.ts:680`, implemented `:1528`; the run-log
      route uses the batch sibling `getManyByTsMsgIds`. Like the two above, it
      still forces every messages double in the test suite to implement it.
- [ ] **The `retryable` flag is emitted and never read.**
      `app/src/routes/suggestions.ts:177` serializes
      `...(error.retryable && { retryable: true })` from
      `SuggestionResolutionError.retryable`
      (`app/src/services/suggestionResolution.ts:82`). W5 gave the three
      retryable-class codes transient copy, but it did so by hardcoding the code
      names in `SUGGESTION_RESOLUTION_ERROR_COPY`
      (`dashboard/src/api/types.ts:1194-1210`) - `grep -rn retryable
      dashboard/src` finds no read of the field itself. So the wire contract and
      the UI can drift: a new retryable code on the server gets a generic
      message until someone edits the copy map. Either consume the flag or drop
      it.
- [ ] **`EMPTY_OPS_VIEW` is only shallow-frozen.**
      `app/src/services/extraction/schema.ts:338` -
      `Object.freeze(absentView())` leaves the twelve nested
      `{ op: 'absent' }` objects mutable. Consumers are tests only today
      (`app/test/extractionOps.test.ts`, `app/test/extractionDecisions.test.ts`).
- [ ] **`commitContactEffect` can emit an empty `ExpressionAttributeValues`.**
      `app/src/repos/suggestionResolutionRepo.ts:719` always spreads
      `{ ...values, ...contactGuard.values }`; for a REMOVE-only patch whose
      guards are all `{ exists: false }` both maps are empty and DynamoDB
      rejects an empty map. Unreachable from today's three plan builders, but
      the same file's sibling ConditionCheck (`:755`) and `contactsRepo.ts:951`
      both guard with `Object.keys(...).length > 0`, so the file is
      inconsistent with itself.

**Suggested fix.** Delete the four dead surfaces (error class, the two
`extractionRepo` methods, `getByTsMsgId`) together with the interface entries
and every test double's stub - the same shape as
[property-card-409-settle-dead-code](./property-card-409-settle-dead-code.md)
and [remove-dead-relay-roster-alias](./remove-dead-relay-roster-alias.md).
Decide the `retryable` contract (consume it in
`suggestionResolutionErrorMessage()` as the default transient signal, or remove
it from the response). Deep-freeze `EMPTY_OPS_VIEW`, and add the
`Object.keys(...).length > 0` guard at `suggestionResolutionRepo.ts:719` for
consistency with its two neighbours.
