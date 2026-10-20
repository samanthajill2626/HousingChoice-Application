# Implementation plan - Landlord requirements and property fields (tracker #11 + #12)

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-20-property-requirements-design.md`
  (revision 6, APPROVED by Cameron 2026-10-20). Decisions are cited D1-D13,
  D10a; "spec section N" means its numbered sections 1-7.
- Branch `feat/property-requirements`, worktree `W:\tmp\property-requirements`,
  cut from main @1d7a4667. Mission records:
  `docs/superpowers/reviews/2026-10-20-property-requirements/`.
- Spec review: 4 rounds (the cap) + Cameron's two gate decisions -
  `docs/superpowers/reviews/2026-10-20-property-requirements/design-review/adjudications.md`.
- Status: PLAN v1 DRAFT (2026-10-20), before plan review. Sections 0-4 are
  BINDING; slice sections 5-11 are the opus section drafts, verbatim; section
  4 (assembly rulings) wins over any slice text it contradicts. The drafts
  themselves (gitignored, under `.superpowers/sdd/plan-drafts/`) are never
  the authority.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case.
- Commits: a separate bare `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\property-requirements\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for a pre-existing file with non-ASCII (`unitFields.ts`, `unitsRepo.ts`,
  `units.ts` and several dashboard files carry em dashes and arrows), only
  ADDED lines must be ASCII: `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. Do not add new em dashes; the copy in 1.1 uses ASCII hyphens.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - verify any
  literal backslash-u with `grep -n '\\u'` after the edit.
- Dependencies: the planner ran `npm ci` at the worktree root on 2026-10-20
  (log `.superpowers/sdd/npm-ci.log`). Never symlink another worktree's
  node_modules.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`, e2e only through
  the e2e workspace (`npm run e2e`, or `npm run e2e:session` + the
  Playwright MCP). Never pipe a test or gate command. Every app vitest run,
  even a pure file, needs DynamoDB Local (`npm run db:start` STARTS it; never
  RESTART the shared container - it wipes local data; ask the human).
  `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY for a pure-file red/green
  step, never for a gate.
- Never touch the live stack (`:5174` / `:8080`).
- Never edit dashboard/app source while this worktree's e2e suite runs (it
  serves the source live).
- Line numbers in this plan are hints against main @1d7a4667; the QUOTED
  text is the anchor. Where an earlier task changed a region, re-read the
  current text and apply the change ON TOP of it - never revert an earlier
  task.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- EIGHT requirement items (D1), in this order, with these groups, fields
  and flyer visibility. Item ids, unit keys and landlord keys are BINDING:

  | Group | Item id | Item label | Unit key | Kind | Field label | Flyer |
  |---|---|---|---|---|---|---|
  | Screening | `evictions` | Evictions | `no_evictions_on_program` | checkbox | No evictions while on the program | Staff only |
  | | | | `evictions_notes` | text | Evictions (details) | Staff only |
  | Screening | `credit_requirements` | Credit score | `credit_requirements` | text | Credit score | Staff only |
  | Screening | `income_requirements` | Income requirements | `income_requirements` | text | Income requirements | Staff only |
  | Screening | `qualifications` | Qualifications | `qualifications` | long_text | Qualifications | Staff only |
  | Pets | `pets` | Pets | `no_pets` | checkbox | No pets | On flyer |
  | | | | `pets` | text (legacy boolean read/write, D1) | Pets (details) | On flyer |
  | | | | `pet_fee` | text | Pet fee | On flyer |
  | Move-in costs | `deposit` | Deposit | `deposit_one_month` | checkbox | One month's rent | On flyer |
  | | | | `deposit` | money | Fixed amount | On flyer |
  | | | | `deposit_flexible` | checkbox | Flexible / payment terms available | On flyer |
  | | | | `deposit_notes` | text | Deposit notes | Staff only |
  | Move-in costs | `application_fee` | Application fee | `application_fee` | money (0 = No application fee) | Application fee (+ checkbox "No application fee") | On flyer |
  | Touring | `touring` | Touring | `tour_type` | tour_type | Tour type | Staff only |
  | | | | `tour_process` | text | Tour process | Staff only |

  Landlord keys are `req_` + the unit key (`req_no_evictions_on_program`
  ... `req_tour_process`, 15 keys). No boolean `req_pets`.
- Value kinds (D1): checkbox = `true` or absent (`false`/null REMOVE);
  text = trimmed string ('' / null REMOVE); money = finite number >= 0 or
  null (REMOVE); `tour_type` unchanged (`self_guided` / `landlord_led` /
  `pm_team`, '' / null REMOVE). Deposit: a resulting record holding BOTH
  `deposit_one_month` and `deposit` is a 400 `{ error: 'deposit_conflict' }`
  (checked against a CONSISTENT read of the stored record whenever the body
  carries any Deposit key).
- Legacy unit `pets` boolean (D1): READ `false` = No pets checked + details
  blank; `true` = No pets unchecked + details "Allowed". WRITE of a boolean
  stores the new shape at once (`false` -> `no_pets: true` + `pets` REMOVEd;
  `true` -> `no_pets` REMOVEd + `pets: 'Allowed'`). A write touching some
  Pets keys on a unit whose STORED `pets` is a boolean also stores `no_pets`
  and `pets` in the new shape with their interpreted values. Free text is
  never parsed.
- Item equality (D1): every key of the item equal after interpretation;
  absent / '' / `false` all blank; text trimmed, case-sensitive; numbers
  exact.
- `requirement_sources` (D5): a plain map `{ <item id>: 'copied' | 'set_here' }`
  on the unit, server-written only (never in `WRITABLE_FIELDS`), always
  written WHOLE in the same update as the item keys; an empty map REMOVEs
  the attribute; absent item = never touched.
- Classification (D5): every item whose INTERPRETED value a write changes
  is compared with "the landlord's value": equal -> `copied`, different ->
  `set_here`. The landlord's value is the snapshot (create with
  `requirements_snapshot`, all items it names), the landlord's CURRENT
  values (create without a snapshot - only items written non-blank; PATCH),
  or the Apply's landlord values (Apply: every changing item -> `copied`).
  No landlord -> every touched item `set_here`. A landlord change (PATCH
  `landlordId`, `restoreWithLandlord` onto a different landlord, the
  `addContact` landlord claim) REMOVEs the map in the same write; a PATCH
  that changes the landlord AND touches items resets first, then classifies
  against the NEW landlord. The importer's fill of an absent `landlordId`
  leaves the map alone. The landlord's own edits never touch a property.
- PATCH fence (D5): when the body touches any requirement key or changes
  `landlordId`, a consistent read of the unit + the landlord contact, then
  ONE write conditioned on the unit's `requirement_sources` and
  `landlordId` being what was read (absent included); on a condition
  failure re-read and recompute, at most 3 attempts in all, then 409
  `{ error: 'property_changed' }`.
- Tags (D6): equal -> no tag; different + `copied` -> orange "Landlord
  updated" + "Landlord now: <v>"; different + `set_here` -> purple "Set on
  this property" + "Landlord: <v>"; different + never touched + property
  not blank -> as `set_here`; property blank + never touched + landlord not
  blank -> "Landlord: <v>" only. A blank landlord value prints "blank" and
  COUNTS as differing. No landlord or a failed landlord load -> no tags, no
  lines. OWN VALUE = `set_here`, or never touched with a non-blank property
  value, whatever the landlord holds.
- Voucher sizes (D4): `voucher_size_accepted` write kind accepts null / `[]`
  (REMOVE), an integer 0..12 (stored as a one-item list), or an array of
  integers 0..12 (stored de-duplicated, ascending); anything else 400.
  `acceptedVoucherSizes` stays the ONE reader (app + dashboard mirror).
- Matching (D12): `bedroomSizes: number[]` of chip values 0..4, 4 = "4 or
  more"; legacy `bedroomSize: n` reads as `[min(n, 4)]` through ONE
  normalizer; POST accepts either (`bedroomSizes` wins); the wire returns
  `bedroomSizes` always and `bedroomSize` (the first) when non-empty.
- Nothing filters or ranks on the requirements (spec section 5). No
  backfill, no importer change, no AI prompt change.

### 1.1 Exact copy (BINDING - tests assert these strings)

`<L>` = the landlord contact's display name as the page already shows it;
`<N>`, `<M>` = counts; `<v>` = `formatItemValue` (2.6).

Forms (D10, D10a, D9):
- Field tags: `On flyer`, `Staff only`. Landlord form: `On property flyers`,
  `Staff only`.
- Legend (property forms), two lines: `On flyer - tenants see it on the public flyer.`
  and `Staff only - never leaves the dashboard.`
- Legend (landlord form), two lines: `On property flyers - copied to this landlord's properties, where tenants see it on the public flyer.`
  and `Staff only - never leaves the dashboard.`
