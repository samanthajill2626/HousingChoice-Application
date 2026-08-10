# Tenant List Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tenant-list facet filters (voucher size / housing authority / porting) with facts on
each row, the tenant `agency` field, and the unit `accepted_authorities` consolidation - per the
approved spec `docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md` (READ IT
FIRST; it is the authority wherever this plan is thinner).

**Architecture:** App-side field changes land first (PATCH allowlists, unit field consolidation
with read-time synthesis, import writer, API/GSI removal, seeds), then the dashboard (a pure
`tenantFacets` module drives a `TenantFilters` component wired into `ContactsList` with
URL-backed state), then e2e + docs. No data backfill anywhere - legacy `jurisdiction` is
synthesized at read time.

**Tech Stack:** TypeScript, Express, DynamoDB (flexible documents), React 19 + react-router +
CSS Modules, Vitest, Playwright.

## Global Constraints

- ASCII-only in every new/touched line of specs, tests, comments, seed strings, labels. The row
  separator is U+00B7 built ONLY via `String.fromCharCode(0xB7)` (the same construction form
  `e2e/support/selectors.md:47` records for the em dash) - never a literal middot character,
  never an HTML entity, never a unicode escape pasted as the character.
- CSS values from `dashboard/src/ui/tokens.css` variables - never hard-coded px.
- Gates run BARE, never piped: `npm run typecheck`, `npm test`, `timeout 1500 npm run e2e` (from
  the worktree only; warm containers first with `npm run db:start` and `npm run s3:start`).
- Commit discipline: bare `git status` READ before every commit; stage + commit EXPLICIT paths
  only; every commit carries `Co-Authored-By:` naming the authoring model.
- Accessibility-first selectors (`getByRole`/`getByLabel`) in all component/e2e tests.
- Display rule: stored authority/agency values render AS-IS everywhere. No humanize, no
  transformation. (`humanizeAuthority` is untouched in `ListingsList` until
  `docs/issues/retire-humanize-authority.md` deletes it - this feature must not spread it.)

---

### Task 1: `agency` on the contact PATCH allowlist (app)

**Files:**
- Modify: `app/src/routes/contacts.ts` (the parse-patch body, directly after the
  `housingAuthority` block at ~:520-525)
- Test: `app/test/contactIntakeFields.test.ts` (extend - it already covers this parser)

**Interfaces:**
- Produces: `PATCH /api/contacts/:id { agency: string }` persists `contact.agency`; non-string
  400s with `agency must be a string`. NOT added to the `PROVENANCE` set (~:850) - nothing
  machine-writes it.

- [ ] **Step 1: Failing test** - in `contactIntakeFields.test.ts`. DO NOT write the request
  calls from scratch: DUPLICATE the file's existing `it('PATCH persists intake fields and GET
  returns them', ...)` block (its :10-38 region) VERBATIM - including however it builds the app,
  authenticates (origin-verify header / session), and creates the contact - then change only the
  payload and assertions:
  - PATCH `{ agency: 'Hope Atlanta' }` -> 200, and the follow-up GET returns
    `contact.agency === 'Hope Atlanta'`.
  - PATCH `{ agency: 7 }` -> 400 with `/agency must be a string/`, mirroring the file's existing
    `rejects a non-string pets` case at :39.
  The earlier draft of this step invented `uniquePhone()` and a bare `app` - neither exists in
  that file; its own idioms are the only valid source. NOTE also: `agency` is EDIT-only by
  design - the POST create body does not accept it (the create dialog does not collect it), so
  no create-path change or test.
- [ ] **Step 2: Run to fail** - `npm test -- contactIntakeFields` from `app/`. Expected: 400
  `unknown field` or the field silently absent -> assertion fails.
- [ ] **Step 3: Implement** - after the `housingAuthority` block in the patch parser:

```ts
  // Tenant agency (edit form) - the helper org (taxonomy: NOT an authority).
  // Plain stored string; no GSI, no facet, no extraction provenance.
  if ('agency' in b) {
    const v = b['agency'];
    if (typeof v !== 'string') return { error: 'agency must be a string' };
    patch['agency'] = v;
    changedFields.push('agency');
  }
```

- [ ] **Step 4: Run to pass**, then run the whole file: `npm test -- contactIntakeFields`.
- [ ] **Step 5: Commit** `app/src/routes/contacts.ts app/test/contactIntakeFields.test.ts`.

### Task 2: unit field consolidation core - `accepted_authorities`, tombstones, `authoritiesOf`, flyer projection (app)

**Files:**
- Modify: `app/src/lib/unitFields.ts` (WRITABLE_FIELDS ~:43-47; the flyer type ~:214; the
  `toUnitFlyer` projection ~:252)
- Modify: `app/src/repos/unitsRepo.ts` (:122-131 - the `UnitItem` type)
- Modify: `app/src/routes/units.ts` (the PATCH handler - the true-no-op early return, Step 4c)
- Test: `app/test/unitFields.test.ts`, `app/test/publicIntake.test.ts` (:322-330 pins the flyer
  key list), `app/test/unitsApi.test.ts` (the no-op route tests, Step 4c)

**Interfaces:**
- Produces: `accepted_authorities?: string[]` writable on the unit PATCH; `jurisdiction` and
  `accepted_programs` become ACCEPT-AND-IGNORE tombstones (parsed, discarded - the unit parser
  400s unknown keys at `unitFields.ts:130-134`, and a stale cached dashboard bundle must not
  fail its save); `export function authoritiesOf(unit: { accepted_authorities?: unknown; jurisdiction?: unknown }): string[]`
  (new field wins; legacy single `jurisdiction` synthesizes `[jurisdiction]`; else `[]`); the
  flyer payload field RENAMES `accepted_programs` -> `accepted_authorities` and carries the
  synthesized list.

- [ ] **Step 1: Failing tests** in `unitFields.test.ts`. CORRECTION from review: the parser's
  real export is `validateUnitBody(body, mode)` - `parseUnitFields` does not exist. Open the
  file first, copy an existing `validateUnitBody` call to get the exact `mode` argument and
  result shape, then adapt:

```ts
describe('accepted_authorities consolidation', () => {
  it('accepts accepted_authorities and tombstones the legacy keys without error', () => {
    const r = validateUnitBody({ accepted_authorities: ['Atlanta (AHA)', 'DCA'], jurisdiction: 'x', accepted_programs: ['HCV'] }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields['accepted_authorities']).toEqual(['Atlanta (AHA)', 'DCA']);
      expect('jurisdiction' in r.fields).toBe(false);
      expect('accepted_programs' in r.fields).toBe(false);
    }
  });
  it('a save supplying ONLY tombstoned keys validates ok with an EMPTY field set', () => {
    const r = validateUnitBody({ jurisdiction: 'x' }, 'update');
    expect(r.ok).toBe(true); // tombstoned keys COUNT as supplied; the update set is empty
  });
  it('authoritiesOf: new field wins, legacy synthesizes, neither is empty', () => {
    expect(authoritiesOf({ accepted_authorities: ['DCA'], jurisdiction: 'old' })).toEqual(['DCA']);
    expect(authoritiesOf({ jurisdiction: 'atlanta_housing' })).toEqual(['atlanta_housing']);
    expect(authoritiesOf({})).toEqual([]);
    expect(authoritiesOf({ accepted_authorities: 'not-a-list', jurisdiction: 'j' })).toEqual(['j']);
  });
  it('toUnitFlyer projects accepted_authorities (synthesized) and no accepted_programs key', () => {
    const flyer = toUnitFlyer({ unitId: 'u1', landlordId: 'l1', status: 'available', jurisdiction: 'Atlanta (AHA)' } as never);
    expect(flyer.accepted_authorities).toEqual(['Atlanta (AHA)']);
    expect('accepted_programs' in flyer).toBe(false);
  });
});
```

