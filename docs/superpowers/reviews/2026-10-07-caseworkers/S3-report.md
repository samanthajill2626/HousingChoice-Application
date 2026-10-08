# S3 report - caseworker services

Date: 2026-10-08. Lane: approved Caseworkers feature mission, S3 only.
Worktree: W:/tmp/caseworkers. Branch: feat/caseworkers.
Started clean at 71214970 after the committed S1/S2 handoff. This report is
updated and committed as each task is produced. No S4 implementation is included.

## Task 3.1 - shared classification effects

Commit: 0525981d.
Moved displayNameOf, the identity-guarded suggestion delete/verdict stamp, and
the revision-guarded bounded type drain into contactClassification.ts. The
contacts PATCH calls the shared helpers; its generic thread behavior and all
pre-existing tests remain unchanged. Only its helper extraction was edited.

C1: added an optional reportFailure callback to SuggestionEffectDeps. Without
it, every previous warning message and field is preserved. A caller can now
report swallowed failures at error level with its own conversion context.
The seam covers type reads, guarded type deletes, other deletes, both verdict
paths, and bounded-drain exhaustion. Task 3.6 will supply the conversion reporter.
The identity/revision comparisons and four-attempt bound are unchanged.

RED (app workdir): npx vitest run test/contactClassification.test.ts exited 1,
one missing-module suite failure, no collected tests. After moving the helpers,
the original seven cases passed (3.1-extraction-green, exit 0). Before adding the
reporter implementation, the same command exited 1: six failure-reporting cases
failed because the supplied callback was never called, eight tests passed
(3.1-c1-red). The default-warning pin already passed on the unchanged helper.

GREEN (app workdir):
npx vitest run test/contactClassification.test.ts test/aiRunVerdicts.test.ts test/contactTriage.test.ts test/contactStaffNotes.test.ts test/suggestions.test.ts test/contactsCrud.test.ts
exited 0: six files, 187 tests passed (3.1-green).
Root npm run typecheck exited 0 (3.1-typecheck).
Root npx eslint app/src/routes/contacts.ts app/src/services/contactClassification.ts app/test/contactClassification.test.ts
exited 0 with no lint errors (3.1-lint). git diff --check and the owned
new-file/added-line ASCII check passed.

Step 0 proof: the S1 leaf definition/import/re-export and matchers, both-kind
organization mapping, all S2 typed fields and multi-clause/notDeleted guards,
all-holders methods, returned-row conditional conversation update, and real/fake
unit any-deletion scopes are present. The ignored probe initially expected an
inline filter/array spelling; inspection showed S2 correctly shares helpers
(deletedScopeFilter, inDeletedScope, expectClausesOf). The probe was corrected;
no production contract mismatch or dependency recreation was needed.
The moved helpers were router-local. Unrelated displayNameOf helpers in users,
inboundEmail and units remain untouched. No unexpected importer or cycle.

## Evidence and operating constraints

All test commands run from W:/tmp/caseworkers/app; root checks run from
W:/tmp/caseworkers. Verbatim logs, exact command/cwd metadata and real exit
files are under .superpowers/sdd/S3/ as <stem>.log, <stem>.command.json and
<stem>.exit. The ignored run.mjs uses a 600-second hard outer timeout on
its owned child tree and preserves the command exit code without a pipeline.
No timeout or DynamoDB control-plane fault has occurred. The shared DynamoDB
container remains running. Aggregate npm test, smoke and e2e are the parent's
later checkpoints. No live application ports, environment/infra mutations,
deployment, main sync/merge, cleanup or tracker edits were performed.

## Task 3.2 - domain, refusal reads and preview removals

Commit: 97a78932.
Added consistent subject reads and 404 handling for missing, invalid, deleted
and pointer rows, with team_member refused at 400. Preview collects all four
refusal kinds whatever the stored type, includes deleted units, gives landlord
of record precedence over a roster seat and sorts IDs within each kind.
Already-caseworker preview skips refusals and reports only suggestion removals.
The organization/thread and make/dismiss stubs remain as the task prescribes.

Step 0 dependency proof passed again after Task 3.1 committed. RED:
npx vitest run test/caseworkerConversion.test.ts exited 1, one missing-module
suite failure and no tests collected (3.2-red). The first implementation run
had 16 passed and one failing added paging assertion (3.2-green): the fixture
incorrectly assumed an implicit 50-item fake page. S2 intentionally returns
all units without a limit. Corrected the fixture to force limit 50, preserving
S2 code; the deleted roster seat beyond the first page is now proved.
The same command then exited 0, 17 tests passed (3.2-green-corrected).
Root npm run typecheck exited 0 (3.2-typecheck); a final run covers the corrected
fixture before commit (3.2-typecheck-final). No production contract deviation.

## Task 3.3 - organization derivation and approved correction C2

Commit: this Task 3.3 commit (hash recorded in the next report update).
Stored organization wins; otherwise agency wins whenever nonempty, then authority.
Resolve against both kinds first; unmatched or ambiguous text is carried only
when raw control/invisible-character, length and normalized-nonempty limits pass.
Compound text remains carriable. No list read when stored or no source text.

C2 ACCEPTED by the parent after checking D19 and R2-F7: the draft trimmed held
agency/authority before carrying it, contradicting carry 'as written' and the
raw D13 limits. Keep raw held values instead. Nonempty whitespace-only or invalid
agency cannot fall through to the authority. List matches still resolve before
carry eligibility, so canonical names remain safe to write. No spec change.

Step 0 passed again. RED: npx vitest run test/caseworkerConversion.test.ts
exited 1: four organization cases failed against the stub, 19 passed (3.3-red).
The limits and no-source cases already passed; this corrects the draft's
expectation that every case except the last would fail. Against the drafted
trimming implementation, C2's added tests exited 1: six failed, 24 passed
(3.3-c2-red): two preserved-padding cases and newline, invisible, raw length
and whitespace-only agency cases. After the correction, the same command
exited 0: 30 tests passed (3.3-green). Root npm run typecheck exited 0
(3.3-typecheck). git diff --check and new-file ASCII checks passed.
