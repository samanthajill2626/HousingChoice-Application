# RD findings - build research, feat/clean-org-names

- Reader: RD (opus), 2026-10-06, read-only.
- Plan range: `docs/superpowers/plans/2026-10-06-clean-org-names.md`
  lines 13675-16211 (S8 importer, S9 intake rule, S10 retire the hand-kept
  lists + checkpoint, S12 seeds, S13 dev seam + checkpoint) and lines
  28047-29736 (S15 cleanup script + RUNBOOK), plus sections 0-3 and 12.
- Base tree: worktree source equals main @d839494a (`git diff --stat
  d839494a HEAD -- app dashboard e2e fake-twilio scripts` is empty).
- Counts: BLOCKER 0, MAJOR 0, MINOR 6.

## What was checked, and how

1. ANCHORS. Every quoted anchor in the range was read against the live file
   (apply.ts, importApply.integration.test.ts, import-apply.ts,
   missedCallAutoText.ts + test, TemplatesSection.tsx + test, the issue doc,
   schema.ts, extractionSchema.test.ts, ContactEditForm.test.tsx, lean.ts,
   cast.ts, live.ts, matrix.ts, performance.ts, devReset.ts,
   seedProfile.integration.test.ts, seedData.test.ts, dev.ts, e2e/README.md,
   RUNBOOK.md) and is present exactly once, including the anchors the
   heuristic did not list (apply.ts:41, :171, :238, :914-924, :484-490,
   :1349-1359; schema.ts:54-82; extractionSchema.test.ts:4-8, :16, :82-112;
   lean.ts:15, :108, :186-187, :525-530; live.ts:46, :102; cast.ts:16;
   matrix.ts:32, :76, :675-676; performance.ts:19; dev.ts:32, :56, :140,
   :1177-1182; README.md:588-590; RUNBOOK.md:420, :1291-1299;
   import-apply.ts:22, :24, :40, :62, :351, :360-361, :376, :414-417). Every
   replace_all target count matches the plan's line lists (lean 4+2, cast
   8+2+1+1, live 5+2, matrix 3+2+1+1+1+1, performance 2+2). Sequence effects
   checked: Task 8.2's anchors survive Task 8.1's edits; S10 item 4b's quoted
   block is byte-identical to Task 8.2's appended text (Task 8.3's block
   follows it, so deleting "blank line + block" leaves one blank line); Task
   15.2/15.3 anchors are Task 15.1/15.2's own new text. The only MISSING row
   in the range (plan:14536) is the "with:" replacement text, not an anchor.
   No MULTI-IN-FILE row falls in the range.
2. SYMBOLS. Existing symbols used by the range exist with compatible
   signatures: `ContactsRepo.getById/update` (contactsRepo.ts:632, :707),
   `UnitsRepo.getById/update` (unitsRepo.ts:333, :340), `isDeleted`,
   `PHONE_REF_PREFIX`, `EMAIL_REF_PREFIX` (contactsRepo.ts:324/:341/:349,
   unitsRepo.ts:285), `AuditRepo.append(entityKey, eventType, payload?)`
   with `actorId` only when `payload.actor` is a string
   (auditRepo.ts:43, :91-98), `parseStageArgs` / `resolveStageClient` /
   `StageClient` (stageClient.ts:186, :112, :76), `createLogCapture`,
   `createLogger({ level, destination })`, `createFakeWorld` /
   `makeWebhookHarness({ world, devRouter })`, `world.contacts` (array) and
   `world.units` (Map), `seedAll(endpoint, profile, namespace)`,
   `createTableNamespace`, `generatePerformanceSeed` /
   `resolvePerformanceSeedConfig`, `matrixItems(now?)`, `castItems()`,
   `PlanResult` / `MergedPerson.airtableTenant.voucherProgram`,
   `parseWorkbook`, `contactIdForPhone`, `getTableSpec('settings' |
   'audit_events')`. A scratch `tsc --strict --noUncheckedIndexedAccess`
   probe of the inference-sensitive snippets (resolveImportedAuthority's
   status narrowing, the tuple inference in `sortEvents(events.map(...))`,
   `{ ...seedOrgListItem() }` as `Record<string, unknown>`, the planners'
   narrowing, the `{ ...build(), ...partial }` deps merge) compiles clean.
