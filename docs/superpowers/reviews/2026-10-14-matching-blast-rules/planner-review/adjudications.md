# Planner handback review - adjudications (round 1)

Branch `feat/matching-blast-rules`, reviewed at tip b1bb9dc9 (last code
commit 994be540). The planner's own work: the whole conversation replayed
from disk (15 human turns, incl. the mid-turn message and the question
answer) and checked against `../intent.md`; the five gates run by the planner
on b1bb9dc9 (run `planner`, `.superpowers/gates/planner/`); two independent
opus reviewers, read-only, no test runs:

- `conformance.md` - spec revision 6: 91 CONFORMS, 2 PARTIAL (low, test
  gaps), 0 DEVIATES, 0 MISSING; 6 info notes.
- `adversarial.md` - plan-blind: 0 blocking/high/medium, 3 low, 6 info.

## Planner gate run on b1bb9dc9 (bare, real exit codes)

| Gate | Exit | Result |
|---|---|---|
| typecheck | 0 | |
| npm test | 0 | app 509 files / 10454 passed + 1 skipped; dashboard 250 / 4812; e2e unit 22 / 508; fake-twilio 34 / 275; fake-twilio-web 13 / 111; no `[dynamoAdmin]` line |
| smoke | 0 | 1707 specifiers across 297 files |
| e2e (timeout 2700) | 0 | 363 passed (21.7m), 0 failed, 0 flaky |
| eslint, main...HEAD files | 1 | 3 errors, all pre-existing: BroadcastComposer.tsx 2 set-state-in-effect (the two message-prefill effects, on main as 2 of its 4), useComposerDraft.ts 1 refs (on main) |

## Cameron's decision (2026-10-19)

The decide-before-merge issue `matching-prefill-org-list-failure-fails-open`
went to Cameron with three options. Picked: "Hold + Try again
(Recommended)". A failed property load, or a failed organization-list read
while the property accepts an authority, now holds the prefill (no draft,
Preview disabled) with Try again, instead of letting the blast go out with
no authority filter. The stale-list case keeps its visible note. Spec
revision 7 (D3 Timing), plan AR44.

## Rulings

FIX = fix wave 2 (with a test that fails without the fix). FILE = an issue
in `docs/issues/`. NOTE = no action.