- [ ] **Step 2: Run to fail** - `npm test -- unitFields`.
- [ ] **Step 3: Implement** - in WRITABLE_FIELDS replace the `jurisdiction` and
  `accepted_programs` entries with:

```ts
  // The decided model (spec section 8): the unit's accepted-authorities LIST.
  accepted_authorities: 'string[]',
```

  Add a tombstone set consumed by the parser loop (accept, skip):

```ts
/** Retired writable keys, accepted and DISCARDED for one transition (a stale
 *  cached dashboard bundle must not 400 its save). Die with
 *  docs/issues/retire-humanize-authority.md. */
const TOMBSTONED_FIELDS = new Set(['jurisdiction', 'accepted_programs']);
```

  In the parse loop (~:130), before the unknown-key rejection:
  `if (TOMBSTONED_FIELDS.has(key)) continue;`
  Add `authoritiesOf` (exported) next to `toUnitFlyer`; in the flyer type and projection replace
  `accepted_programs: string[]` with `accepted_authorities: string[]` fed by
  `authoritiesOf(unit)`. In `UnitItem` (`unitsRepo.ts:122-131`): add
  `accepted_authorities?: string[];` and re-comment `jurisdiction` as
  `/** LEGACY - read-only; synthesized into accepted_authorities (spec section 8). */`.
- [ ] **Step 4: Update EVERY test the rename/tombstone breaks** (review enumerated them - run
  the full app suite, not a filter, to prove the list complete):
  - `publicIntake.test.ts:322-330` - the flyer exact key-list pin: `accepted_programs` ->
    `accepted_authorities`.
  - `publicIntake.test.ts:303-314` - a VALUE assertion on the flyer's programs (becomes the
    synthesized authorities value, e.g. `['DCA']` - a value change, not just a key rename).
  - `unitFields.test.ts:218-241` - the flyer projection block asserting `accepted_programs`.
  - `app/test/unitsApi.test.ts:46-60` - a POST create asserting stored `jurisdiction`. Under
    the tombstone the create BODY's `jurisdiction` is discarded, so change BOTH the request
    body (send `accepted_authorities: [...]`) AND the assertion - changing only the assertion
    leaves the test red.
  - `app/test/unitsApi.test.ts:99` - `accepted_programs: [1,2]` expecting a 400: the tombstone
    now DISCARDS the key, so rewrite the test to assert acceptance-and-discard (200, field
    absent from the stored unit).
  - The tombstone no-op change also touches `unitFields.ts:189-191` (the no-updatable-fields
    check must count tombstoned keys as supplied).
  Also DELIBERATE, from the spec's section 8 flyer row: a legacy unit's synthesized flyer
  authorities ARE the old `jurisdiction` value, now public through the new field - update the
  flyer allowlist-wall test consciously, do not "fix" it by hiding the value.
  Run: `npm test` (app workspace, FULL) to pass.
- [ ] **Step 4c: the true-no-op ROUTE change** (review round 3: this was previously only a
  comment in a test fence - it must be a real step). In `app/src/routes/units.ts`'s PATCH
  handler, immediately after validation succeeds in UPDATE mode: if the validated field set is
  EMPTY, do NOT call `units.update` (any update stamps `updated_at` and writes a bare
  "Property updated" activity row - `units.ts:1304-1307`); instead
  `const existing = await units.getById(unitId);` -> if `undefined`, return the handler's
  EXISTING 404 shape (the normal path gets its 404 from update's `attribute_exists` condition,
  and an early return silently loses it - review round 3 finding 3); else return 200 with the
  unchanged unit in the handler's normal response shape. NO tombstone signal is needed: an
  empty-but-ok validation on update is reachable ONLY via tombstoned keys
  (`unitFields.ts:189-191` rejects a truly empty body). Route tests in `unitsApi.test.ts`:
  (a) PATCH `{jurisdiction:'x'}` on a real unit -> 200, `updated_at` UNCHANGED, activity feed
  gains NO row; (b) the same body on an unknown unitId -> 404.
- [ ] **Step 5: Commit** all touched files.

### Task 3: `similarUnits` scores authority overlap (app)

**Files:**
- Modify: `app/src/lib/similarUnits.ts:94-120`
- Test: `app/test/similarUnits.test.ts`

**Interfaces:**
- Consumes: `authoritiesOf` from Task 2.
- Produces: identical scoring shape; the overlap sets are `authoritiesOf(target)` /
  `authoritiesOf(candidate)`.

- [ ] **Step 1: Failing test** - add:

```ts
it('scores authority overlap across legacy and new fields', () => {
  const target = { ...unit('t'), accepted_authorities: ['Atlanta (AHA)', 'DCA'] };
  const legacy = { ...unit('c1'), jurisdiction: 'Atlanta (AHA)' };
  const miss = { ...unit('c2'), jurisdiction: 'Fulton County' };
  const scored = rankSimilarUnits(target, [legacy, miss]);
  expect(scored[0].unitId).toBe('c1');
});
```

  (CORRECTION from review: the real names are `rankSimilarUnits` and the fixture builder `unit` -
  open the file and match its exact signatures before writing.)
- [ ] **Step 2: Run to fail**, **Step 3:** swap both `(x.accepted_programs ?? []).filter(...)`
  set builds and the `:119-120` render guard to `authoritiesOf(x)`.
- [ ] **Step 4: Fix the tests the switch breaks** (enumerated by review): every seeded unit now
  synthesizes an authority, so the score is live where it was dormant -
  `app/test/unitsApiSimilar.test.ts:60,:115` and `similarUnits.test.ts:60-62` pin
  `matchPct === 100` values that change (recompute against the new scoring, e.g. 100 -> 80);
  any old programs-overlap test that would go vacuously green gets REPLACED by the new authority
  test, not left as decoration. Run the FULL app suite (`npm test`), not a name filter -
  `npm test -- similarUnits` cannot even match `unitsApiSimilar.test.ts`.
- [ ] **Step 5: commit** all touched files.

### Task 4: import unit writer -> canonical `accepted_authorities` (app)

**Files:**
- Modify: `app/src/lib/import/apply.ts:790-793`
- Test: `app/test/importApply.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `housingAuthorityFor` (same file, :362-367).
- Produces: the unit upsert writes `accepted_authorities = [housingAuthorityFor(row.housing_authority)]`
  when non-empty, and never writes `jurisdiction`.

- [ ] **Step 1: Failing test** - in the integration file's unit-apply block, copy the file's
  existing unit-apply test wholesale (its fixtures/harness are involved; reuse, never rebuild)
  and change the assertions: the fixture row's `housing_authority` cell is `atlanta housing`,
  and after apply the stored unit has `accepted_authorities === ['Atlanta (AHA)']` (the
  canonical spelling) and NO `jurisdiction` attribute.
- [ ] **Step 2: Run to fail** (`npm test -- importApply`), **Step 3:** replace :790-793 with:

```ts
  const authority = housingAuthorityFor(row.housing_authority);
  if (authority !== undefined) {
    sets.push('accepted_authorities = :accepted_authorities');
    values[':accepted_authorities'] = [authority];
  }
