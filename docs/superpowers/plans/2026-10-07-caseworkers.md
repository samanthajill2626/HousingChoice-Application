# Implementation plan - caseworkers (branch B)

- Spec (the contract - read sections 2, 3 and 4 "Branch B" (D16-D22) in
  full, and every "(B)" line in D6, D10, 5.2, 6, 9, 10, 11 and 12, before
  Task 1.1): `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (revision 14). Branch A (the org list) is MERGED; its code is the base.
- Branch `feat/caseworkers`, worktree `W:\tmp\caseworkers`, cut from main
  @a8b66cd6, main merged in @c1530f9d. Mission records:
  `docs/superpowers/reviews/2026-10-07-caseworkers/`.
- Design review: 4 rounds, CLOSED (round 4 terminal) -
  `docs/superpowers/reviews/2026-10-07-caseworkers/design-review/adjudications.md`.
  Plan research rulings (BINDING):
  `docs/superpowers/reviews/2026-10-07-caseworkers/plan-research/planner-rulings.md`
  (rulings cited below as R1-F1, R2-F3, R4-12 ...; findings in
  `R1-findings.md` ... `R5-findings.md` beside it; code maps in this
  worktree's gitignored `.superpowers/sdd/plan-research/R<n>-reference.md`).
- Status: PLAN (planner) - plan review pending.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for the
  stated reason), implement, run it GREEN, commit. One commit per task unless
  the task says otherwise. A case marked (PIN) is a regression pin already
  green on unchanged code; every task still has at least one real RED case.
  An e2e task that covers behavior its slice already proved with unit tests
  may be PIN-only (its RED evidence is the pinned specs that fail on the new
  world before they are edited).
- Commits: `git status` first (a separate read), explicit paths only (never
  `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the
  authoring model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for edited files check the added lines of `git diff`.
- Never rewrite source with PowerShell `Get-Content | -replace |
  Set-Content`. Use the Edit tool. The Edit tool DECODES `\u` escapes -
  never type a `\u` escape through it.
- The Bash tool truncates a single command near 10 KB: write files with the
  Write tool, never with a long heredoc.
- Run commands with absolute paths (`cd "W:/tmp/caseworkers/app"` etc.); the
  shell's working directory resets between calls.
- Setup once: `cd "W:/tmp/caseworkers"; npm ci`. DynamoDB Local:
  `npm run db:start` (a START of a stopped container is fine). NEVER
  restart, stop or remove the shared DynamoDB Local container. If it
  misbehaves, stop and report.
- Unit runs while building: app `cd "W:/tmp/caseworkers/app"; npx vitest run
  test/<file>`; dashboard `cd "W:/tmp/caseworkers/dashboard"; npx vitest run
  src/<path>`; typecheck `cd "W:/tmp/caseworkers"; npm run typecheck`. Never
  pipe a gate command.
- e2e only through `npm run e2e` from the worktree root (or the lane session
  scripts). Never edit dashboard/app source while this worktree's e2e runs.
  Never touch Cameron's live ports (:5174/:8080).
- Line numbers in this plan are the branch base's source (`feat/caseworkers`
  @6ed28bb5, whose source equals main @6e25e58a). They DRIFT once an earlier
  task inserts lines. Every quoted anchor is unique text in its file - match
  the TEXT, never the number.
- A typed fake that mirrors a real repo changes in the SAME task as the repo
  (the "harness fake != real repo" trap): `app/test/helpers/twilioWebhookHarness.ts`
  (FakeWorld), `app/test/helpers/contactsPartitionFake.ts`, and any other
  fake the typecheck names.
- E2E rules (binding, planner rulings "E2E rules"): assert only rows a spec
  created with a run-unique stamp - never a count or an empty state on the
  Possible list or the Caseworkers tab; never convert or dismiss a seeded
  contact (Renee, Dario, Tasha, Marcus...); Tasha (open placement) and Marcus
  (landlord of record) may be used READ-ONLY as preview-refusal fixtures; the
  share e2e mints its own consented partner and never pre-opens its
  conversation; the household-phone case is unit/integration only.

## 1. Global constraints (from the spec)

