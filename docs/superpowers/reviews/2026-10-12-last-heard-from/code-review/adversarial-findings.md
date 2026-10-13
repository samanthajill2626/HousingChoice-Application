# Code review - Reviewer B (adversarial, plan-blind) - feat/last-heard-from

Scope: the branch diff 16ca96cc..HEAD (app, dashboard, e2e, docs), plus the live
files around every hunk and every other reader/writer of the touched state
(contacts writers, listing_sends writers, tour creators/markers, the ListingSendRow
and Contact wire types, ContactSearchField, ContactsList, the share ledger).
Design documents were NOT read (plan-blind by mandate).

Gate rule honoured: reading only until `.superpowers/sdd/gates/p3-e2e.exit` existed
(EXIT=0, 359 passed, 20.9m). Then two throwaway files were run singly and deleted:
`app/test/adv-outcome.review-tmp.test.ts` and `app/test/adv-retry.review-tmp.test.ts`
(outputs: `.superpowers/review/adv-run1.txt`, `adv-run2.txt`). `git status --short`
afterwards shows only the untracked `code-review/` folder (the records folder).

Counts: BLOCKER 0, MAJOR 0, MINOR 2, NIT 5.

Overall: the core is sound. Things I checked and could NOT break: the forward-only
`touchLastHeardFrom` (attribute_exists + lexical compare on one normalized form; every
writer goes through `normalizeInstant`); redelivery idempotence (every live path
touches with the PERSISTED tsMsgId, which `messagesRepo.append` returns on a dedupe);
attribution on the persisted thread (a 1:1 delivery that deduped into a group row is
attributed by the group rule); pointer-row refusal; every other contacts writer is a
field-level UpdateItem (no read-modify-write Put can clobber `last_heard_from_at`, and
the touch does not move `updated_at`, so no optimistic guard is disturbed);
`putShareMemory` never touches `declined`; `findByPhone` hops pointer rows to the
owner; all contacts GSIs project ALL (the audience resolver sees the new field); the
new routes sit behind requireAuth with ids in keys only; the dev fixture is on the
dev router; follow-ups is registered above every `/broadcasts/:broadcastId` GET;
`tour_type` is validated at its only writer, so the outcome route cannot mint an
invalid tour type; logs carry ids only.

---

## ADV-1 - MINOR - CONFIRMED (behaviour) / PLAUSIBLE (that it is unintended)

**A decline that tour activity superseded comes BACK when that tour is later canceled
or marked no-show.**

