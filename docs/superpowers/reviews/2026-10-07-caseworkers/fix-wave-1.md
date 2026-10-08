# Caseworkers fix wave 1 - concurrent contact PATCH classification

Date: 2026-10-08. Implementer: GPT-6 Astra.
Lane: accepted review fix within the Caseworkers feature mission.
Worktree: W:/tmp/caseworkers, branch feat/caseworkers.
Start: b8dcd649b884095ab97a22e5ac0eff7baa3e7fbf, clean.
Source commit: e0da8da38313e9f494d56bbbc96b8a3def720015.

## Finding and decision

CF-1 / R1-ADV-1 is fixed. The ordinary PATCH validated the merged contact
type and role from a consistent read, then wrote without conditioning on
that classification. Independent type-only and role-only requests could
both pass and compose into partner/Caseworker, bypassing the dedicated
conversion even when it refused the same contact's open placement.

`app/src/routes/contacts.ts:1531` captures the raw classification revision
as a primitive immediately after the read. Absent becomes an absent-attribute
condition; stored numeric zero remains zero. Every PATCH carrying type or
role uses that condition. `app/src/routes/contacts.ts:1746` composes it with
the existing staff-note expectation in the same atomic repository update.

On a failed condition, the consistent reread returns 404 contact_not_found
for disappearance. A current contact returns 409 contact_changed with the
current contact unless its supplied staff-note expectation is stale, in
which case the existing staff_notes_stale response applies. Note-only
requests retain their existing conflict handling. The route returns before
suggestion deletion, verdict stamping, auditing or conversation effects.

No repository interface or fake change was needed. Both existing update
implementations AND every ExpectClause and distinguish absent from numeric
zero. Reviewed the other relevant writers: conversion uses the same
classification revision; suggestion acceptance directs type decisions to
triage; extraction publishes type suggestions rather than directly setting
type; contact repository type/role updates increment the revision atomically.
The importer writes directly without incrementing it, as already explicitly
accepted and documented in `app/src/lib/import/apply.ts:1071`; this wave does
not claim to close that race.

## Regression evidence

Nineteen new route tests were added across two files.

- `app/test/contactTriage.test.ts:742`: four deterministic schedules cover
  type-first and role-first commits for absent and zero initial revisions.
  Both requests read independent cloned snapshots before either write.
  The real conversion endpoint first refuses the same contact's open
  send_application placement. One PATCH then succeeds, the other conflicts,
  and its retry reaches caseworker_use_conversion. The losing request leaves
  the winning contact and a pending type suggestion unchanged, with no
  post-write suggestion, verdict, audit, event or conversation effects.
- `app/test/contactTriage.test.ts:825`: absent-to-zero and zero-to-absent
  changes are conflicts, rather than both being normalized to revision zero.
- `app/test/contactTriage.test.ts:844`: a concurrent classification that is
  now a caseworker is returned as contact_changed, without overwriting it.
  The following cases retain disappearance as 404 and the generic PATCH's
  existing ability to edit a soft-deleted contact.
- `app/test/contactStaffNotes.test.ts:137`: eight cases compose both guards
  using absent and held note stamps, distinguishing current, classification
  only, note only and both-stale states. Refused mixed edits are atomic and
  preserve ordinary field suggestions. The additional cases cover combined
  disappearance and a note-only edit alongside a classification change.

Commands below ran through the parent's bounded local runner. All raw logs,
command/cwd metadata and exit files are under
`.superpowers/sdd/checkpoints/`, named with the labels below. The runner
uses a 180000 ms hard owned-child timeout; none fired.

| Label | Working directory and command | Result |
|---|---|---|
| FW1-red | W:/tmp/caseworkers/app: npx vitest run test/contactTriage.test.ts test/contactStaffNotes.test.ts | Exit 1; 9 failed, 77 passed, 2 files |
| FW1-green | W:/tmp/caseworkers/app: npx vitest run test/contactTriage.test.ts test/contactStaffNotes.test.ts test/caseworkerReviewApi.test.ts test/aiRunVerdicts.test.ts test/caseworkerRepoParity.integration.test.ts | Exit 0; 230 passed, 5 files |
| FW1-typecheck | W:/tmp/caseworkers: npm run typecheck | Exit 2; test fixture stage application was not a valid PlacementStage |
| FW1-lint | W:/tmp/caseworkers: npx eslint app/src/routes/contacts.ts app/test/contactTriage.test.ts app/test/contactStaffNotes.test.ts | Exit 0 |
| FW1-red-final | W:/tmp/caseworkers/app: npx vitest run test/contactTriage.test.ts test/contactStaffNotes.test.ts | Exit 1; 9 failed, 77 passed, 2 files |
| FW1-green-final | W:/tmp/caseworkers/app: npx vitest run test/contactTriage.test.ts test/contactStaffNotes.test.ts test/caseworkerReviewApi.test.ts test/aiRunVerdicts.test.ts test/caseworkerRepoParity.integration.test.ts | Exit 0; 230 passed, 5 files, zero skipped |
| FW1-typecheck-final | W:/tmp/caseworkers: npm run typecheck | Exit 0, all workspaces |
| FW1-lint-final | W:/tmp/caseworkers: npx eslint app/src/routes/contacts.ts app/test/contactTriage.test.ts app/test/contactStaffNotes.test.ts | Exit 0, no errors |

The initial RED preceded production edits. Typecheck subsequently corrected
the placement fixture to the valid stage send_application. To retain RED
evidence for the exact final fixture, the original b8dcd649 route was replayed
by `.superpowers/sdd/fix-wave-1/replay-red.mjs`, which restored the guarded
route byte-for-byte in a finally block. Both RED runs fail the same nine
assertions: four concurrent losers returned 200, two raw-revision changes
returned 200, one current-classification conflict returned 200, and two
classification-only note conflicts returned 200. Conversion refusal and
independent-snapshot checks had passed before the failing assertions.

Final passing counts: contactTriage 60, contactStaffNotes 26,
caseworkerReviewApi 26, aiRunVerdicts 74, caseworkerRepoParity.integration 44.
The last suite executed its real DynamoDB Local and fake halves, with no
skips. No real [dynamoAdmin] fault marker appeared in any FW1 log.
Diff whitespace and added-line ASCII checks passed. Existing source encoding
was preserved; only the three assigned source/test paths were committed.

## Scope and handoff

The parent confirmed the conflict priority and preservation of generic
soft-deleted edits during implementation. There is no new generic type
refusal or notDeleted guard. Existing successful ordinary edits and the
dedicated conversion keep their behavior. No new copy or dependency was
introduced. The fixture correction is the only verification adjustment;
there is no production contract deviation or unresolved fix-wave concern.

R1-ADV-2 remains the approved in-flight extraction deferral. C6 remains
unapplied. No importer, source writer outside the assigned route, interface,
fake, branch, main sync, infrastructure, deploy, real env, Docker lifecycle
or human live-port change was made. No aggregate test, smoke, e2e or browser
run was started. The parent owns the aggregate gates, independent review,
live self-QA, ledger and final mission disposition; this report is not a
mission completion claim.

Bare git status and the resolved MERGE_HEAD path were checked before the
source commit; no merge was active. The same checks precede this report's
explicit-path commit. Both commits include the GPT-6 Astra co-author trailer.
All commands launched by this implementer have completed; no owned command
or background test remains running.
