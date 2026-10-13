# Code review round 1 - adjudications

Date: 2026-10-13. Reviewed tip: 29114f8c (merge-base with main fa35f228).
Reviewers: R1-conformance.md (spec + work map, opus) and R1-adversarial.md
(PLAN-BLIND by mandate: diff package + repo access + standing charter only,
opus). Both ran read-only while the gate-4 e2e suite ran on this worktree;
their repro tests were written to the scratchpad for the fix wave to execute.
Adjudicated by the build orchestrator (Fable 5.1).

Conformance verdict: 56 work-map rows, 56 CONFORMS, 0 PARTIAL, 0 MISSING.
Adversarial verdict: 0 BLOCKING, 0 HIGH, 1 MEDIUM, 4 LOW, 7 NOTE, 7
PRE-EXISTING, 17 SOUND.

## Conformance findings

| id | severity | adjudication |
|---|---|---|
| L1 `docs/issues/relay-provision-includes-deleted-contacts.md` still calls the `memberFromContact` docblock wrong (S1 fixed it, 03b058e9) | LOW | FIX (fix wave): dated UPDATE block; issue stays open for its real subject. |
| L2 no test pins "an explicit Make primary appends no `unit_primary_contact_assigned`" (plan contract 2.4) | LOW | FIX (fix wave): one assertion in `unitsApiRosterAutoPrimary.test.ts`. |
| N1 7.4's "Add the landlord or property manager - they become the primary automatically." misleads when the landlord of record is soft-deleted: adding someone WITH the Landlord role answers 409 `landlord_reassignment_required`; PM/Owner works | NOTE | SPEC COPY, shipped verbatim. Surface to Cameron in the handback (he may change the sentence before merge); not changed on-branch. |
| N2 spec 10 / `selectors.md` say the UI cannot reach a zero-primary property; it can (Restore without a landlord, then add a tenant). What it cannot build is the imported shape (an eligible contact left non-primary) | NOTE | ACCEPT; selectors.md wording tightened in the fix wave (one clause). |
| N3 `.noPrimaryBox` copies `.duplicateWarning` CSS rather than sharing | NOTE | ACCEPT (two components, two modules; house pattern). |
| N4 remove 503 shows two identical alerts (dialog + row behind it) | NOTE | ACCEPT for this branch; handback "your eye" item (screen readers announce twice). |
| N5 a promoting "Restore without a landlord" puts two rows in Activity (`unit_restored.primaryPromoted` + `handoff_on_restore`) | NOTE | ACCEPT (both events are true; spec 8 asks for the assignment event). Handback item. |
| N6 stale comments `rosterCopy.ts:1-3`, `useListing.ts:244` | NOTE | FIX (fix wave, comment-only). |
| N7 a failed liveness read logs two WARNs | NOTE | ACCEPT (different context on each line); handback item. |

Divergences D-1..D-9 (code vs spec text): ALL ACCEPTED as the reviewer
recommends. D-1 (script log lines carry contact ids - no names; spec 8's
"unit ids only" is a PII rule and is honored), D-2 (`heirIfPrimaryRemoved`
null when no row is flagged - there is no primary to remove), D-3 (GLOSSARY
lists more zero-primary paths than spec 12 - the glossary is right), D-4
(INFO line at compose time - accepted at build research), D-5 (`Make
<contactId> primary` when a row has no name), D-6 (dialog layout follows the
spec text, not the mockup - the spec governs), D-7 (`auto_on_add` carries no
`from`; the field is optional), D-8 (`handoff_on_restore.from` names the old
landlord even with no flagged row - it was the derived primary), D-9 (the
delete hand-off re-reads consistently on every attempt - stricter than spec).

## Adversarial findings

