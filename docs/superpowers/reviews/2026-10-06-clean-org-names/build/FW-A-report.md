# FW-A report - code review round 1, backend fix wave (A1-A5)

- Implementer: FW-A (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after 1575a305 (R1 records) through 155d5e36 - 5 commits, one per item. Tree
  clean after the last commit (this report is the only untracked file). Nothing left
  running. `dashboard/` untouched.
- Every item test-first: the new test was run RED on the pre-fix code and failed for the
  reason the finding states, then GREEN. Logs: `.superpowers/sdd/fwa-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, ASCII message with the `Co-Authored-By: Claude Opus 5.5` trailer; added diff
  lines 0 non-ASCII; new files `tr -d` 0. DynamoDB Local up throughout (never started,
  stopped or restarted); test tables are throwaway `hc-test-<uuid>-` prefixes.
- Baseline before any edit: the 7 org suites 154/154 (exit 0).

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| A1 | d8d4435b fix(org-names): an add waits for a running rewrite that would rewrite the new name | service: add during a running Clear of "Metro HA" `promise resolved "{ ...(8) }" instead of rejecting`; route: `expected 201 to be 409` (2 failed / 54 passed - the 2 PINs green, as pins) | orgNamesService + organizationsApi 56/56 | fallout 7 files 127/127 (0); typecheck 0 |
| A2 | 67b4c0da fix(org-names): a machine REMOVE of housingAuthority takes its AI provenance stamp with it | parity case failed on BOTH halves: `+ "housingAuthority_source": {` survived the REMOVE (2 failed / 24 passed; PIN green on both) | orgRecordWriters.integration 26/26 (13 parity cases x 2, none skipped) | fallout 11 files 281/281 (0); typecheck 0 |
| A3 | ddbd3c95 fix(org-names): a cleanup audit append that fails no longer aborts the apply | both apply cases: `Error: Rate exceeded` rethrown by cleanOrgNames (the apply aborted); formatSummary: received the "Left for Settings" line, not the audit line (3 failed / 27 passed) | cleanOrgNames 30/30; + stageClient + orgListsRetired 62/62 | typecheck 0 |
| A5 | a659235d fix(org-names): the cleanup counts records holding a blank org value Settings cannot see | dry run: ONLY `- "recordsWithBlankValues": 5` missing (scans 13/7, recordsPlanned 8, changes, leftovers all matched - the blanks are invisible today); formatSummary at(-2) was a leftover line (2 failed / 29 passed) | cleanOrgNames 31/31; + stageClient + orgListsRetired 63/63 | typecheck 0 |
| A4 | 155d5e36 docs(issues): file three clean-org-names code-review follow-ups | n/a (docs) | `npm run issues` exit 0: 371 open / 196 closed / 567; the 3 rows in INDEX.md (gitignored, not staged) | `tr -d` 0 on all 3 files |

Fallout sets: A1 = orgNamesService, organizationsApi, suggestionResolutionRecovery,
orgRewriteService, orgRewriteJob, orgRecords, devOrgFixture. A2 = orgRecordWriters.integration,
orgRecords, orgRewriteJob, organizationsApi, cleanOrgNames, contactsRepo.integration,
twilioWebhookHarnessRepoAdditions.integration, audienceResolution, contactCapture,
scheduledSendSuppression, sendMessage (the four with typed ContactsRepo fakes).

## Final gates (after the last commit)

- `cd app; npx vitest run` on 27 files - every org suite (cleanOrgNames, contactOrgNames,
  devOrgFixture, extractionOrgListBlock, importOrgNames, orgListFake,
  orgListRepo.integration, orgListsRetired, orgNames, orgNamesService,
  orgRecordWriters.integration, orgRecords, orgRewriteJob, orgRewriteService,
  orgStartingList, organizationsApi, seedOrgNames, suggestionAcceptOrgList,
  unitsApiOrgNames), the direct importer suggestionResolutionRecovery, contactsRepo.integration,
  twilioWebhookHarnessRepoAdditions.integration, the four typed-fake suites, stageClient:
  545/545, exit 0, no skips, no `[dynamoAdmin]` line.
- `npm run typecheck`: exit 0.
- Lint preview (not required here): `npx eslint` on the 9 touched `.ts` files - exit 0, no
  findings, so no baseline comparison is needed for them.

## What changed, and every divergence / decision

A1 (R1-ADV-BE-1 / FE-3) - `app/src/services/orgNames.ts`: new `refuseWhileRewritingName`
called inside `add`'s `list.mutate`, after the name check: 409 `{ error:
'org_rewrite_running', lastRewrite }` (the existing `rewriteRunningError`) when
`isOrgRewriteRunning(lastRewrite, Date.now())` AND the trimmed name normalizes equal to a
`fromTexts` member. `app/src/services/orgRecords.ts` header PRECONDITION comment names the
new guard (comment only).
- Kind-agnostic, per the ruling's letter: during a value action on one field, an add of the
  OTHER kind with the same normalized text is refused too. Harmless (retry when the
  rewrite finishes); scoping it by kind would have been an extra rule the ruling does not
  state.
- The name check runs first: a name already taken answers `org_name_taken` (still true
  after the rewrite) rather than `org_rewrite_running`.
- `Date.now()`, as `refuseWhileRewriteRuns` does (the service has no clock dep).
- PIN "same add after the rewrite finished" also covers a STALE running lock (16 minutes
  without a heartbeat) - the ruling defines running as `isOrgRewriteRunning`.
- This also closes R1-ADV-BE-1's smaller window (a rename whose old-name spelling was
  skipped: the old name is that rename's from-text). The dashboard needs nothing: the add
  dialog maps errors through `orgErrorCopy`, and `orgCopy.ts:127` already words
  `org_rewrite_running`.

A2 (R1-ADV-BE-2) - `app/src/repos/contactsRepo.ts` `rewriteOrgFields`: when
`next.housingAuthority === null`, the same conditional UpdateItem also REMOVEs
`housingAuthority_source` (alias `#ha_source`; a REMOVE of an absent attribute is a no-op -
the pre-existing no-stamp REMOVE case stays green on DynamoDB Local). Interface doc updated.
Harness fake mirrors it. No divergence. Note: the writer's info log field `removedFields`
now reads 2 for every housingAuthority REMOVE.

A3 (R1-ADV-BE-4) - `app/scripts/clean-org-names.ts`: one `appendAudit` wrapper for both
loops: on a failure `log.warn({ err, entityKey, field }, ...)`, `result.auditFailed += 1`,
continue. New `CleanupResult.auditFailed` (0 in `emptyResult`); on the done line
(`reportCleanupRun` fields). Decisions:
1. WARN, as ruled (the org.rewrite pass logs the same failure at ERROR).
2. NOT in `flatCounts`, so not in the lock's stored counts (the Settings status line) nor
   the PARTIAL line - the RG-5 precedent; each gap has its own WARN line.
3. The printed summary line ("Audit events that could not be written: N (expected 0 -
   ...)") is printed on an APPLY only (a dry run appends nothing), right under the change
   counts, so the RG-5 line stays the summary's last line.
4. The test runs twice (it.each) - the failing append once for a contact with two events
   (the sibling event still lands) and once for a unit - to cover both wrapped call sites;
   each case is the ruling's "one append throws". Asserts: completes, no PARTIAL, record
   rewritten, `auditFailed: 1`, exactly one WARN line naming the key, exit 0, lock `done`,
   every other event present.
5. Beyond the ruling's letter: RUNBOOK.md step 4's parenthetical described the OLD abort
   ("An abort between a record's write and its audit append leaves that one record without
   its event") - rewritten to the new behavior. Kept because the operator would act on
   stale text; drop if unwanted.
6. Fallout: `auditFailed: 0` added to the two whole-result `toEqual`s and the typed
   `SUMMARY_RESULT` fixture.

A5 (R1-CONF-1) - same file: `CleanupResult.recordsWithBlankValues`, counted in both loops
before planning (beside RG-5), on the done line, and printed always (dry run and apply)
directly ABOVE the RG-5 line, expected 0. Count only: no plan or write changed. Decisions:
1. Name: `recordsWithBlankValues` - it counts RECORDS, as ruled (R1-CONF-1 suggested
   `blankValues`). A record with two blank values counts once; deleted records count.
2. Scalars: whitespace-only NON-EMPTY strings. An agency of `''` is a cleared agency (D5)
   and is not counted; a housingAuthority of `''` cannot be stored (GSI key).
3. List members: blank = `trim() === ''`, INCLUDING `''` - one step wider than the
   ruling's word "whitespace-only". Why: the pre-branch unit PATCH validated
   `accepted_authorities` only as a string array (d839494a `app/src/lib/unitFields.ts:172-173`)
   and trimJsonBody turns a whitespace member into `''`, so a blank member written after
   2026-07-14 is stored as `''`; both forms are equally invisible (`orgRecords.ts:455` and
   `planUnit` skip `trim() === ''`). Drop the `''` case if unwanted - one predicate,
   `isBlankMember`.
4. Not in `flatCounts` (RG-5 precedent).
5. RUNBOOK.md step 1 gained one sentence naming the new line (the RG-5 precedent: step 1
   explains every printed line).
6. The one test also runs the apply on the same world: same count, blank records untouched.
7. Fallout: `recordsWithBlankValues: 0` in the two whole-result `toEqual`s and
   `SUMMARY_RESULT`; two assertions appended to the existing formatSummary test (no second
   test), as RG-5 did.

A4 - three issues, all `status: open`, `severity: low`, `created: 2026-10-07`, refs checked
at HEAD: `org-spellings-patch-blind-replace` (type bug - a lost update; R1-ADV-BE-3),
`org-rewrite-single-message-pass` (type improvement - scale; R1-ADV-BE-5),
`composer-org-422-offer-renamed-entry` (type improvement - conforms to D7; R1-ADV-FE-10).

## Out of scope, noticed (no change made)

1. FW-B nit: `dashboard/src/api/endpoints.ts:2890-2893` (the `addOrg` doc comment) lists
   the POST refusals but not the new 409 `org_rewrite_running` from A1. Comment only - the
   dialog already shows the right copy.
2. `app/test/helpers/logCapture.ts:10`: the doc says `atLevel(n)` returns lines "at or
   above" level n, but the implementation (`:36`) filters `=== level`. Harmless for
   today's callers (all pass the exact level); a caller asking for "warn or worse" would
   miss error lines.
3. Residuals A1 leaves by ruling: the cleanup lock carries no from-texts, and the cleanup
   resolves every record against one snapshot read at start while adds and spelling edits
   are not locked out (R1-ADV-BE-1's last sentence) - for the handback's accepted-residual
   list.
