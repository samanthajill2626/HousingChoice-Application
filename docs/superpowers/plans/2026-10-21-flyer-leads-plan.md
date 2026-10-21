# Implementation plan - Flyer trim and flyer / join leads (Sam's 2026-10-21 feedback + tracker #13)

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` (revision 6,
  APPROVED by Cameron 2026-10-21). Decisions are cited D1-D10; "spec section
  N" means its numbered sections 1-6.
- Branch `feat/flyer-leads`, worktree `W:\tmp\flyer-leads`, cut from main
  @b7959e2a. Mission records: `docs/superpowers/reviews/2026-10-21-flyer-leads/`.
- Spec review: 4 rounds (the cap) + Cameron's gate answers -
  `docs/superpowers/reviews/2026-10-21-flyer-leads/design-review/adjudications.md`.
- Status: PLAN v1 DRAFT (2026-10-21). Sections 0-4 are BINDING and written by
  the planner; slice sections 5-10 are the six opus section drafts. Section 4
  (assembly rulings) wins over any slice text it contradicts. Headings INSIDE
  a slice are numbered within that slice; "plan section N" always means this
  file's top-level sections 0-10.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case.
- Commits: a separate bare `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\flyer-leads\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for a new file;
  for a pre-existing file that already carries non-ASCII (several app and
  dashboard files carry em dashes and arrows), only ADDED lines must be ASCII:
  `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. Copy in 1.1 uses ASCII hyphens and the ASCII apostrophe; in JSX
  an apostrophe is written `&apos;` where the file already does so.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - verify any
  literal backslash-u with `grep -n '\\u'` after the edit.
- Dependencies: `npm ci` ran at the worktree root on 2026-10-21 (exit 0).
  Never symlink another worktree's node_modules. No new dependency.
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
  serves the source live). Never commit during it.
- Line numbers are hints against main @b7959e2a; the QUOTED text is the
  anchor. Where an earlier task changed a region, re-read the current text
  and apply the change ON TOP of it - never revert an earlier task.
- Whitespace (D10, Cameron's standing rule): typed input is trimmed before
  it is stored or compared. A builder who finds an untrimmed path in a
  surface this plan touches reports it in its slice report.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- D1: `toUnitFlyer` / `UnitFlyer` (`app/src/lib/unitFields.ts`) and the
  dashboard `PublicFlyer` (`dashboard/src/routes/public/publicApi.ts`) no
  longer carry these TEN keys; they are absent from the payload, never null:
  `rent_min`, `rent_max`, `lease_terms`, `accessibility`, `pets`, `no_pets`,
  `pet_fee`, `deposit`, `deposit_one_month`, `deposit_flexible`.
  `application_fee` stays (0 = "No application fee"). The "only ADDS keys"
  comment (`unitFields.ts:375-377`) is rewritten to record this deliberate
  removal and why it is safe (spec D1 "Old flyer pages").
- D2: every field of those keys is re-tagged Staff only in
  `PROPERTY_FORM_FIELDS` and `REQUIREMENT_ITEMS` (app) and the dashboard
  mirror. `TaggedField` renders the "Tenants see this on the public flyer."
  note ONLY when its visibility is `on_flyer`, whatever `publicNote` says.
- D3: the flyer page order and copy in 1.1; deleted helpers `petsLabel`,
  `depositLabel`, `rentRange`, `addressLines`; `flyerMoney` stays.
- D4: `contacts.findByPhone` stays the ONE lookup. Live holder = existing
  contact; soft-deleted holder (`isDeleted` from `contactsRepo.ts`) = the
  deleted path; none = create (unchanged create body). Nothing is ever
  written to an existing contact (no name, type, status, voucher size,
  housing authority, consent, welcome flag).
- D5: the welcome is sent ONLY when this request created the contact.
- D6: for every live contact (existing, or created by this request): the
  repeat check (existing only), the `signed_up` pin, then touch -> increment
  -> ONE `conversation.updated`. Best-effort, logged with the phone marker,
  response always `{ ok: true }`.
- D7: a flyer share ENTRY (key `flyer`) for a shareable unit and a `tenant`
  or `unknown` contact, refused while a CURRENT decline exists
  (`effectiveDecline(row, undefined)`), decided inside the conditional write.
  O1: `setDeclined` / `clearDeclined` also stamp a fresh `shares_op`.
- D8: outcome `signed_up` = decline > tour > replied > (latest counted key
  is `flyer` ? `signed_up` : `no_reply`). Never waiting.
- D9: `scoreArea` compares subzones as `s.replace(/\s+/g, '').toUpperCase()`;
  an empty result never matches.
- No backfill, no migration, no infra, no new dependency, no change to the
  `[Rent]` merge field.

### 1.1 Exact copy (BINDING - tests assert these strings)

Flyer page (D3), ready state, in this order:
- Heading link (`target="_blank"`, `rel` as the old Address link had it, href
  = the existing `mapsHref`):
  - h1 text = the street line: `line1`, then `line2`, joined by `, ` (blank
    parts left out, each part trimmed);
  - second line inside the same link = `city, state zip`: city, then `, `,
    then state and zip joined by one space; blank parts left out with their
    separators; omitted when the h1 itself is the city line;
  - the sr-only suffix ` - open in Google Maps` (the exact text the old
    Address row carried - copy it from there; if it differs, the OLD text
    wins and the builder reports it).
- Fallbacks for the h1: no street line but any of city / state / zip -> the
  city line (no second line); no address at all -> the area as plain text
  (no link) when recorded; otherwise the plain text `Home for rent`.
  `A home for you` appears nowhere.
- Area line: the area, when recorded AND an address (street or city line)
  is the heading, directly under the heading.
- Highlight line: `Same-day tours available` (every flyer, static copy).
- Facts: beds, baths, `Fits a ... voucher` (unchanged wording); no rent fact.
- Authority line: unchanged wording (`Accepts: ...`), styled bold, larger than
  body text, full-contrast color.
- Detail rows, in this order, each only when recorded: `Application fee`,
  `Tenant pays`, `Washer / dryer`, `Same-day RTA`, `Video tour`, `Listing`
  (labels exactly as they read today; this list fixes only ORDER and
  membership).
- Sign-up box (bare-link `form` variant only): heading
  `Sign up for home alerts`; text
  `We'll text you about this home and others that fit your voucher. Signing up does not book a tour.`;
  button `Sign up`.