3. CONTRACTS. The range uses plan 3.2-3.12 names and shapes exactly:
   `createOrgListRepo({ doc, env, logger })` and `peek()` (S8 CLI, S15),
   `OrgListItem` / `ORG_LIST_SETTING_ID` (S12), `createOrgRewriteService({
   orgListRepo, orgRecords, enqueue, logger })` with `acquireForCleanup` /
   `heartbeat` / `finish` and `OrgHttpError(409, { error:
   'org_rewrite_running', lastRewrite })` (S15 vs Task 3.8 :5933-5966,
   Task 3.10 :6881-6897, Task 3.1 :2816), the 3.7 writers incl. an expected
   `agency: ''` (Task 3.2 :3093-3104) and `rewriteAcceptedAuthorities`
   without `updated_at` (Task 3.3 :3454-3480), the 3.8 audit payload
   `{ field, from, to }`, the 3.12 seam body/route.
4. FALLOUT. S10: every importer/user of `lib/housingAuthority.ts` and of
   `HOUSING_AUTHORITY_VOCAB` across app, scripts, tests, dashboard, e2e,
   fake-twilio, root scripts and docs is accounted for (list in the
   reference file); no live importer remains for S10 - not blocked. One
   plan-introduced comment the S10 guard will flag is not named (RD-1). S12:
   every pinned slug, seed-derived value and count in app/test, dashboard,
   e2e (specs, scenarios, support, performance) and docs was sorted into
   seed-derived (all named by Task 12.2's S14 note or S16) and
   fixture/API-local (owned by S6/S11/S14 and named there); no generic seed
   test breaks on the new `settings` row (seedProfile pk derivation, the
   seedLive id-collision walk, seedMatrix `settingId === 'org'` filters,
   historyItems). S8: `runApply` has one production caller
   (import-apply.ts:354); `ApplyReport` has no other consumer; the only
   imports of the removed re-export are extractionSchema.test.ts:16 and
   importApply.integration.test.ts:21, both named. S9: the intake rule is
   mirrored only in TemplatesSection.tsx + its test + the issue doc. S13: no
   test pins the dev-route list. S15: no scripts registry/README to update.
5. TDD VALIDITY. Every RED step is red for the stated reason (missing
   exports read as undefined under vite-node; the alias map's spellings;
   the missing agency fact; the module-missing seed/guard files); every
   (PIN) is green on base. The fixture really has one property row
   (importPlan.test.ts:195-203) and one UpdateCommand per contact, so
   `unitUpdate` / `contactUpdate` hold. Command cwd: see RD-3.
6. SPEC CONFORMANCE. S8 matches D9 (fill-only HA, agency when absent,
   unresolved values counted in dry runs too, unit ownership rule kept);
   S9 matches D15; S12 matches section 7 (Seeds) and D2; S13 matches
   section 7 (e2e specs) and plan 3.12; S15 matches section 8 and D14 (the
   "agency already that agency is compatible" reading is the plan 3.8
   ruling).

## Findings

RD-1 | Task 10.1 (plan 15138-15185, item 6 at 15305-15313) vs Task 1.5 (plan
1357) | MINOR | The S1 starting-list test adds the comment `// The retired
alias map's raw \`clayton\` (lib/housingAuthority.ts) read as` to
`app/test/orgStartingList.test.ts`. The S10 guard's module-path rule
`/\/housingAuthority\.(?:js|ts)\b/` matches `/housingAuthority.ts)`, so the
guard lists that file too; S10's RED/offender list and run list do not name
it (item 6's comment rule does cover it, so this is not a STOP). | Preferred:
in Task 1.5's test code drop the path, e.g. `// The retired alias map read a
bare \`clayton\` as Clayton County; Cameron's launch-gate ruling`. Otherwise at
S10: rewrite that comment under item 6, stage
`app/test/orgStartingList.test.ts`, and add `test/orgStartingList.test.ts` to
the S10 run command.

RD-2 | Task 10.1 item 5 (plan 15293-15303), item 3 (15232-15255), item 4 last
bullet (15269-15270) | MINOR | Item 5 targets
`importApply.integration.test.ts:21` and the test `'normalizes the Airtable
program to one canonical spelling per authority'` (:188-206), but Task 8.1
already replaced that import (`resolveImportedAuthority, runApply,
splitReviewedName`) and the whole test (plan 13897-14032); item 3's three
bullets are likewise done by Tasks 8.1/8.2 and item 4's last bullet by Task
7.4. "Keep the rest of the test (from `// And it lands on the contact`)"
points at a test that no longer exists. | Mark item 5 (and item 3, item 4's
last bullet) "expected no-op after S7/S8 - confirm with `git grep -n
housingAuthorityFor -- app/test/importApply.integration.test.ts` (no output)";
do not hunt for the old test.

RD-3 | Tasks 8.1 GREEN (14457), 8.2 GREEN (14679), 8.3 Run/GREEN (14706,
14811), 12.1 GREEN (15600), 12.2-12.5 Run/GREEN (15681, 15728, 15762, 15786,
15813, 15865, 15885, 15899), 13.1 GREEN (16192), 15.1 GREEN (28531), 15.2
GREEN (29459), 15.3 Run/GREEN (29550, 29732), 15.3 RUNBOOK ASCII check
(29726) | MINOR | These commands carry no `cd`; section 0 says the shell
cwd resets between calls, and from the worktree root `npx vitest run
test/...` finds no test files (there is no root vitest config) while
`git diff -U0 RUNBOOK.md` needs the worktree root. | Prefix every vitest run
with `cd "W:/tmp/clean-org-names/app"; ` and the RUNBOOK check with
`cd "W:/tmp/clean-org-names"; ` (section 0's form).

RD-4 | Task 15.2 RED (plan 28536) | MINOR | "replace the import block (its
first four lines)" - the file Task 15.1 creates starts with a four-line
COMMENT header; the import block is lines 5-8. | Say "replace the four import
lines (from `import { describe, expect, it } from 'vitest';` through `import
{ planContact, planUnit } from '../scripts/clean-org-names.js';`) - keep the
header comment".

RD-5 | Task 12.1 (plan 15458-15459) | MINOR | The new item 4 is added to the
seedProfile.integration.test.ts header, which still opens "Verifies three
things:" (seedProfile.integration.test.ts:3). | Also change `// Verifies three
things:` to `// Verifies four things:`.

RD-6 | Task 12.3 (plan 15773-15776) | MINOR | Exporting `buildLiveStaticItems`
makes `app/test/seedUnreadFlag.test.ts:16-26` stale: it says live.ts "exports
NO reachable item array - the builder is the module-private
`buildLiveStaticItems` (live.ts:98)" and "If live.ts ever seeds a nonzero
unread, export the builder". No assertion depends on it. | Optional: in the
same commit reword reason 1 to "the builder `buildLiveStaticItems` is exported
(for seedOrgNames.test.ts), but ..." - or leave it and note it in the
handback.

## Clean (one line each)

- S8 importer: anchors, symbols, D9 behavior, the stub-client tests and the
  integration rewrites are consistent; the shared-table ordering of the two
  new integration tests holds (fresh tables in beforeAll, fill-only re-runs).
- S8 CLI: `createOrgListRepo({ doc, env: stageEnv }).peek()` precedes `await
  runApply(`, the parity-gate source check (importGroupAttribution.test.ts:
  195-209) still holds, and the runApply slice up to the first `});` contains
  `orgEntries`.
- S9: all six edits apply; the new Templates matcher matches the collapsed JSX
  text; the two `agency: ''`/`'   '` lines are true PINs.
- S10: no remaining live importer; the guard's walk sees only one stray
  `.mjs` (app/scripts/seed-smoke.mjs, clean); creates-tables guard
  (setup/dynamoAccessKeyGuard.test.ts:348-397) is satisfied by the new suites.
- S12: seeded item is byte-stable; `seedOrgListRow()` typechecks into
  `SEED`; the reseed window (devReset.ts:101-107, a create-only first read
  then the seed's unconditional Put) is what the new seedProfile test pins;
  the performance writer has no `settings` base (performanceSeed.ts:47-56);
  workload version pin (e2e/performance/config.test.ts:392) unaffected.
- S13: dev router mounts before the origin-secret validator and body parsers
  (app.ts:124-127) and only via `maybeLoadDevRouter` (devRoutes.ts:19); the
  seam validates like the sibling fixtures (400 strings, 404
  `<entity>_not_found`); Vite proxies `/__dev` (vite.config.ts:114).
- S15: planner expectations, the seeded-world counters (CHANGES, LEFTOVERS,
  EVENTS, 9/5/1/8), the 15-beat heartbeat count, refusal/stale/abort/
  unplannable/race/lock-lost paths, the CLI source checks, formatSummary
  strings and both RUNBOOK edits all agree with the plan's own code and the
  S2/S3 code they call.
