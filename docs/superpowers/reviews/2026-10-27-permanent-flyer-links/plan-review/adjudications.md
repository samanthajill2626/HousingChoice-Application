# Plan review adjudications - permanent flyer links

## Round 1 (plan v1 -> v2), 2026-10-28

Two opus reviewers, independent: R1-reviewer-a.md (10 findings),
R1-reviewer-b.md (11 findings). Both reported spec coverage of D1-D9 complete
and no BLOCKING finding. Merged to 13 items below. Load-bearing claims were
checked in the code before accepting: followUpFixtures.ts:48 `createUnitViaApi`
takes a tour type and always flips to Available, the `{ available }` variant
is local to broadcasts.spec.ts:87; lean.ts ~224 stores unit-0001's address as a
string; FlyerPage.test.tsx:55 renders `/p/unit-1`; flyer-leads.spec.ts:168
stores a listing link; `e2e/support/steps.ts` does not exist
(`e2e/scenarios/steps.ts` does); `toUnitFlyer`'s only app caller is
public.ts:854; contactStatusMirror.test.ts:1-30 is the cross-workspace mirror
pattern.

| # | Finding (sources) | Ruling | Decision changed? |
|---|---|---|---|
| P1 | T9 Setup e2e case uses the wrong helper (always Available; wrong signature; no staff context) (A1, B1) | ACCEPT - extend the spec file's own `createShareableUnit` with `{ setup: true }`, devLogin a staff page, assert status `setup` first | No (precision) |
| P2 | T9 expects an address heading for seeded unit-0001, whose address is a string the projection drops (B2) | ACCEPT - assert the CTA heading and the 200 only | No (precision) |
| P3 | Dropping the unused `SHAREABLE_STATUSES` import sits in T2 but is only possible in T3; T3's commit would carry a lint error (A4, B3) | ACCEPT - moved to T3 with a per-file eslint run | No (precision) |
| P4 | The "one pin from the same occupied flyer" test is green today (shared no-property source), so R4 is untested (A2, B4) | ACCEPT - add occupied flyer then /join -> two pins (red today) and assert the pin's unit ref | No (precision) |
| P5 | Renaming `unit-placed` seeds and bodies separately can leave a body on a made-up id that stays green (A3) | ACCEPT - grep to zero unit-placed seeds/ids; seed and send in the same test | No (precision) |
| P6 | FlyerPage tests: route id is `unit-1`, not `u1`; body-text absence checks pass vacuously during Loading (A5, B6) | ACCEPT - await the fallback h1 first; id fixed | No (precision) |
| P7 | Wrong path `e2e/support/steps.ts`; "toUnitFlyer has other callers" is false (A6, B10) | ACCEPT - path corrected; reason reworded (keep the projection pure, rule beside the gate) | No (precision) |
| P8 | T8 sweep scope skips app/test, app/scripts, scripts; overlaps T9 on e2e; no selectors.md row for the fallback page (A7, B5) | ACCEPT - scope widened with known hits; e2e/tests owned by T9 with its own sweep; selectors.md row added | No (precision) |
| P9 | No e2e proof of D3a although the flyer-leads unit carries a listing link (B7) | ACCEPT - positive control before the flip, absence after, API null | No (precision) |
| P10 | The On hold sign-up never checks the properties-sent entry (A8, B8) | ACCEPT - an On hold case with an address asserts pin ref and sentRecorded | No (precision) |
| P11 | The dashboard parity test compares against a second hard-coded list, not the app (B9) | ACCEPT - cross-workspace mirror test importing the app's leaf statusModel.ts | No (precision) |
| P12 | The ASCII check reads only unstaged changes; after `git add` it checks nothing (A9) | ACCEPT - `git diff -U0 HEAD` before commit | No (precision) |
| P13 | T10 names no committed home for the self-QA record and handback (A10, B11) | ACCEPT - `self-qa.md` and `handback.md` under the records path, committed as produced | No (precision) |

No rejections. Round 1 changed no decision (nothing added or removed a
surface, moved an invariant or changed what gets built), so it is the
terminal round: the plan review closes at round 1. Plan v2 goes to the
mission block and launch gate.
