# Planner final independent handback review - Caseworkers branch B

Date: 2026-10-09. Reviewer: the planner (Claude Code, cloud session), acting on
Cameron's request to perform the final independent planner review from the
GitHub checkout of `feat/caseworkers`.

| Item | Value |
| --- | --- |
| Reviewed HEAD | `51a4868c022c52c18cf9fe19cbfd90bcd6971f56` (remote branch tip, verified with `git ls-remote`) |
| Pinned base / remote main | `d874915873a61864f6d051a0a9af3f0bb8e7e6e2` (remote main still names it: 0 commits of drift, branch 140 ahead) |
| Implementation source | `e0da8da38313e9f494d56bbbc96b8a3def720015` |
| Scope vs base | 221 files, +40695 / -852; 150 paths under app/dashboard/e2e |
| `e0da8da3..HEAD` | 11 paths, all Markdown under `docs/issues/` and `docs/superpowers/reviews/` |
| Dependency manifests / lockfile vs base | no change |
| Status | UNMERGED. No merge, deploy, infrastructure action, main sync or branch/worktree cleanup performed. |

## Verdict

**QUALIFIED PASS - ready for Cameron's merge decision, with the qualifications
below.** No new in-scope must-fix was found. The implementation conforms to
spec revision 15 branch B on every path I read and drove.