- Thank-you: heading unchanged (`Thanks - you're all set!`, exactly as the
  file has it today); text
  `We'll text you about this home and others that fit your voucher.`
- Unchanged: the `?cta=text` variant, the unavailable state, the tap-to-text
  prefill, the CTA's position.

Thread pins (D6), `<First Last>` = `${firstName} ${lastName}` from the parsed
(trimmed) body; `<address>` = `formatAddress(unit.address)`
(`app/src/lib/address.ts`), or the unitId when that is empty:
- flyer, unit shareable: `Signed up from the flyer for <address> as <First Last>`
  (refType `unit`, refId the unitId);
- flyer, unit NOT shareable / missing / made up: `Signed up from a flyer as <First Last>`
  (no ref);
- /join: `Signed up on the join page as <First Last>` (no ref).

Send roster (D8), contact page and property page:
- row words: `Signed up from the flyer <date>` in place of `Sent <date>`,
  where `<date>` is formatted exactly as the row's existing `Sent <date>`
  formats it;
- outcome chip: `Signed up`.

Log lines (new; ids and booleans only, never PII):
- flyer write lost past the re-read bound (ERROR):
  `share ledger: the flyer entry write lost its condition past the re-read bound - not repaired (the repair walks broadcast slots only)`
- flyer write refused by a current decline (INFO):
  `share ledger: flyer entry not written - the pair holds a current decline`
- a best-effort sign-up step failing (WARN or ERROR, with `{ marker, step }`):
  `housing-fair signup step failed` where `step` is one of `repeat_check`,
  `pin`, `touch`, `increment`, `ledger`.

## 2. Binding interfaces

