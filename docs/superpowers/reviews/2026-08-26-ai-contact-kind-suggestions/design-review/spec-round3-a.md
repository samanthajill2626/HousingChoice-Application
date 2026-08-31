# Adversarial Design Review - Round 3

Reviewed the design through `86e8583d`, the adjudications, and both round-two
reports. D11 correctly identifies the stale-Unknown suggestion problem and adds
both necessary state owners: a live-contact check after extraction puts a row and
a post-classification route drain. Its no-pending-row proof works for the normal
put/read/CAS orderings. One all-successful ordering remains unspecified at the
boundary between that state protocol and AI-run finalization.

## 1. [HIGH] D11 can erase the classification writer's terminal verdict when the drain wins before extraction finalizes

### What is wrong

D11 defines what an extraction writer records when its own conditional cleanup
succeeds, and what happens when it loses to a newer suggestion. It does not define
the third distinct `false` result: the classification route has already deleted
the exact row and written a terminal verdict into that still-in-flight run's
finalization marker.

This is a reachable all-successful schedule:

1. Extraction E has an Unknown contact snapshot and successfully creates its
   finalization marker before it calls `applyExtraction`.
2. The classification PATCH C takes its pre-write suggestion snapshot while no
   type row exists, then writes the contact as Tenant/Landlord/Partner.
3. E puts type row S from its stale snapshot. C's D11 drain consistently reads S,
   CAS-deletes S, and writes `superseded_by_human_edit` for E's type decision to
   E's finalization marker; E has not yet recorded its run row.
4. E's live contact read now correctly sees the classified contact. Its exact CAS
   delete of S returns `false` because C already deleted it, not because a newer
   extraction replaced it.
5. E finalizes its run.

The spec never says what E's `ApplyDecision` must be in step 4. A natural reading
of "the contact is no longer Unknown" is to turn the decision into the D11
`dropped/type_already_classified` outcome. That makes the completed record's
verdict `not_presented`. The existing finalizer applies a marker verdict only
when the run's own decision is still `pending`, so it discards C's already-written
human-superseded verdict. The final record then claims the model was never
presented even though staff classification raced and the route deliberately judged
that exact suggestion as a human override.

This violates D11's instruction that a post-write row drained by the
classification writer receives `superseded_by_human_edit`. It is not a repository
failure and it does not leave a pending row, so D11's current acceptance criterion
does not expose the audit-corruption half of the race.

### Evidence

- D11 treats a successful extraction-side cleanup as dropped, assigns a terminal
  human-superseded verdict to a classification-drained replacement, and says the
  two sides establish the invariant, but defines no outcome for a failed
  extraction CAS caused by the drain: spec D11, lines 290-310. The test matrix
  covers a post-put classified read, card/Edit replacement drains, and a second
  replacement, but not the drain-wins-before-run-finalization order: lines
  438-462.
- The job creates the finalization marker before `applyExtraction`, while the run
  record is assembled only after `applyExtraction` returns:
  `app/src/jobs/extraction.ts:569-599` and `app/src/jobs/extraction.ts:737-764`.
- `setVerdict` can successfully write a verdict to that marker when no run row
  exists (`app/src/repos/aiRunsRepo.ts:420-477`). When `putRun` later finalizes,
  it imports a marker verdict only for a decision whose own verdict is `pending`:
  `app/src/repos/aiRunsRepo.ts:229-263`.
- A dropped apply decision deterministically maps to `not_presented`, whereas a
  suggested decision maps to `pending`:
  `app/src/services/extraction/decisions.ts:51-55, 69-105`.
- The conditional delete contract returns only `false` for either a replacement
  or a row already removed; it carries no deletion cause for D11 to branch on:
  `app/src/repos/extractionRepo.ts:667-694`.

### What it implies

D11 must prescribe the run-decision handoff, not just row deletion. In this exact
CAS-false/now-classified path, extraction must preserve a marker-mergeable
`suggested`/`pending` decision (or the finalizer must merge an already-written
terminal marker over a non-pending decision under an explicitly safe rule). It
must not relabel the run as `type_already_classified` unless E itself won the
conditional delete. The design also needs an integration test that pauses E after
its put, lets C drain and stamp the marker, resumes E through its failed cleanup
and `recordRun`, and asserts: no pending type row, one terminal
`superseded_by_human_edit` decision, and no replacement of that verdict by
`not_presented`.

## Attack surfaces checked without additional material findings

- Suggestion publication before and after the classification write, including an
  empty pre-write snapshot.
- Consistent contact/suggestion reads, exact revision CAS deletion, replacement
  before a drain CAS, and the extraction writer's ownership transfer to the
  newest replacement.
- Finalization-marker creation, marker verdict writes before the run row exists,
  fallback-marker behavior, run-record merge, and later displaced-run stamping.
- Both D7 classification writers, generic target behavior, Today's pending-row
  reader, and the no-pending-row acceptance criterion.

The bounded drain's unspecified retry count is not a separate finding: once the
contact write is visible, every subsequently published writer has its own
consistent post-put cleanup obligation, so a finite route drain does not by
itself leave a row under D11's successful-operation premise.
