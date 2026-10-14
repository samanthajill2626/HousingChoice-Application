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
- Status: PLAN SKELETON (sections 0-3 BINDING). Slice sections 5-8 are
  assembled from opus section drafts; section 4 (assembly rulings) wins over
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
from S1 and on the prefill from S3 - S4 repairs them).

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

(Filled at assembly.)