```

- [ ] **Step 4: Run to pass** (this may also require updating any existing assertion in the file
  that pins `jurisdiction` on an applied unit - invert it), **Step 5: commit**.

### Task 5: remove the dead API surface + the `byJurisdiction` GSI (app)

**Files:**
- Modify: `app/src/routes/units.ts` (:5 comment, :400-408 param branch),
  `app/src/repos/unitsRepo.ts` (:312-313 interface, :545-546 impl, :6 comment),
  `app/src/lib/tables.ts:109` (delete the GSI line),
  `app/test/helpers/twilioWebhookHarness.ts` (:1487 stub - delete its `listByJurisdiction`),
  `app/test/tables.test.ts:150-154`, `app/test/genTables.test.ts:181` (GSI lists),
  `app/test/unitsRepo.integration.test.ts` (:4 comment, :147-149 - delete the block)
- Generated: `infra/envs/dev/tables.auto.tfvars.json`, `infra/envs/prod/tables.auto.tfvars.json`
  via `npm run gen:tables` from the REPO ROOT (the script lives in the ROOT `package.json:29`;
  the generator is `app/scripts/gen-tables.ts` and `genTables.test.ts` proves its output)

**Interfaces:**
- Produces: `GET /api/units` no longer accepts `?jurisdiction=`; `UnitsRepo` has no
  `listByJurisdiction`; the units table schema has GSIs `byLandlord, byStatus, byProperty`.
  OWED POST-MERGE OP (record in the handback): `terraform apply` dev (prod at its gate) to drop
  the index - non-destructive.

- [ ] **Step 1: Update the two schema tests FIRST** (they are the failing tests): expected GSI
  arrays become `['byLandlord', 'byStatus', 'byProperty']`. Run `npm test -- tables genTables` -
  both FAIL against the current schema.
- [ ] **Step 2: Implement** - delete `tables.ts:109`; delete the repo interface method + impl;
  delete the route's `?jurisdiction=` branch (the `else if` at :407-408) and drop it from the :5
  comment AND the filter-order comment at `units.ts:367`; delete the harness stub's
  `listByJurisdiction` (at ~:1487, NOT :1402 - the file moved); in
  `unitsRepo.integration.test.ts` delete the :147-149 block AND update :132-137 (it seeds
  `jurisdiction` under an "each GSI" title that becomes false - switch the seed to
  `accepted_authorities` and retitle); also update the now-false GSI comments at
  `unitFields.ts:9,29` and `unitsRepo.ts:6`. Regenerate tfvars: the script is `gen:tables` in
  the ROOT `package.json:29` - run `npm run gen:tables` from the REPO ROOT of the worktree, not
  from app/ - BOTH env files change identically.
- [ ] **Step 3: Verify** - `npm test` (app workspace, FULL - a name filter misses
  `unitsApi.test.ts:216-239`, the `?jurisdiction=Fulton` filter test this task deletes), then
  `npm run typecheck` BARE (this is the step that catches any straggler reference).
  `unitsApi.test.ts:216-247`: the `it()` ALSO exercises `?landlordId=`, `?status=`, and the
  null-cursor behavior - delete ONLY the jurisdiction sub-assertions and keep the rest of the
  test intact.
- [ ] **Step 4: Commit** all files INCLUDING both generated tfvars, message noting the owed
  terraform apply.

### Task 6: seeds switch to `accepted_authorities` (app)

**Files:**
- Modify: `app/src/lib/seed/cast.ts` (:431, :635, :691, :1148, :1283), `lean.ts` (:145, :168),
  `live.ts` (:184, :206, :228), `matrix.ts` (:480, :535, :600, :658, :699, :725, :749)

**Interfaces:**
- Produces: every seed unit carries `accepted_authorities: [<same value>]`; no seed writes
  `jurisdiction`. VALUES stay as-is (slugs) - spelling normalization belongs to
  `docs/issues/retire-humanize-authority.md`, not here.

- [ ] **Step 1:** Mechanical edit at all 17 sites: `jurisdiction: X` -> `accepted_authorities: [X]`
  (keep `matrix.ts`'s `auth(counter)` calls; `lean.ts:145`'s comment `// byJurisdiction` becomes
  `// accepted authorities (spec section 8)`).
- [ ] **Step 2:** `grep -rn "jurisdiction" app/src/lib/seed/` returns NOTHING. Run
  `npm test` from `app/` - seed-dependent suites now seed the NEW field directly, so no
  synthesis is even involved.
- [ ] **Step 3: Commit** the four seed files.

### Task 7: dashboard types + `authoritiesOf` mirror

**Files:**
- Modify: `dashboard/src/api/types.ts` (Contact :1639, ContactPatch :1735, UnitItem :1822 -
  corrected against the current tree)
- Modify: `dashboard/src/routes/listing/listingFormat.ts` (add the helper; `buildListingFacts`
  :53 drops jurisdiction from the area join)
- Test: `dashboard/src/routes/listing/listingFormat.test.ts` (the REAL pin is the exact-string
  assertion at :72-74, not the fixture line at :70 - replace it with an equally exact
  full-string assertion of the NEW output, not a weaker contains-check; use the file's actual
  fixture name, not an invented `base`)

**Interfaces:**
- Produces: `Contact.agency?: string`, `ContactPatch.agency?: string`,
  `UnitItem.accepted_authorities?: string[]` (jurisdiction re-commented LEGACY);
  `export function authoritiesOf(unit: Pick<UnitItem, 'accepted_authorities' | 'jurisdiction'>): string[]`
  in `listingFormat.ts` - same three-way rule as the app helper (hand-mirror; comment points at
  `app/src/lib/unitFields.ts`).

- [ ] **Step 1: Failing tests** in `listingFormat.test.ts`:

