# Task 2 fix-wave round-2 re-review - legacy present-run identity

## Verdict

- **PASS**
- Addressed original findings: 1
- Open original findings: 0
- New critical/important findings: 0
- Review was read-only. No tests were run.

## Cold review of `66db467d..3fe5dde7`

The fix diff adds 24 test-only lines in
`app/test/extractionRepo.integration.test.ts`; it does not change production
runtime behavior, schema, prompts, fakes, seeds, dependencies, environment,
tables, or infrastructure. The surrounding suite is real DynamoDB Local
coverage: it creates the `ai_extraction` and `contacts` tables with
`ensureTable` at `app/test/extractionRepo.integration.test.ts:42-56`, and its
helper writes the legacy row directly through `doc.send(new PutCommand(...))`
at `:211-230`.

No new critical or important defect was found in the new test diff.

## Prior finding adjudication

### ADDRESSED - MEDIUM: executable legacy present-`runId` transaction predicate

`putLegacyTypeSuggestion` omits `revision` unless explicitly supplied
(`app/test/extractionRepo.integration.test.ts:214,226-227`), so the new
`presentRun` candidate is a genuine legacy identity with no `revision` and a
present `runId: 'run-exact'` (`:241-246`). It is passed to the production
`deleteTypeSuggestionIfCurrentAtContactRevision` transaction and returns
`'deleted'` (`:247-248`). With `revision` absent and `runId` present, that
call executes the production condition
`attribute_not_exists(#revision) AND #createdAt = :createdAt AND #runId = :runId`
and its `:runId` binding (`app/src/repos/extractionRepo.ts:286-309`), in the
real DynamoDB Local transaction (`:779-815`).

The inverse same-timestamp mismatch is also executable: a legacy candidate
with `runId: 'run-original'` is replaced at the same `itemId` and
`createdAt` by a row whose `runId` is absent (`app/test/extractionRepo.integration.test.ts:250-259`).
The candidate delete returns `'suggestion_changed_or_absent'` and the live
replacement is asserted to have no `runId` (`:260-263`). This covers the
opposite present-candidate/absent-live-run identity and, together with the
already-present absent-candidate/present-live-run case at `:265-277`, proves
both asymmetric legacy run-id predicates.

## Counts

- Addressed original findings: 1
- Open original findings: 0
- New critical/important findings: 0