| name | value |
|---|---|
| no new type | caseworker = `type: 'partner'` + a role satisfying `isCaseworkerRole`; no new `ContactType` |
| preset role | `CASEWORKER_ROLE = 'Caseworker'` (byte-exact), beside `PROPERTY_MANAGER_ROLE` |
| three matching tiers | canonicalizer: role EXACTLY `Caseworker`; tab: `isCaseworkerRole` (normalized role is `caseworker` or `case worker`); Possible list, datalist filter, relationship rows: "mentions" (normalized role contains `caseworker`, `case worker` or `case manager`) (D16, D22) |
| one conversion | the ONLY way an existing contact becomes a caseworker is `POST /api/contacts/:id/caseworker-review {action:'make'}`; the contacts PATCH refuses 409 `caseworker_use_conversion` (D16) |
| refusals | open placement, open tour as tenant, landlord of record (live and deleted units), roster seat (live and deleted units) - checked whatever the stored type (D19, D22) |
| commit write | one `contactsRepo.update`, conditional on: the raw `classification_revision` as read, `housingAuthority`, `agency`, `organization` as read, `attribute_not_exists(deleted_at)` (D19, D22) |
| organization | `contact.organization`, D5-checked against BOTH kinds; `''` REMOVEs; the conversion may carry existing not-on-the-list text (D17, D19) |
| server-owned | `caseworker_review`, `caseworker_conversion`, `type_source` - refused on contacts POST and PATCH (D21, D22) |
| threads | the generic type change keeps today's `unknown_1to1`-only flip; ONLY the conversion re-types, and only threads no other live contact shares (D21) |
| shares | seed and explicit recipients may be tenants or partners; filters and the recipient search stay tenant-only; both fan-out sites mint `conversationTypeFor(contact)` (D20) |
| infra | NO Terraform, NO new table, NO new index, NO script (section 11) |
| e2e world | NO seed change (R5-F18) |

## 2. Work map

Server first (S1-S6), a full typecheck + `npm test` checkpoint, then the
dashboard (S7-S9), then e2e, pins and docs (S10). Each slice lists its files;
plan section 3 is binding for every name that crosses a slice.

| slice | what | spec |
|---|---|---|
| S1 | matching helpers: `CASEWORKER_ROLE`, `isCaseworkerRole`, `mentionsCaseworker`, `hasAiCaseworkerNote`, `isCaseworker`; the canonicalizer accepts partner + `Caseworker`; `KINDS_FOR_FIELD.organization`; the dashboard mirror + mirror test | D16, D17, D22 |
| S2 | repo primitives and their fakes, with parity tests: multi-clause `expect`; `findAllByPhone` / `findAllByEmail`; `conversationsRepo.setTypeIfCurrent`; `getRecipientDisplaysByIds`; FakeWorld unit-list paging; `ContactItem` fields | D19, D21, R1-F3, R1-F15, R3-F4, R5-F17 |
| S3 | services: `caseworkerConversion.ts` (refusals, preview, make, dismiss, organization derivation and carry, thread plan, suggestion sweep, side effects) and `possibleCaseworkers.ts` | D19, D21, D22 |
| S4 | contacts routes and wiring: the caseworker-review routes and the possible-caseworkers read; PATCH 409 `caseworker_use_conversion` (merged-kind, consistent read); PATCH `organization` (D5, both kinds); server-owned refusals on POST and PATCH; `type_source` stamping on staff overrides; the importer's `type_source` guard; `unitsRepo` dep | D16, D17, D19, D21, D22 |
| S5 | organization across A's org-list server: field types, usage totals (`inUse`, `kindLocked`), `refuseWhileUsed` modes, rename/merge rewrite `organization`, the rewrite target kind, Not on the list organization rows, resolve `kind`, `/check` `kinds`, the dev seam | D10, D17, D22, R2 |
| S6 | shares server: seed and explicit resolution accept partners; both fan-out mint sites; recipients rows `type`/`role`; preview voucher facts tenant-only; landlord-timeline labels; results fallback | D20, D22, R3 |
| CP | checkpoint: `npm run typecheck`, `npm test` (every workspace) | - |
| S7 | dashboard org UI for both kinds: OrgPicker, NewOrgDialog organization mode, orgCopy, the Settings usage totals, Not on the list organization rows and the Settle dialog | D6, D10, D17, R2, R4-07 |
| S8 | dashboard contacts: the role mirror module, KindPicker, create/edit forms, UnknownFile, ContactDetail header and More actions, the conversion dialog, PartnerFile (role, organization, Staff notes), the Caseworkers page, nav and tabs, API client | D16-D19, D22, R4 |
| S9 | dashboard shares: PartnerFile Properties sent card + Send, neutral wording, the "Sent to" list labels | D20, D22, R3 |
| S10 | e2e specs and pins, perf/mutation pins, GLOSSARY, RUNBOOK, selectors.md, e2e README, issues | D18, D20, sections 11-12, R4-13, R5 |

