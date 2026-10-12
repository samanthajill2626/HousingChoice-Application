# Plan review R1 - reviewer B (adversarial, plan-blind)

Plan: `docs/superpowers/plans/2026-10-12-join-housing-authority.md` (assembled 59a725f2)
Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md` (rev 4)
Repo state read: worktree `W:\tmp\join-housing-authority` at 59a725f2; merge base with
main = 19607658; main = 5c0d3f6a (3 commits ahead of the base).
Method: read the whole plan and spec; checked every edit anchor, import, helper,
signature, test count and RED claim I could against the code at the base; grepped the
app, dashboard, e2e, seeds and docs for every reader/writer of the moved state. Nothing
was run except read-only git and grep.

## Summary

The plan is unusually complete. Every spec decision D1-D11, every section 6 bullet and
every section 7 place maps to a task (map below), the code compiles against the real
signatures I checked, the anchors match the files as they will stand at each step, and
the RED claims I traced are red for the stated reason. No BLOCKING or HIGH finding.
The findings are in the operational instructions: the e2e lane readiness check fires
before the lane is ready, the backfill lane rehearsal the spec requires has no
executable procedure, and the S6 sync will hit a predictable RUNBOOK conflict the plan
does not describe concretely.

## Findings

### F1 [MEDIUM] The e2e lane "ready" check matches a line printed BEFORE the lane is ready

What is wrong. "Lane rules for Tasks 5.1 and 5.2", step 3: wait until
`grep -n "web :" ...e2e-session-s5.log` "prints the launcher's readiness line". The
launcher prints `web :<port>` TWICE: first in
`starting app, worker, web :${ports.dashboard} (non-watch)...`
(`scripts/e2e-session.mjs:750`), which is logged BEFORE the app, worker and Vite are
started, before `waitForHealth()` and before the clean-slate reseed (`:751-763`); only
the second, `ready - app :... web :...` (`:766`), means ready.

Evidence. `scripts/e2e-session.mjs:750` vs `:766`. `lane.json` is written at launcher
start (`:91-96`), so `e2e/playwright.config.ts:26-44` adopts the half-booted lane at
once; its webServer has `reuseExistingServer: true` and probes the dashboard URL
(`:200-206`) - if Vite is not up yet Playwright runs its own launcher command on the
same lane, and if Vite is up but the session is still in `cleanSlate()` the run's
preflight `/__dev/reseed` (`e2e/support/preflight.ts:143-150`) races it.

What it implies. A builder executing literally starts Tasks 5.1/5.2 runs against a
booting stack and gets a launcher/lease collision or a reseed race - and the plan tells
it any unexpected failure "is a regression to diagnose". Wait for the `ready` line
instead (e.g. `grep -n "ready .* web :"`; note the real line contains a U+2014 dash, so
anchor on `ready` and `fake-twilio :`), or poll the lane's `/__dev/ping`.

### F2 [MEDIUM] The backfill lane rehearsal (spec D10, last bullet) has no executable procedure

What is wrong. Spec D10: "An agent rehearses it only with `--env local --lane <L>` on a
hermetic lane it started ... the rehearsal and the script test write pre-change-shaped
leads directly." The plan delivers this only as one handback bullet (Task 6.3: "the
backfill rehearsal on that lane (`--env local --lane <L>`, dry run then `--apply`, with
pre-change-shaped leads written directly), its output verbatim"). No task says HOW to
write those leads: which table (`hc-local-<L>-contacts`), which DynamoDB Local database
(access key `hclane<L>`, `app/scripts/lib/stageClient.ts:122-141`), which shape, which
audit rows (a re-sign-up, an authority history), or what the expected report is.

Evidence. Plan Task 6.3 (lines 7916-7918); RUNBOOK text in Task 4.6 repeats the
requirement but also gives no recipe. DynamoDB Local keeps a separate database per
access key (`app/test/helpers/dynamoKeyLedger.ts` header; `stageClient.ts:124`).

What it implies. Improvised seeding is the riskiest step in the branch: written with
the default key (`local`) or the bare `hc-local-` prefix it lands in the LIVE local
stack's database (forbidden: AGENTS.md "Never test ... against the human's live
dashboard/app"; plan section 0), and written under a different key than the script
uses it is invisible, so the rehearsal reports zero candidates and "passes"
vacuously. Add a concrete step (a small seeding command or script using
`resolveStageClient('local', {}, { lane })` so the key and prefix cannot diverge,
plus the expected dry-run lines), or drop the rehearsal claim and say the DynamoDB
Local script test is the proof.

### F3 [LOW] The S6 main sync will conflict on the exact RUNBOOK line Task 4.6 anchors on; the guidance does not say which side's text to keep

What is wrong. Main is already 3 commits past the base (e27868bc, 794de277,
5c0d3f6a). 794de277 rewrote RUNBOOK line 450 - the Caseworkers heading that Task 4.6
uses as its `old_string` and re-emits verbatim after the new section - into
"DEPLOYED dev + prod 2026-10-12 (release 1.5.1) ..." and added a paragraph under it.
Task 4.6 runs before the sync, so its anchor matches, but Task 6.1's merge then has the
branch inserting immediately before a line main changed: a near-certain conflict.

Evidence. `git diff 19607658 main -- RUNBOOK.md` (heading at old line 450);
plan Task 4.6 Step 1; Task 6.1 step 4 lists RUNBOOK.md as a "likely overlap" and says
only "preserve BOTH sides' intent".

What it implies. A resolver that keeps the branch hunk re-introduces the stale
"NOTHING is owed at deploy" heading and drops main's deploy record. Say explicitly:
keep main's new Caseworkers heading and paragraph, with the new /join section above
it. (The same drift also touches `app/test/publicIntake.test.ts` and
`e2e/tests/dashboard-next/public-pages.spec.ts`; by my reading of the hunks those merge
cleanly - main edits the middle of each file, the branch edits the head/end and the
`/join` test - UNVERIFIED until the merge runs.)

### F4 [LOW] S3's "works in PowerShell and in Git Bash" claim is false for its check commands

What is wrong. The S3 header (plan line 2347-2348) says its commands work in both
shells. The ASCII checks (`tr -d ... < file | wc -c`, `git diff ... | grep | tr | wc`)
and the MERGE_HEAD check (`test -e ... && echo ... || echo ok`) are bash-only:
PowerShell 5.1 rejects `<` input redirection and has no `tr`/`wc`/`test`.

Evidence. Tasks 3.1-3.6 Step 4 "ASCII" items and Step 5 item 2.

What it implies. A builder that believes the header and runs them in PowerShell gets a
parser error, not a pass/fail. Say "run the checks in Git Bash" as S4 effectively does.

### F5 [LOW] Task 3.2's lint attribution baseline is the shared main checkout, not the merge base

What is wrong. Task 3.2 Step 4.4 attributes a lint error by running eslint "read-only
in the main checkout (`W:\AI Projects\Housing Choice\HC Application`)". AGENTS.md gate 5
attributes by the MERGE BASE; the main checkout is at main HEAD (5c0d3f6a), not
19607658. S6 Task 6.2 does it correctly (a throwaway detached worktree at the merge
base).

What it implies. Equivalent today (main has not touched the public route files), but
it is a second, divergent baseline rule in one plan, and it sends a child agent into
the shared checkout other agents use. Point Task 3.2 at the S6 method.

### F6 [LOW] Gate 4's `timeout 2700 npm run e2e` can orphan the stack on Windows, and nothing checks after a timeout

What is wrong. Task 6.2 gate 4 checks for surviving listeners only BEFORE the run. In
Git Bash on Windows `timeout` kills the direct child (npm), not the launcher's node
children; AGENTS.md: "`reuseExistingServer` adopts an orphaned stack on a commit match
alone ... After aborting a run, confirm no listener survives on the lane's ports before
starting another." The live self-QA (Task 6.3) boots the next session at the same
commit.

What it implies. If the gate times out, the self-QA lane can silently adopt the
orphaned, already-driven stack. Add: on a timeout, run `npm run e2e:stop` and confirm
the lane ports are free before anything else.

## Coverage map (spec -> task), verified

- D1: Task 1.1 (`loadPublicOrgEntries` peek-else-`buildStartingEntries`, never writes;
  `housingAuthorityNames` kind filter via `KINDS_FOR_FIELD.housingAuthority`, Set
  de-dup, `localeCompare('en', base)` + code-unit tie-break), 1.2 (route, `no-store`,
  500 by propagation), 1.3 (full-app 500 body, origin-secret 403). The twelve-name
  order in the tests matches `app/src/lib/orgStartingList.ts:14-73` under that collation.
- D2: Task 1.2 (route-level `createRateLimit({ max: 60, windowMs: 60_000 })`), 1.3
  (mount before `app.ts:165`; both-direction independence tests; edge guard
  `app/test/cloudfrontBehaviors.test.ts:137-148` still matches the `'/public'` mount).
- D3: Task 2.1 (shape 1-120 after `trimJsonBody`, generic 400), 2.2 (list check via
  `isOnListFor` before the unit read and the phone lookup, only when sent; 500 on read
  failure; existing phone refused too).
- D4: Task 2.1 (parse-time refusal on presence, unit never read).
- D5: Task 2.3 (`status: unitId === undefined ? 'onboarding' : 'needs_review'`, the
  authority only without a unitId, marker on every create; flyer variants pinned).
- D6: Task 2.3 PINs (whole-contact `toEqual` for welcomed and never-welcomed phones).
- D7: Task 2.4 (audit payload and `withAuthority`; harness audit records are exact
  enumerable keys, `twilioWebhookHarness.ts:2616-2630`).
- D8: Tasks 3.1-3.5 (select, default, loading/failed/10 s, StrictMode, abort, not-listed
  "Choose one" recovery, 429 copy, flyer unchanged).
- D9: Task 3.6 (keyed IntakeForm remount, kept choice, re-read only after a failed read,
  focus) and Task 5.1 (no second list read in a real browser).
- D10: Tasks 4.1-4.5. The audit-history rule's event list was checked against every
  contacts audit writer in `app/src` and `app/scripts` (`routes/contacts.ts:1950`,
  `services/caseworkerConversion.ts:426`, `services/extraction/apply.ts:505`,
  `services/suggestionResolution.ts:318-366`, `services/orgRecords.ts` /
  `jobs/orgRewrite.ts:157`, `scripts/clean-org-names.ts:734`); no other writer sets or
  removes `housingAuthority` with an audit, and the importer's fill-only set is
  correctly argued harmless. `contactsRepo.update` guards, `ConditionalCheckFailedException`
  and no `updated_at` stamp match `app/src/repos/contactsRepo.ts:1458-1580`.
- D11: Task 4.6.
- Section 7: publicApi (3.1), route header and create comment (2.3), steps.ts docblock
  and tenant-onboarding note (5.2), STATUS-MODEL and sequence-diagram note (5.3),
  existing publicIntake assertion (2.3), perf templates (AR-3, justified:
  `e2e/performance/routes.ts:117-118`, `templates.ts:285-303`, catalog skips GETs),
  RUNBOOK (4.6).

## Surfaces checked and found covered (no finding)

- Writers of `capture_source: 'housing_fair'`: only `app/src/routes/public.ts:268`; the
  only seed capture_source is `inbound_sms` (`app/src/lib/seed/cast.ts:159`).
- Readers of `housing_fair_signup`: none outside public.ts and its test.
- Readers keyed on tenant `needs_review`/`onboarding`: only
  `services/extraction/apply.ts:535` (spec section 4 already names it).
- e2e specs that hit `/join` or the POST (a2p-compliance, environment-identity,
  settings, proof-of-send, public-pages, tenant-onboarding) assert no status that the
  change moves; exact-count audiences use run-unique authorities (spot-checked
  contacts-list-facets and org-lists).
- `e2e/performance/mutationCatalog.test.ts` scans non-test dashboard files only
  (`:29-42`) and catalogues non-GETs only (`:323-327`); `getHousingAuthorities` is an
  inline-literal GET, so the 120 count holds.
- Harness: `world.orgListRepo` exists (`twilioWebhookHarness.ts:426`, `:2783`); the
  Task 1.3 anchor at `:5434-5436` matches.
