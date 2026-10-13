# Plan review R1 - reviewer A (adversarial, plan-blind to rationale)

Plan: `docs/superpowers/plans/2026-10-12-join-housing-authority.md` (as committed @59a725f2)
Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md` (rev 4)
Repo read at the worktree HEAD (59a725f2, base 19607658); main read at 5c0d3f6a.
Read-only review: files read and grepped; nothing run.

## Summary

The plan is unusually complete. I walked every spec decision (D1-D11),
section 6 and section 7 to a task, and checked every edit anchor, import,
signature, helper and RED/GREEN claim I could against the code. Nearly all
of them hold (see "Verified" at the end). I found no BLOCKING defect. The
findings below are one MEDIUM gap a context-free builder cannot execute
literally, and four LOW items.

## Findings

### F1 [MEDIUM] Task 6.3's backfill rehearsal has no executable steps

What is wrong. Task 6.3 requires, in the handback, "the backfill rehearsal
on that lane (`--env local --lane <L>`, dry run then `--apply`, with
pre-change-shaped leads written directly), its output verbatim". No task
says how to do it:

- how the builder learns `<L>` for the session it booted (the lane number is
  never named; S5 only greps the log for a readiness line);
- how to "write pre-change-shaped leads directly" into the lane. No app path
  can create one (every new sign-up gets the marker - plan Task 2.3, spec
  D10), no seed writes `capture_source: 'housing_fair'`
  (`app/src/lib/seed/cast.ts:159` is the only seed capture_source), and no
  dev seam creates a raw contact: the dev router's routes are
  `app/src/routes/dev.ts:208-1292` (ping, logtail, dev-login, reseed, ticks,
  fixtures, `/__dev/org-fixture` which only SETs an org field on an existing
  record). The builder must hand-write a PutItem against DynamoDB Local with
  the lane's prefix `hc-local-<L>-` AND the lane's access key (the lane
  selects its own database: `app/scripts/lib/stageClient.ts:65-74,122-126`),
  plus the audit rows for a left-out lead if the rehearsal is to show the
  left-out list;
- the shape of a "pre-change lead" (the Task 4.3 test's `World.lead()` is the
  only definition, and it lives in a test file).

Evidence. Plan section 9, Task 6.3, bullet 4; spec D10 last bullet ("the
rehearsal and the script test write pre-change-shaped leads directly").

What it implies. A builder executing literally either improvises ad hoc
DynamoDB code against a live lane (with real risk of writing to the wrong
database/prefix - a bare `--env local` is the human's live stack, which the
RUNBOOK itself warns about), or skips the rehearsal and hands back without
it. Fix: add a concrete step (find L from the session log/lane file, a short
committed-or-scratch tsx snippet that Puts N leads with the exact `World.lead`
shape through `resolveStageClient('local', {}, { lane: L })`, then the two
CLI runs).

### F2 [LOW] S5's readiness probe matches a line printed BEFORE the stack is ready

What is wrong. "Lane rules for Tasks 5.1 and 5.2", step 3: wait until
`grep -n "web :" .../e2e-session-s5.log` prints "the launcher's readiness
line". The launcher prints `starting app, worker, web :<port> (non-watch)...`
at `scripts/e2e-session.mjs:750`, BEFORE `waitForHealth()` and the clean-slate
reseed; the real readiness line is `ready - app :... web :...` at `:766`.
Both contain `web :`.

What it implies. A literal builder starts the targeted Playwright run while
the app/Vite are still booting; the reused-server preflight or Playwright's
webServer probe then fails or races. Grep for the `ready` line instead.

### F3 [LOW] The CLI's exit-code wiring is "tested" only by source-text greps

What is wrong. Task 4.5's third CLI case reads the script source and asserts
substrings (`'process.exit(2)'`, `'process.exitCode = backfillExitCode(report)'`,
`'err instanceof BackfillRefusedError'`, ...). Nothing ever executes the CLI
block, so spec D10's exit codes (0 clean / 1 refused, failures, unresolved
target / 2 usage) are never observed; a reformat or a rename breaks the test
while a real wiring bug (e.g. the refusal branch setting exitCode 0) would
pass as long as the strings exist.

Evidence. Plan Task 4.5 Step 1(b) third `it`; the guard
`invokedDirectly` (Task 4.5 Step 3) keeps the block from running under
vitest.

What it implies. D10's exit-code contract is only proven by the (itself
under-specified, F1) rehearsal. Acceptable if F1 is fixed and the handback
records the observed exit codes; otherwise D10's exit codes ship unobserved.

### F4 [LOW] The S6 main sync WILL conflict in RUNBOOK.md (not "likely")

What is wrong. Task 4.6 anchors on the exact line
`### Caseworkers (\`feat/caseworkers\`): NOTHING is owed at deploy - ...`
and inserts the new section immediately above it. Main has already rewritten
that heading (`794de277`: now `... DEPLOYED dev + prod 2026-10-12 (release
1.5.1) - nothing was owed; ...`, main RUNBOOK.md:450) and added a paragraph
under it. An insertion directly adjacent to a line the other side modified is
a textual conflict, so Task 6.1's merge stops on RUNBOOK.md every time.

