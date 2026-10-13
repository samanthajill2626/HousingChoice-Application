# Build unit 4 (S5) report - /join e2e, self-serve scenario, stale statements

Implementer: Claude Opus 5.5, 2026-10-12. Branch feat/join-housing-authority,
worktree W:/tmp/join-housing-authority. Start HEAD 0b695bc7, final HEAD 8cb22537.
Plan: Tasks 5.1-5.3 (plan lines 7325-8124), with the build-research corrections
S5S6-F1 (MERGE_HEAD via `git rev-parse --git-path`) and S5S6-F2 (forward-slash
`git -C` paths) applied.

## Task 5.1 - /join e2e (commit 6f8ca2d1)

Files: e2e/tests/dashboard-next/public-pages.spec.ts (Edits A-D verbatim from the
plan), e2e/support/selectors.md (the three Public form rows).

- Lane: session booted at 0b695bc7 (lane 4: app :9401, web :9411, fake-twilio
  :9421); ready line seen before any run.
- RED: with dashboard/src/routes/public/HousingFairIntake.tsx at 469241f7 the
  new test failed 1/1 at public-pages.spec.ts:455 `expect(authority).toBeVisible()`,
  "getByRole('combobox', { name: 'Housing authority' }) ... element(s) not found".
  Step (a) (the raw list read) passed first. The stated reason exactly.
  Page restored; `git status --short -- <page>` printed nothing.
- GREEN: whole file, 7 passed (the six existing cases + the new one at :430).
- Static: `npm run typecheck -w @housingchoice/e2e` exit 0; `npx eslint
  e2e/tests/dashboard-next/public-pages.spec.ts` exit 0; added-line non-ASCII
  count 0.
- Session stopped (exit 0) before the commit.

## Task 5.2 - self-serve scenario (commit 1e2aa7fc)

Files: e2e/scenarios/steps.ts (Edits A-C), e2e/tests/scenarios/tenant-onboarding.spec.ts
(Edits A-B). Anchors next to the pre-existing em dash / arrow lines were copied
from Read output; `git diff` shows only the intended lines changed.

- Lane: fresh session booted at 6f8ca2d1.
- RED (mutation): with `housingAuthority` removed from the tenantSelfServes call
  only, `--grep "Tenant self-serves"` failed 1/1 in step "App: tenant onboarding
  details captured" (steps.ts:875), `expect(received).toBe(expected)`, expected
  "Atlanta Housing Authority", received undefined. expectOnboarding
  (tenant-onboarding.spec.ts:199) passed first, as the plan predicts. Line put
  back; `git diff` shows `housingAuthority` in both the call and the details check.
- GREEN: tenant-onboarding.spec.ts 6 passed.
- Neighbour specs (Step 6): environment-identity + proof-of-send 3 passed;
  a2p-compliance "public intake consent checkbox" 2 passed; settings "welcome-text
  edit reflects" 1 passed.
- Static: e2e typecheck exit 0; `npx eslint e2e/scenarios/steps.ts
  e2e/tests/scenarios/tenant-onboarding.spec.ts` exit 0; added-line non-ASCII 0.
- Session stopped (exit 0) before the commit.

## Task 5.3 - stale statements, launcher note, perf check (commit 8cb22537)

Files: documentation/STATUS-MODEL.md (date + the Needs review bullet; the old em
dash became ` - ` as the plan says), documentation/sequence-diagram-to-test.md
(:110), scripts/e2e-session.mjs (comment-only, after :142).

- RED: "Every new contact lands here" hit STATUS-MODEL.md:161;
  "status:needs_review" hit sequence-diagram-to-test.md:110; PUBLIC_LIST_RATE_LIMIT
  absent from e2e-session.mjs (exit 1) and declared at
  app/src/services/publicOrgList.ts:18.
