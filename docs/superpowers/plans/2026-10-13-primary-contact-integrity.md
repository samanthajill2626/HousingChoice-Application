# Primary contact integrity - implementation plan

Status: SKELETON (sections 0-3 binding; slices S1-S5 drafted from it).
Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
(rev 6, approved and reconciled by Cameron 2026-10-13). Section references
below like "spec 4.4" point there.
Worktree: `W:\tmp\primary-contact-integrity`, branch
`feat/primary-contact-integrity`, `main` merged in at 0e565b86
(caseworker-integrity and join-housing-authority included).

## 0. How to execute this plan

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
- Mid-build breakage stated aloud: none expected - every slice leaves `main`'s
  behavior intact for paths it has not reached yet (S1 moves readers onto the
  new lookup with identical results except the stated deleted-contact
  change; S2 changes write paths; S3/S4 add fields and UI).
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
  handoff_on_restore | backfill`; the unit Activity projection whitelist gains
  `reason`.
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
other `/__dev` routes) - body `{ contacts: Array<{ firstName: string;
lastName?: string; type?: 'landlord' | 'tenant' | 'partner'; role?:
UnitContact['role'] }> ; street?: string }` - creates a NEW unit with NO
`landlordId` and those contacts as NON-primary roster rows, returns
`{ unitId, contactIds }`. S5 may refine the body shape (CONTRACT ISSUE).

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

## 4. Slices

(Drafted per slice from sections 0-3; assembled below.)
