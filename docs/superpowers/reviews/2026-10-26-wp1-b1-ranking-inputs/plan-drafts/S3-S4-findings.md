# S3-S4 plan draft - findings (code vs spec/plan)

Drafter: S3/S4 section drafter, 2026-10-26, against main @d0e2c2d8.
Findings only; the resolutions are in the S3/S4 plan sections. Each changes
what gets built; the planner rules on each.

## F1 (S4) - Spec D4's order would leave system lines outside the retry guard

Spec D4: "... then drop lines the retry guard finds already present ..., then
append the system lines, then apply the five-line cap". Read literally, the
system lines are appended AFTER the guard and so skip it. Today the guard
covers the joined model + system list (app/src/services/extraction/apply.ts:720-740),
and D4 also says "Kept as is: ... the verbatim retry guard". Skipping it would
re-append "Mentioned number X which belongs to another contact"
(apply.ts:666) on every complete() retry - the adversarial-F1 double append
the guard exists for (comment at apply.ts:731-737).
Draft resolution: the guard runs on model AND system lines, both before the
cap; model lines still come first in the cap. Needs a planner ruling.

## F2 (S4) - The AI run detail does not show notedLines today

Spec D5.3 places the new counts "beside notedLines" in the run detail, and
spec 4 says the new counts are "shown in the run detail". The detail pane
renders no Notes line count at all
(dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:56-89); notedLines is
only on the list row (dashboard/src/api/types.ts:264, app/src/routes/aiRuns.ts:216).
Draft resolution: S4 adds a "Notes lines" region in the detail pane showing
notedLines, notesBelowFloor and notesDemoted; S5 adds feedbackLines and
unlabeledAddressLines to the same block. A new UI element the spec did not
name.

## F3 (S4) - notesDemoted has no defined meaning

Spec D4 names the count but not what it counts. Draft resolution: the number
of lines (model and system, after the floor, the guard and the cap) a
demoted run withheld; notesBelowFloor is still counted on a demoted run. Both
are optional on the stored record (app/src/repos/aiRunsRepo.ts:64-66 has
notedLines only) and present on every run that reached apply.

## F4 (S3) - The dashboard keeps a hand mirror of DROP_REASONS the spec does not name

A new drop reason needs a staff label in dashboard/src/api/types.ts:299-314
and the server list in dashboard/src/api/types.test.ts:343-360; without them
the Reason cell shows the humanized fallback "text field filled"
(types.ts:317-319) and the mirror test stays green only because its list is
hand-kept. Draft resolution: S3 adds the label "Field already filled". The
label copy is the planner's (or Cameron's) to confirm.

## F5 (S3) - "Coercion in BOTH coerceField and coerceAccept" as two copies would be a second rule

Spec D3 places coercion by kind in both functions. A second implementation
is a second copy of a value rule (PR4's principle). Today the two already
disagree for free text: coerceField caps at 120 (apply.ts:124,130),
coerceAccept has no cap (app/src/services/suggestionResolution.ts:176).
Draft resolution: coerceField (exported, spec D4) holds the by-kind rule and
coerceAccept delegates to it for the four; the eight original fields keep
their current, differing behavior on each path. No import cycle
(apply.ts's runtime imports never reach suggestionResolution.ts).

## F6 (S3, S4) - Two fixture-only tasks have no unit RED

The e2e run-log marker field list (e2e/tests/dashboard-next/ai-run-log.spec.ts:157-166)
and the e2e noteLines payloads (e2e/tests/dashboard-next/caseworkers.spec.ts:517,
e2e/tests/flows/conversation-fact-extraction.spec.ts:332,377) are untyped
JSON (e2e/fixtures/extraction.ts:50-54), so neither typecheck nor a unit
test can turn them red; after S4.3 the two flows would fail at runtime (a
string item is dropped). Plan section 0 allows no-RED tasks only when
comment-only or docs-only. Draft resolution: both are marked fixture-only and
verified by S7's npm run e2e. Needs a planner ruling on the exception.
