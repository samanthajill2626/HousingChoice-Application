# Implementation plan - Caseworker integrity

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
  (APPROVED revision 3 @fc7cff02, Cameron's spec gate 2026-10-12).
- Branch `fix/caseworker-integrity`, worktree `W:\tmp\caseworker-integrity`,
  cut from main @19607658. Mission records:
  `docs/superpowers/reviews/2026-10-12-caseworker-integrity/`.
- Status: PLAN SKELETON (sections 0-3 BINDING). Slice sections S1-S5 are
  appended below by assembly.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for the
  stated reason), implement, run it GREEN, commit. One commit per task unless
  the task says otherwise. A case marked (PIN) is a regression pin that is
  already green on unchanged code - write it, confirm it passes, keep it;
  every task still has at least one real RED case.
- Commits: `git status` first (a separate read), explicit paths only (never
  `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the authoring
  model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for edited files check the added lines of `git diff`.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit tool DECODES `\u` escapes - never type a `\u`
  escape through it.
- Run commands with absolute paths (`cd "W:/tmp/caseworker-integrity/app"`
  etc.); the shell's working directory resets between calls.
- Setup: `npm ci` was run in this worktree by the planner (2026-10-12).
  DynamoDB Local: `npm run db:start` (a START of a stopped container is fine).
  NEVER restart, stop or remove the shared DynamoDB Local container - it holds
  Cameron's local dev data and other agents' lanes. If it misbehaves, stop and
  report.
- Unit runs while building: app `cd "W:/tmp/caseworker-integrity/app"; npx
  vitest run test/<file>`; dashboard `cd "W:/tmp/caseworker-integrity/dashboard";
  npx vitest run src/<path>`; typecheck `cd "W:/tmp/caseworker-integrity"; npm
  run typecheck`. Never pipe a gate command.
- e2e only through `npm run e2e` from the worktree root (or the lane session
  scripts). Never edit dashboard/app source while this worktree's e2e runs
  (the lane serves source live).
- Code names say `unit`; staff copy says "property" (GLOSSARY).
- PARALLEL WORK: another agent builds tracker #14 (the public /join form,
  `app/src/routes/public.ts`, `dashboard/src/routes/public/*`, a backfill
  script) and another works on #3 + #27 (Tenants tab, Sent to tenants,
  Matching page, property-send records). Do not touch their files; keep edits
  to shared files (`dashboard/src/api/types.ts`, `endpoints.ts`,
  `app/src/repos/unitsRepo.ts`, seeds) minimal, local and additive.

## 1. Global constraints (verbatim from the spec)

| name | value |
|---|---|
| tenant-only targets | `housingAuthority`, `voucherSize`, `pets`, `evictions`, `tenure`, `porting`, `status` |
| neutral targets | `firstName`, `lastName`, `phone`, `address` (never fenced, never refused) |
| plan-time refusal | 409 `suggestion_contact_not_tenant` (before the claim; chip kept; dismiss never refused) |
| fence refusal | 409 `suggestion_contact_reclassified` (classification mismatch wins a tie) |
| repo result | `commitContactEffect` union gains `superseded_by_reclassification`; stored journal outcome + run-log verdict as for `superseded_by_human_edit` |
| legacy fallback | tenant-only journal guard WITHOUT `classification_revision` -> effective guard adds `caseworker_conversion: { exists: false }` at all three real-repo sites (:798, :827, :831) and in the fake |
| copy `suggestion_contact_reclassified` | "This contact's type or role changed after the AI suggested it, so nothing was applied." |
| copy `suggestion_contact_not_tenant` | "This contact isn't a tenant, so this can't be applied. Dismiss it instead." |
| open tour | status in `requested`, `scheduled`, `toured`, `no_show` |
| open placement | stage not in `moved_in`, `lost` |
| type change refusal | 409 `{ error: 'type_change_refused', refusals }`, kinds `open_placement {placementId}`, `open_tour {tourId}`, `landlord_of_record {unitId}`; order kind then id asc; landlord read = LIVE units only |
| type change landlord copy | "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet." (+ View property) |
| tours/placements refusal | 409 `{ error: 'contact_not_tenant', contactKind }`; missing -> 404 `tenant_not_found` |
| `contactKind` | `'caseworker'` when `isCaseworker`, else the stored `type` |
| landlord refusal | 404 `landlord_not_found`; 409 `landlord_not_landlord` |
| contact-list caseworker | 409 `contact_list_caseworker` (NEW seat only) |
| contact-list check order | `contact_list_caseworker`, then `landlord_not_landlord` (NEW claim only), both before the repo call; then repo `landlord_reassignment_required` |
| restore refusal | 409 `restore_needs_landlord` `{ landlordName? }`; body `{ landlordId: <id> \| null }` honored only when the plain restore would refuse; conflict 409 `unit_roster_conflict` |
| restore audit | `unit_restored` gains `landlordReplaced { from, to }` or `landlordCleared { from }` |
| consistent reads | the accept's plan read; every new contact read in D3 |
| not added | no deleted-contact refusal; no data sweep; no change to the conversion's behavior/codes/copy |

Dashboard copy (exact strings, ASCII apostrophes):

| code | sentence |
|---|---|
| `contact_not_tenant` | "Tours and placements are for tenants, and this contact is <phrase>." with phrase by contactKind: tenant "a tenant", landlord "a landlord", partner "a partner", caseworker "a caseworker", team_member "a team member", unknown "not classified yet" |
| `tenant_not_found` | "That contact no longer exists." |
| `landlord_not_landlord` | "Only a landlord can be a property's landlord of record." |
| `landlord_not_found` | "That landlord no longer exists." |
| `contact_list_caseworker` | "Caseworkers can't be on a property's contact list." |
| restore dialog | "<landlordName or This property's landlord> is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:" buttons "Restore with this landlord" (disabled until picked), "Restore without a landlord", "Cancel" |

(Planner ruling P-1: the spec's "This contact is a <kind label>." is rendered
as the phrase table above so `unknown` reads naturally; the meaning is
unchanged.)

## 2. Binding interfaces (every slice codes against these names)

### App

- `app/src/services/contactHoldings.ts` (NEW; extracted from
  `caseworkerConversion.ts:217-266`):
  ```ts
  export const OPEN_TOUR_STATUSES: ReadonlySet<string>; // moved here; conversion imports it
  export interface ContactHoldingsDeps {
    placements: Pick<PlacementsRepo, 'listByTenant'>;
    tours: Pick<ToursRepo, 'listByTenant'>;
    units: Pick<UnitsRepo, 'listByLandlord' | 'list'>;
  }
  export function openPlacementIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]>; // id asc
  export function openTourIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]>;      // id asc
  export function landlordUnitIds(deps: ContactHoldingsDeps, contactId: string, opts: { deleted: false | 'any' }): Promise<string[]>; // id asc
  export function rosterUnitIds(deps: ContactHoldingsDeps, contactId: string, exclude: ReadonlySet<string>): Promise<string[]>;      // id asc, deleted 'any'
  export type TypeChangeRefusal =
    | { code: 'open_placement'; placementId: string }
    | { code: 'open_tour'; tourId: string }
    | { code: 'landlord_of_record'; unitId: string };
  export function typeChangeRefusals(deps: ContactHoldingsDeps, contactId: string, toType: string): Promise<TypeChangeRefusal[]>;
  // toType !== 'tenant' -> placements + tours; toType !== 'landlord' -> live landlord units
  ```
  `collectRefusals` in the conversion is rewritten on top of these with its
  codes, order and `deleted: 'any'` unchanged (its existing tests are the
  proof).
- `app/src/lib/caseworkers.ts` gains
  `export function contactKind(c: { type?: unknown; role?: unknown }): string`
  (`'caseworker'` when `isCaseworker(c)`, else `String(c.type)`).
- `app/src/services/contactTypeGuards.ts` (NEW):
  ```ts
  export class TenantNotFoundError extends Error {}           // -> 404 { error: 'tenant_not_found' }
  export class ContactNotTenantError extends Error { constructor(readonly contactKind: string) } // -> 409 { error: 'contact_not_tenant', contactKind }
  export class LandlordNotFoundError extends Error {}         // -> 404 { error: 'landlord_not_found' }
  export class LandlordNotLandlordError extends Error {}      // -> 409 { error: 'landlord_not_landlord' }
  export function requireTenantContact(contacts: Pick<ContactsRepo, 'getById'>, contactId: string): Promise<ContactItem>;   // consistent read
  export function requireLandlordContact(contacts: Pick<ContactsRepo, 'getById'>, contactId: string): Promise<ContactItem>; // consistent read
  export function sendContactTypeError(err: unknown, res: Response): boolean; // writes the mapped response; false when err is not one of the four
  ```
- `app/src/services/suggestionResolution.ts`: `export const TENANT_ONLY_TARGETS: ReadonlySet<string>`
  (the seven targets). `buildPlan` adds `classification_revision` to the
  guard of a tenant-only ACCEPT; `resolve` refuses before the claim with
  `new SuggestionResolutionError(409, 'suggestion_contact_not_tenant')`; and
  answers `new SuggestionResolutionError(409, 'suggestion_contact_reclassified')`
  for its own reclassification refusal.
- `app/src/repos/suggestionResolutionRepo.ts`:
  `export function effectiveGuard(journal: ActiveSuggestionResolution): ResolutionAttributeGuard`
  and `export function guardMismatchIsClassification(guard: ResolutionAttributeGuard, contact: ContactItem | undefined): boolean`;
  result union adds `'superseded_by_reclassification'`. The fake imports
  both functions from the repo module.
- Units: route-level checks in `app/src/routes/units.ts` using
  `requireLandlordContact`; a new repo method appended to `UnitsRepo`:
  `restoreWithLandlord(unitId: string, input: { expectLandlordId: string | undefined; next: { contactId: string; name?: string; company?: string } | null }): Promise<UnitItem>`
  (one conditional UpdateCommand; throws `RosterWriteConflictError` when the
  stored `landlordId` no longer equals `expectLandlordId`; restores `deleted_at`
  removal, landlordId set/removed, old landlord row removed, new landlord row
  upserted with role pinned `landlord`, `primary_contact` kept consistent
  with the existing roster helpers). Every typed UnitsRepo fake in tests gets
  the method.

### Dashboard

- `dashboard/src/lib/holdingRefusals.ts` (NEW): `refusalCopyByKind(r)` for
  kinds `open_placement`, `open_tour`, `landlord_of_record` (conversion
  wording/links) plus the type-change landlord sentence; the conversion's
  `refusalCopy` in `CaseworkerDialog.tsx` delegates to it (output
  byte-identical for its four codes; the roster kind stays in the dialog or
  moves too - writer's choice, output identical).
- `dashboard/src/lib/contactTypeErrors.ts` (NEW):
  `contactTypeErrorMessage(err: unknown): string | null` - the section-1
  dashboard copy table for `contact_not_tenant` (with `contactKind`),
  `tenant_not_found`, `landlord_not_landlord`, `landlord_not_found`,
  `contact_list_caseworker`; `null` for anything else so each site keeps its
  current fallback.
- `dashboard/src/api/endpoints.ts`: `restoreUnit(unitId, opts?: { landlordId: string | null })`
  (body only when opts given); `ApiError` already carries `status` and `code`
  (check how `body` extras such as `refusals`, `contactKind`, `landlordName`
  are exposed and use the existing mechanism).

## 3. Slice map, ordering and watch items

| Slice | Content | Depends on |
|---|---|---|
| S1 | D1: accept type rule + revision fence + legacy effective guard + reclassified answer; route emit; dashboard copy + refetch; FakeWorld + real-repo regressions | - |
| S2 | `contactHoldings.ts` extraction (conversion unchanged), `contactKind`, contacts PATCH `type_change_refused`, edit form + Unknown card | - |
| S3 | `contactTypeGuards.ts`; tours create / PATCH revive / reopen; placements create / from-tour; transition service + `handleTransitionError`; `deriveTenantStatus` skip; TenantFile team-member buttons; `contactTypeErrors.ts` + the tour/placement dashboard copy sites | S2 (`contactKind`) |
| S4 | units create / PATCH landlordId; contact-list caseworker + landlord-claim checks (order); `restoreWithLandlord` + restore route + dialog; Add contact picker hides caseworkers; `runRosterWrite` mapping | S3 (`contactTypeGuards.ts`, `contactTypeErrors.ts`) |
| S5 | seed invariant test (every profile); e2e sweep + new specs; RUNBOOK; resolve 3 issues + correct the third; file 3 issues | S1-S4 |
| CK | Checkpoint: typecheck + `npm test` + `npm run smoke` after S2 and after S4 | - |

Watch items:

- W1 (invariant rule): every mutation surface and reader in spec section 5 is
  a task or a watch item; a surface found during the build that the plan does
  not list is a STOP-and-record (findings file), not a silent addition.
- W2: the conversion's behavior, codes, order and copy must be byte-identical
  after the S2 extraction; its existing test files stay green unchanged.
- W3: e2e fixtures and seeds that today create a tour/placement for a
  non-tenant, a unit with a non-landlord `landlordId`, or seat a caseworker
  will start failing in S3/S4 - fix the fixture (correct typing), never
  weaken the rule. List every one fixed in the slice report.
- W4: real-repo + fake parity for S1 is by shared functions; a fake-only test
  cannot prove the :827 site - the legacy case MUST run on DynamoDB Local.
- W5: `deriveTenantStatus` skip must not change listing-status derivation.
- W6: the PATCH's 409 `caseworker_use_conversion` still wins over
  `type_change_refused`.
- W7: dashboard sites that today show `err.message` must not regress other
  errors - `contactTypeErrorMessage` returns null for anything else.
