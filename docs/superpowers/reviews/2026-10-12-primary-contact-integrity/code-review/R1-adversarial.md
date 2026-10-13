# R1 adversarial code review - feat/primary-contact-integrity

Reviewer: plan-blind adversarial reviewer (fresh eyes). Branch tip 29114f8c,
merge base fa35f228. Inputs read: the four review packages
(`.superpowers/review/package-app-src.diff`, `package-app-test.diff`,
`package-dashboard.diff`, `package-e2e.diff`), the worktree sources around every
touched symbol, the repo-wide readers and writers of those symbols, and the
branch's `docs/issues/` and RUNBOOK changes. NOT read: anything under
`docs/superpowers/` (spec, plan, review records, research), `.superpowers/sdd/`,
`package-docs.diff`, `package-index.md`, `code-review/R1-conformance.md`. No test
suite, build, lint or typecheck was run in the worktree (an e2e gate is live on
it); the repros below live in the scratchpad and are for the fix wave to run.

## 1. Intended behavior, as derived from the code and its tests

The branch makes "who is this property's contact?" a single decision. One
lookup (`app/src/lib/propertyContact.ts` `resolvePropertyContact` /
`decidePropertyContact`, "P1") walks two candidates - the contact-list row
flagged primary, then the landlord of record - and SKIPS a candidate that is
soft-deleted or has no record, stops (no fall-through) when a candidate is the
tour/placement tenant, and stops with `read_failed` when a read throws. Every
naming/default-roster reader moved onto it: the tour/placement default people
list (`rosterResolution.resolveRoster`), tour-reminder and relay-intro names
(`tourContacts`), and the too-thin open diagnostics (`rosterProvision`). Every
AUTOMATIC primary choice goes through one heir function (`chooseHeir`): the live
landlord of record (no type test), else the earliest-added roster contact that is
typed landlord, live and not a routing pointer, else nobody; a failed liveness
read is "unknown", never "deleted". The writes keep the flag and the
`primary_contact` scalar together (`applyPrimary`): removing the primary row
hands off to the heir (503 `roster_read_failed` when liveness is unknown); a
restore that clears or swaps a landlord hands off when the old landlord's row is
flagged OR no row is flagged (`landlordWasPrimary`); deleting a contact runs a
best-effort, consistent full Scan of units and hands every unit whose FLAGGED
primary is that contact to its heir (the deleted contact excluded and not read);
auto-primary widens to "an add or an edit of X's own row makes X primary when X
is eligible and there is no LIVE flagged primary and no LIVE landlord of record";
a soft-deleted contact can never be MADE primary (409 `primary_contact_deleted`);
`primary_contact` is no longer client-writable. Each automatic move appends
`unit_primary_contact_assigned { reason, from? }`, which the Activity card shows.

The second half explains fallbacks. `resolveRelayComposeInputs` keeps the exact
variant rules but now evaluates every check and, for an owned (tour/placement)
conversation that falls back to the general intro, returns `introFallback` with
every reason in a fixed order plus the unit id / street / contact id; the open
preview (only) carries it to the dashboard, the intro job logs it (ids and codes
only). The property GET and the contact-list write responses add response-only
row flags (`deleted`, `caseworker`) and a `propertyContact` block (P1's answer
and `heirIfPrimaryRemoved`) only when the roster read was complete. The dashboard
shows a "No primary contact." box with a one-click fix, names the server's heir
in the remove confirm, marks deleted rows, shows a fallback box with "Check
again" in the open-group dialog (an unedited draft follows the new preview, an
edited one is kept with a notice), and re-reads after restores. A one-time
script (`app/scripts/assign-primary-contacts.ts`) repairs existing data with the
same `chooseHeir` / `applyPrimary`, one conditional write per unit, dry run by
default. A dev-only seam builds the imported zero-primary shape for e2e.

## 2. Findings

Severity scale: BLOCKING / HIGH / MEDIUM / LOW / NOTE. No BLOCKING or HIGH
finding survived my own verification. Every repro named below is in the single
scratchpad file listed in section 5.

### F1 - MEDIUM - CONFIRMED - the contact-delete hand-off misses a no-flag property whose landlord of record is the deleted contact