## 3. Interfaces (BINDING for every slice)

### 3.1 New files

| file | slice | holds |
|---|---|---|
| `app/src/lib/caseworkers.ts` | S1 | the matching helpers (3.2) |
| `app/test/caseworkers.test.ts` | S1 | helper tables, incl. `prompt.ts:93`'s line verbatim |
| `app/src/services/caseworkerConversion.ts` | S3 | `createCaseworkerConversionService` (3.4) |
| `app/test/caseworkerConversion.test.ts` | S3 | service unit tests on the FakeWorld |
| `app/src/services/possibleCaseworkers.ts` | S3 | `listPossibleCaseworkers` (3.4) |
| `app/test/possibleCaseworkers.test.ts` | S3 | on `contactsPartitionFake` |
| `app/src/routes/caseworkerReview.ts` | S4 | `registerCaseworkerRoutes(router, deps)`, called by `createContactsRouter` BEFORE its `/:contactId` handlers |
| `app/test/caseworkerReviewApi.test.ts` | S4 | route tests through the harness |
| `app/test/caseworkerRepoParity.integration.test.ts` | S2 | real repo vs fake on DynamoDB Local (idiom: `orgRecordWriters.integration.test.ts`) |
| `dashboard/src/routes/contact/caseworkerRole.ts` | S1 | dashboard `CASEWORKER_ROLE`, `isCaseworkerRole`, `mentionsCaseworker` (imports only the D4 normalizer mirror) |
| `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts` | S1 | imports app source and pins equality (idiom: `mediaTypeMirror.test.ts`) |
| `dashboard/src/routes/contact/CaseworkerDialog.tsx` (+ `.test.tsx`, `.module.css`) | S8 | the conversion dialog |
| `dashboard/src/routes/contacts/CaseworkersList.tsx` (+ `.test.tsx`, `.module.css`) | S8 | the Caseworkers page and the Possible list |
| `dashboard/src/routes/contacts/FilterChips.tsx` (+ test) | S8 | `ChipGroup` / `Chip` factored out of `TenantFilters.tsx` |
| `e2e/tests/dashboard-next/caseworkers.spec.ts` | S10 | conversion, tab, Possible list |
| `e2e/tests/dashboard-next/partner-share.spec.ts` | S10 | a share to a partner |

### 3.2 Shared app types and helpers

`app/src/services/extraction/contactKinds.ts` gains
`export const CASEWORKER_ROLE = 'Caseworker';` beside
`PROPERTY_MANAGER_ROLE`, and `canonicalSuggestedContactKind` returns
`'partner'` for `type: 'partner'` with role EXACTLY `CASEWORKER_ROLE` (any
other non-empty partner role stays `undefined`).

`app/src/lib/caseworkers.ts` (pure; imports `normalizeOrgText` from
`lib/orgNames.ts` and `CASEWORKER_ROLE`):

```ts
export function isCaseworkerRole(role: unknown): boolean;
//   string, normalizeOrgText(role) === 'caseworker' || === 'case worker'
export function mentionsCaseworker(role: unknown): boolean;
//   string, normalizeOrgText(role) contains 'caseworker' | 'case worker' | 'case manager'
export function hasAiCaseworkerNote(notes: unknown): boolean;
//   some '\n'-split line matches /^\[Auto - [^\]]+\]\s*/ and the rest,
//   normalized, starts with 'identified as a caseworker' |
//   'identified as caseworker' | 'identified as a case worker' |
//   'identified as case worker'
export function isCaseworker(c: { type?: unknown; role?: unknown }): boolean;
//   c.type === 'partner' && isCaseworkerRole(c.role)
export type PossibleSignal = 'role_mentions' | 'ai_note' | 'relationship' | 'partner_no_role';
```

