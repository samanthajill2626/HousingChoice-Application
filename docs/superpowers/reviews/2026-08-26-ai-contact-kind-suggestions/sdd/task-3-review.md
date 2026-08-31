# Task 3 review - extraction-side type suggestion reconciliation

## Verdicts

- **SPEC-CONFORMANCE: FAIL**
- **TASK-QUALITY: CHANGES REQUIRED**
- Findings: 2 (1 high, 1 medium)

Review was read-only. Per dispatch, no tests were run. Evidence is from the exact
`3fe5dde7..3f96cfa5` diff package, committed source, approved design/plan, live
worklist, Task 3 brief/report, and the converged Task 2 review chain.

The inspected runtime implementation follows the intended reconciliation state
machine. The conformance failure is the approved, load-bearing test contract: the
new job-level regression fabricates the final marker-merged record instead of
executing the finalization handoff, and the new race tests do not pin consistent
reads.

## Findings

### HIGH - The job-level finalization regression fabricates the merge and never executes the required interleaving

**Evidence:** `app/test/extractionJob.test.ts:964-999` supplies an `aiRuns` fake
whose `beginFinalization` is a no-op and whose `putRun` unconditionally rewrites
the incoming type verdict to `superseded_by_human_edit` at lines 968-976. Nothing
creates a marker, nothing calls the marker-writing `setVerdict`, and nothing
asserts ordering after `putSuggestion`. The extraction fake also never stores a
suggestion: `putSuggestion` only returns an item at
`app/test/extractionJob.test.ts:171-180`, while `getSuggestion` always returns
`undefined` at line 190. Therefore the required absence assertion cannot
distinguish a route-owned delete from a row that was never present, and it was
omitted entirely.

This does not meet Task 3 brief lines 298-310 or approved design lines 324-331 and
565-569, which require a begun finalization marker, a classification-equivalent
delete/verdict after the put but before `putRun`, preservation of the pending
apply outcome, and a real marker merge over that pending verdict. The generic
repository integration at `app/test/aiRunsRepo.integration.test.ts:477-501`
proves marker merging for an independently constructed `pets` decision, but it
does not compose that behavior with this type post-put race.

**Reproducible counterfactual:** make `beginFinalization` stop creating markers,
make the classification route omit `setVerdict`, or break `AiRunsRepo.putRun`'s
marker merge at `app/src/repos/aiRunsRepo.ts:229-261`. The new Task 3 test still
passes because its mock `putRun` manufactures the desired verdict. Likewise,
remove route-owned suggestion deletion and it still passes because the fake
never persisted the row.

**Required change:** use a faithful stateful fake or the real repository boundary:
persist the type row, have `beginFinalization` create marker state, inject the
classification-equivalent exact delete plus `setVerdict` after the type put and
before `putRun`, let `putRun` perform the marker merge, then assert the stored run
is `outcome: 'suggested', verdict: 'superseded_by_human_edit'` and the stored
suggestion is absent. Assert invocation ordering so the test fails if the marker
is begun after apply. Keep the successful extraction-owned delete counterexample.

### MEDIUM - The race tests do not prove that every retry is a consistent contact read

**Evidence:** the production helper correctly calls
`getById(item.ownerContactId, { consistentRead: true })` inside its four-attempt
loop at `app/src/services/extraction/apply.ts:740-742`. However, the retry tests at
`app/test/extractionApply.test.ts:504-516` and `:554-564` assert only read counts
and guarded-delete revisions. Although the injectable mock receives the options
through `makeDeps` at `app/test/extractionApply.test.ts:45-48`, no assertion
checks them. The stable-Unknown and classified-contact cases likewise ignore the
read options.

**Reproducible counterfactual:** remove `{ consistentRead: true }` from
`apply.ts:741`. Every new Task 3 test still passes. Under DynamoDB eventual
consistency, a post-classification read can return the source Unknown revision;
the helper then returns pending at lines 750-752, leaving a stale type row with no
Unknown review surface. During repeated revision conflicts, stale reads can also
consume all four attempts and preserve a row that the current contact state says
must be retracted.

**Required change:** assert each injected `getById` call receives the owner id and
`{ consistentRead: true }`, including all four conflict retries. A focused test
should fail when the option is removed.

## State-machine trace

1. The job begins finalization before apply at
   `app/src/jobs/extraction.ts:567-578`.
2. For an Unknown source, apply records the logical source revision, puts the
   type row, and records displaced ownership at
   `app/src/services/extraction/apply.ts:535-553`.
3. Each inspected live state is handled correctly by the current source:
   stable Unknown/source revision returns pending (`:750-752`); classified or a
   newer Unknown epoch attempts the revision-fenced exact delete (`:755-763`);
   replacement/absence preserves pending (`:765`); contact revision conflict
   loops to a fresh read up to four times (`:724,740-766`); repository failure
   warns and preserves pending (`:767-777`).
4. Only `deleted` returns a dropped outcome, classified as
   `type_already_classified` or `type_classification_changed`; every other exit is
   pending. Apply then emits one `suggestion.updated` event even for the transient
   put/retract at `:712-715`.
5. The job builds decisions from that apply result and later passes the pending
   envelope to `putRun` at `app/src/jobs/extraction.ts:583-599,602-638`.
   Production `AiRunsRepo.putRun` consistently reads the marker and merges a
   terminal marker verdict only over a pending decision at
   `app/src/repos/aiRunsRepo.ts:229-261`. That production path appears correct,
   but Finding 1 shows the new S3 test does not execute it or a faithful model of
   it.

## Attacked but held

- **Unknown-only and advisory:** `app/src/services/extraction/apply.ts:536-590`
  writes only a suggestion for an Unknown snapshot and never writes contact
  `type` or `role`.
- **Source epoch and canonical kinds:** type rows carry logical source revision at
  `app/src/services/extraction/apply.ts:538-549`; tests cover Partner, Property
  Manager, and physical-absence-as-zero at
  `app/test/extractionApply.test.ts:432-460`.
- **Drop ownership:** only a guarded-delete result of `deleted` can select a
  dropped outcome; missing/replaced rows and exceptions preserve pending at
  `app/src/services/extraction/apply.ts:755-777`.
- **Drop reason split:** classified contacts map to
  `type_already_classified`; newer Unknown epochs map to
  `type_classification_changed` at `app/src/services/extraction/apply.ts:757-763`.
  The new reason is in the exact vocabulary and decision round-trip tests.
- **Bound and event cardinality:** the helper has a local bound of four and the
  type put/retract contributes to the single end-of-pass event condition at
  `app/src/services/extraction/apply.ts:712-715,724-766`; the successful retract
  test asserts exactly one event at `app/test/extractionApply.test.ts:463-477`.
- **Displaced-run ownership:** displaced type rows are recorded immediately after
  a successful put, before reconciliation, at
  `app/src/services/extraction/apply.ts:550-553`.
- **Generic behavior:** the only shared safe-put change is returning the immutable
  row already produced by the repository at
  `app/src/services/extraction/apply.ts:780-811`; dismissal and non-type branches
  are otherwise unchanged in the exact diff.
- **Typed construction sites:** the live `ApplyDeps` construction sites use full
  repositories or typed fakes; the reported focused typecheck exited 0. No cast
  was added to weaken `ApplyDeps` in this slice.
- **Scope boundary:** the exact six-file diff contains no schema, parser, prompt,
  seed, import, backfill, dependency, environment, infrastructure, worker, dev
  route, or generic suggestion-resolution activation.

