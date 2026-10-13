# Planner review R1 - adversarial (plan-blind)

Branch: `feat/primary-contact-integrity` at `971c9551` (worktree
`W:\tmp\primary-contact-integrity`). Read: `git diff main...HEAD` over
`app/src`, `app/scripts`, `dashboard/src`, `e2e`, the FakeWorld units/contacts
fakes, the new tests' names and selected bodies, and the `docs/issues` files
the branch adds or edits (to avoid re-raising what is already filed). No spec,
plan or prior review was read. Nothing was run (read-only; the planner is
running the gates).

Summary: no BLOCKING or HIGH finding. The core write paths (addContact
auto-primary, removeContact / restoreWithLandlord / handOffPrimaryFrom
hand-offs, the backfill's conditional write) are fenced on the read they
decide from, re-decide per retry, and share one pure decision with the
FakeWorld, and I could not construct a lost update, a lost roster row or a
crash. One MEDIUM (a one-click UI path that recreates exactly the routing the
server refuses to make automatically, with a cross-tenant privacy
consequence) and seven LOW.

---

## 1. [MEDIUM] The no-primary box offers ONE-CLICK "Make <Name> primary" for a tenant (any non-caseworker type), the very promotion the server refuses to make automatically

**What is wrong.** The property page's no-primary box counts as "eligible"
every row that is not deleted and not a caseworker
(`dashboard/src/routes/listing/ListingDetail.tsx:480-481`), and when exactly
one such row exists it renders a one-click `Make <Name> primary` button
(`ListingDetail.tsx:1035-1046`). The row flags the server sends carry only
`deleted` and `caseworker` (`app/src/routes/units.ts` `UnitContactView`,
`enrichRosterView`), so the dashboard cannot tell a tenant-typed (or
partner/unknown-typed) row from a property manager. The comment at
`ListingDetail.tsx:471-477` says this is "broader than the server's
AUTOMATIC rule (typed landlord) on purpose". But the server's automatic rule
excludes non-landlord types for a concrete reason the heir function itself
documents: "a tenant or a caseworker added by accident is never promoted
automatically" (`app/src/lib/propertyContact.ts:274-277`, enforced at `:319`
via `isAutoRoutingEligible`, `:55-63`).

**Why it matters.** Once a tenant T1 is the flagged primary of property U:

- `resolveRoster`'s default for every NEW tour or placement at U by another
  tenant T2 is `[T2, T1]` (`app/src/lib/rosterResolution.ts:335`; the
  `is_tenant` stop only fires when the candidate IS this owner's tenant), so
  T1 is provisioned onto T2's relay group and receives T2's tour logistics,
  and the intro names T1 as the person T2 is touring with ("Putting you in a
  group text with <T1>..." - `app/src/jobs/relayFanOut.ts` tour variants via
  `resolveTourContactNames`).
- It disables the self-healing rule: auto-primary on the next eligible add
  only fires when there is no LIVE flagged primary
  (`app/src/repos/unitsRepo.ts:328-360`, `autoPrimaryLivenessIds` /
  `decideAutoPrimary`), so adding the real landlord later does NOT fix it; only a
  second deliberate Make primary does.

**Reachable, and steered to.** Tenants are offered by "+ Add contact"
(`ListingDetail.tsx:468-470` filters caseworkers only), the e2e spec models
"a tenant - on the list by accident" (`e2e/tests/dashboard-next/primary-contact-integrity.spec.ts:260`),
and the backfill script lists every unit whose only live contacts are a
tenant or a caseworker and tells the operator to "choose one on the property
page" (`app/scripts/assign-primary-contacts.ts:329`, `:452`, `:466`). On such
a unit with one live tenant row the box then shows exactly one CTA: `Make
<Tenant> primary`. The correct guidance for that case,
`NO_ELIGIBLE_LINE` ("Add the landlord or property manager - they become the
primary automatically", `ListingDetail.tsx:148`), is only shown when there
are zero non-caseworker rows (`:1062-1063`).

**Concrete scenario.** Imported property, no landlord of record, contact list
`[Jane Doe (type tenant, role other)]`. Backfill dry run lists it under
"No eligible contact ... choose one on the property page". Sam opens it; the
box says "No primary contact." with one button "Make Jane Doe primary"; one
click. Next week tenant Bob books a tour there; the default people list is
Bob + Jane, the group opens, and Jane (a tenant) receives Bob's tour intro and
every message on Bob's group.

**Suggested fix.** Add a response-only `autoEligible: true` (or
`landlordTyped: true`) row flag from the same complete read in
`enrichRosterView` (it already has the contact), offer the one-click only for
rows that carry it, and show `NO_ELIGIBLE_LINE` (plus "Choose a primary" to
reach edit mode) when no row does. Reword the script's noEligible line so it
does not invite choosing a tenant.

---

## 2. [LOW] Every contact DELETE now runs an unprojected, strongly consistent full-table Scan of units plus sequential per-unit hand-offs inside the request, with no retry for the units it gives up on

**What is wrong.** `DELETE /api/contacts/:id` awaits
`handOffPrimariesOfDeletedContact` (`app/src/routes/contacts.ts:2275-2279`)
before the unread reset and the presence fan-out (`:2343-2371`) and before
responding. The service Scans the WHOLE units table, live and soft-deleted,
with `ConsistentRead` (2x read units) and no `ProjectionExpression`, so whole
unit items (descriptions, media keys, facts) are read to look at
`contacts`/`landlordId` (`app/src/services/primaryHandoff.ts:78-91`;
`app/src/repos/unitsRepo.ts:1502-1527`). This runs for every delete of every
contact type (a tenant, a spam texter), since no type can be ruled out
cheaply (Make primary is type-agnostic) and there is no roster index. Then,
per target unit, sequentially: a consistent GetItem, a BatchGet, a
conditional UpdateItem and an audit append (`primaryHandoff.ts:106-143`;
`unitsRepo.ts:1730-1770`). A unit that answers `unknown` (throttled read) or
exhausts its 3 conditional attempts is logged and never retried
(`primaryHandoff.ts:110-113`, `:138-141`) - that half is already filed in
`docs/issues/roster-liveness-read-eventual-consistency.md`.

**Scenario.** A PM contact who is the flagged primary on 150 properties is
deleted: ~600 sequential DynamoDB round trips before the 200, so the
Contacts page's Delete button spins for seconds and the inbox/Today presence
refresh is delayed by the same amount. Today's scale (a few hundred to low
thousands of units) keeps the Scan itself cheap; the cost grows linearly
with the table and with the contact's holdings.

**Suggested fix.** Give `list` an optional projection (unitId, contacts,
landlordId) for the target-finding Scan, and move the hand-off off the
request path into a job (`jobs.enqueue` / `defineJobHandler`, which also
gives the `unknown` / conflict units a bounded retry). If it stays inline,
run it after the presence fan-out so the live views are not held hostage.

---

## 3. [LOW] Write-deciding liveness reads are eventually consistent; the restore heir pick regressed from a consistent read, and the fix is one BatchGet option

**What is wrong.** Every automatic decision reads liveness through
`readRosterContacts` -> `getManyByIds(..., { requireComplete: true })`
(`app/src/lib/propertyContact.ts:86-104`), whose BatchGet carries no
`ConsistentRead` (`app/src/repos/contactsRepo.ts:978-980`). On main, the
"Restore without a landlord" pick read each remaining contact with
`getById(..., { consistentRead: true })`; it now uses the eventually
consistent batch (`app/src/routes/units.ts:597-602`). The same read also
feeds the add / remove response row flags, so a contact created moments ago
can render "(deleted)" and the box "This property's contact was deleted."
right after it was added.

Already filed (`docs/issues/roster-liveness-read-eventual-consistency.md`,
severity low) and the race windows are sub-second, hence LOW - but it is
listed here because the fix is a single per-table `ConsistentRead: true` in
`batchGetByIds` threaded through `readRosterContacts` for the write-deciding
callers, it removes two of the three filed shapes, and one of them is a
regression against main. Worth doing before merge rather than after.

---

## 4. [LOW] removeContact of a NON-primary row leaves a stale `primary_contact` scalar in place, contradicting the new contract

**What is wrong.** The branch rewrites the contract as "the roster writes -
addContact, removeContact, restoreWithLandlord, handOffPrimaryFrom - keep the
`primary_contact` scalar consistent" (`app/src/repos/unitsRepo.ts:74-76`) and
`UnitItem.primary_contact` says it is "that row's contactId, or REMOVEd when
no row is flagged" (`unitsRepo.ts:476-495`). addContact now always
writes the scalar (`:1277-1280`) and the restore's no-hand-off branch aligns
it (`:1698-1700`), but removeContact only touches it when the removed row was
the primary (`:1357`, `:1370-1385`).

**Scenario.** Legacy unit: an old re-role demoted X (main's addContact never
blanked the scalar), so no row is flagged and `primary_contact = X`. Staff
remove X (a non-primary row): the scalar still names X, a contact no longer
on the list, and GET /api/units/:id serves it (the response spreads the
stored unit). The backfill only aligns when a live flagged primary exists, so
with no heir it stays. Nothing routes on the scalar, hence LOW; e2e specs do
assert on it, so the next reader trusting the contract is misled.

**Suggested fix.** In removeContact's non-primary branch set
`patch.primary_contact` to the flagged row of `remaining` or `null` (one line,
the same rule addContact uses).

---

## 5. [LOW] New import cycle: `lib/propertyContact.ts` <-> `repos/unitsRepo.ts` (value imports both ways)

`app/src/lib/propertyContact.ts:28-29` value-imports `unitContacts` (and
`isDeleted` from contactsRepo); `app/src/repos/unitsRepo.ts:42-48`
value-imports `applyPrimary`, `chooseHeir`, `rosterContactIds` from
propertyContact. It works today only because neither module touches the
other's bindings during module evaluation (all uses are inside functions).
The first top-level constant that does (a frozen default, a precomputed set)
fails with a TDZ ReferenceError whose surfacing depends on which module an
entry point loads first - the compiled `node dist/` smoke would catch only the
entry orders it exercises. `e2e/scenarios/steps.ts:40-43` already had to
document the extra transitive weight. Suggested fix: move `UnitContact` and
`unitContacts` (pure, no SDK) into a leaf module both import, or move
`chooseHeir`/`applyPrimary` next to them.

---

## 6. [LOW] The "live contact" rule and the landlordId normalization are re-implemented in several places; the ladder pin can pass vacuously

- "live" is written three times: `isLive` in `app/src/lib/propertyContact.ts:38-40`,
  inline in `decideAutoPrimary` (`app/src/repos/unitsRepo.ts:356-359`), and
  the script's own `isLive` (`app/scripts/assign-primary-contacts.ts:118-121`).
  The branch's stated goal is one rule (spec 4.3 / the single-source pins),
  but the pins only guard `isAutoRoutingEligible` and the old ladder shapes.
- "non-empty landlordId" is re-derived inline in removeContact, restore,
  handOffPrimaryFrom, the restore route, the script's `landlordOf` and
  propertyContact's `nonEmptyId`.
- `app/test/propertyContactLadderSingleSource.test.ts` has no non-vacuity
  guard (its sibling `autoRoutingEligibleSingleSource.test.ts` has one): if
  the walk ever finds no files (a path change), it passes having checked
  nothing.

Suggested fix: export `isLive`/`nonEmptyId` from propertyContact and use them
in the repo and script; add a "walked at least N files" assertion to the
ladder pin.

---

## 7. [LOW] The backfill counts and audits units that are not broken (no flag, live landlord of record)

`planUnitPrimary` treats "no flagged row" as a target whenever the heir
function names an heir (`app/scripts/assign-primary-contacts.ts:133-157`).
With a live landlord of record, P1 already resolves that unit to the landlord
(`app/src/lib/propertyContact.ts:151-158`), so nothing about who tours and
relay groups reach changes - but the dry run reports it under "Would get a
primary contact" (`:446`) and the apply appends a
`unit_primary_contact_assigned { reason: 'backfill' }` that the property
Activity renders as "Primary contact set automatically - set by a one-time
data repair". The legacy shape exists (a pre-auto-primary landlord claim, a
PATCH landlord reassign). Consequence: the number the human reads in the
RUNBOOK dry run overstates the broken population, and unbroken properties
get an Activity row. Suggested fix: count/report "flag the live landlord of
record" separately (or classify it like `align`: write the flag and scalar,
no audit event).