**Planner validation is COMPLETE WITH ONE EXCEPTION: gate 4 (`npm run e2e`)
could not be executed as specified in this cloud environment** (pinned
Chromium download blocked by egress policy; the committed e2e harness cannot
boot on Linux - a pre-existing defect, not this branch's). A clearly labelled
supplementary full browser run with disclosed local adaptations passed
337/337. It is evidence, not the gate. Every other gate, the live pass and
the source review ran here and are reported with real exits.

Qualifications preserved for the merge decision (none is described as fixed):

1. **Task 10.4 is baseline-red; C6 needs a separate scope decision.** I
   re-ran the populated-picker batch: 6 passed / 1 failed on HEAD and the
   same 6 / 1 at merge base d8749158, identical signature (section 5). C6
   remains unapplied.
2. **R2-ADV-1 (claimed authority accept after conversion) is a new
   parent-deferred P2/med risk without prior human acceptance - and it is
   now REPRODUCED.** The earlier "no executed reproduction" limit no longer
   holds: I executed both schedules against the in-memory harness AND the
   real repositories on DynamoDB Local (section 4). The consequence bounds in
   the adjudication also held: the hidden authority does not reach filter
   blasts (`app/src/services/audienceResolution.ts:149` fences tenants).
3. **The first FINAL2 blank-document browser failure remains unexplained.**
   It did not recur in my supplementary run (the scenario passed in 18.7s),
   which is one more non-reproduction data point on a different platform and
   browser build, not a cause.

Approved limitations remain exactly scoped: the in-flight extraction limit
(R1-ADV-2), the importer read/write race, generic retypes without the
conversion's refusals, tour/placement writers without type checks, imported
unknown thread history, the scan costs, and the A2P question (Sam's).

Planner recommendation (not a gate): R2-ADV-1 is rare (it needs a staff
authority accept claimed concurrently with a conversion, or a crash between
claim and commit followed by a conversion before recovery) and its effect is a
hidden contact field, not a recipient or authorization error, so I do not
judge it merge-blocking. Because it is now deterministic and cheap to pin,
schedule its fix soon after merge rather than leaving it open-ended.

## 1. Method and independence

- Read AGENTS.md, `documentation/FEATURE-DEVELOPMENT-WORKFLOW.md`, the GLOSSARY
  and e2e README sections that applied, `.claude/feature-mission.profile.md`,
  spec revision 15 (sections 1-6, D16-D22, 9-12), plan sections 0-3, the
  mission block, the handback, both adversarial reviews, the R2 adjudication
  and its independent response, conformance R2, fix wave 1, completion gates
  R2, self-QA, the C6 proposal, the picker baseline, the landlord-gate
  diagnosis and the three open issues named in the handback.
- Builder and reviewer results quoted from those records are HISTORICAL
  REPORTED EVIDENCE (Windows workstation). Everything in sections 3-7 is a
  check I executed in this Linux container unless marked otherwise. Raw
  builder artifacts under `.superpowers/` were not available and were not
  inspected.
- No product source, test, spec or plan file was changed on the branch. All
  temporary probes and harness patches lived in my scratchpad or in two
  detached scratch worktrees, and the feature checkout stayed clean.

## 2. Environment preparation (disclosed adaptations)

| Prerequisite | State in this container | What I did |
| --- | --- | --- |
| Node 24 | Node 22.22 preinstalled | Installed Node 24.21.0 (npm 11.19.0) beside it; all gates ran on 24.21.0. |
| Docker | client present, daemon not running | Started `dockerd`; DynamoDB Local and MinIO containers ran locally. |
| Terraform >= 1.15 | absent | Installed Terraform 1.15.6 (template evaluation only; no init, plan or apply). |
| MinIO image (LFS) | pointer only | `git lfs pull`; SHA-256 `ff5c117e...6ace`, 62259712 bytes, matched; `docker load` -> `minio/minio:latest` (amd64). |
| `npm ci` | - | EXIT 0. npm 11 skipped three postinstall scripts (esbuild, protobufjs); esbuild verified working. |
| `db:start` / `s3:start` | - | Both EXIT 0. |
| Pinned Playwright Chromium (1.61.0 -> chromium-1228, Chrome 149) | NOT AVAILABLE | `npx playwright install chromium` EXIT 1: `cdn.playwright.dev` is denied by this environment's egress policy (403). Not routed around. The container ships Chromium 141 (chromium-1194). |
| AWS credentials | the container exports `AWS_ACCESS_KEY_ID=proxy-injected` (+ secret) | Unset for every test run. An exported key overrides per-file DynamoDB keys (`app/test/setup/dynamoAccessKey.ts:118-120`). My first `npm test` attempt started before I noticed and was KILLED unfinished; it is not counted. |

Browser substitution for the supplementary run and the live pass: a
scratchpad `PLAYWRIGHT_BROWSERS_PATH` whose chromium-1228 paths symlink to the
preinstalled Chromium 141 build, and (for the Playwright MCP, which expects
chromium-1247) a temporary symlink I added and removed afterwards. A probe
confirmed launch, role-based clicks, video and tracing on that build.

## 3. Completion gates executed here

All from the repository root with `CI=1`, AWS keys unset, bare commands,
output redirected to files (never piped), exits recorded.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | **0** | All five workspaces (app incl. scripts and test configs, dashboard, e2e, fake-twilio, fake-twilio-web). |
| 2 | `npm test` | **1** | 738 files: 736 passed, 2 failed. Tests: 14375 passed, 2 failed, 2 skipped. No `[dynamoAdmin]` line. Both failures pre-existing and environmental - see 3.1. |
| 3 | `npm run smoke` | **0** | `smoke-dist: OK - 1649 import specifier(s) across 286 emitted file(s) resolve under plain Node.` |
| 4 | `npm run e2e` (with `timeout 2700`) | **1 - NOT A TEST RESULT** | Config load failed before any test: `SyntaxError: Unexpected end of JSON input` at `e2e/playwright.config.ts:60`. Gate 4 is UNRUN as specified - see 3.2. |
| 5 | `npx eslint` on the 142 changed TS/TSX paths vs d8749158 | raw **1**; ratchet **PASS** | 5 errors, 0 warnings, all `react-hooks/set-state-in-effect`: `BroadcastComposer.tsx:204,229,248,263` and `ContactsList.tsx:184` (base :148). The same command on the 119 of those paths that exist at the base reports the same 5; full messages are identical after normalizing only line/column numbers. 0 new. The scope holds no JS file, so the no-JS-rules hole does not apply. |

Per-workspace for gate 2 (HEAD):

```text
app:             Test Files 2 failed | 433 passed (435); Tests 2 failed | 9116 passed | 1 skipped (9119)
dashboard:       Test Files 234 passed (234);            Tests 4370 passed | 1 skipped (4371)
e2e unit:        Test Files 22 passed (22);              Tests 503 passed (503)
fake-twilio:     Test Files 34 passed (34);              Tests 275 passed (275)
fake-twilio-web: Test Files 13 passed (13);              Tests 111 passed (111)
```

Totals reconcile with the builder's 14379 cases (14378 passed + 1 skipped on
Windows). The app skip is the same optional built-dashboard diagnostic (no
`dashboard/dist`). The extra dashboard skip is
`dashboard/src/routes/inbox/inboxTime.test.ts:54`, which skips itself on a UTC
runner by design (untouched by the branch).

### 3.1 Gate 2 failures: re-run-and-compare (AGENTS.md)

| File | HEAD full | HEAD alone x2 | Base alone | Base full suite |
| --- | --- | --- | --- | --- |
| `app/test/setup/dynamoAccessKeyGuard.test.ts` ("same id regardless of path casing") | fail | fail, fail | fail | fail |
| `app/test/voicemailGreetingRoutes.test.ts:249` ("every refusal DRAINS the body ... keep-alive") | fail | fail, fail | fail | fail |

Base full suite at d8749158 (detached scratch worktree, own `npm ci`): EXIT 1,
app 2 failed / 427 passed (429 files), 8780 passed / 2 failed / 1 skipped;
dashboard 229 files, 4201 passed / 1 skipped; e2e unit, fake-twilio and
fake-twilio-web identical to HEAD. The failing-file sets are identical and
neither file nor its subject code is touched by the branch.

Causes (pre-existing, Linux-specific): the path-casing test uppercases an
absolute path, which on a case-sensitive filesystem names a different
directory, so `path.relative` walks out of the repo (expected
`../housingchoice-application/...`, received `../../../home/user/...`). The
voicemail test receives `reusedSocket: false` with the expected 413 and 200
statuses. Both pass on the builder's Windows runs. Not a branch regression.

### 3.2 Gate 4: why the bare command cannot run here

Pre-existing Windows-only assumptions in the committed e2e harness (none
changed by this branch):

- `e2e/support/lane.mjs:423`, `app/scripts/db-create.ts:94`,
  `app/scripts/db-update-gsis.ts:233` detect CLI mode by comparing
  `import.meta.url` with `` `file:///${argv[1]}` ``. On POSIX that yields
  `file:////home/...` and never matches, so `lane.mjs` prints nothing (the
  config's `JSON.parse` fails) and the two table scripts silently do nothing
  when the session spawns them. `scripts/db.mjs:263` and
  `app/scripts/s3-create.ts:68` already use `pathToFileURL` correctly.
- `scripts/e2e-session.mjs:512` locates npm at
  `<node dir>/node_modules/npm/bin/npm-cli.js` (the Windows layout).

Combined with the blocked pinned browser, the specified gate is unexecutable
here. I did not edit the feature checkout to force it.

### 3.3 Supplementary full browser run (evidence, NOT gate 4)

In a detached scratch worktree at HEAD 51a4868c with its own `npm ci`, I
applied a temporary one-line POSIX fix to each of the three CLI checks above
(`file://` plus a leading `/` only when argv[1] lacks one), mirrored the
Windows npm layout with a symlink inside my own Node install, and pointed
Playwright at Chromium 141. App, dashboard, fake-twilio and every spec file
were byte-identical to HEAD. Then `CI=1 E2E_TRACE=1 timeout 2700 npm run e2e`:

```text
EXIT 0 - 337 passed (38.5m)
results.json stats: expected 337, unexpected 0, flaky 0, skipped 0, duration 2308.7s
```

Lane 1 ports 9101/9111/9121/9131 were free afterwards and no harness process
remained. `tests/scenarios/landlord-onboarding.spec.ts:119` (the FINAL2
blank-document case) passed in 18.7s. Caveats: Chromium 141 is not the
pinned Chrome 149, the harness carried my local patches, and `E2E_TRACE=1`
adds overhead; wall clock (38.5m vs the builder's 23.2m) is not comparable.

## 4. R2-ADV-1 reproduced (new executed evidence)

Two temporary vitest files were copied into `app/test/`, run, and deleted
(the tree was verified clean after each; they are not committed). Both drive
the real `suggestionResolution` service through its existing
`afterBoundary('claimed')` hook, then the real caseworker conversion, on a
tenant with no authority and one pending `housingAuthority` suggestion
naming "Atlanta Housing Authority".

| Run | Harness | Exit | Schedule A: claim paused, convert (200), resume | Schedule B: crash after claim, convert (200), recover |
| --- | --- | --- | --- | --- |
| route level | FakeWorld via the HTTP routes | 0 | accept answers 200; contact ends `partner` / `Caseworker` with `housingAuthority: "Atlanta Housing Authority"` and AI `housingAuthority_source`; journal completed | ordinary `GET .../suggestions` recovery applies the same authority and provenance; journal completed |
| service level | real repositories on DynamoDB Local (prefixed throwaway tables, dropped after) | 0 | `resolve` returns `completedNow: true`; same final state | `recoverAbandoned` returns `recovered: 1`; same final state |

In every case `caseworker_conversion` is present, and a second `make` (the
repair path) returns 200 and leaves the authority in place. This confirms the
source-derived schedule in `code-review-adversarial-r2.md` exactly, including
the recovery path and the make-again limit. Remedy until fixed: clear it with
`PATCH /api/contacts/<id> { "housingAuthority": "" }`, the same manual step
RUNBOOK gives for the extraction limit. RUNBOOK's "What the conversion does
not fence" paragraph names only the extraction writer; adding this second
writer there belongs with the R2-ADV-1 decision.

## 5. Task 10.4 populated-picker batch, re-run

Same seven cases as `S10-recipient-picker-baseline.md`, `E2E_TRACE=1`, same
substituted browser and harness patch, each in its own scratch worktree:

| Revision | Exit | Result | Failing case |
| --- | --- | --- | --- |
| HEAD 51a4868c | 1 | 6 passed / 1 failed (1.8m) | `matching-entry-points.spec.ts:192`, click at `:228`: "element is outside of the viewport", 60s budget |
| merge base d8749158 | 1 | 6 passed / 1 failed (1.8m) | identical |

The HEAD failure screenshot shows the "Add a tenant" input at the bottom of
the 1280x720 viewport with its listbox offscreen. This adds the final synced
base as a baseline (the earlier one was 1861e154). Task 10.4 stays PARTIAL.

## 6. Independent source review

I read the riskiest diffs myself rather than relying on the reviews:

- `app/src/services/caseworkerConversion.ts`: subject domain (pointer rows,
  non-ContactType and deleted -> 404, team_member -> 400), ordered refusals
  including deleted units, agency-first derivation with D13-limited carry,
  dirty-only request organization through D5, one commit write guarded on the
  raw revision, the three org fields as read and `notDeleted`, then
  best-effort steps 2-4 logged at error, repair path, and `dismiss` without a
  revision bump. Conforms to D19/D21/D22.
- `app/src/routes/contacts.ts`: the merged-kind 409, the CF-1 classification
  fence ANDed with the staff-note guard, conflict re-read ordering before any
  post-write effect, server-owned-key refusals on POST and PATCH, the D5
  organization check, and `type_source` stamping. The extraction of the
  PATCH side effects into `app/src/services/contactClassification.ts` is
  behaviour-preserving (same drain loop, verdict rule and warnings).
- `app/src/repos/contactsRepo.ts`: multi-clause guards with distinct
  placeholders (a clause may guard an attribute the same write REMOVEs), the
  no-op path honouring every guard, and `findAllByPhone` / `findAllByEmail`
  walking the index to exhaustion and resolving pointers.
- Shares: one tenant-or-partner predicate for seeds and explicit recipients,
  tenant-only voucher facts, `conversationTypeFor` at both mint sites, the
  consent gate unchanged, the filter audience still tenant-only, and the
  recipients projection carrying `type` / `role`.
- Importer `type_source` guard, org rewrite target kinds across both lists,
  `/check` `kinds` validation, possible-caseworkers signals, the strict
  review-route parser, the dialog's dirty-only organization, KindPicker
  gating, and ContactDetail's generation-bound dialog and type-keyed facts.
- Every added line in the branch diff is ASCII (0 non-ASCII bytes).

Findings: none new in scope. One documentation note (non-blocking): the
RUNBOOK gap in section 4.

## 7. Planner live browser pass

Hermetic lane 16 (`/__dev/ping`: `dev:true`, `tablePrefix hc-local-16-`,
`appCommit 51a4868c`), standalone `e2e:session` in the scratch HEAD worktree,
driven personally through the Playwright MCP after the full run had drained.
Live ports 5174/8080 were never touched. Run-unique stamp `Plnr57923`; seeded
Tasha and Marcus were preview-only and verified unchanged.

- **Conversion of an existing tenant** (own fixture: Atlanta Housing
  Authority, agency HOPE Atlanta, staff note, consent, minted `tenant_1to1`).
  The ordinary page mount issued no preview or Possible request; More actions
  offered Make caseworker; the dialog (viewed at 1280 and 375) listed both
  removals, "1 conversation will become a partner conversation", the
  stays-on-record note, and pre-filled Organization "HOPE Atlanta" (agency
  first, list match). At 375px the dialog measured x 16 / width 343 and the
  document scrollWidth was 375. Confirm sent exactly `{"action":"make"}`.
  Stored result: partner / Caseworker / active / `type_source: manual`,
  organization "HOPE Atlanta", authority and its source absent, agency `""`,
  staff note intact, `caseworker_conversion` holding both removed values,
  `fromType: tenant` and `by: user-0002`, and the SAME conversation id now
  `partner_1to1`. The partner page showed the Caseworker chip, the
  organization facts line, Role / Organization, Staff notes, Properties sent
  and a "Status -> Active" milestone; More actions no longer offered Make
  caseworker.
- **Share to the converted caseworker** (not covered by the builder's QA,
  which used a newly created caseworker): Properties sent -> Send seeded the
  composer; Review listed one checked named recipient with no voucher facts
  and "Send to 1 recipient". Fake Twilio holds exactly one outbound to that
  number with the address and flyer link; results: sent, audience 1,
  delivered 1, failed 0. The send reused the re-typed `partner_1to1` thread.
  The property page shows "Sent to 1 recipient" in Activity and a "Sent to"
  card whose row is labelled Caseworker; the recipients wire row carries
  `type: partner, role: Caseworker`. The one console error was the known
  best-effort post-send draft `DELETE` answering 409.
- **Caseworkers page**: the converted contact under an "HOPE Atlanta (1)"
  chip. Possible caseworkers showed seeded Renee Carter and my role-less
  partner ("Partner with no role"); Not a caseworker -> "Hide ... from
  Possible caseworkers?" -> Hide removed only my row, stored
  `caseworker_review: dismissed` with no classification revision.
- **Refusal**: Tasha's dialog showed "Finish or close this contact's
  placement first. View placement" with Make caseworker disabled; cancelled.
  Marcus's preview (API, read-only) returned three landlord-of-record
  refusals.
- **Guards**: an existing tenant's edit form offers Tenant, Landlord,
  Partner, Property Manager, Other (no Caseworker); cancelled. On a fresh own
  tenant the PATCH answered 409 `caseworker_use_conversion` both for
  partner+Caseworker at once and for the "Partner first, then role" path; the
  generic retype stamped `type_source: manual`; client `type_source` and
  `caseworker_conversion` were refused 400; an off-list organization answered
  422 `org_not_on_list` without `otherKind`; the spelling "Travelers Aid"
  stored "HOPE Atlanta". Usage for HOPE Atlanta: organization 2,
  `inUse.active` 2, `kindLocked.active` 0.
- Benign observations: two unauthenticated `/auth/me` 401 probes before
  sign-in; one dev-server module request aborted by my own navigation (the
  next document loaded and rendered normally); the StrictMode duplicate
  preview request (one aborted, one 200).
- Teardown: `npm run e2e:stop` EXIT 0, lane 16 tables dropped, ports
  10601/10611/10621/10631 free, no session process left. Screenshots I viewed
  (gitignored, not committed): `planner-qa-dialog-desktop.png`,
  `planner-qa-dialog-375.png`, `planner-qa-partner-page.png`,
  `planner-qa-caseworkers-page.png`, `planner-qa-tasha-refusal.png`,
  `planner-qa-tasha-edit.png`.

## 8. Not run, unavailable, or out of scope

- Gate 4 as specified (section 3.2). Pinned Chrome 149 never ran here.
- No re-run of the builder's Windows-specific checks; the original FINAL2
  artifacts, the unapplied C6 patch and other ignored files were not
  available and were not inspected.
- No deployment, infrastructure, Terraform init/plan/apply, secret, SSM, real
  environment file, main sync or merge. No branch or worktree belonging to
  the mission was removed.
- The pre-existing Linux harness and test defects in 3.1 and 3.2 are outside
  this branch; they were offered to Cameron as a separate follow-up task
  rather than filed or fixed here.

## 9. Owed operator actions (unchanged)

Deploy only after the human merge: no Terraform, table, index, secret, script
or backfill. RUNBOOK documents the conversion repair and mistaken-conversion
restoration. The A2P coverage question for property shares to caseworkers
stays with Sam.

Single-line PowerShell merge for Cameron (from the shared main checkout, when
he decides to merge; main has not moved since the branch's one sync):

```powershell
git fetch origin; git switch main; git merge --ff-only origin/main; git merge --no-ff origin/feat/caseworkers -m "Merge feat/caseworkers: caseworkers (branch B)"
```

## Addendum (2026-10-09, later): Linux harness fixes merged, gates re-run

At Cameron's request I merged `claude/ecstatic-edison-1r1s10` (another
agent's Linux harness work, cut from the same base d8749158) into this branch:
merge `9481ecf5` (seven commits) and merge `e156aafb` (one later docs commit,
`5e71cb3f`). Sections 1-9 above stay as written; they describe HEAD 51a4868c.
This addendum supersedes their gate-2 and gate-4 outcomes for the merged branch.

### What the merge brings (reviewed before merging)

- One shared run-as-CLI check (`scripts/lib/cliEntry.mjs`, `pathToFileURL`,
  as `scripts/db.mjs` already did) for `e2e/support/lane.mjs`,
  `app/scripts/db-create.ts` and `app/scripts/db-update-gsis.ts`, with
  `app/test/cliEntry.test.ts` pinning both path flavours.
- `scripts/lib/npmCli.mjs`: `npm_execpath` first, then both Node layouts,
  with `app/test/npmCli.test.ts`. Used by `scripts/e2e-session.mjs`.
- `dynamoAccessKeyGuard.test.ts`: the casing test now pins the repo-relative
  id portably; the whole-path case is kept but runs only on win32, with the
  reason stated. `voicemailGreetingRoutes.test.ts`: keep-alive reuse is now
  checked by socket identity, not `req.reusedSocket`.
- e2e README Linux status, setup prerequisites, and a "Claude Code cloud
  container (Linux)" section; `.claude/CLAUDE.md` points cloud sessions at it.
- No caseworkers source change; nothing in `app/src` imports the new modules.
  These fixes are now part of this branch's diff against main.

### Gates on merged head 9481ecf5 (no repo patch)

Before any run I removed the npm-layout symlink I had made in my own Node
install, so the npm-locator fix was tested on the real POSIX layout. The
Docker daemon had died while the session idled; I restarted it and the two
containers. AWS keys were unset for `npm test` as before.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | **0** | All workspaces. |
| 2 | `npm test` | **0** | 740 files, all passed. app 437 files, 9130 passed / 2 skipped; dashboard 234, 4370 / 1 skipped; e2e unit 22, 503; fake-twilio 34, 275; fake-twilio-web 13, 111. No `[dynamoAdmin]` line. Skips: built-dashboard diagnostic, the new win32-only casing case, `inboxTime` on a UTC runner. |
| 3 | `npm run smoke` | **0** | 1649 specifiers / 286 files. |
| 4 | `timeout 2700 npm run e2e` | **0** | **337 passed (33.1m)**; results.json expected 337, unexpected 0, flaky 0, skipped 0. The bare command booted on its own: `db:create` ensured 22 tables, the fake-phones UI built through the real npm location. Lane 5 ports free afterwards, no stack process left. |
| 5 | scoped `npx eslint` (152 paths vs d8749158) | raw **1**; ratchet **PASS** | The same 5 pre-existing `react-hooks/set-state-in-effect` errors; 0 new. The 6 merged `.ts` files lint clean; the 4 merged `.mjs` files fall in the documented no-JS-rules hole and were not linted by any rule. |

Gate 4 now ran as the command is written. The one remaining deviation is the
browser: Chromium 141 stood in for Playwright 1.61's pinned Chrome 149 through
a scratchpad `PLAYWRIGHT_BROWSERS_PATH` alias, because this environment forbids
and blocks the browser download. **So the planner validation exception in the
verdict narrows to "the e2e gate has not run on the pinned browser build."**

Also validated on the merged head: a standalone `npm run e2e:session` started
with the container's AWS key still exported (it logged `accessKeyId=hclane5`,
`/__dev/ping` answered `appCommit 9481ecf5`), then `npm run e2e:stop` exited 0,
stopped the launcher and children, dropped the lane tables and left all four
ports free with no stack process.

### Correction to section 2

Section 2 says an exported key overrides the per-file keys. That holds, but the
log of my killed first `npm test` attempt shows what this particular value
does: DynamoDB Local rejects `proxy-injected`, the app workspace's globalSetup
failed with `UnrecognizedClientException`, and vitest reported "No test files
found" (exit 1). A key DynamoDB Local accepts would instead collapse every file
onto one database silently. Both cases are now written into AGENTS.md (the
`npm test` gate) and the e2e README cloud section.

### Environment findings now in the docs

Already in the merged branch: Node 24 beside the image's Node 22; starting
`dockerd` by hand; the LFS MinIO image; Terraform; npm 11 skipping the esbuild
and protobufjs install scripts; aliasing the preinstalled Chromium under the
pinned build's paths; running `npm test` without the proxy's AWS key; `lsof`
instead of `ss`.

Added by me in this change: the ambient-AWS-key warning in AGENTS.md beside the
`npm test` gate (loud and silent cases); in the README cloud section, the
daemon dying on idle/resume and the restart steps, the 403 on
`cdn.playwright.dev`, the Playwright MCP's own browser revision and its alias
(verified: the MCP launched through the README's directory-level alias),
gate durations against the 45-minute cap, the by-design skips, and the
standalone teardown validation; and the stale "not yet validated on Linux"
and MCP-pinning bullets under CI readiness.

### Unchanged

The verdict stays QUALIFIED PASS for Cameron's merge decision, with the same
three qualifications: Task 10.4 baseline-red with C6 unapplied, R2-ADV-1
reproduced and parent-deferred, and the unexplained first FINAL2 blank-document
failure. No merge to main, deployment, infrastructure action or cleanup was
performed. The PowerShell command in section 9 still applies.