- Under each PUBLIC free-text box (pets details, pet fee, tenant-paid
  utilities, accessibility, lease terms): `Tenants see this on the public flyer.`
  (on the landlord form: the same sentence under pets details and pet fee).
- Section heading on every form: `Requirements`; on the landlord form the
  fieldset legend is `Requirements / Qualifications`.
- Group headings: `Screening`, `Pets`, `Move-in costs`, `Touring`.
- Field labels: the 1.0 table's "Field label" column, plus the checkbox
  `No application fee` above the `Application fee` amount; `Subzone`;
  `Washer / dryer` (a select: `Not recorded`, `Hookups`,
  `Washer and dryer included`, `No hookups`); `Voucher sizes accepted`.
- Voucher picker (D4): chips `Studio`, `1`, `2`, `3`, `4`, then `5`..`12`;
  controls `More sizes (5-12)` and `Fewer sizes`; summary line
  `Accepts: ` + sizes as `Studio`, `<n> BR` joined by `, ` (empty:
  `Accepts: none recorded`); off-chip values:
  `Not a valid size, removed when you save: ` + values joined by `, `.
- 409 `property_changed` on the edit form: `This property changed while you were saving. Save again.`
- Create form (D7): `Filled in from <L>'s requirements. Change anything that is different for this property.`;
  loading `Loading <L>'s requirements...`; failure
  `Couldn't load <L>'s requirements, so this property starts without them. You can apply them from the landlord page later.`
  with a button `Try again`.

