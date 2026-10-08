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

Commit: 32959860.
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

## Task 3.4 - thread ownership plan

Commit: e2b2ef69.
The read-only preview enumerates every phone and email via conversationsForContact.
It counts own retypable threads, shared holder/participant mismatches, and
separately type-less rows. Closed, group and existing partner threads are left.
All-holders reads resolve the pointer fixture correctly; no S2 workaround.
The first case also pins a second email address, alongside the second phone.

Step 0 passed again. RED: npx vitest run test/caseworkerConversion.test.ts
exited 1: five new thread cases failed against the zero-count stub, 31 passed
(3.4-red). The existing-partner skip already passed. GREEN: the same command
exited 0, 36 passed (3.4-green). Root npm run typecheck exited 0
(3.4-typecheck). ASCII and git diff --check passed. No contract deviation.

## Task 3.5 - conditional commit and step-4 effects

Commit: 1e9f5244.
make now recomputes refusals, checks a requested organization against both kinds,
and commits one update guarded by raw revision and all three raw org fields plus
notDeleted. The write changes type/role/status/manual source, bumps the revision,
removes authority/provenance, sets agency empty, writes/removes organization and
saves old type/role/org values atomically. A failed condition consistently rereads
and distinguishes gone/deleted 404 from changed 409. Audit, new-type status
milestone and role vocabulary run once and catch failures after commit.

Step 0 passed. RED: npx vitest run test/caseworkerConversion.test.ts exited 1,
12 make cases failed on the intentional stub, 36 passed (3.5-red). GREEN:
the same command exited 0, 51 passed (3.5-green). Three extra guard boundary
pins cover stored zero/empty values, absent revision racing stored zero, and a
missing-row reread. The explicit-clear case starts with a stored organization,
so it proves removal. Root npm run typecheck exited 0 (3.5-typecheck).
No contract deviation. The suggestion/thread follow-ons remain Task 3.6 work.

## Task 3.6 - suggestion sweep, thread writes and repair

Commit: 15bbeb2a.
The conversion now captures a prewrite type identity, drains it using the shared
revision/identity semantics, then supersedes other suggestions. Own threads use
setTypeIfCurrent with the captured type and display name; events use the returned
updated row. A lost thread condition is logged/skipped. Repair repeats follow-ons
without refusals, a contact write, an organization change or a replacement record.

C1 completed: followOn supplies the optional error reporter with contactId,
conversion and repair context. Type read/delete, other delete, both verdict paths
and four-attempt exhaustion all produce error logs while committed make succeeds.
Parent also approved treating repair's initial type read as post-commit work:
it logs error even if the subsequent drain read succeeds. Fresh prewrite reads
retain the prior warning behavior. No rollback, retry or identity redesign.
The shared helper also had one trailing space removed; no logic changed there.

Step 0 passed. RED: npx vitest run test/caseworkerConversion.test.ts exited 1,
six missing-follow-on cases failed and 52 passed (3.6-red). After draft wiring,
seven C1 cases failed because no error log was emitted, 58 passed (3.6-c1-red).
After the reporter fix, npx vitest run test/caseworkerConversion.test.ts test/contactClassification.test.ts
exited 0: two files, 79 tests (3.6-c1-green).

Expanded GREEN:
npx vitest run test/caseworkerConversion.test.ts test/contactClassification.test.ts test/aiRunVerdicts.test.ts test/contactTriage.test.ts
exited 0: four files, 196 tests (3.6-green), including nine extra boundaries:
repair preserves saved values and emits each effect once; returned-row event
fields; null display name; racing replacement at old/current revisions; and
suggestion-list, thread-plan, milestone and vocabulary failures after commit.
Root npm run typecheck exited 0 (3.6-typecheck). ASCII and git diff --check passed.
The production event bus already isolates failing listeners; no event-bus change.

## Task 3.7 - dismissal

Commit: c92a68e6.
Dismiss shares the consistent-read domain, refuses unknown/already-caseworker,
and writes only caseworker_review: dismissed under notDeleted. No revision bump.
It appends one contact_updated audit naming only caseworker_review and the actor.
A raced deletion answers 404. As prescribed, dismiss audit errors propagate;
only make's follow-ons have the swallow-and-error contract.

Step 0 passed. RED: npx vitest run test/caseworkerConversion.test.ts exited 1:
four dismiss cases failed on its stub, 74 passed (3.7-red). GREEN: the same
command exited 0, 78 passed (3.7-green). Root npm run typecheck exited 0
(3.7-typecheck). Root npx eslint app/src/services/caseworkerConversion.ts app/test/caseworkerConversion.test.ts
exited 0, no lint errors (3.7-lint). No contract deviation.

## Task 3.8 - Possible caseworkers read and correction C3

Commit: this Task 3.8 commit (hash recorded in the final report update).
Added the read over tenant, landlord and partner partitions, exhausting their
cursors and applying exact signal bases/order, exclusions and name/ID ordering.
Tests use contactsPartitionFake unchanged with an explicit fixture limit of 50,
so they do not rely on its synthetic default. Empty deleted pages, full cursor
shape, exact-limit extra page, sparse/pointer exclusion and all three tenant
signals are covered. Production list defaults stay unchanged.

C3 ACCEPTED by the parent: D19 requires another contact's relationship, but the
drafted reader counted a self-link. The current parseRelationships accepts a
self contactId, making this reachable through PATCH. Exclude only that self
relationship in the new signal reader; no parser or route change. Other contacts'
matching links still count.

Step 0 passed. RED: npx vitest run test/possibleCaseworkers.test.ts exited 1,
one missing-module suite failure and no collected tests (3.8-red). Against the
draft reader, the new self-link case failed, eight passed (3.8-c3-red). GREEN:
the same command exited 0, nine tests passed (3.8-green). Final focused S3
regressions passed 274 tests in eight files (exit-regression); all seven owned
TypeScript files lint clean (exit-lint). Root npm run typecheck exited 0
across all five workspaces (3.8-typecheck). ASCII and whitespace checks passed.
