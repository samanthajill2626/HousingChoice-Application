# Code review round 4 - orchestrator adjudications (feat/unknown-inactive)

Report: `R4-review.md` (fresh scoped reviewer on the FW3 diff, HEAD
798de475): 0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW, 3 INFO. FW3 REAL: reverting
FW3-1 (either module, or both) fails exactly the new ContactDetail case
(1/155 at :641, "expected 1 to be greater than 1"); the pre-FW3 form fails
only the 409 row (:2072); five mutants of the helper and the callback are
each caught except "onStale also on success", which is harmless. The header's
409 path is unchanged. Battery-4 at 798de475 (orchestrator-read):
typecheck 0; npm test 0 (app 527 / 11174 passed, 1 skipped; dashboard 266 /
5492; e2e workspace 22 / 508; 34 / 275; 13 / 111; no `[dynamoAdmin]` line);
smoke 0 (1733 specifiers, 301 files); e2e 0 (372 passed, 15.8m).

The review loop CLOSES here: round 4 is INFO-only, every fix wave was
verified REAL by revert, and the remaining items are records or planner
calls.

## RECORD (handback)

- R4-1 (INFO) - the page's consistent re-read after the form's 409 helps
  only once it has answered: a form reopened while that GET is still in
  flight is built from the stale contact with Save on, and a redone
  type-change draft re-sends `{ type }` over the colleague's re-type (R3-1's
  outcome, now needing an operator who reopens within one round trip AND an
  event stream that is down). Several FW3 comments state the next opening is
  always fresh; they overstate by that window. A page-level pending flag
  (open the form with Save off until a re-read succeeds) would close it.
  Recorded for the planner with R3-2 (same family: the contacts PATCH has no
  fence on the form's base type).
- R4-2 (INFO) - the form's own PATCH echo re-read can answer after the
  helper's re-read and leave the page on the older contact until the next
  event. Display-only; same class as ADV-6 (useContact's re-read sequence does
  not cover the initial load, setContact, or this helper).
- R4-3 (INFO) - ContactEditForm.test.tsx ~:2051 pins R3-2's recorded
  behavior (onStale is NOT called on the PATCH's 409 contact_changed). If the
  planner rules R3-2 a fix, that row flips.