Property page (D6, D10):
- Card titles `Requirements`; Property details rows `Subzone`,
  `Washer / dryer`, `Voucher sizes accepted` (value: `Studio`, `<n> BR`
  joined by `, `; empty shows the page's existing blank marker).
- Tags `Set on this property` (purple), `Landlord updated` (orange); lines
  `Landlord: <v>` and `Landlord now: <v>`; blank prints `blank`.
- No requirements: `<L> has no requirements recorded yet.`
- Activity (D13): `Requirements applied from the landlord` (followed by the
  field names exactly as the existing "Property updated" line lists them).

Landlord page (D8, D9):
- Card title `Requirements / Qualifications`; actions `Apply to properties`,
  `Edit`. Apply disabled reason (no properties): `This landlord has no properties yet.`
- Notes empty state: `No notes yet - use + Add.`
- Dialog title `Apply to properties`; columns `What to copy`,
  `Which properties`; blank item mark `Clears`; own-value mark `own value`;
  no-change row `Already matches`; button `Update <N> properties`
  (`Update 1 property` for one); loading `Loading...`; load error
  `Couldn't load this landlord's properties.` + `Try again`.
- 409 `requirements_changed`: `This landlord's requirements changed. Review the updated list and press Update again.`
- Stopped mid-run: `Updated <N> properties before this stopped. Review the rest and press Update again.`
- Done: `Updated <N> properties` (`Updated 1 property`), and when any were
  skipped `<M> skipped` with one line per skipped row
  `<address> - <reason>`, reasons: `changed_since_opened` and
  `changed_during_apply` -> `changed since you opened this - review it again`;
  `already_matches` -> `already matches`; `landlord_changed` ->
  `has a different landlord now`; `deleted` -> `was deleted`; `not_found`
  -> `no longer exists`.

Flyer (D11):
- `Fits a studio voucher`; `Fits a 2-bedroom voucher`;
  `Fits a 2- or 3-bedroom voucher`; `Fits a studio or 1-bedroom voucher`;
  `Fits a 1-, 2-, or 3-bedroom voucher`; general rule: sizes ascending,
  studio as `studio`, every non-final number as `<n>-`, the final number as
  `<n>-bedroom` (a final studio as `studio`), two joined by ` or `, three or
  more by `, ` with `, or ` before the last.
- Pets row: `No pets`, `No pets (<details>)`, or `<details>`; legacy
  `true` -> `Allowed`, `false` -> `No pets`. Row `Pet fee`.
- Deposit row: `One month's rent` or `$N`, + `, flexible / payment plan available`;
  flexible alone `Flexible / payment plan available`; no row for notes alone.
- Application fee row: `No application fee` for 0, else `$N`.
- Row `Washer / dryer` with `Hookups` / `Washer and dryer included` /
  `No hookups`.
- `$N` uses the flyer's EXISTING dollar formatter.

Matching (D12):
- Pre-fill note: `Pre-filled to the voucher sizes this property takes: ` +
  the chip labels as `voucherSizeLabel` gives them, joined by `, `.
- Audience summary lists the same labels joined by `, `.

## 2. Binding interfaces

Names, signatures and wire shapes below are BINDING across slices. A
section writer who finds one wrong against the code raises a CONTRACT ISSUE
at the top of its draft instead of silently deviating.

### 2.1 App: `app/src/lib/requirements.ts` (NEW, pure, no I/O)

```ts
export type RequirementItemId =
  | 'evictions' | 'credit_requirements' | 'income_requirements' | 'qualifications'
  | 'pets' | 'deposit' | 'application_fee' | 'touring';
export type RequirementGroup = 'Screening' | 'Pets' | 'Move-in costs' | 'Touring';
export type RequirementFieldKind = 'checkbox' | 'text' | 'long_text' | 'money' | 'tour_type';
export type FlyerVisibility = 'on_flyer' | 'staff_only';

export interface RequirementField {
  key: string;            // unit key, e.g. 'no_pets'
  landlordKey: string;    // 'req_' + key
  label: string;          // 1.0 "Field label"
  kind: RequirementFieldKind;
  flyer: FlyerVisibility;
}
export interface RequirementItem {
  id: RequirementItemId;
  label: string;
  group: RequirementGroup;
  fields: readonly RequirementField[];
}
/** D1, in display order. */
export const REQUIREMENT_ITEMS: readonly RequirementItem[];
export const REQUIREMENT_ITEM_IDS: readonly RequirementItemId[];
export const REQUIREMENT_UNIT_KEYS: readonly string[];      // 15, item order then field order
export const REQUIREMENT_LANDLORD_KEYS: readonly string[];  // 15 'req_' keys, same order
export function isRequirementItemId(v: unknown): v is RequirementItemId;
export function itemOfUnitKey(key: string): RequirementItem | undefined;

/** One item's value: every key of the item -> its interpreted value; null = blank. */
export type ItemValue = Record<string, string | number | true | null>;

/** D1 read interpretation from a UNIT record (legacy pets boolean, trim, blank -> null). */
export function unitItemValue(unit: Record<string, unknown>, id: RequirementItemId): ItemValue;
/** The same from a LANDLORD contact (req_ keys; never a boolean pets). Keys of the
 *  returned value are the UNIT keys, so unit and landlord values compare directly. */
export function landlordItemValue(contact: Record<string, unknown>, id: RequirementItemId): ItemValue;
export function itemValuesEqual(a: ItemValue, b: ItemValue): boolean;
export function isItemBlank(v: ItemValue): boolean;

/** D1 kinds, shared by the unit validator and the landlord validator.
 *  ok.value: the value to store, or null = REMOVE. */
export function normalizeRequirementValue(
  field: RequirementField, value: unknown, keyForError: string,
): { ok: true; value: string | number | true | null } | { ok: false; error: string };
/** D2: pick the req_ keys out of a contacts PATCH body (unknown req_ keys ignored, like
 *  every unknown contact key). fields maps req_ key -> value or null (REMOVE). */
export function parseLandlordRequirementPatch(
  body: Record<string, unknown>,
): { ok: true; fields: Record<string, string | number | true | null> } | { ok: false; error: string };
/** D1: true when the record (unit keys, or req_ keys with side 'landlord') holds both a
 *  one-month deposit and a fixed amount. */
export function hasDepositConflict(record: Record<string, unknown>, side: 'unit' | 'landlord'): boolean;

export type RequirementSource = 'copied' | 'set_here';
export type RequirementSources = Partial<Record<RequirementItemId, RequirementSource>>;
/** Defensive read of the stored map: non-object -> {}; unknown ids / values dropped. */
export function readRequirementSources(raw: unknown): RequirementSources;
/** D6 OWN VALUE. */
export function isOwnValue(sources: RequirementSources, id: RequirementItemId, unitValue: ItemValue): boolean;

/** D5 create snapshot, as parsed from the wire (2.4). */
export interface RequirementsSnapshot {
  landlordId: string;
  items: Partial<Record<RequirementItemId, ItemValue>>;   // keys = unit keys; missing key = blank
}
export function parseRequirementsSnapshot(
  raw: unknown,
): { ok: true; snapshot: RequirementsSnapshot } | { ok: false; error: string };

/** D5 classification - the ONE rule for create and PATCH.
 *  changed = items whose interpreted value differs between `before` and `after`;
 *  classified = changed, plus (create with a snapshot) every item the snapshot names.
 *  Target per classified item: the snapshot's item when named, else
 *  landlordItemValue(landlord, id); no landlord -> 'set_here'.
 *  Returns the WHOLE next map: `current` with the classified items overwritten. */
export function nextRequirementSources(input: {
  before: Record<string, unknown>;          // {} on create
  after: Record<string, unknown>;           // the unit as it will be stored
  current: RequirementSources;              // {} on create or after a landlord-change reset
  landlord: Record<string, unknown> | undefined;
  snapshot?: RequirementsSnapshot;          // create only
}): RequirementSources;

/** D8 per-unit Apply decision (pure). `landlordValues` = landlordItemValue for every listed
 *  item (already checked equal to `expected` by the route). */
export type ApplySkipReason =
  | 'not_found' | 'deleted' | 'landlord_changed'
  | 'changed_since_opened' | 'already_matches' | 'changed_during_apply';
export function planUnitApply(input: {
  unit: Record<string, unknown> | undefined;    // consistent read; undefined = not found
  landlordId: string;
  items: readonly RequirementItemId[];
  landlordValues: Partial<Record<RequirementItemId, ItemValue>>;
  ownItems: readonly RequirementItemId[];
}):
  | { kind: 'skip'; reason: Exclude<ApplySkipReason, 'changed_during_apply'> }
  | { kind: 'write'; patch: Record<string, unknown>;  // unit keys -> value or null, plus requirement_sources (map or null)
      changedKeys: string[]; changedItems: RequirementItemId[] };

/** D10a: every field on the New / Edit property forms, in form order. */
export interface FormFieldVisibility {
  label: string;               // the form label (1.1)
  keys: readonly string[];     // the unit key(s) the field writes
  flyer: FlyerVisibility;
}
export const PROPERTY_FORM_FIELDS: readonly FormFieldVisibility[];

export const WASHER_DRYER_VALUES: readonly ['hookups', 'included', 'none'];
export const VOUCHER_SIZE_MAX: 12;
```

`planUnitApply` writes, for each CHANGING item, every key of the item to the
landlord's value (SET, or null = REMOVE for blank), so a legacy boolean
`pets` is rewritten into the new shape as part of the Pets item. Its
`requirement_sources` is `{...readRequirementSources(unit.requirement_sources), <each changing item>: 'copied'}`
(null when empty). `changedKeys` lists the unit keys whose STORED value the
write changes (for the audit), never `requirement_sources`. Check order:
not found, deleted, landlord changed, then changing items by interpreted
value; nothing changing -> `already_matches`; a changing item that is an
own value and not in `ownItems` -> `changed_since_opened`.

### 2.2 App: `app/src/lib/unitFields.ts`

- `WRITABLE_FIELDS` gains `no_evictions_on_program`, `evictions_notes`,
  `credit_requirements`, `income_requirements`, `qualifications`, `no_pets`,
  `pet_fee`, `deposit_one_month`, `deposit_flexible`, `deposit_notes`,
  `washer_dryer`; `deposit`, `application_fee`, `tour_process`, `pets`,
  `tour_type` change kind per 1.0; `subzone` becomes clearable text;
  `voucher_size_accepted` becomes the list kind (D4). Requirement keys
  validate through `normalizeRequirementValue`.
- `pets` boolean on write: the validator emits the new shape
  (`pets: false` -> `{ no_pets: true, pets: null }`; `pets: true` ->
  `{ no_pets: null, pets: 'Allowed' }`). A body carrying a boolean `pets`
  together with `no_pets` is a 400
  `pets: a boolean pets cannot be combined with no_pets`.
- `validateUnitBody` stays pure and does NOT check `deposit_conflict` (that
  needs the stored record; S2 does it in the route).
- `UnitFlyer` / `toUnitFlyer` (D11): REMOVES `subzone`; ADDS
  `voucher_sizes: number[]`, `no_pets: boolean`, `pet_fee: string | null`,
  `deposit_one_month: boolean`, `deposit_flexible: boolean`,
  `washer_dryer: 'hookups' | 'included' | 'none' | null`; KEEPS
  `voucher_size`, `deposit`, `application_fee`, `pets` (now: the details
  text per the read interpretation - a legacy `true` -> 'Allowed', a legacy
  `false` -> null with `no_pets: true`; type `string | null`). Never public:
  every Staff-only key in 1.0 and `requirement_sources`.

### 2.3 App: `app/src/repos/unitsRepo.ts`

```ts
// UnitItem gains the 1.0 keys (pets: string | boolean stays), washer_dryer,
// voucher_size_accepted?: number | number[], requirement_sources?: Record<string, 'copied' | 'set_here'>.

/** D5 PATCH fence: SET non-null / REMOVE null fields of `patch`, stamp updated_at, conditioned on
 *  attribute_exists(unitId) AND landlordId AND requirement_sources exactly as in `read`
 *  (attribute_not_exists when absent). Throws ConditionalCheckFailedException on any condition
 *  failure; the CALLER re-reads to tell a missing unit (404) from a race (retry). ALL_NEW. */
updateIfRequirementsCurrent(read: UnitItem, patch: Record<string, unknown>): Promise<UnitItem>;
/** D8: the same fence plus attribute_not_exists(deleted_at). */
applyRequirements(read: UnitItem, patch: Record<string, unknown>): Promise<UnitItem>;
```

`restoreWithLandlord` (a restore whose new landlord differs from the stored
one) and `addContact` (the landlord claim on an ownerless unit) add
`requirement_sources: null` to the patch they already write. The in-memory
harness repo (`app/test/helpers/twilioWebhookHarness.ts:2857-2925`)
implements both new methods and both REMOVEs with the same conditions.

### 2.4 App: wire

- POST `/api/units` body MAY carry `requirements_snapshot` (the route
  removes it before `validateUnitBody`): `{ landlordId: string,
  <item id>: { <unit key>: string | number | boolean | null } }`. 400
  `requirements_snapshot must be an object with a landlordId` (not an
  object / no string `landlordId`); 400
  `requirements_snapshot.<item id> must be an object` (an item value that is
  not a plain object); 400
  `requirements_snapshot.landlordId does not match landlordId`. Unknown item
  ids and unknown keys inside an item are ignored; a missing key counts as
  blank; values are read through the item's kinds (a value that fails its
  kind counts as blank - trusted, not verified, D5). Create also answers
  400 `deposit_conflict` when the created record would hold both.
