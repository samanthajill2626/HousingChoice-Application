# Build research - dashboard, e2e and seed (plan Tasks 9-14): findings

Date: 2026-09-25. Branch `feat/share-skip-fix` at cf088d22 (source tree equal to
main@bbaad87d). Plan: `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (v3).
Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (v10).
Read-only drift check. Nothing was edited, run or installed; one read-only ESLint
pass over the 22 files these tasks touch was taken as the gate-5 baseline.
The byte-exact worklist for the implementers is the git-ignored
`.superpowers/sdd/build-worklist-dashboard.md`.

Result: every anchor, exported symbol, helper signature, accessible name, copy
string and API body that Tasks 9-14 use resolves in the current tree, and every
test the plan writes can pass as written. No lean-world consumer breaks (both
sweeps below). What remains is five NOTE items: places where following the plan
word for word would drop text, expect a lint result that cannot happen, cite the
wrong precedent, or leave comments stale.

Severity counts: BLOCKER 0, MUST-ADJUST 0, NOTE 5.

## N1 (NOTE) - Task 9: the RecipientPreview header anchor ":8-10" cuts across other sentences

`dashboard/src/routes/broadcasts/RecipientPreview.tsx:8-11` holds the old
already-sent rule. But line 8 begins with a different sentence ("(auditable:
staff can see who's left out and re-check them).") and lines 10-11 end with a
third one ("A live selected count drives "Send to N tenants", which posts the
EXACT checked contactIds."). If lines 8-10 are replaced wholesale, the auditable
sentence is lost and line 11 is left as a fragment.

Plan change: in Task 9 Step 3, say "replace the already-sent sentence inside
:8-11, keeping the auditable sentence before it and the 'A live selected count
drives ...' sentence after it".

## N2 (NOTE) - Task 12 Step 7 expects an ESLint PASS that the unchanged file cannot give

The Step 7 command lints `BroadcastComposer.tsx`. On today's tree that file already
reports 4 `react-hooks/set-state-in-effect` errors, at :167, :190, :208 and :223.
One of them (:190) is the resolved-mode `setMessage` that Task 12 edits, and it
stays after the edit. So the command exits 1 before and after the change, and
"Expected: PASS" cannot be met. `BroadcastComposer.test.tsx`, which Task 12 also
touches, has 3 existing `no-unused-vars` errors: :11:24 `ContactsPage`, :11:69
`UnitsPage` and :37:10 `DEFAULT_SEND_TEMPLATE`. Gate 5 at handback will list them.

Plan change: in Step 7, expect "no NEW errors compared with the merge base". Name
the four existing errors in BroadcastComposer.tsx, and add the three test-file
errors to the Task 15 handback's list of existing lint errors, so no builder
tries to "fix" them in this branch.

## N3 (NOTE) - Task 14 cites the wrong precedent for the skipped-slot path

The plan says `a2p-compliance.spec.ts:433-483` "drives the same path". That test
sends with no body (`data: {}`, :466), which is the filter-resolve path. The
plan's spec uses an explicit selection (`recipientContactIds`). The mechanism the
plan relies on is correct:
- the explicit-selection branch re-fences only unknown, non-tenant, opted-out,
  unreachable and phone-less contacts (`app/src/routes/broadcasts.ts:657-663`), so
  it has no consent fence;
- the fan-out's consent fence then records `skipped` / `no_consent`
  (`app/src/jobs/broadcastFanOut.ts:397-407`).

Plan change: cite `broadcasts.ts:657-663` and `broadcastFanOut.ts:397-407` as the
evidence, not the a2p spec. No change to the test code.

## N4 (NOTE) - comments the plan leaves stale (all ASCII rewrites; no behavior)

D7, D8 and the Task 13 seed row make the comments below untrue. The plan's
comment edits (RecipientPreview :8-10, :59-63, :119-121; BroadcastComposer
:179-185, :260-267; DeliveryBadge header :1-5; contacts-list-facets :11-12,
:23-24) do not cover them:
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:24-25`: the `errorCode`
  prop doc says "Absent -> just the status label". After Task 10, a code-less
  failed or skipped row shows a reason. The line is non-ASCII, so a rewrite must
  be ASCII.