| id | severity | adjudication |
|---|---|---|
| F1 contact-delete hand-off skips a unit with NO flagged row whose landlord of record is the deleted contact (`services/primaryHandoff.ts` target filter + `handOffPrimaryFrom` re-check match a FLAGGED primary only) | MEDIUM, CONFIRMED | BY DESIGN - spec 4.6 last bullet ("Restore vs. contact delete on a roster with NO flagged row - different on purpose ... Neither side is a bug to fix toward the other"), approved rev 6. Not changed on-branch. The reviewer's point stands on the merits: `landlordWasPrimary` (shared by both restore paths) already encodes "no row flagged -> the landlord is the primary", so closing the gap is a two-line reuse. FILED as `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md` with the recipe and the data shapes that reach it; RECOMMENDED to Cameron in the handback as a spec amendment he may take before or after merge. Until then the property box shows the state, P2 promotes the next eligible write, and the backfill repairs it. |
| F2 liveness reads that decide writes are eventually consistent (`getManyByIds` has no `ConsistentRead`); a stale image can flag a just-deleted contact, a stale miss can read a live row as deleted | LOW | ACCEPTED RACE - spec 4.2 states and accepts it; ruling R13 relaxed caseworker-integrity's per-row consistent read deliberately. FILED with F4 as `docs/issues/roster-liveness-read-eventual-consistency.md` (recipe: a `consistentRead` option on `getManyByIds`, used by the write-deciding callers). |
| F3 `landlordWasPrimary` treats a soft-deleted flagged row as "a primary exists", so a landlord-clearing restore leaves the deleted flag and promotes nobody; comments at `unitsRepo.ts` (~1618) and `routes/units.ts` (~591) say "live" | LOW | ACCEPTED STATE - spec 4.7 ("a deleted contact still flagged there ... stays flagged until the next eligible write or the script") and 9.2 ("a live flagged row elsewhere is never displaced"). FIX the two comments (fix wave, comment-only) so they stop saying "live". Noted in the F2/F4 issue as the third shape. |
| F4 two near-simultaneous deletes / a remove racing a landlord delete can leave a deleted contact flagged; skipped units are never retried | LOW | ACCEPTED RACE (spec 4.2, 4.6 best-effort). Filed with F2. |
| F5 every contact DELETE runs a full consistent units Scan, no projection; the summary line lists unit ids | LOW | ACCEPT - spec 4.6 accepts the Scan at today's size; the summary logs TARGET ids only (`primaryHandoff.ts:144-150`), not every unit scanned. A `ProjectionExpression` is a cheap future optimization; one bullet in the F1 issue. |
| F6 the box offers one-click "Make <tenant> primary" | NOTE | BY DESIGN (spec 7.4: a deliberate click is broader than the automatic rule). |
| F7 copy that misstates: Delete dialog in the F1 case; "contact was deleted" for a MISSING contact; "not found" diagnostics for a deleted contact | NOTE | BY DESIGN (spec 3 treats missing as deleted; spec 4.1 keeps the diagnostic texts per state). |
| F8 `propertyContact.ts` header says "every reader" uses the lookup; placement nudges route to the landlord of record | NOTE | FIX (fix wave, comment-only): "every reader of the property contact"; the landlord-of-RECORD readers are unchanged on purpose (spec 9.2). |
| F9 double WARNs; optional types; hand-mirrored enums; benign cycle | NOTE | ACCEPT (house patterns; cycle proven safe at module load by S2a/S2b/S5a AST + ESM load checks). |
| F10 rosters with two flagged rows half handled | NOTE | ACCEPT - the writes enforce at most one flagged row (spec 4.7); the script aligns legacy data. |
| F11 the backfill flags every no-flag unit with a live landlord (adds an Activity row, stamps `updated_at`) | NOTE | BY DESIGN (spec 8; the derived primary becomes stored). S5a W6: every such unit already has a stored roster, so the importer's `updated_at` ownership signal does not move. |
| F12 dev fixture: no street length cap; accepts pointer/deleted contact ids | NOTE | ACCEPT (hermetic-only route, structurally absent in deployed envs). |
| PRE-1 a soft-deleted contact can become landlord of record (create, PATCH, restore choice, vacant-slot claim) - ALSO from the dashboard by re-roling a "(deleted)" row to Landlord; the issue file calls it API-only | PRE-EXISTING | FIX the issue text (fix wave): the named issue gains a dated UPDATE naming the dashboard path. Behavior unchanged on this branch (caseworker-integrity's domain; spec 7.4 keeps the role select on deleted rows). Handback item. |
| PRE-2..7 `softDelete` unconditional; `contact_deleted` audit appended before the fan-outs; PATCH `landlordId` blind; others | PRE-EXISTING | NOTED in the handback; no change. |

## Fix wave (one wave, fresh implementer)

1. L2: the explicit-Make-primary-appends-no-event assertion.
2. Comment-only: `unitsRepo.ts` and `routes/units.ts` `landlordWasPrimary` comments (F3); `propertyContact.ts` header (F8); `rosterCopy.ts:1-3`, `useListing.ts:~244` (N6); test titles still saying sole-landlord (`unitsApiRosterAutoPrimary.test.ts ~:150`, `unitsRepoRestoreWithLandlord.int.test.ts ~:192, ~:247`).
3. Issues: L1 UPDATE block; PRE-1 UPDATE; NEW `primary-handoff-no-flag-landlord-delete-gap.md` (F1 + F5 bullet); NEW `roster-liveness-read-eventual-consistency.md` (F2, F3 shape, F4).
4. `e2e/support/selectors.md`: N2 clause.
5. Execute the adversarial repro file once (copied into `app/test/`, run, then removed - never committed) and record its outcome: the F1 and F3 cases are expected to FAIL, documenting the designed behavior; the rest PASS.
6. Worklist-deltas correction: the S3-F2 "403" item was wrong (the tree answers 404; `originSecret.ts:45` exempts `/__dev/`).

Re-review charge (fresh reviewer, AUTO mode): (1) what did the first pass MISS across the changed state; (2) the fix diff is new unreviewed code; (3) challenge any adjudication above with file:line; (4) only then, are the fixes real.