- Where: `app/src/services/primaryHandoff.ts:86-89` (a unit is a target only
  when `unitContacts(unit)`'s FLAGGED row is the contact) and the re-check
  `app/src/repos/unitsRepo.ts:1738` (`flagged === undefined || flagged.contactId
  !== fromContactId` -> `not_primary`). Compare `app/src/lib/propertyContact.ts:145-152`
  (P1 falls back to the landlord of record when no row is flagged) and the shared
  rule `app/src/repos/unitsRepo.ts:865-868` `landlordWasPrimary` ("NO row is
  flagged -> true: the hand-off is how the property gets a primary"), used by
  `restoreWithLandlord` (`unitsRepo.ts:1621-1622`) and the restore route
  (`app/src/routes/units.ts:593`). The issue file
  `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md` records
  the ruling "Shape 1: YES, 'no row flagged' counts".
- Mechanism: on a unit with a stored contact list where no row is flagged and
  `landlordId = L` (live), P1 answers L - L IS the property's contact for the
  default people list, the tour intro and the reminders. `DELETE
  /api/contacts/L` soft-deletes L; the Scan only collects units whose flagged
  row is L, so this unit is never a target; afterwards P1 skips L and answers
  nobody (`reason: 'deleted'`) although an eligible, live PM is on the list. No
  `unit_primary_contact_assigned` row, no hand-off, and nothing re-runs it. The
  same property handled by the restore paths WOULD hand off, because they use
  `landlordWasPrimary`. Two hand-off triggers disagree on what "was the
  primary" means; the shared rule exists and the delete path bypasses it.
- Reachability: legacy units from landlord claims written before
  caseworker-integrity's auto-primary (the issue file above says this shape
  exists), any unit between this deploy and the backfill run (the backfill would
  flag L if run before the delete, and repairs it if run after - but it is a
  one-time script), an API demotion (`primaryContact: false` on the flagged
  landlord row), and a remove-with-no-heir followed by a contact restore. Rare
  after the backfill, but it is exactly the failure class this branch exists to
  close, on its main new code path. The contact Delete dialog
  (`dashboard/src/routes/contact/ContactDetail.tsx:140`, `:1417`) tells staff
  "the landlord or another contact on that property takes over" - false here.
- Repro: scratchpad `r1Adversarial.repro.test.ts`, describe "R1-F1". The first
  test shows `landlordWasPrimary` returns true for this roster; the second seeds
  `{ landlordId: c-ll, contacts: [c-ll (landlord, not flagged), c-pm (pm, not
  flagged)] }`, shows the GET block names c-ll, deletes c-ll, and expects c-pm.
  Expected today: the second test FAILS - `propertyContact` is `{ contactId:
  null, reason: 'deleted', heirIfPrimaryRemoved: null }` and no audit row.
- Fix: make the Scan's target predicate and `handOffPrimaryFrom`'s re-check the
  shared rule for the deleted contact: target when the flagged row is the
  contact, OR when no row is flagged and `unit.landlordId === contactId`
  (exactly `landlordWasPrimary(unitContacts(unit), contactId)` restricted to the
  contact being the landlord when nothing is flagged). `chooseHeir` already
  excludes the deleted landlord and `applyPrimary` flags the heir. Pin it with
  the repro (FakeWorld) and one DynamoDB Local integration case; correct the
  Delete dialog sentence if the outcome stays "nobody" in some case.

### F2 - LOW - CONFIRMED mechanism, PLAUSIBLE frequency - the liveness reads that decide writes are eventually consistent; the restore heir pick lost a pinned consistent read; an EC miss is read as "deleted"

- Where: `app/src/lib/propertyContact.ts:80-98` (`readRosterContacts` ->
  `getManyByIds(..., { requireComplete: true })`), whose BatchGet has no
  `ConsistentRead` at all (`app/src/repos/contactsRepo.ts:957-1000`). Callers
  that decide WRITES from it: `addContact` auto-primary (`app/src/routes/units.ts:1406`
  -> `unitsRepo.ts` `decideAutoPrimary`), `removeContact` (`unitsRepo.ts:1373-1377`),
  the restore swap (`unitsRepo.ts` restoreWithLandlord), the restore-without-
  landlord pick (`app/src/routes/units.ts:595-600`), `handOffPrimaryFrom`, and
  the backfill script. The restore pick REPLACED main's per-row
  `contacts.getById(row.contactId, { consistentRead: true })`; the test that
  pinned it ("(PIN) reads the remaining contacts CONSISTENTLY",
  `app/test/unitsRestoreLandlord.test.ts`) was rewritten to pin the batch read
  instead.
- Mechanism: (a) a stale replica still returns a contact deleted a moment ago
  as live, so `chooseHeir` can pick it - e.g. Staff A deletes C while Staff B
  restores a property without a landlord; the heir pick reads C's pre-delete
  image and C becomes the primary, which spec 4.4's "a soft-deleted contact is
  never made the primary" forbids. C's own delete hand-off may already have
  scanned past that unit, so nothing corrects it. (b) Because "absent from a
  complete read = missing = deleted" (spec section 3), an EC MISS of a contact
  created moments ago is read as deleted: auto-primary on an add can demote a
  LIVE primary in favor of the added contact, and the same response marks the
  live row `deleted: true` (the property page then says "(deleted)" and may show
  "This property's contact was deleted."). The design already handles the
  commonest stale read (the delete hand-off EXCLUDES the deleted contact rather
  than reading it); the residual cases are other contacts' recent writes. Sub-
  second windows; accepted-race class except that one site was consistent
  before.
- Repro: describe "R1-F2" (two tests, both PASS today because they assert the
  defective outcome; the lagging replica is simulated by wrapping
  `getManyByIds`): (1) restore without a landlord promotes `c-gone`, whose
  stored record is soft-deleted but whose batch image is stale - main's
  consistent per-row read would have promoted `c-pm`; (2) an add of `c-x`
  demotes the live flagged primary `c-p` when the batch read misses `c-p`, and
  the response marks `c-p` deleted.
- Fix: add a `consistentRead` option to `getManyByIds` / `batchGetByIds`
  (BatchGetItem accepts `ConsistentRead: true` per table in `RequestItems`) and
  pass it from `readRosterContacts` for the write-deciding callers; keep the
  page GET eventually consistent if cost matters. Restore the consistency pin on
  the restore pick. Cost: 2x RCU on a handful of keys per roster write.

### F3 - LOW - CONFIRMED - `landlordWasPrimary` treats a DELETED flagged row elsewhere as "a live primary exists"; the comments say "live"

- Where: `app/src/repos/unitsRepo.ts:865-868`; callers `unitsRepo.ts:1615-1622`
  and `app/src/routes/units.ts:589-594`, whose comments say "a live flagged row
  elsewhere is never displaced". The rule checks only the flag, never liveness.
- Mechanism: a soft-deleted unit, landlord of record `c-old` (re-typed tenant,
  so the restore needs a choice), list `[c-old (not flagged), c-gone (flagged,
  contact soft-deleted), c-pm (live, typed landlord)]`. "Restore without a
  landlord": `landlordWasPrimary` is false (c-gone is flagged), so no hand-off;
  the restore stores c-gone still flagged and no landlord. P1 then answers
  nobody (`reason: 'deleted'`) while c-pm is eligible. Reachable when c-gone's
  own delete hand-off was skipped (`unknown`: a throttled liveness read - the
  service skips the unit with a WARN and nothing retries it), found no heir at
  the time, or lost the F4 race. The swap branch is functionally fine (P1 falls
  to the new live landlord).
- Repro: describe "R1-F3" (FAILS today: the GET block is `{ contactId: null,
  reason: 'deleted' }`; the test expects c-pm).
- Fix: either compute "flagged elsewhere" from LIVE rows (the restore paths
  already read liveness when they hand off; reading it one step earlier costs one
  batch read on this rare path), or correct the two comments and accept it (the
  property box then shows "This property's contact was deleted." with a
  one-click fix).

### F4 - LOW - CONFIRMED (accepted-race class) - concurrent deletes, or a delete racing a remove, can leave a deleted contact flagged; skipped units are never retried

- Where: `app/src/services/primaryHandoff.ts:78-143` (Scan, then per-unit
  hand-off) and `unitsRepo.ts:1727-1766` (`handOffPrimaryFrom`: the write is
  fenced on landlordId + contacts[] only, never on the heir's liveness).
- Interleaving (no stale replica needed): unit U flagged P, list [P, Q, R].
  t0 DELETE P persists; t1 P's hand-off reads U and reads liveness: Q live;
  t2 DELETE Q persists; t3 Q's hand-off Scan reads U - P still flagged, so U is
  no target of Q; t4 P's hand-off writes Q flagged (its fence holds: contacts and
  landlordId are unchanged). Result: U's primary is the soft-deleted Q; P1
  answers nobody although R is eligible. Same shape for `removeContact` of the
  primary racing a delete of the landlord of record it is about to pick. Also:
  a unit whose hand-off answered `unknown` (throttle) or threw (3 lost writes)
  is logged and skipped forever - the only later sweep is the one-time backfill.
- Repro: describe "R1-F4" (PASSES today - it asserts the bad outcome; the
  nested DELETE of Q runs inside P's liveness read, after the snapshot).
- Fix: accept and document (file an issue; the property box makes the state
  visible), or re-check the chosen heir with a consistent single-key read right
  before the write, and document re-running the backfill as a periodic sweep in
  the RUNBOOK.

### F5 - LOW - CONFIRMED - every contact DELETE runs an unbounded, consistent, unprojected full Scan of the units table inside the request

- Where: `app/src/routes/contacts.ts:2275-2279` -> `primaryHandoff.ts:78-91`.
- Mechanism: the Scan runs for EVERY delete (a tenant or an unknown with no
  seat anywhere included), reads whole unit items (media arrays, addresses,
  notes) with `ConsistentRead` (2x RCU), synchronously before the response; the
  final INFO log embeds every moved/unchanged/failed unit id in one line.
  Staff-only and single-delete in the UI today, so a cost/latency shape, not an
  exploitable DoS; it grows with the units table and adds a second or more to a
  delete at a few MB.
- Repro: describe "R1-F5" (PASSES today: a tenant on no contact list still
  issues `list({ deleted: 'any', consistentRead: true })`).
- Fix: add a `ProjectionExpression` (unitId, contacts, landlordId) for this
  Scan; optionally run the hand-off after the response (it is best-effort
  already); cap or count (not list) ids in the summary log.

### F6 - NOTE - the no-primary box offers a one-click "Make <tenant> primary"

- Where: `dashboard/src/routes/listing/ListingDetail.tsx:478-481` - "eligible"
  rows are rows not flagged `deleted` and not flagged `caseworker`; rows carry no
  type, so a TENANT row counts. RUNBOOK step 4 sends Sam to this box for every
  `noEligible` property ("only a tenant or a caseworker is live").
- Effect: on such a property the box's single button is "Make <Tenant Name>
  primary"; one click makes a tenant the property contact - put on every new
  tour's default people list and named as the landlord in tour intros ("Putting
  you in a group text with <tenant>"). The server's own automatic rule refuses
  tenants for exactly this reason. The code comment says the breadth is
  deliberate; flagging because the button does not say the person is a tenant.
- Repro (manual or dashboard test): `integrityState([TENANT_ROW], { contactId:
  null, reason: 'none', heirIfPrimaryRemoved: null })` renders
  "Make <tenant> primary". Suggest a `type`/`eligible` row flag from the server,
  or route the one-click only to typed-landlord rows.

### F7 - NOTE - copy that states something the code does not do

- `ContactDetail.tsx:140` Delete dialog: "the landlord or another contact on
  that property takes over" - false when no heir exists, and for F1.
- `ListingDetail.tsx:143` "This property's contact was deleted." - also shown
  when the contact merely has no record (import retraction) or, per F2, when a
  live contact was missed by an EC read.
- `app/src/services/rosterProvision.ts` diagnostics: a soft-deleted property
  contact now answers "landlord contact not found" (tour) and
  `landlord_unreachable` / "the unit landlord has no phone on file"
  (placement) - pinned verbatim by tests, but they misdescribe a deleted
  contact.
- `dashboard/src/routes/listing/listingFormat.ts` `auto_on_add` -> "the property
  had no primary contact", also used when the property HAD a (deleted) primary.

### F8 - NOTE - the module header overclaims "every reader"

`app/src/lib/propertyContact.ts:5-13` says every reader now walks this lookup.
The placement-nudge landlord rungs still route to `unit.landlordId` directly
(`app/src/jobs/placementNudges.ts:422-446`; `app/src/routes/placementNudges.ts:227-240`)
- see PRE-1. After a hand-off, tours use the heir while nudges still target
(or, if deleted, refuse at send for) the old landlord.

### F9 - NOTE - maintainability: double reports and types that permit forgettable states

- One liveness failure logs two WARNs (`readRosterContacts` plus the caller:
  `routes/units.ts` add callback, `primaryHandoff.ts:140`, `tourContacts`).
- `ContactListFacts.contactDeleted?` is optional: a future caller that forgets
  it silently disables the repo-side 409 `primary_contact_deleted`.
- An absent `readContacts` means "promote nothing" in `addContact` but "refuse
  with 503" in `removeContact` / restore - the same option, two meanings.
- `PropertyContactBlock` (`routes/units.ts`) permits `{ contactId: 'x', reason }`.
- The dashboard mirrors `IntroFallbackReason`, its order and the
  `PRIMARY_ASSIGNED_REASON` table by hand (documented MIRRORS; drift risk).
- Benign today: `unitsRepo.ts` <-> `lib/propertyContact.ts` is an import cycle;
  neither reads the other at load time (function declarations only), so it is
  safe until someone adds a top-level const that calls across it.

### F10 - NOTE - multi-flag rosters are only half handled

P1 (`propertyContact.ts:146`), `handOffPrimaryFrom`'s re-check and the delete
Scan all take the FIRST row flagged primary. A roster with two flagged rows (no
current writer makes one, but nothing repairs one) where the first is deleted
never reaches the second; the backfill's `align` path writes such a roster back
unchanged (only its `target` path, through `applyPrimary`, normalizes to one).

### F11 - NOTE - the backfill re-flags every no-flag unit that has a live landlord

`planUnitPrimary` (`app/scripts/assign-primary-contacts.ts:130-158`) targets
"flagged primary absent AND an heir exists", so every no-flag unit with a live
landlord of record gets the landlord flagged, `updated_at` stamped and a
"Primary contact set automatically - set by a one-time data repair" Activity
row, although P1's answer for it does not change. Behavior-neutral for routing;
it overrides a deliberate "no primary" state and adds Activity noise. The
RUNBOOK's spot-check paragraph acknowledges these targets.

### F12 - NOTE - dev seam input checks (local-only)

`app/src/routes/dev.ts` `POST /__dev/fixtures/zero-primary-property`: no length
cap on `street`; a row's `contactId` passes when ANY record exists - a phone or
email routing-pointer row or a soft-deleted contact included. Structurally
absent in deployed envs (see S1), so test-harness hygiene only.

## 3. Checked and SOUND

- S1 Security: the new dev route lives in `createDevRouter`, reachable only via
  `app/src/lib/devRoutes.ts` `maybeLoadDevRouter` (dynamic import gated by
  `devAuthEnabled && nodeEnv !== 'production' && dynamodbEndpoint`); no static
  import elsewhere (grep). `json()` scoped to the route. 1-5 rows, roles
  allowlisted, duplicates refused.
- S2 `consistentRead` on `unitsRepo.list` is not client-controllable: `GET
  /api/units` builds its opts explicitly.
- S3 Dropping `primary_contact` from `WRITABLE_FIELDS` breaks no caller: main's
  dashboard never sent it (git grep on main), the importer writes `landlordId`
  only, seeds write through repos - so no stale-bundle 400 (no tombstone needed).
- S4 503 `roster_read_failed`: CloudFront custom error pages cover only 502/504
  (`infra/modules/cloudfront/main.tf:213-221`), 503 is an established app
  pattern, the dashboard client does not auto-retry, and both dialogs map it.
- S5 Every new write is fenced on landlordId + contacts[]
  (`updateRosterIfCurrent`), retries are bounded, `handOffPrimaryFrom`
  re-checks on each retry, restore keeps `requireSoftDeleted`. Walked: two racing
  eligible adds cannot both promote; a hand-off racing an explicit Make primary
  ends `not_primary`; a hand-off racing a restore answers 409 or re-decides; a
  PATCH landlordId racing a hand-off fails the fence and re-decides
  (off-roster landlord -> `addLandlordRow`).
- S6 `ResolvedTourNames.propertyContact` (a whole ContactItem with phone) is
  never serialized: `contactTimeline.ts:1122` and `:857-877`,
  `relayGroups.ts:253-265`, `tourReminders.ts:264-276` read names/flags field
  by field.
- S7 PII: every new log line carries ids, counts and reason codes only; new
  response fields (row flags, heir name, intro street) are staff-only data
  already on those pages; the public flyer projection is an allowlist and
  untouched.
- S8 Relay intro: the chosen VARIANT is unchanged for every input I walked
  (owner missing/throwing, unit missing, no contact, no first name, no street,
  unscheduled/empty/unparseable/started time, settings missing/throwing,
  placement, ownerless); only `introFallback` and one INFO line are new; the
  operator-edited branch and the member-added path log nothing new.
- S9 The FakeWorld calls the SAME pure decisions as the real repo
  (`chooseHeir`, `applyPrimary`, `decideAutoPrimary`, `landlordWasPrimary`) and
  a parity test runs both; remaining hand copies (seat/claim/P2 refusals) are
  filed in `contact-list-rule-duplication-and-fake-drift`.
- S10 One soft-delete path for contacts (`DELETE /api/contacts/:id`); the
  caseworker conversion only READS roster seats (`contactHoldings.rosterUnitIds`);
  no other writer edits rosters around the heir function.
- S11 ASCII: no non-ASCII character on any added line in app/src, app/test,
  dashboard, e2e.
- S12 e2e: the second `role="status"` in the open dialog affects no existing
  spec (only `contact-create-relay-group.spec.ts` scopes the duplicate warning,
  on the standalone dialog that never gets `introOwner`); selectors.md updated.
- S13 Dashboard: the edit form PATCHes only changed fields, so the block and row
  flags never ride back into a PATCH; `setUnit` never clears the load-time
  block; restores re-read; the box hides on deleted properties and with no
  rows; the remove confirm reads the server's heir.
- S14 `readRosterContacts` never throws (both failure shapes -> ok:false); the
  property GET never 500s on a read failure and falls back to best-effort rows.
- S15 The GET block's `heirIfPrimaryRemoved` is the same `chooseHeir` call
  `removeContact` makes (same exclusion, same landlord normalization).
- S16 Activity projection lifts `reason` only for
  `unit_primary_contact_assigned`, keeping `listing_status_changed`'s free text
  off the wire.
- S17 The backfill: dry run by default, stage client resolves tables and
  credentials (account guard first), one conditional write per unit with no
  re-read, idempotent, exit codes as documented, ids-only output.

## 4. PRE-EXISTING (not caused by this diff)

- PRE-1 Placement-nudge landlord rungs route to `unit.landlordId`
  (`app/src/jobs/placementNudges.ts:422-446`), never to the property contact; a
  soft-deleted landlord is refused at send (`:823-829`). Diverged from the
  primary row before this branch too.
- PRE-2 A soft-deleted contact can become a landlord of record: unit create,
  PATCH `landlordId` and the restore choice (`requireLandlordContact`,
  `app/src/services/contactTypeGuards.ts:83-90`, type-only), the plain restore
  (`app/src/routes/units.ts:1999-2005` checks type only), and the vacant-slot
  claim - including from the dashboard: re-roling a seated "(deleted)" row to
  Landlord on an ownerless property claims the slot, after which the row cannot
  be removed (409). `docs/issues/auto-routing-changes-not-named.md` calls the
  claim "API-only"; the role select makes it a dashboard path. P1 now skips such
  a landlord, so the property quietly has no property contact. Repro: describe
  "R1-PRE-1" (PASSES today).
- PRE-3 A soft-deleted member of a tour/placement PLAN keeps its phone and is
  provisioned and texted (`memberFromContact`); filed as
  `relay-provision-includes-deleted-contacts`.
- PRE-4 `contactsRepo.softDelete` (`app/src/repos/contactsRepo.ts:1427-1441`) is
  unconditional: a repeated DELETE re-stamps `deleted_at` and re-appends
  `contact_deleted`; a phone/email pointer row id can be soft-deleted through
  the route.
- PRE-5 `DELETE /api/contacts/:id` appends `contact_deleted` before any
  fan-out (`app/src/routes/contacts.ts:2263-2266`); a throw there 500s after the
  delete persisted and skips the hand-off, the unread reset and the presence
  fan-out, with no retry.
- PRE-6 `PATCH /api/units/:id` `landlordId` is a blind update not fenced against
  roster writes (`app/src/routes/units.ts:1843-1892`) - the source of off-roster
  landlords that `addLandlordRow` now absorbs.
- PRE-7 FakeWorld `contactsRepo.getManyByIds` / `getById` return LIVE objects,
  so any test that captures a read and then mutates a contact sees the mutation
  through the captured value (the R1-F4 repro clones to model a real snapshot).

## 5. Scratchpad repro

One file, FakeWorld harness only (no DynamoDB Local), to be copied into the
worktree's `app/test/` AFTER the running e2e gate finishes:

`C:\Users\Cameron\AppData\Local\Temp\claude\W--AI-Projects-Housing-Choice-HC-Application\31dd19d5-88f8-443e-a959-f9c3f41c0ab3\scratchpad\r1-adversarial\r1Adversarial.repro.test.ts`

Run: `cd W:/tmp/primary-contact-integrity/app && npx vitest run test/r1Adversarial.repro.test.ts`

Expected on tip 29114f8c: "R1-F1 ... hands the property to the eligible PM"
and "R1-F3 ... hands off to the eligible contact" FAIL (those failures are the
findings); "R1-F1 ... shared rule", "R1-F2" (both), "R1-F4", "R1-F5" and
"R1-PRE-1" PASS (they assert the defective outcome directly). Delete the copy
afterwards; it is not meant to be committed as-is.