`lib/orgNames.ts`: `OrgField` gains `'organization'`;
`KINDS_FOR_FIELD.organization = ['housing_authority', 'agency']`.
`OrgRecordField` (services) gains `'organization'`.

`ContactItem` (`repos/contactsRepo.ts`) gains:

```ts
organization?: string;
caseworker_review?: 'dismissed';
caseworker_conversion?: CaseworkerConversionRecord;
type_source?: 'manual';

export interface CaseworkerConversionRecord {
  at: string;            // ISO
  by: string;            // actor email
  fromType: ContactType;
  fromRole?: string;
  housingAuthority?: string;  // the removed value, when there was one
  agency?: string;            // the cleared value, when non-empty
}
```

Conversion wire types (`app/src/services/caseworkerConversion.ts`, mirrored
field-for-field in `dashboard/src/api/types.ts`):

```ts
export type CaseworkerRefusal =
  | { code: 'caseworker_open_placement'; placementId: string }
  | { code: 'caseworker_open_tour'; tourId: string }
  | { code: 'caseworker_landlord_of_record'; unitId: string }
  | { code: 'caseworker_on_roster'; unitId: string };
// One entry per blocking record, ordered placement, tour, landlord, roster.

export type OrganizationSource = 'request' | 'stored' | 'list_match' | 'carried' | 'none';

export interface CaseworkerPreview {
  contactId: string;
  alreadyCaseworker: boolean;
  refusals: CaseworkerRefusal[];
  removes: { housingAuthority?: string; agency?: string; pendingSuggestions: number };
  threads: { retype: number; leftShared: number; leftOther: number };
  //   leftShared = another live contact holds the phone/address;
  //   leftOther = typed for another identity or type-less (R1-F15)
  organization: { value?: string; source: Exclude<OrganizationSource, 'request'> };
}

export interface PossibleCaseworkerRow {
  contactId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  type: 'tenant' | 'landlord' | 'partner';
  role?: string;
  signals: PossibleSignal[];   // non-empty, in PossibleSignal declaration order
}
```

### 3.3 Repo API (S2; every change lands with its fake and a parity test)

- `contactsRepo.update(id, patch, opts)`: `UpdateContactOptions.expect`
  widens to `ExpectClause | ExpectClause[]`, where
  `ExpectClause = { attr: string; value: string | number | null }`
  (`null` = `attribute_not_exists(attr)`), plus
  `notDeleted?: true` (adds `attribute_not_exists(deleted_at)`). Every clause
  is ANDed into the same ConditionExpression; the no-op path evaluates every
  clause; a mismatch throws `ConditionalCheckFailedException` as today. The
  single-object form keeps working unchanged (Staff notes guard).
- `contactsRepo.findAllByPhone(phone: string): Promise<ContactItem[]>` and
  `findAllByEmail(email: string): Promise<ContactItem[]>` - EVERY item the
  byPhone / byEmail index holds for the value, pointer rows resolved to their
  owning contact, de-duplicated by `contactId`, soft-deleted contacts
  EXCLUDED. `findByPhone` / `findByEmail` are unchanged.
- `contactsRepo.getRecipientDisplaysByIds(ids: string[]): Promise<Map<string,
  RecipientDisplay>>` with `RecipientDisplay = ContactDisplay & { type?:
  ContactType; role?: string }` - a SECOND projection for the units
  recipients route only (R3-F4); `getDisplaysByIds` is unchanged.
  `type` / `role` are reserved words (placeholders).
- `conversationsRepo.setTypeIfCurrent(conversationId: string, expected:
  ConversationType, next: ConversationType, displayName: string | null):
  Promise<'updated' | 'skipped'>` - one UpdateItem conditional on
  `#type = :expected`; a failed condition returns `'skipped'` (never throws
  to the caller); `displayName` null leaves the name untouched.
- FakeWorld `unitsRepo.list` pages (honors the cursor) instead of capping at
  50; the fake pointer rows keep their sentinel but S3/S4 tests must include
  a pointer-id case (R1-F1).