Where: `app/src/lib/listingSendTour.ts:109-110` (deriveTourActivityAt skips every
non-qualifying tour, so a canceled / no_show tour's createdAt stops counting) feeding
`app/src/lib/listingSendOutcome.ts:47-58` (effectiveDecline). Same derivation at
every outcome surface: `app/src/routes/units.ts:256-263`,
`app/src/routes/contacts.ts:1258-1265`, `app/src/services/followUps.ts:149-155`,
`app/src/routes/broadcasts.ts:478-484`. The repo header says the opposite of what
happens: `app/src/repos/listingSendsRepo.ts:107-108` "a superseded record stays here
and is simply ineffective".

Scenario: tenant says no -> staff "Not interested" (T1). A week later the tenant
re-engages and a tour is requested/scheduled (T2 > T1): the row reads Interested. The
landlord cancels that tour (or the tenant no-shows). The pair silently flips back to
"Not interested": it leaves the Follow up list, is grouped under Not interested on
the property card, and the next preview of that property starts the tenant UNCHECKED
with a "Not interested" tag - although the most recent human signal was interest.
Without the old decline the same cancel would correctly fall back to Waiting.

Proof (throwaway, pure functions): decline at 2026-07-01, tour created 2026-07-02.
status `requested` -> `interested`; same tour `canceled` (lastMarkedAt 07-05) ->
`effectiveDecline` true, outcome `not_interested`; `no_show` -> `not_interested`.
3/3 assertions passed (`adv-run1.txt`).

Note the current rule is RIGHT for the opposite order (tour scheduled, tenant declines,
staff cancels the tour BECAUSE of the decline: the cancel stamps lastMarkedAt after
the decline and must not supersede it). So the fix must not simply count every tour.

Smallest fix: in the supersession instant, let a NON-qualifying tour contribute its
`createdAt` only (never its `lastMarkedAt`): a tour CREATED after the decline proves
re-engagement whatever happened to it later, while a cancel/no-show mark never
supersedes. (Alternative: clear the stored decline at the moment a later tour or
share supersedes it, so a superseded decline is truly dead, as the header claims.)
If the resurrection IS intended, correct the listingSendsRepo header and add a test
that pins it.

## ADV-2 - MINOR - CONFIRMED (code) / PLAUSIBLE (magnitude)

**The follow-ups list reads FULL contact items for every recipient of every available
property, and it is recomputed from scratch on every Properties-list and every
Matching mount.**

Where: `app/src/services/followUps.ts:139` uses `contacts.getManyByIds` (no
projection - `app/src/repos/contactsRepo.ts:1321-1322`), after two Queries per unit
(`followUps.ts:127`, up to 100 units). Callers: `dashboard/src/routes/listings/ListingsList.tsx:210`
(`useFollowUpCounts`) and `dashboard/src/routes/broadcasts/BroadcastsList.tsx:58`
(`useFollowUps`, fetched whatever tab is active).

Scenario: shares go to whole housing-authority audiences, so unique recipients across
the available properties approach the tenant base. Each Properties-list visit then
pays up to 200 Queries plus sequential 100-key BatchGets of whole contact documents
(notes, phones[], emails[], preferences, consent and caseworker fields) only to keep
the handful of rows that are waiting; the Matching page pays it again.

Proof: code reading. Every attribute buildFollowUps reads (firstName, lastName, phone,
type, role, status, deleted_at, sms_opt_out, sms_unreachable, last_heard_from_at) is
already in RECIPIENT_PROJECTION (`contactsRepo.ts:1044-1055`).

Smallest fix: call `getRecipientDisplaysByIds(ids, { requireComplete: true })` in
buildFollowUps (same completeness contract, a fraction of the bytes). Optionally let
the Properties list reuse one response per session rather than refetching per mount.

## ADV-3 - NIT - CONFIRMED

**Interested clears an effective decline BEFORE creating the tour; a create failure
answers 500 but the decline is already gone and its "cleared" event recorded.**

Where: `app/src/routes/units.ts:1296` (clearDeclined + listing_decline_cleared event)
precedes `units.ts:1312` (tours.create), with no compensation.

Scenario (stale client): staff B marks Not interested; staff A, whose page still shows
the row Waiting, clicks Interested; the tours write fails. A sees "Couldn't save - try
again." while B's decline has been silently undone and the contact timeline says
"Not interested cleared".

Proof (throwaway, harness world): seeded decline at 2026-07-01 (effective), unit
tour_type self_guided, `world.toursRepo.create` throws -> 500
`{"error":"internal server error"}`, stored `declined` undefined, events
`["listing_decline_cleared"]` (`adv-run1.txt`).

Smallest fix: create the tour first, then clear the decline (the new tour's createdAt
already supersedes it, so the order change is safe), or record the clear event only
after the create succeeds.

## ADV-4 - NIT - CONFIRMED (mechanism) / PLAUSIBLE (reachability: 15-minute window)

**An AUTOMATIC 30003 retry of a share sent before a decline supersedes the decline.**

Where: `app/src/services/shareLedger.ts:51` (countedAt = the attempt key's instant, and
a retry is a new, later attempt key) -> `summarize` (`shareLedger.ts:112`) moves the
row's sentAt past the decline -> `effectiveDecline` false. The tour side deliberately
refuses automated writes as supersession (`listingSendTour.ts` doc: "NEVER updatedAt -
would let an automated write undo a decline"); the share side does not make that
distinction.

Scenario: share A counted earlier; a re-share B fails 30003 (retry pending); staff
records Not interested inside the 15-minute retry window
(`app/src/lib/retrySendWindow.ts:15`); the automatic retry is accepted -> the pair is
Waiting again and back on the Follow up list.

Proof (throwaway): row with A counted 07-01T09:00, B pending, decline 07-02T09:30;
`applyShareLedgerEntry` with the retry attempt 07-02T10:00 accepted -> `written`,
sentAt 07-02T10:00, effectiveDecline true -> false (`adv-run2.txt`).

Fix (if it matters): supersede by a share whose ORIGINAL attempt postdates the decline
(the retry chain's root instant), or accept and document. Very narrow; NIT.

## ADV-5 - NIT - CONFIRMED

**The performance seed writes inbound messages but never derives last_heard_from_at.**

Where: `app/src/lib/seed/performance.ts:930` and `:966` write alternating inbound
rows; the derivation runs only in `seedAll` (`app/src/lib/seed/index.ts:151`).

Consequence: `npm run perf:pages` measures the Tenants list (now sorted by last heard
from by default), the contact header and the Follow up surfaces in a world where every
contact is "Never" and nothing is "Replied" - a degenerate sort and an empty waiting
list, so the new paths are not representatively timed.

Fix: run `deriveSeedHeardFrom` over the performance seed's tables before its Put loop.

## ADV-6 - NIT - CONFIRMED (code reading)

**Mount-time clocks on surfaces that stay mounted.**

Where: `dashboard/src/routes/contacts/ContactsList.tsx:213` captures `now` once per
mount, while the same file says the component STAYS MOUNTED across the four contact
filter routes (`:201`); data refetches on each filter change, labels do not re-clock.
Same pattern in FollowUpView / BroadcastsList (Matching), ListingDetail, TenantFile and
PartnerFile.

Consequence: a tab left open across midnight shows yesterday's inbound as "Today
h:mm", and the Follow up chips under-count days ("No reply yet, 2 days" that is
really 3). Cosmetic; no decision depends on it.

Fix: capture the clock per data load (alongside the fetched rows) rather than per
mount.

## ADV-7 - NIT - CONFIRMED

**`PreviewCandidate.declinedThisProperty` has no reader.**

Where: written at `app/src/routes/broadcasts.ts:817`, typed at
`dashboard/src/api/types.ts:3408`; the dashboard derives the flag from
`declinedContactIds` instead (RecipientPreview). Two wire encodings of one fact, one
unread, can drift unnoticed. (It mirrors the existing
alreadySentThisProperty / priorRecipientContactIds pair, so this is a consistency
choice.)

Fix: drop the per-candidate field, or read it in initialRows and keep the list only
for hand-added rows.

---

Not reported (checked, judged by design or pre-existing): the per-contact global
"replied" (any inbound anywhere after the send); the Sent-to / listings-sent cards now
503 instead of degrading (documented D12); duplicate tours on a concurrent double
Interested (acknowledged I3 in the route comment and the tour-create-no-dedupe issue);
requireTenantContact accepting a soft-deleted tenant (identical to POST /api/tours);
the email path touching only on the winning delivery (documented).