Names, signatures and wire shapes below are BINDING across slices. A slice
writer who finds one wrong against the code raises a CONTRACT ISSUE at the
top of its draft instead of silently deviating.

### 2.1 App: `app/src/lib/shareLedgerKeys.ts` (NEW, pure, import-free)

`app/src/lib/` never imports from `app/src/services/`, and the outcome
derivation (`lib/listingSendOutcome.ts`) is pure, so the ONE "latest counted
entry" rule lives in a lib leaf that both `services/shareLedger.ts` and
`lib/listingSendOutcome.ts` import. (Assembly ruling AR1 - a location
deviation from spec D8's "beside summarize"; the rule is still ONE helper.)

```ts
/** The entry key of an individual send (a seeded legacy row with no share id). */
export const INDIVIDUAL_SHARE_KEY = 'individual';
/** flyer-leads D7: the entry key of a flyer sign-up. */
export const FLYER_SHARE_KEY = 'flyer';
/** flyer-leads D7: the attempt key of a flyer sign-up at `iso`. */
export function flyerAttemptKey(iso: string): string; // `${iso}#flyer`
/**
 * The key of the pair's LATEST counted entry: an entry with
 * state === 'counted' AND a string countedAt; the greatest countedAt wins,
 * ties keep the FIRST in Object.entries order (exactly summarize's strict
 * `>`). undefined when none counts.
 */
export function latestCountedShareKey(
  shares: Record<string, { state: string; countedAt?: string }> | undefined,
): string | undefined;
```

`services/shareLedger.ts`: `INDIVIDUAL_KEY` becomes an import of
`INDIVIDUAL_SHARE_KEY`; `summarize` picks its latest entry with
`latestCountedShareKey` and maps BOTH `INDIVIDUAL_SHARE_KEY` and
`FLYER_SHARE_KEY` to `broadcastId: undefined`. Behavior for every existing
key is unchanged (pinned).

### 2.2 App: `services/shareLedger.ts` - the flyer apply

```ts
export type FlyerShareResult = 'written' | 'declined' | 'refused' | 'lost';
/**
 * flyer-leads D7: record a flyer sign-up for (unitId, contactId) at
 * `signedUpAt` (ISO with ms). Same read-modify-write loop as
 * applyShareLedgerEntry (seed, mayReplace, summarize, putShareMemory on the
 * token, MAX_REAPPLY), plus ONE extra refusal decided on EACH round's
 * consistent read: effectiveDecline(row ?? {}, undefined) === true ->
 * 'declined' (INFO log, 1.1), nothing written. 'refused' = the order rule
 * kept the stored flyer entry. 'lost' = token retries exhausted (the ERROR
 * line in 1.1, NOT the shared "the repair heals it" wording).
 */
export async function applyFlyerShareEntry(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; signedUpAt: string },
): Promise<FlyerShareResult>;
```

The entry is `{ attempt: flyerAttemptKey(signedUpAt), state: 'counted',
by: 'acceptance', countedAt: <the ISO of the attempt key, via ledgerEntryFor>
}` - built with `ledgerEntryFor(flyerAttemptKey(signedUpAt), undefined,
{ kind: 'accepted' })`. The loop body is shared with `applyShareLedgerEntry`
through a private helper taking an optional `refuse(row)` predicate and the
lost-line text; `applyShareLedgerEntry`'s signature, results and log line
are unchanged. `ledgerWouldChange` (the repair census) is unchanged.

### 2.3 App: `repos/listingSendsRepo.ts` (O1)

`setDeclined` and `clearDeclined` add `#op = :op` (`shares_op`, a fresh
`randomUUID()`) to their SET clause. Conditions, return values and every
other attribute are unchanged. The NO-RESET comment block records that the
decline writers now also stamp the token (and why: a racing ledger write
loses its condition, re-reads and sees the decline). The harness fake
(`app/test/helpers/twilioWebhookHarness.ts`) mirrors it, and the
conformance normalizer treats `shares_op` as an opaque token.

### 2.4 App: `lib/listingSendOutcome.ts` (D8)

