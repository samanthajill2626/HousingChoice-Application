# Implementation plan - caseworkers (branch B)

- Spec (the contract - read sections 2, 3 and 4 "Branch B" (D16-D22) in
  full, and every "(B)" line in D6, D10, 5.2, 6, 9, 10, 11 and 12, before
  Task 1.1): `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (revision 15). Branch A (the org list) is MERGED; its code is the base.
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
- Status: PLAN (planner) - assembled from six section drafts; contract
  rulings in `docs/superpowers/reviews/2026-10-07-caseworkers/plan-research/plan-assembly-rulings.md`
  (folded into section 3; plan review round 1 applied, round 2 pending).
  Cited as "assembly ruling <writer>-<n>": `S1/S2-3`
  is item 3 under "S1/S2 writer" in that file, `S8-4` item 4 under "S8
  writer"; the S10 writer's items are cited by their subject ("S10 row
  lists", "S10 dismiss confirm container"). The section drafts themselves
  are gitignored and are NEVER the authority.
- Plan review round 1: rulings in
  `docs/superpowers/reviews/2026-10-07-caseworkers/plan-review/adjudications.md`
  (cited as "plan review R1 ruling A2", "... B10" ...), applied to this text.

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
- Glyph placeholders in "Current" anchors (plan review R1 ruling B3). This
  plan is ASCII, so where a quoted CURRENT line of a file holds a non-ASCII
  character the plan writes a placeholder instead:
  `{--}` = U+2014 em dash; `{->}` = U+2192 rightwards arrow; `{...h}` =
  U+22EF midline horizontal ellipsis; `{"}` = U+201C or U+201D curly
  double quote (left or right, as the file has it). The placeholder text
  does NOT exist in the file - an Edit whose old_string contains one fails.
  Procedure: Read the real line (the Read tool shows the true character),
  copy the line's exact text as the old_string (the character pasted from
  the Read output, never typed as a `\u` escape and never via PowerShell),
  and write the REPLACEMENT in ASCII (the "with" block, which is already
  ASCII). If the Edit tool still cannot match, take a unique ASCII
  substring of the line as the old_string and replace the whole line
  around it. Never "fix" a placeholder by retyping the glyph from memory.
- e2e pins move with their copy (plan review R1 ruling A3): a task that
  changes user-facing copy an e2e spec asserts edits that spec line in the
  SAME task (the S6.5 timeline task and the S9 tasks list their pins), so
  `npm run e2e` is not knowingly red between tasks. S10 Task 10.4 only
  verifies them (skip-if-done). A task that edits an e2e spec does not have
  to run the e2e suite itself; Task 10.13 and the final gates task run it.
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
dashboard (S7-S9), a second typecheck + `npm test` checkpoint, then e2e,
pins and docs (S10), ending with the main sync and the five AGENTS.md
completion gates (Task 10.14). Each slice lists its files;
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
| CP2 | checkpoint after S9: `npm run typecheck`, `npm test` (every workspace) - plan review R1 ruling B10 | - |
| S10 | e2e specs and pins, perf/mutation pins, GLOSSARY, RUNBOOK, selectors.md, e2e README, issues; the final task (10.14) syncs main and runs the five completion gates bare | D18, D20, sections 11-12, R4-13, R5 |

## 3. Interfaces (BINDING for every slice)

### 3.1 New files

| file | slice | holds |
|---|---|---|
| `app/src/lib/caseworkers.ts` | S1 | the matching helpers (3.2) |
| `app/test/caseworkers.test.ts` | S1 | helper tables, incl. `prompt.ts:93`'s line verbatim |
| `app/src/services/contactClassification.ts` (+ `app/test/contactClassification.test.ts`) | S3 | `displayNameOf`, `supersedePendingSuggestion`, `drainTypeSuggestion` - extracted from the contacts PATCH; the PATCH and the conversion both call them |
| `app/src/services/caseworkerConversion.ts` | S3 | `createCaseworkerConversionService` (3.4) |
| `app/test/caseworkerConversion.test.ts` | S3 | service unit tests on the FakeWorld |
| `app/src/services/possibleCaseworkers.ts` | S3 | `listPossibleCaseworkers` (3.4) |
| `app/test/possibleCaseworkers.test.ts` | S3 | on `contactsPartitionFake` |
| `app/src/routes/caseworkerReview.ts` | S4 | `registerCaseworkerRoutes(router, deps)`, called by `createContactsRouter` BEFORE its `/:contactId` handlers |
| `app/test/caseworkerReviewApi.test.ts` | S4 | route tests through the harness |
| `app/test/caseworkerRepoParity.integration.test.ts` | S2 | real repo vs fake on DynamoDB Local (idiom: `orgRecordWriters.integration.test.ts`) |
| `dashboard/src/routes/contact/caseworkerRole.ts` | S1 (+ S8) | dashboard `CASEWORKER_ROLE`, `isCaseworkerRole`, `mentionsCaseworker` (imports only the D4 normalizer mirror); S8 Task 8.3 adds `isCaseworkerContact(contact)` here |
| `dashboard/src/routes/orgs/OrgKindChoice.tsx` (+ test) | S7 | the required kind radio group "Kind" (no default) |
| `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts` | S1 | imports app source and pins equality (idiom: `mediaTypeMirror.test.ts`) |
| `dashboard/src/routes/contact/CaseworkerDialog.tsx` (+ `.test.tsx`, `.module.css`) | S8 | the conversion dialog |
| `dashboard/src/routes/contacts/CaseworkersList.tsx` (+ `.test.tsx`, `.module.css`) | S8 | the Caseworkers page and the Possible list |
| `dashboard/src/routes/contacts/FilterChips.tsx` (+ test) | S8 | `ChipGroup` / `Chip` factored out of `TenantFilters.tsx` |
| `e2e/tests/dashboard-next/caseworkers.spec.ts` | S10 | conversion, tab, Possible list |
| `e2e/tests/dashboard-next/partner-share.spec.ts` | S10 | a share to a partner |

### 3.2 Shared app types and helpers

`CASEWORKER_ROLE = 'Caseworker'` is DEFINED in the leaf
`app/src/lib/caseworkers.ts` (`export const CASEWORKER_ROLE = 'Caseworker';`).
`app/src/services/extraction/contactKinds.ts` imports it from there and
re-exports it beside `PROPERTY_MANAGER_ROLE` (`export { CASEWORKER_ROLE };`),
so both import paths name ONE constant; `canonicalSuggestedContactKind`
returns `'partner'` for `type: 'partner'` with role EXACTLY
`CASEWORKER_ROLE` (any other non-empty partner role stays `undefined`). The
direction matters (plan review R1 ruling A2): `contactKinds.ts` type-imports
the extraction adapter and `contactsRepo.ts` (the AWS SDK, the Anthropic SDK,
`lib/config.ts`), so a module that imported the constant FROM
`contactKinds.ts` would drag that graph into the dashboard typecheck through
the S1 mirror test. `lib/caseworkers.ts` imports nothing but
`lib/orgNames.ts` (itself import-free).

`app/src/lib/caseworkers.ts` (pure; imports only `normalizeOrgText` from
`lib/orgNames.ts`; defines `CASEWORKER_ROLE`):

```ts
export const CASEWORKER_ROLE = 'Caseworker';
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
`KINDS_FOR_FIELD.organization = ['housing_authority', 'agency']` (S1).
`OrgRecordField` (`repos/orgListRepo.ts`, with its dashboard and e2e
mirrors) gains `'organization'` in S5, not S1 (widening it earlier breaks
`FIELD_ORDER`).

`ContactItem` (`repos/contactsRepo.ts`) gains:

```ts
organization?: string;
caseworker_review?: 'dismissed';
caseworker_conversion?: CaseworkerConversionRecord;
type_source?: 'manual';

export interface CaseworkerConversionRecord {
  at: string;            // ISO
  by: string;            // the actor's userId (as audit rows record actors)
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
// One entry per blocking record, ordered placement, tour, landlord, roster;
// ids sorted within each kind; ONE refusal per unit - landlord-of-record wins
// over a roster seat on the same unit.

export type OrganizationSource = 'request' | 'stored' | 'list_match' | 'carried' | 'none';

export interface CaseworkerPreview {
  contactId: string;
  alreadyCaseworker: boolean;
  refusals: CaseworkerRefusal[];
  removes: { housingAuthority?: string; agency?: string; pendingSuggestions: number };
  threads: { retype: number; leftShared: number; leftOther: number };
  //   leftShared = another live contact holds the phone/address, OR the
  //     participant contactId is set and is not this contact;
  //   leftOther = type-less rows only (R1-F15)
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
  RecipientDisplay>>` with `RecipientDisplay = ContactDisplayItem & { type?:
  ContactType; role?: string }` (exported) - a SECOND projection for the units
  recipients route only (R3-F4); `getDisplaysByIds` is unchanged.
  `type` / `role` are reserved words (placeholders).
- `conversationsRepo.setTypeIfCurrent(conversationId: string, expected:
  ConversationType, next: ConversationType, displayName: string | null):
  Promise<SetTypeIfCurrentResult>` with `SetTypeIfCurrentResult = {
  outcome: 'updated'; conversation: ConversationItem } | { outcome:
  'skipped' }` - one UpdateItem conditional on `#type = :expected`; a failed
  condition returns `{ outcome: 'skipped' }` (never throws to the caller);
  the `conversation.updated` event is built from the returned row; `displayName` null leaves the name untouched.
- `ListUnitsOpts.deleted` gains `'any'` (no deleted filter) in `queryIndex`,
  `list` and the fake; the refusals read with `deleted: 'any'`.
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
export function listPossibleCaseworkers(deps: { contacts: Pick<ContactsRepo, 'listByType'> }): Promise<PossibleCaseworkerRow[]>;
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
  deleted } }` (types `OrgUsageCounts`, `OrgUseTotal`) - the first five as
  today plus `organization` (display; a deleted organization holder counts
  in `deleted` once per column - that per-column `deleted` stays on the wire
  for compatibility ONLY: the dashboard shows the distinct `inUse.deleted`
  for "+N deleted" and in the Delete sentence, plan review R1 ruling A10);
  the two totals count DISTINCT records (R2-F1) and every refusal reads them. `refuseWhileUsed(mode:
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
  fixture types, README and selectors rows - R5-F13). S5 owns these and the
  e2e usage pin `org-lists.spec.ts:557-562` (the task that changes a wire
  changes its pins); S10 Task 10.3 skips what is done.

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
- Landlord timeline: the stored-count site (`contactTimeline.ts:762-764`)
  reads "Sent to N recipient(s)" for EVERY N including 0; only the recount
  site (`:695-697`) says "No recipients reached" - so the
  `startsWith('Sent to ')` relabel predicate still finds every share row.
  Pins: also `contactsBatchReads.test.ts:141-169` (Task 6.4). Persisted keys (`tenantCount`, `tenantName`) unchanged.

### 3.8 Dashboard API (S8 unless noted)

`dashboard/src/api/endpoints.ts` gains `listPossibleCaseworkers()`,
`previewCaseworker(contactId)` (GET), `makeCaseworker(contactId, body: {
organization?: string })`, `dismissPossibleCaseworker(contactId)`;
`checkOrgText` gains `kinds` (S7). `dashboard/src/api/types.ts` mirrors 3.2's
wire types, `OrgUsage`'s new fields (S7), recipient rows' `type?`/`role?`
(S9) and `ContactItem`'s new fields. The mutation catalog
(`e2e/performance/mutationCatalog.ts` and its count pin, 118 today) gains
TWO entries (`makeCaseworker`, `dismissPossibleCaseworker`) - S8 Task 8.1,
in the same task as the endpoints (assembly ruling S8-2); S10 Task 10.1
only verifies it.

### 3.9 Copy and accessible names (BINDING - unit tests and e2e use these)

| surface | text / accessible name |
|---|---|
| nav sub-link under Contacts (order Tenants, Landlords, Caseworkers, Unknown) | link "Caseworkers" -> `/contacts/caseworkers`; partner dot |
| Contacts "Filter contacts" nav | link "Caseworkers" (these controls are links in `nav aria-label="Filter contacts"`, not tabs) |
| Caseworkers page | heading "Caseworkers"; chips group "Organization" (URL param `org`); rows in `<ul aria-label="Caseworkers">`, one `<li>` per row, showing name, organization, phone; empty text "No caseworkers yet." |
| Possible list | heading "Possible caseworkers"; rows in `<ul aria-label="Possible caseworkers">`, one `<li>` per row (locators use `exact: true` - "Caseworkers" is a substring); per row buttons "Make caseworker" (aria-label "Make <name> a caseworker") and "Not a caseworker" (aria-label "<name> is not a caseworker"); signal labels: role_mentions "Role mentions caseworker", ai_note "AI noted caseworker", relationship "Linked as a caseworker", partner_no_role "Partner with no role" |
| dismiss confirm | a Modal named by its first sentence: "Hide <name> from Possible caseworkers? This can't be undone in the app."; buttons "Hide", "Cancel" |
| KindPicker | segment "Caseworker" (order Tenant, Landlord, Partner, Caseworker, Property Manager, Other); shown on a new contact or one already a caseworker |
| Unknown card | button "Mark as Caseworker" (4th: Tenant, Landlord, Partner, Caseworker, Property Manager) - opens the dialog |
| contact header More actions | menuitem "Make caseworker" (tenant, landlord, partner; live; not already a caseworker) |
| conversion dialog | dialog name "Make <name> a caseworker"; buttons "Make caseworker" (disabled while a refusal shows) and "Cancel"; picker label "Organization"; "This removes" list: "Housing authority: <x>", "Agency: <x>", "<n> pending AI suggestion(s)"; "Past tours, closed placements, properties sent and other details stay on the record."; "1 conversation will become a partner conversation." / "<n> conversations will become partner conversations."; "1 shared conversation stays as it is." / "<n> shared conversations stay as they are."; "1 conversation without a type stays as it is." / "<n> conversations without a type stay as they are." (each line only when its count > 0); when the preview says `alreadyCaseworker`, NO Organization picker and the line "This contact is already a caseworker. Confirming re-runs the cleanup." (plan review R1 ruling B8) |
| refusal sentences (links in parentheses) | open placement: "Finish or close this contact's placement first." ("View placement"); open tour: "Cancel or close this contact's open tour first." ("View tour"); landlord of record: "This contact is the landlord of record for a property. Change that property's landlord first." ("View property"); roster: "This contact is on a property's contact list. Remove them from it first." ("View property") |
| other errors | `contact_changed`: "This contact changed while this was open. Review and try again." (reloads the preview); `caseworker_use_conversion` (edit form): "To make this contact a caseworker, use More actions > Make caseworker." |
| partner header facts | the organization, when set |
| PartnerFile | Staff notes card (as TenantFile); Properties sent card (no tour chips); its Send action aria-label "Send a property to this partner" |
| org pickers, both kinds | add option "Add <text> as a new organization"; load error "Couldn't load organizations"; noun "organization" (organization refusals never name a kind); NewOrgDialog intro exactly "Check that this organization is really new."; radio group "Kind" with "Housing authority" / "Agency", no default, add disabled until chosen; `FIELD_LABEL.organization` "Organization"; the Settings Used by cell adds "1 organization field" / "<n> organization fields" only when > 0 |
| composer Send button | "Send to 1 recipient" / "Send to <n> recipients" |
| unresolved-seed note | "1 added recipient can't receive texts (unknown, opted out, or unreachable) and was left out." / "<n> added recipients can't receive texts (unknown, opted out, or unreachable) and were left out." |
| `empty_audience` 400 | "Nothing selected - check at least one recipient to send." (the em dash becomes " - ": a touched line is ASCII) |
| select-all note | "Flagged recipients you picked stay checked; "Select all" skips the others." |
| compose reach line | "Reaches 1 recipient" / "Reaches <n> recipients" |
| Matching list row and results header (`sendReachLabel`) | "To 1 recipient" / "To <n> recipients" |
| Matching list subtitle | "Share a property with a curated set of recipients." |
| Matching empty state | Start one from a property's "Send this property", from a contact's "Properties sent", or with "Send a property". (curly quotes via entities, as today) |
| results fallback name | "Recipient" |
| property kebab menuitem; card action aria-label | "Send this property" |
| property card title | "Sent to" (the heading's accessible name also carries the aside label: match `/^Sent to\b/`) |
| property Activity share row | "Sent to 1 recipient" / "Sent to <n> recipients"; zero "No recipients reached" |
| landlord timeline | "Sent to 1 recipient" / "Sent to <n> recipients" at both sites; "No recipients reached" at the recount site only (3.7) |
| "Sent to" row label | resolved non-tenant row: `displayKind` (role, else the type label, e.g. "Partner"); tenant and unresolved rows: none |
| UNCHANGED on purpose | "Add more tenants by filters", "Add a tenant", "No candidates - add a tenant below." (as today), the filter summary "Tenants - ...", TenantFile's "Send a property to this tenant", "Couldn't add that tenant - try the search again." (as today) |

## Slices

The slices below are the builder's task list, in the work-map order.

## S1 - the caseworker matching rules (`app/src/services/extraction/contactKinds.ts`, `app/src/lib/caseworkers.ts` (new), `app/src/lib/orgNames.ts`, `dashboard/src/routes/contact/caseworkerRole.ts` (new); tests `app/test/contactKinds.test.ts`, `app/test/caseworkers.test.ts` (new), `app/test/orgNames.test.ts`, `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts` (new))

Spec D16, D17, D22 "Matching"; planner rulings R1-F8, R1-F14, R4-15, R4-16,
R5-F6. S1 is pure: no I/O, no route, no repo. Every later slice imports
these names (plan 3.2); do not rename them.

### Task 1.1 - `CASEWORKER_ROLE` and the canonicalizer accepts partner + `Caseworker` (D16)

Files: `app/src/lib/caseworkers.ts` (new - the constant only; Task 1.2
adds the helpers), `app/src/services/extraction/contactKinds.ts`,
`app/test/contactKinds.test.ts`.

Where the constant lives (plan 3.2, plan review R1 ruling A2): DEFINED in
the leaf `app/src/lib/caseworkers.ts`; `contactKinds.ts` imports and
re-exports it. Never the other way round.

RED: edit `app/test/contactKinds.test.ts`.

1. The import - replace

```ts
import {
  PROPERTY_MANAGER_ROLE,
  canonicalSuggestedContactKind,
} from '../src/services/extraction/contactKinds.js';
```

with

```ts
import {
  CASEWORKER_ROLE,
  PROPERTY_MANAGER_ROLE,
  canonicalSuggestedContactKind,
} from '../src/services/extraction/contactKinds.js';
```

2. After the Property Manager byte-exact case - replace

```ts
  it('keeps the Property Manager preset byte-exact', () => {
    expect(PROPERTY_MANAGER_ROLE).toBe('Property Manager');
  });
```

with

```ts
  it('keeps the Property Manager preset byte-exact', () => {
    expect(PROPERTY_MANAGER_ROLE).toBe('Property Manager');
  });

  it('keeps the Caseworker preset byte-exact (spec 2026-10-06 D16)', () => {
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });
```

3. The mapped table - replace

```ts
    [{ type: 'landlord', role: 'Property Manager' }, 'property_manager'],
    [{ type: 'tenant' }, 'tenant'],
  ] as const)('maps %o to %s', (contact, expected) => {
```

with

```ts
    [{ type: 'landlord', role: 'Property Manager' }, 'property_manager'],
    // D16: a caseworker is still the partner KIND, so the conversion's type
    // drain records an AI `partner` suggestion as accepted.
    [{ type: 'partner', role: 'Caseworker' }, 'partner'],
    [{ type: 'tenant' }, 'tenant'],
  ] as const)('maps %o to %s', (contact, expected) => {
```

4. The unsupported table - replace

```ts
    { type: 'partner', role: 'Inspector' },
```

with

```ts
    { type: 'partner', role: 'Inspector' },
    // Byte-exact, as the Property Manager preset is (D16): the looser
    // isCaseworkerRole / mentions tiers never reach the canonicalizer.
    { type: 'partner', role: 'caseworker' },
    { type: 'partner', role: 'CASEWORKER' },
    { type: 'partner', role: ' Caseworker' },
    { type: 'partner', role: 'Caseworker ' },
    { type: 'partner', role: 'Case worker' },
    { type: 'partner', role: 'Case Manager' },
    { type: 'tenant', role: 'Caseworker' },
    { type: 'landlord', role: 'Caseworker' },
    { type: 'unknown', role: 'Caseworker' },
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactKinds.test.ts`
- RED: "keeps the Caseworker preset byte-exact" fails (`CASEWORKER_ROLE` is
  undefined - not exported), and "maps { type: 'partner', role:
  'Caseworker' } to partner" fails (the canonicalizer answers undefined for
  any non-empty partner role). The new unsupported rows are PINs (green).

GREEN:

1. Create `app/src/lib/caseworkers.ts` (Write tool; Task 1.2 replaces it
   with the full module, keeping this constant and its comment):

```ts
// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2). PURE - no I/O. Task 1.2 adds the helpers.

/**
 * The caseworker preset role (spec 2026-10-06 D16), byte-exact like
 * PROPERTY_MANAGER_ROLE. A caseworker is `type: 'partner'` with a role that
 * satisfies isCaseworkerRole; this exact text is the role the KindPicker
 * preset and the caseworker conversion write. DEFINED here, in a leaf
 * module, and re-exported by services/extraction/contactKinds.ts (never the
 * reverse: contactKinds.ts type-imports the AWS and Anthropic graph, and the
 * dashboard mirror test imports THIS file). The dashboard copy lives in
 * dashboard/src/routes/contact/caseworkerRole.ts (caseworkerRoleMirror.test.ts
 * pins the two together).
 */
export const CASEWORKER_ROLE = 'Caseworker';
```

2. Edit `app/src/services/extraction/contactKinds.ts` - replace

```ts
import type { ContactItem } from '../../repos/contactsRepo.js';

export const PROPERTY_MANAGER_ROLE = 'Property Manager';
```

with

```ts
import type { ContactItem } from '../../repos/contactsRepo.js';
import { CASEWORKER_ROLE } from '../../lib/caseworkers.js';

export const PROPERTY_MANAGER_ROLE = 'Property Manager';

// The caseworker preset (spec 2026-10-06 D16) is DEFINED in the leaf
// lib/caseworkers.ts and re-exported here, so both import paths name one
// constant (plan 3.2).
export { CASEWORKER_ROLE };
```

3. In the same file, replace

```ts
  if (contact.type === 'landlord' && role === PROPERTY_MANAGER_ROLE) {
    return 'property_manager';
  }
  if (role !== '') return undefined;
```

with

```ts
  if (contact.type === 'landlord' && role === PROPERTY_MANAGER_ROLE) {
    return 'property_manager';
  }
  // D16: the caseworker preset is still the partner KIND - byte-exact, as the
  // Property Manager preset is - so accepting an AI `partner` suggestion
  // through the caseworker conversion records `accepted`. Any other
  // non-empty partner role stays unsupported.
  if (contact.type === 'partner' && role === CASEWORKER_ROLE) {
    return 'partner';
  }
  if (role !== '') return undefined;
```

Run the suite - GREEN. Regression (the PATCH type drain is the only server
caller of the canonicalizer, `app/src/routes/contacts.ts:1719`):
`cd "W:/tmp/caseworkers/app"; npx vitest run test/contactKinds.test.ts test/aiRunVerdicts.test.ts test/contactTriage.test.ts`
- GREEN, unchanged.

Commit: `git -C "W:/tmp/caseworkers" status` (read it; no `.git/MERGE_HEAD`),
then stage `app/src/lib/caseworkers.ts`,
`app/src/services/extraction/contactKinds.ts` and
`app/test/contactKinds.test.ts`;
message `feat(caseworkers): CASEWORKER_ROLE preset; the kind canonicalizer maps partner + Caseworker to partner (D16)`
with the `Co-Authored-By:` trailer.

### Task 1.2 - `app/src/lib/caseworkers.ts`: `isCaseworkerRole`, `mentionsCaseworker`, `hasAiCaseworkerNote`, `isCaseworker`, `PossibleSignal` (D16, D22)

Files: `app/src/lib/caseworkers.ts` (created by Task 1.1 with the constant
only; this task replaces it with the full module), `app/test/caseworkers.test.ts`
(new).

The three matching tiers (plan 3.2, spec D22 "Matching"): the
canonicalizer (Task 1.1, byte-exact); `isCaseworkerRole` (the tab: the D4
form is exactly `caseworker` or `case worker`); `mentionsCaseworker` (the
Possible list, the relationship signal and the KindPicker datalist filter:
the D4 form CONTAINS `caseworker`, `case worker` or `case manager`). The
AI-note signal needs the extraction prefix (`[Auto - <Mon> <D>]`, written
by `autoPrefix` in `app/src/services/extraction/apply.ts`); a line without
it never counts (R1-F8).

RED: create `app/test/caseworkers.test.ts`:

```ts
// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2; planner ruling R1-F8). Three tiers: the
// kind canonicalizer is byte-exact (contactKinds.test.ts); the Caseworkers
// tab uses isCaseworkerRole (the D4 form IS "caseworker" or "case worker");
// the Possible list, the relationship signal and the KindPicker datalist use
// mentionsCaseworker (the D4 form CONTAINS "caseworker", "case worker" or
// "case manager"). The AI-note signal reads only a line carrying the
// extraction's own "[Auto - <date>]" prefix.
import { describe, expect, it } from 'vitest';
import {
  CASEWORKER_ROLE,
  hasAiCaseworkerNote,
  isCaseworker,
  isCaseworkerRole,
  mentionsCaseworker,
  type PossibleSignal,
} from '../src/lib/caseworkers.js';
import { CASEWORKER_ROLE as KINDS_CASEWORKER_ROLE } from '../src/services/extraction/contactKinds.js';
import { buildExtractionSystemPrompt } from '../src/services/extraction/prompt.js';

/** A Unicode hyphen built at run time, so this file stays ASCII (U+2010). */
const UNICODE_HYPHEN = String.fromCharCode(0x2010);

/**
 * The AI's own line, read VERBATIM from the extraction prompt's Partner
 * example (services/extraction/prompt.ts, the "I am her caseworker at Hope
 * Atlanta" line) - so a prompt edit that changes the taught wording fails
 * here instead of silently emptying the AI-note signal.
 */
const PROMPT_NOTE = /add "(Identified as a caseworker[^"]*)"/.exec(buildExtractionSystemPrompt())?.[1];

describe('the caseworker preset', () => {
  it('is defined here and re-exported by contactKinds (one constant, D16)', () => {
    expect(CASEWORKER_ROLE).toBe(KINDS_CASEWORKER_ROLE);
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });
  it('satisfies the tab rule and the mentions rule', () => {
    expect(isCaseworkerRole(CASEWORKER_ROLE)).toBe(true);
    expect(mentionsCaseworker(CASEWORKER_ROLE)).toBe(true);
  });
});

describe('isCaseworkerRole (the Caseworkers tab, D16)', () => {
  it.each([
    'Caseworker',
    'caseworker',
    '  CASEWORKER  ',
    'Case worker',
    'case-worker',
    'Case  Worker.',
    'Case_Worker',
    `Case${UNICODE_HYPHEN}worker`,
  ])('accepts %o', (role) => {
    expect(isCaseworkerRole(role)).toBe(true);
  });
  it.each([
    'Caseworkers',
    'Senior Caseworker',
    'Caseworker - DFCS',
    'Case worker 2',
    'Case Manager',
    'Case wor ker',
    'Property Manager',
    '',
    '   ',
    undefined,
    null,
    7,
  ])('refuses %o', (role) => {
    expect(isCaseworkerRole(role)).toBe(false);
  });
});

describe('mentionsCaseworker (the Possible list and the datalist filter, D22)', () => {
  it.each([
    'Caseworker',
    'Caseworkers',
    'Senior Caseworker',
    'Caseworker - DFCS',
    'Case worker 2',
    'Case-Worker',
    'Case Manager',
    'case-manager',
    'Housing Case Manager',
    'CASE  MANAGER',
  ])('accepts %o', (role) => {
    expect(mentionsCaseworker(role)).toBe(true);
  });
  it.each([
    'Case Mgr',
    'Case management',
    'Casework',
    'Social worker',
    'Property Manager',
    'Manager of cases',
    '',
    undefined,
    null,
    3,
  ])('refuses %o', (role) => {
    expect(mentionsCaseworker(role)).toBe(false);
  });
});

describe('hasAiCaseworkerNote (the AI-note signal, D22)', () => {
  it('reads the prompt line verbatim (prompt.ts Partner example)', () => {
    expect(PROMPT_NOTE).toBe('Identified as a caseworker at Hope Atlanta');
    expect(hasAiCaseworkerNote(`[Auto - Oct 7] ${PROMPT_NOTE}`)).toBe(true);
  });
  it.each([
    'Prefers texts\n[Auto - Jul 16] Identified as caseworker for DFCS',
    '[Auto - Jan 2] identified as a case worker at Step Up',
    '[Auto - Jan 2] IDENTIFIED AS CASE WORKER',
    '[Auto - Jan 2]Identified as a caseworker',
    'Line one\r\n[Auto - Jan 2] Identified as a caseworker at Hope Atlanta\r\nLine three',
  ])('accepts a prefixed line in %o', (notes) => {
    expect(hasAiCaseworkerNote(notes)).toBe(true);
  });
  it.each([
    // No prefix: staff-typed words are not the AI's line (R1-F8).
    'Identified as a caseworker at Hope Atlanta',
    'Staff: Identified as a caseworker',
    '[Auto] Identified as a caseworker',
    // The tenant's OWN caseworker is mentioned, not identified (prompt.ts).
    '[Auto - Oct 7] Said her caseworker at Hope Atlanta will call',
    '[Auto - Oct 7] Identified as a property manager',
    '[Auto - Oct 7] Identified as a case manager',
    '[Auto - Oct 7] Identified as the caseworker',
    '',
    undefined,
    null,
    5,
  ])('refuses %o', (notes) => {
    expect(hasAiCaseworkerNote(notes)).toBe(false);
  });
});

describe('isCaseworker (a partner whose role satisfies isCaseworkerRole)', () => {
  it.each([
    [{ type: 'partner', role: 'Caseworker' }, true],
    [{ type: 'partner', role: 'case worker' }, true],
    [{ type: 'partner', role: 'Case Manager' }, false],
    [{ type: 'partner' }, false],
    [{ type: 'tenant', role: 'Caseworker' }, false],
    [{ type: 'landlord', role: 'Caseworker' }, false],
    [{ type: 'unknown', role: 'Caseworker' }, false],
    [{ type: 'team_member', role: 'Caseworker' }, false],
  ] as const)('%o -> %s', (contact, expected) => {
    expect(isCaseworker(contact)).toBe(expected);
  });
});

describe('PossibleSignal (plan 3.2 wire names)', () => {
  it('names the four signals in declaration order', () => {
    const order: PossibleSignal[] = ['role_mentions', 'ai_note', 'relationship', 'partner_no_role'];
    expect(order).toHaveLength(4);
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkers.test.ts`
- RED: `../src/lib/caseworkers.js` holds only Task 1.1's constant, so every
  helper case fails (`isCaseworkerRole`, `mentionsCaseworker`,
  `hasAiCaseworkerNote` and `isCaseworker` are not exported - a TypeError
  "is not a function", or a load error naming the missing export). The
  "is defined here and re-exported by contactKinds" case is green (Task
  1.1). Any other failure: stop and report.

GREEN: replace the whole of `app/src/lib/caseworkers.ts` (Write tool) with:

```ts
// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2). PURE - no I/O. A caseworker is a
// `type: 'partner'` contact whose role satisfies isCaseworkerRole; there is no
// caseworker ContactType (D16). Three tiers, each owned here or beside it:
//   - the kind canonicalizer (services/extraction/contactKinds.ts) takes
//     role EXACTLY CASEWORKER_ROLE;
//   - the Caseworkers tab: isCaseworkerRole - the D4 form (normalizeOrgText)
//     is "caseworker" or "case worker";
//   - the Possible caseworkers list, the relationship signal and the
//     KindPicker datalist filter: mentionsCaseworker - the D4 form CONTAINS
//     "caseworker", "case worker" or "case manager".
// Only `role` counts (`role_title` is ignored). The dashboard copy is
// dashboard/src/routes/contact/caseworkerRole.ts, pinned to this module by
// caseworkerRoleMirror.test.ts - change both together.
//
// LEAF MODULE: import nothing but lib/orgNames.ts (itself import-free). The
// dashboard mirror test imports this file, so an import of anything that
// reaches the repos, the adapters or lib/config.ts drags the app's AWS and
// Anthropic graph into the dashboard typecheck (plan 3.2).
import { normalizeOrgText } from './orgNames.js';

/**
 * The caseworker preset role (spec 2026-10-06 D16), byte-exact like
 * PROPERTY_MANAGER_ROLE. A caseworker is `type: 'partner'` with a role that
 * satisfies isCaseworkerRole; this exact text is the role the KindPicker
 * preset and the caseworker conversion write. DEFINED here, in a leaf
 * module, and re-exported by services/extraction/contactKinds.ts (never the
 * reverse: contactKinds.ts type-imports the AWS and Anthropic graph, and the
 * dashboard mirror test imports THIS file). The dashboard copy lives in
 * dashboard/src/routes/contact/caseworkerRole.ts (caseworkerRoleMirror.test.ts
 * pins the two together).
 */
export const CASEWORKER_ROLE = 'Caseworker';

/** The Possible caseworkers row signals (plan 3.2), in wire/declaration order. */
export type PossibleSignal = 'role_mentions' | 'ai_note' | 'relationship' | 'partner_no_role';

const TAB_ROLES: readonly string[] = ['caseworker', 'case worker'];
const MENTIONS: readonly string[] = ['caseworker', 'case worker', 'case manager'];

/** The extraction's own note prefix, `[Auto - Jul 16]` (extraction/apply.ts autoPrefix). */
const AUTO_PREFIX = /^\[Auto - [^\]]+\]\s*/;
const AI_NOTE_STARTS: readonly string[] = [
  'identified as a caseworker',
  'identified as caseworker',
  'identified as a case worker',
  'identified as case worker',
];

/** The tab rule (D16): the D4 form of the role is "caseworker" or "case worker". */
export function isCaseworkerRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  return TAB_ROLES.includes(normalizeOrgText(role));
}

/**
 * The "mentions" rule (D22): the D4 form of the role contains "caseworker",
 * "case worker" or "case manager" - and nothing else counts ("case mgr" and
 * "case management" do not).
 */
export function mentionsCaseworker(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = normalizeOrgText(role);
  return MENTIONS.some((m) => normalized.includes(m));
}

/**
 * The AI-note signal (D22): some line of `notes` starts with the extraction
 * prefix `[Auto - <date>]` and its text after the prefix, in D4 form, starts
 * with "identified as" + "a caseworker" / "caseworker" / "a case worker" /
 * "case worker". A line without the prefix never counts: staff edit `notes`
 * freely, and a tenant's notes routinely mention the tenant's OWN caseworker.
 */
export function hasAiCaseworkerNote(notes: unknown): boolean {
  if (typeof notes !== 'string') return false;
  return notes.split('\n').some((line) => {
    const prefix = AUTO_PREFIX.exec(line);
    if (prefix === null) return false;
    const rest = normalizeOrgText(line.slice(prefix[0].length));
    return AI_NOTE_STARTS.some((start) => rest.startsWith(start));
  });
}

/** "A caseworker", everywhere in the design: a partner whose role satisfies isCaseworkerRole. */
export function isCaseworker(c: { type?: unknown; role?: unknown }): boolean {
  return c.type === 'partner' && isCaseworkerRole(c.role);
}
```

Run the suite - GREEN. ASCII check:
`tr -d '\11\12\15\40-\176' < "W:/tmp/caseworkers/app/src/lib/caseworkers.ts" | wc -c` and the same
for `app/test/caseworkers.test.ts` - both print 0. Then
`cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/lib/caseworkers.ts` and `app/test/caseworkers.test.ts`;
message `feat(caseworkers): the caseworker matching rules - tab, mentions, AI note (D16, D22)`
with the trailer.

### Task 1.3 - `OrgField` gains `organization`; `KINDS_FOR_FIELD.organization` = both kinds (D17)

Files: `app/src/lib/orgNames.ts`, `app/test/orgNames.test.ts`.

Scope: `OrgField` and `KINDS_FOR_FIELD` ONLY. `OrgRecordField`
(`app/src/repos/orgListRepo.ts`) is S5's (assembly ruling S1/S2-2) - do not touch
it here.

RED: edit `app/test/orgNames.test.ts`.

1. Replace

```ts
  it('maps every field to its kinds', () => {
    expect(KINDS_FOR_FIELD.housingAuthority).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.accepted_authorities).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.audience_filter).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.agency).toEqual(['agency']);
  });
```

with

```ts
  it('maps every field to its kinds', () => {
    expect(KINDS_FOR_FIELD.housingAuthority).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.accepted_authorities).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.audience_filter).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.agency).toEqual(['agency']);
    // Caseworkers (spec D17): a partner's organization is a name of EITHER kind.
    expect(KINDS_FOR_FIELD.organization).toEqual(['housing_authority', 'agency']);
  });
```

2. After the `describe('checkScalarWrite (D5)', ...)` block - replace

```ts
describe('checkListWrite (D5 per member)', () => {
```

with

```ts
describe('checkScalarWrite on organization (D17: both kinds)', () => {
  it('stores a name or unique spelling of EITHER kind', () => {
    expect(checkScalarWrite(LIST, 'organization', 'Georgia DCA', undefined)).toEqual({
      ok: true,
      value: 'Georgia Department of Community Affairs',
    });
    expect(checkScalarWrite(LIST, 'organization', 'VASH', undefined)).toEqual({ ok: true, value: VASH.name });
    expect(checkScalarWrite(LIST, 'organization', 'step up', undefined)).toEqual({ ok: true, value: 'Step Up' });
  });
  it('refuses ambiguous and unknown text naming the organization field, and never reports another kind', () => {
    const amb = checkScalarWrite(LIST, 'organization', 'AHA', undefined);
    expect(amb.ok).toBe(false);
    if (!amb.ok) {
      expect(amb.error.field).toBe('organization');
      expect(amb.error.candidates.map((c) => c.name)).toEqual([ATLANTA.name, AUGUSTA.name]);
      expect(amb.error.otherKind).toBeUndefined();
    }
    const unk = checkScalarWrite(LIST, 'organization', 'Nowhere Org', undefined);
    expect(!unk.ok && unk.error.field).toBe('organization');
    expect(!unk.ok && unk.error.otherKind).toBeUndefined();
  });
  it('passes an unchanged value and clears on blank, as every scalar field does', () => {
    expect(checkScalarWrite(LIST, 'organization', 'Old Text', 'Old Text')).toEqual({ ok: true, value: 'Old Text' });
    expect(checkScalarWrite(LIST, 'organization', ' ', 'Step Up')).toEqual({ ok: true, value: null });
  });
});

describe('checkListWrite (D5 per member)', () => {
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgNames.test.ts`
- RED: `KINDS_FOR_FIELD.organization` is undefined (the mapping case
  fails), and every `checkScalarWrite(..., 'organization', ...)` case throws
  a TypeError (`kinds` is undefined inside `isOnListFor`). `npm run
  typecheck` would also refuse `'organization'` as an `OrgField`.

GREEN: edit `app/src/lib/orgNames.ts` - replace

```ts
/** The record fields that hold organization names (branch A). */
export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter';

export const KINDS_FOR_FIELD: Readonly<Record<OrgField, readonly OrgKind[]>> = {
  housingAuthority: ['housing_authority'],
  accepted_authorities: ['housing_authority'],
  audience_filter: ['housing_authority'],
  agency: ['agency'],
};
```

with

```ts
/**
 * The record fields that hold organization names (branch A; `organization`
 * is branch B's partner field, spec D17).
 */
export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter' | 'organization';

export const KINDS_FOR_FIELD: Readonly<Record<OrgField, readonly OrgKind[]>> = {
  housingAuthority: ['housing_authority'],
  accepted_authorities: ['housing_authority'],
  audience_filter: ['housing_authority'],
  agency: ['agency'],
  // D17: a partner's organization accepts EITHER kind, so an "other kind"
  // result can never occur for it.
  organization: ['housing_authority', 'agency'],
};
```

Run the suite - GREEN. Then `cd "W:/tmp/caseworkers"; npm run typecheck` -
exit 0 (no exhaustive switch over `OrgField` exists in app/src; the
dashboard keeps its own `OrgField` mirror, which S7 widens). Regression:
`cd "W:/tmp/caseworkers/app"; npx vitest run test/orgNamesService.test.ts test/contactOrgNames.test.ts test/seedOrgNames.test.ts`
- GREEN, unchanged.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/lib/orgNames.ts` and `app/test/orgNames.test.ts`;
message `feat(caseworkers): organization is an org-name field of both kinds (D17)`
with the trailer.

### Task 1.4 - the dashboard mirror `caseworkerRole.ts` and its drift test (R1-F14, R4-16)

Files: `dashboard/src/routes/contact/caseworkerRole.ts` (new),
`dashboard/src/routes/contact/caseworkerRoleMirror.test.ts` (new).

The module imports ONLY the D4 normalizer mirror (`normalizeOrgText` in
`dashboard/src/routes/orgs/orgCopy.ts`). `orgCopy.ts` imports
`../contact/contactProfile.js`, so `contactProfile.ts` must NEVER import
this module (an import cycle, R4 reference). Later slices (S8: KindPicker,
the datalist filter, ContactDetail, CaseworkersList) import from here.

RED: create `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts`:

```ts
// Cross-workspace caseworker-role MIRROR DRIFT GUARD (spec 2026-10-06 D16,
// D22; plan 3.1; planner rulings R1-F14, R4-16).
//
// caseworkerRole.ts HAND-COPIES the caseworker role rules from
// app/src/lib/caseworkers.ts (the dashboard is a separate package and cannot
// import app code at runtime). Two unpinned copies of a matching rule drift
// silently: a role the server's Caseworkers tab counts that the dashboard's
// KindPicker datalist still offers on a tenant (or the reverse) is exactly
// the record the Possible caseworkers list exists to clean up.
//
// MECHANISM: the mediaTypeMirror.test.ts one - import both copies and compare
// RESOLVED answers over one table. The app module is a LEAF: it imports only
// the import-free lib/orgNames.ts and itself DEFINES CASEWORKER_ROLE
// (contactKinds.ts re-exports it), so the dashboard typecheck compiles two
// app files and never the repos, adapters or lib/config.ts. Import nothing
// else from app/ here.
import { describe, expect, it } from 'vitest';
import {
  CASEWORKER_ROLE as APP_CASEWORKER_ROLE,
  isCaseworkerRole as appIsCaseworkerRole,
  mentionsCaseworker as appMentionsCaseworker,
} from '../../../../app/src/lib/caseworkers.js';
import { CASEWORKER_ROLE, isCaseworkerRole, mentionsCaseworker } from './caseworkerRole.js';

/** A Unicode hyphen built at run time, so this file stays ASCII (U+2010). */
const UNICODE_HYPHEN = String.fromCharCode(0x2010);

const ROLES: readonly unknown[] = [
  'Caseworker',
  'caseworker',
  '  CASEWORKER  ',
  'Case worker',
  'case-worker',
  'Case  Worker.',
  'Case_Worker',
  `Case${UNICODE_HYPHEN}worker`,
  'Caseworkers',
  'Senior Caseworker',
  'Caseworker - DFCS',
  'Case worker 2',
  'Case Manager',
  'case-manager',
  'Housing Case Manager',
  'Case Mgr',
  'Case management',
  'Casework',
  'Social worker',
  'Property Manager',
  '',
  '   ',
  undefined,
  null,
  42,
];

describe('dashboard caseworker role rules mirror app/src/lib/caseworkers.ts', () => {
  it('the preset role is byte-identical', () => {
    expect(CASEWORKER_ROLE).toBe(APP_CASEWORKER_ROLE);
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });

  it.each(ROLES.map((role) => [role]))('isCaseworkerRole(%o) agrees with the app', (role) => {
    expect(isCaseworkerRole(role)).toBe(appIsCaseworkerRole(role));
  });

  it.each(ROLES.map((role) => [role]))('mentionsCaseworker(%o) agrees with the app', (role) => {
    expect(mentionsCaseworker(role)).toBe(appMentionsCaseworker(role));
  });

  it('does not compare constant answers', () => {
    // The floor that stops the agreement above passing VACUOUSLY: each rule
    // says yes and no somewhere in the table, and mentions is the wider rule.
    const tab = ROLES.filter((role) => isCaseworkerRole(role)).length;
    const mentions = ROLES.filter((role) => mentionsCaseworker(role)).length;
    expect(tab).toBeGreaterThan(0);
    expect(tab).toBeLessThan(ROLES.length);
    expect(mentions).toBeGreaterThan(tab);
    expect(mentions).toBeLessThan(ROLES.length);
  });
});
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/caseworkerRoleMirror.test.ts`
- RED: the suite fails to load - `./caseworkerRole.js` does not exist.

GREEN: create `dashboard/src/routes/contact/caseworkerRole.ts`:

```ts
// caseworkerRole - the dashboard copy of the caseworker role rules (spec
// 2026-10-06 D16, D22; plan 3.1). HAND MIRROR of app/src/lib/caseworkers.ts
// (the dashboard cannot import app code at runtime); caseworkerRoleMirror.test.ts
// pins the two copies together - change both together.
//
// A caseworker is a `partner` whose role satisfies isCaseworkerRole (the
// Caseworkers tab, the offer gate on the STORED contact, R4-15). The preset
// lights on the exact CASEWORKER_ROLE. mentionsCaseworker is the looser rule
// the KindPicker "Other" datalist filter uses (D22).
//
// IMPORT RULE: this module imports only the D4 normalizer mirror. orgCopy.ts
// imports contactProfile.ts, so contactProfile.ts must never import this
// module (an import cycle).
import { normalizeOrgText } from '../orgs/orgCopy.js';

/** The caseworker preset role, byte-exact (the server's CASEWORKER_ROLE). */
export const CASEWORKER_ROLE = 'Caseworker';

const TAB_ROLES: readonly string[] = ['caseworker', 'case worker'];
const MENTIONS: readonly string[] = ['caseworker', 'case worker', 'case manager'];

/** The tab rule: the D4 form of the role is "caseworker" or "case worker". */
export function isCaseworkerRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  return TAB_ROLES.includes(normalizeOrgText(role));
}

/** The mentions rule: the D4 form contains "caseworker", "case worker" or "case manager". */
export function mentionsCaseworker(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = normalizeOrgText(role);
  return MENTIONS.some((m) => normalized.includes(m));
}
```

Run the suite - GREEN. ASCII check (`tr -d '\11\12\15\40-\176' < FILE | wc -c`
prints 0) on both new files. Then `cd "W:/tmp/caseworkers"; npm run
typecheck` - exit 0. The dashboard tsc now compiles exactly two app files
through the mirror test: `app/src/lib/caseworkers.ts` and
`app/src/lib/orgNames.ts`. Prove it before committing:
`grep -n "^import" "W:/tmp/caseworkers/app/src/lib/caseworkers.ts" "W:/tmp/caseworkers/app/src/lib/orgNames.ts"`
prints exactly one line, `caseworkers.ts`'s import of `./orgNames.js`
(plan 3.2; plan review R1 ruling A2). Any other import line: stop and
report.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`dashboard/src/routes/contact/caseworkerRole.ts` and
`dashboard/src/routes/contact/caseworkerRoleMirror.test.ts`;
message `feat(caseworkers): dashboard caseworker role rules, mirror-tested against the app (R4-16)`
with the trailer.

---

## S2 - repo primitives and their fakes (`app/src/repos/contactsRepo.ts`, `app/src/repos/conversationsRepo.ts`, `app/src/repos/unitsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`; the full-repo test fakes in `app/test/audienceResolution.test.ts`, `contactCapture.test.ts`, `sendMessage.test.ts`, `scheduledSendSuppression.test.ts`; test `app/test/caseworkerRepoParity.integration.test.ts` (new))

Spec D19, D21, D22; plan 3.3 (as amended by assembly rulings S1/S2-1, S1/S2-3, S1/S2-4);
rulings R1-F1, R1-F3, R1-F15, R3-F4, R5-F17. Every primitive changes in the
REAL repo and the FakeWorld in the SAME task, and every case in
`caseworkerRepoParity.integration.test.ts` runs against BOTH (the
`orgRecordWriters.integration.test.ts` idiom: the fake half always, the
DynamoDB Local half when `npm run db:start` is up). A fake that disagrees
with its repo lets S3/S4 pass against behavior production never has.

Fake pointer rows keep their `type: 'unknown'` sentinel (the real row has
no type). Consequence for S3/S4 (R1-F1): their 404 tests must use a pointer
ID (`phoneref#...` / `emailref#...`), never rely on "no type".

### Task 2.1 - `ContactItem` caseworker fields; `update` guards: a list of `expect` clauses (number values) and `notDeleted` (D19, D22; R1-F3)

Files: `app/src/repos/contactsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts` (new).

RED: create `app/test/caseworkerRepoParity.integration.test.ts` (Tasks
2.2-2.5 insert their `describe` blocks ABOVE its final marker line):

```ts
// Caseworkers (branch B) repo primitives - real repo vs harness fake (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D21, D22; plan 3.3; rulings R1-F3, R1-F15, R3-F4, R5-F17). The
// caseworker conversion commits through a multi-clause update guard, decides
// "own thread" with an all-holders phone/email read, re-types threads
// conditionally, and scans units without the soft-delete filter; the shares
// recipients route reads a second display projection. Every case runs
// against BOTH the real repos (DynamoDB Local) and the harness world fakes and
// must answer the same - a fake that disagrees with its repo lets the service
// suites pass against behavior production never has. The fake half runs
// without Docker; the real half self-skips.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createContactsRepo,
  emailRefId,
  phoneRefId,
  type CaseworkerConversionRecord,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../src/repos/unitsRepo.js';
import { quietLogger } from './helpers/orgFixtures.js';
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
    `[caseworkerRepoParity.integration] DynamoDB Local half SKIPPED - nothing at ${endpoint}. ` +
      'Run `npm run db:start` to exercise it.',
  );
}

const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const contactsTable = tableName('contacts', testEnv);
const conversationsTable = tableName('conversations', testEnv);
const unitsTable = tableName('units', testEnv);

beforeAll(async () => {
  if (!reachable) return;
  await ensureTable(client, getTableSpec('contacts'), contactsTable);
  await ensureTable(client, getTableSpec('conversations'), conversationsTable);
  await ensureTable(client, getTableSpec('units'), unitsTable);
}, 120_000);

afterAll(async () => {
  if (reachable) {
    await deleteTableIfExists(client, contactsTable);
    await deleteTableIfExists(client, conversationsTable);
    await deleteTableIfExists(client, unitsTable);
  }
  doc.destroy();
  client.destroy();
}, 120_000);

// Phones are unique across the whole run: the real tables are shared by every
// case, and a reused number would meet an earlier case's rows on byPhone.
let phoneSeq = 2000;
const nextPhone = (): string => `+1555020${String(++phoneSeq).padStart(4, '0')}`;

/** One implementation under test: the repos plus raw seed/read access. */
interface World {
  contacts: ContactsRepo;
  conversations: ConversationsRepo;
  units: UnitsRepo;
  putContact(item: ContactItem): Promise<void>;
  readContact(contactId: string): Promise<ContactItem | undefined>;
  /** A pointer row as each implementation stores one (the real row has NO type; the fake's carries the 'unknown' sentinel). */
  putPointer(kind: 'phone' | 'email', value: string, ownerId: string): Promise<void>;
  putConversation(item: Record<string, unknown> & { conversationId: string }): Promise<void>;
  readConversation(conversationId: string): Promise<ConversationItem | undefined>;
  putUnit(item: UnitItem): Promise<void>;
}

function realWorld(): World {
  const logger = quietLogger();
  return {
    contacts: createContactsRepo({ doc, env: testEnv, logger }),
    conversations: createConversationsRepo({ doc, env: testEnv, logger }),
    units: createUnitsRepo({ doc, env: testEnv, logger }),
    async putContact(item) {
      await doc.send(new PutCommand({ TableName: contactsTable, Item: item }));
    },
    async readContact(contactId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: contactsTable, Key: { contactId }, ConsistentRead: true }),
      );
      return Item as ContactItem | undefined;
    },
    async putPointer(kind, value, ownerId) {
      const Item =
        kind === 'phone'
          ? { contactId: phoneRefId(value), phone: value, phone_ref: true, phone_ref_owner: ownerId }
          : { contactId: emailRefId(value), email: value, email_ref: true, email_ref_owner: ownerId };
      await doc.send(new PutCommand({ TableName: contactsTable, Item }));
    },
    async putConversation(item) {
      await doc.send(new PutCommand({ TableName: conversationsTable, Item: item }));
    },
    async readConversation(conversationId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: conversationsTable, Key: { conversationId }, ConsistentRead: true }),
      );
      return Item as ConversationItem | undefined;
    },
    async putUnit(item) {
      await doc.send(new PutCommand({ TableName: unitsTable, Item: item }));
    },
  };
}

function fakeWorld(): World {
  const world = createFakeWorld();
  return {
    contacts: world.contactsRepo,
    conversations: world.conversationsRepo,
    units: world.unitsRepo,
    async putContact(item) {
      world.contacts.push(structuredClone(item));
    },
    async readContact(contactId) {
      const hit = world.contacts.find((c) => c.contactId === contactId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async putPointer(kind, value, ownerId) {
      world.contacts.push(
        (kind === 'phone'
          ? { contactId: phoneRefId(value), type: 'unknown', phone: value, phone_ref: true, phone_ref_owner: ownerId }
          : { contactId: emailRefId(value), type: 'unknown', email: value, email_ref: true, email_ref_owner: ownerId }) as ContactItem,
      );
    },
    async putConversation(item) {
      world.conversations.set(item.conversationId, structuredClone(item) as unknown as ConversationItem);
    },
    async readConversation(conversationId) {
      const hit = world.conversations.get(conversationId);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async putUnit(item) {
      world.units.set(item.unitId, structuredClone(item));
    },
  };
}

/** One case against the harness fake (always) and DynamoDB Local (when reachable). */
function parity(name: string, run: (w: World, id: string) => Promise<void>): void {
  it(`${name} [harness fake]`, async () => {
    await run(fakeWorld(), `fake-${randomUUID().slice(0, 8)}`);
  });
  it.skipIf(!reachable)(`${name} [DynamoDB Local]`, async () => {
    await run(realWorld(), `real-${randomUUID().slice(0, 8)}`);
  });
}

describe('contactsRepo.update guards - expect clauses and notDeleted (plan 3.3)', () => {
  parity('(PIN) the single-object expect form still guards one attribute', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'onboarding', staff_notes_updated_at: 'T1' });
    await expect(
      w.contacts.update(id, { staff_notes: 'lost' }, { expect: { attr: 'staff_notes_updated_at', value: 'T0' } }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const ok = await w.contacts.update(id, { staff_notes: 'kept' }, { expect: { attr: 'staff_notes_updated_at', value: 'T1' } });
    expect(ok.staff_notes).toBe('kept');
  });

  parity('writes when EVERY clause holds - number, string, empty string, absent - and REMOVEs a guarded attribute in the same write', async (w, id) => {
    await w.putContact({
      contactId: id,
      type: 'tenant',
      status: 'searching',
      classification_revision: 4,
      housingAuthority: 'Atlanta Housing Authority',
      housingAuthority_source: 'ai',
      agency: '',
      firstName: 'Pat',
    });
    const updated = await w.contacts.update(
      id,
      { type: 'partner', role: 'Caseworker', status: 'active', housingAuthority: null, housingAuthority_source: null, agency: '' },
      {
        expect: [
          { attr: 'classification_revision', value: 4 },
          { attr: 'housingAuthority', value: 'Atlanta Housing Authority' },
          { attr: 'agency', value: '' },
          { attr: 'organization', value: null },
        ],
        notDeleted: true,
      },
    );
    expect(updated.type).toBe('partner');
    const stored = await w.readContact(id);
    expect(stored).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      agency: '',
      classification_revision: 5,
      firstName: 'Pat',
    });
    expect(stored).not.toHaveProperty('housingAuthority');
    expect(stored).not.toHaveProperty('housingAuthority_source');
  });

  parity('refuses when ANY one clause is lost, writing nothing', async (w, id) => {
    const base: ContactItem = { contactId: id, type: 'tenant', status: 'searching', classification_revision: 2, agency: 'Step Up' };
    await w.putContact(base);
    const lost: Array<[number, string | null]> = [
      [1, 'Step Up'], // a stale revision
      [2, 'Other'], // another agency
      [2, null], // "absent" is not a held value
      [2, ''], // '' is not 'Step Up'
    ];
    for (const [revision, agency] of lost) {
      await expect(
        w.contacts.update(
          id,
          { firstName: 'Lost' },
          { expect: [{ attr: 'classification_revision', value: revision }, { attr: 'agency', value: agency }] },
        ),
      ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    }
    expect(await w.readContact(id)).toEqual(base);
  });

  parity('guards the RAW revision: an absent fence matches null, never the folded 0 (R1-F3)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'unknown', status: 'needs_review' });
    const patch = { type: 'partner', role: 'Caseworker', status: 'active' };
    await expect(
      w.contacts.update(id, patch, { expect: [{ attr: 'classification_revision', value: 0 }] }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const updated = await w.contacts.update(id, patch, { expect: [{ attr: 'classification_revision', value: null }] });
    expect(updated.classification_revision).toBe(1);
  });

  parity('notDeleted refuses a soft-deleted contact even when every clause holds (D22)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching', agency: 'Step Up', deleted_at: '2026-10-07T09:00:00.000Z' });
    await expect(
      w.contacts.update(id, { agency: '' }, { expect: [{ attr: 'agency', value: 'Step Up' }], notDeleted: true }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect((await w.readContact(id))?.['agency']).toBe('Step Up');
    // Deletion is not an IMPLIED guard: without notDeleted the same write lands.
    await w.contacts.update(id, { agency: '' }, { expect: [{ attr: 'agency', value: 'Step Up' }] });
    expect((await w.readContact(id))?.['agency']).toBe('');
  });

  parity('a no-op update evaluates every clause and notDeleted', async (w, id) => {
    await w.putContact({ contactId: id, type: 'partner', status: 'active', classification_revision: 3 });
    await expect(
      w.contacts.update(id, {}, { expect: [{ attr: 'classification_revision', value: 3 }, { attr: 'organization', value: 'X' }] }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const same = await w.contacts.update(
      id,
      {},
      { expect: [{ attr: 'classification_revision', value: 3 }, { attr: 'organization', value: null }], notDeleted: true },
    );
    expect(same.contactId).toBe(id);
    const deletedId = `${id}-deleted`;
    await w.putContact({ contactId: deletedId, type: 'partner', status: 'active', deleted_at: '2026-10-07T09:00:00.000Z' });
    await expect(w.contacts.update(deletedId, {}, { notDeleted: true })).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  parity('the caseworker fields round-trip typed (ContactItem, plan 3.2)', async (w, id) => {
    await w.putContact({ contactId: id, type: 'tenant', status: 'searching' });
    const record: CaseworkerConversionRecord = {
      at: '2026-10-07T10:00:00.000Z',
      by: 'staff@example.test',
      fromType: 'tenant',
      fromRole: 'Case worker',
      housingAuthority: 'Atlanta Housing Authority',
      agency: 'Step Up',
    };
    await w.contacts.update(id, {
      organization: 'Step Up',
      caseworker_conversion: record,
      type_source: 'manual',
      caseworker_review: 'dismissed',
    });
    const stored = await w.readContact(id);
    // Typed reads: these four lines are what `npm run typecheck` checks.
    const organization: string | undefined = stored?.organization;
    const conversion: CaseworkerConversionRecord | undefined = stored?.caseworker_conversion;
    const typeSource: 'manual' | undefined = stored?.type_source;
    const review: 'dismissed' | undefined = stored?.caseworker_review;
    expect({ organization, conversion, typeSource, review }).toEqual({
      organization: 'Step Up',
      conversion: record,
      typeSource: 'manual',
      review: 'dismissed',
    });
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
- RED, both halves: the fake reads `opts.expect.attr` off the ARRAY
  (undefined), so `current === value` compares undefined to undefined and
  every list guard passes - "refuses when ANY one clause is lost", "guards
  the RAW revision" and "a no-op update" fail (the update resolves); the
  fake ignores `notDeleted` ("notDeleted refuses" fails). The real repo
  builds `#expectAttr` / `:expectValue` from the array's undefined `attr` /
  `value`, so the request fails before or at DynamoDB with an error that is
  NOT a ConditionalCheckFailedException (the document client's undefined
  marshalling error, or a ValidationException), and every list case fails. The (PIN) case and the round-trip case pass at runtime.
- `cd "W:/tmp/caseworkers"; npm run typecheck` is also RED:
  `CaseworkerConversionRecord` is not exported, `expect` does not accept an
  array, `notDeleted` is not an option, and the typed reads of
  `organization`, `caseworker_conversion`, `type_source`,
  `caseworker_review` are `unknown`.

GREEN: edit `app/src/repos/contactsRepo.ts`.

1. Before the `ContactItem` interface - replace

```ts
export interface ContactItem {
  contactId: string;
```

with

```ts
/**
 * The caseworker conversion's record of what it removed (spec 2026-10-06
 * D19; plan 3.2), written in the conversion's commit write - so the removed
 * values survive any later failure and a mistaken conversion can be put back
 * by hand. Server-owned; a later conversion replaces it.
 */
export interface CaseworkerConversionRecord {
  /** ISO 8601. */
  at: string;
  /** The actor's userId (the session's `req.user.userId`, as audit rows record actors) - never an email. */
  by: string;
  fromType: ContactType;
  fromRole?: string;
  /** The removed housing authority, when there was one. */
  housingAuthority?: string;
  /** The cleared agency, when it was non-empty. */
  agency?: string;
}

export interface ContactItem {
  contactId: string;
```

2. In `ContactItem` - replace

```ts
  email_ref?: boolean;
  email_ref_owner?: string;
```

with

```ts
  email_ref?: boolean;
  email_ref_owner?: string;
  /**
   * Caseworkers (spec 2026-10-06 D17): the helper organization a partner works
   * for - a list name of EITHER kind (KINDS_FOR_FIELD.organization),
   * D5-checked on the contacts PATCH; ABSENT when cleared (never ''). Not an
   * index key.
   */
  organization?: string;
  /** D19: set by caseworker-review `dismiss` only; hides the contact from Possible caseworkers for good. Server-owned. */
  caseworker_review?: 'dismissed';
  /** D19: the caseworker conversion's record (CaseworkerConversionRecord). Server-owned. */
  caseworker_conversion?: CaseworkerConversionRecord;
  /**
   * D21: 'manual' once staff override a type (or convert a caseworker); the
   * importer then writes none of type, status, housingAuthority, agency.
   * Server-owned; never cleared.
   */
  type_source?: 'manual';
```

3. The options type - replace the whole block

```ts
/**
 * Options for `update`. `expect` is an optimistic-concurrency guard on ONE
 * attribute, evaluated in the SAME conditional UpdateItem as the write: the
 * write lands only while the stored `attr` equals `value` (or is absent, for
 * `value: null`). A mismatch throws ConditionalCheckFailedException exactly
 * like an unknown contact does - the caller re-reads to tell "gone" from
 * "stale". Used by the Staff notes stale-save guard (PATCH
 * staff_notes_expected_updated_at, spec 3.9).
 */
export interface UpdateContactOptions {
  expect?: { attr: string; value: string | null };
}
```

with

```ts
/**
 * One `update` guard clause: the stored `attr` equals `value` exactly (a
 * string or a number - a number clause compares a stored number, so the
 * classification fence is guarded RAW, never through
 * contactClassificationRevision's fold of "absent" to 0), or is ABSENT for
 * `value: null`.
 */
export interface ExpectClause {
  attr: string;
  value: string | number | null;
}

/**
 * Options for `update`: optimistic-concurrency guards evaluated in the SAME
 * conditional UpdateItem as the write, so nothing can slip between a caller's
 * read and its write. `expect` is one clause or a list (every clause ANDed);
 * `notDeleted` adds attribute_not_exists(deleted_at). A lost guard throws
 * ConditionalCheckFailedException exactly like an unknown contact does - the
 * caller re-reads to tell "gone" from "stale". A no-op update evaluates every
 * guard on a consistent read. Users: the Staff notes stale-save guard (PATCH
 * staff_notes_expected_updated_at, spec 3.9 - one clause) and the caseworker
 * conversion's commit (spec 2026-10-06 D19/D22 - the raw
 * classification_revision, housingAuthority, agency and organization as read,
 * plus notDeleted).
 */
export interface UpdateContactOptions {
  expect?: ExpectClause | ExpectClause[];
  notDeleted?: true;
}

/** The `expect` option as a list (the single-object form is one clause). */
export function expectClausesOf(opts: UpdateContactOptions | undefined): ExpectClause[] {
  const expected = opts?.expect;
  if (expected === undefined) return [];
  return Array.isArray(expected) ? expected : [expected];
}
```

4. The no-op path in `update` - replace

```ts
        // An `expect` guard still applies: checked on a consistent read, so a
        // no-op guarded update refuses exactly when a guarded write would.
        const existing = await this.getById(contactId, { consistentRead: opts?.expect !== undefined });
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `contact ${contactId} not found`,
            $metadata: {},
          });
        }
        if (opts?.expect !== undefined) {
          const current = existing[opts.expect.attr];
          const matches = opts.expect.value === null ? current === undefined : current === opts.expect.value;
          if (!matches) {
            throw new ConditionalCheckFailedException({
              message: `contact ${contactId}: expected ${opts.expect.attr} did not match`,
              $metadata: {},
            });
          }
        }
        return existing;
```

with

```ts
        // Every guard still applies (UpdateContactOptions): checked on a
        // consistent read, so a no-op guarded update refuses exactly when a
        // guarded write would.
        const guards = expectClausesOf(opts);
        const guarded = guards.length > 0 || opts?.notDeleted === true;
        const existing = await this.getById(contactId, { consistentRead: guarded });
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `contact ${contactId} not found`,
            $metadata: {},
          });
        }
        if (opts?.notDeleted === true && existing['deleted_at'] !== undefined) {
          throw new ConditionalCheckFailedException({
            message: `contact ${contactId}: deleted`,
            $metadata: {},
          });
        }
        for (const guard of guards) {
          const current = existing[guard.attr];
          const matches = guard.value === null ? current === undefined : current === guard.value;
          if (!matches) {
            throw new ConditionalCheckFailedException({
              message: `contact ${contactId}: expected ${guard.attr} did not match`,
              $metadata: {},
            });
          }
        }
        return existing;
```

5. The guarded write in `update` - replace

```ts
      // The optional optimistic-concurrency guard (UpdateContactOptions): one
      // more clause on the SAME condition, so no write can slip between a
      // separate read and this one.
      let condition = 'attribute_exists(contactId)';
      if (opts?.expect !== undefined) {
        names['#expectAttr'] = opts.expect.attr;
        if (opts.expect.value === null) {
          condition += ' AND attribute_not_exists(#expectAttr)';
        } else {
          values[':expectValue'] = opts.expect.value;
          condition += ' AND #expectAttr = :expectValue';
        }
      }
```

with

```ts
      // The optional optimistic-concurrency guards (UpdateContactOptions):
      // more clauses on the SAME condition, so no write can slip between a
      // separate read and this one. Each clause has its own placeholder
      // (#expect<j>, never the patch's #k<i>), so a clause may guard the very
      // attribute the patch SETs or REMOVEs - the caseworker conversion guards
      // housingAuthority and REMOVEs it in one write.
      let condition = 'attribute_exists(contactId)';
      expectClausesOf(opts).forEach((guard, j) => {
        const nameKey = `#expect${j}`;
        names[nameKey] = guard.attr;
        if (guard.value === null) {
          condition += ` AND attribute_not_exists(${nameKey})`;
        } else {
          values[`:expect${j}`] = guard.value;
          condition += ` AND ${nameKey} = :expect${j}`;
        }
      });
      if (opts?.notDeleted === true) {
        names['#expectDeletedAt'] = 'deleted_at';
        condition += ' AND attribute_not_exists(#expectDeletedAt)';
      }
```

Edit `app/test/helpers/twilioWebhookHarness.ts`.

1. The contactsRepo import - replace

```ts
  emailRefId,
  EmptyIndexKeyError,
  INDEX_KEY_ATTRIBUTES,
```

with

```ts
  emailRefId,
  EmptyIndexKeyError,
  expectClausesOf,
  INDEX_KEY_ATTRIBUTES,
```

2. The contacts fake `update` - replace

```ts
      // Mirror the real repo's optional `expect` guard (UpdateContactOptions):
      // refuse BEFORE any field is applied, as one conditional UpdateItem would.
      if (opts?.expect !== undefined) {
        const current = contact[opts.expect.attr];
        const matches = opts.expect.value === null ? current === undefined : current === opts.expect.value;
        if (!matches) {
          throw conditionalCheckFailed(`update: expected ${opts.expect.attr} did not match on ${contactId}`);
        }
      }
```

with

```ts
      // Mirror the real repo's optional guards (UpdateContactOptions): every
      // `expect` clause (string, number or null = absent) and `notDeleted`
      // (attribute_not_exists(deleted_at)), refused BEFORE any field is
      // applied, as one conditional UpdateItem would.
      if (opts?.notDeleted === true && contact['deleted_at'] !== undefined) {
        throw conditionalCheckFailed(`update: ${contactId} is deleted`);
      }
      for (const guard of expectClausesOf(opts)) {
        const current = contact[guard.attr];
        const matches = guard.value === null ? current === undefined : current === guard.value;
        if (!matches) {
          throw conditionalCheckFailed(`update: expected ${guard.attr} did not match on ${contactId}`);
        }
      }
```

Run the suite - GREEN (the fake half; the real half with DynamoDB Local).
Then `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0. Regression (the
single-clause Staff notes guard through the PATCH, and the repo's own
pins):
`cd "W:/tmp/caseworkers/app"; npx vitest run test/contactStaffNotes.test.ts test/contactsRepo.integration.test.ts test/contactTriage.test.ts`
- GREEN, unchanged. ASCII check the new test file (0).

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/repos/contactsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`
and `app/test/caseworkerRepoParity.integration.test.ts`;
message `feat(caseworkers): contactsRepo.update guards a list of clauses and notDeleted; ContactItem caseworker fields`
with the trailer.

### Task 2.2 - `contactsRepo.findAllByPhone` / `findAllByEmail` - every live holder (D21)

Files: `app/src/repos/contactsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`, and the four full
`ContactsRepo` test fakes: `app/test/audienceResolution.test.ts`,
`app/test/contactCapture.test.ts`, `app/test/sendMessage.test.ts`,
`app/test/scheduledSendSuppression.test.ts`.

RED: in `app/test/caseworkerRepoParity.integration.test.ts` replace

```ts
// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

with

```ts
const idsOf = (contacts: ContactItem[]): string[] => contacts.map((c) => c.contactId).sort();

describe('contactsRepo.findAllByPhone / findAllByEmail (plan 3.3; D21 "own thread")', () => {
  parity('returns EVERY live holder of a phone - duplicate primaries and a pointer owner - as whole contacts', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone, firstName: 'Ana' });
    await w.putContact({ contactId: `${id}-b`, type: 'unknown', status: 'needs_review', phone });
    await w.putContact({ contactId: `${id}-c`, type: 'partner', status: 'active', phone: nextPhone() });
    await w.putPointer('phone', phone, `${id}-c`);
    const holders = await w.contacts.findAllByPhone(phone);
    expect(idsOf(holders)).toEqual([`${id}-a`, `${id}-b`, `${id}-c`]);
    expect(holders.some((c) => c.phone_ref === true)).toBe(false);
    expect(holders.find((c) => c.contactId === `${id}-a`)?.firstName).toBe('Ana');
  });

  parity('lists a holder once when it is reached as a primary AND through a pointer', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone });
    await w.putPointer('phone', phone, `${id}-a`);
    expect(idsOf(await w.contacts.findAllByPhone(phone))).toEqual([`${id}-a`]);
  });

  parity('drops soft-deleted holders and dangling pointers; an unknown phone answers []', async (w, id) => {
    const deletedAt = '2026-10-07T09:00:00.000Z';
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-live`, type: 'tenant', status: 'searching', phone });
    await w.putContact({ contactId: `${id}-gone`, type: 'tenant', status: 'searching', phone, deleted_at: deletedAt });
    expect(idsOf(await w.contacts.findAllByPhone(phone))).toEqual([`${id}-live`]);

    const dangling = nextPhone();
    await w.putPointer('phone', dangling, `${id}-missing`);
    expect(await w.contacts.findAllByPhone(dangling)).toEqual([]);

    const deletedOwner = nextPhone();
    await w.putContact({ contactId: `${id}-del-owner`, type: 'partner', status: 'active', phone: nextPhone(), deleted_at: deletedAt });
    await w.putPointer('phone', deletedOwner, `${id}-del-owner`);
    expect(await w.contacts.findAllByPhone(deletedOwner)).toEqual([]);

    expect(await w.contacts.findAllByPhone(nextPhone())).toEqual([]);
  });

  parity('(PIN) findByPhone still answers ONE holder of a shared phone', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', phone });
    await w.putContact({ contactId: `${id}-b`, type: 'tenant', status: 'searching', phone });
    const one = await w.contacts.findByPhone(phone);
    expect([`${id}-a`, `${id}-b`]).toContain(one?.contactId);
  });

  parity('findAllByEmail: the same contract on the byEmail index', async (w, id) => {
    const shared = `${id}-shared@example.test`;
    await w.putContact({ contactId: `${id}-a`, type: 'tenant', status: 'searching', email: shared });
    await w.putContact({ contactId: `${id}-gone`, type: 'tenant', status: 'searching', email: shared, deleted_at: '2026-10-07T09:00:00.000Z' });
    await w.putContact({ contactId: `${id}-c`, type: 'landlord', status: 'active', email: `${id}-c@example.test` });
    await w.putPointer('email', shared, `${id}-c`);
    expect(idsOf(await w.contacts.findAllByEmail(shared))).toEqual([`${id}-a`, `${id}-c`]);
    expect(await w.contacts.findAllByEmail(`${id}-nobody@example.test`)).toEqual([]);
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
- RED: `w.contacts.findAllByPhone is not a function` (and
  `findAllByEmail`) on both halves; the (PIN) case passes.

GREEN: edit `app/src/repos/contactsRepo.ts`.

1. Imports - replace

```ts
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
```

with

```ts
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
import { logger as defaultLogger } from '../lib/logger.js';
```

2. Interface - replace

```ts
  findByPhone(phone: string): Promise<ContactItem | undefined>;
```

with

```ts
  findByPhone(phone: string): Promise<ContactItem | undefined>;
  /**
   * Caseworkers (spec 2026-10-06 D21; plan 3.3): EVERY contact the byPhone
   * index holds for `phone` - the Query walked to exhaustion, pointer rows
   * resolved to their owning contact (a dangling pointer dropped),
   * de-duplicated by contactId, soft-deleted contacts EXCLUDED. Order is the
   * index's (arbitrary). findByPhone stays the one-holder routing read; this
   * is the read that can tell "no other live contact holds this number". A
   * stale pointer still names its owner (it errs toward "shared").
   */
  findAllByPhone(phone: string): Promise<ContactItem[]>;
```

and replace

```ts
  findByEmail(email: string): Promise<ContactItem | undefined>;
```

with

```ts
  findByEmail(email: string): Promise<ContactItem | undefined>;
  /** The byEmail twin of findAllByPhone (plan 3.3) - the same contract. */
  findAllByEmail(email: string): Promise<ContactItem[]>;
```

3. The shared walk - before the returned object, replace

```ts
  return {
    async findByPhone(phone) {
```

with

```ts
  /**
   * findAllByPhone / findAllByEmail (plan 3.3): one index Query walked to
   * exhaustion (queryAll), every pointer row resolved to its owner by id,
   * de-duplicated by contactId, soft-deleted holders and dangling pointers
   * dropped. At most one pointer row exists per value (putPointer is
   * conditional on its id), so the owner reads are few.
   */
  const allHolders = async (index: 'byPhone' | 'byEmail', value: string): Promise<ContactItem[]> => {
    const byPhone = index === 'byPhone';
    const rows = await queryAll<ContactItem>(
      doc,
      {
        TableName: table,
        IndexName: index,
        KeyConditionExpression: byPhone ? 'phone = :v' : 'email = :v',
        ExpressionAttributeValues: { ':v': value },
      },
      { logger: log },
    );
    const out: ContactItem[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const isPointer = byPhone ? row.phone_ref === true : row.email_ref === true;
      let holder: ContactItem | undefined = row;
      if (isPointer) {
        const ownerId = byPhone ? row.phone_ref_owner : row.email_ref_owner;
        holder = typeof ownerId === 'string' ? await getByIdImpl(ownerId) : undefined;
      }
      if (holder === undefined || isDeleted(holder) || seen.has(holder.contactId)) continue;
      seen.add(holder.contactId);
      out.push(holder);
    }
    return out;
  };

  return {
    async findByPhone(phone) {
```

4. The methods - replace

```ts
    async getById(contactId, opts) {
      return getByIdImpl(contactId, opts?.consistentRead);
    },
```

with

```ts
    async findAllByPhone(phone) {
      return allHolders('byPhone', phone);
    },

    async findAllByEmail(email) {
      return allHolders('byEmail', email);
    },

    async getById(contactId, opts) {
      return getByIdImpl(contactId, opts?.consistentRead);
    },
```

Edit `app/test/helpers/twilioWebhookHarness.ts` - the contacts fake.

1. Replace

```ts
  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
```

with

```ts
  /**
   * findAllByPhone / findAllByEmail (plan 3.3): EVERY row holding the value,
   * pointer rows resolved to their owner, de-duplicated by contactId,
   * soft-deleted holders and dangling pointers dropped - the real repo's
   * contract. Array order (the real index order is arbitrary; never rely on
   * it).
   */
  const fakeAllHolders = (kind: 'phone' | 'email', value: string): ContactItem[] => {
    const out: ContactItem[] = [];
    const seen = new Set<string>();
    for (const row of contacts.filter((c) => c[kind] === value)) {
      const isPointer = kind === 'phone' ? row.phone_ref === true : row.email_ref === true;
      const ownerId = kind === 'phone' ? row.phone_ref_owner : row.email_ref_owner;
      const holder = isPointer
        ? typeof ownerId === 'string'
          ? contacts.find((c) => c.contactId === ownerId)
          : undefined
        : row;
      if (holder === undefined || isDeleted(holder) || seen.has(holder.contactId)) continue;
      seen.add(holder.contactId);
      out.push(holder);
    }
    return out;
  };

  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
```

2. Replace

```ts
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
```

with

```ts
    async findAllByPhone(phone) {
      return fakeAllHolders('phone', phone);
    },
    async findAllByEmail(email) {
      return fakeAllHolders('email', email);
    },
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
```

Test fallout (typecheck): the four full `ContactsRepo` literals no longer
satisfy the interface. In EACH of `app/test/audienceResolution.test.ts`,
`app/test/contactCapture.test.ts`, `app/test/sendMessage.test.ts` and
`app/test/scheduledSendSuppression.test.ts` replace (unique in each file)

```ts
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
```

with

```ts
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
    findAllByPhone: async () => {
      throw new Error('findAllByPhone: not used in this suite');
    },
    findAllByEmail: async () => {
      throw new Error('findAllByEmail: not used in this suite');
    },
```

(the `as unknown as ContactsRepo` cast fakes are unaffected).

Run the suite - GREEN. Then `cd "W:/tmp/caseworkers"; npm run typecheck` -
exit 0, and
`cd "W:/tmp/caseworkers/app"; npx vitest run test/audienceResolution.test.ts test/contactCapture.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts test/contactsRepo.integration.test.ts test/contactsRepo.email.test.ts`
- unchanged and GREEN.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/repos/contactsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`,
`app/test/audienceResolution.test.ts`, `app/test/contactCapture.test.ts`,
`app/test/sendMessage.test.ts`, `app/test/scheduledSendSuppression.test.ts`;
message `feat(caseworkers): contactsRepo.findAllByPhone / findAllByEmail - every live holder (D21)`
with the trailer.

### Task 2.3 - `contactsRepo.getRecipientDisplaysByIds` - the display projection plus `type` and `role` (D20, D22; R3-F4)

Files: `app/src/repos/contactsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`, and the same four full
`ContactsRepo` test fakes as Task 2.2.

A SECOND projection for the units recipients route only (S6);
`getDisplaysByIds` and `DISPLAY_PROJECTION` are NOT widened (R3-F4).

RED: in `app/test/caseworkerRepoParity.integration.test.ts` replace the
marker line

```ts
// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

with

```ts
describe('contactsRepo.getRecipientDisplaysByIds (plan 3.3; R3-F4)', () => {
  parity('projects the display fields plus type and role - nothing else; a missing id is absent', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({
      contactId: `${id}-p`,
      type: 'partner',
      status: 'active',
      firstName: 'Pat',
      lastName: 'Lee',
      phone,
      role: 'Caseworker',
      organization: 'Step Up',
      housingAuthority: 'Atlanta Housing Authority',
      notes: 'not projected',
    });
    await w.putContact({
      contactId: `${id}-t`,
      type: 'tenant',
      status: 'searching',
      firstName: 'Tia',
      deleted_at: '2026-10-07T09:00:00.000Z',
    });
    const map = await w.contacts.getRecipientDisplaysByIds([`${id}-p`, `${id}-t`, `${id}-missing`]);
    expect(map.get(`${id}-p`)).toEqual({
      contactId: `${id}-p`,
      firstName: 'Pat',
      lastName: 'Lee',
      phone,
      type: 'partner',
      role: 'Caseworker',
    });
    expect(map.get(`${id}-t`)).toEqual({
      contactId: `${id}-t`,
      firstName: 'Tia',
      type: 'tenant',
      deleted_at: '2026-10-07T09:00:00.000Z',
    });
    expect(map.has(`${id}-missing`)).toBe(false);
  });

  parity('(PIN) getDisplaysByIds keeps its narrower projection - no type, no role', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({ contactId: id, type: 'partner', status: 'active', firstName: 'Pat', phone, role: 'Caseworker' });
    expect((await w.contacts.getDisplaysByIds([id])).get(id)).toEqual({ contactId: id, firstName: 'Pat', phone });
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
- RED: `w.contacts.getRecipientDisplaysByIds is not a function` on both
  halves; the (PIN) case passes.

GREEN: edit `app/src/repos/contactsRepo.ts`.

1. After the display type - replace

```ts
/** The only contact fields needed to label another record in staff UI. */
export interface ContactDisplayItem {
  contactId: string;
  firstName?: unknown;
  lastName?: unknown;
  phone?: string;
  deleted_at?: string;
}
```

with

```ts
/** The only contact fields needed to label another record in staff UI. */
export interface ContactDisplayItem {
  contactId: string;
  firstName?: unknown;
  lastName?: unknown;
  phone?: string;
  deleted_at?: string;
}

/**
 * A share recipient's label (spec 2026-10-06 D20/D22; plan 3.3): the display
 * fields plus the contact's `type` and `role`, so the units recipients route
 * can label a non-tenant row. A SECOND projection on purpose - the shared
 * display projection is not widened (R3-F4).
 */
export type RecipientDisplay = ContactDisplayItem & { type?: ContactType; role?: string };
```

2. Interface - replace

```ts
  getDisplaysByIds(contactIds: string[]): Promise<Map<string, ContactDisplayItem>>;
```

with

```ts
  getDisplaysByIds(contactIds: string[]): Promise<Map<string, ContactDisplayItem>>;
  /**
   * getDisplaysByIds plus `type` and `role` (plan 3.3) - for the units
   * recipients route ONLY (R3-F4). Missing ids are absent from the map.
   */
  getRecipientDisplaysByIds(contactIds: string[]): Promise<Map<string, RecipientDisplay>>;
```

3. The projection, right after the `DISPLAY_PROJECTION` object - replace

```ts
      '#phone': 'phone',
      '#deletedAt': 'deleted_at',
    },
  } as const;
```

with

```ts
      '#phone': 'phone',
      '#deletedAt': 'deleted_at',
    },
  } as const;

  /**
   * The recipient projection (plan 3.3; R3-F4): the display fields plus `type`
   * and `role` - both DynamoDB reserved words, hence placeholders.
   */
  const RECIPIENT_PROJECTION = {
    ProjectionExpression: '#contactId, #firstName, #lastName, #phone, #deletedAt, #type, #role',
    ExpressionAttributeNames: {
      ...DISPLAY_PROJECTION.ExpressionAttributeNames,
      '#type': 'type',
      '#role': 'role',
    },
  } as const;
```

4. The method - replace

```ts
    async getDisplaysByIds(contactIds) {
      return batchGetByIds<ContactDisplayItem>(contactIds, { projection: DISPLAY_PROJECTION });
    },
```

with

```ts
    async getDisplaysByIds(contactIds) {
      return batchGetByIds<ContactDisplayItem>(contactIds, { projection: DISPLAY_PROJECTION });
    },

    async getRecipientDisplaysByIds(contactIds) {
      return batchGetByIds<RecipientDisplay>(contactIds, { projection: RECIPIENT_PROJECTION });
    },
```

Edit `app/test/helpers/twilioWebhookHarness.ts`.

1. The contactsRepo import - replace

```ts
  type ContactsRepo,
} from '../../src/repos/contactsRepo.js';
```

with

```ts
  type ContactsRepo,
  type RecipientDisplay,
} from '../../src/repos/contactsRepo.js';
```

2. After `projectDisplay` - replace

```ts
  const contactsRepo: ContactsRepo = {
```

(after Task 2.2 this line is preceded by `fakeAllHolders`; it is still
unique) with

```ts
  /**
   * MODELS THE REAL RECIPIENT PROJECTION (plan 3.3): projectDisplay plus
   * `type` and `role` exactly as stored - nothing else, so a recipients caller
   * reading another attribute fails here as it would against DynamoDB. (A fake
   * pointer row would show its 'unknown' sentinel; recipients are never
   * pointer ids.)
   */
  const projectRecipient = (contact: ContactItem): RecipientDisplay => {
    const role = contact['role'];
    return {
      ...projectDisplay(contact),
      ...(typeof contact.type === 'string' && { type: contact.type }),
      ...(typeof role === 'string' && { role }),
    };
  };

  const contactsRepo: ContactsRepo = {
```

3. Replace

```ts
    async getManyByIds(contactIds) {
```

with

```ts
    async getRecipientDisplaysByIds(contactIds) {
      const wanted = new Set(contactIds);
      return new Map(
        contacts
          .filter((contact) => wanted.has(contact.contactId))
          .map((contact) => [contact.contactId, projectRecipient(contact)] as const),
      );
    },
    async getManyByIds(contactIds) {
```

Test fallout (typecheck): in EACH of the four full fakes
(`app/test/audienceResolution.test.ts`, `app/test/contactCapture.test.ts`,
`app/test/sendMessage.test.ts`, `app/test/scheduledSendSuppression.test.ts`)
replace (unique in each file)

```ts
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
```

with

```ts
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
    getRecipientDisplaysByIds: async () => {
      throw new Error('getRecipientDisplaysByIds: not used in this suite');
    },
```

Run the suite - GREEN. Then `cd "W:/tmp/caseworkers"; npm run typecheck` -
exit 0, and
`cd "W:/tmp/caseworkers/app"; npx vitest run test/audienceResolution.test.ts test/contactCapture.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts test/contactsRepo.integration.test.ts test/listingSendsApi.test.ts`
- unchanged and GREEN.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/repos/contactsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`,
`app/test/audienceResolution.test.ts`, `app/test/contactCapture.test.ts`,
`app/test/sendMessage.test.ts`, `app/test/scheduledSendSuppression.test.ts`;
message `feat(caseworkers): contactsRepo.getRecipientDisplaysByIds - a recipient projection with type and role (R3-F4)`
with the trailer.

### Task 2.4 - `conversationsRepo.setTypeIfCurrent` - the conditional re-type (D21; R1-F15; assembly ruling S1/S2-4)

Files: `app/src/repos/conversationsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`, and the three full
`ConversationsRepo` test fakes: `app/test/contactCapture.test.ts`,
`app/test/sendMessage.test.ts`, `app/test/scheduledSendSuppression.test.ts`
(the `as unknown as ConversationsRepo` casts in `groupConvert.test.ts` and
`importConvertGroups.test.ts` are unaffected).

RED: in `app/test/caseworkerRepoParity.integration.test.ts` replace the
marker line

```ts
// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

with

```ts
describe('conversationsRepo.setTypeIfCurrent (plan 3.3 as amended; D21)', () => {
  parity('re-types while the stored type is the expected one, writes the display name, and answers the fresh row', async (w) => {
    const phone = nextPhone();
    const conv = await w.conversations.createOrGetByParticipantPhone(phone, 'unknown_1to1');
    const result = await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', 'Pat Lee');
    expect(result.outcome).toBe('updated');
    if (result.outcome === 'updated') {
      expect(result.conversation).toMatchObject({
        conversationId: conv.conversationId,
        type: 'partner_1to1',
        participant_display_name: 'Pat Lee',
        participant_phone: phone,
      });
    }
    expect(await w.readConversation(conv.conversationId)).toMatchObject({
      type: 'partner_1to1',
      participant_display_name: 'Pat Lee',
      participant_phone: phone,
      status: 'open',
    });
  });

  parity('skips - writing nothing, never throwing - when the stored type is no longer the expected one', async (w) => {
    const conv = await w.conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    expect(
      await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', 'Pat Lee'),
    ).toEqual({ outcome: 'skipped' });
    const stored = await w.readConversation(conv.conversationId);
    expect(stored?.type).toBe('tenant_1to1');
    expect(stored).not.toHaveProperty('participant_display_name');
  });

  parity('a null displayName leaves the stored name untouched', async (w) => {
    const conv = await w.conversations.createOrGetByParticipantPhone(nextPhone(), 'unknown_1to1');
    await w.conversations.applyTriage(conv.conversationId, { displayName: 'Old Name' });
    const result = await w.conversations.setTypeIfCurrent(conv.conversationId, 'unknown_1to1', 'partner_1to1', null);
    expect(result.outcome).toBe('updated');
    expect(await w.readConversation(conv.conversationId)).toMatchObject({
      type: 'partner_1to1',
      participant_display_name: 'Old Name',
    });
  });

  parity('a type-less legacy row and a missing conversation both skip', async (w, id) => {
    await w.putConversation({
      conversationId: `${id}-legacy`,
      participant_phone: nextPhone(),
      status: 'open',
      last_activity_at: '2026-10-07T09:00:00.000Z',
      ai_mode: 'auto',
      created_at: '2026-10-07T09:00:00.000Z',
    });
    expect(
      await w.conversations.setTypeIfCurrent(`${id}-legacy`, 'unknown_1to1', 'partner_1to1', null),
    ).toEqual({ outcome: 'skipped' });
    expect(await w.readConversation(`${id}-legacy`)).not.toHaveProperty('type');
    expect(
      await w.conversations.setTypeIfCurrent(`${id}-missing`, 'unknown_1to1', 'partner_1to1', null),
    ).toEqual({ outcome: 'skipped' });
    expect(await w.readConversation(`${id}-missing`)).toBeUndefined();
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
- RED: `w.conversations.setTypeIfCurrent is not a function` on both halves.

GREEN: edit `app/src/repos/conversationsRepo.ts`.

1. The result type - replace

```ts
export interface ConversationsRepo {
```

with

```ts
/**
 * setTypeIfCurrent's answer (plan 3.3, as amended): the post-update row
 * (ALL_NEW - the conversation.updated event is built from it, as the PATCH
 * builds it from applyTriage's), or skipped.
 */
export type SetTypeIfCurrentResult =
  | { outcome: 'updated'; conversation: ConversationItem }
  | { outcome: 'skipped' };

export interface ConversationsRepo {
```

2. The interface - replace

```ts
  applyTriage(
    conversationId: string,
    fields: { type?: ConversationType; displayName?: string | null },
  ): Promise<ConversationItem>;
```

with

```ts
  applyTriage(
    conversationId: string,
    fields: { type?: ConversationType; displayName?: string | null },
  ): Promise<ConversationItem>;
  /**
   * Caseworkers (spec 2026-10-06 D21; plan 3.3): SET `type` to `next` - and
   * `participant_display_name` when `displayName` is a string (null leaves the
   * name untouched) - in ONE UpdateItem conditional on the stored type being
   * `expected`. A lost condition (the type changed since the caller's read, a
   * type-less legacy row, no such conversation) answers `{ outcome:
   * 'skipped' }` and never throws; success answers the ALL_NEW row.
   */
  setTypeIfCurrent(
    conversationId: string,
    expected: ConversationType,
    next: ConversationType,
    displayName: string | null,
  ): Promise<SetTypeIfCurrentResult>;
```

3. The implementation - replace

```ts
        'conversation triage applied',
      );
      return Attributes as ConversationItem;
    },
```

with

```ts
        'conversation triage applied',
      );
      return Attributes as ConversationItem;
    },

    async setTypeIfCurrent(conversationId, expected, next, displayName) {
      const names: Record<string, string> = { '#t': 'type' };
      const values: Record<string, unknown> = { ':expected': expected, ':next': next };
      const sets = ['#t = :next'];
      if (displayName !== null) {
        names['#dn'] = 'participant_display_name';
        values[':dn'] = displayName;
        sets.push('#dn = :dn');
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // `#t = :expected` also fails for a missing row and a type-less one,
            // so neither is ever created or typed here.
            ConditionExpression: '#t = :expected',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        // PII (doc section 9): the FACT of a name write, never the name.
        log.info(
          { conversationId, from: expected, to: next, nameSet: displayName !== null },
          'conversation type set (conditional)',
        );
        return { outcome: 'updated', conversation: Attributes as ConversationItem };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ conversationId, expected }, 'conversation type not set: stored type is not the expected one');
          return { outcome: 'skipped' };
        }
        throw err;
      }
    },
```

Edit `app/test/helpers/twilioWebhookHarness.ts` - the conversations fake.
Replace

```ts
      return conv;
    },
    async setMode(conversationId, mode) {
```

with

```ts
      return conv;
    },
    // Caseworkers (plan 3.3): mirror the real ConditionExpression
    // `#t = :expected` - a missing row or a type-less one skips, never throws -
    // then SET type and, when a string, the display name.
    async setTypeIfCurrent(conversationId, expected, next, displayName) {
      const conv = conversations.get(conversationId);
      if (!conv || conv.type !== expected) return { outcome: 'skipped' };
      conv.type = next;
      if (displayName !== null) conv.participant_display_name = displayName;
      return { outcome: 'updated', conversation: conv };
    },
    async setMode(conversationId, mode) {
```

Test fallout (typecheck) - the three full `ConversationsRepo` literals:

- `app/test/contactCapture.test.ts`: replace

```ts
    async applyTriage() {
      return conversation;
    },
```

with

```ts
    async applyTriage() {
      return conversation;
    },
    async setTypeIfCurrent() {
      throw new Error('setTypeIfCurrent: not used in this suite');
    },
```

- `app/test/scheduledSendSuppression.test.ts`: replace

```ts
    applyTriage: async () => conversation,
```

with

```ts
    applyTriage: async () => conversation,
    setTypeIfCurrent: async () => {
      throw new Error('setTypeIfCurrent: not used in this suite');
    },
```

- `app/test/sendMessage.test.ts`: replace

```ts
    touchLastActivity: async (_id, previewText, ts) => {
      if (overrides.touchError !== undefined) throw overrides.touchError;
```

with

```ts
    setTypeIfCurrent: async () => {
      throw new Error('setTypeIfCurrent: not used in this suite');
    },
    touchLastActivity: async (_id, previewText, ts) => {
      if (overrides.touchError !== undefined) throw overrides.touchError;
```

Run the suite - GREEN. Then `cd "W:/tmp/caseworkers"; npm run typecheck` -
exit 0, and
`cd "W:/tmp/caseworkers/app"; npx vitest run test/contactCapture.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts test/m14.integration.test.ts test/contactTriage.test.ts`
- unchanged and GREEN.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/repos/conversationsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`,
`app/test/contactCapture.test.ts`, `app/test/sendMessage.test.ts`,
`app/test/scheduledSendSuppression.test.ts`;
message `feat(caseworkers): conversationsRepo.setTypeIfCurrent - re-type only while the read type holds (D21)`
with the trailer.

### Task 2.5 - unit lists: FakeWorld `list` pages; `ListUnitsOpts.deleted: 'any'` (D22; R5-F17; assembly ruling S1/S2-3)

Files: `app/src/repos/unitsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`.

Today the fake `list` caps at `limit ?? 50` and never returns a
`lastEvaluatedKey`, so a caller's paging loop silently stops at 50 in tests
(R5-F17), and no unit read can return live and deleted units in one pass.
The fake `listByLandlord` / `listByProperty` keep their existing cap (no
cursor) - S3/S4 tests stay under 50 units per landlord; only `list` is the
roster scan.

RED: in `app/test/caseworkerRepoParity.integration.test.ts`:

1. The units import - replace

```ts
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../src/repos/unitsRepo.js';
```

with

```ts
import { createUnitsRepo, type UnitItem, type UnitsPage, type UnitsRepo } from '../src/repos/unitsRepo.js';
```

2. Replace the marker line

```ts
// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

with

```ts
const DELETED_AT = '2026-10-07T09:00:00.000Z';

function unitRow(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'contact-landlord-parity', status: 'available', ...extra };
}

/** Walk every page of a unit list - the caller-side cursor loop the roster refusal runs. */
async function walk(page: (cursor: Record<string, unknown> | undefined) => Promise<UnitsPage>): Promise<UnitItem[]> {
  const out: UnitItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const p = await page(cursor);
    out.push(...p.items);
    cursor = p.lastEvaluatedKey;
    pages += 1;
  } while (cursor !== undefined && pages < 1_000);
  return out;
}

/** This case's unit ids, sorted (the real table holds every real case's units). */
const mine = (units: UnitItem[], id: string): string[] =>
  units.map((u) => u.unitId).filter((unitId) => unitId.startsWith(`${id}-`)).sort();

describe('unit lists - paging and the deleted scope (plan 3.3 as amended)', () => {
  parity('a no-limit walk of list() returns EVERY live unit - no silent 50 cap', async (w, id) => {
    const ids = Array.from({ length: 55 }, (_, i) => `${id}-u${String(i).padStart(2, '0')}`);
    await Promise.all(ids.map((unitId) => w.putUnit(unitRow(unitId))));
    const seen = await walk((cursor) => w.units.list({ ...(cursor !== undefined && { exclusiveStartKey: cursor }) }));
    expect(mine(seen, id)).toEqual(ids);
  });

  parity('a limit-2 walk of list() follows the cursor to every live unit', async (w, id) => {
    const ids = [`${id}-a`, `${id}-b`, `${id}-c`, `${id}-d`, `${id}-e`];
    for (const unitId of ids) await w.putUnit(unitRow(unitId));
    const seen = await walk((cursor) =>
      w.units.list({ limit: 2, ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(seen, id)).toEqual(ids);
  });

  parity("list(): deleted 'any' returns live AND deleted; the default and true scopes are unchanged", async (w, id) => {
    await w.putUnit(unitRow(`${id}-live`));
    await w.putUnit(unitRow(`${id}-gone`, { deleted_at: DELETED_AT }));
    const scope = (deleted: boolean | 'any' | undefined) =>
      walk((cursor) =>
        w.units.list({
          ...(deleted !== undefined && { deleted }),
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        }),
      );
    expect(mine(await scope(undefined), id)).toEqual([`${id}-live`]);
    expect(mine(await scope(true), id)).toEqual([`${id}-gone`]);
    expect(mine(await scope('any'), id)).toEqual([`${id}-gone`, `${id}-live`]);
  });

  parity("listByLandlord: deleted 'any' returns the landlord's live AND deleted units", async (w, id) => {
    const landlordId = `${id}-landlord`;
    await w.putUnit(unitRow(`${id}-live`, { landlordId }));
    await w.putUnit(unitRow(`${id}-gone`, { landlordId, deleted_at: DELETED_AT }));
    await w.putUnit(unitRow(`${id}-other`, { landlordId: `${id}-someone-else` }));
    const any = await walk((cursor) =>
      w.units.listByLandlord(landlordId, { deleted: 'any', ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(any, id)).toEqual([`${id}-gone`, `${id}-live`]);
    const live = await walk((cursor) =>
      w.units.listByLandlord(landlordId, { ...(cursor !== undefined && { exclusiveStartKey: cursor }) }),
    );
    expect(mine(live, id)).toEqual([`${id}-live`]);
  });
});

// END OF PARITY CASES - Tasks 2.2-2.5 insert their describe blocks ABOVE this line.
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
- RED: [harness fake] "a no-limit walk" sees 50 of 55, "a limit-2 walk"
  sees 2 of 5 (no cursor), and both `'any'` cases see only the live unit
  (the fake reads anything but `true` as live-only). [DynamoDB Local] the
  two `'any'` cases see only the live unit (the FilterExpression is
  `attribute_not_exists`); the two walk cases already pass for real (they
  pin the real contract the fake must meet). `npm run typecheck` is also
  RED: `'any'` is not assignable to `boolean | undefined`.

GREEN: edit `app/src/repos/unitsRepo.ts`.

1. The option - replace

```ts
  deleted?: boolean;
}

/** The fields a staff-facing property label needs (the All tab's name map). */
```

with

```ts
  //
  // 'any' (caseworkers, plan 3.3 as amended): NO soft-delete filter - live
  // and deleted units in one read. The caseworker conversion's
  // landlord-of-record and roster refusals count deleted properties (spec
  // 2026-10-06 D22: a restored property must not come back with a
  // caseworker on it).
  deleted?: boolean | 'any';
}

/**
 * The soft-delete FilterExpression (over `#del` = deleted_at) for a
 * ListUnitsOpts scope: live only (omitted/false), deleted only (true), or none
 * ('any' - and then the caller must not send the `#del` name either: DynamoDB
 * rejects an unused ExpressionAttributeNames entry).
 */
function deletedScopeFilter(deleted: ListUnitsOpts['deleted']): string | undefined {
  if (deleted === 'any') return undefined;
  return deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)';
}

/** The fields a staff-facing property label needs (the All tab's name map). */
```

2. `queryIndex` - replace

```ts
    opts: ListUnitsOpts,
  ): Promise<UnitsPage> {
    const input: QueryCommandInput = {
```

with

```ts
    opts: ListUnitsOpts,
  ): Promise<UnitsPage> {
    const scopeFilter = deletedScopeFilter(opts.deleted);
    const input: QueryCommandInput = {
```

and replace

```ts
      FilterExpression: opts.deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)',
      ExpressionAttributeNames: { '#k': keyName, '#del': 'deleted_at' },
```

with

```ts
      // deleted:'any' sends neither the filter nor its #del name.
      ...(scopeFilter !== undefined && { FilterExpression: scopeFilter }),
      ExpressionAttributeNames: { '#k': keyName, ...(scopeFilter !== undefined && { '#del': 'deleted_at' }) },
```

3. `list` - replace

```ts
      const input: ScanCommandInput = {
        TableName: table,
        // Soft-delete scope: default excludes deleted; deleted:true shows only them.
        FilterExpression: opts.deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)',
        ExpressionAttributeNames: { '#del': 'deleted_at' },
```

with

```ts
      const scopeFilter = deletedScopeFilter(opts.deleted);
      const input: ScanCommandInput = {
        TableName: table,
        // Soft-delete scope: default excludes deleted; deleted:true shows only
        // them; deleted:'any' scans with no filter (and no #del name).
        ...(scopeFilter !== undefined && {
          FilterExpression: scopeFilter,
          ExpressionAttributeNames: { '#del': 'deleted_at' },
        }),
```

Edit `app/test/helpers/twilioWebhookHarness.ts`.

1. The unitsRepo import - replace

```ts
  LandlordReassignmentRequiredError,
  unitContacts,
```

with

```ts
  LandlordReassignmentRequiredError,
  type ListUnitsOpts,
  unitContacts,
```

2. The scope helper - replace

```ts
  const units = new Map<string, UnitItem>();
  let unitCounter = 0;
```

with

```ts
  const units = new Map<string, UnitItem>();
  let unitCounter = 0;
  /**
   * The ListUnitsOpts soft-delete scope, as the real FilterExpression applies
   * it: live only (omitted/false), deleted only (true), both ('any').
   */
  const inDeletedScope = (u: UnitItem, scope: ListUnitsOpts['deleted']): boolean => {
    if (scope === 'any') return true;
    return scope === true ? isUnitDeleted(u) : !isUnitDeleted(u);
  };
```

3. `list` FIRST (its old text still carries the old filter) - replace

```ts
    async list(opts = {}) {
      const items = [...units.values()]
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
```

with

```ts
    async list(opts = {}) {
      // The real paginated Scan's contract (plan 3.3; R5-F17): resume after
      // the cursor's unitId, return at most `limit` items, and emit a
      // lastEvaluatedKey only when more remain. No limit returns EVERY unit in
      // scope - the old silent 50 cap stopped a caller's paging loop at 50.
      const all = [...units.values()].filter((u) => inDeletedScope(u, opts.deleted));
      let start = 0;
      const cursorId = opts.exclusiveStartKey?.['unitId'];
      if (typeof cursorId === 'string') {
        const idx = all.findIndex((u) => u.unitId === cursorId);
        if (idx >= 0) start = idx + 1;
      }
      const window = opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
      const last = window[window.length - 1];
      const hasMore = opts.limit !== undefined && start + opts.limit < all.length;
      return {
        items: window.map((u) => ({ ...u })),
        ...(hasMore &&
          last !== undefined && {
            lastEvaluatedKey: { unitId: last.unitId } as Record<string, unknown>,
          }),
      };
    },
```

4. THEN, with replace-all, replace every remaining

```ts
(u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u))
```

with

```ts
(u) => inDeletedScope(u, opts.deleted)
```

(three occurrences: `listByLandlord`, `listByStatus`, `listByProperty` of
the units fake; `grep -n "opts.deleted === true" app/test/helpers/twilioWebhookHarness.ts`
then prints nothing).

Run the suite - GREEN, both halves. Then `cd "W:/tmp/caseworkers"; npm run
typecheck` - exit 0. Regression (the units list route pages through the
fake; orgRecords scans every unit):
`cd "W:/tmp/caseworkers/app"; npx vitest run test/unitsApi.test.ts test/unitsRepo.integration.test.ts test/orgRecords.test.ts test/orgRecordWriters.integration.test.ts`
- unchanged and GREEN.

Commit: `git -C "W:/tmp/caseworkers" status`, then stage
`app/src/repos/unitsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/caseworkerRepoParity.integration.test.ts`;
message `feat(caseworkers): unit lists take deleted 'any'; the harness unit list pages like the real Scan`
with the trailer.

S2 exit check: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerRepoParity.integration.test.ts`
reports every case twice (fake and DynamoDB Local) with DynamoDB Local up,
none skipped; `npm run typecheck` exit 0.

## S3 - services: the caseworker conversion and the possible-caseworkers read

Spec D16, D19, D21, D22; planner rulings R1-F1 ... R1-F15, R2-F7; plan 3.2,
3.3, 3.4. Files: `app/src/services/contactClassification.ts` (new, 3.1),
`app/src/routes/contacts.ts` (3.1 only - the helper extraction),
`app/src/services/caseworkerConversion.ts` (new, 3.2-3.7),
`app/src/services/possibleCaseworkers.ts` (new, 3.8), and the
tests named per task.

The PATCH side effects the conversion reproduces, and how (line numbers at
the base; match the quoted text, never the number):

| PATCH effect (`app/src/routes/contacts.ts`) | conversion step | how |
|---|---|---|
| per-field conditional delete + verdict stamp, `:1678-1706` | 2 (every non-type pending suggestion, verdict `superseded_by_human_edit`) | EXTRACT `supersedePendingSuggestion` (Task 3.1); both call it |
| revision-guarded type drain, `:1713-1793` | 2 (the type suggestion; `canonicalSuggestedContactKind(converted)`) | EXTRACT `drainTypeSuggestion` (Task 3.1); both call it |
| `suggestion.updated` emit, `:1795-1797` | 4 | one inline `events.emit` (a one-liner; no helper) |
| `displayNameOf` + the thread name denorm, `:484-494`, `:1848`, `:1880-1885` | 3 | EXTRACT `displayNameOf` (Task 3.1); the type+name write is `setTypeIfCurrent` (S2), NOT `applyTriage` (unconditional, `conversationsRepo.ts:1516-1561`) |
| `conversation.updated` per touched thread, `:1886` | 3 | inline `toConversationUpdatedEvent` on the re-typed row |
| `contact_updated` audit, `:1906-1910` | 4 | inline; the payload differs (names the conversion, carries `caseworker_conversion`) |
| `contact_status_changed` milestone, `:1916-1934` | 4 | inline, labelled by the NEW type (R1-F12) - NOT shared, because the PATCH labels by the STORED type and keeps doing so |
| role vocabulary add, `:1942-1959` | 4 | inline `vocabulary.add({ roles: [CASEWORKER_ROLE] })` |
| D5 org check loop, `:1564-1582` | rule 4 | CALL `orgNames.checkScalar('organization', ...)` (the service the loop calls), not the route loop |
| provenance clear, `:1611-1615` | - | NOT reproduced: the commit REMOVEs `housingAuthority_source` itself; `type`/`role` are not provenance fields |
| triage re-extraction, `:1893-1903` | - | NOT reproduced (tenant flips only; a partner is never extracted) |
| voucher sync, `:1805-1838`; consent and staff-notes stamps | - | NOT reproduced (the conversion writes none of those fields) |

Step 0 for EVERY S3 task (S1 and S2 deliver these; verify, never
re-create - any mismatch: STOP and report):

1. `grep -n "export const CASEWORKER_ROLE = 'Caseworker';" "W:/tmp/caseworkers/app/src/services/extraction/contactKinds.ts"` prints one line.
2. `grep -n "export function isCaseworker\b\|export function mentionsCaseworker\|export function hasAiCaseworkerNote\|export type PossibleSignal" "W:/tmp/caseworkers/app/src/lib/caseworkers.ts"` prints four lines.
3. `grep -n "organization: \['housing_authority', 'agency'\]" "W:/tmp/caseworkers/app/src/lib/orgNames.ts"` prints one line (`KINDS_FOR_FIELD.organization`), and `OrgField` includes `'organization'`.
4. `app/src/repos/contactsRepo.ts` exports `CaseworkerConversionRecord`; `ContactItem` has `organization?`, `caseworker_review?`, `caseworker_conversion?`, `type_source?`; `UpdateContactOptions` has `expect?: ExpectClause | ExpectClause[]` and `notDeleted?: true`; the `ContactsRepo` interface has `findAllByPhone` and `findAllByEmail`.
5. The `ConversationsRepo` interface has `setTypeIfCurrent(conversationId, expected, next, displayName)` returning `SetTypeIfCurrentResult` (`{ outcome: 'updated'; conversation } | { outcome: 'skipped' }`), and the FakeWorld implements it, `findAllByPhone`/`findAllByEmail`, and the multi-clause `expect` + `notDeleted`.
6. `ListUnitsOpts.deleted` accepts `'any'` and the FakeWorld units fake honors it in `listByLandlord` and `list`: `grep -n "'any'" "W:/tmp/caseworkers/app/src/repos/unitsRepo.ts"` prints the option and its filter handling.

### Task 3.1 - move the PATCH's classification side effects into `services/contactClassification.ts` (assembly ruling S3/S4-2)

A refactor with a real RED (the new module's own tests) and the PATCH's
existing pins as the safety net: `app/test/aiRunVerdicts.test.ts`
("verdict write-back - surface 2: the contacts PATCH", the drain cases incl.
the PM role-only and racing-replacement cases) and
`app/test/contactTriage.test.ts` must stay green UNCHANGED.

RED: create `app/test/contactClassification.test.ts`:

```ts
// The contacts PATCH's classification side effects, moved to
// services/contactClassification.ts so the caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19 steps 2-3) calls the SAME code: the display-name denorm, the exact-identity
// delete + verdict stamp, and the revision-guarded type drain.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { AiRunsRepo } from '../src/repos/aiRunsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  displayNameOf,
  drainTypeSuggestion,
  supersedePendingSuggestion,
} from '../src/services/contactClassification.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const ACTOR = 'usr_testva00000000000000000';
const AT = '2026-10-07T12:00:00.000Z';

function setup() {
  const world = createFakeWorld();
  const setVerdict = vi.fn<AiRunsRepo['setVerdict']>(async () => true);
  world.aiRuns.setVerdict = setVerdict;
  const log = createLogger({ level: 'info', destination: createLogCapture().stream });
  return { world, setVerdict, deps: { extraction: world.extractionRepo, aiRuns: world.aiRuns, log } };
}

describe('displayNameOf', () => {
  it('joins the trimmed parts, and answers null when no name is known', () => {
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: ' Ana ', lastName: 'Ruiz  ' })).toBe('Ana Ruiz');
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: 'Ana' })).toBe('Ana');
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: '  ', lastName: '' })).toBeNull();
  });
});

describe('supersedePendingSuggestion', () => {
  it('deletes the exact identity it was handed and stamps the verdict on its run', async () => {
    const { world, setVerdict, deps } = setup();
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'pets', pending: item, verdict: 'superseded_by_human_edit', verdictAt: AT, actor: ACTOR,
    });
    expect(deleted).toBe(true);
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'superseded_by_human_edit', {
      at: AT, expectedVerdict: 'pending', freshSuggestionCreatedAt: item.createdAt, by: ACTOR,
    });
  });

  it('leaves a replaced suggestion pending and unstamped', async () => {
    const { world, setVerdict, deps } = setup();
    const { item: old } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-1', runId: 'run-2',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'pets', pending: old, verdict: 'superseded_by_human_edit', verdictAt: AT, actor: ACTOR,
    });
    expect(deleted).toBe(false);
    expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-2');
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('deletes a suggestion on a non-decision target without stamping a verdict', async () => {
    const { world, setVerdict, deps } = setup();
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'lifEligible', suggestedValue: 'true', conversationId: 'conv-1', runId: 'run-1',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'lifEligible', pending: item, verdict: 'superseded_by_human_edit', verdictAt: AT,
    });
    expect(deleted).toBe(true);
    expect(setVerdict).not.toHaveBeenCalled();
  });
});

describe('drainTypeSuggestion', () => {
  function committedPartner(world: ReturnType<typeof createFakeWorld>, over: Partial<ContactItem> = {}): ContactItem {
    const c: ContactItem = { contactId: 'c1', type: 'partner', status: 'active', classification_revision: 1, ...over };
    world.contacts.push(c);
    return c;
  }

  it('records accepted when the pre-write identity equals the committed kind', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world);
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 0,
    });
    const changed = await drainTypeSuggestion(deps, {
      contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT, actor: ACTOR,
    });
    expect(changed).toBe(true);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-t', 'type', 'accepted', expect.objectContaining({ at: AT, by: ACTOR }));
  });

  it('records superseded_by_human_edit when the committed kind differs', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world, { type: 'landlord' });
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 0,
    });
    expect(await drainTypeSuggestion(deps, { contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT })).toBe(true);
    expect(setVerdict).toHaveBeenCalledWith('run-t', 'type', 'superseded_by_human_edit', expect.anything());
  });

  it('leaves a suggestion written at or after the committed revision', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world);
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 1,
    });
    expect(await drainTypeSuggestion(deps, { contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT })).toBe(false);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeDefined();
    expect(setVerdict).not.toHaveBeenCalled();
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactClassification.test.ts`
- RED: the module `../src/services/contactClassification.js` does not exist
  (import resolution fails).

GREEN, part 1 - create `app/src/services/contactClassification.ts`:

```ts
// The contacts PATCH's classification side effects, shared with the
// caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19 step 2: "the PATCH's existing revision-guarded type drain"; step 3: the
// display-name denorm). MOVED from routes/contacts.ts with identical behavior
// and log lines; routes/contacts.ts (PATCH) and
// services/caseworkerConversion.ts both call these. Best-effort by design:
// every failure is logged at warn and reported as "nothing changed".
import type { Logger } from '../lib/logger.js';
import type { AiRunsRepo } from '../repos/aiRunsRepo.js';
import { contactClassificationRevision, type ContactItem } from '../repos/contactsRepo.js';
import {
  sameSuggestionIdentity,
  type ExtractionRepo,
  type GuardedTypeDeleteResult,
  type SuggestionItem,
} from '../repos/extractionRepo.js';
import { canonicalSuggestedContactKind } from './extraction/contactKinds.js';
import { isDecisionTarget, type Verdict } from './extraction/runTypes.js';
import { normalizeSuggestionValue } from './extraction/schema.js';

/**
 * The denormalized inbox display name from a contact's resolved fields:
 * `firstName`/`lastName` joined and trimmed -> a non-empty string, else null.
 * HONEST: returns null when no name is known - the inbox falls back to the
 * phone; a name is NEVER invented. PII (doc section 9): the name is data, never
 * logged here.
 */
export function displayNameOf(contact: ContactItem): string | null {
  // Part-wise trim BEFORE the join: a legacy padded part ("Cameron   ") must
  // never render an interior gap ("Cameron   Abt"). New writes arrive trimmed
  // (trimJsonBody), but stored data predating it may not be.
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : null;
}

export interface SuggestionEffectDeps {
  extraction: ExtractionRepo;
  aiRuns: AiRunsRepo;
  log: Logger;
}

/**
 * Delete exactly the pending suggestion identity the caller read, then stamp
 * `verdict` on its run's decision (only for a decision target with a run).
 * Returns whether the suggestion was deleted. A suggestion created or replaced
 * since the read stays pending and unstamped.
 */
export async function supersedePendingSuggestion(
  deps: SuggestionEffectDeps,
  input: {
    contactId: string;
    target: string;
    pending: SuggestionItem;
    verdict: Verdict;
    verdictAt: string;
    actor?: string;
  },
): Promise<boolean> {
  const { contactId, target, pending, verdict, verdictAt, actor } = input;
  let deleted = false;
  try {
    deleted = await deps.extraction.deleteSuggestionIfCurrent(
      contactId, target, pending.createdAt, pending.runId, pending.revision,
    );
  } catch (err) {
    deps.log.warn({ err, contactId, field: target }, 'extraction conditional delete (human edit) failed (best-effort)');
  }
  if (!deleted || pending.runId === undefined || !isDecisionTarget(target)) return deleted;
  try {
    await deps.aiRuns.setVerdict(pending.runId, target, verdict, {
      at: verdictAt, expectedVerdict: 'pending',
      freshSuggestionCreatedAt: pending.createdAt,
      ...(actor !== undefined && { by: actor }),
    });
  } catch (err) {
    deps.log.warn({ err, contactId, field: target }, 'ai run verdict stamp failed (best-effort)');
  }
  return deleted;
}
```

then append `drainTypeSuggestion`: the BODY of the PATCH's current
`if (changesKind) { ... }` drain block (`app/src/routes/contacts.ts`, from
`      const committedRevision = contactClassificationRevision(updated);` through
`        log.warn({ contactId }, 'type suggestion drain exhausted bounded retries');`
and its closing `      }`), moved VERBATIM with exactly these renames: `updated` ->
`committed`; `extraction` -> `deps.extraction`; `aiRuns` -> `deps.aiRuns`;
`log` -> `deps.log`; `suggestionStateChanged = true;` -> `changed = true;`;
`...(req.user?.userId !== undefined && { by: req.user.userId }),` ->
`...(actor !== undefined && { by: actor }),`. The wrapper:

```ts
/**
 * The revision-guarded type drain (frozen design 7.3). A type suggestion is
 * judged against the COMPLETE committed kind (`canonicalSuggestedContactKind`),
 * not a request field: Property Manager is landlord plus an exact role, and the
 * caseworker preset is partner plus an exact role. Drains a bounded number of
 * older rows so a replacement racing the contact write cannot remain
 * actionable for an already-committed classification. `accepted` only for the
 * identity read BEFORE the write whose value equals the committed kind.
 * Returns whether any suggestion state changed.
 */
export async function drainTypeSuggestion(
  deps: SuggestionEffectDeps,
  input: {
    contactId: string;
    committed: ContactItem;
    pendingTypeBefore: SuggestionItem | undefined;
    verdictAt: string;
    actor?: string;
  },
): Promise<boolean> {
  const { contactId, committed, pendingTypeBefore, verdictAt, actor } = input;
  let changed = false;
  // <the moved body, renamed as above - it declares committedRevision,
  //  appliedKind, candidate, exhausted, the `for (let attempt = 0; attempt < 4;
  //  attempt += 1)` loop, and the exhausted warn>
  return changed;
}
```

(The moved body uses `GuardedTypeDeleteResult`, `sameSuggestionIdentity`,
`normalizeSuggestionValue`, `canonicalSuggestedContactKind` and
`contactClassificationRevision` - all imported above. Do not leave the
placeholder comment in the file.)

GREEN, part 2 - `app/src/routes/contacts.ts` calls them:

1. Imports. Current:

```ts
import {
  createExtractionRepo,
  sameSuggestionIdentity,
  type GuardedTypeDeleteResult,
  type ExtractionRepo,
  type SuggestionItem,
} from '../repos/extractionRepo.js';
```

   Replace with:

```ts
import {
  createExtractionRepo,
  type ExtractionRepo,
  type SuggestionItem,
} from '../repos/extractionRepo.js';
```

   Delete the line `  contactClassificationRevision,` from the `../repos/contactsRepo.js`
   import block; delete the two lines
   `import { isDecisionTarget } from '../services/extraction/runTypes.js';` and
   `import { canonicalSuggestedContactKind } from '../services/extraction/contactKinds.js';`;
   and insert, after `import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';`:

```ts
import {
  displayNameOf,
  drainTypeSuggestion,
  supersedePendingSuggestion,
} from '../services/contactClassification.js';
```

2. Delete the router-local `displayNameOf` (its whole doc comment starting
   `/**` / ` * The denormalized inbox display name from a contact's resolved fields:`
   through the function's closing `}` after `  return joined.length > 0 ? joined : null;`).
   Its three call sites (the PATCH, POST `/:contactId/conversation`, POST
   `/:contactId/email-conversation`) now resolve to the import.

3. The per-field loop. Current (the PATCH, after the guarded update's
   `catch`):

```ts
    // Resolve only identities retained before contacts.update. A suggestion
    // created or replaced during the update remains pending and unstamped.
    const verdictAt = new Date().toISOString();
    let suggestionStateChanged = false;
    for (const [f, pending] of pendingByField) {
      let deleted = false;
      try {
        deleted = await extraction.deleteSuggestionIfCurrent(contactId, f, pending.createdAt, pending.runId, pending.revision);
      } catch (err) {
        log.warn({ err, contactId, field: f }, 'extraction conditional delete (human edit) failed (best-effort)');
      }
      if (deleted) suggestionStateChanged = true;
      if (!deleted || pending.runId === undefined || !isDecisionTarget(f)) continue;
```

   ... through the loop's end:

```ts
      } catch (err) {
        log.warn({ err, contactId, field: f }, 'ai run verdict stamp failed (best-effort)');
      }
    }
```

   Replace that whole loop (from the `// Resolve only identities` comment to
   the loop's closing `    }`) with:

```ts
    // Resolve only identities retained before contacts.update. A suggestion
    // created or replaced during the update remains pending and unstamped.
    // The delete + verdict stamp is shared with the caseworker conversion
    // (services/contactClassification.ts).
    const verdictAt = new Date().toISOString();
    const suggestionDeps = { extraction, aiRuns, log };
    const actor = req.user?.userId;
    let suggestionStateChanged = false;
    for (const [f, pending] of pendingByField) {
      // The value comparison is CONFINED to `type` (frozen design 7.3): a human
      // triaging a contact to `landlord` after the model suggested `tenant` has
      // REJECTED that suggestion, so `type` must be judged on VALUE. For the
      // other eleven targets a PATCH is a human edit that supersedes the
      // suggestion regardless of value - generalizing the equality rule would
      // record edits that merely coincide with the model as acceptances and
      // corrupt the accuracy record this feature exists to produce.
      const verdict = f === 'type' && suggestionMatchesAppliedValue(pending, parsed.patch[f])
        ? 'accepted'
        : 'superseded_by_human_edit';
      const deleted = await supersedePendingSuggestion(suggestionDeps, {
        contactId, target: f, pending, verdict, verdictAt,
        ...(actor !== undefined && { actor }),
      });
      if (deleted) suggestionStateChanged = true;
    }
```

4. The drain. Current - from

```ts
    if (changesKind) {
      const committedRevision = contactClassificationRevision(updated);
      const appliedKind = canonicalSuggestedContactKind(updated);
```

   through

```ts
      if (exhausted) {
        log.warn({ contactId }, 'type suggestion drain exhausted bounded retries');
      }
    }
```

   (keep the five-line `// A type suggestion is judged against the COMPLETE
   persisted kind, not` comment above it). Replace with:

```ts
    if (changesKind) {
      const drained = await drainTypeSuggestion(suggestionDeps, {
        contactId, committed: updated, pendingTypeBefore, verdictAt,
        ...(actor !== undefined && { actor }),
      });
      if (drained) suggestionStateChanged = true;
    }
```

5. Check nothing else in the file used the removed names:
   `grep -n "sameSuggestionIdentity\|GuardedTypeDeleteResult\|contactClassificationRevision\|canonicalSuggestedContactKind\|isDecisionTarget" "W:/tmp/caseworkers/app/src/routes/contacts.ts"`
   prints nothing. (A name `actor` already declared later in the PATCH
   handler would collide: `grep -n "const actor" ` in the PATCH body first;
   at the base there is none.)

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactClassification.test.ts test/aiRunVerdicts.test.ts test/contactTriage.test.ts test/contactStaffNotes.test.ts test/suggestions.test.ts test/contactsCrud.test.ts`
- GREEN, with every pre-existing case unchanged.

Then `cd "W:/tmp/caseworkers"; npm run typecheck` (exit 0) and
`cd "W:/tmp/caseworkers"; npx eslint app/src/routes/contacts.ts app/src/services/contactClassification.ts app/test/contactClassification.test.ts`
- no error that is absent at the merge base (gate-5 baseline rule).

Commit (stage `app/src/services/contactClassification.ts`,
`app/src/routes/contacts.ts`, `app/test/contactClassification.test.ts`)
`refactor(contacts): share the PATCH's suggestion drain and display name with the conversion (D19)`.

### Task 3.2 - `caseworkerConversion.ts`: types, the domain, the refusals, the preview's removes

Step 0 as above, plus Task 3.1 committed.

RED: create `app/test/caseworkerConversion.test.ts` (later S3 tasks append
`describe` blocks to it):

```ts
// The caseworker conversion service (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D19, D21, D22; plan 3.4) on the FakeWorld. The harness org-list fake
// serves the starting list (spec Appendix A) on its first read. FakeWorld
// reads return the LIVE stored objects, so a test can change a record
// "between" the service's read and its write by wrapping a repo method.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { emailRefId, phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  CaseworkerReviewError,
  createCaseworkerConversionService,
} from '../src/services/caseworkerConversion.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ACTOR = 'usr_testva00000000000000000';
const NOW = '2026-10-07T12:00:00.000Z';
const ID = 'c-cw-1';
const PHONE = '+15550107001';

function setup() {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const service = createCaseworkerConversionService({
    contacts: world.contactsRepo,
    conversations: world.conversationsRepo,
    placements: world.placementsRepo,
    tours: world.toursRepo,
    units: world.unitsRepo,
    extraction: world.extractionRepo,
    aiRuns: world.aiRuns,
    audit: world.auditRepo,
    activityEvents: world.activityEventsRepo,
    vocabulary: world.vocabularyRepo,
    events: world.events,
    orgNames: createOrgNamesService({ orgListRepo: world.orgListRepo, logger }),
    logger,
    now: () => new Date(NOW),
  });
  return { world, service, capture };
}

function seed(world: FakeWorld, over: Partial<ContactItem> = {}): ContactItem {
  const c = {
    contactId: ID,
    type: 'tenant',
    status: 'onboarding',
    phone: PHONE,
    firstName: 'Ana',
    lastName: 'Ruiz',
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  } as ContactItem;
  world.contacts.push(c);
  return c;
}

function stored(world: FakeWorld, contactId = ID): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === contactId);
}

function placement(world: FakeWorld, placementId: string, stage: string, tenantId = ID): void {
  world.placements.set(placementId, {
    placementId, tenantId, unitId: 'unit-p', stage,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  } as PlacementItem);
}

function tour(world: FakeWorld, tourId: string, status: string, tenantId = ID): void {
  world.toursMap.set(tourId, {
    tourId, tenantId, unitId: 'unit-t', tourType: 'self_guided', status,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  } as TourItem);
}

function unit(world: FakeWorld, unitId: string, over: Partial<UnitItem> = {}): void {
  world.units.set(unitId, { unitId, status: 'available', ...over } as UnitItem);
}

/** Await a promise that must reject with a CaseworkerReviewError. */
async function refused(p: Promise<unknown>): Promise<CaseworkerReviewError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CaseworkerReviewError) return err;
    throw err;
  }
  throw new Error('expected a CaseworkerReviewError');
}

describe('the domain (rule 1, D22): who can be previewed', () => {
  it('answers 404 contact_not_found for a missing id', async () => {
    const { service } = setup();
    const err = await refused(service.preview('c-nope'));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
  });

  it('answers 404 for a phone pointer id and an email pointer id (the fake sentinel type must not hide them)', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-owner', phone: '+15550107090', email: 'owner@example.org' });
    await world.contactsRepo.addPhone('c-owner', { phone: '+15550107098' });
    await world.contactsRepo.addEmail('c-owner', { email: 'second@example.org' });
    for (const id of [phoneRefId('+15550107098'), emailRefId('second@example.org')]) {
      expect(stored(world, id), id).toBeDefined();
      const err = await refused(service.preview(id));
      expect([err.status, err.code], id).toEqual([404, 'contact_not_found']);
    }
  });

  it('answers 404 for a row whose type is not a ContactType, and for a soft-deleted contact', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-odd', type: 'vendor' as ContactItem['type'] });
    seed(world, { contactId: 'c-gone', deleted_at: '2026-10-05T00:00:00.000Z' });
    for (const id of ['c-odd', 'c-gone']) {
      const err = await refused(service.preview(id));
      expect([err.status, err.code], id).toEqual([404, 'contact_not_found']);
    }
  });

  it('answers 400 caseworker_team_member for a team member', async () => {
    const { world, service } = setup();
    seed(world, { type: 'team_member', status: 'active' });
    const err = await refused(service.preview(ID));
    expect([err.status, err.code]).toEqual([400, 'caseworker_team_member']);
  });

  it('previews an unknown, a tenant, a landlord and a role-less partner', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-u', type: 'unknown', status: 'needs_review' });
    seed(world, { contactId: 'c-t' });
    seed(world, { contactId: 'c-l', type: 'landlord', status: 'interested' });
    seed(world, { contactId: 'c-p', type: 'partner', status: 'active' });
    for (const id of ['c-u', 'c-t', 'c-l', 'c-p']) {
      const p = await service.preview(id);
      expect(p, id).toMatchObject({ contactId: id, alreadyCaseworker: false, refusals: [] });
    }
  });
});

describe('the refusals (rule 3, D19, D22), checked whatever the stored type', () => {
  it('refuses an open placement and an open tour; terminal placements and resolved tours do not count', async () => {
    const { world, service } = setup();
    seed(world);
    placement(world, 'pl-open', 'awaiting_inspection');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    tour(world, 'tr-req', 'requested');
    tour(world, 'tr-sch', 'scheduled');
    tour(world, 'tr-tou', 'toured');
    tour(world, 'tr-ns', 'no_show');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    const p = await service.preview(ID);
    expect(p.refusals).toEqual([
      { code: 'caseworker_open_placement', placementId: 'pl-open' },
      { code: 'caseworker_open_tour', tourId: 'tr-ns' },
      { code: 'caseworker_open_tour', tourId: 'tr-req' },
      { code: 'caseworker_open_tour', tourId: 'tr-sch' },
      { code: 'caseworker_open_tour', tourId: 'tr-tou' },
    ]);
  });

  it('refuses the landlord of record and a roster seat, soft-deleted units included, one entry per unit', async () => {
    const { world, service } = setup();
    seed(world, { type: 'landlord', status: 'active' });
    unit(world, 'u-ll-live', { landlordId: ID });
    unit(world, 'u-ll-gone', { landlordId: ID, deleted_at: '2026-10-05T00:00:00.000Z' });
    unit(world, 'u-ros-live', {
      landlordId: 'c-someone',
      contacts: [
        { contactId: 'c-someone', role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    unit(world, 'u-ros-gone', {
      landlordId: 'c-someone',
      contacts: [{ contactId: ID, role: 'other', primaryContact: true }],
      deleted_at: '2026-10-05T00:00:00.000Z',
    });
    unit(world, 'u-other', { landlordId: 'c-someone' });
    const p = await service.preview(ID);
    expect(p.refusals).toEqual([
      { code: 'caseworker_landlord_of_record', unitId: 'u-ll-gone' },
      { code: 'caseworker_landlord_of_record', unitId: 'u-ll-live' },
      { code: 'caseworker_on_roster', unitId: 'u-ros-gone' },
      { code: 'caseworker_on_roster', unitId: 'u-ros-live' },
    ]);
  });

  it('checks a partner too (an open tour as the tenant), and lists every kind in order', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active' });
    unit(world, 'u-1', { landlordId: ID });
    tour(world, 'tr-1', 'scheduled');
    placement(world, 'pl-1', 'send_application');
    const p = await service.preview(ID);
    expect(p.refusals.map((r) => r.code)).toEqual([
      'caseworker_open_placement',
      'caseworker_open_tour',
      'caseworker_landlord_of_record',
    ]);
  });
});

describe('the preview (rule 9): what the conversion removes', () => {
  it('names the housing authority, the agency and the pending suggestion count', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority', agency: 'Step Up' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-x' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'conv-x' });
    const p = await service.preview(ID);
    expect(p.removes).toEqual({ housingAuthority: 'Atlanta Housing Authority', agency: 'Step Up', pendingSuggestions: 2 });
  });

  it("omits an empty agency and an absent authority", async () => {
    const { world, service } = setup();
    seed(world, { agency: '' });
    expect((await service.preview(ID)).removes).toEqual({ pendingSuggestions: 0 });
  });

  it('a contact already a caseworker: alreadyCaseworker, no refusals (make runs only steps 2-4), removes only suggestions', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active', role: 'Caseworker', housingAuthority: 'Atlanta Housing Authority' });
    tour(world, 'tr-1', 'scheduled');
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-x' });
    const p = await service.preview(ID);
    expect(p).toMatchObject({ alreadyCaseworker: true, refusals: [], removes: { pendingSuggestions: 1 } });
    expect(p.removes).not.toHaveProperty('housingAuthority');
  });

  it('writes nothing', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority' });
    const before = structuredClone(stored(world));
    await service.preview(ID);
    expect(stored(world)).toEqual(before);
    expect(world.auditEvents).toEqual([]);
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerConversion.test.ts`
- RED: `../src/services/caseworkerConversion.js` does not exist.

GREEN - create `app/src/services/caseworkerConversion.ts`. The organization
and thread functions are stubs here (Tasks 3.3 and 3.4 fill them), and
`make` / `dismiss` throw until Tasks 3.5 and 3.7:

```ts
// The caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D19, D21, D22; plan 3.4). ONE server function behind ONE route
// (routes/caseworkerReview.ts), and the ONLY way an existing contact becomes a
// caseworker - a `partner` whose role satisfies isCaseworkerRole. The contacts
// PATCH refuses that write (409 caseworker_use_conversion), so this service
// owns its whole write: the refusals, the fenced commit, the suggestions, the
// threads, and the PATCH's side effects. `preview` runs the same reads and
// writes nothing. Errors are codes; the dashboard owns every sentence (D22).
import { isCaseworker, type PossibleSignal } from '../lib/caseworkers.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createAiRunsRepo, type AiRunsRepo } from '../repos/aiRunsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactVocabularyRepo, type ContactVocabularyRepo } from '../repos/contactVocabularyRepo.js';
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
  type ContactType,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationType,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createUnitsRepo, unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { createOrgNamesService, type OrgNamesService } from './orgNames.js';

// --- Wire types (plan 3.2; mirrored field-for-field in dashboard/src/api/types.ts)

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
  //   leftShared = another live contact holds the phone/address, or the
  //   thread's participant contactId is another contact; leftOther = an open
  //   one-to-one row with no type (R1-F15)
  organization: { value?: string; source: Exclude<OrganizationSource, 'request'> };
}

export interface PossibleCaseworkerRow {
  contactId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  type: 'tenant' | 'landlord' | 'partner';
  role?: string;
  signals: PossibleSignal[]; // non-empty, in PossibleSignal declaration order
}

export class CaseworkerReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'CaseworkerReviewError';
  }
}

export interface CaseworkerConversionService {
  preview(contactId: string): Promise<CaseworkerPreview>;
  make(contactId: string, input: { organization?: string; actor: string }): Promise<ContactItem>;
  dismiss(contactId: string, actor: string): Promise<ContactItem>;
}

/**
 * The repos and buses the contacts PATCH already uses for the same effects.
 * Every dep optional with the real default (A's createOrgNamesService idiom).
 */
export interface CaseworkerConversionDeps {
  contacts?: ContactsRepo;
  conversations?: ConversationsRepo;
  placements?: PlacementsRepo;
  tours?: ToursRepo;
  units?: UnitsRepo;
  extraction?: ExtractionRepo;
  aiRuns?: AiRunsRepo;
  audit?: AuditRepo;
  activityEvents?: ActivityEventsRepo;
  vocabulary?: ContactVocabularyRepo;
  events?: EventBus;
  orgNames?: OrgNamesService;
  logger?: Logger;
  /** The clock: caseworker_conversion.at and the verdict stamps. */
  now?: () => Date;
}

const CONTACT_TYPES: ReadonlySet<string> = new Set<ContactType>([
  'tenant', 'landlord', 'partner', 'team_member', 'unknown',
]);

/** D19: requested, scheduled, toured or no_show; canceled and closed are resolved. */
const OPEN_TOUR_STATUSES: ReadonlySet<string> = new Set(['requested', 'scheduled', 'toured', 'no_show']);

/** A stored string attribute, or undefined when absent or empty. */
function held(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The step-3 classification of the contact's threads (D21's conversion rule). */
interface ThreadPlan {
  retype: Array<{ conv: ConversationItem; readType: ConversationType }>;
  leftShared: number;
  leftOther: number;
}

export function createCaseworkerConversionService(
  deps: CaseworkerConversionDeps = {},
): CaseworkerConversionService {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contacts ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversations ?? createConversationsRepo({ logger: deps.logger });
  const placements = deps.placements ?? createPlacementsRepo({ logger: deps.logger });
  const tours = deps.tours ?? createToursRepo({ logger: deps.logger });
  const units = deps.units ?? createUnitsRepo({ logger: deps.logger });
  const extraction = deps.extraction ?? createExtractionRepo({ logger: deps.logger });
  const aiRuns = deps.aiRuns ?? createAiRunsRepo({ logger: deps.logger });
  const audit = deps.audit ?? createAuditRepo({ logger: deps.logger });
  const activityEvents = deps.activityEvents ?? createActivityEventsRepo({ logger: deps.logger });
  const vocabulary = deps.vocabulary ?? createContactVocabularyRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const orgNames = deps.orgNames ?? createOrgNamesService({ logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  /**
   * Rule 1: a CONSISTENT read. Missing, a phone/email pointer row (R1-F1: a
   * routing record, never a contact - the FakeWorld's pointer sentinel type
   * 'unknown' must not let one through), a type outside ContactType, or a
   * soft-deleted contact -> 404; a team member -> 400.
   */
  async function readSubject(contactId: string): Promise<ContactItem> {
    const c = await contacts.getById(contactId, { consistentRead: true });
    if (
      c === undefined
      || c.phone_ref === true
      || c.email_ref === true
      || !CONTACT_TYPES.has(c.type as string)
      || isDeleted(c)
    ) {
      throw new CaseworkerReviewError(404, 'contact_not_found');
    }
    if (c.type === 'team_member') throw new CaseworkerReviewError(400, 'caseworker_team_member');
    return c;
  }

  /**
   * Rule 3: every blocking record, kinds in order placement, tour, landlord,
   * roster, ids ascending within a kind. Soft-deleted units count (D22): a
   * restored unit must not come back with a caseworker as its landlord or on
   * its roster. One entry per unit: a landlord of record is not ALSO a roster
   * seat (unitContacts derives a landlord row from landlordId).
   */
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

  /** Rule 4 without a request: stored, else derived (plan Task 3.3). */
  async function storedOrDerived(
    _c: ContactItem,
  ): Promise<{ value?: string; source: Exclude<OrganizationSource, 'request'> }> {
    return { source: 'none' };
  }

  /** Step 3's classification, read-only (plan Task 3.4). */
  async function planThreads(_c: ContactItem): Promise<ThreadPlan> {
    return { retype: [], leftShared: 0, leftOther: 0 };
  }

  return {
    async preview(contactId) {
      const c = await readSubject(contactId);
      const alreadyCaseworker = isCaseworker(c);
      const pendingSuggestions = (await extraction.listSuggestionsByContact(contactId)).length;
      const plan = await planThreads(c);
      const threads = { retype: plan.retype.length, leftShared: plan.leftShared, leftOther: plan.leftOther };
      if (alreadyCaseworker) {
        // make on a caseworker re-runs steps 2-4 only: no refusals, no
        // commit, so nothing but the pending suggestions is removed.
        const org = held(c['organization']);
        return {
          contactId,
          alreadyCaseworker,
          refusals: [],
          removes: { pendingSuggestions },
          threads,
          organization: org !== undefined ? { value: org, source: 'stored' } : { source: 'none' },
        };
      }
      const housingAuthority = held(c['housingAuthority']);
      const agency = held(c['agency']);
      return {
        contactId,
        alreadyCaseworker,
        refusals: await collectRefusals(contactId),
        removes: {
          ...(housingAuthority !== undefined && { housingAuthority }),
          ...(agency !== undefined && { agency }),
          pendingSuggestions,
        },
        threads,
        organization: await storedOrDerived(c),
      };
    },

    async make() {
      throw new Error('caseworker make: plan Task 3.5');
    },

    async dismiss() {
      throw new Error('caseworker dismiss: plan Task 3.7');
    },
  };
}
```

(The unused names `conversations`, `aiRuns`, `audit`, `activityEvents`,
`vocabulary`, `events`, `orgNames`, `now`, `log` are wired now and used by
Tasks 3.3-3.7; eslint's no-unused-vars may warn on them at THIS commit - the
gate-5 check runs at the end of the slice, when all are used. If the repo's
eslint config errors on them, prefix nothing - instead run eslint for this
file only after Task 3.7.)

Run the test file - GREEN. `cd "W:/tmp/caseworkers"; npm run typecheck` -
exit 0.

Commit (stage `app/src/services/caseworkerConversion.ts`,
`app/test/caseworkerConversion.test.ts`)
`feat(caseworkers): conversion service - domain, refusals, preview removes (D19, D22)`.

### Task 3.3 - the organization: stored, list match over both kinds, carried text (rule 4, R2-F7)

RED: append to `app/test/caseworkerConversion.test.ts`:

```ts
describe('the organization without a request (rule 4, D19, R2-F7)', () => {
  async function orgOf(over: Partial<ContactItem>) {
    const { world, service } = setup();
    seed(world, over);
    return (await service.preview(ID)).organization;
  }

  it('keeps a stored organization, even one not on the list', async () => {
    expect(await orgOf({ organization: 'Old Helper Org', agency: 'Step Up' })).toEqual({ value: 'Old Helper Org', source: 'stored' });
  });

  it('the agency wins and resolves against BOTH lists', async () => {
    expect(await orgOf({ agency: 'Hope Atlanta', housingAuthority: 'Atlanta Housing Authority' }))
      .toEqual({ value: 'HOPE Atlanta', source: 'list_match' });
    // A housing authority spelling typed into the agency field still matches.
    expect(await orgOf({ agency: 'Atlanta Housing' })).toEqual({ value: 'Atlanta Housing Authority', source: 'list_match' });
  });

  it('carries agency text that is not on the list, compound text included', async () => {
    expect(await orgOf({ agency: 'Neighborhood Helpers' })).toEqual({ value: 'Neighborhood Helpers', source: 'carried' });
    expect(await orgOf({ agency: 'DCA HUD-VASH' })).toEqual({ value: 'DCA HUD-VASH', source: 'carried' });
    expect(await orgOf({ agency: 'AHA' })).toEqual({ value: 'AHA', source: 'carried' }); // ambiguous is not a match
  });

  it('only with no agency does the housing authority get the same treatment', async () => {
    expect(await orgOf({ housingAuthority: 'GA DCA' }))
      .toEqual({ value: 'Georgia Department of Community Affairs', source: 'list_match' });
    // An agency name sitting in the housing authority field counts.
    expect(await orgOf({ housingAuthority: 'Step Up', agency: '' })).toEqual({ value: 'Step Up', source: 'list_match' });
    expect(await orgOf({ housingAuthority: 'Nowhere Housing Authority' }))
      .toEqual({ value: 'Nowhere Housing Authority', source: 'carried' });
  });

  it('does not carry text that fails the limits, and then does not fall back to the authority', async () => {
    const bell = String.fromCharCode(7);
    expect(await orgOf({ agency: `Helpers${bell}`, housingAuthority: 'Atlanta Housing Authority' })).toEqual({ source: 'none' });
    expect(await orgOf({ agency: 'x'.repeat(121) })).toEqual({ source: 'none' });
    expect(await orgOf({ agency: '---' })).toEqual({ source: 'none' });
  });

  it('none when there is nothing to derive from', async () => {
    expect(await orgOf({})).toEqual({ source: 'none' });
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerConversion.test.ts`
- RED: the stub answers `{ source: 'none' }` for every case except the last.

GREEN - in `app/src/services/caseworkerConversion.ts`:

1. Add imports:

```ts
import { KINDS_FOR_FIELD, ORG_NAME_MAX, normalizeOrgText, resolveOrgText, type OrgEntry } from '../lib/orgNames.js';
```

   and change `import { createOrgNamesService, type OrgNamesService } from './orgNames.js';` to

```ts
import { createOrgNamesService, hasOrgControlChar, type OrgNamesService } from './orgNames.js';
```

2. Add, after `function held(...)`:

```ts
/**
 * R2-F7: carried text passes D13's limits - no control or invisible
 * characters, at most ORG_NAME_MAX, not empty after normalization. NOT
 * checkNewOrgName: a TAKEN or COMPOUND text is carried (settled later with
 * Use or Clear in Settings' "Not on the list").
 */
function carriable(text: string): boolean {
  return !hasOrgControlChar(text) && text.length <= ORG_NAME_MAX && normalizeOrgText(text) !== '';
}

/** D19 derivation from one text: a list match over both kinds, else carried, else none. */
function deriveOrganization(
  entries: readonly OrgEntry[],
  text: string,
): { value?: string; source: 'list_match' | 'carried' | 'none' } {
  const r = resolveOrgText(entries, text, KINDS_FOR_FIELD.organization);
  if (r.status === 'match') return { value: r.entry.name, source: 'list_match' };
  return carriable(text) ? { value: text, source: 'carried' } : { source: 'none' };
}
```

3. Replace the `storedOrDerived` stub with:

```ts
  /**
   * Rule 4 without a request: the stored organization; else the agency text
   * whenever the contact has one (the employer is the helper organization -
   * Cameron 2026-10-07); only with no agency, the housing authority text.
   * One list read, only when deriving.
   */
  async function storedOrDerived(
    c: ContactItem,
  ): Promise<{ value?: string; source: Exclude<OrganizationSource, 'request'> }> {
    const stored = held(c['organization']);
    if (stored !== undefined) return { value: stored, source: 'stored' };
    const agency = held(c['agency'])?.trim();
    const authority = held(c['housingAuthority'])?.trim();
    const text = agency !== undefined && agency !== '' ? agency : authority;
    if (text === undefined || text === '') return { source: 'none' };
    const { entries } = await orgNames.read();
    return deriveOrganization(entries, text);
  }
```

Run - GREEN. Typecheck - exit 0.

Commit (stage the two files)
`feat(caseworkers): conversion derives the organization - stored, list match, carried text (D19)`.

### Task 3.4 - the thread plan: own, shared and type-less threads (step 3 read, D21, R1-F15)

RED: append:

```ts
describe('the thread plan (step 3, D21, R1-F15): what the preview counts', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  function thread(world: FakeWorld, conversationId: string, over: Record<string, unknown>): void {
    world.conversations.set(conversationId, { conversationId, ...OPEN, ...over } as never);
  }

  it("counts the contact's own open one-to-one threads on every phone and every email", async () => {
    const { world, service } = setup();
    seed(world, {
      phones: [{ phone: PHONE, primary: true }, { phone: '+15550107002', primary: false }],
      email: 'ana@example.org',
    });
    thread(world, 'cv-unknown', { type: 'unknown_1to1', participant_phone: PHONE });
    thread(world, 'cv-second', { type: 'tenant_1to1', participant_phone: '+15550107002' });
    thread(world, 'cv-email', { type: 'landlord_1to1', participant_email: 'ana@example.org' });
    thread(world, 'cv-partner', { type: 'partner_1to1', participant_phone: PHONE, status: 'closed' });
    thread(world, 'cv-closed', { type: 'tenant_1to1', participant_phone: PHONE, status: 'closed' });
    thread(world, 'cv-relay', { type: 'relay_group', participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 3, leftShared: 0, leftOther: 0 });
  });

  it('an already partner_1to1 thread is neither re-typed nor counted', async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-p', { type: 'partner_1to1', participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 0, leftOther: 0 });
  });

  it('leaves (leftShared) a household phone another live contact holds; a deleted holder does not share', async () => {
    const { world, service } = setup();
    seed(world);
    seed(world, { contactId: 'c-household', phone: PHONE });
    seed(world, { contactId: 'c-gone', phone: '+15550107003', deleted_at: '2026-10-05T00:00:00.000Z' });
    world.contacts.find((c) => c.contactId === ID)!.phones = [
      { phone: PHONE, primary: true },
      { phone: '+15550107003', primary: false },
    ];
    thread(world, 'cv-shared', { type: 'tenant_1to1', participant_phone: PHONE });
    thread(world, 'cv-own', { type: 'unknown_1to1', participant_phone: '+15550107003' });
    expect((await service.preview(ID)).threads).toEqual({ retype: 1, leftShared: 1, leftOther: 0 });
  });

  it("leaves a phone another contact holds through a pointer row, and a shared address", async () => {
    const { world, service } = setup();
    seed(world, { phone: '+15550107004', email: 'shared@example.org' });
    seed(world, { contactId: 'c-other', phone: '+15550107005', email: 'other@example.org' });
    await world.contactsRepo.addPhone('c-other', { phone: '+15550107004' });
    seed(world, { contactId: 'c-also', phone: '+15550107006', email: 'shared@example.org' });
    thread(world, 'cv-ptr', { type: 'unknown_1to1', participant_phone: '+15550107004' });
    thread(world, 'cv-mail', { type: 'unknown_1to1', participant_email: 'shared@example.org' });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 2, leftOther: 0 });
  });

  it("leaves a thread whose participant contactId is another contact (leftShared) and a type-less row (leftOther)", async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-theirs', {
      type: 'tenant_1to1', participant_phone: PHONE, participants: [{ contactId: 'c-elsewhere', phone: PHONE }],
    });
    thread(world, 'cv-legacy', { participant_phone: PHONE });
    expect((await service.preview(ID)).threads).toEqual({ retype: 0, leftShared: 1, leftOther: 1 });
  });

  it('a participant contactId equal to the contact is its own thread', async () => {
    const { world, service } = setup();
    seed(world);
    thread(world, 'cv-mine', { type: 'unknown_1to1', participant_phone: PHONE, participants: [{ contactId: ID, phone: PHONE }] });
    expect((await service.preview(ID)).threads).toEqual({ retype: 1, leftShared: 0, leftOther: 0 });
  });
});
```

(The `cv-partner` row in the first case is closed AND partner - it would be
skipped either way; it is there so a regression that counts closed rows
shows up as 4.)

Run - RED: the stub plan answers zeros.

GREEN - in `app/src/services/caseworkerConversion.ts`:

1. Add `import { conversationsForContact } from '../lib/contactThreads.js';`.
2. Add, after `OPEN_TOUR_STATUSES`:

```ts
/** The one-to-one types the conversion re-types (partner_1to1 is already done; groups never). */
const RETYPABLE_TYPES: ReadonlySet<string> = new Set(['tenant_1to1', 'landlord_1to1', 'unknown_1to1']);
```

3. Replace the `planThreads` stub with:

```ts
  /**
   * D21's conversion rule, read-only: the contact's OPEN one-to-one threads on
   * EVERY phone and email (conversationsForContact) not yet partner_1to1.
   * A thread is the contact's own only when its participant contactId, when
   * set, is the contact AND no other live contact holds its phone or address
   * (findAllByPhone / findAllByEmail: every holder, pointer rows resolved,
   * deleted excluded - findByPhone returns ONE arbitrary holder and cannot
   * decide this). A type-less open row is left and counted (R1-F15). The
   * read type is captured so the write is conditional on it.
   */
  async function planThreads(c: ContactItem): Promise<ThreadPlan> {
    const plan: ThreadPlan = { retype: [], leftShared: 0, leftOther: 0 };
    for (const conv of await conversationsForContact(c, conversations)) {
      if (conv.status !== 'open') continue;
      const readType: unknown = conv.type;
      if (typeof readType !== 'string' || readType === '') {
        plan.leftOther += 1;
        continue;
      }
      if (!RETYPABLE_TYPES.has(readType)) continue;
      const participantId = conv.participants?.[0]?.contactId;
      if (typeof participantId === 'string' && participantId !== '' && participantId !== c.contactId) {
        plan.leftShared += 1;
        continue;
      }
      if (await heldByAnother(conv, c.contactId)) {
        plan.leftShared += 1;
        continue;
      }
      plan.retype.push({ conv, readType: readType as ConversationType });
    }
    return plan;
  }

  /** Another LIVE contact holds the thread's phone or address. */
  async function heldByAnother(conv: ConversationItem, contactId: string): Promise<boolean> {
    const phone = conv.participant_phone;
    if (typeof phone === 'string' && phone !== '') {
      if ((await contacts.findAllByPhone(phone)).some((h) => h.contactId !== contactId)) return true;
    }
    const email = conv.participant_email;
    if (typeof email === 'string' && email !== '') {
      if ((await contacts.findAllByEmail(email)).some((h) => h.contactId !== contactId)) return true;
    }
    return false;
  }
```

Run - GREEN. If the pointer case fails because the FakeWorld
`findAllByPhone` does not resolve the pointer row to `c-other`, that is S2's
fake (plan 3.3 says pointer rows resolve): STOP and report, do not patch
around it here. Typecheck - exit 0.

Commit (stage the two files)
`feat(caseworkers): conversion plans the contact's own threads - shared and type-less rows left (D21)`.

### Task 3.5 - `make`: the refusals, the request organization, the fenced commit, the step-4 effects

RED: append:

```ts
describe('make - the commit write (rules 3-5, step 1, D19, D22)', () => {
  it('converts in ONE fenced write: partner, Caseworker, active, manual, the organization, agency cleared, authority removed, the record', async () => {
    const { world, service } = setup();
    seed(world, {
      housingAuthority: 'Atlanta Housing Authority',
      housingAuthority_source: 'ai',
      agency: 'Hope Atlanta',
      voucherSize: 2,
    });
    const writes: unknown[] = [];
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      writes.push({ id, opts });
      return original(id, patch, opts);
    };
    const contact = await service.make(ID, { actor: ACTOR });
    expect(writes).toEqual([{
      id: ID,
      opts: {
        expect: [
          { attr: 'classification_revision', value: null },
          { attr: 'housingAuthority', value: 'Atlanta Housing Authority' },
          { attr: 'agency', value: 'Hope Atlanta' },
          { attr: 'organization', value: null },
        ],
        notDeleted: true,
      },
    }]);
    const after = stored(world)!;
    expect(contact).toBe(after);
    expect(after).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      organization: 'HOPE Atlanta',
      agency: '',
      voucherSize: 2, // the other tenant facts stay as data
      classification_revision: 1,
      caseworker_conversion: {
        at: NOW,
        by: ACTOR,
        fromType: 'tenant',
        housingAuthority: 'Atlanta Housing Authority',
        agency: 'Hope Atlanta',
      },
    });
    expect('housingAuthority' in after).toBe(false);
    expect('housingAuthority_source' in after).toBe(false);
    expect(after.caseworker_conversion).not.toHaveProperty('fromRole');
  });

  it('records fromRole, carries not-on-the-list text, and guards the stored revision as a number', async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review', role: 'Case Manager', agency: 'Neighborhood Helpers', classification_revision: 3 });
    await service.make(ID, { actor: ACTOR });
    expect(stored(world)).toMatchObject({
      organization: 'Neighborhood Helpers',
      classification_revision: 4,
      caseworker_conversion: { fromType: 'unknown', fromRole: 'Case Manager', agency: 'Neighborhood Helpers' },
    });
  });

  it("a request organization wins: D5 over both kinds; '' leaves it absent", async () => {
    const { world, service } = setup();
    seed(world, { agency: 'Step Up' });
    seed(world, { contactId: 'c-two', phone: '+15550107010', agency: 'Step Up' });
    await service.make(ID, { actor: ACTOR, organization: 'atlanta housing' });
    expect(stored(world)?.['organization']).toBe('Atlanta Housing Authority');
    await service.make('c-two', { actor: ACTOR, organization: '' });
    expect('organization' in stored(world, 'c-two')!).toBe(false);
  });

  it('a request organization not on the list: 422 org_not_on_list (field organization), nothing written', async () => {
    const { world, service } = setup();
    seed(world, { agency: 'Step Up' });
    const before = structuredClone(stored(world));
    const err = await refused(service.make(ID, { actor: ACTOR, organization: 'Nowhere Org' }));
    expect([err.status, err.code]).toEqual([422, 'org_not_on_list']);
    expect(err.extras).toMatchObject({ field: 'organization', text: 'Nowhere Org', candidates: [] });
    expect(stored(world)).toEqual(before);
  });

  it('a refusal: 409 with the first refusal as the code and every refusal in the body; nothing written', async () => {
    const { world, service } = setup();
    seed(world);
    tour(world, 'tr-1', 'scheduled');
    unit(world, 'u-1', { landlordId: ID });
    const before = structuredClone(stored(world));
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([409, 'caseworker_open_tour']);
    expect(err.extras).toEqual({
      refusals: [
        { code: 'caseworker_open_tour', tourId: 'tr-1' },
        { code: 'caseworker_landlord_of_record', unitId: 'u-1' },
      ],
    });
    expect(stored(world)).toEqual(before);
    expect(world.auditEvents).toEqual([]);
  });

  for (const [label, edit] of [
    ['an agency edit', (c: ContactItem) => { c['agency'] = 'Step Up'; }],
    ['an organization edit', (c: ContactItem) => { c['organization'] = 'Mercy Care'; }],
    ['an authority edit', (c: ContactItem) => { c['housingAuthority'] = 'Decatur Housing Authority'; }],
    ['a concurrent classification', (c: ContactItem) => { c.classification_revision = 1; }],
  ] as const) {
    it(`answers 409 contact_changed when ${label} lands between the read and the commit`, async () => {
      const { world, service } = setup();
      seed(world, { agency: 'Hope Atlanta' });
      const original = world.contactsRepo.update.bind(world.contactsRepo);
      world.contactsRepo.update = async (id, patch, opts) => {
        edit(stored(world)!);
        return original(id, patch, opts);
      };
      const err = await refused(service.make(ID, { actor: ACTOR }));
      expect([err.status, err.code]).toEqual([409, 'contact_changed']);
      expect(stored(world)?.type).toBe('tenant');
    });
  }

  it('answers 404 when the contact is deleted between the read and the commit (the fifth clause)', async () => {
    const { world, service } = setup();
    seed(world);
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      stored(world)!.deleted_at = '2026-10-07T11:59:00.000Z';
      return original(id, patch, opts);
    };
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
    expect(stored(world)?.type).toBe('tenant');
  });
});

describe('make - step 4: the audit, the milestone, the vocabulary (D19)', () => {
  it('audits contact_updated naming the conversion, records Status -> Active by the NEW type, adds the role', async () => {
    const { world, service } = setup();
    seed(world, { housingAuthority: 'Atlanta Housing Authority' });
    await service.make(ID, { actor: ACTOR });
    const audits = world.auditEvents.filter((e) => e.event_type === 'contact_updated');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityKey: `contacts#${ID}`,
      payload: {
        actor: ACTOR,
        conversion: 'caseworker',
        caseworker_conversion: { fromType: 'tenant', housingAuthority: 'Atlanta Housing Authority' },
      },
    });
    const arrow = String.fromCharCode(0x2192);
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed').map((e) => e.label))
      .toEqual([`Status ${arrow} Active`]);
    expect(world.vocabularyAdds).toContainEqual({ roles: ['Caseworker'] });
  });

  it('records no milestone when the status was already active (a partner becoming a caseworker)', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active' });
    await service.make(ID, { actor: ACTOR });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
  });
});
```

Run - RED: `make` throws `caseworker make: plan Task 3.5` (a plain Error, so
`refused` rethrows it and every case fails).

GREEN - in `app/src/services/caseworkerConversion.ts`:

1. Imports: add `import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';`,
   `import { CASEWORKER_ROLE } from './extraction/contactKinds.js';`, and
   `type CaseworkerConversionRecord` to the `../repos/contactsRepo.js` import.

2. Add, after `deriveOrganization`:

```ts
/**
 * One clause of the commit guard (D19 step 1, R1-F3): the attribute AS READ -
 * its raw value (a number for the revision, never the folded 0 of
 * contactClassificationRevision), or null = attribute_not_exists when absent.
 * Any other stored shape becomes null, which fails the condition: a loud 409,
 * never a silent overwrite.
 */
function clause(attr: string, raw: unknown): { attr: string; value: string | number | null } {
  return { attr, value: typeof raw === 'string' || typeof raw === 'number' ? raw : null };
}

/** The milestone arrow, kept out of the source as a character code (ASCII rule). */
const ARROW = String.fromCharCode(0x2192);
```

3. Add, inside the factory after `planThreads` / `heldByAnother`:

```ts
  /** Rule 4 with a request: '' = absent; non-empty = D5 against both kinds (422 as A's shape). */
  async function requestedOrganization(
    c: ContactItem,
    requested: string,
  ): Promise<{ value?: string; source: OrganizationSource }> {
    const next = requested.trim();
    if (next === '') return { source: 'request' };
    const check = await orgNames.checkScalar('organization', next, held(c['organization']));
    if (!check.ok) {
      const { error, ...body } = check.error;
      throw new CaseworkerReviewError(422, error, body);
    }
    return check.value === null ? { source: 'request' } : { value: check.value, source: 'request' };
  }

  /**
   * Steps 2-4 after the commit (or alone, on the repair path). Every failure is
   * logged at error level and swallowed: the contact is already converted and
   * its removed values are safe in caseworker_conversion; `make` again re-runs
   * these steps (RUNBOOK). Steps 2 and 3 land in Task 3.6.
   */
  async function followOn(
    contactId: string,
    committed: ContactItem,
    ctx: {
      actor: string;
      repair: boolean;
      priorStatus: string | undefined;
      fields: string[];
      record?: CaseworkerConversionRecord;
    },
  ): Promise<void> {
    const retyped = 0; // step 3 (Task 3.6)
    try {
      await audit.append(`contacts#${contactId}`, 'contact_updated', {
        fields: ctx.fields,
        actor: ctx.actor,
        conversion: 'caseworker',
        ...(ctx.repair && { repair: true }),
        ...(ctx.record !== undefined && { caseworker_conversion: ctx.record }),
        ...(retyped > 0 && { propagatedConversations: retyped, conversationType: 'partner_1to1' }),
      });
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: audit failed after the commit (make again repairs)');
    }
    // R1-F12: labelled by the NEW type (partner -> "Active"); the PATCH's own
    // milestone keeps labelling by the stored type.
    if (!ctx.repair && ctx.priorStatus !== 'active') {
      try {
        await activityEvents.record({ contactId, type: 'contact_status_changed', label: `Status ${ARROW} Active` });
      } catch (err) {
        log.error({ err, contactId }, 'caseworker conversion: status milestone failed after the commit');
      }
    }
    try {
      await vocabulary.add({ roles: [CASEWORKER_ROLE] });
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: role vocabulary add failed after the commit');
    }
    void committed; // read by steps 2-3 (Task 3.6)
  }
```

   (Task 3.6 replaces `const retyped = 0;` and the `void committed;` line.)

4. Replace the `make` stub with:

```ts
    async make(contactId, input) {
      const c = await readSubject(contactId);
      const actor = input.actor;
      // The read, as primitives, BEFORE any write: a repo may hand back a live
      // object the write then mutates (the FakeWorld does).
      const read = {
        type: c.type,
        role: held(c['role']),
        status: typeof c.status === 'string' ? c.status : undefined,
        revision: c.classification_revision as unknown,
        housingAuthority: c['housingAuthority'],
        agency: c['agency'],
        organization: c['organization'],
      };

      if (isCaseworker(c)) {
        // Rule 2, the repair path: steps 2-4 only. A request organization is
        // ignored here (no commit runs). readSubject re-checked deletion.
        await followOn(contactId, c, { actor, repair: true, priorStatus: read.status, fields: [] });
        return c;
      }

      const refusals = await collectRefusals(contactId);
      if (refusals.length > 0) {
        throw new CaseworkerReviewError(409, refusals[0]!.code, { refusals });
      }

      const organization = input.organization !== undefined
        ? await requestedOrganization(c, input.organization)
        : await storedOrDerived(c);

      const removedAuthority = held(read.housingAuthority);
      const clearedAgency = held(read.agency);
      const record: CaseworkerConversionRecord = {
        at: now().toISOString(),
        by: actor,
        fromType: read.type,
        ...(read.role !== undefined && { fromRole: read.role }),
        ...(removedAuthority !== undefined && { housingAuthority: removedAuthority }),
        ...(clearedAgency !== undefined && { agency: clearedAgency }),
      };
      // Step 1, the commit point. `role` in the patch bumps
      // classification_revision through the repo's fence; '' clears agency
      // (R1-F13, every machine clear); null REMOVEs.
      const patch: Record<string, unknown> = {
        type: 'partner',
        role: CASEWORKER_ROLE,
        status: 'active',
        type_source: 'manual',
        organization: organization.value ?? null,
        agency: '',
        housingAuthority: null,
        housingAuthority_source: null,
        caseworker_conversion: record,
      };
      let converted: ContactItem;
      try {
        converted = await contacts.update(contactId, patch, {
          expect: [
            clause('classification_revision', read.revision),
            clause('housingAuthority', read.housingAuthority),
            clause('agency', read.agency),
            clause('organization', read.organization),
          ],
          notDeleted: true,
        });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          const current = await contacts.getById(contactId, { consistentRead: true });
          if (current === undefined || isDeleted(current)) throw new CaseworkerReviewError(404, 'contact_not_found');
          log.info({ contactId }, 'caseworker conversion refused: the contact changed since the read');
          throw new CaseworkerReviewError(409, 'contact_changed');
        }
        throw err;
      }
      log.info(
        { contactId, fromType: read.type, organizationSource: organization.source, actor },
        'caseworker conversion committed',
      );
      await followOn(contactId, converted, {
        actor, repair: false, priorStatus: read.status, fields: Object.keys(patch), record,
      });
      return converted;
    },
```

Run - GREEN. Typecheck - exit 0.

Commit (stage the two files)
`feat(caseworkers): make - refusals, request organization, the fenced commit, audit and milestone (D19, D22)`.

### Task 3.6 - `make` steps 2 and 3, the repair path, failures after the commit

RED: append:

```ts
describe('make - step 2: the suggestions (D16, D19)', () => {
  it("drains the type suggestion as accepted (the canonicalizer's partner preset) and supersedes every other one", async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review' });
    const stamps: Array<[string, string, string, unknown]> = [];
    world.aiRuns.setVerdict = async (runId, target, verdict, opts) => {
      stamps.push([runId, target, verdict, opts?.by]);
      return true;
    };
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'partner', conversationId: 'cv', runId: 'run-1',
      contactClassificationRevision: 0,
    });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'housingAuthority', suggestedValue: 'AHA', conversationId: 'cv', runId: 'run-1' });
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'cv', runId: 'run-1' });
    await service.make(ID, { actor: ACTOR });
    expect(await world.extractionRepo.listSuggestionsByContact(ID)).toEqual([]);
    expect(stamps.sort()).toEqual([
      ['run-1', 'housingAuthority', 'superseded_by_human_edit', ACTOR],
      ['run-1', 'pets', 'superseded_by_human_edit', ACTOR],
      ['run-1', 'type', 'accepted', ACTOR],
    ]);
    expect(world.emitted.filter((e) => e.event === 'suggestion.updated')).toEqual([
      { event: 'suggestion.updated', payload: { contactId: ID } },
    ]);
  });

  it('a tenant type suggestion is superseded, not accepted', async () => {
    const { world, service } = setup();
    seed(world, { type: 'unknown', status: 'needs_review' });
    const verdicts: string[] = [];
    world.aiRuns.setVerdict = async (_r, _t, verdict) => { verdicts.push(verdict); return true; };
    await world.extractionRepo.putSuggestion({
      ownerContactId: ID, target: 'type', suggestedValue: 'tenant', conversationId: 'cv', runId: 'run-1',
      contactClassificationRevision: 0,
    });
    await service.make(ID, { actor: ACTOR });
    expect(verdicts).toEqual(['superseded_by_human_edit']);
  });
});

describe('make - step 3: the threads (D21)', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  it("re-types the contact's own threads to partner_1to1 with the name, leaves shared ones, emits per thread", async () => {
    const { world, service } = setup();
    seed(world, { email: 'ana@example.org' });
    seed(world, { contactId: 'c-household', phone: '+15550107020' });
    world.contacts.find((c) => c.contactId === ID)!.phones = [
      { phone: PHONE, primary: true },
      { phone: '+15550107020', primary: false },
    ];
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'tenant_1to1', participant_phone: PHONE } as never);
    world.conversations.set('cv-mail', { conversationId: 'cv-mail', ...OPEN, type: 'unknown_1to1', participant_email: 'ana@example.org' } as never);
    world.conversations.set('cv-shared', { conversationId: 'cv-shared', ...OPEN, type: 'tenant_1to1', participant_phone: '+15550107020' } as never);
    await service.make(ID, { actor: ACTOR });
    expect(world.conversations.get('cv-own')).toMatchObject({ type: 'partner_1to1', participant_display_name: 'Ana Ruiz' });
    expect(world.conversations.get('cv-mail')).toMatchObject({ type: 'partner_1to1', participant_display_name: 'Ana Ruiz' });
    expect(world.conversations.get('cv-shared')?.type).toBe('tenant_1to1');
    const updated = world.emitted.filter((e) => e.event === 'conversation.updated');
    expect(updated.map((e) => (e.payload as { conversationId: string }).conversationId).sort()).toEqual(['cv-mail', 'cv-own']);
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.payload).toMatchObject({
      propagatedConversations: 2, conversationType: 'partner_1to1',
    });
  });

  it('skips a thread whose type changed after the plan read it (conditional on the read type)', async () => {
    const { world, service } = setup();
    seed(world);
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    const original = world.conversationsRepo.setTypeIfCurrent.bind(world.conversationsRepo);
    world.conversationsRepo.setTypeIfCurrent = async (id, expected, next, name) => {
      world.conversations.get(id)!.type = 'landlord_1to1'; // a triage landed in between
      return original(id, expected, next, name);
    };
    await service.make(ID, { actor: ACTOR });
    expect(world.conversations.get('cv-own')?.type).toBe('landlord_1to1');
    expect(world.emitted.filter((e) => e.event === 'conversation.updated')).toEqual([]);
  });
});

describe('make - the repair path (rule 2) and failures after the commit', () => {
  const OPEN = { status: 'open', ai_mode: 'auto', last_activity_at: NOW, created_at: NOW };

  it('on a caseworker re-runs steps 2-4 only: no refusals, no commit, no new record, no milestone', async () => {
    const { world, service } = setup();
    seed(world, {
      type: 'partner', status: 'active', role: 'Caseworker', type_source: 'manual', classification_revision: 2,
    });
    tour(world, 'tr-1', 'scheduled'); // would refuse a conversion; the repair does not check
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    await world.extractionRepo.putSuggestion({ ownerContactId: ID, target: 'pets', suggestedValue: 'a dog', conversationId: 'cv' });
    const contact = await service.make(ID, { actor: ACTOR, organization: 'Nowhere Org' });
    expect(contact.classification_revision).toBe(2);
    expect('caseworker_conversion' in contact).toBe(false);
    expect('organization' in contact).toBe(false);
    expect(world.conversations.get('cv-own')?.type).toBe('partner_1to1');
    expect(await world.extractionRepo.listSuggestionsByContact(ID)).toEqual([]);
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.payload).toMatchObject({
      repair: true, conversion: 'caseworker', fields: [],
    });
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toEqual([]);
  });

  it('the repair path re-checks deletion first', async () => {
    const { world, service } = setup();
    seed(world, { type: 'partner', status: 'active', role: 'Caseworker', deleted_at: '2026-10-05T00:00:00.000Z' });
    const err = await refused(service.make(ID, { actor: ACTOR }));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
  });

  it('a failure after the commit is logged at error level and never thrown', async () => {
    const { world, service, capture } = setup();
    seed(world);
    world.conversations.set('cv-own', { conversationId: 'cv-own', ...OPEN, type: 'unknown_1to1', participant_phone: PHONE } as never);
    world.failAuditAppendFor.add('contact_updated');
    world.conversationsRepo.setTypeIfCurrent = async () => {
      throw new Error('injected thread write failure');
    };
    const contact = await service.make(ID, { actor: ACTOR });
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(capture.atLevel(50).length).toBeGreaterThanOrEqual(2);
    expect(capture.atLevel(50).every((l) => String(l['msg']).startsWith('caseworker conversion'))).toBe(true);
  });
});
```

Run - RED: no suggestion is drained or superseded, no thread is re-typed,
no `conversation.updated` is emitted, the audit has no
`propagatedConversations`; the failure case sees fewer than two error lines
(the thread write never runs).

GREEN - in `app/src/services/caseworkerConversion.ts`:

1. Imports: add `toConversationUpdatedEvent` to the `../lib/events.js`
   import, `type SuggestionItem` to the `../repos/extractionRepo.js` import,
   and
   `import { displayNameOf, drainTypeSuggestion, supersedePendingSuggestion } from './contactClassification.js';`.

2. In `followOn`, replace `    const retyped = 0; // step 3 (Task 3.6)` with
   the two steps, and delete the `    void committed; // read by steps 2-3 (Task 3.6)` line:

```ts
    const verdictAt = now().toISOString();
    const suggestionDeps = { extraction, aiRuns, log };

    // Step 2: the type suggestion through the PATCH's revision-guarded drain
    // (canonicalSuggestedContactKind(converted) is 'partner' for the exact
    // Caseworker preset, so an AI partner suggestion records accepted, D16),
    // then every other pending suggestion superseded with the PATCH's stamps
    // (a partner is never extracted again, so none would ever resolve).
    let suggestionsChanged = false;
    try {
      if (await drainTypeSuggestion(suggestionDeps, {
        contactId, committed, pendingTypeBefore: ctx.pendingTypeBefore, verdictAt, actor: ctx.actor,
      })) suggestionsChanged = true;
      for (const pending of await extraction.listSuggestionsByContact(contactId)) {
        if (pending.target === 'type') continue;
        if (await supersedePendingSuggestion(suggestionDeps, {
          contactId, target: pending.target, pending, verdict: 'superseded_by_human_edit', verdictAt, actor: ctx.actor,
        })) suggestionsChanged = true;
      }
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: suggestion sweep failed after the commit (make again repairs)');
    }
    if (suggestionsChanged) events.emit('suggestion.updated', { contactId });

    // Step 3: re-type the contact's OWN open one-to-one threads (D21), each
    // conditional on the type the plan read; a lost condition is skipped and
    // logged, never thrown. The display name rides the same write (R1-F15).
    let retyped = 0;
    try {
      const plan = await planThreads(committed);
      const displayName = displayNameOf(committed);
      for (const { conv, readType } of plan.retype) {
        try {
          const result = await conversations.setTypeIfCurrent(conv.conversationId, readType, 'partner_1to1', displayName);
          if (result.outcome === 'skipped') {
            log.info({ contactId, conversationId: conv.conversationId }, 'caseworker conversion: thread type changed since the read; left as is');
            continue;
          }
          retyped += 1;
          // Built from the UPDATED row setTypeIfCurrent returns (plan 3.3).
          events.emit('conversation.updated', toConversationUpdatedEvent(result.conversation));
        } catch (err) {
          log.error({ err, contactId, conversationId: conv.conversationId }, 'caseworker conversion: thread re-type failed after the commit (make again repairs)');
        }
      }
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: thread plan failed after the commit (make again repairs)');
    }
```

3. Add `pendingTypeBefore: SuggestionItem | undefined;` to `followOn`'s `ctx`
   type, and a reader inside the factory:

```ts
  /** The type suggestion BEFORE the write (consistent; best-effort, as the PATCH reads it). */
  async function readTypeSuggestion(contactId: string): Promise<SuggestionItem | undefined> {
    try {
      return await extraction.getSuggestion(contactId, 'type', { consistentRead: true });
    } catch (err) {
      log.warn({ err, contactId }, 'type suggestion pre-write read failed (best-effort)');
      return undefined;
    }
  }
```

4. In `make`: on the repair path pass
   `pendingTypeBefore: await readTypeSuggestion(contactId)` in the
   `followOn` ctx; on the commit path add
   `const pendingTypeBefore = await readTypeSuggestion(contactId);`
   immediately before `let converted: ContactItem;` and pass
   `pendingTypeBefore` in that `followOn` ctx.

Run - GREEN. Re-run the whole file (every earlier describe stays green).
Typecheck - exit 0.

Commit (stage the two files)
`feat(caseworkers): make sweeps suggestions and re-types the contact's own threads; repair path (D19, D21)`.

### Task 3.7 - `dismiss` (D19, D22, R1-F9)

RED: append:

```ts
describe('dismiss (D19, D22)', () => {
  it('writes caseworker_review dismissed with no revision bump, audits it, returns the contact', async () => {
    const { world, service } = setup();
    for (const [id, type, status] of [['c-t', 'tenant', 'onboarding'], ['c-l', 'landlord', 'interested'], ['c-p', 'partner', 'active']] as const) {
      seed(world, { contactId: id, type, status, classification_revision: 5 });
      const contact = await service.dismiss(id, ACTOR);
      expect(contact, id).toMatchObject({ caseworker_review: 'dismissed', classification_revision: 5 });
    }
    expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated').map((e) => e.payload)).toEqual([
      { fields: ['caseworker_review'], actor: ACTOR },
      { fields: ['caseworker_review'], actor: ACTOR },
      { fields: ['caseworker_review'], actor: ACTOR },
    ]);
  });

  it('refuses an unknown and a caseworker with 400 caseworker_dismiss_not_allowed', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-u', type: 'unknown', status: 'needs_review' });
    seed(world, { contactId: 'c-cw', type: 'partner', status: 'active', role: 'Case worker' });
    for (const id of ['c-u', 'c-cw']) {
      const err = await refused(service.dismiss(id, ACTOR));
      expect([err.status, err.code], id).toEqual([400, 'caseworker_dismiss_not_allowed']);
      expect(stored(world, id)).not.toHaveProperty('caseworker_review');
    }
  });

  it('shares the domain: 404 missing, pointer or deleted; 400 team member', async () => {
    const { world, service } = setup();
    seed(world, { contactId: 'c-owner', phone: '+15550107030' });
    await world.contactsRepo.addPhone('c-owner', { phone: '+15550107031' });
    seed(world, { contactId: 'c-gone', deleted_at: '2026-10-05T00:00:00.000Z' });
    seed(world, { contactId: 'c-team', type: 'team_member', status: 'active' });
    for (const id of ['c-nope', phoneRefId('+15550107031'), 'c-gone']) {
      expect((await refused(service.dismiss(id, ACTOR))).status, id).toBe(404);
    }
    expect((await refused(service.dismiss('c-team', ACTOR))).code).toBe('caseworker_team_member');
  });

  it('answers 404 when the contact is deleted between the read and the write', async () => {
    const { world, service } = setup();
    seed(world);
    const original = world.contactsRepo.update.bind(world.contactsRepo);
    world.contactsRepo.update = async (id, patch, opts) => {
      stored(world)!.deleted_at = '2026-10-07T11:59:00.000Z';
      return original(id, patch, opts);
    };
    const err = await refused(service.dismiss(ID, ACTOR));
    expect([err.status, err.code]).toEqual([404, 'contact_not_found']);
    expect(stored(world)).not.toHaveProperty('caseworker_review');
  });
});
```

Run - RED: `dismiss` throws `caseworker dismiss: plan Task 3.7`.

GREEN - replace the `dismiss` stub:

```ts
    async dismiss(contactId, actor) {
      const c = await readSubject(contactId);
      // An unknown is triaged, not dismissed; a caseworker is not "possible".
      if (c.type === 'unknown' || isCaseworker(c)) {
        throw new CaseworkerReviewError(400, 'caseworker_dismiss_not_allowed');
      }
      // Not a classification: no type/role in the patch, so no revision bump
      // (a concurrent make does not 409 on it - fine, D22).
      let updated: ContactItem;
      try {
        updated = await contacts.update(contactId, { caseworker_review: 'dismissed' }, { notDeleted: true });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw new CaseworkerReviewError(404, 'contact_not_found');
        throw err;
      }
      await audit.append(`contacts#${contactId}`, 'contact_updated', { fields: ['caseworker_review'], actor });
      log.info({ contactId, actor }, 'possible caseworker dismissed');
      return updated;
    },
```

(The dismiss audit propagates a failure like the PATCH's own audit does;
only `make`'s post-commit steps swallow.)

Run - GREEN; whole file green. Typecheck - exit 0. Lint the slice's
service: `cd "W:/tmp/caseworkers"; npx eslint app/src/services/caseworkerConversion.ts app/test/caseworkerConversion.test.ts`
- no new error (every dep is now used).

Commit (stage the two files)
`feat(caseworkers): dismiss a possible caseworker (D19, D22)`.

### Task 3.8 - `possibleCaseworkers.ts` (D19, D22, assembly ruling S3/S4-6)

RED: create `app/test/possibleCaseworkers.test.ts`:

```ts
// The Possible caseworkers read (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.4) on contactsPartitionFake, which models the byTypeStatus
// GSI as DynamoDB runs it (Limit before the deleted filter, pointer rows
// invisible), so the paging below is the production paging.
import { describe, expect, it } from 'vitest';
import type { ContactItem, ContactType, ListContactsOpts } from '../src/repos/contactsRepo.js';
import { listPossibleCaseworkers } from '../src/services/possibleCaseworkers.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

const AI_LINE = '[Auto - Oct 7] Identified as a caseworker at Hope Atlanta';

function depsOver(seed: ContactItem[]) {
  const calls: Array<{ type: ContactType } & ListContactsOpts> = [];
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push({ type, ...opts });
        return listByTypeFromContacts(seed, type, opts);
      },
    },
  };
  return { deps, calls };
}

function c(contactId: string, type: ContactType, over: Partial<ContactItem> = {}): ContactItem {
  const status = type === 'tenant' ? 'onboarding' : type === 'landlord' ? 'interested' : 'active';
  return { contactId, type, status, ...over } as ContactItem;
}

describe('listPossibleCaseworkers', () => {
  it('finds each signal on the right base, in signal declaration order', async () => {
    const { deps } = depsOver([
      c('t-role', 'tenant', { role: 'Case Manager', lastName: 'A' }),
      c('l-role', 'landlord', { role: 'caseworker - DCA', lastName: 'B' }),
      c('t-ai', 'tenant', { notes: `Moved in March\n${AI_LINE}`, lastName: 'C' }),
      c('t-both', 'tenant', { role: 'Case Worker', notes: AI_LINE, lastName: 'D' }),
      c('t-linked', 'tenant', { lastName: 'E' }),
      c('p-none', 'partner', { lastName: 'F' }),
      // linkers: one relationship row that counts, three that do not
      c('l-linker', 'landlord', {
        relationships: [
          { role: 'Case worker', name: 'E', contactId: 't-linked' },
          { role: 'Sister', name: 'X', contactId: 't-role' },
          { role: 'Caseworker', name: 'No link' },
          { role: 'Caseworker', name: 'A landlord', contactId: 'l-role' },
        ],
        role: 'Owner',
        lastName: 'Z',
      }),
    ]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows.map((r) => [r.contactId, r.signals])).toEqual([
      ['t-role', ['role_mentions']],
      ['l-role', ['role_mentions']],
      ['t-ai', ['ai_note']],
      ['t-both', ['role_mentions', 'ai_note']],
      ['t-linked', ['relationship']],
      ['p-none', ['partner_no_role']],
    ]);
  });

  it('does not count: an AI line without the prefix, role_title, a partner with any role, an AI line or link on a landlord', async () => {
    const { deps } = depsOver([
      c('t-plain', 'tenant', { notes: 'Identified as a caseworker at Hope Atlanta' }),
      c('t-title', 'tenant', { role_title: 'Caseworker' }),
      c('p-cm', 'partner', { role: 'Case Manager' }),
      c('p-insp', 'partner', { role: 'Inspector' }),
      c('l-ai', 'landlord', { notes: AI_LINE }),
    ]);
    expect(await listPossibleCaseworkers(deps)).toEqual([]);
  });

  it('excludes caseworkers, dismissed and deleted contacts', async () => {
    const { deps } = depsOver([
      c('p-cw', 'partner', { role: 'Caseworker' }),
      c('p-cw2', 'partner', { role: 'case worker' }),
      c('p-dis', 'partner', { caseworker_review: 'dismissed' }),
      c('t-dis', 'tenant', { role: 'Case Manager', caseworker_review: 'dismissed' }),
      c('p-del', 'partner', { deleted_at: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect(await listPossibleCaseworkers(deps)).toEqual([]);
  });

  it('reads the tenant, landlord and partner partitions to exhaustion, and nothing else', async () => {
    const partners = Array.from({ length: 120 }, (_, i) => c(`p-${String(i).padStart(3, '0')}`, 'partner'));
    const { deps, calls } = depsOver([...partners, c('u-1', 'unknown'), c('tm-1', 'team_member', { role: 'Caseworker' })]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows).toHaveLength(120);
    expect([...new Set(calls.map((x) => x.type))].sort()).toEqual(['landlord', 'partner', 'tenant']);
  });

  it('sorts by last name, first name, contactId (case-insensitive), and shapes the row', async () => {
    const { deps } = depsOver([
      c('p-2', 'partner', { firstName: 'Bo', lastName: 'smith', phone: '+15550107040' }),
      c('p-1', 'partner', { firstName: 'Al', lastName: 'Smith' }),
      c('p-3', 'partner', { firstName: 'Al', lastName: 'Smith' }),
      c('t-1', 'tenant', { firstName: 'Cy', lastName: 'Adams', role: 'Case Manager' }),
      c('p-0', 'partner'),
    ]);
    const rows = await listPossibleCaseworkers(deps);
    expect(rows.map((r) => r.contactId)).toEqual(['p-0', 't-1', 'p-1', 'p-3', 'p-2']);
    expect(rows[1]).toEqual({
      contactId: 't-1', firstName: 'Cy', lastName: 'Adams', type: 'tenant', role: 'Case Manager', signals: ['role_mentions'],
    });
    expect(rows[4]).toEqual({
      contactId: 'p-2', firstName: 'Bo', lastName: 'smith', phone: '+15550107040', type: 'partner', signals: ['partner_no_role'],
    });
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/possibleCaseworkers.test.ts`
- RED: `../src/services/possibleCaseworkers.js` does not exist.

GREEN - create `app/src/services/possibleCaseworkers.ts`:

```ts
// The Possible caseworkers list (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.4): computed on the server from ONE read each of the
// tenant, landlord and partner partitions - no index exists for any signal
// (the tours-tabs cost precedent; filed in section 12). Live (listByType
// excludes deleted), not dismissed, not already a caseworker:
//   role_mentions   - a tenant or landlord whose role "mentions" (D22)
//   ai_note         - a tenant whose `notes` carry the AI's own prefixed line
//   relationship    - a tenant another listed contact links as its caseworker
//                     (a relationship row with a contactId whose role mentions)
//   partner_no_role - a partner with no role
// Only `role` counts; `role_title` and `staff_notes` are never read.
import {
  hasAiCaseworkerNote,
  isCaseworker,
  mentionsCaseworker,
  type PossibleSignal,
} from '../lib/caseworkers.js';
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { PossibleCaseworkerRow } from './caseworkerConversion.js';

const BASES = ['tenant', 'landlord', 'partner'] as const;

async function readPartition(
  contacts: Pick<ContactsRepo, 'listByType'>,
  type: (typeof BASES)[number],
): Promise<ContactItem[]> {
  const out: ContactItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await contacts.listByType(type, {
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    out.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function sortKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function listPossibleCaseworkers(deps: {
  contacts: Pick<ContactsRepo, 'listByType'>;
}): Promise<PossibleCaseworkerRow[]> {
  const all: ContactItem[] = [];
  for (const type of BASES) all.push(...(await readPartition(deps.contacts, type)));

  // Contacts some listed contact links as its caseworker (D22: the row's role
  // mentions). Rows held by unknown or team_member contacts are not seen
  // (accepted, D19).
  const linked = new Set<string>();
  for (const holder of all) {
    const rows: unknown = holder['relationships'];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const target = row['contactId'];
      if (typeof target === 'string' && target !== '' && mentionsCaseworker(row['role'])) linked.add(target);
    }
  }

  const out: PossibleCaseworkerRow[] = [];
  for (const c of all) {
    if (isDeleted(c) || c['caseworker_review'] === 'dismissed' || isCaseworker(c)) continue;
    const signals: PossibleSignal[] = [];
    const role = text(c['role']);
    if ((c.type === 'tenant' || c.type === 'landlord') && mentionsCaseworker(role)) signals.push('role_mentions');
    if (c.type === 'tenant' && hasAiCaseworkerNote(c['notes'])) signals.push('ai_note');
    if (c.type === 'tenant' && linked.has(c.contactId)) signals.push('relationship');
    if (c.type === 'partner' && role === undefined) signals.push('partner_no_role');
    if (signals.length === 0) continue;
    const firstName = text(c['firstName']);
    const lastName = text(c['lastName']);
    const phone = text(c.phone);
    out.push({
      contactId: c.contactId,
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(phone !== undefined && { phone }),
      type: c.type as PossibleCaseworkerRow['type'],
      ...(role !== undefined && { role }),
      signals,
    });
  }
  return out.sort((a, b) =>
    compare(sortKey(a.lastName), sortKey(b.lastName))
    || compare(sortKey(a.firstName), sortKey(b.firstName))
    || compare(a.contactId, b.contactId),
  );
}
```

(Signal order follows `PossibleSignal`'s declaration order by construction:
the pushes are written in that order.)

Run - GREEN. Typecheck - exit 0. Lint the two new files (no new error).

Commit (stage `app/src/services/possibleCaseworkers.ts`,
`app/test/possibleCaseworkers.test.ts`)
`feat(caseworkers): the possible-caseworkers read over three partitions (D19, D22)`.

---

## S4 - contacts routes and wiring

Spec D16, D17, D19, D21, D22; rulings R1-F5, R1-F6, R1-F9, R1-F10, R1-F11;
plan 3.5. Files: `app/src/routes/contacts.ts`, `app/src/routes/api.ts`,
`app/src/routes/caseworkerReview.ts` (new), `app/src/lib/import/apply.ts`,
tests named per task. S3 has landed (Task 3.1 already changed
`contacts.ts`; match quoted text).

Step 0 for every S4 task: S1 and S2's items from S3's Step 0 hold, and
`grep -n "export function createCaseworkerConversionService\|export async function listPossibleCaseworkers" "W:/tmp/caseworkers/app/src/services/caseworkerConversion.ts" "W:/tmp/caseworkers/app/src/services/possibleCaseworkers.ts"`
prints two lines. The harness `api: {` block of `makeWebhookHarness`
already passes `unitsRepo: world.unitsRepo`, `placementsRepo`, `toursRepo`,
`extractionRepo`, `aiRunsRepo`, `orgListRepo` and `contactVocabularyRepo`
(`grep -n "      unitsRepo: world.unitsRepo," "W:/tmp/caseworkers/app/test/helpers/twilioWebhookHarness.ts"`
prints a line inside that block) - so the harness api block needs NO edit
in this slice; only `api.ts` must forward `unitsRepo` (Task 4.4). If that
grep prints nothing, STOP and report.

### Task 4.1 - contacts POST and PATCH refuse the server-owned keys (D21, D22, R1-F10)

RED: append to `app/test/contactsCrud.test.ts` (it already imports
`request`, `describe/expect/it`, `TEST_SESSION_COOKIE`, `makeWebhookHarness`,
`ORIGIN_SECRET` and defines `SECRET`):

```ts
describe('server-owned contact fields (caseworkers spec D21, D22)', () => {
  const OWNED = [
    ['caseworker_review', 'dismissed'],
    ['caseworker_conversion', { at: '2026-10-07T00:00:00.000Z', by: 'x', fromType: 'tenant' }],
    ['type_source', 'manual'],
  ] as const;

  for (const [key, value] of OWNED) {
    it(`POST refuses a client-sent ${key} with 400 and creates nothing`, async () => {
      const { app, world } = makeWebhookHarness();
      const res = await request(app)
        .post('/api/contacts')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ type: 'partner', firstName: 'Pat', [key]: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: `${key} is set by the server, not the client` });
      expect(world.contacts).toEqual([]);
    });

    it(`PATCH refuses a client-sent ${key} with 400 and writes nothing`, async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'contact-owned', type: 'tenant', status: 'onboarding', phone: '+15550107301' });
      const before = structuredClone(world.contacts);
      const res = await request(app)
        .patch('/api/contacts/contact-owned')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ firstName: 'Pat', [key]: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: `${key} is set by the server, not the client` });
      expect(world.contacts).toEqual(before);
    });
  }

  it('(PIN) a null value is still refused, as consent_captured_by is', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-owned', type: 'tenant', status: 'onboarding', phone: '+15550107302' });
    const res = await request(app)
      .patch('/api/contacts/contact-owned')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ firstName: 'Pat', type_source: null });
    expect(res.status).toBe(400);
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactsCrud.test.ts`
- RED: POST answers 201 (the parser drops unknown keys) and PATCH answers
  200 (the keys are ignored); the null case answers 200.

GREEN - `app/src/routes/contacts.ts`:

1. Insert immediately before the `/**` that opens the doc comment of
   `function applyConsentFields(` (the comment starts
   ` * A2P/CTIA consent capture (spec`):

```ts
/**
 * Server-owned contact attributes (caseworkers spec 2026-10-06 D21, D22):
 * `caseworker_review` and `caseworker_conversion` are written only by the
 * caseworker-review route, `type_source` only by the PATCH's staff-override
 * stamp and the conversion. A client value is REFUSED, loudly, on both
 * contact writers (one helper both parsers call), like consent_captured_by.
 */
const SERVER_OWNED_CONTACT_FIELDS = ['caseworker_review', 'caseworker_conversion', 'type_source'] as const;

function refuseServerOwnedFields(b: Record<string, unknown>): { error: string } | undefined {
  for (const key of SERVER_OWNED_CONTACT_FIELDS) {
    if (key in b && b[key] !== undefined) return { error: `${key} is set by the server, not the client` };
  }
  return undefined;
}

```

2. In `parseTriageBody`, current:

```ts
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
```

   Replace with:

```ts
  const b = body as Record<string, unknown>;
  const serverOwned = refuseServerOwnedFields(b);
  if (serverOwned !== undefined) return serverOwned;
  const patch: Record<string, unknown> = {};
```

3. In `parseCreateBody`, current:

```ts
  const b = body as Record<string, unknown>;

  if (!isContactType(b['type'])) {
```

   Replace with:

```ts
  const b = body as Record<string, unknown>;
  const serverOwned = refuseServerOwnedFields(b);
  if (serverOwned !== undefined) return serverOwned;

  if (!isContactType(b['type'])) {
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactsCrud.test.ts test/contactTriage.test.ts test/contactsEmailCrud.test.ts`
- GREEN. Typecheck - exit 0.

Commit (stage `app/src/routes/contacts.ts`, `app/test/contactsCrud.test.ts`)
`feat(caseworkers): contacts POST and PATCH refuse the server-owned fields (D21, D22)`.

### Task 4.2 - PATCH `organization`: D5 against both kinds; '' REMOVEs; POST keeps ignoring it (D17)

RED: append to `app/test/contactOrgNames.test.ts` (it defines `ID`,
`seedTenant`, `patchContact`, `storedOf`, `names`):

```ts
describe('PATCH /api/contacts/:id - organization (caseworkers spec D17): D5 against BOTH lists', () => {
  const partner = { type: 'partner' as const, status: 'active' };

  it('stores an agency name or spelling as the exact entry name', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'hope atlanta' });
    expect(res.status).toBe(200);
    expect(storedOf(world, ID)?.['organization']).toBe('HOPE Atlanta');
  });

  it('accepts a housing authority too (either kind)', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'Atlanta Housing' });
    expect(res.status).toBe(200);
    expect(res.body.contact.organization).toBe('Atlanta Housing Authority');
  });

  it('refuses text on neither list: 422 org_not_on_list with field organization, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { ...partner, organization: 'HOPE Atlanta' });
    const before = structuredClone(storedOf(world, ID));
    const res = await patchContact(app, ID, { organization: 'Nowhere Org', firstName: 'Pat' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'organization', text: 'Nowhere Org', candidates: [] });
    expect(res.body.otherKind).toBeUndefined(); // both kinds are accepted: never "other kind"
    expect(storedOf(world, ID)).toEqual(before);
  });

  it('refuses an ambiguous spelling naming both candidates', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 'AHA' });
    expect(res.status).toBe(422);
    expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
  });

  it("(PIN-shaped) an unchanged off-list value passes; '' REMOVEs the attribute", async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, { ...partner, organization: 'Old Helper Org' });
    expect((await patchContact(app, ID, { organization: 'Old Helper Org', firstName: 'Pat' })).status).toBe(200);
    expect((await patchContact(app, ID, { organization: '' })).status).toBe(200);
    expect('organization' in storedOf(world, ID)!).toBe(false);
  });

  it('a non-string is a parser 400', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, partner);
    const res = await patchContact(app, ID, { organization: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('organization must be a string');
  });
});
```

and extend the existing POST pin - in
`'(PIN) drops housingAuthority and agency instead of storing them unchecked'`,
current:

```ts
        housingAuthority: 'Nowhere Housing Authority',
        agency: 'Step Up',
      });
```

replace with:

```ts
        housingAuthority: 'Nowhere Housing Authority',
        agency: 'Step Up',
        organization: 'Nowhere Org', // caseworkers spec D16: POST ignores organization too
      });
```

and after `    expect(stored !== undefined && 'agency' in stored).toBe(false);` add
`    expect(stored !== undefined && 'organization' in stored).toBe(false);`.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactOrgNames.test.ts`
- RED: the parser rejects nothing about `organization` but also drops it
  ("no updatable fields supplied" 400 for an organization-only body; the
  others store nothing), so the 200 cases fail on the stored value and the
  422 cases answer 200/400. The POST pin stays green.

GREEN - `app/src/routes/contacts.ts`:

1. In `parseTriageBody`, insert immediately before
   `  // Structured postal address (edit form). Every part optional; we store only the`:

```ts
  // Organization (caseworkers spec 2026-10-06 D17): a partner's employer,
  // checked by D5 against BOTH lists in the route. '' clears it - null ->
  // REMOVE, the `role` convention - so a cleared organization is absent.
  if ('organization' in b) {
    const v = b['organization'];
    if (typeof v !== 'string') return { error: 'organization must be a string' };
    patch['organization'] = v.length > 0 ? v : null;
    changedFields.push('organization');
  }
```

2. In the PATCH, current:

```ts
    const touchesOrgField = 'housingAuthority' in parsed.patch || 'agency' in parsed.patch;
```

   Replace with:

```ts
    const touchesOrgField =
      'housingAuthority' in parsed.patch || 'agency' in parsed.patch || 'organization' in parsed.patch;
```

3. In the D5 block, current:

```ts
      for (const field of ['housingAuthority', 'agency'] as const) {
```

   Replace with:

```ts
      // (B) organization: KINDS_FOR_FIELD.organization is both kinds, so its
      // 422 never carries otherKind (D17).
      for (const field of ['housingAuthority', 'agency', 'organization'] as const) {
```

Run the file - GREEN. Then
`cd "W:/tmp/caseworkers/app"; npx vitest run test/contactOrgNames.test.ts test/contactTriage.test.ts test/contactIntakeFields.test.ts test/trimStrings.test.ts`
- GREEN. Typecheck - exit 0 (`checkScalar('organization', ...)` needs S1's
`OrgField`).

Commit (stage `app/src/routes/contacts.ts`, `app/test/contactOrgNames.test.ts`)
`feat(caseworkers): contacts PATCH accepts organization, D5-checked against both lists (D17)`.

### Task 4.3 - PATCH: 409 `caseworker_use_conversion` on the merged kind; consistent read; `type_source` on staff overrides (D16, D21, R1-F11)

RED: append to `app/test/contactTriage.test.ts` (it imports `request`,
`TEST_SESSION_COOKIE`, `makeWebhookHarness`, `ORIGIN_SECRET` as `SECRET`):

```ts
describe('PATCH /api/contacts/:id - caseworkers (spec 2026-10-06 D16, D21)', () => {
  function seed(world: ReturnType<typeof makeWebhookHarness>['world'], over: Record<string, unknown>): void {
    world.contacts.push({ contactId: 'c-cw', status: 'onboarding', phone: '+15550107401', type: 'tenant', ...over } as never);
  }
  function send(app: import('express').Express, body: Record<string, unknown>) {
    return request(app)
      .patch('/api/contacts/c-cw')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(body);
  }
  const storedOf = (world: ReturnType<typeof makeWebhookHarness>['world']) =>
    world.contacts.find((c) => c.contactId === 'c-cw');

  for (const [label, over, body] of [
    ['partner + Caseworker on a tenant', {}, { type: 'partner', role: 'Caseworker' }],
    ['a caseworker role on a role-less partner', { type: 'partner', status: 'active' }, { role: 'case worker' }],
    ['partner on a tenant whose STORED role is Case Worker (merged)', { role: 'Case Worker' }, { type: 'partner' }],
    ['partner + Caseworker on an unknown', { type: 'unknown', status: 'needs_review' }, { type: 'partner', role: 'Caseworker' }],
  ] as const) {
    it(`409 caseworker_use_conversion: ${label}; nothing written`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, over);
      const before = structuredClone(storedOf(world));
      const res = await send(app, body);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'caseworker_use_conversion' });
      expect(storedOf(world)).toEqual(before);
      expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toEqual([]);
    });
  }

  it("(PIN) not a caseworker result: role '' clears the stored caseworker role", async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { role: 'Case Worker' });
    const res = await send(app, { type: 'partner', role: '' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ type: 'partner' });
  });

  it('(PIN) a contact already a caseworker may edit its role and fields', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'partner', status: 'active', role: 'Caseworker' });
    expect((await send(app, { role: 'case worker', firstName: 'Pat' })).status).toBe(200);
  });

  it('(PIN) Mark as Partner on an unknown stays the generic type change', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'unknown', status: 'needs_review' });
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it('404s a missing contact before the 409', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/contacts/c-none')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'partner', role: 'Caseworker' });
    expect(res.status).toBe(404);
  });

  it('reads the stored contact CONSISTENTLY when type or role is in the body', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, {});
    const seen: unknown[] = [];
    const original = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (id, opts) => {
      seen.push(opts);
      return original(id, opts);
    };
    await send(app, { type: 'landlord' }).expect(200);
    await send(app, { role: 'Inspector' }).expect(200);
    await send(app, { firstName: 'Pat' }).expect(200);
    expect(seen.slice(0, 1)).toEqual([{ consistentRead: true }]);
    expect(seen).toContainEqual({ consistentRead: true });
    // the name-only edit keeps today's eventually consistent read
    expect(seen[seen.length - 1]).toBeUndefined();
  });

  for (const [from, to] of [['tenant', 'landlord'], ['landlord', 'partner'], ['partner', 'unknown']] as const) {
    it(`stamps type_source manual on a staff override ${from} -> ${to}`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, { type: from, status: from === 'tenant' ? 'onboarding' : 'active' });
      await send(app, { type: to }).expect(200);
      expect(storedOf(world)?.['type_source']).toBe('manual');
    });
  }

  for (const [label, over, body] of [
    ['triage of an unknown', { type: 'unknown', status: 'needs_review' }, { type: 'tenant' }],
    ['the same type re-sent', {}, { type: 'tenant', firstName: 'Pat' }],
    ['a team member re-typed', { type: 'team_member', status: 'active' }, { type: 'tenant' }],
    ['no type in the body', {}, { firstName: 'Pat' }],
  ] as const) {
    it(`(PIN-shaped) no type_source stamp: ${label}`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, over);
      await send(app, body).expect(200);
      expect(storedOf(world)).not.toHaveProperty('type_source');
    });
  }

  it('(PIN) POST may create a new contact saved as Caseworker (D16) - no stamp', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'partner', role: 'Caseworker', firstName: 'Dana' });
    expect(res.status).toBe(201);
    const c = world.contacts.find((x) => x.contactId === res.body.contact.contactId);
    expect(c).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(c).not.toHaveProperty('type_source');
  });
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactTriage.test.ts`
- RED: the four 409 cases answer 200 and write a caseworker; the consistent
  read case sees `undefined`; the three override cases find no
  `type_source`. The PIN cases pass.

GREEN - `app/src/routes/contacts.ts`:

1. Add `import { isCaseworker } from '../lib/caseworkers.js';` after
   `import { parseRole, parseRelationships, parseCustomFields } from '../lib/contactProfile.js';`.

2. The stored read. Current (after Task 4.2):

```ts
    const stored = await contacts.getById(
      contactId,
      touchesOrgField ? { consistentRead: true } : undefined,
    );
```

   Replace with:

```ts
    // CONSISTENT too when the patch classifies (type or role): the caseworker
    // 409 below decides "already a caseworker" from this read (R1-F11).
    const changesClassification = 'type' in parsed.patch || 'role' in parsed.patch;
    const stored = await contacts.getById(
      contactId,
      touchesOrgField || changesClassification ? { consistentRead: true } : undefined,
    );
```

3. Insert immediately BEFORE the line
   `    // ORGANIZATION NAMES (spec 2026-10-06 D5). A housingAuthority or agency`:

```ts
    // CASEWORKERS (spec 2026-10-06 D16): the ONLY way an existing contact
    // becomes a caseworker is the conversion (POST .../caseworker-review), with
    // its refusals and writes. Refuse a write whose MERGED result - the body's
    // type/role over the stored ones, role ''/null as absent - is a caseworker
    // on a contact that is not one. Writes nothing. Any other type change keeps
    // today's behavior (D21).
    if (changesClassification) {
      if (!stored) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      const resultType = 'type' in parsed.patch ? parsed.patch['type'] : stored.type;
      const patchRole = parsed.patch['role'];
      const resultRole = 'role' in parsed.patch ? (patchRole === null ? undefined : patchRole) : stored['role'];
      if (isCaseworker({ type: resultType, role: resultRole }) && !isCaseworker(stored)) {
        log.info({ contactId }, 'contact patch refused: a caseworker is made through the conversion');
        res.status(409).json({ error: 'caseworker_use_conversion' });
        return;
      }
      // D21: a staff OVERRIDE of a typed contact (tenant, landlord or partner
      // to a different type) is stamped server-side so a re-import does not
      // revert it (lib/import/apply.ts). Triage of an unknown is not stamped.
      if (
        'type' in parsed.patch
        && (stored.type === 'tenant' || stored.type === 'landlord' || stored.type === 'partner')
        && parsed.patch['type'] !== stored.type
      ) {
        parsed.patch['type_source'] = 'manual';
      }
    }

```

   (`type_source` is not pushed to `changedFields`: like
   `staff_notes_updated_at`, it is a server stamp, so it does not join the
   provenance or suggestion loops.)

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/contactsCrud.test.ts test/contactStaffNotes.test.ts test/contactOrgNames.test.ts test/landlordContactFields.test.ts test/contactIntakeFields.test.ts test/suggestions.test.ts test/contactEmailReaders.test.ts test/contactPhones.test.ts test/contactsEmailCrud.test.ts test/trimStrings.test.ts`
- GREEN. If a pre-existing case fails ONLY because a `toEqual` on a stored
  contact now carries `type_source: 'manual'` after a staff re-type, add
  `type_source: 'manual'` to that expectation with a one-line comment citing
  D21 and list it in the commit body; any other failure: STOP and report.
  The generic thread flip pin (`contactTriage.test.ts`, "no re-type of a
  resolved thread") stays green unchanged.

Typecheck - exit 0.

Commit (stage `app/src/routes/contacts.ts`, `app/test/contactTriage.test.ts`
and any test amended above)
`feat(caseworkers): PATCH refuses making a caseworker (409) and stamps type_source on overrides (D16, D21)`.

### Task 4.4 - the caseworker-review routes, the router wiring, `unitsRepo` (D19, D22, R1-F6)

RED: create `app/test/caseworkerReviewApi.test.ts`:

```ts
// The caseworker-review routes (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.5) through the full /api app on the harness world. The
// service's rules are proved in caseworkerConversion.test.ts; this file proves
// the wire: paths, route order, bodies, error shapes, and that the router got
// the world's units, placements and tours repos (a landlord-of-record refusal
// can only come from world.unitsRepo).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { phoneRefId } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-api-1';

function seed(world: FakeWorld, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: ID, type: 'tenant', status: 'onboarding', phone: '+15550107501',
    firstName: 'Ana', lastName: 'Ruiz', ...over,
  } as ContactItem);
}

function get(app: import('express').Express, path: string) {
  return request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
}

function post(app: import('express').Express, contactId: string, body: unknown) {
  return request(app)
    .post(`/api/contacts/${contactId}/caseworker-review`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body as object);
}

describe('GET /api/contacts/possible-caseworkers', () => {
  it('answers { rows } - registered before /:contactId, so the segment is not a contact id', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { contactId: 'p-api', type: 'partner', status: 'active', lastName: 'Stamp-0710' });
    const res = await get(app, '/api/contacts/possible-caseworkers');
    expect(res.status).toBe(200);
    expect(res.body.rows).toContainEqual(expect.objectContaining({
      contactId: 'p-api', type: 'partner', signals: ['partner_no_role'],
    }));
  });

  it('(PIN) GET /api/contacts/vocabulary still answers', async () => {
    const { app } = makeWebhookHarness();
    expect((await get(app, '/api/contacts/vocabulary')).status).toBe(200);
  });
});

describe('GET /api/contacts/:contactId/caseworker-review/preview', () => {
  it('answers the preview, refusals included', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    world.units.set('u-api', { unitId: 'u-api', status: 'available', landlordId: ID } as UnitItem);
    const res = await get(app, `/api/contacts/${ID}/caseworker-review/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contactId: ID,
      alreadyCaseworker: false,
      refusals: [{ code: 'caseworker_landlord_of_record', unitId: 'u-api' }],
      removes: { pendingSuggestions: 0 },
      threads: { retype: 0, leftShared: 0, leftOther: 0 },
      organization: { source: 'none' },
    });
  });

  it('404s a missing contact and a pointer id; 400s a team member', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    await world.contactsRepo.addPhone(ID, { phone: '+15550107502' });
    seed(world, { contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550107503' });
    expect((await get(app, '/api/contacts/c-none/caseworker-review/preview')).body).toEqual({ error: 'contact_not_found' });
    const ptr = await get(app, `/api/contacts/${encodeURIComponent(phoneRefId('+15550107502'))}/caseworker-review/preview`);
    expect([ptr.status, ptr.body]).toEqual([404, { error: 'contact_not_found' }]);
    const team = await get(app, '/api/contacts/c-team/caseworker-review/preview');
    expect([team.status, team.body]).toEqual([400, { error: 'caseworker_team_member' }]);
  });
});

describe("POST /api/contacts/:contactId/caseworker-review { action: 'make' }", () => {
  it('converts and answers { contact }; the record and the audit name the session user', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { agency: 'Hope Atlanta' });
    const res = await post(app, ID, { action: 'make' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      contactId: ID, type: 'partner', role: 'Caseworker', status: 'active', organization: 'HOPE Atlanta',
      caseworker_conversion: { by: TEST_SESSION_USER.userId, fromType: 'tenant', agency: 'Hope Atlanta' },
    });
    expect(world.auditEvents.find((e) => e.event_type === 'contact_updated')?.actorId).toBe(TEST_SESSION_USER.userId);
  });

  it('409 with the first refusal code and every refusal', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    world.units.set('u-api', { unitId: 'u-api', status: 'available', landlordId: ID } as UnitItem);
    const res = await post(app, ID, { action: 'make' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'caseworker_landlord_of_record',
      refusals: [{ code: 'caseworker_landlord_of_record', unitId: 'u-api' }],
    });
  });

  it('422 org_not_on_list in A shape for an organization on neither list', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world);
    const res = await post(app, ID, { action: 'make', organization: 'Nowhere Org' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'organization', text: 'Nowhere Org' });
  });

  it('a staff pick wins over the derived organization', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { agency: 'Hope Atlanta' });
    const res = await post(app, ID, { action: 'make', organization: 'Step Up' });
    expect(res.body.contact.organization).toBe('Step Up');
  });
});

describe("POST /api/contacts/:contactId/caseworker-review { action: 'dismiss' }", () => {
  it('dismisses and answers { contact }; the row leaves the Possible list', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'partner', status: 'active' });
    const res = await post(app, ID, { action: 'dismiss' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ contactId: ID, caseworker_review: 'dismissed' });
    const list = await get(app, '/api/contacts/possible-caseworkers');
    expect(list.body.rows.map((r: { contactId: string }) => r.contactId)).not.toContain(ID);
  });

  it('400 caseworker_dismiss_not_allowed on an unknown; 404 on a missing contact', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, { type: 'unknown', status: 'needs_review' });
    expect((await post(app, ID, { action: 'dismiss' })).body).toEqual({ error: 'caseworker_dismiss_not_allowed' });
    const missing = await post(app, 'c-none', { action: 'dismiss' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'contact_not_found' }]);
  });
});

describe('POST /api/contacts/:contactId/caseworker-review - body validation', () => {
  for (const body of [
    {},
    { action: 'convert' },
    { action: 'make', organization: 7 },
    { action: 'make', type: 'partner' },
    { action: 'dismiss', organization: 'Step Up' },
    { action: 'dismiss', note: 'x' },
    ['make'],
  ]) {
    it(`400 invalid_body for ${JSON.stringify(body)}, nothing written`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, { type: 'partner', status: 'active' });
      const before = structuredClone(world.contacts);
      const res = await post(app, ID, body);
      expect([res.status, res.body]).toEqual([400, { error: 'invalid_body' }]);
      expect(world.contacts).toEqual(before);
    });
  }
});
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerReviewApi.test.ts`
- RED: `GET /possible-caseworkers` is captured by `GET /:contactId` and
  answers 404 `contact_not_found`; the preview and review paths have no
  handler (404 from Express); the vocabulary PIN passes.

GREEN:

1. Create `app/src/routes/caseworkerReview.ts`:

```ts
// The caseworker-review routes (caseworkers spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19, D22; plan 3.5), registered on the contacts router BEFORE its
// /:contactId handlers (createContactsRouter calls this right after
// GET /vocabulary), so the literal `possible-caseworkers` segment is never
// captured as a contact id.
//
//   GET  /api/contacts/possible-caseworkers                  -> { rows }
//   GET  /api/contacts/:contactId/caseworker-review/preview  -> CaseworkerPreview
//   POST /api/contacts/:contactId/caseworker-review
//        { action: 'make', organization? }                   -> { contact }
//        { action: 'dismiss' }                               -> { contact }
//
// Open to every signed-in user (D19), as the edit form's type change is.
// Errors are `{ error: code, ...extras }`; the dashboard owns every sentence.
import type { Response, Router } from 'express';
import { mergeContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import {
  CaseworkerReviewError,
  type CaseworkerConversionService,
} from '../services/caseworkerConversion.js';
import { listPossibleCaseworkers } from '../services/possibleCaseworkers.js';

export interface CaseworkerRoutesDeps {
  contacts: ContactsRepo;
  conversion: CaseworkerConversionService;
  logger: Logger;
}

type ReviewBody = { action: 'make'; organization?: string } | { action: 'dismiss' };

/** Strict: only `action` (+ `organization` for make); anything else is invalid_body. */
function parseReviewBody(body: unknown): ReviewBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (b['action'] === 'dismiss') {
    return keys.every((k) => k === 'action') ? { action: 'dismiss' } : undefined;
  }
  if (b['action'] !== 'make') return undefined;
  if (!keys.every((k) => k === 'action' || k === 'organization')) return undefined;
  if (!('organization' in b)) return { action: 'make' };
  const organization = b['organization'];
  return typeof organization === 'string' ? { action: 'make', organization } : undefined;
}

/** A CaseworkerReviewError becomes its status + `{ error, ...extras }`; anything else rethrows (500). */
function sendReviewError(res: Response, err: unknown): void {
  if (!(err instanceof CaseworkerReviewError)) throw err;
  res.status(err.status).json({ error: err.code, ...err.extras });
}

export function registerCaseworkerRoutes(router: Router, deps: CaseworkerRoutesDeps): void {
  const log = deps.logger;

  router.get('/possible-caseworkers', async (_req, res) => {
    const rows = await listPossibleCaseworkers({ contacts: deps.contacts });
    res.json({ rows });
  });

  router.get('/:contactId/caseworker-review/preview', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    try {
      res.json(await deps.conversion.preview(contactId));
    } catch (err) {
      sendReviewError(res, err);
    }
  });

  router.post('/:contactId/caseworker-review', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const body = parseReviewBody(req.body);
    if (body === undefined) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    // The actor is the session userId - the audit's `actor` and
    // caseworker_conversion.by (plan 3.2: a userId, never an email).
    const actor = req.user?.userId ?? 'unknown';
    try {
      const contact = body.action === 'make'
        ? await deps.conversion.make(contactId, {
            actor,
            ...(body.organization !== undefined && { organization: body.organization }),
          })
        : await deps.conversion.dismiss(contactId, actor);
      log.info({ contactId, action: body.action, actor }, 'caseworker review applied');
      res.json({ contact });
    } catch (err) {
      sendReviewError(res, err);
    }
  });
}
```

2. `app/src/routes/contacts.ts`:

   a. After the `import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';`
      line add:

```ts
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createCaseworkerConversionService,
  type CaseworkerConversionService,
} from '../services/caseworkerConversion.js';
import { registerCaseworkerRoutes } from './caseworkerReview.js';
```

   b. In `ContactsRouterDeps`, current:

```ts
  orgNamesService?: OrgNamesService;
}
```

      (the end of the interface - the line after the D5 doc comment) Replace with:

```ts
  orgNamesService?: OrgNamesService;
  /**
   * Caseworkers (spec 2026-10-06 D19, D22): the conversion's landlord-of-record
   * and roster refusals read units, soft-deleted ones included.
   */
  unitsRepo?: UnitsRepo;
  /** Test seam: the caseworker conversion; built from this router's repos by default. */
  caseworkerConversion?: CaseworkerConversionService;
}
```

   c. Current:

```ts
  const orgNames = deps.orgNamesService ?? createOrgNamesService({ logger: deps.logger });
```

      Replace with:

```ts
  const orgNames = deps.orgNamesService ?? createOrgNamesService({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  // ONE conversion service over the SAME repos and bus the PATCH uses for the
  // same effects (spec D19).
  const caseworkerConversion =
    deps.caseworkerConversion
    ?? createCaseworkerConversionService({
      contacts,
      conversations,
      placements,
      tours,
      units,
      extraction,
      aiRuns,
      audit,
      activityEvents,
      vocabulary,
      events,
      orgNames,
      logger: log,
    });
```

      (Before editing, `grep -n "const units\b\|const units =" "W:/tmp/caseworkers/app/src/routes/contacts.ts"`
      must print nothing - no existing local named `units`.)

   d. Current:

```ts
  router.get('/vocabulary', async (_req, res) => {
    const vocab = await vocabulary.get();
    res.json({ vocabulary: vocab });
  });
```

      Replace with:

```ts
  router.get('/vocabulary', async (_req, res) => {
    const vocab = await vocabulary.get();
    res.json({ vocabulary: vocab });
  });

  // Caseworkers (spec 2026-10-06 D19): GET /possible-caseworkers is a literal
  // segment, so it MUST be registered before GET /:contactId (as /vocabulary is).
  registerCaseworkerRoutes(router, { contacts, conversion: caseworkerConversion, logger: log });
```

3. `app/src/routes/api.ts`, the `/contacts` mount of `createContactsRouter`.
   Current:

```ts
      // Triage re-extraction hook: a flip to tenant schedules an immediate
      // 'triage' run (gated by the same kill switch as the other schedule sites).
      aiExtractionEnabled: config.aiExtractionEnabled,
```

   Replace with:

```ts
      // Triage re-extraction hook: a flip to tenant schedules an immediate
      // 'triage' run (gated by the same kill switch as the other schedule sites).
      aiExtractionEnabled: config.aiExtractionEnabled,
      // Caseworkers (spec 2026-10-06 D19, D22): the conversion's unit refusals.
      unitsRepo: units,
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerReviewApi.test.ts test/contactTriage.test.ts test/contactsCrud.test.ts test/contactOrgNames.test.ts`
- GREEN. Typecheck - exit 0. Lint the touched files (no new error):
  `cd "W:/tmp/caseworkers"; npx eslint app/src/routes/caseworkerReview.ts app/src/routes/contacts.ts app/src/routes/api.ts app/test/caseworkerReviewApi.test.ts`.

Commit (stage `app/src/routes/caseworkerReview.ts`,
`app/src/routes/contacts.ts`, `app/src/routes/api.ts`,
`app/test/caseworkerReviewApi.test.ts`)
`feat(caseworkers): caseworker-review routes and the possible-caseworkers read on the contacts router (D19)`.

### Task 4.5 - the importer leaves a manual type alone (D21, R1-F5)

RED: append to `app/test/importApply.integration.test.ts`, inside the
`describe.skipIf(!reachable)('import:apply', ...)` block, immediately after
the case `it('does NOT revert a status a human set after the import', ...)`
(its closing `});`):

```ts
  it('leaves type, status, housing authority and agency alone on a contact whose type_source is manual (caseworkers D21)', async () => {
    const contactOf = async (phone: string): Promise<Record<string, unknown>> =>
      (await doc.send(
        new GetCommand({ TableName: table('contacts'), Key: { contactId: contactIdForPhone(phone) } }),
      )).Item!;
    const apply = () =>
      runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv, orgEntries: ORG_ENTRIES });
    await apply();
    expect(await contactOf(PHONES.conflictResolved)).toMatchObject({
      type: 'tenant', housingAuthority: 'Atlanta Housing Authority',
    });

    // A caseworker conversion (Vera) and a staff override (Ines), as their
    // commit writes leave them.
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new UpdateCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.conflictResolved) },
        UpdateExpression: 'SET #t = :partner, #r = :role, #s = :active, type_source = :manual, agency = :empty REMOVE housingAuthority',
        ExpressionAttributeNames: { '#t': 'type', '#r': 'role', '#s': 'status' },
        ExpressionAttributeValues: { ':partner': 'partner', ':role': 'Caseworker', ':active': 'active', ':manual': 'manual', ':empty': '' },
      }),
    );
    await doc.send(
      new UpdateCommand({
        TableName: table('contacts'),
        Key: { contactId: contactIdForPhone(PHONES.caseworker) },
        UpdateExpression: 'SET type_source = :manual REMOVE agency',
        ExpressionAttributeValues: { ':manual': 'manual' },
      }),
    );

    await apply();
    const vera = await contactOf(PHONES.conflictResolved);
    expect(vera).toMatchObject({ type: 'partner', role: 'Caseworker', status: 'active', type_source: 'manual', agency: '' });
    expect('housingAuthority' in vera).toBe(false);
    expect('agency' in (await contactOf(PHONES.caseworker))).toBe(false);
    // (PIN) the import still owns what it owns: the name and the phone.
    expect(vera).toMatchObject({ phone: PHONES.conflictResolved, firstName: 'Vera' });
  });
```

(Check the fixture's resolved name for `PHONES.conflictResolved` before
running: `grep -n "Vera" "W:/tmp/caseworkers/app/test/importFixture.ts"`; if
the reviewed first name is not `Vera`, use the fixture's value.)

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/importApply.integration.test.ts`
- RED: the re-apply SETs `type` back to `tenant`, the status back to the
  import's (its `status_source` is `import`), refills `housingAuthority`
  (`if_not_exists` after the REMOVE) and refills Ines's agency. (DynamoDB
  Local must be up; a skipped suite is not RED.)

GREEN - `app/src/lib/import/apply.ts`, `upsertContact`:

1. Current:

```ts
  const prior = existing.Item as { status_source?: string; status?: string } | undefined;
```

   Replace with:

```ts
  const prior = existing.Item as
    | { status_source?: string; status?: string; type_source?: string }
    | undefined;
  // STAFF OVERRODE THE TYPE (caseworkers spec 2026-10-06 D21): a stamped
  // `type_source: 'manual'` (a staff re-type or the caseworker conversion)
  // means the import's type and status were computed for a type staff
  // replaced, and the conversion removed the authority on purpose - so this
  // run writes none of type, status, housingAuthority or agency. A
  // read-then-write like preserveStatus below (R1-F5, accepted): a stamp
  // landing between the read and the write is not seen, and an import never
  // bumps classification_revision, so the conversion's guard does not cover
  // imports either.
  const manualType = prior?.type_source === 'manual';
```

2. Current:

```ts
  const preserveStatus =
    prior !== undefined &&
    prior.status !== undefined &&
    prior.status_source !== IMPORT_STATUS_SOURCE;

  const sets: string[] = [
    '#type = :type',
    'phone = :phone',
```

   Replace with:

```ts
  const preserveStatus =
    manualType ||
    (prior !== undefined &&
      prior.status !== undefined &&
      prior.status_source !== IMPORT_STATUS_SOURCE);

  const sets: string[] = [
    'phone = :phone',
```

3. Current:

```ts
  const values: Record<string, unknown> = {
    ':type': resolved.type,
    ':phone': person.phone,
```

   Replace with:

```ts
  const values: Record<string, unknown> = {
    ':phone': person.phone,
```

   and current:

```ts
  const names: Record<string, string> = { '#type': 'type' };
```

   Replace with:

```ts
  const names: Record<string, string> = {};
  if (!manualType) {
    sets.unshift('#type = :type');
    values[':type'] = resolved.type;
    names['#type'] = 'type';
  }
```

4. Current:

```ts
  if (resolved.housingAuthority) {
    sets.push('housingAuthority = if_not_exists(housingAuthority, :housingAuthority)');
```

   Replace with:

```ts
  if (resolved.housingAuthority && !manualType) {
    sets.push('housingAuthority = if_not_exists(housingAuthority, :housingAuthority)');
```

   and current:

```ts
  if (resolved.agency) {
    sets.push('#agency = if_not_exists(#agency, :agency)');
```

   Replace with:

```ts
  if (resolved.agency && !manualType) {
    sets.push('#agency = if_not_exists(#agency, :agency)');
```

5. The `UpdateCommand` sends `ExpressionAttributeNames: names` - with a
   manual type and no agency/status clause, `names` can now be EMPTY, which
   DynamoDB rejects. Current:

```ts
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
```

   Replace with:

```ts
      UpdateExpression: `SET ${sets.join(', ')}`,
      // An empty names map is a ValidationException (a manual-type contact
      // with no agency clause binds no name at all).
      ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
      ExpressionAttributeValues: values,
```

   (With `preserveStatus` now true for a manual type, the existing
   `if (!preserveStatus)` block already skips the status clause; the
   function's return - counted as `statusPreserved` - now also counts a
   manual-type contact, which is what happened to its status. The docblock
   of `upsertContact` gains one sentence: "A contact whose `type_source` is
   'manual' keeps its type, status, housing authority and agency (D21).")

Run the file - GREEN (every pre-existing case unchanged: no fixture contact
carries `type_source`). Then
`cd "W:/tmp/caseworkers/app"; npx vitest run test/importApply.integration.test.ts test/importOrgNames.test.ts`
- GREEN. Typecheck - exit 0.

Commit (stage `app/src/lib/import/apply.ts`,
`app/test/importApply.integration.test.ts`)
`feat(caseworkers): the importer leaves a manually typed contact's type, status and org fields alone (D21)`.

### S4 close-out

After Task 4.5, from the worktree root:
`cd "W:/tmp/caseworkers"; npm run typecheck` (exit 0) and
`cd "W:/tmp/caseworkers/app"; npx vitest run test/caseworkerConversion.test.ts test/possibleCaseworkers.test.ts test/contactClassification.test.ts test/caseworkerReviewApi.test.ts test/contactTriage.test.ts test/contactsCrud.test.ts test/contactOrgNames.test.ts test/aiRunVerdicts.test.ts test/unitsRepo.integration.test.ts test/importApply.integration.test.ts`
- all green. The full `npm test` runs at the plan's CP checkpoint, not here.

## S5 - organization in the org-list server

Files: `app/src/repos/contactsRepo.ts`, `app/src/repos/orgListRepo.ts`,
`app/src/services/orgRecords.ts`, `app/src/services/orgRewrite.ts`,
`app/src/services/orgNames.ts`, `app/src/routes/organizations.ts`,
`app/src/routes/dev.ts`, `app/scripts/clean-org-names.ts` (comment),
`app/test/helpers/twilioWebhookHarness.ts`; tests
`app/test/orgRecordWriters.integration.test.ts`, `app/test/orgRecords.test.ts`,
`app/test/orgRewriteService.test.ts`, `app/test/orgRewriteJob.test.ts`,
`app/test/organizationsApi.test.ts`, `app/test/orgNamesService.test.ts`,
`app/test/devOrgFixture.test.ts`; e2e `e2e/fixtures/orgFixture.ts`,
`e2e/tests/dashboard-next/org-lists.spec.ts`, `e2e/README.md`,
`e2e/support/selectors.md`.

Depends on S1 (`OrgField` has `'organization'`,
`KINDS_FOR_FIELD.organization = ['housing_authority', 'agency']`) and S2
(`ContactItem.organization?: string`). Every anchor below is unique text at
the branch base; match the TEXT.

Pins this slice changes (each is edited in the task named):

| pin | task |
|---|---|
| `app/test/orgRecords.test.ts` `const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };` | 5.2 |
| `app/test/orgRewriteJob.test.ts` same `const ZERO = ...` line | 5.2 |
| `app/test/orgRewriteService.test.ts` rename `fields: ['housingAuthority', 'accepted_authorities'],` under `// Fixed NOW, from the entry's kind (spec 5.1)` | 5.2 |
| `app/test/orgRewriteService.test.ts` merge `fields: ['housingAuthority', 'accepted_authorities'],` under `// AHA is shared with Atlanta - another entry - so it is no from-text.` | 5.2 |
| `app/test/organizationsApi.test.ts` `counts: { housingAuthority: 2, agency: 0, accepted_authorities: 1, skipped: 0, conflicts: 0 },` | 5.2 |
| `app/test/orgRecords.test.ts` the first usage `toEqual` (`'org-atl': { tenants: 1, otherContacts: 1, properties: 2, deleted: 1 },` ...) | 5.3 |
| `app/test/organizationsApi.test.ts` `expect(res.body.usage['org-atl']).toEqual({ tenants: 1, otherContacts: 0, properties: 1, deleted: 1 });` and the `org-stepup` line after it | 5.3 |
| `app/test/organizationsApi.test.ts` kind change `uses: { active: 0, deleted: 1 }` and delete `uses: { active: 1, deleted: 0 }` | 5.3 (PIN - unchanged, now from the totals) |
| `e2e/fixtures/orgFixture.ts` `OrgUsageWire`; `e2e/tests/dashboard-next/org-lists.spec.ts` usage `toEqual` | 5.3 |
| `app/test/devOrgFixture.test.ts` `'field must be housingAuthority or agency for a contact',` | 5.7 |
| `app/test/orgRewriteService.test.ts` `:711` cleanup lock fields, `:547`/`:620-630`/`:679` value-action fields | none (PIN) |
| `app/test/contactOrgNames.test.ts` "checks housingAuthority first" | none (S4 keeps organization last) |

### Task 5.1 - `contactsRepo.rewriteOrgFields` writes `organization` (repo + FakeWorld, parity)

Files: `app/src/repos/contactsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/orgRecordWriters.integration.test.ts`.

RED: in `app/test/orgRecordWriters.integration.test.ts`, inside
`describe('contactsRepo.rewriteOrgFields (plan 3.7)', () => {`, after the
case `parity('skips an unknown contact', async (w, id) => {` (its closing
`});`), add:

```ts
  // Branch B (spec D17): a contact's organization is rewritten like the other
  // two fields - conditional on the text read, null REMOVEs (the role
  // convention: never SET ''), nothing else written.
  parity('SETs and REMOVEs organization while it still holds the expected text; refuses an empty string', async (w, id) => {
    await w.putContact({
      contactId: id,
      type: 'partner',
      status: 'active',
      role: 'Caseworker',
      organization: 'Steps',
      classification_revision: 2,
    });
    await expect(w.contacts.rewriteOrgFields(id, { organization: 'Steps' }, { organization: '' })).rejects.toThrow(
      /organization/,
    );
    expect(await w.contacts.rewriteOrgFields(id, { organization: 'Edited' }, { organization: 'Step Up' })).toBe('skipped');
    expect(await w.contacts.rewriteOrgFields(id, { organization: 'Steps' }, { organization: 'Step Up' })).toBe('written');
    expect(await w.readContact(id)).toEqual({
      contactId: id,
      type: 'partner',
      status: 'active',
      role: 'Caseworker',
      organization: 'Step Up',
      classification_revision: 2,
    });
    expect(await w.contacts.rewriteOrgFields(id, { organization: 'Step Up' }, { organization: null })).toBe('written');
    expect(await w.readContact(id)).toEqual({
      contactId: id,
      type: 'partner',
      status: 'active',
      role: 'Caseworker',
      classification_revision: 2,
    });
  });

  parity('guards organization - null means absent - together with the other two', async (w, id) => {
    await w.putContact({ contactId: id, type: 'partner', status: 'active', agency: 'Step Up' });
    expect(await w.contacts.rewriteOrgFields(id, { organization: 'Step Up' }, { organization: 'X' })).toBe('skipped');
    expect(
      await w.contacts.rewriteOrgFields(id, { agency: 'Step Up', organization: null }, { organization: 'Step Up' }),
    ).toBe('written');
    expect((await w.readContact(id))?.['organization']).toBe('Step Up');
    expect((await w.readContact(id))?.['agency']).toBe('Step Up');
  });
```

Run: `cd "W:/tmp/caseworkers"; npm run db:start` (a START only), then
`cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecordWriters.integration.test.ts`.
Expected RED: both new cases fail on BOTH halves - the real repo and the fake
ignore `organization` in `expect` and `next`, so the first call does not
throw for `''` and the writes throw `rewriteOrgFields: nothing to write`.
(`npm run typecheck` is also red: the parameter types lack `organization`.)

Implement:

1. `app/src/repos/contactsRepo.ts`, the interface doc above
   `rewriteOrgFields(` (starts `* Organization-name rewrite (spec 2026-10-06 D11; plan 3.7) for the`):
   replace the sentence "`expect` checks housingAuthority and/or agency" with
   "`expect` checks housingAuthority, agency and/or organization (branch B,
   spec D17)" and append before "Writes nothing else":
   "`next.organization` null REMOVEs it; `''` is refused (the `role`
   convention - an organization is never stored empty)."
   Replace the signature lines:

   ```ts
       expect: { housingAuthority?: string | null; agency?: string | null },
       next: { housingAuthority?: string | null; agency?: string },
   ```

   with:

   ```ts
       expect: { housingAuthority?: string | null; agency?: string | null; organization?: string | null },
       next: { housingAuthority?: string | null; agency?: string; organization?: string | null },
   ```

2. Same file, the implementation `async rewriteOrgFields(contactId, expected, next) {`:
   - after `if (next.housingAuthority === '') throw new EmptyIndexKeyError('housingAuthority');` add:

     ```ts
           // Branch B (spec D17): an organization is never stored empty - null is the REMOVE.
           if (next.organization === '') throw new Error("rewriteOrgFields: organization '' - pass null to REMOVE it");
     ```

   - widen the guard's first parameter:
     `const guard = (attr: 'housingAuthority' | 'agency' | 'organization', alias: string, want: string | null | undefined): void => {`
   - after `guard('agency', '#ag', expected.agency);` add
     `guard('organization', '#org', expected.organization);`
   - after the `if (next.agency !== undefined) {` block (ends `sets.push('#ag = :next_agency');` / `}`) add:

     ```ts
           if (next.organization !== undefined) {
             names['#org'] = 'organization';
             if (next.organization === null) removes.push('#org');
             else {
               values[':next_organization'] = next.organization;
               sets.push('#org = :next_organization');
             }
           }
     ```

3. `app/test/helpers/twilioWebhookHarness.ts`, the fake
   `async rewriteOrgFields(contactId, expected, next) {` (its comment starts
   `// Organization-name rewrite (plan 3.7): mirror the real conditional`):
   - after `if (next.housingAuthority === '') throw new EmptyIndexKeyError('housingAuthority');` add
     `if (next.organization === '') throw new Error("rewriteOrgFields: organization '' - pass null to REMOVE it");`
   - replace `if (next.housingAuthority === undefined && next.agency === undefined) {` with
     `if (next.housingAuthority === undefined && next.agency === undefined && next.organization === undefined) {`
   - replace `for (const attr of ['housingAuthority', 'agency'] as const) {` with
     `for (const attr of ['housingAuthority', 'agency', 'organization'] as const) {`
   - after `if (next.agency !== undefined) contact['agency'] = next.agency;` add:

     ```ts
           if (next.organization === null) delete contact['organization'];
           else if (next.organization !== undefined) contact['organization'] = next.organization;
     ```

   - in the comment above, change "both guards checked BEFORE" to "every guard checked BEFORE".

GREEN: the same vitest command (both halves green), then
`cd "W:/tmp/caseworkers"; npm run typecheck` (the throwing stub fakes in
`audienceResolution.test.ts`, `contactCapture.test.ts`,
`scheduledSendSuppression.test.ts`, `sendMessage.test.ts` and the wrappers in
`cleanOrgNames.test.ts` compile unchanged - the change is additive).

Commit: `cd "W:/tmp/caseworkers"; git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/repos/contactsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/orgRecordWriters.integration.test.ts; git commit -m "feat(caseworkers): rewriteOrgFields writes a contact's organization (repo + fake, parity)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.2 - the rewrite pass covers `organization`; rename and merge list it LAST

Files: `app/src/repos/orgListRepo.ts`, `app/src/services/orgRecords.ts`,
`app/src/services/orgRewrite.ts` (header comment only),
`app/scripts/clean-org-names.ts` (comment only); tests
`app/test/orgRecords.test.ts`, `app/test/orgRewriteService.test.ts`,
`app/test/orgRewriteJob.test.ts`, `app/test/organizationsApi.test.ts`.

RED 1: `app/test/orgRecords.test.ts`, inside
`describe('OrgRecordsService.rewrite - one conditional pass over one field (spec D11)', () => {`,
after the case that starts
`it('use on the agency field; clear REMOVEs a housing authority, stores an empty agency, drops a list member', async () => {`
(its closing `});`), add:

```ts
  it('an organization pass: use, clear REMOVEs, rename - holders of any type, deleted included (spec D17)', async () => {
    const { world, records } = setup({
      contacts: [
        contact('p-1', { type: 'partner', status: 'active', role: 'Caseworker', organization: 'Steps' }),
        contact('p-2', { type: 'partner', status: 'active', organization: 'Junk Org' }),
        contact('t-1', { organization: ATLANTA.name, deleted_at: DELETED_AT }),
        contact('t-2', { housingAuthority: 'Steps' }), // another field: an organization pass never reads it
      ],
    });
    const use = runningRewrite({ action: 'use', field: 'organization', fromTexts: ['Steps'], toName: STEP_UP.name });
    expect(await records.rewrite(use, OPTS)).toEqual({ ...ZERO, organization: 1 });
    expect(contactIn(world, 'p-1')?.['organization']).toBe(STEP_UP.name);
    expect(contactIn(world, 't-2')?.['housingAuthority']).toBe('Steps');
    const clear = runningRewrite({ action: 'clear', field: 'organization', fromTexts: ['Junk Org'] });
    expect(await records.rewrite(clear, OPTS)).toEqual({ ...ZERO, organization: 1 });
    expect(contactIn(world, 'p-2')).not.toHaveProperty('organization'); // REMOVEd, never ''
    const rename = runningRewrite({ action: 'rename', field: 'organization', fromTexts: [ATLANTA.name], toName: NEW });
    expect(await records.rewrite(rename, OPTS)).toEqual({ ...ZERO, organization: 1 });
    expect(contactIn(world, 't-1')?.['organization']).toBe(NEW);
    expect(rewrites(world).find((e) => e.entityKey === 'contacts#p-2')?.payload).toEqual({
      field: 'organization',
      from: 'Junk Org',
      to: '',
      action: 'clear',
      actor: 'usr_admin',
    });
  });

  it('(PIN) Move and Split never rewrite organization - the pass stops before any record', async () => {
    const { world, records } = setup({ contacts: [contact('p-1', { type: 'partner', status: 'active', organization: 'X' })] });
    for (const def of [
      runningRewrite({ action: 'move_to_agency', field: 'organization', fromTexts: ['X'], toName: STEP_UP.name }),
      runningRewrite({ action: 'split', field: 'organization', fromTexts: ['X'], toName: DCA.name, agencyName: VASH.name }),
    ]) {
      await expect(records.rewrite(def, OPTS)).rejects.toBeInstanceOf(OrgRewriteAbortedError);
    }
    expect(contactIn(world, 'p-1')?.['organization']).toBe('X');
  });
```

In the same file replace
`const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };` with
`const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, organization: 0, skipped: 0, conflicts: 0 };`.

RED 2: `app/test/orgRewriteService.test.ts`:
- in the rename case, replace the pinned
  `fields: ['housingAuthority', 'accepted_authorities'],` (the line under
  `// Fixed NOW, from the entry's kind (spec 5.1): the job never looks the target up again.`) with
  `fields: ['housingAuthority', 'accepted_authorities', 'organization'],`;
- in `it('moves the name and every spelling onto the target and removes the merged entry, in ONE write', async () => {`
  replace its `fields: ['housingAuthority', 'accepted_authorities'],` with
  `fields: ['housingAuthority', 'accepted_authorities', 'organization'],`;
- inside `describe('OrgRewriteService.rename (spec D11, D12)', () => {`, after the
  first case's closing `});`, add:

```ts
  it('a rename or merge of EITHER kind also rewrites organization, listed LAST (spec D17; R2-F2)', async () => {
    const ha = await rewriteService();
    expect((await ha.svc.rename('org-dca', 'Georgia Community Affairs', 'u')).lastRewrite.fields).toEqual([
      'housingAuthority',
      'accepted_authorities',
      'organization',
    ]);
    const agency = await rewriteService();
    expect((await agency.svc.rename('org-stepup', 'Step Up Atlanta', 'u')).lastRewrite.fields).toEqual([
      'agency',
      'organization',
    ]);
    const STEP_TWO = orgEntry({ orgId: 'org-step2', kind: 'agency', name: 'Step Up Two' });
    const merged = await rewriteService({ entries: [...ORG_FIXTURE, STEP_TWO] });
    expect((await merged.svc.merge('org-step2', 'org-stepup', 'u')).lastRewrite.fields).toEqual(['agency', 'organization']);
  });
```

RED 3: `app/test/orgRewriteJob.test.ts`: replace
`const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };` with
`const ZERO = { housingAuthority: 0, agency: 0, accepted_authorities: 0, organization: 0, skipped: 0, conflicts: 0 };`
and, after the case
`it('a rename runs one pass per STORED field (fixed when it started) and sums the counts', async () => {`
(its closing `});`), add:

```ts
  it('an agency rename runs its organization pass too, and sums the counts (spec D17)', async () => {
    const NEW = 'Step Up Atlanta';
    const entries = ORG_FIXTURE.map((e) => (e.orgId === STEP_UP.orgId ? { ...e, name: NEW } : e));
    const { world, deps } = await jobWorld(
      fresh(
        runningRewrite({
          jobId: 'job-1',
          action: 'rename',
          fromTexts: [STEP_UP.name],
          fields: ['agency', 'organization'],
          toName: NEW,
        }),
      ),
      {
        entries,
        contacts: [
          { contactId: 't-1', type: 'tenant', status: 'searching', agency: STEP_UP.name },
          { contactId: 'p-1', type: 'partner', status: 'active', role: 'Caseworker', organization: STEP_UP.name },
        ],
      },
    );
    expect(await runOrgRewriteJob({ jobId: 'job-1' }, deps)).toEqual({
      outcome: 'done',
      counts: { ...ZERO, agency: 1, organization: 1 },
    });
    expect(world.contacts.map((c) => [c['agency'], c['organization']])).toEqual([
      [NEW, undefined],
      [undefined, NEW],
    ]);
  });
```

RED 4 (pin): `app/test/organizationsApi.test.ts`, in
`it('(PIN) an admin rename answers 202, then the job rewrites every holder and records done', async () => {`
replace
`counts: { housingAuthority: 2, agency: 0, accepted_authorities: 1, skipped: 0, conflicts: 0 },` with
`counts: { housingAuthority: 2, agency: 0, accepted_authorities: 1, organization: 0, skipped: 0, conflicts: 0 },`.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecords.test.ts test/orgRewriteService.test.ts test/orgRewriteJob.test.ts test/organizationsApi.test.ts`.
Expected RED (plan review R1 ruling S10): the organization pass case fails
on its FIRST count. At HEAD `planContactRewrite`'s
`default: // rename, merge, use` branch sends any non-housing-authority
field to an `agency` write CONDITIONAL on `agency` still holding the value;
p-1 holds no agency, so `rewriteOrgFields` misses its condition and the pass
answers `{ housingAuthority: 0, agency: 0, accepted_authorities: 0,
skipped: 1, conflicts: 0 }` - a `skipped: 1` and no `organization` key -
and p-1 keeps `'Steps'`. Every other `ZERO` comparison misses
`organization: 0`; the rename/merge `fields` lack `'organization'`; the job
case answers `agency: 1, skipped: 1` and leaves p-1's organization
unchanged. The (PIN) Move/Split case is green already (`passField` refuses
them). Any other failure: stop and report.

Implement:

1. `app/src/repos/orgListRepo.ts`:
   - replace `/** The record fields a rewrite may touch (branch A). */` and
     `export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';` with:

     ```ts
     /** The record fields a rewrite may touch (branch A; branch B adds a contact's organization, spec D17). */
     export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'organization';
     ```

   - in `OrgRewriteState`, the `field?` doc
     `/** The one field a value action targets; absent for rename/merge (all fields of the kind). */`
     becomes
     `/** The one field a value action targets; absent for rename/merge (all fields of the kind, organization last). */`;
     in the `counts?` doc replace "Keys: `housingAuthority`, `agency`, `accepted_authorities` (records"
     with "Keys: `housingAuthority`, `agency`, `accepted_authorities`, `organization` (records".

2. `app/src/services/orgRecords.ts`:
   - `const FIELD_ORDER: Record<OrgRecordField, number> = { housingAuthority: 0, agency: 1, accepted_authorities: 2 };`
     becomes
     `const FIELD_ORDER: Record<OrgRecordField, number> = { housingAuthority: 0, agency: 1, accepted_authorities: 2, organization: 3 };`
   - replace the whole `recordFieldsForKind` (doc + body) with:

     ```ts
     /**
      * The record fields that hold an entry of each kind: one pass each. A
      * contact's organization accepts EITHER kind (spec D17), so a rename or
      * merge of either kind rewrites it too - always LAST: Run again and the
      * job's claim read the rewrite's kind from its first non-organization
      * field (services/orgRewrite.ts rewriteTargetKinds; R2-F2).
      */
     export function recordFieldsForKind(kind: OrgKind): OrgRecordField[] {
       return kind === 'housing_authority'
         ? ['housingAuthority', 'accepted_authorities', 'organization']
         : ['agency', 'organization'];
     }
     ```

   - `interface RewriteCounts {`: after `accepted_authorities: number;` add
     `organization: number;`.
   - `interface FieldAudit {`: `field: 'housingAuthority' | 'agency';` becomes
     `field: 'housingAuthority' | 'agency' | 'organization';`.
   - `type ContactPlan =`: the two lines
     `expect: { housingAuthority?: string | null; agency?: string | null };` and
     `next: { housingAuthority?: string | null; agency?: string };` become
     `expect: { housingAuthority?: string | null; agency?: string | null; organization?: string | null };` and
     `next: { housingAuthority?: string | null; agency?: string; organization?: string | null };`.
   - `function planContactRewrite(`: its `field: 'housingAuthority' | 'agency',`
     parameter becomes `field: 'housingAuthority' | 'agency' | 'organization',`;
     in the doc above it add the sentence "An organization value is only ever
     used, renamed, merged or cleared (passField refuses Move and Split for
     it): SET the name, or REMOVE it (spec D17)."
     In `case 'clear':` insert BEFORE `return field === 'housingAuthority'`:

     ```ts
           if (field === 'organization') {
             return { kind: 'write', expect: { organization: value }, next: { organization: null }, audits: [matched('')], conflict: false };
           }
     ```

     In `default: // rename, merge, use` insert BEFORE its `return field === 'housingAuthority'`:

     ```ts
           if (field === 'organization') {
             return { kind: 'write', expect: { organization: value }, next: { organization: toName }, audits: [matched(toName)], conflict: false };
           }
     ```

   - in `rewrite`, replace
     `const counts: RewriteCounts = { housingAuthority: 0, agency: 0, accepted_authorities: 0, skipped: 0, conflicts: 0 };` with
     `const counts: RewriteCounts = { housingAuthority: 0, agency: 0, accepted_authorities: 0, organization: 0, skipped: 0, conflicts: 0 };`.
     The contact branch (`const plan = planContactRewrite(def, field, value, c);`)
     compiles unchanged: `field` is narrowed to the three contact fields.
   - header: in the paragraph that starts
     `// THE REWRITE PASS. One call is ONE pass over ONE field (\`def.field\`); the`,
     the parenthesis spans two lines. Replace the line
     `// the rewrite started - recordFieldsForKind for a rename/merge). A record's`
     (unique, one line) with the two lines

     ```ts
     // the rewrite started - recordFieldsForKind for a rename/merge, organization
     // last). A record's
     ```

     (the line above it, `` // org.rewrite job runs one pass per member of `lastRewrite.fields` (fixed when ``,
     is unchanged).

3. `app/src/services/orgRewrite.ts` header: the line
   `// one field; a rename or merge, every field of the target entry's kind at that`
   paragraph - append after "(recordFieldsForKind)." the sentence
   "Branch B: that list ends with `organization` (spec D17)."

4. `app/scripts/clean-org-names.ts` docblock (R2-F9, comment only): after the
   line `// the list", where staff settle it.` add:

   ```ts
   // It never reads or writes a contact's `organization` (branch B, spec D17):
   // those values are settled in Settings only, so a dry run is not a complete
   // preview of "Not on the list".
   ```

GREEN: the same vitest command; then
`cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecordWriters.integration.test.ts test/cleanOrgNames.test.ts`
(PIN - unchanged behavior); then `cd "W:/tmp/caseworkers"; npm run typecheck`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/repos/orgListRepo.ts app/src/services/orgRecords.ts app/src/services/orgRewrite.ts app/scripts/clean-org-names.ts app/test/orgRecords.test.ts app/test/orgRewriteService.test.ts app/test/orgRewriteJob.test.ts app/test/organizationsApi.test.ts; git commit -m "feat(caseworkers): the org rewrite pass covers organization; rename and merge list it last" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.3 - usage: an organization column and two DISTINCT-record totals; `refuseWhileUsed(mode)`

Files: `app/src/services/orgRecords.ts`, `app/src/routes/organizations.ts`;
tests `app/test/orgRecords.test.ts`, `app/test/organizationsApi.test.ts`;
e2e `e2e/fixtures/orgFixture.ts`, `e2e/tests/dashboard-next/org-lists.spec.ts`.

RED 1: `app/test/orgRecords.test.ts`, inside
`describe('OrgRecordsService.usage (spec D3, D10)', () => {`:
- above that `describe` add the shared zero row:

  ```ts
  /** One entry's usage with nothing holding it (plan 3.6). */
  const NO_USE = {
    tenants: 0,
    otherContacts: 0,
    properties: 0,
    organization: 0,
    deleted: 0,
    inUse: { active: 0, deleted: 0 },
    kindLocked: { active: 0, deleted: 0 },
  };
  ```

- replace the first case's whole `expect(await records.usage(ORG_FIXTURE)).toEqual({ ... });` with:

  ```ts
      expect(await records.usage(ORG_FIXTURE)).toEqual({
        'org-atl': {
          ...NO_USE,
          tenants: 1,
          otherContacts: 1,
          properties: 2,
          deleted: 1,
          inUse: { active: 4, deleted: 1 },
          kindLocked: { active: 4, deleted: 1 },
        },
        'org-aug': NO_USE,
        'org-dca': { ...NO_USE, deleted: 1, inUse: { active: 0, deleted: 1 }, kindLocked: { active: 0, deleted: 1 } },
        'org-vash': NO_USE,
        'org-stepup': { ...NO_USE, otherContacts: 1, inUse: { active: 1, deleted: 0 }, kindLocked: { active: 1, deleted: 0 } },
      });
  ```

- after `it('follows the listByType cursor past one page', async () => {` (its closing `});`) add:

  ```ts
    it('counts organization holders of either kind in their own column, and DISTINCT records in two totals (spec D10, D17; R2-F1)', async () => {
      const { records } = setup({
        contacts: [
          contact('p-1', { type: 'partner', status: 'active', role: 'Caseworker', organization: STEP_UP.name }),
          contact('p-2', { type: 'partner', status: 'active', organization: ATLANTA.name }),
          contact('t-1', { housingAuthority: ATLANTA.name, organization: ATLANTA.name }), // one record, two columns
          contact('p-3', { type: 'partner', status: 'active', organization: DCA.name, deleted_at: DELETED_AT }),
          contact('p-4', { type: 'partner', status: 'active', organization: 'Steps' }), // off the list: no use
        ],
        units: [unit('u-1', { accepted_authorities: [ATLANTA.name] })],
      });
      const usage = await records.usage(ORG_FIXTURE);
      expect(usage['org-atl']).toEqual({
        ...NO_USE,
        tenants: 1,
        properties: 1,
        organization: 2,
        // t-1 once, p-2, u-1 - Delete waits for all of them.
        inUse: { active: 3, deleted: 0 },
        // p-2 holds it only as its organization, which accepts either kind: no kind lock.
        kindLocked: { active: 2, deleted: 0 },
      });
      expect(usage['org-stepup']).toEqual({ ...NO_USE, organization: 1, inUse: { active: 1, deleted: 0 } });
      expect(usage['org-dca']).toEqual({ ...NO_USE, deleted: 1, inUse: { active: 0, deleted: 1 } });
    });
  ```

RED 2: `app/test/organizationsApi.test.ts`:
- in `it('counts the records whose field of the entry kind holds the exact name, deleted ones beside them', async () => {`
  replace the two `toEqual` lines with:

  ```ts
      expect(res.body.usage['org-atl']).toEqual({
        tenants: 1,
        otherContacts: 0,
        properties: 1,
        organization: 0,
        deleted: 1,
        inUse: { active: 2, deleted: 1 },
        kindLocked: { active: 2, deleted: 1 },
      });
      expect(res.body.usage['org-stepup']).toEqual({
        tenants: 0,
        otherContacts: 1,
        properties: 0,
        organization: 0,
        deleted: 0,
        inUse: { active: 1, deleted: 0 },
        kindLocked: { active: 1, deleted: 0 },
      });
  ```

- after the `describe('DELETE /api/organizations/:orgId (admin)', () => {` block (its closing `});`) add:

  ```ts
  describe('organization holders and the two refusals (spec D10, D17; R2-F1)', () => {
    it('Delete counts DISTINCT records in any field, organization included; a kind change ignores organization-only holders', async () => {
      const h = await harness();
      h.world.contacts.push(
        tenant('t-1', { housingAuthority: DCA.name, organization: DCA.name }), // two columns, ONE record
        { contactId: 'p-1', type: 'partner', status: 'active', role: 'Caseworker', organization: STEP_UP.name },
        { contactId: 'p-2', type: 'partner', status: 'active', organization: STEP_UP.name, deleted_at: DELETED_AT },
      );
      const admin = as(h, TEST_ADMIN_COOKIE);
      const { usage } = (await admin.get('/usage')).body;
      expect(usage['org-dca']).toMatchObject({ tenants: 1, organization: 1, inUse: { active: 1, deleted: 0 } });
      expect(usage['org-stepup']).toMatchObject({ organization: 1, deleted: 1, kindLocked: { active: 0, deleted: 0 } });
      const delDca = await admin.del('/org-dca');
      expect(delDca.status).toBe(409);
      expect(delDca.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 0 } });
      const delStep = await admin.del('/org-stepup');
      expect(delStep.status).toBe(409);
      expect(delStep.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 1 } });
      const rekindDca = await admin.patch('/org-dca', { kind: 'agency' });
      expect(rekindDca.status).toBe(409);
      expect(rekindDca.body).toEqual({ error: 'org_in_use', uses: { active: 1, deleted: 0 } });
      const rekindStep = await admin.patch('/org-stepup', { kind: 'housing_authority' });
      expect(rekindStep.status).toBe(200);
      expect(rekindStep.body.entry).toMatchObject({ orgId: 'org-stepup', kind: 'housing_authority' });
    });
  });
  ```

  The existing cases `it('a kind change is refused while any record - deleted included - uses the entry', async () => {`
  (`uses: { active: 0, deleted: 1 }`) and
  `it('is admin-only, refused while used, 204 when unused, 404 when unknown', async () => {`
  (`uses: { active: 1, deleted: 0 }`) are (PIN): unchanged, now served from the totals.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts`.
Expected RED: every usage `toEqual` misses `organization`, `inUse`,
`kindLocked`; `DELETE /org-stepup` answers 204 (an organization holder is not
counted today).

Implement:

1. `app/src/services/orgRecords.ts`: replace

   ```ts
   export interface OrgUsage {
     /** orgId -> counts of records whose field of the entry's kind holds the exact name. */
     [orgId: string]: { tenants: number; otherContacts: number; properties: number; deleted: number };
   }
   ```

   with:

   ```ts
   /** A count of DISTINCT records, active and deleted (spec D10; R2-F1). */
   export interface OrgUseTotal {
     active: number;
     deleted: number;
   }

   /**
    * One entry's uses (plan 3.6). The columns are for DISPLAY: each counts the
    * active records holding the exact name in its fields (a field of the
    * entry's kind; `organization` - a contact's organization, any type, either
    * kind), so one record can count in two columns; `deleted` counts deleted
    * holders the same way, once per column hit - kept on the wire for
    * compatibility only: the dashboard shows the distinct `inUse.deleted`
    * (plan review R1 ruling A10). The two totals count DISTINCT
    * records and are what the refusals read: `inUse` - any field, organization
    * included (Delete); `kindLocked` - a field of the entry's kind only, so an
    * organization holder never blocks a kind change (spec D17).
    */
   export interface OrgUsageCounts {
     tenants: number;
     otherContacts: number;
     properties: number;
     organization: number;
     deleted: number;
     inUse: OrgUseTotal;
     kindLocked: OrgUseTotal;
   }

   export interface OrgUsage {
     [orgId: string]: OrgUsageCounts;
   }
   ```

2. Same file, replace the whole `async usage(entries) {` method (through its
   `return out;` / `},`) with:

   ```ts
       async usage(entries) {
         const out: OrgUsage = {};
         for (const e of entries) {
           out[e.orgId] = {
             tenants: 0,
             otherContacts: 0,
             properties: 0,
             organization: 0,
             deleted: 0,
             inUse: { active: 0, deleted: 0 },
             kindLocked: { active: 0, deleted: 0 },
           };
         }
         const haIds = new Map(entries.filter((e) => e.kind === 'housing_authority').map((e) => [e.name, e.orgId] as const));
         const agencyIds = new Map(entries.filter((e) => e.kind === 'agency').map((e) => [e.name, e.orgId] as const));
         // Names are unique across BOTH kinds (D4): one map serves the organization field.
         const anyIds = new Map(entries.map((e) => [e.name, e.orgId] as const));
         type Column = 'tenants' | 'otherContacts' | 'properties' | 'organization';
         /** One record's hits: a column per hit, and each DISTINCT entry once per total. */
         const tally = (
           hits: ReadonlyArray<{ orgId: string | undefined; column: Column; locksKind: boolean }>,
           deleted: boolean,
         ): void => {
           const used = new Set<OrgUsageCounts>();
           const locked = new Set<OrgUsageCounts>();
           for (const hit of hits) {
             const row = hit.orgId === undefined ? undefined : out[hit.orgId];
             if (row === undefined) continue;
             if (deleted) row.deleted += 1;
             else row[hit.column] += 1;
             used.add(row);
             if (hit.locksKind) locked.add(row);
           }
           const bump = (t: OrgUseTotal): void => {
             if (deleted) t.deleted += 1;
             else t.active += 1;
           };
           for (const row of used) bump(row.inUse);
           for (const row of locked) bump(row.kindLocked);
         };
         const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
         for await (const c of everyContact()) {
           const column = c.type === 'tenant' ? 'tenants' : 'otherContacts';
           const ha = text(c['housingAuthority']);
           const agency = text(c['agency']);
           const organization = text(c.organization);
           tally(
             [
               { orgId: ha === undefined ? undefined : haIds.get(ha), column, locksKind: true },
               { orgId: agency === undefined ? undefined : agencyIds.get(agency), column, locksKind: true },
               // Spec D17: the organization field accepts either kind - it never locks one.
               {
                 orgId: organization === undefined ? undefined : anyIds.get(organization),
                 column: 'organization',
                 locksKind: false,
               },
             ],
             isContactDeleted(c),
           );
         }
         for await (const u of everyUnit()) {
           // One property is one use, however often its list repeats the name.
           const members = new Set((storedAuthorities(u) ?? []).filter((m): m is string => typeof m === 'string'));
           tally(
             [...members].map((m) => ({ orgId: haIds.get(m), column: 'properties' as const, locksKind: true })),
             isUnitDeleted(u),
           );
         }
         return out;
       },
   ```

   Update the header paragraph `// USES (D3) count only a field of the entry's kind holding the exact name. A`
   by appending: "Branch B: a contact's `organization` holding the exact name
   of an entry of EITHER kind is a use too, in its own column; the two
   distinct-record totals decide Delete (`inUse`) and a kind change
   (`kindLocked`, which organization never joins - spec D17)."

3. `app/src/routes/organizations.ts`: replace the whole
   `async function refuseWhileUsed(entry: OrgEntry): Promise<void> {` (with its doc) by:

   ```ts
     /**
      * 409 org_in_use while a record - deleted ones included (D10) - holds the
      * entry's name. 'delete': DISTINCT records in any field, a contact's
      * organization included; 'kind': DISTINCT records in a field of the entry's
      * kind - an organization holder stays valid under either kind, so it never
      * blocks a kind change (spec D17; R2-F1). OrgNamesService has no record
      * access (plan 3.4b), so the delete and kind-change routes ask here first
      * (plan 3.5). The count and the list write are two steps: a record written
      * in between can end up holding the removed name - it then shows in "Not on
      * the list" (the accepted race, plan watch items).
      */
     async function refuseWhileUsed(entry: OrgEntry, mode: 'delete' | 'kind'): Promise<void> {
       const u = (await orgRecords.usage([entry]))[entry.orgId];
       const total = mode === 'delete' ? u?.inUse : u?.kindLocked;
       const uses = { active: total?.active ?? 0, deleted: total?.deleted ?? 0 };
       if (uses.active + uses.deleted > 0) throw new OrgHttpError(409, { error: 'org_in_use', uses });
     }
   ```

   and update the two callers: `if (entry.kind !== kind) await refuseWhileUsed(entry);` becomes
   `if (entry.kind !== kind) await refuseWhileUsed(entry, 'kind');`;
   `await refuseWhileUsed(await entryOr404(orgId));` becomes
   `await refuseWhileUsed(await entryOr404(orgId), 'delete');`.

4. e2e (R5-F12, assembly ruling S5/S7-5): `e2e/fixtures/orgFixture.ts` replace

   ```ts
   export type OrgUsageWire = Record<
     string,
     { tenants: number; otherContacts: number; properties: number; deleted: number }
   >;
   ```

   with:

   ```ts
   export type OrgUsageWire = Record<
     string,
     {
       tenants: number;
       otherContacts: number;
       properties: number;
       organization: number;
       deleted: number;
       inUse: { active: number; deleted: number };
       kindLocked: { active: number; deleted: number };
     }
   >;
   ```

   and in `e2e/tests/dashboard-next/org-lists.spec.ts`, the rename case
   (`// What uses the entry, counted per kind of record (D3, D10).`), replace
   the object in `expect((await getOrgUsage(req))[entry.orgId]).toEqual({`
   with:

   ```ts
       tenants: 2,
       otherContacts: 0,
       properties: 1,
       organization: 0,
       deleted: 0,
       inUse: { active: 3, deleted: 0 },
       kindLocked: { active: 3, deleted: 0 },
   ```

   (The e2e change is verified in S10's `npm run e2e`; do not run e2e here.)

GREEN: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts test/orgRewriteJob.test.ts`;
`cd "W:/tmp/caseworkers"; npm run typecheck`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/services/orgRecords.ts app/src/routes/organizations.ts app/test/orgRecords.test.ts app/test/organizationsApi.test.ts e2e/fixtures/orgFixture.ts e2e/tests/dashboard-next/org-lists.spec.ts; git commit -m "feat(caseworkers): org usage counts organization holders; Delete and Change kind read distinct totals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.4 - "Not on the list" organization rows and their holders

Files: `app/src/services/orgRecords.ts`, `app/src/routes/organizations.ts`;
tests `app/test/orgRecords.test.ts`, `app/test/organizationsApi.test.ts`.

RED 1: `app/test/orgRecords.test.ts`, inside
`describe('OrgRecordsService.notOnList (spec D10)', () => {`, after the
first case's closing `});`, add:

```ts
  it('lists organization values off BOTH lists as their own rows, resolved over both kinds (spec D17)', async () => {
    const { records } = setup({
      contacts: [
        contact('p-1', { type: 'partner', status: 'active', organization: 'VASH' }), // an agency spelling
        contact('p-2', { type: 'partner', status: 'active', organization: 'AHA' }), // a shared housing authority spelling
        contact('p-3', { type: 'partner', status: 'active', organization: 'DCA HUD-VASH' }), // one of each kind
        contact('p-4', { type: 'partner', status: 'active', organization: STEP_UP.name }), // on the list: no row
        contact('p-5', { type: 'partner', status: 'active', organization: ATLANTA.name }), // either kind is on the list
        contact('t-1', { organization: 'Nowhere Housing', deleted_at: DELETED_AT }), // any type, deleted counted
      ],
    });
    expect(await records.notOnList(ORG_FIXTURE)).toEqual([
      {
        field: 'organization',
        value: 'AHA',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'ambiguous', candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)] },
      },
      {
        field: 'organization',
        value: 'DCA HUD-VASH',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'compound', compound: [[orgRef(DCA)], [orgRef(VASH)]] },
      },
      {
        field: 'organization',
        value: 'Nowhere Housing',
        count: 0,
        deletedCount: 1,
        resolution: { status: 'unknown', close: [] },
      },
      {
        field: 'organization',
        value: 'VASH',
        count: 1,
        deletedCount: 0,
        resolution: { status: 'match', match: orgRef(VASH) },
      },
    ]);
  });
```

and inside `describe('OrgRecordsService.holders (spec D10 "Show records")', () => {`, after the first case:

```ts
  it('expands an organization value into the contacts holding it, of any type', async () => {
    const { records } = setup({
      contacts: [
        contact('p-1', { type: 'partner', status: 'active', firstName: 'Cora', lastName: 'Case', organization: 'VASH' }),
        contact('t-1', { organization: 'VASH', deleted_at: DELETED_AT }),
        contact('t-2', { agency: 'VASH' }), // another field: not a holder of the organization row
      ],
    });
    expect(await records.holders('organization', 'VASH')).toEqual([
      { kind: 'contact', contactId: 't-1', name: null, type: 'tenant', deleted: true },
      { kind: 'contact', contactId: 'p-1', name: 'Cora Case', type: 'partner', deleted: false },
    ]);
  });
```

(Order: `everyContact` reads the tenant partition before the partner one.)

RED 2: `app/test/organizationsApi.test.ts`, inside
`describe('GET /api/organizations/not-on-list (+ /records) - for everyone', () => {`, add:

```ts
  it('lists an organization value and expands it into its holders (spec D17)', async () => {
    const h = await harness();
    h.world.contacts.push({
      contactId: 'p-1',
      type: 'partner',
      status: 'active',
      role: 'Caseworker',
      firstName: 'Cora',
      lastName: 'Case',
      organization: 'VASH',
    });
    const va = as(h, TEST_SESSION_COOKIE);
    expect((await va.get('/not-on-list')).body.rows).toEqual([
      { field: 'organization', value: 'VASH', count: 1, deletedCount: 0, resolution: { status: 'match', match: orgRef(VASH) } },
    ]);
    const records = await va.get('/not-on-list/records').query({ field: 'organization', value: 'VASH' });
    expect(records.status).toBe(200);
    expect(records.body.records).toEqual([
      { kind: 'contact', contactId: 'p-1', name: 'Cora Case', type: 'partner', deleted: false },
    ]);
  });
```

and add `VASH` to that file's `./helpers/orgFixtures.js` import list.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts`.
Expected RED: no organization rows (the contacts loop reads two fields);
`/not-on-list/records?field=organization` answers 400 (not a record field).
The holders case is green already (generic over the field) - it is a (PIN)
next to a real RED.

Implement:

1. `app/src/services/orgRecords.ts` `async notOnList(entries) {`: replace
   `for (const field of ['housingAuthority', 'agency'] as const) {` with
   `for (const field of ['housingAuthority', 'agency', 'organization'] as const) {`
   and add to the comment block inside the loop: "An organization (branch B,
   spec D17) resolves over BOTH kinds (KINDS_FOR_FIELD.organization), so its
   row is never 'the other kind'."
2. `app/src/routes/organizations.ts`:
   - `const RECORD_FIELDS: readonly OrgRecordField[] = ['housingAuthority', 'agency', 'accepted_authorities'];` becomes
     `const RECORD_FIELDS: readonly OrgRecordField[] = ['housingAuthority', 'agency', 'accepted_authorities', 'organization'];`
   - both occurrences of
     `res.status(400).json({ error: 'field must be housingAuthority, agency or accepted_authorities' });`
     become
     `res.status(400).json({ error: 'field must be housingAuthority, agency, accepted_authorities or organization' });`
     (use the Edit tool's replace-all; no test pins the text - grep confirmed).

GREEN: the same vitest command; `cd "W:/tmp/caseworkers"; npm run typecheck`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/services/orgRecords.ts app/src/routes/organizations.ts app/test/orgRecords.test.ts app/test/organizationsApi.test.ts; git commit -m "feat(caseworkers): Not on the list lists organization values and their holders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.5 - settling an organization row; Run again and the claim across both kinds

Files: `app/src/services/orgRewrite.ts`, `app/src/routes/organizations.ts`;
tests `app/test/orgRewriteService.test.ts`, `app/test/organizationsApi.test.ts`.

RED 1: `app/test/orgRewriteService.test.ts`, inside
`describe('OrgRewriteService.resolveNotOnList (spec D10)', () => {`, before
`it('is refused while another rewrite runs', async () => {`, add:

```ts
  it('an organization row: Use takes a name of EITHER kind, Add as new needs the kind, Move and Split are refused (spec D17; R2-F6)', async () => {
    const useAgency = await rewriteService();
    expect(
      (await useAgency.svc.resolveNotOnList({ field: 'organization', value: 'Steps', action: 'use', name: STEP_UP.name, actor: 'u' }))
        .lastRewrite,
    ).toMatchObject({ action: 'use', field: 'organization', fields: ['organization'], fromTexts: ['Steps'], toName: STEP_UP.name });
    const useHa = await rewriteService();
    expect(
      (await useHa.svc.resolveNotOnList({ field: 'organization', value: 'Atl HA', action: 'use', name: ATLANTA.name, actor: 'u' }))
        .lastRewrite.toName,
    ).toBe(ATLANTA.name);
    const add = await rewriteService();
    const added = await add.svc.resolveNotOnList({
      field: 'organization',
      value: 'Mercy Care',
      action: 'add',
      kind: 'agency',
      actor: 'u',
    });
    expect(added.lastRewrite).toMatchObject({ action: 'use', field: 'organization', toName: 'Mercy Care' });
    expect((await add.repo.peek())?.entries.at(-1)).toMatchObject({ kind: 'agency', name: 'Mercy Care' });

    const { repo, svc } = await rewriteService();
    const refused: Array<Omit<ResolveInput, 'actor'>> = [
      { field: 'organization', value: 'Mercy Care', action: 'add' }, // no kind
      { field: 'organization', value: 'HUD VASH Office', action: 'move_to_agency', name: VASH.name },
      { field: 'organization', value: 'DCA Office', action: 'move_to_housing_authority', name: DCA.name },
      { field: 'organization', value: 'DCA HUD-VASH', action: 'split', name: DCA.name, agencyName: VASH.name },
      { field: 'organization', value: 'Junk', action: 'clear', kind: 'agency' }, // kind on another action
      { field: 'agency', value: 'Mercy Care', action: 'add', kind: 'agency' }, // kind on another field
    ];
    for (const input of refused) {
      await expect(svc.resolveNotOnList({ ...input, actor: 'u' })).rejects.toMatchObject({ status: 400 });
    }
    expect((await repo.peek())?.version).toBe(1);
  });
```

RED 2: same file, inside `describe('OrgRewriteService.runAgain (spec D11)', () => {`,
AFTER the declarations `const failedRewrite = ...`, `const failedClear = ...`
and `const HOPE_HOUSE = ...` and after the case
`it('refuses (409 org_rewrite_target_gone) once a from-text became a NAME VARIANT of an added agency', async () => {`,
add:

```ts
  it('re-checks an organization Use target against BOTH kinds, and a rename by its first non-organization field (spec D17; R2-F2)', async () => {
    const gone = { status: 409, body: { error: 'org_rewrite_target_gone' } };
    const orgUse = failedRewrite(
      runningRewrite({ jobId: 'job-old', action: 'use', field: 'organization', fromTexts: ['Steps'], toName: STEP_UP.name }),
    );
    // An agency target is no "target gone" for an organization value.
    const live = await rewriteService({ lastRewrite: orgUse });
    expect((await live.svc.runAgain('a')).lastRewrite).toMatchObject({
      action: 'use',
      field: 'organization',
      fields: ['organization'],
      status: 'running',
    });
    // ...and it still is once the name left both lists.
    const deleted = await rewriteService({ entries: ORG_FIXTURE.filter((e) => e.orgId !== STEP_UP.orgId), lastRewrite: orgUse });
    await expect(deleted.svc.runAgain('a')).rejects.toMatchObject(gone);
    // A rename's kind comes from its first NON-organization field, whatever the order.
    const NEW = 'Step Up Atlanta';
    const renamed = await rewriteService({
      entries: ORG_FIXTURE.map((e) => (e.orgId === STEP_UP.orgId ? { ...e, name: NEW } : e)),
      lastRewrite: failedRewrite(
        runningRewrite({ jobId: 'job-old', action: 'rename', fromTexts: [STEP_UP.name], fields: ['organization', 'agency'], toName: NEW }),
      ),
    });
    expect((await renamed.svc.runAgain('a')).lastRewrite).toMatchObject({ action: 'rename', toName: NEW, status: 'running' });
  });

  it('(PIN) a housing authority rename that also rewrites organization is refused once its old name became an AGENCY name (R2-F2)', async () => {
    const OLD = 'Old Metro Housing';
    const { svc, enqueued } = await rewriteService({
      entries: [...ORG_FIXTURE, orgEntry({ orgId: 'org-old', kind: 'agency', name: OLD })],
      lastRewrite: failedRewrite(
        runningRewrite({
          jobId: 'job-old',
          action: 'rename',
          fromTexts: [OLD],
          fields: ['housingAuthority', 'accepted_authorities', 'organization'],
          toName: ATLANTA.name,
        }),
      ),
    });
    await expect(svc.runAgain('a')).rejects.toMatchObject({ status: 409, body: { error: 'org_rewrite_target_gone' } });
    expect(enqueued).toEqual([]);
  });
```

RED 2b (plan review R1 ruling S2 - the job's claim path shares
`revalidationProblem` with Run again, so it gets its own case): same file,
inside `describe('OrgRewriteService.claim (code review R2-BE-1)', () => {`,
after the case
`it('a LAPSED lock is re-validated as Run again does: claimed while the definition fits the list, else recorded failed', async () => {`
(its closing `});`), add:

```ts
  it('a LAPSED organization Use of an AGENCY name is claimed - the claim re-checks both kinds, as Run again does (spec D17; R2-F2)', async () => {
    const late = '2026-10-06T12:15:00.000Z'; // exactly 15 minutes after T1: lapsed
    const orgUse = runningRewrite({
      jobId: 'job-1',
      action: 'use',
      field: 'organization',
      fromTexts: ['Steps'],
      toName: STEP_UP.name,
      heartbeatAt: T1,
    });
    const fits = await rewriteService({ lastRewrite: orgUse, now: () => late });
    expect(await fits.svc.claim('job-1')).toEqual({ outcome: 'claimed', lastRewrite: { ...orgUse, heartbeatAt: late } });
    // ...and it is refused once the name left BOTH lists.
    const gone = await rewriteService({
      entries: ORG_FIXTURE.filter((e) => e.orgId !== STEP_UP.orgId),
      lastRewrite: orgUse,
      now: () => late,
    });
    expect(await gone.svc.claim('job-1')).toMatchObject({ outcome: 'refused', lastRewrite: { status: 'failed' } });
  });
```

RED 3: `app/test/organizationsApi.test.ts`, inside
`describe('rewrites through the real in-process queue and the org.rewrite job (spec D10, D11)', () => {`,
before `it('Run again with nothing failed or stalled is 409 org_rewrite_not_rerunnable', async () => {`, add:

```ts
  it('settles organization values: Use a name of either kind, Add as new with the kind staff picked (spec D17)', async () => {
    const h = await harness();
    wireRewriteJob(h);
    h.world.contacts.push(
      { contactId: 'p-1', type: 'partner', status: 'active', role: 'Caseworker', organization: 'Steps' },
      { contactId: 'p-2', type: 'partner', status: 'active', role: 'Caseworker', organization: 'Mercy Care' },
    );
    const admin = as(h, TEST_ADMIN_COOKIE);
    const bad = { field: 'organization', value: 'Mercy Care', action: 'add' };
    expect((await admin.post('/not-on-list/resolve', { ...bad, kind: 'county' })).status).toBe(400);
    expect((await admin.post('/not-on-list/resolve', bad)).status).toBe(400);
    const used = await admin.post('/not-on-list/resolve', { field: 'organization', value: 'Steps', action: 'use', name: STEP_UP.name });
    expect(used.status).toBe(202);
    await queue.settle();
    const added = await admin.post('/not-on-list/resolve', { ...bad, kind: 'agency' });
    expect(added.status).toBe(202);
    await queue.settle();
    expect(h.world.contacts.map((c) => c['organization'])).toEqual([STEP_UP.name, 'Mercy Care']);
    expect((await admin.get()).body.entries.at(-1)).toMatchObject({ kind: 'agency', name: 'Mercy Care' });
    expect((await admin.get('/not-on-list')).body.rows).toEqual([]);
  });
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRewriteService.test.ts test/organizationsApi.test.ts`.
Expected RED: an organization Use of an agency name answers 400 (the
service derives one kind - housing authority - from any field but `agency`);
`add` with no kind is accepted (adds a housing authority); `kind` is never
read; Run again of the organization Use answers 409 (the target is looked up
as a housing authority); the reordered agency rename answers 409
(`fields[0]` is `organization`); the RED 2b claim of the lapsed
organization Use answers `outcome: 'refused'` (the same housing-authority
lookup, through the claim). The second runAgain case is a (PIN): S1's
`KINDS_FOR_FIELD.organization` already widens the union; the "gone" half of
RED 2b is green before and after.

Implement:

1. `app/src/services/orgRewrite.ts`:
   - the `resolveNotOnList(input: {` signature in `export interface OrgRewriteService {`:
     after `rememberSpelling?: boolean;` add

     ```ts
         /** Add as new on an `organization` row only, where it is REQUIRED: the
          *  list staff picked (spec D17; R2-F6). Refused (400) anywhere else. */
         kind?: OrgKind;
     ```

   - replace the whole `function rewriteTargetKind(def: OrgRewriteState): OrgKind | undefined {`
     (doc + body) with:

     ```ts
     /**
      * The kinds an entry `toName` names may be for a re-run (spec D11 Run
      * again): Move to Agency writes an agency; Move to Housing authority and
      * Split write a housing authority (Split's agency half is checked on its
      * own); rename, merge and use write a name their field accepts - a value
      * action's one field (an organization accepts EITHER kind, spec D17), a
      * rename's or merge's FIRST NON-organization field, which is of the
      * entry's own kind (recordFieldsForKind lists organization last, but the
      * kind never depends on that order - R2-F2). Clear names no target.
      */
     function rewriteTargetKinds(def: OrgRewriteState): readonly OrgKind[] | undefined {
       switch (def.action) {
         case 'clear':
         case 'cleanup':
           return undefined;
         case 'move_to_agency':
           return ['agency'];
         case 'move_to_housing_authority':
         case 'split':
           return ['housing_authority'];
         default: // rename, merge, use
           return KINDS_FOR_FIELD[def.field ?? def.fields.find((f) => f !== 'organization') ?? 'housingAuthority'];
       }
     }
     ```

   - in `function revalidationProblem(`, replace

     ```ts
       const targetGone = (name: string | undefined, kind: OrgKind): boolean =>
         name === undefined || !entries.some((e) => e.name === name && e.kind === kind);
       const toKind = rewriteTargetKind(def);
       if (
         (toKind !== undefined && targetGone(def.toName, toKind)) ||
         (def.action === 'split' && targetGone(def.agencyName, 'agency'))
       ) {
     ```

     with

     ```ts
       const targetGone = (name: string | undefined, kinds: readonly OrgKind[]): boolean =>
         name === undefined || !entries.some((e) => e.name === name && kinds.includes(e.kind));
       const toKinds = rewriteTargetKinds(def);
       if (
         (toKinds !== undefined && targetGone(def.toName, toKinds)) ||
         (def.action === 'split' && targetGone(def.agencyName, ['agency']))
       ) {
     ```

     and append to the `// (2): a from-text that has since become ...` comment:
     "A rename or merge that lists `organization` accepts BOTH kinds here, so
     its from-text is checked against agency names too: the organization pass
     would rewrite those holders (R2-F2)."
   - in `async resolveNotOnList(input) {`, replace

     ```ts
           const kinds = KINDS_FOR_FIELD[field];
           const kind: OrgKind = field === 'agency' ? 'agency' : 'housing_authority';
     ```

     with

     ```ts
           const kinds = KINDS_FOR_FIELD[field];
           // `kind` belongs to Add as new on an organization row - required there,
           // refused anywhere else (spec D17; R2-F6). Every other field adds its own kind.
           if (input.kind !== undefined && !(field === 'organization' && action === 'add')) {
             throw new OrgHttpError(400, { error: 'kind is accepted only when adding an organization value' });
           }
           if (field === 'organization' && action === 'add' && input.kind === undefined) {
             throw new OrgHttpError(400, { error: 'kind is required to add an organization value' });
           }
           const addKind: OrgKind = input.kind ?? kinds[0] ?? 'housing_authority';
     ```

   - replace the `named` helper with:

     ```ts
             const named = (name: string | undefined, wanted: readonly OrgKind[], key: 'name' | 'agencyName'): OrgEntry => {
               const hit = name === undefined ? undefined : entries.find((e) => e.name === name && wanted.includes(e.kind));
               if (hit === undefined) {
                 const what = wanted.length > 1 ? 'an organization' : wanted[0] === 'agency' ? 'an agency' : 'a housing authority';
                 throw new OrgHttpError(400, { error: `${key} must be the exact name of ${what} on the list` });
               }
               return hit;
             };
     ```

     and update its five callers: `named(input.name, 'agency', 'name')` ->
     `named(input.name, ['agency'], 'name')`;
     `named(input.name, 'housing_authority', 'name')` (two sites: Move to
     Housing authority and Split) -> `named(input.name, ['housing_authority'], 'name')`;
     `named(input.agencyName, 'agency', 'agencyName')` ->
     `named(input.agencyName, ['agency'], 'agencyName')`;
     the Use site `target = named(input.name, kind, 'name');` ->
     `target = named(input.name, kinds, 'name');`.
   - in the `add` branch, `kind,` inside `target = {` becomes `kind: addKind,`.
   - Move/Split on an organization row need no new code: the existing
     `if (field !== 'housingAuthority') {` / `if (field !== 'agency') {`
     checks answer 400.
2. `app/src/routes/organizations.ts`:
   - header line `//   POST   /not-on-list/resolve  ADMIN { field, value, action, name?, agencyName?, rememberSpelling? }`
     becomes `//   POST   /not-on-list/resolve  ADMIN { field, value, action, name?, agencyName?, rememberSpelling?, kind? }`;
   - in the resolve handler, after `const rememberSpelling = body['rememberSpelling'];` add
     `const kind = body['kind'];`; after the `rememberSpelling` validation add:

     ```ts
           if (kind !== undefined && !isKind(kind)) {
             res.status(400).json({ error: 'kind must be housing_authority or agency' });
             return;
           }
     ```

     and pass it: after `...(rememberSpelling !== undefined && { rememberSpelling }),` add
     `...(kind !== undefined && { kind }),`.

GREEN: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgRewriteService.test.ts test/organizationsApi.test.ts test/orgRewriteJob.test.ts`;
`cd "W:/tmp/caseworkers"; npm run typecheck`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/services/orgRewrite.ts app/src/routes/organizations.ts app/test/orgRewriteService.test.ts app/test/organizationsApi.test.ts; git commit -m "feat(caseworkers): settle organization values; Run again and the claim check both kinds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.6 - `POST /api/organizations/check` takes `kinds`

Files: `app/src/services/orgNames.ts`, `app/src/routes/organizations.ts`;
tests `app/test/orgNamesService.test.ts`, `app/test/organizationsApi.test.ts`.

RED 1: `app/test/orgNamesService.test.ts`, after
`it('check() with an unknown spellingFor is 404 org_not_found', async () => {` (its closing `});`), add:

```ts
  it('check() with kinds resolves against BOTH lists - never "the other kind" (spec D6, D17)', async () => {
    const { svc } = await namesService();
    const both = ['housing_authority', 'agency'] as const;
    expect(await svc.check({ kinds: both, text: 'HUD VASH' })).toEqual({
      match: orgRef(VASH),
      candidates: [],
      close: [],
      nameProblem: 'org_name_taken',
    });
    expect(await svc.check({ kinds: both, text: 'AHA' })).toEqual({
      candidates: [orgRef(ATLANTA), orgRef(AUGUSTA)],
      close: [],
      nameProblem: 'org_name_taken',
    });
    expect(await svc.check({ kinds: both, text: 'DCA HUD-VASH' })).toEqual({
      candidates: [],
      close: [],
      compound: [[orgRef(DCA)], [orgRef(VASH)]],
      nameProblem: 'org_name_compound',
    });
  });
```

RED 2: `app/test/organizationsApi.test.ts`, inside
`describe('POST /api/organizations/check - for everyone', () => {`, add:

```ts
  it('checks against both lists with kinds - exactly one of kind and kinds (spec D17; R2-F5)', async () => {
    const va = as(await harness(), TEST_SESSION_COOKIE);
    const both = await va.post('/check', { kinds: ['housing_authority', 'agency'], text: 'HUD VASH' });
    expect(both.status).toBe(200);
    expect(both.body).toEqual({ match: orgRef(VASH), candidates: [], close: [], nameProblem: 'org_name_taken' });
    // spellingFor is target-based, so it works with either form.
    const spelled = await va.post('/check', { kinds: ['agency', 'housing_authority'], text: 'Steps', spellingFor: 'org-stepup' });
    expect(spelled.status).toBe(200);
    expect(spelled.body).toMatchObject({ spellingProblem: null });
    for (const body of [
      { kind: 'agency', kinds: ['agency'], text: 'x' },
      { text: 'x' },
      { kinds: [], text: 'x' },
      { kinds: ['agency', 'agency'], text: 'x' },
      { kinds: ['county'], text: 'x' },
      { kinds: 'agency', text: 'x' },
    ]) {
      expect((await va.post('/check', body)).status).toBe(400);
    }
  });
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/orgNamesService.test.ts test/organizationsApi.test.ts`.
Expected RED: the service ignores `kinds` (resolves against `[undefined]`:
no match, no candidates); the route answers 400 for any body without `kind`.

Implement:

1. `app/src/services/orgNames.ts`:
   - the interface line
     `check(input: { kind: OrgKind; text: string; spellingFor?: string }): Promise<OrgCheckResult>;`
     becomes:

     ```ts
       /** POST /check: `kind` (one list) or `kinds` (several - the organization
        *  picker's both lists, spec D6/D17), never both (the route enforces it). */
       check(
         input: ({ kind: OrgKind; kinds?: undefined } | { kinds: readonly OrgKind[]; kind?: undefined }) & {
           text: string;
           spellingFor?: string;
         },
       ): Promise<OrgCheckResult>;
     ```

   - the implementation's first THREE lines, which are consecutive in this
     order (plan review R1 ruling S3) -

     ```ts
         async check({ kind, text, spellingFor }) {
           const { entries } = await list.get();
           const resolution = resolveOrgText(entries, text, [kind]);
     ```

     - become, as one replacement of all three lines:

     ```ts
         async check(input) {
           const { text, spellingFor } = input;
           const kinds: readonly OrgKind[] = input.kinds ?? (input.kind !== undefined ? [input.kind] : []);
           const { entries } = await list.get();
           const resolution = resolveOrgText(entries, text, kinds);
     ```

     (`const { entries } = await list.get();` therefore appears ONCE in
     `check` afterwards - the old one is inside the replaced block, not left
     behind; `const { entries } = await list.get();` also occurs in other
     methods of this file, so anchor on the three-line block, starting at
     `async check({ kind, text, spellingFor }) {`, which is unique. The rest
     of `check` is unchanged - `nameProblem` and `spellingProblem` are
     kind-independent).
2. `app/src/routes/organizations.ts`:
   - header `//   POST   /check  { kind, text, spellingFor? }  -> OrgCheckResult (text <= 200 chars, else 400)`
     becomes `//   POST   /check  { kind | kinds, text, spellingFor? }  -> OrgCheckResult (text <= 200 chars, else 400)`;
   - in the `/check` handler replace

     ```ts
           const kind = body['kind'];
           const text = body['text'];
           const spellingFor = body['spellingFor'];
           if (!isKind(kind)) {
             res.status(400).json({ error: 'kind must be housing_authority or agency' });
             return;
           }
     ```

     with

     ```ts
           const kind = body['kind'];
           const kinds = body['kinds'];
           const text = body['text'];
           const spellingFor = body['spellingFor'];
           // Exactly one of kind / kinds (R2-F5): kinds is a non-empty set of the two kinds.
           if ((kind === undefined) === (kinds === undefined)) {
             res.status(400).json({ error: 'send exactly one of kind or kinds' });
             return;
           }
           if (kind !== undefined && !isKind(kind)) {
             res.status(400).json({ error: 'kind must be housing_authority or agency' });
             return;
           }
           if (
             kinds !== undefined &&
             (!Array.isArray(kinds) ||
               kinds.length === 0 ||
               !kinds.every(isKind) ||
               new Set(kinds).size !== kinds.length)
           ) {
             res.status(400).json({ error: 'kinds must list housing_authority and/or agency, each once' });
             return;
           }
     ```

     and the final line
     `res.json(await orgNames.check({ kind, text, ...(spellingFor !== undefined && { spellingFor }) }));`
     becomes:

     ```ts
           const spelling = spellingFor !== undefined ? { spellingFor } : {};
           res.json(
             await orgNames.check(
               Array.isArray(kinds) ? { kinds: kinds as OrgKind[], text, ...spelling } : { kind: kind as OrgKind, text, ...spelling },
             ),
           );
     ```

GREEN: the same vitest command (the existing `{ kind, text }` cases stay
green); `cd "W:/tmp/caseworkers"; npm run typecheck`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/services/orgNames.ts app/src/routes/organizations.ts app/test/orgNamesService.test.ts app/test/organizationsApi.test.ts; git commit -m "feat(caseworkers): POST /api/organizations/check takes kinds (both lists)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 5.7 - the dev seam `POST /__dev/org-fixture` accepts `organization` (+ e2e types, README, selectors)

Files: `app/src/routes/dev.ts`; test `app/test/devOrgFixture.test.ts`;
`e2e/fixtures/orgFixture.ts`, `e2e/README.md`, `e2e/support/selectors.md`.

RED: `app/test/devOrgFixture.test.ts`:
- after `it('SETs a raw agency on a contact', async () => {` (its closing `});`) add:

  ```ts
    it('SETs a raw organization on a contact (branch B, spec D17)', async () => {
      const { app, world } = buildHarness();
      const res = await request(app).post(SEAM).send({ contactId: 'c-fix', field: 'organization', value: OFF_LIST });
      expect(res.status).toBe(200);
      expect(contactOf(world)['organization']).toBe(OFF_LIST);
    });
  ```

- in the `it.each([` table, the expected text of `'a unit field on a contact'`
  `'field must be housingAuthority or agency for a contact',` becomes
  `'field must be housingAuthority, agency or organization for a contact',`.
- in the file header, `contact -> SET housingAuthority | agency; unit -> APPEND to`
  becomes `contact -> SET housingAuthority | agency | organization; unit -> APPEND to`.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/devOrgFixture.test.ts`.
Expected RED: the organization case answers 400; the refusal message differs.

Implement:

1. `app/src/routes/dev.ts`, the `POST /__dev/org-fixture` block:
   - header comment `//   contact: SET \`housingAuthority\` | \`agency\` to the value` becomes
     `//   contact: SET \`housingAuthority\` | \`agency\` | \`organization\` (branch B) to the value`;
   - replace

     ```ts
           if (field !== 'housingAuthority' && field !== 'agency') {
             res.status(400).json({ error: 'field must be housingAuthority or agency for a contact' });
     ```

     with

     ```ts
           if (field !== 'housingAuthority' && field !== 'agency' && field !== 'organization') {
             res.status(400).json({ error: 'field must be housingAuthority, agency or organization for a contact' });
     ```

     (`contactsRepo.update(contactId, { [field]: value })` is generic -
     `organization` is not an index key.)
2. `e2e/fixtures/orgFixture.ts`:
   `export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';` becomes
   `export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'organization';`
   (its doc `/** The record fields an organization name lives in (plan 3.2 OrgRecordField). */`
   unchanged); in the `setOffListValue` doc, "a contact's field is SET" becomes
   "a contact's field (housingAuthority, agency or organization) is SET".
3. `e2e/README.md`, the `- \`POST /__dev/org-fixture\`` bullet: replace
   `` `{ contactId, field:`` / `` housingAuthority|agency, value }` SETs it`` with
   `` `{ contactId, field:`` / `` housingAuthority|agency|organization, value }` SETs it``
   (keep the line wrap at 80 columns).
4. `e2e/support/selectors.md`, the `| Dev seam | put a value NOT on the organization list |` row:
   replace "(a contact field is SET;" with "(a contact field - `housingAuthority`, `agency` or `organization` - is SET;".

GREEN: the same vitest command; `cd "W:/tmp/caseworkers"; npm run typecheck`
(the e2e workspace typechecks with it).

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add app/src/routes/dev.ts app/test/devOrgFixture.test.ts e2e/fixtures/orgFixture.ts e2e/README.md e2e/support/selectors.md; git commit -m "feat(caseworkers): the org-fixture dev seam plants an organization value" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

## S6 - shares server (`app/src/routes/broadcasts.ts`, `app/src/jobs/broadcastFanOut.ts`, `app/src/routes/units.ts`, `app/src/repos/listingSendsRepo.ts`, `app/src/routes/contactTimeline.ts`; tests `app/test/broadcastApi.test.ts`, `app/test/broadcastFanOut.test.ts`, `app/test/listingSendsApi.test.ts`, `app/test/contactsBatchReads.test.ts`, `app/test/contactTimeline.test.ts`)

Spec D20, D22 ("Share wording"), invariant I2; rulings R3-F1..F14. Depends on
S2 (`contactsRepo.getRecipientDisplaysByIds` and its FakeWorld twin, with
`RecipientDisplay` exported - assembly ruling S1/S2-1). Nothing here touches the
dashboard.

What S6 deliberately does NOT do (rulings R3-F11, F12, F14):
- no type re-fence in the fan-out (`broadcastFanOut.ts` `fenceFor`,
  `resolveContact` stay type-agnostic): a contact re-typed between Send and
  the fan-out is texted into a thread minted for its CURRENT type;
- no rename of persisted keys: the finalize audit payload's `tenantCount`
  and the wire field `ListingSendRow.tenantName` stay;
- no deleted-contact check in the new predicate: seed and explicit
  resolution accept a soft-deleted contact today and the fan-out skips it
  (`contact_deleted`) - unchanged;
- filters stay tenant-only (`parseAudienceFilter`, `audienceResolution.ts`
  `if (contact.type !== 'tenant') continue;`), and so does the composer's
  recipient search (dashboard, untouched).

### Task 6.1 - seeds and the explicit recipient list accept tenants OR partners (D20)

One predicate, used by `resolveSeeds` and the explicit-selection loop. Every
other fence (phone, opt-out, unreachable; consent in the fan-out) is
unchanged. `resolveSeeds` serves the create estimate, the preview union and
the seeds_only no-body send, so all three accept a partner seed.

RED - `app/test/broadcastApi.test.ts`. The new describe goes immediately
BEFORE the file's last line `});` (the close of
`describe('share-broadcast API (M1.8a)'`), so it reuses `world`,
`queueAdapter`, the `beforeEach` jobs wiring, `seedTenant`, `seedUnit` and the
in-describe `createDraft`. Current (the file's last four lines - unique,
because `});` at column 0 occurs only once):

```ts
      expect(res.status).toBe(200);
    });
  });
});
```

Replace with those same first three lines, then the block below, then the
final `});`:

```ts
      expect(res.status).toBe(200);
    });
  });

  // --- caseworkers (spec 2026-10-06 D20, plan 3.7): a seed or an explicit
  // recipient may be a TENANT or a PARTNER; a filter stays tenant-only -----
  describe('caseworkers D20: direct shares accept partners', () => {
    const PARTNER_PHONE = '+15550100081';

    /** A consented partner (seedTenant's defaults, re-typed). */
    function seedPartner(overrides: Partial<ContactItem> = {}): ContactItem {
      return seedTenant(world, {
        contactId: 'c-partner',
        type: 'partner',
        status: 'active',
        phone: PARTNER_PHONE,
        firstName: 'Cora',
        lastName: 'Reyes',
        ...overrides,
      });
    }

    function postSeeded(app: import('express').Express, seedContactIds: string[]) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'Hi [TenantName]!', seedContactIds });
    }

    function step(
      app: import('express').Express,
      id: string,
      which: 'preview' | 'send',
      body: Record<string, unknown> = {},
    ) {
      return request(app)
        .post(`/api/broadcasts/${id}/${which}`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    it('a partner seed counts in the draft estimate and previews as a resolved, seeded row', async () => {
      seedUnit(world);
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner']);
      expect(created.status).toBe(201);
      expect(created.body.estimatedCount).toBe(1);
      expect(world.broadcasts.get(created.body.broadcastId)?.audience_mode).toBe('seeds_only');

      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates).toHaveLength(1);
      expect(preview.body.candidates[0]).toMatchObject({
        contactId: 'c-partner',
        firstName: 'Cora',
        lastName: 'Reyes',
        phone: PARTNER_PHONE,
        seeded: true,
        has_consent: true,
      });
      expect(preview.body.unresolvedSeedIds).toEqual([]);
    });

    it('a seeds_only no-body send texts the partner seed', async () => {
      seedUnit(world);
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner']);
      const send = await step(app, created.body.broadcastId, 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(1);
      expect(Object.keys(world.broadcasts.get(created.body.broadcastId)!.recipients)).toEqual(['c-partner']);
      await queueAdapter.settle();
      expect(world.sent.map((s) => s.to)).toEqual([PARTNER_PHONE]);
    });

    it('an explicit selection keeps tenants and partners and still drops landlord, team member, unknown-type and unknown-id contacts', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-ok', phone: '+15550100082' });
      seedPartner();
      world.contacts.push({ contactId: 'c-ll2', type: 'landlord', status: 'active', phone: '+15550100083' });
      world.contacts.push({ contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550100084' });
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550100085' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const send = await step(app, id, 'send', {
        recipientContactIds: ['c-ok', 'c-partner', 'c-ll2', 'c-team', 'c-unk', 'c-missing'],
      });
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(2);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-ok', 'c-partner']);
    });

    it('a partner seed meets every other fence: opted-out, unreachable and phone-less partners (and a landlord) stay unresolved', async () => {
      seedUnit(world);
      seedPartner();
      seedPartner({ contactId: 'c-p-stop', phone: '+15550100086', sms_opt_out: true });
      seedPartner({ contactId: 'c-p-dead', phone: '+15550100087', sms_unreachable: true });
      seedPartner({ contactId: 'c-p-nophone', phone: undefined });
      world.contacts.push({ contactId: 'c-ll-seed', type: 'landlord', status: 'active', phone: '+15550100088' });
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner', 'c-p-stop', 'c-p-dead', 'c-p-nophone', 'c-ll-seed']);
      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-partner']);
      expect(preview.body.unresolvedSeedIds).toEqual(['c-p-stop', 'c-p-dead', 'c-p-nophone', 'c-ll-seed']);
    });

    it('(PIN) a filter-resolved audience stays tenant-only: a partner who is not a seed is never a candidate', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-filter-t', phone: '+15550100089' });
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const preview = await step(app, id, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-filter-t']);
    });
  });
});
```

No existing test breaks: every app test that drops a non-tenant uses a
LANDLORD (`broadcastApi.test.ts` "send-by-selection re-enforces ..." `c-ll`,
the 66-id chunk test `sel-ll`, `contactsBatchReads.test.ts` "the selection
send path still re-fences ..." `c-landlord`), and no test pins a partner seed
landing in `unresolvedSeedIds` (R3 reference 3.1).

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastApi.test.ts -t "caseworkers D20"`
- RED: case 1 - `estimatedCount` 0 and `candidates` empty (the partner seed
  is in `unresolvedSeedIds`); case 2 - 400 `empty_audience`; case 3 - `count`
  1 (the partner dropped as a non-tenant); case 4 - `candidates` empty. The
  (PIN) passes.

GREEN - `app/src/routes/broadcasts.ts` (match the TEXT).

1. Add the predicate immediately BEFORE the `buildRecipientsFrom` doc block.
   Current:

```ts
/**
 * Build the recipients map from a list of already-sendable contacts: one
```

   Replace with:

```ts
/**
 * Spec 2026-10-06 D20 (caseworkers): the contact types a share may text BY
 * NAME - a seed or an explicitly checked recipient. ONE predicate for
 * resolveSeeds and the explicit-selection send path, so the two cannot drift.
 * Filter-resolved audiences stay tenant-only (parseAudienceFilter and the
 * audience resolver), and the dashboard's recipient search stays tenant-only.
 * Deleted contacts are NOT fenced here (pre-existing; the fan-out skips them
 * as contact_deleted).
 */
function isDirectShareRecipientType(type: unknown): boolean {
  return type === 'tenant' || type === 'partner';
}

/**
 * Build the recipients map from a list of already-sendable contacts: one
```

2. The `resolveSeeds` doc and fence. Current:

```ts
  /** Resolve seed contact ids to sendable tenants using the SAME fences as the
   *  explicit-selection send path: exists, type 'tenant', has phone, not
   *  sms_opt_out, not sms_unreachable. Anything else lands in `unresolved`.
   *  Seeds are few (1..handful), so per-id getById is fine. */
```

   Replace with:

```ts
  /** Resolve seed contact ids to sendable recipients using the SAME fences as
   *  the explicit-selection send path: exists, type tenant OR partner
   *  (isDirectShareRecipientType - spec 2026-10-06 D20), has phone, not
   *  sms_opt_out, not sms_unreachable. Anything else lands in `unresolved`.
   *  Seeds are few (1..handful), so per-id getById is fine. */
```

   Then, current:

```ts
      if (
        !c ||
        c.type !== 'tenant' ||
        typeof c.phone !== 'string' ||
```

   Replace with:

```ts
      if (
        !c ||
        !isDirectShareRecipientType(c.type) ||
        typeof c.phone !== 'string' ||
```

3. The explicit-selection loop. Current:

```ts
        if (contact.type !== 'tenant') continue; // never text a non-tenant
```

   Replace with:

```ts
        if (!isDirectShareRecipientType(contact.type)) continue; // tenant or partner only (D20)
```

4. Comments that now contradict the code (comment-only):
   - Header, current:

```ts
// Audience: TENANT 1:1 contacts ONLY (never relay-group rosters), filtered by
// housing authority and/or exact bedroom size; opted-out + unreachable are
// ALWAYS excluded. The send fans out through the SHARED A2P throttle (the
// broadcast.send job + worker a2pBucket).
```

     Replace with:

```ts
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), by housing authority and/or exact bedroom size; hand-picked seeds
// and an explicit recipient list may also name PARTNERS (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
```

   - The send-path comment (the line before and after it carry em dashes -
     leave those two lines untouched). Current:

```ts
    //      hard fences the audience resolver applies (drop unknown / non-tenant
    //      / opted-out / unreachable / phone-less). The already-sent flag is a
```

     Replace with:

```ts
    //      hard fences the audience resolver applies, except that a partner
    //      passes too (D20) - drop unknown ids, any other type, opted-out,
    //      unreachable, phone-less. The already-sent flag is a
```

   - The seeds_only branch, current:

```ts
        // Every seed dropped (unknown / non-tenant / opted-out / unreachable /
```

     Replace with:

```ts
        // Every seed dropped (unknown / not a tenant or partner / opted-out / unreachable /
```

   - The results enrichment doc (the dashboard's fallback changes in Task
     9.5). Current:

```ts
 *   the dashboard falls back to today's "Tenant" label. A partial batch (keys
```

     Replace with:

```ts
 *   the dashboard falls back to its neutral "Recipient" label. A partial batch (keys
```

5. `app/src/services/audienceResolution.ts` (comment-only; R3 S10). Current:

```ts
        // The byHousingAuthority GSI is tenant-sparse, but defend the type
        // invariant either way (never text a non-tenant; never relay rosters).
```

   Replace with:

```ts
        // The byHousingAuthority GSI holds every contact type, so this fence is
        // load-bearing: a FILTER-resolved audience is tenants only (spec
        // 2026-10-06 D20 - partners join a share only as seeds or explicit
        // recipients; never relay rosters).
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/audienceResolution.test.ts` - GREEN (whole files).
Then `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Pins changed: none (unit or e2e).

Commit (stage `app/src/routes/broadcasts.ts`, `app/src/services/audienceResolution.ts`,
`app/test/broadcastApi.test.ts`)
`feat(caseworkers): share seeds and explicit recipients accept partners (D20)`.

### Task 6.2 - preview voucher facts only for tenant-typed recipients (D20, ruling R3-F6)

The facts are stripped at the SOURCE (`resolveSeeds`), so the preview
candidate map (which copies them when present) needs no change. Audience rows
are tenants already. Depends on Task 6.1 (before it, a partner seed never
resolves). The dashboard never renders these fields (R3-F6), so this is an
API test only; the lean partner Renee Carter (`contact-hastaff-0001`, a
partner holding a housing authority, no consent) is the negative fixture,
read from the lean seed itself.

RED - `app/test/broadcastApi.test.ts`.

1. Imports. Current:

```ts
import type { UnitItem } from '../src/repos/unitsRepo.js';
```

   Replace with:

```ts
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { SEED } from '../src/lib/seed/lean.js';
```

2. A new case immediately AFTER the existing
   `it('preview candidates carry voucherSize/housingAuthority when present'`.
   Current (its last three lines; `expect(bare)` occurs only there):

```ts
    expect(bare).not.toHaveProperty('voucherSize');
    expect(bare).not.toHaveProperty('housingAuthority');
  });
```

   Replace with those three lines, then:

```ts

  it('caseworkers D20: a PARTNER seed previews WITHOUT voucher facts (lean Renee Carter is the negative); a tenant seed keeps them', async () => {
    seedUnit(world);
    const renee = SEED.contacts.find((c) => c['contactId'] === 'contact-hastaff-0001') as unknown as ContactItem;
    // The fixture is what the ruling says it is: a partner holding a housing
    // authority (a leftover, not a voucher fact).
    expect(renee.type).toBe('partner');
    expect(typeof renee.housingAuthority).toBe('string');
    // A voucher size on the copy too, so BOTH fields are proved stripped.
    world.contacts.push({ ...renee, voucherSize: 2 });
    seedTenant(world, {
      contactId: 'c-voucher',
      phone: '+15550100071',
      voucherSize: 3,
      housingAuthority: 'Atlanta Housing Authority',
    } as Partial<ContactItem>);
    const { app } = makeWebhookHarness({ world });
    const created = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'Hi!', seedContactIds: ['contact-hastaff-0001', 'c-voucher'] });
    expect(created.status).toBe(201);
    const res = await request(app)
      .post(`/api/broadcasts/${created.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.unresolvedSeedIds).toEqual([]);
    const rows = res.body.candidates as Array<Record<string, unknown>>;
    const partnerRow = rows.find((c) => c['contactId'] === 'contact-hastaff-0001');
    expect(partnerRow).toMatchObject({ firstName: 'Renee', lastName: 'Carter', seeded: true, has_consent: false });
    expect(partnerRow).not.toHaveProperty('voucherSize');
    expect(partnerRow).not.toHaveProperty('housingAuthority');
    expect(rows.find((c) => c['contactId'] === 'c-voucher')).toMatchObject({
      voucherSize: 3,
      housingAuthority: 'Atlanta Housing Authority',
    });
  });
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastApi.test.ts -t "voucher facts"`
- RED: `partnerRow` carries `voucherSize: 2` and Renee's `housingAuthority`.

GREEN - `app/src/routes/broadcasts.ts`.

1. In `resolveSeeds`, current:

```ts
        ...(typeof c.voucherSize === 'number' && { voucherSize: c.voucherSize }),
        ...(typeof c.housingAuthority === 'string' && { housingAuthority: c.housingAuthority }),
```

   Replace with:

```ts
        // Spec 2026-10-06 D20: voucher facts describe a TENANT's voucher. A
        // partner's leftover housing authority is not one, so a partner seed
        // carries neither field (the preview candidate copies only what is here).
        ...(c.type === 'tenant' && typeof c.voucherSize === 'number' && { voucherSize: c.voucherSize }),
        ...(c.type === 'tenant' &&
          typeof c.housingAuthority === 'string' && { housingAuthority: c.housingAuthority }),
```

2. The preview route comment, current:

```ts
  // candidate carries voucherSize/housingAuthority for the row, plus
```

   Replace with:

```ts
  // candidate carries voucherSize/housingAuthority for the row (tenants only,
  // spec 2026-10-06 D20), plus
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastApi.test.ts` - GREEN (the whole file; the
existing "preview candidates carry voucherSize/housingAuthority when present"
tenant case still passes). Typecheck exit 0.

Pins changed: none.

Commit (stage `app/src/routes/broadcasts.ts`, `app/test/broadcastApi.test.ts`)
`feat(caseworkers): preview voucher facts only for tenant recipients (D20)`.

### Task 6.3 - both fan-out mint sites use the contact's conversation type (D20, I2)

`createOrGetByParticipantPhone` returns an existing open thread for the
phone whatever its type and writes `type` only on a FRESH row (R3-F8), so the
tests say "no thread for this phone". The adoption site in practice finds the
thread the pass minted; it mints only when the thread is missing (for
example the contact's phone changed between the pass and the reconcile), so
it is proved by calling `adoptBroadcastRecipient` directly (ruling R3-F8).
`conversationTypeFor` (`app/src/lib/voiceMasking.ts`) maps tenant ->
`tenant_1to1`, partner -> `partner_1to1`, landlord -> `landlord_1to1`, else
`unknown_1to1`; a tenant share is unchanged.

RED - `app/test/broadcastFanOut.test.ts`.

1. Imports. Current:

```ts
import {
  BROADCAST_SEND_JOB,
  broadcastBackoffMs,
```

   Replace with:

```ts
import {
  adoptBroadcastRecipient,
  BROADCAST_SEND_JOB,
  broadcastBackoffMs,
```

2. New cases inside `describe('broadcast.send (M1.8a)'`, immediately BEFORE
   the existing opted-out case. Current:

```ts
  it('skips an opted-out recipient (skipped_opted_out++), NO token spent, NO send', async () => {
```

   Replace with:

```ts
  // --- caseworkers (spec 2026-10-06 D20, invariant I2): a share to a PARTNER
  // never mints a tenant_1to1 thread - both mint sites use the contact's type.
  it('caseworkers I2: the send pass mints partner_1to1 for a partner with no thread for this phone; a tenant still gets tenant_1to1', async () => {
    const partner = seedTenant(world, { contactId: 'c-partner', type: 'partner', firstName: 'Pat', phone: '+15550100061' });
    const tenant = seedTenant(world, { contactId: 'c-tenant', firstName: 'Tia', phone: '+15550100062' });
    seedUnit(world);
    seedBroadcast(world, [partner, tenant]);
    wireHandler(world, logger);
    const threadsFor = (phone: string) =>
      [...world.conversations.values()].filter((c) => c.participant_phone === phone);
    // No thread for either phone before the share.
    expect(threadsFor('+15550100061')).toHaveLength(0);
    expect(threadsFor('+15550100062')).toHaveLength(0);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(threadsFor('+15550100061').map((c) => c.type)).toEqual(['partner_1to1']);
    expect(threadsFor('+15550100062').map((c) => c.type)).toEqual(['tenant_1to1']);
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550100061', '+15550100062']);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-partner']?.status).toBe('sent');
  });

  it('(PIN) caseworkers D20: a partner with an existing open thread is texted INTO it whatever its type (no re-type, no second thread)', async () => {
    const partner = seedTenant(world, { contactId: 'c-partner', type: 'partner', phone: '+15550100063' });
    seedUnit(world);
    const existing = await world.conversationsRepo.createOrGetByParticipantPhone('+15550100063', 'unknown_1to1');
    seedBroadcast(world, [partner]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const threads = [...world.conversations.values()].filter((c) => c.participant_phone === '+15550100063');
    expect(threads.map((c) => [c.conversationId, c.type])).toEqual([[existing.conversationId, 'unknown_1to1']]);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-partner']?.conversationId).toBe(existing.conversationId);
  });

  it('caseworkers I2: the send.reconcile ADOPTION mints partner_1to1 for a partner whose phone has no thread (adoptBroadcastRecipient called directly)', async () => {
    const partner = seedTenant(world, { contactId: 'c-partner', type: 'partner', firstName: 'Pat', phone: '+15550100064' });
    seedUnit(world);
    seedBroadcast(world, [partner]);

    const result = await adoptBroadcastRecipient(
      {
        broadcasts: world.broadcastsRepo,
        contacts: world.contactsRepo,
        conversations: world.conversationsRepo,
        messages: world.messagesRepo,
        activityEvents: world.activityEventsRepo,
        listingSends: world.listingSendsRepo,
        audit: world.auditRepo,
        events: world.events,
        log: logger,
      },
      {
        broadcastId: 'bcast-1',
        contactKey: 'c-partner',
        providerSid: 'SMadoptpartner0001',
        providerTs: new Date().toISOString(),
        providerStatus: 'sent',
        body: 'Hi Pat',
        mediaCount: 0,
      },
    );

    expect(result).toBe('adopted');
    const threads = [...world.conversations.values()].filter((c) => c.participant_phone === '+15550100064');
    expect(threads.map((c) => c.type)).toEqual(['partner_1to1']);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-partner']).toMatchObject({
      status: 'sent',
      conversationId: threads[0]!.conversationId,
    });
  });

  it('skips an opted-out recipient (skipped_opted_out++), NO token spent, NO send', async () => {
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastFanOut.test.ts -t "caseworkers"`
- RED: the two non-PIN cases mint `tenant_1to1` for the partner (both sites
  hard-code it). The (PIN) passes.

GREEN - `app/src/jobs/broadcastFanOut.ts`.

1. Import. Current:

```ts
import { hasSmsConsent } from '../lib/smsCompliance.js';
```

   Replace with:

```ts
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
```

2. The send pass. Current:

```ts
        // Resolve/find the tenant's 1:1 conversation by phone, then send INTO it.
        const conversation = await conversationStore.createOrGetByParticipantPhone(contact.phone, 'tenant_1to1');
```

   Replace with:

```ts
        // Resolve/find the recipient's 1:1 conversation by phone, then send INTO
        // it. An existing open thread is used whatever its type; a thread minted
        // here takes the contact's OWN type (spec 2026-10-06 D20, invariant I2 -
        // never tenant_1to1 for a partner).
        const conversation = await conversationStore.createOrGetByParticipantPhone(
          contact.phone,
          conversationTypeFor(contact),
        );
```

3. The adoption. Current:

```ts
  const conversation = await deps.conversations.createOrGetByParticipantPhone(contact.phone, 'tenant_1to1');
```

   Replace with:

```ts
  // Spec 2026-10-06 D20 / I2: the same rule as the pass - the contact's own type.
  const conversation = await deps.conversations.createOrGetByParticipantPhone(
    contact.phone,
    conversationTypeFor(contact),
  );
```

4. Comments (comment-only, all ASCII lines). Current (file header):

```ts
// broadcast.send (M1.8a) - fan a filtered share-broadcast ("Share Properties")
// out to each matching TENANT's 1:1 conversation, throttled and idempotent.
//
// Modeled on relayFanOut.ts, but the unit differs: a broadcast sends a 1:1
// message to EACH tenant (its own conversation) via the sendMessage wrapper -
// not a relay fan-out from a pool number.
```

   Replace with:

```ts
// broadcast.send (M1.8a) - fan a share-broadcast ("Share Properties") out to
// each recipient's 1:1 conversation, throttled and idempotent. A recipient is a
// tenant or (spec 2026-10-06 D20) a partner; a thread minted here takes the
// contact's own type (conversationTypeFor - never tenant_1to1 for a partner,
// invariant I2). There is NO type re-fence at fan-out time (ruling R3-F11).
//
// Modeled on relayFanOut.ts, but the unit differs: a broadcast sends a 1:1
// message to EACH recipient (its own conversation) via the sendMessage wrapper -
// not a relay fan-out from a pool number.
```

   Then current `//     attempt owns; the tenant's conversation and the rendered body; then the`
   -> `//     attempt owns; the recipient's conversation and the rendered body; then the`;
   current `//   - SEND: sendMessage into the tenant's 1:1 conversation, STAMPED with`
   -> `//   - SEND: sendMessage into the recipient's 1:1 conversation, STAMPED with`;
   current `  // tenant's timeline. Prefer the unit (the thing sent) as the deep-link`
   -> `  // recipient's timeline. Prefer the unit (the thing sent) as the deep-link`;
   current `  // BE4/C4: the unit<->contact listing-send row lights the "Sent to tenants" /`
   -> `  // BE4/C4: the unit<->contact listing-send row lights the "Sent to" /`.

The finalize audit payload key `tenantCount` stays (persisted; R3-F12).

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts test/broadcastApi.test.ts` - GREEN (whole
files; every existing fixture pre-mints `tenant_1to1` for a TENANT, which
`conversationTypeFor` still mints). Typecheck exit 0.

Pins changed: none (no existing test asserts the minted type - R3 reference 3.1).

Commit (stage `app/src/jobs/broadcastFanOut.ts`, `app/test/broadcastFanOut.test.ts`)
`feat(caseworkers): share fan-out mints the contact's own thread type (D20, I2)`.

### Task 6.4 - units recipients rows carry the contact's type and role (D20, rulings R3-F3, R3-F4)

`GET /api/units/:unitId/recipients` reads names through S2's
`contactsRepo.getRecipientDisplaysByIds` (the display projection plus `type`
and `role`; `getDisplaysByIds` and its seven other callers are unchanged) and
adds OPTIONAL `type` / `role` to each row. A row whose contact does not
resolve (missing id, or the best-effort batch failed) OMITS both - never
null. `role` is sent only when it holds text (trimmed). The contact-side
`GET /api/contacts/:contactId/listings-sent` is unchanged (its contact is the
page owner), so the "two directions return the SAME row" pin is amended.

RED - `app/test/listingSendsApi.test.ts`.

1. Amend the shared-row pin. Current:

```ts
    expect(byUnit.body.recipients[0]).toEqual(byContact.body.sent[0]);
```

   Replace with:

```ts
    // caseworkers D20 (plan 3.7): the units side ALSO carries the recipient's
    // type (and role when set); the contact side does not (its contact is the
    // page owner). Otherwise the two directions return the same row.
    expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant' });
    expect(byContact.body.sent[0]).not.toHaveProperty('type');
    expect(byContact.body.sent[0]).not.toHaveProperty('role');
```

2. A new describe at the END of the file. Current (the file's last five
   lines):

```ts
    expect(resent?.created_at).toBe(first?.created_at); // first-write furniture preserved
    // No `response` label is ever written.
    expect(resent).not.toHaveProperty('response');
  });
});
```

   Replace with those five lines, then:

```ts

describe('caseworkers D20: recipients rows carry the contact type and role', () => {
  it('a resolved row carries type (and role when it holds text); an unresolved row omits both; listings-sent is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-ten1');
    world.contacts.push({
      contactId: 'c-pt01',
      type: 'partner',
      status: 'active',
      phone: '+15550109001',
      firstName: 'Cora',
      lastName: 'Reyes',
      role: 'Caseworker',
    });
    world.contacts.push({ contactId: 'c-pt02', type: 'partner', status: 'active', phone: '+15550109002', role: '   ' });
    world.contacts.push({ contactId: 'c-ll01', type: 'landlord', status: 'active', phone: '+15550109003' });
    for (const contactId of ['c-ten1', 'c-pt01', 'c-pt02', 'c-ll01', 'c-gone']) {
      await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
    }

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]),
    );
    expect(byId.get('c-ten1')).toMatchObject({ type: 'tenant' });
    expect(byId.get('c-ten1')).not.toHaveProperty('role');
    expect(byId.get('c-pt01')).toMatchObject({ type: 'partner', role: 'Caseworker', tenantName: 'Cora Reyes' });
    // A blank role is no role.
    expect(byId.get('c-pt02')).toMatchObject({ type: 'partner' });
    expect(byId.get('c-pt02')).not.toHaveProperty('role');
    expect(byId.get('c-ll01')).toMatchObject({ type: 'landlord' });
    // No contact row: the fields are OMITTED, never null (ruling R3-F3).
    expect(byId.get('c-gone')).not.toHaveProperty('type');
    expect(byId.get('c-gone')).not.toHaveProperty('role');

    const contactSide = await request(app)
      .get('/api/contacts/c-pt01/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(contactSide.status).toBe(200);
    expect(contactSide.body.sent[0]).not.toHaveProperty('type');
    expect(contactSide.body.sent[0]).not.toHaveProperty('role');
  });

  it('a failed display batch serves the rows with neither names nor type (best-effort, never a 500)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // Named, so the OLD read path (getDisplaysByIds, not stubbed) would serve a
    // tenantName - the RED evidence that the route switched methods.
    const named = seedTenant(world, 'c-ten2');
    named.firstName = 'Tia';
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-ten2', sentAt: SENT_AT });
    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new Error('dynamo down');
    };

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.recipients[0]).not.toHaveProperty('tenantName');
    expect(res.body.recipients[0]).not.toHaveProperty('type');
  });
});
```

3. The file's describe title (it contains an em dash; `{--}` below is the
   section 0 glyph placeholder, plan review R1 ruling B3). Current:
   `describe('GET /api/units/:unitId/recipients (BE4/C4 {--} "Sent to tenants")', () => {`
   (the line holding the unique ASCII substring `recipients (BE4/C4 `; Read
   it, replace the WHOLE line). Replace with:
   `describe('GET /api/units/:unitId/recipients (BE4/C4 - "Sent to")', () => {`
   and the header line `// BE4/C4 route tests -- the sent-to-tenants / listings-sent endpoints:`
   -> `// BE4/C4 route tests -- the "Sent to" / listings-sent endpoints:`.

RED - `app/test/contactsBatchReads.test.ts` (the second pin on this route,
assembly ruling S6/S9-4).

1. The spy helper. Current:

```ts
    getDisplaysByIds: vi.spyOn(world.contactsRepo, 'getDisplaysByIds'),
    getManyByIds: vi.spyOn(world.contactsRepo, 'getManyByIds'),
```

   Replace with:

```ts
    getDisplaysByIds: vi.spyOn(world.contactsRepo, 'getDisplaysByIds'),
    getRecipientDisplaysByIds: vi.spyOn(world.contactsRepo, 'getRecipientDisplaysByIds'),
    getManyByIds: vi.spyOn(world.contactsRepo, 'getManyByIds'),
```

2. The recipients case. Current (unique: the only `getDisplaysByIds` count
   followed by the `adversarial review r1 finding 6` comment):

```ts
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getDisplaysByIds).toHaveBeenCalledTimes(1);
    // Pin the RENDERED name too (adversarial review r1 finding 6): a call-count
```

   Replace with:

```ts
    expect(reads.getById).not.toHaveBeenCalled();
    // caseworkers D20 (ruling R3-F4): the route reads the SECOND projection
    // (names plus type and role), still ONE batch for the page.
    expect(reads.getRecipientDisplaysByIds).toHaveBeenCalledTimes(1);
    expect(reads.getDisplaysByIds).not.toHaveBeenCalled();
    // Pin the RENDERED name too (adversarial review r1 finding 6): a call-count
```

3. The header comment's primitive list. Current:

```ts
//   - getManyByIds      - full items. Used where the route reads attributes
```

   Replace with:

```ts
//   - getRecipientDisplaysByIds - the display projection plus `type` and
//     `role`. Used ONLY by the units recipients read (the "Sent to" row label).
//   - getManyByIds      - full items. Used where the route reads attributes
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/listingSendsApi.test.ts test/contactsBatchReads.test.ts`
- RED: the amended shared-row pin (no `type` on the units row), the new
  describe (no `type`/`role`; the failure case's stub is never called because
  the route still calls `getDisplaysByIds`, so `tenantName: 'Tia'` is present), and
  `getRecipientDisplaysByIds` called 0 times.

GREEN.

1. `app/src/repos/listingSendsRepo.ts`. Import, current:

```ts
import type { TourSignal } from '../lib/listingSendTour.js';
```

   Replace with:

```ts
import type { TourSignal } from '../lib/listingSendTour.js';
import type { ContactType } from './contactsRepo.js';
```

   The wire row. Current:

```ts
  broadcastId?: string;
  tour?: TourSignal;
}

export interface ListingSendsRepo {
```

   Replace with:

```ts
  broadcastId?: string;
  tour?: TourSignal;
  /** caseworkers D20 (plan 3.7): the recipient's contact type - on the units
   *  recipients read ONLY, and only when the contact resolves (absent, never
   *  null, otherwise). The dashboard labels a non-tenant row by it. */
  type?: ContactType;
  /** caseworkers D20: the recipient's role, when it holds text (same rules as `type`). */
  role?: string;
}

/** caseworkers D20: the recipient facts the units recipients read attaches to a row. */
export interface ListingSendRecipientFacts {
  type?: ContactType;
  role?: string;
}

export interface ListingSendsRepo {
```

   The serializer. Current:

```ts
export function toListingSendRow(
  item: ListingSendItem,
  tour?: TourSignal,
  tenantName?: string,
): ListingSendRow {
```

   Replace with:

```ts
export function toListingSendRow(
  item: ListingSendItem,
  tour?: TourSignal,
  tenantName?: string,
  recipient?: ListingSendRecipientFacts,
): ListingSendRow {
```

   and current:

```ts
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
    ...(tour !== undefined && { tour }),
  };
}
```

   Replace with:

```ts
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
    ...(tour !== undefined && { tour }),
    ...(recipient?.type !== undefined && { type: recipient.type }),
    ...(recipient?.role !== undefined && { role: recipient.role }),
  };
}
```

   Comment-only: `// listing-sends repo (BE4/C4) -- the "Sent to tenants" / "Properties sent" record.`
   -> `// listing-sends repo (BE4/C4) -- the "Sent to" / "Properties sent" record.`;
   `// tenant-facing "home") was sent to a tenant. Two read directions share these`
   -> `// tenant-facing "home") was sent to a contact (a tenant, or a partner - spec 2026-10-06 D20). Two read directions share these`;
   `//   - listByUnit(unitId)       -> the unit's "Sent to tenants" roster (base table).`
   -> `//   - listByUnit(unitId)       -> the unit's "Sent to" roster (base table).`;
   `//   - listByContact(contactId) -> the tenant's "Properties sent" (byContact GSI,`
   -> `//   - listByContact(contactId) -> the contact's "Properties sent" (byContact GSI,`;
   `      // older sends would otherwise vanish from the "Sent to tenants" card.`
   -> `      // older sends would otherwise vanish from the "Sent to" card.`.
   (The `ListingSendRow` JSDoc line above `contactId` contains an em dash -
   leave it.)

2. `app/src/routes/units.ts`. Imports, current:

```ts
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
```

   Replace with:

```ts
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
  type RecipientDisplay,
} from '../repos/contactsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendRecipientFacts,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
```

   A helper after `displayNameOfContact`. Current (unique):

```ts
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
```

   Replace with:

```ts
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * caseworkers D20 (plan 3.7, ruling R3-F3): a recipients row's contact type and
 * role, from the recipient display projection. `role` only when it holds text;
 * a contact that did not resolve never reaches here (its row omits both).
 */
function recipientFactsOf(contact: RecipientDisplay): ListingSendRecipientFacts {
  const role = typeof contact.role === 'string' ? contact.role.trim() : '';
  return {
    ...(contact.type !== undefined && { type: contact.type }),
    ...(role.length > 0 && { role }),
  };
}
```

   The route. Current:

```ts
    const namesByContact = new Map<string, string | undefined>();
    try {
      const displays = await contacts.getDisplaysByIds(rows.map((row) => row.contactId));
      for (const [contactId, contact] of displays) {
        namesByContact.set(contactId, displayNameOfContact(contact));
      }
    } catch (err) {
      log.warn({ err, unitId }, 'recipients name hydration failed (best-effort)');
    }
    res.json({
      recipients: rows.map((row) => {
        const pairing = toursByTenant?.get(row.contactId);
        const signal = pairing !== undefined ? deriveTourSignal(pairing) : undefined;
        return toListingSendRow(row, signal, namesByContact.get(row.contactId));
      }),
    });
```

   Replace with:

```ts
    const namesByContact = new Map<string, string | undefined>();
    const factsByContact = new Map<string, ListingSendRecipientFacts>();
    try {
      // caseworkers D20 (ruling R3-F4): the recipients-only projection also
      // carries type and role, so the dashboard can label a non-tenant row.
      const displays = await contacts.getRecipientDisplaysByIds(rows.map((row) => row.contactId));
      for (const [contactId, contact] of displays) {
        namesByContact.set(contactId, displayNameOfContact(contact));
        factsByContact.set(contactId, recipientFactsOf(contact));
      }
    } catch (err) {
      log.warn({ err, unitId }, 'recipients name hydration failed (best-effort)');
    }
    res.json({
      recipients: rows.map((row) => {
        const pairing = toursByTenant?.get(row.contactId);
        const signal = pairing !== undefined ? deriveTourSignal(pairing) : undefined;
        return toListingSendRow(
          row,
          signal,
          namesByContact.get(row.contactId),
          factsByContact.get(row.contactId),
        );
      }),
    });
```

   Comment-only: `  /** BE4/C4: the listing-send record (the "Sent to tenants" recipients read). */`
   -> `  /** BE4/C4: the listing-send record (the "Sent to" recipients read). */`;
   the route comment line (it contains an em dash; the WHOLE line is replaced
   with ASCII; `{--}` is the section 0 glyph placeholder, plan review R1
   ruling B3 - the line holding the unique ASCII substring
   `// GET /api/units/:unitId/recipients `)
   `  // GET /api/units/:unitId/recipients {--} the "Sent to tenants" list (BE4/C4).`
   -> `  // GET /api/units/:unitId/recipients - the property's "Sent to" list (BE4/C4).`;
   `  // D5); the per-tenant view is the "Sent to tenants" card (GET`
   -> `  // D5); the per-recipient view is the "Sent to" card (GET`.

3. Comment-only elsewhere: `app/src/routes/api.ts`
   `      // BE4: GET /:id/recipients (the "Sent to tenants" recipients read).`
   -> `      // BE4: GET /:id/recipients (the "Sent to" recipients read).`;
   `app/src/lib/listingSendTour.ts` `// ("Sent to tenants" on the property page, "Properties sent" on the tenant`
   -> `// ("Sent to" on the property page, "Properties sent" on the contact`;
   `app/src/lib/tables.ts` `    // directions share these rows: GET /api/units/:id/recipients ("Sent to tenants") reads`
   -> `    // directions share these rows: GET /api/units/:id/recipients ("Sent to") reads`.

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/listingSendsApi.test.ts test/contactsBatchReads.test.ts test/unitsApi.test.ts` - GREEN.
Then `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0 (the
`toListingSendRow` call in `contacts.ts` passes two arguments and is
unchanged).

Pins changed (app): `listingSendsApi.test.ts` the shared-row `toEqual`
(amended above) and its describe title; `contactsBatchReads.test.ts`
"recipients name hydration batches" (amended above). Kept green unchanged:
`listingSendsApi.test.ts` "recipients: a qualifying tour lights ONLY ..."
(`c-1` has no contact row, so its exact `toEqual` still holds - R3-F3).
e2e: none.

Commit (stage `app/src/repos/listingSendsRepo.ts`, `app/src/routes/units.ts`,
`app/src/routes/api.ts`, `app/src/lib/listingSendTour.ts`, `app/src/lib/tables.ts`,
`app/test/listingSendsApi.test.ts`, `app/test/contactsBatchReads.test.ts`)
`feat(caseworkers): property recipients rows carry type and role (D20)`.

### Task 6.5 - landlord timeline share labels go neutral (D20, D22; assembly ruling S6/S9-2)

Both label sites: the read-time recount (`sentToLabel`, applied to a
landlord's share pins) and the stored-count fallback in
`unitAuditToMilestone`. The stored site reads "Sent to N recipient(s)" for
EVERY N so the relabel predicate (`m.label.startsWith('Sent to ')`, unchanged)
always recognises a share pin. Persisted `tenantCount` stays (R3-F12).

RED - `app/test/contactTimeline.test.ts`.

1. The existing landlord case. Current:

```ts
  it('a landlord\'s broadcast_sent milestone reads "Sent to N tenants" from the share\'s reached count, "No tenants reached" when none, and keeps the stored count for a missing share', async () => {
```

   Replace with:

```ts
  it('a landlord\'s broadcast_sent milestone reads "Sent to N recipients" from the share\'s reached count, "No recipients reached" when none, and keeps the stored count for a missing share', async () => {
```

   and current:

```ts
    expect(labels).toEqual(['Sent to 2 tenants', 'No tenants reached', 'Sent to 4 tenants', 'Sent to 1 tenant']);
```

   Replace with:

```ts
    expect(labels).toEqual(['Sent to 2 recipients', 'No recipients reached', 'Sent to 4 recipients', 'Sent to 1 recipient']);
```

2. The read-failure case. Current:

```ts
    expect(bc?.label).toBe('Sent to 4 tenants');
```

   Replace with:

```ts
    expect(bc?.label).toBe('Sent to 4 recipients');
```

3. A new case, immediately BEFORE
   `  it('does NOT interleave property activity for a tenant contact', async () => {`
   (unique):

```ts
  it('caseworkers D22: a stored pin keeps the "Sent to " prefix at every count, so an audit row with no count still relabels from its share', async () => {
    const h = makeWebhookHarness();
    const { app, world } = h;
    world.contacts.push({
      contactId: 'll-d22',
      type: 'landlord',
      status: 'active',
      phone: '+15550100024',
      phones: [{ phone: '+15550100024', primary: true }],
    });
    world.units.set('u-d22', { unitId: 'u-d22', landlordId: 'll-d22', status: 'available' });
    seedShare(world, 's-nocount', 'u-d22', { 'c-1': { status: 'delivered' } });
    // A legacy audit row without tenantCount (the stored site folds it to 0),
    // and one whose share is gone (stored words only).
    await world.auditRepo.append('units#u-d22', 'broadcast_sent', { broadcastId: 's-nocount' });
    await world.auditRepo.append('units#u-d22', 'broadcast_sent', { broadcastId: 's-gone', tenantCount: 0 });

    const res = await authedGet(app, '/api/contacts/ll-d22/timeline');
    expect(res.status).toBe(200);
    const labels = (res.body.items as Array<{ kind: string; refType?: string; label?: string }>)
      .filter((i) => i.kind === 'milestone' && i.refType === 'broadcast')
      .map((m) => m.label);
    // s-nocount: stored "Sent to 0 recipients", relabeled from its share (1
    // reached) - only possible because the stored words keep the prefix.
    // s-gone: no share, so the stored words stand ("Sent to 0 recipients",
    // never "No recipients reached"). Sorted: the order is not the contract.
    expect([...labels].sort()).toEqual(['Sent to 0 recipients', 'Sent to 1 recipient']);
  });

  it('does NOT interleave property activity for a tenant contact', async () => {
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactTimeline.test.ts -t "landlord|caseworkers D22"`
- RED: every label still says "tenant(s)" ("Sent to 0 tenants" / "Sent to 1 tenant").

GREEN - `app/src/routes/contactTimeline.ts`.

1. Current:

```ts
function sentToLabel(n: number): string {
  return n === 0 ? 'No tenants reached' : `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`;
}
```

   Replace with:

```ts
function sentToLabel(n: number): string {
  // Spec 2026-10-06 D20/D22 (caseworkers): neutral words - a share may reach
  // partners. The zero case is THIS site's only (the read-time recount).
  return n === 0 ? 'No recipients reached' : sentToCountLabel(n);
}

/**
 * The stored-count words (unitAuditToMilestone): "Sent to N recipient(s)" for
 * EVERY N, 0 included, so the read-time relabel below
 * (`m.label.startsWith('Sent to ')`) always recognises a share pin - even one
 * whose audit row lost its count (folded to 0).
 */
function sentToCountLabel(n: number): string {
  return `Sent to ${n} ${n === 1 ? 'recipient' : 'recipients'}`;
}
```

2. Current (in `unitAuditToMilestone`, `broadcast_sent`):

```ts
        label: `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`,
```

   Replace with:

```ts
        label: sentToCountLabel(n),
```

3. Comment-only: `  /** share-sent-outcome D5: the landlord's "Sent to N tenants" pins recount`
   -> `  /** share-sent-outcome D5: the landlord's "Sent to N recipients" pins recount`;
   `    // share-sent-outcome D5: a landlord's "Sent to N tenants" pin (the`
   -> `    // share-sent-outcome D5: a landlord's "Sent to N recipients" pin (the`.

4. The e2e pin of this copy, in this task (plan review R1 ruling A3).
   `e2e/tests/dashboard-next/landlord-activity.spec.ts:122`. Current (ASCII,
   unique):

```ts
    const bcast = timeline.getByRole('link', { name: /Sent to 2 tenants/ }).first();
```

   Replace with:

```ts
    const bcast = timeline.getByRole('link', { name: /Sent to 2 recipients/ }).first();
```

Run: `cd "W:/tmp/caseworkers/app"; npx vitest run test/contactTimeline.test.ts` - GREEN. Typecheck
(`cd "W:/tmp/caseworkers"; npm run typecheck`, the e2e workspace included)
exit 0. Lint: `cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/landlord-activity.spec.ts`
- no error on an added line. (No e2e run here: Task 10.4 runs every pinned
test, Task 10.13 the suite.)

Pins changed: app `contactTimeline.test.ts:1234` (title), `:1264`, `:1290`;
e2e `landlord-activity.spec.ts:122` (all edited above).

Commit (stage `app/src/routes/contactTimeline.ts`, `app/test/contactTimeline.test.ts`,
`e2e/tests/dashboard-next/landlord-activity.spec.ts`)
`feat(caseworkers): landlord timeline share labels say recipients (D20, D22)`.

---

## Checkpoint after S6 - the full typecheck and `npm test` (every workspace)

Run bare from the worktree: `npm run typecheck`, then `npm test` (DynamoDB Local up). Both must exit 0 before S7 starts. A red DynamoDB-suite file is adjudicated by re-run-and-compare (AGENTS.md), never waved through.

## S7 - the dashboard org UI for both kinds

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
`dashboard/src/routes/orgs/orgCopy.ts`, `OrgPicker.tsx`, `NewOrgDialog.tsx`,
`OrgKindChoice.tsx` (new), `OrgPicker.module.css`,
`dashboard/src/routes/settings/OrgEntryDialogs.tsx`, `NotOnListSection.tsx`,
`dashboard/src/routes/contact/ContactEditForm.tsx`; tests beside each.

Depends on S5 (the wire). S8 consumes S7's names (assembly ruling S5/S7-1) and builds on Task
7.6's seam (assembly ruling S5/S7-2).

Pins this slice changes:

| pin | task |
|---|---|
| `dashboard/src/routes/orgs/orgCopy.test.ts` `usageText({ tenants: 3, otherContacts: 1, properties: 0, deleted: 2 })` and `usageBreakdown({ tenants: 1, otherContacts: 0, properties: 1, deleted: 0 })` (argument type grows; strings unchanged) | 7.1 |
| `dashboard/src/api/endpoints.test.ts` `checkOrgText({ kind: 'housing_authority', text: 'AHA', spellingFor: 'o1' })` | 7.1 (PIN; a kinds case added) |
| `dashboard/src/routes/orgs/OrgPicker.test.tsx` "Add Metro Housing Board as a new housing authority" | 7.2 (PIN) |
| `dashboard/src/routes/orgs/NewOrgDialog.test.tsx` every single-kind case (`{ kind: 'housing_authority', text: ... }` check bodies, "use Split on Settings") | 7.3 (PIN) |
| `dashboard/src/routes/settings/OrgListSection.test.tsx` `const USAGE = {` fixture (gains the totals), "3 tenants, 1 other contact, 2 properties (+2 deleted)", "8 records still hold this name (3 tenants, 1 other contact, 2 properties, 2 deleted)." | 7.4 |
| `dashboard/src/routes/settings/NotOnListSection.test.tsx` "offers each row the actions its resolution allows", "Use another name picks from the field kind list", "Add as new: from the value, ..." (no `kind` in the body) | 7.5 (PIN) |
| `dashboard/src/routes/contact/ContactEditForm.test.tsx` "a housing authority picker given an agency name offers to put it in Agency", "a refused save (422 org_not_on_list) shows under its picker, worded from the body", "\"Put it in Agency\": the agency chip is not marked either" | 7.6 (PIN) |
| `dashboard/src/routes/settings/useOrgAdmin.test.tsx` `const COUNTS`, `dashboard/src/api/endpoints.test.ts` `const counts` | none (pass-through mocks; no reader of the totals) |

### Task 7.1 - wire types, `checkOrgText` `kinds`, and the both-lists vocabulary in `orgCopy`

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
`dashboard/src/routes/orgs/orgCopy.ts`; tests
`dashboard/src/routes/orgs/orgCopy.test.ts`, `dashboard/src/api/endpoints.test.ts`.

RED: `dashboard/src/routes/orgs/orgCopy.test.ts`:
- add to the import from `'../../api/index.js'`: `type OrgUsageCounts`;
  add to the import from `'./orgCopy.js'`: `FIELD_LABEL`, `ORGANIZATION_KINDS`,
  `kindsForField`, `rewriteCountsText`.
- below the imports add:

  ```ts
  /** A usage row with nothing in it, overridden per case (plan 3.6). */
  function counts(over: Partial<OrgUsageCounts> = {}): OrgUsageCounts {
    return {
      tenants: 0,
      otherContacts: 0,
      properties: 0,
      organization: 0,
      deleted: 0,
      inUse: { active: 0, deleted: 0 },
      kindLocked: { active: 0, deleted: 0 },
      ...over,
    };
  }
  ```

- in `it('counts active records and shows deleted ones beside them', () => {`
  wrap the two literal arguments: `usageText(counts({ tenants: 3, otherContacts: 1, deleted: 2, inUse: { active: 4, deleted: 2 } }))` and
  `usageBreakdown(counts({ tenants: 1, properties: 1, inUse: { active: 2, deleted: 0 } }))` (expected strings unchanged;
  the `inUse` values are what the server sends for those columns, and Task 7.4
  makes the deleted count read `inUse.deleted` - plan review R1 ruling A10).
- add a describe at the end of the file:

  ```ts
  describe('both lists - a contact organization (spec D6, D17; R2-F4)', () => {
    it('the organization field accepts both kinds and has its own labels', () => {
      expect(ORGANIZATION_KINDS).toEqual(['housing_authority', 'agency']);
      expect(kindsForField('organization')).toEqual(['housing_authority', 'agency']);
      expect(kindsForField('housingAuthority')).toEqual(['housing_authority']);
      expect(kindsForField('accepted_authorities')).toEqual(['housing_authority']);
      expect(kindsForField('agency')).toEqual(['agency']);
      expect(FIELD_LABEL.organization).toBe('Organization');
      expect(orgListLoadError(ORGANIZATION_KINDS)).toBe("Couldn't load organizations");
      expect(rewriteCountsText({ organization: 2, skipped: 0 })).toBe('Organization fields: 2');
    });

    it('an organization refusal says "organization", never a kind', () => {
      const say = (extra: Record<string, unknown>): string => {
        const body = orgNotOnListBody(
          new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
            error: 'org_not_on_list',
            field: 'organization',
            candidates: [],
            close: [],
            ...extra,
          }),
        );
        if (body === null) throw new Error('not narrowed');
        return notOnListMessage(body);
      };
      expect(say({ text: 'AHA', candidates: [ATL, AUG] })).toBe(
        'AHA is a spelling of more than one organization (Atlanta Housing Authority, Augusta Housing Authority) - pick one.',
      );
      expect(say({ text: 'DCA HUD-VASH', compound: [[ATL], [STEP]] })).toBe(
        'DCA HUD-VASH names more than one organization - pick one of them.',
      );
    });

    it('the usage text shows organization holders only when there are some', () => {
      expect(usageText(counts({ tenants: 1, organization: 2, deleted: 1, inUse: { active: 3, deleted: 1 } }))).toBe(
        '1 tenant, 0 other contacts, 0 properties, 2 organization fields (+1 deleted)',
      );
      expect(usageBreakdown(counts({ organization: 1 }))).toBe(
        '0 tenants, 0 other contacts, 0 properties, 1 organization field, 0 deleted',
      );
      expect(usageText(counts({ tenants: 2 }))).toBe('2 tenants, 0 other contacts, 0 properties');
    });
  });
  ```

  (`ATL`, `AUG`, `STEP`, `ApiError`, `orgNotOnListBody`, `notOnListMessage`,
  `orgListLoadError`, `usageText`, `usageBreakdown` are already in the file.)

`dashboard/src/api/endpoints.test.ts`, in
`it('organization writes send the exact body to the exact route', async () => {`,
after the first `expect(request).toHaveBeenLastCalledWith('/api/organizations/check', {` block add:

```ts
  vi.mocked(request).mockResolvedValueOnce({ candidates: [], close: [] });
  await checkOrgText({ kinds: ['housing_authority', 'agency'], text: 'Step Up' });
  expect(request).toHaveBeenLastCalledWith('/api/organizations/check', {
    method: 'POST',
    body: { kinds: ['housing_authority', 'agency'], text: 'Step Up' },
  });
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/orgCopy.test.ts src/api/endpoints.test.ts`.
Expected RED: `ORGANIZATION_KINDS` / `kindsForField` are not exported
(undefined); `FIELD_LABEL.organization` is undefined; the load error says
"Couldn't load housing authorities"; "Organization fields" is humanized to
"Organization: 2"; the refusal says "housing authority" and points to "its own
field"; the usage text never shows organization. (The endpoints case is a
typecheck RED only - vitest strips types.)

Implement:

1. `dashboard/src/api/types.ts`:
   - `export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter';` becomes
     `export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter' | 'organization';`
     and its doc `/** The fields a D5 refusal can name (\`audience_filter\` = a blast filter). */` gains
     " (B) `organization` = a contact's organization, either kind (spec D17)."
   - `/** The record fields a rewrite touches (branch A). */` +
     `export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';` become
     `/** The record fields a rewrite touches (branch B adds a contact's organization). */` +
     `export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'organization';`
   - in `OrgRewriteState`, `/** Keys: housingAuthority, agency, accepted_authorities, skipped, conflicts. */`
     becomes `/** Keys: housingAuthority, agency, accepted_authorities, organization, skipped, conflicts. */`.
   - replace `export interface OrgUsageCounts {` ... `}` (its doc
     `/** Records holding an entry's exact name (spec D10), active by group plus deleted. */`) with:

     ```ts
     /** DISTINCT records, active and deleted (spec D10; R2-F1). */
     export interface OrgUseTotal {
       active: number;
       deleted: number;
     }

     /**
      * Records holding an entry's exact name (spec D10, D17; mirrors app
      * services/orgRecords.ts OrgUsageCounts). The columns are for display - one
      * record can count in two. `deleted` counts deleted holders per column hit
      * and stays on the wire for compatibility ONLY: the dashboard shows
      * `inUse.deleted` (distinct records) for "+N deleted" and in every confirm
      * sentence, so one deleted record holding the name in two fields reads
      * "+1 deleted" (Task 7.4). Delete waits for `inUse` (any field,
      * organization included) and Change kind for `kindLocked` (a field of the
      * entry's kind only): both are distinct-record totals the server computes.
      */
     export interface OrgUsageCounts {
       tenants: number;
       otherContacts: number;
       properties: number;
       /** Contacts holding the name as their organization, whatever their type. */
       organization: number;
       deleted: number;
       inUse: OrgUseTotal;
       kindLocked: OrgUseTotal;
     }
     ```

   - in `export interface NotOnListResolveBody {`, after `rememberSpelling?: boolean;` add:

     ```ts
       /** Add as new on an organization row only - required there: the list
        *  staff picked (spec D17). Never sent for another field or action. */
       kind?: OrgKind;
     ```

2. `dashboard/src/api/endpoints.ts`, `export function checkOrgText(`: replace
   `body: { kind: OrgKind; text: string; spellingFor?: string },` with

   ```ts
     body: ({ kind: OrgKind; kinds?: never } | { kinds: readonly OrgKind[]; kind?: never }) & {
       text: string;
       spellingFor?: string;
     },
   ```

   and change its doc's first line to
   "POST /api/organizations/check - the D4 resolution of `text` against `kind`, or
   against several lists with `kinds` (the organization picker, spec D17)".
3. `dashboard/src/routes/orgs/orgCopy.ts`:
   - after `export const AGENCY_KINDS: readonly OrgKind[] = ['agency'];` add:

     ```ts
     /** (B) A contact's organization takes a name from EITHER list (spec D17). */
     export const ORGANIZATION_KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];

     /** The kinds a record field accepts - the client mirror of KINDS_FOR_FIELD. */
     export function kindsForField(field: OrgRecordField): readonly OrgKind[] {
       switch (field) {
         case 'agency':
           return AGENCY_KINDS;
         case 'organization':
           return ORGANIZATION_KINDS;
         default:
           return HOUSING_AUTHORITY_KINDS;
       }
     }
     ```

     and change the comment above `HOUSING_AUTHORITY_KINDS` to
     `/** The kinds each field offers (plan 3.2 KINDS_FOR_FIELD). */`.
   - `FIELD_LABEL`: after `accepted_authorities: 'Property housing authorities',` add
     `organization: 'Organization',`.
   - `orgListLoadError` body becomes:

     ```ts
       if (kinds.includes('housing_authority') && kinds.includes('agency')) return "Couldn't load organizations";
       return kinds.includes('housing_authority') ? "Couldn't load housing authorities" : "Couldn't load agencies";
     ```

   - `notOnListMessage`: replace its body with:

     ```ts
       // (B) An organization takes either kind (spec D17): its noun is
       // "organization", and "the other kind" never happens for it.
       const organization = body.field === 'organization';
       const kind: OrgKind = body.field === 'agency' ? 'agency' : 'housing_authority';
       const noun = organization ? 'organization' : KIND_NOUN[kind];
       if (body.candidates.length > 0) {
         return `${body.text} is a spelling of more than one ${noun} (${names(body.candidates)}) - pick one.`;
       }
       if (!organization && body.otherKind !== undefined && body.otherKind.length > 0) {
         return `${body.text} is ${withArticle(otherKindOf(kind))}, not ${withArticle(kind)}.`;
       }
       if (body.compound !== undefined && body.compound.length > 0) {
         return organization
           ? `${body.text} names more than one organization - pick one of them.`
           : `${body.text} names more than one organization - pick each one in its own field.`;
       }
       if (body.close.length > 0) return `${body.text} is not on the list. Did you mean ${names(body.close)}?`;
       return `${body.text} is not on the list - pick a name from the list or add it.`;
     ```

   - `COUNT_LABEL`: after `accepted_authorities: 'Property lists',` add
     `organization: 'Organization fields',`.
   - `usageText` and `usageBreakdown`: replace both functions with:

     ```ts
     /** The column part both texts share; organization only when some contact holds it (spec D17). */
     function usageColumns(u: OrgUsageCounts): string {
       const parts = [
         plural(u.tenants, 'tenant', 'tenants'),
         plural(u.otherContacts, 'other contact', 'other contacts'),
         plural(u.properties, 'property', 'properties'),
         ...(u.organization > 0 ? [plural(u.organization, 'organization field', 'organization fields')] : []),
       ];
       return parts.join(', ');
     }

     /** "3 tenants, 1 other contact, 2 properties (+2 deleted)"; '-' while unknown. */
     export function usageText(u: OrgUsageCounts | undefined): string {
       if (u === undefined) return '-';
       const base = usageColumns(u);
       return u.deleted > 0 ? `${base} (+${u.deleted} deleted)` : base;
     }

     /** "3 tenants, 1 other contact, 2 properties, 2 deleted" - for a confirm sentence. */
     export function usageBreakdown(u: OrgUsageCounts): string {
       return `${usageColumns(u)}, ${u.deleted} deleted`;
     }
     ```

     (`usageTotal` stays until Task 7.4. These two functions still read the
     per-column `u.deleted` here; Task 7.4 switches both to the distinct
     `u.inUse.deleted` once the Settings test fixtures carry `inUse` - doing
     it here would crash A's `OrgListSection.test.tsx` cases, whose USAGE
     rows have no `inUse` until Task 7.4 replaces them.)
   - `resolutionText`: `const kind = kindForField(field);` becomes
     `const kind: OrgKind = kindsForField(field)[0] ?? 'housing_authority';`
     (an organization row is never `other_kind`). `kindForField` stays until Task 7.5.

GREEN: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs src/routes/settings src/api/endpoints.test.ts`;
`cd "W:/tmp/caseworkers"; npm run typecheck` (the `FIELD_LABEL` record is
compile-forced; nothing else is).

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/endpoints.test.ts dashboard/src/routes/orgs/orgCopy.ts dashboard/src/routes/orgs/orgCopy.test.ts; git commit -m "feat(caseworkers): dashboard org wire for organization and both-lists copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 7.2 - `OrgPicker` over both lists: "Add <text> as a new organization"

Files: `dashboard/src/routes/orgs/OrgPicker.tsx`; test `OrgPicker.test.tsx`.

RED: `dashboard/src/routes/orgs/OrgPicker.test.tsx`, inside
`describe('OrgPicker - the add step', () => {`, add:

```tsx
  it('over both lists, finds a name of either kind, and the add option says "organization" (spec D6, D17)', () => {
    const onRequestAdd = vi.fn();
    render(
      <OrgPicker
        label="Organization"
        kinds={['housing_authority', 'agency']}
        entries={ENTRIES}
        value=""
        onChange={vi.fn()}
        onRequestAdd={onRequestAdd}
      />,
    );
    fireEvent.change(combobox('Organization'), { target: { value: 'Step' } });
    expect(optionNames()).toEqual(['Step Up']);
    fireEvent.change(combobox('Organization'), { target: { value: 'HADC' } });
    expect(optionNames()).toEqual(['DeKalb County Housing Authority (HADC)']);
    fireEvent.change(combobox('Organization'), { target: { value: 'Metro Aid' } });
    expect(optionNames()).toEqual(['Add Metro Aid as a new organization']);
    fireEvent.click(screen.getByRole('option', { name: 'Add Metro Aid as a new organization' }));
    expect(onRequestAdd).toHaveBeenCalledWith('Metro Aid');
  });
```

(`'DeKalb County Housing Authority (HADC)'` is the existing spelling-match
option text, pinned by the case that types `HADC` in this file.)

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/OrgPicker.test.tsx`.
Expected RED: the add option reads "Add Metro Aid as a new housing authority".

Implement: in `OrgPicker.tsx` replace
`const addNoun = KIND_NOUN[kinds[0] ?? 'housing_authority'];` with:

```ts
  // One kind: "a new housing authority" / "a new agency"; both lists (a
  // contact's organization, spec D17): "a new organization" - the add dialog
  // then asks which list.
  const addNoun = kinds.length > 1 ? 'organization' : KIND_NOUN[kinds[0] ?? 'housing_authority'];
```

and in the header (plan review R1 ruling S5: the sentence spans two lines;
anchor on the SECOND, which is unique and on one line) replace the line

```ts
// agency). The HOST renders "Is this really new?" (NewOrgDialog) outside its
```

with the two lines

```ts
// agency; over both lists - a contact's organization, spec D17 - organization).
// The HOST renders "Is this really new?" (NewOrgDialog) outside its
```

(the line above it, `// kinds matches, the one option is "Add <text> as a new housing authority" (or`,
is unchanged); the `kinds` prop doc
`/** The entry kinds offered (branch A: one kind per field). */` becomes
`/** The entry kinds offered: one per field, or both (a contact's organization, spec D17). */`.

GREEN: the same command; typecheck.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/routes/orgs/OrgPicker.tsx dashboard/src/routes/orgs/OrgPicker.test.tsx; git commit -m "feat(caseworkers): the org picker over both lists adds a new organization" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 7.3 - `NewOrgDialog` organization mode and `OrgKindChoice`

Files: `dashboard/src/routes/orgs/NewOrgDialog.tsx`,
`dashboard/src/routes/orgs/OrgKindChoice.tsx` (new),
`dashboard/src/routes/orgs/OrgKindChoice.test.tsx` (new),
`dashboard/src/routes/orgs/OrgPicker.module.css`,
`dashboard/src/routes/orgs/orgCopy.ts` (`orgErrorCopy` gains an organization
option - plan review R1 ruling S8), `e2e/support/selectors.md` (the org-picker
row - ruling S9); test `NewOrgDialog.test.tsx`.

RED 1: create `dashboard/src/routes/orgs/OrgKindChoice.test.tsx`:

```tsx
// OrgKindChoice tests - which list a new organization goes on (spec D6, D17;
// R2-F3): two radios in a group named "Kind", NEITHER checked at first.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrgKindChoice } from './OrgKindChoice.js';

describe('OrgKindChoice', () => {
  it('has no default and reports the kind picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrgKindChoice value={null} onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Kind' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['housing_authority', 'agency']);
    expect(within(group).getByRole('radio', { name: 'Housing authority' })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Agency' })).not.toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Agency' }));
    expect(onChange).toHaveBeenCalledWith('agency');
  });

  it('shows the kind it is given, and is inert while disabled', () => {
    render(<OrgKindChoice value="housing_authority" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('radio', { name: 'Housing authority' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Agency' })).toBeDisabled();
  });
});
```

RED 2: `dashboard/src/routes/orgs/NewOrgDialog.test.tsx`: add `within` to the
`@testing-library/react` import; after the last describe add:

```tsx
describe('NewOrgDialog - organization mode (both lists; spec D6, D17; R2-F3, R2-F4)', () => {
  const MERCY = {
    orgId: 'o-mercy',
    kind: 'agency' as const,
    name: 'Mercy Care',
    spellings: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-10-07T00:00:00.000Z',
    updatedBy: 'u1',
  };

  it('checks against both lists, offers a name of either kind, and words itself as an organization', async () => {
    checkOrgText.mockResolvedValue({ match: STEP, candidates: [], close: [], nameProblem: 'org_name_taken' });
    const props = renderDialog({ kind: 'organization', text: 'step up' });
    expect(screen.getByText('Check that this organization is really new.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Use Step Up' }));
    expect(checkOrgText).toHaveBeenCalledWith(
      { kinds: ['housing_authority', 'agency'], text: 'step up' },
      expect.any(AbortSignal),
    );
    expect(props.onUse).toHaveBeenCalledWith(STEP, 'resolution');
  });

  it('asks the kind before adding: no default, "Yes, add it" stays disabled until one is chosen', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    addOrg.mockResolvedValue(MERCY);
    const props = renderDialog({ kind: 'organization', text: 'Mercy Care' });
    const group = screen.getByRole('group', { name: 'Kind' });
    expect(within(group).getByRole('radio', { name: 'Housing authority' })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Agency' })).not.toBeChecked();
    await waitFor(() => expect(screen.queryByText('Checking the list...')).not.toBeInTheDocument());
    expect(yes()).toBeDisabled();
    await user.click(within(group).getByRole('radio', { name: 'Agency' }));
    expect(yes()).toBeEnabled();
    await user.click(yes());
    expect(addOrg).toHaveBeenCalledWith({ kind: 'agency', name: 'Mercy Care' });
    await waitFor(() => expect(props.onAdded).toHaveBeenCalledWith(MERCY));
  });

  it('a shared spelling and a compound name are worded for both lists - and never point to Split', async () => {
    checkOrgText.mockResolvedValue({ candidates: [ATL, AUG], close: [], nameProblem: 'org_name_taken' });
    const { unmount } = render(
      <NewOrgDialog kind="organization" text="AHA" mode="field" onUse={vi.fn()} onAdded={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText('It is a spelling of more than one organization:')).toBeInTheDocument();
    unmount();
    checkOrgText.mockResolvedValue({ candidates: [], close: [], compound: [[DCA], [VASH]], nameProblem: 'org_name_compound' });
    renderDialog({ kind: 'organization', text: 'DCA HUD-VASH' });
    expect(
      await screen.findByText(
        'DCA HUD-VASH names more than one organization (Georgia Department of Community Affairs and HUD-Veterans Affairs Supportive Housing (HUD-VASH)). Pick one of them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Split/)).not.toBeInTheDocument();
  });

  it('a REFUSED add of a compound name never points to Split either (plan 3.9; plan review R1 ruling S8)', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [] });
    addOrg.mockRejectedValue(
      new ApiError(422, 'org_name_compound', 'org_name_compound', { error: 'org_name_compound', spans: [[DCA], [VASH]] }),
    );
    renderDialog({ kind: 'organization', text: 'DCA and VASH' });
    await waitFor(() => expect(screen.queryByText('Checking the list...')).not.toBeInTheDocument());
    await user.click(within(screen.getByRole('group', { name: 'Kind' })).getByRole('radio', { name: 'Agency' }));
    await user.click(yes());
    expect(
      await screen.findByText(
        'That names more than one organization (Georgia Department of Community Affairs and HUD-Veterans Affairs Supportive Housing (HUD-VASH)), so it cannot be one entry. Pick one of them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Split/)).not.toBeInTheDocument();
  });
});
```

(`ApiError` is already imported in this file; `DCA` and `VASH` are the
`OrgRef` constants the compound case above uses.)

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/OrgKindChoice.test.tsx src/routes/orgs/NewOrgDialog.test.tsx`.
Expected RED: `OrgKindChoice.js` does not exist; NewOrgDialog sends
`{ kind: 'organization', text }`, says "Check that this organization is not
already on the list ...", shows no Kind group, and adds with
`kind: 'organization'`; the refused compound add reads "... Use Split
instead." (`orgErrorCopy`'s single-kind wording).

Implement:

1. Create `dashboard/src/routes/orgs/OrgKindChoice.tsx`:

   ```tsx
   // OrgKindChoice - which list a NEW organization goes on (spec D6, D17;
   // R2-F3): two radios, Housing authority and Agency, in a group named "Kind",
   // with NO default - a default would silently file a new employer under the
   // wrong list. NewOrgDialog's organization mode and the Settle dialog's "Add
   // as new" on an organization row use it; each keeps its add button disabled
   // until a kind is chosen.
   import { useId } from 'react';
   import type { OrgKind } from '../../api/index.js';
   import { KIND_FIELD_LABEL } from './orgCopy.js';
   import styles from './OrgPicker.module.css';

   const KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];

   export interface OrgKindChoiceProps {
     /** null = nothing chosen yet. */
     value: OrgKind | null;
     onChange: (kind: OrgKind) => void;
     disabled?: boolean;
   }

   export function OrgKindChoice({ value, onChange, disabled = false }: OrgKindChoiceProps): React.JSX.Element {
     const name = useId();
     return (
       <fieldset className={styles.kindChoice}>
         <legend className={styles.dialogLabel}>Kind</legend>
         {KINDS.map((kind) => (
           <label key={kind} className={styles.kindOption}>
             <input
               type="radio"
               name={name}
               value={kind}
               checked={value === kind}
               disabled={disabled}
               onChange={() => onChange(kind)}
             />
             {KIND_FIELD_LABEL[kind]}
           </label>
         ))}
       </fieldset>
     );
   }
   ```

2. `dashboard/src/routes/orgs/OrgPicker.module.css`, append:

   ```css
   /* OrgKindChoice: a borderless fieldset, its two radios on one wrapping row. */
   .kindChoice {
     border: 0;
     margin: 0;
     padding: 0;
     display: flex;
     flex-wrap: wrap;
     align-items: center;
     gap: var(--sp-2);
   }

   .kindChoice > legend {
     padding: 0;
     width: 100%;
   }

   .kindOption {
     display: inline-flex;
     align-items: center;
     gap: var(--sp-1);
     font-size: var(--fs-sm);
     color: var(--c-text);
   }
   ```

3. `dashboard/src/routes/orgs/NewOrgDialog.tsx`:
   - header comment: after "... and Settings > Housing authorities & agencies
     "Add housing authority" / "Add agency"." add the sentence:
     "(B) Its ORGANIZATION mode (`kind: 'organization'`, a contact's
     organization, spec D17) checks against both lists (`/check` with
     `kinds`), asks the kind before "Yes, add it" (OrgKindChoice, no
     default) and never points to Split."
   - imports: add `ORGANIZATION_KINDS` to the `./orgCopy.js` import and add
     `import { OrgKindChoice } from './OrgKindChoice.js';`.
   - the prop `kind: OrgKind;` becomes:

     ```ts
       /** The list the name goes on - or 'organization': both lists, and staff
        *  pick the kind before adding (spec D6, D17; R2-F3). */
       kind: OrgKind | 'organization';
     ```

   - after `const [error, setError] = useState<string | null>(null);` add:

     ```ts
       // Organization mode: no default kind - "Yes, add it" waits for a choice.
       const [chosenKind, setChosenKind] = useState<OrgKind | null>(kind === 'organization' ? null : kind);
       const noun = kind === 'organization' ? 'organization' : KIND_NOUN[kind];
     ```

   - in the check effect, `void checkOrgText({ kind, text: trimmed }, controller.signal).then(` becomes:

     ```ts
           void checkOrgText(
             kind === 'organization' ? { kinds: ORGANIZATION_KINDS, text: trimmed } : { kind, text: trimmed },
             controller.signal,
           ).then(
     ```

   - `const addDisabled = busy || trimmed === '' || checking || problem !== undefined;` becomes
     `const addDisabled = busy || trimmed === '' || checking || problem !== undefined || chosenKind === null;`
   - in `add()`: `if (addDisabled) return;` becomes `if (addDisabled || chosenKind === null) return;` and
     `const entry = await addOrg({ kind, name: trimmed, ...(notes.trim() !== '' && { notes: notes.trim() }) });` becomes
     `const entry = await addOrg({ kind: chosenKind, name: trimmed, ...(notes.trim() !== '' && { notes: notes.trim() }) });`
   - the intro `{\`Check that this ${KIND_NOUN[kind]} is not already on the list under another name.\`}` becomes:

     ```tsx
               {kind === 'organization'
                 ? 'Check that this organization is really new.'
                 : `Check that this ${KIND_NOUN[kind]} is not already on the list under another name.`}
     ```

   - the fixed-text label `{\`${KIND_FIELD_LABEL[kind]}: \`}` becomes
     `{\`${kind === 'organization' ? 'Organization' : KIND_FIELD_LABEL[kind]}: \`}`.
   - right after the name field block (the `nameEditable ? (` ... `)` expression's
     closing `)}`), add:

     ```tsx
             {kind === 'organization' ? <OrgKindChoice value={chosenKind} onChange={setChosenKind} disabled={busy} /> : null}
     ```

   - the ambiguity sentence `` : `It is a spelling of more than one ${KIND_NOUN[kind]}:`}`` becomes
     `` : `It is a spelling of more than one ${noun}:`}``.
   - the other-kind block's condition `{other.length > 0 ? (` becomes
     `{kind !== 'organization' && other.length > 0 ? (` (TS then narrows
     `kind` to `OrgKind` for `otherKindOf(kind)` / `withArticle(kind)`).
   - the compound sentence: replace the whole template literal
     `` {`${trimmed} names more than one organization (${compound ... }). Pick each one in its own field; for a value already stored, use Split on Settings > Housing authorities & agencies.`} ``
     with:

     ```tsx
                 {`${trimmed} names more than one organization (${compound
                   .map((span) => span.map((ref) => ref.name).join(' or '))
                   .join(' and ')}). ${
                   kind === 'organization'
                     ? 'Pick one of them.'
                     : 'Pick each one in its own field; for a value already stored, use Split on Settings > Housing authorities & agencies.'
                 }`}
     ```

   - in `add()`'s catch, `setError(orgErrorCopy(err));` (the one in
     NewOrgDialog.tsx) becomes
     `setError(orgErrorCopy(err, { organization: kind === 'organization' }));`.

4. `dashboard/src/routes/orgs/orgCopy.ts` - a refused compound add in
   organization mode must not say "Use Split instead." (plan 3.9: an
   organization never points to Split; plan review R1 ruling S8). Every
   other caller keeps today's copy (the option defaults off).
   - Replace `export function orgErrorCopy(err: unknown): string {` with

     ```ts
     /**
      * `organization`: the caller adds or settles a contact's ORGANIZATION
      * (both lists, spec D17) - a compound name is refused with "Pick one of
      * them.", never "Use Split instead." (Split rewrites a STORED housing
      * authority; it is refused for an organization value).
      */
     export function orgErrorCopy(err: unknown, opts: { organization?: boolean } = {}): string {
     ```

     (the existing doc line above it,
     `/** Staff copy for any /api/organizations failure, using the body when it helps. */`,
     stays.)
   - In `case 'org_name_compound': {`, replace
     `      if (spans.length === 0) return orgErrorMessage(err.code);` with

     ```ts
           if (spans.length === 0) {
             return opts.organization === true
               ? 'That names more than one organization, so it cannot be one entry. Pick one of them.'
               : orgErrorMessage(err.code);
           }
     ```

     and the case's return line (unique in the file)
     (``      return `That names more than one organization (${parts}), so it cannot be one entry. Use Split instead.`;``)
     with

     ```ts
           const next = opts.organization === true ? 'Pick one of them.' : 'Use Split instead.';
           return `That names more than one organization (${parts}), so it cannot be one entry. ${next}`;
     ```

5. `e2e/support/selectors.md`, the
   `| Org pickers (contact form, property forms, composer) | options and the add step |`
   row (plan review R1 ruling S9; the row is ASCII). Replace the substring

   ```
   `ORG_PICKER.addOption` (`Add <text> as a new housing authority`/`agency`), which opens `getByRole('dialog', { name: 'Is this really new?' })`: close names as `Use <name>` buttons, then `Yes, add it`.
   ```

   with

   ```
   `ORG_PICKER.addOption` (`Add <text> as a new housing authority`/`agency`; over BOTH lists - a partner's `Organization` picker, caseworkers spec D17 - `Add <text> as a new organization`), which opens `getByRole('dialog', { name: 'Is this really new?' })`: close names as `Use <name>` buttons, then `Yes, add it` - for an organization only after a kind is chosen in `getByRole('group', { name: 'Kind' })` (radios `Housing authority` / `Agency`, NO default; `Yes, add it` stays disabled until one is checked).
   ```

   and the substring
   ``Labels `Housing authority`, `Agency`, `Housing authorities` - always `exact: true`.``
   with
   ``Labels `Housing authority`, `Agency`, `Housing authorities`, `Organization` - always `exact: true`.``
   (each substring occurs once in the file).

GREEN: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs src/routes/settings`
(every single-kind NewOrgDialog case stays green: their check body is still
`{ kind, text }` and their kind is preset; every other `orgErrorCopy` caller
passes no option and keeps "Use Split instead."); typecheck. ASCII check on
the added lines of `e2e/support/selectors.md`.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/routes/orgs/NewOrgDialog.tsx dashboard/src/routes/orgs/NewOrgDialog.test.tsx dashboard/src/routes/orgs/OrgKindChoice.tsx dashboard/src/routes/orgs/OrgKindChoice.test.tsx dashboard/src/routes/orgs/OrgPicker.module.css dashboard/src/routes/orgs/orgCopy.ts e2e/support/selectors.md; git commit -m "feat(caseworkers): Is this really new? gains an organization mode that asks the kind" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 7.4 - Settings: the Used by cell, and Delete / Change kind read the server totals

Files: `dashboard/src/routes/orgs/orgCopy.ts`,
`dashboard/src/routes/settings/OrgEntryDialogs.tsx`; tests
`dashboard/src/routes/orgs/orgCopy.test.ts`,
`dashboard/src/routes/settings/OrgListSection.test.tsx`.

RED 1: `dashboard/src/routes/orgs/orgCopy.test.ts`: add `blockingUses` to the
`./orgCopy.js` import and, inside `describe('both lists - a contact organization (spec D6, D17; R2-F4)', () => {`, add:

```ts
  it('Delete waits for every distinct record; Change kind only for holders in a field of the kind (R2-F1)', () => {
    const u = counts({ organization: 2, inUse: { active: 2, deleted: 1 }, kindLocked: { active: 0, deleted: 0 } });
    expect(blockingUses(u, 'delete')).toBe(3);
    expect(blockingUses(u, 'kind')).toBe(0);
    expect(blockingUses(undefined, 'delete')).toBeUndefined();
  });

  it('one deleted record holding the name in two fields reads "+1 deleted", never "+2" (plan review R1 ruling A10)', () => {
    // A deleted tenant holding the name as housingAuthority AND organization:
    // the per-column wire `deleted` counts 2 hits; the distinct inUse.deleted is 1.
    const u = counts({ deleted: 2, inUse: { active: 0, deleted: 1 }, kindLocked: { active: 0, deleted: 1 } });
    expect(usageText(u)).toBe('0 tenants, 0 other contacts, 0 properties (+1 deleted)');
    expect(usageBreakdown(u)).toBe('0 tenants, 0 other contacts, 0 properties, 1 deleted');
  });
```

RED 2: `dashboard/src/routes/settings/OrgListSection.test.tsx`:
- replace `const USAGE = {` ... `};` with:

  ```ts
  const USAGE = {
    'o-atl': {
      tenants: 3,
      otherContacts: 1,
      properties: 2,
      organization: 0,
      deleted: 2,
      inUse: { active: 6, deleted: 2 },
      kindLocked: { active: 6, deleted: 2 },
    },
    'o-dek': {
      tenants: 0,
      otherContacts: 0,
      properties: 0,
      organization: 0,
      deleted: 0,
      inUse: { active: 0, deleted: 0 },
      kindLocked: { active: 0, deleted: 0 },
    },
    'o-step': {
      tenants: 1,
      otherContacts: 0,
      properties: 0,
      organization: 0,
      deleted: 0,
      inUse: { active: 1, deleted: 0 },
      kindLocked: { active: 1, deleted: 0 },
    },
  };
  ```

- inside `describe('OrgListSection - admin entry actions', () => {` add:

  ```tsx
    it('organization holders: shown in Used by, they block Delete but never Change kind (spec D10, D17; R2-F1)', async () => {
      const user = userEvent.setup();
      getOrgUsage.mockResolvedValue({
        ...USAGE,
        'o-step': {
          tenants: 0,
          otherContacts: 0,
          properties: 0,
          organization: 2,
          deleted: 1,
          inUse: { active: 2, deleted: 1 },
          kindLocked: { active: 0, deleted: 0 },
        },
      });
      patchOrg.mockResolvedValue({ entry: { ...STEP_UP, kind: 'housing_authority' } });
      renderSection();
      const step = await waitFor(() => entryRow('Agencies', 'Step Up'));
      await waitFor(() =>
        expect(step).toHaveTextContent('0 tenants, 0 other contacts, 0 properties, 2 organization fields (+1 deleted)'),
      );
      await user.click(within(step).getByRole('button', { name: 'Delete Step Up' }));
      let dialog = screen.getByRole('dialog', { name: 'Delete Step Up' });
      expect(dialog).toHaveTextContent(
        '3 records still hold this name (0 tenants, 0 other contacts, 0 properties, 2 organization fields, 1 deleted).',
      );
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await user.click(within(step).getByRole('button', { name: 'Change kind of Step Up' }));
      dialog = screen.getByRole('dialog', { name: 'Change kind of Step Up' });
      expect(dialog).toHaveTextContent(
        'Step Up moves from Agencies to Housing authorities. No record changes. Contacts holding it as their organization keep it.',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Move to Housing authorities' }));
      expect(patchOrg).toHaveBeenCalledWith('o-step', { kind: 'housing_authority' });
    });

    it('Change kind waits for holders in a field of the entry kind, and says so', async () => {
      const user = userEvent.setup();
      renderSection();
      const atlanta = await waitFor(() => entryRow('Housing authorities', 'Atlanta Housing Authority'));
      await waitFor(() => expect(atlanta).toHaveTextContent('3 tenants'));
      await user.click(within(atlanta).getByRole('button', { name: 'Change kind of Atlanta Housing Authority' }));
      const dialog = screen.getByRole('dialog', { name: 'Change kind of Atlanta Housing Authority' });
      expect(dialog).toHaveTextContent(
        '8 records hold this name as a housing authority (2 deleted). The kind can change only when none does.',
      );
      expect(within(dialog).getByRole('button', { name: 'Move to Agencies' })).toBeDisabled();
    });
  ```

  (The row actions' accessible names are `Change kind of ${entry.name}` and
  `Delete ${entry.name}` - `OrgListSection.tsx` - for both sections.)

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/orgCopy.test.ts src/routes/settings/OrgListSection.test.tsx`.
Expected RED: `blockingUses` is not exported; the "+1 deleted" case reads
"(+2 deleted)" and "2 deleted" (Task 7.1's functions still read the
per-column `deleted`); the Delete dialog counts the
column sum (0+0+0+1 = 1, and says "1 record still holds"); Change kind of
Step Up is DISABLED (the column sum counts the deleted organization holder)
and lacks the organization sentence; the Atlanta Change kind sentence is A's
"8 records still hold this name (...)".

Implement:

1. `dashboard/src/routes/orgs/orgCopy.ts`: replace `usageTotal` (doc + body) with:

   ```ts
   /**
    * The records that block Delete ('delete': distinct records holding the name
    * in ANY field, a contact's organization included) or Change kind ('kind':
    * distinct records holding it in a field of the entry's kind - an
    * organization accepts either kind, so it never blocks one, spec D17),
    * deleted ones included: the server's totals, never a column sum (R2-F1).
    * undefined while unknown.
    */
   export function blockingUses(u: OrgUsageCounts | undefined, mode: 'delete' | 'kind'): number | undefined {
     if (u === undefined) return undefined;
     const t = mode === 'delete' ? u.inUse : u.kindLocked;
     return t.active + t.deleted;
   }
   ```

   In the same file, the deleted count both usage texts show becomes the
   DISTINCT `inUse.deleted` (plan review R1 ruling A10; the per-column wire
   `deleted` stays in the type for compatibility only). In `usageText` replace
   `` return u.deleted > 0 ? `${base} (+${u.deleted} deleted)` : base; `` with

   ```ts
     // Distinct deleted records (R1 ruling A10): one deleted record holding the
     // name in two fields is ONE record; the per-column `deleted` would say 2.
     return u.inUse.deleted > 0 ? `${base} (+${u.inUse.deleted} deleted)` : base;
   ```

   and in `usageBreakdown` replace
   `` return `${usageColumns(u)}, ${u.deleted} deleted`; `` with
   `` return `${usageColumns(u)}, ${u.inUse.deleted} deleted`; ``
   (both lines are Task 7.1's text; `grep -n "u\.deleted" "W:/tmp/caseworkers/dashboard/src/routes/orgs/orgCopy.ts"`
   prints nothing afterwards - step 1 above already replaced `usageTotal`).

2. `dashboard/src/routes/settings/OrgEntryDialogs.tsx`:
   - in the `../orgs/orgCopy.js` import replace `usageTotal,` with `blockingUses,` and add `withArticle,`.
   - replace `function inUseText(usage: OrgUsageCounts): string {` (doc + body) with:

     ```ts
     /** "8 records still hold this name (3 tenants, ..., 2 deleted)." - Delete's count: distinct records. */
     function inUseText(usage: OrgUsageCounts): string {
       const total = blockingUses(usage, 'delete') ?? 0;
       return `${total} ${total === 1 ? 'record still holds' : 'records still hold'} this name (${usageBreakdown(usage)}).`;
     }

     /** Change kind's count: distinct records holding it in a field of its kind (spec D17). */
     function kindLockedText(entry: OrgEntry, usage: OrgUsageCounts): string {
       const total = blockingUses(usage, 'kind') ?? 0;
       return `${total} ${total === 1 ? 'record holds' : 'records hold'} this name as ${withArticle(entry.kind)} (${usage.kindLocked.deleted} deleted). The kind can change only when none does.`;
     }
     ```

   - `KindDialog`: its doc `/** "Change kind of <name>" (admin, spec D10): allowed only when no record -`
     / `*  deleted ones included - holds the name; nothing is rewritten. */` becomes
     `/** "Change kind of <name>" (admin, spec D10, D17): allowed only when no record -`
     / `*  deleted ones included - holds the name in a field of its kind; an organization holder never blocks it. Nothing is rewritten. */`;
     `const blocked = usage !== undefined && (usageTotal(usage) ?? 0) > 0;` (the FIRST
     occurrence, inside `KindDialog`) becomes:

     ```ts
       const blocked = (blockingUses(usage, 'kind') ?? 0) > 0;
       // Organization-only holders: they keep the name, which stays valid under either kind.
       const organizationOnly = (blockingUses(usage, 'delete') ?? 0) > (blockingUses(usage, 'kind') ?? 0);
     ```

     and its sentence

     ```tsx
               {blocked && usage !== undefined
                 ? `${inUseText(usage)} The kind can change only when no record uses it.`
                 : `${entry.name} moves from ${KIND_PLURAL_TITLE[entry.kind]} to ${KIND_PLURAL_TITLE[to]}. No record changes.`}
     ```

     becomes

     ```tsx
               {blocked && usage !== undefined
                 ? kindLockedText(entry, usage)
                 : `${entry.name} moves from ${KIND_PLURAL_TITLE[entry.kind]} to ${KIND_PLURAL_TITLE[to]}. No record changes.${
                     organizationOnly ? ' Contacts holding it as their organization keep it.' : ''
                   }`}
     ```

   - `DeleteDialog`: `const blocked = usage !== undefined && (usageTotal(usage) ?? 0) > 0;` becomes
     `const blocked = (blockingUses(usage, 'delete') ?? 0) > 0;` (its text keeps `inUseText(usage)`).

GREEN: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs src/routes/settings`
(the A case "delete and kind change wait until no record (deleted ones
included) uses the entry" stays green: 6+2 = 8 records); typecheck (no
`usageTotal` caller remains - `grep -rn usageTotal dashboard/src` prints nothing).

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/routes/orgs/orgCopy.ts dashboard/src/routes/orgs/orgCopy.test.ts dashboard/src/routes/settings/OrgEntryDialogs.tsx dashboard/src/routes/settings/OrgListSection.test.tsx; git commit -m "feat(caseworkers): Settings shows organization holders; Delete and Change kind read the distinct totals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 7.5 - "Not on the list": organization rows and the Settle dialog across both kinds

Files: `dashboard/src/routes/settings/NotOnListSection.tsx`,
`dashboard/src/routes/orgs/orgCopy.ts` (remove `kindForField`); test
`dashboard/src/routes/settings/NotOnListSection.test.tsx`.

RED: `dashboard/src/routes/settings/NotOnListSection.test.tsx`, after the last describe add:

```tsx
describe('NotOnListSection - organization rows (spec D17; R2-F6, R2-F8)', () => {
  const ORG_ROWS: NotOnListRow[] = [
    {
      field: 'organization',
      value: 'Shrike Housing Authority Kite Aid',
      count: 1,
      deletedCount: 0,
      resolution: { status: 'compound', compound: [[ref(SHRIKE)], [ref(KITE)]] },
    },
    {
      field: 'organization',
      value: 'Kite Ade',
      count: 2,
      deletedCount: 0,
      resolution: { status: 'unknown', close: [ref(KITE)] },
    },
  ];
  const names = (value: string): (string | null)[] =>
    within(valueRow(value)).getAllByRole('button').map((b) => b.textContent);

  it('offers Use of either kind, Add as new and Clear - never Move or Split', () => {
    renderSection({ rows: ORG_ROWS });
    expect(valueRow('Kite Ade')).toHaveTextContent('Organization');
    expect(names('Shrike Housing Authority Kite Aid')).toEqual([
      'Show records',
      'Use Shrike Housing Authority',
      'Use Kite Aid',
      'Use another name',
      'Clear',
    ]);
    expect(names('Kite Ade')).toEqual(['Show records', 'Use Kite Aid', 'Use another name', 'Add as new', 'Clear']);
  });

  it('Use of an agency name keeps "Remember this spelling", checked against that agency', async () => {
    const user = userEvent.setup();
    renderSection({ rows: ORG_ROWS });
    await user.click(within(valueRow('Kite Ade')).getByRole('button', { name: 'Use Kite Aid' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Kite Ade' });
    await waitFor(() =>
      expect(checkOrgText).toHaveBeenCalledWith(
        { kind: 'agency', text: 'Kite Ade', spellingFor: 'o-kite' },
        expect.any(AbortSignal),
      ),
    );
    expect(within(dialog).getByRole('checkbox', { name: 'Remember this spelling' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Use Kite Aid' }));
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'organization',
      value: 'Kite Ade',
      action: 'use',
      name: 'Kite Aid',
      rememberSpelling: true,
    });
  });

  it('Use another name searches both lists', async () => {
    const user = userEvent.setup();
    renderSection({ rows: ORG_ROWS });
    await user.click(within(valueRow('Kite Ade')).getByRole('button', { name: 'Use another name' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Kite Ade' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Name to use' }), 'Shrike Aid');
    await user.click(await screen.findByRole('option', { name: /^Shrike Aid/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Use Shrike Aid' }));
    expect(resolveNotOnList).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'organization', action: 'use', name: 'Shrike Aid' }),
    );
  });

  it('Add as new asks the kind - nothing is sent until one is chosen - and sends it', async () => {
    const user = userEvent.setup();
    renderSection({ rows: ORG_ROWS });
    await user.click(within(valueRow('Kite Ade')).getByRole('button', { name: 'Add as new' }));
    const dialog = screen.getByRole('dialog', { name: 'Settle Kite Ade' });
    expect(dialog).toHaveTextContent(
      'The name below is added to the list you pick, then every record holding this value changes to it (2 records).',
    );
    const add = within(dialog).getByRole('button', { name: 'Add as new' });
    expect(add).toBeDisabled();
    const group = within(dialog).getByRole('group', { name: 'Kind' });
    expect(within(group).getByRole('radio', { name: 'Agency' })).not.toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Agency' }));
    expect(add).toBeEnabled();
    await user.click(add);
    expect(resolveNotOnList).toHaveBeenCalledWith({
      field: 'organization',
      value: 'Kite Ade',
      action: 'add',
      name: 'Kite Ade',
      kind: 'agency',
    });
  });
});
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/settings/NotOnListSection.test.tsx`.
Expected RED: the compound row offers only the housing authority half
(`kindForField('organization')` is housing authority); the spelling check is
never sent (no agency target is found - Remember disappears); "Use another
name" finds no agency; Add as new has no Kind group, is enabled at once and
sends no `kind`; its sentence names "Housing authorities".

Implement (`dashboard/src/routes/settings/NotOnListSection.tsx`):

1. Imports: from `'../../api/index.js'` add `type OrgKind`; in the
   `'../orgs/orgCopy.js'` import replace `kindForField,` with `kindsForField,`;
   add `import { OrgKindChoice } from '../orgs/OrgKindChoice.js';`.
2. `function settleChoices(row: NotOnListRow)`: its `const kind = kindForField(row.field);`
   (the FIRST of the file's two occurrences - the one inside `settleChoices`)
   becomes `const kinds = kindsForField(row.field);` and
   `for (const ref of spans) if (ref.kind === kind) offerUse(ref.name);` becomes
   `for (const ref of spans) if (kinds.includes(ref.kind)) offerUse(ref.name);`.
   Its doc (plan review R1 ruling S6: the phrase "a compound value's halves
   of the field's kind" spans two lines; anchor on the second, which is
   unique and on one line) - replace the line

   ```ts
    * the field's kind, its close names); Split for a compound housing authority
   ```

   with the two lines

   ```ts
    * a kind the field accepts - both, for an organization, spec D17 - its close
    * names); Split for a compound housing authority
   ```

   and replace the doc's last text line
   ` * server refuses it (409 org_value_is_name_variant).` (unique) with

   ```ts
    * server refuses it (409 org_value_is_name_variant). An organization row is
    * never offered Move or Split (the field has no other kind).
   ```

3. `function SettleDialog(`: replace its `const kind = kindForField(row.field);`
   (the SECOND occurrence - the one inside `SettleDialog`) with:

   ```ts
     const kinds = kindsForField(row.field);
     // (B) An organization takes either kind (spec D17): Use looks names up in
     // both lists, and Add as new asks which list - no default (R2-F3).
     const organizationRow = row.field === 'organization';
     const [addKind, setAddKind] = useState<OrgKind | null>(organizationRow ? null : (kinds[0] ?? 'housing_authority'));
   ```

   - the `target` lookup `? entries.find((e) => e.kind === kind && e.name === useName)` becomes
     `? entries.find((e) => kinds.includes(e.kind) && e.name === useName)`.
   - after `const checkForId = target !== undefined && !sameAsName ? target.orgId : undefined;` add
     `const checkKind = target?.kind;` and in the effect replace
     `if (checkForId === undefined) return undefined;` with
     `if (checkForId === undefined || checkKind === undefined) return undefined;`,
     `void checkOrgText({ kind, text: row.value, spellingFor: checkForId }, controller.signal).then(` with
     `void checkOrgText({ kind: checkKind, text: row.value, spellingFor: checkForId }, controller.signal).then(`
     and the dependency list `}, [kind, row.value, checkForId]);` with
     `}, [checkKind, row.value, checkForId]);`.
   - `case 'add':`: replace the `sentence = ...` line with

     ```ts
           sentence = organizationRow
             ? `The name below is added to the list you pick, then every record holding this value changes to it (${records}).`
             : `The name below is added to ${KIND_PLURAL_TITLE[kinds[0] ?? 'housing_authority']}, then every record holding this value changes to it (${records}).`;
     ```

     and its `body =` with

     ```ts
           body =
             addName.trim() === '' || addKind === null
               ? null
               : {
                   field: row.field,
                   value: row.value,
                   action: 'add',
                   name: addName.trim(),
                   ...(rememberApplies && { rememberSpelling: rememberOn }),
                   ...(organizationRow && { kind: addKind }),
                 };
     ```

   - the "Name to use" picker `kinds={kind === 'agency' ? AGENCY_KINDS : HOUSING_AUTHORITY_KINDS}` becomes `kinds={kinds}`.
   - the Kind choice: ONE placement (plan review R1 ruling S4) - a SIBLING
     right after the Name block's whole `{settle.action === 'add' ? ( ... ) : null}`
     expression, never inside it (two JSX siblings inside that ternary would
     be a syntax error). Replace (unique: `setAddName(e.target.value)` and
     `{rememberApplies ? (` each occur once in the file)

     ```tsx
              onChange={(e) => setAddName(e.target.value)}
            />
          </div>
        ) : null}
        {rememberApplies ? (
     ```

     with

     ```tsx
              onChange={(e) => setAddName(e.target.value)}
            />
          </div>
        ) : null}
        {settle.action === 'add' && organizationRow ? (
          <OrgKindChoice value={addKind} onChange={setAddKind} disabled={busy} />
        ) : null}
        {rememberApplies ? (
     ```
4. `dashboard/src/routes/orgs/orgCopy.ts`: delete `kindForField` (doc + body) -
   `grep -rn kindForField dashboard/src` must print nothing.

GREEN: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/settings src/routes/orgs`
(every A case in NotOnListSection.test stays green - housing authority,
agency and property rows behave as before and send no `kind`); typecheck.

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/routes/settings/NotOnListSection.tsx dashboard/src/routes/settings/NotOnListSection.test.tsx dashboard/src/routes/orgs/orgCopy.ts; git commit -m "feat(caseworkers): settle organization values across both lists; Add as new asks the kind" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 7.6 - `ContactEditForm` routes org answers by FIELD and takes an organization 422 (the S8 seam)

Files: `dashboard/src/routes/orgs/orgCopy.ts`,
`dashboard/src/routes/contact/ContactEditForm.tsx`; tests
`dashboard/src/routes/orgs/orgCopy.test.ts`,
`dashboard/src/routes/contact/ContactEditForm.test.tsx` (PIN only).

This task builds the seam of assembly ruling S5/S7-2: the form's org plumbing becomes
field-keyed with the two tenant arms; S8 adds the organization arm and the
partner picker. Nothing here changes what a tenant form does.

RED: `dashboard/src/routes/orgs/orgCopy.test.ts`: add `isOrgFormField`,
`newOrgDialogKind`, `orgPickField` to the `./orgCopy.js` import and, inside
`describe('both lists - a contact organization (spec D6, D17; R2-F4)', () => {`, add:

```ts
  it('a form routes an org answer by FIELD: organization stays put; a tenant field follows the kind (R2-F8)', () => {
    expect(orgPickField('organization', STEP)).toBe('organization');
    expect(orgPickField('organization', ATL)).toBe('organization');
    expect(orgPickField('housingAuthority', STEP)).toBe('agency'); // "Put it in Agency"
    expect(orgPickField('agency', ATL)).toBe('housingAuthority');
    expect(orgPickField('housingAuthority', ATL)).toBe('housingAuthority');
    expect(newOrgDialogKind('organization')).toBe('organization');
    expect(newOrgDialogKind('agency')).toBe('agency');
    expect(newOrgDialogKind('housingAuthority')).toBe('housing_authority');
    expect(
      ['housingAuthority', 'agency', 'organization', 'accepted_authorities', 'audience_filter'].map(isOrgFormField),
    ).toEqual([true, true, true, false, false]);
  });
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/orgCopy.test.ts`.
Expected RED: `orgPickField`, `newOrgDialogKind`, `isOrgFormField` are not exported.

Implement:

1. `dashboard/src/routes/orgs/orgCopy.ts`, after `kindsForField` add:

   ```ts
   /** The org fields a contact FORM edits: the tenant pair and (B) a partner's organization. */
   export type OrgFormField = 'housingAuthority' | 'agency' | 'organization';

   /**
    * Where a form puts an answer from "Is this really new?" opened by `field`'s
    * picker (R2-F8): an organization takes a name of EITHER kind and keeps it;
    * a tenant field puts it in the field of its KIND - the dialog may answer
    * with the other kind ("Put it in Agency", spec D6).
    */
   export function orgPickField(field: OrgFormField, ref: OrgRef): OrgFormField {
     if (field === 'organization') return 'organization';
     return ref.kind === 'agency' ? 'agency' : 'housingAuthority';
   }

   /** The NewOrgDialog `kind` a form field's add step opens with. */
   export function newOrgDialogKind(field: OrgFormField): OrgKind | 'organization' {
     if (field === 'organization') return 'organization';
     return field === 'agency' ? 'agency' : 'housing_authority';
   }

   /** A 422 org_not_on_list a contact form shows under one of its pickers. */
   export function isOrgFormField(field: string): field is OrgFormField {
     return field === 'housingAuthority' || field === 'agency' || field === 'organization';
   }
   ```

2. `dashboard/src/routes/contact/ContactEditForm.tsx`:
   - the `'../orgs/orgCopy.js'` import gains `isOrgFormField`, `newOrgDialogKind`,
     `orgPickField`, `type OrgFormField`; remove `type OrgKind,` from the
     `'../../api/index.js'` import if `grep -n "OrgKind" dashboard/src/routes/contact/ContactEditForm.tsx`
     shows no other use after the edits below.
   - `const [adding, setAdding] = useState<{ kind: OrgKind; text: string } | null>(null);` becomes
     `const [adding, setAdding] = useState<{ field: OrgFormField; text: string } | null>(null);`
     and its comment gains: "Keyed by the FIELD whose picker opened it (R2-F8)."
   - the `orgFieldError` state type `field: 'housingAuthority' | 'agency';` becomes `field: OrgFormField;`.
   - replace

     ```ts
       /** Put a list name into the field its KIND belongs to: "Is this really
        *  new?" can answer with the other kind ("Put it in Agency"). */
       function applyOrg(ref: OrgRef): void {
         if (ref.kind === 'agency') setAgency(ref.name);
         else setHousingAuthority(ref.name);
         setOrgFieldError(null);
       }
     ```

     with

     ```ts
       /** Each org field's setter in this form - a field the form does not
        *  edit has none (R2-F8). */
       const orgSetters: Partial<Record<OrgFormField, (name: string) => void>> = {
         housingAuthority: setHousingAuthority,
         agency: setAgency,
       };

       /** Put a list name where an answer for `field`'s picker belongs
        *  (orgPickField): a tenant field follows the name's KIND - "Is this
        *  really new?" can answer with the other kind ("Put it in Agency") - and
        *  an organization keeps a name of either kind. */
       function applyOrg(field: OrgFormField, ref: OrgRef): void {
         orgSetters[orgPickField(field, ref)]?.(ref.name);
         setOrgFieldError(null);
       }
     ```

   - the two tenant pickers: `onRequestAdd={(text) => setAdding({ kind: 'housing_authority', text })}` becomes
     `onRequestAdd={(text) => setAdding({ field: 'housingAuthority', text })}`;
     `onRequestAdd={(text) => setAdding({ kind: 'agency', text })}` becomes
     `onRequestAdd={(text) => setAdding({ field: 'agency', text })}`.
   - the dialog after `</form>`: `kind={adding.kind}` becomes
     `kind={newOrgDialogKind(adding.field)}`, and each of the three
     `applyOrg(ref);` / `applyOrg(entry);` calls becomes
     `applyOrg(adding.field, ref);` / `applyOrg(adding.field, entry);`.
   - the catch: replace
     `if (refused !== null && (refused.field === 'housingAuthority' || refused.field === 'agency')) {`
     with `if (refused !== null && isOrgFormField(refused.field)) {` (the
     `setOrgFieldError({ field: refused.field, ... })` line compiles as is).

GREEN: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/orgs/orgCopy.test.ts src/routes/contact/ContactEditForm.test.tsx`
- the (PIN) cases "a housing authority picker given an agency name offers to
put it in Agency", "a close name offered by the dialog fills the field instead
of adding", "a refused save (422 org_not_on_list) shows under its picker,
worded from the body" and the "Put it in Agency" chip case stay green; then
typecheck and `cd "W:/tmp/caseworkers"; npx eslint dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/orgs/orgCopy.ts`
(no new errors versus the merge base).

Commit: `git status` (read it), then
`cd "W:/tmp/caseworkers"; git add dashboard/src/routes/orgs/orgCopy.ts dashboard/src/routes/orgs/orgCopy.test.ts dashboard/src/routes/contact/ContactEditForm.tsx; git commit -m "feat(caseworkers): the contact edit form routes org answers by field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

S8 picks up from here (assembly ruling S5/S7-2): the `organization` state, `orgSetters.organization`,
the partner Organization picker with `onRequestAdd={(text) => setAdding({ field: 'organization', text })}`,
its typed text (`useTypedOrgText(orgList, ORGANIZATION_KINDS, organizationPicker)`),
`settleTypedText` and `buildPatch` arms, and the error line
`orgFieldError?.field === 'organization' ? orgFieldError.message : null`
with `orgListLoadError(ORGANIZATION_KINDS)`.

## S8 - dashboard contacts (`dashboard/src/api`, `dashboard/src/routes/contact/*` (KindPicker, ContactCreateForm, ContactEditForm, UnknownFile, ContactActionsMenu, ContactDetail, PartnerFile, the new CaseworkerDialog), `dashboard/src/routes/contacts/*` (FilterChips, ContactsList tabs, the new CaseworkersList), `dashboard/src/app/*` (nav), `dashboard/src/App.tsx`, two `e2e/performance` pins, one e2e selector)

> **Assembly notes (BINDING - they override the task text below where they differ;
> `plan-research/plan-assembly-rulings.md`):**
> - `isCaseworkerContact` lives in `dashboard/src/routes/contact/caseworkerRole.ts` (S1's module), not in `CaseworkerDialog.tsx`; Task 8.3 adds it there and every importer imports it from there (S8-7).
> - The Caseworkers and Possible lists render `<ul aria-label="Caseworkers">` / `<ul aria-label="Possible caseworkers">`, one `<li>` per row (assembly ruling S10 "row lists").
> - The dialog count sentences, including the `leftOther` line, are plan 3.9 verbatim (S8-4).

Read spec D16-D19, D21 and D22, plan sections 3.1, 3.2, 3.8 and 3.9, rulings
R4 (all) and R2-F3/F4/F8, and `.superpowers/sdd/plan-research/R4-reference.md`
before Task 8.1. This slice assumes S1 (the dashboard module
`dashboard/src/routes/contact/caseworkerRole.ts` exporting `CASEWORKER_ROLE`,
`isCaseworkerRole`, `mentionsCaseworker`) and S7 (assembly ruling S5/S7-1's names)
are in. The server (S1-S6) is mocked in every unit test here; no e2e spec is
added (S10 owns them), but two e2e-workspace unit pins and one e2e selector
move here (C2, C3).

Slice rules (on top of plan section 0):

- Run a dashboard file with `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/<path>`
  and an e2e-workspace unit test with
  `cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/<file>`. After every
  GREEN also run `cd "W:/tmp/caseworkers"; npm run typecheck` (exit 0) - the
  app compiles `dashboard/src/api/types.ts` too, so that file's additions stay
  type-only.
- Every added line is ASCII. Several files edited here carry non-ASCII glyphs
  on OTHER lines (KindPicker.tsx lines 1, 36, 41, 46, 76, 99, 170, 174-200;
  ContactDetail.tsx lines 1-10, 624-649, 861, 901-906, 958; nav.ts lines 1-12;
  UnknownFile.tsx lines 1-8, 34; ContactsList.tsx lines 1, 6, 140). Every
  `Current` block quoted below is ASCII and avoids them; the one line that must
  change and carries a glyph (KindPicker's placeholder) says so and how.
- Line numbers are the branch base's; earlier tasks shift them. Match the
  quoted TEXT.
- `ApiError.message` is the raw code: nothing here renders it. Server codes map
  to this slice's copy (plan 3.9, C4, C5).
- The perf contract (ruling R4-13): the conversion preview is read ONLY when the
  dialog opens (the dialog is mounted only while open), the Possible list only
  by the Caseworkers page, and NOTHING new is read when ContactDetail or
  TenantFile mounts. Task 8.8 pins it.
- Known entry points that do NOT offer Caseworker, unchanged (rulings R4-17,
  R4-20): KindPicker's Other role input still accepts a typed caseworker role
  on a tenant or landlord base (the Possible list catches it), and Email
  triage's create-contact (`EmailTriage.tsx:213`) offers Tenant / Landlord /
  Partner with no role.
- Phone width (ruling R4-21): the six-segment KindPicker bar is checked at
  375 px in S10's live self-QA; no CSS change is planned here.

### Task 8.1 - API client: the caseworker wire types, the four endpoint functions, the ContactItem mirror, the two mutation-catalog rows

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
`dashboard/src/api/endpoints.test.ts`, `e2e/performance/mutationCatalog.ts`,
`e2e/performance/mutationCatalog.test.ts`.

Existing tests this task changes: `e2e/performance/mutationCatalog.test.ts`
(the 118 pin and its comment). No other test reads these names.

RED (a) - `dashboard/src/api/endpoints.test.ts`. In the import list from
`'./endpoints.js'`, current (`endpoints.test.ts:13-14`):

```ts
  acceptSuggestion,
  addOrg,
```

Replace with:

```ts
  acceptSuggestion,
  addOrg,
  dismissPossibleCaseworker,
  listPossibleCaseworkers,
  makeCaseworker,
  previewCaseworker,
```

Append at the end of the file:

```ts
it('caseworker reads unwrap their envelopes and pass the abort signal', async () => {
  const signal = new AbortController().signal;
  const row = {
    contactId: 't9',
    firstName: 'Dana',
    type: 'tenant',
    role: 'Case manager',
    signals: ['role_mentions'],
  };
  vi.mocked(request).mockResolvedValueOnce({ rows: [row] });
  await expect(listPossibleCaseworkers(signal)).resolves.toEqual([row]);
  expect(request).toHaveBeenLastCalledWith('/api/contacts/possible-caseworkers', { signal });

  const preview = {
    contactId: 'c 1',
    alreadyCaseworker: false,
    refusals: [],
    removes: { housingAuthority: 'Atlanta Housing Authority', pendingSuggestions: 2 },
    threads: { retype: 1, leftShared: 0, leftOther: 0 },
    organization: { source: 'none' },
  };
  vi.mocked(request).mockResolvedValueOnce(preview);
  await expect(previewCaseworker('c 1', signal)).resolves.toEqual(preview);
  expect(request).toHaveBeenLastCalledWith('/api/contacts/c%201/caseworker-review/preview', { signal });
});

it('caseworker writes POST the action body and unwrap { contact }', async () => {
  const contact = { contactId: 'c1', type: 'partner', role: 'Caseworker' };
  vi.mocked(request).mockResolvedValueOnce({ contact });
  await expect(makeCaseworker('c1', {})).resolves.toEqual(contact);
  // No organization key at all: the server decides (stored, else derived).
  expect(request).toHaveBeenLastCalledWith('/api/contacts/c1/caseworker-review', {
    method: 'POST',
    body: { action: 'make' },
  });

  vi.mocked(request).mockResolvedValueOnce({ contact });
  await makeCaseworker('c1', { organization: '' });
  expect(request).toHaveBeenLastCalledWith('/api/contacts/c1/caseworker-review', {
    method: 'POST',
    body: { action: 'make', organization: '' },
  });

  vi.mocked(request).mockResolvedValueOnce({ contact: { contactId: 'c 1', type: 'tenant' } });
  await expect(dismissPossibleCaseworker('c 1')).resolves.toEqual({ contactId: 'c 1', type: 'tenant' });
  expect(request).toHaveBeenLastCalledWith('/api/contacts/c%201/caseworker-review', {
    method: 'POST',
    body: { action: 'dismiss' },
  });
});
```

RED (b) - `e2e/performance/mutationCatalog.ts`. Current
(`mutationCatalog.ts:139`):

```ts
  entry(ENDPOINTS, 'runOrgRewriteAgain', 'request:POST', '/api/organizations/rewrite/run-again'),
```

Replace with:

```ts
  entry(ENDPOINTS, 'runOrgRewriteAgain', 'request:POST', '/api/organizations/rewrite/run-again'),
  // Caseworkers (spec 2026-10-06 D19): workflow_only - both fire only from a
  // click (the conversion dialog's "Make caseworker", a Possible row's "Hide").
  // The preview and the Possible list are GETs and are never catalogued.
  entry(ENDPOINTS, 'makeCaseworker', 'request:POST', '/api/contacts/:contactId/caseworker-review'),
  entry(ENDPOINTS, 'dismissPossibleCaseworker', 'request:POST', '/api/contacts/:contactId/caseworker-review'),
```

`e2e/performance/mutationCatalog.test.ts` - current (`:367`):

```ts
    // 118 = the 102 pre-manual-trigger mutations + runExtraction
```

Replace with:

```ts
    // 120 = the 102 pre-manual-trigger mutations + runExtraction
```

and current (`:377-378`):

```ts
    // addOrg, patchOrg, mergeOrg, deleteOrg, resolveNotOnList, runOrgRewriteAgain).
    expect(catalogedRaw.filter((entry) => !entry.methodClass.includes('delegated_to_typed_request_options'))).toHaveLength(118);
```

Replace with:

```ts
    // addOrg, patchOrg, mergeOrg, deleteOrg, resolveNotOnList, runOrgRewriteAgain).
    // + makeCaseworker and dismissPossibleCaseworker (caseworkers: POST
    // /api/contacts/:contactId/caseworker-review, one function per action).
    expect(catalogedRaw.filter((entry) => !entry.methodClass.includes('delegated_to_typed_request_options'))).toHaveLength(120);
```

Run RED:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/api/endpoints.test.ts` -
  the two new cases fail: `listPossibleCaseworkers is not a function` (the
  imports resolve to `undefined`).
- `cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/mutationCatalog.test.ts` -
  "matches the complete checked-in catalog in both directions" fails: the two
  new fingerprints are checked in but not discovered, and the length is 118,
  not 120.

GREEN (a) - `dashboard/src/api/types.ts`.

In `interface Contact`, current (`types.ts:2175`, unique):

```ts
  staff_notes_updated_at?: string;
```

Replace with:

```ts
  staff_notes_updated_at?: string;
  /** The helper organization a PARTNER works for (spec 2026-10-06 D17): one
   *  list name of either kind; never stored as '' (a clear REMOVEs it).
   *  MIRRORS ContactItem.organization. */
  organization?: string;
  /** Server-owned (D19): 'dismissed' hides the contact from Possible
   *  caseworkers for good. Never sent by the dashboard (400 if it is). */
  caseworker_review?: 'dismissed';
  /** Server-owned (D19): what the caseworker conversion removed, and the old
   *  type. Never sent by the dashboard. */
  caseworker_conversion?: CaseworkerConversionRecord;
  /** Server-owned (D21): staff overrode the type, so a re-import leaves type,
   *  status, housingAuthority and agency alone. Never sent by the dashboard. */
  type_source?: 'manual';
```

In `interface ContactPatch`, current (`types.ts:2277`, unique):

```ts
  staff_notes_expected_updated_at?: string | null;
```

Replace with:

```ts
  staff_notes_expected_updated_at?: string | null;
  /** A partner's organization (spec D17): a list name of either kind (422
   *  org_not_on_list otherwise); '' clears it. Only the partner edit form
   *  sends it. */
  organization?: string;
```

Current (`types.ts:2317-2321`):

```ts
export interface ContactsPage {
  contacts: Contact[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}
```

Replace with:

```ts
export interface ContactsPage {
  contacts: Contact[];
  /** Opaque cursor to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

// --- Caseworkers (spec 2026-10-06 D16-D22) -----------------------------------
// MIRRORED field for field from app/src/services/caseworkerConversion.ts,
// app/src/lib/caseworkers.ts and app/src/repos/contactsRepo.ts (plan 3.2).

/** ContactItem.caseworker_conversion - what the conversion removed. */
export interface CaseworkerConversionRecord {
  /** ISO 8601. */
  at: string;
  /** The actor's userId (the session's `req.user.userId`, as audit rows record actors) - never an email. */
  by: string;
  fromType: ContactType;
  fromRole?: string;
  /** The removed housing authority, when there was one. */
  housingAuthority?: string;
  /** The cleared agency, when it was non-empty. */
  agency?: string;
}

/** Why a contact is on the Possible caseworkers list (D19, D22). */
export type PossibleSignal = 'role_mentions' | 'ai_note' | 'relationship' | 'partner_no_role';

/** One record that blocks the conversion, with its id so the dialog can link
 *  to it. Ordered placement, tour, landlord, roster. */
export type CaseworkerRefusal =
  | { code: 'caseworker_open_placement'; placementId: string }
  | { code: 'caseworker_open_tour'; tourId: string }
  | { code: 'caseworker_landlord_of_record'; unitId: string }
  | { code: 'caseworker_on_roster'; unitId: string };

export type OrganizationSource = 'request' | 'stored' | 'list_match' | 'carried' | 'none';

/** GET /api/contacts/:contactId/caseworker-review/preview. */
export interface CaseworkerPreview {
  contactId: string;
  alreadyCaseworker: boolean;
  refusals: CaseworkerRefusal[];
  removes: { housingAuthority?: string; agency?: string; pendingSuggestions: number };
  /** leftShared = another live contact holds the phone or address; leftOther =
   *  typed for another identity, or type-less. */
  threads: { retype: number; leftShared: number; leftOther: number };
  organization: { value?: string; source: Exclude<OrganizationSource, 'request'> };
}

/** One row of GET /api/contacts/possible-caseworkers ({ rows }). */
export interface PossibleCaseworkerRow {
  contactId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  type: 'tenant' | 'landlord' | 'partner';
  role?: string;
  /** Non-empty, in PossibleSignal declaration order. */
  signals: PossibleSignal[];
}
```

GREEN (b) - `dashboard/src/api/endpoints.ts`. In the type import list, current
(`endpoints.ts:28-29`):

```ts
  ContactPatch,
  ContactsPage,
```

Replace with:

```ts
  ContactPatch,
  ContactsPage,
  CaseworkerPreview,
  PossibleCaseworkerRow,
```

Current (`endpoints.ts:1468`, unique):

```ts
// --- Conversation fact extraction: AI suggestion review (T8 routes) ----------
```

Replace with:

```ts
// --- Caseworkers (spec 2026-10-06 D19, D22; plan 3.5) ------------------------

/** GET /api/contacts/possible-caseworkers - live contacts that look like
 *  caseworkers but are not yet, each with the signals that put it there. One
 *  server read of three partitions: only the Caseworkers page reads it.
 *  Unwrapped from { rows }. */
export async function listPossibleCaseworkers(signal?: AbortSignal): Promise<PossibleCaseworkerRow[]> {
  const res = await request<{ rows: PossibleCaseworkerRow[] }>('/api/contacts/possible-caseworkers', {
    ...(signal !== undefined && { signal }),
  });
  return res.rows;
}

/** GET /api/contacts/:contactId/caseworker-review/preview - the conversion's
 *  read-only preview: refusals with their blocking ids, what it removes, the
 *  threads it re-types and leaves, the organization it would write. Read ONLY
 *  when the conversion dialog opens. 404 contact_not_found, 400
 *  caseworker_team_member. */
export function previewCaseworker(contactId: string, signal?: AbortSignal): Promise<CaseworkerPreview> {
  return request<CaseworkerPreview>(
    `/api/contacts/${encodeURIComponent(contactId)}/caseworker-review/preview`,
    { ...(signal !== undefined && { signal }) },
  );
}

/** POST /api/contacts/:contactId/caseworker-review { action: 'make',
 *  organization? } - the caseworker conversion (D19). `organization` rides
 *  ONLY when staff changed the dialog's picker ('' clears it). 409 with a
 *  refusal code + `refusals`, 409 contact_changed, 422 org_not_on_list, 404
 *  contact_not_found, 400. Unwrapped from { contact }. */
export async function makeCaseworker(contactId: string, body: { organization?: string }): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/caseworker-review`,
    { method: 'POST', body: { action: 'make', ...body } },
  );
  return res.contact;
}

/** POST /api/contacts/:contactId/caseworker-review { action: 'dismiss' } -
 *  "Not a caseworker": hides the contact from Possible caseworkers for good
 *  (no UI undo). 400 caseworker_dismiss_not_allowed. Unwrapped from
 *  { contact }. */
export async function dismissPossibleCaseworker(contactId: string): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}/caseworker-review`,
    { method: 'POST', body: { action: 'dismiss' } },
  );
  return res.contact;
}

// --- Conversation fact extraction: AI suggestion review (T8 routes) ----------
```

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/api/endpoints.test.ts` - all pass.
- `cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/mutationCatalog.test.ts` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): caseworker API client, wire types and mutation-catalog rows`
(`git status` first; stage `dashboard/src/api/types.ts`,
`dashboard/src/api/endpoints.ts`, `dashboard/src/api/endpoints.test.ts`,
`e2e/performance/mutationCatalog.ts`, `e2e/performance/mutationCatalog.test.ts`).

### Task 8.2 - KindPicker: the Caseworker segment, the offer prop, the mentions filter, the placeholder

Files: `dashboard/src/routes/contact/KindPicker.tsx`,
`dashboard/src/routes/contact/KindPicker.test.tsx`.

Existing tests this task changes: none. Every existing `KindPicker.test.tsx`
case is a PIN (no host passes `offerCaseworker` yet, so the five-segment bar is
unchanged). Their `'Case worker'` examples stay legal (ruling R4-17).

RED - `dashboard/src/routes/contact/KindPicker.test.tsx`. Current (`:1`):

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react';
```

Replace with:

```tsx
import { render, screen, fireEvent, act, within } from '@testing-library/react';
```

Append at the end of the file:

```tsx
/** A host that offers the Caseworker segment (a new contact, or a stored caseworker). */
function OfferedKindPicker({
  initial,
  onChange,
  roleSuggestions,
}: {
  initial: KindValue;
  onChange: (v: KindValue) => void;
  roleSuggestions?: string[];
}) {
  const [value, setValue] = useState<KindValue>(initial);
  return (
    <KindPicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      roleSuggestions={roleSuggestions}
      offerCaseworker
    />
  );
}

function segmentLabels(): (string | null)[] {
  const group = screen.getByRole('group', { name: 'Contact kind' });
  return within(group).getAllByRole('button').map((b) => b.textContent);
}

describe('KindPicker - the Caseworker choice (spec 2026-10-06 D16, D22)', () => {
  it('offers no Caseworker segment unless the host offers it', () => {
    render(<KindPicker value={{ type: null, role: '' }} onChange={vi.fn()} />);
    expect(segmentLabels()).toEqual(['Tenant', 'Landlord', 'Partner', 'Property Manager', 'Other']);
    expect(screen.queryByRole('button', { name: 'Caseworker' })).toBeNull();
  });

  it('offered, the segments follow the Unknown card order, then Other', () => {
    render(<OfferedKindPicker initial={{ type: null, role: '' }} onChange={vi.fn()} />);
    expect(segmentLabels()).toEqual([
      'Tenant',
      'Landlord',
      'Partner',
      'Caseworker',
      'Property Manager',
      'Other',
    ]);
  });

  it('Caseworker is a preset: partner + Caseworker, lit, and no Other panel', () => {
    const onChange = vi.fn();
    render(<OfferedKindPicker initial={{ type: null, role: '' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Caseworker' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'partner', role: 'Caseworker' });
    expect(screen.getByRole('button', { name: 'Caseworker' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Partner' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
  });

  it('Partner after Caseworker clears the role', () => {
    const onChange = vi.fn();
    render(<OfferedKindPicker initial={{ type: 'partner', role: 'Caseworker' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Partner' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'partner', role: '' });
  });

  it('a stored caseworker lights the preset only on the exact role (R4-15); a variant reads as Other', () => {
    const { unmount } = render(
      <KindPicker value={{ type: 'partner', role: 'Caseworker' }} onChange={vi.fn()} offerCaseworker />,
    );
    expect(screen.getByRole('button', { name: 'Caseworker' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
    unmount();
    render(<KindPicker value={{ type: 'partner', role: 'Case worker' }} onChange={vi.fn()} offerCaseworker />);
    expect(screen.getByRole('button', { name: 'Caseworker' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/^role$/i)).toHaveValue('Case worker');
  });

  it('the Other role suggestions leave out every role that mentions a caseworker', () => {
    const { container } = render(
      <OfferedKindPicker
        initial={{ type: null, role: '' }}
        onChange={vi.fn()}
        roleSuggestions={['Case manager', 'Caseworker', 'Senior Case Worker', 'Social worker', 'Inspector']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    const offered = Array.from(container.querySelectorAll('datalist option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(offered).toEqual(['Social worker', 'Inspector']);
  });

  it('the role placeholder no longer suggests a caseworker role', () => {
    render(<KindPicker value={{ type: null, role: '' }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    const placeholder = screen.getByLabelText(/^role$/i).getAttribute('placeholder') ?? '';
    expect(placeholder).toBe('e.g. Social worker, Inspector...');
    expect(placeholder).not.toMatch(/case ?worker/i);
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/KindPicker.test.tsx` -
the new describe fails: no "Caseworker" button (`getByRole` throws), the
datalist offers all five roles, the placeholder still reads "e.g. Case worker,
Social worker" plus an ellipsis. Every pre-existing case passes.

GREEN - `dashboard/src/routes/contact/KindPicker.tsx`.

(a) Current (`:2`, the second header line; line 1 carries a glyph - leave it
byte-identical):

```tsx
// Segments: Tenant / Landlord / Partner / Property Manager / Other.
```

Replace with:

```tsx
// Segments: Tenant / Landlord / Partner / [Caseworker] / Property Manager / Other.
// Caseworker (spec 2026-10-06 D16, D22) is a preset {type:'partner',
// role:CASEWORKER_ROLE}, shown only when the host passes `offerCaseworker` (a
// NEW contact, or a STORED caseworker): an existing contact becomes a
// caseworker only through the conversion dialog, never a save.
```

(b) Current (`:9-13`):

```tsx
import {
  patchForSuggestedContactKind,
  PM_ROLE,
  type SuggestedContactKind,
} from './contactProfile.js';
```

Replace with:

```tsx
import {
  patchForSuggestedContactKind,
  PM_ROLE,
  type SuggestedContactKind,
} from './contactProfile.js';
import { CASEWORKER_ROLE, mentionsCaseworker } from './caseworkerRole.js';
```

(c) Current (`:21-27`):

```tsx
export interface KindPickerProps {
  value: KindPickerValue;
  onChange: (v: KindPickerValue) => void;
  roleSuggestions?: string[];
}

type PrimarySegment = 'tenant' | 'landlord' | 'partner' | 'pm' | 'other';
```

Replace with:

```tsx
export interface KindPickerProps {
  value: KindPickerValue;
  onChange: (v: KindPickerValue) => void;
  roleSuggestions?: string[];
  /** Offer the "Caseworker" segment (spec D16). The HOST decides from the
   *  STORED contact (ruling R4-15): true on a new contact or when the stored
   *  contact is already a caseworker, never from the live kind. */
  offerCaseworker?: boolean;
}

type PrimarySegment = 'tenant' | 'landlord' | 'partner' | 'caseworker' | 'pm' | 'other';

/** The segment order (spec D22): the Unknown card's Mark-as order, then Other. */
const SEGMENTS: readonly PrimarySegment[] = ['tenant', 'landlord', 'partner', 'pm', 'other'];
const SEGMENTS_WITH_CASEWORKER: readonly PrimarySegment[] = [
  'tenant',
  'landlord',
  'partner',
  'caseworker',
  'pm',
  'other',
];

const SEGMENT_LABEL: Readonly<Record<PrimarySegment, string>> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
  caseworker: 'Caseworker',
  pm: 'Property Manager',
  other: 'Other',
};
```

(d) Current (`:47-63`; line 46 above it carries a glyph - leave it):

```tsx
function isPmPresetValue(value: KindPickerValue): boolean {
  return value.type === 'landlord' && value.role === PM_ROLE;
}

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
): PrimarySegment | null {
  if (isPmPresetValue(value)) return 'pm';
  const inOtherMode = otherSelected || value.role.trim() !== '';
```

Replace with:

```tsx
function isPmPresetValue(value: KindPickerValue): boolean {
  return value.type === 'landlord' && value.role === PM_ROLE;
}

/** True when the value is exactly the Caseworker preset (partner +
 *  CASEWORKER_ROLE, byte-exact as the PM preset is - ruling R4-15). A partner
 *  whose role is a variant ("Case worker") reads as Other. */
function isCaseworkerPresetValue(value: KindPickerValue): boolean {
  return value.type === 'partner' && value.role === CASEWORKER_ROLE;
}

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
  offerCaseworker: boolean,
): PrimarySegment | null {
  if (isPmPresetValue(value)) return 'pm';
  if (offerCaseworker && isCaseworkerPresetValue(value)) return 'caseworker';
  const inOtherMode = otherSelected || value.role.trim() !== '';
```

(e) Current (`:65-69`):

```tsx
export function KindPicker({
  value,
  onChange,
  roleSuggestions,
}: KindPickerProps): React.JSX.Element {
```

Replace with:

```tsx
export function KindPicker({
  value,
  onChange,
  roleSuggestions,
  offerCaseworker = false,
}: KindPickerProps): React.JSX.Element {
```

(f) Current (`:91-94`):

```tsx
  const suggestions = roleSuggestions ?? [];
  const isPmPreset = isPmPresetValue(value);
  const inOtherMode = otherSelected || (value.role.trim() !== '' && !isPmPreset);
  const active = activePrimarySegment(value, otherSelected);
```

Replace with:

```tsx
  // The Other panel (bases Tenant and Landlord only) leaves out every role
  // that MENTIONS a caseworker (spec D16, D22): on those bases they are exactly
  // the records the Possible caseworkers list exists to clean up. Typing one
  // stays possible (ruling R4-17) - the list catches it.
  const suggestions = (roleSuggestions ?? []).filter((role) => !mentionsCaseworker(role));
  const isPmPreset = isPmPresetValue(value);
  const isCaseworkerPreset = offerCaseworker && isCaseworkerPresetValue(value);
  const inOtherMode =
    otherSelected || (value.role.trim() !== '' && !isPmPreset && !isCaseworkerPreset);
  const active = activePrimarySegment(value, otherSelected, offerCaseworker);
```

(g) Current (`:105-106`, inside `handleSegment`; line 99 above carries a glyph):

```tsx
    } else {
      const canonicalKind: SuggestedContactKind = seg === 'pm' ? 'property_manager' : seg;
```

Replace with:

```tsx
    } else if (seg === 'caseworker') {
      // A preset, like Property Manager - but not a SuggestedContactKind: the
      // triage PATCH map never makes a caseworker (the conversion does).
      setOtherSelected(false);
      onChange({ type: 'partner', role: CASEWORKER_ROLE });
    } else {
      const canonicalKind: SuggestedContactKind = seg === 'pm' ? 'property_manager' : seg;
```

(h) Current (`:125-135`):

```tsx
        {(['tenant', 'landlord', 'partner', 'pm', 'other'] as PrimarySegment[]).map((seg) => {
          const label =
            seg === 'tenant'
              ? 'Tenant'
              : seg === 'landlord'
                ? 'Landlord'
                : seg === 'partner'
                  ? 'Partner'
                  : seg === 'pm'
                    ? 'Property Manager'
                    : 'Other';
```

Replace with:

```tsx
        {(offerCaseworker ? SEGMENTS_WITH_CASEWORKER : SEGMENTS).map((seg) => {
          const label = SEGMENT_LABEL[seg];
```

(i) The placeholder (`:170`). The line reads
`            placeholder="e.g. Case worker, Social worker` followed by U+2026 and
`"` - it carries the glyph, so match it by READING the file: the Edit's
`old_string` is the two lines `:169-170` copied from the Read output, anchored
by the ASCII line `:169`:

```tsx
            onChange={(e) => handleRoleChange(e.target.value)}
```

`new_string` (both lines ASCII; the touched line becomes ASCII, ruling R4-21):

```tsx
            onChange={(e) => handleRoleChange(e.target.value)}
            placeholder="e.g. Social worker, Inspector..."
```

Check: `git diff -U0 dashboard/src/routes/contact/KindPicker.tsx | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
prints 0.

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/KindPicker.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): KindPicker offers the Caseworker preset and filters caseworker roles from Other`
(stage `dashboard/src/routes/contact/KindPicker.tsx`,
`dashboard/src/routes/contact/KindPicker.test.tsx`).

### Task 8.3 - CaseworkerDialog: the conversion's one confirm dialog (and `isCaseworkerContact`)

Files (new, plan 3.1): `dashboard/src/routes/contact/CaseworkerDialog.tsx`,
`dashboard/src/routes/contact/CaseworkerDialog.test.tsx`,
`dashboard/src/routes/contact/CaseworkerDialog.module.css`; and
`dashboard/src/routes/contact/caseworkerRole.ts` (S1's module) gains
`isCaseworkerContact` - it is DEFINED there, never in the dialog, and every
importer (this task's test, Tasks 8.5, 8.8 and 8.12) imports it from
`caseworkerRole.js` (assembly ruling S8-7; plan review R1 ruling A9).

Existing tests this task changes: none.

Design (spec D19, D22; rulings R4-03, R4-08, R4-09, R4-13, R4-14; C4, C5, C7):
- A standalone component taking `contactId`, `name`, `onConverted(contact)`,
  `onClose`. Hosts (Tasks 8.8 and 8.12) mount it ONLY while open, so the
  preview read fires only when it opens.
- The preview drives everything; it is advisory (the server re-checks at
  `make`). Confirm ("Make caseworker") is disabled until the preview is in hand,
  while any refusal shows (described by the refusal list), and while busy.
- The Organization picker is A's OrgPicker over BOTH kinds, starting from
  `preview.organization.value` (a carried text shows as "Not on the list" by
  itself). Typed-not-picked text is settled with `useTypedOrgText` exactly as
  the forms do. `organization` is sent ONLY when the value differs from the
  preview's (`''` = cleared).
- Errors map codes to copy: the four refusal codes (409 + `refusals`) replace
  the preview's refusals; `contact_changed` says so and re-reads the preview
  (and resets the picker's baseline); a 422 `org_not_on_list` on `organization`
  shows under the picker; anything else is the generic line.
- `preview.alreadyCaseworker` (the server's `make` then re-runs steps 2-4 and
  IGNORES a request organization, plan 3.4 rule 2): the dialog hides the
  Organization picker, says "This contact is already a caseworker. Confirming
  re-runs the cleanup." and sends no `organization` (plan review R1 ruling
  B8 - staff must not believe they set one).
- The thread-count sentences are plan 3.9 verbatim, the `leftOther` line
  included ("... without a type ...", plan review R1 ruling A15).

RED - create `dashboard/src/routes/contact/CaseworkerDialog.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CaseworkerPreview, type Contact, type OrgEntry } from '../../api/index.js';

const previewCaseworker = vi.fn();
const makeCaseworker = vi.fn();
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    previewCaseworker: (...a: unknown[]) => previewCaseworker(...a),
    makeCaseworker: (...a: unknown[]) => makeCaseworker(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { CaseworkerDialog } from './CaseworkerDialog.js';
import { isCaseworkerContact } from './caseworkerRole.js';

function orgEntry(kind: OrgEntry['kind'], name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings,
    createdAt: '2026-10-07T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-07T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const ORG_ENTRIES: OrgEntry[] = [
  orgEntry('housing_authority', 'Atlanta Housing Authority', ['AHA']),
  orgEntry('agency', 'Step Up'),
  orgEntry('agency', 'Hope Atlanta'),
];

const CLEAN: CaseworkerPreview = {
  contactId: 'c1',
  alreadyCaseworker: false,
  refusals: [],
  removes: { housingAuthority: 'Atlanta Housing Authority', agency: 'Hope Atlanta', pendingSuggestions: 2 },
  threads: { retype: 1, leftShared: 2, leftOther: 1 },
  organization: { value: 'Hope Atlanta', source: 'list_match' },
};

const CONVERTED: Contact = {
  contactId: 'c1',
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Dana',
  lastName: 'Reyes',
  organization: 'Hope Atlanta',
};

function renderDialog(): { onConverted: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onConverted = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <CaseworkerDialog contactId="c1" name="Dana Reyes" onConverted={onConverted} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onConverted, onClose };
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Make Dana Reyes a caseworker' });
const confirm = (): HTMLElement => screen.getByRole('button', { name: 'Make caseworker' });
const organization = (): HTMLElement => screen.getByRole('combobox', { name: 'Organization' });

async function ready(): Promise<void> {
  await within(dialog()).findByText('Past tours, closed placements, properties sent and other details stay on the record.');
  await waitFor(() => expect(confirm()).toBeEnabled());
}

beforeEach(() => {
  previewCaseworker.mockReset().mockResolvedValue(CLEAN);
  makeCaseworker.mockReset().mockResolvedValue(CONVERTED);
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: ORG_ENTRIES });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
});

describe('isCaseworkerContact (the STORED-contact test, spec D16)', () => {
  it.each([
    [{ type: 'partner', role: 'Caseworker' }, true],
    [{ type: 'partner', role: 'case worker' }, true],
    [{ type: 'partner', role: 'Case Manager' }, false],
    [{ type: 'partner' }, false],
    [{ type: 'tenant', role: 'Caseworker' }, false],
    [{ type: 'landlord', role: 'Case worker' }, false],
  ] as const)('%o -> %s', (contact, expected) => {
    expect(isCaseworkerContact(contact)).toBe(expected);
  });
});

describe('CaseworkerDialog', () => {
  it('reads the preview for this contact when it opens and says what the conversion does', async () => {
    renderDialog();
    expect(previewCaseworker).toHaveBeenCalledTimes(1);
    expect(previewCaseworker).toHaveBeenCalledWith('c1', expect.any(AbortSignal));
    // Confirm waits for the preview.
    expect(confirm()).toBeDisabled();
    await ready();
    const d = dialog();
    expect(within(d).getByText('Housing authority: Atlanta Housing Authority')).toBeInTheDocument();
    expect(within(d).getByText('Agency: Hope Atlanta')).toBeInTheDocument();
    expect(within(d).getByText('2 pending AI suggestions')).toBeInTheDocument();
    expect(within(d).getByText('1 conversation will become a partner conversation.')).toBeInTheDocument();
    expect(within(d).getByText('2 shared conversations stay as they are.')).toBeInTheDocument();
    expect(within(d).getByText('1 conversation without a type stays as it is.')).toBeInTheDocument();
    // The picker shows the preview's organization.
    expect(organization()).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Remove Hope Atlanta' })).toBeInTheDocument();
  });

  it('the plural thread sentences are plan 3.9 verbatim', async () => {
    previewCaseworker.mockResolvedValue({ ...CLEAN, threads: { retype: 2, leftShared: 3, leftOther: 2 } });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).getByText('2 conversations will become partner conversations.')).toBeInTheDocument();
    expect(within(d).getByText('3 shared conversations stay as they are.')).toBeInTheDocument();
    expect(within(d).getByText('2 conversations without a type stay as they are.')).toBeInTheDocument();
  });

  it('an existing caseworker: no Organization picker, it says Confirm re-runs the cleanup, and sends no organization (plan review R1 ruling B8)', async () => {
    const user = userEvent.setup();
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      alreadyCaseworker: true,
      organization: { value: 'Hope Atlanta', source: 'stored' },
    });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).getByText('This contact is already a caseworker. Confirming re-runs the cleanup.')).toBeInTheDocument();
    expect(within(d).queryByRole('combobox', { name: 'Organization' })).toBeNull();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', {});
  });

  it('says nothing about a count that is zero', async () => {
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      removes: { pendingSuggestions: 0 },
      threads: { retype: 3, leftShared: 0, leftOther: 0 },
      organization: { source: 'none' },
    });
    renderDialog();
    await ready();
    const d = dialog();
    expect(within(d).queryByText(/pending AI suggestion/)).toBeNull();
    expect(within(d).queryByText(/stay as they are|stays as it is/)).toBeNull();
    expect(within(d).queryByText(/^Housing authority:/)).toBeNull();
    expect(within(d).getByText('3 conversations will become partner conversations.')).toBeInTheDocument();
  });

  it('an untouched picker sends no organization - the server decides', async () => {
    const user = userEvent.setup();
    const { onConverted } = renderDialog();
    await ready();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', {});
    await waitFor(() => expect(onConverted).toHaveBeenCalledWith(CONVERTED));
  });

  it('a cleared picker sends organization ""', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Remove Hope Atlanta' }));
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: '' });
  });

  it('a pick of either kind sends that name', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Step Up' });
  });

  it('typed text naming one entry is committed by Confirm; other text stops it (R4-08)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.type(organization(), 'Nowhere Partners');
    await user.click(confirm());
    expect(makeCaseworker).not.toHaveBeenCalled();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Pick a name from the list, add it as new, or clear the text.',
    );
    await user.clear(organization());
    await user.type(organization(), 'AHA');
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Atlanta Housing Authority' });
  });

  it('every refusal in the preview shows its sentence and link, and Confirm stays disabled (R4-09)', async () => {
    previewCaseworker.mockResolvedValue({
      ...CLEAN,
      refusals: [
        { code: 'caseworker_open_placement', placementId: 'p 7' },
        { code: 'caseworker_open_tour', tourId: 't1' },
        { code: 'caseworker_landlord_of_record', unitId: 'u1' },
        { code: 'caseworker_on_roster', unitId: 'u2' },
      ],
    });
    renderDialog();
    const d = dialog();
    expect(await within(d).findByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(d).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(
      within(d).getByText(
        "This contact is the landlord of record for a property. Change that property's landlord first.",
      ),
    ).toBeInTheDocument();
    expect(
      within(d).getByText("This contact is on a property's contact list. Remove them from it first."),
    ).toBeInTheDocument();
    expect(within(d).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(d).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    expect(
      within(d).getAllByRole('link', { name: 'View property' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/listings/u1', '/listings/u2']);
    expect(confirm()).toBeDisabled();
    expect(confirm()).toHaveAccessibleDescription(/Finish or close this contact's placement first\./);
  });

  it('a refusal answered by make replaces the preview and disables Confirm', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(
      new ApiError(409, 'caseworker_on_roster', 'caseworker_on_roster', {
        error: 'caseworker_on_roster',
        refusals: [{ code: 'caseworker_on_roster', unitId: 'u2' }],
      }),
    );
    const { onConverted } = renderDialog();
    await ready();
    await user.click(confirm());
    expect(
      await within(dialog()).findByText("This contact is on a property's contact list. Remove them from it first."),
    ).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    expect(onConverted).not.toHaveBeenCalled();
  });

  it('contact_changed says so, reads the preview again and starts the picker from it', async () => {
    const user = userEvent.setup();
    makeCaseworker
      .mockRejectedValueOnce(new ApiError(409, 'contact_changed', 'contact_changed', { error: 'contact_changed' }))
      .mockResolvedValueOnce(CONVERTED);
    previewCaseworker
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce({ ...CLEAN, organization: { value: 'Step Up', source: 'stored' } });
    renderDialog();
    await ready();
    await user.click(confirm());
    expect(
      await within(dialog()).findByText('This contact changed while this was open. Review and try again.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(previewCaseworker).toHaveBeenCalledTimes(2));
    expect(await within(dialog()).findByRole('button', { name: 'Remove Step Up' })).toBeInTheDocument();
    await waitFor(() => expect(confirm()).toBeEnabled());
    // The new preview is the new baseline: untouched again, nothing is sent.
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenLastCalledWith('c1', {});
  });

  it('a 422 org_not_on_list on organization shows under the picker, never the code', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'organization',
        text: 'Step Up',
        candidates: [],
        close: [],
      }),
    );
    renderDialog();
    await ready();
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(confirm());
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent(/Step Up is not on the list/);
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
  });

  it('any other failure gets the generic line and Confirm again', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockRejectedValue(new Error('offline'));
    renderDialog();
    await ready();
    await user.click(confirm());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      "Couldn't make this contact a caseworker - please try again.",
    );
    expect(confirm()).toBeEnabled();
  });

  it('a failed preview read says so; Try again reads it again', async () => {
    const user = userEvent.setup();
    previewCaseworker.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(CLEAN);
    renderDialog();
    expect(await within(dialog()).findByText("Couldn't check this contact - please try again.")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(previewCaseworker).toHaveBeenCalledTimes(2);
  });

  it('"Add <text> as a new organization" asks for the kind; the added name fills the picker (R2-F3)', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('agency', 'Metro Partners'));
    renderDialog();
    await ready();
    await user.type(organization(), 'Metro Partners');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Partners as a new organization' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    const yes = within(isNew).getByRole('button', { name: 'Yes, add it' });
    expect(yes).toBeDisabled(); // no default kind
    await user.click(within(isNew).getByRole('radio', { name: 'Agency' }));
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(addOrg).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agency', name: 'Metro Partners' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument(),
    );
    expect(within(dialog()).getByRole('button', { name: 'Remove Metro Partners' })).toBeInTheDocument();
    await user.click(confirm());
    expect(makeCaseworker).toHaveBeenCalledWith('c1', { organization: 'Metro Partners' });
  });

  it('Cancel closes without a write', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(makeCaseworker).not.toHaveBeenCalled();
  });
});
```

Note on the add test: it exercises S7's NewOrgDialog with
`kind="organization"` (C1): the "Kind" radio group (OrgKindChoice) with radios
"Housing authority" / "Agency", no default, "Yes, add it" disabled until one
is chosen, `addOrg({ kind, name })`. If S7's dialog also
sends `notes` or checks before enabling, keep the assertion on
`{ kind: 'agency', name: 'Metro Partners' }` via `expect.objectContaining`.

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/CaseworkerDialog.test.tsx` -
fails to load: `Failed to resolve import "./CaseworkerDialog.js"`.

GREEN (a) - create `dashboard/src/routes/contact/CaseworkerDialog.module.css`:

```css
/* CaseworkerDialog - the caseworker conversion's confirm dialog. Tokens only. */

.body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.lead {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.list {
  margin: 0;
  padding-left: var(--sp-5);
  font-size: var(--fs-sm);
  color: var(--c-text);
}

.refusals {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  list-style: none;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

.note {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}

.error {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

.failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
```

GREEN (b) - create `dashboard/src/routes/contact/CaseworkerDialog.tsx`:

```tsx
// CaseworkerDialog - the caseworker conversion's ONE confirm dialog (spec
// 2026-10-06 D16, D19, D22; plan 3.9). Every entry point opens it: the contact
// header's More actions > "Make caseworker", the Unknown card's "Mark as
// Caseworker" and a Possible caseworkers row. Its host mounts it ONLY while it
// is open, so the read-only preview (GET .../caseworker-review/preview) is read
// only when it opens - nothing loads at the contact page's mount (ruling
// R4-13). It shows what the conversion removes and keeps, every refusal with a
// link to the record to resolve first (Confirm stays disabled while one shows;
// the server re-checks anyway), and an Organization picker over BOTH lists.
// Confirm sends `organization` ONLY when staff changed the picker, so an
// untouched carried value never meets D5. Server codes map to this file's copy
// - ApiError.message is the raw code and is never rendered (A's convention).
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  makeCaseworker,
  previewCaseworker,
  type CaseworkerPreview,
  type CaseworkerRefusal,
  type Contact,
  type OrgRef,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import { OrgPicker, type OrgPickerHandle } from '../orgs/OrgPicker.js';
import {
  ORGANIZATION_KINDS,
  notOnListMessage,
  orgListLoadError,
  orgListUnknown,
  orgNotOnListBody,
  refusesSave,
} from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { useTypedOrgText } from '../orgs/useTypedOrgText.js';
import { Modal } from './Modal.js';
import styles from './CaseworkerDialog.module.css';

// isCaseworkerContact is NOT here: it lives in ./caseworkerRole.ts (assembly
// ruling S8-7), so a page that only needs the predicate never imports the dialog.

export const ALREADY_CASEWORKER = 'This contact is already a caseworker. Confirming re-runs the cleanup.';
export const CASEWORKER_STAYS =
  'Past tours, closed placements, properties sent and other details stay on the record.';
export const CONTACT_CHANGED_COPY = 'This contact changed while this was open. Review and try again.';
export const MAKE_CASEWORKER_FAILED = "Couldn't make this contact a caseworker - please try again.";
export const PREVIEW_FAILED = "Couldn't check this contact - please try again.";

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

function isRefusal(value: unknown): value is CaseworkerRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['code']) {
    case 'caseworker_open_placement':
      return typeof v['placementId'] === 'string';
    case 'caseworker_open_tour':
      return typeof v['tourId'] === 'string';
    case 'caseworker_landlord_of_record':
    case 'caseworker_on_roster':
      return typeof v['unitId'] === 'string';
    default:
      return false;
  }
}

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'caseworker_open_placement',
  'caseworker_open_tour',
  'caseworker_landlord_of_record',
  'caseworker_on_roster',
]);

/** The refusals a 409 `make` carries (plan 3.5: the first refusal's code plus
 *  `refusals`), or null for any other failure. */
function refusalsFrom(err: unknown): CaseworkerRefusal[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !REFUSAL_CODES.has(err.code)) return null;
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>) : {};
  const list = Array.isArray(body['refusals']) ? body['refusals'].filter(isRefusal) : [];
  return list.length > 0 ? list : null;
}

function removedLines(preview: CaseworkerPreview): string[] {
  const lines: string[] = [];
  if (preview.removes.housingAuthority !== undefined && preview.removes.housingAuthority !== '') {
    lines.push(`Housing authority: ${preview.removes.housingAuthority}`);
  }
  if (preview.removes.agency !== undefined && preview.removes.agency !== '') {
    lines.push(`Agency: ${preview.removes.agency}`);
  }
  const n = preview.removes.pendingSuggestions;
  if (n > 0) lines.push(n === 1 ? '1 pending AI suggestion' : `${n} pending AI suggestions`);
  return lines;
}

function threadLines(preview: CaseworkerPreview): string[] {
  const { retype, leftShared, leftOther } = preview.threads;
  const lines: string[] = [];
  if (retype > 0) {
    lines.push(
      retype === 1
        ? '1 conversation will become a partner conversation.'
        : `${retype} conversations will become partner conversations.`,
    );
  }
  if (leftShared > 0) {
    lines.push(
      leftShared === 1
        ? '1 shared conversation stays as it is.'
        : `${leftShared} shared conversations stay as they are.`,
    );
  }
  if (leftOther > 0) {
    // Type-less rows only (plan 3.2, R1-F15) - plan 3.9 verbatim.
    lines.push(
      leftOther === 1
        ? '1 conversation without a type stays as it is.'
        : `${leftOther} conversations without a type stay as they are.`,
    );
  }
  return lines;
}

export interface CaseworkerDialogProps {
  contactId: string;
  /** The contact's display name: the dialog is "Make <name> a caseworker". */
  name: string;
  /** The converted contact the server answered with ({ contact }). */
  onConverted: (contact: Contact) => void;
  onClose: () => void;
}

/** One preview read's outcome, tagged with the attempt it answers. */
type Loaded = { attempt: number; preview: CaseworkerPreview } | { attempt: number; failed: true };

export function CaseworkerDialog({ contactId, name, onConverted, onClose }: CaseworkerDialogProps): React.JSX.Element {
  const refusalsId = useId();
  // The two lists behind the Organization picker (spec D17: either kind).
  const orgList = useOrgList();
  const organizationPicker = useRef<OrgPickerHandle>(null);
  const organizationText = useTypedOrgText(orgList, ORGANIZATION_KINDS, organizationPicker);
  // `attempt` re-reads the preview (Try again, contact_changed).
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // What the picker started from (the preview's organization) and what it
  // holds now: `organization` is sent only when the two differ.
  const [baseline, setBaseline] = useState('');
  const [organization, setOrganization] = useState('');
  // Refusals a `make` answered with - they replace the preview's.
  const [serverRefusals, setServerRefusals] = useState<CaseworkerRefusal[] | null>(null);
  // "Is this really new?" (organization mode), opened by the picker's add option.
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    previewCaseworker(contactId, controller.signal).then(
      (preview) => {
        if (controller.signal.aborted) return;
        const start = preview.organization.value ?? '';
        setBaseline(start);
        setOrganization(start);
        setServerRefusals(null);
        setLoaded({ attempt, preview });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ attempt, failed: true });
      },
    );
    return () => controller.abort();
  }, [contactId, attempt]);

  // A read for an earlier attempt is never shown as this one's.
  const current = loaded !== null && loaded.attempt === attempt ? loaded : null;
  const preview = current !== null && 'preview' in current ? current.preview : null;
  const failed = current !== null && 'failed' in current;
  const refusals = serverRefusals ?? preview?.refusals ?? [];
  const canConfirm = preview !== null && refusals.length === 0 && !busy;

  // Not `use*`: the React Compiler lint would read that name as a hook.
  function applyOrg(ref: OrgRef): void {
    // The server's own answer counts as on the list at once (A's noteAdded).
    orgList.noteAdded(ref);
    setOrganization(ref.name);
    setOrgError(null);
    setAdding(null);
  }

  async function onConfirm(): Promise<void> {
    if (!canConfirm) return;
    // An existing caseworker (B8): the picker is hidden and the server ignores
    // a request organization, so nothing is settled and none is sent.
    const already = preview !== null && preview.alreadyCaseworker;
    // Typed text is never dropped silently (R4-08): text naming one entry is
    // committed as a pick would be; any other text stops Confirm and says why.
    const typed = already ? null : organizationText.settle();
    if (typed !== null && refusesSave(typed)) {
      organizationText.focus();
      return;
    }
    let next = organization;
    if (typed !== null && typed.status === 'resolved') {
      next = typed.name;
      setOrganization(typed.name);
    }
    setBusy(true);
    setError(null);
    setOrgError(null);
    try {
      const contact = await makeCaseworker(contactId, !already && next !== baseline ? { organization: next } : {});
      onConverted(contact);
    } catch (err) {
      const refused = refusalsFrom(err);
      const notOnList = orgNotOnListBody(err);
      if (refused !== null) {
        setServerRefusals(refused);
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'contact_changed') {
        setError(CONTACT_CHANGED_COPY);
        organizationPicker.current?.clearText();
        setAttempt((n) => n + 1);
      } else if (notOnList !== null && notOnList.field === 'organization') {
        setOrgError(notOnListMessage(notOnList));
      } else {
        setError(MAKE_CASEWORKER_FAILED);
      }
      setBusy(false);
    }
  }

  const removed = preview !== null ? removedLines(preview) : [];

  return (
    <>
      <Modal
        title={`Make ${name} a caseworker`}
        onClose={busy ? () => {} : onClose}
        footer={
          <>
            <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={!canConfirm}
              aria-describedby={refusals.length > 0 ? refusalsId : undefined}
              onClick={() => void onConfirm()}
            >
              Make caseworker
            </Button>
          </>
        }
      >
        {failed ? (
          <div className={styles.failed}>
            <p className={styles.error} role="alert">
              {PREVIEW_FAILED}
            </p>
            <Button variant="secondary" size="sm" type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : preview === null ? (
          <Spinner center />
        ) : (
          <div className={styles.body}>
            {refusals.length > 0 ? (
              <ul className={styles.refusals} id={refusalsId}>
                {refusals.map((refusal, index) => {
                  const copy = refusalCopy(refusal);
                  return (
                    <li key={`${refusal.code}-${index}`}>
                      {copy.sentence} <Link to={copy.to}>{copy.linkText}</Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {removed.length > 0 ? (
              <>
                <p className={styles.lead}>This removes</p>
                <ul className={styles.list}>
                  {removed.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {threadLines(preview).map((line) => (
              <p key={line} className={styles.note}>
                {line}
              </p>
            ))}
            <p className={styles.note}>{CASEWORKER_STAYS}</p>
            {preview.alreadyCaseworker ? (
              <p className={styles.note}>{ALREADY_CASEWORKER}</p>
            ) : (
            <OrgPicker
              ref={organizationPicker}
              label="Organization"
              kinds={ORGANIZATION_KINDS}
              entries={orgList.entries}
              loading={orgListUnknown(orgList)}
              disabled={organizationText.disabled || busy}
              value={organization}
              onChange={(next) => {
                setOrganization(next);
                setOrgError(null);
              }}
              onPendingTextChange={organizationText.onPendingTextChange}
              pendingNote={organizationText.note}
              onRequestAdd={(text) => setAdding(text)}
              error={
                organizationText.refusal ??
                orgError ??
                (orgList.error ? orgListLoadError(ORGANIZATION_KINDS) : null)
              }
              errorAttempt={organizationText.refusalAttempt}
            />
            )}
          </div>
        )}
        {error !== null ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </Modal>
      {/* Stacked on top (Modal's mountedDialogs stack gives it Escape); the
          host never renders this dialog inside a <form>. */}
      {adding !== null ? (
        <NewOrgDialog
          kind="organization"
          mode="field"
          text={adding}
          onUse={(ref) => applyOrg(ref)}
          onAdded={(entry) => applyOrg(entry)}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  );
}
```

GREEN (c) - `dashboard/src/routes/contact/caseworkerRole.ts` (S1's module),
append at the end:

```ts

/**
 * "A caseworker", everywhere in this design (spec D16): a partner whose role
 * satisfies isCaseworkerRole. Hosts pass the STORED contact (ruling R4-15).
 * Structurally typed, so this module keeps its import rule (the D4
 * normalizer only); a dashboard `Contact` satisfies it. Every importer
 * imports it from HERE (assembly ruling S8-7), never from CaseworkerDialog.
 */
export function isCaseworkerContact(contact: { type?: unknown; role?: unknown }): boolean {
  return contact.type === 'partner' && isCaseworkerRole(contact.role);
}
```

Notes for the builder:
- In GREEN (b) the `<OrgPicker ... />` element sits in the second branch of
  the `preview.alreadyCaseworker ? ( ... ) : ( ... )` ternary; its props are
  as written - re-indent the element two spaces when you write the file.
- `onClose={busy ? () => {} : onClose}` is NewOrgDialog's precedent
  (`NewOrgDialog.tsx:184`): a close while `make` is in flight is ignored.
- The preview effect sets state only inside the promise callbacks (never
  synchronously in the effect body), so `react-hooks/set-state-in-effect`
  stays quiet.
- If `toHaveAccessibleDescription` is not available in this repo's
  jest-dom version, assert
  `expect(confirm().getAttribute('aria-describedby')).toBeTruthy()` and that
  the element with that id contains the placement sentence.

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/CaseworkerDialog.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/caseworkerRoleMirror.test.ts` - still green.
- `cd "W:/tmp/caseworkers"; npm run typecheck` is above; then
  `cd "W:/tmp/caseworkers"; npx eslint dashboard/src/routes/contact/CaseworkerDialog.tsx dashboard/src/routes/contact/CaseworkerDialog.test.tsx dashboard/src/routes/contact/caseworkerRole.ts` - no errors.
- `cd "W:/tmp/caseworkers"; git grep -n "isCaseworkerContact" -- dashboard/src` - the definition is in
  `caseworkerRole.ts` only (no `export function isCaseworkerContact` in `CaseworkerDialog.tsx`).

Commit `feat(dashboard): the caseworker conversion dialog`
(stage `dashboard/src/routes/contact/CaseworkerDialog.tsx`,
`dashboard/src/routes/contact/CaseworkerDialog.test.tsx`,
`dashboard/src/routes/contact/CaseworkerDialog.module.css`,
`dashboard/src/routes/contact/caseworkerRole.ts`).

### Task 8.4 - ContactCreateForm offers Caseworker (a new contact)

Files: `dashboard/src/routes/contact/ContactCreateForm.tsx`,
`dashboard/src/routes/contact/ContactCreateForm.test.tsx`.

Existing tests this task changes: none (the Tenant / Other / Property Manager
cases are PINs; the Other case's `'Case worker'` example stays legal, ruling
R4-17).

RED - append at the end of `dashboard/src/routes/contact/ContactCreateForm.test.tsx`:

```tsx
describe('ContactCreateForm - Caseworker (spec 2026-10-06 D16)', () => {
  it('offers Caseworker on a new contact and saves partner + Caseworker, with no organization field', async () => {
    const user = userEvent.setup();
    createContact.mockResolvedValue({ contactId: 'new-cw', type: 'partner', role: 'Caseworker', firstName: 'Ana' });
    setup();
    const kinds = screen.getByRole('group', { name: 'Contact kind' });
    await user.click(within(kinds).getByRole('button', { name: 'Caseworker' }));
    // D16: the create form never offers Organization (staff set it on the partner page).
    expect(screen.queryByRole('combobox', { name: 'Organization' })).toBeNull();
    await user.type(screen.getByLabelText(/First name/i), 'Ana');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({ type: 'partner', role: 'Caseworker', firstName: 'Ana' }),
    );
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactCreateForm.test.tsx` -
the new case fails: no "Caseworker" button in the "Contact kind" group.

GREEN - `dashboard/src/routes/contact/ContactCreateForm.tsx`. Current (`:258`):

```tsx
        <KindPicker value={kind} onChange={setKind} roleSuggestions={vocab.roles} />
```

Replace with:

```tsx
        {/* A NEW contact may be created as a Caseworker (spec 2026-10-06 D16):
            partner + CASEWORKER_ROLE, no organization here. */}
        <KindPicker value={kind} onChange={setKind} roleSuggestions={vocab.roles} offerCaseworker />
```

The body needs no change: line 136-139 already sends `{ type, role }` for a
resolved kind with a non-empty role, and the partner type has no type-specific
fields here.

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactCreateForm.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): a new contact can be created as a Caseworker`
(stage `dashboard/src/routes/contact/ContactCreateForm.tsx`,
`dashboard/src/routes/contact/ContactCreateForm.test.tsx`).

### Task 8.5 - ContactEditForm: the Caseworker offer gate, the 409 copy, the partner Organization picker

Files: `dashboard/src/routes/contact/ContactEditForm.tsx`,
`dashboard/src/routes/contact/ContactEditForm.test.tsx`.

Existing tests this task changes: none. PINs that must stay green: "surfaces
a save failure and stays open" (`:204-212`, the generic line for a non-409
failure), "giving the contact a role via Change type -> Other" (`:214-231`,
the `'Case worker'` example on a tenant base stays legal - ruling R4-17), every
tenant org-picker case (`:574-760`, `:763-1158` - the tenant pickers and their
422 routing are unchanged).

Rules (spec D16, D17; rulings R2-F8, R4-07, R4-11, R4-15):
- KindPicker offers Caseworker only when the STORED contact is a caseworker
  (`isCaseworkerContact(contact)`), never from the live kind.
- A partner (live kind) gets ONE "Organization" picker over BOTH lists. Its
  answer is written to `organization` by FIELD - through S7's field-keyed
  `applyOrg('organization', ref)`, never by the entry's KIND (HEAD's
  `ContactEditForm.tsx:210-214` routed by kind and would put an agency pick
  into `agency`).
- `organization` is compared exactly and sent only when changed (`''` clears).
- 409 `caseworker_use_conversion` gets its own sentence (plan 3.9).

RED - append at the end of `dashboard/src/routes/contact/ContactEditForm.test.tsx`:

```tsx
describe('ContactEditForm - caseworkers and the partner organization (spec 2026-10-06 D16, D17)', () => {
  const PARTNER: Contact = {
    contactId: 'p1',
    type: 'partner',
    status: 'active',
    firstName: 'Renee',
    lastName: 'Carter',
    phone: '+14045550123',
  };
  const CASEWORKER: Contact = { ...PARTNER, contactId: 'cw1', role: 'Caseworker', organization: 'Hope Atlanta' };
  const organization = (): HTMLElement => screen.getByRole('combobox', { name: 'Organization' });
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [...ORG_ENTRIES, orgEntry('agency', 'Hope Atlanta')] });
  });

  it('offers Caseworker in Change type only when the STORED contact is a caseworker (R4-15)', async () => {
    const user = userEvent.setup();
    for (const plain of [PARTNER, TENANT, LANDLORD]) {
      const { unmount } = render(<ContactEditForm contact={plain} onClose={vi.fn()} onSaved={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: /Change type/i }));
      expect(screen.queryByRole('button', { name: 'Caseworker' })).toBeNull();
      unmount();
    }
    render(<ContactEditForm contact={CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Caseworker - Partner')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    expect(screen.getByRole('button', { name: 'Caseworker' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a 409 caseworker_use_conversion points to the conversion, not a retry (R4-11)', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      new ApiError(409, 'caseworker_use_conversion', 'caseworker_use_conversion', {
        error: 'caseworker_use_conversion',
      }),
    );
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('To make this contact a caseworker, use More actions > Make caseworker.');
    expect(alert.textContent ?? '').not.toContain('caseworker_use_conversion');
  });

  it('a partner gets one Organization picker over both lists; a tenant does not', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Organization' })).toBeNull();
    unmount();
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Housing authority' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Agency' })).toBeNull();
    await user.type(organization(), 'atl');
    expect(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ })).toBeInTheDocument();
    await user.clear(organization());
    await user.type(organization(), 'step');
    expect(await screen.findByRole('option', { name: /^Step Up/ })).toBeInTheDocument();
  });

  it('a pick goes to organization by FIELD - a housing authority name never lands in housingAuthority (R2-F8)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Atlanta Housing Authority' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'atl');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Atlanta Housing Authority' });
  });

  it('removing the chip clears organization as an empty string', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...CASEWORKER, organization: undefined });
    render(<ContactEditForm contact={CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove Hope Atlanta' }));
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('cw1', { organization: '' });
  });

  it('an untouched organization never reaches the wire, even when it is not on the list', async () => {
    const user = userEvent.setup();
    const carried: Contact = { ...CASEWORKER, organization: 'Hope Atlanta Inc' };
    updateContact.mockResolvedValue({ ...carried, firstName: 'ReneeX' });
    render(<ContactEditForm contact={carried} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('Not on the list')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    expect(updateContact.mock.calls[0]?.[1]).toStrictEqual({ firstName: 'ReneeX' });
  });

  it('typed text naming one entry is saved as a pick would be; other text stops Save', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Step Up' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'Nowhere Partners');
    await user.click(save());
    expect(updateContact).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pick a name from the list, add it as new, or clear the text.',
    );
    await user.clear(organization());
    await user.type(organization(), 'Step Up');
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Step Up' });
  });

  it('"Add <text> as a new organization" opens the organization-mode dialog outside the form; the added name fills the field', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('agency', 'Metro Partners'));
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Metro Partners' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'Metro Partners');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Partners as a new organization' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    expect(dialog.closest('form')).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Agency' }));
    const yes = within(dialog).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(addOrg).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agency', name: 'Metro Partners' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument(),
    );
    // Written to organization, NOT to agency, although the entry is an agency.
    expect(updateContact).not.toHaveBeenCalled();
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Metro Partners' });
  });

  it('a refused save (422 org_not_on_list) on organization shows under its picker', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'organization',
        text: 'Step Up',
        candidates: [],
        close: [],
      }),
    );
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Step Up is not on the list/);
    // Changing the field clears it.
    await user.click(screen.getByRole('button', { name: 'Remove Step Up' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactEditForm.test.tsx` -
the new describe fails: no "Caseworker" segment for the stored caseworker, no
"Organization" combobox, and the 409 reads "Couldn't save - please try again.".
Every pre-existing case passes.

GREEN - `dashboard/src/routes/contact/ContactEditForm.tsx`.

Base: this task runs AFTER S7, which made the form FIELD-keyed (planner
ruling, see assembly ruling S5/S7-2): `adding` is `{ field: OrgFormField; text }`,
an `orgSetters` map holds the tenant arms (`housingAuthority`, `agency`),
`applyOrg(field, ref)` writes `orgSetters[field](ref.name)` and clears the
refused-save message, and the one `NewOrgDialog` after the `</form>` opens
with `kind={newOrgDialogKind(adding.field)}`. READ the file first: the anchors
(a)-(d), (f)-(i) and (k)-(m) below are HEAD lines S7 does not touch; steps (e),
(j) and (n) name S7's shapes and say what S8 adds to them - match S7's text as
it stands, not HEAD's.

(a) Current (`:11-12`):

```tsx
import {
  TENANT_STATUSES,
```

Replace with:

```tsx
import {
  ApiError,
  TENANT_STATUSES,
```

(b) Current (`:73`):

```tsx
import { KindPicker, type KindPickerValue } from './KindPicker.js';
```

Replace with:

```tsx
import { KindPicker, type KindPickerValue } from './KindPicker.js';
import { isCaseworkerContact } from './caseworkerRole.js';
```

(c) In the `from '../orgs/orgCopy.js'` import list (S7 may have reshaped it),
add `ORGANIZATION_KINDS` (and `isOrgFormField` if S7 did not already import it
for step (j)), keeping the list alphabetical as S7 left it.

(d) Current (`:97`):

```tsx
export interface ContactEditFormProps {
```

Replace with:

```tsx
/** The PATCH refuses a save whose result would make this contact a caseworker
 *  (409 caseworker_use_conversion, spec D16): the conversion is the only way.
 *  Reachable only from a stale form - the offer gate below hides the choice. */
export const CASEWORKER_USE_CONVERSION = 'To make this contact a caseworker, use More actions > Make caseworker.';

export interface ContactEditFormProps {
```

(e) S7's refused-save state. If S7 typed `orgFieldError`'s `field` as the
tenant pair (`'housingAuthority' | 'agency'`), widen it to `OrgFormField`
(import the type from `orgCopy.js`); if it is already `OrgFormField`, no
change. No second "adding" state: the organization add goes through S7's
field-keyed `adding`.

(f) Current (`:155`):

```tsx
  const agencyText = useTypedOrgText(orgList, AGENCY_KINDS, agencyPicker);
```

(if S7 replaced `AGENCY_KINDS` here with `kindsForField('agency')`, anchor on
S7's line instead.) Replace with that line plus:

```tsx
  const organizationPicker = useRef<OrgPickerHandle>(null);
  const organizationText = useTypedOrgText(orgList, ORGANIZATION_KINDS, organizationPicker);
```

(g) Current (`:166`):

```tsx
  const isTenant = kind.type === 'tenant';
```

Replace with:

```tsx
  const isTenant = kind.type === 'tenant';
  // Partners (caseworkers included) edit their organization (spec D17).
  const isPartner = kind.type === 'partner';
```

(h) Current (`:206`):

```tsx
  const [agency, setAgency] = useState(str(contact.agency));
```

Replace with:

```tsx
  const [agency, setAgency] = useState(str(contact.agency));
  // A partner's organization (spec D17) - one list name of either kind.
  const [organization, setOrganization] = useState(str(contact.organization));
```

Then add the organization arm to S7's `orgSetters` map (declared below these
states), so `applyOrg('organization', ref)` writes `organization` - by FIELD,
whatever the entry's kind (ruling R2-F8):

```tsx
    organization: setOrganization,
```

If S7 typed the map narrower than `Record<OrgFormField, (name: string) => void>`,
widen it to that type now that every arm exists.

(i) Current (`:272`):

```tsx
  function buildPatch(org: { housingAuthority: string; agency: string }): ContactPatch | { error: string } {
```

Replace with:

```tsx
  function buildPatch(org: {
    housingAuthority: string;
    agency: string;
    organization: string;
  }): ContactPatch | { error: string } {
```

Current (`:380-382`):

```tsx
        patch.address = { line1, line2, city, state: stateField, zip };
      }
    }
```

Replace with:

```tsx
        patch.address = { line1, line2, city, state: stateField, zip };
      }
    }
    // A partner's organization (spec D17): changed only by a pick, a removed
    // chip ('' - the server REMOVEs it) or committed typed text, so the
    // comparison is exact and an untouched value - on the list or not - never
    // reaches the wire (D5).
    if (isPartner && org.organization !== str(contact.organization)) {
      patch.organization = org.organization;
    }
```

(j) The save's catch. Current (`:466-468`, unique):

```tsx
      } else {
        setError("Couldn't save - please try again.");
      }
```

Replace with:

```tsx
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'caseworker_use_conversion') {
        // A save never makes a contact a caseworker (spec D16) - say where to go.
        setError(CASEWORKER_USE_CONVERSION);
      } else {
        setError("Couldn't save - please try again.");
      }
```

And the 422 branch just above it: if S7 kept HEAD's condition
`refused.field === 'housingAuthority' || refused.field === 'agency'`, replace
that condition with `isOrgFormField(refused.field)` so an `organization`
refusal lands under its picker; if S7 already routes by `isOrgFormField`, no
change.

(k) In `settleTypedText`, current (`:396-398`):

```tsx
  function settleTypedText(): { housingAuthority: string; agency: string } | null {
    const org = { housingAuthority, agency };
    if (!isTenant) return org;
```

Replace with:

```tsx
  function settleTypedText(): { housingAuthority: string; agency: string; organization: string } | null {
    const org = { housingAuthority, agency, organization };
    if (isPartner) {
      // The partner's one picker, settled by the same rule (R4-07).
      const og = organizationText.settle();
      if (og.status === 'resolved') {
        org.organization = og.name;
        setOrganization(og.name);
        setOrgFieldError(null);
      }
      if (refusesSave(og)) {
        organizationText.focus();
        return null;
      }
      return org;
    }
    if (!isTenant) return org;
```

(l) Current (`:531`):

```tsx
            <KindPicker value={kind} onChange={handleKindChange} roleSuggestions={vocab.roles} />
```

Replace with:

```tsx
            {/* Caseworker is offered only when the STORED contact already is
                one (spec D16, ruling R4-15): an existing contact becomes a
                caseworker through More actions > Make caseworker. */}
            <KindPicker
              value={kind}
              onChange={handleKindChange}
              roleSuggestions={vocab.roles}
              offerCaseworker={isCaseworkerContact(contact)}
            />
```

(m) Current (`:641-646`, the end of the tenant pickers block):

```tsx
              errorAttempt={agencyText.refusalAttempt}
              className={styles.field}
              labelClassName={styles.label}
            />
          </>
        ) : null}
```

Replace with:

```tsx
              errorAttempt={agencyText.refusalAttempt}
              className={styles.field}
              labelClassName={styles.label}
            />
          </>
        ) : null}

        {/* A partner's organization (spec 2026-10-06 D17): ONE picker over
            BOTH lists. Its answer is written to `organization` by FIELD,
            whatever the entry's kind (ruling R2-F8); its add step opens the
            form's one "Is this really new?" in organization mode. */}
        {isPartner ? (
          <OrgPicker
            ref={organizationPicker}
            label="Organization"
            kinds={ORGANIZATION_KINDS}
            entries={orgList.entries}
            loading={orgListUnknown(orgList)}
            disabled={organizationText.disabled}
            value={organization}
            onChange={(next) => {
              setOrganization(next);
              setOrgFieldError(null);
            }}
            onPendingTextChange={organizationText.onPendingTextChange}
            pendingNote={organizationText.note}
            onRequestAdd={(text) => setAdding({ field: 'organization', text })}
            error={
              organizationText.refusal ??
              (orgFieldError?.field === 'organization' ? orgFieldError.message : null) ??
              (orgList.error ? orgListLoadError(ORGANIZATION_KINDS) : null)
            }
            errorAttempt={organizationText.refusalAttempt}
            className={styles.field}
            labelClassName={styles.label}
          />
        ) : null}
```

(If S7 replaced the agency picker's tail, anchor on S7's last lines of the
tenant pickers block; the inserted block goes right after it.)

(n) S7's one `NewOrgDialog` render needs no new instance: with
`adding.field === 'organization'`, `newOrgDialogKind('organization')` answers
`'organization'` (organization mode: the "Kind" radio group, no default) and
its `onUse` / `onAdded` call `applyOrg(adding.field, ref)`, which now has the
organization arm (step (h)). Verify S7's render passes
`kind={newOrgDialogKind(adding.field)}` and routes `onUse` / `onAdded` through
`applyOrg(adding.field, ...)`; if it hard-codes the tenant arms, make it so.
`onUseOtherField` never fires for organization (the field has no other kind).

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactEditForm.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): edit form - Caseworker offer gate, conversion copy, partner Organization picker`
(stage `dashboard/src/routes/contact/ContactEditForm.tsx`,
`dashboard/src/routes/contact/ContactEditForm.test.tsx`).

### Task 8.6 - UnknownFile: "Mark as Caseworker", fourth, opens the dialog

Files: `dashboard/src/routes/contact/UnknownFile.tsx`,
`dashboard/src/routes/contact/UnknownFile.test.tsx`.

Existing tests this task changes (`UnknownFile.test.tsx`): "renders four
actions in KindPicker order and reports canonical kinds" (`:91-104`, the label
array becomes five) and "disables all four actions during one in-flight
classification" (`:105-110`, five names).

RED - `dashboard/src/routes/contact/UnknownFile.test.tsx`.

(a) Current (`:32-35`):

```tsx
  onTriage?: (kind: SuggestedContactKind) => void;
  triaging?: boolean;
  media?: CommsMediaItem[];
} = {}): void {
```

Replace with:

```tsx
  onTriage?: (kind: SuggestedContactKind) => void;
  onMakeCaseworker?: () => void;
  triaging?: boolean;
  media?: CommsMediaItem[];
} = {}): void {
```

(b) Current (`:46-47`):

```tsx
          onTriage={opts.onTriage ?? vi.fn()}
          triaging={opts.triaging}
```

Replace with:

```tsx
          onTriage={opts.onTriage ?? vi.fn()}
          onMakeCaseworker={opts.onMakeCaseworker ?? vi.fn()}
          triaging={opts.triaging}
```

(c) Current (`:91-98`):

```tsx
  it('renders four actions in KindPicker order and reports canonical kinds', async () => {
    const onTriage = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage });
    const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.startsWith('Mark as '));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Property Manager',
    ]);
```

Replace with:

```tsx
  it('renders five actions in KindPicker order and reports canonical kinds', async () => {
    const onTriage = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage });
    const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.startsWith('Mark as '));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Caseworker', 'Mark as Property Manager',
    ]);
```

(d) Current (`:105-107`):

```tsx
  it('disables all four actions during one in-flight classification', () => {
    renderIt({ triaging: true });
    for (const name of ['Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Property Manager']) {
```

Replace with:

```tsx
  it('disables all five actions during one in-flight classification', () => {
    renderIt({ triaging: true });
    for (const name of [
      'Mark as Tenant',
      'Mark as Landlord',
      'Mark as Partner',
      'Mark as Caseworker',
      'Mark as Property Manager',
    ]) {
```

(e) Append at the end of the file:

```tsx
describe('UnknownFile - Mark as Caseworker (spec 2026-10-06 D16)', () => {
  it('opens the conversion, never the triage PATCH', async () => {
    const onTriage = vi.fn();
    const onMakeCaseworker = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage, onMakeCaseworker });
    await user.click(screen.getByRole('button', { name: 'Mark as Caseworker' }));
    expect(onMakeCaseworker).toHaveBeenCalledTimes(1);
    expect(onTriage).not.toHaveBeenCalled();
  });

  it('the card says Caseworker is one of the kinds', () => {
    renderIt();
    expect(screen.getByText(/Tenant, Landlord, Partner, Caseworker, or Property Manager/)).toBeInTheDocument();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/UnknownFile.test.tsx` -
the order test sees four labels, the disable loop and the new cases find no
"Mark as Caseworker", the lede still lists four kinds.

GREEN - `dashboard/src/routes/contact/UnknownFile.tsx`.

(a) Current (`:50-53`):

```tsx
  /** Triage this untriaged contact to a known kind. In flight,
   *  `triaging` disables the buttons. */
  onTriage?: (kind: SuggestedContactKind) => void;
  triaging?: boolean;
```

Replace with:

```tsx
  /** Triage this untriaged contact to a known kind. In flight,
   *  `triaging` disables the buttons. */
  onTriage?: (kind: SuggestedContactKind) => void;
  /** "Mark as Caseworker" (spec 2026-10-06 D16): opens the caseworker
   *  conversion dialog - the one-click way to accept the AI's `partner`
   *  suggestion as a caseworker. Never the triage PATCH. Absent: disabled. */
  onMakeCaseworker?: () => void;
  triaging?: boolean;
```

(b) Current (`:72-73`):

```tsx
  onTriage,
  triaging = false,
```

Replace with:

```tsx
  onTriage,
  onMakeCaseworker,
  triaging = false,
```

(c) Current (`:88-90`):

```tsx
          This contact hasn&apos;t been classified yet. Classify them as a Tenant,
          Landlord, Partner, or Property Manager to file them correctly and unlock the
          matching workspace.
```

Replace with:

```tsx
          This contact hasn&apos;t been classified yet. Classify them as a Tenant,
          Landlord, Partner, Caseworker, or Property Manager to file them correctly and
          unlock the matching workspace.
```

(d) Current (`:118-122`):

```tsx
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('partner')}
          >
            Mark as Partner
          </Button>
```

Replace with:

```tsx
            disabled={triaging || !onTriage}
            onClick={() => onTriage?.('partner')}
          >
            Mark as Partner
          </Button>
          {/* Fourth, after Partner (spec D22): the KindPicker order. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={triaging || !onMakeCaseworker}
            onClick={() => onMakeCaseworker?.()}
          >
            Mark as Caseworker
          </Button>
```

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/UnknownFile.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): Unknown card - Mark as Caseworker opens the conversion`
(stage `dashboard/src/routes/contact/UnknownFile.tsx`,
`dashboard/src/routes/contact/UnknownFile.test.tsx`).

### Task 8.7 - ContactActionsMenu: the "Make caseworker" menuitem

Files: `dashboard/src/routes/contact/ContactActionsMenu.tsx`,
`dashboard/src/routes/contact/ContactActionsMenu.test.tsx`.

Existing tests this task changes: the `setup()` helper only (one optional
prop passed through). Every existing case is a PIN.

RED - `dashboard/src/routes/contact/ContactActionsMenu.test.tsx`.

(a) Current (`:32`):

```tsx
      {...(props.unreadBusy !== undefined && { unreadBusy: props.unreadBusy })}
```

Replace with:

```tsx
      {...(props.unreadBusy !== undefined && { unreadBusy: props.unreadBusy })}
      {...(props.onMakeCaseworker !== undefined && { onMakeCaseworker: props.onMakeCaseworker })}
```

(b) Append at the end of the file:

```tsx
describe('ContactActionsMenu - Make caseworker (spec 2026-10-06 D16, D22)', () => {
  it('offers no Make caseworker item unless the parent passes the handler', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: 'Make caseworker' })).toBeNull();
  });

  it('Make caseworker fires the handler and closes the menu', async () => {
    const user = userEvent.setup();
    const onMakeCaseworker = vi.fn();
    setup({ onMakeCaseworker });
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Make caseworker' }));
    expect(onMakeCaseworker).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactActionsMenu.test.tsx` -
"Make caseworker fires the handler" finds no such menuitem.

GREEN - `dashboard/src/routes/contact/ContactActionsMenu.tsx`.

(a) Current (`:49-51`):

```tsx
  /** True while that request is in flight (disables the item). */
  unreadBusy?: boolean;
}
```

Replace with:

```tsx
  /** True while that request is in flight (disables the item). */
  unreadBusy?: boolean;
  /** Open the caseworker conversion dialog (spec 2026-10-06 D16, D22). The
   *  parent passes it ONLY for a live tenant, landlord or partner that is not
   *  already a caseworker (keyed on the stored type); absent hides the item. */
  onMakeCaseworker?: () => void;
}
```

(b) Current (`:70-71`):

```tsx
  unreadBusy = false,
}: ContactActionsMenuProps): React.JSX.Element {
```

Replace with:

```tsx
  unreadBusy = false,
  onMakeCaseworker,
}: ContactActionsMenuProps): React.JSX.Element {
```

(c) Current (`:176-177`):

```tsx
            Run AI extraction
          </button>
```

Replace with:

```tsx
            Run AI extraction
          </button>
          {onMakeCaseworker !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                onMakeCaseworker();
              }}
            >
              Make caseworker
            </button>
          ) : null}
```

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactActionsMenu.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): contact More actions gains Make caseworker`
(stage `dashboard/src/routes/contact/ContactActionsMenu.tsx`,
`dashboard/src/routes/contact/ContactActionsMenu.test.tsx`).

### Task 8.8 - ContactDetail: header facts by type, Make caseworker (menu and Unknown card), the dialog host, the perf pin

Files: `dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`.

Existing tests this task changes (`ContactDetail.test.tsx`): the api mock
gains three functions (`previewCaseworker`, `makeCaseworker`,
`listPossibleCaseworkers`) and their `beforeEach` resets; "renders the Unknown
treatment" (`:496-511`) gains one assertion (Mark as Caseworker enabled).
PINs: "renders the tenant header band with name, tenant pill, and facts"
(`:334-340`, `Voucher 2BR` stays for a tenant), the `it.each` "Mark as %s
sends the complete kind PATCH" table (`:513-531`, Caseworker is NOT in it - it
never PATCHes), "keeps Unknown actions retryable" (`:533-545`).

Rules (spec D16, D19, D21, D22; rulings R4-10, R4-13, R4-14, R4-18):
- Header facts: voucher + housing authority ONLY when `contact.type` is
  `tenant` or `unknown` (keyed on the TYPE: team_member shares the tenant
  pane); a partner's facts line is its organization; landlord unchanged.
- More actions > "Make caseworker" for a live tenant, landlord or partner that
  is not already a caseworker (stored type). Unknown contacts get the card's
  "Mark as Caseworker" (disabled when deleted). Both open `CaseworkerDialog`.
- The dialog is mounted only while open (its preview is read only then); on
  success the page applies the returned contact in place and refetches
  suggestions, the timeline and the file (the page has no separate 1:1
  threads hook: the re-typed threads' messages ride the timeline; relay and
  group threads and properties sent ride `useContactFile`).
- Nothing new is read at mount.

RED - `dashboard/src/routes/contact/ContactDetail.test.tsx`.

(a) Current (`:46-48`):

```tsx
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
```

Replace with:

```tsx
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
// The caseworker conversion (spec 2026-10-06 D19) - and the Possible list,
// mocked only to prove the contact page never reads it.
const previewCaseworker = vi.fn();
const makeCaseworker = vi.fn();
const listPossibleCaseworkers = vi.fn();
```

(b) Current (`:120`):

```tsx
    addOrg: (...a: unknown[]) => addOrg(...a),
```

Replace with:

```tsx
    addOrg: (...a: unknown[]) => addOrg(...a),
    previewCaseworker: (...a: unknown[]) => previewCaseworker(...a),
    makeCaseworker: (...a: unknown[]) => makeCaseworker(...a),
    listPossibleCaseworkers: (...a: unknown[]) => listPossibleCaseworkers(...a),
```

(c) Current (`:312`):

```tsx
  addOrg.mockReset();
```

Replace with:

```tsx
  addOrg.mockReset();
  previewCaseworker.mockReset();
  makeCaseworker.mockReset();
  listPossibleCaseworkers.mockReset().mockResolvedValue([]);
```

(d) In "renders the Unknown treatment", current (`:506-507`):

```tsx
    expect(screen.getByRole('button', { name: /Mark as Property Manager/i })).toBeEnabled();
    // None of the tenant-specific cards/fields leak in.
```

Replace with:

```tsx
    expect(screen.getByRole('button', { name: /Mark as Property Manager/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mark as Caseworker' })).toBeEnabled();
    // None of the tenant-specific cards/fields leak in.
```

(e) Append at the end of the file:

```tsx
describe('ContactDetail - caseworkers (spec 2026-10-06 D16, D19, D21, D22)', () => {
  const PARTNER: Contact = {
    contactId: 'p1',
    type: 'partner',
    firstName: 'Renee',
    lastName: 'Carter',
    status: 'active',
    phone: '+14045550123',
    voucherSize: 2,
    housingAuthority: 'Atlanta Housing Authority',
    organization: 'Hope Atlanta',
  };
  const CASEWORKER: Contact = { ...PARTNER, contactId: 'cw1', role: 'Caseworker' };
  const PREVIEW = {
    contactId: 'k1',
    alreadyCaseworker: false,
    refusals: [],
    removes: { pendingSuggestions: 0 },
    threads: { retype: 1, leftShared: 0, leftOther: 0 },
    organization: { source: 'none' },
  };

  async function openMoreActions(): Promise<{ click: (el: Element) => Promise<void> }> {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /more actions/i }));
    return { click: (el) => user.click(el) };
  }

  function header(container: HTMLElement): HTMLElement {
    const el = container.querySelector('header');
    if (el === null) throw new Error('no header');
    return el;
  }

  it('header facts: a partner shows its organization, never a leftover voucher or authority (D21, D22)', async () => {
    getContact.mockResolvedValue(PARTNER);
    const { container } = renderAt('p1');
    await screen.findByText('Renee Carter');
    const band = header(container);
    expect(within(band).getByText('Hope Atlanta')).toBeInTheDocument();
    expect(within(band).queryByText(/Voucher 2BR/)).toBeNull();
    expect(within(band).queryByText(/Atlanta Housing Authority/)).toBeNull();
  });

  it('header facts: a team member shows none; an unknown keeps voucher and authority (D21)', async () => {
    getContact.mockResolvedValue({ ...TENANT, type: 'team_member', housingAuthority: 'Atlanta Housing Authority' });
    const first = renderAt('k1');
    await screen.findByText('Tasha Williams');
    expect(within(header(first.container)).queryByText(/Voucher 2BR/)).toBeNull();
    expect(within(header(first.container)).queryByText(/Atlanta Housing Authority/)).toBeNull();
    first.unmount();

    getContact.mockResolvedValue({ ...UNKNOWN, voucherSize: 1, housingAuthority: 'Atlanta Housing Authority' });
    const second = renderAt('u9');
    expect(
      await within(header(second.container)).findByText('Voucher 1BR - Atlanta Housing Authority'),
    ).toBeInTheDocument();
  });

  it.each([
    ['tenant', TENANT, 'k1'],
    ['landlord', LANDLORD, 'L1'],
    ['partner', PARTNER, 'p1'],
  ] as const)('More actions offers Make caseworker on a live %s', async (_label, contact, id) => {
    getContact.mockResolvedValue(contact);
    renderAt(id);
    await openMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Make caseworker' })).toBeInTheDocument();
  });

  it.each([
    ['a caseworker', CASEWORKER, 'cw1'],
    ['a team member', { ...TENANT, type: 'team_member' } as Contact, 'k1'],
    ['a deleted tenant', { ...TENANT, deleted_at: '2026-10-01T00:00:00.000Z' } as Contact, 'k1'],
    ['an unknown contact (the card has its own action)', UNKNOWN, 'u9'],
  ] as const)('More actions offers no Make caseworker on %s', async (_label, contact, id) => {
    getContact.mockResolvedValue(contact);
    renderAt(id);
    await openMoreActions();
    expect(screen.getByRole('menuitem', { name: /Edit contact details/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Make caseworker' })).toBeNull();
  });

  it('Make caseworker opens the dialog, and only then is the preview read (R4-13)', async () => {
    getContact.mockResolvedValue(TENANT);
    previewCaseworker.mockResolvedValue(PREVIEW);
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    expect(previewCaseworker).not.toHaveBeenCalled();
    const { click } = await openMoreActions();
    await click(screen.getByRole('menuitem', { name: 'Make caseworker' }));
    expect(screen.getByRole('dialog', { name: 'Make Tasha Williams a caseworker' })).toBeInTheDocument();
    expect(previewCaseworker).toHaveBeenCalledWith('k1', expect.any(AbortSignal));
  });

  it('a conversion applies the returned contact in place and re-reads suggestions, timeline and file (R4-14)', async () => {
    getContact.mockResolvedValue(TENANT);
    previewCaseworker.mockResolvedValue(PREVIEW);
    makeCaseworker.mockResolvedValue({
      ...TENANT,
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      organization: 'Hope Atlanta',
    });
    const { container } = renderAt('k1');
    await screen.findByText('Tasha Williams');
    const { click } = await openMoreActions();
    await click(screen.getByRole('menuitem', { name: 'Make caseworker' }));
    const confirm = screen.getByRole('button', { name: 'Make caseworker' });
    await waitFor(() => expect(confirm).toBeEnabled());
    const before = {
      suggestions: getSuggestions.mock.calls.length,
      timeline: getContactTimeline.mock.calls.length,
      file: getAllPlacements.mock.calls.length,
    };
    await click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Make Tasha Williams a caseworker' })).not.toBeInTheDocument(),
    );
    expect(makeCaseworker).toHaveBeenCalledWith('k1', {});
    // In place: the header now reads the caseworker - its organization, no voucher.
    expect(await within(header(container)).findByText('Hope Atlanta')).toBeInTheDocument();
    expect(within(header(container)).queryByText(/Voucher 2BR/)).toBeNull();
    await waitFor(() => {
      expect(getSuggestions.mock.calls.length).toBeGreaterThan(before.suggestions);
      expect(getContactTimeline.mock.calls.length).toBeGreaterThan(before.timeline);
      expect(getAllPlacements.mock.calls.length).toBeGreaterThan(before.file);
    });
  });

  it("the Unknown card's Mark as Caseworker opens the dialog and never PATCHes", async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    previewCaseworker.mockResolvedValue({ ...PREVIEW, contactId: 'u9' });
    renderAt('u9');
    await user.click(await screen.findByRole('button', { name: 'Mark as Caseworker' }));
    expect(screen.getByRole('dialog', { name: /^Make .+ a caseworker$/ })).toBeInTheDocument();
    expect(previewCaseworker).toHaveBeenCalledWith('u9', expect.any(AbortSignal));
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('(PIN) a contact page reads nothing new at mount: no preview, no Possible list, no org list (R4-13)', async () => {
    getContact.mockResolvedValue(TENANT);
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
    expect(previewCaseworker).not.toHaveBeenCalled();
    expect(listPossibleCaseworkers).not.toHaveBeenCalled();
    expect(getOrgList).not.toHaveBeenCalled();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx` -
the partner header shows "Voucher 2BR - Atlanta Housing Authority", the team
member's header shows the voucher, no "Make caseworker" menuitem exists, the
Unknown card's "Mark as Caseworker" is disabled (no handler passed). The PIN
passes. Every pre-existing case passes.

GREEN - `dashboard/src/routes/contact/ContactDetail.tsx`.

(a) Current (`:43-44`):

```tsx
  type AiRunCompletedEvent,
  type ConversationUpdatedEvent,
```

Replace with:

```tsx
  type AiRunCompletedEvent,
  type Contact,
  type ConversationUpdatedEvent,
```

(b) Current (`:61`):

```tsx
import { PartnerFile } from './PartnerFile.js';
```

Replace with:

```tsx
import { PartnerFile } from './PartnerFile.js';
import { CaseworkerDialog } from './CaseworkerDialog.js';
import { isCaseworkerContact } from './caseworkerRole.js';
```

(c) Current (`:199`):

```tsx
  const [triaging, setTriaging] = useState(false);
```

Replace with:

```tsx
  const [triaging, setTriaging] = useState(false);
  // The caseworker conversion dialog (spec 2026-10-06 D19). MOUNTED only while
  // open, so its preview is read only then - never at this page's mount
  // (ruling R4-13).
  const [converting, setConverting] = useState(false);
```

(d) Current (`:280-281`, inside the contact-change reset effect):

```tsx
    setHaReview(null);
    reviewGenerationRef.current += 1;
```

Replace with:

```tsx
    setHaReview(null);
    reviewGenerationRef.current += 1;
    // Same reason: contact A's conversion dialog must not open on contact B.
    setConverting(false);
```

(e) Current (`:661-665`, the end of `onTriage`):

```tsx
      .catch(() => {
        /* stay on the unknown view; the buttons re-enable for a retry */
      })
      .finally(() => setTriaging(false));
  };
```

Replace with:

```tsx
      .catch(() => {
        /* stay on the unknown view; the buttons re-enable for a retry */
      })
      .finally(() => setTriaging(false));
  };

  // "Make caseworker" (spec D16, D22): a live tenant, landlord or partner
  // that is not already a caseworker - keyed on the STORED type, because the
  // tenant pane also renders team_member contacts. An unknown contact gets the
  // Unknown card's "Mark as Caseworker" instead.
  const canMakeCaseworker =
    !deleted &&
    (contact.type === 'tenant' || contact.type === 'landlord' || contact.type === 'partner') &&
    !isCaseworkerContact(contact);
  // After a conversion: apply the returned contact in place (the file pane
  // swaps to PartnerFile by its type) and re-read what the conversion changed
  // OFF the contact record (ruling R4-14): the superseded suggestions, the
  // timeline (the re-typed 1:1 threads and the status milestone) and the
  // file's slices (relay and group threads, properties sent).
  const onConverted = (updated: Contact): void => {
    setConverting(false);
    setContact(updated);
    suggestions.refetch();
    timeline.refetch();
    file.refetch();
  };
```

(f) Current (`:950-951`, the end of the `ContactActionsMenu` props):

```tsx
            unreadBusy={unreadAction !== 'idle'}
          />
```

Replace with:

```tsx
            unreadBusy={unreadAction !== 'idle'}
            {...(canMakeCaseworker && { onMakeCaseworker: () => setConverting(true) })}
          />
```

(g) Current (`:1128-1129`, the `UnknownFile` render):

```tsx
                onTriage={onTriage}
                triaging={triaging}
```

Replace with:

```tsx
                onTriage={onTriage}
                // A deleted contact gets no conversion (spec D16): absent = disabled.
                {...(!deleted && { onMakeCaseworker: () => setConverting(true) })}
                triaging={triaging}
```

(h) Current (`:1187`):

```tsx
      {/* Spec 2026-10-06 D8 - outside every form; its buttons are all typed. */}
```

Replace with:

```tsx
      {converting ? (
        <CaseworkerDialog
          contactId={contact.contactId}
          name={name}
          onConverted={onConverted}
          onClose={() => setConverting(false)}
        />
      ) : null}

      {/* Spec 2026-10-06 D8 - outside every form; its buttons are all typed. */}
```

(i) In `buildFacts`, current (`:1328-1333`):

```tsx
    } else {
      if (typeof contact!.voucherSize === 'number') parts.push(`Voucher ${contact!.voucherSize}BR`);
      if (typeof contact!['housingAuthority'] === 'string') {
        parts.push(contact!['housingAuthority'] as string);
      }
    }
```

Replace with:

```tsx
    } else if (contact!.type === 'tenant' || contact!.type === 'unknown') {
      // Spec D21: voucher and authority for tenant and unknown ONLY - keyed on
      // the TYPE (team_member shares the tenant pane; an unknown's imported
      // authority is a triage hint). A partner's leftover authority is not a
      // voucher fact.
      if (typeof contact!.voucherSize === 'number') parts.push(`Voucher ${contact!.voucherSize}BR`);
      if (typeof contact!['housingAuthority'] === 'string') {
        parts.push(contact!['housingAuthority'] as string);
      }
    } else if (contact!.type === 'partner') {
      // Spec D22: a partner's facts line is its organization.
      if (typeof contact!.organization === 'string' && contact!.organization !== '') {
        parts.push(contact!.organization);
      }
    }
```

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/ContactDetail.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): contact page - Make caseworker, the conversion dialog, header facts by type`
(stage `dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`).

### Task 8.9 - PartnerFile: Role, Organization, the Staff notes card; the partner half of an open issue

Files: `dashboard/src/routes/contact/PartnerFile.tsx`,
`dashboard/src/routes/contact/files.test.tsx`,
`dashboard/src/routes/contact/ContactDetail.tsx` (one prop),
`docs/issues/staff-notes-on-landlord-partner-files.md`,
`e2e/tests/flows/conversation-fact-extraction.spec.ts` (one assertion
scoped - plan review R1 ruling A14).

Existing tests this task changes: none - the existing `PartnerFile` describe
(`files.test.tsx:544-591`, Group threads) is a PIN; new cases go in their own
describe.

S9 SEAM (named here so S9 can anchor on it): S9 inserts the "Properties sent"
card (and its `listingsSentPending` / `listingsSent` / `onSendProperty` props)
immediately AFTER the "Preferences & notes" card's closing `</Card>` and BEFORE
the line `      {/* PLACEMENT RULING (C13). "Group threads" is TYPE-AGNOSTIC: a group text`
in `PartnerFile.tsx` - the TenantFile order (Staff notes, Preferences & notes,
Properties sent). After this task the `PartnerFile` render in
`ContactDetail.tsx` ends with the line `                onContactUpdated={setContact}`
before its `/>`; S9 adds its props after that line.

RED - append at the end of `dashboard/src/routes/contact/files.test.tsx`:

```tsx
// Spec 2026-10-06 D17, D19 and ruling R4-19: a partner page shows its Role and
// Organization, and the Staff notes card, so a converted caseworker's notes
// stay visible.
describe('PartnerFile - role, organization and staff notes', () => {
  const caseworker: Contact = {
    contactId: 'P2',
    type: 'partner',
    firstName: 'Ana',
    lastName: 'Lopez',
    status: 'active',
    phone: '+14040100056',
    role: 'Caseworker',
    organization: 'Hope Atlanta',
    staff_notes: 'Prefers email',
    staff_notes_updated_at: '2026-10-01T12:00:00.000Z',
  };

  function renderPartner(contact: Contact, onContactUpdated?: (updated: Contact) => void) {
    return render(
      <MemoryRouter>
        <PartnerFile
          contact={contact}
          phones={[{ phone: '+14040100056', primary: true }]}
          media={[]}
          groupThreadsPending={false}
          groupThreads={[]}
          groupThreadsTruncated={false}
          {...(onContactUpdated !== undefined && { onContactUpdated })}
        />
      </MemoryRouter>,
    );
  }

  /** A Details row's value, by its key text. */
  function kv(key: string): string | null {
    return screen.getByText(key, { selector: 'span' }).nextElementSibling?.textContent ?? null;
  }

  it('Details shows the Role and the Organization', () => {
    renderPartner(caseworker);
    expect(kv('Role')).toBe('Caseworker');
    expect(kv('Organization')).toBe('Hope Atlanta');
  });

  it('a partner with no role reads Partner, and no organization reads blank', () => {
    renderPartner({ ...caseworker, role: undefined, organization: undefined });
    expect(kv('Role')).toBe('Partner');
    expect(kv('Organization')).toBe(BLANK);
  });

  it('shows the Staff notes card above Preferences & notes, editable with a handler', () => {
    renderPartner(caseworker, vi.fn());
    const staff = screen.getByRole('heading', { name: /Staff notes/ });
    const prefs = screen.getByRole('heading', { name: /Preferences & notes/ });
    expect(staff.compareDocumentPosition(prefs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Prefers email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
  });

  it('without a handler the Staff notes card is read-only', () => {
    renderPartner(caseworker);
    expect(screen.getByRole('heading', { name: /Staff notes/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit staff notes' })).toBeNull();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/files.test.tsx` -
no "Role" / "Organization" rows and no "Staff notes" heading on the partner
file. The existing describes pass.

GREEN (a) - `dashboard/src/routes/contact/PartnerFile.tsx`.

Current (`:1-15`, the whole header comment and the imports):

```tsx
// PartnerFile - the right pane for a PARTNER contact (type 'partner'): a resolved
// external party (caseworker, agency, inspector, ...) that is NOT a tenant or a
// landlord, so it shows ONLY the type-agnostic cards - Details (phones, status),
// Preferences & notes, and Media from comms. Deliberately omits the tenant cards
// (voucher / housing authority / listings-sent / tours / placements) and the
// landlord cards (units): a partner has no housing pipeline. Unlike UnknownFile it
// carries NO "Needs triage" call-to-action and NO Placements card - a partner is
// already classified (A2, email-channel-v1). Header pill reads "Partner" via
// CONTACT_TYPE_LABEL in ContactDetail.
import type { Contact, ContactPhone, GroupThreadRow } from '../../api/index.js';
import { BLANK, Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { contactStatusLabel, formatPhone } from './format.js';
```

Replace with:

```tsx
// PartnerFile - the right pane for a PARTNER contact (type 'partner'): a resolved
// external party (caseworker, agency, inspector, ...) that is NOT a tenant or a
// landlord. Details (phones, Role, Organization, status), the Staff notes card,
// Preferences & notes, Group threads and Media from comms. Deliberately omits
// the tenant cards (voucher / housing authority / tours / placements) and the
// landlord cards (units): a partner has no housing pipeline, and a converted
// caseworker's old tenant facts stay as data the page does not show (spec
// 2026-10-06 D19). Role is `displayKind` (a caseworker reads "Caseworker");
// Organization is `contact.organization` (spec D17, edited in the edit form).
// Unlike UnknownFile it carries NO "Needs triage" call-to-action - a partner is
// already classified (A2, email-channel-v1).
import type { Contact, ContactPhone, GroupThreadRow } from '../../api/index.js';
import { BLANK, Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';
import { GroupThreadsCard } from './GroupThreadsCard.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';
import { contactStatusLabel, formatPhone } from './format.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';
import { StaffNotesCard } from './StaffNotesCard.js';
```

Current (`:34-36`):

```tsx
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
}
```

Replace with:

```tsx
  /** Open the "Manage numbers" dialog (Phone numbers row). */
  onManagePhones?: () => void;
  /** Receives the contact a Staff notes save returns (applied in place).
   *  Absent -> the Staff notes card is read-only. */
  onContactUpdated?: (updated: Contact) => void;
}
```

Current (`:47-49`):

```tsx
  onEdit,
  onManagePhones,
}: PartnerFileProps): React.JSX.Element {
```

Replace with:

```tsx
  onEdit,
  onManagePhones,
  onContactUpdated,
}: PartnerFileProps): React.JSX.Element {
```

Current (`:83-86`):

```tsx
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : BLANK} />
      </Card>

      <Card
```

Replace with:

```tsx
        <KV k="Role" v={displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])} />
        <KV
          k="Organization"
          v={typeof contact.organization === 'string' && contact.organization !== '' ? contact.organization : BLANK}
        />
        <KV k="Status" v={contact.status ? contactStatusLabel(contact.type, contact.status) : BLANK} />
      </Card>

      {/* Staff notes (spec D19, ruling R4-19): the hand-written box, apart from
          the AI-appended "Preferences & notes" below - so a converted
          caseworker's notes stay visible. Keyed by the contact, as on the
          tenant file. */}
      <StaffNotesCard
        key={contact.contactId}
        contactId={contact.contactId}
        value={contact.staff_notes}
        updatedAt={contact.staff_notes_updated_at}
        {...(onContactUpdated !== undefined && { onContactUpdated })}
      />

      <Card
```

GREEN (b) - `dashboard/src/routes/contact/ContactDetail.tsx`, the `PartnerFile`
render. Current (`:1106-1112`, inside the block that begins at the unique `<PartnerFile`):

```tsx
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          ) : kind === 'unknown' ? (
```

Replace with:

```tsx
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onContactUpdated={setContact}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          ) : kind === 'unknown' ? (
```

(The `) : kind === 'unknown' ? (` tail makes the quote unique: the same three
lines close the landlord block too.)

GREEN (c) - `docs/issues/staff-notes-on-landlord-partner-files.md`. Current
(the `title:` line):

```md
title: Staff notes card exists only on the tenant file; landlord and partner files may want it too
```

Replace with:

```md
title: Staff notes card exists on the tenant and partner files; the landlord file may want it too
```

Current (the `refs:` line):

```md
refs: dashboard/src/routes/contact/TenantFile.tsx, dashboard/src/routes/contact/LandlordFile.tsx, dashboard/src/routes/contact/PartnerFile.tsx
```

Replace with:

```md
refs: dashboard/src/routes/contact/TenantFile.tsx, dashboard/src/routes/contact/LandlordFile.tsx, dashboard/src/routes/contact/PartnerFile.tsx, docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
```

Append at the end of the file:

```md

**Update (2026-10-07, caseworkers branch B).** The PARTNER half is built:
`PartnerFile` renders `StaffNotesCard` above "Preferences & notes", wired to
`onContactUpdated` from `ContactDetail` (spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D19 - a converted caseworker's staff notes must stay visible; Cameron
confirmed 2026-10-07). The LANDLORD half (and the `UnknownFile` question)
stays open, still a product question for Sam.
```

GREEN (d) - the e2e assertion this task makes ambiguous (plan review R1
ruling A14). After this task a role-less partner's page shows "Partner"
TWICE - the header pill and the new Details "Role" row - so the page-wide
exact `getByText('Partner')` in
`e2e/tests/flows/conversation-fact-extraction.spec.ts:342` (right after
"Mark as Partner") resolves two elements: a strict-mode violation. Scope it,
exact, within its card. Current (ASCII, unique in the file):

```ts
  await expect(page.getByText('Partner', { exact: true })).toBeVisible();
```

Replace with:

```ts
  // Scoped to the Details card, exact (caseworkers: the partner page shows
  // "Partner" twice - the header pill and the Details card's Role row, which
  // reads the type for a role-less partner).
  const partnerDetails = page.locator('section', { has: page.getByRole('heading', { name: /^Details/ }) });
  await expect(partnerDetails.getByText('Partner', { exact: true })).toBeVisible();
```

(The Details card's heading name may carry its "Edit" aside, hence the
anchored regex; `selectors.md:37`.)

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/files.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/TenantFile.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0 (the e2e workspace included).
- `cd "W:/tmp/caseworkers"; npx eslint e2e/tests/flows/conversation-fact-extraction.spec.ts` - no error on an added line.
- `cd "W:/tmp/caseworkers"; npm run issues` - regenerates the gitignored index; nothing to stage from it.

Commit `feat(dashboard): partner page shows Role, Organization and Staff notes`
(stage `dashboard/src/routes/contact/PartnerFile.tsx`,
`dashboard/src/routes/contact/files.test.tsx`,
`dashboard/src/routes/contact/ContactDetail.tsx`,
`docs/issues/staff-notes-on-landlord-partner-files.md`,
`e2e/tests/flows/conversation-fact-extraction.spec.ts`).

### Task 8.10 - FilterChips: `ChipGroup` and `Chip` factored out of TenantFilters

Files: `dashboard/src/routes/contacts/FilterChips.tsx` (new),
`dashboard/src/routes/contacts/FilterChips.test.tsx` (new),
`dashboard/src/routes/contacts/TenantFilters.tsx`.

Existing tests this task changes: none. `TenantFilters.test.tsx` and
`ContactsList.test.tsx` are PINs: the move is verbatim, so the Tenants chips
render byte-for-byte as before (ruling R4-12: "ChipGroup/Chip factored out of
TenantFilters").

RED - create `dashboard/src/routes/contacts/FilterChips.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChipGroup } from './FilterChips.js';

const OPTIONS = [
  { key: 'hope atlanta', label: 'Hope Atlanta', count: 2 },
  { key: 'step up', label: 'Step Up', count: 0 },
  { key: '__none__', label: 'Not recorded', count: 1 },
];

describe('FilterChips - ChipGroup', () => {
  it('names the group by its label and each chip by label and count', () => {
    render(
      <ChipGroup label="Organization" emptyLine={null} options={OPTIONS} selected={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />,
    );
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Hope Atlanta (2)',
      'Step Up (0)',
      'Not recorded (1)',
    ]);
    // No Clear until something is selected.
    expect(within(group).queryByRole('button', { name: 'Clear organization filter' })).toBeNull();
  });

  it('toggles by key, keeps an unselected zero-count chip inert, and offers Clear once selected', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <ChipGroup
        label="Organization"
        emptyLine={null}
        options={OPTIONS}
        selected={new Set(['hope atlanta'])}
        onToggle={onToggle}
        onClear={onClear}
      />,
    );
    expect(screen.getByRole('button', { name: 'Hope Atlanta (2)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Hope Atlanta (2)' }));
    expect(onToggle).toHaveBeenCalledWith('hope atlanta');
    const inert = screen.getByRole('button', { name: 'Step Up (0)' });
    expect(inert).toHaveAttribute('aria-disabled', 'true');
    await user.click(inert);
    expect(onToggle).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Clear organization filter' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders the empty line instead of chips', () => {
    render(
      <ChipGroup
        label="Organization"
        emptyLine="No organizations recorded yet"
        options={[]}
        selected={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getByText('No organizations recorded yet')).toBeInTheDocument();
    expect(within(group).queryAllByRole('button')).toHaveLength(0);
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts/FilterChips.test.tsx` -
fails to load: `Failed to resolve import "./FilterChips.js"`.

GREEN (a) - create `dashboard/src/routes/contacts/FilterChips.tsx`. Its body
is `ChipGroup` and `Chip` MOVED VERBATIM from `TenantFilters.tsx:29-124` (doc
comments included), each now `export`ed:

```tsx
// FilterChips - the chip-group controls shared by the contact list pages: the
// Tenants list's facets (TenantFilters) and the Caseworkers page's
// Organization chips (CaseworkersList, spec 2026-10-06 D18 - "built the way
// the Tenants page builds its housing authority chips"). Moved verbatim out of
// TenantFilters (ruling R4-12); the styles stay in TenantFilters.module.css,
// which both pages already load. Markup mirrors ListingsList's chip groups
// (divs + aria-pressed buttons) - deliberately NO ul/li, so a page's rows list
// stays its only source of listitems.
import { useId } from 'react';
import { type FacetOption } from './tenantFacets.js';
import styles from './TenantFilters.module.css';

/**
 * One chip group: the uppercase label, then either its chips (plus a Clear once
 * the facet is non-empty) or the muted "nothing recorded yet" line. The group
 * ALWAYS renders on the Tenants view - a promised control must not silently
 * vanish - and each group gets its OWN label id, or all three would collapse
 * into one accessible name.
 */
export function ChipGroup({
  label,
  emptyLine,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  /** Rendered instead of chips when the facet has zero recorded values. */
  emptyLine: string | null;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: (() => void) | null;
}): React.JSX.Element {
  const labelId = useId();
  return (
    <div className={styles.control}>
      <span className={styles.controlLabel} id={labelId}>
        {label}
      </span>
      <div className={styles.chips} role="group" aria-labelledby={labelId}>
        {emptyLine !== null ? (
          <span className={styles.noneRecorded}>{emptyLine}</span>
        ) : (
          <>
            {options.map((o) => (
              <Chip
                key={o.key}
                label={`${o.label} (${o.count})`}
                on={selected.has(o.key)}
                count={o.count}
                onClick={() => onToggle(o.key)}
              />
            ))}
            {onClear !== null && selected.size > 0 ? (
              <button
                type="button"
                className={styles.clear}
                aria-label={`Clear ${label.toLowerCase()} filter`}
                onClick={onClear}
              >
                Clear
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One facet chip. An UNSELECTED chip whose contextual count is 0 is inert:
 * `aria-disabled` on an ENABLED button (it stays in the tab order so keyboard
 * and screen-reader users can reach the explanation), the click a no-op, and a
 * muted variant whose hover reset outranks the base `.chip:hover`. A SELECTED
 * chip is always clickable - deselection must never lock.
 */
export function Chip({
  label,
  on,
  count,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  count: number;
  onClick: () => void;
  title?: string;
}): React.JSX.Element {
  const inert = count === 0 && !on;
  return (
    <button
      type="button"
      className={`${styles.chip} ${on ? styles.chipOn : ''} ${inert ? styles.chipDisabled : ''}`}
      aria-pressed={on}
      {...(inert && { 'aria-disabled': true })}
      {...(title !== undefined && { title })}
      onClick={() => {
        if (!inert) onClick();
      }}
    >
      {label}
    </button>
  );
}
```

(Before writing, diff the two function bodies against `TenantFilters.tsx:36-87`
and `:96-124` at HEAD: they must match apart from the added `export`.)

GREEN (b) - `dashboard/src/routes/contacts/TenantFilters.tsx`.

Current (`:9-10`):

```tsx
import { useId } from 'react';
import { type FacetOption, type TenantFacetModel, type TenantSelection } from './tenantFacets.js';
```

Replace with:

```tsx
import { useId } from 'react';
import { Chip, ChipGroup } from './FilterChips.js';
import { type TenantFacetModel, type TenantSelection } from './tenantFacets.js';
```

Then DELETE the two moved definitions: from the line `/**` that opens the
comment ` * One chip group: the uppercase label, then either its chips (plus a Clear once`
(HEAD `:29`) through the `}` that closes `function Chip` (HEAD `:124`), plus
the blank line after it - so `toggled` (`:22-27`) is followed directly by
`export function TenantFilters(`. `useId` stays imported (the Porting label
still uses it). (`FacetOption` is dropped from the import: nothing left in the
file uses it - an unused import fails gate 5.)

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts` - all pass (FilterChips, TenantFilters, ContactsList, tenantFacets, useContacts).
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.
- `cd "W:/tmp/caseworkers"; npx eslint dashboard/src/routes/contacts/FilterChips.tsx dashboard/src/routes/contacts/TenantFilters.tsx` - no errors.

Commit `refactor(dashboard): factor ChipGroup and Chip out of TenantFilters`
(stage `dashboard/src/routes/contacts/FilterChips.tsx`,
`dashboard/src/routes/contacts/FilterChips.test.tsx`,
`dashboard/src/routes/contacts/TenantFilters.tsx`).

### Task 8.11 - The Contacts "Filter contacts" links gain Caseworkers (`ContactsFilterTabs`)

Files: `dashboard/src/routes/contacts/ContactsList.tsx`,
`dashboard/src/routes/contacts/ContactsList.test.tsx`.

Existing tests this task changes (`ContactsList.test.tsx`): "renders on-page
filter tabs linking to each filtered route, marking the active one"
(`:159-170`) gains the Caseworkers link and the order. Every facet-carrying
test (the Tenants link's `search`) is a PIN.

The tabs are LINKS in `<nav aria-label="Filter contacts">` (C6). Caseworkers is
its own page (Task 8.12), not a `ContactsFilter`: the link list is factored
into an exported `ContactsFilterTabs` so both pages render the same bar, in
the nav's order (ruling R4-12): All, Tenants, Landlords, Caseworkers, Unknown,
Deleted.

RED - `dashboard/src/routes/contacts/ContactsList.test.tsx`. Current
(`:168-170`):

```tsx
    expect(within(bar).getByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
  });
```

Replace with:

```tsx
    expect(within(bar).getByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    // Caseworkers (spec 2026-10-06 D18): its own page, in the nav's order.
    expect(within(bar).getByRole('link', { name: 'Caseworkers' })).toHaveAttribute('href', '/contacts/caseworkers');
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'All',
      'Tenants',
      'Landlords',
      'Caseworkers',
      'Unknown',
      'Deleted',
    ]);
  });
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts/ContactsList.test.tsx` -
the tabs test finds no "Caseworkers" link.

GREEN - `dashboard/src/routes/contacts/ContactsList.tsx`.

(a) Current (`:43-53`):

```tsx
/** On-page filter tabs. Each is a link to the SAME route the nav uses, so the URL
 *  stays the source of truth: switching here and the nav shortcuts land on the
 *  identical filtered view (and the active tab reflects the current `filter`).
 *  'Deleted' surfaces soft-deleted contacts (restore from their detail page). */
const FILTERS: { filter: ContactsFilter; label: string; to: string }[] = [
  { filter: 'all', label: 'All', to: '/contacts' },
  { filter: 'tenant', label: 'Tenants', to: '/contacts/tenants' },
  { filter: 'landlord', label: 'Landlords', to: '/contacts/landlords' },
  { filter: 'unknown', label: 'Unknown', to: '/contacts/unknown' },
  { filter: 'deleted', label: 'Deleted', to: '/contacts/deleted' },
];
```

Replace with:

```tsx
/** A tab: one of this page's filters, or the Caseworkers page - its own route
 *  and component (CaseworkersList, spec 2026-10-06 D18), not a ContactsList
 *  filter. */
type FilterTab = ContactsFilter | 'caseworkers';

/** On-page filter tabs. Each is a link to the SAME route the nav uses, so the URL
 *  stays the source of truth: switching here and the nav shortcuts land on the
 *  identical filtered view (and the active tab reflects the current `filter`).
 *  The order mirrors the nav (Tenants, Landlords, Caseworkers, Unknown).
 *  'Deleted' surfaces soft-deleted contacts (restore from their detail page). */
const FILTERS: { tab: FilterTab; label: string; to: string }[] = [
  { tab: 'all', label: 'All', to: '/contacts' },
  { tab: 'tenant', label: 'Tenants', to: '/contacts/tenants' },
  { tab: 'landlord', label: 'Landlords', to: '/contacts/landlords' },
  { tab: 'caseworkers', label: 'Caseworkers', to: '/contacts/caseworkers' },
  { tab: 'unknown', label: 'Unknown', to: '/contacts/unknown' },
  { tab: 'deleted', label: 'Deleted', to: '/contacts/deleted' },
];

/** The "Filter contacts" bar, shared by ContactsList and CaseworkersList.
 *  `tenantSearch` is the query string the Tenants tab carries: ONLY that tab
 *  carries facet params, and only while the Tenants view is active - so a
 *  carried param can neither silently filter another audience nor survive as
 *  invisible state. Re-clicking the active tab preserves the facets; leaving
 *  the view drops them (the URL is the only state carrier - spec section 10). */
export function ContactsFilterTabs({
  active,
  tenantSearch,
}: {
  active: FilterTab;
  tenantSearch: string;
}): React.JSX.Element {
  return (
    <nav className={styles.filters} aria-label="Filter contacts">
      {FILTERS.map((f) => (
        <Link
          key={f.tab}
          to={f.tab === 'tenant' ? { pathname: f.to, search: tenantSearch } : f.to}
          className={`${styles.filter} ${f.tab === active ? styles.filterActive : ''}`}
          {...(f.tab === active && { 'aria-current': 'page' })}
        >
          {f.label}
        </Link>
      ))}
    </nav>
  );
}
```

(b) Current (`:241-261`):

```tsx
      <nav className={styles.filters} aria-label="Filter contacts">
        {FILTERS.map((f) => (
          <Link
            key={f.filter}
            // ONLY the Tenants tab carries facet params, and only while the Tenants
            // view is active - so a carried param can neither silently filter
            // another audience nor survive as invisible state. Re-clicking the
            // active tab preserves the facets; leaving the view drops them (the URL
            // is the only state carrier - spec section 10).
            to={
              f.filter === 'tenant'
                ? { pathname: f.to, search: isTenantView ? searchParams.toString() : '' }
                : f.to
            }
            className={`${styles.filter} ${f.filter === filter ? styles.filterActive : ''}`}
            {...(f.filter === filter && { 'aria-current': 'page' })}
          >
            {f.label}
          </Link>
        ))}
      </nav>
```

Replace with:

```tsx
      <ContactsFilterTabs active={filter} tenantSearch={isTenantView ? searchParams.toString() : ''} />
```

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts/ContactsList.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.

Commit `feat(dashboard): Contacts filter links gain Caseworkers`
(stage `dashboard/src/routes/contacts/ContactsList.tsx`,
`dashboard/src/routes/contacts/ContactsList.test.tsx`).

### Task 8.12 - CaseworkersList: the Caseworkers page, its Organization chips and the Possible list

Files (new, plan 3.1): `dashboard/src/routes/contacts/CaseworkersList.tsx`,
`dashboard/src/routes/contacts/CaseworkersList.test.tsx`,
`dashboard/src/routes/contacts/CaseworkersList.module.css`.

Existing tests this task changes: none.

Design (spec D18, D19; rulings R4-04, R4-09, R4-12, R4-13; plan 3.9; C5):
- Reads, on mount and only here: every live PARTNER (`getAllContacts({ type:
  'partner' })`, filtered client-side by `isCaseworkerContact` - there is no
  server role filter) and `listPossibleCaseworkers()`. The route is excluded
  from the page profiler (Task 8.13).
- Heading "Caseworkers"; the "Filter contacts" bar with Caseworkers active;
  the Organization chip group (URL param `org`, repeated, NORMALIZED keys -
  `normalizeAuthorityKey` + `displaySpelling` + Not recorded, the Tenants
  housing-authority chip rules); a list named "Caseworkers" whose rows show
  name, organization and phone; "No caseworkers yet." when there are none.
  Ghost `org` keys are pruned before filtering (a stale link never empties the
  list).
- "Possible caseworkers" (an h2 section and a list of that name): each row has
  the name (a link to the contact), its kind (`displayKind`), phone, one label
  per signal, and the buttons "Make caseworker" (aria-label "Make <name> a
  caseworker" - opens `CaseworkerDialog`; on success BOTH lists are read
  again) and "Not a caseworker" (aria-label "<name> is not a caseworker" - a
  confirm whose name is "Hide <name> from Possible caseworkers?", body "This
  can't be undone in the app.", buttons "Hide" / "Cancel"; on success the row
  is dropped without a re-read).

RED - create `dashboard/src/routes/contacts/CaseworkersList.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, PossibleCaseworkerRow } from '../../api/index.js';
import { formatPhone } from '../contact/format.js';

const getAllContacts = vi.fn();
const listPossibleCaseworkers = vi.fn();
const dismissPossibleCaseworker = vi.fn();
const previewCaseworker = vi.fn();
const makeCaseworker = vi.fn();
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    listPossibleCaseworkers: (...a: unknown[]) => listPossibleCaseworkers(...a),
    dismissPossibleCaseworker: (...a: unknown[]) => dismissPossibleCaseworker(...a),
    previewCaseworker: (...a: unknown[]) => previewCaseworker(...a),
    makeCaseworker: (...a: unknown[]) => makeCaseworker(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { CaseworkersList } from './CaseworkersList.js';

const CW_HOPE: Contact = {
  contactId: 'cw1',
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Ana',
  lastName: 'Lopez',
  phone: '+14040100056',
  organization: 'Hope Atlanta',
};
const CW_NONE: Contact = { contactId: 'cw2', type: 'partner', role: 'case worker', firstName: 'Ben', lastName: 'Ortiz' };
const PLAIN_PARTNER: Contact = { contactId: 'p3', type: 'partner', firstName: 'Renee', lastName: 'Carter' };
const MANAGER: Contact = { contactId: 'p4', type: 'partner', role: 'Case Manager', firstName: 'Cal', lastName: 'Mays' };

const DANA: PossibleCaseworkerRow = {
  contactId: 't9',
  firstName: 'Dana',
  lastName: 'Reyes',
  phone: '+14040100090',
  type: 'tenant',
  role: 'Case manager',
  signals: ['role_mentions', 'relationship'],
};
const RENEE: PossibleCaseworkerRow = {
  contactId: 'p3',
  firstName: 'Renee',
  lastName: 'Carter',
  type: 'partner',
  signals: ['partner_no_role'],
};

const PREVIEW = {
  contactId: 't9',
  alreadyCaseworker: false,
  refusals: [],
  removes: { pendingSuggestions: 0 },
  threads: { retype: 1, leftShared: 0, leftOther: 0 },
  organization: { source: 'none' },
};

function Probe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderAt(url = '/contacts/caseworkers'): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <CaseworkersList />
      <Probe />
    </MemoryRouter>,
  );
}

const caseworkerRows = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole('list', { name: 'Caseworkers' })).getAllByRole('listitem');
const possibleList = async (): Promise<HTMLElement> => screen.findByRole('list', { name: 'Possible caseworkers' });

beforeEach(() => {
  getAllContacts.mockReset().mockResolvedValue([CW_HOPE, CW_NONE, PLAIN_PARTNER, MANAGER]);
  listPossibleCaseworkers.mockReset().mockResolvedValue([DANA, RENEE]);
  dismissPossibleCaseworker.mockReset();
  previewCaseworker.mockReset().mockResolvedValue(PREVIEW);
  makeCaseworker.mockReset();
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [] });
  checkOrgText.mockReset().mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
});

describe('CaseworkersList - the caseworkers (spec 2026-10-06 D18)', () => {
  it('reads the partners and lists only caseworkers, with organization and phone', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Caseworkers' })).toBeInTheDocument();
    expect(getAllContacts).toHaveBeenCalledWith({ type: 'partner' }, expect.any(AbortSignal));
    const rows = await caseworkerRows();
    expect(rows).toHaveLength(2);
    const ana = rows.find((r) => r.textContent?.includes('Ana Lopez'));
    expect(ana).toBeDefined();
    expect(within(ana!).getByText('Hope Atlanta')).toBeInTheDocument();
    expect(within(ana!).getByText(formatPhone('+14040100056'))).toBeInTheDocument();
    expect(within(ana!).getByRole('link')).toHaveAttribute('href', '/contacts/cw1');
    // A role-less partner and a non-caseworker role are not caseworkers.
    const list = screen.getByRole('list', { name: 'Caseworkers' });
    expect(within(list).queryByText(/Renee Carter|Cal Mays/)).toBeNull();
  });

  it('says so when there are none', async () => {
    getAllContacts.mockResolvedValue([PLAIN_PARTNER]);
    renderAt();
    expect(await screen.findByText('No caseworkers yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Caseworkers' })).toBeNull();
  });

  it('marks Caseworkers active in the Filter contacts links', async () => {
    renderAt();
    const bar = screen.getByRole('navigation', { name: 'Filter contacts' });
    expect(within(bar).getByRole('link', { name: 'Caseworkers' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'Tenants' })).not.toHaveAttribute('aria-current');
  });

  it('filters by Organization chips written to the URL as org', async () => {
    const user = userEvent.setup();
    renderAt();
    await caseworkerRows();
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Hope Atlanta (1)',
      'Not recorded (1)',
    ]);
    await user.click(within(group).getByRole('button', { name: 'Hope Atlanta (1)' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('?org=hope+atlanta');
    expect((await caseworkerRows()).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ana Lopez'),
    ]);
    await user.click(within(group).getByRole('button', { name: 'Clear organization filter' }));
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('a shared link filters; a ghost org key is ignored', async () => {
    renderAt('/contacts/caseworkers?org=__none__');
    expect((await caseworkerRows()).map((r) => r.textContent)).toEqual([expect.stringContaining('Ben Ortiz')]);
  });

  it('a stale org key never empties the list', async () => {
    renderAt('/contacts/caseworkers?org=nobody');
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('says when no caseworker has an organization', async () => {
    getAllContacts.mockResolvedValue([CW_NONE]);
    renderAt();
    await caseworkerRows();
    const group = screen.getByRole('group', { name: 'Organization' });
    expect(within(group).getByText('No organizations recorded yet')).toBeInTheDocument();
  });

  it('a failed partner read says so', async () => {
    getAllContacts.mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByText("We couldn't load caseworkers. Please try again.")).toBeInTheDocument();
  });
});

describe('CaseworkersList - Possible caseworkers (spec 2026-10-06 D19, D22)', () => {
  it('lists each possible row with its kind, phone and one label per signal', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 2, name: 'Possible caseworkers' })).toBeInTheDocument();
    const list = await possibleList();
    const [dana, renee] = within(list).getAllByRole('listitem');
    expect(within(dana!).getByRole('link', { name: 'Dana Reyes' })).toHaveAttribute('href', '/contacts/t9');
    expect(within(dana!).getByText('Case manager')).toBeInTheDocument();
    expect(within(dana!).getByText(formatPhone('+14040100090'))).toBeInTheDocument();
    expect(within(dana!).getByText('Role mentions caseworker')).toBeInTheDocument();
    expect(within(dana!).getByText('Linked as a caseworker')).toBeInTheDocument();
    expect(within(dana!).getByRole('button', { name: 'Make Dana Reyes a caseworker' })).toBeInTheDocument();
    expect(within(dana!).getByRole('button', { name: 'Dana Reyes is not a caseworker' })).toBeInTheDocument();
    expect(within(renee!).getByText('Partner')).toBeInTheDocument();
    expect(within(renee!).getByText('Partner with no role')).toBeInTheDocument();
  });

  it('labels the AI-note signal', async () => {
    listPossibleCaseworkers.mockResolvedValue([{ ...DANA, signals: ['ai_note'] }]);
    renderAt();
    expect(within(await possibleList()).getByText('AI noted caseworker')).toBeInTheDocument();
  });

  it('Make caseworker opens the conversion dialog; a success reads both lists again', async () => {
    const user = userEvent.setup();
    makeCaseworker.mockResolvedValue({ ...DANA, type: 'partner', role: 'Caseworker' });
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Make Dana Reyes a caseworker' }));
    expect(screen.getByRole('dialog', { name: 'Make Dana Reyes a caseworker' })).toBeInTheDocument();
    expect(previewCaseworker).toHaveBeenCalledWith('t9', expect.any(AbortSignal));
    const confirm = screen.getByRole('button', { name: 'Make caseworker' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(makeCaseworker).toHaveBeenCalledWith('t9', {});
    await waitFor(() => expect(getAllContacts).toHaveBeenCalledTimes(2));
    expect(listPossibleCaseworkers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog', { name: 'Make Dana Reyes a caseworker' })).toBeNull();
  });

  it('Not a caseworker asks first; Hide dismisses and drops the row without a re-read', async () => {
    const user = userEvent.setup();
    dismissPossibleCaseworker.mockResolvedValue({ contactId: 't9', type: 'tenant' });
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    const confirm = screen.getByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' });
    expect(within(confirm).getByText("This can't be undone in the app.")).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Hide' }));
    expect(dismissPossibleCaseworker).toHaveBeenCalledWith('t9');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' })).toBeNull(),
    );
    expect(within(await possibleList()).queryByText('Dana Reyes')).toBeNull();
    expect(within(await possibleList()).getByText('Renee Carter')).toBeInTheDocument();
    expect(listPossibleCaseworkers).toHaveBeenCalledTimes(1);
  });

  it('Cancel hides nothing; a failed Hide says so and keeps the dialog', async () => {
    const user = userEvent.setup();
    dismissPossibleCaseworker.mockRejectedValue(new Error('offline'));
    renderAt();
    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dismissPossibleCaseworker).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Hide Dana Reyes/ })).toBeNull();

    await user.click(within(await possibleList()).getByRole('button', { name: 'Dana Reyes is not a caseworker' }));
    const confirm = screen.getByRole('dialog', { name: 'Hide Dana Reyes from Possible caseworkers?' });
    await user.click(within(confirm).getByRole('button', { name: 'Hide' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      "Couldn't hide this contact - please try again.",
    );
    expect(within(await possibleList()).getByText('Dana Reyes')).toBeInTheDocument();
  });

  it('a failed Possible read says so and leaves the caseworkers list working', async () => {
    listPossibleCaseworkers.mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByText("We couldn't load possible caseworkers. Please try again.")).toBeInTheDocument();
    expect(await caseworkerRows()).toHaveLength(2);
  });

  it('says so when nobody is left to review', async () => {
    listPossibleCaseworkers.mockResolvedValue([]);
    renderAt();
    expect(await screen.findByText('No possible caseworkers right now.')).toBeInTheDocument();
  });
});
```

Run RED: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts/CaseworkersList.test.tsx` -
fails to load: `Failed to resolve import "./CaseworkersList.js"`.

GREEN (a) - create `dashboard/src/routes/contacts/CaseworkersList.module.css`:

```css
/* CaseworkersList - the Caseworkers page's own pieces (the list rows reuse
   ContactsList.module.css). Tokens only. */

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
  margin: var(--sp-3) 0;
}

.org {
  font-size: var(--fs-sm);
  color: var(--c-text);
}

.possible {
  margin-top: var(--sp-6);
}

.subheading {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.possibleRows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.possibleRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2) var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
}

.possibleName {
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.signals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}

.signal {
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-surface-2);
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
}

.actions {
  display: flex;
  gap: var(--sp-2);
  margin-left: auto;
}

.note {
  margin: var(--sp-2) 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}

.error {
  margin: var(--sp-2) 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
}
```

(Every token above already exists in `dashboard/src/ui/tokens.css` - check
`--fs-xs` and `--c-surface-2` with a grep; if `--fs-xs` is absent use
`--fs-sm`.)

GREEN (b) - create `dashboard/src/routes/contacts/CaseworkersList.tsx`:

```tsx
// CaseworkersList - Contacts > Caseworkers (spec 2026-10-06 D18, D19; ruling
// R4-12). Its own page, not a ContactsList filter: "a caseworker" is a partner
// whose role satisfies isCaseworkerRole, and the server has no role filter, so
// the page reads every live partner (getAllContacts type=partner) and keeps the
// caseworkers client-side. Organization chips are built the way the Tenants
// page builds its housing authority chips (normalized keys, the most frequent
// spelling as the label, Not recorded last; URL param `org`). Below them,
// "Possible caseworkers" (GET /api/contacts/possible-caseworkers - one server
// read of three partitions, ONLY this page reads it): each row says why it is
// there and offers "Make caseworker" (the conversion dialog) and "Not a
// caseworker" (a confirm, then a permanent dismissal). The route is excluded
// from the page profiler (docs/issues/perf-pages-contacts-caseworkers-surface.md).
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  dismissPossibleCaseworker,
  getAllContacts,
  listPossibleCaseworkers,
  type Contact,
  type PossibleCaseworkerRow,
  type PossibleSignal,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { CaseworkerDialog } from '../contact/CaseworkerDialog.js';
import { isCaseworkerContact } from '../contact/caseworkerRole.js';
import { Modal } from '../contact/Modal.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { contactDisplayName, formatPhone } from '../contact/format.js';
import { ContactsFilterTabs } from './ContactsList.js';
import { ChipGroup } from './FilterChips.js';
import {
  NONE_KEY,
  NONE_LABEL,
  displaySpelling,
  normalizeAuthorityKey,
  type FacetOption,
} from './tenantFacets.js';
import listStyles from './ContactsList.module.css';
import styles from './CaseworkersList.module.css';

/** Why a row is on the Possible list - one staff label per signal (plan 3.9). */
export const SIGNAL_LABEL: Readonly<Record<PossibleSignal, string>> = {
  role_mentions: 'Role mentions caseworker',
  ai_note: 'AI noted caseworker',
  relationship: 'Linked as a caseworker',
  partner_no_role: 'Partner with no role',
};

export const NO_CASEWORKERS = 'No caseworkers yet.';
export const DISMISS_FAILED = "Couldn't hide this contact - please try again.";

/** One read's outcome, tagged with the generation it answers. */
type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** Read once per `generation` (bumped after a conversion). A read for an
 *  earlier generation is never shown as this one's; state is set only in the
 *  promise callbacks (the useContacts idiom). `load` must be module-level. */
function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, generation: number): Loaded<T> {
  const [state, setState] = useState<{ generation: number; result: Loaded<T> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ generation, result: { status: 'ready', value } });
      },
      () => {
        if (!controller.signal.aborted) setState({ generation, result: { status: 'error' } });
      },
    );
    return () => controller.abort();
  }, [load, generation]);
  return state !== null && state.generation === generation ? state.result : { status: 'loading' };
}

function byName(a: Contact, b: Contact): number {
  const an = contactDisplayName(a.firstName, a.lastName, a.phone).toLowerCase();
  const bn = contactDisplayName(b.firstName, b.lastName, b.phone).toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : a.contactId < b.contactId ? -1 : 1;
}

const loadCaseworkers = (signal: AbortSignal): Promise<Contact[]> =>
  getAllContacts({ type: 'partner' }, signal).then((partners) =>
    partners.filter((c) => isCaseworkerContact(c)).sort(byName),
  );
const loadPossible = (signal: AbortSignal): Promise<PossibleCaseworkerRow[]> => listPossibleCaseworkers(signal);

/** The recorded organization, or null (a blank or whitespace-only value counts
 *  as unrecorded, the Tenants authority rule). */
function organizationOf(c: Contact): string | null {
  const raw = c.organization;
  return typeof raw === 'string' && normalizeAuthorityKey(raw) !== '' ? raw : null;
}

/** The Organization chips: one per normalized key, labelled by the most
 *  frequent spelling, sorted by key, then Not recorded - or none at all when
 *  no caseworker has an organization (the group shows its empty line). */
export function organizationOptions(caseworkers: readonly Contact[]): FacetOption[] {
  const byKey = new Map<string, Map<string, number>>();
  let unrecorded = 0;
  for (const c of caseworkers) {
    const raw = organizationOf(c);
    if (raw === null) {
      unrecorded += 1;
      continue;
    }
    const key = normalizeAuthorityKey(raw);
    const spellings = byKey.get(key) ?? new Map<string, number>();
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
    byKey.set(key, spellings);
  }
  if (byKey.size === 0) return [];
  const options: FacetOption[] = [...byKey.entries()]
    .map(([key, spellings]) => ({
      key,
      label: displaySpelling(spellings),
      count: [...spellings.values()].reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  options.push({ key: NONE_KEY, label: NONE_LABEL, count: unrecorded });
  return options;
}

function matchesOrganization(c: Contact, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return true;
  const raw = organizationOf(c);
  return raw === null ? keys.has(NONE_KEY) : keys.has(normalizeAuthorityKey(raw));
}

const NO_CONTACTS: Contact[] = [];

export function CaseworkersList(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  // Bumped after a conversion: the new caseworker joins the list and leaves
  // the Possible list, so both are read again.
  const [generation, setGeneration] = useState(0);
  const caseworkers = useLoad(loadCaseworkers, generation);
  const possible = useLoad(loadPossible, generation);
  // Rows "Not a caseworker" dismissed: the server answered, no re-read needed.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [converting, setConverting] = useState<PossibleCaseworkerRow | null>(null);
  const [dismissing, setDismissing] = useState<PossibleCaseworkerRow | null>(null);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const possibleHeadingId = useId();

  const all = caseworkers.status === 'ready' ? caseworkers.value : NO_CONTACTS;
  const options = useMemo(() => organizationOptions(all), [all]);
  // A key no chip carries (a stale or hand-typed link) is pruned before it
  // can filter: a selection nobody can see or clear must not empty the list.
  const selected = useMemo(() => {
    const valid = new Set(options.map((o) => o.key));
    const keys = new Set<string>();
    for (const raw of searchParams.getAll('org')) if (valid.has(raw)) keys.add(raw);
    return keys;
  }, [searchParams, options]);
  const visible = all.filter((c) => matchesOrganization(c, selected));

  /** Write the selection, MERGING the query string; replace, not push. */
  function updateSelection(next: ReadonlySet<string>): void {
    const params = new URLSearchParams(searchParams);
    params.delete('org');
    for (const key of next) params.append('org', key);
    setSearchParams(params, { replace: true });
  }

  function toggle(key: string): void {
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    updateSelection(next);
  }

  async function onHide(): Promise<void> {
    if (dismissing === null || dismissBusy) return;
    const id = dismissing.contactId;
    setDismissBusy(true);
    setDismissError(null);
    try {
      await dismissPossibleCaseworker(id);
      setHidden((prev) => new Set([...prev, id]));
      setDismissing(null);
    } catch {
      setDismissError(DISMISS_FAILED);
    } finally {
      setDismissBusy(false);
    }
  }

  const rowName = (r: PossibleCaseworkerRow): string => contactDisplayName(r.firstName, r.lastName, r.phone);
  const possibleRows = possible.status === 'ready' ? possible.value.filter((r) => !hidden.has(r.contactId)) : [];

  return (
    <div className={listStyles.page}>
      <div className={listStyles.header}>
        <h1 className={listStyles.title}>Caseworkers</h1>
      </div>
      <p className={listStyles.sub}>All records filtered to caseworkers.</p>

      <ContactsFilterTabs active="caseworkers" tenantSearch="" />

      {caseworkers.status === 'ready' && all.length > 0 ? (
        <div className={styles.controls}>
          <ChipGroup
            label="Organization"
            emptyLine={options.length === 0 ? 'No organizations recorded yet' : null}
            options={options}
            selected={selected}
            onToggle={toggle}
            onClear={() => updateSelection(new Set())}
          />
        </div>
      ) : null}

      {caseworkers.status === 'loading' ? <Spinner center /> : null}
      {caseworkers.status === 'error' ? (
        <p className={listStyles.error} role="alert">
          We couldn&apos;t load caseworkers. Please try again.
        </p>
      ) : null}
      {caseworkers.status === 'ready' && all.length === 0 ? <p className={styles.note}>{NO_CASEWORKERS}</p> : null}
      {caseworkers.status === 'ready' && all.length > 0 ? (
        visible.length > 0 ? (
          <ul className={listStyles.rows} aria-label="Caseworkers">
            {visible.map((c) => {
              const org = organizationOf(c);
              return (
                <li key={c.contactId} className={listStyles.rowItem}>
                  <Link to={`/contacts/${c.contactId}`} className={listStyles.row}>
                    <span className={listStyles.name}>{contactDisplayName(c.firstName, c.lastName, c.phone)}</span>
                    <span className={listStyles.meta}>
                      {org !== null ? <span className={styles.org}>{org}</span> : null}
                      <span className={listStyles.phone}>{formatPhone(c.phone)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={listStyles.noMatches}>No caseworkers match the selected filters.</p>
        )
      ) : null}

      <section className={styles.possible} aria-labelledby={possibleHeadingId}>
        <h2 className={styles.subheading} id={possibleHeadingId}>
          Possible caseworkers
        </h2>
        {possible.status === 'loading' ? <Spinner center /> : null}
        {possible.status === 'error' ? (
          <p className={styles.error} role="alert">
            We couldn&apos;t load possible caseworkers. Please try again.
          </p>
        ) : null}
        {possible.status === 'ready' && possibleRows.length === 0 ? (
          <p className={styles.note}>No possible caseworkers right now.</p>
        ) : null}
        {possibleRows.length > 0 ? (
          <ul className={styles.possibleRows} aria-label="Possible caseworkers">
            {possibleRows.map((row) => {
              const name = rowName(row);
              return (
                <li key={row.contactId} className={styles.possibleRow}>
                  <Link to={`/contacts/${row.contactId}`} className={styles.possibleName}>
                    {name}
                  </Link>
                  <span className={listStyles.badge}>{displayKind(row, (t) => CONTACT_TYPE_LABEL[t])}</span>
                  {row.phone !== undefined ? <span className={listStyles.phone}>{formatPhone(row.phone)}</span> : null}
                  <span className={styles.signals}>
                    {row.signals.map((s) => (
                      <span key={s} className={styles.signal}>
                        {SIGNAL_LABEL[s]}
                      </span>
                    ))}
                  </span>
                  <span className={styles.actions}>
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      aria-label={`Make ${name} a caseworker`}
                      onClick={() => setConverting(row)}
                    >
                      Make caseworker
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      aria-label={`${name} is not a caseworker`}
                      onClick={() => {
                        setDismissError(null);
                        setDismissing(row);
                      }}
                    >
                      Not a caseworker
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {converting !== null ? (
        <CaseworkerDialog
          contactId={converting.contactId}
          name={rowName(converting)}
          onConverted={() => {
            setConverting(null);
            setGeneration((n) => n + 1);
          }}
          onClose={() => setConverting(null)}
        />
      ) : null}

      {/* "Not a caseworker" (ruling R4-09): dismissal is permanent with no UI
          undo, so it asks first. The dialog's name is the question. */}
      {dismissing !== null ? (
        <Modal
          title={`Hide ${rowName(dismissing)} from Possible caseworkers?`}
          onClose={dismissBusy ? () => {} : () => setDismissing(null)}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setDismissing(null)}
                disabled={dismissBusy}
              >
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="button" onClick={() => void onHide()} disabled={dismissBusy}>
                Hide
              </Button>
            </>
          }
        >
          <p className={styles.note}>This can&apos;t be undone in the app.</p>
          {dismissError !== null ? (
            <p className={styles.error} role="alert">
              {dismissError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
```

Notes for the builder:
- `displayKind(row, ...)` accepts the row (`type` and optional `role` - a
  `Pick<Contact, 'type' | 'role'>`).
- The test "Make caseworker ... reads both lists again" relies on
  `onConverted` bumping `generation`; the converted contact itself is not
  needed here.
- `toggle` and `updateSelection` are plain functions (no `use` prefix).

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contacts` - all pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0.
- `cd "W:/tmp/caseworkers"; npx eslint dashboard/src/routes/contacts/CaseworkersList.tsx dashboard/src/routes/contacts/CaseworkersList.test.tsx` - no errors.

Commit `feat(dashboard): the Caseworkers page with Organization chips and Possible caseworkers`
(stage `dashboard/src/routes/contacts/CaseworkersList.tsx`,
`dashboard/src/routes/contacts/CaseworkersList.test.tsx`,
`dashboard/src/routes/contacts/CaseworkersList.module.css`).

### Task 8.13 - The nav sub-link and its dot, the route, the profiler exclusion, the e2e selector it breaks

Files: `dashboard/src/app/nav.ts`, `dashboard/src/app/NavContents.tsx`,
`dashboard/src/app/AppFrame.module.css`, `dashboard/src/app/AppFrame.test.tsx`,
`dashboard/src/App.tsx`, `e2e/performance/routes.test.ts`,
`e2e/performance/routes.ts`, `e2e/README.md`,
`docs/issues/perf-pages-contacts-caseworkers-surface.md` (new),
`e2e/tests/dashboard-next/contact-create.spec.ts`.

Existing tests this task changes: `AppFrame.test.tsx` "renders the two nav
groups with every destination as a link" (`:141`) and "Contacts is a parent
with Tenants/Landlords/Unknown children" (`:153-158`);
`e2e/performance/routes.test.ts` (the `excluded` set, `:381-388`);
`e2e/tests/dashboard-next/contact-create.spec.ts:201` (R5-F11: an unscoped
`getByText('Caseworker')` - a case-insensitive SUBSTRING match in Playwright -
would also match the new "Caseworkers" nav link and fail strict mode).
`e2e/tests/dashboard-next/frame.spec.ts:26` lists nav labels as a subset and
stays valid (S10 may extend it).

RED - `dashboard/src/app/AppFrame.test.tsx`.

(a) Current (`:141`):

```tsx
    for (const label of ['Today', 'Placements', 'Tours', 'Contacts', 'Tenants', 'Landlords', 'Unknown', 'Properties']) {
```

Replace with:

```tsx
    for (const label of ['Today', 'Placements', 'Tours', 'Contacts', 'Tenants', 'Landlords', 'Caseworkers', 'Unknown', 'Properties']) {
```

(b) Current (`:153-158`):

```tsx
  it('Contacts is a parent with Tenants/Landlords/Unknown children', async () => {
    renderAuthedApp();
    const tenants = await screen.findByRole('link', { name: 'Tenants' });
    expect(tenants).toHaveAttribute('href', '/contacts/tenants');
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', '/contacts');
  });
```

Replace with:

```tsx
  it('Contacts is a parent with Tenants/Landlords/Caseworkers/Unknown children, in that order', async () => {
    renderAuthedApp();
    const tenants = await screen.findByRole('link', { name: 'Tenants' });
    expect(tenants).toHaveAttribute('href', '/contacts/tenants');
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', '/contacts');
    // Spec 2026-10-06 D18: the one addition to the locked nav.
    expect(screen.getByRole('link', { name: 'Caseworkers' })).toHaveAttribute('href', '/contacts/caseworkers');
    // The child links carry NO aria-label (NavContents renders them as
    // <NavLink> with the label as a child span; only the parent link sets
    // aria-label), so match them by their ACCESSIBLE NAME - getAllByRole
    // returns them in document order - and read the visible label
    // (plan review R1 ruling A13).
    const workspace = screen.getByRole('navigation', { name: 'Workspace' });
    const children = within(workspace)
      .getAllByRole('link', { name: /^(Tenants|Landlords|Caseworkers|Unknown)$/ })
      .map((a) => a.textContent);
    expect(children).toEqual(['Tenants', 'Landlords', 'Caseworkers', 'Unknown']);
  });
```

Run RED:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/app/AppFrame.test.tsx` -
  no "Caseworkers" link in the Workspace nav.

GREEN (a) - `dashboard/src/app/nav.ts`.

Current (`:9`; lines 1-7 above carry glyphs - leave them):

```ts
// `end` marks an exact-match link (react-router NavLink `end`) so a parent route
```

Replace with:

```ts
// 2026-10-07: Contacts gains a Caseworkers child (after Landlords, partner dot) -
// founder-approved amendment to the locked nav (spec 2026-10-06 D18).
//
// `end` marks an exact-match link (react-router NavLink `end`) so a parent route
```

Current (`:31-32`):

```ts
  /** Colored filter dot (the Contacts children: tenant/landlord/unknown). */
  dot?: 'tenant' | 'landlord' | 'unknown';
```

Replace with:

```ts
  /** Colored filter dot (the Contacts children: tenant/landlord/partner/unknown). */
  dot?: 'tenant' | 'landlord' | 'partner' | 'unknown';
```

Current (`:67-68`):

```ts
          { to: '/contacts/landlords', label: 'Landlords', dot: 'landlord' },
          { to: '/contacts/unknown', label: 'Unknown', dot: 'unknown' },
```

Replace with:

```ts
          { to: '/contacts/landlords', label: 'Landlords', dot: 'landlord' },
          { to: '/contacts/caseworkers', label: 'Caseworkers', dot: 'partner' },
          { to: '/contacts/unknown', label: 'Unknown', dot: 'unknown' },
```

GREEN (b) - `dashboard/src/app/NavContents.tsx`. Current (`:18-22`):

```tsx
const DOT_CLASS: Record<NonNullable<NavLeaf['dot']>, string> = {
  tenant: styles.dotTenant ?? '',
  landlord: styles.dotLandlord ?? '',
  unknown: styles.dotUnknown ?? '',
};
```

Replace with:

```tsx
const DOT_CLASS: Record<NonNullable<NavLeaf['dot']>, string> = {
  tenant: styles.dotTenant ?? '',
  landlord: styles.dotLandlord ?? '',
  partner: styles.dotPartner ?? '',
  unknown: styles.dotUnknown ?? '',
};
```

GREEN (c) - `dashboard/src/app/AppFrame.module.css`. Current (`:211-213`):

```css
.dotUnknown {
  background: var(--c-dot-unknown);
}
```

Replace with:

```css
.dotUnknown {
  background: var(--c-dot-unknown);
}
.dotPartner {
  background: var(--c-dot-partner);
}
```

(`--c-dot-partner` exists: `dashboard/src/ui/tokens.css:43`.)

GREEN (d) - `dashboard/src/App.tsx`.

Current (`:19`):

```tsx
import { ContactsList } from './routes/contacts/ContactsList.js';
```

Replace with:

```tsx
import { ContactsList } from './routes/contacts/ContactsList.js';
import { CaseworkersList } from './routes/contacts/CaseworkersList.js';
```

Current (`:67`, inside `IMPLEMENTED`):

```tsx
  '/contacts/unknown',
```

Replace with:

```tsx
  '/contacts/unknown',
  // Contacts > Caseworkers (spec 2026-10-06 D18) - its own page.
  '/contacts/caseworkers',
```

Current (`:155`):

```tsx
            <Route path="contacts/unknown" element={<ContactsList filter="unknown" />} />
```

Replace with:

```tsx
            <Route path="contacts/unknown" element={<ContactsList filter="unknown" />} />
            {/* Contacts > Caseworkers (spec 2026-10-06 D18): its own page, not a
                ContactsList filter. Static - ranks above contacts/:contactId. */}
            <Route path="contacts/caseworkers" element={<CaseworkersList />} />
```

GREEN (e) - `e2e/performance/routes.test.ts`. Current (`:385-387`):

```ts
      // A new Settings tab, not yet a profiler surface
      // (issue perf-pages-settings-organizations-surface).
      '/settings/organizations',
```

Replace with:

```ts
      // A new Settings tab, not yet a profiler surface
      // (issue perf-pages-settings-organizations-surface).
      '/settings/organizations',
      // Contacts > Caseworkers, not yet a profiler surface
      // (issue perf-pages-contacts-caseworkers-surface).
      '/contacts/caseworkers',
```

GREEN (f) - `e2e/performance/routes.ts`. Current (`:658`):

```ts
  // (docs/issues/perf-pages-settings-organizations-surface.md).
```

Replace with:

```ts
  // (docs/issues/perf-pages-settings-organizations-surface.md).
  // TODO(perf-pages-contacts-caseworkers-surface): KNOWN GAP - there is NO
  // row for /contacts/caseworkers (Contacts > Caseworkers, spec 2026-10-06
  // D18), so `npm run perf:pages` never measures it. Excluded on purpose (the
  // route pin in routes.test.ts lists it with the same issue). Registering it
  // needs: a source (the Contacts > Caseworkers nav link), a terminal (the
  // Caseworkers list or its empty line, AND the Possible caseworkers list or
  // its empty line), and its GETs - the partner walk
  // (GET /api/contacts?type=partner, every page) and
  // GET /api/contacts/possible-caseworkers (a server read of the tenant,
  // landlord and partner partitions), both on mount
  // (docs/issues/perf-pages-contacts-caseworkers-surface.md).
```

GREEN (g) - `e2e/README.md`. Current (`:91-93`):

```md
Known gap: Settings > Housing authorities & agencies (`/settings/organizations`,
added 2026-10-06) is not a registered destination either, for the same reason;
registering it is `docs/issues/perf-pages-settings-organizations-surface.md`.
```

Replace with:

```md
Known gap: Settings > Housing authorities & agencies (`/settings/organizations`,
added 2026-10-06) is not a registered destination either, for the same reason;
registering it is `docs/issues/perf-pages-settings-organizations-surface.md`.

Known gap: Contacts > Caseworkers (`/contacts/caseworkers`, added 2026-10-07)
is not a registered destination either; registering it is
`docs/issues/perf-pages-contacts-caseworkers-surface.md`.
```

GREEN (h) - create `docs/issues/perf-pages-contacts-caseworkers-surface.md`:

```md
---
id: perf-pages-contacts-caseworkers-surface
title: Contacts > Caseworkers (/contacts/caseworkers) is excluded from the perf:pages route-registry pin instead of being a profiled surface
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-10-07
refs: e2e/performance/routes.test.ts, e2e/performance/routes.ts, dashboard/src/App.tsx, dashboard/src/routes/contacts/CaseworkersList.tsx, app/src/services/possibleCaseworkers.ts
---

**Problem.** The caseworkers feature (spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D18, D19) adds a Contacts page, `/contacts/caseworkers`, to
`dashboard/src/App.tsx` and the nav. `e2e/performance/routes.test.ts`
requires the App route set, minus its local `excluded` set, to equal the
profiler's `EXPECTED_KEYS` (31 registered surfaces). Registering the page as a
32nd surface changes that `perf:pages` contract (the 31 pins, `EXPECTED_WARM`,
the README count, the `routes.ts` citation ledgers, a new GET contract), which
the feature did not take on (planner ruling R4-13): the path joined the
`excluded` set instead, the `/tours/past` and `/settings/organizations`
precedent. So the page is a staff destination the profiler never measures.
Its reads are scale-bearing: it walks EVERY live partner
(`GET /api/contacts?type=partner`, all pages) and calls
`GET /api/contacts/possible-caseworkers`, which reads the whole tenant,
landlord and partner partitions on the server (no index exists for any
possible-caseworker signal), on every mount and again after each conversion.

**Suggested fix.** Add a `/contacts/caseworkers` row to `ROUTES` in
`e2e/performance/routes.ts` modeled on the `/contacts/unknown` row: source =
the Contacts > Caseworkers nav link; terminal = the "Caseworkers" list (or
"No caseworkers yet.") AND the "Possible caseworkers" list (or "No possible
caseworkers right now.") settled, or a load alert; GET contract = the partner
walk plus `GET /api/contacts/possible-caseworkers`, both on mount. Then add
the key to `EXPECTED_KEYS` / `EXPECTED_WARM`, bump the 31 pins to 32, refresh
the citation ledgers, update the README count, remove the `excluded` entry,
and re-run the profiler self-QA (`npm run perf:pages -- hermetic
--self-qa=full`, human-owned per `e2e/README.md`). Mark it
`surfaceScaleBearing` and `loadScaleBearing` (the two full reads above).
```

GREEN (i) - `e2e/tests/dashboard-next/contact-create.spec.ts`. Current (`:201`):

```ts
    await expect(page.getByText('Caseworker')).toBeVisible();
```

Replace with:

```ts
    // Scoped to the Relationships card and exact: the nav's "Caseworkers" link
    // (spec 2026-10-06 D18) would otherwise match this case-insensitive
    // substring too (R5-F11).
    const relationshipsCard = page.locator('section', { has: page.getByRole('heading', { name: /^Relationships/ }) });
    await expect(relationshipsCard.getByText('Caseworker', { exact: true })).toBeVisible();
```

(Not run here - S10 runs the e2e suite. Its unit-level proof is the Playwright
semantics: `getByText` with a string is a case-insensitive substring match
unless `exact: true`.)

GREEN:
- `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/app src/App.test.tsx` - all pass.
- `cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/routes.test.ts performance/mutationCatalog.test.ts` - both pass.
- `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0 (the e2e workspace typechecks `routes.ts` and the spec).
- `cd "W:/tmp/caseworkers"; npm run issues` - regenerates the gitignored index; nothing to stage from it.

Commit `feat(dashboard): Contacts > Caseworkers nav link, route and profiler exclusion`
(stage `dashboard/src/app/nav.ts`, `dashboard/src/app/NavContents.tsx`,
`dashboard/src/app/AppFrame.module.css`, `dashboard/src/app/AppFrame.test.tsx`,
`dashboard/src/App.tsx`, `e2e/performance/routes.test.ts`,
`e2e/performance/routes.ts`, `e2e/README.md`,
`docs/issues/perf-pages-contacts-caseworkers-surface.md`,
`e2e/tests/dashboard-next/contact-create.spec.ts`).

S8 slice gate (after Task 8.13): `cd "W:/tmp/caseworkers/dashboard"; npx vitest run`
(the whole dashboard workspace), the two e2e-workspace runs above, and
`cd "W:/tmp/caseworkers"; npm run typecheck` - all green; gate 5 on the
slice's touched `.ts`/`.tsx` files reports no error the base commit does not
(compare against the merge base; the known pre-existing `react-hooks/*`
errors stay named, not fixed).

## S9 - shares dashboard (`dashboard/src/routes/listing/*`, `dashboard/src/routes/broadcasts/*`, `dashboard/src/routes/contact/{PartnerFile,ContactDetail,Card}.tsx`, `dashboard/src/api/{types,endpoints}.ts`, `e2e/support/selectors.md`)

> **Assembly notes (BINDING - they override the task text below where they differ;
> `plan-research/plan-assembly-rulings.md`):**
> - The landlord timeline stored-count site keeps "Sent to N recipient(s)" at every N (S6/S9-2); the plan 3.9 share-wording table is binding byte-for-byte.

Spec D20, D22 "Share wording" (strings: plan 3.9's table, assembly ruling S6/S9-3), rulings
R3-F1, F2, F3, F5, F7, F9, F13. Depends on S6 (the recipients wire's
`type`/`role`; the server accepting a partner seed) and runs after S8 (which
edits PartnerFile / ContactDetail too - see the coordination note at the top).
No new GET: PartnerFile's card reads the `units` and `listingsSent` slices
`useContactFile` already loads for every contact (R3 P4), so the page
profiler is unaffected.

Every task edits the e2e pins of the copy it changes, IN THE SAME TASK
(plan review R1 ruling A3; section 0 "e2e pins move with their copy"): the
spec lines are quoted in the task, the task runs the e2e workspace typecheck
and eslint on them, and stages them with its dashboard files. It does not run
the e2e suite (Task 10.4 re-runs every pinned test; Task 10.13 the whole
suite). Task 9.6 owns the `e2e/support/selectors.md` share rows (line 45, the
partner card row and the "Sent to" card row). The S9 -> S10 handoff at the
end of this slice is now a record of what moved where.

Unchanged on purpose (D22, ruling R3-F2) - do not "fix" these:
`Add more tenants by filters` (BroadcastComposer), `Add a tenant` (label and
input), `No candidates {--} add a tenant below.`, `audienceSummary`'s
`Tenants - ...`, TenantFile's `Send a property to this tenant`, and
`Couldn't add that tenant {--} try the search again.` - each describes the
tenant-only filter or search.

### Task 9.1 - the property page: "Send this property" and the "Sent to" card (D20, D22)

Files: `dashboard/src/routes/listing/ListingActionsMenu.tsx`,
`dashboard/src/routes/listing/ListingDetail.tsx`,
`dashboard/src/routes/listing/ListingDetail.test.tsx`,
`dashboard/src/routes/contact/Card.tsx` (comment only, plan review R1 ruling
A12); e2e pins (ruling A3): `e2e/tests/dashboard-next/broadcasts.spec.ts`,
`e2e/scenarios/steps.ts`, `e2e/tests/dashboard-next/matching-entry-points.spec.ts`,
`e2e/tests/dashboard-next/listing-activity.spec.ts`.

RED - `dashboard/src/routes/listing/ListingDetail.test.tsx`. Current (two
lines carry U+22EF, written `{...h}` below - the section 0 glyph legend,
plan review R1 ruling B3: Read the block and copy it exactly as the
old_string; if that cannot match, replace from the line holding the unique
ASCII substring `menu holds Start placement + Send to tenants (moved off the hero)`
through the closing `});` of the test after it):

```ts
  it('the {...h} menu holds Start placement + Send to tenants (moved off the hero)', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    // Neither is a standalone hero button anymore.
    expect(screen.queryByRole('button', { name: 'Start placement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to tenants/ })).not.toBeInTheDocument();
    // Both live in the {...h} menu.
    await user.click(screen.getByRole('button', { name: /More actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Start placement' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Send to tenants' })).toBeInTheDocument();
  });

  it('Sent to tenants card has a "+ Send" action that opens the composer for this property', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Send this property to tenants' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?unitId=u1');
  });
```

Replace with (all ASCII):

```ts
  it('the More actions menu holds Start placement + Send this property (moved off the hero)', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    // Neither is a standalone hero button: the ONLY button named "Send this
    // property" before the menu opens is the "Sent to" card's "+ Send".
    expect(screen.queryByRole('button', { name: 'Start placement' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Send this property' })).toHaveLength(1);
    // Both live in the More actions menu (spec 2026-10-06 D22: neutral words).
    await user.click(screen.getByRole('button', { name: /More actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Start placement' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Send this property' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /tenants/ })).not.toBeInTheDocument();
  });

  it('the "Sent to" card (D20: titled "Sent to") has a "+ Send" action that opens the composer for this property', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('heading', { name: /^Sent to\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Sent to tenants/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send this property' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?unitId=u1');
  });
```

Also rename three test titles (titles only; the rows are queried by link):
`  it('renders "Sent to tenants" rows: identity links to the contact, no chip without a tour', () => {`
-> `  it('renders "Sent to" rows: identity links to the contact, no chip without a tour', () => {`;
`  it('identifies a "Sent to tenants" row by the tenant NAME when the wire provides one', () => {`
-> `  it('identifies a "Sent to" row by the recipient NAME when the wire provides one', () => {`;
`  it('renders each tour-chip state on "Sent to tenants" rows, linking to the tour', () => {`
-> `  it('renders each tour-chip state on "Sent to" rows, linking to the tour', () => {`.

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing/ListingDetail.test.tsx -t "Send this property|Sent to"`
- RED: no button / menuitem named "Send this property" (today: aria-label
  "Send this property to tenants", menuitem "Send to tenants"); no heading
  starting "Sent to" without "tenants".

GREEN.

1. `dashboard/src/routes/listing/ListingActionsMenu.tsx`. Current:

```tsx
              Send to tenants
```

   Replace with:

```tsx
              Send this property
```

   And the JSDoc line (it contains U+2192, written `{->}` - section 0 glyph
   legend; the line holding the unique ASCII substring
   `Omitted on a deleted property` - the WHOLE line becomes ASCII).
   Current `  /** Send this property to tenants. Omitted on a deleted property {->} no item. */`
   Replace with:

```ts
  /** "Send this property" (opens the share composer). Omitted on a deleted property -> no item. */
```

2. `dashboard/src/routes/listing/ListingDetail.tsx`. Current:

```tsx
            title="Sent to tenants"
            aside={
              !deleted ? (
                <CardAction onClick={goToSend} label="Send this property to tenants">
```

   Replace with:

```tsx
            title="Sent to"
            aside={
              !deleted ? (
                <CardAction onClick={goToSend} label="Send this property">
```

   Comment-only (ASCII lines): current
   `//   RIGHT - Contacts roster - Sent to tenants - Placements on this property - Related`
   -> `//   RIGHT - Contacts roster - Sent to - Placements on this property - Related`;
   `// contact); the C4 "Sent to tenants" + C6 "Similar properties" panels show an`
   -> `// contact); the C4 "Sent to" + C6 "Similar properties" panels show an`;
   `  // "Sent to tenants" card's "+ Send" action) - one URL, one place it's built.`
   -> `  // "Sent to" card's "+ Send" action) - one URL, one place it's built.`;
   and the header lines (ASCII) current:

```ts
// near-black header band (address - status badge - facts - "?? Send to
// tenants" + Edit + ?) over a two-column body and a full-width Photos gallery:
```

   Replace with:

```ts
// near-black header band (address - status badge - facts - Edit + the More
// actions kebab, which holds "Send this property") over a two-column body and
// a full-width Photos gallery:
```

   The Tours comment line contains an em dash, written `{--}` (section 0
   glyph legend; the line holding the unique ASCII substring
   `Tours sit between Sent-to-tenants and Placements` - the WHOLE line
   becomes ASCII). Current `          {/* Tours sit between Sent-to-tenants and Placements {--} the flow order`
   Replace with `          {/* Tours sit between Sent-to and Placements - the flow order`.

3. `dashboard/src/routes/contact/Card.tsx` (comment only, plan review R1
   ruling A12). Current (ASCII, unique):

```ts
/** The ONE shared tour-state chip both send-roster cards render ("Sent to
 *  tenants" on the property page + "Properties sent" on the tenant file). It is a
```

   Replace with:

```ts
/** The ONE shared tour-state chip both send-roster cards render ("Sent to"
 *  on the property page + "Properties sent" on a contact's file). It is a
```

4. The e2e pins of this copy (plan review R1 ruling A3). Every "Current"
   below is unique in its file unless the line says otherwise; all ASCII.

   (a) `e2e/tests/dashboard-next/broadcasts.spec.ts:140-143`. Current:

```ts
    // --- Compose from the property: "Send to tenants" in the kebab menu. ---
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Send to tenants' }).click();
```

   Replace with:

```ts
    // --- Compose from the property: "Send this property" in the kebab menu. ---
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Send this property', exact: true }).click();
```

   (b) `e2e/scenarios/steps.ts:1051-1054`. Current:

```ts
      // "Send to tenants" lives in the header kebab (More actions) menu now,
      // not as a standalone hero button.
      await this.page.getByRole('button', { name: 'More actions' }).click();
      await this.page.getByRole('menuitem', { name: 'Send to tenants' }).click();
```

   Replace with:

```ts
      // "Send this property" lives in the header kebab (More actions) menu,
      // not as a standalone hero button (neutral since caseworkers, D22).
      await this.page.getByRole('button', { name: 'More actions' }).click();
      await this.page.getByRole('menuitem', { name: 'Send this property', exact: true }).click();
```

   (`steps.ts:1059` carries a pre-existing non-ASCII dash: do not touch it.)

   (c) `e2e/tests/dashboard-next/matching-entry-points.spec.ts`, three edits
   (its `:152` / `:235` composer pins are Task 9.4's).

   Header comment, current (`:13-16`):

```ts
//   2. From a PROPERTY detail page ("Sent to tenants" card -> "+ Send"): the
//      audience-filtered composer with the unit pre-filled, curated down to one
//      hand-picked tenant (Deselect all -> add one via search) -> Send -> the
//      "Sent to tenants" card lists them.
```

   Replace with:

```ts
//   2. From a PROPERTY detail page ("Sent to" card -> "+ Send"): the
//      audience-filtered composer with the unit pre-filled, curated down to one
//      hand-picked tenant (Deselect all -> add one via search) -> Send -> the
//      "Sent to" card lists them.
```

   `:203-206`. Current:

```ts
    // From the property page, the "Sent to tenants" card "+ Send" action opens the
    // audience-filtered composer with the unit pre-filled (?unitId=).
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'Send this property to tenants' }).click();
```

   Replace with:

```ts
    // From the property page, the "Sent to" card "+ Send" action opens the
    // audience-filtered composer with the unit pre-filled (?unitId=).
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'Send this property', exact: true }).click();
```

   `:260-264`. Current:

```ts
    // The property page's "Sent to tenants" card now lists the hand-picked tenant.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const sentCard = page.locator('section', {
      has: page.getByRole('heading', { name: 'Sent to tenants' }),
    });
```

   Replace with:

```ts
    // The property page's "Sent to" card now lists the hand-picked tenant. The
    // heading's name is "Sent to" PLUS its "Send this property" action (Card
    // renders the aside inside the <h3>), so match the prefix, never exact.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const sentCard = page.locator('section', {
      has: page.getByRole('heading', { name: /^Sent to\b/ }),
    });
```

   (d) `e2e/tests/dashboard-next/listing-activity.spec.ts`, three edits (its
   `:143` Activity pin is Task 9.3's).

   `:180` (comment). Current:

```ts
    // records a listing_sends row (the "Sent to tenants" ledger).
```

   Replace with:

```ts
    // records a listing_sends row (the "Sent to" ledger).
```

   `:161`. Current:

```ts
test.describe('Property detail - "Sent to tenants" tour chip (listing-response-tour-chip)', () => {
```

   Replace with:

```ts
test.describe('Property detail - "Sent to" tour chip (listing-response-tour-chip)', () => {
```

   `:211-216`. Current:

```ts
    // The "Sent to tenants" card shows both recipients with NO tour chip, and
    // the dead "No reply" label appears nowhere on the page.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: 'Sent to tenants' }),
    });
```

   Replace with:

```ts
    // The "Sent to" card shows both recipients with NO tour chip, and the dead
    // "No reply" label appears nowhere on the page. The heading's name carries
    // its "Send this property" action too: match the prefix.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: /^Sent to\b/ }),
    });
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing` - GREEN. Typecheck
(`cd "W:/tmp/caseworkers"; npm run typecheck`) exit 0 (it typechecks the e2e
workspace too). Lint the edited e2e files:
`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/broadcasts.spec.ts e2e/scenarios/steps.ts e2e/tests/dashboard-next/matching-entry-points.spec.ts e2e/tests/dashboard-next/listing-activity.spec.ts`
- no error on an added line (`steps.ts` may carry pre-existing errors: leave
them). ASCII: `cd "W:/tmp/caseworkers"; git diff -U0 | grep '^+' | grep -nP '[^\x00-\x7F]'` prints nothing.

Pins changed (dashboard): `ListingDetail.test.tsx:980-998` and the three
titles; e2e: step 4 (a)-(d) (all edited above; Task 10.4 runs them).

Commit (stage the four dashboard files `dashboard/src/routes/listing/ListingActionsMenu.tsx`,
`dashboard/src/routes/listing/ListingDetail.tsx`,
`dashboard/src/routes/listing/ListingDetail.test.tsx`,
`dashboard/src/routes/contact/Card.tsx`, and the four e2e files
`e2e/tests/dashboard-next/broadcasts.spec.ts`, `e2e/scenarios/steps.ts`,
`e2e/tests/dashboard-next/matching-entry-points.spec.ts`,
`e2e/tests/dashboard-next/listing-activity.spec.ts`)
`feat(caseworkers): property page says Send this property and Sent to (D22)`.

### Task 9.2 - "Sent to" rows label a resolved non-tenant recipient by its displayKind (D20, D22, ruling R3-F3)

A row whose wire `type` is set and is not `tenant` shows the contact's
`displayKind` (role, else `CONTACT_TYPE_LABEL[type]` - "Partner",
"Landlord", "Team", "Unknown") as a muted label beside the name link; a
tenant row and an unresolved row (no `type` - S6 omits it) show none. The
label sits OUTSIDE the link, so the link's accessible name stays the name.

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`
(comment), `dashboard/src/routes/listing/listingFormat.ts` (+ test),
`dashboard/src/routes/contact/Card.tsx`, `dashboard/src/routes/contact/Card.module.css`,
`dashboard/src/routes/listing/ListingDetail.tsx` (+ test).

RED.

1. `dashboard/src/routes/listing/listingFormat.test.ts`. Imports, current:

```ts
  describeUnitActivity,
  isMediaUrl,
```

   Replace with:

```ts
  describeUnitActivity,
  isMediaUrl,
  sendRowKindLabel,
```

   Append at the END of the file (after its last `});`):

```ts

describe('sendRowKindLabel (caseworkers D20/D22)', () => {
  it('labels a resolved non-tenant row by displayKind: the role, else the type label', () => {
    expect(sendRowKindLabel({ type: 'partner', role: 'Caseworker' })).toBe('Caseworker');
    expect(sendRowKindLabel({ type: 'partner' })).toBe('Partner');
    expect(sendRowKindLabel({ type: 'partner', role: '   ' })).toBe('Partner');
    expect(sendRowKindLabel({ type: 'landlord' })).toBe('Landlord');
    expect(sendRowKindLabel({ type: 'team_member' })).toBe('Team');
    expect(sendRowKindLabel({ type: 'unknown' })).toBe('Unknown');
  });

  it('leaves a tenant row and an unresolved row (no type) unlabelled', () => {
    expect(sendRowKindLabel({ type: 'tenant' })).toBeUndefined();
    expect(sendRowKindLabel({ type: 'tenant', role: 'Case worker' })).toBeUndefined();
    expect(sendRowKindLabel({})).toBeUndefined();
  });
});
```

2. `dashboard/src/routes/listing/ListingDetail.test.tsx` - a new case
   immediately BEFORE the (renamed in 9.1) chip test. Current:

```ts
  it('renders each tour-chip state on "Sent to" rows, linking to the tour', () => {
```

   Replace with:

```ts
  it('caseworkers D20: a resolved non-tenant "Sent to" row shows its displayKind beside the name; tenant and unresolved rows show none', () => {
    useListing.mockReturnValue({
      ...READY,
      recipients: {
        status: 'ready',
        rows: [
          { contactId: 'c-ten', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', tenantName: 'Tia Moss', type: 'tenant' },
          { contactId: 'c-cw', unitId: 'u1', sentAt: '2026-06-29T10:00:00Z', via: 'broadcast', tenantName: 'Cora Reyes', type: 'partner', role: 'Caseworker' },
          { contactId: 'c-pt', unitId: 'u1', sentAt: '2026-06-28T10:00:00Z', via: 'broadcast', tenantName: 'Pat Lin', type: 'partner' },
          { contactId: 'c-ll', unitId: 'u1', sentAt: '2026-06-27T10:00:00Z', via: 'broadcast', tenantName: 'Lee Park', type: 'landlord' },
          { contactId: 'c-gone', unitId: 'u1', sentAt: '2026-06-26T10:00:00Z', via: 'broadcast' },
        ],
      },
    });
    renderAt();
    const card = screen.getByRole('heading', { name: /^Sent to\b/ }).closest('section') as HTMLElement;
    const rowOf = (name: string): HTMLElement =>
      within(card).getByRole('link', { name }).closest('div') as HTMLElement;
    // The label is OUTSIDE the link: the link's name stays the person's name.
    expect(within(rowOf('Cora Reyes')).getByText('Caseworker')).toBeInTheDocument();
    expect(within(rowOf('Pat Lin')).getByText('Partner')).toBeInTheDocument();
    expect(within(rowOf('Lee Park')).getByText('Landlord')).toBeInTheDocument();
    expect(rowOf('Tia Moss').textContent).toBe('Tia Moss');
    expect(rowOf('c-gone').textContent).toBe('c-gone');
  });

  it('renders each tour-chip state on "Sent to" rows, linking to the tour', () => {
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing/listingFormat.test.ts src/routes/listing/ListingDetail.test.tsx -t "sendRowKindLabel|caseworkers D20"`
- RED: `sendRowKindLabel` is not exported (the listingFormat file fails on
  the import), and the ListingDetail case finds no "Caseworker" / "Partner" /
  "Landlord" text in the rows. (vitest strips types, so the rows' `type` /
  `role` fields run before step 1 types them; `npm run typecheck` is what
  proves the `types.ts` mirror.)

GREEN.

1. `dashboard/src/api/types.ts` (S9 owns this mirror, plan 3.8). Current:

```ts
  /** The pairing's most-progressed tour, when one qualifies - powers the roster
   *  tour chip. Absent when no qualifying tour exists (the row renders no chip). */
  tour?: TourSignal;
}
```

   Replace with:

```ts
  /** The pairing's most-progressed tour, when one qualifies - powers the roster
   *  tour chip. Absent when no qualifying tour exists (the row renders no chip). */
  tour?: TourSignal;
  /** caseworkers D20 (plan 3.7): the recipient's contact type - on the property
   *  "Sent to" rows ONLY (GET /api/units/:id/recipients), absent when the
   *  contact did not resolve. A non-tenant row is labelled by it. */
  type?: ContactType;
  /** caseworkers D20: the recipient's role, when it holds text (same rules). */
  role?: string;
}
```

   (`ContactType` is declared in the same file.)

2. `dashboard/src/api/endpoints.ts`, comment-only. Current
   `/** GET /api/units/:id/recipients (C4) - the "Sent to tenants" rows (recipients,`
   -> `/** GET /api/units/:id/recipients (C4) - the "Sent to" rows (recipients,`.

3. `dashboard/src/routes/listing/listingFormat.ts`. Imports, current:

```ts
import {
  LISTING_STATUS_LABELS,
  type ListingStatus,
  type UnitActivityEvent,
  type UnitItem,
} from '../../api/index.js';
import { formatAddress, humanize } from '../contact/format.js';
```

   Replace with:

```ts
import {
  LISTING_STATUS_LABELS,
  type ListingSendRow,
  type ListingStatus,
  type UnitActivityEvent,
  type UnitItem,
} from '../../api/index.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { formatAddress, humanize } from '../contact/format.js';
```

   Append at the END of the file. Current (unique):

```ts
    default:
      return { label: humanize(e.type) };
  }
}
```

   Replace with:

```ts
    default:
      return { label: humanize(e.type) };
  }
}

/**
 * Spec 2026-10-06 D20/D22 (caseworkers): the label a property "Sent to" row
 * shows beside the recipient's name - the contact's displayKind (its role,
 * else the type label, e.g. "Partner") for a RESOLVED non-tenant row. A
 * tenant row stays unlabelled, and so does a row whose contact did not resolve
 * (the server omits `type`).
 */
export function sendRowKindLabel(row: Pick<ListingSendRow, 'type' | 'role'>): string | undefined {
  if (row.type === undefined || row.type === 'tenant') return undefined;
  return displayKind({ type: row.type, role: row.role }, (t) => CONTACT_TYPE_LABEL[t]);
}
```

4. `dashboard/src/routes/contact/Card.tsx`. Current:

```tsx
export function SendRosterRow({
  to,
  identity,
  tour,
}: {
  to: string;
  identity: React.ReactNode;
  tour?: { tourId: string; state: TourSignalState };
}): React.JSX.Element {
  return (
    <div className={styles.li}>
      <span className={styles.liLabel}>
        <Link className={styles.rowLink ?? ''} to={to}>
          {identity}
        </Link>
      </span>
```

   Replace with:

```tsx
export function SendRosterRow({
  to,
  identity,
  kind,
  tour,
}: {
  to: string;
  identity: React.ReactNode;
  /** caseworkers D20: a muted label after the identity link (a non-tenant
   *  recipient's displayKind on the property "Sent to" card). Outside the
   *  link, so the link's accessible name stays the identity. */
  kind?: string;
  tour?: { tourId: string; state: TourSignalState };
}): React.JSX.Element {
  return (
    <div className={styles.li}>
      <span className={styles.liLabel}>
        <Link className={styles.rowLink ?? ''} to={to}>
          {identity}
        </Link>
        {kind !== undefined ? <span className={styles.rowKind}>{kind}</span> : null}
      </span>
```

5. `dashboard/src/routes/contact/Card.module.css`. Current:

```css
.muted {
  color: var(--c-text-muted);
}
```

   Replace with:

```css
.muted {
  color: var(--c-text-muted);
}

/* caseworkers D20: a send-roster row's recipient kind (e.g. "Partner"). */
.rowKind {
  margin-left: var(--sp-2);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
}
```

6. `dashboard/src/routes/listing/ListingDetail.tsx`. Import, current:

```ts
  isMediaUrl,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
```

   Replace with:

```ts
  isMediaUrl,
  sendRowKindLabel,
  shortAddress,
  statusLabel,
} from './listingFormat.js';
```

   The rows, current:

```tsx
                recipients.rows.map((row) => (
                  <SendRosterRow
                    key={`${row.contactId}:${row.sentAt}`}
                    to={`/contacts/${row.contactId}`}
                    identity={row.tenantName ?? row.contactId}
                    {...(row.tour && { tour: row.tour })}
                  />
                ))
```

   Replace with:

```tsx
                recipients.rows.map((row) => {
                  // caseworkers D20/D22: a resolved non-tenant row is labelled by
                  // its displayKind; tenant and unresolved rows are not.
                  const kind = sendRowKindLabel(row);
                  return (
                    <SendRosterRow
                      key={`${row.contactId}:${row.sentAt}`}
                      to={`/contacts/${row.contactId}`}
                      identity={row.tenantName ?? row.contactId}
                      {...(kind !== undefined && { kind })}
                      {...(row.tour && { tour: row.tour })}
                    />
                  );
                })
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing src/routes/contact/files.test.tsx` - GREEN
(TenantFile's rows pass no `kind` and render as before). Typecheck exit 0.

Pins changed: none (unit or e2e). New e2e coverage is S10's
`partner-share.spec.ts` (the property "Sent to" card lists the partner with
`Partner` beside the name).

Commit (stage `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
`dashboard/src/routes/listing/listingFormat.ts`,
`dashboard/src/routes/listing/listingFormat.test.ts`,
`dashboard/src/routes/contact/Card.tsx`, `dashboard/src/routes/contact/Card.module.css`,
`dashboard/src/routes/listing/ListingDetail.tsx`,
`dashboard/src/routes/listing/ListingDetail.test.tsx`)
`feat(caseworkers): Sent to rows label partner and other non-tenant recipients (D20)`.

### Task 9.3 - the property Activity share row says recipients (D20, D22)

Files: `dashboard/src/routes/listing/listingFormat.ts`,
`dashboard/src/routes/listing/listingFormat.test.ts`; e2e pins (plan review
R1 ruling A3): `e2e/tests/dashboard-next/listing-activity.spec.ts`,
`e2e/tests/dashboard-next/share-sent-outcome.spec.ts`.

RED - `dashboard/src/routes/listing/listingFormat.test.ts`. Current:

```ts
  it('describes broadcast_sent with a recipient count and a broadcast deep-link', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 5 }))).toEqual({
      label: 'Sent to 5 tenants',
      to: '/broadcasts/b1',
    });
  });
```

Replace with:

```ts
  it('describes broadcast_sent with a recipient count and a broadcast deep-link', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 5 }))).toEqual({
      label: 'Sent to 5 recipients',
      to: '/broadcasts/b1',
    });
  });
```

Then the pluralization case (its title carries U+2192, written `{->}` -
section 0 glyph legend, plan review R1 ruling B3; the title line holds the
unique ASCII substring `pluralizes the recipient count (1 ` - the WHOLE title
line becomes ASCII). Current:

```ts
  it('pluralizes the recipient count (1 {->} tenant) and omits the link when no broadcastId', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 1 }))).toEqual({
      label: 'Sent to 1 tenant',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 2 }))).toEqual({
      label: 'Sent to 2 tenants',
    });
  });
```

Replace with:

```ts
  it('pluralizes the recipient count (1 -> recipient) and omits the link when no broadcastId', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 1 }))).toEqual({
      label: 'Sent to 1 recipient',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 2 }))).toEqual({
      label: 'Sent to 2 recipients',
    });
  });
```

Then current:

```ts
  it('a share that reached nobody reads "No tenants reached" (an absent count too), linking to the share', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 0 }))).toEqual({
      label: 'No tenants reached',
      to: '/broadcasts/b1',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent' }))).toEqual({ label: 'No tenants reached' });
  });
```

Replace with:

```ts
  it('a share that reached nobody reads "No recipients reached" (an absent count too), linking to the share', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 0 }))).toEqual({
      label: 'No recipients reached',
      to: '/broadcasts/b1',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent' }))).toEqual({ label: 'No recipients reached' });
  });
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing/listingFormat.test.ts -t "broadcast_sent|reached nobody|pluralizes"`
- RED: labels still say "tenant(s)" / "No tenants reached".

GREEN - `dashboard/src/routes/listing/listingFormat.ts`. Current:

```ts
      label: n === 0 ? 'No tenants reached' : `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`,
```

Replace with:

```ts
      // Spec 2026-10-06 D20/D22: neutral words - a share may reach partners;
      // the label keeps its "Sent to " prefix.
      label: n === 0 ? 'No recipients reached' : `Sent to ${n} ${n === 1 ? 'recipient' : 'recipients'}`,
```

(The persisted `tenantCount` field is read as before - R3-F12.)

The e2e pins of this copy (plan review R1 ruling A3; all ASCII, each
"Current" unique in its file):

(a) `e2e/tests/dashboard-next/listing-activity.spec.ts:143`. Current:

```ts
    const bcast = activity.getByRole('link', { name: /Sent to 2 tenants/ });
```

Replace with:

```ts
    const bcast = activity.getByRole('link', { name: /Sent to 2 recipients/ });
```

(b) `e2e/tests/dashboard-next/share-sent-outcome.spec.ts`, three edits.

`:27` (header comment). Current:

```ts
//                                       flagged, "No tenants reached";
```

Replace with:

```ts
//                                       flagged, "No recipients reached";
```

`:621`, current (substring of the test title):

```ts
the tenant not flagged, the property Activity "No tenants reached"', async ({
```

Replace with:

```ts
the tenant not flagged, the property Activity "No recipients reached"', async ({
```

`:671`. Current:

```ts
    const entry = activity.getByRole('link', { name: /No tenants reached/ });
```

Replace with:

```ts
    const entry = activity.getByRole('link', { name: /No recipients reached/ });
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/listing` - GREEN. Typecheck
(`cd "W:/tmp/caseworkers"; npm run typecheck`, the e2e workspace included)
exit 0. Lint the two e2e files:
`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/listing-activity.spec.ts e2e/tests/dashboard-next/share-sent-outcome.spec.ts`
- no error on an added line.

Pins changed: dashboard `listingFormat.test.ts:229-253`; e2e (a) and (b)
(all edited above; Task 10.4 runs them).

Commit (stage `dashboard/src/routes/listing/listingFormat.ts`,
`dashboard/src/routes/listing/listingFormat.test.ts`,
`e2e/tests/dashboard-next/listing-activity.spec.ts`,
`e2e/tests/dashboard-next/share-sent-outcome.spec.ts`)
`feat(caseworkers): property Activity share row says recipients (D20)`.

### Task 9.4 - the composer's review step and reach line say recipients (D20, D22)

Files: `dashboard/src/routes/broadcasts/RecipientPreview.tsx`,
`dashboard/src/routes/broadcasts/AudienceFilters.tsx`,
`dashboard/src/routes/broadcasts/BroadcastComposer.tsx` (comment), and tests
`RecipientPreview.test.tsx`, `BroadcastComposer.test.tsx`,
`AudienceFilters.test.tsx`; e2e pins (plan review R1 ruling A3):
`e2e/tests/dashboard-next/broadcasts.spec.ts`,
`e2e/tests/dashboard-next/matching-entry-points.spec.ts`,
`e2e/tests/dashboard-next/share-skip-fix.spec.ts`,
`e2e/tests/dashboard-next/org-lists.spec.ts`.

RED (pin edits first - each is a wording RED).

1. `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx` - mechanical
   replacements with the Edit tool (`replace_all: true`, each old string
   INCLUDING its quote/slash delimiters, so the comment at `:448`, which uses
   double quotes, is NOT touched):
   - `'Send to 2 tenants'` -> `'Send to 2 recipients'` (lines 306, 344);
   - `'Send to 1 tenant'` -> `'Send to 1 recipient'` (377, 412, 543, 613, 626, 663);
   - `/^Send to 0 tenants/` -> `/^Send to 0 recipients/` (633);
   - `/^Send to 2 tenants/` -> `/^Send to 2 recipients/` (653);
   - `/Send to 1 tenant/` -> `/Send to 1 recipient/` (702, 713, 721, 736, 756, 770, 782, 794);
   - `'Flagged tenants you picked stay checked; "Select all" skips the others.'`
     -> `'Flagged recipients you picked stay checked; "Select all" skips the others.'` (251);
   - `/1 added tenant can't receive texts/` -> `/1 added recipient can't receive texts/` (590).
   After the edits, `grep -n "tenants\?'\|tenants\?/" src/routes/broadcasts/RecipientPreview.test.tsx`
   shows only the `Add a tenant` / add-a-tenant lines (unchanged on purpose).

   Then the empty_audience case. Current:

```ts
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Nothing selected/i);
```

   Replace with:

```ts
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    // Spec 2026-10-06 D22: neutral words (a partner seed can be a recipient).
    expect(alert).toHaveTextContent('Nothing selected - check at least one recipient to send.');
```

   And a plural pin for the unresolved-seed note, immediately after the
   existing single case. Current:

```ts
    expect(screen.getByText(/1 added recipient can't receive texts/)).toBeInTheDocument();
  });
```

   (as edited above) Replace with:

```ts
    expect(screen.getByText(/1 added recipient can't receive texts/)).toBeInTheDocument();
  });

  it('caseworkers D22: the plural unresolved-seed note says recipients', () => {
    renderPreview({ preview: previewOf({ unresolvedSeedIds: ['ghost-1', 'ghost-2'] }) });
    expect(
      screen.getByText(
        "2 added recipients can't receive texts (unknown, opted out, or unreachable) and were left out.",
      ),
    ).toBeInTheDocument();
  });
```

2. `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`:
   `/Reaches\s*5\s*tenants/` -> `/Reaches\s*5\s*recipients/` (189);
   `/^Send to 1 tenant/` -> `/^Send to 1 recipient/` (481);
   `'Send to 1 tenant'` -> `'Send to 1 recipient'` (844).

3. `dashboard/src/routes/broadcasts/AudienceFilters.test.tsx`:
   `/Reaches\s*7\s*tenants/` -> `/Reaches\s*7\s*recipients/` (235).

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/AudienceFilters.test.tsx`
- RED: every edited case fails on the old "tenant(s)" wording (and the
  empty_audience text on its em dash + "tenant").

GREEN.

1. `dashboard/src/routes/broadcasts/RecipientPreview.tsx`.
   - The empty_audience line contains an em dash, written `{--}` (section 0
     glyph legend, plan review R1 ruling B3; the line holding the unique
     ASCII substring `check at least one tenant to send` - the WHOLE line
     becomes ASCII). Current
     `          setError('Nothing selected {--} check at least one tenant to send.');`
     Replace with:

```ts
          setError('Nothing selected - check at least one recipient to send.');
```

   - Current:

```tsx
        Flagged tenants you picked stay checked; &quot;Select all&quot; skips the others.
```

     Replace with:

```tsx
        Flagged recipients you picked stay checked; &quot;Select all&quot; skips the others.
```

   - Current:

```tsx
            ? "1 added tenant can't receive texts (unknown, opted out, or unreachable) and was left out."
            : `${preview.unresolvedSeedIds.length} added tenants can't receive texts (unknown, opted out, or unreachable) and were left out.`}
```

     Replace with:

```tsx
            ? "1 added recipient can't receive texts (unknown, opted out, or unreachable) and was left out."
            : `${preview.unresolvedSeedIds.length} added recipients can't receive texts (unknown, opted out, or unreachable) and were left out.`}
```

   - Current:

```tsx
              : `Send to ${checkedCount} tenant${checkedCount === 1 ? '' : 's'}`}
```

     Replace with:

```tsx
              : `Send to ${checkedCount} recipient${checkedCount === 1 ? '' : 's'}`}
```

   - Comment-only. Current `// A live selected count drives "Send to N tenants", which posts the EXACT`
     -> `// A live selected count drives "Send to N recipients", which posts the EXACT`.
   - NOT changed: `No candidates {--} add a tenant below.`, the `Add a tenant`
     label/input, `Couldn't add that tenant {--} ...` (D22).

2. `dashboard/src/routes/broadcasts/AudienceFilters.tsx`. Current:

```tsx
            Reaches <strong>{reachCount}</strong> tenant{reachCount === 1 ? '' : 's'}
```

   Replace with:

```tsx
            Reaches <strong>{reachCount}</strong> recipient{reachCount === 1 ? '' : 's'}
```

   Comment-only, current:

```tsx
      {/* No audience-base line: property sends are ALWAYS tenants (the filter is
          pinned to contact_type:'tenant'; the backend rejects anything else), so
          naming it here told the operator nothing they could act on. */}
```

   Replace with:

```tsx
      {/* No audience-base line: the FILTER reaches tenants only (pinned to
          contact_type:'tenant'; the backend rejects anything else) - a partner
          joins a share only as a hand-picked seed (spec 2026-10-06 D20) - so
          naming it here told the operator nothing they could act on. */}
```

3. `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`, comment-only.
   Current `// ?contactId= (compose to ONE tenant: property step first, then a seeds-only`
   -> `// ?contactId= (compose to ONE contact - a tenant or a partner: property step first, then a seeds-only`.
   `Add more tenants by filters` stays.

4. The e2e pins of this copy (plan review R1 ruling A3; all ASCII, each
   "Current" unique in its file unless the line says otherwise).

   (a) `e2e/tests/dashboard-next/broadcasts.spec.ts:247`. Current:

```ts
    await page.getByRole('button', { name: /^Send to \d+ tenants?$/ }).click();
```

   Replace with:

```ts
    await page.getByRole('button', { name: /^Send to \d+ recipients?$/ }).click();
```

   (b) `e2e/tests/dashboard-next/matching-entry-points.spec.ts:152` and
   `:235` - the same line twice; use the Edit tool with `replace_all: true`.
   Current:

```ts
    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();
```

   Replace with:

```ts
    await page.getByRole('button', { name: /^Send to 1 recipient\b/ }).click();
```

   (c) `e2e/tests/dashboard-next/share-skip-fix.spec.ts:31`. Current:

```ts
const NOTE = 'Flagged tenants you picked stay checked; "Select all" skips the others.';
```

   Replace with:

```ts
const NOTE = 'Flagged recipients you picked stay checked; "Select all" skips the others.';
```

   `share-skip-fix.spec.ts:190`. Current:

```ts
    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();
```

   Replace with:

```ts
    await page.getByRole('button', { name: /^Send to 1 recipient\b/ }).click();
```

   (d) `e2e/tests/dashboard-next/org-lists.spec.ts`, two edits.

   `:349`. Current:

```ts
    await expect(page.getByText('Reaches 2 tenants', { exact: true })).toBeVisible();
```

   Replace with:

```ts
    await expect(page.getByText('Reaches 2 recipients', { exact: true })).toBeVisible();
```

   `:465`. Current:

```ts
    await expect(page.getByText('Reaches 1 tenant', { exact: true })).toBeVisible();
```

   Replace with:

```ts
    await expect(page.getByText('Reaches 1 recipient', { exact: true })).toBeVisible();
```

   Survive unchanged: `/^Send to/` at `broadcasts.spec.ts:191`,
   `a2p-compliance.spec.ts:402`, `e2e/scenarios/steps.ts:1074`.

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/broadcasts` - GREEN. Typecheck
(`cd "W:/tmp/caseworkers"; npm run typecheck`, the e2e workspace included)
exit 0. Lint the four e2e files:
`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/broadcasts.spec.ts e2e/tests/dashboard-next/matching-entry-points.spec.ts e2e/tests/dashboard-next/share-skip-fix.spec.ts e2e/tests/dashboard-next/org-lists.spec.ts`
- no error on an added line.

Pins changed (dashboard): the RecipientPreview / BroadcastComposer /
AudienceFilters lines listed above; e2e: step 4 (a)-(d) (Task 10.4 runs
them).

Commit (stage `dashboard/src/routes/broadcasts/RecipientPreview.tsx`,
`dashboard/src/routes/broadcasts/AudienceFilters.tsx`,
`dashboard/src/routes/broadcasts/BroadcastComposer.tsx`,
`dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`,
`dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`,
`dashboard/src/routes/broadcasts/AudienceFilters.test.tsx`,
`e2e/tests/dashboard-next/broadcasts.spec.ts`,
`e2e/tests/dashboard-next/matching-entry-points.spec.ts`,
`e2e/tests/dashboard-next/share-skip-fix.spec.ts`,
`e2e/tests/dashboard-next/org-lists.spec.ts`)
`feat(caseworkers): composer review and reach say recipients (D20, D22)`.

### Task 9.5 - the Matching list and results say recipients; the results fallback is "Recipient" (D20, D22, ruling R3-F7)

Files: `dashboard/src/routes/broadcasts/broadcastFormat.ts`,
`BroadcastsList.tsx`, `BroadcastResults.tsx` and tests
`broadcastFormat.test.ts`, `BroadcastsList.test.tsx`, `BroadcastResults.test.tsx`.

RED.

1. `dashboard/src/routes/broadcasts/broadcastFormat.test.ts`. Current:

```ts
  it('pluralizes tenant/tenants by count', () => {
    expect(sendReachLabel(1)).toBe('To 1 tenant');
    expect(sendReachLabel(0)).toBe('To 0 tenants');
    expect(sendReachLabel(5)).toBe('To 5 tenants');
  });
```

   Replace with:

```ts
  it('pluralizes recipient/recipients by count (spec 2026-10-06 D20: a seed may be a partner)', () => {
    expect(sendReachLabel(1)).toBe('To 1 recipient');
    expect(sendReachLabel(0)).toBe('To 0 recipients');
    expect(sendReachLabel(5)).toBe('To 5 recipients');
  });
```

   (`audienceSummary`'s `'Tenants'` / `'Tenants - 2-BR - Atlanta'` pins stay -
   D22.)

2. `dashboard/src/routes/broadcasts/BroadcastsList.test.tsx` - a new case
   immediately BEFORE the existing empty-state case. Current:

```ts
  it('shows the empty state when there are no broadcasts', async () => {
```

   Replace with:

```ts
  it('caseworkers D22: the subtitle and the empty state use the neutral share wording', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    expect(await screen.findByText('No sends yet')).toBeInTheDocument();
    expect(screen.getByText('Share a property with a curated set of recipients.')).toBeInTheDocument();
    // The curly quotes render from entities; `.` matches each one.
    expect(
      screen.getByText(
        /^Start one from a property's .Send this property., from a contact's .Properties sent., or with .Send a property.\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the empty state when there are no broadcasts', async () => {
```

3. `dashboard/src/routes/broadcasts/BroadcastResults.test.tsx`. Current:

```ts
  it('falls back to "Tenant" when neither name nor phone resolves (deleted contact)', async () => {
```

   Replace with:

```ts
  it('falls back to "Recipient" when neither name nor phone resolves (deleted contact; D22)', async () => {
```

   and current:

```ts
    expect(within(list).getByText('Tenant')).toBeInTheDocument();
```

   Replace with:

```ts
    expect(within(list).getByText('Recipient')).toBeInTheDocument();
    expect(within(list).queryByText('Tenant')).not.toBeInTheDocument();
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/BroadcastsList.test.tsx src/routes/broadcasts/BroadcastResults.test.tsx`
- RED: "To N tenant(s)"; the old subtitle and empty-state sentence; the
  "Tenant" fallback.

GREEN.

1. `dashboard/src/routes/broadcasts/broadcastFormat.ts`. Current:

```ts
  return `To ${count} ${count === 1 ? 'tenant' : 'tenants'}`;
```

   Replace with:

```ts
  return `To ${count} ${count === 1 ? 'recipient' : 'recipients'}`;
```

   Comment-only (ASCII lines): current
   `/** Reach line for a seeds-only send, where the audience filter says nothing. */`
   -> `/** Reach line for a seeds-only send, where the audience filter says nothing.
 *  Neutral (spec 2026-10-06 D20): a seed may be a tenant or a partner. */`;
   the `audienceSummary` doc current
   ` *  "Tenants - 2-BR - Atlanta Housing". Always leads with "Tenants" (the only`
   ` *  audience M1.8 targets); appends the size + authority narrowers when set. */`
   -> ` *  "Tenants - 2-BR - Atlanta Housing". Always leads with "Tenants": it`
   ` *  summarizes the FILTER, which reaches tenants only (hand-picked partner`
   ` *  seeds are not summarized here - D22); appends the size + authority narrowers when set. */`;
   ` *  a name nor a phone carries neither field (the view renders the "Tenant"`
   -> ` *  a name nor a phone carries neither field (the view renders the "Recipient"`;
   `    // fallbacks (the row handles those itself, incl. the "Tenant" label).`
   -> `    // fallbacks (the row handles those itself, incl. the "Recipient" label).`.

2. `dashboard/src/routes/broadcasts/BroadcastsList.tsx`. Current:

```tsx
          <p className={styles.sub}>Share a property with a curated set of tenants.</p>
```

   Replace with:

```tsx
          <p className={styles.sub}>Share a property with a curated set of recipients.</p>
```

   The empty state (both lines carry curly quotes, written `{"}` below -
   section 0 glyph legend, plan review R1 ruling B3; the two lines hold the
   unique ASCII substrings `Start one from a property&apos;s` and
   `, or with ` - the WHOLE two lines become ASCII, the quotes rendered from
   entities). Current:

```
            Start one from a property&apos;s {"}Send to tenants{"}, from a tenant&apos;s {"}Properties
            sent{"}, or with {"}Send a property{"}.
```

   Replace with:

```tsx
            Start one from a property&apos;s &ldquo;Send this property&rdquo;, from a contact&apos;s
            &ldquo;Properties sent&rdquo;, or with &ldquo;Send a property&rdquo;.
```

3. `dashboard/src/routes/broadcasts/BroadcastResults.tsx`. Current:

```ts
  return { primary: 'Tenant' };
```

   Replace with:

```ts
  return { primary: 'Recipient' };
```

   Comment-only (ASCII lines): current
   `/** A recipient row's identity block: the tenant NAME (primary) + formatted phone`
   -> `/** A recipient row's identity block: the recipient NAME (primary) + formatted phone`;
   ` *  neither a name nor a phone (a deleted contact) the neutral "Tenant" fallback`
   -> ` *  neither a name nor a phone (a deleted contact) the neutral "Recipient" fallback`;
   `/** One recipient row. A contactId row is a link to the tenant's comms; a failed`
   -> `/** One recipient row. A contactId row is a link to the recipient's comms; a failed`;
   `// Each recipient row links to the tenant's contact/comms page (/contacts/:id);`
   -> `// Each recipient row links to the recipient's contact/comms page (/contacts/:id);`.

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/broadcasts` - GREEN. Typecheck exit 0.

Pins changed (dashboard): `broadcastFormat.test.ts:37-40`,
`BroadcastResults.test.tsx:139, 145` (edited above). e2e: none (no spec
asserts "To N tenants", the subtitle, the empty state or the fallback;
`e2e/tests/dashboard-next/broadcasts.spec.ts:6-7` quotes the old subtitle in
a COMMENT - S10 may refresh it).

Commit (stage the six files)
`feat(caseworkers): Matching list and results say recipients (D20, D22)`.

### Task 9.6 - PartnerFile's Properties sent card and Send; the composer opens with a partner seed; selectors.md (D20, rulings R3-F5, R3-F9)

PartnerFile gains the Properties sent card the tenant page has, WITHOUT tour
chips (R3-F5: a converted caseworker's tenant-era sends stay listed, but the
partner page does not link its tenant-era tours), and the card's "+ Send"
(aria-label "Send a property to this partner", plan 3.9) opens
`/broadcasts/new?contactId=<id>` - the seeded composer, which has no type
gate (S6 resolves the partner seed). The card's three data props are
REQUIRED, as `groupThreads*` are (the C13 rule: forgetting the wiring is a
typecheck error).

Files: `dashboard/src/routes/contact/PartnerFile.tsx`,
`dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/files.test.tsx`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`,
`dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`,
`e2e/support/selectors.md`.

RED.

1. `dashboard/src/routes/contact/files.test.tsx`. The existing PartnerFile
   `renderIt` gains the new required props. Current (unique in the file):

```tsx
          groupThreadsTruncated={false}
        />
```

   Replace with:

```tsx
          groupThreadsTruncated={false}
          units={[]}
          listingsSentPending={false}
          listingsSent={[]}
        />
```

   Then S8 Task 8.9's `renderPartner` helper (in
   `describe('PartnerFile - role, organization and staff notes', () => {`)
   gains the same three props in this SAME step (plan review R1 rulings
   A5/B1 - without them its four cases crash on `units.map` and the dashboard
   typecheck fails TS2741). Current (unique in the file - the only
   `onContactUpdated` spread in `files.test.tsx` is Task 8.9's):

```tsx
          groupThreadsTruncated={false}
          {...(onContactUpdated !== undefined && { onContactUpdated })}
        />
```

   Replace with:

```tsx
          groupThreadsTruncated={false}
          units={[]}
          listingsSentPending={false}
          listingsSent={[]}
          {...(onContactUpdated !== undefined && { onContactUpdated })}
        />
```

   Then append at the END of the file (after Task 8.9's
   `describe('PartnerFile - role, organization and staff notes', () => {`
   block's closing `});`, which is the file's last describe after S8):

```tsx

describe('PartnerFile - Properties sent (caseworkers D20)', () => {
  const partner: Contact = {
    contactId: 'P2',
    type: 'partner',
    firstName: 'Cora',
    lastName: 'Reyes',
    status: 'active',
    phone: '+14040100056',
  };

  function renderSent(
    opts: { listingsSentPending?: boolean; listingsSent?: ListingSendRow[]; onSendProperty?: () => void } = {},
  ) {
    return render(
      <MemoryRouter>
        <PartnerFile
          contact={partner}
          phones={[{ phone: '+14040100056', primary: true }]}
          media={[]}
          groupThreadsPending={false}
          groupThreads={[]}
          groupThreadsTruncated={false}
          units={[UNIT]}
          listingsSentPending={opts.listingsSentPending ?? false}
          listingsSent={opts.listingsSent ?? []}
          {...(opts.onSendProperty !== undefined && { onSendProperty: opts.onSendProperty })}
        />
      </MemoryRouter>,
    );
  }

  it('shows the card empty when nothing was sent', () => {
    renderSent();
    expect(screen.getByRole('heading', { name: /^Properties sent/ })).toBeInTheDocument();
    expect(screen.getByText('No properties sent yet.')).toBeInTheDocument();
  });

  it('shows the pending panel while the slice loads', () => {
    renderSent({ listingsSentPending: true });
    const card = screen.getByRole('heading', { name: /^Properties sent/ }).closest('section') as HTMLElement;
    expect(within(card).getByText('Arrives with the backend.')).toBeInTheDocument();
  });

  it('lists each sent property linking to it, WITHOUT a tour chip even when the row carries one (ruling R3-F5)', () => {
    renderSent({
      listingsSent: [
        { contactId: 'P2', unitId: 'u1', sentAt: '2026-07-01T12:00:00.000Z', via: 'broadcast', tour: { tourId: 't-old', state: 'toured' } },
        { contactId: 'P2', unitId: 'u-missing', sentAt: '2026-06-30T12:00:00.000Z', via: 'broadcast' },
      ],
    });
    expect(screen.getByRole('link', { name: '1450 Joseph Blvd, Atlanta, GA' })).toHaveAttribute('href', '/listings/u1');
    // A unit the page did not load falls back to its id.
    expect(screen.getByRole('link', { name: 'u-missing' })).toHaveAttribute('href', '/listings/u-missing');
    expect(screen.queryByRole('link', { name: 'Toured' })).not.toBeInTheDocument();
  });

  it('"+ Send" (aria-label "Send a property to this partner") fires onSendProperty; no action without the handler', async () => {
    const onSendProperty = vi.fn();
    const { unmount } = renderSent({ onSendProperty });
    await userEvent.click(screen.getByRole('button', { name: 'Send a property to this partner' }));
    expect(onSendProperty).toHaveBeenCalledTimes(1);
    unmount();
    renderSent();
    expect(screen.queryByRole('button', { name: 'Send a property to this partner' })).not.toBeInTheDocument();
  });
});
```

   Imports: the file imports `render, screen` from
   `@testing-library/react`; add `within`. Current
   `import { render, screen } from '@testing-library/react';` ->
   `import { render, screen, within } from '@testing-library/react';`.
   (`UNIT`'s address is `{ line1: '1450 Joseph Blvd', city: 'Atlanta', state: 'GA' }`,
   which `formatAddress` renders `1450 Joseph Blvd, Atlanta, GA`.)

2. `dashboard/src/routes/contact/ContactDetail.test.tsx`. Import, current:

```ts
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
```

   Replace with:

```ts
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
```

   Append at the END of the file (after the last top-level describe; if S8
   appended its own, after that):

```tsx

describe('ContactDetail - a partner page sends a property (caseworkers D20)', () => {
  const PARTNER: Contact = {
    contactId: 'p-send',
    type: 'partner',
    firstName: 'Cora',
    lastName: 'Reyes',
    status: 'active',
    phone: '+14045550199',
  };

  function PathProbe(): React.JSX.Element {
    const loc = useLocation();
    return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
  }

  it('shows Properties sent (rows, no tour chip) and "+ Send" opens the composer seeded with the partner', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(PARTNER);
    getContactListingsSent.mockResolvedValue([
      {
        contactId: 'p-send',
        unitId: 'u1',
        sentAt: '2026-07-01T12:00:00.000Z',
        via: 'broadcast',
        tour: { tourId: 't-old', state: 'toured' },
      },
    ]);
    render(
      <MemoryRouter initialEntries={['/contacts/p-send']}>
        <ImageViewerProvider>
          <Routes>
            <Route path="/contacts/:contactId" element={<ContactDetail />} />
            <Route path="/broadcasts/new" element={<div>COMPOSER</div>} />
          </Routes>
        </ImageViewerProvider>
        <PathProbe />
      </MemoryRouter>,
    );
    const heading = await screen.findByRole('heading', { name: /^Properties sent/ });
    const card = heading.closest('section') as HTMLElement;
    expect(await within(card).findByRole('link', { name: '1450 Joseph Blvd' })).toHaveAttribute('href', '/listings/u1');
    expect(within(card).queryByRole('link', { name: 'Toured' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Send a property to this partner' }));
    expect(await screen.findByText('COMPOSER')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?contactId=p-send');
  });
});
```

3. `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx` - a (PIN)
   immediately BEFORE the raw-id fallback case. Current:

```ts
  it('falls back to the raw contactId in the banner when the contact cannot be resolved', async () => {
```

   Replace with:

```ts
  it('(PIN) caseworkers D20: a PARTNER ?contactId= seeds the draft and the banner names the partner (no type gate)', async () => {
    getContact.mockResolvedValue({
      contactId: 'c-partner',
      type: 'partner',
      firstName: 'Cora',
      lastName: 'Reyes',
      phone: '+14040000002',
    });
    const u = userEvent.setup();
    renderComposer('?contactId=c-partner');
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    expect(await screen.findByText('Cora Reyes')).toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({ seedContactIds: ['c-partner'] });
  });

  it('falls back to the raw contactId in the banner when the contact cannot be resolved', async () => {
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact/files.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx -t "Properties sent|partner page sends|PARTNER .contactId"`
- RED: PartnerFile renders no "Properties sent" heading and no "Send a
  property to this partner" button (both files' cases). The composer case is
  a (PIN) and passes.

GREEN.

1. `dashboard/src/routes/contact/PartnerFile.tsx`.
   - Type import. Current
     `import type { Contact, ContactPhone, GroupThreadRow } from '../../api/index.js';`
     -> `import type { Contact, ContactPhone, GroupThreadRow, ListingSendRow, UnitItem } from '../../api/index.js';`
     (if S8 extended this line, add only `ListingSendRow` and `UnitItem`).
   - Card import. Current
     `import { BLANK, Card, CardAction, CardInlineAction, KV, NotesText, PendingPanel } from './Card.js';`
     -> `import { BLANK, Card, CardAction, CardInlineAction, EmptyRow, KV, NotesText, PendingPanel, SendRosterRow } from './Card.js';`
     (same S8 note).
   - Format import. Current `import { contactStatusLabel, formatPhone } from './format.js';`
     -> `import { contactStatusLabel, formatAddress, formatPhone } from './format.js';`.
   - Props: after the interface's `groupThreadsTruncated: boolean;` (the
     line with the type - unique), add:

```ts
  /** caseworkers D20: the units the page loaded (useContactFile, every contact)
   *  - the Properties sent rows' address labels. REQUIRED for the same reason
   *  as the group-threads props: a forgotten wiring is a typecheck error. */
  units: UnitItem[];
  /** C4 listings-sent slice status (the card degrades to pending). */
  listingsSentPending: boolean;
  /** C4 listings-sent rows - the properties shared with this partner. */
  listingsSent: ListingSendRow[];
  /** Open the seeded composer for this partner (Properties sent "+ Send"). */
  onSendProperty?: () => void;
```

   - Destructuring: after `  groupThreadsTruncated,` (the destructured
     line - unique), add:

```ts
  units,
  listingsSentPending,
  listingsSent,
  onSendProperty,
```

   - A module helper immediately BEFORE `export function PartnerFile({`:

```ts
/** A unit's address line (or its id as a last resort) - TenantFile's rule. */
function sentUnitLabel(units: Map<string, UnitItem>, unitId: string): string {
  const unit = units.get(unitId);
  const addr = unit ? formatAddress(unit.address) : '';
  return addr || unitId;
}
```

   - The card, immediately BEFORE the Group threads placement comment.
     Current (unique):

```tsx
      {/* PLACEMENT RULING (C13). "Group threads" is TYPE-AGNOSTIC: a group text
```

     Replace with:

```tsx
      {/* caseworkers D20: a partner can be sent a property directly (the
          normal share, into the partner's own conversation). Rows show NO tour
          chip (ruling R3-F5): a converted caseworker's tenant-era sends stay
          listed, but the partner page does not link that tenant history. */}
      <Card
        title="Properties sent"
        aside={
          onSendProperty ? (
            <CardAction onClick={onSendProperty} label="Send a property to this partner">
              + Send
            </CardAction>
          ) : undefined
        }
      >
        {listingsSentPending ? (
          <PendingPanel />
        ) : listingsSent.length === 0 ? (
          <EmptyRow>No properties sent yet.</EmptyRow>
        ) : (
          listingsSent.map((s) => (
            <SendRosterRow
              key={`${s.unitId}:${s.sentAt}`}
              to={`/listings/${s.unitId}`}
              identity={sentUnitLabel(unitMap, s.unitId)}
            />
          ))
        )}
      </Card>

      {/* PLACEMENT RULING (C13). "Group threads" is TYPE-AGNOSTIC: a group text
```

   - `unitMap`: current (in the function body)
     `  const phoneList = phones.map((p) => formatPhone(p.phone)).join(' - ');`
     -> that line, then `  const unitMap = new Map(units.map((u) => [u.unitId, u]));`.
   - The header comment. Task 8.9 REPLACED the whole header (HEAD's
     "Preferences & notes, and Media from comms" text no longer exists);
     anchor on 8.9's text (plan review R1 ruling A6). Current (one line,
     unique - it is Task 8.9's fourth header line):

```ts
// Preferences & notes, Group threads and Media from comms. Deliberately omits
```

     Replace with:

```ts
// Preferences & notes, Properties sent (+ Send, spec 2026-10-06 D20: a partner
// can be sent a property directly; its rows carry no tour chips, ruling
// R3-F5), Group threads and Media from comms. Deliberately omits
```

2. `dashboard/src/routes/contact/ContactDetail.tsx`. Current (the opening of
   the partner branch's element - `<PartnerFile` occurs once):

```tsx
              <PartnerFile
                contact={contact}
```

   Replace with:

```tsx
              <PartnerFile
                contact={contact}
                units={file.units}
                listingsSentPending={file.listingsSent.status !== 'ready'}
                listingsSent={file.listingsSent.status === 'ready' ? file.listingsSent.rows : []}
                onSendProperty={() =>
                  navigate(`/broadcasts/new?contactId=${encodeURIComponent(contact.contactId)}`)
                }
```

   (The same wiring TenantFile gets a few lines below; no new GET.)

3. `e2e/support/selectors.md`. This task OWNS line 45 (the `| Thread | send |`
   row) and the two share rows below, each with ONE regex (plan review R1
   ruling A7): the Properties sent heading is `/^Properties sent/` and the
   "Sent to" heading `/^Sent to\b/`. Task 10.9 only verifies these three
   rows (skip-if-done) and never adds a second row for either card.
   - The `| Thread | send |` row (the one line starting `| Thread | send |`,
     unique; it contains one em dash after the first code span - Read it and
     replace the WHOLE line, which becomes ASCII). Replace the line with:

```
| Thread | send | `getByRole('button', { name: 'Send', exact: true })` - non-exact name matching is substring-based, so a bare `{ name: 'Send' }` also matches the contact page's "+ Send" Properties sent action - aria-label "Send a property to this tenant" on a tenant page, "Send a property to this partner" on a partner page: a strict-mode violation |
```

   - A new row immediately BEFORE the `| Contact page | Relay groups card heading |`
     row (match `| Contact page | Relay groups card heading |` at the line start):

```
| Contact page | Properties sent card | `getByRole('heading', { name: /^Properties sent/ })` (the heading's name includes its action) - on tenant AND partner pages. Its action: `getByRole('button', { name: 'Send a property to this tenant' })` / `getByRole('button', { name: 'Send a property to this partner' })`, opening `/broadcasts/new?contactId=<id>`. A partner page's rows carry NO tour chip |
```

   - A new row immediately BEFORE the
     `| Tour / placement hub (People card) | edit toggle |` row:

```
| Property page (Sent to card) | heading, action, row label | `getByRole('heading', { name: /^Sent to\b/ })` - the heading's accessible name includes the "+ Send" action's name, so never `exact: true`. The action: `getByRole('button', { name: 'Send this property', exact: true })`; the kebab twin: `getByRole('menuitem', { name: 'Send this property' })`. A row's link is named by the recipient's name; a non-tenant row's kind (`Partner`, a role such as `Caseworker`, `Landlord`) is SIBLING text after the link, never part of its name |
```

Run: `cd "W:/tmp/caseworkers/dashboard"; npx vitest run src/routes/contact src/routes/broadcasts` - GREEN
(Task 8.9's four `PartnerFile - role, organization and staff notes` cases
included).
Then `cd "W:/tmp/caseworkers"; npm run typecheck` - exit 0 (proves the
required props are wired at EVERY `<PartnerFile` site: `ContactDetail.tsx`,
and in `files.test.tsx` the original `renderIt`, Task 8.9's `renderPartner`
and this task's `renderSent` - `git grep -n "<PartnerFile" -- dashboard/src`
lists exactly those four).
ASCII check on `e2e/support/selectors.md`: the added/changed lines of
`git diff -- e2e/support/selectors.md` carry no byte outside 0x20-0x7E.

Pins changed (dashboard): `files.test.tsx` PartnerFile `renderIt` and Task
8.9's `renderPartner` (props added above). Stays: `files.test.tsx:227-262` (TenantFile "Send a property to
this tenant"), `ContactDetail.test.tsx:510` (Unknown page has no "Properties
sent"). e2e: no existing spec drives a partner page's "+ Send"; the four
group-text specs' `{ name: 'Send', exact: true }` already avoid the collision.

Commit (stage `dashboard/src/routes/contact/PartnerFile.tsx`,
`dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/files.test.tsx`,
`dashboard/src/routes/contact/ContactDetail.test.tsx`,
`dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`,
`e2e/support/selectors.md`)
`feat(caseworkers): partner page lists and sends properties (D20)`.

### S9 -> S10 handoff: every e2e pin and doc line the share wording breaks

A RECORD, not a to-do list (plan review R1 ruling A3): each pin below is
edited by the task in its `from` column, in the same commit as the copy it
pins (Task 6.5 step 4; Task 9.1 step 4; Task 9.3; Task 9.4 step 4). S10
Task 10.4 only verifies them (skip-if-done) and runs the pinned tests.
(byte-exact old -> new; prefer `exact: true` on a button name):

| file:line (base) | old | new | from |
|---|---|---|---|
| `e2e/tests/dashboard-next/broadcasts.spec.ts:143` | `getByRole('menuitem', { name: 'Send to tenants' })` | `getByRole('menuitem', { name: 'Send this property' })` | 9.1 |
| `e2e/tests/dashboard-next/broadcasts.spec.ts:247` | `{ name: /^Send to \d+ tenants?$/ }` | `{ name: /^Send to \d+ recipients?$/ }` | 9.4 |
| `e2e/scenarios/steps.ts:1054` | `getByRole('menuitem', { name: 'Send to tenants' })` | `getByRole('menuitem', { name: 'Send this property' })` | 9.1 |
| `e2e/tests/dashboard-next/matching-entry-points.spec.ts:152`, `:235` | `{ name: /^Send to 1 tenant\b/ }` | `{ name: /^Send to 1 recipient\b/ }` | 9.4 |
| `matching-entry-points.spec.ts:206` | `{ name: 'Send this property to tenants' }` | `{ name: 'Send this property', exact: true }` | 9.1 |
| `matching-entry-points.spec.ts:263` | `getByRole('heading', { name: 'Sent to tenants' })` | `getByRole('heading', { name: /^Sent to\b/ })` | 9.1 |
| `e2e/tests/dashboard-next/listing-activity.spec.ts:215` | same heading | same new | 9.1 |
| `listing-activity.spec.ts:143` | `{ name: /Sent to 2 tenants/ }` | `{ name: /Sent to 2 recipients/ }` | 9.3 |
| `e2e/tests/dashboard-next/landlord-activity.spec.ts:122` | `{ name: /Sent to 2 tenants/ }` | `{ name: /Sent to 2 recipients/ }` | 6.5 |
| `e2e/tests/dashboard-next/share-sent-outcome.spec.ts:671` | `{ name: /No tenants reached/ }` | `{ name: /No recipients reached/ }` | 9.3 |
| `e2e/tests/dashboard-next/share-skip-fix.spec.ts:31` | `'Flagged tenants you picked stay checked; "Select all" skips the others.'` | `'Flagged recipients you picked stay checked; "Select all" skips the others.'` | 9.4 |
| `share-skip-fix.spec.ts:190` | `{ name: /^Send to 1 tenant\b/ }` | `{ name: /^Send to 1 recipient\b/ }` | 9.4 |
| `e2e/tests/dashboard-next/org-lists.spec.ts:349` | `getByText('Reaches 2 tenants', { exact: true })` | `getByText('Reaches 2 recipients', { exact: true })` | 9.4 |
| `org-lists.spec.ts:465` | `getByText('Reaches 1 tenant', { exact: true })` | `getByText('Reaches 1 recipient', { exact: true })` | 9.4 |

Comments/titles only (no assertion): `broadcasts.spec.ts:6-7, 140`,
`steps.ts:1051`, `matching-entry-points.spec.ts:13, 16, 203, 260`,
`listing-activity.spec.ts:161, 180, 211`, `share-sent-outcome.spec.ts:27, 621`.
Survive unchanged: `/^Send to/` at `broadcasts.spec.ts:191`,
`a2p-compliance.spec.ts:402`, `steps.ts:1074`; `matching-entry-points.spec.ts:120`
(`'Send a property to this tenant'`, the tenant page).

Docs (S10 owns them; plan review R1 ruling A8): `documentation/GLOSSARY.md:120`
("offers 'Send to tenants'" -> "offers 'Send this property'") - Task 10.10
step 4; `documentation/sequence-diagram-to-test.md:135` ("Send to N
tenant(s)" -> "Send to N recipient(s)") - Task 10.11 step 3.

New e2e coverage for S10's `partner-share.spec.ts` (E2E rule 3: mint a
run-unique CONSENTED partner through the API, never pre-open its
conversation): partner page "+ Send" (`Send a property to this partner`) ->
seeded composer (banner names the partner) -> pick a property -> Preview ->
`Send to 1 recipient` -> the partner page's Properties sent lists the
property (no tour chip) -> the property's "Sent to" card lists the partner
with `Partner` beside the name -> the partner's thread is `partner_1to1`
(read through the API).

## Checkpoint after S9 - the full typecheck and `npm test` (every workspace)

Plan review R1 ruling B10: S7-S9 touch `dashboard/src/api/types.ts` (which
the app compiles), the e2e workspace's pins and fixtures, and many dashboard
suites that only per-file runs have exercised. Run bare from the worktree,
DynamoDB Local up (`npm run db:start`, section 0):
`cd "W:/tmp/caseworkers"; npm run typecheck`, then
`cd "W:/tmp/caseworkers"; npm test`. Both must exit 0 before S10 starts.
Never pipe either. A red DynamoDB-suite file is adjudicated by
re-run-and-compare (AGENTS.md: re-run the failing FILE alone more than once,
run the full suite at the merge base, compare failing FILES), never waved
through; any `[dynamoAdmin]` line in the output is a real container fault -
capture its `err.$metadata.httpStatusCode` and `attempts` first. Nothing to
commit.

## S10 - e2e specs and pins, perf/mutation pins, GLOSSARY, RUNBOOK, selectors.md, e2e README, issues (spec D16-D22, sections 3, 11, 12; planner rulings R4-13, R5-F11..F16, "E2E rules"; plan 3.8, 3.9)

> **Assembly notes (BINDING - they override the task text below where they differ;
> `plan-research/plan-assembly-rulings.md`):**
> - Task 10.1's catalog and profiler steps and Task 10.2's `contact-create.spec.ts:201` step were MOVED into S8 (Tasks 8.1, 8.13; S8-2, S8-3). Task 10.1 is now a verification task (greps and the e2e-workspace unit run; no RED, no edit, never re-create the issue file) and Task 10.2 keeps only its two additions (plan review R1 ruling A16).
> - Task 10.3's e2e fixture types, README dev-seam line and the `org-lists.spec.ts:557-562` usage pin are S5's (S5/S7-5): skip if done.
> - Task 10.4's share-wording pins were MOVED into the tasks that change the copy (Tasks 6.5, 9.1, 9.3, 9.4; plan review R1 ruling A3): Task 10.4 verifies them (skip-if-done) and runs the pinned tests.
> - Task 10.9's partner "Properties sent" row, "Sent to" card row and line 45 are Task 9.6's (plan review R1 ruling A7): Task 10.9 verifies them and adds only the caseworker rows.
> - The dismiss confirm is a Modal named by its first sentence (S8 as built); locate it by that sentence (assembly ruling S10 "dismiss confirm container").
> - The `empty_audience` line is "Nothing selected - check at least one recipient to send." (ASCII hyphen, S6/S9-3).

Read spec D16-D22 and sections 3, 11 and 12; plan 3.8 and 3.9; the planner
rulings' "E2E rules"; `AGENTS.md` "UI testing and verification";
`e2e/README.md` (dev surface) and `e2e/support/selectors.md` first.

### Before Task 10.1

- S1-S9 must be built and committed. Check, each prints at least one line:
  `cd "W:/tmp/caseworkers"; git log --oneline -60`
  `cd "W:/tmp/caseworkers"; ls app/src/routes/caseworkerReview.ts dashboard/src/routes/contacts/CaseworkersList.tsx dashboard/src/routes/contact/CaseworkerDialog.tsx`
  `cd "W:/tmp/caseworkers"; git grep -n "makeCaseworker\|dismissPossibleCaseworker" -- dashboard/src/api/endpoints.ts`
  `cd "W:/tmp/caseworkers"; git grep -n "contacts/caseworkers" -- dashboard/src/App.tsx dashboard/src/app/nav.ts`
  If any is missing, stop and report.
- This slice edits ONLY files under `e2e/`, `documentation/`, `docs/issues/`
  and `RUNBOOK.md` - except Task 10.14, whose main sync merges whatever main
  changed and whose gate fixes may touch source (never while an e2e run is
  live). Never edit app or dashboard source otherwise in this slice (a lane
  serves source live). A test that fails because the app or dashboard
  differs from plan 3.x is a finding for the orchestrator, not something to
  patch here.
- Docker must be running; `npm run db:start` per section 0.
- Expected state at S10 start (plan review R1 ruling A16): the e2e
  workspace's `routes.test.ts` and `mutationCatalog.test.ts` are GREEN (S8
  Tasks 8.1 and 8.13 made the catalog, route-exclusion, TODO, issue-file and
  `contact-create.spec.ts:201` changes - assembly rulings S8-2, S8-3); the
  share-wording e2e pins are already edited (Tasks 6.5, 9.1, 9.3, 9.4 -
  ruling A3); the usage pin is S5's. No existing Playwright spec is known to
  be red: Tasks 10.1, 10.3 and 10.4 VERIFY (skip-if-done), and S10's RED
  evidence is the new specs' own cases (Tasks 10.5-10.8 and 10.8a).

### How to run e2e in this slice

- Only through the e2e workspace, from the worktree root, as a SINGLE npm hop
  (the root `npm run e2e` is a double hop and eats flags):
  `cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- <file>[:line] [<file>...]`
  A `file:line` argument runs the one test declared on that line. Each
  invocation boots a hermetic lane (about a minute), runs, and tears it down.
  It never touches the live ports `:5174` / `:8080`.
- Never pipe or `;`-chain an e2e run into another command; read the list
  reporter's last lines (`N passed` / `N failed`) after it exits.
- After an ABORTED run: `cd "W:/tmp/caseworkers"; npm run e2e:stop`, and
  confirm no listener survives on the lane's ports before the next run
  (`reuseExistingServer` adopts an orphaned stack on a commit match alone).
- e2e-workspace unit tests (the profiler pins):
  `cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/<file>`.
- Typecheck the workspace: `cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e`
  (exit 0). Lint touched files: `cd "W:/tmp/caseworkers"; npx eslint <files>`
  - no error on a line the task ADDED (`steps.ts` may carry pre-existing
  errors: leave them; the final gate attributes by baseline).
- ASCII: for an edited file
  `cd "W:/tmp/caseworkers"; git diff -U0 -- <file> | grep '^+' | grep -nP '[^\x00-\x7F]'`
  prints nothing; for a new file `tr -d '\11\12\15\40-\176' < "<file>" | wc -c`
  prints `0`.

### Selector contract (verify against S8 and S9 before Task 10.5)

S10 relies on these names. Rows marked "3.9" are binding (a difference is an
S8/S9 bug: stop and report). Rows marked "S10 row lists" / "S10 dismiss
confirm container" / an assembly ruling id rest on that ruling in
`plan-assembly-rulings.md` ("S10 writer" items). Rows marked "assumed" are
S10's reading: before Task 10.5 open S8's
`CaseworkersList.tsx`, `CaseworkerDialog.tsx`, `ContactActionsMenu.tsx`,
`UnknownFile.tsx`, `KindPicker.tsx`, `FilterChips.tsx`, and S9's
`PartnerFile.tsx`, `ListingDetail.tsx`, `RecipientPreview.tsx`,
`AudienceFilters.tsx`, `ListingActionsMenu.tsx`, `listingFormat.ts` and the
server's `app/src/routes/contactTimeline.ts`. Where an "assumed" or
ruling-marked name differs as built, change it in the spec's `UI` object only, name the
difference in the commit body, and keep the assertions.

| id | element | locator S10 uses | source |
|---|---|---|---|
| C1 | nav link | `getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Caseworkers', exact: true })` -> `/contacts/caseworkers` | 3.9 |
| C2 | page heading | `getByRole('heading', { name: 'Caseworkers', exact: true })` | 3.9 (+ `exact`, S10 row lists) |
| C3 | caseworker rows | `getByRole('list', { name: 'Caseworkers', exact: true }).getByRole('listitem').filter({ hasText: <full name> })`; the row text holds the organization | S10 row lists |
| C4 | Possible rows | `getByRole('list', { name: 'Possible caseworkers', exact: true }).getByRole('listitem').filter({ hasText: <full name> })`; the row text holds each signal label | S10 row lists |
| C5 | Organization chips | `getByRole('group', { name: 'Organization', exact: true }).getByRole('button', { name: /^<org> \(/ })`; selected = `aria-pressed="true"`; URL param `org` | 3.9 (group, param); chip name = the factored `Chip`'s `<label> (<count>)` (assumed, `TenantFilters.tsx:66`) |
| C6 | Possible row actions | buttons `Make <full name> a caseworker`, `<full name> is not a caseworker` | 3.9 |
| C7 | signal labels | `Role mentions caseworker`, `AI noted caseworker`, `Linked as a caseworker`, `Partner with no role` | 3.9 |
| C8 | dismiss confirm | `page.getByRole('dialog').filter({ hasText: 'Hide <full name> from Possible caseworkers?' })` containing `This can't be undone in the app.`; button `Hide` | 3.9 copy; container S10 dismiss confirm container |
| C9 | header action | `getByRole('button', { name: 'More actions' })` then `getByRole('menuitem', { name: 'Make caseworker', exact: true })` | 3.9 |
| C10 | conversion dialog | `getByRole('dialog', { name: 'Make <full name> a caseworker', exact: true })`; buttons `Make caseworker` (exact; disabled while a refusal shows) and `Cancel`; picker `getByRole('combobox', { name: 'Organization', exact: true })` | 3.9 |
| C11 | preview text | `Housing authority: <x>`, `Agency: <x>`, `/^1 conversation will become (a )?partner conversations?\.$/` | 3.9 (singular S8-4) |
| C12 | refusals | `Finish or close this contact's placement first.` + link `View placement` (href `/placements/<placementId>`); `This contact is the landlord of record for a property. Change that property's landlord first.` + link `View property` (href `/listings/<unitId>`), one per blocking record | 3.9 text; hrefs assumed (the app's routes) |
| C13 | picker chip | `getByRole('button', { name: 'Remove <value>', exact: true })` = `ORG_PICKER.removeChip` | A's OrgPicker (existing) |
| C14 | Unknown card | `locator('section').filter({ has: getByRole('heading', { name: 'Needs triage' }) }).getByRole('button', { name: 'Mark as Caseworker', exact: true })` | 3.9 |
| C15 | KindPicker | `getByRole('group', { name: 'Contact kind' }).getByRole('button', { name: 'Caseworker', exact: true })` | 3.9 |
| C16 | partner card | `locator('section', { has: getByRole('heading', { name: /Properties sent/ }) })`, button `Send a property to this partner` (exact) | 3.9 |
| C17 | composer Send | `getByRole('button', { name: /^Send to 1 recipient\b/ })`, `/^Send to \d+ recipients?$/` | D20 + S6/S9-3 |
| C18 | property "Sent to" card | `locator('section', { has: getByRole('heading', { name: /^Sent to\b/ }) })` - the heading's name is the title PLUS the aside's label (Card renders the aside inside the `<h3>`, `selectors.md:37`), so `{ name: 'Sent to', exact: true }` finds nothing; a non-tenant row's label (role, else `Partner`) is text inside the card | D22 |
| C19 | share action | kebab `getByRole('menuitem', { name: 'Send this property', exact: true })`; card `getByRole('button', { name: 'Send this property', exact: true })` | D22 |
| C20 | share wording | `Sent to <n> recipient(s)`, `No recipients reached`, `Reaches <n> recipient(s)`, `Flagged recipients you picked stay checked; "Select all" skips the others.` | D22 + S6/S9-3 |

### Isolation rules for this slice (planner rulings, "E2E rules" - binding)

1. Assert only rows a spec created with a run-unique stamp; never a count,
   never an empty state, on the Possible list or the Caseworkers tab.
2. Never convert or dismiss a seeded contact. Tasha Nguyen
   (`contact-tenant-0001`, open `placement-0001`) and Marcus Bell
   (`contact-landlord-0001`, landlord of record of `unit-0001` and
   `unit-0002`) are READ-ONLY refusal fixtures: their dialogs are cancelled,
   and their refusals are read through the GET preview, never a POST.
3. The share e2e mints its own consented partner and never calls
   `POST /api/contacts/:id/conversation` before the share.
4. The household-phone case is unit/integration only (contacts POST refuses
   a held phone, `app/src/routes/contacts.ts:1059-1085`).
5. Every organization name a spec adds is run-unique and added through
   `addOrg` (`e2e/fixtures/orgFixture.ts`); starting-list entries are only
   read.

### Task 10.1 - VERIFY the profiler pins and the mutation catalog (S8 made them; no RED, no edit)

Plan review R1 ruling A16: S8 Task 8.1 added the two mutation-catalog
entries and bumped the count pin 118 -> 120 (assembly ruling S8-2); S8 Task
8.13 added `/contacts/caseworkers` to the route pin's `excluded` set, the
`TODO(perf-pages-contacts-caseworkers-surface)` comment in `routes.ts`, the
README line and the issue file (S8-3). This task only PROVES that is in
place. It writes nothing and commits nothing. Never re-create the issue
file, never add a second catalog entry (a duplicate trips
`mutationCatalog.test.ts`'s fingerprint uniqueness) and never add a second
TODO.

Step 1 - the greps (each from `cd "W:/tmp/caseworkers"`):

- `git grep -n "'/contacts/caseworkers'," -- e2e/performance/routes.test.ts`
  prints exactly ONE line (the `excluded` entry).
- `git grep -n "TODO(perf-pages-contacts-caseworkers-surface)" -- e2e/performance/routes.ts`
  prints exactly ONE line.
- `git grep -n "'makeCaseworker'" -- e2e/performance/mutationCatalog.ts` and
  `git grep -n "'dismissPossibleCaseworker'" -- e2e/performance/mutationCatalog.ts`
  print exactly ONE line each.
- `git grep -n "toHaveLength(120)" -- e2e/performance/mutationCatalog.test.ts`
  prints exactly ONE line.
- `ls docs/issues/perf-pages-contacts-caseworkers-surface.md` lists the file.

Step 2 - the unit runs:

`cd "W:/tmp/caseworkers/e2e"; npx vitest run performance/routes.test.ts performance/mutationCatalog.test.ts`
-> `0 failed`; then `cd "W:/tmp/caseworkers/e2e"; npx vitest run` -> `0 failed`
(the whole e2e workspace unit suite). Then `cd "W:/tmp/caseworkers"; npm run issues`
-> lists `perf-pages-contacts-caseworkers-surface` as open, no warning naming
it (`docs/issues/INDEX.md` is gitignored: never stage it).

Any grep that prints zero or two lines, or any red run: STOP and report to
the orchestrator - it is an S8 defect (Tasks 8.1 / 8.13), not something to
patch in this slice. Nothing to commit when all pass.

### Task 10.2 - the nav pins: the frame's nav list and the Caseworker preset (the contact-create relationship fix is S8's)

Files: `e2e/tests/dashboard-next/contact-create.spec.ts`,
`e2e/tests/dashboard-next/frame.spec.ts`.
Made pass by: S8 (the always-visible "Caseworkers" Workspace nav link, the
KindPicker's "Caseworker" segment, `/contacts/caseworkers`). Planner ruling
R5-F11.

This task is PIN-only (section 0): both additions are green on arrival -
S8 built the behavior they pin. It makes no RED claim (plan review R1
ruling A16).

Step 1 - skip-if-done check (S8 Task 8.13 GREEN (i) scoped
`contact-create.spec.ts:201`): `cd "W:/tmp/caseworkers"; git grep -n "relationshipsCard.getByText('Caseworker', { exact: true })" -- e2e/tests/dashboard-next/contact-create.spec.ts`
prints one line, and `git grep -n "await expect(page.getByText('Caseworker')).toBeVisible();" -- e2e/tests/dashboard-next/contact-create.spec.ts`
prints nothing. If not: stop and report (an S8 defect). Do not edit `:201`
here.

Step 2 - add the Caseworker preset test. Current (unique; the end of the
Property Manager preset test):

```ts
    // It lives under the Landlords filter (it is landlord-typed).
    await page.goto(`${NEXT}/contacts/landlords`);
    await expect(page.getByText(fullName)).toBeVisible();
  });
```

Replace with:

```ts
    // It lives under the Landlords filter (it is landlord-typed).
    await page.goto(`${NEXT}/contacts/landlords`);
    await expect(page.getByText(fullName)).toBeVisible();
  });

  test('creates a Caseworker via the preset (partner + role, under Caseworkers)', async ({
    page,
  }) => {
    const stamp = Date.now();
    const lastName = `Cwpreset ${stamp}`;
    const fullName = `Casey ${lastName}`;

    await devLogin(page);
    await page.goto(`${NEXT}/contacts`);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: /New contact/i });
    await expect(dialog).toBeVisible();

    // The Caseworker preset is the partner base with the exact role
    // "Caseworker" (caseworkers spec D16) - like Property Manager it opens no
    // "Other" panel, and the create form offers no Organization (staff set it
    // on the partner page).
    await dialog
      .getByRole('group', { name: 'Contact kind' })
      .getByRole('button', { name: 'Caseworker', exact: true })
      .click();
    await expect(dialog.getByLabel('Role')).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: 'Organization', exact: true })).toHaveCount(0);

    await dialog.getByLabel('First name').fill('Casey');
    await dialog.getByLabel('Last name').fill(lastName);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/contacts\/[A-Za-z0-9_-]+$/);

    // Stored as a partner with the preset role.
    const contactId = page.url().split('/').pop()!;
    const res = await page.request.get(`${NEXT}/api/contacts/${contactId}`);
    expect(res.ok()).toBeTruthy();
    const { contact } = (await res.json()) as { contact: { type?: string; role?: string } };
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    // Badged "Caseworker" (role ?? type).
    await expect(page.getByText('Caseworker', { exact: true }).first()).toBeVisible();

    // It lives under Contacts > Caseworkers. Exact: "Possible caseworkers"
    // contains the same word.
    await page.goto(`${NEXT}/contacts/caseworkers`);
    await expect(
      page
        .getByRole('list', { name: 'Caseworkers', exact: true })
        .getByRole('listitem')
        .filter({ hasText: fullName }),
    ).toBeVisible();
  });
```

Step 3 - `frame.spec.ts:26`. Current (unique):

```ts
  for (const label of ['Today', 'Placements', 'Tours', 'Contacts', 'Tenants', 'Landlords', 'Unknown', 'Properties']) {
```

Replace with:

```ts
  for (const label of ['Today', 'Placements', 'Tours', 'Contacts', 'Tenants', 'Landlords', 'Caseworkers', 'Unknown', 'Properties']) {
```

Step 4 - GREEN (both additions are PINs):

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/contact-create.spec.ts e2e/tests/dashboard-next/frame.spec.ts`
-> no error on an added line.

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/contact-create.spec.ts tests/dashboard-next/frame.spec.ts`
-> `0 failed` (contact-create: its 6 tests plus the new one; frame: all).
Both additions are PINs of S8 (green on arrival).

ASCII check on both files' added lines (`contact-create.spec.ts:197` is a
pre-existing non-ASCII comment: do not touch it).

Commit `test(e2e): the nav list and the Caseworker preset` (stage the two spec files).

### Task 10.3 - the organization usage wire pin, the fixture types and the dev-seam README line

Files: `e2e/fixtures/orgFixture.ts`, `e2e/tests/dashboard-next/org-lists.spec.ts`,
`e2e/README.md`.
Made pass by: S5 (usage gains `organization`, `inUse`, `kindLocked`; the dev
seam accepts `organization`). Planner rulings R5-F12, R5-F13, R2-F1; assembly ruling S5/S7-5.

Step 1 - skip-if-done check FIRST (assembly ruling S5/S7-5: S5 Task 5.3
step 4 edits `OrgUsageWire` and the `org-lists.spec.ts` usage pin, S5 Task
5.7 edits `OrgRecordField`, the README dev-seam line and the selectors row;
the S10 start state - plan review R1 ruling A16 - says so). From
`cd "W:/tmp/caseworkers"`:
`git grep -n "kindLocked: { active: 3, deleted: 0 }" -- e2e/tests/dashboard-next/org-lists.spec.ts`,
`git grep -n "'organization'" -- e2e/fixtures/orgFixture.ts` and
`git grep -n "housingAuthority|agency|organization" -- e2e/README.md` each
print at least one line -> S5 did Steps 2-4: skip them, run only Step 5's
e2e command as a VERIFICATION (`0 failed`) and commit nothing. Only when a
grep prints nothing does that step below apply - and then it is an S5 gap:
make the edit, and name it in the commit body. No RED run: with S5 in, the
usage pin is already green.

Step 2 - `e2e/fixtures/orgFixture.ts` (skip any edit S5 already made:
`git grep -n "'organization'" -- e2e/fixtures/orgFixture.ts`).

Current (`:23-24`):

```ts
/** The record fields an organization name lives in (plan 3.2 OrgRecordField). */
export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';
```

Replace with:

```ts
/** The record fields an organization name lives in (plan 3.2 OrgRecordField;
 *  caseworkers adds a contact's `organization`, checked against BOTH kinds). */
export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'organization';
```

Current (`:53-57`):

```ts
/** Use counts per entry (plan 3.4 OrgUsage), keyed by orgId. */
export type OrgUsageWire = Record<
  string,
  { tenants: number; otherContacts: number; properties: number; deleted: number }
>;
```

Replace with:

```ts
/** Use counts per entry (plan 3.4 OrgUsage), keyed by orgId. The five
 *  per-field columns are for display; `inUse` (any field: Delete) and
 *  `kindLocked` (the entry's own kind's fields: Change kind) count DISTINCT
 *  records (caseworkers spec D22). */
export type OrgUsageWire = Record<
  string,
  {
    tenants: number;
    otherContacts: number;
    properties: number;
    organization: number;
    deleted: number;
    inUse: { active: number; deleted: number };
    kindLocked: { active: number; deleted: number };
  }
>;
```

(`NotOnListRowWire.field` is typed `OrgRecordField`, so organization rows
type-check with no further edit.)

Step 3 - `org-lists.spec.ts:556-562`. Current (unique):

```ts
    // What uses the entry, counted per kind of record (D3, D10).
    expect((await getOrgUsage(req))[entry.orgId]).toEqual({
      tenants: 2,
      otherContacts: 0,
      properties: 1,
      deleted: 0,
    });
```

Replace with:

```ts
    // What uses the entry, counted per kind of record (D3, D10), plus the
    // caseworkers additions (D22): no caseworker's organization holds it, and
    // the two distinct-record totals count the 2 tenants and the property.
    expect((await getOrgUsage(req))[entry.orgId]).toEqual({
      tenants: 2,
      otherContacts: 0,
      properties: 1,
      organization: 0,
      deleted: 0,
      inUse: { active: 3, deleted: 0 },
      kindLocked: { active: 3, deleted: 0 },
    });
```

Step 4 - `e2e/README.md` dev surface (skip if S5 already did it:
`grep -n "housingAuthority|agency|organization" e2e/README.md`). Current
(`:598-602`, ASCII):

```md
- `POST /__dev/org-fixture` - plant a RAW organization value on a record the
  spec created, bypassing the org-list check: `{ contactId, field:
  housingAuthority|agency, value }` SETs it, `{ unitId, field:
  accepted_authorities, value }` appends it. The only way to put a run-unique
  value under Settings > "Not on the list" - nothing off-list is seeded.
```

Replace with:

```md
- `POST /__dev/org-fixture` - plant a RAW organization value on a record the
  spec created, bypassing the org-list check: `{ contactId, field:
  housingAuthority|agency|organization, value }` SETs it, `{ unitId, field:
  accepted_authorities, value }` appends it. The only way to put a run-unique
  value under Settings > "Not on the list" - nothing off-list is seeded (an
  `organization` value lists as an organization row: Use, Add as new with a
  kind, or Clear).
```

(`e2e/support/selectors.md:111`'s dev-seam row names no field list and needs
no change.)

Step 5 - GREEN:

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

`cd "W:/tmp/caseworkers"; npx eslint e2e/fixtures/orgFixture.ts e2e/tests/dashboard-next/org-lists.spec.ts`
-> no error on an added line.

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/org-lists.spec.ts`
-> `0 failed` (every org-lists test: the usage UI's "Used by" cell still
contains `2 tenants` / `1 property`, and the "Not on the list" rows are
filtered by run-unique values).

ASCII check on the three files' added lines.

Commit `test(e2e): the organization usage wire and fixture types gain organization, inUse and kindLocked`.

### Task 10.4 - VERIFY the share-wording pins (recipients, "Send this property", "Sent to") - skip-if-done

Files (edited by Tasks 6.5, 9.1, 9.3 and 9.4 - this task only reads them
unless Step 1 finds a missed pin): `e2e/tests/dashboard-next/broadcasts.spec.ts`, `e2e/scenarios/steps.ts`,
`e2e/tests/dashboard-next/matching-entry-points.spec.ts`,
`e2e/tests/dashboard-next/share-skip-fix.spec.ts`,
`e2e/tests/dashboard-next/listing-activity.spec.ts`,
`e2e/tests/dashboard-next/landlord-activity.spec.ts`,
`e2e/tests/dashboard-next/share-sent-outcome.spec.ts`,
`e2e/tests/dashboard-next/org-lists.spec.ts`.
Made pass by: S9 (the dashboard wording: RecipientPreview, AudienceFilters,
ListingActionsMenu, ListingDetail, listingFormat) and S6 (the landlord
timeline's two label sites in `app/src/routes/contactTimeline.ts`). Planner
rulings R3-F1, R5-F4, R5-F5; assembly ruling S6/S9-3. Every share label keeps the "Sent to "
prefix, so the prefix regexes at `a2p-compliance.spec.ts:402`,
`broadcasts.spec.ts:191` and `steps.ts:1074` (`/^Send to/`) stay as they
are; "Add a tenant", "Add more tenants by filters" and "Send a property to
this tenant" (`matching-entry-points.spec.ts:120,227`) are tenant-worded on
purpose (D22) and stay.

Plan review R1 ruling A3: every pin this task used to edit now moves with
its copy - `landlord-activity.spec.ts:122` in Task 6.5 (step 4);
`broadcasts.spec.ts:140-143`, `steps.ts:1051-1054`,
`matching-entry-points.spec.ts:13-16, 203-206, 260-264` and
`listing-activity.spec.ts:161, 180, 211-216` in Task 9.1 (step 4);
`listing-activity.spec.ts:143` and `share-sent-outcome.spec.ts:27, 621, 671`
in Task 9.3; `broadcasts.spec.ts:247`, `matching-entry-points.spec.ts:152,
235`, `share-skip-fix.spec.ts:31, 190` and `org-lists.spec.ts:349, 465` in
Task 9.4 (step 4). This task proves none was missed and runs the pinned
tests. No RED claim.

Step 1 - prove nothing stale is left:

`cd "W:/tmp/caseworkers"; git grep -n -E "(Send|Sent) to (tenants|[^ ]+ tenants?)|No tenants reached|Flagged tenants|Reaches [0-9]+ tenant|Send this property to tenants" -- e2e`
-> prints nothing. (Before the moved edits it printed 26 lines - the pins
and comments those tasks edit; checked against `feat/caseworkers` @a6ce07e9.)
If it prints a line: that pin was missed by its owning task - apply the
"Current" -> "Replace with" pair that task quotes for it (Task 6.5 step 4,
Task 9.1 step 4, Task 9.3, Task 9.4 step 4), then continue; name the missed
pin and its owning task in the commit body (Step 3).

Step 2 - run the pinned tests, in the BACKGROUND (Bash tool
`run_in_background: true`; about 15 minutes):

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/broadcasts.spec.ts:96 tests/dashboard-next/broadcasts.spec.ts:231 tests/dashboard-next/landlord-activity.spec.ts:67 tests/dashboard-next/listing-activity.spec.ts:85 tests/dashboard-next/listing-activity.spec.ts:162 tests/dashboard-next/matching-entry-points.spec.ts:103 tests/dashboard-next/matching-entry-points.spec.ts:192 tests/dashboard-next/share-skip-fix.spec.ts:156 tests/dashboard-next/share-sent-outcome.spec.ts:621 tests/dashboard-next/org-lists.spec.ts:309 tests/dashboard-next/org-lists.spec.ts:438 tests/scenarios/sending-unit.spec.ts`

-> `0 failed`. (Line numbers are the base's: every moved edit above a test
is line-for-line or below it, so each `file:line` still names the same test.
If a run reports that no test matched, find the test's current line by its
title with `git grep -n` and re-run.) A failure: diagnose it against plan
3.9's share wording - a copy mismatch is an S6/S9 finding (stop and report);
a pin the owning task missed is fixed as in Step 1.

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

Step 3 - commit ONLY if Step 1 or Step 2 changed a file (stage those spec
files explicitly; ASCII check on their added lines):
`test(e2e): share pins a moved task missed (caseworkers D20, D22)`.
Otherwise nothing to commit.

### Task 10.5 - caseworkers.spec.ts, part 1: the conversion from a contact page, and the read-only refusals

File: `e2e/tests/dashboard-next/caseworkers.spec.ts` (new).
Made pass by: S3 + S4 (the conversion, its preview and refusals, the PATCH
409), S5 (organization accepted), S8 (More actions, the dialog, the
Caseworkers page, header facts). (PIN: plan section 0 lets an e2e task that
covers behavior its slices already proved with unit tests be PIN-only; the
non-vacuity check in Step 3 stands in for RED.)

Step 1 - conform rows C1-C13 of the selector contract to S8's source (see
"Selector contract"); every name lives in the `UI` block below.

Step 2 - create the file with exactly:

```ts
// e2e/tests/dashboard-next/caseworkers.spec.ts
//
// Caseworkers (tracker #19; design
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md,
// branch B, D16-D22), end to end against the real backend:
//   1. the caseworker conversion from a contact page: More actions > Make
//      caseworker, the dialog's read-only preview, Confirm; the contact, its
//      re-typed thread, and the Caseworkers tab row with its Organization chip;
//   2. the conversion's refusals, READ-ONLY, on two seeded contacts: Tasha
//      Nguyen (open placement) and Marcus Bell (landlord of record);
//   3. the Possible caseworkers list: one row per signal, Make caseworker from
//      a row, and Not a caseworker;
//   4. the Unknown card's Mark as Caseworker on an inbound-created unknown
//      contact, accepting the AI's partner suggestion.
//
// dashboard-next dialect (e2e/support/selectors.md). ISOLATION (planner
// rulings, "E2E rules"): every contact a test converts or dismisses is one it
// created with a run-unique name; seeded contacts are only READ (Tasha and
// Marcus are refused, so their dialogs are cancelled and their refusals are
// read through the GET preview, never a POST); no test asserts a count or an
// empty state on the Possible list or the Caseworkers tab - every spec in the
// lane adds rows there (contact-create's "Case worker <stamp>" tenants among
// them). The one reseed in beforeAll makes the two refusal fixtures
// deterministic (placement-0001 open, Marcus the landlord of unit-0001 and
// unit-0002); a reseed logs the browser out, and every test signs in.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { ORG_PICKER } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
/** Lean seed: a tenant with an OPEN placement (placement-0001). Read-only. */
const TASHA = { contactId: 'contact-tenant-0001', name: 'Tasha Nguyen' };
/** Lean seed: the landlord of record of unit-0001 and unit-0002. Read-only. */
const MARCUS = { contactId: 'contact-landlord-0001', name: 'Marcus Bell' };
const ATLANTA = 'Atlanta Housing Authority';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every accessible name and copy string this spec uses - the S10 selector
 * contract (plan 3.9; the plan's assembly rulings on the row lists, the
 * dismiss confirm container and the singular dialog sentences). When S8's as-built name
 * differs from a non-binding row, change it HERE only.
 */
const UI = {
  workspaceNav: 'Workspace',
  navLink: 'Caseworkers',
  pageHeading: 'Caseworkers',
  rowsList: 'Caseworkers',
  possibleList: 'Possible caseworkers',
  orgChips: 'Organization',
  orgChip: (org: string): RegExp => new RegExp(`^${escapeRegExp(org)} \\(`),
  moreActions: 'More actions',
  makeMenuItem: 'Make caseworker',
  dialog: (name: string): string => `Make ${name} a caseworker`,
  anyDialog: /^Make .+ a caseworker$/,
  confirm: 'Make caseworker',
  cancel: 'Cancel',
  orgPicker: 'Organization',
  removesHousingAuthority: (value: string): string => `Housing authority: ${value}`,
  removesAgency: (value: string): string => `Agency: ${value}`,
  retypesOne: /^1 conversation will become (a )?partner conversations?\.$/,
  refusalPlacement: "Finish or close this contact's placement first.",
  refusalLandlord:
    "This contact is the landlord of record for a property. Change that property's landlord first.",
  viewPlacement: 'View placement',
  viewProperty: 'View property',
  caseworkerBadge: 'Caseworker',
};

/** Sign in as the seeded VA (the "Continue as dev user" identity). */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

/** POST /api/contacts (a NEW contact: the POST takes type, role, notes and
 *  relationships; it ignores the org fields). Returns the contactId. */
async function createContact(request: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts`, { data });
  expect(res.ok(), `create ${String(data['firstName'])}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** PATCH /api/contacts/:id - the org fields go through the D5 check here. */
async function patchContact(
  request: APIRequestContext,
  contactId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${NEXT}/api/contacts/${contactId}`, { data });
  expect(res.ok(), `patch ${contactId}: ${await res.text()}`).toBeTruthy();
}

async function readContact(request: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `read contact ${contactId}`).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

/** POST /api/contacts/:id/conversation is ensureContactConversation: it
 *  RETURNS the contact's open 1:1 thread, minting one by contact type only
 *  when there is none. Every caller here reads a thread that already exists
 *  (or, the first call in the conversion test, deliberately mints the
 *  tenant thread the conversion must re-type). */
async function readConversationType(request: APIRequestContext, contactId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), `resolve conversation ${contactId}`).toBeTruthy();
  return ((await res.json()) as { conversation: { type: string } }).conversation.type;
}

interface PreviewWire {
  alreadyCaseworker: boolean;
  refusals: Array<Record<string, string>>;
}

/** GET /api/contacts/:id/caseworker-review/preview - read-only (plan 3.5). */
async function readPreview(request: APIRequestContext, contactId: string): Promise<PreviewWire> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}/caseworker-review/preview`);
  expect(res.ok(), `preview ${contactId}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as PreviewWire;
}

/** Open the conversion dialog from the contact page's More actions menu. */
async function openMakeCaseworker(page: Page, contactId: string, name: string): Promise<Locator> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await page.getByRole('button', { name: UI.moreActions }).click();
  await page.getByRole('menuitem', { name: UI.makeMenuItem, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: UI.dialog(name), exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Contacts > Caseworkers through the Workspace nav link (D18). */
async function openCaseworkersTab(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: UI.workspaceNav })
    .getByRole('link', { name: UI.navLink, exact: true })
    .click();
  await expect(page).toHaveURL(/\/contacts\/caseworkers(\?|$)/);
  await expect(page.getByRole('heading', { name: UI.pageHeading, exact: true })).toBeVisible();
}

/** A caseworker row on the Caseworkers tab, by a run-unique full name. */
function caseworkerRow(page: Page, name: string): Locator {
  return page
    .getByRole('list', { name: UI.rowsList, exact: true })
    .getByRole('listitem')
    .filter({ hasText: name });
}

/** A Possible caseworkers row, by a run-unique full name. */
function possibleRow(page: Page, name: string): Locator {
  return page
    .getByRole('list', { name: UI.possibleList, exact: true })
    .getByRole('listitem')
    .filter({ hasText: name });
}

test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test.describe('Caseworkers - the conversion from a contact page', () => {
  test('More actions > Make caseworker converts a tenant; the Caseworkers tab lists it under its organization', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const agency = `Quillwort Family Services ${stamp}`;
    const lastName = `Cwkconv${stamp}`;
    const name = `Convert ${lastName}`;

    await addOrg(req, { kind: 'agency', name: agency });
    const contactId = await createContact(req, {
      type: 'tenant',
      firstName: 'Convert',
      lastName,
      phone: uniquePhone(),
    });
    await patchContact(req, contactId, { housingAuthority: ATLANTA, agency });
    // The tenant's own 1:1 thread, minted here as tenant_1to1 - the thread the
    // conversion must re-type (D21).
    expect(await readConversationType(req, contactId)).toBe('tenant_1to1');

    // The contacts PATCH never makes a caseworker (D16): 409, nothing written.
    const refused = await req.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { type: 'partner', role: 'Caseworker' },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe('caseworker_use_conversion');
    expect(await readContact(req, contactId)).toMatchObject({ type: 'tenant' });

    const dialog = await openMakeCaseworker(page, contactId, name);
    // The read-only preview: what the conversion removes, the thread it
    // re-types, and the organization it would write - the agency, a list
    // match (D19: the agency wins over the housing authority).
    await expect(dialog.getByText(UI.removesHousingAuthority(ATLANTA), { exact: true })).toBeVisible();
    await expect(dialog.getByText(UI.removesAgency(agency), { exact: true })).toBeVisible();
    await expect(dialog.getByText(UI.retypesOne)).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: UI.orgPicker, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: ORG_PICKER.removeChip(agency), exact: true })).toBeVisible();

    const confirm = dialog.getByRole('button', { name: UI.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);

    // The page re-renders as a partner file, badged "Caseworker", with the
    // organization in the header facts (D22).
    await expect(page.getByText(UI.caseworkerBadge, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(agency).first()).toBeVisible();
    // The offer is gated on the STORED contact: a caseworker gets no Make caseworker.
    await page.getByRole('button', { name: UI.moreActions }).click();
    await expect(page.getByRole('menuitem', { name: UI.makeMenuItem, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // One write: the new identity, the removed values kept on the record
    // (D19 step 1), and the thread re-typed (step 3).
    const contact = await readContact(req, contactId);
    expect(contact).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      organization: agency,
      agency: '',
      caseworker_conversion: { fromType: 'tenant', housingAuthority: ATLANTA, agency },
    });
    expect(contact['housingAuthority']).toBeUndefined();
    expect(await readConversationType(req, contactId)).toBe('partner_1to1');

    // Contacts > Caseworkers: the row with its organization, gone from the
    // Possible list, and found by its Organization chip (URL param `org`).
    await openCaseworkersTab(page);
    const row = caseworkerRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agency);
    await expect(possibleRow(page, name)).toHaveCount(0);
    const chip = page
      .getByRole('group', { name: UI.orgChips, exact: true })
      .getByRole('button', { name: UI.orgChip(agency) });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]org=/);
    await expect(row).toBeVisible();
  });

  test('the refusals show read-only on seeded contacts: an open placement and a landlord of record', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;

    // The preview is a GET: it computes the refusals and writes nothing.
    const tasha = await readPreview(req, TASHA.contactId);
    expect(tasha.alreadyCaseworker).toBe(false);
    expect(tasha.refusals).toContainEqual({ code: 'caseworker_open_placement', placementId: 'placement-0001' });
    const marcus = await readPreview(req, MARCUS.contactId);
    expect(marcus.refusals).toContainEqual({ code: 'caseworker_landlord_of_record', unitId: 'unit-0001' });

    // Tasha: the open-placement sentence links the placement; Make caseworker
    // stays disabled (R4-09); Cancel writes nothing.
    let dialog = await openMakeCaseworker(page, TASHA.contactId, TASHA.name);
    await expect(dialog.getByText(UI.refusalPlacement)).toBeVisible();
    await expect(dialog.getByRole('link', { name: UI.viewPlacement }).first()).toHaveAttribute(
      'href',
      '/placements/placement-0001',
    );
    await expect(dialog.getByRole('button', { name: UI.confirm, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: UI.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Marcus: one landlord-of-record sentence per blocking property (two in
    // the lean world - and more if a spec gave him another unit): first only.
    dialog = await openMakeCaseworker(page, MARCUS.contactId, MARCUS.name);
    await expect(dialog.getByText(UI.refusalLandlord).first()).toBeVisible();
    await expect(dialog.getByRole('link', { name: UI.viewProperty }).first()).toHaveAttribute(
      'href',
      /^\/listings\/[^/]+$/,
    );
    await expect(dialog.getByRole('button', { name: UI.confirm, exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: UI.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Nothing was written to either seeded contact.
    expect(await readContact(req, TASHA.contactId)).toMatchObject({ type: 'tenant' });
    expect(await readContact(req, MARCUS.contactId)).toMatchObject({ type: 'landlord' });
  });
});
```

Step 3 - non-vacuity (stands in for RED; revert afterwards):

(a) Temporarily change the conversion test's final thread assertion
`expect(await readConversationType(req, contactId)).toBe('partner_1to1');`
to `.toBe('tenant_1to1')` (the pre-B world) and run:

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts`

Expected: `1 failed` (that test, at that line, `Received: "partner_1to1"`),
`1 passed`. Any other failure: diagnose against the selector contract (an
"assumed" or "S10 ruling" name -> fix it in `UI` and re-run; a 3.9 name -> stop and
report).

(b) Revert the edit: `cd "W:/tmp/caseworkers"; git diff -- e2e/tests/dashboard-next/caseworkers.spec.ts`
shows nothing but the new file (it is untracked, so check the line by eye:
`grep -n "toBe('tenant_1to1')" e2e/tests/dashboard-next/caseworkers.spec.ts`
prints exactly ONE line - the pre-conversion read).

Step 4 - GREEN:

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/caseworkers.spec.ts` -> no error.

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts`
-> `2 passed`, `0 failed`.

`cd "W:/tmp/caseworkers"; tr -d '\11\12\15\40-\176' < "e2e/tests/dashboard-next/caseworkers.spec.ts" | wc -c` -> `0`.

Commit `test(e2e): caseworkers spec - the conversion from a contact page, and read-only refusals`.

### Task 10.6 - caseworkers.spec.ts, part 2: the Possible caseworkers list

File: `e2e/tests/dashboard-next/caseworkers.spec.ts`.
Made pass by: S3 (`listPossibleCaseworkers`, signals per D22, dismiss), S4
(the routes), S8 (the Possible list rows, the dialog, the dismiss confirm).
(PIN, as Task 10.5.)

Step 1 - conform rows C4, C6-C8 to S8's `CaseworkersList.tsx`.

Step 2 - extend `UI`. Current (unique):

```ts
  viewProperty: 'View property',
  caseworkerBadge: 'Caseworker',
};
```

Replace with:

```ts
  viewProperty: 'View property',
  caseworkerBadge: 'Caseworker',
  makeRow: (name: string): string => `Make ${name} a caseworker`,
  dismissRow: (name: string): string => `${name} is not a caseworker`,
  dismissQuestion: (name: string): string => `Hide ${name} from Possible caseworkers?`,
  dismissWarning: "This can't be undone in the app.",
  hide: 'Hide',
  signal: {
    roleMentions: 'Role mentions caseworker',
    aiNote: 'AI noted caseworker',
    relationship: 'Linked as a caseworker',
    partnerNoRole: 'Partner with no role',
  },
};
```

Step 3 - append at the end of the file:

```ts
test.describe('Caseworkers - the Possible caseworkers list', () => {
  test('one row per signal; Make caseworker from a row; Not a caseworker hides a row for good', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const lastName = `Pcw${stamp}`;
    const full = (first: string): string => `${first} ${lastName}`;

    // One run-unique contact per signal (D19, D22), plus three that must be
    // on NEITHER list. All through the real POST: no seed, no dev seam.
    const mentions = await createContact(req, {
      type: 'tenant',
      firstName: 'Mentions',
      lastName,
      role: `Case Manager ${stamp}`,
    });
    await createContact(req, {
      type: 'tenant',
      firstName: 'Noted',
      lastName,
      // The extraction's own line: the `[Auto - <date>]` prefix is required.
      notes: `[Auto - Jan 5] Identified as a caseworker at Quillwort ${stamp}`,
    });
    const linked = await createContact(req, { type: 'tenant', firstName: 'Linked', lastName });
    await createContact(req, {
      type: 'tenant',
      firstName: 'Holder',
      lastName,
      relationships: [{ role: 'Caseworker', name: full('Linked'), contactId: linked }],
    });
    const norole = await createContact(req, { type: 'partner', firstName: 'Norole', lastName });
    // A partner whose role is not a caseworker role is on neither list (D19).
    await createContact(req, {
      type: 'partner',
      firstName: 'Staffer',
      lastName,
      role: `Case Manager ${stamp}`,
    });
    // The same words WITHOUT the extraction prefix are not the AI's line (D22).
    await createContact(req, {
      type: 'tenant',
      firstName: 'Typed',
      lastName,
      notes: 'Identified as a caseworker at the front desk',
    });

    await openCaseworkersTab(page);
    await expect(possibleRow(page, full('Mentions'))).toContainText(UI.signal.roleMentions);
    await expect(possibleRow(page, full('Noted'))).toContainText(UI.signal.aiNote);
    await expect(possibleRow(page, full('Linked'))).toContainText(UI.signal.relationship);
    await expect(possibleRow(page, full('Norole'))).toContainText(UI.signal.partnerNoRole);
    for (const first of ['Holder', 'Staffer', 'Typed']) {
      await expect(possibleRow(page, full(first))).toHaveCount(0);
      await expect(caseworkerRow(page, full(first))).toHaveCount(0);
    }

    // Make caseworker from a row: the same dialog as the contact page (D19).
    await possibleRow(page, full('Mentions'))
      .getByRole('button', { name: UI.makeRow(full('Mentions')), exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: UI.dialog(full('Mentions')), exact: true });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: UI.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(possibleRow(page, full('Mentions'))).toHaveCount(0);
    await expect(caseworkerRow(page, full('Mentions'))).toBeVisible();
    expect(await readContact(req, mentions)).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      caseworker_conversion: { fromType: 'tenant', fromRole: `Case Manager ${stamp}` },
    });

    // Not a caseworker: a one-line confirm, then the row is gone for good.
    await possibleRow(page, full('Norole'))
      .getByRole('button', { name: UI.dismissRow(full('Norole')), exact: true })
      .click();
    const hide = page.getByRole('dialog').filter({ hasText: UI.dismissQuestion(full('Norole')) });
    await expect(hide).toContainText(UI.dismissWarning);
    await hide.getByRole('button', { name: UI.hide, exact: true }).click();
    await expect(hide).toHaveCount(0);
    await expect(possibleRow(page, full('Norole'))).toHaveCount(0);
    await page.reload();
    await expect(possibleRow(page, full('Noted'))).toBeVisible(); // the list has loaded
    await expect(possibleRow(page, full('Norole'))).toHaveCount(0);
    const dismissed = await readContact(req, norole);
    expect(dismissed).toMatchObject({ type: 'partner', caseworker_review: 'dismissed' });
    expect(dismissed['role']).toBeUndefined();
  });
});
```

Step 4 - non-vacuity: temporarily change `UI.signal.aiNote` to
`'AI noted tenant'`, run the file (`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts`)
-> `1 failed` (the new test, at the `Noted` row's `toContainText`), `2
passed`. Revert the edit (`grep -n "AI noted caseworker" e2e/tests/dashboard-next/caseworkers.spec.ts`
prints one line).

Step 5 - GREEN: typecheck, eslint and ASCII as Task 10.5 Step 4;
`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts`
-> `3 passed`, `0 failed`.

Commit `test(e2e): caseworkers spec - the Possible caseworkers list, make and dismiss`.

### Task 10.7 - caseworkers.spec.ts, part 3: the Unknown card's Mark as Caseworker

File: `e2e/tests/dashboard-next/caseworkers.spec.ts`.
Made pass by: S1 (`canonicalSuggestedContactKind` accepts partner +
`Caseworker`), S3 (the conversion on an `unknown`, the guarded type drain),
S8 (the Unknown card's fifth action). An unknown contact CAN be made through
existing seams: an inbound text from a new number auto-creates one with an
`unknown_1to1` thread, and the deterministic fake extraction driver turns an
`EXTRACT:` body into a `partner` type suggestion
(`e2e/fixtures/extraction.ts`, the conversation-fact-extraction precedent).
(PIN, as Task 10.5.)

Step 1 - conform row C14 to S8's `UnknownFile.tsx`.

Step 2 - imports. Current (unique):

```ts
import { addOrg } from '../../fixtures/orgFixture.js';
```

Replace with:

```ts
import { addOrg } from '../../fixtures/orgFixture.js';
import { extractionTick, sendExtractSms } from '../../fixtures/extraction.js';
```

Step 3 - extend `UI`. Current (unique):

```ts
    partnerNoRole: 'Partner with no role',
  },
};
```

Replace with:

```ts
    partnerNoRole: 'Partner with no role',
  },
  triageHeading: 'Needs triage',
  markAsCaseworker: 'Mark as Caseworker',
  todayReview: 'AI suggestions to review',
};
```

Step 4 - helpers. Current (unique):

```ts
test.beforeAll(async ({ request }) => {
```

Replace with:

```ts
/**
 * The auto-captured (unknown) contact an inbound created, by phone - through
 * the EXACT `?phone=` lookup (a byPhone Query answering 0 or 1 contact,
 * app/src/routes/contacts.ts), never by scanning `?type=unknown`: that list is
 * one page of 50, unordered within a status, so a lane holding more than 50
 * unknowns would hide this one (plan review R1 ruling A11).
 */
async function findUnknownContactId(request: APIRequestContext, phone: string): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        contactId = ((await res.json()) as { contacts: Array<{ contactId: string; type?: string }> }).contacts.find(
          (c) => c.type === 'unknown',
        )?.contactId;
        return contactId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return contactId as string;
}

/** The targets of the contact's PENDING AI suggestions. */
async function pendingSuggestionTargets(request: APIRequestContext, contactId: string): Promise<string[]> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}/suggestions`);
  expect(res.ok(), `suggestions ${contactId}`).toBeTruthy();
  return ((await res.json()) as { suggestions: Array<{ target: string }> }).suggestions.map((s) => s.target);
}

function formattedPhone(phone: string): string {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
}

test.beforeAll(async ({ request }) => {
```

Step 5 - append at the end of the file:

```ts
test.describe('Caseworkers - the Unknown card', () => {
  test('Mark as Caseworker converts an inbound unknown contact and accepts the AI partner suggestion', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const phone = uniquePhone();
    const noteLine = `Identified as a caseworker at Quillwort ${stamp}`;

    // A text from a new number creates an unknown contact and its unknown_1to1
    // thread; the fake driver turns the body into a partner type suggestion and
    // an AI note line.
    await sendExtractSms(request, phone, {
      typeSuggestion: { value: 'partner', reason: `caseworker at Quillwort ${stamp}` },
      noteLines: [noteLine],
    });
    expect((await extractionTick(request)).processed).toBeGreaterThanOrEqual(1);
    const contactId = await findUnknownContactId(req, phone);
    expect(await pendingSuggestionTargets(req, contactId)).toContain('type');

    await page.goto(`${NEXT}/contacts/${contactId}`);
    const triage = page.locator('section').filter({ has: page.getByRole('heading', { name: UI.triageHeading }) });
    await triage.getByRole('button', { name: UI.markAsCaseworker, exact: true }).click();
    // The unknown has no name yet, so the dialog is named by its phone.
    const dialog = page.getByRole('dialog', { name: UI.anyDialog });
    await expect(dialog.getByText(UI.retypesOne)).toBeVisible();
    await dialog.getByRole('button', { name: UI.confirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: UI.markAsCaseworker })).toHaveCount(0);

    const contact = await readContact(req, contactId);
    expect(contact).toMatchObject({
      type: 'partner',
      role: 'Caseworker',
      status: 'active',
      type_source: 'manual',
      caseworker_conversion: { fromType: 'unknown' },
    });
    expect(String(contact['notes'])).toContain(noteLine);
    expect(await readConversationType(req, contactId)).toBe('partner_1to1');
    // The AI's partner suggestion is resolved by the conversion (accepted
    // through the canonicalizer, D16): nothing pending, Today's review clear.
    expect(await pendingSuggestionTargets(req, contactId)).not.toContain('type');
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(
      page
        .getByRole('list', { name: UI.todayReview })
        .getByRole('listitem')
        .filter({ hasText: formattedPhone(phone) }),
    ).toHaveCount(0);
  });
});
```

Step 6 - non-vacuity: temporarily change
`caseworker_conversion: { fromType: 'unknown' }` to `{ fromType: 'tenant' }`,
run the file -> `1 failed` (the new test, at that `toMatchObject`, the
received record showing `fromType: 'unknown'`), `3 passed`. Revert
(`grep -n "fromType: 'unknown'" e2e/tests/dashboard-next/caseworkers.spec.ts`
prints one line).

Step 7 - GREEN: typecheck, eslint and ASCII as Task 10.5 Step 4;
`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/caseworkers.spec.ts`
-> `4 passed`, `0 failed`.

Commit `test(e2e): caseworkers spec - Mark as Caseworker on the Unknown card`.

### Task 10.8 - partner-share.spec.ts: a property sent from a partner page

File: `e2e/tests/dashboard-next/partner-share.spec.ts` (new).
Made pass by: S6 (seed resolution accepts a partner; both fan-out sites mint
`conversationTypeFor(contact)`; recipient rows carry `type`/`role`) and S9
(PartnerFile's Properties sent card and its Send action; the neutral
wording; the "Sent to" row label). Planner rulings R3-F3, R3-F9, R3-F10,
R5-F16; E2E rule 3. (PIN, as Task 10.5.)

Step 1 - conform rows C16-C19 to S9's `PartnerFile.tsx`, `ListingDetail.tsx`
and `RecipientPreview.tsx`.

Step 2 - create the file with exactly:

```ts
// e2e/tests/dashboard-next/partner-share.spec.ts
//
// A direct property share to a partner (caseworkers design D20, D22,
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md),
// end to end against the real backend: from a PARTNER's page ("Properties
// sent" card -> "+ Send", aria-label "Send a property to this partner") the
// seeded composer sends the normal share (address + flyer link) into the
// partner's own conversation, which the share MINTS as `partner_1to1`; the
// partner's Properties sent card lists the property; and the property's
// "Sent to" card labels the partner's row by its role.
//
// The recipient is a fresh, run-unique caseworker - a `partner` with the role
// "Caseworker", created through the contacts POST as a NEW contact (D16) -
// with consent recorded. Never the lean partner Renee Carter: she has no
// consent by design and is a Possible caseworkers row. ISOLATION for the
// thread type (planner rulings, "E2E rules" 3): nothing calls
// POST /api/contacts/:id/conversation before the share - that route mints the
// thread by contact type itself and would make the type check vacuous. The
// type is read only AFTER the send, when the share's thread is the only one
// this phone has ever had. Sends are asserted through the fake-twilio thread
// store (matching-entry-points.spec.ts precedent); a fresh Available property
// satisfies the availability guard.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The S10 selector contract rows C16-C19 (plan 3.9, spec D22). */
const UI = {
  propertiesSent: /Properties sent/,
  partnerSend: 'Send a property to this partner',
  composerHeading: 'Send a property',
  property: 'Property',
  message: 'Message',
  preview: 'Preview recipients',
  review: 'Review recipients',
  candidates: 'Candidate recipients',
  sendOne: /^Send to 1 recipient\b/,
  // The heading's name is "Sent to" PLUS its "Send this property" action
  // (Card renders the aside inside the <h3>): match the prefix.
  sentToCard: /^Sent to\b/,
  // displayKind: the role, else the type label (D22).
  rowLabel: /\bCaseworker\b/,
};

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

/** A NEW caseworker (partner + role "Caseworker", D16) with consent recorded,
 *  so the just-in-time consent gate lets the share through. */
async function createConsentedCaseworker(
  request: APIRequestContext,
  stamp: string,
): Promise<{ contactId: string; name: string; phone: string }> {
  const phone = uniquePhone();
  const firstName = `Share${stamp}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'partner', role: 'Caseworker', firstName, lastName: 'Partnershare', phone },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, name: `${firstName} Partnershare`, phone };
}

/** A fresh per-run property, published Available (the send guard requires it). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp} Partner Share Ave`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Atlanta Housing Authority'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** Outbound messages to `phone` whose body contains `needle` (fake-twilio).
 *  A fresh number's thread holds only what this test sent. */
async function outboundHits(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  const threads = await listThreads(request);
  const thread = threads.find((x) => x.partyNumber === phone);
  return (
    thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle)).length ?? 0
  );
}

test.describe('Partner share - a property sent from a partner page', () => {
  test('the share lands in a partner_1to1 thread, on the Properties sent card, and on the property labelled by role', async ({
    page,
    request,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for setup.
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const partner = await createConsentedCaseworker(page.request, stamp);
    const { unitId, line1 } = await createUnitViaApi(page.request, stamp);

    // The partner page's Properties sent card + its Send action (D20).
    await page.goto(`${NEXT}/contacts/${partner.contactId}`);
    const propertiesSent = page.locator('section', { has: page.getByRole('heading', { name: UI.propertiesSent }) });
    await expect(propertiesSent).toBeVisible();
    await propertiesSent.getByRole('button', { name: UI.partnerSend, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?contactId=${partner.contactId}`));
    await expect(page.getByRole('heading', { name: UI.composerHeading })).toBeVisible();
    await expect(page.getByText(/Sending to/)).toBeVisible();

    // Pick the property; the message fills with the normal share: the one-line
    // address and the flyer link (share-skip-fix D8).
    await page.getByRole('combobox', { name: UI.property }).fill(line1);
    await page.getByRole('option', { name: new RegExp(`${stamp} Partner Share Ave`) }).click();
    await expect(page.getByLabel(UI.message)).toHaveValue(
      new RegExp(`^${stamp} Partner Share Ave, Atlanta, GA 30314 \\S+/p/${unitId}\\?cta=text$`),
      { timeout: 10_000 },
    );

    // The partner seed RESOLVES (before caseworkers it was dropped as a
    // non-tenant): one pre-checked row, named for the partner.
    const previewBtn = page.getByRole('button', { name: UI.preview });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    await expect(page.getByRole('heading', { name: UI.review })).toBeVisible();
    const list = page.getByRole('list', { name: UI.candidates });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();
    await expect(list.locator('li', { hasText: partner.name })).toBeVisible();
    await page.getByRole('button', { name: UI.sendOne }).click();

    // Proof of send: exactly one text with the flyer link.
    await expect
      .poll(async () => outboundHits(request, partner.phone, `/p/${unitId}`), {
        timeout: 15_000,
        message: 'the partner should receive exactly one message with the flyer link',
      })
      .toBe(1);

    // The share MINTED the partner's thread as partner_1to1 (D20:
    // conversationTypeFor(contact) at both fan-out sites). This POST RETURNS
    // the open thread the share created - it mints only when there is none,
    // and this phone had none before the share.
    const conv = await page.request.post(`${NEXT}/api/contacts/${partner.contactId}/conversation`);
    expect(conv.ok()).toBeTruthy();
    expect(((await conv.json()) as { conversation: { type: string } }).conversation.type).toBe('partner_1to1');

    // The listing send is recorded a beat after the text (same deferred pass):
    // wait for it through the card's own API before loading the page.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/contacts/${partner.contactId}/listings-sent`);
          if (!res.ok()) return false;
          const rows = ((await res.json()) as { sent: Array<{ unitId: string }> }).sent;
          return rows.some((r) => r.unitId === unitId);
        },
        { timeout: 15_000, message: 'the listing send should be recorded for the partner' },
      )
      .toBe(true);

    // The partner's Properties sent card lists the property.
    await page.goto(`${NEXT}/contacts/${partner.contactId}`);
    await expect(propertiesSent.locator(`a[href="/listings/${unitId}"]`)).toBeVisible({ timeout: 10_000 });

    // The property's "Sent to" card lists the partner, labelled by role (D22).
    // A fresh property sent once: the card holds this one row only.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const sentTo = page.locator('section', { has: page.getByRole('heading', { name: UI.sentToCard }) });
    await expect(sentTo.locator(`a[href="/contacts/${partner.contactId}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(sentTo.getByText(UI.rowLabel).first()).toBeVisible();
  });
});
```

Step 3 - non-vacuity: temporarily change the `.toBe('partner_1to1')` to
`.toBe('tenant_1to1')` - the type both fan-out sites hard-coded before S6 -
and run:

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/partner-share.spec.ts`

Expected: `1 failed` at that line, `Received: "partner_1to1"`. Revert
(`grep -n "tenant_1to1" e2e/tests/dashboard-next/partner-share.spec.ts`
prints nothing).

Step 4 - GREEN:

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/partner-share.spec.ts` -> no error.

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/partner-share.spec.ts`
-> `1 passed`, `0 failed`.

`cd "W:/tmp/caseworkers"; tr -d '\11\12\15\40-\176' < "e2e/tests/dashboard-next/partner-share.spec.ts" | wc -c` -> `0`.

Commit `test(e2e): partner-share spec - a property sent from a partner page mints partner_1to1`.

### Task 10.8a - org-lists.spec.ts: an organization value under Settings > "Not on the list" - Add as new asks the Kind, Use takes a list name

Plan review R1 ruling S1: no e2e drove S7's Settings organization rows, and
S5 Task 5.7's dev-seam extension (`field: 'organization'`) was never called.
This task adds ONE test to the existing `"Not on the list"` describe of
`e2e/tests/dashboard-next/org-lists.spec.ts`, reusing its helpers
(`devLoginAs`, `uniquePhone`, `openOrgSettings`, `notOnListRow`, `UI`) and
the fixtures it already imports (`addOrg`, `requireOrg`, `sameOrgText`,
`setOffListValue`, `waitForRewrite`).

Files: `e2e/tests/dashboard-next/org-lists.spec.ts`.
Made pass by: S5 (organization rows, resolve `kind`, the dev seam) and S7
(Task 7.5's organization rows and the Settle dialog's Kind choice).

E2E rules (section 0 and this slice's isolation rules): every value and
name is RUN-UNIQUE (a stamp per test; no value contains another, because
`notOnListRow` matches a case-insensitive substring); the holders are
partners this test creates; the one list entry it adds through the API goes
through `addOrg`, and the one the UI adds ("Add as new") carries the stamp
too; NO count is asserted anywhere (no `count` / `deletedCount`, no number
of rows, no empty state); each rewrite is lane-global, so the test waits for
each before the next.

This task is PIN-only (section 0): it covers behavior S5 and S7 proved with
unit tests, so it is green on arrival. Its assertions that CAN fail on a
regression: the row is labelled `Organization`; "Add as new" in the dialog
stays disabled until a `Kind` radio is chosen; the added entry's kind is the
one picked; Use writes the list name onto the holder's `organization`.

Step 1 - helpers. In `e2e/tests/dashboard-next/org-lists.spec.ts`, current
(unique):

```ts
test.describe('"Not on the list" (spec D10, D11)', () => {
```

Replace with:

```ts
/** A run-unique partner (a caseworker - type partner, role Caseworker)
 *  through the real POST; its `organization` is planted by the dev seam. */
async function createPartner(request: APIRequestContext, firstName: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'partner', role: 'Caseworker', firstName, lastName: 'Orglist', phone: uniquePhone() },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** A contact's stored organization (caseworkers spec D17). */
async function organizationOf(request: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { organization?: string } }).contact.organization;
}

test.describe('"Not on the list" (spec D10, D11)', () => {
```

Step 2 - the test, the last one in that describe. Current (unique - the
end of the `an admin settles values: Use, Move to Agency, Split and Clear
each rewrite the records` test and of the describe):

```ts
    for (const value of [useValue, moveValue, splitValue, clearValue]) {
      await expect(notOnListRow(page, value)).toHaveCount(0);
    }
  });
});
```

Replace with:

```ts
    for (const value of [useValue, moveValue, splitValue, clearValue]) {
      await expect(notOnListRow(page, value)).toHaveCount(0);
    }
  });

  test('an organization value (caseworkers D17): its own row; Add as new asks the Kind; Use takes a name of either kind', async ({
    page,
  }) => {
    test.slow(); // two rewrite jobs, strictly one at a time (D11)
    await devLoginAs(page, 'founder@example.com');
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // An AGENCY on the list: an organization value is settled against BOTH lists.
    const wren = `Wren Aid ${stamp}`;
    await addOrg(req, { kind: 'agency', name: wren });
    // Two values, neither containing the other.
    const useValue = wren.toLowerCase(); // resolves to the agency, but is not its exact text
    const addValue = `Starling Partners ${stamp}`; // resolves to nothing
    const useHolder = await createPartner(req, `OrgUse${stamp}`);
    const addHolder = await createPartner(req, `OrgAdd${stamp}`);
    await setOffListValue(req, { contactId: useHolder, field: 'organization', value: useValue });
    await setOffListValue(req, { contactId: addHolder, field: 'organization', value: addValue });

    await openOrgSettings(page);
    const dialog = page.getByRole('dialog');

    // Each value is an ORGANIZATION row (FIELD_LABEL.organization).
    await expect(notOnListRow(page, addValue)).toBeVisible();
    await expect(notOnListRow(page, addValue)).toContainText('Organization');
    await expect(notOnListRow(page, useValue)).toContainText('Organization');

    // Add as new: staff must pick the list - no default kind (D17; R2-F3).
    await notOnListRow(page, addValue).getByRole('button', { name: 'Add as new', exact: true }).click();
    const add = dialog.getByRole('button', { name: 'Add as new', exact: true });
    await expect(add).toBeDisabled();
    const kind = dialog.getByRole('group', { name: 'Kind' });
    await expect(kind.getByRole('radio', { name: 'Housing authority' })).not.toBeChecked();
    await expect(kind.getByRole('radio', { name: 'Agency' })).not.toBeChecked();
    await kind.getByRole('radio', { name: 'Housing authority' }).click();
    await expect(add).toBeEnabled();
    await add.click();
    await waitForRewrite(req, (r) => r.fromTexts.some((t) => sameOrgText(t, addValue)));
    expect((await requireOrg(req, addValue)).kind).toBe('housing_authority');
    expect(await organizationOf(req, addHolder)).toBe(addValue);

    // Use <name>: the value resolves to the AGENCY - an organization takes either kind.
    await page.reload();
    await notOnListRow(page, useValue).getByRole('button', { name: UI.use(wren), exact: true }).click();
    await expect(dialog).toContainText(useValue);
    await dialog.getByRole('button', { name: UI.use(wren), exact: true }).click();
    await waitForRewrite(req, (r) => r.action === 'use' && r.fromTexts.some((t) => sameOrgText(t, useValue)));
    expect(await organizationOf(req, useHolder)).toBe(wren);

    // Both settled values leave the section.
    await page.reload();
    await expect(notOnListRow(page, wren)).toHaveCount(0); // the use value, any case
    await expect(notOnListRow(page, addValue)).toHaveCount(0);
  });
});
```

(`UI.use(name)` is `Use <name>`; the Settle dialog's Add button and the
row's button share the name `Add as new`, hence the dialog scope. If an
as-built name differs - the Kind group or its radios, Task 7.3's
`OrgKindChoice` - it is an S7 defect against plan 3.9: stop and report.)

Step 3 - GREEN:

`cd "W:/tmp/caseworkers"; npm run typecheck -w @housingchoice/e2e` -> exit 0.

`cd "W:/tmp/caseworkers"; npx eslint e2e/tests/dashboard-next/org-lists.spec.ts`
-> no error on an added line.

`cd "W:/tmp/caseworkers"; npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/org-lists.spec.ts`
-> `0 failed` (every org-lists test, the new one included).

ASCII check on the file's added lines (section "How to run").

Commit `test(e2e): an organization value under Not on the list - Add as new asks the kind, Use takes either kind`
(stage `e2e/tests/dashboard-next/org-lists.spec.ts`).

### Task 10.9 - selectors.md: the caseworker surfaces, the partner Send, the neutral share names

File: `e2e/support/selectors.md`. Word every row with the names the specs
use after Tasks 10.2-10.8 (the selector contract as conformed). Lines 6-10,
44 and 164-166 carry pre-existing non-ASCII characters and are not touched;
every added line is ASCII.

Ownership (plan review R1 ruling A7): Task 9.6 OWNS line 45 (the
`| Thread | send |` row), the `| Contact page | Properties sent card |` row
(heading `/^Properties sent/`) and the `| Property page (Sent to card) |`
row (heading `/^Sent to\b/`) - one row and one regex each. Task 7.3 owns the
org-picker row's organization wording and Task 5.7 the dev-seam row. This
task adds only the caseworker rows and the share-wording row below, and
NEVER a second row for either share card.

Step 1 - skip-if-done verification of Task 9.6's rows (no edit):
`cd "W:/tmp/caseworkers"; git grep -n -F "Send a property to this partner" -- e2e/support/selectors.md`
prints the line-45 `| Thread | send |` row and the `| Contact page | Properties sent card |`
row, and `git grep -n -F "| Property page (Sent to card) |" -- e2e/support/selectors.md`
prints one line. If any is missing: stop and report (a Task 9.6 gap) - do
not add a substitute row here.

Step 2 - insert after line 114 (the "Contacts list" row). Current (the
whole line 114, unique, ASCII):

```md
| Contacts list | the rows list + filter tabs | `getByRole('list', { name: 'Tenants' })` - the rows `<ul>` is named by the view heading (`Contacts` / `Tenants` / `Landlords` / `Unknown` / `Deleted`). SCOPE every row assertion to it (`.getByRole('listitem')`); the on-page tabs are `getByRole('navigation', { name: 'Filter contacts' })`, and facet params ride the Tenants tab's href only |
```

Replace with that same line followed by these rows:

```md
| Contacts > Caseworkers (`/contacts/caseworkers`) | page, rows and Organization chips | nav `getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Caseworkers', exact: true })` (a link of the same name sits in `navigation` `Filter contacts`); heading `getByRole('heading', { name: 'Caseworkers', exact: true })`; rows `getByRole('list', { name: 'Caseworkers', exact: true }).getByRole('listitem').filter({ hasText: <full name> })`, each row showing the organization. ALWAYS `exact`: a bare `Caseworkers` substring-matches the `Possible caseworkers` heading and list on the same page. Chips `getByRole('group', { name: 'Organization', exact: true }).getByRole('button', { name: /^<org> \(/ })` - live counts in the name, as the tenant facets; selection is `aria-pressed` and the URL param `org`. The lane keeps every earlier spec's caseworkers: assert only rows the spec created, never a count or the empty text `No caseworkers yet.` |
| Contacts > Caseworkers | the Possible caseworkers list | `getByRole('list', { name: 'Possible caseworkers', exact: true }).getByRole('listitem').filter({ hasText: <run-unique full name> })`; a row states its signals as text: `Role mentions caseworker`, `AI noted caseworker`, `Linked as a caseworker`, `Partner with no role`. Row buttons are named per contact: `Make <Full Name> a caseworker` (the conversion dialog) and `<Full Name> is not a caseworker` (a confirm dialog - find it by `page.getByRole('dialog').filter({ hasText: 'Hide <Full Name> from Possible caseworkers?' })` - with `Hide` / `Cancel`). Every lane spec adds rows (contact-create's `Case worker <stamp>` tenants, conversation-fact-extraction's role-less partners), so never assert the list's length or emptiness. NEVER convert or dismiss a seeded contact: Renee Carter is a row on a fresh lean world, and a dismissal hides her until the next reseed. Plant an AI-note row with a contacts POST `notes` line that starts `[Auto - <date>] Identified as a caseworker` - without the prefix it is not the AI's line |
| Contact page | Make caseworker and the conversion dialog | `getByRole('button', { name: 'More actions' })` then `getByRole('menuitem', { name: 'Make caseworker', exact: true })` - on a live tenant, landlord or partner that is not yet a caseworker (absent otherwise); the Unknown card's `Mark as Caseworker` (between `Mark as Partner` and `Mark as Property Manager`) opens the same dialog. Dialog `getByRole('dialog', { name: 'Make <Full Name> a caseworker', exact: true })` (an unnamed unknown is named by its phone: use `/^Make .+ a caseworker$/`); its read-only preview as text (`Housing authority: <x>`, `Agency: <x>`, `<n> conversation(s) will become partner conversations.`); the Organization picker `getByRole('combobox', { name: 'Organization', exact: true })` (both lists; options portaled - see Org pickers; ABSENT, replaced by the text `This contact is already a caseworker. Confirming re-runs the cleanup.`, when the contact already is one); confirm `getByRole('button', { name: 'Make caseworker', exact: true })`, DISABLED while a refusal shows: `Finish or close this contact's placement first.` + link `View placement`, or the landlord-of-record sentence + `View property` - one sentence per blocking record, so take `.first()`. Tasha Nguyen (open placement) and Marcus Bell (landlord of record) are READ-ONLY refusal fixtures: Cancel, and read refusals through `GET /api/contacts/:id/caseworker-review/preview`, never a POST |
| Contact page (new contact form) | the Caseworker preset | `getByRole('group', { name: 'Contact kind' }).getByRole('button', { name: 'Caseworker', exact: true })` - saves `{ type: 'partner', role: 'Caseworker' }`; no `Role` input and no Organization picker on the create form (Organization is set on the partner page) |
| Share composer and its echoes | recipient wording | neutral since caseworkers (D20, D22): Send `getByRole('button', { name: /^Send to 1 recipient\b/ })` / `/^Send to \d+ recipients?$/`; reach line `Reaches <n> recipient(s)`; note `Flagged recipients you picked stay checked; "Select all" skips the others.`; property Activity and landlord timeline rows `Sent to <n> recipient(s)` / `No recipients reached` (every share label keeps the `Sent to ` prefix the landlord timeline's relabel keys on). Tenant-worded ON PURPOSE because the control reaches tenants only: `Add a tenant`, `Add more tenants by filters`, `No candidates - add a tenant below.`, the filter summary `Tenants - ...`. The partner page's Properties sent card and the property's "Sent to" card are Task 9.6's rows above. A share to a partner mints `partner_1to1`: never "prove" it after calling `POST /api/contacts/:id/conversation` BEFORE the share - that route mints the thread by contact type itself; read the type only after the send. Renee Carter has no consent: mint a run-unique consented partner instead |
```

Step 3 - check:
`cd "W:/tmp/caseworkers"; git diff -U0 -- e2e/support/selectors.md | grep '^+' | grep -nP '[^\x00-\x7F]'`
-> prints nothing.

Commit `docs(e2e): selectors for the Caseworkers page, the conversion dialog and the neutral share wording` (stage `e2e/support/selectors.md`).

### Task 10.10 - GLOSSARY: caseworker and organization (of a caseworker); partner and "not on the list" cross-referenced

File: `documentation/GLOSSARY.md` (spec section 3, planner rulings R1-F17,
R4-22; plan review R1 ruling A8 adds Step 4). Lines 215-345 and line 120 are
ASCII; the file's other non-ASCII lines are not touched.

Step 1 - the `partner` entry. Current (`:227-228`, unique):

```md
  real type end to end (a `partner_1to1` conversation, author `'partner'`). Tenants
  and landlords never see the word - it is a staff/internal label only.
```

Replace with:

```md
  real type end to end (a `partner_1to1` conversation, author `'partner'`). Tenants
  and landlords never see the word - it is a staff/internal label only. A
  partner whose role is "Caseworker" is a **caseworker** (below, beside the
  organization entries) - still typed `partner`.
```

Step 2 - the "not on the list" entry. Current (`:337-338`, unique):

```md
  rewrite the records). On a form it is a removable chip marked "Not on the
  list", and an unrelated save never fails because of it.
```

Replace with:

```md
  rewrite the records). On a form it is a removable chip marked "Not on the
  list", and an unrelated save never fails because of it. A caseworker's
  **organization** (below) is listed too, as an organization row: Use (a name
  of EITHER kind), Add as new (staff pick the kind) or Clear - never Move or
  Split, since the field takes both kinds.
```

Step 3 - the two new entries. Current (unique):

```md
- **accepted authorities** (tenant-list-visibility, 2026-08-10; updated by
```

Replace with:

```md
- **caseworker** (caseworkers, 2026-10-07) - a `partner` contact whose `role`
  is "Caseworker": the role normalizes (spec D4) to "caseworker" or "case
  worker" (`isCaseworkerRole`, `app/src/lib/caseworkers.ts`; the preset value
  is `CASEWORKER_ROLE`). NOT a `ContactType` - the code/data type stays
  `partner`, the way Property Manager stays `landlord`. Staff meet it as the
  KindPicker's "Caseworker" choice and the Contacts > Caseworkers tab (with
  an Organization filter). A NEW contact saved as Caseworker is stored
  `{ type: 'partner', role: 'Caseworker' }`; an EXISTING contact becomes one
  only through the **caseworker conversion** ("Make caseworker" - the contact
  page's More actions, the Unknown card's "Mark as Caseworker", or a Possible
  caseworkers row; `POST /api/contacts/:contactId/caseworker-review`), which
  refuses a contact with an open placement, an open tour as the tenant, a
  property it is landlord of record for, or a seat on a property's contact
  list; removes the tenant's housing authority and agency (keeping them, with
  the old type, in `caseworker_conversion`); and re-types the contact's own
  one-to-one threads to `partner_1to1`. The contacts PATCH refuses to make a
  caseworker any other way (409 `caseworker_use_conversion`). "Possible
  caseworkers" are the contacts the tab offers for review: a role that
  MENTIONS caseworker, case worker or case manager, the AI's
  "[Auto - <date>] Identified as a caseworker" notes line, a caseworker
  relationship pointing at a tenant, or a partner with no role; "Not a
  caseworker" hides one for good (`caseworker_review: 'dismissed'`).
  DIFFERENT from the tenant's free-text `contact.caseworker` (the NAME of a
  tenant's own caseworker, e.g. "D. Okafor", shown on placements), which the
  caseworkers feature neither reads nor writes. Design:
  `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  D16-D22.

- **organization (of a caseworker)** (caseworkers, 2026-10-07) - the housing
  authority or agency a caseworker works for: `contact.organization`, a NAME
  from EITHER list of the **organization list** (above), checked like the
  housing authority (422 `org_not_on_list`; `''` removes it). Shown on a
  partner's page and in its header, and as the Caseworkers tab's
  Organization filter; counted in Settings' "Used by" column and rewritten by
  a rename or merge of either kind. The conversion fills it from the
  contact's agency, else its housing authority - the list name when the text
  matches one, else the text as written (then it waits under "Not on the
  list"). Not the **organization list** itself, and not the generic word.

- **accepted authorities** (tenant-list-visibility, 2026-08-10; updated by
```

Step 4 - the share entry's retired label (`:120`; AGENTS.md: GLOSSARY
changes in the same change as the wording; plan review R1 ruling A8).
Current (ASCII, unique):

```md
  offers "Send to tenants". Replaces the earlier on-screen label "Broadcasts"
```

Replace with:

```md
  offers "Send this property". Replaces the earlier on-screen label "Broadcasts"
```

Step 5 - check:
`cd "W:/tmp/caseworkers"; git diff -U0 -- documentation/GLOSSARY.md | grep '^+' | grep -nP '[^\x00-\x7F]'`
-> prints nothing.

Commit `docs(glossary): caseworker and organization (of a caseworker); partner and not-on-the-list cross-referenced; Send this property`.

### Task 10.11 - RUNBOOK: the caseworker conversion's repair, putting a mistaken conversion back, and what it does not fence

Files: `RUNBOOK.md` (spec section 11; planner rulings R1-F4, R2-F9; plan
review R1 ruling A12 adds Step 2), `documentation/sequence-diagram-to-test.md`
(ruling A8, Step 3). The new section goes BEFORE "Tour reminder
supersession" - not inside the organization-names section, which main's
`20ccdb12` rewrote (keeping the two edits apart keeps the final main sync
clean). The inserted block is ASCII.

Step 1 - Current (unique):

```md
### Tour reminder supersession (2026-09-01): NOTHING is owed - no backfill, no Terraform, no sweep
```

Replace with:

````md
### Caseworkers (`feat/caseworkers`): NOTHING is owed at deploy - the conversion's repair, and putting a mistaken conversion back

**Deploy the app image (app + worker) and you are done: no Terraform, no secrets, no new table or index, no script, no backfill.** Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`, D16-D22 and section 11. A caseworker is a `partner` contact with the role `Caseworker`; Contacts > Caseworkers lists them, with a "Possible caseworkers" list to review.

**What "Make caseworker" writes** (the caseworker conversion, `POST /api/contacts/<contactId>/caseworker-review` with `{ "action": "make" }`, behind every Make caseworker button). Step 1 is ONE conditional write of the contact: type `partner`, role `Caseworker`, status `active`, `type_source: 'manual'`, `organization` set (or removed), the housing authority removed and `agency` set to `''` - and, in the same write, `caseworker_conversion` `{ at, by, fromType, fromRole?, housingAuthority?, agency? }`, the values it removed and the old type. Steps 2-4 follow, each best-effort and once: the pending AI type suggestion resolved and every other pending suggestion superseded; the contact's OWN one-to-one threads re-typed to `partner_1to1` (a thread another live contact shares - a household phone - is left as it is); the `contact_updated` audit (it carries `caseworker_conversion`), the status milestone, the live-update events and the role vocabulary. A failure in steps 2-4 never undoes step 1: the app logs an ERROR line carrying the `contactId`, and the dashboard shows the contact as a caseworker.

**Repair - an ERROR line from the conversion, or a caseworker whose threads are still `tenant_1to1` / `unknown_1to1` or whose AI suggestions are still pending.** Run `make` again on that contact: on a contact that is already a caseworker it re-runs steps 2-4 only (the contact itself is not re-written) and answers `200 { contact }`. There is no page button for it (a caseworker is no longer on the Possible list), so call the route from a signed-in session: open that environment's dashboard, sign in, open the browser DevTools console on any dashboard page, and run

```js
await (await fetch('/api/contacts/<contactId>/caseworker-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'make' }) })).json()
```

`404 contact_not_found`: the contact was deleted - nothing to repair. Dev first, then prod.

**Putting a mistaken conversion back** (no app button; dev first, then prod):

1. Read what the conversion removed. In the same console: `(await (await fetch('/api/contacts/<contactId>')).json()).contact.caseworker_conversion` -> `{ at, by, fromType, fromRole, housingAuthority, agency }` (absent fields were absent before). No `caseworker_conversion` at all means the contact was CREATED as a caseworker: nothing was removed. The contact's `contact_updated` audit for the conversion holds the same record, including an earlier conversion's that a later one replaced.
2. On the contact page (still a partner), Edit contact details: clear Organization if the contact should not keep it (once the type changes, no page shows or edits it), and save.
3. Edit again: change the kind back to `fromType` (Tenant, Landlord or Partner; a contact converted from `unknown` has no "back" - pick its real kind) and the role back to `fromRole` (empty when absent), then set Housing authority and Agency back to the recorded values with their pickers. A recorded value that is no longer on the organization list cannot be saved through the form: pick its list name, or add it first on Settings > Housing authorities & agencies. The contact keeps `type_source: 'manual'`, so a re-import still leaves its type, status, housing authority and agency alone.
4. Threads. The conversion re-typed the contact's own threads to `partner_1to1`, and nothing in the app types them back: the edit form's type change flips only `unknown_1to1` threads. Texting works on them as they are. What does not: tour reminders and the timeline look for a `tenant_1to1` (or `unknown_1to1`) thread and placement nudges for the thread type of their rung, so a contact going back to TENANT with tours or placements ahead needs its thread type restored by hand: in the AWS console, DynamoDB table `hc-<env>-conversations`, the conversation items whose `participant_phone` is one of the contact's phones (or whose `participant_email` is one of its addresses) and whose `type` is `partner_1to1` - set `type` to `tenant_1to1` (or `landlord_1to1`). Edit only `type`; leave the phone-claim rows (no `type` attribute) alone. Ask before touching prod data.
5. AI suggestions the conversion superseded stay superseded; the next extraction run on the contact's thread suggests afresh.

**What the conversion does not fence: an extraction run already in flight.** A run that read the contact while it was still a tenant or unknown can still write tenant facts (a housing authority included) or new suggestions onto it after the conversion: its writes are not conditional on the contact's type (filed: `extraction-in-flight-writes-onto-converted-caseworker`). `make` again (the repair above) supersedes such suggestions, but it does NOT remove a housing authority the run wrote. Remove that by hand in the console: `await fetch('/api/contacts/<contactId>', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ housingAuthority: '' }) })`.

**The organization-names cleanup ignores `organization`.** `app/scripts/clean-org-names.ts` (section above) reads and writes housing authorities, agencies and property lists only; it never reads or writes a caseworker's `organization`. An organization that is not on the list - text the conversion carried over as written - waits on Settings > Housing authorities & agencies > "Not on the list" as an organization row, settled with Use (a name of either kind), Add as new (pick the kind) or Clear; a re-run of the cleanup leaves it alone.

### Tour reminder supersession (2026-09-01): NOTHING is owed - no backfill, no Terraform, no sweep
````

Step 2 - the stale "Sent to tenants" card name elsewhere in `RUNBOOK.md`
(plan review R1 ruling A12; the card is "Sent to" since Task 9.1). Four
edits, each anchor unique in the file:

- `:179` - the line holds an em dash, written `{--}` (section 0 glyph
  legend; the line holding the unique ASCII prefix
  ``| BE4 listings-sent | `listing_sends` | **new table** ``) - Read it and
  replace the WHOLE line, which becomes ASCII. Current
  ``| BE4 listings-sent | `listing_sends` | **new table** {--} PK `unitId`, SK `contactId`, GSI `byContact` (`contactId`+`sentAt`) | "Sent to tenants" / "Properties sent" |``
  Replace with
  ``| BE4 listings-sent | `listing_sends` | **new table** - PK `unitId`, SK `contactId`, GSI `byContact` (`contactId`+`sentAt`) | "Sent to" (the property card; "Sent to tenants" before caseworkers) / "Properties sent" |``.
- `:376` (ASCII) - replace the substring
  `"Properties sent" and "Sent to tenants". The deployed code fixes new sends;`
  with `"Properties sent" and the property's "Sent to" card. The deployed code fixes new sends;`.
- `:386` (ASCII) - replace the substring
  `the property's "Sent to tenants"), a created counted row included.`
  with `the property's "Sent to" card), a created counted row included.`.
- `:415` (ASCII) - replace the substring
  `the tour chip on the "Sent to tenants" / "Properties sent" lists`
  with `the tour chip on the "Sent to" / "Properties sent" lists`.

Afterwards `cd "W:/tmp/caseworkers"; git grep -n "Sent to tenants" -- RUNBOOK.md`
prints only the line-179 parenthesis "(... "Sent to tenants" before caseworkers)".

Step 3 - `documentation/sequence-diagram-to-test.md:135` (plan review R1
ruling A8). The line holds U+2192 arrows, written `{->}` (section 0 glyph
legend; the line holding the unique ASCII substring
`"Send to N tenant(s)"), which sends a templated SMS`) - Read it and replace
the WHOLE line, which becomes ASCII. Current
``  {->} curate {->} "Send to N tenant(s)"), which sends a templated SMS (`[Address]`, `[Rent]`,``
Replace with
``  -> curate -> "Send to N recipient(s)"), which sends a templated SMS (`[Address]`, `[Rent]`,``.
(If the Read shows the line's leading text differs from `  {->} curate {->}`,
keep its leading text, retyped in ASCII, and change only "tenant(s)" ->
"recipient(s)".)

Step 4 - check:
`cd "W:/tmp/caseworkers"; git diff -U0 -- RUNBOOK.md documentation/sequence-diagram-to-test.md | grep '^+' | grep -nP '[^\x00-\x7F]'`
-> prints nothing.

Commit `docs(runbook): caseworkers - the conversion's repair, putting a conversion back, what it does not fence; the "Sent to" card name`
(stage `RUNBOOK.md` and `documentation/sequence-diagram-to-test.md`).

### Task 10.12 - issues: the section 12 B follow-ups, and staff-notes-on-landlord-partner-files updated

Spec section 12's B lines, each checked against `docs/issues/` before this
plan was written: none is filed yet. The cost line pairs with the profiler
issue S8 Task 8.13 filed (Task 10.1 verifies it). Create the six files below (the
`docs/issues/_TEMPLATE.md` schema; filename minus `.md` is the id;
`<BUILD-DATE>` = `date +%F`), then update one existing issue.

Step 1 - VERIFY the imported-thread follow-up against the code before
filing it (spec section 12: "Verify against the code and file"). Each must
hold; if one does not, report to the orchestrator and leave that file out:
- `cd "W:/tmp/caseworkers"; git grep -n "'unknown_1to1'" -- app/src/lib/import/apply.ts`
  shows `upsertConversation` minting every imported 1:1 thread as
  `unknown_1to1` (with `if_not_exists`), whatever the contact's type;
- `cd "W:/tmp/caseworkers"; git grep -n "conv.type === 'unknown_1to1'" -- app/src/routes/today.ts dashboard/src/routes/today/buildToday.ts`
  shows Today choosing "New unknown contact" / "New inbound - untriaged" by
  the THREAD type, with no contact-type check;
- `cd "W:/tmp/caseworkers"; git grep -n "applyTriage(\|setTypeIfCurrent(" -- app/src`
  shows only the contacts PATCH (a type CHANGE), placement nudges (display
  name only) and the caseworker conversion re-typing a thread - so an
  imported contact the importer already typed keeps its `unknown_1to1`
  thread until someone changes its type.

Step 2 - `docs/issues/contact-retype-skips-caseworker-refusals.md`:

```md
---
id: contact-retype-skips-caseworker-refusals
title: The generic contact type change has none of the caseworker conversion's refusals (open placement, open tour, landlord of record, roster seat)
type: decision
severity: low
status: open
area: app/contacts
created: <BUILD-DATE>
refs: app/src/routes/contacts.ts, app/src/services/caseworkerConversion.ts, dashboard/src/routes/contact/ContactEditForm.tsx, dashboard/src/routes/contact/UnknownFile.tsx
---

**Problem.** The caseworker conversion (`feat/caseworkers`, spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D19) refuses a contact with an open placement, an open tour as the tenant, a
property it is the landlord of record for, or a seat on a property's contact
list. The generic type change - the edit form's kind change and the Unknown
card's Mark as Tenant / Landlord / Property Manager / Partner, all through
the contacts PATCH `type` - has none of these checks: a tenant with an open
placement or a scheduled tour can be re-typed to Landlord or Partner today,
and a landlord of record can be re-typed to Tenant. Branch B kept that path
unchanged on purpose (D16, D21): it guards only the conversion, and it kept
the generic path's thread rule (only `unknown_1to1` threads flip), so tour
reminders and placement nudges still find a mistakenly re-typed tenant's
`tenant_1to1` thread. Pre-existing.

**Suggested fix.** Decide (Sam and Cameron) whether a type change AWAY from
tenant or landlord should run the conversion's refusal reads (the four
checks in `app/src/services/caseworkerConversion.ts`) and refuse, or only
warn in the edit form, or stay as it is. Related:
`tours-placements-no-contact-type-check` (the other direction: a tour or
placement created for a non-tenant).
```

Step 3 - `docs/issues/tours-placements-no-contact-type-check.md`:

```md
---
id: tours-placements-no-contact-type-check
title: Tours, placements, a property's landlord of record and its contact list check no contact type, so a caseworker can be given what the conversion refused
type: bug
severity: low
status: open
area: app/tours
created: <BUILD-DATE>
refs: app/src/routes/tours.ts, app/src/routes/placements.ts, app/src/services/statusTransition.ts:335, app/src/jobs/tourReminders.ts:1093, app/src/routes/tourReminders.ts:1027, app/src/routes/units.ts, app/src/lib/unitFields.ts, app/src/services/rosterEdits.ts
---

**Problem.** The caseworker conversion (`feat/caseworkers`, spec D19)
refuses a contact with an open tour or placement, but those are reads before
its write and nothing re-checks later: neither the tours routes nor the
placements routes check the contact's type when a tour or placement is
created or reopened, so a caseworker can be given an open tour or placement
afterwards (the race between the conversion's reads and its write is the same
gap, narrower). Then: `deriveTenantStatus` (`statusTransition.ts:335`) writes
TENANT statuses (searching, placing, ...) onto whatever contact a placement
names, a caseworker included; and a tour reopened after a conversion has NO
reminder thread - the conversion re-typed the contact's thread to
`partner_1to1`, and reminders look only for `tenant_1to1` or `unknown_1to1`
(`jobs/tourReminders.ts:1093`, `routes/tourReminders.ts:1027`), so every rung
finds no conversation. The same holds for the conversion's other two
refusals (plan review R1 ruling A4): a property's landlord of record and its
contact list. The units routes set `landlordId` (create, and the unit PATCH -
`app/src/routes/units.ts`, validated only as a non-empty string by
`app/src/lib/unitFields.ts`) without reading that contact's type, and the
roster edits (`app/src/services/rosterEdits.ts`, which pass the owner's type
through but never check the added contact's) add any contact to a
property's contact list - so after a conversion refused "landlord of
record" or "on a property's contact list", staff can make the caseworker
exactly that. Pre-existing guard gaps; accepted for branch B.

**Suggested fix.** Refuse a tour or placement whose tenant is not typed
`tenant` (or `unknown`, for triage) on create and reopen, with a sentence
naming the contact's kind; make `deriveTenantStatus` skip a contact that is
not a tenant. Decide (Sam and Cameron) whether a caseworker may be a
property's landlord of record or sit on its contact list: if not, the unit
create / PATCH `landlordId` write and the roster add refuse a contact for
which `isCaseworker` (`app/src/lib/caseworkers.ts`) holds, with a sentence
naming why. Related: `contact-retype-skips-caseworker-refusals`.
```

Step 4 - `docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md`:

```md
---
id: extraction-in-flight-writes-onto-converted-caseworker
title: An extraction run in flight can write tenant facts or new suggestions onto a contact just converted to a caseworker
type: bug
severity: low
status: open
area: app/extraction
created: <BUILD-DATE>
refs: app/src/jobs/extraction.ts:457, app/src/services/extraction/apply.ts, app/src/services/caseworkerConversion.ts
---

**Problem.** Extraction skips a `partner` contact when a run STARTS
(`jobs/extraction.ts:457`), and the caseworker conversion (`feat/caseworkers`,
spec D19) supersedes every pending suggestion when it converts. But a run
that read the contact while it was still a tenant or unknown applies its
writes afterwards, unconditionally against its run-start snapshot - no
condition on the contact's type or classification revision. So in that
window (one run, seconds) a just-converted caseworker can gain a housing
authority the conversion removed on purpose, other tenant facts, or new
pending suggestions that will never resolve (a partner is never extracted
again). Accepted for branch B. RUNBOOK ("Caseworkers") says how to clean up:
`make` again supersedes the suggestions; an AI-written housing authority is
removed by hand.

**Suggested fix.** Make the apply layer's contact writes and suggestion
puts conditional on the run-start `classification_revision` (the fence the
conversion bumps, as the type drain already is), or re-read the contact's
type before applying and drop the run's output when it is no longer a
tenant or unknown.
```

Step 5 - `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`:

```md
---
id: imported-unknown-threads-surface-as-unknown-on-today
title: A reply on an imported contact's unknown_1to1 thread shows on Today as a new unknown contact, whatever the contact's type
type: bug
severity: low
status: open
area: app/today
created: <BUILD-DATE>
refs: app/src/lib/import/apply.ts, app/src/routes/today.ts, dashboard/src/routes/today/buildToday.ts, app/src/routes/contacts.ts
---

**Problem.** The importer mints every imported one-to-one thread as
`unknown_1to1` (`upsertConversation` in `app/src/lib/import/apply.ts`,
`if_not_exists`), even for a contact it typed tenant, landlord or partner,
and never re-types a thread. Only a contacts PATCH that CHANGES the type
flips an `unknown_1to1` thread (the triage flip), so an imported contact the
importer already typed keeps an `unknown_1to1` thread indefinitely. Today
decides by the THREAD type alone: an unread `unknown_1to1` thread becomes a
"New unknown contact" needs-you-now row (`app/src/routes/today.ts`, the
`conv.type === 'unknown_1to1'` branch; `buildToday.ts` the same), so a reply
from an imported tenant or partner - including a reply to a property share,
which now reaches partners too (`feat/caseworkers`, spec D20) - is presented
as an untriaged stranger. The caseworker conversion re-types a converted
caseworker's own threads to `partner_1to1`, so it fixes this for caseworkers
only. Pre-existing; verified against the code 2026-10-07. How often it
fires in production is unmeasured.

**Suggested fix.** Measure first: count open `unknown_1to1` threads whose
participant contact is typed tenant, landlord or partner (the
`app/scripts/measure-unread-contact-coverage.ts` pattern). Then either
re-type them once with a script (to `conversationTypeFor(contact)`, skipping
threads another live contact shares), or make the importer mint the
contact's type for a typed contact going forward - or both.
```

Step 6 - `docs/issues/a2p-campaign-covers-caseworker-shares.md`:

```md
---
id: a2p-campaign-covers-caseworker-shares
title: Confirm the registered A2P campaign covers property shares to a voucher holder's caseworker
type: decision
severity: med
status: open
area: compliance
created: <BUILD-DATE>
refs: app/src/routes/broadcasts.ts, app/src/jobs/broadcastFanOut.ts, docs/issues/a2p-compliance-hardening.md
---

**Problem.** `feat/caseworkers` (spec D20) lets staff send a property share
(the address and flyer link) to a partner - in practice a voucher holder's
caseworker - from the partner's page, into the partner's own conversation.
The registered A2P campaign describes listing texts to voucher holders. The
design treats a share to the holder's caseworker as covered (the same
listing content, about a home for that caseworker's client, behind every
existing consent gate: the per-number opt-out, unreachable, deleted, the
kill switch and the just-in-time consent check), but coverage is NOT
confirmed. Cameron, 2026-10-07: branch B ships partner shares anyway; the
campaign question is Sam's.

**Suggested fix.** Sam confirms with the campaign's registration (or
Twilio/TCR support) that texts to a voucher holder's caseworker fall inside
the registered use case. If they do not, amend the campaign description, or
turn partner shares off (the seed and explicit-recipient predicate in
`app/src/routes/broadcasts.ts` goes back to tenants only) until it is.
```

Step 7 - `docs/issues/possible-caseworkers-and-roster-refusal-scans.md`:

```md
---
id: possible-caseworkers-and-roster-refusal-scans
title: The Possible caseworkers read scans three contact partitions, and the conversion's roster refusal scans every unit inside an interactive action
type: improvement
severity: low
status: open
area: app/contacts
created: <BUILD-DATE>
refs: app/src/services/possibleCaseworkers.ts, app/src/services/caseworkerConversion.ts, docs/issues/tours-tabs-load-every-contact-for-names.md, docs/issues/perf-pages-contacts-caseworkers-surface.md
---

**Problem.** Two reads added by `feat/caseworkers` (spec D19) have no index
behind them. `GET /api/contacts/possible-caseworkers` reads the WHOLE
tenant, landlord and partner partitions of the contacts table on every load
of Contacts > Caseworkers (its signals - a role, a notes line, a
relationship row, a partner with no role - are not indexed), then filters in
memory. And the caseworker conversion's roster refusal - is this contact on
any property's contact list? - is one Scan of every unit, deleted units
included, inside the interactive preview and the Make caseworker click.
Both are fine at today's counts; both grow linearly with the data, the
`tours-tabs-load-every-contact-for-names` cost class. The page is also not
profiled (`perf-pages-contacts-caseworkers-surface`).

**Suggested fix.** Revisit when the contact or unit count grows: a sparse
GSI on a server-computed `caseworker_candidate` attribute (written on the
writes that change a signal) for the Possible list; a contact-to-units
roster index (or a reverse `rosterUnitIds` attribute maintained by the
roster routes) for the refusal. Profile the page first.
```

Step 8 - update `docs/issues/staff-notes-on-landlord-partner-files.md`
(planner ruling R4-19: the partner half is built; the landlord half stays
open). Current (`:3`):

```md
title: Staff notes card exists only on the tenant file; landlord and partner files may want it too
```

Replace with:

```md
title: Staff notes card exists on the tenant and partner files only; the landlord file may want it too
```

Current (`:8`):

```md
created: 2026-09-26
```

Replace with:

```md
created: 2026-09-26
updated: <BUILD-DATE>
```

Then append at the end of the file (after the "Note (build research,
2026-09-27)" paragraph, one blank line between):

```md
**Update (<BUILD-DATE>, `feat/caseworkers`).** The PARTNER half is built:
`PartnerFile` renders `StaffNotesCard` above its "Preferences & notes" card,
wired to `onContactUpdated` (caseworkers spec D19 - a tenant converted to a
caseworker keeps its staff notes visible; Cameron confirmed 2026-10-07).
Still open: `LandlordFile` (and the `UnknownFile` question) - ask Sam before
building.
```

Step 9 - checks:

`cd "W:/tmp/caseworkers"; for f in docs/issues/contact-retype-skips-caseworker-refusals.md docs/issues/tours-placements-no-contact-type-check.md docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md docs/issues/a2p-campaign-covers-caseworker-shares.md docs/issues/possible-caseworkers-and-roster-refusal-scans.md; do tr -d '\11\12\15\40-\176' < "$f" | wc -c; done`
-> `0` six times.

`cd "W:/tmp/caseworkers"; git diff -U0 -- docs/issues/staff-notes-on-landlord-partner-files.md | grep '^+' | grep -nP '[^\x00-\x7F]'`
-> prints nothing.

`cd "W:/tmp/caseworkers"; npm run issues` -> prints its summary, lists the
six new ids as open (and `perf-pages-contacts-caseworkers-surface` from
S8 Task 8.13), and prints no warning naming any of them. `docs/issues/INDEX.md`
is gitignored: never stage it.

Commit `docs(issues): file the caseworkers follow-ups; staff notes now on the partner file` (stage the seven paths explicitly).

### Task 10.13 - the whole e2e suite on the new world

No file is planned to change; this task catches any pin the research
missed (the B-sensitive specs it watches hardest: conversation-fact-extraction
- the Unknown card now has five actions; contact-detail - More actions gains
an item; org-lists - the usage UI; environment-identity - one more nav tab
stop; every share spec).

Step 1 - run the whole suite once, in the BACKGROUND (Bash tool
`run_in_background: true`; it takes 20-40 minutes):
`cd "W:/tmp/caseworkers"; npm run e2e`
Do not edit app or dashboard source and do not start another e2e run while
it runs.

Expected: the list reporter's last lines show `0 failed` (the suite count is
main's plus the 7 new tests: caseworkers.spec.ts 4, partner-share.spec.ts 1,
contact-create's Caseworker preset 1, org-lists' organization value 1 - Task
10.8a).

Step 2 - only if something failed:
- Re-run the failing file alone (`npm run e2e -w @housingchoice/e2e -- <file>`).
- If it reads a share label, a contact-list or nav name, the usage wire, or
  a Possible-list / Caseworkers-tab count: fix it the way Tasks 6.5, 9.1-9.4 and 10.2 did
  (neutral wording per plan 3.9, `exact: true` past the Caseworkers names,
  run-unique rows only), run that file green, commit
  `test(e2e): <spec name> on the caseworkers world`, then re-run the whole
  suite.
- Anything else is a regression to report to the orchestrator, never to
  re-run and excuse (AGENTS.md: there is no named-flake list).
- After an aborted run: `npm run e2e:stop` and confirm no listener survives
  on the lane's ports before the next run.

No commit when the suite is green.


### Task 10.14 - sync main once, then the five completion gates, bare (AGENTS.md "Required completion gates")

Plan review R1 ruling B10. The LAST task before handback; nothing else runs
in this worktree meanwhile (no e2e session, no other suite). Every gate runs
BARE - never piped, never `;`-chained into another command, its exit code
read directly. Record each gate's command, exit code and counts for the
handback.

Step 1 - sync `main` into the branch, ONCE (AGENTS.md; never move `HEAD` in
the shared main checkout - this merge happens in `W:/tmp/caseworkers`):

- `git -C "W:/tmp/caseworkers" status` - clean, and no MERGE_HEAD:
  `ls "$(git -C "W:/tmp/caseworkers" rev-parse --git-dir)/MERGE_HEAD"` reports
  no such file.
- `git -C "W:/tmp/caseworkers" log --oneline HEAD..main` - what main added
  since the branch's last sync. Empty -> skip to Step 2.
- `git -C "W:/tmp/caseworkers" merge-tree --write-tree HEAD main` - a
  conflict listed here that touches work another agent has in flight: STOP
  and ask before syncing (AGENTS.md). Otherwise:
  `git -C "W:/tmp/caseworkers" merge main -m "Merge branch 'main' into feat/caseworkers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
  On conflicts: resolve each preserving BOTH sides' intent (the plan's text
  for this branch, main's for its own change), `git status` (read it), stage
  the resolved paths explicitly, commit the merge with the same message.
- If the merge changed any `package-lock.json` / `package.json`:
  `cd "W:/tmp/caseworkers"; npm ci`.

Step 2 - gate 1: `cd "W:/tmp/caseworkers"; npm run typecheck` -> exit 0.

Step 3 - gate 2: `cd "W:/tmp/caseworkers"; npm test` (DynamoDB Local up -
`npm run db:start`; it FAILS rather than skips without it) -> exit 0. A red
DynamoDB-suite file: re-run-and-compare (re-run the failing FILE alone more
than once - `cd "W:/tmp/caseworkers/app"; npx vitest run test/<file>`; run
the full suite at the merge base; compare failing FILES, not cases; report
both runs). Any `[dynamoAdmin]` line is one real container fault: capture
its `err.$metadata.httpStatusCode` and `attempts` first. Never
`ALLOW_SKIP_DYNAMO_TESTS=1` here - that is not a gate.

Step 4 - gate 3: `cd "W:/tmp/caseworkers"; npm run smoke` -> exit 0 (the
compiled app's imports resolve under plain Node).

Step 5 - gate 4: the whole e2e suite under a hard outer timeout, in the
BACKGROUND (Bash tool `run_in_background: true`):
`cd "W:/tmp/caseworkers"; timeout 2700 npm run e2e`
-> exit 0, the list reporter's last lines `0 failed`. Exit 124 = the 45-minute
budget fired: `cd "W:/tmp/caseworkers"; npm run e2e:stop`, confirm no listener
survives on the lane's ports, and report (a stall is a TRACE question, not a
log one - AGENTS.md). Never edit source and never start another suite while
it runs. A failure is a regression to diagnose (there is no named-flake
list), handled as Task 10.13 Step 2.

Step 6 - gate 5: no NEW lint errors in the files this branch touched -
the branch's own `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` files against the EXPLICIT
merge base (after Step 1's sync that is main's tip). In the Bash tool:

```bash
cd "W:/tmp/caseworkers"
BASE=$(git merge-base main HEAD)
echo "merge base: $BASE"
FILES=$(git diff --name-only --diff-filter=d "$BASE"...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
if [ -z "$FILES" ]; then echo "GATE 5: EMPTY FILE LIST - STOP"; else npx eslint $FILES; fi
```

- EMPTY-list guard: this branch changes `.ts`/`.tsx` files, so an empty list
  means the base is wrong (e.g. `main` was already fast-forwarded to this
  branch, or the diff ran unstaged): STOP and report. NEVER run `npx eslint`
  with no path arguments - it lints the whole repo and fails on the 23
  pre-existing `react-hooks/*` errors (AGENTS.md).
- Exit 0 -> done. Errors reported -> attribute them by BASELINE, never by
  line number: for each reported file that exists at `$BASE`, lint the base
  version - `git show "$BASE:<file>" | npx eslint --stdin --stdin-filename <file>`
  (a pipe is fine here: this is attribution, not the gate's exit code) - and
  compare. An error present now and absent at the base is THIS branch's and
  BLOCKING (fix it, commit, re-run gate 5); an error in a file that is new on
  this branch is always this branch's. Pre-existing errors stay unfixed and
  are NAMED in the handback.
- Known hole: the config lints `.ts`/`.tsx` only - a green result on a
  `.mjs`/`.js` file checked nothing.

Step 7 - nothing to commit unless a gate forced a fix (each fix its own
commit: `git status` first, explicit paths, the trailer). If a fix touched
app or dashboard source, re-run gates 1-5 from Step 2. Hand back with the
sync's result and each gate's command, exit code and counts, and any
pre-existing lint errors named.
