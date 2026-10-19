# Fix-wave-2 review - orchestrator adjudications

Fresh reviewer on e1c2bbe8 (`fw2-review.md`): AR44 implemented exactly as
Cameron decided (12 interleavings; the implementer's mutants M1-M6 plus the
reviewer's MX1/MX2 killed); 0 blocking/high/medium; 5 LOW, 3 INFO.

Intermediate gate run `fw2` on e1c2bbe8 (overlapping the reviewer's
single-file test runs): typecheck 0, npm test 0 (app 509 / 10455 + 1 skipped,
dashboard 250 / 4820, e2e-unit 22 / 508, fake-twilio 34 / 275,
fake-twilio-web 13 / 111), smoke 0, e2e 1 failed / 362 passed (24.9 min) -
`tour-roster.spec.ts:183` waited 3 min for "Continue as dev user" on an
entirely white page: the known `e2e-blank-first-paint-at-sign-in` signature
(environmental; sighting recorded with the final run), lint 3 pre-existing.
The final gates run once after micro-wave 3, on its final commit.

| Finding | Sev | Ruling | Why |
|---|---|---|---|
| FW2-1 a failure hold shows "Write a message to enable the preview." (writing one does not help) and then "Sizing the audience..." beside a spinner that never stops | LOW | FIX (micro-wave 3) | Small and contained, in this wave's new UX, and it tells staff the wrong remedy. While a prefill failure notice holds, the Preview area shows no remedy hint and no spinner - the notice with Try again is the explanation. The reach line stays pending as AR44 rules. |
| FW2-2 the hold notice is a plain paragraph, never announced | LOW | FIX | One attribute, consistent with the compose step's 503 alert (also a failed read with Try again): the hold notices get `role="alert"`. |
| FW2-3 a one-tenant message typed while the property failed to load becomes the filter blast's body after "Add more tenants by filters" (no confirm) | LOW | FILE | Pre-existing on main (`onEnableFilters` resets only when the unit is loaded); not this wave's change. File `matching-enable-filters-keeps-one-tenant-message`. |
| FW2-4 `e2e/support/selectors.md:134` still says a failed read settles | LOW | FIX | Doc row the wave missed. |
| FW2-5 no e2e covers the hold | LOW | FIX | AGENTS.md: a new user-facing behavior gets a spec. Extend `matching-blast-rules.spec.ts` with a hold test (a routed 500 on `GET /api/organizations`, robust to StrictMode duplicates), RED by mutation as AR11 allows. |
| FW2-6 two comments still say the list is read once | INFO | FIX | Comment-only. |
| FW2-7 a name ending in "." gets a double period in the Not-used note | INFO | FIX | One guard + one test. |
| FW2-8 the spec's "a failed state belongs to the property" fits only the property load | INFO | FIX (orchestrator, spec clarification) | Spec D3 Timing now says a failed list read is not tied to a property and holds every property that accepts an authority until a read succeeds - the code already does; this keeps a later change from "fixing" it. |