### 3.4 Services (S3)

```ts
// app/src/services/caseworkerConversion.ts
export class CaseworkerReviewError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, readonly code: string,
              readonly extras: Record<string, unknown> = {});
}
export interface CaseworkerConversionService {
  preview(contactId: string): Promise<CaseworkerPreview>;
  make(contactId: string, input: { organization?: string; actor: string }): Promise<ContactItem>;
  dismiss(contactId: string, actor: string): Promise<ContactItem>;
}
export function createCaseworkerConversionService(deps: CaseworkerConversionDeps): CaseworkerConversionService;
// deps: the repos and buses the contacts PATCH already uses for the same
// effects (contacts, conversations, placements, tours, units, extraction /
// suggestions, aiRuns, audit, activityEvents, vocabulary, events, orgNames,
// logger, clock). Every dep optional with the real default, the A
// `createOrgNamesService` idiom.
```

Rules the service implements (spec D19, D21, D22; R1):
1. Read the contact CONSISTENTLY. Missing, pointer row, non-ContactType type,
   or deleted -> 404 `contact_not_found`. `team_member` -> 400
   `caseworker_team_member`.
2. `make` on a contact where `isCaseworker` holds -> re-run steps 2-4 only
   (re-check deletion first), return the contact.
3. Refusals (all collected, 3.2 order): non-terminal placements for the
   contact; tours where it is the tenant in requested / scheduled / toured /
   no_show; `listByLandlord` live AND deleted; one unit Scan WITHOUT the
   deleted filter for roster seats. Any refusal -> 409 with
   `code` = the first refusal's code and `extras = { refusals }`.