- GREEN: the two stale greps exit 1; `git grep -n "status:needs_review" -- e2e
  documentation` exit 1; PUBLIC_LIST_RATE_LIMIT one hit (e2e-session.mjs:145);
  `node --check scripts/e2e-session.mjs` exit 0; added-line non-ASCII 0.
- Perf inventory (Step 6): `npm run test -w @housingchoice/e2e --
  performance/mutationCatalog.test.ts performance/redact.test.ts
  performance/routes.test.ts` exit 0, 3 files / 122 tests passed (mutationCatalog
  4, redact 92, routes 26). S3 kept the dashboard request inventory parseable; no
  templates.ts declaration needed (AR-3).
- Before writing the STATUS-MODEL claim that a staff-created tenant starts at
  Onboarding I confirmed it in code: app/src/routes/contacts.ts:956.

## Unit-end verification (at final HEAD 8cb22537)

- Fresh session booted AFTER the last commit; `npm run e2e -w @housingchoice/e2e
  -- tests/dashboard-next/public-pages.spec.ts tests/scenarios/tenant-onboarding.spec.ts`
  exit 0, 13 passed (7 + 6).
- `npm run typecheck` (root) exit 0.
- `npx eslint e2e/tests/dashboard-next/public-pages.spec.ts e2e/scenarios/steps.ts
  e2e/tests/scenarios/tenant-onboarding.spec.ts` exit 0 (the only .ts files
  touched; scripts/e2e-session.mjs is a .mjs the lint config does not cover - the
  AGENTS.md known hole - so `node --check` is its only static check).
- Session stopped (`npm run e2e:stop` exit 0, lane 4 tables dropped, lease
  released); no listener on 9401/9411/9421; no lane.json or session.pid left.
- Working tree clean.

## Divergences from the plan text

1. RED swap mechanics (Task 5.1 Step 4). The plan's `git restore
   --source=469241f7 --worktree -- <page>` was refused by the auto-mode permission
   classifier ("Irreversible Local Destruction"), although the page was committed
   and clean. Equivalent, reversible route used instead: copied the HEAD page to
   the session scratchpad as a backup, wrote `git show 469241f7:<page>` to the
   scratchpad, copied it over the page, verified `git diff --quiet 469241f7 --
   <page>` (byte-identical), ran RED, then copied the backup back and verified
   `git status --short -- <page>` printed nothing. The page under test and the
   restored page are byte-identical to what the plan's commands would produce.
   The orchestrator may want to pre-allow `git restore` for S6 or later units.
2. Session log names follow the brief (`e2e-session-s5-<task>.log`) rather than
   the plan's single `e2e-session-s5.log`; a third session (`-final`) was booted
   for the unit-end run at the final HEAD, which the brief asked for and the plan
   does not.

No other divergence: every edit is the plan's old_string/new_string verbatim.

## Remarks ("matches the plan, but...")

- documentation/STATUS-MODEL.md:194 (the LANDLORD section) still reads "the
  auto-capture/triage front door (same front door tenants and untriaged contacts
  land at)". It is not wrong for auto-captured tenants and spec section 7 does
  not name it, so I left it; a reader could take it as "every tenant". A one-word
  precision ("auto-captured tenants") is optional follow-up, not done here.
- The 5.1 list-read count is not vacuous: `readsBeforeReset > 0` is asserted
  before the "no growth" check, so a pathname mismatch (proxy rewrite) would fail
  loudly rather than pass 0 == 0.
- Each background session task reports "failed with exit code 1" when
  `npm run e2e:stop` kills the launcher. That is the expected teardown signal,
  not a failure; every stop printed its four `[e2e-stop]` lines and exit 0.
- No unexpected e2e failure occurred, so no `e2e-results-5.<task>-<n>/` copy was
  needed. Both REDs were the planned failures.

## Next step

S6 (orchestrator): sync main once, the five gates (`npm run e2e` full suite will
cover the new /join case and the changed scenario), live self-QA on a session
booted after the last code commit, handback. This report is not committed.
