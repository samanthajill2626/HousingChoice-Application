# S1 report - caseworker matching helpers

Date: 2026-10-08. Lane: approved Caseworkers feature mission, S1 only.
Worktree: W:/tmp/caseworkers. Branch: feat/caseworkers.
Started at 57afc31f; implementation baseline 1c2264d2 matches 54e7b0d0.
Implemented Tasks 1.1-1.4. No S2 or later implementation started.

## Task commits

| Task | Commit | Result |
|---|---|---|
| 1.1 | 2ae58c74 | Defined the leaf CASEWORKER_ROLE and re-exported it from contactKinds; canonicalization accepts exactly partner + Caseworker. |
| 1.2 | dfa351ea | Added the normalized tab rule, broader mentions rule, prefixed AI-note rule, partner predicate, and PossibleSignal type. |
| 1.3 | 94b5ee0a | Added organization to OrgField and mapped it to both organization kinds. |
| 1.4 | 54b2fd24 | Added the dashboard role mirror and cross-workspace drift guard. |

Each task was committed only after its targeted GREEN checks and full root
typecheck. Before each commit, bare git status was read and the resolved worktree
MERGE_HEAD path was absent. Only explicit owned paths were staged. Each task
commit includes the GPT-6 Astra co-author trailer.

## RED evidence

Every RED run preceded the implementation for that task and exited 1.

| Task | Command | Observed reason and count |
|---|---|---|
| 1.1 | npx vitest run test/contactKinds.test.ts | 2 failed, 25 passed: CASEWORKER_ROLE was undefined and the exact partner/Caseworker shape returned undefined. Unsupported-role rows were already passing pins. |
| 1.2 | npx vitest run test/caseworkers.test.ts | 66 failed, 2 passed: all four helpers were missing and produced the expected function-not-found TypeErrors. The existing constant/re-export and signal-order array pins passed. |
| 1.3 | npx vitest run test/orgNames.test.ts | 3 failed, 37 passed: the organization mapping was undefined, and both new name-lookup cases failed inside isOnListFor because kinds was undefined. |
| 1.4 | npx vitest run src/routes/contact/caseworkerRoleMirror.test.ts | 1 suite failed to load, no tests collected: ./caseworkerRole.js did not exist. |

Task 1.3's RED description in the plan says every organization scalar case
throws. The actual unchanged-value and blank-value case was already GREEN:
checkScalarWrite returns before looking up kinds for those inputs. This is a
regression pin, not RED evidence. The mapping and two lookup cases supplied the
genuine RED evidence; no implementation or contract change was needed.

## GREEN evidence

App commands ran from W:/tmp/caseworkers/app. The dashboard command ran from
W:/tmp/caseworkers/dashboard. Every command below exited 0.

| Log stem | Exact command | Result |
|---|---|---|
| 1.1-green | npx vitest run test/contactKinds.test.ts | 1 file, 27 tests passed |
| 1.1-regression | npx vitest run test/contactKinds.test.ts test/aiRunVerdicts.test.ts test/contactTriage.test.ts | 3 files, 135 tests passed |
| 1.2-green | npx vitest run test/caseworkers.test.ts | 1 file, 68 tests passed |
| 1.3-green | npx vitest run test/orgNames.test.ts | 1 file, 40 tests passed |
| 1.3-regression | npx vitest run test/orgNamesService.test.ts test/contactOrgNames.test.ts test/seedOrgNames.test.ts | 3 files, 55 tests passed |
| 1.4-green | npx vitest run src/routes/contact/caseworkerRoleMirror.test.ts | 1 file, 52 tests passed |

From W:/tmp/caseworkers, npm run typecheck exited 0 before each task commit:
1.1-typecheck, 1.2-typecheck, 1.3-typecheck, and 1.4-typecheck.
The final 1.4-typecheck covered all S1 source changes and all five workspaces,
including the dashboard compiler following the new mirror-test import.

Raw logs, exact command/cwd metadata, and real exit-code files are under
.superpowers/sdd/S1/ as <log-stem>.log, <log-stem>.command.json and
<log-stem>.exit; RED stems are 1.1-red through 1.4-red. The ignored run.mjs helper
runs each command without a pipeline, captures stdout/stderr, and enforces a
600-second outer timeout on its owned process tree. No timeout fired.
Logs were preserved verbatim, including test-rendered Unicode characters.

git diff --check passed. New files and added lines passed the ASCII checks.
No DynamoDB control-plane fault appeared in the targeted output. The shared
DynamoDB container was left running. Aggregate npm test and e2e were not run;
the plan reserves them for later checkpoints and completion gates.

## Downstream contract and import proof

- app/src/lib/caseworkers.ts:34 defines CASEWORKER_ROLE. The service module
  imports it at app/src/services/extraction/contactKinds.ts:3 and re-exports
  it at :10. No reverse import exists.
- app/src/lib/caseworkers.ts:52 owns isCaseworkerRole; :62 owns
  mentionsCaseworker; :75 owns hasAiCaseworkerNote; :86 owns isCaseworker.
  The exact canonicalizer, normalized tab match and substring mentions
  match stay distinct. Only role participates, never role_title.
- The app module's sole import is app/src/lib/caseworkers.ts:21, which imports
  normalizeOrgText from lib/orgNames. lib/orgNames.ts remains import-free.
  The explicit import scan found exactly that one line across both files.
  Thus the dashboard drift test reaches these two app leaf files without
  pulling in the contactKinds repo/SDK/config graph.
- The AI-note helper requires an extraction prefix at the start of a notes
  line, then a normalized identified-as-caseworker prefix. The test reads
  the actual Partner example from services/extraction/prompt.ts and pins its
  taught text. Mentions of a tenant's own caseworker and unprefixed staff
  notes do not qualify.
- app/src/lib/orgNames.ts:27 widens OrgField; :36 accepts both
  housing_authority and agency for organization. OrgRecordField remains
  unchanged for S5. Unknown/ambiguous organization writes keep the
  organization error field and do not report otherKind.
- dashboard/src/routes/contact/caseworkerRole.ts:14 imports only orgCopy's
  normalizer. contactProfile.ts has no reverse caseworkerRole import.
  The mirror compares 25 inputs for each of the two rules, the exact preset,
  and a non-vacuous wider-mentions check (52 cases). S8 may extend this module
  with isCaseworkerContact as planned; contactProfile must not import it.

## Findings, deviations, and handoff

No unexpected importer, cycle, contract mismatch, or product deviation was found.
The only evidence-description correction is the Task 1.3 RED distinction above.
UTF-8 Node edits preserved existing line endings; no source was rewritten through
a PowerShell text pipeline. Scoped elevated execution followed the parent's
environment instruction. No live app ports, infrastructure/env mutations,
deployment, merge, or cleanup was performed.

After Task 1.4, the implementation was fully committed. At report preparation,
the only remaining tracked change is this report, to be committed immediately.
The final post-report git status is checked separately before handoff.