- PATCH `/api/units/:unitId`: as today, plus 400 `deposit_conflict`, 409
  `property_changed`, and `requirement_sources` maintained per D5.
- Every unit response carries `requirement_sources` as stored (absent when
  never written).
- Audit `unit_updated` `fields` = the unit keys the write SETs or REMOVEs
  (body keys after normalization plus keys the server added - the pets
  partner, a cleared deposit amount), never `requirement_sources`. On the
  plain path (no requirement key, no landlord change) it stays today's
  `Object.keys(validation.fields)`.
- PATCH `/api/contacts/:contactId`: accepts the 15 `req_` keys per
  `parseLandlordRequirementPatch`; any present `req_` key on a contact whose
  RESULTING type is not `landlord` -> 400
  `requirements can only be set on a landlord`; 400 `deposit_conflict`
  against a consistent read of the stored contact merged with the body;
  audit `contact_updated` lists the changed `req_` keys with the other
  changed fields. A `req_pets` write never touches `pets`, `pets_source` or
  AI suggestions. Contact CREATE ignores `req_` keys.
- POST `/api/contacts/:contactId/requirements/apply` (D8): body
  `{ units: [{ unitId: string, ownItems: string[] }], items: string[], expected: { <item id>: { <unit key>: value | null } } }`.
  Order of refusals: 404 `{ error: 'contact_not_found' }`; 400
  `{ error: <message> }` for: not a landlord (`contact is not a landlord`),
  `items` empty or naming an unknown item, `expected` not covering exactly
  the listed items and their keys, `units` empty / repeating a unit / over
  100, an `ownItems` entry not in `items`; 409
  `{ error: 'deposit_conflict' }` when the landlord holds both; 409
  `{ error: 'requirements_changed' }` when any listed item's CURRENT
  landlord value is not equal (D1) to `expected`. Then per unit in order:
  consistent read, `planUnitApply`, `unitsRepo.applyRequirements`; a
  `ConditionalCheckFailedException` -> skip `changed_during_apply`. Each
  written unit: audit `unit_updated` `{ actor, fields: changedKeys, reason: 'requirements_applied', landlordId }`.
  200 `{ updated: string[], skipped: Array<{ unitId: string, reason: ApplySkipReason }> }`.