---

## 8. [LOW] The contact Delete dialog's new sentence promises a hand-off that often does not happen

`DELETE_PRIMARY_HANDOFF_SENTENCE` (`dashboard/src/routes/contact/ContactDetail.tsx:138-141`)
says "If they're a property's primary contact, the landlord or another
contact on that property takes over". No one takes over when there is no
eligible heir (`handOffPrimaryFrom` answers `unchanged`,
`app/src/repos/unitsRepo.ts:1748`), when the contact is the
landlord of record of a property with no flagged row (the filed
`primary-handoff-no-flag-landlord-delete-gap`), or when the best-effort
hand-off fails/answers unknown (`primaryHandoff.ts:110-141`). Staff reading
it will reasonably conclude deleting is safe for routing. Suggested fix:
"...another contact on that property may take over" plus, ideally, a count in
the response of properties left without a primary so the page can say so.

---

## 9. [LOW] Test gap: the delete hand-off never runs through the real route with the real repos, and no e2e walks it

The DELETE route tests (`app/test/contactDeletePrimaryHandoff.test.ts`) run
on FakeWorld, whose `list` ignores `consistentRead` and whose
`getManyByIds` ignores `requireComplete`
(`app/test/helpers/twilioWebhookHarness.ts:2289-2296`, `:3076-3097`); the
real `handOffPrimaryFrom` is covered on DynamoDB Local in isolation
(`unitsRepoHandOffPrimary.integration.test.ts`), and the e2e spec covers the
box, the dialog and the remove hand-off but not contact delete or the restore
hand-off. The route-to-service-to-real-repo wiring (the Scan args, the
exclusion of the deleted id, the audit) for the most consequential new write
path is therefore pinned only by fakes. Suggested fix: one DynamoDB Local
route-level test (or one e2e step: delete the primary, assert the heir on the
property page and the Activity line).

---

## Checked and found sound (no finding)

- Auto-primary on add/edit: decided per attempt on a consistent unit read,
  only for X, never when X is the flagged primary or the landlord of record,
  conditional write fenced on landlordId + contacts[]; explicit demotion is
  respected; the route's `autoPrimary` audit derivation cannot fire on a
  pre-existing primary.
- removeContact / restoreWithLandlord / handOffPrimaryFrom: heir excluded
  contact never read, re-decided on each retry, `applyPrimary` never throws on
  any reachable input (addLandlordRow computed from the same roster), no
  derived roster is ever written where it could drop rows.
- Error mapping: RosterReadFailedError only from liveness, 503 only on the
  primary-removal and landlord-restore paths; GET never 500s on the read.
- Dev seam: mounted only through `lib/devRoutes.ts` (devAuthEnabled, not
  production, DynamoDB Local endpoint), same posture as `/__dev/org-fixture`.
- PII: new logs carry ids, counts and reason codes only; the relay INFO line
  omits street and names; the Activity projection lifts `reason` for the new
  event type only.
- `primary_contact` removed from WRITABLE_FIELDS: no dashboard form, seed,
  script or e2e spec sends it on create/PATCH.
- ASCII: no non-ASCII on any added line.