```ts
export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested' | 'signed_up';
export function deriveListingSendOutcome(input: {
  row: { declined?: DeclineRecord; sentAt?: string; shares?: Record<string, { state: string; countedAt?: string }> };
  recipientType: string | undefined;
  lastHeardFromAt: string | undefined;
  tour: TourSignal | undefined;
  tourActivityAt: string | undefined;
}): ListingSendOutcome;
// order: effectiveDecline -> 'not_interested'; tour -> 'interested';
// heard > sent -> 'replied'; latestCountedShareKey(row.shares) === FLYER_SHARE_KEY
// -> 'signed_up'; else 'no_reply'.
```

`isWaiting` keeps its rule (only `no_reply` / `replied` wait), so
`signed_up` never waits. The five callers (`routes/contacts.ts:1324`,
`routes/units.ts:240,260`, `services/followUps.ts:168`,
`routes/broadcasts.ts:612`) already pass the stored `row`; each is checked
to pass the FULL stored row (with `shares`), never a narrowed copy, and a
test per caller pins `signed_up` reaching its wire. Every `switch` / map over
`ListingSendOutcome` in the app handles `signed_up` (typecheck finds them).
The wire field stays `outcome`.

### 2.5 App: `repos/activityEventsRepo.ts` (D6)

```ts
// ActivityEventType gains:  | 'signed_up'
/**
 * flyer-leads D6: whether the contact has an event of `type` recorded at or
 * after `sinceIso` whose refId is `refId` (undefined = an event with NO
 * refId). Query PK contactId, KeyCondition `tsEventId > :since` (sinceIso as
 * the bound), FilterExpression on `#type = :type` and on the ref
 * (`refId = :ref` or `attribute_not_exists(refId)`), paginated to the end of
 * the window (lib/dynamoPaging queryAll). Throws on a DynamoDB error.
 */