- `dashboard/src/routes/broadcasts/broadcastFormat.ts:83-87`: says "`skipped` has
  no comms equivalent (opted out between resolve + send)". Skips now carry nine
  reasons.
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx:66-67`: the
  `initialRows` doc says flagged rows start unchecked, with no mention of seeded
  rows. `:427-428` says "the body is written for one named tenant".
- `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx:502-503`: the
  describe comment says "the body names ONE tenant".
- `dashboard/src/routes/broadcasts/resolveTemplate.ts:1-5`: the header describes
  the single-recipient editor as the `[TenantName]` resolver.
  `resolveTemplateForTenant` becomes test-only after Task 12.
- `e2e/tests/dashboard-next/matching-entry-points.spec.ts:7-11`: says "the message
  auto-resolves to that single tenant".
- `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:121-124`: says "The lean
  seed holds exactly three contacts (tenant/landlord/partner)". After Task 13 it
  holds four. The assertion (no unknowns) still holds. This is the same kind of
  stale count the plan already fixes in contacts-list-facets.
- `app/src/lib/seed/cast.ts:114`: says "Never collides with lean
  (+15550100001-3)". It is still true, but the lean range now ends at -4.
- Already stale before this branch; Task 13 makes them staler:
  - `e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts:13`: says "on
    the lean seed the inbox goes empty".
  - `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:52` cites
    `lean.ts:247-269` for the connecting group, which now sits at :259-279, and
    `:65` cites `lean.ts:81-150`. Inserting Dario's conversation row moves the
    connecting group again.

Plan change: fold these rewrites into Tasks 10, 12 and 13. Each line is in a
file the task already touches, except `unknown-caller-triage.spec.ts`,
`cast.ts` and the two already-stale e2e comments. If Task 13 takes those on, add
them to its file list and its explicit `git add`.

## N5 (NOTE) - Task 11's BroadcastStatusPill listing drops the file header

The plan gives a full replacement for `BroadcastStatusPill.tsx` that begins at
the imports. The current file opens with a 4-line header comment (:1-4). Line 1
is non-ASCII. Pasting the listing as the whole file deletes that header.

Plan change: keep the header, rewritten in ASCII, adding one clause that with
`stats` an all-skipped finished share reads "Not sent".

## Lean-world consumer sweeps (Task 13): no breakage

- App tests: all 16 seed-consuming suites under `app/test` were checked (seedData,
  seedRosterShape, seedHistory, seedMatrix, seedMatrixCoherence, seedPersonaDrift,
  seedProfile.integration, seedTourTrails, seedUnreadFlag, seedLive,
  performanceSeed.integration, castMessageTransport, devGating,
  importApply.integration, reseedUnmatchedEmail, toursApi). None changes outcome.
  One ordering dependency is real and the plan already respects it:
  `app/test/seedData.test.ts:81-89` and `:110-121` take the first
  `type === 'tenant'` contact and require `status_source` `'derived'` and a
  boolean `porting`. Dario has neither, so he must be appended AFTER Tasha. The
  plan appends him after Renee, which satisfies this. In the full profile,
  `historyItems()` adds two `tenant_status_changed` audit rows for Dario, which
  `seedHistory.test.ts:188-211` accepts. No test pins full-profile totals.
- E2E: every spec under `e2e/tests` was checked, together with
  `e2e/scenarios/steps.ts`, `e2e/support` and `e2e/fixtures`. None changes
  outcome.
  - Inbox, Unread tab and nav badge: Dario's row carries unread 0, and nothing
    reads an inbox row by position.
  - Today: he has no placement, no tour and nothing unread.
  - Contacts-list facets: he is 1-BR and atlanta_housing, so the 2-BR + DCA
    survivor is unchanged, and the list walks every page.
  - Broadcast audiences: no spec's audience lacks a bedroom size, uses 1-BR, or
    filters on atlanta_housing alone. The resolver matches voucherSize exactly
    (`app/src/services/audienceResolution.ts:153-155`).
  - Unknown triage: he is a tenant, never an unknown.
  - Global extraction-tick counts: the seed creates no extraction due items.
  - The only phone-collision path is `e2e/scenarios/steps.ts:89`'s
    `+1555<5 clock digits><2 seq digits>`. It is negligible (about 1 in 100,000
    per run) and is the same risk the seeded 0001-0003 numbers already carry.
  - One field is load-bearing and the plan already has it: conv-0002's
    `participant_phone`. The fan-out finds the switched-off thread through the
    byParticipantPhone GSI (`app/src/repos/conversationsRepo.ts:1252-1264`).
    Without that field, the share would mint a fresh `auto` thread and the e2e
    would pass without proving anything. The inbox also needs it to attach the
    row to a contact (`app/src/routes/inbox.ts:1077-1094`).
  The file:line table is in the worklist.