| Finding | Sev | Ruling | Why |
|---|---|---|---|
| Fail-open prefill (issue; conformance I5; adversarial PA-9 is its stalled-read form) | med | FIX (Cameron: hold + Try again) | Spec rev 7 / AR44. PA-9 needs nothing further: a stalled read ends in an error, which now holds with Try again. |
| Conformance I2 - "Not used ... <names> This blast is not limited ..." has no period between the sentences | low | FIX | The planner's own copy slip in the spec; a visible run-on sentence. Spec rev 7 adds the period; plan 1.1 / AR44. |
| Adversarial PA-5 - `wireAudienceFilter` reads `filter.bedroomSize` with no guard; one stored broadcast without `audience_filter` would 500 the whole Matching list (main passed it through) | info | FIX | Cheap and contained, and the failure is page-wide. Prod data cannot be checked from here, so guard it: a missing stored filter projects without throwing; a test lists a broadcast with no `audience_filter`. |
| Conformance R27 - a failed state clearing on property load / change is untested | low | FIX (test) | Folded into the AR44 tests (Try again success clears it; a property change clears it). |
| Conformance R55 - the held row's amber row class is untested | low | FIX (test) | One assertion. |
| Conformance I6 - `seed/matrix.ts` list-shape draft comment names only DeKalb | info | FIX | Comment only. |
| Adversarial PA-1 - the server's hold rule checks `convertible` before `outcome` and ignores `convertedPlacementId`; the Tours page checks outcome first | low | FILE | Label-only: the tenant is held either way. A converted tour is `closed` (no hold), so only API-written convertible-without-outcome rows and the brief `pending:` claim differ. Two copies of the tour-state reading can drift; file it (low) with the shared-helper direction. |
| Adversarial PA-3 - the already-sent read fails open with no notice while holds and declines fail closed | low | FILE | Pre-existing (documented soft hint); the branch only made the asymmetry sit inside one rule. A re-text is not critical (severity rule: a double text is high at most, fix only if small and contained); making it fail closed touches the prior-recipient walk. File it (low). |
| Adversarial PA-2 - every typing pause recreates the draft and re-runs the rules reads; a superseded create runs to the end | low | NOTE | Accepted at the spec gate (planner decision 4, approved by Cameron with the spec): "each recount is the same reads as one Preview click", cheap at today's volume. Revisit only on measured cost. |
| Adversarial PA-4 - the no-body send re-texts already-sent tenants and skips seeds | info | NOTE | Spec path (c) as designed; the dashboard never uses it. |
| Adversarial PA-6 - truncated at the exact page bound without reading onboarding | info | NOTE | Same as the orchestrator's ADV-7; needs ~10,000 searching tenants. |
| Adversarial PA-7 - the `heldContacts` log field counts org-wide holds | info | NOTE | Log detail only. |
| Adversarial PA-8 - `ResolvedAudience.contactIds` / `.count` have no runtime reader | info | NOTE | Harmless; not this branch's cleanup. |
| Conformance I1 - an empty authority list is omitted from the wire filter | info | NOTE | Conforms (the spec's wire shape). |
| Conformance I3 - the over-cap message keeps the "narrow" advice | info | NOTE | Intended: plan AR8 keeps it; only the truncation message changed. |
| Conformance I4 - a 422 naming a member the composer does not hold empties the list | info | NOTE | Already filed (`matching-composer-422-unmatched-member-clears-filter`). |

## Conversation checklist (planner only; reviewers stay blind to it)

Every item Cameron raised, against what the branch delivers (live QA
evidence: the build's `self-qa/self-qa.md`, plus the planner's own check
after fix wave 2).

| # | Item (date raised) | Status at b1bb9dc9 |
|---|---|---|
| C1 | Onboarding and Searching only (tracker, Sep 30) | delivered |
| C2 | Hold: upcoming tour; past tour with no outcome incl. no-shows until it closes; undated request for 14 days from the request (tracker, Oct 14) | delivered |
| C3 | An outcome (e.g. Not a fit) makes the tenant eligible right away (tracker) | delivered |
| C4 | Hand picks skip the rules; "NOTHING STOPS YOU FROM SENDING A PROPERTY TO THEM, including by clicking send property on their contact page" (Oct 14 14:21) | delivered (explicit list ships as reviewed; ?contactId= seed starts checked with its label) |
| C5 | Only Available properties can be picked (tracker) | delivered |
| C6 | Housing authority prefills from the property, several per property (tracker) | delivered; fail-open on a failed read -> fix wave 2 (Cameron 10-19) |
| C7 | One mechanism with #27: unchecked + label (tracker) | delivered |
| C8 | Tour-held listed unchecked with a reason; status-excluded not listed (Oct 14 14:21, decision 1) | delivered |
| C9 | Rules on the server; preview and send agree (decision 2) | delivered |
| C10 | #27 Interested -> request -> held up to 14 days, intended (3b) | delivered |
| C11 | Caseworkers never added to a blast automatically; manual add or direct send only (Oct 14 14:21) | delivered (filter path is tenants only; direct send works; Add a tenant search for caseworkers deferred per C13) |
| C12 | "Needs placement" counts as a placement: held (Oct 14 14:21) | delivered |
| C13 | Add a tenant finding caseworkers: left out of #6 (Oct 14 17:32) | delivered as deferred (issue filed) |
| C14 | No-authority tenants: "Leave out, say so" (question answer, Oct 14) | delivered (caption) |
| C15 | "Reaches N recipients" = the number checked (mid-turn, Oct 14) | delivered |
| C16 | Keep the housing authority lookup table/items (Oct 14 18:32) | delivered (comments only) |
| C17 | AUTO with 55-minute timers (Oct 14 19:30, 19:40) | delivered |
| C18 | Requested label "Tour requested Oct 12, no date yet", cue lower case (Oct 18) | delivered (character-exact per conformance) |
| C19 | Do not edit the tracker; 2-3 sentence third-person #6 note | delivered (handback note; tracker untouched) |
| C20 | Voucher size as a list left to #12 | delivered (unchanged) |

## Round 2 (after fix wave 2 and micro-wave 3; fix diff b1bb9dc9..dc073cc7)

Both reviewers CONTINUED with the re-review charge (round-2 sections
appended to `conformance.md` and `adversarial.md`). Planner live QA on the
hermetic lane: `live-qa.md` (12 scenarios, all PASS, incl. Cameron's AR44
hold on the `?unitId=` entry and a deliberate send to a held tenant).

- Conformance: revision 7 D3 plus the round-1 closures, 18 rows: 17
  CONFORMS, 1 PARTIAL (low test gap), 0 DEVIATES, 0 MISSING; 1 new low
  (F1); 6 info. Concedes every round-1 ruling.
- Adversarial: 0 blocking/high/medium; 1 low (R2-1), 5 info. Concedes every
  round-1 ruling. Confirms the hold never sticks after a successful retry,
  never lets an unfiltered draft or send out, and does not block direct
  sends, resumed drafts, seeds-only sends or a no-authority property.

| Finding | Sev | Ruling | Why |
|---|---|---|---|
| Conformance F1 - the PA-5 guard checks only `undefined`; a stored `audience_filter: null` still fails the list | low | FILE (`broadcast-null-audience-filter-guard`) | No app writer stores NULL (only a hand repair could); a fix needs another full gate cycle for a hypothetical shape. Small and filed with the exact fix. |
| Conformance R2-11 - an aborted organization-list read is untested | low | FILE (in `matching-prefill-hold-retry-feedback`) | The code is right (`useOrgList.ts:91`); test-only. |
| Adversarial R2-1 - Try again has no in-flight state, no failed-again signal; a second click restarts a slow read | low | FILE (`matching-prefill-hold-retry-feedback`) | Feedback on a rare failure path; the hold itself is correct. Not worth a fourth fix wave and gate cycle before merge. |
| Adversarial R2-2 / conformance N1 - "Estimating reach..." during a failure hold | info | FILE (same issue) | Deliberate per AR44 ("reach pending as for any unsettled prefill"), but misleading; fold into the feedback fix. |
| Adversarial R2-3 - an older "Couldn't estimate the audience" error beside the hold | info | FILE (same issue) | Needs two failures in a row. |
| Adversarial R2-4 - "Add more tenants by filters" during an outage has no way back | info | FILE (same issue) | Related to the pre-existing `matching-enable-filters-keeps-one-tenant-message`. |
| Adversarial R2-5 / conformance N3 - a 404 `?unitId=` holds behind "can't be filled in yet" | info | FILE (same issue) | No regression (a dead end before); copy only. |
| Adversarial R2-6 / conformance N6 - a filter draft stored with no filter 500s its own preview and send | info | FILE (in `broadcast-null-audience-filter-guard`) | As on main; one row only. |
| Conformance N4 - spec section 6 still says a failed read "settles"; the first Timing sentence conflicts with the no-authority exception | info | FIXED (spec text, planner) | The planner's own revision 7 slip; section 6 and the Timing sentence now match. |
| Conformance N2 | info | (same as R2-1) | |
| Conformance N5 - the e2e proves "no draft" with a fixed 1.5 s wait | info | NOTE | It outlasts the 600 ms create debounce; the unit tests pin the hold exactly. |
| Conformance PA-9 caveat - the dashboard client sets no request timeout, so a stalled read may never end locally | info | NOTE | Deployed reads end at the edge's timeout (504) and then hold with Try again; locally a stall shows the loading state. Not this branch's change. |

No round-2 finding changed what gets built or moved an invariant, so the
planner review closes at round 2. Final gates: the planner's own run on
dc073cc7 (run `planner-final`), quoted in the verdict.

## Planner gate run `planner-final` on dc073cc7, and the e2e fix

typecheck 0; npm test 0 (app 509 files / 10455 passed + 1 skipped,
dashboard 250 / 4824, e2e unit 22 / 508, fake-twilio 34 / 275,
fake-twilio-web 13 / 111, no `[dynamoAdmin]` line); smoke 0; lint 3 errors,
all pre-existing (BroadcastComposer.tsx 2 set-state-in-effect, the two
message-prefill effects; useComposerDraft.ts 1 refs); e2e EXIT 1 = 2 failed
/ 362 passed (32.0m, ~3,100 TIME_WAIT at the end):

- `matching-entry-points.spec.ts:272` (the property-first "Send a property"
  test) - the open `matching-entry-points-property-first-e2e-flake`
  signature, and ALONE it then failed 2 of 3 repeats. Diagnosed rather than
  re-run away: Escape in `UnitSearchField` dismisses only a list already
  shown (`:176`), so a type-and-Escape before the property list lands is a
  no-op and the suggestions open over the row when it lands. Proven with a
  throwaway probe delaying `GET /api/units` 2.5 s (4 of 4 RED with the exact
  signature; 3 of 3 GREEN with the fix); fixed in the spec (wait for a
  browsable row before typing); the real file then 15 of 15 with
  `--repeat-each=5`. Pre-existing mechanism (unchanged component and test
  lines), fixed here because it sits in this feature's spec. Issue resolved
  with the mechanism.
- `approval-and-move-in.spec.ts:337` - "the placement page did not finish
  loading", the open `placement-detail-bundle-fetch-stall` family under port
  exhaustion; 5 of 5 alone right after. Sighting recorded. Not this branch's
  path.

A full gate run on the new tip follows; its exit codes are the verdict's.
