<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-10-13).** This document describes how
> this work was *planned at the time of writing*. The work shipped to `main` (release 1.5.4,
> deployed to dev and prod 2026-10-13) and its feature branch + worktree were deleted during
> cleanup. **This file is NOT current documentation and the live code may have drifted from it -
> do not treat it as authoritative guidance on how the system should be built or behaves today.**
> For current truth read the code and the living docs (`RUNBOOK.md`, `documentation/GLOSSARY.md`,
> `e2e/README.md`). Kept only as a point-in-time record of intent; the review record is in
> `docs/superpowers/reviews/2026-10-12-last-heard-from/`.

# Implementation plan - Last heard from, follow-up status for shared properties, C6

- Spec (the contract - read it in full before Task 1.1, section 14 LAST and
  with the knowledge that it overrides anything earlier):
  `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
  (APPROVED revision 6 @cad93026).
- Branch `feat/last-heard-from`, worktree `W:\tmp\last-heard-from`, cut from
  main @19607658, main merged @f6aba402 (2026-10-13). Mission records:
  `docs/superpowers/reviews/2026-10-12-last-heard-from/`.
- Plan research (findings committed, references gitignored):
  `docs/superpowers/reviews/2026-10-12-last-heard-from/plan-research/*-findings.md`
  and `.superpowers/sdd/plan-research/*-reference.md` (byte-exact quotes with
  current line numbers; read the reference for your slice before its first
  task - every citation below is verified there).
- Status: PLAN v3 (planner, 2026-10-13) - plan review CLOSED: round 1 (21 findings, 15 rulings) and round 2 (6 findings, precision-only, terminal) folded in. Adjudications: `docs/superpowers/reviews/2026-10-12-last-heard-from/design-review/adjudications.md` ("Plan review").

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  that is already green on unchanged code - write it, confirm it passes,
  keep it; every task still has at least one real RED case.
- Commits: `git status` first (a separate read), explicit paths only (never
  `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: <the authoring model's name> <noreply@anthropic.com>`.
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for edited files check the added lines of `git diff`. Where an EXISTING
  line you edit carries a non-ASCII character (several accessible names use
  an em dash), replacing it with ASCII is part of the task, never reformat
  around it.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit tool DECODES `\u` escapes - never type a `\u`
  escape through it.
- Run commands with absolute paths (`cd "W:/tmp/last-heard-from/app"` etc.);
  the shell's working directory resets between calls.
- Setup, FIRST: `cd "W:/tmp/last-heard-from"; npm ci` (the worktree has NO
  node_modules yet). DynamoDB Local: `npm run db:start` (a START of a stopped
  container is fine). NEVER restart, stop or remove the shared DynamoDB Local
  container - it holds Cameron's local dev data and another agent's lanes.
  If it misbehaves, stop and report.
- Unit runs while building: app `cd "W:/tmp/last-heard-from/app"; npx vitest
  run test/<file>`; dashboard `cd "W:/tmp/last-heard-from/dashboard"; npx
  vitest run src/<path>`; typecheck `cd "W:/tmp/last-heard-from"; npm run
  typecheck`. Never pipe a gate command.
- e2e only through `npm run e2e` from the worktree root (or the lane session
  scripts). Never edit dashboard/app source while this worktree's e2e runs
  (the lane serves source live). Ops scripts: an agent runs the backfill ONLY
  as `--env local --lane <L>`; bare `--env local` is the human's live stack.
- Code names say `unit`; staff copy says "property" (GLOSSARY).
- PARALLEL BRANCH: another agent builds caseworker fixes and then tracker
  #14-adjacent work in its own worktree. Keep every edit to shared files
  (`api/types.ts`, `endpoints.ts`, `contactsRepo.ts`, `seed/*`, `GLOSSARY.md`,
  `e2e/scenarios/steps.ts`) minimal, local and ADDITIVE (new members after the
  existing ones, no reformatting), so whichever branch merges second resolves
  a small, mechanical conflict. Never touch another worktree.

## 1. Global constraints (verbatim from the spec, sections 5 and 14)

| name | value |
|---|---|
| contact attribute | `last_heard_from_at?: string` (ISO 8601, canonical `toISOString()` form, forward-only, never an index key) |
| writer | `contactsRepo.touchLastHeardFrom(contactId, at)` -> `'written' \| 'skipped' \| 'failed'`, never throws; condition `attribute_exists(contactId) AND (attribute_not_exists(last_heard_from_at) OR last_heard_from_at < :at)`; normalizes `at` with `Date.parse` and returns `'skipped'` on an unparseable input (and logs at warn) |
| attribution | `attributeInbound(row, thread, lookup): Promise<string \| undefined>` in `app/src/lib/heardFrom.ts`; discriminated by THREAD TYPE; a `relay_retry_of` row is never attributed; email rows with `email_new_address: true` are never attributed |
| outcome module | `app/src/lib/listingSendOutcome.ts` (NOT `sendOutcome.ts`, which exists) |
| outcome type | `ListingSendOutcome = 'no_reply' \| 'replied' \| 'interested' \| 'not_interested'` |
| decline record | `listing_sends.declined?: { at: string; by: 'staff' \| 'engine'; staffId?: string }` |
| effective decline | `declined !== undefined && (sentAt === undefined \|\| declined.at >= sentAt) && (tourActivityAt === undefined \|\| declined.at >= tourActivityAt)` |
| tour activity | `deriveTourActivityAt(tours)` in `lib/listingSendTour.ts` = max over QUALIFYING tours of `max(createdAt, lastMarkedAt)`; never `updatedAt` |
| precedence | not_interested > interested > replied > no_reply; a non-tenant recipient never reads a tour |
| eligibility | `isEligibleRecipient(c)`: not deleted, not `sms_opt_out`, not `sms_unreachable`, has a phone, and not (`type === 'tenant'` and `status in {inactive, placed}`) |
| thresholds | `FOLLOW_UP_QUIET_MS = 24 * 3600 * 1000`; `FOLLOW_UP_LOOKBACK_MS = 14 * 86400 * 1000` |
| waiting row | outcome in {no_reply, replied} AND eligible AND `now - sentAt <= LOOKBACK` AND `now - max(sentAt, lastHeardFromAt) >= QUIET` |
| waitingSince | `max(sentAt, lastHeardFromAt ?? sentAt)` |
| N days | `Math.floor((now - waitingSince) / 86400000)` on the browser clock |
| interestedMode | `'route'` when `unit.tour_type` is set, else `'form'` |
| outcome route | `POST /api/units/:unitId/recipients/:contactId/outcome` body `{ outcome: 'interested' \| 'not_interested' \| 'clear' }` |
| outcome route answers | 200 `{ row }`; 400 `{ error: 'invalid_outcome' }`; 404 `{ error: 'unit_not_found' }`; 404 `{ error: 'send_not_found' }` (no COUNTED row for the pair, `ledgerRowCounted`); 409 `{ error: 'unit_deleted' }`; 400 `{ error: 'interested_unsupported' }` (interested on a non-tenant row); 404 `{ error: 'tenant_not_found' }` / 409 `{ error: 'contact_not_tenant', contactKind }` (from `requireTenantContact`); 409 `{ error: 'tour_type_required' }`; 503 `{ error: 'outcome_unavailable', saved?: true }` |
| follow-ups endpoint | `GET /api/broadcasts/follow-ups` -> `{ items: FollowUpItem[], byUnit: Record<string, number>, truncated: boolean }`; 503 `{ error: 'outcome_unavailable' }` on a failed required join; walks `unitsRepo.listByStatus('available')` pages until 100 KEPT (non-deleted) units or exhaustion |
| preview additions | per candidate `status?` (tenant rows only), `lastHeardFromAt?`, `declinedThisProperty: boolean`; top-level `declinedContactIds: string[]`, `declineLabelsUnavailable: boolean` |
| dev seam | `POST /__dev/listing-send-fixture` `{ unitId, contactId, sentAt }` -> 201 `{ row }` on a FRESH pair; 409 `{ error: 'send_exists' }` when the pair already has any listing_sends row (never overwrite a shares map or move `sentAt` backward); hermetic-local only (the `/__dev/reseed` gate); writes a COUNTED, listed row with that `sentAt` through `putShareMemory` |
| events | `ActivityEventType` += `listing_declined`, `listing_decline_cleared`, `listing_interested`; unit audit event types += the same three; writer `recordListingOutcomeEvent` in `app/src/lib/listingOutcomeEvents.ts`; contact timeline only (no landlord copy); `refType: 'unit'`, `refId: unitId`; unit audit payload `{ contactId, actor }` (+ `tourId` on interested) |
| Tenants tab URL | `?sort=heard \| name` (absent = `heard`); repeated `?status=<value>` (absent = the DEFAULT set = all seven except `inactive`, `placed`; `?status=_empty` = none; values beat the sentinel; invalid-only = default); only a non-default selection is written |
| Tenants tab rule | a tenant with no status or an off-list status is never hidden by the status facet and counts under no chip |
| name order | last name, first name, formatted phone, contactId (case-insensitive `localeCompare`; absent last name sorts first) |
| heardFrom helpers | `dashboard/src/lib/heardFrom.ts`: `formatHeardFrom(iso, now) -> { label, title }` ("Never" for absent OR unparseable), `compareByName(a, b)`, `sortByHeardFrom(rows, { heardAt, name })` (most recent first, absent last, ties by `compareByName`) |
| C6 | `git apply docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch` verbatim, its own commit, BEFORE the `annotate` prop commit |

Copy (exact strings; N is a number; `<x>` is a value):

| where | text |
|---|---|
| outcome chips | `No reply yet` / `Replied` / `Not interested` / `Not interested (auto)` (engine); interested = the existing TourChip labels |
| row dates | `Sent <formatHeardFrom(sentAt).label>` and `Last heard from <label>`; absent = `Never` |
| row actions | buttons `Interested`, `Not interested`, `Undo`; partner link `Request a tour` |
| row action aria | `Mark <name> interested in <address>` / `Mark <name> not interested in <address>` / `Undo not interested for <name>` / `Request a tour for <name> at <address>` (on the contact page `<address>` is the property's short address; on the property page `<name>` is the recipient's name) |
| row error | `Couldn't save - try again.`; after a 503 with `saved: true`: `Saved - reload to see the change.` |
| card errors | property card `We couldn't load recipients.` (existing); contact cards `We couldn't load properties sent.` |
| preview headers | `Name`, `Status`, `Housing authority`, `Last heard from` |
| preview tags | `Already sent` (existing), `Not interested` (new), `Added` (existing) |
| preview checkbox aria | `<name>` / `<name> - already sent` / `<name> - not interested` / `<name> - already sent, not interested` / `<name> - consent not recorded` (ASCII " - " on every one; the existing two change from an em dash) |
| preview degraded line | `Couldn't load not-interested labels - a tenant who said no may be checked; sends still work` |
| search annotation | `Not interested` / `Already sent` (a muted suffix after the option's name) |
| Tenants sort | label `Sort by`; options `Last heard from`, `Name` |
| Tenants status group | label `Status`; chips = the seven `StatusBadge` tenant labels in `TENANT_STATUSES` order; Clear button `Clear status filter` (shown only while the selection differs from the default) |
| Tenants hidden-match | `No matches for <q> among the statuses shown` + button `Show all statuses` |
| Tenants row | `Last heard from <label>` after the Porting chip |
| contact header | `Last heard from <label>` as its own span on the facts line |
| Follow up tab | tab `Follow up` with a count badge (the number); group heading = `unitLabel`, sub `<n> waiting`; chips `No reply yet, N days` / `Replied, quiet N days`; actions `Interested`, `Not interested`, `Text`; empty `Nothing waiting on a reply.`; error `We couldn't load follow-ups.` |
| Properties pill | `<n> waiting` inside the row link, available rows only |
| timeline labels | `Not interested in <address>` / `Not interested cleared for <address>` / `Interested in <address> - tour requested` |
| property Activity labels | `<who> not interested` / `<who> not interested cleared` / `<who> interested - tour requested` (`who = contactName ?? contactId`, `describeUnitActivity`) |

## 2. Work map

| slice | tasks | area | writer |
|---|---|---|---|
| S1 the attribute and the live touches | 1.1 repo method + every typed fake; 1.2 `attributeInbound` + lookup; 1.3-1.10 the eight live paths; 1.11 dev seams; 1.12 importer stamp; 1.13 seed derivation (lean + cast values pinned); 1.14 dashboard `Contact` type | app `contactsRepo`, `lib/heardFrom.ts`, `webhooks/twilio.ts`, `webhooks/voice.ts`, `services/inboundEmail.ts`, `routes/dev.ts`, `lib/import/apply.ts`, `lib/seed/*` | W1 |
| S2 backfill | 2.1 planner + CLI + tests; 2.2 RUNBOOK section | `app/scripts/backfill-last-heard-from.ts`, `RUNBOOK.md` | W1 |
| S3 outcome core (app) | 3.1 `listingSendOutcome.ts`; 3.2 `deriveTourActivityAt`; 3.3 `declined` + `setDeclined`/`clearDeclined` + fakes; 3.4 projection + `requireComplete`; 3.5 event writer + types; 3.6 the two GET projections (required joins, `recipientMissing`, `eligible`, `interestedMode`, partner rows without `tour`); 3.7 the outcome route + api wiring; 3.8 dashboard wire types + endpoints | app `lib/`, `repos/`, `routes/units.ts`, `routes/contacts.ts`, `routes/api.ts`; dashboard `api/*` | W2 |
| S4 shared dashboard helpers + Tenants tab + header | 4.1 `dashboard/src/lib/heardFrom.ts`; 4.2 facet model + URL (status, sort); 4.3 `ChipGroup` baseline + status group + hidden-match hint; 4.4 rows + sort + the `visible` memo; 4.5 contact header span; 4.6 perf `resolveContactDetail` | dashboard `routes/contacts/*`, `ContactDetail.tsx`, `e2e/performance/routes.ts` | W4 |
| S5 roster cards | 5.1 `SendRosterRow` + CSS; 5.2 per-row setters; 5.3 property card wiring (`?tour=new`, deleted property, grouping); 5.4 contact cards (props, interestedMode client-side, partner link); 5.5 Timeline / `describeUnitActivity` labels | dashboard `contact/Card.tsx`, `listing/*`, `contact/*` | W2 |
| S6 Matching review step | 6.1 resolver + seeds projection; 6.2 preview response (declines, degraded flag) + router deps; 6.3 C6 patch commit; 6.4 `annotate` prop; 6.5 RecipientPreview columns, sort, declined rows, names | app `services/audienceResolution.ts`, `routes/broadcasts.ts`; dashboard `broadcasts/*`, `contact/ContactSearchField.tsx` | W3 |
| S7 follow-ups | 7.1 builder + endpoint; 7.2 dev seam; 7.3 `useFollowUps` + `FollowUpView` + tab URL; 7.4 `useFollowUpCounts` + Properties pill | app `routes/broadcasts.ts`, `routes/dev.ts`; dashboard `broadcasts/*`, `listings/*` | W3 |
| S8 e2e | 8.1-8.6 the six specs of spec section 8, plus the two knowing rewrites (`listing-activity`, `already sent` selectors) | `e2e/` | W4 |
| S9 docs | 9.1 GLOSSARY; 9.2 issues (C6 resolved, `denormalize-...` note, `tour-create-no-dedupe` stays open) | docs | W1 |
| S10 final | main sync + the five gates + self-QA + handback | - | orchestrator |

Order: S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10. S1-S3 are
app-only and each ends green on `npm run typecheck` + the app suite. S4 is
the first dashboard slice and owns the shared helper S5-S7 import. S5-S7
build the cards, the review step and the list bottom-up. S8 runs the stack
end to end. Between S3 and S5 the API serves the new fields and the cards
ignore them - acceptable, nothing deploys mid-branch.

## 3. Shared contracts (every slice uses these names VERBATIM)

### 3.1 App - types and pure functions

```ts
// app/src/repos/contactsRepo.ts (ContactItem) - add after the existing
// activity-ish fields; NOT an index key.
/** ISO 8601 - the most recent inbound text, call or email FROM this contact
 *  in any thread. Forward-only; outbound and automated traffic never moves it.
 *  Absent = never heard from (or not yet backfilled). */
last_heard_from_at?: string;

// ContactsRepo interface - add at the END of the interface.
/** Forward-only, best-effort bump of last_heard_from_at. 'skipped' when the
 *  contact row does not exist, the stored value is already later, or `at`
 *  is unparseable; 'failed' on any other error (logged by the CALLER); never
 *  throws. */
touchLastHeardFrom(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'>;
getRecipientDisplaysByIds(contactIds: string[], opts?: { requireComplete?: boolean }): Promise<Map<string, RecipientDisplay>>;

// RecipientDisplay (the RECIPIENT_PROJECTION read model) gains:
status?: string; last_heard_from_at?: string; deleted_at?: string;
sms_opt_out?: boolean; sms_unreachable?: boolean;   // phone is already projected
// RECIPIENT_PROJECTION adds '#status' (reserved word) and the four others.
```

```ts
// app/src/lib/heardFrom.ts
export type MaybePromise<T> = T | Promise<T>;
export interface HeardFromLookup {
  byPhone(e164: string): MaybePromise<{ contactId: string } | undefined>;
  byEmail(address: string): MaybePromise<{ contactId: string } | undefined>;
}
/** Canonical ISO form of any parseable instant; undefined when unparseable. */
export function normalizeInstant(s: string | undefined): string | undefined;
/** WHICH contact an inbound row is FROM (spec 5.1 + 14.2) - the ONE rule.
 *  `row` is the persisted message/call row, `thread` the PERSISTED conversation
 *  it lives on. Returns undefined when the row is not attributable. */
export function attributeInbound(
  row: Pick<MessageItem, 'direction' | 'type' | 'relay_sender_key' | 'relay_retry_of' | 'email_new_address' | 'relay_external_caller_contact_id' | 'relay_external_caller_phone'>,
  thread: Pick<ConversationItem, 'type' | 'participants' | 'participant_phone' | 'participant_email'>,
  lookup: HeardFromLookup,
): Promise<string | undefined>;
/** A HeardFromLookup over a contacts repo, with an optional pre-resolved cache
 *  (the live paths pass the contacts they already hold). */
export function repoLookup(contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>, cache?: ReadonlyMap<string, { contactId: string }>): HeardFromLookup;
```

Rule (spec 5.1 as amended, implemented exactly):
1. `row.direction !== 'inbound'` or `row.relay_retry_of` present -> undefined.
2. Group thread (`thread.type === 'relay_group'` or a native group thread -
   the plan's reference names the native type value): key = `row.relay_sender_key`.
   `'team'` -> undefined. A bare contactId -> that id. `phone#<E164>` -> the
   roster entry with that phone and a NON-EMPTY `contactId`, else
   `lookup.byPhone(E164)`. No key: `row.relay_external_caller_contact_id`,
   else `row.relay_external_caller_phone -> lookup.byPhone`, else undefined.
   A roster member is NEVER the fallback for a keyless row.
3. Any other thread: `row.type === 'email' && row.email_new_address === true`
   -> undefined. Else the first `participants[]` entry with a non-empty
   `contactId`; else `thread.participant_phone -> lookup.byPhone`; else
   `thread.participant_email -> lookup.byEmail`; else undefined.

```ts
// app/src/lib/listingSendOutcome.ts
export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';
export type InterestedMode = 'route' | 'form';
export const FOLLOW_UP_QUIET_MS = 24 * 3600 * 1000;
export const FOLLOW_UP_LOOKBACK_MS = 14 * 86400 * 1000;
export interface DeclineRecord { at: string; by: 'staff' | 'engine'; staffId?: string }
export function effectiveDecline(row: { declined?: DeclineRecord; sentAt?: string }, tourActivityAt: string | undefined): boolean;
export function deriveListingSendOutcome(input: {
  row: { declined?: DeclineRecord; sentAt?: string };
  recipientType: string | undefined;          // 'tenant' reads tours; anything else ignores them
  lastHeardFromAt: string | undefined;
  tour: TourSignal | undefined;               // deriveTourSignal(pairTours)
  tourActivityAt: string | undefined;         // deriveTourActivityAt(pairTours)
}): ListingSendOutcome;
export function isEligibleRecipient(c: { type?: string; status?: string; deleted_at?: string; sms_opt_out?: boolean; sms_unreachable?: boolean; phone?: string }): boolean;
export function interestedModeFor(unit: { tour_type?: string }): InterestedMode;
export function isWaiting(input: { outcome: ListingSendOutcome; eligible: boolean; sentAt: string; lastHeardFromAt?: string; now: number }): boolean;
export function waitingSince(sentAt: string, lastHeardFromAt?: string): string;
```

```ts
// app/src/lib/listingSendTour.ts - sibling of deriveTourSignal, same qualifying set
export function deriveTourActivityAt(tours: TourItem[]): string | undefined;
```

```ts
// app/src/repos/listingSendsRepo.ts
declined?: DeclineRecord;                      // on ListingSendItem
setDeclined(unitId: string, contactId: string, record: DeclineRecord): Promise<'ok' | 'not_found'>;
clearDeclined(unitId: string, contactId: string): Promise<'ok' | 'not_found'>;
// both: UpdateItem SET/REMOVE `declined` + `updated_at` ONLY, condition
// `attribute_exists(unitId) AND (attribute_not_exists(counted) OR counted <> :false)`;
// ConditionalCheckFailed -> 'not_found'.
export function toListingSendRow(item: ListingSendItem, opts: {
  tour?: TourSignal; tenantName?: string; facts?: ListingSendRecipientFacts;
  outcome: ListingSendOutcome; lastHeardFromAt?: string; declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean; interestedMode?: InterestedMode; eligible?: boolean; recipientMissing?: boolean;
}): ListingSendRow;   // replaces the positional signature; every caller updated
```

```ts
// app/src/lib/listingOutcomeEvents.ts
export type ListingOutcomeEventType = 'listing_declined' | 'listing_decline_cleared' | 'listing_interested';
export async function recordListingOutcomeEvent(deps: { activityEvents: ActivityEventsRepo; audit: AuditRepo; logger }, input: {
  type: ListingOutcomeEventType; contactId: string; unitId: string; label: string;  // the timeline label, address included
  actor?: string; tourId?: string; at: string;
}): Promise<void>;   // best-effort: logs and returns on failure, never throws
```

### 3.2 App - wire shapes

`ListingSendRow` (both GET projections; mirrored in `dashboard/src/api/types.ts`):

```ts
export interface ListingSendRow {
  contactId: string; tenantName?: string; unitId: string; sentAt: string;
  via: 'broadcast' | 'individual'; broadcastId?: string;
  tour?: TourSignal;                       // TENANT rows only; never on a partner row
  type?: ContactType; role?: string;       // units route only (existing)
  lastHeardFromAt?: string;
  outcome: ListingSendOutcome;
  declined?: { at: string; by: 'staff' | 'engine' };   // present only when effective
  interestedSupported: boolean;            // false on a non-tenant or missing recipient
  interestedMode?: InterestedMode;         // units route only (the unit is known)
  eligible?: boolean;                      // units route only
  recipientMissing?: boolean;              // true when the contact row is gone
}
```

`FollowUpItem` and the follow-ups response: spec 5.6 as amended (section 14.4).
`PreviewResponse` additions: spec 14.4 / section 1 of this plan.
The outcome route and the dev seam: section 1 of this plan.

### 3.3 Dashboard

```ts
// dashboard/src/lib/heardFrom.ts
export function formatHeardFrom(iso: string | undefined, now: Date): { label: string; title: string };
export function compareByName(a: NameLike, b: NameLike): number;        // NameLike = { firstName?, lastName?, phone?, contactId }
export function sortByHeardFrom<T>(rows: readonly T[], acc: { heardAt: (r: T) => string | undefined; name: (r: T) => NameLike }): T[];
export function daysSince(iso: string, now: Date): number;              // Math.floor
```

`SendRosterRow` props (`dashboard/src/routes/contact/Card.tsx`):

```ts
{
  to: string; identity: React.ReactNode; kind?: string;
  row: ListingSendRow;                       // the whole wire row
  address: string;                           // for the aria names
  name: string;                              // for the aria names
  interestedMode: InterestedMode;            // computed by the host (server on the property card, file.units on the contact page)
  actionsDisabled?: boolean;                 // deleted property
  onOutcome: (outcome: 'interested' | 'not_interested' | 'clear') => Promise<void>;
  onRequestTour?: () => void;                // partner rows (navigates to /listings/:unitId?tour=new)
  onOpenTourForm?: () => void;               // interestedMode 'form' on a tenant row
  now: Date;
}
```

Tenants tab facet model: `TenantFacetModel.status: FacetOption[]`,
`TenantSelection.status: ReadonlySet<TenantStatus>` (`NO_SELECTION` carries the
full seven), `DEFAULT_STATUS_SET` exported from `tenantFacets.ts`,
`applyToParams` writes `status` default-aware (+ `_empty`), `?sort=` written by
its own `applySortToParams(params, sort)`.

### 3.4 Reconciliation of the writers' contract notes (planner rulings, 2026-10-13)

The four slice writers wrote against sections 3.1-3.3 and returned notes.
Rulings, all ACCEPTED unless marked; where a slice body still shows the old
form, THIS section wins:

1. `SendRosterRow.onRequestTour?: () => void` is REPLACED by
   `requestTourTo?: string` rendered as a react-router `<Link>` (W2 #1): the
   copy table calls it a link and gives it a link's accessible name
   (`Request a tour for <name> at <address>`). Value:
   `/listings/<unitId>?tour=new`.
2. `clear` writes `listing_decline_cleared` ONLY when the row carried a
   `declined` record before the call; a clear of a never-declined row answers
   200 and writes no event (W2 #2) - the same honesty rule as
   `listing_interested`.
3. The outcome route's 400 `interested_unsupported` comes from the recipient
   display read; `requireTenantContact` (consistent) runs after it as the I2
   guard, so 409 `contact_not_tenant` fires only on a type change between the
   two reads (W2 #3, clarification).
4. Dashboard endpoint and types the slices share (W3 #1): `endpoints.ts`
   exports `setListingSendOutcome(unitId, contactId, outcome): Promise<{ row:
   ListingSendRow }>`; `api/types.ts` exports `ListingSendOutcome` and
   `InterestedMode` (the app names); `dashboard/src/lib/listingOutcomeErrors.ts`
   holds `isOutcomeSaved`, `outcomeErrorCopy` (W2 3.8).
5. Copy additions (W3 #3), added to the copy table: Follow up row Text
   button aria `Text <name>`; its failure line `Couldn't open the
   conversation - try again.`; the truncated note `Showing follow-ups for the
   first 100 available properties.`; N = 1 renders `1 day`; a row whose
   outcome is `interested` but whose response carries no `tour` shows the
   chip text `Interested`; the search annotation shows ONE suffix, `Not
   interested` outranking `Already sent`.
6. The Properties `<n> waiting` pill renders inside the row link and is NOT
   itself a link to the tab (nested anchors are invalid); `?tab=follow-up`
   still serves deep links (W3 #4).
7. `RecipientPreview` and `FollowUpView` take an optional `now?: Date` (test
   clock); `DevRouterDeps` gains `listingSendsRepo?`, `heardFromRepos` and
   `voiceFixtureRepos`; `FakeWorld` gains `heardFromTouches`; `ApplyReport`
   gains `lastHeardFromStamps` (W1 #5, W3 #7). `FollowUpItem.declined` stays
   in the type and is never set by the builder (W3 #7).
8. `heardFrom.ts` (app) also exports `HeardFromRow` / `HeardFromThread`
   aliases; rule 3 falls through from a phone-lookup miss to the email
   lookup; `touchLastHeardFrom` answers `'skipped'` without a write for a
   `phoneref#` / `emailref#` id; on the five no-read-back paths a dedupe onto
   ANOTHER conversation attributes on that thread via `conversations.getById`
   (W1 #1-#4). The caller's failure log line is exactly
   `last_heard_from touch failed - message persisted, last_heard_from stale`.
9. Dashboard `heardFrom.ts` clarifications (W4 N1): `formatHeardFrom` returns
   `{ label: 'Never', title: '' }` for absent or unparseable (an empty title
   = no title attribute); `daysSince` clamps at 0; `compareByName` uses
   `localeCompare(b, 'en', { sensitivity: 'accent' })`; `TenantSelection.status`
   becomes required and EVERY literal is updated (about 18, listed in 4.2);
   `tenantFacets.ts` additionally exports `ALL_STATUS_SET`, `STATUS_EMPTY_KEY`,
   `TenantSort`, `parseSort`, `hiddenByStatusOnly`.
10. MARKUP CONTRACT (W4 N2, the selectors S8 drives; S5, S6, S7 MUST render
    these): R1 every `SendRosterRow` root is an `<li>` inside a `<ul>` (one
    per group is fine) and nothing else in the card is a listitem; R2 the
    outcome chip is visible text exactly `No reply yet` / `Replied` / `Not
    interested` / `Not interested (auto)`, interested = the TourChip LINK;
    R3 the action buttons carry the aria names of the copy table on the
    property card, the contact card AND the Follow up rows; R4
    `interestedMode: 'form'` on the property page navigates to
    `?tour=new&tenantId=<id>`, opens the `Schedule a tour` dialog with the
    tenant LOCKED (`role="group"` named `Tenant`), creates nothing, and
    Cancel clears both params; P1 the review header cells are visible text
    exactly `Name`, `Status`, `Housing authority`, `Last heard from` rendered
    BEFORE `<ul aria-label="Candidate recipients">` and never inside it; P2
    tags are visible text exactly `Not interested`, `Already sent`, `Added`
    and the annotate suffix is text inside the option; F1 the Follow up tab
    is `role="tab"` with text `Follow up` then the count, `aria-selected`
    while active, `/broadcasts?tab=follow-up` opens it and clicking writes
    it; F2 each property group is a `<section aria-labelledby>` whose heading
    STARTS with `unitLabel` and contains `<n> waiting`, rows are `<li>`s, the
    name links to `/contacts/:id`; F3 chips `No reply yet, N days` / `Replied,
    quiet N days` (`1 day`), empty state `Nothing waiting on a reply.`; F4 the
    pill text `<n> waiting` inside the row link on available rows only.
11. `RecipientPreview.test.tsx:431` pins an em-dash accessible name and is
    rewritten knowingly in 6.5 (W3 #5); no e2e spec selects a checkbox by
    its accessible name, so S8's "already sent selector" rewrite is empty
    (W3, W4). The visible no-consent tag keeps its em dash, built with
    `String.fromCharCode(0x2014)` so the source line stays ASCII.
12. Ordering dependencies the writers named: S4 needs 1.14; S5-S7 need
    3.1-3.8 and 4.1; S8.6 needs 1.11 and 7.2; S8.3 needs 7.2. The work-map
    order already satisfies all of them.

### 3.5 Writer notes, verbatim

The writers' own notes blocks are reproduced in the slice sections below as
they were written (each slice opens with them), so the rulings above can be
checked against their source.

---


<!-- W1 notes -->
## Contract notes (additions only - NO contract change requested)

Unchanged by plan review round 1: the caller's failure log line (note 6)
and the `'written' | 'skipped' | 'failed'` result of `touchLastHeardFrom`.

The shared contracts in section 3.1 work for S1/S2/S9 as written. This
section adds, and every other writer may rely on:

1. `app/src/lib/heardFrom.ts` also exports two type aliases,
   `HeardFromRow` and `HeardFromThread`. They ARE the two `Pick<...>` types in
   the contract's `attributeInbound` signature (same members), so the
   signature is unchanged; they exist so call sites can annotate a row
   literal.
2. Rule 3's "else" chain falls THROUGH on a lookup miss: when
   `thread.participant_phone` is set but `lookup.byPhone` answers undefined,
   `thread.participant_email -> lookup.byEmail` is still tried (the
   `unreadFeed.ts:534-546` precedent the spec cites).
3. `touchLastHeardFrom` answers `'skipped'` WITHOUT a write for a pointer
   contactId (`phoneref#` / `emailref#` prefixes, `contactsRepo.ts:386`,
   `:394`): a pointer row exists, so the `attribute_exists(contactId)` guard
   alone would let it be stamped. The spec says pointer rows are never touch
   targets; this enforces it at the one writer.
4. On the five paths that do not read the persisted row back (relay,
   closed late text, the three voice paths), spec 14.2 rules out a read-back.
   When `appended.conversationId` differs from the thread the path holds (a
   dedupe against a row filed on another conversation), attribution reads
   THAT thread with `conversations.getById(appended.conversationId)` and keeps
   this delivery's row fields. The instant is always the persisted key.
5. `DevRouterDeps` gains `heardFromRepos` and `voiceFixtureRepos` (Task 1.11).
   `FakeWorld` (the webhook harness) gains `heardFromTouches` (Task 1.1).
   `ApplyReport` gains `lastHeardFromStamps: { planned; written; skipped;
   failed }` (Task 1.12).
6. The caller's failure log line, everywhere, is exactly
   `last_heard_from touch failed - message persisted, last_heard_from stale`.

---

## S1 - the attribute and the live touches (spec 5.1, 6 I1/I4, 7, 8, 14.2)

### Task 1.1 - `touchLastHeardFrom`, the attribute, `normalizeInstant`, every typed fake

`normalizeInstant` lands HERE (the writer needs it); Task 1.2 adds the rest
of `app/src/lib/heardFrom.ts`.

RED:

1. New `app/test/heardFrom.test.ts`, `describe('normalizeInstant')`:
   `'2026-09-01T10:00:00Z'` -> `'2026-09-01T10:00:00.000Z'`;
   `'2026-09-01T06:00:00-04:00'` -> `'2026-09-01T10:00:00.000Z'`;
   `'2026-09-01T10:00:00.000Z'` -> itself; `'yesterday'`, `''` and
   `undefined` -> `undefined`. RED: the module does not exist.
2. New `app/test/contactsRepoHeardFrom.test.ts` (no database), `describe('contactsRepo.touchLastHeardFrom (stub client)')`.
   Build `createContactsRepo({ doc: stub as never, env: { TABLE_PREFIX: 'hc-test-lhf-' }, logger })`
   with `logger = createLogger({ destination: capture.stream })`
   (`createLogCapture()` from `./helpers/logCapture.js`) and a stub whose
   `send(command)` pushes `command` onto `sent` and then runs a per-test
   `answer` function (default: resolve `{}`):
   - `'written'`: `touchLastHeardFrom('contact-a', '2026-09-01T10:00:00.000Z')`
     resolves `'written'`; `sent` holds exactly one `UpdateCommand` whose
     `input` `toEqual`s
     `{ TableName: 'hc-test-lhf-contacts', Key: { contactId: 'contact-a' }, UpdateExpression: 'SET #lhf = :at', ConditionExpression: 'attribute_exists(contactId) AND (attribute_not_exists(#lhf) OR #lhf < :at)', ExpressionAttributeNames: { '#lhf': 'last_heard_from_at' }, ExpressionAttributeValues: { ':at': '2026-09-01T10:00:00.000Z' } }`.
   - normalization: `at = '2026-09-01T06:00:00-04:00'` sends
     `':at': '2026-09-01T10:00:00.000Z'`.
   - unparseable: `at = 'yesterday'` resolves `'skipped'`, `sent` is EMPTY,
     and `capture.atLevel(40)` holds one line whose `msg` contains
     `unparseable` and whose `contactId` is `'contact-a'`.
   - pointer: `touchLastHeardFrom('phoneref#+15550100105', '2026-09-01T10:00:00.000Z')`
     resolves `'skipped'` with `sent` EMPTY (same for `'emailref#a@b.test'`).
   - lost condition: `answer` throws
     `new ConditionalCheckFailedException({ message: 'x', $metadata: {} })` ->
     resolves `'skipped'` (no rejection).
   - any other error: `answer` throws `new Error('throttled')` -> resolves
     `'failed'` (no rejection), and nothing at level 50 (the CALLER logs).
   RED: `touchLastHeardFrom is not a function`.
3. `app/test/contactsRepo.integration.test.ts`, inside the existing describe
   (after the `touchPhoneLastSeen` case at `:271`), one new case
   `'touchLastHeardFrom is guarded, forward-only and normalizing'`:
   - `await contacts.touchLastHeardFrom('contact-never-existed-lhf', '2026-09-01T10:00:00.000Z')`
     is `'skipped'` and `await contacts.getById('contact-never-existed-lhf')`
     is `undefined` (the guard: UpdateItem would otherwise CREATE the item);
   - `const c = await contacts.create({ type: 'tenant', phone: nextPhone() })`;
     `touchLastHeardFrom(c.contactId, '2026-09-01T10:00:00Z')` is `'written'`
     and the stored value is `'2026-09-01T10:00:00.000Z'`;
   - an EARLIER `'2026-08-31T10:00:00.000Z'` is `'skipped'` (value unchanged);
   - the SAME instant is `'skipped'`;
   - a LATER `'2026-09-02T10:00:00.000Z'` is `'written'`.
   RED: not a function.

GREEN:

- `app/src/lib/heardFrom.ts` (new; Task 1.2 extends it):

```ts
// The ONE attribution rule for "which contact is this inbound row FROM",
// and the instant normalizer every last_heard_from_at writer shares (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2).

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

/** Canonical ISO form of any parseable instant; undefined when unparseable.
 *  DynamoDB compares stored strings LEXICALLY, so every writer stores this
 *  form ('2026-09-01T10:00:00Z' sorts AFTER '2026-09-01T10:00:00.500Z'). */
export function normalizeInstant(s: string | undefined): string | undefined {
  if (!nonEmpty(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
```

- `app/src/repos/contactsRepo.ts`:
  - import (new line after `:23`): `import { normalizeInstant } from '../lib/heardFrom.js';`
  - `ContactItem`, insert after `created_at?: string;` (`:223`):

```ts
  /** ISO 8601 - the most recent inbound text, call or email FROM this contact
   *  in any thread. Forward-only; outbound and automated traffic never moves it.
   *  Absent = never heard from (or not yet backfilled). Written ONLY by
   *  touchLastHeardFrom (and the seed derivation). NOT an index key. */
  last_heard_from_at?: string;
```

  - `ContactsRepo` interface, at the END (after `rewriteOrgFields(...)`,
    i.e. a new member between `:915` and the closing `}` at `:916`):

```ts
  /** Forward-only, best-effort bump of last_heard_from_at. 'skipped' when the
   *  contact row does not exist, the stored value is already later, or `at`
   *  is unparseable; 'failed' on any other error (logged by the CALLER); never
   *  throws. */
  touchLastHeardFrom(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'>;
```

  - implementation, after `rewriteOrgFields`'s closing `},` (`:1913`) and
    before the object's closing `};` (`:1914`):

```ts
    async touchLastHeardFrom(contactId, at) {
      // Pointer rows exist, so attribute_exists alone would let one be stamped;
      // they are never touch targets (spec 5.1).
      if (contactId.startsWith(PHONE_REF_PREFIX) || contactId.startsWith(EMAIL_REF_PREFIX)) {
        return 'skipped';
      }
      // The ONE writer normalizes: the condition compares stored strings
      // lexically, and the importer hands over the export's raw createdAt.
      const normalized = normalizeInstant(at);
      if (normalized === undefined) {
        log.warn({ contactId }, 'contacts: touchLastHeardFrom refused an unparseable instant - skipped');
        return 'skipped';
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { contactId },
            UpdateExpression: 'SET #lhf = :at',
            // attribute_exists is LOAD-BEARING: UpdateItem on an absent key
            // CREATES the item, and touch targets come from rosters and stored
            // sender keys that can outlive a hard-deleted contact.
            ConditionExpression: 'attribute_exists(contactId) AND (attribute_not_exists(#lhf) OR #lhf < :at)',
            ExpressionAttributeNames: { '#lhf': 'last_heard_from_at' },
            ExpressionAttributeValues: { ':at': normalized },
          }),
        );
        return 'written';
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // "No such contact" and "already as late" share one exception.
          log.debug({ contactId }, 'contacts: last_heard_from_at not moved (no row, or already as late)');
          return 'skipped';
        }
        return 'failed';
      }
    },
```

  (`PHONE_REF_PREFIX`/`EMAIL_REF_PREFIX` are module constants at `:386`,
  `:394`; `ConditionalCheckFailedException` and `UpdateCommand` are already
  imported at `:6`-`:15`; `doc`, `table`, `log` are the names at `:919`-`:921`.)

- The FIVE typed `ContactsRepo` object literals in `app/test` (inventory
  re-verified with `grep -rn "ContactsRepo = {\|ContactsRepo & {" app/test`;
  every other fake is an `as unknown as ContactsRepo` cast or a `Pick` and
  does not break). Add the new member as the LAST member of each literal:
  - `app/test/contactCapture.test.ts` - after `:155` (before `  };` at `:156`);
  - `app/test/scheduledSendSuppression.test.ts` - after `:286` (before `:287`);
  - `app/test/sendMessage.test.ts` - after `:270` (before `:271`);
  - `app/test/audienceResolution.test.ts` (`fakeContacts`, `:25`) - after
    `:131` (before `:132`). In these four, the neighbors' style:

```ts
    touchLastHeardFrom: async () => {
      throw new Error('touchLastHeardFrom: not used in this suite');
    },
```

  - `app/test/helpers/twilioWebhookHarness.ts` (the shared fake, `:2228`) -
    a REAL in-memory implementation, after `rewriteOrgFields`'s `},` (`:2598`)
    before the literal's `};` (`:2599`):

```ts
    // Last heard from (spec 5.1): the real conditional UpdateItem's outcomes -
    // 'skipped' for no such contact, a stored value at or after `at`, or an
    // unparseable `at`. Every call is recorded in world.heardFromTouches with
    // the RAW `at` the caller passed.
    async touchLastHeardFrom(contactId, at) {
      const normalized = normalizeInstant(at);
      const contact = contacts.find((c) => c.contactId === contactId);
      let outcome: 'written' | 'skipped' = 'skipped';
      if (
        normalized !== undefined &&
        contact !== undefined &&
        !(typeof contact.last_heard_from_at === 'string' && contact.last_heard_from_at >= normalized)
      ) {
        contact.last_heard_from_at = normalized;
        outcome = 'written';
      }
      heardFromTouches.push({ contactId, at, outcome });
      return outcome;
    },
```

    and in the same file: `import { normalizeInstant } from '../../src/lib/heardFrom.js';`
    with the other `../../src/lib/` imports; in `interface FakeWorld`, after
    `crossCheckBalances: ...;` (`:516`):

```ts
  /** Every contactsRepo.touchLastHeardFrom call, in order (spec 5.1): the raw
   *  `at` the caller passed and the outcome the fake answered. A test that
   *  replaces world.contactsRepo.touchLastHeardFrom bypasses this record. */
  heardFromTouches: { contactId: string; at: string; outcome: 'written' | 'skipped' | 'failed' }[];
```

    in `createFakeWorld`, after `const touches: FakeWorld['touches'] = [];`
    (`:550`): `const heardFromTouches: FakeWorld['heardFromTouches'] = [];`;
    and in the returned world literal, after `crossCheckBalances,` (`:5224`):
    `heardFromTouches,`.

Run the four files above plus `npm run typecheck` (the typecheck proves all
five literals implement the interface).

Commit: `feat(app): contactsRepo.touchLastHeardFrom - the one forward-only last-heard-from writer`.

### Task 1.2 - `attributeInbound` + `repoLookup` (the one rule)

RED - `app/test/heardFrom.test.ts`, new `describe('attributeInbound')`.
Fixtures: `const PHONE_BOOK = new Map([['+15550100007', 'c-nonmember'], ['+15550100008', 'c-phone-only'], ['+15550100006', 'c-deleted'], ['+15550100005', 'c-phone']])`,
`const EMAIL_BOOK = new Map([['e@x.test', 'c-email']])`; a SYNCHRONOUS lookup
`{ byPhone: vi.fn((p) => (PHONE_BOOK.has(p) ? { contactId: PHONE_BOOK.get(p)! } : undefined)), byEmail: vi.fn((e) => ...) }`
built fresh per case, and `const relay = (participants) => ({ type: 'relay_group', participants, participant_phone: '+15550109000' })`
(the pool number - must never be looked up). One `it` per row:

| # | thread | row | expected |
|---|---|---|---|
| 1 | tenant_1to1, participants `[{ contactId: 'c-t', phone: '+15550100001' }]` | `{ direction: 'outbound', type: 'sms' }` | undefined |
| 2 | relay, roster c-a | `{ direction: 'inbound', type: 'sms', relay_sender_key: 'c-a', relay_retry_of: '2026-09-01T10:00:00.000Z#SMx' }` | undefined |
| 3 | relay, roster c-a | inbound sms, key `'c-a'` | `'c-a'` |
| 4 | relay | inbound sms, key `'team'` | undefined |
| 5 | relay, roster `[{ contactId: 'c-z', phone: '+15550100007' }]` | key `'phone#+15550100007'` | `'c-z'` AND `byPhone` NOT called (roster first) |
| 6 | relay, roster `[{ contactId: '', phone: '+15550100008' }]` | key `'phone#+15550100008'` | `'c-phone-only'` (empty contactId = absent) |
| 7 | relay, roster c-a | key `'phone#+15550100007'` (not on roster) | `'c-nonmember'`; with key `'phone#+15550100999'` -> undefined |
| 8 | relay, roster c-a | keyless call `{ direction: 'inbound', type: 'call', relay_external_caller_contact_id: 'c-ext', relay_external_caller_phone: '+15550100007' }` | `'c-ext'` (the stored id beats the phone) |
| 9 | relay, roster c-a | keyless call, only `relay_external_caller_phone: '+15550100006'` (a soft-deleted match: the id was not stored) | `'c-deleted'` |
| 10 | relay, roster c-a (non-empty!) | keyless `{ direction: 'inbound', type: 'call' }` (an imported group call) | undefined, and `byPhone` NOT called with `'+15550109000'` (never the roster, never the pool number) |
| 11 | group_text, roster `[{ contactId: 'c-g', phone: '+15550100002' }]` | key `'phone#+15550100002'` | `'c-g'` |
| 12 | tenant_1to1, participants c-t, `participant_phone: '+15550100005'` | inbound sms | `'c-t'` (participants win over a phone that resolves elsewhere) |
| 13 | tenant_1to1, participants `[{ contactId: '', phone: '' }]`, `participant_email: 'e@x.test'` | inbound email | `'c-email'` |
| 14 | unknown_1to1, no participants, `participant_phone: '+15550100005'` | inbound sms | `'c-phone'` |
| 15 | tenant_1to1, no participants, `participant_phone: '+15550100999'`, `participant_email: 'e@x.test'` | inbound sms | `'c-email'` (falls through on a phone miss) |
| 16 | tenant_1to1, participants c-t | `{ direction: 'inbound', type: 'email', email_new_address: true }` | undefined |
| 17 | landlord_1to1, participants c-t | inbound email, no flag (an `author: 'unknown'` row - author is not read) | `'c-t'` |
| 18 | thread with NO `type` (legacy row; cast `as never`), participants c-t | inbound sms | `'c-t'` (the 1:1 branch) |
| 19 | landlord_1to1, participants c-t | `{ direction: 'inbound', type: 'call' }` (an imported 1:1 call, no sender fields) | `'c-t'` |
| 20 | relay, roster c-a | key `'phone#+15550100007'` with an ASYNC lookup (`byPhone: async (p) => ...`) | `'c-nonmember'` (MaybePromise) |

`describe('repoLookup')`: with `contacts = { findByPhone: vi.fn(async () => ({ contactId: 'c-repo' })), findByEmail: vi.fn(async () => ({ contactId: 'c-repo-e' })) }`
and `cache = new Map([['+15550100001', { contactId: 'c-cached' }]])`:
`await repoLookup(contacts, cache).byPhone('+15550100001')` is `{ contactId: 'c-cached' }`
with `findByPhone` NOT called; `byPhone('+15550100002')` delegates (called
once with that phone); `byEmail('a@b.test')` delegates to `findByEmail`;
without a cache both delegate.

RED: `attributeInbound` / `repoLookup` are not exported.

GREEN - append to `app/src/lib/heardFrom.ts` (and put the three `import type`
lines at the top of the file, under the header comment):

```ts
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem } from '../repos/conversationsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';

export type MaybePromise<T> = T | Promise<T>;

export interface HeardFromLookup {
  byPhone(e164: string): MaybePromise<{ contactId: string } | undefined>;
  byEmail(address: string): MaybePromise<{ contactId: string } | undefined>;
}

/** The row fields the rule reads - the PERSISTED message/call row. */
export type HeardFromRow = Pick<
  MessageItem,
  | 'direction'
  | 'type'
  | 'relay_sender_key'
  | 'relay_retry_of'
  | 'email_new_address'
  | 'relay_external_caller_contact_id'
  | 'relay_external_caller_phone'
>;

/** The thread fields the rule reads - the PERSISTED conversation. */
export type HeardFromThread = Pick<ConversationItem, 'type' | 'participants' | 'participant_phone' | 'participant_email'>;

/** Multi-party thread types: attribution is per SENDER KEY, never the roster. */
const GROUP_THREAD_TYPES: ReadonlySet<string> = new Set(['relay_group', 'group_text']);
/** The staff sentinel sender key (TEAM_SENDER_KEY, jobs/relayFanOut.ts). */
const TEAM_SENDER_KEY = 'team';
/** groupMemberKey / relayMemberKey's phone-scoped key prefix. */
const PHONE_KEY_PREFIX = 'phone#';

/** WHICH contact an inbound row is FROM (spec 5.1 + 14.2) - the ONE rule.
 *  `row` is the persisted message/call row, `thread` the PERSISTED conversation
 *  it lives on. Returns undefined when the row is not attributable.
 *  Discriminated by THREAD TYPE, never by which fields a row happens to carry.
 *  Always async: the lookup may answer synchronously (the seed) or not. */
export async function attributeInbound(
  row: HeardFromRow,
  thread: HeardFromThread,
  lookup: HeardFromLookup,
): Promise<string | undefined> {
  // 1. Only inbound counts. A relay 30003 retry COPIES the original's
  //    direction (webhooks/twilio.ts:2963), so it is never attributed.
  if (row.direction !== 'inbound' || nonEmpty(row.relay_retry_of)) return undefined;

  // 2. Group threads: the sender key decides.
  if (GROUP_THREAD_TYPES.has(thread.type)) {
    const key = row.relay_sender_key;
    if (nonEmpty(key)) {
      if (key === TEAM_SENDER_KEY) return undefined;
      if (key.startsWith(PHONE_KEY_PREFIX)) {
        const e164 = key.slice(PHONE_KEY_PREFIX.length);
        // An entry with an EMPTY contactId (a phone-only relay member, an
        // imported roster) counts as absent.
        const member = (thread.participants ?? []).find((p) => p.phone === e164 && nonEmpty(p.contactId));
        if (member !== undefined) return member.contactId;
        return (await lookup.byPhone(e164))?.contactId;
      }
      return key;
    }
    // A KEYLESS row: only a refused non-member call says who it was from.
    // A roster member is NEVER the fallback (an imported group call stays
    // unattributed).
    if (nonEmpty(row.relay_external_caller_contact_id)) return row.relay_external_caller_contact_id;
    if (nonEmpty(row.relay_external_caller_phone)) {
      return (await lookup.byPhone(row.relay_external_caller_phone))?.contactId;
    }
    return undefined;
  }

  // 3. Any other thread (a 1:1 of any type, or a legacy typeless row). An
  //    email from an address on no contact is not attributed until staff link
  //    it - keyed on email_new_address, never on author 'unknown' (which a
  //    verified stub or team-member sender also gets).
  if (row.type === 'email' && row.email_new_address === true) return undefined;
  const participant = (thread.participants ?? []).find((p) => nonEmpty(p.contactId));
  if (participant !== undefined) return participant.contactId;
  if (nonEmpty(thread.participant_phone)) {
    const hit = await lookup.byPhone(thread.participant_phone);
    if (hit !== undefined) return hit.contactId;
  }
  if (nonEmpty(thread.participant_email)) {
    const hit = await lookup.byEmail(thread.participant_email);
    if (hit !== undefined) return hit.contactId;
  }
  return undefined;
}

/** A HeardFromLookup over a contacts repo, with an optional pre-resolved cache
 *  (the live paths pass the contacts they already hold, keyed by the phone or
 *  address they resolved them from). findByPhone ignores soft-deletion, so a
 *  deleted contact still resolves (and a restored one keeps its value). */
export function repoLookup(
  contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>,
  cache?: ReadonlyMap<string, { contactId: string }>,
): HeardFromLookup {
  return {
    byPhone: (e164) => cache?.get(e164) ?? contacts.findByPhone(e164),
    byEmail: (address) => cache?.get(address) ?? contacts.findByEmail(address),
  };
}
```

Commit: `feat(app): attributeInbound - the one rule for whom an inbound row is from`.

---
The eight live paths (Tasks 1.3-1.10) share four facts, repeated in each
task's code: the touch runs AFTER the append on the fresh AND the deduped
branch (except email, whose deduped branch returns early by design); the
instant is `splitTsMsgId(<persisted tsMsgId>).providerTs`; attribution uses
the PERSISTED thread; any throw from attribution is caught and logged with
the line from contract note 6 - the webhook answers exactly as before. Each
task's tests assert `world.heardFromTouches` (Task 1.1), and RED for each is
"`world.heardFromTouches` is empty - the path never calls the writer".

### Task 1.3 - path 1, 1:1 SMS/MMS (`app/src/routes/webhooks/twilio.ts`, `router.post('/sms')`)

RED - `app/test/twilioSmsWebhook.test.ts` (harness `makeWebhookHarness`,
`inboundSmsParams`, `TENANT_PHONE`, `SMS_PATH` as the file already imports;
add `splitTsMsgId` from `../src/repos/messagesRepo.js`). New
`describe('last heard from (spec 5.1) - 1:1 inbound')` at the end of the file:

1. known tenant: `world.contacts.push({ contactId: 'c-tenant', type: 'tenant', phone: TENANT_PHONE })`;
   post `inboundSmsParams()`; with `row = world.messages[0]!` and
   `at = splitTsMsgId(row.tsMsgId).providerTs`:
   `world.heardFromTouches` `toEqual([{ contactId: 'c-tenant', at, outcome: 'written' }])`
   and the contact's `last_heard_from_at` is `at`.
2. unknown phone: post; `stub = world.contacts.find((c) => c.phone === TENANT_PHONE)!`
   (the auto-captured stub); touches = `[{ contactId: stub.contactId, at, outcome: 'written' }]`
   (the captured contact feeds the lookup cache - the byPhone index would lag).
3. REDELIVERY: post the same params twice; two touches, BOTH with the
   FIRST row's `at`, outcomes `['written', 'skipped']`; one message row.
4. crash repair: known tenant; replace the writer for ONE call:
   `const real = world.contactsRepo.touchLastHeardFrom.bind(world.contactsRepo); let calls = 0; world.contactsRepo.touchLastHeardFrom = async (id, at) => (++calls === 1 ? 'failed' : real(id, at));`
   first post answers 200 and `capture.atLevel(50)` holds a line whose `msg`
   is exactly `last_heard_from touch failed - message persisted, last_heard_from stale`;
   the redelivery leaves `last_heard_from_at` = the first row's instant.
5. echo dedupe: known tenant; post once; then
   `world.messages[0]!.direction = 'outbound'` (the persisted row is now our
   own send); redeliver; `world.heardFromTouches` still has length 1.
6. In the existing `'FULL LOOP: outbound send ... dedupes to a no-op'` case
   (`:325`), add `expect(world.heardFromTouches).toEqual([]);` after `:365`.

GREEN - `twilio.ts`:

- imports: add `splitTsMsgId,` after `relayMemberKey,` in the messagesRepo
  import (`:76`); new line after `:41`:
  `import { attributeInbound, repoLookup, type HeardFromRow } from '../../lib/heardFrom.js';`
- hoist the persisted row: after `let mediaAlreadyMirrored = false;` (`:2501`)
  add `let persistedRow: MessageItem | undefined;`; inside the dedupe block,
  after `persistedTsMsgId = persisted.tsMsgId;` (`:2524`) add
  `persistedRow = persisted;`.
- insert after the touchPhoneLastSeen block (closing `}` at `:2578`):

```ts
    // (3.7) Last heard from (spec 5.1 / 14.2). Runs on the fresh AND the
    // deduped branch (a redelivery repairs a crash between the append and this
    // line); the instant is the PERSISTED row's key, so a redelivery never
    // moves the value past the first delivery. On a dedupe the persisted row
    // decides: our own send's echo is outbound and touches nobody. Attribution
    // runs on the PERSISTED thread, with the captured contact as the lookup
    // cache (the byPhone index lags a stub minted moments ago). Best-effort.
    try {
      const heardThread =
        persistedConversationId === conversation.conversationId
          ? conversation
          : await conversations.getById(persistedConversationId);
      const heardRow: HeardFromRow = persistedRow ?? {
        direction: 'inbound',
        type: mediaUrls.length > 0 ? 'mms' : 'sms',
      };
      const heardFromId =
        heardThread === undefined
          ? undefined
          : await attributeInbound(
              heardRow,
              heardThread,
              repoLookup(contacts, effectiveContact ? new Map([[From, effectiveContact]]) : undefined),
            );
      if (heardFromId !== undefined) {
        const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(persistedTsMsgId).providerTs);
        if (outcome === 'failed') {
          log.error({ providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
    }
```

Commit: `feat(app): 1:1 inbound texts move last heard from (fresh and redelivered)`.

### Task 1.4 - path 2, relay group open thread (`handleRelayInbound`, `twilio.ts:865-1116`)

Locals in scope: `relay`, `sender`, `senderKey` (`:893`, contactId or
`phone#From`), `senderContact` (`:897`), `mediaUrls`, `appended` (`:913`).
No read-back exists here and none is added (spec 14.2: relay legs are sent
FROM the pool number and an echo is dropped upstream).

RED - `app/test/relayWebhook.test.ts`, appended INSIDE
`describe('relay inbound webhook (M1.7)')` (`:80`, so its `beforeEach`
fan-out wiring applies), after its last case:

1. member: `seedRelay(world); world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE })`;
   post `relayInboundParams()`; with the relay row `m` (provider_sid
   `RELAY_INBOUND_SID`): touches `[{ contactId: 'c-alice', at: splitTsMsgId(m.tsMsgId).providerTs, outcome: 'written' }]`.
2. phone-only member: `seedRelay(world, { participants: [{ contactId: '', phone: ALICE }, { contactId: 'c-bob', phone: BOB, name: 'Bob' }] })`
   and `world.contacts.push({ contactId: 'c-alice-row', type: 'tenant', phone: ALICE })`;
   the row's `relay_sender_key` is `` `phone#${ALICE}` `` and the touch names `'c-alice-row'`.
3. non-member on an open group: `seedRelay(world); world.contacts.push({ contactId: 'c-zara', type: 'tenant', phone: ZARA })`;
   post `relayInboundParams({ From: ZARA, MessageSid: 'SMheard-nonmember' })`;
   touch names `'c-zara'` (no fan-out, as today).
4. redelivery: case 1's setup, post twice: two touches with the same (first)
   `at`, outcomes `['written', 'skipped']`.

GREEN - insert after the media-mirror block (closing `}` at `:939`), before
the keyword-classification comment at `:940`:

```ts
    // Last heard from (spec 5.1 / 14.2): fresh AND deduped. A member is its
    // roster key; a phone-only member and a NON-member (`phone#From`) resolve
    // through findByPhone. No echo reaches this path (relay legs are sent FROM
    // the pool number and dropped upstream), so no read-back. Best-effort.
    try {
      const heardThread =
        appended.conversationId === relay.conversationId
          ? relay
          : await conversations.getById(appended.conversationId);
      const heardFromId =
        heardThread === undefined
          ? undefined
          : await attributeInbound(
              { direction: 'inbound', type: mediaUrls.length > 0 ? 'mms' : 'sms', relay_sender_key: senderKey },
              heardThread,
              repoLookup(contacts),
            );
      if (heardFromId !== undefined) {
        const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
        if (outcome === 'failed') {
          log.error({ providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
    }
```

(No cache: a member with a contactId needs no lookup, and `senderContact`
exists only for those members.)

Commit: `feat(app): relay group texts move the sender's last heard from, members and non-members`.

### Task 1.5 - path 3, closed relay group late text (`handleClosedGroupInbound`, `twilio.ts:1248-1414`)

Locals: `group`, `contact` (`:1280`, `findByPhone(From)`, may be undefined),
`conversation` (the sender's 1:1, `:1281`), `mediaUrls`, `appended` (`:1288`).
No `captureContact` on this path, so an unknown phone has no contact and no
touch - the rule reproduces that (no participants, `findByPhone` misses).

RED - same file, same describe:

1. `seedRelay(world, { status: 'closed' }); world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE })`;
   post `relayInboundParams()`; the message lands in Alice's 1:1 (as the
   existing case at `:161` proves); touch names `'c-alice'` at that row's
   instant.
2. no contact row for the phone: `seedRelay(world, { status: 'closed' })`
   only; post; `world.heardFromTouches` `toEqual([])`.
3. redelivery: case 1 twice; the second touch carries the first `at`.

GREEN - insert after the media-mirror block (closing `}` at `:1340`),
before the inbox-touch comment at `:1342`:

```ts
    // Last heard from (spec 5.1 / 14.2): fresh AND deduped, on the sender's
    // 1:1. No captureContact runs here, so an unknown phone resolves to no
    // contact and touches nobody. Best-effort.
    try {
      const heardThread =
        appended.conversationId === conversation.conversationId
          ? conversation
          : await conversations.getById(appended.conversationId);
      const heardFromId =
        heardThread === undefined
          ? undefined
          : await attributeInbound(
              { direction: 'inbound', type: mediaUrls.length > 0 ? 'mms' : 'sms' },
              heardThread,
              repoLookup(contacts, contact ? new Map([[From, contact]]) : undefined),
            );
      if (heardFromId !== undefined) {
        const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
        if (outcome === 'failed') {
          log.error({ providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
    }
```

Commit: `feat(app): a late text to a closed relay group moves last heard from`.

### Task 1.6 - path 4, native group text (group branch, `twilio.ts:~1940-2223`)

Locals: `thread`, `senderE164` (`:1952`), `senderKey` (`:1971`, always
`phone#...`), `senderContact` (`:2001`), `mediaUrls` (`:2014`), `appended`
(`:2026`). The dedupe block reads the persisted row back (`:2053`) and
returns `{ handled: false }` when it lives elsewhere (`:2059-2069`), so the
persisted thread here is always `thread`.

RED - `app/test/groupTextWebhook.test.ts`, new
`describe('group detection: last heard from (spec 5.1)')` at the end
(helpers `groupParams`, `groupThread`, `SENDER`):

1. known sender: `world.contacts.push({ contactId: 'c-known', type: 'tenant', phone: SENDER })`;
   post `groupParams()`; `rosterId = groupThread(world)!.participants!.find((p) => p.phone === SENDER)!.contactId`;
   touches `[{ contactId: rosterId, at: <the group row's tsMsgId prefix>, outcome: 'written' }]`,
   and `world.contacts.find((c) => c.contactId === rosterId)!.last_heard_from_at` equals that `at`.
2. redelivery: post `groupParams()` twice; two touches with the same `at`,
   outcomes `['written', 'skipped']`.
3. echo dedupe: post once; `world.messages[0]!.direction = 'outbound'`;
   redeliver; touches still length 1.
4. persisted row unreadable on a dedupe: post once; then
   `world.messagesRepo.getByProviderSid = async () => undefined`; redeliver;
   touches still length 1 (an unread persisted row touches nobody).

GREEN:

- after `let groupMediaAlreadyMirrored = false;` (`:2050`) add
  `let groupPersisted: MessageItem | undefined;`; inside the `try`, right
  after the elsewhere-guard's closing `}` (`:2069`), add
  `groupPersisted = persisted;`.
- insert after the touchPhoneLastSeen block (closing `}` at `:2111`):

```ts
    // Last heard from (spec 5.1 / 14.2) - DELIBERATELY NOT GATED ON
    // `appended.deduped`, like the cross-check below: a redelivery repairs a
    // crash between the append and this line. On a dedupe the PERSISTED row
    // decides (an echo of our own send is outbound and touches nobody), and an
    // unreadable persisted row touches nobody (that read failure is already
    // logged above). The sender's resolved contact feeds the lookup cache.
    try {
      const heardRow: HeardFromRow | undefined = appended.deduped
        ? groupPersisted
        : { direction: 'inbound', type: mediaUrls.length > 0 ? 'mms' : 'sms', relay_sender_key: senderKey };
      const heardFromId =
        heardRow === undefined
          ? undefined
          : await attributeInbound(
              heardRow,
              thread,
              repoLookup(
                contacts,
                senderContact && senderE164 !== undefined ? new Map([[senderE164, senderContact]]) : undefined,
              ),
            );
      if (heardFromId !== undefined) {
        const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
        if (outcome === 'failed') {
          log.error({ providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
    }
```

Commit: `feat(app): native group texts move the sender's last heard from`.

### Task 1.7 - path 5, business-line call / founder bridge (`handleFounderTriage`, `app/src/routes/webhooks/voice.ts:647-922`)

Locals: `callerContact` (`:716`), `conversation` (`:734`), `startedAt`
(`:777`), `appended` (const INSIDE the try at `:778-817`). The two refusals
that return before any append (no holder `:677-691`, self-call `:704-711`)
leave no row and touch nobody.

RED - `app/test/founderTriage.test.ts` (`founderHarness(world)`,
`bizVoiceParams()`), in the describe holding the known/unknown caller cases
(`:256`, `:291`):

1. known caller: `world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER })`;
   post `bizVoiceParams()`; the call row `m` (type `call`); touches
   `[{ contactId: 'c-caller', at: splitTsMsgId(m.tsMsgId).providerTs, outcome: 'written' }]`.
2. unknown caller: touches name `world.contacts[0]!.contactId` (the captured
   stub - RED also because `captureContact`'s return is discarded today).
3. redelivery: post the same params twice; two touches, same `at`.
4. (PIN) in the existing SELF-CALL case (`:414`) and the no-holder case
   (`:432`), add `expect(world.heardFromTouches).toEqual([]);`.
5. a NON-MEMBER calling a pool number whose relay groups are ALL CLOSED is
   routed to founder triage and touched (the reachable form of "a non-member
   calls a closed group"): `resolveRelayInbound` answers
   `all_closed_non_member` (`app/src/services/relayInboundResolution.ts:89-96`)
   and the voice router falls through to `handleFounderTriage`
   (`voice.ts:594-619`, then `:633`). Setup: `const relay = seedRelayGroup(world); relay.status = 'closed';`
   (the file's helper, `:66-85`; roster ALICE + BOB) and
   `world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER })`;
   post `bizVoiceParams({ To: POOL, CallSid: 'CAheard-closed-nonmember' })`.
   Assert: the response dials `HOLDER_CELL` (the founder bridge); the call row
   lives on the CALLER's 1:1 (`conversationId !== 'conv-relay-voice-1'`) and no
   row was filed on the relay; touches
   `[{ contactId: 'c-caller', at: <that row's tsMsgId prefix>, outcome: 'written' }]`.

GREEN - `voice.ts`:

- imports: `splitTsMsgId,` after `relayMemberKey,` (`:76`); new line after
  `:56`: `import { attributeInbound, repoLookup } from '../../lib/heardFrom.js';`
- keep the capture's answer - replace `:747-748`:

```ts
    let capturedCaller: ContactItem | undefined = callerContact;
    try {
      capturedCaller = await captureContact(conversation, callerContact, 'inbound_call');
```

  (the `catch` at `:749-754` is unchanged; `ContactItem` is already imported
  at `:65`).
- insert INSIDE the try, after the `if (!appended.deduped) { ... }` block
  (its closing `}` at `:812`) and before `} catch (err) {` (`:813`):

```ts
      // Last heard from (spec 5.1 / 14.2): a call touches at its ring instant
      // whatever its outcome - fresh AND deduped (a redelivery repairs a crash
      // here; voice drops a From equal to one of our numbers upstream, so no
      // echo reaches this line). The captured caller feeds the lookup cache.
      try {
        const heardThread =
          appended.conversationId === conversation.conversationId
            ? conversation
            : await conversations.getById(appended.conversationId);
        const heardFromId =
          heardThread === undefined
            ? undefined
            : await attributeInbound(
                { direction: 'inbound', type: 'call' },
                heardThread,
                repoLookup(contacts, capturedCaller ? new Map([[From, capturedCaller]]) : undefined),
              );
        if (heardFromId !== undefined) {
          const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
          if (outcome === 'failed') {
            log.error({ callSid: CallSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
          }
        }
      } catch (err) {
        log.error({ err, callSid: CallSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
      }
```

  (Its own inner try: the outer catch's message says the PERSIST failed,
  which would be false here.)

Commit: `feat(app): a call to the business line moves the caller's last heard from`.

### Task 1.8 - path 6, masked relay call refused (`handleMaskedInbound` refusal branch, `voice.ts:1006-1077`)

Locals: `caller` (`:997`), `reason` (`:1007`), `relayExternalCallerPhone`,
`relayExternalCallerContactId` (`:1017-1033`; the id is left unset when the
match is soft-deleted or the lookup failed), `appended` (const inside the try
`:1035-1070`).

This path's source is unchanged apart from the touch. A non-member reaching
the CLOSED-thread refusal is unreachable today: `resolveRelayInbound`
returns `closed_member` only for a roster member and sends a non-member to
an OPEN group or, when every group is closed, to founder triage
(`app/src/services/relayInboundResolution.ts:89-96`) - that case is path 5,
covered by Task 1.7 RED case 5.

RED - `app/test/voiceWebhook.test.ts`, new
`describe('inbound masked voice - last heard from (spec 5.1)')` after
`:663` (helpers `seedRelay`, `inboundVoiceParams`, `ALICE`, `CAROL`), each
case with `world = createFakeWorld()`; `at` is the call row's tsMsgId
prefix:

1. `closed_thread`: `seedRelay(world, { status: 'closed' }); world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE })`;
   `CallSid: 'CAheard-closed'` -> touch `'c-alice'`.
2. `non_member`, live match: `world.contacts.push({ contactId: 'c-external', type: 'unknown', phone: CAROL })`;
   `From: CAROL` -> touch `'c-external'`.
3. `non_member`, SOFT-DELETED match: the same contact with
   `deleted_at: '2026-08-28T12:00:00.000Z'` -> the row has no
   `relay_external_caller_contact_id` (as `:537` proves) and the touch STILL
   names `'c-external'` (findByPhone ignores deletion; a restore keeps the value).
4. `non_member`, unmatched: no contact for CAROL -> touches `[]`.
5. `no_callee`, phone-only caller: `seedRelay(world, { participants: [{ contactId: '', phone: ALICE }] }); world.contacts.push({ contactId: 'c-alice-row', type: 'tenant', phone: ALICE })`
   -> touch `'c-alice-row'`.
6. `no_pool_number`: `const relay = seedRelay(world, { pool_number: undefined }); world.conversationsRepo.getAllByPoolNumber = async () => [relay]; world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE })`
   (the `:646-648` technique) -> touch `'c-alice'`.
7. deduped redelivery: case 2 posted twice -> two touches, same `at`.
8. persist failure: case 1 with `world.messagesRepo.append = async () => { throw new Error('boom'); }`
   -> refusal TwiML (`<Hangup`) and touches `[]` (the touch sits after the
   append, inside its try).

GREEN - insert INSIDE the try, after the `if (!appended.deduped) { ... }`
block (closing `}` at `:1065`) and before `} catch (err) {` (`:1066`):

```ts
        // Last heard from (spec 5.1 / 14.2): a refused call still means the
        // caller reached out - every refusal reason, fresh AND deduped. A member
        // is its roster key (a phone-only member resolves by phone); a
        // non-member is its stored contact id, else findByPhone (the id is
        // left unset for a soft-deleted match). Best-effort.
        try {
          const heardThread =
            appended.conversationId === relay.conversationId
              ? relay
              : await conversations.getById(appended.conversationId);
          const heardFromId =
            heardThread === undefined
              ? undefined
              : await attributeInbound(
                  {
                    direction: 'inbound',
                    type: 'call',
                    ...(caller !== undefined && { relay_sender_key: relayMemberKey(caller) }),
                    ...(relayExternalCallerPhone !== undefined && { relay_external_caller_phone: relayExternalCallerPhone }),
                    ...(relayExternalCallerContactId !== undefined && {
                      relay_external_caller_contact_id: relayExternalCallerContactId,
                    }),
                  },
                  heardThread,
                  repoLookup(contacts),
                );
          if (heardFromId !== undefined) {
            const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
            if (outcome === 'failed') {
              log.error({ callSid: CallSid, reason }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
            }
          }
        } catch (err) {
          log.error({ err, callSid: CallSid, reason }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
```

(The two external-caller locals are only ever set when `reason === 'non_member'`
(`:1019`), so the row literal matches what `:1052-1056` persisted.)

Commit: `feat(app): a refused masked relay call moves the caller's last heard from`.

### Task 1.9 - path 7, masked relay call bridged (`voice.ts:1101-1136`)

Locals: `caller` (a roster member, non-undefined here), `callerContact`
(`:1103`), `appended` (const inside the try `:1111-1136`).

RED - same new describe:

1. member: `seedRelay(world); world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE })`;
   post `inboundVoiceParams({ CallSid: 'CAheard-bridge' })` (bridges to Bob)
   -> touch `'c-alice'` at the call row's instant.
2. phone-only member: `seedRelay(world, { participants: [{ contactId: '', phone: ALICE }, { contactId: 'c-bob', phone: BOB, name: 'Bob' }] }); world.contacts.push({ contactId: 'c-alice-row', type: 'tenant', phone: ALICE })`
   -> touch `'c-alice-row'`.
3. redelivery: case 1 twice -> same `at`, outcomes `['written', 'skipped']`.

GREEN - insert INSIDE the try, after the `if (!appended.deduped) { ... }`
block (closing `}` at `:1133`) and before `} catch (err) {` (`:1134`):

```ts
      // Last heard from (spec 5.1 / 14.2): fresh AND deduped; the member's
      // roster key (a phone-only member resolves by phone). Best-effort.
      try {
        const heardThread =
          appended.conversationId === relay.conversationId
            ? relay
            : await conversations.getById(appended.conversationId);
        const heardFromId =
          heardThread === undefined
            ? undefined
            : await attributeInbound(
                { direction: 'inbound', type: 'call', relay_sender_key: relayMemberKey(caller) },
                heardThread,
                repoLookup(contacts),
              );
        if (heardFromId !== undefined) {
          const outcome = await contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
          if (outcome === 'failed') {
            log.error({ callSid: CallSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
          }
        }
      } catch (err) {
        log.error({ err, callSid: CallSid }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
      }
```

Commit: `feat(app): a bridged masked relay call moves the caller's last heard from`.

### Task 1.10 - path 8, inbound email (`app/src/services/inboundEmail.ts`, the shared `thread()` pipeline `:648-838`)

Locals inside `thread(conversationId, author, flagNewAddress, threadContact)`:
`providerTs` (`:710`), `appended` (`:734`), `touched` (`:747`), `fromNorm`,
`bucket`, `key`, `log`. The deduped branch returns at `:735-742` ("the
winner runs the side effects"), so the touch sits with the winner's side
effects and is never re-run. `threadContact` is undefined exactly when the
address is unverified (tier 5, `email_new_address: true`).

RED - `app/test/inboundEmail.test.ts`:

- harness: `WorldOver` (`:109`) gains `touchHeardFromResult?: 'written' | 'skipped' | 'failed';`;
  in `makeWorld` add, next to `touchEmailLastSeen` (`:258`):
  `const findByPhone = vi.fn(async (_phone: string) => undefined as ContactItem | undefined);`
  and `const touchLastHeardFrom = vi.fn(async (_id: string, _at: string) => over.touchHeardFromResult ?? 'written');`;
  `deps.contacts` (`:306`) becomes
  `{ findByEmail, findByPhone, getById, touchEmailLastSeen, touchLastHeardFrom }`;
  return `touchLastHeardFrom` from `makeWorld` (next to `touchEmailLastSeen`).
- new `describe('last heard from (spec 5.1) - inbound email')`:
  1. tier 6 known tenant (`makeWorld({})`): `touchLastHeardFrom` called once
     with `('c1', NOW)`.
  2. an UNKNOWN-TYPED contact (`makeWorld({ contact: { type: 'unknown' } })`,
     author `unknown` as `:795` proves) is STILL touched with `('c1', NOW)`.
  3. tier 5 new address (the `:664` setup verbatim) -> `touchLastHeardFrom`
     NOT called.
  4. tier 5 known address via token (the `:685` setup verbatim) -> called
     with `('c1', NOW)`.
  5. `makeWorld({ appendDeduped: true })` -> NOT called.
  6. `makeWorld({ touchHeardFromResult: 'failed' })` -> outcome `threaded`
     and `w.capture.atLevel(50)` holds a line whose `msg` is
     `last_heard_from touch failed - message persisted, last_heard_from stale`.

GREEN:

- imports: `import { attributeInbound, repoLookup } from '../lib/heardFrom.js';`
  and `import { splitTsMsgId } from '../repos/messagesRepo.js';` (a VALUE
  import beside the existing `import type` from that module at `:68`).
- `InboundEmailDeps.contacts` (`:212`) becomes
  `Pick<ContactsRepo, 'findByEmail' | 'findByPhone' | 'getById' | 'touchEmailLastSeen' | 'touchLastHeardFrom'>`
  (the three construction sites - `routes/unmatchedEmail.ts:216`,
  `routes/webhooks/ses.ts:110`, `worker.ts:219` - pass a full repo).
- insert after the address-freshness block (closing `}` at `:811`), before
  the extraction comment:

```ts
    // Last heard from (spec 5.1 / 14.2): the WINNER's side effects only (a
    // deduped delivery returned above). An unverified address
    // (`email_new_address`) touches nobody; a VERIFIED sender whose contact is
    // an unknown-typed stub or a team member DOES count (author 'unknown' is
    // not the test). Attribution runs on the persisted thread (the touch's
    // snapshot, else a re-read). A reingest carries the mail's original time;
    // the writer is forward-only. Best-effort: never fails the ingest.
    try {
      const heardThread = touched ?? (await deps.conversations.getById(conversationId));
      const heardFromId =
        heardThread === undefined
          ? undefined
          : await attributeInbound(
              { direction: 'inbound', type: 'email', ...(flagNewAddress && { email_new_address: true }) },
              heardThread,
              repoLookup(deps.contacts, threadContact !== undefined ? new Map([[fromNorm, threadContact]]) : undefined),
            );
      if (heardFromId !== undefined) {
        const outcome = await deps.contacts.touchLastHeardFrom(heardFromId, splitTsMsgId(appended.tsMsgId).providerTs);
        if (outcome === 'failed') {
          log.error({ bucket, key, conversationId }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
        }
      }
    } catch (err) {
      log.error(
        { bucket, key, conversationId, ...errFields(err) },
        'last_heard_from touch failed - message persisted, last_heard_from stale',
      );
    }
```

Commit: `feat(app): inbound email from a known address moves last heard from`.

### Task 1.11 - the two dev fixture seams (`app/src/routes/dev.ts`)

Both write branches of `/__dev/extraction/message-fixture` (the append at
`:1056-1092` and the direct Put at `:1094-1115`) and
`/__dev/voice/transcript-fixture` (`:794-877`) touch through the same rule,
so e2e state built through them obeys it (spec 5.1, 14.2).

RED:

1. `app/test/devMessageTransportFixture.test.ts` - `rig()` gains injected
   fakes and records touches (every existing case keeps passing - the
   injection also keeps them off the default DynamoDB client):

```ts
function rig(threads: Record<string, Record<string, unknown>> = {}) {
  const puts: Record<string, unknown>[] = [];
  const touches: { contactId: string; at: string }[] = [];
  const appends: Record<string, unknown>[] = [];
  const doc = { send: async (command: { input?: { Item?: Record<string, unknown> } }) => {
    if (command.input?.Item !== undefined) puts.push(command.input.Item);
    return {};
  } };
  const heardFromRepos = {
    contactsRepo: {
      findByPhone: async () => undefined,
      findByEmail: async () => undefined,
      touchLastHeardFrom: async (contactId: string, at: string) => {
        touches.push({ contactId, at });
        return 'written' as const;
      },
    },
    conversationsRepo: { getById: async (id: string) => threads[id] as never },
  };
  const voiceFixtureRepos = {
    messages: {
      append: async (m: { conversationId: string; providerTs: string; providerSid: string }) => {
        appends.push(m);
        return { deduped: false, tsMsgId: `${m.providerTs}#${m.providerSid}`, conversationId: m.conversationId };
      },
      setCallTranscript: async () => undefined,
    },
    extraction: { scheduleExtraction: async () => undefined },
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
    CF_ORIGIN_SECRET: 'test-origin-secret',
  });
  const app = express();
  app.use(createDevRouter({ config, doc: doc as never, heardFromRepos, voiceFixtureRepos: voiceFixtureRepos as never }));
  return { app, puts, touches, appends };
}
```

   New cases (`const TENANT_THREAD = { 'conversation-fixture': { type: 'tenant_1to1', participants: [{ contactId: 'c-t', phone: '+15550100001' }] } }`):
   - direct-Put branch, inbound: `rig(TENANT_THREAD)`, post `base` -> 200,
     `touches` `toEqual([{ contactId: 'c-t', at: '2026-08-01T00:00:00.000Z' }])`.
   - direct-Put branch, outbound (`direction: 'outbound', transport: { mode: 'versioned', requested: 'sms' }`)
     -> `touches` `[]`.
   - append branch: post `{ ...base, providerSid: 'SM' + 'a'.repeat(32) }`
     -> one append, `touches` names `'c-t'`.
   - relay key on a relay thread:
     `rig({ 'conversation-fixture': { type: 'relay_group', participants: [{ contactId: 'c-r', phone: '+15550100002' }] } })`,
     post `{ ...base, relaySenderKey: 'c-r' }` -> touch `'c-r'`.
   - unknown conversation (`rig()` with no threads) -> 200, `touches` `[]`.
2. New `app/test/devTranscriptFixture.test.ts` - the same rig shape
   (copy it; the file stands alone), driving
   `POST /__dev/voice/transcript-fixture` with
   `{ conversationId: 'conversation-fixture', callSid: 'CAfixture-heard', sentences: [{ text: 'hello', mediaChannel: 1 }] }`:
   inbound -> 200 and one touch naming `'c-t'` whose `at` equals the append's
   `providerTs`; `direction: 'outbound'` -> 200 and no touch; a touch fake
   answering `'failed'` -> still 200.
   RED: `heardFromRepos` / `voiceFixtureRepos` are not `DevRouterDeps` keys
   (tsc) and nothing touches.

GREEN - `dev.ts`:

- imports: add `type MessagesRepo,` and `splitTsMsgId,` to the messagesRepo
  import (`:40-45`); change `import { createExtractionRepo } from '../repos/extractionRepo.js';`
  (`:67`) to `import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';`;
  new line `import { attributeInbound, repoLookup, type HeardFromRow } from '../lib/heardFrom.js';`.
- `DevRouterDeps`, after `orgFixtureRepos?` (`:144`):

```ts
  /** Repos for the last-heard-from touch in the two inbound fixture seams
   *  (spec 5.1 / 14.2) - injected in tests; default to the real repos. */
  heardFromRepos?: {
    contactsRepo: Pick<ContactsRepo, 'findByPhone' | 'findByEmail' | 'touchLastHeardFrom'>;
    conversationsRepo: Pick<ConversationsRepo, 'getById'>;
  };
  /** Repos for the transcript and message fixture APPENDS - injected in tests;
   *  default to the real messages and extraction repos. */
  voiceFixtureRepos?: {
    messages: Pick<MessagesRepo, 'append' | 'setCallTranscript'>;
    extraction: Pick<ExtractionRepo, 'scheduleExtraction'>;
  };
```

- replace `:784-793` (`let voiceFixtureRepos ... transcriptFixtureRepos`) with:

```ts
  let voiceFixtureRepos: NonNullable<DevRouterDeps['voiceFixtureRepos']> | undefined = deps.voiceFixtureRepos;
  const transcriptFixtureRepos = (): NonNullable<DevRouterDeps['voiceFixtureRepos']> => {
    voiceFixtureRepos ??= {
      messages: createMessagesRepo({ logger: log }),
      extraction: createExtractionRepo({ logger: log }),
    };
    return voiceFixtureRepos;
  };
  // Last heard from for the two inbound fixture seams (spec 5.1 / 14.2): the
  // same rule and the same writer as the live paths. Best-effort, like them:
  // a failure is logged and the fixture still answers its normal response.
  let heardFromRepos = deps.heardFromRepos;
  const heardFromDeps = (): NonNullable<DevRouterDeps['heardFromRepos']> => {
    heardFromRepos ??= {
      contactsRepo: createContactsRepo({ logger: log }),
      conversationsRepo: createConversationsRepo({ logger: log }),
    };
    return heardFromRepos;
  };
  const touchFixtureHeardFrom = async (
    row: HeardFromRow,
    persisted: { conversationId: string; tsMsgId: string },
  ): Promise<void> => {
    try {
      const { contactsRepo, conversationsRepo } = heardFromDeps();
      const thread = await conversationsRepo.getById(persisted.conversationId);
      const heardFromId = thread === undefined ? undefined : await attributeInbound(row, thread, repoLookup(contactsRepo));
      if (heardFromId === undefined) return;
      const outcome = await contactsRepo.touchLastHeardFrom(heardFromId, splitTsMsgId(persisted.tsMsgId).providerTs);
      if (outcome === 'failed') {
        log.error({ conversationId: persisted.conversationId }, 'last_heard_from touch failed - message persisted, last_heard_from stale');
      }
    } catch (err) {
      log.error(
        { err, conversationId: persisted.conversationId },
        'last_heard_from touch failed - message persisted, last_heard_from stale',
      );
    }
  };
```

- transcript fixture: `:851` `await messages.append({` becomes
  `const appended = await messages.append({`; right after the append's
  closing `});` (`:863`) add
  `await touchFixtureHeardFrom({ direction, type: 'call' }, appended);`.
- message fixture, append branch: after the append's closing `});` (`:1086`)
  add:

```ts
      await touchFixtureHeardFrom(
        {
          direction,
          type: 'sms',
          ...(reqBody.relaySenderKey !== undefined && { relay_sender_key: reqBody.relaySenderKey }),
        },
        appended,
      );
```

- message fixture, direct-Put branch: after
  `await doc.send(new PutCommand({ TableName: tableName('messages'), Item: item }));`
  (`:1115`) add `await touchFixtureHeardFrom(item, item);`.

Commit: `feat(dev): the inbound fixture seams move last heard from by the live rule`.

### Task 1.12 - the importer stamp (`app/src/lib/import/apply.ts`)

The importer writes history through raw `doc` calls and a `BatchWriter`; it
gets a `contactsRepo` from its own `doc` + `env`, stamps AFTER
`messageBatch.flush()` (`:486`), skips the writes on `dryRun`, and resolves
phones through the in-memory `contactIdByPhone` map (`:297`, filled at
`:333` before the dry-run gate) - the byPhone GSI lags a fresh upsert
(`twilio.ts:1972-1986`).

RED - `app/test/importApply.integration.test.ts`, a new case right after
`'writes contacts, threads, messages and calls'` (`:104`), using the
fixture's own rows (`test/importFixture.ts`):

```ts
  it('stamps last_heard_from_at from the latest attributed inbound it wrote (spec 5.1)', async () => {
    const dry = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv, dryRun: true });
    expect(dry.lastHeardFromStamps.written + dry.lastHeardFromStamps.skipped + dry.lastHeardFromStamps.failed).toBe(0);
    const report = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    expect(report.lastHeardFromStamps.planned).toBe(dry.lastHeardFromStamps.planned);
    expect(report.lastHeardFromStamps.failed).toBe(0);
    const heard = async (phone: string) =>
      (await doc.send(new GetCommand({ TableName: table('contacts'), Key: { contactId: contactIdForPhone(phone) } })))
        .Item?.['last_heard_from_at'];
    expect(await heard(PHONES.tenantBusy)).toBe('2026-07-03T10:00:00.000Z');     // the inbound CALL beats the 07-01 text
    expect(await heard(PHONES.tenantConflict)).toBe('2026-07-20T10:00:00.000Z'); // the 07-20 text beats the 07-19 missed call
    expect(await heard(PHONES.caseworker)).toBe('2026-07-23T10:00:00.000Z');
    expect(await heard(PHONES.optedOut)).toBe('2026-06-01T10:00:00.000Z');       // a STOP counts
    expect(await heard(PHONES.groupTenant)).toBe('2026-07-26T10:00:00.000Z');    // the GROUP inbound beats the 03-01 1:1
    expect(await heard(PHONES.landlord)).toBeUndefined();                        // only outbound and others' group texts
    expect(await heard(PHONES.noTraffic)).toBeUndefined();
    const again = await runApply({ doc, plan, review: cleanReview(), importedAt, env: testEnv });
    expect(again.lastHeardFromStamps.written).toBe(0);
    expect(again.lastHeardFromStamps.skipped).toBe(again.lastHeardFromStamps.planned);
  });
```

RED: `lastHeardFromStamps` is undefined (and tsc).

GREEN - `apply.ts`:

- imports: `:53` `import type { ContactType } from '../../repos/contactsRepo.js';`
  becomes `import { createContactsRepo, type ContactType } from '../../repos/contactsRepo.js';`;
  new line `import { attributeInbound, normalizeInstant, type HeardFromLookup, type HeardFromRow, type HeardFromThread } from '../heardFrom.js';`.
- `ApplyReport` (`:183-223`), after `calls: { written: number };`:

```ts
  /**
   * Last heard from (spec 5.1): one forward-only touchLastHeardFrom per
   * contact, from the latest attributed inbound row this run wrote.
   * `planned` is counted on a dry run too; the other three only on a write.
   */
  lastHeardFromStamps: { planned: number; written: number; skipped: number; failed: number };
```

- the `report` literal (`:277-291`): after `calls: { written: 0 },` add
  `lastHeardFromStamps: { planned: 0, written: 0, skipped: 0, failed: 0 },`.
- after `const messageBatch = new BatchWriter(doc, messagesTable, dryRun);`
  (`:359`):

```ts
  /** Last heard from (spec 5.1): contactId -> the latest attributed inbound
   *  instant (normalized) this run writes. Stamped after the flush below. */
  const heardFromLatest = new Map<string, string>();
  /** Phones resolve through what THIS run wrote - never the lagging byPhone GSI. */
  const heardFromLookup: HeardFromLookup = {
    byPhone: (e164) => {
      const contactId = contactIdByPhone.get(e164);
      return contactId === undefined ? undefined : { contactId };
    },
    byEmail: () => undefined,
  };
  const noteHeardFrom = async (row: HeardFromRow, thread: HeardFromThread, createdAt: string): Promise<void> => {
    const contactId = await attributeInbound(row, thread, heardFromLookup);
    const at = normalizeInstant(createdAt);
    if (contactId === undefined || at === undefined) return;
    const prior = heardFromLatest.get(contactId);
    if (prior === undefined || at > prior) heardFromLatest.set(contactId, at);
  };
```

- inside the thread loop, after `if (thread.isGroup) report.conversations.groups += 1;`
  (`:434`), the thread as THIS run writes it (`upsertConversation`'s type at
  `:1227`, participants at `:419-422`, participant_phone at `:1270-1275`):

```ts
    const heardThread: HeardFromThread = {
      type: thread.isGroup ? 'relay_group' : 'unknown_1to1',
      participants: roster.map((phone) => ({ contactId: contactIdByPhone.get(phone) ?? '', phone })),
      ...(!thread.isGroup && roster[0] !== undefined && { participant_phone: roster[0] }),
    };
```

- in the message loop, after `report.messages.written += 1;` (`:462`):

```ts
      await noteHeardFrom(
        {
          direction: m.direction === 'incoming' ? 'inbound' : 'outbound',
          type: 'sms',
          ...(senderKey !== undefined && { relay_sender_key: senderKey }),
        },
        heardThread,
        m.createdAt,
      );
```

- in the call loop, after `report.calls.written += 1;` (`:483`):

```ts
      await noteHeardFrom({ direction: c.direction === 'incoming' ? 'inbound' : 'outbound', type: 'call' }, heardThread, c.createdAt);
```

  (A group call carries no sender key and stays unattributed - the rule.)
- after `await messageBatch.flush();` (`:486`):

```ts
  // Last heard from (spec 5.1 / 14.2): one stamp per contact, AFTER the flush
  // (a stamp never names a row that is not stored), through the ONE writer
  // (it normalizes and never moves a value backward). A dry run only plans.
  report.lastHeardFromStamps.planned = heardFromLatest.size;
  if (!dryRun && heardFromLatest.size > 0) {
    const contactsRepo = createContactsRepo({ doc, env });
    for (const [contactId, at] of heardFromLatest) {
      const outcome = await contactsRepo.touchLastHeardFrom(contactId, at);
      report.lastHeardFromStamps[outcome] += 1;
    }
    if (report.lastHeardFromStamps.failed > 0) {
      warnings.push(
        `last_heard_from: ${report.lastHeardFromStamps.failed} contact stamp(s) failed - re-run the apply ` +
          '(idempotent) or the last-heard-from backfill.',
      );
    }
  }
```

- `app/scripts/import-apply.ts`, after the calls block (`:423-429`), before
  `units written`:

```ts
console.log(
  `  last heard from stamps  : ${report.lastHeardFromStamps.planned} planned, ` +
    `${report.lastHeardFromStamps.written} written, ${report.lastHeardFromStamps.skipped} already as late, ` +
    `${report.lastHeardFromStamps.failed} failed`,
);
```

Commit: `feat(import): the importer stamps last heard from through the one rule`.

### Task 1.13 - seed derivation (part A) and the I1 writer audit (part B) - TWO commits

#### Part A - `deriveSeedHeardFrom` (spec 5.1, 14.2, I4, D13)

RED:

1. New `app/test/seedHeardFrom.test.ts` (pure, the `seedRosterShape.test.ts:16-31`
   style; imports `SEED`, `castItems`, `matrixItems`, and
   `deriveSeedHeardFrom` from `../src/lib/seed/heardFrom.js`). A local
   `merged(profile)` mirrors `seedAll`'s merge (`seed/index.ts:116-132`):
   lean arrays copied, then for `'full'` `castItems()` and
   `matrixItems(new Date('2026-07-01T12:00:00.000Z'))` appended per table.
   `heardOf(rows, id) = rows.find((c) => c['contactId'] === id)?.['last_heard_from_at']`.
   - lean, the EXACT values: `contact-tenant-0001` = `'2026-06-01T14:02:10.000Z'`,
     `contact-landlord-0001` = `'2026-06-01T13:45:00.000Z'`,
     `contact-hastaff-0001` and `contact-tenant-0002` have NO attribute.
   - full (lean + cast + matrix), the EXACT values: the two lean values
     unchanged (lean beats cast CU/CX for the landlord);
     `contact-cast-unknown-texter` = `'2026-05-01T09:00:00.000Z'`;
     `contact-cast-mid-intake-tenant` = `'2026-05-02T10:20:00.000Z'`;
     `contact-cast-parked-norta-tenant` = `'2026-05-04T13:10:00.000Z'`;
     `contact-cast-searching-tenant` = `'2026-05-08T10:05:00.000Z'` (group A beats relay and 1:1);
     `contact-cast-toured-yes-tenant` = `'2026-05-09T11:00:00.000Z'`;
     `contact-cast-cold-call-landlord` = `'2026-05-09T11:00:00.000Z'` (group B);
     `contact-cast-never-signed-landlord` = `'2026-05-01T09:30:00.000Z'`;
     `contact-cast-parked-landlord` = `'2026-05-02T10:15:00.000Z'`;
     `contact-cast-mid-intake-unit-landlord` = `'2026-05-03T11:05:00.000Z'`;
     `contact-cast-pm-managed-property-owner`, `contact-cast-pm-managed-property-manager`,
     every `contact-mx-*` contact and `phoneref#+15550100105` have NO attribute.
   - COPIES: after deriving lean, `SEED['contacts']` item
     `contact-tenant-0001` still has no `last_heard_from_at`, and the returned
     item `!==` the SEED item; the returned array has the same length and
     contactId order as the input.
   - pointer rows tolerated: the full derivation does not throw on the
     `phone#` claim rows, the `sid#` pointer message row, or the `phoneref#`
     contact row.
   RED: the module does not exist.
2. `app/test/seedProfile.integration.test.ts`, a new case after `:116`
   (`'lean seedAll stamps the derived last_heard_from_at (spec I4)'`):
   `await seedAll(endpoint, 'lean', namespace)`, then
   `doc.send(new GetCommand({ TableName: tn('contacts', prefix), Key: { contactId: 'contact-tenant-0001' } }))`
   -> `last_heard_from_at` `'2026-06-01T14:02:10.000Z'`; `contact-hastaff-0001`
   -> no attribute (add `GetCommand` to the file's lib-dynamodb import). RED:
   the attribute is absent (the hook is not wired).

GREEN:

- new `app/src/lib/seed/heardFrom.ts`:

```ts
// Seed derivation of contacts.last_heard_from_at (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2; invariant I4; D13). Runs in seedAll over the MERGED
// rows of whichever profile is loading, through the SAME attributeInbound rule
// the live paths and the backfill use, so a seeded contact's value is exactly
// what the backfill would compute from its seeded rows.
//
// Returns COPIES of every contact item: the SEED and cast item objects are
// module literals other code reads (seedData.test.ts, broadcastApi.test.ts,
// seedPersonaDrift.test.ts, matrix.ts) - an in-place stamp would leak.
import { splitTsMsgId } from '../../repos/messagesRepo.js';
import {
  attributeInbound,
  normalizeInstant,
  type HeardFromLookup,
  type HeardFromRow,
  type HeardFromThread,
} from '../heardFrom.js';

type Row = Record<string, unknown>;

/** Key-only claim/pointer conversation rows (phone#, email#, token#). */
const POINTER_CONVERSATION_PREFIXES = ['phone#', 'email#', 'token#'] as const;
/** Phone/email pointer CONTACT rows - never a stamp target. */
const POINTER_CONTACT_PREFIXES = ['phoneref#', 'emailref#'] as const;

const isPointerContact = (id: string): boolean => POINTER_CONTACT_PREFIXES.some((p) => id.startsWith(p));

/** findByPhone/findByEmail over the seed's own items, pointer rows hopping to
 *  their owner like the real reads (first holder wins, like the GSI). */
function seedLookup(contacts: Row[]): HeardFromLookup {
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const claim = (map: Map<string, string>, key: unknown, owner: string): void => {
    if (typeof key === 'string' && key.length > 0 && !map.has(key)) map.set(key, owner);
  };
  for (const c of contacts) {
    const id = c['contactId'];
    if (typeof id !== 'string') continue;
    if (isPointerContact(id)) {
      const owner = c['phone_ref_owner'] ?? c['email_ref_owner'];
      if (typeof owner !== 'string') continue;
      claim(byPhone, c['phone'], owner);
      claim(byEmail, c['email'], owner);
      continue;
    }
    claim(byPhone, c['phone'], id);
    claim(byEmail, c['email'], id);
    for (const p of Array.isArray(c['phones']) ? (c['phones'] as Row[]) : []) claim(byPhone, p['phone'], id);
    for (const e of Array.isArray(c['emails']) ? (c['emails'] as Row[]) : []) claim(byEmail, e['email'], id);
  }
  const answer = (map: Map<string, string>, key: string) => {
    const contactId = map.get(key);
    return contactId === undefined ? undefined : { contactId };
  };
  return { byPhone: (e164) => answer(byPhone, e164), byEmail: (address) => answer(byEmail, address) };
}

export async function deriveSeedHeardFrom(messages: Row[], conversations: Row[], contacts: Row[]): Promise<Row[]> {
  const threads = new Map<string, HeardFromThread>();
  for (const c of conversations) {
    const id = c['conversationId'];
    if (typeof id !== 'string' || POINTER_CONVERSATION_PREFIXES.some((p) => id.startsWith(p))) continue;
    threads.set(id, c as unknown as HeardFromThread);
  }
  const lookup = seedLookup(contacts);
  const latest = new Map<string, string>();
  for (const m of messages) {
    // The sid# pointer row has no thread and no direction - skipped here.
    const thread = typeof m['conversationId'] === 'string' ? threads.get(m['conversationId']) : undefined;
    const tsMsgId = m['tsMsgId'];
    if (thread === undefined || typeof tsMsgId !== 'string') continue;
    const contactId = await attributeInbound(m as unknown as HeardFromRow, thread, lookup);
    // Seed rows carry `ts`, not provider_ts: the instant is the key's prefix.
    const at = normalizeInstant(splitTsMsgId(tsMsgId).providerTs);
    if (contactId === undefined || at === undefined) continue;
    const prior = latest.get(contactId);
    if (prior === undefined || at > prior) latest.set(contactId, at);
  }
  return contacts.map((c) => {
    const id = c['contactId'];
    const at = typeof id === 'string' && !isPointerContact(id) ? latest.get(id) : undefined;
    return at === undefined ? { ...c } : { ...c, last_heard_from_at: at };
  });
}
```

- `app/src/lib/seed/index.ts`: import after `:23`
  `import { deriveSeedHeardFrom } from './heardFrom.js';`; insert between the
  full-profile block's closing `}` (`:144`) and `const doc = createDocumentClient({ endpoint });`
  (`:146`):

```ts
  // Last heard from (spec 5.1 / 14.2; invariant I4): derived from the MERGED
  // rows of whichever profile is loading - after the cast/matrix merge (matrix
  // adds no messages), before the Put loop - through the live paths' one rule.
  // Returns COPIES: the SEED and cast items are shared module literals.
  tables['contacts'] = await deriveSeedHeardFrom(
    tables['messages'] ?? [],
    tables['conversations'] ?? [],
    tables['contacts'] ?? [],
  );
```

  (Only these two edits in a shared seed file - the parallel branch edits
  `seed/*` too. The performance world never runs through `seedAll` (D13).
  The lean world's contact items change on purpose; lean MESSAGE rows do not.)

Commit: `feat(seed): seeded contacts carry the derived last heard from`.

#### Part B - invariant I1 (nothing but the writer moves the value)

RED - `app/test/contactsCrud.test.ts`, the `'server-owned contact fields'`
describe (`:550`): add `['last_heard_from_at', '2030-01-01T00:00:00.000Z'],`
as the last entry of `OWNED` (`:551-555`). The loop then emits two cases:
POST refuses it with 400 `{ error: 'last_heard_from_at is set by the server, not the client' }`
and creates nothing; PATCH refuses it with that 400 and writes nothing. RED
today: POST answers 201 and PATCH 200 (the parsers silently drop an unknown
key - neither accepts it, but neither says so).

GREEN - `app/src/routes/contacts.ts:298`: add `'last_heard_from_at'` as the
LAST element of `SERVER_OWNED_CONTACT_FIELDS` (both parsers call
`refuseServerOwnedFields`, `:535`, `:813`). Extend the comment above it
(`:290-297`) with one sentence: `` `last_heard_from_at` is written only by
contactsRepo.touchLastHeardFrom (spec 5.1, invariant I1). ``

Audit (same commit) - write
`docs/superpowers/reviews/2026-10-12-last-heard-from/I1-last-heard-from-writers.md`
(findings by `file:line`, no code quotation), from these commands run in the
worktree:

1. `git grep -n "last_heard_from_at" -- app/src app/scripts` - every hit must
   be one of: the `ContactItem` field and `touchLastHeardFrom` in
   `app/src/repos/contactsRepo.ts`; `app/src/lib/seed/heardFrom.ts`; the
   `SERVER_OWNED_CONTACT_FIELDS` entry in `app/src/routes/contacts.ts`; or a
   READ (a projection or a field read added elsewhere on this branch, e.g.
   `RECIPIENT_PROJECTION`). List each hit as writer / refusal / read. Run
   this audit again at the final gate step and update the file if new reads
   appeared.
2. For each contacts-table writer file, list every `UpdateExpression`,
   `PutCommand`/`Put:` and `DeleteCommand` site and state that none SETs or
   REMOVEs `last_heard_from_at` and none full-item-Puts an EXISTING contact:
   - `app/src/repos/contactsRepo.ts` (`grep -n "new UpdateCommand\|new PutCommand\|new DeleteCommand" app/src/repos/contactsRepo.ts`;
     note `update()` at `:1458` writes only the keys its caller passes - so
     also run `git grep -n "\.update(" -- app/src` and confirm no caller passes
     the attribute; `create`/`createIfAbsent` Put only fresh ids);
   - `app/src/repos/suggestionResolutionRepo.ts:872-1069`;
   - `app/src/repos/extractionRepo.ts:792` (a ConditionCheck, no write);
   - `app/src/lib/import/apply.ts:684-693`, `:768-775` (the retract delete),
     `:798-804`, `:1181-1191` (SET-only upsert - a re-import cannot clear the
     value) and the new stamp (through `touchLastHeardFrom` only);
   - `app/scripts/backfillConsentMethod.ts:127-130`,
     `app/scripts/backfill-join-housing-authority.ts` (`contactsRepo.update`
     with named fields), `app/scripts/clean-org-names.ts`
     (`rewriteOrgFields`), and the new `app/scripts/backfill-last-heard-from.ts`
     (through `touchLastHeardFrom` only).
3. The PATCH/POST refusal above, with the test names.

Commit: `test(app): last_heard_from_at is server-owned - refused from clients, writer audit recorded`.

### Task 1.14 - the dashboard `Contact` type

RED - `dashboard/src/api/types.test.ts`: import `expectTypeOf` from `vitest`
and `type Contact` from `./types.js`; new case
`it('Contact carries last_heard_from_at as an optional ISO string', () => { expectTypeOf<Contact['last_heard_from_at']>().toEqualTypeOf<string | undefined>(); })`.
RED: `cd "W:/tmp/last-heard-from/dashboard"; npm run typecheck` fails (the
index signature types it `unknown`).

GREEN - `dashboard/src/api/types.ts`, `interface Contact`, after
`porting_source?: FieldSource;` (`:2277`), before the index signature:

```ts
  /** ISO 8601 - the most recent inbound text, call or email FROM this contact
   *  (any thread). Absent = never heard from. Read-only: the server owns it. */
  last_heard_from_at?: string;
```

Commit: `feat(dashboard): the Contact type carries last_heard_from_at`.

---

## S2 - the backfill (spec 5.2, 14.2)

### Task 2.1 - `app/scripts/backfill-last-heard-from.ts` (planner, runner, CLI)

RED - new `app/test/backfillLastHeardFrom.test.ts`, two halves (the
`backfillUnreadFlag.test.ts:1-29` shape; no database):

Half 1 - the planner. A synchronous fixture lookup
(`PHONES = new Map([['+15550100007', 'c-z'], ['+15550100005', 'c-p']])`,
`EMAILS = new Map([['e@x.test', 'c-e']])`), `plan = newPlan()`, rows built
by `const row = (tsMsgId, over = {}) => ({ conversationId: 'x', tsMsgId, direction: 'inbound', type: 'sms', ...over }) as MessageItem`:

1. 1:1 stops at its first ATTRIBUTED inbound: thread
   `{ conversationId: 'one', type: 'tenant_1to1', participants: [{ contactId: 'c-a', phone: '+15550100001' }] }`,
   page `[row('2026-09-02T10:00:00.000Z#SM2'), row('2026-09-01T10:00:00.000Z#SM1')]`
   -> `planThreadPage` resolves `true`; `plan.latest.get('c-a')` is the 09-02 instant.
2. retry and outbound rows are ignored, not counted: a relay thread page
   `[row('2026-09-05T...#R', { relay_sender_key: 'c-a', relay_retry_of: '2026-09-01T10:00:00.000Z#SM1' }), row('2026-09-04T...#O', { direction: 'outbound', relay_sender_key: 'team' })]`
   -> `latest` empty, `unattributed` 0.
3. unverified email is stepped over, not stopped on: 1:1 page
   `[row('2026-09-03T10:00:00.000Z#E1', { type: 'email', email_new_address: true }), row('2026-09-02T10:00:00.000Z#E2', { type: 'email' })]`
   -> `true`; `unattributed` 1, `unattributedSample` `['one']`; `c-a` = 09-02.
4. empty participant contactId + email: thread
   `{ conversationId: 'em', type: 'partner_1to1', participants: [{ contactId: '', phone: '' }], participant_email: 'e@x.test' }`
   -> `c-e`.
5. no participants, phone then email fall-through: thread with
   `participant_phone: '+15550100999'`, `participant_email: 'e@x.test'` -> `c-e`;
   with `participant_phone: '+15550100005'` -> `c-p`.
6. group walked to EXHAUSTION (resolves `false`) with every branch on one
   relay thread (roster `[{ contactId: 'c-a', phone: '+15550100001' }, { contactId: '', phone: '+15550100005' }]`):
   key `'c-a'` (newest), key `'phone#+15550100005'` -> `c-p` (empty roster id),
   key `'phone#+15550100007'` (a non-member) -> `c-z`, keyless with
   `relay_external_caller_contact_id: 'c-ext'` -> `c-ext`, keyless with only
   `relay_external_caller_phone: '+15550100007'` -> `c-z`, keyless with
   nothing (an imported group call) -> unattributed, key `'team'` inbound ->
   unattributed. All six contacts planned; `unattributed` 2.
7. group_text with a phone key whose roster entry has a contactId -> that id.
8. cross-thread max: `c-a` at 09-01 on a 1:1 and 09-03 on a group (either
   order) -> 09-03.
9. ISO normalization: thread A row `'2026-09-01T10:00:00Z#a'`, thread B row
   `'2026-09-01T10:00:00.500Z#b'`, both `c-a` -> `latest.get('c-a')` is
   `'2026-09-01T10:00:00.500Z'` (raw strings would compare the other way).
10. unparseable prefix `'garbage#SM'` -> `unparseableInstants` 1, nothing planned.

Half 2 - the runner through a fake `doc` and a fake contacts repo:

```ts
function fakeDoc(conversations: Record<string, unknown>[], messages: Record<string, unknown>[], pageSize = 1000) {
  const queries: Record<string, unknown>[] = [];
  const doc = {
    async send(command: unknown) {
      if (command instanceof ScanCommand) return { Items: conversations };
      if (command instanceof QueryCommand) {
        const input = command.input as Record<string, any>;
        queries.push(input);
        const rows = messages
          .filter((m) => m['conversationId'] === input.ExpressionAttributeValues[':c'])
          .filter((m) => m['direction'] === 'inbound' && m['relay_retry_of'] === undefined)
          .sort((a, b) => (String(a['tsMsgId']) < String(b['tsMsgId']) ? 1 : -1));
        const start = input.ExclusiveStartKey === undefined ? 0 : Number(input.ExclusiveStartKey.idx);
        const next = start + pageSize < rows.length ? { idx: start + pageSize } : undefined;
        return { Items: rows.slice(start, start + pageSize), ...(next && { LastEvaluatedKey: next }) };
      }
      throw new Error('unexpected command');
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, queries };
}
```

The contacts fake keeps `stored: Map<string, string>`; `touchLastHeardFrom`
records `{ contactId, at }` and answers `'written'` (storing) when absent or
earlier, else `'skipped'`; a `failFor` id answers `'failed'`; its
`findByPhone` maps `'+15550100004'` to `'c-d'`. World: one
`{ conversationId: 'phone#+15550100001', ref_conversationId: 'one' }` claim
row; a 1:1 `{ conversationId: 'one', type: 'tenant_1to1', participants: [{ contactId: 'c-a', phone: '+15550100001' }] }`
with two inbound rows (09-01, 09-02); a relay thread
`{ conversationId: 'grp', type: 'relay_group', participants: [{ contactId: 'c-b', phone: '+15550100002' }, { contactId: 'c-c', phone: '+15550100003' }, { contactId: '', phone: '+15550100004' }] }`
with inbound rows keyed `'c-b'` (09-03), `'c-c'` (09-04),
`'phone#+15550100004'` (09-05), an outbound `'team'` row and a retry row
(both filtered); so the planned contacts are `c-a`, `c-b`, `c-c`, `c-d`.
All cases call `backfillLastHeardFrom({ doc, env: { TABLE_PREFIX: 'hc-test-' }, contacts, logger, ... })`
with `logger = createLogger({ destination: capture.stream })`:

1. dry run (no `apply`): no touches; `planned` 4;
   `written`/`skipped`/`failed` 0; `pointerRows` 1; `conversationsWalked` 2;
   the Query input carries `FilterExpression: '#dir = :inbound AND attribute_not_exists(#retryOf)'`,
   `ScanIndexForward: false`.
2. apply: one touch per contact with its MAX instant, `written` = `planned`;
   a second apply on the same fake: `written` 0, `skipped` = `planned`
   (idempotent).
3. paging: with `pageSize = 1`, the 1:1 thread is queried ONCE (stopped at
   its first attributed row) and the relay thread three times (its three
   filtered rows, until `LastEvaluatedKey` is gone) - four Queries in all;
   `c-a` is still 09-02 (the newest).
4. abort: `failFor = 'c-a'` (touched first - the runner touches in contactId
   order) -> the promise REJECTS; no touch after `c-a`; `capture.atLevel(50)`
   holds a line whose `msg` contains `PARTIAL result` and carries
   `failed: 1`.
5. `reportBackfillRun(result, false, logger)` returns 0 and logs a level-30
   line whose `msg` is `backfill-last-heard-from - done (DRY RUN - nothing written)`;
   with `apply = true` the `msg` is `backfill-last-heard-from - done`.

RED: the module does not exist.

GREEN - new `app/scripts/backfill-last-heard-from.ts`:

```ts
// backfill-last-heard-from - the ONE-TIME backfill of contacts.last_heard_from_at
// from message history (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1, 5.2 and 14.2).
//
// WHAT: Scans every conversation (phone#/email#/token# claim rows skipped),
// Queries each one's INBOUND, non-retry rows newest-first (no GSI exists on
// messages), attributes each row with lib/heardFrom.ts attributeInbound - the
// ONE rule every live path uses - keeps the latest instant per contact ACROSS
// threads, then makes ONE contactsRepo.touchLastHeardFrom per contact.
// The writer is conditional and forward-only: a value a live inbound wrote
// after the scan is never moved back, and a second run writes nothing.
//
// A 1:1 thread stops at its first ATTRIBUTED inbound (an unattributed row - an
// email from an unverified address - is counted and stepped over). A GROUP
// thread (relay_group, group_text) is read to EXHAUSTION: non-members, staff
// texting from another org number, removed members and refused callers all
// sit below any roster-complete point.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts. DRY RUN IS
// THE DEFAULT; --apply writes. An agent runs this ONLY with --env local
// --lane <L> against a hermetic e2e lane it started (a bare --env local is the
// human's live stack). NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the
// human does, dry run first, per the RUNBOOK.
//
//   npx tsx app/scripts/backfill-last-heard-from.ts --env dev
//   npx tsx app/scripts/backfill-last-heard-from.ts --env dev --apply
//
// ABORT: a touch answering 'failed' (any error but a lost condition) stops the
// run with a PARTIAL report and exit 1. Re-running after the fix is safe.
//
// PII: logs counts, contactIds and conversationIds only - never a name,
// phone, address or body.
import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import {
  attributeInbound,
  normalizeInstant,
  type HeardFromLookup,
  type HeardFromThread,
} from '../src/lib/heardFrom.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { POINTER_PARTITION_PREFIXES } from '../src/lib/unreadFeed.js';
import { createContactsRepo, type ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { splitTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { parseStageArgs, resolveStageClient, type StageClient } from './lib/stageClient.js';

export const SCRIPT_NAME = 'backfill-last-heard-from';
/** At most this many distinct conversationIds are kept as the unattributed sample. */
export const UNATTRIBUTED_SAMPLE_MAX = 10;

const GROUP_THREAD_TYPES: ReadonlySet<string> = new Set(['relay_group', 'group_text']);

export interface HeardFromPlan {
  conversationsWalked: number;
  pointerRows: number;
  messagesRead: number;
  /** Inbound, non-retry rows the rule could not attribute. */
  unattributed: number;
  unattributedSample: string[];
  unparseableInstants: number;
  /** contactId -> the latest normalized instant, across every thread. */
  latest: Map<string, string>;
}

export function newPlan(): HeardFromPlan {
  return {
    conversationsWalked: 0,
    pointerRows: 0,
    messagesRead: 0,
    unattributed: 0,
    unattributedSample: [],
    unparseableInstants: 0,
    latest: new Map(),
  };
}

export function isPointerConversation(conversationId: unknown): boolean {
  return typeof conversationId === 'string' && POINTER_PARTITION_PREFIXES.some((p) => conversationId.startsWith(p));
}

/**
 * Plan ONE newest-first page of a thread's rows into `plan`. Rows that are not
 * inbound, or carry relay_retry_of, are ignored outright (the Query filters
 * them too; the planner re-checks so it is right on any input). Resolves true
 * when the thread is FINISHED: a 1:1 thread that attributed a row.
 */
export async function planThreadPage(
  plan: HeardFromPlan,
  thread: HeardFromThread & { conversationId: string },
  rows: readonly MessageItem[],
  lookup: HeardFromLookup,
): Promise<boolean> {
  const isGroup = GROUP_THREAD_TYPES.has(thread.type);
  plan.messagesRead += rows.length;
  for (const row of rows) {
    if (row.direction !== 'inbound') continue;
    if (typeof row.relay_retry_of === 'string' && row.relay_retry_of.length > 0) continue;
    const contactId = await attributeInbound(row, thread, lookup);
    if (contactId === undefined) {
      plan.unattributed += 1;
      if (
        plan.unattributedSample.length < UNATTRIBUTED_SAMPLE_MAX &&
        !plan.unattributedSample.includes(thread.conversationId)
      ) {
        plan.unattributedSample.push(thread.conversationId);
      }
      continue;
    }
    const at = normalizeInstant(splitTsMsgId(row.tsMsgId).providerTs);
    if (at === undefined) {
      plan.unparseableInstants += 1;
      continue;
    }
    const prior = plan.latest.get(contactId);
    if (prior === undefined || at > prior) plan.latest.set(contactId, at);
    if (!isGroup) return true;
  }
  return false;
}

export interface BackfillResult {
  conversationsWalked: number;
  pointerRows: number;
  messagesRead: number;
  unattributed: number;
  unattributedSample: string[];
  unparseableInstants: number;
  /** Contacts with a planned instant (dry run: would touch). */
  planned: number;
  written: number;
  /** No contact row, or a value already as late (a live write won). */
  skipped: number;
  failed: number;
}

export interface BackfillOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** Write. Absent/false = dry run (the default). */
  apply?: boolean;
  /** Injectable for tests; defaults to createContactsRepo({ doc, env, logger }). */
  contacts?: Pick<ContactsRepo, 'findByPhone' | 'findByEmail' | 'touchLastHeardFrom'>;
  scanLimit?: number;
  queryLimit?: number;
  logger?: Logger;
}

function syncCounts(plan: HeardFromPlan, result: BackfillResult): void {
  result.conversationsWalked = plan.conversationsWalked;
  result.pointerRows = plan.pointerRows;
  result.messagesRead = plan.messagesRead;
  result.unattributed = plan.unattributed;
  result.unattributedSample = [...plan.unattributedSample];
  result.unparseableInstants = plan.unparseableInstants;
  result.planned = plan.latest.size;
}

export async function backfillLastHeardFrom(opts: BackfillOpts): Promise<BackfillResult> {
  const log = opts.logger ?? defaultLogger;
  const plan = newPlan();
  const result: BackfillResult = {
    conversationsWalked: 0,
    pointerRows: 0,
    messagesRead: 0,
    unattributed: 0,
    unattributedSample: [],
    unparseableInstants: 0,
    planned: 0,
    written: 0,
    skipped: 0,
    failed: 0,
  };
  try {
    await run(opts, plan, result, log);
  } catch (err) {
    syncCounts(plan, result);
    log.error(
      { ...result, apply: opts.apply === true },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and forward-only, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function run(opts: BackfillOpts, plan: HeardFromPlan, result: BackfillResult, log: Logger): Promise<void> {
  const contacts = opts.contacts ?? createContactsRepo({ doc: opts.doc, env: opts.env, logger: log });
  // One byPhone/byEmail Query per distinct key, however many rows name it.
  const memo = new Map<string, Promise<{ contactId: string } | undefined>>();
  const memoized = (key: string, read: () => Promise<{ contactId: string } | undefined>) => {
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = read().then((c) => (c === undefined ? undefined : { contactId: c.contactId }));
      memo.set(key, hit);
    }
    return hit;
  };
  const lookup: HeardFromLookup = {
    byPhone: (e164) => memoized(`phone:${e164}`, () => contacts.findByPhone(e164)),
    byEmail: (address) => memoized(`email:${address}`, () => contacts.findByEmail(address)),
  };
  const messagesTable = tableName('messages', opts.env);

  const walkThread = async (thread: ConversationItem): Promise<void> => {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await opts.doc.send(
        new QueryCommand({
          TableName: messagesTable,
          KeyConditionExpression: 'conversationId = :c',
          FilterExpression: '#dir = :inbound AND attribute_not_exists(#retryOf)',
          ExpressionAttributeNames: { '#dir': 'direction', '#retryOf': 'relay_retry_of' },
          ExpressionAttributeValues: { ':c': thread.conversationId, ':inbound': 'inbound' },
          ScanIndexForward: false,
          ...(opts.queryLimit !== undefined && { Limit: opts.queryLimit }),
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }),
      );
      if (await planThreadPage(plan, thread, (page.Items ?? []) as MessageItem[], lookup)) return;
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey !== undefined);
  };

  let scanKey: Record<string, unknown> | undefined;
  do {
    const page = await opts.doc.send(
      new ScanCommand({
        TableName: tableName('conversations', opts.env),
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(scanKey !== undefined && { ExclusiveStartKey: scanKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      if (isPointerConversation(raw.conversationId)) {
        plan.pointerRows += 1;
        continue;
      }
      plan.conversationsWalked += 1;
      await walkThread(raw);
    }
    scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (scanKey !== undefined);

  syncCounts(plan, result);
  log.info({ ...result, apply: opts.apply === true }, `${SCRIPT_NAME} - planned`);
  if (opts.apply !== true) return;

  // contactId order: deterministic logs and a deterministic abort point.
  for (const [contactId, at] of [...plan.latest].sort(([a], [b]) => a.localeCompare(b))) {
    const outcome = await contacts.touchLastHeardFrom(contactId, at);
    if (outcome === 'written') result.written += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else {
      result.failed += 1;
      log.error({ contactId }, `${SCRIPT_NAME} - touch FAILED (not a lost condition) - aborting`);
      throw new Error(`${SCRIPT_NAME}: touchLastHeardFrom failed for ${contactId}`);
    }
  }
}

/** The end-of-run report (exit 0: a failed touch has already aborted). */
export function reportBackfillRun(result: BackfillResult, apply: boolean, log: Logger = defaultLogger): 0 {
  log.info({ ...result, apply }, `${SCRIPT_NAME} - done${apply ? '' : ' (DRY RUN - nothing written)'}`);
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backfill-last-heard-from.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), { values: [], flags: ['--apply'] });
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply]\n` +
        '  DRY RUN by default; --apply writes. Unknown or repeated arguments are refused. --lane selects a hermetic e2e lane\n' +
        '  (local only). An agent uses --env local --lane <L> ONLY.',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here happens BEFORE any
    // table is read, so it must never point the operator at a PARTIAL report.
    let stage: StageClient;
    try {
      stage = await resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {});
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
      process.exitCode = 1;
      return;
    }
    // STEP 2 - the run.
    try {
      defaultLogger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply },
        `${SCRIPT_NAME} - starting`,
      );
      const result = await backfillLastHeardFrom({ doc: stage.doc, env: stage.env, apply });
      process.exitCode = reportBackfillRun(result, apply);
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
```

(`app/tsconfig.scripts.json` includes `scripts`, so `npm run typecheck`
checks it. No npm script - matching every other backfill here.)

Rehearsal (part of this task, after GREEN, ONLY on a hermetic lane the
builder started with `npm run e2e:session`): reseed the lane LEAN, then
`npx tsx app/scripts/backfill-last-heard-from.ts --env local --lane <L>` (dry
run) - `planned` 2 (`contact-tenant-0001`, `contact-landlord-0001`); then
`--apply` - `written` 0, `skipped` 2 (the seed already derived the same
values: invariant I4 holds end to end). Record both report lines (counts and
ids only) in `docs/superpowers/reviews/2026-10-12-last-heard-from/backfill-rehearsal.md`
and commit it with this task. Never a bare `--env local`.

Commit: `feat(scripts): backfill-last-heard-from - dry run by default, one forward-only touch per contact`.

### Task 2.2 - the RUNBOOK section

`RUNBOOK.md`: insert a new section after the `/join leads` section's last
paragraph (`:498`), before `### Caseworkers (...)` (`:500`), ASCII only:

```markdown
### Last heard from: the backfill (`feat/last-heard-from`) - owed on dev AND prod after this branch deploys

**Owed on dev AND prod once this branch has deployed there; take dev all the way through before prod.** No Terraform, no secrets, no env var, no schema or index change (`last_heard_from_at` is a plain contact attribute, never an index key). Spec: `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`, sections 5.1, 5.2 and 14.2.

What `app/scripts/backfill-last-heard-from.ts` does: from the deploy on, every inbound text, call and email moves its contact's "Last heard from" as it arrives. Contacts who last reached out BEFORE the deploy read "Never" until this backfill runs. The script walks every conversation's inbound history, attributes each row with the same rule the live paths use, keeps the latest instant per contact across all threads, and makes one conditional, forward-only write per contact. It never moves a value backward, so a contact who texted after the deploy keeps that newer value.

Per environment, in this order:

1. **Deploy FIRST** (`npm run deploy:dev`, then the promote for prod). The live touches start at the deploy; running the backfill before it leaves a gap (anyone who reaches out between the backfill and the deploy keeps their old value until they reach out again). After the deploy nothing can be missed: history is backfilled and new traffic is touched live.
2. **Dry run (the DEFAULT; writes nothing):** `npx tsx app/scripts/backfill-last-heard-from.ts --env dev`. Read the start line (`target`, `prefix`) and confirm it names the environment you mean.
3. **Read the counts** on the `backfill-last-heard-from - done (DRY RUN - nothing written)` line:
   - `conversationsWalked` - conversations read (`pointerRows` are claim rows, skipped);
   - `messagesRead` - inbound, non-retry rows read (one-to-one threads stop at their newest attributed inbound; group threads are read to the end);
   - `planned` - contacts that will get a value;
   - `unattributed` - inbound rows no contact can be named for: an email from an address not on any contact, an imported group call, a phone with no contact. `unattributedSample` lists up to 10 conversationIds to look at; a handful is normal;
   - `unparseableInstants` - rows whose stored key carries no readable time (expected 0).
4. **Apply:** `npx tsx app/scripts/backfill-last-heard-from.ts --env dev --apply`. `written` = values set; `skipped` = no contact row (a removed contact) or a value already as late (a live inbound since the deploy); `failed` = any other write error, which STOPS the run with a `PARTIAL result` line (the counters as of the stop) and exit 1 - fix the cause (usually throttling or credentials) and re-run.
5. **Verify in THAT environment's dashboard:** open a tenant you know texted before the deploy - the contact header shows "Last heard from <date>", and Contacts > Tenants sorted by "Last heard from" puts recent repliers first.
6. **Idempotent:** a second `--apply` reports `written: 0` and `skipped` equal to `planned`. Safe to re-run at any time.

Cost: one Scan of the conversations table, one filtered Query per conversation (plus pages for long group threads), one byPhone or byEmail Query per distinct number or address the rule needs, and on an apply one conditional UpdateItem per planned contact - seconds to a minute at today's volume. Exit codes: 0 the run completed (dry run or apply); 1 a write failed (PARTIAL report) or the target could not be resolved (nothing read); 2 usage.

**No agent runs it against dev or prod; an agent rehearses on a lane: `--env local --lane <L>`.** Never a bare `--env local` - that is the live local stack.
```

RED/GREEN does not apply (docs). Check: `tr -d '\11\12\15\40-\176'` over the added lines of `git diff RUNBOOK.md` prints nothing.

Commit: `docs(runbook): the last-heard-from backfill - deploy first, dry run, apply, dev then prod`.

---

<!-- W2 notes -->
## CONTRACT CHANGE REQUESTED

1. `SendRosterRow` prop `onRequestTour?: () => void` -> REPLACE with
   `requestTourTo?: string` (the URL, `/listings/<unitId>?tour=new`), rendered
   as a react-router `<Link>`.
   Reason: the copy table calls it a LINK ("partner link `Request a tour`")
   and gives it a link's accessible name (`Request a tour for <name> at
   <address>`). A callback forces either a `<button>` (wrong role - every
   e2e/test selector would be `getByRole('button')` for a "link") or an
   href-less anchor (not keyboard/middle-click navigable). A `to` gives native
   link semantics, and the same-page case on the property card needs no extra
   code: ListingDetail reads `?tour=new` from the URL on every render (task
   5.3), so a Link to its own path with the query opens the form.
   Replacement line for plan head section 3.3:
   `requestTourTo?: string;  // partner rows: a Link to /listings/:unitId?tour=new`

2. `clear` writes `listing_decline_cleared` ONLY when the row carried a
   `declined` before the call (spec 5.4 says "then the audit writes"
   unconditionally). Reason: a clear of a row that was never declined (a retry
   after a 503 `saved`, a double click) would otherwise pin "Not interested
   cleared" on a timeline where nothing was declined - the same honesty rule
   the spec applies to `listing_interested` ("a click that found an existing
   tour writes no event"). The route still answers 200 and stays idempotent.
   Replacement bullet for plan head section 1 `events` row: append "a `clear`
   that found no stored decline writes no event".

3. Clarification, not a change (recorded so the orchestrator does not read a
   conflict into it): the outcome route decides `400 interested_unsupported`
   from the recipient display read it already needs for the re-projection
   (eventually consistent, the same data the card rendered), and then runs
   `requireTenantContact` (CONSISTENT) as the I2 guard; `409
   contact_not_tenant` therefore fires only when the type changed between the
   two reads (a just-converted caseworker), `404 tenant_not_found` when the row
   is gone. Both are tested (task 3.7).

REVISION 2 (plan review round 1, adjudications "Plan review / Round 1"):
items 1-3 above were ACCEPTED as plan head 3.4 #1-#3. Four review findings
are folded into the tasks below: (a) `setListingSendOutcome` returns
`{ row: ListingSendRow }` everywhere (head 3.4 #4) - tasks 3.8, 5.3, 5.4;
(b) markup R1 - `SendRosterRow`'s root is an `<li>` and every host wraps its
rows in `SendRosterList` (`<ul>`) - tasks 5.1, 5.3, 5.4; (c) markup R4 - the
property page opens the Schedule tour form ONLY from the URL
(`?tour=new[&tenantId=]`); a form-mode Interested click and "+ Tour" both
NAVIGATE there with `setSearchParams`, and Cancel / create clear both params -
task 5.3; (d) B8 - `Request a tour` renders only for a PARTNER recipient (the
host passes `requestTourTo` only then; never a landlord row) - tasks 5.1, 5.3,
5.4.

ADDITIONS (new exported names beyond the head contracts; no existing contract
changes): `wireDecline` and `ListingSendRowOptions` (app); `projectRecipientRow`
and `groupToursByTenant` stay module-private in `routes/units.ts`;
`interestedModeOf`, `SendRosterRowProps`, `SendRowAction`, `SendRosterList` in
`dashboard/src/routes/contact/Card.tsx`; `groupSendRows` and `SendRowGroup` in
`dashboard/src/routes/listing/listingFormat.ts`;
`dashboard/src/lib/listingOutcomeErrors.ts` (`isOutcomeSaved`,
`outcomeErrorCopy`, two copy constants); `useListing().setRecipientRow(unitId,
contactId, row)` and `useContactFile().setListingSentRow(contactId, unitId,
row)` (the head names them; their argument lists are fixed here).

---

## S3 - outcome core (app; dashboard wire mirror in 3.8)

Ends green on `npm run typecheck` + the app suite. Between S3 and S5 the API
serves the new fields and the cards ignore them (plan head section 2).

### Task 3.1 - `app/src/lib/listingSendOutcome.ts` (the pure rules)

RED - new `app/test/listingSendOutcome.test.ts` (pure, the
`app/test/listingSendTour.test.ts:13-42` style; RED today: the module does not
exist, every import fails):

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveListingSendOutcome,
  effectiveDecline,
  FOLLOW_UP_LOOKBACK_MS,
  FOLLOW_UP_QUIET_MS,
  interestedModeFor,
  isEligibleRecipient,
  isWaiting,
  waitingSince,
  wireDecline,
  type DeclineRecord,
} from '../src/lib/listingSendOutcome.js';

const SENT = '2026-10-01T12:00:00.000Z';
const BEFORE = '2026-09-30T12:00:00.000Z';
const AFTER = '2026-10-02T12:00:00.000Z';
const LATER = '2026-10-03T12:00:00.000Z';
const staff = (at: string): DeclineRecord => ({ at, by: 'staff', staffId: 'usr_x' });
const TOUR = { tourId: 't-1', state: 'requested' as const };

describe('constants', () => {
  it('quiet is 24 hours and lookback 14 days, in ms', () => {
    expect(FOLLOW_UP_QUIET_MS).toBe(86_400_000);
    expect(FOLLOW_UP_LOOKBACK_MS).toBe(14 * 86_400_000);
  });
});

describe('effectiveDecline (D11)', () => {
  it('no record -> false', () => {
    expect(effectiveDecline({ sentAt: SENT }, undefined)).toBe(false);
  });
  it('a decline at or after the send, no tour activity -> true (equal counts)', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, undefined)).toBe(true);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(SENT) }, undefined)).toBe(true);
  });
  it('a LATER counted share supersedes it (sentAt after declined.at) -> false', () => {
    expect(effectiveDecline({ sentAt: AFTER, declined: staff(SENT) }, undefined)).toBe(false);
  });
  it('no sentAt (never projected, but total) -> the send clause passes', () => {
    expect(effectiveDecline({ declined: staff(SENT) }, undefined)).toBe(true);
  });
  it('LATER tour activity supersedes it; equal activity does not', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, LATER)).toBe(false);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, AFTER)).toBe(true);
    expect(effectiveDecline({ sentAt: SENT, declined: staff(AFTER) }, BEFORE)).toBe(true);
  });
  it('compares instants, not strings (a stored value without millis)', () => {
    expect(effectiveDecline({ sentAt: '2026-10-01T12:00:00Z', declined: staff('2026-10-01T12:00:00.000Z') }, undefined)).toBe(true);
    expect(effectiveDecline({ sentAt: '2026-10-01T12:00:00.500Z', declined: staff('2026-10-01T12:00:00Z') }, undefined)).toBe(false);
  });
  it('an unparseable declined.at never counts', () => {
    expect(effectiveDecline({ sentAt: SENT, declined: staff('not-a-date') }, undefined)).toBe(false);
  });
});

describe('deriveListingSendOutcome - precedence not_interested > interested > replied > no_reply', () => {
  const row = { sentAt: SENT };
  it('nothing heard, no tour -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: undefined, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard EXACTLY at the send -> no_reply (strictly after)', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: SENT, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard before the send -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: BEFORE, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('heard after the send -> replied', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: undefined, tourActivityAt: undefined })).toBe('replied');
  });
  it('a tenant with a qualifying tour -> interested, even after a reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: SENT })).toBe('interested');
  });
  it('an effective decline beats the tour and the reply -> not_interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(LATER) }, recipientType: 'tenant', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: AFTER })).toBe('not_interested');
  });
  it('tour activity after the decline supersedes it -> interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(AFTER) }, recipientType: 'tenant', lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: LATER })).toBe('interested');
  });
  it('a later share supersedes the decline -> falls through to replied / no_reply', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: AFTER, declined: staff(SENT) }, recipientType: 'tenant', lastHeardFromAt: LATER, tour: undefined, tourActivityAt: undefined })).toBe('replied');
    expect(deriveListingSendOutcome({ row: { sentAt: AFTER, declined: staff(SENT) }, recipientType: 'tenant', lastHeardFromAt: undefined, tour: undefined, tourActivityAt: undefined })).toBe('no_reply');
  });
  it('a PARTNER never reads a tour: the signal is ignored -> replied', () => {
    expect(deriveListingSendOutcome({ row, recipientType: 'partner', lastHeardFromAt: AFTER, tour: TOUR, tourActivityAt: AFTER })).toBe('replied');
  });
  it('a PARTNER decline is not superseded by tour activity it never reads -> not_interested', () => {
    expect(deriveListingSendOutcome({ row: { sentAt: SENT, declined: staff(AFTER) }, recipientType: 'partner', lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: LATER })).toBe('not_interested');
  });
  it('an unknown recipient type (a missing contact) reads no tour -> no_reply', () => {
    expect(deriveListingSendOutcome({ row, recipientType: undefined, lastHeardFromAt: undefined, tour: TOUR, tourActivityAt: AFTER })).toBe('no_reply');
  });
});

describe('wireDecline', () => {
  it('present only when the outcome is not_interested; never carries staffId', () => {
    expect(wireDecline({ declined: staff(AFTER) }, 'not_interested')).toEqual({ at: AFTER, by: 'staff' });
    expect(wireDecline({ declined: staff(AFTER) }, 'replied')).toBeUndefined();
    expect(wireDecline({}, 'not_interested')).toBeUndefined();
  });
});

describe('isEligibleRecipient (B6 - one rule, has-a-phone included)', () => {
  const base = { type: 'tenant', status: 'searching', phone: '+14045550100' };
  it('a reachable searching tenant is eligible', () => {
    expect(isEligibleRecipient(base)).toBe(true);
  });
  it.each([
    ['soft-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' }],
    ['opted out', { sms_opt_out: true }],
    ['unreachable', { sms_unreachable: true }],
    ['no phone', { phone: undefined }],
    ['an empty phone', { phone: '' }],
    ['an inactive tenant', { status: 'inactive' }],
    ['a placed tenant', { status: 'placed' }],
  ])('%s is NOT eligible', (_label, over) => {
    expect(isEligibleRecipient({ ...base, ...over })).toBe(false);
  });
  it('an empty deleted_at is not deleted; false flags are not set', () => {
    expect(isEligibleRecipient({ ...base, deleted_at: '', sms_opt_out: false, sms_unreachable: false })).toBe(true);
  });
  it('the status clause is TENANT-only: a partner marked inactive/placed stays eligible', () => {
    expect(isEligibleRecipient({ type: 'partner', status: 'inactive', phone: '+14045550101' })).toBe(true);
    expect(isEligibleRecipient({ type: 'partner', status: 'placed', phone: '+14045550101' })).toBe(true);
  });
  it('a tenant with no status is eligible', () => {
    expect(isEligibleRecipient({ type: 'tenant', phone: '+14045550102' })).toBe(true);
  });
});

describe('interestedModeFor', () => {
  it("'route' with a structured tour_type, else 'form'", () => {
    expect(interestedModeFor({ tour_type: 'landlord_led' })).toBe('route');
    expect(interestedModeFor({})).toBe('form');
    expect(interestedModeFor({ tour_type: '' })).toBe('form');
  });
});

describe('isWaiting - all five clauses', () => {
  const sent = Date.parse('2026-10-01T12:00:00.000Z');
  const sentAt = '2026-10-01T12:00:00.000Z';
  const base = { outcome: 'no_reply' as const, eligible: true, sentAt };
  it('1. only no_reply / replied wait', () => {
    expect(isWaiting({ ...base, now: sent + 2 * 86_400_000 })).toBe(true);
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: '2026-10-01T13:00:00.000Z', now: sent + 3 * 86_400_000 })).toBe(true);
    expect(isWaiting({ ...base, outcome: 'interested', now: sent + 2 * 86_400_000 })).toBe(false);
    expect(isWaiting({ ...base, outcome: 'not_interested', now: sent + 2 * 86_400_000 })).toBe(false);
  });
  it('2. an ineligible recipient never waits', () => {
    expect(isWaiting({ ...base, eligible: false, now: sent + 2 * 86_400_000 })).toBe(false);
  });
  it('3. lookback: at exactly 14 days still waits, past it does not', () => {
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_LOOKBACK_MS })).toBe(true);
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_LOOKBACK_MS + 1 })).toBe(false);
  });
  it('4. quiet: at exactly 24 hours waits, before it does not', () => {
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_QUIET_MS })).toBe(true);
    expect(isWaiting({ ...base, now: sent + FOLLOW_UP_QUIET_MS - 1 })).toBe(false);
  });
  it('5. a reply after the send restarts the quiet window (max(sentAt, lastHeardFromAt))', () => {
    const heard = '2026-10-03T10:00:00.000Z';
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: heard, now: Date.parse(heard) + 2 * 3_600_000 })).toBe(false);
    expect(isWaiting({ ...base, outcome: 'replied', lastHeardFromAt: heard, now: Date.parse(heard) + FOLLOW_UP_QUIET_MS })).toBe(true);
    // A last-heard BEFORE the send does not move the window.
    expect(isWaiting({ ...base, lastHeardFromAt: '2026-09-20T00:00:00.000Z', now: sent + FOLLOW_UP_QUIET_MS })).toBe(true);
  });
});

describe('waitingSince', () => {
  it('the later of sentAt and lastHeardFromAt (sentAt when absent)', () => {
    expect(waitingSince(SENT)).toBe(SENT);
    expect(waitingSince(SENT, BEFORE)).toBe(SENT);
    expect(waitingSince(SENT, AFTER)).toBe(AFTER);
    expect(waitingSince(SENT, 'garbage')).toBe(SENT);
  });
});
```

GREEN - create `app/src/lib/listingSendOutcome.ts`:

```ts
// Listing-send OUTCOME rules (last-heard-from spec 5.4, 5.6, D11; section 14).
//
// PURE - no I/O. One module owns every rule an outcome-serving surface needs,
// so the units recipients read, the contact listings-sent read, the outcome
// route and the follow-ups list can never disagree:
//   - effectiveDecline: a recorded `declined` counts until a later counted
//     share (the row's sentAt) or later tour ACTIVITY supersedes it;
//   - deriveListingSendOutcome: not_interested > interested > replied >
//     no_reply, and a non-tenant recipient never reads a tour;
//   - isEligibleRecipient: the follow-up eligibility half (one rule, B6);
//   - interestedModeFor: 'route' when the unit has a structured tour_type;
//   - isWaiting / waitingSince: the waiting-on-a-reply rule (5.6).
// NOT lib/sendOutcome.ts - that name is the Twilio send-failure vocabulary
// (spec 14.1).
//
// Every instant comparison goes through Date.parse (spec section 7): a stored
// value may lack milliseconds, and an unparseable one never wins.
import type { TourSignal } from './listingSendTour.js';

export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';
export type InterestedMode = 'route' | 'form';

/** A waiting row is listed once the pair has been quiet this long. */
export const FOLLOW_UP_QUIET_MS = 24 * 3600 * 1000;
/** A send older than this is no longer chased. */
export const FOLLOW_UP_LOOKBACK_MS = 14 * 86400 * 1000;

/** The stored decline (listing_sends.declined). `staffId` never reaches the wire. */
export interface DeclineRecord {
  at: string;
  by: 'staff' | 'engine';
  staffId?: string;
}

/** Epoch ms of a non-empty ISO string; undefined when absent or unparseable. */
function instantMs(iso: string | undefined): number | undefined {
  if (typeof iso !== 'string' || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * D11: a decline is effective unless something LATER supersedes it - a
 * counted share (the row's sentAt follows the latest counted share) or tour
 * activity (deriveTourActivityAt). Equal instants keep it effective.
 */
export function effectiveDecline(
  row: { declined?: DeclineRecord; sentAt?: string },
  tourActivityAt: string | undefined,
): boolean {
  if (row.declined === undefined) return false;
  const declinedMs = instantMs(row.declined.at);
  if (declinedMs === undefined) return false;
  const sentMs = instantMs(row.sentAt);
  if (sentMs !== undefined && declinedMs < sentMs) return false;
  const tourMs = instantMs(tourActivityAt);
  if (tourMs !== undefined && declinedMs < tourMs) return false;
  return true;
}

/**
 * The ONE outcome derivation (spec 5.4). A recipient whose type is not
 * 'tenant' never reads a tour: neither the signal nor its activity (the tours
 * API accepts any contactId, and a converted caseworker keeps tenant-era
 * tours).
 */
export function deriveListingSendOutcome(input: {
  row: { declined?: DeclineRecord; sentAt?: string };
  recipientType: string | undefined;
  lastHeardFromAt: string | undefined;
  tour: TourSignal | undefined;
  tourActivityAt: string | undefined;
}): ListingSendOutcome {
  const readsTours = input.recipientType === 'tenant';
  const tour = readsTours ? input.tour : undefined;
  const tourActivityAt = readsTours ? input.tourActivityAt : undefined;
  if (effectiveDecline(input.row, tourActivityAt)) return 'not_interested';
  if (tour !== undefined) return 'interested';
  const heardMs = instantMs(input.lastHeardFromAt);
  const sentMs = instantMs(input.row.sentAt);
  if (heardMs !== undefined && sentMs !== undefined && heardMs > sentMs) return 'replied';
  return 'no_reply';
}

/** The wire `declined` (spec 5.4): present ONLY while effective; never staffId. */
export function wireDecline(
  row: { declined?: DeclineRecord },
  outcome: ListingSendOutcome,
): { at: string; by: 'staff' | 'engine' } | undefined {
  if (outcome !== 'not_interested' || row.declined === undefined) return undefined;
  return { at: row.declined.at, by: row.declined.by };
}

/** Spec 5.6 / B6: can this recipient be chased by text at all? */
export function isEligibleRecipient(c: {
  type?: string;
  status?: string;
  deleted_at?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
  phone?: string;
}): boolean {
  if (typeof c.deleted_at === 'string' && c.deleted_at.length > 0) return false;
  if (c.sms_opt_out === true || c.sms_unreachable === true) return false;
  if (typeof c.phone !== 'string' || c.phone.length === 0) return false;
  if (c.type === 'tenant' && (c.status === 'inactive' || c.status === 'placed')) return false;
  return true;
}

/** D14: one click creates the tour only when the unit says how it tours. */
export function interestedModeFor(unit: { tour_type?: string }): InterestedMode {
  return typeof unit.tour_type === 'string' && unit.tour_type.length > 0 ? 'route' : 'form';
}

/** Spec 5.6: a send waiting on a reply (outcome, eligibility, lookback, quiet). */
export function isWaiting(input: {
  outcome: ListingSendOutcome;
  eligible: boolean;
  sentAt: string;
  lastHeardFromAt?: string;
  now: number;
}): boolean {
  if (input.outcome !== 'no_reply' && input.outcome !== 'replied') return false;
  if (!input.eligible) return false;
  const sentMs = instantMs(input.sentAt);
  if (sentMs === undefined) return false;
  if (input.now - sentMs > FOLLOW_UP_LOOKBACK_MS) return false;
  const heardMs = instantMs(input.lastHeardFromAt);
  const quietSince = heardMs !== undefined && heardMs > sentMs ? heardMs : sentMs;
  return input.now - quietSince >= FOLLOW_UP_QUIET_MS;
}

/** Spec 5.6: the instant a waiting row has been quiet since. */
export function waitingSince(sentAt: string, lastHeardFromAt?: string): string {
  const sentMs = instantMs(sentAt);
  const heardMs = instantMs(lastHeardFromAt);
  if (lastHeardFromAt !== undefined && heardMs !== undefined && (sentMs === undefined || heardMs > sentMs)) {
    return lastHeardFromAt;
  }
  return sentAt;
}
```

Commit: `feat(app): listingSendOutcome - the pure send-outcome rules`.

### Task 3.2 - `deriveTourActivityAt` in `app/src/lib/listingSendTour.ts`

RED - `app/test/listingSendTour.test.ts`: change the import at `:14` to
`import { deriveTourActivityAt, deriveTourSignal } from '../src/lib/listingSendTour.js';`
and append (the file's own `tour()` builder at `:18-28`):

```ts
describe('deriveTourActivityAt - the latest qualifying ACTIVITY instant (spec 5.4, D11)', () => {
  it('no tours -> undefined', () => {
    expect(deriveTourActivityAt([])).toBeUndefined();
  });

  it('a fresh requested tour -> its createdAt (lastMarkedAt absent until a person acts)', () => {
    expect(deriveTourActivityAt([tour({ tourId: 't1', status: 'requested', createdAt: '2026-08-01T00:00:00.000Z' })])).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('max over EVERY qualifying tour, not the chip winner: an older toured tour behind a newer request', () => {
    const tours = [
      tour({ tourId: 't-old', status: 'toured', createdAt: '2026-07-01T00:00:00.000Z', lastMarkedAt: '2026-07-05T00:00:00.000Z' }),
      tour({ tourId: 't-new', status: 'requested', createdAt: '2026-08-01T00:00:00.000Z' }),
    ];
    // The chip is the most PROGRESSED tour (toured) ...
    expect(deriveTourSignal(tours)).toEqual({ tourId: 't-old', state: 'toured' });
    // ... but the activity is the request made after it.
    expect(deriveTourActivityAt(tours)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('a rescheduled or reopened tour counts from lastMarkedAt', () => {
    expect(
      deriveTourActivityAt([tour({ tourId: 't1', status: 'scheduled', createdAt: '2026-07-01T00:00:00.000Z', lastMarkedAt: '2026-09-01T00:00:00.000Z' })]),
    ).toBe('2026-09-01T00:00:00.000Z');
    // Reopened from an auto-close back to toured (reopenIf stamps lastMarkedAt).
    expect(
      deriveTourActivityAt([tour({ tourId: 't2', status: 'toured', createdAt: '2026-06-01T00:00:00.000Z', lastMarkedAt: '2026-09-10T00:00:00.000Z' })]),
    ).toBe('2026-09-10T00:00:00.000Z');
  });

  it('NEVER updatedAt: a later automated touch (group open, conversion claim) moves nothing', () => {
    expect(
      deriveTourActivityAt([
        tour({ tourId: 't1', status: 'scheduled', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-12-01T00:00:00.000Z' }),
      ]),
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('non-qualifying tours contribute nothing (canceled, no_show, a not-a-fit close, auto-closed from scheduled)', () => {
    const dead = [
      tour({ tourId: 'c', status: 'canceled', createdAt: '2026-11-01T00:00:00.000Z', lastMarkedAt: '2026-11-02T00:00:00.000Z' }),
      tour({ tourId: 'n', status: 'no_show', createdAt: '2026-11-01T00:00:00.000Z' }),
      tour({ tourId: 'x', status: 'closed', outcome: 'not_a_fit', createdAt: '2026-11-01T00:00:00.000Z' }),
      tour({ tourId: 'a', status: 'closed', autoClosedFrom: 'scheduled', createdAt: '2026-11-01T00:00:00.000Z' }),
    ];
    expect(deriveTourActivityAt(dead)).toBeUndefined();
    expect(deriveTourActivityAt([...dead, tour({ tourId: 'q', status: 'requested', createdAt: '2026-07-01T00:00:00.000Z' })])).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('a converted close and an auto-close FROM toured qualify, exactly as for the chip', () => {
    expect(
      deriveTourActivityAt([tour({ tourId: 'cv', status: 'closed', convertedPlacementId: 'pl-1', createdAt: '2026-07-02T00:00:00.000Z' })]),
    ).toBe('2026-07-02T00:00:00.000Z');
    expect(
      deriveTourActivityAt([tour({ tourId: 'ac', status: 'closed', autoClosedFrom: 'toured', createdAt: '2026-07-03T00:00:00.000Z' })]),
    ).toBe('2026-07-03T00:00:00.000Z');
  });

  it('compares instants and returns the stored string of the latest one', () => {
    expect(
      deriveTourActivityAt([
        tour({ tourId: 'a', status: 'requested', createdAt: '2026-07-01T00:00:00Z' }),
        tour({ tourId: 'b', status: 'requested', createdAt: '2026-06-30T23:59:59.999Z', lastMarkedAt: 'garbage' }),
      ]),
    ).toBe('2026-07-01T00:00:00Z');
  });

  it('(PIN) the wire chip stays exactly { tourId, state } - activity is a SEPARATE function (A4)', () => {
    const signal = deriveTourSignal([tour({ tourId: 't1', status: 'scheduled', lastMarkedAt: '2026-09-01T00:00:00.000Z' })]);
    expect(Object.keys(signal ?? {}).sort()).toEqual(['state', 'tourId']);
  });
});
```

RED today: `deriveTourActivityAt` is not exported (the import fails).

GREEN - `app/src/lib/listingSendTour.ts`: append after `deriveTourSignal`
(`:72-87`), reusing the private `qualifyingState` (`:56-66`):

```ts
/**
 * The pair's latest tour ACTIVITY instant (last-heard-from spec 5.4, D11):
 * the max over EVERY qualifying tour (the chip's set - requested, scheduled,
 * toured, converted, auto-closed from toured) of max(createdAt, lastMarkedAt).
 * `lastMarkedAt` is the model's "a person marked / rescheduled / reopened it"
 * (toursModel.ts:214-218; stamped by PATCH on any status change or new time,
 * routes/tours.ts:1333-1338, and by reopenIf) and is absent until a person
 * acts, so createdAt carries a fresh tour. NEVER updatedAt - that is
 * last-touched-by-anything (toursRepo.ts:559) and would let an automated
 * write undo a decline. A SEPARATE function, not a field on deriveTourSignal's
 * result: that result IS the wire `tour` field (route tests pin it with
 * toEqual({ tourId, state })). Not the chip winner's own time either: the
 * winner is the most PROGRESSED tour, so an old toured tour would hide a
 * request made after a decline. Returns the stored string of the latest
 * parseable instant, or undefined when no qualifying tour has one.
 */
export function deriveTourActivityAt(tours: TourItem[]): string | undefined {
  let best: { at: string; ms: number } | undefined;
  for (const tour of tours) {
    if (qualifyingState(tour) === undefined) continue;
    for (const candidate of [tour.createdAt, tour.lastMarkedAt]) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const ms = Date.parse(candidate);
      if (!Number.isFinite(ms)) continue;
      if (best === undefined || ms > best.ms) best = { at: candidate, ms };
    }
  }
  return best?.at;
}
```

Also extend the module header (`:1-27`) with one line after `:27`:
`// deriveTourActivityAt (below) is the sibling the send OUTCOME reads (D11).`

Commit: `feat(app): deriveTourActivityAt - the pair's latest tour activity`.

### Task 3.3 - `declined` on the listing-send row + `setDeclined` / `clearDeclined`

RED:

1. `app/test/listingSendsRepo.integration.test.ts` (DynamoDB Local, the
   self-skipping describe at `:43-58`; add `import type { DeclineRecord } from '../src/lib/listingSendOutcome.js';`
   and `ShareMemoryWrite` to the repo import at `:19`). Append inside the
   describe:

```ts
  describe('declined (last-heard-from spec 5.4) - setDeclined / clearDeclined', () => {
    const DECLINE: DeclineRecord = { at: '2026-06-17T09:00:00.000Z', by: 'staff', staffId: 'usr_test' };

    it('setDeclined stores the record on a counted row and touches nothing else', async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
      const before = await repo.getByKeyConsistent(unitId, contactId);

      expect(await repo.setDeclined(unitId, contactId, DECLINE)).toBe('ok');

      const after = await repo.getByKeyConsistent(unitId, contactId);
      expect(after?.declined).toEqual(DECLINE);
      expect(after?.sentAt).toBe(before?.sentAt);
      expect(after?.broadcastId).toBe(before?.broadcastId);
      expect(after?.shares).toEqual(before?.shares);
      expect(after?.shares_op).toBe(before?.shares_op); // not a memory write
      expect(after?.created_at).toBe(before?.created_at);
    });

    it('a record without staffId is stored without the key', async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z' });
      expect(await repo.setDeclined(unitId, contactId, { at: DECLINE.at, by: 'engine' })).toBe('ok');
      expect((await repo.getByKeyConsistent(unitId, contactId))?.declined).toEqual({ at: DECLINE.at, by: 'engine' });
    });

    it('putShareMemory (a later counted share) never clobbers declined - the NO-RESET invariant', async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
      await repo.setDeclined(unitId, contactId, DECLINE);
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-18T10:00:00.000Z', broadcastId: 'bcast-2' });
      const row = await repo.getByKeyConsistent(unitId, contactId);
      expect(row?.sentAt).toBe('2026-06-18T10:00:00.000Z');
      expect(row?.declined).toEqual(DECLINE);
    });

    it('clearDeclined REMOVEs only declined; a second clear is still ok (idempotent)', async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
      await repo.setDeclined(unitId, contactId, DECLINE);
      expect(await repo.clearDeclined(unitId, contactId)).toBe('ok');
      const row = await repo.getByKeyConsistent(unitId, contactId);
      expect(row).not.toHaveProperty('declined');
      expect(row?.sentAt).toBe('2026-06-16T10:00:00.000Z');
      expect(await repo.clearDeclined(unitId, contactId)).toBe('ok');
    });

    it("an UNCOUNTED row is not declinable: both writers answer 'not_found' and write nothing", async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      const failed: ShareMemoryWrite = {
        shares: { 'b-1': { attempt: '2026-06-16T10:00:00.000Z#SM1', conversationId: 'conv-1', state: 'failed' } },
        counted: false,
        sentAt: undefined,
        broadcastId: undefined,
      };
      expect(await repo.putShareMemory(unitId, contactId, failed, { token: undefined })).toBe(true);
      expect(await repo.setDeclined(unitId, contactId, DECLINE)).toBe('not_found');
      expect(await repo.clearDeclined(unitId, contactId)).toBe('not_found');
      expect((await repo.getByKeyConsistent(unitId, contactId))?.declined).toBeUndefined();
    });

    it("an absent row answers 'not_found' and is NOT created", async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      expect(await repo.setDeclined(unitId, contactId, DECLINE)).toBe('not_found');
      expect(await repo.clearDeclined(unitId, contactId)).toBe('not_found');
      expect(await repo.getByKey(unitId, contactId)).toBeUndefined();
    });
  });
```

2. Fake-vs-real parity - `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`
   (the LS harness at `:921-1027`, runner `:1205-1220`; `normalizeLedgerRow`
   at `:929-938` keeps `declined` and reduces `updated_at` to `<clock>`). Add
   two step builders after `ledgerByKeys` (`:990-996`):

```ts
/** setDeclined / clearDeclined (last-heard-from spec 5.4): 'ok' | 'not_found'. */
const declineStep = (unit: string, contact: string, expected: 'ok' | 'not_found'): LsStep => ({
  label: `setDeclined ${unit}/${contact}`,
  run: async (repo, ctx) => repo.setDeclined(lsUnit(ctx, unit), lsContact(ctx, contact), { at: T1, by: 'staff', staffId: 'usr_parity' }),
  expect: expected,
});

const clearDeclineStep = (unit: string, contact: string, expected: 'ok' | 'not_found'): LsStep => ({
  label: `clearDeclined ${unit}/${contact}`,
  run: async (repo, ctx) => repo.clearDeclined(lsUnit(ctx, unit), lsContact(ctx, contact)),
  expect: expected,
});
```

   and append one `LS_CASES` entry before `];` at `:1027`:

```ts
  {
    name: 'declined: set on a counted row survives a later memory write; clear removes it; an uncounted or absent row is not_found',
    watch: [['unit-1', 'c1'], ['unit-2', 'c2']],
    steps: [
      declineStep('unit-1', 'c1', 'not_found'),
      shareMemory('unit-1', 'c1', LS_COUNTED, 'none', true),
      declineStep('unit-1', 'c1', 'ok'),
      shareMemory('unit-1', 'c1', LS_RECOUNTED, 'current', true),
      clearDeclineStep('unit-1', 'c1', 'ok'),
      clearDeclineStep('unit-1', 'c1', 'ok'),
      shareMemory('unit-2', 'c2', LS_CLEARED, 'none', true),
      declineStep('unit-2', 'c2', 'not_found'),
      clearDeclineStep('unit-2', 'c2', 'not_found'),
    ],
  },
```

RED today: `setDeclined` / `clearDeclined` do not exist on `ListingSendsRepo`
(typecheck and runtime both fail).

GREEN:

- `app/src/repos/listingSendsRepo.ts` header `:14-16` - replace the three
  NO-RESET lines with:

```ts
// NO-RESET INVARIANT: the one share writer, putShareMemory, stamps created_at
// (and via) only when absent, so a later share never rewrites the first-write
// furniture. (share-sent-outcome T7 retired the old blind upsert writer.) It
// extends to `declined` (last-heard-from spec 5.4): putShareMemory never SETs
// or REMOVEs it, and NO writer resets it except clearDeclined. The outcome
// route's two writers, setDeclined / clearDeclined, touch ONLY `declined` and
// `updated_at`, conditioned on a COUNTED row. A cleared decline's history
// lives in the activity / audit events, never on the row.
```

- Import after `:39`: `import type { DeclineRecord, InterestedMode, ListingSendOutcome } from '../lib/listingSendOutcome.js';`
- `ListingSendItem` (`:71-97`) - add before the index signature at `:96`:

```ts
  /** last-heard-from spec 5.4: a recorded "not interested". Absent = not
   *  declined. Written ONLY by setDeclined / clearDeclined; a superseded
   *  record stays here and is simply ineffective (lib/listingSendOutcome.ts). */
  declined?: DeclineRecord;
```

- `ListingSendsRepo` (`:131-157`) - add at the END of the interface (before
  `:157`):

```ts
  /**
   * last-heard-from spec 5.4: SET `declined` (and `updated_at`) on a COUNTED
   * row - condition `attribute_exists(unitId) AND (attribute_not_exists(counted)
   * OR counted <> :false)`. 'not_found' when the condition fails (no row, or no
   * share counts); anything else throws. Never creates a row.
   */
  setDeclined(unitId: string, contactId: string, record: DeclineRecord): Promise<'ok' | 'not_found'>;
  /** REMOVE `declined` (SET `updated_at`) under the same condition. Idempotent. */
  clearDeclined(unitId: string, contactId: string): Promise<'ok' | 'not_found'>;
```

- `createListingSendsRepo` - add both methods to the returned object after
  `putShareMemory` (insert after `:295`):

```ts
    async setDeclined(unitId, contactId, record) {
      const now = new Date().toISOString();
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId, contactId },
            UpdateExpression: 'SET #declined = :declined, #updatedAt = :now',
            ConditionExpression: 'attribute_exists(#unitId) AND (attribute_not_exists(#counted) OR #counted <> :false)',
            ExpressionAttributeNames: {
              '#declined': 'declined',
              '#updatedAt': 'updated_at',
              '#unitId': 'unitId',
              '#counted': 'counted',
            },
            ExpressionAttributeValues: {
              ':declined': { at: record.at, by: record.by, ...(record.staffId !== undefined && { staffId: record.staffId }) },
              ':now': now,
              ':false': false,
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'not_found';
        throw err;
      }
      log.info({ unitId, contactId, by: record.by }, 'listing send decline recorded');
      return 'ok';
    },

    async clearDeclined(unitId, contactId) {
      const now = new Date().toISOString();
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId, contactId },
            UpdateExpression: 'SET #updatedAt = :now REMOVE #declined',
            ConditionExpression: 'attribute_exists(#unitId) AND (attribute_not_exists(#counted) OR #counted <> :false)',
            ExpressionAttributeNames: {
              '#declined': 'declined',
              '#updatedAt': 'updated_at',
              '#unitId': 'unitId',
              '#counted': 'counted',
            },
            ExpressionAttributeValues: { ':now': now, ':false': false },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'not_found';
        throw err;
      }
      log.info({ unitId, contactId }, 'listing send decline cleared');
      return 'ok';
    },
```

- Every typed `ListingSendsRepo` fake (reference section 29: the ONLY full one
  is `app/test/helpers/twilioWebhookHarness.ts:3395`; `shareLedger.test.ts:19-38`
  and `helpers/listingSendSeed.ts` take a `Pick` and are unaffected). Add after
  `putShareMemory` (insert after `:3431`), and add `DeclineRecord` to the
  harness's type imports from `../../src/lib/listingSendOutcome.js`:

```ts
    // last-heard-from spec 5.4: the decline writers, modelled on the real
    // conditional UpdateItem - a row must exist and count (`counted` absent on
    // a legacy row reads as counted); otherwise 'not_found' and nothing is
    // written. They touch ONLY `declined` + `updated_at`, so putShareMemory
    // (which mutates its own fields in place) never clobbers a decline. Held
    // to the real repo by twilioWebhookHarnessRepoAdditions.integration.test.ts.
    async setDeclined(unitId, contactId, record) {
      const row = findListingSend(unitId, contactId);
      if (row === undefined || row.counted === false) return 'not_found';
      row.declined = JSON.parse(JSON.stringify(record)) as DeclineRecord;
      row.updated_at = new Date().toISOString();
      return 'ok';
    },
    async clearDeclined(unitId, contactId) {
      const row = findListingSend(unitId, contactId);
      if (row === undefined || row.counted === false) return 'not_found';
      delete row.declined;
      row.updated_at = new Date().toISOString();
      return 'ok';
    },
```

Commit: `feat(app): listing-send declined record - setDeclined / clearDeclined`.

### Task 3.4 - the recipient projection widens; `requireComplete` on `getRecipientDisplaysByIds`

RED:

1. `app/test/caseworkerRepoParity.integration.test.ts:376-415` (runs on the
   harness fake AND DynamoDB Local via `parity`, `:170-177`) - KNOWING rewrite
   of the existing case: its two `toEqual`s gain `status: 'active'` (the
   partner, `:399-406`) and `status: 'searching'` (the tenant, `:407-412`),
   and the title becomes `'projects the display fields plus type, role,
   status and the reachability facts - nothing else; a missing id is absent'`.
   Add a second parity case below it:

```ts
  parity('projects last_heard_from_at, sms_opt_out and sms_unreachable (last-heard-from spec 5.5)', async (w, id) => {
    const phone = nextPhone();
    await w.putContact({
      contactId: id,
      type: 'tenant',
      status: 'placed',
      firstName: 'Ray',
      phone,
      sms_opt_out: true,
      sms_unreachable: false,
      last_heard_from_at: '2026-10-01T12:00:00.000Z',
      notes: 'not projected',
    });
    expect((await w.contacts.getRecipientDisplaysByIds([id])).get(id)).toEqual({
      contactId: id,
      firstName: 'Ray',
      phone,
      type: 'tenant',
      status: 'placed',
      sms_opt_out: true,
      sms_unreachable: false,
      last_heard_from_at: '2026-10-01T12:00:00.000Z',
    });
  });
```

   The `(PIN) getDisplaysByIds keeps its narrower projection` case at `:417-421`
   stays unchanged and green.

2. `app/test/contactsBatchIncomplete.test.ts` - append a describe (reuses the
   file's `stubDoc`, `:54-83`, `testEnv`, `createContactsRepo`, `IncompleteBatchReadError`):

```ts
describe('contactsRepo.getRecipientDisplaysByIds - requireComplete (last-heard-from D12)', () => {
  const logger = createLogger({ destination: createLogCapture().stream });

  it('DROPS unprocessed keys by default (a label read)', async () => {
    const { doc } = stubDoc({ withholdPerRequest: 1 });
    const contacts = createContactsRepo({ doc, env: testEnv, logger });
    expect((await contacts.getRecipientDisplaysByIds(['c-1', 'c-2', 'c-3'])).size).toBe(2);
  });

  it('THROWS IncompleteBatchReadError under requireComplete (an outcome read)', async () => {
    const { doc } = stubDoc({ withholdPerRequest: 1 });
    const contacts = createContactsRepo({ doc, env: testEnv, logger });
    await expect(
      contacts.getRecipientDisplaysByIds(['c-1', 'c-2', 'c-3'], { requireComplete: true }),
    ).rejects.toBeInstanceOf(IncompleteBatchReadError);
  });

  it('asks for status through a placeholder (a DynamoDB reserved word) and the three new attributes', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const doc = {
      async send(command: { input: Record<string, unknown> }) {
        inputs.push(command.input);
        const requestItems = command.input['RequestItems'] as Record<string, { Keys: Array<{ contactId: string }> }>;
        const table = Object.keys(requestItems)[0]!;
        return { Responses: { [table]: requestItems[table]!.Keys.map(({ contactId }) => ({ contactId })) } };
      },
    } as unknown as DynamoDBDocumentClient;
    const contacts = createContactsRepo({ doc, env: testEnv, logger });
    await contacts.getRecipientDisplaysByIds(['c-1'], { requireComplete: true });
    const req = Object.values(inputs[0]!['RequestItems'] as Record<string, Record<string, unknown>>)[0]!;
    const projection = String(req['ProjectionExpression']);
    const names = req['ExpressionAttributeNames'] as Record<string, string>;
    expect(projection).toContain('#status');
    expect(names['#status']).toBe('status');
    expect(Object.values(names)).toEqual(
      expect.arrayContaining(['last_heard_from_at', 'sms_opt_out', 'sms_unreachable', 'type', 'role', 'deleted_at', 'phone']),
    );
  });
});
```

RED today: the parity `toEqual`s fail (no `status` / reachability fields are
projected), and `requireComplete` is not a parameter (the stub withholds and
the call returns a short map - no throw).

GREEN:

- `app/src/repos/contactsRepo.ts:362` - replace the `RecipientDisplay` line:

```ts
export type RecipientDisplay = ContactDisplayItem & {
  type?: ContactType;
  role?: string;
  /** last-heard-from spec 5.5 (one eligibility rule, lib/listingSendOutcome.ts). */
  status?: string;
  last_heard_from_at?: string;
  sms_opt_out?: boolean;
  sms_unreachable?: boolean;
};
```

  and extend its doc comment (`:356-361`) with one line: `last-heard-from
  (spec 5.5, B6/B7): plus status and the reachability facts, so the outcome
  reads can decide eligibility; read with requireComplete there.`

- Interface `:716-720` - replace the method line:

```ts
  getRecipientDisplaysByIds(contactIds: string[], opts?: { requireComplete?: boolean }): Promise<Map<string, RecipientDisplay>>;
```

  and add to its doc: `requireComplete: throw IncompleteBatchReadError on an
  unread key (an OUTCOME read - the outcome-serving routes, spec D12); a
  genuinely missing contact is still just absent.`

- `RECIPIENT_PROJECTION` `:1018-1025` - replace with:

```ts
  const RECIPIENT_PROJECTION = {
    ProjectionExpression:
      '#contactId, #firstName, #lastName, #phone, #deletedAt, #type, #role, #status, #lastHeardFromAt, #smsOptOut, #smsUnreachable',
    ExpressionAttributeNames: {
      ...DISPLAY_PROJECTION.ExpressionAttributeNames,
      '#type': 'type',
      '#role': 'role',
      '#status': 'status',
      '#lastHeardFromAt': 'last_heard_from_at',
      '#smsOptOut': 'sms_opt_out',
      '#smsUnreachable': 'sms_unreachable',
    },
  } as const;
```

  (comment at `:1014-1017` gains: `plus status (reserved - placeholder) and
  the last-heard-from reachability facts`.)

- Implementation `:1284-1286`:

```ts
    async getRecipientDisplaysByIds(contactIds, opts) {
      return batchGetByIds<RecipientDisplay>(contactIds, {
        projection: RECIPIENT_PROJECTION,
        requireComplete: opts?.requireComplete,
      });
    },
```

- Harness mirror `app/test/helpers/twilioWebhookHarness.ts:2219-2226` - replace
  `projectRecipient`:

```ts
  const projectRecipient = (contact: ContactItem): RecipientDisplay => {
    const role = contact['role'];
    return {
      ...projectDisplay(contact),
      ...(typeof contact.type === 'string' && { type: contact.type }),
      ...(typeof role === 'string' && { role }),
      ...(typeof contact.status === 'string' && { status: contact.status }),
      ...(typeof contact.last_heard_from_at === 'string' && { last_heard_from_at: contact.last_heard_from_at }),
      ...(typeof contact.sms_opt_out === 'boolean' && { sms_opt_out: contact.sms_opt_out }),
      ...(typeof contact.sms_unreachable === 'boolean' && { sms_unreachable: contact.sms_unreachable }),
    };
  };
```

  The fake's `getRecipientDisplaysByIds(contactIds)` at `:2270-2277` keeps its
  one parameter (it ignores `requireComplete`, like its `getManyByIds` at
  `:2278-2285`; tests inject an incomplete read by reassigning the method -
  findings B7). The other three typed `ContactsRepo` literals
  (`contactCapture.test.ts:147`, `scheduledSendSuppression.test.ts:278`,
  `sendMessage.test.ts:262`) throw "not used" and need no change (an optional
  second parameter is assignment-compatible).

Commit: `feat(app): recipient projection carries status and reachability; requireComplete`.

### Task 3.5 - the outcome event writer and the three event types

RED - new `app/test/listingOutcomeEvents.test.ts` (the `app/test/tourEvents.test.ts:37-77`
pattern):

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { recordListingOutcomeEvent } from '../src/lib/listingOutcomeEvents.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const AT = '2026-10-13T15:00:00.000Z';

function setup() {
  const world = createFakeWorld();
  // A unit WITH a landlord: the writer must still never copy the landlord.
  world.units.set('unit-1', {
    unitId: 'unit-1',
    landlordId: 'contact-ll-1',
    status: 'available',
    created_at: AT,
    updated_at: AT,
  });
  const capture = createLogCapture();
  const deps = {
    activityEvents: world.activityEventsRepo,
    audit: world.auditRepo,
    logger: createLogger({ destination: capture.stream }),
  };
  return { world, deps, capture };
}

describe('recordListingOutcomeEvent (spec 14.3)', () => {
  it('pins the CONTACT timeline only (refType unit) and appends the unit audit with { contactId, actor }', async () => {
    const { world, deps } = setup();
    await recordListingOutcomeEvent(deps, {
      type: 'listing_declined',
      contactId: 'c-1',
      unitId: 'unit-1',
      label: 'Not interested in 12 Oak St, Atlanta, GA',
      actor: 'usr_va',
      at: AT,
    });
    expect(world.activityEvents).toHaveLength(1); // no landlord copy
    expect(world.activityEvents[0]).toMatchObject({
      contactId: 'c-1',
      type: 'listing_declined',
      label: 'Not interested in 12 Oak St, Atlanta, GA',
      refType: 'unit',
      refId: 'unit-1',
      at: AT,
    });
    expect(world.auditEvents).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_declined', actorId: 'usr_va', payload: { contactId: 'c-1', actor: 'usr_va' } },
    ]);
  });

  it('listing_interested carries tourId on the unit audit (the Activity row links the tour); no actor -> no actor key', async () => {
    const { world, deps } = setup();
    await recordListingOutcomeEvent(deps, {
      type: 'listing_interested',
      contactId: 'c-1',
      unitId: 'unit-1',
      label: 'Interested in 12 Oak St - tour requested',
      tourId: 'tour-9',
      at: AT,
    });
    expect(world.activityEvents[0]).toMatchObject({ type: 'listing_interested', refType: 'unit', refId: 'unit-1' });
    expect(world.auditEvents).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_interested', payload: { contactId: 'c-1', tourId: 'tour-9' } },
    ]);
  });

  it('a failed timeline write is logged and the audit row is still written; never throws', async () => {
    const { world, deps, capture } = setup();
    world.activityEventsRepo.record = async () => {
      throw new Error('activity down');
    };
    await expect(
      recordListingOutcomeEvent(deps, { type: 'listing_decline_cleared', contactId: 'c-1', unitId: 'unit-1', label: 'x', at: AT }),
    ).resolves.toBeUndefined();
    expect(world.auditEvents).toHaveLength(1);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_decline_cleared contact timeline record failed (best-effort)')).toBe(true);
  });

  it('a failed unit audit is logged; never throws', async () => {
    const { world, deps, capture } = setup();
    world.failAuditAppendFor.add('listing_declined');
    await expect(
      recordListingOutcomeEvent(deps, { type: 'listing_declined', contactId: 'c-1', unitId: 'unit-1', label: 'x', at: AT }),
    ).resolves.toBeUndefined();
    expect(world.activityEvents).toHaveLength(1);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_declined unit audit failed (best-effort)')).toBe(true);
  });
});
```

RED today: the module does not exist, and `'listing_declined'` etc. are not
`ActivityEventType` members (typecheck).

GREEN:

- `app/src/repos/activityEventsRepo.ts:60-61` - the union's last member
  `| 'removed_from_group_text';` becomes (additive, after the existing members):

```ts
  | 'removed_from_group_text'
  // last-heard-from spec 5.4: the send-outcome route's three events, written
  // by lib/listingOutcomeEvents.ts (refType 'unit', the CONTACT's feed only).
  | 'listing_declined'
  | 'listing_decline_cleared'
  | 'listing_interested';
```

- New `app/src/lib/listingOutcomeEvents.ts`:

```ts
// The ONE writer for a send-outcome event (last-heard-from spec 5.4 as
// amended by 14.3): listing_declined, listing_decline_cleared,
// listing_interested. Two best-effort surfaces:
//   - the CONTACT's timeline (an activity event, refType 'unit' / refId
//     unitId) - never a landlord copy: a decline is not deal news for the
//     landlord (the dual-party rule, lib/personEvents.ts:6-9);
//   - the property's Activity card: a `units#<unitId>` audit row whose payload
//     holds only keys the Activity projection whitelists (routes/units.ts
//     toUnitActivityEvent): contactId, actor (hoisted to actorId), and tourId
//     on listing_interested so the row links the tour. `by` (staff / engine)
//     is deliberately NOT written: "(auto)" renders on the cards only.
// NEITHER may fail the caller - the outcome is already persisted. Unlike
// lib/tourEvents.ts this needs no tourId and copies no landlord. PII-safe
// logs: ids and type only (the label carries an address - never logged).
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { Logger } from './logger.js';

export type ListingOutcomeEventType = 'listing_declined' | 'listing_decline_cleared' | 'listing_interested';

export async function recordListingOutcomeEvent(
  deps: { activityEvents: ActivityEventsRepo; audit: AuditRepo; logger: Logger },
  input: {
    type: ListingOutcomeEventType;
    contactId: string;
    unitId: string;
    /** The timeline label, address included (Timeline.tsx renders it verbatim). */
    label: string;
    actor?: string;
    tourId?: string;
    at: string;
  },
): Promise<void> {
  const { activityEvents, audit, logger: log } = deps;
  const { type, contactId, unitId, label, actor, tourId, at } = input;
  try {
    await activityEvents.record({ contactId, type, label, refType: 'unit', refId: unitId, at });
  } catch (err) {
    log.error({ err, contactId, unitId, type }, `${type} contact timeline record failed (best-effort)`);
  }
  try {
    await audit.append(`units#${unitId}`, type, {
      contactId,
      ...(actor !== undefined && { actor }),
      ...(tourId !== undefined && { tourId }),
    });
  } catch (err) {
    log.error({ err, contactId, unitId, type }, `${type} unit audit failed (best-effort)`);
  }
}
```

- Unit audit event types (an open set, documented in comments only):
  `app/src/routes/units.ts:217` ` * tour_reopened).` becomes
  ` * tour_reopened, listing_declined, listing_decline_cleared,` + new line
  ` * listing_interested).`; the landlord interleave
  (`app/src/routes/contactTimeline.ts:331-336`) is NOT extended - the three
  types stay off a landlord's page by design (no landlord copy).

- Dashboard mirror, additive (`dashboard/src/api/types.ts:2738-2739`): the
  last member `| 'removed_from_group_text';` becomes

```ts
  | 'removed_from_group_text'
  // last-heard-from spec 5.4: mirrors the server union (activityEventsRepo.ts).
  | 'listing_declined'
  | 'listing_decline_cleared'
  | 'listing_interested';
```

  and the `UnitActivityEvent` doc (`:3130`) `*  tour_reopened.` becomes
  `*  tour_reopened, listing_declined, listing_decline_cleared,` + new line
  `*  listing_interested.`

Commit: `feat(app): recordListingOutcomeEvent and the three outcome event types`.

### Task 3.6 - the two GET projections (required joins, `recipientMissing`, `eligible`, `interestedMode`, partner rows without `tour`)

RED:

1. New `app/test/listingSendRowProjection.test.ts` (pure serializer):

```ts
import { describe, expect, it } from 'vitest';
import { toListingSendRow, type ListingSendItem } from '../src/repos/listingSendsRepo.js';

const ITEM: ListingSendItem = {
  unitId: 'unit-1',
  contactId: 'c-1',
  sentAt: '2026-06-16T10:00:00.000Z',
  via: 'broadcast',
  broadcastId: 'b-1',
  created_at: 'x',
  updated_at: 'x',
  declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff', staffId: 'usr_x' },
};

describe('toListingSendRow(item, opts)', () => {
  it('serializes the options object; drops furniture and the stored decline unless passed', () => {
    expect(toListingSendRow(ITEM, { outcome: 'replied', interestedSupported: true })).toEqual({
      contactId: 'c-1',
      unitId: 'unit-1',
      sentAt: '2026-06-16T10:00:00.000Z',
      via: 'broadcast',
      broadcastId: 'b-1',
      outcome: 'replied',
      interestedSupported: true,
    });
  });
  it('carries every optional field when given; declined never carries staffId; recipientMissing only when true', () => {
    const row = toListingSendRow(ITEM, {
      tour: { tourId: 't-1', state: 'requested' },
      tenantName: 'Tia Moss',
      facts: { type: 'tenant' },
      outcome: 'not_interested',
      lastHeardFromAt: '2026-06-18T10:00:00.000Z',
      declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff' },
      interestedSupported: true,
      interestedMode: 'route',
      eligible: false,
      recipientMissing: false,
    });
    expect(row).toEqual({
      contactId: 'c-1',
      tenantName: 'Tia Moss',
      unitId: 'unit-1',
      sentAt: '2026-06-16T10:00:00.000Z',
      via: 'broadcast',
      broadcastId: 'b-1',
      tour: { tourId: 't-1', state: 'requested' },
      type: 'tenant',
      lastHeardFromAt: '2026-06-18T10:00:00.000Z',
      outcome: 'not_interested',
      declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff' },
      interestedSupported: true,
      interestedMode: 'route',
      eligible: false,
    });
  });
  it('(PIN) an uncounted row without sentAt is never projected', () => {
    const { sentAt: _drop, ...noSent } = ITEM;
    expect(() => toListingSendRow(noSent as ListingSendItem, { outcome: 'no_reply', interestedSupported: true })).toThrow(/has no sentAt/);
  });
});
```

2. `app/test/listingSendsApi.test.ts` - KNOWING rewrites (findings C1; never
   deletions), each by its current line:

   - `:64-84` ('enriches each recipient ...'): keep, and add after `:83`:
     `expect(ghostRow).toMatchObject({ recipientMissing: true, outcome: 'no_reply', interestedSupported: false, eligible: false });`
     and `expect(ghostRow).not.toHaveProperty('tour');`. Title becomes
     `'enriches each recipient with the tenant display name; a missing contact serves as recipientMissing'`.
   - `:146-168` (parity): replace `:165` with
     `expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant', interestedMode: 'form', eligible: true });`
     and add `expect(byContact.body.sent[0]).toMatchObject({ outcome: 'no_reply', interestedSupported: true });`,
     `expect(byContact.body.sent[0]).not.toHaveProperty('interestedMode');`,
     `expect(byContact.body.sent[0]).not.toHaveProperty('eligible');`.
     The describe title becomes `'the two directions share row fields; units adds recipient facts, interestedMode and eligible'`.
   - `:200` (D7): the expected array element gains
     `outcome: 'no_reply', interestedSupported: true`.
   - `:205-231`: add `seedTenant(world, 'c-1'); seedTenant(world, 'c-2');`
     after `seedUnit` (`:207`) - under D12 a tour is read only for a RESOLVED
     tenant; with no contact row the row would now be `recipientMissing`. The
     `toEqual` at `:228` becomes
     `expect(c1).toEqual({ contactId: 'c-1', unitId: 'unit-1', sentAt: c1.sentAt, via: 'broadcast', tour: { tourId: 'tour-c1', state: 'scheduled' }, type: 'tenant', outcome: 'interested', interestedSupported: true, interestedMode: 'form', eligible: true });`
     (the `tour` stays EXACTLY `{ tourId, state }` - the A4 pin).
   - `:233-268`: add `seedTenant(world, 'c-a'); seedTenant(world, 'c-b');`
     after `:236` (same reason); assertions unchanged.
   - `:298-317` becomes:

```ts
  it('D12: a tours-query failure is a 503 outcome_unavailable - no guessed outcome (recipients)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect(capture.atLevel(40).some((l) => l['msg'] === 'recipients outcome join failed - 503 outcome_unavailable')).toBe(true);
  });
```

   - `:319-339` becomes the same shape for `GET /api/contacts/c-1/listings-sent`
     with `world.toursRepo.listByTenant` throwing, title
     `'D12: a tours-query failure is a 503 outcome_unavailable (listings-sent)'`,
     expecting `503`, `{ error: 'outcome_unavailable' }` and the log message
     `'listings-sent outcome join failed - 503 outcome_unavailable'`.
   - `:342-361` (the PATCH-404 pin) - UNCHANGED; it must stay green (the new
     route is `POST .../recipients/:contactId/outcome`).
   - `:379-425` (caseworkers D20): add after the c-gone assertions (`:415-416`):
     `expect(byId.get('c-gone')).toMatchObject({ recipientMissing: true, interestedSupported: false });`,
     `expect(byId.get('c-pt01')).toMatchObject({ interestedSupported: false });`,
     `expect(byId.get('c-ten1')).toMatchObject({ interestedSupported: true });`
     and after the contact-side assertions (`:423-424`):
     `expect(contactSide.body.sent[0]).toMatchObject({ interestedSupported: false });`.
   - `:427-447` becomes:

```ts
  it('D12: a failed or incomplete display batch is a 503 outcome_unavailable, never nameless guessed rows', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-ten2');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-ten2', sentAt: SENT_AT });
    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new Error('dynamo down');
    };
    const failed = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'outcome_unavailable' });

    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new IncompleteBatchReadError(1, 1);
    };
    const incomplete = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(incomplete.status).toBe(503);
  });
```

   (add `IncompleteBatchReadError` to the `contactsRepo.js` import at `:9`,
   and `vi` to the vitest import at `:7`.)

   New cases, a new describe at the end of the file:

```ts
describe('last-heard-from: the outcome on both GET projections (spec 5.4, D12)', () => {
  const get = (app: ReturnType<typeof makeWebhookHarness>['app'], path: string) =>
    request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('the contacts join is read with requireComplete: true', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    const spy = vi.spyOn(world.contactsRepo, 'getRecipientDisplaysByIds');
    await get(app, '/api/units/unit-1/recipients');
    expect(spy).toHaveBeenCalledWith(['c-1'], { requireComplete: true });
  });

  it('replied when the tenant was heard from after the send; lastHeardFromAt rides the row', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const t = seedTenant(world, 'c-1');
    t.last_heard_from_at = '2026-06-17T09:00:00.000Z';
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    const units = await get(app, '/api/units/unit-1/recipients');
    expect(units.body.recipients[0]).toMatchObject({ outcome: 'replied', lastHeardFromAt: '2026-06-17T09:00:00.000Z' });
    const contact = await get(app, '/api/contacts/c-1/listings-sent');
    expect(contact.body.sent[0]).toMatchObject({ outcome: 'replied', lastHeardFromAt: '2026-06-17T09:00:00.000Z' });
  });

  it('an effective decline reads not_interested with { at, by } (no staffId); a later share supersedes it', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-17T10:00:00.000Z', by: 'staff', staffId: 'usr_x' });
    const declined = await get(app, '/api/units/unit-1/recipients');
    expect(declined.body.recipients[0]).toMatchObject({ outcome: 'not_interested', declined: { at: '2026-06-17T10:00:00.000Z', by: 'staff' } });
    expect(declined.body.recipients[0].declined).not.toHaveProperty('staffId');
    const contactSide = await get(app, '/api/contacts/c-1/listings-sent');
    expect(contactSide.body.sent[0]).toMatchObject({ outcome: 'not_interested' });

    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: '2026-06-18T10:00:00.000Z', broadcastId: 'b-2' });
    const superseded = await get(app, '/api/units/unit-1/recipients');
    expect(superseded.body.recipients[0]).toMatchObject({ outcome: 'no_reply' });
    expect(superseded.body.recipients[0]).not.toHaveProperty('declined');
  });

  it('a tour created after the decline supersedes it -> interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-17T10:00:00.000Z', by: 'staff' });
    await world.toursRepo.create({ tourId: 't-late', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T10:00:00.000Z' });
    const res = await get(app, '/api/units/unit-1/recipients');
    expect(res.body.recipients[0]).toMatchObject({ outcome: 'interested', tour: { tourId: 't-late', state: 'scheduled' } });
  });

  it('eligible follows isEligibleRecipient (inactive tenant, opted out); interestedMode follows the unit tour_type', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1').tour_type = 'landlord_led';
    seedTenant(world, 'c-ok');
    seedTenant(world, 'c-inactive').status = 'inactive';
    seedTenant(world, 'c-stop').sms_opt_out = true;
    for (const contactId of ['c-ok', 'c-inactive', 'c-stop']) {
      await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
    }
    const res = await get(app, '/api/units/unit-1/recipients');
    const byId = new Map((res.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]));
    expect(byId.get('c-ok')).toMatchObject({ eligible: true, interestedMode: 'route' });
    expect(byId.get('c-inactive')).toMatchObject({ eligible: false, interestedMode: 'route' });
    expect(byId.get('c-stop')).toMatchObject({ eligible: false });
  });

  it('a PARTNER row is served WITHOUT tour even when tour data exists (B11), interestedSupported false', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    world.contacts.push({ contactId: 'c-pt', type: 'partner', status: 'active', phone: '+15550109009', role: 'Caseworker' });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-pt', sentAt: SENT_AT });
    // A converted caseworker's tenant-era tour (the tours API accepts any contactId).
    await world.toursRepo.create({ tourId: 't-old', tenantId: 'c-pt', unitId: 'unit-1', tourType: 'self_guided', status: 'toured' });
    const units = await get(app, '/api/units/unit-1/recipients');
    expect(units.body.recipients[0]).not.toHaveProperty('tour');
    expect(units.body.recipients[0]).toMatchObject({ outcome: 'no_reply', interestedSupported: false, type: 'partner' });

    const listByTenant = vi.spyOn(world.toursRepo, 'listByTenant');
    const contact = await get(app, '/api/contacts/c-pt/listings-sent');
    expect(contact.status).toBe(200);
    expect(contact.body.sent[0]).not.toHaveProperty('tour');
    expect(contact.body.sent[0]).toMatchObject({ outcome: 'no_reply', interestedSupported: false });
    // A partner page never reads tours at all.
    expect(listByTenant).not.toHaveBeenCalled();
  });

  it('a missing contact with an unsuperseded decline reads not_interested, still recipientMissing and not eligible', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-gone', sentAt: SENT_AT });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-gone', { at: '2026-06-17T10:00:00.000Z', by: 'staff' });
    const res = await get(app, '/api/units/unit-1/recipients');
    expect(res.body.recipients[0]).toMatchObject({
      contactId: 'c-gone',
      outcome: 'not_interested',
      recipientMissing: true,
      eligible: false,
      interestedSupported: false,
    });
    expect(res.body.recipients[0]).not.toHaveProperty('tenantName');
  });
});
```

RED today: `toListingSendRow` is positional (the options-object call fails to
typecheck and the fields are absent); the GET routes still degrade to 200.

GREEN:

- `app/src/repos/listingSendsRepo.ts` - `ListingSendRow` (`:106-123`): add
  after `role?: string;` (`:122`):

```ts
  /** last-heard-from spec 5.4 - the recipient's own last_heard_from_at. */
  lastHeardFromAt?: string;
  /** The derived send outcome (lib/listingSendOutcome.ts). */
  outcome: ListingSendOutcome;
  /** Present ONLY while the stored decline is effective; never staffId. */
  declined?: { at: string; by: 'staff' | 'engine' };
  /** false on a non-tenant or missing recipient (partners never read a tour). */
  interestedSupported: boolean;
  /** Units route only (the unit is known): 'route' with a structured tour_type. */
  interestedMode?: InterestedMode;
  /** Units route only: isEligibleRecipient on the recipient. */
  eligible?: boolean;
  /** true when the contact row is gone (a hard-deleted contact behind a listed row). */
  recipientMissing?: boolean;
```

  and change the doc of `tour?` (`:116`) to: `/** TENANT rows only - never on a partner or missing recipient's row (spec 14.3 B11). */`.

- Replace `toListingSendRow` (`:173-201`) with:

```ts
/** The options a GET projection (or the outcome route) passes to toListingSendRow. */
export interface ListingSendRowOptions {
  tour?: TourSignal;
  tenantName?: string;
  facts?: ListingSendRecipientFacts;
  outcome: ListingSendOutcome;
  lastHeardFromAt?: string;
  declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean;
  interestedMode?: InterestedMode;
  eligible?: boolean;
  recipientMissing?: boolean;
}

/**
 * Pure serializer to the C4 wire shape. Drops the audit furniture and the
 * STORED decline (a caller passes `declined` only while it is effective -
 * wireDecline); includes broadcastId only when present; every optional field
 * only when supplied (absent, never null). `recipientMissing` only when true.
 */
export function toListingSendRow(item: ListingSendItem, opts: ListingSendRowOptions): ListingSendRow {
  // share-sent-outcome D7: only a counted row is projected (the readers filter
  // the rest), and a counted row always carries sentAt - the guard documents it.
  if (item.sentAt === undefined) {
    throw new Error(`toListingSendRow: listing-send ${item.unitId}|${item.contactId} has no sentAt (an un-counted row is never projected)`);
  }
  return {
    contactId: item.contactId,
    ...(opts.tenantName !== undefined && { tenantName: opts.tenantName }),
    unitId: item.unitId,
    sentAt: item.sentAt,
    via: item.via,
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
    ...(opts.tour !== undefined && { tour: opts.tour }),
    ...(opts.facts?.type !== undefined && { type: opts.facts.type }),
    ...(opts.facts?.role !== undefined && { role: opts.facts.role }),
    ...(opts.lastHeardFromAt !== undefined && { lastHeardFromAt: opts.lastHeardFromAt }),
    outcome: opts.outcome,
    ...(opts.declined !== undefined && { declined: { at: opts.declined.at, by: opts.declined.by } }),
    interestedSupported: opts.interestedSupported,
    ...(opts.interestedMode !== undefined && { interestedMode: opts.interestedMode }),
    ...(opts.eligible !== undefined && { eligible: opts.eligible }),
    ...(opts.recipientMissing === true && { recipientMissing: true }),
  };
}
```

  (`ListingSendRowOptions` is the head contract's inline options type, named.)

- `app/src/routes/units.ts` imports: `:71-76` gains `type ListingSendItem,
  type ListingSendRow`; `:78` gains `type TourType`; `:79` becomes
  `import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';`;
  add after `:84`:

```ts
import {
  deriveListingSendOutcome,
  effectiveDecline,
  interestedModeFor,
  isEligibleRecipient,
  wireDecline,
  type DeclineRecord,
} from '../lib/listingSendOutcome.js';
import { recordListingOutcomeEvent } from '../lib/listingOutcomeEvents.js';
import { formatAddress } from '../lib/address.js';
import { ledgerRowCounted } from '../services/shareLedger.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
```

  Add each name in the task that first uses it, so no commit carries an
  unused import: THIS task adds `type ListingSendItem, type ListingSendRow`
  (`:71-76`), `deriveTourActivityAt` (`:79`) and, from the block above,
  `deriveListingSendOutcome`, `interestedModeFor`, `isEligibleRecipient`,
  `wireDecline`. Task 3.7 adds `type TourType` (`:78`), `effectiveDecline`,
  `type DeclineRecord`, `recordListingOutcomeEvent`, `formatAddress`,
  `ledgerRowCounted`, `createActivityEventsRepo, type ActivityEventsRepo` and
  `requireTenantContact` (`:83`).

- `UnitsRouterDeps` `:102-106` - replace the `toursRepo` doc with:
  `/** listing-response-tour-chip + last-heard-from D12: GET /:id/recipients and
  the outcome route read the unit's tours (byUnit GSI) - a REQUIRED join: a
  query failure is a 503 outcome_unavailable, never a guessed outcome. */`

- Add module-level helpers after `recipientFactsOf` (`:183-189`):

```ts
/** The joins every outcome-serving units read needs (last-heard-from D12):
 *  the unit's tours grouped by tenant, and the recipients' display projection
 *  read with requireComplete. Both REQUIRED. */
interface RecipientJoin {
  toursByTenant: Map<string, TourItem[]>;
  displays: Map<string, RecipientDisplay>;
}

/** Group a unit's tours strictly by the pairing's tenant. */
function groupToursByTenant(unitTours: TourItem[]): Map<string, TourItem[]> {
  const byTenant = new Map<string, TourItem[]>();
  for (const t of unitTours) {
    const arr = byTenant.get(t.tenantId);
    if (arr === undefined) byTenant.set(t.tenantId, [t]);
    else arr.push(t);
  }
  return byTenant;
}

/**
 * One "Sent to" row with its derived outcome (spec 5.4 / 5.5). A recipient
 * whose contact row is GONE is not an incomplete read (requireComplete only
 * throws on unread keys): it serves with the id as its name,
 * recipientMissing, no type (so no tour signal and no reply can be known),
 * interestedSupported false and eligible false. A non-tenant row reads no
 * tours and carries no `tour` (B11).
 */
function projectRecipientRow(row: ListingSendItem, unit: UnitItem, join: RecipientJoin): ListingSendRow {
  const interestedMode = interestedModeFor(unit);
  const contact = join.displays.get(row.contactId);
  if (contact === undefined) {
    const outcome = deriveListingSendOutcome({
      row,
      recipientType: undefined,
      lastHeardFromAt: undefined,
      tour: undefined,
      tourActivityAt: undefined,
    });
    const declined = wireDecline(row, outcome);
    return toListingSendRow(row, {
      outcome,
      ...(declined !== undefined && { declined }),
      interestedSupported: false,
      interestedMode,
      eligible: false,
      recipientMissing: true,
    });
  }
  const isTenant = contact.type === 'tenant';
  const pairTours = isTenant ? (join.toursByTenant.get(row.contactId) ?? []) : [];
  const tour = deriveTourSignal(pairTours);
  const outcome = deriveListingSendOutcome({
    row,
    recipientType: contact.type,
    lastHeardFromAt: contact.last_heard_from_at,
    tour,
    tourActivityAt: deriveTourActivityAt(pairTours),
  });
  const declined = wireDecline(row, outcome);
  const tenantName = displayNameOfContact(contact);
  return toListingSendRow(row, {
    ...(tour !== undefined && { tour }),
    ...(tenantName !== undefined && { tenantName }),
    facts: recipientFactsOf(contact),
    outcome,
    ...(contact.last_heard_from_at !== undefined && { lastHeardFromAt: contact.last_heard_from_at }),
    ...(declined !== undefined && { declined }),
    interestedSupported: isTenant,
    interestedMode,
    eligible: isEligibleRecipient(contact),
  });
}
```

- Replace the recipients route `:1071-1130` with:

```ts
  // GET /api/units/:unitId/recipients - the property's "Sent to" list (BE4/C4).
  // Returns { recipients: ListingSendRow[] } from listByUnit, each row with its
  // derived send outcome (last-heard-from spec 5.4). Mirrors the units 404
  // posture: an unknown unit is a 404; a real unit with zero recipients
  // returns []. D12: the tours join and the contacts join (read with
  // requireComplete) are REQUIRED - an outcome drives buttons and a to-do
  // list, so a failed join is a 503 outcome_unavailable, never a guessed row.
  router.get('/:unitId/recipients', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const rows = await listingSends.listByUnit(unitId);
    let join: RecipientJoin;
    try {
      // ONE byUnit GSI query and ONE BatchGet of the recipient projection for
      // the whole page (the batch de-dupes ids).
      const [unitTours, displays] = await Promise.all([
        tours.listByUnit(unitId),
        contacts.getRecipientDisplaysByIds(rows.map((row) => row.contactId), { requireComplete: true }),
      ]);
      join = { toursByTenant: groupToursByTenant(unitTours), displays };
    } catch (err) {
      log.warn({ err, unitId }, 'recipients outcome join failed - 503 outcome_unavailable');
      res.status(503).json({ error: 'outcome_unavailable' });
      return;
    }
    res.json({ recipients: rows.map((row) => projectRecipientRow(row, unit, join)) });
  });
```

  (`Promise.all` with an empty `rows` still calls the batch with `[]`, which
  `batchGetByIds` answers with an empty map and no request.)

- `app/src/routes/contacts.ts` imports: `:83-87` unchanged; `:89` becomes
  `import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';`
  and add after it:
  `import { deriveListingSendOutcome, wireDecline } from '../lib/listingSendOutcome.js';`.
  `ContactsRouterDeps.toursRepo` doc (`:130-134`) becomes: `/** listing-response-tour-chip
  + last-heard-from D12: GET /:id/listings-sent reads a TENANT's tours
  (byTenant GSI) - a REQUIRED join (503 outcome_unavailable on failure); a
  non-tenant page reads none. */`

- Replace the listings-sent route `:1214-1251` with:

```ts
  // GET /api/contacts/:contactId/listings-sent - the contact page's
  // "Properties sent" (BE4/C4). Returns { sent: ListingSendRow[] } via
  // listByContact (newest-first by sentAt), each row with its derived send
  // outcome (last-heard-from spec 5.4) from the contact's OWN type and
  // last_heard_from_at (the contact is already loaded - no contacts join). A
  // tenant's tours are ONE byTenant query grouped by unitId - REQUIRED (D12:
  // a failure is a 503 outcome_unavailable). A non-tenant reads no tours and
  // its rows carry no `tour` (B11). No units join: the page derives
  // interestedMode from the units it already loaded (spec 14.3 B2). A
  // phone-pointer id is a 404 - never a contact.
  router.get('/:contactId/listings-sent', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const rows = await listingSends.listByContact(contactId);
    const isTenant = contact.type === 'tenant';
    const toursByUnit = new Map<string, TourItem[]>();
    if (isTenant) {
      try {
        for (const t of await tours.listByTenant(contactId)) {
          const arr = toursByUnit.get(t.unitId);
          if (arr === undefined) toursByUnit.set(t.unitId, [t]);
          else arr.push(t);
        }
      } catch (err) {
        log.warn({ err, contactId }, 'listings-sent outcome join failed - 503 outcome_unavailable');
        res.status(503).json({ error: 'outcome_unavailable' });
        return;
      }
    }
    res.json({
      sent: rows.map((row) => {
        const pairTours = toursByUnit.get(row.unitId) ?? [];
        const tour = deriveTourSignal(pairTours);
        const outcome = deriveListingSendOutcome({
          row,
          recipientType: contact.type,
          lastHeardFromAt: contact.last_heard_from_at,
          tour,
          tourActivityAt: deriveTourActivityAt(pairTours),
        });
        const declined = wireDecline(row, outcome);
        return toListingSendRow(row, {
          ...(isTenant && tour !== undefined && { tour }),
          outcome,
          ...(contact.last_heard_from_at !== undefined && { lastHeardFromAt: contact.last_heard_from_at }),
          ...(declined !== undefined && { declined }),
          interestedSupported: isTenant,
        });
      }),
    });
  });
```

  (`contact.last_heard_from_at` is the `ContactItem` field task 1.1 added.)

Commit: `feat(app): send outcome on the units recipients and contact listings-sent reads`.

### Task 3.7 - the outcome route `POST /api/units/:unitId/recipients/:contactId/outcome`

RED - new `app/test/listingSendOutcomeApi.test.ts` (harness world fakes, the
`app/test/toursCreateContactType.test.ts:1-67` shape):

```ts
// POST /api/units/:unitId/recipients/:contactId/outcome (last-heard-from spec
// 5.4 as amended by 14.3) - every answer, in the route's order, and the
// writes behind each. Harness world fakes (no DynamoDB).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];
const SENT_AT = '2026-06-16T10:00:00.000Z';
const ADDRESS = '12 Oak St, Atlanta, GA';
const ACTOR = TEST_SESSION_USER.userId;

function seedUnit(world: FakeWorld, over: Partial<UnitItem> = {}): UnitItem {
  const unit: UnitItem = {
    unitId: 'unit-1',
    landlordId: 'contact-ll-1',
    status: 'available',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA' },
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...over,
  };
  world.units.set(unit.unitId, unit);
  return unit;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'tenant', status: 'searching', phone: '+15550100001', firstName: 'Tia', lastName: 'Moss', ...fields } as ContactItem);
}

async function seedSend(world: FakeWorld, contactId = 'c-1'): Promise<void> {
  await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
}

const post = (app: App, body: unknown, unitId = 'unit-1', contactId = 'c-1') =>
  request(app)
    .post(`/api/units/${unitId}/recipients/${contactId}/outcome`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body as object);

const stored = async (world: FakeWorld, contactId = 'c-1') => world.listingSendsRepo.getByKeyConsistent('unit-1', contactId);
const outcomeEvents = (world: FakeWorld) => world.activityEvents.filter((e) => String(e.type).startsWith('listing_'));

describe('outcome route - refusals in order', () => {
  it('404 unit_not_found for an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await post(app, { outcome: 'not_interested' }, 'nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });

  it.each(['interested', 'not_interested', 'clear'])('409 unit_deleted for %s on a soft-deleted property - nothing written', async (outcome) => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { deleted_at: '2026-10-01T00:00:00.000Z', tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unit_deleted' });
    expect((await stored(world))?.declined).toBeUndefined();
    expect(world.toursMap.size).toBe(0);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('404 send_not_found with no row, and for an UNCOUNTED row (ledgerRowCounted)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    expect((await post(app, { outcome: 'not_interested' })).body).toEqual({ error: 'send_not_found' });
    const failed = { attempt: '2026-06-16T10:00:00.000Z#SM1', conversationId: 'conv-1', state: 'failed' as const };
    await world.listingSendsRepo.putShareMemory('unit-1', 'c-1', { shares: { 'b-1': failed }, counted: false, sentAt: undefined, broadcastId: undefined }, { token: undefined });
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'send_not_found' });
    expect((await stored(world))?.declined).toBeUndefined();
  });

  it('the row check precedes the body check (a bad body on a missing row is 404)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    expect((await post(app, { outcome: 'maybe' })).status).toBe(404);
  });

  it.each([[{}], [{ outcome: 'maybe' }], [{ outcome: 'clear', extra: 1 }], [['clear']]])('400 invalid_outcome for %j', async (body) => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_outcome' });
  });

  it('503 outcome_unavailable (no saved) when the recipient read fails BEFORE any write', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new Error('dynamo down');
    };
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect((await stored(world))?.declined).toBeUndefined();
  });
});

describe('outcome route - not_interested and clear', () => {
  it('not_interested: stores { at, by: staff, staffId }, answers the re-projected row, writes both audit surfaces', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', outcome: 'not_interested', interestedSupported: true, interestedMode: 'form', eligible: true, tenantName: 'Tia Moss' });
    expect(res.body.row.declined).toEqual({ at: expect.any(String), by: 'staff' });
    const row = await stored(world);
    expect(row?.declined).toEqual({ at: res.body.row.declined.at, by: 'staff', staffId: ACTOR });
    expect(outcomeEvents(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', type: 'listing_declined', label: `Not interested in ${ADDRESS}`, refType: 'unit', refId: 'unit-1' }),
    ]);
    expect(world.auditEvents.filter((e) => e.event_type === 'listing_declined')).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_declined', actorId: ACTOR, payload: { contactId: 'c-1', actor: ACTOR } },
    ]);
  });

  it('not_interested is idempotent: a second call rewrites the record with a new at and records again', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const first = await post(app, { outcome: 'not_interested' });
    const second = await post(app, { outcome: 'not_interested' });
    expect(second.status).toBe(200);
    expect(second.body.row.declined.at >= first.body.row.declined.at).toBe(true);
    expect(outcomeEvents(world)).toHaveLength(2);
  });

  it('a PARTNER may be marked not interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-pt', { type: 'partner', status: 'active', role: 'Caseworker' });
    await seedSend(world, 'c-pt');
    const res = await post(app, { outcome: 'not_interested' }, 'unit-1', 'c-pt');
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'not_interested', interestedSupported: false });
  });

  it('clear after a decline: REMOVEs the record, writes listing_decline_cleared, answers the waiting outcome', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await post(app, { outcome: 'not_interested' });
    const res = await post(app, { outcome: 'clear' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'no_reply' });
    expect(res.body.row).not.toHaveProperty('declined');
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_declined', 'listing_decline_cleared']);
    expect(outcomeEvents(world)[1]).toMatchObject({ label: `Not interested cleared for ${ADDRESS}`, refType: 'unit', refId: 'unit-1' });
  });

  it('clear with no stored decline answers 200 and records NOTHING (contract change 2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'clear' });
    expect(res.status).toBe(200);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('a failed audit write never fails the route (best-effort)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    world.failAuditAppendFor.add('listing_declined');
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(200);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_declined unit audit failed (best-effort)')).toBe(true);
  });

  it('503 { saved: true } when the write landed but the re-projection read failed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    // not_interested reads no tours before its write; the re-projection does.
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable', saved: true });
    expect((await stored(world))?.declined).toMatchObject({ by: 'staff' });
  });
});

describe('outcome route - interested', () => {
  it('400 interested_unsupported on a partner row and on a missing contact - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-pt', { type: 'partner', status: 'active' });
    await seedSend(world, 'c-pt');
    await seedSend(world, 'c-gone');
    for (const contactId of ['c-pt', 'c-gone']) {
      const res = await post(app, { outcome: 'interested' }, 'unit-1', contactId);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'interested_unsupported' });
    }
    expect(world.toursMap.size).toBe(0);
  });

  it('requireTenantContact (CONSISTENT) refuses a contact converted after the batch read: 409 contact_not_tenant', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1', { type: 'partner', status: 'active' });
    await seedSend(world);
    // The eventually consistent recipient read still says tenant.
    world.contactsRepo.getRecipientDisplaysByIds = async () => new Map([['c-1', { contactId: 'c-1', type: 'tenant' as const, phone: '+15550100001' }]]);
    const getById = vi.spyOn(world.contactsRepo, 'getById');
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'partner' });
    expect(getById).toHaveBeenCalledWith('c-1', { consistentRead: true });
    expect(world.toursMap.size).toBe(0);
  });

  it('404 tenant_not_found when the contact row is gone behind a stale tenant read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    await seedSend(world);
    world.contactsRepo.getRecipientDisplaysByIds = async () => new Map([['c-1', { contactId: 'c-1', type: 'tenant' as const }]]);
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
  });

  it('an existing qualifying tour: no tour created, NO listing_interested event, the row reads interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world); // no tour_type: an existing tour needs none
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested', tour: { tourId: 't-1', state: 'scheduled' } });
    expect(world.toursMap.size).toBe(1);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('an existing tour behind an EFFECTIVE decline: the decline is cleared (event), no create', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_decline_cleared']);
    expect(world.toursMap.size).toBe(1);
  });

  it('a SUPERSEDED decline is left on the row (inert) - no clear, no event', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-18T00:00:00.000Z', by: 'staff' });
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'requested', createdAt: '2026-06-20T00:00:00.000Z' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect((await stored(world))?.declined).toMatchObject({ at: '2026-06-18T00:00:00.000Z' });
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('409 tour_type_required with no qualifying tour and no structured tour_type - nothing written, decline kept', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-x', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'canceled' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_type_required' });
    expect(world.toursMap.size).toBe(1);
    expect((await stored(world))?.declined).toBeDefined();
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('creates ONE requested tour with tourType = unit.tour_type and only then records listing_interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'landlord_led' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    const created = [...world.toursMap.values()];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: 'c-1', unitId: 'unit-1', tourType: 'landlord_led', status: 'requested' });
    expect(created[0]).not.toHaveProperty('scheduledAt');
    const tourId = created[0]!.tourId;
    expect(res.body.row).toMatchObject({ outcome: 'interested', tour: { tourId, state: 'requested' }, interestedMode: 'route' });
    expect(outcomeEvents(world)).toEqual([
      expect.objectContaining({ type: 'listing_interested', label: `Interested in ${ADDRESS} - tour requested`, refType: 'unit', refId: 'unit-1' }),
    ]);
    expect(world.auditEvents.filter((e) => e.event_type === 'listing_interested')).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_interested', actorId: ACTOR, payload: { contactId: 'c-1', actor: ACTOR, tourId } },
    ]);
  });

  it('a canceled tour is not "existing": interested creates a new one', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-x', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'canceled' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(world.toursMap.size).toBe(2);
  });

  it('an effective decline with no tour: clear (event) THEN create (event), in that order', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'pm_team' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_decline_cleared', 'listing_interested']);
    expect(await stored(world)).not.toHaveProperty('declined');
  });

  it('503 (no saved) when the pre-write tours read fails - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect(world.toursMap.size).toBe(0);
  });
});
```

RED today: the route does not exist (Express 404 for every case).

GREEN - `app/src/routes/units.ts`:

- `UnitsRouterDeps` (`:86-126`) gains, after `auditRepo` (`:89`):

```ts
  /** last-heard-from spec 5.4 / 14.3: the outcome route pins the contact
   *  timeline (lib/listingOutcomeEvents.ts). auditRepo, contactsRepo and
   *  toursRepo above already exist and serve the same route. */
  activityEventsRepo?: ActivityEventsRepo;
```

  and the constructor (`:344-356`) gains after `:347`:
  `const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });`

- `:83` becomes
  `import { requireLandlordContact, requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';`

- Module-level, after `projectRecipientRow` (task 3.6):

```ts
/** The outcome route's body: exactly { outcome } with one of the three values. */
function parseOutcomeBody(body: unknown): 'interested' | 'not_interested' | 'clear' | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'outcome') return undefined;
  const value = (body as Record<string, unknown>)['outcome'];
  return value === 'interested' || value === 'not_interested' || value === 'clear' ? value : undefined;
}
```

- The route, directly after the recipients GET (task 3.6):

```ts
  // POST /api/units/:unitId/recipients/:contactId/outcome - the ONE way a
  // send outcome changes (last-heard-from spec 5.4 as amended by 14.3).
  // Body { outcome: 'interested' | 'not_interested' | 'clear' }. Answers, in
  // this order: 404 unit_not_found; 409 unit_deleted (every outcome, B10);
  // 404 send_not_found (no COUNTED row - ledgerRowCounted, B5); 400
  // invalid_outcome; 503 outcome_unavailable when a required read fails
  // BEFORE any write; interested only: 400 interested_unsupported (not a
  // tenant on the recipient projection), 404 tenant_not_found / 409
  // contact_not_tenant (requireTenantContact - the same CONSISTENT I2 guard
  // POST /api/tours runs), 409 tour_type_required (no qualifying tour and no
  // structured tour_type - the dashboard opens the form instead, D14); then
  // 200 { row } re-projected, or 503 { error: 'outcome_unavailable', saved:
  // true } when the write landed but the re-read failed. Audit events are
  // best-effort (lib/listingOutcomeEvents.ts). A concurrent double click can
  // still race two creates (no conditional write on the pair - I3; the
  // dashboard disables the button in flight). PII: ids only in logs.
  router.post('/:unitId/recipients/:contactId/outcome', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    if (isDeleted(unit)) {
      res.status(409).json({ error: 'unit_deleted' });
      return;
    }
    const row = await listingSends.getByKeyConsistent(unitId, contactId);
    if (row === undefined || !ledgerRowCounted(row)) {
      res.status(404).json({ error: 'send_not_found' });
      return;
    }
    const outcome = parseOutcomeBody(req.body);
    if (outcome === undefined) {
      res.status(400).json({ error: 'invalid_outcome' });
      return;
    }

    // The recipient projection (requireComplete): the type for the
    // interested check AND the name / type / reachability for the
    // re-projection. A failure here has written nothing.
    let recipient: RecipientDisplay | undefined;
    try {
      recipient = (await contacts.getRecipientDisplaysByIds([contactId], { requireComplete: true })).get(contactId);
    } catch (err) {
      log.warn({ err, unitId, contactId }, 'outcome: recipient read failed - nothing written');
      res.status(503).json({ error: 'outcome_unavailable' });
      return;
    }

    const actor = req.user?.userId;
    const at = new Date().toISOString();
    const address = formatAddress(unit.address) || unitId;
    const eventDeps = { activityEvents, audit, logger: log };
    let createdTour: TourItem | undefined;

    if (outcome === 'interested') {
      if (recipient?.type !== 'tenant') {
        res.status(400).json({ error: 'interested_unsupported' });
        return;
      }
      try {
        await requireTenantContact(contacts, contactId);
      } catch (err) {
        if (sendContactTypeError(err, res)) return;
        throw err;
      }
      let pairTours: TourItem[];
      try {
        pairTours = (await tours.listByUnit(unitId)).filter((t) => t.tenantId === contactId);
      } catch (err) {
        log.warn({ err, unitId, contactId }, 'outcome: tours read failed - nothing written');
        res.status(503).json({ error: 'outcome_unavailable' });
        return;
      }
      // (1) ANY qualifying tour (the chip's set) means no tour is created.
      const existing = deriveTourSignal(pairTours) !== undefined;
      // (2) interestedModeFor's rule: no structured tour_type -> the form path.
      const tourType: TourType | undefined = unit.tour_type;
      if (!existing && tourType === undefined) {
        res.status(409).json({ error: 'tour_type_required' });
        return;
      }
      // (3) An EFFECTIVE decline is removed; its event is its history.
      if (effectiveDecline(row, deriveTourActivityAt(pairTours))) {
        if ((await listingSends.clearDeclined(unitId, contactId)) === 'not_found') {
          res.status(404).json({ error: 'send_not_found' });
          return;
        }
        await recordListingOutcomeEvent(eventDeps, {
          type: 'listing_decline_cleared',
          contactId,
          unitId,
          label: `Not interested cleared for ${address}`,
          ...(actor !== undefined && { actor }),
          at,
        });
      }
      // (4) Create, and ONLY then record listing_interested (a click that
      // found an existing tour writes no event; a retry is not re-recorded).
      if (!existing && tourType !== undefined) {
        createdTour = await tours.create({ tenantId: contactId, unitId, tourType, status: 'requested' });
        await recordListingOutcomeEvent(eventDeps, {
          type: 'listing_interested',
          contactId,
          unitId,
          label: `Interested in ${address} - tour requested`,
          ...(actor !== undefined && { actor }),
          tourId: createdTour.tourId,
          at,
        });
      }
    } else if (outcome === 'not_interested') {
      const record: DeclineRecord = { at, by: 'staff', ...(actor !== undefined && { staffId: actor }) };
      if ((await listingSends.setDeclined(unitId, contactId, record)) === 'not_found') {
        res.status(404).json({ error: 'send_not_found' });
        return;
      }
      await recordListingOutcomeEvent(eventDeps, {
        type: 'listing_declined',
        contactId,
        unitId,
        label: `Not interested in ${address}`,
        ...(actor !== undefined && { actor }),
        at,
      });
    } else {
      const hadDecline = row.declined !== undefined;
      if ((await listingSends.clearDeclined(unitId, contactId)) === 'not_found') {
        res.status(404).json({ error: 'send_not_found' });
        return;
      }
      // A clear that found no decline records nothing (contract change 2).
      if (hadDecline) {
        await recordListingOutcomeEvent(eventDeps, {
          type: 'listing_decline_cleared',
          contactId,
          unitId,
          label: `Not interested cleared for ${address}`,
          ...(actor !== undefined && { actor }),
          at,
        });
      }
    }

    // (5) Re-project (D12: the joins are required). The row is re-read
    // CONSISTENTLY; the byUnit GSI may not yet show a tour created a moment
    // ago, so the created item joins the read.
    let after: ListingSendItem | undefined;
    let unitTours: TourItem[];
    try {
      [after, unitTours] = await Promise.all([
        listingSends.getByKeyConsistent(unitId, contactId),
        tours.listByUnit(unitId),
      ]);
    } catch (err) {
      log.warn({ err, unitId, contactId }, 'outcome: re-projection read failed after the write - 503 saved');
      res.status(503).json({ error: 'outcome_unavailable', saved: true });
      return;
    }
    if (after === undefined || !ledgerRowCounted(after)) {
      res.status(503).json({ error: 'outcome_unavailable', saved: true });
      return;
    }
    const created = createdTour;
    const joinedTours = created === undefined ? unitTours : [...unitTours.filter((t) => t.tourId !== created.tourId), created];
    const join: RecipientJoin = {
      toursByTenant: groupToursByTenant(joinedTours),
      displays: recipient !== undefined ? new Map([[contactId, recipient]]) : new Map(),
    };
    log.info({ unitId, contactId, outcome, tourCreated: created !== undefined }, 'listing send outcome recorded');
    res.json({ row: projectRecipientRow(after, unit, join) });
  });
```

- `app/src/routes/api.ts` - the units mount (`:958-981`) gains, after
  `toursRepo: tours,` (`:967`):

```ts
      // last-heard-from spec 5.4: the outcome route pins the contact timeline
      // (the shared activity-events repo built above, :600).
      activityEventsRepo: activityEvents,
```

  (`activityEvents` is constructed at `api.ts:600`; `audit` is already passed
  at `:961`, `toursRepo` at `:967`, and the contacts repo at `:963` - the
  harness injects all of them through `makeWebhookHarness`,
  `twilioWebhookHarness.ts:5434-5446`.)

Commit: `feat(app): POST /api/units/:unitId/recipients/:contactId/outcome`.

### Task 3.8 - dashboard wire mirror, `setListingSendOutcome`, the 503 `saved` reading

RED:

1. `dashboard/src/api/endpoints.test.ts` - add `setListingSendOutcome` to the
   import list and:

```ts
it('setListingSendOutcome POSTs the outcome and returns the { row } body as-is (head 3.4 #4)', async () => {
  vi.mocked(request).mockResolvedValueOnce({ row: { contactId: 'c 1', unitId: 'u1', outcome: 'not_interested' } });
  const res = await setListingSendOutcome('u1', 'c 1', 'not_interested');
  expect(request).toHaveBeenCalledWith('/api/units/u1/recipients/c%201/outcome', {
    method: 'POST',
    body: { outcome: 'not_interested' },
  });
  expect(res).toEqual({ row: { contactId: 'c 1', unitId: 'u1', outcome: 'not_interested' } });
});
```

2. New `dashboard/src/lib/listingOutcomeErrors.test.ts` (kept out of
   `endpoints.ts` on purpose: `endpoints.test.ts:5-8` mocks `./client.js`
   WITHOUT `ApiError`, so an `instanceof ApiError` inside `endpoints.ts` would
   throw there - the `lib/contactTypeErrors.ts` precedent):

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/index.js';
import { isOutcomeSaved, outcomeErrorCopy, OUTCOME_SAVE_FAILED, OUTCOME_SAVED_RELOAD } from './listingOutcomeErrors.js';

describe('listingOutcomeErrors', () => {
  it('a 503 whose body says saved: true is a saved write', () => {
    const err = new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true });
    expect(isOutcomeSaved(err)).toBe(true);
    expect(outcomeErrorCopy(err)).toBe('Saved - reload to see the change.');
    expect(OUTCOME_SAVED_RELOAD).toBe('Saved - reload to see the change.');
  });
  it('anything else is a failed save', () => {
    expect(isOutcomeSaved(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable' }))).toBe(false);
    expect(isOutcomeSaved(new ApiError(500, 'boom', 'x', { saved: true }))).toBe(false);
    expect(isOutcomeSaved(new Error('network'))).toBe(false);
    expect(outcomeErrorCopy(new Error('network'))).toBe("Couldn't save - try again.");
    expect(OUTCOME_SAVE_FAILED).toBe("Couldn't save - try again.");
  });
});
```

RED today: neither export exists.

GREEN:

- `dashboard/src/api/types.ts` - after `TourSignal` (`:2951-2954`), add:

```ts
/** last-heard-from spec 5.4 - hand-mirrored from app/src/lib/listingSendOutcome.ts
 *  (independent types; the lockstep pin is each side's tsc plus the route tests). */
export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';
export type InterestedMode = 'route' | 'form';
```

  and in `ListingSendRow` (`:2955-2973`) after `role?: string;` (`:2972`):

```ts
  /** last-heard-from spec 5.4: the recipient's last inbound text/call/email. */
  lastHeardFromAt?: string;
  /** The derived send outcome; `interested` means `tour` is set. */
  outcome: ListingSendOutcome;
  /** Present only while the decline is effective; `engine` renders "(auto)". */
  declined?: { at: string; by: 'staff' | 'engine' };
  /** false on a non-tenant or missing recipient: no Interested action. */
  interestedSupported: boolean;
  /** Property "Sent to" rows only: 'route' = one click creates the tour. */
  interestedMode?: InterestedMode;
  /** Property "Sent to" rows only: the recipient can be texted (spec 5.5 grouping). */
  eligible?: boolean;
  /** The contact row is gone: no actions, the NOT ELIGIBLE group. */
  recipientMissing?: boolean;
```

  Also change the `tour?` doc (`:2964-2965`) to end with
  `Never on a partner row (the server omits it, spec 14.3 B11).`

- `dashboard/src/api/endpoints.ts` - after `getUnitRecipients` (`:1130-1142`):

```ts
/** POST /api/units/:unitId/recipients/:contactId/outcome (last-heard-from spec
 *  5.4) - record or clear a send outcome; answers `{ row }`, the re-projected
 *  row (the shape EVERY caller destructures - plan head 3.4 #4; the Follow up
 *  view in S7 uses it too). A 503 whose body carries `saved: true` means the
 *  write landed but the re-read failed (lib/listingOutcomeErrors.ts reads it). */
export async function setListingSendOutcome(
  unitId: string,
  contactId: string,
  outcome: 'interested' | 'not_interested' | 'clear',
): Promise<{ row: ListingSendRow }> {
  return request<{ row: ListingSendRow }>(
    `/api/units/${encodeURIComponent(unitId)}/recipients/${encodeURIComponent(contactId)}/outcome`,
    { method: 'POST', body: { outcome } },
  );
}
```

- New `dashboard/src/lib/listingOutcomeErrors.ts`:

```ts
// The send-outcome action's failure copy (last-heard-from spec 5.5): a failed
// call leaves the row unchanged with an inline error; a 503 carrying
// `saved: true` means the write landed but the server could not re-read the
// row, so the row says so instead of claiming nothing changed.
import { ApiError } from '../api/index.js';

export const OUTCOME_SAVE_FAILED = "Couldn't save - try again.";
export const OUTCOME_SAVED_RELOAD = 'Saved - reload to see the change.';

/** True for the outcome route's 503 { error: 'outcome_unavailable', saved: true }. */
export function isOutcomeSaved(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 503) return false;
  const body = err.body;
  return body !== null && typeof body === 'object' && (body as Record<string, unknown>)['saved'] === true;
}

/** The inline row error for a failed outcome action. */
export function outcomeErrorCopy(err: unknown): string {
  return isOutcomeSaved(err) ? OUTCOME_SAVED_RELOAD : OUTCOME_SAVE_FAILED;
}
```

- Typed dashboard fixtures that the now-required `outcome` /
  `interestedSupported` break (dashboard typecheck covers tests,
  `dashboard/tsconfig.json:12`) - `dashboard/src/routes/contact/files.test.tsx`
  rows passed through the `ListingSendRow[]`-typed helpers: `:169` (add
  `outcome: 'no_reply', interestedSupported: true`), the `tour-77` row at
  `:187-193` and the three rows at `:212-214` (rows with a `tour`:
  `outcome: 'interested', interestedSupported: true`), the `send()` builders
  at `:235-240` and `:254-259` (`outcome: 'no_reply', interestedSupported:
  true`), and the partner rows at `:712-713` (`outcome: 'no_reply',
  interestedSupported: false`; the `tour` on `:712` stays - it pins the
  client-side drop). No assertion changes. Untyped
  `vi.fn()` mocks (`ListingDetail.test.tsx`, `ContactDetail.test.tsx`) are
  rewritten in S5 where their assertions change.

Commit: `feat(dashboard): ListingSendRow outcome fields and setListingSendOutcome`.

---

<!-- W4 notes -->
## Contract notes for the orchestrator (read before S4 and S8)

### N1 - clarifications of section 3.3 (no contract change, stated so builders agree)

- `formatHeardFrom` returns `{ label: 'Never', title: '' }` for absent or
  unparseable input. An EMPTY `title` means "render no title attribute";
  every consumer (S4, S5, S6, S7) spreads `title` only when it is non-empty.
- `daysSince(iso, now)` is `Math.floor((now - instant) / 86400000)` CLAMPED at
  0 (a future instant from clock skew reads 0, never "-1 days"); an
  unparseable `iso` also reads 0.
- `compareByName` uses `localeCompare(b, 'en', { sensitivity: 'accent' })`
  (case-insensitive, accent-sensitive) on trimmed last name, then trimmed
  first name, then `formatPhoneDisplay(phone)`, then a byte compare of
  `contactId`. An absent last name is `''`, which sorts first.
- `heardFrom.ts` additionally exports the types `NameLike` and
  `HeardFromLabel` (additive).
- `tenantFacets.ts` additionally exports `ALL_STATUS_SET`, `STATUS_EMPTY_KEY`,
  `type TenantSort`, `parseSort` and `hiddenByStatusOnly` (additive).
  `TenantFilters` gains two OPTIONAL props, `sort?` and `onSortChange?`.
- "The three literals updated" undercounts: making `TenantSelection.status`
  required breaks EVERY `TenantSelection` object literal at typecheck -
  `ContactsList.tsx:100-104`; `TenantFilters.test.tsx:12-16, :148, :162,
  :167-171`; `tenantFacets.test.ts:33-37, :154, :174, :232, :235, :246, :254,
  :260, :285-289, :305-309, :346, :369`. Task 4.2 updates all of them (each
  gains the UNCONSTRAINED `status` - all seven - so no existing assertion
  changes meaning).

### N2 - CONTRACT ADDITION REQUESTED: the selectors S8 drives (S5, S6, S7 must render these)

The plan head fixes copy but not markup. S8's locators need the following;
each is the natural markup for its slice, so this is an addition, not a
change. Reconcile with the S5/S6/S7 writers before building.

| id | slice | requirement | the S8 locator it enables |
|---|---|---|---|
| R1 | S5 | every `SendRosterRow` root is an `<li>`; a card's rows sit in `<ul>` elements (one per group is fine); nothing else inside the card is a listitem | `card.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) })` - today's `card.locator('div').filter({ has: link })` (`listing-activity.spec.ts:224-225`) becomes a strict-mode violation the moment the row grows nested divs |
| R2 | S5 | the outcome chip is visible text, exactly `No reply yet` / `Replied` / `Not interested` / `Not interested (auto)`; interested = the existing TourChip LINK (`Tour requested` / `Tour scheduled` / `Toured`) | `row.getByText('No reply yet', { exact: true })`, `row.getByRole('link', { name: 'Tour scheduled' })` |
| R3 | S5, S7 | action buttons carry the plan's aria names (`Mark <name> interested in <address>`, `Mark <name> not interested in <address>`, `Undo not interested for <name>`) on the property card, the contact card AND the Follow up rows | `row.getByRole('button', { name: /^Mark <name> interested in <line1>/ })` |
| R4 | S5 | `interestedMode: 'form'` on the property page navigates to `?tour=new&tenantId=<id>`, opens the `Schedule a tour` dialog with the tenant LOCKED (`role="group"` named `Tenant`), creates nothing, and Cancel clears both params | `dialog.getByRole('group', { name: 'Tenant' })` |
| P1 | S6 | the column header cells are visible text exactly `Name`, `Status`, `Housing authority`, `Last heard from`, rendered OUTSIDE (before) `<ul aria-label="Candidate recipients">`; a row's last-heard cell shows only the label (`Today 2:14 PM`, `Never`) | `page.getByText('Housing authority', { exact: true })` visible AND `list.getByText('Housing authority', { exact: true })` count 0 |
| P2 | S6 | tags are visible text exactly `Not interested`, `Already sent`, `Added`; the "Add a tenant" option's accessible name contains the full name, with the `annotate` suffix as text inside the option | `row.getByText('Not interested', { exact: true })`; `option` `toContainText('Not interested')` |
| F1 | S7 | the Follow up tab is `role="tab"` whose text is `Follow up` followed by the count (e.g. a badge `2`); `aria-selected="true"` while active; `/broadcasts?tab=follow-up` opens it; clicking it writes `?tab=follow-up` | `page.getByRole('tab', { name: /^Follow up\b/ })`, `toHaveText(/^Follow up\s*2$/)` |
| F2 | S7 | each property group is a `<section aria-labelledby={headingId}>` whose heading text STARTS with `unitLabel` and contains `<n> waiting`; its rows are `<li>`s; each row's name is a link to `/contacts/:id` named by the full name | `page.getByRole('region', { name: new RegExp('^' + line1) })`, `group.getByRole('listitem')` |
| F3 | S7 | the row chip is visible text exactly `No reply yet, N days` / `Replied, quiet N days`; the empty state is exactly `Nothing waiting on a reply.` | `row.getByText('No reply yet, 2 days', { exact: true })` |
| F4 | S7 | the Properties pill is visible text `<n> waiting` inside the row link, on available rows only | `propRow` `toContainText('2 waiting')` |

---


## S4 - shared dashboard helpers, the Tenants tab, and the contact header

Precondition: S1 Task 1.14 is committed - `dashboard/src/api/types.ts`
`Contact` declares `last_heard_from_at?: string` (without it the index
signature at `types.ts:2278` types it `unknown` and every S4 typecheck fails,
which is the guard). Runs: `cd "W:/tmp/last-heard-from/dashboard"; npx vitest
run <file>`; typecheck `cd "W:/tmp/last-heard-from"; npm run typecheck`.

### Task 4.1 - `dashboard/src/lib/heardFrom.ts` + `heardFrom.test.ts`

RED - new `dashboard/src/lib/heardFrom.test.ts` (mirror
`dashboard/src/routes/inbox/inboxTime.test.ts:1-7`: every instant built with
the LOCAL-time constructor, `const now = new Date(2026, 8, 25, 15, 30)`,
`const iso = (d: Date): string => d.toISOString()`). RED today: the module
does not exist (vitest: "Failed to resolve import './heardFrom.js'").

```ts
import { describe, expect, it } from 'vitest';
import { formatInboxTimeFull } from '../routes/inbox/inboxTime.js';
import { compareByName, daysSince, formatHeardFrom, sortByHeardFrom, type NameLike } from './heardFrom.js';

// LOCAL-time constructors so the tiers run in whatever zone the runner has
// (the inboxTime.test.ts convention).
const now = new Date(2026, 8, 25, 15, 30); // Sep 25 2026 15:30 local
const iso = (d: Date): string => d.toISOString();
const DAY = 86_400_000;

describe('formatHeardFrom', () => {
  it('today reads "Today <clock>" with the full stamp as the title', () => {
    const at = iso(new Date(2026, 8, 25, 14, 14));
    expect(formatHeardFrom(at, now)).toEqual({ label: 'Today 2:14 PM', title: formatInboxTimeFull(at) });
    expect(formatHeardFrom(iso(new Date(2026, 8, 25, 0, 5)), now).label).toBe('Today 12:05 AM');
  });
  it('a later instant today is still Today (a clock label, never a date)', () => {
    expect(formatHeardFrom(iso(new Date(2026, 8, 25, 23, 0)), now).label).toBe('Today 11:00 PM');
  });
  it('earlier days follow the inbox tiers: Yesterday, Mon D, Mon D, YYYY', () => {
    expect(formatHeardFrom(iso(new Date(2026, 8, 24, 9, 0)), now).label).toBe('Yesterday');
    expect(formatHeardFrom(iso(new Date(2026, 8, 12, 9, 0)), now).label).toBe('Sep 12');
    expect(formatHeardFrom(iso(new Date(2025, 8, 12, 9, 0)), now).label).toBe('Sep 12, 2025');
  });
  it('absent, empty and unparseable all read Never with no title', () => {
    expect(formatHeardFrom(undefined, now)).toEqual({ label: 'Never', title: '' });
    expect(formatHeardFrom('', now)).toEqual({ label: 'Never', title: '' });
    expect(formatHeardFrom('not-a-date', now)).toEqual({ label: 'Never', title: '' });
  });
  it('a <ISO>#<suffix> sort key reads like its ISO prefix', () => {
    const at = iso(new Date(2026, 8, 12, 9, 0));
    expect(formatHeardFrom(`${at}#msg-1`, now).label).toBe('Sep 12');
  });
});

describe('compareByName', () => {
  const n = (over: Partial<NameLike> & { contactId: string }): NameLike => over;
  it('orders by last name first', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Zed', lastName: 'Adams' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Brown' }))).toBeLessThan(0);
  });
  it('is case-insensitive and trims, then breaks the tie on first name', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Bea', lastName: ' adams' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Adams' }))).toBeGreaterThan(0);
  });
  it('an absent last name sorts first', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Cher' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Adams' }))).toBeLessThan(0);
  });
  it('then the formatted phone, then contactId as the stable key', () => {
    const base = { firstName: 'Amy', lastName: 'Adams' };
    expect(compareByName(n({ ...base, contactId: 'z', phone: '+14045550001' }), n({ ...base, contactId: 'a', phone: '+14045550002' }))).toBeLessThan(0);
    expect(compareByName(n({ ...base, contactId: 'a' }), n({ ...base, contactId: 'b' }))).toBeLessThan(0);
    expect(compareByName(n({ ...base, contactId: 'a' }), n({ ...base, contactId: 'a' }))).toBe(0);
  });
});

describe('sortByHeardFrom', () => {
  interface SnakeRow { contactId: string; firstName?: string; lastName?: string; last_heard_from_at?: string }
  const snake = (rows: SnakeRow[]): SnakeRow[] =>
    sortByHeardFrom(rows, { heardAt: (r) => r.last_heard_from_at, name: (r) => r });
  it('most recent first, absent and unparseable last, ties by the name comparator', () => {
    const rows: SnakeRow[] = [
      { contactId: 'never-b', lastName: 'Brown' },
      { contactId: 'old', lastName: 'Old', last_heard_from_at: '2026-09-01T12:00:00.000Z' },
      { contactId: 'bad', lastName: 'Aaron', last_heard_from_at: 'garbage' },
      { contactId: 'new', lastName: 'New', last_heard_from_at: '2026-09-20T12:00:00.000Z' },
      { contactId: 'tie-z', lastName: 'Zed', last_heard_from_at: '2026-09-10T12:00:00.000Z' },
      { contactId: 'tie-a', lastName: 'Abe', last_heard_from_at: '2026-09-10T12:00:00.000Z' },
    ];
    expect(snake(rows).map((r) => r.contactId)).toEqual(['new', 'tie-a', 'tie-z', 'old', 'bad', 'never-b']);
  });
  it('returns a NEW array and leaves the input order alone', () => {
    const rows: SnakeRow[] = [{ contactId: 'a' }, { contactId: 'b', last_heard_from_at: '2026-09-20T12:00:00.000Z' }];
    const out = snake(rows);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.contactId)).toEqual(['a', 'b']);
  });
  it('serves the camelCase wire rows through the same accessor contract', () => {
    const rows = [
      { contactId: 'x', name: 'X', lastHeardFromAt: undefined as string | undefined },
      { contactId: 'y', name: 'Y', lastHeardFromAt: '2026-09-20T12:00:00.000Z' },
    ];
    const out = sortByHeardFrom(rows, { heardAt: (r) => r.lastHeardFromAt, name: (r) => ({ contactId: r.contactId, firstName: r.name }) });
    expect(out.map((r) => r.contactId)).toEqual(['y', 'x']);
  });
});

describe('daysSince', () => {
  it('floors whole days on the given clock', () => {
    expect(daysSince(new Date(now.getTime() - 2 * DAY - 3_600_000).toISOString(), now)).toBe(2);
    expect(daysSince(new Date(now.getTime() - 3 * DAY).toISOString(), now)).toBe(3);
    expect(daysSince(new Date(now.getTime() - 23 * 3_600_000).toISOString(), now)).toBe(0);
  });
  it('a future instant and an unparseable value read 0', () => {
    expect(daysSince(new Date(now.getTime() + DAY).toISOString(), now)).toBe(0);
    expect(daysSince('garbage', now)).toBe(0);
  });
});
```

GREEN - new `dashboard/src/lib/heardFrom.ts`:

```ts
// heardFrom - the ONE "last heard from" vocabulary for the dashboard (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md
// sections 5.1, 5.3, 5.7 and 14.5 F7/F8/F10). Pure. The Tenants tab, the
// contact header, the roster cards, Review recipients and the Follow up tab
// all label and order through these four functions; the two row shapes
// (Contact's snake `last_heard_from_at`, the wire rows' camel
// `lastHeardFromAt`) share ONE comparator through accessor functions.
//
// The label is a thin wrapper over the inbox tiers (routes/inbox/inboxTime.ts,
// left unchanged - the inbox still shows a bare "2:14 PM"): today gains a
// "Today " prefix so "Last heard from 2:14 PM" never reads as a schedule.
import { formatInboxTime, formatInboxTimeFull } from '../routes/inbox/inboxTime.js';
import { formatPhoneDisplay } from './phone.js';
import { isoOf } from './time.js';

/** The fields the name order reads. `Contact` satisfies it structurally. */
export interface NameLike {
  firstName?: string;
  lastName?: string;
  phone?: string;
  contactId: string;
}

/** A rendered label plus its hover title. An EMPTY title = render no title. */
export interface HeardFromLabel {
  label: string;
  title: string;
}

const DAY_MS = 86_400_000;

/** Epoch ms of a parseable instant (a `<ISO>#<suffix>` key reads as its ISO),
 *  else undefined. Absent, empty and unparseable are all "never". */
function instantOf(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const ms = Date.parse(isoOf(iso));
  return Number.isNaN(ms) ? undefined : ms;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 2:14 PM" / "Yesterday" / "Sep 12" / "Sep 12, 2025", with the full
 *  stamp as the title; "Never" (no title) for an absent OR unparseable value. */
export function formatHeardFrom(iso: string | undefined, now: Date): HeardFromLabel {
  const ms = instantOf(iso);
  if (ms === undefined || iso === undefined) return { label: 'Never', title: '' };
  const tier = formatInboxTime(iso, now);
  if (tier === '') return { label: 'Never', title: '' };
  return {
    label: sameLocalDay(new Date(ms), now) ? `Today ${tier}` : tier,
    title: formatInboxTimeFull(iso),
  };
}

function cmpText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'accent' });
}

/** Last name, first name, formatted phone, then contactId as the stable key
 *  (spec 14.5 F10). Case-insensitive; an absent last name sorts first. */
export function compareByName(a: NameLike, b: NameLike): number {
  return (
    cmpText((a.lastName ?? '').trim(), (b.lastName ?? '').trim()) ||
    cmpText((a.firstName ?? '').trim(), (b.firstName ?? '').trim()) ||
    cmpText(formatPhoneDisplay(a.phone), formatPhoneDisplay(b.phone)) ||
    (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0)
  );
}

/** Most recent first; absent (or unparseable) last; ties by compareByName.
 *  Returns a NEW array - the input is never reordered. */
export function sortByHeardFrom<T>(
  rows: readonly T[],
  acc: { heardAt: (r: T) => string | undefined; name: (r: T) => NameLike },
): T[] {
  const keyed = rows.map((row) => ({ row, at: instantOf(acc.heardAt(row)) }));
  keyed.sort((x, y) => {
    if (x.at !== undefined && y.at !== undefined && x.at !== y.at) return y.at - x.at;
    if (x.at === undefined && y.at !== undefined) return 1;
    if (x.at !== undefined && y.at === undefined) return -1;
    return compareByName(acc.name(x.row), acc.name(y.row));
  });
  return keyed.map((k) => k.row);
}

/** Whole days since `iso` on the given clock: floor(ms / 86400000), clamped at
 *  0 (clock skew never reads "-1 days"); an unparseable value reads 0. */
export function daysSince(iso: string, now: Date): number {
  const ms = instantOf(iso);
  if (ms === undefined) return 0;
  return Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
}
```

(`lib/` importing a route module is new here; `routes/tours/tourTime.ts`
already shares `inboxTime`, and the contract names the wrapper. `formatPhoneDisplay`
is the lib twin of `routes/contact/format.ts:16`'s `formatPhone`, which only
delegates to it.)

Run: `npx vitest run src/lib/heardFrom.test.ts` green; ASCII check on both
new files (`tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0).

Commit: `feat(dashboard): heardFrom helpers - label, name order, heard-from sort, days since`
(+ the section 0 `Co-Authored-By` trailer, on this and every commit below).

### Task 4.2 - the status facet and the sort param in the facet engine (`tenantFacets.ts`)

RED - `dashboard/src/routes/contacts/tenantFacets.test.ts`:

1. Line 5: `import type { Contact } from '../../api/index.js';` becomes
   `import { TENANT_STATUSES, TENANT_STATUS_LABELS, type Contact, type TenantStatus } from '../../api/index.js';`.
   Add to the import list at `:7-19`: `ALL_STATUS_SET`, `applySortToParams`,
   `DEFAULT_STATUS_SET`, `hiddenByStatusOnly`, `parseSort`, `STATUS_EMPTY_KEY`.
2. After `:32` add `const ALL_SEVEN = (): Set<TenantStatus> => new Set<TenantStatus>(TENANT_STATUSES);`
   and give `emptySel()` (`:33-37`) a fourth member `status: ALL_SEVEN(),`.
   Every other `TenantSelection` literal in the file (`:154, :174, :232,
   :235, :246, :254, :260, :285-289, :305-309, :346, :369`) gains
   `status: ALL_SEVEN()` - the unconstrained value, so no existing assertion
   changes meaning.
3. Append:

```ts
describe('status facet (spec 2026-10-12 5.7, 14.5 F1/F9)', () => {
  const st = (status: string | undefined, over: Partial<Contact> = {}): Contact => t({ ...over, ...(status !== undefined && { status }) });
  const sel = (status: Iterable<TenantStatus>): TenantSelection => ({ ...emptySel(), status: new Set(status) });

  it('DEFAULT is every status except inactive and placed; ALL is the seven', () => {
    expect([...DEFAULT_STATUS_SET]).toEqual(['needs_review', 'onboarding', 'searching', 'placing', 'on_hold']);
    expect([...ALL_STATUS_SET]).toEqual([...TENANT_STATUSES]);
  });

  it('parses: absent and invalid-only -> default; _empty -> empty; values beat the sentinel', () => {
    expect([...parseSelection(new URLSearchParams()).status]).toEqual([...DEFAULT_STATUS_SET]);
    expect([...parseSelection(new URLSearchParams('status=bogus')).status]).toEqual([...DEFAULT_STATUS_SET]);
    expect([...parseSelection(new URLSearchParams(`status=${STATUS_EMPTY_KEY}`)).status]).toEqual([]);
    expect([...parseSelection(new URLSearchParams(`status=${STATUS_EMPTY_KEY}&status=inactive`)).status]).toEqual(['inactive']);
    expect([...parseSelection(new URLSearchParams('status=searching&status=bogus')).status]).toEqual(['searching']);
    expect([...parseSelection(new URLSearchParams('status=inactive&status=placed')).status].sort()).toEqual(['inactive', 'placed']);
  });

  it('writes only a NON-default selection: default -> no param, empty -> _empty, values in TENANT_STATUSES order', () => {
    const p = new URLSearchParams('phone=%2B14045550100&status=inactive');
    applyToParams(p, sel(DEFAULT_STATUS_SET));
    expect(p.getAll('status')).toEqual([]);
    expect(p.get('phone')).toBe('+14045550100');
    applyToParams(p, sel([]));
    expect(p.getAll('status')).toEqual([STATUS_EMPTY_KEY]);
    applyToParams(p, sel(['inactive', 'searching']));
    expect(p.getAll('status')).toEqual(['searching', 'inactive']);
  });

  it('round-trips default, empty, all and a custom selection', () => {
    for (const s of [[...DEFAULT_STATUS_SET], [], [...TENANT_STATUSES], ['on_hold', 'placed']] as TenantStatus[][]) {
      const p = new URLSearchParams();
      applyToParams(p, sel(s));
      expect([...parseSelection(p).status].sort()).toEqual([...s].sort());
    }
  });

  it('hides inactive and placed by default; NO status and an off-list status are never hidden (F1)', () => {
    const searching = st('searching');
    const inactive = st('inactive');
    const placed = st('placed');
    const none = st(undefined);
    const offList = st('active');
    expect(applySelection([searching, inactive, placed, none, offList], sel(DEFAULT_STATUS_SET))).toEqual([searching, none, offList]);
    // Even the EMPTY selection keeps them: the facet only ever hides a recorded tenant status.
    expect(applySelection([searching, none, offList], sel([]))).toEqual([none, offList]);
  });

  it('status chips: seven, TENANT_STATUSES order, StatusBadge labels, counts under the OTHER facets only', () => {
    const tenants = [
      st('searching', { voucherSize: 2 }),
      st('searching', { voucherSize: 3 }),
      st('inactive', { voucherSize: 2 }),
      st(undefined, { voucherSize: 2 }), // counts under no chip
      st('active', { voucherSize: 2 }), // off-list: counts under no chip
    ];
    const m = buildFacets(tenants, { ...sel(DEFAULT_STATUS_SET), voucher: new Set(['2']) }, all);
    expect(m.status.map((o) => o.key)).toEqual([...TENANT_STATUSES]);
    expect(m.status.map((o) => o.label)).toEqual(TENANT_STATUSES.map((s) => TENANT_STATUS_LABELS[s]));
    // Narrowed by voucher (one 2-BR searching), NOT by its own selection (inactive still 1).
    expect(m.status.find((o) => o.key === 'searching')!.count).toBe(1);
    expect(m.status.find((o) => o.key === 'inactive')!.count).toBe(1);
    expect(m.status.reduce((sum, o) => sum + o.count, 0)).toBe(2);
  });

  it('the value facets count under the status selection', () => {
    const tenants = [st('searching', { voucherSize: 2 }), st('inactive', { voucherSize: 2 }), st(undefined, { voucherSize: 2 })];
    expect(buildFacets(tenants, sel(DEFAULT_STATUS_SET), all).voucher.find((o) => o.key === '2')!.count).toBe(2);
    expect(buildFacets(tenants, sel(TENANT_STATUSES), all).voucher.find((o) => o.key === '2')!.count).toBe(3);
  });

  it('hiddenByStatusOnly: true only when the other three facets pass and the status does not', () => {
    const inactive2 = st('inactive', { voucherSize: 2 });
    expect(hiddenByStatusOnly(inactive2, sel(DEFAULT_STATUS_SET))).toBe(true);
    expect(hiddenByStatusOnly(inactive2, { ...sel(DEFAULT_STATUS_SET), voucher: new Set(['3']) })).toBe(false);
    expect(hiddenByStatusOnly(st('searching'), sel(DEFAULT_STATUS_SET))).toBe(false);
    expect(hiddenByStatusOnly(st(undefined), sel([]))).toBe(false);
  });

  it('sort: ?sort=name reads name, anything else heard; the writer touches only sort', () => {
    expect(parseSort(new URLSearchParams('sort=name'))).toBe('name');
    expect(parseSort(new URLSearchParams())).toBe('heard');
    expect(parseSort(new URLSearchParams('sort=bogus'))).toBe('heard');
    const p = new URLSearchParams('voucher=2&sort=bogus');
    applySortToParams(p, 'name');
    expect(p.toString()).toBe('voucher=2&sort=name');
    applySortToParams(p, 'heard');
    expect(p.toString()).toBe('voucher=2');
  });
});
```

RED today: the new exports are undefined and `parseSelection` returns no
`status`. Also update `dashboard/src/routes/contacts/TenantFilters.test.tsx`
so it still TYPECHECKS (its new assertions come in 4.3): line 4 becomes
`import { TENANT_STATUSES, type Contact, type TenantStatus } from '../../api/index.js';`;
`EMPTY` (`:12-16`) gains `status: new Set<TenantStatus>(TENANT_STATUSES),`;
the literals at `:148` and `:162` gain the same member, and the expected
object at `:167-171` gains `status: new Set<TenantStatus>(TENANT_STATUSES),`
(the Clear keeps the other facets' members, status included).

GREEN - `dashboard/src/routes/contacts/tenantFacets.ts`:

- Line 7: `import type { Contact } from '../../api/index.js';` becomes
  `import { TENANT_STATUSES, TENANT_STATUS_LABELS, type Contact, type TenantStatus } from '../../api/index.js';`
  (`TENANT_STATUS_LABELS` is the map `StatusBadge.labelFor` reads,
  `dashboard/src/ui/StatusBadge.tsx:93-94`, so the chip labels ARE the badge
  labels).
- After `VOUCHER_KEYS` (`:55`) insert:

```ts
/** The status facet's URL sentinel for the EMPTY selection (spec 2026-10-12
 *  5.7). Spelled unlike NONE_KEY on purpose: "no status chip lit" is not "no
 *  value recorded". */
export const STATUS_EMPTY_KEY = '_empty';

const TENANT_STATUS_SET: ReadonlySet<string> = new Set<string>(TENANT_STATUSES);

/** All seven statuses - the status facet's UNCONSTRAINED value (the probe's,
 *  and what "Show all statuses" lights). */
export const ALL_STATUS_SET: ReadonlySet<TenantStatus> = new Set<TenantStatus>(TENANT_STATUSES);

/** The DEFAULT status selection, read when the URL carries no `status`: every
 *  status except inactive and placed (spec 5.7, D1). */
export const DEFAULT_STATUS_SET: ReadonlySet<TenantStatus> = new Set<TenantStatus>(
  TENANT_STATUSES.filter((s) => s !== 'inactive' && s !== 'placed'),
);

/** The Tenants list order (`?sort=`): absent = 'heard'. */
export type TenantSort = 'heard' | 'name';
```

- Replace `TenantSelection` (`:57-62`) with:

```ts
/**
 * The active facet selection. voucher / ha / porting: empty sets and false
 * are UNCONSTRAINED. `status` INVERTS that convention (spec 2026-10-12 5.7):
 * it is the set of statuses SHOWN - empty shows no status-bearing tenant,
 * ALL_STATUS_SET is unconstrained, and an absent URL param reads as
 * DEFAULT_STATUS_SET. A tenant with no status or an off-list one is never
 * hidden by it and counts under no chip (14.5 F1).
 */
export interface TenantSelection {
  voucher: ReadonlySet<string>;
  ha: ReadonlySet<string>;
  porting: boolean;
  status: ReadonlySet<TenantStatus>;
}
```

- `TenantFacetModel` (`:72-85`): add, after `portingCount`:

```ts
  /** The seven tenant statuses in TENANT_STATUSES order, labelled as
   *  StatusBadge labels them - always all seven, whatever the counts. */
  status: FacetOption[];
```

- After `authorityKeyOf` (`:133-136`) insert:

```ts
/** The tenant's status when it is one of the seven, else null (absent or off-list). */
function statusKeyOf(c: Contact): TenantStatus | null {
  const s = c.status;
  return typeof s === 'string' && TENANT_STATUS_SET.has(s) ? (s as TenantStatus) : null;
}

/** The status selection in the URL: valid values win (the sentinel is then
 *  dropped); else the sentinel alone is the EMPTY selection; else - absent,
 *  or every value invalid - the DEFAULT set (never empty: a stale link must
 *  not blank the list). */
function parseStatus(params: URLSearchParams): Set<TenantStatus> {
  const raw = params.getAll('status');
  const valid = new Set<TenantStatus>();
  for (const v of raw) if (TENANT_STATUS_SET.has(v)) valid.add(v as TenantStatus);
  if (valid.size > 0) return valid;
  if (raw.includes(STATUS_EMPTY_KEY)) return new Set<TenantStatus>();
  return new Set(DEFAULT_STATUS_SET);
}

function sameStatuses(a: ReadonlySet<TenantStatus>, b: ReadonlySet<TenantStatus>): boolean {
  if (a.size !== b.size) return false;
  for (const s of a) if (!b.has(s)) return false;
  return true;
}
```

- `parseSelection` (`:139-158`): its last line (`:157`) becomes
  `return { voucher, ha, porting: porting !== null && porting !== 'false', status: parseStatus(params) };`
- Replace `applyToParams` and its doc (`:160-172`) with:

```ts
/**
 * Write the selection back onto `params` IN PLACE: the four facet keys are
 * deleted and re-added, and no other key is ever touched (`?phone=` and
 * `?sort=` must survive). Porting writes as `porting=1`; the value is never
 * read back. Status writes ONLY a non-default selection: the default removes
 * the param, the empty selection writes `status=_empty`, anything else writes
 * its values in TENANT_STATUSES order.
 */
export function applyToParams(params: URLSearchParams, sel: TenantSelection): void {
  params.delete('voucher');
  params.delete('ha');
  params.delete('porting');
  params.delete('status');
  for (const key of sel.voucher) params.append('voucher', key);
  for (const key of sel.ha) params.append('ha', key);
  if (sel.porting) params.set('porting', '1');
  if (!sameStatuses(sel.status, DEFAULT_STATUS_SET)) {
    if (sel.status.size === 0) params.append('status', STATUS_EMPTY_KEY);
    else for (const s of TENANT_STATUSES) if (sel.status.has(s)) params.append('status', s);
  }
}

/** `?sort=`: 'name', else the default 'heard' (absent or anything else). */
export function parseSort(params: URLSearchParams): TenantSort {
  return params.get('sort') === 'name' ? 'name' : 'heard';
}

/** Write the sort IN PLACE; the default writes nothing. No other key is touched. */
export function applySortToParams(params: URLSearchParams, sort: TenantSort): void {
  params.delete('sort');
  if (sort === 'name') params.set('sort', 'name');
}
```

- After `matchesPorting` (`:188-191`) insert:

```ts
/** The status facet - the set of statuses SHOWN (inverted, see TenantSelection).
 *  No status or an off-list one always passes (F1). */
function matchesStatus(c: Contact, keys: ReadonlySet<TenantStatus>): boolean {
  const key = statusKeyOf(c);
  return key === null || keys.has(key);
}

/** True when the status facet ALONE hides this tenant: voucher, authority and
 *  porting pass, its status is not shown (the hidden-match hint, 14.5 F11). */
export function hiddenByStatusOnly(c: Contact, sel: TenantSelection): boolean {
  return (
    matchesVoucher(c, sel.voucher) &&
    matchesAuthority(c, sel.ha) &&
    matchesPorting(c, sel.porting) &&
    !matchesStatus(c, sel.status)
  );
}
```

- `buildFacets` doc (`:217-226`): "Options + contextual counts for the four
  controls." and the counts sentence reads "each facet sees the search query
  and the OTHER facets (Porting and Status included) - never its own
  selection". Body: replace `:247-256` with

```ts
  const queried = tenants.filter((c) => matchesQuery(c));
  const forVoucher = queried.filter(
    (c) => matchesAuthority(c, sel.ha) && matchesPorting(c, sel.porting) && matchesStatus(c, sel.status),
  );
  const forAuthority = queried.filter(
    (c) => matchesVoucher(c, sel.voucher) && matchesPorting(c, sel.porting) && matchesStatus(c, sel.status),
  );
  const forPorting = queried.filter(
    (c) => matchesVoucher(c, sel.voucher) && matchesAuthority(c, sel.ha) && matchesStatus(c, sel.status),
  );
  const forStatus = queried.filter(
    (c) => matchesVoucher(c, sel.voucher) && matchesAuthority(c, sel.ha) && matchesPorting(c, sel.porting),
  );
```

  insert before the `return {` (`:287`):

```ts
  // Always all seven, in TENANT_STATUSES order. A tenant with no status or an
  // off-list one counts under NO chip (statusKeyOf is null) - F1.
  const status: FacetOption[] = TENANT_STATUSES.map((s) => ({
    key: s,
    label: TENANT_STATUS_LABELS[s],
    count: forStatus.filter((c) => statusKeyOf(c) === s).length,
  }));
```

  and add `status,` to the returned object after `portingCount: ...`.
- `applySelection` (`:298-305`): add `&& matchesStatus(c, sel.status)` after
  `matchesPorting(c, sel.porting)`, and its doc reads "OR within each facet,
  AND across them (status is the set SHOWN)".

`dashboard/src/routes/contacts/ContactsList.tsx` (typecheck needs it now; the
controls arrive in 4.3):

- Import (`:18-25`): add `ALL_STATUS_SET,` to the `./tenantFacets.js` list.
- `NO_SELECTION` (`:98-104`) becomes:

```ts
/** An unconstrained selection - used to derive the SELECTION-INDEPENDENT
 *  authority option keys (see `validAuthorityKeys`). Status is the facet that
 *  INVERTS "empty = unconstrained", so its unconstrained value is all seven. */
const NO_SELECTION: TenantSelection = {
  voucher: new Set<string>(),
  ha: new Set<string>(),
  porting: false,
  status: ALL_STATUS_SET,
};
```

- The selection memo's returned object (`:225-229`) gains
  `status: parsed.status,` and the comment block above it (`:202-220`) gains
  one sentence at its end: "Status needs no prune here: its seven chips
  always render (no empty line, never hidden), so no status selection can go
  invisible, and parseSelection already drops invalid values and reads an
  all-invalid `?status=` as the default."

Interim state, accepted mid-branch: from this commit the Tenants view hides
inactive and placed tenants before their chips exist (4.3).

Run: `npx vitest run src/routes/contacts/tenantFacets.test.ts src/routes/contacts/TenantFilters.test.tsx src/routes/contacts/ContactsList.test.tsx`
green (every existing ContactsList fixture is status-less, `searching`, or the
off-list `active` at `ContactsList.test.tsx:31`, so none is hidden); then
`npm run typecheck` green.

Commit: `feat(dashboard): Tenants status facet in the facet engine - default set, _empty, sort param`

### Task 4.3 - `ChipGroup` baseline, the Status chip group, and the hidden-match hint

RED:

1. `dashboard/src/routes/contacts/FilterChips.test.tsx` - append inside the
   describe:

```tsx
  it('with a baseline, Clear shows only while the selection DIFFERS from it - an empty selection included', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const baseline = new Set(['hope atlanta', 'step up']);
    const props = { label: 'Organization', emptyLine: null, options: OPTIONS, onToggle: vi.fn(), onClear, baseline };
    const { rerender } = render(<ChipGroup {...props} selected={new Set(['step up', 'hope atlanta'])} />);
    expect(screen.queryByRole('button', { name: 'Clear organization filter' })).toBeNull();
    rerender(<ChipGroup {...props} selected={new Set(['hope atlanta'])} />);
    expect(screen.getByRole('button', { name: 'Clear organization filter' })).toBeInTheDocument();
    rerender(<ChipGroup {...props} selected={new Set<string>()} />);
    await user.click(screen.getByRole('button', { name: 'Clear organization filter' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
```

   RED: with the old rule an equal-to-baseline selection (size 2) shows Clear.
   The existing cases (`:13-27`, `:29-51`) pin the no-baseline behavior and
   stay green.

2. `dashboard/src/routes/contacts/TenantFilters.test.tsx`:
   - `:63` `toHaveLength(3)` becomes `toHaveLength(4)` and its comment reads
     "Four distinct groups" (the Status group is new - knowing update).
   - Add `DEFAULT_STATUS_SET` to the `./tenantFacets.js` import (`:5`).
   - Append inside `describe('TenantFilters')`:

```tsx
  it('renders the Status group: seven chips in TENANT_STATUSES order with StatusBadge labels and counts', () => {
    const tenants = [tenant({ status: 'searching' }), tenant({ status: 'inactive' }), tenant({})];
    const sel: TenantSelection = { ...EMPTY, status: new Set(DEFAULT_STATUS_SET) };
    render(<TenantFilters model={buildFacets(tenants, sel, ALL)} selection={sel} onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Status' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Needs review (0)',
      'Onboarding (0)',
      'Searching (1)',
      'Placing (0)',
      'Placed (0)',
      'On hold (0)',
      'Inactive (1)',
    ]);
    expect(within(group).getByRole('button', { name: 'Searching (1)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Inactive (1)' })).toHaveAttribute('aria-pressed', 'false');
    // At the default there is nothing to clear.
    expect(within(group).queryByRole('button', { name: 'Clear status filter' })).toBeNull();
  });

  it('a status chip toggles through onChange; Clear returns to the DEFAULT set and shows only off-default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const tenants = [tenant({ status: 'inactive' })];
    const def: TenantSelection = { ...EMPTY, status: new Set(DEFAULT_STATUS_SET) };
    const { unmount } = render(<TenantFilters model={buildFacets(tenants, def, ALL)} selection={def} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Inactive (1)' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: new Set([...DEFAULT_STATUS_SET, 'inactive']) }),
    );
    unmount();
    const off: TenantSelection = { ...EMPTY, status: new Set<TenantStatus>() }; // the _empty selection
    render(<TenantFilters model={buildFacets(tenants, off, ALL)} selection={off} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Clear status filter' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...off, status: new Set(DEFAULT_STATUS_SET) });
  });
```

3. `dashboard/src/routes/contacts/ContactsList.test.tsx` - add fixtures after
   `:100` and a new describe at the end of the file (after `:458`):

```tsx
/** Status-facet fixtures (spec 2026-10-12 5.7). Sam/Rae are default-visible,
 *  Ida/Pat are hidden by default, Nell has NO status (never hidden, F1). */
const S_SAM: Contact = { contactId: 's1', type: 'tenant', firstName: 'Sam', lastName: 'Searching', phone: '+14040100011', status: 'searching', voucherSize: 2, last_heard_from_at: '2024-03-05T12:00:00.000Z' };
const S_IDA: Contact = { contactId: 's2', type: 'tenant', firstName: 'Ida', lastName: 'Inactive', phone: '+14040100012', status: 'inactive', last_heard_from_at: '2024-04-01T12:00:00.000Z' };
const S_PAT: Contact = { contactId: 's3', type: 'tenant', firstName: 'Pat', lastName: 'Placed', phone: '+14040100013', status: 'placed' };
const S_NELL: Contact = { contactId: 's4', type: 'tenant', firstName: 'Nell', lastName: 'Nostatus', phone: '+14040100014' };
const S_RAE: Contact = { contactId: 's5', type: 'tenant', firstName: 'Rae', lastName: 'Recent', phone: '+14040100015', status: 'onboarding', last_heard_from_at: '2024-06-01T12:00:00.000Z' };
const STATUS_TENANTS: Contact[] = [S_SAM, S_IDA, S_PAT, S_NELL, S_RAE];

/** The rows' display names in render order (the name span is the link's first child). */
function tenantRowNames(): string[] {
  return rowsOf('Tenants')
    .getAllByRole('listitem')
    .map((li) => li.querySelector('a > span')?.textContent ?? '');
}
```

```tsx
describe('ContactsList - status facet (spec 2026-10-12 5.7)', () => {
  it('the default hides inactive and placed tenants; a tenant with no status stays', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    expect(tenantRowNames().sort()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    const group = screen.getByRole('group', { name: 'Status' });
    expect(within(group).getByRole('button', { name: 'Inactive (1)' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: 'Placed (1)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Clear status filter' })).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('');
  });

  it('a chip brings a hidden status back and writes the non-default set; Clear returns to the default', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.click(screen.getByRole('button', { name: 'Inactive (1)' }));
    expect(tenantRowNames()).toContain('Ida Inactive');
    expect(tenantRowNames()).not.toContain('Pat Placed');
    const search = screen.getByTestId('loc').textContent ?? '';
    expect(search).toContain('status=inactive');
    expect(search).toContain('status=needs_review');
    expect(search).not.toContain('status=placed');
    await userEvent.click(screen.getByRole('button', { name: 'Clear status filter' }));
    expect(tenantRowNames()).not.toContain('Ida Inactive');
    expect(screen.getByTestId('loc').textContent).not.toContain('status=');
  });

  it('?status=_empty lights no chip, keeps only the status-less tenant, and offers Clear', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=_empty');
    expect(tenantRowNames()).toEqual(['Nell Nostatus']);
    const group = screen.getByRole('group', { name: 'Status' });
    for (const b of within(group).getAllByRole('button', { name: /\(\d+\)$/ })) {
      expect(b).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByRole('button', { name: 'Clear status filter' })).toBeInTheDocument();
  });

  it('status values beat the _empty sentinel', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=_empty&status=inactive');
    expect(tenantRowNames().sort()).toEqual(['Ida Inactive', 'Nell Nostatus']);
  });

  it('an invalid-only ?status= reads as the default and the URL is not rewritten on mount', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=bogus');
    expect(tenantRowNames().sort()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    expect(screen.getByTestId('loc').textContent).toBe('?status=bogus');
  });

  it('a query that matches only a status-hidden tenant offers "Show all statuses", which lights all seven', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'ida');
    expect(screen.getByText(/No matches for .ida. among the statuses shown/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
    expect(tenantRowNames()).toEqual(['Ida Inactive']);
    for (const b of within(screen.getByRole('group', { name: 'Status' })).getAllByRole('button', { name: /\(\d+\)$/ })) {
      expect(b).toHaveAttribute('aria-pressed', 'true');
    }
    const search = screen.getByTestId('loc').textContent ?? '';
    expect(search).toContain('status=placed');
    expect(search).toContain('status=inactive');
  });

  it('no hint when nothing hidden by status matches, or when another facet hides the match', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?voucher=3');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'sam');
    // Sam (2-BR, searching) is hidden by the VOUCHER facet, not by status.
    expect(screen.getByText(/No matches for .sam.\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all statuses' })).toBeNull();
  });
});
```

RED today: no Status group, no Clear status filter, no hint.

GREEN:

- `dashboard/src/routes/contacts/FilterChips.tsx` - after the imports
  (`:9-11`) insert:

```ts
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
```

  In `ChipGroup`'s destructure (`:20-26`) add `baseline,` after `onClear,`;
  in its props type (`:27-35`) add, after `onClear`:

```ts
  /** The selection Clear returns to (spec 2026-10-12 5.7, the Tenants Status
   *  group). Omitted = the empty set, as every other facet has always had.
   *  Clear shows only while `selected` DIFFERS from it - for the empty
   *  baseline that is exactly the old `selected.size > 0`, and an EMPTY
   *  selection against a non-empty baseline still differs (14.5 F12). */
  baseline?: ReadonlySet<string>;
```

  and `:56` `{onClear !== null && selected.size > 0 ? (` becomes
  `{onClear !== null && !sameKeys(selected, baseline ?? EMPTY_KEYS) ? (`.
  Update the doc comment at `:13-19`: "(plus a Clear while the selection
  differs from its baseline - empty unless the group says otherwise)".
  `CaseworkersList.tsx:229-236` passes no baseline and is unchanged.
- `dashboard/src/routes/contacts/TenantFilters.tsx`:
  - imports (`:11`): `import { DEFAULT_STATUS_SET, type TenantFacetModel, type TenantSelection } from './tenantFacets.js';`
    and add `import type { TenantStatus } from '../../api/index.js';`.
  - header comment (`:1-8`): "the Tenants list's facet controls: status,
    voucher size, housing authority, and a Porting toggle".
  - after `toggled` (`:23-28`) insert:

```ts
/** Toggle one status in the (inverted) status selection, returning a new set. */
function toggledStatus(keys: ReadonlySet<TenantStatus>, key: string): Set<TenantStatus> {
  const next = new Set(keys);
  const status = key as TenantStatus; // keys come from model.status, which lists only the seven
  if (!next.delete(status)) next.add(status);
  return next;
}
```

  - as the FIRST child of `<div className={styles.controls}>` (`:33`):

```tsx
      {/* Status (spec 2026-10-12 5.7): the facet that INVERTS "empty =
       *  unconstrained" - the selection is the statuses SHOWN, its baseline is
       *  the default set, and Clear returns there. Always all seven chips, never
       *  an empty line. */}
      <ChipGroup
        label="Status"
        emptyLine={null}
        options={model.status}
        selected={selection.status}
        baseline={DEFAULT_STATUS_SET}
        onToggle={(key) => onChange({ ...selection, status: toggledStatus(selection.status, key) })}
        onClear={() => onChange({ ...selection, status: new Set(DEFAULT_STATUS_SET) })}
      />
```

- `dashboard/src/routes/contacts/ContactsList.tsx`:
  - Import (`:18-25`): add `hiddenByStatusOnly,` to the `./tenantFacets.js` list.
  - After the `facets` memo (`:240-243`) insert:

```ts
  // The hidden-match hint (spec 5.7, 14.5 F11): the query matches some tenant
  // that ONLY the status facet hides (voucher, authority and porting pass).
  const hiddenMatch = useMemo(
    () => isTenantView && q !== '' && contacts.some((c) => searchKey(c).includes(q) && hiddenByStatusOnly(c, selection)),
    [contacts, q, isTenantView, selection],
  );
```

  - Replace the no-matches paragraph (`:328-336`) with:

```tsx
          <p className={styles.noMatches}>
            {/* The query message wins when both are active. Entity quotes, never
             *  literal curly ones - every new line here stays ASCII. A query that
             *  only a hidden STATUS keeps from matching says so, with the way out. */}
            {query.trim() && hiddenMatch ? (
              <>
                No matches for &ldquo;{query.trim()}&rdquo; among the statuses shown.{' '}
                <button
                  type="button"
                  className={styles.showAll}
                  onClick={() => updateSelection({ ...selection, status: new Set(ALL_STATUS_SET) })}
                >
                  Show all statuses
                </button>
              </>
            ) : query.trim() ? (
              <>No matches for &ldquo;{query.trim()}&rdquo;.</>
            ) : (
              'No tenants match the selected filters.'
            )}
          </p>
```

- `dashboard/src/routes/contacts/ContactsList.module.css` - after `.noMatches`
  (`:336-340`) insert:

```css
/* "Show all statuses" inside the no-match line (spec 2026-10-12 5.7): a quiet
 * text button in the facet Clear's language (TenantFilters.module.css .clear). */
.showAll {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--c-brand);
  font: inherit;
  font-weight: var(--fw-medium);
  cursor: pointer;
}

.showAll:hover {
  text-decoration: underline;
}

.showAll:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}
```

Run: `npx vitest run src/routes/contacts/` green (FilterChips, TenantFilters,
ContactsList, tenantFacets; `CaseworkersList.test.tsx` too - it renders
`ChipGroup` with no baseline).

Commit: `feat(dashboard): Tenants Status chips, a baseline-aware Clear, and the hidden-match hint`

### Task 4.4 - the sort control, the sorted `visible` memo, and the row's last-heard line

RED:

1. `TenantFilters.test.tsx` - append:

```tsx
  it('renders the Sort by select only when the host wires it, and reports the choice', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const { unmount } = render(<TenantFilters model={MODEL} selection={EMPTY} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    unmount();
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={vi.fn()} sort="heard" onSortChange={onSortChange} />);
    const select = screen.getByLabelText('Sort by');
    expect(select).toHaveValue('heard');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Last heard from', 'Name']);
    await user.selectOptions(select, 'name');
    expect(onSortChange).toHaveBeenCalledWith('name');
  });
```

2. `ContactsList.test.tsx` - add `import { formatInboxTimeFull } from '../inbox/inboxTime.js';`
   after `:7`, and append:

```tsx
describe('ContactsList - sort and the last-heard line (spec 2026-10-12 5.7)', () => {
  it('defaults to last heard from: most recent first, never-heard last', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    expect(tenantRowNames()).toEqual(['Rae Recent', 'Sam Searching', 'Nell Nostatus']);
    expect(screen.getByLabelText('Sort by')).toHaveValue('heard');
  });

  it('?sort=name orders by last name and round-trips through the select, merging the query string', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?sort=name');
    expect(tenantRowNames()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    expect(screen.getByLabelText('Sort by')).toHaveValue('name');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'heard');
    expect(screen.getByTestId('loc').textContent).not.toContain('sort=');
    expect(tenantRowNames()).toEqual(['Rae Recent', 'Sam Searching', 'Nell Nostatus']);
  });

  it('a sort write keeps the facet params, and a facet write keeps the sort', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?voucher=2');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'name');
    const afterSort = screen.getByTestId('loc').textContent ?? '';
    expect(afterSort).toContain('voucher=2');
    expect(afterSort).toContain('sort=name');
    // Deselect the (pressed, so always clickable) 2-BR chip: the facet write keeps the sort.
    await userEvent.click(screen.getByRole('button', { name: /^2-BR \(/ }));
    const afterFacet = screen.getByTestId('loc').textContent ?? '';
    expect(afterFacet).not.toContain('voucher=');
    expect(afterFacet).toContain('sort=name');
  });

  it('Tenants rows end with "Last heard from <label>" (title = the full stamp), after the Porting chip', () => {
    state = { status: 'ready', contacts: [...STATUS_TENANTS, T_SIX] };
    renderAt('/contacts/tenants');
    const sam = rowsOf('Tenants').getByRole('link', { name: /Sam Searching/ });
    const line = within(sam).getByText('Last heard from Mar 5, 2024');
    expect(line).toHaveAttribute('title', formatInboxTimeFull(S_SAM.last_heard_from_at as string));
    const nell = rowsOf('Tenants').getByRole('link', { name: /Nell Nostatus/ });
    expect(within(nell).getByText('Last heard from Never')).not.toHaveAttribute('title');
    const six = rowsOf('Tenants').getByRole('link', { name: /Tessa Six/ });
    const text = six.textContent ?? '';
    expect(text.indexOf('Porting')).toBeLessThan(text.indexOf('Last heard from'));
  });

  it('other views: no sort control, no last-heard line, no status facet, list order untouched', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts', 'all');
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    expect(screen.queryByText(/Last heard from/)).toBeNull();
    expect(rowsOf('Contacts').getAllByRole('listitem')).toHaveLength(5);
  });

  it('no sort control until the fetch is ready', () => {
    state = { status: 'loading', contacts: [] };
    renderAt('/contacts/tenants');
    expect(screen.queryByLabelText('Sort by')).toBeNull();
  });
});
```

RED today: no select, fixture order, no line. ("Mar 5, 2024": 12:00Z is
Mar 5 in every zone from UTC-11 to UTC+11.)

GREEN:

- `TenantFilters.tsx`:
  - imports: `import { useId } from 'react';` stays; extend the
    `./tenantFacets.js` import with `type TenantSort`.
  - props (`:14-21`) - add after `onChange`:

```ts
  /** The list order (`?sort=`); only read when `onSortChange` is wired. */
  sort?: TenantSort;
  /** Wiring this renders the "Sort by" select in the controls row (spec 14.5
   *  F14). Optional so a host without a sort (and the facet-only tests) is
   *  unchanged. */
  onSortChange?: (next: TenantSort) => void;
```

  - destructure (`:30`): `{ model, selection, onChange, sort, onSortChange }`;
    add `const sortId = useId();` after `portingLabelId` (`:31`).
  - as the LAST child of the controls div (after the Porting block that ends
    at `:69`):

```tsx
      {/* The list order (spec 2026-10-12 5.7): a labelled native select, the
       *  Properties list's precedent (ListingsList.tsx:338-357). */}
      {onSortChange !== undefined ? (
        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor={sortId}>
            Sort by
          </label>
          <select
            id={sortId}
            className={styles.select}
            value={sort ?? 'heard'}
            onChange={(e) => onSortChange(e.target.value === 'name' ? 'name' : 'heard')}
          >
            <option value="heard">Last heard from</option>
            <option value="name">Name</option>
          </select>
        </div>
      ) : null}
```

- `TenantFilters.module.css` - append after `.noneRecorded` (`:96-99`), the
  `ListingsList.module.css:98-111` rule verbatim:

```css
/* The Sort by select (spec 2026-10-12 5.7) - the Properties list's select. */
.select {
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--c-text);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
}

.select:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 1px;
  border-color: var(--c-border-strong);
}
```

- `ContactsList.tsx`:
  - imports: after `:16` add
    `import { compareByName, formatHeardFrom, sortByHeardFrom } from '../../lib/heardFrom.js';`;
    extend the `./tenantFacets.js` list (`:18-25`) with `applySortToParams,`,
    `parseSort,` and `type TenantSort,`.
  - `Row` (`:122-170`): props become `{ contact, showFacts, showHeardFrom, now }`
    with the type members

```ts
  /** The Tenants view only (spec 2026-10-12 5.7, 14.5 F13): the row's
   *  "Last heard from" line. */
  showHeardFrom: boolean;
  /** The render clock for the label (captured once per list mount). */
  now: Date;
```

    after `const porting = ...` (`:133`) add
    `const heard = showHeardFrom ? formatHeardFrom(contact.last_heard_from_at, now) : null;`,
    the class condition at `:141` becomes
    `${facts !== null || porting || heard !== null ? styles.factsRow : ''}`
    (the comment at `:138-140` gains: "the last-heard line is such a chip"),
    and after the Porting block (`:161-165`) insert:

```tsx
          {/* Spec 2026-10-12 5.7: AFTER Porting, unshrinkable (flex: 0 0 auto) -
           *  .facts stays the ONE compressible child. */}
          {heard !== null ? (
            <span className={styles.heardFrom} {...(heard.title !== '' && { title: heard.title })}>
              Last heard from {heard.label}
            </span>
          ) : null}
```

  - after `const navigate = useNavigate();` (`:187`) add
    `const [now] = useState(() => new Date());` with the comment
    `// One clock per list mount (a lazy initializer, never a render-time read): the list refetches on mount anyway.`
  - replace the `visible` memo (`:232-236`) with:

```ts
  const q = query.trim().toLowerCase();
  const sort: TenantSort = parseSort(searchParams);
  const visible = useMemo(() => {
    const queried = q ? contacts.filter((c) => searchKey(c).includes(q)) : contacts;
    if (!isTenantView) return queried;
    const selected = applySelection(queried, selection);
    // The order lives HERE, never in useContacts (six other screens share it -
    // spec 5.7). Both orders are total: contactId is compareByName's last key.
    return sort === 'name'
      ? [...selected].sort(compareByName)
      : sortByHeardFrom(selected, { heardAt: (c) => c.last_heard_from_at, name: (c) => c });
  }, [contacts, q, isTenantView, selection, sort]);
```

  - after `updateSelection` (`:245-251`) add:

```ts
  /** Serialize the sort, MERGING the query string like updateSelection. */
  function updateSort(next: TenantSort): void {
    const params = new URLSearchParams(searchParams);
    applySortToParams(params, next);
    setSearchParams(params, { replace: true });
  }
```

  - `:280` becomes
    `<TenantFilters model={facets} selection={selection} onChange={updateSelection} sort={sort} onSortChange={updateSort} />`
  - the `Row` call (`:320-324`) gains `showHeardFrom={isTenantView}` and `now={now}`.
- `ContactsList.module.css` - after `.porting` (`:235-246`) insert:

```css
/* "Last heard from <label>" (spec 2026-10-12 5.7, 14.5 F13): Tenants view
 * only, LAST in .meta, and unshrinkable like every other chip - .facts stays
 * the ONE compressible child (the sacrifice order documented above). This
 * widens the fixed chip set that
 * docs/issues/tenant-row-longname-midpane-overflow.md measures. */
.heardFrom {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
```

- `docs/issues/tenant-row-longname-midpane-overflow.md` - append one dated
  paragraph: "**2026-10-13.** The Tenants view now ends every row with an
  unshrinkable `Last heard from <label>` chip (spec
  `2026-10-12-last-heard-from-follow-up-status-design.md` 5.7), up to about
  30 characters at `--fs-xs`, so the band where the facts span is exhausted
  starts wider than the 561-700px measured above. Re-measure with the new chip
  before choosing option 1's cap."

Run: `npx vitest run src/routes/contacts/` green; `npm run typecheck` green.

Commit: `feat(dashboard): Tenants sort by last heard from or name, and the row's last-heard line`

### Task 4.5 - "Last heard from" on the contact header facts line

RED - `dashboard/src/routes/contact/ContactDetail.test.tsx`: add
`import { formatInboxTimeFull } from '../inbox/inboxTime.js';` with the other
imports, and insert after the test that ends at `:2857` (inside
`describe('ContactDetail - caseworkers ...')`, so `header()` (`:2827-2831`)
and `PARTNER` (`:2799`) are in scope):

```tsx
  it('header: Last heard from is its own span on the facts line, for every contact type (spec 2026-10-12 5.7, F6)', async () => {
    const at = '2024-03-05T12:00:00.000Z';
    getContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Atlanta Housing Authority', last_heard_from_at: at });
    const first = renderAt('k1');
    await screen.findByText('Tasha Williams');
    const band = within(header(first.container));
    // buildFacts()'s pinned string is untouched (the :2855 pin's shape).
    expect(band.getByText('Voucher 2BR - Atlanta Housing Authority')).toBeInTheDocument();
    const heard = band.getByText('Last heard from Mar 5, 2024');
    expect(heard.tagName).toBe('SPAN');
    expect(heard).toHaveAttribute('title', formatInboxTimeFull(at));
    first.unmount();

    getContact.mockResolvedValue(PARTNER);
    const second = renderAt('p1');
    await screen.findByText('Renee Carter');
    expect(within(header(second.container)).getByText('Last heard from Never')).toBeInTheDocument();
    expect(within(header(second.container)).getByText('Hope Atlanta')).toBeInTheDocument();
  });
```

RED today: no "Last heard from" text. `:2855`'s exact
`'Voucher 1BR - Atlanta Housing Authority'` and `:369`'s `/Voucher 2BR/` stay
green because the facts string moves into its own span (own text node).

GREEN - `dashboard/src/routes/contact/ContactDetail.tsx`:

- Line 22 already imports `useState`. Add
  `import { formatHeardFrom } from '../../lib/heardFrom.js';` after `:74`.
- `:984` `{facts ? <div className={styles.facts}>{facts}</div> : null}`
  becomes:

```tsx
          {/* The facts line always renders now: "Last heard from" (spec
              2026-10-12 5.7) is its own span here for EVERY contact type -
              never appended to buildFacts()'s string, which tests pin exactly. */}
          <div className={styles.facts}>
            {facts ? (
              <>
                <span>{facts}</span>
                {' - '}
              </>
            ) : null}
            <LastHeardFrom iso={contact.last_heard_from_at} />
          </div>
```

- At the end of the module (after the last top-level declaration) add:

```tsx
/** "Last heard from <label>" on the header facts line (spec 2026-10-12 5.7,
 *  14.5 F5/F6). The header refreshes on NAVIGATION, never live (useContact
 *  fetches once per id), so the clock is captured once per mount. */
function LastHeardFrom({ iso }: { iso: string | undefined }): React.JSX.Element {
  const [now] = useState(() => new Date());
  const { label, title } = formatHeardFrom(iso, now);
  return (
    <span className={styles.heardFrom} {...(title !== '' && { title })}>
      Last heard from {label}
    </span>
  );
}
```

- `dashboard/src/routes/contact/ContactDetail.module.css` - after `.facts`
  (`:89-96`) insert:

```css
/* "Last heard from" (spec 2026-10-12 5.7): its own span on the facts line,
 * in the header facts token it inherits; kept whole while the facts text
 * ahead of it ellipsizes. */
.heardFrom {
  white-space: nowrap;
}
```

Run: `npx vitest run src/routes/contact/ContactDetail.test.tsx` green;
`npm run typecheck` green.

Commit: `feat(dashboard): Last heard from on the contact header facts line`

### Task 4.6 - the perf harness binds a default-visible tenant

RED - `e2e/performance/routes.test.ts`, inside `describe('representative
resolvers')` after the case ending at `:705`:

```ts
  it('binds the first tenant the DEFAULT Tenants view renders - never an inactive or placed one', async () => {
    const api = new FakeApi();
    api.pages.set('/api/contacts?limit=100&type=tenant', [{
      contacts: [
        { contactId: 'contact-private-inactive', type: 'tenant', status: 'inactive' },
        { contactId: 'contact-private-placed', type: 'tenant', status: 'placed' },
        { contactId: 'contact-private-gone', type: 'tenant', status: 'searching', deleted_at: 'x' },
        { contactId: 'contact-private-live', type: 'tenant', status: 'searching' },
      ],
      nextCursor: null,
    }]);
    await expect(resolveContactDetail(api, new FakeDom(new Set(['/contacts/contact-private-live'])))).resolves.toEqual({
      kind: 'resolved', coldPath: '/contacts/contact-private-live',
      warmTarget: { path: '/contacts/contact-private-live', query: { kind: 'absent' } },
      branch: { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 },
    });
  });
```

RED today: `resolveContactDetail` binds `contact-private-inactive`, whose
link the FakeDom lacks -> `{ kind: 'skip', reason: 'fixture_not_navigable' }`.
The existing case at `:690-705` (status-less rows) stays green.

GREEN - `e2e/performance/routes.ts:1117-1131`: above the function add the
comment (the pattern of the unit fix at `:1132-1135`)

```ts
// The warm sample clicks this tenant's row on `/contacts/tenants`, whose
// Status facet HIDES inactive and placed tenants by default (spec 2026-10-12
// 5.7) - and GSI byte order lists `inactive` first. Bind a default-VISIBLE
// tenant (no status, an off-list one, or any status but those two), or every
// sample skips as fixture_not_navigable.
const HIDDEN_BY_DEFAULT: ReadonlySet<string> = new Set(['inactive', 'placed']);
```

and `:1121` becomes:

```ts
    const match = rowsFrom(page, 'contacts').find(
      (row) =>
        row.deleted_at === undefined &&
        !(typeof row.status === 'string' && HIDDEN_BY_DEFAULT.has(row.status)) &&
        stringField(row, 'contactId') !== undefined,
    );
```

Run: `cd "W:/tmp/last-heard-from/e2e"; npx vitest run performance/routes.test.ts`
green (the citation-shape check at `routes.test.ts:447-481` is untouched);
then `cd "W:/tmp/last-heard-from"; npm run typecheck`.

Commit: `fix(perf): bind a default-visible tenant for the contact detail sample`

---


## S5 - roster cards (dashboard)

Depends on S4's `dashboard/src/lib/heardFrom.ts` (`formatHeardFrom(iso, now)
-> { label, title }`). Tests compute expected date text through
`formatHeardFrom` itself, so they never pin S4's label format.

### Task 5.1 - `SendRosterRow` rebuilt + `Card.module.css`

RED - new `dashboard/src/routes/contact/SendRosterRow.test.tsx` (the
`TourChip.test.tsx:1-19` style):

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ListingSendRow } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';
import { interestedModeOf, SendRosterList, SendRosterRow, type SendRosterRowProps } from './Card.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ROW: ListingSendRow = {
  contactId: 'c-1',
  tenantName: 'Tia Moss',
  unitId: 'u1',
  sentAt: '2026-10-03T15:00:00.000Z',
  via: 'broadcast',
  outcome: 'no_reply',
  interestedSupported: true,
};

function renderRow(row: Partial<ListingSendRow> = {}, props: Partial<SendRosterRowProps> = {}) {
  const onOutcome = props.onOutcome ?? vi.fn(() => Promise.resolve());
  render(
    <MemoryRouter>
      <SendRosterList label="Properties sent">
        <SendRosterRow
          to="/contacts/c-1"
          identity="Tia Moss"
          row={{ ...ROW, ...row }}
          address="12 Oak St"
          name="Tia Moss"
          interestedMode="route"
          now={NOW}
          {...props}
          onOutcome={onOutcome}
        />
      </SendRosterList>
    </MemoryRouter>,
  );
  return { onOutcome };
}

describe('SendRosterRow - markup R1 (plan head 3.4 #10)', () => {
  it('the row root is ONE listitem inside the named list, and nothing inside it is another listitem', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    const list = screen.getByRole('list', { name: 'Properties sent' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]!.tagName).toBe('LI');
    expect(within(items[0]!).getByRole('link', { name: 'Tia Moss' })).toBeInTheDocument();
    expect(within(items[0]!).getByText('Not interested', { exact: true })).toBeInTheDocument();
  });

  it('three rows in one list are exactly three listitems', () => {
    render(
      <MemoryRouter>
        <SendRosterList label="Waiting">
          {['c-1', 'c-2', 'c-3'].map((id) => (
            <SendRosterRow
              key={id}
              to={`/contacts/${id}`}
              identity={id}
              row={{ ...ROW, contactId: id }}
              address="12 Oak St"
              name={id}
              interestedMode="route"
              onOutcome={() => Promise.resolve()}
              now={NOW}
            />
          ))}
        </SendRosterList>
      </MemoryRouter>,
    );
    expect(within(screen.getByRole('list', { name: 'Waiting' })).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('SendRosterRow - outcome rendering', () => {
  it('no_reply: the chip, both dates, Interested + Not interested with their names', () => {
    renderRow();
    expect(screen.getByText('No reply yet')).toBeInTheDocument();
    expect(screen.getByText(`Sent ${formatHeardFrom(ROW.sentAt, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByText(`Last heard from ${formatHeardFrom(undefined, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toHaveTextContent('Interested');
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toHaveTextContent('Not interested');
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });

  it('replied: the Replied chip and the last-heard date', () => {
    renderRow({ outcome: 'replied', lastHeardFromAt: '2026-10-10T09:00:00.000Z' });
    expect(screen.getByText('Replied')).toBeInTheDocument();
    expect(screen.getByText(`Last heard from ${formatHeardFrom('2026-10-10T09:00:00.000Z', NOW).label}`)).toBeInTheDocument();
  });

  it('interested: the TourChip IS the signal, and there are no buttons', () => {
    renderRow({ outcome: 'interested', tour: { tourId: 't-9', state: 'scheduled' } });
    expect(screen.getByRole('link', { name: 'Tour scheduled' })).toHaveAttribute('href', '/tours/t-9');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('not_interested (staff): the muted chip with the date in its title, and Undo only', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    const chip = screen.getByText('Not interested');
    expect(chip).toHaveAttribute('title', formatHeardFrom('2026-10-05T10:00:00.000Z', NOW).title);
    expect(screen.getByRole('button', { name: 'Undo not interested for Tia Moss' })).toHaveTextContent('Undo');
    expect(screen.queryByRole('button', { name: /^Mark / })).not.toBeInTheDocument();
  });

  it('not_interested by the engine reads "(auto)"', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'engine' } });
    expect(screen.getByText('Not interested (auto)')).toBeInTheDocument();
  });

  it('a partner row shows the Request a tour LINK in place of Interested', () => {
    renderRow({ interestedSupported: false }, { name: 'Cora Reyes', requestTourTo: '/listings/u1?tour=new' });
    expect(screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' })).toHaveAttribute('href', '/listings/u1?tour=new');
    expect(screen.queryByRole('button', { name: /interested in/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Cora Reyes not interested in 12 Oak St' })).toBeInTheDocument();
  });

  // B8: the HOST passes requestTourTo only for a partner recipient, so a
  // landlord / team-member row (interestedSupported false, no requestTourTo)
  // renders neither - the host-level landlord negatives are in 5.3 / 5.4.
  it('a non-tenant row without requestTourTo (a landlord row) shows neither Interested nor the link', () => {
    renderRow({ interestedSupported: false });
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mark Tia Moss interested/ })).not.toBeInTheDocument();
  });

  it('actionsDisabled (a deleted property) and recipientMissing keep the chip but drop every action', () => {
    renderRow({}, { actionsDisabled: true });
    expect(screen.getByText('No reply yet')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('a missing recipient has no actions', () => {
    renderRow({ recipientMissing: true, interestedSupported: false }, { requestTourTo: '/listings/u1?tour=new' });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
  });

  it('the kind label sits OUTSIDE the identity link', () => {
    renderRow({}, { kind: 'Caseworker' });
    expect(screen.getByRole('link', { name: 'Tia Moss' })).toHaveAttribute('href', '/contacts/c-1');
    expect(screen.getByText('Caseworker')).toBeInTheDocument();
  });
});

describe('SendRosterRow - actions', () => {
  it('Not interested calls onOutcome and disables itself while in flight', async () => {
    let resolve!: () => void;
    const onOutcome = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderRow({}, { onOutcome });
    const button = screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' });
    await userEvent.click(button);
    expect(onOutcome).toHaveBeenCalledWith('not_interested');
    expect(button).toBeDisabled();
    resolve();
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  it("Interested in 'route' mode calls the route", async () => {
    const { onOutcome } = renderRow();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(onOutcome).toHaveBeenCalledWith('interested');
  });

  it("'form' mode: onOpenTourForm, never onOutcome", async () => {
    const onOpenTourForm = vi.fn();
    const { onOutcome } = renderRow({}, { interestedMode: 'form', onOpenTourForm });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(onOpenTourForm).toHaveBeenCalledTimes(1);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("'form' mode with no form host shows Not interested but no Interested button", () => {
    renderRow({}, { interestedMode: 'form' });
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).not.toBeInTheDocument();
  });

  it('Undo calls clear', async () => {
    const { onOutcome } = renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    await userEvent.click(screen.getByRole('button', { name: 'Undo not interested for Tia Moss' }));
    expect(onOutcome).toHaveBeenCalledWith('clear');
  });

  it('a failure shows the inline error; a 503 saved shows the saved line; the next attempt clears it', async () => {
    const onOutcome = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true }))
      .mockResolvedValueOnce(undefined);
    renderRow({}, { onOutcome });
    const button = screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save - try again.");
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved - reload to see the change.');
    await userEvent.click(button);
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('interestedModeOf', () => {
  it("'route' for a unit with a tour_type, else 'form' (absent unit included)", () => {
    expect(interestedModeOf({ tour_type: 'self_guided' })).toBe('route');
    expect(interestedModeOf({})).toBe('form');
    expect(interestedModeOf(undefined)).toBe('form');
  });
});
```

RED today: `SendRosterRow` takes `{ to, identity, kind, tour }` and renders a
`<div>` root (`Card.tsx:218-247`); `interestedModeOf` / `SendRosterRowProps` /
`SendRosterList` do not exist.

GREEN - `dashboard/src/routes/contact/Card.tsx`:

- Imports `:6-9` become:

```tsx
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InterestedMode, ListingSendRow, TourSignalState } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';
import { outcomeErrorCopy } from '../../lib/listingOutcomeErrors.js';
import styles from './Card.module.css';
```

- Replace `SendRosterRow` (`:212-247`) with:

```tsx
/** What a send-roster row's action asks the outcome route for. */
export type SendRowAction = 'interested' | 'not_interested' | 'clear';

/** last-heard-from spec 14.3 B2: the contact page derives the Interested mode
 *  from the units it already loaded ('route' = one click creates the tour). An
 *  absent unit (deleted, or not loaded) reads 'form'. */
export function interestedModeOf(unit: { tour_type?: string } | undefined): InterestedMode {
  return typeof unit?.tour_type === 'string' && unit.tour_type.length > 0 ? 'route' : 'form';
}

export interface SendRosterRowProps {
  /** The identity link's route (a contact on the property card, a property on a contact card). */
  to: string;
  identity: React.ReactNode;
  /** caseworkers D20: a muted label after the identity link, outside it. */
  kind?: string;
  /** The whole wire row (outcome, dates, tour, decline). */
  row: ListingSendRow;
  /** For the accessible names: the property's (short) address ... */
  address: string;
  /** ... and the person's name. */
  name: string;
  /** Computed by the host (server on the property card, file.units on the contact page). */
  interestedMode: InterestedMode;
  /** A deleted property: outcomes show, actions do not (spec 14.3 B10). */
  actionsDisabled?: boolean;
  /** Calls the outcome route and applies the returned row; rejects on failure. */
  onOutcome: (outcome: SendRowAction) => Promise<void>;
  /** A Link to /listings/:unitId?tour=new (head 3.4 #1). The HOST passes it
   *  ONLY for a PARTNER recipient (B8: the units route's `row.type`, or the
   *  contact page's own type) - never for a landlord or team-member row. */
  requestTourTo?: string;
  /** Render that link with `replace` (the property page, whose tour dialog
   *  adds no history entry - task 5.3); the contact pages leave it a push. */
  requestTourReplace?: boolean;
  /** interestedMode 'form' on a tenant row: open the Schedule tour form. */
  onOpenTourForm?: () => void;
  now: Date;
}

/** The outcome chip (spec 5.5). `interested` IS the tour chip - no second chip. */
function OutcomeChip({ row, now }: { row: ListingSendRow; now: Date }): React.JSX.Element | null {
  const chip = styles.outcomeChip ?? '';
  switch (row.outcome) {
    case 'no_reply':
      return <span className={chip}>No reply yet</span>;
    case 'replied':
      return <span className={`${chip} ${styles.chipPositive ?? ''}`}>Replied</span>;
    case 'interested':
      // Head 3.4 #5: an interested row whose response carries no `tour` reads `Interested`.
      return row.tour ? <TourChip tourId={row.tour.tourId} state={row.tour.state} /> : <span className={chip}>Interested</span>;
    case 'not_interested': {
      const title = row.declined !== undefined ? formatHeardFrom(row.declined.at, now).title : '';
      return (
        <span className={`${chip} ${styles.chipMuted ?? ''}`} {...(title !== '' && { title })}>
          {row.declined?.by === 'engine' ? 'Not interested (auto)' : 'Not interested'}
        </span>
      );
    }
    default:
      return null;
  }
}

/** The list every send-roster host wraps its rows in (markup R1, plan head
 *  3.4 #10): a `<ul>` named by `label` (a property-card group - `Waiting`,
 *  `Interested`, `Not interested`, `Not eligible` - or `Properties sent` on a
 *  contact card). Its children are SendRosterRows only, so every listitem in a
 *  card is one roster row. */
export function SendRosterList({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <ul className={styles.sendList} aria-label={label}>
      {children}
    </ul>
  );
}

/** A send-roster row (last-heard-from spec 5.5): line one is the identity
 *  link (+ kind) and the muted "Sent <date> - Last heard from <date>"; line
 *  two is the outcome chip and the outcome's actions. The root is an `<li>`
 *  (markup R1) and must sit inside a SendRosterList. The row is NOT a
 *  full-row link (the identity, the tour chip and the actions go to different
 *  places). An action disables itself while in flight and the host replaces
 *  the row with the route's answer; a failure shows an inline error and
 *  leaves the row unchanged. */
export function SendRosterRow({
  to,
  identity,
  kind,
  row,
  address,
  name,
  interestedMode,
  actionsDisabled = false,
  onOutcome,
  requestTourTo,
  requestTourReplace = false,
  onOpenTourForm,
  now,
}: SendRosterRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (outcome: SendRowAction): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onOutcome(outcome)
      .catch((err: unknown) => setError(outcomeErrorCopy(err)))
      .finally(() => setBusy(false));
  };
  const sent = formatHeardFrom(row.sentAt, now);
  const heard = formatHeardFrom(row.lastHeardFromAt, now);
  const showActions = !actionsDisabled && row.recipientMissing !== true;
  const waiting = row.outcome === 'no_reply' || row.outcome === 'replied';
  const canInterested = waiting && row.interestedSupported && (interestedMode === 'route' || onOpenTourForm !== undefined);
  return (
    <li className={styles.sendRow}>
      <div className={styles.sendRowLine}>
        <span className={styles.liLabel}>
          <Link className={styles.rowLink ?? ''} to={to}>
            {identity}
          </Link>
          {kind !== undefined ? <span className={styles.rowKind}>{kind}</span> : null}
        </span>
        <span className={styles.sendRowDates}>
          <span title={sent.title}>Sent {sent.label}</span>
          {' - '}
          <span title={heard.title}>Last heard from {heard.label}</span>
        </span>
      </div>
      <div className={styles.sendRowLine}>
        <OutcomeChip row={row} now={now} />
        {showActions ? (
          <span className={styles.rowActions}>
            {canInterested ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Mark ${name} interested in ${address}`}
                disabled={busy}
                onClick={() => (interestedMode === 'route' ? run('interested') : onOpenTourForm?.())}
              >
                Interested
              </button>
            ) : null}
            {waiting && !row.interestedSupported && requestTourTo !== undefined ? (
              <Link
                className={styles.rowActionLink}
                to={requestTourTo}
                replace={requestTourReplace}
                aria-label={`Request a tour for ${name} at ${address}`}
              >
                Request a tour
              </Link>
            ) : null}
            {waiting ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Mark ${name} not interested in ${address}`}
                disabled={busy}
                onClick={() => run('not_interested')}
              >
                Not interested
              </button>
            ) : null}
            {row.outcome === 'not_interested' ? (
              <button
                type="button"
                className={styles.rowButton}
                aria-label={`Undo not interested for ${name}`}
                disabled={busy}
                onClick={() => run('clear')}
              >
                Undo
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className={styles.rowError}>
          {error}
        </p>
      ) : null}
    </li>
  );
}
```

- `dashboard/src/routes/contact/Card.module.css` - insert after `.rowKind`
  (`:212-217`):

```css
/* last-heard-from markup R1: the roster list (SendRosterList) - a bare <ul>
 * whose only children are SendRosterRow <li>s. */
.sendList {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* last-heard-from spec 5.5: the two-line send-roster row (SendRosterRow, an
 * <li>). Line one: identity (+ kind) and the muted dates; line two: the
 * outcome chip and its actions. Both lines wrap on a narrow card. */
.sendRow {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-1) 0;
  border-bottom: 1px solid var(--c-surface-2);
  font-size: var(--fs-sm);
  color: var(--c-text);
}

.sendRow:last-child {
  border-bottom: none;
}

.sendRowLine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1) var(--sp-2);
  min-width: 0;
}

.sendRowDates {
  margin-left: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
}

/* The outcome chip: a small pill (unlike the text-only response tones). */
.outcomeChip {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-2);
  border: 1px solid var(--c-evt-neutral-border);
  border-radius: var(--radius-pill);
  background: var(--c-evt-neutral-bg);
  color: var(--c-evt-neutral-text);
  font-size: var(--fs-xs);
  line-height: 1.6;
}

.chipPositive {
  border-color: var(--c-evt-green-border);
  background: var(--c-evt-green-bg);
  color: var(--c-evt-green-text);
}

.chipMuted {
  background: transparent;
  color: var(--c-text-muted);
}

.rowActions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

/* The small row action buttons (Interested / Not interested / Undo). */
.rowButton {
  font: inherit;
  font-size: var(--fs-xs);
  line-height: 1.8;
  padding: 0 var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text);
  cursor: pointer;
}

.rowButton:hover:not(:disabled) {
  border-color: var(--c-border-strong);
}

.rowButton:disabled {
  opacity: 0.6;
  cursor: default;
}

.rowActionLink {
  font-size: var(--fs-xs);
  color: var(--c-brand);
}

.rowButton:focus-visible,
.rowActionLink:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

/* The inline action error under a row. */
.rowError {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-danger);
}
```

  Also update the comment at `:161-163` ("The identity link in a send-roster
  row") - unchanged meaning, no edit needed.

- The three hosts must compile against the new props in THIS commit. They
  render read-only rows (outcome chip + dates, no actions) until 5.3 / 5.4
  wire the actions in the same spots; the `now` state added here is final:
  - `ListingDetail.tsx`: add `const [now] = useState(() => new Date());`
    after `:245` (a lazy initializer keeps render pure; before the early
    returns at `:296-314`), add `interestedModeOf, SendRosterList` to the
    Card import (`:45`), wrap the `recipients.rows.map(...)` at `:1140-1153`
    in ONE `<SendRosterList label="Sent to">...</SendRosterList>` (R1; task
    5.3 replaces it with the four labelled group lists), and replace the
    `SendRosterRow` element at `:1145-1151` with:

```tsx
                      <SendRosterRow
                        key={`${row.contactId}:${row.sentAt}`}
                        to={`/contacts/${row.contactId}`}
                        identity={row.tenantName ?? row.contactId}
                        {...(kind !== undefined && { kind })}
                        row={row}
                        address={address}
                        name={row.tenantName ?? row.contactId}
                        interestedMode={row.interestedMode ?? interestedModeOf(unit)}
                        actionsDisabled
                        onOutcome={() => Promise.resolve()}
                        now={now}
                      />
```

  - `TenantFile.tsx`: add `import { useState } from 'react';` above `:9`,
    `interestedModeOf, SendRosterList` to the Card import (`:24-36`), the
    first body line `const [now] = useState(() => new Date());` (before
    `:143`), wrap the `listingsSent.map(...)` at `:311-318` in
    `<SendRosterList label="Properties sent">...</SendRosterList>` (R1, final),
    and replace the element at `:312-317` with:

```tsx
            <SendRosterRow
              key={`${s.unitId}:${s.sentAt}`}
              to={`/listings/${s.unitId}`}
              identity={unitLabel(unitMap, s.unitId)}
              row={s}
              address={unitLabel(unitMap, s.unitId)}
              name={unitLabel(unitMap, s.unitId)}
              interestedMode={interestedModeOf(unitMap.get(s.unitId))}
              actionsDisabled
              onOutcome={() => Promise.resolve()}
              now={now}
            />
```

  - `PartnerFile.tsx`: the same edits (`useState` import, Card import `:15`
    gains `interestedModeOf, SendRosterList`, `const [now] = useState(() =>
    new Date());` as the first body line before `:81`, the
    `listingsSent.map(...)` at `:173-179` wrapped in
    `<SendRosterList label="Properties sent">`), and `:174-178` becomes the
    TenantFile element above with `sentUnitLabel` in place of `unitLabel`.
  - R1 audit of the three cards: the only other content inside each card is
    `EmptyRow` / `PendingPanel` (`<p>`, `Card.tsx:79-88`) and the card aside -
    no other listitem exists in a "Sent to" / "Properties sent" card.
- KNOWING rewrites of `dashboard/src/routes/listing/ListingDetail.test.tsx`
  (findings C2) land HERE, because this is the first commit that breaks them
  (the untyped `vi.fn()` mock rows carry no `outcome`, so a toured row would
  render no chip, and rows now hold dates):
  - `:503-518`: the fixture row gains
    `outcome: 'no_reply', interestedSupported: true, interestedMode: 'route', eligible: true`;
    assertions unchanged (`'No reply'` exact text matches nothing - the new
    chip reads `No reply yet`).
  - `:520-535`: the same four fields on the fixture row.
  - `:537-561`: the tenant / partner / landlord rows gain
    `outcome: 'no_reply', eligible: true, interestedMode: 'route'`, with
    `interestedSupported: true` on `c-ten` only (`false` on the others);
    `c-gone` gains
    `outcome: 'no_reply', interestedSupported: false, eligible: false, recipientMissing: true`.
    `:559-560` (a row's `textContent` EQUALS the name) become:

```tsx
    // Tenant and unresolved rows carry NO kind label (rows grew dates and an
    // outcome chip, so the old textContent-equals-name check was rewritten).
    for (const name of ['Tia Moss', 'c-gone']) {
      for (const label of ['Tenant', 'Partner', 'Caseworker', 'Landlord']) {
        expect(within(rowOf(name)).queryByText(label)).not.toBeInTheDocument();
      }
    }
```

    (`rowOf`, `:553-554`, resolves `closest('div')` = the row's first line
    inside its `<li>`, which holds the identity link and the kind label -
    unchanged.)
  - `:563-579`: each row gains
    `outcome: 'interested', interestedSupported: true, interestedMode: 'route', eligible: true`.
  Other host tests stay green: the files.test.tsx fixtures already carry
  `outcome` (task 3.8), so their tour-chip cases still find the chip, and
  `ContactDetail.test.tsx:3002-3033` still finds no `Toured` link (a partner
  row's outcome is never the tour chip).

Commit: `feat(dashboard): SendRosterRow - outcome chip, dates and actions`.

### Task 5.2 - per-row setters on `useListing` and `useContactFile`

RED:

1. `dashboard/src/routes/listing/useListing.test.tsx` (the `renderHook`
   pattern at `:184-240`; mocks at `:16-42`):

```tsx
  it('setRecipientRow replaces ONE row in place, bound to the unit it was called for', async () => {
    const r1 = { contactId: 'c-1', unitId: 'u1', sentAt: '2026-10-01T10:00:00.000Z', via: 'broadcast' as const, outcome: 'no_reply' as const, interestedSupported: true };
    const r2 = { ...r1, contactId: 'c-2' };
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockResolvedValue([r1, r2]);
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.recipients.status).toBe('ready'));

    const declined = { ...r1, outcome: 'not_interested' as const, declined: { at: '2026-10-02T10:00:00.000Z', by: 'staff' as const } };
    act(() => result.current.setRecipientRow('u1', 'c-1', declined));
    expect(result.current.recipients).toEqual({ status: 'ready', rows: [declined, r2] });

    // A late answer for another property is a no-op (the setUnit forId guard).
    act(() => result.current.setRecipientRow('u-other', 'c-2', { ...r2, outcome: 'replied' }));
    expect(result.current.recipients).toEqual({ status: 'ready', rows: [declined, r2] });
    // An unknown contact is a no-op (never an append).
    act(() => result.current.setRecipientRow('u1', 'c-9', { ...r2, contactId: 'c-9' }));
    expect(result.current.recipients.status === 'ready' && result.current.recipients.rows).toHaveLength(2);
  });
```

2. `dashboard/src/routes/contact/useContactFile.test.tsx` (add `renderHook`
   and `act` to the `@testing-library/react` import at `:1`):

```tsx
  it('setListingSentRow replaces ONE Properties-sent row, bound to the contact it was called for', async () => {
    const r1 = { contactId: 'k1', unitId: 'u1', sentAt: '2026-10-01T10:00:00.000Z', via: 'broadcast' as const, outcome: 'no_reply' as const, interestedSupported: true };
    const r2 = { ...r1, unitId: 'u2' };
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([r1, r2]);
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    const { result } = renderHook(() => useContactFile('k1'));
    await waitFor(() => expect(result.current.listingsSent.status).toBe('ready'));

    const replied = { ...r2, outcome: 'replied' as const };
    act(() => result.current.setListingSentRow('k1', 'u2', replied));
    expect(result.current.listingsSent).toEqual({ status: 'ready', rows: [r1, replied] });
    act(() => result.current.setListingSentRow('someone-else', 'u1', { ...r1, outcome: 'replied' }));
    expect(result.current.listingsSent).toEqual({ status: 'ready', rows: [r1, replied] });
  });
```

RED today: neither setter exists.

GREEN:

- `dashboard/src/routes/listing/useListing.ts`:
  - `ListingState` (`:49-70`) gains after `setUnit` (`:55`):

```ts
  /** Replace ONE "Sent to" row in place after an outcome action (the route
   *  RETURNS the re-projected row) - no refetch. Bound to the unitId passed:
   *  a late answer for property A after a history move to B is a no-op (the
   *  setUnit precedent). An unknown contactId, or a slice that is not
   *  'ready', is left alone. */
  setRecipientRow: (unitId: string, contactId: string, row: ListingSendRow) => void;
```

  - `LOADING` (`:71`) type becomes `Omit<ListingState, 'setUnit' | 'setRecipientRow'>`;
    the `useState` generic at `:136` becomes
    `Omit<ListingState, 'setUnit' | 'setRecipientRow'> & { forId: string }`.
  - After `setUnit` (`:148-172`):

```ts
  const setRecipientRow = useCallback((forUnitId: string, contactId: string, row: ListingSendRow) => {
    setState((prev) => {
      if (prev.forId !== forUnitId || prev.recipients.status !== 'ready') return prev;
      const index = prev.recipients.rows.findIndex((r) => r.contactId === contactId);
      if (index < 0) return prev;
      const rows = prev.recipients.rows.slice();
      rows[index] = row;
      return { ...prev, recipients: { status: 'ready', rows } };
    });
  }, []);
```

  - The returns `:240-241` become
    `if (state.forId !== unitId) return { ...LOADING, setUnit, setRecipientRow };`
    and `return { ...state, setUnit, setRecipientRow };`; the return type at
    `:131` becomes `ListingState` (it already includes both setters).
  - `dashboard/src/routes/listing/ListingDetail.test.tsx:83` - `READY` gains
    `setRecipientRow: vi.fn(),` after `setUnit: vi.fn(),` (the type now
    requires it).

- `dashboard/src/routes/contact/useContactFile.ts`:
  - `ContactFile` (`:91-105`) gains after `refetch`:

```ts
  /** Replace ONE Properties-sent row in place after an outcome action - no
   *  refetch. Bound to the contactId passed (a late answer for contact A
   *  after a move to B is a no-op); an unknown unitId or a non-ready slice is
   *  left alone. */
  setListingSentRow: (contactId: string, unitId: string, row: ListingSendRow) => void;
```

  - After `refetch` (`:120`):

```ts
  const setListingSentRow = useCallback((forContactId: string, unitId: string, row: ListingSendRow) => {
    setState((prev) => {
      if (prev.forId !== forContactId || prev.listingsSent.status !== 'ready') return prev;
      const index = prev.listingsSent.rows.findIndex((r) => r.unitId === unitId);
      if (index < 0) return prev;
      const rows = prev.listingsSent.rows.slice();
      rows[index] = row;
      return { ...prev, listingsSent: { status: 'ready', rows } };
    });
  }, []);
```

  - The returns `:214-215` add `setListingSentRow` beside `refetch`.

Commit: `feat(dashboard): per-row setters for the two send rosters`.

### Task 5.3 - the property card: the four group lists, the URL-only tour form (R4), deleted property

Markup contracts delivered here (plan head 3.4 #10): R1 - each non-empty
group is a `SendRosterList` (`<ul>`) named `Waiting` / `Interested` /
`Not interested` / `Not eligible`, whose children are the group's rows (each
an `<li>`); nothing else in the card is a listitem. R4 - the Schedule a tour
form on this page opens ONLY from the URL: a form-mode Interested click
NAVIGATES (`setSearchParams`) to `?tour=new&tenantId=<id>`, "+ Tour" to
`?tour=new`, a partner row's `Request a tour` link to `?tour=new`; the
param-driven host opens the form (tenant LOCKED when `tenantId` is set);
Cancel and create clear BOTH params. There is no local-state open path.
Both the open and the close are `{ replace: true }` (the partner link on this
page renders with `replace` too), so the dialog never adds a history entry
and Back after Cancel leaves the property page exactly as before (plan
review round 2).

RED:

1. `dashboard/src/routes/listing/listingFormat.test.ts` - a new describe
   (import `groupSendRows` and `type ListingSendRow`):

```ts
describe('groupSendRows - the four groups that cover every row (spec 5.5)', () => {
  const row = (contactId: string, sentAt: string, over: Partial<ListingSendRow>): ListingSendRow => ({
    contactId,
    unitId: 'u1',
    sentAt,
    via: 'broadcast',
    outcome: 'no_reply',
    interestedSupported: true,
    eligible: true,
    ...over,
  });

  it('Waiting (eligible, newest first), Interested, Not interested, Not eligible - always four, in order', () => {
    const rows = [
      row('ne-waiting', '2026-10-09T00:00:00.000Z', { eligible: false }),
      row('w-old', '2026-10-01T00:00:00.000Z', { outcome: 'replied' }),
      row('ni', '2026-10-08T00:00:00.000Z', { outcome: 'not_interested' }),
      row('missing-ni', '2026-10-10T00:00:00.000Z', { outcome: 'not_interested', recipientMissing: true, eligible: false }),
      row('int', '2026-10-02T00:00:00.000Z', { outcome: 'interested' }),
      row('w-new', '2026-10-05T00:00:00.000Z', {}),
    ];
    const groups = groupSendRows(rows);
    expect(groups.map((g) => [g.key, g.label, g.rows.map((r) => r.contactId)])).toEqual([
      ['waiting', 'Waiting', ['w-new', 'w-old']],
      ['interested', 'Interested', ['int']],
      ['not_interested', 'Not interested', ['ni']],
      ['not_eligible', 'Not eligible', ['missing-ni', 'ne-waiting']],
    ]);
    // A cover: every row exactly once.
    expect(groups.flatMap((g) => g.rows.map((r) => r.contactId)).sort()).toEqual(rows.map((r) => r.contactId).sort());
  });

  it('a row with no eligible flag is Not eligible (only the units route sets it); empty groups stay empty', () => {
    const groups = groupSendRows([row('a', '2026-10-01T00:00:00.000Z', { eligible: undefined })]);
    expect(groups.map((g) => g.rows.length)).toEqual([0, 0, 0, 1]);
  });
});
```

2. `dashboard/src/routes/listing/ListingDetail.test.tsx`:
   - mocks (`:14-58`): add `const setListingSendOutcome = vi.fn();` and
     `const createTour = vi.fn();` and the two mock entries
     `setListingSendOutcome: (...a: unknown[]) => setListingSendOutcome(...a),`
     `createTour: (...a: unknown[]) => createTour(...a),`.
   - `renderAt` (`:69-79`) gains a `search = ''` parameter:
     `initialEntries={[`/listings/${unitId}${search}`]}` (additive; every
     existing call keeps its meaning).
   - The findings-C2 knowing rewrites of `:503-579` already landed in task
     5.1 (the first commit that broke them).
   - The existing `'Tours card has a "+ Tour" action ...'` case (`:1070-1092`)
     stays as it is and must stay green: "+ Tour" now navigates to
     `?tour=new` and the param-driven host opens the same dialog (free tenant
     typeahead, unit pre-committed).
   - New cases (every case uses `unit: { ...READY.unit!, address: { line1: '12 Oak St' } }`
     so the accessible names read `... in 12 Oak St`; `setListingSendOutcome`
     resolves `{ row }` - plan head 3.4 #4):

```tsx
describe('ListingDetail - "Sent to" outcomes (last-heard-from spec 5.5)', () => {
  const unit = { ...READY.unit!, address: { line1: '12 Oak St' } };
  const sent = (over: Record<string, unknown> = {}) => ({
    contactId: 'c-1', unitId: 'u1', sentAt: '2026-10-01T10:00:00.000Z', via: 'broadcast', tenantName: 'Tia Moss',
    outcome: 'no_reply', interestedSupported: true, interestedMode: 'route', eligible: true, ...over,
  });
  const card = (): HTMLElement => screen.getByRole('heading', { name: /^Sent to\b/ }).closest('section') as HTMLElement;

  beforeEach(() => {
    setListingSendOutcome.mockReset();
    createTour.mockReset();
    getAllContacts.mockResolvedValue([{ contactId: 'c-1', type: 'tenant', firstName: 'Tia', lastName: 'Moss' }]);
    getAllUnits.mockResolvedValue([{ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '12 Oak St' } }]);
  });

  it('renders the rows as four named lists in order - Waiting, Interested, Not interested, Not eligible (R1)', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ contactId: 'c-ne', tenantName: 'Ned Ineligible', eligible: false, sentAt: '2026-10-09T10:00:00.000Z' }),
          sent({ contactId: 'c-ni', tenantName: 'Nia Declined', outcome: 'not_interested', declined: { at: '2026-10-03T10:00:00.000Z', by: 'staff' } }),
          sent({ contactId: 'c-in', tenantName: 'Ian Toured', outcome: 'interested', tour: { tourId: 't-1', state: 'toured' } }),
          sent({ contactId: 'c-w', tenantName: 'Wes Waiting', sentAt: '2026-10-05T10:00:00.000Z' }),
          sent({ contactId: 'c-w2', tenantName: 'Wanda Older', sentAt: '2026-10-02T10:00:00.000Z' }),
        ],
      },
    });
    renderAt();
    const lists = within(card()).getAllByRole('list');
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual(['Waiting', 'Interested', 'Not interested', 'Not eligible']);
    // Every listitem in the card is one roster row - 5 rows, 5 listitems.
    expect(within(card()).getAllByRole('listitem')).toHaveLength(5);
    const namesIn = (label: string): Array<string | null> =>
      within(within(card()).getByRole('list', { name: label }))
        .getAllByRole('listitem')
        .map((li) => within(li).getAllByRole('link').find((a) => a.getAttribute('href')?.startsWith('/contacts/'))?.textContent ?? null);
    expect(namesIn('Waiting')).toEqual(['Wes Waiting', 'Wanda Older']);
    expect(namesIn('Interested')).toEqual(['Ian Toured']);
    expect(namesIn('Not interested')).toEqual(['Nia Declined']);
    expect(namesIn('Not eligible')).toEqual(['Ned Ineligible']);
  });

  it('an empty group renders no list', () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    expect(within(card()).getAllByRole('list').map((l) => l.getAttribute('aria-label'))).toEqual(['Waiting']);
    expect(within(card()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('Not interested calls the route and applies the returned { row } through setRecipientRow', async () => {
    const setRecipientRow = vi.fn();
    const returned = sent({ outcome: 'not_interested', declined: { at: '2026-10-13T10:00:00.000Z', by: 'staff' } });
    setListingSendOutcome.mockResolvedValue({ row: returned });
    useListing.mockReturnValue({ ...READY, unit, setRecipientRow, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c-1', 'not_interested');
    await waitFor(() => expect(setRecipientRow).toHaveBeenCalledWith('u1', 'c-1', returned));
  });

  it("Interested in 'route' mode calls the route with interested", async () => {
    setListingSendOutcome.mockResolvedValue({ row: sent({ outcome: 'interested', tour: { tourId: 't-new', state: 'requested' } }) });
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c-1', 'interested');
  });

  it("Interested in 'form' mode NAVIGATES to ?tour=new&tenantId=, the form opens with the tenant LOCKED, creates nothing, and Cancel clears both params (R4)", async () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent({ interestedMode: 'form' })] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/listings/u1?tour=new&tenantId=c-1'));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tia Moss'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveValue('12 Oak St'));
    expect(setListingSendOutcome).not.toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument());
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/);
  });

  it('a PARTNER row links "Request a tour" to ?tour=new on this page; the form opens with NO tenant, and Cancel clears the params', async () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: { status: 'ready', rows: [sent({ contactId: 'c-cw', tenantName: 'Cora Reyes', type: 'partner', role: 'Caseworker', interestedSupported: false })] },
    });
    renderAt();
    const link = screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' });
    expect(link).toHaveAttribute('href', '/listings/u1?tour=new');
    await userEvent.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    expect(within(dialog).getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument());
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/);
  });

  it('a LANDLORD row gets NO "Request a tour" link and no Interested button - only Not interested (B8)', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: { status: 'ready', rows: [sent({ contactId: 'c-ll', tenantName: 'Lee Park', type: 'landlord', interestedSupported: false })] },
    });
    renderAt();
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Lee Park interested in 12 Oak St' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Lee Park not interested in 12 Oak St' })).toBeInTheDocument();
  });

  it('the dialog adds NO history entry: open (Interested, + Tour or the partner link) then Cancel, and Back leaves the property page', async () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ interestedMode: 'form' }),
          sent({ contactId: 'c-cw', tenantName: 'Cora Reyes', type: 'partner', interestedSupported: false }),
        ],
      },
    });
    function Back(): React.JSX.Element {
      const navigate = useNavigate();
      return <button type="button" onClick={() => void navigate(-1)}>test-back</button>;
    }
    render(
      <MemoryRouter initialEntries={['/elsewhere', '/listings/u1']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
        <Back />
      </MemoryRouter>,
    );
    const cancel = async (): Promise<void> => {
      const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/));
    };
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    await cancel();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule a tour on this property' }));
    await cancel();
    await userEvent.click(screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' }));
    await cancel();
    // Three open/cancel cycles, still ONE entry for the property page.
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/elsewhere$/));
  });

  it('the URL entry ?tour=new&tenantId= opens the form on load with that tenant locked', async () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [] } });
    renderAt('u1', '?tour=new&tenantId=c-1');
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tia Moss'));
  });

  it('after a create from the URL entry, Back returns to the card WITHOUT reopening the form', async () => {
    createTour.mockResolvedValue({ tourId: 't-new', tenantId: 'c-1', unitId: 'u1', tourType: 'self_guided', status: 'requested' });
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [] } });
    function Back(): React.JSX.Element {
      const navigate = useNavigate();
      return <button type="button" onClick={() => void navigate(-1)}>test-back</button>;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u1?tour=new&tenantId=c-1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
        <Back />
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Schedule$/ })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Schedule$/ }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/tours/t-new'));
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/));
    expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument();
  });

  it('a deleted property shows the outcomes but no actions, and ?tour=new does not open the form', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...unit, deleted_at: '2026-10-01T00:00:00.000Z' },
      recipients: { status: 'ready', rows: [sent()] },
    });
    renderAt('u1', '?tour=new');
    expect(within(card()).getByText('No reply yet')).toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: /^Mark / })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument();
  });
});
```

RED today: no `groupSendRows`; the card renders one `<div>` row per send in
wire order, calls no route, and ignores `?tour=new`.

GREEN:

- `dashboard/src/routes/listing/listingFormat.ts` - append (and add
  `type ListingSendRow` to its api import if not already there; it is used by
  `sendRowKindLabel` at `:241`):

```ts
/** One property "Sent to" group (last-heard-from spec 5.5): its key and the
 *  accessible name of its list (markup R1). */
export interface SendRowGroup {
  key: 'waiting' | 'interested' | 'not_interested' | 'not_eligible';
  label: 'Waiting' | 'Interested' | 'Not interested' | 'Not eligible';
  rows: ListingSendRow[];
}

/**
 * last-heard-from spec 5.5: the property "Sent to" card's four groups, ALWAYS
 * returned in this order (empty ones included; the host skips them), which
 * together cover every row, each newest sentAt first: Waiting (no_reply /
 * replied on an ELIGIBLE recipient - the eligibility half only, no
 * lookback/quiet thresholds), Interested, Not interested, Not eligible (a
 * waiting outcome on an ineligible recipient, and EVERY row whose contact is
 * missing). `eligible` absent counts as not eligible.
 */
export function groupSendRows(rows: readonly ListingSendRow[]): SendRowGroup[] {
  const groups: SendRowGroup[] = [
    { key: 'waiting', label: 'Waiting', rows: [] },
    { key: 'interested', label: 'Interested', rows: [] },
    { key: 'not_interested', label: 'Not interested', rows: [] },
    { key: 'not_eligible', label: 'Not eligible', rows: [] },
  ];
  const indexOf = (r: ListingSendRow): number => {
    if (r.recipientMissing === true) return 3;
    if (r.outcome === 'interested') return 1;
    if (r.outcome === 'not_interested') return 2;
    return r.eligible === true ? 0 : 3;
  };
  const newestFirst = [...rows].sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  for (const r of newestFirst) groups[indexOf(r)]!.rows.push(r);
  return groups;
}
```

- `dashboard/src/routes/listing/ListingDetail.tsx`:
  - `:16` becomes `import { useNavigate, useParams, useSearchParams } from 'react-router-dom';`
  - the api import `:17-33` gains `setListingSendOutcome,` (alphabetical
    position after `setUnitPhotoCover`) and `type ListingSendRow`.
  - the `listingFormat` import gains `groupSendRows` (`interestedModeOf` and
    `SendRosterList` joined the Card import in 5.1).
  - `:244-246` - DELETE the `schedulingTour` state and its comment (there is
    no local open state any more) and replace them with:

```tsx
  // The "Schedule a tour" dialog (markup R4) opens ONLY from the URL:
  // `?tour=new` (free tenant) or `?tour=new&tenantId=<id>` (that tenant
  // pre-committed and LOCKED in the form, spec 14.3 B9), unit side
  // pre-committed to this property. Every entry point NAVIGATES there - "+
  // Tour", a form-mode Interested click, a partner row's "Request a tour"
  // link, and the waiting list on another page - so a param change while this
  // page is mounted opens it, and Cancel / create clear both params so Back
  // and refresh never reopen it. On this page both the open and the close are
  // REPLACE navigations: the dialog adds no history entry.
  const [searchParams, setSearchParams] = useSearchParams();
  const { setUnit, setRecipientRow } = state;
```

    (the `now` state task 5.1 added after this block stays where it is.)

  - after `goToSend` (`:371`), add:

```tsx
  // The URL-driven tour form (never on a deleted property - "+ Tour" is hidden
  // there too).
  const tourFormOpen = !deleted && searchParams.get('tour') === 'new';
  const tourFormTenant = searchParams.get('tenantId') ?? undefined;
  /** Open the form by NAVIGATING in place (replace): the dialog adds NO
   *  history entry, so open + Cancel leaves one entry and Back leaves the
   *  property page as before (plan review round 2). */
  const openTourForm = (tenantId?: string): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tour', 'new');
        if (tenantId !== undefined) next.set('tenantId', tenantId);
        else next.delete('tenantId');
        return next;
      },
      { replace: true },
    );
  };
  /** Close it: strip BOTH params in place (replace). */
  const closeTourForm = (): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('tour');
        next.delete('tenantId');
        return next;
      },
      { replace: true },
    );
  };
  // One outcome action on a "Sent to" row: the route answers { row } (plan
  // head 3.4 #4), applied in place (no refetch). A rejection propagates to
  // the row, which shows its inline error.
  const onRecipientOutcome = async (contactId: string, outcome: 'interested' | 'not_interested' | 'clear'): Promise<void> => {
    const { row } = await setListingSendOutcome(unit.unitId, contactId, outcome);
    setRecipientRow(unit.unitId, contactId, row);
  };
```

  - the Sent to card's ready branch (`:1139-1154`, the single interim
    `SendRosterList label="Sent to"` from 5.1 included) becomes:

```tsx
                recipients.rows.length === 0 ? (
                  <EmptyRow>Not sent to anyone yet.</EmptyRow>
                ) : (
                  groupSendRows(recipients.rows)
                    .filter((group) => group.rows.length > 0)
                    .map((group) => (
                      // Markup R1: one named list per non-empty group; its
                      // children are roster rows only.
                      <SendRosterList key={group.key} label={group.label}>
                        {group.rows.map((row: ListingSendRow) => {
                          // caseworkers D20/D22: a resolved non-tenant row is labelled by
                          // its displayKind; tenant and unresolved rows are not.
                          const kind = sendRowKindLabel(row);
                          const name = row.tenantName ?? row.contactId;
                          return (
                            <SendRosterRow
                              key={`${row.contactId}:${row.sentAt}`}
                              to={`/contacts/${row.contactId}`}
                              identity={name}
                              {...(kind !== undefined && { kind })}
                              row={row}
                              address={address}
                              name={name}
                              interestedMode={row.interestedMode ?? interestedModeOf(unit)}
                              actionsDisabled={deleted}
                              onOutcome={(outcome) => onRecipientOutcome(row.contactId, outcome)}
                              // B8: only a PARTNER recipient gets "Request a tour"
                              // (never a landlord / team-member row).
                              // Same page: `replace`, so the dialog adds no history entry.
                              {...(row.type === 'partner' && {
                                requestTourReplace: true,
                                requestTourTo: `/listings/${encodeURIComponent(unit.unitId)}?tour=new`,
                              })}
                              // R4: form mode NAVIGATES to ?tour=new&tenantId=.
                              onOpenTourForm={() => openTourForm(row.contactId)}
                              now={now}
                            />
                          );
                        })}
                      </SendRosterList>
                    ))
                )
```

  - "+ Tour" `:1169` becomes `onClick={() => openTourForm()}`.
  - the host `:1403-1412` becomes:

```tsx
      {tourFormOpen ? (
        <ScheduleTourForm
          initialUnitId={unit.unitId}
          {...(tourFormTenant !== undefined && { tenantId: tourFormTenant })}
          onClose={closeTourForm}
          onCreated={(t) => {
            // Strip the params FIRST (replace), then push the tour page, so
            // Back lands on the bare property page.
            closeTourForm();
            void navigate('/tours/' + t.tourId);
          }}
        />
      ) : null}
```

Commit: `feat(dashboard): property "Sent to" card - grouped lists, outcome actions and the URL-driven tour form`.

### Task 5.4 - contact cards: `listingsSentStatus`, `interestedMode` from `file.units`, the per-click unit, the partner link

RED:

1. `dashboard/src/routes/contact/files.test.tsx` - the prop rename (KNOWING,
   mechanical): every `listingsSentPending` becomes `listingsSentStatus`
   (`:61` type `listingsSentStatus?: 'loading' | 'pending' | 'ready' | 'error'`,
   `:86` default `opts.listingsSentStatus ?? 'loading'`, `:161`
   `{ listingsSentStatus: 'loading' }`, `:167, :185, :205, :223, :229, :242,
   :260` `listingsSentStatus: 'ready'`, `:565, :624` `listingsSentStatus="ready"`,
   `:677` the partner helper type, `:689` default `'ready'`, `:704`
   `{ listingsSentStatus: 'loading' }`); `TenantFile.test.tsx:39, :117`
   `listingsSentStatus="ready"`. New cases:

```tsx
  it('an errored listings-sent slice shows the error row, not the pending panel (D12)', () => {
    renderIt({ listingsSentStatus: 'error' });
    const card = screen.getByRole('heading', { name: /^Properties sent/ }).closest('section') as HTMLElement;
    expect(within(card).getByText("We couldn't load properties sent.")).toBeInTheDocument();
    expect(within(card).queryByText(/Arrives with the backend/)).not.toBeInTheDocument();
  });

  it('a waiting row offers Interested / Not interested named for the tenant and the property', async () => {
    const onListingOutcome = vi.fn(() => Promise.resolve());
    renderIt({
      contact: { ...contact, firstName: 'Tia', lastName: 'Moss' },
      listingsSentStatus: 'ready',
      units: [{ ...UNIT, tour_type: 'self_guided' }],
      listingsSent: [{ contactId: 'T1', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true }],
      onListingOutcome,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 1450 Joseph Blvd, Atlanta, GA' }));
    expect(onListingOutcome).toHaveBeenCalledWith('u1', 'interested');
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 1450 Joseph Blvd, Atlanta, GA' }));
    expect(onListingOutcome).toHaveBeenCalledWith('u1', 'not_interested');
  });

  it("a property with no tour_type opens the form for THAT property ('form' mode from file.units)", async () => {
    const onOpenTourForm = vi.fn();
    renderIt({
      contact: { ...contact, firstName: 'Tia', lastName: 'Moss' },
      listingsSentStatus: 'ready',
      listingsSent: [{ contactId: 'T1', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', outcome: 'replied', interestedSupported: true }],
      onListingOutcome: vi.fn(() => Promise.resolve()),
      onOpenTourForm,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 1450 Joseph Blvd, Atlanta, GA' }));
    expect(onOpenTourForm).toHaveBeenCalledWith('u1');
  });

  it('a row whose property is not in the loaded units (deleted) shows the outcome but no actions', () => {
    renderIt({
      listingsSentStatus: 'ready',
      listingsSent: [{ contactId: 'T1', unitId: 'u-gone', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true }],
      onListingOutcome: vi.fn(() => Promise.resolve()),
    });
    expect(screen.getByText('No reply yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mark / })).not.toBeInTheDocument();
  });

  // (PIN - the list wrapper landed in 5.1; this pins R1 on the real card.)
  it("R1: the rows are the listitems of ONE list named 'Properties sent', and nothing else in the card is a listitem", () => {
    renderIt({
      listingsSentStatus: 'ready',
      units: [UNIT, { unitId: 'u2', landlordId: 'L1', status: 'available', address: { line1: '2 Peachtree' } }],
      listingsSent: [
        { contactId: 'T1', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true },
        { contactId: 'T1', unitId: 'u2', sentAt: '2026-06-29T10:00:00Z', via: 'broadcast', outcome: 'replied', interestedSupported: true },
      ],
    });
    const card = screen.getByRole('heading', { name: /^Properties sent/ }).closest('section') as HTMLElement;
    const list = within(card).getByRole('list', { name: 'Properties sent' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
  });

  it('B8: a non-partner row the tenant file shows with interestedSupported false (a team-member page) gets NO "Request a tour" link', () => {
    renderIt({
      contact: { ...contact, type: 'team_member' },
      listingsSentStatus: 'ready',
      listingsSent: [{ contactId: 'T1', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: false }],
      onListingOutcome: vi.fn(() => Promise.resolve()),
    });
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Mark .* not interested in / })).toBeInTheDocument();
  });
```

   (the `renderIt` opts type at `:59-76` gains `onListingOutcome?` and
   `onOpenTourForm?` with the TenantFile prop types, passed through like
   `onSendProperty`.) In `describe('PartnerFile - Properties sent ...')`
   (`:668-730`), the helper gains `onListingOutcome?` passed through, plus:

```tsx
  it('a partner row links "Request a tour" to the property page and offers Not interested; never Interested', async () => {
    const onListingOutcome = vi.fn(() => Promise.resolve());
    renderSent({
      listingsSent: [{ contactId: 'P2', unitId: 'u1', sentAt: '2026-07-01T12:00:00.000Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: false }],
      onListingOutcome,
    });
    expect(screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 1450 Joseph Blvd, Atlanta, GA' })).toHaveAttribute('href', '/listings/u1?tour=new');
    expect(screen.queryByRole('button', { name: /^Mark Cora Reyes interested/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Cora Reyes not interested in 1450 Joseph Blvd, Atlanta, GA' }));
    expect(onListingOutcome).toHaveBeenCalledWith('u1', 'not_interested');
  });

  it('an errored slice shows the error row', () => {
    renderSent({ listingsSentStatus: 'error' });
    expect(screen.getByText("We couldn't load properties sent.")).toBeInTheDocument();
  });
```

2. `dashboard/src/routes/contact/ContactDetail.test.tsx` - add
   `const setListingSendOutcome = vi.fn();` beside `:24-25`, the mock entry in
   `:103-135`, and `setListingSendOutcome.mockReset();` in `beforeEach`
   (`:300-352`). KNOWING rewrite of the partner case `:3002-3033`: the fixture
   row gains `outcome: 'no_reply', interestedSupported: false` (the server no
   longer sends `tour` for a partner - keep the `tour` in the fixture to pin the
   client-side drop), and add before `:3030`:
   `expect(within(card).getByRole('link', { name: 'Request a tour for Cora Reyes at 1450 Joseph Blvd' })).toHaveAttribute('href', '/listings/u1?tour=new');`.
   The `:1077-1101` case's fixture rows gain
   `outcome: 'no_reply', interestedSupported: true` (assertions unchanged:
   the "+ Schedule" path still pre-commits the LATEST send). New cases in the
   tenant describe that holds `:1077`:

```tsx
  it("Interested in 'form' mode pre-commits the CLICKED row's property, not the latest send", async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    getAllUnits.mockResolvedValue([
      { unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' },
      { unitId: 'u2', landlordId: 'L1', status: 'available', beds: 1, address: '88 Sycamore St' },
    ]);
    getContactListingsSent.mockResolvedValue([
      { contactId: 'k1', unitId: 'u2', sentAt: '2026-07-13T15:00:00.000Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true },
      { contactId: 'k1', unitId: 'u1', sentAt: '2026-07-01T15:00:00.000Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true },
    ]);
    renderAt('k1');
    await user.click(await screen.findByRole('button', { name: 'Mark Tasha Williams interested in 1450 Joseph Blvd' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveValue('1450 Joseph Blvd'));
  });

  it('Not interested calls the route for this contact and the row turns to Undo', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    getAllUnits.mockResolvedValue([{ unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd', tour_type: 'self_guided' }]);
    const row = { contactId: 'k1', unitId: 'u1', sentAt: '2026-07-01T15:00:00.000Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: true };
    getContactListingsSent.mockResolvedValue([row]);
    // The endpoint answers { row } (plan head 3.4 #4).
    setListingSendOutcome.mockResolvedValue({ row: { ...row, outcome: 'not_interested', declined: { at: '2026-07-02T10:00:00.000Z', by: 'staff' } } });
    renderAt('k1');
    await user.click(await screen.findByRole('button', { name: 'Mark Tasha Williams not interested in 1450 Joseph Blvd' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'k1', 'not_interested');
    expect(await screen.findByRole('button', { name: 'Undo not interested for Tasha Williams' })).toBeInTheDocument();
  });

  it("a failed listings-sent read shows \"We couldn't load properties sent.\" (not the pending panel)", async () => {
    getContact.mockResolvedValue(TENANT);
    getContactListingsSent.mockRejectedValue(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable' }));
    renderAt('k1');
    expect(await screen.findByText("We couldn't load properties sent.")).toBeInTheDocument();
  });
```

   (If `TENANT`'s display name in this file is not "Tasha Williams" - it is,
   per `:1092` - adjust the three names together.)

RED today: the cards take `listingsSentPending: boolean` (`TenantFile.tsx:58-59`,
`PartnerFile.tsx:42-43`); no outcome props; ContactDetail collapses the slice
(`ContactDetail.tsx:1176`, `:1228`).

GREEN:

- `dashboard/src/routes/contact/TenantFile.tsx`:
  - (`useState`, `interestedModeOf` and the `now` state landed in 5.1.) Add
    `type SendRowAction` to the Card import (`:24-36`); `contactDisplayName`
    to the `./format.js` import (`:49`); add
    `import type { Slice } from './useContactFile.js';`.
  - props `:58-61` become:

```ts
  /** C4 listings-sent slice status: 'ready' renders rows, 'error' the error
   *  row (last-heard-from D12: a 503 is not "pending"), anything else the
   *  pending panel. */
  listingsSentStatus: Slice<ListingSendRow>['status'];
  /** C4 listings-sent rows - the properties broadcast/sent to this tenant. */
  listingsSent: ListingSendRow[];
  /** Record / clear a send outcome on one Properties-sent row; resolves once
   *  the page applied the returned row, rejects on failure (the row shows
   *  its error). Absent -> the rows show outcomes with no actions. */
  onListingOutcome?: (unitId: string, outcome: SendRowAction) => Promise<void>;
  /** Interested on a property with no tour_type: open Schedule tour with
   *  THIS row's property pre-committed. */
  onOpenTourForm?: (unitId: string) => void;
```

  - destructuring `:120` becomes `listingsSentStatus,`, plus
    `onListingOutcome,` and `onOpenTourForm,` after `onSendProperty` (`:140`).
  - after `const unitMap = ...` (`:143`):
    `const personName = contactDisplayName(contact.firstName, contact.lastName, contact.phone);`
  - the card body `:306-319` becomes:

```tsx
        {listingsSentStatus === 'error' ? (
          <EmptyRow>We couldn&apos;t load properties sent.</EmptyRow>
        ) : listingsSentStatus !== 'ready' ? (
          <PendingPanel />
        ) : listingsSent.length === 0 ? (
          <EmptyRow>No properties sent yet.</EmptyRow>
        ) : (
          // Markup R1: the rows are the only listitems in the card.
          <SendRosterList label="Properties sent">
            {listingsSent.map((s) => {
              const unit = unitMap.get(s.unitId);
              const label = unitLabel(unitMap, s.unitId);
              return (
                <SendRosterRow
                  key={`${s.unitId}:${s.sentAt}`}
                  to={`/listings/${s.unitId}`}
                  identity={label}
                  row={s}
                  address={label}
                  name={personName}
                  interestedMode={interestedModeOf(unit)}
                  // The page loads live units only (GET /api/units excludes
                  // deleted), so an absent unit is a deleted property (B10).
                  actionsDisabled={unit === undefined || onListingOutcome === undefined}
                  onOutcome={(outcome) => (onListingOutcome ? onListingOutcome(s.unitId, outcome) : Promise.resolve())}
                  // No requestTourTo here (B8): this file renders tenants and
                  // team members, never a partner (ContactDetail.tsx:599-607
                  // routes partners to PartnerFile).
                  {...(onOpenTourForm !== undefined && { onOpenTourForm: () => onOpenTourForm(s.unitId) })}
                  now={now}
                />
              );
            })}
          </SendRosterList>
        )}
```

- `dashboard/src/routes/contact/PartnerFile.tsx` (its `useState` import,
  `interestedModeOf`, `SendRosterList` and `now` landed in 5.1): the Card
  import `:15` gains `type SendRowAction`; `./format.js` (`:19`) gains
  `contactDisplayName`; `import type { Slice } from './useContactFile.js';`;
  props `:42-45` become `listingsSentStatus: Slice<ListingSendRow>['status'];`
  + `listingsSent` + `onListingOutcome?: (unitId: string, outcome: SendRowAction) => Promise<void>;`
  (no `onOpenTourForm` - a partner never gets Interested); destructuring `:74`
  `listingsSentStatus,` + `onListingOutcome,`; after `const unitMap = ...`
  (`:82`): `const personName = contactDisplayName(contact.firstName, contact.lastName, contact.phone);`.
  The card body `:168-180` becomes:

```tsx
        {listingsSentStatus === 'error' ? (
          <EmptyRow>We couldn&apos;t load properties sent.</EmptyRow>
        ) : listingsSentStatus !== 'ready' ? (
          <PendingPanel />
        ) : listingsSent.length === 0 ? (
          <EmptyRow>No properties sent yet.</EmptyRow>
        ) : (
          <SendRosterList label="Properties sent">
            {listingsSent.map((s) => {
              const unit = unitMap.get(s.unitId);
              const label = sentUnitLabel(unitMap, s.unitId);
              return (
                <SendRosterRow
                  key={`${s.unitId}:${s.sentAt}`}
                  to={`/listings/${s.unitId}`}
                  identity={label}
                  row={s}
                  address={label}
                  name={personName}
                  interestedMode={interestedModeOf(unit)}
                  actionsDisabled={unit === undefined || onListingOutcome === undefined}
                  onOutcome={(outcome) => (onListingOutcome ? onListingOutcome(s.unitId, outcome) : Promise.resolve())}
                  // B8: "Request a tour" keys on the PAGE contact's type -
                  // a partner (this file's only audience; the guard keeps it
                  // honest if the file is ever reused).
                  {...(contact.type === 'partner' && {
                    requestTourTo: `/listings/${encodeURIComponent(s.unitId)}?tour=new`,
                  })}
                  now={now}
                />
              );
            })}
          </SendRosterList>
        )}
```

  The R3-F5 comment at `:154-157` gains: `The server no longer sends tour on a
  partner row (spec 14.3 B11); SendRosterRow renders the outcome chip, which
  for a partner is never the tour chip.`

- `dashboard/src/routes/contact/ContactDetail.tsx`:
  - imports: `setListingSendOutcome` joins the api import.
  - state after `:195`:

```tsx
  // The clicked Properties-sent row's property for the Schedule-a-tour dialog
  // (Interested on a property with no tour_type, spec 5.4 D14). Undefined ->
  // the dialog pre-commits the LATEST send, as before.
  const [tourUnitOverride, setTourUnitOverride] = useState<string | undefined>(undefined);
```

  - after the early returns (beside the other handlers that read `contact`):

```tsx
  // One outcome action on a Properties-sent row: the route answers { row }
  // (plan head 3.4 #4), applied in place; a rejection reaches the row.
  const onListingOutcome = async (unitId: string, outcome: 'interested' | 'not_interested' | 'clear'): Promise<void> => {
    const { row } = await setListingSendOutcome(unitId, contact.contactId, outcome);
    file.setListingSentRow(contact.contactId, unitId, row);
  };
```

  - PartnerFile `:1176` becomes `listingsSentStatus={file.listingsSent.status}`
    and gains `onListingOutcome={onListingOutcome}`.
  - TenantFile `:1228` becomes `listingsSentStatus={file.listingsSent.status}`
    and gains `onListingOutcome={onListingOutcome}` and
    `onOpenTourForm={(unitId) => { setTourUnitOverride(unitId); setSchedulingTour(true); }}`.
  - the host `:1348-1362` becomes:

```tsx
      {schedulingTour ? (
        <ScheduleTourForm
          tenantId={contact.contactId}
          // The clicked row's property (Interested, 'form' mode), else continue
          // from the latest send: the most recent "Properties sent" row (rows
          // arrive newest-first by sentAt).
          initialUnitId={
            tourUnitOverride ??
            (file.listingsSent.status === 'ready' ? file.listingsSent.rows[0]?.unitId : undefined)
          }
          onClose={() => {
            setSchedulingTour(false);
            setTourUnitOverride(undefined);
          }}
          onCreated={(t) => {
            setSchedulingTour(false);
            setTourUnitOverride(undefined);
            void navigate('/tours/' + t.tourId);
          }}
        />
      ) : null}
```

Commit: `feat(dashboard): contact Properties sent - outcomes, actions and the error row`.

### Task 5.5 - Timeline (no change) and the property Activity labels

`dashboard/src/routes/contact/Timeline.tsx` needs NO change (findings A6): the
milestone pin renders the SERVER label verbatim (`Timeline.tsx:467-469`), and
`milestoneVariant` (`:428-444`) only picks a colour, defaulting to neutral for
the three new types. The labels "Not interested in <address>", "Not interested
cleared for <address>" and "Interested in <address> - tour requested" are
written by the outcome route (task 3.7); the union mirror landed in task 3.5.

RED - `dashboard/src/routes/listing/listingFormat.test.ts`, inside
`describe('describeUnitActivity', ...)` (`:159-290`):

```ts
  it('describes the send-outcome rows with the contact (name -> id) and links (spec 5.4)', () => {
    expect(describeUnitActivity(evt({ type: 'listing_declined', contactId: 'c1', contactName: 'Tia Moss' }))).toEqual({
      label: 'Tia Moss not interested',
      to: '/contacts/c1',
    });
    expect(describeUnitActivity(evt({ type: 'listing_decline_cleared', contactId: 'c1' }))).toEqual({
      label: 'c1 not interested cleared',
      to: '/contacts/c1',
    });
    // Interested links the tour it created.
    expect(describeUnitActivity(evt({ type: 'listing_interested', contactId: 'c1', contactName: 'Tia Moss', tourId: 't9' }))).toEqual({
      label: 'Tia Moss interested - tour requested',
      to: '/tours/t9',
    });
    // No tourId -> the contact link.
    expect(describeUnitActivity(evt({ type: 'listing_interested', contactId: 'c1' }))).toEqual({
      label: 'c1 interested - tour requested',
      to: '/contacts/c1',
    });
  });
```

RED today: the three types fall to `humanize` (`listingFormat.ts:229-230`),
e.g. `{ label: 'Listing declined' }`.

GREEN - `dashboard/src/routes/listing/listingFormat.ts`, after `TOUR_LABELS`
(`:156-166`):

```ts
/** last-heard-from spec 5.4 / 14.3: the send-outcome rows the outcome route
 *  appends to the unit audit (payload { contactId, actor } + tourId on
 *  interested). Prefixed by the contact (`who`). "(auto)" never shows here -
 *  `by` is not on the Activity wire. */
const OUTCOME_LABELS: Record<string, string> = {
  listing_declined: 'not interested',
  listing_decline_cleared: 'not interested cleared',
  listing_interested: 'interested - tour requested',
};
```

  and in `describeUnitActivity`, directly after the `tourLabel` block
  (`:187-190`):

```ts
  const outcomeLabel = OUTCOME_LABELS[e.type];
  if (outcomeLabel !== undefined) {
    // `who` is always present in practice (the route writes contactId); the
    // fallback keeps the open-set rule - never a blank or "undefined" row.
    return {
      label: `${who ?? 'A recipient'} ${outcomeLabel}`,
      ...(e.type === 'listing_interested' && e.tourId ? { to: `/tours/${e.tourId}` } : contactLink),
    };
  }
```

Commit: `feat(dashboard): property Activity labels for the send-outcome events`.

---
### Notes for the orchestrator (cross-slice)

- S8 (e2e) owns any spec that reads a "Sent to" / "Properties sent" row's
  text: rows now carry dates, a chip and buttons, so exact-text row checks in
  `e2e/tests/dashboard-next/listing-activity.spec.ts`,
  `partner-share.spec.ts`, `share-sent-outcome.spec.ts` and
  `e2e/scenarios/steps.ts:1118, :1222` (which read `GET .../listings-sent`
  JSON) should be re-checked there; the JSON readers only gain fields.
- S7's follow-ups endpoint reuses `deriveListingSendOutcome`,
  `deriveTourActivityAt`, `isEligibleRecipient`, `isWaiting`, `waitingSince`,
  `interestedModeFor` and the `getRecipientDisplaysByIds(..., { requireComplete: true })`
  projection from this slice; its Interested action on a 'form' property
  navigates to `/listings/<unitId>?tour=new&tenantId=<id>`, which task 5.3
  handles.
- Gate 5 attention: `ListingDetail.tsx` and the contact files may be among
  the 18 pre-existing react-hooks-dirty files; the new code adds no effect,
  no setState-in-render and no impure render call (`useState(() => new Date())`).

<!-- W3 notes -->
## CONTRACT NOTES for S6-S7 (W3) - read before Task 6.1

No plan-head contract is unworkable. These are ADDITIONS and dependencies the
orchestrator must reconcile with the other writers before building:

1. DEPENDENCY (S3.8, W2): S7.3 calls a dashboard endpoint the plan head does not
   name. This section assumes, in `dashboard/src/api/endpoints.ts`:
   `setListingSendOutcome(unitId: string, contactId: string, outcome: 'interested' | 'not_interested' | 'clear'): Promise<{ row: ListingSendRow }>`
   and the dashboard types `ListingSendOutcome` and `InterestedMode` exported
   from `dashboard/src/api/types.ts` (the app names, section 3.1). If W2 names
   them differently, rename here; nothing else changes. (Plan review R1
   confirmed `{ row }` everywhere.) S7.3 also imports W2's
   `dashboard/src/lib/listingOutcomeErrors.ts` (`outcomeErrorCopy`) for the row
   error copy instead of redefining it (R1 #12).
2. DEPENDENCY (S1.1, S1.14, W1): app `ContactItem.last_heard_from_at?: string`
   and dashboard `Contact.last_heard_from_at?: string`. DEPENDENCY (S3.1-S3.3,
   W2): `deriveListingSendOutcome`, `isEligibleRecipient`, `isWaiting`,
   `waitingSince`, `interestedModeFor`, `deriveTourActivityAt`, and
   `ListingSendItem.declined?: DeclineRecord`. DEPENDENCY (S4.1, W4):
   `dashboard/src/lib/heardFrom.ts` (`formatHeardFrom`, `sortByHeardFrom`,
   `daysSince`, `NameLike`) with the section 3.3 signatures. The S7 builder tests
   assume S3's precedence makes a contact heard AFTER `sentAt` read `replied`
   (spec D2).
3. COPY ADDITIONS (not in the plan-head copy table): the Follow up row's Text
   button aria `Text <name>`; its failure line `Couldn't open the conversation - try again.`;
   the truncated note `Showing follow-ups for the first 100 available properties.`;
   N = 1 renders `1 day` (`No reply yet, 1 day`, `Replied, quiet 1 day`); a row
   resolved Interested whose response carries no tour signal shows the chip
   `Interested` (with a signal it shows the existing `TourChip`). The
   search annotation shows ONE suffix: `Not interested` outranks `Already sent`.
4. CLARIFICATION: the Properties `<n> waiting` pill renders INSIDE the row link
   (spec 14.4 last bullet), so it cannot itself link to `?tab=follow-up`
   (nested anchors are invalid HTML). The tab URL still serves deep links and
   the S8 e2e.
5. CORRECTION to finding B7: a test DOES pin an em-dash accessible name -
   `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx:431`
   (`/NoConsent <em dash> consent not recorded/i`). Task 6.5 rewrites it knowingly.
   No e2e spec pins a checkbox accessible name (S8 note at the end of 6.5).
6. SPLIT: the explicit candidate projection of `status` / `lastHeardFromAt`
   (finding B12) lands in Task 6.1, not 6.2: 6.1's D2 update and partner-seed
   negative assert on the preview WIRE, which only the projection reaches.
   Task 6.2 adds the decline fields.
7. SMALL API ADDITIONS: `RecipientPreview` and `FollowUpView` each take an
   optional `now?: Date` (the test clock; production passes nothing).
   `DevRouterDeps` gains `listingSendsRepo?`. The dev seam is CREATE-ONLY: it
   answers 201 `{ row }` on a fresh pair and 409 `{ error: 'send_exists' }`
   when the pair already has any listing_sends row (R1 #11, R2 #3) - an
   addition to the plan-head dev-seam row.
   `displayNameOfContact` moves from `app/src/routes/units.ts:155-176` to a new
   `app/src/lib/contactDisplay.ts` (units.ts imports it) so the follow-ups
   builder reuses it without importing a route (R1 #12, R2 #2). `FollowUpItem.declined` stays in
   the type (spec 5.6) but the builder never sets it: a waiting row has, by
   definition, no effective decline; an in-session decline lives in the
   dashboard's local state (Undo).

---

## S6 - Matching review step (spec 5.3, 5.8, 14.4)

Reference for every citation: `.superpowers/sdd/plan-research/matching-reference.md`
(the tree at f6aba402; source files in this slice are byte-identical at cad93026).

### Task 6.1 - the resolver and the seeds carry `status` (tenant only) and `lastHeardFromAt`

RED:

1. `app/test/audienceResolution.test.ts:212-214` (D1, knowing update) - the
   exact-shape case: its `tenant()` helper defaults `status: 'active'` (`:14-21`),
   so the expected object becomes
   `{ contactId: 'c-1', phone: '+15551230001', firstName: 'Ann', lastName: 'Osei', has_consent: false, status: 'active' }`.
   RED today: `status` is not projected.
2. Same file, new case after `:226` (inside `describe('audience resolution (M1.8a)')`):

```ts
  it('last-heard-from 5.3: carries the tenant status and lastHeardFromAt (absent when the contact has none)', async () => {
    const items = [
      tenant({ contactId: 'c-1', status: 'searching', last_heard_from_at: '2026-10-05T16:20:00.000Z' }),
      tenant({ contactId: 'c-2', status: 'onboarding' }),
    ];
    const resolve = createAudienceResolutionService({ contactsRepo: fakeContacts(items), logger });
    const out = await resolve({ contact_type: 'tenant', ...ALWAYS_EXCLUDE });
    const byId = Object.fromEntries(out.contacts.map((c) => [c.contactId, c]));
    expect(byId['c-1']).toMatchObject({ status: 'searching', lastHeardFromAt: '2026-10-05T16:20:00.000Z' });
    expect(byId['c-2']).toMatchObject({ status: 'onboarding' });
    expect(byId['c-2']).not.toHaveProperty('lastHeardFromAt');
  });
```

3. `app/test/broadcastApi.test.ts:287-296` (D2, knowing update) - the exact
   preview `toEqual`: `seedTenant` defaults `status: 'searching'` (`:56-72`), so
   the candidate gains `status: 'searching'`. RED today.
4. Same file, new case after `:1167` (top-level describe):

```ts
  it('last-heard-from 5.3: an audience candidate carries status and lastHeardFromAt', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-heard', phone: '+15550100001', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.candidates[0]).toMatchObject({
      contactId: 'c-heard',
      status: 'searching',
      lastHeardFromAt: '2026-10-03T09:30:00.000Z',
    });
  });
```

5. Same file, the partner-seed negative - a new case inside
   `describe('caseworkers D20: direct shares accept partners')`, after `:2372`
   (uses that describe's `seedPartner`, `postSeeded`, `step`; `seedPartner`
   sets `status: 'active'`, so the negative is real):

```ts
    it('last-heard-from 5.3: a partner seed previews lastHeardFromAt but NEVER a status; a tenant seed carries both', async () => {
      seedUnit(world);
      seedPartner({ last_heard_from_at: '2026-10-01T12:00:00.000Z' });
      seedTenant(world, { contactId: 'c-tenant', phone: '+15550100082', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner', 'c-tenant']);
      expect(created.status).toBe(201);
      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      const rows = preview.body.candidates as Array<Record<string, unknown>>;
      const partnerRow = rows.find((c) => c['contactId'] === 'c-partner');
      expect(partnerRow).toMatchObject({ lastHeardFromAt: '2026-10-01T12:00:00.000Z' });
      // StatusBadge kind="tenant" must never see a partner's needs_review | active.
      expect(partnerRow).not.toHaveProperty('status');
      expect(rows.find((c) => c['contactId'] === 'c-tenant')).toMatchObject({
        status: 'searching',
        lastHeardFromAt: '2026-10-03T09:30:00.000Z',
      });
    });
```

6. (PIN) Same file, new case right after case 4 (top-level describe, whose
   `beforeEach` `:196-204` wires the queue and whose `afterEach` settles it).
   It is green before AND after GREEN - the proof the projection change never
   rides into the stored recipients map (plan review R1 #13):

```ts
  it('last-heard-from 5.3: markSending stores { status: queued } per key - never status or lastHeardFromAt (paths b and c)', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
    seedTenant(world, { contactId: 'c-seed', phone: '+15550100002', last_heard_from_at: '2026-10-04T09:30:00.000Z' });
    const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
    const { app } = makeWebhookHarness({ world });
    // Path (c): the no-body filter-resolve send snapshots ResolvedContact rows (:933-936).
    const filterId = await createDraft(app);
    const sendC = await request(app)
      .post(`/api/broadcasts/${filterId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(sendC.status).toBe(200);
    // Path (b): a seeds_only draft resolves its seeds through resolveSeeds -> buildRecipientsFrom.
    const seeded = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-seed'] });
    expect(seeded.status).toBe(201);
    const sendB = await request(app)
      .post(`/api/broadcasts/${seeded.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(sendB.status).toBe(200);
    expect(markSending).toHaveBeenCalledTimes(2);
    // Exact equality: any extra field on a slot (status, lastHeardFromAt, ...) fails.
    expect(markSending.mock.calls[0]![1]).toEqual({ 'c-1': { status: 'queued' }, 'c-seed': { status: 'queued' } });
    expect(markSending.mock.calls[1]![1]).toEqual({ 'c-seed': { status: 'queued' } });
  });
```

   (The spy keeps the real `markSending` running, so the fan-out proceeds as in
   every other send case. Path (a) uses the same `buildRecipientsFrom` as (b)
   from `{ contactId, phone }` survivors, `:845-856`, and is not repeated.)

GREEN:

- `app/src/services/audienceResolution.ts`, `ResolvedContact` (`:31-49`) - add
  after `has_consent: boolean;` (`:48`):

```ts
  /**
   * last-heard-from (spec 5.3): the contact's lifecycle status, for the review
   * row's StatusBadge kind="tenant". TENANT rows only - the resolver is
   * tenant-fenced (:149) and resolveSeeds omits it for a partner seed (a
   * partner's needs_review | active is not a tenant status).
   */
  status?: string;
  /** last-heard-from: contact.last_heard_from_at (any type), for the review
   *  row's column and its order. */
  lastHeardFromAt?: string;
```

- Same file, the resolver push (`:163-173`) - add after
  `...(housingAuthority !== undefined && { housingAuthority }),` (`:169`):

```ts
          // last-heard-from (spec 5.3): projection only - no filter changes.
          ...(typeof contact.status === 'string' && contact.status.length > 0 && { status: contact.status }),
          ...(typeof contact.last_heard_from_at === 'string' && { lastHeardFromAt: contact.last_heard_from_at }),
```

- `app/src/routes/broadcasts.ts`, `resolveSeeds` (`:440-473`) - add after the
  `housingAuthority` spread (`:467-468`), before `has_consent` (`:469`):

```ts
        // last-heard-from (spec 5.3): a TENANT seed's lifecycle status; a
        // partner seed carries none (StatusBadge kind="tenant" must never see
        // it). Last heard from is any type's.
        ...(c.type === 'tenant' && typeof c.status === 'string' && c.status.length > 0 && { status: c.status }),
        ...(typeof c.last_heard_from_at === 'string' && { lastHeardFromAt: c.last_heard_from_at }),
```

- Same file, the preview candidate projection (`:710-737`, copied field by
  field - finding B12: a field reaches the wire only if added HERE) - add after
  `...(c.housingAuthority !== undefined && { housingAuthority: c.housingAuthority }),` (`:718`):

```ts
      // last-heard-from (spec 5.3): tenant status (absent for a partner seed)
      // and last heard from, for the review row's columns and order.
      ...(c.status !== undefined && { status: c.status }),
      ...(c.lastHeardFromAt !== undefined && { lastHeardFromAt: c.lastHeardFromAt }),
```

  Persistence (spec 5.3, finding B12, plan review R1 #13): `ResolvedContact` is
  consumed only by `broadcasts.ts`; the send paths build the recipients map as
  `{ status: 'queued' }` per key (`buildRecipientsFrom` `:358-367` for paths (a)
  and (b), the path (c) loop `:933-936`) and the ONE write of it is
  `broadcasts.markSending(broadcastId, recipients)` (`:942`). RED case 6 below
  pins that neither new field reaches that write.

Run: `cd "W:/tmp/last-heard-from/app"; npx vitest run test/audienceResolution.test.ts test/broadcastApi.test.ts`.

Commit: `feat(app): preview candidates carry tenant status and last heard from`.

### Task 6.2 - the preview's not-interested labels and the degraded flag

RED:

1. `app/test/broadcastApi.test.ts:287-296` (D2 again) - the candidate also
   gains `declinedThisProperty: false`; after `:297` add
   `expect(res.body.declinedContactIds).toEqual([]);` and
   `expect(res.body.declineLabelsUnavailable).toBe(false);`. RED today.
2. New nested describe at the END of the top-level describe (insert before its
   closing `});` at `:2430`; `createDraft` is the top-level helper at `:814-821`).
   Add `ListingSendItem` (from `../src/repos/listingSendsRepo.js`) and `TourItem`
   (from `../src/repos/toursRepo.js`) to the file's type imports.

```ts
  describe('last-heard-from 5.3 + D11: the preview not-interested labels', () => {
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    function listedRow(contactId: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
      return { unitId: 'unit-1', contactId, sentAt: SENT, via: 'individual', counted: true, created_at: SENT, updated_at: SENT, ...over };
    }
    function declinedRow(contactId: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
      return listedRow(contactId, { declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' }, ...over });
    }
    function tourOf(tenantId: string, createdAt: string): TourItem {
      return {
        tourId: `tour-${tenantId}-${createdAt}`,
        tenantId,
        unitId: 'unit-1',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'requested',
        createdAt,
        updatedAt: createdAt,
      };
    }
    function previewDraft(app: import('express').Express, id: string) {
      return request(app)
        .post(`/api/broadcasts/${id}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    }
    function declinedById(body: { candidates: Array<{ contactId: string; declinedThisProperty: boolean }> }) {
      return Object.fromEntries(body.candidates.map((c) => [c.contactId, c.declinedThisProperty]));
    }

    it('an EFFECTIVE decline flags the audience row and lists its id; an undeclined row reads false', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
      world.listingSends.push(declinedRow('c-1'), listedRow('c-2'));
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.status).toBe(200);
      expect(res.body.declinedContactIds).toEqual(['c-1']);
      expect(res.body.declineLabelsUnavailable).toBe(false);
      expect(declinedById(res.body)).toEqual({ 'c-1': true, 'c-2': false });
    });

    it('a decline superseded by a LATER send is not effective', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(declinedRow('c-1', { sentAt: '2026-10-03T12:00:00.000Z' }));
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual([]);
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
    });

    it('a decline superseded by a NEWER qualifying tour is not effective; an OLDER tour does not supersede', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-new', phone: '+15550100001' });
      seedTenant(world, { contactId: 'c-old', phone: '+15550100002' });
      world.listingSends.push(declinedRow('c-new'), declinedRow('c-old'));
      const newer = tourOf('c-new', '2026-10-04T12:00:00.000Z');
      const older = tourOf('c-old', '2026-09-30T12:00:00.000Z');
      world.toursMap.set(newer.tourId, newer);
      world.toursMap.set(older.tourId, older);
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual(['c-old']);
      expect(declinedById(res.body)).toEqual({ 'c-new': false, 'c-old': true });
    });

    it('lists a declined contact OUTSIDE the audience (the hand-add annotation, like priorRecipientContactIds)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-in', phone: '+15550100001', voucherSize: 2 } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-out', phone: '+15550100002', voucherSize: 3 } as Partial<ContactItem>);
      world.listingSends.push(declinedRow('c-out'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { audience_filter: { contact_type: 'tenant', bedroomSize: 2 } });
      const res = await previewDraft(app, id);
      expect(res.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-in']);
      expect(res.body.declinedContactIds).toEqual(['c-out']);
    });

    it('a draft with no property reads nothing: both lists empty, no degraded flag', async () => {
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      const listSpy = vi.spyOn(world.listingSendsRepo, 'listByUnit');
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app, { unitId: undefined }));
      expect(res.status).toBe(200);
      expect(listSpy).not.toHaveBeenCalled();
      expect(res.body.declinedContactIds).toEqual([]);
      expect(res.body.declineLabelsUnavailable).toBe(false);
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
    });

    it('no declined row on the property -> the tours and contacts reads are skipped', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(listedRow('c-1'));
      const toursSpy = vi.spyOn(world.toursRepo, 'listByUnit');
      const batchSpy = vi.spyOn(world.contactsRepo, 'getManyByIds');
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual([]);
      expect(toursSpy).not.toHaveBeenCalled();
      expect(batchSpy).not.toHaveBeenCalled();
    });

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
  });
```

  RED today: `declinedContactIds` / `declineLabelsUnavailable` /
  `declinedThisProperty` are absent. (`world` is rebuilt in `beforeEach`
  `:196-204`, so a spy never leaks into the next case.)

3. Dashboard typecheck RED (D3): add the fields below to the dashboard types,
   then `cd "W:/tmp/last-heard-from"; npm run typecheck` fails on
   `RecipientPreview.test.tsx`'s typed fixtures (`candidate()` `:37-50` and
   `previewOf()` `:52-64` return the typed shapes).

GREEN - app:

- `app/src/routes/broadcasts.ts` imports - add after `:63`:

```ts
import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';
import { deriveListingSendOutcome } from '../lib/listingSendOutcome.js';
```

- `BroadcastsRouterDeps` (`:93-118`) - add after `events?: EventBus;` (`:117`):

```ts
  /**
   * last-heard-from (spec 5.3, 5.6, 14.4 A5): the listing-send record - the
   * preview's not-interested labels and the follow-ups list. api.ts passes
   * the SHARED instance (the one the units router reads).
   */
  listingSendsRepo?: ListingSendsRepo;
  /** last-heard-from: the tours a decline (and a follow-up row) is measured against. */
  toursRepo?: ToursRepo;
```

- Router construction - add after `:430` (`const orgNames = ...`):

```ts
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });

  /**
   * last-heard-from (spec 5.3, D11): the contactIds whose decline of `unitId` is
   * EFFECTIVE. Reads, in order: the unit's LISTED rows (listByUnit already drops
   * un-counted rows, so a pair whose every share failed shows no label - "LISTED
   * only"); then, ONLY when some row carries a `declined` record, the unit's
   * tours (one byUnit read, grouped by tenant - the units recipients pattern)
   * and those rows' contacts in one requireComplete batch (their type decides
   * whether tours count, spec 5.4). Throws on any failed read; the caller turns
   * that into the degraded flag - these are labels, not outcomes with buttons,
   * so D12's 503 does not apply.
   */
  async function effectiveDeclines(unitId: string): Promise<Set<string>> {
    const declinedRows = (await listingSends.listByUnit(unitId)).filter((r) => r.declined !== undefined);
    const out = new Set<string>();
    if (declinedRows.length === 0) return out;
    const [unitTours, byId] = await Promise.all([
      tours.listByUnit(unitId),
      contacts.getManyByIds(declinedRows.map((r) => r.contactId), { requireComplete: true }),
    ]);
    const toursByTenant = new Map<string, TourItem[]>();
    for (const t of unitTours) {
      const arr = toursByTenant.get(t.tenantId);
      if (arr === undefined) toursByTenant.set(t.tenantId, [t]);
      else arr.push(t);
    }
    for (const row of declinedRows) {
      const contact = byId.get(row.contactId);
      const pairTours = toursByTenant.get(row.contactId) ?? [];
      const outcome = deriveListingSendOutcome({
        row,
        recipientType: contact?.type,
        lastHeardFromAt: contact?.last_heard_from_at,
        tour: deriveTourSignal(pairTours),
        tourActivityAt: deriveTourActivityAt(pairTours),
      });
      if (outcome === 'not_interested') out.add(row.contactId);
    }
    return out;
  }
```

- The preview handler (`:646-756`) - insert after the `priorRecipients`
  assignment (`:704-707`), before the comment at `:708`:

```ts
    // last-heard-from (spec 5.3, D11): the not-interested labels. Both lists
    // are empty without a property. A failed read serves the candidates with
    // NO labels and says so (declineLabelsUnavailable) - never a 503 here.
    let declinedIds = new Set<string>();
    let declineLabelsUnavailable = false;
    if (broadcast.unitId !== undefined) {
      try {
        declinedIds = await effectiveDeclines(broadcast.unitId);
      } catch (err) {
        declineLabelsUnavailable = true;
        log.warn({ err, broadcastId, unitId: broadcast.unitId }, 'broadcast preview: decline labels unavailable - served without them');
      }
    }
```

  In the candidate projection, add after `seeded: seedIdSet.has(c.contactId),` (`:736`):

```ts
      // last-heard-from D11: an EFFECTIVE decline of this property.
      declinedThisProperty: declinedIds.has(c.contactId),
```

  In `res.json({...})` add after `unresolvedSeedIds: seeds.unresolved,` (`:754`):

```ts
      // last-heard-from (spec 5.3): the analog of priorRecipientContactIds -
      // annotates a hand-added row outside the audience client-side.
      declinedContactIds: [...declinedIds],
      declineLabelsUnavailable,
```

  Add one line to the handler's header comment (after `:654`):
  `// last-heard-from: per candidate status? / lastHeardFromAt? / declinedThisProperty, plus declinedContactIds + declineLabelsUnavailable.`

- `app/src/routes/api.ts`, the broadcasts mount (`:1083-1105`) - add after
  `events,` (`:1104`):

```ts
        // last-heard-from (spec 14.4 A5): the preview's decline labels and the
        // follow-ups list read the SHARED listing-send record and tours (the
        // instances built at :604 and :637, as the units mount passes them).
        listingSendsRepo: listingSends,
        toursRepo: tours,
```

GREEN - dashboard (`dashboard/src/api/types.ts`, additive at the END of each interface):

- `PreviewCandidate` (`:3358-3375`), after `seeded: boolean;` (`:3374`):

```ts
  /** last-heard-from (spec 5.3): the contact's lifecycle status - TENANT rows
   *  only (a partner seed never carries one). */
  status?: string;
  /** last-heard-from: contact.last_heard_from_at (any type). */
  lastHeardFromAt?: string;
  /** last-heard-from D11: an EFFECTIVE decline of this property is recorded. */
  declinedThisProperty: boolean;
```

- `PreviewResponse` (`:3388-3395`), after `unresolvedSeedIds: string[];` (`:3394`):

```ts
  /** last-heard-from (spec 5.3, D11): every contact whose decline of this
   *  property is EFFECTIVE - annotates hand-added rows client-side, like
   *  priorRecipientContactIds. Empty when the draft has no property. */
  declinedContactIds: string[];
  /** True when the decline reads failed: the candidates came back with NO
   *  not-interested labels, so a declined tenant may start checked. */
  declineLabelsUnavailable: boolean;
```

- Fixtures (D3 - required fields, so every literal carries them):
  - `RecipientPreview.test.tsx` `candidate()` (`:37-50`): add
    `declinedThisProperty: false,` after `seeded: false,` (`:47`);
    `previewOf()` (`:52-64`): add `declinedContactIds: [],` and
    `declineLabelsUnavailable: false,` after `unresolvedSeedIds: [],` (`:61`).
  - `BroadcastComposer.test.tsx` (untyped `vi.fn()` mocks, so typecheck does
    not force these - updated for fidelity): `:234` candidate gains
    `declinedThisProperty: false` and the response gains
    `declinedContactIds: [], declineLabelsUnavailable: false`; the same two
    on the response at `:487-494` (its candidate at `:490` gains
    `declinedThisProperty: false`); `DEKALB_TENANT` (`:810-817`) gains
    `declinedThisProperty: false`; the local `previewOf` (`:818-825`) gains
    `declinedContactIds: [], declineLabelsUnavailable: false`.

Run: app `npx vitest run test/broadcastApi.test.ts`; dashboard
`npx vitest run src/routes/broadcasts`; root `npm run typecheck`.

Commit: `feat(app): preview flags effective declines and degrades without them`.

### Task 6.3 - C6: apply the proposed fix verbatim (its own commit)

1. RED: apply ONLY the patch's test hunk and run it -

```
cd "W:/tmp/last-heard-from"; git apply --include=dashboard/src/routes/contact/ContactSearchField.test.tsx docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch
cd "W:/tmp/last-heard-from/dashboard"; npx vitest run src/routes/contact/ContactSearchField.test.tsx
```

   Expected: exactly the three new cases fail (`opens above a low input so a
   matching option stays reachable`, `keeps a short list below the input when
   it fits there`, `caps the list to available space in a short viewport
   without a minimum overflow`); every pre-existing case passes.
2. GREEN: apply the source hunk -

```
cd "W:/tmp/last-heard-from"; git apply --include=dashboard/src/routes/contact/ContactSearchField.tsx docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch
```

   The two `--include` runs together are the patch, byte for byte (verified
   `git apply --check` clean at cad93026). Re-run the file: all green. Then
   `npm run typecheck` (the `pos` state type changes: `maxHeight` becomes a
   number, `top` optional, `bottom` added). `git diff --stat` must show only
   `ContactSearchField.tsx` and `ContactSearchField.test.tsx`.
3. Do NOT touch the issue file here: `docs/issues/contact-search-popover-below-viewport.md`
   is marked resolved (date + this commit's hash) in S9 (W1). The e2e re-proof
   of `e2e/tests/dashboard-next/matching-entry-points.spec.ts:228` counts only in
   the full `npm run e2e` run (spec 14.5 F17) - S8/S10.

Commit: `fix(dashboard): contact search list opens where it fits (C6 proposed fix, verbatim)`.

### Task 6.4 - `ContactSearchField` `annotate` (after C6, separate commit)

Line numbers below are AFTER C6 (its middle hunk adds 7 lines from old `:125`;
the props interface `:53-64` and destructure `:83-89` do not move; the option
body old `:275-306` is now `:282-313`).

RED (`dashboard/src/routes/contact/ContactSearchField.test.tsx`, inside
`describe('ContactSearchField')`, after the `:103-112` case):

```tsx
  it('renders an annotate note as a muted suffix after the kind (last-heard-from 5.3)', () => {
    render(
      <ContactSearchField
        value={{ name: 'li' }}
        onChange={vi.fn()}
        candidates={CANDIDATES}
        annotate={(c) => (c.contactId === 'c1' ? 'Already sent' : undefined)}
      />,
    );
    // Alice Smith (tenant) carries the note; Charlie Brown does not.
    expect(screen.getByRole('option', { name: /Alice Smith\s+Tenant\s+Already sent/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Charlie Brown/ })).not.toHaveTextContent('Already sent');
  });

  it('does NOT commit the annotate note into value.name when a candidate is picked', () => {
    const onChange = vi.fn();
    render(
      <ContactSearchField
        value={{ name: 'Ali' }}
        onChange={onChange}
        candidates={CANDIDATES}
        annotate={() => 'Not interested'}
      />,
    );
    fireEvent.click(screen.getByRole('option', { name: /Alice Smith/i }));
    expect(onChange).toHaveBeenCalledWith({ name: 'Alice Smith', contactId: 'c1' });
  });
```

RED today: the prop does not exist (typecheck error; the first case fails).

GREEN - `dashboard/src/routes/contact/ContactSearchField.tsx`:

- Props interface, after `disabled?: boolean;` (`:63`):

```ts
  /** A caller's muted note after an option's kind (Matching's "Add a tenant"
   *  passes "Not interested" / "Already sent", spec 5.3). DISPLAY ONLY, like
   *  the kind: a sibling node, never folded into the committed `value.name`
   *  (the header rule at :8-16). Return undefined for no note. */
  annotate?: (c: Contact) => string | undefined;
```

- Destructure (`:83-89`): add `annotate,` after `disabled = false,` (`:88`).
- Option body: after `const isActive = idx === activeIndex;` (`:285`) add
  `const note = annotate?.(c);`; after the `optionKind` span (`:309-311`), before
  `</li>` (`:312`), add:

```tsx
                  {note !== undefined ? <span className={styles.optionNote}>{note}</span> : null}
```

- `ContactSearchField.module.css`, after `.optionKind` (`:94-98`):

```css
/* last-heard-from 5.3: a caller's note after the kind (e.g. "Already sent"). */
.optionNote {
  margin-left: var(--sp-2);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-style: italic;
}
```

Run: `npx vitest run src/routes/contact/ContactSearchField.test.tsx`; typecheck.

Commit: `feat(dashboard): ContactSearchField annotate - a muted note after the kind`.

### Task 6.5 - Review recipients: columns, last-heard-from order, declined rows, ASCII names

RED (`dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`):

1. `renderPreview` (`:86-115`): add `now?: Date;` to its props type and pass
   `{...(props.now !== undefined && { now: props.now })}` to `<RecipientPreview>`.
   Add `import { formatHeardFrom } from '../../lib/heardFrom.js';` and
   `type MockInstance` to the vitest import.
2. Knowing rewrite: `:431` becomes
   `const noConsentBox = within(list).getByRole('checkbox', { name: /NoConsent - consent not recorded/i });`
   (ASCII " - ", spec 14.4 B7). The comment at `:428-429` quotes the VISIBLE tag,
   which keeps its em dash - leave it untouched.
3. New describe at the end of the file:

```tsx
describe('RecipientPreview - columns, order and not-interested rows (last-heard-from 5.3)', () => {
  const NOW = new Date('2026-10-12T15:00:00.000Z');
  const listEl = (): HTMLElement => screen.getByRole('list', { name: 'Candidate recipients' });
  const rowOf = (text: string): HTMLElement => within(listEl()).getByText(text).closest('li') as HTMLElement;
  const namesInOrder = (): string[] => within(listEl()).getAllByRole('link').map((a) => a.textContent ?? '');

  it('renders the column headers and each row status, housing authority and last heard from', () => {
    renderPreview({
      now: NOW,
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha', status: 'searching', housingAuthority: 'Atlanta Housing Authority', lastHeardFromAt: '2026-10-07T14:00:00.000Z' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
      }),
    });
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Housing authority')).toBeInTheDocument();
    // ONE "Last heard from" in the DOM: the header, OUTSIDE the list. The
    // narrow layout's per-row prefix is CSS ::before content (no DOM text).
    expect(screen.getAllByText('Last heard from')).toHaveLength(1);
    expect(within(listEl()).queryByText(/Last heard from/)).toBeNull();
    // The header sits OUTSIDE the list: still exactly one checkbox per row.
    expect(within(listEl()).getAllByRole('checkbox')).toHaveLength(2);
    const tasha = rowOf('Tasha');
    expect(within(tasha).getByText('Searching')).toBeInTheDocument();
    expect(within(tasha).getByText('Atlanta Housing Authority')).toBeInTheDocument();
    // The cell's text is exactly the bare label (the e2e matches it by regex).
    const heardLabel = formatHeardFrom('2026-10-07T14:00:00.000Z', NOW).label;
    expect(within(tasha).getByText(heardLabel).textContent).toBe(heardLabel);
    const bo = rowOf('Bo');
    expect(within(bo).getByText('Never').textContent).toBe('Never');
    expect(within(bo).queryByText('Searching')).toBeNull();
  });

  it('orders the list by last heard from, most recent first, never-heard last', () => {
    renderPreview({
      now: NOW,
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Ann', lastName: 'Zed' }),
          candidate({ contactId: 'c2', firstName: 'Bo', lastName: 'Young', phone: '+14040000002', lastHeardFromAt: '2026-10-01T12:00:00.000Z' }),
          candidate({ contactId: 'c3', firstName: 'Cy', lastName: 'Xu', phone: '+14040000003', lastHeardFromAt: '2026-10-05T12:00:00.000Z' }),
        ],
      }),
    });
    expect(namesInOrder()).toEqual(['Cy Xu', 'Bo Young', 'Ann Zed']);
  });

  it('an added tenant slots into place by last heard from, keeps its facts, and is scrolled into view (block nearest)', async () => {
    const scrolled: MockInstance<HTMLElement['scrollIntoView']> = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const u = userEvent.setup();
    renderPreview({
      now: NOW,
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Ann', lastName: 'Zed' }),
          candidate({ contactId: 'c2', firstName: 'Bo', lastName: 'Young', phone: '+14040000002', lastHeardFromAt: '2026-10-01T12:00:00.000Z' }),
        ],
      }),
      tenantCandidates: [
        tenant({ contactId: 'cX', firstName: 'New', lastName: 'Tenant', status: 'searching', housingAuthority: 'DeKalb Housing Authority', last_heard_from_at: '2026-10-09T12:00:00.000Z' }),
      ],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'New');
    await u.click(await screen.findByRole('option', { name: /New Tenant/ }));
    expect(namesInOrder()).toEqual(['New Tenant', 'Bo Young', 'Ann Zed']);
    const added = rowOf('New Tenant');
    expect(within(added).getByText('Added')).toBeInTheDocument();
    expect(within(added).getByText('Searching')).toBeInTheDocument();
    expect(within(added).getByText('DeKalb Housing Authority')).toBeInTheDocument();
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
    expect(scrolled.mock.contexts.at(-1)).toBe(added);
  });

  it('a declined audience row starts UNCHECKED (still enabled), tagged "Not interested", named "<name> - not interested"', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha', declinedThisProperty: true }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
        declinedContactIds: ['c1'],
      }),
    });
    const box = within(listEl()).getByRole('checkbox', { name: 'Tasha - not interested' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    expect(within(rowOf('Tasha')).getByText('Not interested')).toBeInTheDocument();
    expect(within(listEl()).getByRole('checkbox', { name: 'Bo' })).toBeChecked();
  });

  it('ASCII names: "<name> - already sent", and both tags read "<name> - already sent, not interested"', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Ana', alreadySentThisProperty: true }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002', alreadySentThisProperty: true, declinedThisProperty: true }),
        ],
        priorRecipientContactIds: ['c1', 'c2'],
        declinedContactIds: ['c2'],
      }),
    });
    expect(within(listEl()).getByRole('checkbox', { name: 'Ana - already sent' })).not.toBeChecked();
    const both = within(listEl()).getByRole('checkbox', { name: 'Bo - already sent, not interested' });
    expect(both).not.toBeChecked();
    expect(within(rowOf('Bo')).getByText('Already sent')).toBeInTheDocument();
    expect(within(rowOf('Bo')).getByText('Not interested')).toBeInTheDocument();
  });

  it('a SEEDED declined row starts checked; Select all keeps it and skips an unseeded declined row', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Picked', seeded: true, declinedThisProperty: true }),
          candidate({ contactId: 'c2', firstName: 'Filter', phone: '+14040000002', declinedThisProperty: true }),
          candidate({ contactId: 'c3', firstName: 'Plain', phone: '+14040000003' }),
        ],
        declinedContactIds: ['c1', 'c2'],
        seedContactIds: ['c1'],
      }),
    });
    const box = (name: string): HTMLElement => within(rowOf(name)).getByRole('checkbox');
    expect(box('Picked')).toBeChecked();
    expect(box('Filter')).not.toBeChecked();
    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    await u.click(screen.getByRole('button', { name: 'Select all' }));
    expect(box('Picked')).toBeChecked();
    expect(box('Filter')).not.toBeChecked();
    expect(box('Plain')).toBeChecked();
  });

  it('a hand-added declined tenant is CHECKED (a pick is deliberate) and tagged "Not interested"', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })], declinedContactIds: ['cX'] }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Dee', lastName: 'Clined' })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Dee');
    await u.click(await screen.findByRole('option', { name: /Dee Clined/ }));
    const box = within(listEl()).getByRole('checkbox', { name: 'Dee Clined - not interested' });
    expect(box).toBeChecked();
    expect(within(rowOf('Dee Clined')).getByText('Not interested')).toBeInTheDocument();
  });

  it('annotates the Add-a-tenant options: "Not interested" beats "Already sent"', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [], priorRecipientContactIds: ['cA', 'cB'], declinedContactIds: ['cB'] }),
      tenantCandidates: [
        tenant({ contactId: 'cA', firstName: 'Zoe', lastName: 'Prior', phone: '+14040000071' }),
        tenant({ contactId: 'cB', firstName: 'Zia', lastName: 'Both', phone: '+14040000072' }),
        tenant({ contactId: 'cC', firstName: 'Zed', lastName: 'Fresh', phone: '+14040000073' }),
      ],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Z');
    expect(await screen.findByRole('option', { name: /Zoe Prior.*Already sent/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Zia Both.*Not interested/ })).not.toHaveTextContent('Already sent');
    expect(screen.getByRole('option', { name: /Zed Fresh/ })).not.toHaveTextContent(/Already sent|Not interested/);
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

  RED today: no headers, no status cell, server order, no Not interested tag,
  em-dash names, no degraded line, no annotation.

GREEN - `dashboard/src/routes/broadcasts/RecipientPreview.tsx`:

- Imports: `:17` becomes `import { useLayoutEffect, useMemo, useRef, useState } from 'react';`;
  `:31` becomes `import { Button, Spinner, StatusBadge } from '../../ui/index.js';`;
  add `import { formatHeardFrom, sortByHeardFrom } from '../../lib/heardFrom.js';`.
- Append to the header comment (after `:16`, ASCII):
  `// last-heard-from (spec 5.3): columns at a 768px+ pane (Name, Status, Housing authority, Last heard from), the COMBINED list ordered by last heard from, and a "Not interested" row (declinedContactIds) that starts unchecked unless seeded and that Select all skips.`
- `Row` (`:38-54`) - add after `seeded: boolean;` (`:53`):

```ts
  /** last-heard-from (spec 5.3): split name parts for the shared name order
   *  (sortByHeardFrom's tie-break) - `name` stays the rendered string. */
  firstName?: string;
  lastName?: string;
  /** The contact's lifecycle status - TENANT rows only (StatusBadge kind="tenant"). */
  status?: string;
  /** Tenant housing authority (blank for a partner seed, spec 14.4 B6). */
  housingAuthority?: string;
  /** contact.last_heard_from_at - the column AND the list order. */
  lastHeardFromAt?: string;
  /** An EFFECTIVE decline of this property (declinedContactIds, D11). */
  declined: boolean;
```

- `RecipientPreviewProps` (`:56-73`) - add after `resolvedFor?: ...;` (`:72`):

```ts
  /** The clock the Last heard from column formats against (tests pin it). */
  now?: Date;
```

- Replace `initialRows` (`:75-93`) with (comments ASCII):

```ts
/** The visible no-consent tag. Its em dash is PINNED by
 *  e2e a2p-compliance.spec.ts:387 (spec 14.4 B7 keeps the visible text), so it
 *  is built from the code point and this source stays ASCII. */
const NO_CONSENT_TAG_TEXT = `consent not recorded ${String.fromCharCode(0x2014)} fix before sending`;

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

/** Build the initial rows from the preview candidates (FULL name - a first
 *  name alone does not identify a person at roster scale). */
function initialRows(preview: PreviewResponse, declinedIds: ReadonlySet<string>): Row[] {
  return preview.candidates.map((c) => {
    const row: Row = {
      contactId: c.contactId,
      name: contactDisplayName(c.firstName, c.lastName, c.phone),
      ...(c.firstName !== undefined && { firstName: c.firstName }),
      ...(c.lastName !== undefined && { lastName: c.lastName }),
      phone: c.phone,
      ...(c.status !== undefined && { status: c.status }),
      ...(c.housingAuthority !== undefined && { housingAuthority: c.housingAuthority }),
      ...(c.lastHeardFromAt !== undefined && { lastHeardFromAt: c.lastHeardFromAt }),
      alreadySentThisProperty: c.alreadySentThisProperty,
      declined: declinedIds.has(c.contactId),
      hasConsent: c.has_consent,
      seeded: c.seeded,
      checked: false,
    };
    return { ...row, checked: defaultChecked(row) };
  });
}
```

  (The declined flag reads `declinedContactIds` - ONE source for audience and
  added rows alike; `declinedThisProperty` on the wire carries the same fact.)

- Component body: destructure `now: nowProp,` after `resolvedFor,` (`:101`).
  After `priorIds` (`:104-107`) add:

```ts
  const declinedIds = useMemo(() => new Set(preview.declinedContactIds), [preview.declinedContactIds]);
  const [mountNow] = useState(() => new Date());
  const now = nowProp ?? mountNow;
  /** The rendered row elements, for the scroll-into-view on add. */
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  /** The contactId an add just placed - scrolled into view after the commit. */
  const pendingScrollRef = useRef<string | null>(null);
```

  `:108` becomes `const [rows, setRows] = useState<Row[]>(() => initialRows(preview, declinedIds));`.
- Order (spec 5.3: the dashboard sorts the COMBINED list; the server's order
  stops mattering) - add before `visibleRows` (`:142`), and make `visibleRows`
  (`:144-150`) filter `orderedRows` instead of `rows` (deps `[orderedRows, query]`):

```ts
  const orderedRows = useMemo(
    () =>
      sortByHeardFrom(rows, {
        heardAt: (r) => r.lastHeardFromAt,
        name: (r) => ({
          contactId: r.contactId,
          ...(r.firstName !== undefined && { firstName: r.firstName }),
          ...(r.lastName !== undefined && { lastName: r.lastName }),
          phone: r.phone,
        }),
      }),
    [rows],
  );

  // An added (or promoted) row is scrolled into view so a long list still
  // confirms the pick. `block: 'nearest'` (the AllToursView precedent): a bare
  // scrollIntoView scrolls every scrollable ancestor (Timeline.tsx:2342-2343);
  // nearest moves the 420px list only as far as needed.
  useLayoutEffect(() => {
    const id = pendingScrollRef.current;
    if (id === null) return;
    pendingScrollRef.current = null;
    rowEls.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, [rows]);
```

- `selectAll` (`:165-169`): the body becomes
  `setRows((prev) => prev.map((r) => ({ ...r, checked: defaultChecked(r) })));`
  and its doc comment (`:162-164`) gains `... AND unseeded declined rows (spec 14.4 B11).`
- `addTenant`: after `setSearch({ name: '' });` (`:212`) add
  `pendingScrollRef.current = candidate.contactId;`. Replace the new-row block
  `:226-242` with:

```ts
      const already = priorIds.has(candidate.contactId);
      return [
        ...prev,
        {
          contactId: candidate.contactId,
          name,
          ...(candidate.firstName !== undefined && { firstName: candidate.firstName }),
          ...(candidate.lastName !== undefined && { lastName: candidate.lastName }),
          phone,
          // spec 14.4 B6: an added row's facts come from the raw contact.
          ...(candidate.status !== undefined && { status: candidate.status }),
          ...(candidate.housingAuthority !== undefined && { housingAuthority: candidate.housingAuthority }),
          ...(candidate.last_heard_from_at !== undefined && { lastHeardFromAt: candidate.last_heard_from_at }),
          alreadySentThisProperty: already,
          // Tagged, but CHECKED: a hand-pick is a seed (share-skip-fix D5,
          // spec 14.4 G3 as amended); the annotate suffix warned before the pick.
          declined: declinedIds.has(candidate.contactId),
          hasConsent: true,
          checked: true,
          added: true,
          seeded: true,
        },
      ];
```

- The search annotation - add before `return (` (`:349`):

```ts
  /** "Add a tenant" suffix (spec 5.3): warns BEFORE the pick. One suffix -
   *  Not interested outranks Already sent. */
  const annotateCandidate = (c: Contact): string | undefined =>
    declinedIds.has(c.contactId) ? 'Not interested' : priorIds.has(c.contactId) ? 'Already sent' : undefined;
```

  and pass `annotate={annotateCandidate}` to `<ContactSearchField>` after
  `inputLabel="Add a tenant"` (`:472`).
- The note at `:363-365` stays as it is ("Flagged recipients you picked stay
  checked; ..."): "flagged" now covers Not interested too, and
  `RecipientPreview.test.tsx:248-254` pins it.
- The degraded line - insert after the unresolved-seed notice (`:388-396`),
  before `:398`:

```tsx
      {/* last-heard-from 5.3: the decline reads failed - say so rather than hide
          it (a declined tenant who is not also already sent starts CHECKED). */}
      {preview.declineLabelsUnavailable ? (
        <p className={styles.seedNotice} role="status">
          Couldn&apos;t load not-interested labels - a tenant who said no may be checked; sends still work
        </p>
      ) : null}
```

- Replace the list `:403-453` (the `<ul>` through `</ul>`; `:398-402` and `:454`
  stay) with:

```tsx
        <div className={styles.listFrame}>
          {/* Column headers (spec 5.3, 14.4 B8): OUTSIDE the list so every row
              stays ONE listitem with ONE checkbox (the e2e li selectors and
              partner-share's checkbox count hold). Shown at a 768px+ pane only;
              the rows' column template and the list's stable scrollbar gutter
              keep them aligned. Visual labels - every cell's text is in its row. */}
          <div className={styles.headerRow} aria-hidden="true">
            <span className={styles.headerCheck} />
            <span className={styles.headerCols}>
              <span>Name</span>
              <span>Status</span>
              <span>Housing authority</span>
              <span>Last heard from</span>
              <span />
            </span>
          </div>
          <ul className={styles.rows} aria-label="Candidate recipients">
            {visibleRows.map((row) => {
              const heard = formatHeardFrom(row.lastHeardFromAt, now);
              return (
                <li
                  key={row.contactId}
                  ref={(el) => {
                    if (el) rowEls.current.set(row.contactId, el);
                    else rowEls.current.delete(row.contactId);
                  }}
                  className={`${styles.row} ${!row.hasConsent ? styles.rowNoConsent : row.alreadySentThisProperty || row.declined ? styles.rowAlready : ''}`.trim()}
                >
                  <label className={styles.rowLabel}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      // A clean accessible name (checkboxName) so a test or a
                      // screen reader resolves the row by its person, not the
                      // whole row text. A no-consent row is DISABLED (hard fence).
                      aria-label={checkboxName(row)}
                      checked={row.checked}
                      disabled={!row.hasConsent}
                      onChange={() => toggle(row.contactId)}
                    />
                  </label>
                  {/* The name links to the profile in a NEW TAB - the curated list
                      lives in this page's memory, so in-tab navigation would lose
                      it. Outside the checkbox label so the link never toggles.
                      Cells: name + phone | status, authority, last heard from |
                      tags - columns at a 768px+ pane, three stacked lines below. */}
                  <span className={styles.rowBody}>
                    <span className={styles.cellName}>
                      <Link
                        className={styles.rowName}
                        to={`/contacts/${encodeURIComponent(row.contactId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open profile in a new tab - your recipient list stays put"
                      >
                        {row.name}
                      </Link>
                      <span className={styles.rowPhone}>{formatPhone(row.phone)}</span>
                    </span>
                    <span className={styles.cellFacts}>
                      <span className={styles.cellStatus}>
                        {row.status !== undefined ? <StatusBadge kind="tenant" status={row.status} /> : null}
                      </span>
                      <span className={styles.cellAuthority}>{row.housingAuthority ?? null}</span>
                      {/* The cell's DOM text is the bare label ("Never" or the
                          formatted instant). The narrow layout's "Last heard
                          from " prefix is CSS ::before content, never DOM text
                          (plan review R1 #5: e2e 8.3 asserts the phrase is
                          nowhere inside the list). */}
                      <span className={styles.cellHeard} title={heard.title}>
                        {heard.label}
                      </span>
                    </span>
                    <span className={styles.cellTags}>
                      {!row.hasConsent ? (
                        <span className={styles.noConsentTag}>{NO_CONSENT_TAG_TEXT}</span>
                      ) : (
                        <>
                          {row.alreadySentThisProperty ? <span className={styles.alreadyTag}>Already sent</span> : null}
                          {row.declined ? <span className={styles.declinedTag}>Not interested</span> : null}
                        </>
                      )}
                      {row.added ? <span className={styles.addedTag}>Added</span> : null}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
```

GREEN - `RecipientPreview.module.css`:

- `.preview` (`:2-6`) - add:

```css
  /* last-heard-from 5.3: the review rows switch to columns on the PANE's width. */
  container-type: inline-size;
  --recipient-cols: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.2fr);
```

- `.rows` (`:69-77`) - add `scrollbar-gutter: stable;` (the header reserves the same).
- `.row` (`:78-84`) - `align-items: center;` becomes `align-items: flex-start;`
  (stacked rows; the wide query restores center).
- Replace `.rowBody` (`:107-113`) with:

```css
/* Name + phone | status, authority, last heard from | tags. Stacked by default
 * (three lines); a grid of columns at a 768px+ pane (the query below). */
.rowBody {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  flex: 1 1 auto;
  min-width: 0;
}
```

- After `.noConsentTag` (`:154-162`) add:

```css
/* last-heard-from 5.3: "Not interested" - the same tone as "Already sent". */
.declinedTag {
  flex: 0 0 auto;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-evt-amber-border);
  color: var(--c-evt-amber-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
}
.listFrame {
  display: flex;
  flex-direction: column;
}
.headerRow {
  display: none;
  gap: var(--sp-3);
  padding: 0 var(--sp-3) var(--sp-1);
  /* The list's 1px side borders, so the columns start where the rows' do. */
  border-left: 1px solid transparent;
  border-right: 1px solid transparent;
  /* The same reserved gutter as .rows, so a scrollbar never shifts the rows
   * out from under the headers. */
  overflow-y: hidden;
  scrollbar-gutter: stable;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--c-text-muted);
}
.headerCheck {
  flex: 0 0 16px;
}
.headerCols {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: var(--recipient-cols);
  gap: var(--sp-3);
}
.cellName,
.cellFacts,
.cellTags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1) var(--sp-3);
  min-width: 0;
}
.cellStatus,
.cellAuthority,
.cellHeard {
  flex: 0 0 auto;
  min-width: 0;
}
.cellAuthority,
.cellHeard {
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
.cellStatus:empty,
.cellAuthority:empty,
.cellTags:empty {
  display: none;
}
@container (min-width: 768px) {
  .headerRow {
    display: flex;
  }
  .row {
    align-items: center;
  }
  .rowBody {
    display: grid;
    grid-template-columns: var(--recipient-cols);
    align-items: center;
    gap: var(--sp-3);
  }
  /* Status, authority and last heard from become the row grid's own cells. */
  .cellFacts {
    display: contents;
  }
  /* An empty cell keeps its column in the grid. */
  .cellStatus:empty,
  .cellAuthority:empty,
  .cellTags:empty {
    display: block;
  }
  .cellAuthority {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
/* The narrow (stacked) layout has no header row, so the last-heard-from cell
 * names itself - as GENERATED content, so the cell's DOM text stays the bare
 * label (plan review R1 #5). The wide layout's header names the column. */
@container (max-width: 767.98px) {
  .cellHeard::before {
    content: 'Last heard from ';
  }
}
```

Run: `npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx`;
typecheck; ASCII check on the added lines of `git diff`.

E2E consequences for S8 (W4) - selectors, verified against the tree:

- No e2e spec pins a review-step checkbox accessible name: every review pin
  (`broadcasts.spec.ts:173-188`, `matching-entry-points.spec.ts:231`,
  `share-skip-fix.spec.ts:150-152, :208-210, :246, :285`,
  `share-sent-outcome.spec.ts:357-359, :486, :593, :659, :718`,
  `org-lists.spec.ts:366`, `partner-share.spec.ts:151-153`,
  `a2p-compliance.spec.ts:385-390, :440`) selects by list name + `li` hasText +
  the visible tag (`getByText('Already sent')`), all of which this task keeps.
  So the "already sent selectors" rewrite listed for S8 is EMPTY; S8 re-greps
  `'already sent'` / `<U+2014> already sent` after S6 lands to confirm.
- `a2p-compliance.spec.ts:387` pins the visible no-consent tag WITH its em dash:
  unchanged (NO_CONSENT_TAG_TEXT renders the same string).
- `partner-share.spec.ts:151` (exactly 1 checkbox in the list): holds - the
  header is outside the `ul` and carries no checkbox.
- No spec reads the review list positionally (`nth` / `first`), so the new
  order breaks nothing; every `getByText('Already sent')` is row-scoped, so the
  new "Already sent" text inside the search option (a body portal) cannot
  collide.
- New in S8 e2e (3): select a declined row as
  `getByRole('checkbox', { name: '<name> - not interested' })` (or
  `'<name> - already sent, not interested'` when the tenant also had the
  share), the tag with `row.getByText('Not interested')`, and the header with
  `getByText('Last heard from')` scoped to the review step (aria-hidden header:
  query by text, not role). The phrase "Last heard from" is NEVER DOM text
  inside `<ul aria-label="Candidate recipients">` (the narrow prefix is CSS
  `::before`); a row's last-heard-from cell text is the bare label (`Never` or
  the formatHeardFrom label), so a bare-label regex matches the cell.

Commit: `feat(dashboard): review recipients - columns, last-heard-from order, not-interested rows`.

---

## S7 - the waiting list: Follow up tab + Properties count (spec 5.6, 14.4)

### Task 7.1 - the follow-ups builder and `GET /api/broadcasts/follow-ups`

RED 1 - new `app/test/followUps.test.ts` (pure builder over hand-written fakes):

```ts
// Follow-ups builder (last-heard-from spec 5.6 + 14.4): eligibility, the QUIET
// and LOOKBACK thresholds, ordering, byUnit, labels, the one contacts batch,
// and the capped available-unit walk. Pure - every repo is a fake.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { ListUnitsOpts, UnitItem, UnitsPage } from '../src/repos/unitsRepo.js';
import { buildFollowUps, FOLLOW_UPS_UNIT_CAP, type FollowUpsDeps } from '../src/services/followUps.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = Date.parse('2026-10-12T15:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

interface World {
  units: UnitItem[];
  sends: ListingSendItem[];
  tours: TourItem[];
  contacts: ContactItem[];
}
const emptyWorld = (): World => ({ units: [], sends: [], tours: [], contacts: [] });

function unit(unitId: string, over: Partial<UnitItem> = {}): UnitItem {
  return { unitId, landlordId: 'c-ll', status: 'available', ...over };
}
function tenant(contactId: string, over: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'tenant', status: 'searching', phone: '+15550100000', firstName: 'Ten', lastName: contactId, ...over };
}
function send(unitId: string, contactId: string, sentAt: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
  return { unitId, contactId, sentAt, via: 'individual', counted: true, created_at: sentAt, updated_at: sentAt, ...over };
}
function requestedTour(unitId: string, tenantId: string, createdAt: string): TourItem {
  return { tourId: `t-${unitId}-${tenantId}`, tenantId, unitId, _schedPartition: 'tours', tourType: 'self_guided', status: 'requested', createdAt, updatedAt: createdAt };
}

/** Fakes over `world`. `pageSize` forces short unit pages (the real byStatus
 *  page is shortened by the soft-delete filter); the fake returns deleted units
 *  too, so the builder must skip them itself. */
function depsFor(world: World, pageSize = Number.POSITIVE_INFINITY) {
  const calls = {
    listByStatus: [] as ListUnitsOpts[],
    listByUnit: [] as string[],
    toursByUnit: [] as string[],
    batches: [] as Array<{ ids: string[]; requireComplete: boolean | undefined }>,
  };
  const capture = createLogCapture();
  const deps: FollowUpsDeps = {
    units: {
      async listByStatus(status: string, o: ListUnitsOpts = {}): Promise<UnitsPage> {
        calls.listByStatus.push(o);
        const all = world.units.filter((u) => u.status === status);
        const cursor = (o.exclusiveStartKey as { unitId?: string } | undefined)?.unitId;
        const start = cursor === undefined ? 0 : all.findIndex((u) => u.unitId === cursor) + 1;
        const limit = Math.min(o.limit ?? all.length, pageSize);
        const items = all.slice(start, start + limit);
        const last = items[items.length - 1];
        return { items, ...(start + limit < all.length && last !== undefined && { lastEvaluatedKey: { unitId: last.unitId } }) };
      },
    },
    listingSends: {
      async listByUnit(unitId: string) {
        calls.listByUnit.push(unitId);
        return world.sends.filter((s) => s.unitId === unitId);
      },
    },
    tours: {
      async listByUnit(unitId: string) {
        calls.toursByUnit.push(unitId);
        return world.tours.filter((t) => t.unitId === unitId);
      },
    },
    contacts: {
      async getManyByIds(ids: string[], o?: { requireComplete?: boolean }) {
        calls.batches.push({ ids: [...ids], requireComplete: o?.requireComplete });
        return new Map(world.contacts.filter((c) => ids.includes(c.contactId)).map((c) => [c.contactId, c] as const));
      },
    },
    log: createLogger({ destination: capture.stream }),
    now: NOW,
  };
  return { deps, calls, capture };
}

describe('buildFollowUps (last-heard-from 5.6)', () => {
  it('keeps a no-reply send quiet for 24h+; drops one still inside the QUIET window', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c1'), tenant('c2'));
    w.sends.push(send('u1', 'c1', ago(2 * DAY)), send('u1', 'c2', ago(2 * HOUR)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items).toEqual([
      {
        unitId: 'u1',
        unitLabel: 'u1',
        contactId: 'c1',
        name: 'Ten c1',
        type: 'tenant',
        sentAt: ago(2 * DAY),
        outcome: 'no_reply',
        interestedSupported: true,
        interestedMode: 'form',
        waitingSince: ago(2 * DAY),
      },
    ]);
    expect(out.byUnit).toEqual({ u1: 1 });
    expect(out.truncated).toBe(false);
  });

  it('LOOKBACK: a send 15 days old drops off; 13 days old stays', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-old'), tenant('c-in'));
    w.sends.push(send('u1', 'c-old', ago(15 * DAY)), send('u1', 'c-in', ago(13 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId)).toEqual(['c-in']);
  });

  it('replied-then-quiet appears (waiting since the reply); a fresh reply hides the row', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-quiet', { last_heard_from_at: ago(3 * DAY) }), tenant('c-fresh', { last_heard_from_at: ago(2 * HOUR) }));
    w.sends.push(send('u1', 'c-quiet', ago(5 * DAY)), send('u1', 'c-fresh', ago(5 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ contactId: 'c-quiet', outcome: 'replied', lastHeardFromAt: ago(3 * DAY), waitingSince: ago(3 * DAY) });
  });

  it('drops Interested (a qualifying tour) and Not interested (an effective decline)', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c-tour'), tenant('c-no'), tenant('c-wait'));
    w.sends.push(
      send('u1', 'c-tour', ago(3 * DAY)),
      send('u1', 'c-no', ago(3 * DAY), { declined: { at: ago(2 * DAY), by: 'staff', staffId: 'user-0002' } }),
      send('u1', 'c-wait', ago(3 * DAY)),
    );
    w.tours.push(requestedTour('u1', 'c-tour', ago(1 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId)).toEqual(['c-wait']);
  });

  it('eligibility: drops deleted, opted-out, unreachable, phone-less and inactive/placed tenants; keeps a partner', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    const noPhone = tenant('c-nophone');
    delete noPhone.phone;
    w.contacts.push(
      tenant('c-del', { deleted_at: '2026-10-01T00:00:00.000Z' }),
      tenant('c-stop', { sms_opt_out: true }),
      tenant('c-unreach', { sms_unreachable: true }),
      noPhone,
      tenant('c-inactive', { status: 'inactive' }),
      tenant('c-placed', { status: 'placed' }),
      tenant('c-ok'),
      { contactId: 'p-1', type: 'partner', status: 'active', phone: '+15550100099', firstName: 'Renee', lastName: 'Carter', role: 'Case worker' } as ContactItem,
    );
    for (const c of w.contacts) w.sends.push(send('u1', c.contactId, ago(3 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => i.contactId).sort()).toEqual(['c-ok', 'p-1']);
    expect(out.items.find((i) => i.contactId === 'p-1')).toMatchObject({ type: 'partner', role: 'Case worker', interestedSupported: false, name: 'Renee Carter' });
  });

  it('drops a row whose contact is gone (no Text action could work)', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.sends.push(send('u1', 'c-gone', ago(3 * DAY)));
    expect((await buildFollowUps(depsFor(w).deps)).items).toEqual([]);
  });

  it('orders longest-waiting first across properties; byUnit, unitLabel and interestedMode per property', async () => {
    const w = emptyWorld();
    w.units.push(
      unit('u1', { address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' }, tour_type: 'self_guided' }),
      unit('u2'),
    );
    w.contacts.push(tenant('c1'), tenant('c2'), tenant('c3'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)), send('u2', 'c2', ago(6 * DAY)), send('u1', 'c3', ago(8 * DAY)));
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => `${i.unitId}/${i.contactId}`)).toEqual(['u1/c3', 'u2/c2', 'u1/c1']);
    expect(out.byUnit).toEqual({ u1: 2, u2: 1 });
    expect(out.items[0]).toMatchObject({ unitLabel: '12 Oak St, Atlanta, GA 30303', interestedMode: 'route' });
    expect(out.items[1]).toMatchObject({ unitLabel: 'u2', interestedMode: 'form' });
  });

  it('ONE requireComplete contacts batch of unique ids; no tours read for a property with no sends', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'), unit('u2'), unit('u3'));
    w.contacts.push(tenant('c1'), tenant('c2'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)), send('u2', 'c1', ago(3 * DAY)), send('u2', 'c2', ago(3 * DAY)));
    const { deps, calls } = depsFor(w);
    await buildFollowUps(deps);
    expect(calls.batches).toHaveLength(1);
    expect(calls.batches[0]!.ids.sort()).toEqual(['c1', 'c2']);
    expect(calls.batches[0]!.requireComplete).toBe(true);
    expect(calls.toursByUnit.sort()).toEqual(['u1', 'u2']);
  });

  it('walks byStatus pages on lastEvaluatedKey and skips soft-deleted properties', async () => {
    const w = emptyWorld();
    const del = { deleted_at: '2026-10-01T00:00:00.000Z' };
    w.units.push(unit('d1', del), unit('live1'), unit('d2', del), unit('d3', del), unit('live2'));
    const { deps, calls } = depsFor(w, 2);
    const out = await buildFollowUps(deps);
    expect(calls.listByStatus).toHaveLength(3);
    expect(calls.listByUnit).toEqual(['live1', 'live2']);
    expect(out.truncated).toBe(false);
  });

  it('caps the walk at 100 KEPT properties: a 101st sets truncated and WARNs', async () => {
    const w = emptyWorld();
    for (let i = 0; i < FOLLOW_UPS_UNIT_CAP + 1; i += 1) w.units.push(unit(`u${String(i).padStart(3, '0')}`));
    const { deps, calls, capture } = depsFor(w, 50);
    const out = await buildFollowUps(deps);
    expect(calls.listByUnit).toHaveLength(FOLLOW_UPS_UNIT_CAP);
    expect(out.truncated).toBe(true);
    expect(capture.atLevel(40).filter((l) => String(l['msg'] ?? '').includes('cap'))).toHaveLength(1);
  });

  it('exactly 100 kept properties (plus deleted ones) is NOT truncated', async () => {
    const w = emptyWorld();
    for (let i = 0; i < FOLLOW_UPS_UNIT_CAP; i += 1) w.units.push(unit(`u${String(i).padStart(3, '0')}`));
    w.units.push(unit('zz-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' }));
    const { deps, capture } = depsFor(w, 50);
    const out = await buildFollowUps(deps);
    expect(out.truncated).toBe(false);
    expect(capture.atLevel(40)).toHaveLength(0);
  });

  it('a failed required read REJECTS (the route answers 503) - sends, tours or contacts', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c1'));
    w.sends.push(send('u1', 'c1', ago(3 * DAY)));
    const a = depsFor(w).deps;
    a.listingSends = { listByUnit: async () => { throw new Error('throttled'); } };
    await expect(buildFollowUps(a)).rejects.toThrow('throttled');
    const b = depsFor(w).deps;
    b.tours = { listByUnit: async () => { throw new Error('throttled'); } };
    await expect(buildFollowUps(b)).rejects.toThrow('throttled');
    const c = depsFor(w).deps;
    c.contacts = { getManyByIds: async () => { throw new Error('IncompleteBatchReadError'); } };
    await expect(buildFollowUps(c)).rejects.toThrow('IncompleteBatchReadError');
  });
});
```

RED 2 - new `app/test/followUpsApi.test.ts` (the route through the harness):

```ts
// GET /api/broadcasts/follow-ups (last-heard-from spec 5.6, 14.4): the route
// serves the builder's list, is not shadowed by another broadcasts handler,
// and answers 503 outcome_unavailable when a required join fails (D12).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function seed(world: FakeWorld): void {
  const units: UnitItem[] = [
    { unitId: 'u-a', landlordId: 'c-ll', status: 'available', address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' }, tour_type: 'self_guided' },
    { unitId: 'u-b', landlordId: 'c-ll', status: 'available' },
    { unitId: 'u-off', landlordId: 'c-ll', status: 'on_hold' },
  ];
  for (const u of units) world.units.set(u.unitId, u);
  const tenant = (contactId: string, phone: string): ContactItem => ({ contactId, type: 'tenant', status: 'searching', phone, firstName: 'Ten', lastName: contactId });
  world.contacts.push(tenant('c-1', '+15550100001'), tenant('c-2', '+15550100002'), tenant('c-3', '+15550100003'));
  const send = (unitId: string, contactId: string, sentAt: string): ListingSendItem => ({ unitId, contactId, sentAt, via: 'individual', counted: true, created_at: sentAt, updated_at: sentAt });
  world.listingSends.push(send('u-a', 'c-1', ago(3 * DAY)), send('u-b', 'c-2', ago(5 * DAY)), send('u-off', 'c-3', ago(3 * DAY)));
}

function get(app: import('express').Express) {
  return request(app).get('/api/broadcasts/follow-ups').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
}

describe('GET /api/broadcasts/follow-ups', () => {
  it('serves the waiting rows of AVAILABLE properties, longest-waiting first, with byUnit', async () => {
    const world = createFakeWorld();
    seed(world);
    const { app } = makeWebhookHarness({ world });
    const res = await get(app);
    expect(res.status).toBe(200);
    // Exactly the builder's three keys - not the GET /broadcasts list, not a 404.
    expect(Object.keys(res.body).sort()).toEqual(['byUnit', 'items', 'truncated']);
    expect(res.body.items.map((i: { unitId: string; contactId: string }) => `${i.unitId}/${i.contactId}`)).toEqual(['u-b/c-2', 'u-a/c-1']);
    expect(res.body.items[1]).toMatchObject({ unitLabel: '12 Oak St, Atlanta, GA 30303', interestedMode: 'route', outcome: 'no_reply' });
    expect(res.body.byUnit).toEqual({ 'u-a': 1, 'u-b': 1 });
    expect(res.body.truncated).toBe(false);
  });

  it('503 outcome_unavailable when the contacts batch fails', async () => {
    const world = createFakeWorld();
    seed(world);
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValueOnce(new Error('IncompleteBatchReadError'));
    const { app } = makeWebhookHarness({ world });
    const res = await get(app);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
  });

  it('503 outcome_unavailable when a listing-sends read fails', async () => {
    const world = createFakeWorld();
    seed(world);
    vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
    const { app } = makeWebhookHarness({ world });
    expect((await get(app)).status).toBe(503);
  });
});
```

RED today: the module does not exist / the route 404s.

GREEN 1 - new `app/src/services/followUps.ts`:

```ts
// Follow-ups (last-heard-from spec 5.6 + 14.4): the waiting list behind
// Matching's "Follow up" tab and the Properties list "<n> waiting" pill.
//
// Candidate sends = every LISTED listing_sends row on every unit in status
// `available` (byStatus pages walked until 100 KEPT units or exhaustion - the
// GSI is hash-only and the soft-delete filter shortens pages, so the walk
// follows lastEvaluatedKey). Joins (all REQUIRED, D12 - any failure rejects and
// the route answers 503): listByUnit + tours.listByUnit per unit, then ONE
// requireComplete contacts batch. A row is kept when its outcome is no_reply or
// replied, the recipient is eligible (isEligibleRecipient - so every row's Text
// action can work), the send is inside LOOKBACK and the recipient has been quiet
// past QUIET (isWaiting). Order: longest-waiting first (oldest waitingSince), so
// a client grouping by property in first-appearance order gets groups ordered by
// their oldest row. Logs carry ids/counts only - never names or phones.
import { formatAddress } from '../lib/address.js';
import type { Logger } from '../lib/logger.js';
import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';
import {
  deriveListingSendOutcome,
  interestedModeFor,
  isEligibleRecipient,
  isWaiting,
  waitingSince,
  type InterestedMode,
  type ListingSendOutcome,
} from '../lib/listingSendOutcome.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ListingSendItem, ListingSendsRepo } from '../repos/listingSendsRepo.js';
import type { TourItem, ToursRepo } from '../repos/toursRepo.js';
import { isDeleted, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import { displayNameOfContact } from '../lib/contactDisplay.js';

/** Available properties read per request (spec 5.6: tens in practice). */
export const FOLLOW_UPS_UNIT_CAP = 100;
const UNIT_PAGE_LIMIT = 100;
/** Per-unit reads in flight at once (two Queries per unit). */
const PER_UNIT_CONCURRENCY = 10;

/** One waiting row (spec 5.6 as amended; mirrored in dashboard/src/api/types.ts). */
export interface FollowUpItem {
  unitId: string;
  /** formatAddress(unit.address) || unitId - the dashboard's shortAddress rule. */
  unitLabel: string;
  contactId: string;
  name: string;
  type: string;
  role?: string;
  sentAt: string;
  lastHeardFromAt?: string;
  outcome: ListingSendOutcome;
  /** Spec 5.6 lists it; never set here - a waiting row has no effective decline. */
  declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean;
  interestedMode: InterestedMode;
  /** max(sentAt, lastHeardFromAt) - the dashboard's N days counts from here. */
  waitingSince: string;
}

export interface FollowUpsResponse {
  items: FollowUpItem[];
  /** Waiting rows per unitId - the Properties list pill. */
  byUnit: Record<string, number>;
  /** True when more than FOLLOW_UPS_UNIT_CAP available properties exist. */
  truncated: boolean;
}

export interface FollowUpsDeps {
  units: Pick<UnitsRepo, 'listByStatus'>;
  listingSends: Pick<ListingSendsRepo, 'listByUnit'>;
  tours: Pick<ToursRepo, 'listByUnit'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  log: Logger;
  /** Epoch ms - the thresholds' clock. */
  now: number;
}

/** The row's name: the app's ONE display-name rule (lib/contactDisplay.ts
 *  displayNameOfContact - first + last, part-wise trimmed; undefined when no
 *  name is known), then the phone, then the id - FollowUpItem.name is required. */
function nameOf(contact: ContactItem): string {
  const display = displayNameOfContact(contact);
  if (display !== undefined) return display;
  return typeof contact.phone === 'string' && contact.phone.length > 0 ? contact.phone : contact.contactId;
}

function groupByTenant(tours: TourItem[]): Map<string, TourItem[]> {
  const out = new Map<string, TourItem[]>();
  for (const t of tours) {
    const arr = out.get(t.tenantId);
    if (arr === undefined) out.set(t.tenantId, [t]);
    else arr.push(t);
  }
  return out;
}

export async function buildFollowUps(deps: FollowUpsDeps): Promise<FollowUpsResponse> {
  // 1. The available properties: KEPT (non-deleted) units, capped. The walk
  //    reads past the cap only far enough to learn whether a 101st exists.
  const kept: UnitItem[] = [];
  let truncated = false;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.listByStatus('available', {
      limit: UNIT_PAGE_LIMIT,
      ...(cursor !== undefined && { exclusiveStartKey: cursor }),
    });
    for (const unit of page.items) {
      if (isDeleted(unit)) continue;
      if (kept.length === FOLLOW_UPS_UNIT_CAP) {
        truncated = true;
        break;
      }
      kept.push(unit);
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor !== undefined && !truncated);
  if (truncated) {
    deps.log.warn({ cap: FOLLOW_UPS_UNIT_CAP }, 'follow-ups: available-property walk hit the cap - list truncated');
  }

  // 2. Per-unit reads (each unit once per request), bounded fan-out.
  const perUnit: Array<{ unit: UnitItem; rows: ListingSendItem[]; toursByTenant: Map<string, TourItem[]> }> = [];
  for (let i = 0; i < kept.length; i += PER_UNIT_CONCURRENCY) {
    const loaded = await Promise.all(
      kept.slice(i, i + PER_UNIT_CONCURRENCY).map(async (unit) => {
        const rows = await deps.listingSends.listByUnit(unit.unitId);
        const unitTours = rows.length > 0 ? await deps.tours.listByUnit(unit.unitId) : [];
        return { unit, rows, toursByTenant: groupByTenant(unitTours) };
      }),
    );
    perUnit.push(...loaded);
  }

  // 3. ONE contacts batch; requireComplete because an absent contact would
  //    silently drop a row (an OUTCOME, not a label).
  const ids = [...new Set(perUnit.flatMap((u) => u.rows.map((r) => r.contactId)))];
  const byId = ids.length > 0 ? await deps.contacts.getManyByIds(ids, { requireComplete: true }) : new Map<string, ContactItem>();

  // 4. Keep the waiting rows.
  const items: FollowUpItem[] = [];
  for (const { unit, rows, toursByTenant } of perUnit) {
    for (const row of rows) {
      if (typeof row.sentAt !== 'string') continue; // listByUnit returns LISTED rows only; a type guard
      const contact = byId.get(row.contactId);
      if (contact === undefined) continue; // the contact row is gone: nobody to text
      const lastHeardFromAt = typeof contact.last_heard_from_at === 'string' ? contact.last_heard_from_at : undefined;
      const pairTours = toursByTenant.get(row.contactId) ?? [];
      const outcome = deriveListingSendOutcome({
        row,
        recipientType: contact.type,
        lastHeardFromAt,
        tour: deriveTourSignal(pairTours),
        tourActivityAt: deriveTourActivityAt(pairTours),
      });
      const eligible = isEligibleRecipient(contact);
      if (!isWaiting({ outcome, eligible, sentAt: row.sentAt, ...(lastHeardFromAt !== undefined && { lastHeardFromAt }), now: deps.now })) continue;
      const role = typeof contact.role === 'string' && contact.role.trim().length > 0 ? contact.role.trim() : undefined;
      items.push({
        unitId: unit.unitId,
        unitLabel: formatAddress(unit.address) || unit.unitId,
        contactId: row.contactId,
        name: nameOf(contact),
        type: contact.type,
        ...(role !== undefined && { role }),
        sentAt: row.sentAt,
        ...(lastHeardFromAt !== undefined && { lastHeardFromAt }),
        outcome,
        interestedSupported: contact.type === 'tenant',
        interestedMode: interestedModeFor(unit),
        waitingSince: waitingSince(row.sentAt, lastHeardFromAt),
      });
    }
  }

  // 5. Longest-waiting first; stable ties by unit then contact.
  items.sort(
    (a, b) =>
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.unitId.localeCompare(b.unitId) ||
      a.contactId.localeCompare(b.contactId),
  );
  const byUnit: Record<string, number> = {};
  for (const item of items) byUnit[item.unitId] = (byUnit[item.unitId] ?? 0) + 1;
  return { items, byUnit, truncated };
}
```

GREEN 1a (do this BEFORE GREEN 1 - the builder imports it) - move the app's
one display-name rule into a lib module (plan review R1 #12, R2 #2: a service
must not import a route - `routes/units.ts` pulls the media/transcode stack
into the pure builder test). No behavior change; the existing units suites
cover every caller.

- New `app/src/lib/contactDisplay.ts` - the function body is `units.ts:165-176`
  verbatim; the doc comment is `:155-164` with its one em dash (`:157`) written
  as " - " (a new file is ASCII-only):

```ts
// The app's ONE contact display-name rule (moved from routes/units.ts by
// last-heard-from, plan review R2 #2, so a service can share it without
// importing a route).

/**
 * BE3/C3: the denormalized display name for a roster row, from the contact's
 * firstName/lastName (joined + trimmed). HONEST - undefined when no name is
 * known (never invents one); the roster row then has no `name`.
 */
// Takes the MINIMAL shape both contact reads satisfy - a whole ContactItem
// (getById / getManyByIds) and the ContactDisplayItem projection
// (getDisplayById / getDisplaysByIds). `contactId` is here only as the anchor
// that keeps TypeScript's weak-type check honest; the name comes from the two
// optional fields.
export function displayNameOfContact(contact: {
  contactId: string;
  firstName?: unknown;
  lastName?: unknown;
}): string | undefined {
  // Part-wise trim BEFORE the join (legacy padded parts must not render an
  // interior gap; new writes arrive trimmed via trimJsonBody).
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
```

- `app/src/routes/units.ts`: DELETE the local definition `:155-176` (doc
  comment through the closing `}`), and add ONE import line after `:84`
  (`import { isCaseworker } from '../lib/caseworkers.js';`):
  `import { displayNameOfContact } from '../lib/contactDisplay.js';`.
  Every existing call site (`:426`, `:1112`, `:1233`, `:1409`, `:1535`,
  `:1775`, `:1826`) and W2's outcome route keep the same name and resolve to
  the import - no other line changes.
- Run `npx vitest run test/unitsApi.test.ts test/unitsApiRoster.test.ts test/unitsApiPlacements.test.ts`
  plus typecheck: green before and after (a pure move).

GREEN 2 - `app/src/routes/broadcasts.ts` (deps and repos came in Task 6.2):

- Import: `import { buildFollowUps } from '../services/followUps.js';` after the
  Task 6.2 imports.
- Register between `:979` (the blank line after the send route's closing
  `});` at `:978`) and the comment at `:980` - i.e. ABOVE every
  `/broadcasts/:broadcastId...` GET:

```ts
  // GET /api/broadcasts/follow-ups - the waiting list behind Matching's Follow
  // up tab and the Properties list pill (last-heard-from spec 5.6, 14.4).
  // { items, byUnit, truncated }; 503 outcome_unavailable when a required read
  // fails (D12 - an outcome shown with buttons is never guessed). Registered
  // ABOVE every /broadcasts/:broadcastId route so a future
  // GET /broadcasts/:broadcastId cannot answer this path. Mounted under /api
  // (all methods at the edge already) - no CloudFront change.
  router.get('/broadcasts/follow-ups', async (_req, res) => {
    mergeContext({});
    try {
      const out = await buildFollowUps({ units, listingSends, tours, contacts, log, now: Date.now() });
      log.info(
        { items: out.items.length, units: Object.keys(out.byUnit).length, truncated: out.truncated },
        'follow-ups served',
      );
      res.json(out);
    } catch (err) {
      log.warn({ err }, 'follow-ups: a required read failed - 503');
      res.status(503).json({ error: 'outcome_unavailable' });
    }
  });
```

- Header route list (`:6-11`): add one ASCII line after `:11`:
  `//   GET  /api/broadcasts/follow-ups                                                  -> { items, byUnit, truncated } | 503 outcome_unavailable`.

Run: `npx vitest run test/followUps.test.ts test/followUpsApi.test.ts`; typecheck.

Commit: `feat(app): GET /api/broadcasts/follow-ups - the waiting list`.

### Task 7.2 - the dev seam `POST /__dev/listing-send-fixture`

Contract (plan-head dev-seam row as amended by plan review R1 #11 / R2 #3):
`{ unitId, contactId, sentAt }` -> 201 `{ row }` on a FRESH pair (no
listing_sends row yet); 409 `{ error: 'send_exists' }` when the pair already
has a row, listed or not (create-only - it never overwrites a shares map or
moves a sentAt); 400 on a bad body; 404 `unit_not_found` / `contact_not_found`.
S8's e2e 8.6 therefore plants each pair ONCE, on a pair the spec created.

RED - new `app/test/devListingSendFixture.test.ts` (the `devOrgFixture.test.ts:1-55` shape):

```ts
// POST /__dev/listing-send-fixture (last-heard-from spec 14.4, e2e (6)): the
// hermetic seam that plants a LISTED, counted listing-send row with a chosen
// sentAt through putShareMemory - a real send's sentAt is always "now", so
// nothing else can put a send past the 24-hour QUIET threshold in front of
// the Follow up tab. 201 { row } on a fresh pair; 409 { error: 'send_exists' }
// when the pair already has a row. Built like devOrgFixture.test.ts.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SEAM = '/__dev/listing-send-fixture';

function buildHarness(): { app: Express; world: FakeWorld } {
  const world = createFakeWorld();
  const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
  const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: 'test-origin-secret', MESSAGING_DRIVER: 'console' });
  const devRouter = createDevRouter({
    config,
    logger,
    orgFixtureRepos: { contactsRepo: world.contactsRepo, unitsRepo: world.unitsRepo },
    listingSendsRepo: world.listingSendsRepo,
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  world.contacts.push({ contactId: 'c-fix', type: 'tenant', status: 'searching', phone: '+15550100001' });
  world.units.set('u-fix', { unitId: 'u-fix', landlordId: 'c-landlord', status: 'available' });
  return { app, world };
}

describe('POST /__dev/listing-send-fixture', () => {
  it('201: writes a LISTED, counted row with the given sentAt (normalized), one counted individual share', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T08:00:00-04:00' });
    expect(res.status).toBe(201);
    expect(res.body.row).toMatchObject({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z', counted: true });
    const listed = await world.listingSendsRepo.listByUnit('u-fix');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.shares).toEqual({
      individual: { attempt: '!individual', state: 'counted', by: 'acceptance', countedAt: '2026-10-01T12:00:00.000Z' },
    });
  });

  it('409 send_exists when the pair already has a row - never overwrites its shares or moves sentAt (plan review R1 #11)', async () => {
    const { app, world } = buildHarness();
    expect((await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-03T12:00:00.000Z' })).status).toBe(201);
    const before = structuredClone(world.listingSends[0]!);
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'send_exists' });
    expect(world.listingSends).toHaveLength(1);
    expect(world.listingSends[0]).toEqual(before);
  });

  it('409 send_exists for a pre-existing UN-counted row too (any row, listed or not)', async () => {
    const { app, world } = buildHarness();
    world.listingSends.push({
      unitId: 'u-fix',
      contactId: 'c-fix',
      via: 'broadcast',
      counted: false,
      created_at: '2026-10-01T12:00:00.000Z',
      updated_at: '2026-10-01T12:00:00.000Z',
    });
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-02T12:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'send_exists' });
    expect(world.listingSends[0]!.sentAt).toBeUndefined();
  });

  it('400 without unitId/contactId, or with an unparseable sentAt', async () => {
    const { app } = buildHarness();
    expect((await request(app).post(SEAM).send({ contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' })).status).toBe(400);
    expect((await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: 'yesterday' })).status).toBe(400);
  });

  it('404 unit_not_found / contact_not_found', async () => {
    const { app } = buildHarness();
    const noUnit = await request(app).post(SEAM).send({ unitId: 'u-none', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(noUnit.status).toBe(404);
    expect(noUnit.body).toEqual({ error: 'unit_not_found' });
    const noContact = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-none', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(noContact.status).toBe(404);
    expect(noContact.body).toEqual({ error: 'contact_not_found' });
  });
});
```

RED today: the route 404s and `listingSendsRepo` is not a `DevRouterDeps` member.

GREEN - `app/src/routes/dev.ts`:

- Imports, after `:56`:

```ts
import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';
import { INDIVIDUAL_ATTEMPT_KEY } from '../lib/shareAttemptOrder.js';
```

- `DevRouterDeps` (`:106-145`), after `orgFixtureRepos?: ...;` (`:144`):

```ts
  /** Repo for POST /__dev/listing-send-fixture (last-heard-from: 201 { row } on a
   *  fresh pair, 409 { error: 'send_exists' } when the pair already has a row) -
   *  injected in tests (the world fake); defaults to the real listing-sends repo. */
  listingSendsRepo?: ListingSendsRepo;
```

- The route, between `:1259` (the blank line after the org-fixture route's
  closing `});` at `:1258`) and `:1260`:

```ts
  // POST /__dev/listing-send-fixture { unitId, contactId, sentAt } - plant a
  // LISTED, counted listing-send row with a chosen sentAt (last-heard-from
  // spec 14.4, e2e (6)). A real send's sentAt is the provider instant (now), so
  // nothing else can put a send older than the 24-hour QUIET threshold in front
  // of the Follow up tab. Written through putShareMemory as ONE counted
  // `individual` share entry (the shape shareLedger seeds for an individual
  // send), so the readers list it exactly like a real send. Answers: 201
  // { row } on a FRESH pair; 409 { error: 'send_exists' } when the pair
  // already has a row (create-only); 400 bad body; 404 unit_not_found /
  // contact_not_found. Never writes `declined` or
  // any outcome (I2). No threshold
  // override exists anywhere. Same hermetic-LOCAL-only construction as the
  // fixtures above (the dev router only mounts behind lib/devRoutes.ts:
  // DEV_AUTH_ENABLED, not production, a DynamoDB Local endpoint); json() is
  // scoped to this route. Logs ids only.
  let listingSendFixtureRepo = deps.listingSendsRepo;
  const listingSendFixtureDeps = (): ListingSendsRepo => {
    listingSendFixtureRepo ??= createListingSendsRepo({ logger: log });
    return listingSendFixtureRepo;
  };
  router.post('/__dev/listing-send-fixture', json(), async (req, res) => {
    const body = (req.body ?? {}) as { unitId?: unknown; contactId?: unknown; sentAt?: unknown };
    const unitId = typeof body.unitId === 'string' && body.unitId !== '' ? body.unitId : undefined;
    const contactId = typeof body.contactId === 'string' && body.contactId !== '' ? body.contactId : undefined;
    if (unitId === undefined || contactId === undefined) {
      res.status(400).json({ error: 'unitId and contactId are required' });
      return;
    }
    const sentAtMs = typeof body.sentAt === 'string' ? Date.parse(body.sentAt) : Number.NaN;
    if (Number.isNaN(sentAtMs)) {
      res.status(400).json({ error: 'sentAt must be an ISO 8601 instant' });
      return;
    }
    const sentAt = new Date(sentAtMs).toISOString();
    const { contactsRepo, unitsRepo } = orgFixtureDeps();
    if ((await unitsRepo.getById(unitId)) === undefined) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    if ((await contactsRepo.getById(contactId)) === undefined) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const listingSends = listingSendFixtureDeps();
    // CREATE ONLY (plan review R1 #11): a pair that already has a row - listed
    // or not - is refused, so the seam never overwrites a real share memory or
    // moves a sentAt backward. A spec creates its own fresh pair per run.
    if ((await listingSends.getByKeyConsistent(unitId, contactId)) !== undefined) {
      res.status(409).json({ error: 'send_exists' });
      return;
    }
    // token undefined = putShareMemory's `attribute_not_exists(shares_op)`
    // condition; with the read above it can only lose to a concurrent create.
    const written = await listingSends.putShareMemory(
      unitId,
      contactId,
      {
        shares: { individual: { attempt: INDIVIDUAL_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: sentAt } },
        counted: true,
        sentAt,
        broadcastId: undefined,
      },
      { token: undefined },
    );
    if (!written) {
      res.status(409).json({ error: 'send_exists' });
      return;
    }
    const row = await listingSends.getByKeyConsistent(unitId, contactId);
    log.info({ unitId, contactId }, 'dev listing-send fixture written');
    res.status(201).json({ row });
  });
```

  (`orgFixtureDeps` is the lazy contacts+units pair the org-fixture route
  defines at `:1205-1212`, in scope here. If S1.11 (W1) has added
  `contactsRepo` to `DevRouterDeps`, keep using `orgFixtureDeps()` here - it is
  the injected world fake in tests either way. `putShareMemory`'s
  `#via = if_not_exists(#via, 'broadcast')` stamps `via: 'broadcast'` on a new
  row with no broadcastId - harmless for the outcome; note it in S8 if a spec
  reads `via`.)

Run: `npx vitest run test/devListingSendFixture.test.ts test/devOrgFixture.test.ts test/devGating.test.ts`.

Commit: `feat(dev): POST /__dev/listing-send-fixture - a backdated listed send for e2e`.

### Task 7.3 - dashboard: `useFollowUps`, `FollowUpView`, the Follow up tab

THE IN-PLACE RULE (plan review R1 #4, binding on the hook, the view, these
tests and S8's e2e 8.6): an actioned Follow up row shows its new state IN
PLACE for the session - after Not interested it reads `Not interested` with
an `Undo` button; after Interested (route mode) it shows the tour chip (or
`Interested`) - and stays in the list; the group's `<n> waiting` and the tab's
count drop at once. No action refetches. The row LEAVES the list on the next
load (a reload or remount of Matching, or a Retry), because the server no
longer serves it; every completed load replaces the session's resolutions.
Form-mode Interested and Text navigate away and resolve nothing. S8 reloads
the page before asserting a group is gone.

API (additive, after the existing members):

- `dashboard/src/api/types.ts`, after `PreviewResponse` (`:3388-3395`):

```ts
/** GET /api/broadcasts/follow-ups -> one waiting row (last-heard-from spec 5.6;
 *  app/src/services/followUps.ts FollowUpItem, hand-mirrored). */
export interface FollowUpItem {
  unitId: string;
  /** The property's short address (unitId when it has none). */
  unitLabel: string;
  contactId: string;
  name: string;
  type: ContactType;
  role?: string;
  sentAt: string;
  lastHeardFromAt?: string;
  outcome: ListingSendOutcome;
  declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean;
  interestedMode: InterestedMode;
  /** max(sentAt, lastHeardFromAt) - "N days" counts from here. */
  waitingSince: string;
}

/** GET /api/broadcasts/follow-ups response; 503 outcome_unavailable on a failed join. */
export interface FollowUpsResponse {
  items: FollowUpItem[];
  byUnit: Record<string, number>;
  truncated: boolean;
}
```

- `dashboard/src/api/endpoints.ts`, after `listBroadcasts` (`:1912-1920`):

```ts
/** GET /api/broadcasts/follow-ups - the waiting list (last-heard-from spec 5.6).
 *  Throws ApiError 503 outcome_unavailable when a required read failed. */
export function getFollowUps(signal?: AbortSignal): Promise<FollowUpsResponse> {
  return request<FollowUpsResponse>('/api/broadcasts/follow-ups', {
    ...(signal !== undefined && { signal }),
  });
}
```

  (add `FollowUpsResponse` to the file's type import from `./types.js`.)

RED 1 - new `dashboard/src/routes/broadcasts/FollowUpView.test.tsx` (renders
the REAL hook, so a resolve / undo round trip is exercised end to end):

```tsx
// FollowUpView tests (last-heard-from 5.6): grouping and order, the row
// content (dates, the N-days chips), the actions (Interested route / form,
// partner Request a tour, Not interested + Undo, Text), the error lines, and
// the empty / error / truncated states.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { FollowUpItem } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';

const getFollowUps = vi.fn();
const setListingSendOutcome = vi.fn();
const ensureContactConversation = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getFollowUps: (...a: unknown[]) => getFollowUps(...a),
    setListingSendOutcome: (...a: unknown[]) => setListingSendOutcome(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
  };
});

import { FollowUpView } from './FollowUpView.js';
import { useFollowUps } from './useFollowUps.js';

const NOW = new Date('2026-10-12T15:00:00.000Z');

function item(over: Partial<FollowUpItem> = {}): FollowUpItem {
  return {
    unitId: 'u1',
    unitLabel: '672 Cameron Alexander Blvd A',
    contactId: 'c1',
    name: 'Dario Vance',
    type: 'tenant',
    sentAt: '2026-10-02T12:00:00.000Z',
    outcome: 'no_reply',
    interestedSupported: true,
    interestedMode: 'route',
    waitingSince: '2026-10-02T12:00:00.000Z',
    ...over,
  };
}
const MARCUS = item({ unitId: 'u2', unitLabel: '1427 Griffin St, downstairs', contactId: 'c2', name: 'Marcus Dale', sentAt: '2026-10-06T12:00:00.000Z', waitingSince: '2026-10-06T12:00:00.000Z' });
const TASHA = item({ unitId: 'u2', unitLabel: '1427 Griffin St, downstairs', contactId: 'c3', name: 'Tasha Reed', outcome: 'replied', sentAt: '2026-10-06T12:00:00.000Z', lastHeardFromAt: '2026-10-07T12:00:00.000Z', waitingSince: '2026-10-07T12:00:00.000Z' });

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}
function Harness(): React.JSX.Element {
  const followUps = useFollowUps();
  return <FollowUpView followUps={followUps} now={NOW} />;
}
function renderView(items: FollowUpItem[], truncated = false): void {
  getFollowUps.mockResolvedValue({ items, byUnit: {}, truncated });
  render(
    <MemoryRouter initialEntries={['/broadcasts?tab=follow-up']}>
      <Routes>
        <Route path="/broadcasts" element={<Harness />} />
        <Route path="*" element={<div />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}
const group = (label: RegExp): HTMLElement => screen.getByRole('region', { name: label });
const rowOf = (name: string): HTMLElement => screen.getByRole('link', { name }).closest('li') as HTMLElement;

beforeEach(() => {
  getFollowUps.mockReset();
  setListingSendOutcome.mockReset();
  ensureContactConversation.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('FollowUpView - grouping and rows', () => {
  it('groups by property in server order (longest-waiting first), each with its own waiting count', async () => {
    renderView([item(), MARCUS, TASHA]);
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      '672 Cameron Alexander Blvd A1 waiting',
      '1427 Griffin St, downstairs2 waiting',
    ]);
    const griffin = within(group(/1427 Griffin St/)).getAllByRole('listitem');
    expect(griffin.map((li) => within(li).getByRole('link').textContent)).toEqual(['Marcus Dale', 'Tasha Reed']);
  });

  it('a row: contact link, Sent / Last heard from dates, and the N-days chip', async () => {
    renderView([item(), TASHA]);
    const dario = await screen.findByRole('link', { name: 'Dario Vance' });
    expect(dario).toHaveAttribute('href', '/contacts/c1');
    const row = rowOf('Dario Vance');
    expect(row).toHaveTextContent(`Sent ${formatHeardFrom('2026-10-02T12:00:00.000Z', NOW).label}`);
    expect(row).toHaveTextContent('Last heard from Never');
    expect(within(row).getByText('No reply yet, 10 days')).toBeInTheDocument();
    expect(within(rowOf('Tasha Reed')).getByText('Replied, quiet 5 days')).toBeInTheDocument();
  });

  it('one day reads "1 day"', async () => {
    renderView([item({ sentAt: '2026-10-11T12:00:00.000Z', waitingSince: '2026-10-11T12:00:00.000Z' })]);
    expect(await screen.findByText('No reply yet, 1 day')).toBeInTheDocument();
  });
});

describe('FollowUpView - actions', () => {
  it('Not interested marks the row and drops the count; Undo clears it back', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: {} });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance not interested in 672 Cameron Alexander Blvd A' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c1', 'not_interested');
    const row = rowOf('Dario Vance');
    expect(await within(row).findByText('Not interested')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('0 waiting');
    await u.click(within(row).getByRole('button', { name: 'Undo not interested for Dario Vance' }));
    expect(setListingSendOutcome).toHaveBeenLastCalledWith('u1', 'c1', 'clear');
    expect(await within(row).findByText('No reply yet, 10 days')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('1 waiting');
  });

  it('an actioned row stays IN PLACE for the session and leaves the list on the NEXT load', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: {} });
    renderView([item(), MARCUS]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    // In place: still listed, now with Undo; no refetch on an action.
    expect(await within(rowOf('Dario Vance')).findByRole('button', { name: 'Undo not interested for Dario Vance' })).toBeInTheDocument();
    expect(getFollowUps).toHaveBeenCalledTimes(1);
    // The next load (a fresh mount = a reload) is the server's truth, which no
    // longer serves the row: the row and its now-empty group are gone.
    cleanup();
    renderView([MARCUS]);
    expect(await screen.findByRole('link', { name: 'Marcus Dale' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dario Vance' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /672 Cameron Alexander Blvd A/ })).toBeNull();
  });

  it('Interested (route) records it and shows the tour chip', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockResolvedValue({ row: { tour: { tourId: 't1', state: 'requested' } } });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance interested in 672 Cameron Alexander Blvd A' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c1', 'interested');
    const chip = await within(rowOf('Dario Vance')).findByRole('link', { name: 'Tour requested' });
    expect(chip).toHaveAttribute('href', '/tours/t1');
    // In place: the row stays listed (no Interested / Not interested now); the count drops.
    expect(within(rowOf('Dario Vance')).queryByRole('button', { name: /interested in/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('0 waiting');
  });

  it('Interested (form - no tour type on the property) opens the tour form, no API call', async () => {
    const u = userEvent.setup();
    renderView([item({ interestedMode: 'form' })]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance interested/ }));
    expect(setListingSendOutcome).not.toHaveBeenCalled();
    expect(screen.getByTestId('path')).toHaveTextContent('/listings/u1?tour=new&tenantId=c1');
  });

  it('a partner row offers Request a tour instead of Interested', async () => {
    renderView([item({ type: 'partner', interestedSupported: false, name: 'Renee Carter' })]);
    const link = await screen.findByRole('link', { name: 'Request a tour for Renee Carter at 672 Cameron Alexander Blvd A' });
    expect(link).toHaveAttribute('href', '/listings/u1?tour=new');
    // A partner can still be marked not interested; only Interested is replaced.
    expect(screen.getByRole('button', { name: 'Mark Renee Carter not interested in 672 Cameron Alexander Blvd A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark Renee Carter interested/ })).toBeNull();
  });

  it('a landlord row (not a partner) shows NEITHER Interested NOR Request a tour (plan review R2 #1)', async () => {
    renderView([item({ type: 'landlord', interestedSupported: false, name: 'Keystone PM' })]);
    expect(await screen.findByRole('link', { name: 'Keystone PM' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Request a tour/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark Keystone PM interested/ })).toBeNull();
    // Not interested and Text stay available on any row.
    expect(screen.getByRole('button', { name: 'Mark Keystone PM not interested in 672 Cameron Alexander Blvd A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text Keystone PM' })).toBeInTheDocument();
  });

  it('Text opens the 1:1 conversation', async () => {
    const u = userEvent.setup();
    ensureContactConversation.mockResolvedValue('conv-9');
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Text Dario Vance' }));
    expect(ensureContactConversation).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversations/conv-9'));
  });

  it('a failed Text says so on the row', async () => {
    const u = userEvent.setup();
    ensureContactConversation.mockRejectedValue(new Error('down'));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Text Dario Vance' }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent("Couldn't open the conversation - try again.");
  });

  it('a 503 with saved:true reads "Saved - reload to see the change."; any other failure "Couldn\'t save - try again."', async () => {
    const u = userEvent.setup();
    setListingSendOutcome.mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true }));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent('Saved - reload to see the change.');
    setListingSendOutcome.mockRejectedValueOnce(new ApiError(500, 'internal', 'x'));
    await u.click(screen.getByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(await within(rowOf('Dario Vance')).findByRole('alert')).toHaveTextContent("Couldn't save - try again.");
  });

  it('disables the row actions while a call is in flight', async () => {
    const u = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    setListingSendOutcome.mockReturnValue(new Promise((r) => { release = r; }));
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: /Mark Dario Vance not interested/ }));
    expect(screen.getByRole('button', { name: /Mark Dario Vance interested/ })).toBeDisabled();
    release({ row: {} });
    expect(await within(rowOf('Dario Vance')).findByText('Not interested')).toBeInTheDocument();
  });
});

describe('FollowUpView - states', () => {
  it('empty', async () => {
    renderView([]);
    expect(await screen.findByText('Nothing waiting on a reply.')).toBeInTheDocument();
  });
  it('error, then Retry refetches', async () => {
    const u = userEvent.setup();
    getFollowUps.mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x'));
    render(
      <MemoryRouter initialEntries={['/broadcasts']}>
        <Routes>
          <Route path="/broadcasts" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load follow-ups.");
    getFollowUps.mockResolvedValueOnce({ items: [item()], byUnit: { u1: 1 }, truncated: false });
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Dario Vance' })).toBeInTheDocument();
  });
  it('truncated', async () => {
    renderView([item()], true);
    expect(await screen.findByText('Showing follow-ups for the first 100 available properties.')).toBeInTheDocument();
  });
});
```

RED 1b - new `dashboard/src/routes/broadcasts/useFollowUps.test.tsx` (the
in-place rule at the hook: a session resolution is local; a completed load
replaces it):

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpItem } from '../../api/index.js';

const getFollowUps = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getFollowUps: (...a: unknown[]) => getFollowUps(...a) };
});

import { followUpKey, useFollowUps } from './useFollowUps.js';

const ITEM: FollowUpItem = {
  unitId: 'u1',
  unitLabel: '12 Oak St',
  contactId: 'c1',
  name: 'Dario Vance',
  type: 'tenant',
  sentAt: '2026-10-02T12:00:00.000Z',
  outcome: 'no_reply',
  interestedSupported: true,
  interestedMode: 'route',
  waitingSince: '2026-10-02T12:00:00.000Z',
};

beforeEach(() => getFollowUps.mockReset().mockResolvedValue({ items: [ITEM], byUnit: { u1: 1 }, truncated: false }));

describe('useFollowUps - the in-place rule (plan review R1 #4)', () => {
  it('resolve keeps the row in items, drops waitingCount, and does NOT refetch; unresolve restores it', async () => {
    const { result } = renderHook(() => useFollowUps());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.resolve(ITEM, { kind: 'not_interested' }));
    expect(result.current.items).toEqual([ITEM]);
    expect(result.current.resolutions.get(followUpKey(ITEM))).toEqual({ kind: 'not_interested' });
    expect(result.current.waitingCount).toBe(0);
    expect(getFollowUps).toHaveBeenCalledTimes(1);
    act(() => result.current.unresolve(ITEM));
    expect(result.current.waitingCount).toBe(1);
  });

  it('a completed load replaces the session resolutions with the server truth', async () => {
    const { result } = renderHook(() => useFollowUps());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.resolve(ITEM, { kind: 'not_interested' }));
    getFollowUps.mockResolvedValueOnce({ items: [], byUnit: {}, truncated: false });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getFollowUps).toHaveBeenCalledTimes(2);
    expect(result.current.items).toEqual([]);
    expect(result.current.resolutions.size).toBe(0);
    expect(result.current.waitingCount).toBe(0);
  });
});
```

RED 2 - `dashboard/src/routes/broadcasts/BroadcastsList.test.tsx` (D5):

- Mock (`:18-29`): add `const getFollowUps = vi.fn();` after `:15` and
  `getFollowUps: (...a: unknown[]) => getFollowUps(...a),` in the returned
  object. `beforeEach` (`:67-72`): add
  `getFollowUps.mockReset().mockResolvedValue({ items: [], byUnit: {}, truncated: false });`
  (every existing case then makes no real request).
- `renderList` (`:55-65`) becomes `function renderList(entry = '/broadcasts'): void`
  with `initialEntries={[entry]}`.
- New describe at the end:

```tsx
describe('BroadcastsList - Follow up tab (last-heard-from 5.6)', () => {
  const waiting = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      unitId: 'u1',
      unitLabel: '12 Oak St',
      contactId: `c${i}`,
      name: `Tenant ${i}`,
      type: 'tenant',
      sentAt: '2026-10-02T12:00:00.000Z',
      outcome: 'no_reply',
      interestedSupported: true,
      interestedMode: 'route',
      waitingSince: '2026-10-02T12:00:00.000Z',
    }));

  it('fetches follow-ups ONCE on mount and shows the count while All is active', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    getFollowUps.mockResolvedValue({ items: waiting(4), byUnit: { u1: 4 }, truncated: false });
    renderList();
    const tab = await screen.findByRole('tab', { name: 'Follow up 4' });
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(getFollowUps).toHaveBeenCalledTimes(1);
  });

  it('selecting Follow up writes ?tab=follow-up and shows the waiting list in the tab panel', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    getFollowUps.mockResolvedValue({ items: waiting(1), byUnit: { u1: 1 }, truncated: false });
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    await userEvent.setup().click(screen.getByRole('tab', { name: /^Follow up/ }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts?tab=follow-up');
    const tab = screen.getByRole('tab', { name: /^Follow up/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(within(panel).getByRole('heading', { name: /12 Oak St/ })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Property sends' })).toBeNull();
  });

  it('a deep link to ?tab=follow-up opens the tab directly', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList('/broadcasts?tab=follow-up');
    expect(await screen.findByText('Nothing waiting on a reply.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Follow up/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');
  });

  it('a status tab from Follow up drops ?tab and queries that status', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList('/broadcasts?tab=follow-up');
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Drafts' }));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/broadcasts$/);
    await waitFor(() => expect((listBroadcasts.mock.calls.at(-1)?.[0] as { status?: BroadcastStatus }).status).toBe('draft'));
  });

  it('every tab controls the one tab panel', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    const panelId = screen.getByRole('tabpanel').id;
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('aria-controls', panelId);
  });

  it('a failed follow-ups fetch shows no count and leaves the send list alone', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    getFollowUps.mockRejectedValue(new ApiError(503, 'outcome_unavailable', 'x'));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    expect(screen.getByRole('tab', { name: 'Follow up' })).toBeInTheDocument();
  });
});
```

GREEN 1 - new `dashboard/src/routes/broadcasts/useFollowUps.ts`:

```ts
// useFollowUps - the Follow up tab's data (last-heard-from spec 5.6, 14.4).
// Fetched ONCE when Matching mounts, whatever tab is active (the tab label
// carries the count), and handed to FollowUpView as props.
// THE RULE (plan review R1 #4): an actioned row shows its new state IN PLACE
// for the session - `resolve` marks it interested / not interested (the row
// stays listed, the counts drop at once), `unresolve` puts it back (Undo) -
// and it leaves the list on the NEXT load, because the server no longer
// serves it. No action refetches. Every completed load REPLACES the session's
// resolutions with the server's truth. Loading is DERIVED (a stale load reads
// as loading) so no effect sets state synchronously.
import { useCallback, useEffect, useState } from 'react';
import { getFollowUps, type FollowUpItem, type TourSignal } from '../../api/index.js';

export type FollowUpsStatus = 'loading' | 'ready' | 'error';

export type FollowUpResolution = { kind: 'interested'; tour?: TourSignal } | { kind: 'not_interested' };

export interface FollowUpsState {
  status: FollowUpsStatus;
  items: FollowUpItem[];
  truncated: boolean;
  /** Rows still waiting: the served items minus the ones resolved here. */
  waitingCount: number;
  /** This session's actions, by followUpKey - the rows shown in place. */
  resolutions: ReadonlyMap<string, FollowUpResolution>;
  resolve: (item: FollowUpItem, resolution: FollowUpResolution) => void;
  unresolve: (item: FollowUpItem) => void;
  /** A new load; when it completes it replaces `items` AND clears `resolutions`. */
  retry: () => void;
}

export function followUpKey(item: Pick<FollowUpItem, 'unitId' | 'contactId'>): string {
  return `${item.unitId}|${item.contactId}`;
}

const NO_ITEMS: FollowUpItem[] = [];

interface Loaded {
  status: 'ready' | 'error';
  items: FollowUpItem[];
  truncated: boolean;
  forLoad: number;
}

export function useFollowUps(): FollowUpsState {
  const [load, setLoad] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, FollowUpResolution>>(() => new Map());

  useEffect(() => {
    const controller = new AbortController();
    getFollowUps(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: 'ready', items: res.items, truncated: res.truncated, forLoad: load });
        // The next load is the server's truth: actioned rows are gone from it.
        setResolutions(new Map());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setLoaded({ status: 'error', items: NO_ITEMS, truncated: false, forLoad: load });
      });
    return () => controller.abort();
  }, [load]);

  const resolve = useCallback((item: FollowUpItem, resolution: FollowUpResolution) => {
    setResolutions((prev) => new Map(prev).set(followUpKey(item), resolution));
  }, []);
  const unresolve = useCallback((item: FollowUpItem) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.delete(followUpKey(item));
      return next;
    });
  }, []);
  const retry = useCallback(() => setLoad((n) => n + 1), []);

  const current = loaded !== null && loaded.forLoad === load ? loaded : null;
  const items = current?.items ?? NO_ITEMS;
  const waitingCount = items.filter((i) => !resolutions.has(followUpKey(i))).length;
  return {
    status: current === null ? 'loading' : current.status,
    items,
    truncated: current?.truncated ?? false,
    waitingCount,
    resolutions,
    resolve,
    unresolve,
    retry,
  };
}
```

GREEN 2 - new `dashboard/src/routes/broadcasts/FollowUpView.tsx`:

```tsx
// FollowUpView - Matching's "Follow up" tab (last-heard-from spec 5.6, 14.4).
// The waiting list grouped by property: a group is one available property
// (its short address and its own waiting count), rows longest-waiting first.
// Groups follow the server's order - longest-waiting first overall - so a
// group sorts by its oldest row. A row: the recipient (a link to the contact
// page, where the call action lives - the list adds no Call), Sent <date>,
// Last heard from <date>, the outcome chip, and Interested / Not interested /
// Text. Resolving a row keeps it on screen with its new chip and drops it from
// the counts; Undo puts a not-interested row back.
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ensureContactConversation, setListingSendOutcome, type FollowUpItem } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { daysSince, formatHeardFrom } from '../../lib/heardFrom.js';
// The ONE outcome-error copy rule (W2 Task 3.8): 503 with saved:true ->
// "Saved - reload to see the change.", anything else -> "Couldn't save - try again."
import { outcomeErrorCopy } from '../../lib/listingOutcomeErrors.js';
import { TourChip } from '../contact/Card.js';
import { followUpKey, type FollowUpResolution, type FollowUpsState } from './useFollowUps.js';
import styles from './FollowUpView.module.css';

export interface FollowUpViewProps {
  followUps: FollowUpsState;
  /** The clock for the dates and the N-days chips (tests pin it). */
  now?: Date;
}

const TEXT_FAILED = "Couldn't open the conversation - try again.";

function dayCount(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

function waitingChip(item: FollowUpItem, now: Date): string {
  const n = dayCount(daysSince(item.waitingSince, now));
  return item.outcome === 'replied' ? `Replied, quiet ${n}` : `No reply yet, ${n}`;
}

function groupByUnit(items: readonly FollowUpItem[]): Array<{ unitId: string; unitLabel: string; items: FollowUpItem[] }> {
  const groups = new Map<string, { unitId: string; unitLabel: string; items: FollowUpItem[] }>();
  for (const item of items) {
    let g = groups.get(item.unitId);
    if (g === undefined) {
      g = { unitId: item.unitId, unitLabel: item.unitLabel, items: [] };
      groups.set(item.unitId, g);
    }
    g.items.push(item);
  }
  return [...groups.values()];
}

function FollowUpRow({
  item,
  resolution,
  now,
  onResolve,
  onUnresolve,
}: {
  item: FollowUpItem;
  resolution: FollowUpResolution | undefined;
  now: Date;
  onResolve: (r: FollowUpResolution) => void;
  onUnresolve: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = formatHeardFrom(item.sentAt, now);
  const heard = formatHeardFrom(item.lastHeardFromAt, now);
  const unitPath = `/listings/${encodeURIComponent(item.unitId)}`;

  async function record(outcome: 'interested' | 'not_interested' | 'clear'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { row } = await setListingSendOutcome(item.unitId, item.contactId, outcome);
      if (outcome === 'clear') onUnresolve();
      else if (outcome === 'not_interested') onResolve({ kind: 'not_interested' });
      else onResolve({ kind: 'interested', ...(row.tour !== undefined && { tour: row.tour }) });
    } catch (err) {
      setError(outcomeErrorCopy(err));
    } finally {
      setBusy(false);
    }
  }

  async function openText(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const conversationId = await ensureContactConversation(item.contactId);
      navigate(`/conversations/${encodeURIComponent(conversationId)}`);
    } catch {
      setError(TEXT_FAILED);
      setBusy(false);
    }
  }

  return (
    <li className={styles.row}>
      <span className={styles.who}>
        <Link className={styles.name} to={`/contacts/${encodeURIComponent(item.contactId)}`}>
          {item.name}
        </Link>
      </span>
      <span className={styles.when}>
        <span title={sent.title}>
          Sent <b className={styles.date}>{sent.label}</b>
        </span>
        <span title={heard.title}>
          Last heard from <b className={styles.date}>{heard.label}</b>
        </span>
      </span>
      <span className={styles.act}>
        {resolution === undefined ? (
          <>
            <span className={`${styles.chip} ${item.outcome === 'replied' ? styles.chipReplied : styles.chipWait}`}>
              {waitingChip(item, now)}
            </span>
            {item.interestedSupported ? (
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={busy}
                aria-label={`Mark ${item.name} interested in ${item.unitLabel}`}
                onClick={() => {
                  if (item.interestedMode === 'route') void record('interested');
                  else navigate(`${unitPath}?tour=new&tenantId=${encodeURIComponent(item.contactId)}`);
                }}
              >
                Interested
              </button>
            ) : item.type === 'partner' ? (
              // Plan review R2 #1 (the B8 rule): the tour link is for a PARTNER
              // recipient only - never a landlord or team-member row, which
              // gets neither Interested nor the link.
              <Link
                className={styles.link}
                to={`${unitPath}?tour=new`}
                aria-label={`Request a tour for ${item.name} at ${item.unitLabel}`}
              >
                Request a tour
              </Link>
            ) : null}
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              aria-label={`Mark ${item.name} not interested in ${item.unitLabel}`}
              onClick={() => void record('not_interested')}
            >
              Not interested
            </button>
          </>
        ) : resolution.kind === 'interested' ? (
          resolution.tour !== undefined ? (
            <TourChip tourId={resolution.tour.tourId} state={resolution.tour.state} />
          ) : (
            <span className={`${styles.chip} ${styles.chipDone}`}>Interested</span>
          )
        ) : (
          <>
            <span className={`${styles.chip} ${styles.chipNo}`}>Not interested</span>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              aria-label={`Undo not interested for ${item.name}`}
              onClick={() => void record('clear')}
            >
              Undo
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          disabled={busy}
          aria-label={`Text ${item.name}`}
          onClick={() => void openText()}
        >
          Text
        </button>
      </span>
      {error !== null ? (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function FollowUpView({ followUps, now: nowProp }: FollowUpViewProps): React.JSX.Element {
  const [mountNow] = useState(() => new Date());
  const now = nowProp ?? mountNow;
  const baseId = useId();

  if (followUps.status === 'loading') return <Spinner center />;
  if (followUps.status === 'error') {
    return (
      <div className={styles.error} role="alert">
        <p>We couldn&apos;t load follow-ups.</p>
        <button type="button" className={styles.btn} onClick={() => followUps.retry()}>
          Retry
        </button>
      </div>
    );
  }
  if (followUps.items.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyBody}>Nothing waiting on a reply.</p>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      {followUps.truncated ? (
        <p className={styles.note} role="status">
          Showing follow-ups for the first 100 available properties.
        </p>
      ) : null}
      {groupByUnit(followUps.items).map((group, index) => {
        const headingId = `${baseId}-g${index}`;
        const waiting = group.items.filter((i) => !followUps.resolutions.has(followUpKey(i))).length;
        return (
          <section key={group.unitId} className={styles.group} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.groupTitle}>
              {group.unitLabel}
              <span className={styles.groupSub}>{waiting} waiting</span>
            </h2>
            <ul className={styles.rows} aria-label={`Waiting on ${group.unitLabel}`}>
              {group.items.map((item) => {
                const key = followUpKey(item);
                return (
                  <FollowUpRow
                    key={key}
                    item={item}
                    resolution={followUps.resolutions.get(key)}
                    now={now}
                    onResolve={(r) => followUps.resolve(item, r)}
                    onUnresolve={() => followUps.unresolve(item)}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
```

  A `<section aria-labelledby>` exposes role `region` named by its heading -
  what the test's `group()` helper queries.

GREEN 3 - new `dashboard/src/routes/broadcasts/FollowUpView.module.css` (the
mockup's option A row: `mockups.html:62-76, :100-101`):

```css
/* FollowUpView - Matching's Follow up tab (last-heard-from 5.6). Tokens only.
 * The row is the option A mockup's: who | when | chip + actions; it stacks on
 * a tight pane (BroadcastsList's .page is the query container). */
.view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.group {
  display: flex;
  flex-direction: column;
}
.groupTitle {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-1);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}
.groupSub {
  font-size: var(--fs-sm);
  font-weight: var(--fw-regular);
  color: var(--c-text-muted);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.2fr) auto;
  gap: var(--sp-1) var(--sp-3);
  align-items: center;
  padding: var(--sp-3) var(--sp-1);
  border-bottom: 1px solid var(--c-border);
}
.row:last-child {
  border-bottom: none;
}
.who {
  min-width: 0;
}
.name {
  font-weight: var(--fw-medium);
  color: var(--c-brand);
  text-decoration: none;
}
.name:hover {
  text-decoration: underline;
}
.name:focus-visible,
.link:focus-visible,
.btn:focus-visible,
.primaryBtn:focus-visible,
.linkBtn:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}
.when {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
.date {
  font-weight: var(--fw-medium);
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}
.act {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.chip {
  padding: 1px var(--sp-2);
  border-radius: 10px;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}
.chipWait {
  background: var(--c-evt-amber-bg);
  color: var(--c-resp-wait);
}
.chipReplied {
  background: var(--c-surface-2);
  color: var(--c-resp-yes);
}
.chipNo {
  background: var(--c-surface-2);
  color: var(--c-resp-no);
}
.chipDone {
  background: var(--c-brand-soft);
  color: var(--c-brand-hover);
}
.btn,
.primaryBtn {
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.primaryBtn {
  border-color: var(--c-brand);
  background: var(--c-brand);
  color: var(--c-surface);
}
.btn:disabled,
.primaryBtn:disabled,
.linkBtn:disabled {
  opacity: 0.6;
  cursor: default;
}
.link,
.linkBtn {
  padding: 0;
  border: none;
  background: none;
  color: var(--c-brand);
  font-size: var(--fs-sm);
  text-decoration: none;
  cursor: pointer;
}
.link:hover,
.linkBtn:hover {
  text-decoration: underline;
}
.rowError {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
}
.note {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
.error {
  margin: var(--sp-4) 0;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-danger);
  font-size: var(--fs-sm);
}
.empty {
  margin-top: var(--sp-6);
  padding: var(--sp-6);
  text-align: center;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  background: var(--c-surface);
}
.emptyBody {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
@container (max-width: 560px) {
  .row {
    grid-template-columns: 1fr;
  }
  .act {
    justify-content: flex-start;
  }
}
```

GREEN 4 - `dashboard/src/routes/broadcasts/BroadcastsList.tsx`:

- Header comment: append after `:8` (ASCII):
  `// last-heard-from (spec 5.6, 14.4): a "Follow up" tab (FollowUpView) beside the status filters, with the waiting count, URL state ?tab=follow-up, and one tabpanel the tabs control.`
- `:9` becomes `import { useId, useState } from 'react';`;
  `:10` becomes `import { Link, useNavigate, useSearchParams } from 'react-router-dom';`;
  add after `:16`:

```ts
import { FollowUpView } from './FollowUpView.js';
import { useFollowUps } from './useFollowUps.js';
```

- After `FILTERS` (`:20-26`):

```ts
/** The Follow up tab's URL value (?tab=follow-up) - the Properties pill and the
 *  e2e deep-link here. Not a BroadcastsFilter: useBroadcastsList sends every
 *  non-'all' filter as ?status=, which the server 400s (spec 14.4). */
const FOLLOW_UP_TAB = 'follow-up';
```

- In `BroadcastsList()` after `const list = useBroadcastsList(filter);` (`:46`):

```ts
  const [searchParams, setSearchParams] = useSearchParams();
  const followUpActive = searchParams.get('tab') === FOLLOW_UP_TAB;
  // The count fetch runs on mount whatever tab is active (spec 14.4).
  const followUps = useFollowUps();
  const tabIdBase = useId();
  const panelId = `${tabIdBase}-panel`;
  const tabId = (key: string): string => `${tabIdBase}-tab-${key}`;

  function chooseFilter(next: BroadcastsFilter): void {
    setFilter(next);
    if (followUpActive) {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete('tab');
          return p;
        },
        { replace: true },
      );
    }
  }
  function chooseFollowUp(): void {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', FOLLOW_UP_TAB);
        return p;
      },
      { replace: true },
    );
  }
```

- Replace `:102-183` (the tablist through the list body's closing `) : null}`)
  with the block below. The list body is the existing `:117-183` re-indented
  inside the panel, UNCHANGED except `'Loading<ellipsis>'` at `:179` becomes
  `'Loading...'` (a touched line goes ASCII; nothing pins it):

```tsx
      <div className={styles.tabs} role="tablist" aria-label="Send status filter">
        {FILTERS.map((tab) => {
          const selected = !followUpActive && filter === tab.filter;
          return (
            <button
              key={tab.filter}
              id={tabId(tab.filter)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
              onClick={() => chooseFilter(tab.filter)}
            >
              {tab.label}
            </button>
          );
        })}
        <button
          id={tabId(FOLLOW_UP_TAB)}
          type="button"
          role="tab"
          aria-selected={followUpActive}
          aria-controls={panelId}
          className={`${styles.tab} ${followUpActive ? styles.tabActive : ''}`}
          onClick={chooseFollowUp}
        >
          Follow up
          {followUps.status === 'ready' && followUps.waitingCount > 0 ? (
            <>
              {' '}
              <span className={styles.tabCount}>{followUps.waitingCount}</span>
            </>
          ) : null}
        </button>
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={followUpActive ? tabId(FOLLOW_UP_TAB) : tabId(filter)}
      >
        {followUpActive ? (
          <FollowUpView followUps={followUps} />
        ) : (
          <>
            {list.status === 'loading' ? <Spinner center /> : null}

            {list.status === 'error' ? (
              <div className={styles.error} role="alert">
                <p>We couldn&apos;t load your sends.</p>
                <button type="button" className={styles.retry} onClick={() => list.retry()}>
                  Retry
                </button>
              </div>
            ) : null}

            {list.status === 'ready' && list.rows.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>No sends yet</p>
                <p className={styles.emptyBody}>
                  Start one from a property&apos;s &ldquo;Send this property&rdquo;, from a contact&apos;s
                  &ldquo;Properties sent&rdquo;, or with &ldquo;Send a property&rdquo;.
                </p>
              </div>
            ) : null}

            {list.status === 'ready' && list.rows.length > 0 ? (
              <>
                <ul className={styles.rows} aria-label="Property sends">
                  {list.rows.map((row) => (
                    <li key={row.broadcastId} className={styles.rowItem}>
                      <Link to={rowHref(row)} className={styles.row}>
                        <BroadcastStatusPill status={row.status} stats={row.stats} />
                        <span className={styles.audience}>{rowAudienceLabel(row)}</span>
                        {/* Meta (delivered + date) grouped so on a tight content pane it
                         *  wraps to its own line below the audience instead of squeezing
                         *  it into a narrow wrapped column (container query in CSS). */}
                        <span className={styles.meta}>
                          <span className={styles.delivered}>
                            {row.stats.delivered}/{row.stats.audience} delivered
                          </span>
                          <span className={styles.date}>{formatBroadcastDate(row.created_at)}</span>
                        </span>
                      </Link>
                      {row.status === 'draft' ? (
                        <button
                          type="button"
                          className={styles.deleteBtn}
                          aria-label={`Delete draft: ${rowAudienceLabel(row)}`}
                          onClick={() => {
                            setDeleteError(null);
                            setConfirmDelete(row);
                          }}
                        >
                          Delete
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {list.hasMore ? (
                  <button
                    type="button"
                    className={styles.loadMore}
                    onClick={() => list.loadMore()}
                    disabled={list.loadingMore}
                  >
                    {list.loadingMore ? 'Loading...' : 'Load more'}
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
```

  (The inner block is the existing `:117-183` re-indented two levels, byte-for-byte
  otherwise, except `:179`'s ellipsis -> `'Loading...'`. The delete `Modal` at
  `:185-222` stays OUTSIDE the panel, unchanged.)
- `BroadcastsList.module.css` - after `.tab:focus-visible` (`:68-71`):

```css
/* last-heard-from 5.6: the Follow up tab's waiting count. */
.tabCount {
  display: inline-block;
  min-width: 20px;
  padding: 0 var(--sp-1);
  border-radius: 10px;
  background: var(--c-brand);
  color: var(--c-surface);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  line-height: 20px;
  text-align: center;
}
```

Run: `npx vitest run src/routes/broadcasts`; typecheck.

Commit: `feat(dashboard): Matching Follow up tab - the waiting list by property`.

### Task 7.4 - `useFollowUpCounts` and the Properties `<n> waiting` pill

RED 1 - new `dashboard/src/routes/listings/useFollowUpCounts.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFollowUps = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getFollowUps: (...a: unknown[]) => getFollowUps(...a) };
});

import { useFollowUpCounts } from './useFollowUpCounts.js';

beforeEach(() => getFollowUps.mockReset());

describe('useFollowUpCounts (last-heard-from 5.6)', () => {
  it('yields the response byUnit map', async () => {
    getFollowUps.mockResolvedValue({ items: [], byUnit: { u1: 2 }, truncated: false });
    const { result } = renderHook(() => useFollowUpCounts(true));
    expect(result.current).toEqual({});
    await waitFor(() => expect(result.current).toEqual({ u1: 2 }));
  });
  it('a failed fetch stays silent: an empty map, no throw', async () => {
    getFollowUps.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useFollowUpCounts(true));
    await waitFor(() => expect(getFollowUps).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({});
  });
  it('disabled (the Deleted view) makes no request', () => {
    const { result } = renderHook(() => useFollowUpCounts(false));
    expect(getFollowUps).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});
```

RED 2 - `dashboard/src/routes/listings/ListingsList.test.tsx`: the file mocks
ONLY `./useListings.js` (`:12-16`), so the new hook gets its own module mock -
add after `:16`:

```ts
// last-heard-from 5.6: the "<n> waiting" counts come from their own hook
// (never useListings, which ToursPage shares) - mocked the same way.
let followUpCounts: Record<string, number> = {};
vi.mock('./useFollowUpCounts.js', () => ({ useFollowUpCounts: () => followUpCounts }));
```

  reset it in `beforeEach` (`:156-159`): `followUpCounts = {};`. New cases at the
  end of `describe('ListingsList')`:

```tsx
  describe('the <n> waiting pill (last-heard-from 5.6)', () => {
    it('shows "<n> waiting" inside an AVAILABLE row link only, and nothing at 0', async () => {
      activeState = { status: 'ready', units: UNITS };
      followUpCounts = { u1: 2, u2: 5 };
      renderAt();
      await userEvent.selectOptions(statusSelect(), 'all');
      const available = screen.getByRole('link', { name: /123 Peachtree St/ });
      expect(within(available).getByText('2 waiting')).toBeInTheDocument();
      // u2 is occupied: no pill even with a count.
      const occupied = screen.getByRole('link', { name: /88 Oak Ave/ });
      expect(within(occupied).queryByText(/waiting/)).toBeNull();
    });
    it('no count -> no pill (a failed fetch is silent)', () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      expect(within(screen.getByRole('link', { name: /123 Peachtree St/ })).queryByText(/waiting/)).toBeNull();
    });
  });
```

- `ListingsList.urgentState.test.tsx` also mocks only `useListings` (`:31`);
  add after `:31`:
  `vi.mock('./useFollowUpCounts.js', () => ({ useFollowUpCounts: () => ({}) }));`
  so it never fires a real request.

GREEN 1 - new `dashboard/src/routes/listings/useFollowUpCounts.ts`:

```ts
// useFollowUpCounts - the Properties list's "<n> waiting" counts
// (last-heard-from spec 5.6 option C, 14.4 B14): the follow-ups response's
// byUnit map, one request per list load. Its OWN hook - never useListings,
// which ToursPage also calls. Silent on failure: no count, no error over the
// list. `enabled` is false on the Deleted view (no available rows there).
import { useEffect, useState } from 'react';
import { getFollowUps } from '../../api/index.js';

const EMPTY: Readonly<Record<string, number>> = {};

export function useFollowUpCounts(enabled: boolean): Readonly<Record<string, number>> {
  const [byUnit, setByUnit] = useState<Readonly<Record<string, number>>>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getFollowUps(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setByUnit(res.byUnit);
      })
      .catch(() => {
        // Silent by design (spec 14.4 B14): the pill is a hint, not a gate.
      });
    return () => controller.abort();
  }, [enabled]);
  return enabled ? byUnit : EMPTY;
}
```

GREEN 2 - `dashboard/src/routes/listings/ListingsList.tsx`:

- Import `import { useFollowUpCounts } from './useFollowUpCounts.js';` next to
  the `useListings` import.
- `Row` (`:108-128`): the signature becomes
  `function Row({ unit, onOpen, waiting }: { unit: UnitItem; onOpen: () => void; waiting: number }): React.JSX.Element {`
  and inside `.meta` (`:120-124`), after the rent chip (`:123`):

```tsx
          {/* last-heard-from 5.6 (option C): sends waiting on a reply - inside
           *  the link, so it joins the row's accessible name. */}
          {waiting > 0 ? <span className={styles.waiting}>{waiting} waiting</span> : null}
```

- `ListingsList()`: after `const { status, units } = useListings(deleted);` (`:204`):
  `const waitingByUnit = useFollowUpCounts(!deleted);`. The row render (`:419`)
  becomes:

```tsx
                <Row
                  key={unit.unitId}
                  unit={unit}
                  onOpen={persistSearch}
                  waiting={unit.status === 'available' ? (waitingByUnit[unit.unitId] ?? 0) : 0}
                />
```

- `ListingsList.module.css`, after `.badge` (`:268-278`):

```css
/* last-heard-from 5.6 (option C): "<n> waiting" on an available property. */
.waiting {
  flex: 0 0 auto;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-evt-amber-bg);
  border: 1px solid var(--c-evt-amber-border);
  color: var(--c-evt-amber-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}
```

  `properties-available-view.spec.ts:183` matches the row link by regex, so the
  pill joining the link's accessible name is safe (finding B14).

Run: `npx vitest run src/routes/listings`; typecheck.

Commit: `feat(dashboard): Properties list shows "<n> waiting" on available properties`.

---

## S8 - e2e (run ONLY through the e2e workspace)

Preconditions: S1-S7 committed and their unit suites green; the N2 selector
contract honored. Running: start one lane session for the whole slice -
`cd "W:/tmp/last-heard-from"; npm run e2e:session` in the background; run a
single file with
`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<file>.spec.ts`
(the root `npm run e2e` eats arguments); `npm run e2e:restart` after any
backend change; `npm run e2e:stop` before Task 8.5. Only e2e files change in
S8, never dashboard/app source while the lane runs. These tasks VERIFY built
slices, so a new spec has no honest RED (the unit REDs live in S4-S7); the one
real RED is the knowing rewrite in Task 8.4. Every new spec: ASCII only,
run-unique names, assertions only about rows the spec created (the lane keeps
other specs' residue), selectors from `e2e/support/selectors.md`, and
`page.request` (cookie) for authed API calls after login - the bare `request`
fixture only for `/__dev/reseed` and the fake-carrier control API.

Shared helper bodies (repeated per file on purpose - the Matching specs keep
theirs local, REF section 16 note):

```ts
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DAY = 86_400_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** A consented, run-unique tenant (consent so a send reaches them). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
  extra: { email?: string } = {},
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts:41): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Heardtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize, ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}

async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

/** An Available 2-BR property; `tourType` set = the Interested ROUTE mode. */
async function createUnitViaApi(
  api: APIRequestContext,
  stamp: string,
  tourType?: 'self_guided' | 'landlord_led' | 'pm_team',
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp}${Math.floor(Math.random() * 90) + 10} Heardfrom Ave`;
  const res = await api.post(`${NEXT}/api/units`, {
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
  if (tourType !== undefined) {
    const typed = await api.patch(`${NEXT}/api/units/${unitId}`, { data: { tour_type: tourType } });
    expect(typed.ok(), await typed.text()).toBeTruthy();
  }
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** A COUNTED, listed send with the given sentAt and NO broadcast behind it
 *  (S7's hermetic seam) - so the composer never flags it "Already sent". */
async function plantListedSend(api: APIRequestContext, unitId: string, contactId: string, sentAt: string): Promise<void> {
  const res = await api.post(`${NEXT}/__dev/listing-send-fixture`, { data: { unitId, contactId, sentAt } });
  expect(res.status(), await res.text()).toBe(201);
}
```

(`accepted_authorities` takes organization-list NAMES -
`steps.ts:1013-1050`'s default. Each spec that needs a different last name
changes only the `lastName` literal.)

### Task 8.1 - `e2e/tests/dashboard-next/last-heard-from.spec.ts` (spec 8 (1))

Imports: `test, expect, type APIRequestContext, type Page` from
`@playwright/test`; `APP_NUMBER, getOutboundTo, registerParty, sendAsParty`
from `../../fixtures/fakeTwilio.js` (`:37, :201, :220, :233`); `placeCall`
from `../../fixtures/fakeVoice.js` (`:35-43`); `sendInboundEmail` from
`../../fixtures/fakeEmail.js` (`:81-89`); `createGroupOpen` from
`../../fixtures/relayConnect.js` (`:162-186`); `reseed` from
`../../fixtures/reseed.js`; `expectTodayReady` from `../../support/today.js`.
Plus the shared helpers above and:

```ts
const TODAY_LINE = /^Last heard from Today \d{1,2}:\d{2} [AP]M$/;

/** The contact header is fetched ONCE per id (useContact.ts:30-45) - it
 *  refreshes on navigation, never live (spec 14.5 F5) - so reload inside a
 *  retry, the expectEmailInTimeline idiom (steps.ts:727-738). */
async function expectHeaderToday(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  const header = page.locator('header').filter({ hasText: 'Last heard from' });
  await expect(async () => {
    await page.reload();
    await expect(header.getByText(TODAY_LINE)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

async function expectHeaderNever(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(
    page.locator('header').filter({ hasText: 'Last heard from' }).getByText('Last heard from Never', { exact: true }),
  ).toBeVisible();
}

/** Poll the API (the touch is best-effort AFTER the append) until the value exists. */
async function waitForHeard(api: APIRequestContext, contactId: string): Promise<string> {
  let at: string | undefined;
  await expect
    .poll(async () => (at = await heardAt(api, contactId)) !== undefined, {
      timeout: 20_000,
      message: `last_heard_from_at never landed on ${contactId}`,
    })
    .toBe(true);
  return at!;
}

/** The stamp is the INBOUND's instant: no earlier than just before it was sent. */
function expectFresh(at: string, before: number): void {
  const ms = Date.parse(at);
  expect(ms, `last_heard_from_at ${at} predates the inbound`).toBeGreaterThanOrEqual(before - 60_000);
  expect(ms, `last_heard_from_at ${at} is in the future`).toBeLessThanOrEqual(Date.now() + 60_000);
}
```

A FRESH tenant per channel: the label is minute-resolution, so "moves" is
proved as "Never" -> "Today h:mm" plus the API instant (14.5 F5).

Tests (one `test.describe('Last heard from - every inbound channel moves it, an outbound never does')`):

1. `an inbound 1:1 text moves it; a staff reply does not`
   - `devLogin`; `const t = await createTenant(page.request, \`HeardSms${stamp}\`)`;
     `expect(await heardAt(api, t.contactId)).toBeUndefined()`;
     `expectHeaderNever(page, t.contactId)`.
   - `const before = Date.now()`; `registerParty(request, { label: t.name, role: 'tenant', number: t.phone })`;
     `sendAsParty(request, { from: t.phone, to: APP_NUMBER, body: \`Still looking ${t.firstName}\` })`;
     `const at = await waitForHeard(api, t.contactId)`; `expectFresh(at, before)`;
     `expectHeaderToday(page, t.contactId)`.
   - Outbound control, from the page `expectHeaderToday` left open:
     `const since = new Date().toISOString()`; fill
     `page.getByRole('textbox', { name: 'Reply message' })` with
     `Reply ${t.firstName}`, click `page.getByRole('button', { name: 'Send', exact: true })`
     (selectors.md:48); poll `getOutboundTo(request, { to: t.phone, since })`
     until a message body contains the reply (15 s) - the settle point that
     proves the outbound completed - then
     `expect(await heardAt(api, t.contactId)).toBe(at)`.
   Proves: path #1 touches with the inbound's instant; the header renders it
   on navigation; an outbound text leaves it byte-identical (spec G1, I1).
2. `a missed business-line call moves it`
   - fresh tenant `HeardCall${stamp}`, Never first (API + header).
   - `placeCall(request, { from: t.phone, to: APP_NUMBER, scenario: { digit: null, voicemail: false } })`
     (`call-inbox-unread.spec.ts:122`; no cell setup needed for an inbound
     miss); `waitForHeard` + `expectFresh` + `expectHeaderToday`.
   Proves path #5 (the business-line call, 14.5 F18). The missed-call
   auto-text that follows is an outbound and is not asserted here.
3. `an inbound email from the contact's address moves it`
   - `const email = \`heard${stamp}@example.com\``; tenant
     `createTenant(api, \`HeardMail${stamp}\`, 2, { email })` (POST accepts
     `email`, REF 6.1); Never first.
   - `const res = await sendInboundEmail(request, { from: email, subject: \`Heard ${stamp}\`, text: 'Is the unit still open?' })`;
     `expect(res.appStatus).toBe(200)`; `waitForHeard` + `expectFresh` +
     `expectHeaderToday`.
   Proves path #8 (the email channel resolves the sender by address).
4. In a nested `test.describe('relay group text', ...)` with
   `test.beforeEach(async ({ request }) => { await reseed(request); })` and
   `test.afterAll(async ({ request }) => { await reseed(request); })` (a real
   relay group must not outlive the file - `relay-inbound-caller-identity.spec.ts:41-49`):
   `a member's text in a relay group moves it`
   - `devLogin` (the reseed logged the browser out); tenant
     `HeardRelay${stamp}`; `const otherPhone = \`+1555${Math.floor(Math.random() * 9000000 + 1000000)}\``;
     `const relay = await createGroupOpen(page, [{ phone: t.phone, name: t.name, contactId: t.contactId }, { phone: otherPhone, name: 'Heard Relay Other' }])`.
   - `expect(await heardAt(api, t.contactId)).toBeUndefined()` - the group's
     opening legs are OUTBOUND (a second outbound control).
   - `registerParty(request, { label: t.name, role: 'tenant', number: t.phone })`;
     `const before = Date.now()`;
     `sendAsParty(request, { from: t.phone, to: relay.pool_number, body: \`Group hello ${t.firstName}\` })`;
     `waitForHeard` + `expectFresh` + `expectHeaderToday`.
   Proves path #2 (the relay inbound attributes the sending member).

Also append to `e2e/support/selectors.md`'s key-selector table (after its
last row, `:140`):

```
| Contact page | Last heard from | `page.locator('header').filter({ hasText: 'Last heard from' }).getByText(/^Last heard from Today \d{1,2}:\d{2} [AP]M$/)` - its own span on the header facts line (`Last heard from Never` when absent). The header is fetched once per id and does NOT update live: reload inside `expect(...).toPass()`, or read `GET /api/contacts/:id` -> `contact.last_heard_from_at`. The label has minute resolution, so prove a move with a FRESH contact (Never -> Today) or the API instant |
```

Run the file; commit:
`test(e2e): last heard from moves on an inbound text, relay text, missed call and email - never on an outbound`

### Task 8.2 - extend `e2e/tests/dashboard-next/contacts-list-facets.spec.ts` (spec 8 (2))

Imports (`:1-3`) gain `type APIRequestContext` from `@playwright/test` and
`import { APP_NUMBER, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';`.
The header comment (`:5-31`) gains a paragraph: "The second test covers the
Status facet (spec 2026-10-12 5.7): its default hides inactive and placed
tenants, which it creates through the UNGATED `PATCH /api/contacts/:id/tenant-status`
(the lean world has neither status), plus the hidden-match hint, the
last-heard sort and the URL round trip." Add helpers `heardAt` (above) and:

```ts
async function createTenantApi(api: APIRequestContext, t: { firstName: string; lastName: string; phone: string }): Promise<string> {
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: t.firstName, lastName: t.lastName, phone: t.phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** No gate in setTenantStatus (statusTransition.ts:610-622): inactive and placed are reachable. */
async function setTenantStatus(api: APIRequestContext, contactId: string, toStatus: string): Promise<void> {
  const res = await api.patch(`${NEXT}/api/contacts/${contactId}/tenant-status`, {
    data: { toStatus, source: 'manual' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}
```

New test (after `:112`):
`test('the Status facet hides inactive and placed by default; chips, the hint and Clear move it; last heard from sorts; the URL survives a reload', async ({ page, request }) => { ... })`
with `test.slow()`:

1. Setup: `flow.login()` (`new Scenario(page, request)`); three
   `freshTenant` handles (`StatusInactive`, `StatusPlaced`, `StatusReplied`)
   created with `createTenantApi(page.request, ...)` (a manual create is
   `onboarding`, `contacts.ts:955-958`); `setTenantStatus` to `inactive` and
   `placed`; then `registerParty(request, { label: replied.name, role: 'tenant', number: replied.phone })`,
   `sendAsParty(request, { from: replied.phone, to: APP_NUMBER, body: \`Still looking ${replied.firstName}\` })`
   and poll `heardAt` until defined (20 s).
2. Default set: `page.goto(\`${NEXT}/contacts/tenants\`)`;
   `rows = page.getByRole('list', { name: 'Tenants' }).getByRole('listitem')`;
   `statusFacet = page.getByRole('group', { name: 'Status', exact: true })`;
   `inactiveChip = statusFacet.getByRole('button', { name: /^Inactive \(/ })`,
   `placedChip = .../^Placed \(/` (never `/^Plac/` - it also matches
   Placing). Assert `rows.filter({ hasText: replied.firstName })` count 1,
   the inactive and placed tenants count 0; `inactiveChip` / `placedChip`
   `aria-pressed="false"`; `/^Searching \(/` and `/^Onboarding \(/`
   `aria-pressed="true"`; `getByRole('button', { name: 'Clear status filter' })`
   count 0; `expect(page).not.toHaveURL(/[?&]status=/)`.
   Proves: default = all but inactive/placed, written as NO param.
3. Last-heard sort (default): `await expect(async () => { await page.reload(); await expect(rows.first()).toContainText(replied.firstName, { timeout: 5_000 }); }).toPass({ timeout: 30_000 })`
   (the list loads on mount; `workers: 1`, so this inbound is the newest
   instant in the lane); then
   `rows.filter({ hasText: replied.firstName }).getByText(/^Last heard from Today \d{1,2}:\d{2} [AP]M$/)`
   visible. Proves: `sortByHeardFrom` is the default order and the row line
   renders.
4. Hidden-match hint: `const search = page.getByRole('searchbox', { name: 'Search contacts' })`;
   `search.fill(inactive.firstName)`;
   `expect(page.getByText(/No matches for .+ among the statuses shown/)).toBeVisible()`
   (entity quotes - the regex accepts either style, 14.5 F11);
   `page.getByRole('button', { name: 'Show all statuses' }).click()`; the
   inactive row count 1; all seven chips `aria-pressed="true"` (loop over the
   labels `Needs review`, `Onboarding`, `Searching`, `Placing`, `Placed`,
   `On hold`, `Inactive` with `new RegExp(\`^${label} \\(\`)`);
   `toHaveURL(/[?&]status=inactive(&|$)/)` and `/[?&]status=placed(&|$)/`;
   `search.fill('')`. Proves: the hint appears only for a status-hidden
   match and its action lights all seven.
5. Clear: `page.getByRole('button', { name: 'Clear status filter' }).click()`;
   `not.toHaveURL(/[?&]status=/)`; inactive and placed rows count 0.
   Proves: Clear returns to the DEFAULT, not to empty.
6. One chip: `inactiveChip.click()`; inactive row count 1, placed row count
   0; `toHaveURL(/[?&]status=inactive(&|$)/)`, `not.toHaveURL(/[?&]status=placed(&|$)/)`.
7. Sort by name + reload: `page.getByLabel('Sort by').selectOption('name')`;
   `toHaveURL(/[?&]sort=name(&|$)/)` and still `status=inactive`;
   `page.reload()`; `expect(page.getByLabel('Sort by')).toHaveValue('name')`;
   `inactiveChip` pressed, `placedChip` not; inactive row count 1, placed
   row count 0. Proves: the URL is the only state carrier for both.

Append to `selectors.md` (after the last row):

```
| Contacts (tenant facets) | Status chips, Sort by, the hidden-match hint | `getByRole('group', { name: 'Status', exact: true }).getByRole('button', { name: /^Inactive \(/ })` - seven chips in lifecycle order with LIVE counts (regex on the label; `/^Placed \(/`, never `/^Plac/`, which also hits Placing). The DEFAULT (no `status` param) lights every chip but Inactive and Placed; `Clear status filter` (visible text `Clear`) returns to that default and renders only while the selection differs from it; `?status=_empty` is the all-off selection. A tenant with no status is never hidden. `getByLabel('Sort by')` is a select (`heard` = Last heard from, the default, no param; `name` writes `sort=name`). A search that only a hidden status blocks reads `No matches for "<q>" among the statuses shown.` (entity quotes) with `getByRole('button', { name: 'Show all statuses' })` |
| Contacts list (tenant row) | last heard from | Tenants view ONLY: the row's last chip, `Last heard from <label>` (`Today 2:14 PM`, `Yesterday`, `Sep 12`, `Sep 12, 2025`, `Never`) with the full stamp on `title`; absent on the All and Deleted views |
```

Run the file; commit:
`test(e2e): Tenants status facet, hidden-match hint, last-heard sort and URL state`

### Task 8.3 - `e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts` (spec 8 (3)) and the `already sent` selector sweep

Step 1 - the selector sweep (spec 5.3 "the e2e specs that select by already
sent are updated knowingly"; matching findings B7/B8): run
`git grep -n -i "already sent\|consent not recorded" -- e2e/` and confirm
every hit is a VISIBLE-TAG read (`getByText('Already sent')` -
`broadcasts.spec.ts:174`, `share-sent-outcome.spec.ts:486, :593, :659, :718`,
`share-skip-fix.spec.ts:210, :246, :285`; and
`'consent not recorded <em dash> fix before sending'` at
`a2p-compliance.spec.ts:387, :442`) or a comment. NO e2e selector reads the
checkbox ACCESSIBLE name `<name> <em dash> already sent`, so the ASCII
" - " switch (14.4 B7) needs no e2e edit; the visible tag texts are
unchanged (the no-consent TAG keeps its em dash by ruling). The li-scoped
review selectors (B8 list: `broadcasts.spec.ts:173, :178, :186`,
`matching-entry-points.spec.ts:231`, `share-skip-fix.spec.ts:152`,
`share-sent-outcome.spec.ts:359`, `a2p-compliance.spec.ts:385, :440`) hold
because the header sits outside the list (N2 P1). Record the sweep result
in the commit body. If the grep finds an accessible-name read added since
cad93026, rewrite it to the ASCII form in this task.

Step 2 - the new spec. Imports: Playwright types; `APP_NUMBER,
getOutboundTo, registerParty, sendAsParty` from `../../fixtures/fakeTwilio.js`;
`expectTodayReady`; the shared helpers (`createTenant` here uses
`lastName: 'Heardtest'`). `test.use({ viewport: { width: 1440, height: 900 } })`
so the review pane clears the 768px column breakpoint (14.4 B8; the review
step replaces the compose form, `BroadcastComposer.tsx:495-503`, so the pane
is the page's width).

`test('Review recipients: columns, last-heard order, declined rows unchecked unless hand-picked, and a deliberate send', async ({ page, request }) => { ... })`,
`test.slow()`:

1. Setup (`devLogin`; `api = page.request`;
   `stamp = \`${Date.now()}\`.slice(-6)`):
   `{ unitId } = await createUnitViaApi(api, stamp)`; tenants (2-BR unless
   noted) `older = Older${stamp}`, `recent = Recent${stamp}`,
   `never = Never${stamp}`, `declined = Declined${stamp}`, and
   `declinedAdded = Declinedadd${stamp}` with voucherSize 3 (outside the 2-BR
   audience, so it must be hand-added). For `older` THEN `recent`:
   `registerParty` + `sendAsParty(request, { from, to: APP_NUMBER, body: \`Hi ${firstName}\` })`
   + poll `heardAt` until defined - two distinct instants, recent the later
   (assert `Date.parse(recentAt) > Date.parse(olderAt)`). For `declined`
   and `declinedAdded`:
   `plantListedSend(api, unitId, contactId, new Date(Date.now() - 3_600_000).toISOString())`
   then `api.post(\`${NEXT}/api/units/${unitId}/recipients/${contactId}/outcome\`, { data: { outcome: 'not_interested' } })`
   -> `expect(res.status(), await res.text()).toBe(200)`. (The planted row
   has no broadcast, so these two are NOT "Already sent" - the decline rule
   is proved on its own, spec 5.3.)
2. Preview: `page.goto(\`${NEXT}/broadcasts/new?unitId=${unitId}\`)`;
   `expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible()`;
   `page.getByLabel('Message').fill(\`Heard review ${stamp} [FlyerLink]\`)`;
   Preview enabled (15 s) then click; heading `Review recipients` visible;
   `list = page.getByRole('list', { name: 'Candidate recipients' })`.
3. Columns (N2 P1): each of `Name`, `Status`, `Housing authority`,
   `Last heard from` - `page.getByText(label, { exact: true }).first()`
   visible AND `list.getByText(label, { exact: true })` count 0 (the header
   is outside the list; every row stays one listitem, B8). Row cells:
   `recentRow = list.locator('li', { hasText: recent.name })` shows
   `getByText('Onboarding', { exact: true })` (the tenant StatusBadge) and
   `getByText(/^Today \d{1,2}:\d{2} [AP]M$/)`;
   `list.locator('li', { hasText: never.name }).getByText('Never', { exact: true })`
   visible. Both match the BARE label: S6.5 renders the narrow-layout
   "Last heard from " prefix as CSS `::before` content (plan review R1 #5),
   so a cell's DOM text is only `Today 2:14 PM` / `Never` - and that is also
   why `list.getByText('Last heard from', { exact: true })` count 0 holds at
   any width. `allInnerTexts()` below never sees generated content either.
4. Order: `const texts = await list.getByRole('listitem').allInnerTexts()`;
   `const at = (n: string) => texts.findIndex((x) => x.includes(n))`; all
   three found (>= 0); `at(recent.name) < at(older.name) < at(never.name)`.
   Proves the combined list sorts by last heard from, absent last (5.3).
5. Declined audience row: `declinedRow = list.locator('li', { hasText: declined.name })`;
   `declinedRow.getByText('Not interested', { exact: true })` visible;
   `declinedRow.getByText('Already sent', { exact: true })` count 0;
   `declinedBox = list.getByRole('checkbox', { name: \`${declined.name} - not interested\`, exact: true })`
   not checked and enabled. `page.getByRole('button', { name: 'Select all' }).click()`
   -> `declinedBox` STILL unchecked and
   `list.getByRole('checkbox', { name: recent.name, exact: true })` checked.
   Proves: a filter-proposed declined row starts unchecked and Select all
   skips it (14.4 B11).
6. Hand-added declined row: `page.getByRole('button', { name: 'Deselect all' }).click()`;
   `page.getByRole('combobox', { name: 'Add a tenant' }).fill(declinedAdded.firstName)`;
   `option = page.getByRole('option', { name: new RegExp(escapeRegExp(declinedAdded.name)) })`;
   `expect(option).toContainText('Not interested')` (the `annotate` suffix,
   N2 P2); click it. `addedRow = list.locator('li', { hasText: declinedAdded.name })`
   shows `Not interested` and `Added` (exact); its checkbox
   `{ name: \`${declinedAdded.name} - not interested\`, exact: true }` IS
   checked (a pick is deliberate, 14.4 / G3 as amended).
7. Deliberate send: check `declinedBox`; click
   `page.getByRole('button', { name: /^Send to 2 recipients\b/ })`;
   `toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 })`. Then
   poll (30 s) `GET /api/units/${unitId}/recipients` until BOTH declined ids
   have a row with `outcome === 'no_reply'` and no `declined` (the new send's
   `sentAt` supersedes the decline - D11), and poll
   `getOutboundTo(request, { to: declined.phone })` until a body contains
   `Heard review ${stamp}`. Proves: checking a declined row sends to it (D4)
   and the send clears the decline.

Append to `selectors.md`:

```
| Review recipients | columns, order and the Not interested tag | at 768px+ of pane a header row OUTSIDE the `Candidate recipients` list reads `Name`, `Status`, `Housing authority`, `Last heard from` (exact texts; rows stay one listitem each). Rows sort by last heard from (`Today 2:14 PM` ... `Never` last). A declined row carries the tag `Not interested` beside `Already sent`; its checkbox is named `<name> - not interested` / `<name> - already sent, not interested` (ASCII " - " on every tag name, including `<name> - already sent` and `<name> - consent not recorded`); a filter-proposed declined row starts unchecked and Select all skips it, a hand-added one stays checked. The `Add a tenant` option shows a muted `Not interested` / `Already sent` suffix inside its name |
```

Run the file; commit:
`test(e2e): Review recipients columns, last-heard order and declined rows`
(body: the Step 1 sweep result - "no e2e selector reads the checkbox
accessible name; visible tags unchanged").

### Task 8.4 - `e2e/tests/dashboard-next/send-outcome-cards.spec.ts` (spec 8 (4)) and the knowing `listing-activity` rewrite

Step 1 - RED: run `tests/dashboard-next/listing-activity.spec.ts` as it
stands. Expected failure: `:231` `expect(page.getByText(/No reply/i)).toHaveCount(0)`
finds the new `No reply yet` chips (tenants findings F4); if S5's row markup
nests divs, `:226` `rowFor(t1Name)` fails first on strict mode (N2 R1).
Record which.

Step 2 - GREEN, `e2e/tests/dashboard-next/listing-activity.spec.ts`:

- `:162` test title becomes
  `'sent rows carry the derived outcome, never the retired response label, until a tour lights exactly the toured recipient'`;
  the comment at `:165-168` becomes: "Proves the retired listing-send
  `response` CONTROL stays gone (its bare labels were `No reply` / `Not a
  fit`, removed 2026-07-10), each row shows the DERIVED outcome chip instead
  (spec 2026-10-12 5.5), and the tour chip is TRUTHFUL: it appears only for
  the one recipient with a qualifying tour on THIS property."
- `:224-225` becomes (N2 R1):

```ts
    const rowFor = (name: string) =>
      card.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
```

- `:211-213`'s comment: "The "Sent to" card shows both recipients with NO
  tour chip and the derived "No reply yet" outcome - never the retired bare
  "No reply" label. ..." (keep its heading sentence).
- `:231` becomes:

```ts
    // The retired response CONTROL stays gone: its labels were the BARE
    // "No reply" / "Not a fit" (exact - "No reply yet" is the live derived
    // chip, spec 2026-10-12 5.5, and must NOT be confused with it).
    await expect(page.getByText('No reply', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Not a fit/i)).toHaveCount(0);
    await expect(rowFor(t1Name).getByText('No reply yet', { exact: true })).toBeVisible();
    await expect(rowFor(t2Name).getByText('No reply yet', { exact: true })).toBeVisible();
```

- `:254-255`'s comment: "The OTHER recipient stays chipless and still reads
  No reply yet; exactly one chip on the card; the retired label is still
  absent." and `:260` becomes:

```ts
    await expect(page.getByText('No reply', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Not a fit/i)).toHaveCount(0);
    // t1 is Interested now (the tour IS the signal - no second chip); t2 still waits.
    await expect(rowFor(t1Name).getByText('No reply yet', { exact: true })).toHaveCount(0);
    await expect(rowFor(t2Name).getByText('No reply yet', { exact: true })).toBeVisible();
```

(The prompt's ":261" is the closing brace; the assertion is `:260`.)

Step 3 - the new spec. Imports: Playwright types, `expectTodayReady`, the
shared helpers (`createTenant` with `lastName: 'Outcometest'`), plus:

```ts
function sentToCard(page: Page): Locator {
  // The heading's name includes its "Send this property" action - prefix match, never exact.
  return page.locator('section', { has: page.getByRole('heading', { name: /^Sent to\b/ }) });
}

function propertiesSentCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /Properties sent/ }) });
}

function rowFor(page: Page, card: Locator, linkName: string | RegExp): Locator {
  const name = typeof linkName === 'string' ? { name: linkName, exact: true } : { name: linkName };
  return card.getByRole('listitem').filter({ has: page.getByRole('link', name) });
}

/** Send the property to these tenants through a real broadcast and wait for
 *  the ledger rows (listing-activity.spec.ts:181-209 idiom). */
async function sendTo(api: APIRequestContext, unitId: string, contactIds: string[], stamp: string): Promise<void> {
  const draft = await api.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: `Outcome ${stamp} at [Address]`, audience_filter: { contact_type: 'tenant', bedroomSize: 2 } },
  });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const broadcastId = ((await draft.json()) as { broadcastId: string }).broadcastId;
  const send = await api.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, { data: { recipientContactIds: contactIds } });
  expect(send.ok(), await send.text()).toBeTruthy();
  await expect
    .poll(async () => {
      const ids = (await recipients(api, unitId)).map((r) => r.contactId);
      return contactIds.every((id) => ids.includes(id));
    }, { timeout: 30_000 })
    .toBe(true);
}

interface RecipientWire { contactId: string; outcome: string; declined?: { by: string }; tour?: { tourId: string } }
async function recipients(api: APIRequestContext, unitId: string): Promise<RecipientWire[]> {
  const res = await api.get(`${NEXT}/api/units/${unitId}/recipients`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { recipients: RecipientWire[] }).recipients;
}

async function toursFor(api: APIRequestContext, tenantId: string, unitId: string): Promise<Array<{ tourId: string; status: string }>> {
  const res = await api.get(`${NEXT}/api/tours?tenantId=${encodeURIComponent(tenantId)}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tours: Array<{ tourId: string; unitId: string; status: string }> }).tours.filter((x) => x.unitId === unitId);
}

function localDatetimeAt(base: Date, hour: number, minute: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(hour)}:${pad(minute)}`;
}
```

(`GET /api/tours?tenantId=` is `routes/tours.ts:425-433`, `{ tours }`;
`localDatetimeAt` is `tours-page.spec.ts:34-40`.)

`test.describe('Send outcome on the roster cards (spec 2026-10-12 5.5)')`:

1. `Interested creates exactly one tour, lands on Needs booking, and both cards read Tour requested`
   - unit with `tour_type: 'self_guided'` (route mode); tenant `Keen${stamp}`;
     `sendTo`.
   - `/listings/${unitId}`: `row = rowFor(page, sentToCard(page), t.name)`;
     `row.getByText('No reply yet', { exact: true })` visible; click
     `row.getByRole('button', { name: new RegExp(\`^Mark ${escapeRegExp(t.name)} interested in ${escapeRegExp(line1)}\`) })`.
   - `row.getByRole('link', { name: 'Tour requested' })` visible; no
     outcome buttons remain: `row.getByRole('button', { name: /^Mark .+ interested in / })`
     count 0 (that regex covers both Mark buttons).
   - `expect.poll(async () => (await toursFor(api, t.contactId, unitId)).length, { timeout: 15_000 }).toBe(1)`;
     the one tour `status === 'requested'`; the chip's `href` is
     `/tours/${tourId}`. `page.reload()`; still exactly 1 tour and the chip.
   - `/tours`: `page.getByRole('region', { name: 'Needs booking' }).getByRole('link', { name: new RegExp(\`Tour for ${escapeRegExp(t.name)} at .*${escapeRegExp(line1)}\`, 'i') })`
     visible (10 s) (`tours-page.spec.ts:247-253`).
   - `/contacts/${t.contactId}`:
     `rowFor(page, propertiesSentCard(page), new RegExp(escapeRegExp(line1)))`
     shows `getByRole('link', { name: 'Tour requested' })`.
   Proves: Interested = one tour (I3), the tour list and the contact card
   agree.
2. `Not interested then Undo, recorded on either card and mirrored on the other`
   - unit with tour type; tenant `Undo${stamp}`; `sendTo`.
   - Property card: click `Mark <name> not interested in <line1>`; the row
     shows `Not interested` (exact) and
     `row.getByRole('button', { name: new RegExp(\`^Undo not interested for ${escapeRegExp(t.name)}\`) })`;
     both Mark buttons count 0. Wire: `recipients()` row `outcome === 'not_interested'`,
     `declined.by === 'staff'`.
   - Contact card mirrors: on `/contacts/${t.contactId}`, the property row
     shows `Not interested`; click its `/^Undo not interested for /` button;
     the row shows `No reply yet` and a `/^Mark .+ not interested in /`
     button again.
   - Back on `/listings/${unitId}`: the row reads `No reply yet` with both
     Mark buttons; wire `outcome === 'no_reply'`, `declined` undefined.
3. `a tour scheduled from the Tours page after a decline flips the row to Tour scheduled`
   - unit with tour type; tenant `Comeback${stamp}`; `sendTo`; Not interested
     on the property card (row reads `Not interested`).
   - `/tours`: `page.getByRole('button', { name: '+ New tour' }).click()`;
     `dialog = page.getByRole('dialog', { name: /Schedule a tour/i })`;
     `dialog.getByRole('combobox', { name: 'Tenant' }).fill(t.firstName)`;
     `page.getByRole('listbox', { name: 'Tenant suggestions' }).getByRole('option', { name: new RegExp(escapeRegExp(t.name)) }).click()`;
     `dialog.getByRole('combobox', { name: 'Unit' }).fill(line1)`;
     `page.getByRole('listbox', { name: 'Unit suggestions' }).getByRole('option', { name: new RegExp(escapeRegExp(line1)) }).click()`;
     `dialog.getByLabel('Tour type').selectOption({ label: 'Self-guided' })`;
     `dialog.getByLabel('Date and time').fill(localDatetimeAt(new Date(Date.now() + 3 * DAY), 10, 0))`
     (three days out: the reminder ladder sends nothing during the run);
     `dialog.getByRole('button', { name: 'Schedule', exact: true }).click()`;
     `toHaveURL(/\/tours\/[A-Za-z0-9_-]+$/, { timeout: 10_000 })`; capture
     `tourId` from the URL (`tours-page.spec.ts:453-480` flow).
   - `/listings/${unitId}`: reload inside `toPass` (20 s) until
     `row.getByRole('link', { name: 'Tour scheduled' })` is visible with
     `href` `/tours/${tourId}`; `Not interested` text and the Undo button
     count 0. Wire: `outcome === 'interested'`, `declined` undefined.
   - The contact card shows `Tour scheduled` for the property row.
   Proves D11: a NEW tour supersedes an earlier decline.
4. `a property with no tour type opens the Schedule a tour form and creates nothing`
   - unit WITHOUT `tourType`; tenant `Formmode${stamp}`; `sendTo`.
   - Click `Mark <name> interested in <line1>` on the property card;
     `toHaveURL(/[?&]tour=new(&|$)/)` and
     `toHaveURL(new RegExp(\`[?&]tenantId=${t.contactId}(&|$)\`))`;
     `dialog = page.getByRole('dialog', { name: /Schedule a tour/i })` visible;
     `dialog.getByRole('group', { name: 'Tenant' })` `toContainText(t.name)`
     (LOCKED, 14.3 B9); `toursFor(...)` length 0.
   - `dialog.getByRole('button', { name: 'Cancel' }).click()`; dialog count 0;
     `not.toHaveURL(/[?&]tour=new/)`; the row still reads `No reply yet`.
   Proves `interestedMode: 'form'` (5.4) end to end.

Append to `selectors.md`:

```
| Property page (Sent to) and Contact page (Properties sent) | outcome chip and row actions | a row is `card.getByRole('listitem').filter({ has: page.getByRole('link', { name: <identity>, exact: true }) })`. Its outcome is visible text `No reply yet` / `Replied` / `Not interested` / `Not interested (auto)`, or the TourChip LINK (`Tour requested` / `Tour scheduled` / `Toured`) when Interested. Actions are buttons named `Mark <name> interested in <address>` / `Mark <name> not interested in <address>` / `Undo not interested for <name>` (match by regex prefix on the street line - the address is the full one-line form); a partner row has the link `Request a tour for <name> at <address>` instead of Interested. On a property with no tour type, Interested opens `Schedule a tour` with `?tour=new&tenantId=`; a deleted property shows outcomes and no actions. NEVER `getByText(/No reply/i)` to prove the retired response label absent - it matches the live chip; use `getByText('No reply', { exact: true })` |
```

Run both files; commit:
`test(e2e): send outcome on the property and contact cards; listing-activity asserts the retired control, knowingly`

### Task 8.6 - `e2e/tests/dashboard-next/follow-up-tab.spec.ts` (spec 8 (6))

Imports: Playwright types; `APP_NUMBER, registerParty, sendAsParty` from
`../../fixtures/fakeTwilio.js`; `reseed`; `expectTodayReady`; the shared
helpers (`createTenant` with `lastName: 'Followtest'`), plus:

```ts
/** A sentAt n days back, padded a minute so floor() cannot read n-1. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY - 60_000).toISOString();
}

interface FollowUpWire {
  items: Array<{ unitId: string; contactId: string; outcome: string; waitingSince: string }>;
  byUnit: Record<string, number>;
  truncated: boolean;
}

async function followUps(api: APIRequestContext): Promise<FollowUpWire> {
  const res = await api.get(`${NEXT}/api/broadcasts/follow-ups`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as FollowUpWire;
}

function followUpTab(page: Page): Locator {
  return page.getByRole('tab', { name: /^Follow up\b/ });
}

function groupFor(page: Page, line1: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${escapeRegExp(line1)}`) });
}

function propertyRow(page: Page, line1: string): Locator {
  return page.getByRole('list', { name: 'Properties', exact: true }).getByRole('listitem').filter({ hasText: line1 });
}
```

`test.beforeEach(async ({ request }) => { await reseed(request); })` - the
lean world seeds NO `listing_sends` (REF section 16 note), so after a reseed
every waiting row is this test's own and the tab count is exact. (No
`afterAll` reseed: a planted row is harmless to later specs - the Properties
pill joins the row link's name and `properties-available-view.spec.ts:183`
matches by regex.)

1. `a send quiet past 24 hours waits under its property, counted on the tab and the Properties list; a reply removes it`
   - `devLogin`; `{ unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided')`;
     `quiet = Quiet${stamp}`, `replied = Repliedq${stamp}`.
   - `plantListedSend(api, unitId, quiet.contactId, daysAgo(2))`;
     `plantListedSend(api, unitId, replied.contactId, daysAgo(5))`.
   - An AGED reply for `replied`: `const conv = await api.post(\`${NEXT}/api/contacts/${replied.contactId}/conversation\`)`
     -> `conversationId = (await conv.json()).conversation.conversationId`
     (`contacts.ts:2029`, create-or-get); `const heard = daysAgo(3)`;
     `api.post(\`${NEXT}/__dev/extraction/message-fixture\`, { data: { conversationId, body: 'Is it still open?', createdAt: heard, direction: 'inbound' } })`
     -> ok (S1 Task 1.11 makes this seam touch); poll
     `Date.parse(await heardAt(api, replied.contactId) ?? '')` until it
     equals `Date.parse(heard)`.
   - API: `fu = await followUps(api)`; `fu.byUnit[unitId] === 2`; the items
     for `unitId`, in order, are `[replied (outcome 'replied'), quiet (outcome 'no_reply')]`
     - longest-waiting first (`replied` waits since 3 days, `quiet` since 2).
   - Deep link: `page.goto(\`${NEXT}/broadcasts?tab=follow-up\`)`;
     `followUpTab(page)` `aria-selected="true"` and `toHaveText(/^Follow up\s*2$/)`;
     `group = groupFor(page, line1)` `toContainText('2 waiting')`;
     `rows = group.getByRole('listitem')` count 2;
     `rows.nth(0)` contains `replied.name` and
     `getByText('Replied, quiet 3 days', { exact: true })`;
     `rows.nth(1)` contains `quiet.name`,
     `getByText('No reply yet, 2 days', { exact: true })`, `toContainText(/Last heard from\s*Never/)`,
     and `getByRole('link', { name: quiet.name })` `href` `/contacts/${quiet.contactId}`;
     the row's actions exist:
     `rows.nth(1).getByRole('button', { name: new RegExp(\`^Mark ${escapeRegExp(quiet.name)} not interested in \`) })`.
   - Tab click writes the URL: `page.goto(\`${NEXT}/broadcasts\`)`;
     `followUpTab(page).click()`; `toHaveURL(/[?&]tab=follow-up(&|$)/)`.
   - Properties list: `page.goto(\`${NEXT}/listings\`)` (the Active tab
     defaults to Available); `propertyRow(page, line1)` `toContainText('2 waiting')`.
   - Reply: `registerParty(request, { label: quiet.name, role: 'tenant', number: quiet.phone })`;
     `sendAsParty(request, { from: quiet.phone, to: APP_NUMBER, body: \`Yes ${quiet.firstName}\` })`;
     poll `followUps(api)` (20 s) until no item has `contactId === quiet.contactId`
     and `byUnit[unitId] === 1`. The tab never drops a row live (plan review
     R1 #4: a row leaves the list on the NEXT LOAD), so load it fresh:
     `page.goto(\`${NEXT}/broadcasts?tab=follow-up\`)`, then inside `toPass`
     (`page.reload()` first on each attempt): `groupFor(page, line1)` contains `1 waiting`, its rows count 1
     and none contains `quiet.name`; `followUpTab(page)` `toHaveText(/^Follow up\s*1$/)`.
     `/listings`: `propertyRow(page, line1)` contains `1 waiting`.
   Proves: QUIET (a reply moves `max(sentAt, lastHeardFromAt)` to now),
   ordering, both chips' N-day wording, the tab count, the deep link, and
   option C's pill from the same `byUnit`.
2. `Not interested on the Follow up tab removes the row`
   - `devLogin`; unit with tour type; tenant `Declineq${stamp}`;
     `plantListedSend(api, unitId, t.contactId, daysAgo(3))`.
   - `/broadcasts?tab=follow-up`: the row under `groupFor(page, line1)`
     reads `No reply yet, 3 days`; click
     `getByRole('button', { name: new RegExp(\`^Mark ${escapeRegExp(t.name)} not interested in \`) })`.
   - In place, for the session (plan review R1 #4 ruling): the row stays and
     shows its new state - `Not interested` (exact) and a
     `/^Undo not interested for /` button; it does NOT vanish before a load.
   - `page.reload()`; then `groupFor(page, line1)` count 0 (its only row left)
     and `page.getByText('Nothing waiting on a reply.', { exact: true })`
     visible (the only waiting row after the reseed).
   - API: `followUps(api)` has no item for `t.contactId` and
     `byUnit[unitId]` is undefined; `GET /api/units/${unitId}/recipients`
     row `outcome === 'not_interested'`.
   - `/listings`: `propertyRow(page, line1)` `not.toContainText('waiting')`.
   Proves: the outcome filter (not_interested never waits) and the empty state.

Append to `selectors.md` (two rows):

```
| Matching | Follow up tab | `page.getByRole('tab', { name: /^Follow up\b/ })` - its text is `Follow up` + the waiting count; `/broadcasts?tab=follow-up` opens it (`aria-selected="true"`). Each property is `getByRole('region', { name: /^<unitLabel>/ })` (heading = the one-line address, sub `<n> waiting`); rows are its listitems, chip `No reply yet, N days` / `Replied, quiet N days` (N = whole days on the browser clock), actions as the roster rows plus `Text`; empty state `Nothing waiting on a reply.`. Only a send at least 24 hours quiet waits, so make one with the dev seam below - never wait on a clock. The Properties list's Available rows show `<n> waiting` inside the row link |
| Dev seam | a backdated listed send | `POST ${NEXT}/__dev/listing-send-fixture { unitId, contactId, sentAt }` -> 201 `{ row }`: a COUNTED, listed `listing_sends` row with that `sentAt` and NO broadcast behind it (so the composer never flags it `Already sent`). Hermetic-local only, like `/__dev/reseed`. Pair it with `/__dev/extraction/message-fixture` (`direction: 'inbound'`, an aged `createdAt`) for a deterministic, aged `last_heard_from_at` |
```

Run the file; commit:
`test(e2e): the Follow up tab, its count, and the Properties waiting pill`

### Task 8.5 - C6: the full-run re-proof (spec 8 (5), 5.8, 14.5 F17) - run LAST in S8

The C6 patch and its unit tests land in S6 (Task 6.3, the verbatim
`git apply`; Task 6.5 changes the Review recipients row height). The
populated hand-pick case is `matching-entry-points.spec.ts:192`
(`property-page + Send: hand-picked single recipient`), whose `:228` option
`.click()` is an ORDINARY click (no `force`). A solo green run of that file
proves nothing - the issue reproduces only in the populated batch
(`docs/issues/contact-search-popover-below-viewport.md`, "Reproduction and
attribution"), so the proof is the FULL run.

1. Unit: `cd "W:/tmp/last-heard-from/dashboard"; npx vitest run src/routes/contact/ContactSearchField.test.tsx`
   green, including the patch's three tests (opens above when below does
   not fit; max height bounded by the space; no 9rem floor).
2. `npm run e2e:stop` (never a full suite beside a live session in the same
   worktree); confirm no listener survives on the lane's ports (a killed
   suite orphans its stack, which `reuseExistingServer` then adopts on a
   commit match alone - AGENTS.md).
3. `cd "W:/tmp/last-heard-from"; timeout 2400 npm run e2e` (the same budget
   as S10's gate 4) - bare, in the background with its output captured; never
   piped; read the exit code from the completion notice.
   If the TIMEOUT fires (exit 124), the kill orphans the lane stack and the
   next run's `reuseExistingServer` adopts it on a commit match alone
   (AGENTS.md): before ANY further run, confirm no listener survives on the
   lane's ports (app `9001+L*100`, dashboard `+10`, fake-twilio `+20`, public
   base `+30`, L = the lane in `e2e/.artifacts/`), stopping only that lane's
   processes (`npm run e2e:stop`), never a shared MCP browser.
4. If red: COPY `e2e/test-results/` and `e2e/playwright-report/` to
   `.superpowers/sdd/e2e-runs/<timestamp>/` BEFORE any re-run (a re-run
   overwrites them). A named-spec failure is a REGRESSION to diagnose, not a
   flake (AGENTS.md - the re-run list is empty).
5. If green: write
   `docs/superpowers/reviews/2026-10-12-last-heard-from/c6-full-run-reproof.md`
   (ASCII): date, branch HEAD sha, the command, exit code 0, the totals line
   from the captured output, the line showing `matching-entry-points.spec.ts`
   `property-page + Send: hand-picked single recipient` passed, the sha of
   the C6 patch commit, and the output of
   `git grep -n "force: true" -- e2e/tests/dashboard-next/matching-entry-points.spec.ts`
   (expected empty: ordinary clicks). S9 Task 9.2 cites this file and the
   patch commit when it marks the issue resolved; S10's gate-4 run re-confirms
   after the main sync.

Commit: `docs(records): C6 re-proof - the populated hand-pick case passes in the full e2e run`

## S9 - docs (spec 11, 13)

### Task 9.1 - GLOSSARY entries

`documentation/GLOSSARY.md`, "Feature & label notes": append after the
"Requested tour / Needs booking / Undated" entry's last line (`:476`,
"and the Past tab (curated work lists).") and before the blank line + `---`
(`:477-478`) - one blank line, then (ASCII only):

```markdown
- **last heard from** (last-heard-from, 2026-10-12) - the most recent inbound
  text, call or email FROM a contact, in any thread (one-to-one, relay group,
  native group text). Staff copy: "Last heard from <date>" (the Tenants tab,
  the contact header, Matching's Review recipients, the Sent to cards, the
  Follow up tab); "Never" when there is none. Stored as `last_heard_from_at`
  on the contact: forward-only, written ONLY by
  `contactsRepo.touchLastHeardFrom` (refused from clients), and attributed by
  ONE rule, `attributeInbound` (`app/src/lib/heardFrom.ts`), shared by every
  live path, the importer, the seed and the backfill. A call counts at ring
  time whatever its outcome; a STOP counts (it is not a consent signal); an
  email from an address on no contact does not count until staff link the
  address. Outbound and automated traffic never move it. Not a conversation's
  `last_activity_at` (any direction) and not a phone's `lastSeenAt`.

- **send outcome** (last-heard-from, 2026-10-12) - per property sent to a
  contact: No reply yet / Replied / Interested / Not interested. Interested =
  a qualifying tour exists for that tenant and property (tenants only - a
  partner row never reads a tour); Not interested = a recorded decline not
  superseded by a later send or later tour activity; Replied = heard from
  after the send; otherwise No reply yet. Precedence: Not interested >
  Interested > Replied > No reply yet. DERIVED, never stored, except the
  decline record (`listing_sends.declined`). "(auto)" marks an engine decline
  on the cards only. Code: `ListingSendOutcome` in
  `app/src/lib/listingSendOutcome.ts` - never `SendOutcome`, which is the
  Twilio send-failure vocabulary.

- **waiting on a reply** (last-heard-from, 2026-10-12) - a send at No reply
  yet or Replied whose recipient can be texted (not deleted, not opted out,
  not unreachable, has a phone, and not an inactive or placed tenant) and has
  been quiet for 24 hours since the later of the send and their last heard
  from, within 14 days of the send (`FOLLOW_UP_QUIET_MS`,
  `FOLLOW_UP_LOOKBACK_MS`). Listed on Matching's "Follow up" tab, grouped by
  property, and counted as "<n> waiting" on the Properties list.
```

Check: the added lines are ASCII (`git diff` added lines through the
section-0 `tr` check).

Commit: `docs(glossary): last heard from, send outcome, waiting on a reply`.

### Task 9.2 - issue records

1. `docs/issues/contact-search-popover-below-viewport.md` (resolved by the
   C6 commit - plan section 1, row C6):
   - find the C6 commit: `git log --reverse --format='%h %as %s' main..HEAD -- dashboard/src/routes/contact/ContactSearchField.tsx`
     - its FIRST line (C6 lands before the `annotate` commit);
   - frontmatter: `status: open` (`:6`) becomes `status: resolved`; add
     `resolved: <that commit's %as date>` on a new line after
     `created: 2026-10-08` (`:8`);
   - append at the end of the file (after `:51`), one blank line first:

```markdown
**Resolution (<that commit's %as date>, feat/last-heard-from).** The
caseworkers review's proposed fix,
`docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`, was
applied verbatim in commit <its %h>: the list opens ABOVE its input when the
room below is short and is constrained to the viewport space available. The
populated Matching hand-pick case (`matching-entry-points.spec.ts`) passes
with ordinary pointer clicks; that re-proof counts only in the full
`npm run e2e` gate run, recorded in the mission handback.
```

2. `docs/issues/denormalize-contact-last-activity-for-ordered-paging.md`
   stays `status: open`; append at the end of the file, one blank line first:

```markdown
**Note (2026-10-13, feat/last-heard-from).** The contact now carries a
recency attribute: `last_heard_from_at`, the latest INBOUND text, call or
email from the contact (forward-only, written only by
`contactsRepo.touchLastHeardFrom`, backfilled by
`app/scripts/backfill-last-heard-from.ts`; spec
`docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
section 5.1). It answers the forward-only and best-effort questions above. It
is deliberately NOT an index key and is inbound-only, so the paged-feed half
of this issue - a GSI that lets a contact-side feed page in activity order -
is still open; whoever builds it decides whether to index this attribute or
add a both-directions one.
```

3. `docs/issues/tour-create-no-dedupe.md` - NO edit; confirm it still reads
   `status: open` (`:6`) - the Interested route dedupes only its own path.
4. `cd "W:/tmp/last-heard-from"; npm run issues` - must exit 0 (it
   regenerates the gitignored `docs/issues/INDEX.md`; nothing of it is
   committed). Check the added lines are ASCII.

Commit (the two issue files only): `docs(issues): C6 popover resolved; last_heard_from_at noted on the denormalize issue`.

## S10 - final: main sync, the five gates, self-QA, handback

### Task 10.1 - sync main ONCE

`cd "W:/tmp/last-heard-from"; git status` (clean), `git merge --no-edit main`.
Resolve conflicts preserving BOTH sides' intent (the parallel branch edits
`api/types.ts`, `endpoints.ts`, `contactsRepo.ts`, `seed/*`, `GLOSSARY.md`,
`e2e/scenarios/steps.ts` additively; keep both additions). Then
`npm run typecheck` (bare) - a merge can create a SEMANTIC seam that green
tests miss. Commit the merge. Report later drift in the handback; never
chase it with a second merge.

### Task 10.2 - the five gates, bare, from the worktree root, on a QUIET tree

1. `npm run typecheck`
2. `npm test` (DynamoDB Local running; `env | grep '^AWS_'` first - unset any
   exported `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)
3. `npm run smoke`
4. `timeout 2400 npm run e2e` (run in the background with its output to a
   file; read the exit code from the notification; never pipe; the recorded
   baseline is ~18 min and this branch adds five specs). If the timeout
   fires, the stack is ORPHANED and the next run adopts it on a commit
   match alone (AGENTS.md): confirm no listener survives on the lane's ports
   before starting another run.
After gate 5: re-run Task 1.13B's I1 writer audit on the FINAL tree (every
contacts-table writer, incl. the ones later slices added, SETs/REMOVEs only
named attributes and never `last_heard_from_at`), and COMMIT its output as
`docs/superpowers/reviews/2026-10-12-last-heard-from/i1-audit-final.md` (a
mission record; the S1-time audit stays as the first record).
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
   - the list is NON-empty on this branch; attribute any error by BASELINE
   COMPARISON (run the same command on the same paths at the merge base and
   diff); anything present now and absent there is yours and blocking.

Quote every exit code verbatim in `.superpowers/sdd/gates/<gate>.exit` and
in the handback. A red gate is diagnosed to root cause, fixed under TDD, and
the gate re-run; a named-spec e2e failure is a REGRESSION, not a flake
(AGENTS.md); an environmental DynamoDB failure is adjudicated by
re-run-and-compare on FILES.

### Task 10.3 - live self-QA on a hermetic lane (Playwright MCP)

`npm run e2e:session` from the worktree (its own lane), dev-login, then
drive and SCREENSHOT (into `.playwright-mcp/last-heard-from-<n>-<what>.png`
under the MAIN checkout root, moved into
`docs/superpowers/reviews/2026-10-12-last-heard-from/self-qa/` afterwards):

1. Tenants tab: default set hides a placed tenant you create; the Status
   chips; the sort select; a tenant who just texted (fake carrier) moves to
   the top after reload; `Last heard from` on the row and on the header.
2. Matching Review recipients: the four columns at desktop width; the
   stacked layout at 420px (resize the MCP viewport); a declined tenant
   unchecked with `Not interested`; `Add a tenant` with the annotated option
   REACHABLE at the bottom of a populated list (C6: the list opens upward).
3. Property page Sent to: `Interested` on a property WITH a tour type ->
   `Tour requested` chip and the tenant on Tours > Needs booking;
   `Interested` on a property WITHOUT a tour type -> the Schedule tour form
   with the guessed type visible; `Not interested` -> `Undo`; the groups
   order; the Properties sent card on the tenant page mirrors it.
4. Matching > Follow up: seed a two-day-old send through the dev fixture;
   the tab count, the group, `No reply yet, 2 days`; `Text` opens the
   thread; the `1 waiting` pill on Properties; a reply removes the row.
5. The property Activity and the tenant Timeline show the decline and the
   interested events with their labels.

Write `self-qa.md` (what was driven, what was seen, screenshot names) to the
records folder and commit it.

### Task 10.4 - handback

Update the ledger `STATUS: DONE`, write
`docs/superpowers/reviews/2026-10-12-last-heard-from/handback.md` (per-spec-
section table incl. deviations with why; QUOTED gate exit codes on the final
commit; the reviewer findings and adjudications of every fix wave; `git
rev-list --count HEAD..main` drift; the owed post-merge operator action:
run `npx tsx app/scripts/backfill-last-heard-from.ts --env dev` then
`--apply`, then the same on prod, per the RUNBOOK section) and commit it.
Never merge. Never deploy. Never clean up.

## 11. Watch items

- `app/src/lib/sendOutcome.ts` ALREADY EXISTS and is unrelated; the new
  module is `listingSendOutcome.ts`. A builder who "fixes" an import into
  the old file has broken 14 modules.
- `touchLastHeardFrom` MUST carry `attribute_exists(contactId)`; without it
  the backfill mints phantom contacts for every hard-deleted id in history.
- The echo-dedupe direction check exists on the 1:1 and native-group paths
  ONLY; adding a `getByProviderSid` read on the voice paths is not wanted.
- `deriveTourSignal`'s result is the wire `tour` field; `deriveTourActivityAt`
  is a SEPARATE function. Three route tests pin `tour` with `toEqual`.
- Partner rows: the server attaches NO `tour` and the pure derivation ignores
  tours for a non-tenant; a converted caseworker's tenant-era tours are real
  data that must not leak as Interested.
- The Interested route creates through `toursRepo.create` and therefore MUST
  call `requireTenantContact` itself; `POST /api/tours`'s guard does not
  cover it.
- The outcome route's `tourType` is `unit.tour_type` ONLY (D14); never call
  `deriveTourType` on the server.
- `RECIPIENT_PROJECTION`: `status` is a DynamoDB reserved word - alias it.
- The lean seed's contact items CHANGE (D13) but the lean message rows do
  not; the derivation returns copies - mutating the SEED literal breaks four
  unrelated tests.
- `listing-activity.spec.ts:231, :261` assert `/No reply/i` count 0; the new
  chip reads "No reply yet". Rewrite those two assertions in S8 BEFORE the
  gate run, knowingly.
- Every accessible name on the review rows switches to ASCII " - ";
  `a2p-compliance.spec.ts` pins the VISIBLE no-consent tag's em dash - leave
  the visible tag text alone.
- `useBroadcastsList` sends any non-`all` filter as `?status=`; the Follow
  up tab is its OWN view and hook, never a filter value.
- The Properties count hook is its own module; `useListings` is shared with
  ToursPage and the ListingsList tests mock only `useListings`.
- The perf harness `resolveContactDetail` binds the FIRST tenant in GSI
  order (inactive) - S4.6 rebinds it, or `npm run perf:pages` silently
  samples nothing on that surface.
- The C6 proof is the FULL `npm run e2e`; the isolated case passes without
  the fix.
- An agent runs the backfill ONLY with `--env local --lane <L>`; bare
  `--env local` is Cameron's live stack (AGENTS.md live-stack rule).
- Accepted and NOT to be "fixed": the placement conversion and an
  outcome-only close never stamp `lastMarkedAt`, so they do not supersede a
  decline (spec 14.6); an `email_new_address` row stays unattributed after
  the address is linked (spec 14.6).
- `setListingSendOutcome` returns `{ row }` EVERYWHERE (plan 3.4 #4); a bare
  row anywhere is a seam bug.
- Never restart the shared DynamoDB Local container (Cameron's go only).