- `toUnitActivityEvent` (`units.ts:311-376`) lifts `reason` for
  `unit_updated` ONLY when it is exactly `'requirements_applied'`.

### 2.5 App: Matching (`blastAudienceRules.ts`, `broadcastsRepo.ts`, `broadcasts.ts`, `audienceResolution.ts`)

```ts
// broadcastsRepo.ts AudienceFilter:
//   bedroomSizes?: number[];          // D12: chip values 0..4, 4 = 4 or more; stored by new drafts
//   /** @deprecated legacy stored shape; read ONLY through bedroomSizesOfFilter */
//   bedroomSize?: number;

// blastAudienceRules.ts
export const VOUCHER_CHIP_MAX = 4;
/** D12 - the ONLY reader of a filter's voucher sizes: bedroomSizes when it is an array
 *  (finite integers kept, each min(n, 4), de-duplicated, ascending), else a finite
 *  legacy bedroomSize as [min(n, 4)], else []. */
export function bedroomSizesOfFilter(
  filter: { bedroomSizes?: unknown; bedroomSize?: unknown } | undefined,
): number[];
/** D12 match: empty sizes -> true; else tenant size defined and (size in sizes when
 *  size < 4, or 4 in sizes when size >= 4). */
export function voucherSizeMatches(sizes: readonly number[], tenantSize: number | undefined): boolean;
// WireAudienceFilter: bedroomSizes: number[] (always), bedroomSize?: number (first, when non-empty)
```