```ts
it('authoritiesOf synthesizes legacy jurisdiction and prefers the new list', () => {
  expect(authoritiesOf({ accepted_authorities: ['DCA'], jurisdiction: 'x' })).toEqual(['DCA']);
  expect(authoritiesOf({ jurisdiction: 'Atlanta' })).toEqual(['Atlanta']);
  expect(authoritiesOf({})).toEqual([]);
});
```

  For the area change: open `listingFormat.test.ts`, find the EXACT-STRING assertion at :72-74
  (that is the real pin, on the file's own fixture - do not invent a `base`), and rewrite it to
  the full expected NEW string - the same facts line minus the jurisdiction element, still
  asserted with `toBe` (an exact string), never `toContain`.
- [ ] **Step 2: Run to fail** (`npm test -- listingFormat` from `dashboard/`), **Step 3:**
  implement the helper + change :53 to drop the jurisdiction element from the area join, add
  the three type fields, **Step 4: run to pass** + `npm run typecheck`, **Step 5: commit**.

### Task 8: `tenantFacets` - the pure facet engine (dashboard)

**Files:**
- Create: `dashboard/src/routes/contacts/tenantFacets.ts`
- Test: `dashboard/src/routes/contacts/tenantFacets.test.ts`

**Interfaces (later tasks depend on these EXACT names):**

```ts
export const NONE_KEY = '__none__';
export type VoucherBucketKey = '0' | '1' | '2' | '3' | '4plus';
export const VOUCHER_BUCKETS: ReadonlyArray<{ key: VoucherBucketKey; label: string }>;
  // [{key:'0',label:'Studio'},{key:'1',label:'1-BR'},{key:'2',label:'2-BR'},
  //  {key:'3',label:'3-BR'},{key:'4plus',label:'4+ BR'}] - labels via voucherSizeLabel
  //  (import from '../broadcasts/broadcastFormat.js'; do NOT restate strings).
export interface TenantSelection { voucher: ReadonlySet<string>; ha: ReadonlySet<string>; porting: boolean; }
export function parseSelection(params: URLSearchParams): TenantSelection;
export function applyToParams(params: URLSearchParams, sel: TenantSelection): void; // mutates: deletes voucher/ha/porting keys then re-adds; NEVER touches other keys
export function voucherBucketOf(c: Contact): VoucherBucketKey | null; // typeof c.voucherSize === 'number' -> the EXPLICIT bucket table (4 and above -> '4plus'); else null
export function normalizeAuthorityKey(raw: string): string; // trim, collapse ws, toLowerCase, underscores->spaces
export interface FacetOption { key: string; label: string; count: number; }
export interface TenantFacetModel {
  voucher: FacetOption[];      // fixed five + Not recorded last. Not recorded is ALWAYS
                               // present (spec section 5: the option list is stable and chips
                               // never vanish); at zero count it behaves like any other
                               // zero-count chip (aria-disabled unless selected)
  authority: FacetOption[];    // derived, sorted by label, + Not recorded last (same rule)
  authorityEmpty: boolean;     // zero recorded values
  voucherEmpty: boolean;
  showPorting: boolean;        // some tenant has porting === true
  portingCount: number;
}
export function buildFacets(tenants: Contact[], sel: TenantSelection, matchesQuery: (c: Contact) => boolean): TenantFacetModel;
export function applySelection(tenants: Contact[], sel: TenantSelection): Contact[];
export function factsLine(c: Contact): string | null; // exact facts: 'Studio' | `${n} BR`, joined to the stored authority AS-IS with the fromCharCode-built middot separator; null when neither present
```

Rules the tests pin (all from spec sections 5/6/10): explicit two-way bucket-key table (`4 ->
'4plus'`, never `String()`); `voucher=0` matched by string comparison; presence =
`typeof === 'number'` / non-empty string / `=== true`; counts per facet reflect the OTHER facet +
query + porting but not their own; option list from the FULL set, stable; authority options merge
by `normalizeAuthorityKey` with display = most frequent raw spelling (ties: first by sort);
unknown URL values dropped individually; `?porting=false` = absent; OR within, AND across; empty
selection = unconstrained.

- [ ] **Step 1: Failing tests** - write the suite BEFORE the module:

```ts
const t = (over: Partial<Contact>): Contact => ({ contactId: Math.random().toString(36).slice(2), type: 'tenant', ...over } as Contact);
const all = () => true;
const emptySel = (): TenantSelection => ({ voucher: new Set<string>(), ha: new Set<string>(), porting: false });
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';
describe('voucherBucketOf', () => {
  it('pins Studio=0 via typeof, never truthiness', () => { expect(voucherBucketOf(t({ voucherSize: 0 }))).toBe('0'); });
  it('caps at 4plus via the explicit table', () => { expect(voucherBucketOf(t({ voucherSize: 6 }))).toBe('4plus'); });
  it('null when absent', () => { expect(voucherBucketOf(t({}))).toBeNull(); });
});
describe('normalizeAuthorityKey', () => {
  it('folds case, whitespace, underscores', () => {
    for (const raw of ['atlanta_housing', 'Atlanta_Housing', 'Atlanta  Housing', ' Atlanta Housing ']) {
      expect(normalizeAuthorityKey(raw)).toBe('atlanta housing');
    }
  });
});
describe('buildFacets', () => {
  it('merges spelling variants into one option, displays most frequent, sums counts', () => {
    const m = buildFacets([t({ housingAuthority: 'Atlanta (AHA)' }), t({ housingAuthority: 'Atlanta (AHA)' }), t({ housingAuthority: 'atlanta (aha) ' })], emptySel(), all);
    const opt = m.authority.find((o) => o.key === 'atlanta (aha)')!;
    expect(opt.label).toBe('Atlanta (AHA)');
    expect(opt.count).toBe(3);
  });
  it('counts reflect the OTHER facet but not their own', () => {
    const tenants = [t({ voucherSize: 2, housingAuthority: 'DCA' }), t({ voucherSize: 3, housingAuthority: 'DCA' }), t({ voucherSize: 2, housingAuthority: 'Fulton County' })];
    const sel = { voucher: new Set(['2']), ha: new Set<string>(), porting: false };
    const m = buildFacets(tenants, sel, all);
    expect(m.authority.find((o) => o.key === 'dca')!.count).toBe(1);   // narrowed by voucher
    expect(m.voucher.find((o) => o.key === '2')!.count).toBe(2);       // NOT narrowed by itself
  });
  it('Not recorded buckets count the absent', () => {
    const m = buildFacets([t({}), t({ voucherSize: 1, housingAuthority: 'DCA' })], emptySel(), all);
    expect(m.voucher.find((o) => o.key === NONE_KEY)!.count).toBe(1);
    expect(m.authority.find((o) => o.key === NONE_KEY)!.count).toBe(1);
  });
  it('porting shows only when some tenant is === true', () => {
    expect(buildFacets([t({ porting: false })], emptySel(), all).showPorting).toBe(false);
    expect(buildFacets([t({ porting: true })], emptySel(), all).showPorting).toBe(true);
  });
  it('authorityEmpty when zero recorded', () => {
    expect(buildFacets([t({})], emptySel(), all).authorityEmpty).toBe(true);
  });
});
describe('applySelection', () => {
  it('OR within a facet, AND across, none-key matches the unrecorded', () => {
    const a = t({ voucherSize: 2, housingAuthority: 'DCA' });
    const b = t({ voucherSize: 3, housingAuthority: 'DCA' });
    const c = t({ voucherSize: 2 });
    expect(applySelection([a, b, c], { voucher: new Set(['2', '3']), ha: new Set(['dca']), porting: false })).toEqual([a, b]);
    expect(applySelection([a, c], { voucher: new Set<string>(), ha: new Set([NONE_KEY]), porting: false })).toEqual([c]);
  });
});
describe('URL round-trip', () => {
  it('parses repeated params, drops unknown voucher keys, string-matches 0 and 4plus, porting presence-only', () => {
    const p = new URLSearchParams('voucher=0&voucher=4plus&voucher=9&ha=dca&porting=false&phone=%2B14045550100');
    const sel = parseSelection(p);
    expect([...sel.voucher].sort()).toEqual(['0', '4plus']);
    expect(sel.porting).toBe(false);
    applyToParams(p, sel);
    expect(p.has('phone')).toBe(true);            // unrelated keys NEVER touched
    expect(p.getAll('voucher').sort()).toEqual(['0', '4plus']);
    expect(p.get('porting')).toBeNull();          // false -> absent
  });
});
describe('factsLine', () => {
  it('exact facts, middot join, collapses missing values', () => {
    expect(factsLine(t({ voucherSize: 6, housingAuthority: 'Dekalb County Housing' }))).toBe('6 BR' + SEP + 'Dekalb County Housing');
    expect(factsLine(t({ voucherSize: 0 }))).toBe('Studio');
    expect(factsLine(t({ housingAuthority: 'DCA' }))).toBe('DCA');
    expect(factsLine(t({}))).toBeNull();
  });
});
describe('option-list stability (spec section 5: pinned by test)', () => {
  it('applying a selection never changes which authority options exist', () => {
    const tenants = [t({ housingAuthority: 'DCA' }), t({ housingAuthority: 'Fulton County', voucherSize: 2 })];
    const before = buildFacets(tenants, emptySel(), all).authority.map((o) => o.key);
    const after = buildFacets(tenants, { voucher: new Set(['2']), ha: new Set<string>(), porting: false }, all).authority.map((o) => o.key);
    expect(after).toEqual(before); // counts change; the option LIST does not
  });
});
describe('porting filter', () => {
  it('porting: true keeps only tenants with porting === true', () => {
    const on = t({ porting: true });
    const off = t({ porting: false });
    const absent = t({});
    expect(applySelection([on, off, absent], { voucher: new Set<string>(), ha: new Set<string>(), porting: true })).toEqual([on]);
  });
});
```

  URL write form for porting: `applyToParams` sets `porting=1` when on (presence-only read;
  the value is never inspected). Define `SEP` in the test file as
  `' ' + String.fromCharCode(0xB7) + ' '`.

- [ ] **Step 2: Run to fail** (`npm test -- tenantFacets`), **Step 3: implement** the module to
  these tests (unknown `voucher` values: parseSelection keeps only members of the literal key
  set + NONE_KEY; unknown `ha` values: kept in the set but harmless - applySelection matches by
  normalized key so a ghost key matches nothing, and TenantFilters renders only real options;
  counts: for each facet compute the base = tenants filtered by query + the OTHER facets, then
  count per option), **Step 4: run to pass**, **Step 5: commit** both files.

### Task 9: `TenantFilters` component (dashboard)

**Files:**
- Create: `dashboard/src/routes/contacts/TenantFilters.tsx`,
  `dashboard/src/routes/contacts/TenantFilters.module.css`
- Test: `dashboard/src/routes/contacts/TenantFilters.test.tsx`

**Interfaces:**
- Consumes: `TenantFacetModel`, `TenantSelection`, `NONE_KEY` from Task 8.
- Produces: `export function TenantFilters({ model, selection, onChange }: { model: TenantFacetModel; selection: TenantSelection; onChange: (next: TenantSelection) => void }): React.JSX.Element`

Behavior (spec section 5): three labelled groups ("Voucher size" / "Housing authority" /
"Porting") of `aria-pressed` chip buttons + a per-facet Clear when non-empty, mirroring
`ListingsList.tsx:169-200`'s group markup; chips show `Label (N)`; an unselected zero-count chip
gets `aria-disabled="true"`, a no-op click, `cursor: default`, and a `.chipDisabled` class whose
`.chip.chipDisabled:hover` resets the hover treatment; a selected chip is ALWAYS active; the
zero-recorded empty states render the muted lines "No housing authorities recorded yet" / "No
voucher sizes recorded yet" instead of chips; the porting group renders only when
`model.showPorting`, its chip labelled `Porting` with `title="Tenant is porting"`. CSS from
tokens; `.controls`/`.chips` wrap (`flex-wrap`) per `ListingsList.module.css:72-116`.

- [ ] **Step 1: Failing tests** (jsdom, structure only - NO layout assertions). COMPLETE
  fixture preamble - the earlier draft left these undefined:

```tsx
import userEvent from '@testing-library/user-event';
const user = userEvent.setup();
const empty: TenantSelection = { voucher: new Set<string>(), ha: new Set<string>(), porting: false };
const tenant = (over: Partial<Contact>): Contact => ({ contactId: Math.random().toString(36).slice(2), type: 'tenant', ...over } as Contact);
// Models come from the REAL buildFacets - never hand-assemble the shape:
const model = buildFacets([tenant({ housingAuthority: 'DCA' }), tenant({ housingAuthority: 'DCA' })], empty, () => true);
const withZeroCount = buildFacets([tenant({ voucherSize: 2 })], { ...empty, voucher: new Set(['2']) } as TenantSelection, () => true); // Studio contextual count 0
const authorityEmptyModel = buildFacets([tenant({})], empty, () => true);

it('renders groups, counts, and toggles a chip through onChange', async () => {
  const onChange = vi.fn();
  render(<TenantFilters model={model} selection={empty} onChange={onChange} />);
  await user.click(screen.getByRole('button', { name: 'DCA (2)' }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ha: new Set(['dca']) }));
});
it('zero-count unselected chip is aria-disabled, focusable, and inert', async () => {
  const onChange = vi.fn();
  render(<TenantFilters model={withZeroCount} selection={empty} onChange={onChange} />);
  const chip = screen.getByRole('button', { name: 'Studio (0)' });
  expect(chip).toHaveAttribute('aria-disabled', 'true');
  chip.focus();
  expect(chip).toHaveFocus();
  await user.click(chip);
  expect(onChange).not.toHaveBeenCalled();
});
it('a SELECTED chip with contextual count 0 is STILL clickable - no deselection deadlock', async () => {
  const onChange = vi.fn();
  // '2' is selected AND its contextual count is 0: the only 2-BR tenant is
  // excluded by the OTHER facet (ha selection matches nobody with voucher 2).
  const sel: TenantSelection = { voucher: new Set(['2']), ha: new Set(['dca']), porting: false };
  const tenants = [tenant({ voucherSize: 2 }), tenant({ voucherSize: 3, housingAuthority: 'DCA' })];
  const m = buildFacets(tenants, sel, () => true);
  expect(m.voucher.find((o) => o.key === '2')!.count).toBe(0); // the precondition A6 demanded
  render(<TenantFilters model={m} selection={sel} onChange={onChange} />);
  await user.click(screen.getByRole('button', { name: /2-BR \(0\)/ }));
  expect(onChange).toHaveBeenCalled(); // aria-disabled must key on count===0 AND NOT selected
});
it('zero-recorded authority facet renders the empty line, no chips', () => {
  render(<TenantFilters model={authorityEmptyModel} selection={empty} onChange={vi.fn()} />);
  expect(screen.getByText('No housing authorities recorded yet')).toBeInTheDocument();
});
```
- [ ] **Step 2-5:** fail, implement, pass (`npm test -- TenantFilters`), commit.

### Task 10: `ContactsList` wiring - URL state, controls, row facts, CSS, page limit (dashboard)

**Files:**
- Modify: `dashboard/src/routes/contacts/ContactsList.tsx`,
  `dashboard/src/routes/contacts/ContactsList.module.css`,
  `dashboard/src/routes/contacts/useContacts.ts` (:27 - pass `limit: '100'`),
  `dashboard/src/api/endpoints.ts` (`getContacts` params gain `limit?: string`, passed through
  in `query`)
- Test: `dashboard/src/routes/contacts/ContactsList.test.tsx` (extend)

**Interfaces:** consumes Tasks 8 + 9. Everything below is spec sections 5, 6, 10 - re-read them
before this task; they are the authority.

Implementation checklist, all in `ContactsList.tsx`:
1. `const [searchParams, setSearchParams] = useSearchParams();` selection =
   `parseSelection(searchParams)` (derived, not state). Writes:
   `const next = new URLSearchParams(searchParams); applyToParams(next, sel); setSearchParams(next, { replace: true });`
2. Controls + facet APPLICATION gated on `filter === 'tenant'`: `const isTenantView = filter === 'tenant';`
   `visible = useMemo(...)` applies query THEN (`isTenantView ? applySelection(...) : identity`).
3. `buildFacets(contacts, selection, matchesQuery)` where `matchesQuery` reuses `searchKey`.
4. `<TenantFilters .../>` rendered between the filter tabs and the search block, only when
   `isTenantView && status === 'ready'`.
5. Tab links: the Tenants entry's `to` becomes
   `{ pathname: '/contacts/tenants', search: isTenantView ? searchParams.toString() : '' }`;
   the other four stay bare strings. (Leaving the view drops facets BY DESIGN - spec 10.)
6. `Row` gains a `showFacts: boolean` prop (`contact.type === 'tenant' && filter !== 'deleted'`);
   inside `.meta`, AFTER the status chip: `{showFacts && facts ? (<span className={styles.facts} title={facts}>{facts}</span>) : null}`
   then `{showFacts && contact.porting === true ? (<span className={styles.porting} title="Tenant is porting">Porting</span>) : null}`
   where `const facts = factsLine(contact)`. The row Link ALSO gains the `.factsRow` class
   whenever ANY chip was added - `showFacts && (facts !== null || contact.porting === true)` -
   not just when facts exist (a porting-only tenant still gains a fourth unshrinkable chip).
   The wide-pane sacrifice-order CSS keys off `.factsRow` (per-ROW), NOT `.tenantList`
   (per-route), because facts render on `/contacts` (All) too and the name-crush failure would
   otherwise survive there. Only the DENSITY rules stay route-scoped (mixed density in one list
   is a bug; mixed shrink behavior is invisible).
7. `noMatches` gains ListingsList's conditional (`ListingsList.tsx:244-248` precedence: the
   query message when `query.trim()`, else `No tenants match the selected filters.`).
