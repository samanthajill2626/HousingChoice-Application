# Primary contact integrity - implementation plan

Status: v4 2026-10-13 (sections 0-3 binding; slices S1-S5 from five section drafts; contract issues ruled in 3.2; plan review rounds 1-3 folded in - see plan-review/adjudications.md).
Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
(rev 6, approved and reconciled by Cameron 2026-10-13). Section references
below like "spec 4.4" point there.
Worktree: `W:\tmp\primary-contact-integrity`, branch
`feat/primary-contact-integrity`, `main` merged in at 0e565b86
(caseworker-integrity and join-housing-authority included).

## 0. How to execute this plan

- PRECONDITION, once before Task S1.1: the worktree has no `node_modules`.
  Run `cd W:/tmp/primary-contact-integrity && npm ci` and confirm
  `ls node_modules/vitest/package.json` succeeds.
- Execute the slices IN ORDER: S1 -> S2 -> S3 -> S4 -> S5. Inside a slice,
  tasks run in order. Each task is TDD: write the failing test, run it RED,
  implement, run it GREEN, commit (explicit paths, gating `git status` first).
- Every command runs from the worktree root `W:\tmp\primary-contact-integrity`
  with an explicit `cd` or absolute path (the shell cwd resets between calls).
- Unit tests for one file: `cd app; npx vitest run test/<file>` (DynamoDB
  Local must be running for repo integration tests - `npm run db:start`; never
  restart a SHARED DynamoDB Local container without Cameron's go). Dashboard:
  `cd dashboard; npx vitest run src/<path>`.
- Slice gates (end of each slice): `npm run typecheck` and the touched
  workspaces' tests. The FULL completion gates (AGENTS.md: typecheck, test,
  smoke, e2e, eslint on touched files) run at the end of S5 only.
- Mid-build breakage stated aloud (plan review R1 P2). Two short windows
  INSIDE S2 leave the real API wrong between two consecutive tasks, by
  construction (each repo task lands before the route task that wires it):
  after S2.5 and before S2.6, removing a PRIMARY row through the real route
  answers 500 (the repo needs `readContacts`, which the route passes only from
  S2.6); after S2.7 and before S2.8, a landlord SWAP whose old landlord was
  primary answers 500 the same way. The FakeWorld route tests do not see
  either window. Never run e2e or a live session inside S2; every other slice
  boundary leaves `main`'s behavior intact for paths not reached yet.
- DynamoDB Local: `app/test/globalSetup.ts` PROBES it on EVERY vitest run in
  the app workspace and throws when it is unreachable - even for test files
  that use only in-memory fakes. Start it with
  `cd W:/tmp/primary-contact-integrity && npm run db:start` (never RESTART a
  shared container without Cameron's go). If it cannot be started, a
  fake-only file may run with the prefix `ALLOW_SKIP_DYNAMO_TESTS=1` - a
  deliberate unit-only pass, never a gate. Where a task below says "no
  DynamoDB Local is needed", read it as "no tables are used; the probe still
  needs the container or the prefix" (plan review R1 P4).
- ASCII only in every new or touched line of code, comments, test names and
  docs. Edit source with the Edit tool, never a PowerShell rewrite.

## 1. Global constraints (copied from the spec, binding)

- C1 One shared property-contact lookup (spec 4.1): candidates = flagged
  primary row (from `unitContacts(unit)`), then `landlordId` if non-empty and
  different. Per candidate, in order: equals the tenant id -> STOP nobody
  `is_tenant` (id comparison BEFORE any read); read throws -> STOP
  `read_failed` with `candidateId` (never fall through); deleted or missing ->
  SKIP; else FOUND. Exhausted -> nobody `deleted` if any candidate was
  skipped, else `none`. Never throws.
- C2 Liveness for automatic decisions (spec 4.2): ONE batch read of the roster
  ids + `landlordId` with `requireComplete`; ANY throw (raw chunk error or
  `IncompleteBatchReadError`) = UNKNOWN, never "deleted". Read before the
  conditional roster write, refreshed on every retry. Unit reads on these
  paths are strongly consistent. A contact the request just deleted is never
  read - it is the EXCLUDED contact.
- C3 Eligible for automatic routing (spec 4.3) = `main`'s rule, moved to a
  shared module unchanged: exists, `type === 'landlord'`, not soft-deleted,
  not `phone_ref`, not `email_ref`.
- C4 Heir function (spec 4.3, PURE, shared by the real repo and the API-test
  fake): 1. the landlord of record if live and not excluded (no type test; if
  no roster row, the result says to ADD one, `role: 'landlord'`); 2. else the
  earliest-added roster contact that is eligible (C3) and not excluded; 3.
  else none with `no_live_candidate` / `no_eligible_candidate`; liveness read
  failed -> `unknown`. The excluded contact counts as not live at every step.
- C5 P2 auto-primary (spec 4.4): a roster write for contact X (add, or an
  edit of X's own row) makes X - ONLY X - primary when X is eligible (the
  route's `facts.autoPrimaryEligible`), there is no LIVE flagged primary and
  no LIVE landlord of record, on the attempt's own read. Never promotes
  another contact. No promotion + no flagged row -> REMOVE a stale scalar; a
  deleted flagged contact keeps flag AND scalar. Unknown liveness -> the write
  succeeds unpromoted (WARN). 409 `primary_contact_deleted` only when a write
  would make a soft-deleted contact primary that is not already primary
  (checked after the route's 404 and after caseworker-integrity's type
  checks). Re-sending true for an already-primary row is never refused.
- C6 P2b (spec 4.5): `primary_contact` removed from the writable unit fields
  (create and PATCH).
- C7 P3 handoffs (spec 4.6): REMOVE of the primary -> heir / clear all flags
  + REMOVE scalar / unknown -> 503 `roster_read_failed`, nothing written.
  DELETE of a contact -> after the soft delete persists, one strongly
  consistent Scan (live + soft-deleted units) finds units whose
  `unitContacts()` primary is the contact; per unit, re-read consistently,
  re-check it is still the flagged primary, heir -> MOVE flag + scalar / none
  -> NOTHING changes / unknown -> skip + WARN; conditional-write failure ->
  re-read and re-decide with the bounded retries (3); best-effort, never fails
  the delete. Contact RESTORE -> no roster change. "Restore without a
  landlord" -> the REMOVE rule (heir excluding the cleared landlord) REPLACES
  `soleLandlordToPromote`. Landlord SWAP when the old landlord was primary ->
  re-run the heir function after the swap.
- C8 Intro fallback reasons (spec 5.1) and their transport (5.2): the exact
  union and rules in spec 5.1; `RosterPreview.introFallback` set only by the
  tour and placement OPEN previews; the job's INFO line with ids + reason
  codes only.
- C9 Property payload (spec 7.5): rows gain `deleted?: true`,
  `caseworker?: true` (only on a complete read); unit gains
  `propertyContact?: { contactId: string | null; reason?: 'none' | 'deleted';
  heirIfPrimaryRemoved: { contactId: string; name?: string } | null }`,
  ABSENT when the read was incomplete; an incomplete read falls back to
  today's best-effort read for names; the GET never 500s.
- C10 Dashboard copy is EXACTLY the spec's (7.1 table and heading, 7.2, 7.3,
  7.4, 7.6). New-tab links. Check again. The edited-draft rule.
- C11 Audit: `unit_primary_contact_assigned` `{ contactId, reason, from? }`
  with `reason` one of `auto_on_add | handoff_on_remove | handoff_on_delete |
  handoff_on_restore | backfill`; the unit Activity projection serves
  `reason` for `unit_primary_contact_assigned` ONLY (ruling R17:
  `listing_status_changed` already stores staff free text under `reason`,
  which must stay off the wire).
- C12 Script (spec 8): `app/scripts/assign-primary-contacts.ts`, no lock,
  own conditional write against its own read, counts `targets`, `noHeir`,
  `noEligible`, `unknown`, `skippedOnCondition`, `scalarAligned`; ids only.
- C13 Lean seed byte-stable; the e2e zero-primary state comes from a new
  DEV-ONLY seam that creates its own unit + contacts.

## 2. Shared contracts (binding interfaces between slices)

A slice that needs a contract changed raises it as a CONTRACT ISSUE at the top
of its draft; the planner rules before assembly. Names below are final unless
ruled otherwise.

### 2.1 `app/src/lib/propertyContact.ts` (NEW, S1)

```ts
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { UnitContact, UnitItem } from '../repos/unitsRepo.js';
import type { Logger } from './logger.js';

/** C3 - moved verbatim from routes/units.ts `autoRoutingEligible`. */
export function isAutoRoutingEligible(contact: ContactItem | undefined): boolean;

/** A contact read for automatic decisions (C2). */
export type RosterContactsRead =
  | { ok: true; byId: Map<string, ContactItem> }
  | { ok: false };

/** C2: ONE batch read, requireComplete, ANY throw -> { ok: false }.
 *  De-duplicates ids and drops empty strings. Never throws. */
export async function readRosterContacts(
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  ids: Iterable<string | undefined>,
  logger?: Logger,
): Promise<RosterContactsRead>;

/** The ids C2 reads for a unit: every unitContacts() row + landlordId. */
export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[];

export type PropertyContactResult =
  | { kind: 'found'; contactId: string; contact: ContactItem }
  | { kind: 'nobody'; reason: 'none' | 'deleted' | 'is_tenant' }
  | { kind: 'read_failed'; candidateId: string };

/** C1, PURE: decide from a lookup. `lookup` answers per id:
 *  { ok: true, contact } (contact undefined = missing) or { ok: false } (threw). */
export function decidePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  lookup: (contactId: string) => { ok: true; contact: ContactItem | undefined } | { ok: false };
}): PropertyContactResult;

/** C1, async: reads candidates LAZILY with getById (candidate 2 only if 1 was
 *  skipped) - today's read count. Never throws. */
export async function resolvePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<PropertyContactResult>;

export type HeirResult =
  | { kind: 'heir'; contactId: string; addLandlordRow: boolean }
  | { kind: 'none'; why: 'no_live_candidate' | 'no_eligible_candidate' }
  | { kind: 'unknown' };

/** C4, PURE. `roster` is unitContacts(unit) (array order = add order). */
export function chooseHeir(args: {
  roster: readonly UnitContact[];
  landlordId: string | undefined;
  exclude?: string;
  read: RosterContactsRead;
}): HeirResult;

/** Apply a heir to a roster copy: flag exactly the heir (adding the landlord
 *  row when addLandlordRow), or clear every flag for `null`. Returns the new
 *  roster and the scalar patch value (contactId, or null = REMOVE). PURE. */
export function applyPrimary(
  roster: readonly UnitContact[],
  heir: { contactId: string; addLandlordRow: boolean } | null,
): { contacts: UnitContact[]; primaryContactScalar: string | null };
```

### 2.2 Repo write contracts (S2)

- `UnitsRepo.addContact(unitId, contact, facts, opts?)` - `facts` keeps
  `ContactListFacts` (`caseworker`, `landlordTyped`, `autoPrimaryEligible`);
  NEW optional `opts.readContacts?: (ids: string[]) => Promise<RosterContactsRead>`
  supplied by the route (bound to `readRosterContacts`), called PER ATTEMPT for
  the flagged primary + `landlordId` liveness (C5). Absent = the caller cannot
  decide liveness: today's `main` rule only (no flagged row, no `landlordId`).
- `UnitsRepo.removeContact(unitId, contactId, opts?)` - NEW optional
  `opts.readContacts` as above, required for the heir when the removed row is
  primary; unknown -> throws NEW `RosterReadFailedError` (route 503
  `roster_read_failed`). Unit read becomes strongly consistent.
- `UnitsRepo.handOffPrimaryFrom(unitId, fromContactId, readContacts)`: NEW.
  Returns `'moved' | 'unchanged' | 'not_primary' | 'unknown'` plus the
  written unit when moved. Consistent read; re-check; C4 with `exclude:
  fromContactId`; conditional write via `updateRosterIfCurrent`; bounded
  retries; `RosterWriteConflictError` after exhausting them.
- `UnitsRepo.list(opts)` gains `consistentRead?: boolean` (Scan
  `ConsistentRead`).
- `RestoreWithLandlordInput` `next: null` keeps `promote: string | null` (and
  `expectContacts`); the ROUTE now decides `promote` with `chooseHeir`
  (exclude the cleared landlord) instead of `soleLandlordToPromote`. The swap
  branch's primary decision re-runs `chooseHeir` (S2 decides whether the route
  passes it or the repo computes it from a supplied `readContacts`; either way
  the heir function is the only rule).
- The API-test fake (`app/test/helpers/twilioWebhookHarness.ts`) mirrors every
  signature above and calls `chooseHeir` / `applyPrimary` - no twin logic.

### 2.3 Errors and codes

- `RosterReadFailedError` (NEW, `unitsRepo.ts`) -> 503 `{ error:
  'roster_read_failed' }`.
- `PrimaryContactDeletedError` (NEW) or a route-level check -> 409 `{ error:
  'primary_contact_deleted' }`.
- Diagnostics in `rosterProvision.ts` keep their codes/texts per spec 4.1.

### 2.4 Audit (S2 writes, S3 projects, S4 renders)

`unit_primary_contact_assigned`, entity `units#<unitId>`, payload
`{ contactId: string; reason: 'auto_on_add' | 'handoff_on_remove' |
'handoff_on_delete' | 'handoff_on_restore' | 'backfill'; from?: string }`.
Appended by the ROUTE / service / script after a successful write, derived
from the write's own result (never a separate read). Not appended for an
explicit Make primary (that is `unit_contact_added` as today).

### 2.5 Intro fallback (S3)

`IntroFallbackReason` and `IntroFallback` exactly as spec 5.1, exported from
`app/src/jobs/relayFanOut.ts` next to `RelayComposeInputs` (which gains
`introFallback?: IntroFallback`). `RosterPreview` (app
`services/rosterEdits.ts` and dashboard `api/types.ts`) gains
`introFallback?: IntroFallback`.

### 2.6 Property payload (S3 serves, S4 renders)

App `routes/units.ts` and dashboard `api/types.ts`:

```ts
// UnitContact wire row additions (response only, never stored)
deleted?: true;
caseworker?: true;
// unit response addition
propertyContact?: {
  contactId: string | null;
  reason?: 'none' | 'deleted';
  heirIfPrimaryRemoved: { contactId: string; name?: string } | null;
};
```

### 2.7 Dev seam (S5)

`POST /__dev/fixtures/zero-primary-property` (hermetic-only, mounted with the
other `/__dev` routes) - body `{ street: string; rows: Array<{ contactId:
string; role: 'pm' | 'owner' | 'other' }> }` (1-5 rows, each contact once;
`landlord` role refused) - creates a NEW unit (status `setup`, no
`landlordId`, no `accepted_authorities`) whose roster is those rows, all
NON-primary, and answers 201 `{ unitId }`. The SPEC creates the contacts
through the real `POST /api/contacts` first; the seam only checks they exist
(ruling R23, refined by S5).

## 3. Slice map

| slice | scope | owns (files it edits) |
|---|---|---|
| S1 app lookup + heir | 2.1 module; move `autoRoutingEligible` into it (units.ts imports it); move the four ladder copies onto C1 (`lib/tourContacts.ts`, `lib/rosterResolution.ts` default branch, `services/rosterProvision.ts` two diagnostics) keeping today's codes/texts and the bare-row-on-read-failure; correct the false docblock at `rosterResolution.ts:174-180` | `lib/propertyContact.ts`, `lib/tourContacts.ts`, `lib/rosterResolution.ts`, `services/rosterProvision.ts`, `routes/units.ts` (ONLY the `autoRoutingEligible` move), their tests |
| S2 app writes | 2.2-2.4: P2 widen in `addContact` + route, 409, P2b, `removeContact` heir + 503, `handOffPrimaryFrom` + `list(consistentRead)`, the contact-DELETE fan-out service and its wiring in `routes/contacts.ts`, restore route `chooseHeir` in place of `soleLandlordToPromote` + swap rule, audit appends, the API-test fake | `repos/unitsRepo.ts`, `routes/units.ts` (contact-list routes, restore route), `routes/contacts.ts` (DELETE), `lib/unitFields.ts`, NEW `services/primaryHandoff.ts`, `app/test/helpers/twilioWebhookHarness.ts`, their tests |
| S3 app reads | 2.5-2.6: `resolveRelayComposeInputs` reasons + `introFallback`, `RosterPreview` + `buildOpenPreview` pass-through, job INFO line; `enrichRoster` complete read + rows flags + `propertyContact` block on GET and the two roster writes' responses; Activity projection `reason` | `jobs/relayFanOut.ts`, `services/rosterEdits.ts`, `routes/units.ts` (`enrichRoster`, GET, `toUnitActivityEvent`), their tests |
| S4 dashboard | types; `RosterConfirmDialog` box + Check again + edited-draft rule; `TourDetail` / `PlacementDetail` `onCheckAgain`; `ListingDetail` box, notice, deleted rows (no Make primary), 409/503 copy, facts subline, restore refetch as roster source; `rosterSuggestions` skip deleted; `ContactDetail` delete sentence; unit activity renderer line | `dashboard/src/api/types.ts`, `routes/shared/RosterConfirmDialog.*`, `routes/tours/TourDetail.tsx`, `routes/placements/PlacementDetail.tsx`, `routes/listing/*`, `routes/shared/rosterPeople.ts`, `routes/contact/ContactDetail.tsx`, the activity renderer file, their tests |
| S5 script, seam, e2e, docs | `app/scripts/assign-primary-contacts.ts` + tests; the dev seam; e2e specs (a)-(c) of spec 10 + scenario verbs; GLOSSARY, RUNBOOK section, issue updates (`tour-reminder-zero-primary-e2e-gap` partial; `relay-provision-includes-deleted-contacts` stays open); completion gates | `app/scripts/`, `app/src/routes/dev.ts`, `e2e/`, `documentation/GLOSSARY.md`, `RUNBOOK.md`, `docs/issues/` |

Ordering traps:

- S1 before S2/S3: both import 2.1.
- `routes/units.ts` is edited by S1 (one import move), S2 (contact-list and
  restore routes) and S3 (`enrichRoster`, GET, Activity projection). Each
  slice edits ONLY its regions; anchors are function names, not line numbers.
- S4 needs S2's error codes and S3's payload shapes; S5's e2e needs all four.
- Watch item (plan review R1 P3): the contact-DELETE hand-off runs one
  strongly consistent units Scan per delete. `e2e/tests/dashboard-next/roster-paging.spec.ts`
  deletes 60 contacts in one `Promise.all`, so gate 4 issues 60 concurrent
  Scans against the lane's (small, per-lane) units table. Expected cheap; if
  that spec slows or times out at gate 4, measure before blaming anything
  else and report it - do not tune it away silently.
- Restore paths decide "does this restore need a primary hand-off?" through
  ONE shared pure rule, `landlordWasPrimary(roster, landlordId)` (Task S2.7
  (e); plan review R1-R3): yes when the old landlord's row is the FLAGGED
  primary, or when NO row is flagged; a live flagged row elsewhere is never
  displaced. It never reads `primary_contact` (caseworker-integrity's three
  no-flag pins stay GREEN because no-flag always hands off). Task S2.7 (real
  repo), Task S2.8 (`clearedLandlordHeir`, the API-test fake) all call it;
  with no hand-off they re-align the scalar to the stored flag.

### 3.1 Surface -> task matrix (the invariant sweep; every row needs a task)

Mutation surfaces (spec 9.1): unit create (C6) S2; unit PATCH (C6) S2;
contact-list add/edit (C5, 409) S2; contact-list remove (C7) S2; contact
DELETE (C7 fan-out) S2; contact restore (no change - a test pins it) S2; unit
plain restore (no change) S2; "Restore without a landlord" (C7) S2; landlord
swap (C7) S2; importer upsert / retract (no change - P1 covers; no task beyond
S1's missing-contact tests); API-test fake S2; dashboard roster callers S4;
seeds (lean UNCHANGED - S5 verifies byte-stability; performance seed
unchanged); dev seam S5.

Readers (spec 9.2): four ladder copies S1; `resolveTourContactNames` callers
(reminders job, reminder routes, relayGroups scheduled previews, contact
timeline, relay intro) S1 via `tourContacts.ts` - each gets a deleted-primary
test where it composes copy; `resolveRoster` default callers (describeRoster,
applyRosterPlanEdit materialization, previews, provisioning, rosterActions,
tenant gates) S1 via `rosterResolution.ts` - the read-failure bare row pinned;
`enrichRoster` + property page S3/S4; People-card suggestions S4; Activity
projection + renderer S3/S4; relay intro reasons S3; dialog S4.

Unchanged on purpose (landlord of RECORD readers, spec 9.2): no tasks; S1
adds no edits there.

### 3.2 Contract rulings (binding; they override any slice text)

Each slice below opens with the CONTRACT ISSUES its writer raised against
sections 0-3. Every one is RULED; the full table, with reasons, is
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/plan-research/plan-assembly-rulings.md`
(R1-R25). Where a slice's issue text says "ruling needed", read the ruling
here, not the question. In short:

- Accepted as the slice drafted them: R1 (`ResolvedTourNames.propertyContact?`),
  R3 (the propertyContact <-> unitsRepo cycle: no top-level reads either way),
  R4, R5, R6 (swap repo-decided per attempt; clear route-decided), R7
  (audit via the write's own result and `onPrimaryHandoff`; payload carries
  `actor`), R8, R9, R10, R11, R13 (the restore's liveness read is the spec 4.2
  batch read), R14, R15 (binding on S1), R16, R17, R18, R19, R20 (S5.7/S5.8 own
  the e2e copy updates), R21 (S4 P-1..P-8), R22 (S5 adds
  `assignPrimaryIfCurrent`), R23 (the refined seam, contract 2.7 above).
- Changed at assembly: R2 - the shared `routes/units.ts` import: S1 aliases
  (`isAutoRoutingEligible as autoRoutingEligible`); S2.4 imports BOTH names;
  S2.8 drops the alias when it deletes `soleLandlordToPromote`; S3.5 3a is an
  exact replacement of the import S2.8 leaves. R12 - NEW Task S4.10b (a
  restore's 503 `roster_read_failed` shows the shared "Couldn't check the
  other contacts - try again." from `rosterCopy.ts`). R24 - gate 4 runs under
  `timeout 2700`. R25 - `npm ci` precondition (section 0).

## 4. Slices

Assembled from the five section drafts (S1-S5), with the assembly rulings
above applied to their text.

## S1 - app lookup + heir (plan section draft)

### CONTRACT ISSUES (RULED - section 3.2 and plan-assembly-rulings.md govern; do not act on any "ruling needed" text here)

Each item: where the skeleton (sections 2-3) does not fit the merged code or
the spec, what this draft does, and what the planner must rule.

1. **`ResolvedTourNames` gains `propertyContact?: PropertyContactResult`**
   (`app/src/lib/tourContacts.ts`). S3 needs the C1 reason (none / deleted /
   is_tenant / read_failed, and the found contact's id for
   `property_contact_no_first_name`) for the relay intro, and
   `resolveRelayComposeInputs` reads the property contact ONLY through
   `resolveTourContactNames`. This draft adds the field: the whole C1 result,
   PRESENT exactly when a `unit` was passed (a lookup ran), ABSENT when
   `unit` is undefined. `tenantReadFailed` / `propertyReadFailed` keep their
   meaning exactly; `propertyReadFailed === (propertyContact?.kind ===
   'read_failed')`. No caller's compile breaks: every caller reads named
   fields (`jobs/relayFanOut.ts` reads only `resolved.names`, so S1 makes NO
   edit to `relayFanOut.ts`). `routes/contactTimeline.ts` spreads the result
   into an internal `UnitNames` value that is never serialized. Ruling
   needed: accept the field name and shape for S3.

2. **`routes/units.ts` imports the moved rule under its OLD local name, and
   loses the `isContactDeleted` import.** S1 adds
   `import { isAutoRoutingEligible as autoRoutingEligible } from '../lib/propertyContact.js'`
   and deletes the local function, so every call site and comment in
   `soleLandlordToPromote` and the contact-list add route stays
   byte-identical - S2's and S3's Edit anchors, drafted against the pre-S1
   tree, still match. Because the deleted function was the only user of
   `isDeleted as isContactDeleted` (units.ts import from contactsRepo), S1
   REMOVES that import (otherwise `no-unused-vars` fails gate 5 on a touched
   file). Consequence for S3: `enrichRoster`'s `deleted: true` row flag
   needs a contact soft-delete test and must ADD its own import
   (`isDeleted as isContactDeleted` from `../repos/contactsRepo.js`) - it is
   not there after S1. Ruling needed: alias (this draft) vs a rename; S2 may
   rename freely when it rewrites those regions.

3. **ESM import cycle risk once S2 lands.** `lib/propertyContact.ts` imports
   the VALUE `unitContacts` from `repos/unitsRepo.ts` (contract 2.1 shows
   type-only imports, but C1 and `rosterContactIds` are defined over
   `unitContacts()`). If S2 makes `unitsRepo.ts` import `chooseHeir` /
   `applyPrimary` (contract 2.2 implies the repo calls them), the two modules
   form a two-module cycle. It is SAFE as written - each side references the
   other only inside function bodies, never at module top level - and S2
   must keep it that way (no top-level call into propertyContact.ts from
   unitsRepo.ts, e.g. no module-level constant built from it). Ruling
   needed: accept with that rule stated in S2.

4. **`applyPrimary` edge behavior the contract leaves open.** (a) An heir
   that has no roster row while `addLandlordRow` is false cannot be flagged
   (`chooseHeir` never produces one); this draft THROWS
   `applyPrimary: heir <id> has no roster row and addLandlordRow is false`
   rather than return a scalar no row agrees with. (b) The appended landlord
   row is `{ contactId, role: 'landlord', primaryContact: true }` with NO
   `name` / `company` - applyPrimary has no contact record. Names are
   enriched at read time (`enrichRoster`), so nothing renders wrong; if S2
   wants stored denormalization (as `restoreWithLandlord` does for a new
   landlord row) it sets them on the appended row after the call. The row is
   APPENDED (array order = add order), matching `restoreWithLandlord`'s
   push. Ruling needed: accept (a) and (b).

5. **Matrix 3.1 per-caller coverage for `resolveTourContactNames`.** The
   matrix says each caller (reminders job, reminder routes, relayGroups
   scheduled previews, contact timeline, relay intro) "gets a deleted-primary
   test where it composes copy". This draft writes the deleted-primary tests
   at the SHARED function, composing a real reminder body through
   `composeTourReminderBody`, plus a separate relay-intro file through
   `resolveRelayComposeInputs` + `composeIntroBody`. The four reminder-copy
   callers pass `resolved.names` UNMODIFIED into `composeTourReminderBody`
   (verified: `jobs/tourReminders.ts` composeBodyForRow,
   `routes/tourReminders.ts` composeInputsOf (two call sites),
   `routes/relayGroups.ts` scheduled bucket, `routes/contactTimeline.ts`
   namesOnce), so per-caller tests would re-test one function through four
   harnesses. Ruling needed: accept the shared-function coverage, or name
   the callers that must get their own test.

#### Notes for the planner (not contract changes)

- **Empty primary contactId.** C1 treats a flagged roster row whose
  `contactId` is `''` as NO candidate (falls through to the landlord of
  record). Today's ladder (`primary?.contactId ?? landlordId`) short-circuits
  on `''` and yields nobody. Unreachable in practice (roster writes validate
  `contactId`); pinned by a lookup test so the choice is visible.
- **`readRosterContacts` logs its own WARN** (`requested` count only) in
  addition to whatever its callers log.
- **`chooseHeir` precondition.** On `{ ok: true }` an id absent from `byId`
  is MISSING (complete read). A caller that reuses a liveness read across a
  retry whose unit re-read gained rows would see the new row as missing. C2
  already requires a fresh read per attempt; S2 must honor it.
- **S2 comment drift.** `repos/unitsRepo.ts` `ContactListFacts`
  (`autoPrimaryEligible` docblock) points at "routes/units.ts
  `autoRoutingEligible`"; after S1 the rule lives in
  `lib/propertyContact.ts` `isAutoRoutingEligible`. S2 owns unitsRepo.ts and
  should repoint it.
- **Dependencies.** The worktree currently has NO `node_modules`. Section 0
  has no install step; the builder must run `npm ci` once from the worktree
  root before Task S1.1 (S1 states it as a precondition below).
- **No spec contradictions found** for S1's surfaces; no findings file
  written.

---

### S1 - app lookup + heir

Scope (skeleton section 3): create `app/src/lib/propertyContact.ts` per
contract 2.1; move `routes/units.ts` `autoRoutingEligible` into it; move the
four "flagged primary ?? landlordId" ladder copies onto C1
(`lib/tourContacts.ts`, `lib/rosterResolution.ts` default branch, both
`services/rosterProvision.ts` diagnostics) keeping today's codes, texts and
the bare-row-on-read-failure; correct the false `memberFromContact`
docblock.

Preconditions (once, before Task S1.1):

- `cd W:/tmp/primary-contact-integrity && ls node_modules/vitest/package.json`
  must succeed. If it fails with "No such file or directory", run
  `cd W:/tmp/primary-contact-integrity && npm ci` once.
- Every test file S1 creates or edits is PURE or in-memory (fake repos, the
  FakeWorld harness) - no DynamoDB Local TABLES are used for Tasks S1.1-S1.7.
  The vitest globalSetup still PROBES the container on every run (section 0):
  start it, or prefix these fake-only runs with `ALLOW_SKIP_DYNAMO_TESTS=1`.
  The slice gate's whole-workspace run (Task S1.8 step 3) needs it running.

Files S1 creates:

- `app/src/lib/propertyContact.ts`
- `app/test/propertyContact.test.ts`
- `app/test/propertyContactLookup.test.ts`
- `app/test/propertyContactHeir.test.ts`
- `app/test/autoRoutingEligibleSingleSource.test.ts`
- `app/test/relayIntroPropertyContact.test.ts`
- `app/test/rosterPlanMaterializePropertyContact.test.ts`
- `app/test/rosterProvisionPropertyContact.test.ts`
- `app/test/propertyContactLadderSingleSource.test.ts`

Files S1 edits:

- `app/src/routes/units.ts` (ONLY the import block and the
  `autoRoutingEligible` definition)
- `app/src/lib/tourContacts.ts`
- `app/src/lib/rosterResolution.ts`
- `app/src/services/rosterProvision.ts`
- `app/test/tourContacts.test.ts`
- `app/test/rosterResolution.test.ts`

S1 does NOT edit `app/src/jobs/relayFanOut.ts` (S3 owns it; it compiles
unchanged - it reads only `resolved.names`).

All commands are bash. Every command `cd`s explicitly (the shell cwd resets).

---

#### Task S1.1 - propertyContact.ts part 1: the eligibility rule, the liveness read and its ids

Files:

- Create `app/src/lib/propertyContact.ts`
- Create `app/test/propertyContact.test.ts`

Steps:

**(1) Write the failing test.** Create `app/test/propertyContact.test.ts`
with exactly this content:

```ts
// Unit tests for lib/propertyContact.ts part 1 (primary-contact-integrity spec
// 4.2 / 4.3, plan contract 2.1): the automatic-routing eligibility rule (moved
// verbatim from routes/units.ts), the ids the liveness read covers, and the
// liveness read itself. PURE - in-memory fakes, no DynamoDB.
import { describe, expect, it, vi } from 'vitest';
import {
  isAutoRoutingEligible,
  readRosterContacts,
  rosterContactIds,
} from '../src/lib/propertyContact.js';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

type RosterUnit = Pick<UnitItem, 'contacts' | 'landlordId'>;
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): RosterUnit => o as unknown as RosterUnit;

describe('isAutoRoutingEligible (spec 4.3 - the ONE automatic-routing rule)', () => {
  it('is true for an existing, live, landlord-typed, non-pointer contact', () => {
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'landlord' }))).toBe(true);
    // An EMPTY deleted_at stamp is not a soft delete (contactsRepo isDeleted).
    expect(
      isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'landlord', deleted_at: '' })),
    ).toBe(true);
  });

  it('is false for a missing, soft-deleted, non-landlord or routing-pointer contact', () => {
    expect(isAutoRoutingEligible(undefined)).toBe(false);
    expect(
      isAutoRoutingEligible(
        contact({ contactId: 'c-1', type: 'landlord', deleted_at: '2026-10-01T00:00:00.000Z' }),
      ),
    ).toBe(false);
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'tenant' }))).toBe(false);
    expect(
      isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'partner', role: 'Caseworker' })),
    ).toBe(false);
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'unknown' }))).toBe(false);
    expect(
      isAutoRoutingEligible(
        contact({ contactId: 'phoneref#+15550100001', type: 'landlord', phone_ref: true }),
      ),
    ).toBe(false);
    expect(
      isAutoRoutingEligible(contact({ contactId: 'emailref#a@b.co', type: 'landlord', email_ref: true })),
    ).toBe(false);
  });
});

describe('rosterContactIds (spec 4.2 - the ids the liveness read covers)', () => {
  it('lists every roster row in order, then an OFF-roster landlord of record', () => {
    expect(
      rosterContactIds(
        unit({
          landlordId: 'c-ll',
          contacts: [
            { contactId: 'c-pm', role: 'pm', primaryContact: true },
            { contactId: 'c-owner', role: 'owner', primaryContact: false },
          ],
        }),
      ),
    ).toEqual(['c-pm', 'c-owner', 'c-ll']);
  });

  it('de-duplicates a landlord of record that already has a row', () => {
    expect(
      rosterContactIds(
        unit({
          landlordId: 'c-ll',
          contacts: [
            { contactId: 'c-ll', role: 'landlord', primaryContact: true },
            { contactId: 'c-pm', role: 'pm', primaryContact: false },
          ],
        }),
      ),
    ).toEqual(['c-ll', 'c-pm']);
  });

  it('covers a landlord-only unit through its DERIVED row (no stored roster)', () => {
    expect(rosterContactIds(unit({ landlordId: 'c-ll' }))).toEqual(['c-ll']);
  });

  it('drops an empty or absent landlordId', () => {
    expect(rosterContactIds(unit({ landlordId: '', contacts: [] }))).toEqual([]);
    expect(
      rosterContactIds(unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] })),
    ).toEqual(['c-pm']);
  });
});

describe('readRosterContacts (spec 4.2 - ONE complete batch read; ANY throw = unknown)', () => {
  it('reads the de-duplicated, non-empty ids ONCE with requireComplete', async () => {
    const ll = contact({ contactId: 'c-ll', type: 'landlord' });
    const getManyByIds = vi.fn(
      async (_ids: string[], _opts?: { requireComplete?: boolean }) => new Map([['c-ll', ll]]),
    );
    const read = await readRosterContacts({ getManyByIds }, ['c-ll', undefined, '', 'c-pm', 'c-ll']);
    expect(getManyByIds).toHaveBeenCalledTimes(1);
    expect(getManyByIds).toHaveBeenCalledWith(['c-ll', 'c-pm'], { requireComplete: true });
    expect(read).toEqual({ ok: true, byId: new Map([['c-ll', ll]]) });
  });

  it('reads nothing at all for no usable ids', async () => {
    const getManyByIds = vi.fn(
      async (_ids: string[], _opts?: { requireComplete?: boolean }) => new Map<string, ContactItem>(),
    );
    expect(await readRosterContacts({ getManyByIds }, [undefined, ''])).toEqual({
      ok: true,
      byId: new Map(),
    });
    expect(getManyByIds).not.toHaveBeenCalled();
  });

  it('a RAW chunk error is liveness UNKNOWN (ok: false), never a throw - logged with a count only', async () => {
    const capture = createLogCapture();
    const read = await readRosterContacts(
      {
        getManyByIds: async () => {
          throw new Error('dynamodb: ProvisionedThroughputExceededException');
        },
      },
      ['c-ll'],
      createLogger({ destination: capture.stream }),
    );
    expect(read).toEqual({ ok: false });
    const warns = capture.atLevel(40);
    expect(warns.map((line) => line['msg'])).toEqual([
      'property contact: roster liveness read failed - liveness unknown',
    ]);
    expect(warns[0]?.['requested']).toBe(1);
  });

  it('an IncompleteBatchReadError is liveness UNKNOWN too (spec 4.2: BOTH failure shapes)', async () => {
    const read = await readRosterContacts(
      {
        getManyByIds: async () => {
          throw new IncompleteBatchReadError(1, 2);
        },
      },
      ['c-ll', 'c-pm'],
      createLogger({ destination: createLogCapture().stream }),
    );
    expect(read).toEqual({ ok: false });
  });
});
```

**(2) Run it RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContact.test.ts
```

Expected RED: the file fails to load because the module does not exist yet -
vitest prints `Failed to load url ../src/lib/propertyContact.js` (or
`Cannot find module`) and `Test Files  1 failed (1)`.

**(3) Implement.** Create `app/src/lib/propertyContact.ts` with exactly this
content:

```ts
// The ONE property-contact lookup, the ONE heir function, and the liveness
// read and eligibility rule they share (primary-contact-integrity spec
// 2026-10-12, sections 4.1-4.3; plan contract 2.1).
//
// WHY ONE MODULE. "Who is this property's contact?" was answered by four
// inline copies of one ladder - the roster row flagged primary, else the
// landlord of record - in lib/tourContacts.ts, lib/rosterResolution.ts and
// both services/rosterProvision.ts diagnostics. None checked `deleted_at`, and
// contactsRepo.getById returns a soft-deleted contact, so a deleted primary
// was named in intro and reminder copy, put on the default people list,
// provisioned onto the relay group and texted. Every reader now walks the
// candidates here, and every AUTOMATIC primary choice (auto-primary, the
// handoffs, the backfill script) goes through chooseHeir.
//
// PURE where it can be: isAutoRoutingEligible, rosterContactIds,
// decidePropertyContact, chooseHeir and applyPrimary do no I/O. The two async
// functions NEVER throw: a failed read is an ANSWER (read_failed / ok:false),
// never "deleted" or "missing" (spec 4.2).
//
// PII (doc section 9): log lines carry ids and counts only - never a name or
// a phone.
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';

/** A non-empty string id, else undefined: a legacy landlordId of '' is "none". */
function nonEmptyId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Spec section 3 "live contact": a record exists and carries no deleted_at. */
function isLive(contact: ContactItem | undefined): contact is ContactItem {
  return contact !== undefined && !isDeleted(contact);
}

/**
 * The ONE eligibility rule for an AUTOMATIC routing choice - moved here
 * VERBATIM from routes/units.ts `autoRoutingEligible` (caseworker-integrity
 * spec revision 6 section 4 "Contact list (I4)" and "Restore"; final review
 * A4, fix wave FWF-3), so the contact-list route's auto-primary and the heir
 * function below share one definition (primary-contact-integrity spec 4.3).
 * The contact exists, is typed `landlord`, is NOT soft-deleted (the contacts
 * repo's own test - deleting a contact keeps its seats, and a deleted contact
 * is unusable for routing everywhere else) and is NOT a phone or email routing
 * pointer (a routing record, never a contact). A deliberate choice - the I3
 * claim of a vacant landlord slot, a landlord picked for a restore, an
 * explicit "Make primary" - asks only the type.
 */
export function isAutoRoutingEligible(contact: ContactItem | undefined): boolean {
  return (
    contact !== undefined &&
    contact.phone_ref !== true &&
    contact.email_ref !== true &&
    !isDeleted(contact) &&
    contact.type === 'landlord'
  );
}

/** A contact read for automatic decisions (spec 4.2). */
export type RosterContactsRead =
  | { ok: true; byId: Map<string, ContactItem> }
  | { ok: false };

/**
 * The liveness read every automatic decision makes (spec 4.2): ONE batch read
 * with `requireComplete`. That option fails in TWO shapes - a thrown chunk
 * rethrows the raw error, unprocessed keys throw IncompleteBatchReadError -
 * and ANY throw here means liveness UNKNOWN (`{ ok: false }`), never
 * "deleted": catching only the error class would turn a throttled read into a
 * 500.
 *
 * On `{ ok: true }` an id absent from `byId` is a contact that does NOT exist
 * (a complete read of an absent key), which spec section 3 treats exactly like
 * a deleted one. So a caller must read the ids of the SAME unit snapshot it
 * decides on (rosterContactIds) and read again on every retry.
 *
 * De-duplicates ids (BatchGetItem rejects duplicate keys), drops empty strings
 * and undefined, and reads nothing at all for an empty list. Never throws.
 */
export async function readRosterContacts(
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  ids: Iterable<string | undefined>,
  logger?: Logger,
): Promise<RosterContactsRead> {
  const unique = [
    ...new Set([...ids].filter((id): id is string => nonEmptyId(id) !== undefined)),
  ];
  if (unique.length === 0) return { ok: true, byId: new Map() };
  try {
    return { ok: true, byId: await contacts.getManyByIds(unique, { requireComplete: true }) };
  } catch (err) {
    (logger ?? defaultLogger).warn(
      { err, requested: unique.length },
      'property contact: roster liveness read failed - liveness unknown',
    );
    return { ok: false };
  }
}

/**
 * The ids the spec 4.2 read covers for one unit: every unitContacts() row (so
 * a landlord-only unit's DERIVED row counts) plus `landlordId` - an off-roster
 * landlord of record (an API PATCH reassign or an importer re-import can leave
 * one, spec 9.1) must not read as missing. Roster order first, then the
 * landlord; de-duplicated; empty ids dropped.
 */
export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const ids: string[] = [];
  for (const id of [...unitContacts(unit).map((row) => row.contactId), unit.landlordId]) {
    const usable = nonEmptyId(id);
    if (usable !== undefined && !ids.includes(usable)) ids.push(usable);
  }
  return ids;
}
```

**(4) Run it GREEN:**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContact.test.ts
```

Expected: `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: on branch `feat/primary-contact-integrity`; the ONLY changes are
the two untracked files `app/src/lib/propertyContact.ts` and
`app/test/propertyContact.test.ts`. Anything else: stop and report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory` (no merge in progress).

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/propertyContact.ts app/test/propertyContact.test.ts && git commit -m "feat(app): lib/propertyContact - the shared automatic-routing rule and the roster liveness read (primary-contact-integrity S1.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.2 - the property-contact lookup (C1): decidePropertyContact and resolvePropertyContact

Files:

- Modify `app/src/lib/propertyContact.ts`
- Create `app/test/propertyContactLookup.test.ts`

Steps:

**(1) Write the failing test.** Create `app/test/propertyContactLookup.test.ts`
with exactly this content:

```ts
// Unit tests for the ONE property-contact lookup (primary-contact-integrity
// spec 4.1, plan contract 2.1 / C1): decidePropertyContact (PURE, over reads
// the caller already holds) and resolvePropertyContact (async, LAZY getById).
// Every case runs through BOTH, so the two walks cannot drift: the same
// answer, and the same candidate reads in the same order. PURE - no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  decidePropertyContact,
  resolvePropertyContact,
  type PropertyContactResult,
} from '../src/lib/propertyContact.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

type LookupUnit = Pick<UnitItem, 'contacts' | 'landlordId'>;
const DELETED_AT = '2026-10-01T00:00:00.000Z';
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): LookupUnit => o as unknown as LookupUnit;

const PM = contact({ contactId: 'c-pm', type: 'landlord', firstName: 'Dana' });
const PM_DELETED = contact({ contactId: 'c-pm', type: 'landlord', firstName: 'Dana', deleted_at: DELETED_AT });
const LL = contact({ contactId: 'c-ll', type: 'landlord', firstName: 'Lee' });
const LL_DELETED = contact({ contactId: 'c-ll', type: 'landlord', firstName: 'Lee', deleted_at: DELETED_AT });
const TENANT_RECORD = contact({ contactId: 'c-t', type: 'tenant', firstName: 'Alice' });

/** A PM flagged primary next to the landlord of record (the PM-property shape). */
const PM_PRIMARY = unit({
  landlordId: 'c-ll',
  contacts: [
    { contactId: 'c-ll', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
});

interface Case {
  name: string;
  unit: LookupUnit;
  tenantId?: string;
  /** contactId -> record. An id absent here has NO record (hard-deleted). */
  records: Record<string, ContactItem>;
  /** ids whose read THROWS. */
  throwing?: string[];
  expected: PropertyContactResult;
  /** The candidate reads the walk makes, in order. */
  reads: string[];
}

const CASES: Case[] = [
  {
    name: 'a live flagged primary is found - the landlord of record is never read',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-pm', contact: PM },
    reads: ['c-pm'],
  },
  {
    name: 'zero-primary falls back to the live landlord of record',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    }),
    records: { 'c-pm': PM, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'a landlord-only unit resolves its landlord through the DERIVED row, read once',
    unit: unit({ landlordId: 'c-ll' }),
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'a DELETED primary is skipped to the live landlord of record',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED, 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a primary with NO record (an import retract hard-deletes) is skipped like a deleted one',
    unit: PM_PRIMARY,
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a deleted primary and a deleted landlord of record: nobody, reason deleted',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED, 'c-ll': LL_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-pm', 'c-ll'],
  },
  {
    name: 'a deleted SOLE primary with no landlord of record: nobody, reason deleted',
    unit: unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
    records: { 'c-pm': PM_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-pm'],
  },
  {
    name: 'a deleted landlord-only unit is ONE candidate (the derived row IS the landlord): read once',
    unit: unit({ landlordId: 'c-ll' }),
    records: { 'c-ll': LL_DELETED },
    expected: { kind: 'nobody', reason: 'deleted' },
    reads: ['c-ll'],
  },
  {
    name: 'no flagged row and no landlord of record (the imported no-landlord shape): nobody, reason none, nothing read',
    unit: unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
    records: { 'c-pm': PM },
    expected: { kind: 'nobody', reason: 'none' },
    reads: [],
  },
  {
    name: 'an EMPTY-STRING landlordId is no candidate - never read',
    unit: unit({ landlordId: '', contacts: [] }),
    records: {},
    expected: { kind: 'nobody', reason: 'none' },
    reads: [],
  },
  {
    name: 'a flagged row with an EMPTY contactId is no candidate - the landlord of record answers',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: '', role: 'pm', primaryContact: true },
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      ],
    }),
    records: { 'c-ll': LL },
    expected: { kind: 'found', contactId: 'c-ll', contact: LL },
    reads: ['c-ll'],
  },
  {
    name: 'the primary IS the tenant: STOP is_tenant before any read - no fall-through to a live landlord',
    unit: unit({
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-t', role: 'other', primaryContact: true },
      ],
    }),
    tenantId: 'c-t',
    records: { 'c-ll': LL, 'c-t': TENANT_RECORD },
    expected: { kind: 'nobody', reason: 'is_tenant' },
    reads: [],
  },
  {
    name: 'a deleted primary, then the landlord of record IS the tenant: is_tenant',
    unit: unit({
      landlordId: 'c-t',
      contacts: [
        { contactId: 'c-t', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    }),
    tenantId: 'c-t',
    records: { 'c-pm': PM_DELETED, 'c-t': TENANT_RECORD },
    expected: { kind: 'nobody', reason: 'is_tenant' },
    reads: ['c-pm'],
  },
  {
    name: 'no tenant given: no tenant test at all',
    unit: unit({ landlordId: 'c-t' }),
    records: { 'c-t': TENANT_RECORD },
    expected: { kind: 'found', contactId: 'c-t', contact: TENANT_RECORD },
    reads: ['c-t'],
  },
  {
    name: 'an EMPTY tenant id is no tenant: no tenant test at all',
    unit: unit({ landlordId: 'c-t' }),
    tenantId: '',
    records: { 'c-t': TENANT_RECORD },
    expected: { kind: 'found', contactId: 'c-t', contact: TENANT_RECORD },
    reads: ['c-t'],
  },
  {
    name: 'a THROWING primary read STOPS the walk: read_failed names it, the landlord is never read',
    unit: PM_PRIMARY,
    records: { 'c-ll': LL },
    throwing: ['c-pm'],
    expected: { kind: 'read_failed', candidateId: 'c-pm' },
    reads: ['c-pm'],
  },
  {
    name: 'a deleted primary and a THROWING landlord read: read_failed names the landlord',
    unit: PM_PRIMARY,
    records: { 'c-pm': PM_DELETED },
    throwing: ['c-ll'],
    expected: { kind: 'read_failed', candidateId: 'c-ll' },
    reads: ['c-pm', 'c-ll'],
  },
];

describe('the property-contact lookup (spec 4.1) - decide and resolve give ONE answer', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const syncReads: string[] = [];
      const decided = decidePropertyContact({
        unit: c.unit,
        tenantId: c.tenantId,
        lookup: (contactId) => {
          syncReads.push(contactId);
          if (c.throwing?.includes(contactId) === true) return { ok: false };
          return { ok: true, contact: c.records[contactId] };
        },
      });
      expect(decided).toEqual(c.expected);
      expect(syncReads).toEqual(c.reads);

      const asyncReads: string[] = [];
      const resolved = await resolvePropertyContact({
        unit: c.unit,
        tenantId: c.tenantId,
        contactsRepo: {
          getById: async (contactId: string) => {
            asyncReads.push(contactId);
            if (c.throwing?.includes(contactId) === true) {
              throw new Error('dynamodb: ProvisionedThroughputExceededException');
            }
            return c.records[contactId];
          },
        },
        logger: createLogger({ destination: createLogCapture().stream }),
      });
      expect(resolved).toEqual(c.expected);
      expect(asyncReads).toEqual(c.reads);
    });
  }
});

describe('resolvePropertyContact - a failed read is an ANSWER, never a throw', () => {
  it('logs the failed candidate with ids only and returns read_failed', async () => {
    const capture = createLogCapture();
    const result = await resolvePropertyContact({
      unit: PM_PRIMARY,
      tenantId: 'c-t',
      contactsRepo: {
        getById: async () => {
          throw new Error('dynamodb: ProvisionedThroughputExceededException');
        },
      },
      logger: createLogger({ destination: capture.stream }),
    });
    expect(result).toEqual({ kind: 'read_failed', candidateId: 'c-pm' });
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      msg: 'property contact: candidate read failed - lookup stops',
      candidateId: 'c-pm',
    });
  });
});
```

**(2) Run it RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContactLookup.test.ts
```

Expected RED: the exports do not exist yet, so every test fails - each with
`TypeError: ... decidePropertyContact is not a function` (the last one:
`resolvePropertyContact is not a function`), `Tests  18 failed (18)`; or, if
the module loader rejects the missing named export up front, the file fails
to load with `does not provide an export named 'decidePropertyContact'`.
Either is the expected RED.

**(3) Implement.** In `app/src/lib/propertyContact.ts`, use the Edit tool to
append the lookup after `rosterContactIds`.

old_string (the whole existing function, unique):

```ts
export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const ids: string[] = [];
  for (const id of [...unitContacts(unit).map((row) => row.contactId), unit.landlordId]) {
    const usable = nonEmptyId(id);
    if (usable !== undefined && !ids.includes(usable)) ids.push(usable);
  }
  return ids;
}
```

new_string:

```ts
export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const ids: string[] = [];
  for (const id of [...unitContacts(unit).map((row) => row.contactId), unit.landlordId]) {
    const usable = nonEmptyId(id);
    if (usable !== undefined && !ids.includes(usable)) ids.push(usable);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// P1 - the property-contact lookup (spec 4.1, plan C1)
// ---------------------------------------------------------------------------

/**
 * Who the app uses as a property's contact (spec 4.1), or why nobody:
 *   found       - the first live candidate;
 *   nobody      - `none` (no candidate at all), `deleted` (every candidate was
 *                 soft-deleted or has no record), `is_tenant` (a candidate IS
 *                 the given tenant - the walk STOPS there, no fall-through);
 *   read_failed - a candidate's read THREW. The walk stops: a failed read is
 *                 not absence, and falling through would name the wrong
 *                 person (the reminders fail closed on it, and the default
 *                 people list keeps a bare row for `candidateId`).
 */
export type PropertyContactResult =
  | { kind: 'found'; contactId: string; contact: ContactItem }
  | { kind: 'nobody'; reason: 'none' | 'deleted' | 'is_tenant' }
  | { kind: 'read_failed'; candidateId: string };

/** One candidate's read: `contact` undefined = no record; `{ ok: false }` = the read threw. */
type CandidateRead = { ok: true; contact: ContactItem | undefined } | { ok: false };

/**
 * The candidates, in order: the flagged primary row's contact (through
 * unitContacts, so a landlord-only unit's DERIVED row counts), then the
 * landlord of record when it is non-empty and a different id. A flagged row
 * with an empty contactId names nobody and is no candidate.
 */
function propertyContactCandidates(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const primary = nonEmptyId(unitContacts(unit).find((row) => row.primaryContact === true)?.contactId);
  const landlordId = nonEmptyId(unit.landlordId);
  const candidates: string[] = [];
  if (primary !== undefined) candidates.push(primary);
  if (landlordId !== undefined && landlordId !== primary) candidates.push(landlordId);
  return candidates;
}

/** The tenant test (spec 4.1): an id comparison made BEFORE any read. */
function isTheTenant(candidateId: string, tenantId: string | undefined): boolean {
  const tenant = nonEmptyId(tenantId);
  return tenant !== undefined && candidateId === tenant;
}

/**
 * The per-candidate rule (spec 4.1), shared by both walks below so the sync
 * and async lookups cannot drift. Returns the walk's answer, or 'skip' for a
 * candidate that is soft-deleted or has no record.
 */
function judgeCandidate(candidateId: string, read: CandidateRead): PropertyContactResult | 'skip' {
  if (!read.ok) return { kind: 'read_failed', candidateId };
  const contact = read.contact;
  if (!isLive(contact)) return 'skip';
  return { kind: 'found', contactId: candidateId, contact };
}

/** The walk ran out of candidates: `deleted` if any was skipped, else `none`. */
function exhausted(skippedAny: boolean): PropertyContactResult {
  return { kind: 'nobody', reason: skippedAny ? 'deleted' : 'none' };
}

/**
 * C1, PURE (spec 4.1): decide the property contact from reads the caller
 * already holds. `lookup` answers per id `{ ok: true, contact }` (`contact`
 * undefined = no record) or `{ ok: false }` (the read threw), and is asked
 * only about the candidates the walk actually reaches. Never throws unless
 * `lookup` itself throws.
 */
export function decidePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  lookup: (contactId: string) => { ok: true; contact: ContactItem | undefined } | { ok: false };
}): PropertyContactResult {
  let skippedAny = false;
  for (const candidateId of propertyContactCandidates(args.unit)) {
    if (isTheTenant(candidateId, args.tenantId)) return { kind: 'nobody', reason: 'is_tenant' };
    const verdict = judgeCandidate(candidateId, args.lookup(candidateId));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}

/** Read one candidate for the async walk: a throw is logged (ids only) and answered `{ ok: false }`. */
async function readCandidate(
  contactsRepo: Pick<ContactsRepo, 'getById'>,
  candidateId: string,
  log: Logger,
): Promise<CandidateRead> {
  try {
    return { ok: true, contact: await contactsRepo.getById(candidateId) };
  } catch (err) {
    log.warn({ err, candidateId }, 'property contact: candidate read failed - lookup stops');
    return { ok: false };
  }
}

/**
 * C1, async (spec 4.1): the same walk, reading each candidate LAZILY with
 * getById - the landlord of record is read only when the flagged primary was
 * skipped, so a healthy property costs the one read it always did. Never
 * throws.
 */
export async function resolvePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<PropertyContactResult> {
  const log = args.logger ?? defaultLogger;
  let skippedAny = false;
  for (const candidateId of propertyContactCandidates(args.unit)) {
    if (isTheTenant(candidateId, args.tenantId)) return { kind: 'nobody', reason: 'is_tenant' };
    const verdict = judgeCandidate(candidateId, await readCandidate(args.contactsRepo, candidateId, log));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}
```

**(4) Run it GREEN:**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContactLookup.test.ts test/propertyContact.test.ts
```

Expected: `Test Files  2 passed (2)`, `Tests  28 passed (28)`.

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/lib/propertyContact.ts` and the untracked
`app/test/propertyContactLookup.test.ts`. Anything else: stop and report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/propertyContact.ts app/test/propertyContactLookup.test.ts && git commit -m "feat(app): one property-contact lookup - decidePropertyContact and resolvePropertyContact skip a deleted or missing contact (spec 4.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.3 - the heir function (C4) and applyPrimary

Files:

- Modify `app/src/lib/propertyContact.ts`
- Create `app/test/propertyContactHeir.test.ts`

Steps:

**(1) Write the failing test.** Create `app/test/propertyContactHeir.test.ts`
with exactly this content:

```ts
// Unit tests for the heir function and applyPrimary (primary-contact-integrity
// spec 4.3 / 4.7, plan contract 2.1 / C4). PURE - no I/O, no DynamoDB. The
// real units repo AND the API-test fake both call these two functions (slice
// S2), so pinning them here pins both.
import { describe, expect, it } from 'vitest';
import { applyPrimary, chooseHeir, type RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact } from '../src/repos/unitsRepo.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
/** A COMPLETE liveness read holding exactly these records. */
const readOf = (...contacts: ContactItem[]): RosterContactsRead => ({
  ok: true,
  byId: new Map(contacts.map((c): [string, ContactItem] => [c.contactId, c])),
});
const deleted = (c: ContactItem): ContactItem => ({ ...c, deleted_at: DELETED_AT });

const LL = contact({ contactId: 'c-ll', type: 'landlord' });
const PM = contact({ contactId: 'c-pm', type: 'landlord' });
const OWNER = contact({ contactId: 'c-owner', type: 'landlord' });
const TENANT_TYPED = contact({ contactId: 'c-tenant-typed', type: 'tenant' });
const CASEWORKER = contact({ contactId: 'c-cw', type: 'partner', role: 'Caseworker' });
const POINTER = contact({ contactId: 'c-ptr', type: 'landlord', phone_ref: true });

describe('chooseHeir (spec 4.3)', () => {
  it('liveness UNKNOWN answers unknown - whatever the roster holds', () => {
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord', true), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        read: { ok: false },
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('1. the live landlord of record wins, ahead of an earlier eligible row', () => {
    expect(
      chooseHeir({ roster: [row('c-pm', 'pm'), row('c-ll', 'landlord')], landlordId: 'c-ll', read: readOf(PM, LL) }),
    ).toEqual({ kind: 'heir', contactId: 'c-ll', addLandlordRow: false });
  });

  it('1. the landlord of record is NOT type-tested (the owner by definition)', () => {
    const partnerLandlord = contact({ contactId: 'c-ll', type: 'partner' });
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord'), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        read: readOf(partnerLandlord, PM),
      }),
    ).toEqual({ kind: 'heir', contactId: 'c-ll', addLandlordRow: false });
  });

  it('1. an OFF-roster landlord of record is the heir, and the write must ADD its row', () => {
    expect(chooseHeir({ roster: [row('c-pm', 'pm')], landlordId: 'c-ll', read: readOf(PM, LL) })).toEqual({
      kind: 'heir',
      contactId: 'c-ll',
      addLandlordRow: true,
    });
  });

  it('2. a deleted, missing or EXCLUDED landlord falls to the earliest-added eligible row', () => {
    const roster = [row('c-ll', 'landlord', true), row('c-pm', 'pm'), row('c-owner', 'owner')];
    expect(chooseHeir({ roster, landlordId: 'c-ll', read: readOf(deleted(LL), PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
    expect(chooseHeir({ roster, landlordId: 'c-ll', read: readOf(PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
    // The read says the landlord is LIVE - the exclusion still wins (a delete
    // fan-out's eventually consistent read can return the contact it just
    // deleted).
    expect(chooseHeir({ roster, landlordId: 'c-ll', exclude: 'c-ll', read: readOf(LL, PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
  });

  it('2. never picks a tenant-typed, caseworker or routing-pointer row: the first ELIGIBLE row in add order', () => {
    const roster = [
      row('c-tenant-typed', 'other'),
      row('c-cw', 'other'),
      row('c-ptr', 'other'),
      row('c-owner', 'owner'),
      row('c-pm', 'pm'),
    ];
    expect(
      chooseHeir({ roster, landlordId: undefined, read: readOf(TENANT_TYPED, CASEWORKER, POINTER, OWNER, PM) }),
    ).toEqual({ kind: 'heir', contactId: 'c-owner', addLandlordRow: false });
  });

  it('2. skips a deleted row, a row with no record, and the excluded row', () => {
    const roster = [row('c-pm', 'pm', true), row('c-gone', 'pm'), row('c-owner', 'owner')];
    expect(chooseHeir({ roster, landlordId: undefined, read: readOf(deleted(PM), OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-owner',
      addLandlordRow: false,
    });
    expect(chooseHeir({ roster, landlordId: undefined, exclude: 'c-pm', read: readOf(PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-owner',
      addLandlordRow: false,
    });
  });

  it('the heir if a landlord PRIMARY were removed never names the landlord (excluded = not live)', () => {
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord', true), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        exclude: 'c-ll',
        read: readOf(LL, PM),
      }),
    ).toEqual({ kind: 'heir', contactId: 'c-pm', addLandlordRow: false });
    expect(
      chooseHeir({ roster: [row('c-ll', 'landlord', true)], landlordId: 'c-ll', exclude: 'c-ll', read: readOf(LL) }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
  });

  it('3. none - no_live_candidate when no live, non-excluded roster contact exists', () => {
    expect(chooseHeir({ roster: [], landlordId: undefined, read: readOf() })).toEqual({
      kind: 'none',
      why: 'no_live_candidate',
    });
    expect(
      chooseHeir({
        roster: [row('c-pm', 'pm', true), row('c-gone', 'other')],
        landlordId: '',
        read: readOf(deleted(PM)),
      }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
    expect(
      chooseHeir({ roster: [row('c-pm', 'pm', true)], landlordId: undefined, exclude: 'c-pm', read: readOf(PM) }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
  });

  it('3. none - no_eligible_candidate when live rows exist but none may be promoted automatically', () => {
    expect(
      chooseHeir({
        roster: [row('c-tenant-typed', 'other'), row('c-cw', 'other')],
        landlordId: undefined,
        read: readOf(TENANT_TYPED, CASEWORKER),
      }),
    ).toEqual({ kind: 'none', why: 'no_eligible_candidate' });
  });
});

describe('applyPrimary (spec 4.7 - the flag and the scalar move together)', () => {
  it('flags exactly the heir, demotes every other row, and returns the scalar', () => {
    expect(
      applyPrimary([row('c-ll', 'landlord', true), row('c-pm', 'pm')], { contactId: 'c-pm', addLandlordRow: false }),
    ).toEqual({
      contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)],
      primaryContactScalar: 'c-pm',
    });
  });

  it('APPENDS the off-roster landlord row as the primary when addLandlordRow', () => {
    expect(applyPrimary([row('c-pm', 'pm', true)], { contactId: 'c-ll', addLandlordRow: true })).toEqual({
      contacts: [row('c-pm', 'pm', false), { contactId: 'c-ll', role: 'landlord', primaryContact: true }],
      primaryContactScalar: 'c-ll',
    });
  });

  it('never duplicates a row that is already there, even when addLandlordRow', () => {
    expect(
      applyPrimary([row('c-ll', 'landlord'), row('c-pm', 'pm', true)], { contactId: 'c-ll', addLandlordRow: true })
        .contacts,
    ).toEqual([row('c-ll', 'landlord', true), row('c-pm', 'pm', false)]);
  });

  it('null clears EVERY flag and the scalar (null = REMOVE)', () => {
    expect(applyPrimary([row('c-ll', 'landlord'), row('c-pm', 'pm', true)], null)).toEqual({
      contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', false)],
      primaryContactScalar: null,
    });
  });

  it('keeps each row\'s denormalized name and company, and never mutates its input', () => {
    const input = Object.freeze([
      Object.freeze({
        contactId: 'c-ll',
        role: 'landlord' as const,
        primaryContact: true,
        name: 'Lee Park',
        company: 'Park Homes',
      }),
      Object.freeze(row('c-pm', 'pm')),
    ]);
    const result = applyPrimary(input, { contactId: 'c-pm', addLandlordRow: false });
    expect(result.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false, name: 'Lee Park', company: 'Park Homes' },
      row('c-pm', 'pm', true),
    ]);
    expect(input[0]?.primaryContact).toBe(true);
    expect(result.contacts).not.toBe(input);
  });

  it('THROWS for an heir with no row and addLandlordRow false (a scalar no row agrees with)', () => {
    expect(() => applyPrimary([row('c-pm', 'pm', true)], { contactId: 'c-x', addLandlordRow: false })).toThrow(
      'applyPrimary: heir c-x has no roster row and addLandlordRow is false',
    );
  });

  it('composes with chooseHeir: no landlord of record and ONE live typed-landlord contact -> it becomes primary', () => {
    const roster = [row('c-sole', 'pm')];
    const sole = contact({ contactId: 'c-sole', type: 'landlord' });
    const heir = chooseHeir({ roster, landlordId: undefined, read: readOf(sole) });
    expect(heir).toEqual({ kind: 'heir', contactId: 'c-sole', addLandlordRow: false });
    if (heir.kind !== 'heir') throw new Error('unreachable: asserted above');
    expect(applyPrimary(roster, heir)).toEqual({
      contacts: [row('c-sole', 'pm', true)],
      primaryContactScalar: 'c-sole',
    });
  });
});
```

**(2) Run it RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContactHeir.test.ts
```

Expected RED: the exports do not exist yet, so every test fails with
`TypeError: ... chooseHeir is not a function` / `applyPrimary is not a
function` (`Tests  17 failed (17)`), or the file fails to load with
`does not provide an export named 'applyPrimary'`. Either is the expected
RED.

**(3) Implement.** Two Edit-tool edits in `app/src/lib/propertyContact.ts`.

Edit A - the import. old_string:

```ts
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
```

new_string:

```ts
import { unitContacts, type UnitContact, type UnitItem } from '../repos/unitsRepo.js';
```

Edit B - append after `resolvePropertyContact`. old_string (the unique tail
of `resolvePropertyContact`; `await readCandidate(` appears only there):

```ts
    const verdict = judgeCandidate(candidateId, await readCandidate(args.contactsRepo, candidateId, log));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}
```

new_string:

```ts
    const verdict = judgeCandidate(candidateId, await readCandidate(args.contactsRepo, candidateId, log));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}

// ---------------------------------------------------------------------------
// The heir function (spec 4.3, plan C4)
// ---------------------------------------------------------------------------

/**
 * Who takes over as primary (spec 4.3):
 *   heir    - `contactId` becomes primary; `addLandlordRow` says the heir is
 *             the landlord of record with NO roster row, which the write must
 *             add (`role: 'landlord'`);
 *   none    - `no_live_candidate` (no live, non-excluded roster contact at
 *             all) or `no_eligible_candidate` (live ones exist, none eligible
 *             for automatic routing). The backfill script's noHeir /
 *             noEligible counts read this - nothing re-derives the rule;
 *   unknown - the liveness read failed (the caller's path rule applies).
 */
export type HeirResult =
  | { kind: 'heir'; contactId: string; addLandlordRow: boolean }
  | { kind: 'none'; why: 'no_live_candidate' | 'no_eligible_candidate' }
  | { kind: 'unknown' };

/**
 * The heir function, PURE (spec 4.3) - used by the real units repo AND the
 * API-test fake, so the two cannot drift:
 *
 *   1. the landlord of record, if live and not excluded - NO type test (the
 *      owner by definition, and P1's own fallback);
 *   2. else the EARLIEST-ADDED roster contact (array order = add order) that
 *      is eligible for automatic routing (isAutoRoutingEligible: typed
 *      landlord, live, not a routing pointer) and not excluded - a tenant or a
 *      caseworker added by accident is never promoted automatically;
 *   3. else none, with why.
 *
 * `roster` is unitContacts(unit). `read` is readRosterContacts over
 * rosterContactIds(unit) of the SAME unit snapshot; `{ ok: false }` answers
 * unknown. The `exclude`d contact counts as NOT live at every step, whatever
 * `read` says: the delete fan-out never picks the contact it just deleted
 * (whose eventually consistent read can still say live), and the heir "if the
 * primary were removed" never names that primary.
 */
export function chooseHeir(args: {
  roster: readonly UnitContact[];
  landlordId: string | undefined;
  exclude?: string;
  read: RosterContactsRead;
}): HeirResult {
  const read = args.read;
  if (!read.ok) return { kind: 'unknown' };
  const exclude = nonEmptyId(args.exclude);
  /** The live, non-excluded record for an id - else undefined. */
  const usable = (contactId: string): ContactItem | undefined => {
    if (contactId === exclude) return undefined;
    const contact = read.byId.get(contactId);
    return isLive(contact) ? contact : undefined;
  };

  const landlordId = nonEmptyId(args.landlordId);
  if (landlordId !== undefined && usable(landlordId) !== undefined) {
    return {
      kind: 'heir',
      contactId: landlordId,
      addLandlordRow: !args.roster.some((row) => row.contactId === landlordId),
    };
  }

  let anyLive = false;
  for (const row of args.roster) {
    const contactId = nonEmptyId(row.contactId);
    if (contactId === undefined) continue;
    const contact = usable(contactId);
    if (contact === undefined) continue;
    anyLive = true;
    if (isAutoRoutingEligible(contact)) return { kind: 'heir', contactId, addLandlordRow: false };
  }
  return { kind: 'none', why: anyLive ? 'no_eligible_candidate' : 'no_live_candidate' };
}

/**
 * Apply an heir to a COPY of the roster (PURE; the input is never mutated):
 * flag exactly the heir and demote every other row - APPENDING the landlord's
 * row (`role: 'landlord'`, primary) when `addLandlordRow` and the roster has
 * none - or, for `null`, clear every flag. Returns the new roster and the
 * `primary_contact` scalar the same write must store: the heir's id, or null =
 * REMOVE the attribute (spec 4.7: every write that sets or moves the primary
 * sets the scalar to it or removes it). The appended row carries no
 * name/company - read-time enrichment names it.
 *
 * An heir with no roster row and `addLandlordRow: false` cannot be flagged -
 * chooseHeir never produces one - and THROWS rather than return a scalar no
 * row agrees with.
 */
export function applyPrimary(
  roster: readonly UnitContact[],
  heir: { contactId: string; addLandlordRow: boolean } | null,
): { contacts: UnitContact[]; primaryContactScalar: string | null } {
  if (heir === null) {
    return {
      contacts: roster.map((row) => ({ ...row, primaryContact: false })),
      primaryContactScalar: null,
    };
  }
  const contacts = roster.map((row) => ({ ...row, primaryContact: row.contactId === heir.contactId }));
  if (!contacts.some((row) => row.contactId === heir.contactId)) {
    if (!heir.addLandlordRow) {
      throw new Error(`applyPrimary: heir ${heir.contactId} has no roster row and addLandlordRow is false`);
    }
    contacts.push({ contactId: heir.contactId, role: 'landlord', primaryContact: true });
  }
  return { contacts, primaryContactScalar: heir.contactId };
}
```

**(4) Run it GREEN:**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContactHeir.test.ts test/propertyContactLookup.test.ts test/propertyContact.test.ts
```

Expected: `Test Files  3 passed (3)`, `Tests  45 passed (45)`.

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/lib/propertyContact.ts` and the untracked
`app/test/propertyContactHeir.test.ts`. Anything else: stop and report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/propertyContact.ts app/test/propertyContactHeir.test.ts && git commit -m "feat(app): the heir function and applyPrimary - one rule for every automatic primary choice (spec 4.3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.4 - routes/units.ts uses the shared eligibility rule

Files:

- Modify `app/src/routes/units.ts` (ONLY the two import statements and the
  `autoRoutingEligible` definition - no other region)
- Create `app/test/autoRoutingEligibleSingleSource.test.ts`

Steps:

**(1) Write the failing test.** Create
`app/test/autoRoutingEligibleSingleSource.test.ts` with exactly this content:

```ts
// The ONE automatic-routing eligibility rule (primary-contact-integrity spec
// 4.3). `main` shipped it as routes/units.ts `autoRoutingEligible`; the heir
// function needs the very same rule, so it moved to lib/propertyContact.ts
// (`isAutoRoutingEligible`). A second DEFINITION anywhere in app/src is how
// auto-primary and the handoffs would start disagreeing about who may be
// promoted.
//
// TEXTUAL, like tourCopyCallSites.test.ts: it catches a function or const
// definition under either name, not a re-implementation under a new name. A
// green run is evidence, not proof.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// path.dirname(fileURLToPath(...)), never new URL(...).pathname (a leading
// slash on win32) - the idiom every tree-walking test here uses.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOME = join('lib', 'propertyContact.ts');
const DEFINITION =
  /\bfunction\s+(?:isAutoRoutingEligible|autoRoutingEligible)\s*\(|\b(?:const|let)\s+(?:isAutoRoutingEligible|autoRoutingEligible)\s*=/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('the automatic-routing eligibility rule has ONE definition (spec 4.3)', () => {
  it('no module outside lib/propertyContact.ts defines it', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(HOME)) continue;
      if (DEFINITION.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC, file));
    }
    expect(offenders, `import isAutoRoutingEligible from lib/propertyContact.ts instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('lib/propertyContact.ts does define it (the pin is not vacuous)', () => {
    expect(readFileSync(join(SRC, HOME), 'utf8')).toMatch(/export function isAutoRoutingEligible\(/);
  });
});
```

**(2) Run it RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/autoRoutingEligibleSingleSource.test.ts
```

Expected RED: `1 failed | 1 passed`; the failure is
`AssertionError: ... expected [ 'routes\\units.ts' ] to deeply equal []`
(on Linux the path reads `routes/units.ts`).

**(3) Implement.** Three Edit-tool edits in `app/src/routes/units.ts`.

Edit A - drop the import only the moved function used. old_string:

```ts
import {
  createContactsRepo,
  isDeleted as isContactDeleted,
  type ContactItem,
  type ContactsRepo,
  type RecipientDisplay,
} from '../repos/contactsRepo.js';
```

new_string:

```ts
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
  type RecipientDisplay,
} from '../repos/contactsRepo.js';
```

Edit B - import the shared rule under the old local name. old_string:

```ts
import { isCaseworker } from '../lib/caseworkers.js';

export interface UnitsRouterDeps {
```

new_string:

```ts
import { isCaseworker } from '../lib/caseworkers.js';
// The ONE automatic-routing eligibility rule lives in lib/propertyContact.ts
// (primary-contact-integrity spec 4.3), shared with the heir function. It is
// imported under its old local name so every call site below reads as before.
import { isAutoRoutingEligible as autoRoutingEligible } from '../lib/propertyContact.js';

export interface UnitsRouterDeps {
```

Edit C - delete the local definition. old_string:

```ts
/**
 * The ONE eligibility rule for an AUTOMATIC routing choice (caseworker-
 * integrity spec revision 6 section 4 "Contact list (I4)" and "Restore"; final
 * review A4, fix wave FWF-3): auto-primary on a contact-list add (passed to
 * unitsRepo.addContact as `autoPrimaryEligible`) and the restore's
 * sole-landlord promotion (soleLandlordToPromote). The contact exists, is
 * typed `landlord`, is NOT soft-deleted (the contacts repo's own test -
 * deleting a contact keeps its seats, and a deleted contact is unusable for
 * routing everywhere else) and is NOT a phone or email routing pointer (a
 * routing record, never a contact). A deliberate choice - the I3 claim of a
 * vacant landlord slot, a landlord picked for a restore - asks only the type.
 */
function autoRoutingEligible(contact: ContactItem | undefined): boolean {
  return (
    contact !== undefined &&
    contact.phone_ref !== true &&
    contact.email_ref !== true &&
    !isContactDeleted(contact) &&
    contact.type === 'landlord'
  );
}

/**
 * BE3/C3: the denormalized display name for a roster row, from the contact's
```

new_string:

```ts
/**
 * BE3/C3: the denormalized display name for a roster row, from the contact's
```

Do NOT touch any other line of `units.ts` (S2 and S3 edit its other regions,
anchored on today's text). `ContactItem` stays imported - `enrichRoster` and
the restore route still use it.

**(4) Run it GREEN** - the pin, plus the route suites that exercise the rule
(auto-primary on add, the restore's sole-landlord promotion, the contact-list
type checks). All in-memory FakeWorld, no DynamoDB:

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/autoRoutingEligibleSingleSource.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsRestoreLandlord.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiRoster.test.ts
```

Expected: `Test Files  5 passed (5)`, 0 failed.

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/routes/units.ts` and the untracked
`app/test/autoRoutingEligibleSingleSource.test.ts`. Anything else: stop and
report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/autoRoutingEligibleSingleSource.test.ts && git commit -m "refactor(app): units routes use the shared automatic-routing eligibility rule from lib/propertyContact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.5 - tour and relay copy read the property contact through C1

`lib/tourContacts.ts` `resolveTourContactNames` keeps its never-throw
contract and both failure flags exactly; it gains the
`propertyContact?: PropertyContactResult` field (CONTRACT ISSUE 1). The relay
intro inherits the change through it (no edit to `jobs/relayFanOut.ts`).

Files:

- Modify `app/src/lib/tourContacts.ts`
- Modify `app/test/tourContacts.test.ts`
- Create `app/test/relayIntroPropertyContact.test.ts`

Steps:

**(1) Write the failing tests.**

1a. `app/test/tourContacts.test.ts` - five Edit-tool edits.

Edit A (import). old_string:

```ts
import { resolveTourContactNames } from '../src/lib/tourContacts.js';
```

new_string:

```ts
import { resolveTourContactNames } from '../src/lib/tourContacts.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
```

Edit B (constants). old_string:

```ts
const TENANT = contact({ contactId: 'c-t', firstName: 'Alice', lastName: 'Rivera' });
```

new_string:

```ts
const TENANT = contact({ contactId: 'c-t', firstName: 'Alice', lastName: 'Rivera' });
const DANA = contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz' });
const LEE = contact({ contactId: 'c-ll', firstName: 'Lee', lastName: 'Park' });
const DELETED_AT = '2026-10-01T00:00:00.000Z';
/** 2026-09-08 15:00 New York - any parseable instant composes the en-route rung. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
```

Edit C (existing test 'resolves the roster PRIMARY and the tenant, first and
full names' - use the shared constant). old_string:

```ts
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz' }) }, calls),
```

new_string:

```ts
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-pm': DANA }, calls),
```

Edit D (the SAME existing test's whole-result assertion now includes the new
field). old_string:

```ts
      tenantReadFailed: false,
      propertyReadFailed: false,
    });
    // LIVE read, not the roster's denormalized name.
```

new_string:

```ts
      tenantReadFailed: false,
      propertyReadFailed: false,
      propertyContact: { kind: 'found', contactId: 'c-pm', contact: DANA },
    });
    // LIVE read, not the roster's denormalized name.
```

Edit E (new tests, appended inside the describe). old_string:

```ts
  it('a supplied tenantContact skips the tenant read', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      tenantContact: TENANT,
      contactsRepo: repoOf({}, calls),
    });
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(calls).toEqual([]);
  });
});
```

new_string:

```ts
  it('a supplied tenantContact skips the tenant read', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      tenantContact: TENANT,
      contactsRepo: repoOf({}, calls),
    });
    expect(r.names.tenantFirstName).toBe('Alice');
    expect(calls).toEqual([]);
  });

  // primary-contact-integrity spec 4.1: the property contact comes from the ONE
  // shared lookup (lib/propertyContact.ts), which SKIPS a soft-deleted or
  // missing contact. Before it, a deleted primary was named in every reminder.
  it('a DELETED primary is skipped: the names and the en-route body come from the landlord of record', async () => {
    const calls: string[] = [];
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true },
        ],
      }),
      contactsRepo: repoOf(
        {
          'c-t': TENANT,
          'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', lastName: 'Ortiz', deleted_at: DELETED_AT }),
          'c-ll': LEE,
        },
        calls,
      ),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.names.propertyContactName).toBe('Lee Park');
    expect(r.propertyReadFailed).toBe(false);
    expect(r.propertyContact).toEqual({ kind: 'found', contactId: 'c-ll', contact: LEE });
    // Lazy: the landlord of record is read only because the primary was skipped.
    expect(calls).toEqual(['c-t', 'c-pm', 'c-ll']);
    const body = composeTourReminderBody({
      kind: 'en_route',
      scheduledAt: TOUR_AT,
      timezone: 'America/New_York',
      tourType: 'landlord_led',
      names: r.names,
    });
    expect(body).toBe(
      "Hey Alice, Lee will be headed that way shortly. Can you please text here when you're on the way?",
    );
  });

  it('a deleted SOLE primary with no landlord of record is NO property contact (reason deleted)', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
      }),
      contactsRepo: repoOf(
        { 'c-t': TENANT, 'c-pm': contact({ contactId: 'c-pm', firstName: 'Dana', deleted_at: DELETED_AT }) },
        [],
      ),
    });
    expect(r.names.propertyContactFirstName).toBeUndefined();
    expect(r.names.propertyContactName).toBeUndefined();
    expect(r.propertyReadFailed).toBe(false);
    expect(r.propertyContact).toEqual({ kind: 'nobody', reason: 'deleted' });
    // No name can back "will be headed that way": the rung degrades to the
    // self-guided entry (spec 6.3) and never names the deleted contact.
    expect(
      composeTourReminderBody({
        kind: 'en_route',
        scheduledAt: TOUR_AT,
        timezone: 'America/New_York',
        tourType: 'landlord_led',
        names: r.names,
      }),
    ).toBe("Hey Alice, can you please text me when you're on the way?");
  });

  it('a primary with NO record (an import retract hard-deletes) falls through to the landlord like a deleted one', async () => {
    const r = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({
        unitId: 'u1',
        landlordId: 'c-ll',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-gone', role: 'pm', primaryContact: true },
        ],
      }),
      contactsRepo: repoOf({ 'c-t': TENANT, 'c-ll': LEE }, []),
    });
    expect(r.names.propertyContactFirstName).toBe('Lee');
    expect(r.propertyContact).toEqual({ kind: 'found', contactId: 'c-ll', contact: LEE });
  });

  it('exposes the shared lookup answer for every outcome - and none at all without a unit', async () => {
    const none = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: '', contacts: [] }),
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect(none.propertyContact).toEqual({ kind: 'nobody', reason: 'none' });

    const self = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-t' }),
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect(self.propertyContact).toEqual({ kind: 'nobody', reason: 'is_tenant' });

    const failed = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: unit({ unitId: 'u1', landlordId: 'c-boom' }),
      contactsRepo: {
        async getById(id: string) {
          if (id === 'c-boom') throw new Error('repo down');
          return TENANT;
        },
      },
    });
    expect(failed.propertyContact).toEqual({ kind: 'read_failed', candidateId: 'c-boom' });
    expect(failed.propertyReadFailed).toBe(true);

    const noUnit = await resolveTourContactNames({
      tenantId: 'c-t',
      unit: undefined,
      contactsRepo: repoOf({ 'c-t': TENANT }, []),
    });
    expect('propertyContact' in noUnit).toBe(false);
  });
});
```

1b. Create `app/test/relayIntroPropertyContact.test.ts` with exactly this
content:

```ts
// The relay INTRO names the property contact through resolveTourContactNames,
// so it inherits the shared lookup (primary-contact-integrity spec 4.1): a
// soft-deleted or missing primary is never named in the intro - the walk
// resolves past it to the landlord of record, or to nobody (the general
// intro). Preview and send share resolveRelayComposeInputs, so this pins both.
// PURE - in-memory repos, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  composeIntroBody,
  resolveRelayComposeInputs,
  type RelayComposeDeps,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
/** 2026-09-08 15:00 New York; "now" is the day before, so the DATED tour variant. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
const DAY_BEFORE_NOW = '2026-09-07T13:00:00.000Z';

const CONTACTS: Record<string, ContactItem> = {
  'c-tenant': { contactId: 'c-tenant', type: 'tenant', firstName: 'Alicia', lastName: 'Reyes' },
  'c-landlord': { contactId: 'c-landlord', type: 'landlord', firstName: 'Marcus', lastName: 'Webb' },
  'c-pm-deleted': {
    contactId: 'c-pm-deleted',
    type: 'landlord',
    firstName: 'Dana',
    lastName: 'Ortiz',
    deleted_at: DELETED_AT,
  },
};

function unitWith(over: Record<string, unknown>): UnitItem {
  return {
    unitId: 'unit-1',
    status: 'available',
    address: { line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  } as unknown as UnitItem;
}

function depsFor(unit: UnitItem): RelayComposeDeps {
  return {
    toursRepo: {
      get: async () =>
        ({ tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1', scheduledAt: TOUR_AT }) as never,
    },
    placementsRepo: {
      getById: async () => ({ placementId: 'plc-1', tenantId: 'c-tenant', unitId: 'unit-1' }) as never,
    },
    unitsRepo: { getById: async () => unit },
    contactsRepo: { getById: async (id: string) => CONTACTS[id] },
    settingsRepo: { getOrgSettings: async () => ({ timezone: 'America/New_York' }) as never },
    nowIso: DAY_BEFORE_NOW,
    logger: createLogger({ destination: createLogCapture().stream }),
  };
}

/** A deleted PM flagged primary next to a live landlord of record. */
const DELETED_PM_PRIMARY = unitWith({
  landlordId: 'c-landlord',
  contacts: [
    { contactId: 'c-landlord', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm-deleted', role: 'pm', primaryContact: true },
  ],
});

describe('the relay intro skips a deleted property contact (spec 4.1)', () => {
  it('a DELETED primary: the tour intro names the landlord of record, never the deleted contact', async () => {
    const inputs = await resolveRelayComposeInputs({ type: 'tour', id: 'tour-1' }, depsFor(DELETED_PM_PRIMARY));
    expect(inputs.variant).toBe('tour');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
    const body = composeIntroBody(inputs, ['Alicia Reyes', 'Marcus Webb']);
    expect(body).toContain('Marcus');
    expect(body).not.toContain('Dana');
  });

  it('a DELETED primary: the placement intro does the same', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'placement', id: 'plc-1' },
      depsFor(DELETED_PM_PRIMARY),
    );
    expect(inputs.variant).toBe('placement');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
  });

  it('a deleted SOLE primary with no landlord of record: the general intro, never naming it', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      depsFor(unitWith({ contacts: [{ contactId: 'c-pm-deleted', role: 'pm', primaryContact: true }] })),
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.propertyContactFirstName).toBeUndefined();
    expect(composeIntroBody(inputs, ['Alicia Reyes'])).not.toContain('Dana');
  });

  it('a primary with NO record falls through to the landlord of record', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      depsFor(
        unitWith({
          landlordId: 'c-landlord',
          contacts: [
            { contactId: 'c-landlord', role: 'landlord', primaryContact: false },
            { contactId: 'c-gone', role: 'pm', primaryContact: true },
          ],
        }),
      ),
    );
    expect(inputs.variant).toBe('tour');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
  });
});
```

**(2) Run them RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/tourContacts.test.ts test/relayIntroPropertyContact.test.ts
```

Expected RED: `Test Files  2 failed (2)`. In `tourContacts.test.ts`, 5
failed (the edited 'resolves the roster PRIMARY ...' test - the result has no
`propertyContact` - and the four new tests; e.g.
`expected 'Dana' to be 'Lee'`), the other 10 pass. In
`relayIntroPropertyContact.test.ts`, all 4 fail (e.g.
`expected 'Dana' to be 'Marcus'`, `expected 'tour' to be 'naked'`,
`expected 'naked' to be 'tour'`).

**(3) Implement.** Five Edit-tool edits in `app/src/lib/tourContacts.ts`.

Edit A (imports). old_string:

```ts
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';
```

new_string:

```ts
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { resolvePropertyContact, type PropertyContactResult } from './propertyContact.js';
```

Edit B (the result type). old_string:

```ts
  /** true only when the PROPERTY-CONTACT read threw. */
  propertyReadFailed: boolean;
}
```

new_string:

```ts
  /** true only when the PROPERTY-CONTACT read threw (the shared lookup's
   *  `read_failed`). A soft-deleted or missing candidate is NOT a failure:
   *  the lookup skips it (primary-contact-integrity spec 4.1). */
  propertyReadFailed: boolean;
  /**
   * The shared lookup's own answer (lib/propertyContact.ts
   * resolvePropertyContact) - WHO the property contact is, or why nobody
   * (none / deleted / is_tenant / read_failed). PRESENT exactly when a unit was
   * passed (a lookup ran); ABSENT when `unit` is undefined. The names above
   * already reflect it; the relay intro reads it to explain a fallback to the
   * general intro (spec 5.1).
   */
  propertyContact?: PropertyContactResult;
}
```

Edit C (the function docblock). old_string:

```ts
 * Resolve the two names tour-reminder copy interpolates: the TENANT, and the
 * unit's PRIMARY CONTACT falling back to the landlord of record - the
 * established rule (lib/rosterResolution.ts:273-275). Reads the LIVE contact
 * for names; roster rows carry a denormalized name that goes stale.
```

new_string:

```ts
 * Resolve the two names tour-reminder copy interpolates: the TENANT, and the
 * PROPERTY CONTACT - the ONE shared lookup (lib/propertyContact.ts
 * resolvePropertyContact, primary-contact-integrity spec 4.1): the roster row
 * flagged primary, else the landlord of record, skipping a soft-deleted or
 * missing contact. Reads the LIVE contact for names; roster rows carry a
 * denormalized name that goes stale.
```

Edit D (the property-contact block). old_string:

```ts
  // Primary-contact rule, with the inline empty-string guard replacing
  // rosterResolution's module-private nonEmpty() (spec 6.1): a legacy
  // landlordId of '' must read as "no property contact", never as an id.
  let propertyContact: ContactItem | undefined;
  if (args.unit !== undefined) {
    const primary = unitContacts(args.unit).find((c) => c.primaryContact === true);
    const landlordId =
      typeof args.unit.landlordId === 'string' && args.unit.landlordId.length > 0
        ? args.unit.landlordId
        : undefined;
    const propertyContactId = primary?.contactId ?? landlordId;
    // DE-DUPE the degenerate case where the tenant IS the property contact -
    // the guard rosterResolution.ts:279-281 carries one line below the rule
    // spec 6.1 told us to reuse, and which an earlier revision of this module
    // copied the rule without. Without it a unit whose landlordId is the tour's
    // own tenant composes "Hey Alice, Alice will be headed that way shortly."
    // and sends it to Alice. Treating it as NO property contact is the right
    // outcome rather than a special case: idFor() then degrades the rung to the
    // self-guided entry, which is exactly spec 6.3's absence fallback.
    const usablePropertyContactId =
      propertyContactId === args.tenantId ? undefined : propertyContactId;
    if (typeof usablePropertyContactId === 'string' && usablePropertyContactId.length > 0) {
      try {
        propertyContact = await args.contactsRepo.getById(usablePropertyContactId);
      } catch (err) {
        propertyReadFailed = true;
        log.warn(
          { err, unitId: args.unit.unitId, propertyContactId: usablePropertyContactId },
          'tour names: property contact read failed',
        );
      }
    }
  }
```

new_string:

```ts
  // The property contact through the ONE shared lookup (lib/propertyContact.ts,
  // primary-contact-integrity spec 4.1): the flagged primary row, else the
  // landlord of record. A soft-deleted or missing candidate is SKIPPED; an
  // empty landlordId is no candidate. A candidate who IS the tenant is NO
  // property contact - without that, a unit whose landlordId is the tour's own
  // tenant composes "Hey Alice, Alice will be headed that way shortly." and
  // sends it to Alice; absence instead lets idFor() degrade the rung to the
  // self-guided entry (spec 6.3). A read that THROWS is a failure, never
  // absence: propertyReadFailed (the lookup already logged the error).
  let propertyContactResult: PropertyContactResult | undefined;
  if (args.unit !== undefined) {
    propertyContactResult = await resolvePropertyContact({
      unit: args.unit,
      tenantId: args.tenantId,
      contactsRepo: args.contactsRepo,
      logger: log,
    });
    if (propertyContactResult.kind === 'read_failed') {
      propertyReadFailed = true;
      log.warn(
        { unitId: args.unit.unitId, propertyContactId: propertyContactResult.candidateId },
        'tour names: property contact read failed',
      );
    }
  }
  const propertyContact =
    propertyContactResult?.kind === 'found' ? propertyContactResult.contact : undefined;
```

Edit E (the return). old_string:

```ts
    tenantReadFailed,
    propertyReadFailed,
  };
}
```

new_string:

```ts
    tenantReadFailed,
    propertyReadFailed,
    ...(propertyContactResult !== undefined && { propertyContact: propertyContactResult }),
  };
}
```

`ContactItem` stays imported (the tenant read and the name helpers use it).

**(4) Run GREEN** - the two files, plus every suite that composes copy
through `resolveTourContactNames` / `resolveRelayComposeInputs` (in-memory, no
DynamoDB):

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/tourContacts.test.ts test/relayIntroPropertyContact.test.ts test/tourCopy.test.ts test/relayFanOut.test.ts test/tourRemindersApi.test.ts test/contactTimeline.test.ts test/rosterEdits.test.ts
```

Expected: `Test Files  7 passed (7)`, 0 failed. (`tourContacts.test.ts`:
15 passed; `relayIntroPropertyContact.test.ts`: 4 passed.)

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/lib/tourContacts.ts`,
`modified: app/test/tourContacts.test.ts` and the untracked
`app/test/relayIntroPropertyContact.test.ts`. Anything else: stop and report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/tourContacts.ts app/test/tourContacts.test.ts app/test/relayIntroPropertyContact.test.ts && git commit -m "fix(app): tour reminder and relay intro copy skip a deleted property contact via the shared lookup (spec 4.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.6 - the default people list reads the property contact through C1

`lib/rosterResolution.ts` `resolveRoster` DEFAULT branch: a found contact is
added; a read that THROWS keeps today's bare `{ contactId }` row for that
candidate (spec 4.1 - a materialized plan never silently loses the property
contact); nobody adds nothing. The false `memberFromContact` docblock is
corrected.

Files:

- Modify `app/src/lib/rosterResolution.ts`
- Modify `app/test/rosterResolution.test.ts`
- Create `app/test/rosterPlanMaterializePropertyContact.test.ts`

Steps:

**(1) Write the failing tests.**

1a. `app/test/rosterResolution.test.ts` - one Edit-tool edit inserting a new
describe block BEFORE the describeRoster section. old_string:

```ts
// ---------------------------------------------------------------------------
// describeRoster - the DISPLAY name chain
// ---------------------------------------------------------------------------
```

new_string:

```ts
// ---------------------------------------------------------------------------
// DEFAULT through the shared property-contact lookup (primary-contact-integrity
// spec 4.1): a soft-deleted or missing candidate is SKIPPED; a read that THROWS
// keeps the bare row and never falls through to the next candidate.
// ---------------------------------------------------------------------------

describe('resolveRoster - the property default skips a deleted property contact (spec 4.1)', () => {
  const DELETED_AT = '2026-10-01T00:00:00.000Z';
  const pmPrimary: UnitItem = {
    unitId: 'unit-1',
    landlordId: 'c-owner',
    status: 'available',
    contacts: [
      { contactId: 'c-owner', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ],
    primary_contact: 'c-pm',
  };

  it('a DELETED primary is not on the list - the live landlord of record takes its slot', async () => {
    const deps = makeDeps({
      units: { 'unit-1': pmPrimary },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-pm': { ...contact('c-pm', '+15550100002', 'Pat'), deleted_at: DELETED_AT },
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved).toEqual({
      source: 'default',
      members: [
        { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' },
        { contactId: 'c-owner', phone: '+15550100004', name: 'Olive Person' },
      ],
    });
  });

  it('a deleted SOLE primary with no landlord of record leaves the tenant alone - never the deleted phone', async () => {
    const deps = makeDeps({
      units: {
        'unit-1': {
          unitId: 'unit-1',
          status: 'available',
          contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
        } as unknown as UnitItem,
      },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-pm': { ...contact('c-pm', '+15550100002', 'Pat'), deleted_at: DELETED_AT },
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant']);
  });

  it('a primary with NO record is skipped like a deleted one (the importer hard-deletes)', async () => {
    const deps = makeDeps({
      units: { 'unit-1': pmPrimary },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-owner': contact('c-owner', '+15550100004', 'Olive'),
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members.map((m) => m.contactId)).toEqual(['c-tenant', 'c-owner']);
  });

  it('a deleted primary, then the landlord IS the tenant: the tenant alone, one slot', async () => {
    const deps = makeDeps({
      units: {
        'unit-1': {
          unitId: 'unit-1',
          landlordId: 'c-tenant',
          status: 'available',
          contacts: [
            { contactId: 'c-tenant', role: 'landlord', primaryContact: false },
            { contactId: 'c-pm', role: 'pm', primaryContact: true },
          ],
        },
      },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-pm': { ...contact('c-pm', '+15550100002', 'Pat'), deleted_at: DELETED_AT },
      },
    });

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved.members).toEqual([{ contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' }]);
  });

  it('(PIN) a THROWING property-contact read keeps the BARE row for that candidate and never falls through', async () => {
    const live: Record<string, ContactItem> = {
      'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
      'c-owner': contact('c-owner', '+15550100004', 'Olive'),
    };
    const deps = makeDeps({ units: { 'unit-1': pmPrimary }, contacts: live });
    deps.contacts = {
      getById: vi.fn(async (contactId: string) => {
        deps.contactReads.push(contactId);
        if (contactId === 'c-pm') throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return live[contactId];
      }),
    };

    const resolved = await resolveRoster(deps, TOUR);

    expect(resolved).toEqual({
      source: 'default',
      members: [
        { contactId: 'c-tenant', phone: '+15550100001', name: 'Tina Person' },
        { contactId: 'c-pm' },
      ],
    });
    // The landlord of record was never read: a failed read is not absence.
    expect(deps.contactReads).toEqual(['c-tenant', 'c-pm']);
  });
});

// ---------------------------------------------------------------------------
// describeRoster - the DISPLAY name chain
// ---------------------------------------------------------------------------
```

1b. Create `app/test/rosterPlanMaterializePropertyContact.test.ts` with
exactly this content:

```ts
// A plan MATERIALIZED from the property default (services/rosterEdits.ts
// applyRosterPlanEdit - the first People-card edit) inherits the shared
// property-contact lookup (primary-contact-integrity spec 4.1): a deleted
// primary is never written into the plan, and a property-contact read that
// THROWS keeps its bare entry, so the plan never silently loses the property
// contact. PURE - in-memory repos and an in-memory plan store, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  applyRosterPlanEdit,
  type RosterPlanEditRequest,
  type RosterPlanState,
  type RosterPlanStore,
} from '../src/services/rosterEdits.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterEntry, RosterResolutionDeps } from '../src/lib/rosterResolution.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const UNIT: UnitItem = {
  unitId: 'unit-1',
  landlordId: 'c-owner',
  status: 'available',
  contacts: [
    { contactId: 'c-owner', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
  primary_contact: 'c-pm',
};

function person(contactId: string, phone: string, firstName: string, over: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', phone, firstName, ...over };
}

function depsFor(records: Record<string, ContactItem>, throwing: string[] = []): RosterResolutionDeps {
  return {
    conversations: { getById: async () => undefined },
    units: { getById: async () => UNIT },
    contacts: {
      getById: async (contactId: string) => {
        if (throwing.includes(contactId)) throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return records[contactId];
      },
    },
    log: createLogger({ destination: createLogCapture().stream }),
  };
}

/** An in-memory plan store recording every setRoster write, in order. */
function memoryStore(): { store: RosterPlanStore; writes: RosterEntry[][] } {
  const writes: RosterEntry[][] = [];
  let state: RosterPlanState = {};
  return {
    writes,
    store: {
      async reload() {
        return state;
      },
      async setRoster(roster, expectedVersion) {
        writes.push(roster);
        state = { roster, rosterVersion: (expectedVersion ?? 0) + 1 };
        return state;
      },
      async clearRoster() {
        state = {};
      },
    },
  };
}

const ADD_CASEWORKER: RosterPlanEditRequest = {
  owner: { type: 'tour', id: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1' },
  state: {},
  edit: { kind: 'add', entry: { contactId: 'c-caseworker' } },
  notFoundError: 'tour_not_found',
};

describe('materializing the property default into a plan (spec 4.1)', () => {
  it('a DELETED primary is never written into the plan - the landlord of record is', async () => {
    const { store, writes } = memoryStore();
    const outcome = await applyRosterPlanEdit(
      depsFor({
        'c-tenant': person('c-tenant', '+15550100001', 'Tina', { type: 'tenant' }),
        'c-pm': person('c-pm', '+15550100002', 'Pat', { deleted_at: DELETED_AT }),
        'c-owner': person('c-owner', '+15550100004', 'Olive'),
      }),
      store,
      ADD_CASEWORKER,
    );
    expect(outcome).toEqual({ ok: true });
    // writes[0] is the MATERIALIZE, writes[1] the add applied on top of it.
    expect(writes[0]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-owner' }]);
    expect(writes[1]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-owner' }, { contactId: 'c-caseworker' }]);
  });

  it('(PIN) a THROWING property-contact read keeps the candidate as a bare entry - the plan never loses it', async () => {
    const { store, writes } = memoryStore();
    const outcome = await applyRosterPlanEdit(
      depsFor(
        {
          'c-tenant': person('c-tenant', '+15550100001', 'Tina', { type: 'tenant' }),
          'c-owner': person('c-owner', '+15550100004', 'Olive'),
        },
        ['c-pm'],
      ),
      store,
      ADD_CASEWORKER,
    );
    expect(outcome).toEqual({ ok: true });
    expect(writes[0]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-pm' }]);
  });
});
```

**(2) Run them RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterResolution.test.ts test/rosterPlanMaterializePropertyContact.test.ts
```

Expected RED: `Test Files  2 failed (2)`. In `rosterResolution.test.ts` the
new describe has 4 failed and 1 passed - the `(PIN)` read-failure test is
green before AND after (it pins today's bare row, which C1 must keep); every
pre-existing test still passes. The failures show the deleted or dangling
contact still on the list, e.g. `c-pm` where `c-owner` is expected. In
`rosterPlanMaterializePropertyContact.test.ts`: 1 failed (the deleted
primary is in `writes[0]`), 1 passed (the `(PIN)`).

**(3) Implement.** Four Edit-tool edits in `app/src/lib/rosterResolution.ts`.

Edit A (import). old_string:

```ts
import type { Logger } from './logger.js';
import { normalizeToE164 } from './phone.js';
```

new_string:

```ts
import type { Logger } from './logger.js';
import { normalizeToE164 } from './phone.js';
import { resolvePropertyContact } from './propertyContact.js';
```

Edit B (the file header's description of the default). old_string:

```ts
//   NO THREAD  -> the roster is a PLAN: the `roster` override when the operator
//                 materialized one, else the property default (the tenant plus
//                 the unit's primary contact, falling back to the landlord of
//                 record when no roster row is primary).
```

new_string:

```ts
//   NO THREAD  -> the roster is a PLAN: the `roster` override when the operator
//                 materialized one, else the property default (the tenant plus
//                 the PROPERTY CONTACT from the one shared lookup,
//                 lib/propertyContact.ts: the roster row flagged primary, else
//                 the landlord of record, skipping a soft-deleted or missing
//                 contact).
```

Edit C (the corrected docblock, and the record-to-member helper the default
branch reuses). old_string:

```ts
/**
 * Build a member from a contactId. A contact that cannot be read - deleted,
 * dangling, or a repo throw - KEEPS ITS ROW (spec 5.2 DANGLING IDS): the row
 * renders as "removed contact", is excluded from every send and from call
 * routing, and stays removable like any other member. Dropping it would hide a
 * member the operator can still see on the thread.
 */
async function memberFromContact(
  deps: RosterResolutionDeps,
  contactId: string,
): Promise<ResolvedMember> {
  let contact: ContactItem | undefined;
  try {
    contact = await deps.contacts.getById(contactId);
  } catch (err) {
    deps.log.warn({ err, contactId }, 'roster resolution: contact read failed - bare row kept');
  }
  if (!contact) return { contactId };
  const phone = nonEmpty(contact.phone);
  const normalized = phone !== undefined ? normalizeToE164(phone) : undefined;
  const name = displayName(contact);
  return {
    contactId,
    ...(normalized !== undefined && { phone: normalized }),
    ...(name !== undefined && { name }),
  };
}
```

new_string:

```ts
/** A member from a contact record already in hand: its E.164 phone and its display name. */
function memberFromRecord(contactId: string, contact: ContactItem): ResolvedMember {
  const phone = nonEmpty(contact.phone);
  const normalized = phone !== undefined ? normalizeToE164(phone) : undefined;
  const name = displayName(contact);
  return {
    contactId,
    ...(normalized !== undefined && { phone: normalized }),
    ...(name !== undefined && { name }),
  };
}

/**
 * Build a member from a contactId - a plan entry, or the tenant slot. A
 * contact that cannot be read KEEPS ITS ROW (spec 5.2 DANGLING IDS) and stays
 * removable like any other member; dropping it would hide a member the
 * operator can still see:
 *
 * - a DANGLING id (no record) or a repo THROW gives the bare `{ contactId }`
 *   row. It carries no phone, so provisioning and every send skip it.
 * - a SOFT-DELETED contact is a different case: contactsRepo.getById returns
 *   the record, so its row keeps the phone and the name. describeRoster
 *   labels it `removed_contact` but still counts it reachable, and
 *   provisioning puts it on the relay thread - it is NOT excluded from sends.
 *   Filed as docs/issues/relay-provision-includes-deleted-contacts.md
 *   (primary-contact-integrity spec 9.3). The property DEFAULT below never
 *   adds one as its property contact: the shared lookup skips it.
 */
async function memberFromContact(
  deps: RosterResolutionDeps,
  contactId: string,
): Promise<ResolvedMember> {
  let contact: ContactItem | undefined;
  try {
    contact = await deps.contacts.getById(contactId);
  } catch (err) {
    deps.log.warn({ err, contactId }, 'roster resolution: contact read failed - bare row kept');
  }
  if (!contact) return { contactId };
  return memberFromRecord(contactId, contact);
}
```

Edit D (the default branch). old_string:

```ts
  // The property's default contact, with the D3 fallback: when NO roster row
  // carries primaryContact (zero-primary is legal and reachable, spec 5.1) fall
  // back to the LANDLORD OF RECORD - exactly the pre-roster behavior, so no
  // working property regresses to a too-thin roster.
  const roster = unitContacts(unit);
  const primary = roster.find((c) => c.primaryContact === true);
  const propertyContactId = primary?.contactId ?? nonEmpty(unit.landlordId);
  if (propertyContactId === undefined || propertyContactId.length === 0) {
    return { source: 'default', members };
  }
  // De-dupe the degenerate case where the tenant IS the property contact.
  if (propertyContactId !== tenantId) {
    members.push(await memberFromContact(deps, propertyContactId));
  }
  return { source: 'default', members };
}
```

new_string:

```ts
  // The property's default contact: the ONE shared lookup
  // (lib/propertyContact.ts, primary-contact-integrity spec 4.1). The roster
  // row flagged primary, else the LANDLORD OF RECORD (the D3 fallback:
  // zero-primary is legal and reachable, so no working property regresses to
  // a too-thin roster) - and a soft-deleted or missing contact is SKIPPED, so
  // a deleted primary is never put on this list, provisioned or texted. A
  // candidate who IS the tenant is no property contact (the tenant already
  // holds a slot).
  const lookup = await resolvePropertyContact({
    unit,
    tenantId,
    contactsRepo: deps.contacts,
    logger: deps.log,
  });
  if (lookup.kind === 'found') {
    members.push(memberFromRecord(lookup.contactId, lookup.contact));
  } else if (lookup.kind === 'read_failed') {
    // A read that THREW is not absence (spec 4.1): keep today's bare row for
    // that candidate, so a plan materialized from this default
    // (services/rosterEdits.ts applyRosterPlanEdit) never silently loses the
    // property contact. It carries no phone, so no send reaches it.
    deps.log.warn(
      { ownerType: owner.type, ownerId: owner.id, contactId: lookup.candidateId },
      'roster resolution: property contact read failed - bare row kept',
    );
    members.push({ contactId: lookup.candidateId });
  }
  return { source: 'default', members };
}
```

`unitContacts` stays imported (describeRoster's role map uses it).

**(4) Run GREEN** - the two files, plus every suite that resolves a default
roster (People card, previews, provisioning, plan edits, the deferred-action
poller, the nudge tenant gate). All in-memory, no DynamoDB:

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterResolution.test.ts test/rosterPlanMaterializePropertyContact.test.ts test/rosterEdits.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/placementsRelay.test.ts test/rosterActionsPoll.test.ts test/placementNudges.test.ts test/tourRemindersApi.test.ts
```

Expected: `Test Files  9 passed (9)`, 0 failed. If a pre-existing test fails
ONLY because a default roster no longer carries a soft-deleted or
record-less (dangling) property contact, that is the stated behavior change
(spec 4.1 "Behavior change, stated") - STOP and report the test name and
assertion to the planner; do not edit the test unilaterally.

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/lib/rosterResolution.ts`,
`modified: app/test/rosterResolution.test.ts` and the untracked
`app/test/rosterPlanMaterializePropertyContact.test.ts`. Anything else: stop
and report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/rosterResolution.ts app/test/rosterResolution.test.ts app/test/rosterPlanMaterializePropertyContact.test.ts && git commit -m "fix(app): the default people list skips a deleted property contact and keeps the bare row on a failed read; correct the memberFromContact docblock (spec 4.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.7 - the two roster-open diagnostics read the property contact through C1

`services/rosterProvision.ts`: the tour diagnostic (`resolveTourMembers`)
and the placement diagnostic (`describeThinPlacementRoster`) keep their codes
AND texts per state (spec 4.1):

| C1 outcome | tour `detail` (400 relay_member_unresolvable) | placement body (400) |
|---|---|---|
| nobody `none` | `unit has no landlord (cannot resolve landlord)` | `{ error: 'landlord_unreachable', message: 'the unit landlord has no phone on file' }` |
| nobody `deleted` (deleted or no record) | `landlord contact not found` | same `landlord_unreachable` body |
| nobody `is_tenant` | `this tour roster has fewer than two reachable members` | `{ error: 'relay_member_unresolvable', detail: 'this placement roster has fewer than two reachable members' }` |
| found, no phone | `landlord contact has no phone` | `landlord_unreachable` body |
| found, with phone | `this tour roster has fewer than two reachable members` | the `relay_member_unresolvable` body |
| read throws | the SAME error is thrown (today's thrown read) | the SAME error is thrown |

The API tests that assert the tour texts verbatim
(`app/test/toursApi.test.ts` "400 relay_member_unresolvable names each
missing rung of the resolution ladder" and "... naming the tenant when the
tenant contact has no phone") and the placement codes
(`app/test/placementsRelay.test.ts` "400s when the tenant has no phone on
file", "400s when the unit landlord has no phone on file") must stay green
UNCHANGED.

Files:

- Modify `app/src/services/rosterProvision.ts`
- Create `app/test/rosterProvisionPropertyContact.test.ts`
- Create `app/test/propertyContactLadderSingleSource.test.ts`

Steps:

**(1) Write the failing tests.**

1a. Create `app/test/rosterProvisionPropertyContact.test.ts` with exactly
this content:

```ts
// The two too-thin DIAGNOSTICS in services/rosterProvision.ts read the
// property contact through the shared lookup (primary-contact-integrity spec
// 4.1) and keep, per state, the code and text they answered before:
//   tour:      none -> 'unit has no landlord (cannot resolve landlord)';
//              deleted / no record -> 'landlord contact not found';
//              is_tenant -> 'this tour roster has fewer than two reachable members';
//   placement: none / deleted -> landlord_unreachable;
//              is_tenant -> relay_member_unresolvable;
//   a read that throws -> thrown out as the same error, as the inline getById
//   threw it.
// Driven through the exported deferral pre-checks (tourOpenDeferralRefusal /
// placementOpenDeferralRefusal): they run exactly the immediate path's
// resolution and refusal ladder and provision nothing. PURE - in-memory
// repos, no DynamoDB, no HTTP.
import { describe, expect, it } from 'vitest';
import {
  placementOpenDeferralRefusal,
  tourOpenDeferralRefusal,
  type OpenPlacementGroupDeps,
  type OpenTourGroupDeps,
} from '../src/services/rosterProvision.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const TENANT: ContactItem = { contactId: 'c-tenant', type: 'tenant', firstName: 'Tina', phone: '+15550100001' };
const LANDLORD: ContactItem = { contactId: 'c-ll', type: 'landlord', firstName: 'Lee', phone: '+15550100002' };
const PM: ContactItem = { contactId: 'c-pm', type: 'landlord', firstName: 'Pat', phone: '+15550100003' };
const PM_NO_PHONE: ContactItem = { contactId: 'c-pm', type: 'landlord', firstName: 'Pat' };

interface World {
  unit?: UnitItem;
  contacts: Record<string, ContactItem>;
  /** contactId -> the error its read THROWS. */
  throwing?: Record<string, Error>;
}

function depsFor(world: World): OpenTourGroupDeps & OpenPlacementGroupDeps {
  return {
    conversations: { getById: async () => undefined },
    units: { getById: async () => world.unit },
    contacts: {
      getById: async (contactId: string) => {
        const boom = world.throwing?.[contactId];
        if (boom !== undefined) throw boom;
        return world.contacts[contactId];
      },
    },
    log: createLogger({ destination: createLogCapture().stream }),
  } as unknown as OpenTourGroupDeps & OpenPlacementGroupDeps;
}

const TOUR = {
  tourId: 'tour-1',
  tenantId: 'c-tenant',
  unitId: 'unit-1',
  status: 'scheduled',
  tourType: 'landlord_led',
} as unknown as TourItem;
const PLACEMENT = {
  placementId: 'plc-1',
  tenantId: 'c-tenant',
  unitId: 'unit-1',
  stage: 'awaiting_approval',
} as unknown as PlacementItem;

function unitOf(over: Record<string, unknown>): UnitItem {
  return { unitId: 'unit-1', status: 'available', ...over } as unknown as UnitItem;
}
/** A PM flagged primary next to the landlord of record. */
const PM_PRIMARY = {
  landlordId: 'c-ll',
  contacts: [
    { contactId: 'c-ll', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
};

const tourRefusal = (world: World) => tourOpenDeferralRefusal(depsFor(world), TOUR, true);
const placementRefusal = (world: World) => placementOpenDeferralRefusal(depsFor(world), PLACEMENT, true);
const tourDetail = (detail: string) => ({ status: 400, body: { error: 'relay_member_unresolvable', detail } });
const LANDLORD_UNREACHABLE = {
  status: 400,
  body: { error: 'landlord_unreachable', message: 'the unit landlord has no phone on file' },
};
const PLACEMENT_TOO_THIN = {
  status: 400,
  body: {
    error: 'relay_member_unresolvable',
    detail: 'this placement roster has fewer than two reachable members',
  },
};

describe('the TOUR too-thin diagnostic reads the property contact through the shared lookup (spec 4.1)', () => {
  it('none -> "unit has no landlord (cannot resolve landlord)"', async () => {
    expect(
      await tourRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM },
      }),
    ).toEqual(tourDetail('unit has no landlord (cannot resolve landlord)'));
  });

  it('deleted -> "landlord contact not found": a soft-deleted SOLE primary reads like a missing contact', async () => {
    expect(
      await tourRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM, deleted_at: DELETED_AT } },
      }),
    ).toEqual(tourDetail('landlord contact not found'));
  });

  it('deleted -> "landlord contact not found": a deleted primary AND a deleted landlord of record', async () => {
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: {
          'c-tenant': TENANT,
          'c-pm': { ...PM, deleted_at: DELETED_AT },
          'c-ll': { ...LANDLORD, deleted_at: DELETED_AT },
        },
      }),
    ).toEqual(tourDetail('landlord contact not found'));
  });

  it('a deleted primary resolves PAST it to the live landlord of record: no refusal', async () => {
    // Before the shared lookup the phone-less deleted PM made the default
    // roster too thin, and the diagnostic blamed it ("landlord contact has no
    // phone").
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM_NO_PHONE, deleted_at: DELETED_AT }, 'c-ll': LANDLORD },
      }),
    ).toBeUndefined();
  });

  it('(PIN) a LIVE primary without a phone is not skipped: "landlord contact has no phone"', async () => {
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM_NO_PHONE, 'c-ll': LANDLORD },
      }),
    ).toEqual(tourDetail('landlord contact has no phone'));
  });

  it('(PIN) is_tenant -> the too-thin text: the tenant IS the property contact', async () => {
    expect(
      await tourRefusal({ unit: unitOf({ landlordId: 'c-tenant' }), contacts: { 'c-tenant': TENANT } }),
    ).toEqual(tourDetail('this tour roster has fewer than two reachable members'));
  });

  it('(PIN) a property-contact read that THROWS is thrown out as the SAME error - never a fall-through', async () => {
    const boom = new Error('dynamodb: ProvisionedThroughputExceededException');
    await expect(
      tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-ll': LANDLORD },
        throwing: { 'c-pm': boom },
      }),
    ).rejects.toBe(boom);
  });
});

describe('the PLACEMENT too-thin diagnostic keeps its codes per state (spec 4.1)', () => {
  it('(PIN) none -> landlord_unreachable', async () => {
    expect(
      await placementRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM },
      }),
    ).toEqual(LANDLORD_UNREACHABLE);
  });

  it('deleted -> landlord_unreachable: a soft-deleted SOLE primary is no longer put on the group', async () => {
    expect(
      await placementRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM, deleted_at: DELETED_AT } },
      }),
    ).toEqual(LANDLORD_UNREACHABLE);
  });

  it('a deleted primary resolves PAST it to the live landlord of record: no refusal', async () => {
    expect(
      await placementRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM_NO_PHONE, deleted_at: DELETED_AT }, 'c-ll': LANDLORD },
      }),
    ).toBeUndefined();
  });

  it('(PIN) is_tenant -> relay_member_unresolvable', async () => {
    expect(
      await placementRefusal({ unit: unitOf({ landlordId: 'c-tenant' }), contacts: { 'c-tenant': TENANT } }),
    ).toEqual(PLACEMENT_TOO_THIN);
  });

  it('(PIN) a property-contact read that THROWS is thrown out as the SAME error', async () => {
    const boom = new Error('dynamodb: ProvisionedThroughputExceededException');
    await expect(
      placementRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-ll': LANDLORD },
        throwing: { 'c-pm': boom },
      }),
    ).rejects.toBe(boom);
  });
});
```

1b. Create `app/test/propertyContactLadderSingleSource.test.ts` with exactly
this content:

```ts
// The property-contact ladder - "the roster row flagged primary, else the
// landlord of record" - has ONE implementation: lib/propertyContact.ts
// (primary-contact-integrity spec 4.1 / goal G2). Four inline copies of it
// (lib/tourContacts.ts, lib/rosterResolution.ts and both
// services/rosterProvision.ts diagnostics) never checked deleted_at, which is
// how a soft-deleted primary got named, listed and texted. This pin fails if
// a copy comes back.
//
// TEXTUAL, like tourCopyCallSites.test.ts: it matches the two shapes the
// copies were written in (`...primaryContact === true)?.contactId ??` and
// `primary?.contactId ??`), not every conceivable re-derivation. A green run
// is evidence, not proof.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOME = join('lib', 'propertyContact.ts');
const LADDER_SHAPES: readonly RegExp[] = [
  /primaryContact === true\)\?\.contactId\s*\?\?/,
  /\bprimary\?\.contactId\s*\?\?/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('the primary-then-landlord ladder has ONE implementation (spec 4.1)', () => {
  it('no module outside lib/propertyContact.ts re-derives it', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(HOME)) continue;
      const text = readFileSync(file, 'utf8');
      for (const shape of LADDER_SHAPES) {
        if (shape.test(text)) offenders.push(`${path.relative(SRC, file)}: ${shape.source}`);
      }
    }
    expect(offenders, `read the property contact through lib/propertyContact.ts:\n${offenders.join('\n')}`).toEqual([]);
  });
});
```

**(2) Run them RED (pure, no DynamoDB):**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterProvisionPropertyContact.test.ts test/propertyContactLadderSingleSource.test.ts
```

Expected RED: `Test Files  2 failed (2)`.
`rosterProvisionPropertyContact.test.ts`: `3 failed | 9 passed`. The three
failures are the tour "deleted -> landlord contact not found" pair (the old
ladder reads the soft-deleted PM, finds its phone and answers
`detail: 'this tour roster has fewer than two reachable members'` instead of
`'landlord contact not found'`) and the placement "deleted ->
landlord_unreachable" case (it answers the `relay_member_unresolvable`
too-thin body instead). The two "resolves PAST" tests ALREADY pass here:
Task S1.6 fixed the default membership they pin end to end through the open
path (against the pre-S1 tree they fail); the `(PIN)` tests pass before and
after.
`propertyContactLadderSingleSource.test.ts`: 1 failed, listing exactly
`services\rosterProvision.ts: primaryContact === true\)\?\.contactId\s*\?\?`
(forward slash on Linux) - tourContacts.ts and rosterResolution.ts are
already clean after Tasks S1.5-S1.6.

**(3) Implement.** Five Edit-tool edits in
`app/src/services/rosterProvision.ts`.

Edit A (import the lookup). old_string:

```ts
import { recordRosterMilestone } from '../lib/personEvents.js';
```

new_string:

```ts
import { recordRosterMilestone } from '../lib/personEvents.js';
import { resolvePropertyContact, type PropertyContactResult } from '../lib/propertyContact.js';
```

Edit B (the units import loses `unitContacts`, gains `UnitItem`). old_string:

```ts
import { unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
```

new_string:

```ts
import type { UnitItem, UnitsRepo } from '../repos/unitsRepo.js';
```

Edit C (the shared diagnostic helper, placed before the Tours section).
old_string:

```ts
// ---------------------------------------------------------------------------
// Tours
// ---------------------------------------------------------------------------
```

new_string:

```ts
/**
 * The property contact for a too-thin DIAGNOSTIC - the ONE shared lookup
 * (lib/propertyContact.ts, primary-contact-integrity spec 4.1), the same walk
 * the resolver took to build the default roster. The lookup itself never
 * throws, but these diagnostics always have: a contact read that throws here
 * fails the open (the route's 500, the poller's retry) rather than naming the
 * wrong rung. So a `read_failed` RE-THROWS the very error the read raised,
 * captured on its way through.
 */
async function diagnosticPropertyContact(
  contacts: Pick<ContactsRepo, 'getById'>,
  log: Logger,
  unit: UnitItem,
  tenantId: string,
): Promise<Exclude<PropertyContactResult, { kind: 'read_failed' }>> {
  let thrown: unknown;
  const result = await resolvePropertyContact({
    unit,
    tenantId,
    contactsRepo: {
      getById: async (contactId: string) => {
        try {
          return await contacts.getById(contactId);
        } catch (err) {
          thrown = err;
          throw err;
        }
      },
    },
    logger: log,
  });
  if (result.kind === 'read_failed') {
    throw thrown ?? new Error(`roster open: property contact read failed (candidateId=${result.candidateId})`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tours
// ---------------------------------------------------------------------------
```

Edit D (the tour diagnostic). old_string:

```ts
  const unit = await deps.units.getById(tour.unitId);
  if (!unit) return { unresolvable: 'unit not found (cannot resolve landlord)' };
  // The property's contact is the primaryContact row, falling back to the
  // landlord of record (D3) - the same ladder the resolver walked.
  const propertyContactId =
    unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ??
    (typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined);
  if (propertyContactId === undefined) {
    return { unresolvable: 'unit has no landlord (cannot resolve landlord)' };
  }
  const landlord = await deps.contacts.getById(propertyContactId);
  if (!landlord) return { unresolvable: 'landlord contact not found' };
```

new_string:

```ts
  const unit = await deps.units.getById(tour.unitId);
  if (!unit) return { unresolvable: 'unit not found (cannot resolve landlord)' };
  // The property's contact through the shared lookup - the same walk the
  // resolver took. Each outcome keeps the detail string its state answered
  // before the lookup existed (spec 4.1; the API tests assert them verbatim):
  //   none      -> no flagged primary and no landlord of record;
  //   deleted   -> every candidate soft-deleted or without a record - a
  //                deleted contact now reads exactly like a missing one;
  //   is_tenant -> the tenant IS the property contact: one party, too thin.
  // A read that throws is re-thrown (diagnosticPropertyContact).
  const lookup = await diagnosticPropertyContact(deps.contacts, deps.log, unit, tour.tenantId);
  if (lookup.kind === 'nobody') {
    if (lookup.reason === 'none') return { unresolvable: 'unit has no landlord (cannot resolve landlord)' };
    if (lookup.reason === 'deleted') return { unresolvable: 'landlord contact not found' };
    return { unresolvable: 'this tour roster has fewer than two reachable members' };
  }
  const landlord = lookup.contact;
```

(The lines that follow - `const landlordPhone = ...`, the
`'landlord contact has no phone'` return and the final too-thin return - stay
exactly as they are.)

Edit E (the placement diagnostic). old_string:

```ts
  const unit = await deps.units.getById(item.unitId);
  if (!unit) return { status: 400, body: { error: 'unit_not_found' } };
  const propertyContactId =
    unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ?? unit.landlordId;
  const landlord =
    typeof propertyContactId === 'string' && propertyContactId.length > 0
      ? await deps.contacts.getById(propertyContactId)
      : undefined;
```

new_string:

```ts
  const unit = await deps.units.getById(item.unitId);
  if (!unit) return { status: 400, body: { error: 'unit_not_found' } };
  // The property's contact through the shared lookup (spec 4.1), each state
  // keeping today's code: none / deleted -> landlord_unreachable (this ladder's
  // one property-side code); is_tenant -> the too-thin answer, exactly what
  // the tenant-as-landlord read used to reach. A read that throws is re-thrown
  // (diagnosticPropertyContact).
  const lookup = await diagnosticPropertyContact(deps.contacts, deps.log, unit, item.tenantId);
  if (lookup.kind === 'nobody' && lookup.reason === 'is_tenant') {
    return {
      status: 400,
      body: {
        error: 'relay_member_unresolvable',
        detail: 'this placement roster has fewer than two reachable members',
      },
    };
  }
  const landlord = lookup.kind === 'found' ? lookup.contact : undefined;
```

(The `if (!landlord || typeof landlord.phone !== 'string' || ...)` refusal
and the final return that follow stay exactly as they are.)

**(4) Run GREEN** - the two new files, plus the suites that assert the
diagnostics' codes and texts verbatim and every open path (in-memory, no
DynamoDB):

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterProvisionPropertyContact.test.ts test/propertyContactLadderSingleSource.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/placementsRelay.test.ts test/rosterActionsPoll.test.ts
```

Expected: `Test Files  6 passed (6)`, 0 failed. In particular
`toursApi.test.ts` "400 relay_member_unresolvable names each missing rung of
the resolution ladder" passes UNCHANGED (its `ll-ghost` landlord with no
record now resolves as nobody `deleted` -> 'landlord contact not found').

**(5) Commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: ONLY `modified: app/src/services/rosterProvision.ts` and the two
untracked files `app/test/rosterProvisionPropertyContact.test.ts` and
`app/test/propertyContactLadderSingleSource.test.ts`. Anything else: stop and
report.

```bash
cd W:/tmp/primary-contact-integrity && ls "$(git rev-parse --git-path MERGE_HEAD)"
```

Expected: `No such file or directory`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/services/rosterProvision.ts app/test/rosterProvisionPropertyContact.test.ts app/test/propertyContactLadderSingleSource.test.ts && git commit -m "fix(app): roster-open diagnostics read the property contact through the shared lookup, codes and texts unchanged per state (spec 4.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S1.8 - S1 slice gate

No code changes. Every step runs BARE (never piped); quote the real exit
code.

**(1) Typecheck** (all workspaces, app src + scripts + tests):

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0, no `error TS` lines.

**(2) The S1 test files and every suite S1's readers feed** (in-memory, no
DynamoDB):

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/propertyContact.test.ts test/propertyContactLookup.test.ts test/propertyContactHeir.test.ts test/autoRoutingEligibleSingleSource.test.ts test/propertyContactLadderSingleSource.test.ts test/tourContacts.test.ts test/relayIntroPropertyContact.test.ts test/rosterResolution.test.ts test/rosterPlanMaterializePropertyContact.test.ts test/rosterProvisionPropertyContact.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsRestoreLandlord.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiRoster.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/placementsRelay.test.ts test/tourRemindersApi.test.ts test/tourCopy.test.ts test/relayFanOut.test.ts test/rosterEdits.test.ts test/contactTimeline.test.ts test/rosterActionsPoll.test.ts test/placementNudges.test.ts
```

Expected: `Test Files  24 passed (24)`, 0 failed.

**(3) The whole app workspace** (needs DynamoDB Local; it covers
`tourReminders.test.ts`, the reminder job's integration suite, and every
other app suite). Precondition: DynamoDB Local is running - check with
`docker ps --filter name=hc-dynamodb-local` (a row with status `Up` means
running). If it is running, do NOT run `npm run db:start` (it can recreate a
container whose args went stale, wiping every lane's data). Only if it is NOT
running: `cd W:/tmp/primary-contact-integrity && npm run db:start`. NEVER
restart or stop a running shared container. On a cloud Linux container, first run
`env | grep '^AWS_'` and, if any AWS key is exported, prefix the command with
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY`.

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run
```

Expected: exit 0, `Test Files  ... passed`, 0 failed. A failure in a
DynamoDB Local suite that S1 did not touch is adjudicated by AGENTS.md
re-run-and-compare (re-run the failing FILE alone more than once; run the
suite at the branch's merge base; compare failing FILES) - never by editing
the test. Any `[dynamoAdmin]` line in the output is a real container fault:
record its `err.$metadata.httpStatusCode` and `attempts` and report it.

**(4) Lint the files S1 touched** (gate 5 shape, scoped to S1's own files):

```bash
cd W:/tmp/primary-contact-integrity && npx eslint app/src/lib/propertyContact.ts app/src/lib/tourContacts.ts app/src/lib/rosterResolution.ts app/src/services/rosterProvision.ts app/src/routes/units.ts app/test/propertyContact.test.ts app/test/propertyContactLookup.test.ts app/test/propertyContactHeir.test.ts app/test/autoRoutingEligibleSingleSource.test.ts app/test/propertyContactLadderSingleSource.test.ts app/test/tourContacts.test.ts app/test/relayIntroPropertyContact.test.ts app/test/rosterResolution.test.ts app/test/rosterPlanMaterializePropertyContact.test.ts app/test/rosterProvisionPropertyContact.test.ts
```

Expected: exit 0, no output. If errors are reported, attribute them by
BASELINE comparison (AGENTS.md gate 5): run the same command on the
pre-existing paths at the merge base; anything new is S1's and blocking.

**(5) Nothing to commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Expected: `nothing to commit, working tree clean` on
`feat/primary-contact-integrity`, with seven S1 commits on top of the plan
commits. Record the four exit codes in the slice report.

---

## S2 - app writes (plan slice draft)

Slice of `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`.
Runs AFTER S1 (which creates `app/src/lib/propertyContact.ts` per contract
2.1). Scope: plan sections 1-3, contracts 2.2-2.4 - P2 widening in
`unitsRepo.addContact` + the contact-list add/edit route, 409
`primary_contact_deleted`, P2b, `removeContact` heir + 503, the restore route
(heir in place of `soleLandlordToPromote`, swap re-runs the heir function),
`handOffPrimaryFrom` + `list({ consistentRead })`, the contact-DELETE fan-out
service and its wiring, the audit event `unit_primary_contact_assigned`, and
the API-test fake.

All paths are under `W:\tmp\primary-contact-integrity`. Every command uses an
explicit `cd`. ASCII only in every new or touched line.

### CONTRACT ISSUES (RULED - section 3.2 and plan-assembly-rulings.md govern; do not act on any "ruling needed" text here)

1. **Landlord SWAP primary decision: REPO-computed** (contract 2.2 left it
   open). `restoreWithLandlord(unitId, input, opts?)` gains a third parameter
   `opts?: RosterHandoffOpts` (`readContacts`, `onPrimaryHandoff`). When the
   old landlord was the primary, the repo re-runs `chooseHeir` on EACH
   attempt's swapped roster (landlordId = the new landlord, exclude = the old
   landlord) with liveness from `opts.readContacts`, and applies it with
   `applyPrimary`. Why: the swap branch retries contacts-only races
   (caseworker-integrity: it is NOT fenced on `expectContacts`), so a
   route-decided heir could go stale between attempts; deciding per attempt
   keeps the decision on the very roster the conditional write is fenced on.
   The CLEAR branch (`next: null`) keeps the contract as written: the ROUTE
   decides `promote` with `chooseHeir` (exclude = the cleared landlord,
   landlordId = undefined) from `listRead`, and the repo applies it only on
   `expectContacts` (any list change -> 409 `unit_roster_conflict`), so a
   route decision there cannot go stale. Liveness unknown: clear -> the route
   answers 503 `roster_read_failed` before any write; swap -> the repo throws
   `RosterReadFailedError` -> 503 `roster_read_failed`, nothing written.
2. **Audit derivation from the write's own result (contract 2.4).**
   - `auto_on_add`: derived exactly as main's FW2-2 `autoPrimary` flag -
     the written unit's row for X is primary AND the request did not ask for
     it (`effectivePrimary && !primaryContact`). Only the auto rule can make
     that true, so it is exact. No `from` (the previous flagged row is not in
     the write's result; contract 2.4 makes `from` optional).
   - handoffs (`handoff_on_remove`, `handoff_on_restore`): NEW
     `opts.onPrimaryHandoff?: (h: PrimaryHandoff) => void`, called by
     `removeContact` / `restoreWithLandlord` ONCE, after the successful
     conditional write, only when that write flagged an heir
     (`{ from: <removed / old landlord>, to: <heir> }`). A clear (no heir)
     reports nothing and appends no event (the event names an assignee).
     Chosen over changing the methods' `Promise<UnitItem>` return type, which
     would churn ~25 existing test call sites.
   - `handoff_on_delete`: from `handOffPrimaryFrom`'s result
     `{ outcome: 'moved', unit, to }`.
   - Every payload also carries `actor` (the repo-wide audit convention; the
     audit repo hoists it to `actorId`). Payload:
     `{ actor, contactId, reason, from? }`.
   - Route appends are awaited without a catch, like their neighbors
     (`unit_contact_added` etc.); the delete fan-out's appends are
     best-effort (logged, never thrown).
3. **409 `primary_contact_deleted` is decided twice**, in the
   caseworker-integrity FW2-1 pattern: the route checks it on its consistent
   reads (after the 404s and after I4 `contact_list_caseworker` and I3
   `landlord_not_landlord`), and `addContact` re-decides it per attempt from a
   NEW optional fact `ContactListFacts.contactDeleted?: boolean` (absent =
   not deleted), throwing NEW `PrimaryContactDeletedError` (repo order: I4,
   I3, deleted, reassignment). Without the per-attempt check, a primary moved
   off a deleted contact between the route's read and the write would let a
   re-sent `primaryContact: true` make the deleted contact primary again.
4. **Absent `readContacts`** - one semantics everywhere: absent = liveness
   UNKNOWN whenever a decision needs it. `addContact`: unknown -> no
   promotion, which equals main's rule (promote only with no flagged row and
   no landlordId) exactly as contract 2.2 says. `removeContact` of the primary
   and a swap of a primary landlord: unknown -> `RosterReadFailedError`
   (contract 2.2 said "required"; kept OPTIONAL in the type so non-primary
   removals and existing callers compile, but never silently falling back to
   a twin rule). Existing integration tests that remove a primary or swap a
   primary landlord are updated to pass a liveness stub (named per task).
5. **The P2 decision is a shared PURE function in `unitsRepo.ts`**
   (`autoPrimaryLivenessIds`, `decideAutoPrimary`, `AutoPrimaryArgs`), so the
   real repo and the API-test fake call one rule ("no twin logic"). It lives
   in S2's file, not in S1's `propertyContact.ts`. Pinned semantics: the
   liveness read for P2 asks only for the flagged primary and `landlordId`
   (a subset of C2's ids, one batch read, per contract 2.2); X itself being
   the flagged primary counts as a LIVE flagged primary (X is eligible, so
   live) - an explicit `primaryContact: false` on X's own primary row still
   demotes it as today and then REMOVEs the scalar; X being the landlord of
   record counts as a LIVE landlord of record ("properties with a live
   landlord of record are never touched by P2").
6. **`handOffPrimaryFrom` result shape**:
   `{ outcome: 'moved'; unit: UnitItem; to: string } | { outcome: 'unchanged'
   | 'not_primary' | 'unknown' }` (contract 2.2 named the outcomes; `to` added
   so the audit needs no re-derivation). A unit that no longer exists answers
   `not_primary` (nothing to hand off). The repo leaves the deleted contact
   out of the ids it passes to `readContacts` (and the service filters it
   too), so it is never read (C2).
7. **`list({ consistentRead })` is typed on `list` only**
   (`ListUnitsOpts & { consistentRead?: boolean }`), not on `ListUnitsOpts`:
   the same type feeds the GSI queries, and DynamoDB rejects `ConsistentRead`
   on a GSI.
8. **New exports from `unitsRepo.ts`** (beyond contract 2.2/2.3):
   `ReadRosterContacts` (alias of `(ids: string[]) =>
   Promise<RosterContactsRead>`), `RosterHandoffOpts`, `PrimaryHandoff`,
   `PrimaryHandOffResult`, `AutoPrimaryArgs`, `autoPrimaryLivenessIds`,
   `decideAutoPrimary`, `PrimaryContactDeletedError`, `RosterReadFailedError`.
9. **Spec gap for S4 (copy):** a restore whose liveness read fails now
   answers 503 `roster_read_failed` (both restore branches - spec 4.6 says
   "unknown -> refuse" but spec 7 gives no restore copy). Proposed for S4:
   map it in the restore dialog / notice slot to the remove copy "Couldn't
   check the other contacts - try again." Planner to rule.
10. **Consistency of the restore's contact read changes.** caseworker-integrity
    read the remaining contacts' types with a consistent `getById` per row
    (FW3-1 pin "(PIN) reads the remaining contacts CONSISTENTLY"). The heir
    path reads them through `readRosterContacts` (ONE `getManyByIds` with
    `requireComplete`, eventually consistent) - exactly spec 4.2's contract,
    whose accepted race covers it. The PIN is replaced (task S2.8) by one that
    pins the single complete batch read. Flagged so the planner knows a
    caseworker-integrity pin is deliberately relaxed; a later
    `ConsistentRead` option on `getManyByIds` would restore it.
11. **[SUPERSEDED by ruling R2 - S1 imports it under the ALIAS
    `autoRoutingEligible`; Task S2.4 step (c) and Task S2.8 step 3 (a) below
    already carry the corrected import edits. Do not act on this item's import
    text.]** **S1 assumptions this slice relies on** (from contract 2.1): after S1,
    `app/src/routes/units.ts` imports `isAutoRoutingEligible` BY THAT NAME
    from `'../lib/propertyContact.js'` (tasks S2.4/S2.8 extend that import
    line; if S1 aliased it, adapt the one import line and keep the call
    names in this slice's code); S1 may have removed the now-unused
    `isDeleted as isContactDeleted` from units.ts's contactsRepo import (task
    S2.4 restores it); `readRosterContacts` calls
    `contacts.getManyByIds(ids, { requireComplete: true })` once (two tests
    pin that second argument); `applyPrimary` adds an off-roster landlord heir
    as a row `{ contactId, role: 'landlord', primaryContact: true }` (tests
    match it with `expect.objectContaining`, position-free) and otherwise
    preserves row order and fields; no S2 test depends on what `chooseHeir`
    answers for a failed read with NO candidates.
12. **Runtime import cycle** `lib/propertyContact.ts <-> repos/unitsRepo.ts`
    (S1 imports `unitContacts`; S2 imports `chooseHeir`, `applyPrimary`,
    `rosterContactIds`). Safe under Node ESM and vite-node as long as neither
    module READS the other's bindings at module top level (only inside
    functions). Watch item for S1/S2 reviewers.
13. **Unassigned comment correction (spec 9.2):** the
    `conversationsRepo.ts` `placementId` docblock still says the voice
    masked-call seam resolves `placement -> unit.primary_contact`.
    `conversationsRepo.ts` is in no slice's owns list; this draft takes it as
    task S2.13 (comment only). The other 9.2 comment sites in
    `unitsRepo.ts` / `routes/units.ts` are already correct on the merged
    main (verified) except the addContact scalar comment, rewritten in S2.3.
Findings file: none - the merged code matches the spec's preconditions;
only line numbers drifted.

### Slice watch items

- S2 changes e2e-visible behavior (remove-the-primary heir, restore heir,
  edit-of-X auto-primary, contact-delete hand-off). S5 runs `npm run e2e`;
  `e2e/tests/dashboard-next/property-roster.spec.ts` exercises these flows
  (on the lean seed the outcomes are unchanged: a live landlord of record is
  the heir; restore-without-a-landlord of a landlord-only unit has nobody
  left).
- The contact DELETE now runs one consistent units Scan per delete (spec
  4.6 accepts it). No existing test seeds a unit whose primary is a deleted
  contact (swept: contactSoftDelete, contactsCrud, voiceInboxActivity,
  contactEmailReaders).
- Integration suites self-skip without DynamoDB Local. A `SKIPPED - no
  DynamoDB Local` line means the RED/GREEN step proved nothing: start it
  (`cd W:/tmp/primary-contact-integrity && npm run db:start`; never RESTART a
  shared container without Cameron's go) and re-run.
- `routes/units.ts` is shared: this slice edits ONLY the contact-list add and
  remove handlers, the restore handler, the `soleLandlordToPromote` helper
  (deleted, replaced) and three import lines. S3 later edits `enrichRoster`,
  the GET and `toUnitActivityEvent`.

#### Task S2.1 - P2b: `primary_contact` is no longer writable on unit create or PATCH

Files:
- Modify: `app/src/lib/unitFields.ts`
- Modify: `app/test/unitFields.test.ts`
- Modify: `app/test/unitsApi.test.ts`

DynamoDB Local: not needed (pure validator + FakeWorld harness).

**Step 1 - the failing tests.**

(a) `app/test/unitFields.test.ts` - Edit. old_string:

```ts
describe('validateUnitBody - tour_type (structured, clear-to-absent)', () => {
```

new_string:

```ts
describe('validateUnitBody - primary_contact is not writable (primary-contact-integrity spec 4.5)', () => {
  // P2b: only the roster writes set the primary_contact scalar, so a body
  // carrying it is refused like any other non-writable key, on create and on
  // update alike.
  it('refuses primary_contact on create', () => {
    expect(validateUnitBody({ landlordId: 'c-ll', primary_contact: 'c-pm' }, 'create')).toEqual({
      ok: false,
      error: 'unknown field: primary_contact',
    });
  });

  it('refuses primary_contact on update, even beside a writable field', () => {
    expect(validateUnitBody({ notes: 'x', primary_contact: 'c-pm' }, 'update')).toEqual({
      ok: false,
      error: 'unknown field: primary_contact',
    });
  });
});

describe('validateUnitBody - tour_type (structured, clear-to-absent)', () => {
```

(b) `app/test/unitsApi.test.ts` - Edit (replaces the test that asserted the
scalar WAS accepted). old_string:

```ts
  it('accepts the per-unit internal fields incl. primary_contact (CO1)', async () => {
    const { app } = landlordHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        landlordId: 'contact-ll-1',
        tour_process: 'lockbox 1234',
        application_process: 'online portal',
        primary_contact: 'contact-ll-agent-7',
        pets: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.unit.primary_contact).toBe('contact-ll-agent-7');
    expect(res.body.unit.pets).toBe(true);
  });
```

new_string:

```ts
  it('accepts the per-unit internal fields (CO1)', async () => {
    const { app } = landlordHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        landlordId: 'contact-ll-1',
        tour_process: 'lockbox 1234',
        application_process: 'online portal',
        pets: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.unit.tour_process).toBe('lockbox 1234');
    expect(res.body.unit.application_process).toBe('online portal');
    expect(res.body.unit.pets).toBe(true);
  });

  // primary-contact-integrity spec 4.5 (P2b, Cameron 2026-10-13): only the
  // roster writes set the primary_contact scalar; a unit body carrying it is
  // refused like any other non-writable key.
  it('refuses primary_contact on create and on PATCH - 400, nothing written', async () => {
    const { app, world } = landlordHarness();
    const create = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'contact-ll-1', primary_contact: 'contact-ll-agent-7' });
    expect(create.status).toBe(400);
    expect(create.body).toEqual({ error: 'unknown field: primary_contact' });
    expect([...world.units.values()].some((u) => u.primary_contact === 'contact-ll-agent-7')).toBe(false);

    seedUnit(world, 'unit-pc');
    const patch = await request(app)
      .patch('/api/units/unit-pc')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ primary_contact: 'contact-ll-agent-7' });
    expect(patch.status).toBe(400);
    expect(patch.body).toEqual({ error: 'unknown field: primary_contact' });
    expect(world.units.get('unit-pc')?.primary_contact).toBeUndefined();
    expect(world.auditEvents).toHaveLength(0);
  });
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitFields.test.ts test/unitsApi.test.ts
```

Expected: 3 failed - `refuses primary_contact on create`, `refuses
primary_contact on update, even beside a writable field` (received
`{ ok: true, fields: ... }`) and `refuses primary_contact on create and on
PATCH - 400, nothing written` (`expected 201 to be 400`).

**Step 3 - implementation.** `app/src/lib/unitFields.ts` - Edit. old_string:

```ts
  application_process: 'string',
  primary_contact: 'string',
```

new_string:

```ts
  application_process: 'string',
  // primary_contact is deliberately NOT writable (primary-contact-integrity
  // spec 4.5, P2b): only the roster writes (unitsRepo addContact /
  // removeContact / restoreWithLandlord / handOffPrimaryFrom) set the scalar,
  // so a body carrying it is refused as an unknown field on create and PATCH.
```

**Step 4 - run GREEN.** Same command as step 2. Expected: both files pass,
0 failed.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: only the three files above are modified; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/lib/unitFields.ts app/test/unitFields.test.ts app/test/unitsApi.test.ts && git commit -m "feat(units): primary_contact is no longer writable on unit create or PATCH (P2b)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.2 - roster write contracts: new errors, handoff options, the PURE P2 decision

Files:
- Modify: `app/src/repos/unitsRepo.ts`
- Create: `app/test/unitsRepoAutoPrimaryDecision.test.ts`

DynamoDB Local: not needed (pure functions).

**Step 1 - the failing test.** Create
`app/test/unitsRepoAutoPrimaryDecision.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.4, P2): the PURE
// auto-primary decision that unitsRepo.addContact and the API-test fake
// (test/helpers/twilioWebhookHarness.ts) share - which ids a roster write for
// contact X must read for liveness, and what that read decides - plus the two
// new roster errors. No DynamoDB.
import { describe, expect, it } from 'vitest';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  autoPrimaryLivenessIds,
  decideAutoPrimary,
  PrimaryContactDeletedError,
  RosterReadFailedError,
  type AutoPrimaryArgs,
  type UnitContact,
} from '../src/repos/unitsRepo.js';

const GONE = '2026-10-01T09:00:00.000Z';

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A COMPLETE liveness read that found exactly `known` (any other id is missing). */
function readOf(...known: ContactItem[]): RosterContactsRead {
  return { ok: true, byId: new Map(known.map((c) => [c.contactId, c] as const)) };
}

function row(contactId: string, primaryContact: boolean, role: UnitContact['role'] = 'pm'): UnitContact {
  return { contactId, role, primaryContact };
}

/** A write for X = c-x: eligible, the request not asking for primary, unless overridden. */
function args(overrides: Partial<AutoPrimaryArgs> = {}): AutoPrimaryArgs {
  return { roster: [], landlordId: undefined, contactId: 'c-x', eligible: true, requested: false, ...overrides };
}

/** The writes no liveness read can change: the request's flag stands. */
const NO_READ_CASES: Array<[string, Partial<AutoPrimaryArgs>]> = [
  ['X is not eligible for automatic routing', { eligible: false }],
  ['the request already asks for primary', { requested: true }],
  ['X is itself the flagged primary', { roster: [row('c-x', true)] }],
  ['X is the landlord of record', { landlordId: 'c-x', roster: [row('c-x', false, 'landlord')] }],
];

describe('autoPrimaryLivenessIds (spec 4.4)', () => {
  it('no flagged row and no landlord of record: nothing to read', () => {
    expect(autoPrimaryLivenessIds(args({ roster: [row('c-other', false)] }))).toEqual([]);
  });

  it('reads the flagged primary and the landlord of record - each once', () => {
    expect(
      autoPrimaryLivenessIds(
        args({ roster: [row('c-ll', false, 'landlord'), row('c-dead', true)], landlordId: 'c-ll' }),
      ),
    ).toEqual(['c-dead', 'c-ll']);
    // A landlord-only unit: the derived landlord row IS the flagged primary.
    expect(autoPrimaryLivenessIds(args({ roster: [row('c-ll', true, 'landlord')], landlordId: 'c-ll' }))).toEqual([
      'c-ll',
    ]);
  });

  it.each(NO_READ_CASES)('%s: null - no read can change the answer', (_case, overrides) => {
    expect(autoPrimaryLivenessIds(args(overrides))).toBeNull();
  });
});

describe('decideAutoPrimary (spec 4.4)', () => {
  it('no flagged row and no landlord of record: promote, with no read at all', () => {
    expect(decideAutoPrimary({ ...args(), read: undefined })).toBe('promote');
  });

  it('a soft-deleted flagged primary counts as absent: promote', () => {
    const a = args({ roster: [row('c-dead', true)] });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-dead', { deleted_at: GONE })) })).toBe('promote');
  });

  it('a MISSING flagged primary (no record) counts as absent: promote', () => {
    expect(decideAutoPrimary({ ...args({ roster: [row('c-gone', true)] }), read: readOf() })).toBe('promote');
  });

  it('a soft-deleted landlord of record counts as absent: promote', () => {
    const a = args({ roster: [row('c-ll', false, 'landlord')], landlordId: 'c-ll' });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-ll', { deleted_at: GONE })) })).toBe('promote');
  });

  it('a LIVE flagged primary: keep the request flag', () => {
    const a = args({ roster: [row('c-first', true)] });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-first')) })).toBe('keep');
  });

  it('a LIVE landlord of record: keep, even beside a soft-deleted flagged primary', () => {
    const a = args({ roster: [row('c-ll', false, 'landlord'), row('c-dead', true)], landlordId: 'c-ll' });
    expect(
      decideAutoPrimary({ ...a, read: readOf(person('c-ll'), person('c-dead', { deleted_at: GONE })) }),
    ).toBe('keep');
  });

  it('a liveness read that failed, or that was not supplied, is unknown - never a promotion', () => {
    const a = args({ roster: [row('c-dead', true)] });
    expect(decideAutoPrimary({ ...a, read: { ok: false } })).toBe('unknown');
    expect(decideAutoPrimary({ ...a, read: undefined })).toBe('unknown');
  });

  it.each(NO_READ_CASES)('%s: keep, whatever the read says', (_case, overrides) => {
    expect(decideAutoPrimary({ ...args(overrides), read: { ok: false } })).toBe('keep');
    expect(decideAutoPrimary({ ...args(overrides), read: readOf() })).toBe('keep');
  });
});

describe('the new roster errors (spec 4.4, 4.6)', () => {
  it('RosterReadFailedError and PrimaryContactDeletedError are named Errors', () => {
    expect(new RosterReadFailedError()).toBeInstanceOf(Error);
    expect(new RosterReadFailedError()).toMatchObject({ name: 'RosterReadFailedError' });
    expect(new PrimaryContactDeletedError()).toBeInstanceOf(Error);
    expect(new PrimaryContactDeletedError()).toMatchObject({ name: 'PrimaryContactDeletedError' });
  });
});
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoAutoPrimaryDecision.test.ts
```

Expected: every test fails - the helpers and errors are not exported yet
(`TypeError: (0 , __vi_import_2__.autoPrimaryLivenessIds) is not a function`,
`... is not a constructor`, or a missing-export error, depending on vitest's
transform).

**Step 3 - implementation** (`app/src/repos/unitsRepo.ts`, three Edits).

(a) Imports. old_string:

```ts
import { UNIT_MEDIA_MAX } from '../lib/unitMedia.js';
import type { RepoDeps } from './conversationsRepo.js';
```

new_string:

```ts
import { UNIT_MEDIA_MAX } from '../lib/unitMedia.js';
import type { RosterContactsRead } from '../lib/propertyContact.js';
import { isDeleted as isContactDeleted } from './contactsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';
```

(b) `ContactListFacts`. old_string:

```ts
  /**
   * The contact is eligible for an AUTOMATIC routing choice - the route's one
   * rule (routes/units.ts `autoRoutingEligible`, shared with the restore's
   * sole-landlord promotion): typed landlord, not soft-deleted, not a phone or
   * email routing pointer. Only such a contact is made primary by auto-primary
   * (spec revision 6, final review A4, fix wave FWF-3; revision 5 / FW2-11
   * keyed it on the type alone).
   */
  autoPrimaryEligible: boolean;
}
```

new_string:

```ts
  /**
   * The contact is eligible for an AUTOMATIC routing choice - the one rule
   * (lib/propertyContact.ts `isAutoRoutingEligible`, shared with the heir
   * function): typed landlord, not soft-deleted, not a phone or email routing
   * pointer. Only such a contact is made primary by auto-primary
   * (caseworker-integrity spec revision 6, final review A4, fix wave FWF-3;
   * revision 5 / FW2-11 keyed it on the type alone).
   */
  autoPrimaryEligible: boolean;
  /**
   * The contact is soft-deleted (contactsRepo `isDeleted`) -
   * primary-contact-integrity spec 4.4: such a contact is never made the
   * primary unless its row already is (PrimaryContactDeletedError). Optional:
   * absent means not deleted.
   */
  contactDeleted?: boolean;
}
```

(c) After the retry constant. old_string:

```ts
const ROSTER_WRITE_MAX_ATTEMPTS = 3;
```

new_string:

```ts
const ROSTER_WRITE_MAX_ATTEMPTS = 3;

/**
 * primary-contact-integrity (spec 2026-10-12 sections 4.2 and 4.6): a roster
 * write that must hand the primary contact to an heir could not tell who is
 * live - the contacts liveness read threw or came back incomplete (either
 * shape: a raw chunk error or IncompleteBatchReadError, both of which
 * readRosterContacts answers as `{ ok: false }`), or the caller supplied no
 * read. Nothing was written. The routes map it to 503 roster_read_failed.
 */
export class RosterReadFailedError extends Error {
  constructor(message = 'could not read the property contacts to choose who takes over; nothing was changed') {
    super(message);
    this.name = 'RosterReadFailedError';
  }
}

/**
 * primary-contact-integrity (spec 2026-10-12 section 4.4): a contact-list
 * write would make a SOFT-DELETED contact the primary contact while its row
 * is not already the primary. Decided per attempt from the caller's
 * `ContactListFacts.contactDeleted`. Nothing was written. The route maps it
 * to 409 primary_contact_deleted.
 */
export class PrimaryContactDeletedError extends Error {
  constructor(message = 'a soft-deleted contact cannot be made the primary contact') {
    super(message);
    this.name = 'PrimaryContactDeletedError';
  }
}

/**
 * The liveness read for automatic primary decisions (spec 4.2): the caller
 * binds lib/propertyContact.ts readRosterContacts to its contacts repo. ONE
 * batch read with requireComplete; any failure answers `{ ok: false }`.
 */
export type ReadRosterContacts = (ids: string[]) => Promise<RosterContactsRead>;

/** A primary hand-off a roster write made, reported by that write itself so
 *  the caller can audit it (spec section 8) without a second read. */
export interface PrimaryHandoff {
  /** The contact whose primary flag went away (removed, or the old landlord). */
  from: string;
  /** The heir the write flagged primary. */
  to: string;
}

/** Options of the roster writes that can hand the primary contact off (spec 4.6). */
export interface RosterHandoffOpts {
  /**
   * The liveness read, called on EACH attempt after that attempt's consistent
   * unit read and before its conditional write (a retry reads again). Absent
   * = liveness unknown: a hand-off that needs it throws RosterReadFailedError.
   */
  readContacts?: ReadRosterContacts;
  /** Called once, after the successful write, when that write flagged an heir. */
  onPrimaryHandoff?: (handoff: PrimaryHandoff) => void;
}

/** handOffPrimaryFrom's answer (spec 4.6, contact delete). */
export type PrimaryHandOffResult =
  | { outcome: 'moved'; unit: UnitItem; to: string }
  | { outcome: 'unchanged' | 'not_primary' | 'unknown' };

/** The inputs of the P2 decision (spec 4.4), all from ONE attempt's read. */
export interface AutoPrimaryArgs {
  /** unitContacts(unit) of this attempt's read (a derived landlord row included). */
  roster: readonly UnitContact[];
  /** This attempt's non-empty landlordId, else undefined. */
  landlordId: string | undefined;
  /** X - the contact this roster write is for. */
  contactId: string;
  /** ContactListFacts.autoPrimaryEligible (the route's consistent read of X). */
  eligible: boolean;
  /** The request's own primaryContact flag. */
  requested: boolean;
}

/**
 * P2 step 1, PURE (primary-contact-integrity spec 4.4; shared by
 * unitsRepo.addContact and the API-test fake): the ids whose liveness decides
 * whether X is made the primary automatically - the flagged primary row's
 * contact and the landlord of record, each once - or null when no read can
 * change the answer: X is not eligible, the request already asks for primary,
 * X is itself the flagged primary (eligible means live, so a live primary
 * exists - an explicit `false` on X's own primary row still demotes it), or X
 * is the landlord of record (a live landlord of record). An empty list means
 * nothing is flagged and there is no landlord of record: no read is needed.
 */
export function autoPrimaryLivenessIds(args: AutoPrimaryArgs): string[] | null {
  if (!args.eligible || args.requested) return null;
  if (args.landlordId !== undefined && args.landlordId === args.contactId) return null;
  const flagged = args.roster.find((row) => row.primaryContact === true);
  if (flagged !== undefined && flagged.contactId === args.contactId) return null;
  const ids: string[] = [];
  if (flagged !== undefined) ids.push(flagged.contactId);
  if (args.landlordId !== undefined && !ids.includes(args.landlordId)) ids.push(args.landlordId);
  return ids;
}

/**
 * P2 step 2, PURE: 'promote' = X becomes the primary (on this attempt's read
 * there is no LIVE flagged primary and no LIVE landlord of record - a
 * soft-deleted or missing contact counts as absent); 'keep' = the request's
 * own flag stands; 'unknown' = the decision needed a liveness read that failed
 * or was not supplied - the write proceeds without a promotion (the route
 * WARNs). A write for X never promotes any other contact.
 */
export function decideAutoPrimary(
  args: AutoPrimaryArgs & { read: RosterContactsRead | undefined },
): 'promote' | 'keep' | 'unknown' {
  const ids = autoPrimaryLivenessIds(args);
  if (ids === null) return 'keep';
  if (ids.length === 0) return 'promote';
  const read = args.read;
  if (read === undefined || !read.ok) return 'unknown';
  const byId = read.byId;
  const anyLive = ids.some((id) => {
    const contact = byId.get(id);
    return contact !== undefined && !isContactDeleted(contact);
  });
  return anyLive ? 'keep' : 'promote';
}
```

**Step 4 - run GREEN.** Same command as step 2. Expected: all tests pass.
Also prove nothing else moved:

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: only `app/src/repos/unitsRepo.ts` modified and the new test file
untracked; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/unitsRepo.ts app/test/unitsRepoAutoPrimaryDecision.test.ts && git commit -m "feat(units): roster hand-off contracts and the pure P2 auto-primary decision" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.3 - `unitsRepo.addContact`: P2 widened (spec 4.4), stale scalar removed, the deleted-primary refusal

Files:
- Modify: `app/src/repos/unitsRepo.ts`
- Create: `app/test/unitsRepoPrimaryOnAdd.integration.test.ts`
- Modify: `app/test/unitsRepoAutoPrimary.integration.test.ts` (case (f)
  changes meaning - see step 1b)

DynamoDB Local: REQUIRED (both test files are integration suites).

**Step 1 - the failing tests.**

(a) Create `app/test/unitsRepoPrimaryOnAdd.integration.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.4, P2, Cameron
// 2026-10-13): the real unitsRepo.addContact against DynamoDB Local. A roster
// write for contact X - an add, or an edit of X's own row - makes X, and only
// X, the primary contact when X is eligible for automatic routing and the
// attempt's own read has no LIVE flagged primary and no LIVE landlord of
// record (soft-deleted or missing counts as absent; the liveness read is the
// caller's opts.readContacts, called per attempt). A soft-deleted flagged
// primary that nobody replaces keeps its flag AND the scalar; with no row
// flagged after the write a stale scalar is REMOVEd; unknown liveness writes
// unpromoted; a soft-deleted contact is never made primary unless its row
// already is (PrimaryContactDeletedError).
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  PrimaryContactDeletedError,
  type UnitContact,
  type UnitItem,
} from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[unitsRepoPrimaryOnAdd.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';
/** ContactListFacts for a live contact typed landlord (eligible for automatic routing). */
const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };
/** ...for a contact of another type (a tenant): never promoted automatically. */
const NOT_LANDLORD_FACTS = { caseworker: false, landlordTyped: false, autoPrimaryEligible: false };
/** ...for a SOFT-DELETED contact typed landlord. */
const DELETED_LANDLORD_FACTS = {
  caseworker: false,
  landlordTyped: true,
  autoPrimaryEligible: false,
  contactDeleted: true,
};

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/**
 * A liveness read (lib/propertyContact.ts RosterContactsRead) answering from
 * `known` - an id it does not know is MISSING, exactly as a complete batch
 * read of an absent contact - recording the ids of every call.
 */
function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

/** A liveness read that failed (either shape - readRosterContacts answers both as { ok: false }). */
const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.addContact - P2 widened (spec 4.4) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** An OWNERLESS unit (landlordId REMOVEd) with the given stored list and scalar. */
  async function ownerlessUnit(contacts?: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  /** A unit owned by `landlordId`, with the given stored list and scalar when supplied. */
  async function ownedUnit(landlordId: string, contacts?: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId,
      status: 'available',
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  /** A repo that counts the UpdateCommands it sends for `unitId`. */
  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  /** A repo whose FIRST read of `unitId` is followed by `race` (on the raw client). */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (!raced && command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        raced = true;
        await race();
      }
      return result;
    }) as typeof doc.send;
    return createUnitsRepo({ doc: racingDoc, env: testEnv, logger });
  }

  const primaries = (unit: UnitItem | undefined): string[] =>
    (unit?.contacts ?? []).filter((c) => c.primaryContact === true).map((c) => c.contactId);

  it('a soft-deleted flagged primary on an ownerless property: an eligible add becomes the primary, the deleted row is demoted', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-new');
    expect(liveness.calls).toEqual([['c-dead']]);
  });

  it('a flagged primary whose contact record is MISSING counts as absent', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-gone', role: 'pm', primaryContact: true }], 'c-gone');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'owner' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([]).read,
    });

    expect(primaries(updated)).toEqual(['c-new']);
    expect(updated.primary_contact).toBe('c-new');
  });

  it('a soft-deleted landlord of record and no flagged row: an eligible add becomes the primary; landlordId stays', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }]);
    const liveness = livenessFrom([person('c-ll', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(updated.landlordId).toBe('c-ll');
    expect(liveness.calls).toEqual([['c-ll']]);
  });

  it('a landlord-only unit whose landlord of record is soft-deleted: the derived landlord row is demoted, the add is the primary', async () => {
    const unitId = await ownedUnit('c-ll');
    const liveness = livenessFrom([person('c-ll', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    // The derived landlord row is BOTH the flagged primary and the landlord of record: read once.
    expect(liveness.calls).toEqual([['c-ll']]);
  });

  it('(PIN) a LIVE flagged primary: the add joins non-primary, the primary and the scalar are untouched', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-first', role: 'pm', primaryContact: true }], 'c-first');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-first')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-first', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-first');
  });

  it('(PIN) a LIVE landlord of record beside a soft-deleted flagged primary: nothing promoted - the deleted row keeps its flag AND the scalar', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
      ],
      'c-dead',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-ll'), person('c-dead', { deleted_at: GONE })]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('a contact NOT eligible for automatic routing: nobody is promoted and nothing is read - the soft-deleted primary keeps its flag and the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE })]);

    const updated = await units.addContact(unitId, { contactId: 'c-ten', role: 'other' }, NOT_LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
    expect(liveness.calls).toEqual([]);
  });

  it('a write for one contact never promotes ANOTHER - an eligible row already on the list stays non-primary', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      ],
      'c-dead',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-ten', role: 'other' }, NOT_LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-dead', { deleted_at: GONE }), person('c-eligible')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('an edit of a seated contact (a role change) on a property with a soft-deleted primary makes THAT contact the primary', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-mark', role: 'pm', primaryContact: false },
      ],
      'c-dead',
    );

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-mark', role: 'owner', primaryContact: false },
      LANDLORD_FACTS,
      { readContacts: livenessFrom([person('c-dead', { deleted_at: GONE })]).read },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-mark', role: 'owner', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-mark');
  });

  it('liveness unknown (the read failed): the add succeeds without a promotion - the deleted primary keeps its flag and the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: failedRead,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('(PIN) no readContacts supplied: main rule only - a flagged row blocks the promotion', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS);

    expect(primaries(updated)).toEqual(['c-dead']);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('no row flagged after the write: a stale primary_contact scalar is REMOVEd', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
      'c-gone',
    );

    const updated = await units.addContact(unitId, { contactId: 'c-pm', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: livenessFrom([person('c-ll')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBeUndefined();
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBeUndefined();
  });

  it('an explicit primaryContact false on the only primary row demotes it and REMOVEs the scalar', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-first', role: 'pm', primaryContact: true }], 'c-first');

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-first', role: 'pm', primaryContact: false },
      LANDLORD_FACTS,
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-first', role: 'pm', primaryContact: false }]);
    expect(updated.primary_contact).toBeUndefined();
  });

  it('a soft-deleted contact asked to be primary on a row that is not the primary: PrimaryContactDeletedError, nothing written', async () => {
    const unitId = await ownedUnit('c-ll');
    const { repo, counter } = countingRepo(unitId);

    await expect(
      repo.addContact(unitId, { contactId: 'c-dead', role: 'pm', primaryContact: true }, DELETED_LANDLORD_FACTS),
    ).rejects.toBeInstanceOf(PrimaryContactDeletedError);

    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toBeUndefined();
    expect(stored?.landlordId).toBe('c-ll');
  });

  it('a soft-deleted contact whose row IS already the primary: re-sending primaryContact true is not refused and changes nothing', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');

    const updated = await units.addContact(
      unitId,
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      DELETED_LANDLORD_FACTS,
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-dead', role: 'pm', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-dead');
  });

  it('(PIN) a soft-deleted contact added NON-primary stays allowed', async () => {
    const unitId = await ownedUnit('c-ll');

    const updated = await units.addContact(unitId, { contactId: 'c-dead', role: 'pm' }, DELETED_LANDLORD_FACTS);

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-ll');
  });

  it('the liveness read is refreshed on every attempt: a live primary that lands after attempt 1 blocks the promotion on the retry', async () => {
    const unitId = await ownerlessUnit([{ contactId: 'c-dead', role: 'pm', primaryContact: true }], 'c-dead');
    // Staff B makes c-live the primary right after attempt 1's read: attempt
    // 1 decides "promote" from its read, its write loses the roster
    // condition, and attempt 2 re-reads the unit AND the liveness.
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c, #p = :p',
          ExpressionAttributeNames: { '#c': 'contacts', '#p': 'primary_contact' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-dead', role: 'pm', primaryContact: false },
              { contactId: 'c-live', role: 'pm', primaryContact: true },
            ],
            ':p': 'c-live',
          },
        }),
      ),
    );
    const liveness = livenessFrom([person('c-dead', { deleted_at: GONE }), person('c-live')]);

    const updated = await racing.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, {
      readContacts: liveness.read,
    });

    expect(liveness.calls).toEqual([['c-dead'], ['c-live']]);
    expect(updated.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-live', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-live');
  });
});
```

(b) `app/test/unitsRepoAutoPrimary.integration.test.ts` - case (f) REVERSES
(spec 4.4: an edit of X's own row counts). Two Edits.

Header, old_string:

```ts
// - the route's `autoPrimaryEligible`, case (i)). Every other add keeps
// the request's flag: a property with a landlord of record, one with a
// primary row, and an upsert of a contact already on the list. The rule is
```

new_string:

```ts
// - the route's `autoPrimaryEligible`, case (i)). Every other add keeps
// the request's flag: a property with a landlord of record and one with a
// primary row (no liveness read is supplied here, so those are main's rule;
// unitsRepoPrimaryOnAdd.integration.test.ts covers the deleted ones). An edit
// of a contact already on the list follows the same rule as an add
// (primary-contact-integrity spec 4.4, case (f)). The rule is
```

Case (f), old_string:

```ts
  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) (PIN) an upsert of a contact already on an ownerless no-primary list (%s, primaryContact false) does NOT become primary',
    async (_kind, role) => {
      const unitId = await ownerlessUnit([{ contactId: 'c-seated', role: 'pm', primaryContact: false }]);

      const updated = await units.addContact(
        unitId,
        { contactId: 'c-seated', role, primaryContact: false },
        LANDLORD_FACTS,
      );

      expect(updated.contacts).toEqual([{ contactId: 'c-seated', role, primaryContact: false }]);
      expect(primaries(updated)).toEqual([]);
      expect(updated.primary_contact).toBeUndefined();
      // The landlord-role edit still claims the vacant slot (today's behavior);
      // the resolvers then fall back to that landlord of record.
      if (role === 'landlord') expect(updated.landlordId).toBe('c-seated');
      else expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    },
  );
```

new_string:

```ts
  // primary-contact-integrity spec 4.4 (Cameron 2026-10-13) REPLACES the old
  // pin "an upsert does NOT become primary": an edit of the contact's own row
  // counts like an add, so on an ownerless property with no primary row the
  // edited contact - eligible for automatic routing - becomes the primary.
  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) an edit of a contact already on an ownerless no-primary list (%s, primaryContact false) makes THAT contact the primary',
    async (_kind, role) => {
      const unitId = await ownerlessUnit([{ contactId: 'c-seated', role: 'pm', primaryContact: false }]);

      const updated = await units.addContact(
        unitId,
        { contactId: 'c-seated', role, primaryContact: false },
        LANDLORD_FACTS,
      );

      expect(updated.contacts).toEqual([{ contactId: 'c-seated', role, primaryContact: true }]);
      expect(primaries(updated)).toEqual(['c-seated']);
      expect(updated.primary_contact).toBe('c-seated');
      // The landlord-role edit also claims the vacant slot (unchanged).
      if (role === 'landlord') expect(updated.landlordId).toBe('c-seated');
      else expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    },
  );
```

**Step 2 - run RED.** (DynamoDB Local up; a `SKIPPED` line means it is not.)

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoPrimaryOnAdd.integration.test.ts test/unitsRepoAutoPrimary.integration.test.ts
```

Expected failures include: `a soft-deleted flagged primary on an ownerless
property...` (c-new not primary), `a soft-deleted landlord of record...`,
`a landlord-only unit whose landlord of record is soft-deleted...`, `an edit
of a seated contact...`, `no row flagged after the write: a stale
primary_contact scalar is REMOVEd` (received `'c-gone'`), `an explicit
primaryContact false ... REMOVEs the scalar`, `a soft-deleted contact asked to
be primary...` (promise resolved instead of rejecting), the refreshed-read
test, and both `(f)` cases (received `primaryContact: false`).

**Step 3 - implementation** (`app/src/repos/unitsRepo.ts`, four Edits).

(a) Interface docblock, first part. old_string:

```ts
   * This contact is primaryContact when the request asks for it, or - auto-
   * primary, caseworker-integrity spec revision 4 section 4 - when it takes a
   * NEW seat (not an upsert of a contact already on the roster) on a unit that,
   * as that attempt read it, has no primaryContact row and no `landlordId`
   * attribute, whatever its role (a role-`landlord` claim of the vacant slot
   * included), provided it is eligible for automatic routing
   * (`facts.autoPrimaryEligible`: typed landlord, not soft-deleted, not a
   * routing pointer - spec revisions 5 and 6); any other contact joins
   * non-primary. Decided inside the conditional retry loop from each
   * attempt's own read, so two racing adds never both become primary.
```

new_string:

```ts
   * This contact is primaryContact when the request asks for it, or - auto-
   * primary, caseworker-integrity spec revisions 4-6 as widened by
   * primary-contact-integrity spec 4.4 - when, as that attempt read the unit,
   * there is no LIVE flagged primary and no LIVE landlord of record (a
   * soft-deleted or missing contact counts as absent; the liveness comes from
   * `opts.readContacts`, called per attempt for exactly the flagged primary
   * and the landlordId - decideAutoPrimary), whatever its role (a
   * role-`landlord` claim of the vacant slot included) and whether it is a
   * NEW seat or an edit of its own row, provided it is eligible for automatic
   * routing (`facts.autoPrimaryEligible`: typed landlord, not soft-deleted,
   * not a routing pointer). A write for this contact never promotes another.
   * With no `opts.readContacts`, or a read that failed, liveness is unknown
   * and nothing is promoted unless no row is flagged and there is no
   * landlordId (main's rule). Decided inside the conditional retry loop from
   * each attempt's own read, so two racing writes never both promote.
   * A soft-deleted contact (`facts.contactDeleted`) asked to be primary on a
   * row that is not already the primary throws PrimaryContactDeletedError
   * (after the I4 / I3 refusals, before the reassignment refusal).
```

(b) Interface docblock, second part. old_string:

```ts
   * When the roster's primaryContact changes, the unit's `primary_contact`
   * scalar is kept consistent = the primary contact's contactId (nothing routes
   * on the scalar: the roster resolvers take the row marked primary, else the
   * landlordId - see the note above the write in the implementation).
   * Persists contacts[] + the scalar.
   */
  addContact(
```

new_string:

```ts
   * The unit's `primary_contact` scalar is kept consistent with the roster:
   * the flagged row's contactId (a soft-deleted contact still flagged
   * included - flag and scalar never split), or REMOVEd when no row is
   * flagged after the write (nothing routes on the scalar: the roster
   * resolvers take the row marked primary, else the landlordId).
   * Persists contacts[] + the scalar.
   */
  addContact(
```

(c) Interface signature. old_string:

```ts
    facts: ContactListFacts,
  ): Promise<UnitItem>;
```

new_string:

```ts
    facts: ContactListFacts,
    opts?: { readContacts?: ReadRosterContacts },
  ): Promise<UnitItem>;
```

(d) Implementation: replace the WHOLE `addContact` method of the object
returned by `createUnitsRepo` - from the line `    async addContact(unitId,
contact, facts) {` through its closing `    },` (the line before `    async
removeContact(unitId, contactId) {`). The old method contains a non-ASCII
dash in one comment, so select the region by those two marker lines in the
editor rather than retyping it. Replacement:

```ts
    async addContact(unitId, contact, facts, opts) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        // CONSISTENT (final review A7, fix wave FWF-5): the contact-list
        // refusals below are thrown on this read and write nothing, so no
        // conditional write ever confirms it - a lagging replica must not
        // refuse a state the route's own consistent read saw as allowed.
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // A sparse byLandlord GSI permits only a real string key or NO attribute;
        // ownerless therefore means landlordId is structurally absent, not an
        // empty/null/malformed value.
        const hasLandlordId = Object.prototype.hasOwnProperty.call(unit, 'landlordId');
        const landlordId =
          hasLandlordId && typeof unit.landlordId === 'string' && unit.landlordId.length > 0
            ? unit.landlordId
            : undefined;
        const claimsVacantLandlord = contact.role === 'landlord' && !hasLandlordId;
        // Seed the roster from the legacy landlordId when absent (so the primary
        // landlord is always represented), then upsert this contact by contactId.
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const existing = roster.find((c) => c.contactId === contact.contactId);
        // caseworker-integrity (spec 2026-10-12 section 4; R1 code review backend
        // finding 1, fix wave 2 FW2-1): the contact-list rules, decided again on
        // THIS attempt's read from the facts the caller read about the contact.
        // The route checks them first on its own read (the no-race answer, in
        // the spec's order); deciding them here too, where the write below is
        // conditioned on the landlordId and contacts[] this attempt read, means
        // a seat removed or a landlord cleared after the route's read is
        // refused - never re-created or claimed.
        //   I4: a caseworker never takes a NEW seat (no row for the contact).
        //   I3: claiming the vacant landlord slot needs a contact typed landlord.
        // Then primary-contact-integrity (spec 4.4): a soft-deleted contact is
        // never made the primary unless its row already is - re-sending true
        // for the current primary is never refused and changes nothing.
        if (existing === undefined && facts.caseworker) throw new ContactListCaseworkerError();
        if (claimsVacantLandlord && !facts.landlordTyped) throw new LandlordClaimNotLandlordError();
        if (
          contact.primaryContact === true &&
          facts.contactDeleted === true &&
          existing?.primaryContact !== true
        ) {
          throw new PrimaryContactDeletedError();
        }
        if (
          contact.role === 'landlord' &&
          !claimsVacantLandlord &&
          contact.contactId !== landlordId
        ) {
          throw new LandlordReassignmentRequiredError();
        }
        // Auto-primary (caseworker-integrity spec revisions 4-6, widened by
        // primary-contact-integrity spec 4.4, Cameron 2026-10-13): this write
        // for contact X - an add or an edit of X's own row - makes X, and only
        // X, the primary when X is eligible for automatic routing
        // (`facts.autoPrimaryEligible`) and THIS attempt's read has no LIVE
        // flagged primary and no LIVE landlord of record (soft-deleted or
        // missing counts as absent). The liveness is the caller's
        // `opts.readContacts`, called here - per attempt, after this attempt's
        // unit read and before its conditional write - for exactly the ids
        // autoPrimaryLivenessIds names; no read supplied, or a failed read, is
        // unknown: no promotion (the route WARNs). The decision is the shared
        // pure decideAutoPrimary (the API-test fake calls the same function).
        // The write below is conditioned on the landlordId and contacts[] this
        // attempt read, so of two racing writes only the first to commit can
        // promote; the loser re-reads and sees that primary.
        const autoArgs: AutoPrimaryArgs = {
          roster,
          landlordId,
          contactId: contact.contactId,
          eligible: facts.autoPrimaryEligible,
          requested: contact.primaryContact === true,
        };
        const livenessIds = autoPrimaryLivenessIds(autoArgs);
        const read =
          livenessIds !== null && livenessIds.length > 0 && opts?.readContacts !== undefined
            ? await opts.readContacts(livenessIds)
            : undefined;
        const decision = decideAutoPrimary({ ...autoArgs, read });
        const autoPrimary = decision === 'promote';
        // The owning landlord's role is STRUCTURAL: a row for the unit's
        // landlordId is always 'landlord', regardless of the supplied role - a
        // non-'landlord' add must never overwrite it (BE3/C3 FIX C).
        const isLandlordOfRecord =
          claimsVacantLandlord || contact.contactId === landlordId;
        const role: UnitContact['role'] = isLandlordOfRecord ? 'landlord' : contact.role;
        const next: UnitContact = {
          contactId: contact.contactId,
          role,
          primaryContact: contact.primaryContact === true || autoPrimary,
          ...(contact.name !== undefined ? { name: contact.name } : {}),
          ...(contact.company !== undefined ? { company: contact.company } : {}),
        };
        if (existing) {
          existing.role = next.role; // pinned to 'landlord' for the owning landlord
          existing.primaryContact = next.primaryContact;
          // Denormalized fields: update when supplied, preserve otherwise.
          if (contact.name !== undefined) existing.name = contact.name;
          if (contact.company !== undefined) existing.company = contact.company;
        } else {
          roster.push(next);
        }

        // EXACTLY-ONE-primaryContact: when this contact is the primary - asked for,
        // or made so by the auto-primary rule above - demote every other. When it
        // isn't, leave any existing primary as-is (a soft-deleted primary that
        // nobody replaced keeps its flag - spec 4.4).
        if (next.primaryContact) {
          for (const c of roster) c.primaryContact = c.contactId === contact.contactId;
        }

        // Keep the `primary_contact` scalar consistent with the roster's
        // primary row (nothing routes on the scalar: the roster resolvers take
        // the row marked primary, else the landlordId, and a masked call dials
        // the live thread's participants without reading the unit). With a
        // primary row - a soft-deleted contact still flagged included, so flag
        // and scalar never split (spec 4.4) - the scalar names it; with NO row
        // flagged after this write the scalar is REMOVEd (null -> REMOVE), so
        // a stale value left by an earlier demotion never lingers.
        const primary = roster.find((c) => c.primaryContact);
        const patch: Record<string, unknown> = {
          contacts: roster,
          primary_contact: primary !== undefined ? primary.contactId : null,
        };
        if (claimsVacantLandlord) patch['landlordId'] = contact.contactId;

        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch);
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          // CONSISTENT, like each attempt's read (final review round 2 R2-4):
          // the reassignment refusal below is thrown on this re-read and
          // writes nothing, so no conditional write ever confirms it.
          const current = await this.getById(unitId, { consistentRead: true });
          if (current === undefined) throw err;
          const currentHasLandlordId = Object.prototype.hasOwnProperty.call(
            current,
            'landlordId',
          );
          if (
            contact.role === 'landlord' &&
            currentHasLandlordId &&
            current.landlordId !== contact.contactId
          ) {
            throw new LandlordReassignmentRequiredError();
          }
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) {
            throw new RosterWriteConflictError();
          }
          // Ownership or contacts[] changed after our read. Re-run from the
          // current item so no concurrent roster row is lost, deciding the
          // auto-primary again on a fresh liveness read.
          return write();
        }
        log.info(
          {
            unitId,
            contactId: contact.contactId,
            rosterSize: roster.length,
            primaryContact: next.primaryContact,
            autoPrimary,
            ...(decision === 'unknown' && { autoPrimaryUnknown: true }),
          },
          'unit contact added',
        );
        return updated;
      };
      return write();
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoPrimaryOnAdd.integration.test.ts test/unitsRepoAutoPrimary.integration.test.ts test/unitsRepoRoster.integration.test.ts test/unitsRepoContactListRules.integration.test.ts
```

Expected: all pass (the last two pin that existing roster behavior is
unchanged: they supply no liveness read, so only main's rule applies).
Then:

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/repos/unitsRepo.ts` and
`app/test/unitsRepoAutoPrimary.integration.test.ts` modified, the new test
untracked; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/unitsRepo.ts app/test/unitsRepoPrimaryOnAdd.integration.test.ts app/test/unitsRepoAutoPrimary.integration.test.ts && git commit -m "feat(units): addContact auto-primary counts deleted as absent and edits of the contact's own row (P2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.4 - the contact-list add/edit route: liveness read, 409 `primary_contact_deleted`, audit `auto_on_add`; the API-test fake mirrors `addContact`

Files:
- Modify: `app/src/routes/units.ts` (three import lines + the
  `POST /:unitId/contacts` handler ONLY)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (its unitsRepo import
  block + the fake `addContact` ONLY)
- Create: `app/test/unitsApiPrimaryOnAdd.test.ts`
- Modify: `app/test/unitsApiRosterAutoPrimary.test.ts` (case (f) reverses)
- Modify: `app/test/unitsApiRoster.test.ts` (one seed line - step 1 (c))

DynamoDB Local: not needed (FakeWorld harness).

**Step 1 - the failing tests.**

(a) Create `app/test/unitsApiPrimaryOnAdd.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.4, P2, Cameron
// 2026-10-13) through POST /api/units/:id/contacts on the FakeWorld harness:
// the widened auto-primary (an add OR an edit of the contact's own row; a
// soft-deleted or missing primary / landlord of record counts as absent; a
// write never promotes another contact; unknown liveness writes unpromoted
// with a WARN), the unit_primary_contact_assigned { reason: 'auto_on_add' }
// audit row, and 409 primary_contact_deleted - ordered after the 404s and
// caseworker-integrity's I4 / I3 refusals, decided by the route AND, per
// attempt, by the roster write. The fake calls the same pure decision as the
// real repo (decideAutoPrimary).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-01T09:00:00.000Z';

/** A unit with NO landlordId attribute unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  } as UnitItem);
}

/** A contact typed landlord unless overridden. */
function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...fields } as ContactItem);
}

function addContact(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

/** The two shapes a requireComplete batch read fails in (spec 4.2). */
const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('POST /api/units/:id/contacts - auto-primary widened (spec 4.4)', () => {
  it('470 Bolton: an edit of the only contact (typed landlord) on an ownerless no-primary property makes them the primary, audited auto_on_add', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-bolton', { contacts: [{ contactId: 'c-mark', role: 'pm', primaryContact: false }] });
    seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });

    const res = await addContact(app, 'u-bolton', { contactId: 'c-mark', role: 'owner', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-bolton')?.contacts).toEqual([
      { contactId: 'c-mark', role: 'owner', primaryContact: true, name: 'Mark Passmore' },
    ]);
    expect(world.units.get('u-bolton')?.primary_contact).toBe('c-mark');
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-bolton',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: { actor: TEST_SESSION_USER.userId, contactId: 'c-mark', reason: 'auto_on_add' },
      },
    ]);
  });

  it('delete the primary, then add the replacement: the replacement is promoted (a soft-deleted flagged primary counts as absent)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-repl', {
      contacts: [{ contactId: 'c-mark', role: 'pm', primaryContact: true }],
      primary_contact: 'c-mark',
    });
    seedContact(world, 'c-mark', { deleted_at: GONE });
    seedContact(world, 'c-new');

    const res = await addContact(app, 'u-repl', { contactId: 'c-new', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-repl')?.contacts).toEqual([
      { contactId: 'c-mark', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-repl')?.primary_contact).toBe('c-new');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-new', reason: 'auto_on_add' },
    ]);
  });

  it('a soft-deleted landlord of record counts as absent: an eligible add is promoted; landlordId stays', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-dll', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
    });
    seedContact(world, 'c-ll', { deleted_at: GONE });
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-dll', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-dll')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-dll')?.primary_contact).toBe('c-pm');
    expect(world.units.get('u-dll')?.landlordId).toBe('c-ll');
  });

  it('(PIN) a LIVE landlord of record: the add joins non-primary and no auto_on_add row is written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-live', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-live', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-live')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-live')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
  });

  it('a contact NOT eligible (a tenant): nobody is promoted - the soft-deleted primary keeps its flag and the scalar', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ten', {
      contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await addContact(app, 'u-ten', { contactId: 'c-ten', role: 'other', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-ten')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(world.units.get('u-ten')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });

  it('a write for one contact never promotes another eligible contact already on the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-other', {
      contacts: [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-eligible');
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await addContact(app, 'u-other', { contactId: 'c-ten', role: 'other', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-other')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(world.units.get('u-other')?.primary_contact).toBe('c-dead');
  });

  it('reads liveness for exactly the flagged primary and the landlord of record - ONE complete batch read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ids', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-ll', { deleted_at: GONE });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-other');
    seedContact(world, 'c-new');
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    const res = await addContact(app, 'u-ids', { contactId: 'c-new', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(batchRead).toHaveBeenNthCalledWith(1, ['c-dead', 'c-ll'], { requireComplete: true });
    expect(world.units.get('u-ids')?.primary_contact).toBe('c-new');
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 200, the add joins non-primary, and the route WARNs',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedUnit(world, 'u-unknown', {
        contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
        primary_contact: 'c-dead',
      });
      seedContact(world, 'c-dead', { deleted_at: GONE });
      seedContact(world, 'c-new');
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await addContact(app, 'u-unknown', { contactId: 'c-new', role: 'pm', primaryContact: false });

      expect(res.status).toBe(200);
      expect(world.units.get('u-unknown')?.contacts).toEqual([
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-new', role: 'pm', primaryContact: false },
      ]);
      expect(world.units.get('u-unknown')?.primary_contact).toBe('c-dead');
      expect(assigned(world)).toEqual([]);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit contact add: the liveness read failed - auto-primary skipped'),
      ).toMatchObject({ unitId: 'u-unknown', contactId: 'c-new' });
    },
  );
});

describe('POST /api/units/:id/contacts - 409 primary_contact_deleted (spec 4.4)', () => {
  it('making a soft-deleted contact primary when its row is not the primary: 409 - nothing written, no audit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-409', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-dead', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-ll',
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });
    const before = structuredClone(world.units.get('u-409'));

    const res = await addContact(app, 'u-409', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-409')).toEqual(before);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('a NEW seat for a soft-deleted contact asked to be primary: 409 too', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-409b', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-409b', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-409b')?.contacts).toBeUndefined();
  });

  it('re-sending primaryContact true for a soft-deleted contact whose row IS the primary: 200, nothing changes', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-resend', {
      contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-resend', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(200);
    expect(world.units.get('u-resend')?.contacts).toEqual([{ contactId: 'c-dead', role: 'pm', primaryContact: true }]);
    expect(world.units.get('u-resend')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });

  it('(PIN) adding a soft-deleted contact NON-primary stays allowed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-np', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-np', { contactId: 'c-dead', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-np')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
    ]);
  });

  it('order: an unknown contact answers 404 contact_not_found first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord0', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');

    const res = await addContact(app, 'u-ord0', { contactId: 'c-ghost', role: 'pm', primaryContact: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
  });

  it('order: a soft-deleted caseworker taking a NEW seat answers contact_list_caseworker first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord1', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', deleted_at: GONE });

    const res = await addContact(app, 'u-ord1', { contactId: 'c-cw', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_list_caseworker' });
  });

  it('order: a soft-deleted non-landlord claiming the vacant landlord slot answers landlord_not_landlord first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord2');
    seedContact(world, 'c-ten', { type: 'tenant', deleted_at: GONE });

    const res = await addContact(app, 'u-ord2', { contactId: 'c-ten', role: 'landlord', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
  });

  it('decided again in the roster write: the primary moved off the deleted contact after the route read - 409, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-race', {
      contacts: [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-other');
    const write = world.unitsRepo.addContact.bind(world.unitsRepo);
    world.unitsRepo.addContact = async (unitId, contact, facts, opts) => {
      // Staff B makes c-other the primary after the route's reads (which saw
      // c-dead's row as the primary, so the route let the re-send through).
      const unit = world.units.get(unitId)!;
      unit.contacts = [
        { contactId: 'c-dead', role: 'pm', primaryContact: false },
        { contactId: 'c-other', role: 'pm', primaryContact: true },
      ];
      unit.primary_contact = 'c-other';
      return write(unitId, contact, facts, opts);
    };

    const res = await addContact(app, 'u-race', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-race')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-other', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-race')?.primary_contact).toBe('c-other');
    expect(world.auditEvents).toHaveLength(0);
  });
});
```

(b) `app/test/unitsApiRosterAutoPrimary.test.ts` - case (f) REVERSES. Edit,
old_string:

```ts
  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) (PIN) an upsert of a contact already on an ownerless no-primary list (%s, primaryContact false) does NOT become primary',
    async (_kind, role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-f', { contacts: [{ contactId: 'c-seated', role: 'pm', primaryContact: false }] });
      seedContact(world, 'c-seated');

      const res = await addContact(app, 'u-f', { contactId: 'c-seated', role, primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-seated', role, primaryContact: false });
      expect(res.body.unit.primary_contact).toBeUndefined();
      expect(world.units.get('u-f')?.primary_contact).toBeUndefined();
      // The landlord-role edit still claims the vacant slot (today's behavior).
      expect(hasLandlordId(world.units.get('u-f'))).toBe(role === 'landlord');
    },
  );
```

new_string:

```ts
  // primary-contact-integrity spec 4.4 (Cameron 2026-10-13) REPLACES the old
  // pin "an upsert does NOT become primary": an edit of the contact's own row
  // counts like an add - the edited contact becomes the primary and the
  // promotion is audited auto_on_add.
  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) an edit of a contact already on an ownerless no-primary list (%s, primaryContact false) makes THAT contact the primary',
    async (_kind, role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-f', { contacts: [{ contactId: 'c-seated', role: 'pm', primaryContact: false }] });
      seedContact(world, 'c-seated');

      const res = await addContact(app, 'u-f', { contactId: 'c-seated', role, primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-seated', role, primaryContact: true });
      expect(res.body.unit.primary_contact).toBe('c-seated');
      expect(world.units.get('u-f')?.primary_contact).toBe('c-seated');
      // The landlord-role edit also claims the vacant slot (unchanged).
      expect(hasLandlordId(world.units.get('u-f'))).toBe(role === 'landlord');
      expect(
        world.auditEvents
          .filter((e) => e.event_type === 'unit_primary_contact_assigned')
          .map((e) => e.payload),
      ).toEqual([expect.objectContaining({ contactId: 'c-seated', reason: 'auto_on_add' })]);
    },
  );
```

(c) `app/test/unitsApiRoster.test.ts` - the existing add test
`adds a roster contact, denormalizes name/company, and audits unit_contact_added`
seeds a unit whose landlord of record `c-ll-1` has NO contact record. Under
spec 4.4 a missing landlord of record counts as absent, so the widened P2
would make the added landlord-typed `c-pm-3` primary and the test's
`primaryContact: false` would fail (plan review R2 P9). The test means "a
property with a live landlord": seed it, exactly as Task S2.6 (b) does for its
remove test. Edit, old_string:

```ts
    seedUnit(world, 'u-3', { landlordId: 'c-ll-1' });
    seedContact(world, 'c-pm-3', { type: 'landlord', firstName: 'Pat', lastName: 'Manager', company: 'Acme PM' });
```

new_string:

```ts
    seedUnit(world, 'u-3', { landlordId: 'c-ll-1' });
    // primary-contact-integrity spec 4.4: a missing landlord of record counts
    // as absent (auto-primary would fire); this test means a LIVE landlord.
    seedContact(world, 'c-ll-1');
    seedContact(world, 'c-pm-3', { type: 'landlord', firstName: 'Pat', lastName: 'Manager', company: 'Acme PM' });
```

The test's assertions stay exactly as they are. It is GREEN before and after
this slice (it pins that a live landlord keeps P2 from firing); it is not part
of the RED list below.

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPrimaryOnAdd.test.ts test/unitsApiRosterAutoPrimary.test.ts
```

Expected failures include: `470 Bolton...` (c-mark not primary, no
assigned event), `delete the primary, then add the replacement...`, `a
soft-deleted landlord of record counts as absent...`, `reads liveness for
exactly the flagged primary...` (getManyByIds first call is the enrichment
read with no options), both `liveness unknown` cases (no WARN line), every
`409 primary_contact_deleted` case that expects 409 (received 200), and both
`(f)` cases.

**Step 3 - implementation.**

(a) `app/src/routes/units.ts` - unitsRepo import. old_string:

```ts
  LandlordReassignmentRequiredError,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
  LandlordReassignmentRequiredError,
  PrimaryContactDeletedError,
  RosterWriteConflictError,
  unitContacts,
```

(b) `app/src/routes/units.ts` - contactsRepo import. Make the block that
imports from `'../repos/contactsRepo.js'` read EXACTLY as below (S1 may have
dropped the `isDeleted as isContactDeleted` line when it moved
`autoRoutingEligible` out; this task uses it again):

```ts
import {
  createContactsRepo,
  isDeleted as isContactDeleted,
  type ContactItem,
  type ContactsRepo,
  type RecipientDisplay,
} from '../repos/contactsRepo.js';
```

(c) `app/src/routes/units.ts` - the propertyContact import S1 added (ruling
R2: S1 imports it under the ALIAS `autoRoutingEligible`; this task's region
replacements below remove every aliased call, so the alias goes). old_string
(exactly what S1's Task S1.4 Edit B wrote):

```ts
// The ONE automatic-routing eligibility rule lives in lib/propertyContact.ts
// (primary-contact-integrity spec 4.3), shared with the heir function. It is
// imported under its old local name so every call site below reads as before.
import { isAutoRoutingEligible as autoRoutingEligible } from '../lib/propertyContact.js';
```

new_string (the alias STAYS until Task S2.8 deletes `soleLandlordToPromote`,
its last caller - dropping it here would break the build between S2.4 and
S2.8):

```ts
// The ONE automatic-routing eligibility rule lives in lib/propertyContact.ts
// (primary-contact-integrity spec 4.3), shared with the heir function.
import {
  isAutoRoutingEligible,
  isAutoRoutingEligible as autoRoutingEligible,
  readRosterContacts,
} from '../lib/propertyContact.js';
```

(d) `app/src/routes/units.ts` - replace the WHOLE add handler together with
the comment block above it: from the comment line that begins
`  // POST /api/units/:unitId/contacts { contactId, role, primaryContact? } (BE3/C3).`
through the handler's closing `  });` (the line before the comment line that
begins `  // DELETE /api/units/:unitId/contacts/:contactId (BE3/C3)`). The old
region contains non-ASCII arrows/dashes in comments, so select it by those
marker lines. Replacement:

```ts
  // POST /api/units/:unitId/contacts { contactId, role, primaryContact? } (BE3/C3).
  // Add (or update) a roster contact -> { unit } (with contacts). The ROUTE
  // resolves the contact's denormalized name/company (so the roster row is
  // self-describing); the repo maintains the single-primaryContact invariant and
  // keeps the primary_contact scalar consistent with the row marked primary
  // (nothing routes on the scalar: the roster resolvers take the row marked
  // primary, else the landlord of record - see unitsRepo.addContact).
  // Auto-primary (caseworker-integrity spec revisions 4-6, widened by
  // primary-contact-integrity spec 4.4, Cameron 2026-10-13): a write for
  // contact X - an add, or an edit of X's own row - makes X, and only X, the
  // primary contact when X is eligible for automatic routing
  // (isAutoRoutingEligible) and the property has no LIVE flagged primary and
  // no LIVE landlord of record on the roster write's own read (soft-deleted or
  // missing counts as absent). The liveness read is ONE complete batch read per
  // attempt (readRosterContacts), passed to the repo; when it fails the write
  // succeeds unpromoted and this route WARNs. An automatic promotion also
  // appends unit_primary_contact_assigned { reason: 'auto_on_add' }. A
  // Landlord role claims an ownerless legacy property. 409
  // contact_list_caseworker (a caseworker taking a NEW seat), 409
  // landlord_not_landlord (a claim of the vacant landlord slot by a contact
  // not typed landlord) and 409 primary_contact_deleted (primaryContact true
  // for a soft-deleted contact whose row is not already the primary), in that
  // order, each from the route's checks below or from the roster write
  // itself; 409 landlord_reassignment_required when a different owner already
  // exists, or unit_roster_conflict after repeated write races. 404
  // unit_not_found (unknown/disappeared unit) or contact_not_found (a missing
  // contact, or the id of a phone or email routing pointer); 400 bad role /
  // primaryContact; audit unit_contact_added after successful writes only.
  router.post('/:unitId/contacts', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const contactId = b['contactId'];
    if (typeof contactId !== 'string' || contactId.length === 0) {
      res.status(400).json({ error: 'contactId is required' });
      return;
    }
    const role = b['role'];
    if (!isUnitContactRole(role)) {
      res.status(400).json({ error: `role must be one of: ${UNIT_CONTACT_ROLES.join(', ')}` });
      return;
    }
    const primaryContactRaw = b['primaryContact'];
    if (primaryContactRaw !== undefined && typeof primaryContactRaw !== 'boolean') {
      res.status(400).json({ error: 'primaryContact must be a boolean' });
      return;
    }
    const primaryContact = primaryContactRaw === true;

    // The unit must exist (404). We check up-front so an unknown unit is a clean
    // 404 distinct from the unknown-contact 404 below. caseworker-integrity
    // (spec 2026-10-12 section 4): the seat and claim checks below decide from
    // THIS read, so it is consistent.
    const unit = await units.getById(unitId, { consistentRead: true });
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    // Resolve the contact for denormalization (404 when the contact doesn't
    // exist - never roster a phantom). name/company are best-effort honest:
    // omitted when unknown, never invented. A phone or email ROUTING POINTER
    // row (contactsRepo.ts `phone_ref` / `email_ref`: a routing record, never
    // a contact) does not exist as a contact here either - the codebase's own
    // pointer test, as in services/contactTypeGuards.ts (R2 code review finding
    // A3, fix wave 2 FW2-3).
    const contact = await contacts.getById(contactId, { consistentRead: true });
    if (!contact || contact.phone_ref === true || contact.email_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // caseworker-integrity (spec 2026-10-12 section 4), then
    // primary-contact-integrity (spec 4.4), in this order and all before the
    // repo call; the repo's own 409 landlord_reassignment_required follows.
    // Decided from the consistent reads above with the repo's own definitions
    // (unitsRepo.addContact): a SEAT is a row of unitContacts(unit) (the
    // landlord of record included); a CLAIM is a role-landlord add on a unit
    // with no landlordId attribute.
    //   I4: a caseworker never takes a NEW seat, whatever the role. A seat they
    //       already hold stays editable (L2).
    //   I3: claiming the vacant landlord slot needs a contact typed `landlord`.
    //       Re-asserting the existing owner is not a claim and is not checked.
    //   P2: a soft-deleted contact is never MADE the primary - primaryContact
    //       true for a row that is not already the primary. Re-sending true
    //       for the current primary is never refused (the dashboard's re-role
    //       sends the row's own flag); adding a deleted contact non-primary
    //       stays allowed.
    // These answer the common, no-race case. addContact decides all three again
    // on each attempt's own read from the facts passed below (fix wave 2
    // FW2-1), so a change landing after THIS read answers the same 409s.
    const seated = unitContacts(unit).some((row) => row.contactId === contactId);
    if (!seated && isCaseworker(contact)) {
      log.info({ unitId, contactId, actor: req.user?.userId }, 'unit contact refused: a caseworker cannot take a new seat');
      res.status(409).json({ error: 'contact_list_caseworker' });
      return;
    }
    const claimsVacantLandlord =
      role === 'landlord' && !Object.prototype.hasOwnProperty.call(unit, 'landlordId');
    if (claimsVacantLandlord && contact.type !== 'landlord') {
      log.info({ unitId, contactId, actor: req.user?.userId }, 'unit contact refused: a landlord claim by a non-landlord');
      res.status(409).json({ error: 'landlord_not_landlord' });
      return;
    }
    const contactDeleted = isContactDeleted(contact);
    const alreadyPrimary = unitContacts(unit).some(
      (row) => row.contactId === contactId && row.primaryContact === true,
    );
    if (primaryContact && contactDeleted && !alreadyPrimary) {
      log.info(
        { unitId, contactId, actor: req.user?.userId },
        'unit contact refused: a soft-deleted contact cannot be made the primary',
      );
      res.status(409).json({ error: 'primary_contact_deleted' });
      return;
    }
    const name = displayNameOfContact(contact);
    const company = typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;

    let updated: UnitItem;
    try {
      updated = await units.addContact(
        unitId,
        {
          contactId,
          role,
          primaryContact,
          ...(name !== undefined && { name }),
          ...(company !== undefined && { company }),
        },
        {
          caseworker: isCaseworker(contact),
          landlordTyped: contact.type === 'landlord',
          autoPrimaryEligible: isAutoRoutingEligible(contact),
          contactDeleted,
        },
        {
          // P2's liveness read (spec 4.2): ONE complete batch read of the ids
          // the repo names (the flagged primary and the landlord of record),
          // per attempt. A failure is unknown liveness: the repo writes
          // unpromoted, and this is the WARN the spec asks for.
          readContacts: async (ids) => {
            const read = await readRosterContacts(contacts, ids, log);
            if (!read.ok) {
              log.warn(
                { unitId, contactId, actor: req.user?.userId },
                'unit contact add: the liveness read failed - auto-primary skipped',
              );
            }
            return read;
          },
        },
      );
    } catch (err) {
      if (err instanceof ContactListCaseworkerError) {
        log.info(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact refused at the roster write: a caseworker cannot take a new seat',
        );
        res.status(409).json({ error: 'contact_list_caseworker' });
        return;
      }
      if (err instanceof LandlordClaimNotLandlordError) {
        log.info(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact refused at the roster write: a landlord claim by a non-landlord',
        );
        res.status(409).json({ error: 'landlord_not_landlord' });
        return;
      }
      if (err instanceof PrimaryContactDeletedError) {
        log.info(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact refused at the roster write: a soft-deleted contact cannot be made the primary',
        );
        res.status(409).json({ error: 'primary_contact_deleted' });
        return;
      }
      if (err instanceof LandlordReassignmentRequiredError) {
        res.status(409).json({ error: 'landlord_reassignment_required' });
        return;
      }
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    // The EFFECTIVE primary flag, read from the written unit (R2 code review
    // finding A1, fix wave 2 FW2-2): auto-primary can make the contact primary
    // although the request said false (every dashboard add does), so the
    // durable record states what the write did, and `autoPrimary` says the
    // rule - not the request - did it. That same derivation, from the write's
    // own result, drives unit_primary_contact_assigned { reason: 'auto_on_add' }
    // (primary-contact-integrity spec section 8; plan contract 2.4): only the
    // auto rule can make X primary when the request did not ask.
    const effectivePrimary = (updated.contacts ?? []).some(
      (row) => row.contactId === contactId && row.primaryContact === true,
    );
    const autoPrimary = effectivePrimary && !primaryContact;
    await audit.append(`units#${unitId}`, 'unit_contact_added', {
      actor: req.user?.userId,
      contactId,
      role,
      primaryContact: effectivePrimary,
      ...(autoPrimary && { autoPrimary: true }),
    });
    if (autoPrimary) {
      await audit.append(`units#${unitId}`, 'unit_primary_contact_assigned', {
        actor: req.user?.userId,
        contactId,
        reason: 'auto_on_add',
      });
    }
    log.info(
      {
        unitId,
        contactId,
        role,
        primaryContact: effectivePrimary,
        ...(autoPrimary && { autoPrimary: true }),
        actor: req.user?.userId,
      },
      'unit contact added via api',
    );
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
  });
```

(e) `app/test/helpers/twilioWebhookHarness.ts` - unitsRepo import. old_string:

```ts
import {
  CannotRemoveLandlordOfRecordError,
  ContactListCaseworkerError,
  isDeleted as isUnitDeleted,
  LandlordClaimNotLandlordError,
  LandlordReassignmentRequiredError,
  type ListUnitsOpts,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
import {
  autoPrimaryLivenessIds,
  CannotRemoveLandlordOfRecordError,
  ContactListCaseworkerError,
  decideAutoPrimary,
  isDeleted as isUnitDeleted,
  LandlordClaimNotLandlordError,
  LandlordReassignmentRequiredError,
  type ListUnitsOpts,
  PrimaryContactDeletedError,
  RosterWriteConflictError,
  unitContacts,
```

(f) `app/test/helpers/twilioWebhookHarness.ts` - replace the WHOLE fake
`addContact` method of the `unitsRepo` object: from the line `    async
addContact(unitId, contact, facts) {` through its closing `    },` (the line
before `    async removeContact(unitId, contactId) {`). The old method has a
non-ASCII dash in one comment; select by the marker lines. Replacement:

```ts
    async addContact(unitId, contact, facts, opts) {
      // Mirror the real repo's invariants: seed from landlordId, upsert by
      // contactId, the contact-list rules on this read (I4, I3, the
      // soft-deleted-primary refusal, the reassignment refusal - in the real
      // repo's order), auto-primary through the SAME pure decision
      // (autoPrimaryLivenessIds / decideAutoPrimary, primary-contact-integrity
      // spec 4.4; liveness from the caller's opts.readContacts),
      // exactly-one-primaryContact, and the primary_contact scalar: the
      // flagged row's id, else REMOVEd.
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`addContact: no unit ${unitId}`);
      const hasLandlordId = Object.prototype.hasOwnProperty.call(unit, 'landlordId');
      const landlordId =
        hasLandlordId && typeof unit.landlordId === 'string' && unit.landlordId.length > 0
          ? unit.landlordId
          : undefined;
      const claimsVacantLandlord = contact.role === 'landlord' && !hasLandlordId;
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const existing = roster.find((c) => c.contactId === contact.contactId);
      if (existing === undefined && facts.caseworker) throw new ContactListCaseworkerError();
      if (claimsVacantLandlord && !facts.landlordTyped) throw new LandlordClaimNotLandlordError();
      if (
        contact.primaryContact === true &&
        facts.contactDeleted === true &&
        existing?.primaryContact !== true
      ) {
        throw new PrimaryContactDeletedError();
      }
      if (
        contact.role === 'landlord' &&
        !claimsVacantLandlord &&
        contact.contactId !== landlordId
      ) {
        throw new LandlordReassignmentRequiredError();
      }
      const autoArgs = {
        roster,
        landlordId,
        contactId: contact.contactId,
        eligible: facts.autoPrimaryEligible,
        requested: contact.primaryContact === true,
      };
      const livenessIds = autoPrimaryLivenessIds(autoArgs);
      const read =
        livenessIds !== null && livenessIds.length > 0 && opts?.readContacts !== undefined
          ? await opts.readContacts(livenessIds)
          : undefined;
      const autoPrimary = decideAutoPrimary({ ...autoArgs, read }) === 'promote';
      const primaryContact = contact.primaryContact === true || autoPrimary;
      // FIX C: the owning landlord's role is structural - pinned to 'landlord'.
      const isLandlordOfRecord =
        claimsVacantLandlord || contact.contactId === landlordId;
      const role: UnitContact['role'] = isLandlordOfRecord ? 'landlord' : contact.role;
      if (existing) {
        existing.role = role;
        existing.primaryContact = primaryContact;
        if (contact.name !== undefined) existing.name = contact.name;
        if (contact.company !== undefined) existing.company = contact.company;
      } else {
        const entry: UnitContact = {
          contactId: contact.contactId,
          role,
          primaryContact,
          ...(contact.name !== undefined ? { name: contact.name } : {}),
          ...(contact.company !== undefined ? { company: contact.company } : {}),
        };
        roster.push(entry);
      }
      if (primaryContact) {
        for (const c of roster) c.primaryContact = c.contactId === contact.contactId;
      }
      unit.contacts = roster;
      if (claimsVacantLandlord) unit.landlordId = contact.contactId;
      const primary = roster.find((c) => c.primaryContact);
      if (primary !== undefined) unit.primary_contact = primary.contactId;
      else delete unit.primary_contact; // null -> REMOVE, exactly as the real repo
      unit.updated_at = new Date().toISOString();
      return unit;
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPrimaryOnAdd.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsApiRoster.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiActivity.test.ts test/unitsRestoreLandlord.test.ts test/placementsVoiceRouting.test.ts
```

Expected: all pass (the last five are neighbors that drive the same route or
the fake's `addContact`).

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/routes/units.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/unitsApiRosterAutoPrimary.test.ts` and `app/test/unitsApiRoster.test.ts`
modified, the new test untracked; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsApiPrimaryOnAdd.test.ts app/test/unitsApiRosterAutoPrimary.test.ts app/test/unitsApiRoster.test.ts && git commit -m "feat(units): contact-list add reads liveness for auto-primary, refuses a deleted primary (409), audits auto_on_add" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.5 - `unitsRepo.removeContact`: the heir function, `RosterReadFailedError`, consistent reads

Files:
- Modify: `app/src/repos/unitsRepo.ts`
- Create: `app/test/unitsRepoPrimaryOnRemove.integration.test.ts`
- Modify: `app/test/unitsRepoRoster.integration.test.ts` (three removeContact
  tests now pass a liveness read - see step 1b)

DynamoDB Local: REQUIRED.

**Step 1 - the failing tests.**

(a) Create `app/test/unitsRepoPrimaryOnRemove.integration.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Remove from the
// property"): the real unitsRepo.removeContact against DynamoDB Local.
// Removing the PRIMARY row hands the primary to the heir function's pick
// (lib/propertyContact.ts chooseHeir, the removed contact EXCLUDED): the live
// landlord of record - its row ADDED as primary when it has none - else the
// earliest-added remaining contact eligible for automatic routing; no heir
// clears every flag and REMOVEs the scalar. The liveness read is the caller's
// opts.readContacts, called per attempt after a CONSISTENT unit read; a failed
// read (or none supplied) is RosterReadFailedError and nothing is written.
// Removing a non-primary row reads nothing. opts.onPrimaryHandoff reports a
// hand-off once, after the write.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  RosterReadFailedError,
  type PrimaryHandoff,
  type UnitContact,
} from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[unitsRepoPrimaryOnRemove.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A liveness read answering from `known` (any other id is missing), recording each call's ids. */
function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.removeContact - the heir function (spec 4.6) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function ownerlessUnit(contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  async function ownedUnit(landlordId: string, contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId,
      status: 'available',
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  /** A repo whose FIRST read of `unitId` is followed by `race`; records every unit read's ConsistentRead. */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    const counter = { unitReads: [] as Array<boolean | undefined> };
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        counter.unitReads.push(command.input.ConsistentRead);
        if (!raced) {
          raced = true;
          await race();
        }
      }
      return result;
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: racingDoc, env: testEnv, logger }), counter };
  }

  it('the live landlord of record takes over - flag and scalar - and onPrimaryHandoff reports it once', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const liveness = livenessFrom([person('c-ll'), person('c-pm')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: liveness.read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-ll');
    expect(handoffs).toEqual([{ from: 'c-pm', to: 'c-ll' }]);
    // The removed contact is excluded, never asked about.
    expect(liveness.calls.flat()).not.toContain('c-pm');
  });

  it('an off-roster landlord of record takes over: a landlord row is ADDED as the primary', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-pm', role: 'pm', primaryContact: true }], 'c-pm');

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ll')]).read,
    });

    expect(updated.contacts).toHaveLength(1);
    expect(updated.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(updated.primary_contact).toBe('c-ll');
  });

  it('no landlord of record: the EARLIEST-added remaining eligible contact takes over - a tenant, a soft-deleted landlord-typed contact and a caseworker are skipped', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: false },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-late', role: 'pm', primaryContact: false },
      ],
      'c-pm',
    );
    const liveness = livenessFrom([
      person('c-ten', { type: 'tenant' }),
      person('c-gone', { deleted_at: GONE }),
      person('c-cw', { type: 'partner', role: 'Caseworker' }),
      person('c-own'),
      person('c-late'),
    ]);

    const updated = await units.removeContact(unitId, 'c-pm', { readContacts: liveness.read });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'pm', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-late', role: 'pm', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-own');
  });

  it('a soft-deleted landlord of record is skipped for the earliest eligible roster contact; landlordId stays', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-pm',
    );

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ll', { deleted_at: GONE }), person('c-own')]).read,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-own');
    expect(updated.landlordId).toBe('c-ll');
  });

  it('no heir (nobody eligible left): every flag cleared, the scalar REMOVEd, no hand-off reported', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.removeContact(unitId, 'c-pm', {
      readContacts: livenessFrom([person('c-ten', { type: 'tenant' })]).read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([{ contactId: 'c-ten', role: 'other', primaryContact: false }]);
    expect(updated.primary_contact).toBeUndefined();
    expect(handoffs).toEqual([]);
  });

  const UNKNOWN_READS: Array<[string, ((ids: string[]) => Promise<RosterContactsRead>) | undefined]> = [
    ['the read failed', failedRead],
    ['no read was supplied', undefined],
  ];
  it.each(UNKNOWN_READS)('liveness unknown (%s): RosterReadFailedError - nothing written', async (_case, read) => {
    const roster: UnitContact[] = [
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ];
    const unitId = await ownedUnit('c-ll', roster, 'c-pm');
    const { repo, counter } = countingRepo(unitId);

    await expect(
      repo.removeContact(unitId, 'c-pm', read === undefined ? undefined : { readContacts: read }),
    ).rejects.toBeInstanceOf(RosterReadFailedError);

    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
    expect(stored?.primary_contact).toBe('c-pm');
  });

  it('(PIN) removing a NON-primary row reads no liveness - it succeeds even with a read that would fail', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-ll',
    );
    let reads = 0;
    const counted = async (): Promise<RosterContactsRead> => {
      reads += 1;
      return { ok: false };
    };

    const updated = await units.removeContact(unitId, 'c-pm', { readContacts: counted });

    expect(updated.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-ll');
    expect(reads).toBe(0);
  });

  it('(PIN) every attempt reads the unit CONSISTENTLY, and a retry decides the heir again on its own read', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-pm',
    );
    // Staff B's write lands right after attempt 1's read: c-first is now the
    // earliest-added row. Attempt 1 decides c-own, its write loses the roster
    // condition, and attempt 2 re-reads and decides c-first.
    const { repo, counter } = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c',
          ExpressionAttributeNames: { '#c': 'contacts' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-first', role: 'owner', primaryContact: false },
              { contactId: 'c-pm', role: 'pm', primaryContact: true },
              { contactId: 'c-own', role: 'owner', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const liveness = livenessFrom([person('c-first'), person('c-own')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await repo.removeContact(unitId, 'c-pm', {
      readContacts: liveness.read,
      onPrimaryHandoff: (handoff) => {
        handoffs.push(handoff);
      },
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-first', role: 'owner', primaryContact: true },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-first');
    expect(liveness.calls).toHaveLength(2);
    expect(handoffs).toEqual([{ from: 'c-pm', to: 'c-first' }]);
    expect(counter.unitReads.length).toBeGreaterThanOrEqual(2);
    expect(counter.unitReads.every((consistent) => consistent === true)).toBe(true);
  });
});
```

(b) `app/test/unitsRepoRoster.integration.test.ts` - its three
removeContact-of-the-primary tests now pass a liveness read (the heir needs
one; without it the removal is refused). Three Edits.

Imports, old_string:

```ts
import { CannotRemoveLandlordOfRecordError, createUnitsRepo } from '../src/repos/unitsRepo.js';
```

new_string:

```ts
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { CannotRemoveLandlordOfRecordError, createUnitsRepo } from '../src/repos/unitsRepo.js';
```

Helpers, old_string:

```ts
describe.skipIf(!reachable)('unitsRepo roster + property (BE3) against DynamoDB Local', () => {
```

new_string:

```ts
/**
 * primary-contact-integrity (spec 4.6): removing the primary runs the heir
 * function, which needs a liveness read. These answer every id as a live
 * contact typed landlord (the landlord of record takes over, as before) or
 * as a live tenant (nobody is eligible: every flag cleared, as before).
 */
const EVERYONE_LIVE_LANDLORD = async (ids: string[]): Promise<RosterContactsRead> => ({
  ok: true,
  byId: new Map(ids.map((id) => [id, { contactId: id, type: 'landlord' } as ContactItem] as const)),
});
const EVERYONE_LIVE_TENANT = async (ids: string[]): Promise<RosterContactsRead> => ({
  ok: true,
  byId: new Map(ids.map((id) => [id, { contactId: id, type: 'tenant' } as ContactItem] as const)),
});

describe.skipIf(!reachable)('unitsRepo roster + property (BE3) against DynamoDB Local', () => {
```

The three tests: replace the contiguous region from the line that begins
`  it('removeContact removes a non-landlord and falls the scalar back to
landlordId when it was the` through the closing `  });` of the test whose
title begins `  it('removeContact of the` and contains `with NO landlordId
clears the scalar (no dangling)` (the line before `  it('addContact pins the
owning landlord row to role:landlord`). The old titles contain a non-ASCII
phone glyph; select the region by those marker lines. Replacement:

```ts
  it('removeContact of the primary pm hands the primary back to the live landlord of record (flag and scalar)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-4', status: 'available' });
    await units.addContact(unit.unitId, { contactId: 'c-pm-4', role: 'pm', primaryContact: true }, LANDLORD_FACTS);
    const removed = await units.removeContact(unit.unitId, 'c-pm-4', { readContacts: EVERYONE_LIVE_LANDLORD });
    expect((removed.contacts ?? []).map((c) => c.contactId)).toEqual(['c-ll-4']);
    // The removed contact was the primary -> the live landlord of record takes over.
    expect(removed.primary_contact).toBe('c-ll-4');
  });

  it('removeContact of the primary pm: exactly one primaryContact (the landlord) AND scalar === landlordId (FIX B)', async () => {
    const unit = await units.create({ landlordId: 'c-ll-b1', status: 'available' });
    // pm becomes the primary (landlord demoted to primaryContact:false).
    await units.addContact(unit.unitId, { contactId: 'c-pm-b1', role: 'pm', primaryContact: true }, LANDLORD_FACTS);
    const removed = await units.removeContact(unit.unitId, 'c-pm-b1', { readContacts: EVERYONE_LIVE_LANDLORD });
    const roster = removed.contacts ?? [];
    // Exactly one primaryContact - the landlord - and the scalar AGREES.
    const primaries = roster.filter((c) => c.primaryContact);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.contactId).toBe('c-ll-b1');
    expect(removed.primary_contact).toBe('c-ll-b1');
  });

  it('removeContact of the primary with NO landlordId and no eligible contact left clears every flag and REMOVEs the scalar (FIX B)', async () => {
    // A landlord-less unit. landlordId is the byLandlord GSI hash key, so an
    // empty string is illegal at write time - create with a real landlordId,
    // then REMOVE it (null -> REMOVE) to reach the no-landlord state, then seed
    // the roster + the primary scalar.
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    const unit = await units.update(created.unitId, {
      landlordId: null,
      contacts: [
        { contactId: 'c-a', role: 'owner', primaryContact: false },
        { contactId: 'c-b', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-b',
    });
    expect(unit.landlordId).toBeUndefined();
    // c-a is a live TENANT: not eligible for automatic routing, so no heir.
    const removed = await units.removeContact(unit.unitId, 'c-b', { readContacts: EVERYONE_LIVE_TENANT });
    const roster = removed.contacts ?? [];
    expect(roster.map((c) => c.contactId)).toEqual(['c-a']);
    // No heir -> no primaryContact and the scalar is CLEARED (not left
    // dangling at the removed contact).
    expect(roster.filter((c) => c.primaryContact)).toHaveLength(0);
    expect(removed.primary_contact).toBeUndefined();
  });
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoPrimaryOnRemove.integration.test.ts test/unitsRepoRoster.integration.test.ts
```

Expected failures (new file): `an off-roster landlord of record takes over`
(the old code flags only an EXISTING landlord row, so `contacts` has length
0), `no landlord of record: the EARLIEST-added...` (the old code clears every
flag), `a soft-deleted landlord of record is skipped...` (the old code
promotes c-ll), both `liveness unknown` cases (resolved instead of
rejecting), the first test (`handoffs` stays empty) and the retry test
(`liveness.calls` has length 0). The three edited unitsRepoRoster tests PASS
already (the old code ignores the new options and gives the same answers).

**Step 3 - implementation** (`app/src/repos/unitsRepo.ts`).

(a) Imports: the propertyContact import becomes a runtime import. old_string:

```ts
import type { RosterContactsRead } from '../lib/propertyContact.js';
```

new_string:

```ts
import {
  applyPrimary,
  chooseHeir,
  rosterContactIds,
  type RosterContactsRead,
} from '../lib/propertyContact.js';
```

(b) Interface docblock + signature. old_string:

```ts
  /**
   * BE3/C3: remove a contact from the unit's roster. REJECTS removing the
   * LANDLORD OF RECORD (contactId === unit.landlordId) with
   * CannotRemoveLandlordOfRecordError (route 409). A contact not on the roster
   * throws ConditionalCheckFailedException (route 404). When the removed contact
   * was the current primaryContact, the roster flag and the `primary_contact`
   * scalar are kept in AGREEMENT: with a `landlordId`, the landlord row is
   * promoted to the lone primaryContact and the scalar points at it; with NO
   * `landlordId`, both are cleared (the scalar is REMOVEd, never left dangling at
   * the removed contact, and no row stays primaryContact). Persists contacts[] +
   * the scalar. Uses the same bounded optimistic roster guard as addContact.
   * Returns the unit.
   */
  removeContact(unitId: string, contactId: string): Promise<UnitItem>;
```

new_string:

```ts
  /**
   * BE3/C3: remove a contact from the unit's roster. REJECTS removing the
   * LANDLORD OF RECORD (contactId === unit.landlordId) with
   * CannotRemoveLandlordOfRecordError (route 409). A contact not on the roster
   * throws ConditionalCheckFailedException (route 404). When the removed
   * contact was the current primaryContact (primary-contact-integrity spec
   * 4.6), the heir function (lib/propertyContact.ts chooseHeir, the removed
   * contact excluded) picks who takes over - the live landlord of record (its
   * row added as primary when it has none), else the earliest-added remaining
   * contact eligible for automatic routing - and the roster flag and the
   * `primary_contact` scalar move to it together; with no heir every flag is
   * cleared and the scalar REMOVEd (never left dangling at the removed
   * contact). The liveness comes from `opts.readContacts`, called per attempt
   * after a CONSISTENT unit read; a failed read or none supplied throws
   * RosterReadFailedError and writes nothing (route 503 roster_read_failed).
   * Removing a non-primary row reads nothing. `opts.onPrimaryHandoff` is
   * called once after the write when an heir was flagged. Persists
   * contacts[] + the scalar. Uses the same bounded optimistic roster guard as
   * addContact. Returns the unit.
   */
  removeContact(unitId: string, contactId: string, opts?: RosterHandoffOpts): Promise<UnitItem>;
```

(c) Implementation: replace the WHOLE `removeContact` method of the object
returned by `createUnitsRepo` - from the line `    async
removeContact(unitId, contactId) {` through its closing `    },` (the line
before `    async appendMedia(unitId, keys, cap = UNIT_MEDIA_MAX) {`). The old
method has non-ASCII glyphs in comments; select it by the marker lines.
Replacement:

```ts
    async removeContact(unitId, contactId, opts) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        // CONSISTENT (primary-contact-integrity spec 4.2): the heir below is
        // decided on this read, and the conditional write is fenced on it.
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // The landlord of record (legacy landlordId) must remain in the roster -
        // reassign landlordId first (typed error -> route 409).
        if (typeof unit.landlordId === 'string' && unit.landlordId === contactId) {
          throw new CannotRemoveLandlordOfRecordError();
        }
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const target = roster.find((c) => c.contactId === contactId);
        if (!target) {
          // Not on the roster (route 404). Mirrors the contacts removePhone 404.
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} has no roster contact ${contactId}`,
            $metadata: {},
          });
        }
        const removedWasPrimaryContact = target.primaryContact;
        const remaining = roster.filter((c) => c.contactId !== contactId);
        const patch: Record<string, unknown> = { contacts: remaining };
        let heirId: string | undefined;
        // Removing the PRIMARY row (primary-contact-integrity spec 4.6): the
        // heir function picks who takes over, the removed contact EXCLUDED -
        // the live landlord of record (its row added as primary when it has
        // none), else the earliest-added remaining contact eligible for
        // automatic routing - and applyPrimary flags exactly that row and sets
        // the scalar to it, keeping flag and scalar in AGREEMENT (BE3/C3 FIX
        // B); no heir clears every flag and REMOVEs the scalar. The liveness is
        // the caller's `opts.readContacts`, called on THIS attempt after its
        // consistent unit read (a retry reads again); a failed read - or none
        // supplied - is unknown: refused with RosterReadFailedError and nothing
        // written. Removing a non-primary row needs no liveness.
        if (removedWasPrimaryContact) {
          const landlordOfRecord =
            typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
          const read: RosterContactsRead =
            opts?.readContacts !== undefined
              ? await opts.readContacts(rosterContactIds(unit).filter((id) => id !== contactId))
              : { ok: false };
          const heir = chooseHeir({ roster, landlordId: landlordOfRecord, exclude: contactId, read });
          if (heir.kind === 'unknown') throw new RosterReadFailedError();
          const applied = applyPrimary(
            remaining,
            heir.kind === 'heir' ? { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow } : null,
          );
          patch['contacts'] = applied.contacts;
          patch['primary_contact'] = applied.primaryContactScalar;
          heirId = heir.kind === 'heir' ? heir.contactId : undefined;
        }

        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch);
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          const current = await this.getById(unitId, { consistentRead: true });
          if (current === undefined) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) {
            throw new RosterWriteConflictError();
          }
          // Ownership or contacts[] changed after our read. Re-run from the
          // current item so the removal applies without erasing the winner,
          // and the heir is decided again on that read.
          return write();
        }
        log.info(
          {
            unitId,
            contactId,
            rosterSize: (patch['contacts'] as UnitContact[]).length,
            removedPrimaryContact: removedWasPrimaryContact,
            ...(heirId !== undefined && { primaryHandedTo: heirId }),
          },
          'unit contact removed',
        );
        if (heirId !== undefined) opts?.onPrimaryHandoff?.({ from: contactId, to: heirId });
        return updated;
      };
      return write();
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoPrimaryOnRemove.integration.test.ts test/unitsRepoRoster.integration.test.ts test/unitsRepoContactListRules.integration.test.ts
```

Expected: all pass.

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/repos/unitsRepo.ts`, `app/test/unitsRepoRoster.integration.test.ts`
modified; the new test untracked; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/unitsRepo.ts app/test/unitsRepoPrimaryOnRemove.integration.test.ts app/test/unitsRepoRoster.integration.test.ts && git commit -m "feat(units): removing the primary hands it to the heir function's pick, refuses on unknown liveness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.6 - the remove route: 503 `roster_read_failed`, audit `handoff_on_remove`; the fake mirrors `removeContact`

Files:
- Modify: `app/src/routes/units.ts` (unitsRepo import + the
  `DELETE /:unitId/contacts/:contactId` handler ONLY)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (imports + the fake
  `removeContact` ONLY)
- Create: `app/test/unitsApiPrimaryOnRemove.test.ts`
- Modify: `app/test/unitsApiRoster.test.ts` (one seed line)

DynamoDB Local: not needed.

**Step 1 - the failing tests.**

(a) Create `app/test/unitsApiPrimaryOnRemove.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Remove from the
// property") through DELETE /api/units/:id/contacts/:contactId on the
// FakeWorld harness. Removing the PRIMARY row hands the primary to the heir
// function's pick (the removed contact excluded): the live landlord of record
// - given a row as primary when it has none - else the earliest-added
// remaining contact eligible for automatic routing; no heir clears every flag
// and REMOVEs the scalar; a liveness read that fails (either shape) refuses
// with 503 roster_read_failed and writes nothing. A hand-off appends
// unit_primary_contact_assigned { reason: 'handoff_on_remove', from }.
// Removing a non-primary row reads no liveness.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-01T09:00:00.000Z';

/** A unit with NO landlordId attribute unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  } as UnitItem);
}

/** A contact typed landlord unless overridden. */
function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...fields } as ContactItem);
}

function remove(app: import('express').Express, unitId: string, contactId: string) {
  return request(app)
    .delete(`/api/units/${unitId}/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 2)],
];

describe('DELETE /api/units/:id/contacts/:contactId - removing the primary (spec 4.6)', () => {
  it('the live landlord of record takes over - flag and scalar - audited handoff_on_remove', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', {
      landlordId: 'c-ll',
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');

    const res = await remove(app, 'u-1', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-ll');
    expect(res.body.unit.contacts).toEqual([expect.objectContaining({ contactId: 'c-ll', primaryContact: true })]);
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-ll',
          reason: 'handoff_on_remove',
          from: 'c-pm',
        },
      },
    ]);
  });

  it('an off-roster landlord of record takes over with a landlord row added as the primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2', {
      landlordId: 'c-ll',
      primary_contact: 'c-pm',
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
    });
    seedContact(world, 'c-ll');

    const res = await remove(app, 'u-2', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-2')?.contacts).toHaveLength(1);
    expect(world.units.get('u-2')?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(world.units.get('u-2')?.primary_contact).toBe('c-ll');
  });

  it('no landlord of record (470 Bolton): the earliest-added eligible contact takes over - a tenant and a caseworker are skipped', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-3', {
      primary_contact: 'c-mark',
      contacts: [
        { contactId: 'c-mark', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-late', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-mark');
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker' });
    seedContact(world, 'c-own');
    seedContact(world, 'c-late');

    const res = await remove(app, 'u-3', 'c-mark');

    expect(res.status).toBe(200);
    expect(world.units.get('u-3')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-late', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-3')?.primary_contact).toBe('c-own');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-own', reason: 'handoff_on_remove', from: 'c-mark' },
    ]);
  });

  it('no eligible contact left: every flag cleared, the scalar removed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-4', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'owner', primaryContact: false },
      ],
    });
    seedContact(world, 'c-pm');
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-gone', { deleted_at: GONE });

    const res = await remove(app, 'u-4', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-4')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-4')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
    expect(world.auditEvents.map((e) => e.event_type)).toEqual(['unit_contact_removed']);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedUnit(world, 'u-5', {
        landlordId: 'c-ll',
        primary_contact: 'c-pm',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true },
        ],
      });
      seedContact(world, 'c-ll');
      seedContact(world, 'c-pm');
      const before = structuredClone(world.units.get('u-5'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await remove(app, 'u-5', 'c-pm');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-5')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit contact remove refused: the liveness read failed'),
      ).toMatchObject({ unitId: 'u-5', contactId: 'c-pm' });
    },
  );

  it('(PIN) removing a NON-primary row needs no liveness: it succeeds even when every batch read fails', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-6', {
      landlordId: 'c-ll',
      primary_contact: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
    });
    // Every batch read throws - the response's best-effort enrichment survives
    // that, and a removal that needed liveness would answer 503 instead.
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await remove(app, 'u-6', 'c-other');

    expect(res.status).toBe(200);
    expect(world.units.get('u-6')?.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(world.units.get('u-6')?.primary_contact).toBe('c-ll');
    expect(world.auditEvents.map((e) => e.event_type)).toEqual(['unit_contact_removed']);
  });
});
```

(b) `app/test/unitsApiRoster.test.ts` - the existing landlord-heir test now
needs the landlord of record to be a LIVE contact (spec 4.6: the landlord
takes over only when live; before this slice nobody checked). Edit,
old_string:

```ts
        { contactId: 'c-pm-c', role: 'pm', primaryContact: true },
      ],
    });
```

new_string:

```ts
        { contactId: 'c-pm-c', role: 'pm', primaryContact: true },
      ],
    });
    // primary-contact-integrity spec 4.6: the landlord of record takes over
    // only when it is a LIVE contact.
    seedContact(world, 'c-ll-c');
```

The test's assertions stay exactly as they are (one primary - c-ll-c - and
the scalar `c-ll-c` on the wire and in the store).

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPrimaryOnRemove.test.ts test/unitsApiRoster.test.ts
```

Expected failures (new file): the first test (no assigned event), `an
off-roster landlord of record takes over...` (the old fake flags only an
existing landlord row - `contacts` has length 0), `no landlord of record (470
Bolton)...` (the old fake clears instead of handing off), both `liveness
unknown` cases (200 instead of 503). The unitsApiRoster edit passes already.

**Step 3 - implementation.**

(a) `app/src/routes/units.ts` - unitsRepo import. old_string:

```ts
  PrimaryContactDeletedError,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
  PrimaryContactDeletedError,
  RosterReadFailedError,
  RosterWriteConflictError,
  unitContacts,
```

and old_string:

```ts
  type ListUnitsOpts,
  type RelatedUnit,
```

new_string:

```ts
  type ListUnitsOpts,
  type PrimaryHandoff,
  type RelatedUnit,
```

(b) `app/src/routes/units.ts` - replace the WHOLE remove handler with the
comment block above it: from the comment line that begins
`  // DELETE /api/units/:unitId/contacts/:contactId (BE3/C3)` through the
handler's closing `  });` (the line before the comment line that begins
`  // GET /api/units/:unitId/related`). Select by those marker lines (the old
text has non-ASCII arrows/dashes). Replacement:

```ts
  // DELETE /api/units/:unitId/contacts/:contactId (BE3/C3) -> { unit }. 404
  // unknown unit / contact-not-on-roster; 409 removing the landlord of record
  // (cannot_remove_landlord_of_record - reassign landlordId first) or exhausted
  // optimistic retries (unit_roster_conflict); audit unit_contact_removed.
  // Removing the PRIMARY row (primary-contact-integrity spec 4.6) hands the
  // primary to the heir function's pick (lib/propertyContact.ts chooseHeir,
  // the removed contact excluded): the live landlord of record, else the
  // earliest-added remaining contact eligible for automatic routing; no heir
  // clears every flag and REMOVEs the scalar. The liveness read is ONE
  // complete batch read per attempt (readRosterContacts); when it fails the
  // removal is refused with 503 roster_read_failed and nothing is written. A
  // hand-off also appends unit_primary_contact_assigned
  // { reason: 'handoff_on_remove', from: <removed contact> }, from the hand-off
  // the write itself reported.
  router.delete('/:unitId/contacts/:contactId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    const reported: { handoff?: PrimaryHandoff } = {};
    let updated: UnitItem;
    try {
      updated = await units.removeContact(unitId, contactId, {
        readContacts: (ids) => readRosterContacts(contacts, ids, log),
        onPrimaryHandoff: (handoff) => {
          reported.handoff = handoff;
        },
      });
    } catch (err) {
      if (err instanceof CannotRemoveLandlordOfRecordError) {
        res.status(409).json({ error: 'cannot_remove_landlord_of_record' });
        return;
      }
      if (err instanceof RosterReadFailedError) {
        log.warn(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact remove refused: the liveness read failed',
        );
        res.status(503).json({ error: 'roster_read_failed' });
        return;
      }
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        // Unknown unit OR contact-not-on-roster - both 404 (mirrors the unit
        // 404 posture; the message distinguishes them in logs only).
        res.status(404).json({ error: 'unit_or_contact_not_found' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    await audit.append(`units#${unitId}`, 'unit_contact_removed', {
      actor: req.user?.userId,
      contactId,
    });
    const handoff = reported.handoff;
    if (handoff !== undefined) {
      await audit.append(`units#${unitId}`, 'unit_primary_contact_assigned', {
        actor: req.user?.userId,
        contactId: handoff.to,
        reason: 'handoff_on_remove',
        from: handoff.from,
      });
    }
    log.info(
      {
        unitId,
        contactId,
        actor: req.user?.userId,
        ...(handoff !== undefined && { primaryHandedTo: handoff.to }),
      },
      'unit contact removed via api',
    );
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
  });
```

(c) `app/test/helpers/twilioWebhookHarness.ts` - unitsRepo import. old_string:

```ts
  PrimaryContactDeletedError,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
  PrimaryContactDeletedError,
  RosterReadFailedError,
  RosterWriteConflictError,
  unitContacts,
```

(d) `app/test/helpers/twilioWebhookHarness.ts` - add the propertyContact
import. old_string:

```ts
import { UNIT_MEDIA_MAX } from '../../src/lib/unitMedia.js';
import { RosterPlanConflictError } from '../../src/lib/rosterResolution.js';
```

new_string:

```ts
import { UNIT_MEDIA_MAX } from '../../src/lib/unitMedia.js';
import {
  applyPrimary,
  chooseHeir,
  rosterContactIds,
  type RosterContactsRead,
} from '../../src/lib/propertyContact.js';
import { RosterPlanConflictError } from '../../src/lib/rosterResolution.js';
```

(If S1 already added an import from `'../../src/lib/propertyContact.js'` to
this file, merge these four names into it instead of adding a second line.)

(e) `app/test/helpers/twilioWebhookHarness.ts` - replace the WHOLE fake
`removeContact` method: from the line `    async removeContact(unitId,
contactId) {` through its closing `    },` (the line before `    async
list(opts = {}) {` that follows it). The old method has non-ASCII glyphs in
comments; select by the marker lines. Replacement:

```ts
    async removeContact(unitId, contactId, opts) {
      // Mirror the real repo: the landlord-of-record guard, the 404, and -
      // when the removed row was the primary - the heir function
      // (primary-contact-integrity spec 4.6) through the SAME pure chooseHeir /
      // applyPrimary, the removed contact excluded and never read; unknown
      // liveness (a failed read, or none supplied) refuses with
      // RosterReadFailedError and writes nothing.
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`removeContact: no unit ${unitId}`);
      if (typeof unit.landlordId === 'string' && unit.landlordId === contactId) {
        throw new CannotRemoveLandlordOfRecordError();
      }
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const target = roster.find((c) => c.contactId === contactId);
      if (!target) throw conditionalCheckFailed(`removeContact: unit ${unitId} has no contact ${contactId}`);
      let next = roster.filter((c) => c.contactId !== contactId);
      let scalar: string | null | undefined;
      let heirId: string | undefined;
      if (target.primaryContact) {
        const landlordOfRecord =
          typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
        const read: RosterContactsRead =
          opts?.readContacts !== undefined
            ? await opts.readContacts(rosterContactIds(unit).filter((id) => id !== contactId))
            : { ok: false };
        const heir = chooseHeir({ roster, landlordId: landlordOfRecord, exclude: contactId, read });
        if (heir.kind === 'unknown') throw new RosterReadFailedError();
        const applied = applyPrimary(
          next,
          heir.kind === 'heir' ? { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow } : null,
        );
        next = applied.contacts;
        scalar = applied.primaryContactScalar;
        heirId = heir.kind === 'heir' ? heir.contactId : undefined;
      }
      unit.contacts = next;
      if (scalar === null) delete unit.primary_contact; // null -> REMOVE; never dangling
      else if (scalar !== undefined) unit.primary_contact = scalar;
      unit.updated_at = new Date().toISOString();
      if (heirId !== undefined) opts?.onPrimaryHandoff?.({ from: contactId, to: heirId });
      return unit;
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPrimaryOnRemove.test.ts test/unitsApiRoster.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiActivity.test.ts test/unitsApiPrimaryOnAdd.test.ts
```

Expected: all pass.

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/routes/units.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/unitsApiRoster.test.ts` modified; the new test untracked; no
`.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsApiPrimaryOnRemove.test.ts app/test/unitsApiRoster.test.ts && git commit -m "feat(units): remove route hands the primary off (503 roster_read_failed on unknown liveness), audits handoff_on_remove" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.7 - `unitsRepo.restoreWithLandlord`: the swap re-runs the heir function; both branches report the hand-off

Files:
- Modify: `app/src/repos/unitsRepo.ts`
- Create: `app/test/unitsRepoRestoreHandoff.integration.test.ts`
- Modify: `app/test/unitsRepoRestoreWithLandlord.integration.test.ts` (six
  swap calls whose old landlord is the primary now pass a liveness read)

DynamoDB Local: REQUIRED.

**Step 1 - the failing tests.**

(a) Create `app/test/unitsRepoRestoreHandoff.integration.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, caseworker-
// integrity's restores): the real unitsRepo.restoreWithLandlord against
// DynamoDB Local. When the old landlord was the primary, a landlord SWAP
// re-runs the heir function after the swap - chooseHeir on the attempt's
// swapped roster, the old landlord excluded: the new landlord when live, else
// the earliest-added remaining contact eligible for automatic routing, else
// nobody - with liveness from opts.readContacts per attempt; unknown is
// RosterReadFailedError and nothing is written. A restore WITHOUT a landlord
// applies the caller's heir pick (`promote`) and needs no read.
// opts.onPrimaryHandoff reports a flagged heir once, after the write.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  RosterReadFailedError,
  type PrimaryHandoff,
  type UnitContact,
} from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[unitsRepoRestoreHandoff.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const AT = '2026-10-01T09:00:00.000Z';

function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord - the heir function (spec 4.6) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** A SOFT-DELETED unit owned by c-old with the given stored roster and scalar. */
  async function deletedUnit(contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    await units.softDelete(created.unitId, AT);
    return created.unitId;
  }

  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      const result = await doc.send(command);
      if (!raced && command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        raced = true;
        await race();
      }
      return result;
    }) as typeof doc.send;
    return createUnitsRepo({ doc: racingDoc, env: testEnv, logger });
  }

  it('swap, the new landlord is live: it takes the primary; onPrimaryHandoff reports { from: old, to: new }', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const liveness = livenessFrom([person('c-new'), person('c-pm')]);
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: liveness.read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.deleted_at).toBeUndefined();
    expect(updated.landlordId).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
    expect(updated.primary_contact).toBe('c-new');
    expect(handoffs).toEqual([{ from: 'c-old', to: 'c-new' }]);
    expect(liveness.calls.flat()).not.toContain('c-old');
  });

  it('swap, the new landlord is SOFT-DELETED: the earliest eligible remaining contact takes the primary; the new landlord stays landlord of record, not primary', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: livenessFrom([
          person('c-new', { deleted_at: AT }),
          person('c-ten', { type: 'tenant' }),
          person('c-pm'),
        ]).read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.landlordId).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(handoffs).toEqual([{ from: 'c-old', to: 'c-pm' }]);
  });

  it('swap, the new landlord soft-deleted and nobody eligible: no primary row, the scalar REMOVEd, no hand-off reported', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        readContacts: livenessFrom([person('c-new', { deleted_at: AT }), person('c-ten', { type: 'tenant' })]).read,
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBeUndefined();
    expect(handoffs).toEqual([]);
  });

  const UNKNOWN_READS: Array<[string, ((ids: string[]) => Promise<RosterContactsRead>) | undefined]> = [
    ['the read failed', failedRead],
    ['no read was supplied', undefined],
  ];
  it.each(UNKNOWN_READS)(
    'swap of a primary landlord, liveness unknown (%s): RosterReadFailedError - nothing written',
    async (_case, read) => {
      const roster: UnitContact[] = [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ];
      const unitId = await deletedUnit(roster, 'c-old');
      const { repo, counter } = countingRepo(unitId);

      await expect(
        repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          read === undefined ? undefined : { readContacts: read },
        ),
      ).rejects.toBeInstanceOf(RosterReadFailedError);

      expect(counter.writes).toBe(0);
      const stored = await units.getById(unitId, { consistentRead: true });
      expect(stored?.deleted_at).toBe(AT);
      expect(stored?.landlordId).toBe('c-old');
      expect(stored?.contacts).toEqual(roster);
      expect(stored?.primary_contact).toBe('c-old');
    },
  );

  it('(PIN) swap where the old landlord was NOT the primary: no liveness read, the other primary stays', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    let reads = 0;
    const counted = async (): Promise<RosterContactsRead> => {
      reads += 1;
      return { ok: false };
    };

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: counted },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(reads).toBe(0);
  });

  it('a swap retried after a contacts-only race decides the heir again on a fresh read', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    // Staff B adds c-late (eligible) right after attempt 1's read. Attempt 1
    // finds nobody (c-new deleted, c-pm a tenant), its write loses the roster
    // condition, and attempt 2 re-reads and finds c-late.
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #c = :c',
          ExpressionAttributeNames: { '#c': 'contacts' },
          ExpressionAttributeValues: {
            ':c': [
              { contactId: 'c-old', role: 'landlord', primaryContact: true },
              { contactId: 'c-pm', role: 'pm', primaryContact: false },
              { contactId: 'c-late', role: 'other', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const liveness = livenessFrom([
      person('c-new', { deleted_at: AT }),
      person('c-pm', { type: 'tenant' }),
      person('c-late'),
    ]);

    const updated = await racing.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: liveness.read },
    );

    expect(liveness.calls).toHaveLength(2);
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-late', role: 'other', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-late');
  });

  it("without a landlord: the caller's heir pick is applied and reported; no pick reports nothing", async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ];
    const withPick = await deletedUnit(roster, 'c-old');
    const picked: PrimaryHandoff[] = [];
    const promoted = await units.restoreWithLandlord(
      withPick,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: 'c-pm' },
      {
        onPrimaryHandoff: (handoff) => {
          picked.push(handoff);
        },
      },
    );
    expect(promoted.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(promoted.primary_contact).toBe('c-pm');
    expect(picked).toEqual([{ from: 'c-old', to: 'c-pm' }]);

    const withoutPick = await deletedUnit(roster, 'c-old');
    const none: PrimaryHandoff[] = [];
    const cleared = await units.restoreWithLandlord(
      withoutPick,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: null },
      {
        onPrimaryHandoff: (handoff) => {
          none.push(handoff);
        },
      },
    );
    expect(cleared.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    expect(cleared.primary_contact).toBeUndefined();
    expect(none).toEqual([]);
  });

  it('(PIN) without a landlord needs no liveness read: a failed read changes nothing', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ];
    const unitId = await deletedUnit(roster, 'c-old');

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: null, expectContacts: roster, promote: 'c-pm' },
      { readContacts: failedRead },
    );

    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(updated.primary_contact).toBe('c-pm');
  });

  // plan review R2/R3 (spec 3 / 4.7; landlordWasPrimary): when ANY row is
  // flagged, only the flag says who is primary. A stale primary_contact naming
  // the old landlord moves nothing, and the write re-aligns the scalar to the
  // flagged row. (With NO row flagged the restore always hands off, whatever
  // the scalar says - caseworker-integrity's no-flag pins in
  // unitsRepoRestoreWithLandlord.integration.test.ts stay GREEN that way.)
  it('swap: a stale scalar naming the old landlord does NOT move the primary off a live flagged row; the scalar is re-aligned', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-old',
    );
    const handoffs: PrimaryHandoff[] = [];

    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      {
        onPrimaryHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      },
    );

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
    expect(handoffs).toEqual([]);
  });

  it('without a landlord: a stale scalar naming the cleared landlord does NOT move the primary off a live flagged row', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-old', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ];
    const unitId = await deletedUnit(roster, 'c-old');

    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: null,
      expectContacts: roster,
      promote: null,
    });

    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(updated.primary_contact).toBe('c-pm');
  });
});
```

(b) `app/test/unitsRepoRestoreWithLandlord.integration.test.ts` - its swaps of
a landlord who was the primary now need a liveness read (without one the
repo refuses: RosterReadFailedError). Eight Edits; every assertion stays as it
is.

Imports, old_string:

```ts
import { createUnitsRepo, RosterWriteConflictError, type UnitContact } from '../src/repos/unitsRepo.js';
```

new_string:

```ts
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createUnitsRepo, RosterWriteConflictError, type UnitContact } from '../src/repos/unitsRepo.js';
```

Helper, old_string:

```ts
describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord against DynamoDB Local', () => {
```

new_string:

```ts
/**
 * primary-contact-integrity (spec 4.6): a SWAP of a landlord who was the
 * primary re-runs the heir function, which needs a liveness read. This one
 * answers every id as a live contact typed landlord, so the new landlord of
 * record takes the primary exactly as before the heir function.
 */
const EVERYONE_LIVE_LANDLORD = async (ids: string[]): Promise<RosterContactsRead> => ({
  ok: true,
  byId: new Map(ids.map((id) => [id, { contactId: id, type: 'landlord' } as ContactItem] as const)),
});

describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord against DynamoDB Local', () => {
```

Call 1 (test "swaps the landlord: restored, old row gone..."), old_string:

```ts
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new', name: 'Nora Lane', company: 'Lane Homes' },
    });
```

new_string:

```ts
    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new', name: 'Nora Lane', company: 'Lane Homes' } },
      { readContacts: EVERYONE_LIVE_LANDLORD },
    );
```

Call 2 (test "moves the primary to the new landlord when only the
primary_contact scalar named the old one"), old_string:

```ts
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new' },
    });
    expect(updated.primary_contact).toBe('c-new');
```

new_string:

```ts
    const updated = await units.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: EVERYONE_LIVE_LANDLORD },
    );
    expect(updated.primary_contact).toBe('c-new');
```

Call 3 (test "a plain restore landing between the read and the write is a
conflict"), old_string:

```ts
      racing.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    // Nothing of this call landed: live by the racer's restore, still c-old's.
```

new_string:

```ts
      racing.restoreWithLandlord(
        unitId,
        { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
        { readContacts: EVERYONE_LIVE_LANDLORD },
      ),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    // Nothing of this call landed: live by the racer's restore, still c-old's.
```

Call 4 (test "a landlordId changed between the read and the write is a
conflict"), old_string:

```ts
      racing.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.landlordId).toBe('c-racer');
```

new_string:

```ts
      racing.restoreWithLandlord(
        unitId,
        { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
        { readContacts: EVERYONE_LIVE_LANDLORD },
      ),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.landlordId).toBe('c-racer');
```

Call 5 (test "a contacts-only change between the read and the write is
retried"), old_string:

```ts
    const updated = await racing.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new' },
    });
```

new_string:

```ts
    const updated = await racing.restoreWithLandlord(
      unitId,
      { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
      { readContacts: EVERYONE_LIVE_LANDLORD },
    );
```

Call 6 (test "gives up after 3 attempts..."), old_string:

```ts
      contended.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
```

new_string:

```ts
      contended.restoreWithLandlord(
        unitId,
        { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
        { readContacts: EVERYONE_LIVE_LANDLORD },
      ),
```

(c) Create `app/test/landlordWasPrimary.test.ts` (pure - no tables; the
vitest globalSetup still probes DynamoDB Local, see section 0):

```ts
// primary-contact-integrity (plan review R2/R3; spec 3 / 4.6 / 4.7): does a
// restore that removes the landlord's row need a primary hand-off? ONE pure
// rule shared by the real restoreWithLandlord, the restore route's heir pick
// and the API-test fake: yes when the landlord's row is the FLAGGED primary,
// or when NO row is flagged (the property has no primary; the heir function
// picks who). It takes no scalar - a stale primary_contact can decide
// nothing.
import { describe, expect, it } from 'vitest';
import { landlordWasPrimary, type UnitContact } from '../src/repos/unitsRepo.js';

function row(contactId: string, primaryContact: boolean): UnitContact {
  return { contactId, role: contactId === 'c-old' ? 'landlord' : 'pm', primaryContact };
}

describe('landlordWasPrimary', () => {
  it('the landlord row is flagged -> true', () => {
    expect(landlordWasPrimary([row('c-old', true), row('c-pm', false)], 'c-old')).toBe(true);
  });

  it('ANOTHER row is flagged -> false (a live flagged primary is never displaced)', () => {
    expect(landlordWasPrimary([row('c-old', false), row('c-pm', true)], 'c-old')).toBe(false);
  });

  it('NO row is flagged -> true (the hand-off is how the property gets a primary)', () => {
    expect(landlordWasPrimary([row('c-old', false), row('c-pm', false)], 'c-old')).toBe(true);
    expect(landlordWasPrimary([], 'c-old')).toBe(true);
  });

  it('the landlord-only DERIVED row (unitContacts) counts as flagged', () => {
    expect(landlordWasPrimary([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old')).toBe(
      true,
    );
  });
});
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoRestoreHandoff.integration.test.ts test/unitsRepoRestoreWithLandlord.integration.test.ts test/landlordWasPrimary.test.ts
```

Expected failures (new file): the soft-deleted-new-landlord cases (the old
code flags c-new unconditionally), both `liveness unknown` cases (resolved),
the retry case (`liveness.calls` length 0), every `handoffs`/`picked`
expectation (the old code never reports), and both `a stale scalar naming the
old/cleared landlord does NOT move the primary...` cases (the old code counts
the scalar alone as primary, so the swap flags c-new and the clear removes
c-pm's flag). `landlordWasPrimary.test.ts` fails to import
(`landlordWasPrimary` is not exported yet). The edited existing file passes
already (the old code ignores the third argument; its three no-flag pins
- `moves the primary to the new landlord when only the primary_contact scalar
named the old one`, `without a landlord: promotes when only the
primary_contact scalar named the cleared landlord`, and the route twin in
`unitsRestoreLandlord.test.ts` - stay GREEN under `landlordWasPrimary`, which
hands off whenever NO row is flagged; their scalar no longer matters).

**Step 3 - implementation** (`app/src/repos/unitsRepo.ts`, five Edits).

(a) `RestoreWithLandlordInput` header. old_string:

```ts
 * ownerless); `next` is the new landlord of record, or null for a restore
 * WITHOUT a landlord - which also carries the caller's sole-landlord promotion
 * (spec revision 5; fix wave 2 FW2-12) and the contact list it was decided
 * from.
```

new_string:

```ts
 * ownerless); `next` is the new landlord of record, or null for a restore
 * WITHOUT a landlord - which also carries the caller's heir pick
 * (primary-contact-integrity spec 4.6; it replaced caseworker-integrity's
 * sole-landlord promotion) and the contact list it was decided from.
```

(b) The `promote` field doc. old_string:

```ts
      /**
       * The caller's decision: the one remaining row whose contact is typed
       * landlord, made the sole primary when the cleared landlord was the
       * primary; null when zero or two-plus such rows remain (nobody).
       */
      promote: string | null;
```

new_string:

```ts
      /**
       * The caller's decision (primary-contact-integrity spec 4.6): the heir
       * function's pick - chooseHeir with the cleared landlord excluded and no
       * landlord of record, i.e. the earliest-added remaining contact eligible
       * for automatic routing - made the sole primary when the cleared
       * landlord was the primary; null for nobody.
       */
      promote: string | null;
```

(c) Interface docblock + signature. old_string:

```ts
   * 'landlord' (kept when already seated; name/company updated when supplied),
   * and keeps `primary_contact` consistent: when the old landlord was the
   * primary (roster flag or scalar), `next` becomes the sole primary, or with
   * no landlord the caller's sole-landlord promotion (`promote`, spec revision
   * 5) becomes the sole primary when it names a remaining row, else the scalar
   * is REMOVEd and no row stays primary (removeContact's rule). The write is
```

new_string:

```ts
   * 'landlord' (kept when already seated; name/company updated when supplied),
   * and keeps `primary_contact` consistent: when the restore needs a hand-off
   * (landlordWasPrimary: the old landlord's row is the flagged primary, or no
   * row is flagged; the scalar is never read) - primary-contact-integrity spec
   * 4.6 - a SWAP re-runs the heir function after the swap (chooseHeir on this
   * attempt's swapped roster, the old landlord excluded: the new landlord when
   * live, else the earliest-added remaining contact eligible for automatic
   * routing, else nobody), its liveness from `opts.readContacts` per attempt
   * (a failed read or none supplied: RosterReadFailedError, nothing written);
   * a restore WITHOUT a landlord applies the caller's heir pick (`promote`)
   * when it names a remaining row, else the scalar is REMOVEd and no row stays
   * primary (removeContact's rule). `opts.onPrimaryHandoff` is called once
   * after the write when an heir was flagged. The write is
```

and old_string:

```ts
  restoreWithLandlord(unitId: string, input: RestoreWithLandlordInput): Promise<UnitItem>;
```

new_string:

```ts
  restoreWithLandlord(
    unitId: string,
    input: RestoreWithLandlordInput,
    opts?: RosterHandoffOpts,
  ): Promise<UnitItem>;
```

(d) Implementation: replace the WHOLE `restoreWithLandlord` method of the
object returned by `createUnitsRepo` - from the line `    async
restoreWithLandlord(unitId, input) {` through its closing `    },` (the line
before the `  };` that closes the returned object, which is followed by `}`
and the comment `/** Re-export so callers needn't import
ConditionalCheckFailedException separately. */`). Replacement:

```ts
    async restoreWithLandlord(unitId, input, opts) {
      let attempts = 0;
      const write = async (): Promise<UnitItem> => {
        attempts += 1;
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) {
          throw new ConditionalCheckFailedException({
            message: `unit ${unitId} not found`,
            $metadata: {},
          });
        }
        // Restore only ever restores: a unit that is not soft-deleted (never
        // deleted, or restored by someone else since the caller's read) must
        // not have its landlord of record swapped or cleared here (R1 code
        // review, backend finding 2) - a concurrent change the caller must
        // re-read (route 409 unit_roster_conflict). The write below is
        // conditioned on deleted_at too, for a restore landing after this read.
        if (!isDeleted(unit)) throw new RosterWriteConflictError();
        const current =
          typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
        // The caller decided from THIS landlordId; any other owner now is a
        // concurrent change the caller must re-read (route 409 unit_roster_conflict).
        if (current !== input.expectLandlordId) throw new RosterWriteConflictError();
        // A restore WITHOUT a landlord carries the caller's heir pick
        // (primary-contact-integrity spec 4.6), decided from the contact list
        // the caller read. On any other list - a contact-list change since -
        // that decision is stale: a conflict the caller must re-read (route 409
        // unit_roster_conflict), never a retry that applies it anyway. The
        // write below is conditioned on this very list, so a change landing
        // after this read loses the write and re-reads into here.
        if (input.next === null && !isDeepStrictEqual(unit.contacts, input.expectContacts)) {
          throw new RosterWriteConflictError();
        }
        const old = input.expectLandlordId;
        const next = input.next;
        const promote = input.next === null ? input.promote : null;
        // `next` naming the old landlord (only reachable when they became a
        // landlord again under a race) keeps their row instead of re-adding it.
        const keepsOld = next !== null && next.contactId === old;
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        // Does this restore need a hand-off? The shared rule (landlordWasPrimary,
        // plan review R1-R3): yes when the old landlord's row is the FLAGGED
        // primary, or when NO row is flagged (the heir function then picks
        // who); a live flagged row elsewhere is never displaced. The
        // primary_contact scalar is never read; with no hand-off it is
        // re-aligned to the flag below.
        const oldWasPrimary =
          old !== undefined && !keepsOld && landlordWasPrimary(roster, old);
        const nextRoster: UnitContact[] =
          old !== undefined && !keepsOld ? roster.filter((c) => c.contactId !== old) : roster;
        if (next !== null) {
          const seated = nextRoster.find((c) => c.contactId === next.contactId);
          if (seated) {
            seated.role = 'landlord'; // the landlord of record's role is structural
            if (next.name !== undefined) seated.name = next.name;
            if (next.company !== undefined) seated.company = next.company;
          } else {
            nextRoster.push({
              contactId: next.contactId,
              role: 'landlord',
              primaryContact: false,
              ...(next.name !== undefined ? { name: next.name } : {}),
              ...(next.company !== undefined ? { company: next.company } : {}),
            });
          }
        }
        const patch: Record<string, unknown> = {
          contacts: nextRoster,
          landlordId: next !== null ? next.contactId : null, // null -> REMOVE
          deleted_at: null, // null -> REMOVE: the restore itself
        };
        let heirId: string | undefined;
        if (oldWasPrimary) {
          if (next !== null) {
            // The landlord SWAP (primary-contact-integrity spec 4.6, Cameron
            // 2026-10-13): re-run the heir function after the swap instead of
            // flagging the new landlord unconditionally - the new landlord of
            // record when live, else the earliest-added remaining contact
            // eligible for automatic routing, else nobody - so a soft-deleted
            // new landlord is not made primary. Decided HERE, per attempt, on
            // this attempt's swapped roster (a contacts-only race is retried,
            // so a decision made by the caller could go stale); the old
            // landlord is excluded and not read. Unknown liveness refuses with
            // RosterReadFailedError and writes nothing (route 503).
            const read: RosterContactsRead =
              opts?.readContacts !== undefined
                ? await opts.readContacts(
                    rosterContactIds({ contacts: nextRoster, landlordId: next.contactId }).filter(
                      (id) => id !== old,
                    ),
                  )
                : { ok: false };
            const heir = chooseHeir({ roster: nextRoster, landlordId: next.contactId, exclude: old, read });
            if (heir.kind === 'unknown') throw new RosterReadFailedError();
            const applied = applyPrimary(
              nextRoster,
              heir.kind === 'heir' ? { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow } : null,
            );
            patch['contacts'] = applied.contacts;
            patch['primary_contact'] = applied.primaryContactScalar;
            heirId = heir.kind === 'heir' ? heir.contactId : undefined;
          } else {
            // No landlord left. The caller's heir pick (spec 4.6), when it
            // names a remaining row, becomes the sole primary in this same
            // write; otherwise every flag is cleared and the scalar REMOVEd
            // (removeContact's rule), never left dangling at the removed
            // landlord.
            const promoted = promote === null ? undefined : nextRoster.find((c) => c.contactId === promote);
            const applied = applyPrimary(
              nextRoster,
              promoted !== undefined ? { contactId: promoted.contactId, addLandlordRow: false } : null,
            );
            patch['contacts'] = applied.contacts;
            patch['primary_contact'] = applied.primaryContactScalar;
            heirId = promoted?.contactId;
          }
        } else {
          // No hand-off: keep the scalar consistent with the FLAG this write
          // stores (spec 4.7) without ever reading the old scalar - the row
          // marked primary, or REMOVE when none is (never left dangling at the
          // removed landlord's row).
          const flagged = nextRoster.find((c) => c.primaryContact === true);
          patch['primary_contact'] = flagged !== undefined ? flagged.contactId : null;
        }
        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch, { requireSoftDeleted: true });
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) throw new RosterWriteConflictError();
          // Re-read: a vanished unit throws (route 404), a unit restored or a
          // landlordId changed meanwhile throws RosterWriteConflictError, a
          // contacts-only race retries (deciding a swap's heir again) - or, for
          // a restore without a landlord, fails the contact-list check above
          // (RosterWriteConflictError).
          return write();
        }
        log.info(
          {
            unitId,
            attempts,
            landlordCleared: next === null,
            ...(heirId !== undefined && { primaryPromoted: heirId }),
            rosterSize: (patch['contacts'] as UnitContact[]).length,
          },
          'unit restored with a landlord change',
        );
        if (heirId !== undefined && old !== undefined) opts?.onPrimaryHandoff?.({ from: old, to: heirId });
        return updated;
      };
      return write();
    },
```

(e) The shared "was this landlord the primary?" rule (plan review R2), used by
(d) above, by the restore route's heir pick (Task S2.8) and by the API-test
fake (Task S2.8). Insert it directly above the line
`export function createUnitsRepo(deps: RepoDeps = {}): UnitsRepo {` - Edit,
old_string:

```ts
export function createUnitsRepo(deps: RepoDeps = {}): UnitsRepo {
```

new_string:

```ts
/**
 * primary-contact-integrity (plan review R2/R3; spec 3 / 4.6 / 4.7): does a
 * restore that removes `landlordId`'s row need a primary hand-off? ONE pure
 * rule for the real restoreWithLandlord, the restore route's heir pick and the
 * API-test fake. True when the landlord's row is the FLAGGED primary, or when
 * NO row is flagged at all (the property has no primary, so the hand-off is
 * how it gets one - the heir function picks who). Never reads the
 * `primary_contact` scalar: a stale scalar can neither move the primary off a
 * live flagged row nor decide anything when nothing is flagged. (This keeps
 * caseworker-integrity's R1 backend finding 4 cases - a no-flag unit whose
 * scalar named the old landlord - handing off, without reading the scalar.)
 * `roster` is unitContacts(unit), so a landlord-only unit's DERIVED landlord
 * row counts as flagged.
 */
export function landlordWasPrimary(roster: readonly UnitContact[], landlordId: string): boolean {
  if (!roster.some((c) => c.primaryContact === true)) return true;
  return roster.some((c) => c.contactId === landlordId && c.primaryContact === true);
}

export function createUnitsRepo(deps: RepoDeps = {}): UnitsRepo {
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoRestoreHandoff.integration.test.ts test/unitsRepoRestoreWithLandlord.integration.test.ts test/unitsRepoAutoPrimary.integration.test.ts test/landlordWasPrimary.test.ts
```

Expected: all pass.

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/repos/unitsRepo.ts` and
`app/test/unitsRepoRestoreWithLandlord.integration.test.ts` modified, the two
new tests (`unitsRepoRestoreHandoff.integration.test.ts`,
`landlordWasPrimary.test.ts`) untracked; no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/unitsRepo.ts app/test/unitsRepoRestoreHandoff.integration.test.ts app/test/unitsRepoRestoreWithLandlord.integration.test.ts app/test/landlordWasPrimary.test.ts && git commit -m "feat(units): restore swap re-runs the heir function per attempt; restores report the primary hand-off; landlordWasPrimary decides by the flag" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.8 - the restore route: the heir function replaces `soleLandlordToPromote`; the swap passes liveness; 503; audit `handoff_on_restore`; the fake mirrors `restoreWithLandlord`

Files:
- Modify: `app/src/routes/units.ts` (the propertyContact import, the
  `soleLandlordToPromote` helper, the restore handler ONLY)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the fake
  `restoreWithLandlord` ONLY)
- Create: `app/test/unitsRestorePrimaryHandoff.test.ts`
- Modify: `app/test/unitsRestoreLandlord.test.ts` (the "two or more ->
  nobody" test, the consistent-read PIN, the read-race test - see step 1b)

DynamoDB Local: not needed.

**Step 1 - the failing tests.**

(a) Create `app/test/unitsRestorePrimaryHandoff.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, Cameron 2026-10-13)
// through POST /api/units/:id/restore on the FakeWorld harness:
// caseworker-integrity's restores hand the primary contact through the heir
// function. "Restore without a landlord" of a property whose cleared landlord
// was the primary promotes the EARLIEST-added remaining contact eligible for
// automatic routing (this replaced the sole-landlord promotion); the landlord
// SWAP re-runs the heir function after the swap, so a soft-deleted new
// landlord is not made primary. Liveness unknown (either read-failure shape)
// answers 503 roster_read_failed and writes nothing. Every hand-off appends
// unit_primary_contact_assigned { reason: 'handoff_on_restore', from: <old
// landlord> }. The plain restore changes no roster.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T09:00:00.000Z';

/** A SOFT-DELETED unit owned by c-old: c-old is the primary, c-pm a second row - unless overridden. */
function seedDeletedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-old',
    status: 'available',
    primary_contact: 'c-old',
    contacts: [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ],
    deleted_at: DELETED_AT,
    created_at: DELETED_AT,
    updated_at: DELETED_AT,
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function restore(app: import('express').Express, unitId: string, body?: Record<string, unknown>) {
  const req = request(app)
    .post(`/api/units/${unitId}/restore`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
  return body === undefined ? req : req.send(body);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');
const restoredEvents = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'unit_restored');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 2)],
];

describe('POST /api/units/:id/restore without a landlord - the heir function (spec 4.6)', () => {
  it('rows that are not eligible (a tenant, a soft-deleted landlord-typed contact) are skipped for the earliest eligible one; the hand-off is audited', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-c1', {
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-gone', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-own', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-c1', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-c1')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'pm', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-c1')?.primary_contact).toBe('c-own');
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordCleared: { from: 'c-old' },
      primaryPromoted: { to: 'c-own' },
    });
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-c1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-own',
          reason: 'handoff_on_restore',
          from: 'c-old',
        },
      },
    ]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedDeletedUnit(world, 'u-c2');
      seedContact(world, 'c-old', { type: 'tenant' });
      seedContact(world, 'c-pm', { type: 'landlord' });
      const before = structuredClone(world.units.get('u-c2'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await restore(app, 'u-c2', { landlordId: null });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-c2')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit restore refused: the liveness read failed'),
      ).toMatchObject({ unitId: 'u-c2' });
    },
  );

  it('the cleared landlord was not the primary: no liveness is needed (every batch read failing changes nothing) and no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-c3', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-pm', { type: 'landlord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await restore(app, 'u-c3', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-c3')?.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(world.units.get('u-c3')?.primary_contact).toBe('c-pm');
    expect(assigned(world)).toEqual([]);
  });
});

describe('POST /api/units/:id/restore with a landlord - the swap re-runs the heir function (spec 4.6)', () => {
  it('the new landlord is live: it takes the primary; audited handoff_on_restore from the old landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s1');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-s1', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s1')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
    expect(world.units.get('u-s1')?.primary_contact).toBe('c-new');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-new', reason: 'handoff_on_restore', from: 'c-old' },
    ]);
  });

  it('the new landlord is SOFT-DELETED: the earliest eligible remaining contact takes the primary; the new landlord stays landlord of record, not primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s2');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-s2', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s2')?.landlordId).toBe('c-new');
    expect(world.units.get('u-s2')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s2')?.primary_contact).toBe('c-pm');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-pm', reason: 'handoff_on_restore', from: 'c-old' },
    ]);
  });

  it('the new landlord soft-deleted and nobody else eligible: no primary row, the scalar removed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s3');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'tenant' });

    const res = await restore(app, 'u-s3', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s3')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s3')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world } = makeWebhookHarness();
      seedDeletedUnit(world, 'u-s4');
      seedContact(world, 'c-old', { type: 'tenant' });
      seedContact(world, 'c-new', { type: 'landlord' });
      const before = structuredClone(world.units.get('u-s4'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await restore(app, 'u-s4', { landlordId: 'c-new' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-s4')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('the old landlord was not the primary: the other primary stays, no liveness is needed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s5', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await restore(app, 'u-s5', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s5')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s5')?.primary_contact).toBe('c-pm');
    expect(assigned(world)).toEqual([]);
  });
});

describe('POST /api/units/:id/restore - the plain restore changes no roster (spec 9.1)', () => {
  it('(PIN) a soft-deleted flagged primary stays flagged after a plain restore; no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-plain', {
      primary_contact: 'c-dead',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'landlord' });
    seedContact(world, 'c-dead', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-plain');

    expect(res.status).toBe(200);
    expect(world.units.get('u-plain')?.deleted_at).toBeUndefined();
    expect(world.units.get('u-plain')?.contacts).toEqual([
      { contactId: 'c-old', role: 'landlord', primaryContact: false },
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-plain')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });
});
```

(b) `app/test/unitsRestoreLandlord.test.ts` - four Edits (caseworker-integrity
tests whose meaning this spec changes).

Edit 1 - the describe comment and title. old_string:

```ts
// Cameron's Q5 (spec revision 5 section 4 "Restore", the sole-landlord
// promotion; fix wave 2 FW2-12): a restore WITHOUT a landlord of a property
// whose cleared landlord was its primary contact promotes the ONE remaining
// contact-list row whose contact is typed landlord (any roster role; read
// consistently, a missing contact or a routing pointer is not eligible, nor -
// fix wave 3 FW3-1 - a soft-deleted contact) in the same conditional write;
// with zero or two-plus such rows nobody is promoted.
// The write is conditioned on the contact list the route read, so a
// concurrent contact-list change answers 409 unit_roster_conflict. The audit
// gains primaryPromoted { to } next to landlordCleared.
describe('POST /api/units/:id/restore - without a landlord: the sole-landlord promotion', () => {
```

new_string:

```ts
// Cameron's Q5 (caseworker-integrity spec revision 5 section 4 "Restore"),
// REPLACED by primary-contact-integrity spec 4.6 (Cameron 2026-10-13): a
// restore WITHOUT a landlord of a property whose cleared landlord was its
// primary contact hands the primary to the heir function's pick - the
// EARLIEST-added remaining contact-list row whose contact is eligible for
// automatic routing (typed landlord, any roster role; a missing contact, a
// routing pointer or a soft-deleted contact is not eligible) - in the same
// conditional write; with no such row nobody is promoted. The remaining
// contacts are read in ONE complete batch read (spec 4.2).
// The write is conditioned on the contact list the route read, so a
// concurrent contact-list change answers 409 unit_roster_conflict. The audit
// gains primaryPromoted { to } next to landlordCleared.
describe('POST /api/units/:id/restore - without a landlord: the heir takes over', () => {
```

Edit 2 - "two or more -> nobody" becomes "the earliest-added". old_string:

```ts
  it('two remaining contacts typed landlord: nobody is promoted - no primary row, primary_contact removed, no primaryPromoted', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p3', [
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });

    const res = await restore(app, 'u-p3', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p3')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-p3')?.primary_contact).toBeUndefined();
    expect(restoredEvents(world)[0]?.payload).toMatchObject({ landlordCleared: { from: 'c-old' } });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('primaryPromoted');
  });
```

new_string:

```ts
  // primary-contact-integrity spec 4.6 (Cameron 2026-10-13) REPLACES "two or
  // more -> nobody": the earliest-added eligible contact takes over.
  it('two remaining contacts typed landlord: the EARLIEST-added (c-pm) is promoted - its row primary, primary_contact set, audit primaryPromoted', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p3', [
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });

    const res = await restore(app, 'u-p3', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p3')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-p3')?.primary_contact).toBe('c-pm');
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordCleared: { from: 'c-old' },
      primaryPromoted: { to: 'c-pm' },
    });
  });

  // plan review R1 P1 (spec 3 / 4.7): the FLAG is the truth. A stale
  // primary_contact naming the cleared landlord must not hand the primary away
  // from a live flagged contact; the restore re-aligns the scalar to the flag.
  it('a stale primary_contact naming the cleared landlord does NOT move the primary off a live flagged contact; the scalar is re-aligned to it', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-p8', {
      primary_contact: 'c-old',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-owner', role: 'owner', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });

    const res = await restore(app, 'u-p8', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p8')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-p8')?.primary_contact).toBe('c-pm');
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('primaryPromoted');
  });
```

Edit 3 - the consistent-read PIN becomes the one-batch-read PIN. old_string:

```ts
  it('(PIN) reads the remaining contacts CONSISTENTLY', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p7', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');

    expect((await restore(app, 'u-p7', { landlordId: null })).status).toBe(200);

    expect(contactRead).toHaveBeenCalledWith('c-pm', { consistentRead: true });
  });
```

new_string:

```ts
  // primary-contact-integrity spec 4.2: the remaining contacts are read in ONE
  // complete batch read (readRosterContacts -> getManyByIds with
  // requireComplete), replacing the per-row consistent getById of the
  // sole-landlord promotion (plan S2 contract issue 10).
  it('(PIN) reads the remaining contacts in ONE complete batch read', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p7', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    expect((await restore(app, 'u-p7', { landlordId: null })).status).toBe(200);

    expect(batchRead).toHaveBeenCalledWith(['c-pm'], { requireComplete: true });
  });
```

Edit 4 - the read race now hooks the batch read. old_string:

```ts
  // R3 code review, backend finding A3 (probe F1; fix wave 3 FW3-2): the same
  // change landing EARLIER - while the route awaits the remaining contacts'
  // type reads, after it captured the list it decides from. The write must be
  // conditioned on that same list, not on a second read of the unit after the
  // awaits (the FakeWorld's getById hands the route the live unit object, so a
  // second read would see the NEW list and the stale promotion would go
  // through).
  it('a contact-list change WHILE the route reads the contact types: 409 unit_roster_conflict - nothing restored, no audit', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-race-read', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });
    const read = world.contactsRepo.getById.bind(world.contactsRepo);
    let added = false;
    world.contactsRepo.getById = async (contactId, opts) => {
      // Staff B adds a second landlord-typed contact while the route reads
      // c-pm's type for the promotion.
      if (contactId === 'c-pm' && !added) {
        added = true;
        await world.unitsRepo.addContact(
          'u-race-read',
          { contactId: 'c-owner', role: 'owner' },
          { caseworker: false, landlordTyped: true, autoPrimaryEligible: true },
        );
      }
      return read(contactId, opts);
    };
```

new_string:

```ts
  // R3 code review, backend finding A3 (probe F1; fix wave 3 FW3-2): the same
  // change landing EARLIER - while the route awaits the remaining contacts'
  // liveness read (primary-contact-integrity spec 4.2: ONE batch read,
  // readRosterContacts), after it captured the list it decides from. The write
  // must be conditioned on that same list, not on a second read of the unit
  // after the awaits (the FakeWorld's getById hands the route the live unit
  // object, so a second read would see the NEW list and the stale promotion
  // would go through).
  it('a contact-list change WHILE the route reads the contacts liveness: 409 unit_roster_conflict - nothing restored, no audit', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-race-read', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });
    const read = world.contactsRepo.getManyByIds.bind(world.contactsRepo);
    let added = false;
    world.contactsRepo.getManyByIds = async (contactIds, opts) => {
      // Staff B adds a second landlord-typed contact while the route reads
      // the remaining contacts' liveness for the heir.
      if (contactIds.includes('c-pm') && !added) {
        added = true;
        await world.unitsRepo.addContact(
          'u-race-read',
          { contactId: 'c-owner', role: 'owner' },
          { caseworker: false, landlordTyped: true, autoPrimaryEligible: true },
        );
      }
      return read(contactIds, opts);
    };
```

(The rest of that test - the restore call and its assertions - is unchanged.)

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRestorePrimaryHandoff.test.ts test/unitsRestoreLandlord.test.ts
```

Expected failures: in the new file, the earliest-eligible case (the old
promotion needs exactly one eligible row - two here), all four `liveness
unknown` cases (200 instead of 503), the soft-deleted-new-landlord swap cases
(c-new flagged), and every `assigned(...)` expectation; in the edited file,
`two remaining contacts typed landlord: the EARLIEST-added...`, `a stale
primary_contact naming the cleared landlord does NOT move the primary...`
(today the scalar alone counts the cleared landlord as primary, so the two
eligible rows promote nobody and c-pm's flag is cleared), the one-batch
PIN (`getManyByIds` never called with requireComplete) and the read-race test
(`added` stays false, so the restore succeeds instead of 409).

**Step 3 - implementation.**

(a) `app/src/routes/units.ts` - the propertyContact import (Task S2.4 left
the `autoRoutingEligible` alias for `soleLandlordToPromote`, which (b) below
deletes). old_string:

```ts
import {
  isAutoRoutingEligible,
  isAutoRoutingEligible as autoRoutingEligible,
  readRosterContacts,
} from '../lib/propertyContact.js';
```

new_string:

```ts
import { chooseHeir, isAutoRoutingEligible, readRosterContacts } from '../lib/propertyContact.js';
```

After (b) below, run
`cd W:/tmp/primary-contact-integrity && grep -n "autoRoutingEligible" app/src/routes/units.ts`:
every hit must read `isAutoRoutingEligible`. A bare `autoRoutingEligible`
means a caller was missed - stop and report.

(a2) `app/src/routes/units.ts` - the unitsRepo import gains the shared rule
Task S2.7 (e) exported (plan review R2). Edit, old_string:

```ts
  RosterReadFailedError,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
  RosterReadFailedError,
  RosterWriteConflictError,
  landlordWasPrimary,
  unitContacts,
```

(b) `app/src/routes/units.ts` - replace the `soleLandlordToPromote` helper
WITH its docblock: from the line `  /**` directly above the line that begins
`   * caseworker-integrity spec revision 5, section 4 "Restore" (Cameron's Q5;`
through the helper's closing `  }` (the last line before the blank line that
precedes the comment line beginning `  // GET /api/units`). S1 may have
touched the helper's body (the eligibility call); select the region by those
marker lines. Replacement:

```ts
  /**
   * primary-contact-integrity spec 4.6 ("Restore without a landlord", Cameron
   * 2026-10-13; it replaced caseworker-integrity's sole-landlord promotion):
   * when the restore needs a hand-off - the cleared landlord's row is the
   * flagged primary, or no row is flagged at all (repos/unitsRepo.ts
   * landlordWasPrimary, the rule restoreWithLandlord shares; it never reads
   * the primary_contact scalar) - the heir function
   * (lib/propertyContact.ts chooseHeir) picks who takes over, with the
   * cleared landlord EXCLUDED and no landlord of record left: the
   * earliest-added remaining contact eligible for automatic routing (typed
   * landlord, live, not a routing pointer); nobody when none is.
   * `{ kind: 'unknown' }` when the liveness read (ONE complete batch read,
   * readRosterContacts) failed - the route then refuses with 503
   * roster_read_failed and writes nothing.
   * Decided from `listRead` - the contact list of `unit` (the route's
   * consistent read) taken ONCE, before the liveness read is awaited - which
   * is the very value the restore's write is then conditioned on
   * (`expectContacts`; caseworker-integrity R3 code review finding A3, fix
   * wave 3 FW3-2), so a list change in between answers 409
   * unit_roster_conflict instead of applying a stale pick.
   */
  async function clearedLandlordHeir(
    listRead: UnitItem['contacts'],
    clearedLandlordId: string | undefined,
  ): Promise<{ kind: 'decided'; promote: string | null } | { kind: 'unknown' }> {
    if (clearedLandlordId === undefined) return { kind: 'decided', promote: null };
    // unitContacts' own reading of that one list (the landlordId-derived row
    // when no list is stored).
    const rows = unitContacts({ contacts: listRead, landlordId: clearedLandlordId });
    // The SHARED rule (repos/unitsRepo.ts landlordWasPrimary, plan review
    // R1-R3): hand off when the cleared landlord's row is the flagged primary
    // or no row is flagged; a live flagged row elsewhere is never displaced.
    // It never reads the primary_contact scalar.
    const clearedWasPrimary = landlordWasPrimary(rows, clearedLandlordId);
    if (!clearedWasPrimary) return { kind: 'decided', promote: null };
    const read = await readRosterContacts(
      contacts,
      rows.filter((row) => row.contactId !== clearedLandlordId).map((row) => row.contactId),
      log,
    );
    const heir = chooseHeir({ roster: rows, landlordId: undefined, exclude: clearedLandlordId, read });
    if (heir.kind === 'unknown') return { kind: 'unknown' };
    return { kind: 'decided', promote: heir.kind === 'heir' ? heir.contactId : null };
  }
```

(c) `app/src/routes/units.ts` - the restore handler's header comment. old_string:

```ts
    //   - { landlordId: <id> } restores AND makes that contact (404
    //     landlord_not_found / 409 landlord_not_landlord) the landlord of record;
    //     { landlordId: null } restores ownerless and, when the cleared landlord
    //     was the primary, promotes the one remaining contact typed landlord
    //     (spec revision 5, soleLandlordToPromote). Honored ONLY when the plain
```

new_string:

```ts
    //   - { landlordId: <id> } restores AND makes that contact (404
    //     landlord_not_found / 409 landlord_not_landlord) the landlord of record;
    //     { landlordId: null } restores ownerless. When the old landlord was
    //     the primary, the heir function picks who takes over
    //     (primary-contact-integrity spec 4.6): for { landlordId: null } this
    //     route decides it (clearedLandlordHeir: the earliest-added remaining
    //     contact eligible for automatic routing), for a swap the repo re-runs
    //     it per attempt; unknown liveness answers 503 roster_read_failed and
    //     writes nothing; a hand-off appends unit_primary_contact_assigned
    //     { reason: 'handoff_on_restore' }. Honored ONLY when the plain
```

(d) `app/src/routes/units.ts` - replace the tail of the restore handler: from
the comment line `    // Restore WITHOUT a landlord: the sole-landlord promotion (spec revision`
through the handler's last statement
`    res.json({ unit: { ...restored, contacts: await enrichRoster(restored) } });`
(keep the handler's closing `  });` after it). Replacement:

```ts
    // Restore WITHOUT a landlord (primary-contact-integrity spec 4.6): when the
    // cleared landlord was the primary, the heir function's pick
    // (clearedLandlordHeir) takes over in the same write, and the repo applies
    // it only on the very contact list it was decided from (`expectContacts`) -
    // a contact-list change in between answers 409 unit_roster_conflict. The
    // list is read ONCE, here, before the liveness read is awaited, and that
    // one value is both the decision's input and `expectContacts`
    // (caseworker-integrity R3 code review finding A3, fix wave 3 FW3-2):
    // `stored.contacts` read again after the awaits need not be the list the
    // decision saw (a FakeWorld unit read is the live object a concurrent write
    // replaces it on). Unknown liveness refuses with 503 roster_read_failed
    // before any write. The landlord SWAP decides its heir in the repo instead,
    // per attempt, from the liveness read passed below - its contacts-only
    // races are retried, so a decision made here could go stale.
    const listRead = stored.contacts;
    let promote: string | null = null;
    if (next === null) {
      const decided = await clearedLandlordHeir(listRead, storedLandlordId);
      if (decided.kind === 'unknown') {
        log.warn({ unitId, actor: req.user?.userId }, 'unit restore refused: the liveness read failed');
        res.status(503).json({ error: 'roster_read_failed' });
        return;
      }
      promote = decided.promote;
    }
    const reported: { handoff?: PrimaryHandoff } = {};
    const handoffOpts = {
      readContacts: (ids: string[]) => readRosterContacts(contacts, ids, log),
      onPrimaryHandoff: (handoff: PrimaryHandoff) => {
        reported.handoff = handoff;
      },
    };
    let restored: UnitItem;
    try {
      restored =
        next !== null
          ? await units.restoreWithLandlord(unitId, { expectLandlordId: storedLandlordId, next }, handoffOpts)
          : await units.restoreWithLandlord(
              unitId,
              { expectLandlordId: storedLandlordId, next: null, expectContacts: listRead, promote },
              handoffOpts,
            );
    } catch (err) {
      if (err instanceof RosterReadFailedError) {
        log.warn({ unitId, actor: req.user?.userId }, 'unit restore refused: the liveness read failed');
        res.status(503).json({ error: 'roster_read_failed' });
        return;
      }
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    // The promotion as written: the promoted row is primary in the written unit.
    const primaryPromoted =
      promote !== null &&
      (restored.contacts ?? []).some((row) => row.contactId === promote && row.primaryContact === true);
    await audit.append(`units#${unitId}`, 'unit_restored', {
      actor: req.user?.userId,
      ...(next !== null
        ? { landlordReplaced: { from: storedLandlordId, to: next.contactId } }
        : {
            landlordCleared: { from: storedLandlordId },
            ...(primaryPromoted && { primaryPromoted: { to: promote } }),
          }),
    });
    // The hand-off the restore write itself reported (plan contract 2.4):
    // either branch, whenever an heir was flagged in place of the old landlord.
    const handoff = reported.handoff;
    if (handoff !== undefined) {
      await audit.append(`units#${unitId}`, 'unit_primary_contact_assigned', {
        actor: req.user?.userId,
        contactId: handoff.to,
        reason: 'handoff_on_restore',
        from: handoff.from,
      });
    }
    log.info(
      {
        unitId,
        actor: req.user?.userId,
        landlordCleared: next === null,
        ...(primaryPromoted && { primaryPromoted: promote }),
        ...(handoff !== undefined && { primaryHandedTo: handoff.to }),
      },
      'unit restored via api with a landlord change',
    );
    // The enriched roster (the roster routes' shape) so the Contacts card can
    // apply the new landlord of record in place.
    res.json({ unit: { ...restored, contacts: await enrichRoster(restored) } });
```

(e0) `app/test/helpers/twilioWebhookHarness.ts` - its unitsRepo import gains
the shared rule (plan review R2; the fake calls the real rule, never a twin).
Edit, old_string:

```ts
  RosterReadFailedError,
  RosterWriteConflictError,
  unitContacts,
```

new_string:

```ts
  RosterReadFailedError,
  RosterWriteConflictError,
  landlordWasPrimary,
  unitContacts,
```

(e) `app/test/helpers/twilioWebhookHarness.ts` - replace the fake
`restoreWithLandlord` WITH the comment block above it: from the comment line
`    // caseworker-integrity (spec 2026-10-12 section 4 "Restore"): mirror the`
through the method's closing `    },` (the line before the `  };` that closes
the `unitsRepo` object). Replacement:

```ts
    // caseworker-integrity (spec 2026-10-12 section 4 "Restore"): mirror the
    // real repo - the unit must still be soft-deleted and the stored
    // landlordId must still be the caller's expectation
    // (RosterWriteConflictError otherwise); restore (drop deleted_at), swap or
    // clear the landlord of record, drop the old landlord's row, upsert the new
    // one with role pinned 'landlord', and keep primary_contact consistent
    // through the SAME pure chooseHeir / applyPrimary as the real repo
    // (primary-contact-integrity spec 4.6): a swap of a primary landlord
    // re-runs the heir function (unknown liveness: RosterReadFailedError,
    // nothing written); a clear applies the caller's heir pick, only on the
    // contact list it was decided from.
    async restoreWithLandlord(unitId, input, opts) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`restoreWithLandlord: no unit ${unitId}`);
      // The real repo's read check and its attribute_exists(deleted_at) write
      // condition (R1 code review, backend finding 2): restore never swaps or
      // clears the landlord of a LIVE unit.
      if (!isUnitDeleted(unit)) throw new RosterWriteConflictError();
      const current =
        typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
      if (current !== input.expectLandlordId) throw new RosterWriteConflictError();
      // The real repo's contact-list check: a restore without a landlord
      // applies only to the contact list its heir pick was decided from.
      if (input.next === null && !isDeepStrictEqual(unit.contacts, input.expectContacts)) {
        throw new RosterWriteConflictError();
      }
      const old = input.expectLandlordId;
      const next = input.next;
      const promote = input.next === null ? input.promote : null;
      const keepsOld = next !== null && next.contactId === old;
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      // The SHARED rule (landlordWasPrimary, plan review R1-R3) - the real
      // repo's decision exactly, never a twin: hand off when the old
      // landlord's row is the flagged primary or no row is flagged; the scalar
      // is never read.
      const oldWasPrimary =
        old !== undefined && !keepsOld && landlordWasPrimary(roster, old);
      let nextRoster: UnitContact[] =
        old !== undefined && !keepsOld ? roster.filter((c) => c.contactId !== old) : roster;
      if (next !== null) {
        const seated = nextRoster.find((c) => c.contactId === next.contactId);
        if (seated) {
          seated.role = 'landlord';
          if (next.name !== undefined) seated.name = next.name;
          if (next.company !== undefined) seated.company = next.company;
        } else {
          nextRoster.push({
            contactId: next.contactId,
            role: 'landlord',
            primaryContact: false,
            ...(next.name !== undefined ? { name: next.name } : {}),
            ...(next.company !== undefined ? { company: next.company } : {}),
          });
        }
      }
      let scalar: string | null | undefined;
      let heirId: string | undefined;
      if (oldWasPrimary) {
        if (next !== null) {
          const read: RosterContactsRead =
            opts?.readContacts !== undefined
              ? await opts.readContacts(
                  rosterContactIds({ contacts: nextRoster, landlordId: next.contactId }).filter(
                    (id) => id !== old,
                  ),
                )
              : { ok: false };
          const heir = chooseHeir({ roster: nextRoster, landlordId: next.contactId, exclude: old, read });
          if (heir.kind === 'unknown') throw new RosterReadFailedError();
          const applied = applyPrimary(
            nextRoster,
            heir.kind === 'heir' ? { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow } : null,
          );
          nextRoster = applied.contacts;
          scalar = applied.primaryContactScalar;
          heirId = heir.kind === 'heir' ? heir.contactId : undefined;
        } else {
          const promoted = promote === null ? undefined : nextRoster.find((c) => c.contactId === promote);
          const applied = applyPrimary(
            nextRoster,
            promoted !== undefined ? { contactId: promoted.contactId, addLandlordRow: false } : null,
          );
          nextRoster = applied.contacts;
          scalar = applied.primaryContactScalar;
          heirId = promoted?.contactId;
        }
      } else {
        // No hand-off: align the scalar with the stored FLAG, never reading
        // the old scalar (mirrors the real repo).
        const flagged = nextRoster.find((c) => c.primaryContact === true);
        scalar = flagged !== undefined ? flagged.contactId : null;
      }
      unit.contacts = nextRoster;
      if (scalar === null) delete unit.primary_contact; // null -> REMOVE; never dangling
      else if (scalar !== undefined) unit.primary_contact = scalar;
      if (next !== null) unit.landlordId = next.contactId;
      else delete (unit as Partial<UnitItem>).landlordId;
      delete unit.deleted_at;
      unit.updated_at = new Date().toISOString();
      if (heirId !== undefined && old !== undefined) opts?.onPrimaryHandoff?.({ from: old, to: heirId });
      return unit;
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRestorePrimaryHandoff.test.ts test/unitsRestoreLandlord.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiPrimaryOnAdd.test.ts test/unitsApiPrimaryOnRemove.test.ts test/unitsApi.test.ts
```

Expected: all pass.

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0 (no reference to `soleLandlordToPromote` is left; if the
compiler names one, it is a comment-free call site this task missed - the
only caller was the restore handler tail replaced in (d)).

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/routes/units.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/unitsRestoreLandlord.test.ts` modified; the new test untracked; no
`.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsRestorePrimaryHandoff.test.ts app/test/unitsRestoreLandlord.test.ts && git commit -m "feat(units): restores hand the primary through the heir function (earliest eligible), 503 on unknown liveness, audit handoff_on_restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.9 - `unitsRepo.handOffPrimaryFrom` and `list({ consistentRead })`; the fake mirrors both

Files:
- Modify: `app/src/repos/unitsRepo.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (adds the fake
  `handOffPrimaryFrom` ONLY)
- Create: `app/test/unitsRepoHandOffPrimary.integration.test.ts`

DynamoDB Local: REQUIRED.

**Step 1 - the failing test.** Create
`app/test/unitsRepoHandOffPrimary.integration.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"; plan contract 2.2): the real unitsRepo.handOffPrimaryFrom and the
// consistent Scan against DynamoDB Local. handOffPrimaryFrom(unit, deleted,
// read) re-reads the unit CONSISTENTLY, re-checks that `deleted` is STILL the
// flagged primary (else not_primary), runs the heir function with that
// contact EXCLUDED and never read, and: heir -> moves the flag AND the scalar
// in one conditional write (moved); no heir -> nothing changes (unchanged);
// failed read -> nothing changes (unknown). A lost conditional write re-reads,
// re-checks and re-decides, bounded at three attempts
// (RosterWriteConflictError). list({ consistentRead: true }) sends
// ConsistentRead on its Scan.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createUnitsRepo, RosterWriteConflictError, type UnitContact } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[unitsRepoHandOffPrimary.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';

function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

function livenessFrom(known: ContactItem[]): {
  read: (ids: string[]) => Promise<RosterContactsRead>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return {
    calls,
    read: async (ids) => {
      calls.push([...ids]);
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return { ok: true, byId: found };
    },
  };
}

const failedRead = async (): Promise<RosterContactsRead> => ({ ok: false });

describe.skipIf(!reachable)('unitsRepo.handOffPrimaryFrom + list({ consistentRead }) (spec 4.6) against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function ownerlessUnit(contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({ landlordId: 'c-temp', status: 'available' });
    await units.update(created.unitId, {
      landlordId: null,
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  async function ownedUnit(landlordId: string, contacts: UnitContact[], primary?: string): Promise<string> {
    const created = await units.create({
      landlordId,
      status: 'available',
      contacts,
      ...(primary !== undefined && { primary_contact: primary }),
    });
    return created.unitId;
  }

  /** A repo whose FIRST read of `unitId` is followed by `race`; counts writes and unit reads. */
  function racingRepo(unitId: string, race: () => Promise<unknown>) {
    const counter = { writes: 0, unitReads: [] as Array<boolean | undefined> };
    let raced = false;
    const racingDoc = Object.create(doc) as typeof doc;
    racingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      const result = await doc.send(command);
      if (command instanceof GetCommand && command.input.Key?.['unitId'] === unitId) {
        counter.unitReads.push(command.input.ConsistentRead);
        if (!raced) {
          raced = true;
          await race();
        }
      }
      return result;
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: racingDoc, env: testEnv, logger }), counter };
  }

  /** Overwrite a unit's contacts (and optionally its scalar) on the raw client. */
  function rawRosterWrite(unitId: string, contacts: UnitContact[], primary?: string) {
    return doc.send(
      new UpdateCommand({
        TableName: tableName('units', testEnv),
        Key: { unitId },
        UpdateExpression: primary !== undefined ? 'SET #c = :c, #p = :p' : 'SET #c = :c',
        ExpressionAttributeNames: {
          '#c': 'contacts',
          ...(primary !== undefined && { '#p': 'primary_contact' }),
        },
        ExpressionAttributeValues: { ':c': contacts, ...(primary !== undefined && { ':p': primary }) },
      }),
    );
  }

  it('moved: the live landlord of record takes over; the deleted contact keeps its row, unflagged', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
      ],
      'c-d',
    );
    const liveness = livenessFrom([person('c-ll')]);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-ll' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-d', role: 'pm', primaryContact: false },
    ]);
    expect(stored?.primary_contact).toBe('c-ll');
    // The deleted contact is EXCLUDED and never read (spec 4.2).
    expect(liveness.calls.flat()).not.toContain('c-d');
    expect(liveness.calls.flat()).toContain('c-ll');
  });

  it('moved: an off-roster landlord of record gets a landlord row as the primary', async () => {
    const unitId = await ownedUnit('c-ll', [{ contactId: 'c-d', role: 'pm', primaryContact: true }], 'c-d');

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-ll')]).read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-ll' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toHaveLength(2);
    expect(stored?.contacts).toContainEqual({ contactId: 'c-d', role: 'pm', primaryContact: false });
    expect(stored?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(stored?.primary_contact).toBe('c-ll');
  });

  it('moved: no landlord - the earliest-added eligible contact (a caseworker and a tenant are skipped)', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );

    const result = await units.handOffPrimaryFrom(
      unitId,
      'c-d',
      livenessFrom([person('c-cw', { type: 'partner', role: 'Caseworker' }), person('c-ten', { type: 'tenant' }), person('c-own')])
        .read,
    );

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-own' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual([
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
    ]);
    expect(stored?.primary_contact).toBe('c-own');
  });

  it('a soft-deleted unit is handed off too', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    await units.softDelete(unitId, GONE);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-own' });
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBe(GONE);
    expect(stored?.primary_contact).toBe('c-own');
  });

  it('unchanged: no live non-excluded candidate - nothing written, the deleted contact stays flagged', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ];
    const unitId = await ownerlessUnit(roster, 'c-d');
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-ten', { type: 'tenant' })]).read);

    expect(result).toEqual({ outcome: 'unchanged' });
    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
    expect(stored?.primary_contact).toBe('c-d');
  });

  it('unknown: the liveness read failed - nothing written', async () => {
    const roster: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: true },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
    ];
    const unitId = await ownerlessUnit(roster, 'c-d');
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', failedRead);

    expect(result).toEqual({ outcome: 'unknown' });
    expect(counter.writes).toBe(0);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(roster);
  });

  it('not_primary: the contact holds a row that is not the primary - nothing read, nothing written', async () => {
    const unitId = await ownedUnit(
      'c-ll',
      [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
      'c-ll',
    );
    const liveness = livenessFrom([person('c-ll')]);

    const result = await units.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toEqual({ outcome: 'not_primary' });
    expect(liveness.calls).toEqual([]);
  });

  it('not_primary: a unit that does not exist', async () => {
    const result = await units.handOffPrimaryFrom(`unit-missing-${randomUUID()}`, 'c-d', failedRead);
    expect(result).toEqual({ outcome: 'not_primary' });
  });

  it('(PIN) reads the unit CONSISTENTLY', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const { repo, counter } = racingRepo(unitId, async () => undefined);

    await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read);

    expect(counter.unitReads).toEqual([true]);
  });

  it('a lost write re-reads and re-checks: someone already moved the primary -> not_primary, nothing more written', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const moved: UnitContact[] = [
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: false },
      { contactId: 'c-other', role: 'pm', primaryContact: true },
    ];
    const { repo, counter } = racingRepo(unitId, () => rawRosterWrite(unitId, moved, 'c-other'));

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own'), person('c-other')]).read);

    expect(result).toEqual({ outcome: 'not_primary' });
    expect(counter.writes).toBe(1);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.contacts).toEqual(moved);
    expect(stored?.primary_contact).toBe('c-other');
  });

  it('a lost write re-decides from the new roster', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    const { repo } = racingRepo(unitId, () =>
      rawRosterWrite(unitId, [
        { contactId: 'c-first', role: 'owner', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ]),
    );
    const liveness = livenessFrom([person('c-first'), person('c-own')]);

    const result = await repo.handOffPrimaryFrom(unitId, 'c-d', liveness.read);

    expect(result).toMatchObject({ outcome: 'moved', to: 'c-first' });
    expect(liveness.calls).toHaveLength(2);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBe('c-first');
  });

  it('gives up after 3 lost writes: RosterWriteConflictError, nothing of its own written', async () => {
    const unitId = await ownerlessUnit(
      [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
      ],
      'c-d',
    );
    let writes = 0;
    const contendedDoc = Object.create(doc) as typeof doc;
    contendedDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) {
        writes += 1;
        // A racer changes the roster right before every write of ours lands.
        await rawRosterWrite(unitId, [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-own', role: 'owner', primaryContact: false },
          { contactId: `c-late-${writes}`, role: 'other', primaryContact: false },
        ]);
      }
      return doc.send(command);
    }) as typeof doc.send;
    const contended = createUnitsRepo({ doc: contendedDoc, env: testEnv, logger });

    await expect(
      contended.handOffPrimaryFrom(unitId, 'c-d', livenessFrom([person('c-own')]).read),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);

    expect(writes).toBe(3);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.primary_contact).toBe('c-d');
    expect(stored?.contacts?.find((c) => c.contactId === 'c-d')?.primaryContact).toBe(true);
  });

  it('list({ consistentRead: true }) sends a consistent Scan; the default Scan does not', async () => {
    await units.create({ landlordId: 'c-scan', status: 'available' });
    const scans: Array<Record<string, unknown>> = [];
    const spyDoc = Object.create(doc) as typeof doc;
    spyDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof ScanCommand) scans.push(command.input as Record<string, unknown>);
      return doc.send(command);
    }) as typeof doc.send;
    const spied = createUnitsRepo({ doc: spyDoc, env: testEnv, logger });

    const consistent = await spied.list({ deleted: 'any', consistentRead: true, limit: 1 });
    await spied.list({ deleted: 'any', limit: 1 });

    expect(consistent.items).toHaveLength(1);
    expect(scans[0]).toMatchObject({ ConsistentRead: true });
    expect(scans[1]).not.toHaveProperty('ConsistentRead');
  });
});
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoHandOffPrimary.integration.test.ts
```

Expected: every `handOffPrimaryFrom` test fails with
`TypeError: units.handOffPrimaryFrom is not a function` (or `repo.` /
`contended.`), and the list test fails (`scans[0]` has no `ConsistentRead`).

**Step 3 - implementation.**

(a) `app/src/repos/unitsRepo.ts` - interface: `list` gains the option.
old_string:

```ts
  list(opts?: ListUnitsOpts): Promise<UnitsPage>;
```

new_string:

```ts
  list(
    opts?: ListUnitsOpts & {
      /**
       * primary-contact-integrity (spec 2026-10-12 section 4.6): a strongly
       * consistent Scan (`ConsistentRead`) - the contact-delete hand-off
       * decides what to write from it. On `list` only: the GSI list methods
       * share ListUnitsOpts, and DynamoDB rejects ConsistentRead on a GSI.
       */
      consistentRead?: boolean;
    },
  ): Promise<UnitsPage>;
```

(b) `app/src/repos/unitsRepo.ts` - interface: the new method, after
`restoreWithLandlord` (whose signature task S2.7 wrote). old_string:

```ts
  restoreWithLandlord(
    unitId: string,
    input: RestoreWithLandlordInput,
    opts?: RosterHandoffOpts,
  ): Promise<UnitItem>;
}
```

new_string:

```ts
  restoreWithLandlord(
    unitId: string,
    input: RestoreWithLandlordInput,
    opts?: RosterHandoffOpts,
  ): Promise<UnitItem>;
  /**
   * primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
   * contact"): hand a unit's primary away from `fromContactId`, a contact the
   * caller has just soft-deleted. Reads the unit CONSISTENTLY and first
   * re-checks that `fromContactId` is STILL its flagged primary
   * (unitContacts(); else 'not_primary', nothing read or written - a unit
   * that no longer exists answers the same). Then the heir function
   * (lib/propertyContact.ts chooseHeir) with `fromContactId` EXCLUDED - its id
   * is left out of the ids passed to `readContacts`, so the eventually
   * consistent batch read never answers it live (spec 4.2):
   *   heir    -> ONE conditional write (updateRosterIfCurrent, fenced on the
   *              landlordId and contacts[] read) moves the flag AND the scalar
   *              to it (applyPrimary; an off-roster landlord heir gets its
   *              row): { outcome: 'moved', unit, to };
   *   none    -> nothing changes - the deleted contact stays flagged, so a
   *              later restore of the contact leaves the unit as it was:
   *              { outcome: 'unchanged' };
   *   unknown -> nothing changes: { outcome: 'unknown' }.
   * A lost conditional write re-reads, re-checks and re-decides, bounded at
   * ROSTER_WRITE_MAX_ATTEMPTS, then RosterWriteConflictError. The deleted
   * contact's own row stays on the roster.
   */
  handOffPrimaryFrom(
    unitId: string,
    fromContactId: string,
    readContacts: ReadRosterContacts,
  ): Promise<PrimaryHandOffResult>;
}
```

(c) `app/src/repos/unitsRepo.ts` - `list` implementation. old_string:

```ts
      const input: ScanCommandInput = {
        TableName: table,
```

new_string:

```ts
      const input: ScanCommandInput = {
        TableName: table,
        // A strongly consistent Scan on request (primary-contact-integrity
        // spec 4.6: the contact-delete hand-off decides writes from it).
        ...(opts.consistentRead === true && { ConsistentRead: true }),
```

(d) `app/src/repos/unitsRepo.ts` - the implementation of the new method,
appended as the LAST method of the object returned by `createUnitsRepo`.
old_string:

```ts
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
```

new_string:

```ts
    async handOffPrimaryFrom(unitId, fromContactId, readContacts) {
      let attempts = 0;
      const attempt = async (): Promise<PrimaryHandOffResult> => {
        attempts += 1;
        // CONSISTENT: the re-check and the heir are decided on this read, and
        // the write is fenced on it.
        const unit = await this.getById(unitId, { consistentRead: true });
        if (!unit) return { outcome: 'not_primary' };
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const flagged = roster.find((c) => c.primaryContact === true);
        // Re-check first: someone may already have moved it (done).
        if (flagged === undefined || flagged.contactId !== fromContactId) return { outcome: 'not_primary' };
        const landlordOfRecord =
          typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
        // The deleted contact is EXCLUDED and never read (spec 4.2).
        const read = await readContacts(rosterContactIds(unit).filter((id) => id !== fromContactId));
        const heir = chooseHeir({ roster, landlordId: landlordOfRecord, exclude: fromContactId, read });
        if (heir.kind === 'unknown') return { outcome: 'unknown' };
        if (heir.kind === 'none') return { outcome: 'unchanged' };
        const applied = applyPrimary(roster, { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow });
        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, {
            contacts: applied.contacts,
            primary_contact: applied.primaryContactScalar,
          });
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) throw new RosterWriteConflictError();
          // The unit changed since this attempt's read: re-read, re-check
          // that the contact is still the primary, and decide again.
          return attempt();
        }
        log.info(
          { unitId, attempts, from: fromContactId, to: heir.contactId },
          'unit primary handed off from a deleted contact',
        );
        return { outcome: 'moved', unit: updated, to: heir.contactId };
      };
      return attempt();
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
```

(e) `app/test/helpers/twilioWebhookHarness.ts` - add the fake method right
after the fake `restoreWithLandlord` (whose last lines task S2.8 wrote).
old_string:

```ts
      if (heirId !== undefined && old !== undefined) opts?.onPrimaryHandoff?.({ from: old, to: heirId });
      return unit;
    },
```

new_string:

```ts
      if (heirId !== undefined && old !== undefined) opts?.onPrimaryHandoff?.({ from: old, to: heirId });
      return unit;
    },
    // primary-contact-integrity (spec 2026-10-12 section 4.6, contact delete):
    // mirror the real repo - re-check that `fromContactId` is STILL the
    // flagged primary (else not_primary), read liveness WITHOUT that contact,
    // and run the SAME pure chooseHeir / applyPrimary with it excluded:
    // heir -> moved (flag and scalar), none -> unchanged, unknown -> unknown.
    // (The fake's list() ignores `consistentRead`: in memory is consistent.)
    async handOffPrimaryFrom(unitId, fromContactId, readContacts) {
      const unit = units.get(unitId);
      if (!unit) return { outcome: 'not_primary' };
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const flagged = roster.find((c) => c.primaryContact === true);
      if (flagged === undefined || flagged.contactId !== fromContactId) return { outcome: 'not_primary' };
      const landlordOfRecord =
        typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
      const read = await readContacts(rosterContactIds(unit).filter((id) => id !== fromContactId));
      const heir = chooseHeir({ roster, landlordId: landlordOfRecord, exclude: fromContactId, read });
      if (heir.kind === 'unknown') return { outcome: 'unknown' };
      if (heir.kind === 'none') return { outcome: 'unchanged' };
      const applied = applyPrimary(roster, { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow });
      unit.contacts = applied.contacts;
      if (applied.primaryContactScalar === null) delete unit.primary_contact;
      else unit.primary_contact = applied.primaryContactScalar;
      unit.updated_at = new Date().toISOString();
      return { outcome: 'moved', unit, to: heir.contactId };
    },
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsRepoHandOffPrimary.integration.test.ts test/caseworkerRepoParity.integration.test.ts test/contactHoldings.test.ts test/orgRecords.test.ts
```

Expected: all pass (the last three use `units.list` and must be unaffected).

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/repos/unitsRepo.ts` and
`app/test/helpers/twilioWebhookHarness.ts` modified, the new test untracked;
no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/unitsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsRepoHandOffPrimary.integration.test.ts && git commit -m "feat(units): handOffPrimaryFrom for the contact-delete hand-off; list supports a consistent Scan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.10 - the contact-delete hand-off service (`services/primaryHandoff.ts`)

Files:
- Create: `app/src/services/primaryHandoff.ts`
- Create: `app/test/primaryHandoffService.test.ts`

DynamoDB Local: not needed (FakeWorld repos).

**Step 1 - the failing test.** Create `app/test/primaryHandoffService.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"): services/primaryHandoff.ts on the FakeWorld repos. ONE
// consistent Scan over live AND soft-deleted units finds every unit whose
// flagged primary is the deleted contact; each is handed off through
// unitsRepo.handOffPrimaryFrom with the deleted contact excluded and never
// read: moved -> unit_primary_contact_assigned { reason: 'handoff_on_delete',
// from }; unchanged / not_primary -> nothing; unknown -> skipped with a WARN.
// Best-effort as a whole: a Scan failure, a unit whose hand-off throws and a
// failed audit append are logged and skipped - it never throws.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem } from '../src/repos/unitsRepo.js';
import { handOffPrimariesOfDeletedContact, type PrimaryHandoffDeps } from '../src/services/primaryHandoff.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-13T09:00:00.000Z';
const ACTOR = 'usr-deleter';

function setup(): {
  world: FakeWorld;
  deps: PrimaryHandoffDeps;
  capture: ReturnType<typeof createLogCapture>;
} {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const deps: PrimaryHandoffDeps = {
    units: world.unitsRepo,
    contacts: world.contactsRepo,
    audit: world.auditRepo,
    logger: createLogger({ destination: capture.stream }),
  };
  return { world, deps, capture };
}

/** A unit with NO landlordId unless `fields` sets one (fields are cloned: units never share a roster array). */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...structuredClone(fields),
  } as UnitItem);
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...fields } as ContactItem);
}

/** c-d (the deleted contact) flagged primary, c-p an eligible second row. */
const D_PRIMARY: UnitContact[] = [
  { contactId: 'c-d', role: 'pm', primaryContact: true },
  { contactId: 'c-p', role: 'pm', primaryContact: false },
];

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('handOffPrimariesOfDeletedContact (spec 4.6)', () => {
  it('follows every consistent Scan page over live and deleted units, hands each target off and audits each move', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-other', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: true }],
    });
    seedUnit(world, 'u-2', { contacts: D_PRIMARY, primary_contact: 'c-d', deleted_at: STAMP });
    seedUnit(world, 'u-seat', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
    });
    seedUnit(world, 'u-3', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    const scan = vi.spyOn(world.unitsRepo, 'list').mockImplementation((options) => realList({ ...options, limit: 2 }));

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(scan).toHaveBeenCalledTimes(3);
    for (const [options] of scan.mock.calls) expect(options).toMatchObject({ deleted: 'any', consistentRead: true });
    expect(summary).toEqual({
      targets: ['u-1', 'u-2', 'u-3'],
      moved: ['u-1', 'u-2', 'u-3'],
      unchanged: [],
      notPrimary: [],
      unknown: [],
      failed: [],
      scanFailed: false,
    });
    for (const unitId of ['u-1', 'u-2', 'u-3']) {
      expect(world.units.get(unitId)?.contacts).toEqual([
        { contactId: 'c-d', role: 'pm', primaryContact: false },
        { contactId: 'c-p', role: 'pm', primaryContact: true },
      ]);
      expect(world.units.get(unitId)?.primary_contact).toBe('c-p');
    }
    expect(assigned(world)).toEqual(
      ['u-1', 'u-2', 'u-3'].map((unitId) => ({
        entityKey: `units#${unitId}`,
        event_type: 'unit_primary_contact_assigned',
        actorId: ACTOR,
        payload: { actor: ACTOR, contactId: 'c-p', reason: 'handoff_on_delete', from: 'c-d' },
      })),
    );
    // A unit where the contact merely holds a non-primary seat is not a target.
    expect(world.units.get('u-seat')?.contacts?.[0]?.primaryContact).toBe(true);
  });

  it('no heir: unchanged - nothing written, no audit', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedUnit(world, 'u-1', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const before = structuredClone(world.units.get('u-1'));

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.unchanged).toEqual(['u-1']);
    expect(world.units.get('u-1')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)('liveness unknown (%s): the unit is skipped with a WARN, untouched', async (_shape, make) => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const before = structuredClone(world.units.get('u-1'));
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.unknown).toEqual(['u-1']);
    expect(world.units.get('u-1')).toEqual(before);
    expect(assigned(world)).toEqual([]);
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff skipped - the liveness read failed'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-1' });
  });

  it('a unit whose hand-off throws is logged and skipped; the others are handed off; it never throws', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-a', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-b', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const real = world.unitsRepo.handOffPrimaryFrom.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'handOffPrimaryFrom').mockImplementation(async (unitId, from, read) => {
      if (unitId === 'u-a') throw new Error('boom');
      return real(unitId, from, read);
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.failed).toEqual(['u-a']);
    expect(summary.moved).toEqual(['u-b']);
    expect(world.units.get('u-a')?.primary_contact).toBe('c-d');
    expect(world.units.get('u-b')?.primary_contact).toBe('c-p');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff failed for a unit (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-a' });
  });

  it('a Scan failure is logged and resolves; the targets found before it are still handed off', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    seedUnit(world, 'u-2', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    let pages = 0;
    vi.spyOn(world.unitsRepo, 'list').mockImplementation(async (options) => {
      pages += 1;
      if (pages > 1) throw new Error('scan throttled');
      return realList({ ...options, limit: 1 });
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.scanFailed).toBe(true);
    expect(summary.targets).toEqual(['u-1']);
    expect(summary.moved).toEqual(['u-1']);
    expect(world.units.get('u-2')?.primary_contact).toBe('c-d');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff scan failed (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', found: 1 });
  });

  it('an audit append that fails is logged, never thrown; the move stands', async () => {
    const { world, deps, capture } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    world.failAuditAppendFor.add('unit_primary_contact_assigned');

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.moved).toEqual(['u-1']);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
    expect(
      capture.atLevel(40).find((l) => l['msg'] === 'contact delete: primary handoff audit append failed (best-effort)'),
    ).toMatchObject({ contactId: 'c-d', unitId: 'u-1' });
  });

  it('never reads the deleted contact for liveness', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', {
      landlordId: 'c-d',
      contacts: [
        { contactId: 'c-d', role: 'landlord', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(batchRead).toHaveBeenCalled();
    for (const [ids] of batchRead.mock.calls) expect(ids).not.toContain('c-d');
    // The deleted landlord of record is excluded at step 1, so the eligible row takes over.
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
  });

  it('a primary someone else moved between the Scan and the hand-off is not_primary - left as they set it', async () => {
    const { world, deps } = setup();
    seedContact(world, 'c-d', { deleted_at: GONE });
    seedContact(world, 'c-p');
    seedContact(world, 'c-other');
    seedUnit(world, 'u-1', { contacts: D_PRIMARY, primary_contact: 'c-d' });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'list').mockImplementation(async (options) => {
      const page = await realList(options);
      // Staff B moves the primary after the Scan read the unit (a NEW array,
      // so the Scan's copy still shows c-d as the primary).
      const live = world.units.get('u-1')!;
      live.contacts = [
        { contactId: 'c-d', role: 'pm', primaryContact: false },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
        { contactId: 'c-other', role: 'pm', primaryContact: true },
      ];
      live.primary_contact = 'c-other';
      return page;
    });

    const summary = await handOffPrimariesOfDeletedContact(deps, 'c-d', ACTOR);

    expect(summary.targets).toEqual(['u-1']);
    expect(summary.notPrimary).toEqual(['u-1']);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-other');
    expect(assigned(world)).toEqual([]);
  });
});
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/primaryHandoffService.test.ts
```

Expected: the suite fails to load - `Failed to load url ../src/services/primaryHandoff.js`
(or `Cannot find module`).

**Step 3 - implementation.** Create `app/src/services/primaryHandoff.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact"; plan contract 2.2): after DELETE /api/contacts/:id has persisted
// the soft delete, hand every property whose primary contact was that
// contact to its heir.
//
// ONE strongly consistent Scan of the units table - live AND soft-deleted
// units (`deleted: 'any'`), `consistentRead` (unitsRepo.list's Scan is
// eventually consistent by default) - finds every unit whose unitContacts()
// primary row is the deleted contact. There is no roster index; the
// caseworker conversion accepts the same Scan (services/contactHoldings.ts
// rosterUnitIds). Each target is handed off by unitsRepo.handOffPrimaryFrom:
// a consistent re-read, a re-check that the contact is STILL the flagged
// primary, the heir function with the deleted contact EXCLUDED - and never
// read: the batch read is eventually consistent and could still answer it
// live (spec 4.2) - and the bounded conditional retries. Per unit:
//   moved       -> unit_primary_contact_assigned { contactId: <heir>,
//                  reason: 'handoff_on_delete', from: <deleted contact> };
//   unchanged   -> nothing: no heir, so the deleted contact stays flagged
//                  (P1 skips it, the property box says so, the next eligible
//                  add promotes) - and restoring the contact then leaves the
//                  property exactly as it was;
//   not_primary -> nothing: someone already moved it;
//   unknown     -> skipped with a WARN (the liveness read failed).
//
// BEST-EFFORT AS A WHOLE, the posture of the delete's presence fan-out
// (routes/contacts.ts propagateContactPresenceChange): the delete has already
// persisted, so nothing here throws - a Scan failure, a unit whose hand-off
// throws (RosterWriteConflictError after its retries included) and a failed
// audit append are each logged with the unit id and skipped. PII (doc section
// 9): ids and counts only in logs.
import { readRosterContacts } from '../lib/propertyContact.js';
import type { Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type PrimaryHandOffResult, type UnitsRepo } from '../repos/unitsRepo.js';

export interface PrimaryHandoffDeps {
  units: Pick<UnitsRepo, 'list' | 'handOffPrimaryFrom'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  audit: Pick<AuditRepo, 'append'>;
  logger: Logger;
}

/** What one delete hand-off did, by unit id (ids only - spec section 9 PII). */
export interface DeletedContactHandoffSummary {
  /** Units whose flagged primary was the contact when the Scan read them, in Scan order. */
  targets: string[];
  moved: string[];
  unchanged: string[];
  notPrimary: string[];
  unknown: string[];
  /** The hand-off threw for these units (logged, skipped). */
  failed: string[];
  /** The Scan failed partway; `targets` holds what it found before that. */
  scanFailed: boolean;
}

/**
 * Hand every unit whose primary is `contactId` (just soft-deleted) to its
 * heir - see the file header. `actor` is the deleting user (audit). Never
 * throws.
 */
export async function handOffPrimariesOfDeletedContact(
  deps: PrimaryHandoffDeps,
  contactId: string,
  actor: string | undefined,
): Promise<DeletedContactHandoffSummary> {
  const log = deps.logger;
  const summary: DeletedContactHandoffSummary = {
    targets: [],
    moved: [],
    unchanged: [],
    notPrimary: [],
    unknown: [],
    failed: [],
    scanFailed: false,
  };
  try {
    let key: Record<string, unknown> | undefined;
    do {
      const page = await deps.units.list({
        deleted: 'any',
        consistentRead: true,
        ...(key !== undefined && { exclusiveStartKey: key }),
      });
      for (const unit of page.items) {
        const primary = unitContacts(unit).find((row) => row.primaryContact === true);
        if (primary !== undefined && primary.contactId === contactId) summary.targets.push(unit.unitId);
      }
      key = page.lastEvaluatedKey;
    } while (key !== undefined);
  } catch (err) {
    summary.scanFailed = true;
    log.warn(
      { err, contactId, found: summary.targets.length },
      'contact delete: primary handoff scan failed (best-effort)',
    );
  }
  // The deleted contact is never read (spec 4.2); the repo leaves it out too.
  const readContacts = (ids: string[]) =>
    readRosterContacts(
      deps.contacts,
      ids.filter((id) => id !== contactId),
      log,
    );
  for (const unitId of summary.targets) {
    let result: PrimaryHandOffResult;
    try {
      result = await deps.units.handOffPrimaryFrom(unitId, contactId, readContacts);
    } catch (err) {
      summary.failed.push(unitId);
      log.warn({ err, contactId, unitId }, 'contact delete: primary handoff failed for a unit (best-effort)');
      continue;
    }
    switch (result.outcome) {
      case 'moved':
        summary.moved.push(unitId);
        try {
          await deps.audit.append(`units#${unitId}`, 'unit_primary_contact_assigned', {
            actor,
            contactId: result.to,
            reason: 'handoff_on_delete',
            from: contactId,
          });
        } catch (err) {
          log.warn(
            { err, contactId, unitId },
            'contact delete: primary handoff audit append failed (best-effort)',
          );
        }
        break;
      case 'unchanged':
        summary.unchanged.push(unitId);
        break;
      case 'not_primary':
        summary.notPrimary.push(unitId);
        break;
      case 'unknown':
        summary.unknown.push(unitId);
        log.warn({ contactId, unitId }, 'contact delete: primary handoff skipped - the liveness read failed');
        break;
    }
  }
  if (summary.targets.length > 0 || summary.scanFailed) {
    log.info(
      {
        contactId,
        targets: summary.targets.length,
        moved: summary.moved,
        unchanged: summary.unchanged,
        notPrimary: summary.notPrimary,
        unknown: summary.unknown,
        failed: summary.failed,
        scanFailed: summary.scanFailed,
      },
      'contact delete: primary handoff done',
    );
  }
  return summary;
}
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/primaryHandoffService.test.ts
```

Expected: all pass.

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: the two new files untracked, nothing else changed; no
`.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/services/primaryHandoff.ts app/test/primaryHandoffService.test.ts && git commit -m "feat(contacts): best-effort primary hand-off service for a deleted contact (consistent Scan, heir per unit)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.11 - wire the hand-off into `DELETE /api/contacts/:id`; contact restore changes no roster

Files:
- Modify: `app/src/routes/contacts.ts` (one import + the DELETE handler ONLY)
- Create: `app/test/contactDeletePrimaryHandoff.test.ts`

DynamoDB Local: not needed.

**Step 1 - the failing test.** Create
`app/test/contactDeletePrimaryHandoff.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact" and "Restore a contact") through the contacts routes on the
// FakeWorld harness. DELETE /api/contacts/:id, after the soft delete
// persists, hands every property whose primary contact was that contact to
// its heir (services/primaryHandoff.ts: one consistent Scan over live and
// soft-deleted units, the deleted contact excluded and never read) -
// best-effort: a failed liveness read or a failing unit never fails the
// delete. No heir changes nothing, so delete-then-restore is lossless; POST
// /api/contacts/:id/restore changes no roster.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';

const auth = (req: request.Test) => req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

/** A unit with NO landlordId unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  } as UnitItem);
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', status: 'active', ...fields } as ContactItem);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('DELETE /api/contacts/:id - the primary hand-off (spec 4.6)', () => {
  it('moves the primary to the heir in the same request - flag and scalar - audited handoff_on_delete', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d', { firstName: 'Mark' });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-1')?.contacts).toEqual([
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-p', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-p',
          reason: 'handoff_on_delete',
          from: 'c-d',
        },
      },
    ]);
  });

  it('a live landlord of record takes over, on a soft-deleted unit too', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-ll');
    seedUnit(world, 'u-2', {
      landlordId: 'c-ll',
      deleted_at: STAMP,
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-d',
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-2')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-d', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-2')?.primary_contact).toBe('c-ll');
  });

  it('no heir: nothing changes - and restoring the contact leaves the property exactly as it was', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedUnit(world, 'u-3', {
      contacts: [{ contactId: 'c-d', role: 'pm', primaryContact: true }],
      primary_contact: 'c-d',
    });
    const before = structuredClone(world.units.get('u-3'));

    const del = await auth(request(app).delete('/api/contacts/c-d'));
    expect(del.status).toBe(200);
    expect(world.units.get('u-3')).toEqual(before);

    const back = await auth(request(app).post('/api/contacts/c-d/restore'));
    expect(back.status).toBe(200);
    expect(world.units.get('u-3')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): the delete still succeeds; the unit is skipped with a WARN',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedContact(world, 'c-d');
      seedContact(world, 'c-p');
      seedUnit(world, 'u-4', {
        contacts: [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-p', role: 'pm', primaryContact: false },
        ],
        primary_contact: 'c-d',
      });
      const before = structuredClone(world.units.get('u-4'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const del = await auth(request(app).delete('/api/contacts/c-d'));

      expect(del.status).toBe(200);
      expect(typeof del.body.contact.deleted_at).toBe('string');
      expect(world.units.get('u-4')).toEqual(before);
      expect(
        capture
          .atLevel(40)
          .find((l) => l['msg'] === 'contact delete: primary handoff skipped - the liveness read failed'),
      ).toMatchObject({ contactId: 'c-d', unitId: 'u-4' });
    },
  );

  it('one unit failing does not fail the delete; the others are handed off', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    for (const unitId of ['u-a', 'u-b']) {
      seedUnit(world, unitId, {
        contacts: [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-p', role: 'pm', primaryContact: false },
        ],
        primary_contact: 'c-d',
      });
    }
    const real = world.unitsRepo.handOffPrimaryFrom.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'handOffPrimaryFrom').mockImplementation(async (unitId, from, read) => {
      if (unitId === 'u-a') throw new Error('boom');
      return real(unitId, from, read);
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-a')?.primary_contact).toBe('c-d');
    expect(world.units.get('u-b')?.primary_contact).toBe('c-p');
  });

  it('restoring the contact afterwards changes no roster - the heir keeps the primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    seedUnit(world, 'u-5', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);
    const afterDelete = structuredClone(world.units.get('u-5'));

    const back = await auth(request(app).post('/api/contacts/c-d/restore'));

    expect(back.status).toBe(200);
    expect(world.units.get('u-5')).toEqual(afterDelete);
    expect(world.units.get('u-5')?.primary_contact).toBe('c-p');
    expect(assigned(world)).toHaveLength(1);
  });

  it('Scans consistently over live and deleted units and never reads the deleted contact for liveness', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    seedUnit(world, 'u-6', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const scan = vi.spyOn(world.unitsRepo, 'list');
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);

    expect(scan).toHaveBeenCalledWith({ deleted: 'any', consistentRead: true });
    const livenessReads = batchRead.mock.calls.filter(
      ([, opts]) => (opts as { requireComplete?: boolean } | undefined)?.requireComplete === true,
    );
    expect(livenessReads.length).toBeGreaterThan(0);
    for (const [ids] of livenessReads) expect(ids).not.toContain('c-d');
  });

  it('(PIN) a contact who is the primary of no property: no unit is written', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-ll');
    seedUnit(world, 'u-7', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-ll',
    });
    const before = structuredClone(world.units.get('u-7'));

    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);

    expect(world.units.get('u-7')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });
});
```

**Step 2 - run RED.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/contactDeletePrimaryHandoff.test.ts
```

Expected failures: `moves the primary to the heir...`, `a live landlord of
record takes over...`, the two `liveness unknown` cases (no WARN line), `one
unit failing...` (u-b still c-d), `restoring the contact afterwards...`
(primary still c-d) and the Scan test (`list` never called). The no-heir and
the nobody's-primary PINs pass already.

**Step 3 - implementation** (`app/src/routes/contacts.ts`, two Edits).

(a) Import. old_string:

```ts
import { typeChangeRefusals } from '../services/contactHoldings.js';
```

new_string:

```ts
import { typeChangeRefusals } from '../services/contactHoldings.js';
import { handOffPrimariesOfDeletedContact } from '../services/primaryHandoff.js';
```

(b) The DELETE handler, right after its `contact_deleted` audit. old_string:

```ts
    await audit.append(`contacts#${contactId}`, 'contact_deleted', {
      actor: req.user?.userId,
      deletedAt,
    });
```

new_string:

```ts
    await audit.append(`contacts#${contactId}`, 'contact_deleted', {
      actor: req.user?.userId,
      deletedAt,
    });
    // primary-contact-integrity (spec 2026-10-12 section 4.6): now that the
    // soft delete has persisted, hand every property whose primary contact
    // this was to its heir (services/primaryHandoff.ts: one consistent Scan of
    // live and soft-deleted units, the deleted contact excluded and never
    // read; no heir changes nothing). BEST-EFFORT, like the fan-outs below:
    // the service never throws, and it is guarded here anyway so a failure can
    // never turn this successful delete into a 500. Restore runs nothing like
    // it (spec 4.6: restoring a contact changes no roster).
    try {
      await handOffPrimariesOfDeletedContact({ units, contacts, audit, logger: log }, contactId, req.user?.userId);
    } catch (err) {
      log.warn({ err, contactId }, 'contact delete: primary handoff failed (best-effort)');
    }
```

**Step 4 - run GREEN.**

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/contactDeletePrimaryHandoff.test.ts test/contactSoftDelete.test.ts test/contactsCrud.test.ts test/contactEmailReaders.test.ts test/voiceInboxActivity.test.ts
```

Expected: all pass (the last four are the existing contact-delete suites;
they seed no unit whose primary is the deleted contact).

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: `app/src/routes/contacts.ts` modified, the new test untracked; no
`.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/routes/contacts.ts app/test/contactDeletePrimaryHandoff.test.ts && git commit -m "feat(contacts): deleting a contact hands its properties' primary to the heir (best-effort, never fails the delete)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.12 - parity pin: the real repo and the API-test fake agree on every heir case

Files:
- Create: `app/test/primaryHandoffParity.integration.test.ts`

DynamoDB Local: REQUIRED.

This is a PIN over behavior S2.3-S2.9 already built (spec section 10,
"Parity"): it is expected GREEN on its first run. A failure is a real drift
between `app/src/repos/unitsRepo.ts` and
`app/test/helpers/twilioWebhookHarness.ts`: the `expected` outcome says which
side is wrong; fix that side (normally the fake), never the expectation.

**Step 1 - the test.** Create `app/test/primaryHandoffParity.integration.test.ts`:

```ts
// primary-contact-integrity (spec 2026-10-12 section 10, "Parity"): the real
// unitsRepo (DynamoDB Local) and the API-test fake
// (test/helpers/twilioWebhookHarness.ts createFakeWorld) give the SAME result
// for the heir cases, because both call lib/propertyContact.ts chooseHeir /
// applyPrimary (and for P2, because both call decideAutoPrimary). Each case
// runs once through each implementation from the same stored shape and the
// same liveness read; the roster, the scalar, the landlord of record and the
// soft-delete state must match - and, where given, equal the expected outcome.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  type ReadRosterContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[primaryHandoffParity.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const GONE = '2026-10-01T09:00:00.000Z';
const LANDLORD_FACTS = { caseworker: false, landlordTyped: true, autoPrimaryEligible: true };

function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A complete liveness read answering from `known` (any other id is missing). */
function liveness(known: ContactItem[]): ReadRosterContacts {
  const byId = new Map(known.map((c) => [c.contactId, c] as const));
  return async (ids) => {
    const found = new Map<string, ContactItem>();
    for (const id of ids) {
      const contact = byId.get(id);
      if (contact !== undefined) found.set(id, contact);
    }
    return { ok: true, byId: found };
  };
}

function row(contactId: string, role: UnitContact['role'], primaryContact: boolean): UnitContact {
  return { contactId, role, primaryContact };
}

interface Shape {
  landlordId?: string;
  contacts: UnitContact[];
  primary?: string;
  deleted?: boolean;
}

interface ParityCase {
  shape: Shape;
  people: ContactItem[];
  act: (repo: UnitsRepo, unitId: string, read: ReadRosterContacts) => Promise<unknown>;
  /** The outcome, when the case pins it (an ADDED landlord row's position is applyPrimary's choice). */
  expected?: { contacts: UnitContact[]; primary: string | null };
}

const remove =
  (contactId: string) =>
  (repo: UnitsRepo, unitId: string, read: ReadRosterContacts): Promise<unknown> =>
    repo.removeContact(unitId, contactId, { readContacts: read });

const CASES: Array<[string, ParityCase]> = [
  [
    'remove: the live landlord of record takes over',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
      people: [person('c-ll')],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ll', 'landlord', true)], primary: 'c-ll' },
    },
  ],
  [
    'remove: an off-roster landlord of record gets a row as the primary',
    {
      shape: { landlordId: 'c-ll', contacts: [row('c-pm', 'pm', true), row('c-own', 'owner', false)], primary: 'c-pm' },
      people: [person('c-ll'), person('c-own')],
      act: remove('c-pm'),
    },
  ],
  [
    'remove: no landlord - the earliest-added eligible contact takes over',
    {
      shape: {
        contacts: [
          row('c-ten', 'other', false),
          row('c-gone', 'pm', false),
          row('c-own', 'owner', false),
          row('c-pm', 'pm', true),
          row('c-late', 'pm', false),
        ],
        primary: 'c-pm',
      },
      people: [person('c-ten', { type: 'tenant' }), person('c-gone', { deleted_at: GONE }), person('c-own'), person('c-late')],
      act: remove('c-pm'),
      expected: {
        contacts: [
          row('c-ten', 'other', false),
          row('c-gone', 'pm', false),
          row('c-own', 'owner', true),
          row('c-late', 'pm', false),
        ],
        primary: 'c-own',
      },
    },
  ],
  [
    'remove: nobody eligible - every flag cleared, the scalar removed',
    {
      shape: { contacts: [row('c-ten', 'other', false), row('c-pm', 'pm', true)], primary: 'c-pm' },
      people: [person('c-ten', { type: 'tenant' })],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ten', 'other', false)], primary: null },
    },
  ],
  [
    'remove: a soft-deleted landlord of record is skipped',
    {
      shape: {
        landlordId: 'c-ll',
        contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true), row('c-own', 'owner', false)],
        primary: 'c-pm',
      },
      people: [person('c-ll', { deleted_at: GONE }), person('c-own')],
      act: remove('c-pm'),
      expected: { contacts: [row('c-ll', 'landlord', false), row('c-own', 'owner', true)], primary: 'c-own' },
    },
  ],
  [
    'delete hand-off: moved to the earliest eligible contact, the deleted row kept',
    {
      shape: {
        contacts: [row('c-d', 'pm', true), row('c-cw', 'other', false), row('c-own', 'owner', false)],
        primary: 'c-d',
      },
      people: [person('c-cw', { type: 'partner', role: 'Caseworker' }), person('c-own')],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-d', read),
      expected: {
        contacts: [row('c-d', 'pm', false), row('c-cw', 'other', false), row('c-own', 'owner', true)],
        primary: 'c-own',
      },
    },
  ],
  [
    'delete hand-off: no heir - unchanged',
    {
      shape: { contacts: [row('c-d', 'pm', true), row('c-ten', 'other', false)], primary: 'c-d' },
      people: [person('c-ten', { type: 'tenant' })],
      act: (repo, unitId, read) => repo.handOffPrimaryFrom(unitId, 'c-d', read),
      expected: { contacts: [row('c-d', 'pm', true), row('c-ten', 'other', false)], primary: 'c-d' },
    },
  ],
  [
    'restore swap: a soft-deleted new landlord is skipped for the earliest eligible contact',
    {
      shape: {
        landlordId: 'c-old',
        contacts: [row('c-old', 'landlord', true), row('c-pm', 'pm', false)],
        primary: 'c-old',
        deleted: true,
      },
      people: [person('c-new', { deleted_at: GONE }), person('c-pm')],
      act: (repo, unitId, read) =>
        repo.restoreWithLandlord(
          unitId,
          { expectLandlordId: 'c-old', next: { contactId: 'c-new' } },
          { readContacts: read },
        ),
      expected: { contacts: [row('c-pm', 'pm', true), row('c-new', 'landlord', false)], primary: 'c-pm' },
    },
  ],
  [
    'add (P2): a soft-deleted flagged primary counts as absent',
    {
      shape: { contacts: [row('c-dead', 'pm', true)], primary: 'c-dead' },
      people: [person('c-dead', { deleted_at: GONE })],
      act: (repo, unitId, read) =>
        repo.addContact(unitId, { contactId: 'c-new', role: 'pm' }, LANDLORD_FACTS, { readContacts: read }),
      expected: { contacts: [row('c-dead', 'pm', false), row('c-new', 'pm', true)], primary: 'c-new' },
    },
  ],
];

/** The fields a roster write decides. */
function observe(unit: UnitItem | undefined) {
  return {
    contacts: unit?.contacts ?? null,
    primary: unit?.primary_contact ?? null,
    landlordId: unit?.landlordId ?? null,
    deleted: typeof unit?.deleted_at === 'string',
  };
}

describe.skipIf(!reachable)('heir parity: the real unitsRepo and the API-test fake (spec section 10)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function seedReal(shape: Shape): Promise<string> {
    const created = await units.create({
      landlordId: shape.landlordId ?? 'c-temp',
      status: 'available',
      contacts: structuredClone(shape.contacts),
      ...(shape.primary !== undefined && { primary_contact: shape.primary }),
    });
    if (shape.landlordId === undefined) await units.update(created.unitId, { landlordId: null });
    if (shape.deleted === true) await units.softDelete(created.unitId, GONE);
    return created.unitId;
  }

  it.each(CASES)('%s: the real repo and the fake agree', async (_name, c) => {
    const realId = await seedReal(c.shape);
    await c.act(units, realId, liveness(c.people));
    const real = observe(await units.getById(realId, { consistentRead: true }));

    const world = createFakeWorld();
    world.units.set('u-parity', {
      unitId: 'u-parity',
      status: 'available',
      contacts: structuredClone(c.shape.contacts),
      ...(c.shape.landlordId !== undefined && { landlordId: c.shape.landlordId }),
      ...(c.shape.primary !== undefined && { primary_contact: c.shape.primary }),
      ...(c.shape.deleted === true && { deleted_at: GONE }),
    } as UnitItem);
    await c.act(world.unitsRepo, 'u-parity', liveness(c.people));
    const fake = observe(world.units.get('u-parity'));

    expect(fake).toEqual(real);
    if (c.expected !== undefined) {
      expect(real.contacts).toEqual(c.expected.contacts);
      expect(real.primary).toBe(c.expected.primary);
    }
  });
});
```

**Step 2 - run** (expected GREEN on the first run - see above).

```bash
cd W:/tmp/primary-contact-integrity/app && npx vitest run test/primaryHandoffParity.integration.test.ts
```

Expected: 9 passed. A `SKIPPED - no DynamoDB Local` line is NOT a pass.

**Step 3 - implementation:** none (a failure here is a drift to fix in the
fake, per the note above).

**Step 4 - re-run** the same command after any fix: 9 passed.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: only the new test untracked (plus the fake if step 3 fixed a
drift); no `.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/test/primaryHandoffParity.integration.test.ts && git commit -m "test(units): pin heir parity between the real units repo and the API-test fake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(If step 3 changed `app/test/helpers/twilioWebhookHarness.ts`, add that path
to the same `git add`.)

---

#### Task S2.13 - correct the `placementId` docblock in `conversationsRepo.ts` (spec 9.2)

Files:
- Modify: `app/src/repos/conversationsRepo.ts` (comment only)

DynamoDB Local: not needed. No test: comment-only change (spec 9.2 lists the
comments that claim a masked call routes on the unit's `primary_contact`;
this is the one left on the merged main - see CONTRACT ISSUE 13).

**Step 1 - test:** none (no behavior).

**Step 2 - run:** n/a.

**Step 3 - implementation.** In `app/src/repos/conversationsRepo.ts`, the
docblock above `  placementId?: string;` begins with these four lines (the
second and third contain a non-ASCII arrow, so select them in the editor by
reading the file):

```text
   * The placement this relay_group is the thread for (M1.10): the
   * conversation<arrow>placement BACK-REFERENCE. It lets the voice masked-call seam resolve
   * the landlord-leg target (placement<arrow>unit.primary_contact) and the
   * failed-send escalation flag the right placement. Set when a relay is provisioned
```

Replace exactly those four lines with:

```ts
   * The placement this relay_group is the thread for (M1.10): the
   * conversation-to-placement BACK-REFERENCE. It lets the failed-send
   * escalation flag the right placement. (The voice masked-call seam dials the
   * live thread's participants and reads no unit field - nothing routes on the
   * unit's primary_contact scalar; primary-contact-integrity spec 9.2.)
   * Set when a relay is provisioned
```

The following line (`   * FROM a placement; absent on 1:1 threads and
standalone (test-scaffold) relays.`) and the rest of the docblock stay.

**Step 4 - verify.**

```bash
cd W:/tmp/primary-contact-integrity && npm run typecheck
```

Expected: exit 0.

**Step 5 - commit.**

```bash
cd W:/tmp/primary-contact-integrity && git status
```

Read it: only `app/src/repos/conversationsRepo.ts` modified; no
`.git/MERGE_HEAD`.

```bash
cd W:/tmp/primary-contact-integrity && git add app/src/repos/conversationsRepo.ts && git commit -m "docs(conversations): placementId docblock no longer claims a masked call routes on the unit primary_contact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S2.14 - slice gate

No new code. Run every command BARE (no pipes), from the paths shown.

1. AWS credentials the environment may export (AGENTS.md):

   ```bash
   env | grep '^AWS_'
   ```

   If it prints an `AWS_ACCESS_KEY_ID`, prefix the vitest commands below with
   `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY`.

2. Typecheck (app source, scripts AND tests):

   ```bash
   cd W:/tmp/primary-contact-integrity && npm run typecheck
   ```

   Expected: exit 0.

3. The files this slice touched or created, plus the neighbors that drive the
   same writes (DynamoDB Local REQUIRED; a `SKIPPED` line is a failure of the
   gate, not a pass):

   ```bash
   cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitFields.test.ts test/unitsApi.test.ts test/unitsRepoAutoPrimaryDecision.test.ts test/unitsRepoPrimaryOnAdd.integration.test.ts test/unitsRepoAutoPrimary.integration.test.ts test/unitsApiPrimaryOnAdd.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsRepoPrimaryOnRemove.integration.test.ts test/unitsRepoRoster.integration.test.ts test/unitsApiPrimaryOnRemove.test.ts test/unitsApiRoster.test.ts test/unitsRepoRestoreHandoff.integration.test.ts test/unitsRepoRestoreWithLandlord.integration.test.ts test/unitsRestorePrimaryHandoff.test.ts test/unitsRestoreLandlord.test.ts test/unitsRepoHandOffPrimary.integration.test.ts test/primaryHandoffService.test.ts test/contactDeletePrimaryHandoff.test.ts test/primaryHandoffParity.integration.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsRepoContactListRules.integration.test.ts test/unitsApiActivity.test.ts test/placementsVoiceRouting.test.ts test/contactSoftDelete.test.ts test/contactsCrud.test.ts test/contactEmailReaders.test.ts test/voiceInboxActivity.test.ts test/caseworkerRepoParity.integration.test.ts test/contactHoldings.test.ts test/orgRecords.test.ts
   ```

   Expected: every file passes.

4. The whole app workspace (plan section 0: the touched workspace's tests):

   ```bash
   cd W:/tmp/primary-contact-integrity && npm test -w @housingchoice/app
   ```

   Expected: exit 0. If DynamoDB Local suites fail, follow AGENTS.md
   "FIRST, if `npm test` is red on DynamoDB Local suites": re-run the failing
   FILES alone, run the suite at the merge base, compare failing FILES, and
   report both runs - never the old `AWS_ACCESS_KEY_ID` recipe. Any
   `[dynamoAdmin]` line is a real container fault: capture
   `err.$metadata.httpStatusCode` and `attempts` first.

5. Lint the slice's source and test files (gate 5's rule, scoped to this
   slice):

   ```bash
   cd W:/tmp/primary-contact-integrity && npx eslint app/src/repos/unitsRepo.ts app/src/routes/units.ts app/src/routes/contacts.ts app/src/lib/unitFields.ts app/src/services/primaryHandoff.ts app/src/repos/conversationsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsRepoAutoPrimaryDecision.test.ts app/test/unitsRepoPrimaryOnAdd.integration.test.ts app/test/unitsApiPrimaryOnAdd.test.ts app/test/unitsRepoPrimaryOnRemove.integration.test.ts app/test/unitsApiPrimaryOnRemove.test.ts app/test/unitsRepoRestoreHandoff.integration.test.ts app/test/unitsRestorePrimaryHandoff.test.ts app/test/unitsRepoHandOffPrimary.integration.test.ts app/test/primaryHandoffService.test.ts app/test/contactDeletePrimaryHandoff.test.ts app/test/primaryHandoffParity.integration.test.ts
   ```

   Expected: exit 0. Any error: attribute it by BASELINE comparison (the
   same command on the same paths at the merge base); a new one is this
   slice's and blocking (an unused import such as `soleLandlordToPromote`'s
   leftovers or `vi` in a test that no longer spies is the usual shape).

6. ASCII check of every line this branch added under `app/` (a check, not a
   completion gate - the pipe cannot hide a test exit code here):

   ```bash
   cd W:/tmp/primary-contact-integrity && git diff main...HEAD -U0 -- app | grep -nP '^\+.*[^\x00-\x7F]'
   ```

   Expected: no output (grep exits 1 when it finds nothing - that is the
   pass).

Nothing to commit unless a step forced a fix; then commit that fix alone,
with a `git status` read first and explicit paths.


---

## S3 - app reads (plan slice)

### CONTRACT ISSUES (RULED - section 3.2 and plan-assembly-rulings.md govern; do not act on any "ruling needed" text here)

CI-1 (S1 dependency, contract 2.1 / C1). S3.1 reads a NEW REQUIRED field on
`ResolvedTourNames` (`app/src/lib/tourContacts.ts`): `propertyContact:
PropertyContactResult` - the P1 result for the `unit` passed in, computed by
`resolvePropertyContact` with the call's `tenantId`. S3 reads it ONLY when the
unit is known (when `unit` is undefined S3 never looks at it, so S1 may put any
value there). `names.propertyContactFirstName` must be derived from the SAME
contact P1 found (`kind: 'found'`). If S1 named or shaped the field
differently, the S3.1 builder renames the two reads in
`resolveRelayComposeInputs` (`propertyContact = resolved.propertyContact;`) and
nothing else.

CI-2 (S1 dependency, contract 2.1 / C2 / C4). S3.5 and S3.6 tests assume:
`readRosterContacts(contacts, ids, logger)` makes EXACTLY ONE
`contacts.getManyByIds(ids, { requireComplete: true, ... })` call (the tests
spy on `opts.requireComplete === true`) and answers `{ ok: false }` for ANY
throw; `rosterContactIds(unit)` includes `landlordId` even when the landlord
has no roster row; `decidePropertyContact` with no `tenantId` and an all-`ok`
lookup only ever answers `found` or `nobody` with `none | deleted`;
`chooseHeir` with `read.ok === true` never answers `unknown`, step 1 is the
landlord of record (no type test), step 2 is the earliest-added roster contact
passing `isAutoRoutingEligible`, the excluded contact counts as not live.

CI-3 (S1 + S2 share the import). S1 (and S2) add an import from
`'../lib/propertyContact.js'` to `app/src/routes/units.ts`. S3.5 MERGES its
four names into that one statement (a second import of the same name is a
TS2300 duplicate-identifier error). Exact procedure in S3.5 step 3a.

CI-4 (S2 owns the contact-list routes). S3.6 attaches the block by a
`replace_all` of the byte-identical line
`res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });`,
which `main` has EXACTLY TWICE (the add route and the remove route). S2 must
leave both lines as they are. S3.6 step 3 counts them first and STOPS if the
count is not 2. The S3.6 tests also drive S2's behavior through the API-test
fake: an add under an unknown liveness read answers 200 unpromoted (C5); a
remove of a NON-primary row reads no liveness and answers 200 (C7); a remove of
the primary with a live eligible roster contact hands the flag to it (C7).

CI-5 (ruling requested on C11 / spec 8 "the Activity projection whitelist
gains `reason`"). `listing_status_changed` already stores a FREE-TEXT `reason`
under the same key (`app/src/services/statusTransition.ts` setListingStatus;
`PATCH /api/units/:unitId/listing-status { reason? }`), which the projection
has never served. A blanket whitelist would start shipping that text to the
Activity card. S3.4 projects `reason` for `unit_primary_contact_assigned`
ONLY and pins the listing-status text staying off the wire. S4's renderer
reads `reason` only for that event, so S4 is unaffected. Recorded in
`plan-research/S3-findings.md` F1.

CI-6 (S2 / S4 awareness). The unit RESTORE route (S2-owned) keeps
`contacts: await enrichRoster(restored)`. S3 keeps `enrichRoster` as today's
best-effort reader (same name, same signature, same output), so the restore
response carries NO row flags and NO `propertyContact` block. Spec 7.5 lists
only GET and the two roster writes, and has the page REFETCH after either
restore; S4 must take flags and the block from that refetch, never from the
restore response. Recorded in `plan-research/S3-findings.md` F2.

### Design notes (slice-internal decisions, no other slice affected)

- D1. Unknown unit = the unit read THREW, returned nothing, or no units repo is
  wired. All three take spec 5.1's "unit read fails" rule: `lookup_failed`
  plus any tour reason, `unitId` from the owner, no `street`. (Spec names only
  "fails"; F3.)
- D2. `lookup_failed` is ADDED when: P1 answers `read_failed`; P1 could not run
  (no contacts repo wired, or `resolveTourContactNames` threw); the settings
  read throws OR answers nothing; the tour time cannot be formatted. It is
  reported once (a Set), last in order.
- D3. A tour `scheduledAt` that is absent OR the empty string is
  `tour_not_scheduled`. Settings are read only for a tour with a usable,
  not-started time on a KNOWN unit (every other tour already carries a reason
  and formatting could add nothing); a placement never reads settings (today's
  rule, kept).
- D4. `heirIfPrimaryRemoved` is `null` when NO roster row is flagged primary
  (there is no primary to remove); otherwise `chooseHeir` excluding the flagged
  row's contact (also when that contact is deleted). S4's 7.3 notice uses the
  block only when removing the flagged row, so `null` here is never shown.
- D5. `resolveOwnerInputs` (the job's repo-construction catch) answers
  `{ variant: 'naked', introFallback: { reasons: ['lookup_failed'] } }` for an
  owned conversation, so the job's INFO line also covers that path.
- D6. The INFO line is logged right after the body is composed, before the
  send, inside the composed-default branch only (never for an edited intro).
- D7. `RosterPreview.introFallback` is attached by `buildOpenPreview` itself,
  AFTER `buildOpenPreviewFromParts`; `buildOpenPreviewFromParts` (shared with
  the standalone preview) never copies it, and `buildAddPreview` composes its
  own preview. So only the tour and placement OPEN previews can carry it.

### Slice S3 - app reads (contracts 2.5, 2.6; C8, C9, C11)

Runs AFTER S1 and S2 are merged into the branch. Owns:
`app/src/jobs/relayFanOut.ts`, `app/src/services/rosterEdits.ts`,
`app/src/routes/units.ts` (ONLY `enrichRoster` and new helpers beside it, the
GET `/:unitId` response line, `toUnitActivityEvent` + `UnitActivityEvent`, the
module-level helpers inserted before `const DEFAULT_PAGE_LIMIT = 50;`, and the
two contact-list `res.json` lines), and their tests.

Test runs: every test file in this slice uses in-memory fakes only (no
DynamoDB client). The vitest `globalSetup` still PROBES DynamoDB Local and
fails the run when it is unreachable. Start it with `npm run db:start` from the
worktree root if it is not running (never restart a SHARED container without
Cameron's go). If it cannot be started, these fake-only files may be run with
the prefix `ALLOW_SKIP_DYNAMO_TESTS=1` (a deliberate unit-only pass; not a
completion gate).

Every command uses an explicit `cd` (the shell cwd resets between calls).
Every new or touched line is ASCII-only. Edit source with the Edit tool only.

---

#### Task S3.1 - `resolveRelayComposeInputs` reports every intro fallback reason

Files:
- NEW `app/test/relayIntroFallback.test.ts`
- `app/src/jobs/relayFanOut.ts`

Steps:

(1) Write the failing test. Create `app/test/relayIntroFallback.test.ts` with
exactly this content:

```ts
// primary-contact-integrity spec 5.1 (plan S3.1): resolveRelayComposeInputs
// explains a general intro. For an OWNED conversation (tour or placement) that
// resolves to the general ("naked") intro, `introFallback` carries EVERY
// reason, in the spec's order, plus the ids the open-group dialog links to.
// An ownerless conversation never carries it; the variant rule is unchanged.
import { describe, expect, it } from 'vitest';
import { resolveRelayComposeInputs, type RelayComposeDeps } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { RelayOwner } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const NY = 'America/New_York';
/** 2026-09-08 15:00 New York (19:00Z, EDT). */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
/** 09:00 New York the day BEFORE the tour: the dated tour variant. */
const DAY_BEFORE_NOW = '2026-09-07T13:00:00.000Z';
/** 09:00 New York the day AFTER the tour: the tour has started. */
const DAY_AFTER_NOW = '2026-09-09T13:00:00.000Z';
const DELETED_AT = '2026-10-01T12:00:00.000Z';

const TOUR: RelayOwner = { type: 'tour', id: 'tour-1' };
const PLACEMENT: RelayOwner = { type: 'placement', id: 'plc-1' };

const TENANT = {
  contactId: 'c-tenant',
  type: 'tenant',
  firstName: 'Alicia',
  lastName: 'Reyes',
} as ContactItem;
const LANDLORD = {
  contactId: 'c-landlord',
  type: 'landlord',
  firstName: 'Marcus',
  lastName: 'Webb',
} as ContactItem;
const DELETED_LANDLORD = { ...LANDLORD, deleted_at: DELETED_AT } as ContactItem;
const NAMELESS_LANDLORD = { contactId: 'c-landlord', type: 'landlord', lastName: 'Webb' } as ContactItem;

const SCHEDULED_TOUR = { tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1', scheduledAt: TOUR_AT };
const UNSCHEDULED_TOUR = { tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1' };
/** No flagged primary row and no landlord of record: P1 answers nobody / none. */
const NO_CONTACT_UNIT = { landlordId: undefined, contacts: [] };

const quietLogger = createLogger({ destination: createLogCapture().stream });

function unitWith(over: Record<string, unknown> = {}): UnitItem {
  return {
    unitId: 'unit-1',
    landlordId: 'c-landlord',
    status: 'available',
    address: { line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
    contacts: [{ contactId: 'c-landlord', role: 'landlord', primaryContact: true }],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  } as UnitItem;
}

function contactsOf(...rows: ContactItem[]): NonNullable<RelayComposeDeps['contactsRepo']> {
  return { getById: async (id: string) => rows.find((c) => c.contactId === id) as never };
}

/** The tenant reads fine; the PROPERTY contact's read throws (P1 read_failed). */
const LANDLORD_READ_THROWS: NonNullable<RelayComposeDeps['contactsRepo']> = {
  getById: async (id: string) => {
    if (id === 'c-landlord') throw new Error('contacts-boom');
    return (id === 'c-tenant' ? TENANT : undefined) as never;
  },
};

function throws(label: string): () => Promise<never> {
  return async () => {
    throw new Error(`${label}-boom`);
  };
}

/** Deps whose every read succeeds: a future tour on a unit with a named landlord. */
function deps(
  over: Partial<RelayComposeDeps> = {},
  unit: UnitItem = unitWith(),
  tour: Record<string, unknown> = SCHEDULED_TOUR,
): RelayComposeDeps {
  return {
    toursRepo: { get: async () => tour as never },
    placementsRepo: {
      getById: async () =>
        ({ placementId: 'plc-1', tenantId: 'c-tenant', unitId: 'unit-1' }) as never,
    },
    unitsRepo: { getById: async () => unit as never },
    contactsRepo: contactsOf(TENANT, LANDLORD),
    settingsRepo: { getOrgSettings: async () => ({ timezone: NY }) as never },
    nowIso: DAY_BEFORE_NOW,
    logger: quietLogger,
    ...over,
  };
}

const OWNER_UNREADABLE = { variant: 'naked', introFallback: { reasons: ['lookup_failed'] } };

describe('resolveRelayComposeInputs - introFallback (primary-contact-integrity spec 5.1)', () => {
  describe('absent when there is nothing to explain', () => {
    it('a tour that composes its own intro carries no introFallback', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps());
      expect(inputs.variant).toBe('tour');
      expect(inputs.introFallback).toBeUndefined();
    });

    it('a placement that composes its own intro carries no introFallback', async () => {
      const inputs = await resolveRelayComposeInputs(PLACEMENT, deps());
      expect(inputs.variant).toBe('placement');
      expect(inputs.introFallback).toBeUndefined();
    });

    it('an ownerless conversation never carries it: the general intro is its only intro', async () => {
      const inputs = await resolveRelayComposeInputs(
        { type: null },
        deps({ toursRepo: { get: throws('tours') } }),
      );
      expect(inputs).toEqual({ variant: 'naked' });
    });

    it('a deleted primary next to a live landlord of record resolves past it (P1): the tour intro', async () => {
      const unit = unitWith({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] });
      const deletedPm = {
        contactId: 'c-pm',
        type: 'landlord',
        firstName: 'Pat',
        deleted_at: DELETED_AT,
      } as ContactItem;
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, LANDLORD, deletedPm) }, unit),
      );
      expect(inputs.variant).toBe('tour');
      expect(inputs.propertyContactFirstName).toBe('Marcus');
      expect(inputs.introFallback).toBeUndefined();
    });
  });

  describe('the owner read decides first', () => {
    it('an owner read that THROWS is lookup_failed ALONE - and nothing else is read', async () => {
      for (const owner of [TOUR, PLACEMENT]) {
        let reads = 0;
        const count = async (): Promise<never> => {
          reads += 1;
          return undefined as never;
        };
        const inputs = await resolveRelayComposeInputs(
          owner,
          deps({
            toursRepo: { get: throws('tours') },
            placementsRepo: { getById: throws('placements') },
            unitsRepo: { getById: count },
            settingsRepo: { getOrgSettings: count },
          }),
        );
        expect(inputs, String(owner.type)).toEqual(OWNER_UNREADABLE);
        expect(reads, String(owner.type)).toBe(0);
      }
    });

    it('an owner that is MISSING, or has no repo wired, is the same: lookup_failed alone', async () => {
      const rows: [string, RelayOwner, RelayComposeDeps][] = [
        ['the tour row is gone', TOUR, deps({ toursRepo: { get: async () => undefined as never } })],
        [
          'the placement row is gone',
          PLACEMENT,
          deps({ placementsRepo: { getById: async () => undefined as never } }),
        ],
        ['no tours repo wired', TOUR, deps({ toursRepo: undefined })],
        ['no placements repo wired', PLACEMENT, deps({ placementsRepo: undefined })],
      ];
      for (const [why, owner, d] of rows) {
        expect(await resolveRelayComposeInputs(owner, d), why).toEqual(OWNER_UNREADABLE);
      }
    });
  });

  describe('an unknown unit still decides the tour reasons', () => {
    it('a unit read that THROWS: lookup_failed, with the unitId the owner named', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') } }),
      );
      expect(inputs.variant).toBe('naked');
      expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
    });

    it('a failed unit read keeps tour_not_scheduled / tour_started beside lookup_failed', async () => {
      const unscheduled = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') } }, unitWith(), UNSCHEDULED_TOUR),
      );
      expect(unscheduled.introFallback).toEqual({
        reasons: ['tour_not_scheduled', 'lookup_failed'],
        unitId: 'unit-1',
      });
      const started = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') }, nowIso: DAY_AFTER_NOW }),
      );
      expect(started.introFallback).toEqual({
        reasons: ['tour_started', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('a MISSING unit, or no units repo wired, reads like a failed unit read', async () => {
      for (const unitsRepo of [{ getById: async () => undefined as never }, undefined]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ unitsRepo }));
        expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
      }
    });

    it('a placement on an unknown unit carries NO tour reason', async () => {
      const inputs = await resolveRelayComposeInputs(
        PLACEMENT,
        deps({ unitsRepo: { getById: throws('units') } }),
      );
      expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
    });
  });

  describe('each reason alone', () => {
    it('no_property_contact: no flagged primary and no landlord of record (P1 none)', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith(NO_CONTACT_UNIT)));
      expect(inputs.variant).toBe('naked');
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_deleted: the only candidate is soft-deleted', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, DELETED_LANDLORD) }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_deleted: a candidate with NO contact record reads like a deleted one', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: contactsOf(TENANT) }));
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_is_tenant: the flagged primary IS the tenant (no fall-through to the landlord)', async () => {
      const unit = unitWith({
        contacts: [{ contactId: 'c-tenant', role: 'other', primaryContact: true }],
      });
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unit));
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_is_tenant'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_no_first_name: P1 found a contact with no first name - its id rides along', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, NAMELESS_LANDLORD) }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_no_first_name'],
        unitId: 'unit-1',
        street: '412 Oak St',
        propertyContactId: 'c-landlord',
      });
    });

    it('no_street_address: the unit has no street - and no `street` field', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith({ address: undefined })));
      expect(inputs.introFallback).toEqual({ reasons: ['no_street_address'], unitId: 'unit-1' });
    });

    it('tour_not_scheduled: a requested tour has no time', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith(), UNSCHEDULED_TOUR));
      expect(inputs.introFallback).toEqual({
        reasons: ['tour_not_scheduled'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('tour_started: at or after the start instant', async () => {
      for (const nowIso of [TOUR_AT, DAY_AFTER_NOW]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ nowIso }));
        expect(inputs.introFallback, nowIso).toEqual({
          reasons: ['tour_started'],
          unitId: 'unit-1',
          street: '412 Oak St',
        });
      }
    });

    it('lookup_failed: a THROWN property-contact read (P1 read_failed) is never read as absence', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: LANDLORD_READ_THROWS }));
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('lookup_failed: no contacts repo wired (the lookup cannot run)', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: undefined }));
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('lookup_failed: the settings read THROWS, answers nothing, or is not wired', async () => {
      for (const settingsRepo of [
        { getOrgSettings: throws('settings') },
        { getOrgSettings: async () => undefined as never },
        undefined,
      ]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ settingsRepo }));
        expect(inputs.introFallback).toEqual({
          reasons: ['lookup_failed'],
          unitId: 'unit-1',
          street: '412 Oak St',
        });
      }
    });

    it('lookup_failed: an unformattable tour time', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({}, unitWith(), { ...SCHEDULED_TOUR, scheduledAt: 'not-a-date' }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('a failed TENANT read is NOT a reason: the tour intro still composes', async () => {
      const contactsRepo: NonNullable<RelayComposeDeps['contactsRepo']> = {
        getById: async (id: string) => {
          if (id === 'c-tenant') throw new Error('tenant-boom');
          return (id === 'c-landlord' ? LANDLORD : undefined) as never;
        },
      };
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo }));
      expect(inputs.variant).toBe('tour');
      expect(inputs.tenantFirstName).toBeUndefined();
      expect(inputs.introFallback).toBeUndefined();
    });
  });

  describe('every check is evaluated, reported in the spec order', () => {
    it('reports in SPEC order, not evaluation order', async () => {
      // Evaluated: tour_started first (the owner read), lookup_failed next (P1),
      // no_street_address last. Reported: the spec's order.
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: LANDLORD_READ_THROWS, nowIso: DAY_AFTER_NOW }, unitWith({ address: undefined })),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_street_address', 'tour_started', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('does not stop at the first miss: no contact AND a failed settings read are both reported', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ settingsRepo: { getOrgSettings: throws('settings') } }, unitWith(NO_CONTACT_UNIT)),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact', 'lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('no first name + no street + not scheduled', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, NAMELESS_LANDLORD) }, unitWith({ address: undefined }), UNSCHEDULED_TOUR),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_no_first_name', 'no_street_address', 'tour_not_scheduled'],
        unitId: 'unit-1',
        propertyContactId: 'c-landlord',
      });
    });

    it('a deleted contact + no street + an unformattable time', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps(
          { contactsRepo: contactsOf(TENANT, DELETED_LANDLORD) },
          unitWith({ address: undefined }),
          { ...SCHEDULED_TOUR, scheduledAt: 'not-a-date' },
        ),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted', 'no_street_address', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('lookup_failed is reported ONCE however many reads fail', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({
          contactsRepo: { getById: throws('contacts') },
          settingsRepo: { getOrgSettings: throws('settings') },
        }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });
  });

  describe('placements', () => {
    it('never carry a tour reason, and never read settings', async () => {
      let settingsReads = 0;
      const inputs = await resolveRelayComposeInputs(
        PLACEMENT,
        deps(
          {
            settingsRepo: {
              getOrgSettings: async () => {
                settingsReads += 1;
                return { timezone: NY } as never;
              },
            },
            nowIso: DAY_AFTER_NOW,
          },
          unitWith({ ...NO_CONTACT_UNIT, address: undefined }),
        ),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact', 'no_street_address'],
        unitId: 'unit-1',
      });
      expect(settingsReads).toBe(0);
    });
  });

  it('the member-added role is still resolved when the intro falls back', async () => {
    const inputs = await resolveRelayComposeInputs(
      TOUR,
      deps({}, unitWith({ address: undefined })),
      'c-landlord',
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.role).toBe('landlord');
  });

  it('NEVER throws: every read failing at once answers lookup_failed', async () => {
    const allThrow: Partial<RelayComposeDeps> = {
      toursRepo: { get: throws('tours') },
      placementsRepo: { getById: throws('placements') },
      unitsRepo: { getById: throws('units') },
      contactsRepo: { getById: throws('contacts') },
      settingsRepo: { getOrgSettings: throws('settings') },
    };
    for (const owner of [TOUR, PLACEMENT]) {
      expect(await resolveRelayComposeInputs(owner, deps(allThrow)), String(owner.type)).toEqual(
        OWNER_UNREADABLE,
      );
    }
  });
});
```

(2) Run it RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/relayIntroFallback.test.ts`

Expected RED: the run exits non-zero with `Tests  25 failed | 6 passed (31)`.
The failures read `AssertionError: expected undefined to deeply equal { reasons: [ ... ] ... }`
(the reason tests) or `expected { variant: 'naked' } to deeply equal { variant: 'naked', introFallback: { ... } }`
(the owner tests). The six that already pass are the four "absent" pins, the
failed-TENANT-read pin and the member-added role pin.

(3) Implement, in `app/src/jobs/relayFanOut.ts`, four Edit-tool edits.

3a. Import the P1 result type. Replace the line

```ts
import { resolveTourContactNames, type TourContactNames } from '../lib/tourContacts.js';
```

with

```ts
import { resolveTourContactNames, type TourContactNames } from '../lib/tourContacts.js';
import type { PropertyContactResult } from '../lib/propertyContact.js';
```

3b. The new field and types. Replace the text (the end of
`interface RelayComposeInputs`)

```ts
  /** member_added only (spec 9.4's role table). */
  role?: 'property manager' | 'landlord' | 'tenant';
}
```

with

```ts
  /** member_added only (spec 9.4's role table). */
  role?: 'property manager' | 'landlord' | 'tenant';
  /**
   * primary-contact-integrity spec 5.1: WHY an OWNED conversation (tour or
   * placement) resolves to the general (naked) intro. Present exactly then -
   * never on a tour or placement variant, and never on an ownerless group (the
   * general intro is its only intro). The member-added path ignores it.
   */
  introFallback?: IntroFallback;
}

/**
 * primary-contact-integrity spec 5.1: why an owned conversation's intro fell
 * back to the general one. Declared in the order the dialog lists them
 * (INTRO_FALLBACK_ORDER below).
 */
export type IntroFallbackReason =
  | 'no_property_contact' // P1 (lib/propertyContact): nobody, reason none
  | 'property_contact_deleted' // P1: nobody, reason deleted (deleted or missing)
  | 'property_contact_is_tenant' // P1: nobody, reason is_tenant
  | 'property_contact_no_first_name' // P1 found a contact with no first name
  | 'no_street_address' // formatStreet(unit.address) is empty
  | 'tour_not_scheduled' // tour only: no scheduledAt
  | 'tour_started' // tour only: scheduledAt <= now
  | 'lookup_failed'; // a read failed or could not answer

/** spec 5.1: the explanation the OPEN preview carries to the open-group dialog. */
export interface IntroFallback {
  /** Every reason that applies, in INTRO_FALLBACK_ORDER. Never empty. */
  reasons: IntroFallbackReason[];
  /** The property, when known (the owner read succeeded). */
  unitId?: string;
  /** formatStreet(unit.address), when non-empty. */
  street?: string;
  /** Set with property_contact_no_first_name: the contact missing a first name. */
  propertyContactId?: string;
}

/** spec 5.1's reason order - the order `reasons` is reported in. */
const INTRO_FALLBACK_ORDER: readonly IntroFallbackReason[] = [
  'no_property_contact',
  'property_contact_deleted',
  'property_contact_is_tenant',
  'property_contact_no_first_name',
  'no_street_address',
  'tour_not_scheduled',
  'tour_started',
  'lookup_failed',
];

/** P1's three "nobody" outcomes, each its own reason. */
const NOBODY_REASON: Record<
  Extract<PropertyContactResult, { kind: 'nobody' }>['reason'],
  IntroFallbackReason
> = {
  none: 'no_property_contact',
  deleted: 'property_contact_deleted',
  is_tenant: 'property_contact_is_tenant',
};

/** The variant-specific half of a composed (non-naked) intro. */
type IntroTiming =
  | { variant: 'placement' }
  | { variant: 'tour_today'; time: string }
  | { variant: 'tour'; when: string };

/** The reported explanation: the recorded reasons in spec order, plus the ids. */
function introFallbackOf(
  reasons: ReadonlySet<IntroFallbackReason>,
  ids: Omit<IntroFallback, 'reasons'>,
): IntroFallback {
  return { reasons: INTRO_FALLBACK_ORDER.filter((reason) => reasons.has(reason)), ...ids };
}

/** spec 5.1: an owner that cannot be read decides nothing else. */
function ownerUnreadable(): RelayComposeInputs {
  return { variant: 'naked', introFallback: { reasons: ['lookup_failed'] } };
}
```

3c. Document the rule in the resolver's docblock. Replace the line

```ts
 * IT NEVER THROWS. Every read gets its OWN try/catch and degrades toward
```

with

```ts
 * WHY IT FELL BACK (primary-contact-integrity spec 5.1): for an OWNED
 * conversation that resolves to the naked intro, `introFallback` carries every
 * reason in INTRO_FALLBACK_ORDER, so the open-group dialog can explain it.
 * Every check is evaluated - the resolver no longer stops at the first miss.
 * An owner read that fails (or finds nothing) decides nothing else:
 * `lookup_failed` alone. An unknown unit (read failed, found nothing, or no
 * repo) still decides the tour reasons, plus `lookup_failed`. A failed
 * property-contact read (P1 read_failed), a failed or empty settings read, or
 * an unformattable tour time ADDS `lookup_failed` beside the decided reasons.
 * Placements never carry the tour reasons; an ownerless conversation never
 * carries `introFallback`. The variant rule is unchanged: any reason means
 * naked.
 *
 * IT NEVER THROWS. Every read gets its OWN try/catch and degrades toward
```

3d. Replace the WHOLE function `resolveRelayComposeInputs` - from the line
`export async function resolveRelayComposeInputs(` through its closing `}`
(the last line before the blank line and the docblock whose second line is
` * The relay intro body, routed on the conversation's owner (spec 9.1).`) -
with:

```ts
export async function resolveRelayComposeInputs(
  owner: RelayOwner,
  deps: RelayComposeDeps,
  /** member_added only: resolve {role} for THIS contact (spec 9.4). */
  addedContactId?: string,
): Promise<RelayComposeInputs> {
  const log = deps.logger ?? defaultLogger;
  // An ownerless group's ONLY intro is the general one, so there is nothing to
  // explain (primary-contact-integrity spec 5.1) - and nothing is read.
  if (owner.type === null) return { variant: 'naked' };
  const nowIso = deps.nowIso ?? new Date().toISOString();
  // Every miss below is RECORDED rather than returned on (spec 5.1): the
  // open-group dialog lists all of them. Any reason at all means naked.
  const reasons = new Set<IntroFallbackReason>();

  let tenantId: string;
  let unitId: string;
  let scheduledAt: string | undefined;
  try {
    if (owner.type === 'tour') {
      // ToursRepo's getter is get(), never getById().
      const tour = await deps.toursRepo?.get(owner.id);
      if (!tour) return ownerUnreadable();
      tenantId = tour.tenantId;
      unitId = tour.unitId;
      // OPTIONAL on TourItem: a 'requested' tour has no time at all, which
      // spec 9.5 routes to the naked intro (there is no {when} to render) -
      // reason tour_not_scheduled. An empty string is no time either.
      //
      // A tour that has ALREADY STARTED is dropped here and takes exactly the
      // same route (reason tour_started), because both tour entries end
      // "Please let us know when you're on the way" - copy that assumes the
      // tour has not happened. This is the third writer of tour-time copy and
      // the same staleness class the ladder's fire-time gate
      // (retiredByTourStart) exists for; the two reachable paths are an
      // operator opening the group from a tour whose outcome is not recorded
      // yet, and a quiet-hours deferral that straddles the tour start
      // (routes/tours.ts defers the open to quiet-end, and this composes THEN).
      //
      // AT-OR-AFTER, matching retiredByTourStart's `now >= start` exactly
      // (round 2, R2-S1): one codebase answers "is forward-looking tour copy
      // stale at t=start" one way.
      //
      // An unparseable scheduledAt is NOT dropped here - Number.isFinite is
      // false, so it falls through to the formatter's own try/catch, which
      // records lookup_failed. An unparseable `nowIso` likewise leaves the
      // guard OFF (NaN comparisons are false) and the tour variant composes: a
      // deliberate fail-OPEN, because this resolver's first duty is never to
      // throw and never to lose an intro, and every production caller supplies
      // an ISO instant (the quiet-hours state, or the job's own default).
      scheduledAt =
        typeof tour.scheduledAt === 'string' && tour.scheduledAt.length > 0
          ? tour.scheduledAt
          : undefined;
      if (scheduledAt === undefined) {
        reasons.add('tour_not_scheduled');
      } else {
        const startedAt = Date.parse(scheduledAt);
        if (Number.isFinite(startedAt) && startedAt <= Date.parse(nowIso)) {
          scheduledAt = undefined;
          reasons.add('tour_started');
        }
      }
    } else {
      const placement = await deps.placementsRepo?.getById(owner.id);
      if (!placement) return ownerUnreadable();
      tenantId = placement.tenantId;
      unitId = placement.unitId;
    }
  } catch (err) {
    log.warn({ err, ownerType: owner.type, ownerId: owner.id }, 'relay copy: owner read failed - naked intro');
    return ownerUnreadable();
  }

  let unit: UnitItem | undefined;
  try {
    unit = await deps.unitsRepo?.getById(unitId);
  } catch (err) {
    log.warn({ err, unitId }, 'relay copy: unit read failed - naked intro');
  }

  // The role is a DIFFERENT question from the intro variant and is answered
  // even when the variant degrades: it needs only the unit roster.
  const role = resolveMemberRole(unit, tenantId, addedContactId);
  const withRole = role !== undefined ? { role } : {};

  // REUSE (spec 9.3): resolveTourContactNames applies the shared property-
  // contact lookup (lib/propertyContact, primary-contact-integrity P1), the
  // tenant de-dupe, and inertName's brace stripping (which is what keeps a
  // user-supplied name from re-opening a token). It never throws; the try is
  // belt-and-braces around the repo pick. `propertyContact` stays undefined
  // when the lookup could not run at all.
  let names: TourContactNames = {};
  let propertyContact: PropertyContactResult | undefined;
  if (deps.contactsRepo !== undefined) {
    try {
      const resolved = await resolveTourContactNames({
        tenantId,
        unit,
        contactsRepo: deps.contactsRepo,
        ...(deps.logger !== undefined && { logger: deps.logger }),
      });
      names = resolved.names;
      propertyContact = resolved.propertyContact;
    } catch (err) {
      log.warn({ err, unitId }, 'relay copy: name resolution failed - naked intro');
    }
  }
  const withNames = {
    ...(names.tenantFirstName !== undefined && { tenantFirstName: names.tenantFirstName }),
    ...withRole,
  };

  // The PROPERTY half (spec 5.1). An UNKNOWN unit - its read threw, found
  // nothing, or no units repo is wired - decides none of it: lookup_failed,
  // beside the tour reasons the owner read already decided.
  const where = unit === undefined ? '' : formatStreet(unit.address);
  let propertyContactFirstName: string | undefined;
  let noFirstNameContactId: string | undefined;
  if (unit === undefined) {
    reasons.add('lookup_failed');
  } else {
    if (propertyContact === undefined || propertyContact.kind === 'read_failed') {
      // A thrown candidate read is not absence (P1 never falls through it), and
      // no contacts repo means nothing could be looked up at all.
      reasons.add('lookup_failed');
    } else if (propertyContact.kind === 'nobody') {
      reasons.add(NOBODY_REASON[propertyContact.reason]);
    } else if (names.propertyContactFirstName === undefined) {
      reasons.add('property_contact_no_first_name');
      noFirstNameContactId = propertyContact.contactId;
    } else {
      propertyContactFirstName = names.propertyContactFirstName;
    }
    if (where.length === 0) reasons.add('no_street_address');
  }

  // The TOUR TIME. A placement reads no settings at all. Only a tour with a
  // usable, not-started time on a KNOWN unit gets here: every other tour
  // already carries its reason, and formatting could add nothing.
  //
  // A SETTINGS read failure (or no settings) records lookup_failed rather than
  // assuming the default zone: {time} and {when} are FACTS in a tenant's SMS,
  // and a wrong-zone "3:00 PM" is worse copy than the naked intro.
  let timing: IntroTiming | undefined =
    owner.type === 'placement' ? { variant: 'placement' } : undefined;
  if (owner.type === 'tour' && scheduledAt !== undefined && unit !== undefined) {
    const at = scheduledAt;
    let timezone: string | undefined;
    try {
      const settings = await deps.settingsRepo?.getOrgSettings();
      // The SAME seam the booked-too-late same-day test uses, so "today" here
      // and "today" there can never disagree (spec 9.1).
      if (settings) timezone = resolveQuietHoursTimezone(settings);
      else reasons.add('lookup_failed');
    } catch (err) {
      log.warn({ err }, 'relay copy: org settings read failed - naked intro');
      reasons.add('lookup_failed');
    }
    if (timezone !== undefined) {
      try {
        const time = formatLocalTime(at, timezone);
        // "on {when}", not Sam's "at {when}": our {when} renders "Tue, Sep 8 at
        // 3:00 PM" (tourCopy.ts builds it the same way), so "at Tue, Sep 8 at
        // 3:00 PM" reads badly. Cameron approved "on" for the dated form.
        timing =
          localDateOf(nowIso, timezone) === localDateOf(at, timezone)
            ? { variant: 'tour_today', time }
            : { variant: 'tour', when: `${formatLocalDate(at, timezone)} at ${time}` };
      } catch (err) {
        log.warn({ err, ownerId: owner.id }, 'relay copy: tour time unformattable - naked intro');
        reasons.add('lookup_failed');
      }
    }
  }

  if (reasons.size > 0 || propertyContactFirstName === undefined || timing === undefined) {
    // Every path that leaves a token unset has recorded a reason above; this
    // only keeps `reasons` non-empty should a later edit break that.
    if (reasons.size === 0) reasons.add('lookup_failed');
    return {
      variant: 'naked',
      ...withNames,
      introFallback: introFallbackOf(reasons, {
        unitId,
        ...(where.length > 0 && { street: where }),
        ...(noFirstNameContactId !== undefined && { propertyContactId: noFirstNameContactId }),
      }),
    };
  }

  const named = { ...withNames, propertyContactFirstName, where };
  if (timing.variant === 'placement') return { variant: 'placement', ...named };
  if (timing.variant === 'tour_today') return { variant: 'tour_today', ...named, time: timing.time };
  return { variant: 'tour', ...named, when: timing.when };
}
```

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/relayIntroFallback.test.ts test/relayFanOut.test.ts`

Expected: `Test Files  2 passed (2)`; `relayIntroFallback.test.ts` reports
`31 passed (31)`; no failure in `relayFanOut.test.ts` (its existing resolver,
composer and owned-job tests are unchanged and green).

Then the type check of the app sources + tests:

`cd W:/tmp/primary-contact-integrity/app && npx tsc -p tsconfig.test.json --noEmit`

Expected: exit 0, no output.

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: only `app/src/jobs/relayFanOut.ts` modified and
`app/test/relayIntroFallback.test.ts` untracked. Anything else: STOP and
report.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/jobs/relayFanOut.ts app/test/relayIntroFallback.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(relay): introFallback reasons on resolveRelayComposeInputs (primary-contact-integrity S3.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.2 - the relay intro job logs the general-intro fallback

Files:
- NEW `app/test/relayIntroFallbackJob.test.ts`
- `app/src/jobs/relayFanOut.ts`

Steps:

(1) Write the failing test. Create `app/test/relayIntroFallbackJob.test.ts`:

```ts
// primary-contact-integrity spec 5.2 (plan S3.2): the relay INTRO job logs ONE
// INFO line - ids and reason codes only - when it sends the general intro on an
// OWNED conversation. Never for an operator-edited intro, never for an
// ownerless group, and never from the member-added announcement.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  RELAY_INTRO_JOB,
  RELAY_MEMBER_ADDED_JOB,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const TENANT = '+15550100061';
const LANDLORD = '+15550100062';
const PM = '+15550100063';
const POOL = '+15550109061';
const STAMP = '2026-07-01T00:00:00.000Z';
/** The job's pinned clock: 09:00 New York on 2026-09-07. */
const JOB_NOW = '2026-09-07T13:00:00.000Z';
/** 15:00 New York the NEXT day: a future tour, so the dated tour intro. */
const FUTURE_AT = '2026-09-08T19:00:00.000Z';
/** A week before JOB_NOW: the tour has started, so the general intro. */
const PAST_AT = '2026-08-31T19:00:00.000Z';
const USED = 'relay intro: general intro used';

describe('relay.intro job - the general-intro INFO line (primary-contact-integrity spec 5.2)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;
  let capture: LogCapture;

  beforeEach(async () => {
    _resetForTests();
    capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      sendAttemptsRepo: world.sendAttemptsRepo,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      unitsRepo: world.unitsRepo,
      toursRepo: world.toursRepo,
      placementsRepo: world.placementsRepo,
      settingsRepo: world.settingsRepo,
      nowIso: JOB_NOW,
      logger,
    });
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);

    world.contacts.push(
      { contactId: 'c-tenant', type: 'tenant', phone: TENANT, firstName: 'Tina', lastName: 'Tenant' },
      { contactId: 'c-land', type: 'landlord', phone: LANDLORD, firstName: 'Larry', lastName: 'Land' },
      { contactId: 'c-pm', type: 'landlord', phone: PM, firstName: 'Pat', lastName: 'Manager' },
    );
    world.units.set('unit-job', {
      unitId: 'unit-job',
      landlordId: 'c-land',
      status: 'available',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts: [
        { contactId: 'c-land', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    world.toursMap.set('tour-job', {
      tourId: 'tour-job',
      tenantId: 'c-tenant',
      unitId: 'unit-job',
      scheduledAt: FUTURE_AT,
      status: 'scheduled',
      tourType: 'landlord_led',
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    await world.settingsRepo.putOrgSettings({ timezone: 'America/New_York' });
  });

  afterEach(() => {
    _resetForTests();
  });

  function seedRelay(owner: ConversationItem['owner'], extra: Partial<ConversationItem> = {}): void {
    const now = '2026-07-10T00:00:00.000Z';
    world.conversations.set('conv-job', {
      conversationId: 'conv-job',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
        { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
        { contactId: 'c-pm', phone: PM, name: 'Pat Manager' },
      ],
      ...(owner !== undefined && { owner }),
      created_at: now,
      ...extra,
    });
  }

  function setTourAt(scheduledAt: string): void {
    const tour = world.toursMap.get('tour-job')!;
    world.toursMap.set('tour-job', { ...tour, scheduledAt });
  }

  const usedLines = (): Record<string, unknown>[] => capture.lines.filter((l) => l['msg'] === USED);

  async function runIntro(): Promise<void> {
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-job' });
    await outbound.settle();
  }

  it('a tour that composes its own intro sends it and logs NO fallback line', async () => {
    seedRelay({ type: 'tour', id: 'tour-job' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain('Putting you in a group text with Larry');
    expect(usedLines()).toHaveLength(0);
  });

  it('a tour whose start has passed: the general intro and ONE INFO line, ids and reason codes only', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain("You're now connected with");
    const lines = usedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      conversationId: 'conv-job',
      ownerType: 'tour',
      ownerId: 'tour-job',
      reasons: ['tour_started'],
    });
    // PII (doc Sec 9): never a name or the street.
    const wire = JSON.stringify(lines[0]);
    expect(wire).not.toContain('Peachtree');
    expect(wire).not.toContain('Tina');
    expect(wire).not.toContain('Larry');
    expect(lines[0]).not.toHaveProperty('street');
  });

  it('a placement-owned group logs ownerType placement and its own reasons', async () => {
    world.units.set('unit-bare', {
      unitId: 'unit-bare',
      landlordId: 'c-land',
      status: 'available',
      contacts: [{ contactId: 'c-land', role: 'landlord', primaryContact: true }],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    const placement = await world.placementsRepo.create({
      tenantId: 'c-tenant',
      unitId: 'unit-bare',
      stage: 'awaiting_approval',
    });
    seedRelay({ type: 'placement', id: placement.placementId });
    await runIntro();
    const lines = usedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      conversationId: 'conv-job',
      ownerType: 'placement',
      ownerId: placement.placementId,
      reasons: ['no_street_address'],
    });
  });

  it('an operator-edited intro is sent verbatim and logs NO fallback line', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' }, { intro_body: 'Hand-written by the operator.' });
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toBe('Hand-written by the operator.');
    expect(usedLines()).toHaveLength(0);
  });

  it('an ownerless group sends the general intro and logs NO fallback line', async () => {
    seedRelay(undefined);
    await runIntro();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) expect(sent.body).toContain("You're now connected with");
    expect(usedLines()).toHaveLength(0);
  });

  it('the member-added announcement logs NO fallback line, even on a group whose intro falls back', async () => {
    setTourAt(PAST_AT);
    seedRelay({ type: 'tour', id: 'tour-job' });
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-job',
      addedMemberKey: 'c-pm',
    });
    await outbound.settle();
    expect(world.sent.length).toBeGreaterThan(0);
    expect(usedLines()).toHaveLength(0);
  });
});
```

(2) Run it RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/relayIntroFallbackJob.test.ts`

Expected RED: exit non-zero, `Tests  2 failed | 4 passed (6)`. The two
failures are the "tour whose start has passed" and "placement-owned" tests,
each with `AssertionError: expected [] to have a length of 1 but got +0`.

(3) Implement, in `app/src/jobs/relayFanOut.ts`, two Edit-tool edits.

3a. In `resolveOwnerInputs` (inside `registerRelayFanOutJobHandler`), replace

```ts
      log.warn({ err, ownerType: owner.type }, 'relay copy: repo construction failed - naked intro');
      return { variant: 'naked' };
```

with

```ts
      log.warn({ err, ownerType: owner.type }, 'relay copy: repo construction failed - naked intro');
      // An OWNED conversation whose reads cannot even be built is explained
      // like any unreadable owner (primary-contact-integrity spec 5.1).
      return ownerUnreadable();
```

3b. In the `RELAY_INTRO_JOB` handler, replace

```ts
      // Precedence 2-4: tour, then placement, then naked - routed on the
      // conversation's own owner, which this handler already holds.
      const inputs = await resolveOwnerInputs(
        conversation ? getOwner(conversation) : { type: null },
      );
      body = composeIntroBody(
        inputs,
        roster.map((m) => m.name),
      );
```

with

```ts
      // Precedence 2-4: tour, then placement, then naked - routed on the
      // conversation's own owner, which this handler already holds.
      const owner: RelayOwner = conversation ? getOwner(conversation) : { type: null };
      const inputs = await resolveOwnerInputs(owner);
      body = composeIntroBody(
        inputs,
        roster.map((m) => m.name),
      );
      // primary-contact-integrity spec 5.2, observability only: `introFallback`
      // is present exactly when an OWNED conversation resolved to the general
      // intro. Ids and reason codes ONLY - never a name or the street (PII,
      // doc Sec 9). The operator-edited branch above never reaches here, and
      // the member-added handler below ignores introFallback.
      if (owner.type !== null && inputs.introFallback !== undefined) {
        log.info(
          {
            conversationId: payload.relayConversationId,
            ownerType: owner.type,
            ownerId: owner.id,
            reasons: inputs.introFallback.reasons,
          },
          'relay intro: general intro used',
        );
      }
```

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/relayIntroFallbackJob.test.ts test/relayIntroFallback.test.ts test/relayFanOut.test.ts`

Expected: `Test Files  3 passed (3)`; `relayIntroFallbackJob.test.ts`
`6 passed (6)`; no failures anywhere.

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: only `app/src/jobs/relayFanOut.ts` modified and
`app/test/relayIntroFallbackJob.test.ts` untracked. Anything else: STOP.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/jobs/relayFanOut.ts app/test/relayIntroFallbackJob.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(relay): log the general-intro fallback reasons in the relay intro job (primary-contact-integrity S3.2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.3 - `RosterPreview.introFallback` on the tour and placement OPEN previews

Files:
- NEW `app/test/rosterPreviewIntroFallback.test.ts`
- `app/test/rosterEdits.test.ts` (two existing parity tests change)
- `app/test/toursApi.test.ts` (two new tests)
- `app/test/placementsApi.test.ts` (two new tests)
- `app/src/services/rosterEdits.ts`

Steps:

(1) Write the failing tests.

1a. Create `app/test/rosterPreviewIntroFallback.test.ts`:

```ts
// primary-contact-integrity spec 5.2 (plan S3.3): RosterPreview.introFallback
// is set by the tour and placement OPEN preview (buildOpenPreview) ONLY -
// never by the standalone preview or the add-member preview.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAddPreview,
  buildOpenPreview,
  buildStandaloneOpenPreview,
} from '../src/services/rosterEdits.js';
import { createLogger } from '../src/lib/logger.js';
import type { QuietHoursWindow } from '../src/lib/quietHours.js';
import type { RosterOwner, RosterResolutionDeps } from '../src/lib/rosterResolution.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const WINDOW: QuietHoursWindow = {
  enabled: true,
  start: '21:00',
  end: '08:00',
  timezone: 'America/New_York',
};
/** 14:00 New York on 2026-09-07: outside quiet hours, the day before the tour. */
const QUIET_OFF = { nowIso: '2026-09-07T18:00:00.000Z', window: WINDOW };
/** 15:00 New York on 2026-09-08. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
const TENANT_PHONE = '+15550100071';
const LANDLORD_PHONE = '+15550100072';
const THREAD_ID = 'conv-preview-fallback';
const STAMP = '2026-07-01T00:00:00.000Z';
const MEMBERS: ConversationParticipant[] = [
  { contactId: 'c-tenant', phone: TENANT_PHONE, name: 'Tina Tenant' },
  { contactId: 'c-land', phone: LANDLORD_PHONE, name: 'Larry Land' },
];

describe('RosterPreview.introFallback (primary-contact-integrity spec 5.2)', () => {
  let world: FakeWorld;

  beforeEach(async () => {
    world = createFakeWorld();
    world.contacts.push(
      {
        contactId: 'c-tenant',
        type: 'tenant',
        phone: TENANT_PHONE,
        firstName: 'Tina',
        lastName: 'Tenant',
        sms_opt_out: false,
      },
      {
        contactId: 'c-land',
        type: 'landlord',
        phone: LANDLORD_PHONE,
        firstName: 'Larry',
        lastName: 'Land',
        sms_opt_out: false,
      },
    );
    // 470 Bolton's shape: a street, no landlord of record, nobody on the roster.
    world.units.set('unit-zero', {
      unitId: 'unit-zero',
      status: 'available',
      address: { line1: '470 Bolton Rd', city: 'Atlanta', state: 'GA', zip: '30318' },
      contacts: [],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    world.units.set('unit-ok', {
      unitId: 'unit-ok',
      landlordId: 'c-land',
      status: 'available',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts: [{ contactId: 'c-land', role: 'landlord', primaryContact: true }],
      created_at: STAMP,
      updated_at: STAMP,
    } as never);
    for (const [tourId, unitId] of [
      ['tour-zero', 'unit-zero'],
      ['tour-ok', 'unit-ok'],
    ] as const) {
      world.toursMap.set(tourId, {
        tourId,
        tenantId: 'c-tenant',
        unitId,
        scheduledAt: TOUR_AT,
        status: 'scheduled',
        tourType: 'landlord_led',
        created_at: STAMP,
        updated_at: STAMP,
      } as never);
    }
    // The participants source: resolveRoster reads this thread's members, so no
    // default roster is needed. buildOpenPreview is called DIRECTLY (the route
    // refuses once a thread exists), exactly as rosterEdits.test.ts does.
    world.conversations.set(THREAD_ID, {
      conversationId: THREAD_ID,
      status: 'open',
      last_activity_at: STAMP,
      type: 'relay_group',
      ai_mode: 'auto',
      created_at: STAMP,
      participants: MEMBERS,
    });
    await world.settingsRepo.putOrgSettings({ timezone: 'America/New_York' });
  });

  function deps(): RosterResolutionDeps {
    return {
      conversations: world.conversationsRepo,
      units: world.unitsRepo,
      contacts: world.contactsRepo,
      tours: world.toursRepo,
      placements: world.placementsRepo,
      settings: world.settingsRepo,
      log: createLogger({ destination: createLogCapture().stream }),
    };
  }

  function tourOwner(tourId: string, unitId: string): RosterOwner {
    return { type: 'tour', id: tourId, tenantId: 'c-tenant', unitId, groupThreadId: THREAD_ID };
  }

  it('the OPEN preview carries the resolver introFallback when the owner falls back to the general intro', async () => {
    const outcome = await buildOpenPreview(deps(), tourOwner('tour-zero', 'unit-zero'), QUIET_OFF);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.body).toContain("You're now connected with");
    expect(outcome.preview.introFallback).toEqual({
      reasons: ['no_property_contact'],
      unitId: 'unit-zero',
      street: '470 Bolton Rd',
    });
  });

  it('the OPEN preview carries NO introFallback when the tour intro composes', async () => {
    const outcome = await buildOpenPreview(deps(), tourOwner('tour-ok', 'unit-ok'), QUIET_OFF);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.body).toContain('Putting you in a group text with Larry');
    expect(outcome.preview.introFallback).toBeUndefined();
  });

  it('the STANDALONE preview never carries introFallback', async () => {
    const preview = await buildStandaloneOpenPreview(
      { contacts: world.contactsRepo, conversations: world.conversationsRepo },
      MEMBERS,
      QUIET_OFF,
    );
    expect(preview.introFallback).toBeUndefined();
  });

  it('the ADD-MEMBER preview never carries introFallback, even on an owner whose intro falls back', async () => {
    const outcome = await buildAddPreview(
      deps(),
      tourOwner('tour-zero', 'unit-zero'),
      { contactId: 'c-new', phone: '+15550100073', name: 'Nia New', optedOut: false },
      QUIET_OFF,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.preview.introFallback).toBeUndefined();
  });
});
```

1b. In `app/test/rosterEdits.test.ts`, the test
`'produces an IDENTICAL preview for the same member set'` changes. Replace

```ts
    expect(standalone).toEqual(ownerOutcome.preview);
    // Spelled out too, so a future failure names the field that drifted.
```

with

```ts
    // The ONE intended difference (primary-contact-integrity spec 5.2): an
    // owner OPEN preview explains a general intro, and this fixture wires no
    // tours repo, so its owner read cannot answer. The standalone preview
    // never carries introFallback.
    const { introFallback, ...ownerPreview } = ownerOutcome.preview;
    expect(introFallback).toEqual({ reasons: ['lookup_failed'] });
    expect(standalone.introFallback).toBeUndefined();
    expect(standalone).toEqual(ownerPreview);
    // Spelled out too, so a future failure names the field that drifted.
```

1c. In the same file, the test
`'carries the SAME quiet-hours verdict through both paths'` changes. Replace

```ts
    expect(standalone.quietEndsAt).toBe(ownerOutcome.preview.quietEndsAt);
    expect(standalone).toEqual(ownerOutcome.preview);
```

with

```ts
    expect(standalone.quietEndsAt).toBe(ownerOutcome.preview.quietEndsAt);
    // introFallback is owner-only (spec 5.2); see the test above.
    const { introFallback: _ownerOnly, ...ownerPreview } = ownerOutcome.preview;
    expect(standalone).toEqual(ownerPreview);
```

1d. In `app/test/toursApi.test.ts`, replace the line

```ts
  it('preview-open carries duplicateOf when a live group already holds exactly this roster', async () => {
```

with

```ts
  it('preview-open explains the general intro: introFallback carries the reasons, the unit and the street (primary-contact-integrity spec 5.2)', async () => {
    const { app } = makeWebhookHarness({ world });
    await world.settingsRepo.putOrgSettings({ quietHoursEnabled: false });
    const tourId = await createTour(app, { scheduledAt: '2020-01-10T10:00:00.000Z' });

    const res = await authed(app).get(`/api/tours/${tourId}/roster/preview-open`);

    expect(res.status).toBe(200);
    expect(res.body.introFallback).toEqual({
      reasons: ['tour_started'],
      unitId: 'unit-abc',
      street: '318 Marietta St',
    });
  });

  it('preview-open carries NO introFallback when the tour intro composes', async () => {
    const { app } = makeWebhookHarness({ world });
    await world.settingsRepo.putOrgSettings({ quietHoursEnabled: false });
    const tourId = await createTour(app, { scheduledAt: FUTURE_TOUR_AT });

    const res = await authed(app).get(`/api/tours/${tourId}/roster/preview-open`);

    expect(res.status).toBe(200);
    expect(res.body.body).toContain('Putting you in a group text with Pat to tour 318 Marietta St');
    expect(res.body).not.toHaveProperty('introFallback');
  });

  it('preview-open carries duplicateOf when a live group already holds exactly this roster', async () => {
```

1e. In `app/test/placementsApi.test.ts`, replace the line

```ts
  it('preview-open carries duplicateOf when a live group already holds exactly this roster', async () => {
```

with

```ts
  it('preview-open explains a general intro with introFallback - never a tour reason (primary-contact-integrity spec 5.1-5.2)', async () => {
    // The street is what the placement intro needs and this unit loses it; the
    // primary (Pat) still resolves, so it is the ONLY reason.
    const { address: _dropped, ...streetless } = world.units.get('unit-r')!;
    world.units.set('unit-r', streetless as never);
    const placementId = await createPlacement();

    const res = await authedReq.get(`/api/placements/${placementId}/roster/preview-open`);

    expect(res.status).toBe(200);
    expect(res.body.body).toContain("You're now connected with");
    expect(res.body.introFallback).toEqual({ reasons: ['no_street_address'], unitId: 'unit-r' });
  });

  it('preview-open carries NO introFallback when the placement intro composes', async () => {
    const placementId = await createPlacement();

    const res = await authedReq.get(`/api/placements/${placementId}/roster/preview-open`);

    expect(res.status).toBe(200);
    expect(res.body.body).toContain('Excited to have you move into 52 Edgewood Ave.');
    expect(res.body).not.toHaveProperty('introFallback');
  });

  it('preview-open carries duplicateOf when a live group already holds exactly this roster', async () => {
```

(2) Run RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterPreviewIntroFallback.test.ts test/rosterEdits.test.ts test/toursApi.test.ts test/placementsApi.test.ts`

Expected RED: exit non-zero, `Tests  4 failed`, one per file:
- `rosterPreviewIntroFallback.test.ts` > `the OPEN preview carries the resolver introFallback ...`
  - `AssertionError: expected undefined to deeply equal { reasons: [ 'no_property_contact' ], ... }`
- `rosterEdits.test.ts` > `produces an IDENTICAL preview for the same member set`
  - `AssertionError: expected undefined to deeply equal { reasons: [ 'lookup_failed' ] }`
- `toursApi.test.ts` > `preview-open explains the general intro: ...`
  - `AssertionError: expected undefined to deeply equal { reasons: [ 'tour_started' ], ... }`
- `placementsApi.test.ts` > `preview-open explains a general intro with introFallback ...`
  - `AssertionError: expected undefined to deeply equal { reasons: [ 'no_street_address' ], ... }`

(3) Implement, in `app/src/services/rosterEdits.ts`, three Edit-tool edits.

3a. Replace

```ts
  resolveRelayComposeInputs,
  type RelayComposeDeps,
  type RelayComposeInputs,
} from '../jobs/relayFanOut.js';
```

with

```ts
  resolveRelayComposeInputs,
  type IntroFallback,
  type RelayComposeDeps,
  type RelayComposeInputs,
} from '../jobs/relayFanOut.js';
```

3b. Replace (the end of `interface RosterPreview`)

```ts
  duplicateOf?: DuplicateOpenGroup;
}

export type RosterPreviewOutcome =
```

with

```ts
  duplicateOf?: DuplicateOpenGroup;
  /**
   * primary-contact-integrity spec 5.2: why an OWNED open falls back to the
   * general intro - every reason, in order, plus the ids the dialog links to.
   * Set ONLY by the tour and placement OPEN preview (buildOpenPreview); never
   * by the standalone preview or the add-member preview. Absent = the owner's
   * own intro (or an ownerless group).
   */
  introFallback?: IntroFallback;
}

export type RosterPreviewOutcome =
```

3c. At the end of `buildOpenPreview`, replace

```ts
  return {
    ok: true,
    preview: buildOpenPreviewFromParts(
      {
        inputs,
        bodyMembers: provisioned.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: resolvedMemberKey(m),
        })),
        recipients: view.members.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: m.memberKey,
          // Feeds recipientLabel's "Unnamed number ...1234" for a member with no
          // saved name. RosterMemberView already exposes it; nothing widened.
          ...(m.phoneLast4 !== undefined && { phoneLast4: m.phoneLast4 }),
          reachability: m.reachability,
        })),
        ...(duplicateOf !== undefined && { duplicateOf }),
      },
      quiet,
    ),
  };
}
```

with

```ts
  const preview = buildOpenPreviewFromParts(
    {
      inputs,
      bodyMembers: provisioned.map((m) => ({
        ...(m.name !== undefined && { name: m.name }),
        memberKey: resolvedMemberKey(m),
      })),
      recipients: view.members.map((m) => ({
        ...(m.name !== undefined && { name: m.name }),
        memberKey: m.memberKey,
        // Feeds recipientLabel's "Unnamed number ...1234" for a member with no
        // saved name. RosterMemberView already exposes it; nothing widened.
        ...(m.phoneLast4 !== undefined && { phoneLast4: m.phoneLast4 }),
        reachability: m.reachability,
      })),
      ...(duplicateOf !== undefined && { duplicateOf }),
    },
    quiet,
  );
  // primary-contact-integrity spec 5.2: the OPEN preview is the ONLY one that
  // explains a general intro. buildOpenPreviewFromParts never copies it (the
  // standalone preview shares that builder, and buildAddPreview composes its
  // own), so it is attached here and only here.
  return {
    ok: true,
    preview:
      inputs.introFallback === undefined
        ? preview
        : { ...preview, introFallback: inputs.introFallback },
  };
}
```

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/rosterPreviewIntroFallback.test.ts test/rosterEdits.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts`

Expected: `Test Files  5 passed (5)`, no failures
(`rosterPreviewIntroFallback.test.ts` `4 passed (4)`).

`cd W:/tmp/primary-contact-integrity/app && npx tsc -p tsconfig.test.json --noEmit`

Expected: exit 0, no output.

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: modified `app/src/services/rosterEdits.ts`,
`app/test/rosterEdits.test.ts`, `app/test/toursApi.test.ts`,
`app/test/placementsApi.test.ts`; untracked
`app/test/rosterPreviewIntroFallback.test.ts`. Anything else: STOP.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/services/rosterEdits.ts app/test/rosterEdits.test.ts app/test/toursApi.test.ts app/test/placementsApi.test.ts app/test/rosterPreviewIntroFallback.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(roster): RosterPreview.introFallback on the tour and placement open preview (primary-contact-integrity S3.3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.4 - the unit Activity projection serves the primary-assignment `reason`

Files:
- `app/test/unitsApiActivity.test.ts`
- `app/src/routes/units.ts` (ONLY `UnitActivityEvent` and `toUnitActivityEvent`)

Steps:

(1) Write the failing tests. In `app/test/unitsApiActivity.test.ts`, replace

```ts
    const alsoBad = await authedGet(app, '/api/units/u-many/activity?limit=101');
    expect(alsoBad.status).toBe(400);
  });
});
```

with

```ts
    const alsoBad = await authedGet(app, '/api/units/u-many/activity?limit=101');
    expect(alsoBad.status).toBe(400);
  });

  // primary-contact-integrity C11: the event the roster writes, the contact
  // delete fan-out and the backfill script append when the primary moves
  // without a click. `reason` is projected for THIS event only.
  it('projects unit_primary_contact_assigned with contactId, contactName, reason and from', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-handoff');
    seedContact(world, 'c-heir', { type: 'landlord', firstName: 'Mark', lastName: 'Passmore' });
    await world.auditRepo.append('units#u-handoff', 'unit_primary_contact_assigned', {
      contactId: 'c-heir',
      reason: 'handoff_on_delete',
      from: 'c-gone',
    });

    const res = await authedGet(app, '/api/units/u-handoff/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      type: 'unit_primary_contact_assigned',
      contactId: 'c-heir',
      contactName: 'Mark Passmore',
      reason: 'handoff_on_delete',
      from: 'c-gone',
    });
  });

  it('projects every primary-assignment reason code verbatim', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-reasons');
    const codes = ['auto_on_add', 'handoff_on_remove', 'handoff_on_delete', 'handoff_on_restore', 'backfill'];
    for (const reason of codes) {
      await world.auditRepo.append('units#u-reasons', 'unit_primary_contact_assigned', {
        contactId: 'c-x',
        reason,
      });
    }

    const res = await authedGet(app, '/api/units/u-reasons/activity');
    expect(res.status).toBe(200);
    const served = (res.body.events as Array<{ reason?: string }>).map((e) => e.reason);
    expect([...served].sort()).toEqual([...codes].sort());
  });

  it('keeps a listing_status_changed free-text reason OFF the wire', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-status-reason', { status: 'available' });
    await world.auditRepo.append('units#u-status-reason', 'listing_status_changed', {
      actor: TEST_SESSION_USER.userId,
      from: 'setup',
      to: 'available',
      source: 'manual',
      reason: 'Owner asked to pause until spring',
    });

    const res = await authedGet(app, '/api/units/u-status-reason/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'listing_status_changed', from: 'setup', to: 'available' });
    expect(res.body.events[0]).not.toHaveProperty('reason');
  });
});
```

(2) Run RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiActivity.test.ts`

Expected RED: exit non-zero, `Tests  2 failed`. The first new test fails with
`AssertionError: expected { id: ..., type: 'unit_primary_contact_assigned', ... } to deeply equal { ..., reason: 'handoff_on_delete', ... }`;
the second with `expected [ undefined, undefined, ... ] to deeply equal [ 'auto_on_add', ... ]`.
The listing-status pin and every existing test pass.

(3) Implement, in `app/src/routes/units.ts`, three Edit-tool edits (each
anchor is ASCII; the docblock lines around them carry pre-existing non-ASCII
dashes and are NOT touched).

3a. Replace the line

```ts
 * tour_reopened).
```

with

```ts
 * tour_reopened, unit_primary_contact_assigned).
```

3b. Replace (the end of `interface UnitActivityEvent`)

```ts
  tourId?: string;
  outcome?: string;
}
```

with

```ts
  tourId?: string;
  outcome?: string;
  /**
   * unit_primary_contact_assigned ONLY (primary-contact-integrity C11): why
   * the primary moved without a click - auto_on_add | handoff_on_remove |
   * handoff_on_delete | handoff_on_restore | backfill.
   */
  reason?: string;
}
```

3c. Replace (the end of `toUnitActivityEvent`)

```ts
    ...(str('outcome') !== undefined && { outcome: str('outcome') }),
  };
}
```

with

```ts
    ...(str('outcome') !== undefined && { outcome: str('outcome') }),
    // primary-contact-integrity C11: `reason` is lifted for the primary-contact
    // event ONLY. listing_status_changed stores a FREE-TEXT `reason` under the
    // same key (services/statusTransition setListingStatus), which this
    // projection has never served and must not start serving.
    ...(e.event_type === 'unit_primary_contact_assigned' &&
      str('reason') !== undefined && { reason: str('reason') }),
  };
}
```

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiActivity.test.ts`

Expected: `Test Files  1 passed (1)`, no failures.

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: only `app/src/routes/units.ts` and
`app/test/unitsApiActivity.test.ts` modified. Anything else: STOP.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/unitsApiActivity.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(units): project the primary-assignment reason on the unit Activity wire (primary-contact-integrity S3.4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.5 - GET `/api/units/:id`: row flags and the `propertyContact` block

Files:
- NEW `app/test/unitsApiPropertyContact.test.ts`
- `app/test/unitsApiRoster.test.ts` (one existing test changes)
- `app/src/routes/units.ts` (ONLY: the `propertyContact.js` import, new
  module-level types + helper inserted before `const DEFAULT_PAGE_LIMIT = 50;`,
  the tail of `enrichRoster` + two new closures beside it, and the GET
  `/:unitId` response line)

Steps:

(1) Write the failing tests.

1a. Create `app/test/unitsApiPropertyContact.test.ts`:

```ts
// primary-contact-integrity spec 7.5 (plan S3.5): GET /api/units/:id serves the
// property page's contact facts ONLY from a COMPLETE read of the roster's
// contact ids AND landlordId (spec 4.2): per-row `deleted` / `caseworker`, and
// the unit's `propertyContact` block. Either failure shape of that read (a raw
// chunk error or IncompleteBatchReadError) serves today's best-effort rows -
// names, NO flags - and NO block. The GET never 500s.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T12:00:00.000Z';

type WireRow = Record<string, unknown> & { contactId: string };

/** A unit whose landlord of record is `c-ll` unless overridden. */
function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  } as UnitItem);
}

/** The importer's shape: NO landlordId attribute at all. */
function seedUnitWithoutLandlord(
  world: FakeWorld,
  unitId: string,
  contacts: NonNullable<UnitItem['contacts']>,
): void {
  seedUnit(world, unitId, { contacts });
  delete (world.units.get(unitId) as Partial<UnitItem>).landlordId;
}

function seedContact(world: FakeWorld, contactId: string, overrides: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...overrides } as ContactItem);
}

const getUnit = (app: Express, unitId: string) =>
  request(app)
    .get(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);

/** Make ONLY the complete (requireComplete) batch read throw; the best-effort read still answers. */
function failCompleteRead(world: FakeWorld, error: Error): void {
  const real = world.contactsRepo.getManyByIds.bind(world.contactsRepo);
  vi.spyOn(world.contactsRepo, 'getManyByIds').mockImplementation(async (ids, opts) => {
    if (opts?.requireComplete === true) throw error;
    return real(ids, opts);
  });
}

/** One deleted primary, one caseworker, one plain landlord-typed contact. */
function seedMixedRoster(world: FakeWorld, unitId: string): void {
  seedUnitWithoutLandlord(world, unitId, [
    { contactId: 'c-gone', role: 'pm', primaryContact: true },
    { contactId: 'c-cw', role: 'other', primaryContact: false },
    { contactId: 'c-mark', role: 'pm', primaryContact: false },
  ]);
  seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });
  seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey', lastName: 'Worker' });
  seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/units/:id - row flags and the propertyContact block (complete read, spec 7.5)', () => {
  it('a landlord-only unit: the landlord is the property contact, and nobody inherits it', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ll');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });

    const res = await getUnit(app, 'u-ll');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({ contactId: 'c-ll', heirIfPrimaryRemoved: null });
  });

  it('470 Bolton: no landlord of record and no flagged primary - contactId null, reason none, no heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-bolton', [{ contactId: 'c-mark', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });

    const res = await getUnit(app, 'u-bolton');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-mark', role: 'pm', primaryContact: false, name: 'Mark Passmore' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'none',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a deleted flagged primary: its row is marked, reason deleted, and the earliest ELIGIBLE live contact is the heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-del', [
      { contactId: 'c-gone', role: 'pm', primaryContact: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-pam', role: 'pm', primaryContact: false },
    ]);
    seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey', lastName: 'Worker' });
    seedContact(world, 'c-ten', { type: 'tenant', firstName: 'Tia', lastName: 'Tenant' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await getUnit(app, 'u-del');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-gone', role: 'pm', primaryContact: true, name: 'Gail Gone', deleted: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false, name: 'Casey Worker', caseworker: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false, name: 'Tia Tenant' },
      { contactId: 'c-pam', role: 'pm', primaryContact: false, name: 'Pam Two' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: { contactId: 'c-pam', name: 'Pam Two' },
    });
  });

  it('only ineligible live contacts (a caseworker, a tenant): no heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-noheir', [
      { contactId: 'c-gone', role: 'pm', primaryContact: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    seedContact(world, 'c-gone', { firstName: 'Gail', deleted_at: DELETED_AT });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey' });
    seedContact(world, 'c-ten', { type: 'tenant', firstName: 'Tia' });

    const res = await getUnit(app, 'u-noheir');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a deleted primary next to a live landlord of record: the landlord is the property contact AND the heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-both', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });

    const res = await getUnit(app, 'u-both');

    expect(res.status).toBe(200);
    const gone = (res.body.unit.contacts as WireRow[]).find((r) => r.contactId === 'c-gone');
    expect(gone).toMatchObject({ deleted: true });
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-ll', name: 'Lee Lord' },
    });
  });

  it('an OFF-roster landlord of record is read too, and named as the heir from that read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-off', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });

    const res = await getUnit(app, 'u-off');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-pat', role: 'pm', primaryContact: true, name: 'Pat Manager' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-pat',
      heirIfPrimaryRemoved: { contactId: 'c-ll', name: 'Lee Lord' },
    });
  });

  it('an heir with no name on record carries its id only', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-noname', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat' });
    seedContact(world, 'c-ll');

    const res = await getUnit(app, 'u-noname');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact.heirIfPrimaryRemoved).toEqual({ contactId: 'c-ll' });
  });

  it('a landlord id that names NO contact record reads as deleted', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ghost', { landlordId: 'c-ghost' });

    const res = await getUnit(app, 'u-ghost');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ghost', role: 'landlord', primaryContact: true, deleted: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a soft-deleted caseworker row carries BOTH flags', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-cw', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-cw', {
      type: 'partner',
      role: 'Caseworker',
      firstName: 'Casey',
      lastName: 'Worker',
      deleted_at: DELETED_AT,
    });

    const res = await getUnit(app, 'u-cw');

    expect(res.status).toBe(200);
    expect((res.body.unit.contacts as WireRow[]).find((r) => r.contactId === 'c-cw')).toEqual({
      contactId: 'c-cw',
      role: 'other',
      primaryContact: false,
      name: 'Casey Worker',
      deleted: true,
      caseworker: true,
    });
  });

  it('the complete read is ONE requireComplete batch read of the roster ids AND landlordId', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-reads', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat' });
    seedContact(world, 'c-ll', { firstName: 'Lee' });
    const reads = vi.spyOn(world.contactsRepo, 'getManyByIds');

    const res = await getUnit(app, 'u-reads');

    expect(res.status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    expect([...(reads.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['c-ll', 'c-pat']);
    expect(reads.mock.calls[0]?.[1]).toMatchObject({ requireComplete: true });
  });
});

describe("GET /api/units/:id - an incomplete read serves today's rows, no flags, no block, never a 500", () => {
  const shapes: [string, () => Error][] = [
    ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
    ['IncompleteBatchReadError', () => new IncompleteBatchReadError(1, 3)],
  ];
  for (const [shape, makeError] of shapes) {
    it(`${shape}: best-effort names, no deleted/caseworker flags, no propertyContact`, async () => {
      const { app, world } = makeWebhookHarness();
      seedMixedRoster(world, 'u-inc');
      failCompleteRead(world, makeError());

      const res = await getUnit(app, 'u-inc');

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-gone', role: 'pm', primaryContact: true, name: 'Gail Gone' },
        { contactId: 'c-cw', role: 'other', primaryContact: false, name: 'Casey Worker' },
        { contactId: 'c-mark', role: 'pm', primaryContact: false, name: 'Mark Passmore' },
      ]);
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });
  }

  it('both reads failing: bare rows, no block, still 200', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-down');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('contacts table unavailable'));

    const res = await getUnit(app, 'u-down');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(res.body.unit).not.toHaveProperty('propertyContact');
  });
});
```

1b. In `app/test/unitsApiRoster.test.ts`, the test
`'returns a back-compat single-row roster for a roster-less unit (derived from landlordId)'`
changes: its landlord now needs a contact record (a landlordId naming no
record reads as deleted, pinned in `unitsApiPropertyContact.test.ts`).
Replace

```ts
    seedUnit(world, 'u-1', { landlordId: 'c-ll-9' });
```

with

```ts
    seedUnit(world, 'u-1', { landlordId: 'c-ll-9' });
    // A LIVE landlord record: a landlordId naming no record now reads as
    // deleted (primary-contact-integrity spec 7.5).
    seedContact(world, 'c-ll-9');
```

and replace

```ts
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll-9', role: 'landlord', primaryContact: true },
    ]);
```

with

```ts
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll-9', role: 'landlord', primaryContact: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({ contactId: 'c-ll-9', heirIfPrimaryRemoved: null });
```

(2) Run RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPropertyContact.test.ts test/unitsApiRoster.test.ts`

Expected RED: exit non-zero, `Tests  11 failed`:
`unitsApiPropertyContact.test.ts` `10 failed | 3 passed (13)` (every
complete-read test; the three incomplete-read pins already pass) and the one
changed `unitsApiRoster.test.ts` test. Typical lines:
`AssertionError: expected undefined to deeply equal { contactId: 'c-ll', heirIfPrimaryRemoved: null }`
and, for the call-shape test, `expected undefined to match object { requireComplete: true }`.

(3) Implement, in `app/src/routes/units.ts`, four Edit-tool edits.

3a. The import (ruling R2). After Task S2.8, `app/src/routes/units.ts` has
exactly one propertyContact import, and it reads exactly as below. Confirm
first:

`cd W:/tmp/primary-contact-integrity && grep -n "from '../lib/propertyContact.js'" app/src/routes/units.ts`

Expected: ONE line,
`import { chooseHeir, isAutoRoutingEligible, readRosterContacts } from '../lib/propertyContact.js';`.
Anything else: stop and report. Then Edit, old_string:

```ts
import { chooseHeir, isAutoRoutingEligible, readRosterContacts } from '../lib/propertyContact.js';
```

new_string:

```ts
import {
  chooseHeir,
  decidePropertyContact,
  isAutoRoutingEligible,
  readRosterContacts,
  rosterContactIds,
} from '../lib/propertyContact.js';
```

The `isDeleted as isContactDeleted` import from `'../repos/contactsRepo.js'`
that 3c uses is already present (Task S2.4 step (b) restored it). Do NOT add
it again (a duplicate identifier fails typecheck).

3b. Insert the wire types and the pure block helper. Replace the line

```ts
const DEFAULT_PAGE_LIMIT = 50;
```

with

```ts
/**
 * primary-contact-integrity spec 7.5: one roster row as the property page
 * receives it. The two flags are RESPONSE-only (never stored) and set ONLY from
 * a complete read of the roster's contacts: `deleted` when the row's contact is
 * soft-deleted or has no record, `caseworker` when it is a caseworker
 * (lib/caseworkers isCaseworker). Absent otherwise.
 */
interface UnitContactView extends UnitContact {
  deleted?: true;
  caseworker?: true;
}

/**
 * primary-contact-integrity spec 7.5: who this property's contact is. Served on
 * the unit ONLY when the roster read was complete (absent = could not tell).
 */
interface PropertyContactBlock {
  /** P1 (lib/propertyContact decidePropertyContact) with no tenant; null = nobody. */
  contactId: string | null;
  /** Why nobody, when contactId is null. */
  reason?: 'none' | 'deleted';
  /**
   * The heir function (chooseHeir) excluding the current flagged primary: who
   * takes over if that row is removed. null when nobody would, and when no row
   * is flagged (there is no primary to remove). `name` is the heir's display
   * name from the same read - present even for an off-roster landlord, who has
   * no row to take a name from.
   */
  heirIfPrimaryRemoved: { contactId: string; name?: string } | null;
}

/**
 * primary-contact-integrity spec 7.5: decide the propertyContact block from ONE
 * complete roster read (`byId` holds every roster id and landlordId that has a
 * record; an absent id is a missing contact). PURE. Undefined = could not tell
 * - unreachable on a complete read (P1 with no tenant never answers is_tenant,
 * an all-ok lookup never answers read_failed, and chooseHeir with a read never
 * answers unknown), kept so the caller omits the block rather than inventing
 * one.
 */
function propertyContactBlockOf(
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>,
  byId: Map<string, ContactItem>,
): PropertyContactBlock | undefined {
  const decided = decidePropertyContact({
    unit,
    lookup: (contactId) => ({ ok: true as const, contact: byId.get(contactId) }),
  });
  let contactId: string | null;
  let reason: 'none' | 'deleted' | undefined;
  if (decided.kind === 'found') {
    contactId = decided.contactId;
  } else if (decided.kind === 'nobody' && decided.reason !== 'is_tenant') {
    contactId = null;
    reason = decided.reason;
  } else {
    return undefined;
  }

  const roster = unitContacts(unit);
  const primary = roster.find((row) => row.primaryContact === true);
  let heirIfPrimaryRemoved: PropertyContactBlock['heirIfPrimaryRemoved'] = null;
  if (primary !== undefined) {
    const heir = chooseHeir({
      roster,
      landlordId: unit.landlordId,
      exclude: primary.contactId,
      read: { ok: true as const, byId },
    });
    if (heir.kind === 'unknown') return undefined;
    if (heir.kind === 'heir') {
      const heirContact = byId.get(heir.contactId);
      const name = heirContact !== undefined ? displayNameOfContact(heirContact) : undefined;
      heirIfPrimaryRemoved = { contactId: heir.contactId, ...(name !== undefined && { name }) };
    }
  }
  return { contactId, ...(reason !== undefined && { reason }), heirIfPrimaryRemoved };
}

const DEFAULT_PAGE_LIMIT = 50;
```

3c. The roster readers. Inside `createUnitsRouter`, replace the tail of
`enrichRoster`:

```ts
    return roster.map((row) => {
      const contact = byId.get(row.contactId);
      const name = contact ? displayNameOfContact(contact) : undefined;
      const company =
        contact && typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;
      // Read-time enrichment is authoritative: drop any stale stored name/company
      // and re-set ONLY when the contact currently carries one.
      const { name: _staleName, company: _staleCompany, ...rest } = row;
      return {
        ...rest,
        ...(name !== undefined && { name }),
        ...(company !== undefined && { company }),
      };
    });
  }
```

with

```ts
    return roster.map((row) => enrichRow(row, byId.get(row.contactId)));
  }

  /**
   * One roster row's read-time name/company from `contact` (undefined: the row
   * serves un-enriched). Read-time enrichment is authoritative: any stale
   * stored name/company is dropped and re-set ONLY when the contact currently
   * carries one. Shared by enrichRoster and enrichRosterView so the two can
   * never name a row differently.
   */
  function enrichRow(row: UnitContact, contact: ContactItem | undefined): UnitContact {
    const name = contact ? displayNameOfContact(contact) : undefined;
    const company =
      contact && typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;
    const { name: _staleName, company: _staleCompany, ...rest } = row;
    return {
      ...rest,
      ...(name !== undefined && { name }),
      ...(company !== undefined && { company }),
    };
  }

  /**
   * primary-contact-integrity spec 7.5: the roster as the PROPERTY PAGE reads
   * it - GET /api/units/:id and the two contact-list writes. ONE complete read
   * (requireComplete, lib/propertyContact readRosterContacts) of the roster's
   * contact ids AND landlordId - an off-roster landlord of record must not read
   * as missing. On that complete read every row gets `deleted: true` (contact
   * soft-deleted or missing) and `caseworker: true` (isCaseworker), each only
   * when it holds, and the unit gets the `propertyContact` block. When the read
   * fails in EITHER shape (a raw chunk error or IncompleteBatchReadError -
   * neither carries a partial map; readRosterContacts answers { ok: false }
   * for both) the rows fall back to enrichRoster's best-effort read exactly as
   * before and the block is ABSENT ("could not tell"). readRosterContacts never
   * throws and enrichRoster guards its own read, so the GET never 500s here.
   * enrichRoster itself is unchanged for the other caller (the unit restore).
   */
  async function enrichRosterView(
    unit: UnitItem,
  ): Promise<{ contacts: UnitContactView[]; propertyContact?: PropertyContactBlock }> {
    const read = await readRosterContacts(contacts, rosterContactIds(unit), log);
    if (!read.ok) return { contacts: await enrichRoster(unit) };
    const rows = unitContacts(unit).map((row): UnitContactView => {
      const contact = read.byId.get(row.contactId);
      return {
        ...enrichRow(row, contact),
        ...((contact === undefined || isContactDeleted(contact)) && { deleted: true as const }),
        ...(contact !== undefined && isCaseworker(contact) && { caseworker: true as const }),
      };
    });
    const block = propertyContactBlockOf(unit, read.byId);
    return { contacts: rows, ...(block !== undefined && { propertyContact: block }) };
  }
```

3d. The GET handler. Replace the line

```ts
    res.json({ unit: { ...unit, contacts: await enrichRoster(unit), mediaDisplay } });
```

with

```ts
    // primary-contact-integrity spec 7.5: rows flagged and the propertyContact
    // block ONLY on a complete roster read; else today's rows and no block.
    res.json({ unit: { ...unit, ...(await enrichRosterView(unit)), mediaDisplay } });
```

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPropertyContact.test.ts test/unitsApiRoster.test.ts test/contactsBatchReads.test.ts test/unitsApi.test.ts test/unitsRestoreLandlord.test.ts`

Expected: `Test Files  5 passed (5)`, no failures
(`unitsApiPropertyContact.test.ts` `13 passed (13)`; `contactsBatchReads.test.ts`
still sees exactly ONE `getManyByIds` on the GET).

`cd W:/tmp/primary-contact-integrity/app && npx tsc -p tsconfig.test.json --noEmit`

Expected: exit 0, no output.

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: modified `app/src/routes/units.ts` and
`app/test/unitsApiRoster.test.ts`; untracked
`app/test/unitsApiPropertyContact.test.ts`. Anything else: STOP.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/unitsApiRoster.test.ts app/test/unitsApiPropertyContact.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(units): roster row flags and the propertyContact block on GET /api/units/:id (primary-contact-integrity S3.5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.6 - the contact-list add and remove responses carry the block

Files:
- NEW `app/test/unitsApiPropertyContactWrites.test.ts`
- `app/src/routes/units.ts` (ONLY the two contact-list `res.json` lines; S2
  owns those routes - CI-4)

Steps:

(1) Write the failing test. Create
`app/test/unitsApiPropertyContactWrites.test.ts`:

```ts
// primary-contact-integrity spec 7.5 (plan S3.6): the two contact-list writes
// (POST /api/units/:id/contacts and DELETE /api/units/:id/contacts/:contactId)
// answer with the same row flags and propertyContact block as GET, decided
// from the WRITTEN roster - and with today's rows and NO block when the
// complete read fails, in either shape.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

/** A unit whose landlord of record is `c-ll` unless overridden. */
function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  } as UnitItem);
}

/** The importer's shape: NO landlordId attribute at all. */
function seedUnitWithoutLandlord(
  world: FakeWorld,
  unitId: string,
  contacts: NonNullable<UnitItem['contacts']>,
): void {
  seedUnit(world, unitId, { contacts });
  delete (world.units.get(unitId) as Partial<UnitItem>).landlordId;
}

function seedContact(world: FakeWorld, contactId: string, overrides: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...overrides } as ContactItem);
}

const post = (app: Express, unitId: string) =>
  request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);

const del = (app: Express, unitId: string, contactId: string) =>
  request(app)
    .delete(`/api/units/${unitId}/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);

/** Make ONLY the complete (requireComplete) batch read throw; the best-effort read still answers. */
function failCompleteRead(world: FakeWorld, error: Error): void {
  const real = world.contactsRepo.getManyByIds.bind(world.contactsRepo);
  vi.spyOn(world.contactsRepo, 'getManyByIds').mockImplementation(async (ids, opts) => {
    if (opts?.requireComplete === true) throw error;
    return real(ids, opts);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contact-list writes carry the propertyContact block (spec 7.5)', () => {
  it('POST add: the block is decided from the written roster', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-add');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });

    const res = await post(app, 'u-add').send({ contactId: 'c-pat', role: 'pm' });

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
      { contactId: 'c-pat', role: 'pm', primaryContact: false, name: 'Pat Manager' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-pat', name: 'Pat Manager' },
    });
  });

  it('DELETE of a NON-primary row: the block is decided from the written roster', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-rm', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-pat', role: 'pm', primaryContact: false },
        { contactId: 'c-pam', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await del(app, 'u-rm', 'c-pat');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-pam', name: 'Pam Two' },
    });
  });

  it('DELETE of the PRIMARY with a live heir: the block names the heir as the property contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-handoff', [
      { contactId: 'c-pat', role: 'pm', primaryContact: true },
      { contactId: 'c-pam', role: 'pm', primaryContact: false },
    ]);
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await del(app, 'u-handoff', 'c-pat');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-pam', role: 'pm', primaryContact: true, name: 'Pam Two' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({ contactId: 'c-pam', heirIfPrimaryRemoved: null });
  });

  const shapes: [string, () => Error][] = [
    ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
    ['IncompleteBatchReadError', () => new IncompleteBatchReadError(1, 2)],
  ];
  for (const [shape, makeError] of shapes) {
    it(`${shape}: POST add answers 200 with today's rows and no block`, async () => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-add-inc');
      seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
      seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
      failCompleteRead(world, makeError());

      const res = await post(app, 'u-add-inc').send({ contactId: 'c-pat', role: 'pm' });

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
        { contactId: 'c-pat', role: 'pm', primaryContact: false, name: 'Pat Manager' },
      ]);
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });

    it(`${shape}: DELETE of a non-primary row answers 200 with no block`, async () => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-rm-inc', {
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: true },
          { contactId: 'c-pat', role: 'pm', primaryContact: false },
        ],
      });
      seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
      seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
      failCompleteRead(world, makeError());

      const res = await del(app, 'u-rm-inc', 'c-pat');

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
      ]);
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });
  }
});
```

(2) Run RED:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPropertyContactWrites.test.ts`

Expected RED: exit non-zero, `Tests  3 failed | 4 passed (7)`. The three
complete-read tests fail with
`AssertionError: expected undefined to deeply equal { contactId: ..., heirIfPrimaryRemoved: ... }`;
the four failure-shape pins already pass. If a failure is instead a non-200
status, S2's route behavior differs from CI-4: STOP and report.

(3) Implement. First confirm the anchor is intact (CI-4):

`cd W:/tmp/primary-contact-integrity && grep -c "res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });" app/src/routes/units.ts`

Expected: `2`. Any other count: STOP and report (S2 changed the response
lines; the planner re-anchors).

Then, with the Edit tool and `replace_all: true`, replace

```ts
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
```

with

```ts
    res.json({ unit: { ...updated, ...(await enrichRosterView(updated)) } });
```

Then confirm:

`cd W:/tmp/primary-contact-integrity && grep -c "...(await enrichRosterView(updated))" app/src/routes/units.ts`

Expected: `2`.

(4) Run GREEN:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/unitsApiPropertyContactWrites.test.ts test/unitsApiPropertyContact.test.ts test/unitsApiRoster.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsApiActivity.test.ts`

Expected: `Test Files  6 passed (6)`, no failures
(`unitsApiPropertyContactWrites.test.ts` `7 passed (7)`).

(5) Commit:

`cd W:/tmp/primary-contact-integrity && git status`

Expected: modified `app/src/routes/units.ts`; untracked
`app/test/unitsApiPropertyContactWrites.test.ts`. Anything else: STOP.

`cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`

Expected: `no-merge-in-progress`.

`cd W:/tmp/primary-contact-integrity && git add app/src/routes/units.ts app/test/unitsApiPropertyContactWrites.test.ts`

`cd W:/tmp/primary-contact-integrity && git commit -m "feat(units): propertyContact block on the contact-list add and remove responses (primary-contact-integrity S3.6)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S3.7 - slice gate

Files: none (verification only; a fix found here is its own commit with the
same `git status` / explicit-path discipline).

Steps:

(1) Type check, from the worktree root (all workspaces):

`cd W:/tmp/primary-contact-integrity && npm run typecheck`

Expected: exit 0.

(2) Every app test file this slice touched or whose responses it changed.
DynamoDB Local must be reachable (vitest globalSetup probe; `npm run db:start`
from the worktree root if needed) - none of these files writes to it:

`cd W:/tmp/primary-contact-integrity/app && npx vitest run test/relayIntroFallback.test.ts test/relayIntroFallbackJob.test.ts test/rosterPreviewIntroFallback.test.ts test/relayFanOut.test.ts test/rosterEdits.test.ts test/relayGroupPreview.test.ts test/relayProvisioning.test.ts test/devRelayReplay.test.ts test/relayQueuedMessages.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/unitsApiActivity.test.ts test/unitsApiPropertyContact.test.ts test/unitsApiPropertyContactWrites.test.ts test/unitsApiRoster.test.ts test/unitsApiRosterAutoPrimary.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsRestoreLandlord.test.ts test/unitsApi.test.ts test/contactsBatchReads.test.ts`

Expected: `Test Files  20 passed (20)`, `0 failed`.

(2b) The WHOLE app workspace (plan review R1 P5 - the subset above is the fast
look; this is the slice gate section 0 promises). DynamoDB Local must be
running. Check for exported AWS keys first (AGENTS.md: an exported
`AWS_ACCESS_KEY_ID` collapses every test file onto one database):

`env | grep '^AWS_' || echo no-aws-env`

then, bare (never piped), with any such keys unset:

`cd W:/tmp/primary-contact-integrity && env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test -w @housingchoice/app`

Expected: exit 0, `Test Files  N passed (N)` with 0 failed. A red DynamoDB
Local suite: re-run that FILE alone twice and compare with the same file at
the merge base before calling it ours (AGENTS.md re-run-and-compare); any
`[dynamoAdmin]` line is a real container fault - record it.

(3) Lint the files this slice touched (a cheap early look at gate 5; the
full gate runs in S5):

`cd W:/tmp/primary-contact-integrity && npx eslint app/src/jobs/relayFanOut.ts app/src/services/rosterEdits.ts app/src/routes/units.ts app/test/relayIntroFallback.test.ts app/test/relayIntroFallbackJob.test.ts app/test/rosterPreviewIntroFallback.test.ts app/test/rosterEdits.test.ts app/test/toursApi.test.ts app/test/placementsApi.test.ts app/test/unitsApiActivity.test.ts app/test/unitsApiPropertyContact.test.ts app/test/unitsApiPropertyContactWrites.test.ts app/test/unitsApiRoster.test.ts`

Expected: exit 0. Any error: compare with the same command at the merge base
(`git merge-base main HEAD`); an error present now and absent there is this
slice's and blocks.

(4) ASCII check of every line this slice added:

`cd W:/tmp/primary-contact-integrity && git diff main...HEAD -- app/src/jobs/relayFanOut.ts app/src/services/rosterEdits.ts app/src/routes/units.ts app/test | grep -nP '^\+.*[^\x00-\x7F]' || echo ascii-clean`

Expected: `ascii-clean` for the S3 commits (if S1/S2 lines show up, check
they are not S3's; S3 adds none).

---

## S4 - dashboard (plan slice)

### CONTRACT ISSUES (RULED - section 3.2 and plan-assembly-rulings.md govern; do not act on any "ruling needed" text here)

1. **S5 must update two e2e artifacts this slice's copy change breaks (S4 does
   not own `e2e/`).** Spec 7.3 replaces the remove-the-primary notice. The
   existing e2e assertion `e2e/tests/dashboard-next/property-roster.spec.ts:251`
   (step 4, "Remove the PM: the confirm NAMES the promotion") expects the OLD
   sentence `${owner.name} becomes the primary contact - calls and new relay
   groups for this property will go to them.` and `e2e/support/selectors.md:87`
   documents both old sentences. After S4 (with S3's block on the GET) that
   confirm reads `${owner.name} becomes the primary contact - new tours and
   relay groups for this property will use them.` and the no-heir sentence is
   `This property will have no primary contact. New tours won't include a
   landlord, and tour group texts will use the general intro.` The planner
   should give S5 a task to change both, or the S5 e2e gate fails on step 4.
   Selectors S5 can use for its new specs are listed at the end of this draft.

No other contract changes are requested. S4 consumes 2.3 (codes), 2.4
(`reason`), 2.5 (`introFallback`) and 2.6 (row flags + `propertyContact`)
exactly as written, and relies on 2.6's statement that the block is served on
GET and the two contact-list writes ONLY (not on restore responses) - which is
why Task S4.10 re-reads after a restore.

### Decisions this draft makes (planner to confirm)

- **P-1 Dialog heading needs an owner kind.** `IntroFallback` (2.5) carries no
  owner, so `RosterConfirmDialog` gains a dashboard-only prop
  `introOwner?: 'tour' | 'placement'` (TourDetail passes `'tour'`,
  PlacementDetail `'placement'`). The box renders only when BOTH
  `preview.introFallback` and `introOwner` are present (the server sets the
  field only on those two previews; without an owner there is no heading to
  give). Pinned by a dialog test.
- **P-2 Check again failure copy (not in the spec).** The error line shows the
  server's own `message` when the body carries one, else
  `Couldn't check again - please try again.` (the shared refusal fallback
  talks about "saving", which Check again does not do).
- **P-3 Activity line copy (spec 8 gives none).** Label
  `Primary contact set automatically`; sub `<who> - <why>` with why:
  auto_on_add `the property had no primary contact`; handoff_on_remove `the
  previous primary contact was removed`; handoff_on_delete `the previous
  primary contact was deleted`; handoff_on_restore `the property's landlord
  changed when it was restored`; backfill `set by a one-time data repair`;
  unknown reason humanizes; links to the contact. `from` (a raw contact id) is
  not rendered.
- **P-4 The property box is `role="status"`** (same as the dialog box) so e2e
  can locate it, and it has its own error slot (busy/error key
  `no-primary-box`) because the one-click Make primary also runs outside edit
  mode, where row error slots do not render.
- **P-5** The box stays visible in edit mode; "Choose a primary" turns edit
  mode ON (not a toggle). A deleted flagged primary row reads
  `Gina Gone (deleted) (primary)` - "(deleted)" right after the name, as the
  spec says, then the existing primary marker.
- **P-6** A 503 `roster_read_failed` does NOT re-read the property (nothing was
  written; not a race). A 409 `primary_contact_deleted` DOES (the existing
  409 settle), so the row visibly turns "(deleted)".
- **P-7** The post-restore re-read is best-effort: on failure the card keeps
  the restore's own answer (landlord dialog) or what it had (plain restore).
- **P-8** The dialog sorts reasons into spec 5.1's order client-side (the
  server already sends them in it), and ignores an unknown reason.

### Preconditions

- S1, S2 and S3 are committed on `feat/primary-contact-integrity`. S4's
  dashboard code imports nothing from `app/`; it consumes the wire shapes of
  plan sections 2.3-2.6.
- Every command below uses an explicit path. Dashboard unit tests need no
  Docker. Do NOT run `npm run e2e` in this slice (S5 owns it).
- Edit with the Edit tool only. Every `old_string` below is ASCII and unique
  in its file at the point its task runs (tasks run in order).

---

#### Task S4.1 - Wire types; People-card suggestions skip deleted rows

Files:
- Modify: `dashboard/src/api/types.ts`
- Modify: `dashboard/src/routes/shared/rosterPeople.ts`
- Test: `dashboard/src/routes/shared/rosterPeople.test.ts`

Steps:

1. Failing test. In `dashboard/src/routes/shared/rosterPeople.test.ts`, Edit:

   old_string:
   ```ts
        tenant: { contactId: 'c-t', name: 'Tasha Nguyen' },
      }),
    ).toEqual([]);
  });
});
   ```
   new_string:
   ```ts
        tenant: { contactId: 'c-t', name: 'Tasha Nguyen' },
      }),
    ).toEqual([]);
  });

  // primary-contact-integrity spec 7.5: a row the server marks `deleted` is
  // never offered for "+ Add" and never labeled "primary contact" - even when
  // it is still the property's flagged primary row.
  it('never suggests a row whose contact is deleted, primary or not', () => {
    const DELETED_PRIMARY: UnitContact = { ...PM, deleted: true };
    const DELETED_OTHER: UnitContact = {
      contactId: 'c-gone',
      role: 'other',
      primaryContact: false,
      name: 'Gina Gone',
      deleted: true,
    };
    expect(
      rosterSuggestions({
        scope: 'tour',
        roster: view(),
        unitContacts: [DELETED_PRIMARY, OWNER, DELETED_OTHER],
      }),
    ).toEqual([
      { contactId: 'c-own', name: 'Marcus Webb', lead: 'Also on this property', roleLabel: 'owner' },
    ]);
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/rosterPeople.test.ts`
   Expected: `FAIL  src/routes/shared/rosterPeople.test.ts > rosterSuggestions > never suggests a row whose contact is deleted, primary or not` with `AssertionError: expected [ { contactId: 'c-pm', ...(4) }, ...(2) ] to deeply equal [ { contactId: 'c-own', ...(3) } ]`; summary `Tests  1 failed | 4 passed (5)`.
   Also: `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit`
   Expected: `src/routes/shared/rosterPeople.test.ts(...): error TS2353: Object literal may only specify known properties, and 'deleted' does not exist in type 'UnitContact'.`

3. Implementation.

   3a. `dashboard/src/api/types.ts`, Edit (RosterPreview gains `introFallback`; the two new types follow it):

   old_string:
   ```ts
  /** A live group with exactly these members already exists. Absent when none
   *  does AND when the server could not tell - both mean "say nothing". */
  duplicateOf?: DuplicateOpenGroup;
}
   ```
   new_string:
   ```ts
  /** A live group with exactly these members already exists. Absent when none
   *  does AND when the server could not tell - both mean "say nothing". */
  duplicateOf?: DuplicateOpenGroup;
  /** Why this OWNED group's open preview uses the GENERAL intro instead of the
   *  tour or placement intro (primary-contact-integrity spec 5.1). Set only by
   *  the tour and placement OPEN previews, and only when the general intro is
   *  used; never by the standalone or add-member previews. */
  introFallback?: IntroFallback;
}

/**
 * One reason an owned group's intro fell back to the general intro. MIRRORS
 * app/src/jobs/relayFanOut.ts `IntroFallbackReason` (primary-contact-integrity
 * spec 5.1); the union order IS the order the dialog lists them in.
 */
export type IntroFallbackReason =
  | 'no_property_contact'
  | 'property_contact_deleted'
  | 'property_contact_is_tenant'
  | 'property_contact_no_first_name'
  | 'no_street_address'
  | 'tour_not_scheduled'
  | 'tour_started'
  | 'lookup_failed';

/** MIRRORS app/src/jobs/relayFanOut.ts `IntroFallback` (spec 5.1). */
export interface IntroFallback {
  /** Every reason that applies, in the order above. */
  reasons: IntroFallbackReason[];
  /** The property, when known - the "Set a primary contact" and "Add the
   *  address" links open it. */
  unitId?: string;
  /** formatStreet(unit.address), when non-empty. */
  street?: string;
  /** Set with property_contact_no_first_name - the "Add a first name" link
   *  opens this contact. */
  propertyContactId?: string;
}
   ```

   3b. `dashboard/src/api/types.ts`, Edit (UnitContact row flags + the block type):

   old_string:
   ```ts
  name?: string;
  company?: string; // denormalized for the roster row
}
   ```
   new_string:
   ```ts
  name?: string;
  company?: string; // denormalized for the roster row
  /** RESPONSE ONLY (primary-contact-integrity spec 7.5): the row's contact is
   *  soft-deleted or missing. Present only when the server's contact read was
   *  complete; never stored. */
  deleted?: true;
  /** RESPONSE ONLY (spec 7.5): the row's contact is a caseworker. Present only
   *  when the server's contact read was complete; never stored. */
  caseworker?: true;
}

/**
 * The property-contact block on a unit response (primary-contact-integrity
 * spec 7.5): GET /api/units/:id and the two contact-list writes. ABSENT when
 * the server's contact read was incomplete - the page then shows no box, no
 * "(deleted)" marks and the generic remove notice.
 */
export interface UnitPropertyContact {
  /** Who the app uses for this property (the shared lookup, no tenant), or
   *  null for nobody. */
  contactId: string | null;
  /** Why nobody, when `contactId` is null. */
  reason?: 'none' | 'deleted';
  /** Who takes over if the primary row is removed (the heir function with the
   *  primary excluded), or null for nobody. `name` is present even for an
   *  off-roster landlord of record. */
  heirIfPrimaryRemoved: { contactId: string; name?: string } | null;
}
   ```

   3c. `dashboard/src/api/types.ts`, Edit (UnitItem gains the block):

   old_string:
   ```ts
  application_process?: string;
  primary_contact?: string;
   ```
   new_string:
   ```ts
  application_process?: string;
  primary_contact?: string;
  /** The property-contact block (primary-contact-integrity spec 7.5) - see
   *  UnitPropertyContact. Absent on the units LIST, on status / PATCH / photo /
   *  restore responses, and whenever the server could not tell. */
  propertyContact?: UnitPropertyContact;
   ```

   3d. `dashboard/src/api/types.ts`, Edit (UnitActivityEvent gains `reason`):

   old_string:
   ```ts
  tenantCount?: number;
  tourId?: string;
  outcome?: string;
}
   ```
   new_string:
   ```ts
  tenantCount?: number;
  tourId?: string;
  outcome?: string;
  /** unit_primary_contact_assigned only: why the primary contact was set
   *  automatically (primary-contact-integrity spec 8) - auto_on_add,
   *  handoff_on_remove, handoff_on_delete, handoff_on_restore or backfill. An
   *  open set: an unknown value humanizes. */
  reason?: string;
}
   ```

   3e. `dashboard/src/api/types.ts`, Edit (the event-type list in the doc):

   old_string:
   ```ts
 *  tour_reopened.
 *  Unknown types must still render (humanized), never blank. */
   ```
   new_string:
   ```ts
 *  tour_reopened, unit_primary_contact_assigned.
 *  Unknown types must still render (humanized), never blank. */
   ```

   3f. `dashboard/src/routes/shared/rosterPeople.ts`, Edit (stale comment, spec 9.2):

   old_string:
   ```ts
  /** The property's primary contact - worth saying, it is who calls route to. */
   ```
   new_string:
   ```ts
  /** The property's primary contact - worth saying, it is who new tours put
   *  on the people list and the tour intro names. */
   ```

   3g. `dashboard/src/routes/shared/rosterPeople.ts`, Edit:

   old_string:
   ```ts
    if (onRoster.has(c.contactId)) continue;
   ```
   new_string:
   ```ts
    // primary-contact-integrity spec 7.5: a deleted contact is never offered
    // for "+ Add" nor labeled "primary contact" (the server marks the row).
    if (c.deleted === true) continue;
    if (onRoster.has(c.contactId)) continue;
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/rosterPeople.test.ts`
   Expected: `Tests  5 passed (5)`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit`
   Expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: exactly the three files above.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/api/types.ts dashboard/src/routes/shared/rosterPeople.ts dashboard/src/routes/shared/rosterPeople.test.ts && git commit -m "feat(dashboard): primary-contact wire types; People card suggestions skip deleted property contacts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.2 - Open-group dialog: the intro fallback box and Check again

Files:
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- Test: `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`

Steps:

1. Failing tests.

   1a. `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`, Edit:

   old_string:
   ```ts
import { ApiError, type RosterPreview } from '../../api/index.js';
   ```
   new_string:
   ```ts
import { ApiError, type IntroFallback, type IntroFallbackReason, type RosterPreview } from '../../api/index.js';
   ```

   1b. Same file, Edit (append a describe at the end):

   old_string:
   ```ts
    // force=true AND the edit - the escape hatch must not drop the typing.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(true, 'Edited during quiet hours');
  });
});
   ```
   new_string:
   ```ts
    // force=true AND the edit - the escape hatch must not drop the typing.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(true, 'Edited during quiet hours');
  });
});

// --- primary-contact-integrity spec 7.1: the intro fallback box --------------
// When an OWNED group (a tour or a placement) opens with the GENERAL intro,
// the dialog says why ABOVE the message - every reason, in reason order - links
// to each fix in a NEW TAB, and offers Check again, which re-fetches the
// preview through the caller.
describe('RosterConfirmDialog - the intro fallback box (primary-contact-integrity spec 7.1)', () => {
  const GENERAL_INTRO = "Hey, it's Sam. You're now connected with Mark and Keisha on this number.";
  const withFallback = (fallback: IntroFallback): RosterPreview =>
    preview({ body: GENERAL_INTRO, introFallback: fallback });

  it('renders ABOVE the message with the tour heading and one line per reason, in reason order', () => {
    renderDialog({
      introOwner: 'tour',
      editableBody: true,
      preview: withFallback({
        reasons: ['no_property_contact', 'no_street_address', 'tour_started', 'lookup_failed'],
        unitId: 'u-470',
      }),
    });
    const box = screen.getByRole('status');
    expect(within(box).getByText('Using the general intro, not the tour intro.')).toBeInTheDocument();
    const text = box.textContent ?? '';
    const positions = [
      "This property has no primary contact, so the intro can't name the landlord.",
      'This property has no street address.',
      "This tour's start time has passed. The tour intro asks the tenant to say when they're on the way.",
      "Some property details couldn't be loaded.",
    ].map((line) => text.indexOf(line));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // ABOVE the message: read before the operator edits anything.
    const message = screen.getByRole('region', { name: 'Message preview' });
    expect(box.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists the reasons in reason order even when they arrive out of order', () => {
    renderDialog({
      introOwner: 'tour',
      preview: withFallback({ reasons: ['lookup_failed', 'tour_not_scheduled', 'no_street_address'] }),
    });
    const text = screen.getByRole('status').textContent ?? '';
    const positions = [
      'This property has no street address.',
      'This tour has no date and time yet.',
      "Some property details couldn't be loaded.",
    ].map((line) => text.indexOf(line));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('uses the placement heading on a placement', () => {
    renderDialog({ introOwner: 'placement', preview: withFallback({ reasons: ['lookup_failed'] }) });
    expect(
      within(screen.getByRole('status')).getByText('Using the general intro, not the placement intro.'),
    ).toBeInTheDocument();
  });

  type ReasonRow = [IntroFallbackReason, Partial<IntroFallback>, string, string | null, string | null];
  const REASON_ROWS: ReasonRow[] = [
    [
      'no_property_contact',
      { street: '470 Bolton Rd NW' },
      "470 Bolton Rd NW has no primary contact, so the intro can't name the landlord.",
      'Set a primary contact',
      '/listings/u-470',
    ],
    [
      'no_property_contact',
      {},
      "This property has no primary contact, so the intro can't name the landlord.",
      'Set a primary contact',
      '/listings/u-470',
    ],
    [
      'property_contact_deleted',
      { street: '470 Bolton Rd NW' },
      "The contact on file for 470 Bolton Rd NW was deleted, so the intro can't name the landlord.",
      'Set a primary contact',
      '/listings/u-470',
    ],
    [
      'property_contact_deleted',
      {},
      "The contact on file for this property was deleted, so the intro can't name the landlord.",
      'Set a primary contact',
      '/listings/u-470',
    ],
    [
      'property_contact_is_tenant',
      { street: '470 Bolton Rd NW' },
      "The contact on file for 470 Bolton Rd NW is this tenant, so the intro can't name a landlord.",
      'Set a primary contact',
      '/listings/u-470',
    ],
    [
      'property_contact_no_first_name',
      { street: '470 Bolton Rd NW', propertyContactId: 'c-mark' },
      'The contact on file for 470 Bolton Rd NW has no first name saved.',
      'Add a first name',
      '/contacts/c-mark',
    ],
    ['no_street_address', {}, 'This property has no street address.', 'Add the address', '/listings/u-470'],
    ['tour_not_scheduled', {}, 'This tour has no date and time yet.', null, null],
    [
      'tour_started',
      {},
      "This tour's start time has passed. The tour intro asks the tenant to say when they're on the way.",
      null,
      null,
    ],
    ['lookup_failed', {}, "Some property details couldn't be loaded.", null, null],
  ];

  it.each(REASON_ROWS)('%s renders its line and its link (%o)', (reason, extra, line, linkName, href) => {
    renderDialog({
      introOwner: 'tour',
      preview: withFallback({ reasons: [reason], unitId: 'u-470', ...extra }),
    });
    const lineEl = within(screen.getByRole('status')).getByText(line);
    if (linkName === null) {
      expect(within(lineEl).queryByRole('link')).not.toBeInTheDocument();
      return;
    }
    const link = within(lineEl).getByRole('link', { name: linkName });
    expect(link).toHaveAttribute('href', href);
    // A NEW TAB, like the duplicate warning's link: navigating this tab away
    // would discard the half-built group.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('omits a link whose id is absent', () => {
    renderDialog({
      introOwner: 'tour',
      preview: withFallback({
        reasons: ['no_property_contact', 'property_contact_no_first_name'],
        street: '470 Bolton Rd NW',
      }),
    });
    const box = screen.getByRole('status');
    expect(
      within(box).getByText("470 Bolton Rd NW has no primary contact, so the intro can't name the landlord."),
    ).toBeInTheDocument();
    expect(
      within(box).getByText('The contact on file for 470 Bolton Rd NW has no first name saved.'),
    ).toBeInTheDocument();
    expect(within(box).queryByRole('link')).not.toBeInTheDocument();
  });

  it('Check again runs the caller, is disabled while it runs, and comes back', async () => {
    let settle!: () => void;
    const onCheckAgain = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        settle = r;
      }),
    );
    renderDialog({ introOwner: 'tour', onCheckAgain, preview: withFallback({ reasons: ['lookup_failed'] }) });
    const button = within(screen.getByRole('status')).getByRole('button', { name: 'Check again' });
    await userEvent.click(button);
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    settle();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('a failed Check again renders in the error line and the dialog stays open', async () => {
    const onCheckAgain = vi.fn().mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    const { onClose } = renderDialog({
      introOwner: 'tour',
      onCheckAgain,
      preview: withFallback({ reasons: ['lookup_failed'] }),
    });
    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check again - please try again.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("a failed Check again shows the server's own sentence when it sent one", async () => {
    const onCheckAgain = vi.fn().mockRejectedValue(
      new ApiError(503, 'preview_unavailable', 'preview_unavailable', {
        error: 'preview_unavailable',
        message: 'The preview could not be built - try again in a minute.',
      }),
    );
    renderDialog({ introOwner: 'tour', onCheckAgain, preview: withFallback({ reasons: ['lookup_failed'] }) });
    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The preview could not be built - try again in a minute.',
    );
  });

  it('offers no Check again without an onCheckAgain', () => {
    renderDialog({ introOwner: 'tour', preview: withFallback({ reasons: ['lookup_failed'] }) });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('renders no box when the preview carries no introFallback (standalone and add-member previews)', () => {
    renderDialog({ introOwner: 'tour' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Using the general intro/)).not.toBeInTheDocument();
  });

  it('renders no box when the caller names no owner (there is no heading to give)', () => {
    renderDialog({ preview: withFallback({ reasons: ['lookup_failed'] }) });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sits beside the duplicate warning: two status blocks, the duplicate one unchanged', () => {
    renderDialog({
      introOwner: 'tour',
      preview: preview({
        body: GENERAL_INTRO,
        introFallback: { reasons: ['lookup_failed'] },
        duplicateOf: {
          conversationId: 'conv-existing',
          partition: 'open',
          memberNames: ['Dana Reed', 'Marcus Bell'],
        },
      }),
    });
    const blocks = screen.getAllByRole('status');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveTextContent('Using the general intro, not the tour intro.');
    expect(blocks[1]).toHaveTextContent(/already have an open relay group/);
    expect(within(blocks[1]!).getByRole('link', { name: 'View the existing group' })).toHaveAttribute(
      'href',
      '/conversations/conv-existing',
    );
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx`
   Expected: the new tests fail with `TestingLibraryElementError: Unable to find an accessible element with the role "status"` (or, for the duplicate case, `expected [ <div> ] to have a length of 2 but got 1`); the two "renders no box ..." tests pass already (pins); summary `Tests  19 failed | 35 passed (54)`.

3. Implementation in `dashboard/src/routes/shared/RosterConfirmDialog.tsx`.

   3a. Edit:

   old_string:
   ```ts
import type { RosterPreview, RosterPreviewRecipient } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { quietClockLabel, refusalMessage, RELAY_INTRO_MAX_CHARS } from './rosterWrites.js';
   ```
   new_string:
   ```ts
import type {
  IntroFallback,
  IntroFallbackReason,
  RosterPreview,
  RosterPreviewRecipient,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import {
  GENERIC_WRITE_FAILURE,
  quietClockLabel,
  refusalMessage,
  RELAY_INTRO_MAX_CHARS,
} from './rosterWrites.js';
   ```

   3b. Edit (two new props at the end of `RosterConfirmDialogProps`):

   old_string:
   ```ts
   * relay-intro-editable-but-never-overridden was filed for. Turn this on only
   * together with an endpoint that honors it.
   */
  editableBody?: boolean;
}
   ```
   new_string:
   ```ts
   * relay-intro-editable-but-never-overridden was filed for. Turn this on only
   * together with an endpoint that honors it.
   */
  editableBody?: boolean;
  /**
   * Whose intro the general intro replaced - the fallback box's heading
   * (primary-contact-integrity spec 7.1). The tour and placement OPEN
   * surfaces pass it; the server sets `preview.introFallback` only on those
   * previews. The box renders only with BOTH: without an owner there is no
   * heading to give, and the general intro is the ownerless path's only one.
   */
  introOwner?: 'tour' | 'placement';
  /**
   * "Check again" in the fallback box (spec 7.1): the caller re-runs its
   * preview fetch and replaces the `preview` it passes in (a 409
   * relay_already_provisioned is the caller's to handle - it closes the
   * dialog). Rejects -> the message renders in the dialog's error line and the
   * dialog stays open. Absent -> no button.
   */
  onCheckAgain?: () => Promise<void>;
}
   ```

   3c. Edit (helpers after `formatNames`):

   old_string:
   ```ts
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}
   ```
   new_string:
   ```ts
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/** The fallback box's heading, by whose intro the general intro replaced
 *  (primary-contact-integrity spec 7.1), word for word. */
const INTRO_FALLBACK_HEADING: Readonly<Record<'tour' | 'placement', string>> = {
  tour: 'Using the general intro, not the tour intro.',
  placement: 'Using the general intro, not the placement intro.',
};

/** Spec 5.1's reason order - the order the box lists them in. The server
 *  already sends them in it; sorting here keeps the box right regardless. */
const INTRO_FALLBACK_ORDER: readonly IntroFallbackReason[] = [
  'no_property_contact',
  'property_contact_deleted',
  'property_contact_is_tenant',
  'property_contact_no_first_name',
  'no_street_address',
  'tour_not_scheduled',
  'tour_started',
  'lookup_failed',
];

/** One line of the fallback box: the sentence, and the fix's link when the id
 *  it needs is known. */
interface IntroFallbackLine {
  reason: IntroFallbackReason;
  text: string;
  link?: { href: string; label: string };
}

/** The box's lines (spec 7.1 table), word for word. `<Street>` is the
 *  server's street, else "this property" ("This property" when it starts the
 *  sentence). A link is omitted when its id is absent; an unknown reason (a
 *  newer server) gets no line. */
function introFallbackLines(fallback: IntroFallback): IntroFallbackLine[] {
  const street = fallback.street !== undefined && fallback.street.length > 0 ? fallback.street : undefined;
  const inStreet = street ?? 'this property';
  const leadStreet = street ?? 'This property';
  const listingHref =
    fallback.unitId !== undefined && fallback.unitId.length > 0
      ? `/listings/${encodeURIComponent(fallback.unitId)}`
      : undefined;
  const contactHref =
    fallback.propertyContactId !== undefined && fallback.propertyContactId.length > 0
      ? `/contacts/${encodeURIComponent(fallback.propertyContactId)}`
      : undefined;
  const linkTo = (href: string | undefined, label: string): IntroFallbackLine['link'] =>
    href !== undefined ? { href, label } : undefined;
  const present = new Set<IntroFallbackReason>(fallback.reasons);
  const lines: IntroFallbackLine[] = [];
  for (const reason of INTRO_FALLBACK_ORDER) {
    if (!present.has(reason)) continue;
    switch (reason) {
      case 'no_property_contact':
        lines.push({
          reason,
          text: `${leadStreet} has no primary contact, so the intro can't name the landlord.`,
          link: linkTo(listingHref, 'Set a primary contact'),
        });
        break;
      case 'property_contact_deleted':
        lines.push({
          reason,
          text: `The contact on file for ${inStreet} was deleted, so the intro can't name the landlord.`,
          link: linkTo(listingHref, 'Set a primary contact'),
        });
        break;
      case 'property_contact_is_tenant':
        lines.push({
          reason,
          text: `The contact on file for ${inStreet} is this tenant, so the intro can't name a landlord.`,
          link: linkTo(listingHref, 'Set a primary contact'),
        });
        break;
      case 'property_contact_no_first_name':
        lines.push({
          reason,
          text: `The contact on file for ${inStreet} has no first name saved.`,
          link: linkTo(contactHref, 'Add a first name'),
        });
        break;
      case 'no_street_address':
        lines.push({
          reason,
          text: 'This property has no street address.',
          link: linkTo(listingHref, 'Add the address'),
        });
        break;
      case 'tour_not_scheduled':
        lines.push({ reason, text: 'This tour has no date and time yet.' });
        break;
      case 'tour_started':
        lines.push({
          reason,
          text: "This tour's start time has passed. The tour intro asks the tenant to say when they're on the way.",
        });
        break;
      case 'lookup_failed':
        lines.push({ reason, text: "Some property details couldn't be loaded." });
        break;
    }
  }
  return lines;
}

/** The error line after a failed Check again: the server's own sentence when
 *  it sent one, else this - the shared refusal fallback talks about SAVING,
 *  and Check again saves nothing. */
const CHECK_AGAIN_FAILURE = "Couldn't check again - please try again.";

function checkAgainMessage(err: unknown): string {
  const message = refusalMessage(err);
  return message === GENERIC_WRITE_FAILURE ? CHECK_AGAIN_FAILURE : message;
}
   ```

   3d. Edit (props destructure + the `checking` state):

   old_string:
   ```ts
  allowDefer = true,
  editableBody = false,
}: RosterConfirmDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
   ```
   new_string:
   ```ts
  allowDefer = true,
  editableBody = false,
  introOwner,
  onCheckAgain,
}: RosterConfirmDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A "Check again" (spec 7.1) is in flight.
  const [checking, setChecking] = useState(false);
   ```

   3e. Edit (the Check again handler, before the count line):

   old_string:
   ```ts
  const countLine =
    preview.recipientCount === 1
   ```
   new_string:
   ```ts
  // "Check again" (primary-contact-integrity spec 7.1): the CALLER re-fetches
  // the preview and hands the dialog the new one. While it runs the button is
  // disabled; a failure lands in the error line below and the dialog stays
  // open - nothing was sent.
  const checkAgain = (): void => {
    if (onCheckAgain === undefined || checking || busy) return;
    setChecking(true);
    setError(null);
    void onCheckAgain()
      .catch((err: unknown) => setError(checkAgainMessage(err)))
      .finally(() => setChecking(false));
  };
  const introFallback = preview.introFallback;

  const countLine =
    preview.recipientCount === 1
   ```

   3f. Edit (the box, ABOVE the message):

   old_string:
   ```tsx
      <section className={styles.previewBox} aria-label="Message preview">
   ```
   new_string:
   ```tsx
      {/* primary-contact-integrity spec 7.1 (layout A): why this OWNED group
          opens with the GENERAL intro - read first, ABOVE the message, before
          the operator edits anything. The duplicate warning's amber style
          (--c-warning, not danger: nothing is refused). Links open in a NEW
          TAB for the duplicate warning's reason: navigating this tab away
          would discard the half-built group. */}
      {introFallback !== undefined && introOwner !== undefined ? (
        <div className={styles.duplicateWarning} role="status">
          <p>
            <strong>{INTRO_FALLBACK_HEADING[introOwner]}</strong>
          </p>
          {introFallbackLines(introFallback).map((line) => (
            <p key={line.reason}>
              {line.text}
              {line.link !== undefined ? (
                <>
                  {' '}
                  <a href={line.link.href} target="_blank" rel="noreferrer">
                    {line.link.label}
                  </a>
                </>
              ) : null}
            </p>
          ))}
          {onCheckAgain !== undefined ? (
            <p>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={checkAgain}
                disabled={checking || busy}
              >
                Check again
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
      <section className={styles.previewBox} aria-label="Message preview">
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx`
   Expected: `Tests  54 passed (54)`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/shared/RosterConfirmDialog.tsx dashboard/src/routes/shared/RosterConfirmDialog.test.tsx && git commit -m "feat(dashboard): open-group dialog explains the general intro fallback, with Check again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.3 - Open-group dialog: the edited-draft rule

Files:
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.module.css`
- Test: `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`

Steps:

1. Failing tests. `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`, Edit (append after Task S4.2's describe):

   old_string:
   ```ts
    expect(within(blocks[1]!).getByRole('link', { name: 'View the existing group' })).toHaveAttribute(
      'href',
      '/conversations/conv-existing',
    );
  });
});
   ```
   new_string:
   ```ts
    expect(within(blocks[1]!).getByRole('link', { name: 'View the existing group' })).toHaveAttribute(
      'href',
      '/conversations/conv-existing',
    );
  });
});

// --- primary-contact-integrity spec 7.2: the edited-draft rule --------------
// A Check again (or any re-preview behind the open dialog) must never
// overwrite text the operator typed. An unedited draft follows the server; an
// edited one is kept, with a one-click way to take the new intro.
describe('RosterConfirmDialog - the edited-draft rule (primary-contact-integrity spec 7.2)', () => {
  const FIRST = "Hey, it's Sam. You're now connected with Mark and Keisha on this number.";
  const SECOND =
    "Hey Keisha! It's Sam. Putting you in a group text with Mark to tour 470 Bolton Rd NW on Fri Oct 16.";
  const THIRD =
    "Hey Keisha! It's Sam. Putting you in a group text with Mark to tour 470 Bolton Rd NW on Sat Oct 17.";
  const TYPED = 'My own words for Keisha and Mark.';

  /** An editable open dialog on FIRST; `rerenderWith` hands it a new preview
   *  body, as a caller does after Check again. */
  function renderEditable(): {
    rerenderWith: (body: string) => void;
    onConfirm: ReturnType<typeof vi.fn>;
  } {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const props: RosterConfirmDialogProps = {
      title: 'Open the relay group?',
      preview: preview({ body: FIRST }),
      confirmLabel: 'Open relay group',
      deferLabel: 'Open',
      onConfirm,
      onClose: vi.fn(),
      editableBody: true,
    };
    const { rerender } = render(<RosterConfirmDialog {...props} />);
    return {
      rerenderWith: (body) => rerender(<RosterConfirmDialog {...props} preview={preview({ body })} />),
      onConfirm,
    };
  }

  /** Replace the draft with TYPED. */
  async function editDraft(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const box = screen.getByRole('textbox', { name: /Message/ });
    await user.clear(box);
    await user.type(box, TYPED);
  }

  it('an UNEDITED draft takes the new body, with no notice', () => {
    const { rerenderWith } = renderEditable();
    rerenderWith(SECOND);
    expect(screen.getByRole('textbox', { name: /Message/ })).toHaveValue(SECOND);
    expect(screen.queryByText('The intro changed.')).not.toBeInTheDocument();
  });

  it('an EDITED draft is KEPT on a new preview, and the dialog says the intro changed', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderEditable();
    await editDraft(user);
    rerenderWith(SECOND);
    expect(screen.getByRole('textbox', { name: /Message/ })).toHaveValue(TYPED);
    expect(screen.getByText('The intro changed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use the updated intro' })).toBeInTheDocument();
  });

  it('"Use the updated intro" takes the new body and clears the notice; sent untouched, it posts no introBody', async () => {
    const user = userEvent.setup();
    const { rerenderWith, onConfirm } = renderEditable();
    await editDraft(user);
    rerenderWith(SECOND);
    await user.click(screen.getByRole('button', { name: 'Use the updated intro' }));
    expect(screen.getByRole('textbox', { name: /Message/ })).toHaveValue(SECOND);
    expect(screen.queryByText('The intro changed.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open relay group' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(false, undefined);
  });

  it('a KEPT edit is what is sent - it differs from the CURRENT preview body', async () => {
    const user = userEvent.setup();
    const { rerenderWith, onConfirm } = renderEditable();
    await editDraft(user);
    rerenderWith(SECOND);
    await user.click(screen.getByRole('button', { name: 'Open relay group' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(false, TYPED);
  });

  it('after "Use the updated intro" the draft is unedited again: the next preview replaces it', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderEditable();
    await editDraft(user);
    rerenderWith(SECOND);
    await user.click(screen.getByRole('button', { name: 'Use the updated intro' }));
    rerenderWith(THIRD);
    expect(screen.getByRole('textbox', { name: /Message/ })).toHaveValue(THIRD);
    expect(screen.queryByText('The intro changed.')).not.toBeInTheDocument();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx`
   Expected: `FAIL ... > an EDITED draft is KEPT on a new preview, and the dialog says the intro changed` with `expect(element).toHaveValue(My own words for Keisha and Mark.)` receiving SECOND; the "Use the updated intro" cases fail with `Unable to find an accessible element with the role "button" and name "Use the updated intro"`; the KEPT-edit case fails with `expected "spy" to be called with arguments: [ false, 'My own words for Keisha and Mark.' ]`. The UNEDITED case passes already (pin). Summary `Tests  4 failed | 55 passed (59)`.

3. Implementation.

   3a. `dashboard/src/routes/shared/RosterConfirmDialog.tsx`, Edit:

   old_string:
   ```ts
import { useEffect, useState } from 'react';
   ```
   new_string:
   ```ts
import { useState } from 'react';
   ```

   3b. Same file, Edit:

   old_string:
   ```ts
  // Seeded from the server-composed preview. Re-seeded if the preview itself
  // changes (a re-preview behind an open dialog), which would otherwise leave
  // the operator editing text the server no longer proposes.
  const [draft, setDraft] = useState(preview.body);
  useEffect(() => {
    setDraft(preview.body);
  }, [preview.body]);
   ```
   new_string:
   ```ts
  // The edited-draft rule (primary-contact-integrity spec 7.2). The draft is
  // seeded from the server-composed preview, and `seed` remembers that body.
  // On a NEW preview (a Check again, or a re-preview behind an open dialog):
  // an UNEDITED draft (still equal to its seed) takes the new body, seed and
  // all; an EDITED draft is KEPT, and the note under the box offers the new
  // body. Adjusted during render (React's "adjust state when a prop changes"),
  // never in an effect, so no frame pairs the new preview with the old draft.
  // What is sent is unchanged: a draft that differs from the CURRENT preview
  // body posts `introBody` (see `run`).
  const [draft, setDraft] = useState(preview.body);
  const [seed, setSeed] = useState(preview.body);
  const [seenBody, setSeenBody] = useState(preview.body);
  if (seenBody !== preview.body) {
    setSeenBody(preview.body);
    if (draft === seed) {
      setDraft(preview.body);
      setSeed(preview.body);
    }
  }
  const introChanged = editableBody && seed !== preview.body;
  const applyUpdatedIntro = (): void => {
    setDraft(preview.body);
    setSeed(preview.body);
  };
   ```

   3c. Same file, Edit:

   old_string:
   ```tsx
            <p className={styles.charCount} aria-live="polite">
              {draft.length} / {RELAY_INTRO_MAX_CHARS}
            </p>
          </>
   ```
   new_string:
   ```tsx
            <p className={styles.charCount} aria-live="polite">
              {draft.length} / {RELAY_INTRO_MAX_CHARS}
            </p>
            {/* Spec 7.2: the operator's edit was kept over a newer server
                intro. Say so under the box, with the one-click way back. */}
            {introChanged ? (
              <p className={styles.introChanged}>
                The intro changed.{' '}
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={applyUpdatedIntro}
                  disabled={busy}
                >
                  Use the updated intro
                </Button>
              </p>
            ) : null}
          </>
   ```

   3d. `dashboard/src/routes/shared/RosterConfirmDialog.module.css`, Edit:

   old_string:
   ```css
.charCount {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
  text-align: right;
}
   ```
   new_string:
   ```css
.charCount {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
  text-align: right;
}

/* "The intro changed." under the editable box (primary-contact-integrity spec
 * 7.2): the operator's edit was kept over a newer server intro. A note with
 * its one action, not a warning - nothing is wrong. */
.introChanged {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx src/routes/shared/PeopleCard.test.tsx src/routes/contact/CreateRelayGroupModal.test.tsx`
   Expected: all three files pass (`RosterConfirmDialog.test.tsx` 59 passed); the add-member (PeopleCard) and standalone (CreateRelayGroupModal) dialogs are unchanged because they pass no `introOwner` and their previews carry no `introFallback`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the three files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/shared/RosterConfirmDialog.tsx dashboard/src/routes/shared/RosterConfirmDialog.module.css dashboard/src/routes/shared/RosterConfirmDialog.test.tsx && git commit -m "feat(dashboard): open-group dialog keeps an edited intro when the preview changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.4 - TourDetail: heading owner and Check again

Files:
- Modify: `dashboard/src/routes/tours/TourDetail.tsx`
- Test: `dashboard/src/routes/tours/TourDetail.test.tsx`

Steps:

1. Failing tests. `dashboard/src/routes/tours/TourDetail.test.tsx`, Edit (append at the end of the file):

   old_string:
   ```ts
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That contact no longer exists.'));
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
   ```
   new_string:
   ```ts
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That contact no longer exists.'));
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

// --- primary-contact-integrity spec 7.1: the fallback box and Check again ---
describe('TourDetail - the intro fallback box and Check again (primary-contact-integrity spec 7.1)', () => {
  const GENERAL_INTRO = "Hey, it's Sam. You're now connected with Ann and Lon on this number.";
  const TOUR_INTRO = "Hey Ann! It's Sam. Putting you in a group text with Lon to tour 123 Main St on Fri Jul 10.";
  const RECIPIENTS = [
    { name: 'Ann Tenant', reachability: 'reachable' as const },
    { name: 'Lon Landlord', reachability: 'reachable' as const },
  ];
  const FALLBACK_PREVIEW = {
    body: GENERAL_INTRO,
    recipients: RECIPIENTS,
    recipientCount: 2,
    deferred: false,
    introFallback: { reasons: ['no_property_contact' as const], unitId: 'unit-1', street: '123 Main St' },
  };
  const TOUR_PREVIEW = { body: TOUR_INTRO, recipients: RECIPIENTS, recipientCount: 2, deferred: false };

  async function openTheDialog(): Promise<HTMLElement> {
    getTour.mockResolvedValue(makeTour({ status: 'requested', groupThreadId: undefined }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open relay group' }));
    return screen.findByRole('dialog', { name: 'Open the relay group?' });
  }

  it('the open dialog explains the general intro with the TOUR heading and links to the property', async () => {
    previewTourRosterOpen.mockResolvedValue(FALLBACK_PREVIEW);
    const dialog = await openTheDialog();
    const box = within(dialog).getByRole('status');
    expect(within(box).getByText('Using the general intro, not the tour intro.')).toBeInTheDocument();
    expect(
      within(box).getByText("123 Main St has no primary contact, so the intro can't name the landlord."),
    ).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Set a primary contact' })).toHaveAttribute(
      'href',
      '/listings/unit-1',
    );
  });

  it('Check again re-runs the preview and swaps the unedited draft for the tour intro', async () => {
    previewTourRosterOpen.mockResolvedValueOnce(FALLBACK_PREVIEW).mockResolvedValueOnce(TOUR_PREVIEW);
    const dialog = await openTheDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(previewTourRosterOpen).toHaveBeenCalledTimes(2));
    expect(previewTourRosterOpen).toHaveBeenLastCalledWith('tour-abc');
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Message/ })).toHaveValue(TOUR_INTRO),
    );
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(createTourRelay).not.toHaveBeenCalled();
  });

  it('Check again answered 409 relay_already_provisioned closes the dialog and refetches the roster', async () => {
    previewTourRosterOpen
      .mockResolvedValueOnce(FALLBACK_PREVIEW)
      .mockRejectedValueOnce(
        new ApiError(409, 'relay_already_provisioned', 'relay_already_provisioned', {
          error: 'relay_already_provisioned',
        }),
      );
    const dialog = await openTheDialog();
    const rosterReads = getTourRoster.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open the relay group?' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(getTourRoster.mock.calls.length).toBeGreaterThan(rosterReads));
    expect(createTourRelay).not.toHaveBeenCalled();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/tours/TourDetail.test.tsx`
   Expected: the three new tests fail - the first with `Unable to find an accessible element with the role "status"`, the other two with `Unable to find an accessible element with the role "button" and name "Check again"`; every other test passes. Summary shows `3 failed`.

3. Implementation in `dashboard/src/routes/tours/TourDetail.tsx`.

   3a. Edit (the re-fetch, right after `handleOpenGroup`):

   old_string:
   ```ts
  // Provision the masked group thread (members auto-resolved server-side) - the
   ```
   new_string:
   ```ts
  // primary-contact-integrity spec 7.1 "Check again": re-run the open preview
  // behind the open dialog and hand it the new one - after the property is
  // fixed in another tab, the tour intro comes back without reopening the
  // dialog. A 409 relay_already_provisioned means someone opened the group
  // meanwhile: close the dialog and refetch the roster, exactly as the first
  // fetch does. Any other failure rejects, and the dialog shows it in its own
  // error line. The functional update keeps a dialog that closed while this
  // was in flight closed.
  const checkOpenPreviewAgain = async (): Promise<void> => {
    try {
      const next = await previewTourRosterOpen(tourId);
      setOpenPreview((prev) => (prev === null ? null : next));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'relay_already_provisioned') {
        setOpenPreview(null);
        roster.refetch();
        return;
      }
      throw err;
    }
  };

  // Provision the masked group thread (members auto-resolved server-side) - the
   ```

   3b. Edit (the dialog's props):

   old_string:
   ```tsx
          // The intro is editable here: POST /api/tours/:id/relay accepts introBody.
          editableBody
          onConfirm={runOpenGroup}
   ```
   new_string:
   ```tsx
          // The intro is editable here: POST /api/tours/:id/relay accepts introBody.
          editableBody
          // primary-contact-integrity spec 7.1: the fallback box's heading,
          // and its Check again.
          introOwner="tour"
          onCheckAgain={checkOpenPreviewAgain}
          onConfirm={runOpenGroup}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/tours/TourDetail.test.tsx`
   Expected: all tests pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx && git commit -m "feat(dashboard): tour open-group dialog wires the intro heading and Check again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.5 - PlacementDetail: heading owner and Check again

Files:
- Modify: `dashboard/src/routes/placements/PlacementDetail.tsx`
- Test: `dashboard/src/routes/placements/PlacementDetail.test.tsx`

Steps:

1. Failing tests. `dashboard/src/routes/placements/PlacementDetail.test.tsx`, Edit (append at the end of the file):

   old_string:
   ```ts
    await chooseStage(user, 'send_application');
    expect(await screen.findByText(/That move was rejected/)).toBeInTheDocument();
  });
});
   ```
   new_string:
   ```ts
    await chooseStage(user, 'send_application');
    expect(await screen.findByText(/That move was rejected/)).toBeInTheDocument();
  });
});

// --- primary-contact-integrity spec 7.1: the fallback box and Check again ---
describe('PlacementDetail - the intro fallback box and Check again (primary-contact-integrity spec 7.1)', () => {
  const GENERAL_INTRO = "Hey, it's Sam. You're now connected with Tasha and Larry on this number.";
  const PLACEMENT_INTRO = "Hey Tasha! It's Sam. Putting you in a group text with Larry about 12 Oak St.";
  const RECIPIENTS = [
    { name: 'Tasha Nguyen', reachability: 'reachable' as const },
    { name: 'Larry Owens', reachability: 'reachable' as const },
  ];
  const FALLBACK_PREVIEW = {
    body: GENERAL_INTRO,
    recipients: RECIPIENTS,
    recipientCount: 2,
    deferred: false,
    introFallback: { reasons: ['no_property_contact' as const], unitId: 'u1', street: '12 Oak St' },
  };
  const PLACEMENT_PREVIEW = { body: PLACEMENT_INTRO, recipients: RECIPIENTS, recipientCount: 2, deferred: false };

  async function openTheDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    renderAt();
    await waitLoaded();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open relay group' }));
    return screen.findByRole('dialog', { name: 'Open the relay group?' });
  }

  it('the open dialog explains the general intro with the PLACEMENT heading and links to the property', async () => {
    const user = userEvent.setup();
    previewPlacementRosterOpen.mockResolvedValue(FALLBACK_PREVIEW);
    const dialog = await openTheDialog(user);
    const box = within(dialog).getByRole('status');
    expect(within(box).getByText('Using the general intro, not the placement intro.')).toBeInTheDocument();
    expect(
      within(box).getByText("12 Oak St has no primary contact, so the intro can't name the landlord."),
    ).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Set a primary contact' })).toHaveAttribute('href', '/listings/u1');
  });

  it('Check again re-runs the preview and swaps the unedited draft for the placement intro', async () => {
    const user = userEvent.setup();
    previewPlacementRosterOpen.mockResolvedValueOnce(FALLBACK_PREVIEW).mockResolvedValueOnce(PLACEMENT_PREVIEW);
    const dialog = await openTheDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(previewPlacementRosterOpen).toHaveBeenCalledTimes(2));
    expect(previewPlacementRosterOpen).toHaveBeenLastCalledWith('c1');
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /Message/ })).toHaveValue(PLACEMENT_INTRO),
    );
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(provisionPlacementRelay).not.toHaveBeenCalled();
  });

  it('Check again answered 409 relay_already_provisioned closes the dialog and refetches the roster', async () => {
    const user = userEvent.setup();
    previewPlacementRosterOpen
      .mockResolvedValueOnce(FALLBACK_PREVIEW)
      .mockRejectedValueOnce(
        new ApiError(409, 'relay_already_provisioned', 'relay_already_provisioned', {
          error: 'relay_already_provisioned',
        }),
      );
    const dialog = await openTheDialog(user);
    const rosterReads = getPlacementRoster.mock.calls.length;
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open the relay group?' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(getPlacementRoster.mock.calls.length).toBeGreaterThan(rosterReads));
    expect(provisionPlacementRelay).not.toHaveBeenCalled();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/placements/PlacementDetail.test.tsx`
   Expected: the three new tests fail (`role "status"` not found for the first, `button ... "Check again"` not found for the others); summary shows `3 failed`.

3. Implementation in `dashboard/src/routes/placements/PlacementDetail.tsx`.

   3a. Edit (the re-fetch, right after `handleOpenGroup`):

   old_string:
   ```ts
  // The confirmed half. Throws on failure so the dialog shows the reason and
  // stays open; on success the plan is consumed (spec D1), so re-read.
   ```
   new_string:
   ```ts
  // primary-contact-integrity spec 7.1 "Check again": re-run the open preview
  // behind the open dialog and hand it the new one. A 409
  // relay_already_provisioned means someone opened the group meanwhile: close
  // the dialog and refetch the roster, exactly as the first fetch does. Any
  // other failure rejects, and the dialog shows it in its own error line. The
  // functional update keeps a dialog that closed meanwhile closed.
  const checkOpenPreviewAgain = useCallback(async (): Promise<void> => {
    try {
      const next = await previewPlacementRosterOpen(placementId);
      setOpenPreview((prev) => (prev === null ? null : next));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'relay_already_provisioned') {
        setOpenPreview(null);
        roster.refetch();
        return;
      }
      throw err;
    }
  }, [placementId, roster]);

  // The confirmed half. Throws on failure so the dialog shows the reason and
  // stays open; on success the plan is consumed (spec D1), so re-read.
   ```

   3b. Edit (the dialog's props):

   old_string:
   ```tsx
          // The intro is editable here: POST /api/placements/:id/relay accepts introBody.
          editableBody
          onConfirm={runOpenGroup}
   ```
   new_string:
   ```tsx
          // The intro is editable here: POST /api/placements/:id/relay accepts introBody.
          editableBody
          // primary-contact-integrity spec 7.1: the fallback box's heading,
          // and its Check again.
          introOwner="placement"
          onCheckAgain={checkOpenPreviewAgain}
          onConfirm={runOpenGroup}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/placements/PlacementDetail.test.tsx`
   Expected: all tests pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/placements/PlacementDetail.tsx dashboard/src/routes/placements/PlacementDetail.test.tsx && git commit -m "feat(dashboard): placement open-group dialog wires the intro heading and Check again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.6 - Roster rows carry the server flags; useListing keeps the load-time block

Files:
- Modify: `dashboard/src/routes/listing/buildListingFile.ts`
- Modify: `dashboard/src/routes/listing/useListing.ts`
- Test: `dashboard/src/routes/listing/buildListingFile.test.ts`
- Test: `dashboard/src/routes/listing/useListing.test.tsx`

Steps:

1. Failing tests.

   1a. `dashboard/src/routes/listing/buildListingFile.test.ts`, Edit (insert before the fallback case):

   old_string:
   ```ts
  it('falls back to a single landlord row from the resolved contact when contacts[] is absent', () => {
   ```
   new_string:
   ```ts
  it('carries the server row flags deleted and caseworker through (primary-contact-integrity spec 7.5), and nothing when absent', () => {
    const u = unit({
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryContact: true, name: 'Gina Gone', deleted: true },
        { contactId: 'cw1', role: 'other', primaryContact: false, name: 'Casey Worker', caseworker: true },
        { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Mark Passmore' },
      ],
    });
    const rows = listingRoster(u, null);
    expect(rows[0]).toMatchObject({ contactId: 'pm1', deleted: true });
    expect(rows[0]?.caseworker).toBeUndefined();
    expect(rows[1]).toMatchObject({ contactId: 'cw1', caseworker: true });
    expect(rows[1]?.deleted).toBeUndefined();
    expect(rows[2]).not.toHaveProperty('deleted');
    expect(rows[2]).not.toHaveProperty('caseworker');
  });

  it('falls back to a single landlord row from the resolved contact when contacts[] is absent', () => {
   ```

   1b. `dashboard/src/routes/listing/useListing.test.tsx`, Edit (insert inside `describe('useListing', ...)`):

   old_string:
   ```ts
  it('errors when the unit itself fails to load', async () => {
   ```
   new_string:
   ```ts
  it('exposes the load-time propertyContact block (primary-contact-integrity spec 7.5), and setUnit keeps it', async () => {
    const block = { contactId: null, reason: 'none' as const, heirIfPrimaryRemoved: null };
    getUnit.mockResolvedValue({ ...UNIT, propertyContact: block });
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.propertyContact).toEqual(block);
    // A status / edit-form / photo response carries no block - it never
    // clears the load-time one (only a roster source supersedes it, in the page).
    act(() => result.current.setUnit({ ...UNIT, status: 'occupied' }));
    expect(result.current.propertyContact).toEqual(block);
  });

  it('leaves propertyContact absent when the GET carried no block (the server could not tell)', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.propertyContact).toBeUndefined();
  });

  it('errors when the unit itself fails to load', async () => {
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/buildListingFile.test.ts src/routes/listing/useListing.test.tsx`
   Expected: `FAIL ... > carries the server row flags deleted and caseworker through ...` (`expected { contactId: 'pm1', ... } to match object { contactId: 'pm1', deleted: true }`) and `FAIL ... > exposes the load-time propertyContact block ...` (`expected undefined to deeply equal { contactId: null, reason: 'none', heirIfPrimaryRemoved: null }`); the "leaves propertyContact absent" case passes already (pin). Summary across the two files: `2 failed`.

3. Implementation.

   3a. `dashboard/src/routes/listing/buildListingFile.ts`, Edit (RosterRow gains the flags; the stale masked-call comment, spec 9.2):

   old_string:
   ```ts
  /** The primary contact: the property's default contact - relay groups
   *  and masked calls. */
  primaryContact: boolean;
   ```
   new_string:
   ```ts
  /** The primary contact: the property's default contact - who new tours put
   *  on the people list and the tour intro names. */
  primaryContact: boolean;
  /** The row's contact is soft-deleted or missing (primary-contact-integrity
   *  spec 7.5). The server sets it only from a complete contact read. */
  deleted?: true;
  /** The row's contact is a caseworker (spec 7.5). The server sets it only
   *  from a complete contact read. */
  caseworker?: true;
   ```

   3b. Same file, Edit:

   old_string:
   ```ts
        primaryContact: c.primaryContact,
        fallback: false,
      }));
   ```
   new_string:
   ```ts
        primaryContact: c.primaryContact,
        fallback: false,
        ...(c.deleted === true && { deleted: true as const }),
        ...(c.caseworker === true && { caseworker: true as const }),
      }));
   ```

   3c. `dashboard/src/routes/listing/useListing.ts`, Edit:

   old_string:
   ```ts
  type UnitActivityEvent,
  type UnitItem,
} from '../../api/index.js';
   ```
   new_string:
   ```ts
  type UnitActivityEvent,
  type UnitItem,
  type UnitPropertyContact,
} from '../../api/index.js';
   ```

   3d. Same file, Edit:

   old_string:
   ```ts
  /** Tours on this unit (GET /api/tours?unitId=), unbooked first then newest. */
  tours: Slice<Tour>;
}
   ```
   new_string:
   ```ts
  /** Tours on this unit (GET /api/tours?unitId=), unbooked first then newest. */
  tours: Slice<Tour>;
  /** The property-contact block (primary-contact-integrity spec 7.5) from the
   *  load-time GET; ABSENT when the server could not tell. Like `roster` it is
   *  fixed at load: setUnit (a status, edit-form or photo response, which
   *  carry no block) never changes it. The page prefers a roster write's (or
   *  a re-read's) own block over this one. */
  propertyContact?: UnitPropertyContact;
}
   ```

   3e. Same file, Edit:

   old_string:
   ```ts
          roster: listingRoster(unit, landlord),
   ```
   new_string:
   ```ts
          roster: listingRoster(unit, landlord),
          ...(unit.propertyContact !== undefined && { propertyContact: unit.propertyContact }),
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/buildListingFile.test.ts src/routes/listing/useListing.test.tsx`
   Expected: both files pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the four files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/buildListingFile.ts dashboard/src/routes/listing/useListing.ts dashboard/src/routes/listing/buildListingFile.test.ts dashboard/src/routes/listing/useListing.test.tsx && git commit -m "feat(dashboard): property roster rows carry deleted and caseworker flags; useListing keeps the propertyContact block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.7 - Property page: "(deleted)" rows, no Make primary on them, facts subline, empty state

Files:
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx`
- Modify: `dashboard/src/routes/listing/ListingDetail.module.css`
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx`

Steps:

1. Failing tests.

   1a. `dashboard/src/routes/listing/ListingDetail.test.tsx`, Edit (imports):

   old_string:
   ```ts
import { ApiError } from '../../api/index.js';
import type { ListingState } from './useListing.js';
   ```
   new_string:
   ```ts
import { ApiError, type UnitContact, type UnitPropertyContact } from '../../api/index.js';
import { listingRoster } from './buildListingFile.js';
import type { ListingState } from './useListing.js';
   ```

   1b. Same file, Edit (append module-level fixtures and a describe at the end of the file):

   old_string:
   ```ts
    // SETTLED into the truth: Dana is the landlord of record now, so her remove
    // is disabled - the click read as a real outcome, not a dead button.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }),
      ).toBeDisabled(),
    );
  });
});
   ```
   new_string:
   ```ts
    // SETTLED into the truth: Dana is the landlord of record now, so her remove
    // is disabled - the click read as a real outcome, not a dead button.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }),
      ).toBeDisabled(),
    );
  });
});

// --- primary-contact-integrity (spec 7.3 / 7.4 / 7.5) ------------------------
// The server marks each roster row `deleted` / `caseworker` and sends a
// propertyContact block (7.5); the page renders them and never re-derives the
// heir rule. 470 Bolton is the motivating shape: no landlord of record, one
// contact (Mark, a property manager), nobody primary.

/** Mark Passmore, the 470 Bolton property manager - live, not primary. */
const MARK: UnitContact = { contactId: 'pm-mark', role: 'pm', primaryContact: false, name: 'Mark Passmore' };

/** A row whose contact was soft-deleted (the server's `deleted: true`). */
const GINA_DELETED: UnitContact = {
  contactId: 'pm-gone',
  role: 'pm',
  primaryContact: false,
  name: 'Gina Gone',
  deleted: true,
};

/** An OWNERLESS property whose roster is `contacts`, with the hook's rows
 *  derived exactly as useListing derives them (listingRoster) and the
 *  load-time propertyContact block when given. */
function integrityState(
  contacts: UnitContact[],
  propertyContact?: UnitPropertyContact,
  unitOver: Partial<NonNullable<ListingState['unit']>> = {},
): ListingState {
  const { landlordId: _ownerless, ...base } = READY.unit!;
  const unit: NonNullable<ListingState['unit']> = { ...base, contacts, ...unitOver };
  return {
    ...READY,
    unit,
    landlord: null,
    roster: listingRoster(unit, null),
    ...(propertyContact !== undefined && { propertyContact }),
  };
}

/** The Contacts card (its own <section>). */
function contactsCard(): HTMLElement {
  return screen.getByRole('heading', { name: /^Contacts/ }).closest('section') as HTMLElement;
}

describe('ListingDetail - deleted contact rows (primary-contact-integrity spec 7.4)', () => {
  beforeEach(() => {
    addUnitContact.mockReset();
    removeUnitContact.mockReset();
  });

  it('marks a deleted row "(deleted)" in view mode', () => {
    useListing.mockReturnValue(integrityState([{ ...MARK, primaryContact: true }, GINA_DELETED]));
    renderAt();
    const card = contactsCard();
    expect(within(card).getByRole('link', { name: /Gina Gone/ })).toHaveTextContent('Gina Gone (deleted)');
    expect(within(card).getByRole('link', { name: /Mark Passmore/ })).not.toHaveTextContent('(deleted)');
  });

  it('in edit mode a deleted row says "(deleted)" and offers no Make primary - its role select and Remove stay', async () => {
    const user = userEvent.setup();
    const dana: UnitContact = { contactId: 'pm-dana', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    useListing.mockReturnValue(integrityState([{ ...MARK, primaryContact: true }, GINA_DELETED, dana]));
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));

    const remove = screen.getByRole('button', { name: 'Remove Gina Gone from this property' });
    expect(remove.parentElement).toHaveTextContent('Gina Gone (deleted)');
    expect(remove).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Role for Gina Gone' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Make Gina Gone the primary contact' })).not.toBeInTheDocument();
    // A live non-primary row still offers it.
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();
  });

  it('the header facts subline skips a deleted row when naming the company', () => {
    useListing.mockReturnValue(
      integrityState([
        { ...GINA_DELETED, primaryContact: true, company: 'Gone LLC' },
        { ...MARK, company: 'BNS Property Management' },
      ]),
    );
    renderAt();
    expect(
      screen.getByText((t) => t.includes('2 BR') && t.includes('BNS Property Management')),
    ).toBeInTheDocument();
    expect(screen.queryByText((t) => t.includes('2 BR') && t.includes('Gone LLC'))).not.toBeInTheDocument();
  });

  it('the empty state says tours need a primary contact', () => {
    useListing.mockReturnValue(integrityState([]));
    renderAt();
    expect(within(contactsCard()).getByText('No contacts on this property yet. Tours need a primary contact.')).toBeInTheDocument();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: the 4 new tests fail (`expected element to have text content Gina Gone (deleted)`; `Make Gina Gone the primary contact` found; the facts matcher finds no element containing `BNS Property Management`; `Unable to find an element with the text: No contacts on this property yet. Tours need a primary contact.`); every other test passes. Summary shows `4 failed`.

3. Implementation.

   3a. `dashboard/src/routes/listing/ListingDetail.tsx`, Edit (facts subline):

   old_string:
   ```ts
  const landlordName = contactRows.find((r) => r.primaryContact)?.company ?? contactRows[0]?.company;
   ```
   new_string:
   ```ts
  // The facts subline names a LIVE contact's company (primary-contact-integrity
  // spec 7.4): a row whose contact is deleted is skipped, primary or not.
  const liveRows = contactRows.filter((r) => r.deleted !== true);
  const landlordName = liveRows.find((r) => r.primaryContact)?.company ?? liveRows[0]?.company;
   ```

   3b. Same file, Edit (empty state):

   old_string:
   ```tsx
              <EmptyRow>No contacts on this property yet.</EmptyRow>
   ```
   new_string:
   ```tsx
              <EmptyRow>No contacts on this property yet. Tours need a primary contact.</EmptyRow>
   ```

   3c. Same file, Edit (edit-mode name line):

   old_string:
   ```tsx
                      <span className={styles.contactName}>{name}</span>
                      {r.primaryContact ? (
                        <span className={styles.primaryStar}> (primary)</span>
                      ) : null}
   ```
   new_string:
   ```tsx
                      <span className={styles.contactName}>{name}</span>
                      {r.deleted === true ? <span className={styles.deletedMark}> (deleted)</span> : null}
                      {r.primaryContact ? (
                        <span className={styles.primaryStar}> (primary)</span>
                      ) : null}
   ```

   3d. Same file, Edit (no Make primary on a deleted row):

   old_string:
   ```tsx
                      {r.primaryContact ? null : (
   ```
   new_string:
   ```tsx
                      {/* A deleted contact can't be made primary (the server
                          answers 409 primary_contact_deleted, spec 7.4) - no
                          doomed click. Its role select and Remove stay. */}
                      {r.primaryContact || r.deleted === true ? null : (
   ```

   3e. Same file, Edit (view-mode row):

   old_string:
   ```tsx
                      <span className={styles.contactName}>{r.name ?? r.contactId}</span>
                      {r.primaryContact ? <span className={styles.primaryStar}> (primary)</span> : null}
   ```
   new_string:
   ```tsx
                      <span className={styles.contactName}>{r.name ?? r.contactId}</span>
                      {r.deleted === true ? <span className={styles.deletedMark}> (deleted)</span> : null}
                      {r.primaryContact ? <span className={styles.primaryStar}> (primary)</span> : null}
   ```

   3f. `dashboard/src/routes/listing/ListingDetail.module.css`, Edit:

   old_string:
   ```css
.contactRowError {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-danger);
}
   ```
   new_string:
   ```css
.contactRowError {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-danger);
}

/* "(deleted)" after a roster row whose contact is soft-deleted or missing
 * (primary-contact-integrity spec 7.4). Muted: a fact, not an action. */
.deletedMark {
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: all tests pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the three files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.module.css dashboard/src/routes/listing/ListingDetail.test.tsx && git commit -m "feat(dashboard): property page marks deleted contacts and skips them for Make primary and the facts line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.8 - Property page: the no-primary box

Files:
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx`
- Modify: `dashboard/src/routes/listing/ListingDetail.module.css`
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx`

The module-level test helpers `MARK`, `GINA_DELETED`, `integrityState(contacts, propertyContact?, unitOver?)` and `contactsCard()` already exist at the end of `ListingDetail.test.tsx` (Task S4.7).

Steps:

1. Failing tests. `dashboard/src/routes/listing/ListingDetail.test.tsx`, Edit (append after Task S4.7's describe):

   old_string:
   ```ts
    expect(within(contactsCard()).getByText('No contacts on this property yet. Tours need a primary contact.')).toBeInTheDocument();
  });
});
   ```
   new_string:
   ```ts
    expect(within(contactsCard()).getByText('No contacts on this property yet. Tours need a primary contact.')).toBeInTheDocument();
  });
});

describe('ListingDetail - the no-primary box (primary-contact-integrity spec 7.4)', () => {
  /** The server's block for a property with no property contact. */
  const NO_PRIMARY: UnitPropertyContact = { contactId: null, reason: 'none', heirIfPrimaryRemoved: null };
  const DANA: UnitContact = { contactId: 'pm-dana', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
  const CASEY_CASEWORKER: UnitContact = {
    contactId: 'cw-casey',
    role: 'other',
    primaryContact: false,
    name: 'Casey Worker',
    caseworker: true,
  };

  beforeEach(() => {
    addUnitContact.mockReset();
    removeUnitContact.mockReset();
  });

  it('exactly one eligible row: "Make <Name> primary" above the rows - the same write as Make primary', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY));
    const { landlordId: _ownerless, ...base } = READY.unit!;
    addUnitContact.mockResolvedValue({
      ...base,
      primary_contact: 'pm-mark',
      contacts: [{ ...MARK, primaryContact: true }],
      propertyContact: { contactId: 'pm-mark', heirIfPrimaryRemoved: null },
    });
    renderAt();

    const card = contactsCard();
    const box = within(card).getByRole('status');
    expect(within(box).getByText('No primary contact.')).toBeInTheDocument();
    expect(
      within(box).getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeInTheDocument();
    // ABOVE the rows.
    const row = within(card).getByRole('link', { name: /Mark Passmore/ });
    expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(box).getByRole('button', { name: 'Make Mark Passmore primary' }));
    expect(addUnitContact).toHaveBeenCalledWith('u1', { contactId: 'pm-mark', role: 'pm', primaryContact: true });
    // The write's own block names a property contact now: the box goes.
    await waitFor(() => expect(within(card).queryByRole('status')).not.toBeInTheDocument());
    expect(within(card).getByRole('link', { name: /Mark Passmore/ })).toHaveTextContent('Mark Passmore (primary)');
  });

  it('counts only ELIGIBLE rows: a deleted row and a caseworker row do not count', () => {
    useListing.mockReturnValue(integrityState([MARK, GINA_DELETED, CASEY_CASEWORKER], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByRole('button', { name: 'Make Mark Passmore primary' })).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Choose a primary' })).not.toBeInTheDocument();
  });

  it('two or more eligible rows: "Choose a primary" opens the edit mode', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK, DANA], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).queryByRole('button', { name: /^Make .* primary$/ })).not.toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Choose a primary' }));
    expect(screen.getByRole('button', { name: 'Make Mark Passmore the primary contact' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();
    expect(addUnitContact).not.toHaveBeenCalled();
  });

  it('no eligible row: no button, and the line says an added landlord or property manager becomes primary', () => {
    useListing.mockReturnValue(integrityState([GINA_DELETED, CASEY_CASEWORKER], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText('No primary contact.')).toBeInTheDocument();
    expect(
      within(box).getByText('Add the landlord or property manager - they become the primary automatically.'),
    ).toBeInTheDocument();
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });

  it("a deleted property contact leads with \"This property's contact was deleted.\"", () => {
    useListing.mockReturnValue(
      integrityState([{ ...GINA_DELETED, primaryContact: true }, MARK], {
        contactId: null,
        reason: 'deleted',
        heirIfPrimaryRemoved: { contactId: 'pm-mark', name: 'Mark Passmore' },
      }),
    );
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText("This property's contact was deleted.")).toBeInTheDocument();
    expect(within(box).queryByText('No primary contact.')).not.toBeInTheDocument();
    expect(
      within(box).getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Make Mark Passmore primary' })).toBeInTheDocument();
  });

  it('no box when the block is absent (the server could not tell)', () => {
    useListing.mockReturnValue(integrityState([MARK]));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box when the block names a property contact', () => {
    useListing.mockReturnValue(
      integrityState([{ ...MARK, primaryContact: true }], { contactId: 'pm-mark', heirIfPrimaryRemoved: null }),
    );
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box on a soft-deleted property (the card is read-only there)', () => {
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY, { deleted_at: '2026-06-19T00:00:00.000Z' }));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box with zero roster rows - the empty state speaks instead', () => {
    useListing.mockReturnValue(integrityState([], NO_PRIMARY));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/Tours need a primary contact\./)).toBeInTheDocument();
  });

  it('a failed write from the box shows its error inside the box', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY));
    addUnitContact.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    await user.click(within(box).getByRole('button', { name: 'Make Mark Passmore primary' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent("Couldn't save that change - please try again.");
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: 6 new tests fail with `Unable to find an accessible element with the role "status"` (one eligible, counts eligible, two eligible, no eligible, deleted lead, write failure); the four "no box ..." tests pass already (pins). Summary shows `6 failed`.

3. Implementation.

   3a. `dashboard/src/routes/listing/ListingDetail.tsx`, Edit (copy constants):

   old_string:
   ```ts
const LANDLORD_REASSIGNMENT_COPY =
  'This property already has a landlord of record - reassign it before choosing Landlord.';
   ```
   new_string:
   ```ts
const LANDLORD_REASSIGNMENT_COPY =
  'This property already has a landlord of record - reassign it before choosing Landlord.';

/** The no-primary box (primary-contact-integrity spec 7.4), word for word.
 *  The lead names the case; the effect sentence follows it. */
const NO_PRIMARY_LEAD = 'No primary contact.';
const DELETED_CONTACT_LEAD = "This property's contact was deleted.";
const NO_PRIMARY_EFFECT = "New tours won't include the landlord, and tour group texts use the general intro.";
/** No eligible row to offer (no live contact, or only caseworkers). True: an
 *  eligible add on a property with no live primary and no live landlord of
 *  record is made primary by the server (spec 4.4). */
const NO_ELIGIBLE_LINE = 'Add the landlord or property manager - they become the primary automatically.';

/** The busy/error key for the box's one-click Make primary: its error renders
 *  IN the box, which shows outside edit mode too. */
const NO_PRIMARY_BOX_KEY = 'no-primary-box';
   ```

   3b. Same file, Edit (the block comes from the same roster source as the rows):

   old_string:
   ```ts
  const contactRows: RosterRow[] =
    contactsUnit !== null ? listingRoster(contactsUnit, state.landlord) : roster;
   ```
   new_string:
   ```ts
  const contactRows: RosterRow[] =
    contactsUnit !== null ? listingRoster(contactsUnit, state.landlord) : roster;
  // The property-contact block (primary-contact-integrity spec 7.5) comes from
  // the SAME roster source as the rows: a roster write's (or a re-read's) own
  // block, else the load-time GET's. Absent = the server could not tell.
  const propertyContact = contactsUnit !== null ? contactsUnit.propertyContact : state.propertyContact;
   ```

   3c. Same file, Edit (box derivations):

   old_string:
   ```ts
  const addContactCandidates = contactsList.filter(
    (c) => !rosteredIds.has(c.contactId) && !isCaseworkerContact(c),
  );
   ```
   new_string:
   ```ts
  const addContactCandidates = contactsList.filter(
    (c) => !rosteredIds.has(c.contactId) && !isCaseworkerContact(c),
  );
  // The no-primary box (spec 7.4). Shown only when the server TOLD us there
  // is no property contact (block present, contactId null), the property has
  // at least one row, and it is live (the card is read-only on a deleted
  // property). Its action counts ELIGIBLE rows - live and not a caseworker,
  // both from the server's row flags. That is broader than the server's
  // AUTOMATIC rule (typed landlord) on purpose: this is a deliberate click,
  // and the button names the person before it writes.
  const showNoPrimaryBox =
    !deleted && propertyContact !== undefined && propertyContact.contactId === null && contactRows.length > 0;
  const eligibleRows = contactRows.filter((r) => r.deleted !== true && r.caseworker !== true);
  const soleEligible = eligibleRows.length === 1 ? eligibleRows[0] : undefined;
   ```

   3d. Same file, Edit (Make primary takes the busy/error key):

   old_string:
   ```ts
  /** Promote a row to the property's primary contact - the same upsert with
   *  `primaryContact: true`; the server demotes whoever held it. Idempotent. */
  const onMakePrimaryContact = (row: RosterRow): void => {
    runRosterWrite(row.contactId, () =>
   ```
   new_string:
   ```ts
  /** Promote a row to the property's primary contact - the same upsert with
   *  `primaryContact: true`; the server demotes whoever held it. Idempotent.
   *  `key` is where its busy state and error land: the row's own slot in edit
   *  mode, or the no-primary box (spec 7.4), which shows outside edit mode. */
  const onMakePrimaryContact = (row: RosterRow, key: string = row.contactId): void => {
    runRosterWrite(key, () =>
   ```

   3e. Same file, Edit (the box, ABOVE the rows):

   old_string:
   ```tsx
            {contactRows.length === 0 ? (
              <EmptyRow>No contacts on this property yet. Tours need a primary contact.</EmptyRow>
   ```
   new_string:
   ```tsx
            {showNoPrimaryBox ? (
              <div className={styles.noPrimaryBox} role="status">
                <p>
                  <strong>
                    {propertyContact?.reason === 'deleted' ? DELETED_CONTACT_LEAD : NO_PRIMARY_LEAD}
                  </strong>{' '}
                  {NO_PRIMARY_EFFECT}
                </p>
                {soleEligible !== undefined ? (
                  <p>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onMakePrimaryContact(soleEligible, NO_PRIMARY_BOX_KEY)}
                      disabled={rosterBusy !== null}
                    >
                      {`Make ${soleEligible.name ?? soleEligible.contactId} primary`}
                    </Button>
                  </p>
                ) : eligibleRows.length > 1 ? (
                  <p>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setEditingContacts(true);
                        setRosterError(null);
                        closeAddContact();
                      }}
                    >
                      Choose a primary
                    </Button>
                  </p>
                ) : (
                  <p>{NO_ELIGIBLE_LINE}</p>
                )}
                {rosterError !== null && rosterError.key === NO_PRIMARY_BOX_KEY ? (
                  <p role="alert" className={styles.contactRowError}>
                    {rosterError.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {contactRows.length === 0 ? (
              <EmptyRow>No contacts on this property yet. Tours need a primary contact.</EmptyRow>
   ```

   3f. `dashboard/src/routes/listing/ListingDetail.module.css`, Edit:

   old_string:
   ```css
.deletedMark {
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
}
   ```
   new_string:
   ```css
.deletedMark {
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
}

/* The no-primary-contact box on the Contacts card (primary-contact-integrity
 * spec 7.4, layout A). The SAME amber treatment as the open-group dialog's
 * fallback box (shared/RosterConfirmDialog.module.css .duplicateWarning):
 * --c-warning, not danger - nothing is broken until a tour needs it. */
.noPrimaryBox {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-warning);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
}

.noPrimaryBox p {
  margin: 0 0 var(--sp-1);
}

.noPrimaryBox p:last-child {
  margin-bottom: 0;
}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: all tests pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the three files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.module.css dashboard/src/routes/listing/ListingDetail.test.tsx && git commit -m "feat(dashboard): property page no-primary-contact box" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.9 - Remove-the-primary notice from the server block; 409 and 503 copy; stale comments

Files:
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx`
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx`

Steps:

1. Tests. All edits are inside `describe('ListingDetail - Contacts card edit mode', ...)` in `dashboard/src/routes/listing/ListingDetail.test.tsx`. Existing tests that change: "removing the CURRENT primary confirms first and NAMES the promotion" (renamed; now reads the block), "names the NO-primary outcome when there is no landlord of record to promote" (renamed; block with no heir), "an OWNERLESS property ... without crashing" (block with no heir). Their old sentences are replaced by the spec 7.3 sentences below.

   1a. Edit:

   old_string:
   ```ts
  it('removing the CURRENT primary confirms first and NAMES the promotion', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
   ```
   new_string:
   ```ts
  it('removing the CURRENT primary confirms first and NAMES the heir the server reports', async () => {
    const user = userEvent.setup();
    // primary-contact-integrity spec 7.3: the heir comes from the server's
    // propertyContact block, never from a client-side copy of the rule.
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
   ```

   1b. Edit:

   old_string:
   ```ts
        'James Porter becomes the primary contact - calls and new relay groups for this property will go to them.',
   ```
   new_string:
   ```ts
        'James Porter becomes the primary contact - new tours and relay groups for this property will use them.',
   ```

   1c. Edit:

   old_string:
   ```ts
  it('names the NO-primary outcome when there is no landlord of record to promote', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ROSTER_UNIT, landlordId: '', contacts: [ROSTER_UNIT.contacts![0]!] },
      roster: [ROSTER_READY.roster[0]!],
    });
   ```
   new_string:
   ```ts
  it('names the NO-primary outcome when the server reports no heir', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ROSTER_UNIT, landlordId: '', contacts: [ROSTER_UNIT.contacts![0]!] },
      roster: [ROSTER_READY.roster[0]!],
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: null },
    });
   ```

   1d. Edit:

   old_string:
   ```ts
    const { landlordId: _dropped, ...ownerless } = ROSTER_UNIT;
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ownerless, contacts: [ROSTER_UNIT.contacts![0]!] } as NonNullable<ListingState['unit']>,
      roster: [ROSTER_READY.roster[0]!],
    });
   ```
   new_string:
   ```ts
    const { landlordId: _dropped, ...ownerless } = ROSTER_UNIT;
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ownerless, contacts: [ROSTER_UNIT.contacts![0]!] } as NonNullable<ListingState['unit']>,
      roster: [ROSTER_READY.roster[0]!],
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: null },
    });
   ```

   1e. Edit with `replace_all: true` (the two tests above share the sentence; expected 2 replacements):

   old_string:
   ```ts
        'This property will have no primary contact and has no landlord of record, so calls and new relay groups for it will reach no one until someone on its contact list is made the primary contact or a new contact is added.',
   ```
   new_string:
   ```ts
        "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.",
   ```

   1f. Edit (new tests, inserted before the existing 409 settle test):

   old_string:
   ```ts
  it('a 409 renders inline on the row, refetches the unit, and the row VISIBLY SETTLES', async () => {
   ```
   new_string:
   ```ts
  it('an heir with no name on record: "Another contact on this property becomes the primary contact."', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1' } },
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText('Another contact on this property becomes the primary contact.'),
    ).toBeInTheDocument();
  });

  it('no propertyContact block (the server could not tell): another contact MAY take over', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText('Another contact on this property may become the primary contact.'),
    ).toBeInTheDocument();
    // Never a client-side guess at the landlord of record.
    expect(within(dialog).queryByText(/James Porter/)).not.toBeInTheDocument();
  });

  it("the notice reads the LATEST roster write's block, not the load-time one", async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
    // Make Dana primary; the write answers with its own block - Alicia would
    // take over from Dana.
    addUnitContact.mockReset().mockResolvedValue({
      ...ROSTER_UNIT,
      primary_contact: 'pm2',
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryContact: false, name: 'Alicia Grant' },
        { contactId: 'll1', role: 'landlord', primaryContact: false, name: 'James Porter' },
        { contactId: 'pm2', role: 'pm', primaryContact: true, name: 'Dana Reyes' },
      ],
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: { contactId: 'pm1', name: 'Alicia Grant' } },
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' }));
    // Wait for the write to land: Dana is the primary row now.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }).parentElement,
      ).toHaveTextContent('Dana Reyes (primary)'),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        'Alicia Grant becomes the primary contact - new tours and relay groups for this property will use them.',
      ),
    ).toBeInTheDocument();
  });

  it('a 409 primary_contact_deleted on Make primary names its own reason, and the re-read marks the row deleted', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact
      .mockReset()
      .mockRejectedValue(
        new ApiError(409, 'primary_contact_deleted', 'primary_contact_deleted', { error: 'primary_contact_deleted' }),
      );
    getUnit.mockReset().mockResolvedValue({
      ...ROSTER_UNIT,
      contacts: ROSTER_UNIT.contacts!.map((row) =>
        row.contactId === 'pm2' ? { ...row, deleted: true as const } : row,
      ),
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That contact was deleted - restore them first or choose someone else.');
    expect(alert).not.toHaveTextContent(/landlord of record/);
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    // Settled: Dana is marked deleted and no longer offers Make primary.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Make Dana Reyes the primary contact' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }).parentElement,
    ).toHaveTextContent('Dana Reyes (deleted)');
  });

  it('a 503 roster_read_failed on removing the primary says the other contacts could not be checked, and re-reads nothing', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
    removeUnitContact
      .mockReset()
      .mockRejectedValue(
        new ApiError(503, 'roster_read_failed', 'roster_read_failed', { error: 'roster_read_failed' }),
      );
    getUnit.mockReset();
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    await user.click(within(dialog).getByRole('button', { name: 'Remove contact' }));

    expect(removeUnitContact).toHaveBeenCalledWith('u1', 'pm1');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Couldn't check the other contacts - try again.",
    );
    // Nothing was written, so there is nothing to settle.
    expect(getUnit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Remove the primary contact\?/i })).toBeInTheDocument();
  });

  it('a 409 renders inline on the row, refetches the unit, and the row VISIBLY SETTLES', async () => {
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: 8 failures - the three updated tests (`Unable to find an element with the text: James Porter becomes the primary contact - new tours ...` / `... This property will have no primary contact. New tours won't include a landlord ...`), the unnamed-heir and no-block tests (old landlord-of-record sentence shown instead), the latest-write test (old sentence), the 409 test (`expected ... to have text content That contact was deleted ...` - the landlord-of-record catch-all is shown), and the 503 test (`Couldn't save that change - please try again.` shown). Summary shows `8 failed`.

3. Implementation in `dashboard/src/routes/listing/ListingDetail.tsx`.

   3a. Edit (copy constants):

   old_string:
   ```ts
const ROSTER_CONFLICT_COPY =
  "That contact is the landlord of record now - reassign the property's landlord first.";
   ```
   new_string:
   ```ts
const ROSTER_CONFLICT_COPY =
  "That contact is the landlord of record now - reassign the property's landlord first.";

/** A 409 primary_contact_deleted (primary-contact-integrity spec 7.4): Make
 *  primary on a contact who was deleted. Its own sentence - not the
 *  landlord-of-record catch-all above. */
const PRIMARY_CONTACT_DELETED_COPY = 'That contact was deleted - restore them first or choose someone else.';

/** A 503 roster_read_failed on removing the primary (spec 7.3): the server
 *  could not check who takes over, so it removed nothing. */
const ROSTER_READ_FAILED_COPY = "Couldn't check the other contacts - try again.";

/** The remove-the-primary confirm (spec 7.3), word for word: no heir, an heir
 *  with no name on record, and no propertyContact block (could not tell). The
 *  named-heir sentence is built in promotionNotice. */
const NO_HEIR_NOTICE =
  "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.";
const UNNAMED_HEIR_NOTICE = 'Another contact on this property becomes the primary contact.';
const UNKNOWN_HEIR_NOTICE = 'Another contact on this property may become the primary contact.';
   ```

   3b. Edit (`runRosterWrite`'s failure mapping):

   old_string:
   ```ts
        const conflict = err instanceof ApiError && err.status === 409;
        setRosterError({
          key,
          message: conflict
            ? err.code === 'landlord_reassignment_required'
              ? LANDLORD_REASSIGNMENT_COPY
              : err.code === 'unit_roster_conflict'
                ? ROSTER_RETRY_COPY
              : ROSTER_CONFLICT_COPY
            : "Couldn't save that change - please try again.",
        });
        if (!conflict) return;
        await settle();
   ```
   new_string:
   ```ts
        // primary-contact-integrity spec 7.3: removing the primary could not
        // check who takes over (a contact read failed), so the server wrote
        // nothing. Not a race - no settle; the operator tries again.
        if (err instanceof ApiError && err.status === 503 && err.code === 'roster_read_failed') {
          setRosterError({ key, message: ROSTER_READ_FAILED_COPY });
          return;
        }
        const conflict = err instanceof ApiError && err.status === 409;
        setRosterError({
          key,
          message: conflict
            ? err.code === 'landlord_reassignment_required'
              ? LANDLORD_REASSIGNMENT_COPY
              : err.code === 'unit_roster_conflict'
                ? ROSTER_RETRY_COPY
                : err.code === 'primary_contact_deleted'
                  ? PRIMARY_CONTACT_DELETED_COPY
                  : ROSTER_CONFLICT_COPY
            : "Couldn't save that change - please try again.",
        });
        if (!conflict) return;
        await settle();
   ```

   3c. Edit (promotionNotice reads the block; replaces its long comment):

   old_string:
   ```ts
  /** Who the primary-contact routing lands on once `row` is gone: the landlord
   *  of record (the repo promotes them), or nobody when the property has no
   *  landlordId. There is no further fallback: the server's property-contact
   *  resolvers take the primary row, else the landlord of record, so with
   *  neither they find no one and calls and new relay groups for the property
   *  reach no one. On such a property (no primary contact, no landlord of
   *  record) the routing comes back in one of three ways:
   *  - a NEW contact typed landlord (a landlord, property manager or owner,
   *    whatever its role) added to the contact list becomes its primary
   *    contact automatically - the server decides it, while "+ Add contact"
   *    still posts `primaryContact: false`. A new contact of any other type
   *    (tenant, partner, unknown, team member) joins non-primary;
   *  - a contact already on the list and typed landlord, re-roled to
   *    Landlord, claims the empty landlord slot (it is not made primary; the
   *    resolvers fall back to it as the landlord of record);
   *  - otherwise only Make primary on someone on the list.
   *  The sentence below is Cameron's ruled copy and stays as ruled: it names
   *  the first and last ways, and its "a new contact is added" holds for a new
   *  contact typed landlord only (caseworker-integrity spec section 4
   *  "Contact list" auto-primary: revision 4, superseding planner rulings Q2
   *  and Q3, narrowed by revision 5 - Cameron's Q4 ruling; R1 code review,
   *  dashboard finding 1; R2 code review, dashboard finding A5). */
  const promotionNotice = (): string => {
    const promoted =
      landlordOfRecord.length > 0
        ? contactRows.find((r) => r.contactId === landlordOfRecord)?.name ?? landlordOfRecord
        : undefined;
    return promoted !== undefined
      ? `${promoted} becomes the primary contact - calls and new relay groups for this property will go to them.`
      : 'This property will have no primary contact and has no landlord of record, so calls and new relay groups for it will reach no one until someone on its contact list is made the primary contact or a new contact is added.';
  };
   ```
   new_string:
   ```ts
  /** The remove-the-primary confirm's sentence (primary-contact-integrity spec
   *  7.3). WHO takes over is the server's call, read from the propertyContact
   *  block's `heirIfPrimaryRemoved` (the heir function with the primary
   *  excluded) - never a client-side copy of that rule. The block carries the
   *  heir's name even for an off-roster landlord of record. "calls and" is
   *  gone from the old sentence: the scalar drives no live call routing. An
   *  absent block means the server could not tell. */
  const promotionNotice = (): string => {
    if (propertyContact === undefined) return UNKNOWN_HEIR_NOTICE;
    const heir = propertyContact.heirIfPrimaryRemoved;
    if (heir === null) return NO_HEIR_NOTICE;
    return heir.name !== undefined && heir.name.length > 0
      ? `${heir.name} becomes the primary contact - new tours and relay groups for this property will use them.`
      : UNNAMED_HEIR_NOTICE;
  };
   ```

   3d. Edit (stale comment, spec 9.2):

   old_string:
   ```ts
  /** Who OWNS the property (`unit.landlordId`) - never removable from the roster,
   *  and whoever inherits the primary-contact routing when the primary leaves. */
   ```
   new_string:
   ```ts
  /** Who OWNS the property (`unit.landlordId`) - never removable from the
   *  roster. Who takes over when the primary leaves is the SERVER's call
   *  (propertyContact.heirIfPrimaryRemoved, primary-contact-integrity 7.3). */
   ```

   3e. Edit (stale comment, spec 9.2):

   old_string:
   ```ts
  // --- Contacts card edit mode (spec 6.1 / D9) ------------------------------
  // This card is where the property's PRIMARY CONTACT is set: the person tours
  // and placements put on the relay group and reach by masked call when nobody
  // has overridden the roster. A deleted property is read-only, like every other
  // card here.
   ```
   new_string:
   ```ts
  // --- Contacts card edit mode (spec 6.1 / D9) ------------------------------
  // This card is where the property's PRIMARY CONTACT is set: the person new
  // tours and placements put on their people list and the tour intro names
  // (no live call routing reads it - primary-contact-integrity spec 9.2). A
  // deleted property is read-only, like every other card here.
   ```

   3f. Edit (stale comment, spec 9.2):

   old_string:
   ```ts
  /** Removing the CURRENT primary contact re-points live masked calls and every
   *  new relay group, so it confirms first and NAMES who inherits that routing.
   *  Any other row removes on click. */
   ```
   new_string:
   ```ts
  /** Removing the CURRENT primary contact changes who new tours and relay
   *  groups for this property use, so it confirms first and NAMES who takes
   *  over (primary-contact-integrity spec 7.3). Any other row removes on
   *  click. */
   ```

   3g. Edit (stale comment, spec 9.2):

   old_string:
   ```tsx
      {/* Removing the primary contact re-points live routing, so it NAMES the
          promotion before it writes - silently moving calls is not acceptable
          (spec 6.1). */}
   ```
   new_string:
   ```tsx
      {/* Removing the primary contact changes who new tours and relay groups
          use, so it NAMES who takes over before it writes (spec 6.1; the
          sentence is the server's call, primary-contact-integrity spec 7.3). */}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: all tests pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.
   `cd W:/tmp/primary-contact-integrity && grep -n "calls and new relay groups\|masked call" dashboard/src/routes/listing/ListingDetail.tsx` - expected: no output.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx && git commit -m "feat(dashboard): remove-the-primary notice reads the server heir; primary_contact_deleted and roster_read_failed copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.10 - Property page: re-read after either restore, and the re-read becomes the roster source

Files:
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx`
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx`

Steps:

1. Tests. Do the four existing-test edits (1a-1d) FIRST, then append (1e).
   Existing tests that change (each now also mocks the re-read, which the page
   makes after a successful restore; their assertions are unchanged):
   "shows the Deleted banner + Restore for a deleted property and restores in
   place", "a restore that needs a landlord opens the landlord dialog;
   restoring through it applies the unit and closes it", "(PIN) restoring
   through the landlord dialog puts the restored roster on the Contacts card,
   not just the page unit", "Restore without a landlord that promotes the sole
   landlord-typed contact shows that contact as the primary contact".

   1a. `dashboard/src/routes/listing/ListingDetail.test.tsx`, Edit:

   old_string:
   ```ts
    restoreUnit.mockResolvedValue({ ...READY.unit }); // restored (no deleted_at)
   ```
   new_string:
   ```ts
    restoreUnit.mockResolvedValue({ ...READY.unit }); // restored (no deleted_at)
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue({ ...READY.unit });
   ```

   1b. Edit:

   old_string:
   ```ts
    const restored = { ...READY.unit!, landlordId: 'll9' };
   ```
   new_string:
   ```ts
    const restored = { ...READY.unit!, landlordId: 'll9' };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
   ```

   1c. Edit:

   old_string:
   ```ts
      contacts: [{ contactId: 'll9', role: 'landlord' as const, primaryContact: true, name: 'Nora Lane' }],
    };
   ```
   new_string:
   ```ts
      contacts: [{ contactId: 'll9', role: 'landlord' as const, primaryContact: true, name: 'Nora Lane' }],
    };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
   ```

   1d. Edit:

   old_string:
   ```ts
      contacts: [{ ...dana, primaryContact: true }],
    };
   ```
   new_string:
   ```ts
      contacts: [{ ...dana, primaryContact: true }],
    };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
   ```

   1e. Edit (append after Task S4.8's describe; uses the module-level `contactsCard()` and the imported `listingRoster`):

   old_string:
   ```ts
    expect(await within(box).findByRole('alert')).toHaveTextContent("Couldn't save that change - please try again.");
  });
});
   ```
   new_string:
   ```ts
    expect(await within(box).findByRole('alert')).toHaveTextContent("Couldn't save that change - please try again.");
  });
});

describe('ListingDetail - a restore re-reads the roster source (primary-contact-integrity spec 7.5)', () => {
  beforeEach(() => {
    restoreUnit.mockReset();
    getUnit.mockReset();
    getAllContacts.mockReset().mockResolvedValue([]);
  });

  it('a plain restore re-reads the property, and the re-read becomes the Contacts card roster', async () => {
    const user = userEvent.setup();
    const james: UnitContact = { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' };
    const dana: UnitContact = { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      contacts: [james, dana],
    };
    const { deleted_at: _live, ...liveUnit } = deletedUnit;
    // The re-read: the server's own roster now (Dana primary) and its block.
    const fresh: NonNullable<ListingState['unit']> = {
      ...liveUnit,
      contacts: [{ ...james, primaryContact: false }, { ...dana, primaryContact: true }],
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    };
    restoreUnit.mockResolvedValue(liveUnit);
    getUnit.mockResolvedValue(fresh);
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: listingRoster(deletedUnit, null),
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() =>
      expect(within(contactsCard()).getAllByRole('link')[0]).toHaveTextContent('Dana Reyes (primary)'),
    );
  });

  it('a restore through the landlord dialog re-reads the property; the re-read REPLACES the restore answer as the roster source', async () => {
    const user = userEvent.setup();
    const james: UnitContact = { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' };
    const dana: UnitContact = { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      landlordId: 'll1',
      primary_contact: 'll1',
      contacts: [james, dana],
    };
    const { landlordId: _cleared, deleted_at: _live, ...restoredBase } = deletedUnit;
    // The restore's own answer: James's row gone, Dana handed the primary - and
    // no propertyContact block (restore responses carry none).
    const restoreAnswer: NonNullable<ListingState['unit']> = {
      ...restoredBase,
      primary_contact: 'pm2',
      contacts: [{ ...dana, primaryContact: true }],
    };
    // The re-read carries the block: nobody would take over from Dana.
    const reread: NonNullable<ListingState['unit']> = {
      ...restoreAnswer,
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: null },
    };
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockResolvedValueOnce(restoreAnswer);
    getUnit.mockResolvedValue(reread);
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: listingRoster(deletedUnit, null),
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));

    // The re-read's block is what the remove confirm reads: the server says
    // nobody takes over. The restore answer alone (no block) would only let
    // the page say that someone MAY take over.
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }));
    const confirm = await screen.findByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      await within(confirm).findByText(
        "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.",
      ),
    ).toBeInTheDocument();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx`
   Expected: the two new tests fail with `expected "spy" to be called with arguments: [ 'u1' ]` (`Number of calls: 0`) on `getUnit`; the four edited existing tests still pass. Summary shows `2 failed`.

3. Implementation in `dashboard/src/routes/listing/ListingDetail.tsx`.

   3a. Edit (plain restore):

   old_string:
   ```ts
    void restoreUnit(unit.unitId)
      .then((updated) => setUnit(updated))
   ```
   new_string:
   ```ts
    void restoreUnit(unit.unitId)
      .then((updated) => {
        setUnit(updated);
        // primary-contact-integrity spec 7.5: re-read the property and make
        // the re-read the Contacts card's roster source, REPLACING any earlier
        // roster-write response (a restore answers with no propertyContact
        // block). Best-effort: on a failed re-read the card keeps what it had.
        void getUnit(unit.unitId)
          .then((fresh) => {
            setRosterUnit(fresh);
            setUnit(fresh);
          })
          .catch(() => {
            /* best-effort re-read */
          });
      })
   ```

   3b. Edit (restore through the landlord dialog):

   old_string:
   ```tsx
          onRestored={(updated) => {
            setRestoreNeeds(null);
            applyRosterUnit(updated);
          }}
   ```
   new_string:
   ```tsx
          onRestored={(updated) => {
            setRestoreNeeds(null);
            applyRosterUnit(updated);
            // primary-contact-integrity spec 7.5: a landlord-clearing or
            // landlord-swapping restore can hand the primary contact off, and
            // its answer carries no propertyContact block - re-read, and let
            // the re-read REPLACE this answer as the card's roster source.
            // Best-effort: on a failure the card keeps the restore's roster.
            void getUnit(unit.unitId)
              .then((fresh) => applyRosterUnit(fresh))
              .catch(() => {
                /* best-effort re-read */
              });
          }}
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx src/routes/listing/useListing.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx`
   Expected: all three files pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx && git commit -m "feat(dashboard): property page re-reads the roster source after either restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.10b - Restore dialog: a 503 roster_read_failed shows the shared "could not check" sentence

Planner addition (assembly ruling R12). A landlord restore through
`RestoreLandlordDialog` ("Restore without a landlord", or with a new landlord)
can now answer 503 `roster_read_failed` when the server could not read the
contacts it needs to pick the next primary (spec 4.6: unknown -> refuse,
nothing written). Today that falls into the generic "Couldn't restore"
sentence. It must show the same sentence the property page shows for the same
code on Remove (Task S4.9), from ONE shared literal - `rosterCopy.ts` exists
for exactly that ("the two sites show ONE sentence ... and cannot drift
apart"). A plain restore never runs a hand-off, so it never answers 503 and is
unchanged.

Files:
- Modify: `dashboard/src/routes/listing/rosterCopy.ts`
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx`
- Modify: `dashboard/src/routes/listing/RestoreLandlordDialog.tsx`
- Test: `dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx`

Steps:

1. Test. In `dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx`,
   Edit. old_string:

   ```ts
     it('any other failure says the restore did not happen', async () => {
   ```

   new_string:

   ```ts
     it('a 503 roster_read_failed says the other contacts could not be checked, and stays open', async () => {
       const user = userEvent.setup();
       restoreUnit.mockRejectedValue(
         new ApiError(503, 'roster_read_failed', 'roster_read_failed', { error: 'roster_read_failed' }),
       );
       const { onRestored, onConflict } = setup();
       await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
       expect(await screen.findByRole('alert')).toHaveTextContent(
         "Couldn't check the other contacts - try again.",
       );
       expect(onRestored).not.toHaveBeenCalled();
       expect(onConflict).not.toHaveBeenCalled();
       expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
     });

     it('any other failure says the restore did not happen', async () => {
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/RestoreLandlordDialog.test.tsx`
   Expected: `1 failed`, the new test, with the alert reading
   `Couldn't restore - please try again.` instead.

3. Implement.

   3a. `dashboard/src/routes/listing/rosterCopy.ts` - append at the end of the
   file:

   ```ts

   /** A 503 roster_read_failed (primary-contact-integrity spec 4.6 / 7.3): the
    *  server could not read the contacts it needs to pick the next primary, so
    *  nothing was written - removing the primary, or a landlord restore. */
   export const ROSTER_READ_FAILED_COPY = "Couldn't check the other contacts - try again.";
   ```

   3b. `dashboard/src/routes/listing/ListingDetail.tsx` - the page now imports
   the shared literal instead of its own copy (Task S4.9 added the local one).
   Edit, old_string:

   ```ts
   import { ROSTER_RETRY_COPY } from './rosterCopy.js';
   ```

   new_string:

   ```ts
   import { ROSTER_READ_FAILED_COPY, ROSTER_RETRY_COPY } from './rosterCopy.js';
   ```

   Then Edit, old_string:

   ```ts
   /** A 503 roster_read_failed on removing the primary (spec 7.3): the server
    *  could not check who takes over, so it removed nothing. */
   const ROSTER_READ_FAILED_COPY = "Couldn't check the other contacts - try again.";

   ```

   new_string: the empty string (delete those lines and the blank line after
   them). Every use of `ROSTER_READ_FAILED_COPY` in the file stays as it is.

   3c. `dashboard/src/routes/listing/RestoreLandlordDialog.tsx` - Edit,
   old_string:

   ```ts
   import { ROSTER_RETRY_COPY } from './rosterCopy.js';
   ```

   new_string:

   ```ts
   import { ROSTER_READ_FAILED_COPY, ROSTER_RETRY_COPY } from './rosterCopy.js';
   ```

   Then Edit, old_string:

   ```ts
           if (err instanceof ApiError && err.status === 409 && err.code === 'unit_roster_conflict') {
             setError(ROSTER_RETRY_COPY);
             onConflict();
             return;
           }
           setError(RESTORE_FAILED_COPY);
   ```

   new_string:

   ```ts
           if (err instanceof ApiError && err.status === 409 && err.code === 'unit_roster_conflict') {
             setError(ROSTER_RETRY_COPY);
             onConflict();
             return;
           }
           // primary-contact-integrity spec 4.6: the server could not read the
           // contacts it needs to pick the next primary and wrote nothing. A
           // retry can succeed, so the dialog stays open and asks for one.
           if (err instanceof ApiError && err.status === 503 && err.code === 'roster_read_failed') {
             setError(ROSTER_READ_FAILED_COPY);
             return;
           }
           setError(RESTORE_FAILED_COPY);
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/RestoreLandlordDialog.test.tsx src/routes/listing/ListingDetail.test.tsx`
   Expected: both files pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the four files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/rosterCopy.ts dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/RestoreLandlordDialog.tsx dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx && git commit -m "feat(dashboard): restore dialog shows the shared could-not-check sentence on 503 roster_read_failed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.11 - Property Activity: the unit_primary_contact_assigned line

Files:
- Modify: `dashboard/src/routes/listing/listingFormat.ts`
- Test: `dashboard/src/routes/listing/listingFormat.test.ts`

Steps:

1. Failing test. `dashboard/src/routes/listing/listingFormat.test.ts`, Edit (insert inside `describe('describeUnitActivity', ...)`):

   old_string:
   ```ts
  it('describes the auto-close and reopen rows (spec 9.5) with their tour deep-links', () => {
   ```
   new_string:
   ```ts
  it('describes an automatic primary-contact pick with who, why, and a contact link (primary-contact-integrity spec 8)', () => {
    const assigned = (reason?: string) =>
      describeUnitActivity(
        evt({
          type: 'unit_primary_contact_assigned',
          contactId: 'c1',
          contactName: 'Mark Passmore',
          ...(reason !== undefined && { reason }),
        }),
      );
    expect(assigned('auto_on_add')).toEqual({
      label: 'Primary contact set automatically',
      sub: 'Mark Passmore - the property had no primary contact',
      to: '/contacts/c1',
    });
    expect(assigned('handoff_on_remove').sub).toBe('Mark Passmore - the previous primary contact was removed');
    expect(assigned('handoff_on_delete').sub).toBe('Mark Passmore - the previous primary contact was deleted');
    expect(assigned('handoff_on_restore').sub).toBe(
      "Mark Passmore - the property's landlord changed when it was restored",
    );
    expect(assigned('backfill').sub).toBe('Mark Passmore - set by a one-time data repair');
    // An unknown reason humanizes; no reason leaves just who.
    expect(assigned('manual_fix').sub).toBe('Mark Passmore - Manual fix');
    expect(assigned()).toEqual({
      label: 'Primary contact set automatically',
      sub: 'Mark Passmore',
      to: '/contacts/c1',
    });
    // An unresolved contact: the id stands in.
    expect(
      describeUnitActivity(evt({ type: 'unit_primary_contact_assigned', contactId: 'c2', reason: 'backfill' })),
    ).toEqual({
      label: 'Primary contact set automatically',
      sub: 'c2 - set by a one-time data repair',
      to: '/contacts/c2',
    });
  });

  it('describes the auto-close and reopen rows (spec 9.5) with their tour deep-links', () => {
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/listingFormat.test.ts`
   Expected: `FAIL ... > describes an automatic primary-contact pick ...` with `expected { label: 'Unit primary contact assigned' } to deeply equal { label: 'Primary contact set automatically', ... }`; summary shows `1 failed`.

3. Implementation in `dashboard/src/routes/listing/listingFormat.ts`.

   3a. Edit:

   old_string:
   ```ts
  tour_auto_closed: 'Tour closed automatically: no outcome recorded after two weeks',
  tour_reopened: 'Tour reopened',
};
   ```
   new_string:
   ```ts
  tour_auto_closed: 'Tour closed automatically: no outcome recorded after two weeks',
  tour_reopened: 'Tour reopened',
};

/** Why a primary contact was set without anyone clicking Make primary
 *  (primary-contact-integrity spec 8, the `reason` on
 *  unit_primary_contact_assigned). A Map, so an inherited name such as
 *  `toString` never matches; an unknown reason humanizes. */
const PRIMARY_ASSIGNED_REASON: ReadonlyMap<string, string> = new Map([
  ['auto_on_add', 'the property had no primary contact'],
  ['handoff_on_remove', 'the previous primary contact was removed'],
  ['handoff_on_delete', 'the previous primary contact was deleted'],
  ['handoff_on_restore', "the property's landlord changed when it was restored"],
  ['backfill', 'set by a one-time data repair'],
]);
   ```

   3b. Edit:

   old_string:
   ```ts
    case 'unit_deleted':
      return { label: 'Property deleted' };
   ```
   new_string:
   ```ts
    case 'unit_primary_contact_assigned': {
      // primary-contact-integrity spec 8: a primary contact nobody clicked -
      // an automatic pick or the backfill script - says who and why, and
      // links to the contact. (`from` is a raw contact id; not shown.)
      const why =
        e.reason !== undefined ? (PRIMARY_ASSIGNED_REASON.get(e.reason) ?? humanize(e.reason)) : undefined;
      const sub = [who, why].filter(Boolean).join(' - ');
      return { label: 'Primary contact set automatically', ...(sub && { sub }), ...contactLink };
    }
    case 'unit_deleted':
      return { label: 'Property deleted' };
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/listing/listingFormat.test.ts`
   Expected: all pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/listing/listingFormat.ts dashboard/src/routes/listing/listingFormat.test.ts && git commit -m "feat(dashboard): property Activity line for an automatic primary contact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.12 - Contact Delete dialog: the handoff sentence for non-tenants

Files:
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx`
- Test: `dashboard/src/routes/contact/ContactDetail.test.tsx`

Steps:

1. Failing tests. `dashboard/src/routes/contact/ContactDetail.test.tsx`, Edit (append at the end of the file):

   old_string:
   ```ts
    expect(await screen.findByText('COMPOSER')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?contactId=p-send');
  });
});
   ```
   new_string:
   ```ts
    expect(await screen.findByText('COMPOSER')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?contactId=p-send');
  });
});

// primary-contact-integrity spec 7.6: deleting a contact who is a property's
// primary contact hands that property off (server, spec 4.6), and restoring
// them does not take it back. The Delete dialog says so for every contact
// that is not a tenant; a tenant-typed primary (a degenerate state) gets no
// sentence - the dialog cannot know without the server's scan.
describe('ContactDetail - the Delete dialog names the primary-contact handoff (primary-contact-integrity spec 7.6)', () => {
  const HANDOFF =
    "If they're a property's primary contact, the landlord or another contact on that property takes over, and restoring them won't change that back.";
  const PARTNER_TO_DELETE: Contact = {
    contactId: 'p-del',
    type: 'partner',
    firstName: 'Renee',
    lastName: 'Carter',
    status: 'active',
    phone: '+14045550123',
  };

  async function openDeleteDialog(contact: Contact): Promise<HTMLElement> {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(contact);
    renderAt(contact.contactId);
    await user.click(await screen.findByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete contact/i }));
    return screen.getByRole('dialog', { name: /Delete contact\?/i });
  }

  it.each([
    ['a landlord', LANDLORD],
    ['a partner', PARTNER_TO_DELETE],
  ] as const)('%s gets the handoff sentence', async (_label, contact) => {
    const dialog = await openDeleteDialog(contact);
    expect(within(dialog).getByText(HANDOFF)).toBeInTheDocument();
  });

  it('a tenant does not', async () => {
    const dialog = await openDeleteDialog(TENANT);
    expect(within(dialog).queryByText(HANDOFF)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is erased/)).toBeInTheDocument();
  });
});
   ```

2. Run RED:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/contact/ContactDetail.test.tsx`
   Expected: the landlord and partner cases fail with `Unable to find an element with the text: If they're a property's primary contact, ...`; the tenant case passes already (pin). Summary shows `2 failed`.

3. Implementation in `dashboard/src/routes/contact/ContactDetail.tsx`.

   3a. Edit (module-level copy constant):

   old_string:
   ```ts
export const MARK_UNREAD_NO_THREAD =
  'No thread to mark unread yet - if this contact has messages, try again.';
   ```
   new_string:
   ```ts
export const MARK_UNREAD_NO_THREAD =
  'No thread to mark unread yet - if this contact has messages, try again.';

/** The Delete dialog's handoff sentence for a non-tenant contact
 *  (primary-contact-integrity spec 7.6), word for word. */
const DELETE_PRIMARY_HANDOFF_SENTENCE =
  "If they're a property's primary contact, the landlord or another contact on that property takes over, and restoring them won't change that back.";
   ```

   3b. Edit (the dialog body):

   old_string:
   ```tsx
            <em>Deleted</em> view.
          </p>
          {deleteError !== null ? (
   ```
   new_string:
   ```tsx
            <em>Deleted</em> view.
          </p>
          {/* primary-contact-integrity spec 7.6: deleting a non-tenant hands
              off any property it is the primary contact of, and a restore does
              not take that back. A tenant-typed primary (a degenerate state)
              gets no sentence: the dialog cannot know without the server's
              scan. */}
          {contact.type !== 'tenant' ? <p>{DELETE_PRIMARY_HANDOFF_SENTENCE}</p> : null}
          {deleteError !== null ? (
   ```

4. Run GREEN:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run src/routes/contact/ContactDetail.test.tsx`
   Expected: all pass, `0 failed`.
   `cd W:/tmp/primary-contact-integrity/dashboard && npx tsc -p tsconfig.json --noEmit` - expected: no output, exit 0.

5. Commit:
   `cd W:/tmp/primary-contact-integrity && git status` - expected modified: the two files above only.
   `cd W:/tmp/primary-contact-integrity && git rev-parse -q --verify MERGE_HEAD` - expected: prints nothing.
   `cd W:/tmp/primary-contact-integrity && git add dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx && git commit -m "feat(dashboard): contact Delete dialog names the primary-contact handoff" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task S4.13 - Slice gate

Files: none modified (fixes, if any, go back to the task that owns the file
and are committed with explicit paths).

Steps:

1. Typecheck, both workspaces, bare (never piped):
   `cd W:/tmp/primary-contact-integrity && npm run typecheck`
   Expected: exits 0 (`tsc -p tsconfig.json --noEmit` clean for app and dashboard).

2. The whole dashboard unit suite (covers every file this slice touched -
   `rosterPeople`, `RosterConfirmDialog`, `PeopleCard`, `TourDetail`,
   `PlacementDetail`, `buildListingFile`, `useListing`, `ListingDetail`,
   `RestoreLandlordDialog`, `listingFormat`, `ContactDetail` - plus every
   other consumer of the changed types). No Docker needed:
   `cd W:/tmp/primary-contact-integrity/dashboard && npx vitest run`
   Expected: every test file passes, `0 failed`.

2b. Lint the dashboard files this slice touched (plan review R1 P5 - S4's
   edits sit in files that carry PRE-EXISTING `react-hooks/*` errors, so an
   early look matters; the full gate 5 runs in S5). List them:
   `cd W:/tmp/primary-contact-integrity && git diff --name-only --diff-filter=d f204106f..HEAD -- 'dashboard/*.ts' 'dashboard/*.tsx'`
   then lint exactly that list, bare:
   `cd W:/tmp/primary-contact-integrity && npx eslint $(git diff --name-only --diff-filter=d f204106f..HEAD -- 'dashboard/*.ts' 'dashboard/*.tsx')`
   Expected: exit 0, or errors that ALL pre-date this branch. Attribute by
   BASELINE, never by line number: for each file with an error, lint its
   pre-branch version and compare the two outputs, e.g.
   `cd W:/tmp/primary-contact-integrity && git show f204106f:dashboard/src/routes/listing/ListingDetail.tsx | npx eslint --stdin --stdin-filename dashboard/src/routes/listing/ListingDetail.tsx`
   An error (rule + message) present now and absent at f204106f is this
   slice's and BLOCKS - fix it in the owning task's file and commit. Name the
   pre-existing ones in the slice report. (A NEW file has no baseline: any
   error in it is this slice's.)

3. ASCII check of this slice's dashboard diff (dashboard is touched only by
   S4; f204106f is the plan-skeleton commit before S1):
   `cd W:/tmp/primary-contact-integrity && git diff -U0 f204106f..HEAD -- dashboard/src | grep -nP '^\+(?!\+\+).*[^\x00-\x7F]'`
   Expected: no output (grep exits 1). Any hit is a non-ASCII added line: fix
   it in the owning task's file and commit.

4. Confirm the copy is the spec's: `cd W:/tmp/primary-contact-integrity && grep -rn "calls and new relay groups\|who calls route to\|reach by masked call" dashboard/src`
   Expected: no output.

5. `cd W:/tmp/primary-contact-integrity && git status` - expected: clean
   (everything committed in S4.1-S4.12).

6. Hand-off note for S5 (do not edit `e2e/` in this slice): the remove-the-
   primary confirm copy changed (CONTRACT ISSUE 1) - S5 updates
   `e2e/tests/dashboard-next/property-roster.spec.ts:251` and
   `e2e/support/selectors.md:87` before its e2e gate.

---

### Selectors S5 can use (accessibility-first)

- Open-group dialog fallback box:
  `dialog.getByRole('status').filter({ hasText: 'Using the general intro, not the tour intro.' })`
  (placement: `... not the placement intro.`); its links
  `getByRole('link', { name: 'Set a primary contact' })` / `'Add a first name'` /
  `'Add the address'` (`target="_blank"`, `rel="noreferrer"`; read `href`
  rather than following them); `getByRole('button', { name: 'Check again' })`.
- Edited-draft note: `getByText('The intro changed.')`,
  `getByRole('button', { name: 'Use the updated intro' })`.
- Property no-primary box:
  `page.getByRole('status').filter({ hasText: 'No primary contact.' })` (or
  `"This property's contact was deleted."`);
  `getByRole('button', { name: 'Make <Name> primary' })`;
  `getByRole('button', { name: 'Choose a primary' })`.
- Deleted rows: the row link / edit-row text contains `<Name> (deleted)`; no
  `Make <Name> the primary contact` button on such a row.
- Remove-the-primary confirm (`getByRole('dialog', { name: 'Remove the primary
  contact?' })`) sentences: `<Heir> becomes the primary contact - new tours
  and relay groups for this property will use them.` /
  `This property will have no primary contact. New tours won't include a
  landlord, and tour group texts will use the general intro.` /
  `Another contact on this property becomes the primary contact.` /
  `Another contact on this property may become the primary contact.`
- Property Activity row: label `Primary contact set automatically`, sub
  `<Name> - <why>` (P-3).

---

## Slice S5 - script, dev seam, e2e, docs, completion gates (DRAFT)

Runs AFTER S1-S4. Every path below is absolute or relative to the worktree
root `W:\tmp\primary-contact-integrity`. Commands are Git Bash (the Bash
tool): `timeout` in the gates task is the coreutils one - in PowerShell or
cmd, `timeout 2700` is Windows' timeout.exe, which just WAITS 45 minutes. ASCII
only in every line you add.

### CONTRACT ISSUES (RULED - section 3.2 and plan-assembly-rulings.md govern; do not act on any "ruling needed" text here)

1. **S5 needs a new repo write in S2-owned files:
   `UnitsRepo.assignPrimaryIfCurrent`.** Spec 8 requires the script's OWN
   conditional write against the roster and `landlordId` IT read, never a
   re-read. Nothing in contract 2.2 does that: `addContact` re-reads (spec 8
   forbids it), and `handOffPrimaryFrom(unitId, fromContactId, ...)` re-reads,
   retries and needs a `from` - a unit with NO flagged primary (470 Bolton)
   has none, and it answers `not_primary`. Proposal (Task S5.1): S5 adds,
   ADDITIVELY and touching no S2 region,
   - `assignPrimaryIfCurrent(unit: UnitItem, next: { contacts: UnitContact[];
     primaryContact: string }): Promise<'written' | 'skipped'>` to the
     `UnitsRepo` interface (right after `rewriteAcceptedAuthorities`) and its
     implementation (right after `rewriteAcceptedAuthorities`'s), calling the
     private `updateRosterIfCurrent` UNCHANGED - one attempt, a lost condition
     answers `'skipped'`, any other error is thrown;
   - its mirror in the API-test fake `app/test/helpers/twilioWebhookHarness.ts`
     (right after the fake's `rewriteAcceptedAuthorities`) - required anyway:
     the fake is typed `UnitsRepo`, so typecheck fails without it.
   It stamps `updated_at` (that is what `updateRosterIfCurrent` does). Safe:
   the script writes only units with a STORED contact list (a landlord-only
   unit is never a target and never aligned - see S5.2), which in dev and prod
   only roster writes create, each stamping `updated_at`; so the importer's
   ownership line (`lib/import/apply.ts` `attribute_not_exists(updated_at)`)
   never moves. Planner: rule that S5 may edit those two files at those
   anchors, or move the method into S2 with this exact signature.

2. **Contract 2.7 refined (the dev seam's body and answer).**
   `POST /__dev/fixtures/zero-primary-property` takes `{ street: string;
   rows: Array<{ contactId: string; role: 'pm' | 'owner' | 'other' }> }`
   (1 to 5 rows, each contact once) and answers 201 `{ unitId }`. Changes
   from 2.7: (a) the SPEC creates the contacts through the real
   `POST /api/contacts` (phones, phone pointer rows and types exactly as
   production makes them - the open-group dialog needs two reachable members);
   the seam only checks they exist and writes the unit, so it duplicates no
   contact-create logic; (b) role `landlord` is refused - on an ownerless
   property a landlord-role add CLAIMS the landlord slot, so no path stores
   that row; (c) `street` is required (the box, the dialog and the intro all
   name it, and the spec needs it run-unique); (d) the unit is status `setup`
   with no `accepted_authorities`, so it never enters the Available view or
   the organization usage counts other specs assert on; (e) rows carry no
   `name` / `company` (the unit GET's `enrichRoster` is authoritative at read
   time). Path unchanged.

3. **[SUPERSEDED by ruling R24 - gate 4 runs under `timeout 2700`; Task S5.12
   below already says so.]** **Gate 4's cap.** As instructed, the e2e gate runs under `timeout 1500`
   (also `documentation/FEATURE-DEVELOPMENT-WORKFLOW.md` 3.5). `e2e/README.md`
   records full-suite wall times of 33-43 minutes in the Linux cloud
   container, where missions use `timeout 2700`. If this machine's full suite
   needs more than 1500 s the gate cannot pass; Task S5.12 treats exit 124 as a
   gate FAILURE to report, never as a reason to raise the cap on its own.
   Planner: confirm 1500 for this Windows build, or rule 2700.

4. **Cross-slice notes (no change requested, ordering only).**
   - S4's spec-7.3 copy change breaks the existing e2e assertion
     `e2e/tests/dashboard-next/property-roster.spec.ts` step 4 (the old
     "calls and new relay groups ... will go to them." notice). S5.7 owns
     that edit; S4 must not edit `e2e/`.
   - Spec 7.1 gives the fallback box `role="status"`. The open dialog can then
     hold TWO `role="status"` nodes (that box and the duplicate warning).
     `e2e/support/selectors.md` claims the status is unique inside the dialog;
     S5.8 corrects that row. S4 owns any `RosterConfirmDialog.test.tsx` pin of
     the old uniqueness.

### Assumptions on S1-S4 (used literally; no change requested)

- S1 (contract 2.1), `app/src/lib/propertyContact.ts`: `readRosterContacts`,
  `rosterContactIds`, `chooseHeir`, `applyPrimary`, `RosterContactsRead`
  exactly as typed there. In particular: `chooseHeir` answers
  `{ kind: 'none', why: 'no_live_candidate' }` for a unit with no roster rows
  and no landlord, and `applyPrimary` keeps the roster's order and adds the
  landlord's row (role `landlord`, flagged) when `addLandlordRow` is true.
- S2 (contract 2.2): `ListUnitsOpts.consistentRead?: boolean` on
  `unitsRepo.list` (a Scan with `ConsistentRead`).
- S2 (contract 2.4): the audit event type is the string
  `unit_primary_contact_assigned`, payload `{ contactId, reason, from? }`. No
  exported constant is in the contract, so the script declares
  `PRIMARY_ASSIGNED_EVENT` itself. If S2 exports one, import it instead.
- S3 (contract 2.6): GET `/api/units/:id` answers `{ unit }` and `unit` carries
  `propertyContact` on a complete read; the tour open preview
  (`GET /api/tours/:tourId/roster/preview-open`) carries `introFallback`
  (contract 2.5).
- S4: the spec 7.1, 7.3 and 7.4 strings verbatim (heading, reason line, link
  text `Set a primary contact`, button `Check again`, box lead
  `No primary contact.`, sentence `New tours won't include the landlord, and
  tour group texts use the general intro.`, buttons `Make <Full Name> primary`
  and `Choose a primary`, notice `<Heir name> becomes the primary contact - new
  tours and relay groups for this property will use them.`), with `<Full Name>`
  and `<Heir name>` the row's / heir's display name `First Last`.

### Findings against the spec

None (no `S5-findings.md` written).

---

#### Task S5.1 - `UnitsRepo.assignPrimaryIfCurrent` (the script's conditional write)

See CONTRACT ISSUE 1 (S2-owned files; additive edits at the anchors below).

**Files:**
- Modify: `app/src/repos/unitsRepo.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts`
- Create: `app/test/unitsRepoAssignPrimary.integration.test.ts`

**Steps:**

1. Write the failing test - create
   `app/test/unitsRepoAssignPrimary.integration.test.ts`:

```ts
// primary-contact-integrity (spec section 8; plan C12, task S5.1): the real
// unitsRepo.assignPrimaryIfCurrent - the one-time assign-primary-contacts
// script's write. It sets the contact list and the primary_contact scalar
// ONLY while landlordId AND contacts[] are exactly what the caller read (the
// updateRosterIfCurrent guard), answers 'skipped' on a lost condition after
// ONE attempt with no re-read (a primary someone set after the read is never
// overwritten), creates nothing for a unit that is gone, and lets any other
// error through.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createUnitsRepo, type CreateUnitInput, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[unitsRepoAssignPrimary.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const MARK: UnitContact = { contactId: 'c-mark', role: 'pm', primaryContact: false };
const MARK_PRIMARY: UnitContact = { ...MARK, primaryContact: true };

describe('unitsRepo.assignPrimaryIfCurrent - an error that is not a lost condition', () => {
  it('is thrown, never reported as skipped', async () => {
    const failing = {
      send: async () => {
        throw new Error('throttled');
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = createUnitsRepo({
      doc: failing,
      env: { TABLE_PREFIX: 'hc-test-unreachable-' },
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const read = { unitId: 'u-1', status: 'setup', contacts: [MARK] } as unknown as UnitItem;
    await expect(
      repo.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).rejects.toThrow('throttled');
  });
});

describe.skipIf(!reachable)('unitsRepo.assignPrimaryIfCurrent against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });
  const table = (): string => tableName('units', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), table());
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table());
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** An OWNERLESS unit - no landlordId attribute, the imported shape - read back consistently. */
  async function ownerless(contacts: UnitContact[]): Promise<UnitItem> {
    const created = await units.create({ status: 'setup', contacts } as unknown as CreateUnitInput);
    const read = await units.getById(created.unitId, { consistentRead: true });
    if (read === undefined) throw new Error('the unit just created is missing');
    return read;
  }

  async function stored(unitId: string): Promise<UnitItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table(), Key: { unitId }, ConsistentRead: true }));
    return Item as UnitItem | undefined;
  }

  /** A repo that counts the UpdateCommands it sends for `unitId`. */
  function countingRepo(unitId: string) {
    const counter = { writes: 0 };
    const countingDoc = Object.create(doc) as typeof doc;
    countingDoc.send = (async (command: Parameters<typeof doc.send>[0]) => {
      if (command instanceof UpdateCommand && command.input.Key?.['unitId'] === unitId) counter.writes += 1;
      return doc.send(command);
    }) as typeof doc.send;
    return { repo: createUnitsRepo({ doc: countingDoc, env: testEnv, logger }), counter };
  }

  it('writes the contact list and the scalar while landlordId and contacts are as read', async () => {
    const read = await ownerless([MARK]);
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('written');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK_PRIMARY]);
    expect(after?.primary_contact).toBe('c-mark');
    expect(after !== undefined && Object.prototype.hasOwnProperty.call(after, 'landlordId')).toBe(false);
  });

  it('aligns the scalar alone when the contact list is written back unchanged', async () => {
    const read = await ownerless([MARK_PRIMARY]);
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('written');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK_PRIMARY]);
    expect(after?.primary_contact).toBe('c-mark');
  });

  it('skips after ONE attempt - nothing written - when the contact list changed after the read', async () => {
    const read = await ownerless([MARK]);
    // Staff added the owner as the primary contact after the script read the unit.
    const concurrent: UnitContact[] = [MARK, { contactId: 'c-owner', role: 'owner', primaryContact: true }];
    await doc.send(
      new UpdateCommand({
        TableName: table(),
        Key: { unitId: read.unitId },
        UpdateExpression: 'SET #c = :c, #p = :p',
        ExpressionAttributeNames: { '#c': 'contacts', '#p': 'primary_contact' },
        ExpressionAttributeValues: { ':c': concurrent, ':p': 'c-owner' },
      }),
    );
    const { repo, counter } = countingRepo(read.unitId);
    expect(
      await repo.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    expect(counter.writes).toBe(1);
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual(concurrent);
    expect(after?.primary_contact).toBe('c-owner');
  });

  it('skips when a landlord of record was set after the read', async () => {
    const read = await ownerless([MARK]);
    await doc.send(
      new UpdateCommand({
        TableName: table(),
        Key: { unitId: read.unitId },
        UpdateExpression: 'SET #l = :l',
        ExpressionAttributeNames: { '#l': 'landlordId' },
        ExpressionAttributeValues: { ':l': 'c-claim' },
      }),
    );
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    const after = await stored(read.unitId);
    expect(after?.contacts).toEqual([MARK]);
    expect(after?.primary_contact).toBeUndefined();
  });

  it('skips a unit that no longer exists, and creates nothing', async () => {
    const read = { unitId: `u-gone-${randomUUID()}`, status: 'setup', contacts: [MARK] } as unknown as UnitItem;
    expect(
      await units.assignPrimaryIfCurrent(read, { contacts: [MARK_PRIMARY], primaryContact: 'c-mark' }),
    ).toBe('skipped');
    expect(await stored(read.unitId)).toBeUndefined();
  });
});
```

2. Run it RED (DynamoDB Local must be up: `cd "W:/tmp/primary-contact-integrity" && npm run db:start` - a no-op when it already runs; never stop or restart the shared container):

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/unitsRepoAssignPrimary.integration.test.ts
```

Expected RED: `Test Files  1 failed (1)`, every case failing with
`TypeError: units.assignPrimaryIfCurrent is not a function` (the first case:
`repo.assignPrimaryIfCurrent is not a function`). If the summary says
`skipped`, DynamoDB Local is not reachable - start it and re-run.

3. Implement.

3a. `app/src/repos/unitsRepo.ts`, the interface. Edit old_string:

```ts
  rewriteAcceptedAuthorities(
    unitId: string,
    expected: string[] | null,
    next: string[],
  ): Promise<'written' | 'skipped'>;
```

new_string:

```ts
  rewriteAcceptedAuthorities(
    unitId: string,
    expected: string[] | null,
    next: string[],
  ): Promise<'written' | 'skipped'>;
  /**
   * primary-contact-integrity (spec section 8; plan C12): the ONE-TIME
   * assign-primary-contacts script's write. Sets `contacts` to
   * `next.contacts` and the `primary_contact` scalar to `next.primaryContact`
   * ONLY while the unit's landlordId AND contacts[] are still exactly what the
   * caller read - `unit` IS that read (the updateRosterIfCurrent guard; a
   * missing unit fails it too). ONE attempt: no re-read and no retry, so a
   * primary someone set after the read is never overwritten - a lost
   * condition answers 'skipped' (the script counts it skippedOnCondition and
   * leaves the unit for a re-run). Any other error is thrown. Stamps
   * updated_at like every roster write: every unit the script writes has a
   * stored contact list, which in dev and prod only roster writes create, and
   * each of those stamps it - so the importer's ownership line never moves.
   */
  assignPrimaryIfCurrent(
    unit: UnitItem,
    next: { contacts: UnitContact[]; primaryContact: string },
  ): Promise<'written' | 'skipped'>;
```

3b. `app/src/repos/unitsRepo.ts`, the implementation. Edit old_string:

```ts
      log.info({ unitId, members: next.length }, 'unit accepted authorities rewritten');
      return 'written';
    },
```

new_string:

```ts
      log.info({ unitId, members: next.length }, 'unit accepted authorities rewritten');
      return 'written';
    },

    async assignPrimaryIfCurrent(unit, next) {
      try {
        await updateRosterIfCurrent(unit, {
          contacts: next.contacts,
          primary_contact: next.primaryContact,
        });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'skipped';
        throw err;
      }
      log.info(
        { unitId: unit.unitId, primaryContact: next.primaryContact, rosterSize: next.contacts.length },
        'unit primary contact assigned (script)',
      );
      return 'written';
    },
```

3c. `app/test/helpers/twilioWebhookHarness.ts`, the fake (typed `UnitsRepo`,
so it must implement the new member). Edit old_string:

```ts
      unit.accepted_authorities = [...next];
      return 'written';
    },
```

new_string:

```ts
      unit.accepted_authorities = [...next];
      return 'written';
    },
    // primary-contact-integrity (plan S5.1): the one-time script's write - the
    // real repo's updateRosterIfCurrent guard (landlordId AND contacts[] as the
    // caller read them; a missing unit fails it), ONE attempt, no re-read.
    async assignPrimaryIfCurrent(read, next) {
      const unit = units.get(read.unitId);
      if (!unit || unit.landlordId !== read.landlordId || !isDeepStrictEqual(unit.contacts, read.contacts)) {
        return 'skipped';
      }
      unit.contacts = next.contacts.map((c) => ({ ...c }));
      unit.primary_contact = next.primaryContact;
      unit.updated_at = new Date().toISOString();
      return 'written';
    },
```

(`isDeepStrictEqual` is already imported at the top of the harness from
`node:util`.)

4. Run GREEN:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/unitsRepoAssignPrimary.integration.test.ts
```

Expected: `Test Files  1 passed (1)` and `Tests  6 passed (6)`. Then:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npm run typecheck
```

Expected: exit 0, no `error TS` line.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: on `feat/primary-contact-integrity`, no merge in progress, and the
only changes are the three files of this task.

```bash
git -C "W:/tmp/primary-contact-integrity" add app/src/repos/unitsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsRepoAssignPrimary.integration.test.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "feat(units): assignPrimaryIfCurrent - the one-time primary script's conditional write (no re-read, no retry)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.2 - assign-primary-contacts: the pure per-unit planner

**Files:**
- Create: `app/scripts/assign-primary-contacts.ts`
- Create: `app/test/assignPrimaryContacts.plan.test.ts`

**Steps:**

1. Write the failing test - create `app/test/assignPrimaryContacts.plan.test.ts`:

```ts
// assign-primary-contacts (spec 2026-10-12 primary-contact-integrity, section
// 8; plan C12, task S5.2): the PURE per-unit planner. WHO takes over always
// comes from the shared heir function (lib/propertyContact.ts chooseHeir and
// applyPrimary) - these tests pin that the script asks it the right question
// and maps its answer to the right outcome, never a rule of its own.
import { describe, expect, it } from 'vitest';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem } from '../src/repos/unitsRepo.js';
import { planUnitPrimary, type UnitPrimaryPlan } from '../scripts/assign-primary-contacts.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';

const landlord = (contactId: string, extra: Partial<ContactItem> = {}): ContactItem => ({
  contactId,
  type: 'landlord',
  status: 'active',
  ...extra,
});
const tenant = (contactId: string): ContactItem => ({ contactId, type: 'tenant', status: 'searching' });
const caseworker = (contactId: string): ContactItem => ({
  contactId,
  type: 'partner',
  status: 'active',
  role: 'Caseworker',
});
const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
const unitOf = (fields: Partial<UnitItem>): UnitItem => ({ unitId: 'u-1', status: 'available', ...fields }) as UnitItem;
const readOf = (...contacts: ContactItem[]): RosterContactsRead => ({
  ok: true,
  byId: new Map(contacts.map((c) => [c.contactId, c])),
});

function asTarget(plan: UnitPrimaryPlan): Extract<UnitPrimaryPlan, { kind: 'target' }> {
  if (plan.kind !== 'target') throw new Error(`expected a target, got ${plan.kind}`);
  return plan;
}
const flaggedIds = (contacts: UnitContact[]): string[] =>
  contacts.filter((c) => c.primaryContact).map((c) => c.contactId);

describe('planUnitPrimary - targets (spec section 8)', () => {
  it('470 Bolton: no primary, no landlord of record, one live landlord-typed contact -> that contact', () => {
    const plan = asTarget(planUnitPrimary(unitOf({ contacts: [row('c-mark', 'pm')] }), readOf(landlord('c-mark'))));
    expect(plan.heirId).toBe('c-mark');
    expect(plan.from).toBeUndefined();
    expect(plan.write).toEqual({ contacts: [row('c-mark', 'pm', true)], primaryContact: 'c-mark' });
  });

  it('a DELETED flagged primary next to a live landlord of record -> the landlord; from names the deleted contact', () => {
    const unit = unitOf({
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord'), row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    });
    const plan = asTarget(
      planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-gone', { deleted_at: DELETED_AT }))),
    );
    expect(plan.heirId).toBe('c-owner');
    expect(plan.from).toBe('c-gone');
    expect(plan.write).toEqual({
      contacts: [row('c-owner', 'landlord', true), row('c-gone', 'pm')],
      primaryContact: 'c-owner',
    });
  });

  it('a MISSING flagged primary (hard-deleted by an import retraction) counts as not live', () => {
    const unit = unitOf({ contacts: [row('c-retracted', 'pm', true), row('c-pm', 'owner')] });
    const plan = asTarget(planUnitPrimary(unit, readOf(landlord('c-pm'))));
    expect(plan.heirId).toBe('c-pm');
    expect(plan.from).toBe('c-retracted');
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-pm']);
  });

  it('no landlord: the EARLIEST-added eligible contact - a deleted one, a tenant and a caseworker before it are skipped', () => {
    const unit = unitOf({
      contacts: [
        row('c-gone', 'pm', true),
        row('c-ten', 'other'),
        row('c-cw', 'other'),
        row('c-first', 'owner'),
        row('c-second', 'pm'),
      ],
    });
    const plan = asTarget(
      planUnitPrimary(
        unit,
        readOf(
          landlord('c-gone', { deleted_at: DELETED_AT }),
          tenant('c-ten'),
          caseworker('c-cw'),
          landlord('c-first'),
          landlord('c-second'),
        ),
      ),
    );
    expect(plan.heirId).toBe('c-first');
    expect(plan.from).toBe('c-gone');
    expect(plan.write.contacts.map((c) => c.contactId)).toEqual(['c-gone', 'c-ten', 'c-cw', 'c-first', 'c-second']);
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-first']);
  });

  it('an OFF-ROSTER landlord of record and no flagged row -> the landlord, who gains a landlord row', () => {
    const unit = unitOf({ landlordId: 'c-owner', contacts: [row('c-pm', 'pm')] });
    const plan = asTarget(planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-pm'))));
    expect(plan.heirId).toBe('c-owner');
    expect(plan.write.primaryContact).toBe('c-owner');
    expect(plan.write.contacts).toHaveLength(2);
    expect(plan.write.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-owner', role: 'landlord', primaryContact: true }),
    );
    expect(plan.write.contacts).toContainEqual(row('c-pm', 'pm'));
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-owner']);
  });

  it('a soft-deleted UNIT is planned like a live one (the script reads them all)', () => {
    const unit = unitOf({ contacts: [row('c-mark', 'pm')], deleted_at: DELETED_AT });
    expect(asTarget(planUnitPrimary(unit, readOf(landlord('c-mark')))).heirId).toBe('c-mark');
  });
});

describe('planUnitPrimary - a live primary stays; only the scalar may be aligned', () => {
  it('a live flagged primary whose scalar is absent or names someone else -> align, the contact list unchanged', () => {
    for (const scalar of [undefined, 'c-old']) {
      const contacts = [row('c-owner', 'landlord'), row('c-pm', 'pm', true)];
      const unit = unitOf({
        landlordId: 'c-owner',
        contacts,
        ...(scalar !== undefined && { primary_contact: scalar }),
      });
      expect(planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-pm')))).toEqual({
        kind: 'align',
        write: { contacts, primaryContact: 'c-pm' },
      });
    }
  });

  it('a live flagged primary whose scalar agrees -> unchanged', () => {
    const unit = unitOf({ contacts: [row('c-pm', 'pm', true)], primary_contact: 'c-pm' });
    expect(planUnitPrimary(unit, readOf(landlord('c-pm')))).toEqual({ kind: 'unchanged' });
  });

  it('a landlord-only unit (no stored contact list: the DERIVED landlord row is primary) is left alone, whatever its scalar', () => {
    const unit = unitOf({ landlordId: 'c-owner', primary_contact: 'c-someone' });
    expect(planUnitPrimary(unit, readOf(landlord('c-owner')))).toEqual({ kind: 'unchanged' });
  });

  it('a live flagged primary that is NOT eligible (a tenant made primary by hand) is not replaced', () => {
    const unit = unitOf({ contacts: [row('c-ten', 'other', true), row('c-pm', 'pm')], primary_contact: 'c-ten' });
    expect(planUnitPrimary(unit, readOf(tenant('c-ten'), landlord('c-pm')))).toEqual({ kind: 'unchanged' });
  });
});

describe('planUnitPrimary - counted, never written', () => {
  it('noHeir: no live contact and no live landlord of record', () => {
    const gone = landlord('c-gone', { deleted_at: DELETED_AT });
    // A deleted sole primary...
    expect(
      planUnitPrimary(unitOf({ contacts: [row('c-gone', 'pm', true)], primary_contact: 'c-gone' }), readOf(gone)),
    ).toEqual({ kind: 'noHeir' });
    // ...a landlord-only unit whose landlord of record is deleted...
    expect(planUnitPrimary(unitOf({ landlordId: 'c-gone' }), readOf(gone))).toEqual({ kind: 'noHeir' });
    // ...and an ownerless unit with no contacts at all.
    expect(planUnitPrimary(unitOf({}), readOf())).toEqual({ kind: 'noHeir' });
  });

  it('noEligible: live contacts exist, but only a tenant and a caseworker', () => {
    const unit = unitOf({ contacts: [row('c-ten', 'other'), row('c-cw', 'other')] });
    expect(planUnitPrimary(unit, readOf(tenant('c-ten'), caseworker('c-cw')))).toEqual({ kind: 'noEligible' });
  });

  it('unknown: the contact read failed - even for a unit that would otherwise be fine', () => {
    expect(planUnitPrimary(unitOf({ contacts: [row('c-mark', 'pm')] }), { ok: false })).toEqual({ kind: 'unknown' });
    expect(planUnitPrimary(unitOf({ landlordId: 'c-owner' }), { ok: false })).toEqual({ kind: 'unknown' });
  });
});
```

2. Run RED:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.plan.test.ts
```

Expected RED: `Test Files  1 failed (1)` with
`Failed to load url ../scripts/assign-primary-contacts.js` (or
`Cannot find module '../scripts/assign-primary-contacts.js'`).

3. Implement - create `app/scripts/assign-primary-contacts.ts`:

```ts
// assign-primary-contacts - the ONE-TIME repair of the properties whose
// primary contact is missing or deleted (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 8; plan constraint C12). From this branch on, every write keeps the
// primary pointing at a usable person (spec section 4); this pass repairs the
// properties already in the broken state - 470 Bolton's shape: no primary
// contact, no landlord of record, one live contact added as Property Manager.
//
// READS every unit (live AND soft-deleted) with a consistent Scan
// (unitsRepo.list, deleted 'any', consistentRead), and per unit ONE complete
// batch read of the contacts its contact list and landlord of record name
// (readRosterContacts: requireComplete; ANY throw = liveness unknown, never
// "deleted" - spec 4.2).
//
// PER UNIT (planUnitPrimary, pure):
//   - TARGET: its flagged primary (unitContacts()) is absent or not live AND
//     the heir function (chooseHeir, nothing excluded) names an heir. The
//     write flags exactly the heir (adding the landlord's row when the heir is
//     an off-roster landlord of record - applyPrimary) and sets the
//     primary_contact scalar to it; then ONE unit_primary_contact_assigned
//     audit event { contactId, reason: 'backfill', from? } with no actor
//     (from = the flagged contact it replaces, when there was one).
//   - ALIGN (counted scalarAligned): its flagged primary is live and stored,
//     but the scalar is absent or names someone else. The write sets the
//     scalar (the contact list goes back unchanged); no audit event - the
//     primary did not change. A landlord-only unit (no stored contact list:
//     its primary is the DERIVED landlord row) is left alone.
//   - COUNTED, never written: noHeir (no live contact and no live landlord of
//     record), noEligible (live contacts, none eligible for automatic routing
//     - only a tenant or a caseworker; listed by unit id so Sam can choose on
//     the property page), unknown (the contact read failed - re-run),
//     unchanged (nothing to do).
//
// NO LOCK (spec section 8): every write is unitsRepo.assignPrimaryIfCurrent,
// conditional on the contact list AND landlordId THIS run read - never
// addContact, which re-reads and would overwrite a primary set meanwhile. A
// unit changed since the read is counted skippedOnCondition and left for a
// re-run. Idempotent: a completed apply plans nothing on a re-run.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). An agent
// runs this ONLY with --env local --lane <L> against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK, after that environment's deploy.
//
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev
//   npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply
//
// Exit codes: 0 the run completed (units skipped on their condition included
// - re-run for them); 1 it completed with failures (a unit whose contact read
// failed, or a write that failed), aborted (the Scan failed: a PARTIAL
// report), or the target could not be resolved (nothing read); 2 usage.
//
// PII: prints and logs counts, unit ids and contact ids only - never a
// person's name, a phone or a street.
import { applyPrimary, chooseHeir, type RosterContactsRead } from '../src/lib/propertyContact.js';
import { isDeleted as isContactDeleted } from '../src/repos/contactsRepo.js';
import { unitContacts, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';

// ---------------------------------------------------------------------------
// Planning (pure): what one unit needs
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'assign-primary-contacts';

/** The audit event each primary assignment appends (plan contract 2.4). */
export const PRIMARY_ASSIGNED_EVENT = 'unit_primary_contact_assigned';

/** One unit's conditional write: its whole contact list and the scalar. */
export interface PrimaryWrite {
  contacts: UnitContact[];
  primaryContact: string;
}

/**
 * What one unit needs (spec section 8). `target`: its primary is absent or
 * not live and the heir function named an heir (`from` = the flagged contact
 * it replaces, when there was one). `align`: its live, stored primary does
 * not match the scalar. The rest are counted only.
 */
export type UnitPrimaryPlan =
  | { kind: 'target'; heirId: string; from?: string; write: PrimaryWrite }
  | { kind: 'align'; write: PrimaryWrite }
  | { kind: 'noHeir' }
  | { kind: 'noEligible' }
  | { kind: 'unknown' }
  | { kind: 'unchanged' };

/** The landlord of record as the repos read it: a non-empty string, else none. */
function landlordOf(unit: Pick<UnitItem, 'landlordId'>): string | undefined {
  return typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
}

/** Live (spec section 3): the complete read returned the contact and it is not soft-deleted. */
function isLive(read: Extract<RosterContactsRead, { ok: true }>, contactId: string): boolean {
  const contact = read.byId.get(contactId);
  return contact !== undefined && !isContactDeleted(contact);
}

/**
 * ONE unit's plan, from the unit as the Scan read it and the complete contact
 * read of its contact list + landlord of record. WHO takes over is never
 * decided here: chooseHeir answers it (nothing excluded - this run deleted
 * nobody) and applyPrimary builds the contact list - the same two functions
 * every app write uses (spec 4.3).
 */
export function planUnitPrimary(unit: UnitItem, read: RosterContactsRead): UnitPrimaryPlan {
  // A failed read decides nothing, and is never read as "deleted" (spec 4.2).
  if (!read.ok) return { kind: 'unknown' };
  const roster = unitContacts(unit);
  const flagged = roster.find((row) => row.primaryContact === true);
  if (flagged !== undefined && isLive(read, flagged.contactId)) {
    // A live primary stays. Only the scalar may need aligning - and only on a
    // STORED contact list: a landlord-only unit's primary is the derived
    // landlord row, which has no stored scalar to agree with (spec section 8).
    const stored = Array.isArray(unit.contacts) && unit.contacts.length > 0;
    if (stored && unit.primary_contact !== flagged.contactId) {
      return {
        kind: 'align',
        write: { contacts: roster.map((row) => ({ ...row })), primaryContact: flagged.contactId },
      };
    }
    return { kind: 'unchanged' };
  }
  const heir = chooseHeir({ roster, landlordId: landlordOf(unit), read });
  if (heir.kind === 'unknown') return { kind: 'unknown' };
  if (heir.kind === 'none') return { kind: heir.why === 'no_eligible_candidate' ? 'noEligible' : 'noHeir' };
  const applied = applyPrimary(roster, { contactId: heir.contactId, addLandlordRow: heir.addLandlordRow });
  return {
    kind: 'target',
    heirId: heir.contactId,
    ...(flagged !== undefined && { from: flagged.contactId }),
    write: { contacts: applied.contacts, primaryContact: heir.contactId },
  };
}
```

4. Run GREEN:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.plan.test.ts
```

Expected: `Test Files  1 passed (1)` and `Tests  13 passed (13)`. A failure
here that names `chooseHeir` / `applyPrimary` output (an order, a row shape) is
an S1 contract mismatch - stop and report it; never add a twin rule here.
Then:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npm run typecheck
```

Expected: exit 0.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `app/scripts/assign-primary-contacts.ts` and
`app/test/assignPrimaryContacts.plan.test.ts` (both new), no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add app/scripts/assign-primary-contacts.ts app/test/assignPrimaryContacts.plan.test.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "feat(scripts): assign-primary-contacts planner - targets, scalar alignment and counts from the shared heir function" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.3 - assign-primary-contacts: the run, counts, report and summary

**Files:**
- Modify: `app/scripts/assign-primary-contacts.ts`
- Create: `app/test/assignPrimaryContacts.run.test.ts`

**Steps:**

1. Write the failing test - create `app/test/assignPrimaryContacts.run.test.ts`:

```ts
// assign-primary-contacts (spec 2026-10-12 primary-contact-integrity, section
// 8; plan C12, task S5.3): the run against FAKE repos. A dry run counts and
// lists every outcome and writes nothing; an apply makes ONE conditional
// write per changed unit and appends one backfill audit event per assigned
// primary (none for a scalar alignment); a unit changed after the read is
// skipped and never overwritten; a failed contact read - in both shapes - is
// `unknown`, never "deleted"; a re-run plans nothing; and nothing it logs or
// prints names a person.
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem, type ContactsRepo } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem, UnitsRepo } from '../src/repos/unitsRepo.js';
import {
  assignPrimaryContacts,
  formatAssignSummary,
  PRIMARY_ASSIGNED_EVENT,
  reportAssignRun,
  type AssignDeps,
  type AssignResult,
} from '../scripts/assign-primary-contacts.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';

/** Names in the world below: none may reach a log line or the printed summary. */
const NAMES = ['Mark', 'Passmore', 'Olive', 'Gina', 'Tara', 'Paul'];

const CONTACTS: ContactItem[] = [
  { contactId: 'c-mark', type: 'landlord', status: 'active', firstName: 'Mark', lastName: 'Passmore' },
  { contactId: 'c-owner', type: 'landlord', status: 'active', firstName: 'Olive', lastName: 'Owner' },
  {
    contactId: 'c-gone',
    type: 'landlord',
    status: 'active',
    firstName: 'Gina',
    lastName: 'Gone',
    deleted_at: DELETED_AT,
  },
  { contactId: 'c-ten', type: 'tenant', status: 'searching', firstName: 'Tara', lastName: 'Tenant' },
  { contactId: 'c-pm', type: 'landlord', status: 'active', firstName: 'Paul', lastName: 'Manager' },
];

const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
const unit = (unitId: string, fields: Partial<UnitItem>): UnitItem =>
  ({ unitId, status: 'available', ...fields }) as UnitItem;

/** One unit per outcome, in Scan order. */
function world(): UnitItem[] {
  return [
    // 470 Bolton: no primary, no landlord of record, one live landlord-typed contact.
    unit('u-bolton', { contacts: [row('c-mark', 'pm')] }),
    // A deleted primary next to a live landlord of record.
    unit('u-deleted-primary', {
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord'), row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    }),
    // A soft-deleted PROPERTY in the 470 Bolton shape: read and repaired too.
    unit('u-soft-deleted', { contacts: [row('c-pm', 'pm')], deleted_at: DELETED_AT }),
    // A live flagged primary whose scalar was never written.
    unit('u-stale-scalar', { contacts: [row('c-pm', 'pm', true)] }),
    // Only a tenant on the list: nobody eligible - Sam chooses.
    unit('u-only-tenant', { contacts: [row('c-ten', 'other')] }),
    // A deleted sole contact: nobody can take over.
    unit('u-nobody', { contacts: [row('c-gone', 'pm', true)], primary_contact: 'c-gone' }),
    // A landlord-only unit: fine as it is.
    unit('u-fine', { landlordId: 'c-owner' }),
  ];
}

interface FakeUnits extends Pick<UnitsRepo, 'list' | 'assignPrimaryIfCurrent'> {
  stored: Map<string, UnitItem>;
  writes: string[];
}

interface FakeUnitHooks {
  /** Runs before each write attempt - a concurrent change lands here. */
  beforeWrite?: (unitId: string, stored: Map<string, UnitItem>) => void;
  /** Units whose write fails with an error that is not a lost condition. */
  failWrite?: ReadonlySet<string>;
  /** The Scan itself fails. */
  failList?: boolean;
}

function fakeUnits(units: UnitItem[], hooks: FakeUnitHooks = {}): FakeUnits {
  const stored = new Map(units.map((u) => [u.unitId, structuredClone(u)] as const));
  const writes: string[] = [];
  return {
    stored,
    writes,
    async list(opts = {}) {
      if (hooks.failList === true) throw new Error('scan failed');
      // The run must read EVERY unit, consistently (spec section 8).
      expect(opts.deleted).toBe('any');
      expect(opts.consistentRead).toBe(true);
      const all = [...stored.values()];
      const cursor = opts.exclusiveStartKey?.['unitId'];
      const start = typeof cursor === 'string' ? all.findIndex((u) => u.unitId === cursor) + 1 : 0;
      const window = opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
      const last = window[window.length - 1];
      const more = opts.limit !== undefined && start + opts.limit < all.length;
      return {
        items: window.map((u) => structuredClone(u)),
        ...(more && last !== undefined && { lastEvaluatedKey: { unitId: last.unitId } }),
      };
    },
    async assignPrimaryIfCurrent(read, next) {
      hooks.beforeWrite?.(read.unitId, stored);
      if (hooks.failWrite?.has(read.unitId) === true) throw new Error('throttled');
      const current = stored.get(read.unitId);
      // The real guard: landlordId AND contacts[] exactly as read.
      if (
        current === undefined ||
        current.landlordId !== read.landlordId ||
        !isDeepStrictEqual(current.contacts, read.contacts)
      ) {
        return 'skipped';
      }
      current.contacts = structuredClone(next.contacts);
      current.primary_contact = next.primaryContact;
      writes.push(read.unitId);
      return 'written';
    },
  };
}

function fakeContacts(failures: ReadonlyMap<string, Error> = new Map()) {
  const byId = new Map(CONTACTS.map((c) => [c.contactId, c] as const));
  const calls: Array<{ ids: string[]; requireComplete: boolean }> = [];
  const repo: Pick<ContactsRepo, 'getManyByIds'> = {
    async getManyByIds(ids, opts) {
      calls.push({ ids: [...ids], requireComplete: opts?.requireComplete === true });
      for (const id of ids) {
        const failure = failures.get(id);
        if (failure !== undefined) throw failure;
      }
      const found = new Map<string, ContactItem>();
      for (const id of ids) {
        const contact = byId.get(id);
        if (contact !== undefined) found.set(id, contact);
      }
      return found;
    },
  };
  return { repo, calls };
}

function fakeAudit(fail = false) {
  const events: Array<{ entityKey: string; eventType: string; payload: Record<string, unknown> | undefined }> = [];
  const repo: AssignDeps['audit'] = {
    async append(entityKey, eventType, payload) {
      if (fail) throw new Error('audit unavailable');
      events.push({ entityKey, eventType, payload });
    },
  };
  return { repo, events };
}

function harness(opts: { units?: FakeUnits; failures?: ReadonlyMap<string, Error>; auditFails?: boolean } = {}) {
  const units = opts.units ?? fakeUnits(world());
  const contacts = fakeContacts(opts.failures);
  const audit = fakeAudit(opts.auditFails === true);
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const deps: AssignDeps = { units, contacts: contacts.repo, audit: audit.repo };
  return { units, contacts, audit, capture, logger, deps };
}

/** What a dry run over world() reports. */
const DRY_RESULT: AssignResult = {
  unitsScanned: 7,
  deletedUnits: 1,
  targets: 3,
  targetsOnDeletedUnits: 1,
  assigned: 0,
  scalarAligned: 1,
  skippedOnCondition: 0,
  writeFailed: 0,
  noHeir: 1,
  noEligible: 1,
  unknown: 0,
  unchanged: 1,
  auditFailed: 0,
  targetUnitIds: ['u-bolton', 'u-deleted-primary', 'u-soft-deleted'],
  alignedUnitIds: ['u-stale-scalar'],
  noEligibleUnitIds: ['u-only-tenant'],
  unknownUnitIds: [],
  skippedUnitIds: [],
  failedUnitIds: [],
};

describe('assignPrimaryContacts - dry run', () => {
  it('counts and lists every outcome and writes NOTHING', async () => {
    const h = harness();
    const before = structuredClone([...h.units.stored.values()]);
    const result = await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger });
    expect(result).toEqual(DRY_RESULT);
    expect(h.units.writes).toEqual([]);
    expect([...h.units.stored.values()]).toEqual(before);
    expect(h.audit.events).toEqual([]);
    // ONE complete contact read per unit (spec 4.2: requireComplete).
    expect(h.contacts.calls).toHaveLength(7);
    expect(h.contacts.calls.every((c) => c.requireComplete)).toBe(true);
    expect(reportAssignRun(result, false, h.logger)).toBe(0);
  });

  it('pages through the Scan: two units a page reaches the same result', async () => {
    const h = harness();
    expect(await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger, scanLimit: 2 })).toEqual(DRY_RESULT);
  });
});

describe('assignPrimaryContacts - apply', () => {
  it('assigns each target its heir in ONE conditional write with one backfill audit event, and aligns the scalar with none', async () => {
    const h = harness();
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toEqual({ ...DRY_RESULT, assigned: 3 });
    expect(h.units.writes).toEqual(['u-bolton', 'u-deleted-primary', 'u-soft-deleted', 'u-stale-scalar']);
    expect(h.units.stored.get('u-bolton')).toMatchObject({
      contacts: [row('c-mark', 'pm', true)],
      primary_contact: 'c-mark',
    });
    expect(h.units.stored.get('u-deleted-primary')).toMatchObject({
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord', true), row('c-gone', 'pm')],
      primary_contact: 'c-owner',
    });
    expect(h.units.stored.get('u-soft-deleted')).toMatchObject({
      contacts: [row('c-pm', 'pm', true)],
      primary_contact: 'c-pm',
      deleted_at: DELETED_AT,
    });
    expect(h.units.stored.get('u-stale-scalar')).toMatchObject({
      contacts: [row('c-pm', 'pm', true)],
      primary_contact: 'c-pm',
    });
    // Counted only - never written.
    expect(h.units.stored.get('u-only-tenant')?.primary_contact).toBeUndefined();
    expect(h.units.stored.get('u-nobody')).toMatchObject({
      contacts: [row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    });
    expect(PRIMARY_ASSIGNED_EVENT).toBe('unit_primary_contact_assigned');
    expect(h.audit.events).toEqual([
      {
        entityKey: 'units#u-bolton',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-mark', reason: 'backfill' },
      },
      {
        entityKey: 'units#u-deleted-primary',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-owner', reason: 'backfill', from: 'c-gone' },
      },
      {
        entityKey: 'units#u-soft-deleted',
        eventType: PRIMARY_ASSIGNED_EVENT,
        payload: { contactId: 'c-pm', reason: 'backfill' },
      },
    ]);
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
  });

  it('is idempotent: a re-run of a completed apply plans nothing and writes nothing', async () => {
    const h = harness();
    await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    const writes = h.units.writes.length;
    const events = h.audit.events.length;
    const again = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(again).toMatchObject({
      targets: 0,
      assigned: 0,
      scalarAligned: 0,
      unchanged: 5,
      noHeir: 1,
      noEligible: 1,
      unknown: 0,
    });
    expect(h.units.writes).toHaveLength(writes);
    expect(h.audit.events).toHaveLength(events);
  });

  it('a unit changed after the read is SKIPPED - never overwritten, no audit event - and left for a re-run', async () => {
    const units = fakeUnits(world(), {
      beforeWrite(unitId, stored) {
        if (unitId !== 'u-bolton') return;
        // Staff added the owner as the primary contact after the Scan read the unit.
        const current = stored.get('u-bolton');
        if (current !== undefined) {
          current.contacts = [row('c-mark', 'pm'), row('c-owner', 'owner', true)];
          current.primary_contact = 'c-owner';
        }
      },
    });
    const h = harness({ units });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ targets: 3, assigned: 2, skippedOnCondition: 1, skippedUnitIds: ['u-bolton'] });
    expect(units.stored.get('u-bolton')).toMatchObject({
      contacts: [row('c-mark', 'pm'), row('c-owner', 'owner', true)],
      primary_contact: 'c-owner',
    });
    expect(h.audit.events.some((e) => e.entityKey === 'units#u-bolton')).toBe(false);
    // Exit 0 - but at WARN, so a level filter shows it.
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, skippedOnCondition: 1 });
  });

  it('a failed contact read is UNKNOWN in BOTH shapes - never "deleted": nothing written for that unit, exit 1', async () => {
    const h = harness({
      failures: new Map<string, Error>([
        ['c-mark', new Error('ProvisionedThroughputExceededException')],
        ['c-ten', new IncompleteBatchReadError(1, 1)],
      ]),
    });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({
      unknown: 2,
      unknownUnitIds: ['u-bolton', 'u-only-tenant'],
      targets: 2,
      assigned: 2,
      noEligible: 0,
    });
    expect(h.units.writes).not.toContain('u-bolton');
    expect(reportAssignRun(result, true, h.logger)).toBe(1);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, unknown: 2 });
    expect(String(h.capture.lines.at(-1)?.['msg'])).toContain('COMPLETED WITH FAILURES');
  });

  it('a write that fails (not a lost condition) is counted and the run goes on; exit 1', async () => {
    const units = fakeUnits(world(), { failWrite: new Set(['u-bolton']) });
    const h = harness({ units });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ writeFailed: 1, failedUnitIds: ['u-bolton'], assigned: 2, scalarAligned: 1 });
    expect(h.audit.events.some((e) => e.entityKey === 'units#u-bolton')).toBe(false);
    expect(h.capture.atLevel(50).some((l) => l['unitId'] === 'u-bolton')).toBe(true);
    expect(reportAssignRun(result, true, h.logger)).toBe(1);
  });

  it('an audit append that fails after the write landed is counted, never thrown; exit 0 at WARN', async () => {
    const h = harness({ auditFails: true });
    const result = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    expect(result).toMatchObject({ assigned: 3, auditFailed: 3 });
    expect(reportAssignRun(result, true, h.logger)).toBe(0);
    expect(h.capture.lines.at(-1)).toMatchObject({ level: 40, auditFailed: 3 });
  });

  it('a Scan failure ABORTS with a PARTIAL report and rethrows', async () => {
    const h = harness({ units: fakeUnits(world(), { failList: true }) });
    await expect(assignPrimaryContacts(h.deps, { apply: true, logger: h.logger })).rejects.toThrow('scan failed');
    const partial = h.capture.atLevel(50).find((l) => String(l['msg']).includes('PARTIAL'));
    expect(partial).toMatchObject({ unitsScanned: 0, apply: true });
  });
});

describe('assignPrimaryContacts - what it prints and logs', () => {
  it('prints counts and unit ids only - never a name - and so do its log lines', async () => {
    const h = harness();
    const dry = await assignPrimaryContacts(h.deps, { apply: false, logger: h.logger });
    const dryLines = formatAssignSummary(dry, false);
    expect(dryLines[0]).toBe('Primary contacts - DRY RUN, nothing written:');
    expect(dryLines).toContain('  Would get a primary contact: 3 (1 on soft-deleted properties)');
    expect(dryLines).toContain('Properties that would get a primary contact: u-bolton, u-deleted-primary, u-soft-deleted');
    expect(dryLines).toContain(
      'Properties with no eligible contact (open each one and choose a primary contact): u-only-tenant',
    );
    expect(dryLines).toContain('Properties that could not be decided (re-run): none');
    const applied = await assignPrimaryContacts(h.deps, { apply: true, logger: h.logger });
    const appliedLines = formatAssignSummary(applied, true);
    expect(appliedLines[0]).toBe('Primary contacts - APPLIED:');
    expect(appliedLines).toContain('  Primary contacts assigned: 3');
    expect(appliedLines).toContain('Properties whose write failed: none');
    // pino stamps the machine's hostname on every line - not ours to check.
    const logged = h.capture.lines.map(({ hostname: _hostname, ...line }) => line);
    const everything = JSON.stringify(logged) + dryLines.join('\n') + appliedLines.join('\n');
    for (const name of NAMES) expect(everything).not.toContain(name);
  });
});
```

2. Run RED:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.run.test.ts
```

Expected RED: `Test Files  1 failed (1)`; the cases fail with
`TypeError: assignPrimaryContacts is not a function` (or
`does not provide an export named 'assignPrimaryContacts'`).

3. Implement.

3a. `app/scripts/assign-primary-contacts.ts`, the imports. Edit old_string:

```ts
import { applyPrimary, chooseHeir, type RosterContactsRead } from '../src/lib/propertyContact.js';
import { isDeleted as isContactDeleted } from '../src/repos/contactsRepo.js';
import { unitContacts, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';
```

new_string:

```ts
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import {
  applyPrimary,
  chooseHeir,
  readRosterContacts,
  rosterContactIds,
  type RosterContactsRead,
} from '../src/lib/propertyContact.js';
import { createAuditRepo, type AuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo, isDeleted as isContactDeleted, type ContactsRepo } from '../src/repos/contactsRepo.js';
import {
  createUnitsRepo,
  isDeleted as isUnitDeleted,
  unitContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
```

3b. Append the run after `planUnitPrimary`. Edit old_string:

```ts
    write: { contacts: applied.contacts, primaryContact: heir.contactId },
  };
}
```

new_string:

```ts
    write: { contacts: applied.contacts, primaryContact: heir.contactId },
  };
}

// ---------------------------------------------------------------------------
// The run (dry run by default; --apply writes, unit by unit)
// ---------------------------------------------------------------------------

/** What the run reads and writes through. */
export interface AssignDeps {
  units: Pick<UnitsRepo, 'list' | 'assignPrimaryIfCurrent'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  audit: Pick<AuditRepo, 'append'>;
}

/** The real deps, every repo on the stage's doc client and env - never the ambient TABLE_PREFIX. */
export function buildAssignDeps(
  stage: { doc: DynamoDBDocumentClient; env: NodeJS.ProcessEnv },
  logger: Logger,
): AssignDeps {
  const { doc, env } = stage;
  return {
    units: createUnitsRepo({ doc, env, logger }),
    contacts: createContactsRepo({ doc, env, logger }),
    audit: createAuditRepo({ doc, env, logger }),
  };
}

export interface AssignOptions {
  /** Write. false = dry run (the CLI's default). */
  apply: boolean;
  logger?: Logger;
  /** Test seam: the Scan page size (unset = DynamoDB's own page). */
  scanLimit?: number;
}

/**
 * The counts (spec section 8) and the unit ids behind them. `targets` and the
 * id lists are what the run PLANNED (both modes); `assigned` is what an apply
 * wrote; `scalarAligned` is what a dry run would align and an apply aligned.
 */
export interface AssignResult {
  unitsScanned: number;
  /** Soft-deleted units among them - read and repaired like live ones. */
  deletedUnits: number;
  /** Units whose primary is absent or not live AND that have an heir. */
  targets: number;
  targetsOnDeletedUnits: number;
  /** Apply only: primaries written. */
  assigned: number;
  /** Units whose live, stored primary the scalar did not match. */
  scalarAligned: number;
  /** Apply only: writes whose condition failed - the unit changed after the read; nothing written. Re-run. */
  skippedOnCondition: number;
  /** Apply only: writes that failed otherwise - they may or may not have landed. */
  writeFailed: number;
  /** No live contact and no live landlord of record: nothing anyone can do. */
  noHeir: number;
  /** Live contacts, none eligible for automatic routing: Sam chooses on the property page. */
  noEligible: number;
  /** The contact read failed: liveness unknown, nothing decided. Re-run. */
  unknown: number;
  /** Nothing to do. */
  unchanged: number;
  /** Apply only: audit events that may not have been written AFTER their primary write landed. Expected 0. */
  auditFailed: number;
  targetUnitIds: string[];
  alignedUnitIds: string[];
  noEligibleUnitIds: string[];
  unknownUnitIds: string[];
  skippedUnitIds: string[];
  failedUnitIds: string[];
}

function emptyResult(): AssignResult {
  return {
    unitsScanned: 0,
    deletedUnits: 0,
    targets: 0,
    targetsOnDeletedUnits: 0,
    assigned: 0,
    scalarAligned: 0,
    skippedOnCondition: 0,
    writeFailed: 0,
    noHeir: 0,
    noEligible: 0,
    unknown: 0,
    unchanged: 0,
    auditFailed: 0,
    targetUnitIds: [],
    alignedUnitIds: [],
    noEligibleUnitIds: [],
    unknownUnitIds: [],
    skippedUnitIds: [],
    failedUnitIds: [],
  };
}

/** The counters as one flat record: every summary log line, the PARTIAL one included. */
function flatCounts(result: AssignResult): Record<string, number> {
  return {
    unitsScanned: result.unitsScanned,
    deletedUnits: result.deletedUnits,
    targets: result.targets,
    targetsOnDeletedUnits: result.targetsOnDeletedUnits,
    assigned: result.assigned,
    scalarAligned: result.scalarAligned,
    skippedOnCondition: result.skippedOnCondition,
    writeFailed: result.writeFailed,
    noHeir: result.noHeir,
    noEligible: result.noEligible,
    unknown: result.unknown,
    unchanged: result.unchanged,
    auditFailed: result.auditFailed,
  };
}

/**
 * The run. A Scan failure ABORTS: a PARTIAL report (the counters so far) is
 * logged and the error rethrown - every write is conditional, so re-running
 * after the fix is safe. Everything else is per unit and never aborts.
 */
export async function assignPrimaryContacts(deps: AssignDeps, opts: AssignOptions): Promise<AssignResult> {
  const log = opts.logger ?? defaultLogger;
  const result = emptyResult();
  try {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.units.list({
        deleted: 'any',
        consistentRead: true,
        ...(opts.scanLimit !== undefined && { limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      });
      for (const unit of page.items) await handleUnit(deps, opts.apply, result, log, unit);
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  } catch (err) {
    log.error(
      { err, ...flatCounts(result), apply: opts.apply },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function handleUnit(
  deps: AssignDeps,
  apply: boolean,
  result: AssignResult,
  log: Logger,
  unit: UnitItem,
): Promise<void> {
  const unitId = unit.unitId;
  const deleted = isUnitDeleted(unit);
  result.unitsScanned += 1;
  if (deleted) result.deletedUnits += 1;
  const read = await readRosterContacts(deps.contacts, rosterContactIds(unit), log);
  const plan = planUnitPrimary(unit, read);
  switch (plan.kind) {
    case 'unchanged':
      result.unchanged += 1;
      return;
    case 'noHeir':
      result.noHeir += 1;
      log.info({ unitId, deleted }, `${SCRIPT_NAME} - no heir: no live contact and no live landlord of record`);
      return;
    case 'noEligible':
      result.noEligible += 1;
      result.noEligibleUnitIds.push(unitId);
      log.info(
        { unitId, deleted },
        `${SCRIPT_NAME} - no eligible contact: only a tenant or a caseworker is live (choose one on the property page)`,
      );
      return;
    case 'unknown':
      result.unknown += 1;
      result.unknownUnitIds.push(unitId);
      log.warn(
        { unitId, deleted },
        `${SCRIPT_NAME} - a contact read failed: liveness unknown, nothing decided or written for this unit (re-run)`,
      );
      return;
    case 'align': {
      result.alignedUnitIds.push(unitId);
      if (!apply) {
        result.scalarAligned += 1;
        log.info({ unitId, deleted }, `${SCRIPT_NAME} - DRY RUN: would align primary_contact with the flagged primary`);
        return;
      }
      if ((await writeUnit(deps, result, log, unit, plan.write)) === 'written') {
        result.scalarAligned += 1;
        log.info({ unitId, deleted }, `${SCRIPT_NAME} - primary_contact aligned with the flagged primary`);
      }
      return;
    }
    case 'target': {
      result.targets += 1;
      if (deleted) result.targetsOnDeletedUnits += 1;
      result.targetUnitIds.push(unitId);
      const ids = { unitId, deleted, contactId: plan.heirId, ...(plan.from !== undefined && { from: plan.from }) };
      if (!apply) {
        log.info(ids, `${SCRIPT_NAME} - DRY RUN: would make this contact the primary contact`);
        return;
      }
      if ((await writeUnit(deps, result, log, unit, plan.write)) !== 'written') return;
      result.assigned += 1;
      try {
        await deps.audit.append(`units#${unitId}`, PRIMARY_ASSIGNED_EVENT, {
          contactId: plan.heirId,
          reason: 'backfill',
          ...(plan.from !== undefined && { from: plan.from }),
        });
      } catch (err) {
        // An append can land and then error (a timeout): MAY not have been written.
        result.auditFailed += 1;
        log.warn(
          { err, unitId },
          `${SCRIPT_NAME} - the audit event may not have been written (the primary was assigned); counted in auditFailed, continuing`,
        );
      }
      log.info(ids, `${SCRIPT_NAME} - primary contact assigned`);
      return;
    }
  }
}

/** ONE conditional write; a lost condition is skipped, any other failure counted - the run goes on. */
async function writeUnit(
  deps: AssignDeps,
  result: AssignResult,
  log: Logger,
  unit: UnitItem,
  write: PrimaryWrite,
): Promise<'written' | 'skipped' | 'failed'> {
  let outcome: 'written' | 'skipped';
  try {
    outcome = await deps.units.assignPrimaryIfCurrent(unit, write);
  } catch (err) {
    result.writeFailed += 1;
    result.failedUnitIds.push(unit.unitId);
    log.error(
      { err, unitId: unit.unitId },
      `${SCRIPT_NAME} - the write FAILED; it may or may not have landed - re-run the dry run to see`,
    );
    return 'failed';
  }
  if (outcome === 'skipped') {
    result.skippedOnCondition += 1;
    result.skippedUnitIds.push(unit.unitId);
    log.info(
      { unitId: unit.unitId },
      `${SCRIPT_NAME} - the unit changed after the run read it; skipped, nothing written (re-run)`,
    );
  }
  return outcome;
}

/** The end-of-run log line and the exit code it earns: 1 when a unit could not be decided or a write failed. */
export function reportAssignRun(result: AssignResult, apply: boolean, log: Logger = defaultLogger): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  const fields = { ...flatCounts(result), apply };
  if (result.unknown > 0 || result.writeFailed > 0) {
    log.warn(
      fields,
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.unknown} unit(s) could not be decided (a contact read failed) and ${result.writeFailed} write(s) failed - see the WARN and ERROR lines naming them, then re-run (idempotent).`,
    );
    return 1;
  }
  if (result.skippedOnCondition > 0 || result.auditFailed > 0) {
    log.warn(
      fields,
      `${SCRIPT_NAME} - done${suffix}: ${result.skippedOnCondition} unit(s) changed while the run worked (re-run to finish them) and ${result.auditFailed} audit event(s) may not have been written`,
    );
    return 0;
  }
  log.info(fields, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

/**
 * What the CLI prints (spec section 8): the counts, then the unit ids of each
 * list - never a name, a phone or a street.
 */
export function formatAssignSummary(result: AssignResult, apply: boolean): string[] {
  const ids = (list: readonly string[]): string => (list.length === 0 ? 'none' : list.join(', '));
  const lines = [
    apply ? 'Primary contacts - APPLIED:' : 'Primary contacts - DRY RUN, nothing written:',
    `  Properties scanned: ${result.unitsScanned} (${result.deletedUnits} soft-deleted)`,
    `  ${apply ? 'Planned a primary contact' : 'Would get a primary contact'}: ${result.targets} (${result.targetsOnDeletedUnits} on soft-deleted properties)`,
  ];
  if (apply) lines.push(`  Primary contacts assigned: ${result.assigned}`);
  lines.push(
    `  primary_contact field ${apply ? 'aligned' : 'would be aligned'} with the flagged primary: ${result.scalarAligned}`,
    `  No heir - no live contact and no live landlord of record (nothing to do): ${result.noHeir}`,
    `  No eligible contact - only a tenant or a caseworker is live (choose one on the property page): ${result.noEligible}`,
    `  Unknown - a contact read failed (re-run): ${result.unknown}`,
    `  Already fine: ${result.unchanged}`,
  );
  if (apply) {
    lines.push(
      `  Skipped - the property changed after the run read it (re-run): ${result.skippedOnCondition}`,
      `  Writes that FAILED (re-run the dry run to see): ${result.writeFailed}`,
      `  Audit events that may not have been written: ${result.auditFailed} (expected 0)`,
    );
  }
  lines.push(
    `${apply ? 'Properties planned for a primary contact' : 'Properties that would get a primary contact'}: ${ids(result.targetUnitIds)}`,
    `${apply ? 'Properties planned for a primary_contact field alignment' : 'Properties whose primary_contact field would be aligned'}: ${ids(result.alignedUnitIds)}`,
    `Properties with no eligible contact (open each one and choose a primary contact): ${ids(result.noEligibleUnitIds)}`,
    `Properties that could not be decided (re-run): ${ids(result.unknownUnitIds)}`,
  );
  if (apply) {
    lines.push(
      `Properties skipped because they changed (re-run): ${ids(result.skippedUnitIds)}`,
      `Properties whose write failed: ${ids(result.failedUnitIds)}`,
    );
  }
  return lines;
}
```

4. Run GREEN (both script test files):

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.plan.test.ts test/assignPrimaryContacts.run.test.ts
```

Expected: `Test Files  2 passed (2)` and `Tests  23 passed (23)`. Then:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npm run typecheck
```

Expected: exit 0.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `app/scripts/assign-primary-contacts.ts` (modified) and
`app/test/assignPrimaryContacts.run.test.ts` (new), no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add app/scripts/assign-primary-contacts.ts app/test/assignPrimaryContacts.run.test.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "feat(scripts): assign-primary-contacts run - consistent Scan, conditional writes, backfill audit events, counts and summary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.4 - assign-primary-contacts: the CLI and its exit codes

**Files:**
- Modify: `app/scripts/assign-primary-contacts.ts`
- Create: `app/test/assignPrimaryContacts.cli.test.ts`

**Steps:**

1. Write the failing test - create `app/test/assignPrimaryContacts.cli.test.ts`:

```ts
// assign-primary-contacts (plan C12, task S5.4): the CLI. Dry run by default,
// --apply writes, --lane is local only, anything else is a usage error (exit
// 2, nothing resolved); the target resolves BEFORE any read and a refusal
// there exits 1 with nothing run; a run that throws exits 1; a completed run
// exits by reportAssignRun (1 when a unit could not be decided or a write
// failed); once resolved, the stage client is destroyed whatever happens.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { StageClient, StageClientOpts, StageTarget } from '../scripts/lib/stageClient.js';
import {
  main,
  USAGE,
  type AssignCliDeps,
  type AssignOptions,
  type AssignResult,
} from '../scripts/assign-primary-contacts.js';
import { createLogCapture } from './helpers/logCapture.js';

const CLEAN: AssignResult = {
  unitsScanned: 2,
  deletedUnits: 0,
  targets: 0,
  targetsOnDeletedUnits: 0,
  assigned: 0,
  scalarAligned: 0,
  skippedOnCondition: 0,
  writeFailed: 0,
  noHeir: 0,
  noEligible: 0,
  unknown: 0,
  unchanged: 2,
  auditFailed: 0,
  targetUnitIds: [],
  alignedUnitIds: [],
  noEligibleUnitIds: [],
  unknownUnitIds: [],
  skippedUnitIds: [],
  failedUnitIds: [],
};

function cli(opts: { resolveFails?: boolean; runFails?: boolean; result?: AssignResult } = {}) {
  const resolved: Array<{ target: StageTarget; opts: StageClientOpts }> = [];
  const runs: AssignOptions[] = [];
  const printed: string[] = [];
  const errors: string[] = [];
  let destroyed = 0;
  const stage: StageClient = {
    doc: {
      destroy: () => {
        destroyed += 1;
      },
    } as unknown as DynamoDBDocumentClient,
    env: { TABLE_PREFIX: 'hc-test-' },
    endpoint: 'http://fake-stage',
    prefix: 'hc-test-',
    accessKeyId: undefined,
    describe: 'fake stage',
  };
  const capture = createLogCapture();
  const deps: AssignCliDeps = {
    async resolveStage(target, stageOpts) {
      resolved.push({ target, opts: stageOpts });
      if (opts.resolveFails === true) throw new Error('ACCOUNT GUARD: wrong account');
      return stage;
    },
    async run(_stage, runOpts) {
      runs.push(runOpts);
      if (opts.runFails === true) throw new Error('scan failed');
      return opts.result ?? CLEAN;
    },
    print: (line) => {
      printed.push(line);
    },
    printError: (text) => {
      errors.push(text);
    },
    logger: createLogger({ level: 'info', destination: capture.stream }),
  };
  return { deps, resolved, runs, printed, errors, capture, destroyed: () => destroyed };
}

describe('assign-primary-contacts CLI', () => {
  it.each<[string[]]>([
    [[]],
    [['--apply']],
    [['--env', 'staging']],
    [['--env', 'dev', '--dry-run']],
    [['--env', 'dev', '--lane', '2']],
    [['--env', 'dev', '--apply', '--apply']],
  ])('exits 2 on the usage error %j: nothing resolved, nothing run', async (argv) => {
    const c = cli();
    expect(await main(argv, c.deps)).toBe(2);
    expect(c.errors).toEqual([USAGE]);
    expect(c.resolved).toEqual([]);
    expect(c.runs).toEqual([]);
  });

  it('dry run by default, against the resolved stage; the summary is printed and the client destroyed', async () => {
    const c = cli();
    expect(await main(['--env', 'prod'], c.deps)).toBe(0);
    expect(c.resolved).toEqual([{ target: 'prod', opts: {} }]);
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toMatchObject({ apply: false });
    expect(c.printed[0]).toBe('Primary contacts - DRY RUN, nothing written:');
    expect(c.destroyed()).toBe(1);
  });

  it('--apply writes; --lane reaches a local stage', async () => {
    const c = cli();
    expect(await main(['--env', 'local', '--lane', '4', '--apply'], c.deps)).toBe(0);
    expect(c.resolved).toEqual([{ target: 'local', opts: { lane: 4 } }]);
    expect(c.runs[0]).toMatchObject({ apply: true });
    expect(c.printed[0]).toBe('Primary contacts - APPLIED:');
  });

  it('exits 1 with nothing run when the target cannot be resolved', async () => {
    const c = cli({ resolveFails: true });
    expect(await main(['--env', 'dev'], c.deps)).toBe(1);
    expect(c.runs).toEqual([]);
    expect(c.destroyed()).toBe(0);
    expect(c.capture.atLevel(50).some((l) => String(l['msg']).includes('FAILED before the run started'))).toBe(true);
  });

  it('exits 1 when the run throws, naming the failure, and still destroys the client', async () => {
    const c = cli({ runFails: true });
    expect(await main(['--env', 'dev', '--apply'], c.deps)).toBe(1);
    expect(c.destroyed()).toBe(1);
    expect(
      c.capture.atLevel(50).some((l) => String(l['msg']) === 'assign-primary-contacts - FAILED: scan failed'),
    ).toBe(true);
  });

  it('exits 1 when the run completed with failures, 0 when it completed clean', async () => {
    const failed = cli({ result: { ...CLEAN, unknown: 1, unknownUnitIds: ['u-1'] } });
    expect(await main(['--env', 'dev'], failed.deps)).toBe(1);
    const clean = cli();
    expect(await main(['--env', 'dev'], clean.deps)).toBe(0);
  });
});
```

2. Run RED:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.cli.test.ts
```

Expected RED: `Test Files  1 failed (1)`; the cases fail with
`TypeError: main is not a function` (or `does not provide an export named 'main'`).

3. Implement.

3a. `app/scripts/assign-primary-contacts.ts`, the imports. Edit old_string:

```ts
import {
  createUnitsRepo,
  isDeleted as isUnitDeleted,
  unitContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
```

new_string:

```ts
import {
  createUnitsRepo,
  isDeleted as isUnitDeleted,
  unitContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../src/repos/unitsRepo.js';
import {
  parseStageArgs,
  resolveStageClient,
  type StageClient,
  type StageClientOpts,
  type StageTarget,
} from './lib/stageClient.js';
```

3b. Append the CLI after `formatAssignSummary`. Edit old_string:

```ts
      `Properties whose write failed: ${ids(result.failedUnitIds)}`,
    );
  }
  return lines;
}
```

new_string:

```ts
      `Properties whose write failed: ${ids(result.failedUnitIds)}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/** The argument names the CLI accepts beside --env and --lane (parseStageArgs refuses any other, and any repeat). */
export const ASSIGN_ARGS = { values: [] as string[], flags: ['--apply'] };

/** What a usage error prints (exit 2). */
export const USAGE =
  `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply]\n` +
  '  DRY RUN by default; --apply writes. Unknown or repeated arguments are refused.\n' +
  '  --lane selects a hermetic e2e lane (local only).';

/** The CLI's outside world - each member injectable, so the tests execute every exit code. */
export interface AssignCliDeps {
  /** --env/--lane -> the stage client (default: resolveStageClient; for dev/prod the account guard runs first). */
  resolveStage: (target: StageTarget, opts: StageClientOpts) => Promise<StageClient>;
  /** The run on that client (default: assignPrimaryContacts on buildAssignDeps(stage)). */
  run: (stage: StageClient, opts: AssignOptions) => Promise<AssignResult>;
  /** One line of the printed summary (default: console.log). */
  print: (line: string) => void;
  /** The usage text (default: console.error). */
  printError: (text: string) => void;
  logger: Logger;
}

/**
 * The CLI (spec section 8). Resolves to the exit code: 2 a usage error
 * (nothing resolved, nothing read); 1 the target could not be resolved
 * (nothing read), the run aborted (the Scan failed - its PARTIAL line says
 * so), or it completed with failures (reportAssignRun); 0 it completed. Once
 * resolved, the stage client is destroyed whatever happens.
 */
export async function main(argv: readonly string[], cli: Partial<AssignCliDeps> = {}): Promise<0 | 1 | 2> {
  const printError = cli.printError ?? ((text: string) => console.error(text));
  const print = cli.print ?? ((line: string) => console.log(line));
  const log = cli.logger ?? defaultLogger;
  const resolveStage: AssignCliDeps['resolveStage'] =
    cli.resolveStage ?? ((target, opts) => resolveStageClient(target, {}, opts));
  const run: AssignCliDeps['run'] =
    cli.run ?? ((stage, opts) => assignPrimaryContacts(buildAssignDeps(stage, log), opts));

  const parsed = parseStageArgs([...argv], ASSIGN_ARGS);
  if ('usage' in parsed) {
    printError(USAGE);
    return 2;
  }
  const apply = parsed.flags.has('--apply');

  // STEP 1 - resolve the target on its own: a refusal here (account guard,
  // STS, an ambient AWS_ENDPOINT_URL*) happens BEFORE any table is read.
  let stage: StageClient;
  try {
    stage = await resolveStage(parsed.target, parsed.lane !== undefined ? { lane: parsed.lane } : {});
  } catch (err) {
    log.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
    return 1;
  }
  // STEP 2 - the run, then the summary and the exit code it earns.
  try {
    log.info(
      { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply },
      `${SCRIPT_NAME} - starting`,
    );
    const result = await run(stage, { apply, logger: log });
    for (const line of formatAssignSummary(result, apply)) print(line);
    return reportAssignRun(result, apply, log);
  } catch (err) {
    log.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    stage.doc.destroy();
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(`${SCRIPT_NAME}.ts`);
if (invokedDirectly) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
```

4. Run GREEN (all three script test files):

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/assignPrimaryContacts.plan.test.ts test/assignPrimaryContacts.run.test.ts test/assignPrimaryContacts.cli.test.ts
```

Expected: `Test Files  3 passed (3)` and `Tests  34 passed (34)`. Then:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npm run typecheck
```

Expected: exit 0. Optional rehearsal ONLY on a hermetic lane you started
(`npm run e2e:session`, lane number from `e2e/.artifacts/lane.json`), never a
bare `--env local`, never dev/prod:
`cd "W:/tmp/primary-contact-integrity" && npx tsx app/scripts/assign-primary-contacts.ts --env local --lane <L>`
(exit 0, a DRY RUN summary). Not required for the task.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `app/scripts/assign-primary-contacts.ts` (modified) and
`app/test/assignPrimaryContacts.cli.test.ts` (new), no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add app/scripts/assign-primary-contacts.ts app/test/assignPrimaryContacts.cli.test.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "feat(scripts): assign-primary-contacts CLI - --env dev|prod, dry run by default, --apply, exit codes 0/1/2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.5 - the dev-only seam `POST /__dev/fixtures/zero-primary-property`

Contract 2.7 as refined by CONTRACT ISSUE 2. `app/src/routes/dev.ts` is only
ever loaded by `lib/devRoutes.ts` `maybeLoadDevRouter` (DEV_AUTH_ENABLED,
NODE_ENV not production, AND a DynamoDB Local endpoint) and mounted by
`app.ts` only when that returns a router - so a route added inside
`createDevRouter` is structurally absent in every deployed environment, like
`/__dev/org-fixture`.

**Files:**
- Modify: `app/src/routes/dev.ts`
- Create: `app/test/devZeroPrimaryFixture.test.ts`

**Steps:**

1. Write the failing test - create `app/test/devZeroPrimaryFixture.test.ts`:

```ts
// POST /__dev/fixtures/zero-primary-property (primary-contact-integrity spec
// section 10; plan contract 2.7 as refined by S5, task S5.5): the hermetic e2e
// seam that creates a NEW property in the imported shape - no landlord of
// record, the given contacts as NON-primary rows - because no UI path and no
// lean seed unit reaches that state. Built like devOrgFixture.test.ts: the dev
// router gets the world fakes and shares the world with the harness app.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';
const SEAM = '/__dev/fixtures/zero-primary-property';
/** A run-unique street - what an e2e spec passes. */
const STREET = '4821 Zero Primary Way NW';

interface Harness {
  app: Express;
  world: FakeWorld;
  capture: LogCapture;
  /** Unit ids present before the request. */
  existing: ReadonlySet<string>;
}

function buildHarness(): Harness {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    CF_ORIGIN_SECRET: SECRET,
    MESSAGING_DRIVER: 'console',
  });
  const devRouter = createDevRouter({
    config,
    logger,
    zeroPrimaryFixtureRepos: { contactsRepo: world.contactsRepo, unitsRepo: world.unitsRepo },
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  world.contacts.push(
    { contactId: 'c-mark', type: 'landlord', status: 'active', firstName: 'Mark', lastName: 'Passmore' },
    { contactId: 'c-ten', type: 'tenant', status: 'searching', firstName: 'Tara', lastName: 'Tenant' },
  );
  world.units.set('u-existing', {
    unitId: 'u-existing',
    landlordId: 'c-owner',
    status: 'available',
    contacts: [{ contactId: 'c-owner', role: 'landlord', primaryContact: true }],
  });
  return { app, world, capture, existing: new Set(world.units.keys()) };
}

/** The units the seam created in this harness. */
const created = (h: Harness): UnitItem[] => [...h.world.units.values()].filter((u) => !h.existing.has(u.unitId));

describe('POST /__dev/fixtures/zero-primary-property', () => {
  it('creates a NEW property with no landlord of record and the contacts as non-primary rows, in order', async () => {
    const h = buildHarness();
    const res = await request(h.app)
      .post(SEAM)
      .send({
        street: STREET,
        rows: [
          { contactId: 'c-ten', role: 'other' },
          { contactId: 'c-mark', role: 'pm' },
        ],
      });
    expect(res.status).toBe(201);
    const [unit] = created(h);
    expect(created(h)).toHaveLength(1);
    expect(res.body).toEqual({ unitId: unit?.unitId });
    expect(unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId')).toBe(false);
    expect(unit?.primary_contact).toBeUndefined();
    expect(unit?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-mark', role: 'pm', primaryContact: false },
    ]);
    expect(unit?.status).toBe('setup');
    expect(unit?.address).toEqual({ line1: STREET, city: 'Atlanta', state: 'GA', zip: '30314' });
    expect(unit?.accepted_authorities).toBeUndefined();
  });

  it('never touches an existing property', async () => {
    const h = buildHarness();
    const before = structuredClone(h.world.units.get('u-existing'));
    const res = await request(h.app).post(SEAM).send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(res.status).toBe(201);
    expect(h.world.units.get('u-existing')).toEqual(before);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no street', { rows: [{ contactId: 'c-mark', role: 'pm' }] }, 'street must be a non-empty string'],
    ['a blank street', { street: '   ', rows: [{ contactId: 'c-mark', role: 'pm' }] }, 'street must be a non-empty string'],
    ['no rows', { street: STREET }, 'rows must be an array of 1 to 5 entries'],
    ['an empty rows list', { street: STREET, rows: [] }, 'rows must be an array of 1 to 5 entries'],
    [
      'six rows',
      {
        street: STREET,
        rows: ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6'].map((contactId) => ({ contactId, role: 'other' })),
      },
      'rows must be an array of 1 to 5 entries',
    ],
    ['a row without a contactId', { street: STREET, rows: [{ role: 'pm' }] }, 'each row needs a non-empty contactId'],
    [
      'the landlord role',
      { street: STREET, rows: [{ contactId: 'c-mark', role: 'landlord' }] },
      'each row role must be pm, owner or other',
    ],
    [
      'a repeated contact',
      {
        street: STREET,
        rows: [
          { contactId: 'c-mark', role: 'pm' },
          { contactId: 'c-mark', role: 'owner' },
        ],
      },
      'a contactId may appear once',
    ],
  ])('refuses %s with 400 and creates nothing', async (_label, body, error) => {
    const h = buildHarness();
    const res = await request(h.app).post(SEAM).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(created(h)).toEqual([]);
  });

  it('answers 404 for a contact that does not exist, and creates nothing', async () => {
    const h = buildHarness();
    const res = await request(h.app)
      .post(SEAM)
      .send({
        street: STREET,
        rows: [
          { contactId: 'c-mark', role: 'pm' },
          { contactId: 'c-missing', role: 'owner' },
        ],
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found', contactId: 'c-missing' });
    expect(created(h)).toEqual([]);
  });

  it('logs the unit id and the row count - never the street or a name', async () => {
    const h = buildHarness();
    const res = await request(h.app).post(SEAM).send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(h.capture.lines.find((l) => l['msg'] === 'dev zero-primary-property fixture created')).toMatchObject({
      unitId: (res.body as { unitId: string }).unitId,
      rows: 1,
    });
    // pino stamps the machine's hostname on every line - not ours to check.
    const logged = JSON.stringify(h.capture.lines.map(({ hostname: _hostname, ...line }) => line));
    for (const text of [STREET, 'Mark', 'Passmore']) expect(logged).not.toContain(text);
  });

  it('is absent when the dev router is not mounted', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app)
      .post(SEAM)
      .set('x-origin-verify', SECRET)
      .send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(res.status).toBe(404);
  });
});
```

2. Run RED:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/devZeroPrimaryFixture.test.ts
```

Expected RED: `Test Files  1 failed (1)`; the seam cases fail with
`AssertionError: expected 404 to be 201` (or `... 404 to be 400`); only
`is absent when the dev router is not mounted` passes.

3. Implement in `app/src/routes/dev.ts`.

3a. The import. Edit old_string:

```ts
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
```

new_string:

```ts
import { createUnitsRepo, type CreateUnitInput, type UnitContact, type UnitsRepo } from '../repos/unitsRepo.js';
```

3b. The deps. Edit old_string:

```ts
  orgFixtureRepos?: { contactsRepo: ContactsRepo; unitsRepo: UnitsRepo };
}
```

new_string:

```ts
  orgFixtureRepos?: { contactsRepo: ContactsRepo; unitsRepo: UnitsRepo };
  /** Repos for POST /__dev/fixtures/zero-primary-property - injected in tests
   *  (the world fakes); default to the real contacts and units repos. */
  zeroPrimaryFixtureRepos?: { contactsRepo: ContactsRepo; unitsRepo: UnitsRepo };
}
```

3c. The route, right after the org-fixture route. Edit old_string:

```ts
    log.info({ unitId: id, field: 'accepted_authorities' }, 'dev org-fixture applied');
    res.status(200).json({ ok: true });
  });
```

new_string:

```ts
    log.info({ unitId: id, field: 'accepted_authorities' }, 'dev org-fixture applied');
    res.status(200).json({ ok: true });
  });

  // POST /__dev/fixtures/zero-primary-property { street, rows: [{ contactId,
  // role }] } -> 201 { unitId } (primary-contact-integrity spec section 10;
  // plan contract 2.7 as refined by S5). Creates a NEW property in the
  // IMPORTED shape - no landlordId attribute at all (as the importer leaves
  // it when the landlord name matches nobody, lib/import/apply.ts) and the
  // given contacts as NON-primary contact-list rows, in the order given
  // (array order = add order). It is the only way to reach that state: a new
  // property requires a landlord, and an add on an ownerless property makes
  // an eligible contact primary at once (auto-primary), so the rows go in
  // through the create itself, never addContact. The spec creates the
  // contacts first through the real POST /api/contacts; rows carry no
  // name/company (the unit GET's read-time enrichment is authoritative).
  // Role `landlord` is refused: on an ownerless property a landlord-role add
  // CLAIMS the landlord slot, so no path stores that row. Status `setup` and
  // no accepted_authorities keep it out of the Available view and the
  // organization usage counts other specs read. It never touches an existing
  // unit, so the lean world stays byte-stable; the next reseed removes what
  // it made. Same hermetic-LOCAL-only construction as the fixtures above (the
  // dev router only mounts behind lib/devRoutes.ts, structurally absent in
  // every deployed env); json() is scoped to this route. Logs ids and counts
  // only - never a name or the street.
  const ZERO_PRIMARY_MAX_ROWS = 5;
  let zeroPrimaryRepos = deps.zeroPrimaryFixtureRepos;
  const zeroPrimaryDeps = (): { contactsRepo: ContactsRepo; unitsRepo: UnitsRepo } => {
    zeroPrimaryRepos ??= {
      contactsRepo: createContactsRepo({ logger: log }),
      unitsRepo: createUnitsRepo({ logger: log }),
    };
    return zeroPrimaryRepos;
  };
  router.post('/__dev/fixtures/zero-primary-property', json(), async (req, res) => {
    const body = (req.body ?? {}) as { street?: unknown; rows?: unknown };
    const street = typeof body.street === 'string' ? body.street.trim() : '';
    if (street === '') {
      res.status(400).json({ error: 'street must be a non-empty string' });
      return;
    }
    const rawRows = body.rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0 || rawRows.length > ZERO_PRIMARY_MAX_ROWS) {
      res.status(400).json({ error: `rows must be an array of 1 to ${ZERO_PRIMARY_MAX_ROWS} entries` });
      return;
    }
    const rows: Array<{ contactId: string; role: UnitContact['role'] }> = [];
    for (const raw of rawRows as unknown[]) {
      const row = (typeof raw === 'object' && raw !== null ? raw : {}) as { contactId?: unknown; role?: unknown };
      const contactId = typeof row.contactId === 'string' ? row.contactId : '';
      if (contactId === '') {
        res.status(400).json({ error: 'each row needs a non-empty contactId' });
        return;
      }
      const role = row.role;
      if (role !== 'pm' && role !== 'owner' && role !== 'other') {
        res.status(400).json({ error: 'each row role must be pm, owner or other' });
        return;
      }
      if (rows.some((r) => r.contactId === contactId)) {
        res.status(400).json({ error: 'a contactId may appear once' });
        return;
      }
      rows.push({ contactId, role });
    }
    const { contactsRepo, unitsRepo } = zeroPrimaryDeps();
    for (const row of rows) {
      if ((await contactsRepo.getById(row.contactId)) === undefined) {
        res.status(404).json({ error: 'contact_not_found', contactId: row.contactId });
        return;
      }
    }
    const contacts: UnitContact[] = rows.map((row) => ({
      contactId: row.contactId,
      role: row.role,
      primaryContact: false,
    }));
    // CreateUnitInput types landlordId as required because every API create
    // has one; this fixture is the one caller that omits it on purpose.
    const unit = await unitsRepo.create({
      status: 'setup',
      address: { line1: street, city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts,
    } as unknown as CreateUnitInput);
    log.info({ unitId: unit.unitId, rows: contacts.length }, 'dev zero-primary-property fixture created');
    res.status(201).json({ unitId: unit.unitId });
  });
```

4. Run GREEN:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/devZeroPrimaryFixture.test.ts test/devOrgFixture.test.ts test/devGating.test.ts
```

Expected: `Test Files  3 passed (3)` (this file: 13 tests). Then:

```bash
cd "W:/tmp/primary-contact-integrity/app" && npm run typecheck
```

Expected: exit 0.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `app/src/routes/dev.ts` (modified) and
`app/test/devZeroPrimaryFixture.test.ts` (new), no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add app/src/routes/dev.ts app/test/devZeroPrimaryFixture.test.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "feat(dev): /__dev/fixtures/zero-primary-property - a NEW property with no primary contact and no landlord of record, for e2e" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.6 - e2e: the seam fixture and the three walks of spec 10

These specs pin behavior S1-S4 and S5.5 already built, so there is no
honest RED step: the first run is EXPECTED GREEN. A failure here is a real
defect - diagnose it to root cause (read the trace/screenshot under
`e2e/.artifacts/test-results/`) before changing anything, and never loosen an
assertion to pass. Do not edit app or dashboard source while an e2e run is
live in this worktree (it serves the source live).

On (b)'s "fix the property in another tab": the walk follows the dialog's own
`Set a primary contact` link, which opens a NEW TAB in the same browser
context (the session cookie is shared - exactly Sam's browser), fixes the
property there with the box's one-click button, closes it, and presses Check
again in the still-open dialog. That is the spec's flow verbatim and needs no
API shortcut.

**Files:**
- Create: `e2e/fixtures/primaryContact.ts`
- Create: `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts`

**Steps:**

1. Write the tests.

1a. Create `e2e/fixtures/primaryContact.ts`:

```ts
// e2e/fixtures/primaryContact.ts
//
// The dev-only seam for primary-contact-integrity (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 10): POST /__dev/fixtures/zero-primary-property creates a NEW
// property in the imported shape - no landlord of record, the given contacts
// on its contact list as NON-primary rows, in the order given. No UI path
// reaches that state (a new property requires a landlord, and an add on an
// ownerless property makes an eligible contact primary at once), and the
// byte-stable lean seed has none on purpose. Create the contacts first
// through POST /api/contacts; the seam writes only the property and never
// touches an existing one. Relative path: the lane's Vite server proxies
// /__dev to the app (reseed.ts, orgFixture.ts).
import type { APIRequestContext } from '@playwright/test';

/** A contact-list row the seam writes. `landlord` is refused: on a property
 *  with no landlord of record, a landlord-role add CLAIMS the slot. */
export interface ZeroPrimaryRow {
  contactId: string;
  role: 'pm' | 'owner' | 'other';
}

/** Create the property; returns its unitId. Throws on anything but 201. */
export async function createZeroPrimaryProperty(
  request: APIRequestContext,
  input: { street: string; rows: ZeroPrimaryRow[] },
): Promise<string> {
  const res = await request.post('/__dev/fixtures/zero-primary-property', { data: input });
  if (res.status() !== 201) {
    throw new Error(`/__dev/fixtures/zero-primary-property failed: ${res.status()} ${await res.text()}`);
  }
  return ((await res.json()) as { unitId: string }).unitId;
}
```

1b. Create `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts`:

```ts
// e2e/tests/dashboard-next/primary-contact-integrity.spec.ts
//
// PRIMARY CONTACT INTEGRITY, end to end (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 10). Three walks over a property in the IMPORTED shape - no
// landlord of record, and contacts on its contact list of which none is
// primary (470 Bolton). The UI cannot reach that state and the byte-stable
// lean seed has none on purpose, so each walk builds its own through the
// DEV-ONLY seam POST /__dev/fixtures/zero-primary-property
// (fixtures/primaryContact.ts):
//
//   (a) THE PROPERTY BOX (spec 7.4): the Contacts card says the property has
//       no primary contact and offers "Make <Name> primary" for its one
//       eligible contact; one click makes them primary and the box goes.
//   (b) THE OPEN-GROUP DIALOG (spec 7.1): a booked tour on that property
//       previews the GENERAL intro, and the dialog says why and links to the
//       fix in a NEW TAB. The walk follows that link - a second tab in the
//       same browser context, exactly what Sam's browser does - fixes the
//       property there, comes back and presses Check again: the preview
//       becomes the TOUR intro naming the new primary contact.
//   (c) THE REMOVE HANDOFF (spec 4.6 / 7.3): removing the primary from a
//       property with no landlord of record hands it to the earliest-added
//       contact eligible for automatic routing - a tenant added before it is
//       skipped - and the confirm names who takes over.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + a
// local devLogin, raw page.request for setup, accessibility-first locators,
// no Scenario verbs. Self-clean isolation: every contact, property and tour
// is minted fresh per test (the seam creates a NEW property and never
// touches a lean one), so NOTHING here reseeds and the lean world stays
// byte-stable. No walk opens a relay group, so nothing is texted.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createZeroPrimaryProperty } from '../../fixtures/primaryContact.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The display name every roster surface renders for this contact. */
  name: string;
}

/** A fresh typed contact WITH a phone, through the real create. A property
 *  manager is a `landlord`-typed contact; the ROLE is what the row carries. */
async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const lastName = 'Pcint';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type, firstName, lastName, phone, ...(type === 'tenant' && { voucherSize: 2 }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, lastName, phone, name: `${firstName} ${lastName}` };
}

/** A run-unique street: the box, the dialog and the tour intro all name it. */
function freshStreet(stamp: string): string {
  return `${stamp} Primary Contact Way NW`;
}

interface UnitWire {
  landlordId?: string;
  primary_contact?: string;
  contacts?: Array<{ contactId: string; role: string; primaryContact?: boolean }>;
  propertyContact?: { contactId: string | null; reason?: 'none' | 'deleted' };
}

async function readUnit(request: APIRequestContext, unitId: string): Promise<UnitWire> {
  const res = await request.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: UnitWire }).unit;
}

/** The open-group preview exactly as the dialog receives it. */
interface PreviewWire {
  body: string;
  introFallback?: { reasons: string[]; unitId?: string; street?: string; propertyContactId?: string };
}

async function previewOpen(request: APIRequestContext, tourId: string): Promise<PreviewWire> {
  const res = await request.get(`${NEXT}/api/tours/${tourId}/roster/preview-open`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as PreviewWire;
}

/** The property page's Contacts card: Card.tsx renders a plain <section> under
 *  an <h3> whose accessible name also carries the "Edit contacts" action, so
 *  match the heading by prefix. Scoping matters: getByText is a
 *  case-insensitive substring match, and the remove confirm's no-heir notice
 *  also contains "no primary contact." */
function contactsCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /^Contacts\b/ }) });
}

test.describe('Primary contact integrity - a property with no primary contact', () => {
  test('(a) the property box offers Make <Name> primary, and one click fixes it', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // 470 Bolton's shape: no landlord of record; its only contact a property
    // manager typed landlord - on the contact list, not primary.
    const mark = await createContact(req, 'landlord', `Pcmark${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street: freshStreet(stamp),
      rows: [{ contactId: mark.contactId, role: 'pm' }],
    });

    // The server agrees it is the broken state: no landlord, no primary, and
    // the property-contact block names nobody (reason none - not deleted).
    let unit = await readUnit(req, unitId);
    expect(unit.landlordId).toBeUndefined();
    expect(unit.primary_contact).toBeUndefined();
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: mark.contactId, role: 'pm', primaryContact: false }),
    ]);
    expect(unit.propertyContact).toMatchObject({ contactId: null, reason: 'none' });

    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = contactsCard(page);
    await expect(card.getByText('No primary contact.')).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeVisible();
    // ONE eligible row: the button names the person, never "Choose a primary".
    const makePrimary = card.getByRole('button', { name: `Make ${mark.name} primary` });
    await expect(makePrimary).toBeVisible();
    await expect(card.getByRole('button', { name: 'Choose a primary' })).toHaveCount(0);

    await makePrimary.click();
    await expect(card.getByText('No primary contact.')).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByRole('link', { name: new RegExp(`^${mark.name} \\(primary\\)`) })).toBeVisible();

    unit = await readUnit(req, unitId);
    expect(unit.primary_contact).toBe(mark.contactId);
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: mark.contactId, role: 'pm', primaryContact: true }),
    ]);
    expect(unit.propertyContact).toMatchObject({ contactId: mark.contactId });
    expect(unit.landlordId).toBeUndefined();
  });

  test('(b) a booked tour there previews the general intro and says why; Check again after the fix shows the tour intro', async ({
    page,
  }) => {
    test.slow(); // build-a-world, a second tab, two previews.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const street = freshStreet(stamp);
    const mark = await createContact(req, 'landlord', `Pctour${stamp}`);
    const tenant = await createContact(req, 'tenant', `Pcten${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street,
      rows: [{ contactId: mark.contactId, role: 'pm' }],
    });
    // BOOKED, +48h (never "today" in the org zone): only a booked tour can
    // carry the tour intro, so the general intro here is about the property.
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: {
        tenantId: tenant.contactId,
        unitId,
        tourType: 'landlord_led',
        scheduledAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      },
    });
    expect(tourRes.ok(), await tourRes.text()).toBeTruthy();
    const tourId = ((await tourRes.json()) as { tour: { tourId: string } }).tour.tourId;
    // With no primary contact and no landlord the default people list is the
    // tenant alone - too thin to open a group. Put Mark on THIS tour by hand:
    // the silent plan add the People card makes (no thread, nothing sent).
    const added = await req.post(`${NEXT}/api/tours/${tourId}/roster/members`, {
      data: { contactId: mark.contactId },
    });
    expect(added.ok(), await added.text()).toBeTruthy();

    // The server's own preview: the GENERAL intro, and exactly one reason.
    const before = await previewOpen(req, tourId);
    expect(before.introFallback).toEqual({ reasons: ['no_property_contact'], unitId, street });
    expect(before.body).not.toContain('Putting you in a group text');

    await page.goto(`${NEXT}/tours/${tourId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open relay group' }).click();
    const confirm = page.getByRole('dialog', { name: 'Open the relay group?' });
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    const draft = confirm.getByRole('region', { name: 'Message preview' }).getByRole('textbox');
    await expect(draft).toHaveValue(before.body);

    // The box: role="status" inside the dialog, filtered by its heading (the
    // duplicate-group warning is the dialog's other status region).
    const box = confirm.getByRole('status').filter({ hasText: 'Using the general intro, not the tour intro.' });
    await expect(box).toBeVisible();
    await expect(box).toContainText(`${street} has no primary contact, so the intro can't name the landlord.`);
    const fixLink = box.getByRole('link', { name: 'Set a primary contact' });
    await expect(fixLink).toHaveAttribute('href', new RegExp(`/listings/${unitId}$`));
    await expect(fixLink).toHaveAttribute('target', '_blank');

    // Follow it: a NEW TAB in the same browser context (same session), which
    // leaves the half-built group standing in this one.
    const [propertyTab] = await Promise.all([page.waitForEvent('popup'), fixLink.click()]);
    await propertyTab.waitForLoadState('domcontentloaded');
    await expect(propertyTab).toHaveURL(new RegExp(`/listings/${unitId}$`));
    const card = contactsCard(propertyTab);
    const makeMark = card.getByRole('button', { name: `Make ${mark.name} primary` });
    await expect(makeMark).toBeVisible({ timeout: 20_000 });
    await makeMark.click();
    await expect(card.getByText('No primary contact.')).toHaveCount(0, { timeout: 20_000 });
    await propertyTab.close();

    // Back in the still-open dialog: Check again re-runs the preview.
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Check again' }).click();
    await expect(box).toHaveCount(0, { timeout: 20_000 });

    // The preview is now the TOUR intro naming Mark and the street - and the
    // UNEDITED draft followed it (spec 7.2).
    const after = await previewOpen(req, tourId);
    expect(after.introFallback).toBeUndefined();
    expect(after.body.startsWith(`Hey ${tenant.firstName}!`), after.body).toBeTruthy();
    expect(after.body).toContain(`Putting you in a group text with ${mark.firstName}`);
    expect(after.body).toContain(`to tour ${street}`);
    await expect(draft).toHaveValue(after.body);

    // Nothing is provisioned: Cancel closes the dialog.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
  });

  test('(c) removing the primary from a property with no landlord hands it to the earliest eligible contact', async ({
    page,
  }) => {
    test.slow(); // build-a-world plus three roster writes.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // Added FIRST, but a tenant - on the list by accident: never picked automatically.
    const tenant = await createContact(req, 'tenant', `Pchten${stamp}`);
    const first = await createContact(req, 'landlord', `Pcha${stamp}`);
    const second = await createContact(req, 'landlord', `Pchb${stamp}`);
    const unitId = await createZeroPrimaryProperty(req, {
      street: freshStreet(stamp),
      rows: [
        { contactId: tenant.contactId, role: 'other' },
        { contactId: first.contactId, role: 'pm' },
        { contactId: second.contactId, role: 'owner' },
      ],
    });

    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = contactsCard(page);
    // Three live, non-caseworker rows: the box asks for a deliberate choice.
    await expect(card.getByText('No primary contact.')).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Choose a primary' }).click();
    // ...which is the card's edit mode.
    await expect(page.getByRole('button', { name: 'Done editing contacts' })).toBeVisible();

    // Make the LATER-added landlord the primary contact.
    const makeSecond = page.getByRole('button', { name: `Make ${second.name} the primary contact` });
    await makeSecond.click();
    await expect(makeSecond).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByText('No primary contact.')).toHaveCount(0);

    // Remove them: the confirm names the heir from the server's block - the
    // earliest-added ELIGIBLE contact, skipping the tenant added before it.
    await page.getByRole('button', { name: `Remove ${second.name} from this property` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the primary contact?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        `${first.name} becomes the primary contact - new tours and relay groups for this property will use them.`,
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove contact' }).click();
    await expect(page.getByRole('button', { name: `Remove ${second.name} from this property` })).toHaveCount(0, {
      timeout: 20_000,
    });

    // The handoff landed: the first landlord is primary, the tenant is not.
    await expect(page.getByRole('button', { name: `Make ${first.name} the primary contact` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Make ${tenant.name} the primary contact` })).toBeVisible();
    await page.getByRole('button', { name: 'Done editing contacts' }).click();
    await expect(card.getByRole('link', { name: new RegExp(`^${first.name} \\(primary\\)`) })).toBeVisible();
    await expect(card.getByText('No primary contact.')).toHaveCount(0);

    const unit = await readUnit(req, unitId);
    expect(unit.landlordId).toBeUndefined();
    expect(unit.primary_contact).toBe(first.contactId);
    expect(unit.contacts).toEqual([
      expect.objectContaining({ contactId: tenant.contactId, role: 'other', primaryContact: false }),
      expect.objectContaining({ contactId: first.contactId, role: 'pm', primaryContact: true }),
    ]);
  });
});
```

2. Typecheck the e2e workspace, then run the spec (it boots its own
hermetic lane; never point it at `:5174` / `:8080`):

```bash
cd "W:/tmp/primary-contact-integrity/e2e" && npm run typecheck
```

Expected: exit 0.

```bash
cd "W:/tmp/primary-contact-integrity" && timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/primary-contact-integrity.spec.ts
```

Expected (see the note at the top of the task - no RED step): `3 passed`,
exit 0.

3. Implementation: none beyond step 1 (the spec pins S1-S4 + S5.5).

4. GREEN is step 2's run. If a selector does not match S4's DOM, read S4's
component before touching the spec: change the spec only when S4's DOM is
spec-correct (spec 7.1 / 7.3 / 7.4 copy and roles) and the locator was wrong;
otherwise S4 has a defect - report it.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only the two new e2e files, no merge in progress, and no
`e2e/.artifacts` path (gitignored).

```bash
git -C "W:/tmp/primary-contact-integrity" add e2e/fixtures/primaryContact.ts e2e/tests/dashboard-next/primary-contact-integrity.spec.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "test(e2e): primary contact integrity - the property box, the open-group fallback box with Check again, the remove handoff" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.7 - e2e: property-roster.spec follows the spec-7.3 remove notice

S4 changed the remove-the-primary notice (spec 7.3: "calls and" dropped;
"new tours and relay groups ... will use them"). The existing walk asserts the
old copy, so it is RED after S4.

**Files:**
- Modify: `e2e/tests/dashboard-next/property-roster.spec.ts`

**Steps:**

1. The failing test already exists. Confirm it:

```bash
cd "W:/tmp/primary-contact-integrity" && timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts
```

2. Expected RED: `1 failed` (`add a PM, make them primary, and the tour People
card follows - then falls back on removal`) with
`Timed out 15000ms waiting for expect(locator).toBeVisible()` on
`getByText('<owner> becomes the primary contact - calls and new relay groups for this property will go to them.')`;
`3 passed`.

3. Implement. Edit old_string:

```ts
    await expect(
      dialog.getByText(
        `${owner.name} becomes the primary contact - calls and new relay groups for this property will go to them.`,
      ),
    ).toBeVisible();
```

new_string:

```ts
    // The heir is read from the server's propertyContact block (spec 7.3 of
    // primary-contact-integrity): the landlord of record, who is live here.
    await expect(
      dialog.getByText(
        `${owner.name} becomes the primary contact - new tours and relay groups for this property will use them.`,
      ),
    ).toBeVisible();
```

4. Run GREEN:

```bash
cd "W:/tmp/primary-contact-integrity" && timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts
```

Expected: `4 passed`, exit 0.

5. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `e2e/tests/dashboard-next/property-roster.spec.ts`, no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add e2e/tests/dashboard-next/property-roster.spec.ts
git -C "W:/tmp/primary-contact-integrity" commit -m "test(e2e): property-roster asserts the spec-7.3 remove notice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.8 - e2e docs: selectors and the dev-only surface

Docs task: exact text below. ASCII only.

**Files:**
- Modify: `e2e/support/selectors.md`
- Modify: `e2e/README.md`

**Steps:**

1. `e2e/support/selectors.md` - the remove confirm row, plus the new
property-box row. Edit old_string (the whole existing row):

```
| Property page (Contacts card) | remove-the-primary confirm | `getByRole('dialog', { name: 'Remove the primary contact?' })`, whose body NAMES the promotion: `<Landlord of record> becomes the primary contact - calls and new relay groups for this property will go to them.` (or `This property will have no primary contact and has no landlord of record, so calls and new relay groups for it will reach no one until someone on its contact list is made the primary contact or a new contact is added.` when the property has no landlordId). Confirm with `getByRole('button', { name: 'Remove contact' })` SCOPED to the dialog - the card behind it still holds every row's Remove |
```

new_string:

```
| Property page (Contacts card) | remove-the-primary confirm | `getByRole('dialog', { name: 'Remove the primary contact?' })`, whose body NAMES who takes over, read from the unit GET's `propertyContact.heirIfPrimaryRemoved` (primary-contact-integrity spec 7.3): `<Heir name> becomes the primary contact - new tours and relay groups for this property will use them.` - the heir is the landlord of record when live, else the earliest-added contact typed landlord, never a tenant or a caseworker (`Another contact on this property becomes the primary contact.` when the heir has no name); `This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.` when nobody can take over; `Another contact on this property may become the primary contact.` when the server could not tell. Confirm with `getByRole('button', { name: 'Remove contact' })` SCOPED to the dialog - the card behind it still holds every row's Remove. A remove the server cannot decide (a contact read failed) is refused 503 and the row's error slot reads `Couldn't check the other contacts - try again.` |
| Property page (Contacts card) | no-primary box | above the rows, ONLY when the unit GET carries a `propertyContact` block that names nobody and the property has at least one row (never on a deleted property). Scope it to the card: `page.locator('section').filter({ has: page.getByRole('heading', { name: /^Contacts\b/ }) })` - Card.tsx renders a plain `<section>`, and the heading's name carries the `Edit contacts` label too - because `getByText` is a case-insensitive substring match and the remove confirm's no-heir notice also contains "no primary contact.". Lead `No primary contact.` (or `This property's contact was deleted.`), then `New tours won't include the landlord, and tour group texts use the general intro.` The action counts the live, non-caseworker rows: one -> `getByRole('button', { name: 'Make <Full Name> primary' })` (NOT the edit-mode `Make <Full Name> the primary contact`); two or more -> `getByRole('button', { name: 'Choose a primary' })`, which opens the card's edit mode; none -> no button and the text `Add the landlord or property manager - they become the primary automatically.` A deleted contact's row reads `(deleted)` after the name and offers no make-primary control. The UI cannot reach this state and the lean seed has none: build it with `createZeroPrimaryProperty` (`fixtures/primaryContact.ts`, the Dev seam row below) |
```

2. `e2e/support/selectors.md` - the duplicate-warning row's uniqueness claim.
Edit old_string:

```
**Always scope it to the dialog**: `role="status"` is unique INSIDE the dialog (RosterConfirmDialog.test.tsx pins that, so nothing else in the dialog body may take the role - a `Spinner` inside it would break every locator here), but it is NOT unique at page level.
```

new_string:

```
**Always scope it to the dialog AND filter it by its text** (`.filter({ hasText: 'already have' })`): since primary-contact-integrity the tour and placement OPEN dialog can also show the general-intro box (its own row below), a second `role="status"` inside the dialog, and `role="status"` is NOT unique at page level either. (The standalone create dialog never shows that box.)
```

3. `e2e/support/selectors.md` - the general-intro box row, before the quiet
hours row. Edit old_string:

```
| Roster confirm dialogs (both) | INSIDE quiet hours |
```

new_string:

```
| Tour / placement hub (open confirm) | general-intro box | `getByRole('dialog', { name: 'Open the relay group?' }).getByRole('status').filter({ hasText: 'Using the general intro, not the tour intro.' })` (`... not the placement intro.` on a placement) - rendered when the server's preview carries `introFallback`, which only the tour and placement OPEN previews set (never the standalone create, never an add). ALWAYS filter by that heading: the duplicate-group warning is a second `role="status"` in the same dialog. One line per reason, in order - e.g. `<street> has no primary contact, so the intro can't name the landlord.` with the NEW-TAB link `getByRole('link', { name: 'Set a primary contact' })` (href `/listings/<unitId>`; follow it with `page.waitForEvent('popup')` - the tab shares the session), and `This tour has no date and time yet.` on EVERY timeless tour, so most tour walks in this suite now show the box. `getByRole('button', { name: 'Check again' })` re-fetches the preview: the box goes once nothing is missing, and an UNEDITED draft takes the new body (an edited draft is kept, with `The intro changed.` and a `Use the updated intro` button) |
| Roster confirm dialogs (both) | INSIDE quiet hours |
```

4. `e2e/support/selectors.md` - the seam row, before the org-fixture seam
row. Edit old_string:

```
| Dev seam | put a value NOT on the organization list |
```

new_string:

```
| Dev seam | a property with NO primary contact and no landlord of record | `POST /__dev/fixtures/zero-primary-property { street, rows: [{ contactId, role: 'pm'\|'owner'\|'other' }] }` -> 201 `{ unitId }`, via `fixtures/primaryContact.ts` `createZeroPrimaryProperty`. A NEW property in the imported shape: no `landlordId`, the rows NON-primary in the order given (1 to 5, each contact once; `landlord` is refused), status `setup`, address line1 = `street`. Create the contacts first through `POST /api/contacts` (the real create: phones, pointer rows, types). It never touches an existing unit, so the lean world stays byte-stable. The only way to reach the state: a new property needs a landlord, and an add on an ownerless property makes an eligible contact primary at once |
| Dev seam | put a value NOT on the organization list |
```

5. `e2e/README.md` - the dev-only surface list. Edit old_string:

```
  value under Settings > "Not on the list" - nothing off-list is seeded.
```

new_string:

```
  value under Settings > "Not on the list" - nothing off-list is seeded.
- `POST /__dev/fixtures/zero-primary-property` - create a NEW property in the
  imported shape: no landlord of record, the given contacts as NON-primary
  rows (`{ street, rows: [{ contactId, role: pm|owner|other }] }` -> 201
  `{ unitId }`). The only way to reach a property with no primary contact -
  the UI requires a landlord and the lean seed has none on purpose. Create the
  contacts first through `POST /api/contacts`; it never touches an existing
  unit (`fixtures/primaryContact.ts`).
```

6. `e2e/README.md` - the fixtures layout line. Edit old_string:

```
plant an off-list value through `/__dev/org-fixture`, and `waitForRewrite`).
```

new_string:

```
plant an off-list value through `/__dev/org-fixture`, and `waitForRewrite`), `primaryContact` (`createZeroPrimaryProperty` - a NEW property with no primary contact and no landlord of record, through `/__dev/fixtures/zero-primary-property`).
```

7. Verify ASCII on both files' added lines:

```bash
cd "W:/tmp/primary-contact-integrity" && git diff -U0 -- e2e/support/selectors.md e2e/README.md | grep -nP '^\+.*[^\x00-\x7F]' ; echo "non-ascii-check-done"
```

Expected: only `non-ascii-check-done` (no `+` line printed).

8. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only the two docs, no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add e2e/support/selectors.md e2e/README.md
git -C "W:/tmp/primary-contact-integrity" commit -m "docs(e2e): selectors for the no-primary box, the general-intro box and the new remove notice; the zero-primary dev seam" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.9 - GLOSSARY: "property contact" added, "primary contact" updated (spec 12)

Docs task. ASCII only.

**Files:**
- Modify: `documentation/GLOSSARY.md`

**Steps:**

1. Replace the primary contact entry. Edit old_string:

```
- **primary contact** (contact-rosters, 2026-08-04) - the property-side person we
  put on relay groups and reach by a masked call: the unit's DEFAULT contact. Code
  and data: the roster-row flag `UnitContact.primaryContact` plus the unit scalar
  `primary_contact`, which `unitsRepo.addContact` / `removeContact` keep
  consistent with each other. AT MOST ONE per unit (zero is legal and reachable -
  removing the primary from a unit with no `landlordId` clears both). Staff see it
  as the "primary" on the property's Contacts card. RENAMED 2026-08-04 from
  `primaryVoice` / `primary_voice_contact`: the old names meant only "the
  landlord-side person a masked tenant call routes to", and the concept widened to
  cover relay groups as well as calls (persisted keys were renamed too - safe only
  because prod is not live yet and dev reseeds).
```

new_string:

```
- **primary contact** (contact-rosters, 2026-08-04; kept usable by
  primary-contact-integrity, 2026-10-13) - the property-side person the app puts
  on a tour's or placement's default people list and names in the relay intro and
  the tour reminders: the unit's DEFAULT contact (read through the **property
  contact** lookup, below). Code and data: the roster-row flag
  `UnitContact.primaryContact` - THE FLAG IS THE TRUTH. The unit scalar
  `primary_contact` mirrors it, is written only by the roster writes (and the
  one-time `app/scripts/assign-primary-contacts.ts`), never by a unit create or
  PATCH, and is ABSENT on a landlord-only unit, whose primary is the DERIVED
  landlord row (`unitContacts()`); nothing reads the scalar at runtime, so code
  that needs "who is primary" reads `unitContacts(unit)`. AT MOST ONE per unit.
  The HANDOFF rule (spec
  `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`,
  section 4): when the primary is removed from the property, deleted, or cleared
  by "Restore without a landlord", the HEIR takes over - the landlord of record
  when live, else the earliest-added contact eligible for automatic routing
  (typed landlord, live, not a phone or email routing pointer: never a tenant or
  a caseworker) - and an add or an edit of an eligible contact on a property
  with no live primary and no live landlord of record makes THAT contact
  primary. So zero primary is reachable when nobody can take over (no live
  landlord of record and no eligible live contact), when only NON-eligible
  contacts were added (a tenant or partner is never promoted automatically),
  after an explicit API write that sends `primaryContact: false` for the
  current primary's own row, or for legacy data the script has not repaired;
  the property's Contacts card then shows a "No primary contact." box (with a
  live landlord of record the lookup still uses the landlord). A DELETED contact can stay flagged when nobody could
  take over; the property contact lookup skips it. Staff see the primary as
  "(primary)" on the property's Contacts card. RENAMED 2026-08-04 from
  `primaryVoice` / `primary_voice_contact`: the old names meant only "the
  landlord-side person a masked tenant call routes to", and the concept widened
  to cover relay groups as well as calls (persisted keys were renamed too - safe
  only because prod is not live yet and dev reseeds).
```

2. Add the property contact entry after the landlord of record entry. Edit
old_string:

```
  "primary landlord" wording collided with the primary contact, which is exactly
  the ambiguity this pair of names removes.
```

new_string:

```
  "primary landlord" wording collided with the primary contact, which is exactly
  the ambiguity this pair of names removes.

- **property contact** (primary-contact-integrity, 2026-10-13) - who the app
  actually USES for a property, given a tenant: the answer of the ONE shared
  lookup in `app/src/lib/propertyContact.ts` (`resolvePropertyContact` /
  `decidePropertyContact`). It walks the flagged **primary contact**, then the
  **landlord of record** when set and different; a deleted or missing contact
  is skipped, a candidate who IS the tenant stops the walk (nobody), and a read
  that fails stops it too (never read as "deleted"). It is what the tour and
  placement default people lists, the relay intros, the tour reminders and the
  "cannot open a group" diagnostics use. Distinct from the primary contact (a
  stored flag, which can name a deleted contact) and from the landlord of
  record (the owner). When it finds nobody, an owned group opens with the
  general intro and the open-group dialog says why; the property page reads it
  as the unit's `propertyContact` block. Staff copy keeps saying "primary
  contact" - that is what they set.
```

3. Verify ASCII:

```bash
cd "W:/tmp/primary-contact-integrity" && git diff -U0 -- documentation/GLOSSARY.md | grep -nP '^\+.*[^\x00-\x7F]' ; echo "non-ascii-check-done"
```

Expected: only `non-ascii-check-done`.

4. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `documentation/GLOSSARY.md`, no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add documentation/GLOSSARY.md
git -C "W:/tmp/primary-contact-integrity" commit -m "docs(glossary): property contact; primary contact - the flag is the truth, the handoff rule, when zero primary is reachable" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.10 - RUNBOOK: the assign-primary-contacts section (owed with the deploy)

Docs task (spec 8 and 13), in the clean-org-names / join backfill style.
ASCII only. The printed lines quoted below are exactly `formatAssignSummary`'s
(Task S5.3) - keep them in step.

**Files:**
- Modify: `RUNBOOK.md`

**Steps:**

1. Insert the section before the Caseworkers section. Edit old_string:

```
### Caseworkers (`feat/caseworkers`): DEPLOYED dev + prod 2026-10-12 (release 1.5.1) - nothing was owed; the conversion's repair, and putting a mistaken conversion back
```

new_string:

```
### Primary contacts backfill (`feat/primary-contact-integrity`): owed on dev AND prod after this branch deploys - dry run, then `--apply`

**NOT YET RUN - owed on dev AND prod once this branch has deployed there; take dev all the way through before prod.** No Terraform, no secrets, no env var, no schema or index change. Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`, sections 8 and 13. Run it AFTER that environment's deploy: until then the old app can still leave a property with no primary contact (removing the primary from a property with no landlord, or deleting a contact, left nobody) and the old unit PATCH can still write the `primary_contact` field. It is safe at any time and re-runnable, but after the deploy one pass catches them all.

What `app/scripts/assign-primary-contacts.ts` does: it gives a primary contact to every property whose primary contact is missing or deleted, when someone can take over - the repair for properties like 470 Bolton (imported with no landlord of record; its only contact added later as Property Manager and never made primary), whose tours open their group texts with the general intro and leave that contact off new tours. It reads every property (soft-deleted ones included) with one consistent Scan, and for each one ONE complete read of the contacts its contact list and landlord of record name. A property is a TARGET when its flagged primary contact is absent, deleted or missing AND someone can take over - the HEIR, by the app's own rule (`chooseHeir`, `app/src/lib/propertyContact.ts`): the landlord of record when live, else the earliest-added contact on the list that is eligible for automatic routing (typed landlord, live, not a phone or email routing pointer - never a tenant or a caseworker). For each target it makes ONE conditional write: the heir becomes the only primary row (a landlord of record with no row on the list gets a `landlord` row), the `primary_contact` field names it, and one `unit_primary_contact_assigned` audit event `{ contactId, reason: 'backfill', from }` is appended with no actor (`from` names the deleted contact that was flagged, when there was one) - the property's Activity tab shows it. It also ALIGNS the `primary_contact` field on a property whose flagged primary is live but whose field is empty or names someone else (the same conditional write, the contact list unchanged, no audit event - the primary did not change); a property with no stored contact list (its primary is its landlord of record, derived) is left alone. Nothing reads that field at runtime; it is kept consistent for the masked-call path not yet built. Every write is conditional on the property's contact list AND landlord of record still being exactly what the run read: a property changed meanwhile (someone made a contact primary, added or removed one) is counted `skippedOnCondition` and left for a re-run - the script never overwrites a choice made after it read. It takes no lock (every write is conditional, so two runs at once cannot double-write). Idempotent: a re-run of a completed apply plans nothing.

Counted and NOT written: `noHeir` - no live contact and no live landlord of record (nothing anyone can do; an ownerless property with no contacts counts here); `noEligible` - live contacts exist but none is eligible for automatic routing (only a tenant or a caseworker), listed by property id: on each one the Contacts card's "No primary contact." box lets Sam choose by name; `unknown` - the contact read for that property failed (throttling): re-run.

Target handling is the automation scripts' (above): `--env local|dev|prod` resolves the tables AND the credentials itself (`app/scripts/lib/stageClient.ts`); `dev`/`prod` run the account guard on the `housingchoice` profile BEFORE any table is read, pin the regional endpoint and refuse to start while an `AWS_ENDPOINT_URL*` variable is set. Unknown or repeated arguments, and `--lane` with `dev`/`prod`, are usage errors (exit 2, nothing run).

1. **Dry run (the DEFAULT; writes nothing), after that environment's deploy:** `npx tsx app/scripts/assign-primary-contacts.ts --env dev`. After its JSON log lines (counts, property ids and contact ids - never a name), it prints:
   - `Primary contacts - DRY RUN, nothing written:` then `Properties scanned: N (D soft-deleted)`, `Would get a primary contact: T (S on soft-deleted properties)`, `primary_contact field would be aligned with the flagged primary: A`, `No heir - no live contact and no live landlord of record (nothing to do): H`, `No eligible contact - only a tenant or a caseworker is live (choose one on the property page): E`, `Unknown - a contact read failed (re-run): U`, `Already fine: F`;
   - the property ids of each list (`none` when empty): `Properties that would get a primary contact: ...`, `Properties whose primary_contact field would be aligned: ...`, `Properties with no eligible contact (open each one and choose a primary contact): ...`, `Properties that could not be decided (re-run): ...`.
   Ids only - never a name, phone or street. The `done` log line carries the same counts (`targets`, `targetsOnDeletedUnits`, `scalarAligned`, `noHeir`, `noEligible`, `unknown`, `unchanged`), and each property that needs anything gets its own line with its `unitId` and the heir's `contactId`. Spot-check a target or two before applying: `/listings/<unitId>` shows the "No primary contact." box (or "This property's contact was deleted.") on its Contacts card.
2. **Apply:** `npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply`. The summary heads `Primary contacts - APPLIED:`, says `Planned a primary contact: T (...)` and `Primary contacts assigned: N`, and adds `Skipped - the property changed after the run read it (re-run): S`, `Writes that FAILED (re-run the dry run to see): W` and `Audit events that may not have been written: X (expected 0)`, with the skipped and failed property ids. `skippedOnCondition > 0` (a WARN `done` line, exit 0): re-run the apply. `unknown > 0` or a failed write (`COMPLETED WITH FAILURES`, exit 1): re-run the dry run, then the apply - a failed write may or may not have landed; a property no longer listed got its primary (only its audit event may be missing). An audit event that may not have been written is a WARN line naming the property; its primary WAS assigned, and a re-run cannot write the event.
3. **Re-run the dry run:** it must show `Would get a primary contact: 0 (...)` and `primary_contact field would be aligned with the flagged primary: 0`; what is left is `noHeir` (nothing to do) and `noEligible` (step 4).
4. **Hand the `noEligible` list to Sam:** on each property, the box's "Make <Name> primary" or "Choose a primary" sets it in one click.
5. **Then prod**, the same steps after prod's deploy.

Until the script runs, a property in the broken state shows the "No primary contact." box on its Contacts card and Sam can fix it by hand; the open-group dialog of a tour there says why the general intro is used and links to the property.

Cost: one consistent Scan of the units table, one contact batch read per property, and on an apply one conditional write (plus one audit event for a target) per changed property - seconds at today's volume. Exit codes: 0 the run completed (skipped properties included - re-run for them); 1 it completed with failures (`unknown` or a failed write), aborted (a `PARTIAL` ERROR line - the Scan failed; every write is conditional, so re-running is safe), or the target could not be resolved (nothing read); 2 usage. On a failure the last line names it: `assign-primary-contacts - FAILED: <the error>`.

**No agent runs it against dev or prod; an agent rehearses on a lane: `--env local --lane <L>`.** Never a bare `--env local` - that is the live local stack. A rehearsal builds its broken properties through the dev seam `POST /__dev/fixtures/zero-primary-property` (`e2e/README.md`, Dev-only surface).

### Caseworkers (`feat/caseworkers`): DEPLOYED dev + prod 2026-10-12 (release 1.5.1) - nothing was owed; the conversion's repair, and putting a mistaken conversion back
```

2. Correct the caseworker section's description of "Restore without a
landlord" (its sole-landlord promotion is replaced, spec 4.6). Edit old_string:

```
the remaining contacts' types are read before its write (to find the one landlord-typed contact to make the primary contact), and the write is conditioned on the contact list it read
```

new_string:

```
the remaining contacts are read before its write (when the cleared landlord was the primary contact, to pick who takes over: since `feat/primary-contact-integrity` the earliest-added contact eligible for automatic routing, and a read that fails refuses the restore with nothing written), and the write is conditioned on the contact list it read
```

3. Verify ASCII:

```bash
cd "W:/tmp/primary-contact-integrity" && git diff -U0 -- RUNBOOK.md | grep -nP '^\+.*[^\x00-\x7F]' ; echo "non-ascii-check-done"
```

Expected: only `non-ascii-check-done`.

4. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only `RUNBOOK.md`, no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add RUNBOOK.md
git -C "W:/tmp/primary-contact-integrity" commit -m "docs(runbook): primary contacts backfill owed on dev and prod after the deploy - dry run, then --apply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.11 - issues: tour-reminder-zero-primary-e2e-gap item 1 partially addressed

Docs task (spec 12). `docs/issues/relay-provision-includes-deleted-contacts.md`
stays OPEN and is NOT edited: it already states what this branch closes (the
property-contact route) and what stays exposed (a member added by hand).
ASCII only.

**Files:**
- Modify: `docs/issues/tour-reminder-zero-primary-e2e-gap.md`

**Steps:**

1. Frontmatter. Edit old_string:

```
created: 2026-08-26
refs: e2e/scenarios/steps.ts, app/test/tourContacts.test.ts, app/test/tourReminders.test.ts, app/test/relayApi.test.ts, app/test/tourRemindersApi.test.ts
```

new_string:

```
created: 2026-08-26
updated: 2026-10-13
refs: e2e/scenarios/steps.ts, app/test/tourContacts.test.ts, app/test/tourReminders.test.ts, app/test/relayApi.test.ts, app/test/tourRemindersApi.test.ts, app/src/routes/dev.ts, e2e/tests/dashboard-next/primary-contact-integrity.spec.ts
```

2. Item 1's update. Edit old_string:

```
   deferred by adjudication 2026-08-26, not overlooked.
```

new_string:

```
   deferred by adjudication 2026-08-26, not overlooked.

   **Update (2026-10-13, `feat/primary-contact-integrity`): the OWNERLESS leg
   now has an e2e path; the landlord-fallback leg is still open.** A dev-only
   seam, `POST /__dev/fixtures/zero-primary-property` (`app/src/routes/dev.ts`),
   creates a NEW property in the imported shape - no landlord of record, the
   given contacts as non-primary rows - without touching the byte-stable lean
   seed. `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts` drives
   it: a booked tour on such a property previews its relay group with the
   GENERAL intro and the open-group dialog says why, and once the property has
   a primary contact, Check again turns the preview into the tour intro naming
   that contact. Still without an e2e path: a property WITH a landlord of
   record whose contact list has rows but no primary, where the lookup falls
   back to the landlord. The same seam could carry it with a `landlordId`
   option; not built, because that branch did not change that fallback.
```

3. Verify ASCII:

```bash
cd "W:/tmp/primary-contact-integrity" && git diff -U0 -- docs/issues/tour-reminder-zero-primary-e2e-gap.md | grep -nP '^\+.*[^\x00-\x7F]' ; echo "non-ascii-check-done"
```

Expected: only `non-ascii-check-done`.

4. Commit:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only the issue file, no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add docs/issues/tour-reminder-zero-primary-e2e-gap.md
git -C "W:/tmp/primary-contact-integrity" commit -m "docs(issues): tour-reminder-zero-primary-e2e-gap - the ownerless leg now has an e2e path" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Task S5.12 - FINAL: sync main once, then the five completion gates

AGENTS.md "Required completion gates". Everything below runs from the
feature worktree, in Git Bash, each gate as its OWN command, BARE: never
piped, never `;`-chained behind another gate (a pipe or a chain reports the
wrong command's exit code). Long gates run in the background with output
REDIRECTED to a file (a redirect is not a pipe). Quote every real exit code.

**Files:**
- (merge commit only, unless a gate needs a fix)
- Create: `docs/superpowers/reviews/2026-10-12-primary-contact-integrity/S5-gates.md` (the gate record)

**Steps:**

1. State. Read both:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Expected: `On branch feat/primary-contact-integrity`, `nothing to commit,
working tree clean`.

```bash
test -f "$(git -C "W:/tmp/primary-contact-integrity" rev-parse --git-dir)/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

Expected: `no-merge`. Also confirm no e2e session or suite is live for this
worktree (`e2e/.artifacts/session.pid` absent or its process gone; the
lane's four ports in `e2e/.artifacts/lane.json` free) - never run the full
suite beside an interactive session, and never adopt an orphaned stack.

2. Sync `main` ONCE (AGENTS.md: sync the latest `main` into the branch at
the final pre-handback step; report later drift rather than chasing it):

```bash
git -C "W:/tmp/primary-contact-integrity" rev-list --count HEAD..main
```

If `0`: nothing to merge - record "main already merged" and go to step 3.
Otherwise:

```bash
git -C "W:/tmp/primary-contact-integrity" merge --no-ff main -m "Merge main into feat/primary-contact-integrity (pre-handback sync)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

On a conflict, resolve it preserving BOTH sides' intent, `git add` the
explicit resolved paths, then `git -C "W:/tmp/primary-contact-integrity" commit --no-edit`.
If a conflict is in a file this branch changed in meaning (`unitsRepo.ts`,
`routes/units.ts`, `routes/contacts.ts`, `ListingDetail.tsx`,
`RosterConfirmDialog.tsx`, `relayFanOut.ts`, `rosterEdits.ts`) and the right
resolution is not obvious, `git -C "W:/tmp/primary-contact-integrity" merge --abort`
and STOP: report it rather than guess. After a merge, check whether it moved
dependencies:

```bash
git -C "W:/tmp/primary-contact-integrity" diff --name-only HEAD^1 HEAD -- package-lock.json package.json app/package.json dashboard/package.json e2e/package.json
```

Non-empty -> `cd "W:/tmp/primary-contact-integrity" && npm install` before the gates.

3. The lean seed is byte-stable (C13):

```bash
git -C "W:/tmp/primary-contact-integrity" diff --name-only main...HEAD -- app/src/lib/seed app/src/lib/seedData.ts
```

Expected: NO output. Any path listed is a C13 violation - stop and report.

4. Pre-gate environment:

```bash
cd "W:/tmp/primary-contact-integrity" && npm run db:start
```

Expected: `db:start - ... already running` or a started container (it never
restarts a running one; never stop or restart the shared container).

```bash
env | grep '^AWS_' ; echo "aws-env-check-done"
```

If any `AWS_ACCESS_KEY_ID` is printed, gate 2 runs as
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` (AGENTS.md: an
exported key collapses every app test file onto one DynamoDB Local database).

```bash
mkdir -p "W:/tmp/primary-contact-integrity/.superpowers/sdd/gates"
```

5. **Gate 1 - typecheck** (bare, foreground):

```bash
cd "W:/tmp/primary-contact-integrity" && npm run typecheck
```

Expected: exit 0, no `error TS` line in any workspace.

6. **Gate 2 - npm test** (background, redirected; ~3+ min per workspace):

```bash
cd "W:/tmp/primary-contact-integrity" && npm test > .superpowers/sdd/gates/npm-test.log 2>&1
```

Expected: exit 0. Then read the result:

```bash
grep -nE "Test Files|Tests  |FAIL|\[dynamoAdmin\]" "W:/tmp/primary-contact-integrity/.superpowers/sdd/gates/npm-test.log"
```

Every workspace's `Test Files` line with no `failed`; no `FAIL` line. ANY
`[dynamoAdmin]` line is one real container fault: capture that run's
`err.$metadata.httpStatusCode` and `attempts` and report it
(`docs/issues/dynamo-local-control-plane-fault-shape-unverified.md`). If red
on DynamoDB Local suites, adjudicate by re-run-and-compare, never by the old
`AWS_ACCESS_KEY_ID` recipe: re-run each failing FILE alone more than once
(`cd "W:/tmp/primary-contact-integrity/app" && npx vitest run test/<file>`),
run the full suite at the merge base, and compare failing FILES (not cases),
reporting both runs. There is no named-flake list: any other failing test is
a regression to diagnose.

7. **Gate 3 - smoke** (bare, foreground; about a second after the build):

```bash
cd "W:/tmp/primary-contact-integrity" && npm run smoke
```

Expected: exit 0 (every import in the compiled `app/dist` resolves under
plain node).

8. **Gate 4 - e2e** under the hard outer cap (background, redirected). Never
edit source or commit while it runs (it serves the source live):

```bash
cd "W:/tmp/primary-contact-integrity" && timeout 2700 npm run e2e > .superpowers/sdd/gates/e2e.log 2>&1
```

Expected: exit 0. Exit 124 = the 2700 s cap fired = a gate FAILURE - report
it; do not raise the cap on your own (ruling R24: recent Windows full-suite runs took 22-34 minutes). Read the result:

```bash
grep -nE "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)" "W:/tmp/primary-contact-integrity/.superpowers/sdd/gates/e2e.log"
```

Expected: `N passed`, no `failed`. On a failure: FIRST copy
`e2e/.artifacts/test-results` to `.superpowers/sdd/gates/e2e-results-1/`
(a re-run overwrites it), confirm the lane's ports are free before any
re-run, and diagnose to root cause. A named-spec failure is a REGRESSION, not
a flake. For a CONTENT symptom (a missing row, a wrong payload) re-run with
`E2E_CHILD_LOG_DIR=.artifacts/child-logs`; for a TIMING symptom (a hang, a
budget) use `E2E_TRACE=1` instead - never the child-log flag (it changes the
timings).

9. **Gate 5 - lint the files this branch touched.** First the list (it must
NOT be empty - this branch touches many `.ts` / `.tsx` files; an empty list
means the merge-base is wrong, so stop - and never run `npx eslint` with no
paths, which lints the whole repo):

```bash
cd "W:/tmp/primary-contact-integrity" && git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'
```

Then the gate, exactly as AGENTS.md states it, output kept for the
comparison:

```bash
cd "W:/tmp/primary-contact-integrity" && npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') > .superpowers/sdd/gates/lint-head.txt 2>&1
```

Exit 0 -> done. Errors -> attribute them by BASELINE COMPARISON, never by line
number (deleting the last use of an import fires `no-unused-vars` on the
import line, which the diff never touched). Lint the SAME paths as they are
at the merge base:

```bash
cd "W:/tmp/primary-contact-integrity" && BASE=$(git merge-base main HEAD) && : > .superpowers/sdd/gates/lint-base.txt && for f in $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'); do if git cat-file -e "$BASE:$f" 2>/dev/null; then echo "== $f" >> .superpowers/sdd/gates/lint-base.txt; git show "$BASE:$f" | npx eslint --stdin --stdin-filename "$f" >> .superpowers/sdd/gates/lint-base.txt 2>&1; else echo "== $f (NEW on this branch: no baseline - every error in it is ours)" >> .superpowers/sdd/gates/lint-base.txt; fi; done; echo "baseline-done"
```

(This loop is a diagnostic, not a gate, so its pipe is fine.) Compare
`lint-head.txt` with `lint-base.txt` per FILE by rule id and message,
ignoring line:column: anything present in head and absent in base is OURS and
BLOCKING - fix it, re-run gates 1 and 5 (and the touched workspace's tests),
and commit the fix with explicit paths. Everything else is pre-existing (as
of 2026-10-07: 23 errors, all `react-hooks/*`, in 18 dashboard files): leave
it, and NAME each in the handback so nobody re-diagnoses it as ours. Known
hole: the config lints `.ts` / `.tsx` only - a green result on a `.mjs` /
`.js` path checked nothing.

10. Record the gates - create
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/S5-gates.md`:

```
# S5 completion gates - feat/primary-contact-integrity

Branch tip: <git rev-parse --short HEAD>
main merged: <the merge commit's short sha, or "main already merged at <sha>">
Lean seed diff vs main (C13): empty

| gate | command | exit |
|---|---|---|
| 1 typecheck | npm run typecheck | <code> |
| 2 test | npm test | <code> (<per-workspace Test Files lines>) |
| 3 smoke | npm run smoke | <code> |
| 4 e2e | timeout 2700 npm run e2e | <code> (<N passed / failed>) |
| 5 lint | npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') | <code> |

Pre-existing lint errors in touched files (baseline-matched, not ours):
<file: rule - message, one per line, or "none">
```

Fill every `<...>` with the real value (ASCII only), then:

```bash
git -C "W:/tmp/primary-contact-integrity" status
```

Read it: only the new record file (plus any gate-fix files already
committed), no merge in progress.

```bash
git -C "W:/tmp/primary-contact-integrity" add docs/superpowers/reviews/2026-10-12-primary-contact-integrity/S5-gates.md
git -C "W:/tmp/primary-contact-integrity" commit -m "docs(records): primary-contact-integrity S5 completion gates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Never merge the branch into `main`; the human merges.
