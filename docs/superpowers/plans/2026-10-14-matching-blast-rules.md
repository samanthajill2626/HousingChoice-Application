# Implementation plan - Matching blasts follow the audience rules (tracker #6)

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`
  (revision 5, APPROVED by Cameron 2026-10-14). Decisions are cited D1-D10,
  D3a, D3b.
- Branch `feat/matching-blast-rules`, worktree `W:\tmp\matching-blast-rules`,
  cut from main @a2b3d80d. Mission records:
  `docs/superpowers/reviews/2026-10-14-matching-blast-rules/`.
- Spec review: 3 rounds, CLOSED (round 3 terminal) -
  `docs/superpowers/reviews/2026-10-14-matching-blast-rules/design-review/adjudications.md`.
- Status: PLAN v1 (assembled 2026-10-14). Sections 0-4 are BINDING; slice sections 5-8 are
  the four opus section drafts, verbatim; section 4 (assembly rulings) wins over
  any slice text it contradicts. The drafts themselves (gitignored, under
  `.superpowers/sdd/plan-drafts/`) are never the authority.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case.
- Commits: a separate `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for a pre-existing file with non-ASCII, only ADDED lines must be ASCII.
  (Several existing dashboard strings use an em dash; do not add new ones.)
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - verify any
  literal backslash-u with `grep -n '\\u'` after the edit.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`, e2e only through
  the e2e workspace (`npm run e2e`, or `npm run e2e:session` + the
  Playwright MCP). Never pipe a test or gate command.
- Never touch the live stack (`:5174` / `:8080`). Do not restart the shared
  DynamoDB Local container (it wipes local data) - ask the human.
- Never edit dashboard/app source while this worktree's e2e suite runs (it
  serves the source live).

## 1. Global constraints (copied from the spec)

- FILTER-resolved audience = tenants with `status` `searching` or
  `onboarding` only, read from `byTypeStatus` partitions in the order
  `searching`, then `onboarding`; the existing page bound and truncation
  flag stay. The `byHousingAuthority` GSI and
  `contactsRepo.listByHousingAuthority` STAY (not deleted, not re-pointed);
  the resolver simply stops calling it. (D1, section 4)
- `audience_filter.housing_authorities?: string[]`, any-of against the
  tenant's trimmed `housingAuthority`; empty/absent = no authority filter.
  While non-empty, a tenant with a missing or non-member authority does not
  match and is not listed. At most 100 members (400 otherwise). Members
  checked with `orgNames.checkList('audience_filter', list, undefined,
  undefined)`; first failing member -> today's 422 `org_not_on_list` body
  (field `audience_filter`, `text` = that member). LEGACY body string
  `housing_authority` accepted when `housing_authorities` is absent; both
  present -> 400. Stored drafts carry `housing_authorities` only. (D2)
- Every response that carries a filter sends `housing_authorities` (present
  only when non-empty) and NEVER `housing_authority`; the server normalizes
  legacy rows; the dashboard has no normalizer. (D2)
- Tour holds (D4 table): `scheduled` + scheduledAt > now -> `upcoming`;
  `scheduled` + scheduledAt <= now or missing -> `not_marked`; `toured` +
  `convertible === true` -> `needs_placement`; `toured` + no outcome ->
  `needs_outcome`; `no_show` -> `no_show`; `requested` created less than
  336 h before now -> `requested`; anything else no hold. One hold per
  tenant by kind order `needs_placement, upcoming, needs_outcome,
  not_marked, no_show, requested`; within `upcoming` earliest `at`, others
  latest `at`; ties by `tourId`. Keyed on the tour's `tenantId`, any contact
  type.
- `checkedByDefault = hasConsent && (seeded || (!alreadySent && !declined && !held))`
  - ONE server rule (D5). Client-side exception: a row added or promoted by
  Add a tenant takes `checkedByDefault = hasConsent` from that moment.
- Open-tours read: `byStatus` partitions `scheduled`, `toured`, `no_show` to
  the end + `requested` with `createdAt >= now - 14 days`; unbounded like
  the auto-close sweep; only a THROWN error is a failed read. (D5)
- Filter draft preview: a throwing tours or decline read -> 503
  `{ error: 'audience_rules_unavailable' }`. Seeds-only preview: serve rows
  without tour/decline labels + `audienceRulesUnavailable: true`.
  `declineLabelsUnavailable` is removed. (D5)
- Send (a) and (b) unchanged; (c) = resolved audience minus held minus
  effective declines (already-sent and no-consent NOT subtracted); a thrown
  rules read -> 503; truncation refused as today; the recipient cap counts
  the final set; empty -> 400 `empty_audience`. (D6)
- `estimatedCount` (POST create) = count of `checkedByDefault` rows; a
  seeds-only create makes NO rules reads (count = seeds with consent); a
  thrown rules read on a filter draft -> draft created, `estimatedCount`
  omitted, stored `stats.audience` 0. (D8)
- Property picker: `available` only on every entry that shows it; a
  `?unitId=` preselection keeps any status + today's banner and Make
  Available dialog. (D9)
- Partners never resolve from a filter (type fence, pinned by tests). (D10)
- Prefill (D3, D3a): composer reads the org list; prefills the property's
  `authoritiesOf(unit)` mapped by exact name or unique spelling to entry
  names (property order, de-duplicated); unmapped names shown as "Not used";
  voucher size keeps "first accepted size". Edits are owned while the
  property stays; a change to a DIFFERENT property empties both filters at
  once and prefills on load, no confirm; the same property again changes
  nothing. Preview disabled until settled ONLY with a property attached and
  filters on; a failed property load or list read settles with its notice;
  an aborted load is neither; resumed drafts and seeds-only are never gated.
  A 422 removes only the named member (counts as an edit).

### 1.1 Exact copy (BINDING - tests assert these strings)

- Picker label: `Housing authorities` (was `Housing authority`).
- Caption (filters on), sentence 1 and 3 always, sentence 2 only while the
  authority list is non-empty, joined by single spaces:
  1. `Only tenants in Onboarding or Searching are included.`
  2. `While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.`
  3. `Add any other tenant by hand when you review recipients.`
- Prefill notes: `Not used (not on the organization list): <names joined by ", ">`
  and, when none mapped, followed by ` This blast is not limited by housing authority.`
- Property load failed: `Couldn't load the property, so its housing authorities and voucher size were not filled in.`
- Org list failed: `Couldn't load the organization list, so housing authorities were not filled in from the property.`
- 422 member removed: `<text> is no longer on the organization list, so it was removed from the filter.`
- 503 on compose: `Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.` + button `Try again`.
- Seeds-only notice: `Tour and Not interested labels couldn't be loaded.`
- Truncation alert (review): `Too many tenants to read - some matches may be missing from this list.`
- Reach suffix: ` - the list is incomplete`
- Server truncation message: `audience resolution was truncated (more than ${MAX_BROADCAST_RECIPIENTS} candidates) - the audience could not be read completely`
- Picker empty state: `No Available properties. A property must be Available to send.`
- Tour labels (`<d>` = `shortDate(at)`, e.g. `Oct 20`; with no `at` drop
  the date and the space before it):
  `upcoming` `Tour <d>`; `not_marked` `Tour <d>, not marked`;
  `needs_outcome` `Toured <d>, needs outcome`; `needs_placement`
  `Toured <d>, needs placement`; `no_show` `No show <d>`; `requested`
  `Tour requested <d>`.
- Checkbox accessible name: no-consent row `<name> - consent not recorded`
  (unchanged); otherwise `<name>` plus, when any cue applies, ` - ` and the
  cues joined by `, ` in order `already sent`, `not interested`, then the
  tour label LOWER-CASED (e.g. `Ana Diaz - already sent, not interested, tour oct 20`).
- Add a tenant option note: cues in order `Not interested`, `Already sent`,
  tour label (as displayed), joined by `, `.
- `audienceSummary` for a list: names joined by `, `.

## 2. Binding interfaces

Names, signatures and wire shapes below are BINDING across slices. A
section writer who finds one wrong against the code raises a CONTRACT ISSUE
at the top of its draft instead of silently deviating.

### 2.1 App: `app/src/lib/blastAudienceRules.ts` (NEW, pure, no I/O)

```ts
import type { AudienceFilter } from '../repos/broadcastsRepo.js';

/** D4: a tour request holds for 14 days (336 h) from its createdAt. */
export const TOUR_REQUEST_HOLD_MS = 14 * 24 * 60 * 60 * 1000;
/** D1: the statuses a filter blast reads, IN READ ORDER. */
export const BLAST_TENANT_STATUSES = ['searching', 'onboarding'] as const;
/** D2: shape guard on audience_filter.housing_authorities. */
export const MAX_FILTER_AUTHORITIES = 100;

export type TourHoldKind =
  | 'needs_placement' | 'upcoming' | 'needs_outcome' | 'not_marked' | 'no_show' | 'requested';
export const TOUR_HOLD_KIND_ORDER: readonly TourHoldKind[] =
  ['needs_placement', 'upcoming', 'needs_outcome', 'not_marked', 'no_show', 'requested'];

export interface TourHold { kind: TourHoldKind; tourId: string; at?: string }

/** The tour fields the rule reads (a stored TourItem satisfies it). */
export interface TourHoldInput {
  tourId: string; tenantId: string; status: unknown;
  scheduledAt?: unknown; createdAt?: unknown; outcome?: unknown; convertible?: unknown;
}

/** D4 table for ONE tour. An unparseable scheduledAt counts as missing
 *  (`not_marked`, no `at`); an unparseable createdAt on a request -> no hold. */
export function tourHoldOf(tour: TourHoldInput, nowMs: number): TourHold | undefined;
/** D4 tie-break: kind order; upcoming earliest `at`; others latest `at`
 *  (a missing `at` loses); then tourId ascending. */
export function pickTourHold(holds: readonly TourHold[]): TourHold | undefined;
/** Group by tenantId, one picked hold per tenant. */
export function tourHoldsByTenant(tours: readonly TourHoldInput[], nowMs: number): Map<string, TourHold>;

export interface DefaultCheckFlags {
  hasConsent: boolean; seeded: boolean; alreadySent: boolean; declined: boolean; held: boolean;
}
/** D5: hasConsent && (seeded || (!alreadySent && !declined && !held)). */
export function checkedByDefault(f: DefaultCheckFlags): boolean;

/** D2 normalizer - the ONLY reader of a stored filter's authorities:
 *  housing_authorities (trimmed, blanks dropped, de-duplicated) when present,
 *  else the legacy housing_authority string as one member, else []. */
export function authoritiesOfFilter(
  filter: Pick<AudienceFilter, 'housing_authorities' | 'housing_authority'> | undefined,
): string[];

/** D2 wire shape: never housing_authority; housing_authorities only when non-empty. */
export interface WireAudienceFilter {
  contact_type: 'tenant';
  housing_authorities?: string[];
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}
export function wireAudienceFilter(filter: AudienceFilter): WireAudienceFilter;
```

### 2.2 App: `AudienceFilter` (`app/src/repos/broadcastsRepo.ts:84-90`)

```ts
export interface AudienceFilter {
  contact_type: 'tenant';
  /** D2 (2026-10-14): any-of housing authorities; absent/empty = no filter. */
  housing_authorities?: string[];
  /** @deprecated LEGACY stored shape (drafts saved before 2026-10-14). Read
   *  ONLY through authoritiesOfFilter; never written by new code. */
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}
```

### 2.3 App: `toursRepo.listByStatus`

```ts
listByStatus(status: string, opts?: { createdAtFrom?: string }): Promise<TourItem[]>;
```
With `createdAtFrom`, the key condition becomes `#st = :st AND #ca >= :from`
(`createdAt` is the byStatus range key). Without it, behavior is byte-for-byte
today's. Every fake `toursRepo` that implements `listByStatus` (the harness
fake `app/test/helpers/twilioWebhookHarness.ts:3964` at least; grep for the
rest) models the option.

### 2.4 App: the resolver (`app/src/services/audienceResolution.ts`)

Signature and `ResolvedAudience` shape unchanged. Reads
`contacts.listByType('tenant', { status, limit: pageSize, exclusiveStartKey })`
for each of `BLAST_TENANT_STATUSES` in order; `maxPages` bounds the TOTAL
pages across both; `truncated` is true when the cap stops the walk with any
page still unread (in the current partition or a later one). The authority
filter is `authoritiesOfFilter(filter)`: empty -> no filter; else the
tenant's trimmed `housingAuthority` must be a member. All other fences
unchanged. The log line drops `byHousingAuthority` and reports
`authorities: <count>`.

### 2.5 App: router internals (`app/src/routes/broadcasts.ts`)

```ts
/** Thrown when the open-tours or decline read fails for a filter draft. */
class AudienceRulesUnavailableError extends Error {}

/** D5 read: four listByStatus calls in parallel; throws on any failure. */
async function readOpenTourHolds(nowMs: number): Promise<Map<string, TourHold>>;

interface ReviewInput {
  audienceMode: BroadcastAudienceMode;   // 'filter' | 'seeds_only'
  filter: AudienceFilter;
  seedContactIds: string[];
  unitId?: string;
}
interface ReviewRow extends ResolvedContact {
  seeded: boolean; alreadySent: boolean; declined: boolean;
  tourHold?: TourHold; checkedByDefault: boolean;
}
interface ReviewRowsResult {
  rows: ReviewRow[];                      // audience rows first, then seeds not already present
  truncated: boolean;
  unresolvedSeedIds: string[];
  priorRecipients: Set<string>;           // contactKeys, as today
  declinedIds: Set<string>;
  tourHolds: Map<string, TourHold>;       // EVERY held contact (for tourHolds on the wire)
  rulesUnavailable: boolean;              // true only for a seeds_only preview whose reads threw
}
/** ONE rule for preview and create (D5, D8).
 *  - filter draft: resolve + seeds; read priorRecipients, declines (when
 *    unitId), open-tour holds; a thrown tours/decline read throws
 *    AudienceRulesUnavailableError.
 *  - seeds_only + 'preview': same reads; a throw sets rulesUnavailable and
 *    serves rows without tour/decline flags.
 *  - seeds_only + 'estimate': NO rules or prior-recipient reads; rows are the
 *    seeds, checkedByDefault = has_consent. */
async function buildReviewRows(input: ReviewInput, mode: 'preview' | 'estimate'): Promise<ReviewRowsResult>;
```
`effectiveDeclines`, `resolveSeeds`, `priorRecipientKeys` and
`storedFilterRefusal` keep their roles; `storedFilterRefusal` checks every
member of `authoritiesOfFilter(filter)`.

### 2.6 App: wire

- POST `/api/broadcasts` body `audience_filter`: `{ contact_type?: 'tenant',
  housing_authorities?: string[], housing_authority?: string (legacy),
  bedroomSize?: number }`. 400 `audience_filter.housing_authorities must be an array of at most 100 strings`
  (not an array, a non-string member, or more than 100); 400
  `audience_filter: use housing_authorities only` (both keys). 422
  `org_not_on_list` (first failing member). 201 `{ broadcastId, status:
  'draft', estimatedCount?: number, audience_filter: WireAudienceFilter,
  truncated: boolean, flyerUrl? }` - `estimatedCount` omitted when a rules
  read threw.
- POST `/api/broadcasts/:id/preview` 200 adds per candidate
  `tourHold?: TourHold` and `checkedByDefault: boolean` (keeps
  `declinedThisProperty`, `alreadySentThisProperty`, `seeded`, ...); top level
  `tourHolds: Array<{ contactId: string } & TourHold>` and
  `audienceRulesUnavailable?: true`; `declineLabelsUnavailable` REMOVED.
  503 `{ error: 'audience_rules_unavailable' }` for a filter draft.
- POST `/api/broadcasts/:id/send` path (c): 503
  `{ error: 'audience_rules_unavailable' }` on a thrown rules read; the
  truncation message per 1.1.
- GET results / list: `audience_filter` is `wireAudienceFilter(stored)`.

### 2.7 Dashboard: `dashboard/src/api/types.ts`

```ts
export interface AudienceFilter {
  contact_type: 'tenant';
  /** Any-of housing authorities (exact organization-list names). */
  housing_authorities?: string[];
  bedroomSize?: number;
}
export type TourHoldKind =
  | 'needs_placement' | 'upcoming' | 'needs_outcome' | 'not_marked' | 'no_show' | 'requested';
export interface TourHold { kind: TourHoldKind; tourId: string; at?: string }
// PreviewCandidate += tourHold?: TourHold; checkedByDefault: boolean;
// PreviewResponse  += tourHolds: Array<{ contactId: string } & TourHold>;
//                     audienceRulesUnavailable?: true;   (declineLabelsUnavailable removed)
// createBroadcast response: estimatedCount?: number (was required)
```
`BroadcastSummary.audience_filter` / `BroadcastResults.audience_filter` use
the same `AudienceFilter` (wire shape).

### 2.8 Dashboard: new helpers

```ts
// dashboard/src/routes/broadcasts/tourHoldLabel.ts (NEW)
export function tourHoldLabel(hold: TourHold): string;   // 1.1 strings, shortDate

// dashboard/src/routes/broadcasts/authorityPrefill.ts (NEW)
/** D3: map each property authority by exact name or unique spelling
 *  (settleTypedOrgText(list, ['housing_authority'], a), orgCopy.ts:248),
 *  property order, de-duplicated. `unused` = the ones that do not resolve. */
export function prefillAuthorities(
  propertyAuthorities: readonly string[],
  list: OrgListView,
): { names: string[]; unused: string[] };
```

## 3. Slices and task numbering

Order S1 -> S2 -> S3 -> S4. Each slice ends green on its own unit suites and
`npm run typecheck`. The e2e suite is NOT expected green until S4 (stated
mid-build breakage: after S2 the dashboard still sends the legacy
`housing_authority` string, which the server accepts; it reads no tour
holds yet; existing Matching e2e specs start failing on the status rule
from S1 and on the prefill from S3 - S4 repairs them; from S1 until Task
3.1 the dashboard's `audienceSummary` shows no authority, AR5).

- **S1 - App foundations** (Tasks 1.1-1.5): the pure rules module (2.1);
  `AudienceFilter` type (2.2); `toursRepo.listByStatus` option + every fake
  (2.3); the resolver (2.4, D1, D2, D10 pins); `parseAudienceFilter`, POST
  create's list check and legacy body, `storedFilterRefusal` over a list,
  and the results / list / create-echo projections through
  `wireAudienceFilter`.
- **S2 - App rules in the routes** (Tasks 2.1-2.5): `readOpenTourHolds` +
  `buildReviewRows` (2.5); preview (fields, `tourHolds`, 503, seeds-only
  degrade, remove `declineLabelsUnavailable`); POST create's estimate (D8);
  send path (c) (D6); the full-profile seed broadcasts (one legacy, one
  list) and the server comments section 7 of the spec names (ALONE
  comments, the `byHousingAuthority` comments - correct, never delete the
  GSI or the method).
- **S3 - Dashboard** (Tasks 3.1-3.6): types + endpoints + `audienceSummary`;
  `tourHoldLabel` + `RecipientPreview` (server `checkedByDefault`, hand-pick
  case, tags, accessible name, option note, seeds-only notice, truncation
  alert, remove the decline-unavailable notice); `AudienceFilters`
  (multi picker, caption, notes, truncation suffix); `prefillAuthorities`;
  `BroadcastComposer` (org list, prefill ownership, property change, settle
  gate, 422 member removal, 503 Try again); Available-only picker.
- **S4 - e2e, docs, completion** (Tasks 4.1-4.5): repair the existing
  Matching specs per the spec section 7 ruling (run-unique authorities,
  explicit status, consent - with the a2p no-consent exception) and
  `e2e/support/selectors.md`; the new e2e spec; GLOSSARY, RUNBOOK, issue
  registry (resolve the truncation issue; no GSI issue); the five gates;
  the single main sync; the handback.

## 4. Assembly rulings (planner, BINDING over the section text below)

Each section writer raised CONTRACT ISSUES at the top of its draft (kept
below as written). Rulings:

- **AR1 (S1-CI1) Dependencies.** The planner ran `npm ci` at the worktree
  root on 2026-10-14 (exit 0; the `install-scripts` warning for esbuild /
  protobufjs is known and harmless). S1's preflight stays as a check.
- **AR2 (S1-CI2) DynamoDB Local.** Every app `npx vitest run` - even a pure
  file - needs DynamoDB Local (`app/test/globalSetup.ts`); start it with
  `npm run db:start` if it is not up (a START is fine; never RESTART the
  shared container). `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY for a
  pure-file red/green step, never for a gate.
- **AR3 (S1-CI3) Parse edge cases** - ACCEPTED as drafted: `null` counts as
  absent for both keys; the legacy key keeps today's 400
  `audience_filter.housing_authority must be a non-empty string`; the
  both-keys 400 is checked before either value's shape; the 100-member cap
  counts the raw array.
- **AR4 (S1-CI4) Resolver status belt** - ACCEPTED: a row whose `status` is
  not its partition's is skipped (pinned by a test). "All other fences
  unchanged" in 2.4 is amended by this one addition.
- **AR5 (S1-CI5) Mid-build breakage** - ACCEPTED, added to section 3: from S1
  until Task 3.1 the dashboard's `audienceSummary` shows no authority (it
  still reads `housing_authority`); nothing asserts it.
- **AR6 (S2-CI1) `AudienceRulesUnavailableError`** carries
  `readonly truncated: boolean` and the constructor
  `(truncated: boolean, options?: ErrorOptions)`, so POST create can still
  answer `truncated` when it omits the estimate. Amends 2.5.
- **AR7 (S2-CI2) `readAudienceRules(unitId, nowMs)`** - a private router
  closure returning `{ tourHolds, declinedIds }` (throws on a failed read),
  shared by `buildReviewRows` and send path (c). Amends 2.5.
- **AR8 (S2-CI3) Over-cap message** (count above the cap, not truncated):
  `audience of ${count} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`
  (keeps the advice - narrowing does reduce the count; ASCII hyphen). Amends
  1.1. The TRUNCATION message stays as 1.1 gives it.
- **AR9 (S2-CI4) Router header split.** S1 Task 1.5 owns
  `broadcasts.ts:14-28` (the "Audience:" and "Organization names"
  paragraphs, as S1 drafted). S2 Task 2.5 owns the endpoint lines `:6-12`
  and only ADDS the tour-hold / fail-closed sentence to S1's "Audience:"
  text, never rewriting it.
- **AR10 (S2-CI5) Extra stale comment** `contactsRepo.ts:1396-1397` - S2
  corrects it. `dev.ts:1263` and `lean.ts:109` only gain a "kept, not read
  by blasts" note. The GSI and `listByHousingAuthority` code are untouched.
- **AR11 (S2-CI6, S4-CI1) TDD exceptions.** A comment-only task (2.5) uses
  its `git grep` gate as RED/GREEN. Task 4.2 (the new e2e spec, over
  behavior S1-S3 shipped) proves its assertions with the RED-by-mutation
  step it describes. Tasks 4.3-4.5 (docs, gates, sync, handback) have no
  test step.
- **AR12 (S2-CI7) 503 scope** - ACCEPTED: the fail-closed 503 applies to any
  preview of a broadcast whose `audience_mode` is not `seeds_only`, whatever
  its status (the dashboard previews only drafts). Path (c) reads the rules
  even for an empty or truncated resolution, so a failed rules read
  outranks the empty and truncation refusals (all leave the draft a draft).
- **AR13 (S3-CI1) Prefill while the list is unknown** -
  `prefillAuthorities` returns `{ names: [], unused: [] }` while the list is
  loading, or failed with nothing in hand (the settle gate and the
  list-failed notice cover those states). Signature unchanged.
- **AR14 (S3-CI2) "Not limited" line** shows only while NONE of the
  property's authorities mapped AND the filter list is empty (staff may
  have picked one by hand). Strings unchanged.
- **AR15 (S3-CI3) Transitional types** - Task 3.1 keeps
  `housing_authority?` and `declineLabelsUnavailable?` as temporary optional
  fields so the typecheck stays green; Tasks 3.2 / 3.3 delete them. The final
  types equal 2.7.
- **AR16 S3 design choices** (recorded, binding): the composer reads the org
  list once and passes it to `AudienceFilters` as a prop
  (`orgList: OrgListView`); the prefill is COMPUTED DURING RENDER from the
  property and the list, and state holds only staff edits keyed to the
  property they were made for (no prefill effect - nothing can overwrite an
  edit); the property load is stored with the id it was for, an
  `AbortError` is neither loaded nor failed; the property pick handler
  empties both filters when a DIFFERENT property is picked. S3 adds no new
  lint error (it removes 2 of the 4 existing `set-state-in-effect` errors in
  `BroadcastComposer.tsx`).
- **AR17 (S4-CI2) e2e outer timeout** - the full suite runs under
  `timeout 2700` (this host's last two full runs took 22.4 and 23.3 min);
  per-file runs keep `timeout 1500`.
- **AR18 (S4-CI3) Sync order** - AGENTS.md's order wins: Task 4.4 first
  checks `git rev-list --count HEAD..main`; if main has moved, merge main
  into the branch ONCE (preserving both sides; ask the planner via a
  QUESTION if a conflict touches an S1-S3 decision), re-run the unit suites
  that cover any conflicted file, and only then run the five gates once on
  the post-sync tree. The reported gates are always post-sync.
- **AR19 Lint backlog count.** If gate 5's baseline comparison shows the
  branch REMOVED pre-existing errors (S3 expects 23 -> 21), Task 4.3
  updates the count in `docs/issues/lint-backlog-repo-wide.md` and in
  AGENTS.md's gate 5 paragraph to the measured number with the date - only
  the number and date, nothing else in AGENTS.md.
- **AR20 422 member text.** The server's 422 `text` is the trimmed member;
  the dashboard removes the member whose trimmed value equals `text`.
- **AR21 Slice anchors.** S2-S4 were drafted against main @a2b3d80d with S1
  assumed done. Where a task's old_string no longer matches because an
  earlier slice changed the region, re-read the current text and apply the
  same change ON TOP of it - never revert an earlier slice. Line numbers are
  hints; the quoted text is the anchor.

### 4.1 Plan review round 1 rulings (BINDING; adjudications in
### `docs/superpowers/reviews/2026-10-14-matching-blast-rules/plan-review/adjudications.md`)

- **AR22 (R1-B1, R1-A5) The draft-delete e2e test.**
  `e2e/tests/dashboard-next/broadcasts.spec.ts` "compose a draft, see it in
  the Drafts list, delete it" (`:398-440`) joins Task 4.1's repair list
  (and the F16-F21 inventory): it must not capture the FIRST
  `POST /api/broadcasts`. Repair: wait until the `Preview recipients`
  button is enabled (the settle gate plus a current draft), and take the
  draft id from the LAST create response received by then (record every
  create response with `page.on('response', ...)`, read the last). AR23
  removes the race at the source; the repair keeps the test robust anyway.
- **AR23 (R1-B2) No draft while the prefill is unsettled.** In Task 3.5,
  while `prefillPending` is true (the gate's own scope: a property attached,
  filters on, not a resumed draft), the composer creates NO draft: add a
  `hold?: boolean` input to `useComposerDraft` that, when true, makes no
  create (and deletes nothing) and reports `reachPending: true`, so the
  reach line shows its existing pending hint. Add dashboard tests: with the
  org list unresolved, `createBroadcast` is not called and the reach line is
  pending; once the list resolves, exactly ONE create is made and it carries
  the prefilled `housing_authorities`.
- **AR24 (R1-B3) Picker empty state only once loaded.** Task 3.6 shows
  `No Available properties. A property must be Available to send.` only
  after the units read has settled (track a loaded flag beside
  `unitCandidates`); while loading, today's loading behavior stays. The
  Task 3.6 empty-state test waits for `getAllUnits` to resolve before
  asserting, and a sibling assertion proves a non-Available unit is absent
  AFTER load.
- **AR25 (R1-B4, R1-A6) Clear the 503 alert on change.** The compose-step
  `audience_rules_unavailable` alert (and its Try again) is cleared wherever
  the other compose notices reset: any filter change, message change,
  property pick or change, and whenever the draft key changes. Add a test:
  after a 503, changing the voucher size removes the alert.
- **AR26 (R1-B5) Late preview results.** While a Preview is in flight
  (`previewBusy`), the `Change` property button is disabled (as the filters
  already are). Belt: `rejectAuthority` ignores a 422 whose captured
  property id no longer equals the current one. Add a test for the
  disabled Change button during a pending preview.
- **AR27 (R1-A1, R1-B6) Where the lint count update happens** (replaces
  AR19's placement). It is the LAST step of Task 4.4, after gate 5: if the
  gate-5 baseline comparison shows the branch removed pre-existing errors,
  run `npm run lint` bare from the worktree root (a measurement, not a
  gate; capture its output to `.superpowers/lint-repo.log` and read the
  `N problems (N errors, M warnings)` summary), then edit ONLY the count,
  file count and date in AGENTS.md's gate 5 sentence ("as of 2026-10-07
  `npm run lint` reports 23 errors across 18 dashboard files") and the
  matching count in `docs/issues/lint-backlog-repo-wide.md`, and commit
  those two files alone (docs-only; the gates need not re-run). If nothing
  was removed, skip it.
- **AR28 (R1-A2) Sync before gates is MUST.** Task 4.4 Step 0 is not
  optional: check `git rev-list --count HEAD..main` first; if main moved,
  sync once per AR18 before any gate. The full gate script runs once.
- **AR29 (R1-A3) DynamoDB Local.** S1's preflight "ask the human before
  `npm run db:start`" is superseded by AR2: START it if it is not up; never
  RESTART it. An unattended build must not stall on this.
- **AR30 (R1-A4) S2's shell.** S2's command blocks are PowerShell
  (`cd W:\...;`, `@'...'@` here-string commit messages): run them with the
  PowerShell tool as written.
- **AR31 (R1-B7) Task 4.1 Step 3's closing grep** prints the TWO comment
  lines from steps 3b and 3h, not one.
- **AR32 (R1-B8) Server truncation message** (amends 1.1 and AR8's note):
  `audience resolution was truncated - the audience could not be read completely`
  (no candidate count - the resolver's read bound is pages x page size, not
  the recipient cap). Every test asserting it uses this exact string.

## 5. S1 - App foundations (Tasks 1.1-1.5)

# S1 - App foundations (Tasks 1.1-1.5) - section draft

Draft for plan `docs/superpowers/plans/2026-10-14-matching-blast-rules.md`
section 5 (S1). Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`
(revision 5). Worktree `W:\tmp\matching-blast-rules`, branch
`feat/matching-blast-rules`. All paths below are relative to the worktree
root unless absolute.

### CONTRACT ISSUES

1. **The worktree has no dependencies installed.** Verified 2026-10-14:
   `W:/tmp/matching-blast-rules/node_modules`, `app/node_modules`,
   `dashboard/node_modules` and `e2e/node_modules` do not exist, so no
   `npx vitest` / `npm run typecheck` step in any slice can run. Section 0
   does not say who installs. Proposed fix: add to section 0 "Before Task 1.1,
   run `npm ci` once at the worktree root (never symlink another worktree's
   node_modules)". The preflight below carries it.

2. **Every app `npx vitest run test/<file>` needs DynamoDB Local, even for a
   pure file.** `app/vitest.config.ts` runs `globalSetup: './test/globalSetup.ts'`,
   which FAILS LOUD when DynamoDB Local is unreachable (`app/test/globalSetup.ts:17`,
   `:65-72`); `ALLOW_SKIP_DYNAMO_TESTS=1` is the deliberate unit-only escape.
   Section 0 says only "run app tests from app/ with npx vitest run". Proposed
   fix: section 0 states "DynamoDB Local must be up (`npm run db:start`) for
   any app vitest run; for a pure-only file `ALLOW_SKIP_DYNAMO_TESTS=1` may be
   prefixed, never for a gate". The tasks below say which runs need it.

3. **Section 2.6 leaves three parse cases unstated.** This draft rules them,
   for the planner to bless or change: (a) `housing_authorities: null` reads
   as ABSENT (as `bedroomSize: null` does today, `broadcasts.ts:157`), and so
   does `housing_authority: null` (today's rule, `broadcasts.ts:150`); (b) the
   LEGACY key keeps today's own 400 `audience_filter.housing_authority must be
   a non-empty string` for a non-string or blank value (`broadcasts.ts:151-153`);
   (c) "both present" means both non-null, and is checked BEFORE either
   value's shape (so `{housing_authorities: 'x', housing_authority: 'y'}` is
   the "use housing_authorities only" 400). The 100-member cap counts the RAW
   array (before blanks and duplicates are dropped).

4. **Section 2.4 says "All other fences unchanged"; this draft adds one
   belt.** The resolver also skips a row whose `status` is not the
   partition's own status (`contact.status !== status`), next to the existing
   type fence. Against a correct index it never fires (the partition is the
   status); it keeps D1 "nothing else" true against a broken/leaky index and
   is what stops a leaky index from returning a tenant twice (once per
   partition). Pinned by a test. Proposed: accept (strike the line in Task
   1.3 and its test if not).

5. **Section 3's stated mid-build breakage is incomplete.** From S1 on, the
   results and list projections answer `housing_authorities` and never
   `housing_authority`, and the dashboard's `audienceSummary`
   (`dashboard/src/routes/broadcasts/broadcastFormat.ts:61-68`) reads only
   `housing_authority`, so the Broadcasts list rows and the results header
   lose their "- <authority>" part until S3 Task 3.1. No e2e asserts that text
   (grep `Tenants - ` in `e2e/tests`: no hit), so nothing goes red; it is a
   visible UI gap mid-build. Proposed: add it to section 3's stated
   breakage.

6. (Not an issue, recorded so no one re-checks it.) The binding
   `BLAST_TENANT_STATUSES = ['searching', 'onboarding'] as const` gains
   `satisfies readonly TenantStatus[]` in Task 1.1 - same type, a compile-time
   guard that the two names are real tenant statuses
   (`app/src/lib/statusModel.ts:140-148`).

### Facts the tasks rely on (verified)

Against `feat/matching-blast-rules` @9a945ec1 (= main @a2b3d80d plus docs).

- `AudienceFilter` is `app/src/repos/broadcastsRepo.ts:84-90` with its doc
  comment at `:77-83`; lines 77-90 are ASCII. The repo stores the filter as
  given (`broadcastsRepo.ts:729`); the harness fake does the same by
  reference (`app/test/helpers/twilioWebhookHarness.ts:3702`).
- `parseAudienceFilter` is `app/src/routes/broadcasts.ts:140-171`; its doc
  comment is `:134-139`, and `:136` holds a non-ASCII dash, so edits anchor at
  `:137`. Lines 137-171 are ASCII.
- POST create: parse at `:592`; the org-name check is `:635-650`
  (`orgNames.checkScalar`), the estimate `:652-667` (S2 replaces it), the 201
  echo `audience_filter: created.audience_filter` at `:697-699`. Lines
  635-704 are ASCII; `:571` (the route's header comment) is not.
- `storedFilterRefusal` is `:536-567` and reads ONLY `filter?.housing_authority`
  (`:550`); called at preview `:729-736` and send path (c) `:985-990`.
  Lines 536-567 are ASCII.
- The results and list projections pass `b.audience_filter` raw at `:393`
  (`toBroadcastResults`, `:384-404`) and `:421` (`toBroadcastSummary`,
  `:416-431`); the same line text appears at both, so each edit anchors on
  the comment line after it. Both ASCII.
- Router header `:14-28` (audience + organization names) is ASCII; `:1`,
  `:6-9`, `:11` hold non-ASCII (S2's endpoint lines).
- `orgNames.checkList(field, next, current, legacyJurisdiction)` is the
  SERVICE method (`app/src/services/orgNames.ts:218-223`, `:258-264`; one
  list read per call). It delegates to the lib's `checkListWrite`
  (`app/src/lib/orgNames.ts:302-326` - the spec's citation names this
  function): members trimmed, blanks dropped, each checked with
  `checkScalarWrite` and the FIRST failing member's error returned as is
  (`:319-320`), whose `text` is that trimmed member (`:281`, `:288`,
  `notOnList` `:255-265`); resolved names de-duplicated, first wins (`:323`).
- The org list in every harness world is the starting list
  (`app/test/helpers/orgListFake.ts:34-41`, `get` is an OWN property of the
  returned object, so `vi.spyOn(world.orgListRepo, 'get')` intercepts the
  service's `list.get()`). In it (`app/src/lib/orgStartingList.ts`): `DCA` is a
  spelling of ONLY `Georgia Department of Community Affairs` (`:21-23`);
  `AHA` is a spelling of both `Atlanta Housing Authority` (`:16-18`) and
  `Augusta Housing Authority` (`:63`) - ambiguous; `atlanta_housing`
  normalizes to the spelling `Atlanta Housing`; `Step Up` is an agency
  (`:76`); `DeKalb County Housing Authority` and `Decatur Housing Authority`
  are names (`:33-37`).
- The resolver walk is `app/src/services/audienceResolution.ts:123-191`; the
  `byHousingAuthority` branch `:127-138` is the only runtime caller of
  `listByHousingAuthority`; the truncation TODO is `:139-148`; the type fence
  `:154-159`; the log line with `byHousingAuthority` `:205-213`. The file has
  non-ASCII on many lines (em dashes, section signs) - Task 1.3 rewrites it
  whole, in ASCII.
- `contactsRepo.listByType(type, { status, limit, exclusiveStartKey })`:
  `ListContactsOpts.status` (`app/src/repos/contactsRepo.ts:657-661`) becomes
  `AND #s = :s` on the byTypeStatus key (`:1351-1356`); the default scope
  hides soft-deleted contacts (`:1360-1363`).
- `app/test/helpers/contactsPartitionFake.ts` `listByTypeFromContacts(contacts,
  type, opts)` (`:100-200`): honors `opts.status` as a key condition (`:111`),
  sorts by `status` then `contactId` (`:116-122`), mints
  `lastEvaluatedKey = { type, status, contactId }` whenever a page REACHED the
  limit (`:188-198`), throws on a resume key naming another type (`:160-166`),
  hides soft-deleted rows by default (`:181-182`).
- The harness contacts fake `listByType` (`twilioWebhookHarness.ts:2322-2358`)
  honors `status` (`:2327`) and returns SEED-ARRAY order; the harness wires the
  REAL resolver over `world.contactsRepo` (`:5641-5646`).
- Tours: `byStatus` GSI is hash `status`, range `createdAt`
  (`app/src/lib/tables.ts:546-550`). `toursRepo.listByStatus(status)` doc
  `app/src/repos/toursRepo.ts:214-219` (`:216` non-ASCII, `:217-219` ASCII),
  impl `:436-455` (ASCII). `TourItem.createdAt: string` (`:149`), index
  signature `[key: string]: unknown` (`:151`); `CreateTourInput` accepts
  `createdAt` (`:160-166`) and `create` honors it (`:368`; the harness fake
  too, `twilioWebhookHarness.ts:3931`).
- The ONLY implementers of tours `listByStatus` are the real repo and the
  harness fake (`twilioWebhookHarness.ts:3964-3969`, ASCII). Callers:
  `app/src/jobs/tourAutoClose.ts:77`, `app/src/routes/tours.ts:452`, tests.
  `app/test/tourAutoClose.test.ts:473-477` wraps the fake's method with a
  one-argument function - harmless (auto-close never passes opts).
- `app/test/toursRepo.integration.test.ts:439-444` (ASCII) is the last
  listByStatus case before the conversion-claim block (`:446-449`, non-ASCII
  at `:447`). It needs DynamoDB Local (self-skips without it).
- `app/test/repoPagingWiring.test.ts:23-37` shows the fake-doc pattern
  (`cmd.input` is the QueryCommand input); `createToursRepo({ doc, logger })`
  needs no env (`:79`).
- Test files are typechecked: `app/package.json:13` runs
  `tsc -p tsconfig.test.json` (includes `test` and `src`), strict with
  `noUncheckedIndexedAccess` (`tsconfig.base.json`).
- `app/test/broadcastApi.test.ts`: `seedTenant` defaults `status: 'searching'`
  (`:65`) and recorded consent (`:69`); its comment `:62-64` says the
  resolver does not filter on status (`:62` non-ASCII, `:63-64` ASCII). Every
  contact a filter test resolves uses that default; the only other statuses
  in the file are landlords, partners and an unknown (`:974`, `:1008`,
  `:2379`, `:2468-2470`, `:2487`), none a filter candidate. The org-names
  describe is `:2171-2367` (all ASCII): `filterFor` `:2172-2178`, the
  exact-name test `:2197-2206`, the spelling test `:2208-2222`, the PIN
  `:2250-2267`; the next block's first line `:2369`
  (`  // --- caseworkers (spec 2026-10-06 D20, plan 3.7): a seed or an explicit`)
  is unique and ASCII. `createDraft` is `:820-827`. The first test after the
  create test is `:248` (`share-skip-fix D4 ...`, ASCII).
- Other app suites that drive the broadcasts routes use searching tenants
  only: `contactsBatchReads.test.ts:61-72`, `contactsBatchIncomplete.test.ts:192-199`,
  `followUpsApi.test.ts:22`.
- `app/test/seedOrgNames.test.ts:84-89` and `:141-146` read the seeded
  broadcasts' `housing_authority`; S1 changes no seed, so they stay green
  (S2's seed change breaks them - see Notes).
- `createLogger` defaults to `process.env.LOG_LEVEL ?? 'info'`
  (`app/src/lib/logger.ts:180`); pino's message key is `msg`
  (`app/test/aiRunsRepo.test.ts:978`). The log test passes `level: 'info'`.
- Tenant statuses: `needs_review, onboarding, searching, placing, placed,
  on_hold, inactive` (`app/src/lib/statusModel.ts:140-148`).

### Preflight (once, before Task 1.1)

Git Bash, from anywhere:

```bash
cd "W:/tmp/matching-blast-rules" && git status && git log --oneline -1
```

Expect a clean tree on `feat/matching-blast-rules`. Then install (no pipe):

```bash
cd "W:/tmp/matching-blast-rules" && npm ci
```

Confirm DynamoDB Local answers (needed by every app vitest run, see contract
issue 2) - do NOT restart the shared container:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000
```

Any HTTP code (400 is normal) means it is up. If nothing answers, ask the
human before `npm run db:start`.

---

### Task 1.1 - The pure rules module and the `AudienceFilter` list type (plan 2.1, 2.2)

**Files**
- Create: `app/test/blastAudienceRules.test.ts`
- Create: `app/src/lib/blastAudienceRules.ts`
- Modify: `app/src/repos/broadcastsRepo.ts:77-90`

**Step 1 - write the failing test.** Create `app/test/blastAudienceRules.test.ts`
with exactly:

```ts
// matching-blast-rules (spec docs/superpowers/specs/
// 2026-10-14-matching-blast-rules-design.md) - the pure rules module
// app/src/lib/blastAudienceRules.ts: D1 read order, D2 the authority-list
// normalizer and the wire shape, D4 the tour hold rule (every row of the
// table, its boundaries, the pick among several, the per-tenant map), D5 the
// default-checked rule. No I/O, no clock.
import { describe, expect, it } from 'vitest';
import {
  authoritiesOfFilter,
  BLAST_TENANT_STATUSES,
  checkedByDefault,
  MAX_FILTER_AUTHORITIES,
  pickTourHold,
  TOUR_HOLD_KIND_ORDER,
  TOUR_REQUEST_HOLD_MS,
  tourHoldOf,
  tourHoldsByTenant,
  wireAudienceFilter,
  type DefaultCheckFlags,
  type TourHold,
  type TourHoldInput,
  type TourHoldKind,
} from '../src/lib/blastAudienceRules.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';

const HOUR = 60 * 60 * 1000;
const NOW_ISO = '2026-10-14T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const iso = (ms: number): string => new Date(ms).toISOString();
/** 2026-10-09 and 2026-10-20 at noon UTC: a past and a future tour date. */
const AT_PAST = iso(NOW - 5 * 24 * HOUR);
const AT_FUTURE = iso(NOW + 6 * 24 * HOUR);

/** The fields the rule reads; defaults to a scheduled tour with no date. */
function tour(over: Partial<TourHoldInput>): TourHoldInput {
  return { tourId: 'tour-1', tenantId: 'c-1', status: 'scheduled', ...over };
}

/** A WHOLE stored tour. Passing it where a TourHoldInput is expected is the
 *  binding claim "a stored TourItem satisfies it" - checked by
 *  `npm run typecheck`, which compiles app/test. */
function storedTour(over: Partial<TourItem>): TourItem {
  const created = iso(NOW - 30 * 24 * HOUR);
  return {
    tourId: 'tour-1',
    tenantId: 'c-1',
    unitId: 'unit-1',
    _schedPartition: 'tours',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

describe('blast audience rules - constants (D1, D2, D4)', () => {
  it('reads searching then onboarding; holds a request 336 hours; caps the list at 100; orders the hold kinds', () => {
    expect(BLAST_TENANT_STATUSES).toEqual(['searching', 'onboarding']);
    expect(TOUR_REQUEST_HOLD_MS).toBe(336 * HOUR);
    expect(MAX_FILTER_AUTHORITIES).toBe(100);
    expect(TOUR_HOLD_KIND_ORDER).toEqual([
      'needs_placement',
      'upcoming',
      'needs_outcome',
      'not_marked',
      'no_show',
      'requested',
    ]);
  });
});

describe('authoritiesOfFilter - the ONE reader of a stored filter authorities (D2)', () => {
  it('no filter, or a filter naming no authority, is the empty list', () => {
    expect(authoritiesOfFilter(undefined)).toEqual([]);
    expect(authoritiesOfFilter({})).toEqual([]);
  });

  it('a list is trimmed, blanks dropped and de-duplicated - first wins, order kept', () => {
    expect(
      authoritiesOfFilter({ housing_authorities: [' HA-B ', '', 'HA-A', 'HA-B', '   ', 'HA-A '] }),
    ).toEqual(['HA-B', 'HA-A']);
  });

  it('a stored non-string member is ignored', () => {
    const odd = ['HA-A', 7, null] as unknown as string[];
    expect(authoritiesOfFilter({ housing_authorities: odd })).toEqual(['HA-A']);
  });

  it('LEGACY: the one-string housing_authority is a one-member list (trimmed); a blank one is no filter', () => {
    expect(authoritiesOfFilter({ housing_authority: ' Atlanta Housing Authority ' })).toEqual([
      'Atlanta Housing Authority',
    ]);
    expect(authoritiesOfFilter({ housing_authority: '   ' })).toEqual([]);
  });

  it('a present list wins over a legacy string, even an empty list', () => {
    expect(authoritiesOfFilter({ housing_authorities: ['HA-A'], housing_authority: 'HA-OLD' })).toEqual(['HA-A']);
    expect(authoritiesOfFilter({ housing_authorities: [], housing_authority: 'HA-OLD' })).toEqual([]);
  });
});

describe('wireAudienceFilter - the filter shape every response carries (D2)', () => {
  it('a LEGACY row answers housing_authorities and never housing_authority; size and booleans pass through as stored', () => {
    const legacy: AudienceFilter = {
      contact_type: 'tenant',
      housing_authority: 'Atlanta Housing Authority',
      bedroomSize: 2,
      excludeOptedOut: true,
      excludeUnreachable: false,
    };
    const wire = wireAudienceFilter(legacy);
    expect(wire).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
      excludeOptedOut: true,
      excludeUnreachable: false,
    });
    expect(wire).not.toHaveProperty('housing_authority');
  });

  it('a list row answers its normalized list', () => {
    const listed: AudienceFilter = {
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', ' Decatur Housing Authority '],
      excludeOptedOut: true,
      excludeUnreachable: true,
    };
    expect(wireAudienceFilter(listed)).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', 'Decatur Housing Authority'],
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
  });

  it('no authority (absent, or an empty list) and no size: neither key is sent', () => {
    const filters: AudienceFilter[] = [
      { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      { contact_type: 'tenant', housing_authorities: [], excludeOptedOut: true, excludeUnreachable: true },
    ];
    for (const filter of filters) {
      const wire = wireAudienceFilter(filter);
      expect(wire).toEqual({ contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true });
      expect(wire).not.toHaveProperty('housing_authorities');
      expect(wire).not.toHaveProperty('bedroomSize');
    }
  });
});

describe('tourHoldOf - the D4 table for ONE tour', () => {
  const cases: Array<[string, TourHoldInput, TourHold | undefined]> = [
    [
      'scheduled later than now -> upcoming, dated by scheduledAt',
      tour({ status: 'scheduled', scheduledAt: AT_FUTURE }),
      { kind: 'upcoming', tourId: 'tour-1', at: AT_FUTURE },
    ],
    [
      'scheduled 1 ms after now -> upcoming (boundary)',
      tour({ status: 'scheduled', scheduledAt: iso(NOW + 1) }),
      { kind: 'upcoming', tourId: 'tour-1', at: iso(NOW + 1) },
    ],
    [
      'scheduled at exactly now -> not_marked (boundary)',
      tour({ status: 'scheduled', scheduledAt: NOW_ISO }),
      { kind: 'not_marked', tourId: 'tour-1', at: NOW_ISO },
    ],
    [
      'scheduled in the past -> not_marked, dated',
      tour({ status: 'scheduled', scheduledAt: AT_PAST }),
      { kind: 'not_marked', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'scheduled with no scheduledAt -> not_marked, no date',
      tour({ status: 'scheduled' }),
      { kind: 'not_marked', tourId: 'tour-1' },
    ],
    [
      'scheduled with an unreadable scheduledAt -> not_marked, no date',
      tour({ status: 'scheduled', scheduledAt: 'not-a-date' }),
      { kind: 'not_marked', tourId: 'tour-1' },
    ],
    [
      'toured + convertible (Move forward, no placement yet) -> needs_placement',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'move_forward', convertible: true }),
      { kind: 'needs_placement', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured + convertible with no date -> needs_placement, no date',
      tour({ status: 'toured', convertible: true }),
      { kind: 'needs_placement', tourId: 'tour-1' },
    ],
    [
      'toured with no outcome -> needs_outcome',
      tour({ status: 'toured', scheduledAt: AT_PAST }),
      { kind: 'needs_outcome', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured with no outcome and convertible false -> needs_outcome',
      tour({ status: 'toured', scheduledAt: AT_PAST, convertible: false }),
      { kind: 'needs_outcome', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'toured with a null outcome -> needs_outcome (null is no outcome)',
      tour({ status: 'toured', outcome: null }),
      { kind: 'needs_outcome', tourId: 'tour-1' },
    ],
    [
      'toured with an outcome, not convertible (Not a fit left toured) -> no hold',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'not_a_fit', convertible: false }),
      undefined,
    ],
    [
      'toured with outcome no_outcome -> no hold',
      tour({ status: 'toured', scheduledAt: AT_PAST, outcome: 'no_outcome' }),
      undefined,
    ],
    [
      'no_show -> no_show, dated',
      tour({ status: 'no_show', scheduledAt: AT_PAST }),
      { kind: 'no_show', tourId: 'tour-1', at: AT_PAST },
    ],
    [
      'no_show with no date -> no_show, no date',
      tour({ status: 'no_show' }),
      { kind: 'no_show', tourId: 'tour-1' },
    ],
    [
      'requested 1 hour old -> requested, dated by createdAt',
      tour({ status: 'requested', createdAt: iso(NOW - HOUR) }),
      { kind: 'requested', tourId: 'tour-1', at: iso(NOW - HOUR) },
    ],
    [
      'requested 1 ms short of 336 hours old -> requested (boundary)',
      tour({ status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS + 1) }),
      { kind: 'requested', tourId: 'tour-1', at: iso(NOW - TOUR_REQUEST_HOLD_MS + 1) },
    ],
    [
      'requested exactly 336 hours old -> no hold (boundary)',
      tour({ status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS) }),
      undefined,
    ],
    [
      'requested 20 days old -> no hold',
      tour({ status: 'requested', createdAt: iso(NOW - 20 * 24 * HOUR) }),
      undefined,
    ],
    [
      'requested with an unreadable createdAt -> no hold',
      tour({ status: 'requested', createdAt: 'nope' }),
      undefined,
    ],
    ['requested with no createdAt -> no hold', tour({ status: 'requested' }), undefined],
    ['canceled -> no hold', tour({ status: 'canceled', scheduledAt: AT_FUTURE }), undefined],
    [
      'closed (Not a fit) -> no hold',
      tour({ status: 'closed', scheduledAt: AT_PAST, outcome: 'not_a_fit' }),
      undefined,
    ],
    [
      'closed after a conversion (convertible) -> no hold',
      tour({ status: 'closed', scheduledAt: AT_PAST, outcome: 'move_forward', convertible: true }),
      undefined,
    ],
    ['an unknown status -> no hold', tour({ status: 'confirmed', scheduledAt: AT_FUTURE }), undefined],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    const hold = tourHoldOf(input, NOW);
    expect(hold).toEqual(expected);
    if (expected !== undefined && expected.at === undefined) expect(hold).not.toHaveProperty('at');
  });

  it('a stored TourItem is a TourHoldInput: toured + convertible with a PENDING conversion claim is needs_placement', () => {
    const claimed = storedTour({
      status: 'toured',
      scheduledAt: AT_PAST,
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
      convertedPlacementId: 'pending:3f1c2b',
      conversionClaimedAt: iso(NOW - HOUR),
    });
    expect(tourHoldOf(claimed, NOW)).toEqual({ kind: 'needs_placement', tourId: 'tour-1', at: AT_PAST });
  });
});

describe('pickTourHold - the ONE hold shown (D4 tie-break)', () => {
  it('no holds -> undefined', () => {
    expect(pickTourHold([])).toBeUndefined();
  });

  it('the kind order decides first: needs_placement, upcoming, needs_outcome, not_marked, no_show, requested', () => {
    const all: TourHold[] = [
      { kind: 'requested', tourId: 't-6', at: iso(NOW - HOUR) },
      { kind: 'no_show', tourId: 't-5', at: AT_PAST },
      { kind: 'not_marked', tourId: 't-4', at: AT_PAST },
      { kind: 'needs_outcome', tourId: 't-3', at: AT_PAST },
      { kind: 'upcoming', tourId: 't-2', at: AT_FUTURE },
      { kind: 'needs_placement', tourId: 't-1' },
    ];
    TOUR_HOLD_KIND_ORDER.forEach((kind, i) => {
      const remaining = all.filter((h) => TOUR_HOLD_KIND_ORDER.indexOf(h.kind) >= i);
      expect(pickTourHold(remaining)?.kind).toBe(kind);
    });
  });

  it('within upcoming the EARLIEST date wins', () => {
    const pick = pickTourHold([
      { kind: 'upcoming', tourId: 't-a', at: '2026-10-20T15:00:00.000Z' },
      { kind: 'upcoming', tourId: 't-b', at: '2026-10-18T15:00:00.000Z' },
      { kind: 'upcoming', tourId: 't-c', at: '2026-10-25T15:00:00.000Z' },
    ]);
    expect(pick?.tourId).toBe('t-b');
  });

  it('within every other kind the LATEST date wins', () => {
    const kinds: TourHoldKind[] = ['needs_placement', 'needs_outcome', 'not_marked', 'no_show', 'requested'];
    for (const kind of kinds) {
      const pick = pickTourHold([
        { kind, tourId: 't-early', at: '2026-10-01T15:00:00.000Z' },
        { kind, tourId: 't-late', at: '2026-10-09T15:00:00.000Z' },
      ]);
      expect(pick?.tourId, kind).toBe('t-late');
    }
  });

  it('a hold with no date loses to a dated hold of the same kind, whichever comes first', () => {
    expect(
      pickTourHold([
        { kind: 'needs_placement', tourId: 't-a' },
        { kind: 'needs_placement', tourId: 't-b', at: '2026-10-01T15:00:00.000Z' },
      ])?.tourId,
    ).toBe('t-b');
    expect(
      pickTourHold([
        { kind: 'not_marked', tourId: 't-b', at: '2026-10-01T15:00:00.000Z' },
        { kind: 'not_marked', tourId: 't-a' },
      ])?.tourId,
    ).toBe('t-b');
  });

  it('dates compare as INSTANTS, not as strings', () => {
    // 2026-10-09T23:00-05:00 is 2026-10-10T04:00Z - LATER than 01:00Z, though
    // its string sorts first.
    const pick = pickTourHold([
      { kind: 'not_marked', tourId: 't-a', at: '2026-10-10T01:00:00.000Z' },
      { kind: 'not_marked', tourId: 't-b', at: '2026-10-09T23:00:00.000-05:00' },
    ]);
    expect(pick?.tourId).toBe('t-b');
  });

  it('a tie (same date, or both undated) goes to the lower tourId', () => {
    expect(
      pickTourHold([
        { kind: 'no_show', tourId: 't-b', at: AT_PAST },
        { kind: 'no_show', tourId: 't-a', at: AT_PAST },
      ])?.tourId,
    ).toBe('t-a');
    expect(
      pickTourHold([
        { kind: 'not_marked', tourId: 't-b' },
        { kind: 'not_marked', tourId: 't-a' },
      ])?.tourId,
    ).toBe('t-a');
    expect(
      pickTourHold([
        { kind: 'upcoming', tourId: 't-b', at: AT_FUTURE },
        { kind: 'upcoming', tourId: 't-a', at: AT_FUTURE },
      ])?.tourId,
    ).toBe('t-a');
  });
});

describe('tourHoldsByTenant - one picked hold per tenant (D4)', () => {
  it('groups by the tour tenantId and keeps ONE hold each; a tenant with only resolved tours is absent', () => {
    const tours: TourHoldInput[] = [
      tour({ tourId: 't-1', tenantId: 'c-ana', status: 'requested', createdAt: iso(NOW - HOUR) }),
      tour({ tourId: 't-2', tenantId: 'c-ana', status: 'scheduled', scheduledAt: AT_FUTURE }),
      tour({ tourId: 't-3', tenantId: 'c-bo', status: 'closed', outcome: 'not_a_fit' }),
      tour({ tourId: 't-4', tenantId: 'c-bo', status: 'requested', createdAt: iso(NOW - TOUR_REQUEST_HOLD_MS) }),
      tour({ tourId: 't-5', tenantId: 'c-cy', status: 'no_show', scheduledAt: AT_PAST }),
      tour({ tourId: 't-6', tenantId: '', status: 'no_show', scheduledAt: AT_PAST }),
    ];
    const holds = tourHoldsByTenant(tours, NOW);
    expect([...holds.keys()].sort()).toEqual(['c-ana', 'c-cy']);
    expect(holds.get('c-ana')).toEqual({ kind: 'upcoming', tourId: 't-2', at: AT_FUTURE });
    expect(holds.get('c-cy')).toEqual({ kind: 'no_show', tourId: 't-5', at: AT_PAST });
  });

  it('keys on the tour tenantId with no assumption about the contact type (an older tour may name a caseworker)', () => {
    const tours: TourItem[] = [
      storedTour({ tourId: 't-p', tenantId: 'contact-partner-7', status: 'scheduled', scheduledAt: AT_FUTURE }),
    ];
    expect(tourHoldsByTenant(tours, NOW).get('contact-partner-7')).toEqual({
      kind: 'upcoming',
      tourId: 't-p',
      at: AT_FUTURE,
    });
  });
});

describe('checkedByDefault - the ONE default-checked rule (D5)', () => {
  const NONE: DefaultCheckFlags = { hasConsent: true, seeded: false, alreadySent: false, declined: false, held: false };

  it('a consented filter row with no flag starts checked', () => {
    expect(checkedByDefault(NONE)).toBe(true);
  });

  it('already sent, declined and held each leave a filter row unchecked', () => {
    expect(checkedByDefault({ ...NONE, alreadySent: true })).toBe(false);
    expect(checkedByDefault({ ...NONE, declined: true })).toBe(false);
    expect(checkedByDefault({ ...NONE, held: true })).toBe(false);
  });

  it('a hand pick (seed) starts checked whatever its flags', () => {
    expect(checkedByDefault({ ...NONE, seeded: true, alreadySent: true, declined: true, held: true })).toBe(true);
  });

  it('a row without recorded consent is never checked, seed or not', () => {
    expect(checkedByDefault({ ...NONE, hasConsent: false })).toBe(false);
    expect(checkedByDefault({ ...NONE, hasConsent: false, seeded: true })).toBe(false);
  });

  it('all 32 flag combinations: checked exactly when consent and (seeded, or no flag at all)', () => {
    const bools = [false, true];
    for (const hasConsent of bools)
      for (const seeded of bools)
        for (const alreadySent of bools)
          for (const declined of bools)
            for (const held of bools) {
              const flags: DefaultCheckFlags = { hasConsent, seeded, alreadySent, declined, held };
              const expected = hasConsent && (seeded || (!alreadySent && !declined && !held));
              expect(checkedByDefault(flags), JSON.stringify(flags)).toBe(expected);
            }
  });
});
```

**Step 2 - run it RED.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/blastAudienceRules.test.ts
```

Expected: the file FAILS to load - an import-resolution error naming
`../src/lib/blastAudienceRules.js` ("Failed to load url" / "Cannot find
module"); no test runs. (DynamoDB Local must be up for globalSetup; if it is
not and you are only running this pure file, prefix
`ALLOW_SKIP_DYNAMO_TESTS=1 `.)

**Step 3 - widen the stored filter type.** In `app/src/repos/broadcastsRepo.ts`
replace (lines 77-90):

```ts
/**
 * The audience filter SNAPSHOT persisted on the broadcast (M1.8a): tenant
 * contacts, optionally narrowed by housing authority and exact bedroom size.
 * contact_type is fixed 'tenant' for M1.8 (never relay-group rosters); opt-out
 * + unreachable are ALWAYS excluded (the booleans record the intent for the
 * audit trail / future flexibility).
 */
export interface AudienceFilter {
  contact_type: 'tenant';
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}
```

with:

```ts
/**
 * The audience filter SNAPSHOT persisted on the broadcast (M1.8a): tenant
 * contacts - only those in Onboarding or Searching (matching-blast-rules D1,
 * applied by the resolver, not stored here) - optionally narrowed by ANY of a
 * list of housing authorities (D2) and exact bedroom size. contact_type is
 * fixed 'tenant' for M1.8 (never relay-group rosters); opt-out + unreachable
 * are ALWAYS excluded (the booleans record the intent for the audit trail /
 * future flexibility). Read a filter's authorities ONLY through
 * authoritiesOfFilter (lib/blastAudienceRules.ts), which also reads the
 * legacy one-string shape.
 */
export interface AudienceFilter {
  contact_type: 'tenant';
  /** D2 (2026-10-14): any-of housing authorities; absent/empty = no filter. */
  housing_authorities?: string[];
  /** @deprecated LEGACY stored shape (drafts saved before 2026-10-14). Read
   *  ONLY through authoritiesOfFilter; never written by new code. */
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}
```

**Step 4 - create the module.** Create `app/src/lib/blastAudienceRules.ts`
with exactly:

```ts
// Matching blast audience rules - the PURE half (spec
// docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md).
// No I/O and no clock: callers pass `nowMs`. ONE home for the rules the
// resolver, the preview, draft create and send path (c) share, so they
// cannot drift:
//   D1  the tenant statuses a filter blast reads, in read order;
//   D2  the housing authority list: its shape guard, the ONE reader of a
//       stored filter's authorities (authoritiesOfFilter - a legacy
//       one-string row included) and the wire shape every response carries;
//   D4  the tour hold rule: one tour, the pick among several, per tenant;
//   D5  the default-checked rule.
import type { AudienceFilter } from '../repos/broadcastsRepo.js';
import type { TenantStatus } from './statusModel.js';

/** D4: a tour request holds for 14 days (336 h) from its createdAt. */
export const TOUR_REQUEST_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

/** D1: the statuses a filter blast reads, IN READ ORDER (searching first). */
export const BLAST_TENANT_STATUSES = ['searching', 'onboarding'] as const satisfies readonly TenantStatus[];

/** D2: shape guard on audience_filter.housing_authorities. */
export const MAX_FILTER_AUTHORITIES = 100;

/** D4: why a tenant is held (left unchecked by default). */
export type TourHoldKind =
  | 'needs_placement'
  | 'upcoming'
  | 'needs_outcome'
  | 'not_marked'
  | 'no_show'
  | 'requested';

/** D4: the order the ONE shown hold is picked in when a tenant has several. */
export const TOUR_HOLD_KIND_ORDER: readonly TourHoldKind[] = [
  'needs_placement',
  'upcoming',
  'needs_outcome',
  'not_marked',
  'no_show',
  'requested',
];

/** A tour hold: its kind, the tour it comes from, and the date shown (`at`,
 *  an ISO string; absent when the tour has no readable date). */
export interface TourHold {
  kind: TourHoldKind;
  tourId: string;
  at?: string;
}

/** The tour fields the rule reads (a stored TourItem satisfies it). */
export interface TourHoldInput {
  tourId: string;
  tenantId: string;
  status: unknown;
  scheduledAt?: unknown;
  createdAt?: unknown;
  outcome?: unknown;
  convertible?: unknown;
}

/** Epoch ms of a non-empty ISO string, or null (an unreadable date reads as missing). */
function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A hold dated by the tour's scheduledAt when it has a readable one. */
function scheduledHold(kind: TourHoldKind, tour: TourHoldInput): TourHold {
  if (isoMs(tour.scheduledAt) === null) return { kind, tourId: tour.tourId };
  return { kind, tourId: tour.tourId, at: tour.scheduledAt as string };
}

/**
 * D4 table for ONE tour at `nowMs`:
 *   scheduled, scheduledAt later than now           -> upcoming (at = scheduledAt)
 *   scheduled, scheduledAt now or earlier, or none   -> not_marked
 *   toured, convertible === true                     -> needs_placement
 *   toured, no outcome (and not convertible)         -> needs_outcome
 *   no_show                                          -> no_show
 *   requested, created less than 336 h before now    -> requested (at = createdAt)
 *   anything else - canceled, closed (any reason), toured with an outcome
 *   and not convertible, a request 336 h old or older, an unknown status
 *   -> no hold.
 * Every kind but `requested` is dated by scheduledAt when it has one. An
 * unparseable scheduledAt counts as missing (`not_marked`, no `at`); an
 * unparseable or missing createdAt on a request holds nothing. "No outcome"
 * is an outcome that is absent (undefined or null).
 */
export function tourHoldOf(tour: TourHoldInput, nowMs: number): TourHold | undefined {
  switch (tour.status) {
    case 'scheduled': {
      const atMs = isoMs(tour.scheduledAt);
      if (atMs !== null && atMs > nowMs) {
        return { kind: 'upcoming', tourId: tour.tourId, at: tour.scheduledAt as string };
      }
      return scheduledHold('not_marked', tour);
    }
    case 'toured':
      if (tour.convertible === true) return scheduledHold('needs_placement', tour);
      if (tour.outcome === undefined || tour.outcome === null) return scheduledHold('needs_outcome', tour);
      return undefined;
    case 'no_show':
      return scheduledHold('no_show', tour);
    case 'requested': {
      const createdMs = isoMs(tour.createdAt);
      if (createdMs === null || nowMs - createdMs >= TOUR_REQUEST_HOLD_MS) return undefined;
      return { kind: 'requested', tourId: tour.tourId, at: tour.createdAt as string };
    }
    default:
      return undefined;
  }
}

/** Negative when `a` is the better hold to show (the D4 tie-break). */
function compareHolds(a: TourHold, b: TourHold): number {
  const byKind = TOUR_HOLD_KIND_ORDER.indexOf(a.kind) - TOUR_HOLD_KIND_ORDER.indexOf(b.kind);
  if (byKind !== 0) return byKind;
  const aMs = a.at === undefined ? null : isoMs(a.at);
  const bMs = b.at === undefined ? null : isoMs(b.at);
  if (aMs !== bMs) {
    // A missing date loses.
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    // upcoming: the EARLIEST date; every other kind: the LATEST date.
    return a.kind === 'upcoming' ? aMs - bMs : bMs - aMs;
  }
  return a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0;
}

/** D4: the ONE hold shown for a tenant with several - kind order
 *  (TOUR_HOLD_KIND_ORDER); within `upcoming` the earliest `at`, within the
 *  others the latest `at` (a missing `at` loses; dates compare as instants);
 *  then tourId ascending. */
export function pickTourHold(holds: readonly TourHold[]): TourHold | undefined {
  let best: TourHold | undefined;
  for (const hold of holds) {
    if (best === undefined || compareHolds(hold, best) < 0) best = hold;
  }
  return best;
}

/** D4: group by the tour's tenantId - with no assumption about that
 *  contact's type (an older tour may name a non-tenant) - and keep one
 *  picked hold per tenant. A tenant whose tours hold nothing is absent; a
 *  tour with no tenantId is skipped. */
export function tourHoldsByTenant(tours: readonly TourHoldInput[], nowMs: number): Map<string, TourHold> {
  const byTenant = new Map<string, TourHold[]>();
  for (const tour of tours) {
    if (typeof tour.tenantId !== 'string' || tour.tenantId.length === 0) continue;
    const hold = tourHoldOf(tour, nowMs);
    if (hold === undefined) continue;
    const list = byTenant.get(tour.tenantId);
    if (list === undefined) byTenant.set(tour.tenantId, [hold]);
    else list.push(hold);
  }
  const out = new Map<string, TourHold>();
  for (const [tenantId, holds] of byTenant) {
    const picked = pickTourHold(holds);
    if (picked !== undefined) out.set(tenantId, picked);
  }
  return out;
}

/** The flags the D5 rule reads for one review row. */
export interface DefaultCheckFlags {
  hasConsent: boolean;
  seeded: boolean;
  alreadySent: boolean;
  declined: boolean;
  held: boolean;
}

/** D5: hasConsent && (seeded || (!alreadySent && !declined && !held)). A hand
 *  pick (seed) starts checked whatever its flags; a row without recorded
 *  consent never does. */
export function checkedByDefault(f: DefaultCheckFlags): boolean {
  return f.hasConsent && (f.seeded || (!f.alreadySent && !f.declined && !f.held));
}

/** D2 normalizer - the ONLY reader of a stored filter's authorities:
 *  housing_authorities (trimmed, blanks dropped, de-duplicated - first wins,
 *  non-strings ignored) when present, even when empty; else the legacy
 *  housing_authority string (trimmed) as one member; else []. */
export function authoritiesOfFilter(
  filter: Pick<AudienceFilter, 'housing_authorities' | 'housing_authority'> | undefined,
): string[] {
  if (filter === undefined) return [];
  const list: unknown = filter.housing_authorities;
  if (Array.isArray(list)) {
    const out: string[] = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const member = raw.trim();
      if (member === '' || out.includes(member)) continue;
      out.push(member);
    }
    return out;
  }
  const legacy: unknown = filter.housing_authority;
  if (typeof legacy === 'string' && legacy.trim() !== '') return [legacy.trim()];
  return [];
}

/** D2 wire shape: never housing_authority; housing_authorities only when non-empty. */
export interface WireAudienceFilter {
  contact_type: 'tenant';
  housing_authorities?: string[];
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}

/** D2: the filter every response carries (the create echo, the results and
 *  list projections) - normalized through authoritiesOfFilter, so a legacy
 *  row answers its string as a one-member list and the dashboard reads ONE
 *  shape. The booleans pass through as stored. */
export function wireAudienceFilter(filter: AudienceFilter): WireAudienceFilter {
  const housing_authorities = authoritiesOfFilter(filter);
  return {
    contact_type: 'tenant',
    ...(housing_authorities.length > 0 && { housing_authorities }),
    ...(typeof filter.bedroomSize === 'number' && { bedroomSize: filter.bedroomSize }),
    excludeOptedOut: filter.excludeOptedOut,
    excludeUnreachable: filter.excludeUnreachable,
  };
}
```

**Step 5 - run it GREEN.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/blastAudienceRules.test.ts
```

Expected: every test passes (the `it.each` table reports 25 cases).

**Step 6 - typecheck, lint, ASCII.**

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

```bash
cd "W:/tmp/matching-blast-rules" && npx eslint app/src/lib/blastAudienceRules.ts app/src/repos/broadcastsRepo.ts app/test/blastAudienceRules.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && tr -d '\11\12\15\40-\176' < app/src/lib/blastAudienceRules.ts | wc -c && tr -d '\11\12\15\40-\176' < app/test/blastAudienceRules.test.ts | wc -c && git diff -U0 -- app/src/repos/broadcastsRepo.ts | grep -cP '^\+.*[^\x00-\x7F]'
```

Expected: typecheck exits 0; eslint exits 0; the ASCII check prints `0`, `0`,
`0` (the last `grep -c` exits 1 on a zero count - that is the pass).

**Step 7 - commit.** Read the tree first:

```bash
cd "W:/tmp/matching-blast-rules" && git status
```

```bash
test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

Expect `no-merge` and only the three paths below changed. Then:

```bash
cd "W:/tmp/matching-blast-rules" && git add app/src/lib/blastAudienceRules.ts app/test/blastAudienceRules.test.ts app/src/repos/broadcastsRepo.ts && git commit -F - <<'EOF'
feat(app): matching blast rules module - tour holds, default-checked rule, authority list normalizer and wire shape (plan 1.1)

Pure lib/blastAudienceRules.ts (spec D1, D2, D4, D5): BLAST_TENANT_STATUSES,
the D4 hold table with its pick and per-tenant map, checkedByDefault,
authoritiesOfFilter (the one reader of a stored filter, legacy string
included) and wireAudienceFilter. AudienceFilter gains housing_authorities;
housing_authority stays as the deprecated legacy shape.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 1.2 - `toursRepo.listByStatus` `createdAtFrom` and the harness fake (plan 2.3)

**Files**
- Create: `app/test/toursRepoListByStatusRange.test.ts`
- Modify: `app/src/repos/toursRepo.ts:217-219` (interface), `:436-455` (impl)
- Modify: `app/test/helpers/twilioWebhookHarness.ts:3964-3969` (fake)
- Modify: `app/test/toursRepo.integration.test.ts` (one case after `:444`)

**Step 1 - write the failing tests.** Create
`app/test/toursRepoListByStatusRange.test.ts` with exactly:

```ts
// toursRepo.listByStatus `createdAtFrom` (matching-blast-rules plan 2.3, spec
// D5): the open-tours read bounds the `requested` partition by the byStatus
// RANGE key (createdAt >= now - 14 days) in the KEY condition, so the index
// itself limits the read. Without the option the Query must be byte-for-byte
// today's unbounded one (tour auto-close and GET /api/tours?status= use it).
//
// The real repo is driven through a recording doc client (the
// repoPagingWiring.test.ts pattern - no DynamoDB); the harness fake, which
// every broadcastApi preview case runs against, must model the same bound.
// The DynamoDB Local twin is in toursRepo.integration.test.ts.
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

interface Page {
  Items: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}

/** A doc client that serves `pages` in order and records every Query input. */
function recordingDoc(pages: Page[]) {
  const inputs: Array<Record<string, unknown>> = [];
  let call = 0;
  const doc = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      inputs.push(cmd.input);
      const page = pages[call] ?? { Items: [] };
      call += 1;
      return page;
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, inputs };
}

const FROM = '2026-09-30T12:00:00.000Z';

describe('toursRepo.listByStatus createdAtFrom (plan 2.3)', () => {
  it('(PIN) without opts the Query is exactly the unbounded byStatus read', async () => {
    const { doc, inputs } = recordingDoc([{ Items: [{ tourId: 't1' }] }]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByStatus('scheduled');
    expect(rows.map((r) => r.tourId)).toEqual(['t1']);
    expect(inputs).toHaveLength(1);
    const { TableName, ...rest } = inputs[0]!;
    expect(typeof TableName).toBe('string');
    expect(rest).toEqual({
      IndexName: 'byStatus',
      KeyConditionExpression: '#st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': 'scheduled' },
    });
  });

  it('with createdAtFrom the KEY condition bounds the range key: createdAt >= from', async () => {
    const { doc, inputs } = recordingDoc([{ Items: [{ tourId: 't1' }] }]);
    const repo = createToursRepo({ doc, logger });
    await repo.listByStatus('requested', { createdAtFrom: FROM });
    const { TableName, ...rest } = inputs[0]!;
    expect(typeof TableName).toBe('string');
    expect(rest).toEqual({
      IndexName: 'byStatus',
      KeyConditionExpression: '#st = :st AND #ca >= :from',
      ExpressionAttributeNames: { '#st': 'status', '#ca': 'createdAt' },
      ExpressionAttributeValues: { ':st': 'requested', ':from': FROM },
    });
  });

  it('with createdAtFrom it still walks EVERY page, the bound on each', async () => {
    const { doc, inputs } = recordingDoc([
      { Items: [{ tourId: 't1' }], LastEvaluatedKey: { k: 1 } },
      { Items: [{ tourId: 't2' }] },
    ]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByStatus('requested', { createdAtFrom: FROM });
    expect(rows.map((r) => r.tourId)).toEqual(['t1', 't2']);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!['ExclusiveStartKey']).toBeUndefined();
    expect(inputs[1]).toMatchObject({
      KeyConditionExpression: '#st = :st AND #ca >= :from',
      ExpressionAttributeValues: { ':st': 'requested', ':from': FROM },
      ExclusiveStartKey: { k: 1 },
    });
  });

  it('the harness fake models the bound: createdAt >= from (inclusive), in createdAt order', async () => {
    const world = createFakeWorld();
    const make = (createdAt: string) =>
      world.toursRepo.create({ tenantId: 'c-range', unitId: 'u-range', tourType: 'self_guided', createdAt });
    const after = await make('2026-10-05T12:00:00.000Z');
    const before = await make('2026-09-30T11:59:59.999Z');
    const atBound = await make(FROM);
    const bounded = await world.toursRepo.listByStatus('requested', { createdAtFrom: FROM });
    expect(bounded.map((t) => t.tourId)).toEqual([atBound.tourId, after.tourId]);
    const all = await world.toursRepo.listByStatus('requested');
    expect(all.map((t) => t.tourId)).toEqual([before.tourId, atBound.tourId, after.tourId]);
  });
});
```

**Step 2 - run it RED.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/toursRepoListByStatusRange.test.ts
```

Expected: the `(PIN)` passes; the other three FAIL - the two repo cases show
`KeyConditionExpression: '#st = :st'` where `'#st = :st AND #ca >= :from'`
is expected (the option is ignored today); the harness case returns all three
tour ids where two are expected.

**Step 3 - the interface.** In `app/src/repos/toursRepo.ts` replace (lines
217-219; line 216 above them holds a non-ASCII dash and is left alone):

```ts
   * use; volumes are expected to remain low in Phase 1).
   */
  listByStatus(status: string): Promise<TourItem[]>;
```

with:

```ts
   * use; volumes are expected to remain low in Phase 1).
   *
   * `opts.createdAtFrom` (matching-blast-rules D5) adds the RANGE condition
   * `createdAt >= createdAtFrom` to the KEY condition, so the index itself
   * bounds the read - the open-tours read uses it on the `requested`
   * partition, the one that grows with every unbooked request. Without it the
   * Query is byte-for-byte the unbounded one. Every page is still walked.
   */
  listByStatus(status: string, opts?: { createdAtFrom?: string }): Promise<TourItem[]>;
```

**Step 4 - the implementation.** In the same file replace (lines 436-455):

```ts
    async listByStatus(status) {
      // Paginate the byStatus GSI (hash=status, range=createdAt). DynamoDB
      // returns at most 1 MB per page; follow ExclusiveStartKey until exhausted.
      const all: TourItem[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const input: QueryCommandInput = {
          TableName: table,
          IndexName: 'byStatus',
          KeyConditionExpression: '#st = :st',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':st': status },
          ...(lastKey !== undefined && { ExclusiveStartKey: lastKey }),
        };
```

with:

```ts
    async listByStatus(status, opts) {
      // Paginate the byStatus GSI (hash=status, range=createdAt). DynamoDB
      // returns at most 1 MB per page; follow ExclusiveStartKey until exhausted.
      // createdAtFrom (matching-blast-rules D5) adds `createdAt >= :from` to
      // the KEY condition; without it the input is exactly the unbounded one.
      const from = opts?.createdAtFrom;
      const all: TourItem[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const input: QueryCommandInput = {
          TableName: table,
          IndexName: 'byStatus',
          KeyConditionExpression: from === undefined ? '#st = :st' : '#st = :st AND #ca >= :from',
          ExpressionAttributeNames:
            from === undefined ? { '#st': 'status' } : { '#st': 'status', '#ca': 'createdAt' },
          ExpressionAttributeValues: from === undefined ? { ':st': status } : { ':st': status, ':from': from },
          ...(lastKey !== undefined && { ExclusiveStartKey: lastKey }),
        };
```

(The rest of the method - the `doc.send`, the push, the `while` - is
unchanged.)

**Step 5 - the harness fake.** In `app/test/helpers/twilioWebhookHarness.ts`
replace (lines 3964-3969):

```ts
    async listByStatus(status) {
      return [...toursMap.values()]
        .filter((t) => t.status === status)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((t) => ({ ...t }));
    },
```

with:

```ts
    async listByStatus(status, opts) {
      // byStatus GSI mirror: hash `status`, range `createdAt` (ascending, the
      // Query's order). createdAtFrom is a KEY condition on the range key
      // (createdAt >= from), as toursRepo.listByStatus sends it; ISO strings
      // compare the way DynamoDB compares S keys (matching-blast-rules 2.3).
      const from = opts?.createdAtFrom;
      return [...toursMap.values()]
        .filter((t) => t.status === status)
        .filter((t) => from === undefined || t.createdAt >= from)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map((t) => ({ ...t }));
    },
```

**Step 6 - the DynamoDB Local twin.** In `app/test/toursRepo.integration.test.ts`
replace (lines 439-444):

```ts
  it('listByStatus returns empty array for a status with no matching tours', async () => {
    const result = await tours.listByStatus('no_show');
    // no_show tours may or may not exist from other tests, but this call
    // should not throw - it may return any non-error result
    expect(Array.isArray(result)).toBe(true);
  });
```

with:

```ts
  it('listByStatus returns empty array for a status with no matching tours', async () => {
    const result = await tours.listByStatus('no_show');
    // no_show tours may or may not exist from other tests, but this call
    // should not throw - it may return any non-error result
    expect(Array.isArray(result)).toBe(true);
  });

  it('listByStatus with createdAtFrom reads only rows at or after the bound (matching-blast-rules plan 2.3)', async () => {
    // The fake twin is in toursRepoListByStatusRange.test.ts - keep them in step.
    const from = '2026-09-30T12:00:00.000Z';
    const make = (createdAt: string) =>
      tours.create({ tenantId: 'contact-range-1', unitId: 'unit-range-1', tourType: 'self_guided', createdAt });
    const before = await make('2026-09-30T11:59:59.999Z');
    const atBound = await make(from);
    const after = await make('2026-10-05T12:00:00.000Z');

    const bounded = (await tours.listByStatus('requested', { createdAtFrom: from })).map((t) => t.tourId);
    expect(bounded).toContain(atBound.tourId);
    expect(bounded).toContain(after.tourId);
    expect(bounded).not.toContain(before.tourId);

    const unbounded = (await tours.listByStatus('requested')).map((t) => t.tourId);
    expect(unbounded).toEqual(expect.arrayContaining([before.tourId, atBound.tourId, after.tourId]));
  });
```

**Step 7 - run GREEN.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/toursRepoListByStatusRange.test.ts test/toursRepo.integration.test.ts test/tourAutoClose.test.ts test/repoPagingWiring.test.ts
```

Expected: all pass, and `toursRepo.integration` RUNS (not "SKIPPED - no
DynamoDB Local"); if it reports SKIPPED, DynamoDB Local is down - stop and
ask the human.

**Step 8 - typecheck, lint, ASCII.**

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

```bash
cd "W:/tmp/matching-blast-rules" && npx eslint app/src/repos/toursRepo.ts app/test/toursRepoListByStatusRange.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/toursRepo.integration.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && tr -d '\11\12\15\40-\176' < app/test/toursRepoListByStatusRange.test.ts | wc -c && git diff -U0 -- app/src/repos/toursRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/toursRepo.integration.test.ts | grep -cP '^\+.*[^\x00-\x7F]'
```

Expected: 0 / 0 / `0` and `0`.

**Step 9 - commit.**

```bash
cd "W:/tmp/matching-blast-rules" && git status
```

```bash
test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

```bash
cd "W:/tmp/matching-blast-rules" && git add app/src/repos/toursRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/toursRepo.integration.test.ts app/test/toursRepoListByStatusRange.test.ts && git commit -F - <<'EOF'
feat(app): toursRepo.listByStatus createdAtFrom range condition, modelled by the harness fake (plan 1.2)

The open-tours read (matching-blast-rules D5) bounds the requested partition
by the byStatus range key in the KEY condition (createdAt >= from). Without
the option the Query is unchanged. The harness fake and a DynamoDB Local
case model the same bound.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 1.3 - The resolver reads searching then onboarding and filters authorities in memory (plan 2.4; D1, D2, D10)

**Files**
- Rewrite: `app/src/services/audienceResolution.ts` (whole file)
- Rewrite: `app/test/audienceResolution.test.ts` (whole file)
- Modify: `app/test/broadcastApi.test.ts` (`:63-64` comment; one test before `:248`)

**Step 1 - rewrite the resolver test.** Read
`app/test/audienceResolution.test.ts`, then replace its WHOLE content with:

```ts
// Audience resolution - the share-broadcast (Matching blast) filter resolver.
//
// matching-blast-rules (spec 2026-10-14) D1, D2, D10: a FILTER audience reads
// ONLY the byTypeStatus partitions (tenant, searching) and then (tenant,
// onboarding) - searching FIRST, under one page bound - and narrows by an
// any-of housing authority list IN MEMORY; the byHousingAuthority GSI is kept
// but never read here. Caseworkers (partners) never resolve. The fences that
// predate it are pinned too: opt-out, unreachable, phone, exact voucher size,
// the per-candidate consent flag, the page cap.
//
// listByType is served by helpers/contactsPartitionFake.ts, which models the
// GSI as DynamoDB runs it (status partitions, range-key order, the
// limit-reached cursor). The harness fake returns seed order, so it could not
// show the read order at all.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem, ContactsRepo, ListContactsOpts } from '../src/repos/contactsRepo.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
import { createAudienceResolutionService } from '../src/services/audienceResolution.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

function tenant(overrides: Partial<ContactItem>): ContactItem {
  return {
    contactId: `c-${Math.random().toString(36).slice(2, 8)}`,
    type: 'tenant',
    // D1: a filter audience reads only searching and onboarding tenants, so
    // the default is one of them; a case about another status says so.
    status: 'searching',
    phone: `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    ...overrides,
  };
}

interface TypeQuery {
  type: string;
  status: string | undefined;
}

/**
 * A contactsRepo whose listByType is contactsPartitionFake - or, with
 * `leaky`, a BROKEN index that hands back every item on every call whatever
 * the type and status, to pin the resolver's own in-memory fences. Records
 * each listByType call (type + status) and each listByHousingAuthority call.
 */
function fakeContacts(
  items: ContactItem[],
  opts: { leaky?: boolean } = {},
): ContactsRepo & { typeQueries: TypeQuery[]; haQueries: string[] } {
  const typeQueries: TypeQuery[] = [];
  const haQueries: string[] = [];
  return {
    typeQueries,
    haQueries,
    async listByType(type, listOpts: ListContactsOpts = {}) {
      typeQueries.push({ type, status: listOpts.status });
      if (opts.leaky === true) return { items: [...items] };
      return listByTypeFromContacts(items, type, listOpts);
    },
    async listByHousingAuthority(ha) {
      haQueries.push(ha);
      return { items: items.filter((c) => c['housingAuthority'] === ha) };
    },
    async findByPhone() {
      return undefined;
    },
    async getById() {
      return undefined;
    },
    async getDisplayById() {
      return undefined;
    },
    async getDisplaysByIds() {
      return new Map();
    },
    async getManyByIds() {
      return new Map();
    },
    async create() {
      throw new Error('unused');
    },
    async createIfAbsent() {
      return true;
    },
    async setFlag() {},
    async clearFlag() {},
    async softDelete(contactId) {
      return { contactId, type: 'tenant' };
    },
    async restore(contactId) {
      return { contactId, type: 'tenant' };
    },
    async update(contactId) {
      return { contactId, type: 'tenant' };
    },
    async addPhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async setPhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async removePhone(contactId) {
      return { contactId, type: 'tenant' };
    },
    async touchPhoneLastSeen() {},
    // Email-channel A1 primitives - unused by audience resolution.
    async findByEmail() {
      return undefined;
    },
    async addEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async setPrimaryEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async removeEmail(contactId) {
      return { contactId, type: 'tenant' };
    },
    async touchEmailLastSeen() {},
    stampGroupParticipation: async () => {
      throw new Error('stampGroupParticipation: not used in this suite');
    },
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
    getRecipientDisplaysByIds: async () => {
      throw new Error('getRecipientDisplaysByIds: not used in this suite');
    },
    findAllByPhone: async () => {
      throw new Error('findAllByPhone: not used in this suite');
    },
    findAllByEmail: async () => {
      throw new Error('findAllByEmail: not used in this suite');
    },
    touchLastHeardFrom: async () => {
      throw new Error('touchLastHeardFrom: not used in this suite');
    },
  };
}

const ALWAYS_EXCLUDE = { excludeOptedOut: true, excludeUnreachable: true } as const;
const TENANTS: AudienceFilter = { contact_type: 'tenant', ...ALWAYS_EXCLUDE };

describe('audience resolution - D1: only searching and onboarding, searching first', () => {
  it('resolves ONLY searching and onboarding tenants, whatever other statuses exist', async () => {
    const statuses = ['needs_review', 'onboarding', 'searching', 'placing', 'placed', 'on_hold', 'inactive'];
    const items = statuses.map((status) => tenant({ contactId: `c-${status}`, status }));
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-searching', 'c-onboarding']);
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('reads the searching partition FIRST, then onboarding - never an un-narrowed read, never byHousingAuthority', async () => {
    // Range-key order is ascending and 'onboarding' < 'searching', so an
    // un-narrowed read (or onboarding read first) puts the onboarding rows first.
    const items = [
      tenant({ contactId: 'c-a', status: 'onboarding', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-b', status: 'searching', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-c', status: 'onboarding', housingAuthority: 'HA-A' }),
      tenant({ contactId: 'c-d', status: 'searching', housingAuthority: 'HA-A' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });

    const all = await resolve(TENANTS);
    expect(all.contactIds).toEqual(['c-b', 'c-d', 'c-a', 'c-c']);
    const listed = await resolve({ ...TENANTS, housing_authorities: ['HA-A'] });
    expect(listed.contactIds).toEqual(['c-b', 'c-d', 'c-a', 'c-c']);

    expect(contacts.typeQueries).toEqual([
      { type: 'tenant', status: 'searching' },
      { type: 'tenant', status: 'onboarding' },
      { type: 'tenant', status: 'searching' },
      { type: 'tenant', status: 'onboarding' },
    ]);
    expect(contacts.haQueries).toEqual([]);
  });

  it('the page bound cuts ONBOARDING, never searching: searching is read to its end first', async () => {
    // pageSize 2, maxPages 2: searching takes both pages ([s1,s2] then [s3]),
    // so the onboarding partition is left unread - truncated.
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-s2', status: 'searching' }),
      tenant({ contactId: 'c-s3', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
      tenant({ contactId: 'c-o2', status: 'onboarding' }),
      tenant({ contactId: 'c-o3', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 2 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-s3']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching']);
  });

  it('a cut inside searching never reads onboarding at all', async () => {
    const items = [
      ...['c-s1', 'c-s2', 'c-s3', 'c-s4', 'c-s5'].map((contactId) => tenant({ contactId, status: 'searching' })),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 2 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-s3', 'c-s4']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching']);
  });

  it('maxPages counts the TOTAL pages across both partitions', async () => {
    // pageSize 2, maxPages 3. searching: [s1,s2] reaches the limit, so the
    // index answers a cursor and an EMPTY second page (2 pages); onboarding:
    // [o1,o2] is page 3 and reaches the limit - a page is still unread.
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-s2', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
      tenant({ contactId: 'c-o2', status: 'onboarding' }),
      tenant({ contactId: 'c-o3', status: 'onboarding' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger, pageSize: 2, maxPages: 3 });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-s2', 'c-o1', 'c-o2']);
    expect(out.truncated).toBe(true);
    expect(contacts.typeQueries.map((q) => q.status)).toEqual(['searching', 'searching', 'onboarding']);
  });

  it('a cap met exactly at the end of the LAST partition is complete, not truncated', async () => {
    const items = [
      tenant({ contactId: 'c-s1', status: 'searching' }),
      tenant({ contactId: 'c-o1', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 2,
    });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['c-s1', 'c-o1']);
    expect(out.truncated).toBe(false);
  });

  it('(PIN) a soft-deleted tenant stays hidden (listByType default scope)', async () => {
    const items = [
      tenant({ contactId: 'c-live' }),
      tenant({ contactId: 'c-gone', deleted_at: '2026-10-01T00:00:00.000Z' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-live']);
  });
});

describe('audience resolution - D2: the housing authority list, any-of, in memory', () => {
  const items = [
    tenant({ contactId: 'c-a', housingAuthority: 'HA-A' }),
    tenant({ contactId: 'c-b', housingAuthority: '  HA-B ' }),
    tenant({ contactId: 'c-c', housingAuthority: 'HA-C' }),
    tenant({ contactId: 'c-none' }),
    tenant({ contactId: 'c-blank', housingAuthority: '   ' }),
  ];

  it('matches ANY member against the trimmed housingAuthority; missing, blank and non-member tenants are left out', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'] });
    expect(out.contactIds).toEqual(['c-a', 'c-b']);
    // The row shows the trimmed value.
    expect(out.contacts.find((c) => c.contactId === 'c-b')?.housingAuthority).toBe('HA-B');
  });

  it('an EMPTY list, or none, is no authority filter: every authority and none resolve', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const everyone = ['c-a', 'c-b', 'c-blank', 'c-c', 'c-none'];
    expect((await resolve({ ...TENANTS, housing_authorities: [] })).contactIds).toEqual(everyone);
    expect((await resolve(TENANTS)).contactIds).toEqual(everyone);
  });

  it('LEGACY stored string: housing_authority is read as a one-member list', async () => {
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    const out = await resolve({ ...TENANTS, housing_authority: 'HA-A' });
    expect(out.contactIds).toEqual(['c-a']);
    expect(contacts.haQueries).toEqual([]);
  });

  it('members are read like any stored list (authoritiesOfFilter): trimmed, blanks ignored', async () => {
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: [' HA-C ', '', '  '] });
    expect(out.contactIds).toEqual(['c-c']);
  });

  it('combines the list with bedroomSize', async () => {
    const sized = [
      tenant({ contactId: 'a2', housingAuthority: 'HA-A', voucherSize: 2 }),
      tenant({ contactId: 'a3', housingAuthority: 'HA-A', voucherSize: 3 }),
      tenant({ contactId: 'b2', housingAuthority: 'HA-B', voucherSize: 2 }),
      tenant({ contactId: 'c2', housingAuthority: 'HA-C', voucherSize: 2 }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(sized), logger });
    const out = await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'], bedroomSize: 2 });
    expect(out.contactIds).toEqual(['a2', 'b2']);
  });
});

describe('audience resolution - D10: caseworkers and other types never resolve', () => {
  it('a partner with a matching authority never resolves, whatever its status', async () => {
    const items = [
      tenant({ contactId: 'c-t', housingAuthority: 'HA-A' }),
      ...['active', 'needs_review', 'searching', 'onboarding'].map((status) =>
        tenant({ contactId: `c-p-${status}`, type: 'partner', status, housingAuthority: 'HA-A' }),
      ),
      tenant({ contactId: 'c-ll', type: 'landlord', status: 'searching', housingAuthority: 'HA-A' }),
    ];
    const contacts = fakeContacts(items);
    const resolve = createAudienceResolutionService({ contactsRepo: contacts, logger });
    expect((await resolve({ ...TENANTS, housing_authorities: ['HA-A'] })).contactIds).toEqual(['c-t']);
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-t']);
    expect(contacts.typeQueries.every((q) => q.type === 'tenant')).toBe(true);
    expect(contacts.haQueries).toEqual([]);
  });

  it('the in-memory fences hold even when the index hands back the wrong rows (type and status)', async () => {
    const items = [
      tenant({ contactId: 'c-s', status: 'searching' }),
      tenant({ contactId: 'c-o', status: 'onboarding' }),
      tenant({ contactId: 'c-placing', status: 'placing' }),
      tenant({ contactId: 'c-partner', type: 'partner', status: 'searching' }),
      tenant({ contactId: 'c-ll', type: 'landlord', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items, { leaky: true }),
      logger,
    });
    // Each partition read returns all five rows; only the row whose status IS
    // that partition's, and whose type is tenant, survives - once.
    expect((await resolve(TENANTS)).contactIds).toEqual(['c-s', 'c-o']);
  });
});

describe('audience resolution - the fences that predate the blast rules', () => {
  it('excludes opted-out AND unreachable contacts (the first TCPA fence) and a missing phone', async () => {
    const items = [
      tenant({ contactId: 'ok' }),
      tenant({ contactId: 'stopped', sms_opt_out: true }),
      tenant({ contactId: 'dead', sms_unreachable: true }),
      tenant({ contactId: 'nophone', phone: undefined }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    expect(out.contactIds).toEqual(['ok']);
  });

  it('bedroomSize filters on the contact voucherSize (exact match), in memory', async () => {
    const items = [
      tenant({ contactId: 'two', voucherSize: 2 }),
      tenant({ contactId: 'three', voucherSize: 3 }),
      tenant({ contactId: 'none' }), // no voucherSize
      tenant({ contactId: 'twoB', voucherSize: 2 }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ ...TENANTS, bedroomSize: 2 });
    expect(out.contactIds.sort()).toEqual(['two', 'twoB']);
  });

  it('carries firstName + lastName + phone + status through (merge field / the review rows FULL name)', async () => {
    const items = [
      tenant({ contactId: 'c-1', firstName: 'Ann', lastName: 'Osei', phone: '+15551230001' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    // has_consent:false here - this tenant has no recorded consent (A2P section 4).
    expect(out.contacts).toEqual([
      { contactId: 'c-1', phone: '+15551230001', firstName: 'Ann', lastName: 'Osei', has_consent: false, status: 'searching' },
    ]);
  });

  it('annotates each candidate with has_consent (A2P/CTIA - LOCKED CONTRACT 3)', async () => {
    const items = [
      tenant({ contactId: 'with', phone: '+15551230001', consent_method: 'inbound_text' }),
      tenant({ contactId: 'without', phone: '+15551230002' }), // no consent
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c.has_consent]));
    expect(byId).toEqual({ with: true, without: false });
  });

  it('last-heard-from 5.3: carries the tenant status and lastHeardFromAt (absent when the contact has none)', async () => {
    const items = [
      tenant({ contactId: 'c-1', status: 'searching', last_heard_from_at: '2026-10-05T16:20:00.000Z' }),
      tenant({ contactId: 'c-2', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c]));
    expect(byId['c-1']).toMatchObject({ status: 'searching', lastHeardFromAt: '2026-10-05T16:20:00.000Z' });
    expect(byId['c-2']).toMatchObject({ status: 'onboarding' });
    expect(byId['c-2']).not.toHaveProperty('lastHeardFromAt');
  });

  // group-texting A8, consumer 5 of 6 (audienceResolution.ts - staff display 1).
  it('shows has_consent FALSE for a silent group member (group_participation_at is not consent)', async () => {
    const items = [
      tenant({
        contactId: 'groupmember',
        phone: '+15551230003',
        group_participation_at: '2026-08-10T12:00:00.000Z',
      }),
      tenant({
        contactId: 'both',
        phone: '+15551230004',
        group_participation_at: '2026-08-10T12:00:00.000Z',
        consent_method: 'inbound_text',
      }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve(TENANTS);
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c.has_consent]));
    expect(byId).toEqual({ groupmember: false, both: true });
  });

  it('resolves cleanly within the page cap -> truncated:false (FIX 3)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 50, // plenty of pages to exhaust 5 items
    });
    const out = await resolve(TENANTS);
    expect(out.count).toBe(5);
    expect(out.truncated).toBe(false);
  });

  it('hits the page cap with more candidates -> truncated:true (FIX 3)', async () => {
    // 10 candidates, pageSize 2, maxPages 2 -> only 4 resolved, more remain.
    const items = Array.from({ length: 10 }, (_, i) => tenant({ contactId: `c-${i}` }));
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts(items),
      logger,
      pageSize: 2,
      maxPages: 2,
    });
    const out = await resolve(TENANTS);
    expect(out.count).toBe(4); // 2 pages x 2
    expect(out.truncated).toBe(true);
  });

  it('logs counts only: `authorities` is the list size and the byHousingAuthority field is gone', async () => {
    const capture = createLogCapture();
    const resolve = createAudienceResolutionService({
      contactsRepo: fakeContacts([
        tenant({ contactId: 'c-a', housingAuthority: 'HA-A', firstName: 'Quillonette', phone: '+15559870001' }),
      ]),
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });
    await resolve({ ...TENANTS, housing_authorities: ['HA-A', 'HA-B'] });
    const line = capture.lines.find((l) => l['msg'] === 'broadcast audience resolved');
    expect(line).toMatchObject({ count: 1, authorities: 2, bedroomSizeFilter: null, truncated: false });
    expect(line).not.toHaveProperty('byHousingAuthority');
    // PII (doc section 9): counts only - no name, no phone.
    const dump = JSON.stringify(capture.lines);
    expect(dump).not.toContain('Quillonette');
    expect(dump).not.toContain('+15559870001');
  });
});
```

**Step 2 - the route-level D1 pin.** In `app/test/broadcastApi.test.ts`
replace (lines 63-64; line 62 above holds a non-ASCII character and stays):

```ts
    // field). 'searching' is a valid lifecycle value; audience resolution does
    // NOT filter on status (services/audienceResolution.ts), so any value works.
```

with:

```ts
    // field). 'searching' is a valid lifecycle value AND one a filter audience
    // reads: matching-blast-rules D1 resolves only searching and onboarding
    // tenants (services/audienceResolution.ts), so a tenant that must be IN a
    // filter audience keeps this default or uses 'onboarding'.
```

Then, in the same file, insert this test immediately BEFORE the line
`  it('share-skip-fix D4: a draft created through the dashboard route records created_via dashboard', async () => {`
(old_string = that line; new_string = the block below followed by a blank
line and that same line):

```ts
  it('matching-blast-rules D1: a filter draft reaches ONLY searching and onboarding tenants, searching first (estimate, preview, no-body send)', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-onb', status: 'onboarding' });
    seedTenant(world, { contactId: 'c-sea', status: 'searching' });
    for (const status of ['needs_review', 'placing', 'placed', 'on_hold', 'inactive']) {
      seedTenant(world, { contactId: `c-${status}`, status });
    }
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    expect(create.status).toBe(201);
    expect(create.body.estimatedCount).toBe(2);

    const preview = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(preview.status).toBe(200);
    expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-sea', 'c-onb']);

    const send = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(200);
    expect(send.body.count).toBe(2);
    expect(Object.keys(world.broadcasts.get(create.body.broadcastId)!.recipients).sort()).toEqual([
      'c-onb',
      'c-sea',
    ]);
  });
```

**Step 3 - run RED.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/audienceResolution.test.ts test/broadcastApi.test.ts
```

Expected failures, for these reasons: in `audienceResolution.test.ts` the D1
cases resolve every status (the walk is un-narrowed - `typeQueries` shows
`status: undefined`) and order onboarding before searching; the D2 list cases
resolve every tenant (`housing_authorities` is ignored today); the leaky-fence
case returns `c-placing` and duplicates; the log case finds
`byHousingAuthority` and no `authorities`. The legacy-string case FAILS too
(`haQueries` is `['HA-A']` - today's byHousingAuthority branch). In
`broadcastApi.test.ts` only the new D1 test fails (`estimatedCount` 7, all
seven candidates); every other case passes.

**Step 4 - rewrite the resolver.** Read
`app/src/services/audienceResolution.ts`, then replace its WHOLE content with
(ASCII only - the old file's em dashes and section signs are gone):

```ts
// Audience resolution (M1.8a; matching-blast-rules 2026-10-14 D1, D2, D10) -
// turn a filtered-share (Matching blast) audience filter into the concrete
// set of tenant contacts to text.
//
// A FILTER audience is TENANT 1:1 contacts ONLY (never relay-group rosters,
// and never caseworkers - D10: a partner joins a share only as a seed or an
// explicitly checked recipient), and only tenants whose status is
// `searching` or `onboarding` (D1). Opted-out (STOP) and unreachable contacts
// are ALWAYS excluded here, at audience resolution, as the first TCPA fence
// (sendMessage's opt-out gate is the second fence per recipient).
//
// THE READ (D1): exactly two byTypeStatus partitions, (tenant, searching) and
// then (tenant, onboarding) - BLAST_TENANT_STATUSES order, searching FIRST -
// under ONE page bound (maxPages counts the pages of both). A cut therefore
// drops onboarding tenants before any searching one, and no other status is
// ever read. (The old un-narrowed walk ascended the status range key and cut
// `searching` tenants first - docs/issues/
// broadcast-audience-truncation-drops-searching-tenants.md, resolved by D1.)
// `truncated` is true when the bound stops the walk with any page still
// unread, in the current partition or a later one.
//
// HOUSING AUTHORITIES (D2) are an in-memory any-of filter. The list comes
// from authoritiesOfFilter (the ONE reader of a stored filter - a legacy
// one-string row is its one member); a tenant matches when its trimmed
// housingAuthority is a member. While the list is non-empty, a tenant with no
// housing authority, or one that is not on the list, does not match. The
// byHousingAuthority GSI and contactsRepo.listByHousingAuthority are KEPT
// (Cameron 2026-10-14) but no longer read here.
//
// SCAN-BOUND ASSUMPTION (Phase-1 volumes, doc section 5.1): the two
// partitions are the active tenant working set - hundreds to low thousands of
// small items - so paginating the Query and filtering in memory is fine. The
// upgrade path if tenants ever exceed tens of thousands is the matching
// engine's (section 5.1): a stream-fed materialized audience index.
//
// PII (doc section 9): NEVER log phones/names - counts only. The RESULT
// carries phones (the send job + the authed preview need them) but the
// service itself logs only counts.
import { authoritiesOfFilter, BLAST_TENANT_STATUSES } from '../lib/blastAudienceRules.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import type { AudienceFilter } from '../repos/broadcastsRepo.js';

/** One resolved recipient: enough to send + render the per-recipient merge field. */
export interface ResolvedContact {
  contactId: string;
  phone: string;
  firstName?: string;
  /** For the review-recipients rows, which show the FULL name (people are not
   *  identifiable by first name alone at roster scale). */
  lastName?: string;
  /** The tenant's approved bedroom (voucher) size - for the preview row display. */
  voucherSize?: number;
  /** The administering housing authority (trimmed) - for the preview row display. */
  housingAuthority?: string;
  /**
   * A2P/CTIA (spec section 4, LOCKED CONTRACT 3): whether this contact has
   * recorded SMS consent (hasSmsConsent). The composer preview surfaces
   * "consent not recorded" for `false`, and the broadcast fan-out EXCLUDES
   * them. Kept as a per-candidate flag (not a pre-exclusion) so staff can see
   * + fix them.
   */
  has_consent: boolean;
  /**
   * last-heard-from (spec 5.3): the contact's lifecycle status, for the review
   * row's StatusBadge kind="tenant". TENANT rows only - the resolver is
   * tenant-fenced and resolveSeeds omits it for a partner seed (a partner's
   * needs_review | active is not a tenant status).
   */
  status?: string;
  /** last-heard-from: contact.last_heard_from_at (any type), for the review
   *  row's column and its order. */
  lastHeardFromAt?: string;
}

export interface ResolvedAudience {
  contactIds: string[];
  contacts: ResolvedContact[];
  count: number;
  /**
   * True when the page walk hit its maxPages cap with a page still unread
   * (in the current status partition or a later one) - the resolved set is
   * INCOMPLETE. The /send route refuses on this (no silent under-delivery);
   * the preview surfaces it to the operator.
   */
  truncated: boolean;
}

export interface AudienceResolutionDeps {
  contactsRepo?: ContactsRepo;
  logger?: Logger;
  /**
   * Safety cap on the number of Query pages walked, counted ACROSS both
   * status partitions (each page is up to the GSI's natural page size).
   * Bounds the scan even if the working set grows unexpectedly; the header
   * comment is the design assumption, this is the fence.
   */
  maxPages?: number;
  /** Per-page Limit handed to the Query (bounds each round-trip). */
  pageSize?: number;
}

export type AudienceResolutionService = (filter: AudienceFilter) => Promise<ResolvedAudience>;

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_PAGE_SIZE = 200;

/** A tenant's bedroom (voucher) size - the FLEXIBLE `voucherSize` field, not indexed. */
function voucherSizeOf(contact: ContactItem): number | undefined {
  const v = contact['voucherSize'];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Resolved first name for the [TenantName] merge token, or undefined. */
function firstNameOf(contact: ContactItem): string | undefined {
  const v = contact['firstName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Resolved last name (the preview rows show the FULL name), or undefined. */
function lastNameOf(contact: ContactItem): string | undefined {
  const v = contact['lastName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** The administering housing authority, trimmed, or undefined when blank. */
function housingAuthorityOf(contact: ContactItem): string | undefined {
  const v = contact['housingAuthority'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function createAudienceResolutionService(
  deps: AudienceResolutionDeps = {},
): AudienceResolutionService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

  return async function resolve(filter) {
    // D2: the any-of list, read through the ONE normalizer (legacy rows too).
    const authorities = new Set(authoritiesOfFilter(filter));

    const resolved: ResolvedContact[] = [];
    let pages = 0;
    let truncated = false;
    // D1: one Query walk per wanted status partition, in read order.
    for (const status of BLAST_TENANT_STATUSES) {
      if (truncated) break;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        if (pages >= maxPages) {
          // The bound stops the walk with a page still unread - the next page
          // of this partition, or the first page of a later one.
          truncated = true;
          break;
        }
        const page = await contacts.listByType('tenant', {
          status,
          limit: pageSize,
          ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
        });
        pages += 1;

        for (const contact of page.items) {
          // A FILTER-resolved audience is tenants only (spec 2026-10-06 D20,
          // matching-blast-rules D10). The partition is type-keyed; this belt
          // keeps a caseworker out even if an index ever hands one back.
          if (contact.type !== 'tenant') continue;
          // D1: only the partition's own status (the same belt for status;
          // it also keeps a row from resolving twice across partitions).
          if (contact.status !== status) continue;
          // Always exclude STOP'd / unreachable contacts (first TCPA fence). A
          // missing phone is unsendable - drop it.
          if (filter.excludeOptedOut !== false && contact.sms_opt_out === true) continue;
          if (filter.excludeUnreachable !== false && contact.sms_unreachable === true) continue;
          if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue;
          // Bedroom-size filter: exact match on the contact's voucherSize.
          if (filter.bedroomSize !== undefined && voucherSizeOf(contact) !== filter.bedroomSize) {
            continue;
          }
          const housingAuthority = housingAuthorityOf(contact);
          // D2: any-of on the trimmed value; an empty list filters nothing,
          // a non-empty one leaves out a missing or non-member authority.
          if (
            authorities.size > 0 &&
            (housingAuthority === undefined || !authorities.has(housingAuthority))
          ) {
            continue;
          }
          const firstName = firstNameOf(contact);
          const lastName = lastNameOf(contact);
          const voucherSize = voucherSizeOf(contact);
          resolved.push({
            contactId: contact.contactId,
            phone: contact.phone,
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(voucherSize !== undefined && { voucherSize }),
            ...(housingAuthority !== undefined && { housingAuthority }),
            // last-heard-from (spec 5.3): projection only.
            ...(typeof contact.status === 'string' && contact.status.length > 0 && { status: contact.status }),
            ...(typeof contact.last_heard_from_at === 'string' && { lastHeardFromAt: contact.last_heard_from_at }),
            // A2P/CTIA: per-candidate consent flag (spec section 4). NOT a
            // pre-exclusion here - the preview surfaces it and the fan-out
            // fences on it.
            has_consent: hasSmsConsent(contact),
          });
        }

        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
    }

    if (truncated) {
      // Hit the page cap with more candidates remaining: surface it loudly so
      // the operator knows the audience was truncated (and the bound revisited).
      log.warn(
        { maxPages, resolved: resolved.length },
        'audience resolution hit the page cap - audience may be truncated',
      );
    }

    log.info(
      {
        count: resolved.length,
        authorities: authorities.size,
        bedroomSizeFilter: filter.bedroomSize ?? null,
        truncated,
      },
      'broadcast audience resolved',
    );

    return {
      contactIds: resolved.map((c) => c.contactId),
      contacts: resolved,
      count: resolved.length,
      truncated,
    };
  };
}
```

**Step 5 - run GREEN** (plus every other suite that drives the broadcasts
routes through the real resolver):

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/audienceResolution.test.ts test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts test/followUpsApi.test.ts test/blastAudienceRules.test.ts
```

Expected: all pass.

**Step 6 - typecheck, lint, ASCII.**

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

```bash
cd "W:/tmp/matching-blast-rules" && npx eslint app/src/services/audienceResolution.ts app/test/audienceResolution.test.ts app/test/broadcastApi.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && tr -d '\11\12\15\40-\176' < app/src/services/audienceResolution.ts | wc -c && tr -d '\11\12\15\40-\176' < app/test/audienceResolution.test.ts | wc -c && git diff -U0 -- app/test/broadcastApi.test.ts | grep -cP '^\+.*[^\x00-\x7F]'
```

Expected: 0 / 0 / `0`, `0`, `0`. (Both rewritten files must be fully ASCII.)

**Step 7 - commit.**

```bash
cd "W:/tmp/matching-blast-rules" && git status
```

```bash
test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

```bash
cd "W:/tmp/matching-blast-rules" && git add app/src/services/audienceResolution.ts app/test/audienceResolution.test.ts app/test/broadcastApi.test.ts && git commit -F - <<'EOF'
feat(app): blast audience reads only searching then onboarding tenants and filters housing authorities in memory (plan 1.3)

matching-blast-rules D1, D2, D10: the resolver reads the (tenant, searching)
then (tenant, onboarding) byTypeStatus partitions under one page bound, so a
cut drops onboarding before searching; the authority filter is any-of over
authoritiesOfFilter (legacy string included), in memory. byHousingAuthority
is kept but no longer read. Partners never resolve (pinned, plus a leaky-index
fence test). The log reports authorities instead of byHousingAuthority.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 1.4 - Draft create takes a housing authority list (plan 2.6 create; D2)

The estimate math stays today's (`broadcasts.ts:652-667`, now over the list
through the resolver); S2 replaces it. Only the filter changes here.

**Files**
- Modify: `app/src/routes/broadcasts.ts` (import after `:82`; `:137-171`;
  `:635-650`; `:697-699`)
- Modify: `app/test/broadcastApi.test.ts` (`:2197-2206`, `:2216-2221`,
  `:2250-2267`; one new describe before `:2369`)

**Step 1 - update the two create tests that pin the string shape.** In
`app/test/broadcastApi.test.ts` replace (lines 2197-2206):

```ts
    it('POST stores an exact list name, and the 201 echoes the stored filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'Atlanta Housing Authority');
      expect(res.status).toBe(201);
      expect(res.body.audience_filter).toEqual(filterFor('Atlanta Housing Authority'));
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter).toEqual(
        filterFor('Atlanta Housing Authority'),
      );
    });
```

with:

```ts
    it('POST (LEGACY body string) stores an exact list name as a one-member list, and the 201 echoes the wire filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'Atlanta Housing Authority');
      expect(res.status).toBe(201);
      const wire = {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      };
      expect(res.body.audience_filter).toEqual(wire);
      expect(res.body.audience_filter).not.toHaveProperty('housing_authority');
      const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
      expect(stored).toEqual(wire);
      expect(stored).not.toHaveProperty('housing_authority');
    });
```

Then replace (lines 2216-2221):

```ts
      expect(res.body.audience_filter.housing_authority).toBe('Atlanta Housing Authority');
      // The estimate resolved the NAME (two holders), not the slug (one holder).
      expect(res.body.estimatedCount).toBe(2);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authority).toBe(
        'Atlanta Housing Authority',
      );
```

with:

```ts
      expect(res.body.audience_filter.housing_authorities).toEqual(['Atlanta Housing Authority']);
      // The estimate resolved the NAME (two holders), not the slug (one holder).
      expect(res.body.estimatedCount).toBe(2);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authorities).toEqual([
        'Atlanta Housing Authority',
      ]);
```

Then replace the PIN (lines 2250-2267):

```ts
    it('(PIN) every 400 and the unit 404 still come before the 422', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const create = (body: Record<string, unknown>) =>
        request(app)
          .post('/api/broadcasts')
          .set('x-origin-verify', ORIGIN_SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send(body);
      const filter = { contact_type: 'tenant', housing_authority: 'AHA' };
      const noTemplate = await create({ audience_filter: filter });
      expect(noTemplate.status).toBe(400);
      const badSeeds = await create({ body_template: 'hi', audience_filter: filter, seedContactIds: 'c-1' });
      expect(badSeeds.status).toBe(400);
      const badUnit = await create({ unitId: 'unit-nope', body_template: 'hi', audience_filter: filter });
      expect(badUnit.status).toBe(404);
      expect(badUnit.body).toEqual({ error: 'unit_not_found' });
    });
```

with:

```ts
    it('(PIN) every 400 and the unit 404 still come before the 422 (legacy string and list alike)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const create = (body: Record<string, unknown>) =>
        request(app)
          .post('/api/broadcasts')
          .set('x-origin-verify', ORIGIN_SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send(body);
      const filters = [
        { contact_type: 'tenant', housing_authority: 'AHA' },
        { contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority', 'AHA'] },
      ];
      for (const filter of filters) {
        const noTemplate = await create({ audience_filter: filter });
        expect(noTemplate.status).toBe(400);
        const badSeeds = await create({ body_template: 'hi', audience_filter: filter, seedContactIds: 'c-1' });
        expect(badSeeds.status).toBe(400);
        const badUnit = await create({ unitId: 'unit-nope', body_template: 'hi', audience_filter: filter });
        expect(badUnit.status).toBe(404);
        expect(badUnit.body).toEqual({ error: 'unit_not_found' });
      }
    });
```

**Step 2 - the new create tests.** In the same file, replace the line

```ts
  // --- caseworkers (spec 2026-10-06 D20, plan 3.7): a seed or an explicit
```

with the block below followed by a blank line and that same line:

```ts
  // --- matching-blast-rules D2 (plan Task 1.4): the housing authority LIST at
  // draft create - the shape 400s, the legacy one-string body, the org-list
  // check (the FIRST failing member is the 422) and the stored + echoed
  // list. The estimate here is still today's math (S2 replaces it). ---------
  describe('matching-blast-rules D2: housing_authorities at draft create', () => {
    function postFilter(app: import('express').Express, audience_filter: Record<string, unknown>) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', audience_filter });
    }

    /** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
    function names(refs: Array<{ name: string }>): string[] {
      return refs.map((r) => r.name).sort();
    }

    it('stores exact names and unique spellings as entry NAMES - trimmed, blanks dropped, de-duplicated - and echoes the wire filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', ' DCA ', 'atlanta_housing', '', '   '],
      });
      expect(res.status).toBe(201);
      const wire = {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      };
      expect(res.body.audience_filter).toEqual(wire);
      const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
      expect(stored).toEqual(wire);
      expect(stored).not.toHaveProperty('housing_authority');
    });

    it('LEGACY body: a housing_authority string is a one-member list, stored as housing_authorities', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', housing_authority: 'atlanta_housing' });
      expect(res.status).toBe(201);
      expect(res.body.audience_filter).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      const stored = world.broadcasts.get(res.body.broadcastId)!.audience_filter;
      expect(stored.housing_authorities).toEqual(['Atlanta Housing Authority']);
      expect(stored).not.toHaveProperty('housing_authority');
    });

    it('both keys at once is a 400, and nothing is stored', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        housing_authority: 'Atlanta Housing Authority',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'audience_filter: use housing_authorities only' });
      expect(world.broadcasts.size).toBe(0);
    });

    it('a list that is not an array of at most 100 strings is a 400, and nothing is stored', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const bad: unknown[] = [
        'Atlanta Housing Authority',
        { name: 'Atlanta Housing Authority' },
        ['Atlanta Housing Authority', 7],
        Array.from({ length: 101 }, () => 'Atlanta Housing Authority'),
      ];
      for (const housing_authorities of bad) {
        const res = await postFilter(app, { contact_type: 'tenant', housing_authorities });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          error: 'audience_filter.housing_authorities must be an array of at most 100 strings',
        });
      }
      expect(world.broadcasts.size).toBe(0);
    });

    it('exactly 100 members passes the shape guard (and duplicates collapse)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: Array.from({ length: 100 }, () => 'Atlanta Housing Authority'),
      });
      expect(res.status).toBe(201);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authorities).toEqual([
        'Atlanta Housing Authority',
      ]);
    });

    it('the FIRST failing member is the 422 (field audience_filter, text = that member); no row, no audit', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'AHA', 'Step Up'],
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'AHA', close: [] });
      expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
      expect(res.body).not.toHaveProperty('otherKind');
      expect(world.broadcasts.size).toBe(0);
      expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_created')).toHaveLength(0);
    });

    it('a LATER member that fails is refused too, naming that member (an agency names otherKind)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', housing_authorities: ['DCA', 'Step Up'] });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'Step Up', candidates: [] });
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
      expect(world.broadcasts.size).toBe(0);
    });

    it('(PIN) an empty or all-blank list is no authority filter: no key stored, the org list not read', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      // Spied AFTER the harness is built: the org-names service holds this
      // same object and calls list.get() per request.
      const read = vi.spyOn(world.orgListRepo, 'get');
      for (const housing_authorities of [[], ['  ', '']]) {
        const res = await postFilter(app, { contact_type: 'tenant', housing_authorities });
        expect(res.status).toBe(201);
        expect(res.body.audience_filter).toEqual({ contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true });
        expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter).not.toHaveProperty('housing_authorities');
      }
      expect(read).not.toHaveBeenCalled();
    });

    it('the estimate counts tenants holding ANY listed authority; no authority and a Placing tenant are left out', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-aha', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dca',
        status: 'onboarding',
        housingAuthority: 'Georgia Department of Community Affairs',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-dekalb', housingAuthority: 'DeKalb County Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-none' });
      seedTenant(world, {
        contactId: 'c-placing',
        status: 'placing',
        housingAuthority: 'Atlanta Housing Authority',
      } as Partial<ContactItem>);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'DCA'],
      });
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(2);
    });
  });
```

**Step 3 - run RED.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/broadcastApi.test.ts
```

Expected failures, and why: the legacy-body and spelling tests read
`housing_authority` back (the route still stores the string); in the new
describe, the list is ignored by today's parser - the stores-names and
100-member tests find no `housing_authorities`, the both-keys, shape and two
422 tests get 201, and the estimate test counts 4 (every searching/onboarding
tenant). The `(PIN)` cases pass.

**Step 4 - import the rules.** In `app/src/routes/broadcasts.ts` replace
(line 82):

```ts
import { checkScalarWrite, isOnListFor, KINDS_FOR_FIELD, type OrgNotOnList } from '../lib/orgNames.js';
```

with:

```ts
import { checkScalarWrite, isOnListFor, KINDS_FOR_FIELD, type OrgNotOnList } from '../lib/orgNames.js';
import { authoritiesOfFilter, MAX_FILTER_AUTHORITIES, wireAudienceFilter } from '../lib/blastAudienceRules.js';
```

**Step 5 - the parser.** In the same file replace (lines 137-171; the doc
comment's lines 134-136 above stay - line 136 holds a non-ASCII dash):

```ts
 * housing_authority/bedroomSize are optional narrowers; opt-out + unreachable
 * are ALWAYS excluded regardless of the request.
 */
function parseAudienceFilter(raw: unknown): AudienceFilter | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'audience_filter must be an object' };
  }
  const f = raw as Record<string, unknown>;
  // contact_type defaults to 'tenant'; if present it MUST be 'tenant'.
  if (f['contact_type'] !== undefined && f['contact_type'] !== 'tenant') {
    return { error: 'audience_filter.contact_type must be "tenant" (M1.8 targets tenants only)' };
  }
  let housing_authority: string | undefined;
  if (f['housing_authority'] !== undefined && f['housing_authority'] !== null) {
    if (typeof f['housing_authority'] !== 'string' || f['housing_authority'].trim().length === 0) {
      return { error: 'audience_filter.housing_authority must be a non-empty string' };
    }
    housing_authority = f['housing_authority'].trim();
  }
  let bedroomSize: number | undefined;
  if (f['bedroomSize'] !== undefined && f['bedroomSize'] !== null) {
    const v = f['bedroomSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'audience_filter.bedroomSize must be an integer 0..12' };
    }
    bedroomSize = v;
  }
  return {
    contact_type: 'tenant',
    ...(housing_authority !== undefined && { housing_authority }),
    ...(bedroomSize !== undefined && { bedroomSize }),
    excludeOptedOut: true,
    excludeUnreachable: true,
  };
}
```

with:

```ts
 * housing_authorities (matching-blast-rules D2: any-of, an array of at most
 * MAX_FILTER_AUTHORITIES strings; the LEGACY one-string housing_authority is
 * read as a one-member list while the list is absent, and both keys at once
 * is a 400; null reads as absent) and bedroomSize are optional narrowers;
 * opt-out + unreachable are ALWAYS excluded regardless of the request.
 * Members are trimmed, blanks dropped and de-duplicated here
 * (authoritiesOfFilter); the route then checks them against the org list.
 * The result NEVER carries housing_authority, and carries housing_authorities
 * only when non-empty.
 */
function parseAudienceFilter(raw: unknown): AudienceFilter | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'audience_filter must be an object' };
  }
  const f = raw as Record<string, unknown>;
  // contact_type defaults to 'tenant'; if present it MUST be 'tenant'.
  if (f['contact_type'] !== undefined && f['contact_type'] !== 'tenant') {
    return { error: 'audience_filter.contact_type must be "tenant" (M1.8 targets tenants only)' };
  }
  const rawList = f['housing_authorities'];
  const rawLegacy = f['housing_authority'];
  const listGiven = rawList !== undefined && rawList !== null;
  const legacyGiven = rawLegacy !== undefined && rawLegacy !== null;
  if (listGiven && legacyGiven) {
    return { error: 'audience_filter: use housing_authorities only' };
  }
  let given: string[] | undefined;
  if (listGiven) {
    const listError = `audience_filter.housing_authorities must be an array of at most ${MAX_FILTER_AUTHORITIES} strings`;
    if (!Array.isArray(rawList) || rawList.length > MAX_FILTER_AUTHORITIES) return { error: listError };
    given = [];
    for (const member of rawList as unknown[]) {
      if (typeof member !== 'string') return { error: listError };
      given.push(member);
    }
  } else if (legacyGiven) {
    // LEGACY body (an old open dashboard tab or an API client): today's rule.
    if (typeof rawLegacy !== 'string' || rawLegacy.trim().length === 0) {
      return { error: 'audience_filter.housing_authority must be a non-empty string' };
    }
    given = [rawLegacy];
  }
  // Trimmed, blanks dropped, de-duplicated (first wins) - the ONE normalizer.
  // An empty result is no housing authority filter: no key is stored.
  const housing_authorities = authoritiesOfFilter({ housing_authorities: given });
  let bedroomSize: number | undefined;
  if (f['bedroomSize'] !== undefined && f['bedroomSize'] !== null) {
    const v = f['bedroomSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'audience_filter.bedroomSize must be an integer 0..12' };
    }
    bedroomSize = v;
  }
  return {
    contact_type: 'tenant',
    ...(housing_authorities.length > 0 && { housing_authorities }),
    ...(bedroomSize !== undefined && { bedroomSize }),
    excludeOptedOut: true,
    excludeUnreachable: true,
  };
}
```

**Step 6 - the list check at create.** In the same file replace (lines
635-650):

```ts
    // ORGANIZATION NAMES (spec 2026-10-06 D5): a housing authority filter must
    // name a housing authority on the stored org list. Checked AFTER every 400
    // shape check and the unit 404 above, and BEFORE the estimate, so the
    // estimate and the stored row both use the entry's exact name (a unique
    // spelling is stored as the name). Anything else is a 422 (field
    // `audience_filter`) with no row and no audit. A seeds_only draft parsed
    // `{}` and never carries a housing authority.
    if (filter.housing_authority !== undefined) {
      const check = await orgNames.checkScalar('audience_filter', filter.housing_authority, undefined);
      if (!check.ok) {
        log.info({ actor }, 'broadcast draft refused: housing authority filter not on the list');
        res.status(422).json(check.error);
        return;
      }
      if (check.value !== null) filter.housing_authority = check.value;
    }
```

with:

```ts
    // ORGANIZATION NAMES (spec 2026-10-06 D5; matching-blast-rules D2): EVERY
    // member of the housing authority list must name a housing authority on
    // the stored org list (orgNames.checkList: trimmed, blanks dropped,
    // de-duplicated, a unique spelling stored as the entry's exact name).
    // Checked AFTER every 400 shape check and the unit 404 above, and BEFORE
    // the estimate, so the estimate and the stored row both use the entries'
    // exact names. The FIRST member that is not on the list is the 422 (field
    // `audience_filter`, `text` = that member) with no row and no audit. One
    // list read, and only when the parsed list is non-empty. A seeds_only
    // draft parsed `{}` and never carries a housing authority.
    if (filter.housing_authorities !== undefined) {
      const check = await orgNames.checkList('audience_filter', filter.housing_authorities, undefined, undefined);
      if (!check.ok) {
        log.info({ actor }, 'broadcast draft refused: a housing authority filter member is not on the list');
        res.status(422).json(check.error);
        return;
      }
      filter.housing_authorities = check.value;
    }
```

**Step 7 - the 201 echo.** In the same file replace (lines 697-699):

```ts
      // Spec 2026-10-06 D5 (ruling R2 decision 5): echo the STORED filter, so a
      // caller that sent a spelling sees the list name it was stored as.
      audience_filter: created.audience_filter,
```

with:

```ts
      // Spec 2026-10-06 D5 (ruling R2 decision 5): echo the STORED filter, so a
      // caller that sent a spelling sees the list name it was stored as - in
      // the wire shape (matching-blast-rules D2: housing_authorities, never
      // housing_authority).
      audience_filter: wireAudienceFilter(created.audience_filter),
```

**Step 8 - run GREEN.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts test/audienceResolution.test.ts
```

Expected: all pass (the legacy-stored preview/send re-check tests at
`:2282-2366` are untouched and still pass - `storedFilterRefusal` still reads
the legacy string until Task 1.5).

**Step 9 - typecheck, lint, ASCII.**

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

```bash
cd "W:/tmp/matching-blast-rules" && npx eslint app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && git diff -U0 -- app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts | grep -cP '^\+.*[^\x00-\x7F]'
```

Expected: 0 / 0 / `0`.

**Step 10 - commit.**

```bash
cd "W:/tmp/matching-blast-rules" && git status
```

```bash
test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

```bash
cd "W:/tmp/matching-blast-rules" && git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts && git commit -F - <<'EOF'
feat(app): draft create takes a housing authority list - shape 400s, legacy string, first off-list member 422, wire echo (plan 1.4)

matching-blast-rules D2: audience_filter.housing_authorities (at most 100
strings) is checked with orgNames.checkList and stored as entry names; the
legacy housing_authority string is read as a one-member list; both keys is a
400. The stored draft never carries housing_authority and the 201 echoes the
wire filter. The estimate is unchanged (S2).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 1.5 - Stored lists re-checked member by member; results and list answer the wire filter (D2)

**Files**
- Modify: `app/src/routes/broadcasts.ts` (`:14-28` header; `:392-394`;
  `:420-422`; `:536-567`)
- Modify: `app/test/broadcastApi.test.ts` (`:2172` comment; one new describe
  before the caseworkers line)

**Step 1 - mark the legacy fixtures as legacy coverage.** In
`app/test/broadcastApi.test.ts` replace (line 2172):

```ts
    /** A stored audience filter holding `housing_authority` exactly as written. */
```

with:

```ts
    /** A LEGACY stored audience filter (saved before matching-blast-rules D2)
     *  holding `housing_authority` exactly as written. Kept as legacy
     *  coverage: storedFilterRefusal and the resolver read it through
     *  authoritiesOfFilter as a one-member list. */
```

**Step 2 - the new tests.** In the same file, replace the line

```ts
  // --- caseworkers (spec 2026-10-06 D20, plan 3.7): a seed or an explicit
```

with the block below followed by a blank line and that same line (it lands
after Task 1.4's describe):

```ts
  // --- matching-blast-rules D2 (plan Task 1.5): a STORED list is re-checked
  // member by member at preview and at the filter-resolving send, and every
  // response that carries a filter answers the wire shape - a legacy row's
  // string as a one-member housing_authorities, never housing_authority. ----
  describe('matching-blast-rules D2: stored lists at preview, send and the projections', () => {
    /** A stored LIST-shaped filter (what draft create writes since D2). */
    const listFilter = (...housing_authorities: string[]): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      housing_authorities,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
    /** A LEGACY stored filter (drafts and shares saved before D2). */
    const legacyFilter = (housing_authority: string): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      housing_authority,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });

    function act(
      app: import('express').Express,
      broadcastId: string,
      verb: 'preview' | 'send',
      body: Record<string, unknown> = {},
    ) {
      return request(app)
        .post(`/api/broadcasts/${broadcastId}/${verb}`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    /** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
    function names(refs: Array<{ name: string }>): string[] {
      return refs.map((r) => r.name).sort();
    }

    it('preview re-checks EVERY member in order: the first not exactly listed is the 422 (one list read)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-spelling', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'DCA', 'Step Up'),
      });
      const { app } = makeWebhookHarness({ world });
      // Spied AFTER the harness is built (the service calls list.get() per request).
      const read = vi.spyOn(world.orgListRepo, 'get');
      const res = await act(app, 'bcast-list-spelling', 'preview');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'DCA', close: [] });
      expect(res.body.candidates).toEqual([
        expect.objectContaining({ kind: 'housing_authority', name: 'Georgia Department of Community Affairs' }),
      ]);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('preview: a stored agency member is the 422 with otherKind', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-list-agency', 'draft', {}, { audience_filter: listFilter('Step Up', 'DCA') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-list-agency', 'preview');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'Step Up' });
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
    });

    it('the filter-resolving send re-checks every member of the stored list: 422, still a draft, nothing sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-send', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'Nowhere Housing Authority'),
      });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-list-send', 'send');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'org_not_on_list',
        field: 'audience_filter',
        text: 'Nowhere Housing Authority',
      });
      await queueAdapter.settle();
      expect(world.broadcasts.get('bcast-list-send')?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('(PIN) a stored list of exact names previews and sends to holders of ANY member', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-aha', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dca',
        housingAuthority: 'Georgia Department of Community Affairs',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-dekalb', housingAuthority: 'DeKalb County Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-exact', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'Georgia Department of Community Affairs'),
      });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-list-exact', 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.count).toBe(2);
      const send = await act(app, 'bcast-list-exact', 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(2);
    });

    it('GET results answers the wire filter: a LEGACY row reads housing_authorities, never housing_authority', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-legacy-sent', 'sent', { 'c-1': { status: 'delivered' } }, {
        audience_filter: { ...legacyFilter('Atlanta Housing Authority'), bedroomSize: 2 },
      });
      const { app } = makeWebhookHarness({ world });
      const res = await request(app)
        .get('/api/broadcasts/bcast-legacy-sent/results')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(res.status).toBe(200);
      expect(res.body.audience_filter).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        bedroomSize: 2,
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(res.body.audience_filter).not.toHaveProperty('housing_authority');
    });

    it('GET /api/broadcasts rows answer the wire filter too - legacy, list and no-authority rows', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-row-legacy', 'sent', {}, { audience_filter: legacyFilter('Atlanta Housing Authority') });
      seedShare(world, 'bcast-row-list', 'draft', {}, { audience_filter: listFilter('DeKalb County Housing Authority') });
      seedShare(world, 'bcast-row-none', 'draft', {});
      const { app } = makeWebhookHarness({ world });
      const res = await request(app)
        .get('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        (res.body.broadcasts as Array<{ broadcastId: string; audience_filter: Record<string, unknown> }>).map(
          (b) => [b.broadcastId, b.audience_filter],
        ),
      );
      expect(byId['bcast-row-legacy']).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(byId['bcast-row-legacy']).not.toHaveProperty('housing_authority');
      expect(byId['bcast-row-list']).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['DeKalb County Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(byId['bcast-row-none']).toEqual({ contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true });
      expect(byId['bcast-row-none']).not.toHaveProperty('housing_authorities');
    });
  });
```

**Step 3 - run RED.**

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/broadcastApi.test.ts
```

Expected failures, and why: the two preview cases answer 200 (today's
`storedFilterRefusal` reads only `housing_authority`, absent on a list row,
and makes no list read); the send case answers 200 `sending`; the results
and list cases show `housing_authority` and no `housing_authorities` on the
legacy row (the projections pass the stored filter raw). The `(PIN)` passes.

**Step 4 - re-check every stored member.** In `app/src/routes/broadcasts.ts`
replace (lines 536-567):

```ts
  /**
   * Spec 2026-10-06 D7: the STORED housing authority filter of a draft is
   * re-checked before it is resolved - at preview of a DRAFT and in the send
   * branch that re-resolves the filter. The value must be EXACTLY the name of
   * a housing authority entry (D3); nothing rewrites a broadcast, so a stored
   * spelling or slug that resolves to one entry is still refused, naming that
   * entry as the one candidate so the composer can offer it (ruling R2
   * decision 2). Returns the 422 body, or undefined when the filter names no
   * housing authority or names one exactly. One list read, and only when a
   * housing authority is present.
   */
  async function storedFilterRefusal(
    filter: AudienceFilter | undefined,
  ): Promise<OrgNotOnList | undefined> {
    const text = filter?.housing_authority;
    if (typeof text !== 'string' || text.length === 0) return undefined;
    const { entries } = await orgNames.read();
    const kinds = KINDS_FOR_FIELD.audience_filter;
    if (isOnListFor(entries, text, kinds)) return undefined;
    const check = checkScalarWrite(entries, 'audience_filter', text, undefined);
    if (!check.ok) return check.error;
    // The one entry the stored text resolves to (a spelling or slug of it).
    const resolvedName = check.value;
    const match = entries.find((e) => kinds.includes(e.kind) && e.name === resolvedName);
    return {
      error: 'org_not_on_list',
      field: 'audience_filter',
      text,
      candidates: match === undefined ? [] : [{ orgId: match.orgId, kind: match.kind, name: match.name }],
      close: [],
    };
  }
```

with:

```ts
  /**
   * Spec 2026-10-06 D7 (matching-blast-rules D2): the STORED housing authority
   * filter of a draft is re-checked before it is resolved - at preview of a
   * DRAFT and in the send branch that re-resolves the filter. EVERY member of
   * the stored list (authoritiesOfFilter - a legacy row's one string is its
   * one member) must be EXACTLY the name of a housing authority entry (D3),
   * checked in order; the first that is not is answered. Nothing rewrites a
   * broadcast, so a stored spelling or slug that resolves to one entry is
   * still refused, naming that entry as the one candidate so the composer can
   * offer it (ruling R2 decision 2). Returns the 422 body, or undefined when
   * the filter names no housing authority or only exact names. One list read,
   * and only when the list is non-empty.
   */
  async function storedFilterRefusal(
    filter: AudienceFilter | undefined,
  ): Promise<OrgNotOnList | undefined> {
    const members = authoritiesOfFilter(filter);
    if (members.length === 0) return undefined;
    const { entries } = await orgNames.read();
    const kinds = KINDS_FOR_FIELD.audience_filter;
    for (const text of members) {
      if (isOnListFor(entries, text, kinds)) continue;
      const check = checkScalarWrite(entries, 'audience_filter', text, undefined);
      if (!check.ok) return check.error;
      // The one entry the stored text resolves to (a spelling or slug of it).
      const resolvedName = check.value;
      const match = entries.find((e) => kinds.includes(e.kind) && e.name === resolvedName);
      return {
        error: 'org_not_on_list',
        field: 'audience_filter',
        text,
        candidates: match === undefined ? [] : [{ orgId: match.orgId, kind: match.kind, name: match.name }],
        close: [],
      };
    }
    return undefined;
  }
```

**Step 5 - the two projections.** In the same file replace (lines 392-394):

```ts
    unitId: b.unitId ?? null,
    audience_filter: b.audience_filter,
    // Matching sends: surface the draft's audience mode when set so the composer
```

with:

```ts
    unitId: b.unitId ?? null,
    // matching-blast-rules D2: the wire shape (a legacy row's string becomes
    // a one-member housing_authorities; never housing_authority).
    audience_filter: wireAudienceFilter(b.audience_filter),
    // Matching sends: surface the draft's audience mode when set so the composer
```

and replace (lines 420-422):

```ts
    unitId: b.unitId ?? null,
    audience_filter: b.audience_filter,
    // Matching sends: pass the audience mode through on list rows too (dashboard
```

with:

```ts
    unitId: b.unitId ?? null,
    // matching-blast-rules D2: the wire shape, as on the results view.
    audience_filter: wireAudienceFilter(b.audience_filter),
    // Matching sends: pass the audience mode through on list rows too (dashboard
```

**Step 6 - the router header.** In the same file replace (lines 14-28):

```ts
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), by housing authority and/or exact bedroom size; hand-picked seeds
// and an explicit recipient list may also name PARTNERS (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
//
// Organization names (spec 2026-10-06 D5): POST answers 422 org_not_on_list
// (field `audience_filter`) when audience_filter.housing_authority is not a
// housing authority on the stored org list; a unique spelling is stored as the
// entry's exact name, and the 201 echoes the stored audience_filter.
// Preview of a DRAFT and the filter-resolving send (no recipientContactIds, not
// seeds_only) re-check the STORED value (D7): it must be EXACTLY a listed name,
// else the same 422, where a stored spelling names its entry as the one
// candidate. The curated send, seeds_only drafts and non-draft previews are
// never re-checked; nothing rewrites a broadcast.
```

with:

```ts
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), and only tenants in Onboarding or Searching (matching-blast-rules
// D1), narrowed by ANY of a list of housing authorities (D2) and/or exact
// bedroom size; hand-picked seeds and an explicit recipient list may also
// name PARTNERS, of any status (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
//
// Organization names (spec 2026-10-06 D5; matching-blast-rules D2): POST
// answers 422 org_not_on_list (field `audience_filter`, `text` = the FIRST
// failing member) when a member of audience_filter.housing_authorities - or
// the LEGACY one-string housing_authority, read as a one-member list - is not
// a housing authority on the stored org list; a unique spelling is stored as
// the entry's exact name, and the 201 echoes the stored filter in the wire
// shape (wireAudienceFilter: housing_authorities, never housing_authority),
// as do the results and list views. Preview of a DRAFT and the
// filter-resolving send (no recipientContactIds, not seeds_only) re-check
// EVERY member of the STORED list (D7; authoritiesOfFilter, so a legacy row's
// string is its one member): each must be EXACTLY a listed name, else the
// same 422 for the first that is not, where a stored spelling names its entry
// as the one candidate. The curated send, seeds_only drafts and non-draft
// previews are never re-checked; nothing rewrites a broadcast.
```

**Step 7 - run GREEN** (the whole route suite, the seed name guard and the
rules module):

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts test/followUpsApi.test.ts test/audienceResolution.test.ts test/blastAudienceRules.test.ts test/seedOrgNames.test.ts
```

Expected: all pass - including the untouched legacy-fixture re-check tests
(`:2282-2366`), now going through `authoritiesOfFilter`.

**Step 8 - typecheck, lint, ASCII, smoke.**

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

```bash
cd "W:/tmp/matching-blast-rules" && npx eslint app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && git diff -U0 -- app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts | grep -cP '^\+.*[^\x00-\x7F]'
```

```bash
cd "W:/tmp/matching-blast-rules" && npm run smoke
```

Expected: 0 / 0 / `0` / smoke exits 0 (the new `lib/blastAudienceRules.js`
import resolves in the compiled output).

**Step 9 - commit.**

```bash
cd "W:/tmp/matching-blast-rules" && git status
```

```bash
test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

```bash
cd "W:/tmp/matching-blast-rules" && git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts && git commit -F - <<'EOF'
feat(app): stored filter re-check covers every listed authority; results and list answer the wire filter (plan 1.5)

matching-blast-rules D2: storedFilterRefusal reads authoritiesOfFilter and
answers the 422 for the first member that is not exactly a listed name (one
list read). The results and list projections send wireAudienceFilter, so a
legacy row reads as a one-member housing_authorities. Router header updated.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

**Slice S1 end check** (plan section 3: each slice ends green on its own unit
suites and typecheck):

```bash
cd "W:/tmp/matching-blast-rules/app" && npx vitest run test/blastAudienceRules.test.ts test/toursRepoListByStatusRange.test.ts test/toursRepo.integration.test.ts test/tourAutoClose.test.ts test/repoPagingWiring.test.ts test/audienceResolution.test.ts test/broadcastApi.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts test/followUpsApi.test.ts test/seedOrgNames.test.ts
```

```bash
cd "W:/tmp/matching-blast-rules" && npm run typecheck
```

### Spec coverage map

| Spec item | Task |
|---|---|
| D1 filter audience = tenants `searching` / `onboarding` only | 1.3 (resolver + route pin), constant 1.1 |
| D1 read the two `byTypeStatus` partitions, searching FIRST, under the existing page bound and truncation flag | 1.3 |
| D1 `byHousingAuthority` branch removed from the resolver; other fences unchanged | 1.3 |
| D1 status-excluded tenants not listed in the review | 1.3 (route-level preview pin) |
| D2 `AudienceFilter.housing_authorities?: string[]` | 1.1 |
| D2 any-of on the trimmed `housingAuthority`; empty/absent = no filter; missing or non-member excluded while non-empty | 1.3 (resolver), 1.1 (normalizer) |
| D2 POST accepts the list; at most 100; the 400 message | 1.4 |
| D2 members via `orgNames.checkList`; trimmed, blanks dropped, de-duplicated; spellings stored as names; FIRST failing member is the 422 | 1.4 |
| D2 stored draft carries `housing_authorities`, never `housing_authority` | 1.4 |
| D2 LEGACY body string as a one-member list; both keys 400 | 1.4 |
| D2 LEGACY storage through ONE normalizer `authoritiesOfFilter` | 1.1; used by the resolver (1.3), `storedFilterRefusal` (1.5), the create echo (1.4), the results/list projections (1.5); preview and send path (c) reach it through those two |
| D2 responses send `housing_authorities`, never `housing_authority` (create echo, results `:393`, list `:421`) | 1.4 (echo), 1.5 (projections) |
| D2 `storedFilterRefusal` checks EVERY member in order, first failure answered, candidate = its entry | 1.5 |
| D4 hold table, both boundaries, pending conversion claim, kind order, tie-breaks, keyed on `tenantId` with no type assumption | 1.1 (pure; S2 wires it) |
| D5 `checkedByDefault` for every flag combination; seeds checked whatever their flags; no consent never | 1.1 (pure; S2 wires it) |
| D5 open-tours read: `requested` with `createdAt >= now - 14 days` as a KEY condition; every page of the partitions | 1.2 (repo option, harness fake, DynamoDB Local case; S2 makes the read) |
| D10 partners never resolve from a filter, any status or authority | 1.3 (partition-fake pin + leaky-index fence pin + route pin `:2496-2505` kept) |
| Section 4: GSI and `listByHousingAuthority` kept; the resolver stops calling them | 1.3 (`haQueries` pinned empty; nothing deleted) |
| Section 4: truncation issue's status-order cut gone | 1.3 (resolver header; S4 resolves the issue file) |
| Section 6 unit: the hold rule | 1.1 |
| Section 6 unit: the review-rows `checkedByDefault` combinations | 1.1 (the rule; the review-rows function is S2) |
| Section 6 unit: the resolver (statuses, searching first on `contactsPartitionFake`, any-of, blank/non-member, legacy string, partner never, existing fences) | 1.3 |
| Section 6 unit: POST create - list stored as names, spelling, first off-list 422, more than 100 400, legacy one-member, both keys 400 | 1.4 |
| Section 6 unit: preview - legacy stored filter previews; `storedFilterRefusal` over a list | 1.5 (+ the kept legacy fixtures `:2282-2366`) |
| Section 6 unit: the open-tours read's `requested` key condition; every page | 1.2 |
| Section 7: `broadcastsRepo.ts:84-90` type | 1.1 |
| Section 7: `parseAudienceFilter`, POST create list check | 1.4 |
| Section 7: `storedFilterRefusal`, results `:393` and list `:421` projections | 1.5 |
| Section 7: router header comment (the `:14-28` audience + organization paragraphs) | 1.5 (S2 owns `:6-12`) |
| Section 7: `audienceResolution.ts` whole read, header, truncation TODO, `byHousingAuthority` log field | 1.3 |
| Section 7: `toursRepo.ts` open-tours read option; harness fake `toursRepo` models it | 1.2 |
| Section 7 tests: `audienceResolution.test.ts` (`tenant()` default `active`) | 1.3 |
| Section 7 tests: `broadcastApi.test.ts` string filters; the "does NOT filter on status" comment `:62-64` | 1.4, 1.5 (filters), 1.3 (comment) |

NOT delivered by S1 (owned elsewhere): the POST create estimate (D8),
`readOpenTourHolds` / `buildReviewRows`, preview fields / `tourHolds` / 503 /
seeds-only degrade, send path (c) exclusions and the new truncation
messages, the full-profile seed broadcasts, the ALONE comments and the other
`byHousingAuthority` comments, `seedOrgNames.test.ts` (all S2); everything
dashboard (S3); e2e, selectors, GLOSSARY, RUNBOOK, issues (S4).

### Notes for other slices

- **S2, `app/test/seedOrgNames.test.ts`.** `orgValues` (`:84-89`) reads only
  `audience_filter.housing_authority`, and `:141-146` expects the matrix's
  two broadcasts to read `[SEED_AUTHORITY.atlanta, SEED_AUTHORITY.dca]` from
  that key. When S2 moves one matrix broadcast to the list shape
  (`app/src/lib/seed/matrix.ts:1224-1230` / `:1257-1263`), `:141-146` FAILS
  (it reads `undefined` for the list row) and `orgValues` silently stops
  checking that row's names. Make `orgValues` read
  `authoritiesOfFilter(filter)` (import from `../src/lib/blastAudienceRules.js`)
  and make `:141-146` assert the normalized lists per broadcast (and that one
  row is legacy-shaped, one list-shaped).
- **S2, truncation message.** `app/test/broadcastApi.test.ts:683` asserts
  `expect(send.body.message).toMatch(/narrow/)`; the section 1.1 message
  drops "narrow" - update that assertion with the message change.
- **S2, `declineLabelsUnavailable`.** Asserted at `broadcastApi.test.ts:303`,
  `:2550`, `:2599`, `:2630`; the degraded describe `:2616-2646` is exactly the
  behavior D5 replaces (a filter draft -> 503).
- **S2, the open-tours read.** Call
  `tours.listByStatus('requested', { createdAtFrom: new Date(nowMs - TOUR_REQUEST_HOLD_MS).toISOString() })`
  plus the three unbounded partitions. The key condition is `>=`, and
  `tourHoldOf` holds a request only while `now - createdAt < 336 h`, so the
  row created exactly at the bound is READ but NOT held - consistent, no
  special case. Feed the rows to `tourHoldsByTenant` (a `TourItem` is a
  `TourHoldInput` - pinned by typecheck in `blastAudienceRules.test.ts`).
  `tourAutoClose.test.ts:473-477` replaces the fake's `listByStatus` with a
  one-argument wrapper; any new test that wraps it for the open-tours read
  must forward `opts`. A throwing read in route tests:
  `vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(...)`.
- **S2, the estimate.** Task 1.4 left the POST create estimate as today's
  (resolver + seed union, `broadcasts.ts:652-667`); the D2 list check block
  sits directly above it and must stay above the estimate (the estimate must
  see entry names). The 1.4 test "the estimate counts tenants holding ANY
  listed authority" uses consented, hold-free tenants, so it stays at 2 under
  D8's default-checked count; so does Task 1.3's D1 route pin.
- **S2, router header.** S1 rewrote `broadcasts.ts:14-28` (audience +
  organization names). The endpoint lines `:6-12` (preview / create shapes)
  are S2's; `:1`, `:6-9`, `:11` already hold non-ASCII characters - only added
  lines must be ASCII.
- **S2, the resolver log.** The `broadcast audience resolved` line now carries
  `authorities: <count>` instead of `byHousingAuthority`; the TODO marker for
  `broadcast-audience-truncation-drops-searching-tenants` is gone from the
  resolver (its header names the issue as resolved by D1). S2's comment sweep
  must NOT re-add a `byHousingAuthority` mention to `audienceResolution.ts`.
- **S2, the type belt.** The resolver now also skips a row whose `status` is
  not the partition's (contract issue 4). `buildReviewRows` needs no status
  logic of its own for filter rows; seeds keep any status (resolveSeeds is
  unchanged).
- **S3.** From S1 on, every server response carrying a filter (create echo,
  results, list) sends `{ contact_type, housing_authorities?, bedroomSize?,
  excludeOptedOut, excludeUnreachable }` and never `housing_authority`;
  `audienceSummary` (`dashboard/src/routes/broadcasts/broadcastFormat.ts:61-68`)
  shows no authority until Task 3.1 (contract issue 5). The server accepts
  BOTH the legacy `housing_authority` string and `housing_authorities` from
  S1 on, so the dashboard keeps working mid-build. A 422 for a list names the
  FIRST failing member in `text` - the member D3b removes.
- **S4.** From S1 on the e2e Matching specs that rely on tenants outside
  Searching/Onboarding (e.g. the lean seed's Tasha, `placing`) or on
  authority-less tenants under an authority filter start failing - the stated
  mid-build breakage. The truncation issue
  (`docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`) is
  fixed in code by Task 1.3; S4 flips its status to resolved with the note
  spec section 4 asks for. A path (c) send through the API with
  `audience_filter.housing_authority` (`a2p-compliance.spec.ts:480`) keeps
  working: the body string is stored as a one-member list.

## 6. S2 - App rules in the routes (Tasks 2.1-2.5)

# S2 - App rules in the routes (Tasks 2.1-2.5) - section draft

Slice owner: `app/src/routes/broadcasts.ts` and `app/test/broadcastApi.test.ts`,
plus the full-profile seed broadcasts (`app/src/lib/seed/matrix.ts`,
`app/test/seedOrgNames.test.ts`) and the server comments spec section 7 names.

ASSUMES S1 is done exactly as binding 2.1-2.4 describe:
`app/src/lib/blastAudienceRules.ts` exports `TOUR_REQUEST_HOLD_MS`,
`BLAST_TENANT_STATUSES`, `MAX_FILTER_AUTHORITIES`, `TourHoldKind`,
`TOUR_HOLD_KIND_ORDER`, `TourHold`, `TourHoldInput`, `tourHoldOf`,
`pickTourHold`, `tourHoldsByTenant`, `DefaultCheckFlags`, `checkedByDefault`,
`authoritiesOfFilter`, `WireAudienceFilter`, `wireAudienceFilter`;
`AudienceFilter` has `housing_authorities?: string[]` and keeps the deprecated
`housing_authority?: string`; `toursRepo.listByStatus(status, opts?: {
createdAtFrom?: string })` and the harness fake models `createdAtFrom`; the
resolver reads `searching` then `onboarding` only; parse / create list check /
`storedFilterRefusal` / projections use the list. S2 never re-implements any
of that. Where an S2 edit quotes a line S1 may also have edited, the task says
so: re-read the current line and apply the same change on top of S1's text -
never revert S1.

### CONTRACT ISSUES

1. Binding 2.5 `class AudienceRulesUnavailableError extends Error {}` is too
   thin for POST create. Wire 2.6 keeps `truncated: boolean` in the 201 even
   when `estimatedCount` is omitted, but `buildReviewRows` throws before it can
   return the resolution's `truncated`. FIX (router-private, no other slice
   sees it): the class carries the flag -
   `class AudienceRulesUnavailableError extends Error { readonly truncated: boolean; constructor(truncated: boolean, options?: ErrorOptions) }`.
   Task 2.1 implements this; Task 2.2 reads `err.truncated`.
2. Binding 2.5 lists `readOpenTourHolds` and `buildReviewRows` only, but send
   path (c) (D6) needs the two fail-closed reads WITHOUT seeds and WITHOUT the
   already-sent read. FIX (additive, router-private): one more closure,
   `readAudienceRules(unitId: string | undefined, nowMs: number): Promise<{ tourHolds: Map<string, TourHold>; declinedIds: Set<string> }>`,
   shared by `buildReviewRows` and path (c).
3. Plan 1.1 binds only the TRUNCATED `audience_too_large` message. The
   over-cap message (a COMPLETE audience above 1000) is unspecified; spec D7
   strips the narrowing advice from the truncation message only. S2 keeps the
   over-cap advice (the housing authority and bedroom-size filters still narrow
   a complete audience) and only swaps its U+2014 for ` - ` because the line is
   rewritten: `audience of ${n} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`.
   FIX: add that string to 1.1 as binding copy (Task 2.3 tests it verbatim).
4. Spec section 7 names the router header comment (`broadcasts.ts:6-28`) but
   plan section 3 assigns it to no slice. FIX: S2 owns lines 6-8 (route
   shapes S2 changes) and the "Audience:" paragraph (14-18); S1 owns the
   "Organization names" paragraph (20-28). Task 2.5 merges onto S1's text if S1
   already rewrote 14-18.
5. Spec section 7's `byHousingAuthority` comment list misses
   `app/src/repos/contactsRepo.ts:1396-1397` ("Broadcast targeting must never
   reach a soft-deleted contact", inside `listByHousingAuthority`) - same rule
   as spec section 4 ("comments that call it the broadcast audience key are
   corrected"). FIX: Task 2.5 corrects it too. Conversely `dev.ts:1263-1264` and
   `lean.ts:109` never call the GSI a broadcast key; Task 2.5 only adds
   "kept; blast audiences no longer read it" so every mention reads the same.
6. Ground rule 0 ("every task has a real RED case") cannot hold for a
   comment-only task. FIX: Task 2.5 uses a `git grep` gate as its RED (prints
   the 7 stale lines) and GREEN (prints nothing).
7. Spec D5 words the 503 as applying "while previewing a draft that resolves
   filter rows". The preview route also serves non-draft shares (API only).
   S2 keys the 503 on `audience_mode !== 'seeds_only'` whatever the status (the
   same reads; a list without the rules is equally wrong). No change proposed;
   recorded so a reviewer does not read it as drift.

### Facts the tasks rely on (verified)

Verified on the worktree at 9a945ec1 (main @a2b3d80d + docs). Line numbers are
pre-S1; S1 edits move some of them (each task re-anchors on text).

- `app/src/routes/broadcasts.ts`
  - `:6-8` route lines of the header contain U+2192 arrows; `:14-18` the
    "Audience:" paragraph (ASCII); `:20-28` the org-names paragraph (S1).
  - `:49-50` imports `type AudienceFilter`, `type BroadcastAudienceMode`;
    `:66` imports `createToursRepo, type TourItem, type ToursRepo`; `:69-73`
    imports `type ResolvedContact`; `:74-80` imports `priorRecipientKeys`;
    `:84` `import { buildFollowUps } from '../services/followUps.js';` is the
    last import.
  - `:110-113` the "composer flag ALONE reads a queued slot's send-attempt
    record" doc on `sendAttemptsRepo` (spec cites 111-114; 114 is the field).
  - `:433` `export function createBroadcastsRouter(deps: BroadcastsRouterDeps = {}): Router {`
    (unique); `:446` `const tours = deps.toursRepo ?? createToursRepo(...)`.
  - `:451-461` `effectiveDeclines` doc: "Throws on any failed read; the caller
    turns that into the degraded flag ... D12's 503 does not apply" (`:458-460`);
    `:462-489` body (reads listingSends.listByUnit, then only with a declined
    row tours.listByUnit + contacts.getManyByIds requireComplete).
  - `:496-534` `resolveSeeds` (tenant OR partner, phone, not opted-out, not
    unreachable; `has_consent: hasSmsConsent(c)`).
  - `:547-567` `storedFilterRefusal`; `:569` `  const router = Router();` (unique).
  - POST create `:572-705`: `:625-626` `seedContactIds` (string[] | undefined);
    `:632-633` `audienceMode`; `:652-667` the estimate block (ASCII, unique);
    `:678` `      estimatedAudience,`; `:687-690` audit `estimatedCount` and the
    log line; `:695-696` `status: 'draft',` + `estimatedCount: estimatedAudience,`
    (the only `status: 'draft',` in the file).
  - Preview `:717-841`: `:716` header comment ending "+ declineLabelsUnavailable.";
    `:729-736` the D7 re-check (S1's domain, untouched by S2); `:737-840` the body
    S2 replaces (U+2014 at `:783`, `:804`, `:807`; U+2026 at `:808`);
    `:766-769` priorRecipientKeys; `:773-782` the decline degrade.
  - Send `:856-1063`: `:879-885` Available guard; `:898` path (c) summary line
    (ASCII); `:910-961` path (a); `:962-974` path (b); `:975-1023` path (c)
    (U+2192 at `:1000`, U+2014 at `:1001`, `:1011`, `:1012`); `:1025-1039`
    markSending with the ConditionalCheckFailedException -> 409 branch.
  - `:1108-1111` results route "the composer flag alone reads it" (ASCII).
- `app/src/services/shareRecipientState.ts:249-269` `priorRecipientKeys` never
  throws (catch -> WARN, partial set); `:190` record reads only with
  `recordReads: true`, which `:259` passes.
- `app/src/repos/broadcastsRepo.ts:47` `BroadcastAudienceMode = 'filter' | 'seeds_only'`;
  `:223` `audience_mode?` (absent = filter); `:75` `MAX_BROADCAST_RECIPIENTS = 1000`;
  `:722` create sets `stats.audience` only when `estimatedAudience` is a number
  (else `zeroStats()` -> 0). Harness twin `app/test/helpers/twilioWebhookHarness.ts:3695`.
- Harness (`app/test/helpers/twilioWebhookHarness.ts`): `toursMap` `:3912`;
  `toursRepo` `:3920`; `listByStatus` `:3964-3969` (S1 adds `createdAtFrom`);
  `listByUnit` `:3954-3956`; listing-sends `listByUnit` `:3608-3612`;
  broadcasts `markSending` `:3736-3748`, `listByUnit` `:3890`; contacts
  `listByType` filters `opts.status` `:2327`; audit records `payload` `:2667-2672`;
  `audienceResolutionService` override `:5641-5646`; `toursRepo` and
  `listingSendsRepo` handed to the api router `:5608-5610`, which passes both to
  the broadcasts router (`app/src/routes/api.ts:1088-1112`).
- `app/test/broadcastApi.test.ts`: imports `ConditionalCheckFailedException`
  `:8`, `MAX_BROADCAST_RECIPIENTS` `:27`, `ListingSendItem` `:40`, `TourItem`
  `:41`, `SEED` `:42`; `seedTenant` `:58-74` (status `searching`,
  `consent_method: 'inbound_text'`); `seedUnit` `:76-87` (`unit-1`, available);
  `isoFromNow` `:95-97`; `seedShare` `:127-151` (unitId `unit-1`);
  `SEED_ATTEMPT_FACTS` `:154`; `createDraft` `:820-827` (filter draft on
  `unit-1`, body spread last); `authedGet` `:1574-1576` (both function
  declarations inside the top-level describe, so hoisted for nested describes);
  exact preview candidate `:289-303` (`declineLabelsUnavailable` `:303`);
  over-cap/truncated test `:648-687` (`toMatch(/narrow/)` `:683`, unique);
  last-heard-from describe `:2508-2647` (`declineLabelsUnavailable` `:2550`,
  `:2599`, degrade helper `:2616-2646`); the file's ONLY line that is exactly
  `});` is the last one, `:2648`.
- `app/src/lib/smsCompliance.ts:101-103` consent = non-empty `consent_method`.
- Fan-out: a no-consent recipient is skipped with code `no_consent`, bucket
  `skipped_no_consent` (`app/src/jobs/broadcastFanOut.ts:279-280`); the results
  route derives `skipped_no_consent` from slots (`broadcastsRepo.ts:345`).
- `app/src/routes/contacts.ts:962-964` POST `/api/contacts` defaults a tenant
  to `onboarding`; `e2e/tests/dashboard-next/a2p-compliance.spec.ts:70-87`
  creates its tenants that way, and the path (c) case `:445-510` drafts with NO
  `unitId` and a run-unique authority.
- Seeds: `app/src/lib/seed/matrix.ts:1224-1230` (sent share, legacy
  `housing_authority: SEED_AUTHORITY.atlanta`), `:1257-1263` (draft,
  `housing_authority: SEED_AUTHORITY.dca`; the line is unique); body_template
  lines `:1231`, `:1264` hold U+2014 (untouched). `SEED_AUTHORITY.dekalb` =
  `'DeKalb County Housing Authority'` (`app/src/lib/seed/orgList.ts:35`).
  `app/test/seedOrgNames.test.ts:83-88` reads only `housing_authority`;
  `:142-147` expects `[SEED_AUTHORITY.atlanta, SEED_AUTHORITY.dca]`.
- Comments: `contacts.ts:650` (U+2014) + `:651` (ASCII, "for broadcast
  targeting."); `dev.ts:1263-1264` (ASCII); `apply.ts:1208-1209` (ASCII);
  `lean.ts:109` (ASCII); `contactsRepo.ts:770-771` (ASCII; `:772-773` hold
  U+00A7 / U+2014, untouched); `contactsRepo.ts:1396` (U+2014) + `:1397`.
- Express 5 (`app/package.json:36`): a thrown async handler is a 500.
  `tsconfig.base.json`: target ES2023 (`ErrorOptions` available), strict, no
  `exactOptionalPropertyTypes`; `app/tsconfig.test.json` typechecks `app/test`
  under `npm run typecheck`. `eslint.config.mjs` has no duplicate-import rule.
- Other suites touching these routes set their spies AFTER the draft create
  (`app/test/contactsBatchIncomplete.test.ts:209-224`,
  `app/test/contactsBatchReads.test.ts:349-353`), so create's new reads do not
  disturb them.

---

## Task 2.1 - Review rows: tour holds and `checkedByDefault` in the preview; fail closed (D4, D5, D7)

Files: `app/src/routes/broadcasts.ts`, `app/test/broadcastApi.test.ts`.

### Step 1 - tests (write first)

T-Edit 1. In `app/test/broadcastApi.test.ts`, after the line
`import { SEED } from '../src/lib/seed/lean.js';` add:

```ts
import { TOUR_REQUEST_HOLD_MS } from '../src/lib/blastAudienceRules.js';
```

(If S1 already imports from `'../src/lib/blastAudienceRules.js'` in this
file, add `TOUR_REQUEST_HOLD_MS` to that statement instead.)

T-Edit 2. In the test `'POST /preview re-resolves the audience + returns the full candidate list with phones'`, replace:

```ts
        status: 'searching',
        declinedThisProperty: false,
      },
    ]);
    expect(res.body.priorRecipientContactIds).toEqual([]);
    expect(res.body.declinedContactIds).toEqual([]);
    expect(res.body.declineLabelsUnavailable).toBe(false);
  });
```

with:

```ts
        status: 'searching',
        declinedThisProperty: false,
        // matching-blast-rules D5: the server's default-check rule (no tour
        // hold here, so no tourHold key).
        checkedByDefault: true,
      },
    ]);
    expect(res.body.priorRecipientContactIds).toEqual([]);
    expect(res.body.declinedContactIds).toEqual([]);
    expect(res.body.tourHolds).toEqual([]);
    // D5/D7: the decline-only degrade flag is gone; the seeds_only flag is absent on success.
    expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
    expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
  });
```

T-Edit 3. Replace:

```ts
      expect(res.body.declinedContactIds).toEqual(['c-1']);
      expect(res.body.declineLabelsUnavailable).toBe(false);
```

with:

```ts
      expect(res.body.declinedContactIds).toEqual(['c-1']);
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
```

T-Edit 4. Replace the test title line:

```ts
    it('a draft with no property reads nothing: both lists empty, no degraded flag', async () => {
```

with:

```ts
    it('a draft with no property reads no declines: both lists empty, no unavailable flag', async () => {
```

T-Edit 5. Replace:

```ts
      expect(res.body.declineLabelsUnavailable).toBe(false);
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
```

with:

```ts
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
      expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
```

T-Edit 6. Replace the whole degrade block at the end of the
`'last-heard-from 5.3 + D11: the preview not-interested labels'` describe:

```ts
    // B13: the harness getManyByIds ignores requireComplete, so the degraded
    // branch is driven by making each read REJECT.
    async function expectDegraded(arm: () => void): Promise<void> {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(declinedRow('c-1'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      arm();
      const res = await previewDraft(app, id);
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
      expect(res.body.declinedContactIds).toEqual([]);
      expect(res.body.declineLabelsUnavailable).toBe(true);
    }
    it('a failed listing-sends read serves the candidates with NO labels and declineLabelsUnavailable', async () => {
      await expectDegraded(() => {
        vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed tours read serves the candidates with NO labels and declineLabelsUnavailable', async () => {
      await expectDegraded(() => {
        vi.spyOn(world.toursRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed (or incomplete) contacts batch serves the candidates with NO labels and declineLabelsUnavailable', async () => {
      await expectDegraded(() => {
        vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValueOnce(new Error('IncompleteBatchReadError'));
      });
    });
```

with:

```ts
    // B13: the harness getManyByIds ignores requireComplete, so the failed
    // read is driven by making each read REJECT. matching-blast-rules D5: a
    // filter draft whose decline read fails is no longer served without its
    // labels - the preview fails CLOSED (503, no list), because a list
    // without them would check tenants who said Not interested.
    async function expectRulesUnavailable(arm: () => void): Promise<void> {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(declinedRow('c-1'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      arm();
      const res = await previewDraft(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    }
    it('a failed listing-sends read fails the filter preview closed: 503 audience_rules_unavailable, no list', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed tours read (the decline supersession read) fails the filter preview closed', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.toursRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed (or incomplete) contacts batch fails the filter preview closed', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValueOnce(new Error('IncompleteBatchReadError'));
      });
    });
```

T-Edit 7. Insert a new describe inside the top-level describe: replace the
last two lines of the file

```ts
  });
});
```

(the only occurrence: the file's last line is its only line that is exactly
`});`) with:

```ts
  });

  // --- matching-blast-rules D4/D5/D7: the preview's review rows -------------
  describe('matching-blast-rules D4/D5/D7: the preview review rows', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';
    type Row = Record<string, unknown>;

    /** A tour written straight into the world. unitId defaults to ANOTHER
     *  property: a hold counts an unresolved tour for ANY property (D4). */
    function seedTour(t: {
      tourId: string;
      tenantId: string;
      status: string;
      unitId?: string;
      createdAt?: string;
      scheduledAt?: string;
      outcome?: TourItem['outcome'];
      moveForward?: boolean;
      convertible?: boolean;
    }): TourItem {
      const createdAt = t.createdAt ?? isoFromNow(-10 * DAY);
      const item: TourItem = {
        tourId: t.tourId,
        tenantId: t.tenantId,
        unitId: t.unitId ?? 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: t.status,
        createdAt,
        updatedAt: createdAt,
        ...(t.scheduledAt !== undefined && { scheduledAt: t.scheduledAt }),
        ...(t.outcome !== undefined && { outcome: t.outcome }),
        ...(t.moveForward !== undefined && { moveForward: t.moveForward }),
        ...(t.convertible !== undefined && { convertible: t.convertible }),
      };
      world.toursMap.set(item.tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1 (listed, then declined; no later send or tour). */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function preview(app: import('express').Express, id: string) {
      return request(app)
        .post(`/api/broadcasts/${id}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    }

    /** A seeds_only draft: the direct send from a tenant's or caseworker's page. */
    async function createSeedsOnly(app: import('express').Express, seedContactIds: string[]): Promise<string> {
      const res = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds });
      expect(res.status).toBe(201);
      return res.body.broadcastId as string;
    }

    function rowsById(body: { candidates: Row[] }): Map<string, Row> {
      return new Map(body.candidates.map((c) => [c['contactId'] as string, c]));
    }

    function sortedHolds(body: { tourHolds: Array<{ contactId: string }> }): Array<{ contactId: string }> {
      return [...body.tourHolds].sort((a, b) => (a.contactId < b.contactId ? -1 : 1));
    }

    it('every D4 hold kind reaches its candidate as tourHold and unchecks it; a resolved or stale tour holds nothing', async () => {
      seedUnit(world);
      const ids = [
        'c-up', 'c-unmarked', 'c-needs-placement', 'c-needs-outcome', 'c-noshow', 'c-req',
        'c-old-req', 'c-closed', 'c-canceled', 'c-done', 'c-free',
      ];
      ids.forEach((contactId, i) => seedTenant(world, { contactId, phone: `+1555030${String(i + 1).padStart(4, '0')}` }));
      const upAt = isoFromNow(3 * DAY);
      const pastAt = isoFromNow(-2 * DAY);
      const reqAt = isoFromNow(-1 * DAY);
      seedTour({ tourId: 't-up', tenantId: 'c-up', status: 'scheduled', scheduledAt: upAt });
      seedTour({ tourId: 't-unmarked', tenantId: 'c-unmarked', status: 'scheduled', scheduledAt: pastAt });
      seedTour({
        tourId: 't-needs-placement',
        tenantId: 'c-needs-placement',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
      });
      seedTour({ tourId: 't-needs-outcome', tenantId: 'c-needs-outcome', status: 'toured', scheduledAt: pastAt });
      seedTour({ tourId: 't-noshow', tenantId: 'c-noshow', status: 'no_show', scheduledAt: pastAt });
      seedTour({ tourId: 't-req', tenantId: 'c-req', status: 'requested', createdAt: reqAt });
      seedTour({ tourId: 't-old-req', tenantId: 'c-old-req', status: 'requested', createdAt: isoFromNow(-15 * DAY) });
      seedTour({ tourId: 't-closed', tenantId: 'c-closed', status: 'closed', scheduledAt: pastAt, outcome: 'not_a_fit', convertible: false });
      seedTour({ tourId: 't-canceled', tenantId: 'c-canceled', status: 'canceled', scheduledAt: upAt });
      seedTour({
        tourId: 't-done',
        tenantId: 'c-done',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'not_a_fit',
        moveForward: false,
        convertible: false,
      });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-up')?.['tourHold']).toEqual({ kind: 'upcoming', tourId: 't-up', at: upAt });
      expect(byId.get('c-unmarked')?.['tourHold']).toEqual({ kind: 'not_marked', tourId: 't-unmarked', at: pastAt });
      expect(byId.get('c-needs-placement')?.['tourHold']).toEqual({
        kind: 'needs_placement',
        tourId: 't-needs-placement',
        at: pastAt,
      });
      expect(byId.get('c-needs-outcome')?.['tourHold']).toEqual({ kind: 'needs_outcome', tourId: 't-needs-outcome', at: pastAt });
      expect(byId.get('c-noshow')?.['tourHold']).toEqual({ kind: 'no_show', tourId: 't-noshow', at: pastAt });
      expect(byId.get('c-req')?.['tourHold']).toEqual({ kind: 'requested', tourId: 't-req', at: reqAt });
      for (const id of ['c-up', 'c-unmarked', 'c-needs-placement', 'c-needs-outcome', 'c-noshow', 'c-req']) {
        expect(byId.get(id)?.['checkedByDefault'], id).toBe(false);
      }
      for (const id of ['c-old-req', 'c-closed', 'c-canceled', 'c-done', 'c-free']) {
        expect(byId.has(id), id).toBe(true);
        expect(byId.get(id), id).not.toHaveProperty('tourHold');
        expect(byId.get(id)?.['checkedByDefault'], id).toBe(true);
      }
      expect(sortedHolds(res.body)).toEqual([
        { contactId: 'c-needs-outcome', kind: 'needs_outcome', tourId: 't-needs-outcome', at: pastAt },
        { contactId: 'c-needs-placement', kind: 'needs_placement', tourId: 't-needs-placement', at: pastAt },
        { contactId: 'c-noshow', kind: 'no_show', tourId: 't-noshow', at: pastAt },
        { contactId: 'c-req', kind: 'requested', tourId: 't-req', at: reqAt },
        { contactId: 'c-unmarked', kind: 'not_marked', tourId: 't-unmarked', at: pastAt },
        { contactId: 'c-up', kind: 'upcoming', tourId: 't-up', at: upAt },
      ]);
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
      expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
    });

    it('checkedByDefault is the ONE server rule: a seed is checked whatever its flags; a held, declined, already-sent or no-consent filter row is not; tourHolds lists EVERY held contact, in the rows or not', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550301001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550301002' });
      seedTenant(world, { contactId: 'c-held-seed', phone: '+15550301003' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550301004' });
      seedTenant(world, { contactId: 'c-declined-seed', phone: '+15550301005' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550301006' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550301007', consent_method: undefined });
      seedTenant(world, { contactId: 'c-nocons-seed', phone: '+15550301008', consent_method: undefined });
      // Held but never a filter row: a Placing tenant (D1 leaves them out) and
      // a caseworker seed (D10: a filter never resolves partners; a hand pick may).
      seedTenant(world, { contactId: 'c-placing', phone: '+15550301009', status: 'placing' });
      seedTenant(world, { contactId: 'c-cw-seed', phone: '+15550301010', type: 'partner', status: 'active' });
      // An older tour whose tenantId names a LANDLORD still holds: the hold is
      // keyed on the tour's tenantId with no assumption about type (D4).
      world.contacts.push({ contactId: 'c-ll-tour', type: 'landlord', status: 'active', phone: '+15550301011' });
      const at = isoFromNow(3 * DAY);
      for (const tenantId of ['c-held', 'c-held-seed', 'c-placing', 'c-cw-seed', 'c-ll-tour']) {
        seedTour({ tourId: `t-${tenantId}`, tenantId, status: 'scheduled', scheduledAt: at });
      }
      world.listingSends.push(declinedRow('c-declined'), declinedRow('c-declined-seed'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, {
        seedContactIds: ['c-held-seed', 'c-declined-seed', 'c-nocons-seed', 'c-cw-seed'],
      });
      const res = await preview(app, id);
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(Object.fromEntries([...byId].map(([cid, r]) => [cid, r['checkedByDefault']]))).toEqual({
        'c-plain': true,
        'c-held': false,
        'c-held-seed': true,
        'c-declined': false,
        'c-declined-seed': true,
        'c-sent': false,
        'c-nocons': false,
        'c-nocons-seed': false,
        'c-cw-seed': true,
      });
      // A hand pick is never held: it starts checked AND keeps its label (D4).
      expect(byId.get('c-held-seed')).toMatchObject({
        seeded: true,
        tourHold: { kind: 'upcoming', tourId: 't-c-held-seed', at },
      });
      expect(byId.get('c-cw-seed')).toMatchObject({
        seeded: true,
        tourHold: { kind: 'upcoming', tourId: 't-c-cw-seed', at },
      });
      expect(byId.get('c-declined-seed')).toMatchObject({ seeded: true, declinedThisProperty: true });
      expect(byId.get('c-sent')).toMatchObject({ alreadySentThisProperty: true });
      expect(byId.get('c-nocons')).toMatchObject({ has_consent: false });
      expect(byId.has('c-placing')).toBe(false);
      expect(sortedHolds(res.body).map((h) => h.contactId)).toEqual([
        'c-cw-seed',
        'c-held',
        'c-held-seed',
        'c-ll-tour',
        'c-placing',
      ]);
    });

    it('the open-tours read is ONE read per preview: scheduled, toured and no_show to the end, requested from now minus 14 days (D5)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301101' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const spy = vi.spyOn(world.toursRepo, 'listByStatus');
      const before = Date.now();
      const res = await preview(app, id);
      const after = Date.now();
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(4);
      expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['no_show', 'requested', 'scheduled', 'toured']);
      for (const call of spy.mock.calls) {
        if (call[0] !== 'requested') expect(call[1], call[0]).toBeUndefined();
      }
      const requestedCall = spy.mock.calls.find((c) => c[0] === 'requested')!;
      const from = Date.parse(requestedCall[1]!.createdAtFrom!);
      expect(from).toBeGreaterThanOrEqual(before - TOUR_REQUEST_HOLD_MS);
      expect(from).toBeLessThanOrEqual(after - TOUR_REQUEST_HOLD_MS);
    });

    it('several unresolved tours: ONE hold is shown, by kind order, then the earliest upcoming date', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-multi', phone: '+15550301201' });
      seedTenant(world, { contactId: 'c-place', phone: '+15550301202' });
      const soon = isoFromNow(2 * DAY);
      const pastAt = isoFromNow(-3 * DAY);
      seedTour({ tourId: 't-late', tenantId: 'c-multi', status: 'scheduled', scheduledAt: isoFromNow(5 * DAY) });
      seedTour({ tourId: 't-soon', tenantId: 'c-multi', status: 'scheduled', scheduledAt: soon });
      seedTour({ tourId: 't-ask', tenantId: 'c-multi', status: 'requested', createdAt: isoFromNow(-1 * DAY) });
      seedTour({
        tourId: 't-np',
        tenantId: 'c-place',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
      });
      seedTour({ tourId: 't-next', tenantId: 'c-place', status: 'scheduled', scheduledAt: isoFromNow(1 * DAY) });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-multi')?.['tourHold']).toEqual({ kind: 'upcoming', tourId: 't-soon', at: soon });
      expect(byId.get('c-place')?.['tourHold']).toEqual({ kind: 'needs_placement', tourId: 't-np', at: pastAt });
    });

    it('a draft stored with the LEGACY one-string filter previews through the normalizer, rows carrying checkedByDefault', async () => {
      seedUnit(world);
      seedTenant(world, {
        contactId: 'c-aha',
        phone: '+15550301301',
        housingAuthority: 'Atlanta Housing Authority',
      } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dekalb',
        phone: '+15550301302',
        housingAuthority: 'DeKalb County Housing Authority',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-blank', phone: '+15550301303' });
      seedShare(world, 'bcast-legacy', 'draft', {}, {
        audience_filter: {
          contact_type: 'tenant',
          housing_authority: 'Atlanta Housing Authority',
          excludeOptedOut: true,
          excludeUnreachable: true,
        },
      });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, 'bcast-legacy');
      expect(res.status).toBe(200);
      expect(res.body.candidates.map((c: Row) => [c['contactId'], c['checkedByDefault']])).toEqual([['c-aha', true]]);
    });

    it('a FILTER draft whose tours read throws is 503 audience_rules_unavailable with NO list (D5 fail closed)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301401' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const res = await preview(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    });

    it('a filter draft with NO property still reads tours: a throwing tours read is 503 there too', async () => {
      seedTenant(world, { contactId: 'c-1', phone: '+15550301501' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { unitId: undefined });
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const res = await preview(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    });

    it('a seeds_only draft (a direct send): the seed keeps its tour label and stays checked; when the tours read throws it is served WITHOUT labels and says so', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301601' });
      const at = isoFromNow(2 * DAY);
      seedTour({ tourId: 't-1', tenantId: 'c-1', status: 'scheduled', scheduledAt: at });
      const { app } = makeWebhookHarness({ world });
      const id = await createSeedsOnly(app, ['c-1']);
      const ok = await preview(app, id);
      expect(ok.status).toBe(200);
      expect(ok.body.candidates).toHaveLength(1);
      expect(ok.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        seeded: true,
        checkedByDefault: true,
        tourHold: { kind: 'upcoming', tourId: 't-1', at },
      });
      expect(ok.body).not.toHaveProperty('audienceRulesUnavailable');
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const degraded = await preview(app, id);
      expect(degraded.status).toBe(200);
      expect(degraded.body.candidates).toHaveLength(1);
      expect(degraded.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        seeded: true,
        checkedByDefault: true,
        declinedThisProperty: false,
      });
      expect(degraded.body.candidates[0]).not.toHaveProperty('tourHold');
      expect(degraded.body.tourHolds).toEqual([]);
      expect(degraded.body.declinedContactIds).toEqual([]);
      expect(degraded.body.audienceRulesUnavailable).toBe(true);
    });

    it('a seeds_only draft whose decline read throws is served without the Not interested label, still checked, audienceRulesUnavailable', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301701' });
      world.listingSends.push(declinedRow('c-1'));
      const { app } = makeWebhookHarness({ world });
      const id = await createSeedsOnly(app, ['c-1']);
      const ok = await preview(app, id);
      expect(ok.status).toBe(200);
      expect(ok.body.candidates[0]).toMatchObject({ declinedThisProperty: true, checkedByDefault: true });
      expect(ok.body.declinedContactIds).toEqual(['c-1']);
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const degraded = await preview(app, id);
      expect(degraded.status).toBe(200);
      expect(degraded.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        declinedThisProperty: false,
        checkedByDefault: true,
      });
      expect(degraded.body.declinedContactIds).toEqual([]);
      expect(degraded.body.audienceRulesUnavailable).toBe(true);
    });
  });
});
```

### Step 2 - run RED

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected: the file compiles and these fail (every other test passes):
- `POST /preview re-resolves the audience + returns the full candidate list with phones`
  (toEqual: the candidate has no `checkedByDefault`).
- `an EFFECTIVE decline flags ...` and `a draft with no property reads no declines ...`
  (`expected { ... declineLabelsUnavailable: false } to not have property 'declineLabelsUnavailable'`).
- the three `... fails the filter preview closed` tests (`expected 200 to be 503`).
- all 9 tests of `matching-blast-rules D4/D5/D7: the preview review rows`
  (`expected undefined to deeply equal { kind: 'upcoming', ... }`,
  `expected "spy" to be called 4 times, but got 0 times`, `expected 200 to be 503`,
  `expected undefined to be true` for `audienceRulesUnavailable`, and the
  legacy test's `[['c-aha', undefined]]`).

### Step 3 - implementation (`app/src/routes/broadcasts.ts`)

I-Edit 1 (imports). After the line
`import { buildFollowUps } from '../services/followUps.js';` add:

```ts
import {
  checkedByDefault as isCheckedByDefault,
  TOUR_REQUEST_HOLD_MS,
  tourHoldsByTenant,
  type TourHold,
} from '../lib/blastAudienceRules.js';
```

If S1 already added an import from `'../lib/blastAudienceRules.js'` to this
file, put these four specifiers into that statement instead (lint treats both
forms the same).

I-Edit 2 (module-level types). Replace

```ts
export function createBroadcastsRouter(deps: BroadcastsRouterDeps = {}): Router {
```

with:

```ts
/**
 * matching-blast-rules D5/D6/D8: thrown by buildReviewRows when the open-tours
 * read or the #27 decline read fails for a FILTER draft. The preview answers
 * 503 audience_rules_unavailable; draft create omits its estimate. `truncated`
 * carries the audience resolution's flag (the resolution ran before the
 * failed read), so create still reports it.
 */
class AudienceRulesUnavailableError extends Error {
  readonly truncated: boolean;
  constructor(truncated: boolean, options?: ErrorOptions) {
    super('audience rules unavailable: a tours or decline read failed', options);
    this.name = 'AudienceRulesUnavailableError';
    this.truncated = truncated;
  }
}

/** What buildReviewRows needs from a draft (or from POST create's body). */
interface ReviewInput {
  audienceMode: BroadcastAudienceMode;
  filter: AudienceFilter;
  seedContactIds: string[];
  unitId?: string;
}

/** One review row: a resolved contact plus its D5 flags. */
interface ReviewRow extends ResolvedContact {
  seeded: boolean;
  alreadySent: boolean;
  declined: boolean;
  tourHold?: TourHold;
  checkedByDefault: boolean;
}

interface ReviewRowsResult {
  /** Audience rows first (resolver order), then seeds not already present. */
  rows: ReviewRow[];
  truncated: boolean;
  unresolvedSeedIds: string[];
  /** contactKeys (contactId or phone#<E164>) that MAY have received this property. */
  priorRecipients: Set<string>;
  /** Effective #27 declines of the property (empty without one). */
  declinedIds: Set<string>;
  /** EVERY held contact, in the rows or not (tourHolds on the wire). */
  tourHolds: Map<string, TourHold>;
  /** True only for a seeds_only preview whose rules reads threw. */
  rulesUnavailable: boolean;
}

export function createBroadcastsRouter(deps: BroadcastsRouterDeps = {}): Router {
```

I-Edit 3 (effectiveDeclines doc). Replace

```ts
   * whether tours count, spec 5.4). Throws on any failed read; the caller turns
   * that into the degraded flag - these are labels, not outcomes with buttons,
   * so D12's 503 does not apply.
   */
```

with:

```ts
   * whether tours count, spec 5.4). Throws on any failed read. Since
   * matching-blast-rules D5 a decline UNCHECKS a filter row by default, so its
   * callers fail closed (readAudienceRules): a filter preview and the no-body
   * filter send answer 503 audience_rules_unavailable, draft create omits its
   * estimate, and only a seeds_only preview is served without the labels.
   */
```

I-Edit 4 (the rules reads and the ONE review-rows function). Replace

```ts
  const router = Router();
```

with:

```ts
  /**
   * matching-blast-rules D5: the open-tours read - ONE read per call,
   * independent of audience size. The byStatus partitions `scheduled`,
   * `toured` and `no_show` are walked to the end (the same unbounded reads the
   * auto-close sweep makes every 15 minutes, jobs/tourAutoClose.ts); the
   * `requested` partition is bounded by its range key to the requests created
   * in the last 14 days - the only ones that can hold (D4) - because it grows
   * with every unbooked request. Grouped by tenantId in memory, one picked
   * hold per contact (any contact type: older tours may name a non-tenant).
   * Throws on any failed read; the caller decides what that means.
   */
  async function readOpenTourHolds(nowMs: number): Promise<Map<string, TourHold>> {
    const requestedFrom = new Date(nowMs - TOUR_REQUEST_HOLD_MS).toISOString();
    const [scheduled, toured, noShow, requested] = await Promise.all([
      tours.listByStatus('scheduled'),
      tours.listByStatus('toured'),
      tours.listByStatus('no_show'),
      tours.listByStatus('requested', { createdAtFrom: requestedFrom }),
    ]);
    return tourHoldsByTenant([...scheduled, ...toured, ...noShow, ...requested], nowMs);
  }

  /**
   * matching-blast-rules D5/D6: the two reads that fail CLOSED - the open-tour
   * holds and, with a property, its effective #27 declines - in parallel.
   * Throws the first failure as it came; callers decide (503 for a filter
   * preview and send path (c), no estimate at create, a label-less seeds_only
   * preview).
   */
  async function readAudienceRules(
    unitId: string | undefined,
    nowMs: number,
  ): Promise<{ tourHolds: Map<string, TourHold>; declinedIds: Set<string> }> {
    const [tourHolds, declinedIds] = await Promise.all([
      readOpenTourHolds(nowMs),
      unitId !== undefined ? effectiveDeclines(unitId) : Promise.resolve(new Set<string>()),
    ]);
    return { tourHolds, declinedIds };
  }

  /**
   * matching-blast-rules D5 (and D8): the ONE rule that builds a draft's review
   * rows - the preview serves them, POST create counts the checkedByDefault
   * ones as "Reaches N recipients".
   *  - filter draft: the resolved audience (D1, D2) united with the seeds
   *    (audience rows first, then seeds not already present; a contact in both
   *    is ONE row flagged seeded), the rules reads (readAudienceRules), then
   *    the already-sent set. A thrown tours or decline read throws
   *    AudienceRulesUnavailableError - never a list the rules did not check.
   *  - seeds_only + 'preview': the seeds alone, the same reads; a thrown rules
   *    read serves the rows WITHOUT tour or decline flags and sets
   *    rulesUnavailable (a direct send is never blocked by these reads).
   *  - seeds_only + 'estimate': NO rules or already-sent reads - every row is a
   *    seed, so checkedByDefault is has_consent (D8).
   * checkedByDefault = has_consent && (seeded || (!alreadySent && !declined && !held)).
   * The already-sent set (priorRecipientKeys) never throws: a failed page keeps
   * what it resolved - a soft hint by design, so a throttled read can leave an
   * already-sent tenant checked. It reads a queued slot's send-attempt record
   * (in flight vs stranded) with `recordReads: true`; this function is the ONLY
   * place those records are read - the preview and draft create call it, no
   * other route does (share-sent-outcome D1).
   */
  async function buildReviewRows(input: ReviewInput, mode: 'preview' | 'estimate'): Promise<ReviewRowsResult> {
    const seeds =
      input.seedContactIds.length > 0
        ? await resolveSeeds(input.seedContactIds)
        : { contacts: [], unresolved: [] };
    const seedIdSet = new Set(seeds.contacts.map((c) => c.contactId));
    const seedsOnly = input.audienceMode === 'seeds_only';
    if (seedsOnly && mode === 'estimate') {
      const seedRows: ReviewRow[] = seeds.contacts.map((c) => ({
        ...c,
        seeded: true,
        alreadySent: false,
        declined: false,
        checkedByDefault: isCheckedByDefault({
          hasConsent: c.has_consent,
          seeded: true,
          alreadySent: false,
          declined: false,
          held: false,
        }),
      }));
      return {
        rows: seedRows,
        truncated: false,
        unresolvedSeedIds: seeds.unresolved,
        priorRecipients: new Set<string>(),
        declinedIds: new Set<string>(),
        tourHolds: new Map<string, TourHold>(),
        rulesUnavailable: false,
      };
    }
    const audience: { contacts: ResolvedContact[]; truncated: boolean } = seedsOnly
      ? { contacts: [], truncated: false }
      : await resolveAudience(input.filter);
    const combined = [...audience.contacts.filter((c) => !seedIdSet.has(c.contactId)), ...seeds.contacts];
    let tourHolds = new Map<string, TourHold>();
    let declinedIds = new Set<string>();
    let rulesUnavailable = false;
    try {
      const rules = await readAudienceRules(input.unitId, Date.now());
      tourHolds = rules.tourHolds;
      declinedIds = rules.declinedIds;
    } catch (err) {
      log.warn(
        { err, audienceMode: input.audienceMode, mode, ...(input.unitId !== undefined && { unitId: input.unitId }) },
        'broadcast audience rules unavailable: a tours or decline read failed',
      );
      if (!seedsOnly) throw new AudienceRulesUnavailableError(audience.truncated, { cause: err });
      rulesUnavailable = true;
    }
    const priorRecipients =
      input.unitId !== undefined
        ? await priorRecipientKeys({ broadcasts, messages, attempts, log }, input.unitId)
        : new Set<string>();
    const rows: ReviewRow[] = combined.map((c) => {
      const seeded = seedIdSet.has(c.contactId);
      // The set is contactKeys - contactId OR `phone#<E164>` (a phone-only
      // recipient at the prior share's send time) - so match on EITHER key.
      const alreadySent =
        input.unitId !== undefined &&
        (priorRecipients.has(c.contactId) || priorRecipients.has(`phone#${c.phone}`));
      const declined = declinedIds.has(c.contactId);
      const tourHold = tourHolds.get(c.contactId);
      return {
        ...c,
        seeded,
        alreadySent,
        declined,
        ...(tourHold !== undefined && { tourHold }),
        checkedByDefault: isCheckedByDefault({
          hasConsent: c.has_consent,
          seeded,
          alreadySent,
          declined,
          held: tourHold !== undefined,
        }),
      };
    });
    return {
      rows,
      truncated: audience.truncated,
      unresolvedSeedIds: seeds.unresolved,
      priorRecipients,
      declinedIds,
      tourHolds,
      rulesUnavailable,
    };
  }

  const router = Router();
```

I-Edit 5 (preview header comment). Replace the line

```ts
  // last-heard-from: per candidate status? / lastHeardFromAt? / declinedThisProperty, plus declinedContactIds + declineLabelsUnavailable.
```

with:

```ts
  // last-heard-from: per candidate status? / lastHeardFromAt? / declinedThisProperty, plus declinedContactIds.
  // matching-blast-rules D5/D7: per candidate tourHold? / checkedByDefault, plus tourHolds and, for a
  // seeds_only draft whose rules reads failed, audienceRulesUnavailable; a filter draft whose tours or
  // decline read fails is 503 audience_rules_unavailable.
```

I-Edit 6 (preview body). Replace the block that starts with the line
`    // Seeded recipients attached to the draft: resolve them (same fences as the`
(pre-S1 line 737) and ends with the lines
`      declinedContactIds: [...declinedIds],` / `      declineLabelsUnavailable,` /
`    });` (pre-S1 lines 838-840) - i.e. everything after the D7 re-check `if`
block and before the handler's closing `  });`. The old block contains U+2014
(lines 783, 804, 807) and U+2026 (line 808): Read those lines from the file
to build `old_string`. New text:

```ts
    // matching-blast-rules D5: ONE server function builds the review rows (the
    // filter rows united with the hand-picked seeds - a seeds_only draft, the
    // seeded 1:1 entry, skips the filter so preview returns ONLY its seeds),
    // each flagged with the one checkedByDefault rule the composer applies.
    // A filter draft whose tours or decline read throws is 503
    // audience_rules_unavailable with NO list - serving one would check people
    // the rules leave out; a seeds_only draft is served without those labels
    // and says so (audienceRulesUnavailable).
    const seedIds = broadcast.seed_contact_ids ?? [];
    let review: ReviewRowsResult;
    try {
      review = await buildReviewRows(
        {
          audienceMode: broadcast.audience_mode ?? 'filter',
          filter: broadcast.audience_filter,
          seedContactIds: seedIds,
          ...(broadcast.unitId !== undefined && { unitId: broadcast.unitId }),
        },
        'preview',
      );
    } catch (err) {
      if (!(err instanceof AudienceRulesUnavailableError)) throw err;
      log.info({ broadcastId }, 'broadcast preview refused: audience rules unavailable - 503');
      res.status(503).json({ error: 'audience_rules_unavailable' });
      return;
    }
    // The candidate list carries phones - authed/internal response only; the
    // log line below stays IDs/counts only (NEVER phones/names/bodies).
    const candidates = review.rows.slice(0, MAX_BROADCAST_RECIPIENTS).map((r) => ({
      contactId: r.contactId,
      ...(r.firstName !== undefined && { firstName: r.firstName }),
      // Full name for the review rows (same authed/internal PII class as
      // firstName + phone).
      ...(r.lastName !== undefined && { lastName: r.lastName }),
      phone: r.phone,
      ...(r.voucherSize !== undefined && { voucherSize: r.voucherSize }),
      ...(r.housingAuthority !== undefined && { housingAuthority: r.housingAuthority }),
      // last-heard-from (spec 5.3): tenant status (absent for a partner seed)
      // and last heard from, for the review row's columns and order.
      ...(r.status !== undefined && { status: r.status }),
      ...(r.lastHeardFromAt !== undefined && { lastHeardFromAt: r.lastHeardFromAt }),
      // A2P/CTIA (LOCKED CONTRACT 3): whether this candidate has recorded SMS
      // consent. The composer surfaces "consent not recorded" for `false` +
      // a count; the fan-out EXCLUDES !has_consent recipients (broadcastFanOut).
      has_consent: r.has_consent,
      // SOFT - an earlier share of this unit MAY have reached the tenant
      // (share-sent-outcome D1's safe reading), matched on contactId OR the
      // `phone#<E164>` key.
      // TODO(broadcasts): the manually-added-tenant client-side annotation (the
      // dashboard matches `priorRecipientContactIds` by contactId) has the same
      // rare phone-only edge - a manually-added tenant prior-texted under a
      // `phone#<E164>` key won't be flagged client-side. Not addressed here.
      alreadySentThisProperty: r.alreadySent,
      // Whether this row came from the draft's seed_contact_ids (a hand-picked
      // recipient, or the seeded 1:1 entry). A contact in BOTH audience and
      // seeds is ONE row flagged seeded.
      seeded: r.seeded,
      // last-heard-from D11: an EFFECTIVE decline of this property.
      declinedThisProperty: r.declined,
      // matching-blast-rules D4/D7: the ONE unresolved tour shown for this
      // contact (any property), when there is one.
      ...(r.tourHold !== undefined && { tourHold: r.tourHold }),
      // D5: whether the review step starts this row checked (Select all
      // re-applies it); the dashboard reads it instead of computing a rule.
      checkedByDefault: r.checkedByDefault,
    }));
    // count/truncated derive from the post-union, pre-slice list (+ the audience
    // truncation flag) so the operator sees the true unioned reach.
    log.info(
      {
        broadcastId,
        count: review.rows.length,
        truncated: review.truncated,
        checkedByDefault: review.rows.filter((r) => r.checkedByDefault).length,
        heldContacts: review.tourHolds.size,
        rulesUnavailable: review.rulesUnavailable,
      },
      'broadcast audience previewed',
    );
    // Surface `truncated` (FIX 3+4) so the operator sees an incomplete/over-cap
    // audience BEFORE sending (and the dashboard can warn). seedContactIds (as
    // stored) + unresolvedSeedIds let the composer show which seeds dropped.
    res.json({
      count: review.rows.length,
      truncated: review.truncated,
      candidates,
      priorRecipientContactIds: [...review.priorRecipients],
      seedContactIds: seedIds,
      unresolvedSeedIds: review.unresolvedSeedIds,
      // last-heard-from (spec 5.3): the analog of priorRecipientContactIds -
      // annotates a hand-added row outside the audience client-side.
      declinedContactIds: [...review.declinedIds],
      // matching-blast-rules D7: EVERY held contact (the same analog), so Add a
      // tenant can label a tenant outside the candidates.
      tourHolds: [...review.tourHolds].map(([contactId, hold]) => ({ contactId, ...hold })),
      // D5: a seeds_only draft whose rules reads threw - served without the
      // tour and Not interested labels. Absent otherwise.
      ...(review.rulesUnavailable && { audienceRulesUnavailable: true as const }),
    });
```

(The handler's own closing `  });` that followed line 840 stays.)

### Step 4 - run GREEN

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected: every test in the file passes.

```
cd W:\tmp\matching-blast-rules; npm run typecheck -w @housingchoice/app
```

Expected: exit 0.

### Step 5 - ASCII check (Bash)

```
cd /w/tmp/matching-blast-rules && git diff -U0 -- app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts | grep -n -P '^\+(?!\+\+).*[^\x00-\x7F]'
```

Expected: no output (grep exit 1).

### Step 6 - commit

```
git -C W:\tmp\matching-blast-rules status
```

Read it: only the two files below are modified.

```
Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD"
```

Must print `False`.

```
git -C W:\tmp\matching-blast-rules add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(broadcasts): preview review rows carry tour holds and checkedByDefault from one server rule; a filter preview fails closed (matching-blast-rules D4, D5, D7)

buildReviewRows unions the filter rows and the seeds and flags each row
(alreadySent, declined, tourHold, seeded, consent) with
checkedByDefault = consent && (seeded || (!alreadySent && !declined && !held)).
The open-tours read is one read per call (scheduled, toured, no_show to the
end; requested from now minus 14 days). A filter draft whose tours or
decline read throws is 503 audience_rules_unavailable; a seeds_only preview
is served without the labels and sets audienceRulesUnavailable.
declineLabelsUnavailable is removed; tourHolds lists every held contact.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

---

## Task 2.2 - The reach estimate is the default-checked count (D8)

Files: `app/src/routes/broadcasts.ts`, `app/test/broadcastApi.test.ts`.

### Step 1 - tests (write first)

Append a new describe inside the top-level describe: replace the file's last
two lines

```ts
  });
});
```

with:

```ts
  });

  // --- matching-blast-rules D8: "Reaches N recipients" = the default-checked rows ---
  describe('matching-blast-rules D8: POST create estimates the default-checked rows', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    /** An upcoming tour on ANOTHER property: holds the tenant (D4). */
    function seedUpcomingTour(tourId: string, tenantId: string): TourItem {
      const createdAt = isoFromNow(-5 * DAY);
      const item: TourItem = {
        tourId,
        tenantId,
        unitId: 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: isoFromNow(3 * DAY),
        createdAt,
        updatedAt: createdAt,
      };
      world.toursMap.set(tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1. */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function postDraft(app: import('express').Express, body: Record<string, unknown>) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    const FILTER_BODY = { unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } };

    it('estimatedCount (stored as stats.audience) counts ONLY the rows that start checked: held, declined, already-sent and no-consent rows are left out; a held seed counts', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550305001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550305002' });
      seedTenant(world, { contactId: 'c-held-seed', phone: '+15550305003' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550305004' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550305005' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550305006', consent_method: undefined });
      seedUpcomingTour('t-held', 'c-held');
      seedUpcomingTour('t-held-seed', 'c-held-seed');
      world.listingSends.push(declinedRow('c-declined'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, { ...FILTER_BODY, seedContactIds: ['c-held-seed'] });
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(2); // c-plain + the hand-picked c-held-seed
      expect(res.body.truncated).toBe(false);
      expect(world.broadcasts.get(res.body.broadcastId)?.stats.audience).toBe(2);
      // The preview agrees: the same two rows start checked (one rule, D5).
      const preview = await request(app)
        .post(`/api/broadcasts/${res.body.broadcastId}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
      expect(preview.status).toBe(200);
      const checked = (preview.body.candidates as Array<{ contactId: string; checkedByDefault: boolean }>)
        .filter((c) => c.checkedByDefault)
        .map((c) => c.contactId)
        .sort();
      expect(checked).toEqual(['c-held-seed', 'c-plain']);
    });

    it('a seeds_only create makes NO rules or already-sent reads and counts the seeds WITH recorded consent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-seed-yes', phone: '+15550305101' });
      seedTenant(world, { contactId: 'c-seed-no', phone: '+15550305102', consent_method: undefined });
      seedUpcomingTour('t-yes', 'c-seed-yes'); // a hand pick is never held anyway
      const toursRead = vi.spyOn(world.toursRepo, 'listByStatus');
      const declinesRead = vi.spyOn(world.listingSendsRepo, 'listByUnit');
      const priorRead = vi.spyOn(world.broadcastsRepo, 'listByUnit');
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, { unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-seed-yes', 'c-seed-no'] });
      expect(res.status).toBe(201);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_mode).toBe('seeds_only');
      expect(res.body.estimatedCount).toBe(1);
      expect(toursRead).not.toHaveBeenCalled();
      expect(declinesRead).not.toHaveBeenCalled();
      expect(priorRead).not.toHaveBeenCalled();
    });

    it('a throwing tours read never blocks the draft: 201 WITHOUT estimatedCount, stats.audience 0, no estimate in the audit', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550305201' });
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(res.body.truncated).toBe(false);
      const stored = world.broadcasts.get(res.body.broadcastId);
      expect(stored?.status).toBe('draft');
      expect(stored?.stats.audience).toBe(0);
      const audit = world.auditEvents.find((e) => e.event_type === 'broadcast_created');
      expect(audit).toBeDefined();
      expect(audit?.payload).not.toHaveProperty('estimatedCount');
    });

    it('a throwing decline read omits the estimate the same way', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550305301' });
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(world.broadcasts.get(res.body.broadcastId)?.stats.audience).toBe(0);
    });

    it('an omitted estimate still reports a truncated resolution', async () => {
      seedUnit(world);
      const truncatedAudience = {
        contactIds: ['c-t1'],
        contacts: [{ contactId: 'c-t1', phone: '+15550305401', has_consent: true }],
        count: 1,
        truncated: true,
      };
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world, audienceResolutionService: async () => truncatedAudience });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(res.body.truncated).toBe(true);
    });

    it('create reads the send-attempt record (the already-sent input of the estimate): a queued slot of a failed share with a live record counts as already sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-live', phone: '+15550305501' });
      seedTenant(world, { contactId: 'c-other', phone: '+15550305502' });
      seedShare(world, 'bcast-failed', 'failed', { 'c-live': { status: 'queued' } }, { last_error: 'enqueue failed' });
      await world.sendAttemptsRepo.claim(
        { kind: 'broadcast', broadcastId: 'bcast-failed', contactKey: 'c-live' },
        SEED_ATTEMPT_FACTS,
        new Date().toISOString(),
      );
      const recordReads = vi.spyOn(world.sendAttemptsRepo, 'get');
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(recordReads).toHaveBeenCalled();
      expect(res.body.estimatedCount).toBe(1); // c-other only
    });

    it('(PIN) create counts every default-checked row, past the preview list bound of MAX_BROADCAST_RECIPIENTS', async () => {
      seedUnit(world);
      const contacts = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, i) => ({
        contactId: `c-big-${i}`,
        phone: `+1556${String(i).padStart(7, '0')}`,
        has_consent: true,
      }));
      const big = { contactIds: contacts.map((c) => c.contactId), contacts, count: contacts.length, truncated: false };
      const { app } = makeWebhookHarness({ world, audienceResolutionService: async () => big });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(MAX_BROADCAST_RECIPIENTS + 1);
    });
  });
});
```

### Step 2 - run RED

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected failures (all in `matching-blast-rules D8: ...`; every other test passes):
- `estimatedCount ... counts ONLY the rows that start checked` (`expected 6 to be 2`).
- `a seeds_only create makes NO rules ...` (`expected 2 to be 1`).
- `a throwing tours read never blocks the draft` and `a throwing decline read
  omits the estimate` (`expected { ... estimatedCount: 1 ... } to not have property 'estimatedCount'`).
- `an omitted estimate still reports a truncated resolution` (same).
- `create reads the send-attempt record ...` (`expected "spy" to be called at least once`).
The `(PIN)` case passes already.

### Step 3 - implementation (`app/src/routes/broadcasts.ts`)

I-Edit 1 (the ALONE doc on the dep). Replace

```ts
  /**
   * share-sent-outcome D1: the composer flag ALONE reads a queued slot's
   * send-attempt record (in flight vs stranded); no other route reads it.
   */
```

with:

```ts
  /**
   * share-sent-outcome D1: the composer flag ALONE reads a queued slot's
   * send-attempt record (in flight vs stranded) - through buildReviewRows,
   * which the preview and, since matching-blast-rules D8, draft create both
   * call; no other route reads it.
   */
```

I-Edit 2 (the estimate). Replace

```ts
    // Estimate the audience now (save-for-later shows the operator the reach).
    const seeds =
      seedContactIds !== undefined
        ? await resolveSeeds(seedContactIds)
        : { contacts: [], unresolved: [] };
    let estimatedAudience: number;
    let truncated = false;
    if (audienceMode === 'seeds_only') {
      estimatedAudience = seeds.contacts.length;
    } else {
      const audience = await resolveAudience(filter);
      const union = new Set(audience.contactIds);
      for (const s of seeds.contacts) union.add(s.contactId);
      estimatedAudience = union.size;
      truncated = audience.truncated;
    }
```

with:

```ts
    // matching-blast-rules D8: "Reaches N recipients" is the number of rows that
    // will START CHECKED on the review step - the SAME buildReviewRows the
    // preview serves, counted by checkedByDefault (held, declined, already-sent
    // and no-consent rows are left out; seeds with recorded consent count). A
    // seeds_only draft makes NO rules reads (every row is a seed). A filter
    // draft reads tours, declines and the already-sent set on every create -
    // the draft key includes the message body, so a pause in typing repeats
    // them (a few small Query pages, the same reads as one Preview click). A
    // thrown tours or decline read never blocks the draft: the estimate is
    // omitted (stats.audience stays 0) and the composer shows "Reach estimate
    // unavailable" until the draft is recreated. The preview lists at most
    // MAX_BROADCAST_RECIPIENTS rows; this counts them all.
    let estimatedAudience: number | undefined;
    let truncated = false;
    try {
      const review = await buildReviewRows(
        {
          audienceMode,
          filter,
          seedContactIds: seedContactIds ?? [],
          ...(unitId !== undefined && { unitId }),
        },
        'estimate',
      );
      estimatedAudience = review.rows.filter((r) => r.checkedByDefault).length;
      truncated = review.truncated;
    } catch (err) {
      if (!(err instanceof AudienceRulesUnavailableError)) throw err;
      truncated = err.truncated;
    }
```

(If S1 edited a line inside this block - it should not have - re-read it and
replace the whole block from the `// Estimate the audience now` comment to the
closing `}` of the `if/else`.)

I-Edit 3. Replace

```ts
      estimatedAudience,
      audienceMode,
```

with:

```ts
      ...(estimatedAudience !== undefined && { estimatedAudience }),
      audienceMode,
```

I-Edit 4. Replace

```ts
      estimatedCount: estimatedAudience,
    });
    log.info(
      { broadcastId: created.broadcastId, estimatedCount: estimatedAudience, actor },
```

with:

```ts
      ...(estimatedAudience !== undefined && { estimatedCount: estimatedAudience }),
    });
    log.info(
      { broadcastId: created.broadcastId, estimatedCount: estimatedAudience ?? null, actor },
```

I-Edit 5. Replace

```ts
      status: 'draft',
      estimatedCount: estimatedAudience,
```

with:

```ts
      status: 'draft',
      // matching-blast-rules D8: omitted when a rules read threw.
      ...(estimatedAudience !== undefined && { estimatedCount: estimatedAudience }),
```

I-Edit 6 (results route ALONE comment). Replace

```ts
    // share-sent-outcome D1/D3: each recipient's state, WITHOUT record reads
    // (deviation 12 - the record only tells in flight from stranded, which this
    // page does not show; the composer flag alone reads it). Only a young
    // failed-30003 slot reads its newest attempt's row, 8 at a time.
```

with:

```ts
    // share-sent-outcome D1/D3: each recipient's state, WITHOUT record reads
    // (deviation 12 - the record only tells in flight from stranded, which this
    // page does not show; the composer flag alone reads it, through
    // buildReviewRows at preview and draft create). Only a young failed-30003
    // slot reads its newest attempt's row, 8 at a time.
```

### Step 4 - run GREEN

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected: every test passes (including the unchanged estimate tests:
`creates a draft + estimates the audience` = 2, `estimates the union` = 2,
`drops unresolvable seeds` = 1, the partner seed = 1 - all their tenants carry
consent and no tours).

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/contactsBatchIncomplete.test.ts test/contactsBatchReads.test.ts
```

Expected: pass (their spies are set after the create).

```
cd W:\tmp\matching-blast-rules; npm run typecheck -w @housingchoice/app
```

Expected: exit 0.

### Step 5 - ASCII check (Bash)

```
cd /w/tmp/matching-blast-rules && git diff -U0 -- app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts | grep -n -P '^\+(?!\+\+).*[^\x00-\x7F]'
```

Expected: no output.

### Step 6 - commit

```
git -C W:\tmp\matching-blast-rules status
```

```
Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD"
```

Must print `False`.

```
git -C W:\tmp\matching-blast-rules add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(broadcasts): the draft reach estimate counts the rows that start checked (matching-blast-rules D8)

POST /api/broadcasts runs buildReviewRows and answers estimatedCount (stored
as stats.audience) = the checkedByDefault rows: held, declined, already-sent
and no-consent rows are left out. A seeds_only create makes no rules or
already-sent reads and counts seeds with recorded consent. A thrown tours or
decline read still creates the draft, omits estimatedCount (stats.audience
0) and keeps truncated. The send-attempt record read now also runs at
create; the ALONE comments say so.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

---

## Task 2.3 - Send path (c) leaves out held and declined tenants (D6, D7 server copy)

Files: `app/src/routes/broadcasts.ts`, `app/test/broadcastApi.test.ts`.

### Step 1 - tests (write first)

T-Edit 1. In `'/send refuses an over-cap audience (400 audience_too_large), stays draft (FIX 3+4)'`
(the injected resolver there reports `truncated: true`), replace

```ts
    expect(send.body.message).toMatch(/narrow/);
```

with:

```ts
    // matching-blast-rules D7: no filter narrows the read any more, so the
    // truncation message gives no narrowing advice.
    expect(send.body.message).toBe(
      `audience resolution was truncated (more than ${MAX_BROADCAST_RECIPIENTS} candidates) - the audience could not be read completely`,
    );
    expect(send.body.truncated).toBe(true);
```

T-Edit 2. Append a new describe: replace the file's last two lines

```ts
  });
});
```

with:

```ts
  });

  // --- matching-blast-rules D6: the no-body filter send (path c) -------------
  describe('matching-blast-rules D6: send path (c) leaves out held and declined tenants', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    /** An upcoming tour on ANOTHER property: holds the tenant (D4). */
    function seedUpcomingTour(tourId: string, tenantId: string): TourItem {
      const createdAt = isoFromNow(-5 * DAY);
      const item: TourItem = {
        tourId,
        tenantId,
        unitId: 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: isoFromNow(3 * DAY),
        createdAt,
        updatedAt: createdAt,
      };
      world.toursMap.set(tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1. */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function send(app: import('express').Express, id: string, body: Record<string, unknown> = {}) {
      return request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    /** A resolver result of `n` consented tenants c-cap-0 .. c-cap-(n-1). */
    function capAudience(n: number) {
      const contacts = Array.from({ length: n }, (_, i) => ({
        contactId: `c-cap-${i}`,
        phone: `+1556${String(i).padStart(7, '0')}`,
        has_consent: true,
      }));
      return { contactIds: contacts.map((c) => c.contactId), contacts, count: contacts.length, truncated: false };
    }

    it('the recipients are the resolved audience MINUS held MINUS declined; already-sent and no-consent tenants stay (the fan-out counts skipped_no_consent); seeds stay out', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550306001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550306002' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306003' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550306004' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550306005', consent_method: undefined });
      seedTenant(world, { contactId: 'c-seed-out', phone: '+15550306006', status: 'placing' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { seedContactIds: ['c-seed-out'] });
      const res = await send(app, id);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-nocons', 'c-plain', 'c-sent']);
      await queueAdapter.settle();
      expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550306001', '+15550306004']);
      const results = await authedGet(app, `/api/broadcasts/${id}/results`);
      expect(results.status).toBe(200);
      expect(results.body.stats.skipped_no_consent).toBe(1);
    });

    it('a throwing tours read is 503 audience_rules_unavailable: still a draft, nothing marked sending, nothing sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550306101' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(markSending).not.toHaveBeenCalled();
      await queueAdapter.settle();
      expect(world.broadcasts.get(id)?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('a throwing decline read is 503 audience_rules_unavailable too', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550306201' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('every resolved tenant excluded is 400 empty_audience, still a draft', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306301' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306302' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const res = await send(app, id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'empty_audience' });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('the recipient cap counts the FINAL set: 1002 resolved minus 2 held is 1000 and passes the cap', async () => {
      seedUnit(world);
      seedUpcomingTour('t-cap-0', 'c-cap-0');
      seedUpcomingTour('t-cap-1', 'c-cap-1');
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => capAudience(MAX_BROADCAST_RECIPIENTS + 2),
      });
      const id = await createDraft(app);
      // Stop at markSending (a lost conditional write answers 409) so no
      // 1000-recipient fan-out runs in a unit test.
      const markSending = vi
        .spyOn(world.broadcastsRepo, 'markSending')
        .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'stop before the fan-out', $metadata: {} }));
      const res = await send(app, id);
      expect(res.status).toBe(409);
      expect(markSending).toHaveBeenCalledTimes(1);
      const recipients = markSending.mock.calls[0]![1];
      expect(Object.keys(recipients)).toHaveLength(MAX_BROADCAST_RECIPIENTS);
      expect(recipients).not.toHaveProperty('c-cap-0');
      expect(recipients).not.toHaveProperty('c-cap-1');
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('one held of 1002 leaves 1001: 400 audience_too_large with the FINAL count', async () => {
      seedUnit(world);
      seedUpcomingTour('t-cap-0', 'c-cap-0');
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => capAudience(MAX_BROADCAST_RECIPIENTS + 2),
      });
      const id = await createDraft(app);
      const res = await send(app, id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'audience_too_large',
        message: `audience of ${MAX_BROADCAST_RECIPIENTS + 1} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`,
        count: MAX_BROADCAST_RECIPIENTS + 1,
        truncated: false,
      });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('(PIN) path (a), the explicit list the dashboard sends, is unchanged: a checked held or declined tenant is sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306601' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306602' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const res = await send(app, id, { recipientContactIds: ['c-held', 'c-declined'] });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-declined', 'c-held']);
    });

    it('(PIN) path (b), a seeds_only no-body send, is unchanged: a held seed is sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306701' });
      seedUpcomingTour('t-held', 'c-held');
      const { app } = makeWebhookHarness({ world });
      const created = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-held'] });
      expect(created.status).toBe(201);
      const res = await send(app, created.body.broadcastId as string);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });
  });
});
```

### Step 2 - run RED

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected failures:
- `/send refuses an over-cap audience ...` (message still holds the U+2014 narrowing advice).
- `the recipients are the resolved audience MINUS held MINUS declined ...` (`expected 5 to be 3`).
- both 503 cases (`expected 200 to be 503`).
- `every resolved tenant excluded is 400 empty_audience` (`expected 200 to be 400`).
- `the recipient cap counts the FINAL set ...` (`expected 400 to be 409`).
- `one held of 1002 leaves 1001 ...` (count 1002 and the U+2014 message).
The two `(PIN)` cases pass already.

### Step 3 - implementation (`app/src/routes/broadcasts.ts`)

I-Edit 1. Replace

```ts
    //  (c) filter-resolve (back-compat - no body): the existing snapshot path.
```

with:

```ts
    //  (c) filter-resolve (API only - no body): the resolved audience minus
    //      tour holds and #27 declines (matching-blast-rules D6).
```

I-Edit 2. Replace the whole path (c) branch: from the line `    } else {`
that is immediately followed by
`      // (c) Re-resolve the audience snapshot at send time (the source of truth -`
(pre-S1 line 975) through the lines `      count = audience.count;` and `    }`
(pre-S1 lines 1022-1023). It holds U+2192 (line 1000) and U+2014 (lines 1001,
1011, 1012): Read those lines to build `old_string`. New text:

```ts
    } else {
      // (c) Filter draft, no body (API only - the dashboard always posts an
      // explicit list, path (a)). Re-resolve the audience at send time (the
      // source of truth - the draft estimate may be stale), then apply
      // matching-blast-rules D6: the resolved audience (D1 status, D2 housing
      // authorities) MINUS tenants held by an unresolved tour (D4, evaluated
      // now) MINUS effective #27 declines of this property. Already-sent
      // tenants and tenants without recorded consent are NOT subtracted (the
      // fan-out skips a no-consent recipient and counts it skipped_no_consent),
      // and seeds stay out of this path, as before. The recipients map is keyed
      // by contactKey (contactId else phone#<E164>, the shared convention), all
      // 'queued'.
      // Spec 2026-10-06 D7: re-check the stored housing authority filter HERE,
      // inside the one branch that re-resolves it - an explicit selection (a)
      // and a seeds_only draft (b) never read the filter, so they are never
      // refused for it. Every refusal below leaves the draft a draft: nothing
      // is marked sending and nothing is enqueued.
      const refusal = await storedFilterRefusal(broadcast.audience_filter);
      if (refusal !== undefined) {
        log.info({ broadcastId }, 'broadcast send refused: stored housing authority filter not on the list');
        res.status(422).json(refusal);
        return;
      }
      const audience = await resolveAudience(broadcast.audience_filter);
      // D6: the tours and decline reads fail CLOSED - sending without them
      // would text tenants the rules leave out.
      let rules: { tourHolds: Map<string, TourHold>; declinedIds: Set<string> };
      try {
        rules = await readAudienceRules(broadcast.unitId, Date.now());
      } catch (err) {
        log.warn({ err, broadcastId }, 'broadcast send refused: audience rules unavailable - 503');
        res.status(503).json({ error: 'audience_rules_unavailable' });
        return;
      }
      const finalContacts = audience.contacts.filter(
        (c) => !rules.tourHolds.has(c.contactId) && !rules.declinedIds.has(c.contactId),
      );
      if (finalContacts.length === 0) {
        // Nobody left to send to: refuse clearly, leave it a draft.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      // Bound the audience (FIX 3+4): refuse when the FINAL set (after the D6
      // exclusions) exceeds the recipients-map item-size cap, OR when the
      // resolution was truncated (page cap hit - the set is INCOMPLETE and
      // sending would silently under-deliver). Either way leave the broadcast a
      // DRAFT and do NOT enqueue.
      if (finalContacts.length > MAX_BROADCAST_RECIPIENTS || audience.truncated) {
        log.warn(
          {
            broadcastId,
            count: finalContacts.length,
            resolved: audience.contacts.length,
            truncated: audience.truncated,
            cap: MAX_BROADCAST_RECIPIENTS,
          },
          'broadcast send refused: audience too large',
        );
        res.status(400).json({
          error: 'audience_too_large',
          message: audience.truncated
            ? `audience resolution was truncated (more than ${MAX_BROADCAST_RECIPIENTS} candidates) - the audience could not be read completely`
            : `audience of ${finalContacts.length} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`,
          count: finalContacts.length,
          truncated: audience.truncated,
        });
        return;
      }
      log.info(
        { broadcastId, resolved: audience.contacts.length, sending: finalContacts.length },
        'broadcast filter send: held and declined tenants left out',
      );
      recipients = buildRecipientsFrom(finalContacts);
      count = Object.keys(recipients).length;
    }
```

### Step 4 - run GREEN

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts
```

Expected: every test passes (including `draft -> send transitions` = 2,
`back-compat: an ABSENT body` = 2, `refuses a send with an empty audience`,
and `markSending stores { status: queued } per key (paths b and c)`).

```
cd W:\tmp\matching-blast-rules; npm run typecheck -w @housingchoice/app
```

Expected: exit 0.

### Step 5 - ASCII check (Bash)

```
cd /w/tmp/matching-blast-rules && git diff -U0 -- app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts | grep -n -P '^\+(?!\+\+).*[^\x00-\x7F]'
```

Expected: no output.

### Step 6 - commit

```
git -C W:\tmp\matching-blast-rules status
```

```
Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD"
```

Must print `False`.

```
git -C W:\tmp\matching-blast-rules add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(broadcasts): the no-body filter send (path c) leaves out held and declined tenants (matching-blast-rules D6, D7)

Path (c) sends the resolved audience minus tenants held by an unresolved
tour (evaluated at send time) minus effective #27 declines; already-sent and
no-consent tenants stay (the fan-out still counts skipped_no_consent), seeds
stay out. A thrown tours or decline read is 503 audience_rules_unavailable
and leaves the draft a draft. The recipient cap counts the final set; an
empty final set is 400 empty_audience; the truncation message drops its
narrowing advice. Paths (a) and (b) are unchanged (pinned).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

---

## Task 2.4 - Full-profile seed broadcasts: one legacy, one list (spec section 7)

Files: `app/src/lib/seed/matrix.ts`, `app/test/seedOrgNames.test.ts`.

### Step 1 - tests (write first)

T-Edit 1. In `app/test/seedOrgNames.test.ts`, after the line
`import { ORG_LIST_SETTING_ID } from '../src/repos/orgListRepo.js';` add:

```ts
import { authoritiesOfFilter } from '../src/lib/blastAudienceRules.js';
import type { AudienceFilter } from '../src/repos/broadcastsRepo.js';
```

T-Edit 2. In `orgValues`, replace

```ts
  for (const b of rowsOf(tables, 'broadcasts')) {
    const filter = b['audience_filter'] as { housing_authority?: unknown } | undefined;
    if (filter?.housing_authority !== undefined) {
      out.push({ field: 'audience_filter', value: filter.housing_authority });
    }
  }
```

with:

```ts
  for (const b of rowsOf(tables, 'broadcasts')) {
    // matching-blast-rules D2: the LEGACY one-string filter and the list
    // (housing_authorities) are both checked, member by member.
    const filter = b['audience_filter'] as
      | { housing_authority?: unknown; housing_authorities?: unknown }
      | undefined;
    if (filter?.housing_authority !== undefined) {
      out.push({ field: 'audience_filter', value: filter.housing_authority });
    }
    for (const v of listOf(filter?.housing_authorities)) out.push({ field: 'audience_filter', value: v });
  }
```

T-Edit 3. Replace

```ts
  it('the seeded broadcasts filter on list names (the draft is re-checked at preview - spec D7)', () => {
    const filters = rowsOf(items, 'broadcasts').map(
      (b) => (b['audience_filter'] as { housing_authority?: unknown } | undefined)?.housing_authority,
    );
    expect(filters).toEqual([SEED_AUTHORITY.atlanta, SEED_AUTHORITY.dca]);
  });
```

with:

```ts
  it('the seeded broadcasts filter on list names: the sent share keeps the LEGACY string, the draft holds a list (matching-blast-rules D2)', () => {
    const filters = rowsOf(items, 'broadcasts').map((b) => b['audience_filter'] as AudienceFilter);
    expect(filters.map((f) => f.housing_authority)).toEqual([SEED_AUTHORITY.atlanta, undefined]);
    expect(filters.map((f) => f.housing_authorities)).toEqual([
      undefined,
      [SEED_AUTHORITY.dca, SEED_AUTHORITY.dekalb],
    ]);
    // ONE server normalizer reads both shapes (spec D2).
    expect(filters.map((f) => authoritiesOfFilter(f))).toEqual([
      [SEED_AUTHORITY.atlanta],
      [SEED_AUTHORITY.dca, SEED_AUTHORITY.dekalb],
    ]);
  });
```

### Step 2 - run RED

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/seedOrgNames.test.ts
```

Expected: `the seeded broadcasts filter on list names: ...` fails
(`expected [ 'Atlanta Housing Authority', 'Georgia Department of Community Affairs' ] to deeply equal [ 'Atlanta Housing Authority', undefined ]`);
every other test passes.

### Step 3 - implementation (`app/src/lib/seed/matrix.ts`)

I-Edit 1 (the sent share keeps the legacy shape, now on purpose). Replace

```ts
      audience_filter: {
        contact_type: 'tenant',
        housing_authority: SEED_AUTHORITY.atlanta,
```

with:

```ts
      // LEGACY shape on purpose (matching-blast-rules D2): a share sent before
      // 2026-10-14 stored ONE housing_authority string, and every server reader
      // goes through authoritiesOfFilter. Kept so the full world exercises it.
      audience_filter: {
        contact_type: 'tenant',
        housing_authority: SEED_AUTHORITY.atlanta,
```

I-Edit 2 (the draft moves to the list). Replace

```ts
      audience_filter: {
        contact_type: 'tenant',
        housing_authority: SEED_AUTHORITY.dca,
```

with:

```ts
      // matching-blast-rules D2: a draft saved since 2026-10-14 carries the
      // housing authority LIST (any-of) - here the 2BR in DeKalb.
      audience_filter: {
        contact_type: 'tenant',
        housing_authorities: [SEED_AUTHORITY.dca, SEED_AUTHORITY.dekalb],
```

### Step 4 - run GREEN

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/seedOrgNames.test.ts
```

Expected: every test passes (the "every value is an exact list name" case now
also checks both list members).

```
cd W:\tmp\matching-blast-rules; npm run typecheck -w @housingchoice/app
```

Expected: exit 0.

### Step 5 - ASCII check (Bash)

```
cd /w/tmp/matching-blast-rules && git diff -U0 -- app/src/lib/seed/matrix.ts app/test/seedOrgNames.test.ts | grep -n -P '^\+(?!\+\+).*[^\x00-\x7F]'
```

Expected: no output.

### Step 6 - commit

```
git -C W:\tmp\matching-blast-rules status
```

```
Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD"
```

Must print `False`.

```
git -C W:\tmp\matching-blast-rules add app/src/lib/seed/matrix.ts app/test/seedOrgNames.test.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
chore(seed): the full-profile draft broadcast filters on a housing authority list; the sent share keeps the legacy string (matching-blast-rules D2)

broadcast-mx-draft-01 now stores housing_authorities [DCA, DeKalb];
broadcast-mx-sent-01 keeps the one-string housing_authority on purpose so
the full world exercises authoritiesOfFilter. seedOrgNames checks list
members against the org list and pins both shapes through the normalizer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

---

## Task 2.5 - Server comments: the GSI is kept but not read by blasts; the router header

Files: `app/src/routes/broadcasts.ts`, `app/src/routes/contacts.ts`,
`app/src/routes/dev.ts`, `app/src/lib/import/apply.ts`,
`app/src/lib/seed/lean.ts`, `app/src/repos/contactsRepo.ts`.
Comment-only: the RED/GREEN is a `git grep` gate (CONTRACT ISSUE 6). Never
delete or change the `byHousingAuthority` GSI (`app/src/lib/tables.ts:97-100`)
or `contactsRepo.listByHousingAuthority` code, its tests or its fakes.

### Step 1 - run RED (the gate)

```
git -C W:\tmp\matching-blast-rules grep -n -E "for broadcast targeting|GSI that broadcast|GSI \(M1\.8a share-broadcast audience resolution\)|Broadcast targeting must never reach|GSI key and can never hold|byHousingAuthority \(any contact type\)|sample:\[\{contactId" -- app/src
```

Expected: exactly 7 lines, in `app/src/lib/import/apply.ts`,
`app/src/lib/seed/lean.ts`, `app/src/repos/contactsRepo.ts` (2),
`app/src/routes/broadcasts.ts`, `app/src/routes/contacts.ts`,
`app/src/routes/dev.ts`.

### Step 2 - edits

C-Edit 1 (`app/src/routes/contacts.ts`; line 650 keeps its U+2014 and is NOT
touched). Replace

```ts
  // GSI hash key, so writing it re-indexes the contact for broadcast targeting.
```

with:

```ts
  // GSI hash key, so writing it re-indexes the contact (the GSI is kept, but
  // blast audiences no longer read it - matching-blast-rules D2 matches the
  // housing authority in memory).
```

C-Edit 2 (`app/src/routes/dev.ts`). Replace

```ts
  // The value must be non-empty: `housingAuthority` is the byHousingAuthority
  // GSI key and can never hold ''. Same triple-gate/hermetic-LOCAL-only
```

with:

```ts
  // The value must be non-empty: `housingAuthority` is the byHousingAuthority
  // GSI key (the GSI is kept; blast audiences no longer read it) and can never
  // hold ''. Same triple-gate/hermetic-LOCAL-only
```

C-Edit 3 (`app/src/lib/import/apply.ts`). Replace

```ts
  // Contact-side housing authority (the byHousingAuthority GSI that broadcast
  // audience resolution queries). FILL-ONLY since the org lists (spec D9): a
```

with:

```ts
  // Contact-side housing authority (the byHousingAuthority GSI hash key; the GSI
  // is kept, but blast audiences match the housing authority in memory since
  // matching-blast-rules D2 and no longer query it). FILL-ONLY since the org
  // lists (spec D9): a
```

C-Edit 4 (`app/src/lib/seed/lean.ts`). Replace

```ts
      housingAuthority: SEED_AUTHORITY.atlanta, // byHousingAuthority (any contact type)
```

with:

```ts
      housingAuthority: SEED_AUTHORITY.atlanta, // byHousingAuthority GSI key, any contact type (kept; blasts no longer read it)
```

C-Edit 5 (`app/src/repos/contactsRepo.ts`, the `listByHousingAuthority` doc;
lines 772-773 keep their U+00A7 / U+2014 and are NOT touched). Replace

```ts
   * GSI (M1.8a share-broadcast audience resolution). A voucher is administered
```

with:

```ts
   * GSI. Built for M1.8a share-broadcast audience resolution; since
   * matching-blast-rules (2026-10-14) a blast audience reads byTypeStatus and
   * matches the housing authority in memory, so this has no runtime caller -
   * it and the GSI are KEPT on purpose (Cameron 2026-10-14), not dead code to
   * remove. A voucher is administered
```

C-Edit 6 (`app/src/repos/contactsRepo.ts`, inside `listByHousingAuthority`).
Replace the two lines (pre-S1 1396-1397; line 1396 holds one U+2014 between
"contact" and "always" - Read it to build `old_string`):

```
        // Broadcast targeting must never reach a soft-deleted contact <U+2014> always
        // exclude them here (no "deleted" view on this index).
```

with:

```ts
        // A soft-deleted contact is never listed - always exclude them here
        // (no "deleted" view on this index).
```

C-Edit 7 (`app/src/routes/broadcasts.ts`, header route lines 6-8; each holds a
U+2192 - Read lines 6-8 to build `old_string`; lines 9-12 stay). Replace the
three lines that start `//   POST /api/broadcasts  `,
`//   POST /api/broadcasts/:id/preview` and `//   POST /api/broadcasts/:id/send`
with:

```ts
//   POST /api/broadcasts                 { unitId?, body_template, audience_filter?, seedContactIds? } -> 201 { broadcastId, status:'draft', estimatedCount?, audience_filter, truncated, flyerUrl? }
//   POST /api/broadcasts/:id/preview                                                 -> { count, truncated, candidates, priorRecipientContactIds, seedContactIds, unresolvedSeedIds, declinedContactIds, tourHolds, audienceRulesUnavailable? } | 503 audience_rules_unavailable
//   POST /api/broadcasts/:id/send        { recipientContactIds? }                    -> { broadcastId, status:'sending', count } | 400 empty_audience | 503 audience_rules_unavailable
```

C-Edit 8 (`app/src/routes/broadcasts.ts`, the "Audience:" paragraph). Replace

```ts
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters), by housing authority and/or exact bedroom size; hand-picked seeds
// and an explicit recipient list may also name PARTNERS (spec 2026-10-06 D20).
// Opted-out + unreachable are ALWAYS excluded. The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
```

with:

```ts
// Audience: a FILTER resolves TENANT 1:1 contacts ONLY (never relay-group
// rosters) in Searching or Onboarding (matching-blast-rules D1), by any of a
// list of housing authorities and/or exact bedroom size (D2); hand-picked
// seeds and an explicit recipient list may also name PARTNERS (spec
// 2026-10-06 D20) and keep any status. Opted-out + unreachable are ALWAYS
// excluded. A tenant with an unresolved tour (D4) or a #27 decline is listed
// for review but not checked by default (checkedByDefault, D5), and the
// no-body filter send (c) leaves them out (D6). The send fans out through the
// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).
```

If S1 already rewrote this paragraph, keep S1's D1/D2 wording and add only
the sentence starting "A tenant with an unresolved tour".

### Step 3 - run GREEN (the gate)

```
git -C W:\tmp\matching-blast-rules grep -n -E "for broadcast targeting|GSI that broadcast|GSI \(M1\.8a share-broadcast audience resolution\)|Broadcast targeting must never reach|GSI key and can never hold|byHousingAuthority \(any contact type\)|sample:\[\{contactId" -- app/src
```

Expected: no output (exit 1).

```
git -C W:\tmp\matching-blast-rules grep -n "listByHousingAuthority" -- app/src
```

Expected: the interface method and its implementation in
`app/src/repos/contactsRepo.ts` are still there (comments only changed).

### Step 4 - slice-end checks

```
cd W:\tmp\matching-blast-rules; npm run typecheck -w @housingchoice/app
```

```
cd W:\tmp\matching-blast-rules\app; npx vitest run test/broadcastApi.test.ts test/seedOrgNames.test.ts test/contactsBatchIncomplete.test.ts test/contactsBatchReads.test.ts test/followUpsApi.test.ts
```

```
cd W:\tmp\matching-blast-rules; npx eslint app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts app/src/lib/seed/matrix.ts app/test/seedOrgNames.test.ts app/src/routes/contacts.ts app/src/routes/dev.ts app/src/lib/import/apply.ts app/src/lib/seed/lean.ts app/src/repos/contactsRepo.ts
```

Expected: all exit 0 (the repo's 23 known lint errors are all dashboard
`react-hooks/*`; none of these files carries one - if one appears, compare
with the same command at the merge base before calling it yours).

### Step 5 - ASCII check (Bash)

```
cd /w/tmp/matching-blast-rules && git diff -U0 -- app/src/routes/broadcasts.ts app/src/routes/contacts.ts app/src/routes/dev.ts app/src/lib/import/apply.ts app/src/lib/seed/lean.ts app/src/repos/contactsRepo.ts | grep -n -P '^\+(?!\+\+).*[^\x00-\x7F]'
```

Expected: no output.

### Step 6 - commit

```
git -C W:\tmp\matching-blast-rules status
```

```
Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD"
```

Must print `False`.

```
git -C W:\tmp\matching-blast-rules add app/src/routes/broadcasts.ts app/src/routes/contacts.ts app/src/routes/dev.ts app/src/lib/import/apply.ts app/src/lib/seed/lean.ts app/src/repos/contactsRepo.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
docs(comments): the byHousingAuthority GSI is kept but no longer read by blast audiences; the broadcasts router header describes the new preview and send shapes (matching-blast-rules)

Comments that called byHousingAuthority the broadcast audience key now say
the GSI and listByHousingAuthority are kept on purpose with no runtime
caller (contacts.ts, dev.ts, import/apply.ts, seed/lean.ts, contactsRepo.ts
doc and its soft-delete note). No code, GSI, test or fake changed. The
router header lists estimatedCount?, tourHolds, audienceRulesUnavailable?
and the 503, and the Audience paragraph states D1, D2, D4-D6.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

---

### Spec coverage map

- D4 hold kinds (every table row; 14-day request bound; resolved tours hold
  nothing) through the route -> 2.1 "every D4 hold kind". Pure-rule boundaries
  (exactly now, exactly 336 h, pending claim, tie-breaks) are S1's unit tests.
- D4 one hold per tenant by kind order / earliest upcoming -> 2.1 "several
  unresolved tours".
- D4 keyed on tenantId, any contact type -> 2.1 flags test (`c-ll-tour`,
  `c-cw-seed`).
- D4 listed unchecked; hand pick never held, keeps the label -> 2.1 flags test;
  seeds_only test.
- D5 ONE function, `checkedByDefault` formula, seeds checked whatever their
  flags, no-consent never -> 2.1 (buildReviewRows + flags test); create uses
  the same function -> 2.2 (estimate == preview's checked rows).
- D5 already-sent stays a soft never-throwing hint -> 2.1 (priorRecipientKeys
  unchanged; existing "a failed row read never empties the set" stays green).
- D5 open-tours read shape (three partitions to the end, `requested` from now
  minus 14 days, one read per call) -> 2.1 "the open-tours read is ONE read".
- D5 filter draft fail closed 503 (tours, listing sends, decline tours,
  contacts batch; with and without a property) -> 2.1.
- D5 seeds_only degrade + `audienceRulesUnavailable` -> 2.1 (tours and decline
  failures).
- D5 `declineLabelsUnavailable` removed -> 2.1 (code + four test edits).
- D6 (a) unchanged -> 2.3 (PIN); (b) unchanged -> 2.3 (PIN).
- D6 (c) minus held minus declined; already-sent and no-consent kept; seeds
  out; 503; truncation refused; cap after exclusions; empty 400 -> 2.3.
- D7 wire: per-candidate `tourHold?`, `checkedByDefault`; top-level
  `tourHolds` (every held contact), `audienceRulesUnavailable?` -> 2.1.
- D7 server truncation message without advice -> 2.3 (existing test edited);
  over-cap message -> 2.3 (CONTRACT ISSUE 3).
- D8 `estimatedCount` = default-checked count, stored as `stats.audience` -> 2.2.
- D8 seeds_only create makes no rules reads, counts seeds with consent -> 2.2.
- D8 filter create reads tours, declines, already-sent; send-attempt record
  read moves to create; ALONE comments updated -> 2.2 (record-read test,
  I-Edits 1 and 6) and 2.1 (buildReviewRows doc replaces the preview's
  ":757-760" text).
- D8 omit on throw, `stats.audience` 0, truncated still reported -> 2.2.
- D8 create counts past the preview's 1000 -> 2.2 (PIN).
- D10 caseworker seed with a tour stays checked and labeled; never a filter
  row -> 2.1 flags test (resolver fence itself is S1).
- Spec 7 server: review-rows function, preview, send path (c), the
  `audience_too_large` messages -> 2.1-2.3; the ALONE comments (`:111-114`,
  `:757-760`, `:1108-1111`) -> 2.2 / 2.1; full-profile seeds (one legacy, one
  list) + `seedOrgNames.test.ts:86-87`, `:143-145` -> 2.4; the
  `byHousingAuthority` comments (contacts, dev, apply, lean, contactsRepo
  770-775 + 1396-1397) -> 2.5; router header `:6-8`, `:14-18` -> 2.5.
- Spec 7 tests: `broadcastApi.test.ts` estimate/decline-flag pins -> 2.1-2.3
  (the `:62-64` status comment is S1's).
- Spec 6 "Preview ... legacy stored filter previews" -> 2.1 legacy test;
  "storedFilterRefusal over a list" and the projections -> S1.
- a2p e2e path (c) `skipped_no_consent === 1`: stays true BY CONSTRUCTION -
  the draft has no `unitId` (no decline read), its tenants come from POST
  `/api/contacts` and start `onboarding` (resolved under D1), have no tours
  (no hold), and path (c) never subtracts a no-consent tenant, so the fan-out
  still skips and counts exactly one. 2.3's first test pins the same
  mechanism (`results.stats.skipped_no_consent === 1`).
- NOT S2: D1/D2 resolver, parse, create list check, storedFilterRefusal,
  projections (S1); D3, D3a, D3b, D9, D7 dashboard copy (S3); e2e, docs,
  GLOSSARY/RUNBOOK, issue registry (S4).

### Notes for other slices

- S1: S2 imports from `app/src/lib/blastAudienceRules.ts` exactly
  `checkedByDefault`, `TOUR_REQUEST_HOLD_MS`, `tourHoldsByTenant`, `TourHold`
  (router) and `TOUR_REQUEST_HOLD_MS`, `authoritiesOfFilter` (tests). S2's
  tests compare `tourHold.at` with `Date.prototype.toISOString()` output, so
  `tourHoldOf` may return the stored string or a re-serialized ISO string.
  S2's tests still construct `AudienceFilter` with the deprecated
  `housing_authority` (legacy preview test, matrix seed) - keep that field on
  the type. Test 2.1 "ONE read" asserts `listByStatus` is called with exactly
  one argument for `scheduled` / `toured` / `no_show` and with
  `{ createdAtFrom }` for `requested`. S1 should not touch broadcasts.ts lines
  652-705 (estimate, create, 201) or the preview body / path (c) beyond the
  `storedFilterRefusal` function itself; if it must, S2's anchors say how to
  re-apply.
- S1/S2 header split: S1 owns the "Organization names" paragraph
  (broadcasts.ts:20-28); S2 owns lines 6-8 and the "Audience:" paragraph.
- S3: preview 200 now has per-candidate `checkedByDefault` (always) and
  `tourHold?`, top-level `tourHolds` (always, possibly empty, every held
  contact org-wide - not just the candidates) and `audienceRulesUnavailable`
  only when true; `declineLabelsUnavailable` is gone. A filter draft's preview
  can answer 503 `{ error: 'audience_rules_unavailable' }`. POST create may
  omit `estimatedCount` while still sending `truncated` (true or false). The
  API never puts an `audience_rules_unavailable` body on create.
- S3/S4: the full-profile demo world's `broadcast-mx-draft-01` now carries
  `housing_authorities: ['Georgia Department of Community Affairs', 'DeKalb County Housing Authority']`;
  `broadcast-mx-sent-01` keeps the legacy string (the wire shows both as
  `housing_authorities` through S1's `wireAudienceFilter`).
- S4: path (c) (API-only) can now return 503 `audience_rules_unavailable`;
  RUNBOOK / GLOSSARY wording should say a filter blast's preview and its
  no-body send both fail closed on a failed tours or decline read. Any e2e that
  gives a tenant a tour and then blasts will see that tenant listed unchecked
  (and left out of a path (c) send).
- Review note: path (c) reads the rules even for an empty or truncated
  resolution (order: 422 re-check, resolve, rules read -> 503, empty -> 400,
  too large / truncated -> 400). A failed rules read therefore outranks the
  empty and truncation refusals; both leave the draft a draft.

## 7. S3 - Dashboard (Tasks 3.1-3.6)

## S3 - Dashboard (Tasks 3.1-3.6)

Section draft by the S3 plan writer (2026-10-14). Every step below was EXECUTED, in order, against
a scratch copy of this worktree's `dashboard/` (main @a2b3d80d plus the plan commits - the same
files): each RED run failed exactly as stated, each GREEN run passed with the counts stated, the
dashboard typecheck was clean after every task, and the lint results are the ones stated. Line
numbers in a step are where its old_string sits AT THAT STEP (earlier steps already applied); the
old_string TEXT is the authority - each one is unique in its file unless the step says
`replace_all`. Copy every block verbatim (they are ASCII; five old_strings mark an existing em dash
as `{{U+2014}}`, explained where they appear - every new or touched line is ASCII).

Commands are PowerShell, one per line, never piped. `npx vitest` and `npm run typecheck` run from
`W:\tmp\matching-blast-rules\dashboard`; `npx eslint` and `git` from the worktree root
(`git -C` is used so the shell's working directory does not matter).

### CONTRACT ISSUES

1. **Binding 2.8 `prefillAuthorities` while the org list is unknown.** `settleTypedOrgText`
   (dashboard/src/routes/orgs/orgCopy.ts:248-251) answers `loading` / `unavailable` - never
   `resolved` - for EVERY text while the list is still loading or failed with nothing in hand. Read
   literally ("`unused` = the ones that do not resolve"), every property authority would land in
   `unused` and the filters would say "Not used (not on the organization list): <every name>" right
   beside the list-failed notice - false. Proposed fix (applied in Task 3.4, signature unchanged):
   while `orgListUnknown(list)` the function returns `{ names: [], unused: [] }`.
2. **Copy 1.1, the not-limited sentence.** "when none mapped, followed by ` This blast is not
   limited by housing authority.`" turns false as soon as staff pick an authority by hand (the
   blast IS then limited). Proposed fix (applied in Task 3.3, strings unchanged): append it only
   while none mapped AND the housing authority list is empty; the "Not used (not on the
   organization list): ..." part stays while the property stays.
3. **Binding 2.7 vs a green typecheck at every commit.** Removing `AudienceFilter.housing_authority`
   and `PreviewResponse.declineLabelsUnavailable` in the types task breaks `tsc` in
   AudienceFilters.tsx and useComposerDraft.ts (until the multi-picker lands) and in
   RecipientPreview.tsx (until its notice goes). Proposed fix (applied): Task 3.1 keeps both as
   TRANSITIONAL optional fields; Task 3.2 deletes `declineLabelsUnavailable` with its last reader,
   Task 3.3 deletes `housing_authority` with its last readers. The final types are exactly 2.7 and
   nothing transitional ever reaches the wire.

### Facts the tasks rely on (verified)

Citations are to the worktree as cut (main @a2b3d80d) unless a task says otherwise.

- **Types.** `dashboard/src/api/types.ts:3269-3275` `AudienceFilter` holds ONE `housing_authority?:
  string` (doc :3265-3268, field comment :3271); `Contact.housingAuthority` comment :2273 (an em dash
  precedes "the byHousingAuthority GSI key"); `PreviewCandidate` :3461-3485 has no `tourHold` /
  `checkedByDefault`; `PreviewResponse` :3498-3512 ends with `declineLabelsUnavailable: boolean`
  (:3511); `UnitItem.accepted_authorities?: string[]` :2503; `OrgEntry` :3649-3660; `OrgKind`
  :3646. The dashboard tsconfig is `strict` + `noUncheckedIndexedAccess`, no
  `exactOptionalPropertyTypes` (tsconfig.base.json).
- **Endpoints/client.** `createBroadcast` (`dashboard/src/api/endpoints.ts:1989-2009`) types
  `estimatedCount: number` (required) and sends `audience_filter` as given; `previewBroadcast`
  :2013. `ApiError.code` is the body's `error` (`dashboard/src/api/client.ts:74-82`); an
  `AbortError` is rethrown as-is (:125). The app renders under `<StrictMode>`
  (`dashboard/src/main.tsx:15`), so every mount-effect fetch is started, aborted and started again
  in dev.
- **Org list.** `useOrgList` (`dashboard/src/routes/orgs/useOrgList.ts`) reads GET
  /api/organizations once per mount; `loading` stays true until a read SETTLES - an aborted read
  returns without settling (:84, :92) - and `error` is true after a failed read; `entries` is
  memoized (:136-145). `OrgListView` (`orgCopy.ts:194-202`), `orgListUnknown` (:212-214),
  `settleTypedOrgText` (:248-259: the normalized NAME of an entry of the kinds, else a spelling
  exactly ONE such entry carries; anything else `blocked`), `orgNotOnListBody` (:367-382: narrows a
  422 and returns its `text`). The server's rule is the same: an exact name, the name in another
  case, or a unique spelling (`app/src/lib/orgNames.ts:275-290` `checkScalarWrite`).
- **OrgPicker multi mode** (`dashboard/src/routes/orgs/OrgPicker.tsx`): `multiple: true` takes
  `value: readonly string[]` / `onChange(next: string[])` (:108-112); a pick APPENDS (:319-320);
  a chip's remove button is named `Remove <value>` (:373); chosen names are hidden from the options
  (:239); the label is the combobox's accessible name (:359-361).
- **Property helpers.** `authoritiesOf` (`dashboard/src/routes/listing/listingFormat.ts:63-71`),
  `acceptedVoucherSizes` (:103-109); `shortDate` (`dashboard/src/routes/placements/placementsFormat.ts:114-119`,
  browser-local `en-US` `{ month: 'short', day: 'numeric' }`, e.g. "Oct 20").
- **Composer today** (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx`): `unit` and `filter`
  are state (:77-78); the 422 copy constant (:60-61); `rejectAuthorityPick` clears the whole
  authority (:130-137); the draft hook call (:154-164); picker candidates are every unit (:190-199);
  the property load swallows a failure and resets on a cleared picker with `setUnit(null)`
  (:203-215); the voucher prefill is an EFFECT writing state (:261-272); Preview's 422 branch
  (:368-371); `canPreview` (:388-394); the browse rows and search field call `setUnitPick`
  (:442-467); the zero-candidate copy (:482-484); the disabled-Preview hint chain (:606-614).
- **Draft hook** (`dashboard/src/routes/broadcasts/useComposerDraft.ts`): `onOrgNotOnList?: () =>
  void` (:45-49); `materialKey` reads `filter.housing_authority` (:95); the create effect's deps
  include `input.filter` (:258) - a NEW filter object re-runs it, which clears a pending debounce
  and bumps `genRef` (discarding a create in flight), so the composer must keep the filter's
  identity while its content stays; the 422 branch (:226-237); `setReachCount(created.estimatedCount)`
  (:213) already renders an undefined count as "Reach estimate unavailable" (AudienceFilters.tsx:180-188).
- **AudienceFilters** (`dashboard/src/routes/broadcasts/AudienceFilters.tsx`): reads the list itself
  (`useOrgList`, :66); single `OrgPicker` labeled "Housing authority" (:144-162); the truncation
  suffix (:189-194, em dash). **RecipientPreview** (`.../RecipientPreview.tsx`): client rule
  `defaultChecked` (:99-101) used by `initialRows` (:115-134) and Select all (:243-245);
  `checkboxName` (:105-111); promotion (:294-301); the added row (:304-328); one-suffix annotate
  (:437-438); the decline-unavailable notice (:489-495); row class (:528); tags (:577-586); the
  truncation alert (:650-657, em dash). `ContactSearchField` renders the annotate note as a span in
  the option (`dashboard/src/routes/contact/ContactSearchField.tsx:292`, :319), so the option's
  name/text carries it.
- **Tests at main.** The five spec-7 files (AudienceFilters.test.tsx, BroadcastComposer.test.tsx,
  BroadcastComposer.prefill.test.tsx, RecipientPreview.test.tsx, broadcastFormat.test.ts): 5 files,
  144 tests, all pass. vitest runs jsdom with `css: false` (CSS-module class names are not
  asserted) and no TZ pin, so tour instants in tests are noon UTC (the same calendar day in every
  US zone). BroadcastComposer.prefill.test.tsx already mocks `getOrgList` (:13, :59) and passes
  unchanged after S3 - spec section 7 lists it, but it needs NO edit (proved in Task 3.3 and 3.5).
- **Lint at main** (`npx eslint` on the S3 source files): BroadcastComposer.tsx has 4 errors, all
  `react-hooks/set-state-in-effect` (:205 `setUnit(null)`, :230 and :249 `setMessage`, :271
  `setFilter`); useComposerDraft.ts has 1 `react-hooks/refs` (:140); AudienceFilters.tsx,
  RecipientPreview.tsx, broadcastFormat.ts, api/types.ts and api/endpoints.ts are clean. After S3:
  BroadcastComposer.tsx 2 (the two `setMessage` effects), useComposerDraft.ts 1, every other S3
  file clean - S3 removes two baseline errors and adds none.
- **ASCII.** BroadcastComposer.tsx, AudienceFilters.tsx, RecipientPreview.tsx, useComposerDraft.ts,
  api/types.ts and every test file touched hold em dashes / ellipses on EXISTING lines; no step adds
  one. AudienceFilters.test.tsx is rewritten whole in ASCII (its five em-dash/ellipsis lines were
  titles and comments).
- **Readers of a draft's `stats.audience`** (`BroadcastsList.tsx:47`, :221, `BroadcastResults.tsx:208`,
  `StatChips.tsx:40`) print the number as given; `rowAudienceLabel` / the results header call
  `audienceSummary` (fixed in 3.1). No code or test change there.

### S3 design decisions (local to this slice)

- **The org list moves up as a prop** (the brief's open choice): the composer calls `useOrgList()`
  ONCE and passes `orgList: OrgListView` to AudienceFilters. The prefill and the gate must read the
  same answer the picker shows; a second hook would issue a second read that could disagree.
- **The prefill is derived, not written.** Composer state holds only staff EDITS, owned by one
  property (`FilterEdits { unitId, authorities?, size? }`, absent = not edited). The filter on
  screen = edits, else the property's prefill, recomputed in render and memoized by CONTENT. Value
  and ownership live in one state and every write is a functional update (the
  broadcast-composer-prefill-overwrites-edit lesson); there is no effect, so no pending-effect race
  and no new lint error.
- **The property load is keyed by its id** (`UnitLoad`), so a stale load never shows for a new pick
  and "a failed state belongs to the property it was for" is structural. An AbortError (or an
  aborted signal) records nothing.
- **A different property resets the edits in the pick handler** (`pickProperty`), in the same event
  as the pick - "at once"; the same id again keeps them.
- **The settle gate reuses the existing "Sizing the audience" hint** (no new copy). Prefill notices
  are plain paragraphs (no `role`), so the reach line stays the panel's only `role="status"` (unit
  tests and e2e read it that way).
- **A 422 whose text matches no member** (never expected: the dashboard sends exact list names)
  empties the list instead of leaving the composer stuck on a filter the server refuses; a body with
  no `text` reads "That housing authority is no longer on the organization list, so it was removed
  from the filter."
- **RecipientPreview trusts the server's `checkedByDefault` as is** (no client re-check); the test
  fixture `candidate()` computes the server rule as data, so existing tests keep their meaning, and
  new tests give it values the flags would contradict.

### Task 3.1 - Wire types, createBroadcast and audienceSummary for a list

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/broadcastFormat.test.ts`
- `dashboard/src/api/types.ts`
- `dashboard/src/api/endpoints.ts`
- `dashboard/src/routes/broadcasts/broadcastFormat.ts`
- `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`

Binding 2.7 lands here: `AudienceFilter.housing_authorities`, `TourHoldKind`, `TourHold`,
`PreviewCandidate.tourHold?` + `checkedByDefault`, `PreviewResponse.tourHolds` +
`audienceRulesUnavailable?`, and `createBroadcast`'s `estimatedCount?` (D8: omitted when a rules read
threw). `audienceSummary` (the Matching list row and the results header) joins a list with ", ".

SEQUENCING (CONTRACT ISSUE 3): so that EVERY commit of this slice typechecks, this task keeps
`AudienceFilter.housing_authority?` and `PreviewResponse.declineLabelsUnavailable?` as TRANSITIONAL
optional fields. Task 3.2 deletes `declineLabelsUnavailable` (with its RecipientPreview notice),
Task 3.3 deletes `housing_authority` (with the single picker). After Task 3.3 the types are exactly
binding 2.7. The RecipientPreview.test.tsx fixture edits below are typecheck fallout of the two new
REQUIRED fields (`checkedByDefault`, `tourHolds`); `candidate()` computes the server rule as fixture
data so every existing test keeps its meaning.

#### Step 1 - Write the failing tests

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\broadcastFormat.test.ts` - the audienceSummary describe block (old_string is at lines 27-34 when this step runs).

   old_string:

```ts
describe('audienceSummary', () => {
  it('leads with Tenants and appends size + authority when set', () => {
    expect(audienceSummary({ contact_type: 'tenant' })).toBe('Tenants');
    expect(
      audienceSummary({ contact_type: 'tenant', bedroomSize: 2, housing_authority: 'Atlanta' }),
    ).toBe('Tenants - 2-BR - Atlanta');
  });
});
```

   new_string:

```ts
describe('audienceSummary', () => {
  it('leads with Tenants and appends size + authority when set', () => {
    expect(audienceSummary({ contact_type: 'tenant' })).toBe('Tenants');
    expect(
      audienceSummary({ contact_type: 'tenant', bedroomSize: 2, housing_authorities: ['Atlanta'] }),
    ).toBe('Tenants - 2-BR - Atlanta');
  });

  it('matching-blast-rules D2: joins a housing authority LIST with ", "', () => {
    expect(
      audienceSummary({
        contact_type: 'tenant',
        bedroomSize: 2,
        housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
      }),
    ).toBe('Tenants - 2-BR - Atlanta Housing Authority, DeKalb County Housing Authority');
    expect(audienceSummary({ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] })).toBe(
      'Tenants - Atlanta Housing Authority',
    );
    // An empty list is no housing authority filter.
    expect(audienceSummary({ contact_type: 'tenant', housing_authorities: [] })).toBe('Tenants');
  });
});
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/RecipientPreview.test.tsx
```

Expected: the run FAILS (`Test Files  1 failed | 1 passed (2); Tests  2 failed | 73 passed (75)`). Both audienceSummary cases fail because the function still reads the one-string `housing_authority`: "expected 'Tenants - 2-BR' to be 'Tenants - 2-BR - Atlanta'" and "... to be 'Tenants - 2-BR - Atlanta Housing Auth...'". The failing tests are exactly:

   - audienceSummary > leads with Tenants and appends size + authority when set
   - audienceSummary > matching-blast-rules D2: joins a housing authority LIST with ", "

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - the Contact `housingAuthority` comment (old_string is at lines 2273-2274 when this step runs). NOTE: the file holds a NON-ASCII character where old_string below shows `{{U+2014}}` (an em dash): Read those lines and put the real character in old_string in its place. new_string is pure ASCII.

   old_string:

```ts
  /** Tenant housing authority (camelCase {{U+2014}} the byHousingAuthority GSI key). */
  housingAuthority?: string;
```

   new_string:

```ts
  /** Tenant housing authority (camelCase). The byHousingAuthority GSI is keyed
   *  on it and KEPT, but a Matching blast no longer reads that GSI: its housing
   *  authority filter matches this field in memory (matching-blast-rules D2). */
  housingAuthority?: string;
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - the AudienceFilter doc comment (old_string is at line 3268 when this step runs).

   old_string:

```ts
 *  'tenant' (M1.8 targets tenants only); housing_authority/bedroomSize are
```

   new_string:

```ts
 *  'tenant' (M1.8 targets tenants only); housing_authorities/bedroomSize are
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - the AudienceFilter interface (old_string is at lines 3271-3277 when this step runs).

   old_string:

```ts
export interface AudienceFilter {
  contact_type: 'tenant';
  /** Tenant housing authority (the byHousingAuthority GSI key). */
  housing_authority?: string;
  /** Approved bedroom size to match against the tenant's voucherSize (0=Studio). */
  bedroomSize?: number;
}
```

   new_string:

```ts
export interface AudienceFilter {
  contact_type: 'tenant';
  /** matching-blast-rules D2: any-of housing authorities (exact organization
   *  list names); absent = no housing authority filter. Every response that
   *  carries a filter uses this list (present only when non-empty) and never
   *  the legacy one-string `housing_authority` - the server normalizes stored
   *  legacy rows, so the dashboard reads ONE shape. */
  housing_authorities?: string[];
  /** TRANSITIONAL: the old one-string filter, still read by AudienceFilters
   *  until Task 3.3 moves it to the list and deletes this field. */
  housing_authority?: string;
  /** Approved bedroom size to match against the tenant's voucherSize (0=Studio). */
  bedroomSize?: number;
}
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - the end of PreviewCandidate (old_string is at lines 3492-3494 when this step runs).

   old_string:

```ts
  /** last-heard-from D11: an EFFECTIVE decline of this property is recorded. */
  declinedThisProperty: boolean;
}
```

   new_string:

```ts
  /** last-heard-from D11: an EFFECTIVE decline of this property is recorded. */
  declinedThisProperty: boolean;
  /** matching-blast-rules D4: the unresolved tour (for ANY property) that
   *  holds this tenant out of the default selection - absent when none, and on
   *  a seeds-only preview whose rules reads failed (audienceRulesUnavailable). */
  tourHold?: TourHold;
  /** matching-blast-rules D5: the server's ONE default-check rule -
   *  has_consent && (seeded || (!alreadySent && !declined && !tourHold)). The
   *  review starts each row with it and "Select all" re-applies it; the
   *  dashboard never recomputes it. */
  checkedByDefault: boolean;
}

/** matching-blast-rules D4: why a tenant is held out of a blast's default
 *  selection - an unresolved tour for ANY property. MIRRORS
 *  app/src/lib/blastAudienceRules.ts TourHoldKind. */
export type TourHoldKind =
  | 'needs_placement'
  | 'upcoming'
  | 'needs_outcome'
  | 'not_marked'
  | 'no_show'
  | 'requested';

/** One tenant's shown tour hold: `at` is the tour's date (an ISO instant),
 *  absent when the tour has none. MIRRORS app/src/lib/blastAudienceRules.ts
 *  TourHold. */
export interface TourHold {
  kind: TourHoldKind;
  tourId: string;
  at?: string;
}
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - the end of PreviewResponse (old_string is at lines 3547-3550 when this step runs).

   old_string:

```ts
  /** True when the decline reads failed: the candidates came back with NO
   *  not-interested labels, so a declined tenant may start checked. */
  declineLabelsUnavailable: boolean;
}
```

   new_string:

```ts
  /** matching-blast-rules D7: EVERY held contact's tour hold (the analog of
   *  declinedContactIds), so Add a tenant can label a tenant who is not among
   *  the candidates. */
  tourHolds: Array<{ contactId: string } & TourHold>;
  /** matching-blast-rules D5: a SEEDS-ONLY draft's tour or decline read
   *  failed - its rows came back without those labels (a filter draft's
   *  preview answers 503 audience_rules_unavailable instead). */
  audienceRulesUnavailable?: true;
  /** TRANSITIONAL: the removed degrade flag, still read by RecipientPreview
   *  until Task 3.2 deletes its notice and this field. */
  declineLabelsUnavailable?: boolean;
}
```

6. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\endpoints.ts` - the createBroadcast doc comment (old_string is at line 1984 when this step runs).

   old_string:

```ts
 *  shape (contact_type/housing_authority?/bedroomSize?); the server adds the
```

   new_string:

```ts
 *  shape (contact_type/housing_authorities?/bedroomSize?); the server adds the
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\endpoints.ts` - the createBroadcast return type (old_string is at lines 1994-2008 when this step runs).

   old_string:

```ts
}): Promise<{
  broadcastId: string;
  status: 'draft';
  estimatedCount: number;
  truncated: boolean;
  flyerUrl?: string;
}> {
  return request<{
    broadcastId: string;
    status: 'draft';
    estimatedCount: number;
    truncated: boolean;
    flyerUrl?: string;
  }>('/api/broadcasts', { method: 'POST', body });
}
```

   new_string:

```ts
}): Promise<{
  broadcastId: string;
  status: 'draft';
  /** matching-blast-rules D8: how many review rows will START CHECKED (the
   *  default-checked count, stored as the draft's stats.audience). OMITTED
   *  when a rules read failed at create - the composer then reads "Reach
   *  estimate unavailable". */
  estimatedCount?: number;
  truncated: boolean;
  flyerUrl?: string;
}> {
  return request<{
    broadcastId: string;
    status: 'draft';
    estimatedCount?: number;
    truncated: boolean;
    flyerUrl?: string;
  }>('/api/broadcasts', { method: 'POST', body });
}
```

8. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\broadcastFormat.ts` - audienceSummary (old_string is at lines 60-68 when this step runs).

   old_string:

```ts
 *  seeds are not summarized here - D22); appends the size + authority narrowers when set. */
export function audienceSummary(filter: AudienceFilter): string {
  const parts: string[] = ['Tenants'];
  if (filter.bedroomSize !== undefined) parts.push(voucherSizeLabel(filter.bedroomSize));
  if (filter.housing_authority !== undefined && filter.housing_authority.length > 0) {
    parts.push(filter.housing_authority);
  }
  return parts.join(' - ');
}
```

   new_string:

```ts
 *  seeds are not summarized here - D22); appends the size + authority narrowers when set.
 *  matching-blast-rules D2: the housing authorities are a LIST, joined with
 *  ", " ("Tenants - 2-BR - Atlanta Housing Authority, DeKalb Housing Authority"). */
export function audienceSummary(filter: AudienceFilter): string {
  const parts: string[] = ['Tenants'];
  if (filter.bedroomSize !== undefined) parts.push(voucherSizeLabel(filter.bedroomSize));
  const authorities = (filter.housing_authorities ?? []).filter((name) => name.length > 0);
  if (authorities.length > 0) parts.push(authorities.join(', '));
  return parts.join(' - ');
}
```

9. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - the candidate() fixture - typecheck fallout of the required checkedByDefault (old_string is at lines 38-52 when this step runs).

   old_string:

```tsx
function candidate(over: Partial<PreviewResponse['candidates'][number]> = {}): PreviewResponse['candidates'][number] {
  return {
    contactId: 'c1',
    firstName: 'Tasha',
    phone: '+14040000001',
    voucherSize: 2,
    alreadySentThisProperty: false,
    has_consent: true,
    // Matching sends (Task 5 dashboard types): default un-seeded; Task 8 covers
    // the seeded-row rendering itself.
    seeded: false,
    declinedThisProperty: false,
    ...over,
  };
}
```

   new_string:

```tsx
function candidate(over: Partial<PreviewResponse['candidates'][number]> = {}): PreviewResponse['candidates'][number] {
  const row = {
    contactId: 'c1',
    firstName: 'Tasha',
    phone: '+14040000001',
    voucherSize: 2,
    alreadySentThisProperty: false,
    has_consent: true,
    // Matching sends (Task 5 dashboard types): default un-seeded; Task 8 covers
    // the seeded-row rendering itself.
    seeded: false,
    declinedThisProperty: false,
    ...over,
  };
  // matching-blast-rules D5: the server's ONE default-check rule, as fixture
  // data - so a fixture reads like a real preview. A test that needs the
  // server to say something else passes checkedByDefault itself.
  return {
    ...row,
    checkedByDefault:
      over.checkedByDefault ??
      (row.has_consent &&
        (row.seeded || (!row.alreadySentThisProperty && !row.declinedThisProperty && row.tourHold === undefined))),
  };
}
```

10. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - the previewOf() fixture - typecheck fallout of the required tourHolds (old_string is at lines 74-76 when this step runs).

   old_string:

```tsx
    declinedContactIds: [],
    declineLabelsUnavailable: false,
    ...over,
```

   new_string:

```tsx
    declinedContactIds: [],
    declineLabelsUnavailable: false,
    tourHolds: [],
    ...over,
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/RecipientPreview.test.tsx
```

Expected: `Test Files  2 passed (2); Tests  75 passed (75)`. RecipientPreview.test.tsx is unchanged in behavior (its fixtures only gained the two required fields).

#### Step 5 - Typecheck

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/RecipientPreview.test.tsx
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): matching blast wire types - housing_authorities list, tour holds, checkedByDefault, optional estimatedCount; audienceSummary joins a list (S3 Task 3.1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Task 3.2 - tourHoldLabel and the recipient review (server checkedByDefault, tour tags, names, notes)

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/tourHoldLabel.test.ts`
- `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`
- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`
- `dashboard/src/routes/broadcasts/tourHoldLabel.ts`
- `dashboard/src/api/types.ts`
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx`

D4/D5/D7 on the review step. New pure `tourHoldLabel(hold)` (binding 2.8; 1.1 copy, `shortDate`). In
`RecipientPreview`: each row starts at the server's `checkedByDefault` and Select all re-applies it
(the client rule `defaultChecked` is deleted); the ONE client case - a row added or PROMOTED by Add a
tenant takes `checkedByDefault = hasConsent` (RecipientPreview.test.tsx "picking a tenant ALREADY
listed ... kept by Select all", original lines 315-365, keeps passing unchanged); a held row is amber
with its tour tag right after Not interested (the same `declinedTag` class); the checkbox name lists
the cues in order (1.1); Add a tenant's option note lists every cue and an added tenant's hold comes
from the top-level `tourHolds`; the seeds-only `audienceRulesUnavailable` notice replaces the
`declineLabelsUnavailable` notice (deleted with its two tests, original lines 981-989); the
truncation alert never asks to narrow a filter. The BroadcastComposer.test.tsx preview fixtures gain
`checkedByDefault: true` and `tourHolds: []` - the review step now reads both.

#### Step 1 - Write the failing tests

1. Write `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\tourHoldLabel.test.ts` with EXACTLY this content:

```ts
// tourHoldLabel tests - matching-blast-rules D7: every hold kind's label, with
// and without a date. The instants are noon UTC, so the browser-local short
// date (shortDate) is the same calendar day in every US time zone.
import { describe, expect, it } from 'vitest';
import { tourHoldLabel } from './tourHoldLabel.js';

describe('tourHoldLabel', () => {
  it('labels every kind with its date', () => {
    expect(tourHoldLabel({ kind: 'upcoming', tourId: 't1', at: '2026-10-20T12:00:00.000Z' })).toBe('Tour Oct 20');
    expect(tourHoldLabel({ kind: 'not_marked', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Tour Oct 9, not marked',
    );
    expect(tourHoldLabel({ kind: 'needs_outcome', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Toured Oct 9, needs outcome',
    );
    expect(tourHoldLabel({ kind: 'needs_placement', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Toured Oct 9, needs placement',
    );
    expect(tourHoldLabel({ kind: 'no_show', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe('No show Oct 9');
    expect(tourHoldLabel({ kind: 'requested', tourId: 't1', at: '2026-10-12T12:00:00.000Z' })).toBe(
      'Tour requested Oct 12',
    );
  });

  it('drops the date and the space before it when the tour has none', () => {
    expect(tourHoldLabel({ kind: 'upcoming', tourId: 't1' })).toBe('Tour');
    expect(tourHoldLabel({ kind: 'not_marked', tourId: 't1' })).toBe('Tour, not marked');
    expect(tourHoldLabel({ kind: 'needs_outcome', tourId: 't1' })).toBe('Toured, needs outcome');
    expect(tourHoldLabel({ kind: 'needs_placement', tourId: 't1' })).toBe('Toured, needs placement');
    expect(tourHoldLabel({ kind: 'no_show', tourId: 't1' })).toBe('No show');
    expect(tourHoldLabel({ kind: 'requested', tourId: 't1' })).toBe('Tour requested');
  });
});
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - the previewOf() fixture: the removed flag goes (old_string is at lines 74-77 when this step runs).

   old_string:

```tsx
    declinedContactIds: [],
    declineLabelsUnavailable: false,
    tourHolds: [],
    ...over,
```

   new_string:

```tsx
    declinedContactIds: [],
    tourHolds: [],
    ...over,
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - the annotate test title (old_string is at line 975 when this step runs).

   old_string:

```tsx
  it('annotates the Add-a-tenant options: "Not interested" beats "Already sent"', async () => {
```

   new_string:

```tsx
  it('annotates the Add-a-tenant options with every cue, in order: Not interested, Already sent', async () => {
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - the annotate test assertion (old_string is at line 987 when this step runs).

   old_string:

```tsx
    expect(screen.getByRole('option', { name: /Zia Both.*Not interested/ })).not.toHaveTextContent('Already sent');
```

   new_string:

```tsx
    // matching-blast-rules D7: both cues, Not interested first (was one suffix).
    expect(screen.getByRole('option', { name: /Zia Both/ })).toHaveTextContent('Not interested, Already sent');
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - delete the two degraded-line tests; matching-blast-rules D5 removes declineLabelsUnavailable (old_string is at lines 990-1001 when this step runs).

   old_string:

```tsx
  });

  it('shows the degraded line when the decline labels could not load, and not otherwise', () => {
    const LINE = "Couldn't load not-interested labels - a tenant who said no may be checked; sends still work";
    renderPreview({ preview: previewOf({ candidates: [candidate()], declineLabelsUnavailable: true }) });
    expect(screen.getByText(LINE)).toBeInTheDocument();
  });
  it('no degraded line on a healthy preview', () => {
    renderPreview({ preview: previewOf({ candidates: [candidate()] }) });
    expect(screen.queryByText(/Couldn't load not-interested labels/)).toBeNull();
  });
});
```

   new_string:

```tsx
  });
});
```

6. Append to the END of `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.test.tsx` - a new describe block after the last one:

```tsx

// matching-blast-rules D4, D5, D7: rows start from the server's
// checkedByDefault (the dashboard never recomputes the rule), a held tenant is
// listed unchecked with its tour label, and a hand pick here is checked.
describe('RecipientPreview - tour holds and the server default (matching-blast-rules)', () => {
  const listEl = (): HTMLElement => screen.getByRole('list', { name: 'Candidate recipients' });
  const rowOf = (text: string): HTMLElement => within(listEl()).getByText(text).closest('li') as HTMLElement;
  const UPCOMING = { kind: 'upcoming', tourId: 't-1', at: '2026-10-20T12:00:00.000Z' } as const;

  it('a row starts as the server checkedByDefault says - never recomputed from the flags', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Plain', checkedByDefault: false }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
      }),
    });
    expect(within(listEl()).getByRole('checkbox', { name: 'Plain' })).not.toBeChecked();
    expect(within(listEl()).getByRole('checkbox', { name: 'Bo' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Send to 1 recipient' })).toBeInTheDocument();
  });

  it('a held row starts UNCHECKED with its tour tag; Select all skips it; staff may still check it', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Held', tourHold: UPCOMING }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
        tourHolds: [{ contactId: 'c1', ...UPCOMING }],
      }),
    });
    const held = within(listEl()).getByRole('checkbox', { name: 'Held - tour oct 20' });
    expect(held).not.toBeChecked();
    expect(held).toBeEnabled();
    expect(within(rowOf('Held')).getByText('Tour Oct 20')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    await u.click(screen.getByRole('button', { name: 'Select all' }));
    expect(held).not.toBeChecked();
    expect(within(listEl()).getByRole('checkbox', { name: 'Bo' })).toBeChecked();
    // A tour never stops staff from sending: the held row can be checked.
    await u.click(held);
    expect(held).toBeChecked();
    expect(screen.getByRole('button', { name: 'Send to 2 recipients' })).toBeInTheDocument();
  });

  it('the checkbox name lists every cue in order - already sent, not interested, then the tour label in lower case', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({
            contactId: 'c1',
            firstName: 'Ana',
            lastName: 'Diaz',
            alreadySentThisProperty: true,
            declinedThisProperty: true,
            tourHold: UPCOMING,
          }),
          candidate({
            contactId: 'c2',
            firstName: 'Bo',
            phone: '+14040000002',
            tourHold: { kind: 'needs_outcome', tourId: 't-2', at: '2026-10-09T12:00:00.000Z' },
          }),
          candidate({ contactId: 'c3', firstName: 'Cy', phone: '+14040000003', tourHold: { kind: 'not_marked', tourId: 't-3' } }),
          candidate({ contactId: 'c4', firstName: 'Di', phone: '+14040000004', has_consent: false, tourHold: UPCOMING }),
        ],
        priorRecipientContactIds: ['c1'],
        declinedContactIds: ['c1'],
      }),
    });
    expect(
      within(listEl()).getByRole('checkbox', { name: 'Ana Diaz - already sent, not interested, tour oct 20' }),
    ).not.toBeChecked();
    expect(within(listEl()).getByRole('checkbox', { name: 'Bo - toured oct 9, needs outcome' })).not.toBeChecked();
    expect(within(listEl()).getByRole('checkbox', { name: 'Cy - tour, not marked' })).not.toBeChecked();
    // A no-consent row keeps its consent-only name (unchanged).
    expect(within(listEl()).getByRole('checkbox', { name: 'Di - consent not recorded' })).toBeDisabled();
    const ana = rowOf('Ana Diaz');
    expect(within(ana).getByText('Already sent')).toBeInTheDocument();
    expect(within(ana).getByText('Not interested')).toBeInTheDocument();
    expect(within(ana).getByText('Tour Oct 20')).toBeInTheDocument();
    expect(within(rowOf('Cy')).getByText('Tour, not marked')).toBeInTheDocument();
  });

  it('a SEEDED held row starts checked and still shows its label (a hand pick is never held)', () => {
    renderPreview({
      preview: previewOf({
        candidates: [candidate({ contactId: 'c1', firstName: 'Picked', seeded: true, tourHold: UPCOMING })],
        seedContactIds: ['c1'],
        tourHolds: [{ contactId: 'c1', ...UPCOMING }],
      }),
    });
    expect(screen.getByRole('checkbox', { name: 'Picked - tour oct 20' })).toBeChecked();
    expect(within(rowOf('Picked')).getByText('Tour Oct 20')).toBeInTheDocument();
  });

  it('Add a tenant: the option lists every cue, and the added tenant starts checked with its tour label from tourHolds', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })],
        priorRecipientContactIds: ['cX'],
        declinedContactIds: ['cX'],
        tourHolds: [{ contactId: 'cX', kind: 'requested', tourId: 't-9', at: '2026-10-12T12:00:00.000Z' }],
      }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Zia', lastName: 'Both' })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Zia');
    const option = await screen.findByRole('option', { name: /Zia Both/ });
    expect(option).toHaveTextContent('Not interested, Already sent, Tour requested Oct 12');
    await u.click(option);
    const box = within(listEl()).getByRole('checkbox', {
      name: 'Zia Both - already sent, not interested, tour requested oct 12',
    });
    expect(box).toBeChecked();
    expect(within(rowOf('Zia Both')).getByText('Tour requested Oct 12')).toBeInTheDocument();
    // A hand pick stays checked through Select all.
    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    await u.click(screen.getByRole('button', { name: 'Select all' }));
    expect(box).toBeChecked();
  });

  it('picking a HELD filter row in Add a tenant promotes it: checked, still labeled, kept by Select all', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c2', firstName: 'Bo', lastName: 'Held', phone: '+14040000002', tourHold: UPCOMING }),
        ],
        tourHolds: [{ contactId: 'c2', ...UPCOMING }],
      }),
      tenantCandidates: [tenant({ contactId: 'c2', firstName: 'Bo', lastName: 'Held', phone: '+14040000002' })],
    });
    const box = within(listEl()).getByRole('checkbox', { name: 'Bo Held - tour oct 20' });
    expect(box).not.toBeChecked();
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Bo');
    await u.click(await screen.findByRole('option', { name: /Bo Held/ }));
    expect(box).toBeChecked();
    expect(within(listEl()).getAllByText('Bo Held')).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    await u.click(screen.getByRole('button', { name: 'Select all' }));
    expect(box).toBeChecked();
    await waitFor(() => expect(updateBroadcastSeeds).toHaveBeenCalledWith('bcast_1', ['c2']));
  });

  it('a seeds-only preview whose rules reads failed says so', () => {
    renderPreview({
      preview: previewOf({ candidates: [candidate({ seeded: true })], seedContactIds: ['c1'], audienceRulesUnavailable: true }),
    });
    expect(screen.getByText("Tour and Not interested labels couldn't be loaded.")).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Tasha' })).toBeChecked();
  });

  it('no rules notice on a healthy preview', () => {
    renderPreview({ preview: previewOf({ candidates: [candidate()] }) });
    expect(screen.queryByText(/labels couldn't be loaded/)).toBeNull();
  });

  it('a truncated preview says the list may be incomplete - and never asks to narrow a filter', () => {
    renderPreview({ preview: previewOf({ candidates: [candidate()], truncated: true }) });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Too many tenants to read - some matches may be missing from this list.',
    );
    expect(screen.queryByText(/Narrow the filter/)).toBeNull();
  });
});
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the preview fixture(the review step now reads checkedByDefault and tourHolds) (old_string is at line 234 when this step runs).

   old_string:

```tsx
has_consent: true, seeded: false, declinedThisProperty: false }], priorRecipientContactIds: [], seedContactIds: [], unresolvedSeedIds: [], declinedContactIds: [], declineLabelsUnavailable: false });
```

   new_string:

```tsx
has_consent: true, seeded: false, declinedThisProperty: false, checkedByDefault: true }], priorRecipientContactIds: [], seedContactIds: [], unresolvedSeedIds: [], declinedContactIds: [], tourHolds: [] });
```

8. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the seeded candidate (old_string is at line 491 when this step runs).

   old_string:

```tsx
alreadySentThisProperty: false, has_consent: true, seeded: true, declinedThisProperty: false }],
```

   new_string:

```tsx
alreadySentThisProperty: false, has_consent: true, seeded: true, declinedThisProperty: false, checkedByDefault: true }],
```

9. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the preview fixture (old_string is at lines 495-497 when this step runs).

   old_string:

```tsx
      declinedContactIds: [],
      declineLabelsUnavailable: false,
    });
```

   new_string:

```tsx
      declinedContactIds: [],
      tourHolds: [],
    });
```

10. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - DEKALB_TENANT (old_string is at lines 818-821 when this step runs).

   old_string:

```tsx
    seeded: false,
    declinedThisProperty: false,
  };
  const previewOf
```

   new_string:

```tsx
    seeded: false,
    declinedThisProperty: false,
    checkedByDefault: true,
  };
  const previewOf
```

11. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the previewOf() fixture (old_string is at lines 829-831 when this step runs).

   old_string:

```tsx
    declinedContactIds: [],
    declineLabelsUnavailable: false,
  });
```

   new_string:

```tsx
    declinedContactIds: [],
    tourHolds: [],
  });
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/tourHoldLabel.test.ts src/routes/broadcasts/RecipientPreview.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: the run FAILS (`Test Files  2 failed | 1 passed (3); Tests  9 failed | 97 passed (106)`). tourHoldLabel.test.ts fails to import the missing module; the RecipientPreview cases fail on the old client rule, the old one-suffix note and the old copy. The failing tests are exactly:

   - RecipientPreview - columns, order and not-interested rows (last-heard-from 5.3) > annotates the Add-a-tenant options with every cue, in order: Not interested, Already sent
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > a row starts as the server checkedByDefault says - never recomputed from the flags
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > a held row starts UNCHECKED with its tour tag; Select all skips it; staff may still check it
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > the checkbox name lists every cue in order - already sent, not interested, then the tour label in lower case
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > a SEEDED held row starts checked and still shows its label (a hand pick is never held)
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > Add a tenant: the option lists every cue, and the added tenant starts checked with its tour label from tourHolds
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > picking a HELD filter row in Add a tenant promotes it: checked, still labeled, kept by Select all
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > a seeds-only preview whose rules reads failed says so
   - RecipientPreview - tour holds and the server default (matching-blast-rules) > a truncated preview says the list may be incomplete - and never asks to narrow a filter
   - Error: Failed to resolve import "./tourHoldLabel.js" from "src/routes/broadcasts/tourHoldLabel.test.ts". Does the file exist?

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Write `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\tourHoldLabel.ts` with EXACTLY this content:

```ts
// tourHoldLabel - matching-blast-rules D7: the recipient review's label for a
// tenant's tour hold (D4). The date is the dashboard's browser-local short
// date (shortDate, "Oct 20" - the same as every other tour date); a hold with
// no date drops the date and the space before it ("Tour, not marked").
import type { TourHold } from '../../api/index.js';
import { shortDate } from '../placements/placementsFormat.js';

export function tourHoldLabel(hold: TourHold): string {
  const day = hold.at !== undefined ? shortDate(hold.at) : '';
  const at = day === '' ? '' : ` ${day}`;
  switch (hold.kind) {
    case 'upcoming':
      return `Tour${at}`;
    case 'not_marked':
      return `Tour${at}, not marked`;
    case 'needs_outcome':
      return `Toured${at}, needs outcome`;
    case 'needs_placement':
      return `Toured${at}, needs placement`;
    case 'no_show':
      return `No show${at}`;
    case 'requested':
      return `Tour requested${at}`;
    default:
      // A kind this dashboard does not know yet (a newer server): still a tour.
      return `Tour${at}`;
  }
}
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - delete the TRANSITIONAL declineLabelsUnavailable (Task 3.1 added it) (old_string is at lines 3554-3558 when this step runs).

   old_string:

```ts
  audienceRulesUnavailable?: true;
  /** TRANSITIONAL: the removed degrade flag, still read by RecipientPreview
   *  until Task 3.2 deletes its notice and this field. */
  declineLabelsUnavailable?: boolean;
}
```

   new_string:

```ts
  audienceRulesUnavailable?: true;
}
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the header comment (old_string is at lines 9-13 when this step runs).

   old_string:

```tsx
// Already-sent-this-property rows render amber and start UNCHECKED (a SOFT
// opt-in-to-resend flag, never a hard gate) - UNLESS the row is SEEDED: a seed
// (the one-to-one tenant, a preview-returned hand-pick, or a tenant added right
// here) is a deliberate choice and stays checked, through "Select all" too
// (share-skip-fix D5 / I4). "Select all" skips UNSEEDED already-sent rows.
```

   new_string:

```tsx
// Flagged rows (already sent, Not interested, a tour hold) render amber. Each
// row starts as the server's checkedByDefault says (matching-blast-rules D5:
// has_consent && (seeded || (!alreadySent && !declined && !tourHold))) and
// "Select all" re-applies it - the dashboard never recomputes the rule. ONE
// client-side case: a row added or PROMOTED by Add a tenant here is a hand
// pick from that moment (checkedByDefault = hasConsent), so it starts checked
// and "Select all" keeps it (share-skip-fix D5 / I4).
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the api import (old_string is at lines 30-33 when this step runs).

   old_string:

```tsx
  type Contact,
  type ListingStatus,
  type PreviewResponse,
} from '../../api/index.js';
```

   new_string:

```tsx
  type Contact,
  type ListingStatus,
  type PreviewResponse,
  type TourHold,
} from '../../api/index.js';
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the module imports (old_string is at line 40 when this step runs).

   old_string:

```tsx
import styles from './RecipientPreview.module.css';
```

   new_string:

```tsx
import { tourHoldLabel } from './tourHoldLabel.js';
import styles from './RecipientPreview.module.css';
```

6. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the Row interface (old_string is at lines 70-72 when this step runs).

   old_string:

```tsx
  /** An EFFECTIVE decline of this property (declinedContactIds, D11). */
  declined: boolean;
}
```

   new_string:

```tsx
  /** An EFFECTIVE decline of this property (declinedContactIds, D11). */
  declined: boolean;
  /** matching-blast-rules D4: the unresolved tour that holds this tenant. */
  tourHold?: TourHold;
  /** matching-blast-rules D5: the row's default - the server's verdict for a
   *  preview row, hasConsent for a hand pick made here. The initial state
   *  AND "Select all" read it. */
  checkedByDefault: boolean;
}
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - defaultChecked + checkboxName: the client rule goes (old_string is at lines 106-121 when this step runs).

   old_string:

```tsx
/** The ONE default-check rule - initial rows AND Select all (spec 14.4 B11):
 *  a no-consent row never; a seeded row always (a pick is deliberate,
 *  share-skip-fix D5); otherwise only a row neither already sent nor declined. */
function defaultChecked(r: Pick<Row, 'hasConsent' | 'seeded' | 'alreadySentThisProperty' | 'declined'>): boolean {
  return r.hasConsent && (r.seeded || (!r.alreadySentThisProperty && !r.declined));
}

/** The checkbox's accessible name: the person plus every cue, ASCII " - "
 *  (spec 14.4 B7) - so getByRole('checkbox', { name }) resolves by the row. */
function checkboxName(row: Row): string {
  if (!row.hasConsent) return `${row.name} - consent not recorded`;
  if (row.alreadySentThisProperty && row.declined) return `${row.name} - already sent, not interested`;
  if (row.alreadySentThisProperty) return `${row.name} - already sent`;
  if (row.declined) return `${row.name} - not interested`;
  return row.name;
}
```

   new_string:

```tsx
/** The checkbox's accessible name: the person plus every cue, ASCII " - "
 *  (spec 14.4 B7) - so getByRole('checkbox', { name }) resolves by the row.
 *  matching-blast-rules D7: the cues joined with ", " in the order already
 *  sent, not interested, then the tour label in lower case
 *  ("Ana Diaz - already sent, not interested, tour oct 20"). A no-consent row
 *  names its fence alone. */
function checkboxName(row: Row): string {
  if (!row.hasConsent) return `${row.name} - consent not recorded`;
  const cues: string[] = [];
  if (row.alreadySentThisProperty) cues.push('already sent');
  if (row.declined) cues.push('not interested');
  if (row.tourHold !== undefined) cues.push(tourHoldLabel(row.tourHold).toLowerCase());
  return cues.length > 0 ? `${row.name} - ${cues.join(', ')}` : row.name;
}
```

8. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the end of initialRows (old_string is at lines 135-142 when this step runs).

   old_string:

```tsx
      declined: declinedIds.has(c.contactId),
      hasConsent: c.has_consent,
      seeded: c.seeded,
      checked: false,
    };
    return { ...row, checked: defaultChecked(row) };
  });
}
```

   new_string:

```tsx
      declined: declinedIds.has(c.contactId),
      ...(c.tourHold !== undefined && { tourHold: c.tourHold }),
      hasConsent: c.has_consent,
      seeded: c.seeded,
      // matching-blast-rules D5: the server's verdict, as is.
      checkedByDefault: c.checkedByDefault,
      checked: c.checkedByDefault,
    };
    return row;
  });
}
```

9. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - after declinedIds (old_string is at line 161 when this step runs).

   old_string:

```tsx
  const declinedIds = useMemo(() => new Set(preview.declinedContactIds), [preview.declinedContactIds]);
```

   new_string:

```tsx
  const declinedIds = useMemo(() => new Set(preview.declinedContactIds), [preview.declinedContactIds]);
  /** matching-blast-rules D7: EVERY held contact's tour hold - labels a
   *  tenant Add a tenant brings in from outside the candidates. */
  const tourHoldsById = useMemo(
    () =>
      new Map<string, TourHold>(
        preview.tourHolds.map((h) => [
          h.contactId,
          h.at !== undefined ? { kind: h.kind, tourId: h.tourId, at: h.at } : { kind: h.kind, tourId: h.tourId },
        ]),
      ),
    [preview.tourHolds],
  );
```

10. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - selectAll (old_string is at lines 262-268 when this step runs).

   old_string:

```tsx
  /** Select all - but SKIP unseeded already-sent rows (opt-in only) AND
   *  no-consent rows (hard fence). A SEEDED row stays checked whatever its flag
   *  (share-skip-fix D5): the operator picked them on purpose.
   *  ... AND unseeded declined rows (spec 14.4 B11). */
  function selectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: defaultChecked(r) })));
  }
```

   new_string:

```tsx
  /** Select all = every row back to its default (matching-blast-rules D5):
   *  the server's checkedByDefault skips unseeded already-sent, declined and
   *  held rows and every no-consent row (hard fence); a hand pick made here
   *  defaults to checked (share-skip-fix D5). */
  function selectAll(): void {
    setRows((prev) => prev.map((r) => ({ ...r, checked: r.checkedByDefault })));
  }
```

11. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the promotion in addTenant (old_string is at lines 322-326 when this step runs).

   old_string:

```tsx
        return prev.map((r) =>
          r.contactId === candidate.contactId ? { ...r, seeded: true, checked: r.hasConsent } : r,
        );
      }
      const already = priorIds.has(candidate.contactId);
```

   new_string:

```tsx
        // matching-blast-rules D5: from this pick on the row is a hand pick,
        // so its default is hasConsent - Select all keeps it checked.
        return prev.map((r) =>
          r.contactId === candidate.contactId
            ? { ...r, seeded: true, checkedByDefault: r.hasConsent, checked: r.hasConsent }
            : r,
        );
      }
      const already = priorIds.has(candidate.contactId);
      const hold = tourHoldsById.get(candidate.contactId);
```

12. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the added row (old_string is at lines 347-348 when this step runs).

   old_string:

```tsx
          declined: declinedIds.has(candidate.contactId),
          hasConsent: true,
```

   new_string:

```tsx
          declined: declinedIds.has(candidate.contactId),
          // matching-blast-rules D7: a tenant from outside the candidates is
          // labeled from the top-level tourHolds list.
          ...(hold !== undefined && { tourHold: hold }),
          hasConsent: true,
```

13. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the added row (old_string is at lines 355-357 when this step runs).

   old_string:

```tsx
          checked: true,
          added: true,
          seeded: true,
```

   new_string:

```tsx
          checkedByDefault: true,
          checked: true,
          added: true,
          seeded: true,
```

14. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - annotateCandidate (old_string is at lines 467-470 when this step runs).

   old_string:

```tsx
  /** "Add a tenant" suffix (spec 5.3): warns BEFORE the pick. One suffix -
   *  Not interested outranks Already sent. */
  const annotateCandidate = (c: Contact): string | undefined =>
    declinedIds.has(c.contactId) ? 'Not interested' : priorIds.has(c.contactId) ? 'Already sent' : undefined;
```

   new_string:

```tsx
  /** "Add a tenant" note (spec 5.3; matching-blast-rules D7): warns BEFORE
   *  the pick with every cue that applies, in the order Not interested,
   *  Already sent, then the tour label - joined with ", ". */
  const annotateCandidate = (c: Contact): string | undefined => {
    const cues: string[] = [];
    if (declinedIds.has(c.contactId)) cues.push('Not interested');
    if (priorIds.has(c.contactId)) cues.push('Already sent');
    const hold = tourHoldsById.get(c.contactId);
    if (hold !== undefined) cues.push(tourHoldLabel(hold));
    return cues.length > 0 ? cues.join(', ') : undefined;
  };
```

15. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the decline-unavailable notice becomes the seeds-only notice (old_string is at lines 528-534 when this step runs).

   old_string:

```tsx
      {/* last-heard-from 5.3: the decline reads failed - say so rather than hide
          it (a declined tenant who is not also already sent starts CHECKED). */}
      {preview.declineLabelsUnavailable ? (
        <p className={styles.seedNotice} role="status">
          Couldn&apos;t load not-interested labels - a tenant who said no may be checked; sends still work
        </p>
      ) : null}
```

   new_string:

```tsx
      {/* matching-blast-rules D5: a SEEDS-ONLY draft's tour or decline reads
          failed - its rows came back without those labels (seeds stay
          checked). A filter draft's preview is refused instead (503). */}
      {preview.audienceRulesUnavailable === true ? (
        <p className={styles.seedNotice} role="status">
          Tour and Not interested labels couldn&apos;t be loaded.
        </p>
      ) : null}
```

16. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the row className: a held row is amber too (old_string is at line 568 when this step runs).

   old_string:

```tsx
row.alreadySentThisProperty || row.declined ? styles.rowAlready : ''}`.trim()}
```

   new_string:

```tsx
row.alreadySentThisProperty || row.declined || row.tourHold !== undefined ? styles.rowAlready : ''}`.trim()}
```

17. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the row tags (old_string is at line 622 when this step runs).

   old_string:

```tsx
                          {row.declined ? <span className={styles.declinedTag}>Not interested</span> : null}
```

   new_string:

```tsx
                          {row.declined ? <span className={styles.declinedTag}>Not interested</span> : null}
                          {/* matching-blast-rules D7: the tour hold, after Not
                              interested, in the same amber tag. */}
                          {row.tourHold !== undefined ? (
                            <span className={styles.declinedTag}>{tourHoldLabel(row.tourHold)}</span>
                          ) : null}
```

18. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\RecipientPreview.tsx` - the truncation alert (old_string is at lines 698-701 when this step runs). NOTE: the file holds a NON-ASCII character where old_string below shows `{{U+2014}}` (an em dash): Read those lines and put the real character in old_string in its place. new_string is pure ASCII.

   old_string:

```tsx
        <p className={styles.truncated} role="alert">
          The audience hit the cap {{U+2014}} some matches may be missing. Narrow the filter for a complete
          list.
        </p>
```

   new_string:

```tsx
        <p className={styles.truncated} role="alert">
          Too many tenants to read - some matches may be missing from this list.
        </p>
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/tourHoldLabel.test.ts src/routes/broadcasts/RecipientPreview.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: `Test Files  3 passed (3); Tests  108 passed (108)`. BroadcastComposer.test.tsx still passes - its review-step fixtures now carry the server fields.

#### Step 5 - Typecheck and lint

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

Lint the touched source (from the worktree root):

```
cd W:\tmp\matching-blast-rules; npx eslint dashboard/src/routes/broadcasts/RecipientPreview.tsx dashboard/src/routes/broadcasts/tourHoldLabel.ts dashboard/src/routes/broadcasts/tourHoldLabel.test.ts dashboard/src/routes/broadcasts/RecipientPreview.test.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/api/types.ts
```

Expected: exit 0, no problems.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/tourHoldLabel.test.ts dashboard/src/routes/broadcasts/RecipientPreview.test.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/routes/broadcasts/tourHoldLabel.ts dashboard/src/api/types.ts dashboard/src/routes/broadcasts/RecipientPreview.tsx
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): recipient review follows the server checkedByDefault; tour hold tags, accessible names, Add a tenant cues, seeds-only rules notice, truncation copy (S3 Task 3.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Task 3.3 - AudienceFilters: the "Housing authorities" multi-picker, caption, prefill notes, incomplete-list suffix

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/AudienceFilters.test.tsx`
- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`
- `dashboard/src/api/types.ts`
- `dashboard/src/routes/broadcasts/useComposerDraft.ts`
- `dashboard/src/routes/broadcasts/AudienceFilters.tsx`
- `dashboard/src/routes/broadcasts/AudienceFilters.module.css`
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`

D2/D3/D7/D8 in the filters panel. DECISION (the brief asked to decide and state it): the organization
list moves UP - the COMPOSER calls `useOrgList()` once and passes it to `AudienceFilters` as a
required `orgList: OrgListView` prop. Not a second hook call: the prefill and the Preview gate (Task
3.5) must read the SAME answer the picker shows, and useOrgList reads GET /api/organizations once
per mount (two instances would read twice and could disagree).

`OrgPicker multiple` labeled "Housing authorities" holds `filter.housing_authorities` (absent when
empty); the caption (1.1, sentence 2 only while the list is non-empty) sits under the always-excluded
note; the prefill notes (`unusedAuthorities`, `noAuthorityMapped`, `prefillNotices` props - Task 3.5
feeds them) render under the picker as plain paragraphs (no role, so the reach line stays the panel's
only `role="status"`); the truncation suffix is " - the list is incomplete". CONTRACT ISSUE 2: the
not-limited sentence shows only while none mapped AND no authority is selected.

Fallout in the same commit: the composer passes `orgList`, `useComposerDraft`'s draft key covers the
LIST, the TRANSITIONAL `AudienceFilter.housing_authority` goes, and BroadcastComposer.test.tsx moves
to the new label, filter shape and truncation copy (the composer's own D3 behavior is Task 3.5; until
then a 422 still clears the whole list, which its existing tests pin).

#### Step 1 - Write the failing tests

1. Write `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.test.tsx` with EXACTLY this content - replace the WHOLE file (Write) - every test moves to the list shape and the orgList prop:

```tsx
// AudienceFilters tests - the extensible audience-filter framework: the
// voucher-size chips (with the "matches property" tag pre-filled from the voucher
// size the unit takes), the "Housing authorities" multi-picker over the
// organization list (matching-blast-rules D2), the property prefill's notes
// (D3), the caption (D8), the disabled "+ Add filter" seam, the always-excluded
// note, and the live reach count + incomplete-list suffix (D7).
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AudienceFilter, OrgEntry } from '../../api/index.js';
import type { OrgListView } from '../orgs/orgCopy.js';
import { AudienceFilters } from './AudienceFilters.js';

function entry(orgId: string, name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId,
    kind: 'housing_authority',
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}
const ATLANTA = entry('o-atl', 'Atlanta Housing Authority', ['AHA']);
const DEKALB = entry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
// The picker's list (spec 2026-10-06 D7) now comes from the composer as a
// prop (matching-blast-rules D3): each test passes its own list state.
const LOADED: OrgListView = { entries: [ATLANTA, DEKALB], loading: false, error: false };
const FAILED: OrgListView = { entries: [], loading: false, error: true };

const CAPTION_SHORT =
  'Only tenants in Onboarding or Searching are included. Add any other tenant by hand when you review recipients.';
const CAPTION_LONG =
  'Only tenants in Onboarding or Searching are included. While a housing authority is selected, tenants whose ' +
  'housing authority is missing or not on the organization list are left out. Add any other tenant by hand when ' +
  'you review recipients.';

/** Controlled harness - mirrors the composer owning the filter state so chip
 *  toggles round-trip through onChange. */
function Harness({
  authorityError,
  propertyVoucherSize,
  reachCount,
  reachPending = false,
  truncated = false,
  onChangeSpy,
  onAuthorityTextChange,
  initialFilter = { contact_type: 'tenant' },
  disabled,
  orgList = LOADED,
  unusedAuthorities,
  noAuthorityMapped,
  prefillNotices,
}: {
  propertyVoucherSize?: number;
  reachCount?: number;
  reachPending?: boolean;
  truncated?: boolean;
  onChangeSpy?: (f: AudienceFilter) => void;
  authorityError?: string;
  onAuthorityTextChange?: (text: string) => void;
  initialFilter?: AudienceFilter;
  disabled?: boolean;
  orgList?: OrgListView;
  unusedAuthorities?: string[];
  noAuthorityMapped?: boolean;
  prefillNotices?: string[];
}): React.JSX.Element {
  const [filter, setFilter] = useState<AudienceFilter>(initialFilter);
  return (
    <AudienceFilters
      filter={filter}
      onChange={(next) => {
        onChangeSpy?.(next);
        setFilter(next);
      }}
      orgList={orgList}
      {...(disabled !== undefined && { disabled })}
      {...(propertyVoucherSize !== undefined && { propertyVoucherSize })}
      {...(reachCount !== undefined && { reachCount })}
      reachPending={reachPending}
      truncated={truncated}
      {...(authorityError !== undefined && { authorityError })}
      {...(onAuthorityTextChange !== undefined && { onAuthorityTextChange })}
      {...(unusedAuthorities !== undefined && { unusedAuthorities })}
      {...(noAuthorityMapped !== undefined && { noAuthorityMapped })}
      {...(prefillNotices !== undefined && { prefillNotices })}
    />
  );
}

describe('AudienceFilters - voucher size pre-fill + override', () => {
  it('shows the "matches property" tag + note on the chip matching the voucher size the unit takes', () => {
    render(<Harness propertyVoucherSize={2} />);
    const chips = screen.getByRole('group', { name: 'Voucher size' });
    const twoBr = within2(chips, '2-BR');
    expect(twoBr).toHaveTextContent(/matches property/i);
    // The note names the voucher size (not the bedrooms) and says it is overridable.
    expect(
      screen.getByText(/Pre-filled to the 2-bedroom voucher this property takes - change it/i),
    ).toBeInTheDocument();
  });

  it('lets the operator override the voucher size (pick a different chip)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness propertyVoucherSize={2} onChangeSpy={onChangeSpy} />);
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(onChangeSpy).toHaveBeenCalledWith({ contact_type: 'tenant', bedroomSize: 3 });
    // The 3-BR chip is now pressed.
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles a chip off when re-clicked (clears the size narrower)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    // Re-click: bedroomSize cleared.
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('a voucher chip keeps the housing authority list as it is', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(
      <Harness
        onChangeSpy={onChangeSpy}
        initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'] }}
      />,
    );
    await u.click(screen.getByRole('button', { name: '3-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
      bedroomSize: 3,
    });
  });
});

describe('AudienceFilters - housing authorities (matching-blast-rules D2)', () => {
  it('is a multi-picker labeled "Housing authorities": each pick ADDS a list name (names and spellings match)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'AHA');
    // Typing never commits (each filter change recreates the draft).
    expect(onChangeSpy).not.toHaveBeenCalled();
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
    });
    await u.type(box, 'HADC');
    await u.click(screen.getByRole('option', { name: /^DeKalb County Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
    });
    // Removing one chip keeps the other; removing the last clears the filter.
    await u.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority'],
    });
    await u.click(screen.getByRole('button', { name: 'Remove DeKalb County Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('a chosen name is no longer offered (multi mode hides members)', async () => {
    const u = userEvent.setup();
    render(<Harness initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Housing');
    expect(screen.queryByRole('option', { name: /^Atlanta Housing Authority/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^DeKalb County Housing Authority/ })).toBeInTheDocument();
  });

  it('a field left holding typed text says it is no filter - even a full list name (R2-FE-6)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'Atlanta Housing Authority');
    await u.tab();
    expect(box).toHaveAccessibleDescription('Not used as a filter - pick a name from the list, or clear the text.');
  });

  it('never offers to add a name (spec D7)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Nowhere Board');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('a list that fails to load says so and the filter cannot be set; voucher size still works', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} orgList={FAILED} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByRole('combobox', { name: 'Housing authorities' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('tells the composer what is typed in the picker - and nothing once a name is picked (R2-FE-3)', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('AHA');
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
  });

  it('a list that fails to load marks no picked filter "Not on the list" - nothing is known about it (R3-FE-5)', () => {
    render(
      <Harness orgList={FAILED} initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByText('Atlanta Housing Authority')).toBeInTheDocument();
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
  });

  it('a list that fails while text is typed keeps the field clearable - that text holds Preview back', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    const { rerender } = render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'Atl');
    rerender(<Harness onAuthorityTextChange={onAuthorityTextChange} orgList={FAILED} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(box).toBeEnabled();
    await u.clear(box);
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
    expect(box).toBeDisabled();
  });

  it('disabled (a preview is loading): no voucher chip, pick or chip removal can change the audience (R3-FE-1)', () => {
    render(
      <Harness
        disabled
        initialFilter={{ contact_type: 'tenant', bedroomSize: 2, housing_authorities: ['Atlanta Housing Authority'] }}
      />,
    );
    const chips = screen.getByRole('group', { name: 'Voucher size' });
    for (const chip of Array.from(chips.querySelectorAll('button'))) expect(chip).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Housing authorities' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeDisabled();
  });

  it("shows the composer's message under the picker", () => {
    render(
      <Harness authorityError="Atlanta Housing Authority is no longer on the organization list, so it was removed from the filter." />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Atlanta Housing Authority is no longer on the organization list, so it was removed from the filter.',
    );
  });
});

describe('AudienceFilters - the property prefill notes (matching-blast-rules D3)', () => {
  it('names the property authorities that are not on the organization list', () => {
    render(
      <Harness
        unusedAuthorities={['Nowhere Board', 'Old Name HA']}
        initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }}
      />,
    );
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board, Old Name HA')).toBeInTheDocument();
    expect(screen.queryByText(/This blast is not limited by housing authority/)).not.toBeInTheDocument();
  });

  it('when NONE of them mapped, says the blast is not limited by housing authority', () => {
    render(<Harness unusedAuthorities={['Nowhere Board']} noAuthorityMapped />);
    expect(
      screen.getByText(
        'Not used (not on the organization list): Nowhere Board This blast is not limited by housing authority.',
      ),
    ).toBeInTheDocument();
  });

  it('drops the not-limited sentence once staff pick an authority', async () => {
    const u = userEvent.setup();
    render(<Harness unusedAuthorities={['Nowhere Board']} noAuthorityMapped />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board')).toBeInTheDocument();
  });

  it('shows the settle notices the composer passes', () => {
    render(
      <Harness
        prefillNotices={[
          "Couldn't load the property, so its housing authorities and voucher size were not filled in.",
          "Couldn't load the organization list, so housing authorities were not filled in from the property.",
        ]}
      />,
    );
    expect(
      screen.getByText("Couldn't load the property, so its housing authorities and voucher size were not filled in."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load the organization list, so housing authorities were not filled in from the property."),
    ).toBeInTheDocument();
  });

  it('no notes without a prefill', () => {
    render(<Harness />);
    expect(screen.queryByText(/Not used \(not on the organization list\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the/)).not.toBeInTheDocument();
  });
});

describe('AudienceFilters - caption (matching-blast-rules D8)', () => {
  it('says who is included - without the housing authority sentence while none is selected', () => {
    render(<Harness />);
    expect(screen.getByText(CAPTION_SHORT)).toBeInTheDocument();
    expect(screen.queryByText(/While a housing authority is selected/)).not.toBeInTheDocument();
  });

  it('adds the housing authority sentence while the list is non-empty', () => {
    render(<Harness initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />);
    expect(screen.getByText(CAPTION_LONG)).toBeInTheDocument();
  });
});

describe('AudienceFilters - seam + excluded note', () => {
  it('renders a DISABLED "+ Add filter" seam', () => {
    render(<Harness />);
    const add = screen.getByRole('button', { name: '+ Add filter' });
    expect(add).toBeDisabled();
  });

  it('renders the always-excluded note (opted-out - unreachable)', () => {
    render(<Harness />);
    expect(screen.getByText(/Always excluded:/i)).toBeInTheDocument();
    expect(screen.getByText('opted-out')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });
});

describe('AudienceFilters - live reach', () => {
  it('shows "Estimating reach" while pending', () => {
    render(<Harness reachPending />);
    expect(screen.getByText(/Estimating reach/i)).toBeInTheDocument();
  });

  it('shows the reach count when resolved', () => {
    render(<Harness reachCount={7} />);
    const reach = screen.getByRole('status');
    expect(reach).toHaveTextContent(/Reaches\s*7\s*recipients/);
  });

  it('says the list is incomplete when truncated - and never asks to narrow a filter (D7)', () => {
    render(<Harness reachCount={500} truncated />);
    expect(screen.getByRole('status')).toHaveTextContent('Reaches 500 recipients - the list is incomplete');
    expect(screen.queryByText(/narrow/i)).not.toBeInTheDocument();
  });
});

/** Find a button by its leading label text within a group (chips carry an extra
 *  "- matches property" span we don't want to over-match). */
function within2(container: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  );
  if (!btn) throw new Error(`no chip starting with ${label}`);
  return btn as HTMLElement;
}
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the label lookups (old_string is at lines 107, 131, 349, 351, 433, 455 when this step runs). Use `replace_all: true`: the text occurs more than once and EVERY occurrence changes.

   old_string:

```tsx
'Housing authority')
```

   new_string:

```tsx
'Housing authorities')
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the combobox lookups (old_string is at lines 677, 741, 784, 833 when this step runs). Use `replace_all: true`: the text occurs more than once and EVERY occurrence changes.

   old_string:

```tsx
{ name: 'Housing authority' }
```

   new_string:

```tsx
{ name: 'Housing authorities' }
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - both draftAuthorities() helpers (old_string is at lines 744, 837 when this step runs). Use `replace_all: true`: the text occurs more than once and EVERY occurrence changes.

   old_string:

```tsx
      ([body]) => (body as { audience_filter?: { housing_authority?: string } } | undefined)?.audience_filter?.housing_authority,
```

   new_string:

```tsx
      ([body]) => (body as { audience_filter?: { housing_authorities?: string[] } } | undefined)?.audience_filter?.housing_authorities,
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - line 765 (old_string is at line 765 when this step runs).

   old_string:

```tsx
    expect(draftAuthorities().at(-1)).toBe('Atlanta Housing Authority');
```

   new_string:

```tsx
    expect(draftAuthorities().at(-1)).toEqual(['Atlanta Housing Authority']);
```

6. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - lines 687-688 (old_string is at lines 687-688 when this step runs).

   old_string:

```tsx
    createBroadcast.mockImplementation(async (body: { audience_filter?: { housing_authority?: string } }) => {
      if (body.audience_filter?.housing_authority !== undefined) throw refused();
```

   new_string:

```tsx
    createBroadcast.mockImplementation(async (body: { audience_filter?: { housing_authorities?: string[] } }) => {
      if (body.audience_filter?.housing_authorities !== undefined) throw refused();
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - line 210 (the truncation suffix copy, D7) (old_string is at line 210 when this step runs).

   old_string:

```tsx
    await waitFor(() => expect(screen.getByText(/list is capped/i)).toBeInTheDocument(), { timeout: 4000 });
```

   new_string:

```tsx
    await waitFor(() => expect(screen.getByText(/the list is incomplete/)).toBeInTheDocument(), { timeout: 4000 });
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/AudienceFilters.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/BroadcastComposer.prefill.test.tsx
```

Expected: the run FAILS (`Test Files  2 failed | 1 passed (3); Tests  29 failed | 50 passed (79)`). AudienceFilters cases fail on the single picker's label/shape and the missing caption/notes/suffix; the BroadcastComposer cases fail because the label is still "Housing authority", the picker still sends one string, and the suffix copy is old. The failing tests are exactly (`<U+2014>` stands for the em dash in an existing test title):

   - AudienceFilters - voucher size pre-fill + override > a voucher chip keeps the housing authority list as it is
   - AudienceFilters - housing authorities (matching-blast-rules D2) > is a multi-picker labeled "Housing authorities": each pick ADDS a list name (names and spellings match)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > a chosen name is no longer offered (multi mode hides members)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > a field left holding typed text says it is no filter - even a full list name (R2-FE-6)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > never offers to add a name (spec D7)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > a list that fails to load says so and the filter cannot be set; voucher size still works
   - AudienceFilters - housing authorities (matching-blast-rules D2) > tells the composer what is typed in the picker - and nothing once a name is picked (R2-FE-3)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > a list that fails to load marks no picked filter "Not on the list" - nothing is known about it (R3-FE-5)
   - AudienceFilters - housing authorities (matching-blast-rules D2) > a list that fails while text is typed keeps the field clearable - that text holds Preview back
   - AudienceFilters - housing authorities (matching-blast-rules D2) > disabled (a preview is loading): no voucher chip, pick or chip removal can change the audience (R3-FE-1)
   - AudienceFilters - the property prefill notes (matching-blast-rules D3) > names the property authorities that are not on the organization list
   - AudienceFilters - the property prefill notes (matching-blast-rules D3) > when NONE of them mapped, says the blast is not limited by housing authority
   - AudienceFilters - the property prefill notes (matching-blast-rules D3) > drops the not-limited sentence once staff pick an authority
   - AudienceFilters - the property prefill notes (matching-blast-rules D3) > shows the settle notices the composer passes
   - AudienceFilters - caption (matching-blast-rules D8) > says who is included - without the housing authority sentence while none is selected
   - AudienceFilters - caption (matching-blast-rules D8) > adds the housing authority sentence while the list is non-empty
   - AudienceFilters - live reach > says the list is incomplete when truncated - and never asks to narrow a filter (D7)
   - BroadcastComposer - property-first step (spec 2026-07-13) > picking a property reveals compose with the message pre-filled: unit fields resolved, [TenantName] kept
   - BroadcastComposer <U+2014> reach count + truncated > shows the truncated/capped warning when the estimate is truncated
   - BroadcastComposer - ?contactId= seeding > seeded entry shows the seeds-only banner; "Add more tenants by filters" enables the filter
   - BroadcastComposer - resolved message mode (single recipient) > an UNEDITED auto-seeded body resets silently when filters are enabled (no name leak, no confirm)
   - BroadcastComposer - a housing authority that left the list > a refused draft create clears the pick and says so - and Preview works again
   - BroadcastComposer - a housing authority that left the list > a refused Preview clears the pick, says so, and recreates the draft without it
   - BroadcastComposer - text typed in the housing authority filter > a full name typed but not picked holds Preview back and says why - a pick lets it go
   - BroadcastComposer - text typed in the housing authority filter > clearing the text lets Preview go again - with no new draft
   - BroadcastComposer - text typed in the housing authority filter > (PIN) text typed before "Change" goes with the compose step: Preview works for the next pick
   - BroadcastComposer - the audience while a preview loads (code review R3-FE-1) > a pick tried while the preview loads changes nothing: the review and Send stay on the previewed draft
   - BroadcastComposer - the audience while a preview loads (code review R3-FE-1) > the filters are frozen while the preview loads - the picker, its chip and the voucher chips
   - BroadcastComposer - the audience while a preview loads (code review R3-FE-1) > text typed while the preview loads: the frozen field takes none, so none is dropped unseen when the review opens

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\api\types.ts` - delete the TRANSITIONAL housing_authority (Task 3.1 added it) (old_string is at lines 3278-3281 when this step runs).

   old_string:

```ts
  housing_authorities?: string[];
  /** TRANSITIONAL: the old one-string filter, still read by AudienceFilters
   *  until Task 3.3 moves it to the list and deletes this field. */
  housing_authority?: string;
```

   new_string:

```ts
  housing_authorities?: string[];
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\useComposerDraft.ts` - materialKey: the draft key covers the LIST (old_string is at line 95 when this step runs).

   old_string:

```ts
            h: input.filter.housing_authority ?? null,
```

   new_string:

```ts
            h: input.filter.housing_authorities ?? null,
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the header comment (old_string is at line 3 when this step runs).

   old_string:

```tsx
// (bedroomSize 0..4) and a HousingAuthority picker; the disabled "+ Add
```

   new_string:

```tsx
// (bedroomSize 0..4) and a "Housing authorities" multi-picker (any-of,
// matching-blast-rules D2); the disabled "+ Add
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the header comment (old_string is at line 8 when this step runs).

   old_string:

```tsx
// A live reach count + truncated warning surface the resolved audience size.
```

   new_string:

```tsx
// A caption says who the filters include (matching-blast-rules D8), and a
// live reach - the rows that will start checked - carries an incomplete-list
// suffix when the read was truncated (D7).
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the header comment (old_string is at lines 14-15 when this step runs).

   old_string:

```tsx
// a unit, shown with a "matches property" tag (overridable - a home may suit
// other sizes).
```

   new_string:

```tsx
// a unit, shown with a "matches property" tag (overridable - a home may suit
// other sizes). The composer prefills the housing authorities from the
// property too (D3) and owns that prefill; this component shows its notes:
// the property's names that are not on the organization list, and why nothing
// was filled in (a failed property load or list read).
```

6. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the org imports: the list now comes in as a prop (old_string is at lines 22-23 when this step runs).

   old_string:

```tsx
import { HOUSING_AUTHORITY_KINDS, ORG_TYPED_NOT_A_FILTER, orgListLoadError, orgListUnknown } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
```

   new_string:

```tsx
import {
  HOUSING_AUTHORITY_KINDS,
  ORG_TYPED_NOT_A_FILTER,
  orgListLoadError,
  orgListUnknown,
  type OrgListView,
} from '../orgs/orgCopy.js';
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - after the styles import (old_string is at line 33 when this step runs).

   old_string:

```tsx
import styles from './AudienceFilters.module.css';
```

   new_string:

```tsx
import styles from './AudienceFilters.module.css';

/** matching-blast-rules D8 caption: who the filters include. The middle
 *  sentence shows only while a housing authority is selected. */
const CAPTION_STATUS = 'Only tenants in Onboarding or Searching are included.';
const CAPTION_AUTHORITY =
  'While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.';
const CAPTION_BY_HAND = 'Add any other tenant by hand when you review recipients.';
/** D3: the property's accepted authorities that map to no list entry. */
const NOT_USED_PREFIX = 'Not used (not on the organization list): ';
/** D3: none of the property's authorities mapped (and none is selected). */
const NOT_LIMITED = ' This blast is not limited by housing authority.';
/** D7: the reach line's suffix while the audience read was truncated. */
const REACH_INCOMPLETE = ' - the list is incomplete';
```

8. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the props interface (old_string is at lines 50-51 when this step runs).

   old_string:

```tsx
  filter: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
```

   new_string:

```tsx
  filter: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
  /** The organization list behind the housing authorities picker. The
   *  composer reads it ONCE (useOrgList) and passes it down: its property
   *  prefill and its Preview gate read the same answer (matching-blast-rules D3). */
  orgList: OrgListView;
```

9. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the props interface (old_string is at lines 58-62 when this step runs).

   old_string:

```tsx
   *  matching chip. Undefined when not unit-scoped or nothing is recorded. */
  propertyVoucherSize?: number;
  /** The live reach estimate (resolved audience size), or undefined while the
   *  debounced estimate is pending / not yet computed. */
  reachCount?: number;
```

   new_string:

```tsx
   *  matching chip. Undefined when not unit-scoped or nothing is recorded. */
  propertyVoucherSize?: number;
  /** D3: the property's accepted authorities that map to no list entry -
   *  "Not used (not on the organization list): <names>". */
  unusedAuthorities?: readonly string[];
  /** D3: the property lists authorities and NONE of them mapped - while no
   *  authority is selected the note adds "This blast is not limited by
   *  housing authority." */
  noAuthorityMapped?: boolean;
  /** D3: why the prefill filled nothing in (a failed property load, a failed
   *  organization list read) - shown under the picker. */
  prefillNotices?: readonly string[];
  /** The live reach: how many review rows will start checked
   *  (matching-blast-rules D8), or undefined while the debounced estimate is
   *  pending / not yet computed / not computable (a rules read failed). */
  reachCount?: number;
```

10. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the props destructuring (old_string is at lines 92-95 when this step runs).

   old_string:

```tsx
export function AudienceFilters({
  filter,
  onChange,
  propertyVoucherSize,
```

   new_string:

```tsx
export function AudienceFilters({
  filter,
  onChange,
  orgList,
  propertyVoucherSize,
  unusedAuthorities = [],
  noAuthorityMapped = false,
  prefillNotices = [],
```

11. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - lines 64-66 (old_string is at lines 107-109 when this step runs).

   old_string:

```tsx
  const uid = useId();
  // The housing authority list behind the picker (spec 2026-10-06 D7).
  const orgList = useOrgList();
```

   new_string:

```tsx
  const uid = useId();
  // The housing authority list behind the picker (spec 2026-10-06 D7) is the
  // composer's `orgList` prop (matching-blast-rules D3).
  const authorities = filter.housing_authorities ?? [];
```

12. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - pickSize (old_string is at line 124 when this step runs).

   old_string:

```tsx
    if (filter.housing_authority !== undefined) next.housing_authority = filter.housing_authority;
```

   new_string:

```tsx
    if (authorities.length > 0) next.housing_authorities = authorities;
```

13. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - setAuthority (old_string is at lines 129-135 when this step runs).

   old_string:

```tsx
  /** A pick (an exact list name) or a removed chip (''): the only commits. */
  function setAuthority(name: string): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (filter.bedroomSize !== undefined) next.bedroomSize = filter.bedroomSize;
    if (name !== '') next.housing_authority = name;
    onChange(next);
  }
```

   new_string:

```tsx
  /** A pick (an exact list name, ADDED) or a removed chip: the only commits.
   *  An empty list is no housing authority filter (matching-blast-rules D2). */
  function setAuthorities(names: string[]): void {
    const next: AudienceFilter = { contact_type: 'tenant' };
    if (names.length > 0) next.housing_authorities = names;
    if (filter.bedroomSize !== undefined) next.bedroomSize = filter.bedroomSize;
    onChange(next);
  }
```

14. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the audience-base comment (old_string is at lines 149-150 when this step runs).

   old_string:

```tsx
          joins a share only as a hand-picked seed (spec 2026-10-06 D20) - so
          naming it here told the operator nothing they could act on. */}
```

   new_string:

```tsx
          joins a share only as a hand-picked seed (spec 2026-10-06 D20). Which
          tenants it reaches (Onboarding or Searching, matching-blast-rules D1)
          is the caption's job, under the filters (D8). */}
```

15. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the picker (old_string is at lines 183-198 when this step runs).

   old_string:

```tsx
      {/* Housing authority (spec 2026-10-06 D7): a picker over the stored
          list - names and spellings, NO add option. Only a pick or a removed
          chip changes the filter, so typing never recreates the draft - and
          the note under a field left holding text says so (R2-FE-6), and the
          composer holds Preview back until it is picked or cleared (R2-FE-3).
          A list that failed to load leaves this filter unsettable; the
          others work. */}
      <div className={styles.criterion}>
        <OrgPicker
          label="Housing authority"
          kinds={HOUSING_AUTHORITY_KINDS}
          entries={orgList.entries}
          loading={orgListUnknown(orgList)}
          disabled={disabled || (orgList.error && orgListUnknown(orgList) && typed.trim() === '')}
          value={filter.housing_authority ?? ''}
          onChange={setAuthority}
```

   new_string:

```tsx
      {/* Housing authorities (spec 2026-10-06 D7; matching-blast-rules D2): a
          MULTI-picker over the stored list - names and spellings, NO add
          option; a tenant matches when their housing authority is any member.
          Only a pick or a removed chip changes the filter, so typing never
          recreates the draft - and the note under a field left holding text
          says so (R2-FE-6), and the composer holds Preview back until it is
          picked or cleared (R2-FE-3). A list that failed to load leaves this
          filter unsettable; the others work. Under it: the property
          prefill's notes (D3). */}
      <div className={styles.criterion}>
        <OrgPicker
          multiple
          label="Housing authorities"
          kinds={HOUSING_AUTHORITY_KINDS}
          entries={orgList.entries}
          loading={orgListUnknown(orgList)}
          disabled={disabled || (orgList.error && orgListUnknown(orgList) && typed.trim() === '')}
          value={authorities}
          onChange={setAuthorities}
```

16. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the end of the picker block (old_string is at lines 208-211 when this step runs).

   old_string:

```tsx
          placeholder="Any housing authority"
          labelClassName={styles.criterionLabel}
        />
      </div>
```

   new_string:

```tsx
          placeholder="Any housing authority"
          labelClassName={styles.criterionLabel}
        />
        {unusedAuthorities.length > 0 ? (
          <p className={styles.matchNote}>
            {NOT_USED_PREFIX}
            {unusedAuthorities.join(', ')}
            {noAuthorityMapped && authorities.length === 0 ? NOT_LIMITED : null}
          </p>
        ) : null}
        {prefillNotices.map((notice) => (
          <p key={notice} className={styles.prefillNotice}>
            {notice}
          </p>
        ))}
      </div>
```

17. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the excluded note: the caption follows it (old_string is at lines 235-237 when this step runs).

   old_string:

```tsx
      <p className={styles.excludedNote}>
        Always excluded: <strong>opted-out</strong> - <strong>unreachable</strong>
      </p>
```

   new_string:

```tsx
      <p className={styles.excludedNote}>
        Always excluded: <strong>opted-out</strong> - <strong>unreachable</strong>
      </p>

      {/* matching-blast-rules D8: who the filters include - the middle
          sentence only while a housing authority is selected. */}
      <p className={styles.caption}>
        {authorities.length > 0
          ? `${CAPTION_STATUS} ${CAPTION_AUTHORITY} ${CAPTION_BY_HAND}`
          : `${CAPTION_STATUS} ${CAPTION_BY_HAND}`}
      </p>
```

18. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.tsx` - the truncation suffix (old_string is at lines 258-263 when this step runs). NOTE: the file holds a NON-ASCII character where old_string below shows `{{U+2014}}` (an em dash): Read those lines and put the real character in old_string in its place. new_string is pure ASCII.

   old_string:

```tsx
        {truncated ? (
          <span className={styles.truncated}>
            {' '}
            {{U+2014}} list is capped; narrow the size or housing authority for a complete audience
          </span>
        ) : null}
```

   new_string:

```tsx
        {truncated ? <span className={styles.truncated}>{REACH_INCOMPLETE}</span> : null}
```

19. Append to the END of `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\AudienceFilters.module.css`:

```css
/* matching-blast-rules D8: who the filters include (under the filters). */
.caption {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
/* matching-blast-rules D3: why the property prefill filled nothing in. */
.prefillNotice {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-warning);
}
```

20. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the imports (old_string is at line 35 when this step runs).

   old_string:

```tsx
import { ORG_FILTER_TYPED_HINT } from '../orgs/orgCopy.js';
```

   new_string:

```tsx
import { ORG_FILTER_TYPED_HINT } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
```

21. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - after the seedContact state (old_string is at line 95 when this step runs).

   old_string:

```tsx
  const [seedContact, setSeedContact] = useState<Contact | null>(null);
```

   new_string:

```tsx
  const [seedContact, setSeedContact] = useState<Contact | null>(null);
  // The housing authority list behind the filters' picker - read ONCE here
  // (one GET /api/organizations per mount), not in AudienceFilters: the
  // property prefill and the Preview gate read the same answer
  // (matching-blast-rules D3).
  const orgList = useOrgList();
```

22. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the AudienceFilters element (old_string is at lines 546-548 when this step runs).

   old_string:

```tsx
            <AudienceFilters
              filter={filter}
              onChange={onFilterChange}
```

   new_string:

```tsx
            <AudienceFilters
              filter={filter}
              onChange={onFilterChange}
              orgList={orgList}
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/AudienceFilters.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/BroadcastComposer.prefill.test.tsx
```

Expected: `Test Files  3 passed (3); Tests  79 passed (79)`. BroadcastComposer.prefill.test.tsx passes (it already mocks getOrgList).

#### Step 5 - Typecheck and lint

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

Lint the touched source (from the worktree root):

```
cd W:\tmp\matching-blast-rules; npx eslint dashboard/src/routes/broadcasts/AudienceFilters.tsx dashboard/src/routes/broadcasts/AudienceFilters.test.tsx dashboard/src/routes/broadcasts/useComposerDraft.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/api/types.ts
```

Expected: exactly the 5 pre-existing errors (BroadcastComposer.tsx: 4 x `react-hooks/set-state-in-effect`,
the `setUnit(null)`, the two `setMessage` and the `setFilter` effects; useComposerDraft.ts: 1 x
`react-hooks/refs`). Their line numbers moved by the lines this task added; nothing else may appear.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/AudienceFilters.test.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/api/types.ts dashboard/src/routes/broadcasts/useComposerDraft.ts dashboard/src/routes/broadcasts/AudienceFilters.tsx dashboard/src/routes/broadcasts/AudienceFilters.module.css dashboard/src/routes/broadcasts/BroadcastComposer.tsx
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): AudienceFilters - Housing authorities multi-picker, D8 caption, prefill notes, incomplete-list suffix; the composer owns the org list read (S3 Task 3.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Task 3.4 - authorityPrefill: map a property's authorities to list names

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/authorityPrefill.test.ts`
- `dashboard/src/routes/broadcasts/authorityPrefill.ts`

Binding 2.8 `prefillAuthorities(propertyAuthorities, list)`: each property authority through
`settleTypedOrgText(list, HOUSING_AUTHORITY_KINDS, a)` (orgCopy.ts:248, the client mirror of the
server's checkScalarWrite: the exact name, the name written differently, or a spelling exactly ONE
housing authority entry carries); property order, de-duplicated; the rest are `unused`. CONTRACT
ISSUE 1: while the list is unknown (`orgListUnknown`) it returns `{ names: [], unused: [] }` - the
composer shows the list-failed notice instead of calling every name "Not used".

#### Step 1 - Write the failing tests

1. Write `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\authorityPrefill.test.ts` with EXACTLY this content:

```ts
// authorityPrefill tests - matching-blast-rules D3: a property's accepted
// housing authorities mapped to organization-list names the way the server
// maps a filter member (its exact name, the name written differently, or a
// spelling exactly one entry carries), in the property's order,
// de-duplicated; everything else is "unused".
import { describe, expect, it } from 'vitest';
import type { OrgEntry, OrgKind } from '../../api/index.js';
import type { OrgListView } from '../orgs/orgCopy.js';
import { prefillAuthorities } from './authorityPrefill.js';

function entry(orgId: string, kind: OrgKind, name: string, spellings: string[]): OrgEntry {
  return {
    orgId,
    kind,
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}
const ATLANTA = entry('o-atl', 'housing_authority', 'Atlanta Housing Authority', ['AHA', 'Atlanta Housing']);
const AUGUSTA = entry('o-aug', 'housing_authority', 'Augusta Housing Authority', ['AHA']);
const DEKALB = entry('o-dek', 'housing_authority', 'DeKalb County Housing Authority', ['HADC']);
const HOPE = entry('o-hope', 'agency', 'Hope Atlanta', ['HOPE']);
const LIST: OrgListView = { entries: [ATLANTA, AUGUSTA, DEKALB, HOPE], loading: false, error: false };

describe('prefillAuthorities (matching-blast-rules D3)', () => {
  it('keeps an exact list name', () => {
    expect(prefillAuthorities(['DeKalb County Housing Authority'], LIST)).toEqual({
      names: ['DeKalb County Housing Authority'],
      unused: [],
    });
  });

  it('maps a spelling exactly one entry carries, and a name written differently, to the entry name', () => {
    expect(prefillAuthorities(['HADC', 'atlanta housing authority'], LIST)).toEqual({
      names: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      unused: [],
    });
  });

  it('leaves out a shared spelling, an unknown name and an agency - as unused, in the property order', () => {
    expect(prefillAuthorities(['AHA', 'Nowhere Board', 'Hope Atlanta'], LIST)).toEqual({
      names: [],
      unused: ['AHA', 'Nowhere Board', 'Hope Atlanta'],
    });
  });

  it('keeps the property order and drops duplicates and blanks', () => {
    expect(
      prefillAuthorities(
        ['HADC', 'Atlanta Housing Authority', 'DeKalb County Housing Authority', 'Nowhere', ' Nowhere ', '  '],
        LIST,
      ),
    ).toEqual({
      names: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      unused: ['Nowhere'],
    });
  });

  it('maps nothing while the list is unknown - still loading, or failed with nothing in hand', () => {
    expect(prefillAuthorities(['DeKalb County Housing Authority'], { entries: [], loading: true, error: false })).toEqual({
      names: [],
      unused: [],
    });
    expect(prefillAuthorities(['DeKalb County Housing Authority'], { entries: [], loading: false, error: true })).toEqual({
      names: [],
      unused: [],
    });
  });

  it('a property with no accepted authorities prefills nothing', () => {
    expect(prefillAuthorities([], LIST)).toEqual({ names: [], unused: [] });
  });
});
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/authorityPrefill.test.ts
```

Expected: the run FAILS (`Test Files  1 failed (1); Tests  no tests`). The module does not exist yet. The failing tests are exactly:

   - Error: Failed to resolve import "./authorityPrefill.js" from "src/routes/broadcasts/authorityPrefill.test.ts". Does the file exist?

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Write `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\authorityPrefill.ts` with EXACTLY this content:

```ts
// authorityPrefill - matching-blast-rules D3: which of a property's accepted
// housing authorities the blast composer puts in its housing authority filter.
// Each is mapped the way the server maps a filter member (app/src/lib/orgNames.ts
// checkScalarWrite): its exact list name, the name written differently, or a
// spelling exactly ONE housing authority entry carries - through
// settleTypedOrgText, the client mirror the contact and property forms' Save
// already use. Property order, de-duplicated. A name that maps to no entry (or
// to more than one, or to an agency) is `unused`: the composer shows it as
// "Not used (not on the organization list): ...". While the list is unknown
// (still loading, or failed with nothing in hand) nothing can be mapped, and
// both lists are empty - the composer says the list failed instead.
import { HOUSING_AUTHORITY_KINDS, orgListUnknown, settleTypedOrgText, type OrgListView } from '../orgs/orgCopy.js';

export function prefillAuthorities(
  propertyAuthorities: readonly string[],
  list: OrgListView,
): { names: string[]; unused: string[] } {
  if (orgListUnknown(list)) return { names: [], unused: [] };
  const names: string[] = [];
  const unused: string[] = [];
  for (const raw of propertyAuthorities) {
    const text = raw.trim();
    if (text === '') continue;
    const verdict = settleTypedOrgText(list, HOUSING_AUTHORITY_KINDS, text);
    if (verdict.status === 'resolved') {
      if (!names.includes(verdict.name)) names.push(verdict.name);
    } else if (!unused.includes(text)) {
      unused.push(text);
    }
  }
  return { names, unused };
}
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/authorityPrefill.test.ts
```

Expected: `Test Files  1 passed (1); Tests  6 passed (6)`. 

#### Step 5 - Typecheck

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/authorityPrefill.test.ts dashboard/src/routes/broadcasts/authorityPrefill.ts
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): prefillAuthorities maps a property's accepted authorities to organization list names (S3 Task 3.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Task 3.5 - BroadcastComposer: the property prefill, its ownership, the settle gate, the 422 member removal, the 503 Try again

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`
- `dashboard/src/routes/broadcasts/useComposerDraft.ts`
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`
- `dashboard/src/routes/broadcasts/BroadcastComposer.module.css`

D3, D3a, D3b, D5/D7 (503), D8 (reach). The design (S3-local):

- The prefill is DERIVED in render, never written by an effect. State holds only staff's EDITS,
  keyed to the property they belong to (`FilterEdits { unitId, authorities?, size? }`; absent = not
  edited, so the prefill shows). The filter = edits ?? prefill, memoized by CONTENT (the draft hook's
  effect re-runs on a new filter object, which would restart its debounce and discard a create in
  flight - useComposerDraft.ts:258). Value and ownership are one state and every write is a
  functional update (the lesson of docs/issues/broadcast-composer-prefill-overwrites-edit.md); with
  no effect there is no stale-effect window at all, and no new `set-state-in-effect` lint error (the
  old voucher effect's error goes away).
- The property load is kept WITH the id it was for (`UnitLoad`), so a load for another id never
  shows, a failed state belongs to its property, and the `setUnit(null)` effect goes. An AbortError
  (client.ts:125 rethrows it; StrictMode main.tsx:15 aborts the first mount's load) is neither loaded
  nor failed.
- `pickProperty` (the browse rows and the search field) resets the edits AT ONCE when the picked id
  differs from the property the edits belong to; the same id again keeps them. No confirm.
- Gate: ONLY with a property attached and the filters on (and not on a resumed `?draftId=`), Preview
  waits until the property has loaded or failed AND the org list has loaded or failed; the hint is
  the existing "Sizing the audience" line. Failure notices are passed to AudienceFilters.
- A 422 `org_not_on_list` (create or Preview) removes ONLY `body.text` (via `orgNotOnListBody`) and
  shows "<text> is no longer on the organization list, so it was removed from the filter."; the
  hook's callback now receives the ApiError. A 503 `audience_rules_unavailable` from Preview keeps
  compose and shows the 1.1 sentence with a "Try again" button that re-runs `onPreview`.
- The reach line needs no new code: an omitted `estimatedCount` already reads "Reach estimate
  unavailable" (pinned).

The old "a housing authority that left the list" describe block is REPLACED (its one-member copy and
whole-list clearing are gone); everything else in the file keeps passing, including
BroadcastComposer.prefill.test.tsx unchanged (the hand edit at the property commit survives: the
prefill never touches the message).

#### Step 1 - Write the failing tests

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the testing-library import (old_string is at line 7 when this step runs).

   old_string:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
```

   new_string:

```tsx
import { act, render, screen, waitFor, within } from '@testing-library/react';
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - the type import (old_string is at line 11 when this step runs).

   old_string:

```tsx
import type { Contact, EventStreamHandlers, UnitItem } from '../../api/index.js';
```

   new_string:

```tsx
import type { Contact, EventStreamHandlers, OrgEntry, UnitItem } from '../../api/index.js';
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - add two helpers before renderComposer (old_string is at line 73 when this step runs).

   old_string:

```tsx
function renderComposer(search = ''): ReturnType<typeof render> {
```

   new_string:

```tsx
/** A housing authority entry of the organization list. */
function orgEntry(orgId: string, name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId,
    kind: 'housing_authority',
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderComposer(search = ''): ReturnType<typeof render> {
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - replace the WHOLE "a housing authority that left the list" describe block with three describe blocks (old_string is at lines 676-744 when this step runs).

   old_string:

```tsx
// Spec 2026-10-06 D7: a picked housing authority can leave the list between
// the pick and the server's check (the draft create, or Preview).
describe('BroadcastComposer - a housing authority that left the list', () => {
  const ATLANTA = {
    orgId: 'o-atl',
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA'],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
  const GONE = 'That housing authority is no longer on the list - pick it again';
  const refused = (): ApiError =>
    new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
      error: 'org_not_on_list',
      field: 'audience_filter',
      text: 'Atlanta Housing Authority',
      candidates: [],
      close: [],
    });

  async function pickAtlanta(u: ReturnType<typeof userEvent.setup>): Promise<void> {
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await u.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
  }

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA] });
  });

  it('a refused draft create clears the pick and says so - and Preview works again', async () => {
    const u = userEvent.setup();
    createBroadcast.mockImplementation(async (body: { audience_filter?: { housing_authorities?: string[] } }) => {
      if (body.audience_filter?.housing_authorities !== undefined) throw refused();
      return { broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false };
    });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await pickAtlanta(u);
    expect(await screen.findByText(GONE, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Atlanta Housing Authority' })).not.toBeInTheDocument();
    // The cleared filter is the first draft's again: no recreate needed, and
    // the draft is not stale.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled());
    expect(createBroadcast).toHaveBeenCalledTimes(2);
    // The next filter change clears the message.
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
  });

  it('a refused Preview clears the pick, says so, and recreates the draft without it', async () => {
    const u = userEvent.setup();
    previewBroadcast.mockRejectedValue(refused());
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await pickAtlanta(u);
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled());
    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    expect(await screen.findByText(GONE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Atlanta Housing Authority' })).not.toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(3), { timeout: 4000 });
    expect(createBroadcast.mock.calls[2]?.[0]?.audience_filter).toEqual({ contact_type: 'tenant', bedroomSize: 2 });
    // Never the raw code.
    expect(screen.queryByText(/org_not_on_list/)).not.toBeInTheDocument();
  });
});
```

   new_string:

```tsx
// Spec 2026-10-06 D7, matching-blast-rules D3b: a member of the housing
// authority filter can leave the list between the pick and the server's check
// (the draft create, or Preview). THAT member alone is removed; the others
// stay, and the removal is an edit (the prefill never puts it back).
describe('BroadcastComposer - a housing authority that left the list (matching-blast-rules D3b)', () => {
  const ATLANTA = orgEntry('o-atl', 'Atlanta Housing Authority', ['AHA']);
  const DEKALB = orgEntry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
  const GONE = 'DeKalb County Housing Authority is no longer on the organization list, so it was removed from the filter.';
  const refused = (text: string): ApiError =>
    new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
      error: 'org_not_on_list',
      field: 'audience_filter',
      text,
      candidates: [],
      close: [],
    });
  const preview = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB] });
    getUnit.mockResolvedValue(
      unit({ accepted_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'] }),
    );
  });

  it('a refused draft create removes ONLY the named member, says so, and the next draft keeps the others', async () => {
    const u = userEvent.setup();
    createBroadcast.mockImplementation(async (body: { audience_filter?: { housing_authorities?: string[] } }) => {
      if (body.audience_filter?.housing_authorities?.includes('DeKalb County Housing Authority') === true) {
        throw refused('DeKalb County Housing Authority');
      }
      return { broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false };
    });
    renderComposer('?unitId=unit-0001');
    expect(await screen.findByText(GONE, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove DeKalb County Housing Authority' })).not.toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast.mock.calls.at(-1)?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
    // Never the raw code.
    expect(screen.queryByText(/org_not_on_list/)).not.toBeInTheDocument();
    // The next filter change clears the message; DeKalb stays out (an edit).
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
    await waitFor(
      () =>
        expect(createBroadcast.mock.calls.at(-1)?.[0]?.audience_filter).toEqual({
          contact_type: 'tenant',
          housing_authorities: ['Atlanta Housing Authority'],
          bedroomSize: 3,
        }),
      { timeout: 4000 },
    );
  });

  it('a refused Preview removes ONLY the named member, says so, and recreates the draft without it', async () => {
    const u = userEvent.setup();
    previewBroadcast.mockRejectedValue(refused('DeKalb County Housing Authority'));
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(createBroadcast.mock.calls[0]?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
      bedroomSize: 2,
    });
    await u.click(preview());
    expect(await screen.findByText(GONE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove DeKalb County Housing Authority' })).not.toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(createBroadcast.mock.calls[1]?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
    expect(screen.queryByText(/org_not_on_list/)).not.toBeInTheDocument();
  });
});

// matching-blast-rules D3: the composer fills the housing authorities (and the
// voucher size, D3a) from the property. The prefill BELONGS TO THE PROPERTY:
// staff edits win while it stays; a DIFFERENT property empties both filters at
// once and its prefill fills them when it loads. Preview waits for the prefill
// ONLY with a property attached and the filters on.
describe('BroadcastComposer - the property prefill (matching-blast-rules D3)', () => {
  const ATLANTA = orgEntry('o-atl', 'Atlanta Housing Authority', ['AHA']);
  const DEKALB = orgEntry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
  const preview = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });
  const lastDraftFilter = (): unknown =>
    (createBroadcast.mock.calls.at(-1)?.[0] as { audience_filter?: unknown } | undefined)?.audience_filter;

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB] });
  });

  it('fills the housing authorities from the property - exact names and unique spellings, in its order - and notes names off the list', async () => {
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['HADC', 'Atlanta Housing Authority', 'Nowhere Board'] }));
    renderComposer('?unitId=unit-0001');
    expect(await screen.findByRole('button', { name: 'Remove DeKalb County Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board')).toBeInTheDocument();
    // The caption's housing authority sentence shows while the list is non-empty.
    expect(screen.getByText(/While a housing authority is selected/)).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  it('when none of the property authorities map, says the blast is not limited by housing authority', async () => {
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Nowhere Board'] }));
    renderComposer('?unitId=unit-0001');
    expect(
      await screen.findByText(
        'Not used (not on the organization list): Nowhere Board This blast is not limited by housing authority.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('staff edits win while the property stays: a size picked before the list lands is kept, and the authorities still fill in', async () => {
    const u = userEvent.setup();
    const list = deferred<unknown>();
    getOrgList.mockReturnValue(list.promise);
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'true'));
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    await act(async () => list.resolve({ version: 1, entries: [ATLANTA, DEKALB] }));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 3,
    });
  });

  it('the same property again changes nothing; a DIFFERENT one empties both filters at once - no confirm - then its prefill fills them', async () => {
    const u = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const peach = unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    const oak = unit({
      unitId: 'u-2',
      beds: 3,
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['DeKalb County Housing Authority'],
    });
    getAllUnits.mockResolvedValue([peach, oak]);
    const oakLoad = deferred<UnitItem>();
    getUnit.mockImplementation((id: string) => (id === 'u-2' ? oakLoad.promise : Promise.resolve(peach)));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    // Staff edit both of Peachtree's prefilled filters.
    await u.click(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    await u.click(screen.getByRole('button', { name: /^4\+ BR/ }));
    // The same property again: the edits stay.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await screen.findByRole('combobox', { name: 'Housing authorities' });
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Remove Atlanta Housing Authority' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^4\+ BR/ })).toHaveAttribute('aria-pressed', 'true');
    // A DIFFERENT property: both filters are empty at once, before it loads.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    const chips = within(await screen.findByRole('group', { name: 'Voucher size' })).getAllByRole('button');
    for (const chip of chips) expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    // ...and its prefill fills them when it loads.
    await act(async () => oakLoad.resolve(oak));
    expect(await screen.findByRole('button', { name: 'Remove DeKalb County Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority'],
      bedroomSize: 3,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('with a property and the filters on, Preview waits for the organization list - the draft alone does not enable it', async () => {
    const list = deferred<unknown>();
    getOrgList.mockReturnValue(list.promise);
    renderComposer('?unitId=unit-0001');
    // The draft landed (its reach shows) but the prefill has not settled.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Reaches\s*5\s*recipients/), {
      timeout: 4000,
    });
    expect(preview()).toBeDisabled();
    expect(screen.getByText(/Sizing the audience/)).toBeInTheDocument();
    await act(async () => list.resolve({ version: 1, entries: [ATLANTA] }));
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
  });

  it('a failed property load settles the prefill with its notice - Preview works once a message is written', async () => {
    const u = userEvent.setup();
    getUnit.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    renderComposer('?unitId=unit-0001');
    expect(
      await screen.findByText(
        "Couldn't load the property, so its housing authorities and voucher size were not filled in.",
      ),
    ).toBeInTheDocument();
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({ contact_type: 'tenant' });
  });

  it('a failed organization list read settles the prefill with its notice; the voucher size still fills in', async () => {
    getOrgList.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    expect(
      await screen.findByText(
        "Couldn't load the organization list, so housing authorities were not filled in from the property.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('an ABORTED property load is neither loaded nor failed: no notice, and Preview keeps waiting', async () => {
    const u = userEvent.setup();
    getUnit.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    renderComposer('?unitId=unit-0001');
    await u.type(await screen.findByLabelText('Message'), 'Hello there');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Reaches\s*5\s*recipients/), {
      timeout: 4000,
    });
    expect(preview()).toBeDisabled();
    expect(screen.getByText(/Sizing the audience/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the property/)).not.toBeInTheDocument();
  });

  it('(PIN) a resumed draft is never gated: the list never loads, and Preview still works once a message is written', async () => {
    const u = userEvent.setup();
    getOrgList.mockReturnValue(new Promise(() => {}));
    renderComposer('?draftId=bcast_resume');
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
  });

  it('(PIN) a seeds-only send is never gated: the list never loads, and Preview still works', async () => {
    getOrgList.mockReturnValue(new Promise(() => {}));
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
  });
});

// matching-blast-rules D7, D8: the rules reads behind a filter draft's preview
// and reach.
describe('BroadcastComposer - tour and Not interested reads (matching-blast-rules D7, D8)', () => {
  it('a 503 audience_rules_unavailable keeps compose with the message, and Try again re-runs the preview', async () => {
    const u = userEvent.setup();
    previewBroadcast
      .mockRejectedValueOnce(
        new ApiError(503, 'audience_rules_unavailable', 'audience_rules_unavailable', {
          error: 'audience_rules_unavailable',
        }),
      )
      .mockResolvedValueOnce({
        count: 1,
        truncated: false,
        candidates: [
          {
            contactId: 'c1',
            firstName: 'Tasha',
            phone: '+14040000001',
            alreadySentThisProperty: false,
            has_consent: true,
            seeded: false,
            declinedThisProperty: false,
            checkedByDefault: true,
          },
        ],
        priorRecipientContactIds: [],
        seedContactIds: [],
        unresolvedSeedIds: [],
        declinedContactIds: [],
        tourHolds: [],
      });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(), {
      timeout: 4000,
    });
    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.",
    );
    // Still on compose, never the raw code.
    expect(screen.queryByRole('heading', { name: 'Review recipients' })).not.toBeInTheDocument();
    expect(screen.queryByText(/audience_rules_unavailable/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).not.toHaveValue('');
    await u.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(previewBroadcast).toHaveBeenCalledTimes(2);
  });

  it('(PIN) a draft whose reach could not be computed (no estimatedCount) reads "Reach estimate unavailable"', async () => {
    createBroadcast.mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', truncated: false });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(), {
      timeout: 4000,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reach estimate unavailable');
  });
});
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/BroadcastComposer.prefill.test.tsx
```

Expected: the run FAILS (`Test Files  1 failed | 1 passed (2); Tests  11 failed | 54 passed (65)`). The three (PIN) cases pass already (a resumed draft and a seeds-only send are not gated today; an omitted estimatedCount already reads "Reach estimate unavailable"). The failing tests are exactly:

   - BroadcastComposer - a housing authority that left the list (matching-blast-rules D3b) > a refused draft create removes ONLY the named member, says so, and the next draft keeps the others
   - BroadcastComposer - a housing authority that left the list (matching-blast-rules D3b) > a refused Preview removes ONLY the named member, says so, and recreates the draft without it
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > fills the housing authorities from the property - exact names and unique spellings, in its order - and notes names off the list
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > when none of the property authorities map, says the blast is not limited by housing authority
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > staff edits win while the property stays: a size picked before the list lands is kept, and the authorities still fill in
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > the same property again changes nothing; a DIFFERENT one empties both filters at once - no confirm - then its prefill fills them
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > with a property and the filters on, Preview waits for the organization list - the draft alone does not enable it
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > a failed property load settles the prefill with its notice - Preview works once a message is written
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > a failed organization list read settles the prefill with its notice; the voucher size still fills in
   - BroadcastComposer - the property prefill (matching-blast-rules D3) > an ABORTED property load is neither loaded nor failed: no notice, and Preview keeps waiting
   - BroadcastComposer - tour and Not interested reads (matching-blast-rules D7, D8) > a 503 audience_rules_unavailable keeps compose with the message, and Try again re-runs the preview

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\useComposerDraft.ts` - the onOrgNotOnList input (old_string is at lines 45-49 when this step runs).

   old_string:

```ts
  /** Called when a (re)create is refused 422 org_not_on_list - the picked
   *  housing authority left the list (spec 2026-10-06 D7). The composer clears
   *  the pick and owns the message, so this draft is NOT marked stale: the
   *  cleared filter either matches the current draft again or recreates it. */
  onOrgNotOnList?: () => void;
```

   new_string:

```ts
  /** Called when a (re)create is refused 422 org_not_on_list - a member of
   *  the housing authority filter left the list (spec 2026-10-06 D7). The
   *  composer reads the refused member from the error's body, removes it and
   *  owns the message (matching-blast-rules D3b), so this draft is NOT marked
   *  stale: the changed filter either matches the current draft again or
   *  recreates it. */
  onOrgNotOnList?: (err: ApiError) => void;
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\useComposerDraft.ts` - the reachCount doc (old_string is at line 57 when this step runs).

   old_string:

```ts
  /** The live reach estimate from the latest draft, or undefined when none. */
```

   new_string:

```ts
  /** The live reach from the latest draft - how many review rows will start
   *  checked (matching-blast-rules D8) - or undefined when none, or when the
   *  server could not compute it (estimatedCount omitted: a rules read failed). */
```

3. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\useComposerDraft.ts` - the 422 branch (old_string is at lines 237-239 when this step runs).

   old_string:

```ts
            // Spec 2026-10-06 D7: the composer clears the pick and says so.
            setError(null);
            onOrgNotOnList();
```

   new_string:

```ts
            // Spec 2026-10-06 D7, matching-blast-rules D3b: the composer removes
            // the refused member and says so.
            setError(null);
            onOrgNotOnList(err);
```

4. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the header comment (old_string is at lines 6-7 when this step runs). NOTE: the file holds a NON-ASCII character where old_string below shows `{{U+2014}}` (an em dash): Read those lines and put the real character in old_string in its place. new_string is pure ASCII.

   old_string:

```tsx
//   1. COMPOSE {{U+2014}} AudienceFilters (voucher size + housing authority, pre-filled
//      from the property) + MessageEditor
```

   new_string:

```tsx
//   1. COMPOSE - AudienceFilters (voucher size + housing authorities, pre-filled
//      from the property and owned by it - matching-blast-rules D3) + MessageEditor
```

5. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the imports (old_string is at lines 35-39 when this step runs).

   old_string:

```tsx
import { ORG_FILTER_TYPED_HINT } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { acceptedVoucherSizes, shortAddress } from '../listing/listingFormat.js';
import { AudienceFilters } from './AudienceFilters.js';
```

   new_string:

```tsx
import { ORG_FILTER_TYPED_HINT, orgListUnknown, orgNotOnListBody } from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { UnitSearchField, type UnitSearchValue } from '../contact/UnitSearchField.js';
import { acceptedVoucherSizes, authoritiesOf, shortAddress } from '../listing/listingFormat.js';
import { AudienceFilters } from './AudienceFilters.js';
import { prefillAuthorities } from './authorityPrefill.js';
```

6. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the 422 copy constant (old_string is at lines 62-63 when this step runs).

   old_string:

```tsx
/** R2 ruling F1's copy for both composer 422s. */
const AUTHORITY_LEFT_THE_LIST = 'That housing authority is no longer on the list - pick it again';
```

   new_string:

```tsx
/** matching-blast-rules D3b: a 422 org_not_on_list from the draft create or
 *  from Preview named ONE member of the housing authority filter; that member
 *  alone is removed. */
function authorityLeftTheList(text: string): string {
  return `${text} is no longer on the organization list, so it was removed from the filter.`;
}

/** D3: the property did not load, so nothing was prefilled from it. */
const PROPERTY_LOAD_FAILED =
  "Couldn't load the property, so its housing authorities and voucher size were not filled in.";
/** D3: the organization list did not load, so no authority was prefilled. */
const ORG_LIST_FAILED =
  "Couldn't load the organization list, so housing authorities were not filled in from the property.";
/** D7: a filter draft's Preview was refused 503 audience_rules_unavailable. */
const RULES_UNAVAILABLE =
  "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.";

/** D3: the property load, kept with the id it was for - a failed state
 *  belongs to that property and clears when it loads or the property changes. */
type UnitLoad = { unitId: string; status: 'loaded'; unit: UnitItem } | { unitId: string; status: 'failed' };

/** D3: staff's edits to the audience filters, OWNED by one property. An
 *  absent field is not edited (the property's prefill shows); a present one
 *  is staff's, and the prefill never overwrites it while the property stays.
 *  Value and ownership live in this ONE state and every write is a functional
 *  update (docs/issues/broadcast-composer-prefill-overwrites-edit.md). */
interface FilterEdits {
  /** The property these edits belong to (null: none - a resumed draft). */
  unitId: string | null;
  /** Staff's housing authority list ([] = staff emptied it). */
  authorities?: string[];
  /** Staff's voucher size (null = staff cleared it). */
  size?: number | null;
}

/** No authority prefill (no property loaded) - ONE shared value, so the
 *  derived filter keeps its identity. */
const NO_AUTHORITY_PREFILL: { names: string[]; unused: string[] } = { names: [], unused: [] };
```

7. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the unit and filter state: both are DERIVED now (old_string is at lines 115-116 when this step runs).

   old_string:

```tsx
  const [unit, setUnit] = useState<UnitItem | null>(null);
  const [filter, setFilter] = useState<AudienceFilter>({ contact_type: 'tenant' });
```

   new_string:

```tsx
  const [unitLoad, setUnitLoad] = useState<UnitLoad | null>(null);
```

8. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - after resolvedMode: the derived property, prefill, filter and gate (old_string is at line 157 when this step runs).

   old_string:

```tsx
  const resolvedMode = seedContactIds.length === 1 && !audienceEnabled;
```

   new_string:

```tsx
  const resolvedMode = seedContactIds.length === 1 && !audienceEnabled;

  // matching-blast-rules D3: the property on screen and its load - a load for
  // another id (the previous pick, or one still in flight) is not this one's.
  const loaded = unitLoad !== null && unitLoad.unitId === effectiveUnitId ? unitLoad : null;
  const unit = loaded !== null && loaded.status === 'loaded' ? loaded.unit : null;

  // D3 prefill - DERIVED, never written by an effect: the property's accepted
  // authorities mapped to list names (authorityPrefill), and the voucher size
  // it takes (acceptedVoucherSizes, the one reader; the filter holds ONE size
  // until tracker #12, so the first, as the public flyer does - D3a).
  const { entries: orgEntries, loading: orgLoading, error: orgError } = orgList;
  const authorityPrefill = useMemo(
    () =>
      unit === null
        ? NO_AUTHORITY_PREFILL
        : prefillAuthorities(authoritiesOf(unit), { entries: orgEntries, loading: orgLoading, error: orgError }),
    [unit, orgEntries, orgLoading, orgError],
  );
  const propertyVoucherSize = unit === null ? undefined : acceptedVoucherSizes(unit)[0];

  // D3 ownership: staff's edits for THIS property win; a filter not edited
  // shows the prefill. A DIFFERENT property resets the edits (pickProperty).
  const [edits, setEdits] = useState<FilterEdits>(() => ({ unitId: unitId ?? null }));
  const unitKey = effectiveUnitId ?? null;
  const ownEdits: FilterEdits = edits.unitId === unitKey ? edits : { unitId: unitKey };
  const authorities = ownEdits.authorities ?? authorityPrefill.names;
  const size = ownEdits.size !== undefined ? (ownEdits.size ?? undefined) : propertyVoucherSize;
  // The filter keeps its identity while its content stays (the draft hook
  // re-runs on a new filter object): keyed on the names joined by a line
  // break, which no organization name can hold.
  const authoritiesKey = authorities.join('\n');
  const filter = useMemo<AudienceFilter>(() => {
    const names = authoritiesKey === '' ? [] : authoritiesKey.split('\n');
    return {
      contact_type: 'tenant',
      ...(names.length > 0 && { housing_authorities: names }),
      ...(size !== undefined && { bedroomSize: size }),
    };
  }, [authoritiesKey, size]);

  // D3 timing: ONLY with a property attached and the filters on (never on a
  // resumed draft, which has no property here) does Preview wait for the
  // prefill to settle - the property loaded or failed, AND the organization
  // list loaded or failed. An ABORTED load is neither (the load effect).
  const prefillGated = audienceEnabled && effectiveUnitId !== undefined && resumeDraftId === undefined;
  const prefillPending = prefillGated && (loaded === null || orgLoading);
  const prefillNotices: string[] = [];
  if (prefillGated && loaded !== null && loaded.status === 'failed') prefillNotices.push(PROPERTY_LOAD_FAILED);
  if (prefillGated && orgError && orgListUnknown(orgList)) prefillNotices.push(ORG_LIST_FAILED);
```

9. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - after the previewError state (old_string is at line 213 when this step runs).

   old_string:

```tsx
  const [previewError, setPreviewError] = useState<string | null>(null);
```

   new_string:

```tsx
  const [previewError, setPreviewError] = useState<string | null>(null);
  // matching-blast-rules D7: the last Preview was refused 503
  // audience_rules_unavailable - compose says why, with Try again.
  const [rulesUnavailable, setRulesUnavailable] = useState(false);
```

10. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the 422 handling and onFilterChange (old_string is at lines 218-235 when this step runs).

   old_string:

```tsx
  // Spec 2026-10-06 D7: a 422 org_not_on_list from the draft create or from
  // Preview means the picked housing authority left the list. The pick is
  // cleared and this message stays under the picker until the operator next
  // changes a filter (a recreate clears the draft hook's own error, so the
  // composer owns this one).
  const [authorityNotice, setAuthorityNotice] = useState<string | null>(null);
  function rejectAuthorityPick(): void {
    setFilter((prev) => {
      const next: AudienceFilter = { contact_type: 'tenant' };
      if (prev.bedroomSize !== undefined) next.bedroomSize = prev.bedroomSize;
      return next;
    });
    setAuthorityNotice(AUTHORITY_LEFT_THE_LIST);
  }
  function onFilterChange(next: AudienceFilter): void {
    setAuthorityNotice(null);
    setFilter(next);
  }
```

   new_string:

```tsx
  // Spec 2026-10-06 D7, matching-blast-rules D3b: a 422 org_not_on_list from
  // the draft create or from Preview names the member of the housing
  // authority filter that left the list. THAT member alone is removed (an
  // edit: the prefill never puts it back while the property stays) and this
  // message stays under the picker until the operator next changes a filter
  // (a recreate clears the draft hook's own error, so the composer owns this
  // one).
  const [authorityNotice, setAuthorityNotice] = useState<string | null>(null);
  function rejectAuthority(text: string | null): void {
    const prefillNames = authorityPrefill.names;
    setEdits((prev) => {
      const own: FilterEdits = prev.unitId === unitKey ? prev : { unitId: unitKey };
      const current = own.authorities ?? prefillNames;
      const kept = text === null ? current : current.filter((name) => name.trim() !== text.trim());
      // A refusal that names no member we hold (never expected) empties the
      // list, so the composer is never left holding a filter the server refuses.
      return { ...own, authorities: kept.length < current.length ? kept : [] };
    });
    setAuthorityNotice(authorityLeftTheList(text ?? 'That housing authority'));
  }
  /** A filter change from AudienceFilters: each filter that differs from the
   *  one on screen becomes staff's edit for this property (D3). */
  function onFilterChange(next: AudienceFilter): void {
    setAuthorityNotice(null);
    const nextAuthorities = next.housing_authorities ?? [];
    const nextSize = next.bedroomSize ?? null;
    const authoritiesEdited = nextAuthorities.join('\n') !== authoritiesKey;
    const sizeEdited = nextSize !== (size ?? null);
    if (!authoritiesEdited && !sizeEdited) return;
    setEdits((prev) => {
      const own: FilterEdits = prev.unitId === unitKey ? prev : { unitId: unitKey };
      return {
        ...own,
        ...(authoritiesEdited && { authorities: nextAuthorities }),
        ...(sizeEdited && { size: nextSize }),
      };
    });
  }
```

11. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the draft hook input (old_string is at line 273 when this step runs).

   old_string:

```tsx
    onOrgNotOnList: rejectAuthorityPick,
```

   new_string:

```tsx
    onOrgNotOnList: (err) => rejectAuthority(orgNotOnListBody(err)?.text ?? null),
```

12. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the property load effect (old_string is at lines 315-329 when this step runs). NOTE: the file holds a NON-ASCII character where old_string below shows `{{U+2014}}` (an em dash): Read those lines and put the real character in old_string in its place. new_string is pure ASCII.

   old_string:

```tsx
  // Load the property (address -> property label; its voucher size feeds the
  // pre-fill below).
  useEffect(() => {
    if (effectiveUnitId === undefined) {
      setUnit(null); // picker cleared - drop the stale property context
      return;
    }
    const controller = new AbortController();
    getUnit(effectiveUnitId, controller.signal)
      .then(setUnit)
      .catch(() => {
        /* property load failed {{U+2014}} compose still works without the pre-fill */
      });
    return () => controller.abort();
  }, [effectiveUnitId]);
```

   new_string:

```tsx
  // Load the property (address -> property label; its authorities and voucher
  // size feed the prefill above). The result is kept WITH the id it was for,
  // so a stale property never shows for a new pick and no reset is needed when
  // the picker clears.
  useEffect(() => {
    if (effectiveUnitId === undefined) return;
    const id = effectiveUnitId;
    const controller = new AbortController();
    getUnit(id, controller.signal)
      .then((loadedUnit) => setUnitLoad({ unitId: id, status: 'loaded', unit: loadedUnit }))
      .catch((err: unknown) => {
        // matching-blast-rules D3: an ABORTED load (an unmount, a property
        // change, StrictMode's double mount - api/client.ts rethrows the
        // AbortError) is neither loaded nor failed: the gate keeps waiting and
        // no notice shows. A real failure settles the prefill with its notice;
        // compose still works without it.
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setUnitLoad({ unitId: id, status: 'failed' });
      });
    return () => controller.abort();
  }, [effectiveUnitId]);
```

13. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - DELETE the voucher-size prefill effect: the derived prefill above replaces it (D3a) (old_string is at lines 377-393 when this step runs).

   old_string:

```tsx
  // The voucher size the property takes - its recorded size, else its beds
  // (acceptedVoucherSizes, the one reader). The audience filter holds ONE size;
  // only the demo seed can record a list until tracker #12, so take the first,
  // as the public flyer does.
  const propertyVoucherSize = unit === null ? undefined : acceptedVoucherSizes(unit)[0];

  // Pre-fill the voucher size the property takes (overridable), only while the
  // filters are ACTIVE (hidden filters have no state to pre-fill) and only when
  // the operator hasn't already set a size. Enabling the filters with a
  // property attached applies the pre-fill at that moment.
  useEffect(() => {
    if (!audienceEnabled || unit === null) return;
    const size = acceptedVoucherSizes(unit)[0];
    if (size === undefined) return;
    setFilter((prev) => (prev.bedroomSize === undefined ? { ...prev, bedroomSize: size } : prev));
  }, [audienceEnabled, unit]);

```

   new_string: the EMPTY string (delete the block).

14. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - onChangeProperty: pickProperty goes before it (old_string is at lines 433-436 when this step runs).

   old_string:

```tsx
  // "Change property" (picked entries only) - back to the property step. An
  // edited message was written for THIS property, so confirm the discard; an
  // untouched prefill just refills for the next pick.
  function onChangeProperty(): void {
```

   new_string:

```tsx
  /** The property step's pick (a browse row, or the search field - which also
   *  reports plain typing, with no unitId). matching-blast-rules D3: a
   *  DIFFERENT property empties both filters at once - its prefill fills them
   *  when it loads, and the old property's edits are dropped, with no confirm
   *  (they were chosen for the old property, as the message was); the same
   *  property again changes nothing. A failed load of the picked property is
   *  retried by the pick, so the gate waits for the new attempt. */
  function pickProperty(next: UnitSearchValue): void {
    setUnitPick(next);
    const id = next.unitId;
    if (id === undefined) return;
    if (edits.unitId !== id) setAuthorityNotice(null);
    setEdits((prev) => (prev.unitId === id ? prev : { unitId: id }));
    setUnitLoad((prev) => (prev !== null && prev.unitId === id && prev.status === 'failed' ? null : prev));
  }

  // "Change property" (picked entries only) - back to the property step. An
  // edited message was written for THIS property, so confirm the discard; an
  // untouched prefill just refills for the next pick. The filters wait for
  // the next pick (pickProperty): the same property keeps them.
  function onChangeProperty(): void {
```

15. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - onPreview start (old_string is at lines 481-483 when this step runs).

   old_string:

```tsx
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
```

   new_string:

```tsx
    setPreviewBusy(true);
    setPreviewError(null);
    setRulesUnavailable(false);
    setPreview(null);
```

16. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - onPreview catch (old_string is at lines 490-493 when this step runs).

   old_string:

```tsx
        // Spec D7: the stored filter's housing authority left the list after
        // the draft was made - the same answer as the create's.
        rejectAuthorityPick();
      } else if (err instanceof ApiError) {
```

   new_string:

```tsx
        // Spec D7, matching-blast-rules D3b: a member of the stored filter
        // left the list after the draft was made - the create's answer.
        rejectAuthority(orgNotOnListBody(err)?.text ?? null);
      } else if (err instanceof ApiError && err.status === 503 && err.code === 'audience_rules_unavailable') {
        // matching-blast-rules D5, D7: the tours or decline read failed, so no
        // list is served (it would check people the rules leave out). Compose
        // stays, with Try again.
        setRulesUnavailable(true);
      } else if (err instanceof ApiError) {
```

17. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the canPreview comment (old_string is at lines 513-514 when this step runs).

   old_string:

```tsx
  // And while the housing authority filter holds typed text (R2-FE-3, above).
  const canPreview =
```

   new_string:

```tsx
  // And while the housing authority filter holds typed text (R2-FE-3, above),
  // and while the property prefill settles (matching-blast-rules D3).
  const canPreview =
```

18. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - canPreview (old_string is at lines 520-521 when this step runs).

   old_string:

```tsx
    !draft.stale &&
    !authorityTyped;
```

   new_string:

```tsx
    !draft.stale &&
    !authorityTyped &&
    !prefillPending;
```

19. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the property search field (old_string is at lines 572-573 when this step runs).

   old_string:

```tsx
            onChange={setUnitPick}
            candidates={unitCandidates}
```

   new_string:

```tsx
            onChange={pickProperty}
            candidates={unitCandidates}
```

20. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the browse rows (old_string is at lines 583-585 when this step runs).

   old_string:

```tsx
                onClick={() =>
                  setUnitPick({ label: shortAddress(u.address, u.unitId), unitId: u.unitId })
                }
```

   new_string:

```tsx
                onClick={() =>
                  pickProperty({ label: shortAddress(u.address, u.unitId), unitId: u.unitId })
                }
```

21. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the AudienceFilters element (old_string is at line 675 when this step runs).

   old_string:

```tsx
              {...(propertyVoucherSize !== undefined && { propertyVoucherSize })}
```

   new_string:

```tsx
              {...(propertyVoucherSize !== undefined && { propertyVoucherSize })}
              unusedAuthorities={authorityPrefill.unused}
              noAuthorityMapped={authorityPrefill.names.length === 0 && authorityPrefill.unused.length > 0}
              prefillNotices={prefillNotices}
```

22. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the compose alerts (old_string is at lines 713-717 when this step runs).

   old_string:

```tsx
      {previewError !== null ? (
        <p className={styles.error} role="alert">
          {previewError}
        </p>
      ) : null}
```

   new_string:

```tsx
      {previewError !== null ? (
        <p className={styles.error} role="alert">
          {previewError}
        </p>
      ) : null}
      {rulesUnavailable ? (
        <p className={styles.error} role="alert">
          {RULES_UNAVAILABLE}{' '}
          <button
            type="button"
            className={styles.retryBtn}
            disabled={!canPreview || previewBusy}
            onClick={() => void onPreview()}
          >
            Try again
          </button>
        </p>
      ) : null}
```

23. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the disabled-Preview hint: a settling prefill reads "Sizing the audience" (old_string is at line 756 when this step runs).

   old_string:

```tsx
          ) : draft.reachPending || draft.draftId === null ? (
```

   new_string:

```tsx
          ) : draft.reachPending || draft.draftId === null || prefillPending ? (
```

24. Append to the END of `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.module.css`:

```css

/* matching-blast-rules D7: Try again after a 503 audience_rules_unavailable. */
.retryBtn {
  border: none;
  background: none;
  padding: 0;
  color: var(--c-brand);
  font-size: var(--fs-sm);
  text-decoration: underline;
  cursor: pointer;
}
.retryBtn:disabled {
  cursor: default;
  opacity: 0.5;
}
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx src/routes/broadcasts/BroadcastComposer.prefill.test.tsx
```

Expected: `Test Files  2 passed (2); Tests  65 passed (65)`. BroadcastComposer.prefill.test.tsx passes unchanged.

#### Step 5 - Typecheck and lint

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

Lint the touched source (from the worktree root; gate 5 is a baseline ratchet):

```
cd W:\tmp\matching-blast-rules; npx eslint dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/useComposerDraft.ts dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: exactly 3 errors, ALL pre-existing on main: two `react-hooks/set-state-in-effect` in
BroadcastComposer.tsx (the two MESSAGE prefill effects, `setMessage(...)` - main lines 230 and 249)
and one `react-hooks/refs` in useComposerDraft.ts (`disposableRef.current = ...`, main line 140).
Main had FOUR in BroadcastComposer.tsx; the `setUnit(null)` effect (main :205) and the voucher
prefill effect (main :271) are gone, so this task REMOVES two baseline errors and adds none. Any
other error is yours - fix it before committing.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/routes/broadcasts/useComposerDraft.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.module.css
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): composer prefills housing authorities and voucher size from the property (owned by the property, reset on a different property), waits for the prefill to settle, removes only the refused authority on a 422, Try again on a 503 (S3 Task 3.5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Task 3.6 - The property picker offers Available properties only

**Files** (every path is under `W:\tmp\matching-blast-rules`):

- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`

D9: the composer keeps only `status === 'available'` from `getAllUnits` (the browse list and the
search field both read `unitCandidates`), on the bare entry and the `?contactId=` entry alike. A
`?unitId=` entry never reads the candidates, so its property keeps any status with today's banner and
Make Available dialog (pinned). With no Available property the picker reads the 1.1 empty state
(it replaces "No properties yet - add one from the Properties page.").

#### Step 1 - Write the failing tests

1. Append to the END of `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.test.tsx` - a new describe block at the end of the file:

```tsx

// matching-blast-rules D9: the property picker offers only Available
// properties, on every entry that shows it (the bare Matching entry and the
// ?contactId= entry). A ?unitId= preselection (the property page's "+ Send")
// keeps its property whatever the status, with the banner and the Make
// Available dialog.
describe('BroadcastComposer - Available properties only (matching-blast-rules D9)', () => {
  const peach = unit({
    unitId: 'u-1',
    address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });
  const oak = unit({
    unitId: 'u-2',
    status: 'on_hold',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });
  const elm = unit({
    unitId: 'u-3',
    status: 'setup',
    address: { line1: '5 Elm St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });

  it('the bare entry lists and searches only Available properties', async () => {
    const u = userEvent.setup();
    getAllUnits.mockResolvedValue([peach, oak, elm]);
    renderComposer();
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /5 Elm St/ })).not.toBeInTheDocument();
    // The search finds nothing that is not Available either.
    await u.type(screen.getByRole('combobox', { name: 'Property' }), 'Oak');
    expect(screen.queryByRole('option', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.getByText('No properties match that search - clear it to browse them all.')).toBeInTheDocument();
  });

  it('the ?contactId= entry (a tenant or caseworker page) lists only Available properties too', async () => {
    getAllUnits.mockResolvedValue([peach, oak, elm]);
    renderComposer('?contactId=c-seed');
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /5 Elm St/ })).not.toBeInTheDocument();
  });

  it('with no Available property the picker says why', async () => {
    getAllUnits.mockResolvedValue([oak, elm]);
    renderComposer();
    await waitFor(() => expect(getAllUnits).toHaveBeenCalled());
    expect(
      await screen.findByText('No Available properties. A property must be Available to send.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
  });

  it('(PIN) a ?unitId= preselection keeps a non-Available property, with the banner', async () => {
    getUnit.mockResolvedValue(oak);
    renderComposer('?unitId=u-2');
    expect(await screen.findByText(/flyer link won't work/)).toHaveTextContent(/This property is On hold/);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(getAllUnits).not.toHaveBeenCalled();
  });
});
```


#### Step 2 - Run them RED

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: the run FAILS (`Test Files  1 failed (1); Tests  3 failed | 64 passed (67)`). The (PIN) ?unitId= case passes already. The failing tests are exactly:

   - BroadcastComposer - Available properties only (matching-blast-rules D9) > the bare entry lists and searches only Available properties
   - BroadcastComposer - Available properties only (matching-blast-rules D9) > the ?contactId= entry (a tenant or caseworker page) lists only Available properties too
   - BroadcastComposer - Available properties only (matching-blast-rules D9) > with no Available property the picker says why

If anything else fails, stop: an anchor or a fixture was applied wrongly.

#### Step 3 - Implement

1. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the picker candidates load (old_string is at lines 302-308 when this step runs).

   old_string:

```tsx
  // unbrowsable, but unfindable by search too, since the search filters this
  // array client-side.
  useEffect(() => {
    if (unitId !== undefined) return; // fixed by the entry point
    const controller = new AbortController();
    getAllUnits({}, controller.signal)
      .then(setUnitCandidates)
```

   new_string:

```tsx
  // unbrowsable, but unfindable by search too, since the search filters this
  // array client-side. matching-blast-rules D9: only AVAILABLE properties are
  // offered, on the bare entry and the ?contactId= entry alike (every send
  // requires Available); a ?unitId= preselection keeps any status, with the
  // banner and the Make Available dialog.
  useEffect(() => {
    if (unitId !== undefined) return; // fixed by the entry point
    const controller = new AbortController();
    getAllUnits({}, controller.signal)
      .then((units) => setUnitCandidates(units.filter((u) => u.status === 'available')))
```

2. Edit `W:\tmp\matching-blast-rules\dashboard\src\routes\broadcasts\BroadcastComposer.tsx` - the picker empty state (old_string is at line 614 when this step runs).

   old_string:

```tsx
          <p className={styles.pickerHint}>No properties yet - add one from the Properties page.</p>
```

   new_string:

```tsx
          <p className={styles.pickerHint}>No Available properties. A property must be Available to send.</p>
```


#### Step 4 - Run them GREEN

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: `Test Files  1 passed (1); Tests  67 passed (67)`. 

#### Step 5 - Typecheck and lint

```
cd W:\tmp\matching-blast-rules\dashboard; npm run typecheck
```

Expected: exit 0, no `error TS` lines.

Lint, then run the whole broadcasts folder once (every S3 file together):

```
cd W:\tmp\matching-blast-rules; npx eslint dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx
```

Expected: exactly the 2 pre-existing `react-hooks/set-state-in-effect` errors (the two `setMessage`
prefill effects), nothing else.

```
cd W:\tmp\matching-blast-rules\dashboard; npx vitest run src/routes/broadcasts/
```

Expected: `Test Files  16 passed (16); Tests  306 passed (306)`.

#### Step 6 - Commit

```
git -C W:\tmp\matching-blast-rules status
```

Read the output: only the paths below are modified/new (anything else is someone else's work - leave it). Then:

```
Test-Path 'W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD'
```

It must print `False` (no merge in progress). Then stage EXACTLY these paths and commit:

```
git -C W:\tmp\matching-blast-rules add dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/routes/broadcasts/BroadcastComposer.tsx
```

```
git -C W:\tmp\matching-blast-rules commit -m @'
feat(dashboard): the Matching property picker offers Available properties only (S3 Task 3.6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
'@
```

### Spec coverage map

| Spec item (dashboard side) | Where |
|---|---|
| D2 `housing_authorities` list on the wire; the dashboard reads ONE shape, no normalizer | 3.1 (types, `audienceSummary`), 3.3 (picker sends the list, draft key covers it, transitional field deleted) |
| D3 composer reads the org list (moved up) | 3.3 (prop + one `useOrgList` in the composer) |
| D3 prefill: exact names / unique spellings, property order, de-duplicated; off-list names "Not used ..."; none mapped "This blast is not limited ..." | 3.4 (`prefillAuthorities`), 3.3 (notes rendered), 3.5 (fed; integration tests) |
| D3 `OrgPicker multiple` labeled "Housing authorities"; staff remove/add members | 3.3 |
| D3 ownership: edits never overwritten while the property stays; a DIFFERENT property empties both filters at once, prefills on load, no confirm; the same property changes nothing | 3.5 (`FilterEdits`, `pickProperty`; tests "staff edits win ...", "the same property again ... a DIFFERENT one ...") |
| D3 timing: gate ONLY with a property + filters on; property loaded-or-failed AND list loaded-or-failed; failure notices; aborted = neither; resumed draft and seeds-only never gated | 3.5 (`prefillGated` / `prefillPending`, `UnitLoad`; five tests + two PINs) |
| D3a voucher size: first accepted size, same ownership rule | 3.5 (derived `propertyVoucherSize`; old effect deleted; covered by the ownership tests and the existing voucher tests) |
| D3b a 422 removes ONLY the named member, new copy (create and Preview) | 3.5 (`rejectAuthority`, `onOrgNotOnList(err)`; two tests) |
| D4 / D7 tour labels for every kind, with and without a date (`shortDate`) | 3.2 (`tourHoldLabel` + tests) |
| D5 rows start at the server `checkedByDefault`; Select all re-applies it; the client no longer computes the rule | 3.2 (`defaultChecked` deleted; tests "a row starts as the server ..." and "a held row ...") |
| D5 hand pick: added or PROMOTED by Add a tenant takes `checkedByDefault = hasConsent`; RecipientPreview.test.tsx original :315-360 keeps passing | 3.2 (promotion + added row; that test unchanged; new tests for an added and a promoted HELD row) |
| D5 seeds-only `audienceRulesUnavailable` notice; `declineLabelsUnavailable` and its notice removed (test original :982-988 deleted) | 3.2 |
| D7 tag after Not interested, same amber class; the row amber | 3.2 |
| D7 checkbox accessible name, literal format | 3.2 |
| D7 Add a tenant option note: every cue in order; added row checked with its labels | 3.2 |
| D7 "Flagged recipients you picked stay checked; ..." note unchanged | 3.2 (existing test kept) |
| D7 503 on compose with "Try again" re-running the preview | 3.5 (test "a 503 ...") |
| D7 truncation copy: review alert + reach suffix | 3.2 (alert), 3.3 (suffix) |
| D8 caption (sentence 2 only while the list is non-empty) | 3.3 (two tests), 3.5 (shown with a prefilled list) |
| D8 "Reaches N recipients" = default-checked count; omitted -> "Reach estimate unavailable" | 3.1 (`estimatedCount?`), 3.5 (PIN test); the number itself is the server's (S2) |
| D9 picker lists only Available on the bare and `?contactId=` entries; `?unitId=` keeps any status with banner + dialog; empty state | 3.6 |
| D10 caseworkers: no dashboard change (seeds and checked rows as today) | - |
| Spec 6 dashboard unit tests (every item) | 3.1-3.6 as above |
| Spec 7 dashboard places: types.ts (:3269-3275, :3461-3485, :3498-3512, comments :2273, :3271), endpoints `createBroadcast`, useComposerDraft (draft key 3.3, create body via the filter 3.3, 422 3.5, reach doc 3.5), AudienceFilters (incl. the :102-105 comment, 3.3), BroadcastComposer (3.3, 3.5, 3.6), RecipientPreview (3.2), broadcastFormat (3.1) | as listed |
| Spec 7 readers of `stats.audience` (BroadcastsList :47 :221, BroadcastResults :208, StatChips :40) | verified: no code or test change (Facts) |
| Spec 7 dashboard tests: AudienceFilters.test.tsx (rewritten, 3.3), BroadcastComposer.test.tsx (3.2 fixtures, 3.3 labels/shape/copy, 3.5 new blocks, 3.6), BroadcastComposer.prefill.test.tsx (verified unchanged), RecipientPreview.test.tsx (3.1 fixtures, 3.2), broadcastFormat.test.ts (3.1) | as listed |

### Notes for other slices

**For S1/S2 (the server the dashboard now assumes - binding 2.6):**

- From Task 3.3 on, the composer sends `audience_filter: { contact_type: 'tenant', housing_authorities?: string[], bedroomSize?: number }` with `housing_authorities` OMITTED when empty and never the legacy `housing_authority`. Members are exact organization-list names (picks and the prefill both resolve to entry names).
- RecipientPreview reads `preview.tourHolds` unconditionally (`.map`) and every candidate's `checkedByDefault` (absent reads as UNCHECKED). The server must always send `tourHolds` (possibly `[]`) and `checkedByDefault` on every candidate, including on a seeds-only preview whose rules reads failed.
- The 422 body's `text` must be the refused member exactly as the dashboard sent it (trimmed is fine): the composer removes the member whose trimmed name equals the trimmed `text`.
- Preview 503 is recognized only as `status 503` + `{ error: 'audience_rules_unavailable' }`. POST create never answers 503 (D8): an omitted `estimatedCount` is the dashboard's "Reach estimate unavailable".
- `TourHoldKind` / `TourHold` in `dashboard/src/api/types.ts` are hand mirrors of `app/src/lib/blastAudienceRules.ts` (their comments say MIRRORS); an unknown future kind still renders "Tour <date>".

**For S4 (e2e, selectors, docs) - every user-visible contract S3 changes:**

- **Composer label**: the filter combobox is `getByRole('combobox', { name: 'Housing authorities', exact: true })` (was `Housing authority`); options stay `getByRole('option', { name: /^<entry name>/ })` (portaled), chips `getByRole('button', { name: 'Remove <name>', exact: true })`. Old-label uses: `e2e/tests/dashboard-next/org-lists.spec.ts:343`, `:359` (`pickOrgName(page, page, 'Housing authority', ...)`), `:467`, `:474`; `e2e/tests/dashboard-next/matching-entry-points.spec.ts:290`, `:325` (`getByLabel('Housing authority', { exact: true })`). Update `e2e/support/selectors.md:132-134` (the composer is now a MULTI-picker; it changes its filter on a pick, a chip removal, a property prefill or a property change).
- **Prefill**: with a property attached and the filters on, the property's accepted authorities are already chips when compose shows (exact names or unique spellings; others listed under the picker as "Not used (not on the organization list): <names>"), and the voucher size chip is pressed. A multi-picker HIDES a chosen name from its options, so a spec that types the prefilled authority and clicks its option will find no option. org-lists.spec.ts `:321-367` / `:450-480` ("no authority before a pick") must change.
- **Preview gate**: "Preview recipients" stays disabled (hint "Sizing the audience...") until the property and the organization list have loaded; `toBeEnabled()` waits already work.
- **Caption** (exact, one paragraph): `Only tenants in Onboarding or Searching are included. Add any other tenant by hand when you review recipients.`, and with an authority selected `Only tenants in Onboarding or Searching are included. While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out. Add any other tenant by hand when you review recipients.`
- **Reach line** `Reaches <n> recipient(s)` (the panel's only `role="status"`) now counts the rows that will start checked (server, D8): tenants need recorded consent (`consent_method`), no hold, no decline, not already sent. org-lists.spec.ts `:361` / `:477` counts change unless the helper records consent.
- **Truncation**: the reach line ends ` - the list is incomplete`; the review's `role="alert"` reads `Too many tenants to read - some matches may be missing from this list.`
- **422 copy** (under the picker, `role="alert"`): `<name> is no longer on the organization list, so it was removed from the filter.` (the old `That housing authority is no longer on the list - pick it again` is gone; no e2e uses it).
- **503 copy** (compose, `role="alert"`): `Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.` with `getByRole('button', { name: 'Try again' })` inside it.
- **Failure notices** (plain text under the picker, no role): `Couldn't load the property, so its housing authorities and voucher size were not filled in.` / `Couldn't load the organization list, so housing authorities were not filled in from the property.`
- **Property picker**: the bare and `?contactId=` entries list ONLY Available properties (browse buttons and the search); a non-Available property cannot be picked there - a spec must make it Available first or enter through `?unitId=` (the property page's "+ Send"), which keeps the banner and the Make Available dialog. Empty state: `No Available properties. A property must be Available to send.` (replaces `No properties yet - add one from the Properties page.`; no e2e uses either; `e2e/performance/routes.ts` excludes `/broadcasts/new`).
- **Review step** (`list` `Candidate recipients`): a held row starts UNCHECKED and Select all skips it; its tag text is the tour label (`Tour Oct 20`, `Tour Oct 9, not marked`, `Toured Oct 9, needs outcome`, `Toured Oct 9, needs placement`, `No show Oct 9`, `Tour requested Oct 12`; no date -> no date and no space before it), after `Not interested`. Checkbox names: `<name> - consent not recorded` (no-consent, unchanged), else `<name>` + ` - ` + cues joined by `, ` in the order `already sent`, `not interested`, then the tour label LOWER-CASED (`Ana Diaz - already sent, not interested, tour oct 20`). The date is the BROWSER-LOCAL `toLocaleDateString('en-US', { month: 'short', day: 'numeric' })` of the hold's `at`: compute the expectation in the page (or match with a regex such as `/ - tour [a-z]{3} \d{1,2}$/`) - never from the Node clock's zone. Update `e2e/support/selectors.md:147`.
- **Add a tenant** option text appends every cue joined by `, ` (`Not interested, Already sent, Tour Oct 20`); the added row is checked and carries its tags.
- **Seeds-only** review notice (`role="status"`): `Tour and Not interested labels couldn't be loaded.`
- **Lint gate 5 baseline**: S3 removes two pre-existing `react-hooks/set-state-in-effect` errors from BroadcastComposer.tsx (4 -> 2) and adds none; the repo count AGENTS.md quotes ("23 errors across 18 dashboard files", `docs/issues/lint-backlog-repo-wide.md`) becomes 21 across the same 18 files - update it in S4's docs pass if the count is kept current. Attribute gate 5 by baseline comparison against the merge base, as AGENTS.md says.
- **GLOSSARY**: S3 adds no domain noun ("tour hold" is the spec's D4 term; S4 owns the GLOSSARY Matching entry).

## 8. S4 - e2e, docs, completion (Tasks 4.1-4.5)

## S4 - e2e, docs, completion (Tasks 4.1-4.5)

Draft by the S4 section writer, 2026-10-14. Assumes S1-S3 are committed on
`feat/matching-blast-rules` exactly as plan sections 1.1 and 2 bind them.
Every path below is relative to the worktree root `W:\tmp\matching-blast-rules`
(Git Bash: `/w/tmp/matching-blast-rules`). Every command is Git Bash and starts
with an explicit `cd /w/tmp/matching-blast-rules` (shell cwd does not persist).

### CONTRACT ISSUES

1. Ground rule 0 ("every task is TDD ... at least one real RED case") cannot
   apply literally to S4. Task 4.1 has a real RED (the five specs fail on the
   S3 tip for the reasons listed). Task 4.2 is an acceptance spec over
   behavior S1-S3 already shipped, so it cannot be red against code; this
   draft uses a RED-BY-MUTATION step (one expectation deliberately wrong, run
   red, revert, run green). Tasks 4.3 (docs), 4.4 (gates) and 4.5 (sync,
   handback) have no test step. The assembler should rule this exception in
   section 4.
2. The brief says "`timeout 1500 npm run e2e` style". This draft uses
   `timeout 2700` for the full suite (gate 4): the last two full runs on this
   host took 22.4 and 23.3 minutes for 359 specs
   (`docs/superpowers/reviews/2026-10-12-last-heard-from/handback.md`, gate
   table), this branch adds one spec, and 1500 s would leave about two
   minutes of headroom. 2700 s is the mission cap `e2e/README.md:162-164`
   names. Per-file runs keep `timeout 1500`. Assembler: confirm or override.
3. Order of sync vs gates: AGENTS.md "Required completion gates" says sync
   main FIRST, then run the gates; the brief puts the gates in 4.4 and the
   sync in 4.5 with a re-run when anything merged. This draft keeps the
   brief's numbering and adds an allowed shortcut (Task 4.4 Step 0): when
   `main` is already ahead before 4.4 starts, do Task 4.5 Steps 1-5 first
   so the gates run once. Either way the sync happens exactly once and the
   reported gates run on the post-sync tree. Not a conflict, flagged so the
   assembler can pick one order.

### Facts the tasks rely on (verified on main @a2b3d80d, the branch base)

Tenant setup through the real routes:
- F1. `POST /api/contacts` accepts `status` for a tenant from the tenant
  allowlist (`app/src/routes/contacts.ts:864-870`; allowlist
  `app/src/lib/statusModel.ts:140-148`: needs_review, onboarding, searching,
  placing, placed, on_hold, inactive) and defaults a tenant to `onboarding`
  when absent (`contacts.ts:962-964`). It accepts consent fields through
  `applyConsentFields` (`contacts.ts:972`; human methods include
  `verbal_in_person`, `app/src/lib/smsCompliance.ts:81-84`) and IGNORES
  `housingAuthority` (not parsed by `parseCreateBody`, `contacts.ts:815`).
- F2. `PATCH /api/contacts/:id` sets `housingAuthority` (`contacts.ts:661-666`)
  and checks a changed value against the organization list
  (`contacts.ts:1697-1720`; an unlisted name is 422 `org_not_on_list`), so a
  spec must `addOrg` the run-unique name first. The same PATCH may carry the
  consent fields (`contacts.ts:767`).
- F3. "Recorded consent" = a non-empty `consent_method`
  (`smsCompliance.ts:101-103`, used for the preview's `has_consent` at
  `app/src/routes/broadcasts.ts:530`). The e2e idiom is
  `{ consent_method: 'verbal_in_person', consent_at: new Date().toISOString() }`
  on the PATCH (`broadcasts.spec.ts:55-57`, `review-recipients-heard-from.spec.ts:47-49`,
  `matching-entry-points.spec.ts:49-51`) or on the POST (F1). Add a tenant
  refuses a pick with no consent (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:282-286`).
- F4. `addOrg(request, { kind: 'housing_authority', name })`
  (`e2e/fixtures/orgFixture.ts:81-88`) needs a SIGNED-IN context
  (`page.request` after dev-login) and answers 201. A new name is refused
  only when it equals an existing name or spelling, or is a compound of two
  (`app/src/lib/orgNames.ts:347-365`, `:136-165`), so "<Bird> <Word>
  Authority <stamp>" names are safe (org-lists.spec.ts already uses birds;
  this draft adds Wren Rules, Finch Rules, Wagtail, Bcast Compose, Bcast Warn,
  A2P Consent, Heard Review - none in use, grep-verified).
- F5. The legacy unit value `atlanta_housing` is a spelling of Atlanta Housing
  Authority (`app/src/lib/orgStartingList.ts:17-18`), so units created with it
  store and prefill Atlanta Housing Authority. The lean seed's Tasha
  (`contact-tenant-0001`) is `placing` with Atlanta Housing Authority
  (`app/src/lib/seed/lean.ts:101`, `:109`); the lean seed's other Searching
  Atlanta tenant, Dario, is 1-BR (`lean.ts:189-200`).

Tours:
- F6. `POST /api/tours` (`app/src/routes/tours.ts:312`), body allowlist
  `tenantId, unitId, scheduledAt, tourType` (`:156`), `tourType` one of
  `self_guided | landlord_led | pm_team` (`app/src/lib/toursModel.ts:112`).
  With `scheduledAt` the tour is `scheduled` (reminders armed); without it,
  `requested` with no date. The tenant must be typed tenant; the unit's
  status is not checked. Answers 201 `{ tour }` (TourItem: `tourId`,
  `status`, `createdAt`, `scheduledAt?`).
- F7. `PATCH /api/tours/:id` (`tours.ts:1158`), allowlist
  `scheduledAt, status, outcome, moveForward` (`:159`). `requested -> toured`
  is allowed and may carry a past `scheduledAt` without arming anything
  (`:1239-1260`); an outcome needs the tour to be `toured` (`:1296-1299`).
  The dashboard's Record outcome for Not a fit sends
  `{ outcome: 'not_a_fit', moveForward: false, status: 'closed' }` in ONE
  PATCH (`dashboard/src/routes/tours/TourDetail.tsx:597-601`). Answers
  `{ tour }`.
- F8. The tour label date is `shortDate` =
  `toLocaleDateString('en-US', { month: 'short', day: 'numeric' })` in the
  BROWSER's local time (`dashboard/src/routes/placements/placementsFormat.ts:114-119`),
  so a spec computes the expected label with `page.evaluate`.

Composer and review step (today's DOM, which S3 keeps unless it binds otherwise):
- F9. Property step: `getByRole('combobox', { name: 'Property' })`
  (`BroadcastComposer.tsx:446`) whose options are a CLIENT filter over the
  candidates (`dashboard/src/routes/contact/UnitSearchField.tsx:45-88`,
  option role `:249`), and `<ul aria-label="Properties">` of button rows
  (`BroadcastComposer.tsx:449-466`). The typeahead can re-open over the rows;
  `matching-entry-points.spec.ts:298-314` waits for zero options first.
- F10. The multi-recipient message prefill ends with `[FlyerLink]`
  (`dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`) and is
  rewritten when the first draft returns the server's `?cta=text` link; a
  spec waits for `/p/<unitId>?cta=text` at the end of the value before typing
  (`a2p-compliance.spec.ts:365-373`, `docs/issues/a2p-consent-reinclude-fill-races-prefill.md`).
- F11. The reach line is ONE span `Reaches <strong>N</strong> recipient(s)`
  (`AudienceFilters.tsx:184`), replaced by a pending text while a draft is
  recreated; `getByText('Reaches 2 recipients', { exact: true })` resolves it
  today (`org-lists.spec.ts:361`).
- F12. Review step: `getByRole('list', { name: 'Candidate recipients' })`
  (`RecipientPreview.tsx:518`), one `li` per row, the `Added` tag (`:585`),
  `Select all` / `Deselect all` buttons (`:446`, `:449`), `Add a tenant`
  combobox (`:611`), Send button `Send to N recipient(s)` (`:670`).
- F13. Chips of an org multi-picker are `getByRole('button', { name: 'Remove <name>', exact: true })`
  (`ORG_PICKER.removeChip`, `e2e/scenarios/steps.ts:126-137`);
  `pickOrgName(page, scope, 'Housing authorities', name, { query? })`
  already accepts the plural label (`steps.ts:151-164`).
- F14. Proof of send: `getOutboundTo(request, { to })` reads the fake-twilio
  thread store (`e2e/fixtures/fakeTwilio.ts:201-211`); never reset the fake
  mid-suite (`:437-442`).
- F15. A spec's dev-login: `POST /auth/dev-login { email: 'va@example.com' }`
  then `expectTodayReady` (`review-recipients-heard-from.spec.ts:26-31`).
  Per-test cap 60 s, `test.slow()` triples it; expect timeout 15 s
  (`e2e/playwright.config.ts:115`, `:135`).

What breaks after S1-S3 (why each repair is needed):
- F16. `broadcasts.spec.ts` test 1 (`:96-229`): `createUnitViaApi` stores
  Atlanta Housing Authority (F5, `:78`), so the composer prefills it (D3) and
  the no-authority keep/drop tenants are left out (D2); Tasha is Placing (D1)
  so the "already sent" row (`:172-175`) never appears. Test 2 (`:231-262`):
  its tenant has no authority, so its audience is whatever Atlanta 2-BR
  Searching/Onboarding consented tenants the lane holds - zero on a fresh
  lane (Send disabled), others' tenants otherwise.
- F17. `review-recipients-heard-from.spec.ts`: property accepts Atlanta
  Housing Authority (`:67`), tenants have none (`:42-44`) - none listed.
  `:173` asserts the `Onboarding` badge (the POST default today).
- F18. `a2p-compliance.spec.ts` section 8.3 test 1 (`:324-443`): unit
  `atlanta_housing` (`:348`), tenants without an authority (`:332-333`) -
  not listed. The path (c) test (`:445-510`) already uses a run-unique LISTED
  authority added by `addOrg` (`:459-460`) and sends the LEGACY
  `housing_authority` string (`:480`); under D2 a legacy string is accepted as
  a one-member list and stored as `housing_authorities`, so the 201 and the
  path (c) send keep working (storedFilterRefusal needs an exact listed name,
  which it is). Its tenants default to Onboarding (D1-compatible).
- F19. `org-lists.spec.ts`: `draftAuthority` reads a string
  (`:183-194`); the composer tests (`:321-369`, `:450-478`) use the label
  `Housing authority` (`:343`, `:359`, `:467`, `:474`), expect NO authority
  before a pick (`:354-355`) and an option for a name the multi picker now
  hides once prefilled (`:347`, `:469`); `Reaches 2 recipients` (`:361`) and
  `Reaches 1 recipient` (`:477`) count tenants created without consent
  (`createTenant`, `:113-136`), which D8 leaves out.
- F20. `matching-entry-points.spec.ts:290`, `:325` use the label
  `Housing authority`. Its other two tests send to a seed or a hand-added
  tenant after `Deselect all` and do not depend on the filter audience.
- F21. Not broken: `e2e/tests/scenarios/sending-unit.spec.ts` (its tenant is
  Atlanta, Searching, 2-BR, consented, with no tour before each send - so it
  is listed and checked; `teamSendsListing` checks it by name,
  `steps.ts:1059-1089`); `share-skip-fix`, `share-sent-outcome`,
  `partner-share`, `matching-entry-points` test 1 (seeds-only, fresh
  Available units); `listing-activity`, `landlord-activity`,
  `send-outcome-*` (API drafts + explicit `recipientContactIds`, path (a)).
- F22. Lint baseline on main @a2b3d80d (run 2026-10-14 in the main checkout):
  `dashboard/src/routes/broadcasts/BroadcastComposer.tsx` has 4
  `react-hooks/set-state-in-effect` errors (lines 205, 230, 249, 271) and
  `dashboard/src/routes/broadcasts/useComposerDraft.ts` has 1
  `react-hooks/refs` error (line 140); the five e2e specs, `AudienceFilters.tsx`,
  `RecipientPreview.tsx`, `broadcastFormat.ts`, `OrgPicker.tsx`,
  `api/types.ts`, `api/endpoints.ts`, `app/src/routes/broadcasts.ts`,
  `audienceResolution.ts`, `toursRepo.ts`, `broadcastsRepo.ts` are clean.
- F23. The worktree had NO `node_modules` at plan time
  (`ls node_modules/.bin/eslint` failed). Every e2e run and gate needs them.
- F24. Per-file e2e runs: `npm run e2e -w @housingchoice/e2e -- <file>...`
  (one npm hop - a flag or path passed through the ROOT `npm run e2e` takes a
  second hop). `reuseExistingServer` adopts any stack on the lane whose
  commit matches (AGENTS.md), and the preflight refuses a stack booted at a
  different commit (`e2e/support/preflight.ts:88-125`), so per-file runs here
  boot their own stack: never leave an `e2e:session` running in this
  worktree during S4.
- F25. Worktree gitdir is
  `W:/AI Projects/Housing Choice/HC Application/.git/worktrees/matching-blast-rules`
  (`git rev-parse --absolute-git-dir`); branch base = main = a2b3d80d,
  0 behind at plan time. `git merge-tree --write-tree HEAD main` is available
  (git 2.56) to preview conflicts without touching the tree.
- F26. `.superpowers/` is gitignored (`.gitignore:52`); mission records go
  to `docs/superpowers/reviews/2026-10-14-matching-blast-rules/` (exists,
  holds `design-review/`).

Shared helpers this section creates (gitignored, not committed):

`.superpowers/gates/run-e2e-files.sh` - created in Task 4.1 Step 2:

```bash
#!/usr/bin/env bash
# Run chosen e2e spec files on their own hermetic lane, BARE: the e2e command
# is the last thing on its line and its exit code is written on the NEXT line.
# Usage: bash .superpowers/gates/run-e2e-files.sh <label> <spec path under e2e/>...
cd /w/tmp/matching-blast-rules || exit 99
LABEL="$1"
shift
OUT=".superpowers/gates/$LABEL"
mkdir -p "$OUT"
rm -f "$OUT/exit.txt"
timeout 1500 npm run e2e -w @housingchoice/e2e -- "$@" > "$OUT/e2e.log" 2>&1
echo "EXIT:$?" > "$OUT/exit.txt"
```

How every e2e run in S4 is launched and read (the Bash tool kills even a
backgrounded command after 600 s, so launch DETACHED):

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-e2e-files.sh <label> <files...> > /dev/null 2>&1 & disown
```

Wait with the Monitor tool (load it with ToolSearch `select:Monitor`), command
`cd /w/tmp/matching-blast-rules && until test -f .superpowers/gates/<label>/exit.txt; do sleep 20; done`,
then read `.superpowers/gates/<label>/exit.txt` and the counts with
`grep -nE " passed| failed| flaky|npm error code" .superpowers/gates/<label>/e2e.log`.
The verdict is the LOG plus `exit.txt`, never a task notification's exit code.
While any e2e run is live in this worktree, edit nothing under `app/` or
`dashboard/` (the stack serves the source live). After an ABORTED run, read
the lane ports from `e2e/.artifacts/lane.json` and confirm none still listens
(`netstat -ano | grep -E ":(<app>|<dashboard>|<fake>|<public>) "` prints
nothing) before the next run; if one does, run `npm run e2e:stop` and check
again.

---

### Task 4.1 - Repair the existing Matching e2e specs and selectors.md

Files (edit only these):
- `e2e/tests/dashboard-next/broadcasts.spec.ts`
- `e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts`
- `e2e/tests/dashboard-next/a2p-compliance.spec.ts`
- `e2e/tests/dashboard-next/org-lists.spec.ts`
- `e2e/tests/dashboard-next/matching-entry-points.spec.ts`
- `e2e/support/selectors.md`

Ruling applied (spec section 7): wherever a spec asserts a list or a count,
its tenants get an EXPLICIT status, recorded consent and a RUN-UNIQUE
listed housing authority (added per run with `addOrg`), and the property
accepts that authority. EXCEPTION kept: the a2p no-consent tenants keep no
consent (section 8.3 test 1's `noConsent`, and the path (c) test that
expects `skipped_no_consent === 1`); the path (c) test keeps sending the
legacy `housing_authority` string as legacy coverage.

Several of these files hold pre-existing non-ASCII characters (em dashes,
arrows, the section sign). Every line this task ADDS is ASCII. Where an
edit below must remove or replace a line that holds non-ASCII text, it is
located by its ASCII anchors and line number: Read those lines first and
copy them into the Edit tool's `old_string` exactly as read.

**Step 1 - preconditions.**

```bash
cd /w/tmp/matching-blast-rules && git status && git log --oneline -1 && test -x node_modules/.bin/eslint && echo "node_modules OK"; test -f e2e/.artifacts/session.pid && echo "SESSION PID FILE PRESENT"
```

Expected: a clean tree on the S3 tip, `node_modules OK`, no session line.
If `node_modules OK` is missing, run `cd /w/tmp/matching-blast-rules && npm ci`
(never link another worktree's node_modules). If the session line prints,
run `cd /w/tmp/matching-blast-rules && npm run e2e:stop` and confirm the lane
ports are free (see "How every e2e run ... is launched").

**Step 2 - RED: run the five specs on the S3 tip before any edit.**

Create `.superpowers/gates/run-e2e-files.sh` with the content in "Shared
helpers" above, then launch:

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-e2e-files.sh s4-41-red tests/dashboard-next/broadcasts.spec.ts tests/dashboard-next/review-recipients-heard-from.spec.ts tests/dashboard-next/a2p-compliance.spec.ts tests/dashboard-next/org-lists.spec.ts tests/dashboard-next/matching-entry-points.spec.ts > /dev/null 2>&1 & disown
```

Wait for `.superpowers/gates/s4-41-red/exit.txt`. Expected `EXIT:1`, with
these tests failing for these reasons (read each failure in `e2e.log`):
- broadcasts "pre-filled audience, uncheck one + add one + an already-sent
  flag ..." - the keep/drop rows are not listed (no housing authority under
  the Atlanta prefill) or Tasha's row never appears (Placing).
- broadcasts "sending a non-Available property warns ..." - lane-dependent
  (F16): red on a lane with no Atlanta 2-BR consented Searching/Onboarding
  tenant (the Send button reads `Send to 0 recipients`, disabled); it may
  pass otherwise. That dependence is what the repair removes.
- review-recipients "Review recipients: columns, last-heard order ..." - the
  tenants' rows are not listed.
- a2p "a no-consent tenant is surfaced in the preview ..." - the
  no-consent row is not listed.
- org-lists "blast composer: the picker has no add step ..." and "blast
  composer: Preview waits while the housing authority filter holds typed
  text" - no combobox named exactly `Housing authority`.
- matching-entry-points "Matching page \"Send a property\": property-first
  step ..." - fails at `:325` (no element labeled `Housing authority`).
Expected GREEN already (pins): every other test in the five files,
including the a2p path (c) test "the fan-out fence counts
skipped_no_consent ..." (F18). If any OTHER test fails, stop and diagnose
it before editing: it is not a known consequence of S1-S3.

**Step 3 - `broadcasts.spec.ts`.** Apply in this order.

3a. Import `addOrg`. old:

```ts
import { listThreads } from '../../fixtures/fakeTwilio.js';
```

new:

```ts
import { listThreads } from '../../fixtures/fakeTwilio.js';
import { addOrg } from '../../fixtures/orgFixture.js';
```

3b. Header comment. Replace lines 19-24 - from the line
`// Seeded data (app/src/lib/seedData.ts):` through the line
`//     this on the local DynamoDB).` (line 21 holds an arrow; copy it from a
Read) - with:

```ts
// Seeded data (app/src/lib/seedData.ts): unit-0001 = 1450 Joseph E. Boone Blvd
// NW (beds 2, Atlanta Housing Authority) - only the draft-delete test uses it.
// The first two tests build their audience per run (tracker #6): a Matching blast
// reads Searching and Onboarding tenants only and limits them to the property's
// housing authorities, so each adds a RUN-UNIQUE housing authority, gives the
// property and its tenants that name, and (the first test) plants a PRIOR send
// to one of its own tenants so the next preview flags them "already sent" (the
// lean seed's Tasha is Placing, so the filters leave her out).
```

Lines 25-27 stay as they are.

3c. Delete the Tasha constant. old (the whole line plus its newline):

```ts
const TASHA = 'contact-tenant-0001';
```

new: nothing (the line `const SEEDED_UNIT = ...` above it stays).

3d. `createTenant` signature and create body. old:

```ts
/** Create a tenant via the API (camelCase voucherSize so the resolver matches).
 *  `voucherSize` defaults to 2 (the unit-0001 audience); pass 3 for a tenant the
 *  2-BR filter will NOT catch (so it must be added manually via search).
 *  Returns the new contactId + the display name we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Bcastest', phone, voucherSize },
  });
```

new:

```ts
/** Create a tenant via the API (camelCase voucherSize so the resolver matches).
 *  `voucherSize` defaults to 2 (the unit-0001 audience); pass 3 for a tenant the
 *  2-BR filter will NOT catch (so it must be added manually via search).
 *  The status is EXPLICIT (default Searching): a Matching blast reads Searching
 *  and Onboarding tenants only (tracker #6 D1). `housingAuthority`, when given,
 *  must already be an organization-list name (the PATCH below checks it; the
 *  create ignores the field).
 *  Returns the new contactId + the display name we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
  opts: { housingAuthority?: string; status?: 'searching' | 'onboarding' } = {},
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName,
      lastName: 'Bcastest',
      phone,
      voucherSize,
      status: opts.status ?? 'searching',
    },
  });
```

3e. `createTenant` consent PATCH. old:

```ts
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
```

new:

```ts
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: {
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
      ...(opts.housingAuthority !== undefined && { housingAuthority: opts.housingAuthority }),
    },
  });
```

3f. `createUnitViaApi` authorities option. old:

```ts
  opts: { available: boolean },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['atlanta_housing'],
```

new:

```ts
  opts: { available: boolean; authorities?: string[] },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      // List names or unique spellings (the default `atlanta_housing` is a
      // spelling of Atlanta Housing Authority). A test whose audience is
      // asserted passes its own run-unique name: the composer prefills its
      // housing authority filter from this list (tracker #6 D3).
      accepted_authorities: opts.authorities ?? ['atlanta_housing'],
```

3g. Delete the Tasha consent block in test 1. Delete lines 104-112: the
4-line comment whose first line begins `    // A2P/CTIA (spec` and contains
`seeded Tasha (contact-tenant-0001) now carries inbound_text` (lines 104
and 106 hold a section sign and an em dash - copy from a Read), the four
lines `    const tashaConsent = await page.request.patch(...` through
`    expect(tashaConsent.ok()).toBeTruthy();`, and the blank line 112 after
them. `old_string` = those nine lines as read; `new_string` = empty. Line
102 `    await devLogin(page);` and its following blank line stay.

3h. Test 1 audience setup. old:

```ts
    // --- Set up the audience: two fresh 2-BR tenants we control (unique names). ---
    const stamp = `${Date.now()}`.slice(-6);
    // Per-run Available property (spec 2026-07-10): with the send guard live,
    // sending against seeded unit-0001 would 400 (it is under_application, kept
    // that way for public-pages.spec.ts). Create + publish our own.
    const unitId = await createUnitViaApi(page.request, stamp, { available: true });
    const keep = await createTenant(page.request, `Keepme${stamp}`);
    const drop = await createTenant(page.request, `Dropme${stamp}`);
```

new:

```ts
    // --- Set up the audience: three fresh 2-BR Searching tenants we control
    // (unique names) in a RUN-UNIQUE housing authority (tracker #6: the
    // composer prefills the property's authorities and the blast reads
    // Searching and Onboarding tenants in them only, so a shared authority
    // would pull in every earlier spec's tenants). ---
    const stamp = `${Date.now()}`.slice(-6);
    const authority = `Bcast Compose Authority ${stamp}`;
    await addOrg(page.request, { kind: 'housing_authority', name: authority });
    // Per-run Available property (spec 2026-07-10): with the send guard live,
    // sending against seeded unit-0001 would 400 (it is under_application, kept
    // that way for public-pages.spec.ts). Create + publish our own.
    const unitId = await createUnitViaApi(page.request, stamp, { available: true, authorities: [authority] });
    const keep = await createTenant(page.request, `Keepme${stamp}`, 2, { housingAuthority: authority });
    const drop = await createTenant(page.request, `Dropme${stamp}`, 2, { housingAuthority: authority });
    // The already-sent tenant is ours, not the lean seed's Tasha: she is
    // Placing, so the filters leave her out (tracker #6 D1).
    const prior = await createTenant(page.request, `Priorsent${stamp}`, 2, { housingAuthority: authority });
```

The next two lines (the 3-BR comment holding an arrow, and
`const added = await createTenant(page.request, \`Addme${stamp}\`, 3);`)
stay unchanged.

3i. The prior send comment. old:

```ts
    // --- Seed a PRIOR sent broadcast for unit-0001 that includes Tasha, so the
    // next preview flags her "already sent". Built straight through the API. ---
```

new:

```ts
    // --- Seed a PRIOR send of this property to `prior`, so the next preview
    // flags them "already sent". Built straight through the API. ---
```

3j. The prior send recipient. old:

```ts
      data: { recipientContactIds: [TASHA] },
```

new:

```ts
      data: { recipientContactIds: [prior.contactId] },
```

3k. Prefill assertion and the message-settle wait. old:

```ts
    await expect(page.getByText(/matches property/i)).toBeVisible();

    // Write a message (unique so its outbound copy is assertable in the fake).
```

new:

```ts
    await expect(page.getByText(/matches property/i)).toBeVisible();

    // The housing authority filter is PRE-FILLED with the property's run-unique
    // authority (tracker #6 D3): one chip in the "Housing authorities" picker.
    await expect(page.getByRole('button', { name: `Remove ${authority}`, exact: true })).toBeVisible();

    // Let the message prefill settle before typing: it is written on property
    // load, then again with the server's ?cta=text link
    // (docs/issues/a2p-consent-reinclude-fill-races-prefill.md).
    await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), {
      timeout: 15_000,
    });

    // Write a message (unique so its outbound copy is assertable in the fake).
```

3l. The candidate rows. old:

```ts
    // Our two 2-BR tenants are filter-matched candidates (preview rows show the
    // FIRST name only). Tasha is too (already-sent).
    await expect(list.getByText(keep.firstName)).toBeVisible();
    await expect(list.getByText(drop.firstName)).toBeVisible();

    // Tasha is flagged "already sent" and starts UNCHECKED (soft opt-in to resend).
    const tashaRow = list.locator('li', { hasText: 'Tasha' });
    await expect(tashaRow.getByText('Already sent')).toBeVisible();
    await expect(tashaRow.getByRole('checkbox')).not.toBeChecked();
```

new:

```ts
    // Our three 2-BR tenants are filter-matched candidates; `prior` is the
    // already-sent one.
    await expect(list.getByText(keep.firstName)).toBeVisible();
    await expect(list.getByText(drop.firstName)).toBeVisible();

    // `prior` is flagged "already sent" and starts UNCHECKED (soft opt-in to resend).
    const priorRow = list.locator('li', { hasText: prior.name });
    await expect(priorRow.getByText('Already sent')).toBeVisible();
    await expect(
      list.getByRole('checkbox', { name: `${prior.name} - already sent`, exact: true }),
    ).not.toBeChecked();
```

3m. The send count. old:

```ts
    // Send to the curated selection.
    await page.getByRole('button', { name: /^Send to/ }).click();
```

new:

```ts
    // Send to the curated selection: keep + the hand-added tenant (drop was
    // unchecked by hand, prior starts unchecked).
    await page.getByRole('button', { name: 'Send to 2 recipients', exact: true }).click();
```

3n. Test 2 setup. old:

```ts
    // A sendable 2-BR tenant the default audience will catch.
    await createTenant(page.request, `Warnme${stamp}`);
    // Fresh unit left in 'setup' - NOT shareable, so the flyer link is dead.
    const unitId = await createUnitViaApi(page.request, stamp, { available: false });
```

new:

```ts
    // A sendable 2-BR Searching tenant in a RUN-UNIQUE housing authority the
    // property accepts, so the prefilled audience is exactly this tenant
    // (tracker #6: a shared authority would pull in other specs' tenants).
    const authority = `Bcast Warn Authority ${stamp}`;
    await addOrg(page.request, { kind: 'housing_authority', name: authority });
    await createTenant(page.request, `Warnme${stamp}`, 2, { housingAuthority: authority });
    // Fresh unit left in 'setup' - NOT shareable, so the flyer link is dead.
    const unitId = await createUnitViaApi(page.request, stamp, { available: false, authorities: [authority] });
```

3o. Test 2 send. old:

```ts
    await page.getByRole('button', { name: /^Send to \d+ recipients?$/ }).click();
```

new:

```ts
    await page.getByRole('button', { name: 'Send to 1 recipient', exact: true }).click();
```

Check: `grep -n "TASHA\|Tasha\|tashaConsent" e2e/tests/dashboard-next/broadcasts.spec.ts`
prints only the header comment line from 3b.

**Step 4 - `review-recipients-heard-from.spec.ts`.**

4a. Import. old:

```ts
import { APP_NUMBER, getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
```

new:

```ts
import { APP_NUMBER, getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { addOrg } from '../../fixtures/orgFixture.js';
```

4b. `createTenant`. old (lines 33-52, the whole function and its comment):

```ts
/** A consented, run-unique tenant (consent so a send reaches them). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Heardtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}
```

new:

```ts
/** A consented, run-unique tenant (consent so a send reaches them), explicitly
 *  Onboarding: a Matching blast reads Onboarding and Searching tenants only
 *  (tracker #6 D1). `housingAuthority`, when given, must already be a list
 *  name - the PATCH checks it (the create ignores the field). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
  housingAuthority?: string,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Heardtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize, status: 'onboarding' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: {
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
      ...(housingAuthority !== undefined && { housingAuthority }),
    },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}
```

4c. `createUnitViaApi`. old:

```ts
/** An Available 2-BR property (no tour type - the review step does not read it). */
async function createUnitViaApi(api: APIRequestContext, stamp: string): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp}${Math.floor(Math.random() * 90) + 10} Heardfrom Ave`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Atlanta Housing Authority'],
```

new:

```ts
/** An Available 2-BR property (no tour type - the review step does not read it)
 *  accepting one housing authority, which must be a list name. */
async function createUnitViaApi(
  api: APIRequestContext,
  stamp: string,
  authority: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp}${Math.floor(Math.random() * 90) + 10} Heardfrom Ave`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: [authority],
```

4d. Test setup. old:

```ts
  // --- Setup: a property, four 2-BR tenants and one 3-BR (outside the audience,
  // so it must be hand-added). ---
  const { unitId } = await createUnitViaApi(api, stamp);
  const older = await createTenant(api, `Older${stamp}`);
  const recent = await createTenant(api, `Recent${stamp}`);
  const never = await createTenant(api, `Never${stamp}`);
  const declined = await createTenant(api, `Declined${stamp}`);
  const declinedAdded = await createTenant(api, `Declinedadd${stamp}`, 3);
```

new:

```ts
  // --- Setup: a property, four 2-BR tenants and one 3-BR (outside the audience,
  // so it must be hand-added). The property and the four share a RUN-UNIQUE
  // housing authority (tracker #6): the composer prefills the property's
  // authorities and the blast leaves out a tenant outside them, so a shared
  // name would also pull in every earlier spec's tenants. ---
  const authority = `Heard Review Authority ${stamp}`;
  await addOrg(api, { kind: 'housing_authority', name: authority });
  const { unitId } = await createUnitViaApi(api, stamp, authority);
  const older = await createTenant(api, `Older${stamp}`, 2, authority);
  const recent = await createTenant(api, `Recent${stamp}`, 2, authority);
  const never = await createTenant(api, `Never${stamp}`, 2, authority);
  const declined = await createTenant(api, `Declined${stamp}`, 2, authority);
  const declinedAdded = await createTenant(api, `Declinedadd${stamp}`, 3);
```

Nothing else in this file changes (`:173` still reads the `Onboarding`
badge - now explicit; the column header `Housing authority` at `:166` is the
review list's column, not the picker).

**Step 5 - `a2p-compliance.spec.ts`** (`addOrg` is already imported, `:11`).

5a. `createContact`. old (lines 70-87; the doc comment above it, lines
67-69, holds an em dash and stays unchanged):

```ts
async function createContact(
  request: APIRequestContext,
  opts: { type?: 'tenant' | 'landlord'; firstName: string; voucherSize?: number },
): Promise<{ contactId: string; firstName: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: opts.type ?? 'tenant',
      firstName: opts.firstName,
      lastName: 'A2Ptest',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
    },
  });
  expect(res.ok(), `create contact ${opts.firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  return { contactId, firstName: opts.firstName, phone };
}
```

new:

```ts
async function createContact(
  request: APIRequestContext,
  opts: {
    type?: 'tenant' | 'landlord';
    firstName: string;
    voucherSize?: number;
    /** Explicit status (a Matching blast reads Searching and Onboarding
     *  tenants only, tracker #6 D1); the create defaults a tenant to Onboarding. */
    status?: 'searching' | 'onboarding';
    /** Must already be an organization-list name: the PATCH checks it (the
     *  create ignores the field). */
    housingAuthority?: string;
  },
): Promise<{ contactId: string; firstName: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: opts.type ?? 'tenant',
      firstName: opts.firstName,
      lastName: 'A2Ptest',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
      ...(opts.status !== undefined && { status: opts.status }),
    },
  });
  expect(res.ok(), `create contact ${opts.firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  if (opts.housingAuthority !== undefined) {
    const patch = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { housingAuthority: opts.housingAuthority },
    });
    expect(patch.ok(), `set the housing authority of ${opts.firstName}`).toBeTruthy();
  }
  return { contactId, firstName: opts.firstName, phone };
}
```

5b. Section 8.3 test 1 tenants. old:

```ts
    // Two 2-BR tenants: one WITH consent (via a JIT-style PATCH) and one WITHOUT.
    const consented = await createContact(page.request, { firstName: `Yes${stamp}`, voucherSize: 2 });
    const noConsent = await createContact(page.request, { firstName: `No${stamp}`, voucherSize: 2 });
```

new:

```ts
    // A run-unique housing authority (tracker #6): the composer prefills the
    // property's authorities and the blast reads Searching and Onboarding
    // tenants in them only, so a shared authority would pull in every earlier
    // spec's tenants.
    const authority = `A2P Consent Authority ${stamp}`;
    await addOrg(page.request, { kind: 'housing_authority', name: authority });

    // Two 2-BR Searching tenants in it: one WITH consent (via a JIT-style PATCH)
    // and one WITHOUT. The no-consent one keeps none ON PURPOSE - it is what
    // this test proves is fenced (spec section 7 exception).
    const consented = await createContact(page.request, {
      firstName: `Yes${stamp}`,
      voucherSize: 2,
      status: 'searching',
      housingAuthority: authority,
    });
    const noConsent = await createContact(page.request, {
      firstName: `No${stamp}`,
      voucherSize: 2,
      status: 'searching',
      housingAuthority: authority,
    });
```

5c. Section 8.3 test 1 property. old:

```ts
    // Seed an AVAILABLE 2-BR property to broadcast from (so the composer pre-fills a
    // 2-BR audience that catches both tenants).
    const landlord = 'contact-landlord-0001';
    const created = await page.request.post(`${NEXT}/api/units`, {
      data: {
        landlordId: landlord,
        accepted_authorities: ['atlanta_housing'],
```

new:

```ts
    // Seed an AVAILABLE 2-BR property to broadcast from, accepting the run-unique
    // authority (so the composer pre-fills a 2-BR audience in that authority that
    // catches both tenants).
    const landlord = 'contact-landlord-0001';
    const created = await page.request.post(`${NEXT}/api/units`, {
      data: {
        landlordId: landlord,
        accepted_authorities: [authority],
```

5d. Path (c) test tenants. old:

```ts
    const consented = await createContact(page.request, { firstName: `FenceYes${stamp}`, voucherSize: 2 });
    const noConsent = await createContact(page.request, { firstName: `FenceNo${stamp}`, voucherSize: 2 });
```

new:

```ts
    // Explicit Searching (tracker #6 D1); the no-consent tenant keeps no consent
    // on purpose - the fan-out's skipped_no_consent is what this test proves.
    const consented = await createContact(page.request, {
      firstName: `FenceYes${stamp}`,
      voucherSize: 2,
      status: 'searching',
    });
    const noConsent = await createContact(page.request, {
      firstName: `FenceNo${stamp}`,
      voucherSize: 2,
      status: 'searching',
    });
```

(The existing loop below them still PATCHes both into the run-unique
authority; the consent PATCH still covers only `consented`.)

5e. Path (c) legacy body, kept. old:

```ts
        audience_filter: { contact_type: 'tenant', housing_authority: authority, bedroomSize: 2 },
```

new:

```ts
        // LEGACY body shape, kept on purpose as the e2e coverage of it (tracker
        // #6 D2): a one-string `housing_authority` is accepted and stored as a
        // one-member `housing_authorities` list (asserted on the echo below).
        audience_filter: { contact_type: 'tenant', housing_authority: authority, bedroomSize: 2 },
```

5f. Path (c) echo assertion. old:

```ts
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await page.request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, { data: {} });
```

new:

```ts
    expect(draft.ok(), await draft.text()).toBeTruthy();
    const draftJson = (await draft.json()) as {
      broadcastId: string;
      audience_filter: { housing_authorities?: string[]; housing_authority?: string };
    };
    // The echo is the normalized wire shape: the list, never the legacy key (D2).
    expect(draftJson.audience_filter.housing_authorities).toEqual([authority]);
    expect(draftJson.audience_filter.housing_authority).toBeUndefined();
    const broadcastId = draftJson.broadcastId;
    const send = await page.request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, { data: {} });
```

The `skipped_no_consent` poll (`toBe(1)`) and the no-outbound poll stay.

**Step 6 - `org-lists.spec.ts`.**

6a. Header. old:

```ts
//      multi-picker; the blast composer's picker (no add step, and the filter
//      changes only on a pick); text typed but never picked (code review
```

new:

```ts
//      multi-picker; the blast composer's multi-picker (prefilled from the
//      property, no add step, and the filter changes only on a pick or a chip
//      removal); text typed but never picked (code review
```

6b. `createTenant` head. old:

```ts
/** A tenant through the real routes. `housingAuthority` must already be a list
 *  name: the PATCH applies the D5 check (the POST ignores the field). */
async function createTenant(
  request: APIRequestContext,
  opts: { firstName: string; voucherSize?: number; housingAuthority?: string },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName: 'Orglist',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
    },
  });
```

new:

```ts
/** A tenant through the real routes. `housingAuthority` must already be a list
 *  name: the PATCH applies the D5 check (the POST ignores the field). A blast
 *  tenant passes `status` (a Matching blast reads Searching and Onboarding
 *  tenants only) and `consent: true` (the reach counts only the recipients that
 *  start checked, which needs recorded consent) - tracker #6 D1, D8. */
async function createTenant(
  request: APIRequestContext,
  opts: {
    firstName: string;
    voucherSize?: number;
    housingAuthority?: string;
    status?: 'searching' | 'onboarding';
    consent?: boolean;
  },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName: 'Orglist',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
      ...(opts.status !== undefined && { status: opts.status }),
      ...(opts.consent === true && {
        consent_method: 'verbal_in_person',
        consent_at: new Date().toISOString(),
      }),
    },
  });
```

6c. Draft-body readers. old:

```ts
interface DraftBody {
  audience_filter?: { housing_authority?: string };
}

/** A blast-draft create: the composer's estimate engine, one per material change. */
function isDraftCreate(r: Request): boolean {
  return r.method() === 'POST' && new URL(r.url()).pathname === '/api/broadcasts';
}

function draftAuthority(r: Request): string | undefined {
  return (r.postDataJSON() as DraftBody | null)?.audience_filter?.housing_authority;
}
```

new:

```ts
interface DraftBody {
  audience_filter?: { housing_authorities?: string[] };
}

/** A blast-draft create: the composer's estimate engine, one per material change. */
function isDraftCreate(r: Request): boolean {
  return r.method() === 'POST' && new URL(r.url()).pathname === '/api/broadcasts';
}

/** The housing authorities a draft create carried (tracker #6 D2: a list);
 *  undefined = no authority filter (the key absent or the list empty). */
function draftAuthorities(r: Request): string[] | undefined {
  const list = (r.postDataJSON() as DraftBody | null)?.audience_filter?.housing_authorities;
  return list !== undefined && list.length > 0 ? list : undefined;
}

/** The same names, in any order. */
function sameNames(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return actual !== undefined && [...actual].sort().join('\n') === [...expected].sort().join('\n');
}
```

6d. Replace the WHOLE test block lines 321-369 - from the line
`  test('blast composer: the picker has no add step and changes the filter only on a pick', async ({ page }) => {`
through its closing `  });` (line 369; line 370 `});` closes the describe
and stays) - with:

```ts
  test('blast composer: the picker is prefilled from the property, has no add step, and changes the filter only on a pick or a chip removal', async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const plover = `Plover Housing Authority ${stamp}`;
    const first = `PloverA${stamp}`;
    const second = `PloverB${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: plover });
    // Searching with recorded consent: the reach counts the recipients that
    // will start checked (tracker #6 D1, D8).
    for (const firstName of [first, second]) {
      await createTenant(req, { firstName, voucherSize: 2, housingAuthority: plover, status: 'searching', consent: true });
    }
    const unitId = await createUnit(req, { line1: `${stamp} Plover Way`, authorities: [plover], available: true });

    // The housing authorities every draft create carried (undefined = no filter).
    const sent: Array<string[] | undefined> = [];
    page.on('request', (r) => {
      if (isDraftCreate(r)) sent.push(draftAuthorities(r));
    });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill(`Plover check ${stamp}`);

    // The property prefills its authority (tracker #6 D3): one chip, and the
    // reach counts exactly the two tenants.
    const chip = page.getByRole('button', { name: ORG_PICKER.removeChip(plover), exact: true });
    await expect(chip).toBeVisible();
    await expect(page.getByText('Reaches 2 recipients', { exact: true })).toBeVisible();
    expect(sent.filter((a) => a !== undefined).every((a) => sameNames(a, [plover]))).toBe(true);

    // Removing the chip is a filter change: the next draft carries no authority.
    const cleared = page.waitForRequest((r) => isDraftCreate(r) && draftAuthorities(r) === undefined);
    await chip.click();
    await cleared;
    const mark = sent.length;

    // Names are offered; the add option never is (D7: filters name list entries only).
    const box = page.getByRole('combobox', { name: 'Housing authorities', exact: true });
    await box.fill('Plover');
    await expect(page.getByRole('option', { name: ORG_PICKER.option(plover) })).toBeVisible();
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toHaveCount(0);
    await box.fill(`Zz Nowhere ${stamp}`);
    await expect(page.getByRole('option', { name: ORG_PICKER.option(plover) })).toHaveCount(0);
    await expect(page.getByRole('option', { name: ORG_PICKER.addOption })).toHaveCount(0);
    // Typing is never a filter change: outlast the 600 ms create debounce, then
    // no draft since the removal has carried a housing authority.
    await page.waitForTimeout(1_500);
    expect(sent.slice(mark).filter((a) => a !== undefined)).toEqual([]);

    // A pick commits the filter again, and the reach counts exactly the two tenants.
    const committed = page.waitForRequest((r) => isDraftCreate(r) && sameNames(draftAuthorities(r), [plover]));
    await pickOrgName(page, page, 'Housing authorities', plover, { query: 'Plover' });
    await committed;
    await expect(page.getByText('Reaches 2 recipients', { exact: true })).toBeVisible();

    // The server resolves that exact name: Preview lists both tenants.
    await page.getByRole('button', { name: 'Preview recipients' }).click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByText(first)).toBeVisible();
    await expect(list.getByText(second)).toBeVisible();
  });
```

6e. Replace the WHOLE test block lines 450-478 - from the line
`  test('blast composer: Preview waits while the housing authority filter holds typed text', async ({ page }) => {`
through its closing `  });` (line 478; line 479 `});` closes the describe
and stays) - with:

```ts
  test('blast composer: Preview waits while the housing authorities filter holds typed text', async ({ page }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const pipit = `Pipit Housing Authority ${stamp}`;
    // A second list name the property does NOT accept: typed, it is no filter.
    const wagtail = `Wagtail Housing Authority ${stamp}`;
    await addOrg(req, { kind: 'housing_authority', name: pipit });
    await addOrg(req, { kind: 'housing_authority', name: wagtail });
    await createTenant(req, {
      firstName: `PipitA${stamp}`,
      voucherSize: 2,
      housingAuthority: pipit,
      status: 'searching',
      consent: true,
    });
    const unitId = await createUnit(req, { line1: `${stamp} Pipit Way`, authorities: [pipit], available: true });

    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill(`Pipit check ${stamp}`);
    const previewButton = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewButton).toBeEnabled();
    // The property's authority is prefilled (tracker #6 D3) and reaches the one tenant.
    await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(pipit), exact: true })).toBeVisible();
    await expect(page.getByText('Reaches 1 recipient', { exact: true })).toBeVisible();

    // Another list name typed in full, its option showing, but not picked: it
    // is no filter (D7), so Preview waits and says why.
    const box = page.getByRole('combobox', { name: 'Housing authorities', exact: true });
    await box.fill(wagtail);
    await expect(page.getByRole('option', { name: ORG_PICKER.option(wagtail) })).toBeVisible();
    await expect(previewButton).toBeDisabled();
    await expect(page.getByText(PREVIEW_HINT, { exact: true })).toBeVisible();

    // A pick makes it a member: Preview goes, and the reach is any-of (pipit OR
    // wagtail) - still the one tenant.
    const committed = page.waitForResponse(
      (r) => isDraftCreate(r.request()) && sameNames(draftAuthorities(r.request()), [pipit, wagtail]),
    );
    await pickOrgName(page, page, 'Housing authorities', wagtail);
    const created = (await (await committed).json()) as { estimatedCount?: number };
    expect(created.estimatedCount).toBe(1);
    await expect(previewButton).toBeEnabled();
    await expect(page.getByText(PREVIEW_HINT, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Reaches 1 recipient', { exact: true })).toBeVisible();
  });
```

Check: `grep -n "draftAuthority(\|'Housing authority'" e2e/tests/dashboard-next/org-lists.spec.ts`
prints only the contact-form uses at the lines that were `:218`, `:395`,
`:428`, `:903`, `:905` (now shifted) - none in a composer test.

**Step 7 - `matching-entry-points.spec.ts`.**

7a. old:

```ts
    // exact: the org picker's listbox and chip buttons may carry this text too.
    await expect(page.getByLabel('Housing authority', { exact: true })).toHaveCount(0);
```

new:

```ts
    // The composer's housing authority filter is the multi picker "Housing
    // authorities" (tracker #6 D3); exact, since the property forms share it.
    await expect(page.getByRole('combobox', { name: 'Housing authorities', exact: true })).toHaveCount(0);
```

7b. old:

```ts
    await expect(page.getByLabel('Housing authority', { exact: true })).toBeVisible();
```

new:

```ts
    await expect(page.getByRole('combobox', { name: 'Housing authorities', exact: true })).toBeVisible();
```

**Step 8 - `e2e/support/selectors.md`** (the lines edited are ASCII).

8a. In the row at line 132 (Property form ... housing authorities), old:

```
The singular `Housing authority` labels the CONTACT form's picker and the composer's filter, and `getByLabel` substring-matches across them - always pass `exact: true` |
```

new:

```
The singular `Housing authority` labels the CONTACT form's picker; the blast composer's filter is this same plural multi-picker `Housing authorities` since tracker #6 (2026-10-14), prefilled from the property, and `getByLabel` substring-matches across all of them - always pass `exact: true` |
```

8b. In the row at line 133 (Org pickers ... options and the add step), old:

```
The composer changes its filter ONLY on a pick or a chip removal, never per keystroke |
```

new:

```
The composer changes its filter ONLY on a pick, a chip removal, or the property prefill (tracker #6 D3: when the property loads its accepted authorities are filled in; choosing a DIFFERENT property empties both filters and fills them from the new one), never per keystroke. In the multi-picker a chosen name is no longer offered as an option - remove its chip to pick it again |
```

8c. In the row at line 134 (text typed but never picked), old:

```
`pickOrgName` stays the deterministic path; `org-lists.spec.ts` pins these behaviors |
```

new:

```
With a property attached and the filters on, Preview also stays disabled until the prefill has settled (the property and the organization list each loaded or failed - tracker #6 D3). `pickOrgName` stays the deterministic path; `org-lists.spec.ts` pins these behaviors |
```

8d. In the row at line 147 (Review recipients), old (from this sentence to
the end of the row):

```
A declined row carries the tag `Not interested` beside `Already sent`; its checkbox is named `<name> - not interested` / `<name> - already sent, not interested` (ASCII " - " on every tag name, including `<name> - already sent` and `<name> - consent not recorded`; the VISIBLE no-consent tag keeps its em dash); a filter-proposed declined row starts unchecked and Select all skips it, a hand-added one stays checked. `Select all` needs `exact: true` (a substring name also matches `Deselect all`). The `Add a tenant` option shows a muted `Not interested` / `Already sent` suffix inside its name |
```

new:

```
A declined row carries the tag `Not interested` beside `Already sent`. A TOUR HOLD (tracker #6 D4: an unresolved tour for ANY property) adds one more amber tag after them: `Tour Oct 20` (upcoming), `Tour Oct 9, not marked`, `Toured Oct 9, needs outcome`, `Toured Oct 9, needs placement`, `No show Oct 9` or `Tour requested Oct 12`; the date is the dashboard's browser-local `shortDate` (with no date the date and its space are dropped), so build the expected label IN THE BROWSER with `page.evaluate` and `toLocaleDateString('en-US', { month: 'short', day: 'numeric' })`, never on the Node side. The checkbox name is `<name>`, plus ` - ` and the cues joined by `, ` in the order `already sent`, `not interested`, then the tour label LOWER-CASED (`<name> - not interested`, `<name> - already sent, not interested`, `<name> - tour oct 20`, `<name> - already sent, tour requested oct 12`); a no-consent row is `<name> - consent not recorded` whatever else applies (ASCII " - " on every name; the VISIBLE no-consent tag keeps its em dash). Which rows START checked is the server's `checkedByDefault` (recorded consent, and seeded or neither already sent, declined nor held): a filter-proposed declined or held row starts unchecked and Select all skips it; a hand-added or hand-promoted one (Add a tenant) stays checked, through Select all too. `Select all` needs `exact: true` (a substring name also matches `Deselect all`). The `Add a tenant` option shows a muted note inside its name: every cue that applies, in the order `Not interested`, `Already sent`, then the tour label, joined by `, `. A tenant the filters leave out (a status other than Onboarding or Searching; while a housing authority is selected, a missing or other authority) is NOT listed at all - add them by hand |
```

8e. Insert ONE new row directly after the line-147 row (before the
`| Property page (Sent to) and Contact page (Properties sent) | ...` row):

```
| Matching composer (filters on) | prefill, caption, reach and the property step | `getByRole('combobox', { name: 'Housing authorities', exact: true })` - a multi-picker since tracker #6 (2026-10-14). Picking a property FILLS it with the property's accepted authorities that are list names (one chip each, `getByRole('button', { name: 'Remove <name>', exact: true })`, in the property's order) and the voucher size with the first accepted size; names not on the list are not used and the note reads `Not used (not on the organization list): <names>` (followed by ` This blast is not limited by housing authority.` when none was used). Under the filters the caption is ONE element: `Only tenants in Onboarding or Searching are included.`, then - only while a name is selected - `While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.`, then `Add any other tenant by hand when you review recipients.`, joined by single spaces (`getByText(<full text>, { exact: true })`). The reach line `Reaches <n> recipient(s)` counts the rows that will START CHECKED on Review recipients (held, declined, already-sent and no-consent rows left out); it shows a pending text while a draft is recreated, so assert the exact final text. The property step (the bare entry and the `?contactId=` entry) offers Available properties only, in both `getByRole('combobox', { name: 'Property' })`'s options and the `getByRole('list', { name: 'Properties', exact: true })` rows - prove an absence only beside a present Available row (`matching-blast-rules.spec.ts`); a `?unitId=` entry keeps its property whatever its status |
```

**Step 9 - static checks (fast, before the e2e run).**

```bash
cd /w/tmp/matching-blast-rules && npm run typecheck -w @housingchoice/e2e > .superpowers/gates/s4-41-typecheck.log 2>&1
echo "EXIT:$?"
```

Expected `EXIT:0` (read the log on a failure).

```bash
cd /w/tmp/matching-blast-rules && npx eslint e2e/tests/dashboard-next/broadcasts.spec.ts e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts e2e/tests/dashboard-next/a2p-compliance.spec.ts e2e/tests/dashboard-next/org-lists.spec.ts e2e/tests/dashboard-next/matching-entry-points.spec.ts
echo "EXIT:$?"
```

Expected `EXIT:0` (the five were clean on main, F22).

ASCII of every ADDED line (expect no output):

```bash
cd /w/tmp/matching-blast-rules && git diff -U0 -- e2e/tests/dashboard-next/broadcasts.spec.ts e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts e2e/tests/dashboard-next/a2p-compliance.spec.ts e2e/tests/dashboard-next/org-lists.spec.ts e2e/tests/dashboard-next/matching-entry-points.spec.ts e2e/support/selectors.md | grep '^+' | grep -v '^+++' | grep -nP '[^\x00-\x7F]'
```

**Step 10 - GREEN.**

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-e2e-files.sh s4-41-green tests/dashboard-next/broadcasts.spec.ts tests/dashboard-next/review-recipients-heard-from.spec.ts tests/dashboard-next/a2p-compliance.spec.ts tests/dashboard-next/org-lists.spec.ts tests/dashboard-next/matching-entry-points.spec.ts > /dev/null 2>&1 & disown
```

Expected `EXIT:0` and every test in the five files passed (0 failed, 0
flaky). A failure is a regression to diagnose (AGENTS.md: there is no
named-flake list); re-run only the failing file to isolate it.

**Step 11 - commit.**

```bash
cd /w/tmp/matching-blast-rules && git status
```

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD PRESENT - STOP" || echo "no MERGE_HEAD"
```

(The path checked is
`W:\AI Projects\Housing Choice\HC Application\.git\worktrees\matching-blast-rules\MERGE_HEAD`.)
Expected: only the six files modified, `no MERGE_HEAD`.

```bash
cd /w/tmp/matching-blast-rules && git add e2e/tests/dashboard-next/broadcasts.spec.ts e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts e2e/tests/dashboard-next/a2p-compliance.spec.ts e2e/tests/dashboard-next/org-lists.spec.ts e2e/tests/dashboard-next/matching-entry-points.spec.ts e2e/support/selectors.md && git commit -F - <<'EOF'
test(e2e): repair the Matching specs for the tracker #6 audience rules - run-unique listed housing authorities, explicit statuses and recorded consent wherever a spec asserts a list or a count; Tasha (Placing) replaced by a run-created already-sent tenant; the a2p no-consent tenants keep none and path (c) keeps the legacy housing_authority string with an echo assertion; the composer picker is "Housing authorities" (prefill, chip removal, any-of reach); selectors.md rows for the prefill, caption, reach, tour tags and Available-only picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4.2 - The new e2e spec (spec section 6)

File: CREATE `e2e/tests/dashboard-next/matching-blast-rules.spec.ts`.

**Step 1 - write the spec** (complete file):

```ts
// e2e/tests/dashboard-next/matching-blast-rules.spec.ts
//
// Matching blasts follow the audience rules (tracker #6; design
// docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md, section 6),
// end to end against the real backend:
//   - the bare Matching entry's property step offers Available properties only (D9);
//   - picking a property fills the "Housing authorities" multi picker with its
//     accepted authorities, and the voucher size with its beds (D3);
//   - the caption under the filters (D8);
//   - the filters reach Searching and Onboarding tenants in ANY of the selected
//     authorities only (D1, D2): a Placing tenant and a tenant with no housing
//     authority are not listed;
//   - a tenant with an unresolved tour for ANY property is listed, unchecked and
//     labeled, and Select all skips them (D4, D5, D7); a tour closed Not a fit
//     holds nothing;
//   - "Reaches N recipients" equals the rows that start checked (D8);
//   - Add a tenant adds the Placing tenant checked (a hand pick skips the rules);
//   - the send reaches exactly the checked tenants (fake-twilio thread store).
//
// ISOLATION: the lane keeps every earlier spec's tenants, so everything here is
// RUN-UNIQUE: two housing authorities added through POST /api/organizations,
// seven tenants, two properties and three tours created through the real
// routes. Nothing is reseeded and nothing seeded is changed. The tours sit on a
// second property left in Setup (a hold counts a tour for ANY property), which
// is also the non-Available property the picker must leave out. The 14-day
// tour-request boundary is unit-tested; no backdating seam exists, by design.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { ORG_PICKER } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The D8 caption with all three sentences (a housing authority is selected). */
const CAPTION = [
  'Only tenants in Onboarding or Searching are included.',
  'While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.',
  'Add any other tenant by hand when you review recipients.',
].join(' ');

interface Tenant {
  contactId: string;
  firstName: string;
  name: string;
  phone: string;
}

interface TourWire {
  tourId: string;
  status: string;
  createdAt: string;
  scheduledAt?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

/** A 2-BR tenant through the real routes, with recorded consent and an EXPLICIT
 *  status. `housingAuthority` must already be a list name: the PATCH applies the
 *  organization-list check (the create ignores the field). */
async function createTenant(
  api: APIRequestContext,
  opts: { firstName: string; status: 'searching' | 'onboarding' | 'placing'; housingAuthority?: string },
): Promise<Tenant> {
  const phone = uniquePhone();
  const lastName = 'Blastrule';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName,
      phone,
      voucherSize: 2,
      status: opts.status,
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  if (opts.housingAuthority !== undefined) {
    const patch = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { housingAuthority: opts.housingAuthority },
    });
    expect(patch.ok(), await patch.text()).toBeTruthy();
  }
  return { contactId, firstName: opts.firstName, name: `${opts.firstName} ${lastName}`, phone };
}

/** A 2-BR property under the seeded landlord; `authorities` must be list names.
 *  New units start in Setup; `available` publishes it through the transition route. */
async function createUnit(
  api: APIRequestContext,
  opts: { line1: string; authorities: string[]; available: boolean },
): Promise<string> {
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: opts.authorities,
      address: { line1: opts.line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (opts.available) {
    const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(flip.ok(), await flip.text()).toBeTruthy();
  }
  return unitId;
}

/** POST /api/tours: with scheduledAt the tour is scheduled; without, a dateless request. */
async function createTour(
  api: APIRequestContext,
  input: { tenantId: string; unitId: string; scheduledAt?: string },
): Promise<TourWire> {
  const res = await api.post(`${NEXT}/api/tours`, {
    data: {
      tenantId: input.tenantId,
      unitId: input.unitId,
      tourType: 'self_guided',
      ...(input.scheduledAt !== undefined && { scheduledAt: input.scheduledAt }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { tour: TourWire }).tour;
}

async function patchTour(api: APIRequestContext, tourId: string, data: Record<string, unknown>): Promise<TourWire> {
  const res = await api.patch(`${NEXT}/api/tours/${tourId}`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: TourWire }).tour;
}

/** The dashboard's tour date ("Oct 20"), computed IN THE BROWSER so it uses the
 *  page's local timezone - the same call as shortDate in
 *  dashboard/src/routes/placements/placementsFormat.ts. */
async function browserShortDate(page: Page, iso: string): Promise<string> {
  return page.evaluate(
    (value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    iso,
  );
}

test('a Matching blast follows the audience rules: status, housing authorities, tour holds, Available-only picker', async ({
  page,
  request,
}) => {
  test.slow();
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);

  // --- Two run-unique listed housing authorities. ---
  const authA = `Wren Rules Authority ${stamp}`;
  const authB = `Finch Rules Authority ${stamp}`;
  await addOrg(api, { kind: 'housing_authority', name: authA });
  await addOrg(api, { kind: 'housing_authority', name: authB });

  // --- The Available property the blast sends (it accepts both authorities),
  // and a second one left in Setup that carries the tours. Both street lines
  // share the run-unique prefix the picker is searched by. ---
  const prefix = `${stamp} Blastrule`;
  const line1 = `${prefix} Ave`;
  const tourLine1 = `${prefix} Tour Ct`;
  const unitId = await createUnit(api, { line1, authorities: [authA, authB], available: true });
  const tourUnitId = await createUnit(api, { line1: tourLine1, authorities: [authA], available: false });

  // --- Seven tenants, all 2-BR with recorded consent and an explicit status. ---
  const searching = await createTenant(api, { firstName: `Searcha${stamp}`, status: 'searching', housingAuthority: authA });
  const onboarding = await createTenant(api, { firstName: `Onboardb${stamp}`, status: 'onboarding', housingAuthority: authB });
  const placing = await createTenant(api, { firstName: `Placinga${stamp}`, status: 'placing', housingAuthority: authA });
  const touring = await createTenant(api, { firstName: `Touringa${stamp}`, status: 'searching', housingAuthority: authA });
  const requesting = await createTenant(api, { firstName: `Requesta${stamp}`, status: 'searching', housingAuthority: authA });
  const notFit = await createTenant(api, { firstName: `Notfita${stamp}`, status: 'searching', housingAuthority: authA });
  const noAuthority = await createTenant(api, { firstName: `Noauth${stamp}`, status: 'searching' });

  // --- Tours, all on the Setup property. ---
  // An upcoming tour five days out.
  const upcoming = await createTour(api, {
    tenantId: touring.contactId,
    unitId: tourUnitId,
    scheduledAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
  });
  expect(upcoming.status).toBe('scheduled');
  expect(upcoming.scheduledAt, 'a scheduled tour carries its time').toBeDefined();
  // A fresh tour request with no date.
  const tourRequest = await createTour(api, { tenantId: requesting.contactId, unitId: tourUnitId });
  expect(tourRequest.status).toBe('requested');
  // notFit's ONLY tour: a request, toured two days ago, then closed Not a fit
  // with the dashboard's Record outcome PATCH.
  const fitTour = await createTour(api, { tenantId: notFit.contactId, unitId: tourUnitId });
  await patchTour(api, fitTour.tourId, {
    status: 'toured',
    scheduledAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
  });
  const closed = await patchTour(api, fitTour.tourId, { outcome: 'not_a_fit', moveForward: false, status: 'closed' });
  expect(closed.status).toBe('closed');

  // --- D9: the bare Matching entry's property step offers Available properties only. ---
  await page.goto(`${NEXT}/broadcasts/new`);
  await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
  const propertyBox = page.getByRole('combobox', { name: 'Property' });
  await propertyBox.fill(prefix);
  await expect(page.getByRole('option', { name: new RegExp(escapeRegExp(line1)) })).toBeVisible();
  await expect(page.getByRole('option', { name: new RegExp(escapeRegExp(tourLine1)) })).toHaveCount(0);
  // Close the typeahead before using the rows under it (its options overlay
  // them; matching-entry-points.spec.ts documents the race).
  await propertyBox.press('Escape');
  await expect(page.getByRole('option'), 'the typeahead dropdown never closed').toHaveCount(0, {
    timeout: 10_000,
  });
  const properties = page.getByRole('list', { name: 'Properties', exact: true });
  const propertyRow = properties.getByRole('button', { name: new RegExp(escapeRegExp(line1)) });
  await expect(propertyRow).toBeVisible();
  await expect(properties.getByRole('button', { name: new RegExp(escapeRegExp(tourLine1)) })).toHaveCount(0);
  await propertyRow.click();

  // --- D3: both accepted authorities fill the multi picker; the voucher size
  // is the property's 2 beds. ---
  await expect(page.getByRole('combobox', { name: 'Housing authorities', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(authA), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(authB), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'true');

  // --- D8: the caption, all three sentences while authorities are selected. ---
  await expect(page.getByText(CAPTION, { exact: true })).toBeVisible();

  // Let the message prefill settle before typing: it is written on property
  // load, then again with the server's ?cta=text link
  // (docs/issues/a2p-consent-reinclude-fill-races-prefill.md).
  const message = page.getByLabel('Message');
  await expect(message).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 15_000 });
  const marker = `Rules check ${stamp}`;
  await message.fill(`${marker} [FlyerLink]`);
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await expect(message).toHaveValue(`${marker} [FlyerLink]`);

  // --- D8: the reach counts the rows that will START CHECKED - searching,
  // onboarding and notFit. touring and requesting are held; placing and
  // noAuthority are not in the audience at all. ---
  const startChecked = [searching, onboarding, notFit];
  await expect(page.getByText(`Reaches ${startChecked.length} recipients`, { exact: true })).toBeVisible();

  await previewBtn.click();
  await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  const rowOf = (t: Tenant) => list.locator('li', { hasText: t.name });
  const boxOf = (t: Tenant, cues = '') => list.getByRole('checkbox', { name: `${t.name}${cues}`, exact: true });

  // Listed and checked: nothing holds them.
  for (const t of startChecked) await expect(boxOf(t)).toBeChecked();

  // Listed, UNCHECKED and labeled: the tour holds (a tour for ANY property, D4, D7).
  const upcomingLabel = `Tour ${await browserShortDate(page, upcoming.scheduledAt as string)}`;
  const requestedLabel = `Tour requested ${await browserShortDate(page, tourRequest.createdAt)}`;
  await expect(rowOf(touring).getByText(upcomingLabel, { exact: true })).toBeVisible();
  await expect(rowOf(requesting).getByText(requestedLabel, { exact: true })).toBeVisible();
  const touringBox = boxOf(touring, ` - ${upcomingLabel.toLowerCase()}`);
  const requestingBox = boxOf(requesting, ` - ${requestedLabel.toLowerCase()}`);
  await expect(touringBox).not.toBeChecked();
  await expect(touringBox).toBeEnabled();
  await expect(requestingBox).not.toBeChecked();
  await expect(requestingBox).toBeEnabled();

  // The reach line equals the rows that start checked.
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(startChecked.length);

  // Not in the audience at all (D1, D2) - asserted after the rows above rendered.
  await expect(rowOf(placing)).toHaveCount(0);
  await expect(rowOf(noAuthority)).toHaveCount(0);

  // --- Select all re-applies the default: the held rows stay unchecked. ---
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(touringBox).not.toBeChecked();
  await expect(requestingBox).not.toBeChecked();
  for (const t of startChecked) await expect(boxOf(t)).toBeChecked();
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(startChecked.length);

  // --- Add a tenant: a hand pick skips the rules, so the Placing tenant joins checked. ---
  await page.getByRole('combobox', { name: 'Add a tenant' }).fill(placing.firstName);
  await page.getByRole('option', { name: new RegExp(escapeRegExp(placing.name)) }).click();
  await expect(rowOf(placing).getByText('Added', { exact: true })).toBeVisible();
  await expect(boxOf(placing)).toBeChecked();

  // --- Send: exactly the checked tenants. ---
  const recipients = [...startChecked, placing];
  await page.getByRole('button', { name: `Send to ${recipients.length} recipients`, exact: true }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });

  const hits = async (t: Tenant): Promise<number> =>
    (await getOutboundTo(request, { to: t.phone })).filter((m) => (m.body ?? '').includes(marker)).length;
  for (const t of recipients) {
    await expect
      .poll(() => hits(t), { timeout: 30_000, message: `${t.firstName} should receive the blast exactly once` })
      .toBe(1);
  }
  // Every recipient's copy has landed, so the fan-out is done: the others got none.
  for (const t of [touring, requesting, noAuthority]) {
    expect(await hits(t), `${t.firstName} must not receive the blast`).toBe(0);
  }
});
```

**Step 2 - static checks.**

```bash
cd /w/tmp/matching-blast-rules && npm run typecheck -w @housingchoice/e2e > .superpowers/gates/s4-42-typecheck.log 2>&1
echo "EXIT:$?"
```

```bash
cd /w/tmp/matching-blast-rules && npx eslint e2e/tests/dashboard-next/matching-blast-rules.spec.ts
echo "EXIT:$?"
```

```bash
cd /w/tmp/matching-blast-rules && tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/matching-blast-rules.spec.ts | wc -c
```

Expected: `EXIT:0`, `EXIT:0`, `0`.

**Step 3 - RED by mutation** (contract issue 1: the behavior shipped in
S1-S3, so prove the spec CAN fail). Edit the spec, old:

```ts
  const startChecked = [searching, onboarding, notFit];
```

new (temporary):

```ts
  const startChecked = [searching, onboarding, notFit, touring];
```

Run:

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-e2e-files.sh s4-42-red tests/dashboard-next/matching-blast-rules.spec.ts > /dev/null 2>&1 & disown
```

Expected `EXIT:1`, the one test failing at
`getByText('Reaches 4 recipients', { exact: true })` (the server's count is
3: the upcoming tour holds `touring`). A failure ANYWHERE EARLIER (setup,
picker, prefill, caption) is not the mutation: diagnose it before going on.
Then revert the edit exactly (back to `[searching, onboarding, notFit]`).

**Step 4 - GREEN.**

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-e2e-files.sh s4-42-green tests/dashboard-next/matching-blast-rules.spec.ts > /dev/null 2>&1 & disown
```

Expected `EXIT:0`, `1 passed`. `git diff --stat` must show no change to the
spec from the mutation (`grep -n "notFit, touring\]" e2e/tests/dashboard-next/matching-blast-rules.spec.ts`
prints nothing).

**Step 5 - commit.**

```bash
cd /w/tmp/matching-blast-rules && git status
```

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD PRESENT - STOP" || echo "no MERGE_HEAD"
```

Expected: only the new spec untracked, `no MERGE_HEAD`.

```bash
cd /w/tmp/matching-blast-rules && git add e2e/tests/dashboard-next/matching-blast-rules.spec.ts && git commit -F - <<'EOF'
test(e2e): matching-blast-rules spec (tracker #6 section 6) - the property step offers Available properties only; both run-unique authorities prefill the Housing authorities picker; the caption; the reach equals the rows that start checked; Placing and no-authority tenants are not listed; an upcoming tour and a fresh tour request hold their tenants unchecked with labels and Select all skips them, a tour closed Not a fit holds nothing; Add a tenant adds the Placing tenant checked; the send reaches exactly the checked tenants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4.3 - Docs: GLOSSARY, RUNBOOK, the issue registry

Files: `documentation/GLOSSARY.md`, `RUNBOOK.md`,
`docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`.
No test (docs only); verified by the checks in Step 5. Do NOT file any issue
about removing the `byHousingAuthority` GSI or `listByHousingAuthority`
(Cameron keeps them, spec section 4). The deferred caseworker search is
ALREADY filed (`docs/issues/matching-add-recipient-search-caseworkers.md`,
status deferred) - leave it as is.

**Step 1 - GLOSSARY, the Matching entry** (`documentation/GLOSSARY.md:117-124`).
old:

```
  routes, jobs, tables, and log fields all keep their names - only displayed
  copy follows the audience rule.
```

new:

```
  routes, jobs, tables, and log fields all keep their names - only displayed
  copy follows the audience rule.
  **Who a blast reaches** (tracker #6, 2026-10-14): the filters reach only
  tenants in Onboarding or Searching; the housing authority filter is a LIST
  prefilled from the property's **accepted authorities** - a tenant matches ANY
  of them, and while it holds a name a tenant whose housing authority is
  missing or not one of them is left out; and a tenant with an unresolved tour
  for ANY property (an upcoming tour, a past tour not marked, a toured tour
  waiting on an outcome or a placement, a no-show, or a tour request under 14
  days old) is a **tour hold**: listed on Review recipients with a label such
  as "Tour Oct 20", but left unchecked. Tenants left out by status or housing
  authority are not listed at all. A tenant picked by hand skips these rules
  (a held one keeps its label but starts checked), and caseworkers are never
  added by the filters. "Reaches N recipients" counts the recipients that will
  start checked, and the property picker offers Available properties only.
  Design: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`.
```

**Step 2 - GLOSSARY, the housing authority entry** (`:321-323`). old:

```
  has EXACTLY ONE (`contact.housingAuthority`, the `byHousingAuthority` GSI
  hash); a property lists the ones it accepts (**accepted authorities**, below).
```

new:

```
  has EXACTLY ONE (`contact.housingAuthority`, the `byHousingAuthority` GSI
  hash - the GSI is kept, but since tracker #6 (2026-10-14) a Matching blast no
  longer reads it: the blast reads Searching and Onboarding tenants and compares
  this value with the filter's names in memory); a property lists the ones it
  accepts (**accepted authorities**, below).
```

**Step 3 - RUNBOOK** (`RUNBOOK.md:1455-1457`, "Housing authority: why an
extracted one sometimes arrives as a suggestion"). old:

```
names from the organization list (Settings > Housing authorities & agencies), because broadcast
audience resolution is an exact hash match on the `byHousingAuthority` GSI. The AI's apply layer
```

new:

```
names from the organization list (Settings > Housing authorities & agencies), because a Matching
blast's housing authority filter matches a tenant's stored value against list names exactly (any
of the names the filter holds; since tracker #6, 2026-10-14, the blast no longer reads the
`byHousingAuthority` GSI, which is kept). The AI's apply layer
```

**Step 4 - resolve the truncation issue.** Get the date once:

```bash
date +%F
```

Use that literal value (expected `2026-10-14`, or the build day) as DATE
below. In `docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`:

4a. frontmatter, old:

```
status: open
area: app
created: 2026-08-26
```

new (DATE substituted):

```
status: resolved
area: app
created: 2026-08-26
resolved: DATE
```

4b. Append at the end of the file (after the "Reopen / escalate" paragraph,
one blank line before it; DATE substituted):

```
**Resolution (DATE, feat/matching-blast-rules, tracker #6).** The resolver no
longer reads the unwanted statuses at all, which is suggested fix 2 (a
status-aware cut). A Matching blast's filter audience is now tenants in
`searching` or `onboarding` only (spec
`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` D1), read
as two explicit `byTypeStatus` partitions - `searching` FIRST, then
`onboarding` - under the same `maxPages` x `pageSize` bound and the same
truncation flag. A cut can therefore no longer keep `inactive` (or any other
unwanted status) in place of `searching` tenants: within the wanted set the
read order is searching first. The housing authority became an in-memory
filter over those two partitions, so the `byHousingAuthority` read is gone
from this path (the GSI itself is kept, unused by blasts). The bound and the
truncation refusal remain: a truncated filter send is still refused, and the
review step says the list is incomplete. The
`TODO(broadcast-audience-truncation-drops-searching-tenants)` marker in
`app/src/services/audienceResolution.ts` went with the rewrite.
`listByType`'s shared ascending order is unchanged.
```

**Step 5 - checks.**

```bash
cd /w/tmp/matching-blast-rules && grep -rn "TODO(broadcast-audience-truncation-drops-searching-tenants)" app dashboard e2e scripts
```

Expected: no output (S1 removed the marker with the resolver rewrite, spec
section 7 "the truncation TODO"). If it prints a line, STOP and report it to
the orchestrator as an S1 leftover - do not resolve an issue whose marker
still stands.

```bash
cd /w/tmp/matching-blast-rules && npm run issues > .superpowers/gates/s4-43-issues.log 2>&1
echo "EXIT:$?"
```

Expected `EXIT:0` and no warning line naming
`broadcast-audience-truncation-drops-searching-tenants`
(`grep -n "broadcast-audience-truncation" .superpowers/gates/s4-43-issues.log`
shows none in a warning). `docs/issues/INDEX.md` is gitignored - never stage it.

```bash
cd /w/tmp/matching-blast-rules && git diff -U0 -- documentation/GLOSSARY.md RUNBOOK.md docs/issues/broadcast-audience-truncation-drops-searching-tenants.md | grep '^+' | grep -v '^+++' | grep -nP '[^\x00-\x7F]'
```

Expected: no output.

```bash
cd /w/tmp/matching-blast-rules && grep -n "byHousingAuthority" RUNBOOK.md documentation/GLOSSARY.md
```

Expected: exactly the two edited mentions, each saying the GSI is kept and
no longer read by the blast.

**Step 6 - commit.**

```bash
cd /w/tmp/matching-blast-rules && git status
```

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD PRESENT - STOP" || echo "no MERGE_HEAD"
```

```bash
cd /w/tmp/matching-blast-rules && git add documentation/GLOSSARY.md RUNBOOK.md docs/issues/broadcast-audience-truncation-drops-searching-tenants.md && git commit -F - <<'EOF'
docs(glossary,runbook,issues): tracker #6 audience rules - the Matching entry says who a blast reaches (Onboarding and Searching only, any-of housing authorities prefilled from the property, tour holds listed unchecked, reach = rows that start checked, Available-only picker); byHousingAuthority kept but no longer the blast key (glossary, RUNBOOK); resolve broadcast-audience-truncation-drops-searching-tenants (status-aware read, searching first)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4.4 - The five completion gates (AGENTS.md "Required completion gates")

No commit (logs are gitignored; the handback in Task 4.5 records them).

**Step 0 - shortcut (contract issue 3).**

```bash
cd /w/tmp/matching-blast-rules && git rev-list --count HEAD..main
```

(`main` is a local branch shared by every worktree; the count is what main
has that the branch lacks.) If it prints a number above 0, you MAY do Task
4.5 Steps 1-5 now (the single sync) and then run this task once on the
post-sync tree; then skip Task 4.5 Step 6.

**Step 1 - preconditions.**

```bash
cd /w/tmp/matching-blast-rules && git status && git log --oneline -1 && test -x node_modules/.bin/eslint && echo "node_modules OK"; test -f e2e/.artifacts/session.pid && echo "SESSION PID FILE PRESENT"
```

Expected: clean tree, `node_modules OK`, no session line (if it prints, run
`npm run e2e:stop` and confirm the lane ports free). Make sure DynamoDB
Local is up (idempotent - it says "already running" when it is; it never
restarts the shared container):

```bash
cd /w/tmp/matching-blast-rules && npm run db:start
```

AWS check (AGENTS.md: an exported key silently changes `npm test`):

```bash
env | grep '^AWS_'
```

The gate script below always runs `npm test` as
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` (AGENTS.md's
own form; identical to bare `npm test` when nothing is exported). Record in
the handback whether anything was exported.

**Step 2 - the gate script.** Create `.superpowers/gates/run-gates.sh`:

```bash
#!/usr/bin/env bash
# The five completion gates (AGENTS.md), in order, each BARE: every gate is
# the LAST command on its line and its exit code is written on the NEXT line.
# Usage: bash .superpowers/gates/run-gates.sh <label>
cd /w/tmp/matching-blast-rules || exit 99
OUT=".superpowers/gates/$1"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
echo "label $1 commit $(git rev-parse HEAD) start $(date -Is)" > "$SUMMARY"
timeout 900 npm run typecheck > "$OUT/1-typecheck.log" 2>&1
echo "gate1 typecheck exit=$?" >> "$SUMMARY"
timeout 2400 env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test > "$OUT/2-test.log" 2>&1
echo "gate2 test exit=$?" >> "$SUMMARY"
timeout 600 npm run smoke > "$OUT/3-smoke.log" 2>&1
echo "gate3 smoke exit=$?" >> "$SUMMARY"
timeout 2700 npm run e2e > "$OUT/4-e2e.log" 2>&1
echo "gate4 e2e exit=$?" >> "$SUMMARY"
git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' > "$OUT/5-lint-files.txt"
if [ -s "$OUT/5-lint-files.txt" ]; then
  npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') > "$OUT/5-lint.log" 2>&1
  echo "gate5 lint exit=$?" >> "$SUMMARY"
else
  echo "gate5 lint SKIPPED - main...HEAD lists no .ts/.tsx/.js/.mjs/.cjs file" >> "$SUMMARY"
fi
echo "end $(date -Is)" >> "$SUMMARY"
```

Gate 5 traps this script already handles (AGENTS.md): it lists the
branch's files with `main...HEAD` (a bare `git diff --name-only` lists
unstaged changes and is EMPTY on a committed branch), and it SKIPS when the
list is empty (a bare `npx eslint` lints the whole repo and fails on the
23 pre-existing errors). It will not be empty here (S1-S4 touch `.ts` and
`.tsx` files). `.mjs`/`.js` files are linted by NO rule (AGENTS.md known
hole) - a green result on them checks nothing.

**Step 3 - run it detached** (never stop it midway - TaskStop on Windows
leaves the next gate running as an orphan):

```bash
cd /w/tmp/matching-blast-rules && nohup bash .superpowers/gates/run-gates.sh final > .superpowers/gates/final-runner.out 2>&1 & disown
```

Wait with Monitor, command
`cd /w/tmp/matching-blast-rules && until grep -q '^end ' .superpowers/gates/final/summary.txt; do sleep 30; done`
(re-arm until it ends; the whole run is about 35-45 minutes). Edit nothing
in the worktree while it runs.

**Step 4 - read the verdict from the logs.**

```bash
cd /w/tmp/matching-blast-rules && cat .superpowers/gates/final/summary.txt
```

```bash
cd /w/tmp/matching-blast-rules && grep -nE "Test Files|Tests |\[dynamoAdmin\]|npm error" .superpowers/gates/final/2-test.log
```

```bash
cd /w/tmp/matching-blast-rules && grep -n "smoke-dist" .superpowers/gates/final/3-smoke.log
```

```bash
cd /w/tmp/matching-blast-rules && grep -nE " passed| failed| flaky| skipped|npm error code" .superpowers/gates/final/4-e2e.log
```

Expected: gates 1-4 `exit=0`; npm test with every workspace's test files
passed and no `[dynamoAdmin]` line; smoke prints `smoke-dist: OK ...`; e2e
`N passed` with 0 failed and 0 flaky (N = the main count plus this
branch's 1 new test). Gate 5: `exit=0`, or `exit=1` with ONLY pre-existing
errors (Step 5).

On a red gate:
- gate 4: isolate the failing file first
  (`bash .superpowers/gates/run-e2e-files.sh s4-44-isolate <file>`, launched
  detached as above); a named-spec failure is a REGRESSION to diagnose
  (AGENTS.md has no named-flake list). For an intermittent CONTENT failure
  the child logs help (`E2E_CHILD_LOG_DIR=.artifacts/child-logs`), never
  for a hang or timing failure (they change the timings).
- gate 2 red on DynamoDB Local suites: re-run the failing FILE alone more
  than once (`cd app && npx vitest run test/<file>`), run the suite at the
  branch's merge base, compare failing FILES, report both runs. Any
  `[dynamoAdmin]` line is a real container fault: capture its
  `err.$metadata.httpStatusCode` and `attempts` first.
- any fix is a new commit, then the WHOLE gate script runs again with a new
  label (`final-2`, ...); report every run.

**Step 5 - gate 5 baseline comparison (only when gate 5 exited 1).**
Attribute by baseline, never by line number. For EACH file
`.superpowers/gates/final/5-lint.log` names with an error, with REL its
repo-relative path (forward slashes):

```bash
cd /w/tmp/matching-blast-rules && BASE=$(git merge-base main HEAD) && mkdir -p .superpowers/gates/lint-base && git show "$BASE:REL" > .superpowers/gates/lint-base/base.txt && npx eslint --stdin --stdin-filename "REL" < .superpowers/gates/lint-base/base.txt > .superpowers/gates/lint-base/base.log 2>&1
echo "EXIT:$?"
```

```bash
cd /w/tmp/matching-blast-rules && npx eslint "REL" > .superpowers/gates/lint-base/head.log 2>&1
echo "EXIT:$?"
```

```bash
cd /w/tmp/matching-blast-rules && grep -oE "(react-hooks|@typescript-eslint)/[a-z-]+" .superpowers/gates/lint-base/base.log | sort | uniq -c
```

```bash
cd /w/tmp/matching-blast-rules && grep -oE "(react-hooks|@typescript-eslint)/[a-z-]+" .superpowers/gates/lint-base/head.log | sort | uniq -c
```

(A file absent at BASE - `git show` fails - is new: every error in it is
this branch's.) Any rule whose HEAD count exceeds its BASE count in a file
is this branch's and BLOCKING: fix it (a new commit) and re-run the gates.
The rest are pre-existing; name them in the handback. Known baseline (F22):
`dashboard/src/routes/broadcasts/BroadcastComposer.tsx` 4
`react-hooks/set-state-in-effect`, `dashboard/src/routes/broadcasts/useComposerDraft.ts`
1 `react-hooks/refs`.

---

### Task 4.5 - The single main sync and the handback

**Step 1 - clean tree and drift.**

```bash
cd /w/tmp/matching-blast-rules && git status && git rev-list --count HEAD..main && git log --oneline HEAD..main
```

Expected: clean. If the count is 0, the sync is a no-op: record
"`git merge --no-commit main` -> Already up to date." after running Step 3,
and skip Steps 4-6.

**Step 2 - preview conflicts without touching the tree.**

```bash
cd /w/tmp/matching-blast-rules && git merge-tree --write-tree HEAD main
echo "EXIT:$?"
```

`EXIT:0` = merges cleanly. `EXIT:1` = conflicts, listed in the output. If a
conflict is in a file this branch changed for tracker #6, it is resolved in
Step 4 preserving BOTH sides' intent. If it is in work that is not this
branch's and its intent is unclear, STOP and report to the orchestrator
before merging (AGENTS.md: ask before a sync that could conflict with
active work).

**Step 3 - merge.**

```bash
cd /w/tmp/matching-blast-rules && git merge --no-commit main
echo "EXIT:$?"
```

**Step 4 - resolve, verify, commit the merge** (only when Step 3 merged
something). Resolve each conflicted file with the Edit tool (never a
PowerShell rewrite), keeping both sides' behavior; stage ONLY the files
`git status` lists as merged or resolved, by explicit path (never
`git add -A`). Then:

```bash
cd /w/tmp/matching-blast-rules && git status
```

```bash
cd /w/tmp/matching-blast-rules && git diff --name-only --cached | grep -nE "(^|/)package(-lock)?\.json$"
```

If that prints a path, main changed dependencies: after the merge commit
run `cd /w/tmp/matching-blast-rules && npm install` (app runtime deps live
in `app/package.json`; nothing else changes).

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD present (expected mid-merge)"
```

```bash
cd /w/tmp/matching-blast-rules && git commit -F - <<'EOF'
Merge main into feat/matching-blast-rules (the single pre-handback sync)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD STILL PRESENT - STOP" || echo "no MERGE_HEAD"
```

**Step 5 - record the sync.** Note for the handback: main's tip before the
merge (`git rev-parse main`), the merge commit (`git rev-parse HEAD`), the
files main brought (`git diff --stat HEAD^1 HEAD`), and any conflicts and
how each was resolved.

**Step 6 - re-run the gates when anything merged.** Run Task 4.4 Steps 1-5
again with the label `post-sync` (`bash .superpowers/gates/run-gates.sh post-sync`,
launched detached). The handback reports this run as the final one (and
the pre-sync run beside it). If main moves again after this point, do NOT
sync again: report the drift (`git rev-list --count HEAD..main`) in the
handback (AGENTS.md: sync once).

**Step 7 - write the handback** to
`docs/superpowers/reviews/2026-10-14-matching-blast-rules/handback.md`
(ASCII; every value comes from a log or a git command - never from memory or
a task notification). Use exactly these sections:

````
# Handback - feat/matching-blast-rules (tracker #6 Matching blasts follow the audience rules)

Build orchestrator, <date>. Worktree `W:\tmp\matching-blast-rules`, branch
`feat/matching-blast-rules`. Spec:
`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` (APPROVED
rev 5). Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md`.

**VERDICT: <MERGE-READY | NOT READY - reason> on feat/matching-blast-rules
(W:\tmp\matching-blast-rules) at <commit>; <n> behind main @<main tip>;
UNMERGED (human gate). Not deployed.**

## Gates on the final commit (bare, from the worktree root)

Gate commit: `<HEAD at the final gate run>`. Main sync: <"Already up to
date." | merge commit <sha> bringing <n> commits, conflicts: <none | list>>.
AWS variables exported in the gate shell: <none | names> (npm test ran as
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test`).

| gate | command | exit | counts |
|---|---|---|---|
| 1 | `npm run typecheck` | <from summary.txt> | - |
| 2 | `npm test` | <exit> | <per workspace: files / passed / skipped>; `[dynamoAdmin]` lines: <0 or the captured fault> |
| 3 | `npm run smoke` | <exit> | <the smoke-dist line> |
| 4 | `timeout 2700 npm run e2e` | <exit> | <passed / failed / flaky, duration> |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (<n> files) | <exit> | <new errors: 0 | list>; pre-existing (baseline-compared): <list, e.g. BroadcastComposer.tsx react-hooks/set-state-in-effect x4, useComposerDraft.ts react-hooks/refs x1> |

<Every earlier gate run, with its label and what changed between runs.>

## Work map - shipped / deviated / skipped

| slice | status | notes |
|---|---|---|
| S1 app foundations (1.1-1.5) | <SHIPPED / deviations> | <...> |
| S2 app rules in the routes (2.1-2.5) | <...> | <...> |
| S3 dashboard (3.1-3.6) | <...> | <...> |
| S4 e2e, docs, completion (4.1-4.5) | <...> | 5 specs repaired + selectors.md; new `matching-blast-rules.spec.ts`; GLOSSARY, RUNBOOK; issue resolved |

## Issues

Resolved: `broadcast-audience-truncation-drops-searching-tenants`.
Already filed (deferred, unchanged): `matching-add-recipient-search-caseworkers`.
Not filed, by Cameron's ruling: any removal of the `byHousingAuthority` GSI
or `listByHousingAuthority` (kept, unused by blasts).
Filed during the build: <none | slugs>.

## Tracker #6 note (paste as is)

Matching blasts now reach only tenants in Onboarding or Searching, fill the
housing authority filter from the property's accepted housing authorities,
and list tenants who have an open tour or a recent tour request unchecked
with a label such as "Tour Oct 20". The "Reaches N recipients" line now
counts the recipients that will start checked, and the property picker
offers Available properties only. Staff can still add any tenant by hand on
the review step.

## What Sam may notice (spec section 4)

- Tenants in Needs review, Placing, Placed, On hold or Inactive no longer
  appear in a filtered blast; flyer sign-ups (Needs review, no authority)
  stay out until staff move them.
- With housing authorities selected, tenants with none recorded are left
  out (the caption says so); add them by hand or clear the filter.
- The reach count is usually smaller than before for the same filters.
- A property must be Available to be picked on the Matching page and on a
  tenant's or caseworker's page (the property page's Send keeps the Make
  Available dialog).
- Changing the property replaces edited filters with the new property's
  prefill.

## Post-merge - OWED (Cameron)

- Merge (human gate) and deploy (Cameron's call). No Terraform, no SSM, no
  secrets, no backfill, no data migration: stored drafts with the old
  one-string filter are read through the server normalizer, and the
  `byHousingAuthority` GSI stays in place.
````

Fill every `<...>` from the logs and git; delete none of the sections.
The tracker note is three sentences, third person, no "you" (checked:
`grep -niw "you" docs/superpowers/reviews/2026-10-14-matching-blast-rules/handback.md`
prints no line from the "Tracker #6 note" section).

**Step 8 - commit the handback.**

```bash
cd /w/tmp/matching-blast-rules && tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-14-matching-blast-rules/handback.md | wc -c
```

Expected `0`.

```bash
cd /w/tmp/matching-blast-rules && git status
```

```bash
cd /w/tmp/matching-blast-rules && test -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" && echo "MERGE_HEAD PRESENT - STOP" || echo "no MERGE_HEAD"
```

```bash
cd /w/tmp/matching-blast-rules && git add docs/superpowers/reviews/2026-10-14-matching-blast-rules/handback.md && git commit -F - <<'EOF'
docs(records): matching-blast-rules handback - five bare gates with exit codes, the single main sync, the work map, issues, the tracker #6 note and what is owed (merge and deploy only, no infra)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

STOP. Do not merge into main, do not deploy, do not delete the worktree or
the branch.

---

### Spec coverage map

| Spec item | Where S4 covers it |
|---|---|
| Section 6 e2e: one property, two run-unique listed authorities (addOrg) | 4.2 (authA, authB, `createUnit` with both) |
| Section 6: seven tenants with explicit status, authority, consent | 4.2 (`createTenant` x7) |
| Section 6: both authorities prefilled | 4.2 (two `Remove <name>` chips) |
| Section 6: the caption | 4.2 (`CAPTION`, three sentences) |
| Section 6: reach equals the checked count | 4.2 (`Reaches 3 recipients` + 3 checked boxes, twice) |
| Section 6: Placing and no-authority absent | 4.2 (`rowOf(...)` count 0 after rows render) |
| Section 6: two held tenants unchecked with labels; Select all leaves them | 4.2 (labels, lower-cased accessible names, Deselect all then Select all) |
| Section 6: picker lists only Available properties | 4.2 (bare entry: option and row present for the Available unit, absent for the Setup one) |
| Section 6: Add a tenant adds the Placing tenant checked | 4.2 (`Added` tag, checked box) |
| Section 6: the send reaches exactly the checked tenants (outbox) | 4.2 (`getOutboundTo` = 1 for 4, 0 for 3) |
| Section 6: 14-day boundary unit-tested, no backdating seam | 4.2 header comment; nothing added |
| D4 closed Not a fit holds nothing | 4.2 (`notFit` listed and checked) |
| Section 7 e2e: broadcasts test 1 and "non-Available warns" | 4.1 Step 3 |
| Section 7 e2e: review-recipients-heard-from | 4.1 Step 4 |
| Section 7 e2e: a2p 8.3 test 1 (authority) and path (c) legacy string kept, no-consent exception | 4.1 Step 5 (plus the echo assertion of the D2 normalizer) |
| Section 7 e2e: org-lists draftAuthority, composer tests, label, consent for the reach | 4.1 Step 6 |
| Section 7 e2e: matching-entry-points :290, :325 | 4.1 Step 7 |
| Section 7: selectors.md :132-134, :147 | 4.1 Step 8 (plus one new composer row) |
| Section 7 Docs: GLOSSARY Matching entry and :322 | 4.3 Steps 1-2 |
| Section 7 Docs: RUNBOOK:1457 | 4.3 Step 3 |
| Section 4 / 7: resolve the truncation issue; no GSI issue | 4.3 Step 4 (and the explicit "do not file") |
| D3 prefill ownership (chip removal is an edit; typed text is no filter) | 4.1 Step 6 (org-lists composer tests) |
| D2 any-of list in the reach | 4.1 Step 6e (pipit + wagtail, `estimatedCount` 1) |
| D6 path (c) legacy filter still sends and counts skipped_no_consent | 4.1 Step 5 (a2p path (c), kept green) |
| D9 Available-only on `?contactId=` and `?unitId=` entries | not e2e-asserted (S3 unit tests); fact F21: the existing `?contactId=` specs pick fresh Available units, and broadcasts.spec.ts test 2 keeps a Setup unit through `?unitId=` (its banner and Make Available dialog) |
| D10, D3b, D5 503 / seeds-only notice, truncation copy | not e2e (S1-S3 unit tests) |
| AGENTS.md completion gates (five, bare, traps, AWS, baseline) | 4.4 |
| AGENTS.md single main sync; handback contract; no merge/deploy | 4.5 |

### Notes for other slices

- S3 - the e2e reads these exact shapes; keep them or raise a contract issue:
  - the composer's picker is `getByRole('combobox', { name: 'Housing authorities', exact: true })`
    and each chosen name a button `Remove <name>` (OrgPicker multi chips);
  - the caption is ONE element whose whole text is the joined sentences
    (single spaces, no other text inside it) - `getByText(CAPTION, { exact: true })`;
  - the reach line keeps today's one-span shape `Reaches <strong>N</strong>
    recipient(s)` (F11) and shows a different text while pending;
  - `ORG_FILTER_TYPED_HINT` (`dashboard/src/routes/orgs/orgCopy.ts:177`,
    "Pick the housing authority from the list, or clear the text.") is
    unchanged - org-lists.spec.ts asserts it;
  - the draft create body carries `audience_filter.housing_authorities`
    (omitted or `[]` when no name) and never `housing_authority`;
  - the 2-BR chip's accessible name still starts `2-BR` and the
    "matches property" tag stays (broadcasts.spec.ts:149-151);
  - the property step keeps `<ul aria-label="Properties">` with button rows
    and the `Property` combobox, both offering Available properties only;
  - the tour tag's visible text is exactly the 1.1 label in its OWN element
    (so `row.getByText('Tour Oct 19', { exact: true })` resolves), the row
    keeps one `li` and one checkbox, the `Added` tag stays;
  - on a FILTER draft's review step, keep `role="status"` to what today
    renders (the no-consent count is the only one when a no-consent row is
    listed): a2p-compliance.spec.ts:392 reads a page-level `getByRole('status')`;
  - lint: `BroadcastComposer.tsx` already carries 4
    `react-hooks/set-state-in-effect` and `useComposerDraft.ts` 1
    `react-hooks/refs` error on main (F22). Gate 5 blocks on any NEW one, so
    the prefill / settle effects must not call setState synchronously in an
    effect body (set it from the load promise's callbacks or an event).
- S1 - remove the `TODO(broadcast-audience-truncation-drops-searching-tenants)`
  marker with the resolver rewrite (Task 4.3 Step 5 checks it). The create
  echo for a LEGACY one-string body must be `housing_authorities: [<name>]`
  with no `housing_authority` key (a2p path (c) test asserts it).
- S2 - a filter draft with NO `unitId` (the a2p path (c) test) makes no
  decline read and still sends through path (c); `estimatedCount` in the
  201 is the `checkedByDefault` count (org-lists.spec.ts reads it from the
  201 body); the open-tours read must hold `requested` tours created moments
  ago (createdAt = now) and `scheduled` tours on a Setup property.
- Orchestrator - the worktree had no `node_modules` at plan time (F23): run
  `npm ci` in it before S1's first test run. Keep no `e2e:session` running
  in this worktree during S4 (F24). Refresh the Claude project-memory topic
  `matching-blast-rules` and its index line before handing back (Claude
  feature-mission profile, memory contract).