POST `/api/broadcasts` `audience_filter`: `bedroomSizes` = an array of
integers 0..12 (400 `audience_filter.bedroomSizes must be an array of integers 0..12`),
`bedroomSize` as today; both present -> `bedroomSizes` wins; stored as
`bedroomSizes` (normalized; omitted when empty), never `bedroomSize`. The
resolver uses `voucherSizeMatches(bedroomSizesOfFilter(filter), voucherSizeOf(contact))`
and logs `bedroomSizesFilter` (the list) in place of `bedroomSizeFilter`.

### 2.6 Dashboard

- `dashboard/src/routes/listing/requirements.ts` (NEW): the hand MIRROR of
  2.1's pure exports (same names, same cases in its test), plus:

  ```ts
  /** D6 display of one item on a property. landlord undefined = no landlord or not loaded. */
  export interface RequirementDisplay {
    tag: 'set_here' | 'landlord_updated' | null;
    landlordLine: string | null;   // 'Landlord: <v>' | 'Landlord now: <v>' | null
  }
  export function requirementDisplay(
    unit: UnitItem, landlord: Contact | undefined, id: RequirementItemId,
  ): RequirementDisplay;
  /** One item value as one line: the parts below joined by '; '; all blank -> 'blank'.
   *  evictions: 'No evictions while on the program', details;
   *  credit / income / qualifications: the text;
   *  pets: 'No pets', details, 'pet fee ' + fee;
   *  deposit: "One month's rent" or '$N', 'flexible', notes;
   *  application_fee: 0 -> 'No application fee', else '$N';
   *  touring: the tour type's existing dashboard label, tour process. */
  export function formatItemValue(id: RequirementItemId, value: ItemValue): string;
  /** True when the landlord holds no requirement at all (every item blank). */
  export function landlordHasNoRequirements(landlord: Contact): boolean;
  ```