4. Organization: request `organization` (non-empty: D5 against both kinds,
   422 `org_not_on_list` per A's shape; `''`: absent) > stored >
   derived: agency text when present (list match by `resolveOrgText` over
   both kinds -> that name, else carried) else housing authority text (same
   treatment); carried text must pass `hasOrgControlChar` false,
   `length <= ORG_NAME_MAX`, `normalizeOrgText(text) !== ''` - else not
   carried (R2-F7). Compound text is carried.
5. Step 1 commit: `contactsRepo.update` with SET type `partner`, role
   `CASEWORKER_ROLE`, status `active`, `type_source: 'manual'`,
   `organization` (or REMOVE), `agency: ''`, `caseworker_conversion`; REMOVE
   `housingAuthority`, `housingAuthority_source`; classification fence bump;
   `expect` = [raw `classification_revision` as read, `housingAuthority`,
   `agency`, `organization` as read] + `notDeleted`. Lost condition: consistent
   re-read; missing/deleted -> 404, else 409 `contact_changed`.
6. Step 2: the PATCH's revision-guarded type drain with
   `canonicalSuggestedContactKind(converted)`; then supersede every other
   pending suggestion with the PATCH's verdict stamps.
7. Step 3: for each open 1:1 thread from `conversationsForContact`
   (every phone and email): skip `partner_1to1`; leave (count `leftShared`)
   when `findAllByPhone` / `findAllByEmail` returns another live contact, or
   the participant `contactId` is set and is not this contact; leave (count
   `leftOther`) a type-less row; else `setTypeIfCurrent(id, readType,
   'partner_1to1', displayName)`.
8. Step 4, each once: `contact_updated` audit (payload names the conversion
   and carries `caseworker_conversion`); `contact_status_changed` milestone
   labelled by the NEW type when status changed (R1-F12);
   `suggestion.updated` / `conversation.updated` events; the role vocabulary
   write. Failures after step 1 are logged at error level, never thrown.
9. `preview` runs rules 1-4 and the step 3 classification READ-ONLY.
10. `dismiss`: rule 1; `isCaseworker` or `unknown` -> 400
    `caseworker_dismiss_not_allowed`; write `caseworker_review: 'dismissed'`
    with no revision bump; `contact_updated` audit
    (`fields: ['caseworker_review']`).

```ts
// app/src/services/possibleCaseworkers.ts
export function listPossibleCaseworkers(deps: { contacts: ContactsRepo }): Promise<PossibleCaseworkerRow[]>;
// One read each of the tenant, landlord and partner partitions; excludes
// deleted, dismissed and isCaseworker contacts; signals per D22; sorted by
// last name, first name, contactId.
```

### 3.5 Endpoints and errors (S4; bodies are `{ error: code, ...extras }`)

| method + path | who | success | errors |
|---|---|---|---|
| `GET /api/contacts/possible-caseworkers` | everyone | `{ rows: PossibleCaseworkerRow[] }` | - |
| `GET /api/contacts/:contactId/caseworker-review/preview` | everyone | `CaseworkerPreview` | 404 `contact_not_found`, 400 `caseworker_team_member` |
| `POST /api/contacts/:contactId/caseworker-review` `{ action: 'make', organization?: string }` | everyone | `{ contact }` | 400 `invalid_body`, 400 `caseworker_team_member`, 404 `contact_not_found`, 409 refusal code + `refusals`, 409 `contact_changed`, 422 `org_not_on_list` |
| `POST /api/contacts/:contactId/caseworker-review` `{ action: 'dismiss' }` | everyone | `{ contact }` | 400 `invalid_body` (also: any other key), 400 `caseworker_dismiss_not_allowed`, 404 `contact_not_found` |
| contacts PATCH | as today | as today | NEW 409 `caseworker_use_conversion` when the MERGED result (stored role when the body omits `role`; `''`/null = absent) satisfies `isCaseworker` and the stored contact does not; read consistently when `type` or `role` is in the body. NEW 422 `org_not_on_list` for `organization` (both kinds). NEW 400 for client-sent `caseworker_review`, `caseworker_conversion`, `type_source` (message "<field> is set by the server, not the client", the `consent_captured_by` mechanism) |
| contacts POST | as today | as today | NEW 400 for the same three keys (one helper both parsers call) |

PATCH `type_source`: SET `'manual'` when the stored type is tenant,
landlord or partner and the patched type differs (staff override); never on
triage of `unknown`. The generic PATCH thread flip is UNCHANGED.

Importer (`lib/import/apply.ts` `upsertContact`): a stored
`type_source === 'manual'` skips SET of `type`, `status`, `housingAuthority`,
`agency` (read-then-write race accepted, R1-F5).

### 3.6 Organization in the org-list server (S5)

- `OrgUsage[orgId]` becomes `{ tenants, otherContacts, properties,
  organization, deleted, inUse: { active, deleted }, kindLocked: { active,
  deleted } }` - the first five as today plus `organization` (display); the
  two totals count DISTINCT records (R2-F1). `refuseWhileUsed(mode:
  'delete' | 'kind')` reads `inUse` / `kindLocked`; the 409 `org_in_use`
  `uses` body reports the mode's total.
- `recordFieldsForKind`: housing authority -> `housingAuthority`,
  `accepted_authorities`, `organization`; agency -> `agency`,
  `organization` (`organization` always LAST). `rewriteTargetKind` reads the
  first non-organization field (R2-F2).
- Not on the list: `organization` rows (`field: 'organization'`), resolution
  over both kinds; resolve on them accepts `use` (both kinds), `add` (REQUIRES
  `kind`, else 400), `clear`; `move_to_agency`, `move_to_housing_authority`,
  `split` -> 400; `kind` on any other field or action -> 400 (R2-F6).
- `POST /api/organizations/check`: exactly one of `kind` / `kinds`; `kinds` a
  non-empty subset of the two kinds; else 400 (R2-F5).
- `lastRewrite.counts` gains an `organization` key.
- `POST /__dev/org-fixture` accepts `organization` (+ its test message, the e2e
  fixture types, README and selectors rows - R5-F13).

### 3.7 Shares (S6)

- `resolveSeeds` and the explicit-recipients loop accept `type` tenant OR
  partner (one predicate); filters and the composer search unchanged.
- `broadcastFanOut.ts` send pass and `adoptBroadcastRecipient` mint with
  `conversationTypeFor(contact)`.
- `GET /api/units/:unitId/recipients` rows gain OPTIONAL `type` and `role`
  (via `getRecipientDisplaysByIds`); omitted when the contact does not
  resolve; `listings-sent` (contact side) unchanged; the shared-row pin at
  `listingSendsApi.test.ts:146-163` amended.
- Preview candidates carry `voucherSize` / `housingAuthority` only when the
  contact's type is `tenant`.
- Landlord timeline: both label sites read "Sent to N recipient(s)" and "No
  recipients reached"; the `startsWith('Sent to ')` relabel predicate keeps
  working. Persisted keys (`tenantCount`, `tenantName`) unchanged.

### 3.8 Dashboard API (S8 unless noted)

`dashboard/src/api/endpoints.ts` gains `listPossibleCaseworkers()`,
`previewCaseworker(contactId)` (GET), `makeCaseworker(contactId, body: {
organization?: string })`, `dismissPossibleCaseworker(contactId)`;
`checkOrgText` gains `kinds` (S7). `dashboard/src/api/types.ts` mirrors 3.2's
wire types, `OrgUsage`'s new fields (S7), recipient rows' `type?`/`role?`
(S9) and `ContactItem`'s new fields. The mutation catalog
(`e2e/performance/mutationCatalog.ts` and its count pin, 118 today) gains
TWO entries (`makeCaseworker`, `dismissPossibleCaseworker`) - S10.

### 3.9 Copy and accessible names (BINDING - unit tests and e2e use these)

| surface | text / accessible name |
|---|---|
| nav sub-link under Contacts (order Tenants, Landlords, Caseworkers, Unknown) | link "Caseworkers" -> `/contacts/caseworkers`; partner dot |
| Contacts "Filter contacts" tabs | tab "Caseworkers" |
| Caseworkers page | heading "Caseworkers"; chips group "Organization" (URL param `org`); rows show name, organization, phone; empty text "No caseworkers yet." |
| Possible list | heading "Possible caseworkers"; per row buttons "Make caseworker" (aria-label "Make <name> a caseworker") and "Not a caseworker" (aria-label "<name> is not a caseworker"); signal labels: role_mentions "Role mentions caseworker", ai_note "AI noted caseworker", relationship "Linked as a caseworker", partner_no_role "Partner with no role" |
| dismiss confirm | "Hide <name> from Possible caseworkers? This can't be undone in the app."; buttons "Hide", "Cancel" |
| KindPicker | segment "Caseworker" (order Tenant, Landlord, Partner, Caseworker, Property Manager, Other); shown on a new contact or one already a caseworker |
| Unknown card | button "Mark as Caseworker" (4th: Tenant, Landlord, Partner, Caseworker, Property Manager) - opens the dialog |
| contact header More actions | menuitem "Make caseworker" (tenant, landlord, partner; live; not already a caseworker) |
| conversion dialog | dialog name "Make <name> a caseworker"; buttons "Make caseworker" (disabled while a refusal shows) and "Cancel"; picker label "Organization"; "This removes" list: "Housing authority: <x>", "Agency: <x>", "<n> pending AI suggestion(s)"; "Past tours, closed placements, properties sent and other details stay on the record."; "<n> conversation(s) will become partner conversations."; "<n> shared conversation(s) stay as they are." |
| refusal sentences (links in parentheses) | open placement: "Finish or close this contact's placement first." ("View placement"); open tour: "Cancel or close this contact's open tour first." ("View tour"); landlord of record: "This contact is the landlord of record for a property. Change that property's landlord first." ("View property"); roster: "This contact is on a property's contact list. Remove them from it first." ("View property") |
| other errors | `contact_changed`: "This contact changed while this was open. Review and try again." (reloads the preview); `caseworker_use_conversion` (edit form): "To make this contact a caseworker, use More actions > Make caseworker." |
| partner header facts | the organization, when set |
| PartnerFile | Staff notes card (as TenantFile); Properties sent card (no tour chips); its Send action aria-label "Send a property to this partner" |
| org pickers, both kinds | add option "Add <text> as a new organization"; load error "Couldn't load organizations"; noun "organization"; NewOrgDialog intro "Check that this organization is really new"; kind radio "Housing authority" / "Agency", no default, add disabled until chosen; `FIELD_LABEL.organization` "Organization" |
| share wording (S9) | per spec D22 "Share wording" - every string there, verbatim |

## Slices

The slices below are the builder's task list, in the work-map order.