8. The `<ul className={styles.rows}>` gains `styles.tenantList` when `isTenantView`.

`ContactsList.module.css` additions (tokens only):

```css
/* Facts-row + tenant-route modifiers (spec section 6). Sacrifice order (facts
 * truncate first; the name never shrinks, only caps) is PER-ROW (.factsRow) -
 * facts render on the All view too. Density alone is route-scoped
 * (.tenantList) so no list ever mixes densities. */
.facts { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-muted); font-size: var(--fs-xs); font-weight: var(--fw-medium); }
.porting { flex: 0 0 auto; padding: 1px var(--sp-2); border-radius: var(--radius-pill); border: 1px solid var(--c-warning); color: var(--c-warning); font-size: var(--fs-xs); font-weight: var(--fw-semibold); white-space: nowrap; }
.factsRow .name { flex: 1 0 auto; max-width: 55cqw; }
.factsRow .meta { flex: 0 1 auto; min-width: 0; }
@container (max-width: 560px) {
  .tenantList .row { padding: var(--sp-2) var(--sp-3); }
  .tenantList .rowItem { margin-bottom: var(--sp-1); }
  .factsRow .name { flex: 1 1 100%; max-width: none; white-space: normal; overflow: visible; text-overflow: clip; }
  .factsRow .meta { flex: 1 1 100%; }
}
```

  (`.rowItem` is the `<li>`; the ul carries `.tenantList` so both selectors reach their targets.
  The narrow-pane name block is `ListingsList.module.css:292-299`'s idiom.)

- [ ] **Step 1: Failing tests** - extend `ContactsList.test.tsx`. CORRECTION from review: that
  file's real harness MOCKS `useContacts` (not `getContacts`) and renders inside a bare
  `MemoryRouter` - open it, copy its actual setup block, and drive tests by setting the mocked
  `useContacts` return value; use `<MemoryRouter initialEntries={['/contacts/tenants?voucher=0']}>`
  for URL cases and a tiny location-probe child (`const Probe = () => { const loc = useLocation(); return <div data-testid="loc">{loc.search}</div>; }`)
  to assert writes. Seed mock tenants covering `voucherSize` 0 and 6:

```tsx
// Shared arrange: mock useContacts to return { status: 'ready', contacts: TENANTS } where
// TENANTS = [t0 (voucherSize 0, DCA), t6 (voucherSize 6, 'Fulton County', porting true),
// tNone (no size, no authority), landlord (type 'landlord')]. Render via
// <MemoryRouter initialEntries={[url]}><Routes>...<ContactsList filter=.../> + <Probe/>.

it('tenant view: controls render, a chip narrows the list, the URL carries it', async () => {
  renderAt('/contacts/tenants');
  await user.click(screen.getByRole('button', { name: /Studio \(1\)/ }));
  const rows = within(screen.getByRole('list', { name: 'Tenants' })); // scoped - TenantFilters must not count
  expect(rows.getAllByRole('listitem')).toHaveLength(1); // only t0 remains
  expect(screen.getByTestId('loc').textContent).toContain('voucher=0');
});
it('all/landlord views: no controls, facet params inert', () => {
  // ('deleted' is outside this suite's route helper union - covered by the e2e layer.)
  // The useContacts mock must be VIEW-AWARE here (return only the landlord fixture for the
  // landlords view) - the hook is mocked, so ContactsList does no type filtering of its own,
  // and a filter-blind mock would render all four fixtures and void the exact count.
  renderAt('/contacts/landlords?voucher=0');
  expect(screen.queryByRole('button', { name: /Studio/ })).toBeNull();
  const rows = within(screen.getByRole('list', { name: 'Landlords' }));
  expect(rows.getAllByRole('listitem')).toHaveLength(1); // EXACT: the one landlord fixture -
  // a >0 assertion would pass even if the param wrongly filtered (the failure case itself)
});
it('tenant rows show facts + keep kind/phone/status; landlord rows show none', () => {
  renderAt('/contacts');
  const rows = within(screen.getByRole('list', { name: 'Contacts' })); // scope to the ROWS ul
  const row6 = rows.getByRole('link', { name: new RegExp('6 BR') });
  expect(row6.textContent).toContain('Fulton County');
  expect(row6.textContent).toMatch(/\(\d{3}\)/); // phone kept in the same link
  // The landlord fixture MUST carry firstName/lastName in the arrange block
  // (nameless -> contactDisplayName falls back to the phone and this query throws):
  expect(rows.getByRole('link', { name: /Lana Landlord/ }).textContent).not.toContain('BR');
});
it('?voucher=0 and ?voucher=4plus round-trip a re-render at the same URL', () => {
  renderAt('/contacts/tenants?voucher=0&voucher=4plus');
  expect(screen.getByRole('button', { name: /Studio/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /4\+ BR/ })).toHaveAttribute('aria-pressed', 'true');
});
it('active Tenants tab preserves params; Landlords tab is bare', () => {
  renderAt('/contacts/tenants?voucher=0');
  const bar = within(screen.getByRole('navigation', { name: 'Filter contacts' }));
  // Exact string equality via getAttribute - no asymmetric matcher inside
  // toHaveAttribute (support UNVERIFIED), and no unscoped substring match that
  // would pass on a wrong pathname:
  expect(bar.getByRole('link', { name: 'Tenants' }).getAttribute('href')).toBe('/contacts/tenants?voucher=0');
  expect(bar.getByRole('link', { name: 'Landlords' }).getAttribute('href')).toBe('/contacts/landlords');
  // The tab-link change also touches the existing exact href assertions at
  // ContactsList.test.tsx:73-79 - update them in the same pass.
});
it('facets + empty query -> the filter-miss message', async () => {
  renderAt('/contacts/tenants?voucher=3'); // no tenant has bucket 3
  expect(screen.getByText('No tenants match the selected filters.')).toBeInTheDocument();
});
```

  `renderAt` is a tiny local helper this suite defines around its EXISTING setup idiom (mocked
  `useContacts`, `MemoryRouter` with `initialEntries`) - build it from the file's current
  tests, do not import a harness that is not there. The tab-link change ALSO touches the
  existing tab assertions at `ContactsList.test.tsx:73-79` - update them deliberately.

- [ ] **Step 1b: the `limit=100` test** - `useContacts` is mocked in the component suite, so the
  page-limit change needs its own test. `dashboard/src/routes/contacts/useContacts.test.tsx`
  ALREADY EXISTS with six tests - EXTEND it (Write/overwrite destroys them) IN ITS OWN IDIOM:
  the file drives the hook through a Probe component, not renderHook - copy one of its existing
  tests wholesale. Mock `getContacts` to resolve ONE EMPTY PAGE using the file's OWN `page()`
  helper (a rejecting or hanging mock leaves the test green over the hook's error path),
  mount the probe with filter `'tenant'` (the hook throws without a filter), and
  `await waitFor(() => expect(getContacts).toHaveBeenCalledWith(expect.objectContaining({ limit: '100' }), expect.anything()));`
- [ ] **Step 2-4:** fail -> implement (the checklist above) -> pass
  (`npm test -- ContactsList tenantFacets TenantFilters useContacts`), plus `npm run typecheck`.
  While in `useContacts.ts`, also update its :14-17 page-math comment (the 40 x 50 arithmetic
  changes with limit=100).
- [ ] **Step 5: Commit** the six files (the five modified plus `useContacts.test.tsx`).

### Task 11: contact edit form - authority datalist + agency input (dashboard)

**Files:**
- Modify: `dashboard/src/routes/contact/ContactEditForm.tsx` (:167 state, :297 patch-diff,
  :479-489 the authority input)
- Create: `dashboard/src/routes/contact/orgVocabulary.ts`
- Test: `dashboard/src/routes/contact/ContactEditForm.test.tsx` (extend)

**Interfaces:**
- Produces: `orgVocabulary.ts` exports
  `export const AUTHORITY_SUGGESTIONS = ['Atlanta (AHA)', 'Jonesboro (JHA)', 'Dekalb County Housing', 'DCA', 'Fulton County', 'Clayton County', 'East Point', 'McDonough'] as const;`
  `export const AGENCY_SUGGESTIONS = ['HUD VASH', 'Claratel', 'Hope Atlanta', 'Step Up'] as const;`
  with a header comment: `// HAND-MIRROR of the canonical spellings in app/src/lib/import/apply.ts (CANONICAL_AUTHORITY) - keep in sync by hand; no cross-workspace import exists. Taxonomy: docs/issues/housing-authority-free-text-drift.md.`
  `export function collapseOrgInput(raw: string): string` - `raw.trim().replace(/\s+/g, ' ')`.

Behavior (spec section 7): both inputs are `<input list={id}>` + `<datalist id={id}>` per
`CustomFieldsEditor.tsx:62-82`; ids from `useId()`; NO `autoComplete` attribute; the agency
input's visible label text is exactly `Agency`; placeholders `e.g. Atlanta (AHA)` /
`e.g. Hope Atlanta`; the agency input sits directly below the authority input in the same
tenant-only block.

**DIFF RULE - twice corrected by review, get this exactly right.** `housingAuthority` is in
`PROVENANCE_FIELDS` (`contacts.ts:1324-1327`): any PATCH that carries it clears AI provenance
and consumes pending suggestions (`:1332-1340`). So a field whose EFFECTIVE value did not
change must NEVER reach the PATCH. Collapse BOTH sides for the comparison; send the collapsed
value:

```ts
const nextAuthority = collapseOrgInput(housingAuthority);
if (nextAuthority !== collapseOrgInput(str(contact.housingAuthority))) {
  patch.housingAuthority = nextAuthority;
}
const nextAgency = collapseOrgInput(agency);
if (nextAgency !== collapseOrgInput(str(contact.agency))) {
  patch.agency = nextAgency;
}
```

Why both sides: collapse-before-diff against the RAW stored value re-PATCHes an untouched field
whenever the STORE carries stray whitespace; raw-vs-raw re-PATCHes on a whitespace-ONLY edit
(same effective value, provenance still destroyed). Collapse-both-sides is a no-op in both
cases and sends only on a real value change.

- [ ] **Step 1: Failing tests:**

```tsx
it('authority input suggests the eight canonical spellings via a datalist and keeps free text', async () => {
  render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
  const input = screen.getByLabelText(/Housing authority/i);
  expect(input).toHaveAttribute('list');
  const datalist = document.getElementById(input.getAttribute('list')!)!;
  expect(datalist.querySelectorAll('option')).toHaveLength(8);
  await user.type(input, 'Brand New Authority');
  await user.click(screen.getByRole('button', { name: /^Save$/i }));
  expect(updateContact).toHaveBeenCalledWith('k1', expect.objectContaining({ housingAuthority: 'Brand New Authority' }));
});
it('agency input PATCHes trimmed', async () => {
  render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.type(screen.getByLabelText(/^Agency$/i), '  Hope   Atlanta ');
  await user.click(screen.getByRole('button', { name: /^Save$/i }));
  expect(updateContact).toHaveBeenCalledWith('k1', expect.objectContaining({ agency: 'Hope Atlanta' }));
});
it('an untouched authority NEVER reaches the PATCH (provenance protection)', async () => {
  const stored = { ...TENANT, housingAuthority: 'Atlanta  (AHA) ' }; // stray whitespace IN STORE
  updateContact.mockResolvedValue(stored);
  render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.type(screen.getByLabelText(/First name/i), 'X'); // dirty something else
  await user.click(screen.getByRole('button', { name: /^Save$/i }));
  const sent = updateContact.mock.calls[0]![1] as Record<string, unknown>;
  expect('housingAuthority' in sent).toBe(false); // collapse-before-diff would have re-sent it
});
it('a whitespace-ONLY edit is also a no-op (same effective value)', async () => {
  // LOCAL fixture - do NOT add housingAuthority to the shared TENANT (it would
  // break the exact-assertion test at :70-77).
  const stored = { ...TENANT, housingAuthority: 'Atlanta (AHA)' };
  updateContact.mockResolvedValue(stored);
  render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.type(screen.getByLabelText(/Housing authority/i), ' '); // trailing space only
  await user.type(screen.getByLabelText(/First name/i), 'X');
  await user.click(screen.getByRole('button', { name: /^Save$/i }));
  const sent = updateContact.mock.calls[0]![1] as Record<string, unknown>;
  expect('housingAuthority' in sent).toBe(false); // raw-vs-raw would have re-sent it
});
```

Test preamble: declare `const user = userEvent.setup();` and give EVERY test its
`updateContact.mockResolvedValue(...)` - the review caught both omissions (and the same class
in Task 9's earlier draft).

- [ ] **Step 2-5:** fail -> implement -> pass (`npm test -- ContactEditForm`) -> commit (three
  files).

### Task 12: tenant file Agency row (dashboard)

**Files:**
- Modify: `dashboard/src/routes/contact/TenantFile.tsx` (the Details card, after the
  Housing authority KV at :164)
- Test: `dashboard/src/routes/contact/files.test.tsx` (extend - it renders TenantFile)

- [ ] **Step 1: Failing test:** with a contact fixture carrying `agency: 'Hope Atlanta'`, plain
  `getByText('Agency')` + the value rendered - `files.test.tsx` renders `TenantFile` in
  isolation, where no custom-field row exists to collide (the earlier `within(detailsCard)`
  instruction was wrong: the Card is an unnamed `<section>` with no accessible handle). The
  REAL collision surface is live data: a deployed custom field labelled "Agency" exists, so a
  tenant can render BOTH rows - operations-side cleanup, note it in the handback, and in live
  QA identify the first-class row by its position in the Details card.
- [ ] **Step 2-5:** fail -> add
  `<KV k="Agency" v={contact.agency ?? BLANK} />` right after the Housing authority KV
  (`BLANK` is the exported blank constant from `./Card.js` - reuse it, never paste a literal
  dash) -> pass -> commit.

### Task 13: unit forms - ONE authorities input (dashboard)

**Files:**
- Modify: `dashboard/src/routes/listing/UnitCreateForm.tsx` (:54 state, :149 submit, :294-307
  the jurisdiction field; plus its accepted-programs input), `ListingEditForm.tsx` (:34, :54,
  :110, :158-160, :216-230)
- Test: `UnitCreateForm`/`ListingEditForm` test files (extend; `ListingEditForm.test.tsx:18,24,98`
  seed the old fields)

Behavior (spec section 8): the "Housing authority" single input AND the existing programs comma
input - whose REAL label is `Accepted vouchers / programs` (`ListingEditForm.tsx:417-424`), not
"Accepted programs" - are REPLACED by one labelled "Housing authorities" comma-separated input
using the same split-on-comma/trim/drop-empties idiom (`ListingEditForm.tsx:158-160`),
placeholder `e.g. Atlanta (AHA), DCA`. Create sends `accepted_authorities` when non-empty; edit
diffs against `authoritiesOf(unit).join(', ')` (the dashboard helper from Task 7) so a
legacy-jurisdiction unit shows its synthesized value in the input. Tests to update include the
label-anchored queries at `ListingEditForm.test.tsx:36,92-93`.

- [ ] **Step 1: Failing tests:** create-form submits
  `accepted_authorities: ['Atlanta (AHA)', 'DCA']` from typing `Atlanta (AHA), DCA`; edit form
  seeded with `{ jurisdiction: 'ga_dca' }` (no new field) shows `ga_dca` in the input and
  PATCHes `accepted_authorities: ['ga_dca', 'DCA']` after appending `, DCA`; neither form ever
  sends `jurisdiction` or `accepted_programs`.
- [ ] **Step 2-5:** fail -> implement -> pass (`npm test -- UnitCreateForm ListingEditForm`) ->
  commit.

### Task 14: unit read surfaces - properties facet, detail row, flyer (dashboard)

**Files:**
- Modify: `dashboard/src/routes/listings/ListingsList.tsx` (:89-95 options, :101-105 filter),
  `dashboard/src/routes/listing/ListingDetail.tsx` (:727 KV; :282 programs),
  `dashboard/src/routes/public/FlyerPage.tsx` (:253-254), `dashboard/src/routes/public/publicApi.ts` (:36)
- Test: `ListingsList.test.tsx` (:21,:32 seed slugs - stay green via synthesis),
  `ListingDetail.test.tsx` (:86,:101), `FlyerPage.test.tsx` (:37)

Behavior: `ListingsList` derives its authority options from `authoritiesOf(u)` with SPEC
SECTION 8's NORMALIZED-KEY GROUPING (import `normalizeAuthorityKey` from
`../contacts/tenantFacets.js`): options group by normalized key (display = most frequent raw
spelling), `selectedHAs` holds normalized KEYS, and the filter predicate is list-aware - a unit
matches when ANY of `authoritiesOf(u)` normalizes to a selected key. The humanize call stays
EXACTLY as-is on the displayed values (do not touch `humanizeAuthority`; the retire issue owns
it). `ListingDetail`: the Jurisdiction KV (:729) AND the programs display (:282 and the second
render site at :750-760, asserted by `ListingDetail.test.tsx:259-261`) become ONE
`<KV k="Housing authorities" v={authoritiesOf(unit).join(', ') || BLANK} />` - `BLANK` imported
from the shared card module (it is already importable there; NEVER paste a literal dash, the
file's own em-dash idiom predates the ASCII rule). `publicApi.ts:36` renames the flyer field to
`accepted_authorities: string[]`; `FlyerPage` renders
`Accepts: {flyer.accepted_authorities.join(', ')}` when non-empty.

- [ ] **Step 1: Failing tests:** ListingDetail fixture with only `jurisdiction: 'Atlanta'` shows
  "Housing authorities" -> "Atlanta"; FlyerPage gains an EXPLICIT render assertion (fixture
  field renamed AND `expect(screen.getByText(/Accepts: Atlanta \(AHA\), DCA/)).toBeInTheDocument()`
  on a two-authority fixture - the spec's section 11 names this assertion); ListingsList: a unit
  with `accepted_authorities: ['atlanta_housing', 'ga_dca']` appears under BOTH chips, and a
  slug-seeded unit + a prose-typed variant of the same authority group under ONE chip.
- [ ] **Step 2-5:** fail -> implement -> pass
  (`npm test -- ListingsList ListingDetail FlyerPage listingFormat`) + `npm run typecheck` ->
  commit.

### Task 15: e2e - steps, the new contacts-list spec, seed-arg sweep

**Files:**
- Modify: `e2e/scenarios/steps.ts` (:816-828 `seedAvailableUnit` takes
  `accepted_authorities?: string[]` and posts it, default `['atlanta_housing']`; :1440-1458 the
  create-form step fills the "Housing authorities" input)
- Modify: the 12 spec files that actually SEED `jurisdiction:` (13 grep hits, one is prose -
  verify with `grep -rln "jurisdiction" e2e/tests/` and read each) - mechanical arg rename to
  `accepted_authorities: ['atlanta_housing']`
- Create: `e2e/tests/dashboard-next/contacts-list-facets.spec.ts`
- Modify: `e2e/support/selectors.md` (the new controls + the String.fromCharCode(0xB7)
  construction rule, the same form as its em-dash row)

The new spec (lean world has ONE tenant, so create your own per spec section 11):

```ts
test('tenant facets narrow the list and survive reload', async ({ page }) => {
  // Arrange: three tenants via teamCreatesTenant (steps.ts:604-651 - the real
  // step name; it supports voucherSize/housingAuthority):
  // 2BR/DCA, 3BR/DCA, 2BR/'Fulton County'.
  // Act: open /contacts/tenants; click the '2-BR' chip, then the 'DCA' chip.
  // Assert: exactly the 2BR/DCA tenant row remains; the row facts read
  //   '2 BR' + String.fromCharCode(0xB7) + 'DCA' with spaces (fromCharCode,
  //   never a literal); page.reload(); the same single row remains and both
  //   chips are pressed (aria-pressed true).
});
```

  Write it with the harness's real step vocabulary (dev-login, `steps.*` helpers) copied from a
  neighboring `dashboard-next` spec's arrange block.
- [ ] **Steps:** write the spec; update steps + sweep the 12 seeding files; run the SINGLE new spec
  from the `e2e/` workspace dir against a session lane when the wiring exists; commit. The FULL
  suite runs in the final gates, not here.

### Task 16: GLOSSARY + final gates

**Files:**
- Modify: `documentation/GLOSSARY.md` - three entries: housing authority (issuer; exactly one
  per tenant; porting = moving between authorities), agency (helper org; caseworker-linked;
  never unit-tied; Hope Atlanta / HUD VASH / Claratel / Step Up), accepted authorities (the
  unit's landlord-chosen list; jurisdiction-vs-acceptance is a two-question framing, ONE field).
  Match the file's existing entry format.
- [ ] **Step 1:** write the entries; verify only the ADDED lines are ASCII:
  `git diff -U0 documentation/GLOSSARY.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0
  (the file may hold legacy non-ASCII; the rule covers added lines).
- [ ] **Step 1b: STRAGGLER SWEEP** - the retired fields must not survive in prose:
  `grep -rn "accepted_programs\|jurisdiction" app/src app/test dashboard/src documentation e2e/support --include=*.ts --include=*.tsx --include=*.md`
  (NOTE `app/test` is in the sweep - test TITLES count) and fix every hit that is not (a) the
  tombstone set itself, (b) the LEGACY-commented type fields, (c) a retire-issue/drift-issue
  reference, or (d) LEGACY FIXTURE DATA a test deliberately depends on - e.g.
  `unitFields.test.ts:181` seeds `jurisdiction` precisely to prove synthesis, and Task 2's
  `['DCA']` flyer assertion rides on it; a literal sweep must not undo Task 2. Known hits from review: `documentation/GLOSSARY.md:150` (names
  `accepted_programs` as a per-property fact), `app/src/routes/contacts.ts:307` +
  `app/src/repos/contactsRepo.ts:254-255` (the field-move comments), any remaining GSI
  comments, `app/test/tables.test.ts:150`'s test title, and the `useContacts.ts` page-math
  comment if Task 10 missed it.
- [ ] **Step 2:** commit.
- [ ] **Step 3: FINAL GATES**, bare, from the worktree, containers warm:
  `npm run typecheck` then `npm test` then `timeout 1500 npm run e2e`. Known flakes
  (`tour-reminders-panel-e2e-flake`, `conversationdetail-members-mock-suite-flake`): re-run the
  full suite once before blaming the change; report both runs.
- [ ] **Step 4:** live self-QA per spec section 11 (hermetic `npm run e2e:session` lane, NEVER
  lane 0): the two layout acceptance criteria at 375px and ~700px, the datalist dropdowns, a
  facet round-trip. Screenshots under `.playwright-mcp/`.

---

## Self-review notes (already applied)

- Spec coverage walked section-by-section: 5 -> Tasks 8/9/10; 6 -> 8/10; 7 -> 11; 8 -> 2/3/4/5/6/13/14/15;
  4 -> 1/10; 10 -> 8/10; 11 -> every task's test steps + Task 16 gates; GLOSSARY -> 16.
- The one deliberate deviation from bite-size: Tasks 6 and 15 are mechanical sweeps committed as
  single units - a per-file cycle would be ceremony without a distinct deliverable.
- Type-consistency check: `authoritiesOf` exists TWICE by design (app `unitFields.ts`, dashboard
  `listingFormat.ts`) - hand-mirrored, each commented at the source. `TenantSelection`,
  `NONE_KEY`, `factsLine`, `VOUCHER_BUCKETS` are defined once in Task 8 and consumed by name in
  Tasks 9/10/15.