- `dashboard/src/routes/listing/FlyerTag.tsx` (NEW): `FlyerTag`
  (`{ visibility: FlyerVisibility; audience: 'property' | 'landlord'; id: string }`
  - renders the tag OUTSIDE any `<label>` with the given `id` for the
  field's `aria-describedby`) and `FlyerLegend` (`{ audience }`).
- `dashboard/src/routes/listing/VoucherSizePicker.tsx` (NEW):
  `{ value: number[]; invalid: readonly unknown[]; onChange(next: number[]): void; disabled?: boolean }`
  (picker B, toggle buttons with `aria-pressed`, group labelled
  `Voucher sizes accepted`).
- `dashboard/src/routes/listing/RequirementsFields.tsx` (NEW): the shared
  Requirements section for the three forms:
  `{ values: RequirementFormValues; onChange(next: RequirementFormValues): void; audience: 'property' | 'landlord'; disabled?: boolean }`,
  where `RequirementFormValues` is keyed by UNIT key (the landlord form maps
  `req_` keys in and out).
- `dashboard/src/routes/listing/PropertyRequirementsCard.tsx` (NEW): the
  property page card (D6, D10).
- `dashboard/src/routes/contact/LandlordRequirementsCard.tsx` (NEW) and
  `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx` (NEW): D8, D9.
- `dashboard/src/api/endpoints.ts`: `applyLandlordRequirements(contactId: string, body: ApplyRequirementsBody, signal?: AbortSignal): Promise<ApplyRequirementsResult>`;
  `createUnit` accepts `requirements_snapshot`.
- `dashboard/src/api/types.ts`: `UnitItem` gains the 1.0 keys,
  `washer_dryer`, `voucher_size_accepted?: number | number[]`,
  `requirement_sources?: Partial<Record<RequirementItemId, 'copied' | 'set_here'>>`;
  `Contact` and `ContactPatch` gain the 15 `req_` keys; `AudienceFilter`
  gains `bedroomSizes?: number[]` (keeps `bedroomSize?: number` for reading
  old pages' data only).

## 3. Slices, task numbering, order

Order S1 -> S7, strictly sequential. Each slice ends green on its own unit
suites and `npm run typecheck`. The e2e suite is NOT expected green until
S7. Stated mid-build breakage (nothing to fix before S7 unless a slice says
so):

- From S1: a stored voucher size becomes a list on every save, so the
  property page's "Voucher size accepted" row (number-only) goes blank and
  `e2e/scenarios/steps.ts` voucher assertions fail until S6/S7; the flyer
  stops showing subzone; '' on `tour_process` / `pets` now REMOVEs.
- From S2: the unit create/PATCH responses carry `requirement_sources`.
- From S4 (app part) to S4 (dashboard part): the server stores
  `bedroomSizes`; dashboard reads `bedroomSize` from the wire's compat key.
- S5 changes form labels (`Pets` -> `Pets (details)`, `Deposit` ->
  `Fixed amount`, `Voucher size accepted` -> `Voucher sizes accepted`, ...),
  so e2e selectors against them fail until S7.

Slices:

- **S1 - App foundations** (Tasks 1.x): the registry module 2.1 (items,
  kinds, interpretation, equality, sources read, own value, snapshot parse,
  `nextRequirementSources`, `planUnitApply`, `PROPERTY_FORM_FIELDS`, the
  landlord patch parser, deposit conflict); the unit validator 2.2;
  `UnitItem` / `ContactItem` types; `toUnitFlyer` 2.2 + the D10a parity
  walk; the stale comments (`unitsRepo.ts:443-446`, the flyer never-list).
- **S2 - App property writes** (Tasks 2.x): repo 2.3 (both fenced methods,
  the two landlord-change REMOVEs) + the harness repo + the real/fake
  parity test; POST create (snapshot, classification, `deposit_conflict`);
  PATCH (read path, legacy pets partner, `deposit_conflict`, landlord
  change reset, classification, fence + retry + 409, audit fields);
  `toUnitActivityEvent`.
- **S3 - App landlord and Apply** (Tasks 3.x): contacts PATCH `req_` keys;
  the Apply route; the full-profile seed (one demo landlord with
  requirements; its properties with one copied, one set-here and one
  landlord-updated item; the `[2, 3]` unit stays); lean byte-stable.
- **S4 - Matching, app and dashboard** (Tasks 4.x): 2.5 server side, the
  matrix seed (one legacy `bedroomSize`, one `bedroomSizes`); dashboard
  types, `AudienceFilters` multi-select, `BroadcastComposer` pre-fill (one
  chip per accepted size, 4+ mapping, tags, note), `broadcastFormat`
  summary, `useComposerDraft` draft key, `BroadcastsList` /
  `BroadcastResults`.
- **S5 - Dashboard property forms** (Tasks 5.x): types + endpoints (2.6),
  the dashboard registry mirror + D10a parity, `FlyerTag` / `FlyerLegend`,
  `VoucherSizePicker`, `RequirementsFields`, `ListingEditForm` (order, tags,
  legend, picker, subzone, washer/dryer, requirements, No application fee,
  One month's rent, the 409 message), `UnitCreateForm` (the same fields +
  landlord prefill, snapshot, refill, load / failure states).
- **S6 - Dashboard pages** (Tasks 6.x): `requirementDisplay` /
  `formatItemValue`; `PropertyRequirementsCard` + `ListingDetail` (rows
  moved and added) + `useListing` (re-read the landlord on a `landlordId`
  change); `listingFormat` (sizes formatting, Activity label);
  `FlyerPage` + `publicApi` (D11); `LandlordRequirementsCard` +
  `ContactEditForm` fieldset + the Notes copy; `ApplyRequirementsDialog` +
  `LandlordFile` / `ContactDetail` wiring + `useContactFile` refetch and the
  page taking the dialog's contact.
- **S7 - e2e, docs, completion** (Tasks 7.x): repair every e2e spec and
  step that asserts an old shape (spec section 7 list, plus the label
  sweep below); the two `getByLabel('Notes')` selectors `{ exact: true }`;
  the new e2e spec (spec section 6 "E2E"); GLOSSARY, the mermaid line, the
  issue registry (close two issues, partly close `unit-onboarding-fields`);
  the five gates; the single main sync; the handback.

### 3.1 Invariant enumeration (BINDING - every row is a task or a watch item)

| State | Writers (task) | Readers / renderers (task) |
|---|---|---|
| Unit requirement keys | `validateUnitBody` (1.x); POST create (2.x); PATCH (2.x); Apply (3.x); full seed (3.x); lean / live / matrix seeds write `pets` / `deposit` directly (WATCH: unchanged values, lean byte-stable); importer (WATCH: writes none of them, `apply.ts:1476-1621`); extraction (WATCH: writes TENANT contact `pets` / `evictions`, never units or `req_` keys) | `toUnitFlyer` (1.x); `FlyerPage` (6.x); `ListingDetail` + `PropertyRequirementsCard` (6.x); both property forms (5.x); WATCH (semantics unchanged, re-run their tests): `TourDetail.tsx:716`, `ScheduleTourForm.tsx:247-292`, `listingSendOutcome.ts:112`, `contact/Card.tsx:221`, `units.ts:1466-1470` `tour_type_required` |
| `requirement_sources` | create, PATCH (2.x); Apply (3.x); `restoreWithLandlord`, `addContact` claim (2.x); harness repo (2.x); full seed (3.x); importer fill of `landlordId` (WATCH: must not write it) | `PropertyRequirementsCard` (6.x); Apply dialog own values (6.x); Apply route (3.x); NEVER in `toUnitFlyer` (1.x test) or any audit `fields` (2.x, 3.x tests) |
| Landlord `req_` keys | contacts PATCH (3.x); full seed (3.x); contact create (WATCH: ignores them, 3.x test) | `LandlordRequirementsCard`, `ContactEditForm` (6.x); `UnitCreateForm` prefill (5.x); `requirementDisplay` (6.x); Apply dialog + route (6.x, 3.x); WATCH: the tenant `pets` / `evictions` / `pets_source` path in contacts PATCH stays untouched (3.x test) |
| `voucher_size_accepted` (list) | validator (1.x); both forms (5.x); seeds (WATCH: `cast.ts:1358` `[2, 3]` stays) | `acceptedVoucherSizes` app + mirror (unchanged code, list cases re-pinned 1.x / 5.x); `toUnitFlyer` (1.x); `FlyerPage` (6.x); `ListingDetail` row (6.x); forms (5.x); composer pre-fill (4.x); WATCH: `unitListFacets.ts:175-196` (already list-ready) |
| Audience `bedroomSizes` | `parseAudienceFilter` (4.x); composer (4.x); matrix seed (4.x) | resolver (4.x); `wireAudienceFilter` (create echo, results, list) (4.x); preview / send re-read (`broadcasts.ts:1042,1285`) (4.x); dashboard summary, composer, list, results (4.x) |
| `subzone` | validator (1.x); both forms (5.x) | `toUnitFlyer` drops it (1.x); `FlyerPage` neighborhood line (6.x); `ListingDetail` row (6.x); `similarUnits.ts:52-65` (WATCH: unchanged) |
| `washer_dryer` | validator (1.x); both forms (5.x) | `toUnitFlyer` (1.x); `FlyerPage` (6.x); `ListingDetail` (6.x) |

### 3.2 Watch items for every slice

- Playwright `getByLabel('X')` is a case-insensitive SUBSTRING match: new
  labels `No pets`, `Pets (details)`, `Pet fee`, `Deposit notes`,
  `Fixed amount`, `Application fee` / `No application fee`,
  `Evictions (details)`, `Tour type`, `Tour process` collide with existing
  selectors (`'Pets'`, `'Notes'`, `'Application fee'`, `'Deposit'`). S7
  sweeps every `getByLabel` in `e2e/` against the property and landlord
  forms; S5 checks testing-library `getByLabelText` (exact by default, but
  regex selectors such as `ListingEditForm.test.tsx:178-200` `/Application fee/i`
  match both).
- Tags never enter a field's accessible name (D10): the tag sits outside
  the `<label>` ELEMENT (the forms use wrapping labels,
  `ListingEditForm.tsx:464-472`), tied by `aria-describedby`.
- The registry and its dashboard mirror carry the SAME test cases (the
  `acceptedVoucherSizes` pattern).
- `primaryHandoffParity.integration.test.ts` and the other
  `restoreWithLandlord` suites must stay green; the harness repo's new
  behavior is pinned against the real repo where a parity suite exists.
