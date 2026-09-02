# Fix wave 1 - all findings ruled FIX / REVERT / DOC in the round-1 adjudications

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\fix-wave-1.md`
THE FINDINGS LIST (binding, read fully): `W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\reviews\2026-08-31-tour-reminder-ladder-phase-b\code-review\adjudications-r1.md`
Reviewer reports (evidence, `file:line`, proposed fixes, reproduction sketches):
`...\code-review\r1-adversarial.md` and `...\code-review\r1-conformance.md` (same dir).
Slice reports for context: `.superpowers/sdd/reports/slice-4.md` (T7/T8), `slice-5.md` (T9),
`slice-8.md` (T14 - the relay resolver, the e2e variants spec).

Scope - implement EVERY row ruled FIX, REVERT, or DOC (15 items):
MUST-FIX: B-MF1, B-MF2, A-M1, A-M2.
SHOULD: B-S1, B-S2, B-S3, B-S4, B-S5, B-S6 (doc), A-S3, A-S4, A-S5, A-S6 (REVERT the
`DeadlinesNudgesCard` StateChip discontinued branch ONLY - keep its label entry; KEEP the
`ScheduledCard` muted tone).
NOTE: B-N1, B-N4.
Nothing ruled RECORD/MOOT is touched.

Rules for this wave:
- Failing test first for every behavioural fix (B-MF1, B-MF2, B-S1, B-S2, B-S5, A-S4, A-S5,
  B-N1, B-N4). Comment-only fixes (B-S3, B-S4, A-S3, A-M1's comments) need no test but
  A-M1 must make the discontinued-guard claim REAL by seeding a confirmation row directly
  (repo `create`) in that devGating case - or drop the claim; say which.
- A fix that touches behaviour a test fake mirrors must fix BOTH the real thing and the fake.
- A-M2 (placement relay intro e2e): extend `e2e/tests/relay-intro-variants.spec.ts` with a
  placement-owned walk mirroring the tour walk's structure and helpers (open via the
  placement roster preview/open routes - read how `placementsApi.test.ts` and the existing
  placement e2e specs create a placement with a unit ADDRESS and a landlord; assert the
  PREVIEW body starts `Hey <tenant first>!` and contains `Excited to have you move into <street>`,
  then that EVERY member's fake thread receives that body from the pool number). Accessibility-
  first selectors; far-future fixtures; no near-now rows. Do NOT run Playwright; `cd .../e2e
  && npx tsc --noEmit -p .` must be green; the orchestrator runs the full e2e.
- B-S5: the sweep gains a `failed` counter; per-row try/catch logs `{ reminderId, tourId,
  err }` (never a name/phone/body) and continues; the top-level catch logs the partial
  counters before `process.exitCode = 1`; add ONE sentence to the RUNBOOK entry about the
  PARTIAL report; integration test: a row with `tourId: ''` (or missing) does not abort the
  run and is counted `failed`.
- B-S6 (DOC): append item d to `## Added during the build` in `founder-handback-items.md`:
  the tour/placement intros are written TO THE TENANT by name but every roster member -
  the landlord included - receives the identical text ("Hey Alicia! ... meeting Marcus!"
  read by Marcus). The old naked intro was audience-neutral, which is why this never came
  up. Her copy, her call: keep as-is, or supply a landlord-facing line. ASCII.
- After all fixes: `cd .../app && npx vitest run` FULL (timeout 600000); `cd .../dashboard &&
  npx vitest run` FULL; `npm run typecheck` (root); `npm run smoke`; e2e tsc; `npx eslint
  <touched ts/tsx>` with baseline attribution. ONE commit (or two: code + docs):
  `fix(reminders,relay): review round 1 - past-tour naked fallback, next skips discontinued,
  sweep partial report, panel affordances`. Report per item: FIXED (file:line + test) /
  how each behavioural fix was proven red-first.
