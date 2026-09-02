# MISSION: Tour reminder supersession + Upcoming placement

Worktree: `W:\tmp\tour-reminder-supersession`
Branch: `feat/tour-reminder-supersession` (cut from `main` @f27aabbf)
Profile: `.claude/feature-mission.profile.md`
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Plan: `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md`
Design review: spec R5, plan R2 - adjudications at
`docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/adjudications.md`
(111 findings, 107 accepted, across seven rounds)

## Work map

- **S1** repo foundations: `ladderId`, `currentLadderId`, a value-guarded
  pointer write, `attribute_exists(reminderId)` claim guards,
  `deleteSupersededForTour`, and BOTH harness fakes
- **S2** the armer stamps one `ladderId` per call and returns `{ ladderId, rows }`
- **S3** tour pointer writes: create, re-arm rotation, terminal rotation,
  compare-and-set, interruption logging
- **S4** seeds stamp ladders AND set pointers (`live.ts`, `matrix.ts`, `cast.ts`)
- **S5** refusal: poll + send-now, `superseded` across BOTH unions and every
  copy surface, bounded conversion deferral with its own token
- **S6** the three preview surfaces agree, with the pre-migration exemption
- **S7** read grouping, `earlier[]`, the disclosure, the action allowlist, 404s
- **S8** conversion: defer before finalize, rotate inside it, sweep after
- **S9** `tours.ts` swaps cancel for the sweep; the old wrapper is removed
- **S10** the Upcoming block moves inside the scroll; six scroll writers; the
  three-valued anchor
- **S11** re-point the tests that encode the old contracts

## Watch items

- **Slice order is the safety property.** Nothing deletes until everything that
  refuses a superseded rung exists. If a slice has to move, re-check that
  guarantee before moving it - plan review found it false at S8 once already.
- **Two conditional writes must be proven against DynamoDB Local, not the
  fakes**: the claim guard (T1.4) and the compare-and-set (T3.3). Both fakes
  will happily agree with a broken implementation.
- **The copy census has been wrong in four consecutive reviews.** Use T5.2's
  two-probe method, not a list.
- **Vitest strips types.** Only `npm run typecheck` proves S2's return shape
  threaded, and nothing proves the two hand-mirrored dashboard unions.
- **jsdom performs no layout.** The scroll anchor is a pure function at the unit
  layer and an e2e assertion in a real browser; S10.9 additionally requires live
  phone QA by hand.
- Do not commit while `npm run e2e` is running.
- `npm test` needs DynamoDB Local. Red on DynamoDB suites with timeouts and no
  assertion failures: re-run under a clean access key before blaming the branch.

## Gates

Bare, from the worktree: `npm run typecheck`, `npm test`, `npm run smoke`,
`npm run e2e`, then
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.
Attribute gate-5 errors by baseline comparison at the merge base.

## Post-merge obligations already known

None expected - no new dependencies, no infrastructure, no data backfill (the
spec's 3.5 deliberately declines one).
