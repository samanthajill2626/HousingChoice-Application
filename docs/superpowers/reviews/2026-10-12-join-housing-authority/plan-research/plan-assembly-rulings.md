# Plan assembly rulings (2026-10-12)

The text below is section 4 of the plan as assembled
(`docs/superpowers/plans/2026-10-12-join-housing-authority.md`), kept here as
the mission record of how the four section drafts were reconciled. Writer
findings: `S1-S2-findings.md` (one LOW, F1 -> AR-4). S3, S4 and S5 wrote no
findings file (their code checks found no spec error).

## Assembly rulings (planner, BINDING over the section text below)

Four opus section writers drafted S1-S2, S3, S4 and S5; the planner wrote
S6. The record of these rulings is
`docs/superpowers/reviews/2026-10-12-join-housing-authority/plan-research/plan-assembly-rulings.md`.
Each section opens with its writer's "CONTRACT ISSUES" check; every item
there is resolved here. Where a section's prose and this list disagree,
this list wins.

- AR-1 (S1-S2 contract issue 1, ACCEPTED): Task 1.3 adds
  `orgListRepo: world.orgListRepo` to the harness `public` deps in
  `app/test/helpers/twilioWebhookHarness.ts`, so no harness test builds the
  DynamoDB-backed org list repo. No binding name changes.
- AR-2 (S3 and S4 additive exports, ACCEPTED): S3 adds
  `HOUSING_AUTHORITY_NOT_LISTED` to `publicApi.ts`, an
  `ApiError(0, 'invalid_response')` for a malformed list body, the
  presentational `HousingAuthoritySelect.tsx` (it never fetches), and a
  `.help` CSS class. S4 adds `doc` and `env` to `BackfillDeps` (the
  candidate read is a base-table Scan) and the helper exports its section
  lists. The binding names in section 2 are unchanged.
- AR-3 (perf templates, S3 note vs S5 decision): NO task. S5's evidence
  stands: `/join` and `/p/:unitId` are excluded from the measured registry
  (`e2e/performance/routes.ts:117-118`), only an undeclared `/api/*` path
  becomes `unmatched_api` (`e2e/performance/templates.ts:285-303`), and the
  mutation catalog skips GETs. Spec section 7's perf line is conditional
  ("if a measured page requests it") and no measured page does. Task 5.3
  runs the inventory tests as a check.
- AR-4 (S1-S2 finding F1, ACCEPTED as a spec precision note): Express
  answers `OPTIONS /public/housing-authorities` itself
  (`200 Allow: GET, HEAD`) without reaching either limiter. It reads
  nothing; no task depends on it. Spec D2 carries a one-line note.
- AR-5 (DynamoDB Local): before any `npm run db:start`, check `docker ps`.
  If the shared container is running, do NOT start, stop or restart it
  (AGENTS.md; Cameron's standing rule). `db:start` is only for a container
  that is not running at all. The `ALLOW_SKIP_DYNAMO_TESTS=1` route is for
  the fake-only app test files S1-S2 names; it is never a gate, and a
  SKIPPED DynamoDB-backed test (S4) is never GREEN.
- AR-6 (e2e sessions, S5 note 5): the e2e preflight refuses a session booted
  at a different commit (`e2e/support/preflight.ts:87-128`). Every targeted
  e2e run boots a session at the current HEAD; stop it before each commit;
  S6's live self-QA boots its session after the last code commit.
- AR-7 (the not-listed message, S3 design note): the message is IntakeForm's
  error line and clears on the next text edit or send, not on picking an
  authority. Accepted as written (the spec requires no more).
- AR-8 (order): S1 -> S2 -> S3 -> S4 -> S5 -> S6. S4 is independent of
  S1-S3 but runs after them so its gates see the final app code.
