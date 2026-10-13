# Implementation plan - Caseworker integrity

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
  (APPROVED revision 3 @fc7cff02, Cameron's spec gate 2026-10-12).
- Branch `fix/caseworker-integrity`, worktree `W:\tmp\caseworker-integrity`,
  cut from main @19607658. Mission records:
  `docs/superpowers/reviews/2026-10-12-caseworker-integrity/`.
- Status: PLAN v2 (planner, 2026-10-12) - plan review round 1 (terminal)
  folded in: `docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-review/adjudications.md`.
  (v1 ASSEMBLED @771edb52.) Sections 0-3 are BINDING; slices S1-S5 follow
  (drafted by five section writers; each slice's CONTRACT ISSUES block is
  kept for context and is overridden by the assembly rulings linked in
  section 1 and by the plan-review adjudications above). Execute slices in
  order S1, S2, CK, S3, S4, CK, S5.

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
- Lint at every slice gate (plan review R1 row 3; AGENTS.md gate 5 - NO NEW
  LINT ERRORS IN THE FILES YOU TOUCHED). Each slice gate runs `npx eslint`
  BARE on the exact list of `.ts`/`.tsx` files that slice touches (the
  config lints nothing else). Then:
  1. Coverage check - every `.ts`/`.tsx` file the branch has touched so far
     must be in this slice's list or an earlier slice's list:
     ```
     cd "W:/tmp/caseworker-integrity"; git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx'
     ```
     A printed path in no slice's list is a STOP-and-record (W1); lint it
     with this slice before going on.
  2. If eslint reports ANY error, attribute it by BASELINE COMPARISON, never
     by line number (an unused import fires on the import line your diff
     never touched). Lint each listed file's MERGE-BASE content in place
     (bash; read-only; a diagnostic, not a gate, so its pipe is allowed;
     replace `<files>` with the slice gate's list):
     ```
     cd "W:/tmp/caseworker-integrity"; B=$(git merge-base main HEAD); for f in <files>; do if git cat-file -e "$B:$f" 2>/dev/null; then echo "== base: $f"; git show "$B:$f" | npx eslint --stdin --stdin-filename "$f"; else echo "== base: $f is new on this branch - no baseline, must be clean"; fi; done
     ```
     Compare the two outputs by file + rule + the flagged source text (line
     numbers shift with the slice's own edits). An error present on the
     branch and absent at base is the SLICE's and BLOCKING - fix it and
     re-run. One present at base is pre-existing - leave it (never fix it in
     this branch) and name it in the slice report and the handback.
  3. Known baseline, measured by the planner on the base tree 2026-10-12
     (`npx eslint` on every existing file this plan touches - 58 files -
     reports exactly these two, in files S3 edits; everything else lints
     clean at base):
     - `dashboard/src/routes/tours/TourDetail.tsx:341` - `react-hooks/purity`
       ("Cannot call impure function during render"): `Date.now()` in the
       `startPassed` computation (Task 3.12 edits this file, not that line).
     - `dashboard/src/routes/tours/ScheduleTourForm.tsx:241` -
       `react-hooks/set-state-in-effect`: `setTourType(DEFAULT_TOUR_TYPE);`
       in the unit-picked effect (Task 3.14 edits this file, not that line).
     Both are pre-existing debt (`docs/issues/lint-backlog-repo-wide.md`):
     NOT to be fixed here; the S3 gate expects exactly these two.

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
| `contact_not_tenant` | "Tours and placements are for tenants. This contact is <phrase>." (the spec's two sentences) with phrase by contactKind: tenant "a tenant", landlord "a landlord", partner "a partner", caseworker "a caseworker", team_member "a team member", unknown "not classified yet"; a missing or unrecognized contactKind "not a tenant" |
| `tenant_not_found` | "That contact no longer exists." |
| `landlord_not_landlord` | "Only a landlord can be a property's landlord of record." |
| `landlord_not_found` | "That landlord no longer exists." |
| `contact_list_caseworker` | "Caseworkers can't be on a property's contact list." |
| restore dialog | title "Restore property" (the dialog's accessible name); body "<landlordName or This property's landlord> is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:"; picker label "Landlord" (landlords only); buttons "Restore with this landlord" (disabled until picked), "Restore without a landlord", "Cancel"; in-dialog 409 `unit_roster_conflict` -> the existing `ROSTER_RETRY_COPY`; any other failure "Couldn't restore - please try again." |

(Planner ruling P-1, as amended by plan review R1 row 2: the sentence is the
spec's own two-sentence form, "Tours and placements are for tenants. This
contact is <phrase>." - first sentence and wording unchanged from the spec.
The only handling added is the phrase: the spec's kind label is lower-cased
and given its article ("a landlord", "a team member"), and `unknown` reads
"not classified yet" so the sentence stays natural English instead of "This
contact is a Unknown". A missing or unrecognized `contactKind` uses the
phrase "not a tenant".)

Assembly rulings on the section writers' contract issues are binding and
override a slice where they differ:
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/plan-assembly-rulings.md`
(rulings S2-1, S5-1 and P-1 there are amended by plan review R1 rows 4, 1 and
2; the plan text below already carries the amendments).

## 2. Binding interfaces (every slice codes against these names)

### App

- `app/src/services/contactHoldings.ts` (NEW; extracted from
  `caseworkerConversion.ts:217-266`):
  ```ts
  export const OPEN_TOUR_STATUSES: ReadonlySet<string>; // moved here; the conversion drops its now-unused imports (ruling S2-2)
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
  (the seven targets; DEFINED in `services/extraction/runTypes.ts` and
  re-exported here, to avoid an import cycle - ruling S1-1). `buildPlan` adds `classification_revision` to the
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

- `dashboard/src/lib/holdingRefusals.ts` (NEW, a `.ts` module - no JSX):
  `refusalCopyByKind(r)` for kinds `open_placement`, `open_tour`,
  `landlord_of_record` (conversion wording/links), plus
  `typeChangeRefusalCopy`, `TYPE_CHANGE_LANDLORD_SENTENCE`,
  `typeChangeRefusalsFrom` and the wire type `TypeChangeRefusal` (ruling
  S2-1; exact shapes in S2); the conversion's `refusalCopy` in
  `CaseworkerDialog.tsx` delegates to it (output byte-identical for its four
  codes).
- `dashboard/src/routes/contact/TypeChangeRefusalList.tsx` (NEW, S2 Task
  2.6): `export function TypeChangeRefusalList({ refusals })` - the ONE shared
  component that renders a refused type change's sentences and View links,
  used by the edit form (Task 2.6) and the Unknown card (Task 2.7), which
  import it from `./TypeChangeRefusalList.js`. It is NOT exported from
  `holdingRefusals.ts` (corrected by plan review R1 row 4).
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
| S5 | seed invariant test (every profile); e2e sweep + new specs; RUNBOOK; resolve 3 issues + correct the third; file 4 issues (spec section 7's three + `unit-primary-contact-unchecked`, plan review R1 row 7) | S1-S4 |
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


---

# SLICE S1 (assembled from the section draft)

# S1 - D1: tenant-only accepts check the type and are fenced on the classification revision

Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` section 2
and section 8 ("D1, real AND fake", "D1 dashboard"). Plan sections 0-3 are binding.
Every line anchor below was read on `fix/caseworker-integrity` @54f9e6ed.

## CONTRACT ISSUES

1. **`TENANT_ONLY_TARGETS` cannot live only in the service without an import cycle.**
   Binding section 2 puts `export const TENANT_ONLY_TARGETS` in
   `app/src/services/suggestionResolution.ts`, but the binding `effectiveGuard`
   lives in `app/src/repos/suggestionResolutionRepo.ts` and needs the set, while
   the service already imports the repo (`suggestionResolution.ts:7-16`). A repo
   import of the service would be a repo<->service cycle (and would drag the
   status/org-name modules into the repo). Resolution (used by this slice):
   define the set once in the leaf module
   `app/src/services/extraction/runTypes.ts` (which "imports nothing" by design,
   `runTypes.ts:2`, and which the repo already imports at
   `suggestionResolutionRepo.ts:29`) and RE-EXPORT it from
   `suggestionResolution.ts` under the binding name. Importers of the binding
   name are unaffected (Task 1.2 pins the re-export).

2. **Where the plan-time refusal sits relative to the other plan-time checks.**
   The binding says `resolve` refuses before the claim. This slice places it in
   `resolve()` immediately after the contact read (`suggestionResolution.ts:778-779`),
   i.e. BEFORE `buildPlan`. Consequences, all intended: it runs before the
   status allowlist (`:271`, as the spec requires), before the org-list read
   (`:784-786`), and before the `value_not_from_suggestion` check (`:266`) - so
   a housingAuthority accept that carries a `value` on a non-tenant answers 409
   `suggestion_contact_not_tenant`, not 422. Completed-row replays
   (`:756-771`) still answer first, as today.

3. **Which read decides the tie (classification versus field).** The real repo
   decides `stale` versus mismatch on its consistent re-read
   (`suggestionResolutionRepo.ts:822-829`) and only then runs the mismatch
   `ConditionCheck` (`:831-851`). The answer code is decided from that same
   re-read (`guardMismatchIsClassification(guard, contact)`). A classification
   change landing between that read and the ConditionCheck therefore answers
   `suggestion_field_edited` rather than `_reclassified`. Durable state, the
   stored outcome and the run-log verdict are identical either way (the spec
   makes them the same). Resolution: accept; stated in the code comment.

4. **`guardMismatchIsClassification(guard, undefined)` and `effectiveGuard` on a
   non-contact plan are unspecified.** Resolution: a missing contact answers
   `false` (it stays a human-edit supersede, today's behavior - the mismatch
   condition at `:831` already fails `attribute_exists(contactId)`); a phone or
   dismiss plan answers `{}` (`commitContactEffect` never reaches it:
   `suggestionResolutionRepo.ts:773`).

5. **Spec 8 (A) "`suggestion.updated` emitted ... on FakeWorld routes and on the
   real repos".** The real-repo twin is service-level - there is no router in
   it, exactly like the planner's executed reproduction
   (`docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md:197`).
   Resolution: the emit is asserted on the FakeWorld routes (Tasks 1.3, 1.8);
   the real-repo run asserts the 409, the contact state and the completed
   journal (Task 1.7).

6. Line-number drift only (no decision impact): the copy map is
   `dashboard/src/api/types.ts:1654-1699` (spec says 1655-1700); everything
   else the spec cites for D1 is exact.

## Task order and why

1.1 consistent read -> 1.2 type rule (defines `TENANT_ONLY_TARGETS`) -> 1.3 the
revision fence in `buildPlan` -> 1.4 the pure guard functions -> 1.5 the real
repo's three sites -> 1.6 the fake (parity) -> 1.7 the service's 409 answer
(+ the real-repo schedules) -> 1.8 the route emit -> 1.9 dashboard copy ->
1.10 dashboard refetch. Each task's RED is caused by the change it makes.

Shared conventions for every task:

- Paths are absolute under `W:/tmp/caseworker-integrity`. Use the Edit tool for
  every source change (never a PowerShell rewrite). Never type a `\u` escape.
- DynamoDB Local suites (Tasks 1.5 and 1.7) need the shared container started:
  `cd "W:/tmp/caseworker-integrity"; npm run db:start` (START only - never
  restart, stop or remove it).
- Commit = three commands: `git status` (read it), `git add <explicit paths>`,
  `git commit` with the shown message. Check new files are ASCII:
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0.

---

## Task 1.1 - The accept plan is built from a consistent contact read

Goal: spec 2 change 1. The contact read that feeds `buildPlan` (and, after
Tasks 1.2-1.3, the type rule and the fence) is a strongly consistent read.

Files:
- create `app/test/suggestionReclassification.test.ts`
- modify `app/src/services/suggestionResolution.ts`

### Step 1 - failing test

Create `app/test/suggestionReclassification.test.ts` with exactly:

```ts
// Spec 2026-10-12 D1 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// section 2; R2-ADV-1): an accepted AI suggestion for a TENANT-ONLY field commits
// only onto a contact typed tenant whose classification is unchanged since the
// accept read it. These cases drive the HTTP routes on the FakeWorld
// (makeWebhookHarness). The DynamoDB Local twin of the schedules is
// suggestionReclassification.integration.test.ts; the guard functions and the
// fake's parity with the real repository are in
// suggestionReclassificationGuard.test.ts.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import type { SuggestionItem } from '../src/repos/extractionRepo.js';

const suggestionIdentities = new Map<string, { revision?: string; createdAt: string; runId?: string }>();

/** A contact - a tenant with no classification_revision unless `over` says otherwise. */
function seedContact(world: FakeWorld, over: Record<string, unknown> = {}): string {
  const contactId = (over['contactId'] as string | undefined) ?? 'c1';
  world.contacts.push({
    contactId,
    type: 'tenant',
    status: 'onboarding',
    phone: '+15550100001',
    created_at: '2026-07-01T10:00:00.000Z',
    ...over,
  });
  return contactId;
}

async function seedSuggestion(
  world: FakeWorld,
  suggestion: Omit<SuggestionItem, 'itemId' | '_pendingPartition' | 'createdAt'> & { createdAt?: string },
): Promise<void> {
  await world.extractionRepo.putSuggestion(suggestion);
  const stored = await world.extractionRepo.getSuggestion(suggestion.ownerContactId, suggestion.target);
  if (stored !== undefined) {
    suggestionIdentities.set(`${stored.ownerContactId}#${stored.target}`, {
      revision: stored.revision,
      createdAt: stored.createdAt,
      runId: stored.runId,
    });
  }
}

function accept(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/accept`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(suggestionIdentities.get(`${contactId}#${target}`));
}

// D1 cases. Later tasks insert their helpers ABOVE this line.

describe('D1 change 1: the accept plan reads the contact consistently', () => {
  it('builds the plan from a CONSISTENT contact read', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-plan-read',
    });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    await accept(app, 'c1', 'pets').expect(200);

    // The FIRST contact read of the request is the plan read: resolve() reads
    // the journal and the suggestion first, neither through contactsRepo.
    expect(getById.mock.calls[0]).toEqual(['c1', { consistentRead: true }]);
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts`

RED: 1 failed - `expected [ 'c1' ] to deeply equal [ 'c1', { consistentRead: true } ]`.
Why: `resolve()` reads the contact with `deps.contactsRepo.getById(input.contactId)`
(`suggestionResolution.ts:778`), no options.

### Step 3 - implement

Edit `app/src/services/suggestionResolution.ts`:

old_string:
```ts
          const contact = await deps.contactsRepo.getById(input.contactId);
          if (!contact) throw new SuggestionResolutionError(404, 'contact_not_found');
```
new_string:
```ts
          // Spec 2026-10-12 D1 change 1: CONSISTENT. This read drives the
          // tenant-only type rule and the classification_revision fence; a stale
          // read would refuse spuriously and, for the fence, consume the chip.
          const contact = await deps.contactsRepo.getById(input.contactId, { consistentRead: true });
          if (!contact) throw new SuggestionResolutionError(404, 'contact_not_found');
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/aiRunVerdicts.test.ts test/suggestionAcceptOrgList.test.ts`
All pass.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/services/suggestionResolution.ts app/test/suggestionReclassification.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): build the accept plan from a consistent contact read" -m "Spec 2026-10-12 D1 change 1: the plan read drives the tenant-only type rule and the classification fence, so it must not be stale." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.2 - A tenant-only accept on a contact not typed tenant is refused before the claim

Goal: spec 2 change 2. `TENANT_ONLY_TARGETS` (the seven targets) exists under
the binding name; an ACCEPT of one on a non-tenant answers 409
`suggestion_contact_not_tenant` before the claim, the chip survives, nothing
is emitted; a dismiss is never refused; neutral targets are unaffected; for
`status` the rule runs before the allowlist (today a landlord's status accept
answers 400 `invalid_suggestion_value`).

Files:
- modify `app/src/services/extraction/runTypes.ts`
- modify `app/src/services/suggestionResolution.ts`
- modify `app/test/suggestionReclassification.test.ts`

### Step 1 - failing tests

Edit `app/test/suggestionReclassification.test.ts` (imports):

old_string:
```ts
import type { SuggestionItem } from '../src/repos/extractionRepo.js';
```
new_string:
```ts
import type { SuggestionItem } from '../src/repos/extractionRepo.js';
import { TENANT_ONLY_TARGETS } from '../src/services/suggestionResolution.js';
```

Edit the same file (helpers):

old_string:
```ts
// D1 cases. Later tasks insert their helpers ABOVE this line.
```
new_string:
```ts
function dismiss(app: import('express').Express, contactId: string, target: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/suggestions/${target}/dismiss`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(suggestionIdentities.get(`${contactId}#${target}`));
}

function contactOf(world: FakeWorld, contactId: string) {
  return world.contacts.find((contact) => contact.contactId === contactId);
}

function journalsFor(world: FakeWorld, contactId: string) {
  return [...world.suggestionResolutions.values()].filter((item) => item.contactId === contactId);
}

function suggestionEmits(world: FakeWorld): number {
  return world.emitted.filter((event) => event.event === 'suggestion.updated').length;
}

// D1 cases. Later tasks insert their helpers ABOVE this line.
```

Append at the END of the file:

```ts
describe('D1 change 2: a tenant-only accept on a contact not typed tenant is refused before the claim', () => {
  it('names exactly the seven tenant-only targets', () => {
    expect([...TENANT_ONLY_TARGETS].sort()).toEqual([
      'evictions', 'housingAuthority', 'pets', 'porting', 'status', 'tenure', 'voucherSize',
    ]);
  });

  it.each([
    ['housingAuthority', 'Atlanta Housing Authority'],
    ['voucherSize', '3'],
    ['pets', 'two cats'],
    ['evictions', 'none'],
    ['tenure', '2 years'],
    ['porting', 'true'],
    ['status', 'searching'],
  ])('refuses a %s accept on a landlord with 409 suggestion_contact_not_tenant and keeps the chip', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target, suggestedValue, conversationId: 'conv-ll', runId: `run-${target}`,
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-ll', target);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    // Refused before the claim: the chip is still pending, no journal exists,
    // the contact is untouched and no dashboard is told anything changed.
    expect(await world.extractionRepo.getSuggestion('c-ll', target)).toBeDefined();
    expect(journalsFor(world, 'c-ll')).toEqual([]);
    expect(contactOf(world, 'c-ll')?.[target]).toEqual(target === 'status' ? 'active' : undefined);
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown contact', { type: 'unknown', status: 'needs_review' }],
    ['a caseworker', { type: 'partner', role: 'Caseworker', status: 'active' }],
    ['a team member', { type: 'team_member', status: 'active' }],
  ])('refuses a voucherSize accept on %s too', async (_label, kind) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-kind', ...kind });
    await seedSuggestion(world, {
      ownerContactId: 'c-kind', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-k', runId: 'run-k',
    });

    const res = await accept(app, 'c-kind', 'voucherSize');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(await world.extractionRepo.getSuggestion('c-kind', 'voucherSize')).toBeDefined();
    expect(contactOf(world, 'c-kind')?.['voucherSize']).toBeUndefined();
  });

  it('never refuses a dismiss - staff clear the kept chip this way (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-ll', runId: 'run-pets',
    });

    await dismiss(app, 'c-ll', 'pets').expect(200);

    expect(await world.extractionRepo.getSuggestion('c-ll', 'pets')).toBeUndefined();
  });

  it('leaves a neutral target alone: a lastName accept on a landlord still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'lastName', suggestedValue: 'Okafor', conversationId: 'conv-ll', runId: 'run-last',
    });

    await accept(app, 'c-ll', 'lastName').expect(200);

    expect(contactOf(world, 'c-ll')?.['lastName']).toBe('Okafor');
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts`

RED, and why:
- `names exactly the seven tenant-only targets`: TypeError (`TENANT_ONLY_TARGETS`
  is not exported yet, so the spread of `undefined` throws).
- the six non-status targets on a landlord and all three kinds: `expected 200 to be 409`
  - `buildPlan` reads no contact type for fact targets, so the accept commits.
- `status` on a landlord: `expected 400 to be 409` - the allowlist check
  (`suggestionResolution.ts:271`) answers 400 `invalid_suggestion_value` first.
- The two PIN cases pass.

### Step 3 - implement

Edit `app/src/services/extraction/runTypes.ts`:

old_string:
```ts
/** True when `value` is one of the twelve targets (route/param validation). */
export function isDecisionTarget(value: unknown): value is DecisionTarget {
  return typeof value === 'string' && (DECISION_TARGETS as readonly string[]).includes(value);
}
```
new_string:
```ts
/** True when `value` is one of the twelve targets (route/param validation). */
export function isDecisionTarget(value: unknown): value is DecisionTarget {
  return typeof value === 'string' && (DECISION_TARGETS as readonly string[]).includes(value);
}

/**
 * Spec 2026-10-12 D1 (I1): the targets whose facts belong to a tenant only. An
 * accept of one is refused on a contact not typed tenant (409
 * suggestion_contact_not_tenant, before the claim) and is fenced on the
 * contact's classification_revision. The neutral targets (firstName, lastName,
 * phone, address) are never refused or fenced; `type` cannot be accepted at
 * all. Defined in this leaf module so the resolution service AND the resolution
 * repository (effectiveGuard) share one definition without an import cycle;
 * services/suggestionResolution.ts re-exports it.
 */
export const TENANT_ONLY_TARGETS: ReadonlySet<string> = new Set<string>([
  'housingAuthority', 'voucherSize', 'pets', 'evictions', 'tenure', 'porting', 'status',
]);
```

Edit `app/src/services/suggestionResolution.ts` (import):

old_string:
```ts
import { isDecisionTarget } from './extraction/runTypes.js';
```
new_string:
```ts
import { isDecisionTarget, TENANT_ONLY_TARGETS } from './extraction/runTypes.js';
```

Edit the same file (re-export under the binding name):

old_string:
```ts
import type { OrgNamesService } from './orgNames.js';

const EXTRACTABLE = new Set<string>(EXTRACTABLE_FIELDS);
```
new_string:
```ts
import type { OrgNamesService } from './orgNames.js';

// Spec 2026-10-12 D1: the seven tenant-only targets, exported here under the
// plan's binding name. Defined in extraction/runTypes.ts (a leaf module) so the
// resolution repository can read it without importing this service.
export { TENANT_ONLY_TARGETS };

const EXTRACTABLE = new Set<string>(EXTRACTABLE_FIELDS);
```

Edit the same file (the rule, right after the Task 1.1 read):

old_string:
```ts
          const contact = await deps.contactsRepo.getById(input.contactId, { consistentRead: true });
          if (!contact) throw new SuggestionResolutionError(404, 'contact_not_found');
```
new_string:
```ts
          const contact = await deps.contactsRepo.getById(input.contactId, { consistentRead: true });
          if (!contact) throw new SuggestionResolutionError(404, 'contact_not_found');
          // Spec 2026-10-12 D1 change 2: tenant facts are accepted only onto a
          // contact typed tenant - the rule extraction proposes them by
          // (extraction/apply.ts fieldApplies). Refused BEFORE the claim, so the
          // chip is not consumed and staff can still dismiss it; a dismiss is
          // never refused. It runs before buildPlan, so a status accept meets
          // it before the type-scoped allowlist check.
          if (
            input.action === 'accept'
            && TENANT_ONLY_TARGETS.has(input.target)
            && contact.type !== 'tenant'
          ) {
            throw new SuggestionResolutionError(409, 'suggestion_contact_not_tenant');
          }
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/suggestions.test.ts test/suggestionAcceptOrgList.test.ts test/aiRunVerdicts.test.ts`
All pass.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/services/extraction/runTypes.ts app/src/services/suggestionResolution.ts app/test/suggestionReclassification.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): refuse a tenant-only accept on a non-tenant before the claim" -m "Spec 2026-10-12 D1 change 2: 409 suggestion_contact_not_tenant, chip kept, dismiss never refused, checked before the status allowlist. TENANT_ONLY_TARGETS lives in extraction/runTypes.ts and is re-exported by the service." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.3 - A tenant-only accept's guard carries the classification revision it read

Goal: spec 2 change 3. `buildPlan` adds `classification_revision` to the
guard of a tenant-only ACCEPT (`{ exists: false }` when absent, else
`{ exists: true, value }`); neutral guards are unchanged. Because the real repo
and the fake already enforce every key a guard holds, this alone stops the
R2-ADV-1 recovery schedule (B) and the generic re-type from writing anything.

Files:
- modify `app/src/services/suggestionResolution.ts`
- modify `app/test/suggestionReclassification.test.ts`

### Step 1 - failing tests

Edit `app/test/suggestionReclassification.test.ts` (imports):

old_string:
```ts
import { TENANT_ONLY_TARGETS } from '../src/services/suggestionResolution.js';
```
new_string:
```ts
import { runJournalSweep } from '../src/jobs/journalSweep.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import type { OrgListItem } from '../src/repos/orgListRepo.js';
import type {
  ResolutionAttributeGuard,
  ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import {
  createSuggestionResolutionService,
  TENANT_ONLY_TARGETS,
} from '../src/services/suggestionResolution.js';
import { quietLogger } from './helpers/orgFixtures.js';
```

Edit the same file (helpers):

old_string:
```ts
// D1 cases. Later tasks insert their helpers ABOVE this line.
```
new_string:
```ts
/** The starting organization list (spec 2026-10-06 Appendix A) as a stored item. */
function startingOrgList(): OrgListItem {
  let n = 0;
  return {
    settingId: 'org-list',
    version: 1,
    entries: buildStartingEntries('2026-10-06T00:00:00.000Z', () => `org-${(n += 1)}`),
  };
}

function list(app: import('express').Express, contactId: string) {
  return request(app)
    .get(`/api/contacts/${contactId}/suggestions`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function patch(app: import('express').Express, contactId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

/** The real caseworker conversion, through its one route. */
function convert(app: import('express').Express, contactId: string) {
  return request(app)
    .post(`/api/contacts/${contactId}/caseworker-review`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ action: 'make' });
}

/** An app whose accept dies right after its claim (process termination). */
function crashingApp(world: FakeWorld): import('express').Express {
  return makeWebhookHarness({
    world,
    suggestionResolutionHooks: {
      afterBoundary: (boundary) => {
        if (boundary === 'claimed') throw new Error('simulated termination after claim');
      },
    },
  }).app;
}

function expireActiveResolution(world: FakeWorld, contactId: string, target: string): void {
  for (const [key, item] of world.suggestionResolutions) {
    if (item.state === 'active' && item.contactId === contactId && item.target === target) {
      world.suggestionResolutions.set(key, { ...item, leaseExpiresAt: '2000-01-01T00:00:00.000Z' });
      return;
    }
  }
  throw new Error('expected an active resolution');
}

function journalFor(world: FakeWorld, contactId: string, target: string) {
  return [...world.suggestionResolutions.values()].find(
    (item) => item.contactId === contactId && item.target === target,
  );
}

function guardOf(plan: ResolutionReplayPlan | undefined): ResolutionAttributeGuard {
  if (plan === undefined || (plan.kind !== 'contact' && plan.kind !== 'status')) {
    throw new Error('expected a contact or status plan');
  }
  return plan.guard;
}

/** The daily abandoned-journal sweep, run a day later over the world's repos. */
async function sweepADayLater(world: FakeWorld) {
  const service = createSuggestionResolutionService({
    contactsRepo: world.contactsRepo,
    extractionRepo: world.extractionRepo,
    aiRunsRepo: world.aiRuns,
    resolutionRepo: world.suggestionResolutionRepo,
    orgNamesService: createOrgNamesService({ orgListRepo: world.orgListRepo, logger: quietLogger() }),
    logger: quietLogger(),
  });
  return runJournalSweep(
    new Date(Date.now() + 25 * 3_600_000).toISOString(),
    {
      settingsRepo: {
        claimGroupPeriod: async () => true,
        getJournalSweepCursor: async () => undefined,
        putJournalSweepCursor: async () => {},
      },
      resolutionRepo: world.suggestionResolutionRepo,
      resolutionService: service,
      events: world.events,
      logger: quietLogger(),
    },
    { force: true },
  );
}

// D1 cases. Later tasks insert their helpers ABOVE this line.
```

Append at the END of the file:

```ts
describe('D1 change 3: a tenant-only accept is fenced on the classification it read', () => {
  it.each([
    ['housingAuthority', 'Atlanta Housing Authority'],
    ['voucherSize', '3'],
    ['pets', 'two cats'],
    ['evictions', 'none'],
    ['tenure', '2 years'],
    ['porting', 'true'],
    ['status', 'searching'],
  ])('a %s accept guards classification_revision as absent when the contact has none', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target, suggestedValue, conversationId: 'conv-1', runId: `run-${target}`,
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', target).expect(200);

    expect(guardOf(claim.mock.calls[0]?.[0].plan)['classification_revision']).toEqual({ exists: false });
  });

  it('guards the stored revision value when the contact has one', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { classification_revision: 3 });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-pets',
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', 'pets').expect(200);

    expect(guardOf(claim.mock.calls[0]?.[0].plan)['classification_revision']).toEqual({ exists: true, value: 3 });
  });

  it.each([
    ['firstName', 'Tasha'],
    ['lastName', 'Williams'],
    ['address', '1 Main St'],
  ])('never fences the neutral %s target (PIN)', async (target, suggestedValue) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target, suggestedValue, conversationId: 'conv-1', runId: `run-${target}`,
      ...(target === 'address' && { suggestedAddress: { line1: '1 Main St' } }),
    });
    const claim = vi.spyOn(world.suggestionResolutionRepo, 'claim');

    await accept(app, 'c1', target).expect(200);

    expect(Object.keys(guardOf(claim.mock.calls[0]?.[0].plan))).not.toContain('classification_revision');
  });

  // R2-ADV-1 schedule B: the claim lands, the process dies before the commit,
  // the contact is converted, and recovery later finishes the journal.
  it('B (read): an authority claim that crashed, recovered by a suggestions read after a conversion, writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('active');
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');
    const emitsBefore = suggestionEmits(world);

    await list(app, 'c1').expect(200);

    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
    // The journal consumed the chip, so the read still notifies every dashboard.
    expect(suggestionEmits(world)).toBe(emitsBefore + 1);
  });

  it('B (sweep): the same claim, recovered by the daily journal sweep after a conversion, writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');

    const outcome = await sweepADayLater(world);

    expect(outcome.recovered).toBe(1);
    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });

  it('a voucherSize claim that crashed, then a generic tenant -> landlord re-type, recovers without writing voucherSize', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-1', runId: 'run-voucher',
    });
    await accept(crashingApp(world), 'c1', 'voucherSize').expect(500);
    await patch(app, 'c1', { type: 'landlord' }).expect(200);
    expireActiveResolution(world, 'c1', 'voucherSize');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')).toMatchObject({ type: 'landlord' });
    expect(contactOf(world, 'c1')?.['voucherSize']).toBeUndefined();
    expect(journalFor(world, 'c1', 'voucherSize')?.state).toBe('completed');
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts`

RED, and why:
- the seven `guards classification_revision as absent` cases and `guards the
  stored revision value`: `expected undefined to deeply equal { exists: false }`
  (resp. `{ exists: true, value: 3 }`) - `guardForPatch` (`suggestionResolution.ts:194`)
  names only the fields the plan writes.
- `B (read)` and `B (sweep)`: `expected 'Atlanta Housing Authority' to be undefined`
  - the guard expects both authority attributes absent, the conversion removed
  (already-absent) attributes, so the guard still matches and recovery writes
  the authority onto the caseworker (the R2-ADV-1 reproduction).
- the generic re-type: `expected 3 to be undefined` - the same, for voucherSize.
- the three `(PIN)` neutral cases pass (the "never fenced" rule).

### Step 3 - implement

Edit `app/src/services/suggestionResolution.ts` (helper):

old_string:
```ts
/**
 * Spec 2026-10-06 D8 + D5: the name an accepted housingAuthority suggestion
 * writes, decided against the CURRENT list inside buildPlan - before the
```
new_string:
```ts
/**
 * Spec 2026-10-12 D1 change 3 (I1): a tenant-only ACCEPT is fenced on the
 * contact's classification as the plan read it. The caseworker conversion and
 * every contacts-PATCH type/role change bump classification_revision in the
 * same write (contactsRepo update), so the guard transaction refuses an accept
 * that spans any reclassification. Neutral targets are never fenced.
 */
function withClassificationFence(
  contact: ContactItem,
  target: string,
  guard: ResolutionAttributeGuard,
): ResolutionAttributeGuard {
  if (!TENANT_ONLY_TARGETS.has(target)) return guard;
  const revision = contact.classification_revision;
  return {
    ...guard,
    classification_revision: revision === undefined
      ? { exists: false }
      : { exists: true, value: revision },
  };
}

/**
 * Spec 2026-10-06 D8 + D5: the name an accepted housingAuthority suggestion
 * writes, decided against the CURRENT list inside buildPlan - before the
```

Edit the same file (status plan):

old_string:
```ts
      guard: guardForPatch(contact, status.patch),
```
new_string:
```ts
      guard: withClassificationFence(contact, target, guardForPatch(contact, status.patch)),
```

Edit the same file with `replace_all: true` (the housingAuthority branch and the
EXTRACTABLE branch both carry this exact line - 2 occurrences; the address
branch's `guard: guardForPatch(contact, {` is different and stays as is):

old_string:
```ts
      guard: guardForPatch(contact, patch),
```
new_string:
```ts
      guard: withClassificationFence(contact, target, guardForPatch(contact, patch)),
```

Verify: `cd "W:/tmp/caseworker-integrity/app"; grep -c "withClassificationFence(contact, target" src/services/suggestionResolution.ts`
prints 3.

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/suggestionAcceptOrgList.test.ts`
All pass. (At this point the conversion and re-type cases are refused as
`superseded_by_human_edit`; Tasks 1.5-1.7 turn that into the reclassification
answer.)

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/services/suggestionResolution.ts app/test/suggestionReclassification.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): fence a tenant-only accept on the classification revision it read" -m "Spec 2026-10-12 D1 change 3. Closes the R2-ADV-1 recovery schedule: a claimed authority accept no longer commits onto a contact converted to a caseworker, and a voucherSize accept no longer commits across a generic re-type." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.4 - The guard functions: `effectiveGuard` and `guardMismatchIsClassification`

Goal: spec 2 changes 4-5, the pure half. `effectiveGuard(journal)` is the
plan's guard, extended with `caseworker_conversion: { exists: false }` for a
tenant-only journal whose guard has no `classification_revision` (a journal
claimed before the deploy). `guardMismatchIsClassification(guard, contact)` is
true when the contact fails the guard on a classification key.

Files:
- create `app/test/suggestionReclassificationGuard.test.ts`
- modify `app/src/repos/suggestionResolutionRepo.ts`

### Step 1 - failing tests

Create `app/test/suggestionReclassificationGuard.test.ts` with exactly:

```ts
// Spec 2026-10-12 D1 changes 4-5 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// section 2): the ONE guard commitContactEffect and its test fake evaluate
// (effectiveGuard), and how a refusal is told apart as a reclassification
// (guardMismatchIsClassification). Pure functions - no DynamoDB.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  effectiveGuard,
  guardMismatchIsClassification,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';

const TENANT_ONLY = ['housingAuthority', 'voucherSize', 'pets', 'evictions', 'tenure', 'porting', 'status'];

function journal(target: string, plan: ResolutionReplayPlan): ActiveSuggestionResolution {
  return {
    itemId: `resolve#c1#${target}`,
    state: 'active',
    contactId: 'c1',
    target,
    identityKey: `revision#rev-${target}`,
    action: 'accept',
    snapshot: {
      itemId: `sugg#c1#${target}`,
      ownerContactId: 'c1',
      target,
      suggestedValue: 'x',
      conversationId: 'conv-1',
      createdAt: '2026-10-12T11:00:00.000Z',
    },
    plan,
    phase: 'claimed',
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-10-12T12:01:30.000Z',
    fence: 1,
    claimedAt: '2026-10-12T12:01:00.000Z',
  };
}

function fieldPlan(guard: ResolutionAttributeGuard, kind: 'contact' | 'status' = 'contact'): ResolutionReplayPlan {
  return { kind, patch: { x: 1 }, guard, audit: { eventType: 'ai_suggestion_accepted' } };
}

function contact(over: Record<string, unknown> = {}): ContactItem {
  return { contactId: 'c1', type: 'tenant', ...over } as ContactItem;
}

describe('effectiveGuard', () => {
  it.each(TENANT_ONLY)('adds caseworker_conversion absent to a pre-deploy %s guard', (target) => {
    const guard: ResolutionAttributeGuard = { [target]: { exists: false } };
    const kind = target === 'status' ? 'status' : 'contact';

    expect(effectiveGuard(journal(target, fieldPlan(guard, kind)))).toEqual({
      [target]: { exists: false },
      caseworker_conversion: { exists: false },
    });
  });

  it('leaves a guard that carries classification_revision exactly as it is', () => {
    const guard: ResolutionAttributeGuard = {
      voucherSize: { exists: false },
      classification_revision: { exists: true, value: 4 },
    };

    expect(effectiveGuard(journal('voucherSize', fieldPlan(guard)))).toEqual(guard);
  });

  it.each(['firstName', 'lastName', 'address'])('never extends a neutral %s guard', (target) => {
    const guard: ResolutionAttributeGuard = { [target]: { exists: false } };

    expect(effectiveGuard(journal(target, fieldPlan(guard)))).toEqual(guard);
  });

  it('answers an empty guard for a phone or a dismiss plan', () => {
    expect(effectiveGuard(journal('phone', {
      kind: 'phone', phone: '+15550102020', audit: { eventType: 'contact_phone_added' },
    }))).toEqual({});
    expect(effectiveGuard(journal('pets', {
      kind: 'dismiss', normalizedValue: 'two cats', audit: { eventType: 'ai_suggestion_dismissed' },
    }))).toEqual({});
  });

  it('never mutates the stored guard', () => {
    const guard: ResolutionAttributeGuard = { pets: { exists: false } };

    effectiveGuard(journal('pets', fieldPlan(guard)));

    expect(guard).toEqual({ pets: { exists: false } });
  });
});

describe('guardMismatchIsClassification', () => {
  it('is true when classification_revision was read absent and is now stored', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      contact({ classification_revision: 1 }),
    )).toBe(true);
  });

  it('is true when the stored revision moved on', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: true, value: 1 } },
      contact({ classification_revision: 2 }),
    )).toBe(true);
  });

  it('is true when the legacy caseworker_conversion key mismatches', () => {
    expect(guardMismatchIsClassification(
      { housingAuthority: { exists: false }, caseworker_conversion: { exists: false } },
      contact({ caseworker_conversion: { at: '2026-10-12T12:00:00.000Z', by: 'u1', fromType: 'tenant' } }),
    )).toBe(true);
  });

  it('is false when only a written field changed', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: true, value: 2 } },
      contact({ pets: 'one dog', classification_revision: 2 }),
    )).toBe(false);
  });

  it('is true when a field AND the classification changed - classification wins the tie', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      contact({ pets: 'one dog', classification_revision: 1 }),
    )).toBe(true);
  });

  it('is false for a contact that no longer exists', () => {
    expect(guardMismatchIsClassification(
      { pets: { exists: false }, classification_revision: { exists: false } },
      undefined,
    )).toBe(false);
  });

  it('is false for a guard that names no classification key', () => {
    expect(guardMismatchIsClassification(
      { address: { exists: false } },
      contact({ address: { line1: '1 Main St' }, classification_revision: 5 }),
    )).toBe(false);
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassificationGuard.test.ts`

RED: every case fails (or the file fails to load) with
`effectiveGuard is not a function` / `does not provide an export named
'effectiveGuard'` - neither function exists in the repo module yet.

### Step 3 - implement

Edit `app/src/repos/suggestionResolutionRepo.ts` (import):

old_string:
```ts
import { DECISION_TARGETS } from '../services/extraction/runTypes.js';
```
new_string:
```ts
import { DECISION_TARGETS, TENANT_ONLY_TARGETS } from '../services/extraction/runTypes.js';
```

Edit the same file (replace `contactMatchesGuard` and add the new functions
after it; `contactMatchesGuard`'s behavior is unchanged - it now shares the
per-key test):

old_string:
```ts
function contactMatchesGuard(
  contact: ContactItem | undefined,
  guard: ResolutionAttributeGuard,
): boolean {
  if (contact === undefined) return false;
  return Object.entries(guard).every(([key, expected]) => {
    const exists = Object.prototype.hasOwnProperty.call(contact, key) && contact[key] !== undefined;
    return expected.exists
      ? exists && isDeepStrictEqual(contact[key], expected.value)
      : !exists;
  });
}
```
new_string:
```ts
/** One guard clause against a contact read - the in-memory twin of contactGuardCondition. */
function attributeMatches(
  contact: ContactItem,
  key: string,
  expected: ResolutionAttributeGuard[string],
): boolean {
  const exists = Object.prototype.hasOwnProperty.call(contact, key) && contact[key] !== undefined;
  return expected.exists
    ? exists && isDeepStrictEqual(contact[key], expected.value)
    : !exists;
}

function contactMatchesGuard(
  contact: ContactItem | undefined,
  guard: ResolutionAttributeGuard,
): boolean {
  if (contact === undefined) return false;
  return Object.entries(guard).every(([key, expected]) => attributeMatches(contact, key, expected));
}

/**
 * Spec 2026-10-12 D1: the guard keys that describe the contact's
 * CLASSIFICATION rather than a field the plan writes. classification_revision
 * is fenced by every tenant-only accept planned after the deploy;
 * caseworker_conversion is the legacy fallback effectiveGuard adds for a
 * journal claimed before it.
 */
export const CLASSIFICATION_GUARD_KEYS: readonly string[] = ['classification_revision', 'caseworker_conversion'];

/**
 * Spec 2026-10-12 D1 change 4: the ONE guard commitContactEffect evaluates -
 * at its commit condition, at the consistent re-read that tells `stale` from a
 * mismatch, and at the mismatch ConditionCheck - and the one the test fake
 * evaluates, so the two cannot drift. It is the plan's guard, EXTENDED for a
 * tenant-only journal claimed before classification_revision joined the guard:
 * such a journal also requires caseworker_conversion to be absent (the
 * conversion writes that attribute in the same write as the type change), so a
 * legacy journal recovered onto a converted contact ends superseded instead of
 * writing tenant facts onto a caseworker or looping on `stale`. Known limit: a
 * legacy journal is not fenced against a GENERIC re-type. Phone and dismiss
 * plans carry no guard and answer {}. Never mutates the stored plan.
 */
export function effectiveGuard(journal: ActiveSuggestionResolution): ResolutionAttributeGuard {
  const plan = journal.plan;
  if (plan.kind !== 'contact' && plan.kind !== 'status') return {};
  const guard = plan.guard;
  if (!TENANT_ONLY_TARGETS.has(journal.target)) return guard;
  if (Object.prototype.hasOwnProperty.call(guard, 'classification_revision')) return guard;
  return { ...guard, caseworker_conversion: { exists: false } };
}

/**
 * Spec 2026-10-12 D1 change 5: true when `contact` fails `guard` on a
 * CLASSIFICATION key, so the refusal is a reclassification - and that answer
 * wins when a written field ALSO changed. A contact that no longer exists is
 * not a reclassification (it stays a human-edit refusal, as before).
 */
export function guardMismatchIsClassification(
  guard: ResolutionAttributeGuard,
  contact: ContactItem | undefined,
): boolean {
  if (contact === undefined) return false;
  return CLASSIFICATION_GUARD_KEYS.some((key) => {
    const expected = guard[key];
    return expected !== undefined && !attributeMatches(contact, key, expected);
  });
}
```

Note for the builder: no comment or code in this file may contain the literal
text `.plan.guard` from here on - Task 1.6 pins that the three sites read the
guard only through `effectiveGuard`. (`effectiveGuard` itself reads it as
`plan.guard` through the local `plan`.)

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassificationGuard.test.ts test/suggestionResolutionRepo.test.ts`
All pass. Then `cd "W:/tmp/caseworker-integrity"; npm run typecheck` passes.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/repos/suggestionResolutionRepo.ts app/test/suggestionReclassificationGuard.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(suggestions): effectiveGuard and guardMismatchIsClassification for the D1 fence" -m "Spec 2026-10-12 D1 changes 4-5: one exported guard for the repository and its fake, extended with caseworker_conversion absent for a pre-deploy tenant-only journal; a classification-key mismatch is a reclassification and wins a tie." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.5 - The real repository evaluates `effectiveGuard` at all three sites and answers `superseded_by_reclassification`

Goal: spec 2 changes 4-5 on the real repo. `commitContactEffect` uses
`effectiveGuard(journal)` at the commit condition (`:798`), the stale-versus-
mismatch re-read (`:827`) and the mismatch ConditionCheck (`:831`); the result
union gains `'superseded_by_reclassification'`, returned when the mismatch is
in a classification key (classification wins a tie); the stored outcome stays
`superseded_by_human_edit`. W4: the legacy case runs on DynamoDB Local.

Files:
- modify `app/src/repos/suggestionResolutionRepo.ts`
- modify `app/test/suggestionResolutionRepo.integration.test.ts`

### Step 1 - failing tests

Start DynamoDB Local if needed: `cd "W:/tmp/caseworker-integrity"; npm run db:start`.

Edit `app/test/suggestionResolutionRepo.integration.test.ts` (imports):

old_string:
```ts
  type ClaimResolutionInput,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
```
new_string:
```ts
  type ClaimResolutionInput,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
```

Edit the same file - insert the block BEFORE this existing comment (inside the
first describe, so `putContact`, `putSuggestion`, `claimInput`, `resolutions`,
`doc`, `contactsTable` and `auditTable` are in scope):

old_string:
```ts
  // The two rules the crash-suite fake mirrors but nothing pinned on the real
  // side (F7b). Both are decided in the repository's catch paths, so only a real
  // cancellation exercises them.
```
new_string:
```ts
  // Spec 2026-10-12 D1 changes 4-5. commitContactEffect consults ONE guard -
  // effectiveGuard - at its commit condition, at the consistent re-read that
  // tells `stale` from a mismatch, and at the mismatch ConditionCheck. Only a
  // real cancellation reaches the last two, so the legacy case is proved HERE
  // (plan watch item W4): a site left on the raw plan guard turns it into
  // 'committed' (the commit condition) or 'stale' (either later site).
  const authorityPlan = (guard: ResolutionAttributeGuard): ResolutionReplayPlan => ({
    kind: 'contact',
    patch: {
      housingAuthority: 'Atlanta Housing Authority',
      housingAuthority_source: { source: 'ai', at: '2026-08-08T12:01:00.000Z' },
    },
    guard,
    audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'housingAuthority' } },
  });
  const CONVERTED = {
    type: 'partner',
    role: 'Caseworker',
    status: 'active',
    classification_revision: 1,
    caseworker_conversion: { at: '2026-08-08T12:00:30.000Z', by: 'user-2', fromType: 'tenant' },
  };

  async function claimFor(contactId: string, target: string, value: string, plan: ResolutionReplayPlan) {
    const suggestion = await putSuggestion(contactId, target, value);
    const claimed = await resolutions.claim(claimInput(suggestion, { plan }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    return {
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed' as const,
      nextPhase: 'domain_applied' as const,
    };
  }

  async function readContact(contactId: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: contactsTable, Key: { contactId }, ConsistentRead: true,
    }));
    return Item;
  }

  async function auditRows(contactId: string): Promise<unknown[]> {
    const audit = await doc.send(new QueryCommand({
      TableName: auditTable,
      KeyConditionExpression: 'entityKey = :entity',
      ExpressionAttributeValues: { ':entity': `contacts#${contactId}` },
    }));
    return audit.Items ?? [];
  }

  it('answers superseded_by_reclassification when classification_revision moved on, writing nothing', async () => {
    const contactId = 'reclass-revision';
    await putContact(contactId);
    const phase = await claimFor(contactId, 'housingAuthority', 'Atlanta Housing Authority', authorityPlan({
      housingAuthority: { exists: false },
      housingAuthority_source: { exists: false },
      classification_revision: { exists: false },
    }));
    await putContact(contactId, CONVERTED);

    expect(await resolutions.commitContactEffect(phase)).toBe('superseded_by_reclassification');

    expect((await readContact(contactId))?.['housingAuthority']).toBeUndefined();
    expect(await auditRows(contactId)).toEqual([]);
    // Stored exactly like a human-edit refusal - same outcome, so the run-log
    // verdict the service stamps from it is the same too.
    expect(await resolutions.get(contactId, 'housingAuthority')).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
  });

  it('answers superseded_by_reclassification when the field ALSO changed - classification wins the tie', async () => {
    const contactId = 'reclass-tie';
    await putContact(contactId, { housingAuthority: 'DeKalb County Housing Authority' });
    const phase = await claimFor(contactId, 'housingAuthority', 'Atlanta Housing Authority', authorityPlan({
      housingAuthority: { exists: true, value: 'DeKalb County Housing Authority' },
      housingAuthority_source: { exists: false },
      classification_revision: { exists: false },
    }));
    // The conversion REMOVES the authority and bumps the revision in one write.
    await putContact(contactId, CONVERTED);

    expect(await resolutions.commitContactEffect(phase)).toBe('superseded_by_reclassification');
    expect((await readContact(contactId))?.['housingAuthority']).toBeUndefined();
  });

  it('ends a pre-deploy journal (no classification_revision in its guard) on a converted contact as superseded, never committed or stale', async () => {
    const contactId = 'reclass-legacy-converted';
    await putContact(contactId);
    const phase = await claimFor(contactId, 'housingAuthority', 'Atlanta Housing Authority', authorityPlan({
      housingAuthority: { exists: false },
      housingAuthority_source: { exists: false },
    }));
    await putContact(contactId, CONVERTED);

    expect(await resolutions.commitContactEffect(phase)).toBe('superseded_by_reclassification');

    expect((await readContact(contactId))?.['housingAuthority']).toBeUndefined();
    expect(await auditRows(contactId)).toEqual([]);
    expect(await resolutions.get(contactId, 'housingAuthority')).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
  });

  it('still commits that pre-deploy journal onto an unconverted tenant (PIN)', async () => {
    const contactId = 'reclass-legacy-tenant';
    await putContact(contactId);
    const phase = await claimFor(contactId, 'housingAuthority', 'Atlanta Housing Authority', authorityPlan({
      housingAuthority: { exists: false },
      housingAuthority_source: { exists: false },
    }));

    expect(await resolutions.commitContactEffect(phase)).toBe('committed');
    expect((await readContact(contactId))?.['housingAuthority']).toBe('Atlanta Housing Authority');
  });

  it('keeps a field-only change a human edit when the revision is unchanged (PIN)', async () => {
    const contactId = 'reclass-field-only';
    await putContact(contactId, { classification_revision: 2 });
    const phase = await claimFor(contactId, 'pets', 'two cats', {
      kind: 'contact',
      patch: { pets: 'two cats' },
      guard: { pets: { exists: false }, classification_revision: { exists: true, value: 2 } },
      audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'pets' } },
    });
    await putContact(contactId, { classification_revision: 2, pets: 'one dog' });

    expect(await resolutions.commitContactEffect(phase)).toBe('superseded_by_human_edit');
    expect((await readContact(contactId))?.['pets']).toBe('one dog');
  });

  it('never extends a neutral guard: an address journal still commits onto a converted contact (PIN)', async () => {
    const contactId = 'reclass-neutral';
    await putContact(contactId);
    const phase = await claimFor(contactId, 'address', '1 Main St', {
      kind: 'contact',
      patch: { address: { line1: '1 Main St' } },
      guard: { address: { exists: false } },
      audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'address' } },
    });
    await putContact(contactId, CONVERTED);

    expect(await resolutions.commitContactEffect(phase)).toBe('committed');
    expect((await readContact(contactId))?.['address']).toEqual({ line1: '1 Main St' });
  });

  // The two rules the crash-suite fake mirrors but nothing pinned on the real
  // side (F7b). Both are decided in the repository's catch paths, so only a real
  // cancellation exercises them.
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionResolutionRepo.integration.test.ts`

RED, and why:
- `moved on` and `classification wins the tie`: `expected 'superseded_by_human_edit'
  to be 'superseded_by_reclassification'` - the repo already enforces the
  revision key in the guard but has only one refusal answer.
- `pre-deploy journal ... converted`: `expected 'committed' to be
  'superseded_by_reclassification'` - the commit condition (`:798`) uses the
  raw plan guard (both authority attributes absent), which still matches.
- The three PIN cases pass.
If the suite is skipped (no endpoint), it is NOT a RED - start DynamoDB Local.

### Step 3 - implement

Edit `app/src/repos/suggestionResolutionRepo.ts` (result union):

old_string:
```ts
export type ResolutionEffectResult =
  | 'committed'
  | 'already_committed'
  | 'stale'
  | 'phone_conflict'
  | 'superseded_by_human_edit';
```
new_string:
```ts
export type ResolutionEffectResult =
  | 'committed'
  | 'already_committed'
  | 'stale'
  | 'phone_conflict'
  | 'superseded_by_human_edit'
  // Spec 2026-10-12 D1 change 5: refused because the contact's classification
  // changed after the plan read it. Stored exactly like a human-edit refusal
  // (journal outcome superseded_by_human_edit); only the caller's answer differs.
  | 'superseded_by_reclassification';
```

Edit the same file (site 1, the commit condition):

old_string:
```ts
      const audit = auditItem(journal);
      const contactGuard = contactGuardCondition(journal.plan.guard, true);
```
new_string:
```ts
      const audit = auditItem(journal);
      // Spec 2026-10-12 D1: ONE guard for the commit condition, the
      // stale-versus-mismatch re-read and the mismatch ConditionCheck below -
      // the plan's guard as effectiveGuard extends it for a pre-deploy
      // tenant-only journal. A site that read the plan's guard directly would
      // turn a legacy journal on a converted contact into a `stale` loop.
      const guard = effectiveGuard(journal);
      const contactGuard = contactGuardCondition(guard, true);
```

Edit the same file (sites 2 and 3, the re-read and the mismatch check):

old_string:
```ts
      if (contactMatchesGuard(Item as ContactItem | undefined, journal.plan.guard)) {
        return 'stale';
      }

      const mismatchGuard = contactGuardCondition(journal.plan.guard, false);
```
new_string:
```ts
      const contact = Item as ContactItem | undefined;
      if (contactMatchesGuard(contact, guard)) {
        return 'stale';
      }
      // Spec 2026-10-12 D1 change 5: a mismatch in a CLASSIFICATION key
      // (classification_revision, or the legacy caseworker_conversion) is a
      // reclassification, and it wins when a written field ALSO changed. It is
      // decided from this consistent read; a classification change landing
      // between this read and the ConditionCheck below answers as a human edit.
      // The stored outcome and the run-log verdict are the same either way.
      const refusal: 'superseded_by_human_edit' | 'superseded_by_reclassification' =
        guardMismatchIsClassification(guard, contact)
          ? 'superseded_by_reclassification'
          : 'superseded_by_human_edit';

      const mismatchGuard = contactGuardCondition(guard, false);
```

Edit the same file (both refusal returns answer `refusal`):

old_string:
```ts
            { Update: journalSuperseded(extractionTable, input) },
          ],
        }));
        return 'superseded_by_human_edit';
      } catch (error) {
        if (isValidationFailure(error)) throw error;
        const after = await getJournal(input.token.contactId, input.token.target);
        if (
          sameToken(after, input.token)
          && after.phase === input.nextPhase
          && after.outcome === 'superseded_by_human_edit'
        ) {
          return 'superseded_by_human_edit';
        }
        return 'stale';
      }
```
new_string:
```ts
            { Update: journalSuperseded(extractionTable, input) },
          ],
        }));
        return refusal;
      } catch (error) {
        if (isValidationFailure(error)) throw error;
        const after = await getJournal(input.token.contactId, input.token.target);
        if (
          sameToken(after, input.token)
          && after.phase === input.nextPhase
          && after.outcome === 'superseded_by_human_edit'
        ) {
          return refusal;
        }
        return 'stale';
      }
```

Verify: `cd "W:/tmp/caseworker-integrity/app"; grep -c "plan\.guard" src/repos/suggestionResolutionRepo.ts`
prints 1 (only `const guard = plan.guard;` inside `effectiveGuard`), and
`grep -c "\.plan\.guard" src/repos/suggestionResolutionRepo.ts` prints 0.

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionResolutionRepo.integration.test.ts test/suggestionReclassificationGuard.test.ts test/suggestionReclassification.test.ts test/aiRunVerdicts.test.ts`
All pass. `cd "W:/tmp/caseworker-integrity"; npm run typecheck` passes.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/repos/suggestionResolutionRepo.ts app/test/suggestionResolutionRepo.integration.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): evaluate effectiveGuard at all three contact-effect sites" -m "Spec 2026-10-12 D1 changes 4-5: the commit condition, the stale-versus-mismatch re-read and the mismatch ConditionCheck share one guard, so a pre-deploy journal on a converted contact ends superseded instead of committing or looping on stale; a classification mismatch answers superseded_by_reclassification (stored outcome unchanged). Proved on DynamoDB Local." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.6 - The test fake reads the guard only through `effectiveGuard` and answers like the real repository

Goal: spec 2 changes 4-5 in `app/test/helpers/suggestionResolutionFake.ts`
(`:322-336`): the fake imports `effectiveGuard` and
`guardMismatchIsClassification` from the repo, returns
`superseded_by_reclassification` when the repo would, and stores outcome
`superseded_by_human_edit` for both refusals. Pinned: neither the repo nor the
fake reads the raw plan guard (spec 8: "`effectiveGuard` is the one function
the three real-repo sites and the fake call").

Files:
- modify `app/test/helpers/suggestionResolutionFake.ts`
- modify `app/test/suggestionReclassificationGuard.test.ts`
- modify `app/test/suggestionReclassification.test.ts`

### Step 1 - failing tests

Edit `app/test/suggestionReclassificationGuard.test.ts` (imports):

old_string:
```ts
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  effectiveGuard,
  guardMismatchIsClassification,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
```
new_string:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  effectiveGuard,
  guardMismatchIsClassification,
  tokenFor,
  type ActiveSuggestionResolution,
  type ResolutionAttributeGuard,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
```

Append at the END of `app/test/suggestionReclassificationGuard.test.ts`:

```ts
// The FakeWorld half of the parity the real-repo cases in
// suggestionResolutionRepo.integration.test.ts prove on DynamoDB Local - the
// same plans, the same contact states, the same answers.
describe('the FakeWorld journal answers like the real repository (spec 2026-10-12 D1, W4)', () => {
  const NOW = '2026-10-12T12:01:00.000Z';
  const CONVERTED = {
    type: 'partner',
    role: 'Caseworker',
    status: 'active',
    classification_revision: 1,
    caseworker_conversion: { at: '2026-10-12T12:00:30.000Z', by: 'user-2', fromType: 'tenant' },
  };

  function authorityPlan(guard: ResolutionAttributeGuard): ResolutionReplayPlan {
    return {
      kind: 'contact',
      patch: {
        housingAuthority: 'Atlanta Housing Authority',
        housingAuthority_source: { source: 'ai', at: NOW },
      },
      guard,
      audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'housingAuthority' } },
    };
  }

  function seedFakeContact(world: FakeWorld, contactId: string, over: Record<string, unknown> = {}): void {
    world.contacts.push({
      contactId, type: 'tenant', status: 'onboarding', created_at: '2026-07-01T10:00:00.000Z', ...over,
    });
  }

  /** The conversion's commit, applied to the stored contact: authority removed, re-typed, revision bumped. */
  function convertInPlace(world: FakeWorld, contactId: string): void {
    const contact = world.contacts.find((c) => c.contactId === contactId);
    if (contact === undefined) throw new Error('no contact');
    delete contact['housingAuthority'];
    delete contact['housingAuthority_source'];
    Object.assign(contact, CONVERTED);
  }

  async function claimOnFake(
    world: FakeWorld,
    input: { contactId: string; target: string; suggestedValue: string; plan: ResolutionReplayPlan },
  ) {
    await world.extractionRepo.putSuggestion({
      ownerContactId: input.contactId,
      target: input.target,
      suggestedValue: input.suggestedValue,
      conversationId: `conv-${input.contactId}`,
    });
    const suggestion = await world.extractionRepo.getSuggestion(input.contactId, input.target);
    if (suggestion === undefined) throw new Error('suggestion not stored');
    const claimed = await world.suggestionResolutionRepo.claim({
      suggestion,
      action: 'accept',
      actorId: 'user-1',
      plan: input.plan,
      now: NOW,
      leaseId: `lease-${input.contactId}`,
      leaseMs: 30_000,
    });
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    return {
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed' as const,
      nextPhase: 'domain_applied' as const,
    };
  }

  function storedJournal(world: FakeWorld, contactId: string, target: string) {
    return [...world.suggestionResolutions.values()].find(
      (item) => item.contactId === contactId && item.target === target,
    );
  }

  it('answers superseded_by_reclassification when classification_revision moved on, storing the human-edit outcome', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-revision');
    const phase = await claimOnFake(world, {
      contactId: 'f-revision', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({
        housingAuthority: { exists: false },
        housingAuthority_source: { exists: false },
        classification_revision: { exists: false },
      }),
    });
    convertInPlace(world, 'f-revision');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');

    expect(world.contacts.find((c) => c.contactId === 'f-revision')?.['housingAuthority']).toBeUndefined();
    expect(storedJournal(world, 'f-revision', 'housingAuthority')).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
  });

  it('answers superseded_by_reclassification when the field ALSO changed - classification wins the tie', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-tie', { housingAuthority: 'DeKalb County Housing Authority' });
    const phase = await claimOnFake(world, {
      contactId: 'f-tie', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({
        housingAuthority: { exists: true, value: 'DeKalb County Housing Authority' },
        housingAuthority_source: { exists: false },
        classification_revision: { exists: false },
      }),
    });
    convertInPlace(world, 'f-tie');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');
  });

  it('ends a pre-deploy journal on a converted contact as superseded, never committed', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-legacy');
    const phase = await claimOnFake(world, {
      contactId: 'f-legacy', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({ housingAuthority: { exists: false }, housingAuthority_source: { exists: false } }),
    });
    convertInPlace(world, 'f-legacy');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_reclassification');
    expect(world.contacts.find((c) => c.contactId === 'f-legacy')?.['housingAuthority']).toBeUndefined();
  });

  it('still commits that pre-deploy journal onto an unconverted tenant (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-legacy-tenant');
    const phase = await claimOnFake(world, {
      contactId: 'f-legacy-tenant', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      plan: authorityPlan({ housingAuthority: { exists: false }, housingAuthority_source: { exists: false } }),
    });

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('committed');
    expect(world.contacts.find((c) => c.contactId === 'f-legacy-tenant')?.['housingAuthority'])
      .toBe('Atlanta Housing Authority');
  });

  it('keeps a field-only change a human edit when the revision is unchanged (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-field', { classification_revision: 2 });
    const phase = await claimOnFake(world, {
      contactId: 'f-field', target: 'pets', suggestedValue: 'two cats',
      plan: {
        kind: 'contact',
        patch: { pets: 'two cats' },
        guard: { pets: { exists: false }, classification_revision: { exists: true, value: 2 } },
        audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'pets' } },
      },
    });
    const contact = world.contacts.find((c) => c.contactId === 'f-field');
    if (contact === undefined) throw new Error('no contact');
    contact['pets'] = 'one dog';

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('superseded_by_human_edit');
  });

  it('never extends a neutral guard: an address journal still commits onto a converted contact (PIN)', async () => {
    const world = createFakeWorld();
    seedFakeContact(world, 'f-neutral');
    const phase = await claimOnFake(world, {
      contactId: 'f-neutral', target: 'address', suggestedValue: '1 Main St',
      plan: {
        kind: 'contact',
        patch: { address: { line1: '1 Main St' } },
        guard: { address: { exists: false } },
        audit: { eventType: 'ai_suggestion_accepted', payload: { target: 'address' } },
      },
    });
    convertInPlace(world, 'f-neutral');

    expect(await world.suggestionResolutionRepo.commitContactEffect(phase)).toBe('committed');
  });
});

describe('one guard function for the repository and its fake (spec 2026-10-12 D1 change 4)', () => {
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length;

  it('commitContactEffect evaluates effectiveGuard at all three sites and never the raw plan guard', () => {
    const repo = read('../src/repos/suggestionResolutionRepo.ts');

    expect(count(repo, /\.plan\.guard\b/g)).toBe(0);
    expect(count(repo, /effectiveGuard\(journal\)/g)).toBe(1);
    expect(repo).toContain('contactGuardCondition(guard, true)');
    expect(repo).toContain('contactMatchesGuard(contact, guard)');
    expect(repo).toContain('contactGuardCondition(guard, false)');
  });

  it('the fake imports both guard functions from the repository and reads no plan guard of its own', () => {
    const fake = read('./helpers/suggestionResolutionFake.ts');

    expect(count(fake, /\.plan\.guard\b/g)).toBe(0);
    expect(count(fake, /effectiveGuard\(journal\)/g)).toBe(1);
    expect(fake).toMatch(
      /import \{[^}]*\beffectiveGuard\b[^}]*\} from '\.\.\/\.\.\/src\/repos\/suggestionResolutionRepo\.js'/,
    );
    expect(fake).toMatch(
      /import \{[^}]*\bguardMismatchIsClassification\b[^}]*\} from '\.\.\/\.\.\/src\/repos\/suggestionResolutionRepo\.js'/,
    );
  });
});
```

Edit `app/test/suggestionReclassification.test.ts` (helper):

old_string:
```ts
// D1 cases. Later tasks insert their helpers ABOVE this line.
```
new_string:
```ts
/** Turn an active journal into one claimed before the deploy: no classification_revision in its guard. */
function stripRevisionFromJournal(world: FakeWorld, contactId: string, target: string): void {
  for (const [key, item] of world.suggestionResolutions) {
    if (item.state === 'active' && item.contactId === contactId && item.target === target) {
      if (item.plan.kind !== 'contact' && item.plan.kind !== 'status') throw new Error('expected a contact plan');
      const { classification_revision: _dropped, ...legacyGuard } = item.plan.guard;
      world.suggestionResolutions.set(key, { ...item, plan: { ...item.plan, guard: legacyGuard } });
      return;
    }
  }
  throw new Error('expected an active resolution');
}

// D1 cases. Later tasks insert their helpers ABOVE this line.
```

Append at the END of `app/test/suggestionReclassification.test.ts`:

```ts
describe('D1 change 4: a journal claimed before the deploy (no revision in its guard)', () => {
  it('recovered by a read onto a converted contact ends superseded and writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    stripRevisionFromJournal(world, 'c1', 'housingAuthority');
    await convert(app, 'c1').expect(200);
    expireActiveResolution(world, 'c1', 'housingAuthority');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')?.['housingAuthority']).toBeUndefined();
    expect(contactOf(world, 'c1')?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });

  it('recovered by a read onto an unconverted tenant still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    await accept(crashingApp(world), 'c1', 'housingAuthority').expect(500);
    stripRevisionFromJournal(world, 'c1', 'housingAuthority');
    expireActiveResolution(world, 'c1', 'housingAuthority');

    await list(app, 'c1').expect(200);

    expect(contactOf(world, 'c1')?.['housingAuthority']).toBe('Atlanta Housing Authority');
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassificationGuard.test.ts test/suggestionReclassification.test.ts`

RED, and why:
- `moved on` and `tie` (fake): `expected 'superseded_by_human_edit' to be
  'superseded_by_reclassification'` - the fake has one refusal answer.
- `pre-deploy journal on a converted contact` (fake) and the FakeWorld
  `recovered by a read onto a converted contact`: `expected 'committed' ...` /
  `expected 'Atlanta Housing Authority' to be undefined` - the fake evaluates
  the raw plan guard (`suggestionResolutionFake.ts:334`).
- `the fake imports both guard functions ...`: `.plan.guard` count is 1 and
  the import is missing.
- The repo-side pin and the PIN cases pass (Task 1.5 already made the repo use
  `effectiveGuard`).

### Step 3 - implement

Edit `app/test/helpers/suggestionResolutionFake.ts` (imports):

old_string:
```ts
import {
  makeCompletedResolution,
  resolutionItemId,
```
new_string:
```ts
import {
  effectiveGuard,
  guardMismatchIsClassification,
  makeCompletedResolution,
  resolutionItemId,
```

Edit the same file (the effect wrapper's callback type):

old_string:
```ts
    ) => Promise<'committed' | 'phone_conflict' | 'superseded_by_human_edit' | 'stale'>,
```
new_string:
```ts
    ) => Promise<
      'committed' | 'phone_conflict' | 'superseded_by_human_edit' | 'superseded_by_reclassification' | 'stale'
    >,
```

Edit the same file (the stored outcome):

old_string:
```ts
    if (result === 'superseded_by_human_edit') {
      // repo:760 journalSuperseded stamps phase AND outcome together.
      items.set(key(journal.contactId, journal.target), {
        ...journal,
        phase: input.nextPhase,
        outcome: result,
      });
      return result;
    }
```
new_string:
```ts
    if (result === 'superseded_by_human_edit' || result === 'superseded_by_reclassification') {
      // The repo's journalSuperseded stamps phase AND outcome together, and the
      // stored outcome is superseded_by_human_edit for BOTH refusals (spec
      // 2026-10-12 D1 change 5) - only the answer to the caller differs.
      items.set(key(journal.contactId, journal.target), {
        ...journal,
        phase: input.nextPhase,
        outcome: 'superseded_by_human_edit',
      });
      return result;
    }
```

Edit the same file (`commitContactEffect`):

old_string:
```ts
        const contact = await deps.contactsRepo.getById(journal.contactId);
        // repo:732-763 - arbitration order: the journal must still be ours at
        // the expected phase (activeFor, above), THEN a consistent re-read
        // decides. A contact that still matches the guard means the write lost
        // to CONTENTION, which is 'stale'; only a MISMATCH is a human edit.
        if (!contactMatchesGuard(contact, journal.plan.guard)) {
          return 'superseded_by_human_edit';
        }
```
new_string:
```ts
        const contact = await deps.contactsRepo.getById(journal.contactId);
        // The repo's commitContactEffect arbitration order: the journal must
        // still be ours at the expected phase (activeFor, above), THEN a
        // consistent re-read decides. A contact that still matches the guard
        // means the write lost to CONTENTION, which is 'stale'; only a MISMATCH
        // is a refusal. The guard is effectiveGuard's - the SAME exported
        // function the real repository evaluates at all three of its sites
        // (spec 2026-10-12 D1 change 4) - and a classification mismatch wins a
        // tie (change 5).
        const guard = effectiveGuard(journal);
        if (!contactMatchesGuard(contact, guard)) {
          return guardMismatchIsClassification(guard, contact)
            ? 'superseded_by_reclassification'
            : 'superseded_by_human_edit';
        }
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassificationGuard.test.ts test/suggestionReclassification.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/suggestionAcceptOrgList.test.ts`
All pass. `cd "W:/tmp/caseworker-integrity"; npm run typecheck` passes.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/test/helpers/suggestionResolutionFake.ts app/test/suggestionReclassificationGuard.test.ts app/test/suggestionReclassification.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "test(suggestions): the resolution fake evaluates effectiveGuard like the real repository" -m "Spec 2026-10-12 D1 changes 4-5: the fake imports effectiveGuard and guardMismatchIsClassification, answers superseded_by_reclassification and stores the human-edit outcome; a source pin keeps both off the raw plan guard." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.7 - The requester of a reclassified accept hears 409 `suggestion_contact_reclassified`

Goal: spec 2 change 5, service half. `applyJournal` carries
`refusedByReclassification`; `resolve()` answers 409
`suggestion_contact_reclassified` for its OWN claim (classification first); a
journal reached by helping keeps today's answers. Schedule A on the FakeWorld
routes and on the real repos (DynamoDB Local), plus the real-repo schedule B
(read + sweep) and the real-repo legacy recovery. Plan review R1 row 8: the
`voucherSize` accept spanning a GENERIC tenant -> landlord re-type (through
the real `contactsRepo.update`, which bumps `classification_revision`) and
the `status` accept spanning a conversion (the classification-vs-field tie)
also run on the real repos, not only on the FakeWorld. The phone accept stays
FakeWorld-only: phone is a neutral target, never fenced, and commits through
`commitPhoneEffect`, which D1 does not touch.

Files:
- modify `app/src/services/suggestionResolution.ts`
- modify `app/test/suggestionReclassification.test.ts`
- create `app/test/suggestionReclassification.integration.test.ts`

### Step 1 - failing tests

Edit `app/test/suggestionReclassification.test.ts` (helper):

old_string:
```ts
// D1 cases. Later tasks insert their helpers ABOVE this line.
```
new_string:
```ts
/**
 * An app whose accept pauses right after its claim until `release()` - the
 * R2-ADV-1 schedule A window, deterministic.
 */
function pausedAtClaim(world: FakeWorld): {
  app: import('express').Express;
  atClaim: Promise<void>;
  release: () => void;
} {
  let releaseHold!: () => void;
  const held = new Promise<void>((resolve) => { releaseHold = resolve; });
  let reached!: () => void;
  const atClaim = new Promise<void>((resolve) => { reached = resolve; });
  const { app } = makeWebhookHarness({
    world,
    suggestionResolutionHooks: {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') {
          reached();
          await held;
        }
      },
    },
  });
  return { app, atClaim, release: () => releaseHold() };
}

// D1 cases. Later tasks insert their helpers ABOVE this line.
```

Append at the END of `app/test/suggestionReclassification.test.ts`:

```ts
describe('D1 change 5: the requester of a refused accept hears 409 suggestion_contact_reclassified', () => {
  it('A: an authority accept paused at claimed, then a conversion, answers 409 and writes no authority', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const setVerdict = vi.spyOn(world.aiRuns, 'setVerdict');
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    const contact = contactOf(world, 'c1');
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect(journalFor(world, 'c1', 'housingAuthority')?.state).toBe('completed');
    // The run log records it exactly as a human-edit refusal (spec D1 change 5).
    expect(setVerdict).toHaveBeenCalledWith(
      'run-ha', 'housingAuthority', 'superseded_by_human_edit', expect.anything(),
    );
  });

  it('A: a voucherSize accept spanning a generic tenant -> landlord re-type answers 409 reclassified', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'voucherSize', suggestedValue: '3', conversationId: 'conv-1', runId: 'run-voucher',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'voucherSize').then((res) => res);
    await paused.atClaim;
    await patch(app, 'c1', { type: 'landlord' }).expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'landlord' });
    expect(contactOf(world, 'c1')?.['voucherSize']).toBeUndefined();
    expect(journalFor(world, 'c1', 'voucherSize')?.state).toBe('completed');
  });

  it('A: a status accept spanning a conversion answers reclassified - classification wins the tie with status', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'status', suggestedValue: 'searching', conversationId: 'conv-1', runId: 'run-status',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'status').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    // The conversion's own status stands; the accepted one was never written.
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'partner', status: 'active' });
  });

  it('A: an accept over a prior authority spanning a conversion answers reclassified - classification wins the tie with the field', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world, {
      housingAuthority: 'DeKalb County Housing Authority',
      housingAuthority_source: { source: 'manual', at: '2026-09-01T00:00:00.000Z' },
    });
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(contactOf(world, 'c1')?.['housingAuthority']).toBeUndefined();
  });

  it('A: an address accept claimed before the conversion still commits onto the caseworker (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'address', suggestedValue: '1 Main St',
      suggestedAddress: { line1: '1 Main St' }, conversationId: 'conv-1', runId: 'run-address',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'address').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(contactOf(world, 'c1')).toMatchObject({ type: 'partner', address: { line1: '1 Main St' } });
  });

  it('A: a phone accept claimed before the conversion still commits (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'phone', suggestedValue: '+15550102020', conversationId: 'conv-1', runId: 'run-phone',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'phone').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);

    paused.release();
    const res = await pending;

    expect(res.status).toBe(200);
    const phones = (contactOf(world, 'c1')?.['phones'] as Array<{ phone: string }> | undefined) ?? [];
    expect(phones.map((entry) => entry.phone)).toContain('+15550102020');
  });
});
```

Create `app/test/suggestionReclassification.integration.test.ts` with exactly:

```ts
// Spec 2026-10-12 D1 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// sections 2 and 8): the R2-ADV-1 schedules against the REAL repositories on
// DynamoDB Local - the resolution service and the caseworker conversion built
// over prefixed throwaway tables, as the planner's executed reproduction ran
// them (docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md
// section 4). There is no router here, so the suggestion.updated emit is
// asserted by the FakeWorld twin (suggestionReclassification.test.ts); the
// commit-site cases are in suggestionResolutionRepo.integration.test.ts.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJournalSweep } from '../src/jobs/journalSweep.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createEventBus } from '../src/lib/events.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createActivityEventsRepo } from '../src/repos/activityEventsRepo.js';
import { createAiRunsRepo } from '../src/repos/aiRunsRepo.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactVocabularyRepo } from '../src/repos/contactVocabularyRepo.js';
import { createContactsRepo, type ContactItem } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
import { createOrgListRepo } from '../src/repos/orgListRepo.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import {
  createSuggestionResolutionRepo,
  resolutionItemId,
  type SuggestionResolutionItem,
} from '../src/repos/suggestionResolutionRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
import { createCaseworkerConversionService } from '../src/services/caseworkerConversion.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import {
  createSuggestionResolutionService,
  type SuggestionRequestIdentity,
  type SuggestionResolutionHooks,
} from '../src/services/suggestionResolution.js';
import { quietLogger } from './helpers/orgFixtures.js';

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
  console.warn(`[suggestionReclassification.integration] DynamoDB Local is required at ${endpoint}`);
}

/** The plan reads the contact and claims here. */
const T0 = '2026-10-12T12:00:00.000Z';
/** Past the 30s default lease, so a read-path recovery can take the journal over. */
const LATER = '2026-10-12T12:05:00.000Z';
/** Past the daily sweep's 24h claim-age gate. */
const DAY_LATER = '2026-10-13T13:00:00.000Z';
const ACTOR = 'usr_testreclass00000000000';
const AUTHORITY = 'Atlanta Housing Authority';
const BASES = [
  'contacts', 'conversations', 'placements', 'tours', 'units',
  'ai_extraction', 'ai_runs', 'audit_events', 'activity_events', 'settings',
] as const;

describe.skipIf(!reachable)('D1 schedules on the real repositories (DynamoDB Local)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = quietLogger();
  const deps = { doc, env: testEnv, logger };
  const contacts = createContactsRepo(deps);
  const extraction = createExtractionRepo(deps);
  const aiRuns = createAiRunsRepo(deps);
  const resolutions = createSuggestionResolutionRepo(deps);
  const orgNames = createOrgNamesService({ orgListRepo: createOrgListRepo(deps), logger });
  const events = createEventBus({ logger });
  const conversion = createCaseworkerConversionService({
    contacts,
    conversations: createConversationsRepo(deps),
    placements: createPlacementsRepo(deps),
    tours: createToursRepo(deps),
    units: createUnitsRepo(deps),
    extraction,
    aiRuns,
    audit: createAuditRepo(deps),
    activityEvents: createActivityEventsRepo(deps),
    vocabulary: createContactVocabularyRepo(deps),
    events,
    orgNames,
    logger,
  });
  const contactsTable = tableName('contacts', testEnv);
  const extractionTable = tableName('ai_extraction', testEnv);

  beforeAll(async () => {
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
  }, 120_000);

  afterAll(async () => {
    for (const base of BASES) await deleteTableIfExists(client, tableName(base, testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  function resolutionService(now: string, hooks?: SuggestionResolutionHooks) {
    return createSuggestionResolutionService({
      contactsRepo: contacts,
      extractionRepo: extraction,
      aiRunsRepo: aiRuns,
      resolutionRepo: resolutions,
      orgNamesService: orgNames,
      logger,
      now: () => now,
      ...(hooks !== undefined && { hooks }),
    });
  }

  async function seedTenant(contactId: string): Promise<void> {
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: {
        contactId, type: 'tenant', status: 'onboarding', firstName: 'Ana', lastName: 'Ruiz',
        created_at: '2026-07-01T10:00:00.000Z',
      },
    }));
  }

  async function seedAuthoritySuggestion(contactId: string): Promise<SuggestionRequestIdentity> {
    const { item } = await extraction.putSuggestion({
      ownerContactId: contactId,
      target: 'housingAuthority',
      suggestedValue: AUTHORITY,
      conversationId: `conv-${contactId}`,
      createdAt: '2026-10-12T11:00:00.000Z',
    });
    return { createdAt: item.createdAt, ...(item.revision !== undefined && { revision: item.revision }) };
  }

  /** A pending suggestion for any other target (the voucherSize and status cases). */
  async function seedTargetSuggestion(
    contactId: string,
    target: string,
    suggestedValue: string,
  ): Promise<SuggestionRequestIdentity> {
    const { item } = await extraction.putSuggestion({
      ownerContactId: contactId,
      target,
      suggestedValue,
      conversationId: `conv-${contactId}`,
      createdAt: '2026-10-12T11:00:00.000Z',
    });
    return { createdAt: item.createdAt, ...(item.revision !== undefined && { revision: item.revision }) };
  }

  async function readContact(contactId: string): Promise<ContactItem | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: contactsTable, Key: { contactId }, ConsistentRead: true,
    }));
    return Item as ContactItem | undefined;
  }

  /** The claim lands, then the process dies before the domain commit. */
  async function crashAfterClaim(contactId: string, identity: SuggestionRequestIdentity): Promise<void> {
    const crashing = resolutionService(T0, {
      afterBoundary: (boundary) => {
        if (boundary === 'claimed') throw new Error('simulated termination after claim');
      },
    });
    await expect(crashing.resolve({
      contactId, target: 'housingAuthority', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toThrow('simulated termination after claim');
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('active');
  }

  function guardKeys(item: SuggestionResolutionItem | undefined): string[] {
    if (item?.state !== 'active') throw new Error('expected an active journal');
    const plan = item.plan;
    if (plan.kind !== 'contact' && plan.kind !== 'status') throw new Error('expected a contact plan');
    return Object.keys(plan.guard).sort();
  }

  /** Make the stored journal look claimed before the deploy: no classification_revision in its guard. */
  async function stripRevision(contactId: string): Promise<void> {
    await doc.send(new UpdateCommand({
      TableName: extractionTable,
      Key: { itemId: resolutionItemId(contactId, 'housingAuthority') },
      UpdateExpression: 'REMOVE #plan.#guard.#revision',
      ConditionExpression: '#state = :active',
      ExpressionAttributeNames: {
        '#plan': 'plan', '#guard': 'guard', '#revision': 'classification_revision', '#state': 'state',
      },
      ExpressionAttributeValues: { ':active': 'active' },
    }));
  }

  async function expectNoAuthority(contactId: string): Promise<void> {
    const contact = await readContact(contactId);
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('completed');
  }

  it('A: an accept paused at claimed, then a conversion, answers 409 suggestion_contact_reclassified and writes no authority', async () => {
    const contactId = `reclass-a-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    // The hook IS the pause: the conversion commits between the claim and the
    // contact effect, exactly where R2-ADV-1 put it.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await conversion.make(contactId, { actor: ACTOR });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'housingAuthority', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    await expectNoAuthority(contactId);
  });

  // Plan review R1 row 8 (spec 8 "D1, real AND fake": the generic re-type and
  // the status tie also run on DynamoDB Local, not only on the FakeWorld).
  it('A: a voucherSize accept spanning a generic tenant -> landlord re-type answers 409 suggestion_contact_reclassified and writes no voucher size', async () => {
    const contactId = `reclass-v-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedTargetSuggestion(contactId, 'voucherSize', '3');
    // Not the conversion: an ordinary type change through the REAL
    // contactsRepo.update, whose UpdateExpression bumps classification_revision
    // in the same write (what the contacts PATCH calls) - the fence must see it.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await contacts.update(contactId, { type: 'landlord' });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'voucherSize', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    const contact = await readContact(contactId);
    // Seeded with no revision, so the re-type's bump made it 1.
    expect(contact).toMatchObject({ type: 'landlord', classification_revision: 1 });
    expect(contact?.['voucherSize']).toBeUndefined();
    expect(contact?.['voucherSize_source']).toBeUndefined();
    expect((await resolutions.get(contactId, 'voucherSize'))?.state).toBe('completed');
  });

  it('A: a status accept spanning a conversion answers 409 suggestion_contact_reclassified - classification wins the tie with status', async () => {
    const contactId = `reclass-st-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId); // status 'onboarding'
    const identity = await seedTargetSuggestion(contactId, 'status', 'searching');
    // The conversion changes BOTH the guarded status (to 'active') and the
    // classification, so the commit's mismatch is a tie the repository must
    // answer as a reclassification.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await conversion.make(contactId, { actor: ACTOR });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'status', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    // The conversion's own status stands; the accepted 'searching' was never written.
    expect(await readContact(contactId)).toMatchObject({ type: 'partner', role: 'Caseworker', status: 'active' });
    expect((await resolutions.get(contactId, 'status'))?.state).toBe('completed');
  });

  it('B (read): a crashed claim recovered after a conversion writes no authority (PIN)', async () => {
    const contactId = `reclass-b-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await conversion.make(contactId, { actor: ACTOR });

    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    await expectNoAuthority(contactId);
  });

  it('B (sweep): a crashed claim recovered by the daily journal sweep after a conversion writes no authority (PIN)', async () => {
    const contactId = `reclass-s-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await conversion.make(contactId, { actor: ACTOR });

    const outcome = await runJournalSweep(DAY_LATER, {
      settingsRepo: {
        claimGroupPeriod: async () => true,
        getJournalSweepCursor: async () => undefined,
        putJournalSweepCursor: async () => {},
      },
      // The table is shared by every case in this file: the sweep sees only
      // this case's journal.
      resolutionRepo: {
        async listActiveResolutionRows(opts) {
          const page = await resolutions.listActiveResolutionRows(opts);
          return { ...page, rows: page.rows.filter((row) => row.contactId === contactId) };
        },
        listJournals: (id) => resolutions.listJournals(id),
      },
      resolutionService: resolutionService(DAY_LATER),
      events,
      logger,
    }, { force: true });

    expect(outcome.recovered).toBe(1);
    await expectNoAuthority(contactId);
  });

  it('a pre-deploy journal recovered onto a converted contact ends superseded, not stale (PIN)', async () => {
    const contactId = `reclass-l-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await stripRevision(contactId);
    expect(guardKeys(await resolutions.get(contactId, 'housingAuthority')))
      .toEqual(['housingAuthority', 'housingAuthority_source']);
    await conversion.make(contactId, { actor: ACTOR });

    // `stale` would throw inside recovery (logged, recovered: 0) and leave the
    // journal active forever - the loop effectiveGuard exists to prevent.
    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    await expectNoAuthority(contactId);
  });

  it('the same pre-deploy journal recovered onto an unconverted tenant still commits (PIN)', async () => {
    const contactId = `reclass-lt-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await stripRevision(contactId);

    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    const contact = await readContact(contactId);
    expect(contact).toMatchObject({ type: 'tenant', housingAuthority: AUTHORITY });
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('completed');
  });
});
```

### Step 2 - run it RED

Start DynamoDB Local if needed: `cd "W:/tmp/caseworker-integrity"; npm run db:start`.

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/suggestionReclassification.integration.test.ts`

RED, and why:
- FakeWorld `A: an authority accept ...`, `A: a voucherSize accept ...`,
  `A: a status accept ...`, `A: an accept over a prior authority ...`:
  `expected 200 to be 409`. The repo (and fake) now answer
  `superseded_by_reclassification`, but `applyJournal` only flags
  `superseded_by_human_edit` (`suggestionResolution.ts:585`), so the journal
  completes as superseded and `resolve()` returns `completedNow: true`.
- Real `A: ...` (all three: the authority accept, the voucherSize accept
  across a generic re-type, and the status accept across a conversion):
  `promise resolved "{ completedNow: true, ... }" instead of rejecting` - same
  cause (Tasks 1.3 and 1.5 already make the real repository answer
  `superseded_by_reclassification`; only the service's answer is missing).
- The `(PIN)` cases (FakeWorld address/phone, real B read, B sweep, both
  legacy cases) pass already (Tasks 1.3 and 1.5).

### Step 3 - implement

Edit `app/src/services/suggestionResolution.ts` (signature and flag):

old_string:
```ts
  ): Promise<{ stateChanged: boolean; refusedByHumanEdit: boolean }> {
    let journal = initial;
    // Entering above `claimed` means the domain effect is already durable (a
    // previous process committed it), so carrying the journal forward is still
    // a state change the dashboard has never been told about.
    let stateChanged = initial.phase !== 'claimed';
    let refusedByHumanEdit = false;
```
new_string:
```ts
  ): Promise<{ stateChanged: boolean; refusedByHumanEdit: boolean; refusedByReclassification: boolean }> {
    let journal = initial;
    // Entering above `claimed` means the domain effect is already durable (a
    // previous process committed it), so carrying the journal forward is still
    // a state change the dashboard has never been told about.
    let stateChanged = initial.phase !== 'claimed';
    let refusedByHumanEdit = false;
    // Spec 2026-10-12 D1 change 5: the fenced write was refused because the
    // contact's classification (type or role) changed after the plan read it.
    let refusedByReclassification = false;
```

Edit the same file (record the new result):

old_string:
```ts
        if (result === 'superseded_by_human_edit') refusedByHumanEdit = true;
```
new_string:
```ts
        if (result === 'superseded_by_human_edit') refusedByHumanEdit = true;
        if (result === 'superseded_by_reclassification') refusedByReclassification = true;
```

Edit the same file with `replace_all: true` (all 7 returns inside
`applyJournal`; verify first with
`grep -c "return { stateChanged, refusedByHumanEdit };" src/services/suggestionResolution.ts` = 7):

old_string:
```ts
return { stateChanged, refusedByHumanEdit };
```
new_string:
```ts
return { stateChanged, refusedByHumanEdit, refusedByReclassification };
```

Edit the same file (the requester's answer):

old_string:
```ts
          if (applied.refusedByHumanEdit) {
            throw new SuggestionResolutionError(409, 'suggestion_field_edited');
          }
```
new_string:
```ts
          // Spec 2026-10-12 D1 change 5: the same shape for a refusal caused by
          // a reclassification (the caseworker conversion, or a type or role
          // change) after the plan read the contact. The repository decides
          // classification first, so a tie answers this code. Only THIS
          // request's own claim answers it; a helped journal keeps today's
          // answers (applyJournal's flags are ignored on the help path).
          if (applied.refusedByReclassification) {
            throw new SuggestionResolutionError(409, 'suggestion_contact_reclassified');
          }
          if (applied.refusedByHumanEdit) {
            throw new SuggestionResolutionError(409, 'suggestion_field_edited');
          }
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/suggestionReclassification.integration.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/suggestionAcceptOrgList.test.ts test/suggestionResolutionRecovery.test.ts test/journalSweep.test.ts`
All pass. `cd "W:/tmp/caseworker-integrity"; npm run typecheck` passes.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/services/suggestionResolution.ts app/test/suggestionReclassification.test.ts app/test/suggestionReclassification.integration.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): answer 409 suggestion_contact_reclassified for an accept refused by a reclassification" -m "Spec 2026-10-12 D1 change 5. The R2-ADV-1 schedules (A paused, B via read and via the sweep, and a pre-deploy journal), a voucherSize accept across a generic re-type and a status accept across a conversion now run on the FakeWorld routes and on the real repositories with the real conversion on DynamoDB Local." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.8 - The suggestions route notifies every dashboard of a reclassification refusal

Goal: spec 2 change 6, first reader. The route's `suggestion.updated` emit
(`app/src/routes/suggestions.ts:224-226`) fires for
`suggestion_contact_reclassified` exactly as for `suggestion_field_edited`;
`suggestion_contact_not_tenant` emits nothing.

Files:
- modify `app/src/routes/suggestions.ts`
- modify `app/test/suggestionReclassification.test.ts`

### Step 1 - failing tests

Append at the END of `app/test/suggestionReclassification.test.ts`:

```ts
describe('D1 change 6: the suggestions route notifies dashboards of a reclassification refusal', () => {
  it('emits suggestion.updated once for 409 suggestion_contact_reclassified - claim() consumed the chip', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed(startingOrgList());
    seedContact(world);
    await seedSuggestion(world, {
      ownerContactId: 'c1', target: 'housingAuthority', suggestedValue: 'Atlanta Housing Authority',
      conversationId: 'conv-1', runId: 'run-ha',
    });
    const paused = pausedAtClaim(world);
    const pending = accept(paused.app, 'c1', 'housingAuthority').then((res) => res);
    await paused.atClaim;
    await convert(app, 'c1').expect(200);
    // Counted AFTER the conversion, so only the accept's own answer is measured.
    const emitsBefore = suggestionEmits(world);

    paused.release();
    const res = await pending;

    expect(res.body).toEqual({ error: 'suggestion_contact_reclassified' });
    expect(await world.extractionRepo.getSuggestion('c1', 'housingAuthority')).toBeUndefined();
    expect(suggestionEmits(world)).toBe(emitsBefore + 1);
  });

  it('emits nothing for 409 suggestion_contact_not_tenant - nothing was consumed (PIN)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });
    await seedSuggestion(world, {
      ownerContactId: 'c-ll', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-ll', runId: 'run-pets',
    });
    const emitsBefore = suggestionEmits(world);

    const res = await accept(app, 'c-ll', 'pets');

    expect(res.body).toEqual({ error: 'suggestion_contact_not_tenant' });
    expect(suggestionEmits(world)).toBe(emitsBefore);
  });
});
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts`

RED: `emits suggestion.updated once ...` fails with `expected 0 to be 1`
(relative to `emitsBefore`). Why: the route's `refused` test
(`suggestions.ts:224-225`) names only `suggestion_field_edited`, so the
reclassification refusal - whose chip `claim()` already consumed - reaches no
open dashboard. The PIN passes.

### Step 3 - implement

Edit `app/src/routes/suggestions.ts`:

old_string:
```ts
      //  - `suggestion_field_edited`: the request's own accept was refused, yet
      //    claim() had already consumed the `sugg#` row and the journal was
      //    scrubbed, so every open dashboard is showing a chip that no longer
      //    exists (H1).
      const helped = (error as { helpedCommitted?: boolean } | null)?.helpedCommitted === true;
      const refused = error instanceof SuggestionResolutionError
        && error.code === 'suggestion_field_edited';
      if (helped || refused) events.emit('suggestion.updated', { contactId });
```
new_string:
```ts
      //  - `suggestion_field_edited` / `suggestion_contact_reclassified`: the
      //    request's own accept was refused (a human edit, or a type/role change
      //    after the plan read the contact - spec 2026-10-12 D1), yet claim()
      //    had already consumed the `sugg#` row and the journal was scrubbed,
      //    so every open dashboard is showing a chip that no longer exists (H1).
      //    `suggestion_contact_not_tenant` is refused BEFORE the claim,
      //    consumes nothing and emits nothing.
      const helped = (error as { helpedCommitted?: boolean } | null)?.helpedCommitted === true;
      const refused = error instanceof SuggestionResolutionError
        && (error.code === 'suggestion_field_edited' || error.code === 'suggestion_contact_reclassified');
      if (helped || refused) events.emit('suggestion.updated', { contactId });
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts`
All pass.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/routes/suggestions.ts app/test/suggestionReclassification.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(suggestions): emit suggestion.updated for a reclassification refusal" -m "Spec 2026-10-12 D1 change 6: the refused accept consumed the chip, so open dashboards must refetch; suggestion_contact_not_tenant consumes nothing and emits nothing." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.9 - Dashboard copy for the two new refusal codes

Goal: spec 2 change 6, second reader. `SUGGESTION_RESOLUTION_ERROR_COPY`
(`dashboard/src/api/types.ts:1654-1694`) gains the two exact sentences.

Files:
- modify `dashboard/src/api/types.ts`
- modify `dashboard/src/api/types.test.ts`

### Step 1 - failing tests

Edit `dashboard/src/api/types.test.ts` (the server vocabulary list):

old_string:
```ts
  // Spec D5 runs while the accept is planned: the value is not on the list.
  'org_not_on_list',
];
```
new_string:
```ts
  // Spec D5 runs while the accept is planned: the value is not on the list.
  'org_not_on_list',
  // Spec 2026-10-12 D1: the fence refused an accept that spanned a type or
  // role change (the chip is gone).
  'suggestion_contact_reclassified',
  // Spec 2026-10-12 D1: a tenant fact on a contact not typed tenant, refused
  // before anything was consumed (the chip stays).
  'suggestion_contact_not_tenant',
];
```

Edit the same file (exact sentences):

old_string:
```ts
  it('keeps the established phone-conflict sentence', () => {
    expect(suggestionResolutionErrorMessage('phone_in_use')).toBe(
      'That number already belongs to another contact.',
    );
  });
```
new_string:
```ts
  it('keeps the established phone-conflict sentence', () => {
    expect(suggestionResolutionErrorMessage('phone_in_use')).toBe(
      'That number already belongs to another contact.',
    );
  });

  it('says what happened for the two D1 refusals (spec 2026-10-12)', () => {
    expect(suggestionResolutionErrorMessage('suggestion_contact_reclassified')).toBe(
      "This contact's type or role changed after the AI suggested it, so nothing was applied.",
    );
    expect(suggestionResolutionErrorMessage('suggestion_contact_not_tenant')).toBe(
      "This contact isn't a tenant, so this can't be applied. Dismiss it instead.",
    );
  });
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/types.test.ts`

RED: `covers every code the resolution routes can return with its own sentence`
fails for `suggestion_contact_reclassified` (its copy equals the generic
fallback), and `says what happened for the two D1 refusals` fails with
`expected 'Something went wrong - please try again.' to be ...` - neither code
is in the map, so `suggestionResolutionErrorMessage` (`types.ts:1697`) falls back.

### Step 3 - implement

Edit `dashboard/src/api/types.ts`:

old_string:
```ts
  org_not_on_list:
    'That housing authority is not on the list any more, so nothing changed - pick it from the list instead.',
};
```
new_string:
```ts
  org_not_on_list:
    'That housing authority is not on the list any more, so nothing changed - pick it from the list instead.',
  // Spec 2026-10-12 D1: the accept spanned a reclassification (the caseworker
  // conversion, or a type or role change), so the fence refused it. The chip is
  // gone; nothing was written.
  suggestion_contact_reclassified:
    "This contact's type or role changed after the AI suggested it, so nothing was applied.",
  // Spec 2026-10-12 D1: a tenant fact offered for a contact not typed tenant.
  // Refused before anything was consumed - the chip stays so it can be dismissed.
  suggestion_contact_not_tenant:
    "This contact isn't a tenant, so this can't be applied. Dismiss it instead.",
};
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/types.test.ts`
All pass (including `never puts a machine token in front of staff` - neither
sentence contains `_`). Check the added lines are ASCII:
`cd "W:/tmp/caseworker-integrity"; git diff -U0 dashboard/src/api/types.ts dashboard/src/api/types.test.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/api/types.ts dashboard/src/api/types.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(dashboard): copy for the suggestion reclassified and not-a-tenant refusals" -m "Spec 2026-10-12 D1 change 6." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 1.10 - The contact page refetches suggestions on `suggestion_contact_reclassified`

Goal: spec 2 change 6, third reader. `failSuggestion`'s refetch list
(`dashboard/src/routes/contact/ContactDetail.tsx:720-725`) adds
`suggestion_contact_reclassified` (the chip is gone server-side);
`suggestion_contact_not_tenant` keeps the chip and does not refetch.

Files:
- modify `dashboard/src/routes/contact/ContactDetail.tsx`
- modify `dashboard/src/routes/contact/ContactDetail.test.tsx`

### Step 1 - failing tests

Edit `dashboard/src/routes/contact/ContactDetail.test.tsx` (the refetch table):

old_string:
```ts
    it.each([
      ['no_pending_suggestion', 404],
      ['suggestion_already_resolved', 409],
      ['suggestion_field_edited', 409],
    ])('refetches on a SERVER %s so the list really does show its real state', async (code, httpStatus) => {
```
new_string:
```ts
    it.each([
      ['no_pending_suggestion', 404],
      ['suggestion_already_resolved', 409],
      ['suggestion_field_edited', 409],
      // Spec 2026-10-12 D1: refused by the classification fence after claim()
      // consumed the row - the list has moved on exactly like a field edit.
      ['suggestion_contact_reclassified', 409],
    ])('refetches on a SERVER %s so the list really does show its real state', async (code, httpStatus) => {
```

Edit the same file (the not-a-tenant case, after the in-flight test, closing
the describe):

old_string:
```ts
      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('try again in a moment');
      expect(getSuggestions).toHaveBeenCalledTimes(1);
    });
  });
```
new_string:
```ts
      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('try again in a moment');
      expect(getSuggestions).toHaveBeenCalledTimes(1);
    });

    // Spec 2026-10-12 D1: refused BEFORE the claim, so the chip is still
    // pending server-side - it stays, says why, and offers Dismiss.
    it('keeps the chip and does NOT refetch on suggestion_contact_not_tenant (PIN)', async () => {
      acceptSuggestion.mockRejectedValue(
        new ApiError(409, 'suggestion_contact_not_tenant', 'suggestion_contact_not_tenant'),
      );
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent("This contact isn't a tenant, so this can't be applied. Dismiss it instead.");
      expect(within(chip).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
      expect(getSuggestions).toHaveBeenCalledTimes(1);
    });
  });
```

### Step 2 - run it RED

`cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx`

RED: `refetches on a SERVER suggestion_contact_reclassified ...` times out in
`waitFor(() => expect(getSuggestions).toHaveBeenCalledTimes(2))` (called 1
time) - the refetch list names only the first three codes. The `(PIN)`
not-a-tenant case passes (the "chip kept" half; its copy landed in Task 1.9).

### Step 3 - implement

Edit `dashboard/src/routes/contact/ContactDetail.tsx`:

old_string:
```ts
      // These three answer with a list that has genuinely moved on: two of them
      // PROMISE "the list now shows its real state", and a refused accept has
      // already deleted the row server-side. The server DOES emit
      // `suggestion.updated` for `suggestion_field_edited` now, and for any
      // request that helped somebody else's journal commit - the
      // `helped || refused` emit in the suggestions router's shared error path
      // (named rather than cited by line, so an edit above it cannot silently
      // repoint this reference). Neither covers a plain `no_pending_suggestion`
      // or `suggestion_already_resolved`, and no emit reaches a tab whose SSE
      // stream has dropped, so the refetch is what makes the answer true HERE.
      // The remaining codes describe a live in-flight resolution and promise
      // nothing about the list.
      if (
        err.code === 'no_pending_suggestion' ||
        err.code === 'suggestion_already_resolved' ||
        err.code === 'suggestion_field_edited'
      ) {
        suggestions.refetch();
      }
```
new_string:
```ts
      // These four answer with a list that has genuinely moved on: two of them
      // PROMISE "the list now shows its real state", and a refused accept
      // (`suggestion_field_edited`, or `suggestion_contact_reclassified` when
      // the contact's type or role changed - spec 2026-10-12 D1) has already
      // deleted the row server-side. The server DOES emit `suggestion.updated`
      // for both refused accepts now, and for any request that helped somebody
      // else's journal commit - the `helped || refused` emit in the
      // suggestions router's shared error path (named rather than cited by
      // line, so an edit above it cannot silently repoint this reference).
      // Neither covers a plain `no_pending_suggestion` or
      // `suggestion_already_resolved`, and no emit reaches a tab whose SSE
      // stream has dropped, so the refetch is what makes the answer true HERE.
      // `suggestion_contact_not_tenant` is refused BEFORE anything is consumed,
      // so its chip stays and is not refetched. The remaining codes describe a
      // live in-flight resolution and promise nothing about the list.
      if (
        err.code === 'no_pending_suggestion' ||
        err.code === 'suggestion_already_resolved' ||
        err.code === 'suggestion_field_edited' ||
        err.code === 'suggestion_contact_reclassified'
      ) {
        suggestions.refetch();
      }
```

### Step 4 - GREEN

`cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx src/api/types.test.ts`
All pass. Added lines ASCII:
`cd "W:/tmp/caseworker-integrity"; git diff -U0 dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0.

### Step 5 - commit

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(dashboard): refetch suggestions after a reclassification refusal" -m "Spec 2026-10-12 D1 change 6: the refused accept consumed the chip server-side; a not-a-tenant refusal keeps its chip and does not refetch." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice gate

DynamoDB Local must be up (`cd "W:/tmp/caseworker-integrity"; npm run db:start`).

1. New and touched suites, bare (no pipe):
   `cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/suggestionReclassification.test.ts test/suggestionReclassificationGuard.test.ts test/suggestionResolutionRepo.integration.test.ts test/suggestionReclassification.integration.test.ts`
2. Regression neighbours (suggestion protocol, sweep, conversion):
   `cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/aiRunVerdicts.test.ts test/suggestions.test.ts test/suggestionAcceptOrgList.test.ts test/suggestionResolutionRecovery.test.ts test/suggestionResolutionRepo.test.ts test/journalSweep.test.ts test/caseworkerConversion.test.ts test/caseworkerReviewApi.test.ts`
3. Dashboard:
   `cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/types.test.ts src/routes/contact/ContactDetail.test.tsx`
4. `cd "W:/tmp/caseworker-integrity"; npm run typecheck`
5. ASCII on the three new files: for each of
   `app/test/suggestionReclassification.test.ts`,
   `app/test/suggestionReclassificationGuard.test.ts`,
   `app/test/suggestionReclassification.integration.test.ts`:
   `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0.
6. Lint - AGENTS.md gate 5 scoped to S1's touched `.ts`/`.tsx` files (plan
   review R1 row 3; the procedure is "Lint at every slice gate" in section
   0), bare:
   ```
   cd "W:/tmp/caseworker-integrity"; npx eslint app/src/services/extraction/runTypes.ts app/src/services/suggestionResolution.ts app/src/repos/suggestionResolutionRepo.ts app/src/routes/suggestions.ts app/test/suggestionReclassification.test.ts app/test/suggestionReclassificationGuard.test.ts app/test/suggestionReclassification.integration.test.ts app/test/suggestionResolutionRepo.integration.test.ts app/test/helpers/suggestionResolutionFake.ts dashboard/src/api/types.ts dashboard/src/api/types.test.ts dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
   ```
   Expected: exit 0 - every one of these files that exists at the merge base
   lints clean there (planner, 2026-10-12), so ANY error is S1's and
   BLOCKING. If one is reported, confirm the attribution with the baseline
   run (section 0) on the same paths, fix it, and re-run until exit 0.

## Surfaces covered

| Spec bullet (section 2 / 8) | Task |
|---|---|
| Change 1: consistent plan read | 1.1 |
| Change 2: tenant-only ACCEPT on a non-tenant -> 409 `suggestion_contact_not_tenant` before the claim, chip kept | 1.2 |
| Change 2: dismissals never refused | 1.2 (PIN) |
| Change 2: for `status`, the type check runs before the allowlist | 1.2 (status on a landlord: 400 -> 409) |
| Change 2 / I1: neutral targets unaffected | 1.2 (lastName on a landlord), 1.3 (never fenced), 1.5 + 1.6 (neutral legacy commits), 1.7 (address + phone across a conversion) |
| Change 3: `classification_revision` in the guard of a tenant-only accept (`exists:false` / `exists:true,value`) | 1.3 |
| Change 4: `effectiveGuard(journal)` legacy fallback (`caseworker_conversion: { exists: false }`) | 1.4 |
| Change 4: used at the three real-repo sites `:798`, `:827`, `:831` | 1.5 (behavior on DynamoDB Local) + 1.6 (source pin) |
| Change 4: used by the fake (`suggestionResolutionFake.ts:322-336`) | 1.6 |
| Change 4: legacy journal on a converted contact ends superseded, not `stale` - ON THE REAL REPO | 1.5 (repo level), 1.7 (recovered via `recoverAbandoned`) |
| Change 4: legacy journal on an unconverted contact commits | 1.5, 1.6, 1.7 (PINs) |
| Change 5: result union gains `superseded_by_reclassification` (real + fake); classification wins a tie | 1.5 (real), 1.6 (fake), 1.4 (`guardMismatchIsClassification`) |
| Change 5: stored outcome + run-log verdict as for `superseded_by_human_edit` | 1.5, 1.6 (stored outcome), 1.7 (`setVerdict` with `superseded_by_human_edit`) |
| Change 5: `resolve()` answers 409 `suggestion_contact_reclassified`; helped/replayed journals keep today's answers | 1.7 |
| Change 6: route emit for `suggestion_contact_reclassified`; nothing for `suggestion_contact_not_tenant` | 1.8 (+ 1.2 asserts no emit for not_tenant) |
| Change 6: dashboard copy map (both sentences) | 1.9 |
| Change 6: dashboard refetch list adds `suggestion_contact_reclassified` | 1.10 |
| Change 7: no repair step | nothing to build (no task) |
| Spec 8 (A) schedule A: 409, no authority, emit, journal completed - FakeWorld + real | 1.7 (FakeWorld + real), 1.8 (emit) |
| Spec 8 (B) schedule B via ordinary read and via the journal sweep - FakeWorld + real | 1.3 (FakeWorld), 1.7 (real) |
| Spec 8: address and phone accepts claimed before the conversion still commit | 1.7 (FakeWorld; neutral targets - the phone commits through `commitPhoneEffect`, untouched by D1, so it stays fake-only, plan review R1 row 8) |
| Spec 8: voucherSize accept spanning a generic tenant -> landlord re-type refused as reclassified | 1.7 (schedule A, FakeWorld + real - the real case re-types through the real `contactsRepo.update`, plan review R1 row 8), 1.3 (recovery variant) |
| Spec 8: each tenant-only target on a non-tenant refused, chip survives; dismiss not refused | 1.2 |
| Spec 8: status accept and prior-authority accept spanning a conversion answer reclassified | 1.7 (FakeWorld both; real status accept, plan review R1 row 8), 1.5 + 1.6 (tie at repo level) |
| Spec 8: `effectiveGuard` is the one function the three sites and the fake call | 1.6 (source pin) + 1.5 (behavior) |
| Spec 8 D1 dashboard: both copy entries; refetch on reclassified | 1.9, 1.10 |
| Spec 5: `resolve` and both recovery paths commit through `commitContactEffect` | 1.3, 1.6, 1.7 (read path + sweep, FakeWorld and real) |


---

# SLICE S2 (assembled from the section draft)

## S2 - D2: shared holding reads, contactKind, the contacts PATCH type-change refusal, edit form + Unknown card

Spec: section 3 (D2) of `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`,
plus `contactKind` (section 4 body, used by S3). Binding interfaces: plan section 2.
Watch items owned here: W2 (the conversion byte-identical), W6 (the caseworker 409 wins).

### CONTRACT ISSUES

1. **`refusalCopyByKind(r)` cannot choose between the two landlord-of-record sentences.**
   Plan section 2 (Dashboard) keys `refusalCopyByKind(r)` by refusal KIND "plus the
   type-change landlord sentence", but the landlord-of-record kind has TWO wordings
   (the conversion's, `CaseworkerDialog.tsx:76-81`, and the type change's, spec section 3
   "Dashboard"), so a one-argument function keyed by kind cannot pick. Resolution (used by
   Tasks 2.5-2.8): `refusalCopyByKind(r)` is the conversion wording for all four kinds
   (`open_placement`, `open_tour`, `landlord_of_record`, `on_roster` - the roster kind moves
   too, writer's choice per plan); a second export `typeChangeRefusalCopy(r)` delegates to it
   for placement/tour and returns `TYPE_CHANGE_LANDLORD_SENTENCE` for landlord of record. The
   module also exports `typeChangeRefusalsFrom(err)` (the 409 body reader, the
   `CaseworkerDialog.tsx:116-121` idiom) and the wire type `TypeChangeRefusal` (no edit to
   `dashboard/src/api/types.ts`). Both dashboard sites render through ONE new component,
   `dashboard/src/routes/contact/TypeChangeRefusalList.tsx`.

2. **"OPEN_TOUR_STATUSES ... moved here; conversion imports it" would leave an unused import.**
   After `collectRefusals` (`app/src/services/caseworkerConversion.ts:217-266`) is rebuilt on
   `openTourIds`, the conversion no longer references `OPEN_TOUR_STATUSES` (only use:
   `caseworkerConversion.ts:229`), nor `TERMINAL_STAGES` (only use: :224, import :17) nor
   `unitContacts` (only use: :254, import :39). Importing any of them is a
   `@typescript-eslint/no-unused-vars` error (gate 5). Resolution: move the set to
   `contactHoldings.ts` (exported, for S3), delete the conversion's private copy (:119-120),
   and REMOVE the three imports from the conversion instead of adding one.

3. **An existing PATCH test hangs under D2 and must change its fixture.**
   `app/test/contactTriage.test.ts:740-822` ("concurrent partial edits cannot bypass
   conversion") seeds an OPEN placement for tenant `c-cw` (:748-752) only so the conversion
   refuses (`caseworker_open_placement`, :755), then sends `{ type: 'partner' }` on that
   tenant (:769) and waits for it to reach `contacts.update` (:774). Under D2 that type edit
   is refused with 409 `type_change_refused` BEFORE the write, so `arrived.type` never
   resolves and the test times out (both `first` orders). Resolution (Task 2.4 step 1): swap
   the placement for a contact-list SEAT on a unit - the conversion still refuses
   (`caseworker_on_roster`), a seat never refuses a type change (spec section 3 rule 3) - and
   expect `caseworker_on_roster`. The test's intent (a refused conversion cannot be bypassed
   by two concurrent partial edits) is unchanged. This is not one of the conversion's own test
   files (`caseworkerConversion.test.ts`, `caseworkerReviewApi.test.ts`), which stay
   byte-unchanged (W2).

4. **W3 names only S3/S4, but S2's PATCH rule can also break e2e.**
   Any e2e spec or fixture that re-types (PATCH `type`, the edit form's kind picker, or a
   Mark as button) a contact that holds an open tour, an open placement or a live unit's
   `landlordId` now gets 409 `type_change_refused`. S2 runs no e2e. Resolution: S5's e2e sweep
   must include type changes, not only tour/placement/unit/seat creation.

5. **Relative order against the organization-name 422 is unspecified.**
   Spec section 3 places the check "after the existing 409 caseworker_use_conversion check and
   before any write"; the D5 org-name 422 (`contacts.ts` "ORGANIZATION NAMES" block, right
   after the classification block) also writes nothing. Resolution: the type check sits
   immediately after the caseworker 409, inside the same `if (changesClassification)` block,
   so a body that is both a refused type change and an off-list org name answers 409
   `type_change_refused`. No test pins this order.

---

### Task 2.1 - `contactKind` in `app/src/lib/caseworkers.ts`

Goal: export `contactKind(c)`: `'caseworker'` when `isCaseworker(c)`, else `String(c.type)`.
S3 uses it for 409 `contact_not_tenant`'s `contactKind`. Leaf module rule: no new import.

Files:
- `app/src/lib/caseworkers.ts`
- `app/test/caseworkers.test.ts`

Step 1 - failing test. In `app/test/caseworkers.test.ts`, edit the import:

Before:
```ts
import {
  CASEWORKER_ROLE,
  hasAiCaseworkerNote,
```
After:
```ts
import {
  CASEWORKER_ROLE,
  contactKind,
  hasAiCaseworkerNote,
```

Append at the end of the file:
```ts
describe('contactKind (spec 2026-10-12 section 4: the kind a refusal names)', () => {
  it.each([
    [{ type: 'partner', role: 'Caseworker' }, 'caseworker'],
    [{ type: 'partner', role: 'case worker' }, 'caseworker'],
    [{ type: 'partner', role: 'Case Manager' }, 'partner'],
    [{ type: 'partner' }, 'partner'],
    [{ type: 'tenant', role: 'Caseworker' }, 'tenant'],
    [{ type: 'landlord', role: 'Property Manager' }, 'landlord'],
    [{ type: 'unknown' }, 'unknown'],
    [{ type: 'team_member', role: 'Caseworker' }, 'team_member'],
  ] as const)('%o -> %s', (contact, expected) => {
    expect(contactKind(contact)).toBe(expected);
  });
});
```

Step 2 - run RED:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/caseworkers.test.ts
```
RED: the eight new cases fail with `TypeError: contactKind is not a function` (the export does
not exist); every existing case passes.

Step 3 - implement. Append to `app/src/lib/caseworkers.ts` (after `isCaseworker`):
```ts

/**
 * The kind a refusal names (spec
 * docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 4:
 * 409 contact_not_tenant's `contactKind`): 'caseworker' when isCaseworker
 * holds, else the stored type as text. PURE, like the rest of this module.
 */
export function contactKind(c: { type?: unknown; role?: unknown }): string {
  return isCaseworker(c) ? 'caseworker' : String(c.type);
}
```

Step 4 - GREEN:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/caseworkers.test.ts
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/caseworkerRoleMirror.test.ts
```
(The mirror test imports this leaf module; it must stay green - no new import was added.)

Step 5 - commit (`git status` first, as a separate read):
```
git -C "W:/tmp/caseworker-integrity" add app/src/lib/caseworkers.ts app/test/caseworkers.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(caseworkers): contactKind names a contact's kind for refusals (caseworker, else the stored type)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.2 - `app/src/services/contactHoldings.ts`: the shared holding reads; the conversion rebuilt on them (W2)

Goal: the four holding reads extracted from `caseworkerConversion.ts` `collectRefusals`
(:217-266), each returning ids ascending by UTF-16 code unit (the conversion's `byId`
comparator, never `localeCompare`), each walking every page; the conversion's
`collectRefusals` rewritten on top with codes, order, read sequence and `deleted: 'any'`
unchanged. `caseworkerConversion.test.ts` and `caseworkerReviewApi.test.ts` are the W2 proof
and are NOT edited.

Files:
- `app/src/services/contactHoldings.ts` (NEW)
- `app/src/services/caseworkerConversion.ts`
- `app/test/contactHoldings.test.ts` (NEW)

Step 1 - baseline (must be green before any edit):
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/caseworkerConversion.test.ts test/caseworkerReviewApi.test.ts
```

Step 2 - failing test. Create `app/test/contactHoldings.test.ts`:
```ts
// The shared holding reads (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3
// "Shared reads"; plan S2): what a contact holds that a type change or the
// caseworker conversion must not orphan - its open placements and open tours
// as the tenant, the units it is the landlord of record for, and its
// contact-list seats. Extracted from caseworkerConversion.ts collectRefusals;
// the conversion's own tests (caseworkerConversion.test.ts) prove its behavior
// did not move. FakeWorld repos.
import { describe, expect, it, vi } from 'vitest';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  OPEN_TOUR_STATUSES,
  landlordUnitIds,
  openPlacementIds,
  openTourIds,
  rosterUnitIds,
  type ContactHoldingsDeps,
} from '../src/services/contactHoldings.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-hold-1';
const OTHER = 'c-hold-other';
const STAMP = '2026-10-01T00:00:00.000Z';
const DELETED = '2026-10-05T00:00:00.000Z';

function setup(): { world: FakeWorld; deps: ContactHoldingsDeps } {
  const world = createFakeWorld();
  return {
    world,
    deps: { placements: world.placementsRepo, tours: world.toursRepo, units: world.unitsRepo },
  };
}

function placement(world: FakeWorld, placementId: string, stage: string, tenantId = ID): void {
  world.placements.set(placementId, {
    placementId, tenantId, unitId: 'u-pl', stage, created_at: STAMP, updated_at: STAMP,
  } as PlacementItem);
}

function tour(world: FakeWorld, tourId: string, status: string, tenantId = ID): void {
  world.toursMap.set(tourId, {
    tourId, tenantId, unitId: 'u-tr', tourType: 'self_guided', status, createdAt: STAMP, updatedAt: STAMP,
  } as TourItem);
}

function unit(world: FakeWorld, unitId: string, over: Partial<UnitItem> = {}): void {
  world.units.set(unitId, { unitId, status: 'available', ...over } as UnitItem);
}

describe('OPEN_TOUR_STATUSES (spec I2; moved from the conversion)', () => {
  it('is requested, scheduled, toured and no_show - canceled and closed are resolved', () => {
    expect([...OPEN_TOUR_STATUSES].sort()).toEqual(['no_show', 'requested', 'scheduled', 'toured']);
  });
});

describe('openPlacementIds', () => {
  it("the contact's non-terminal placements as the tenant, ids ascending by code unit", async () => {
    const { world, deps } = setup();
    placement(world, 'pl-b', 'send_application');
    placement(world, 'pl-a', 'awaiting_inspection');
    placement(world, 'PL-c', 'schedule_inspection');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    placement(world, 'pl-other', 'send_application', OTHER);
    expect(await openPlacementIds(deps, ID)).toEqual(['PL-c', 'pl-a', 'pl-b']);
  });

  it('follows the index cursor past its first page', async () => {
    const { world, deps } = setup();
    placement(world, 'pl-1', 'send_application');
    placement(world, 'pl-2', 'send_application');
    const original = world.placementsRepo.listByTenant.bind(world.placementsRepo);
    const cursors: unknown[] = [];
    world.placementsRepo.listByTenant = async (tenantId, opts = {}) => {
      cursors.push(opts.exclusiveStartKey);
      return original(tenantId, { ...opts, limit: 1 });
    };
    expect(await openPlacementIds(deps, ID)).toEqual(['pl-1', 'pl-2']);
    expect(cursors).toEqual([undefined, { placementId: 'pl-1' }]);
  });
});

describe('openTourIds', () => {
  it("the contact's requested, scheduled, toured and no_show tours, ids ascending", async () => {
    const { world, deps } = setup();
    tour(world, 'tr-sch', 'scheduled');
    tour(world, 'tr-req', 'requested');
    tour(world, 'tr-tou', 'toured');
    tour(world, 'tr-ns', 'no_show');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    tour(world, 'tr-other', 'scheduled', OTHER);
    expect(await openTourIds(deps, ID)).toEqual(['tr-ns', 'tr-req', 'tr-sch', 'tr-tou']);
  });
});

describe('landlordUnitIds', () => {
  function landlordWorld(): { world: FakeWorld; deps: ContactHoldingsDeps } {
    const s = setup();
    unit(s.world, 'u-live-b', { landlordId: ID });
    unit(s.world, 'u-live-a', { landlordId: ID });
    unit(s.world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    unit(s.world, 'u-other', { landlordId: OTHER });
    return s;
  }

  it("deleted: false - the LIVE units the contact is the landlord of record for (the type change's rule)", async () => {
    const { deps } = landlordWorld();
    expect(await landlordUnitIds(deps, ID, { deleted: false })).toEqual(['u-live-a', 'u-live-b']);
  });

  it("deleted: 'any' - live and soft-deleted units (the conversion's rule, D22)", async () => {
    const { deps } = landlordWorld();
    expect(await landlordUnitIds(deps, ID, { deleted: 'any' })).toEqual(['u-gone', 'u-live-a', 'u-live-b']);
  });

  it('passes the scope on every page and follows the cursor', async () => {
    const { world, deps } = landlordWorld();
    const original = world.unitsRepo.listByLandlord.bind(world.unitsRepo);
    const seen: Array<{ deleted: unknown; cursor: unknown }> = [];
    world.unitsRepo.listByLandlord = async (landlordId, opts = {}) => {
      seen.push({ deleted: opts.deleted, cursor: opts.exclusiveStartKey });
      return original(landlordId, { ...opts, limit: 1 });
    };
    expect(await landlordUnitIds(deps, ID, { deleted: false })).toEqual(['u-live-a', 'u-live-b']);
    expect(seen).toEqual([
      { deleted: false, cursor: undefined },
      { deleted: false, cursor: { unitId: 'u-live-b' } },
    ]);
  });
});

describe('rosterUnitIds', () => {
  it('every unit, live or deleted, whose contact list seats the contact, minus the excluded ids', async () => {
    const { world, deps } = setup();
    unit(world, 'u-seat-live', {
      landlordId: OTHER,
      contacts: [
        { contactId: OTHER, role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    unit(world, 'u-seat-gone', {
      landlordId: OTHER,
      contacts: [{ contactId: ID, role: 'other', primaryContact: true }],
      deleted_at: DELETED,
    });
    // A landlord of record with no contacts[] still has a derived landlord row (unitContacts).
    unit(world, 'u-owned', { landlordId: ID });
    unit(world, 'u-none', { landlordId: OTHER });
    expect(await rosterUnitIds(deps, ID, new Set())).toEqual(['u-owned', 'u-seat-gone', 'u-seat-live']);
    expect(await rosterUnitIds(deps, ID, new Set(['u-owned']))).toEqual(['u-seat-gone', 'u-seat-live']);
  });

  it("scans with deleted: 'any' and follows the scan cursor", async () => {
    const { world, deps } = setup();
    for (let i = 0; i < 3; i += 1) unit(world, 'scan-' + String(i));
    unit(world, 'scan-last', {
      deleted_at: DELETED,
      contacts: [{ contactId: ID, role: 'other', primaryContact: false }],
    });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    const scan = vi.spyOn(world.unitsRepo, 'list').mockImplementation((options) => realList({ ...options, limit: 2 }));
    expect(await rosterUnitIds(deps, ID, new Set())).toEqual(['scan-last']);
    expect(scan).toHaveBeenCalledTimes(2);
    for (const [options] of scan.mock.calls) expect(options).toMatchObject({ deleted: 'any' });
  });
});
```

Step 3 - run RED:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactHoldings.test.ts
```
RED: the file fails to load - `Failed to load url ../src/services/contactHoldings.js` (the module
does not exist), so every case fails.

Step 4 - implement. Create `app/src/services/contactHoldings.ts`:
```ts
// What a contact HOLDS that a change of its kind must not orphan (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3
// "Shared reads"; extracted from caseworkerConversion.ts collectRefusals):
// its open placements and open tours as the tenant (I2), the units it is the
// landlord of record for (I3) and its contact-list seats (I4). Each reader
// walks every page of its index or scan and returns ids ascending by UTF-16
// code unit (never localeCompare - the conversion's order, W2). Two callers:
// the caseworker conversion (all four kinds, soft-deleted units included,
// codes caseworker_*) and the contacts PATCH type change (typeChangeRefusals:
// only the kinds its rule needs, LIVE units only, never the roster Scan).
// Reads only. The index reads are never strongly consistent, so a caller's
// check is not atomic with its write (spec L1).
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import type { PlacementsRepo } from '../repos/placementsRepo.js';
import type { ToursRepo } from '../repos/toursRepo.js';
import { unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';

/** I2 (D19): requested, scheduled, toured or no_show; canceled and closed are resolved. */
export const OPEN_TOUR_STATUSES: ReadonlySet<string> = new Set(['requested', 'scheduled', 'toured', 'no_show']);

/**
 * The repos the readers query. Callers pass the repo objects themselves, and
 * every read looks its method up at call time, so a test that swaps a repo
 * method after setup still reaches it.
 */
export interface ContactHoldingsDeps {
  placements: Pick<PlacementsRepo, 'listByTenant'>;
  tours: Pick<ToursRepo, 'listByTenant'>;
  units: Pick<UnitsRepo, 'listByLandlord' | 'list'>;
}

/** One entry of the contacts PATCH's 409 type_change_refused (spec D2). */
export type TypeChangeRefusal =
  | { code: 'open_placement'; placementId: string }
  | { code: 'open_tour'; tourId: string }
  | { code: 'landlord_of_record'; unitId: string };

/** Ascending by UTF-16 code unit - the conversion's order. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The contact's placements as the tenant whose stage is not terminal (moved_in, lost). */
export async function openPlacementIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]> {
  const ids: string[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.placements.listByTenant(contactId, {
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const p of page.items) if (!TERMINAL_STAGES.has(p.stage)) ids.push(p.placementId);
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return ids.sort(byId);
}

/** The contact's tours as the tenant whose status is open (OPEN_TOUR_STATUSES). */
export async function openTourIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]> {
  return (await deps.tours.listByTenant(contactId))
    .filter((t) => OPEN_TOUR_STATUSES.has(t.status))
    .map((t) => t.tourId)
    .sort(byId);
}

/**
 * The units whose landlordId is the contact: LIVE units only (deleted: false,
 * the type change - a soft-deleted unit is fenced at restore instead), or
 * live and soft-deleted (deleted: 'any', the conversion, D22).
 */
export async function landlordUnitIds(
  deps: ContactHoldingsDeps,
  contactId: string,
  opts: { deleted: false | 'any' },
): Promise<string[]> {
  const ids = new Set<string>();
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.listByLandlord(contactId, {
      deleted: opts.deleted,
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const u of page.items) ids.add(u.unitId);
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return [...ids].sort(byId);
}

/**
 * The units, live and soft-deleted, whose contact list (unitContacts - a
 * landlordId with no contacts[] derives a landlord row) seats the contact,
 * minus `exclude`. ONE Scan of every unit: there is no roster index (the
 * conversion accepts the cost at today's unit count; filed in the 2026-10-06
 * design section 12). The type change never calls this.
 */
export async function rosterUnitIds(
  deps: ContactHoldingsDeps,
  contactId: string,
  exclude: ReadonlySet<string>,
): Promise<string[]> {
  const ids: string[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.list({
      deleted: 'any',
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const u of page.items) {
      if (exclude.has(u.unitId)) continue;
      if (unitContacts(u).some((seat) => seat.contactId === contactId)) ids.push(u.unitId);
    }
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return ids.sort(byId);
}
```

Edit `app/src/services/caseworkerConversion.ts`:

(a) Remove the now-unused statusModel import. Before:
```ts
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
```
After:
```ts
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
```

(b) Drop `unitContacts` and import the readers. Before:
```ts
import { createUnitsRepo, unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { displayNameOf, drainTypeSuggestion, supersedePendingSuggestion, type SuggestionEffectDeps } from './contactClassification.js';
```
After:
```ts
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  landlordUnitIds,
  openPlacementIds,
  openTourIds,
  rosterUnitIds,
  type ContactHoldingsDeps,
} from './contactHoldings.js';
import { displayNameOf, drainTypeSuggestion, supersedePendingSuggestion, type SuggestionEffectDeps } from './contactClassification.js';
```

(c) Delete the private set (it moved to contactHoldings.ts). Before:
```ts
/** D19: requested, scheduled, toured or no_show; canceled and closed are resolved. */
const OPEN_TOUR_STATUSES: ReadonlySet<string> = new Set(['requested', 'scheduled', 'toured', 'no_show']);

/** The one-to-one types the conversion re-types (partner_1to1 is already done; groups never). */
```
After:
```ts
/** The one-to-one types the conversion re-types (partner_1to1 is already done; groups never). */
```

(d) Build the deps once. Before:
```ts
  const now = deps.now ?? (() => new Date());

  /**
   * Rule 1: a CONSISTENT read.
```
After:
```ts
  const now = deps.now ?? (() => new Date());
  // Rule 3's reads live in services/contactHoldings.ts, shared with the
  // contacts PATCH type-change refusal (spec 2026-10-12 D2). The repo objects
  // themselves, so a test that swaps a repo method still reaches it.
  const holdings: ContactHoldingsDeps = { placements, tours, units };

  /**
   * Rule 1: a CONSISTENT read.
```

(e) Replace the body of `collectRefusals` (keep its docblock above it unchanged). Before
(`caseworkerConversion.ts:217-266`, the whole function):
```ts
  async function collectRefusals(contactId: string): Promise<CaseworkerRefusal[]> {
    const placementIds: string[] = [];
    let placementKey: Record<string, unknown> | undefined;
    do {
      const page = await placements.listByTenant(contactId, {
        ...(placementKey !== undefined && { exclusiveStartKey: placementKey }),
      });
      for (const p of page.items) if (!TERMINAL_STAGES.has(p.stage)) placementIds.push(p.placementId);
      placementKey = page.lastEvaluatedKey;
    } while (placementKey !== undefined);

    const tourIds = (await tours.listByTenant(contactId))
      .filter((t) => OPEN_TOUR_STATUSES.has(t.status))
      .map((t) => t.tourId);

    const landlordUnitIds = new Set<string>();
    let landlordKey: Record<string, unknown> | undefined;
    do {
      const page = await units.listByLandlord(contactId, {
        deleted: 'any',
        ...(landlordKey !== undefined && { exclusiveStartKey: landlordKey }),
      });
      for (const u of page.items) landlordUnitIds.add(u.unitId);
      landlordKey = page.lastEvaluatedKey;
    } while (landlordKey !== undefined);

    // One Scan of every unit, live and deleted (no roster index; D19 accepts
    // the cost at today's unit count, filed in section 12).
    const rosterUnitIds: string[] = [];
    let scanKey: Record<string, unknown> | undefined;
    do {
      const page = await units.list({
        deleted: 'any',
        ...(scanKey !== undefined && { exclusiveStartKey: scanKey }),
      });
      for (const u of page.items) {
        if (landlordUnitIds.has(u.unitId)) continue;
        if (unitContacts(u).some((seat) => seat.contactId === contactId)) rosterUnitIds.push(u.unitId);
      }
      scanKey = page.lastEvaluatedKey;
    } while (scanKey !== undefined);

    const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return [
      ...placementIds.sort(byId).map((placementId) => ({ code: 'caseworker_open_placement' as const, placementId })),
      ...tourIds.sort(byId).map((tourId) => ({ code: 'caseworker_open_tour' as const, tourId })),
      ...[...landlordUnitIds].sort(byId).map((unitId) => ({ code: 'caseworker_landlord_of_record' as const, unitId })),
      ...rosterUnitIds.sort(byId).map((unitId) => ({ code: 'caseworker_on_roster' as const, unitId })),
    ];
  }
```
After:
```ts
  async function collectRefusals(contactId: string): Promise<CaseworkerRefusal[]> {
    // The same four reads in the same order as before the extraction, each
    // id-sorted by the same comparator (W2).
    const placementIds = await openPlacementIds(holdings, contactId);
    const tourIds = await openTourIds(holdings, contactId);
    const landlordIds = await landlordUnitIds(holdings, contactId, { deleted: 'any' });
    // One Scan of every unit, live and deleted (no roster index; D19 accepts
    // the cost at today's unit count, filed in section 12).
    const rosterIds = await rosterUnitIds(holdings, contactId, new Set(landlordIds));
    return [
      ...placementIds.map((placementId) => ({ code: 'caseworker_open_placement' as const, placementId })),
      ...tourIds.map((tourId) => ({ code: 'caseworker_open_tour' as const, tourId })),
      ...landlordIds.map((unitId) => ({ code: 'caseworker_landlord_of_record' as const, unitId })),
      ...rosterIds.map((unitId) => ({ code: 'caseworker_on_roster' as const, unitId })),
    ];
  }
```

Step 5 - GREEN:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactHoldings.test.ts
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/caseworkerConversion.test.ts test/caseworkerReviewApi.test.ts test/contactTriage.test.ts
cd "W:/tmp/caseworker-integrity/app"; npx tsc -p tsconfig.test.json
git -C "W:/tmp/caseworker-integrity" diff --exit-code 19607658 -- app/test/caseworkerConversion.test.ts app/test/caseworkerReviewApi.test.ts
cd "W:/tmp/caseworker-integrity"; npx eslint app/src/services/contactHoldings.ts app/src/services/caseworkerConversion.ts app/test/contactHoldings.test.ts
```
The conversion suites are green with NO edit (the diff prints nothing and exits 0): W2. If
any conversion case changes, STOP - the extraction moved behavior. ASCII check of the new
files: `tr -d '\11\12\15\40-\176' < app/src/services/contactHoldings.ts | wc -c` and the same
for `app/test/contactHoldings.test.ts` print 0.

Step 6 - commit:
```
git -C "W:/tmp/caseworker-integrity" add app/src/services/contactHoldings.ts app/src/services/caseworkerConversion.ts app/test/contactHoldings.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "refactor(caseworkers): extract the conversion's holding reads into services/contactHoldings.ts (conversion unchanged)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.3 - `typeChangeRefusals`: the kinds the type-change rule needs

Goal: `typeChangeRefusals(deps, contactId, toType)`: resulting type not `tenant` -> open
placements then open tours; resulting type not `landlord` -> LIVE landlord units; order kind
(placement, tour, landlord) then id ascending; never the roster Scan; reads only the kinds
the target needs.

Files:
- `app/src/services/contactHoldings.ts`
- `app/test/contactHoldings.test.ts`

Step 1 - failing test. In `app/test/contactHoldings.test.ts` edit the import:

Before:
```ts
  rosterUnitIds,
  type ContactHoldingsDeps,
} from '../src/services/contactHoldings.js';
```
After:
```ts
  rosterUnitIds,
  typeChangeRefusals,
  type ContactHoldingsDeps,
} from '../src/services/contactHoldings.js';
```

Append at the end of the file:
```ts
describe('typeChangeRefusals (spec 2026-10-12 D2)', () => {
  function holdingEverything(): { world: FakeWorld; deps: ContactHoldingsDeps } {
    const s = setup();
    placement(s.world, 'pl-b', 'send_application');
    placement(s.world, 'pl-a', 'send_application');
    placement(s.world, 'pl-done', 'moved_in');
    tour(s.world, 'tr-b', 'scheduled');
    tour(s.world, 'tr-a', 'requested');
    tour(s.world, 'tr-done', 'canceled');
    unit(s.world, 'u-b', { landlordId: ID });
    unit(s.world, 'u-a', { landlordId: ID });
    unit(s.world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    unit(s.world, 'u-seat', {
      landlordId: OTHER,
      contacts: [
        { contactId: OTHER, role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    return s;
  }

  const PLACEMENTS_AND_TOURS = [
    { code: 'open_placement', placementId: 'pl-a' },
    { code: 'open_placement', placementId: 'pl-b' },
    { code: 'open_tour', tourId: 'tr-a' },
    { code: 'open_tour', tourId: 'tr-b' },
  ];
  const LANDLORD = [
    { code: 'landlord_of_record', unitId: 'u-a' },
    { code: 'landlord_of_record', unitId: 'u-b' },
  ];

  it.each(['partner', 'unknown', 'team_member'])(
    'to %s: every kind - placements, then tours, then live units, ids ascending',
    async (toType) => {
      const { deps } = holdingEverything();
      expect(await typeChangeRefusals(deps, ID, toType)).toEqual([...PLACEMENTS_AND_TOURS, ...LANDLORD]);
    },
  );

  it('to tenant: only the landlord kind (a tenant may hold open placements and tours)', async () => {
    const { deps } = holdingEverything();
    expect(await typeChangeRefusals(deps, ID, 'tenant')).toEqual(LANDLORD);
  });

  it('to landlord: only the placement and tour kinds (a landlord may be a landlord of record)', async () => {
    const { deps } = holdingEverything();
    expect(await typeChangeRefusals(deps, ID, 'landlord')).toEqual(PLACEMENTS_AND_TOURS);
  });

  it('a soft-deleted unit and a contact-list seat never refuse', async () => {
    const { world, deps } = setup();
    unit(world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    unit(world, 'u-seat', {
      landlordId: OTHER,
      contacts: [
        { contactId: OTHER, role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    expect(await typeChangeRefusals(deps, ID, 'partner')).toEqual([]);
  });

  it('reads only the kinds the target needs, live units only, never the roster Scan', async () => {
    const { world, deps } = setup();
    const placementsRead = vi.spyOn(world.placementsRepo, 'listByTenant');
    const toursRead = vi.spyOn(world.toursRepo, 'listByTenant');
    const landlordRead = vi.spyOn(world.unitsRepo, 'listByLandlord');
    const scan = vi.spyOn(world.unitsRepo, 'list');

    await typeChangeRefusals(deps, ID, 'tenant');
    expect(placementsRead).not.toHaveBeenCalled();
    expect(toursRead).not.toHaveBeenCalled();
    expect(landlordRead).toHaveBeenCalledWith(ID, { deleted: false });

    landlordRead.mockClear();
    await typeChangeRefusals(deps, ID, 'landlord');
    expect(placementsRead).toHaveBeenCalledWith(ID, {});
    expect(toursRead).toHaveBeenCalledWith(ID);
    expect(landlordRead).not.toHaveBeenCalled();

    expect(scan).not.toHaveBeenCalled();
  });
});
```

Step 2 - run RED:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactHoldings.test.ts
```
RED: the seven new cases fail with `TypeError: typeChangeRefusals is not a function` (not
exported yet); the Task 2.2 cases stay green.

Step 3 - implement. Append to `app/src/services/contactHoldings.ts`:
```ts

/**
 * The contacts PATCH type-change refusal (spec 2026-10-12 D2), for a PATCH
 * whose resulting type `toType` differs from the stored type. A result that is
 * not `tenant` is refused by every open placement and open tour (I2); a result
 * that is not `landlord` by every LIVE unit the contact is the landlord of
 * record for (I3). Soft-deleted units are fenced at restore instead, and
 * contact-list seats never refuse, so the roster Scan is never run. Ordered by
 * kind (placement, tour, landlord), then id ascending.
 */
export async function typeChangeRefusals(
  deps: ContactHoldingsDeps,
  contactId: string,
  toType: string,
): Promise<TypeChangeRefusal[]> {
  const refusals: TypeChangeRefusal[] = [];
  if (toType !== 'tenant') {
    for (const placementId of await openPlacementIds(deps, contactId)) {
      refusals.push({ code: 'open_placement', placementId });
    }
    for (const tourId of await openTourIds(deps, contactId)) {
      refusals.push({ code: 'open_tour', tourId });
    }
  }
  if (toType !== 'landlord') {
    for (const unitId of await landlordUnitIds(deps, contactId, { deleted: false })) {
      refusals.push({ code: 'landlord_of_record', unitId });
    }
  }
  return refusals;
}
```

Step 4 - GREEN:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactHoldings.test.ts
cd "W:/tmp/caseworker-integrity/app"; npx tsc -p tsconfig.test.json
```

Step 5 - commit:
```
git -C "W:/tmp/caseworker-integrity" add app/src/services/contactHoldings.ts app/test/contactHoldings.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(contacts): typeChangeRefusals reads the open placements, open tours and live landlord units a type change would orphan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.4 - the contacts PATCH answers 409 `type_change_refused`

Goal: in `PATCH /api/contacts/:contactId`, when the body's `type` differs from the stored
type, after the 409 `caseworker_use_conversion` check and before any write, answer 409
`{ error: 'type_change_refused', refusals }` when `typeChangeRefusals` is non-empty. Role-only
changes and a re-sent stored type are not checked. Fix the one existing test the rule breaks
(CONTRACT ISSUE 3) first.

Files:
- `app/test/contactTriage.test.ts` (fixture swap only)
- `app/test/contactTypeChangeRefusals.test.ts` (NEW)
- `app/src/routes/contacts.ts`

Step 1 - pre-adjust the existing concurrency test (stays GREEN on unchanged code). In
`app/test/contactTriage.test.ts`:

Before:
```ts
        world.placements.set('p-cw-race', {
          placementId: 'p-cw-race', tenantId: 'c-cw', unitId: 'u-cw-race',
          stage: 'send_application', created_at: '2026-10-08T10:00:00.000Z',
          updated_at: '2026-10-08T10:00:00.000Z',
        });
        const conversion = await request(app).post('/api/contacts/c-cw/caseworker-review')
          .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE).send({ action: 'make' });
        expect(conversion.status).toBe(409);
        expect(conversion.body.error).toBe('caseworker_open_placement');
```
After:
```ts
        // A contact-list seat: the conversion refuses it (caseworker_on_roster)
        // while a generic type change never does (spec 2026-10-12 D2). An open
        // placement here would refuse the type edit before its write.
        world.units.set('u-cw-race', {
          unitId: 'u-cw-race', status: 'available', landlordId: 'c-cw-owner',
          contacts: [
            { contactId: 'c-cw-owner', role: 'landlord', primaryContact: true },
            { contactId: 'c-cw', role: 'other', primaryContact: false },
          ],
        });
        const conversion = await request(app).post('/api/contacts/c-cw/caseworker-review')
          .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE).send({ action: 'make' });
        expect(conversion.status).toBe(409);
        expect(conversion.body.error).toBe('caseworker_on_roster');
```
Run (must be green on unchanged route code):
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTriage.test.ts
```

Step 2 - failing test. Create `app/test/contactTypeChangeRefusals.test.ts`:
```ts
// The contacts PATCH type-change refusal (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2; plan S2). A PATCH whose `type` differs from the stored type answers 409
// { error: 'type_change_refused', refusals } while the contact is the tenant
// of an open placement or open tour and the result is not `tenant` (I2), or
// the landlord of record of a LIVE unit and the result is not `landlord` (I3).
// Soft-deleted units and contact-list seats never refuse, a role-only change
// is not checked, the caseworker 409 still wins (W6), and a refusal writes
// nothing. FakeWorld routes.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-tc-1';
const OTHER = 'c-tc-other';
const STAMP = '2026-10-01T00:00:00.000Z';
const DELETED = '2026-10-05T00:00:00.000Z';

const TYPES: ContactType[] = ['tenant', 'landlord', 'partner', 'unknown', 'team_member'];
/** Every (stored type, requested type) pair that is a type change. */
const PAIRS: Array<[ContactType, ContactType]> = TYPES.flatMap((from) =>
  TYPES.filter((to) => to !== from).map((to): [ContactType, ContactType] => [from, to]),
);

/** A status valid for each stored type. */
const SEED_STATUS: Record<ContactType, string> = {
  tenant: 'onboarding',
  landlord: 'interested',
  partner: 'active',
  unknown: 'needs_review',
  team_member: 'active',
};

function seed(world: FakeWorld, type: ContactType, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: ID,
    type,
    status: SEED_STATUS[type],
    phone: '+15550107601',
    firstName: 'Ana',
    lastName: 'Ruiz',
    created_at: STAMP,
    ...over,
  } as ContactItem);
}

function placement(world: FakeWorld, placementId: string, stage: string, tenantId = ID): void {
  world.placements.set(placementId, {
    placementId, tenantId, unitId: 'u-pl', stage, created_at: STAMP, updated_at: STAMP,
  } as PlacementItem);
}

function tour(world: FakeWorld, tourId: string, status: string, tenantId = ID): void {
  world.toursMap.set(tourId, {
    tourId, tenantId, unitId: 'u-tr', tourType: 'self_guided', status, createdAt: STAMP, updatedAt: STAMP,
  } as TourItem);
}

function unit(world: FakeWorld, unitId: string, over: Partial<UnitItem> = {}): void {
  world.units.set(unitId, { unitId, status: 'available', ...over } as UnitItem);
}

/** A seat on another landlord's unit - never a landlord of record. */
function seat(world: FakeWorld, unitId: string): void {
  unit(world, unitId, {
    landlordId: OTHER,
    contacts: [
      { contactId: OTHER, role: 'landlord', primaryContact: true },
      { contactId: ID, role: 'pm', primaryContact: false },
    ],
  });
}

function send(app: import('express').Express, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${ID}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function stored(world: FakeWorld): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === ID);
}

describe('the refusal matrix: every stored type to every other type', () => {
  for (const [from, to] of PAIRS) {
    it(`${from} -> ${to} holding an open placement, an open tour and a live unit: 409 naming what the result breaks; nothing written`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      placement(world, 'pl-open', 'send_application');
      tour(world, 'tr-open', 'scheduled');
      unit(world, 'u-live', { landlordId: ID });
      const before = structuredClone(stored(world));
      const update = vi.spyOn(world.contactsRepo, 'update');
      const res = await send(app, { type: to });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'type_change_refused',
        refusals: [
          ...(to !== 'tenant'
            ? [
                { code: 'open_placement', placementId: 'pl-open' },
                { code: 'open_tour', tourId: 'tr-open' },
              ]
            : []),
          ...(to !== 'landlord' ? [{ code: 'landlord_of_record', unitId: 'u-live' }] : []),
        ],
      });
      expect(update).not.toHaveBeenCalled();
      expect(stored(world)).toEqual(before);
      expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toEqual([]);
      expect(world.emitted).toEqual([]);
    });
  }

  for (const [from] of PAIRS.filter(([, to]) => to === 'tenant')) {
    it(`(PIN) ${from} -> tenant holding an open placement and an open tour: allowed (I2 wants a tenant)`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      placement(world, 'pl-open', 'send_application');
      tour(world, 'tr-open', 'scheduled');
      const res = await send(app, { type: 'tenant' });
      expect(res.status).toBe(200);
      expect(stored(world)?.type).toBe('tenant');
    });
  }

  for (const [from] of PAIRS.filter(([, to]) => to === 'landlord')) {
    it(`(PIN) ${from} -> landlord as the landlord of record of a live unit: allowed (I3 wants a landlord)`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      unit(world, 'u-live', { landlordId: ID });
      const res = await send(app, { type: 'landlord' });
      expect(res.status).toBe(200);
      expect(stored(world)?.type).toBe('landlord');
    });
  }
});

describe('what counts as a holding', () => {
  it('(PIN) terminal placements and resolved tours never refuse', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it("(PIN) another contact's placements, tours and units never refuse", async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-x', 'send_application', OTHER);
    tour(world, 'tr-x', 'scheduled', OTHER);
    unit(world, 'u-x', { landlordId: OTHER });
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it('a soft-deleted unit does not count: only the live unit is named', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'landlord');
    unit(world, 'u-live', { landlordId: ID });
    unit(world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'type_change_refused',
      refusals: [{ code: 'landlord_of_record', unitId: 'u-live' }],
    });
  });

  it('(PIN) the landlord of record of only a soft-deleted unit may change type (restore fences it, spec section 4)', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'landlord');
    unit(world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(200);
    expect(stored(world)?.type).toBe('partner');
  });

  it('(PIN) a contact-list seat never refuses a type change', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    seat(world, 'u-seat');
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it('names placements, then tours, then units, each id ascending', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'unknown');
    placement(world, 'pl-b', 'send_application');
    placement(world, 'pl-a', 'awaiting_inspection');
    tour(world, 'tr-b', 'scheduled');
    tour(world, 'tr-a', 'requested');
    unit(world, 'u-b', { landlordId: ID });
    unit(world, 'u-a', { landlordId: ID });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(409);
    expect(res.body.refusals).toEqual([
      { code: 'open_placement', placementId: 'pl-a' },
      { code: 'open_placement', placementId: 'pl-b' },
      { code: 'open_tour', tourId: 'tr-a' },
      { code: 'open_tour', tourId: 'tr-b' },
      { code: 'landlord_of_record', unitId: 'u-a' },
      { code: 'landlord_of_record', unitId: 'u-b' },
    ]);
  });
});

describe('what is not checked', () => {
  it('(PIN) a role-only change is not checked', async () => {
    const tenant = makeWebhookHarness();
    seed(tenant.world, 'tenant');
    placement(tenant.world, 'pl-open', 'send_application');
    expect((await send(tenant.app, { role: 'Inspector' })).status).toBe(200);

    const landlord = makeWebhookHarness();
    seed(landlord.world, 'landlord');
    unit(landlord.world, 'u-live', { landlordId: ID });
    expect((await send(landlord.app, { role: 'Property Manager' })).status).toBe(200);
  });

  it('(PIN) the stored type re-sent is not a type change', async () => {
    const tenant = makeWebhookHarness();
    seed(tenant.world, 'tenant');
    placement(tenant.world, 'pl-open', 'send_application');
    expect((await send(tenant.app, { type: 'tenant', firstName: 'Pat' })).status).toBe(200);

    const landlord = makeWebhookHarness();
    seed(landlord.world, 'landlord');
    unit(landlord.world, 'u-live', { landlordId: ID });
    expect((await send(landlord.app, { type: 'landlord', role: 'Property Manager' })).status).toBe(200);
  });

  it('(PIN) the caseworker 409 still wins over the type-change refusal (W6)', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-open', 'send_application');
    const res = await send(app, { type: 'partner', role: 'Caseworker' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'caseworker_use_conversion' });
  });
});

describe('the reads', () => {
  it('reads live landlord units only and never runs the roster Scan', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'partner');
    seat(world, 'u-seat');
    const landlordRead = vi.spyOn(world.unitsRepo, 'listByLandlord');
    const scan = vi.spyOn(world.unitsRepo, 'list');
    expect((await send(app, { type: 'unknown' })).status).toBe(200);
    expect(landlordRead).toHaveBeenCalledWith(ID, { deleted: false });
    expect(scan).not.toHaveBeenCalled();
  });
});
```

Step 3 - run RED:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTypeChangeRefusals.test.ts
```
RED: every matrix refusal case (20), "a soft-deleted unit does not count", "names placements,
then tours..." and "the reads" fail - the PATCH never checks holdings, so it answers 200
(`expected 200 to be 409`) and never calls `listByLandlord`. Every (PIN) case passes.

Step 4 - implement in `app/src/routes/contacts.ts`.

(a) Import. Before:
```ts
import {
  createCaseworkerConversionService,
  type CaseworkerConversionService,
} from '../services/caseworkerConversion.js';
```
After:
```ts
import {
  createCaseworkerConversionService,
  type CaseworkerConversionService,
} from '../services/caseworkerConversion.js';
import { typeChangeRefusals } from '../services/contactHoldings.js';
```

(b) The check, right after the caseworker 409 inside the `if (changesClassification)` block.
Before:
```ts
      if (isCaseworker({ type: resultType, role: resultRole }) && !isCaseworker(stored)) {
        log.info({ contactId }, 'contact patch refused: a caseworker is made through the conversion');
        res.status(409).json({ error: 'caseworker_use_conversion' });
        return;
      }
```
After:
```ts
      if (isCaseworker({ type: resultType, role: resultRole }) && !isCaseworker(stored)) {
        log.info({ contactId }, 'contact patch refused: a caseworker is made through the conversion');
        res.status(409).json({ error: 'caseworker_use_conversion' });
        return;
      }
      // CASEWORKER INTEGRITY (spec 2026-10-12 D2): a TYPE change must not
      // leave an open placement or open tour on a non-tenant (I2), or a LIVE
      // unit's landlord of record on a non-landlord (I3). Soft-deleted units
      // do not count (restore fences them), contact-list seats never refuse,
      // and a role-only change is not checked. After the caseworker 409 (W6)
      // and before any write; index reads, so not atomic with the write (L1).
      if ('type' in parsed.patch && newType !== stored.type) {
        const refusals = await typeChangeRefusals({ placements, tours, units }, contactId, String(newType));
        if (refusals.length > 0) {
          log.info(
            { contactId, fromType: stored.type, toType: newType, refusals: refusals.length },
            'contact patch refused: the type change would orphan open records',
          );
          res.status(409).json({ error: 'type_change_refused', refusals });
          return;
        }
      }
```
(`newType` is the handler's existing `const newType = parsed.patch['type'];`; `placements`,
`tours` and `units` are the router's existing repos.)

Step 5 - GREEN:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTypeChangeRefusals.test.ts test/contactTriage.test.ts test/caseworkerConversion.test.ts test/caseworkerReviewApi.test.ts
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/aiRunVerdicts.test.ts test/contactEmailReaders.test.ts test/suggestions.test.ts test/contactStaffNotes.test.ts
cd "W:/tmp/caseworker-integrity/app"; npx tsc -p tsconfig.test.json
cd "W:/tmp/caseworker-integrity"; npx eslint app/src/routes/contacts.ts app/test/contactTypeChangeRefusals.test.ts app/test/contactTriage.test.ts
```
(The second line runs the other suites that PATCH a contact's `type`; none seeds a holding, so
they stay green.) ASCII check: `tr -d '\11\12\15\40-\176' < app/test/contactTypeChangeRefusals.test.ts | wc -c`
prints 0; added lines of `git diff -- app/src/routes/contacts.ts app/test/contactTriage.test.ts`
are ASCII.

Step 6 - commit:
```
git -C "W:/tmp/caseworker-integrity" add app/src/routes/contacts.ts app/test/contactTypeChangeRefusals.test.ts app/test/contactTriage.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(contacts): a type change refuses 409 type_change_refused while the contact holds an open placement, open tour or live unit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.5 - `dashboard/src/lib/holdingRefusals.ts`; CaseworkerDialog's `refusalCopy` delegates to it

Goal: the refusal sentences move out of `CaseworkerDialog.tsx` (:61-89) into a shared module
keyed by KIND; the dialog maps its `caseworker_*` codes onto the kinds with byte-identical
output; the module adds the type change's own landlord sentence and the 409
`type_change_refused` body reader (CONTRACT ISSUE 1).

Files:
- `dashboard/src/lib/holdingRefusals.ts` (NEW)
- `dashboard/src/lib/holdingRefusals.test.ts` (NEW)
- `dashboard/src/routes/contact/CaseworkerDialog.tsx`

Step 1 - baseline (green before any edit; this file is NOT edited in this task):
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/CaseworkerDialog.test.tsx
```

Step 2 - failing test. Create `dashboard/src/lib/holdingRefusals.test.ts`:
```ts
// The shared holding-refusal copy (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): the conversion's four sentences keyed by KIND (byte-identical to what
// CaseworkerDialog showed), the generic type change's own landlord sentence,
// and the reader for a 409 type_change_refused body.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/index.js';
import { refusalCopy } from '../routes/contact/CaseworkerDialog.js';
import {
  TYPE_CHANGE_LANDLORD_SENTENCE,
  refusalCopyByKind,
  typeChangeRefusalCopy,
  typeChangeRefusalsFrom,
} from './holdingRefusals.js';

const PLACEMENT = {
  sentence: "Finish or close this contact's placement first.",
  linkText: 'View placement',
  to: '/placements/p%207',
};
const TOUR = {
  sentence: "Cancel or close this contact's open tour first.",
  linkText: 'View tour',
  to: '/tours/t1',
};
const CONVERSION_LANDLORD = {
  sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
  linkText: 'View property',
  to: '/listings/u1',
};
const ROSTER = {
  sentence: "This contact is on a property's contact list. Remove them from it first.",
  linkText: 'View property',
  to: '/listings/u2',
};

describe('refusalCopyByKind - the conversion wording, keyed by kind', () => {
  it('names each kind with its link, ids URL-encoded', () => {
    expect(refusalCopyByKind({ code: 'open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(refusalCopyByKind({ code: 'open_tour', tourId: 't1' })).toEqual(TOUR);
    expect(refusalCopyByKind({ code: 'landlord_of_record', unitId: 'u1' })).toEqual(CONVERSION_LANDLORD);
    expect(refusalCopyByKind({ code: 'on_roster', unitId: 'u2' })).toEqual(ROSTER);
  });

  it("CaseworkerDialog's refusalCopy answers exactly as before for its four codes (W2)", () => {
    expect(refusalCopy({ code: 'caseworker_open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(refusalCopy({ code: 'caseworker_open_tour', tourId: 't1' })).toEqual(TOUR);
    expect(refusalCopy({ code: 'caseworker_landlord_of_record', unitId: 'u1' })).toEqual(CONVERSION_LANDLORD);
    expect(refusalCopy({ code: 'caseworker_on_roster', unitId: 'u2' })).toEqual(ROSTER);
  });
});

describe('typeChangeRefusalCopy - the generic type change', () => {
  it('uses the conversion sentence and link for an open placement and an open tour', () => {
    expect(typeChangeRefusalCopy({ code: 'open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(typeChangeRefusalCopy({ code: 'open_tour', tourId: 't1' })).toEqual(TOUR);
  });

  it('has its own landlord-of-record sentence: no dashboard path reassigns a landlord yet', () => {
    expect(TYPE_CHANGE_LANDLORD_SENTENCE).toBe(
      "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.",
    );
    expect(typeChangeRefusalCopy({ code: 'landlord_of_record', unitId: 'u 1' })).toEqual({
      sentence: TYPE_CHANGE_LANDLORD_SENTENCE,
      linkText: 'View property',
      to: '/listings/u%201',
    });
  });
});

describe('typeChangeRefusalsFrom - the 409 type_change_refused body', () => {
  function refused(body: unknown): ApiError {
    return new ApiError(409, 'type_change_refused', 'type_change_refused', body);
  }

  it('reads every refusal, in order', () => {
    const refusals = [
      { code: 'open_placement', placementId: 'p1' },
      { code: 'open_tour', tourId: 't1' },
      { code: 'landlord_of_record', unitId: 'u1' },
    ];
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused', refusals }))).toEqual(refusals);
  });

  it('drops malformed entries, and answers null when none is left', () => {
    expect(
      typeChangeRefusalsFrom(
        refused({
          error: 'type_change_refused',
          refusals: [
            { code: 'open_placement' },
            { code: 'on_roster', unitId: 'u2' },
            { code: 'caseworker_open_tour', tourId: 't9' },
            'open_tour',
            null,
            { code: 'open_tour', tourId: 't1' },
          ],
        }),
      ),
    ).toEqual([{ code: 'open_tour', tourId: 't1' }]);
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused', refusals: [] }))).toBeNull();
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused' }))).toBeNull();
    expect(typeChangeRefusalsFrom(refused(undefined))).toBeNull();
  });

  it('answers null for any other failure', () => {
    const refusals = [{ code: 'open_tour', tourId: 't1' }];
    expect(
      typeChangeRefusalsFrom(
        new ApiError(409, 'caseworker_use_conversion', 'caseworker_use_conversion', {
          error: 'caseworker_use_conversion',
          refusals,
        }),
      ),
    ).toBeNull();
    expect(
      typeChangeRefusalsFrom(
        new ApiError(400, 'type_change_refused', 'type_change_refused', { error: 'type_change_refused', refusals }),
      ),
    ).toBeNull();
    expect(typeChangeRefusalsFrom(new Error('offline'))).toBeNull();
    expect(typeChangeRefusalsFrom(undefined)).toBeNull();
  });
});
```

Step 3 - run RED:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/holdingRefusals.test.ts
```
RED: the file fails to load - `Failed to resolve import "./holdingRefusals.js"` (the module does
not exist).

Step 4 - implement. Create `dashboard/src/lib/holdingRefusals.ts`:
```ts
// holdingRefusals - the staff copy for what a contact HOLDS that blocks a
// change of its kind (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): an open placement or open tour as the tenant, a property it is the
// landlord of record for, a seat on a property's contact list. Keyed by
// refusal KIND and shared by the caseworker conversion dialog (its
// caseworker_* codes map onto these kinds, wording unchanged) and the generic
// type change (409 type_change_refused). The server sends codes only; every
// sentence lives here. TypeChangeRefusal mirrors the server's type in
// app/src/services/contactHoldings.ts.
import { ApiError } from '../api/index.js';

/** One refusal's staff sentence and the link to the record that blocks it. */
export interface RefusalCopy {
  sentence: string;
  linkText: string;
  to: string;
}

/** A blocking record, by kind. */
export type HoldingRefusal =
  | { code: 'open_placement'; placementId: string }
  | { code: 'open_tour'; tourId: string }
  | { code: 'landlord_of_record'; unitId: string }
  | { code: 'on_roster'; unitId: string };

/** One entry of a 409 type_change_refused - a seat never refuses a type change. */
export type TypeChangeRefusal = Exclude<HoldingRefusal, { code: 'on_roster' }>;

/**
 * The type change's own landlord-of-record sentence: no dashboard UI can
 * reassign a property's landlord yet (filed: landlord-of-record-no-reassign-ui),
 * so "change that property's landlord first" would point nowhere.
 */
export const TYPE_CHANGE_LANDLORD_SENTENCE =
  "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.";

/** The conversion's wording, by kind (CaseworkerDialog's four sentences, verbatim). */
export function refusalCopyByKind(refusal: HoldingRefusal): RefusalCopy {
  switch (refusal.code) {
    case 'open_placement':
      return {
        sentence: "Finish or close this contact's placement first.",
        linkText: 'View placement',
        to: `/placements/${encodeURIComponent(refusal.placementId)}`,
      };
    case 'open_tour':
      return {
        sentence: "Cancel or close this contact's open tour first.",
        linkText: 'View tour',
        to: `/tours/${encodeURIComponent(refusal.tourId)}`,
      };
    case 'landlord_of_record':
      return {
        sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
    case 'on_roster':
      return {
        sentence: "This contact is on a property's contact list. Remove them from it first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
  }
}

/** The generic type change's wording: the conversion's for an open placement
 *  and an open tour, its own for a landlord of record. */
export function typeChangeRefusalCopy(refusal: TypeChangeRefusal): RefusalCopy {
  if (refusal.code === 'landlord_of_record') {
    return {
      sentence: TYPE_CHANGE_LANDLORD_SENTENCE,
      linkText: 'View property',
      to: `/listings/${encodeURIComponent(refusal.unitId)}`,
    };
  }
  return refusalCopyByKind(refusal);
}

function isTypeChangeRefusal(value: unknown): value is TypeChangeRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['code']) {
    case 'open_placement':
      return typeof v['placementId'] === 'string';
    case 'open_tour':
      return typeof v['tourId'] === 'string';
    case 'landlord_of_record':
      return typeof v['unitId'] === 'string';
    default:
      return false;
  }
}

/** The refusals a 409 type_change_refused carries, or null for any other
 *  failure (and for a body with no well-formed refusal - the caller then
 *  shows its generic retry sentence). */
export function typeChangeRefusalsFrom(err: unknown): TypeChangeRefusal[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'type_change_refused') return null;
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>) : {};
  const list = Array.isArray(body['refusals']) ? body['refusals'].filter(isTypeChangeRefusal) : [];
  return list.length > 0 ? list : null;
}
```

Edit `dashboard/src/routes/contact/CaseworkerDialog.tsx`:

(a) Import. Before:
```ts
import { Button, Spinner } from '../../ui/index.js';
```
After:
```ts
import { Button, Spinner } from '../../ui/index.js';
import { refusalCopyByKind } from '../../lib/holdingRefusals.js';
```

(b) Delegate. Before:
```ts
/** One refusal's staff sentence and the link to the record that blocks it (plan 3.9). */
export function refusalCopy(refusal: CaseworkerRefusal): { sentence: string; linkText: string; to: string } {
  switch (refusal.code) {
    case 'caseworker_open_placement':
      return {
        sentence: "Finish or close this contact's placement first.",
        linkText: 'View placement',
        to: `/placements/${encodeURIComponent(refusal.placementId)}`,
      };
    case 'caseworker_open_tour':
      return {
        sentence: "Cancel or close this contact's open tour first.",
        linkText: 'View tour',
        to: `/tours/${encodeURIComponent(refusal.tourId)}`,
      };
    case 'caseworker_landlord_of_record':
      return {
        sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
    case 'caseworker_on_roster':
      return {
        sentence: "This contact is on a property's contact list. Remove them from it first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
  }
}
```
After:
```ts
/** One refusal's staff sentence and the link to the record that blocks it
 *  (plan 3.9). The sentences live in lib/holdingRefusals.ts keyed by refusal
 *  KIND, shared with the generic type change (spec 2026-10-12 D2); each
 *  caseworker_* code maps onto its kind, so the output is unchanged. */
export function refusalCopy(refusal: CaseworkerRefusal): { sentence: string; linkText: string; to: string } {
  switch (refusal.code) {
    case 'caseworker_open_placement':
      return refusalCopyByKind({ code: 'open_placement', placementId: refusal.placementId });
    case 'caseworker_open_tour':
      return refusalCopyByKind({ code: 'open_tour', tourId: refusal.tourId });
    case 'caseworker_landlord_of_record':
      return refusalCopyByKind({ code: 'landlord_of_record', unitId: refusal.unitId });
    case 'caseworker_on_roster':
      return refusalCopyByKind({ code: 'on_roster', unitId: refusal.unitId });
  }
}
```

Step 5 - GREEN:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/holdingRefusals.test.ts src/routes/contact/CaseworkerDialog.test.tsx
cd "W:/tmp/caseworker-integrity/dashboard"; npx tsc -p tsconfig.json --noEmit
git -C "W:/tmp/caseworker-integrity" diff --exit-code 19607658 -- dashboard/src/routes/contact/CaseworkerDialog.test.tsx
cd "W:/tmp/caseworker-integrity"; npx eslint dashboard/src/lib/holdingRefusals.ts dashboard/src/lib/holdingRefusals.test.ts dashboard/src/routes/contact/CaseworkerDialog.tsx
```
The dialog's own test file is green and unedited (W2: four sentences and View links
byte-identical). ASCII check of both new files prints 0.

Step 6 - commit:
```
git -C "W:/tmp/caseworker-integrity" add dashboard/src/lib/holdingRefusals.ts dashboard/src/lib/holdingRefusals.test.ts dashboard/src/routes/contact/CaseworkerDialog.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "refactor(dashboard): holding refusal copy keyed by kind in lib/holdingRefusals.ts, plus the type change's landlord sentence and body reader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.6 - the edit form keeps the draft and shows a refused type change beside the kind picker

Goal: on 409 `type_change_refused` the edit form keeps everything typed and picked, and shows
each refusal's sentence with its View link inside the Type block, under the KindPicker; the
form-level line stays empty. Picking another kind, or saving again, clears the list. 409
`caseworker_use_conversion` keeps its own copy; any other failure keeps "Couldn't save -
please try again.". One new shared component renders the list (reused by Task 2.7).

Files:
- `dashboard/src/routes/contact/TypeChangeRefusalList.tsx` (NEW)
- `dashboard/src/routes/contact/TypeChangeRefusalList.module.css` (NEW)
- `dashboard/src/routes/contact/ContactEditForm.tsx`
- `dashboard/src/routes/contact/ContactEditForm.test.tsx`

Step 1 - failing test. In `dashboard/src/routes/contact/ContactEditForm.test.tsx` edit the
imports. Before:
```ts
import { ApiError, type Contact, type OrgEntry } from '../../api/index.js';
```
After:
```ts
import { ApiError, type Contact, type OrgEntry } from '../../api/index.js';
import { MemoryRouter } from 'react-router-dom';
import { TYPE_CHANGE_LANDLORD_SENTENCE } from '../../lib/holdingRefusals.js';
```

Append at the end of the file:
```tsx
describe('ContactEditForm - a refused type change (spec 2026-10-12 D2)', () => {
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  function typeChangeRefused(refusals: unknown[]): ApiError {
    return new ApiError(409, 'type_change_refused', 'type_change_refused', {
      error: 'type_change_refused',
      refusals,
    });
  }

  function renderForm(contact: Contact): {
    onSaved: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
  } {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ContactEditForm contact={contact} onClose={onClose} onSaved={onSaved} />
      </MemoryRouter>,
    );
    return { onSaved, onClose };
  }

  it('keeps the draft and shows each refusal with its View link beside the kind picker', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      typeChangeRefused([
        { code: 'open_placement', placementId: 'p 7' },
        { code: 'open_tour', tourId: 't1' },
      ]),
    );
    const { onSaved, onClose } = renderForm({ ...TENANT, status: 'needs_review' });
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Tash');
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    await user.click(save());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(alert).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(alert).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    // Beside the kind picker: inside the Type block that holds the picker.
    const picker = screen.getByRole('group', { name: 'Contact kind' });
    expect(picker.parentElement?.parentElement).toContainElement(alert);
    // The draft is kept: still open, on the picked kind, with the edited name.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Landlord' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/First name/i)).toHaveValue('Tash');
    expect(save()).toBeEnabled();
    // Never the raw code, never the generic retry line.
    expect(screen.queryByText("Couldn't save - please try again.")).toBeNull();
    expect(alert.textContent ?? '').not.toContain('type_change_refused');
  });

  it("a landlord of record gets the type change's own sentence, not the conversion's", async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(typeChangeRefused([{ code: 'landlord_of_record', unitId: 'u1' }]));
    renderForm(LANDLORD);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View property' })).toHaveAttribute('href', '/listings/u1');
    expect(
      screen.queryByText("This contact is the landlord of record for a property. Change that property's landlord first."),
    ).toBeNull();
  });

  it('picking another kind clears the refusals, and the next save asks the server again', async () => {
    const user = userEvent.setup();
    updateContact
      .mockRejectedValueOnce(typeChangeRefused([{ code: 'landlord_of_record', unitId: 'u1' }]))
      .mockResolvedValueOnce({ ...LANDLORD, role: 'Property Manager' });
    const { onSaved } = renderForm(LANDLORD);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    await user.click(save());
    expect(await screen.findByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(screen.queryByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeNull();
    await user.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateContact).toHaveBeenLastCalledWith('L1', { role: 'Property Manager' });
  });
});
```

Step 2 - run RED:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactEditForm.test.tsx
```
RED: the three new cases fail - the form shows the generic `<p role="alert">Couldn't save -
please try again.</p>`, so `within(alert).getByText("Finish or close ...")` and
`findByText(TYPE_CHANGE_LANDLORD_SENTENCE)` find nothing. Every existing case passes.

Step 3 - implement.

Create `dashboard/src/routes/contact/TypeChangeRefusalList.tsx`:
```tsx
// TypeChangeRefusalList - what blocks a refused contact type change (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): one sentence per blocking record, each with a link to that record.
// Shared by the edit form (beside the kind picker) and the Unknown card
// (under its Mark as actions). The sentences live in lib/holdingRefusals.ts.
import { Link } from 'react-router-dom';
import { typeChangeRefusalCopy, type TypeChangeRefusal } from '../../lib/holdingRefusals.js';
import styles from './TypeChangeRefusalList.module.css';

export interface TypeChangeRefusalListProps {
  refusals: TypeChangeRefusal[];
}

export function TypeChangeRefusalList({ refusals }: TypeChangeRefusalListProps): React.JSX.Element {
  return (
    <div role="alert" className={styles.refusals}>
      <ul className={styles.list}>
        {refusals.map((refusal, index) => {
          const copy = typeChangeRefusalCopy(refusal);
          return (
            <li key={`${refusal.code}-${index}`}>
              {copy.sentence} <Link to={copy.to}>{copy.linkText}</Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

Create `dashboard/src/routes/contact/TypeChangeRefusalList.module.css`:
```css
/* TypeChangeRefusalList - a refused type change's blocking records. Tokens only. */

.refusals {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
```

Edit `dashboard/src/routes/contact/ContactEditForm.tsx`:

(a) Imports. Before:
```ts
import { consentAtFromDate } from '../../lib/consentCopy.js';
```
After:
```ts
import { consentAtFromDate } from '../../lib/consentCopy.js';
import { typeChangeRefusalsFrom, type TypeChangeRefusal } from '../../lib/holdingRefusals.js';
```
Before:
```ts
import { KindPicker, type KindPickerValue } from './KindPicker.js';
```
After:
```ts
import { KindPicker, type KindPickerValue } from './KindPicker.js';
import { TypeChangeRefusalList } from './TypeChangeRefusalList.js';
```

(b) State. Before:
```ts
  const [changingType, setChangingType] = useState(false);
```
After:
```ts
  const [changingType, setChangingType] = useState(false);
  // A refused type change's blocking records (409 type_change_refused, spec
  // 2026-10-12 D2), shown beside the kind picker until the kind changes or
  // the next save.
  const [typeRefusals, setTypeRefusals] = useState<TypeChangeRefusal[] | null>(null);
```

(c) A new kind clears them. Before:
```ts
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
```
After:
```ts
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
    setTypeRefusals(null);
```

(d) A new save clears them. Before:
```ts
    setSaving(true);
    setError(null);
```
After:
```ts
    setSaving(true);
    setError(null);
    setTypeRefusals(null);
```

(e) The catch. Before:
```ts
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'caseworker_use_conversion') {
        // A save never makes a contact a caseworker (spec D16) - say where to go.
        setError(CASEWORKER_USE_CONVERSION);
      } else {
        setError("Couldn't save - please try again.");
      }
```
After:
```ts
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'caseworker_use_conversion') {
        // A save never makes a contact a caseworker (spec D16) - say where to go.
        setError(CASEWORKER_USE_CONVERSION);
      } else {
        // A type change that would orphan open records (spec 2026-10-12 D2):
        // keep the draft and show what blocks it beside the kind picker.
        const typeRefused = typeChangeRefusalsFrom(err);
        if (typeRefused !== null) setTypeRefusals(typeRefused);
        else setError("Couldn't save - please try again.");
      }
```

(f) Render beside the picker. Before:
```tsx
            <KindPicker
              value={kind}
              onChange={handleKindChange}
              roleSuggestions={vocab.roles}
              offerCaseworker={isCaseworkerContact(contact)}
            />
          </div>
```
After:
```tsx
            <KindPicker
              value={kind}
              onChange={handleKindChange}
              roleSuggestions={vocab.roles}
              offerCaseworker={isCaseworkerContact(contact)}
            />
            {/* A refused type change (409 type_change_refused, spec
                2026-10-12 D2): what blocks it, beside the picker. A type
                change is only possible with this block open. */}
            {typeRefusals !== null ? <TypeChangeRefusalList refusals={typeRefusals} /> : null}
          </div>
```

Step 4 - GREEN:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactEditForm.test.tsx
cd "W:/tmp/caseworker-integrity/dashboard"; npx tsc -p tsconfig.json --noEmit
cd "W:/tmp/caseworker-integrity"; npx eslint dashboard/src/routes/contact/TypeChangeRefusalList.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx
```
(The existing "409 caseworker_use_conversion points to the conversion" case stays green: that
branch is untouched.) ASCII check of the two new files prints 0; added lines of the two edited
files are ASCII (the form has pre-existing non-ASCII comment arrows - do not touch them).

Step 5 - commit:
```
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/contact/TypeChangeRefusalList.tsx dashboard/src/routes/contact/TypeChangeRefusalList.module.css dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): the edit form keeps the draft and shows a refused type change's records beside the kind picker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.7 - the Unknown card shows a Mark as failure

Goal: `UnknownFile` takes `triageError` and shows it on the Needs triage card, under the Mark
as actions: a refused type change as its sentences with View links, any other failure as its
message. No error: nothing.

Files:
- `dashboard/src/routes/contact/UnknownFile.tsx`
- `dashboard/src/routes/contact/UnknownFile.module.css`
- `dashboard/src/routes/contact/UnknownFile.test.tsx`

Step 1 - failing test. In `dashboard/src/routes/contact/UnknownFile.test.tsx`:

Before:
```ts
import { render, screen } from '@testing-library/react';
```
After:
```ts
import { render, screen, within } from '@testing-library/react';
```
Before:
```ts
import { UnknownFile } from './UnknownFile.js';
```
After:
```ts
import { UnknownFile, type TriageError } from './UnknownFile.js';
import { TYPE_CHANGE_LANDLORD_SENTENCE } from '../../lib/holdingRefusals.js';
```
Before:
```ts
  triaging?: boolean;
  media?: CommsMediaItem[];
} = {}): void {
```
After:
```ts
  triaging?: boolean;
  media?: CommsMediaItem[];
  triageError?: TriageError | null;
} = {}): void {
```
Before:
```tsx
          triaging={opts.triaging}
```
After:
```tsx
          triaging={opts.triaging}
          triageError={opts.triageError ?? null}
```

Append at the end of the file:
```tsx
describe('UnknownFile - a Mark as failure on the card (spec 2026-10-12 D2)', () => {
  const card = (): HTMLElement =>
    screen.getByRole('heading', { name: 'Needs triage' }).closest('section') as HTMLElement;

  it('a refused type change shows each refusal sentence with its View link', () => {
    renderIt({
      triageError: {
        refusals: [
          { code: 'open_placement', placementId: 'p 7' },
          { code: 'open_tour', tourId: 't1' },
          { code: 'landlord_of_record', unitId: 'u1' },
        ],
      },
    });
    const alert = within(card()).getByRole('alert');
    expect(within(alert).getByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(alert).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(within(alert).getByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(alert).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    expect(within(alert).getByRole('link', { name: 'View property' })).toHaveAttribute('href', '/listings/u1');
    // The actions stay available for a retry.
    expect(screen.getByRole('button', { name: 'Mark as Tenant' })).toBeEnabled();
  });

  it('any other failure shows its sentence on the card', () => {
    renderIt({ triageError: { message: "Couldn't save - please try again." } });
    expect(within(card()).getByRole('alert')).toHaveTextContent("Couldn't save - please try again.");
  });

  it('(PIN) shows nothing on the card without a failure', () => {
    renderIt();
    expect(within(card()).queryByRole('alert')).toBeNull();
  });
});
```

Step 2 - run RED:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/UnknownFile.test.tsx
```
RED: the first two new cases fail with `Unable to find role="alert"` (the component ignores the
prop); the (PIN) case and every existing case pass.

Step 3 - implement. Edit `dashboard/src/routes/contact/UnknownFile.tsx`:

(a) Imports. Before:
```ts
import { suggestedContactKindLabel, type SuggestedContactKind } from './contactProfile.js';
import styles from './UnknownFile.module.css';
```
After:
```ts
import { suggestedContactKindLabel, type SuggestedContactKind } from './contactProfile.js';
import type { TypeChangeRefusal } from '../../lib/holdingRefusals.js';
import { TypeChangeRefusalList } from './TypeChangeRefusalList.js';
import styles from './UnknownFile.module.css';

/** The Unknown card's last Mark as failure (spec 2026-10-12 D2): a refused
 *  type change's blocking records, or a sentence for any other failure. */
export type TriageError = { refusals: TypeChangeRefusal[] } | { message: string };
```

(b) Prop. Before:
```ts
  triaging?: boolean;
  /** Pending AI suggestions - a `type` suggestion surfaces a recommendation line
```
After:
```ts
  triaging?: boolean;
  /** The last Mark as failure, shown on the Needs triage card (null: none). */
  triageError?: TriageError | null;
  /** Pending AI suggestions - a `type` suggestion surfaces a recommendation line
```

(c) Destructure. Before:
```ts
  triaging = false,
  suggestions = [],
}: UnknownFileProps): React.JSX.Element {
```
After:
```ts
  triaging = false,
  triageError = null,
  suggestions = [],
}: UnknownFileProps): React.JSX.Element {
```

(d) Render under the actions. Before:
```tsx
            Mark as Property Manager
          </Button>
        </div>
      </Card>
```
After:
```tsx
            Mark as Property Manager
          </Button>
        </div>
        {triageError !== null ? (
          <div className={styles.triageError}>
            {'refusals' in triageError ? (
              <TypeChangeRefusalList refusals={triageError.refusals} />
            ) : (
              <p role="alert" className={styles.error}>
                {triageError.message}
              </p>
            )}
          </div>
        ) : null}
      </Card>
```

Append to `dashboard/src/routes/contact/UnknownFile.module.css`:
```css

.triageError {
  margin-top: var(--sp-2);
}

.error {
  margin: 0;
  color: var(--c-danger);
  font-size: var(--fs-sm);
}
```

Step 4 - GREEN:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/UnknownFile.test.tsx
cd "W:/tmp/caseworker-integrity/dashboard"; npx tsc -p tsconfig.json --noEmit
cd "W:/tmp/caseworker-integrity"; npx eslint dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx
```
Added lines are ASCII (UnknownFile.tsx has pre-existing non-ASCII dashes - leave them).

Step 5 - commit:
```
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.module.css dashboard/src/routes/contact/UnknownFile.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): the Unknown card shows a Mark as failure - a refused type change's records or the save sentence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.8 - ContactDetail stops swallowing Mark as errors

Goal: `onTriage` (`ContactDetail.tsx:667-676`) no longer `.catch(() => {})`: a 409
`type_change_refused` becomes `{ refusals }` on the card, any other failure `{ message:
"Couldn't save - please try again." }`; a new attempt clears the previous one; a contact
change resets it, and a failure that lands after the contact changed is dropped
(`reviewGenerationRef`, bumped only by the contact-change effect).

Files:
- `dashboard/src/routes/contact/ContactDetail.tsx`
- `dashboard/src/routes/contact/ContactDetail.test.tsx`

Step 1 - failing test. In `dashboard/src/routes/contact/ContactDetail.test.tsx` add an import.
Before:
```ts
import { ImageViewerProvider } from '../../ui/imageViewer/ImageViewerProvider.js';
```
After:
```ts
import { ImageViewerProvider } from '../../ui/imageViewer/ImageViewerProvider.js';
import { TYPE_CHANGE_LANDLORD_SENTENCE } from '../../lib/holdingRefusals.js';
```
(The first match is the import at the top of the file, line 15.)

Insert right after the existing test `it('keeps Unknown actions retryable when triage PATCH
rejects', ...)` - i.e. after its closing lines:
```tsx
    expect(screen.getByRole('button', { name: 'Mark as Property Manager' })).toBeEnabled();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
```
add:
```tsx

  it('a refused Mark as (409 type_change_refused) shows each refusal and its View link on the Unknown card', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    updateContact.mockRejectedValue(
      new ApiError(409, 'type_change_refused', 'type_change_refused', {
        error: 'type_change_refused',
        refusals: [
          { code: 'open_placement', placementId: 'p 7' },
          { code: 'open_tour', tourId: 't1' },
        ],
      }),
    );
    renderAt('u9');
    await user.click(await screen.findByRole('button', { name: 'Mark as Landlord' }));
    const card = screen.getByRole('heading', { name: 'Needs triage' }).closest('section') as HTMLElement;
    expect(await within(card).findByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(card).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(card).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    // Still untriaged, and every action re-enables for a retry.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as Landlord' })).toBeEnabled());
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('any other Mark as failure shows the save sentence on the card instead of being swallowed', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    updateContact.mockRejectedValue(new Error('offline'));
    renderAt('u9');
    await user.click(await screen.findByRole('button', { name: 'Mark as Partner' }));
    const card = screen.getByRole('heading', { name: 'Needs triage' }).closest('section') as HTMLElement;
    expect(await within(card).findByText("Couldn't save - please try again.")).toBeInTheDocument();
  });

  it('a new Mark as attempt replaces the previous message', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    updateContact
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(
        new ApiError(409, 'type_change_refused', 'type_change_refused', {
          error: 'type_change_refused',
          refusals: [{ code: 'landlord_of_record', unitId: 'u1' }],
        }),
      );
    renderAt('u9');
    await user.click(await screen.findByRole('button', { name: 'Mark as Tenant' }));
    const card = screen.getByRole('heading', { name: 'Needs triage' }).closest('section') as HTMLElement;
    expect(await within(card).findByText("Couldn't save - please try again.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as Tenant' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Mark as Tenant' }));
    expect(await within(card).findByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    expect(within(card).queryByText("Couldn't save - please try again.")).toBeNull();
    expect(within(card).getByRole('link', { name: 'View property' })).toHaveAttribute('href', '/listings/u1');
  });
```

Step 2 - run RED:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx
```
RED: the three new cases fail - `onTriage` swallows the rejection (`.catch(() => {})`), so the
card never shows a sentence and `findByText` times out. The existing "keeps Unknown actions
retryable" case and every other case pass.

Step 3 - implement. Edit `dashboard/src/routes/contact/ContactDetail.tsx`:

(a) Imports. Before:
```ts
import { UnknownFile } from './UnknownFile.js';
```
After:
```ts
import { UnknownFile, type TriageError } from './UnknownFile.js';
```
Before:
```ts
import { orgErrorCopy } from '../orgs/orgCopy.js';
```
After:
```ts
import { orgErrorCopy } from '../orgs/orgCopy.js';
import { typeChangeRefusalsFrom } from '../../lib/holdingRefusals.js';
```

(b) State. Before:
```ts
  const [triaging, setTriaging] = useState(false);
```
After:
```ts
  const [triaging, setTriaging] = useState(false);
  // The Unknown card's last Mark as failure (spec 2026-10-12 D2): a refused
  // type change names what blocks it; anything else is the save sentence.
  const [triageError, setTriageError] = useState<TriageError | null>(null);
```

(c) Reset on a contact change (inside the existing `[contactId]` effect). Before:
```ts
    setSuggestionBusy(null);
    setSuggestionError(null);
    // Spec D8: contact A's "Is this really new?" - and a check still in flight
```
After:
```ts
    setSuggestionBusy(null);
    setSuggestionError(null);
    // Same reason: contact A's Mark as failure must not show on contact B.
    setTriageError(null);
    // Spec D8: contact A's "Is this really new?" - and a check still in flight
```

(d) onTriage. Before:
```ts
  const onTriage = (kind: SuggestedContactKind): void => {
    if (triaging) return;
    setTriaging(true);
    void updateContact(contact.contactId, patchForSuggestedContactKind(kind))
      .then((updated) => setContact(updated))
      .catch(() => {
        /* stay on the unknown view; the buttons re-enable for a retry */
      })
      .finally(() => setTriaging(false));
  };
```
After:
```ts
  const onTriage = (kind: SuggestedContactKind): void => {
    if (triaging) return;
    setTriaging(true);
    setTriageError(null);
    // A failure for contact A must not land on contact B's card: the
    // contact-change effect bumps reviewGenerationRef.
    const generation = reviewGenerationRef.current;
    void updateContact(contact.contactId, patchForSuggestedContactKind(kind))
      .then((updated) => setContact(updated))
      .catch((err: unknown) => {
        // Stay on the unknown view; the buttons re-enable for a retry. Say why
        // on the card (spec 2026-10-12 D2): a refused type change names what
        // blocks it, anything else is the save sentence.
        if (generation !== reviewGenerationRef.current) return;
        const refusals = typeChangeRefusalsFrom(err);
        setTriageError(refusals !== null ? { refusals } : { message: "Couldn't save - please try again." });
      })
      .finally(() => setTriaging(false));
  };
```

(e) Pass it to the card. Before:
```tsx
                triaging={triaging}
```
After:
```tsx
                triaging={triaging}
                triageError={triageError}
```
(`triaging={triaging}` occurs once in the file, on the `<UnknownFile` element.)

Step 4 - GREEN:
```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx src/routes/contact/UnknownFile.test.tsx
cd "W:/tmp/caseworker-integrity/dashboard"; npx tsc -p tsconfig.json --noEmit
cd "W:/tmp/caseworker-integrity"; npx eslint dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
```
ContactDetail.tsx lints clean on the base commit; any lint error now is this task's. Added lines
are ASCII (the file has pre-existing non-ASCII characters - leave them).

Step 5 - commit:
```
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "fix(dashboard): Mark as on the Unknown card no longer swallows errors - a refused type change or the save sentence shows on the card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Slice gate

Run bare, from the worktree, after Task 2.8:
```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/caseworkers.test.ts test/contactHoldings.test.ts test/caseworkerConversion.test.ts test/caseworkerReviewApi.test.ts test/contactTriage.test.ts test/contactTypeChangeRefusals.test.ts
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/holdingRefusals.test.ts src/routes/contact/CaseworkerDialog.test.tsx src/routes/contact/ContactEditForm.test.tsx src/routes/contact/UnknownFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/caseworkerRoleMirror.test.ts
cd "W:/tmp/caseworker-integrity"; npm run typecheck
git -C "W:/tmp/caseworker-integrity" diff --exit-code 19607658 -- app/test/caseworkerConversion.test.ts app/test/caseworkerReviewApi.test.ts dashboard/src/routes/contact/CaseworkerDialog.test.tsx
cd "W:/tmp/caseworker-integrity"; npx eslint app/src/lib/caseworkers.ts app/src/services/contactHoldings.ts app/src/services/caseworkerConversion.ts app/src/routes/contacts.ts app/test/caseworkers.test.ts app/test/contactHoldings.test.ts app/test/contactTriage.test.ts app/test/contactTypeChangeRefusals.test.ts dashboard/src/lib/holdingRefusals.ts dashboard/src/lib/holdingRefusals.test.ts dashboard/src/routes/contact/CaseworkerDialog.tsx dashboard/src/routes/contact/TypeChangeRefusalList.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
```
All of the S2 source files above lint clean at the base commit (checked 2026-10-12), so any
error is S2's and BLOCKING: expected eslint exit 0. Follow section 0 "Lint at every slice
gate": run its coverage check (every path it prints must be in the S1 or S2 list), and if
eslint reports anything, confirm the attribution with its merge-base baseline run on the
same S2 list before fixing (plan review R1 row 3). The CK checkpoint after S2 (plan section
3: typecheck + `npm test` + `npm run smoke`) follows this gate. e2e is not run here
(CONTRACT ISSUE 4: S5's sweep).

### Surfaces covered

- Rule: a type change whose result is not `tenant` refuses open placements and open tours (I2) -> 2.3 (reader), 2.4 (route, full matrix).
- Rule: a result that is not `landlord` refuses a LIVE unit's landlord of record; soft-deleted units do not count -> 2.2 (`landlordUnitIds` live/any), 2.3, 2.4 ("only the live unit is named", "(PIN) only a soft-deleted unit").
- Rule: contact-list seats never refuse -> 2.3, 2.4.
- Every target type, including `team_member` and `unknown`, from every stored type -> 2.4 (20-pair matrix + allowed pairs).
- Order: after 409 `caseworker_use_conversion` (W6), before any write; role-only changes and a re-sent stored type not checked -> 2.4.
- Response 409 `{ error: 'type_change_refused', refusals }`, ordered kind then id ascending -> 2.3, 2.4.
- Shared reads: `collectRefusals` extracted into `contactHoldings.ts`, four kinds separately, live-only or any-deleted per call -> 2.2.
- The conversion's behavior, codes, order and deleted-unit counting unchanged; its tests stay green unchanged (W2) -> 2.2 (diff check), 2.4 (only the PATCH-side `contactTriage.test.ts` fixture changes, CONTRACT ISSUE 3).
- The PATCH reads only the kinds its rule needs, never the roster Scan -> 2.3, 2.4 ("the reads").
- `contactKind` in `app/src/lib/caseworkers.ts` (for S3) -> 2.1.
- Dashboard: `refusalCopy` moved to a shared module keyed by kind; the dialog's four sentences and View links byte-identical -> 2.5.
- Dashboard: the type change uses the conversion sentences for placement/tour and its own landlord sentence with View property -> 2.5, rendered in 2.6/2.7.
- Edit form: on 409 `type_change_refused` keep the draft, sentences + View links beside the kind picker; `caseworker_use_conversion` copy and the generic failure copy unchanged -> 2.6.
- Unknown card: Mark as stops swallowing errors (`ContactDetail.tsx:672`); `type_change_refused` shows sentences + links on the card; other failures "Couldn't save - please try again." -> 2.7 (card), 2.8 (wiring).
- Tests per spec section 8 "D2" (PATCH matrix, conversion unchanged, edit form and Unknown card dashboard tests) -> 2.2-2.8.
- Not in S2: filing `landlord-of-record-no-reassign-ui` and the e2e "type change from the edit form" spec -> S5.


---

# SLICE S3 (assembled from the section draft)

## S3 - D3 (I2): contact-type guards, tours and placements check the tenant, derived tenant status, team members, tour/placement dashboard copy

Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` section 4
("Tours and placements (I2)", "Derived tenant status", "Team members", the
tour/placement half of "Dashboard copy for section 4") and section 8 "D3".
Binding: plan sections 0-3 (names in section 2, copy in section 1, W3/W5/W7).

Prerequisites (slice map: S3 depends on S2), committed before Task 3.1:
- `contactKind` exported from `app/src/lib/caseworkers.ts` (S2 Task 2.1).
- `OPEN_TOUR_STATUSES` exported from `app/src/services/contactHoldings.ts` (S2).

Line numbers below are from main @19607658 (+ the S2 tree for the two names
above). Every edit is anchored on quoted text that was verified UNIQUE and
ASCII in its file; never edit by line number.

Task order matters: 3.2 (fixture sweep) lands before 3.3 and 3.5 (otherwise
existing suites go red); 3.8 before 3.9; 3.11 before 3.12-3.17.

---

## CONTRACT ISSUES

1. **The tour dialogs are the dashboard's real revive/reopen surfaces and are
   missing from the spec's copy-site list.** `TourModals.tsx:41-46`
   `failureCopy` maps EVERY ApiError 409 to `TOUR_CHANGED_COPY`
   ("This tour changed since the page loaded - reload and try again.",
   :39). The only dashboard path that revives a CANCELED tour is the
   Reschedule dialog (`TourActionsMenu.tsx:16` shows Reschedule for
   scheduled/canceled/no_show; `RescheduleTourModal`, `TourModals.tsx:177`,
   via `DateTimeModal` :98-106), and the only reopen path is
   `ReopenTourModal` (:439-490). After S3 as specified, a 409
   `contact_not_tenant` there would read "This tour changed...". The listed
   site `TourDetail.tsx:382` (`runDirect`) is reached only by Mark toured /
   Mark no-show on a SCHEDULED tour (an open-to-open move the server never
   refuses under I2). **Resolution:** add `failureCopy` as a copy site
   (Task 3.13: `contactTypeErrorMessage(err)` first, then today's 409 rule;
   W7-safe), and keep :382/:514/:589 as listed (Task 3.12). S5 reached the
   same conclusion independently (S5 draft CONTRACT ISSUE 1 (a)).
2. **Plan section 1 has no phrase for a `contactKind` outside its six.** The
   server sends one of the six today (`contactKind` = `caseworker` or the
   stored ContactType), but the body is untyped on the wire.
   **Resolution:** `contactTypeErrorMessage` falls back to the phrase
   "not a tenant" ("Tours and placements are for tenants. This contact
   is not a tenant.") for a missing or unrecognized `contactKind`
   (Task 3.11 pins it).
3. **W3 scale: `app/test/toursApi.test.ts` posts tours for tenants it never
   created.** 113 test blocks (137 `POST /api/tours` calls; ~20 distinct
   ids, mostly `BASE_CREATE_BODY`'s `contact-tenant-1`) create tours for a
   contact absent from the world; after Task 3.3 every one answers 404
   `tenant_not_found`. Per-test edits (113 Edit calls in a 6115-line file)
   are impractical and error-prone. **Resolution (Task 3.2):** a FILE-LOCAL
   fixture in `toursApi.test.ts`: a `POST /api/tours` sent through its
   `authed()` helper first puts the posted `tenantId` in the world as a
   contact typed `tenant` ONLY when no contact with that id is there yet; a
   contact the test seeded itself is used exactly as written, so a
   non-tenant is still refused (the rule is not weakened). The fixture is
   pinned by its own tests; the one test that NEEDS a missing tenant
   (`400 relay_member_unresolvable names each missing rung of the resolution
   ladder`) creates its tour in the store instead. The rule's own tests live
   in new files that have no such fixture. Orchestrator: accept or rule
   per-test seeding instead.
4. **ASCII rule vs W7 on three fallback strings.** The fallbacks at
   `ScheduleTourForm.tsx:327`, `PlacementCreateForm.tsx:249` and
   `PlacementDetail.tsx:402` contain a non-ASCII em dash; rewriting those
   lines would ADD non-ASCII lines (section 0 forbids it), and W7 forbids
   changing the copy. **Resolution:** the edits never touch those lines (an
   early-return branch before the fallback, or a preceding `.catch`), and
   tests match the fallback with an ASCII regex prefix.
5. **`deriveTenantStatus`'s contact read is eventually consistent**
   (`statusTransition.ts:337`) and now also gates the new skip. The spec
   makes NEW reads consistent; this one is not new. **Resolution:** left
   as is (best-effort derivation; the window is index/replication lag of
   the same class as L1). Flag only.

No findings file: nothing in the tree changes a spec DECISION.

---

## Task 3.1 - `contactTypeGuards.ts`: consistent tenant / landlord reads and their HTTP mapping

Goal: create the binding module (plan section 2): four error classes,
`requireTenantContact` and `requireLandlordContact` (CONSISTENT reads),
`sendContactTypeError`. S4 uses the landlord half.

Files:
- `app/src/services/contactTypeGuards.ts` (new)
- `app/test/contactTypeGuards.test.ts` (new)

### Step 1 - failing test

Write `app/test/contactTypeGuards.test.ts`:

```ts
// contactTypeGuards (caseworker integrity spec 2026-10-12, sections 1 and 4):
// the CONSISTENT tenant / landlord reads behind I2 and I3, and the one mapping
// from their four errors to HTTP answers. Pure: a stub contacts repo and a
// recording response - no harness, no DynamoDB.
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  ContactNotTenantError,
  LandlordNotFoundError,
  LandlordNotLandlordError,
  requireLandlordContact,
  requireTenantContact,
  sendContactTypeError,
  TenantNotFoundError,
} from '../src/services/contactTypeGuards.js';

/** A contacts repo that answers `contact` for any id and records each call. */
function repoAnswering(contact: ContactItem | undefined) {
  return {
    getById: vi.fn(async (_contactId: string, _opts?: { consistentRead?: boolean }) => contact),
  };
}

interface FakeResponse {
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

/** A response that records the status and JSON body it was given. */
function recordingResponse(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res: FakeResponse = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

describe('requireTenantContact (I2)', () => {
  it('reads the contact CONSISTENTLY and returns a contact typed tenant', async () => {
    const tenant: ContactItem = { contactId: 'c-1', type: 'tenant' };
    const repo = repoAnswering(tenant);
    await expect(requireTenantContact(repo, 'c-1')).resolves.toBe(tenant);
    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(repo.getById).toHaveBeenCalledWith('c-1', { consistentRead: true });
  });

  it('a soft-deleted tenant still exists (no deleted-contact refusal, spec section 10)', async () => {
    const deleted: ContactItem = { contactId: 'c-1', type: 'tenant', deleted_at: '2026-10-01T00:00:00.000Z' };
    await expect(requireTenantContact(repoAnswering(deleted), 'c-1')).resolves.toBe(deleted);
  });

  it('throws TenantNotFoundError when the contact does not exist', async () => {
    await expect(requireTenantContact(repoAnswering(undefined), 'c-gone')).rejects.toBeInstanceOf(
      TenantNotFoundError,
    );
  });

  it.each([
    ['landlord', { type: 'landlord' }, 'landlord'],
    ['landlord whose role says Caseworker (still a landlord)', { type: 'landlord', role: 'Caseworker' }, 'landlord'],
    ['partner', { type: 'partner' }, 'partner'],
    ['team member', { type: 'team_member' }, 'team_member'],
    ['unknown contact (unknown is NOT a tenant)', { type: 'unknown' }, 'unknown'],
    ['caseworker (partner + Caseworker role)', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
    ['caseworker (role written case worker)', { type: 'partner', role: 'case worker' }, 'caseworker'],
  ] as const)('throws ContactNotTenantError for a %s, carrying contactKind', async (_label, fields, kind) => {
    const contact = { contactId: 'c-1', ...fields } as ContactItem;
    const err = await requireTenantContact(repoAnswering(contact), 'c-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe(kind);
  });
});

describe('requireLandlordContact (I3)', () => {
  it('reads the contact CONSISTENTLY and returns a contact typed landlord', async () => {
    const landlord: ContactItem = { contactId: 'l-1', type: 'landlord' };
    const repo = repoAnswering(landlord);
    await expect(requireLandlordContact(repo, 'l-1')).resolves.toBe(landlord);
    expect(repo.getById).toHaveBeenCalledWith('l-1', { consistentRead: true });
  });

  it('a property manager is a landlord with a role, so it passes', async () => {
    const pm = { contactId: 'l-1', type: 'landlord', role: 'Property Manager' } as ContactItem;
    await expect(requireLandlordContact(repoAnswering(pm), 'l-1')).resolves.toBe(pm);
  });

  it('throws LandlordNotFoundError when the contact does not exist', async () => {
    await expect(requireLandlordContact(repoAnswering(undefined), 'l-gone')).rejects.toBeInstanceOf(
      LandlordNotFoundError,
    );
  });

  it.each([
    ['tenant', { type: 'tenant' }],
    ['partner', { type: 'partner' }],
    ['team member', { type: 'team_member' }],
    ['unknown contact', { type: 'unknown' }],
    ['caseworker', { type: 'partner', role: 'Caseworker' }],
  ] as const)('throws LandlordNotLandlordError for a %s', async (_label, fields) => {
    const contact = { contactId: 'l-1', ...fields } as ContactItem;
    await expect(requireLandlordContact(repoAnswering(contact), 'l-1')).rejects.toBeInstanceOf(
      LandlordNotLandlordError,
    );
  });
});

describe('sendContactTypeError', () => {
  it.each([
    ['TenantNotFoundError', () => new TenantNotFoundError(), 404, { error: 'tenant_not_found' }],
    [
      'ContactNotTenantError',
      () => new ContactNotTenantError('caseworker'),
      409,
      { error: 'contact_not_tenant', contactKind: 'caseworker' },
    ],
    ['LandlordNotFoundError', () => new LandlordNotFoundError(), 404, { error: 'landlord_not_found' }],
    ['LandlordNotLandlordError', () => new LandlordNotLandlordError(), 409, { error: 'landlord_not_landlord' }],
  ] as const)('answers %s and reports it handled', (_label, make, status, body) => {
    const { res, sent } = recordingResponse();
    expect(sendContactTypeError(make(), res)).toBe(true);
    expect(sent).toEqual({ status, body });
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'contact_not_tenant'],
    ['undefined', undefined],
  ])('returns false for %s and writes nothing', (_label, err) => {
    const { res, sent } = recordingResponse();
    expect(sendContactTypeError(err, res)).toBe(false);
    expect(sent).toEqual({});
  });

  it('the errors carry no ids or names - their messages are the codes', () => {
    expect(new TenantNotFoundError().message).toBe('tenant_not_found');
    expect(new ContactNotTenantError('landlord').message).toBe('contact_not_tenant');
    expect(new LandlordNotFoundError().message).toBe('landlord_not_found');
    expect(new LandlordNotLandlordError().message).toBe('landlord_not_landlord');
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTypeGuards.test.ts
```

RED: the file fails to load - `Failed to resolve import "../src/services/contactTypeGuards.js"` (the module does not exist yet), so every case fails.

### Step 3 - implementation

Write `app/src/services/contactTypeGuards.ts`:

```ts
// Contact-type guards (caseworker integrity, spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md, sections 1
// and 4). The reads behind two invariants:
//   I2 - the tenant of an open tour or an open placement is a contact typed
//        `tenant` (requireTenantContact: tour create / revive / reopen,
//        placement create / from-tour, a placement leaving a terminal stage);
//   I3 - a live unit's landlord of record is a contact typed `landlord` (a
//        property manager is a landlord with a role) (requireLandlordContact:
//        the unit routes);
// and the ONE mapping from their four errors to HTTP answers
// (sendContactTypeError), so every route answers the same bodies.
//
// Every read here is CONSISTENT, so a type change that just committed is seen.
// "Exists" keeps getById's meaning: a soft-deleted contact still exists (this
// branch adds no deleted-contact refusal, spec section 10). The checks are
// reads before writes, not atomic with them (spec section 6, L1).
//
// PII (doc section 9): the errors carry no ids and no names. contactKind is a
// type word: `caseworker` when isCaseworker holds, else the stored type.
import type { Response } from 'express';
import { contactKind as kindOf } from '../lib/caseworkers.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';

/** The named tenant contact does not exist -> 404 { error: 'tenant_not_found' }. */
export class TenantNotFoundError extends Error {
  constructor() {
    super('tenant_not_found');
    this.name = 'TenantNotFoundError';
  }
}

/** The named tenant is not typed `tenant` -> 409 { error: 'contact_not_tenant', contactKind }. */
export class ContactNotTenantError extends Error {
  constructor(readonly contactKind: string) {
    super('contact_not_tenant');
    this.name = 'ContactNotTenantError';
  }
}

/** The named landlord contact does not exist -> 404 { error: 'landlord_not_found' }. */
export class LandlordNotFoundError extends Error {
  constructor() {
    super('landlord_not_found');
    this.name = 'LandlordNotFoundError';
  }
}

/** The named landlord is not typed `landlord` -> 409 { error: 'landlord_not_landlord' }. */
export class LandlordNotLandlordError extends Error {
  constructor() {
    super('landlord_not_landlord');
    this.name = 'LandlordNotLandlordError';
  }
}

/**
 * I2: the contact a tour or placement names as its tenant, read CONSISTENTLY.
 * Throws TenantNotFoundError when it does not exist and ContactNotTenantError
 * (carrying contactKind) when it is not typed `tenant`. `unknown` is NOT a
 * tenant (Cameron, 2026-10-12).
 */
export async function requireTenantContact(
  contacts: Pick<ContactsRepo, 'getById'>,
  contactId: string,
): Promise<ContactItem> {
  const contact = await contacts.getById(contactId, { consistentRead: true });
  if (contact === undefined) throw new TenantNotFoundError();
  if (contact.type !== 'tenant') throw new ContactNotTenantError(kindOf(contact));
  return contact;
}

/**
 * I3: the contact a unit names as its landlord of record, read CONSISTENTLY.
 * Throws LandlordNotFoundError when it does not exist and
 * LandlordNotLandlordError when it is not typed `landlord`.
 */
export async function requireLandlordContact(
  contacts: Pick<ContactsRepo, 'getById'>,
  contactId: string,
): Promise<ContactItem> {
  const contact = await contacts.getById(contactId, { consistentRead: true });
  if (contact === undefined) throw new LandlordNotFoundError();
  if (contact.type !== 'landlord') throw new LandlordNotLandlordError();
  return contact;
}

/**
 * Write the HTTP answer for one of the four errors above and return true;
 * return false (writing nothing) for anything else, so the caller rethrows.
 */
export function sendContactTypeError(err: unknown, res: Response): boolean {
  if (err instanceof TenantNotFoundError) {
    res.status(404).json({ error: 'tenant_not_found' });
    return true;
  }
  if (err instanceof ContactNotTenantError) {
    res.status(409).json({ error: 'contact_not_tenant', contactKind: err.contactKind });
    return true;
  }
  if (err instanceof LandlordNotFoundError) {
    res.status(404).json({ error: 'landlord_not_found' });
    return true;
  }
  if (err instanceof LandlordNotLandlordError) {
    res.status(409).json({ error: 'landlord_not_landlord' });
    return true;
  }
  return false;
}
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTypeGuards.test.ts
```

All cases pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/src/services/contactTypeGuards.ts" | wc -c
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/contactTypeGuards.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/services/contactTypeGuards.ts app/test/contactTypeGuards.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(contacts): contactTypeGuards - consistent tenant/landlord reads and their HTTP answers (I2/I3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Both `wc -c` print 0.

---

## Task 3.2 - W3 sweep: existing tests that create or reopen tours for a contact that is not a typed tenant

Goal: before any route starts refusing, give every existing test fixture a
correctly typed tenant (W3: fix the fixture, never weaken the rule). Every
change here is green on unchanged code; the task's RED is the toursApi
fixture's own pin.

### The sweep (app/test and e2e/, read 2026-10-12)

Needs a fix (would be refused after Tasks 3.3 / 3.5):

| File | What it does today | Fix (this task) |
|---|---|---|
| `app/test/toursApi.test.ts` | 113 test blocks post `/api/tours` for a tenant id never put in the world: `contact-tenant-1` (`BASE_CREATE_BODY`, both local `createTour` helpers), `t`, `tenant-A`, `tenant-B`, `tenant-a`, `tenant-b`, `tenant-c`, `tenant-regression`, `tenant-log-1`, `tenant-log-2`, `tenant-filter-a`, `contact-tenant-sched`, `contact-tenant-req`, `contact-tenant-req2`, `contact-req-to-sched`, `contact-req-cancel` (`tenant-req-gate` and `tenant-exit-gate` are already seeded typed). Its revive-from-canceled PATCHes run on those same POST-created tours. | File-local fixture (CONTRACT ISSUE 3): `authed().post('/api/tours').send(body)` first seeds `body.tenantId` as `{ type: 'tenant' }` when absent; pinned by two fixture tests. |
| `app/test/toursApi.test.ts` - `400 relay_member_unresolvable names each missing rung of the resolution ladder` | NEEDS the tenant to be missing for its first rung ("tenant contact not found") | Create its tour straight in the store (`world.toursRepo.create`) instead of through the route. |
| `app/test/toursReopenApi.test.ts` | `createTour(app)` posts `BASE_CREATE_BODY` (`contact-tenant-1`), seeded typed only in the one test that calls `seedTenantAndUnit`; 16 callers then reopen | `createTour(app, world)` seeds `TENANT` typed tenant when absent; the 16 call sites pass `world`. |
| `app/test/scheduledUpdatedEvent.test.ts` | 4 tests post `/api/tours` for an unseeded `contact-tenant-1` | Each pushes `{ contactId: 'contact-tenant-1', type: 'tenant' }` after its harness line. |

Checked, already typed tenant - no change: `devGating.test.ts`
(`contact-tick-tenant`), `placementsApi.test.ts` (`c-tenant`, `c-real`;
`ghost-tenant` is the existing 404 test), `placementConvert.test.ts`
(`seedTenantAndUnit`), `sse.test.ts` (`t-sse`), `unitsApi.test.ts` (tenant
made via `POST /api/contacts` with `type: 'tenant'`),
`transitionRoutes.test.ts` / `statusTransition.test.ts` (`tenant-1`; no move
out of a terminal stage anywhere; the landlord fixtures only use
`setTenantStatus`), `statusTransition.integration.test.ts` and
`seedHistory.test.ts` (typed tenant), and `contactVoucherSync.test.ts` (its
one `POST /api/placements`, `:82`, is for `tn-3`, created `type: 'tenant'` at
`:74-79` - added by plan review R1 row 9; the v1 record missed it). No other
app test posts `/api/tours`, `/api/placements`, `/from-tour`, `/reopen` or
`/transition`. Re-checked 2026-10-12 (bash, from the worktree root):

```
cd "W:/tmp/caseworker-integrity"; grep -rnE "['\`]/api/(tours|placements)['\`]|/from-tour|/reopen['\`]|/transition['\`]" app/test
```

Every hit is in a file named in this sweep (the three to fix, or one of the
checked files above) or is a comment (`seedMatrixCoherence.test.ts:574`,
`toursRepo.integration.test.ts:993`, `toursRepoFakeConditions.test.ts:342`).

e2e - no change: every API-created tour/placement uses
`createContact(req, 'tenant', ...)`, a `createConsentedTenant` helper
(`type: 'tenant'`) or `contact-tenant-0001` (lean seed, `type: 'tenant'`);
`lost-modal.spec.ts`, `placement-history.spec.ts` and
`placements-page.spec.ts` move `placement-0001` (tenant
`contact-tenant-0001`) out of `lost`, which stays allowed. Seeds are S5's
invariant test.

Files:
- `app/test/toursApi.test.ts`
- `app/test/toursReopenApi.test.ts`
- `app/test/scheduledUpdatedEvent.test.ts`

### Step 1 - failing test (the fixture pin)

Edit `app/test/toursApi.test.ts` - old_string:

```ts
const BASE_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  scheduledAt: '2026-07-15T10:00:00.000Z',
  tourType: 'self_guided',
};
```

new_string:

```ts
const BASE_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  scheduledAt: '2026-07-15T10:00:00.000Z',
  tourType: 'self_guided',
};

// The file's tenant fixture (see the note above authed()), pinned so a later
// edit cannot quietly drop it.
describe('fixture: a tour posted through authed() has a typed tenant', () => {
  it('seeds an absent tenantId as a contact typed tenant before the POST', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app)
      .post('/api/tours')
      .send({ ...BASE_CREATE_BODY, tenantId: 'fixture-tenant' });
    expect(res.status).toBe(201);
    expect(world.contacts.filter((c) => c.contactId === 'fixture-tenant')).toEqual([
      { contactId: 'fixture-tenant', type: 'tenant' },
    ]);
  });

  it('leaves a contact the test already seeded exactly as the test wrote it', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'fixture-tenant', type: 'tenant', phone: '+15550200077' });
    await authed(app)
      .post('/api/tours')
      .send({ ...BASE_CREATE_BODY, tenantId: 'fixture-tenant' });
    expect(world.contacts.filter((c) => c.contactId === 'fixture-tenant')).toEqual([
      { contactId: 'fixture-tenant', type: 'tenant', phone: '+15550200077' },
    ]);
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursApi.test.ts -t "fixture: a tour posted"
```

RED: `seeds an absent tenantId ...` fails - the filter returns `[]` (nothing seeds the tenant yet). The second case passes (PIN).

### Step 3 - implementation

3a. Edit `app/test/toursApi.test.ts` - old_string:

```ts
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
```

new_string:

```ts
import {
  createFakeWorld,
  makeWebhookHarness as makeBaseWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
```

3b. Edit `app/test/toursApi.test.ts` - old_string:

```ts
function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
```

new_string:

```ts
// THE TENANT FIXTURE (caseworker integrity I2, spec 2026-10-12 section 4):
// POST /api/tours reads the tenant and refuses a missing one (404
// tenant_not_found) or one not typed tenant (409 contact_not_tenant). Most
// tests in this file post tours for a tenant id they never put in the world,
// so every harness built here records its world, and a POST /api/tours sent
// through authed() first adds the posted tenantId to that world as a contact
// typed `tenant` - UNLESS the test already put a contact with that id there,
// which is then used exactly as the test wrote it (a non-tenant is refused,
// as in production). The rule's own tests live in
// toursCreateContactType.test.ts, which has no such fixture.
const harnessWorlds = new WeakMap<object, FakeWorld>();

function makeWebhookHarness(
  opts?: Parameters<typeof makeBaseWebhookHarness>[0],
): ReturnType<typeof makeBaseWebhookHarness> {
  const harness = makeBaseWebhookHarness(opts);
  harnessWorlds.set(harness.app, harness.world);
  return harness;
}

/** Put the posted tenantId in the app's world as a typed tenant when absent. */
function seedPostedTenant(app: object, body: unknown): void {
  const world = harnessWorlds.get(app);
  if (world === undefined || typeof body !== 'object' || body === null) return;
  const tenantId = (body as { tenantId?: unknown }).tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return;
  if (world.contacts.some((c) => c.contactId === tenantId)) return;
  world.contacts.push({ contactId: tenantId, type: 'tenant' });
}

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) => {
      const req = request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      if (path !== '/api/tours') return req;
      // Seed at SEND time, after whatever the test itself put in the world.
      const send = req.send.bind(req);
      req.send = (data?: string | object) => {
        seedPostedTenant(app, data);
        return send(data);
      };
      return req;
    },
```

3c. Edit `app/test/toursApi.test.ts` - old_string:

```ts
  it('400 relay_member_unresolvable names each missing rung of the resolution ladder', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
```

new_string:

```ts
  it('400 relay_member_unresolvable names each missing rung of the resolution ladder', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    // Created straight in the store, NOT through POST /api/tours: the route
    // refuses a tenant that does not exist (caseworker integrity I2), and this
    // test's first rung needs exactly that missing tenant.
    const tourId = (
      await world.toursRepo.create({
        tenantId: BASE_CREATE_BODY.tenantId,
        unitId: BASE_CREATE_BODY.unitId,
        tourType: 'self_guided',
        scheduledAt: BASE_CREATE_BODY.scheduledAt,
      })
    ).tourId;
```

3d. Edit `app/test/toursReopenApi.test.ts` - old_string:

```ts
async function createTour(app: App): Promise<string> {
  const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
```

new_string:

```ts
async function createTour(app: App, world: FakeWorld): Promise<string> {
  // Caseworker integrity I2: POST /api/tours refuses a missing tenant (404)
  // and a contact not typed tenant (409), and so does the reopen. TENANT is
  // put in the world as a typed tenant first - unless the test already seeded
  // it (seedTenantAndUnit), which is then used as the test wrote it.
  if (!world.contacts.some((c) => c.contactId === TENANT)) {
    world.contacts.push({ contactId: TENANT, type: 'tenant' });
  }
  const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
```

3e. Edit `app/test/toursReopenApi.test.ts` with `replace_all: true` - old_string `await createTour(app);` new_string `await createTour(app, world);` (16 occurrences; every caller already destructures `world`).

3f. Edit `app/test/scheduledUpdatedEvent.test.ts` four times - each old_string is the test line plus its harness line, each new_string appends the seed:

old_string:
```ts
  it('emits { contactId: tenantId } when a tour is booked with a time', async () => {
    const { app, world } = makeWebhookHarness();
```
new_string:
```ts
  it('emits { contactId: tenantId } when a tour is booked with a time', async () => {
    const { app, world } = makeWebhookHarness();
    // Caseworker integrity I2: POST /api/tours needs a contact typed tenant.
    world.contacts.push({ contactId: 'contact-tenant-1', type: 'tenant' });
```

old_string:
```ts
  it('does NOT emit on a timeless (requested) create', async () => {
    const { app, world } = makeWebhookHarness();
```
new_string:
```ts
  it('does NOT emit on a timeless (requested) create', async () => {
    const { app, world } = makeWebhookHarness();
    // Caseworker integrity I2: POST /api/tours needs a contact typed tenant.
    world.contacts.push({ contactId: 'contact-tenant-1', type: 'tenant' });
```

old_string:
```ts
  it('emits on reschedule (PATCH scheduledAt)', async () => {
    const { app, world } = makeWebhookHarness();
```
new_string:
```ts
  it('emits on reschedule (PATCH scheduledAt)', async () => {
    const { app, world } = makeWebhookHarness();
    // Caseworker integrity I2: POST /api/tours needs a contact typed tenant.
    world.contacts.push({ contactId: 'contact-tenant-1', type: 'tenant' });
```

old_string:
```ts
  it('emits on cancel (PATCH status=canceled)', async () => {
    const { app, world } = makeWebhookHarness();
```
new_string:
```ts
  it('emits on cancel (PATCH status=canceled)', async () => {
    const { app, world } = makeWebhookHarness();
    // Caseworker integrity I2: POST /api/tours needs a contact typed tenant.
    world.contacts.push({ contactId: 'contact-tenant-1', type: 'tenant' });
```

### Step 4 - GREEN (unchanged route code; every swept file stays green)

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursApi.test.ts test/toursReopenApi.test.ts test/scheduledUpdatedEvent.test.ts
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

All pass. If any toursApi test now fails, it depended on a MISSING tenant
(like 3c): STOP, record it in the slice report and rework it the 3c way
(create the tour in the store) - never by loosening the fixture.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/test/toursApi.test.ts app/test/toursReopenApi.test.ts app/test/scheduledUpdatedEvent.test.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/test/toursApi.test.ts app/test/toursReopenApi.test.ts app/test/scheduledUpdatedEvent.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "test(tours): type the tenant of every API-created tour fixture before I2 refuses non-tenants (W3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The grep prints nothing.

---

## Task 3.3 - `POST /api/tours` refuses a missing or non-tenant contact

Goal: spec section 4 row 1: 404 `tenant_not_found` when missing; 409
`{ error: 'contact_not_tenant', contactKind }` when not typed `tenant`;
CONSISTENT read after body validation, before any write.

Files:
- `app/src/routes/tours.ts`
- `app/test/toursCreateContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/toursCreateContactType.test.ts`:

```ts
// POST /api/tours - the tenant check (caseworker integrity spec 2026-10-12,
// section 4, I2). A tour's tenant must exist (404 tenant_not_found) and be a
// contact typed `tenant` (409 { error: 'contact_not_tenant', contactKind });
// the read is CONSISTENT and runs after the body validation and before any
// write. Harness world fakes (no DynamoDB). Deliberately NOT toursApi.test.ts:
// that file seeds a typed tenant for every tour it posts.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const SUBJECT = 'c-subject';
const BODY = {
  tenantId: SUBJECT,
  unitId: 'unit-abc',
  scheduledAt: '2030-06-01T15:00:00.000Z',
  tourType: 'self_guided',
};

const createTour = (app: App, body: object) =>
  request(app)
    .post('/api/tours')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function harness(): { app: App; world: FakeWorld } {
  const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
  return { app, world };
}

function seedContact(world: FakeWorld, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A refused create leaves nothing: no tour, no reminder row, no emit, no milestone. */
function expectNothingWritten(world: FakeWorld): void {
  expect(world.toursMap.size).toBe(0);
  expect(world.tourRemindersMap.size).toBe(0);
  expect(world.emitted.filter((e) => e.event === 'scheduled.updated' || e.event === 'tour.updated')).toEqual([]);
  expect(world.activityEvents.filter((e) => e.type === 'tour_scheduled')).toEqual([]);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['partner', { type: 'partner' }, 'partner'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/tours - the tenant must be a tenant (I2)', () => {
  it('creates the tour for a contact typed tenant, reading it CONSISTENTLY', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await createTour(app, BODY);

    expect(res.status).toBe(201);
    expect(res.body.tour).toMatchObject({ tenantId: SUBJECT, status: 'scheduled' });
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('404 tenant_not_found when the contact does not exist - nothing written', async () => {
    const { app, world } = harness();

    const res = await createTour(app, BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectNothingWritten(world);
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - nothing written', async (_label, fields, kind) => {
    const { app, world } = harness();
    seedContact(world, fields);

    const res = await createTour(app, BODY);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectNothingWritten(world);
  });

  it('a timeless (requested) create is checked the same way', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });

    const res = await createTour(app, { tenantId: SUBJECT, unitId: 'unit-abc', tourType: 'self_guided' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectNothingWritten(world);
  });

  it('(PIN) body validation answers first: a bad tourType for a missing contact is 400, not 404', async () => {
    const { app, world } = harness();

    const res = await createTour(app, { ...BODY, tourType: 'bad_type' });

    expect(res.status).toBe(400);
    expectNothingWritten(world);
  });

  it('(PIN) a soft-deleted tenant still exists - no deleted-contact refusal (spec section 10)', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant', deleted_at: '2026-10-01T00:00:00.000Z' });

    const res = await createTour(app, BODY);

    expect(res.status).toBe(201);
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursCreateContactType.test.ts
```

RED: the route never reads the contact. The 404 case and the six 409 cases get 201 (a tour is created); the tenant case gets 201 but `getById` was never called with `{ consistentRead: true }`. The two PIN cases pass.

### Step 3 - implementation

3a. Edit `app/src/routes/tours.ts` - old_string:

```ts
import { loadConfig, type AppConfig } from '../lib/config.js';
```

new_string:

```ts
import { loadConfig, type AppConfig } from '../lib/config.js';
import { requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

3b. Edit `app/src/routes/tours.ts` - old_string:

```ts
    // Timeless create: OMIT scheduledAt entirely (never undefined/null) so the
```

new_string:

```ts
    // Caseworker integrity I2 (spec 2026-10-12 section 4): a tour's tenant is a
    // contact typed `tenant`. One CONSISTENT read after the body validation and
    // before any write: 404 tenant_not_found when the contact is gone, 409
    // { error: 'contact_not_tenant', contactKind } when it is not a tenant.
    try {
      await requireTenantContact(contacts, b['tenantId'] as string);
    } catch (err) {
      if (sendContactTypeError(err, res)) return;
      throw err;
    }

    // Timeless create: OMIT scheduledAt entirely (never undefined/null) so the
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursCreateContactType.test.ts test/toursApi.test.ts test/toursReopenApi.test.ts test/scheduledUpdatedEvent.test.ts test/devGating.test.ts
```

All pass (the swept fixtures from Task 3.2 now carry typed tenants).

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/toursCreateContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/tours.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/tours.ts app/test/toursCreateContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(tours): POST /api/tours refuses a missing (404) or non-tenant (409) contact (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.4 - Tour PATCH: reviving a canceled tour into an open status needs a tenant

Goal: spec section 4 row 2: when the CURRENT status is `canceled` and the
RESULTING status is open (`scheduled` via a new time alone or an explicit
status, `toured`, `no_show`), read the tenant consistently: 409
`contact_not_tenant` / 404 `tenant_not_found`. Open-to-open and into-closed
moves are not checked; the transition guards still answer first.

Files:
- `app/src/routes/tours.ts`
- `app/test/toursReviveContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/toursReviveContactType.test.ts`:

```ts
// PATCH /api/tours/:id - reviving a CANCELED tour (caseworker integrity spec
// 2026-10-12, section 4, I2). Moving a tour whose CURRENT status is canceled
// into an OPEN status - scheduled (a new time alone auto-advances, or an
// explicit status), toured, no_show - needs a contact typed `tenant`: 409
// { error: 'contact_not_tenant', contactKind }, 404 tenant_not_found when the
// contact is gone, read CONSISTENTLY, before the write. A move between open
// statuses, or into a closed one, is not checked, and the transition guards
// still answer first. Harness world fakes (no DynamoDB); tours are seeded
// straight into the store, since POST /api/tours itself refuses non-tenants.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { TourStatus } from '../src/lib/toursModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const AT = '2030-06-01T15:00:00.000Z';
const NEW_AT = '2030-06-02T15:00:00.000Z';
const SUBJECT = 'c-subject';

const patchTour = (app: App, tourId: string, body: object) =>
  request(app)
    .patch(`/api/tours/${tourId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function harness(): { app: App; world: FakeWorld } {
  const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
  return { app, world };
}

function seedContact(world: FakeWorld, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedTour(world: FakeWorld, status: TourStatus): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: 'unit-abc',
    tourType: 'self_guided',
    scheduledAt: AT,
    status,
  });
  return tour.tourId;
}

/** The refused PATCH left the tour canceled, armed nothing and emitted nothing. */
function expectUntouched(world: FakeWorld, tourId: string): void {
  expect(world.toursMap.get(tourId)?.status).toBe('canceled');
  expect([...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId)).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'tour.updated' || e.event === 'scheduled.updated')).toEqual([]);
}

const REVIVALS = [
  ['a new time alone (auto-advances to scheduled)', { scheduledAt: NEW_AT }, 'scheduled'],
  ['status scheduled', { status: 'scheduled' }, 'scheduled'],
  ['status toured', { status: 'toured' }, 'toured'],
  ['status no_show', { status: 'no_show' }, 'no_show'],
] as const;

describe('PATCH /api/tours/:id - reviving a canceled tour needs a tenant (I2)', () => {
  it.each(REVIVALS)('%s: 409 contact_not_tenant for a landlord, nothing written', async (_label, body) => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, body);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectUntouched(world, tourId);
  });

  it.each(REVIVALS)('%s: allowed for a tenant, read CONSISTENTLY', async (_label, body, status) => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const tourId = await seedTour(world, 'canceled');
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await patchTour(app, tourId, body);

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe(status);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'partner', role: 'Caseworker' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { scheduledAt: NEW_AT });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
    expectUntouched(world, tourId);
  });

  it('404 tenant_not_found when the contact is gone - nothing written', async () => {
    const { app, world } = harness();
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'scheduled' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectUntouched(world, tourId);
  });
});

describe('PATCH /api/tours/:id - what the revival check does NOT cover', () => {
  it('(PIN) a move between open statuses is not checked: scheduled -> toured for a landlord', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'scheduled');

    const res = await patchTour(app, tourId, { status: 'toured' });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('toured');
  });

  it('(PIN) no_show -> scheduled (a reschedule between open statuses) is not checked', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'no_show');

    const res = await patchTour(app, tourId, { scheduledAt: NEW_AT });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('scheduled');
  });

  it('(PIN) a move into a closed status is not checked: scheduled -> canceled for a landlord', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'scheduled');

    const res = await patchTour(app, tourId, { status: 'canceled' });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('canceled');
  });

  it('(PIN) restating canceled on a canceled tour is not checked', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'canceled' });

    expect(res.status).toBe(200);
  });

  it('(PIN) the transition guard answers first: canceled -> requested is 409 illegal_status_transition', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'requested' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('illegal_status_transition');
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursReviveContactType.test.ts
```

RED: no revival check exists. The four landlord revivals, the caseworker case and the missing-contact case all get 200 (the tour is revived); the four tenant revivals get 200 but `getById` was never called with `{ consistentRead: true }`. The five PIN cases pass.

### Step 3 - implementation

3a. Edit `app/src/routes/tours.ts` - old_string:

```ts
import { requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

new_string:

```ts
import { OPEN_TOUR_STATUSES } from '../services/contactHoldings.js';
import { requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

3b. Edit `app/src/routes/tours.ts` - old_string:

```ts
    const rotation = randomUUID();
    if ((armable && rearmTrigger) || terminal) patch['currentLadderId'] = rotation;
```

new_string:

```ts
    const rotation = randomUUID();
    if ((armable && rearmTrigger) || terminal) patch['currentLadderId'] = rotation;

    // Caseworker integrity I2 (spec 2026-10-12 section 4): REVIVING a canceled
    // tour - into scheduled (a new time alone auto-advances, or an explicit
    // status), toured or no_show - needs a contact typed `tenant`. A move
    // between open statuses, or into a closed one, is not checked. The
    // transition guards above have already answered; no write or side effect
    // has run yet.
    if (currentStatus === 'canceled' && OPEN_TOUR_STATUSES.has(effectiveStatus)) {
      try {
        await requireTenantContact(contacts, current.tenantId);
      } catch (err) {
        if (sendContactTypeError(err, res)) return;
        throw err;
      }
    }
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursReviveContactType.test.ts test/toursApi.test.ts test/scheduledUpdatedEvent.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/toursReviveContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/tours.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/tours.ts app/test/toursReviveContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(tours): reviving a canceled tour into an open status needs a tenant (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.5 - `POST /api/tours/:id/reopen` needs a tenant

Goal: spec section 4 row 3. Every reopen target (`reopenTargetFor`,
`toursModel.ts:253-259`: scheduled / toured / no_show) is open, so after the
reopen decision and before `reopenIf`, read the tenant consistently.

Files:
- `app/src/routes/tours.ts`
- `app/test/toursReopenContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/toursReopenContactType.test.ts`:

```ts
// POST /api/tours/:id/reopen - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). Every reopen target (scheduled / toured /
// no_show) is an OPEN status, so a reopen needs a contact typed `tenant`: 409
// { error: 'contact_not_tenant', contactKind }, 404 tenant_not_found when the
// contact is gone, read CONSISTENTLY after the reopen decision and before the
// conditional write. Harness world fakes (no DynamoDB); closed tours are
// seeded straight into the store.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const AT = '2030-04-01T15:00:00.000Z';
const SUBJECT = 'c-subject';

const reopen = (app: App, tourId: string) =>
  request(app)
    .post(`/api/tours/${tourId}/reopen`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({});

function harness(): { app: App; world: FakeWorld } {
  const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
  return { app, world };
}

function seedContact(world: FakeWorld, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedClosedTour(world: FakeWorld, closedFields: Partial<TourItem>): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: 'unit-abc',
    tourType: 'self_guided',
    scheduledAt: AT,
    status: 'closed',
    ...closedFields,
  });
  return tour.tourId;
}

/** The ways a tour comes to be closed, with the open status a reopen sends it to. */
const CLOSED_FROM = [
  ['a person decided not a fit', { outcome: 'not_a_fit', moveForward: false }, 'toured'],
  [
    'auto-closed from scheduled',
    { outcome: 'no_outcome', autoClosedAt: NOW, autoClosedFrom: 'scheduled' },
    'scheduled',
  ],
  ['auto-closed from no_show', { outcome: 'no_outcome', autoClosedAt: NOW, autoClosedFrom: 'no_show' }, 'no_show'],
] as const;

/** The refused reopen left the tour closed with its outcome, recorded nothing and emitted nothing. */
function expectStillClosed(world: FakeWorld, tourId: string, outcome: string): void {
  const stored = world.toursMap.get(tourId)!;
  expect(stored.status).toBe('closed');
  expect(stored.outcome).toBe(outcome);
  expect(world.auditEvents.filter((e) => e.event_type === 'tour_reopened')).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'tour.updated')).toEqual([]);
}

describe('POST /api/tours/:id/reopen - the tenant must be a tenant (I2)', () => {
  it.each(CLOSED_FROM)('%s: reopens for a tenant, read CONSISTENTLY', async (_label, closed, target) => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const tourId = await seedClosedTour(world, closed);
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await reopen(app, tourId);

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe(target);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it.each(CLOSED_FROM)('%s: 409 contact_not_tenant for a landlord, the tour stays closed', async (_label, closed) => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedClosedTour(world, closed);

    const res = await reopen(app, tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectStillClosed(world, tourId, closed.outcome);
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'partner', role: 'Caseworker' });
    const tourId = await seedClosedTour(world, { outcome: 'not_a_fit', moveForward: false });

    const res = await reopen(app, tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
    expectStillClosed(world, tourId, 'not_a_fit');
  });

  it('404 tenant_not_found when the contact is gone - the tour stays closed', async () => {
    const { app, world } = harness();
    const tourId = await seedClosedTour(world, { outcome: 'not_a_fit', moveForward: false });

    const res = await reopen(app, tourId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectStillClosed(world, tourId, 'not_a_fit');
  });

  it('(PIN) a tour that cannot reopen answers that first: a scheduled tour of a landlord is 409 tour_not_closed', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tour = await world.toursRepo.create({
      tenantId: SUBJECT,
      unitId: 'unit-abc',
      tourType: 'self_guided',
      scheduledAt: AT,
      status: 'scheduled',
    });

    const res = await reopen(app, tour.tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_not_closed' });
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursReopenContactType.test.ts
```

RED: the reopen route never reads the contact. The three landlord cases, the caseworker case and the missing-contact case get 200 (the tour reopens); the three tenant cases get 200 but `getById` was never called with `{ consistentRead: true }`. The PIN passes.

### Step 3 - implementation

Edit `app/src/routes/tours.ts` - old_string:

```ts
    const reopened = await tours.reopenIf(current, decision.target, getNow());
```

new_string:

```ts
    // Caseworker integrity I2 (spec 2026-10-12 section 4): every reopen target
    // (scheduled / toured / no_show) is an OPEN status, so the tenant must be a
    // contact typed `tenant`. After the reopen decision (a tour that cannot
    // reopen answers that first), before the conditional write.
    try {
      await requireTenantContact(contacts, current.tenantId);
    } catch (err) {
      if (sendContactTypeError(err, res)) return;
      throw err;
    }
    const reopened = await tours.reopenIf(current, decision.target, getNow());
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/toursReopenContactType.test.ts test/toursReopenApi.test.ts
```

All pass (`toursReopenApi.test.ts` seeds its tenant since Task 3.2).

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/toursReopenContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/tours.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/tours.ts app/test/toursReopenContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(tours): reopening a closed tour needs a tenant (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.6 - `POST /api/placements` adds 409 `contact_not_tenant`

Goal: spec section 4 row 4: keep 404 `tenant_not_found`, add 409 for a
non-tenant (any starting stage), CONSISTENT read, still before the unit check.

Files:
- `app/src/routes/placements.ts`
- `app/test/placementsCreateContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/placementsCreateContactType.test.ts`:

```ts
// POST /api/placements - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). The existing 404 tenant_not_found stays; a
// contact that exists but is not typed `tenant` is refused 409
// { error: 'contact_not_tenant', contactKind } - for ANY starting stage -
// before the unit check and before any write. The read is CONSISTENT.
// Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-p1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-p1', status: 'available' });
});

const createPlacement = (body: object) =>
  request(app)
    .post('/api/placements')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A refused create persists nothing, audits nothing and emits nothing. */
function expectNothingWritten(): void {
  expect(world.placements.size).toBe(0);
  expect(world.auditEvents.filter((a) => a.event_type === 'placement_created')).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'placement.updated')).toEqual([]);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['partner', { type: 'partner' }, 'partner'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/placements - the tenant must be a tenant (I2)', () => {
  it('opens a placement for a contact typed tenant, reading it CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(201);
    expect(res.body.placement.tenantId).toBe(SUBJECT);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('(PIN) 404 tenant_not_found when the contact does not exist - nothing written', async () => {
    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectNothingWritten();
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - nothing written', async (_label, fields, kind) => {
    seedContact(fields);

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectNothingWritten();
  });

  it('refused for any starting stage, a terminal one included', async () => {
    seedContact({ type: 'landlord' });

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT, stage: 'lost' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectNothingWritten();
  });

  it('the tenant check answers before the unit check (a non-tenant on a missing unit is 409)', async () => {
    seedContact({ type: 'landlord' });

    const res = await createPlacement({ tenantId: SUBJECT, unitId: 'unit-ghost' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_not_tenant');
    expectNothingWritten();
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/placementsCreateContactType.test.ts
```

RED: today the route checks existence only (eventually consistent). The five non-tenant cases and the `lost` case get 201; the unit-order case gets 404 `unit_not_found`; the tenant case gets 201 but no `getById` call carried `{ consistentRead: true }`. The 404 PIN passes.

### Step 3 - implementation

3a. Edit `app/src/routes/placements.ts` - old_string:

```ts
import { recordPersonMilestone } from '../lib/personEvents.js';
```

new_string:

```ts
import { recordPersonMilestone } from '../lib/personEvents.js';
import { requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

3b. Edit `app/src/routes/placements.ts` - old_string:

```ts
    if (!(await contacts.getById(validation.fields.tenantId))) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
```

new_string:

```ts
    // Caseworker integrity I2 (spec 2026-10-12 section 4): the tenant must
    // exist (404 tenant_not_found, as before) AND be a contact typed `tenant`
    // (409 { error: 'contact_not_tenant', contactKind }), whatever the starting
    // stage. One CONSISTENT read, before the unit check and any write.
    try {
      await requireTenantContact(contacts, validation.fields.tenantId);
    } catch (err) {
      if (sendContactTypeError(err, res)) return;
      throw err;
    }
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/placementsCreateContactType.test.ts test/placementsApi.test.ts test/sse.test.ts test/unitsApi.test.ts test/contactVoucherSync.test.ts
```

All pass (`contactVoucherSync.test.ts` posts `/api/placements` for a typed
tenant - Task 3.2's sweep, plan review R1 row 9).

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/placementsCreateContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/placements.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/placements.ts app/test/placementsCreateContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(placements): POST /api/placements refuses a non-tenant contact (409 contact_not_tenant, I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.7 - `POST /api/placements/from-tour` adds 409 `contact_not_tenant` before any write

Goal: spec section 4 row 5: the existing existence read becomes
`requireTenantContact`, still before the conversion claim.

Files:
- `app/src/routes/placements.ts`
- `app/test/placementsFromTourContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/placementsFromTourContactType.test.ts`:

```ts
// POST /api/placements/from-tour - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). The tour's tenant must still exist (404
// tenant_not_found, as before) AND be a contact typed `tenant` (409
// { error: 'contact_not_tenant', contactKind }), read CONSISTENTLY BEFORE the
// conversion claim - a refusal writes nothing: no claim, no placement, the
// tour untouched. Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-ft1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-ft1', status: 'available' });
});

const convert = (tourId: string) =>
  request(app)
    .post('/api/placements/from-tour')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ tourId });

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A toured tour whose exit gate said move forward (convertible). */
async function seedConvertibleTour(): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: UNIT,
    tourType: 'self_guided',
    scheduledAt: '2030-06-01T15:00:00.000Z',
    status: 'toured',
    outcome: 'move_forward',
    moveForward: true,
    convertible: true,
  });
  return tour.tourId;
}

/** Nothing claimed, nothing created: the tour is still toured and unconverted. */
function expectTourUntouched(tourId: string): void {
  const stored = world.toursMap.get(tourId)!;
  expect(stored.status).toBe('toured');
  expect(stored.convertedPlacementId).toBeUndefined();
  expect(world.placements.size).toBe(0);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/placements/from-tour - the tenant must be a tenant (I2)', () => {
  it('converts for a contact typed tenant, reading it CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const tourId = await seedConvertibleTour();
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await convert(tourId);

    expect(res.status).toBe(201);
    expect(res.body.placement.tenantId).toBe(SUBJECT);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - no claim, no placement', async (_label, fields, kind) => {
    seedContact(fields);
    const tourId = await seedConvertibleTour();

    const res = await convert(tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectTourUntouched(tourId);
  });

  it('(PIN) 404 tenant_not_found when the contact is gone - no claim, no placement', async () => {
    const tourId = await seedConvertibleTour();

    const res = await convert(tourId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectTourUntouched(tourId);
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/placementsFromTourContactType.test.ts
```

RED: today the route checks existence only. The four non-tenant cases get 201 (the tour converts, a placement is created); the tenant case gets 201 but no `getById` call carried `{ consistentRead: true }`. The 404 PIN passes.

### Step 3 - implementation

Edit `app/src/routes/placements.ts` - old_string:

```ts
    if (!(await contacts.getById(tour.tenantId))) {
      res.status(404).json({ error: 'tenant_not_found' });
      return;
    }
```

new_string:

```ts
    // Caseworker integrity I2 (spec 2026-10-12 section 4): the tour's tenant
    // must still exist (404 tenant_not_found, as before) AND be a contact typed
    // `tenant` (409 contact_not_tenant) - one CONSISTENT read, BEFORE the
    // conversion claim, so a refusal writes nothing.
    try {
      await requireTenantContact(contacts, tour.tenantId);
    } catch (err) {
      if (sendContactTypeError(err, res)) return;
      throw err;
    }
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/placementsFromTourContactType.test.ts test/placementConvert.test.ts test/toursReopenApi.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/placementsFromTourContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/placements.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/placements.ts app/test/placementsFromTourContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(placements): from-tour refuses a non-tenant contact before the conversion claim (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.8 - `transitionPlacement`: leaving a terminal stage needs a tenant

Goal: spec section 4 row 6: in the SERVICE (every caller covered), a move
from `moved_in` / `lost` to a non-terminal stage reads the tenant
consistently before any write and throws `ContactNotTenantError` /
`TenantNotFoundError`. Non-terminal to non-terminal, into a terminal stage
and terminal to terminal are not checked.

Files:
- `app/src/services/statusTransition.ts`
- `app/test/statusTransitionContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/statusTransitionContactType.test.ts`:

```ts
// transitionPlacement - a placement leaving a terminal stage needs a tenant
// (caseworker integrity spec 2026-10-12, section 4, I2). Moving a placement
// out of `moved_in` / `lost` into a non-terminal stage re-opens it, so the
// SERVICE reads its tenant CONSISTENTLY first and refuses - before any write -
// with ContactNotTenantError (carrying contactKind) or TenantNotFoundError.
// Moves between non-terminal stages, into a terminal stage, or between the two
// terminal stages are not checked. World fakes (no DynamoDB).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { PlacementStage } from '../src/lib/statusModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { ContactNotTenantError, TenantNotFoundError } from '../src/services/contactTypeGuards.js';
import {
  createStatusTransitionService,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let world: FakeWorld;
let svc: StatusTransitionService;

beforeEach(async () => {
  world = createFakeWorld();
  svc = createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedPlacement(stage: PlacementStage): Promise<string> {
  const placement = await world.placementsRepo.create({ tenantId: SUBJECT, unitId: UNIT, stage });
  return placement.placementId;
}

function stageChangedRows(): unknown[] {
  return world.auditEvents.filter((a) => a.event_type === 'placement_stage_changed');
}

const EXITS = [
  ['lost', 'send_application'],
  ['lost', 'awaiting_inspection'],
  ['moved_in', 'awaiting_move_in'],
] as const;

describe('transitionPlacement - leaving a terminal stage needs a tenant (I2)', () => {
  it.each(EXITS)('%s -> %s for a landlord: ContactNotTenantError, nothing written', async (from, to) => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement(from);

    const err = await svc.transitionPlacement(id, { toStage: to, source: 'manual' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe('landlord');
    expect(world.placements.get(id)!.stage).toBe(from);
    expect(stageChangedRows()).toEqual([]);
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    seedContact({ type: 'partner', role: 'Caseworker' });
    const id = await seedPlacement('lost');

    const err = await svc
      .transitionPlacement(id, { toStage: 'send_application', source: 'manual' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe('caseworker');
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('a missing tenant throws TenantNotFoundError and writes nothing', async () => {
    const id = await seedPlacement('moved_in');

    await expect(
      svc.transitionPlacement(id, { toStage: 'awaiting_move_in', source: 'manual' }),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(world.placements.get(id)!.stage).toBe('moved_in');
    expect(stageChangedRows()).toEqual([]);
  });

  it('a tenant may leave lost - the tenant is read CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const id = await seedPlacement('lost');
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const updated = await svc.transitionPlacement(id, { toStage: 'send_application', source: 'manual' });

    expect(updated.stage).toBe('send_application');
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });
});

describe('transitionPlacement - moves the terminal-exit check does NOT cover', () => {
  it('(PIN) between non-terminal stages: a landlord placement still moves', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('send_application');

    const updated = await svc.transitionPlacement(id, { toStage: 'awaiting_approval', source: 'manual' });

    expect(updated.stage).toBe('awaiting_approval');
  });

  it('(PIN) into a terminal stage: a landlord placement can still be marked lost', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('collect_rta');

    const updated = await svc.transitionPlacement(id, { toStage: 'lost', source: 'manual' });

    expect(updated.stage).toBe('lost');
  });

  it('(PIN) between the two terminal stages: lost -> moved_in is not checked', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('lost');

    const updated = await svc.transitionPlacement(id, { toStage: 'moved_in', source: 'manual' });

    expect(updated.stage).toBe('moved_in');
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/statusTransitionContactType.test.ts
```

RED: the service never reads the tenant before a move. The three landlord exits, the caseworker case and the missing-tenant case resolve (the stage changes) instead of rejecting; the tenant case passes its stage check but `getById` was never called with `{ consistentRead: true }`. The three PINs pass.

### Step 3 - implementation

3a. Edit `app/src/services/statusTransition.ts` - old_string:

```ts
import { armRelayCloseNagIfOpen } from './relayCloseNag.js';
```

new_string:

```ts
import { armRelayCloseNagIfOpen } from './relayCloseNag.js';
import { requireTenantContact } from './contactTypeGuards.js';
```

3b. Edit `app/src/services/statusTransition.ts` - old_string:

```ts
      const from = existing.stage;
      const now = new Date().toISOString();
```

new_string:

```ts
      const from = existing.stage;
      // Caseworker integrity I2 (spec 2026-10-12 section 4): moving a placement
      // OUT of a terminal stage (moved_in / lost) into a non-terminal one
      // re-opens it, so its tenant must be a contact typed `tenant` - read
      // CONSISTENTLY here, before any write, so every caller of the service is
      // covered. Throws ContactNotTenantError / TenantNotFoundError (the route
      // maps them). Moves between non-terminal stages, into a terminal stage,
      // or between the two terminal stages are not checked. WHETHER a placement
      // may leave lost / moved_in at all is filed separately
      // (placement-terminal-stage-exit-unguarded), not decided here.
      if (TERMINAL_STAGES.has(from) && !TERMINAL_STAGES.has(toStage)) {
        await requireTenantContact(contactsRepo, existing.tenantId);
      }
      const now = new Date().toISOString();
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/statusTransitionContactType.test.ts test/statusTransition.test.ts test/transitionRoutes.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/statusTransitionContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/services/statusTransition.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/services/statusTransition.ts app/test/statusTransitionContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(placements): a placement leaving lost/moved_in needs a tenant, checked in the transition service (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.9 - `handleTransitionError` maps the contact-type errors

Goal: spec section 4: the transition route answers 409
`{ error: 'contact_not_tenant', contactKind }` and 404 `tenant_not_found`
(today: 400 `{ error }` for refusals, anything else rethrown -> 500).

Files:
- `app/src/routes/statusTransition.ts`
- `app/test/transitionRoutesContactType.test.ts` (new)

### Step 1 - failing test

Write `app/test/transitionRoutesContactType.test.ts`:

```ts
// POST /api/placements/:id/transition - the route's answer when the service
// refuses a placement leaving a terminal stage (caseworker integrity spec
// 2026-10-12, section 4): handleTransitionError maps ContactNotTenantError to
// 409 { error: 'contact_not_tenant', contactKind } and TenantNotFoundError to
// 404 { error: 'tenant_not_found' }; its existing answers are unchanged.
// Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlacementStage } from '../src/lib/statusModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

const transition = (placementId: string, body: object) =>
  request(app)
    .post(`/api/placements/${placementId}/transition`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedPlacement(stage: PlacementStage): Promise<string> {
  const placement = await world.placementsRepo.create({ tenantId: SUBJECT, unitId: UNIT, stage });
  return placement.placementId;
}

describe('POST /api/placements/:id/transition - contact-type answers (I2)', () => {
  it('409 contact_not_tenant (with contactKind) for a landlord placement leaving lost; the stage stays', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('409 names a caseworker as caseworker', async () => {
    seedContact({ type: 'partner', role: 'Caseworker' });
    const id = await seedPlacement('moved_in');

    const res = await transition(id, { toStage: 'awaiting_move_in', source: 'manual' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
  });

  it('404 tenant_not_found when the tenant contact is gone', async () => {
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('(PIN) a tenant placement leaves lost (200)', async () => {
    seedContact({ type: 'tenant' });
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(200);
    expect(res.body.placement.stage).toBe('send_application');
  });

  it('(PIN) an unknown placement is still 404 placement_not_found', async () => {
    const res = await transition('placement-ghost', { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'placement_not_found' });
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/transitionRoutesContactType.test.ts
```

RED: since Task 3.8 the service throws the new errors, but `handleTransitionError` rethrows them, so the three refusal cases answer 500 `{ error: 'internal server error' }` instead of 409 / 404. The two PINs pass.

### Step 3 - implementation

3a. Edit `app/src/routes/statusTransition.ts` - old_string:

```ts
import { appEvents, type EventBus } from '../lib/events.js';
```

new_string:

```ts
import { appEvents, type EventBus } from '../lib/events.js';
import { sendContactTypeError } from '../services/contactTypeGuards.js';
```

3b. Edit `app/src/routes/statusTransition.ts` - old_string:

```ts
function handleTransitionError(err: unknown, res: import('express').Response): void {
  if (err instanceof EntityNotFoundError) {
```

new_string:

```ts
function handleTransitionError(err: unknown, res: import('express').Response): void {
  // Caseworker integrity I2 (spec 2026-10-12 section 4): transitionPlacement
  // refuses a placement leaving a terminal stage for a contact that is not a
  // tenant (409 { error: 'contact_not_tenant', contactKind }) or no longer
  // exists (404 tenant_not_found).
  if (sendContactTypeError(err, res)) return;
  if (err instanceof EntityNotFoundError) {
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/transitionRoutesContactType.test.ts test/transitionRoutes.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/transitionRoutesContactType.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/routes/statusTransition.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/routes/statusTransition.ts app/test/transitionRoutesContactType.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(placements): the transition route answers 409 contact_not_tenant / 404 tenant_not_found" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.10 - `deriveTenantStatus` skips a contact that is not typed tenant (W5)

Goal: spec section 4 "Derived tenant status": no status, no audit, no
milestone for a non-tenant; one info log line; listing-status derivation
unchanged (W5).

Files:
- `app/src/services/statusTransition.ts`
- `app/test/deriveTenantStatusSkip.test.ts` (new)

### Step 1 - failing test

Write `app/test/deriveTenantStatusSkip.test.ts`:

```ts
// deriveTenantStatus skips a contact that is not typed tenant (caseworker
// integrity spec 2026-10-12, section 4 "Derived tenant status"; plan watch
// item W5). A placement move derives the TENANT lifecycle only for a contact
// typed `tenant`: for anyone else nothing is written - no status, no audit
// row, no timeline milestone - and one info line says why. The PROPERTY's
// derived listing status is unchanged by this rule. Service on world fakes.
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createStatusTransitionService,
  type StatusTransitionService,
} from '../src/services/statusTransition.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SKIP_MSG = 'derivation: contact is not a tenant - tenant status left unchanged';
const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let world: FakeWorld;
let capture: LogCapture;
let svc: StatusTransitionService;

beforeEach(async () => {
  world = createFakeWorld();
  capture = createLogCapture();
  svc = createStatusTransitionService({
    placementsRepo: world.placementsRepo,
    placementDeadlinesRepo: world.placementDeadlinesRepo,
    unitsRepo: world.unitsRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    events: world.events,
    logger: createLogger({ level: 'info', destination: capture.stream }),
  });
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

function storedContact(): ContactItem {
  return world.contacts.find((c) => c.contactId === SUBJECT)!;
}

/** Nothing tenant-side was written for SUBJECT. */
function expectNoTenantWrite(status: string): void {
  expect(storedContact().status).toBe(status);
  expect(storedContact().status_source).toBeUndefined();
  expect(world.auditEvents.filter((a) => a.entityKey === `contacts#${SUBJECT}`)).toEqual([]);
  expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
}

function skipLines(): Record<string, unknown>[] {
  return capture.lines.filter((l) => l['msg'] === SKIP_MSG);
}

describe('deriveTenantStatus - only a tenant gets a derived tenant status', () => {
  it('a landlord placement moving between active stages: contact untouched, property still derived', async () => {
    seedContact({ type: 'landlord', status: 'interested' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'awaiting_approval', source: 'manual' });

    expectNoTenantWrite('interested');
    // W5: the listing-status derivation is unchanged.
    expect((await world.unitsRepo.getById(UNIT))!.status).toBe('under_application');
    expect(skipLines()).toHaveLength(1);
    expect(skipLines()[0]).toMatchObject({ level: 30, tenantId: SUBJECT, contactType: 'landlord' });
  });

  it('a caseworker (partner + Caseworker role) is skipped too', async () => {
    seedContact({ type: 'partner', role: 'Caseworker', status: 'active' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'collect_rta', source: 'manual' });

    expectNoTenantWrite('active');
    expect(skipLines()).toHaveLength(1);
  });

  it('derive-on-create (deriveForStage) skips a team member; the property is still derived', async () => {
    seedContact({ type: 'team_member', status: 'active' });

    await svc.deriveForStage(SUBJECT, UNIT, 'send_application');

    expectNoTenantWrite('active');
    expect((await world.unitsRepo.getById(UNIT))!.status).toBe('under_application');
    expect(skipLines()).toHaveLength(1);
  });

  it('the lost bounce skips the tenant side for a landlord and still frees the property', async () => {
    seedContact({ type: 'landlord', status: 'interested' });
    await world.unitsRepo.create({ unitId: 'unit-2', landlordId: 'll-1', status: 'under_application' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: 'unit-2',
      stage: 'collect_rta',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'lost', source: 'manual' });

    expectNoTenantWrite('interested');
    expect((await world.unitsRepo.getById('unit-2'))!.status).toBe('available');
  });

  it('(PIN) a tenant still derives: placing, with its audit row and no skip line', async () => {
    seedContact({ type: 'tenant', status: 'searching' });
    const placement = await world.placementsRepo.create({
      tenantId: SUBJECT,
      unitId: UNIT,
      stage: 'send_application',
    });

    await svc.transitionPlacement(placement.placementId, { toStage: 'awaiting_approval', source: 'manual' });

    expect(storedContact().status).toBe('placing');
    expect(world.auditEvents.filter((a) => a.event_type === 'tenant_status_changed')).toHaveLength(1);
    expect(skipLines()).toEqual([]);
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/deriveTenantStatusSkip.test.ts
```

RED: today the derivation writes `placing` (or `searching` on the lost bounce) onto any contact. The four skip cases fail: the stored status reads `placing` / `searching` instead of `interested` / `active`, a `tenant_status_changed` audit row exists for the contact, and no skip line was logged. The PIN passes.

### Step 3 - implementation

Edit `app/src/services/statusTransition.ts` - old_string:

```ts
      const contact = await contactsRepo.getById(tenantId);
      if (!contact) return;
      const current = contact.status as TenantStatus | undefined;
```

new_string:

```ts
      const contact = await contactsRepo.getById(tenantId);
      if (!contact) return;
      // Caseworker integrity (spec 2026-10-12 section 4, "Derived tenant
      // status"): the derived lifecycle is a TENANT's. A placement whose
      // contact is not typed tenant (a record from before the I2 checks, or a
      // contact re-typed since) writes nothing here - no status, no audit, no
      // milestone. The listing-status derivation is separate and unchanged.
      if (contact.type !== 'tenant') {
        log.info(
          { tenantId, contactType: contact.type },
          'derivation: contact is not a tenant - tenant status left unchanged',
        );
        return;
      }
      const current = contact.status as TenantStatus | undefined;
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/deriveTenantStatusSkip.test.ts test/statusTransition.test.ts test/transitionRoutes.test.ts test/placementConvert.test.ts test/placementsApi.test.ts test/unitsApi.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/app/test/deriveTenantStatusSkip.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" diff -U0 -- app/src/services/statusTransition.ts | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add app/src/services/statusTransition.ts app/test/deriveTenantStatusSkip.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "fix(placements): derived tenant status skips a contact that is not typed tenant; listing derivation unchanged (W5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.11 - dashboard `contactTypeErrors.ts`: the shared copy helper

Goal: `contactTypeErrorMessage(err): string | null` with the plan section 1
copy table (all five codes; S4 uses the landlord and contact-list codes);
`null` for anything else (W7). Fallback phrase per CONTRACT ISSUE 2.

Files:
- `dashboard/src/lib/contactTypeErrors.ts` (new)
- `dashboard/src/lib/contactTypeErrors.test.ts` (new)

### Step 1 - failing test

Write `dashboard/src/lib/contactTypeErrors.test.ts`:

```ts
// contactTypeErrorMessage - the dashboard copy for the contact-type refusals
// (caseworker integrity spec 2026-10-12, section 4; plan section 1 copy
// table). Every sentence is pinned verbatim; anything that is not one of the
// five codes answers null so each call site keeps its own fallback (W7).
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { contactTypeErrorMessage } from './contactTypeErrors.js';

function refusal(status: number, code: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, code, code, { error: code, ...extra });
}

describe('contactTypeErrorMessage', () => {
  it.each([
    ['tenant', 'Tours and placements are for tenants. This contact is a tenant.'],
    ['landlord', 'Tours and placements are for tenants. This contact is a landlord.'],
    ['partner', 'Tours and placements are for tenants. This contact is a partner.'],
    ['caseworker', 'Tours and placements are for tenants. This contact is a caseworker.'],
    ['team_member', 'Tours and placements are for tenants. This contact is a team member.'],
    ['unknown', 'Tours and placements are for tenants. This contact is not classified yet.'],
  ])('contact_not_tenant with contactKind %s', (kind, sentence) => {
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: kind }))).toBe(sentence);
  });

  it('contact_not_tenant with a missing or unrecognized contactKind still reads as a sentence', () => {
    const other = 'Tours and placements are for tenants. This contact is not a tenant.';
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant'))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 'robot' }))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 'toString' }))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 7 }))).toBe(other);
    expect(contactTypeErrorMessage(new ApiError(409, 'contact_not_tenant', 'contact_not_tenant'))).toBe(other);
  });

  it.each([
    ['tenant_not_found', 404, 'That contact no longer exists.'],
    ['landlord_not_landlord', 409, "Only a landlord can be a property's landlord of record."],
    ['landlord_not_found', 404, 'That landlord no longer exists.'],
    ['contact_list_caseworker', 409, "Caseworkers can't be on a property's contact list."],
  ])('%s', (code, status, sentence) => {
    expect(contactTypeErrorMessage(refusal(status, code))).toBe(sentence);
  });

  it.each([
    ['another 409 code (tour_changed)', refusal(409, 'tour_changed')],
    ['another 409 code (illegal_status_transition)', refusal(409, 'illegal_status_transition')],
    ['another 404 code (tour_not_found)', refusal(404, 'tour_not_found')],
    ['a 500', new ApiError(500, 'internal_error', 'internal_error')],
    ['a network failure', new ApiError(0, 'network_error', 'Network error')],
    ['a plain Error', new Error('contact_not_tenant')],
    ['a string', 'contact_not_tenant'],
    ['undefined', undefined],
  ])('returns null for %s (the site keeps its fallback)', (_label, err) => {
    expect(contactTypeErrorMessage(err)).toBeNull();
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/contactTypeErrors.test.ts
```

RED: the file fails to load - `Failed to resolve import "./contactTypeErrors.js"` (the module does not exist yet).

### Step 3 - implementation

Write `dashboard/src/lib/contactTypeErrors.ts`:

```ts
// contactTypeErrorMessage - the dashboard copy for the contact-type refusals
// (caseworker integrity, spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 4
// "Dashboard copy"; plan section 1 copy table). ONE helper, used at every
// tour, placement and property site that can meet these codes. It returns
// null for anything else, so each site keeps its own fallback copy (plan
// watch item W7). Staff audience: "property", never "listing" (GLOSSARY).
import { ApiError } from '../api/client.js';

/** contactKind (the server's `caseworker`, else the stored type) -> the phrase
 *  that ends the contact_not_tenant sentence (plan ruling P-1). A Map, so an
 *  inherited name such as `toString` never matches. */
const KIND_PHRASE: ReadonlyMap<string, string> = new Map([
  ['tenant', 'a tenant'],
  ['landlord', 'a landlord'],
  ['partner', 'a partner'],
  ['caseworker', 'a caseworker'],
  ['team_member', 'a team member'],
  ['unknown', 'not classified yet'],
]);

/** A missing or unrecognized contactKind (the server sends none today). */
const OTHER_KIND_PHRASE = 'not a tenant';

/** The sentence for a contact-type refusal, or null for any other failure. */
export function contactTypeErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'contact_not_tenant': {
      const body = err.body;
      const kind =
        body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['contactKind'] : undefined;
      const phrase = (typeof kind === 'string' ? KIND_PHRASE.get(kind) : undefined) ?? OTHER_KIND_PHRASE;
      return `Tours and placements are for tenants. This contact is ${phrase}.`;
    }
    case 'tenant_not_found':
      return 'That contact no longer exists.';
    case 'landlord_not_landlord':
      return "Only a landlord can be a property's landlord of record.";
    case 'landlord_not_found':
      return 'That landlord no longer exists.';
    case 'contact_list_caseworker':
      return "Caseworkers can't be on a property's contact list.";
    default:
      return null;
  }
}
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/contactTypeErrors.test.ts
```

All pass.

### Step 5 - ASCII + commit

```
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/dashboard/src/lib/contactTypeErrors.ts" | wc -c
tr -d '\11\12\15\40-\176' < "W:/tmp/caseworker-integrity/dashboard/src/lib/contactTypeErrors.test.ts" | wc -c
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/lib/contactTypeErrors.ts dashboard/src/lib/contactTypeErrors.test.ts
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): contactTypeErrorMessage - one copy helper for the contact-type refusals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.12 - TourDetail: status changes, Start placement and outcome-then-convert show the sentence

Goal: spec copy sites `TourDetail.tsx:382` (`runDirect`), `:514`
(`handleConvert`), `:589` (`confirmOutcome`'s from-tour) - all show
`err.message` today. Each consults `contactTypeErrorMessage` first; every
other error keeps today's copy (W7; existing tests `a FAILED Mark toured
surfaces the alert...`, `a convert failure surfaces role=alert...`,
`move-forward with a failing conversion...` stay green).

Files:
- `dashboard/src/routes/tours/TourDetail.tsx`
- `dashboard/src/routes/tours/TourDetail.test.tsx`

Lint baseline (plan review R1 row 3): `TourDetail.tsx` already carries ONE
pre-existing error at the merge base - `react-hooks/purity` on the
`Date.now()` in the `startPassed` computation (:341). It is baseline debt:
do NOT fix it in this task; this task's edits must add no other error
(section 0 "Lint at every slice gate"; checked at the S3 slice gate).

### Step 1 - failing test

Edit `dashboard/src/routes/tours/TourDetail.test.tsx` - old_string (the file's last lines):

```ts
      expect(screen.getByRole('link', { name: 'Back to tours' })).toHaveAttribute('href', '/tours');
    },
  );
});
```

new_string:

```ts
      expect(screen.getByRole('link', { name: 'Back to tours' })).toHaveAttribute('href', '/tours');
    },
  );
});

// Caseworker integrity (spec 2026-10-12 section 4, "Dashboard copy"): a
// contact-type refusal reads as a sentence at the page's three header-alert
// sites, never as the raw code err.message carries.
describe('TourDetail - contact-type refusals (caseworker integrity)', () => {
  function notTenant(contactKind: string): ApiError {
    return new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
      error: 'contact_not_tenant',
      contactKind,
    });
  }

  it('a status change refused as contact_not_tenant shows the sentence in the header alert', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockRejectedValue(notTenant('team_member'));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Mark toured' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tours and placements are for tenants. This contact is a team member.',
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('contact_not_tenant');
    expect(screen.queryByRole('form', { name: 'Record outcome form' })).not.toBeInTheDocument();
  });

  it('Start placement refused as contact_not_tenant shows the sentence and does not navigate', async () => {
    getTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockRejectedValue(notTenant('caseworker'));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getAllByRole('button', { name: 'Start placement' })[0]!);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tours and placements are for tenants. This contact is a caseworker.',
      ),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('move-forward whose conversion finds the contact gone says so (outcome saved, no navigation)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockRejectedValue(
      new ApiError(404, 'tenant_not_found', 'tenant_not_found', { error: 'tenant_not_found' }),
    );
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Yes - move forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That contact no longer exists.'));
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/TourDetail.test.tsx -t "contact-type refusals"
```

RED: all three show `err.message` today - the alert reads `contact_not_tenant` (twice) and `tenant_not_found`, not the sentences.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/tours/TourDetail.tsx` - old_string:

```ts
import { Button, Spinner, StatusBadge, useTwoPaneNarrow } from '../../ui/index.js';
```

new_string:

```ts
import { Button, Spinner, StatusBadge, useTwoPaneNarrow } from '../../ui/index.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

3b. Edit `dashboard/src/routes/tours/TourDetail.tsx` - old_string:

```ts
      setActionError(err instanceof ApiError ? err.message : failMsg);
```

new_string:

```ts
      setActionError(contactTypeErrorMessage(err) ?? (err instanceof ApiError ? err.message : failMsg));
```

3c. Edit `dashboard/src/routes/tours/TourDetail.tsx` - old_string:

```ts
      setActionError(err instanceof ApiError ? err.message : 'Failed to start placement');
```

new_string:

```ts
      setActionError(
        contactTypeErrorMessage(err) ?? (err instanceof ApiError ? err.message : 'Failed to start placement'),
      );
```

3d. Edit `dashboard/src/routes/tours/TourDetail.tsx` - old_string:

```ts
        setActionError(
          err instanceof ApiError ? err.message : 'Outcome saved, but starting the placement failed',
        );
```

new_string:

```ts
        setActionError(
          contactTypeErrorMessage(err) ??
            (err instanceof ApiError ? err.message : 'Outcome saved, but starting the placement failed'),
        );
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/TourDetail.test.tsx
```

All pass (the three W7 tests named above included).

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): tour page shows the contact-type sentence for status changes and starting a placement" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.13 - TourModals `failureCopy`: the Reschedule and Reopen dialogs show the sentence (CONTRACT ISSUE 1)

Goal: the dashboard's real revive (Reschedule on a canceled tour) and reopen
paths answer a contact-type refusal with its sentence instead of
`TOUR_CHANGED_COPY`. Every other 409 keeps the reload copy, every other
failure the dialog's own copy (W7; the existing `a 409 ApiError (any reopen
refusal) shows the reload copy...` and `any other rejection shows the
generic copy...` tests stay green).

Files:
- `dashboard/src/routes/tours/TourModals.tsx`
- `dashboard/src/routes/tours/TourModals.test.tsx`

### Step 1 - failing test

1a. Edit `dashboard/src/routes/tours/TourModals.test.tsx` - old_string:

```ts
import { render, screen, waitFor, within } from '@testing-library/react';
```

new_string:

```ts
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
```

1b. Edit `dashboard/src/routes/tours/TourModals.test.tsx` - old_string:

```ts
import { ReopenTourModal, TOUR_CHANGED_COPY, type RecordOutcomeModal } from './TourModals.js';
```

new_string:

```ts
import {
  ReopenTourModal,
  RescheduleTourModal,
  TOUR_CHANGED_COPY,
  type RecordOutcomeModal,
} from './TourModals.js';
```

1c. Edit `dashboard/src/routes/tours/TourModals.test.tsx` - old_string:

```ts
// `no_outcome` is written ONLY by the server's auto-close sweep (spec 9.1); a
```

new_string:

```ts
// Caseworker integrity (spec 2026-10-12 section 4): the Reschedule dialog is
// the dashboard's only way to revive a CANCELED tour and the Reopen dialog its
// only way out of closed - both refused with contact_not_tenant when the
// tour's contact is not a tenant. That refusal is not "the tour changed".
describe('Tour dialogs - contact-type refusals (caseworker integrity)', () => {
  const NOT_TENANT = 'Tours and placements are for tenants. This contact is a caseworker.';

  function notTenant(): ApiError {
    return new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
      error: 'contact_not_tenant',
      contactKind: 'caseworker',
    });
  }

  /** A datetime-local value two days from the real clock (never past, never past 14 days). */
  function inTwoDaysLocal(): string {
    const d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function submitReschedule(onConfirm: () => Promise<void>): Promise<{ onClose: () => void }> {
    const onClose = vi.fn();
    render(<RescheduleTourModal onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: inTwoDaysLocal() } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reschedule' }));
    return { onClose };
  }

  it('Reopen: a 409 contact_not_tenant shows the contact-type sentence, not the reload copy', async () => {
    const onConfirm = vi.fn().mockRejectedValue(notTenant());
    const { onClose } = renderReopen('toured', onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(NOT_TENANT);
    expect(screen.queryByText(CHANGED)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, reopen' })).toBeEnabled();
  });

  it('Reopen: a 404 tenant_not_found says the contact no longer exists', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValue(new ApiError(404, 'tenant_not_found', 'tenant_not_found', { error: 'tenant_not_found' }));
    renderReopen('scheduled', onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That contact no longer exists.');
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
  });

  it('Reschedule (reviving a canceled tour): a 409 contact_not_tenant shows the sentence; the dialog stays open', async () => {
    const onConfirm = vi.fn().mockRejectedValue(notTenant());
    const { onClose } = await submitReschedule(onConfirm);
    expect((await screen.findByRole('alert')).textContent).toBe(NOT_TENANT);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('form', { name: 'Reschedule tour form' })).toBeInTheDocument();
  });

  it('(PIN) Reschedule: any other 409 still shows the reload copy', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError(409, 'tour_changed', 'tour_changed'));
    await submitReschedule(onConfirm);
    expect((await screen.findByRole('alert')).textContent).toBe(CHANGED);
  });

  it('(PIN) Reopen: any other 409 still shows the reload copy', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError(409, 'tour_changed', 'tour_changed'));
    renderReopen('toured', onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
    expect((await screen.findByRole('alert')).textContent).toBe(CHANGED);
  });
});

// `no_outcome` is written ONLY by the server's auto-close sweep (spec 9.1); a
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/TourModals.test.tsx
```

RED: `failureCopy` maps every 409 to `TOUR_CHANGED_COPY`, so the Reopen and Reschedule `contact_not_tenant` cases read "This tour changed since the page loaded - reload and try again.", and the Reopen 404 case reads "Couldn't reopen the tour - please try again.". The two PINs pass.

(Coordinator addition, folded in here: the S5 writer's finding F1,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/S5-findings.md`,
asks for exactly this task - `failureCopy` returns `contactTypeErrorMessage(err)`
when non-null, BEFORE its 409 rule, with both dialogs unit-tested for the
sentence and for a plain 409 still reading `TOUR_CHANGED_COPY`.)

### Step 3 - implementation

3a. Edit `dashboard/src/routes/tours/TourModals.tsx` - old_string:

```ts
import { ApiError, type StaffTourOutcome } from '../../api/index.js';
```

new_string:

```ts
import { ApiError, type StaffTourOutcome } from '../../api/index.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

3b. Edit `dashboard/src/routes/tours/TourModals.tsx` - old_string:

```ts
/** A writing dialog's inline error for a failed onConfirm: any ApiError 409
 *  (illegal_status_transition, illegal_exit_gate, tour_changed, a reopen
 *  refusal) reads TOUR_CHANGED_COPY; anything else the dialog's own copy. */
function failureCopy(err: unknown, retryCopy: string): string {
  return err instanceof ApiError && err.status === 409 ? TOUR_CHANGED_COPY : retryCopy;
}
```

new_string:

```ts
/** A writing dialog's inline error for a failed onConfirm. A contact-type
 *  refusal (caseworker integrity: a canceled tour rescheduled, or a closed
 *  tour reopened, for a contact that is not a tenant or no longer exists)
 *  reads its own sentence; any other ApiError 409 (illegal_status_transition,
 *  illegal_exit_gate, tour_changed, a reopen refusal) reads TOUR_CHANGED_COPY;
 *  anything else the dialog's own copy. */
function failureCopy(err: unknown, retryCopy: string): string {
  const typeCopy = contactTypeErrorMessage(err);
  if (typeCopy !== null) return typeCopy;
  return err instanceof ApiError && err.status === 409 ? TOUR_CHANGED_COPY : retryCopy;
}
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/TourModals.test.tsx src/routes/tours/TourDetail.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/tours/TourModals.tsx dashboard/src/routes/tours/TourModals.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/tours/TourModals.tsx dashboard/src/routes/tours/TourModals.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): Reschedule and Reopen dialogs show the contact-type sentence, not 'this tour changed'" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.14 - ScheduleTourForm shows the sentence

Goal: spec copy site `ScheduleTourForm.tsx:326` (bare catch, fixed copy).
The fallback line (:327, non-ASCII) is left untouched (CONTRACT ISSUE 4);
the existing `on an API error keeps the dialog open...` test stays green (W7).

Files:
- `dashboard/src/routes/tours/ScheduleTourForm.tsx`
- `dashboard/src/routes/tours/ScheduleTourForm.test.tsx`

Lint baseline (plan review R1 row 3): `ScheduleTourForm.tsx` already carries
ONE pre-existing error at the merge base - `react-hooks/set-state-in-effect`
on `setTourType(DEFAULT_TOUR_TYPE);` in the unit-picked effect (:241). It is
baseline debt: do NOT fix it in this task; this task's edits must add no
other error (section 0 "Lint at every slice gate"; checked at the S3 slice
gate).

### Step 1 - failing test

Edit `dashboard/src/routes/tours/ScheduleTourForm.test.tsx` - old_string (the file's last lines):

```ts
    expect(onClose).toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
  });
});
```

new_string:

```ts
    expect(onClose).toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
  });
});

// Caseworker integrity (spec 2026-10-12 section 4): POST /api/tours refuses a
// contact that is not a tenant (409) or no longer exists (404); the dialog
// says which, inline, and stays open.
describe('ScheduleTourForm - contact-type refusals (caseworker integrity)', () => {
  it('a 409 contact_not_tenant shows the contact-type sentence inline; onCreated is not called', async () => {
    const user = userEvent.setup();
    createTour.mockRejectedValue(
      new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
        error: 'contact_not_tenant',
        contactKind: 'landlord',
      }),
    );
    const { onCreated } = setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tours and placements are for tenants. This contact is a landlord.',
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Couldn't schedule the tour/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Schedule$/ })).toBeEnabled();
  });

  it('a 404 tenant_not_found says the contact no longer exists', async () => {
    const user = userEvent.setup();
    createTour.mockRejectedValue(
      new ApiError(404, 'tenant_not_found', 'tenant_not_found', { error: 'tenant_not_found' }),
    );
    setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That contact no longer exists.'));
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/ScheduleTourForm.test.tsx -t "contact-type refusals"
```

RED: the bare `catch` shows the fixed "Couldn't schedule the tour ..." copy for every failure, so neither sentence appears.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/tours/ScheduleTourForm.tsx` - old_string:

```ts
import { contactDisplayName } from '../contact/format.js';
```

new_string:

```ts
import { contactDisplayName } from '../contact/format.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

3b. Edit `dashboard/src/routes/tours/ScheduleTourForm.tsx` - old_string:

```ts
      onCreated(tour);
    } catch {
```

new_string:

```ts
      onCreated(tour);
    } catch (err) {
      // Caseworker integrity: a contact-type refusal has its own sentence;
      // any other failure keeps the fixed copy below.
      const typeCopy = contactTypeErrorMessage(err);
      if (typeCopy !== null) {
        setError(typeCopy);
        setBusy(false);
        return;
      }
```

(The two lines after it - the fixed-copy `setError(...)` and `setBusy(false);` - stay exactly as they are.)

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/tours/ScheduleTourForm.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/tours/ScheduleTourForm.tsx dashboard/src/routes/tours/ScheduleTourForm.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/tours/ScheduleTourForm.tsx dashboard/src/routes/tours/ScheduleTourForm.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): Schedule a tour shows the contact-type sentence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.15 - PlacementCreateForm shows the sentence

Goal: spec copy site `PlacementCreateForm.tsx:248`. The fallback line (:249,
non-ASCII) is left untouched; the existing `on an API error keeps the dialog
open...` test stays green (W7).

Files:
- `dashboard/src/routes/placements/PlacementCreateForm.tsx`
- `dashboard/src/routes/placements/PlacementCreateForm.test.tsx`

### Step 1 - failing test

Edit `dashboard/src/routes/placements/PlacementCreateForm.test.tsx` - old_string (the file's last lines):

```ts
        expect.objectContaining({ tenantId: 'contact-tenant-0001', unitId: 'unit-0002' }),
      ),
    );
  });
});
```

new_string:

```ts
        expect.objectContaining({ tenantId: 'contact-tenant-0001', unitId: 'unit-0002' }),
      ),
    );
  });
});

// Caseworker integrity (spec 2026-10-12 section 4): POST /api/placements
// refuses a contact that is not a tenant (409) or no longer exists (404); the
// dialog says which, inline, and stays open.
describe('PlacementCreateForm - contact-type refusals (caseworker integrity)', () => {
  it('a 409 contact_not_tenant shows the contact-type sentence inline; onCreated is not called', async () => {
    const user = userEvent.setup();
    createPlacement.mockRejectedValue(
      new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
        error: 'contact_not_tenant',
        contactKind: 'caseworker',
      }),
    );
    const { onCreated } = setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tours and placements are for tenants. This contact is a caseworker.',
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Couldn't create the placement/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
  });

  it('a 404 tenant_not_found says the contact no longer exists', async () => {
    const user = userEvent.setup();
    createPlacement.mockRejectedValue(
      new ApiError(404, 'tenant_not_found', 'tenant_not_found', { error: 'tenant_not_found' }),
    );
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That contact no longer exists.'));
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementCreateForm.test.tsx -t "contact-type refusals"
```

RED: the bare `catch` shows "Couldn't create the placement ..." for every failure, so neither sentence appears.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/placements/PlacementCreateForm.tsx` - old_string:

```ts
import styles from './PlacementCreateForm.module.css';
```

new_string:

```ts
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
import styles from './PlacementCreateForm.module.css';
```

3b. Edit `dashboard/src/routes/placements/PlacementCreateForm.tsx` - old_string:

```ts
      onCreated(placement);
    } catch {
```

new_string:

```ts
      onCreated(placement);
    } catch (err) {
      // Caseworker integrity: a contact-type refusal has its own sentence;
      // any other failure keeps the fixed copy below.
      const typeCopy = contactTypeErrorMessage(err);
      if (typeCopy !== null) {
        setError(typeCopy);
        setBusy(false);
        return;
      }
```

(The fixed-copy `setError(...)` and `setBusy(false);` after it stay exactly as they are.)

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementCreateForm.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/placements/PlacementCreateForm.tsx dashboard/src/routes/placements/PlacementCreateForm.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/placements/PlacementCreateForm.tsx dashboard/src/routes/placements/PlacementCreateForm.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): New placement shows the contact-type sentence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.16 - PlacementsPage stage moves show the sentence

Goal: spec copy site `PlacementsPage.tsx:96` (fixed copy). Other rejections
keep "That move was rejected. The placement kept its stage." (W7).

Files:
- `dashboard/src/routes/placements/PlacementsPage.tsx`
- `dashboard/src/routes/placements/PlacementsPage.test.tsx`

### Step 1 - failing test

1a. Edit `dashboard/src/routes/placements/PlacementsPage.test.tsx` - old_string:

```ts
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';
```

new_string:

```ts
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';
import { ApiError } from '../../api/index.js';
```

1b. Edit `dashboard/src/routes/placements/PlacementsPage.test.tsx` - old_string (the file's last lines):

```ts
    expect(screen.getByText("No matches for 'zzz'.")).toBeInTheDocument();
  });
});
```

new_string:

```ts
    expect(screen.getByText("No matches for 'zzz'.")).toBeInTheDocument();
  });
});

// Caseworker integrity (spec 2026-10-12 section 4): a placement moved back out
// of lost / moved_in for a contact that is not a tenant is refused 409
// contact_not_tenant; the board says why instead of its generic copy.
describe('PlacementsPage - contact-type refusals (caseworker integrity)', () => {
  it('a move refused as contact_not_tenant shows the contact-type sentence and rolls back', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockRejectedValue(
      new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
        error: 'contact_not_tenant',
        contactKind: 'landlord',
      }),
    );
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tours and placements are for tenants. This contact is a landlord.',
      ),
    );
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Collect RTA' })).toBeInTheDocument();
  });

  it('(PIN) any other rejected move keeps the fixed copy', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockRejectedValue(new ApiError(500, 'internal_error', 'internal_error'));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That move was rejected. The placement kept its stage.'),
    );
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementsPage.test.tsx -t "contact-type refusals"
```

RED: the `catch` ignores the error and shows "That move was rejected. The placement kept its stage."; the sentence case fails. The PIN passes.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/placements/PlacementsPage.tsx` - old_string:

```ts
import { usePlacements } from './usePlacements.js';
```

new_string:

```ts
import { usePlacements } from './usePlacements.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

3b. Edit `dashboard/src/routes/placements/PlacementsPage.tsx` - old_string:

```ts
      .catch(() => {
        setError('That move was rejected. The placement kept its stage.');
      })
```

new_string:

```ts
      .catch((err: unknown) => {
        // Caseworker integrity: a contact-type refusal has its own sentence.
        setError(contactTypeErrorMessage(err) ?? 'That move was rejected. The placement kept its stage.');
      })
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementsPage.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/placements/PlacementsPage.tsx dashboard/src/routes/placements/PlacementsPage.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/placements/PlacementsPage.tsx dashboard/src/routes/placements/PlacementsPage.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): placements board shows the contact-type sentence for a refused move" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.17 - PlacementDetail stage moves show the sentence

Goal: spec copy site `PlacementDetail.tsx:402` (fixed copy, non-ASCII line
left untouched - CONTRACT ISSUE 4): a preceding `.catch` answers a
contact-type refusal and rethrows anything else to the existing fixed-copy
catch (W7).

Files:
- `dashboard/src/routes/placements/PlacementDetail.tsx`
- `dashboard/src/routes/placements/PlacementDetail.test.tsx`

### Step 1 - failing test

1a. Edit `dashboard/src/routes/placements/PlacementDetail.test.tsx` - old_string:

```ts
import { STAGE_LABELS } from '../../api/index.js';
```

new_string:

```ts
import { ApiError, STAGE_LABELS } from '../../api/index.js';
```

1b. Edit `dashboard/src/routes/placements/PlacementDetail.test.tsx` - old_string (the file's last lines):

```ts
    expect(conversation).toHaveAttribute('aria-pressed', 'true');
    expect(details).toHaveAttribute('aria-pressed', 'false');
  });
});
```

new_string:

```ts
    expect(conversation).toHaveAttribute('aria-pressed', 'true');
    expect(details).toHaveAttribute('aria-pressed', 'false');
  });
});

// Caseworker integrity (spec 2026-10-12 section 4): moving a LOST placement
// back to an active stage re-opens it, which the server refuses (409
// contact_not_tenant) when its contact is not a tenant. The page says why.
describe('PlacementDetail - contact-type refusals (caseworker integrity)', () => {
  it('a lost placement moved back to an active stage, refused as contact_not_tenant, shows the sentence', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'lost' });
    transitionPlacement.mockRejectedValue(
      new ApiError(409, 'contact_not_tenant', 'contact_not_tenant', {
        error: 'contact_not_tenant',
        contactKind: 'caseworker',
      }),
    );
    renderAt();
    await waitLoaded();
    await chooseStage(user, 'send_application');
    expect(
      await screen.findByText('Tours and placements are for tenants. This contact is a caseworker.'),
    ).toBeInTheDocument();
    expect(transitionPlacement).toHaveBeenCalledWith('c1', { toStage: 'send_application', source: 'manual' });
    expect(screen.queryByText(/That move was rejected/)).not.toBeInTheDocument();
  });

  it('(PIN) any other rejected move keeps the fixed copy', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'lost' });
    transitionPlacement.mockRejectedValue(new ApiError(500, 'internal_error', 'internal_error'));
    renderAt();
    await waitLoaded();
    await chooseStage(user, 'send_application');
    expect(await screen.findByText(/That move was rejected/)).toBeInTheDocument();
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementDetail.test.tsx -t "contact-type refusals"
```

RED: the only `.catch` shows the fixed "That move was rejected ..." copy, so `findByText` for the sentence times out. The PIN passes.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/placements/PlacementDetail.tsx` - old_string:

```ts
import { formatMoney } from '../listing/listingFormat.js';
```

new_string:

```ts
import { formatMoney } from '../listing/listingFormat.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

3b. Edit `dashboard/src/routes/placements/PlacementDetail.tsx` - old_string:

```ts
            void askCloseGroupIfOpen(updated);
          }
        })
```

new_string:

```ts
            void askCloseGroupIfOpen(updated);
          }
        })
        // Caseworker integrity: a contact-type refusal (a lost / moved-in
        // placement moved back to an active stage for a contact that is not a
        // tenant, or no longer exists) has its own sentence; anything else
        // falls through to the fixed copy in the next catch.
        .catch((err: unknown) => {
          const typeCopy = contactTypeErrorMessage(err);
          if (typeCopy === null) throw err;
          setError(typeCopy);
        })
```

(The existing fixed-copy `.catch(...)` line right after it stays exactly as it is.)

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/placements/PlacementDetail.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/placements/PlacementDetail.tsx dashboard/src/routes/placements/PlacementDetail.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/placements/PlacementDetail.tsx dashboard/src/routes/placements/PlacementDetail.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): placement page shows the contact-type sentence for a refused move" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.18 - TenantFile: no "+ Schedule" / "+ Start placement" for a team member

Goal: spec section 4 "Team members": `TenantFile` also renders for
`team_member` contacts (`ContactDetail.tsx:574-584`) and offers both actions
(`TenantFile.tsx:320,348`, wired at `ContactDetail.tsx:1203-1204`). Gate both
inside TenantFile on `contact.type === 'tenant'` so every caller is covered
(TenantFile serves exactly tenant + team_member, so this hides them for a
team member); ContactDetail's wiring is unchanged. The cards still render.

Files:
- `dashboard/src/routes/contact/TenantFile.tsx`
- `dashboard/src/routes/contact/TenantFile.test.tsx`

### Step 1 - failing test

Edit `dashboard/src/routes/contact/TenantFile.test.tsx` - old_string (the file's last lines):

```ts
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
  });
});
```

new_string:

```ts
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
  });
});

// Caseworker integrity I2 (spec 2026-10-12 section 4, "Team members"): tours
// and placements are for tenants. TenantFile also serves team_member
// contacts, who get neither action (Cameron 2026-10-12: tours are never booked
// on team members; the server refuses them too).
describe('TenantFile - tours and placements are for tenants (caseworker integrity)', () => {
  function renderWithActions(contact: Contact): void {
    render(
      <MemoryRouter>
        <TenantFile
          contact={contact}
          phones={[{ phone: '+14045550111', primary: true }]}
          placements={[]}
          tours={[]}
          units={[]}
          listingsSentPending={false}
          listingsSent={[]}
          relayGroupsPending={false}
          relayGroups={[]}
          groupThreadsPending={false}
          groupThreads={[]}
          groupThreadsTruncated={false}
          media={[]}
          onEdit={vi.fn()}
          onContactUpdated={vi.fn()}
          onScheduleTour={vi.fn()}
          onStartPlacement={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('(PIN) a tenant gets "+ Schedule" and "+ Start placement"', () => {
    renderWithActions(CONTACT);
    expect(screen.getByRole('button', { name: 'Schedule a tour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a placement' })).toBeInTheDocument();
  });

  it('a team member gets neither action, while both cards still render', () => {
    renderWithActions({ ...CONTACT, type: 'team_member', status: 'active' });
    expect(screen.queryByRole('button', { name: 'Schedule a tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a placement' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Tours/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Placements/ })).toBeInTheDocument();
  });
});
```

### Step 2 - RED

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/TenantFile.test.tsx
```

RED: the team-member case finds both buttons (the actions render whenever the callbacks are passed). The PIN passes.

### Step 3 - implementation

3a. Edit `dashboard/src/routes/contact/TenantFile.tsx` - old_string:

```ts
  const myPlacements = tenantPlacements(placements, contact.contactId);
```

new_string:

```ts
  // Tours and placements are for TENANTS (caseworker integrity I2, spec
  // 2026-10-12 section 4): this file also serves team_member contacts, who
  // get neither "+ Schedule" nor "+ Start placement" - the server refuses
  // them too.
  const isTenant = contact.type === 'tenant';
  const myPlacements = tenantPlacements(placements, contact.contactId);
```

3b. Edit `dashboard/src/routes/contact/TenantFile.tsx` - old_string:

```ts
          onScheduleTour ? (
```

new_string:

```ts
          onScheduleTour && isTenant ? (
```

3c. Edit `dashboard/src/routes/contact/TenantFile.tsx` - old_string:

```ts
          onStartPlacement ? (
```

new_string:

```ts
          onStartPlacement && isTenant ? (
```

### Step 4 - GREEN

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/contact/TenantFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/files.test.tsx
```

All pass.

### Step 5 - ASCII + commit

```
git -C "W:/tmp/caseworker-integrity" diff -U0 -- dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/TenantFile.test.tsx | grep '^+' | grep -P '[^\x00-\x7F]'
git -C "W:/tmp/caseworker-integrity" status
git -C "W:/tmp/caseworker-integrity" add dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/TenantFile.test.tsx
git -C "W:/tmp/caseworker-integrity" commit -m "feat(dashboard): no Schedule / Start placement on a team member's file (I2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice gate

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/contactTypeGuards.test.ts test/toursApi.test.ts test/toursReopenApi.test.ts test/scheduledUpdatedEvent.test.ts test/toursCreateContactType.test.ts test/toursReviveContactType.test.ts test/toursReopenContactType.test.ts test/placementsCreateContactType.test.ts test/placementsFromTourContactType.test.ts test/statusTransitionContactType.test.ts test/transitionRoutesContactType.test.ts test/deriveTenantStatusSkip.test.ts test/placementsApi.test.ts test/placementConvert.test.ts test/transitionRoutes.test.ts test/statusTransition.test.ts test/sse.test.ts test/devGating.test.ts test/unitsApi.test.ts test/contactVoucherSync.test.ts
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/lib/contactTypeErrors.test.ts src/routes/tours/TourDetail.test.tsx src/routes/tours/TourModals.test.tsx src/routes/tours/ScheduleTourForm.test.tsx src/routes/placements/PlacementCreateForm.test.tsx src/routes/placements/PlacementsPage.test.tsx src/routes/placements/PlacementDetail.test.tsx src/routes/contact/TenantFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/files.test.tsx
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

All green, typecheck exit 0. (The CK checkpoint after S4 runs the full `npm test` + `npm run smoke`.)

Lint - AGENTS.md gate 5 scoped to S3's touched `.ts`/`.tsx` files (plan review R1 row 3;
procedure: section 0 "Lint at every slice gate"), bare:

```
cd "W:/tmp/caseworker-integrity"; npx eslint app/src/services/contactTypeGuards.ts app/src/routes/tours.ts app/src/routes/placements.ts app/src/routes/statusTransition.ts app/src/services/statusTransition.ts app/test/contactTypeGuards.test.ts app/test/toursApi.test.ts app/test/toursReopenApi.test.ts app/test/scheduledUpdatedEvent.test.ts app/test/toursCreateContactType.test.ts app/test/toursReviveContactType.test.ts app/test/toursReopenContactType.test.ts app/test/placementsCreateContactType.test.ts app/test/placementsFromTourContactType.test.ts app/test/statusTransitionContactType.test.ts app/test/transitionRoutesContactType.test.ts app/test/deriveTenantStatusSkip.test.ts dashboard/src/lib/contactTypeErrors.ts dashboard/src/lib/contactTypeErrors.test.ts dashboard/src/routes/tours/TourDetail.tsx dashboard/src/routes/tours/TourDetail.test.tsx dashboard/src/routes/tours/TourModals.tsx dashboard/src/routes/tours/TourModals.test.tsx dashboard/src/routes/tours/ScheduleTourForm.tsx dashboard/src/routes/tours/ScheduleTourForm.test.tsx dashboard/src/routes/placements/PlacementCreateForm.tsx dashboard/src/routes/placements/PlacementCreateForm.test.tsx dashboard/src/routes/placements/PlacementsPage.tsx dashboard/src/routes/placements/PlacementsPage.test.tsx dashboard/src/routes/placements/PlacementDetail.tsx dashboard/src/routes/placements/PlacementDetail.test.tsx dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/TenantFile.test.tsx
```

Expected: exit 1 with EXACTLY the two pre-existing baseline errors named in section 0 -
`TourDetail.tsx` `react-hooks/purity` on the `Date.now()` in `startPassed`, and
`ScheduleTourForm.tsx` `react-hooks/set-state-in-effect` on `setTourType(DEFAULT_TOUR_TYPE);`
(their line numbers may have moved from :341 / :241 with Tasks 3.12 / 3.14) - and nothing
else. Do NOT fix those two (pre-existing; out of scope); name them in the slice report as
baseline. Any OTHER error is S3's and BLOCKING: confirm it with the section-0 merge-base
baseline run on the same list (base `TourDetail.tsx` and `ScheduleTourForm.tsx` each print
exactly their one error there), fix it, and re-run. Then run the section-0 coverage check
(every path it prints must be in the S1, S2 or S3 list).

## Surfaces covered

| Spec bullet (section 4 / 8 D3, my area) | Task |
|---|---|
| `contactTypeGuards.ts`: four error classes, `requireTenantContact` / `requireLandlordContact` (CONSISTENT), `sendContactTypeError` (S4 uses the landlord half) | 3.1 |
| 409 body `{ error: 'contact_not_tenant', contactKind }`; `contactKind` = `caseworker` when `isCaseworker`, else the stored type | 3.1 (+ asserted in 3.3-3.9) |
| W3: existing tests/fixtures that create or reopen tours/placements for a non-tenant (app/test + e2e swept) | 3.2 |
| `POST /api/tours`: 404 `tenant_not_found` / 409 `contact_not_tenant` | 3.3 |
| tour PATCH, current `canceled` -> open (`scheduled` via reschedule or status, `toured`, `no_show`); open-to-open and into-closed not checked | 3.4 |
| `POST /api/tours/:id/reopen` | 3.5 |
| `POST /api/placements`: keep 404, add 409 | 3.6 |
| `POST /api/placements/from-tour`: 409 before any write | 3.7 |
| placement transition terminal -> non-terminal, in the service (every caller) | 3.8 |
| `handleTransitionError` maps 409 `contact_not_tenant` / 404 `tenant_not_found` | 3.9 |
| Derived tenant status: non-tenant writes nothing, info log; listing derivation unchanged (W5) | 3.10 |
| Dashboard copy helper `contactTypeErrorMessage` (all five codes; null otherwise, W7) | 3.11 |
| Copy sites `TourDetail.tsx` :382 / :514 / :589 | 3.12 |
| Copy site added by CONTRACT ISSUE 1: `TourModals.tsx` `failureCopy` (Reschedule revive + Reopen dialogs) | 3.13 |
| Copy site `ScheduleTourForm.tsx:326` | 3.14 |
| Copy site `PlacementCreateForm.tsx:248` | 3.15 |
| Copy site `PlacementsPage.tsx:96` | 3.16 |
| Copy site `PlacementDetail.tsx:402` | 3.17 |
| Team members: TenantFile hides "+ Schedule" and "+ Start placement" (`TenantFile.tsx:320,348`; `ContactDetail.tsx:574-584,1203-1204`) | 3.18 |
| Not in S3: units / contact list / restore / `runRosterWrite` / `UnitCreateForm` copy (S4); seed invariant + e2e specs (S5) | - |


---

# SLICE S4 (assembled from the section draft)

# S4 - Properties: landlord of record (I3), restore, contact list (I4)

Slice S4 of `docs/superpowers/plans/2026-10-12-caseworker-integrity.md`.
Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
section 4 ("Landlord of record (I3)", "Restore", "Contact list (I4)", and the
property half of "Dashboard copy for section 4"), section 8 "D3".

Depends on S3: `app/src/services/contactTypeGuards.ts`
(`requireLandlordContact`, `sendContactTypeError`, the four error classes) and
`dashboard/src/lib/contactTypeErrors.ts` (`contactTypeErrorMessage`) must exist
exactly as named in plan section 2 before Task 4.2 starts. This slice never
creates or edits those two files.

All run commands are written for either shell (`;` separators, absolute
`cd`). App test files need DynamoDB Local up (`npm run db:start` - a START is
fine; never restart/stop/remove the container): the app vitest globalSetup
touches it even for FakeWorld-only files.

---

## CONTRACT ISSUES

1. **"New seat" / "vacant claim" are decided at the ROUTE, from consistent
   reads; the repo is untouched.** `units.addContact` re-reads the unit inside
   its own retry loop (`app/src/repos/unitsRepo.ts:754-863`), so a route-side
   decision can, in principle, be made on a state the repo no longer sees.
   Choice: keep both checks in `app/src/routes/units.ts` (the spec's literal
   "both before the repo call", section 4 "Contact list"), switch the route's
   existing unit read (`units.ts:1088`) and contact read (`units.ts:1097`) to
   `consistentRead: true`, and mirror the repo's own definitions exactly - a
   seat is a row of `unitContacts(unit)` (`unitsRepo.ts:296`; the landlord of
   record included), a claim is `role === 'landlord'` on a unit with no
   `landlordId` attribute (`unitsRepo.ts:768,773`). Residual window (same
   record, milliseconds): a concurrent DELETE of the same caseworker's seat
   between the route read and the repo write lets an "edit" become a new seat;
   a concurrent landlord clear (only `restoreWithLandlord(next: null)`, on a
   deleted unit) lets a non-landlord claim. Both are the L1 class (spec
   section 6, read-then-write). Rejected alternative: typed errors inside
   `addContact` (race-free on the unit side) - it rewrites the core of a shared
   repo method (plan section 0 asks for minimal, additive `unitsRepo.ts` edits)
   and needs a parity rewrite of the FakeWorld fake. Planner may overrule.

2. **The plain restore stays UNCONDITIONED (exactly today's `units.restore`).**
   Spec section 4 "Restore" says "each write conditions on the landlordId it
   read". Plan section 2 gives a condition only to `restoreWithLandlord`.
   Resolution: only the body path (`restoreWithLandlord`) conditions on the
   read `landlordId`; the plain restore calls `units.restore(unitId)` exactly
   as today (spec: "restore exactly as today"). Safe because every in-scope
   writer of `landlordId` (create, changed-landlordId PATCH, roster claim,
   restore-with-landlord) is type-checked after this slice, so a concurrent
   change can only install another landlord-typed contact. The importer
   (out of scope, filed) is the only exception. If the planner wants the plain
   path conditioned too, the minimal change is an optional second parameter
   `restore(unitId, opts?: { expectLandlordId: string | undefined })` - not
   planned here.

3. **Restore of a unit that is NOT soft-deleted: no landlord check, body
   ignored.** The spec text does not distinguish. `restore` on a live unit is
   a no-op today (`unitsRepo.ts:726-740`). Applying the check there would let
   `POST /restore { landlordId }` reassign a LIVE property's landlord (an API
   reassign path; spec section 10 lists reassignment as a non-goal, filed as
   `landlord-of-record-no-reassign-ui`). Resolution: the check runs only when
   `isDeleted(stored)`; a live unit restores exactly as today. Pinned in
   Task 4.6.

4. **`restoreWithLandlord` reads the unit itself and conditions on
   `contacts[]` as well as `landlordId`.** The plan-2 signature carries only
   `expectLandlordId`, so the repo does its own consistent read to rebuild the
   roster. Each attempt is ONE conditional UpdateCommand via the existing
   `updateRosterIfCurrent` (`unitsRepo.ts:522-578`, condition = landlordId AND
   contacts[] as read). A stored `landlordId` different from
   `expectLandlordId` throws `RosterWriteConflictError` immediately (nothing
   written). A contacts-only race re-reads and retries up to
   `ROSTER_WRITE_MAX_ATTEMPTS` (3), then `RosterWriteConflictError` - the same
   bound `addContact` uses. Conditioning on `landlordId` alone would let the
   read-modify-write of `contacts[]` erase a concurrently added contact-list
   row. A missing unit throws `ConditionalCheckFailedException` (route 404).

5. **The contact-list landlord check uses the route's existing contact read,
   not `requireLandlordContact`.** Plan section 2 says the units checks use
   `requireLandlordContact`. On `POST /:unitId/contacts` the route already
   reads the contact (and 404s `contact_not_found` for a missing one, an
   existing code the spec keeps); a second read could disagree with the first.
   Resolution: that route compares `contact.type !== 'landlord'` on its own
   (now consistent) read and answers `{ error: 'landlord_not_landlord' }`
   itself. `requireLandlordContact` is used for create, PATCH and
   restore-with-landlord.

6. **PATCH `landlordId: ''`.** The validator accepts an empty string on update
   (`app/src/lib/unitFields.ts:162`, kind `string`); today it reaches the GSI
   key write and fails in DynamoDB (500). Resolution: when it differs from the
   stored value the route answers 404 `landlord_not_found` without a contact
   read (no contact has an empty id; `getById('')` would itself throw a
   DynamoDB ValidationException).

7. **Restore body validation.** The spec defines `{ landlordId: <id> | null }`
   only. Resolution: a body whose `landlordId` key is present but neither a
   non-empty string nor `null` answers 400
   `{ error: 'landlordId must be a contact id or null' }` before any read. A
   body without the key (or no body) is the plain restore.

8. **Dashboard copy the spec does not name.** Restore dialog title
   "Restore property"; picker input label "Landlord"; a 409
   `unit_roster_conflict` inside the dialog reuses the roster's existing
   sentence for that code, "The property contacts changed - try that change
   again." (`ListingDetail.tsx:123`, ROSTER_RETRY_COPY); any other dialog
   failure "Couldn't restore - please try again." (mirrors
   "Couldn't delete - please try again.", `ListingDetail.tsx:342`). Planner
   to confirm or replace. (Ruled S4-8; plan review R1 row 6: the dialog
   imports that same constant - Task 4.10 moves it to
   `dashboard/src/routes/listing/rosterCopy.ts` - never a second literal.)

9. **The restore-with-landlord response carries the enriched roster.** The
   plain restore keeps today's raw `{ unit }`. The body path answers
   `{ unit: { ...unit, contacts: await enrichRoster(unit) } }` (the roster
   routes' shape, `units.ts:1136`) so the dashboard can apply it to the
   Contacts card via `applyRosterUnit` (`ListingDetail.tsx:370`) - the hook's
   `setUnit` alone leaves the card's roster stale (`useListing.ts:143-164`).

10. **Ownerless properties reach ListingDetail more often, and one site
    crashes on them.** "Restore without a landlord" creates ownerless units
    (already a supported legacy state). `ListingDetail.tsx:290` reads
    `landlordOfRecord = contactsUnit?.landlordId ?? unit.landlordId` and
    `:473` calls `landlordOfRecord.length` - an ownerless unit (no
    `landlordId` on the wire, despite `UnitItem.landlordId: string`,
    `dashboard/src/api/types.ts:2435`) crashes the "Remove the primary
    contact?" dialog. Pre-existing for legacy ownerless units; newly reachable
    via restore-without-landlord + Make primary + Remove. Resolution: Task
    4.13 (one-line guard + test), kept in scope by ruling S4-10; plan review
    R1 row 11 widened it: `UnitItem.landlordId` becomes optional in the
    dashboard type and every compile error that causes is fixed (one site
    today, the same `:473` read).

11. **Ground-rule exception: Task 4.1 has no RED case.** It is the W3 fixture
    prep (tests that will break under Tasks 4.2 / 4.6 because their fixtures
    name landlords that do not exist). It changes no product code, so it can
    only be PIN-green; it must land first so Tasks 4.2-4.6 commit green.

12. **"`ListingDetail.tsx:349`, the only Restore button".** There are three
    Restore entry points - the header button (`:668`), the Deleted banner
    button (`:691`) and the More actions menu (`:679`, `ListingActionsMenu`) -
    all calling the one `onRestore` handler (`:346-355`). The dialog hangs
    off `onRestore`, so all three are covered. Clarification only.

No findings file: nothing in the tree contradicts a spec DECISION; items 2, 3
and 10 are interpretations / an enabling fix, listed here for the planner.

---

## Task 4.1 - W3 fixture prep: seed the landlords that existing unit tests name

**Goal.** Existing FakeWorld tests create units through `POST /api/units`
with landlordIds that are not contacts, and one restores a deleted unit whose
landlord is not a contact. After Tasks 4.2 and 4.6 they would answer 404
`landlord_not_found` / 409 `restore_needs_landlord`. Fix the fixtures (correct
typing), never weaken the rule (plan W3). No product code.

**W3 sweep result (every site checked):**

| File:line | What it does | Fix |
|---|---|---|
| `app/test/unitsApi.test.ts:38,76,116,139,168,188,199,411,542` | POST /api/units with `contact-ll-9` / `contact-ll-1` / `contact-ll-reg`, none seeded; expects 201 | every harness in the file seeds those three as `landlord` (`landlordHarness()`) |
| `app/test/unitsApi.test.ts:90,158,225` | POST /api/units expecting 400 | none (the validator 400 runs before the landlord check); covered by the same harness swap, harmless |
| `app/test/unitsApiOrgNames.test.ts:29,39` | POST with `contact-ll-1`, not seeded; expects 201 | `seedLandlord(world)` in both tests |
| `app/test/unitsApiOrgNames.test.ts:56,74,85,97` | POST expecting 422 / 400 | none (400 and 422 run before the landlord check) |
| `app/test/unitsApiRoster.test.ts:463` | two POSTs with `c-ll-prop` / `c-ll-other`, not seeded; expects 201 | `seedContact(world, ...)` for both (the file's helper defaults to `type: 'landlord'`) |
| `app/test/unitsSoftDelete.test.ts:50` | restores a deleted unit whose `landlordId` `contact-ll-1` is not a contact; expects 200 | seed `contact-ll-1` as `landlord` |
| `app/test/unitsApiRoster.test.ts:166-361` | roster adds; `seedContact` defaults to `type: 'landlord'`; the vacant claim at :192 is landlord-typed | clean |
| `app/test/unitsApiActivity.test.ts:85-98` | roster add of a `tenant` with role `pm` on an OWNED unit | clean (not a caseworker, not a claim) |
| `app/test/placementsVoiceRouting.test.ts:239` | calls `world.unitsRepo.addContact` directly (no route) | clean |
| e2e: `e2e/scenarios/steps.ts:1021`; `e2e/tests/dashboard-next/{a2p-compliance:345, broadcasts:74, landlord-activity:47, listing-activity:65, listing-photos:54, matching-entry-points:67, org-lists:153, partner-share:86, properties-available-view:61, property-roster:80, public-pages:111, send-outcome-reconcile:138, share-sent-outcome:155, share-skip-fix:55, tour-comms-pane:115, tours-page:307, upcoming-in-stream:81}.spec.ts`; `e2e/tests/{relay-intro-variants:89, roster-quiet-hours:170, tour-roster:114}.spec.ts` | POST /api/units | clean - every landlordId is the lean seed's `contact-landlord-0001` (`type: 'landlord'`, `app/src/lib/seed/lean.ts:137-138`), a `createLandlord` / `createContact(req, 'landlord', ...)` contact, or a `teamCreatesLandlord` contact |
| e2e: `relay-intro-variants.spec.ts:118`, `roster-quiet-hours.spec.ts:197`, `tour-roster.spec.ts:141`, `property-roster.spec.ts:129-158` (UI) | contact-list adds | clean - every added PM is `landlord`-typed; no caseworker is seated |
| e2e (all) | unit restore | none exists |

(Seeds are S5's seed-invariant test, not this task.)

**Files:** `app/test/unitsApi.test.ts`, `app/test/unitsApiOrgNames.test.ts`,
`app/test/unitsApiRoster.test.ts`, `app/test/unitsSoftDelete.test.ts`.

**Step 1 - baseline (PIN).** Run, confirm green before editing:

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsApi.test.ts test/unitsApiOrgNames.test.ts test/unitsApiRoster.test.ts test/unitsSoftDelete.test.ts
```

There is no RED step (CONTRACT ISSUE 11): this task only adds fixtures that
the later rules require.

**Step 2 - `app/test/unitsApi.test.ts`.** Do these three edits IN THIS ORDER
(the replace-all must run before the helper exists, or it would rewrite the
helper's own body).

(a) Edit with `replace_all: true`:
- old: `makeWebhookHarness();`
- new: `landlordHarness();`

(27 call sites; the import line `import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET }` has no `();` and is untouched.)

(b) Add the import. Before:

```ts
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
```

After:

```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
```

(c) Add the helper right after `seedUnit`. Before:

```ts
  world.units.set(unitId, item);
  return item;
}
```

After:

```ts
  world.units.set(unitId, item);
  return item;
}

/**
 * caseworker-integrity I3 (spec 2026-10-12 section 4): POST /api/units needs
 * its landlordId to name a contact typed `landlord`. Every harness in this
 * file seeds the landlord ids its creates use.
 */
function landlordHarness(): ReturnType<typeof makeWebhookHarness> {
  const harness = makeWebhookHarness();
  for (const contactId of ['contact-ll-1', 'contact-ll-9', 'contact-ll-reg']) {
    harness.world.contacts.push({ contactId, type: 'landlord' } as ContactItem);
  }
  return harness;
}
```

**Step 3 - `app/test/unitsApiOrgNames.test.ts`.**

Import. Before:

```ts
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

After:

```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

Helper. Before:

```ts
function names(refs: Array<{ name: string }>): string[] {
  return refs.map((r) => r.name).sort();
}
```

After:

```ts
function names(refs: Array<{ name: string }>): string[] {
  return refs.map((r) => r.name).sort();
}

/**
 * caseworker-integrity I3 (spec 2026-10-12 section 4): a created unit's
 * landlordId must name a contact typed `landlord`.
 */
function seedLandlord(world: FakeWorld, contactId = 'contact-ll-1'): void {
  world.contacts.push({ contactId, type: 'landlord' } as ContactItem);
}
```

First 201 test. Before:

```ts
  it('(PIN) stores exact list names as is', async () => {
    const { app } = makeWebhookHarness();
```

After:

```ts
  it('(PIN) stores exact list names as is', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
```

Second 201 test. Before:

```ts
  it('resolves a unique spelling to the exact name and de-duplicates the result', async () => {
    const { app, world } = makeWebhookHarness();
```

After:

```ts
  it('resolves a unique spelling to the exact name and de-duplicates the result', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
```

**Step 4 - `app/test/unitsApiRoster.test.ts`.** Before:

```ts
    const { app } = makeWebhookHarness();
    // Create the target unit WITH a propertyId straight through the API
```

After:

```ts
    const { app, world } = makeWebhookHarness();
    // caseworker-integrity I3: both creates below name landlord-typed contacts.
    seedContact(world, 'c-ll-prop');
    seedContact(world, 'c-ll-other');
    // Create the target unit WITH a propertyId straight through the API
```

**Step 5 - `app/test/unitsSoftDelete.test.ts`.** Import. Before:

```ts
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

After:

```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

Restore test. Before:

```ts
  it('restore clears deleted_at and brings the listing back into the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2');
```

After:

```ts
  it('restore clears deleted_at and brings the listing back into the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2');
    // caseworker-integrity I3: the restored unit's landlord of record is a landlord.
    world.contacts.push({ contactId: 'contact-ll-1', type: 'landlord' } as ContactItem);
```

**Step 6 - GREEN (still all pass):**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsApi.test.ts test/unitsApiOrgNames.test.ts test/unitsApiRoster.test.ts test/unitsSoftDelete.test.ts
```

**Step 7 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/test/unitsApi.test.ts app/test/unitsApiOrgNames.test.ts app/test/unitsApiRoster.test.ts app/test/unitsSoftDelete.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "test(units): seed landlord-typed contacts for unit fixtures ahead of the I3 checks (W3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.2 - POST /api/units: the landlordId must name a landlord

**Goal.** Spec section 4 table row 1: 404 `landlord_not_found` when the
contact is missing; 409 `landlord_not_landlord` when not typed `landlord`.
Consistent read (inside `requireLandlordContact`). Runs after the validator's
400s and the org-list 422 (`units.ts:465-489`), so existing 400/422 answers
keep their precedence and nothing is created on a refusal.

**Files:** `app/src/routes/units.ts`; NEW `app/test/unitsLandlordOfRecord.test.ts`.

**Step 1 - failing test.** Create `app/test/unitsLandlordOfRecord.test.ts`:

```ts
// caseworker-integrity I3 (spec 2026-10-12 section 4, "Landlord of record"):
// POST /api/units, and a PATCH that CHANGES landlordId, need the landlordId to
// name a contact typed `landlord` (a property manager is a landlord with a
// role) - 404 landlord_not_found when the contact is missing, 409
// landlord_not_landlord otherwise. Runs on the shared in-memory world.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function postUnit(app: import('express').Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/units')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

/** Every contact kind that is NOT a landlord (a caseworker is a partner with the role). */
const NON_LANDLORDS: Array<[string, Partial<ContactItem>]> = [
  ['tenant', { type: 'tenant' }],
  ['partner', { type: 'partner', role: 'Navigator' }],
  ['caseworker', { type: 'partner', role: 'Caseworker' }],
  ['unknown', { type: 'unknown' }],
  ['team member', { type: 'team_member' }],
];

describe('POST /api/units - the landlordId must name a landlord (I3)', () => {
  it('(PIN) creates the unit when landlordId names a landlord, a property manager included', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord', role: 'Property manager' });
    for (const landlordId of ['c-ll', 'c-pm']) {
      const res = await postUnit(app, { landlordId });
      expect(res.status, landlordId).toBe(201);
      expect(res.body.unit.landlordId).toBe(landlordId);
    }
  });

  it('404s landlord_not_found when no such contact exists - nothing created, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - nothing created, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedContact(world, 'c-other', fields);
      const res = await postUnit(app, { landlordId: 'c-other' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(world.units.size).toBe(0);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('(PIN) the validator 400 and the org-list 422 still come first', async () => {
    const { app } = makeWebhookHarness();
    const bad = await postUnit(app, { landlordId: 'c-ghost', beds: 'three' });
    expect(bad.status).toBe(400);
    const offList = await postUnit(app, { landlordId: 'c-ghost', accepted_authorities: ['Step Up'] });
    expect(offList.status).toBe(422);
    expect(offList.body.error).toBe('org_not_on_list');
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsLandlordOfRecord.test.ts
```

Expected RED: the `404s landlord_not_found` case and all five
`409s landlord_not_landlord` cases fail with `expected 201 to be 404` /
`expected 201 to be 409` - the route never reads the contact today. The two
(PIN) cases pass.

**Step 3 - implementation, `app/src/routes/units.ts`.**

(a) Import. Before:

```ts
import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';
```

After:

```ts
import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';
import { requireLandlordContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

(b) The check, after the create's org-list block. Before:

```ts
      if (!check.ok) {
        log.info({ actor: req.user?.userId }, 'unit create refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
```

After:

```ts
      if (!check.ok) {
        log.info({ actor: req.user?.userId }, 'unit create refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
    // caseworker-integrity I3 (spec 2026-10-12 section 4): the owning
    // landlordId must name a contact typed `landlord` (a property manager is a
    // landlord with a role) - 404 landlord_not_found when no such contact
    // exists, 409 landlord_not_landlord otherwise. A consistent read. It runs
    // after the validator's 400s and the org-list 422, and nothing is created
    // on a refusal. landlordId is guaranteed by validation.
    try {
      await requireLandlordContact(contacts, validation.fields['landlordId'] as string);
    } catch (err) {
      if (sendContactTypeError(err, res)) {
        log.info({ actor: req.user?.userId }, 'unit create refused: landlordId is not a landlord');
        return;
      }
      throw err;
    }
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsLandlordOfRecord.test.ts test/unitsApi.test.ts test/unitsApiOrgNames.test.ts test/unitsApiRoster.test.ts
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/routes/units.ts app/test/unitsLandlordOfRecord.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(units): a created property's landlord of record must be a landlord (I3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.3 - PATCH /api/units/:id: a CHANGED landlordId must name a landlord

**Goal.** Spec section 4 table row 2. "Changed" is decided against a
CONSISTENT unit read; an unchanged `landlordId` (re-saving the stored owner)
is not checked; an empty id is 404 `landlord_not_found` with no read
(CONTRACT ISSUE 6). Placed after the org-list 422 block so its precedence is
unchanged.

**Files:** `app/src/routes/units.ts`; `app/test/unitsLandlordOfRecord.test.ts`.

**Step 1 - failing test.** In `app/test/unitsLandlordOfRecord.test.ts`:

Import. Before:

```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
```

After:

```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

Append after the POST describe. Before (the end of the file):

```ts
    expect(offList.status).toBe(422);
    expect(offList.body.error).toBe('org_not_on_list');
  });
});
```

After:

```ts
    expect(offList.status).toBe(422);
    expect(offList.body.error).toBe('org_not_on_list');
  });
});

const STAMP = '2026-10-12T09:00:00.000Z';

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

function patchUnit(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

describe('PATCH /api/units/:id - a CHANGED landlordId must name a landlord (I3)', () => {
  it('(PIN) moves the property to another landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ll', { type: 'landlord' });
    seedContact(world, 'c-ll-2', { type: 'landlord' });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll-2' });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll-2');
  });

  it('404s landlord_not_found for a missing contact - unit unchanged, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
    expect(world.auditEvents).toHaveLength(0);
  });

  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - unit unchanged, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-1');
      seedContact(world, 'c-other', fields);
      const res = await patchUnit(app, 'u-1', { landlordId: 'c-other', beds: 3 });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
      expect(world.units.get('u-1')?.beds).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('404s landlord_not_found for an empty landlordId', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { landlordId: '' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
  });

  it('(PIN) an UNCHANGED landlordId is not checked, even when the stored landlord is no longer a landlord (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ll', { type: 'tenant' });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll', beds: 3 });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.beds).toBe(3);
  });

  it('(PIN) a PATCH without landlordId never looks at the landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { beds: 4 });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.beds).toBe(4);
  });

  it('(PIN) an unknown unit still 404s unit_not_found', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll', { type: 'landlord' });
    const res = await patchUnit(app, 'nope', { landlordId: 'c-ll' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsLandlordOfRecord.test.ts
```

Expected RED: the `404s landlord_not_found for a missing contact`, the five
`409s landlord_not_landlord` and the `empty landlordId` cases fail with
`expected 200 to be 404/409` - the PATCH writes any landlordId today. The
(PIN) cases pass.

**Step 3 - implementation, `app/src/routes/units.ts`.** Before:

```ts
      if (!check.ok) {
        log.info({ unitId, actor: req.user?.userId }, 'unit patch refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
```

After:

```ts
      if (!check.ok) {
        log.info({ unitId, actor: req.user?.userId }, 'unit patch refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
    // caseworker-integrity I3 (spec 2026-10-12 section 4): a CHANGED landlordId
    // must name a contact typed `landlord` (404 landlord_not_found / 409
    // landlord_not_landlord). "Changed" is decided on a CONSISTENT unit read; an
    // unchanged landlordId is not checked (re-saving the stored owner, L2). An
    // empty id names no contact, so it is a 404 without a contact read.
    const landlordPatch = validation.fields['landlordId'];
    if (typeof landlordPatch === 'string') {
      const current = await units.getById(unitId, { consistentRead: true });
      if (current === undefined) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      if (current.landlordId !== landlordPatch) {
        if (landlordPatch.length === 0) {
          res.status(404).json({ error: 'landlord_not_found' });
          return;
        }
        try {
          await requireLandlordContact(contacts, landlordPatch);
        } catch (err) {
          if (sendContactTypeError(err, res)) {
            log.info({ unitId, actor: req.user?.userId }, 'unit patch refused: landlordId is not a landlord');
            return;
          }
          throw err;
        }
      }
    }
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsLandlordOfRecord.test.ts test/unitsApi.test.ts test/unitsApiOrgNames.test.ts test/unitsApiPhotos.test.ts test/unitsApiActivity.test.ts
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/routes/units.ts app/test/unitsLandlordOfRecord.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(units): a changed landlord of record must be a landlord (I3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.4 - Contact list: no NEW seat for a caseworker (I4); a vacant landlord claim needs a landlord (I3)

**Goal.** Spec section 4 "Contact list (I4)" and table row 3. On
`POST /api/units/:unitId/contacts`, in this order and before the repo call:
409 `contact_list_caseworker` when a caseworker (`isCaseworker`,
`app/src/lib/caseworkers.ts:86`) is not already seated (any role); then 409
`landlord_not_landlord` when a role-`landlord` add claims the vacant landlord
slot with a contact not typed `landlord`. Editing an existing seat and
re-asserting the existing owner are not checked; other types may sit on a
contact list. Decided at the route from consistent reads (CONTRACT ISSUES 1
and 5).

**Files:** `app/src/routes/units.ts`; NEW `app/test/unitsApiRosterTypeChecks.test.ts`.

**Step 1 - failing test.** Create `app/test/unitsApiRosterTypeChecks.test.ts`:

```ts
// caseworker-integrity (spec 2026-10-12 section 4 "Landlord of record (I3)"
// and "Contact list (I4)"): POST /api/units/:id/contacts refuses a caseworker
// taking a NEW contact-list seat (409 contact_list_caseworker, any role) and a
// role-landlord add that CLAIMS the vacant landlord slot with a contact not
// typed landlord (409 landlord_not_landlord) - in that order, before the repo
// call; the repo's own 409 landlord_reassignment_required follows. Existing
// seats, re-asserting the owner, and other contact types stay allowed.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';

const CASEWORKER: Partial<ContactItem> = {
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Casey',
  lastName: 'Worker',
};

/** Non-landlord kinds that are NOT caseworkers (a caseworker hits I4 first). */
const NON_LANDLORDS: Array<[string, Partial<ContactItem>]> = [
  ['tenant', { type: 'tenant' }],
  ['partner', { type: 'partner', role: 'Navigator' }],
  ['unknown', { type: 'unknown' }],
  ['team member', { type: 'team_member' }],
];

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-owner',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

/** A legacy OWNERLESS unit: no landlordId attribute at all (the repo's vacant slot). */
function seedOwnerlessUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item = seedUnit(world, unitId, overrides);
  delete (item as Partial<UnitItem>).landlordId;
  return item;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function addContact(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

const hasLandlordId = (unit: UnitItem | undefined): boolean =>
  unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId');

describe('contact list - a caseworker never takes a NEW seat (I4)', () => {
  it.each(['pm', 'owner', 'other', 'landlord'] as const)(
    '409s contact_list_caseworker for role %s - roster unchanged, no audit row',
    async (role) => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-1');
      seedContact(world, 'c-owner', { type: 'landlord' });
      seedContact(world, 'c-cw', CASEWORKER);
      const res = await addContact(app, 'u-1', { contactId: 'c-cw', role });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'contact_list_caseworker' });
      expect(world.units.get('u-1')?.contacts).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('the caseworker refusal comes before the landlord-claim refusal on a vacant slot', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-vacant', { contactId: 'c-cw', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_list_caseworker' });
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
  });

  it('(PIN) a caseworker who already holds a seat can still be re-roled and made primary (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-seated', {
      primary_contact: 'c-owner',
      contacts: [
        { contactId: 'c-owner', role: 'landlord', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
      ],
    });
    seedContact(world, 'c-owner', { type: 'landlord' });
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-seated', { contactId: 'c-cw', role: 'pm', primaryContact: true });
    expect(res.status).toBe(200);
    expect(world.units.get('u-seated')?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-cw', role: 'pm', primaryContact: true }),
    );
  });

  it('(PIN) other non-landlord types still take a new seat', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-owner', { type: 'landlord' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-nav', { type: 'partner', role: 'Navigator' });
    expect((await addContact(app, 'u-1', { contactId: 'c-ten', role: 'other' })).status).toBe(200);
    expect((await addContact(app, 'u-1', { contactId: 'c-nav', role: 'pm' })).status).toBe(200);
  });
});

describe('contact list - a role-landlord add that CLAIMS the vacant slot needs a landlord (I3)', () => {
  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - the slot stays vacant, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-vacant');
      seedContact(world, 'c-other', fields);
      const res = await addContact(app, 'u-vacant', { contactId: 'c-other', role: 'landlord' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('a SEATED caseworker re-roled to landlord on a vacant slot gets the landlord refusal', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant', {
      contacts: [{ contactId: 'c-cw', role: 'other', primaryContact: false }],
    });
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-vacant', { contactId: 'c-cw', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
    expect(world.units.get('u-vacant')?.contacts).toEqual([
      { contactId: 'c-cw', role: 'other', primaryContact: false },
    ]);
  });

  it('(PIN) a landlord claims the vacant slot', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-ll', { type: 'landlord' });
    const res = await addContact(app, 'u-vacant', { contactId: 'c-ll', role: 'landlord' });
    expect(res.status).toBe(200);
    expect(world.units.get('u-vacant')?.landlordId).toBe('c-ll');
  });

  it('(PIN) re-asserting the existing owner is not checked, even when the owner is no longer a landlord (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-owner', { type: 'tenant' });
    const res = await addContact(app, 'u-1', { contactId: 'c-owner', role: 'landlord', primaryContact: true });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.landlordId).toBe('c-owner');
  });

  it('(PIN) a non-landlord landlord-role add on an OWNED unit is the repo reassignment refusal, not a claim', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ten', { type: 'tenant' });
    const res = await addContact(app, 'u-1', { contactId: 'c-ten', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_reassignment_required' });
  });

  it('(PIN) a non-landlord with a non-landlord role on an ownerless unit is not a claim', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-ten', { type: 'tenant' });
    const res = await addContact(app, 'u-vacant', { contactId: 'c-ten', role: 'pm' });
    expect(res.status).toBe(200);
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsApiRosterTypeChecks.test.ts
```

Expected RED: the four `409s contact_list_caseworker` cases, the
`caseworker refusal comes before` case, the four `409s landlord_not_landlord`
cases and the `SEATED caseworker re-roled` case fail with
`expected 200 to be 409` (the role-landlord caseworker on an OWNED unit fails
with a `landlord_reassignment_required` body instead) - the route has no type
checks today. The (PIN) cases pass.

**Step 3 - implementation, `app/src/routes/units.ts`.**

(a) Import. Before:

```ts
import { requireLandlordContact, sendContactTypeError } from '../services/contactTypeGuards.js';
```

After:

```ts
import { requireLandlordContact, sendContactTypeError } from '../services/contactTypeGuards.js';
import { isCaseworker } from '../lib/caseworkers.js';
```

(b) Consistent unit read. Before:

```ts
    // The unit must exist (404). We check up-front so an unknown unit is a clean
    // 404 distinct from the unknown-contact 404 below.
    const unit = await units.getById(unitId);
```

After:

```ts
    // The unit must exist (404). We check up-front so an unknown unit is a clean
    // 404 distinct from the unknown-contact 404 below. caseworker-integrity
    // (spec 2026-10-12 section 4): the seat and claim checks below decide from
    // THIS read, so it is consistent.
    const unit = await units.getById(unitId, { consistentRead: true });
```

(c) Consistent contact read + the two checks. Before:

```ts
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const name = displayNameOfContact(contact);
```

After:

```ts
    const contact = await contacts.getById(contactId, { consistentRead: true });
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // caseworker-integrity (spec 2026-10-12 section 4), in this order and both
    // before the repo call; the repo's own 409 landlord_reassignment_required
    // follows. Decided from the consistent reads above with the repo's own
    // definitions (unitsRepo.addContact): a SEAT is a row of unitContacts(unit)
    // (the landlord of record included); a CLAIM is a role-landlord add on a
    // unit with no landlordId attribute.
    //   I4: a caseworker never takes a NEW seat, whatever the role. A seat they
    //       already hold stays editable (L2).
    //   I3: claiming the vacant landlord slot needs a contact typed `landlord`.
    //       Re-asserting the existing owner is not a claim and is not checked.
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
    const name = displayNameOfContact(contact);
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsApiRosterTypeChecks.test.ts test/unitsApiRoster.test.ts test/unitsApiActivity.test.ts
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/routes/units.ts app/test/unitsApiRosterTypeChecks.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(units): refuse a new contact-list seat for a caseworker and a landlord claim by a non-landlord (I3, I4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.5 - UnitsRepo.restoreWithLandlord (real repo + FakeWorld fake)

**Goal.** Plan section 2 method, appended to the `UnitsRepo` interface AND
`createUnitsRepo`, plus the one typed fake (`app/test/helpers/twilioWebhookHarness.ts:2816`;
the only other UnitsRepo fake, `app/test/placementNudges.test.ts:176`, is an
`as unknown as UnitsRepo` cast and needs nothing). Semantics: CONTRACT ISSUE 4.
Real-repo proof on DynamoDB Local, including the race that proves the write
is conditioned on the read `landlordId`.

**Files:** `app/src/repos/unitsRepo.ts`; `app/test/helpers/twilioWebhookHarness.ts`;
NEW `app/test/unitsRepoRestoreWithLandlord.integration.test.ts`.

**Step 1 - failing test.** Create
`app/test/unitsRepoRestoreWithLandlord.integration.test.ts`:

```ts
// caseworker-integrity (spec 2026-10-12 section 4 "Restore"): the real
// unitsRepo.restoreWithLandlord against DynamoDB Local - restore plus a
// landlord swap or clear in one conditional write, the old landlord's row
// removed, the new one pinned 'landlord', primary_contact kept consistent, a
// landlordId that changed under the read answered with
// RosterWriteConflictError (nothing written), and a contacts-only race retried
// without losing the concurrent row.
//
// Self-skipping like the other integration suites when nothing answers at
// DYNAMODB_ENDPOINT (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
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
    `[unitsRepoRestoreWithLandlord.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('unitsRepo.restoreWithLandlord against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });
  const AT = '2026-10-01T09:00:00.000Z';

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** A SOFT-DELETED unit owned by c-old, with the given stored roster (or none). */
  async function deletedUnit(contacts: UnitContact[] | undefined, primary?: string): Promise<string> {
    const created = await units.create({
      landlordId: 'c-old',
      status: 'available',
      ...(contacts !== undefined && { contacts }),
      ...(primary !== undefined && { primary_contact: primary }),
    });
    await units.softDelete(created.unitId, AT);
    return created.unitId;
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

  it('swaps the landlord: restored, old row gone, new row pinned landlord and made primary in its place', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new', name: 'Nora Lane', company: 'Lane Homes' },
    });
    expect(updated.deleted_at).toBeUndefined();
    expect(updated.landlordId).toBe('c-new');
    expect(updated.primary_contact).toBe('c-new');
    expect(updated.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true, name: 'Nora Lane', company: 'Lane Homes' },
    ]);
    const owned = await units.listByLandlord('c-new');
    expect(owned.items.map((u) => u.unitId)).toContain(unitId);
  });

  it('keeps an already-seated new landlord row (re-roled to landlord) and leaves another primary alone', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
      'c-pm',
    );
    const updated = await units.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-pm' },
    });
    expect(updated.landlordId).toBe('c-pm');
    expect(updated.primary_contact).toBe('c-pm');
    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'landlord', primaryContact: true }]);
  });

  it('clears the landlord: restored ownerless, old row gone, primary_contact removed', async () => {
    const unitId = await deletedUnit(
      [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      'c-old',
    );
    const updated = await units.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: null });
    expect(updated.deleted_at).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    expect(updated.primary_contact).toBeUndefined();
    expect(updated.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    const owned = await units.listByLandlord('c-old', { deleted: 'any' });
    expect(owned.items.map((u) => u.unitId)).not.toContain(unitId);
  });

  it('clears the landlord of a legacy unit with no stored roster', async () => {
    const unitId = await deletedUnit(undefined);
    const updated = await units.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: null });
    expect(updated.deleted_at).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(updated, 'landlordId')).toBe(false);
    expect(updated.contacts).toEqual([]);
    expect(updated.primary_contact).toBeUndefined();
  });

  it('throws RosterWriteConflictError when the stored landlordId is not the expected one - nothing written', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    await expect(
      units.restoreWithLandlord(unitId, { expectLandlordId: 'c-someone-else', next: null }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.deleted_at).toBe(AT);
    expect(stored?.landlordId).toBe('c-old');
  });

  it('throws ConditionalCheckFailedException for an unknown unit', async () => {
    await expect(
      units.restoreWithLandlord(`unit-missing-${randomUUID()}`, { expectLandlordId: 'c-old', next: null }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('a landlordId changed between the read and the write is a conflict - the write is conditioned on it', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
    const racing = racingRepo(unitId, () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName('units', testEnv),
          Key: { unitId },
          UpdateExpression: 'SET #l = :l',
          ExpressionAttributeNames: { '#l': 'landlordId' },
          ExpressionAttributeValues: { ':l': 'c-racer' },
        }),
      ),
    );
    await expect(
      racing.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: { contactId: 'c-new' } }),
    ).rejects.toBeInstanceOf(RosterWriteConflictError);
    const stored = await units.getById(unitId, { consistentRead: true });
    expect(stored?.landlordId).toBe('c-racer');
    expect(stored?.deleted_at).toBe(AT);
  });

  it('a contacts-only change between the read and the write is retried and keeps the concurrent row', async () => {
    const unitId = await deletedUnit([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old');
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
              { contactId: 'c-late', role: 'other', primaryContact: false },
            ],
          },
        }),
      ),
    );
    const updated = await racing.restoreWithLandlord(unitId, {
      expectLandlordId: 'c-old',
      next: { contactId: 'c-new' },
    });
    expect(updated.landlordId).toBe('c-new');
    expect(updated.deleted_at).toBeUndefined();
    expect(updated.contacts).toEqual([
      { contactId: 'c-late', role: 'other', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity"; npm run db:start
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsRepoRestoreWithLandlord.integration.test.ts
```

Expected RED: every case fails with
`TypeError: units.restoreWithLandlord is not a function` (the
`unknown unit` case fails because the rejection is that TypeError, not a
ConditionalCheckFailedException). If the suite reports SKIPPED, DynamoDB
Local is not up - stop and start it; a skipped run is not RED.

**Step 3 - implementation.**

(a) `app/src/repos/unitsRepo.ts`, the interface. Before:

```ts
  rewriteAcceptedAuthorities(
    unitId: string,
    expected: string[] | null,
    next: string[],
  ): Promise<'written' | 'skipped'>;
}
```

After:

```ts
  rewriteAcceptedAuthorities(
    unitId: string,
    expected: string[] | null,
    next: string[],
  ): Promise<'written' | 'skipped'>;
  /**
   * caseworker-integrity (spec 2026-10-12 section 4 "Restore"): restore a
   * soft-deleted property AND change its landlord of record in one
   * conditional write. Reads the unit (consistent). When its landlordId is no
   * longer `expectLandlordId` (undefined = ownerless) throws
   * RosterWriteConflictError and writes nothing. Otherwise REMOVEs deleted_at,
   * sets landlordId to `next.contactId` (or REMOVEs it for `next` null), drops
   * the old landlord's contact-list row, upserts `next` with role pinned
   * 'landlord' (kept when already seated; name/company updated when supplied),
   * and keeps `primary_contact` consistent: when the old landlord was the
   * primary (roster flag or scalar), `next` becomes the sole primary, or with
   * no landlord the scalar is REMOVEd and no row stays primary (removeContact's
   * rule). The write is conditioned on the landlordId AND contacts[] it read
   * (updateRosterIfCurrent); a contacts-only race re-reads and retries up to
   * ROSTER_WRITE_MAX_ATTEMPTS, then RosterWriteConflictError. A missing unit
   * throws ConditionalCheckFailedException (route 404). Returns ALL_NEW.
   */
  restoreWithLandlord(
    unitId: string,
    input: {
      expectLandlordId: string | undefined;
      next: { contactId: string; name?: string; company?: string } | null;
    },
  ): Promise<UnitItem>;
}
```

(b) `app/src/repos/unitsRepo.ts`, the implementation. Before:

```ts
      log.info({ unitId, members: next.length }, 'unit accepted authorities rewritten');
      return 'written';
    },
  };
}
```

After:

```ts
      log.info({ unitId, members: next.length }, 'unit accepted authorities rewritten');
      return 'written';
    },

    async restoreWithLandlord(unitId, input) {
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
        const current =
          typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
        // The caller decided from THIS landlordId; any other owner now is a
        // concurrent change the caller must re-read (route 409 unit_roster_conflict).
        if (current !== input.expectLandlordId) throw new RosterWriteConflictError();
        const old = input.expectLandlordId;
        const next = input.next;
        // `next` naming the old landlord (only reachable when they became a
        // landlord again under a race) keeps their row instead of re-adding it.
        const keepsOld = next !== null && next.contactId === old;
        const roster = unitContacts(unit).map((c) => ({ ...c }));
        const oldRow = old !== undefined && !keepsOld ? roster.find((c) => c.contactId === old) : undefined;
        const oldWasPrimary =
          old !== undefined && !keepsOld && (oldRow?.primaryContact === true || unit.primary_contact === old);
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
        if (oldWasPrimary) {
          if (next !== null) {
            for (const c of nextRoster) c.primaryContact = c.contactId === next.contactId;
            patch['primary_contact'] = next.contactId;
          } else {
            // No landlord to fall back to (removeContact's rule): clear the
            // scalar, never leave it dangling at the removed landlord.
            for (const c of nextRoster) c.primaryContact = false;
            patch['primary_contact'] = null;
          }
        }
        let updated: UnitItem;
        try {
          updated = await updateRosterIfCurrent(unit, patch);
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          if (attempts >= ROSTER_WRITE_MAX_ATTEMPTS) throw new RosterWriteConflictError();
          // Re-read: a vanished unit throws (route 404), a changed landlordId
          // throws RosterWriteConflictError, a contacts-only race retries.
          return write();
        }
        log.info(
          { unitId, attempts, landlordCleared: next === null, rosterSize: nextRoster.length },
          'unit restored with a landlord change',
        );
        return updated;
      };
      return write();
    },
  };
}
```

(c) `app/test/helpers/twilioWebhookHarness.ts`, the import. Before:

```ts
  LandlordReassignmentRequiredError,
  type ListUnitsOpts,
  unitContacts,
```

After:

```ts
  LandlordReassignmentRequiredError,
  type ListUnitsOpts,
  RosterWriteConflictError,
  unitContacts,
```

(d) `app/test/helpers/twilioWebhookHarness.ts`, the fake (end of the
`unitsRepo` object). Before:

```ts
      if (media[0] === entry) return unit; // already the cover -> no-op success
      unit.media = [entry, ...media.filter((e) => e !== entry)];
      unit.updated_at = new Date().toISOString();
      return unit;
    },
  };
```

After:

```ts
      if (media[0] === entry) return unit; // already the cover -> no-op success
      unit.media = [entry, ...media.filter((e) => e !== entry)];
      unit.updated_at = new Date().toISOString();
      return unit;
    },
    // caseworker-integrity (spec 2026-10-12 section 4 "Restore"): mirror the
    // real repo - the stored landlordId must still be the caller's expectation
    // (RosterWriteConflictError otherwise); restore (drop deleted_at), swap or
    // clear the landlord of record, drop the old landlord's row, upsert the new
    // one with role pinned 'landlord', and keep primary_contact consistent.
    async restoreWithLandlord(unitId, input) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`restoreWithLandlord: no unit ${unitId}`);
      const current =
        typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined;
      if (current !== input.expectLandlordId) throw new RosterWriteConflictError();
      const old = input.expectLandlordId;
      const next = input.next;
      const keepsOld = next !== null && next.contactId === old;
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const oldRow = old !== undefined && !keepsOld ? roster.find((c) => c.contactId === old) : undefined;
      const oldWasPrimary =
        old !== undefined && !keepsOld && (oldRow?.primaryContact === true || unit.primary_contact === old);
      const nextRoster: UnitContact[] =
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
      if (oldWasPrimary) {
        if (next !== null) {
          for (const c of nextRoster) c.primaryContact = c.contactId === next.contactId;
          unit.primary_contact = next.contactId;
        } else {
          for (const c of nextRoster) c.primaryContact = false;
          delete unit.primary_contact; // null -> REMOVE; never dangling
        }
      }
      unit.contacts = nextRoster;
      if (next !== null) unit.landlordId = next.contactId;
      else delete (unit as Partial<UnitItem>).landlordId;
      delete unit.deleted_at;
      unit.updated_at = new Date().toISOString();
      return unit;
    },
  };
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsRepoRestoreWithLandlord.integration.test.ts test/unitsRepoRoster.integration.test.ts test/unitsSoftDelete.test.ts
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/repos/unitsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsRepoRestoreWithLandlord.integration.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(units): restoreWithLandlord - restore and swap or clear the landlord of record in one conditional write" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.6 - POST /api/units/:id/restore: plain, with a landlord, without a landlord

**Goal.** Spec section 4 "Restore" in full, with CONTRACT ISSUES 2, 3, 7, 9:
plain restore exactly as today when ownerless or the stored landlord is typed
`landlord` (consistent contact read), else 409 `restore_needs_landlord`
`{ landlordName? }` with nothing written; `{ landlordId: <id> }` (404
`landlord_not_found` / 409 `landlord_not_landlord`) and `{ landlordId: null }`
honored only when the plain restore would refuse, via `restoreWithLandlord`
(409 `unit_roster_conflict` on a concurrent change); audit `unit_restored`
gains `landlordReplaced { from, to }` / `landlordCleared { from }`; a unit that
is not soft-deleted restores as today with no check.

**Files:** `app/src/routes/units.ts`; NEW `app/test/unitsRestoreLandlord.test.ts`.

**Step 1 - failing test.** Create `app/test/unitsRestoreLandlord.test.ts`:

```ts
// caseworker-integrity (spec 2026-10-12 section 4 "Restore", Cameron
// 2026-10-12): POST /api/units/:id/restore never brings a property back with a
// landlord of record that is not typed `landlord`, and never dead-ends.
//   - plain (no landlordId in the body): ownerless or a valid landlord ->
//     restore as before; otherwise 409 restore_needs_landlord { landlordName? }
//     and nothing is written;
//   - { landlordId: <id> } / { landlordId: null }: honored only when the plain
//     restore would refuse - swap or clear the landlord in one write;
//   - the unit_restored audit gains landlordReplaced / landlordCleared.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { RosterWriteConflictError, type UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T09:00:00.000Z';

/** A SOFT-DELETED unit owned by c-old: c-old is the primary, c-pm a second row. */
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

const restoredEvents = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'unit_restored');

const hasLandlordId = (unit: UnitItem | undefined): boolean =>
  unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId');

describe('POST /api/units/:id/restore - plain restore (I3)', () => {
  it('(PIN) restores as before when the landlord of record is still a landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-1');
    seedContact(world, 'c-old', { type: 'landlord', firstName: 'Lee', lastName: 'Lord' });
    const res = await restore(app, 'u-1');
    expect(res.status).toBe(200);
    expect(res.body.unit.deleted_at).toBeUndefined();
    expect(world.units.get('u-1')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(1);
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordReplaced');
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordCleared');
  });

  it('(PIN) restores an ownerless property as before', async () => {
    const { app, world } = makeWebhookHarness();
    const unit = seedDeletedUnit(world, 'u-2', {
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }],
    });
    delete (unit as Partial<UnitItem>).landlordId;
    delete unit.primary_contact;
    const res = await restore(app, 'u-2');
    expect(res.status).toBe(200);
    expect(world.units.get('u-2')?.deleted_at).toBeUndefined();
  });

  it('409s restore_needs_landlord with the stored name when the landlord is no longer a landlord - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-3');
    seedContact(world, 'c-old', { type: 'partner', role: 'Caseworker', firstName: 'Lee', lastName: 'Lord' });
    const res = await restore(app, 'u-3');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'restore_needs_landlord', landlordName: 'Lee Lord' });
    expect(world.units.get('u-3')?.deleted_at).toBe(DELETED_AT);
    expect(world.units.get('u-3')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('409s restore_needs_landlord without a name when the landlord contact no longer exists', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-4');
    const res = await restore(app, 'u-4');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'restore_needs_landlord' });
    expect(world.units.get('u-4')?.deleted_at).toBe(DELETED_AT);
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('(PIN) 404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await restore(app, 'nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });

  it('(PIN) a property that is not deleted restores as before with no landlord check', async () => {
    const { app, world } = makeWebhookHarness();
    const unit = seedDeletedUnit(world, 'u-live');
    delete unit.deleted_at;
    seedContact(world, 'c-old', { type: 'tenant' });
    const res = await restore(app, 'u-live', { landlordId: null });
    expect(res.status).toBe(200);
    expect(world.units.get('u-live')?.landlordId).toBe('c-old');
  });

  it('400s a landlordId that is neither a contact id nor null - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-bad');
    for (const landlordId of [42, '', true, { id: 'c-new' }]) {
      const res = await restore(app, 'u-bad', { landlordId });
      expect(res.status, JSON.stringify(landlordId)).toBe(400);
      expect(res.body).toEqual({ error: 'landlordId must be a contact id or null' });
    }
    expect(world.units.get('u-bad')?.deleted_at).toBe(DELETED_AT);
  });
});

describe('POST /api/units/:id/restore - with a landlord (I3)', () => {
  it('restores with the chosen landlord: old row out, new row pinned landlord, primary moved, audit landlordReplaced', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-5');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', firstName: 'Nora', lastName: 'Lane', company: 'Lane Homes' });
    const res = await restore(app, 'u-5', { landlordId: 'c-new' });
    expect(res.status).toBe(200);
    const stored = world.units.get('u-5')!;
    expect(stored.deleted_at).toBeUndefined();
    expect(stored.landlordId).toBe('c-new');
    expect(stored.primary_contact).toBe('c-new');
    expect(stored.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true, name: 'Nora Lane', company: 'Lane Homes' },
    ]);
    // The response carries the enriched roster (the Contacts card applies it).
    expect(res.body.unit.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-new', role: 'landlord', name: 'Nora Lane' }),
    );
    expect(restoredEvents(world)).toHaveLength(1);
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordReplaced: { from: 'c-old', to: 'c-new' },
    });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordCleared');
  });

  it('409s landlord_not_landlord when the chosen contact is not a landlord - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-6');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker' });
    const res = await restore(app, 'u-6', { landlordId: 'c-cw' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
    expect(world.units.get('u-6')?.deleted_at).toBe(DELETED_AT);
    expect(world.units.get('u-6')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('404s landlord_not_found when the chosen contact does not exist - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-7');
    seedContact(world, 'c-old', { type: 'tenant' });
    const res = await restore(app, 'u-7', { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-7')?.deleted_at).toBe(DELETED_AT);
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('(PIN) a body is ignored when the stored landlord is still valid - the restore is plain', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-8a');
    seedDeletedUnit(world, 'u-8b');
    seedContact(world, 'c-old', { type: 'landlord' });
    seedContact(world, 'c-new', { type: 'landlord' });
    expect((await restore(app, 'u-8a', { landlordId: 'c-new' })).status).toBe(200);
    expect((await restore(app, 'u-8b', { landlordId: null })).status).toBe(200);
    expect(world.units.get('u-8a')?.landlordId).toBe('c-old');
    expect(world.units.get('u-8b')?.landlordId).toBe('c-old');
    for (const event of restoredEvents(world)) {
      expect(event.payload).not.toHaveProperty('landlordReplaced');
      expect(event.payload).not.toHaveProperty('landlordCleared');
    }
  });

  it('409s unit_roster_conflict when the landlord changed under the request - no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-9');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    world.unitsRepo.restoreWithLandlord = async () => {
      throw new RosterWriteConflictError();
    };
    const res = await restore(app, 'u-9', { landlordId: 'c-new' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unit_roster_conflict' });
    expect(restoredEvents(world)).toHaveLength(0);
  });
});

describe('POST /api/units/:id/restore - without a landlord (I3)', () => {
  it('restores ownerless: landlordId and the old row removed, primary cleared, audit landlordCleared', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-10');
    const res = await restore(app, 'u-10', { landlordId: null });
    expect(res.status).toBe(200);
    const stored = world.units.get('u-10');
    expect(stored?.deleted_at).toBeUndefined();
    expect(hasLandlordId(stored)).toBe(false);
    expect(stored?.primary_contact).toBeUndefined();
    expect(stored?.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    expect(restoredEvents(world)[0]?.payload).toMatchObject({ landlordCleared: { from: 'c-old' } });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordReplaced');
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsRestoreLandlord.test.ts
```

Expected RED: the two `409s restore_needs_landlord` cases, the `400s` case,
the `restores with the chosen landlord`, `409s landlord_not_landlord`,
`404s landlord_not_found`, `409s unit_roster_conflict` and
`restores ownerless` cases fail with `expected 200 to be ...` or on the
stored landlord / contacts - the route restores unconditionally and ignores
the body today. The (PIN) cases pass.

**Step 3 - implementation, `app/src/routes/units.ts`.** Replace the restore
handler body. Before:

```ts
  router.post('/:unitId/restore', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    let unit;
    try {
      unit = await units.restore(unitId);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`units#${unitId}`, 'unit_restored', { actor: req.user?.userId });
    log.info({ unitId, actor: req.user?.userId }, 'unit restored via api');
    res.json({ unit });
  });
```

After:

```ts
  router.post('/:unitId/restore', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    // caseworker-integrity I3 (spec 2026-10-12 section 4 "Restore", Cameron
    // 2026-10-12): a property comes back live only with a landlord of record
    // typed `landlord`, or with none - and restore never dead-ends.
    //   - Plain restore (no `landlordId` key in the body): when the unit is
    //     ownerless or its landlordId names a contact typed `landlord`, restore
    //     exactly as before. Otherwise 409 restore_needs_landlord
    //     { landlordName? } and nothing is written.
    //   - { landlordId: <id> } restores AND makes that contact (404
    //     landlord_not_found / 409 landlord_not_landlord) the landlord of record;
    //     { landlordId: null } restores ownerless. Honored ONLY when the plain
    //     restore would refuse (otherwise ignored), in ONE conditional write
    //     (unitsRepo.restoreWithLandlord) on the landlordId read here - a
    //     concurrent change answers 409 unit_roster_conflict.
    //   - A unit that is NOT soft-deleted restores exactly as before with no
    //     check: nothing comes back to life, and restore must never become a
    //     way to reassign a live property's landlord.
    const raw: unknown = req.body;
    const body =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const choosesLandlord = Object.prototype.hasOwnProperty.call(body, 'landlordId');
    const choice = body['landlordId'];
    if (choosesLandlord && choice !== null && (typeof choice !== 'string' || choice.length === 0)) {
      res.status(400).json({ error: 'landlordId must be a contact id or null' });
      return;
    }

    const stored = await units.getById(unitId, { consistentRead: true });
    if (stored === undefined) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const storedLandlordId =
      typeof stored.landlordId === 'string' && stored.landlordId.length > 0 ? stored.landlordId : undefined;
    let needsLandlord = false;
    let landlordName: string | undefined;
    if (isDeleted(stored) && storedLandlordId !== undefined) {
      const current = await contacts.getById(storedLandlordId, { consistentRead: true });
      if (current === undefined || current.type !== 'landlord') {
        needsLandlord = true;
        landlordName = current === undefined ? undefined : displayNameOfContact(current);
      }
    }

    if (!needsLandlord) {
      let unit;
      try {
        unit = await units.restore(unitId);
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          res.status(404).json({ error: 'unit_not_found' });
          return;
        }
        throw err;
      }
      await audit.append(`units#${unitId}`, 'unit_restored', { actor: req.user?.userId });
      log.info({ unitId, actor: req.user?.userId }, 'unit restored via api');
      res.json({ unit });
      return;
    }

    if (!choosesLandlord) {
      log.info({ unitId, actor: req.user?.userId }, 'unit restore refused: the landlord of record is not a landlord');
      res.status(409).json({
        error: 'restore_needs_landlord',
        ...(landlordName !== undefined && { landlordName }),
      });
      return;
    }

    let next: { contactId: string; name?: string; company?: string } | null = null;
    if (typeof choice === 'string') {
      let landlord: ContactItem;
      try {
        landlord = await requireLandlordContact(contacts, choice);
      } catch (err) {
        if (sendContactTypeError(err, res)) return;
        throw err;
      }
      const name = displayNameOfContact(landlord);
      const company = typeof landlord['company'] === 'string' ? (landlord['company'] as string) : undefined;
      next = {
        contactId: choice,
        ...(name !== undefined && { name }),
        ...(company !== undefined && { company }),
      };
    }

    let restored: UnitItem;
    try {
      restored = await units.restoreWithLandlord(unitId, { expectLandlordId: storedLandlordId, next });
    } catch (err) {
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
    await audit.append(`units#${unitId}`, 'unit_restored', {
      actor: req.user?.userId,
      ...(next !== null
        ? { landlordReplaced: { from: storedLandlordId, to: next.contactId } }
        : { landlordCleared: { from: storedLandlordId } }),
    });
    log.info(
      { unitId, actor: req.user?.userId, landlordCleared: next === null },
      'unit restored via api with a landlord change',
    );
    // The enriched roster (the roster routes' shape) so the Contacts card can
    // apply the new landlord of record in place.
    res.json({ unit: { ...restored, contacts: await enrichRoster(restored) } });
  });
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsRestoreLandlord.test.ts test/unitsSoftDelete.test.ts test/unitsApiActivity.test.ts
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add app/src/routes/units.ts app/test/unitsRestoreLandlord.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(units): restore refuses a non-landlord landlord of record and offers a landlord or none (I3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.7 - Dashboard endpoint: restoreUnit(unitId, opts?)

**Goal.** Plan section 2: `restoreUnit(unitId, opts?: { landlordId: string | null })`
- body only when `opts` is given; without `opts` the call is byte-for-byte
today's (`{ method: 'POST' }`).

**Files:** `dashboard/src/api/endpoints.ts`; `dashboard/src/api/endpoints.test.ts`.

**Step 1 - failing test.** In `dashboard/src/api/endpoints.test.ts`:

Import. Before:

```ts
  clearPlacementFollowUp,
  setListingStatus,
```

After:

```ts
  clearPlacementFollowUp,
  restoreUnit,
  setListingStatus,
```

Append a test. Before:

```ts
    body: { action: 'dismiss' },
  });
});
```

After:

```ts
    body: { action: 'dismiss' },
  });
});

it('restoreUnit POSTs no body by default, and { landlordId } only when given (caseworker-integrity)', async () => {
  vi.mocked(request).mockResolvedValue({ unit: { unitId: 'u1', status: 'available' } });

  await restoreUnit('u1');
  expect(request).toHaveBeenLastCalledWith('/api/units/u1/restore', { method: 'POST' });

  await restoreUnit('u 1', { landlordId: 'c-nora' });
  expect(request).toHaveBeenLastCalledWith('/api/units/u%201/restore', {
    method: 'POST',
    body: { landlordId: 'c-nora' },
  });

  const u = await restoreUnit('u1', { landlordId: null });
  expect(request).toHaveBeenLastCalledWith('/api/units/u1/restore', {
    method: 'POST',
    body: { landlordId: null },
  });
  expect(u).toEqual({ unitId: 'u1', status: 'available' });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/endpoints.test.ts
```

Expected RED: the new test fails at the second assertion - today's
`restoreUnit` ignores a second argument and posts `{ method: 'POST' }` with no
body. (`npm run typecheck` would also fail: "Expected 1 arguments, but got 2".)

**Step 3 - implementation, `dashboard/src/api/endpoints.ts`.** Before:

```ts
/** POST /api/units/:id/restore - clear deleted_at, bringing a soft-deleted property
 *  back into the normal views. Returns the updated unit. */
export async function restoreUnit(unitId: string): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/restore`,
    { method: 'POST' },
  );
  return res.unit;
}
```

After:

```ts
/** POST /api/units/:id/restore - clear deleted_at, bringing a soft-deleted property
 *  back into the normal views. Returns the updated unit.
 *  caseworker-integrity (spec section 4 "Restore"): with no `opts` this is the
 *  plain restore (no body). 409 restore_needs_landlord { landlordName? } means
 *  the stored landlord can't stay the property's landlord; call again with
 *  `{ landlordId: <a landlord's contactId> }` to restore with that landlord, or
 *  `{ landlordId: null }` to restore without one (404 landlord_not_found /
 *  409 landlord_not_landlord / 409 unit_roster_conflict). */
export async function restoreUnit(
  unitId: string,
  opts?: { landlordId: string | null },
): Promise<UnitItem> {
  const res = await request<{ unit: UnitItem }>(
    `/api/units/${encodeURIComponent(unitId)}/restore`,
    { method: 'POST', ...(opts !== undefined && { body: { landlordId: opts.landlordId } }) },
  );
  return res.unit;
}
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/endpoints.test.ts src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/api/endpoints.ts dashboard/src/api/endpoints.test.ts
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(dashboard): restoreUnit takes an optional landlord choice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.8 - Add contact picker hides caseworkers (I4)

**Goal.** Spec section 4 "Contact list (I4)": the property Add contact picker
(`ListingDetail.tsx:367`, fed by `useContacts('all')` at :194, rendered at
:967-986) never offers a caseworker (`isCaseworkerContact`,
`dashboard/src/routes/contact/caseworkerRole.ts:42`). Other kinds still show;
an already-seated caseworker's row is untouched (it is not a candidate).

**Files:** `dashboard/src/routes/listing/ListingDetail.tsx`;
`dashboard/src/routes/listing/ListingDetail.test.tsx`.

**Step 1 - failing test.** In `ListingDetail.test.tsx`, inside
`describe('ListingDetail - Contacts card edit mode', ...)`. Before:

```tsx
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });
```

After:

```tsx
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });

  it('the Add contact picker never offers a caseworker (I4) - other kinds still show', async () => {
    const user = userEvent.setup();
    useContacts.mockImplementation((filter: string) =>
      filter === 'deleted'
        ? { status: 'ready', contacts: [] }
        : {
            status: 'ready',
            contacts: [
              { contactId: 'pm9', type: 'landlord', status: 'active', firstName: 'Renata', lastName: 'Vale', phone: '+14045550188' },
              { contactId: 'cw1', type: 'partner', role: 'Caseworker', status: 'active', firstName: 'Renee', lastName: 'Casey', phone: '+14045550199' },
              { contactId: 'pt1', type: 'partner', role: 'Navigator', status: 'active', firstName: 'Renaldo', lastName: 'Park', phone: '+14045550177' },
            ],
          },
    );
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: '+ Add contact' }));
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Ren');

    expect(screen.getByRole('option', { name: /Renata Vale/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Renaldo Park/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Renee Casey/ })).not.toBeInTheDocument();
  });
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

Expected RED: the new test fails on the last assertion - the caseworker
"Renee Casey" is offered today (the candidates filter only drops rostered ids).

**Step 3 - implementation, `dashboard/src/routes/listing/ListingDetail.tsx`.**

Import. Before:

```tsx
import { Modal } from '../contact/Modal.js';
```

After:

```tsx
import { Modal } from '../contact/Modal.js';
import { isCaseworkerContact } from '../contact/caseworkerRole.js';
```

Candidates. Before:

```tsx
  /** Search candidates for "+ Add contact": every live contact NOT already on
   *  the roster (re-adding a rostered contact is a re-role, which the row's own
   *  selector does). */
  const addContactCandidates = contactsList.filter((c) => !rosteredIds.has(c.contactId));
```

After:

```tsx
  /** Search candidates for "+ Add contact": every live contact NOT already on
   *  the roster (re-adding a rostered contact is a re-role, which the row's own
   *  selector does). Never a caseworker: a caseworker can't take a NEW seat on
   *  a property's contact list (caseworker-integrity I4; the server refuses
   *  with 409 contact_list_caseworker). */
  const addContactCandidates = contactsList.filter(
    (c) => !rosteredIds.has(c.contactId) && !isCaseworkerContact(c),
  );
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(dashboard): the property Add contact picker never offers a caseworker (I4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.9 - runRosterWrite names the new refusals before its 409 catch-all

**Goal.** Spec section 4 "Dashboard copy": `runRosterWrite`
(`ListingDetail.tsx:388-421`) maps `contact_list_caseworker` and
`landlord_not_landlord` (any code `contactTypeErrorMessage` knows) to their
sentences BEFORE its 409 catch-all `ROSTER_CONFLICT_COPY` (:115-116, which
would claim "landlord of record"). Nothing was written on such a refusal, so
there is no refetch; the form keeps the pick. Other failures keep today's
copy.

**Files:** `dashboard/src/routes/listing/ListingDetail.tsx`;
`dashboard/src/routes/listing/ListingDetail.test.tsx`.

**Step 1 - failing test.** In `ListingDetail.test.tsx`, inside the Contacts
card describe. Before:

```tsx
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This property already has a landlord of record - reassign it before choosing Landlord.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });
```

After:

```tsx
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This property already has a landlord of record - reassign it before choosing Landlord.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });

  it.each([
    ['contact_list_caseworker', "Caseworkers can't be on a property's contact list."],
    ['landlord_not_landlord', "Only a landlord can be a property's landlord of record."],
  ] as const)(
    'a %s refusal names its own reason - not the landlord-of-record catch-all - and does not refetch',
    async (code, sentence) => {
      const user = userEvent.setup();
      useListing.mockReturnValue(ROSTER_READY);
      getUnit.mockReset();
      addUnitContact.mockReset().mockRejectedValue(new ApiError(409, code, code, { error: code }));
      renderAt();

      await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
      await user.click(screen.getByRole('button', { name: '+ Add contact' }));
      await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
      await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
      await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(sentence);
      expect(alert).not.toHaveTextContent(/landlord of record now/);
      expect(getUnit).not.toHaveBeenCalled();
      expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
    },
  );
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

Expected RED: both new cases fail - the alert reads today's catch-all
"That contact is the landlord of record now - reassign the property's
landlord first." and `getUnit` is called (the 409 refetch; with the mock
reset it resolves `undefined`, so the case may also error on render - still
red for the same reason).

**Step 3 - implementation, `dashboard/src/routes/listing/ListingDetail.tsx`.**

Import. Before:

```tsx
import { safeHttpUrl } from '../../lib/safeUrl.js';
```

After:

```tsx
import { safeHttpUrl } from '../../lib/safeUrl.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

The catch. Before:

```tsx
      .catch(async (err: unknown) => {
        const conflict = err instanceof ApiError && err.status === 409;
```

After:

```tsx
      .catch(async (err: unknown) => {
        // caseworker-integrity (spec section 4): a contact-type refusal
        // (contact_list_caseworker, landlord_not_landlord) names its own reason.
        // Mapped BEFORE the 409 catch-all below, whose copy would otherwise
        // claim "landlord of record". Nothing was written, so nothing to settle.
        const typed = contactTypeErrorMessage(err);
        if (typed !== null) {
          setRosterError({ key, message: typed });
          return;
        }
        const conflict = err instanceof ApiError && err.status === 409;
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(dashboard): contact-list type refusals name their own reason, not the landlord-of-record catch-all" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.10 - RestoreLandlordDialog (the restore landlord picker)

**Goal.** Spec section 4 "Restore" dashboard dialog as a self-contained
component (kept out of `ListingDetail.tsx` to keep that shared file's diff
small; plan section 0 PARALLEL WORK): the sentence with `landlordName` or
"This property's landlord"; a landlords-only picker from the same source as
the New property picker (`getAllContacts({ type: 'landlord' }, signal)`,
`UnitCreateForm.tsx:143`); "Restore with this landlord" (disabled until a
pick) -> `restoreUnit(unitId, { landlordId })`; "Restore without a landlord"
-> `restoreUnit(unitId, { landlordId: null })`; "Cancel". Errors: the
`contactTypeErrorMessage` sentence (landlord_not_landlord /
landlord_not_found); 409 `unit_roster_conflict` -> the EXISTING
`ROSTER_RETRY_COPY` + `onConflict` (the caller re-reads); anything else ->
"Couldn't restore - please try again." (CONTRACT ISSUE 8).

One literal for the retry sentence (plan review R1 row 6): `ROSTER_RETRY_COPY`
is today a module-private `const` in `ListingDetail.tsx` (:123). This task
MOVES it, unchanged, into a new two-line shared module
`dashboard/src/routes/listing/rosterCopy.ts`, and both `ListingDetail.tsx`
(`runRosterWrite`, unchanged) and the dialog import it from there. (Not
exported from `ListingDetail.tsx` itself: Task 4.11 makes `ListingDetail.tsx`
import the dialog, so the dialog importing back from `ListingDetail.tsx`
would be an import cycle.) No second literal of the sentence exists in source;
the tests keep pinning the sentence verbatim, as every copy test here does.

**Files:** NEW `dashboard/src/routes/listing/RestoreLandlordDialog.tsx`;
NEW `dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx`;
NEW `dashboard/src/routes/listing/rosterCopy.ts`;
`dashboard/src/routes/listing/ListingDetail.tsx` (the constant moves out).

**Step 1 - failing test.** Create
`dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx`:

```tsx
// RestoreLandlordDialog (caseworker-integrity spec 2026-10-12 section 4
// "Restore"): the sentence, the landlords-only picker, and the three actions.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, UnitItem } from '../../api/index.js';

const restoreUnit = vi.fn();
const getAllContacts = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
  };
});

import { RestoreLandlordDialog } from './RestoreLandlordDialog.js';

const LANDLORDS: Contact[] = [{ contactId: 'c-nora', type: 'landlord', firstName: 'Nora', lastName: 'Lane' }];
const RESTORED: UnitItem = { unitId: 'u1', landlordId: 'c-nora', status: 'available' };

function setup(props: { landlordName?: string } = {}) {
  const onRestored = vi.fn();
  const onConflict = vi.fn();
  const onClose = vi.fn();
  render(
    <RestoreLandlordDialog
      unitId="u1"
      {...props}
      onRestored={onRestored}
      onConflict={onConflict}
      onClose={onClose}
    />,
  );
  return { onRestored, onConflict, onClose };
}

async function pickNora(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
  await user.type(screen.getByRole('combobox', { name: 'Landlord' }), 'Nora');
  await user.click(await screen.findByRole('option', { name: /Nora Lane/ }));
}

beforeEach(() => {
  restoreUnit.mockReset();
  getAllContacts.mockReset().mockResolvedValue(LANDLORDS);
});

describe('RestoreLandlordDialog', () => {
  it('names the stored landlord in the sentence', () => {
    setup({ landlordName: 'Lee Lord' });
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lee Lord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to This property's landlord when the server named no one", () => {
    setup();
    expect(
      screen.getByText(
        "This property's landlord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
  });

  it('reads its candidates from the landlords-only source (the New property picker source)', async () => {
    setup();
    await waitFor(() =>
      expect(getAllContacts).toHaveBeenCalledWith({ type: 'landlord' }, expect.any(AbortSignal)),
    );
  });

  it('Restore with this landlord is disabled until one is picked, then restores with that landlord', async () => {
    const user = userEvent.setup();
    restoreUnit.mockResolvedValue(RESTORED);
    const { onRestored } = setup();
    const withLandlord = screen.getByRole('button', { name: 'Restore with this landlord' });
    expect(withLandlord).toBeDisabled();
    await pickNora(user);
    expect(withLandlord).toBeEnabled();
    await user.click(withLandlord);
    expect(restoreUnit).toHaveBeenCalledWith('u1', { landlordId: 'c-nora' });
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(RESTORED));
  });

  it('Restore without a landlord restores with landlordId null', async () => {
    const user = userEvent.setup();
    restoreUnit.mockResolvedValue({ ...RESTORED, landlordId: undefined });
    const { onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenCalledWith('u1', { landlordId: null });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it('Cancel closes without restoring', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(restoreUnit).not.toHaveBeenCalled();
  });

  it('shows the landlord refusal sentence and stays open', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(
      new ApiError(409, 'landlord_not_landlord', 'landlord_not_landlord', { error: 'landlord_not_landlord' }),
    );
    const { onRestored } = setup();
    await pickNora(user);
    await user.click(screen.getByRole('button', { name: 'Restore with this landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Only a landlord can be a property's landlord of record.",
    );
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
  });

  it('a concurrent change asks for a retry and lets the caller re-read', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(
      new ApiError(409, 'unit_roster_conflict', 'unit_roster_conflict', { error: 'unit_roster_conflict' }),
    );
    const { onConflict, onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    expect(onConflict).toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('any other failure says the restore did not happen', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't restore - please try again.");
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/RestoreLandlordDialog.test.tsx
```

Expected RED: the file fails to load - `Failed to resolve import
"./RestoreLandlordDialog.js"` (the component does not exist yet).

**Step 3 - implementation.**

(a) Create `dashboard/src/routes/listing/rosterCopy.ts` with exactly:

```ts
// Staff copy shared by the property page's contact-list writes (ListingDetail
// runRosterWrite) and the restore landlord dialog (RestoreLandlordDialog), so
// the two sites show ONE sentence for the same 409 and cannot drift apart.

/** A 409 unit_roster_conflict: the property's contacts or its landlord of
 *  record changed under the request - nothing was written; try again. */
export const ROSTER_RETRY_COPY = 'The property contacts changed - try that change again.';
```

(b) Edit `dashboard/src/routes/listing/ListingDetail.tsx` - move the constant
out. old_string:

```tsx
  'This property already has a landlord of record - reassign it before choosing Landlord.';

const ROSTER_RETRY_COPY = 'The property contacts changed - try that change again.';
```

new_string:

```tsx
  'This property already has a landlord of record - reassign it before choosing Landlord.';
```

(c) Edit `dashboard/src/routes/listing/ListingDetail.tsx` - import it.
old_string:

```tsx
import { useListing } from './useListing.js';
```

new_string:

```tsx
import { useListing } from './useListing.js';
import { ROSTER_RETRY_COPY } from './rosterCopy.js';
```

(`runRosterWrite`'s `? ROSTER_RETRY_COPY` is unchanged and now reads the
import.)

(d) Create `dashboard/src/routes/listing/RestoreLandlordDialog.tsx`:

```tsx
// RestoreLandlordDialog - Restore for a property whose stored landlord can't
// stay its landlord (caseworker-integrity spec 2026-10-12 section 4
// "Restore", Cameron 2026-10-12). A property comes back live only with a
// landlord of record typed `landlord`, or with none, and restore never
// dead-ends: when the plain restore answers 409 restore_needs_landlord,
// ListingDetail opens this dialog - pick a landlord (the same landlords-only
// source as the New property picker, UnitCreateForm) or restore without one.
// Staff can add a landlord later from the Contacts card (Add contact, role
// Landlord), which claims an empty slot.
import { useEffect, useState } from 'react';
import { ApiError, getAllContacts, restoreUnit, type Contact, type UnitItem } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
import { ContactSearchField, type ContactSearchValue } from '../contact/ContactSearchField.js';
import { Modal } from '../contact/Modal.js';
// The roster's own sentence for the same 409 unit_roster_conflict (the
// landlord changed under the request) - one shared literal, never a copy.
import { ROSTER_RETRY_COPY } from './rosterCopy.js';
import styles from './ListingDetail.module.css';

/** Any other failure: nothing was restored. */
const RESTORE_FAILED_COPY = "Couldn't restore - please try again.";

export interface RestoreLandlordDialogProps {
  unitId: string;
  /** The stored landlord's display name from the 409 body, when it exists. */
  landlordName?: string;
  /** The restored unit (with its enriched contacts) - the caller applies it. */
  onRestored: (unit: UnitItem) => void;
  /** A 409 unit_roster_conflict: the caller re-reads the property. */
  onConflict: () => void;
  onClose: () => void;
}

export function RestoreLandlordDialog({
  unitId,
  landlordName,
  onRestored,
  onConflict,
  onClose,
}: RestoreLandlordDialogProps): React.JSX.Element {
  const [landlords, setLandlords] = useState<Contact[]>([]);
  const [pick, setPick] = useState<ContactSearchValue>({ name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        // EVERY page, landlords only - the New property picker's source.
        const items = await getAllContacts({ type: 'landlord' }, ac.signal);
        if (!ac.signal.aborted) setLandlords(items);
      } catch {
        // Non-fatal: the picker stays empty; "Restore without a landlord" still works.
      }
    })();
    return () => ac.abort();
  }, []);

  const run = (landlordId: string | null): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void restoreUnit(unitId, { landlordId })
      .then((unit) => onRestored(unit))
      .catch((err: unknown) => {
        const typed = contactTypeErrorMessage(err);
        if (typed !== null) {
          setError(typed);
          return;
        }
        if (err instanceof ApiError && err.status === 409 && err.code === 'unit_roster_conflict') {
          setError(ROSTER_RETRY_COPY);
          onConflict();
          return;
        }
        setError(RESTORE_FAILED_COPY);
      })
      .finally(() => setBusy(false));
  };

  const who = landlordName ?? "This property's landlord";
  const pickedId = pick.contactId;
  return (
    <Modal
      title="Restore property"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className={styles.confirmActions}>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => run(null)} disabled={busy}>
            Restore without a landlord
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => {
              if (pickedId !== undefined) run(pickedId);
            }}
            disabled={pickedId === undefined || busy}
          >
            Restore with this landlord
          </Button>
        </div>
      }
    >
      <p>{`${who} is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:`}</p>
      <ContactSearchField
        value={pick}
        onChange={setPick}
        candidates={landlords}
        inputLabel="Landlord"
        disabled={busy}
      />
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/RestoreLandlordDialog.test.tsx src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; npm run typecheck
cd "W:/tmp/caseworker-integrity"; git grep --untracked -n "The property contacts changed - try that change again." -- dashboard/src ':!*.test.tsx'
```

Expected: both files pass (ListingDetail's existing `unit_roster_conflict`
case still reads the moved constant); typecheck exit 0; the `git grep` prints
exactly ONE line, in `dashboard/src/routes/listing/rosterCopy.ts` - the only
source literal of the sentence (`--untracked`: the new file is not committed
yet).

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < dashboard/src/routes/listing/rosterCopy.ts | wc -c
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/listing/RestoreLandlordDialog.tsx dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx dashboard/src/routes/listing/rosterCopy.ts dashboard/src/routes/listing/ListingDetail.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(dashboard): restore dialog - choose a landlord or restore without one" -m "The in-dialog unit_roster_conflict reads the roster's existing ROSTER_RETRY_COPY, moved unchanged from ListingDetail.tsx into the shared rosterCopy.ts so both sites import one literal." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.11 - ListingDetail: a restore that needs a landlord opens the dialog

**Goal.** Spec section 4 "Restore" dashboard: on 409 `restore_needs_landlord`
from the plain Restore (`onRestore`, `ListingDetail.tsx:346-355`, shared by
all three entry points - CONTRACT ISSUE 12), open `RestoreLandlordDialog`
with the body's `landlordName`. A successful dialog restore closes it and
applies the returned unit with `applyRosterUnit` (unit + Contacts card,
CONTRACT ISSUE 9). A dialog conflict re-reads the property (`getUnit`),
applies the re-read with `applyRosterUnit` too (page AND Contacts card - the
pattern `runRosterWrite`'s 409 path uses, `ListingDetail.tsx:415`; plan review
R1 row 5), and closes the dialog if the re-read shows the property already
restored. In the normal case Restore behaves exactly as today (no dialog).

**Files:** `dashboard/src/routes/listing/ListingDetail.tsx`;
`dashboard/src/routes/listing/ListingDetail.test.tsx`.

**Step 1 - failing test.** In `ListingDetail.test.tsx`, at the end of the
first `describe('ListingDetail', ...)`. Before:

```tsx
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(setUnit).toHaveBeenCalled());
  });
});
```

After:

```tsx
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(setUnit).toHaveBeenCalled());
    // The normal case: no landlord dialog.
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();
  });

  it('a restore that needs a landlord opens the landlord dialog; restoring through it applies the unit and closes it', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    const restored = { ...READY.unit!, landlordId: 'll9' };
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockResolvedValueOnce(restored);
    getAllContacts.mockReset().mockResolvedValue([]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    expect(
      within(dialog).getByText(
        "James Porter is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    expect(setUnit).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenLastCalledWith('u1', { landlordId: null });
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(restored));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
  });

  it('a conflict inside the landlord dialog re-reads the property into the page AND the Contacts card, and keeps the dialog while it is still deleted', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    // The concurrent change put a new landlord of record on the property: the
    // re-read carries its enriched contact row, which the Contacts card must show.
    const fresh = {
      ...READY.unit!,
      landlordId: 'll2',
      deleted_at: '2026-06-19T00:00:00.000Z',
      contacts: [{ contactId: 'll2', role: 'landlord' as const, primaryContact: true, name: 'Nora Lane' }],
    };
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', { error: 'restore_needs_landlord' }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'unit_roster_conflict', 'unit_roster_conflict', { error: 'unit_roster_conflict' }),
      );
    getUnit.mockReset().mockResolvedValue(fresh);
    getAllContacts.mockReset().mockResolvedValue([]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    expect(
      within(dialog).getByText(
        "This property's landlord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(fresh));
    // applyRosterUnit, not setUnit alone: the Contacts card renders the
    // re-read's landlord row (useListing is mocked, so only the card's own
    // roster state can show it).
    expect(await screen.findByText('Nora Lane')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
  });
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

Expected RED: both new cases time out on
`findByRole('dialog', { name: 'Restore property' })` - today `onRestore`
swallows every restore failure, so no dialog opens. The edited existing case
still passes.

**Step 3 - implementation, `dashboard/src/routes/listing/ListingDetail.tsx`.**

(a) Import. Before:

```tsx
import { ListingEditForm } from './ListingEditForm.js';
```

After:

```tsx
import { ListingEditForm } from './ListingEditForm.js';
import { RestoreLandlordDialog } from './RestoreLandlordDialog.js';
```

(b) Helper after `photoUploadMessage`. Before:

```tsx
    default:
      return "Couldn't upload the photos - please try again.";
  }
}
```

After:

```tsx
    default:
      return "Couldn't upload the photos - please try again.";
  }
}

/** The stored landlord's name a 409 restore_needs_landlord carries, when it
 *  names one (caseworker-integrity spec section 4 "Restore"). */
function restoreLandlordName(err: ApiError): string | undefined {
  const body = err.body;
  if (body === null || typeof body !== 'object') return undefined;
  const name = (body as Record<string, unknown>)['landlordName'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}
```

(c) State (with the other hooks, before the early returns). Before:

```tsx
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

After:

```tsx
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // caseworker-integrity (spec section 4 "Restore"): set when a plain restore
  // answered 409 restore_needs_landlord - opens the landlord dialog.
  const [restoreNeeds, setRestoreNeeds] = useState<{ landlordName?: string } | null>(null);
```

(d) `onRestore`. Before:

```tsx
  const onRestore = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    void restoreUnit(unit.unitId)
      .then((updated) => setUnit(updated))
      .catch(() => {
        /* leave it deleted; the action re-enables for a retry */
      })
      .finally(() => setDeleteBusy(false));
  };
```

After:

```tsx
  const onRestore = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    void restoreUnit(unit.unitId)
      .then((updated) => setUnit(updated))
      .catch((err: unknown) => {
        // The stored landlord can't stay this property's landlord (gone, or no
        // longer a landlord): choose one - or none - in the dialog instead of
        // a dead click (caseworker-integrity spec section 4 "Restore").
        if (err instanceof ApiError && err.status === 409 && err.code === 'restore_needs_landlord') {
          const landlordName = restoreLandlordName(err);
          setRestoreNeeds(landlordName !== undefined ? { landlordName } : {});
          return;
        }
        /* any other failure: leave it deleted; the action re-enables for a retry */
      })
      .finally(() => setDeleteBusy(false));
  };
```

(e) Render the dialog after the delete confirm. Before:

```tsx
          {deleteError !== null ? (
            <p role="alert" className={styles.error}>
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}
```

After:

```tsx
          {deleteError !== null ? (
            <p role="alert" className={styles.error}>
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {/* caseworker-integrity (spec section 4 "Restore"): the stored landlord
          can't stay this property's landlord - choose one, or restore
          without. The restored unit carries its enriched roster, so it is
          applied to the Contacts card too. */}
      {restoreNeeds !== null ? (
        <RestoreLandlordDialog
          unitId={unit.unitId}
          {...(restoreNeeds.landlordName !== undefined && { landlordName: restoreNeeds.landlordName })}
          onRestored={(updated) => {
            setRestoreNeeds(null);
            applyRosterUnit(updated);
          }}
          onConflict={() => {
            void getUnit(unit.unitId)
              .then((fresh) => {
                // The re-read is the new truth for the page AND the Contacts
                // card (its landlord row may have changed) - the same settle
                // runRosterWrite's 409 path uses (plan review R1 row 5).
                applyRosterUnit(fresh);
                if (!(typeof fresh.deleted_at === 'string' && fresh.deleted_at.length > 0)) {
                  setRestoreNeeds(null);
                }
              })
              .catch(() => {
                /* best-effort re-read; the dialog's retry message stands */
              });
          }}
          onClose={() => setRestoreNeeds(null)}
        />
      ) : null}
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx src/routes/listing/ListingActionsMenu.test.tsx
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "feat(dashboard): a restore that needs a landlord opens the landlord dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.12 - UnitCreateForm shows the landlord refusals

**Goal.** Spec section 4 "Dashboard copy" site `UnitCreateForm`: a create
refused with 409 `landlord_not_landlord` / 404 `landlord_not_found` shows
the shared sentence (`contactTypeErrorMessage`) inline; the dialog stays open
and Create re-enables. The org-list 422 path and the generic fallback are
unchanged.

**Files:** `dashboard/src/routes/listing/UnitCreateForm.tsx`;
`dashboard/src/routes/listing/UnitCreateForm.test.tsx`.

**Step 1 - failing test.** In `UnitCreateForm.test.tsx`, inside the first
`describe('UnitCreateForm', ...)`. Before:

```tsx
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
    expect(onCreated).not.toHaveBeenCalled();
  });
});
```

After:

```tsx
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
    expect(onCreated).not.toHaveBeenCalled();
  });

  // caseworker-integrity I3 (spec section 4): the owning landlord was refused.
  it.each([
    ['landlord_not_landlord', 409, "Only a landlord can be a property's landlord of record."],
    ['landlord_not_found', 404, 'That landlord no longer exists.'],
  ] as const)(
    'shows the server landlord refusal %s as its sentence; the dialog stays open',
    async (code, status, sentence) => {
      const user = userEvent.setup();
      createUnit.mockRejectedValue(new ApiError(status, code, code, { error: code }));
      const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });

      await screen.findByRole('dialog', { name: 'New property' });
      await user.click(screen.getByRole('button', { name: /^Create$/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
      expect(screen.getByRole('dialog', { name: 'New property' })).toBeInTheDocument();
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
    },
  );
});
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/UnitCreateForm.test.tsx
```

Expected RED: both new cases fail - the alert shows today's generic
"Couldn't create the property ... please try again." instead of the sentence.

**Step 3 - implementation, `dashboard/src/routes/listing/UnitCreateForm.tsx`.**

Import. Before:

```tsx
import { contactDisplayName } from '../contact/format.js';
```

After:

```tsx
import { contactDisplayName } from '../contact/format.js';
import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';
```

The catch. Before:

```tsx
      const refused = orgNotOnListBody(err);
      if (refused !== null) {
        setAuthoritiesError(notOnListMessage(refused));
        setBusy(false);
        return;
      }
```

After:

```tsx
      const refused = orgNotOnListBody(err);
      if (refused !== null) {
        setAuthoritiesError(notOnListMessage(refused));
        setBusy(false);
        return;
      }
      // caseworker-integrity I3 (spec section 4): the owning landlord was
      // refused - gone (404 landlord_not_found) or no longer a landlord (409
      // landlord_not_landlord). Say which, never the raw code.
      const typed = contactTypeErrorMessage(err);
      if (typed !== null) {
        setError(typed);
        setBusy(false);
        return;
      }
```

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/UnitCreateForm.test.tsx
```

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/routes/listing/UnitCreateForm.tsx dashboard/src/routes/listing/UnitCreateForm.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(dashboard): New property names a refused landlord of record" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4.13 - Ownerless properties: the dashboard type says `landlordId` is optional, and ListingDetail's primary-removal notice tolerates one

**Goal.** CONTRACT ISSUE 10 + plan review R1 row 11. "Restore without a
landlord" makes an ownerless property (no `landlordId` on the wire) a routine
outcome, but the dashboard's `UnitItem` (`dashboard/src/api/types.ts:2435`)
still declares `landlordId: string` (required), so TypeScript cannot flag an
unguarded read. Make it `landlordId?: string` - the wire truth - and fix every
compile error that causes. `ListingDetail.tsx:290` + `:473`
(`landlordOfRecord.length`) is the one such read today: it crashes the
"Remove the primary contact?" dialog for an ownerless property. Read a
missing landlordId as `''` (the existing "no landlord" branch). Kept in scope
(ruling S4-10).

Breaking sites, measured by the planner on 2026-10-12 (type-probe of
`landlordId?: string` on the base tree, `npx tsc -p tsconfig.json --noEmit`
in `dashboard/`, then reverted): exactly ONE -
`src/routes/listing/ListingDetail.tsx(473,7): error TS18048: 'landlordOfRecord' is possibly 'undefined'.`
(the `landlordOfRecord.length > 0` read in `promotionNotice`, fed by the
`landlordOfRecord` assignment at :290). Every other dashboard read of a
unit's `landlordId` already guards a missing value
(`buildListingFile.ts:64-65,97-98` `if (!landlordId) return []`;
`buildContactFile.ts:19` and `useContactFile.ts:168` compare with `===`;
`useListing.ts:119` already takes `string | undefined`), and no S1-S4 task
adds a new read. Step 3 fixes the one site; if the Step 3b typecheck reports
ANY other site (for example one added by a parallel branch synced in later),
fix it the same way - read a missing `landlordId` as "no landlord", never
with a non-null assertion - and list it in the slice report; if more than
five sites break, STOP and record them in the slice report instead of fixing
them in this task (ruling row 11).

**Files:** `dashboard/src/api/types.ts`;
`dashboard/src/routes/listing/ListingDetail.tsx`;
`dashboard/src/routes/listing/ListingDetail.test.tsx`.

**Step 1 - failing test.** In `ListingDetail.test.tsx`, inside the Contacts
card describe. Before:

```tsx
    expect(
      within(dialog).getByText(
        'This property will have no primary contact - tours fall back to the landlord of record.',
      ),
    ).toBeInTheDocument();
  });
```

After:

```tsx
    expect(
      within(dialog).getByText(
        'This property will have no primary contact - tours fall back to the landlord of record.',
      ),
    ).toBeInTheDocument();
  });

  it('an OWNERLESS property (no landlordId at all, e.g. restored without a landlord) names the NO-primary outcome without crashing', async () => {
    const user = userEvent.setup();
    const { landlordId: _dropped, ...ownerless } = ROSTER_UNIT;
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ownerless, contacts: [ROSTER_UNIT.contacts![0]!] } as NonNullable<ListingState['unit']>,
      roster: [ROSTER_READY.roster[0]!],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));

    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        'This property will have no primary contact - tours fall back to the landlord of record.',
      ),
    ).toBeInTheDocument();
  });
```

**Step 2 - RED.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx
```

Expected RED: the new case fails with
`TypeError: Cannot read properties of undefined (reading 'length')` from
`promotionNotice` while rendering the confirm dialog.

**Step 3 - implementation.**

(a) Edit `dashboard/src/api/types.ts` (inside `export interface UnitItem`).
old_string:

```ts
export interface UnitItem {
  unitId: string;
  landlordId: string;
```

new_string:

```ts
export interface UnitItem {
  unitId: string;
  /** The landlord of record's contactId. ABSENT on an ownerless property - a
   *  legacy one, or one restored without a landlord (caseworker-integrity spec
   *  section 4 "Restore") - so every read must handle "no landlord". */
  landlordId?: string;
```

(b) Prove the type now flags the unguarded read (a deliberate compile RED):

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx tsc -p tsconfig.json --noEmit
```

Expected: exit 2 with exactly one error,
`src/routes/listing/ListingDetail.tsx(<line>,7): error TS18048: 'landlordOfRecord' is possibly 'undefined'.`
- the `landlordOfRecord.length > 0` read in `promotionNotice` (line 473 on
the base tree; Tasks 4.9-4.11 shift it). Any OTHER error: handle it as the
Goal says (fix and list, or STOP past five).

(c) Edit `dashboard/src/routes/listing/ListingDetail.tsx`. old_string:

```tsx
  const landlordOfRecord = contactsUnit?.landlordId ?? unit.landlordId;
```

new_string:

```tsx
  // An ownerless property (legacy, or restored without a landlord -
  // caseworker-integrity section 4) has NO landlordId (UnitItem.landlordId is
  // optional); read it as '' (the "no landlord" branch) so nothing below
  // touches undefined.
  const landlordOfRecord: string = contactsUnit?.landlordId ?? unit.landlordId ?? '';
```

(`promotionNotice`'s `landlordOfRecord.length > 0` and the row loop's
`r.contactId === landlordOfRecord` then read a `string` and need no change.)

**Step 4 - GREEN.**

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx src/routes/listing/buildListingFile.test.ts src/routes/listing/RestoreLandlordDialog.test.tsx
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

Expected: all pass; typecheck exit 0 (the dashboard compiles with
`landlordId` optional).

**Step 5 - commit.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- dashboard/src/api/types.ts dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git add dashboard/src/api/types.ts dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx
cd "W:/tmp/caseworker-integrity"; git commit -m "fix(dashboard): a property's landlordId is optional in the dashboard type; the primary-removal notice tolerates an ownerless property" -m "Restore without a landlord makes ownerless properties routine, so UnitItem.landlordId is now optional - the wire truth - and the one unguarded read (ListingDetail promotionNotice) reads a missing landlord as none." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice gate

App (needs DynamoDB Local up):

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/unitsApi.test.ts test/unitsApiOrgNames.test.ts test/unitsApiRoster.test.ts test/unitsSoftDelete.test.ts test/unitsApiActivity.test.ts test/unitsApiPhotos.test.ts test/unitsLandlordOfRecord.test.ts test/unitsApiRosterTypeChecks.test.ts test/unitsRestoreLandlord.test.ts test/unitsRepoRestoreWithLandlord.integration.test.ts test/unitsRepoRoster.integration.test.ts
```

Dashboard:

```
cd "W:/tmp/caseworker-integrity/dashboard"; npx vitest run src/api/endpoints.test.ts src/routes/listing/ListingDetail.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx src/routes/listing/UnitCreateForm.test.tsx src/routes/listing/ListingActionsMenu.test.tsx
```

Types:

```
cd "W:/tmp/caseworker-integrity"; npm run typecheck
```

ASCII check on the new files (each prints 0):

```
cd "W:/tmp/caseworker-integrity"; for f in app/test/unitsLandlordOfRecord.test.ts app/test/unitsApiRosterTypeChecks.test.ts app/test/unitsRestoreLandlord.test.ts app/test/unitsRepoRestoreWithLandlord.integration.test.ts dashboard/src/routes/listing/RestoreLandlordDialog.tsx dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx dashboard/src/routes/listing/rosterCopy.ts; do tr -d '\11\12\15\40-\176' < "$f" | wc -c; done
```

(bash; for edited files check the added lines of `git diff`.)

Lint - AGENTS.md gate 5 scoped to S4's touched `.ts`/`.tsx` files (plan review R1 row 3;
procedure: section 0 "Lint at every slice gate"), bare:

```
cd "W:/tmp/caseworker-integrity"; npx eslint app/src/routes/units.ts app/src/repos/unitsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsApi.test.ts app/test/unitsApiOrgNames.test.ts app/test/unitsApiRoster.test.ts app/test/unitsSoftDelete.test.ts app/test/unitsLandlordOfRecord.test.ts app/test/unitsApiRosterTypeChecks.test.ts app/test/unitsRepoRestoreWithLandlord.integration.test.ts app/test/unitsRestoreLandlord.test.ts dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/endpoints.test.ts dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx dashboard/src/routes/listing/RestoreLandlordDialog.tsx dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx dashboard/src/routes/listing/rosterCopy.ts dashboard/src/routes/listing/UnitCreateForm.tsx dashboard/src/routes/listing/UnitCreateForm.test.tsx
```

Expected: exit 0 - every one of these files that exists at the merge base lints clean there
(planner, 2026-10-12), so ANY error is S4's and BLOCKING. If one is reported, confirm the
attribution with the section-0 merge-base baseline run on the same list, fix it, and re-run
until exit 0. Then run the section-0 coverage check (every path it prints must be in the
S1-S4 lists; Task 4.13's typecheck may have named an extra file to fix - lint it here too).

---

## Surfaces covered

| Spec bullet (section 4 / section 8 D3) | Task |
|---|---|
| `POST /api/units`: 404 `landlord_not_found`, 409 `landlord_not_landlord` | 4.2 |
| `PATCH /api/units/:id` with a CHANGED `landlordId`: same | 4.3 |
| `POST /api/units/:id/contacts` role `landlord` CLAIMING a vacant slot: 409 `landlord_not_landlord`; re-asserting the owner not checked | 4.4 |
| Contact list: caseworker NEW seat 409 `contact_list_caseworker` (any role); existing seat edits not refused; order caseworker -> landlord -> repo `landlord_reassignment_required` | 4.4 |
| Restore: new `UnitsRepo.restoreWithLandlord` (interface + real + every typed fake), one conditional write, row swap / clear, `primary_contact` consistent, conflict on a changed `landlordId` | 4.5 |
| Restore: plain (valid landlord, ownerless) as today; 409 `restore_needs_landlord { landlordName? }` (non-landlord, missing contact), nothing written | 4.6 |
| Restore with a landlord (404 / 409 contact checks, row swap, primary moved) | 4.5 (repo), 4.6 (route) |
| Restore without a landlord (ownerless after, row removed, primary cleared) | 4.5, 4.6 |
| A body ignored when the plain restore would not refuse; 409 `unit_roster_conflict` | 4.6 |
| Audit `unit_restored` gains `landlordReplaced { from, to }` / `landlordCleared { from }` | 4.6 |
| `endpoints.ts` `restoreUnit(unitId, opts?)` (body only with opts) | 4.7 |
| Add contact picker hides caseworkers | 4.8 |
| `runRosterWrite` maps the new codes BEFORE `ROSTER_CONFLICT_COPY` | 4.9 |
| Restore dialog: sentence, landlords-only picker (Add property's source), three actions | 4.10 (component), 4.11 (wiring on `onRestore`) |
| Dashboard copy site: the restore action | 4.10, 4.11 |
| Dashboard copy site: `UnitCreateForm` | 4.12 |
| W3: tests/fixtures that create units with a non-landlord landlordId, restore such a unit, or seat a caseworker | 4.1 (sweep table: app fixes listed; e2e clean) |
| Ownerless properties in the dashboard: `UnitItem.landlordId` optional (plan review R1 row 11) and ListingDetail's one unguarded read fixed (enabling fix, CONTRACT ISSUE 10) | 4.13 |
| Not in S4 (by the slice map): `contactTypeGuards.ts` / `contactTypeErrors.ts` (S3); seed invariant + e2e specs "Add contact hides a caseworker" (S5) | - |


---

# SLICE S5 (assembled from the section draft)

# S5 - Seeds, e2e, docs (caseworker integrity)

Slice S5 runs AFTER S1-S4 are built and committed. It adds no product code. It
adds: a seed invariant test over every seed world (5.1), an e2e fixture sweep
(5.2), four extended e2e specs (5.3-5.5), selector-registry rows (5.6), the
RUNBOOK edit (5.7), the three issue resolutions (5.8) and four new issues
(5.9: spec section 7's three, plus `unit-primary-contact-unchecked` from
plan review R1 row 7).

Researched against the tree at @54f9e6ed (main @19607658 + spec + plan
skeleton). Line numbers cited below are from that tree; S1-S4 shift some of
them - anchor on the quoted text, never on a line number.

## CONTRACT ISSUES

1. **(AMENDED by plan review R1 row 1 - the premise below is FALSE once S3
   Task 3.13 lands: after it, the Reopen and Reschedule dialogs show the
   contact-type sentence. Task 5.5 therefore drives the Reopen dialog in the
   UI and asserts its sentence; resolution (b) below is superseded where it
   says the tour refusals are proved at the API only.)**
   **No dashboard path reaches a TOUR I2 refusal at a site the spec lists;
   the tour dialogs answer every 409 with "This tour changed".** Spec section
   8 asks the e2e for "a refused tour action shows its sentence". Create is
   unreachable (pickers load tenants only, `ScheduleTourForm.tsx:179`).
   From-tour (`TourDetail.tsx:514`, :589) needs `convertible === true`
   (`app/src/routes/placements.ts:652`), which only the exit gate writes, on a
   `toured` tour (`app/src/routes/tours.ts:1283-1313`) - an OPEN status, so
   S2 refuses the re-type that would set the case up. Reopen and revive go
   through `ReopenTourModal` / `RescheduleTourModal` (`TourModals.tsx:439-490`,
   :177 via `DateTimeModal` :98-106), whose `failureCopy`
   (`TourModals.tsx:44-46`) maps EVERY 409 to `TOUR_CHANGED_COPY` (:39); spec
   section 4's copy-site list omits both dialogs, so after S3 as specified a
   reopen refused with `contact_not_tenant` reads "This tour changed since the
   page loaded - reload and try again." **Resolution:** (a) S3 should make
   `failureCopy` return `contactTypeErrorMessage(err)` when non-null, before
   its 409 rule (W7-safe), and unit-test both dialogs; (b) independent of (a),
   S5 proves the tour refusals at the API (reopen + revive, task 5.5) and the
   dashboard SENTENCE on the placement path the spec does list (a Lost
   placement moved back from the placement page, `PlacementDetail.tsx:402`,
   error bar :560-563). Recorded as F1/F2 in
   `docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/S5-findings.md`.
2. **The restore dialog's accessible name and its landlord picker's label are
   not bound.** Section 1 binds the dialog's sentence and button names only.
   **Resolution:** S5 finds the dialog by its sentence
   (`getByRole('dialog').filter({ hasText: 'is no longer a landlord' })`) and
   the picker as the dialog's only `combobox`, so any S4 title works. S4 MUST
   render the picker as the shared committed-pick `ContactSearchField` (as
   `UnitCreateForm`'s "Owning landlord", `UnitCreateForm.tsx:286-290`: role
   `combobox`, options `page.getByRole('option', { name })`) and keep exactly
   one combobox in the dialog. Proposed binding for S4: Modal title
   "Restore this property", picker `inputLabel` "Landlord".
3. **Section 0's "every task has at least one real RED case" cannot hold for
   S5's e2e and doc tasks.** They verify behavior S2-S4 already built RED-first
   in unit tests. Only 5.1 has a RED (its negative controls against a stubbed
   checker). The seed assertions themselves are PINs: evaluated in memory on
   the tree, every world (lean; full = lean + cast + matrix + live;
   performance + lean at default scale and with no generated contacts) has
   ZERO violations, and no seeded contact is a caseworker at all, so the I4
   seed rule is a guard for future seeds. **Resolution:** accept; 5.3-5.5 are
   e2e PIN tasks, 5.2 and 5.6-5.9 are doc/sweep tasks.
4. **The seed rule is deliberately stricter than I2.** I2 covers OPEN tours
   and placements; the S5 brief asks that EVERY seeded tour and placement name
   a contact typed `tenant`. All seeds satisfy the strict form today.
   **Resolution:** keep it strict (no seed needs a closed record on a
   non-tenant); the test's header says to relax it to open records only if a
   seed ever models a converted caseworker's closed history.
5. **S5's e2e depends on three S2-S4 render choices section 2 does not fix.**
   (a) The edit form's `type_change_refused` sentences and links render INSIDE
   the "Edit contact" dialog, links named exactly `View placement` /
   `View property`, and the KindPicker stays expanded with the draft segment
   `aria-pressed="true"`. (b) `PlacementDetail`'s refusal renders in the
   EXISTING `role="alert"` error bar (`PlacementDetail.tsx:560-563`), not a
   toast. (c) The restore dialog's buttons are named exactly as section 1's
   table. **Resolution:** S2/S4 builders keep these; if one differs, the S5
   builder changes the selector in the spec, never the product, and records it
   in the slice report.

## Tasks

Ground rules (section 0 applies; repeated where they bite):

- Absolute paths in every command; the shell's cwd resets.
- ASCII only in every new or touched line. New file check:
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints `0`. Edited file check:
  `git -C "W:/tmp/caseworker-integrity" diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints `0`.
- Edits with the Edit tool only (never a PowerShell read/replace/write
  pipeline). Nothing below contains a backslash-u escape - keep it that way
  (the Edit tool decodes them).
- e2e ONLY through the e2e workspace, single hop, so flags survive:
  `npm run e2e -w @housingchoice/e2e -- <spec path relative to e2e/> [--grep "<title>"]`
  from the worktree root. It boots its own hermetic lane. Never while an
  `npm run e2e:session` lane is live in this worktree; never edit app or
  dashboard source while it runs. If a run is aborted, run
  `cd "W:/tmp/caseworker-integrity"; npm run e2e:stop` before the next one.
- Commits: read `git status` first (a separate call), confirm no merge is in
  progress, stage explicit paths only, message ends with the trailer.

---

### Task 5.1 - Seed contact-type invariant test (every seed world)

**Goal.** Pin I2-I4 over every seeded world, built in memory the way the
seeders compose them: lean (`SEED`); full (`SEED` + `castItems()` +
`matrixItems(now)` + the live builder `buildLiveStaticItems(now)`,
`app/src/lib/seed/index.ts:110-163` and `live.ts:103,452`); performance on top
of lean (`resetPerformanceData` resets to lean first,
`app/src/lib/performanceSeed.ts:250-252`), at the default scale AND with no
generated contacts so the lean fallbacks (`performance.ts:508-510`) are
exercised. No DynamoDB access: every builder used is pure.

**Files.** Create `W:/tmp/caseworker-integrity/app/test/seedContactTypeInvariants.test.ts`.

**Step 1 - write the test with a STUB checker.** Create the file with exactly:

```ts
// Seed contact-type invariants (fix/caseworker-integrity; spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 1,
// I2-I4, and section 5 "Seeds"). Seeds are raw puts: none of the route checks
// that keep these rules run for them, so a seed that put a non-tenant on a
// tour or placement, named a non-landlord as a property's landlord of record,
// or seated a caseworker on a property's contact list would build a world the
// app itself refuses to build - and every lane and demo starts from a seed.
//
// Checked per WORLD, composed the way the seeders write it (a later layer's
// row replaces an earlier one with the same id, as a later PutCommand does):
//   - lean:        SEED (lib/seed/lean.ts) - the e2e world;
//   - full:        SEED + castItems() + matrixItems(now) (seedAll('full'),
//                  lib/seed/index.ts), then the live builder
//                  buildLiveStaticItems(now) (seedLive, lib/seed/live.ts);
//   - performance: SEED + the generated performance tables
//                  (resetPerformanceData resets to lean first,
//                  lib/performanceSeed.ts) - at the default scale, and with
//                  NO generated contacts, which exercises the lean fallbacks
//                  (contact-tenant-0001 / contact-landlord-0001).
//
// The rules. EVERY seeded tour and placement - open or closed - names a
// contact typed `tenant`: stricter than I2 (open records only) on purpose, as
// no seed needs a closed record on a non-tenant; relax it to open records only
// if a seed ever models a converted caseworker's closed history. Every LIVE
// unit with a `landlordId` names a contact typed `landlord` (an ownerless unit
// is a supported state; a soft-deleted one is fenced at restore). No unit's
// contact list - the stored `contacts[]`, else the row derived from
// `landlordId` (unitContacts) - seats a caseworker (isCaseworker,
// lib/caseworkers.ts), and every seat names a seeded contact. On 2026-10-12 no
// seed holds a caseworker at all, so the last rule guards future seeds.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import {
  generatePerformanceSeed,
  resolvePerformanceSeedConfig,
  type PerformanceSeedInput,
} from '../src/lib/seed/performance.js';
import { isCaseworker } from '../src/lib/caseworkers.js';
import { unitContacts, type UnitItem } from '../src/repos/unitsRepo.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix, live and performance are now-relative; a fixed instant makes them deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const ANCHOR = FIXED_NOW.toISOString();

function performanceTables(input: PerformanceSeedInput): Tables {
  return generatePerformanceSeed(resolvePerformanceSeedConfig(input, ANCHOR)).tables as unknown as Tables;
}

const WORLDS: Readonly<Record<string, readonly Tables[]>> = {
  lean: [SEED],
  full: [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)],
  performance: [SEED, performanceTables({})],
  'performance-lean-fallbacks': [SEED, performanceTables({ contacts: 0, nativeGroups: 0, conversations: 0 })],
};

interface WorldCheck {
  violations: string[];
  checked: { tours: number; placements: number; liveUnits: number; contactListRows: number };
}

/** Every I2-I4 violation in one composed world (later layers win). */
function seedTypeViolations(layers: readonly Tables[]): WorldCheck {
  void layers;
  return { violations: [], checked: { tours: 0, placements: 0, liveUnits: 0, contactListRows: 0 } };
}

describe('seed contact-type invariants (I2-I4) hold in every seeded world', () => {
  for (const [world, layers] of Object.entries(WORLDS)) {
    it(`${world}: tours and placements name tenants, live landlords are landlords, no caseworker on a contact list`, () => {
      const { violations, checked } = seedTypeViolations(layers);
      expect(violations, `${world} violations`).toEqual([]);
      // Not vacuous: the world holds what is checked (lean seeds no tours).
      expect(checked.placements, `${world} placements checked`).toBeGreaterThan(0);
      expect(checked.liveUnits, `${world} live units checked`).toBeGreaterThan(0);
      expect(checked.contactListRows, `${world} contact-list rows checked`).toBeGreaterThan(0);
      if (world !== 'lean') expect(checked.tours, `${world} tours checked`).toBeGreaterThan(0);
    });
  }
});

describe('the seed checker itself', () => {
  it('names each kind of violation, and skips what the rules allow', () => {
    const world: Tables = {
      contacts: [
        { contactId: 'c-tenant', type: 'tenant' },
        { contactId: 'c-landlord', type: 'landlord' },
        { contactId: 'c-caseworker', type: 'partner', role: 'Case Worker' },
        { contactId: 'c-partner', type: 'partner', role: 'Housing navigator' },
        { contactId: 'phoneref#+15550109999', ref_contactId: 'c-tenant' },
      ],
      tours: [
        { tourId: 't-ok', tenantId: 'c-tenant', status: 'scheduled' },
        { tourId: 't-landlord', tenantId: 'c-landlord', status: 'closed' },
      ],
      placements: [
        { placementId: 'p-ok', tenantId: 'c-tenant', stage: 'send_application' },
        { placementId: 'p-gone', tenantId: 'c-gone', stage: 'lost' },
      ],
      units: [
        { unitId: 'u-ok', landlordId: 'c-landlord' },
        { unitId: 'u-ownerless', contacts: [] },
        {
          unitId: 'u-partner-owner',
          landlordId: 'c-partner',
          contacts: [{ contactId: 'c-partner', role: 'landlord', primaryContact: true }],
        },
        {
          unitId: 'u-deleted',
          landlordId: 'c-tenant',
          deleted_at: '2026-06-30T00:00:00.000Z',
          contacts: [{ contactId: 'c-landlord', role: 'owner', primaryContact: true }],
        },
        {
          unitId: 'u-seat',
          landlordId: 'c-landlord',
          contacts: [
            { contactId: 'c-landlord', role: 'landlord', primaryContact: true },
            { contactId: 'c-caseworker', role: 'other', primaryContact: false },
          ],
        },
      ],
    };
    expect(seedTypeViolations([world])).toEqual({
      violations: [
        'tours t-landlord: tenantId c-landlord is typed landlord, not tenant',
        'placements p-gone: tenantId c-gone is missing, not tenant',
        'units u-partner-owner: landlordId c-partner is typed partner, not landlord',
        'units u-seat: contact list seats caseworker c-caseworker',
      ],
      checked: { tours: 2, placements: 2, liveUnits: 3, contactListRows: 5 },
    });
  });

  it('composes layers the way the seeders write them: a later contact row wins', () => {
    const first: Tables = {
      contacts: [{ contactId: 'c-x', type: 'tenant' }],
      tours: [{ tourId: 't-x', tenantId: 'c-x', status: 'requested' }],
    };
    const later: Tables = { contacts: [{ contactId: 'c-x', type: 'landlord' }] };
    expect(seedTypeViolations([first, later]).violations).toEqual([
      'tours t-x: tenantId c-x is typed landlord, not tenant',
    ]);
  });
});
```

**Step 2 - run RED.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/seedContactTypeInvariants.test.ts
```

Expected: 6 tests, 6 failing, every one because of the stub: the four world
cases fail on `placements checked` (`expected 0 to be greater than 0`) and
the two checker cases fail on `toEqual` against the stub's empty answer. Any
OTHER failure (an import error, a builder throwing) is a real problem: stop
and fix that first.

**Step 3 - implement the checker.** Edit the file: replace

```ts
/** Every I2-I4 violation in one composed world (later layers win). */
function seedTypeViolations(layers: readonly Tables[]): WorldCheck {
  void layers;
  return { violations: [], checked: { tours: 0, placements: 0, liveUnits: 0, contactListRows: 0 } };
}
```

with

```ts
/** One table across the layers, by id; a later layer's row wins. Phone-pointer
 *  rows (`phoneref#...` contactIds, cast.ts) are not contacts and are skipped. */
function byId(layers: readonly Tables[], table: string, key: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const layer of layers) {
    for (const row of layer[table] ?? []) {
      const id = row[key];
      if (typeof id === 'string' && !id.startsWith('phoneref#')) rows.set(id, row);
    }
  }
  return rows;
}

function kindOf(contact: Row | undefined): string {
  return contact === undefined ? 'missing' : `typed ${String(contact['type'])}`;
}

/** Every I2-I4 violation in one composed world (later layers win). */
function seedTypeViolations(layers: readonly Tables[]): WorldCheck {
  const contacts = byId(layers, 'contacts', 'contactId');
  const violations: string[] = [];
  const checked = { tours: 0, placements: 0, liveUnits: 0, contactListRows: 0 };
  for (const [table, key] of [['tours', 'tourId'], ['placements', 'placementId']] as const) {
    for (const [id, record] of byId(layers, table, key)) {
      checked[table] += 1;
      const tenantId = String(record['tenantId']);
      const tenant = contacts.get(tenantId);
      if (tenant?.['type'] !== 'tenant') {
        violations.push(`${table} ${id}: tenantId ${tenantId} is ${kindOf(tenant)}, not tenant`);
      }
    }
  }
  for (const [unitId, unit] of byId(layers, 'units', 'unitId')) {
    const deletedAt = unit['deleted_at'];
    const live = !(typeof deletedAt === 'string' && deletedAt.length > 0);
    const landlordId = unit['landlordId'];
    if (live && typeof landlordId === 'string' && landlordId.length > 0) {
      checked.liveUnits += 1;
      const owner = contacts.get(landlordId);
      if (owner?.['type'] !== 'landlord') {
        violations.push(`units ${unitId}: landlordId ${landlordId} is ${kindOf(owner)}, not landlord`);
      }
    }
    for (const seat of unitContacts(unit as unknown as Pick<UnitItem, 'contacts' | 'landlordId'>)) {
      checked.contactListRows += 1;
      const seated = contacts.get(seat.contactId);
      if (seated === undefined) {
        violations.push(`units ${unitId}: contact list seats ${seat.contactId}, which is not a seeded contact`);
      } else if (isCaseworker(seated)) {
        violations.push(`units ${unitId}: contact list seats caseworker ${seat.contactId}`);
      }
    }
  }
  return { violations, checked };
}
```

**Step 4 - run GREEN.**

```
cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/seedContactTypeInvariants.test.ts
```

Expected: 6 passed. (Planner's in-memory dry run of the same checker on the
tree: lean 0 tours / 1 placement / 2 live units / 2 rows; full 17 / 39 / 60 /
61; both performance worlds 50 / 51 / 15 / 18; zero violations everywhere.)
If a WORLD case fails with a real violation, a seed breaks I2-I4: fix the
SEED's typing (never the rule), list it in the slice report (W3), and re-run.

**Step 5 - checks.**

```
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < app/test/seedContactTypeInvariants.test.ts | wc -c
cd "W:/tmp/caseworker-integrity"; npm run typecheck
cd "W:/tmp/caseworker-integrity"; npx eslint app/test/seedContactTypeInvariants.test.ts
```

Expected: `0`; typecheck exit 0; eslint exit 0.

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add app/test/seedContactTypeInvariants.test.ts && git commit -m "test(seeds): pin the contact-type invariants I2-I4 over every seeded world" -m "Lean, full (lean + cast + matrix + live) and performance (on lean, default scale and with no generated contacts): every tour and placement names a tenant, every live landlordId a landlord, and no contact list seats a caseworker. All worlds are clean today; the checker is proven by its own negative controls." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.2 - e2e fixture sweep (W3): nothing the new rules refuse

**Goal.** Confirm no existing e2e spec or fixture now trips an S1-S4 refusal:
an Accept of a tenant-only AI suggestion on a contact not typed tenant, or
one spanning a type/role change (S1: 409 `suggestion_contact_not_tenant` /
`suggestion_contact_reclassified`; scope added by plan review R1 row 10), a
tour or placement for a non-tenant, a unit whose `landlordId` is not a
landlord, a caseworker seated on a contact list, a type change of a contact
that holds an open tour/placement or a live property, a reopen/revive/terminal
exit for a non-tenant, or a restore of a property whose landlord is no longer
a landlord. Read-only unless the sweep finds one.

**Files.** Read only: `e2e/tests/**`, `e2e/scenarios/steps.ts`,
`e2e/fixtures/*.ts`.

**Steps.**

1. Re-run the planner's greps (they list every call site the sweep covers):

```
cd "W:/tmp/caseworker-integrity/e2e"; grep -rn "post(\`\${[A-Za-z_]*}/api/tours\`\|post(\`\${[A-Za-z_]*}/api/placements\`\|/api/placements/from-tour\|/reopen\`\|/transition\`" --include=*.ts tests scenarios fixtures
cd "W:/tmp/caseworker-integrity/e2e"; grep -rn "landlordId" --include=*.ts tests scenarios fixtures
cd "W:/tmp/caseworker-integrity/e2e"; grep -rn "/api/units/\${[A-Za-z_.]*}/contacts\`\|Add contact to this property\|/restore\`" --include=*.ts tests scenarios fixtures
cd "W:/tmp/caseworker-integrity/e2e"; grep -rn "patch(\`\${[A-Za-z_]*}/api/contacts/" --include=*.ts tests scenarios fixtures
cd "W:/tmp/caseworker-integrity/e2e"; grep -rn "/suggestions/[A-Za-z\${}]*/accept\|name: 'Accept' })" --include=*.ts tests scenarios fixtures
```

2. Compare with the planner's reading on @54f9e6ed (all CLEAN):

| Surface | Call sites | Contact used |
| --- | --- | --- |
| `POST /api/tours` | landlord-activity:96, listing-activity:117 and :234, today-past-tours:55, tours-all:64, tours-past:65 and :253, tours-page:393 and :408, tour-auto-close:66, tour-comms-pane:141, property-roster:105, upcoming-in-stream:136, relay-intro-variants:129, roster-quiet-hours:209, tour-roster:153 | `contact-tenant-0001` (lean tenant) or a contact created with `type: 'tenant'` |
| `POST /api/placements` | placements-page:135, tour-comms-pane:474, relay-intro-variants:148 | lean tenant or a created tenant |
| placement terminal exits | lost-modal:20/:31, placement-history:21, placements-page:16/:37/:189 | `placement-0001` (Tasha, a tenant) |
| `POST /api/units` `landlordId` | every site in the second grep | `contact-landlord-0001`, a created `type: 'landlord'` contact, or a scenario contact made a landlord first (`teamCreatesLandlord`, `teamTriagesUnknownToLandlord`) |
| contact-list adds | relay-intro-variants:118, roster-quiet-hours:197, tour-roster:141, property-roster:144/:159 | landlord-typed contacts with roles pm / landlord / owner |
| contacts PATCH `type` | ai-run-log:338 and :492 (fresh unknowns, no records), caseworkers:252 (refused by `caseworker_use_conversion`, which still wins, W6) | no holdings |
| unit restore | none | - |
| tour create in scenarios | through `ScheduleTourForm` (tenants only) | tenants |
| suggestion Accept (S1; added by plan review R1 row 10, re-verified 2026-10-12) | ai-run-log:439 (API `suggestions/pets/accept`), org-lists:957 and :989 (housing authority chips), conversation-fact-extraction:152 (voucher size), :217 (address - neutral, never refused) and :281 (status) | every one on a contact created `type: 'tenant'` (each spec's `createTenant` helper), and none re-types the contact between the extraction and the Accept - clean |

3. If anything new appears (a site added since @54f9e6ed), check its contact
   type the same way. A site that DOES break a rule: change that fixture to a
   correctly typed contact (W3 - never weaken the rule), re-run that spec
   alone with `npm run e2e -w @housingchoice/e2e -- tests/...` (that spec's
   path under `e2e/`), list it in the slice report, and commit that one file
   alone (after `git status` and the MERGE_HEAD check) with the message
   `test(e2e): type a fixture correctly for the contact-type rules`, a body
   line naming the spec and the fixture, and the trailer
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
4. The completion gate's full `npm run e2e` is the final word: if any spec
   fails with `suggestion_contact_not_tenant`,
   `suggestion_contact_reclassified`, `contact_not_tenant`,
   `tenant_not_found`, `landlord_not_landlord`, `landlord_not_found`,
   `contact_list_caseworker`, `type_change_refused` or
   `restore_needs_landlord` in its error or trace, treat it as step 3.

**Commit.** None when the sweep is clean (expected). Record "W3 sweep: clean"
in the slice report.

---

### Task 5.3 - e2e: the edit form refuses a type change (caseworkers.spec.ts)

**Goal.** Spec section 8 "type change from the edit form": a tenant with an
open placement cannot become a landlord (the conversion's sentence + `View
placement`), and the landlord of record of a live property cannot become a
tenant (D2's own sentence + `View property`); the dialog keeps the draft;
nothing is written; the wire answer is `type_change_refused`. Extends the
existing caseworkers spec and reuses its helpers (`devLogin`, `uniquePhone`,
`createContact`, `readContact`, `readPreview`).

**Files.** Modify `W:/tmp/caseworker-integrity/e2e/tests/dashboard-next/caseworkers.spec.ts`.

**Step 1 - append the block.** Edit: replace this (the file's last lines, unique)

```ts
        .filter({ hasText: formattedPhone(phone) }),
    ).toHaveCount(0);
  });
});
```

with

```ts
        .filter({ hasText: formattedPhone(phone) }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Caseworker integrity (spec docs/superpowers/specs/2026-10-12-caseworker-
// integrity-design.md D2): the GENERIC type change - the edit form's kind
// picker - is refused while the contact is the tenant of an open placement or
// the landlord of record of a live property. The placement refusal reuses the
// conversion's sentence and link; the landlord one is D2's own, because no
// dashboard path reassigns a property's landlord. Self-contained: every
// contact, property and placement is run-unique (the reseed above is not
// relied on), and the holdings reads are polled through the read-only
// conversion preview, which runs the same index reads, before the UI acts.
// ---------------------------------------------------------------------------

/** The edit form and the type-change refusals' copy (dashboard
 *  src/lib/holdingRefusals.ts; the placement sentence is UI.refusalPlacement). */
const RETYPE = {
  editDetails: 'Edit contact details',
  editDialog: /Edit contact/i,
  changeType: 'Change type',
  kindGroup: 'Contact kind',
  save: 'Save',
  cancel: 'Cancel',
  openPlacement: "Finish or close this contact's placement first.",
  viewPlacement: 'View placement',
  landlordOfRecord:
    "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.",
  viewProperty: 'View property',
};

/** POST /api/units - a live property owned by `landlordId` (it starts in Setup). */
async function createOwnedUnit(request: APIRequestContext, landlordId: string, line1: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), `create property ${line1}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
}

/** POST /api/placements - an OPEN placement at the ladder's first rung. */
async function createOpenPlacement(request: APIRequestContext, tenantId: string, unitId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/placements`, {
    data: { tenantId, unitId, stage: 'send_application' },
  });
  expect(res.ok(), `create placement: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { placement: { placementId: string } }).placement.placementId;
}

/** Open the contact page's Edit contact details dialog with its kind picker expanded. */
async function openKindChange(page: Page, contactId: string): Promise<Locator> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await page.getByRole('button', { name: RETYPE.editDetails }).click();
  const dialog = page.getByRole('dialog', { name: RETYPE.editDialog });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: RETYPE.changeType, exact: true }).click();
  return dialog;
}

test.describe('Caseworker integrity - the edit form refuses a type change that would break a record', () => {
  test('an open placement keeps a tenant a tenant; a live property keeps its landlord a landlord', async ({
    page,
  }) => {
    test.slow(); // two contacts, a property and a placement, then two edit-form round trips.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const lastName = `Cwkret${stamp}`;
    const tenantId = await createContact(req, { type: 'tenant', firstName: 'Retyped', lastName, phone: uniquePhone() });
    const ownerId = await createContact(req, { type: 'landlord', firstName: 'Owner', lastName, phone: uniquePhone() });
    const unitId = await createOwnedUnit(req, ownerId, `${stamp} Retype Refusal Way NW`);
    const placementId = await createOpenPlacement(req, tenantId, unitId);
    // The holdings reads are index queries (spec L1): wait until they see both
    // records, read-only, so the PATCH below cannot slip through the lag.
    await expect
      .poll(
        async () =>
          (await readPreview(req, tenantId)).refusals.some(
            (r) => r['code'] === 'caseworker_open_placement' && r['placementId'] === placementId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await readPreview(req, ownerId)).refusals.some(
            (r) => r['code'] === 'caseworker_landlord_of_record' && r['unitId'] === unitId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // 1. Tenant -> Landlord with an open placement: refused, the draft kept.
    let dialog = await openKindChange(page, tenantId);
    const kinds = dialog.getByRole('group', { name: RETYPE.kindGroup });
    await kinds.getByRole('button', { name: 'Landlord', exact: true }).click();
    await dialog.getByRole('button', { name: RETYPE.save, exact: true }).click();
    await expect(dialog.getByText(RETYPE.openPlacement)).toBeVisible();
    await expect(dialog.getByRole('link', { name: RETYPE.viewPlacement })).toHaveAttribute(
      'href',
      `/placements/${placementId}`,
    );
    await expect(kinds.getByRole('button', { name: 'Landlord', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: RETYPE.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readContact(req, tenantId)).toMatchObject({ type: 'tenant' });

    // 2. Landlord -> Tenant while the landlord of record of a live property.
    dialog = await openKindChange(page, ownerId);
    await dialog
      .getByRole('group', { name: RETYPE.kindGroup })
      .getByRole('button', { name: 'Tenant', exact: true })
      .click();
    await dialog.getByRole('button', { name: RETYPE.save, exact: true }).click();
    await expect(dialog.getByText(RETYPE.landlordOfRecord)).toBeVisible();
    await expect(dialog.getByRole('link', { name: RETYPE.viewProperty })).toHaveAttribute(
      'href',
      `/listings/${unitId}`,
    );
    await dialog.getByRole('button', { name: RETYPE.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await readContact(req, ownerId)).toMatchObject({ type: 'landlord' });

    // On the wire: one refusal per blocking record, nothing written.
    const refused = await req.patch(`${NEXT}/api/contacts/${tenantId}`, { data: { type: 'partner' } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'type_change_refused',
      refusals: [{ code: 'open_placement', placementId }],
    });
    expect(await readContact(req, tenantId)).toMatchObject({ type: 'tenant' });
  });
});
```

**Step 2 - run the new test, then the whole file.**

```
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts --grep "edit form refuses a type change"
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts
```

Expected: 1 passed, then 6 passed. A failure on a selector that S2 rendered
differently (CONTRACT ISSUE 5a): fix the selector here, never the product, and
record it in the slice report. A failure where the PATCH SUCCEEDED (the tenant
became a landlord) is an S2 defect: stop and report.

**Step 3 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- e2e/tests/dashboard-next/caseworkers.spec.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; npm run typecheck
cd "W:/tmp/caseworker-integrity"; npx eslint e2e/tests/dashboard-next/caseworkers.spec.ts
```

Expected: `0`; exit 0; exit 0.

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add e2e/tests/dashboard-next/caseworkers.spec.ts && git commit -m "test(e2e): the edit form refuses a type change an open placement or a live property forbids" -m "Caseworker integrity D2 end to end: the open-placement and landlord-of-record sentences with their View links, the draft kept, nothing written, and 409 type_change_refused on the wire." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.4 - e2e: the contact list never takes a caseworker; the restore dialog (property-roster.spec.ts)

**Goal.** Spec section 8 "Add contact hides a caseworker" (with a positive
control and the route's 409), and the restore dialog's three actions (S5
brief): a property soft-deleted, then its landlord re-typed to tenant
(allowed - a deleted property does not hold its landlord, D2), then Restore ->
dialog -> Cancel (nothing written) -> Restore without a landlord; and a second
property -> Restore with this landlord. Reuses the spec's `devLogin`,
`freshPhone`, `Party`, `createContact`, `createAvailableUnit`.

**Files.** Modify `W:/tmp/caseworker-integrity/e2e/tests/dashboard-next/property-roster.spec.ts`.

**Step 1 - append the block.** Edit: replace this (the file's last lines, unique)

```ts
    await expect(roster.getByRole('link', { name: pm.name })).toHaveCount(0);
  });
});
```

with

```ts
    await expect(roster.getByRole('link', { name: pm.name })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Caseworker integrity (spec docs/superpowers/specs/2026-10-12-caseworker-
// integrity-design.md section 4): a property's contact list never takes a
// caseworker (I4), and restoring a deleted property whose landlord is no
// longer a landlord asks who its landlord is instead of failing (I3,
// "Restore"). Same isolation as above: every contact and property is minted
// fresh, nothing reseeds.
// ---------------------------------------------------------------------------

/** A fresh PARTNER; `role: 'Caseworker'` makes it a caseworker (lib/caseworkers.ts). */
async function createPartnerContact(
  request: APIRequestContext,
  firstName: string,
  lastName: string,
  role?: string,
): Promise<Party> {
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'partner', firstName, lastName, phone, ...(role !== undefined && { role }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, lastName, phone, name: `${firstName} ${lastName}` };
}

interface UnitWire {
  landlordId?: string;
  deleted_at?: string;
  contacts?: Array<{ contactId: string; role: string }>;
}

async function readUnit(request: APIRequestContext, unitId: string): Promise<UnitWire> {
  const res = await request.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: UnitWire }).unit;
}

/** A soft-deleted property whose landlord of record was then re-typed to
 *  tenant. The re-type is allowed because a DELETED property does not hold its
 *  landlord (spec D2); it is retried while the owned-properties index catches
 *  up with the delete (spec L1) - a refused PATCH writes nothing. */
async function deletedWithRetypedOwner(request: APIRequestContext, owner: Party): Promise<string> {
  const unitId = await createAvailableUnit(request, owner.contactId);
  const del = await request.delete(`${NEXT}/api/units/${unitId}`);
  expect(del.ok(), await del.text()).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await request.patch(`${NEXT}/api/contacts/${owner.contactId}`, { data: { type: 'tenant' } })).ok(),
      { timeout: 10_000 },
    )
    .toBe(true);
  return unitId;
}

/** The deleted property's banner; its Restore is the plain restore. */
const deletedBanner = (page: Page) => page.getByRole('status').filter({ hasText: 'This property is deleted' });

/** The restore dialog, found by its sentence (its title is S4's choice). */
const restoreDialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'is no longer a landlord' });

test.describe('Property contact list and restore - caseworker integrity', () => {
  test('the Add contact search never offers a caseworker, and the route refuses one', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const lastName = `Cwkseat${stamp}`;
    const owner = await createContact(req, 'landlord', `Seatown${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const caseworker = await createPartnerContact(req, 'Seatcwk', lastName, 'Caseworker');
    const partner = await createPartnerContact(req, 'Seatptr', lastName);

    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'Edit contacts' }).click();
    await page.getByRole('button', { name: '+ Add contact' }).click();
    await page.getByRole('combobox', { name: 'Add contact' }).fill(lastName);
    // The search ran: the plain partner sharing the last name IS offered...
    await expect(page.getByRole('option', { name: partner.name })).toBeVisible();
    // ...and the caseworker is not.
    await expect(page.getByRole('option', { name: caseworker.name })).toHaveCount(0);

    // The route refuses a caseworker a new seat whatever the role, and writes nothing.
    const refused = await req.post(`${NEXT}/api/units/${unitId}/contacts`, {
      data: { contactId: caseworker.contactId, role: 'other' },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'contact_list_caseworker' });
    const unit = await readUnit(req, unitId);
    expect((unit.contacts ?? []).map((c) => c.contactId)).not.toContain(caseworker.contactId);
  });

  test('Restore asks for a landlord when the old one is no longer a landlord: Cancel, then Restore without a landlord', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const oldOwner = await createContact(req, 'landlord', `Rsgone${stamp}`);
    const unitId = await deletedWithRetypedOwner(req, oldOwner);

    await page.goto(`${NEXT}/listings/${unitId}`);
    const banner = deletedBanner(page);
    await banner.getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = restoreDialog(page);
    await expect(dialog).toContainText(
      `${oldOwner.name} is no longer a landlord, so they can't stay this property's landlord.`,
    );
    await expect(dialog).toContainText('Choose its landlord:');
    await expect(dialog.getByRole('button', { name: 'Restore with this landlord', exact: true })).toBeDisabled();

    // Cancel writes nothing: still deleted, the old landlord still on record.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(banner).toBeVisible();
    let unit = await readUnit(req, unitId);
    expect(typeof unit.deleted_at).toBe('string');
    expect(unit.landlordId).toBe(oldOwner.contactId);

    // Restore without a landlord: back, ownerless, the old landlord's row gone.
    await banner.getByRole('button', { name: 'Restore', exact: true }).click();
    await dialog.getByRole('button', { name: 'Restore without a landlord', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    unit = await readUnit(req, unitId);
    expect(unit.deleted_at).toBeUndefined();
    expect(unit.landlordId).toBeUndefined();
    expect((unit.contacts ?? []).map((c) => c.contactId)).not.toContain(oldOwner.contactId);
  });

  test('Restore with this landlord: the property comes back owned by the landlord picked', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const oldOwner = await createContact(req, 'landlord', `Rsold${stamp}`);
    const newOwner = await createContact(req, 'landlord', `Rsnew${stamp}`);
    const unitId = await deletedWithRetypedOwner(req, oldOwner);

    await page.goto(`${NEXT}/listings/${unitId}`);
    await deletedBanner(page).getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = restoreDialog(page);
    const restoreWith = dialog.getByRole('button', { name: 'Restore with this landlord', exact: true });
    await expect(restoreWith).toBeDisabled();
    // A landlords-only committed-pick search (the New property picker's source).
    await dialog.getByRole('combobox').fill(newOwner.firstName);
    await page.getByRole('option', { name: newOwner.name }).click();
    await expect(restoreWith).toBeEnabled();
    await restoreWith.click();
    await expect(dialog).toHaveCount(0);
    await expect(deletedBanner(page)).toHaveCount(0);

    // One write: restored, the new landlord of record seated as landlord, the old one's row gone.
    const unit = await readUnit(req, unitId);
    expect(unit.deleted_at).toBeUndefined();
    expect(unit.landlordId).toBe(newOwner.contactId);
    expect(unit.contacts ?? []).toContainEqual(
      expect.objectContaining({ contactId: newOwner.contactId, role: 'landlord' }),
    );
    expect((unit.contacts ?? []).map((c) => c.contactId)).not.toContain(oldOwner.contactId);
  });
});
```

**Step 2 - run the new tests, then the whole file.**

```
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts --grep "caseworker integrity"
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-roster.spec.ts
```

Expected: 3 passed, then 4 passed. The first existing test must stay green
unchanged: its Landlord-role add on an OWNED property still answers the
repo's `landlord_reassignment_required` (a landlord-typed PM claims no vacant
slot, so neither new check fires - spec section 4 check order). A restore
dialog selector failure: see CONTRACT ISSUE 2 - adjust the selector here,
record it.

**Step 3 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- e2e/tests/dashboard-next/property-roster.spec.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; npm run typecheck
cd "W:/tmp/caseworker-integrity"; npx eslint e2e/tests/dashboard-next/property-roster.spec.ts
```

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add e2e/tests/dashboard-next/property-roster.spec.ts && git commit -m "test(e2e): the contact list never takes a caseworker; restore asks for a landlord" -m "Caseworker integrity section 4 end to end: Add contact offers a plain partner but not a caseworker and the route answers contact_list_caseworker; a deleted property whose landlord was re-typed opens the restore dialog - Cancel writes nothing, Restore without a landlord leaves it ownerless, Restore with this landlord seats the pick." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.5 - e2e: a refused tour reopen and a refused placement move show their sentence; tour reopen and revive are refused (placements-page.spec.ts, tour-auto-close.spec.ts)

**Goal.** Spec section 8 "a refused tour action shows its sentence"
(CONTRACT ISSUE 1 as amended by plan review R1 row 1; ruling S5-1):

- ON THE TOUR PAGE: a CLOSED (not a fit) tour whose tenant was re-typed to
  landlord through the API while the tour was closed (allowed - a closed tour
  is not open, so the contacts PATCH has nothing to refuse), then staff click
  `Reopen tour` -> `Yes, reopen`: the `Reopen tour` dialog's `role="alert"`
  reads "Tours and placements are for tenants. This contact is a landlord."
  (the end-to-end wiring TourDetail `confirmReopen` -> `ReopenTourModal`
  `failureCopy` -> `contactTypeErrorMessage`, S3 Task 3.13), the dialog stays
  open (no Record outcome dialog follows), and the tour stays closed.
- ON THE PLACEMENT PAGE: a Lost placement whose tenant was re-typed while it
  was closed, moved back from the placement page -> the `role="alert"` bar
  shows "Tours and placements are for tenants. This contact is a landlord."
  and the placement stays Lost.
- AT THE API: reopen of a closed tour and revive of a canceled one, both
  after their tenant was re-typed, answer 409 `contact_not_tenant` with
  `contactKind: 'landlord'` and change nothing.

Reuses `devLoginAndReset` / `placementBanner` (placements-page) and
`devLogin` / `pastAt` / `daysFromNow` / `patchTour` / `getTour` /
`tourHeader` / `REOPEN_TO_TOURED` / `UNIT_B` (tour-auto-close; the Reopen
dialog drive is modeled on that file's existing "a not-a-fit tour reopens
straight into Record outcome" test).

**Files.** Modify
`W:/tmp/caseworker-integrity/e2e/tests/dashboard-next/placements-page.spec.ts`
and `W:/tmp/caseworker-integrity/e2e/tests/dashboard-next/tour-auto-close.spec.ts`.

**Step 1 - placements-page.spec.ts import.** Edit: replace

```ts
import { test, expect, type Page, type Locator } from '@playwright/test';
```

with

```ts
import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
```

**Step 2 - placements-page.spec.ts block.** Edit: replace this (the file's last lines, unique)

```ts
    page.getByRole('dialog').or(placementBanner(page).getByText('Send application')).first(),
  ).toBeVisible({ timeout: 10_000 });
});
```

with

```ts
    page.getByRole('dialog').or(placementBanner(page).getByText('Send application')).first(),
  ).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Caseworker integrity (spec docs/superpowers/specs/2026-10-12-caseworker-
// integrity-design.md D3): a placement leaving a TERMINAL stage (lost /
// moved_in) for an open one checks that its tenant is still typed tenant. The
// dashboard reaches the refusal like this: a Lost placement whose tenant was
// re-typed while it was closed (allowed - a closed placement is not open),
// moved back from the placement page's Move to menu. Its own world, run-unique;
// the file's afterEach still resets placement-0001.
// ---------------------------------------------------------------------------

/** The refusal sentence for a landlord (dashboard src/lib/contactTypeErrors.ts). */
const NOT_A_TENANT_LANDLORD = 'Tours and placements are for tenants. This contact is a landlord.';

async function createTypedContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
  lastName: string,
): Promise<string> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, { data: { type, firstName, lastName, phone } });
  expect(res.ok(), `create ${type} ${firstName}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

test('hub: a Lost placement whose tenant is no longer a tenant cannot move back, and the page says why', async ({
  page,
}) => {
  test.slow(); // a fresh world (two contacts, a property, a placement) plus the hub.
  await devLoginAndReset(page);
  const req = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const lastName = `Plret${stamp}`;
  const tenantId = await createTypedContact(req, 'tenant', 'Lostten', lastName);
  const ownerId = await createTypedContact(req, 'landlord', 'Lostown', lastName);
  const unitRes = await req.post(`${NEXT}/api/units`, {
    data: {
      landlordId: ownerId,
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1: `${stamp} Lost Placement Way NW`, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(unitRes.ok(), await unitRes.text()).toBeTruthy();
  const unitId = ((await unitRes.json()) as { unit: { unitId: string } }).unit.unitId;
  const created = await req.post(`${NEXT}/api/placements`, {
    data: { tenantId, unitId, stage: 'send_application' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const placementId = ((await created.json()) as { placement: { placementId: string } }).placement.placementId;
  const lost = await req.post(`${NEXT}/api/placements/${placementId}/transition`, {
    data: { toStage: 'lost', source: 'manual' },
  });
  expect(lost.ok(), await lost.text()).toBeTruthy();
  // Closed, so the contact holds no open record and the re-type is allowed.
  // Retried while the placements index catches up with the move to Lost (spec
  // L1); a refused PATCH writes nothing.
  await expect
    .poll(
      async () => (await req.patch(`${NEXT}/api/contacts/${tenantId}`, { data: { type: 'landlord' } })).ok(),
      { timeout: 10_000 },
    )
    .toBe(true);

  await page.goto(`${NEXT}/placements/${placementId}`);
  const banner = placementBanner(page);
  await expect(banner.getByText('Lost', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: /^Placement stage/ }).click();
  await page.getByRole('menuitemradio', { name: 'Send application', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: NOT_A_TENANT_LANDLORD })).toBeVisible();
  await expect(banner.getByText('Lost', { exact: true })).toBeVisible();

  // On the wire: 409 with the contact's kind, and the placement did not move.
  const refused = await req.post(`${NEXT}/api/placements/${placementId}/transition`, {
    data: { toStage: 'send_application', source: 'manual' },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'contact_not_tenant', contactKind: 'landlord' });
  const after = await req.get(`${NEXT}/api/placements/${placementId}`);
  expect(after.ok(), await after.text()).toBeTruthy();
  expect(((await after.json()) as { placement: { stage: string } }).placement.stage).toBe('lost');
});
```

**Step 3 - tour-auto-close.spec.ts block.** Edit: replace this (the file's
last lines, unique)

```ts
    expect(reopened.status).toBe('toured');
    expect(reopened.outcome).toBeUndefined();
  });
});
```

with

```ts
    expect(reopened.status).toBe('toured');
    expect(reopened.outcome).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Caseworker integrity (spec docs/superpowers/specs/2026-10-12-caseworker-
// integrity-design.md D3 and section 8 "a refused tour action shows its
// sentence"): reopening a closed tour and reviving a canceled one check that
// the tenant is still typed tenant. The dashboard reaches the reopen refusal
// like this: a tour closed as not a fit, its tenant re-typed to landlord
// while the tour was closed (allowed - a closed tour is not open), then
// Reopen tour on the tour page. The Reopen dialog shows the refusal's own
// sentence (TourDetail confirmReopen lets the rejection reach ReopenTourModal,
// whose failureCopy asks contactTypeErrorMessage before its 409 rule) and the
// tour stays closed. The revive (the Reschedule dialog on a canceled tour runs
// the same failureCopy, unit-tested in TourModals.test.tsx) and the reopen are
// also asserted on the wire. The tour create pickers list tenants only, so a
// create refusal is not reachable from the dashboard. Each test makes its own
// tenant (a fresh contact, never the lean Tasha) and leaves its tours closed or
// canceled, so no later spec meets them on the Past tab or Today.
// ---------------------------------------------------------------------------
test.describe('Tour reopen and revive check the tenant (caseworker integrity)', () => {
  /** The refusal sentence for a landlord (dashboard src/lib/contactTypeErrors.ts). */
  const NOT_A_TENANT_LANDLORD = 'Tours and placements are for tenants. This contact is a landlord.';

  /** A fresh contact typed tenant, run-unique. */
  async function createTenant(page: Page, firstName: string): Promise<string> {
    const stamp = `${Date.now()}`.slice(-6);
    const res = await page.request.post(`${NEXT}/api/contacts`, {
      data: {
        type: 'tenant',
        firstName,
        lastName: `Tac${stamp}`,
        phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  }

  /** A past-dated tour for `tenantId` at UNIT_B - the create texts nobody (its rungs are born skipped). */
  async function pastTourFor(page: Page, tenantId: string): Promise<string> {
    const res = await page.request.post(`${NEXT}/api/tours`, {
      data: { tenantId, unitId: UNIT_B, scheduledAt: pastAt(3, 10), tourType: 'self_guided' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
  }

  /** Toured, then closed as not a fit - Reopen then targets Toured (REOPEN_TO_TOURED). */
  async function closeNotAFit(page: Page, tourId: string): Promise<void> {
    await patchTour(page, tourId, { status: 'toured' });
    await patchTour(page, tourId, { outcome: 'not_a_fit', moveForward: false, status: 'closed' });
  }

  /** Re-type the contact to landlord. Its tours are all closed or canceled, so
   *  the PATCH is allowed - retried while the tours index catches up with the
   *  closes (spec L1); a refused PATCH writes nothing. */
  async function retypeToLandlord(page: Page, contactId: string): Promise<void> {
    await expect
      .poll(
        async () =>
          (await page.request.patch(`${NEXT}/api/contacts/${contactId}`, { data: { type: 'landlord' } })).ok(),
        { timeout: 10_000 },
      )
      .toBe(true);
  }

  test('the Reopen dialog says why a closed tour whose tenant is now a landlord cannot reopen', async ({ page }) => {
    test.slow(); // a fresh contact and tour, a polled re-type, then the tour page and its dialog
    await devLogin(page); // page.request carries the session cookie for /api writes
    const tenantId = await createTenant(page, 'Reopenui');
    const tourId = await pastTourFor(page, tenantId);
    await closeNotAFit(page, tourId);
    await retypeToLandlord(page, tenantId);

    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(tourHeader(page).getByText('Closed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen tour' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen tour' });
    await expect(dialog.getByText(REOPEN_TO_TOURED, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, reopen' }).click();

    // The refusal's own sentence inside the dialog - not "This tour changed
    // since the page loaded", which every other 409 there reads.
    await expect(dialog.getByRole('alert')).toHaveText(NOT_A_TENANT_LANDLORD);
    // Refused, so the dialog stays (its confirm live again) and no Record
    // outcome dialog follows.
    await expect(dialog.getByRole('button', { name: 'Yes, reopen' })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: 'Record outcome' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tourHeader(page).getByText('Closed', { exact: true })).toBeVisible();

    // On the wire: still closed with its outcome; nothing was written.
    expect(await getTour(page, tourId)).toMatchObject({ status: 'closed', outcome: 'not_a_fit' });
  });

  test('a closed or canceled tour whose tenant was re-typed stays as it is', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const tenantId = await createTenant(page, 'Reopenten');
    const closedTourId = await pastTourFor(page, tenantId);
    await closeNotAFit(page, closedTourId);
    const canceledTourId = await pastTourFor(page, tenantId);
    await patchTour(page, canceledTourId, { status: 'canceled' });

    // Neither tour is open, so the re-type is allowed.
    await retypeToLandlord(page, tenantId);

    const reopen = await req.post(`${NEXT}/api/tours/${closedTourId}/reopen`, { data: {} });
    expect(reopen.status()).toBe(409);
    expect(await reopen.json()).toMatchObject({ error: 'contact_not_tenant', contactKind: 'landlord' });
    // The revive the Reschedule dialog sends (TourDetail confirmReschedule).
    const revive = await req.patch(`${NEXT}/api/tours/${canceledTourId}`, {
      data: { scheduledAt: daysFromNow(30), status: 'scheduled' },
    });
    expect(revive.status()).toBe(409);
    expect(await revive.json()).toMatchObject({ error: 'contact_not_tenant', contactKind: 'landlord' });

    expect(await getTour(page, closedTourId)).toMatchObject({ status: 'closed', outcome: 'not_a_fit' });
    expect(await getTour(page, canceledTourId)).toMatchObject({ status: 'canceled' });
  });
});
```

**Step 4 - run the new tests, then both files.**

```
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/placements-page.spec.ts --grep "Lost placement whose tenant"
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/tour-auto-close.spec.ts --grep "check the tenant"
cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/placements-page.spec.ts tests/dashboard-next/tour-auto-close.spec.ts
```

Expected: 1 passed; 2 passed (the describe's two tests: the Reopen dialog
drive and the API reopen/revive); then every test in both files passed
(placements-page: every existing test + 1; tour-auto-close: 3 existing + 2 =
5). The existing tests move `placement-0001` - Tasha, a tenant - out of
`lost`, which stays allowed. If the placement alert shows "That move was
rejected" instead of the sentence, S3's `PlacementDetail` mapping is missing
(CONTRACT ISSUE 5b): stop and report. If the Reopen dialog's alert reads
"This tour changed since the page loaded - reload and try again.", S3 Task
3.13's `failureCopy` change is missing; if a Record outcome dialog opens
instead (the reopen succeeded), S3 Task 3.5's reopen check is missing;
either way stop and report (do not change the test). If a revive answers
200, S3's PATCH check does not see the explicit `status: 'scheduled'` from
`canceled`: stop and report (do not change the test).

**Step 5 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- e2e/tests/dashboard-next/placements-page.spec.ts e2e/tests/dashboard-next/tour-auto-close.spec.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; npm run typecheck
cd "W:/tmp/caseworker-integrity"; npx eslint e2e/tests/dashboard-next/placements-page.spec.ts e2e/tests/dashboard-next/tour-auto-close.spec.ts
```

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add e2e/tests/dashboard-next/placements-page.spec.ts e2e/tests/dashboard-next/tour-auto-close.spec.ts && git commit -m "test(e2e): a refused tour reopen and a refused placement move show their sentence; tour reopen and revive check the tenant" -m "Caseworker integrity D3 end to end: a closed tour whose tenant was re-typed to landlord cannot reopen and the Reopen dialog says why; a Lost placement whose tenant was re-typed cannot move back and the placement page says why; a closed tour cannot reopen and a canceled one cannot revive for a non-tenant (409 contact_not_tenant at the API)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.6 - Selector registry rows (e2e/support/selectors.md)

**Goal.** Record the new selectors the way the registry records every other
surface, so the next spec does not rediscover them.

**Files.** Modify `W:/tmp/caseworker-integrity/e2e/support/selectors.md`.

**Step 1.** Edit: replace (the END of the key-selectors table's last row,
the "Broadcast results" row - unique)

```
as `share-skip-fix.spec.ts` does |
```

with

```
as `share-skip-fix.spec.ts` does |
| Contact page (edit form) | a REFUSED type change | `getByRole('button', { name: 'Edit contact details' })` opens `getByRole('dialog', { name: /Edit contact/i })`; `getByRole('button', { name: 'Change type', exact: true })` expands `getByRole('group', { name: 'Contact kind' })`; then `Save`. A change the contact's own records forbid (409 `type_change_refused`, caseworker-integrity spec D2: an open placement or tour keeps a tenant a tenant, a live property keeps its landlord of record a landlord) KEEPS the dialog and the draft (the picked segment stays `aria-pressed="true"`) and shows, inside the dialog, one sentence per blocking record with its link: `Finish or close this contact's placement first.` + `View placement`, `Cancel or close this contact's open tour first.` + `View tour`, or `This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.` + `View property`. Match a sentence by SUBSTRING (`getByText(sentence)` without `exact`): its link may share the element. The Unknown card's `Mark as ...` buttons show the same sentences on the card |
| Property page (Contacts card) | Add contact never offers a caseworker | the `Add contact` combobox's options leave out every caseworker (a `partner` whose role is Caseworker or Case worker; caseworker-integrity spec I4), and `POST /api/units/:id/contacts` refuses one a new seat with 409 `contact_list_caseworker`. Prove the absence only beside a POSITIVE control that shares the typed text - a plain partner IS offered - because an option list that never rendered has no caseworker option either |
| Property page (deleted) | Restore, and the restore dialog | the deleted banner `getByRole('status').filter({ hasText: 'This property is deleted' })` holds `getByRole('button', { name: 'Restore', exact: true })` - scope to it: the header carries a second `Restore` and the kebab a `Restore property`. When the landlord of record is missing or no longer typed landlord the restore answers 409 `restore_needs_landlord` and opens a dialog found by its sentence, `getByRole('dialog').filter({ hasText: 'is no longer a landlord' })`: `<landlord name, or This property's landlord> is no longer a landlord, so they can't stay this property's landlord.` and `Choose its landlord:`, a landlords-only committed-pick `combobox` (fill it, then click `page.getByRole('option', { name })` - the options are portaled), `Restore with this landlord` (DISABLED until a pick), `Restore without a landlord`, and `Cancel` (writes nothing). A property whose landlord is still a landlord restores with no dialog, as before |
| Tour page (closed tour) | a REFUSED reopen | `getByRole('button', { name: 'Reopen tour' })` opens `getByRole('dialog', { name: 'Reopen tour' })`; confirm with the dialog's `getByRole('button', { name: 'Yes, reopen' })` (never named "Reopen tour" - it would collide with the header CTA). A closed tour whose tenant is no longer typed tenant is refused (409 `contact_not_tenant`, caseworker-integrity spec D3): the dialog STAYS, its `getByRole('alert')` reads `Tours and placements are for tenants. This contact is <a landlord / a partner / a caseworker / a team member / not classified yet>.` (any other 409 there reads `This tour changed since the page loaded - reload and try again.`), no Record outcome dialog follows, and its `Cancel` leaves the tour Closed. The Reschedule dialog shows the same sentence for a refused revive of a canceled tour |
| Placement hub | a REFUSED move out of Lost / Moved in | `getByRole('button', { name: 'More actions' })` -> `getByRole('button', { name: /^Placement stage/ })` -> `getByRole('menuitemradio', { name: <stage label>, exact: true })`. A placement leaving a terminal stage whose tenant is no longer typed tenant is refused (409 `contact_not_tenant`, caseworker-integrity spec D3): the page's `role="alert"` bar reads `Tours and placements are for tenants. This contact is <a landlord / a partner / a caseworker / a team member / not classified yet>.` and the header's stage pill keeps its label. Read it with `getByRole('alert').filter({ hasText: <sentence> })` |
```

(The five new rows follow the last row directly, with no blank line between,
so the table stays one table; the blank line and the `## Narrow viewport`
heading after it are untouched.)

**Step 2 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- e2e/support/selectors.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; grep -n "^| Placement hub | a REFUSED move" e2e/support/selectors.md
cd "W:/tmp/caseworker-integrity"; grep -n -A1 "as \`share-skip-fix.spec.ts\` does |" e2e/support/selectors.md
cd "W:/tmp/caseworker-integrity"; grep -n -B2 "^## Narrow viewport" e2e/support/selectors.md
```

Expected: `0`; one match; the Broadcast results row is followed directly by
the new "Contact page (edit form)" row; the line before the heading is blank
and the line before THAT is the new "Placement hub" row.

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add e2e/support/selectors.md && git commit -m "docs(e2e): selector rows for the type-change, contact-list, restore, tour-reopen and terminal-move refusals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.7 - RUNBOOK: what the conversion does not fence, and L1

**Goal.** Spec section 7: the staff accept is now refused on a non-tenant and
fenced across a conversion (D1), so the hand-clear applies to the extraction
writer and the importer only; add L1.

**Files.** Modify `W:/tmp/caseworker-integrity/RUNBOOK.md` (the paragraph at
:473, inside "### Caseworkers (`feat/caseworkers`): NOTHING is owed at
deploy").

**Step 1.** Edit: replace this whole paragraph (one line, unique)

```
**What the conversion does not fence: an extraction run already in flight.** A run that read the contact while it was still a tenant or unknown can still write tenant facts (a housing authority included) or new suggestions onto it after the conversion: its writes are not conditional on the contact's type (filed: `extraction-in-flight-writes-onto-converted-caseworker`). `make` again (the repair above) supersedes such suggestions, but it does NOT remove a housing authority the run wrote. Remove that by hand in the console: `await fetch('/api/contacts/<contactId>', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ housingAuthority: '' }) })`.
```

with these two paragraphs (two lines, a blank line between)

```
**What the conversion does not fence: an extraction run already in flight, and the importer.** Since `fix/caseworker-integrity` (spec `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D1) a staff Accept of an AI suggestion cannot put tenant facts on a caseworker: an Accept of a tenant-only suggestion (housing authority, voucher size, pets, evictions, time at current address, porting, status) on a contact that is not a tenant is refused before anything is written, and the chip stays so it can be dismissed (409 `suggestion_contact_not_tenant`); an Accept that spans a type or role change - the conversion included, and also when crash recovery or the daily journal sweep finishes it hours later - writes nothing (409 `suggestion_contact_reclassified`). One gap remains there: an Accept claimed before that deploy and finished after it is fenced against the conversion but not against an ordinary type change. So a housing authority on a caseworker can now come from two writers only. One is an extraction run already in flight: a run that read the contact while it was still a tenant or unknown can still write tenant facts (a housing authority included) or new suggestions onto it after the conversion, because its writes are not conditional on the contact's type (filed: `extraction-in-flight-writes-onto-converted-caseworker`). The other is the importer: `import:apply` leaves a contact's type, status, housing authority and agency alone only when the contact carries `type_source: 'manual'` - every converted caseworker does, a contact created directly as a caseworker does not - and it applies none of the contact-type rules (filed: `import-bypasses-contact-type-rules`). `make` again (the repair above) supersedes an in-flight run's suggestions, but it does NOT remove a housing authority either writer put there. Remove that by hand in the console: `await fetch('/api/contacts/<contactId>', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ housingAuthority: '' }) })`.

**The contact-type checks are reads, not locks.** Also since `fix/caseworker-integrity` (D2, D3): a contact's type change is refused while it is the tenant of an open tour or placement, or the landlord of record of a live property; a tour or placement is created, reopened, revived or moved out of Lost / Moved in only for a contact typed tenant; a property's landlord of record must be typed landlord; and a caseworker cannot take a new seat on a property's contact list. Each check reads first and writes after, and the reads of a contact's open tours, open placements and owned properties go through indexes, which trail a write by a moment (normally well under a second). Two people acting on the same contact at the same time - or one person scheduling a tour and changing the contact's type within that moment - can therefore both get through and leave, say, a landlord-typed contact on an open tour (spec L1: no lock was built, by decision). Nothing sweeps for it, and records made before the deploy that break these rules stay as they are (spec L2). Put one right by hand in the dashboard: change the contact's type back on its page (a change back to Tenant is refused only while the contact is also the landlord of record of a live property), or cancel or close the tour or placement.
```

**Step 2 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- RUNBOOK.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; grep -c "The contact-type checks are reads, not locks" RUNBOOK.md
```

Expected: `0`; `1`.

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add RUNBOOK.md && git commit -m "docs(runbook): the staff accept is fenced; the hand-clear covers the in-flight extraction and the importer; the type checks are reads, not locks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.8 - Resolve the three issues (and correct the third)

**Goal.** Spec section 7: status, resolved date, a Resolution paragraph each;
in `tours-placements-no-contact-type-check`, correct the record (the contact
list add lives in `units.ts`, not `rosterEdits.ts`; a placement can leave
`lost` / `moved_in` unguarded) and record the tenant-only ruling.

**Date rule (this task and 5.9).** Every date this branch writes for itself
is the day the builder commits. Run `date +%F`. If it does not print
`2026-10-12`, replace `2026-10-12` with that value in exactly these places and
nowhere else: the `resolved:` lines and the `**Resolution (2026-10-12).**`
headings in 5.8, and the `created:` lines in 5.9. Leave every other
`2026-10-12` alone - it names the spec file or Cameron's rulings.

**Files.** Modify, in `W:/tmp/caseworker-integrity/docs/issues/`:
`claimed-suggestion-accept-after-caseworker-conversion.md`,
`contact-retype-skips-caseworker-refusals.md`,
`tours-placements-no-contact-type-check.md`.

**Step 1 - claimed-suggestion-accept-after-caseworker-conversion.md.**

Edit A: replace `status: open` with

```
status: resolved
resolved: 2026-10-12
```

Edit B: replace (the file's last line, unique)

```
priority and the scope decision are unchanged and remain Cameron's call.
```

with

```
priority and the scope decision are unchanged and remain Cameron's call.

**Resolution (2026-10-12).** Fixed on `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D1;
Cameron's rulings 2026-10-12). An accept now reads the contact consistently
before it plans, and for a TENANT-ONLY target (`housingAuthority`,
`voucherSize`, `pets`, `evictions`, `tenure`, `porting`, `status`): (1) on a
contact not typed `tenant` it is refused before the claim with 409
`suggestion_contact_not_tenant`, so the chip is kept and can be dismissed;
(2) otherwise its guard also carries the contact's `classification_revision`,
which the conversion and every contacts-PATCH type or role change bump in the
same write, so a claim that spans a reclassification - resumed, recovered by
`recoverAbandoned`, or finished by the journal sweep - ends superseded and
writes nothing (`commitContactEffect` answers
`superseded_by_reclassification`; the requester gets 409
`suggestion_contact_reclassified`, and `suggestion.updated` is emitted because
the chip is gone). A journal claimed by the old code has no revision key:
`effectiveGuard` (`app/src/repos/suggestionResolutionRepo.ts`), used at all
three real-repo guard sites and by the test fake, extends its guard with
`caseworker_conversion: { exists: false }`, so such a claim recovered onto a
converted contact also ends superseded instead of looping as stale. Neutral
targets (`firstName`, `lastName`, `phone`, `address`) still commit across a
reclassification. The R2-ADV-1 schedule - the paused claim and the
crash-recovered claim, on the FakeWorld routes and on the real repositories
over DynamoDB Local - is now a regression test, and it ends with no housing
authority on the caseworker. Known limit (spec D1.4): a journal claimed before
the deploy is not fenced against a GENERIC re-type. No repair step: #19 had
not deployed anywhere. What can still write a housing authority onto a
caseworker - an extraction run in flight, and the importer - is in RUNBOOK.md,
"What the conversion does not fence".
```

**Step 2 - contact-retype-skips-caseworker-refusals.md.**

Edit A: replace `status: open` with

```
status: resolved
resolved: 2026-10-12
```

Edit B: replace (the file's last line, unique)

```
placement created for a non-tenant).
```

with

```
placement created for a non-tenant).

**Resolution (2026-10-12).** Decided and fixed on `fix/caseworker-integrity`
(spec `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D2;
Cameron, 2026-10-12): the generic type change REFUSES, it does not warn. A
contacts PATCH that changes `type` answers 409
`{ error: 'type_change_refused', refusals }` when the new type is not
`tenant` and the contact is the tenant of an open placement (`open_placement`)
or an open tour (`open_tour`), or when the new type is not `landlord` and the
contact is the landlord of record of a LIVE property (`landlord_of_record`; a
soft-deleted property is fenced at restore instead). A contact-list seat never
refuses a type change, a role-only change is not checked, and 409
`caseworker_use_conversion` still answers first. The reads are the
conversion's own, extracted to `app/src/services/contactHoldings.ts`; the
conversion's behavior, codes, order and copy are unchanged. The edit form
keeps the draft and shows each refusal's sentence and View link beside the
kind picker - the conversion's sentences for a placement or a tour; for a
landlord of record, "This contact is the landlord of record for a property,
so they must stay a landlord. Changing a property's landlord isn't available
in the dashboard yet." (no dashboard path reassigns a property's landlord:
filed `landlord-of-record-no-reassign-ui`). The Unknown card's Mark as ...
buttons no longer swallow failures: a refusal shows the same sentences on the
card. The checks read before they write (spec L1; RUNBOOK "The contact-type
checks are reads, not locks"), and existing records were not swept (L2). The
importer's re-type is outside this fence: filed
`import-bypasses-contact-type-rules`.
```

**Step 3 - tours-placements-no-contact-type-check.md.**

Edit A: replace `status: open` with

```
status: resolved
resolved: 2026-10-12
```

Edit B (the refs line names the wrong file): replace

```
app/src/lib/unitFields.ts, app/src/services/rosterEdits.ts
```

with

```
app/src/lib/unitFields.ts, app/src/repos/unitsRepo.ts, app/src/services/contactTypeGuards.ts
```

Edit C: replace (the file's last two lines, unique)

```
which `isCaseworker` (`app/src/lib/caseworkers.ts`) holds, with a sentence
naming why. Related: `contact-retype-skips-caseworker-refusals`.
```

with

```
which `isCaseworker` (`app/src/lib/caseworkers.ts`) holds, with a sentence
naming why. Related: `contact-retype-skips-caseworker-refusals`.

**Resolution (2026-10-12).** Fixed on `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D3;
Cameron's rulings 2026-10-12), with the shared checks in
`app/src/services/contactTypeGuards.ts` (consistent contact reads):

- Tours and placements are for tenants ONLY. The "(or `unknown`, for
  triage)" suggested above was declined: no flow gives an unknown contact a
  tour or placement (the pickers load tenants only), so `unknown` is refused
  like every other non-tenant. `POST /api/tours`, a tour PATCH that moves a
  canceled tour to an open status, `POST /api/tours/:id/reopen`,
  `POST /api/placements`, `POST /api/placements/from-tour`, and a placement
  move from `lost` / `moved_in` to an open stage (checked in the transition
  service, so every caller is covered) answer 404 `tenant_not_found` for a
  missing contact and 409 `{ error: 'contact_not_tenant', contactKind }` for
  one not typed `tenant`; the dashboard says "Tours and placements are for
  tenants. This contact is a landlord." (or a partner, a caseworker, a
  team member, not classified yet). `deriveTenantStatus` writes nothing onto a
  non-tenant. A team member's page no longer offers "+ Schedule" or "+ Start
  placement".
- A property's landlord of record: `POST /api/units`, a unit PATCH that
  changes `landlordId`, and a Landlord-role contact-list add that claims a
  vacant slot refuse a contact not typed `landlord` (404 `landlord_not_found`,
  409 `landlord_not_landlord`). Restoring a deleted property whose landlord is
  no longer a landlord answers 409 `restore_needs_landlord`, and the property
  page asks: Restore with this landlord (a landlords-only picker) or Restore
  without a landlord.
- Its contact list: `POST /api/units/:id/contacts` refuses a caseworker a NEW
  seat (409 `contact_list_caseworker`), and the Add contact search no longer
  offers caseworkers. Seats held before the deploy stay editable.

**Correction to the record above.** The property contact-list add is
`POST /api/units/:id/contacts` in `app/src/routes/units.ts` (repo
`addContact`, `app/src/repos/unitsRepo.ts`), not
`app/src/services/rosterEdits.ts`, which edits tour and placement RELAY
rosters. And the reopen gap named above was wider for placements: a placement
can leave `lost` or `moved_in` for ANY stage with no guard at all. This
branch adds only the tenant check on that path; whether the exit should be
allowed is filed as `placement-terminal-stage-exit-unguarded`. Also out of
scope and filed: the importer's re-type and `landlordId` writes
(`import-bypasses-contact-type-rules`). Limits: the checks are reads before
writes, not locks (spec L1), and records made before the deploy were not
swept (L2).
```

**Step 4 - checks.**

```
cd "W:/tmp/caseworker-integrity"; git diff -U0 -- docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md docs/issues/contact-retype-skips-caseworker-refusals.md docs/issues/tours-placements-no-contact-type-check.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
cd "W:/tmp/caseworker-integrity"; grep -n "^status:\|^resolved:" docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md docs/issues/contact-retype-skips-caseworker-refusals.md docs/issues/tours-placements-no-contact-type-check.md
```

Expected: `0`; each file shows `status: resolved` and `resolved: <the date>`.

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md docs/issues/contact-retype-skips-caseworker-refusals.md docs/issues/tours-placements-no-contact-type-check.md && git commit -m "docs(issues): resolve the three caseworker-integrity issues; correct the contact-list record" -m "claimed-suggestion-accept-after-caseworker-conversion (D1), contact-retype-skips-caseworker-refusals (D2) and tours-placements-no-contact-type-check (D3, tenant-only; the contact-list add is units.ts, not rosterEdits.ts; the unguarded terminal-stage exit is filed)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5.9 - File the four follow-up issues; regenerate the index

**Goal.** Spec section 7: file `placement-terminal-stage-exit-unguarded`,
`import-bypasses-contact-type-rules`, `landlord-of-record-no-reassign-ui`;
plus the plan review's deferral (R1 row 7, DEFER -> filed):
`unit-primary-contact-unchecked` (low). All four from `_TEMPLATE.md`
(frontmatter schema, docs/issues/README.md), then `npm run issues`.
`docs/issues/INDEX.md` is gitignored - never stage it. Apply 5.8's date rule
to the four `created:` lines.

**Files.** Create, in `W:/tmp/caseworker-integrity/docs/issues/`:
`placement-terminal-stage-exit-unguarded.md`,
`import-bypasses-contact-type-rules.md`,
`landlord-of-record-no-reassign-ui.md`,
`unit-primary-contact-unchecked.md`.

**Step 1 - `placement-terminal-stage-exit-unguarded.md`** (exact content):

```
---
id: placement-terminal-stage-exit-unguarded
title: A placement can move out of Lost or Moved in to any stage; whether that is allowed is undecided
type: decision
severity: low
status: open
area: app/placements
created: 2026-10-12
refs: app/src/lib/statusModel.ts:118, app/src/services/statusTransition.ts, app/src/routes/statusTransition.ts, dashboard/src/routes/placements/PlacementDetail.tsx, dashboard/src/routes/placements/StageMenu.tsx:155, e2e/tests/dashboard-next/lost-modal.spec.ts:27, e2e/tests/dashboard-next/placement-history.spec.ts:16
---

**Problem.** `lost` and `moved_in` are the placement ladder's terminal stages
(`TERMINAL_STAGES`, `app/src/lib/statusModel.ts:118`), but nothing stops a
placement leaving them. `transitionPlacement`
(`app/src/services/statusTransition.ts`) accepts any stage from any stage, the
transition route (`POST /api/placements/:placementId/transition`,
`app/src/routes/statusTransition.ts`) adds no rule, and both dashboard stage
pickers offer every stage on a terminal placement: the placement page's
Move to menu says so in a NOTE beside `requestMove`
(`dashboard/src/routes/placements/PlacementDetail.tsx`: "an allowed
re-open"), and the Placements list's row menu lists every stage but the
current one (`dashboard/src/routes/placements/StageMenu.tsx:155-157`). A
placement marked Lost by mistake can be put back, which is useful. But a
Moved in placement can also be dragged back into the application phase - the
move re-derives the tenant's and the property's statuses for the new stage
wherever no manual status pins them, as if the move-in never happened - and a
Lost placement can be revived months later without anyone deciding it should
be. The e2e specs rely on the escape today: `lost-modal.spec.ts:27-34` and
`placement-history.spec.ts:16-24` reset the seeded placement out of `lost`
through the API.

`fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, section 4)
added ONE check on this path - a move from a terminal stage to an open one
refuses a tenant who is no longer typed `tenant` (409 `contact_not_tenant`) -
and deliberately decided nothing else (spec section 10).

**Suggested fix.** Decide (Sam and Cameron) between: (a) keep the free
re-open as a feature and say so in the stage menus; (b) allow leaving `lost`
only (a mistaken Lost) and make `moved_in` final; or (c) route any exit from a
terminal stage through a confirm that names what it re-derives. Whatever is
chosen belongs in the transition service, so every caller is covered, and the
two e2e resets above must move to whatever path stays legal.
```

**Step 2 - `import-bypasses-contact-type-rules.md`** (exact content):

```
---
id: import-bypasses-contact-type-rules
title: The importer's re-type and landlordId writes skip the contact-type rules, and its re-type does not bump classification_revision
type: debt
severity: low
status: open
area: app/import
created: 2026-10-12
refs: app/src/lib/import/apply.ts:883, app/src/lib/import/apply.ts:1065, app/src/lib/import/apply.ts:1110, app/src/lib/import/apply.ts:1519, app/src/repos/contactsRepo.ts:1501, app/src/services/contactHoldings.ts
---

**Problem.** `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, section 1)
made the app keep four rules: a tenant-only AI suggestion commits only onto a
contact typed `tenant` whose classification did not change since the accept
read it (I1); the tenant of an open tour or placement is typed `tenant` (I2);
a live property's `landlordId` names a contact typed `landlord` (I3); and no
new contact-list seat goes to a caseworker (I4). The importer
(`import:apply`, `app/src/lib/import/apply.ts`) writes contacts and
properties directly and applies none of them:

- its contact upsert re-types a contact from the reviewed workbook (the type
  is resolved at `apply.ts:883-893` and written at `:1110`) without the
  contacts PATCH's refusals, so a tenant with an open tour or placement can be
  re-typed and a landlord of record can stop being a landlord (I2, I3);
- that re-type never bumps `classification_revision` - the attribute the
  contacts PATCH and the caseworker conversion bump in the same write as a
  type or role change (`app/src/repos/contactsRepo.ts:1501`) - so a staff
  accept of a tenant-only suggestion claimed before an import re-typed the
  contact is not fenced by I1 and can still commit tenant facts onto the
  re-typed contact;
- its property upsert sets `landlordId` (`apply.ts:1519`) from the merge
  plan's SUGGESTED type, not the reviewed type the contact upsert wrote, and
  never reads the contact's stored type (I3).

A contact whose `type_source` is `manual` (a staff re-type, every caseworker
conversion) keeps its type, status, housing authority and agency
(`apply.ts:1065-1073`), which covers converted caseworkers; it does not cover
a contact staff created directly as a caseworker, or any other typed contact.
Out of scope for `fix/caseworker-integrity` by decision (spec section 10).

**Suggested fix.** Before the import writes a contact's type, run the same
holdings reads the contacts PATCH uses (`typeChangeRefusals`,
`app/src/services/contactHoldings.ts`) and skip-and-report a refused re-type
in the run's summary instead of writing it; write a re-type with
`classification_revision` bumped in the same update; and set a property's
`landlordId` only when the matched contact's resolved type is `landlord`.
Rehearse the dry run on a copy of production data first: the importer is the
one writer that touches every record at once.
```

**Step 3 - `landlord-of-record-no-reassign-ui.md`** (exact content):

```
---
id: landlord-of-record-no-reassign-ui
title: No dashboard path changes a property's landlord of record after it is created
type: improvement
severity: low
status: open
area: dashboard/listing
created: 2026-10-12
refs: app/src/lib/unitFields.ts:46, app/src/routes/units.ts, app/src/repos/unitsRepo.ts, dashboard/src/routes/listing/ListingDetail.tsx, dashboard/src/routes/listing/UnitCreateForm.tsx, dashboard/src/lib/holdingRefusals.ts
---

**Problem.** A property's landlord of record (`landlordId`) is picked on New
property (`dashboard/src/routes/listing/UnitCreateForm.tsx`, the only
dashboard writer of `landlordId`), and no dashboard screen changes it
afterwards. The API can: `landlordId` is writable on `PATCH /api/units/:id`
(`app/src/lib/unitFields.ts:46`, `app/src/routes/units.ts`). The property
page's Contacts card can only FILL an empty slot - adding a contact with the
Landlord role claims it on an ownerless property (`addContact`,
`app/src/repos/unitsRepo.ts`) - and with an owner in place it answers "This
property already has a landlord of record - reassign it before choosing
Landlord." with nothing in the dashboard to reassign it with. Since
`fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D2) this
matters more: a contact who is the landlord of record of a live property
cannot be re-typed (409 `type_change_refused`, refusal `landlord_of_record`),
and the edit form has to say "Changing a property's landlord isn't available
in the dashboard yet." (`dashboard/src/lib/holdingRefusals.ts`) - a dead end
for staff correcting a mistyped landlord or handing a property to a new owner.
Restoring a deleted property whose landlord is no longer a landlord does offer
a landlord picker (spec section 4, Restore); a live property has none.

**Suggested fix.** A "Change landlord of record" action on the property page
(the Contacts card or the property kebab): a picker of contacts typed
`landlord` (the New property picker's source), a PATCH of `landlordId` (which
since `fix/caseworker-integrity` refuses a contact not typed `landlord`), the
old owner's contact-list row demoted or removed and the new owner's row added
with role `landlord`, the primary contact kept consistent, and an audit entry
naming both. Then the edit form's landlord-of-record refusal can drop "isn't
available in the dashboard yet" and link straight to that action.
```

**Step 3b - `unit-primary-contact-unchecked.md`** (exact content; plan review
R1 row 7, reviewer A F7 - DEFERRED by the planner and filed here, not built):

```
---
id: unit-primary-contact-unchecked
title: A property's primary_contact is writable on unit create and PATCH with any contactId - no existence, type, caseworker or contact-list check
type: debt
severity: low
status: open
area: app/units
created: 2026-10-12
refs: app/src/lib/unitFields.ts:104, app/src/routes/units.ts:1055, app/src/repos/unitsRepo.ts:815, app/src/routes/webhooks/voice.ts:627, app/src/repos/conversationsRepo.ts:207, app/src/services/rosterProvision.ts:233
---

**Problem.** `primary_contact` is a property's scalar "default contact"
(relay groups and masked calls - the comment on `POST /api/units/:id/contacts`,
`app/src/routes/units.ts:1055-1058`). It is a plain writable string on BOTH
`POST /api/units` and `PATCH /api/units/:id` (`app/src/lib/unitFields.ts:104`,
validated by `validateUnitBody` in both modes), and any contactId is
accepted: nothing checks that the contact exists, what it is typed, whether
it is a caseworker, or whether it holds a seat on the property's contact
list. The contact-list writer (`POST /api/units/:id/contacts`, repo
`addContact`) keeps the scalar consistent with the list's `primaryContact`
flag (`app/src/repos/unitsRepo.ts:815-824`); a direct write bypasses that, so
the scalar can name a contact who is not on the list at all. No dashboard
screen writes it directly today.

Since `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, I4) a
caseworker cannot take a NEW contact-list seat (409
`contact_list_caseworker`), but a direct `primary_contact` write can still
name one as the property's default contact without ever taking a seat. Found
by that branch's plan review (round 1, reviewer A, F7) and deferred: it is
not a contact-list seat by the spec's definition, and nothing routes on the
SCALAR today - the readers that pick a property's contact use the contact
list's `primaryContact` flag with the landlord-of-record fallback
(`app/src/services/rosterProvision.ts:233` and `:525`,
`app/src/lib/tourContacts.ts:124`, `app/src/lib/rosterResolution.ts:293`).
The scalar's only other mentions are comments naming it as the future
landlord-leg target of the main-number masked call
(`app/src/routes/webhooks/voice.ts:627`, which says that path "stays M1.10";
`app/src/repos/conversationsRepo.ts:207`), and the comment at
`app/src/repos/unitsRepo.ts:816-817` that says the masked-call landlord leg
dials it today, which the voice route does not bear out. When that M1.10
path is built on the scalar, the gap becomes live: a caseworker, a deleted
contact, or a contact unrelated to the property could become the callee.

**Suggested fix.** Before anything routes on `primary_contact`: either stop
accepting it on the unit create / PATCH body (the contact list's Make primary
already sets it, and the repo keeps it consistent), or validate it on write -
the contact exists, is not a caseworker (`isCaseworker`,
`app/src/lib/caseworkers.ts`) and holds a seat on the property's contact
list - with the consistent contact read the contact-list checks use
(`app/src/services/contactTypeGuards.ts`). The voice route's own NOTE says
the M1.10 path must consult the THREAD roster, not the unit scalar
(`voice-business-number-roster`); if it does, the scalar's write path can be
removed outright. Correct the stale `unitsRepo.ts:816-817` comment either way.
```

**Step 4 - regenerate the index and check.**

```
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < docs/issues/placement-terminal-stage-exit-unguarded.md | wc -c
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < docs/issues/import-bypasses-contact-type-rules.md | wc -c
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < docs/issues/landlord-of-record-no-reassign-ui.md | wc -c
cd "W:/tmp/caseworker-integrity"; tr -d '\11\12\15\40-\176' < docs/issues/unit-primary-contact-unchecked.md | wc -c
cd "W:/tmp/caseworker-integrity"; npm run issues
cd "W:/tmp/caseworker-integrity"; git status --short docs/issues
```

Expected: `0` four times; `npm run issues` exits 0 with no warning naming
any of the seven files this slice touched (the four new ones appear as open,
the three resolved ones as closed); `git status --short docs/issues` lists
the four new files as untracked and does NOT list `INDEX.md` (gitignored).

**Commit.**

```
cd "W:/tmp/caseworker-integrity"; git status
cd "W:/tmp/caseworker-integrity"; git rev-parse -q --verify MERGE_HEAD || echo "no merge in progress"
cd "W:/tmp/caseworker-integrity" && git add docs/issues/placement-terminal-stage-exit-unguarded.md docs/issues/import-bypasses-contact-type-rules.md docs/issues/landlord-of-record-no-reassign-ui.md docs/issues/unit-primary-contact-unchecked.md && git commit -m "docs(issues): file the four caseworker-integrity follow-ups" -m "placement-terminal-stage-exit-unguarded (decision), import-bypasses-contact-type-rules (debt), landlord-of-record-no-reassign-ui (improvement) - spec section 7; unit-primary-contact-unchecked (debt, low) - the plan review's deferral." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice gate

Run in order, each bare (no pipes on a gate), from the worktree; every one
must pass before S5 is reported done:

1. `cd "W:/tmp/caseworker-integrity/app"; npx vitest run test/seedContactTypeInvariants.test.ts`
   -> 6 passed.
2. `cd "W:/tmp/caseworker-integrity"; npm run typecheck` -> exit 0 (covers
   `app/test` and `e2e/`).
3. Lint - AGENTS.md gate 5 scoped to S5's touched `.ts` files (procedure:
   section 0 "Lint at every slice gate"; plan review R1 row 3), bare:
   `cd "W:/tmp/caseworker-integrity"; npx eslint app/test/seedContactTypeInvariants.test.ts e2e/tests/dashboard-next/caseworkers.spec.ts e2e/tests/dashboard-next/property-roster.spec.ts e2e/tests/dashboard-next/placements-page.spec.ts e2e/tests/dashboard-next/tour-auto-close.spec.ts`
   -> exit 0: the four e2e specs lint clean at the merge base (planner,
   2026-10-12) and the seed test is new, so ANY error is S5's and BLOCKING;
   confirm it with the section-0 merge-base baseline run on the same five
   paths, fix it, and re-run. Then the section-0 coverage check: every path
   it prints must be in one of the S1-S5 lists.
4. `cd "W:/tmp/caseworker-integrity"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts tests/dashboard-next/property-roster.spec.ts tests/dashboard-next/placements-page.spec.ts tests/dashboard-next/tour-auto-close.spec.ts`
   -> every test passed (6 + 4 + every placements-page test + 5; tour-auto-close
   is its 3 existing tests + Task 5.5's 2).
5. ASCII: `0` from every check in 5.1-5.9.
6. `cd "W:/tmp/caseworker-integrity"; npm run issues` -> exit 0; `git status`
   shows a clean tree with `docs/issues/INDEX.md` untracked-and-ignored (not
   listed).
7. Slice report lists: the W3 sweep result (5.2); any selector adjusted to an
   S2-S4 render choice (CONTRACT ISSUE 5) with the reason; the date used in
   5.8/5.9.

Then the mission's five completion gates (spec section 9) run on the branch
tip; the full `npm run e2e` is the final W3 check (5.2 step 4). Gate 5 (eslint
on every `.ts`/`.tsx` file in `main...HEAD`) is expected to report exactly the
two pre-existing baseline errors named in section 0 ("Lint at every slice
gate", item 3) and nothing else; attribute them by the merge-base baseline
run and name them in the handback as pre-existing (not fixed).

## Surfaces covered

- Seeds (spec section 5 "Seeds"): lean; full = lean + cast + matrix + live
  (`buildLiveStaticItems`); performance on lean at default scale; performance
  on lean with no generated contacts (the lean fallbacks). Rules: every tour
  and placement -> tenant; every live `landlordId` -> landlord; no contact
  list seats a caseworker; every seat names a seeded contact. (5.1)
- e2e fixtures (W3): every suggestion Accept (S1), tour/placement create,
  terminal exit, unit create, contact-list add, contacts PATCH type, restore -
  swept clean. (5.2)
- D2 contacts PATCH via the edit form: `open_placement` and
  `landlord_of_record` refusals with sentences, View links, draft kept,
  nothing written, `type_change_refused` on the wire. (5.3)
- I4 contact-list add: the Add contact picker hides a caseworker (positive
  control: a plain partner is offered); `POST /api/units/:id/contacts` ->
  409 `contact_list_caseworker`, nothing written. (5.4)
- I3 restore: plain restore -> 409 `restore_needs_landlord` -> dialog with
  the old landlord's name; Cancel writes nothing; Restore without a landlord
  (ownerless, old row gone); Restore with this landlord (new `landlordId`,
  new landlord row, old row gone); the D2 rule that a soft-deleted property
  does not hold its landlord (the setup re-type). (5.4)
- I2 placement terminal exit: the dashboard sentence on the placement page's
  alert bar, stage kept, 409 `contact_not_tenant` with `contactKind`. (5.5)
- I2 tour reopen from the tour page (spec 8 "a refused tour action shows
  its sentence"): a closed tour whose tenant was re-typed to landlord ->
  Reopen tour -> Yes, reopen -> the Reopen dialog's alert reads the
  `contact_not_tenant` sentence, no Record outcome dialog, the tour stays
  closed. (5.5)
- I2 tour reopen and tour revive (canceled -> scheduled): 409
  `contact_not_tenant` at the API, tours unchanged. (5.5)
- Docs: selector rows (5.6); RUNBOOK accept fence + importer + L1 (5.7);
  three issues resolved, the third corrected (5.8); four follow-ups filed -
  spec section 7's three plus `unit-primary-contact-unchecked` (plan review
  R1 row 7, deferred) - and the index regenerated (5.9).
- NOT covered by S5 e2e (unit-tested in S1-S4, listed so nothing is assumed):
  D1 accept refusals and the fence; the Unknown card's Mark as refusals; the
  team-member button hiding; tour/placement create and from-tour refusals;
  unit create / PATCH `landlordId` and the vacant-slot landlord claim;
  `deriveTenantStatus` skipping a non-tenant; the Reschedule dialog's copy
  for a refused revive (the same `failureCopy` the Reopen dialog runs, which
  5.5 drives end to end; unit-tested in S3 Task 3.13).


---

# CK - Checkpoints

After S2 and again after S4, from the worktree root, bare: `npm run typecheck`, `npm test`, `npm run smoke`. Record exit codes in the ledger; a red checkpoint is fixed before the next slice starts.
