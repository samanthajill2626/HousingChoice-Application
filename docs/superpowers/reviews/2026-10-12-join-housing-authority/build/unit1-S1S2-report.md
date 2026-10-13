# Build unit 1 (S1 + S2, app server) - implementer report

- Implementer: Claude Opus 5.5, 2026-10-12.
- Branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
- Start: 6682a697 (clean tree). End: a4212c0e (clean tree). Seven commits, one per task.
- Scope held: exactly the files Tasks 1.1-2.4 name. Nothing in dashboard/, e2e/,
  app/scripts/ or docs (this report is the only docs file, left uncommitted).
- DynamoDB Local: the shared hc-dynamodb-local container was up (`docker ps`); never
  started, stopped or restarted. ALLOW_SKIP_DYNAMO_TESTS was never used: every run
  below is a real globalSetup run.

## Per task

| Task | Commit | RED seen (reason) | GREEN |
|---|---|---|---|
| 1.1 publicOrgList | 96fcef2d | file failed to load: "Cannot find module '../src/services/publicOrgList.js'"; no tests ran; exit 1 (as planned) | test/publicOrgList.test.ts 9/9 |
| 1.2 list router | 5540ab1c | 5/5 failed: "TypeError: (0 , createPublicHousingAuthoritiesRouter) is not a function"; exit 1 (as planned) | test/publicHousingAuthoritiesRouter.test.ts 5/5; regression test/publicIntake.test.ts 30/30 |
| 1.3 mount + harness | bab94cc0 | 5 failed / 32 passed of 37: 404-to-be-200 (x2), 404-to-be-500, "list read 1: expected 429 to be 200", "list read 1: expected 404 to be 200"; origin-secret test and the (PIN) passed (as planned) | publicIntake 37/37; cloudfrontBehaviors 9/9; publicOrgList 9/9; router 5/5 |
| 2.1 shape + D4 | 3d2a0633 | 2 failed / 37 passed of 39: "42: expected 200 to be 400", "unit-flyer: expected 200 to be 400" (as planned) | publicIntake 39/39 |
| 2.2 list check | 6b4bb4e4 | 5 failed / 40 passed of 45: "Springfield Housing Authority: expected 200 to be 400", 200-to-be-400 (x2), "expected peek to be called 1 times, but got 0 times", 200-to-be-500; (PIN) passed (as planned) | publicIntake 45/45 |
| 2.3 onboarding + marker | 7936881b | 8 failed / 46 passed of 54: the edited first test plus 7 new (each on status / housingAuthority / housing_fair_signup_v2); both (PIN) passed (as planned) | publicIntake 54/54 |
| 2.4 audit + log | a4212c0e | 4 failed / 54 passed of 58: the audit toEqual diff shows ONLY `signupVersion` and `housingAuthority` missing from the payload (as planned) | publicIntake 58/58; cloudfrontBehaviors 9/9; publicOrgList 9/9; router 5/5 |

Every RED/GREEN count matched the plan text exactly.

## Gates run by this unit (all bare, output redirected, never piped)

- `cd app && npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`:
  exit 0 / exit 0, after Task 1.3 and again after Task 2.4.
- `npm run typecheck` from the worktree root (end of unit): exit 0.
- `npx eslint` on every .ts file the unit touched or created (the list is
  `git diff --name-only --diff-filter=d 6682a697...HEAD`: app/src/app.ts,
  app/src/routes/public.ts, app/src/services/publicOrgList.ts,
  app/test/helpers/twilioWebhookHarness.ts, app/test/publicHousingAuthoritiesRouter.test.ts,
  app/test/publicIntake.test.ts, app/test/publicOrgList.test.ts): exit 0, no output. No
  baseline comparison needed.
- `cd app && npx vitest run test/cloudfrontBehaviors.test.ts` (end of unit): 9/9, exit 0.
- ASCII: both new source/test files print 0 with the `tr` count; every commit's added lines
  counted 0 non-ASCII. Non-ASCII LINE counts versus 6682a697: public.ts 26 -> 24 (exactly the
  two em-dash create-comment lines Task 2.3 step 4 replaces), app.ts 19 -> 19,
  publicIntake.test.ts 26 -> 26, harness 54 -> 54. A fixed-string search for a literal
  backslash-u finds 0 in all four files, before and after.
- `grep -n needs_review app/src/routes/public.ts`: exactly three hits (public.ts:23 header,
  :334 new comment, :339 status expression), as Task 2.3 step 4 expects.

## Divergences from the plan text

- MERGE_HEAD check: used `test -e "$(git rev-parse --git-path MERGE_HEAD)"` (rules file and
  adjudication S5S6-F1), not the plan section 0 `.git/worktrees/...` path. Printed
  "no merge in progress" before every commit.
- No code divergence. Every Edit anchor was found once and applied verbatim. Task 2.3 step 4
  (the em-dash comment, public.ts:252-256 on main, :328-332 at the time of the edit) was
  copied from Read output, not retyped.
- Additional check (not in the plan): before keeping Task 2.3's new create comment, confirmed
  its two factual claims against the code - a manual tenant create starts 'onboarding'
  (app/src/routes/contacts.ts:940,956) and stamps no status_source
  (app/src/routes/contacts.ts:947). Both hold.

## "Matches the plan but..." remarks (findings for the reviewer)

1. LOW, comment precision. The `PublicRouterDeps.orgListRepo` doc comment
   (app/src/routes/public.ts:210-213) says app.ts hands "the SAME repo" to
   createPublicHousingAuthoritiesRouter. That is true only when a repo is injected (the test
   harness). In production `deps.public` carries no orgListRepo, so app.ts:182 passes none
   and each router builds its own `createOrgListRepo` default (public.ts:234 and :490). The
   two instances are stateless peek readers with no cache, so behavior is identical; only the
   wording overstates it.
2. INFO. HEAD /public/housing-authorities is answered by Express's GET route, so it passes
   the 60/min limiter and performs the read (body discarded). Consistent with D1/D2 (it is
   the same route); noted alongside AR-4's OPTIONS precision.
3. INFO. The D3 list check (public.ts:293-299) runs before the unit read and before
   `contacts.findByPhone`; since D4 is decided in the parser, a request carrying a unitId
   never reaches the list read. Matches D3/D4 and the "(PIN) reads no list" test.
4. INFO. The in-memory fallback (app/src/services/publicOrgList.ts:28-30) mints fresh random
   orgIds on every call. Only names leave either public use, so this is invisible, but no
   caller may rely on those ids.
5. INFO, test-reading trap. Task 2.4's RED headline reads "expected [ { ...(5) } ] to deeply
   equal [ { ...(3) } ]", which looks like an extra audit-event key. The full diff shows the
   only differences are the two missing payload keys; GREEN confirms the event has exactly
   entityKey/event_type/payload under toEqual.
6. INFO. Exact-match is strict on internal whitespace: the body trim removes only leading and
   trailing space, so "Atlanta  Housing Authority" (double space) is
   housing_authority_not_listed. This is D3 as written ("character-for-character").

## Next step

Unit 1 (S1 + S2) is complete at a4212c0e. The orchestrator commits this report, then
dispatches S3 (dashboard, Tasks 3.1-3.6). The server contract S3 consumes is as the plan's
"Notes for the planner" state: GET /public/housing-authorities -> 200 { names } with
Cache-Control: no-store, 429 { error: 'rate_limited' } + Retry-After past 60/min/IP, generic
500 on a read failure; POST /public/housing-fair -> 400 { error: 'housing_authority_not_listed' }
for an unlisted name, 400 { error: 'invalid request' } for a bad shape or unitId + authority.