hasEventSince(contactId: string, type: ActivityEventType, sinceIso: string, refId: string | undefined): Promise<boolean>;
```

The harness fake implements the same rule over its array, and the
conformance suite (`app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`)
holds the fake to the real repo for `hasEventSince` (window edge, type
filter, ref vs no-ref).

`routes/contactTimeline.ts` maps `signed_up` like the other milestones (its
label and ref pass through; a `unit` ref links to the property).

### 2.6 App: `routes/public.ts` (D4-D7)

`PublicRouterDeps` gains (defaults in brackets):
- `activityEventsRepo?: Pick<ActivityEventsRepo, 'record' | 'hasEventSince'>`
  [`createActivityEventsRepo({ logger })`];
- `listingSendsRepo?: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>`
  [`createListingSendsRepo({ logger })`];
- `events?: EventBus` [`appEvents`];
- `now?: () => number` [`Date.now`] - the test seam for the 24-hour window
  and the attempt key.

`app.ts` needs no change beyond what `...deps.public` already spreads (the
defaults cover production). The harness `public:` block passes
`world.activityEventsRepo`, `world.listingSendsRepo`, `world.events`.

The handler, after the existing parse and housing authority check
(unchanged), in this order:
1. Flyer unit read (unchanged rule) - keep the unit object for the label.
2. `existing = await contacts.findByPhone(phone)`.
3. `existing` soft-deleted -> audit (`deletedContact: true`), log, `{ ok: true }`.
   No conversation call, no send, no pin, no unread, no ledger.
4. `existing` live -> contactId, contact = existing, `isNew = false`.
   none -> create exactly as today (`isNew = true`, contact = created).
5. Conversation: `createOrGetByParticipantPhone(phone, conversationTypeFor(contact))`
   then `setParticipantsIfAbsent` (unchanged; NOT best-effort, as today).
6. Welcome: only when `isNew` (D5); `housing_fair_welcomed: true` after a
   successful send, as today.
7. Repeat check (existing only): source refId = `viaFlyer ? unitId : undefined`;
   `hasEventSince(contactId, 'signed_up', new Date(now() - 24h).toISOString(), source)`;
   a throw FAILS OPEN (logged, step `repeat_check`). New contacts skip the read.
8. Unless a repeat: the pin (`record`, label 1.1), then touch
   (`touchLastActivity(conversationId, undefined, nowIso)`) -> increment ->
   ONE `events.emit('conversation.updated', { ...toConversationUpdatedEvent(touched), unread_count: count })`.
   A failed increment emits from the touched image unchanged; a failed touch
   means no increment and no event. Each failure logged with its step.
9. Ledger: when `viaFlyer` and contact type is `tenant` or `unknown`:
   `applyFlyerShareEntry(...)`, `signedUpAt` = `new Date(now()).toISOString()`.
   A throw = `sentSkipped: 'error'` (logged, step `ledger`).
10. Audit, log line, `{ ok: true }`.

Audit `housing_fair_signup` payload = today's fields (`marker`, `isNew`,
`welcomeSent`, `viaFlyer`, `signupVersion: 2`, `housingAuthority`) plus:
`existingContact` (live holder), `deletedContact`, `recorded` (pin
written), `sentRecorded` (ledger `'written'`), `sentSkipped` (absent when
written; else `not_flyer` = no unitId, `not_shareable` = unitId but not
`viaFlyer`, `not_tenant`, `declined`, `refused` (AR2), `lost`, `error`;
for the deleted path `sentSkipped` is absent and `sentRecorded: false`),
`consentVersion: CONSENT_VERSION`. `app/scripts/backfill-join-housing-authority.ts:226`
keeps working (pinned).

### 2.7 Dashboard

- `dashboard/src/api/types.ts`: `ListingSendOutcome` adds `'signed_up'`; the
  milestone type union (`TimelineMilestoneType`, near `'listing_interested'`)
  adds `'signed_up'`. `endpoints.ts` accepts `signed_up` wherever it
  validates or maps outcomes.
- `dashboard/src/routes/public/publicApi.ts`: `PublicFlyer` drops the ten
  D1 keys.
- `dashboard/src/routes/listing/requirements.ts`: the mirror re-tags as D2;
  its drift test stays green against the app table.
- `TaggedField`: renders the public note only when `visibility === 'on_flyer'`.
- `Card.tsx` `SendRosterRow`: the words and chip in 1.1; the action gate
  (`row.outcome === 'no_reply' || row.outcome === 'replied'`, line ~348)
  adds `signed_up`; "Request a tour" keeps its partner-only rule.
- `listingFormat.ts` `groupSendRows`: `signed_up` -> Interested when the
  recipient is eligible, else Not eligible (the waiting rows' rule).
- `Timeline.tsx` `MilestonePin`: a colour for `signed_up` (reuse an existing
  neutral or positive milestone colour; no new design token).
- `ContactDetail.tsx`, `ListingDetail.tsx`, `FollowUpView.tsx`: every
  outcome switch / label map handles `signed_up`.

## 3. Slices, task numbering, order

| Slice | Plan section | Tasks | Area | Depends on |
|---|---|---|---|---|
| S1 | 5 | 1.x | App: projection (D1), tag tables (D2 app side), subzone (D9) | - |
| S2 | 6 | 2.x | Dashboard: mirror, TaggedField note gate, form props, PublicFlyer, FlyerPage (D2 dashboard side, D3) | S1 (tag table values) |
| S3 | 7 | 3.x | App: ledger keys, flyer apply, decline token (O1), outcome `signed_up` + callers (D7, D8) | - |
| S4 | 8 | 4.x | App: activity type + hasEventSince, public router deps + harness, the handler (D4-D7), audit | S3 |
| S5 | 9 | 5.x | Dashboard: wire unions, MilestonePin, roster row, groupSendRows, outcome switches (D8 renderers) | S3 (union) |
| S6 | 10 | 6.x | e2e repairs + new flyer-leads spec, selectors.md, GLOSSARY, gates | S1-S5 |

Build order: S1 -> S3 -> S4 -> S2 -> S5 -> S6 (or S2/S5 after their
dependency, never before). Each slice ends with its exit check (the slice's
own test files plus `npm run typecheck` from the worktree root).

### 3.1 Invariant enumeration (BINDING - every row is a task or a watch item)

**Invariant A: the public flyer never carries a Staff only field.** Writers
of the projection: `toUnitFlyer` (S1). Readers: `GET /public/units/:unitId/flyer`
(S1 test), `PublicFlyer` + `FlyerPage` (S2), the parity walk (S1), the
dashboard mirror drift test (S2), e2e public-pages / property-requirements
(S6). The tag tables are the forms' claim about it: `PROPERTY_FORM_FIELDS`,
`REQUIREMENT_ITEMS`, the mirror, `TaggedField`, `RequirementsFields`, the
three forms (S1, S2).

**Invariant B: a sign-up never changes an existing contact.** Writers in the
handler: `contacts.create` (new only), `contacts.update` (welcome flag, new
only after this change). Watch: no other `contacts.*` write in the handler
(S4 test asserts the existing contact's stored item is byte-identical).

**Invariant C: one pin and one bump per contact per source per 24 hours.**
Writer: the handler (S4). Reader: `hasEventSince` (S4) over
`activity_events` - also written by every other milestone writer, which the
type filter excludes.

**Invariant D: a sign-up never clears or overrides a CURRENT decline.**
Writers of `listing_sends`: `putShareMemory` via `applyShareLedgerEntry`
(broadcast fan-out, share attempt outcome), `applyFlyerShareEntry` (new),
`setDeclined` / `clearDeclined` (O1 token), the seed runner's Put
(dev-only, unchanged), the dev listing-send fixture (`dev.ts:1433-1484`,
unchanged signature). Readers of the outcome: the five
`deriveListingSendOutcome` callers, `isWaiting` / follow-ups, the
dashboard renderers, `blastAudienceRules.ts` (excludes only
`not_interested` - pinned unchanged), the repair script
`app/scripts/repair-share-outcomes.ts` (watch: its census must not
mis-forecast a `flyer` entry - S3 adds a test), `contactTimeline.ts`
`propertySentWords` (watch: an uncounted pair turned counted by a flyer
entry reads "Property sent" - the spec's stated residual, pinned).

**Invariant E: the unread mark never leaves a closed thread flagged but
invisible.** Writer order touch -> increment (S4). Readers: inbox, unread
feed (unchanged; pinned through the e2e inbox row).

### 3.2 Watch items for every slice

- The flyer entry's `via`: a brand-new row gets `via: 'broadcast'` from
  `putShareMemory`'s `if_not_exists`; nothing renders `via` (spec D7). Do
  not change `putShareMemory`.
- A `flyer` key must never reach the Matching composer's "already sent"
  hint or any `broadcastId` consumer (`summarize` maps it to undefined).
- `latestCountedShareKey` ties: the FIRST entry in insertion order wins,
  identical to `summarize` today. Never sort keys.
- The pin label carries a typed name: never log it (activityEventsRepo
  already logs ids/type only).
- `conversationTypeFor(created)` for a new contact is `tenant_1to1`, as
  today - pinned.
- Old public flyer bundle crash on the new payload is ACCEPTED (spec D1);
  do not add compatibility code.
- `blastAudienceRules.ts`: a `signed_up` tenant stays checked by default.

## 4. Assembly rulings (planner, BINDING over the slice text below)

- AR1. `latestCountedShareKey`, `FLYER_SHARE_KEY`, `INDIVIDUAL_SHARE_KEY`
  and `flyerAttemptKey` live in the new pure leaf
  `app/src/lib/shareLedgerKeys.ts` (2.1), because `lib/` never imports
  `services/`. Spec D8's "ONE helper" holds: `summarize` and
  `deriveListingSendOutcome` both call it.
- AR2. `applyFlyerShareEntry` can also return `'refused'` (the order rule
  kept a NEWER stored flyer entry - two sign-ups inside the clock skew of
  two app instances). The audit records it as `sentSkipped: 'refused'`, a
  precision addition to the spec's list (the list's purpose - "why no entry
  was written" - is kept honest).
- AR3. The handler's injected clock `now` (2.6) is the only time source for
  the 24-hour window, the touch timestamp and the attempt key, so tests are
  deterministic.

(Slice drafts' contract issues are ruled on here at assembly.)