Evidence. `git diff 19607658 main -- RUNBOOK.md`; plan Task 4.6 Step 1; plan
Task 6.1 step 4 lists RUNBOOK.md only as a "likely" overlap. (The other two
files main touched that the plan edits - `app/test/publicIntake.test.ts`
mid-file at ~:299 and ~:366, and `public-pages.spec.ts` :175-370 - do not
overlap the plan's edits and should merge clean.)

What it implies. Handled by 6.1's generic "preserve both sides" rule, but a
builder should be told it is certain and what the resolution is: keep main's
new Caseworkers heading and paragraph, with the backfill section above it.
Also: the plan names `app/src/routes/public.ts` and `app/src/app.ts` as likely
overlaps; main did not touch either.

### F5 [LOW] Two accepted D10 gaps live only in plan prose, not in docs/issues

What is wrong. "S4 verification notes" accept (1) a lead with
`deleted_at: ''` being a dry-run target and an apply `skipped` forever, and
(2) a post-change re-sign-up landing between a lead's history read and its
write being overwritten with Atlanta Housing Authority. (2) contradicts spec
D10's "it never touches ... a post-change sign-up"; it cannot be closed with
the three spec-bound guards (D6 writes nothing to the contact, so there is no
attribute to condition on), so accepting it is reasonable - but AGENTS.md
routes known gaps to `docs/issues/`, and the plan files nothing.

What it implies. The gap is invisible to the operator and to tracker #6's
author once the plan is frozen. File one issue (or add the window to the
RUNBOOK entry's caveats) in Task 4.6.

## Coverage walk (spec -> task)

- D1 list read: 1.1 (source, never writes, names/sort), 1.2 (route,
  no-store, 500), 1.3 (full app, stored list, no leakage, origin secret).
- D2 own limit + mount: 1.2 (60/min, per client), 1.3 (mount before the
  shared limiter; independence both directions; OPTIONS note = AR-4).
- D3 shape 2.1; list check 2.2 (unlisted, spelling, case, agency, 120-char,
  existing phone, stored list governs, peek-only, 500, no read when absent).
- D4 2.1 (shareable, missing, non-shareable; unit never read).
- D5 2.3 (onboarding + authority + marker; null unitId; padded; flyer
  needs_review + marker for shareable, missing, non-shareable).
- D6 2.3 PINs (welcomed and never-welcomed existing phones).
- D7 2.4 (audit signupVersion/housingAuthority incl. existing phone and
  flyer; withAuthority log key, name never logged).
- D8 3.1-3.5 (select, help, order, default rule, loading/disabled, 10 s
  timeout, failed note, Not sure sends nothing, not-listed recovery with
  Choose one, 429 copy, flyer unchanged); e2e 5.1.
- D9 3.6 (+ e2e 5.1: empty form, consent unchecked, focus, kept choice, no
  re-read; re-read after a failed read).
- D10 4.1-4.5 (every rule, refusal, guard, warning, exit code); rehearsal F1.
- D11 4.6.
- Section 6: every bullet mapped (plan's own table for S1/S2 is accurate).
- Section 7: publicApi 3.1; public.ts header/comment 2.3; steps.ts and
  tenant-onboarding note 5.2 (the plan correctly retargets the steps.ts edit
  to `openSelfServedContact`'s docblock, `e2e/scenarios/steps.ts:969-974`);
  STATUS-MODEL and sequence-diagram-to-test 5.3; publicIntake assertion 2.3;
  perf templates: AR-3, justified (`/join` is not a measured page; only an
  undeclared `/api/*` path is `unmatched_api`, `e2e/performance/templates.ts`
  ~:285-303); RUNBOOK 4.6.

## Mutation surfaces / readers enumerated (no omission found)

- `capture_source: 'housing_fair'`: written only at `app/src/routes/public.ts:268`
  (grep of app/src, app/scripts, seeds, dev routes, e2e). Auto-capture writes
  `inbound_sms`/`inbound_call` only (`app/src/services/contactCapture.ts:49`).
- `housing_fair_signup_v2`: only the create in public.ts; no code path
  rewrites a whole contact item (create/createIfAbsent/pointer Puts only;
  every other write is an UpdateItem), so the marker cannot be dropped.
- Contact `housingAuthority` writers and their audit: staff PATCH
  (`routes/contacts.ts:653-657`, append `:1950`), caseworker conversion
  (`services/caseworkerConversion.ts:555-565`, `fields: Object.keys(patch)`
  `:592`, append `:426`), AI extraction (`services/extraction/apply.ts:505`),
  accepted suggestion (`services/suggestionResolution.ts:328-351`, item built
  by `repos/suggestionResolutionRepo.ts` with an ISO-prefixed ts), org rewrite
  (`services/orgRecords.ts:618-628`), cleanup (`scripts/clean-org-names.ts:734`),
  importer fill-only with no audit (`lib/import/apply.ts:1150-1152`, harmless:
  SET only), dev org fixture (hermetic only). `ai_extraction_demoted` writes
  nothing. The plan's enumeration matches.
- `housing_fair_signup` audit readers: none in app or dashboard besides the
  new backfill (`listByEntity` callers are units/tours/placements/aiRuns only).
- `IntakeForm` renderers: FlyerPage and HousingFairIntake only.
- Vite proxies `/public` wholesale (`dashboard/vite.config.ts` proxy table),
  so the new GET reaches the app in dev and every e2e lane.

## Verified (selected; all against the files cited)

- Every Edit anchor in Tasks 1.2, 1.3, 2.1-2.4, 3.1, 3.2, 3.3, 4.6, 5.1, 5.2,
  5.3 exists verbatim and is unique at the point the task runs (incl. the
  end-of-file anchors chained 1.3 -> 2.1 -> 2.2 -> 2.3 -> 2.4).
- Test counts: publicIntake 29 today (29 -> 36 -> 38 -> 44 -> 53 -> 57),
  cloudfrontBehaviors 9, mutationCatalog 4, tenant-onboarding 6.
- Signatures: `createRateLimit` opts (`middleware/rateLimit.ts:41-52`),
  `buildStartingEntries(now, newId)`, `isOnListFor`, `KINDS_FOR_FIELD`,
  `ORG_NAME_MAX`, `OrgListRepo.peek/get/mutate/putForSeed`, the fake's empty
  start, `contactsRepo.update(id, patch, { expect, notDeleted })` throwing
  `ConditionalCheckFailedException` (`repos/contactsRepo.ts:1458-1580`),
  `ExpectClause` (`:668`), `isOrgRewriteRunning(last, nowMs)`
  (`services/orgNames.ts:153`), `parseStageArgs`/`resolveStageClient`/
  `StageClient` (`scripts/lib/stageClient.ts`), `PHONE_REF_PREFIX`/
  `EMAIL_REF_PREFIX`, `createDocumentClient` `removeUndefinedValues: true`
  (so `lead(..., { captured_at: undefined })` drops the field), `ApiError`
  ctor and `errorFrom` code mapping (`dashboard/src/api/client.ts:13-33,75-83`),
  `request` options shape, `GET /api/contacts?phone=` returning the stored
  item (`routes/contacts.ts:1038-1048`), generic 500 body (`lib/errors.ts`).
- The mutation-catalog scanner is AST-based and accepts
  `request<...>('/public/housing-authorities', { signal })` as `request:GET`
  (not cataloged); test files are excluded from the scan.
- No `exactOptionalPropertyTypes` anywhere, so `keyOf: deps.rateLimitKeyOf`
  and the optional-prop spreads typecheck.
- The e2e preflight compares commits only (not a dirty tree), so Task 5.1's
  temporary `git restore --source=19607658` RED is allowed against a session
  booted at HEAD.
- eslint config: no rule the new code trips (no-unused-vars `_` patterns,
  react-hooks relaxed for dashboard tests; no type-checked rules).
