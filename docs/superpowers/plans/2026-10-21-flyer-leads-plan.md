# Implementation plan - Flyer trim and flyer / join leads (Sam's 2026-10-21 feedback + tracker #13)

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` (revision 6,
  APPROVED by Cameron 2026-10-21). Decisions are cited D1-D10; "spec section
  N" means its numbered sections 1-6.
- Branch `feat/flyer-leads`, worktree `W:\tmp\flyer-leads`, cut from main
  @b7959e2a. Mission records: `docs/superpowers/reviews/2026-10-21-flyer-leads/`.
- Spec review: 4 rounds (the cap) + Cameron's gate answers -
  `docs/superpowers/reviews/2026-10-21-flyer-leads/design-review/adjudications.md`.
- Status: PLAN v3 FINAL (2026-10-21), plan review CLOSED after 2 rounds. Sections
  0-4 are BINDING and written by the planner; slice sections 5-10 are the
  six opus section drafts, verbatim. Section 4 (assembly rulings AR1-AR16)
  wins over any slice text it contradicts. The drafts themselves
  (gitignored, `.superpowers/sdd/plan-drafts/`) are never the authority. Headings INSIDE
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
- Slice reports (plan review R1 #2): a "slice report" is the file
  `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S<n>-report.md`,
  ASCII, findings only (what the tree held that the plan got wrong, risks,
  untrimmed paths), citing code by `file:line`. It MAY name pre-existing
  lint errors in files the slice touched (a finding for the next reader);
  `S6-gates.md` stays the authority for gate 5's baseline attribution (R2
  #6). Commit it with explicit paths when the slice ends. A slice with
  nothing to report writes one line saying so.
- Code blocks under list bullets (R1 #13) carry the bullet's indent in this
  file. Strip that indent before using a block as an Edit anchor or as
  replacement text; the target file's own indentation is the authority.
- Commit messages (R1 #15): use repeated `-m` arguments, or a message file
  OUTSIDE the worktree (never inside it - it would show in `git status`).

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
 * (`refId = :ref` or `attribute_not_exists(refId)`), `ConsistentRead: true`
 * (AR12 - two quick sign-ups must see each other's pin), paginated to the end
 * of the window (lib/dynamoPaging queryAll). Throws on a DynamoDB error.
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
for the deleted path `sentSkipped: 'deleted'` and `sentRecorded: false` -
AR11),
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

Build order (AR4): S1 -> S2 -> S3 -> S4 -> S5 -> S6. S2 runs straight
after S1 because the dashboard mirror drift test imports the app table, so
S1's re-tag leaves it red until S2 lands. Slice text that still says
"S1 -> S3 -> S4 -> S2" is superseded by this line. Each slice ends with its
exit check (the slice's own test files plus `npm run typecheck` from the
worktree root).

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

Slice contract issues, ruled at assembly (2026-10-21):

- AR4. (S1-1, S2-1) Build order S1 -> S2 -> S3 -> S4 -> S5 -> S6 (plan
  section 3). S2's Task 2.2 precheck (stop if S1 has not landed) stays.
- AR5. (S1-2, S2-2) WITHDRAWN by AR16 (premise false). The drafters read
  `validateUnitBody`'s plain `string` kind and the Edit form's raw fields as
  an untrimmed save path. S2's display-time trim of the area (Task 2.4 step
  3(a), `neighborhood()`) stays ACCEPTED: it changes no stored data and is
  harmless.
- AR6. (S2-3) No change: `interestedPrefill` is fed a validated, trimmed
  address.
- AR7. (S3) 1: no change (the conformance normalizer already treats
  `shares_op` as opaque; S3's exposing step stays). 2: ACCEPT the private
  loop helper's names `veto` and `lostIds` beside `lostLine` (plan 2.2's
  `refuse` was descriptive); `applyShareLedgerEntry`'s ERROR fields stay
  byte-identical and no log line carries `broadcastId: 'flyer'`. 3: CONFIRMED
  - `signed_up` is type-blind, so a missing recipient and an `unknown`
  contact read it too; the renderers file an ineligible or missing
  recipient under Not eligible (S5 Task 5.3 owns it). 4: no change. 5:
  ACCEPT `flyerAttemptKey` in `shareLedgerKeys.ts` with a doc sentence in
  `shareAttemptOrder.ts`.
- AR8. (S4) All ACCEPTED. 1: the pin is recorded with `at: nowIso`. 2: ONE
  clock reading, taken after the welcome send: the window start, the pin
  `at`, the touch `ts` and `signedUpAt` all derive from it (replaces the two
  `now()` reads in 2.6). 3: `HarnessOptions.publicNow?: () => number`,
  forwarded as the router's `now`. 4: a failed pin does NOT skip the unread
  mark (the audit says `recorded: false`). 5: "ONE conversation.updated"
  means the mark emits one event; a new contact's welcome send emits its own
  event first (`sendMessage.ts:738`). Tests assert exactly one event for an
  existing contact, and that the LAST event carries the new count for a new
  contact.
- AR9. (S5) 1: ACCEPT - an Undo on Follow up answered with `signed_up`
  shows the waiting display until the next load; pinned. 2: no endpoint
  change (nothing validates outcomes); the pass-through PIN stays. 3: the
  `signed_up` pin is GREEN (the positive existing colour; replaces 2.7's
  "neutral or positive"). Note: S5 section E's date example "Today 3:05p"
  is wrong - the label is `formatHeardFrom`'s, e.g. "Today 2:14 PM"; S6's
  regex is right.
- AR10. (S6) 1: the docs tasks (6.3, 6.4) and the gates task (6.5) are
  exempt from the RED rule; they are verified by grep, the ASCII check and
  the gates' exit codes. 2: 6.5 is the ONE main sync; a later fix wave
  re-runs the gates without a second sync and reports newer main drift. 3:
  the GLOSSARY documents all five fields leaving the flyer (rent,
  accessibility, lease terms, pets, deposit).

Plan review round 1 rulings (adjudications:
`docs/superpowers/reviews/2026-10-21-flyer-leads/plan-review/adjudications.md`):

- AR11. (R1 #11) The deleted path's audit records `recorded: false`,
  `sentRecorded: false` and `sentSkipped: 'deleted'`, so `sentSkipped` is
  absent ONLY when an entry was written (the spec's own rule).
- AR12. (R1 #5) `hasEventSince` reads with `ConsistentRead: true` (plan
  2.5); a test asserts the Query command carries it.
- AR13. (R1 #1) The units recipients projection (`routes/units.ts`, the
  `tenantName` it attaches) labels a RESOLVED contact that has no first or
  last name by its formatted phone - `formatPhoneForDisplay(phone) ?? phone`
  from `app/src/lib/phone.ts`, the `groupTitle.ts:56` precedent - so the
  property "Sent to" card never shows a raw contactId for a contact that
  exists. `tenantName` stays absent for an unresolved / missing contact (the
  dashboard's existing contactId fallback is unchanged for those). The wire
  comment on `ListingSendRow.tenantName` is updated to say so. S3 owns it.
- AR14. (R1 #4) Superseded by AR16: the conditional work drafted for AR5's
  two outcomes is removed from S1 and S6.
- AR15. (R1 #9) The S3 and S4 exit checks each run the FULL app suite
  (`cd app; npx vitest run`), because both slices edit shared test helpers
  (the harness fakes, `listingSendSeed.ts`).
- AR16. (S1's own correction while applying R1, verified by the planner)
  AR5's premise is FALSE. `app.ts:146` mounts `trimJsonBody()`
  (`middleware/trimStrings.ts:43-50`) before every route, and it deep-trims
  every string in every JSON body. The validator's only callers are the HTTP
  routes, so no dashboard or public save stores those unit fields
  untrimmed, and the importer trims `notes` itself. No task, no issue file,
  no question for Cameron.

## 5. S1 - App: the public projection (D1), the tag tables (D2, app side), subzone matching (D9)

Slice S1 owns Tasks 1.1 and 1.2. Build it first (plan section 3 and AR4:
S1 -> S2 -> S3 -> S4 -> S5 -> S6). It touches app files only.

Both tasks were dry-run in a scratch copy against the real files at main
@b7959e2a. Every projection, tag and ranking test below was RED before its
implementation and GREEN after, and the scratch `tsc` (app compiler options)
exited 0. The one exception is `publicIntake.test.ts`, which needs the whole
harness; its expected key list was computed from the real, edited
`toUnitFlyer`.

## A. CONTRACT ISSUES (for the planner to rule)

1. **RULED by AR4 - no action left.** Task 1.1 changes the app tables, and
   `dashboard/src/routes/listing/requirementsMirror.test.ts` compares them by
   `toEqual` (line 81 `REQUIREMENT_ITEMS`, line 88 `PROPERTY_FORM_FIELDS`).
   Under AR4's order S2 is the NEXT slice, so its two cases ("the items, ids
   and key lists are identical" and "the D10a property-form table is
   identical") are red only from Task 1.1's commit until S2 re-tags the
   mirror. The S1 exit check names them as expected-red.
2. **WITHDRAWN - premise false; ruled AR16, no task.**
   - `app.ts:146` `trimJsonBody` deep-trims every JSON body.
   - The validator's only callers are the HTTP routes.
   - The importer trims `notes`.

No other contract issue. Plan sections 1 (D1, D2, D9) and 3.1 (Invariant A)
match the code. The binding interfaces in section 2 do not touch S1.

## B. Facts the tasks rely on (verified on this worktree)

- `app/src/lib/unitFields.ts:73-74`: `rent_min: 'number',` / `rent_max: 'number',`
  (WRITABLE_FIELDS; no comment today).
- `app/src/lib/unitFields.ts:80-82`: `// 2026-10-20 D1: clearable money, null REMOVEs). PUBLIC on the flyer.`
  then `deposit: 'requirement',`.
- `app/src/lib/unitFields.ts:86`: `// Accessibility notes (tenant-useful). PUBLIC on the flyer projection (flyer-full-info).`
- `app/src/lib/unitFields.ts:93-94`: `// accepted programs / expected rent - see GLOSSARY). PUBLIC on the flyer`
  / `// projection below (flyer-full-info 2026-07-16).`
- `app/src/lib/unitFields.ts:98`: `// in the new shape at once (the 'pets' case below). PUBLIC on the flyer.`
- `app/src/lib/unitFields.ts:356`: the never-list ends `credit_requirements, income_requirements, qualifications and deposit_notes.`
- `app/src/lib/unitFields.ts:375-377` (spec D1's anchor): `* Older bundles (spec 2026-10-20 D11): a flyer page loaded before #12 keeps`
  / `* reading \`voucher_size\`, \`deposit\`, \`application_fee\` and \`pets\`, so the`
  / `* projection keeps those keys and only ADDS keys.`
- `app/src/lib/unitFields.ts:379-425`: `export interface UnitFlyer {`. It carries
  `rent_min`/`rent_max` (400-401) and `pets`, `no_pets`, `pet_fee`,
  `accessibility`, `deposit`, `deposit_one_month`, `deposit_flexible` and
  `lease_terms` (406-422).
- `app/src/lib/unitFields.ts:482-489`: `const pets = unitItemValue(unit, 'pets');`
  / `const deposit = unitItemValue(unit, 'deposit');` /
  `const fee = unitItemValue(unit, 'application_fee')['application_fee'];`.
  `unitItemValue` stays imported, because the `'pets'` case of
  `validateUnitBody` (:276) and the fee still use it.
- `app/src/lib/unitFields.ts:500-501` and `507-514`: the ten projected keys
  in the returned object.
- `app/src/lib/requirements.ts:84-97`: the Pets item fields `'on_flyer'` x3
  and the Deposit fields `deposit_one_month` / `deposit` / `deposit_flexible`
  `'on_flyer'`; `deposit_notes` is already `'staff_only'`.
- `app/src/lib/requirements.ts:535-536`, `542-543`: `formField('Rent min', ['rent_min'], 'on_flyer'),`
  / `Rent max` / `Accessibility` / `Lease terms`, all `'on_flyer'`.
- `app/src/lib/requirements.ts:510-517`: REQUIREMENT_FORM_FIELDS derives the
  requirement rows from REQUIREMENT_ITEMS. "No application fee" copies the
  `application_fee` tag, so the requirement rows of the 35-row table follow
  the registry automatically.
- `app/src/repos/unitsRepo.ts` comments that call the trimmed keys public:
  - :423, `alternative to \`deposit_one_month\`). PUBLIC on the flyer. */`;
  - :442, `/** Accessibility notes <EM-DASH> free-form. */`, where `<EM-DASH>`
    stands for the U+2014 character the file really carries (this draft is
    ASCII). The rewrite replaces it with an ASCII hyphen;
  - :452-454, `after"). Moved off the landlord contact 2026-07-10 (GLOSSARY). PUBLIC on`;
  - :515, :517, :519 and :521, each ending `PUBLIC on the flyer. */`.
- `app/src/routes/public.ts:463`:
  `res.json({ flyer: { ...toUnitFlyer(unit), media, contact_number: contactNumber } });`.
  The flyer route spreads the projection, so it needs NO code change.
- `app/src/lib/similarUnits.ts:52-65`:
  `/** area: 1.0 same subzone, 0.6 same area (different subzone), else 0. */`,
  and `scoreArea` compares `target.subzone === c.subzone` after
  `target.subzone.length > 0`. A whitespace-only subzone therefore matches
  itself today.
- `app/src/lib/similarUnits.ts:126`: `if (scores.area >= 1) parts.push('Same subzone');`.
  The reason text needs no change.
- `app/test/propertyFormFlyerParity.test.ts:174-214`: the pinned 35-row
  table. `:260-267`: "catches a wrong tag", which flips
  `new Set(['Subzone', 'Pets (details)', 'Deposit notes'])`.
- `app/test/requirements.test.ts:85-90`: the six Pets / Deposit tuples, each
  ending `'on_flyer'],`.
- `app/test/unitFields.test.ts:581-847`: `describe('toUnitFlyer - the merged public allowlist', ...)`.
  Its fixture is at 602-610, the exact shape at 638-670, the leak wall at
  672-697, the bare-unit test at 699-722, pets at 724-740, deposit at
  794-820, the money fields at 827-834 and the pet fee at 836-839.
- `app/test/publicIntake.test.ts:266-380`:
  `describe('GET /public/units/:unitId/flyer <EM-DASH> shareable view only', ...)`.
  Its fixture `seedFullUnit` is at 267-293 and the test
  `'returns ONLY the allowlisted flyer fields (internal fields absent)'` at
  295-380. The describe line carries an em dash; do not edit it.
- No other app reader: `grep -rnE "\.flyer\b|\bflyer:" app/src` hits only
  `lib/requirements.ts` and `routes/public.ts:463`. No other app test pins
  `on_flyer` / `staff_only`. `app/scripts` never calls `toUnitFlyer`. The
  remaining `rent_min` / `rent_max` / `pets` / `deposit` readers are WRITE or
  non-flyer readers and stay unchanged: `lib/mergeFields.ts:36-37` (the
  `[Rent]` merge field, unchanged by spec), `lib/similarUnits.ts:68-76` (the
  rent score), `lib/unitRequirementWrite.ts`, the seeds, and
  `repos/contactsRepo.ts` (`req_*`).
- `app/test/unitsApiSimilar.test.ts` uses identical subzone strings only
  (`subzone: 'North-A'`), so D9 leaves it unchanged. No edit.
- `app/src/lib/seed/lean.ts:212-213`: a comment says
  `rent_min / rent_max / pets` are names "the app reads (unitFields
  WRITABLE_FIELDS + toUnitFlyer + ...)". It stays true through
  WRITABLE_FIELDS. No edit.
- Line endings: the touched files are LF, UTF-8. `unitFields.ts`,
  `similarUnits.ts`, `unitsRepo.ts`, `unitFields.test.ts`,
  `publicIntake.test.ts` and `similarUnits.test.ts` already carry non-ASCII on
  OTHER lines, so the added-lines ASCII check applies to them.
  `requirements.ts`, `requirements.test.ts` and
  `propertyFormFlyerParity.test.ts` are pure ASCII today.

## C. Commands used by every task

Run every command in Git Bash, with the worktree path written in full. Never
pipe a test command.

- DynamoDB Local is needed by every app vitest run. Start it ONCE if it is
  not running, from `W:/tmp/flyer-leads`: `npm run db:start`. Never restart
  the shared container.
- Run app tests from `W:/tmp/flyer-leads/app`: `npx vitest run test/<file> [test/<file> ...]`.
  `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY on these red/green steps, never
  on a gate.
- Typecheck from `W:/tmp/flyer-leads`: `npm run typecheck`. Do not run it
  between a task's Step 1 and Step 3. The new tests drop keys that the OLD
  `UnitFlyer` still requires, so `tsc` is red until the implementation lands.
- ASCII check on a pre-existing file, from `W:/tmp/flyer-leads`, BEFORE
  `git add`. It must print `0`:
  `git diff -U0 -- <FILE> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
- Commit, from `W:/tmp/flyer-leads`:
  1. Run a bare `git status` on its own and read it. If it lists a file this
     task did not edit (for example the planner's records under
     `docs/superpowers/reviews/2026-10-21-flyer-leads/`), never stage it.
  2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD" && echo "MERGE IN PROGRESS - STOP" || echo "no merge in progress"`
  3. `git add <explicit paths>`, then a bare `git status`. Exactly those paths
     are staged.
  4. `git commit -m "<subject>" -m "<body>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
  5. Never `git add -A`. Never commit while an e2e suite runs in this worktree.

## Task 1.1 - The flyer drops the ten trimmed keys, and every tag says Staff only (spec D1, D2 app side)

Goal: `toUnitFlyer` / `UnitFlyer` no longer carry `rent_min`, `rent_max`,
`lease_terms`, `accessibility`, `pets`, `no_pets`, `pet_fee`, `deposit`,
`deposit_one_month` or `deposit_flexible`: the keys are absent, never null.
`REQUIREMENT_ITEMS` and `PROPERTY_FORM_FIELDS` tag every field behind those
keys Staff only. `application_fee` stays On flyer.

The two halves are ONE commit, because the parity walk couples them. Either
half alone turns `propertyFormFlyerParity.test.ts` red.

Files:
- `app/src/lib/unitFields.ts`
- `app/src/lib/requirements.ts`
- `app/src/repos/unitsRepo.ts` (comments only)
- `app/test/requirements.test.ts`
- `app/test/propertyFormFlyerParity.test.ts`
- `app/test/unitFields.test.ts`
- `app/test/publicIntake.test.ts`

### Step 1 - tests first

**1a. `app/test/requirements.test.ts`, the pinned registry shape.** Anchor
(lines 85-90, exact):

```ts
      ['pets', 'no_pets', 'req_no_pets', 'No pets', 'checkbox', 'on_flyer'],
      ['pets', 'pets', 'req_pets', 'Pets (details)', 'text', 'on_flyer'],
      ['pets', 'pet_fee', 'req_pet_fee', 'Pet fee', 'text', 'on_flyer'],
      ['deposit', 'deposit_one_month', 'req_deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'],
      ['deposit', 'deposit', 'req_deposit', 'Fixed amount', 'money', 'on_flyer'],
      ['deposit', 'deposit_flexible', 'req_deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'],
```

Replace with:

```ts
      // flyer-leads D2 (spec 2026-10-21): every Pets and Deposit field is Staff only.
      ['pets', 'no_pets', 'req_no_pets', 'No pets', 'checkbox', 'staff_only'],
      ['pets', 'pets', 'req_pets', 'Pets (details)', 'text', 'staff_only'],
      ['pets', 'pet_fee', 'req_pet_fee', 'Pet fee', 'text', 'staff_only'],
      ['deposit', 'deposit_one_month', 'req_deposit_one_month', "One month's rent", 'checkbox', 'staff_only'],
      ['deposit', 'deposit', 'req_deposit', 'Fixed amount', 'money', 'staff_only'],
      ['deposit', 'deposit_flexible', 'req_deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'staff_only'],
```

**1b. `app/test/requirements.test.ts`, a new case.** Insert it directly
BEFORE the anchor
`  it('flattens the 15 unit keys and the 15 req_ keys in item, then field, order', () => {`:

```ts
  it('flyer-leads D2: Application fee is the only requirement field On flyer', () => {
    expect(
      REQUIREMENT_ITEMS.flatMap((item) => item.fields.filter((f) => f.flyer === 'on_flyer').map((f) => f.key)),
    ).toEqual(['application_fee']);
  });

```

**1c. `app/test/propertyFormFlyerParity.test.ts`, the pinned 35-row table.**
Make three replacements inside the
`'lists every property-form field in form order with its tag (D10, D10a, plan AR1) - 35 rows'`
case.
- Anchor `      ['Rent min', ['rent_min'], 'on_flyer'],` + newline +
  `      ['Rent max', ['rent_max'], 'on_flyer'],`. Replace with:
  ```ts
      // flyer-leads D2 (spec 2026-10-21): rent, accessibility, lease terms and
      // every Pets / Deposit field are Staff only; Application fee stays On flyer.
      ['Rent min', ['rent_min'], 'staff_only'],
      ['Rent max', ['rent_max'], 'staff_only'],
  ```
- Anchor `      ['Accessibility', ['accessibility'], 'on_flyer'],` + newline +
  `      ['Lease terms', ['lease_terms'], 'on_flyer'],`. Replace with the same
  two rows ending `'staff_only'],`.
- Anchor the six rows `['No pets', ['no_pets'], 'on_flyer'],` through
  `['Flexible / payment terms available', ['deposit_flexible'], 'on_flyer'],`
  (lines 200-205). Replace with the same six rows, each ending
  `'staff_only'],`.

Rows that stay unchanged: Owning landlord, Housing authorities, Beds, Baths,
Voucher sizes accepted, Payment standard, Address, Subzone, Washer / dryer,
Tenant-paid utilities, Public listing link, Video URL, Same-day RTA, the
five Screening rows, Deposit notes, No application fee, Application fee,
Tour type, Tour process, Application process and Notes. The table stays at
35 rows.

**1d. `app/test/propertyFormFlyerParity.test.ts`, the wrong-tag proofs.**
Anchor (lines 262-267, exact):

```ts
    const flipped = new Set(['Subzone', 'Pets (details)', 'Deposit notes']);
    const wrong = PROPERTY_FORM_FIELDS.map((f) => (flipped.has(f.label) ? { ...f, flyer: flip(f.flyer) } : f));
    const mismatches = flyerTagMismatches(wrong, BASES);
    expect(mismatches).toHaveLength(flipped.size * BASES.length);
    expect(new Set(mismatches.map((m) => m.split(' | ')[0]))).toEqual(flipped);
  });
```

Replace with the code below. "Pets (details)" is now Staff only, so all three
old flips ran in the same direction. Adding "Application fee" keeps an On
flyer -> Staff only flip in the proof. The new case is the D2 RED driver.

```ts
    // Both directions: three Staff only rows flipped On flyer, and one On flyer
    // row (Application fee) flipped Staff only.
    const flipped = new Set(['Subzone', 'Pets (details)', 'Deposit notes', 'Application fee']);
    const wrong = PROPERTY_FORM_FIELDS.map((f) => (flipped.has(f.label) ? { ...f, flyer: flip(f.flyer) } : f));
    const mismatches = flyerTagMismatches(wrong, BASES);
    expect(mismatches).toHaveLength(flipped.size * BASES.length);
    expect(new Set(mismatches.map((m) => m.split(' | ')[0]))).toEqual(flipped);
  });

  it('flyer-leads D2: a re-tagged field tagged On flyer again fails the walk on every base', () => {
    const retagged = new Set([
      'Rent min',
      'Rent max',
      'Accessibility',
      'Lease terms',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]);
    const wrong = PROPERTY_FORM_FIELDS.map((f) =>
      retagged.has(f.label) ? { ...f, flyer: 'on_flyer' as FlyerVisibility } : f,
    );
    const mismatches = flyerTagMismatches(wrong, BASES);
    expect(mismatches).toHaveLength(retagged.size * BASES.length);
    expect(new Set(mismatches.map((m) => m.split(' | ')[0]))).toEqual(retagged);
    expect(mismatches.every((m) => m.endsWith('tagged On flyer, but the flyer does not change'))).toBe(true);
  });
```

`FlyerVisibility` is already imported (line 18). SAMPLE and BASES need no
change: the "fully filled" base already sets rent, accessibility, lease
terms, pets, pet fee and deposit. The sizes-equal base sets no_pets,
deposit_one_month and deposit_flexible.

**1e. `app/test/unitFields.test.ts`, inside `describe('toUnitFlyer - the merged public allowlist'`.**

(i) Anchor (lines 581-584):

```ts
describe('toUnitFlyer - the merged public allowlist', () => {
  // A unit loaded with EVERY internal/landlord/contact field set, to prove none
  // leak through the projection.
  function fullUnit(
```

Insert this between the `describe(` line and the `// A unit loaded` comment:

```ts
  // flyer-leads D1 (spec 2026-10-21): the ten keys the public flyer no longer
  // carries. Staff only; ABSENT from the payload, never sent as null.
  const TRIMMED_FLYER_KEYS = [
    'rent_min',
    'rent_max',
    'lease_terms',
    'accessibility',
    'pets',
    'no_pets',
    'pet_fee',
    'deposit',
    'deposit_one_month',
    'deposit_flexible',
  ] as const;

```

(ii) The fixture. Anchor (lines 602-610, exact):

```ts
      // newly PUBLIC (flyer-full-info 2026-07-16) - real values, asserted below
      deposit: 1400,
      accessibility: 'Ground floor, no stairs',
      lease_terms: '12-month minimum',
      pets: 'Cats only',
      // spec 2026-10-20 D1/D3/D11: public requirement keys and washer / dryer
      pet_fee: '$300 one-time',
      deposit_flexible: true,
      washer_dryer: 'hookups',
```

Replace with the code below. `rent_min: 1400, rent_max: 1600` already sit
higher in the fixture (594-595); keep them.

```ts
      // flyer-leads D1 (2026-10-21): staff only now. Every one of the ten
      // trimmed keys is set (TRIMMED marks the text ones) and asserted ABSENT
      // below. Both deposit alternatives are set on purpose: this is a
      // projection fixture, not a valid write.
      deposit: 1400,
      deposit_one_month: true,
      deposit_flexible: true,
      accessibility: 'TRIMMED ground floor, no stairs',
      lease_terms: 'TRIMMED 12-month minimum',
      pets: 'TRIMMED cats only',
      no_pets: true,
      pet_fee: 'TRIMMED $300 one-time',
      // spec 2026-10-20 D3/D11: washer / dryer stays public
      washer_dryer: 'hookups',
```

(iii) The exact shape and a new RED case. In
`it('exposes the merged public field set (teaser + reveal + tenant-useful)'`,
delete the expected-object lines `      rent_min: 1400,` and
`      rent_max: 1600,` (653-654). Also delete the eight lines from
`      pets: 'Cats only',` through `      lease_terms: '12-month minimum',`
(660-667). The object keeps `washer_dryer: 'hookups',` as its last key.

Then insert this new case directly AFTER that test's closing `  });`, before
`  it('NEVER leaks an internal/landlord/contact field (allowlist wall)'`:

```ts
  it('flyer-leads D1: a fully filled property publishes NONE of the ten trimmed keys - absent, never null', () => {
    const flyer = toUnitFlyer(fullUnit());
    for (const key of TRIMMED_FLYER_KEYS) {
      expect(key in flyer, key).toBe(false);
    }
    expect(JSON.stringify(flyer)).not.toContain('TRIMMED');
    // A bare unit carries none of them either: no null placeholders.
    const bare = toUnitFlyer({ unitId: 'bare', landlordId: 'll', status: 'available' });
    for (const key of TRIMMED_FLYER_KEYS) {
      expect(key in bare, key).toBe(false);
    }
  });

```

(iv) The leak wall. Anchor
`      'credit_requirements', 'income_requirements', 'qualifications', 'deposit_notes',`
followed by `    ]) {`. Insert between them:

```ts
      // flyer-leads D1 (2026-10-21): staff only, removed from the projection
      ...TRIMMED_FLYER_KEYS,
```

(v) The bare-unit test
(`it('falls each absent field to null (not undefined) and address to {}'`):
- delete the four lines `expect(flyer.pets).toBeNull();`,
  `expect(flyer.accessibility).toBeNull();`, `expect(flyer.deposit).toBeNull();`
  and `expect(flyer.lease_terms).toBeNull();`;
- replace the comment
  `    // spec 2026-10-20 D11: the added keys - checkboxes read false, the list [].`
  with `    // spec 2026-10-20 D11: the added keys that stay - the list [].`;
- delete the four lines `expect(flyer.no_pets).toBe(false);`,
  `expect(flyer.pet_fee).toBeNull();`,
  `expect(flyer.deposit_one_month).toBe(false);` and
  `expect(flyer.deposit_flexible).toBe(false);`.

The test ends with `expect(flyer.voucher_sizes)...`,
`expect(flyer.voucher_size)...` and `expect(flyer.washer_dryer).toBeNull();`.

(vi) Replace the whole case
`it('reads pets through the D1 interpretation (spec 2026-10-20): details text + No pets', () => { ... });`
(lines 724-740) with:

```ts
  it('flyer-leads D1: the Pets item never ships, whatever its stored shape (a legacy boolean too)', () => {
    for (const pets of [true, false, 'No pets', ' service animals only ', '   ']) {
      const flyer = toUnitFlyer(fullUnit({ pets, no_pets: true, pet_fee: '$300' }));
      for (const key of ['pets', 'no_pets', 'pet_fee']) {
        expect(key in flyer, `${JSON.stringify(pets)} ${key}`).toBe(false);
      }
    }
  });
```

(vii) Replace the whole case
`it('projects the Deposit item: one month, a fixed amount, flexible - never its notes (D11)', () => { ... });`
(lines 794-820) with:

```ts
  it('flyer-leads D1: the Deposit item never ships - not the amount, one month, flexible or the notes', () => {
    const bare: UnitItem = { unitId: 'd', landlordId: 'll', status: 'available' };
    const variants: Partial<UnitItem>[] = [
      { deposit_one_month: true },
      { deposit: 1400, deposit_flexible: true },
      { deposit_flexible: true },
      { deposit: 0 },
      { deposit_notes: 'SECRET split it' },
    ];
    for (const variant of variants) {
      const flyer = toUnitFlyer({ ...bare, ...variant });
      for (const key of ['deposit', 'deposit_one_month', 'deposit_flexible', 'deposit_notes']) {
        expect(key in flyer, `${JSON.stringify(variant)} ${key}`).toBe(false);
      }
      expect(JSON.stringify(flyer)).not.toContain('SECRET');
    }
  });
```

(viii) Replace the case
`it('reads both money fields through the D1 read: a stored negative amount projects null (D1, D11)', () => {`
(827-834) AND the case that follows it,
`it('projects the pet fee trimmed, null when blank (D11)', () => {`
(836-839, which is deleted), with:

```ts
  it('reads the application fee through the D1 read: a stored negative amount projects null (D1, D11)', () => {
    // A negative amount was never writable (the validator's >= 0), so only bad
    // raw data can hold one. The registry read (unitItemValue) treats it as
    // blank, so the flyer must not publish it as "$-50". The deposit is not on
    // the flyer at all (flyer-leads D1).
    const flyer = toUnitFlyer(fullUnit({ application_fee: -50, deposit: -1400 }));
    expect(flyer.application_fee).toBeNull();
    expect('deposit' in flyer).toBe(false);
  });
```

Leave every other case in the describe unchanged: voucher sizes, legacy
address, subzone, the application-fee PIN, and washer / dryer. The
`type UnitFlyer` import stays, because the exact-shape test still uses it.
Line 540, "(PIN) area, notes, lease_terms, utilities and accessibility keep
the plain string kind", also stays unchanged: the validator does not change.

**1f. `app/test/publicIntake.test.ts`, the flyer route.**

(i) `seedFullUnit`. Anchor (lines 281-282):
`      deposit: 1400,` + newline + `      lif: 500,`. Insert after `      lif: 500,`:

```ts
      // flyer-leads D1 (2026-10-21): the rest of the ten trimmed keys, so the
      // allowlist test below proves a FULLY filled property publishes none.
      lease_terms: 'TRIMMED 12-month minimum',
      accessibility: 'TRIMMED ground floor',
      pets: 'TRIMMED cats ok',
      no_pets: true,
      pet_fee: 'TRIMMED $300',
      deposit_one_month: true,
      deposit_flexible: true,
```

(ii) In `it('returns ONLY the allowlisted flyer fields (internal fields absent)'`,
delete the two `toMatchObject` lines `      rent_min: 1400,` and
`      rent_max: 1600,` (320-321). The object ends with
`listing_link: 'https://example.com/listing/1',`.

(iii) In the same test, replace the block from
`    // The flyer shape carries the full public allowlist + media + contact_number`
through its closing `    );` (lines 328-360) with:

```ts
    // The flyer shape carries the public allowlist + media + contact_number and
    // NOTHING beyond it. flyer-leads D1 (2026-10-21): rent, lease terms,
    // accessibility, pets and deposit are staff only again - absent, never null.
    expect(Object.keys(flyer).sort()).toEqual(
      [
        'accepted_authorities',
        'area',
        'baths',
        'beds',
        'listing_link',
        'media',
        'unitId',
        'voucher_size',
        'voucher_sizes',
        'address',
        'utilities',
        'video_url',
        'application_fee',
        'same_day_rta',
        // spec 2026-10-20 D11 (subzone left, D3)
        'washer_dryer',
        'contact_number',
      ].sort(),
    );
    for (const trimmed of [
      'rent_min',
      'rent_max',
      'lease_terms',
      'accessibility',
      'pets',
      'no_pets',
      'pet_fee',
      'deposit',
      'deposit_one_month',
      'deposit_flexible',
    ]) {
      expect(trimmed in flyer, trimmed).toBe(false);
    }
```

(iv) Replace the two comment lines
`    // INTERNAL fields must never appear in the response (address + deposit are`
/ `    // PUBLIC now, so they moved into the exact-keys assertion above).` with:

```ts
    // INTERNAL fields must never appear in the response (the address is public,
    // so it is in the exact-keys assertion above, where the D1 keys are
    // asserted absent too).
```

Then, in the `for (const secret of [` list, insert after `      'Zone 4',`:

```ts
      // flyer-leads D1: no trimmed text value ships either
      'TRIMMED',
```

Do not touch any other describe in this file (S4 owns the housing-fair
blocks), and do not edit the describe line that carries an em dash.

### Step 2 - run RED

From `W:/tmp/flyer-leads/app`:
`npx vitest run test/requirements.test.ts test/propertyFormFlyerParity.test.ts test/unitFields.test.ts test/publicIntake.test.ts`

Expected: exactly these 11 cases fail; everything else passes.
- `requirements.test.ts`:
  - "gives every field its unit key, landlord key, label, kind and flyer
    visibility". Expected `staff_only`, received `on_flyer`.
  - "flyer-leads D2: Application fee is the only requirement field On
    flyer". Received seven keys.
- `propertyFormFlyerParity.test.ts`:
  - "lists every property-form field in form order with its tag ... - 35
    rows". Ten rows differ.
  - "flyer-leads D2: a re-tagged field tagged On flyer again fails the walk
    on every base". 0 mismatches, expected 30.
- `unitFields.test.ts`:
  - "exposes the merged public field set (teaser + reveal +
    tenant-useful)". Extra keys.
  - "flyer-leads D1: a fully filled property publishes NONE of the ten
    trimmed keys - absent, never null". `rent_min` is in flyer.
  - "NEVER leaks an internal/landlord/contact field (allowlist wall)".
    `rent_min` is listed.
  - "flyer-leads D1: the Pets item never ships ...".
  - "flyer-leads D1: the Deposit item never ships ...".
  - "reads the application fee through the D1 read ...". `'deposit' in
    flyer` is true.
- `publicIntake.test.ts`:
  - "returns ONLY the allowlisted flyer fields (internal fields absent)".
    The key list includes `accessibility`, `deposit` and the rest.

The "catches a wrong tag - the walk is not vacuous" case PASSES at this step
(a strengthened PIN). If any OTHER case fails, stop and report.

### Step 3 - implementation

**3a. `app/src/lib/requirements.ts`, the registry.** Anchor (lines 84-97,
exact): the block from `  defineItem('pets', 'Pets', 'Pets', [` through
the Deposit item's closing `  ]),`. Replace it with:

```ts
  // flyer-leads D2 (spec 2026-10-21): every Pets and Deposit field is Staff
  // only - Sam talks them through with each tenant instead of publishing them,
  // and lib/unitFields.ts toUnitFlyer no longer carries them (D1).
  defineItem('pets', 'Pets', 'Pets', [
    defineField('no_pets', 'No pets', 'checkbox', 'staff_only'),
    // The EXISTING unit key. A legacy bare boolean is read (and, on the unit
    // write only, accepted) per D1 - see unitItemValue below.
    defineField('pets', 'Pets (details)', 'text', 'staff_only'),
    defineField('pet_fee', 'Pet fee', 'text', 'staff_only'),
  ]),
  defineItem('deposit', 'Deposit', 'Move-in costs', [
    // "One month's rent" and a fixed amount are ALTERNATIVES (hasDepositConflict).
    defineField('deposit_one_month', "One month's rent", 'checkbox', 'staff_only'),
    defineField('deposit', 'Fixed amount', 'money', 'staff_only'),
    defineField('deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'staff_only'),
    defineField('deposit_notes', 'Deposit notes', 'text', 'staff_only'),
  ]),
```

The Application fee item (`defineField('application_fee', 'Application fee', 'money', 'on_flyer'),`)
stays unchanged.

**3b. `app/src/lib/requirements.ts`, `PROPERTY_FORM_FIELDS`.**
- Anchor `  formField('Rent min', ['rent_min'], 'on_flyer'),` + newline +
  `  formField('Rent max', ['rent_max'], 'on_flyer'),`. Replace with:
  ```ts
  // flyer-leads D2 (spec 2026-10-21): rent, accessibility and lease terms are
  // Staff only (toUnitFlyer no longer carries them, D1).
  formField('Rent min', ['rent_min'], 'staff_only'),
  formField('Rent max', ['rent_max'], 'staff_only'),
  ```
- Anchor `  formField('Accessibility', ['accessibility'], 'on_flyer'),` + newline +
  `  formField('Lease terms', ['lease_terms'], 'on_flyer'),`. Replace with the
  same two lines ending `'staff_only'),`.

**3c. `app/src/lib/unitFields.ts`, the WRITABLE_FIELDS comments.**
- Anchor `  subzone: 'clearable_string',` + newline + `  rent_min: 'number',`.
  Insert between the two lines:
  ```ts
  // The asking rent range. Staff only since flyer-leads D1 (spec 2026-10-21):
  // NEVER on the flyer projection below. Still read by the [Rent] merge field
  // and the similar-properties rent score.
  ```
- Anchor `  // 2026-10-20 D1: clearable money, null REMOVEs). PUBLIC on the flyer.`
  Replace with:
  ```ts
  // 2026-10-20 D1: clearable money, null REMOVEs). Staff only since
  // flyer-leads D1 (spec 2026-10-21): NEVER on the flyer projection below.
  ```
- Anchor `  // Accessibility notes (tenant-useful). PUBLIC on the flyer projection (flyer-full-info).`
  Replace with:
  ```ts
  // Accessibility notes. Staff only since flyer-leads D1 (spec 2026-10-21):
  // NEVER on the flyer projection below.
  ```
- Anchor `  // accepted programs / expected rent - see GLOSSARY). PUBLIC on the flyer`
  + newline + `  // projection below (flyer-full-info 2026-07-16).` Replace with:
  ```ts
  // accepted programs / expected rent - see GLOSSARY). Staff only since
  // flyer-leads D1 (spec 2026-10-21): NEVER on the flyer projection below.
  ```
- Anchor `  // in the new shape at once (the 'pets' case below). PUBLIC on the flyer.`
  Replace with:
  ```ts
  // in the new shape at once (the 'pets' case below). Staff only since
  // flyer-leads D1 (spec 2026-10-21), like the whole Pets item.
  ```

**3d. `app/src/lib/unitFields.ts`, the projection doc comment.**
- Anchor
  `` * credit_requirements, income_requirements, qualifications and deposit_notes.``
  Insert after it:
  ```
   * Since flyer-leads D1 (spec 2026-10-21) also NEVER rent_min, rent_max,
   * lease_terms, accessibility, or any key of the Pets item (pets, no_pets,
   * pet_fee) or the Deposit item (deposit, deposit_one_month, deposit_flexible) -
   * see "Removed keys" below.
  ```
- Anchor (spec D1's "only ADDS keys" comment, lines 375-378, exact):
  ```
   * Older bundles (spec 2026-10-20 D11): a flyer page loaded before #12 keeps
   * reading `voucher_size`, `deposit`, `application_fee` and `pets`, so the
   * projection keeps those keys and only ADDS keys.
   */
  ```
  Replace with:
  ```
   * Older bundles (spec 2026-10-20 D11): a flyer page loaded before #12 reads
   * `voucher_size` and `application_fee`, so the projection keeps those keys.
   *
   * Removed keys (flyer-leads D1, spec 2026-10-21). The projection used to only
   * ADD keys. It now deliberately REMOVES ten: rent_min, rent_max, lease_terms,
   * accessibility, pets, no_pets, pet_fee, deposit, deposit_one_month and
   * deposit_flexible - Sam talks rent, lease terms, accessibility, pets and the
   * deposit through with each tenant instead of publishing them. The keys are
   * ABSENT, never null: "off the flyer" means the public endpoint never returns
   * them. This is safe for old flyer pages: an old bundle fed the new payload
   * would crash on render (its textOrNull(undefined).trim() throws - a white
   * page, never a stray value), but it is never fed it - the page fetches once
   * on load and nothing caches the bundle (the app container serves the
   * dashboard and CloudFront does not cache the default behavior), so the load
   * that fetches the new payload also brings the new bundle. Add no
   * compatibility code for the old page. Removing any OTHER key needs the same
   * argument recorded here.
   */
  ```

**3e. `app/src/lib/unitFields.ts`, `interface UnitFlyer`.**
- Delete `  rent_min: number | null;` and `  rent_max: number | null;` (after
  `  listing_link: string | null;`).
- Delete the 17 lines (406-422) from
  `  /** The Pets item's details text, read per spec D1: a legacy \`true\` reads`
  through `  lease_terms: string | null;`. That covers the doc comments and
  fields of `pets`, `no_pets`, `pet_fee`, `accessibility`, `deposit`,
  `deposit_one_month`, `deposit_flexible` and `lease_terms`.
- `same_day_rta` is then directly followed by the
  `/** Washer / dryer (spec D3) ...` comment and `washer_dryer`.

**3f. `app/src/lib/unitFields.ts`, `toUnitFlyer`.** Anchor (lines 482-489,
exact):

```ts
  // The requirement items through the D1 read interpretation (legacy pets
  // boolean, trimmed text, blank -> null). Only their ON-FLYER keys are copied.
  const pets = unitItemValue(unit, 'pets');
  const deposit = unitItemValue(unit, 'deposit');
  const fee = unitItemValue(unit, 'application_fee')['application_fee'];
  const petsDetails = pets['pets'];
  const petFee = pets['pet_fee'];
  const depositAmount = deposit['deposit'];
```

Replace with:

```ts
  // The Application fee item through the D1 read interpretation (a negative or
  // non-number amount reads blank). Since flyer-leads D1 it is the only
  // requirement item on the flyer.
  const fee = unitItemValue(unit, 'application_fee')['application_fee'];
```

In the returned object, delete these two groups of lines:
- `    rent_min: isFiniteNumber(unit.rent_min) ? unit.rent_min : null,` and
  `    rent_max: isFiniteNumber(unit.rent_max) ? unit.rent_max : null,`;
- the eight lines from `    pets: typeof petsDetails === 'string' ? petsDetails : null,`
  through `    lease_terms: typeof unit.lease_terms === 'string' ? unit.lease_terms : null,`.

`same_day_rta: ...` is then followed by `washer_dryer: ...`. Keep the
`unitItemValue` and `isFiniteNumber` imports and helpers: both are still
used.

**3g. `app/src/repos/unitsRepo.ts`, stale comments (comment-only).**
- `   *  alternative to \`deposit_one_month\`). PUBLIC on the flyer. */` ->
  `   *  alternative to \`deposit_one_month\`). Staff only (flyer-leads D1). */`
- `  /** Accessibility notes <EM-DASH> free-form. */` (line 442; `<EM-DASH>`
  is the real U+2014 character in the file) ->
  `  /** Accessibility notes - free-form. Staff only (flyer-leads D1). */`
  (the em dash becomes an ASCII hyphen). Use the Edit tool, and match
  the line by its text `Accessibility notes` and `free-form`.
- Lease terms. Replace the three lines
  `   * after"). Moved off the landlord contact 2026-07-10 (GLOSSARY). PUBLIC on`
  / `   * the flyer projection (flyer-full-info 2026-07-16; lib/unitFields.ts`
  / `   * toUnitFlyer).` with:
  ```
     * after"). Moved off the landlord contact 2026-07-10 (GLOSSARY). Staff only
     * since flyer-leads D1 (spec 2026-10-21): never on the flyer projection
     * (lib/unitFields.ts toUnitFlyer).
  ```
- Four doc lines lose ` PUBLIC on the flyer.` and gain
  ` Staff only (flyer-leads D1).`:
  - `/** Pets item: "No pets". PUBLIC on the flyer. */`
  - `/** Pets item: "Pet fee" (free text). PUBLIC on the flyer. */`
  - `/** Deposit item: "One month's rent" (an alternative to \`deposit\`). PUBLIC on the flyer. */`
  - `/** Deposit item: "Flexible / payment terms available". PUBLIC on the flyer. */`

  For example, the first becomes
  `/** Pets item: "No pets". Staff only (flyer-leads D1). */`.
- Leave `washer_dryer`'s `PUBLIC on the flyer.` (still true) and the block
  comment `Staff only unless marked PUBLIC.` unchanged.

### Step 4 - run GREEN

From `W:/tmp/flyer-leads/app`:
`npx vitest run test/requirements.test.ts test/propertyFormFlyerParity.test.ts test/unitFields.test.ts test/publicIntake.test.ts`

Expected: 0 failed. The scratch dry run counted 38 cases in
requirements.test.ts, 10 in propertyFormFlyerParity.test.ts and 81 in
unitFields.test.ts; publicIntake keeps its count.

Then from `W:/tmp/flyer-leads`: `npm run typecheck`, which exits 0. It
proves no `app/src` or `app/test` reader still names a removed `UnitFlyer`
key.

### Step 5 - ASCII check

From `W:/tmp/flyer-leads`, run the plan's added-lines command for each file
below. Each prints `0`:
- `app/src/lib/unitFields.ts`
- `app/src/lib/requirements.ts`
- `app/src/repos/unitsRepo.ts`
- `app/test/requirements.test.ts`
- `app/test/propertyFormFlyerParity.test.ts`
- `app/test/unitFields.test.ts`
- `app/test/publicIntake.test.ts`

Example:
`git diff -U0 -- app/src/repos/unitsRepo.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`

### Step 6 - commit

Follow section C. The paths are:

`git add app/src/lib/unitFields.ts app/src/lib/requirements.ts app/src/repos/unitsRepo.ts app/test/requirements.test.ts app/test/propertyFormFlyerParity.test.ts app/test/unitFields.test.ts app/test/publicIntake.test.ts`

Message:
- subject: `feat(flyer): drop rent, lease terms, accessibility, pets and deposit from the public flyer and tag them Staff only (flyer-leads D1, D2)`
- body: `toUnitFlyer no longer carries the ten keys (absent, never null); the "only ADDS keys" comment records the deliberate removal and why old flyer pages are safe. REQUIREMENT_ITEMS and PROPERTY_FORM_FIELDS re-tag Rent min/max, Accessibility, Lease terms and every Pets / Deposit field Staff only; Application fee stays On flyer. The parity walk proves a re-tagged field tagged On flyer again fails. Expected red until S2: dashboard requirementsMirror.test.ts (two cases).`
- trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Task 1.2 - Similar properties compare subzones ignoring case and spacing (spec D9)

Goal: `scoreArea` compares subzones as `s.replace(/\s+/g, '').toUpperCase()`,
so "se11", " SE11 " and "SE 11" all equal "SE11". A value that normalizes to
empty never matches. "SE1" and "SE11" stay different. The area comparison
and the "Same subzone" reason text are unchanged, and no stored value is
rewritten.

Files:
- `app/src/lib/similarUnits.ts`
- `app/test/similarUnits.test.ts`

### Step 1 - tests first

Append a new describe at the END of `app/test/similarUnits.test.ts`, after
the file's final `});`. That `});` closes
`describe('rankSimilarUnits (BE5/C6)'`; the last lines of the file are
`    expect(typeof item.matchPct).toBe('number');` /
`    expect(typeof item.summary).toBe('string');` / `  });` / `});`. The
`unit()` helper and `import type { UnitItem }` already exist at the top of
the file.

```ts

describe('rankSimilarUnits - the subzone ignores case and spacing (flyer-leads D9)', () => {
  // beds 1.0 * 0.35 + same subzone 1.0 * 0.25 = 0.60 -> 60;
  // beds 1.0 * 0.35 + same area 0.6 * 0.25 = 0.50 -> 50.
  const zoneTarget = unit('zone-target', { beds: 2, area: 'East', subzone: 'SE11' });
  const ranked = (target: UnitItem, candidates: UnitItem[]) =>
    rankSimilarUnits(target, candidates, { limit: 10 }).map((u) => [u.unitId, u.matchPct, u.summary]);

  it('"se11", " SE11 ", "SE 11" and a tab-spaced value are the same subzone as "SE11"', () => {
    expect(
      ranked(zoneTarget, [
        unit('z-lower', { beds: 2, area: 'East', subzone: 'se11' }),
        unit('z-outer', { beds: 2, area: 'East', subzone: ' SE11 ' }),
        unit('z-inner', { beds: 2, area: 'East', subzone: 'SE 11' }),
        unit('z-tab', { beds: 2, area: 'East', subzone: 'Se\t1 1' }),
      ]),
    ).toEqual([
      ['z-inner', 60, '2 bed - Same subzone'],
      ['z-lower', 60, '2 bed - Same subzone'],
      ['z-outer', 60, '2 bed - Same subzone'],
      ['z-tab', 60, '2 bed - Same subzone'],
    ]);
  });

  it("normalizes the target's subzone too", () => {
    const messyTarget = unit('messy-target', { beds: 2, area: 'East', subzone: ' se 11 ' });
    expect(ranked(messyTarget, [unit('c', { beds: 2, area: 'East', subzone: 'SE11' })])).toEqual([
      ['c', 60, '2 bed - Same subzone'],
    ]);
  });

  it('a subzone that normalizes to empty never matches, not even another blank one', () => {
    const blankTarget = unit('blank-target', { beds: 2, area: 'East', subzone: '   ' });
    expect(
      ranked(blankTarget, [
        unit('b-spaces', { beds: 2, area: 'East', subzone: '   ' }),
        unit('b-tab', { beds: 2, area: 'East', subzone: ' \t ' }),
        unit('b-empty', { beds: 2, area: 'East', subzone: '' }),
        unit('b-none', { beds: 2, area: 'East' }),
      ]),
    ).toEqual([
      ['b-empty', 50, '2 bed - Same area'],
      ['b-none', 50, '2 bed - Same area'],
      ['b-spaces', 50, '2 bed - Same area'],
      ['b-tab', 50, '2 bed - Same area'],
    ]);
  });

  it('(PIN) no fuzzy matching: "SE1" and "SE111" stay different from "SE11"', () => {
    expect(
      ranked(zoneTarget, [
        unit('c-se1', { beds: 2, area: 'East', subzone: 'SE1' }),
        unit('c-se111', { beds: 2, area: 'East', subzone: 'se 111' }),
      ]),
    ).toEqual([
      ['c-se1', 50, '2 bed - Same area'],
      ['c-se111', 50, '2 bed - Same area'],
    ]);
  });

  it('(PIN) the area comparison is unchanged - still exact, case included', () => {
    const areaTarget = unit('area-target', { beds: 2, area: 'East' });
    expect(
      ranked(areaTarget, [
        unit('a-case', { beds: 2, area: 'east' }),
        unit('a-exact', { beds: 2, area: 'East' }),
      ]),
    ).toEqual([
      ['a-exact', 50, '2 bed - Same area'],
      ['a-case', 35, '2 bed'],
    ]);
  });
});
```

Note on `\t`: the Edit/Write tools may decode `\t` into a literal TAB inside
the two string literals (`'Se\t1 1'` and `' \t '`). Either form is
acceptable: both are whitespace, the RED/GREEN expectations below hold for
both, and the ASCII check allows TAB (`\11`). There is no `\u` in this code.

### Step 2 - run RED

From `W:/tmp/flyer-leads/app`: `npx vitest run test/similarUnits.test.ts`

Expected: 3 failed, and every other case passes.
- "... the same subzone as \"SE11\"": each row reads 50 / "2 bed - Same
  area" (strict equality fails).
- "normalizes the target's subzone too": same reason.
- "a subzone that normalizes to empty never matches ...": `b-spaces` reads
  60 / "Same subzone", because `'   ' === '   '`.

The two (PIN) cases pass.

### Step 3 - implementation

`app/src/lib/similarUnits.ts`. Anchor (lines 52-60, exact):

```ts
/** area: 1.0 same subzone, 0.6 same area (different subzone), else 0. */
function scoreArea(target: UnitItem, c: UnitItem): number {
  if (
    typeof target.subzone === 'string' &&
    target.subzone.length > 0 &&
    target.subzone === c.subzone
  ) {
    return 1;
  }
```

Replace with:

```ts
/**
 * flyer-leads D9: a subzone as the score compares it - EVERY whitespace
 * character removed, then uppercased, so "se11", " SE11 " and "SE 11" are one
 * subzone. Never fuzzy: "SE1" and "SE11" stay different. A non-string reads
 * as '', and '' never matches (scoreArea). Stored values are not rewritten.
 */
function subzoneKey(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : '';
}

/**
 * area: 1.0 same subzone (compared by subzoneKey, flyer-leads D9), 0.6 same
 * area (different subzone; an exact, unchanged comparison), else 0.
 */
function scoreArea(target: UnitItem, c: UnitItem): number {
  const subzone = subzoneKey(target.subzone);
  if (subzone.length > 0 && subzone === subzoneKey(c.subzone)) {
    return 1;
  }
```

The area branch below it
(`if (typeof target.area === 'string' && target.area.length > 0 && target.area === c.area) {`),
`buildSummary` and the header comment block all stay unchanged. Lines 1-10
carry em dashes; do not edit them. `subzoneKey` is private: do not export
it.

### Step 4 - run GREEN

From `W:/tmp/flyer-leads/app`:
`npx vitest run test/similarUnits.test.ts test/unitsApiSimilar.test.ts`

Expected: 0 failed. The scratch run counted 21 cases in
similarUnits.test.ts; `unitsApiSimilar.test.ts` is unchanged and green.

Then from `W:/tmp/flyer-leads`: `npm run typecheck`, which exits 0.

### Step 5 - ASCII check

From `W:/tmp/flyer-leads`, the added-lines command prints `0` for
`app/src/lib/similarUnits.ts` and for `app/test/similarUnits.test.ts`.

### Step 6 - commit

Follow section C. The paths are:

`git add app/src/lib/similarUnits.ts app/test/similarUnits.test.ts`

Message:
- subject: `fix(similar): match subzones ignoring case and spacing (flyer-leads D9)`
- body: `scoreArea compares subzones after removing all whitespace and uppercasing ("se11", " SE11 " and "SE 11" are one subzone); a value that normalizes to empty never matches; no fuzzy matching (SE1 != SE11). The area comparison, the "Same subzone" reason text and stored values are unchanged.`
- trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## S1 exit check (ends with the slice report commit)

1. From `W:/tmp/flyer-leads/app`, with DynamoDB Local up and WITHOUT
   `ALLOW_SKIP_DYNAMO_TESTS`:
   `npx vitest run test/requirements.test.ts test/propertyFormFlyerParity.test.ts test/unitFields.test.ts test/publicIntake.test.ts test/similarUnits.test.ts test/unitsApiSimilar.test.ts`
   Expected: 0 failed.
2. From `W:/tmp/flyer-leads`: `npm run typecheck`. Expected: exit 0.
3. From `W:/tmp/flyer-leads`, the gate-5 shape on S1's own files:
   `npx eslint app/src/lib/unitFields.ts app/src/lib/requirements.ts app/src/lib/similarUnits.ts app/src/repos/unitsRepo.ts app/test/requirements.test.ts app/test/propertyFormFlyerParity.test.ts app/test/unitFields.test.ts app/test/publicIntake.test.ts app/test/similarUnits.test.ts`
   - Expected: no errors.
   - If any appear, attribute them by running the same command at
     `b7959e2a` (AGENTS.md gate 5).
4. In `git log --oneline -3`, the two newest commits are Task 1.2 and then
   Task 1.1. A bare `git status` shows nothing staged and no S1 file modified.
5. Known and EXPECTED red outside S1, until S2 (the next slice, AR4)
   re-tags the mirror. From `W:/tmp/flyer-leads/dashboard`:
   `npx vitest run src/routes/listing/requirementsMirror.test.ts`
   - It fails exactly two cases: "the items, ids and key lists are
     identical" (line 81) and "the D10a property-form table is identical"
     (line 88). Every other case passes.
   - Any OTHER dashboard failure is a regression to diagnose.

   The e2e specs that assert flyer rent / pets / deposit rows
   (`public-pages.spec.ts`, `property-requirements.spec.ts`) are S6's; do not
   run e2e here.
6. **The slice report (plan section 0).** Write
   `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S1-report.md`.
   The `slices/` directory may not exist yet; the Write tool creates it.
   - ASCII, findings only, each citing code by `file:line`.
   - It must at least record:
     - the two expected-red `requirementsMirror.test.ts` cases (:81, :88)
       until S2;
     - anything the tree held that this plan got wrong;
     - any untrimmed typed-input path found in a touched surface.
   - If there is nothing beyond the expected-red pair, say so in one line
     after it.
   - Check: `tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S1-report.md | wc -c`
     prints `0`.

   Then commit it, from `W:/tmp/flyer-leads`:
   1. Run a bare `git status`.
   2. Check MERGE_HEAD as in section C.
   3. `git add docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S1-report.md`,
      then a bare `git status`.
   4. Commit:
      `git commit -m "docs(records): flyer-leads S1 slice report" -m "Findings from building S1 (projection trim, Staff only tags, subzone matching)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

## D. Spec coverage map

| Spec item | Where |
|---|---|
| D1: `toUnitFlyer` / `UnitFlyer` drop the ten keys, absent not null | Task 1.1 Steps 3e, 3f; tests 1e (iii), (vi), (vii), (viii) |
| D1: the public endpoint never returns them (`GET /public/units/:unitId/flyer`) | Task 1.1 test 1f. The route code is unchanged: it spreads the projection (`public.ts:463`) |
| D1: `application_fee` stays, 0 = "No application fee" | Task 1.1: the existing `(PIN) projects the application fee` case, plus 1e (viii) |
| D1: the "only ADDS keys" comment rewritten with the safety reason | Task 1.1 Step 3d |
| D1: the dashboard `PublicFlyer` drops the keys | NOT S1 - S2 |
| D2: `REQUIREMENT_ITEMS` re-tag (Pets x3, Deposit x3) | Task 1.1 Step 3a; test 1a, 1b |
| D2: `PROPERTY_FORM_FIELDS` re-tag (Rent min/max, Accessibility, Lease terms) | Task 1.1 Step 3b; test 1c |
| D2: the parity walk green, its 35-row table changing only for those rows | Task 1.1 test 1c + the existing walk case |
| D2: a deliberately wrong tag still fails the walk | Task 1.1 test 1d (both directions, plus all ten re-tagged rows) |
| D2: the pinned shapes in `requirements.test.ts` / `unitFields.test.ts` | Task 1.1 tests 1a, 1e |
| D2: the dashboard mirror, `TaggedField` note gate, forms, landlord form | NOT S1 - S2, the next slice (AR4; see A.1) |
| D9: subzone normalized (all whitespace removed, uppercased) | Task 1.2 Step 3 |
| D9: blank never matches; SE1 vs SE11 differ | Task 1.2 tests (blank case; PIN fuzzy case) |
| D9: area comparison and reason text unchanged | Task 1.2 PIN case + the reason text asserted in every row |
| D10: whitespace - report untrimmed paths in touched surfaces | The slice report (exit check 6); A.2 withdrawn (AR16) |
| Plan section 0: the slice report | S1 exit check 6 |
| Spec section 4 "app tests: the parity test, unitFields.test.ts, requirements.test.ts" | Task 1.1 |
| Spec section 4 "Similar properties (D9): similarUnits.ts scoreArea and its tests" | Task 1.2 |
| Spec section 5 "Projection" (three bullets) | Task 1.1 |
| Spec section 5 "Subzone" | Task 1.2 |
| Stale "PUBLIC on the flyer" comments (app) | Task 1.1 Steps 3c, 3g |

## E. Notes for other slices

- **S2 (dashboard):** the mirror must make the SAME ten re-tags as Task 1.1,
  with labels, keys and order unchanged:
  - `REQUIREMENT_ITEMS`: no_pets, pets, pet_fee, deposit_one_month, deposit
    and deposit_flexible become `staff_only`;
  - `PROPERTY_FORM_FIELDS`: Rent min, Rent max, Accessibility and Lease
    terms become `staff_only`.

  `requirementsMirror.test.ts` compares data by `toEqual`, not comments, so
  S2's comment text is free. Two more facts for S2:
  - After S1 the flyer route returns exactly these 16 keys, which
    `PublicFlyer` should mirror (`contact_number` is added by the route, not
    the projection): `accepted_authorities, address, application_fee, area,
    baths, beds, contact_number, listing_link, media, same_day_rta, unitId,
    utilities, video_url, voucher_size, voucher_sizes, washer_dryer`.
  - After S1 the only requirement field On flyer is `application_fee`, so
    S2's landlord-form "On property flyers" tag lands only on the
    application-fee pair by construction.
- **S4 (handler):** S4 also edits `app/test/publicIntake.test.ts` (the
  `POST /public/housing-fair` describes) and `app/src/routes/public.ts`.
  S1 touches ONLY the `GET /public/units/:unitId/flyer` describe
  (`seedFullUnit` and the allowlist case, ~lines 266-380) and does not touch
  `public.ts`. Re-read the current text before applying S4 edits, and never
  revert S1's.
- **S6 (e2e and docs):** after S1 + S2 the flyer shows no rent, deposit, pets,
  pet fee, accessibility or lease rows. Only Rent min / Rent max,
  Accessibility, Lease terms and the Pets / Deposit fields change tag; the
  forms show Staff only on exactly those fields. GLOSSARY's "staff only"
  wording for lease terms, pets and deposit is S6's.
- **Names created (all private / test-local; nothing exported):**
  - `subzoneKey(v: unknown): string` in `app/src/lib/similarUnits.ts`
    (private);
  - `TRIMMED_FLYER_KEYS` (test-local, in `unitFields.test.ts`).

  No binding interface from plan section 2 is created or consumed by S1.
- **Unchanged on purpose:**
  - the `[Rent]` merge field (`lib/mergeFields.ts:36-37`, spec "Out of
    scope");
  - `validateUnitBody` kinds: every trimmed key stays WRITABLE (spec: "All
    of those fields stay in the system");
  - `app/src/lib/seed/*` values;
  - `app/test/unitsApiSimilar.test.ts`.

## 6. S2 - Dashboard: mirror, note gate, form props, PublicFlyer, FlyerPage (Tasks 2.x)

Slice S2 of `docs/superpowers/plans/2026-10-21-flyer-leads-plan.md` (plan
section 6). Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`
rev 6 - D1 (dashboard type), D2 (dashboard side), D3 (all of it).
Depends on S1 (the app tag table values). Build order (AR4):
S1 -> S2 -> S3 -> S4 -> S5 -> S6, so S2's commits sit directly on top of
S1's. Six tasks, 2.1 - 2.6, then the slice report (exit check).

## A. CONTRACT ISSUES (all ruled at assembly - kept for the record)

1. **Cross-slice red window on the dashboard suite - RULED (AR4): S2 runs
   right after S1.**
   `dashboard/src/routes/listing/requirementsMirror.test.ts:18` imports the
   APP module (`import * as app from '../../../../app/src/lib/requirements.js'`)
   and asserts `expect(mirror.REQUIREMENT_ITEMS).toEqual(app.REQUIREMENT_ITEMS)`
   (:81) and `expect(mirror.PROPERTY_FORM_FIELDS).toEqual(app.PROPERTY_FORM_FIELDS)`
   (:88), so it is RED from S1's app re-tag commit until Task 2.2 lands.
   With S2 next in the build order, that window is S2's own Tasks 2.1 - 2.2
   only. Task 2.2's precheck still stops the builder if S1 has NOT landed.
2. **Area whitespace - RULED (AR5, AR16): the display-time trim is
   ACCEPTED.** `toUnitFlyer` copies the stored `area` as is (:495
   "area: typeof unit.area === 'string' ? unit.area : null,"). S2 now prints
   the area as the h1 fallback and as the line under the heading, so Task 2.4
   makes `neighborhood()` return the TRIMMED area (blank -> null) - a
   defensive display guard (it changes no stored data). That also trims the
   unchanged tap-to-text prefill's fallback word (whitespace only; the
   wording is unchanged) - AR5: the D10 rule applied. Task 2.4 step 3(a) is
   binding as written.
   No untrimmed stored path (AR16): `app/src/app.ts:146` mounts
   `trimJsonBody()` (`app/src/middleware/trimStrings.ts:43-50`), which
   deep-trims every string in every JSON body before any route, so every
   dashboard write - the Edit form's raw `utilities`, `accessibility`,
   `lease_terms`, `listing_link`, `video_url` included
   (`ListingEditForm.tsx:182-186`) - is stored trimmed. The Edit form's raw
   (untrimmed) comparison can only add a harmless no-op field to a PATCH.
   S2 builds nothing for it.
3. **(info) RULED (AR6): no change.** `interestedPrefill` (`FlyerPage.tsx:108-115`) tests
   `line1 !== ''` untrimmed. Unreachable from a real payload:
   `toUnitFlyer` re-validates the address (`unitFields.ts:478`) and
   `validateAddress` trims and drops blank parts (`app/src/lib/address.ts:69-71`
   "const trimmed = raw.trim(); if (trimmed.length === 0) continue;").
   Spec D3 says the prefill is unchanged, so S2 leaves it.

No binding name, signature or copy in plan sections 1.1 / 2.7 is wrong
against the code: the old sr-only suffix is exactly ` - open in Google Maps`
(`FlyerPage.tsx:345`), the old link's rel is `noreferrer` (:343), the
thank-you heading is `Thanks - you&apos;re all set!` (:447), and the six
detail-row labels read as 1.1 lists them (:362, :367, :373, :403, :409, :419).

## B. Facts the tasks rely on (verified on this worktree @7ac1f2e3)

Tags and note:
- `dashboard/src/routes/listing/TaggedField.tsx:16`
  "export const PUBLIC_FLYER_NOTE = 'Tenants see this on the public flyer.';"
  and :55-60 render the note whenever the prop is set:
  "{publicNote ? (" - no visibility check today.
- `dashboard/src/routes/listing/RequirementsFields.tsx:153` derives the note:
  "publicNote={audience === 'property' && field.kind === 'text' && field.flyer === 'on_flyer'}".
  No source change is needed there: after the re-tag no requirement text
  field is `on_flyer`.
- Hand-set props: `ListingEditForm.tsx:531` (Tenant-paid utilities - STAYS),
  :545 "<TaggedField label=\"Accessibility\" visibility={formFieldVisibility('Accessibility')} audience=\"property\" publicNote>",
  :558 the same for "Lease terms"; `UnitCreateForm.tsx:666` (utilities -
  STAYS), :680 Accessibility, :693 Lease terms.
- Every form tag is looked up by label from the mirror:
  `requirementForm.ts:206-210` `formFieldVisibility(label)` reads
  `PROPERTY_FORM_FIELDS`. The form tests' tag `it.each` cases are generated
  from the same table (`ListingEditForm.test.tsx:615`,
  `UnitCreateForm.test.tsx:1022`, `RequirementsFields.test.tsx:73-88`), so
  they follow the re-tag by construction - which is why each task below adds
  EXPLICIT pins.
- Dashboard mirror today (`dashboard/src/routes/listing/requirements.ts`):
  :100-102 "field('no_pets', 'No pets', 'checkbox', 'on_flyer')," /
  "field('pets', 'Pets (details)', 'text', 'on_flyer')," /
  "field('pet_fee', 'Pet fee', 'text', 'on_flyer'),";
  :110-112 "field('deposit_one_month', \"One month's rent\", 'checkbox', 'on_flyer')," /
  "field('deposit', 'Fixed amount', 'money', 'on_flyer')," /
  "field('deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'),";
  FORM_FIELD_LIST :261-262 Rent min / Rent max, :268-269 Accessibility /
  Lease terms, :278-283 the six Pets / Deposit rows, all `'on_flyer'`;
  :285-286 the application-fee pair `'on_flyer'` (stays).
- App table S1 re-tags (`app/src/lib/requirements.ts`): :85-95 the same six
  requirement fields; :535-536 Rent min / max; :542-543 Accessibility /
  Lease terms; the requirement form rows are DERIVED from REQUIREMENT_ITEMS
  (:510-517 `REQUIREMENT_FORM_FIELDS`). After S1 every one of those reads
  `'staff_only'`; the application-fee pair stays `'on_flyer'` (plan 1, D2).
- Pinned shapes in `dashboard/src/routes/listing/requirements.test.ts`:
  :41-57 (item fields with flyer) and :224-262 (35 form rows with flyer).
- Landlord form: `ContactEditForm.tsx:1016-1018` "<legend
  className={styles.label}>Requirements / Qualifications</legend>" then
  `<FlyerLegend audience="landlord" />` and `<RequirementsFields`; its test
  describe is `ContactEditForm.test.tsx:1435`, helper `fieldset()` :1443,
  first case :1445-1457, next case "never shows the fieldset for a tenant"
  :1459.
- `FlyerTag.tsx:21-24`: staff_only -> 'Staff only'; on_flyer -> 'On flyer'
  (property) / 'On property flyers' (landlord). Legend lines :35-43 are
  unchanged by this slice.

Public flyer:
- `dashboard/src/routes/public/publicApi.ts:28-66` `PublicFlyer`; the ten D1
  keys are :45-46 (`rent_min`, `rent_max`), :52-62 (`pets`, `no_pets`,
  `pet_fee`, `accessibility`, `deposit`, `deposit_one_month`,
  `deposit_flexible`), :64 (`lease_terms`). `PublicAddress` is exported
  (:16-22). `getFlyer` only casts the JSON (:89-95): stale keys are never
  stripped, the page just never reads them.
- `PublicFlyer` is read ONLY by `FlyerPage.tsx` and `FlyerPage.test.tsx`
  (grep `PublicFlyer` over `dashboard/src` and `e2e`). `publicApi.test.ts`
  reads none of the keys. The staff-side `UnitItem` readers of rent / pets /
  deposit / lease (ListingDetail, listingFormat, resolveTemplate's `[Rent]`,
  requirement cards) are unchanged: the fields stay in the system (spec
  goal 1; `[Rent]` out of scope).
- `FlyerPage.tsx`: `rentRange` :47-53; `neighborhood` :55-59; `addressLines`
  :82-87; `mapsHref` :89-105 (null iff every part is blank - it filters
  `p.trim() !== ''`); `interestedPrefill` :107-115; `textOrNull` :126-131;
  `petsLabel` :133-140; `flyerMoney` :142-147; `depositLabel` :149-159;
  `applicationFeeLabel` :161-165 (uses `flyerMoney`). Ready-state consts
  :276-291; h1 :302 "<h1 className={styles.title}>{hood ?? 'A home for you'}</h1>";
  rent fact :315-319; authority line :329-331 "<p
  className={styles.authorities}>Accepts: {flyer.accepted_authorities.join(', ')}</p>";
  `<dl>` :333-427 with rows Address :334-352, Deposit :353-358, Application
  fee :359-364, Tenant pays :365-370, Washer / dryer :371-376, Pets :377-382,
  Pet fee :383-388, Accessibility :389-394, Lease terms :395-400, Same-day
  RTA :401-406, Video tour :407-416, Listing :417-426. After removing the
  five requirement rows and Address, the remaining order ALREADY matches
  1.1 (Application fee, Tenant pays, Washer / dryer, Same-day RTA, Video
  tour, Listing). CTA copy :444-460: "We&apos;ve got your info and a team
  member will be in touch." (:450), "<h2 className={styles.title}>Interested
  in this home?</h2>" (:455, form variant), "Share your info and a team
  member will reach out about this home." (:457), "<IntakeForm
  onSubmit={handleIntakeSubmit} submitLabel=\"I'm interested\" />" (:459).
  The ?cta=text heading (:433) is the SAME words and stays.
- `IntakeForm.tsx:24-25,44,290`: `submitLabel?: string` (default 'Send my
  info') is the submit button's text. No heading or other button inside.
- `FlyerPage.module.css`: `.title` :20-25 (also used by the CTA h2s and the
  unavailable h1); `.authorities` :64-67 "font-size: var(--fs-sm); color:
  var(--c-text-muted);"; `.srOnly` :117-128. Body text is `--fs-md`
  (`dashboard/src/index.css:21` "font-size: var(--fs-md);"); tokens
  `dashboard/src/ui/tokens.css`: --fs-md 0.9375rem, --fs-lg 1.125rem,
  --fs-xl 1.5rem, --fw-semibold 600, --fw-bold 700, --c-text #1a1d23,
  --c-text-muted, --c-brand #1f6feb, --c-brand-soft #e7f0fe,
  --radius-pill, --sp-1..; no dark theme. Global `a:hover` underlines
  (`index.css:42-44`); `h1, h2, h3, h4, p { margin: 0; }` (:29-35).
- Vitest runs with `css: false` (`dashboard/vite.config.ts:147`): a CSS
  module import is a proxy and `styles.foo` is a stable `_foo_<hash>`
  string, so `toHaveClass(styles.foo!)` works (precedent
  `StatChips.test.tsx:113`), but no test can measure layout. Precedent for
  CSS source pins: `dashboard/src/routes/inbox/InboxRow.styles.test.ts`
  (reads the `.module.css` with `readFileSync`, strips comments, matches a
  top-level rule).
- Type pins: `expectTypeOf` precedent `dashboard/src/api/types.test.ts:382`;
  `expect-type` 1.3.0 has `toBeNever` (vitest 3.2.6). Vitest strips types,
  so a type pin is RED/GREEN only under `npm run typecheck`
  (`dashboard/package.json:10` "tsc -p tsconfig.json --noEmit"; the
  tsconfig includes `src`, tests included).
- Accessible names, checked in jsdom with the repo's own
  `dom-accessibility-api`: `<a ...><h1>88 Sycamore St</h1><span>Decatur, GA
  30030</span><span> - open in Google Maps</span></a>` -> link name
  "88 Sycamore St Decatur, GA 30030 - open in Google Maps", heading name
  "88 Sycamore St"; with no second line the link name is
  "Decatur, GA - open in Google Maps" (single spaces).
- ASCII: pre-existing non-ASCII bytes in touched files (use the DIFF check
  on these): `FlyerPage.tsx` 3 ("Loading..." ellipsis :239),
  `publicApi.ts` 15, `ListingEditForm.test.tsx` 3, `UnitCreateForm.test.tsx`
  87, `ContactEditForm.test.tsx` 36. Every other touched file is pure ASCII
  today.
- Lint baseline (`npx eslint` on every file S2 touches, 2026-10-21): ONLY
  `FlyerPage.tsx` reports, 2 pre-existing `react-hooks/set-state-in-effect`
  errors - `setVariant(...)` in the cta effect (:192) and
  `setStage({ kind: 'unavailable', contactNumber: null })` in the unit
  effect (:210). Line numbers move with this slice; compare by message.
- Dashboard vitest needs NO DynamoDB. The dashboard workspace name is
  `@housingchoice/dashboard`.

## C. Commands used by every task

Bash (Git Bash); every command names its directory. Never pipe a test or
gate command. Never run e2e in this slice (S6). Never touch :5174 / :8080.

- Dashboard tests (from the dashboard workspace):
  `cd "W:/tmp/flyer-leads/dashboard" && npx vitest run <src/... paths>`
- Dashboard typecheck (from the worktree root):
  `cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard`
- ASCII, pre-existing file, BEFORE `git add` (prints 0):
  `cd "W:/tmp/flyer-leads" && git diff -U0 -- <FILE> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
- ASCII, new file (prints 0):
  `cd "W:/tmp/flyer-leads" && tr -d '\11\12\15\40-\176' < <FILE> | wc -c`
- Commit preamble (two separate commands, read both):
  `cd "W:/tmp/flyer-leads" && git status`
  `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD" && echo "MERGE_HEAD PRESENT - STOP" || echo "no MERGE_HEAD"`
  then `cd "W:/tmp/flyer-leads" && git add <explicit paths>` and the task's
  `git commit` command, which passes the message as REPEATED `-m` arguments
  (plan 0: never a message file inside the worktree). Each `-m` argument is
  single-quoted, and the message texts below contain no apostrophe, so they
  paste as written; the trailer is the last `-m`.

---

## Task 2.1 - TaggedField shows the public note only on an On flyer field

Goal: the "Tenants see this on the public flyer." note renders only when
`visibility === 'on_flyer'`, whatever `publicNote` says (spec D2 last
bullet; plan 1 D2, 2.7).

Files: `dashboard/src/routes/listing/TaggedField.tsx`,
`dashboard/src/routes/listing/TaggedField.test.tsx`.

### Step 1 - tests first

In `TaggedField.test.tsx`, inside `describe('TaggedField', () => {`, insert
after the case ending
"      'On flyer Tenants see this on the public flyer.',\n    );\n  });":

```tsx
  it('a Staff only field never shows the public note, even with publicNote set (flyer-leads D2)', () => {
    render(
      <TaggedField label="Lease terms" visibility="staff_only" audience="property" publicNote>
        {(control) => <input {...control} />}
      </TaggedField>,
    );
    expect(screen.queryByText(PUBLIC_FLYER_NOTE)).toBeNull();
    // ... and the control is described by its tag alone.
    expect(screen.getByLabelText('Lease terms')).toHaveAccessibleDescription('Staff only');
  });
```

Also (cosmetic, keeps the examples true after D2): in the case
"a public free-text box also says tenants see it, in its description too"
replace both `Lease terms` strings with `Tenant-paid utilities`
(`label="Tenant-paid utilities"` and
`screen.getByLabelText('Tenant-paid utilities')`); in the case
"on the landlord form the public tag reads On property flyers" replace both
`Pet fee` strings with `Application fee`.

### Step 2 - RED

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/listing/TaggedField.test.tsx`
Expected: exactly the new case fails - `expect(received).toBeNull()`
received the `<p>` with the note (the prop alone renders it today).

### Step 3 - implementation (`TaggedField.tsx`)

(a) Anchor :14-16
```
/** D10: under each public free-text box (pets details, pet fee, tenant-paid
 *  utilities, accessibility, lease terms). */
```
replace with
```
/** D10: under each public free-text box. flyer-leads D2: only On flyer
 *  fields carry it (today Tenant-paid utilities alone); TaggedField never
 *  shows it on a Staff only field. */
```
(b) Anchor :28 "  /** Show PUBLIC_FLYER_NOTE under the control (and describe the control by it). */"
replace with
```
  /** Show PUBLIC_FLYER_NOTE under the control (and describe the control by
   *  it) - only when `visibility` is 'on_flyer' (flyer-leads D2). */
```
(c) Anchor
```
  const noteId = `${uid}-note`;
  return (
```
replace with
```
  const noteId = `${uid}-note`;
  // flyer-leads D2: the note follows the TAG, never the prop alone, so a
  // hand-set prop can never again say tenants see a Staff only field.
  const showNote = publicNote && visibility === 'on_flyer';
  return (
```
(d) Anchor
"      {children({ id: controlId, 'aria-describedby': publicNote ? `${tagId} ${noteId}` : tagId })}\n      {publicNote ? ("
replace with
"      {children({ id: controlId, 'aria-describedby': showNote ? `${tagId} ${noteId}` : tagId })}\n      {showNote ? ("

### Step 4 - GREEN

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/listing/TaggedField.test.tsx src/routes/listing/RequirementsFields.test.tsx src/routes/listing/ListingEditForm.test.tsx src/routes/listing/UnitCreateForm.test.tsx`
All green (before Task 2.2 every field passing `publicNote` is still
On flyer, so nothing else moves).

### Step 5 - ASCII

`tr -d '\11\12\15\40-\176' < dashboard/src/routes/listing/TaggedField.tsx | wc -c` and the same for
`TaggedField.test.tsx` -> 0 (both are pure ASCII files).

### Step 6 - commit

After the section C preamble:
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/listing/TaggedField.tsx dashboard/src/routes/listing/TaggedField.test.tsx
cd "W:/tmp/flyer-leads" && git commit -m 'feat(dashboard): show the public flyer note only on an On flyer field (flyer-leads D2)' -m 'TaggedField renders "Tenants see this on the public flyer." only when the visibility of the field is on_flyer, whatever publicNote says, so a hand-set prop can no longer drift from the tag (spec 2026-10-21 D2, plan 2.7).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## Task 2.2 - The dashboard mirror re-tags as D2; forms and landlord form follow

Goal: the mirror's REQUIREMENT_ITEMS and PROPERTY_FORM_FIELDS re-tag the
trimmed fields Staff only, exactly as S1 did the app (spec D2; plan 2.7);
the hand-set Accessibility / Lease terms notes go; both property forms and
the landlord form are pinned.

Files: `dashboard/src/routes/listing/requirements.ts`,
`dashboard/src/routes/listing/requirements.test.ts`,
`dashboard/src/routes/listing/RequirementsFields.test.tsx`,
`dashboard/src/routes/listing/ListingEditForm.tsx`,
`dashboard/src/routes/listing/ListingEditForm.test.tsx`,
`dashboard/src/routes/listing/UnitCreateForm.tsx`,
`dashboard/src/routes/listing/UnitCreateForm.test.tsx`,
`dashboard/src/routes/contact/ContactEditForm.test.tsx`.
(Not touched: `requirementsMirror.test.ts` - it stays as is and goes green.)

### Step 0 - precheck (S1 must be on the branch)

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/listing/requirementsMirror.test.ts`
Expected RED: 2 failures, "the items, ids and key lists are identical" and
"the D10a property-form table is identical (...)", each a `toEqual` diff of
`"flyer": "on_flyer"` (mirror) vs `"staff_only"` (app). If it is GREEN,
STOP: S1's app re-tag is not on this branch - report and wait.

### Step 1 - tests first

(a) `requirements.test.ts` :48-53 - anchor
```
      ['no_pets', 'req_no_pets', 'No pets', 'checkbox', 'on_flyer'],
      ['pets', 'req_pets', 'Pets (details)', 'text', 'on_flyer'],
      ['pet_fee', 'req_pet_fee', 'Pet fee', 'text', 'on_flyer'],
      ['deposit_one_month', 'req_deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'],
      ['deposit', 'req_deposit', 'Fixed amount', 'money', 'on_flyer'],
      ['deposit_flexible', 'req_deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'],
```
replace each `'on_flyer'` on these six lines with `'staff_only'` (the
`application_fee` line below stays `'on_flyer'`).

(b) `requirements.test.ts` :231-232, :238-239, :248-253 - in the
`PROPERTY_FORM_FIELDS` table change to `'staff_only'` exactly these rows:
`['Rent min', ...]`, `['Rent max', ...]`, `['Accessibility', ...]`,
`['Lease terms', ...]`, `['No pets', ...]`, `['Pets (details)', ...]`,
`['Pet fee', ...]`, `["One month's rent", ...]`, `['Fixed amount', ...]`,
`['Flexible / payment terms available', ...]`. `No application fee` and
`Application fee` stay `'on_flyer'`.

(c) `RequirementsFields.test.tsx` :84-87 - anchor
```
    // D10: only the PROPERTY forms' public free-text boxes (pets details, pet
    // fee) say tenants see them; a landlord value reaches a flyer only once it
    // is copied to a property (D9; planner ruling PR-2, code review PC-1).
```
replace with
```
    // D10: only the PROPERTY forms' public free-text boxes say tenants see
    // them; a landlord value reaches a flyer only once it is copied to a
    // property (D9; planner ruling PR-2, code review PC-1). flyer-leads D2:
    // no requirement text field is On flyer any more, so none carries it.
```
Then insert, after the case ending
"    expect(describedTexts(box)).toContain(TAGS[audience].on_flyer);\n  });" (:95):
```tsx
  it.each(['property', 'landlord'] as const)(
    '%s form: every Pets and Deposit field reads Staff only, and no requirement field carries the public note (flyer-leads D2)',
    (audience) => {
      render(<Harness audience={audience} />);
      for (const label of [
        'No pets',
        'Pets (details)',
        'Pet fee',
        "One month's rent",
        'Fixed amount',
        'Flexible / payment terms available',
        'Deposit notes',
      ]) {
        expect(describedTexts(screen.getByLabelText(label)), label).toEqual(['Staff only']);
      }
      expect(screen.queryByText(PUBLIC_NOTE)).toBeNull();
      // The application-fee pair is the only public requirement left.
      expect(describedTexts(screen.getByLabelText('No application fee'))).toEqual([TAGS[audience].on_flyer]);
      expect(describedTexts(screen.getByLabelText('Application fee'))).toEqual([TAGS[audience].on_flyer]);
    },
  );
```

(d) `ListingEditForm.test.tsx` :648-656 - anchor the whole case
```
  it('the public free-text boxes say tenants see them; staff-only boxes do not', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const label of ['Tenant-paid utilities', 'Accessibility', 'Lease terms', 'Pets (details)', 'Pet fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(PUBLIC_NOTE);
    }
    for (const label of ['Notes', 'Subzone', 'Deposit notes', 'Qualifications', 'Public listing link']) {
      expect(describedTexts(screen.getByLabelText(label)), label).not.toContain(PUBLIC_NOTE);
    }
  });
```
replace with
```tsx
  it('only Tenant-paid utilities says tenants see it; every other box does not (flyer-leads D2)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(describedTexts(screen.getByLabelText('Tenant-paid utilities'))).toContain(PUBLIC_NOTE);
    for (const label of [
      'Accessibility',
      'Lease terms',
      'Pets (details)',
      'Pet fee',
      'Notes',
      'Subzone',
      'Deposit notes',
      'Qualifications',
      'Public listing link',
    ]) {
      expect(describedTexts(screen.getByLabelText(label)), label).not.toContain(PUBLIC_NOTE);
    }
    expect(screen.getAllByText(PUBLIC_NOTE)).toHaveLength(1);
  });

  it('rent, accessibility, lease terms, pets and deposit read Staff only; the fee pair stays On flyer (flyer-leads D2)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const label of [
      'Rent min',
      'Rent max',
      'Accessibility',
      'Lease terms',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]) {
      const texts = describedTexts(screen.getByLabelText(label));
      expect(texts, label).toContain(TAG.staff_only);
      expect(texts, label).not.toContain(TAG.on_flyer);
    }
    for (const label of ['No application fee', 'Application fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(TAG.on_flyer);
    }
  });
```

(e) `UnitCreateForm.test.tsx` :1057-1065 - anchor
```
    for (const label of ['Tenant-paid utilities', 'Accessibility', 'Lease terms', 'Pets (details)', 'Pet fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(PUBLIC_NOTE);
    }
  });
});
```
replace with
```tsx
    // flyer-leads D2: Tenant-paid utilities is the only public free-text box.
    expect(describedTexts(screen.getByLabelText('Tenant-paid utilities'))).toContain(PUBLIC_NOTE);
    for (const label of ['Accessibility', 'Lease terms', 'Pets (details)', 'Pet fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).not.toContain(PUBLIC_NOTE);
    }
    expect(screen.getAllByText(PUBLIC_NOTE)).toHaveLength(1);
  });

  it('rent, accessibility, lease terms, pets and deposit read Staff only; the fee pair stays On flyer (flyer-leads D2)', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    for (const label of [
      'Rent min',
      'Rent max',
      'Accessibility',
      'Lease terms',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]) {
      const texts = describedTexts(screen.getByLabelText(label));
      expect(texts, label).toContain(TAG.staff_only);
      expect(texts, label).not.toContain(TAG.on_flyer);
    }
    for (const label of ['No application fee', 'Application fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(TAG.on_flyer);
    }
  });
});
```
(and rename that case's title, :1057, from
"a legend under the title explains both tags, and the public free-text boxes say tenants see them"
to "a legend under the title explains both tags, and only Tenant-paid utilities says tenants see it").

(f) `ContactEditForm.test.tsx` - insert before
"  it('never shows the fieldset for a tenant', () => {" (:1459):
```tsx
  it('Pets and Deposit read Staff only; On property flyers is only on the application-fee pair (flyer-leads D2)', () => {
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    const group = fieldset();
    for (const label of ['Pets (details)', 'Pet fee', 'Fixed amount', 'Deposit notes']) {
      expect(within(group).getByLabelText(label), label).toHaveAccessibleDescription('Staff only');
    }
    for (const name of ['No pets', "One month's rent", 'Flexible / payment terms available']) {
      expect(within(group).getByRole('checkbox', { name }), name).toHaveAccessibleDescription('Staff only');
    }
    expect(within(group).getByRole('checkbox', { name: 'No application fee' })).toHaveAccessibleDescription(
      'On property flyers',
    );
    expect(within(group).getByLabelText('Application fee')).toHaveAccessibleDescription('On property flyers');
    // Exactly that pair: the legend line starts "On property flyers - ..."
    // and so is not an exact match - only the two TAGS are.
    expect(within(group).getAllByText('On property flyers')).toHaveLength(2);
    // The landlord legend is unchanged (spec D2).
    expect(group).toHaveTextContent(/tenants see it once it is copied to a property/);
  });
```

### Step 2 - RED

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/listing/requirementsMirror.test.ts src/routes/listing/requirements.test.ts src/routes/listing/RequirementsFields.test.tsx src/routes/listing/ListingEditForm.test.tsx src/routes/listing/UnitCreateForm.test.tsx src/routes/contact/ContactEditForm.test.tsx`
Expected failures, all for "the mirror still says on_flyer":
- requirementsMirror: the 2 Step 0 cases;
- requirements.test: "gives every field its unit key, ..." and "lists every
  New / Edit property-form field in form order with its tag";
- RequirementsFields: the 2 new `%s form: every Pets and Deposit field ...`
  cases (`No pets` described by 'On flyer' / 'On property flyers');
- ListingEditForm: the 2 new / replaced cases (Accessibility still carries
  the note; Rent min reads 'On flyer');
- UnitCreateForm: the replaced legend case and the new tag case;
- ContactEditForm: the new case (`Pets (details)` described by 'On property
  flyers'; 8 tags, not 2).

### Step 3 - implementation

(a) `requirements.ts` (dashboard) :100-102 and :110-112: in these six
`field(...)` calls change the last argument `'on_flyer'` to `'staff_only'`
(no_pets, pets, pet_fee, deposit_one_month, deposit, deposit_flexible).
`application_fee` (:120) stays `'on_flyer'`.

(b) `requirements.ts` FORM_FIELD_LIST: change `flyer: 'on_flyer'` to
`flyer: 'staff_only'` on exactly these rows: :261 Rent min, :262 Rent max,
:268 Accessibility, :269 Lease terms, :278 No pets, :279 Pets (details),
:280 Pet fee, :281 One month's rent, :282 Fixed amount, :283 Flexible /
payment terms available. :285-286 (the fee pair) stay.

(c) `requirements.ts` - anchor the comment line
" *  PROPERTY_FORM_FIELDS, rows and key lists included (as the app's). */" (:254)
replace with
```
 *  PROPERTY_FORM_FIELDS, rows and key lists included (as the app's).
 *  flyer-leads D2 (spec 2026-10-21): Rent min / max, Accessibility, Lease
 *  terms and every Pets and Deposit field are Staff only - the public flyer
 *  no longer carries them (D1). */
```

(d) `ListingEditForm.tsx` :545 - anchor
"        <TaggedField label=\"Accessibility\" visibility={formFieldVisibility('Accessibility')} audience=\"property\" publicNote>"
replace with
"        <TaggedField label=\"Accessibility\" visibility={formFieldVisibility('Accessibility')} audience=\"property\">"
and :558 - anchor
"        <TaggedField label=\"Lease terms\" visibility={formFieldVisibility('Lease terms')} audience=\"property\" publicNote>"
replace with
"        <TaggedField label=\"Lease terms\" visibility={formFieldVisibility('Lease terms')} audience=\"property\">"

(e) `UnitCreateForm.tsx` :680 and :693 - the same two edits (identical
anchor text in this file). The Tenant-paid utilities `publicNote` (:531 /
:666) STAYS in both forms.

(Why (d)/(e) cannot be RED on their own: after (a)-(b) the Task 2.1 gate
already hides these notes. They are dead props; removing them is the
spec's "Remove now-wrong hand-set publicNote props".)

### Step 4 - GREEN

The Step 2 command: all green. Also the rest of the listing / contact
folders, which read the mirror:
`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/listing src/routes/contact`
and `cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard` (exit 0).

### Step 5 - ASCII

Pure-ASCII files (`requirements.ts`, `requirements.test.ts`,
`RequirementsFields.test.tsx`, `ListingEditForm.tsx`, `UnitCreateForm.tsx`):
the new-file command prints 0. `ListingEditForm.test.tsx`,
`UnitCreateForm.test.tsx`, `ContactEditForm.test.tsx`: the diff command
prints 0.

### Step 6 - commit

After the section C preamble:
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/listing/requirements.ts dashboard/src/routes/listing/requirements.test.ts dashboard/src/routes/listing/RequirementsFields.test.tsx dashboard/src/routes/listing/ListingEditForm.tsx dashboard/src/routes/listing/ListingEditForm.test.tsx dashboard/src/routes/listing/UnitCreateForm.tsx dashboard/src/routes/listing/UnitCreateForm.test.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx
cd "W:/tmp/flyer-leads" && git commit -m 'feat(dashboard): re-tag rent, accessibility, lease terms, pets and deposit Staff only (flyer-leads D2)' -m 'The dashboard mirror of the D10a tag table and the requirement registry follows the app (S1): Rent min / max, Accessibility, Lease terms and every Pets and Deposit field are Staff only; the application-fee pair stays On flyer. The hand-set public notes on Accessibility and Lease terms go - only Tenant-paid utilities keeps one. Explicit pins on both property forms, the shared Requirements section and the landlord form (spec 2026-10-21 D2).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## Task 2.3 - The flyer drops rent, deposit, pets, pet fee, accessibility and lease; PublicFlyer drops the ten keys

Goal: no rent fact and no Deposit / Pets / Pet fee / Accessibility / Lease
terms row, even from a stale payload; `PublicFlyer` drops the ten D1 keys;
`rentRange`, `petsLabel`, `depositLabel` are deleted (`flyerMoney` stays)
(spec D1 last para, D3 items 5 and 7; plan 1 D1, D3, 2.7).

Files: `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/public/FlyerPage.test.tsx`,
`dashboard/src/routes/public/publicApi.ts`,
`dashboard/src/routes/public/publicApi.test.ts`.

### Step 1 - tests first

(a) `publicApi.test.ts`: change
"import { beforeEach, describe, expect, it, vi } from 'vitest';" to
"import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';"
and
```
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
} from './publicApi.js';
```
to
```
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
  type PublicAddress,
  type PublicFlyer,
} from './publicApi.js';
```
Append at the end of the file:
```ts
// flyer-leads D1: the public projection no longer carries rent, lease terms,
// accessibility, pets or deposit - the keys are REMOVED, never null - so the
// client type drops the same ten. A TYPE pin: vitest strips types, so these
// cases pass at runtime either way; `npm run typecheck` is what fails while
// any of the keys is still on PublicFlyer.
type TrimmedFlyerKey =
  | 'rent_min'
  | 'rent_max'
  | 'lease_terms'
  | 'accessibility'
  | 'pets'
  | 'no_pets'
  | 'pet_fee'
  | 'deposit'
  | 'deposit_one_month'
  | 'deposit_flexible';

describe('PublicFlyer (flyer-leads D1)', () => {
  it('carries none of the ten trimmed keys', () => {
    expectTypeOf<Extract<keyof PublicFlyer, TrimmedFlyerKey>>().toBeNever();
  });

  it('(PIN) keeps the application fee and the address', () => {
    expectTypeOf<PublicFlyer['application_fee']>().toEqualTypeOf<number | null>();
    expectTypeOf<PublicFlyer['address']>().toEqualTypeOf<PublicAddress>();
  });
});
```

(b) `FlyerPage.test.tsx`, first case "public variant shows ALL info upfront
plus the intake form" - anchor :95-108
```
    // Detail rows are all present upfront (no gate).
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('$1800')).toBeInTheDocument();
    expect(screen.getByText('Application fee')).toBeInTheDocument();
    expect(screen.getByText('$40')).toBeInTheDocument();
    expect(screen.getByText('Tenant pays')).toBeInTheDocument();
    expect(screen.getByText('Electric and gas')).toBeInTheDocument();
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('Cats only')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(screen.getByText('Ground floor')).toBeInTheDocument();
    expect(screen.getByText('Lease terms')).toBeInTheDocument();
    expect(screen.getByText('12-month minimum')).toBeInTheDocument();
    expect(screen.getByText('Same-day RTA')).toBeInTheDocument();
```
replace with
```
    // Detail rows are all present upfront (no gate) - the public ones only
    // (flyer-leads D1, D3: no rent, deposit, pets, accessibility or lease).
    expect(screen.getByText('Application fee')).toBeInTheDocument();
    expect(screen.getByText('$40')).toBeInTheDocument();
    expect(screen.getByText('Tenant pays')).toBeInTheDocument();
    expect(screen.getByText('Electric and gas')).toBeInTheDocument();
    expect(screen.getByText('Same-day RTA')).toBeInTheDocument();
```

(c) `FlyerPage.test.tsx` :260-294 - anchor from
"  it('empty-string detail values render NO row (label suppressed)', async () => {"
through the closing "  });" of
"  it('whitespace-only detail values render NO row (edit form saves untrimmed)', async () => {"
and replace both cases with:
```tsx
  it('an empty-string detail value renders NO row (label suppressed)', async () => {
    // Staff can save '' for a free-text field (the write validator accepts
    // it); a labeled <dt> with a blank <dd> must simply not render.
    getFlyer.mockResolvedValue({ ...FLYER, utilities: '' });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText('Tenant pays')).toBeNull();
  });

  it('a whitespace-only detail value renders NO row (edit form saves untrimmed)', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, utilities: '  ' });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText('Tenant pays')).toBeNull();
  });

  // flyer-leads D1, D3: the projection no longer sends these ten keys. A
  // stale payload that still carries them (hand-fed here) shows none of them:
  // the page never reads them.
  const STALE_TRIMMED_KEYS = {
    rent_min: 1800,
    rent_max: 2000,
    lease_terms: '12-month minimum',
    accessibility: 'Ground floor',
    pets: 'Cats only',
    no_pets: true,
    pet_fee: '$300',
    deposit: 1500,
    deposit_one_month: true,
    deposit_flexible: true,
  };

  it('shows no rent, deposit, pets, pet fee, accessibility or lease row, even from a stale payload (flyer-leads D1, D3)', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, ...STALE_TRIMMED_KEYS } as unknown as PublicFlyer);
    renderPage();
    // A positive read on the same load first: the page is ready.
    expect(await screen.findByText('Tenant pays')).toBeInTheDocument();
    for (const label of ['Deposit', 'Pets', 'Pet fee', 'Accessibility', 'Lease terms']) {
      expect(screen.queryAllByText(label, { selector: 'dt' }), label).toHaveLength(0);
    }
    for (const text of ['12-month minimum', 'Ground floor', 'Cats only', '$300', '$1500', "One month's rent"]) {
      expect(screen.queryAllByText(text, { exact: false }), text).toHaveLength(0);
    }
    expect(screen.queryAllByText(/No pets/)).toHaveLength(0);
    expect(screen.queryAllByText(/flexible/i)).toHaveLength(0);
    // No rent fact: neither amount, and no "/mo".
    expect(screen.queryAllByText(/\$1800|\$2000|\/mo/)).toHaveLength(0);
  });
```

(d) `FlyerPage.test.tsx`, describe "FlyerPage - D11 wording": DELETE the
cases from
"  it('Pets: \"No pets\", \"No pets (<details>)\" or the details; the pet fee is its own row', async () => {"
(:434) through the end of
"  it('no deposit recorded: no Deposit row (the notes are staff only and never projected)', async () => {"
(:478-481) - that is the four Pets cases, the legacy-boolean case, the
blank-pet-fee case, the O-1 comment, `DEPOSIT_CASES` with its loop, and the
no-deposit case. Then replace the MONEY_CASES head (:493-502)
```
  // Planner ruling PR-4 (code review PA-4): both amounts print through one
  // formatter - a whole number exactly as before, any other amount with two
  // decimals (the forms accept cents, D1).
  // Plain its with template titles (note O-1 above).
  const MONEY_CASES: Array<[string, Partial<PublicFlyer>, string]> = [
    ['Deposit', { deposit: 1250.4 }, '$1250.40'],
    ['Deposit', { deposit: 1250.4, deposit_flexible: true }, '$1250.40, flexible / payment plan available'],
    ['Application fee', { application_fee: 37.5 }, '$37.50'],
    ['Application fee', { application_fee: 40 }, '$40'],
  ];
```
with
```
  // Planner ruling PR-4 (code review PA-4): the application fee prints through
  // flyerMoney - a whole number exactly as before, any other amount with two
  // decimals (the forms accept cents, D1). flyer-leads D3: the deposit row is
  // gone, so the fee is flyerMoney's only reader.
  // Plain its, not it.each (orchestrator note O-1): an it.each title has every
  // `$<word>` read as a case field AFTER the %s substitution, so "$37.50"
  // printed as "undefined". A template-literal title prints the text as is.
  const MONEY_CASES: Array<[string, Partial<PublicFlyer>, string]> = [
    ['Application fee', { application_fee: 37.5 }, '$37.50'],
    ['Application fee', { application_fee: 40 }, '$40'],
  ];
```
Do NOT yet remove the ten keys from the `FLYER` fixture (Step 3 does): the
current page calls `textOrNull(flyer.pet_fee)` and would throw on
`undefined`, turning every case red for the wrong reason.

### Step 2 - RED

- `cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public/FlyerPage.test.tsx src/routes/public/publicApi.test.ts`
  Expected: exactly one failure, the stale-payload case - the `Deposit` /
  `Pets` / ... `<dt>` is found (length 1, expected 0). The publicApi type
  pins pass at runtime (by design).
- `cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard`
  Expected: exit non-zero, ONE type error, on the `toBeNever()` line of
  `publicApi.test.ts` (the extracted union of the ten keys is not never).

### Step 3 - implementation

(a) `publicApi.ts` - anchor
```
  listing_link: string | null;
  rent_min: number | null;
  rent_max: number | null;
  address: PublicAddress;
```
replace with
```
  listing_link: string | null;
  address: PublicAddress;
```
and anchor from "  same_day_rta: boolean | null;" through
"  lease_terms: string | null;" (:51-64, the pets docs, `no_pets`, `pet_fee`,
`accessibility`, `deposit`, `deposit_one_month`, `deposit_flexible`,
`washer_dryer`, `lease_terms`) replace with
```
  same_day_rta: boolean | null;
  washer_dryer: 'hookups' | 'included' | 'none' | null;
```
and anchor
" *  shown upfront - the teaser/reveal split is gone (flyer-full-info). */" (:27)
replace with
```
 *  shown upfront - the teaser/reveal split is gone (flyer-full-info).
 *  flyer-leads D1 (spec 2026-10-21): rent, lease terms, accessibility, pets
 *  and deposit are staff only - the projection REMOVES those ten keys and
 *  this type drops them too. */
```

(b) `FlyerPage.tsx` - delete the whole `rentRange` function (:47-53, from
"function rentRange(flyer: Pick<PublicFlyer, 'rent_min' | 'rent_max'>): string | null {"
to its closing "}" and the blank line after).

(c) `FlyerPage.tsx` - delete the `petsLabel` doc comment and function
(:133-140, from "/** D11: \"No pets\", \"No pets (<details>)\", or the details alone. A legacy stored"
through the closing "}" of `petsLabel`, and the blank line after).

(d) `FlyerPage.tsx` - anchor
```
/** The deposit and application-fee amounts (planner ruling PR-4, code review
 *  PA-4): a whole number exactly as before ("$1500"), any other amount with
 *  two decimals ("$1250.40", "$37.50") - the forms accept cents (D1). */
```
replace with
```
/** The application-fee amount (planner ruling PR-4, code review PA-4): a
 *  whole number exactly as before ("$40"), any other amount with two decimals
 *  ("$37.50") - the forms accept cents (D1). flyer-leads D3: the deposit row
 *  is gone; applicationFeeLabel is the only reader. */
```

(e) `FlyerPage.tsx` - delete the `depositLabel` doc comment and function
(:149-159, from "/** D11: \"One month's rent\" or \"$N\", then \", flexible / payment plan"
through its closing "}" and the blank line after).

(f) `FlyerPage.tsx` ready-state consts - delete these six lines (and only
these): "  const rent = rentRange(flyer);", "  const pets = petsLabel(flyer);",
"  const petFee = textOrNull(flyer.pet_fee);",
"  const deposit = depositLabel(flyer);",
"  const accessibility = textOrNull(flyer.accessibility);",
"  const leaseTerms = textOrNull(flyer.lease_terms);".

(g) `FlyerPage.tsx` - delete the rent fact:
```
        {rent !== null && (
          <li>
            <strong>{rent}</strong>/mo
          </li>
        )}
```

(h) `FlyerPage.tsx` - delete the five `<div className={styles.detailRow}>`
blocks guarded by `{deposit !== null && (`, `{pets !== null && (`,
`{petFee !== null && (`, `{accessibility !== null && (` and
`{leaseTerms !== null && (` (each from its `{... !== null && (` line through
its closing `)}`). Leave the Address row for Task 2.4.

(i) `FlyerPage.tsx` header - anchor
"// Tenant-facing copy: the dwelling is a \"home\" (never unit/property/listing)."
replace with
```
// Tenant-facing copy: the dwelling is a "home" (never unit/property/listing).
//
// flyer-leads (spec 2026-10-21 D1, D3): no rent, lease terms, accessibility,
// pets or deposit - those are staff only, and the public projection no longer
// sends them (a stale payload's keys are simply never read).
```

(j) `FlyerPage.test.tsx` `FLYER` fixture - now drop the ten keys. Anchor
```
  listing_link: 'https://external.example/listing/1',
  rent_min: 1800,
  rent_max: 2000,
  address:
```
-> remove the two rent lines; and anchor
```
  same_day_rta: true,
  pets: 'Cats only',
  no_pets: false,
  pet_fee: null,
  accessibility: 'Ground floor',
  deposit: 1800,
  deposit_one_month: false,
  deposit_flexible: false,
  washer_dryer: null,
  lease_terms: '12-month minimum',
  contact_number: '+15550009999',
```
replace with
```
  same_day_rta: true,
  washer_dryer: null,
  contact_number: '+15550009999',
```
(Without this the typecheck fails with excess-property errors on the
fixture.)

### Step 4 - GREEN

- `cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public` - all green.
- `cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard` - exit 0.
- `cd "W:/tmp/flyer-leads" && grep -n "rentRange\|petsLabel\|depositLabel\|rent_min\|no_pets\|pet_fee\|deposit_one_month\|deposit_flexible\|lease_terms" dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/publicApi.ts`
  prints nothing (comments included: the header note says "rent, lease
  terms, ..." in words, not key names).

### Step 5 - ASCII

`FlyerPage.test.tsx`, `publicApi.test.ts`: new-file command prints 0
(both pure ASCII). `FlyerPage.tsx`, `publicApi.ts`: the diff command prints 0.

### Step 6 - commit

After the section C preamble:
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/publicApi.test.ts
cd "W:/tmp/flyer-leads" && git commit -m 'feat(flyer): drop rent, deposit, pets, accessibility and lease from the public flyer (flyer-leads D1, D3)' -m 'The flyer page no longer shows the rent fact or the Deposit, Pets, Pet fee, Accessibility and Lease terms rows, and ignores those keys on a stale payload; PublicFlyer drops the ten keys the projection no longer sends (type-pinned). rentRange, petsLabel and depositLabel are deleted; flyerMoney stays for the application fee (spec 2026-10-21 D1, D3).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## Task 2.4 - The address is the heading (Maps link), with its fallbacks and the area line

Goal: the h1 is the street line inside the existing Maps link, a second
"city, state zip" line in the same link, the old sr-only suffix; fallbacks
(city line; area as plain text; "Home for rent"); the area line under an
address heading; the Address row and `addressLines` gone; the detail rows
pinned in 1.1 order; the heading wraps at 320px and the whole heading block
is the tap target (spec D3 items 2, 3, 7, the 320px paragraph; plan 1.1).

Files: `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/public/FlyerPage.module.css`,
`dashboard/src/routes/public/FlyerPage.test.tsx`,
`dashboard/src/routes/public/FlyerPage.styles.test.ts` (NEW).

### Step 1 - tests first

(a) `FlyerPage.test.tsx` imports: change
"import { render, screen, waitFor } from '@testing-library/react';" to
"import { render, screen, waitFor, within } from '@testing-library/react';"
and after "import type { PublicFlyer } from './publicApi.js';" add
"import styles from './FlyerPage.module.css';".

(b) First case - anchor
```
    // D11 / D3: the neighborhood line is the area alone.
    expect(screen.getByRole('heading', { name: 'Decatur' })).toBeInTheDocument();
```
replace with
```
    // flyer-leads D3: the address is the heading; the area is the line under it.
    expect(screen.getByRole('heading', { level: 1, name: '88 Sycamore St' })).toBeInTheDocument();
    expect(screen.getByText('Decatur')).toBeInTheDocument();
```

(c) Case "a partial address still maps; a blank one renders as plain text" -
anchor
```
    // Whitespace-only parts print (addressLines keeps them) but must not link.
    getFlyer.mockResolvedValue({ ...FLYER, address: { line1: '   ' } });
    renderPage();
    await screen.findByText('Address');
    expect(screen.queryByRole('link', { name: /google maps/i })).toBeNull();
```
replace with
```
    // Whitespace-only parts are no address (flyer-leads D3): the heading falls
    // back to the area, as plain text - no Maps link.
    getFlyer.mockResolvedValue({ ...FLYER, address: { line1: '   ' } });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Decatur' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /google maps/i })).toBeNull();
```

(d) Case "a stale subzone in the payload is never shown (D3: staff only)" -
anchor
"    expect(await screen.findByRole('heading', { name: 'Decatur' })).toBeInTheDocument();"
replace with
"    expect(await screen.findByRole('heading', { level: 1, name: '88 Sycamore St' })).toBeInTheDocument();"

(e) Append at the end of `FlyerPage.test.tsx`:
```tsx
// flyer-leads D3: the address is the heading - a Maps link holding the street
// line (the h1), the city line and the sr-only suffix the old Address row
// carried; the area is a line under it; fallbacks when parts are missing.
describe('FlyerPage - the address heading (flyer-leads D3)', () => {
  const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  async function renderReady(over: Partial<PublicFlyer>): Promise<void> {
    getFlyer.mockResolvedValue({ ...FLYER, ...over });
    renderPage();
    await screen.findByText('Tenant pays');
  }
  /** The Maps heading link; null when the heading is plain text. */
  const mapsLink = (): HTMLElement | null => screen.queryByRole('link', { name: /open in Google Maps/ });

  it('the h1 is the street line inside the Maps link, with the city line and the sr-only suffix', async () => {
    await renderReady({
      address: { line1: '88 Sycamore St', line2: 'Apt 2', city: 'Decatur', state: 'GA', zip: '30030' },
    });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName('88 Sycamore St, Apt 2');
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(link).toContainElement(heading);
    expect(link).toHaveAttribute('href', MAPS + encodeURIComponent('88 Sycamore St, Apt 2, Decatur, GA, 30030'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    // The whole heading block is the tap target: the city line is in the SAME link.
    expect(within(link).getByText('Decatur, GA 30030')).toBeInTheDocument();
    // WCAG 2.5.3: the visible text leads the name; the hidden suffix only adds
    // to it and says where the link goes (a new tab).
    expect(link).toHaveAccessibleName(/^88 Sycamore St, Apt 2\s*Decatur, GA 30030 - open in Google Maps$/);
    expect(within(link).getByText('- open in Google Maps')).toHaveClass(styles.srOnly!);
    // The separate Address row is gone.
    expect(screen.queryByText('Address', { selector: 'dt' })).toBeNull();
  });

  it('the area is a line directly under an address heading, outside the link; photos stay first', async () => {
    await renderReady({});
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    // Exact text: the city line inside the link reads "Decatur, GA 30030".
    const area = screen.getByText('Decatur');
    expect(link).not.toContainElement(area);
    expect(link.nextElementSibling).toBe(area);
    const photo = screen.getByRole('img', { name: 'Home photo 1' });
    expect(photo.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each<[string, PublicFlyer['address'], string, string]>([
    ['zip only', { zip: '30030' }, '30030', '30030'],
    ['state and zip', { state: 'GA', zip: '30030' }, 'GA 30030', 'GA, 30030'],
    ['city and zip', { city: 'Decatur', zip: '30030' }, 'Decatur, 30030', 'Decatur, 30030'],
    ['city and state', { city: 'Decatur', state: 'GA' }, 'Decatur, GA', 'Decatur, GA'],
  ])('no street line, %s: the h1 is the city line, linked, with no second line', async (_case, address, title, query) => {
    await renderReady({ address });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName(title);
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(link).toContainElement(heading);
    expect(link).toHaveAttribute('href', MAPS + encodeURIComponent(query));
    // Name = the h1 and the suffix only: no second line.
    expect(link).toHaveAccessibleName(`${title} - open in Google Maps`);
  });

  it('line2 alone is a street line; every part is trimmed', async () => {
    await renderReady({ address: { line1: '  88 Sycamore St ', line2: '   ', city: ' Decatur', state: 'GA ', zip: ' 30030 ' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('88 Sycamore St');
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(within(link).getByText('Decatur, GA 30030').textContent).toBe('Decatur, GA 30030');
    getFlyer.mockResolvedValue({ ...FLYER, address: { line2: 'Unit 4', city: 'Decatur' } });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Unit 4' })).toBeInTheDocument();
  });

  it('no address at all: the area as plain text - no link, and no second area line', async () => {
    await renderReady({ address: {} });
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Decatur');
    expect(mapsLink()).toBeNull();
    expect(screen.getAllByText('Decatur')).toHaveLength(1);
  });

  it.each<[string, string | null]>([
    ['no area', null],
    ['a blank area', '   '],
  ])('no address and %s: the plain text "Home for rent"', async (_case, area) => {
    await renderReady({ address: {}, area });
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Home for rent');
    expect(mapsLink()).toBeNull();
  });

  it('a recorded area prints trimmed (D10)', async () => {
    await renderReady({ area: '  Decatur  ' });
    expect(screen.getByText('Decatur').textContent).toBe('Decatur');
  });

  it('"A home for you" appears nowhere, whatever the payload', async () => {
    for (const over of [{}, { address: {} }, { address: {}, area: null }] as Partial<PublicFlyer>[]) {
      getFlyer.mockResolvedValue({ ...FLYER, ...over });
      const view = renderPage();
      await screen.findByText('Tenant pays');
      expect(screen.queryByText(/A home for you/)).toBeNull();
      view.unmount();
    }
  });

  it('the detail rows run Application fee, Tenant pays, Washer / dryer, Same-day RTA, Video tour, Listing', async () => {
    await renderReady({ washer_dryer: 'hookups' });
    expect(Array.from(document.querySelectorAll('dt'), (dt) => dt.textContent)).toEqual([
      'Application fee',
      'Tenant pays',
      'Washer / dryer',
      'Same-day RTA',
      'Video tour',
      'Listing',
    ]);
  });
});
```
Note on the line2 case: `'Unit 4'` + city `'Decatur'` -> the h1 is "Unit 4"
(spec: line1, then line2, blank parts left out), second line "Decatur".

(f) NEW `dashboard/src/routes/public/FlyerPage.styles.test.ts`:
```ts
// FlyerPage.module.css source pins (flyer-leads D3). The unit tests run with
// `css: false` (vite.config.ts), so no test can measure the page; these pins
// keep the rules in place, and the e2e flyer spec checks the 320px wrap in a
// real browser. Same mechanism as routes/inbox/InboxRow.styles.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(testDir, 'FlyerPage.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The TOP-LEVEL rule for `selector`, anchored on a line start.
function bodyOf(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

describe('FlyerPage.module.css (flyer-leads D3)', () => {
  it('the address heading link is one block: the whole heading is the tap target', () => {
    expect(bodyOf('.headingLink')).toMatch(/(?:^|\s)display:\s*block\s*;/);
  });

  it('the heading wraps instead of overflowing its card at 320px', () => {
    expect(bodyOf('.headingLink')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    // The plain-text fallback heading too (a long area name).
    expect(bodyOf('.title')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });
});
```
(The regex line is copied verbatim from `InboxRow.styles.test.ts:16`. Plan
0's backslash-u check: `cd "W:/tmp/flyer-leads" && grep -c -F '\u' dashboard/src/routes/public/FlyerPage.styles.test.ts`
prints 0 - use `-F`: without it Git Bash's grep reads the pattern as a
plain "u" and matches nearly every line. Then diff the regex line against
`InboxRow.styles.test.ts:16` by eye.)

### Step 2 - RED

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public/FlyerPage.test.tsx src/routes/public/FlyerPage.styles.test.ts`
Expected failures: the first case (no heading named "88 Sycamore St" - the
h1 is the area); every new heading case except "no address at all" (which
is a PIN: the h1 is the area today) - no Maps link holding an h1, the old
`<h1>` reads "A home for you" for the two "Home for rent" cases and inside
the "A home for you" loop, the `dt` list starts with "Address"; the stale-
subzone case; both styles cases ("missing CSS rule for .headingLink",
`.title` has no overflow-wrap). The trimmed-area case is RED too
(`textContent` "  Decatur  " - the h1 holds the untrimmed area today).

### Step 3 - implementation

(a) `FlyerPage.tsx` - anchor the `neighborhood` block (:55-59)
```
/** The neighborhood line: the AREA alone (D11). Subzone is a staff-only code
 *  and is not in the projection (D3). */
function neighborhood(flyer: Pick<PublicFlyer, 'area'>): string | null {
  return typeof flyer.area === 'string' && flyer.area.trim() !== '' ? flyer.area : null;
}
```
replace with
```
/** The neighborhood: the AREA alone (D11), trimmed (flyer-leads D10 - a
 *  display guard; JSON writes are already trimmed server-side, but a legacy
 *  or imported value may not be). Subzone is a staff-only code and is not in
 *  the projection (D3). flyer-leads D3: the line under an address heading,
 *  or the plain heading when there is no address. */
function neighborhood(flyer: Pick<PublicFlyer, 'area'>): string | null {
  if (typeof flyer.area !== 'string') return null;
  const area = flyer.area.trim();
  return area === '' ? null : area;
}
```
(Binding: the display-time trim is accepted by AR5 and stands under AR16 as
a defensive display guard.)

(b) `FlyerPage.tsx` - delete `addressLines` (:82-87, from
"function addressLines(a: PublicFlyer['address']): string | null {" through
its closing "}" and the blank line after).

(c) `FlyerPage.tsx` `mapsHref` doc - anchor
"/** A Google Maps link for the home's address - \"where is this?\" is the tenant's\n *  next question after the rent, and a flyer arrives by text on a phone, where"
replace with
"/** A Google Maps link for the home's address - \"where is this?\" is the tenant's\n *  first question about a flyer, and a flyer arrives by text on a phone, where"
and anchor
" *  address carries nothing but blanks (the row then renders as plain text). */"
replace with
" *  address carries nothing but blanks (the heading then falls back to the area\n *  or \"Home for rent\" as plain text - flyerHeading, flyer-leads D3). */"

(d) `FlyerPage.tsx` - insert directly after the closing "}" of `mapsHref`
(before "/** \"I'm interested in <line1, city | neighborhood | this home>\" */"):
```ts
/** flyer-leads D3: one address part, trimmed ('' when absent). */
function addressPart(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** flyer-leads D3: the street line - line1, then line2, joined by ', ';
 *  blank parts left out. Null when both are blank. */
function streetLine(a: PublicFlyer['address']): string | null {
  const line = [addressPart(a.line1), addressPart(a.line2)].filter((p) => p !== '').join(', ');
  return line === '' ? null : line;
}

/** flyer-leads D3: the city line - city, then ', ', then state and zip joined
 *  by one space; blank parts left out with their separators. Null when all
 *  three are blank. */
function cityLine(a: PublicFlyer['address']): string | null {
  const stateZip = [addressPart(a.state), addressPart(a.zip)].filter((p) => p !== '').join(' ');
  const line = [addressPart(a.city), stateZip].filter((p) => p !== '').join(', ');
  return line === '' ? null : line;
}

/** flyer-leads D3: the ready state's heading. An address heading is the Maps
 *  link; `subline` is the city line under the street line (null when the city
 *  line IS the title). With no address part at all: the area, else "Home for
 *  rent", as plain text. mapsHref is non-null exactly when streetLine or
 *  cityLine is (both test every part trimmed). */
type FlyerHeading =
  | { kind: 'address'; title: string; subline: string | null; href: string }
  | { kind: 'plain'; title: string };

function flyerHeading(address: PublicFlyer['address'], hood: string | null): FlyerHeading {
  const href = mapsHref(address);
  const street = streetLine(address);
  const city = cityLine(address);
  if (href !== null && street !== null) return { kind: 'address', title: street, subline: city, href };
  if (href !== null && city !== null) return { kind: 'address', title: city, subline: null, href };
  return { kind: 'plain', title: hood ?? 'Home for rent' };
}
```

(e) `FlyerPage.tsx` ready-state consts - anchor
```
  const address = addressLines(flyer.address);
  const mapUrl = mapsHref(flyer.address);
```
replace with
```
  const heading = flyerHeading(flyer.address, hood);
```
(`hood` is declared above it: "  const hood = neighborhood(flyer);".)

(f) `FlyerPage.tsx` - anchor
"      <h1 className={styles.title}>{hood ?? 'A home for you'}</h1>"
replace with
```tsx
      {/* flyer-leads D3: the address IS the heading and the Maps link - the
          whole block (street line + city line) is the tap target. The visible
          text leads the accessible name and the hidden suffix only ADDS to it
          (WCAG 2.5.3); it also says the link leaves for Maps in a new tab.
          The area is a line under an address heading, never dropped. */}
      <div className={styles.headingGroup}>
        {heading.kind === 'address' ? (
          <a className={styles.headingLink} href={heading.href} target="_blank" rel="noreferrer">
            <h1 className={styles.addressTitle}>{heading.title}</h1>
            {heading.subline !== null && <span className={styles.subline}>{heading.subline}</span>}
            <span className={styles.srOnly}> - open in Google Maps</span>
          </a>
        ) : (
          <h1 className={styles.title}>{heading.title}</h1>
        )}
        {heading.kind === 'address' && hood !== null && <p className={styles.area}>{hood}</p>}
      </div>
```

(g) `FlyerPage.tsx` - delete the whole Address row: from
"        {address !== null && (" through its closing "        )}" (the block
with "<dt className={styles.dt}>Address</dt>", the WCAG comment and the
`mapUrl` ternary). The `<dl>` now opens with the Application fee row.

(h) `FlyerPage.tsx` header - anchor
"// sends them (a stale payload's keys are simply never read)."
replace with
```
// sends them (a stale payload's keys are simply never read). The address is
// the heading (a Google Maps link), the area the line under it.
```

(i) `FlyerPage.module.css` - replace the `.title` rule (:20-25) with
```css
.title {
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  line-height: var(--lh-tight);
  color: var(--c-text);
  overflow-wrap: anywhere;
}
```
and insert after the `.muted` rule (:27-29):
```css
/* flyer-leads D3: the heading group - the address heading link (the h1
   street line plus the city line: ONE tap target) and the area line under
   it. overflow-wrap lets a long street name wrap at 320px instead of
   overflowing the card. */
.headingGroup {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}

.headingLink {
  display: block;
  color: var(--c-brand);
  overflow-wrap: anywhere;
}

.addressTitle {
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  line-height: var(--lh-tight);
  color: inherit;
}

.subline {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-md);
  color: inherit;
}

.area {
  font-size: var(--fs-md);
  color: var(--c-text-muted);
}
```
and anchor
"/* Visually-hidden text (the Address link's \"open in Google Maps\" suffix). */"
replace with
"/* Visually-hidden text (the address heading link's \"open in Google Maps\" suffix). */"

### Step 4 - GREEN

- `cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public` - all green.
- `cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard` - exit 0.
- `cd "W:/tmp/flyer-leads" && grep -n "addressLines\|A home for you\|mapUrl" dashboard/src/routes/public/FlyerPage.tsx` prints nothing.

### Step 5 - ASCII

`FlyerPage.module.css`, `FlyerPage.test.tsx`, new `FlyerPage.styles.test.ts`:
new-file command prints 0. `FlyerPage.tsx`: diff command prints 0.

### Step 6 - commit

After the section C preamble (the styles test is a NEW file - add it by
its explicit path too):
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.module.css dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/routes/public/FlyerPage.styles.test.ts
cd "W:/tmp/flyer-leads" && git commit -m 'feat(flyer): make the address the flyer heading, linked to Google Maps (flyer-leads D3)' -m 'The h1 is the street line inside the Maps link, with the city line under it in the same link and the old sr-only "open in Google Maps" suffix; with no street line the city line is the h1, with no address the area (plain text, trimmed), else "Home for rent". The area is a line under an address heading. The Address row and addressLines are gone, the detail rows are pinned in order, and CSS pins keep the heading one tap target that wraps at 320px (spec 2026-10-21 D3; AR5).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## Task 2.5 - "Same-day tours available" on every flyer; a bolder authority line

Goal: a highlighted static line "Same-day tours available" under the
heading group on every ready flyer (both CTA variants, a bare property
included), never on the unavailable state; the "Accepts: ..." line bold,
larger than body text, full-contrast, wording unchanged (spec D3 items 4,
6; plan 1.1).

Files: `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/public/FlyerPage.module.css`,
`dashboard/src/routes/public/FlyerPage.test.tsx`,
`dashboard/src/routes/public/FlyerPage.styles.test.ts`.

### Step 1 - tests first

(a) Append to `FlyerPage.test.tsx`:
```tsx
// flyer-leads D3 items 4 and 6: the highlight line on every flyer (Sam,
// tracker #13) and the bolder housing authority line.
describe('FlyerPage - the highlight and the authority line (flyer-leads D3)', () => {
  const BARE: PublicFlyer = {
    unitId: 'unit-bare',
    media: [],
    beds: null,
    baths: null,
    area: null,
    voucher_size: null,
    voucher_sizes: [],
    accepted_authorities: [],
    listing_link: null,
    address: {},
    utilities: null,
    video_url: null,
    application_fee: null,
    same_day_rta: null,
    washer_dryer: null,
    contact_number: null,
  };

  it('"Same-day tours available" shows on a bare property: static copy, not the Same-day RTA row', async () => {
    getFlyer.mockResolvedValue(BARE);
    renderPage('/p/unit-bare');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home for rent' })).toBeInTheDocument();
    expect(screen.getByText('Same-day tours available')).toHaveClass(styles.highlight!);
    expect(screen.queryByText('Same-day RTA')).toBeNull();
  });

  it('sits under the heading group and above the facts, on both CTA variants', async () => {
    getFlyer.mockResolvedValue(FLYER);
    for (const entry of ['/p/unit-1', '/p/unit-1?cta=text']) {
      const view = renderPage(entry);
      const line = await screen.findByText('Same-day tours available');
      const area = screen.getByText('Decatur');
      const beds = screen.getByText((_, el) => el?.tagName === 'LI' && el.textContent === '3 beds');
      expect(area.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(line.compareDocumentPosition(beds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      view.unmount();
      sessionStorage.clear();
    }
  });

  it('(PIN) the unavailable state keeps its copy, with no highlight', async () => {
    getFlyer.mockRejectedValue(
      new ApiError(404, 'not_found', 'not_found', { error: 'not_found', contact_number: null }),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: /no longer available/i })).toBeInTheDocument();
    expect(screen.queryByText('Same-day tours available')).toBeNull();
  });

  it('(PIN) the authority line keeps its wording and the class the CSS pin reads', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage();
    expect(await screen.findByText('Accepts: Atlanta (AHA), DCA')).toHaveClass(styles.authorities!);
  });
});
```

(b) Add to `FlyerPage.styles.test.ts`, inside the describe after the 320px
case:
```ts
  it('the housing authority line is bold, larger than body text (--fs-md) and full-contrast', () => {
    const body = bodyOf('.authorities');
    expect(body).toMatch(/font-weight:\s*var\(--fw-bold\)\s*;/);
    expect(body).toMatch(/font-size:\s*var\(--fs-(?:lg|xl|2xl)\)\s*;/);
    expect(body).toMatch(/(?:^|[\s;])color:\s*var\(--c-text\)\s*;/);
  });

  it('"Same-day tours available" is a highlighted line', () => {
    const body = bodyOf('.highlight');
    expect(body).toMatch(/background:\s*var\(--c-brand-soft\)\s*;/);
    expect(body).toMatch(/font-weight:\s*var\(--fw-semibold\)\s*;/);
    expect(body).toMatch(/(?:^|[\s;])color:\s*var\(--c-text\)\s*;/);
  });
```

### Step 2 - RED

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public/FlyerPage.test.tsx src/routes/public/FlyerPage.styles.test.ts`
Expected failures: the two highlight cases (no "Same-day tours available"
text) and the two new styles cases (`.authorities` is `--fs-sm` /
`--c-text-muted`; "missing CSS rule for .highlight"). The two (PIN) cases
pass.

### Step 3 - implementation

(a) `FlyerPage.tsx` - anchor (the end of the Task 2.4 heading group)
```
        {heading.kind === 'address' && hood !== null && <p className={styles.area}>{hood}</p>}
      </div>
```
replace with
```
        {heading.kind === 'address' && hood !== null && <p className={styles.area}>{hood}</p>}
      </div>

      {/* flyer-leads D3: on EVERY flyer (Sam, tracker #13: for advertising) -
          static page copy, not a property field. The per-property "Same-day
          RTA" row below is a different thing (Request for Tenancy Approval). */}
      <p className={styles.highlight}>Same-day tours available</p>
```

(b) `FlyerPage.tsx` - anchor
```
      {/* Which authorities' vouchers this home takes - the tenant's actual
          question. Absent authorities hide the line entirely (spec section 8). */}
```
replace with
```
      {/* Which authorities' vouchers this home takes - the tenant's actual
          question. Absent authorities hide the line entirely (spec section 8).
          flyer-leads D3: visibly stronger - bold, larger, full contrast. */}
```

(c) `FlyerPage.module.css` - replace the `.authorities` rule (:64-67)
```css
.authorities {
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
```
with
```css
/* flyer-leads D3: bold, larger than body text (--fs-md), full contrast. */
.authorities {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--c-text);
}

/* flyer-leads D3: "Same-day tours available" - static copy on every flyer
   (Sam, tracker #13), sized to its text rather than the card. */
.highlight {
  align-self: flex-start;
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  background: var(--c-brand-soft);
  color: var(--c-text);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}
```
(--c-text on --c-brand-soft is about 14.7:1; --c-brand on it would be about
4.0:1, under AA for 15px text - hence --c-text.)

(d) `FlyerPage.tsx` header - anchor
"// the heading (a Google Maps link), the area the line under it."
replace with
```
// the heading (a Google Maps link), the area the line under it, then the
// static "Same-day tours available" line on every flyer.
```

### Step 4 - GREEN

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public` - all green.
`cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/dashboard` - exit 0.

### Step 5 - ASCII

`FlyerPage.module.css`, `FlyerPage.test.tsx`, `FlyerPage.styles.test.ts`:
new-file command prints 0. `FlyerPage.tsx`: diff command prints 0.

### Step 6 - commit

After the section C preamble:
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.module.css dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/routes/public/FlyerPage.styles.test.ts
cd "W:/tmp/flyer-leads" && git commit -m 'feat(flyer): add "Same-day tours available" to every flyer and strengthen the authority line (flyer-leads D3)' -m 'A highlighted static line under the heading on every ready flyer (both CTA variants, not the unavailable state); the "Accepts: ..." line is bold, larger than body text and full contrast, wording unchanged. CSS source pins hold both (spec 2026-10-21 D3 items 4 and 6).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## Task 2.6 - The sign-up box reads as alerts, not a tour request

Goal: the bare-link (`form`) variant's box reads "Sign up for home alerts" /
the new text / button "Sign up"; the thank-you keeps its heading and gets
the new text; the `?cta=text` variant is unchanged (spec D3 item 8,
"Unchanged"; plan 1.1).

Files: `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/public/FlyerPage.test.tsx`.

### Step 1 - tests first

(a) `FlyerPage.test.tsx`: replace ALL THREE occurrences of
"await user.click(screen.getByRole('button', { name: /i'm interested/i }));"
(case "submit swaps ONLY the CTA ..." :184, and twice in the
join-housing-authority case :369, :375) with
"await user.click(screen.getByRole('button', { name: 'Sign up' }));"
(Edit with replace_all - the string occurs nowhere else).

(b) Case "submit swaps ONLY the CTA to a thank-you; the info stays" - anchor
```
    const thanks = await screen.findByRole('heading', {
      name: /you're all set|we've got your info/i,
    });
    expect(thanks).toBeInTheDocument();
```
replace with
```
    const thanks = await screen.findByRole('heading', { name: "Thanks - you're all set!" });
    expect(thanks).toBeInTheDocument();
    // flyer-leads D3: the thank-you promises alerts, never a call back.
    expect(screen.getByText("We'll text you about this home and others that fit your voucher.")).toBeInTheDocument();
    expect(screen.queryByText(/team member/i)).toBeNull();
```

(c) Append to `FlyerPage.test.tsx`:
```tsx
// flyer-leads D3 item 8: tenants filled the box in as if it booked a tour.
describe('FlyerPage - the sign-up box (flyer-leads D3)', () => {
  it('the bare-link box says what it is: home alerts, not a tour', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage();
    expect(await screen.findByRole('heading', { level: 2, name: 'Sign up for home alerts' })).toBeInTheDocument();
    expect(
      screen.getByText("We'll text you about this home and others that fit your voucher. Signing up does not book a tour."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Interested in this home?' })).toBeNull();
    expect(screen.queryByRole('button', { name: /interested/i })).toBeNull();
    expect(screen.queryByText(/team member/i)).toBeNull();
  });

  it('(PIN) the ?cta=text variant keeps its copy', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage('/p/unit-1?cta=text');
    expect(await screen.findByRole('heading', { level: 2, name: 'Interested in this home?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "I'm interested - text us" })).toBeInTheDocument();
    expect(screen.queryByText('Sign up for home alerts')).toBeNull();
  });
});
```

### Step 2 - RED

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public/FlyerPage.test.tsx`
Expected failures: "submit swaps ONLY the CTA ..." and the
join-housing-authority case (no button named "Sign up"), and "the bare-link
box says what it is ..." (no heading "Sign up for home alerts"). The (PIN)
passes.

### Step 3 - implementation (`FlyerPage.tsx`)

(a) Anchor
```
            <p className={styles.muted}>
              We&apos;ve got your info and a team member will be in touch.
            </p>
```
replace with
```
            <p className={styles.muted}>
              We&apos;ll text you about this home and others that fit your voucher.
            </p>
```
(b) Anchor
```
            <h2 className={styles.title}>Interested in this home?</h2>
            <p className={styles.muted}>
              Share your info and a team member will reach out about this home.
            </p>
            <IntakeForm onSubmit={handleIntakeSubmit} submitLabel="I'm interested" />
```
replace with
```
            {/* flyer-leads D3: alerts, never a tour request (Cameron approved
                this copy; Sam reviews it after the build). */}
            <h2 className={styles.title}>Sign up for home alerts</h2>
            <p className={styles.muted}>
              We&apos;ll text you about this home and others that fit your voucher.
              Signing up does not book a tour.
            </p>
            <IntakeForm onSubmit={handleIntakeSubmit} submitLabel="Sign up" />
```
(JSX joins the two text lines with one space.) The `?cta=text` block above
it ("Interested in this home?" / "I&apos;m interested - text us") is NOT
touched.

(c) Header - anchor
"//   form (bare link)  - the IntakeForm signup funnel at the bottom."
replace with
"//   form (bare link)  - the IntakeForm sign-up for home alerts at the bottom\n//                       (flyer-leads D3: it never reads as a tour request)."

### Step 4 - GREEN

`cd "W:/tmp/flyer-leads/dashboard" && npx vitest run src/routes/public` - all green.
`cd "W:/tmp/flyer-leads" && grep -n "team member\|I'm interested\" />" dashboard/src/routes/public/FlyerPage.tsx` prints nothing.

### Step 5 - ASCII

`FlyerPage.test.tsx`: new-file command prints 0. `FlyerPage.tsx`: diff
command prints 0.

### Step 6 - commit

After the section C preamble:
```
cd "W:/tmp/flyer-leads" && git add dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.test.tsx
cd "W:/tmp/flyer-leads" && git commit -m 'feat(flyer): reword the flyer sign-up box as home alerts, not a tour request (flyer-leads D3)' -m 'The bare-link box reads "Sign up for home alerts", says signing up does not book a tour, and its button reads "Sign up"; the thank-you keeps its heading and now promises texts about this home and others. The ?cta=text variant is unchanged (spec 2026-10-21 D3 item 8).' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## S2 exit check (its only commit is the slice report, step 7)

1. `cd "W:/tmp/flyer-leads/dashboard" && npx vitest run` - the whole
   dashboard suite green (no DynamoDB needed). Includes
   `requirementsMirror.test.ts` against the S1 app table.
2. `cd "W:/tmp/flyer-leads" && npm run typecheck` - exit 0 (all workspaces).
3. Lint, the touched files only (bare, not piped):
   `cd "W:/tmp/flyer-leads" && npx eslint dashboard/src/routes/listing/TaggedField.tsx dashboard/src/routes/listing/TaggedField.test.tsx dashboard/src/routes/listing/requirements.ts dashboard/src/routes/listing/requirements.test.ts dashboard/src/routes/listing/RequirementsFields.test.tsx dashboard/src/routes/listing/ListingEditForm.tsx dashboard/src/routes/listing/ListingEditForm.test.tsx dashboard/src/routes/listing/UnitCreateForm.tsx dashboard/src/routes/listing/UnitCreateForm.test.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/routes/public/FlyerPage.styles.test.ts dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/publicApi.test.ts`
   Expected: only the 2 pre-existing `react-hooks/set-state-in-effect`
   errors in `FlyerPage.tsx` (`setVariant(...)`, `setStage({ kind:
   'unavailable', ...})`); anything else is S2's and blocking. Name the two
   in the slice report.
4. `cd "W:/tmp/flyer-leads" && grep -rn "A home for you\|petsLabel\|depositLabel\|rentRange\|addressLines" dashboard/src`
   prints ONLY the `FlyerPage.test.tsx` lines of the case
   '"A home for you" appears nowhere, whatever the payload' (its title and
   its `/A home for you/` query) - no source file.
5. `cd "W:/tmp/flyer-leads" && grep -rn "rent_min\|rent_max\|no_pets\|pet_fee\|deposit_one_month\|deposit_flexible\|lease_terms" dashboard/src/routes/public`
   prints only `FlyerPage.test.tsx` (`STALE_TRIMMED_KEYS`) and
   `publicApi.test.ts` (`TrimmedFlyerKey`).
6. `cd "W:/tmp/flyer-leads" && git status` - clean (bare read). Then
   `cd "W:/tmp/flyer-leads" && git log --oneline -10`: the newest SIX
   commits are S2's, newest first - Task 2.6 ("feat(flyer): reword the flyer
   sign-up box ..."), 2.5, 2.4, 2.3, 2.2, 2.1 ("feat(dashboard): show the
   public flyer note only ...") - and the commit directly below Task 2.1's is
   S1's last commit (AR4: S1 -> S2 -> S3; no S3 / S4 commit exists yet).
   Anything else in between: STOP and report.
7. **Slice report** (plan 0). Write
   `W:/tmp/flyer-leads/docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S2-report.md`
   (create the `slices/` folder if S1 did not), ASCII, FINDINGS ONLY, each
   citing code by `file:line` - what the tree held that this plan got wrong
   (any anchor that did not match, any RED that was red for another reason),
   risks, and untrimmed paths. At minimum it names, with the line numbers the
   tree shows at the end of S2:
   - the 2 pre-existing lint errors in `dashboard/src/routes/public/FlyerPage.tsx`
     (`react-hooks/set-state-in-effect`: `setVariant(...)` in the cta effect,
     `setStage({ kind: 'unavailable', contactNumber: null })` in the unit
     effect) - not S2's;
   - that the 320px wrap is pinned only by CSS source (`FlyerPage.styles.test.ts`)
     and still needs the S6 real-browser check.
   If nothing else turned up, those items are the whole report. Check it:
   `cd "W:/tmp/flyer-leads" && tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S2-report.md | wc -c`
   prints 0. Then the section C preamble (bare `git status`, MERGE_HEAD
   absent) and:
   ```
   cd "W:/tmp/flyer-leads" && git add docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S2-report.md
   cd "W:/tmp/flyer-leads" && git commit -m 'docs(records): flyer-leads S2 slice report (dashboard: mirror, note gate, flyer page)' -m 'Findings only: pre-existing FlyerPage lint errors and the 320px check owed to S6.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
   ```
   (Adjust the second `-m` to what the report actually says; keep it free
   of apostrophes.)

## D. Spec coverage map

| Spec item | Task |
|---|---|
| D1 dashboard: `PublicFlyer` drops the ten keys (removed, not null) | 2.3 (type pin + type) |
| D1 "Old flyer pages" crash accepted - no compatibility code | 2.3 (the page never reads the keys; no shim added) |
| D2 mirror re-tag + drift test green | 2.2 |
| D2 note only where On flyer; `TaggedField` gate; pin with `publicNote` set | 2.1 |
| D2 hand-set `publicNote` removed on Accessibility / Lease terms (both forms); stays on Tenant-paid utilities | 2.2 (d)(e) + pins |
| D2 `RequirementsFields` derives the note - checked | 2.2 (c) pin (no source change) |
| D2 landlord form: Staff only for Pets / Deposit, "On property flyers" only on the fee pair, legend unchanged | 2.2 (f) |
| D3.1 photos unchanged | 2.4 (photo-first order assertion) |
| D3.2 heading = address link, h1 street line, second line, sr-only suffix, fallbacks, Address row + `addressLines` removed, "A home for you" nowhere | 2.4 |
| D3.3 area line under an address heading | 2.4 |
| D3.4 "Same-day tours available" on every flyer, static | 2.5 |
| D3.5 facts without rent | 2.3 |
| D3.6 bolder authority line, wording unchanged | 2.5 |
| D3.7 detail rows, order, removed rows; `petsLabel` / `depositLabel` / `rentRange` deleted, `flyerMoney` kept | 2.3 (rows, helpers), 2.4 (Address row, order pin) |
| D3.8 sign-up box copy, button, thank-you text | 2.6 |
| D3 Unchanged: `?cta=text` variant, unavailable state, tap-to-text prefill, CTA position | 2.5 / 2.6 (PINs) + the existing cta / unavailable / prefill cases, kept green |
| D3 320px wrap, whole heading block is the tap target | 2.4 (CSS pins + one-link DOM assertions); real-browser check = S6 |
| Spec 5 "Tags" bullets | 2.1, 2.2 |
| Spec 5 "Flyer page" bullets | 2.3, 2.4, 2.5, 2.6 |
| D10 whitespace | 2.4 (address parts and area trimmed at display); A2 / A3 (server trims every JSON body, AR16) |

## E. Notes for other slices

Names S2 creates (dashboard only, none cross-workspace):
- `FlyerPage.tsx` helpers `addressPart`, `streetLine`, `cityLine`,
  `flyerHeading` and type `FlyerHeading` (module-private).
- CSS classes `.headingGroup`, `.headingLink`, `.addressTitle`, `.subline`,
  `.area`, `.highlight` (new); `.authorities`, `.title` (changed).
- New test file `dashboard/src/routes/public/FlyerPage.styles.test.ts`.
- `TaggedField`'s internal `showNote`.

Relies on:
- S1: the app `REQUIREMENT_ITEMS` / `PROPERTY_FORM_FIELDS` values (B, plan
  1 D2). S2 runs directly after S1 (AR4), so the mirror drift test is red
  only between S1's re-tag commit and Task 2.2.
- Nothing from S3 / S4 / S5 (all of them run after S2).

Files other slices also touch: none of S2's files. S5's dashboard files
(`routes/listing/listingFormat.ts`, `routes/listing/ListingDetail.tsx`,
`routes/contact/Card.tsx`, `routes/contact/ContactDetail.tsx`,
`routes/contact/Timeline.tsx`, `routes/broadcasts/FollowUpView.tsx`,
`api/types.ts`, `api/endpoints.ts`) sit beside S2's but do not overlap; S2
touches `routes/contact/ContactEditForm.test.tsx` only. S6 owns
`documentation/GLOSSARY.md` and `e2e/support/selectors.md`.

e2e assertions S2 breaks (S6 repairs; line numbers @7ac1f2e3):
- `e2e/tests/dashboard-next/public-pages.spec.ts`
  - :216-217 "Key facts: neighborhood heading + beds + rent." /
    `getByRole('heading', { name: new RegExp(unit.area) })` - the heading is
    now the street line; the area is the line under it.
  - :219 `getByText(\`$${unit.rent}\`, ...)` - no rent on the flyer.
  - :239-240 Deposit + `$${unit.deposit}`, :244-249 Pets, Accessibility,
    Lease terms rows - gone (flip to `toHaveCount(0)` after a positive
    anchor; `createShareableUnit` :126-137 may keep writing them as data).
  - :285 `getByRole('button', { name: /I'm interested/i })` -> `Sign up`
    (use `exact: true`).
  - :22-25 header comment lists the old rows.
  - Still passing: :224 `getByText(unit.addressLine1)` (the h1), :228 the
    link named by line1 with the full-address Maps href, :288 the
    `/you're all set/i` heading.
- `e2e/tests/dashboard-next/listing-photos.spec.ts:242` - the ready anchor
  `getByRole('button', { name: /I'm interested/i })` -> `Sign up`.
- `e2e/tests/dashboard-next/property-requirements.spec.ts`
  - :262 `getByLabel('Pet fee', ...)` `toHaveAccessibleDescription(/On flyer/)`
    -> `/Staff only/`.
  - :380-386 the flyer reads "One month's rent, flexible / payment plan
    available" and "No pets" - both rows gone; the comment's "the deposit
    row ... proves this load carries the applied values" anchor needs a new
    positive anchor (e.g. "No application fee", if it comes from the Apply).
  - :406-416 `toMatchObject({ no_pets, pets, pet_fee, deposit_one_month,
    deposit_flexible, deposit, ... })` - those keys are absent now (S1's
    D1); `NEVER_ON_FLYER` (:50-56) should gain the ten keys.
  - :14-17 header comment (O1 "No pets" on the flyer).
- `e2e/tests/dashboard-next/contact-detail.spec.ts:187` landlord
  `Pet fee` `toHaveAccessibleDescription(/On property flyers/)` ->
  `/Staff only/` (the :163 legend line is unchanged).
- `e2e/support/selectors.md:137` "Public flyer (`/p/:unitId`) | requirement
  rows" - Pets / Pet fee / Deposit rows are gone; add the heading
  (`getByRole('heading', { level: 1, name: <street line> })`; the Maps link
  `getByRole('link', { name: /open in Google Maps/ })`, named
  `<street line> <city line> - open in Google Maps`), the highlight
  (`getByText('Same-day tours available', { exact: true })` - a bare
  `getByText('Same-day')` now matches it AND the `Same-day RTA` row), and
  the sign-up box (`getByRole('heading', { name: 'Sign up for home alerts' })`,
  `getByRole('button', { name: 'Sign up', exact: true })`). :44 (the
  thank-you heading) is unchanged.
- No unit test can measure the 320px wrap (`css: false`): S6's flyer spec
  should set a 320px viewport and assert the heading link's box stays inside
  the card (e.g. card `scrollWidth <= clientWidth`) with a long street line.
- Other e2e specs that only put `/p/<unitId>` in a message
  (broadcasts, matching-*, partner-share, share-*, send-outcome-reconcile,
  a2p-compliance) read no flyer content - unaffected.

## 7. S3 - App: ledger keys, flyer apply, decline token (O1), outcome signed_up (Tasks 3.x)

Spec decisions owned: D7 (the flyer share entry, the current-decline refusal,
O1), D8 (the `signed_up` outcome, its derivation and its five callers).
Binding interfaces implemented: plan 2.1, 2.2, 2.3, 2.4; rulings AR1, AR2,
AR7, AR13, AR15.
Slice order (AR4): S1 -> S2 -> S3 -> S4 -> S5 -> S6. S3 needs nothing from S1
or S2 (it touches no file they edit); S4 and S5 build on it.
Tasks: 3.1 keys leaf + summarize; 3.2 O1 decline token; 3.3 applyFlyerShareEntry;
3.4 `signed_up` outcome + every caller's wire; 3.5 (AR13) a nameless resolved
recipient's "Sent to" label is its formatted phone. Task order is binding:
3.3's race test needs 3.2's token, 3.4's caller tests seed through 3.3's
writer, 3.5's tests read 3.4's `signed_up`.

## A. CONTRACT ISSUES (for the planner to rule)

RULED - AR7 (2026-10-21): all five accepted / confirmed; none is open. Kept
below as the record the ruling cites. Plan review round 1 added AR13 (Task
3.5), AR15 (full app suite at the exit check) and the section 0 ground rules
(slice report, commit messages); no new contract issue arises from them.

1. (Informational - no deviation.) Plan 2.3 says "the conformance normalizer
   treats `shares_op` as an opaque token". It ALREADY does:
   `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts:928-938`
   reduces it to `'<op>'`. Because of that, the existing per-step row compare
   cannot see a fake that FAILS to stamp on a decline whenever the row already
   had a token. S3 leaves the normalizer unchanged and adds a step whose RESULT
   (`{ wrote, put }`) exposes a non-stamping fake, plus a legacy-row step where
   the token's presence differs. Ruling requested: accept.
2. Plan 2.2's private helper: S3 names the predicate `veto(row)` (the plan's
   `refuse(row)`) so it is never confused with the `'refused'` RESULT of the
   order rule, and the helper takes `lostIds` beside `lostLine`:
   `{ broadcastId }` on the broadcast path (keeps `applyShareLedgerEntry`'s
   ERROR fields byte-identical) and `{ shareKey: 'flyer' }` on the flyer path
   (so no log line ever carries `broadcastId: 'flyer'`). Private only; no
   binding signature changes. Ruling requested: accept.
3. D8 is type-blind by construction (plan 2.4 derives from the row): a
   MISSING recipient (`routes/units.ts:240`, `recipientType: undefined`) and an
   `unknown` contact also read `signed_up`, and so would a partner / landlord
   pair if one ever held a flyer entry (S4 writes none for them). S3 pins
   tenant, unknown and missing on the units wire. S5 must file a missing /
   ineligible `signed_up` row under "Not eligible" (spec D8 already says so).
   Ruling requested: confirm type-blind is intended.
4. (Informational.) Plan 2.4: "Every switch / map over `ListingSendOutcome` in
   the app handles `signed_up` (typecheck finds them)". The app has NONE (grep
   of `app/src` and `app/scripts`): the only readers are `isWaiting`
   (`listingSendOutcome.ts:123`, `!== 'no_reply' && !== 'replied'`) and
   `routes/broadcasts.ts:619` (`=== 'not_interested'`); both already treat
   `signed_up` correctly. No app edit beyond `listingSendOutcome.ts`; the
   exhaustive switches are dashboard-side (S5).
5. Spec section 4 names `shareAttemptOrder.ts (the attempt-key form)` as a
   surface; plan 2.1 puts `flyerAttemptKey` in `shareLedgerKeys.ts`. S3 keeps
   the function where 2.1 binds it and adds only a header doc sentence to
   `shareAttemptOrder.ts` naming the `<iso>#flyer` form. Ruling requested:
   accept.

## B. Facts the tasks rely on (verified on this worktree, branch feat/flyer-leads @7ac1f2e3)

Ledger service `app/src/services/shareLedger.ts` (all ASCII today):
- `:24` `import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys } from '../lib/shareAttemptOrder.js';`
- `:39-41` `const MAX_REAPPLY = 3;` then `/** The entry key of an individual send (a seeded legacy row with no share id). */` / `const INDIVIDUAL_KEY = 'individual';` (private; used at `:74` and `:119`).
- `:49-56` `ledgerEntryFor(attempt, conversationId, outcome)`: `countedAt` is `new Date(attemptKeyTimestampMs(attempt)).toISOString()`; `{ kind: 'accepted' }` -> `{ attempt, state: 'counted', by: 'acceptance', countedAt }` (no `conversationId` key when undefined).
- `:68-75` `seeded(row)`: `row.shares` copy; else a legacy row seeds `!legacy` (broadcastId) or `individual` (`!individual`) at `row.sentAt`.
- `:78-90` `mayReplace`: a NEWER attempt replaces; the SAME counted-by-acceptance attempt never re-counts by acceptance; an OLDER one only as a delivery.
- `:112-120` `summarize`: picks the latest counted entry with a strict string `>` (`if (latest === undefined || e.countedAt > latest.at)`) and `broadcastId: latest.key === INDIVIDUAL_KEY ? undefined : latest.key`.
- `:132-145` `ledgerWouldChange` (the repair census) calls `seeded`, `mayReplace`, `summarize` - so it sees every entry, a flyer one included.
- `:178-195` `applyShareLedgerEntry`: the loop, then `deps.log.error({ unitId, contactId, broadcastId, attempt, state }, 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it')`.

Attempt order `app/src/lib/shareAttemptOrder.ts`: `:31-38` `attemptKeyTimestampMs(key)` parses the ISO before the first `#` (so `<iso>#flyer` carries its instant); `:27-29` `compareAttemptKeys` is plain string order; `:5-9` header ends `entry is \`!legacy\` (\`!\` sorts before any year digit). Import-free leaf.`

Outcome lib `app/src/lib/listingSendOutcome.ts` (all ASCII):
- `:8-9` `//   - deriveListingSendOutcome: not_interested > interested > replied >` / `//     no_reply, and a non-tenant recipient never reads a tour;`
- `:18` `import type { TourSignal } from './listingSendTour.js';`
- `:20` `export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';`
- `:47-59` `effectiveDecline(row, tourActivityAt)`: false with no record; true when `declinedMs >= sentMs` or the row has no `sentAt`; tours can supersede.
- `:67-83` `deriveListingSendOutcome`: `row: { declined?: DeclineRecord; sentAt?: string };` ... `if (heardMs !== undefined && sentMs !== undefined && heardMs > sentMs) return 'replied';` / `return 'no_reply';`
- `:123` `if (input.outcome !== 'no_reply' && input.outcome !== 'replied') return false;` (isWaiting).

Listing-sends repo `app/src/repos/listingSendsRepo.ts` (9 pre-existing non-ASCII bytes - use the added-lines ASCII check):
- `:14-25` the NO-RESET comment; `:18-21` reads `// or REMOVEs it, and NO writer resets it except clearDeclined. The outcome` / `// route's two writers, setDeclined / clearDeclined, touch ONLY \`declined\` and` / `// \`updated_at\`, conditioned on a COUNTED row. A cleared decline's history`.
- `:36-37` `// read-modify-write on the row's change token (\`shares_op\`, stamped fresh by` / `// each putShareMemory); services/shareLedger.ts is its one caller. A legacy row`
- `:41` `import { randomUUID } from 'node:crypto';` (already imported).
- `:102` `/** share-sent-outcome D7: the per-share memory, keyed by broadcastId (or \`individual\`). Absent on a legacy row. */`
- `:104` `/** share-sent-outcome D7: the change token every putShareMemory stamps (a random id, never a clock). */`
- `:180-182` putShareMemory doc: `` `expect.token` is undefined, `attribute_not_exists(shares_op)` (an absent `` / `row OR a seeded/legacy row nobody has written memory on).`
- `:197` `* last-heard-from spec 5.4: SET \`declined\` (and \`updated_at\`) on a COUNTED`; `:204` `* REMOVE \`declined\` (SET \`updated_at\`) under the same condition. Idempotent`
- `:368-396` setDeclined: `UpdateExpression: 'SET #declined = :declined, #updatedAt = :now',` with names `#declined #updatedAt #unitId #counted` and values `:declined :now :false`.
- `:398-427` clearDeclined: `UpdateExpression: 'SET #updatedAt = :now REMOVE #declined',`; values on one line `ExpressionAttributeValues: { ':now': now, ':false': false, ...(expectedAt !== undefined && { ':readAt': expectedAt }) },`.
- The only callers of setDeclined / clearDeclined are the outcome route (`routes/units.ts:1656,1671,1700`).
- The dev listing-send fixture is CREATE-ONLY (`routes/dev.ts:1452-1458` refuses an existing row before its tokenless `putShareMemory`), and the seed runner Puts whole rows, so O1 cannot strand either.

Harness fake `app/test/helpers/twilioWebhookHarness.ts` (156 pre-existing non-ASCII bytes):
- `:3638-3650` setDeclined, comment `// written. They touch ONLY \`declined\` + \`updated_at\`, so putShareMemory` / `// (which mutates its own fields in place) never clobbers a decline. Held`; body ends `row.declined = JSON.parse(JSON.stringify(record)) as DeclineRecord;` / `row.updated_at = new Date().toISOString();` / `return 'ok';`
- `:3653-3660` clearDeclined body ends `delete row.declined;` / `row.updated_at = new Date().toISOString();` / `return 'ok';` (each anchor occurs once).
- `randomUUID` is already used there (`:3628 row.shares_op = randomUUID();`).

Conformance suite `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (ASCII): `:928-938` normalizer; `:951-959` `shareMemory(...)` step; `:962-978` `seedLegacyRow`; `:998-1013` `declineStep` / `clearDeclineStep`; `:1015` `const LS_CASES: LsCase[] = [`; last case ends `:1072-1076` `shareMemory('unit-2', 'c2', LS_CLEARED, 'current', true),` / `clearDeclineStep('unit-2', 'c2', 'not_found', T1),` / `],` / `},` / `];`. `T1 = '2026-09-26T12:00:05.000Z'`, `LS_A1`, `LS_COUNTED`, `LS_RECOUNTED` exist.

Repo integration test `app/test/listingSendsRepo.integration.test.ts`: `:155` `it('setDeclined stores the record on a counted row and touches nothing else', async () => {`; `:168` `expect(after?.shares_op).toBe(before?.shares_op); // not a memory write` (the pin O1 flips); `:239` `it("an UNCOUNTED row is not declinable: both writers answer 'not_found' and write nothing", async () => {`; `ShareMemoryWrite` and `DeclineRecord` are imported; `DECLINE = { at: '2026-06-17T09:00:00.000Z', by: 'staff', staffId: 'usr_test' }`.

The five `deriveListingSendOutcome` callers all pass the FULL stored item (no projection, no narrowed copy):
- `routes/contacts.ts:1304` `const rows = await listingSends.listByContact(contactId);` -> `:1324` `deriveListingSendOutcome({ row,` (byContact GSI is projection ALL: `infra/modules/dynamodb/main.tf:57 projection_type = "ALL"`, `lib/tables.ts:14`).
- `routes/units.ts:236` `function projectRecipientRow(row: ListingSendItem, ...)` -> `:240` (missing contact, `recipientType: undefined`) and `:260`; its callers pass `listByUnit` rows (`:1479`) and the outcome route's consistent re-read (`:1743 res.json({ row: projectRecipientRow(after, unit, join) })`).
- `services/followUps.ts:139` `(await deps.listingSends.listByUnit(unit.unitId)).filter(...)` -> `:168`; kept only when `isWaiting` (`:180`).
- `routes/broadcasts.ts:596` `const declinedRows = (await listingSends.listByUnit(unitId)).filter((r) => r.declined !== undefined);` -> `:612`; `:619` `if (outcome === 'not_interested') out.add(row.contactId);` feeds D5 `checkedByDefault` (`lib/blastAudienceRules.ts:62-64`: `hasConsent && (seeded || (!alreadySent && !declined && !held))`). `alreadySent` reads BROADCASTS (`priorRecipientKeys`, `broadcasts.ts:820-822`), never listing_sends.
- `ListingSendItem.shares` is `Record<string, ShareLedgerEntry>`, assignable to plan 2.4's `Record<string, { state: string; countedAt?: string }>`, so no caller edit is needed.
- Outcome route `routes/units.ts:1553-1556`: `if (row === undefined || !ledgerRowCounted(row)) { ... 'send_not_found' }` - any counted row, a flyer-counted one included.

Repair script `app/scripts/repair-share-outcomes.ts:824-833`: the census forecasts with `ledgerWouldChange(before, share.broadcastId, forecast)`; `:846-848` the apply writes through `applyShareLedgerEntry`. No script edit is needed; S3 pins that a flyer entry keeps the pair counted (an `update`, not an `uncount`).

Timeline `app/src/routes/contactTimeline.ts:732` `if (entry === undefined) return row.counted === false ? 'Property text failed' : 'Property sent';` - only a pin whose share has NO entry (or a pre-branch pin with no share id) reads the PAIR; a pin whose share entry failed keeps reading that entry.

Test helpers: `app/test/helpers/listingSendSeed.ts` (ASCII) - `:20` `/** The service logs only a lost write, which this helper throws on anyway. */`, `:21` `const log = createLogger({ level: 'silent' });`, imports `applyShareLedgerEntry` from `../../src/services/shareLedger.js`. `createLogCapture().atLevel(n)` filters `level === n` (info 30, error 50). Log lines carry `msg`.

Test-file anchors (each unique): `shareLedger.test.ts:102` `  it('a lost condition re-reads and re-applies; past the bound it reports lost with one ERROR', async () => {`; `contactTimeline.test.ts` `  it('a ledger read failure leaves the stored labels and logs one ERROR', async () => {` (inside the D6 describe that defines `TENANT_D6`, `seedTenant`, `seedPin`, `seedEntry`, `pinLabels`, `authedGet`, `minutesAgo`; pins list OLDEST first); `repairShareOutcomes.test.ts:808` `  it('the CLI contract: --env local|dev|prod, --lane with local only, --broadcast <id>, --apply; anything else is a usage error', () => {` and `:53` `import { seedListingSend } from './helpers/listingSendSeed.js';`; `broadcastApi.test.ts` `    it('checkedByDefault is the ONE server rule: a seed is checked whatever its flags;` (inside describe `matching-blast-rules D4/D5/D7: the preview review rows`, which defines `declinedRow`, `preview`, `rowsById`, `SENT = '2026-10-01T12:00:00.000Z'`, `DECLINED_AT = '2026-10-02T12:00:00.000Z'`; `seedTenant` defaults `status: 'searching'` and `consent_method: 'inbound_text'`; `createDraft(app)` makes a unit-1 tenant filter draft); `broadcastApi.test.ts:44` `import { createSendMessageService } from '../src/services/sendMessage.js';`; `listingSendsApi.test.ts:11` and `listingSendOutcomeApi.test.ts:9` `import { seedListingSend } from './helpers/listingSendSeed.js';`; `contactTimeline.test.ts:29` `import { createLogCapture } from './helpers/logCapture.js';`.

AR13 facts (Task 3.5):
- `app/src/routes/units.ts:183-194` `function displayNameOfContact(contact: { contactId: string; firstName?: unknown; lastName?: unknown; }): string | undefined` - trimmed first/last join, `undefined` without a name. It has EIGHT callers (`:268`, `:473`, `:650`, `:1871`, `:2123`, `:2249`, `:2522`, `:2573` - rosters, placements, landlord names), so AR13 does NOT change it: a new `recipientLabelOf` wraps it for the recipients projection only.
- `:196-201` the anchor `/**` / ` * caseworkers D20 (plan 3.7, ruling R3-F3): a recipients row's contact type and` / ` * role, from the recipient display projection. \`role\` only when it holds text;` then `function recipientFactsOf(contact: RecipientDisplay): ListingSendRecipientFacts {`.
- `:268` `  const tenantName = displayNameOfContact(contact);` (unique - every other caller assigns `name`), inside `projectRecipientRow`, which serves BOTH the units recipients GET (`:1496`) and the outcome route's re-projection (`:1743`). A MISSING recipient returns earlier (`:238-256`) with no tenantName.
- `:120` `import { formatAddress } from '../lib/address.js';`; units.ts imports nothing from `../lib/phone.js` yet. units.ts carries 142 pre-existing non-ASCII bytes.
- `app/src/lib/phone.ts:73-77` `formatPhoneForDisplay(e164: string | undefined): string | undefined` - `undefined` for an absent / empty number, `(NNN) NNN-NNNN` for a `+1` ten-digit number, any other value returned AS IS. Precedent `app/src/lib/groupTitle.ts:56` `const label = first.length > 0 ? first : (formatPhoneForDisplay(phone) ?? phone);` (staff chrome only, per its `relayMemberLabels` doc).
- `RecipientDisplay` (`repos/contactsRepo.ts:397`) = `ContactDisplayItem & {...}`, and `ContactDisplayItem` carries `phone?: string` (`:385`); the recipient projection reads `phone`.
- The contact listings-sent read (`routes/contacts.ts:1332-1338`) passes `toListingSendRow(row, { tour, outcome, lastHeardFromAt, declined, interestedSupported })` - it never attaches `tenantName` (its contact is the page owner). So AR13 changes nothing there, and sharing a helper with it is moot: the rule lives in `units.ts` only.
- `repos/listingSendsRepo.ts:132-134` the wire comment: `  /** Denormalized tenant display name, attached by the GET projections (same` / `   *  contacts join as the roster's \`name\`). HONEST - absent when the contact is` / `   *  unknown or has no name; the dashboard then falls back to the id. */`
- The dashboard reads it at `dashboard/src/routes/listing/ListingDetail.tsx:1343` `const name = row.tenantName ?? row.contactId;` (identity link text and the outcome dialogs' `name`). No dashboard edit is needed.
- Two existing tests pin the EXACT units row of a NAMELESS seeded tenant and would break: `app/test/listingSendsApi.test.ts:169` `expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant', interestedMode: 'form', eligible: true });` (after `:152` `    seedTenant(world, 'c-x');`) and `:239` `expect(c1).toEqual({ contactId: 'c-1', unitId: 'unit-1', sentAt: c1.sentAt, via: 'broadcast', tour: { tourId: 'tour-c1', state: 'scheduled' }, type: 'tenant', outcome: 'interested', interestedSupported: true, interestedMode: 'form', eligible: true });` (seeded at `:217-221`). `seedTenant` there gives no name and the phone `+1555010` + the id's last four characters padded with `0` (e.g. `+15550100c-1`), which `formatPhoneForDisplay` passes through as stored. Every other `tenantName` assertion in `app/test` is on a NAMED contact or a MISSING one (`listingSendsApi.test.ts:83`, `:576`) - unaffected. No e2e spec finds a Sent to row by a raw contactId (grep of `e2e/tests`).

Non-ASCII baseline of every pre-existing file S3 touches: 0 bytes in shareLedger.ts, listingSendOutcome.ts, shareAttemptOrder.ts, the conformance suite, shareLedger.test.ts, listingSendOutcome.test.ts, listingSendOutcomeApi.test.ts, followUps.test.ts, repairShareOutcomes.test.ts, listingSendSeed.ts; non-zero in listingSendsRepo.ts (9), the harness (156), listingSendsRepo.integration.test.ts (3), listingSendsApi.test.ts (3), broadcastApi.test.ts (134), contactTimeline.test.ts (66). Always use the ADDED-lines check below.

Verified outside the worktree (scratch only): (1) a prototype of the 3.1 / 3.3 logic, run against the worktree's harness fake with O1 emulated, passed every 3.3 scenario below, the O1 race included; (2) a scratch copy of `app/` with EVERY edit of Tasks 3.1-3.5 applied exactly as written here (the code blocks were extracted from this file) typechecks under `app/tsconfig.test.json` with ZERO new errors against the unmodified copy (tsc 5.9.3, worktree node_modules). The vitest runs themselves were not executed (no shared-DynamoDB runs from a planning agent).

## C. Commands used by every task

Every shell call starts from an explicit `cd` (the cwd resets). Git Bash syntax.

- DynamoDB Local (idempotent START, never a restart - a restart wipes data; ask the human if it is wedged):
  `cd "W:/tmp/flyer-leads" && npm run db:start`
  Every app vitest run needs it; an integration suite whose endpoint is down SKIPS (a false green) - confirm no `SKIPPED - no DynamoDB Local` line in a RED or GREEN run of an `*.integration.test.ts` or `repairShareOutcomes.test.ts`.
- Run app test files (never piped): `cd "W:/tmp/flyer-leads/app" && npx vitest run test/<a>.test.ts test/<b>.test.ts`
- App typecheck (vitest strips types; this is the type gate per task): `cd "W:/tmp/flyer-leads/app" && npm run typecheck`
- ASCII, new file: `cd "W:/tmp/flyer-leads" && tr -d '\11\12\15\40-\176' < app/<path> | wc -c` prints `0`.
- ASCII, pre-existing file (added lines only): `cd "W:/tmp/flyer-leads" && git diff -U0 -- app/<path> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints `0`.
- No literal backslash-u in S3's code; if an Edit ever introduces one, check with `grep -n '\\u' <file>`.
- Commit (one per task): (1) `cd "W:/tmp/flyer-leads" && git status` - read it bare; (2) `test ! -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD" && echo no-merge` prints `no-merge`; (3) `cd "W:/tmp/flyer-leads" && git add <explicit paths>` (never `-A`); (4) the task's `git commit` command, verbatim: repeated `-m` arguments (subject, body, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`) - never a message file inside the worktree (plan section 0, R1 #15).
- Code blocks nested under a list bullet carry the bullet's indent in this file; strip it before using a block as an Edit anchor or replacement - the target file's own indentation is the authority (plan section 0, R1 #13).

---

## Task 3.1 - The keys leaf and summarize on the ONE rule

Goal: create `app/src/lib/shareLedgerKeys.ts` (plan 2.1, AR1) and make `summarize` pick its latest entry with `latestCountedShareKey`, mapping `flyer` like `individual` to no broadcastId (spec D7 "summarize maps the key flyer like individual", D8 "ONE helper").

Files: NEW `app/src/lib/shareLedgerKeys.ts`; NEW `app/test/shareLedgerKeys.test.ts`; `app/src/services/shareLedger.ts`; `app/src/lib/shareAttemptOrder.ts` (header doc only); `app/test/shareLedger.test.ts`.

### Step 1 - tests first

1a. NEW `app/test/shareLedgerKeys.test.ts`:

```ts
// flyer-leads plan 2.1 (AR1): the pure share-ledger keys leaf - the key
// literals, the flyer attempt key, and the ONE "latest counted entry" rule
// that summarize (services/shareLedger.ts) and deriveListingSendOutcome
// (lib/listingSendOutcome.ts) both read. Pure - no I/O.
import { describe, expect, it } from 'vitest';
import { attemptKeyTimestampMs, compareAttemptKeys } from '../src/lib/shareAttemptOrder.js';
import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../src/lib/shareLedgerKeys.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

describe('shareLedgerKeys - the key literals and the flyer attempt key', () => {
  it('the stored key literals', () => {
    expect(INDIVIDUAL_SHARE_KEY).toBe('individual');
    expect(FLYER_SHARE_KEY).toBe('flyer');
  });

  it("flyerAttemptKey is `<iso>#flyer`: it carries the sign-up instant like every attempt key, and a later sign-up is a NEWER attempt", () => {
    const iso = '2026-10-21T15:04:05.678Z';
    expect(flyerAttemptKey(iso)).toBe('2026-10-21T15:04:05.678Z#flyer');
    expect(attemptKeyTimestampMs(flyerAttemptKey(iso))).toBe(Date.parse(iso));
    expect(compareAttemptKeys(flyerAttemptKey(T2), flyerAttemptKey(T1))).toBe(1);
  });
});

describe('latestCountedShareKey - the ONE latest-counted-entry rule', () => {
  it('undefined for no shares, an empty map, nothing counted, or a counted entry without an instant', () => {
    expect(latestCountedShareKey(undefined)).toBeUndefined();
    expect(latestCountedShareKey({})).toBeUndefined();
    expect(latestCountedShareKey({ b1: { state: 'failed' }, b2: { state: 'pending' }, b3: { state: 'unconfirmed' } })).toBeUndefined();
    expect(latestCountedShareKey({ b1: { state: 'counted' } })).toBeUndefined(); // no instant: counts nowhere
  });

  it('the greatest countedAt among COUNTED entries wins; an uncounted entry never does, however late', () => {
    expect(
      latestCountedShareKey({
        b1: { state: 'counted', countedAt: T1 },
        flyer: { state: 'counted', countedAt: T2 },
        b2: { state: 'failed', countedAt: T3 },
      }),
    ).toBe('flyer');
    expect(latestCountedShareKey({ flyer: { state: 'counted', countedAt: T1 }, b1: { state: 'counted', countedAt: T2 } })).toBe('b1');
    expect(latestCountedShareKey({ individual: { state: 'counted', countedAt: T1 } })).toBe('individual');
  });

  it("a tie keeps the FIRST entry in insertion order (summarize's strict >) - keys are never sorted", () => {
    expect(latestCountedShareKey({ zeta: { state: 'counted', countedAt: T1 }, alpha: { state: 'counted', countedAt: T1 } })).toBe('zeta');
    expect(latestCountedShareKey({ alpha: { state: 'counted', countedAt: T1 }, zeta: { state: 'counted', countedAt: T1 } })).toBe('alpha');
  });
});
```

1b. `app/test/shareLedger.test.ts` - insert a new case directly BEFORE the anchor
`  it('a lost condition re-reads and re-applies; past the bound it reports lost with one ERROR', async () => {`
(it uses the file's own `fakeLedger`, `deps`, `write`, `A1`; the key and attempt are written as literals on purpose - they pin the STORED values):

```ts
  it("flyer-leads D7: a `flyer` entry that is the pair's latest counted entry gives the pair NO broadcastId (summarize maps it like `individual`); a later broadcast entry takes sentAt and broadcastId back", async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'accepted');
    const flyer = ledgerEntryFor('2026-09-28T10:30:00.000Z#flyer', undefined, { kind: 'accepted' });
    expect(await applyShareLedgerEntry(deps(f), { unitId: 'u', contactId: 'c', broadcastId: 'flyer', entry: flyer })).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T10:30:00.000Z' });
    expect(f.row?.broadcastId).toBeUndefined();
    expect(f.row?.shares?.['b1']).toMatchObject({ state: 'counted', countedAt: '2026-09-28T10:00:00.000Z' });
    expect(await write(f, 'b2', '2026-09-28T11:00:00.000Z#SM3', 'accepted')).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T11:00:00.000Z', broadcastId: 'b2' });
  });

```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/shareLedgerKeys.test.ts test/shareLedger.test.ts`

Expected: `shareLedgerKeys.test.ts` fails to load (cannot resolve `../src/lib/shareLedgerKeys.js`); in `shareLedger.test.ts` exactly the new case fails on `expect(f.row?.broadcastId).toBeUndefined()` - received `'flyer'` (today's summarize names any non-`individual` key as the broadcastId). Every other shareLedger case passes.

### Step 3 - implementation

3a. NEW `app/src/lib/shareLedgerKeys.ts`:

```ts
/**
 * flyer-leads plan 2.1 (assembly ruling AR1): the share-ledger KEYS and the
 * ONE "latest counted entry" rule. A pure, import-free leaf, because
 * services/shareLedger.ts (summarize: the pair's sentAt and broadcastId) and
 * lib/listingSendOutcome.ts (deriveListingSendOutcome: `signed_up`, spec D8)
 * must read the SAME entry, and lib/ never imports services/.
 *
 * A pair's row (listingSendsRepo `shares`) holds one entry per share, keyed
 * by the share's broadcastId, by `individual` (a seeded legacy row with no
 * share id) or by `flyer` (a flyer sign-up, spec D7).
 */

/** The entry key of an individual send (a seeded legacy row with no share id). */
export const INDIVIDUAL_SHARE_KEY = 'individual';

/** flyer-leads D7: the entry key of a flyer sign-up. */
export const FLYER_SHARE_KEY = 'flyer';

/**
 * flyer-leads D7: the attempt key of a flyer sign-up at `iso` - `<iso>#flyer`.
 * Like every attempt key it carries its instant before the first `#`
 * (shareAttemptOrder.attemptKeyTimestampMs), so the entry's countedAt is the
 * sign-up instant and a later sign-up is a NEWER attempt.
 */
export function flyerAttemptKey(iso: string): string {
  return `${iso}#${FLYER_SHARE_KEY}`;
}

/**
 * The key of the pair's LATEST counted entry: an entry whose state is
 * 'counted' AND that carries a string countedAt (an entry without an instant
 * counts nowhere). The greatest countedAt wins, compared as strings exactly
 * as summarize always has (countedAt is a normalized ISO); a tie keeps the
 * FIRST entry in Object.entries order (a strict `>`). Keys are never sorted.
 * undefined when no entry counts.
 */
export function latestCountedShareKey(
  shares: Record<string, { state: string; countedAt?: string }> | undefined,
): string | undefined {
  if (shares === undefined) return undefined;
  let latest: { key: string; at: string } | undefined;
  for (const [key, e] of Object.entries(shares)) {
    if (e.state !== 'counted' || typeof e.countedAt !== 'string') continue;
    if (latest === undefined || e.countedAt > latest.at) latest = { key, at: e.countedAt };
  }
  return latest?.key;
}
```

3b. `app/src/services/shareLedger.ts`:
- After the anchor line `import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys } from '../lib/shareAttemptOrder.js';` add:
  `import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, latestCountedShareKey } from '../lib/shareLedgerKeys.js';`
- Delete these two lines (anchor `:40-41`):
  ```ts
  /** The entry key of an individual send (a seeded legacy row with no share id). */
  const INDIVIDUAL_KEY = 'individual';
  ```
- In `seeded`, replace `: { [INDIVIDUAL_KEY]: { attempt: INDIVIDUAL_ATTEMPT_KEY,` with `: { [INDIVIDUAL_SHARE_KEY]: { attempt: INDIVIDUAL_ATTEMPT_KEY,` (rest of the line unchanged).
- Replace the whole summarize doc comment + function (anchor: from `/**` / ` * The pair-level fields the entries imply: \`counted\` while a counted entry` through the function's closing `}` at `:120`) with:

```ts
/**
 * The pair-level fields the entries imply: `counted` while a counted entry
 * (with its instant) exists; `sentAt` = the latest such instant and
 * `broadcastId` = that entry's share - absent for `individual` and, since
 * flyer-leads D7, for `flyer` (neither is a broadcast). The latest entry is
 * latestCountedShareKey's (lib/shareLedgerKeys.ts - the ONE rule the outcome
 * derivation reads too). So a counted row always carries sentAt, and an
 * un-counted one never does.
 */
function summarize(shares: Record<string, ShareLedgerEntry>): Pick<ShareMemoryWrite, 'counted' | 'sentAt' | 'broadcastId'> {
  const key = latestCountedShareKey(shares);
  const sentAt = key === undefined ? undefined : shares[key]?.countedAt;
  if (key === undefined || sentAt === undefined) return { counted: false, sentAt: undefined, broadcastId: undefined };
  return { counted: true, sentAt, broadcastId: key === INDIVIDUAL_SHARE_KEY || key === FLYER_SHARE_KEY ? undefined : key };
}
```

(`ledgerEntryCounts` stays exported and unchanged - the repair script imports it.)

3c. `app/src/lib/shareAttemptOrder.ts` header (doc only) - replace the anchor line
` * entry is \`!legacy\` (\`!\` sorts before any year digit). Import-free leaf.`
with:
```
 * entry is `!legacy` (`!` sorts before any year digit). A flyer sign-up's
 * attempt (flyer-leads D7, lib/shareLedgerKeys.ts flyerAttemptKey) is
 * `<sign-up ISO>#flyer`: an ordinary key whose instant is the sign-up's, so a
 * later sign-up is a newer attempt. Import-free leaf.
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/shareLedgerKeys.test.ts test/shareLedger.test.ts test/shareAttemptOrder.test.ts test/listingSendsRepoShares.integration.test.ts test/repairShareOutcomes.test.ts`
All pass (the last two are regression: the census and the real repo still agree). Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` exits 0.

### Step 5 - ASCII

New: `app/src/lib/shareLedgerKeys.ts`, `app/test/shareLedgerKeys.test.ts` (full-file check). Touched: `app/src/services/shareLedger.ts`, `app/src/lib/shareAttemptOrder.ts`, `app/test/shareLedger.test.ts` (added-lines check). All print `0`.

### Step 6 - commit

Paths: `app/src/lib/shareLedgerKeys.ts app/test/shareLedgerKeys.test.ts app/src/services/shareLedger.ts app/src/lib/shareAttemptOrder.ts app/test/shareLedger.test.ts`

Command (repeated `-m`, plan section 0 - no message file):
```
cd "W:/tmp/flyer-leads" && git commit -m "feat(ledger): shareLedgerKeys leaf - one latest-counted-entry rule; summarize maps the flyer key like individual" -m "flyer-leads D7/D8, plan 2.1 (AR1): INDIVIDUAL_SHARE_KEY, FLYER_SHARE_KEY, flyerAttemptKey and latestCountedShareKey live in a pure lib leaf so the ledger summary and the outcome derivation read the same entry. A flyer entry never names a broadcastId." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.2 - O1: the decline writers stamp a fresh change token

Goal: `setDeclined` / `clearDeclined` SET `shares_op` to a fresh `randomUUID()` (plan 2.3; spec D7 O1, Cameron 2026-10-21 "let's close it"), so a ledger write that read the row before a decline loses its condition and re-reads. The harness fake mirrors it and the NO-RESET comment records why.

Files: `app/src/repos/listingSendsRepo.ts`; `app/test/helpers/twilioWebhookHarness.ts`; `app/test/listingSendsRepo.integration.test.ts`; `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`.

### Step 1 - tests first

1a. `app/test/listingSendsRepo.integration.test.ts`:
- Replace the anchor title line
  `    it('setDeclined stores the record on a counted row and touches nothing else', async () => {`
  with
  `    it('setDeclined stores the record on a counted row, stamps a fresh change token (flyer-leads O1) and touches nothing else', async () => {`
- Replace the anchor line
  `      expect(after?.shares_op).toBe(before?.shares_op); // not a memory write`
  with:
  ```ts
      // flyer-leads O1: a decline stamps a FRESH change token, so a ledger
      // write that read the row before it loses its condition and re-reads.
      expect(typeof after?.shares_op).toBe('string');
      expect(after?.shares_op).not.toBe(before?.shares_op);
  ```
- Insert directly BEFORE the anchor
  `    it("an UNCOUNTED row is not declinable: both writers answer 'not_found' and write nothing", async () => {`
  this case:

```ts
    it('flyer-leads O1: a token read BEFORE either decline writer loses its condition after it; clearDeclined stamps a fresh token too; a compare-and-clear that loses writes nothing (the token stays)', async () => {
      const unitId = `unit-${randomUUID().slice(0, 8)}`;
      const contactId = `contact-${randomUUID().slice(0, 8)}`;
      await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
      const next: ShareMemoryWrite = {
        shares: { 'bcast-2': { attempt: '2026-06-18T10:00:00.000Z#SM2', state: 'counted', by: 'acceptance', countedAt: '2026-06-18T10:00:00.000Z' } },
        counted: true,
        sentAt: '2026-06-18T10:00:00.000Z',
        broadcastId: 'bcast-2',
      };
      const t0 = (await repo.getByKeyConsistent(unitId, contactId))?.shares_op;
      expect(await repo.setDeclined(unitId, contactId, DECLINE)).toBe('ok');
      expect(await repo.putShareMemory(unitId, contactId, next, { token: t0 })).toBe(false); // the racing ledger write loses
      const t1 = (await repo.getByKeyConsistent(unitId, contactId))?.shares_op;
      expect(t1).not.toBe(t0);
      // A compare-and-clear that loses (a stale expectedAt) writes nothing - the token stays.
      expect(await repo.clearDeclined(unitId, contactId, { expectedAt: '2026-06-17T08:00:00.000Z' })).toBe('not_found');
      expect((await repo.getByKeyConsistent(unitId, contactId))?.shares_op).toBe(t1);
      expect(await repo.clearDeclined(unitId, contactId, { expectedAt: DECLINE.at })).toBe('ok');
      const t2 = (await repo.getByKeyConsistent(unitId, contactId))?.shares_op;
      expect(typeof t2).toBe('string');
      expect(t2).not.toBe(t1);
      expect(await repo.putShareMemory(unitId, contactId, next, { token: t1 })).toBe(false);
      expect(await repo.putShareMemory(unitId, contactId, next, { token: t2 })).toBe(true); // the re-read token wins
    });

```

1b. `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`:
- Insert directly BEFORE the anchor line `const LS_CASES: LsCase[] = [` this step builder:

```ts
/**
 * flyer-leads O1: a decline writer runs BETWEEN a ledger write's read and its
 * write - read the token, run setDeclined / clearDeclined, then putShareMemory
 * on the token read before it. Both writers stamp a fresh token, so the put
 * loses (false) in BOTH implementations. The RESULT carries the put's answer:
 * the normalized row compare alone cannot see a fake that skips the stamp on
 * a row that already had a token (normalizeLedgerRow reduces it to '<op>').
 */
const tokenAcrossDecline = (unit: string, contact: string, writer: 'set' | 'clear', next: ShareMemoryWrite): LsStep => ({
  label: `putShareMemory ${unit}/${contact} on the token read before ${writer === 'set' ? 'setDeclined' : 'clearDeclined'}`,
  run: async (repo, ctx) => {
    const unitId = lsUnit(ctx, unit);
    const contactId = lsContact(ctx, contact);
    const before = (await repo.getByKeyConsistent(unitId, contactId))?.shares_op;
    const wrote =
      writer === 'set'
        ? await repo.setDeclined(unitId, contactId, { at: T1, by: 'staff', staffId: 'usr_parity' })
        : await repo.clearDeclined(unitId, contactId);
    const put = await repo.putShareMemory(unitId, contactId, structuredClone(next), { token: before });
    return { wrote, put };
  },
  expect: { wrote: 'ok', put: false },
});

```

- Replace the anchor (the end of the LAST case and of the array)
  ```ts
      shareMemory('unit-2', 'c2', LS_CLEARED, 'current', true),
      clearDeclineStep('unit-2', 'c2', 'not_found', T1),
    ],
  },
];
  ```
  with:
  ```ts
      shareMemory('unit-2', 'c2', LS_CLEARED, 'current', true),
      clearDeclineStep('unit-2', 'c2', 'not_found', T1),
    ],
  },
  {
    name: 'flyer-leads O1: both decline writers stamp a fresh change token - a token read before setDeclined or clearDeclined loses its condition after it; a legacy row gains a token from its first decline',
    watch: [['unit-1', 'c1'], ['unit-mx', 'c-mx']],
    steps: [
      shareMemory('unit-1', 'c1', LS_COUNTED, 'none', true),
      tokenAcrossDecline('unit-1', 'c1', 'set', LS_RECOUNTED),
      shareMemory('unit-1', 'c1', LS_RECOUNTED, 'current', true),
      tokenAcrossDecline('unit-1', 'c1', 'clear', LS_COUNTED),
      seedLegacyRow('unit-mx', 'c-mx'),
      tokenAcrossDecline('unit-mx', 'c-mx', 'set', { shares: { 'b-old': { ...LS_A1, attempt: '!legacy' } }, counted: true, sentAt: T0, broadcastId: 'b-old' }),
    ],
  },
];
  ```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads" && npm run db:start` then
`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendsRepo.integration.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts`

Expected (confirm neither suite printed `SKIPPED`): the setDeclined case fails `expected '<uuid>' not to be '<uuid>'` (today a decline leaves the token); the new O1 repo case fails at its first `putShareMemory ... toBe(false)` (received `true`); the new conformance case fails on `the script's expectation` - the REAL answer is `{ wrote: 'ok', put: true }`. All other cases pass.

### Step 3 - implementation

3a. `app/src/repos/listingSendsRepo.ts` comments:
- Replace (anchor `:18-21`)
  ```
  // or REMOVEs it, and NO writer resets it except clearDeclined. The outcome
  // route's two writers, setDeclined / clearDeclined, touch ONLY `declined` and
  // `updated_at`, conditioned on a COUNTED row. A cleared decline's history
  ```
  with
  ```
  // or REMOVEs it, and NO writer resets it except clearDeclined. The outcome
  // route's two writers, setDeclined / clearDeclined, touch ONLY `declined`,
  // `updated_at` and the change token `shares_op`, conditioned on a COUNTED
  // row. flyer-leads O1: each stamps a FRESH token, so a ledger write that read
  // the row before a decline landed loses its condition, re-reads and sees the
  // decline (the flyer entry's current-decline refusal is decided on that
  // re-read - services/shareLedger.ts applyFlyerShareEntry). A cleared decline's history
  ```
- Replace (anchor `:36-37`)
  ```
  // read-modify-write on the row's change token (`shares_op`, stamped fresh by
  // each putShareMemory); services/shareLedger.ts is its one caller. A legacy row
  ```
  with
  ```
  // read-modify-write on the row's change token (`shares_op`, stamped fresh by
  // each putShareMemory and, since flyer-leads O1, by each decline writer);
  // services/shareLedger.ts is its one caller. A legacy row
  ```
- Replace (anchor `:104`)
  `  /** share-sent-outcome D7: the change token every putShareMemory stamps (a random id, never a clock). */`
  with
  `  /** share-sent-outcome D7: the change token every putShareMemory stamps - and, since flyer-leads O1, every setDeclined / clearDeclined (a random id, never a clock). */`
- Replace (anchor `:182`) `   * row OR a seeded/legacy row nobody has written memory on). \`false\` = the` with `   * row OR a seeded/legacy row nobody has written memory or a decline on). \`false\` = the`
  (read the current `:181-183` text first; only the parenthesis changes).
- Replace (anchor `:197`)
  `   * last-heard-from spec 5.4: SET \`declined\` (and \`updated_at\`) on a COUNTED`
  with
  ```
     * last-heard-from spec 5.4: SET `declined` (and `updated_at` and a fresh
     * `shares_op` - flyer-leads O1) on a COUNTED
  ```
- Replace (anchor `:204`)
  `   * REMOVE \`declined\` (SET \`updated_at\`) under the same condition. Idempotent`
  with
  `   * REMOVE \`declined\` (SET \`updated_at\` and a fresh \`shares_op\`) under the same condition. Idempotent`

3b. `app/src/repos/listingSendsRepo.ts` code. In setDeclined replace the anchor block
```ts
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
```
with
```ts
            // flyer-leads O1: a fresh change token - a ledger write that read
            // the row before this decline loses its condition and re-reads.
            UpdateExpression: 'SET #declined = :declined, #updatedAt = :now, #op = :op',
            ConditionExpression: 'attribute_exists(#unitId) AND (attribute_not_exists(#counted) OR #counted <> :false)',
            ExpressionAttributeNames: {
              '#declined': 'declined',
              '#updatedAt': 'updated_at',
              '#unitId': 'unitId',
              '#counted': 'counted',
              '#op': 'shares_op',
            },
            ExpressionAttributeValues: {
              ':declined': { at: record.at, by: record.by, ...(record.staffId !== undefined && { staffId: record.staffId }) },
              ':now': now,
              ':false': false,
              ':op': randomUUID(),
            },
```
In clearDeclined replace the anchor block
```ts
            UpdateExpression: 'SET #updatedAt = :now REMOVE #declined',
```
with
```ts
            // flyer-leads O1: a fresh change token, as setDeclined.
            UpdateExpression: 'SET #updatedAt = :now, #op = :op REMOVE #declined',
```
then the anchor
```ts
              '#counted': 'counted',
              ...(expectedAt !== undefined && { '#at': 'at' }),
            },
            ExpressionAttributeValues: { ':now': now, ':false': false, ...(expectedAt !== undefined && { ':readAt': expectedAt }) },
```
with
```ts
              '#counted': 'counted',
              '#op': 'shares_op',
              ...(expectedAt !== undefined && { '#at': 'at' }),
            },
            ExpressionAttributeValues: { ':now': now, ':false': false, ':op': randomUUID(), ...(expectedAt !== undefined && { ':readAt': expectedAt }) },
```
(Conditions, return values and log lines are unchanged. A failed condition throws before anything is written, so a lost compare-and-clear keeps the token - the new repo case pins it.)

3c. `app/test/helpers/twilioWebhookHarness.ts` (the listing-sends fake):
- Replace the comment anchor
  ```
      // written. They touch ONLY `declined` + `updated_at`, so putShareMemory
      // (which mutates its own fields in place) never clobbers a decline. Held
  ```
  with
  ```
      // written. They touch ONLY `declined`, `updated_at` and a FRESH
      // `shares_op` (flyer-leads O1: a ledger write that read the row before
      // the decline loses its condition and re-reads), so putShareMemory
      // (which mutates its own fields in place) never clobbers a decline. Held
  ```
- Replace the anchor
  ```ts
      row.declined = JSON.parse(JSON.stringify(record)) as DeclineRecord;
      row.updated_at = new Date().toISOString();
      return 'ok';
  ```
  with
  ```ts
      row.declined = JSON.parse(JSON.stringify(record)) as DeclineRecord;
      row.updated_at = new Date().toISOString();
      row.shares_op = randomUUID();
      return 'ok';
  ```
- Replace the anchor
  ```ts
      delete row.declined;
      row.updated_at = new Date().toISOString();
      return 'ok';
  ```
  with
  ```ts
      delete row.declined;
      row.updated_at = new Date().toISOString();
      row.shares_op = randomUUID();
      return 'ok';
  ```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendsRepo.integration.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/listingSendsRepoShares.integration.test.ts test/listingSendOutcomeApi.test.ts test/listingSendsApi.test.ts test/shareLedger.test.ts`
All pass (no `SKIPPED`). Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` exits 0.

### Step 5 - ASCII

Added-lines check on all four files; each prints `0`.

### Step 6 - commit

Paths: `app/src/repos/listingSendsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/listingSendsRepo.integration.test.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`

Command (repeated `-m`, plan section 0 - no message file):
```
cd "W:/tmp/flyer-leads" && git commit -m "feat(listing-sends): decline writers stamp a fresh shares_op so a racing ledger write re-reads (flyer-leads O1)" -m "Plan 2.3: setDeclined / clearDeclined SET a fresh change token, so a ledger write that read the pair before a decline landed loses its condition, re-reads and sees it. The harness fake mirrors it; the conformance suite and the repo suite pin it." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.3 - applyFlyerShareEntry: the flyer entry, refused by a current decline

Goal: `applyFlyerShareEntry` (plan 2.2, AR2) writes ONE counted flyer entry through the loop `applyShareLedgerEntry` uses, refusing on EACH round's consistent read when `effectiveDecline(row ?? {}, undefined)` (spec D7 "a sign-up never clears a decline", O1, residuals). Also pins the two D7 watch items (repair census, timeline pin words) and adds the `seedFlyerSignUp` test helper.

Files: `app/src/services/shareLedger.ts`; `app/src/repos/listingSendsRepo.ts` (one doc line); `app/test/helpers/listingSendSeed.ts`; NEW `app/test/shareLedgerFlyer.test.ts`; `app/test/repairShareOutcomes.test.ts`; `app/test/contactTimeline.test.ts`.

### Step 1 - tests first

1a. `app/test/helpers/listingSendSeed.ts`:
- Replace the import anchor `import { applyShareLedgerEntry } from '../../src/services/shareLedger.js';` with `import { applyFlyerShareEntry, applyShareLedgerEntry } from '../../src/services/shareLedger.js';`
- Replace `/** The service logs only a lost write, which this helper throws on anyway. */` with `/** The service logs only a lost write or a refused flyer write, which these helpers throw on anyway. */`
- Append at end of file:

```ts

/**
 * flyer-leads D7: seed a flyer sign-up's share entry on a pair THROUGH the
 * service's own writer (applyFlyerShareEntry), so the entry, the pair's
 * sentAt and its broadcastId come from the service and never diverge from
 * what a sign-up writes. Anything but 'written' (a current decline, an equal
 * or older sign-up instant, a lost write) throws: a seed never fails silently.
 */
export async function seedFlyerSignUp(
  repo: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>,
  args: { unitId: string; contactId: string; signedUpAt: string },
): Promise<void> {
  const result = await applyFlyerShareEntry({ listingSends: repo, log }, args);
  if (result !== 'written') {
    throw new Error(`seedFlyerSignUp: the flyer write for ${args.unitId}|${args.contactId} was ${result}`);
  }
}
```

1b. NEW `app/test/shareLedgerFlyer.test.ts`:

```ts
// flyer-leads D7 / O1 (plan 2.2, AR2): applyFlyerShareEntry - a flyer
// sign-up's share entry through the ledger's own read-modify-write; the
// flyer-only CURRENT-decline refusal decided on each round's consistent read;
// the O1 race (a decline landing between the read and the write); the flyer's
// own lost-write line. The listing-sends fake used here is held to the real
// repo by twilioWebhookHarnessRepoAdditions.integration.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { effectiveDecline } from '../src/lib/listingSendOutcome.js';
import { FLYER_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../src/lib/shareLedgerKeys.js';
import type { ListingSendsRepo, ShareMemoryWrite } from '../src/repos/listingSendsRepo.js';
import { applyFlyerShareEntry, applyShareLedgerEntry, ledgerEntryFor } from '../src/services/shareLedger.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

type LedgerRepo = Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>;

const U = 'unit-1';
const C = 'c-1';
/** An earlier share of the pair (a broadcast). */
const SENT = '2026-10-01T12:00:00.000Z';
/** A staff Not interested after that share. */
const DECLINED = '2026-10-02T12:00:00.000Z';
/** Two flyer sign-ups, with milliseconds as `new Date().toISOString()` writes them. */
const SIGNED_1 = '2026-10-03T12:00:00.123Z';
const SIGNED_2 = '2026-10-04T08:30:00.456Z';
const FLYER_LOST_LINE =
  'share ledger: the flyer entry write lost its condition past the re-read bound - not repaired (the repair walks broadcast slots only)';
const FLYER_DECLINED_LINE = 'share ledger: flyer entry not written - the pair holds a current decline';
const SHARED_LOST_LINE = 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it';

function setup() {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  const deps = (listingSends: LedgerRepo = world.listingSendsRepo) => ({ listingSends, log });
  const flyer = (signedUpAt: string, listingSends?: LedgerRepo) =>
    applyFlyerShareEntry(deps(listingSends), { unitId: U, contactId: C, signedUpAt });
  const row = () => world.listingSendsRepo.getByKeyConsistent(U, C);
  const sent = (sentAt = SENT, broadcastId = 'b-1') =>
    seedListingSend(world.listingSendsRepo, { unitId: U, contactId: C, sentAt, broadcastId });
  return { world, capture, deps, flyer, row, sent };
}

describe('applyFlyerShareEntry (flyer-leads D7)', () => {
  it('a NEW pair: one counted-by-acceptance flyer entry, sentAt = the sign-up instant, no broadcastId', async () => {
    const { flyer, row } = setup();
    expect(await flyer(SIGNED_1)).toBe('written');
    const r = await row();
    expect(r).toMatchObject({ counted: true, sentAt: SIGNED_1 });
    expect(r?.broadcastId).toBeUndefined();
    expect(r?.shares).toStrictEqual({
      [FLYER_SHARE_KEY]: { attempt: flyerAttemptKey(SIGNED_1), state: 'counted', by: 'acceptance', countedAt: SIGNED_1 },
    });
    expect(r?.shares?.['flyer']?.attempt).toBe('2026-10-03T12:00:00.123Z#flyer');
  });

  it('a pair already sent (whether or not the tenant replied - a contact fact, D8) gets the flyer entry as its LATEST counted entry; the sent share is kept; a legacy row keeps its seeded entry', async () => {
    const { world, deps, flyer, row, sent } = setup();
    await sent();
    expect(await flyer(SIGNED_1)).toBe('written');
    const r = await row();
    expect(latestCountedShareKey(r?.shares)).toBe(FLYER_SHARE_KEY);
    expect(r).toMatchObject({ counted: true, sentAt: SIGNED_1 });
    expect(r?.broadcastId).toBeUndefined();
    expect(r?.shares?.['b-1']).toMatchObject({ state: 'counted', countedAt: SENT });

    world.listingSends.push({ unitId: 'unit-legacy', contactId: C, sentAt: SENT, via: 'broadcast', broadcastId: 'b-old', created_at: SENT, updated_at: SENT });
    expect(await applyFlyerShareEntry(deps(), { unitId: 'unit-legacy', contactId: C, signedUpAt: SIGNED_1 })).toBe('written');
    const legacy = await world.listingSendsRepo.getByKeyConsistent('unit-legacy', C);
    expect(legacy?.shares?.['b-old']).toMatchObject({ attempt: '!legacy', state: 'counted', countedAt: SENT });
    expect(legacy).toMatchObject({ counted: true, sentAt: SIGNED_1 });
  });

  it('a CURRENT decline (at or after sentAt) answers declined: nothing written, ONE INFO line with ids only', async () => {
    const { world, capture, flyer, row, sent } = setup();
    await sent();
    expect(await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff', staffId: 'usr_x' })).toBe('ok');
    const before = await row();
    expect(effectiveDecline(before!, undefined)).toBe(true);
    expect(await flyer(SIGNED_1)).toBe('declined');
    expect(await row()).toStrictEqual(before);
    const info = capture.lines.filter((l) => l['msg'] === FLYER_DECLINED_LINE);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ level: 30, unitId: U, contactId: C });
    expect(info[0]).not.toHaveProperty('staffId');
  });

  it('an UNCOUNTED row that still holds a decline refuses too (no sentAt: any decline is current)', async () => {
    const { world, deps, flyer, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    // The pair's one share later failed: the row stops counting (sentAt REMOVED); the decline stays.
    const failed = ledgerEntryFor('2026-10-02T13:00:00.000Z#SM2', 'conv-1', { kind: 'failed' });
    expect(await applyShareLedgerEntry(deps(), { unitId: U, contactId: C, broadcastId: 'b-1', entry: failed })).toBe('written');
    expect(await row()).toMatchObject({ counted: false, declined: { at: DECLINED } });
    expect((await row())?.sentAt).toBeUndefined();
    expect(await flyer(SIGNED_1)).toBe('declined');
    expect((await row())?.shares?.[FLYER_SHARE_KEY]).toBeUndefined();
  });

  it('a decline OLDER than sentAt (superseded by a later share) does not refuse: the flyer entry is written and the decline record is left as it was', async () => {
    const { world, flyer, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    await sent('2026-10-02T18:00:00.000Z', 'b-2');
    expect(effectiveDecline((await row())!, undefined)).toBe(false);
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await row()).toMatchObject({ sentAt: SIGNED_1, declined: { at: DECLINED, by: 'staff' } });
  });

  it('(PIN) the refusal is flyer-only: a broadcast entry to a pair with a CURRENT decline still writes and supersedes it', async () => {
    const { world, deps, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SMb2', 'conv-1', { kind: 'accepted' });
    expect(await applyShareLedgerEntry(deps(), { unitId: U, contactId: C, broadcastId: 'b-2', entry })).toBe('written');
    const r = await row();
    expect(r).toMatchObject({ sentAt: '2026-10-03T09:00:00.000Z', broadcastId: 'b-2' });
    expect(effectiveDecline(r!, undefined)).toBe(false);
  });

  it('repeat sign-ups move sentAt forward; an equal or older sign-up instant is refused by the order rule (AR2)', async () => {
    const { flyer, row } = setup();
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await flyer(SIGNED_2)).toBe('written');
    expect(await row()).toMatchObject({ sentAt: SIGNED_2 });
    expect((await row())?.shares?.[FLYER_SHARE_KEY]?.attempt).toBe(flyerAttemptKey(SIGNED_2));
    expect(await flyer(SIGNED_2)).toBe('refused');
    expect(await flyer(SIGNED_1)).toBe('refused');
    expect(await row()).toMatchObject({ sentAt: SIGNED_2 });
  });

  it('a decline recorded AFTER a sign-up holds against the next sign-up (it is at or after the sentAt that sign-up moved)', async () => {
    const { world, flyer, row, sent } = setup();
    await sent();
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await world.listingSendsRepo.setDeclined(U, C, { at: '2026-10-03T15:00:00.000Z', by: 'staff' })).toBe('ok');
    expect(await flyer(SIGNED_2)).toBe('declined');
    expect(await row()).toMatchObject({ sentAt: SIGNED_1 });
    expect((await row())?.shares?.[FLYER_SHARE_KEY]?.attempt).toBe(flyerAttemptKey(SIGNED_1));
  });

  it('O1: a decline landing between the ledger read and its write makes the flyer write lose its token, re-read and answer declined - nothing written; a broadcast write in the same race re-reads and still writes', async () => {
    for (const writer of ['flyer', 'broadcast'] as const) {
      const { world, deps, row, sent } = setup();
      await sent();
      let reads = 0;
      let raced = false;
      const racing: LedgerRepo = {
        async getByKeyConsistent(u, c) {
          reads += 1;
          return world.listingSendsRepo.getByKeyConsistent(u, c);
        },
        async putShareMemory(u, c, next, expected) {
          if (!raced) {
            raced = true;
            // A staff Not interested lands after the ledger's consistent read.
            expect(await world.listingSendsRepo.setDeclined(u, c, { at: DECLINED, by: 'staff', staffId: 'usr_x' })).toBe('ok');
          }
          return world.listingSendsRepo.putShareMemory(u, c, next, expected);
        },
      };
      if (writer === 'flyer') {
        expect(await applyFlyerShareEntry(deps(racing), { unitId: U, contactId: C, signedUpAt: SIGNED_1 })).toBe('declined');
        const r = await row();
        expect(r?.shares?.[FLYER_SHARE_KEY]).toBeUndefined();
        expect(r).toMatchObject({ sentAt: SENT, broadcastId: 'b-1', declined: { at: DECLINED, by: 'staff' } });
      } else {
        const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SMb2', 'conv-1', { kind: 'accepted' });
        expect(await applyShareLedgerEntry(deps(racing), { unitId: U, contactId: C, broadcastId: 'b-2', entry })).toBe('written');
        expect(await row()).toMatchObject({ sentAt: '2026-10-03T09:00:00.000Z', broadcastId: 'b-2' });
      }
      expect(reads).toBe(2); // the lost condition forced exactly ONE re-read
    }
  });

  it('lost: past the re-read bound the flyer write answers lost with ONE ERROR - its own line, never the shared "the repair heals it" wording; applyShareLedgerEntry keeps the shared line', async () => {
    const { world, capture, deps, flyer } = setup();
    const puts = vi.fn(async (_u: string, _c: string, _n: ShareMemoryWrite, _e: { token: string | undefined }) => false);
    const losing: LedgerRepo = { getByKeyConsistent: (u, c) => world.listingSendsRepo.getByKeyConsistent(u, c), putShareMemory: puts };
    expect(await flyer(SIGNED_1, losing)).toBe('lost');
    expect(puts).toHaveBeenCalledTimes(4); // 1 + MAX_REAPPLY (3) writes
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: FLYER_LOST_LINE, unitId: U, contactId: C, shareKey: FLYER_SHARE_KEY, attempt: flyerAttemptKey(SIGNED_1), state: 'counted' });
    expect(errors[0]).not.toHaveProperty('broadcastId');
    expect(capture.lines.some((l) => l['msg'] === SHARED_LOST_LINE)).toBe(false);

    const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SM1', 'conv-1', { kind: 'accepted' });
    expect(await applyShareLedgerEntry(deps(losing), { unitId: U, contactId: C, broadcastId: 'b-1', entry })).toBe('lost');
    expect(capture.atLevel(50)[1]).toMatchObject({ msg: SHARED_LOST_LINE, broadcastId: 'b-1' });
  });
});
```

1c. `app/test/repairShareOutcomes.test.ts` (D7 watch item - the census must not mis-forecast a flyer entry):
- Replace the import anchor `import { seedListingSend } from './helpers/listingSendSeed.js';` with `import { seedFlyerSignUp, seedListingSend } from './helpers/listingSendSeed.js';`
- Insert directly BEFORE the anchor `  it('the CLI contract: --env local|dev|prod, --lane with local only, --broadcast <id>, --apply; anything else is a usage error', () => {`:

```ts
  it("flyer-leads D7 watch: a pair that ALSO holds a flyer entry is not mis-forecast - the slot stuck sent over its failed row moves to failed, the pair stays counted by the flyer entry (an update: pairsToUncount 0), and its sentAt / broadcastId follow the flyer entry; a second run forecasts nothing", async () => {
    const k = ids('b-fly');
    await seedShareWithChain({ broadcastId: 'b-fly', slotStatus: 'sent', rows: [{ tsMsgId: k.ROOT, status: 'failed', errorCode: '30007' }] });
    await seedListingSend(listingSends, { unitId: k.unitId, contactId: k.contactId, sentAt: T_ROOT, broadcastId: 'b-fly' });
    const SIGNED_UP_AT = '2026-09-28T11:30:00.000Z';
    await seedFlyerSignUp(listingSends, { unitId: k.unitId, contactId: k.contactId, signedUpAt: SIGNED_UP_AT });
    // Contrast: the same fixture without the flyer entry forecasts pairsToUncount 1 (the b-4 case above).
    expect(await run('b-fly', false)).toMatchObject({ slotsToMove: 1, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0 });
    expect(await run('b-fly', true)).toMatchObject({ slotsMoved: 1, rowsCreated: 0, pairsRecounted: 0, pairsUncounted: 0 });
    expect(await slotOf('b-fly')).toMatchObject({ status: 'failed', errorCode: '30007' });
    const row = await ledgerOf('b-fly');
    expect(row).toMatchObject({ counted: true, sentAt: SIGNED_UP_AT });
    expect(row).not.toHaveProperty('broadcastId');
    expect(row?.shares?.['b-fly']).toMatchObject({ state: 'failed' });
    expect(row?.shares?.['flyer']).toMatchObject({ state: 'counted', by: 'acceptance', countedAt: SIGNED_UP_AT });
    expect(await run('b-fly', false)).toMatchObject({ slotsToMove: 0, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0 });
  });

```

1d. `app/test/contactTimeline.test.ts` (D7 stated residual - `contactTimeline.ts:732`):
- After the import anchor `import { createLogCapture } from './helpers/logCapture.js';` add the line `import { seedFlyerSignUp } from './helpers/listingSendSeed.js';`
- Insert directly BEFORE the anchor `  it('a ledger read failure leaves the stored labels and logs one ERROR', async () => {` (inside the D6 describe):

```ts
  it('flyer-leads D7 residual (PIN): a flyer entry on a pair no share counted makes its pair-read pins read Property sent; the pin of the share whose entry failed keeps Property text failed', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world);
    await seedEntry(world, 'u-fly', 'b-x', { attempt: buildTsMsgId(minutesAgo(90), 'SMx'), state: 'failed' });
    await seedPin(world, 'u-fly', 50); // a pre-branch pin (no share id): reads the PAIR
    await seedPin(world, 'u-fly', 40, 'b-x'); // the failed share's own pin: reads ITS entry
    const before = await authedGet(app, `/api/contacts/${TENANT_D6}/timeline`);
    expect(before.status).toBe(200);
    expect(pinLabels(before.body)).toEqual(['Property text failed', 'Property text failed']);

    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'u-fly', contactId: TENANT_D6, signedUpAt: minutesAgo(10) });
    const after = await authedGet(app, `/api/contacts/${TENANT_D6}/timeline`);
    expect(after.status).toBe(200);
    expect(pinLabels(after.body)).toEqual(['Property sent', 'Property text failed']);
  });

```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/shareLedgerFlyer.test.ts test/repairShareOutcomes.test.ts test/contactTimeline.test.ts`

Expected: every `shareLedgerFlyer` case and the two new repair / timeline cases fail because `applyFlyerShareEntry` is not exported yet - under vitest 3.2 a `... applyFlyerShareEntry is not a function` TypeError at the call (the SSR transform does not reject a missing named export of a source module at import). All pre-existing repair and timeline cases pass. (Should the runner instead reject the import, every case of the three files fails - still the expected RED; re-check the pre-existing ones at GREEN.)

### Step 3 - implementation

3a. `app/src/services/shareLedger.ts`:
- Header: replace the anchor line ` * Imports repos and libs only - never a job module. Log lines carry ids only.` with:
  ```
   * flyer-leads D7: a flyer sign-up is one more share entry (key `flyer`,
   * applyFlyerShareEntry) - refused while the pair holds a CURRENT decline,
   * decided on each round's read (O1: a decline stamps the token, so a decline
   * that lands mid-loop is seen on the forced re-read).
   *
   * Imports repos and libs only - never a job module. Log lines carry ids only.
  ```
- Imports: replace the Task 3.1 line `import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, latestCountedShareKey } from '../lib/shareLedgerKeys.js';` with
  ```ts
  import { effectiveDecline } from '../lib/listingSendOutcome.js';
  import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../lib/shareLedgerKeys.js';
  ```
- Replace the whole `applyShareLedgerEntry` doc comment + function (anchor: from `/**` / ` * Apply one share's entry to the pair's row: read consistently, seed a legacy` to the end of the file) with:

```ts
/** What one run of the ledger loop decided. `'vetoed'` = the caller's veto refused the write on a read. */
type LedgerLoopResult = 'written' | 'refused' | 'lost' | 'vetoed';

/**
 * The ONE read-modify-write loop every ledger write runs (spec D7): read
 * consistently; let `veto` refuse the write on THAT read (flyer-leads D7: the
 * flyer's current-decline refusal - decided on each round's read, so a decline
 * that lands mid-loop is seen on the re-read its token change forces, O1);
 * seed a legacy row's memory, apply the order rule, summarize, write on the
 * token. A lost condition re-reads and re-applies up to MAX_REAPPLY times,
 * then ONE ERROR (`lostLine`, ids only: the pair, `lostIds`, the attempt and
 * its state) and `'lost'`.
 */
async function applyLedgerLoop(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; shareKey: string; entry: ShareLedgerEntry },
  opts: { veto?: (row: ListingSendItem | undefined) => boolean; lostLine: string; lostIds: Record<string, string> },
): Promise<LedgerLoopResult> {
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const row = await deps.listingSends.getByKeyConsistent(args.unitId, args.contactId);
    if (opts.veto !== undefined && opts.veto(row)) return 'vetoed';
    const shares = seeded(row);
    if (!mayReplace(shares[args.shareKey], args.entry)) return 'refused';
    shares[args.shareKey] = args.entry;
    const next: ShareMemoryWrite = { shares, ...summarize(shares) };
    if (await deps.listingSends.putShareMemory(args.unitId, args.contactId, next, { token: row?.shares_op })) return 'written';
  }
  deps.log.error(
    { unitId: args.unitId, contactId: args.contactId, ...opts.lostIds, attempt: args.entry.attempt, state: args.entry.state },
    opts.lostLine,
  );
  return 'lost';
}

/**
 * Apply one share's entry to the pair's row: read consistently, seed a legacy
 * row's memory, apply the order rule, summarize, write on the token. A lost
 * condition re-reads and re-applies up to MAX_REAPPLY times, then `'lost'`
 * with ONE ERROR. `'refused'` = the order rule kept the stored entry.
 */
export async function applyShareLedgerEntry(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; broadcastId: string; entry: ShareLedgerEntry },
): Promise<'written' | 'refused' | 'lost'> {
  const result = await applyLedgerLoop(
    deps,
    { unitId: args.unitId, contactId: args.contactId, shareKey: args.broadcastId, entry: args.entry },
    {
      lostLine: 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it',
      lostIds: { broadcastId: args.broadcastId },
    },
  );
  // No veto is passed, so the loop never answers 'vetoed' here.
  return result === 'vetoed' ? 'refused' : result;
}

/** flyer-leads D7 (plan 2.2, AR2): what a flyer sign-up's ledger write did. */
export type FlyerShareResult = 'written' | 'declined' | 'refused' | 'lost';

/**
 * flyer-leads D7: record a flyer sign-up for (unitId, contactId) at
 * `signedUpAt` (ISO with ms): ONE counted-by-acceptance entry under the
 * `flyer` key whose attempt is `<signedUpAt>#flyer`, so the pair's sentAt
 * moves to the sign-up and it reads `signed_up` (D8); no "Property sent"
 * milestone is written here. Same loop as applyShareLedgerEntry plus ONE
 * refusal, decided on EACH round's consistent read: a CURRENT decline
 * (effectiveDecline(row, undefined) - at or after the row's sentAt, or any
 * decline on a row with none; tours are not consulted) answers 'declined',
 * writes nothing and logs at INFO. A sign-up never clears a decline, so a
 * public request never undoes a staff decision; the refusal is the flyer's
 * ONLY - a broadcast or individual share still supersedes a decline.
 * 'refused' = the order rule kept the stored flyer entry (an equal or newer
 * sign-up instant - AR2). 'lost' = token retries exhausted, ONE ERROR with the
 * flyer's own line: the repair walks broadcast slots only, so it never heals
 * a flyer entry. Log lines carry ids only.
 */
export async function applyFlyerShareEntry(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; signedUpAt: string },
): Promise<FlyerShareResult> {
  const entry = ledgerEntryFor(flyerAttemptKey(args.signedUpAt), undefined, { kind: 'accepted' });
  const result = await applyLedgerLoop(
    deps,
    { unitId: args.unitId, contactId: args.contactId, shareKey: FLYER_SHARE_KEY, entry },
    {
      veto: (row) => effectiveDecline(row ?? {}, undefined),
      lostLine:
        'share ledger: the flyer entry write lost its condition past the re-read bound - not repaired (the repair walks broadcast slots only)',
      lostIds: { shareKey: FLYER_SHARE_KEY },
    },
  );
  if (result === 'vetoed') {
    deps.log.info({ unitId: args.unitId, contactId: args.contactId }, 'share ledger: flyer entry not written - the pair holds a current decline');
    return 'declined';
  }
  return result;
}
```

(`ledgerWouldChange` and `putShareMemory` are unchanged; a new row's `via` stays the `if_not_exists` `'broadcast'` - plan 3.2 watch item.)

3b. `app/src/repos/listingSendsRepo.ts` - replace the anchor line
`  /** share-sent-outcome D7: the per-share memory, keyed by broadcastId (or \`individual\`). Absent on a legacy row. */`
with
`  /** share-sent-outcome D7: the per-share memory, keyed by broadcastId (or \`individual\`, or \`flyer\` for a flyer sign-up - flyer-leads D7). Absent on a legacy row. */`

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/shareLedgerFlyer.test.ts test/shareLedger.test.ts test/repairShareOutcomes.test.ts test/contactTimeline.test.ts test/listingSendsApi.test.ts test/listingSendOutcomeApi.test.ts test/shareAttemptOutcome.test.ts test/broadcastFanOut.test.ts`
All pass (the last four are regression for the shared loop). Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` exits 0.

### Step 5 - ASCII

New: `app/test/shareLedgerFlyer.test.ts` (full-file). Touched (added lines): `app/src/services/shareLedger.ts`, `app/src/repos/listingSendsRepo.ts`, `app/test/helpers/listingSendSeed.ts`, `app/test/repairShareOutcomes.test.ts`, `app/test/contactTimeline.test.ts`. All print `0`.

### Step 6 - commit

Paths: `app/src/services/shareLedger.ts app/src/repos/listingSendsRepo.ts app/test/helpers/listingSendSeed.ts app/test/shareLedgerFlyer.test.ts app/test/repairShareOutcomes.test.ts app/test/contactTimeline.test.ts`

Command (repeated `-m`, plan section 0 - no message file):
```
cd "W:/tmp/flyer-leads" && git commit -m "feat(ledger): applyFlyerShareEntry - flyer share entry, refused by a current decline (flyer-leads D7)" -m "Plan 2.2 / AR2: one counted flyer entry through the shared ledger loop; a current decline (effectiveDecline(row, undefined)) refuses it on each round's read, so a decline racing the write wins (O1). Lost writes log their own not-repaired line. Pins the repair census and the timeline pin-word residual; adds the seedFlyerSignUp test helper." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.4 - The `signed_up` outcome and every caller's wire

Goal: `ListingSendOutcome` gains `signed_up`; `deriveListingSendOutcome` reads `row.shares` and returns it after decline > tour > replied when `latestCountedShareKey(row.shares) === FLYER_SHARE_KEY` (plan 2.4, spec D8). `isWaiting` keeps its rule, so `signed_up` never waits. One test per caller pins it on that caller's wire.

Files: `app/src/lib/listingSendOutcome.ts`; `app/test/listingSendOutcome.test.ts`; `app/test/listingSendsApi.test.ts` (contacts.ts:1324, units.ts:240 and :260); `app/test/listingSendOutcomeApi.test.ts` (the outcome route, units.ts:1553 + :1743); `app/test/followUps.test.ts` (followUps.ts:168); `app/test/broadcastApi.test.ts` (broadcasts.ts:612 and the blast D5 default).

### Step 1 - tests first

1a. `app/test/listingSendOutcome.test.ts` - append at end of file (uses the file's `SENT`, `AFTER`, `LATER`, `staff`, `TOUR` and its imports):

```ts

describe('flyer-leads D8: signed_up - the latest counted entry is the flyer entry', () => {
  const SIGNED = '2026-10-01T18:00:00.000Z'; // after SENT, before AFTER
  const signedRow = {
    sentAt: SIGNED,
    shares: { b1: { state: 'counted', countedAt: SENT }, flyer: { state: 'counted', countedAt: SIGNED } },
  };
  type Input = Parameters<typeof deriveListingSendOutcome>[0];
  const derive = (row: Input['row'], over: Partial<Omit<Input, 'row'>> = {}) =>
    deriveListingSendOutcome({ row, recipientType: 'tenant', lastHeardFromAt: undefined, tour: undefined, tourActivityAt: undefined, ...over });

  it('nothing heard since the sign-up and no tour -> signed_up, whatever the recipient type (type-blind: tenant, unknown, a missing recipient)', () => {
    expect(derive(signedRow)).toBe('signed_up');
    expect(derive(signedRow, { recipientType: 'unknown' })).toBe('signed_up');
    expect(derive(signedRow, { recipientType: undefined })).toBe('signed_up');
  });

  it('a reply BEFORE the sign-up no longer beats it (the sign-up moved sentAt); a reply AFTER it -> replied', () => {
    expect(derive({ sentAt: SENT }, { lastHeardFromAt: '2026-10-01T15:00:00.000Z' })).toBe('replied'); // the contrast, before the sign-up
    expect(derive(signedRow, { lastHeardFromAt: '2026-10-01T15:00:00.000Z' })).toBe('signed_up');
    expect(derive(signedRow, { lastHeardFromAt: AFTER })).toBe('replied');
  });

  it('order: an effective decline > a tour > replied > signed_up', () => {
    expect(derive(signedRow, { tour: TOUR, tourActivityAt: SIGNED })).toBe('interested');
    expect(derive({ ...signedRow, declined: staff(LATER) }, { tour: TOUR, tourActivityAt: AFTER, lastHeardFromAt: LATER })).toBe('not_interested');
    // A decline the sign-up's sentAt superseded is not effective.
    expect(derive({ ...signedRow, declined: staff(SENT) })).toBe('signed_up');
  });

  it('a LATER counted share of the pair is the latest entry -> the normal outcomes again', () => {
    const resent = { sentAt: LATER, shares: { flyer: { state: 'counted', countedAt: SIGNED }, b2: { state: 'counted', countedAt: LATER } } };
    expect(derive(resent)).toBe('no_reply');
    expect(derive(resent, { lastHeardFromAt: '2026-10-04T12:00:00.000Z' })).toBe('replied');
  });

  it('the latest COUNTED entry decides: a later uncounted entry keeps signed_up; a legacy row (no shares) and an individual latest entry read no_reply', () => {
    expect(derive({ sentAt: SIGNED, shares: { flyer: { state: 'counted', countedAt: SIGNED }, b2: { state: 'failed' } } })).toBe('signed_up');
    expect(derive({ sentAt: SENT })).toBe('no_reply');
    expect(derive({ sentAt: SENT, shares: { individual: { state: 'counted', countedAt: SENT } } })).toBe('no_reply');
  });

  it('(PIN) signed_up never waits however long the pair is quiet, and carries no wire decline', () => {
    const sentMs = Date.parse(SIGNED);
    expect(isWaiting({ outcome: 'signed_up', eligible: true, sentAt: SIGNED, now: sentMs + 2 * 86_400_000 })).toBe(false);
    expect(wireDecline({ declined: staff(SENT) }, 'signed_up')).toBeUndefined();
  });
});
```

1b. `app/test/listingSendsApi.test.ts`:
- Replace the import anchor `import { seedListingSend } from './helpers/listingSendSeed.js';` with `import { seedFlyerSignUp, seedListingSend } from './helpers/listingSendSeed.js';`
- Append at end of file:

```ts

describe('flyer-leads D8: signed_up on both GET projections (the callers pass the FULL stored row)', () => {
  const get = (app: ReturnType<typeof makeWebhookHarness>['app'], path: string) =>
    request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
  const SIGNED_UP_AT = '2026-06-18T10:00:00.000Z';

  it('a pair whose latest counted entry is the flyer entry reads signed_up on the units recipients (a tenant, an unknown contact, a missing recipient) and on the contact listings-sent - sentAt is the sign-up, no broadcastId', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'active', phone: '+15550109010' } as ContactItem);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT, broadcastId: 'b-1' });
    for (const contactId of ['c-1', 'c-unk', 'c-gone']) {
      await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId, signedUpAt: SIGNED_UP_AT });
    }

    const units = await get(app, '/api/units/unit-1/recipients');
    expect(units.status).toBe(200);
    const byId = new Map((units.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]));
    expect(byId.get('c-1')).toMatchObject({ outcome: 'signed_up', sentAt: SIGNED_UP_AT, interestedSupported: true, eligible: true });
    expect(byId.get('c-1')).not.toHaveProperty('broadcastId');
    expect(byId.get('c-1')).not.toHaveProperty('declined');
    expect(byId.get('c-unk')).toMatchObject({ outcome: 'signed_up', type: 'unknown', interestedSupported: false });
    expect(byId.get('c-gone')).toMatchObject({ outcome: 'signed_up', recipientMissing: true, eligible: false });

    const contact = await get(app, '/api/contacts/c-1/listings-sent');
    expect(contact.status).toBe(200);
    expect(contact.body.sent[0]).toMatchObject({ unitId: 'unit-1', outcome: 'signed_up', sentAt: SIGNED_UP_AT });
    expect(contact.body.sent[0]).not.toHaveProperty('broadcastId');
  });

  it('a later counted share of the pair takes it back to the normal outcomes (no_reply, its broadcastId)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', signedUpAt: SIGNED_UP_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: '2026-06-19T10:00:00.000Z', broadcastId: 'b-2' });
    const units = await get(app, '/api/units/unit-1/recipients');
    expect(units.body.recipients[0]).toMatchObject({ outcome: 'no_reply', sentAt: '2026-06-19T10:00:00.000Z', broadcastId: 'b-2' });
    const contact = await get(app, '/api/contacts/c-1/listings-sent');
    expect(contact.body.sent[0]).toMatchObject({ outcome: 'no_reply', broadcastId: 'b-2' });
  });
});
```

1c. `app/test/listingSendOutcomeApi.test.ts`:
- Replace the import anchor `import { seedListingSend } from './helpers/listingSendSeed.js';` with `import { seedFlyerSignUp, seedListingSend } from './helpers/listingSendSeed.js';`
- Append at end of file:

```ts

describe('flyer-leads D8: a signed_up pair takes the same outcome actions as a waiting one (any counted row)', () => {
  const SIGNED_UP_AT = '2026-06-18T10:00:00.000Z';

  it('Not interested on a signed_up pair -> not_interested; Undo -> signed_up again', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', signedUpAt: SIGNED_UP_AT });
    const declined = await post(app, { outcome: 'not_interested' });
    expect(declined.status).toBe(200);
    expect(declined.body.row).toMatchObject({ outcome: 'not_interested', sentAt: SIGNED_UP_AT });
    const undone = await post(app, { outcome: 'clear' });
    expect(undone.status).toBe(200);
    expect(undone.body.row).toMatchObject({ outcome: 'signed_up', sentAt: SIGNED_UP_AT });
    expect((await stored(world))?.declined).toBeUndefined();
  });

  it('(PIN) Interested on a signed_up pair creates the tour -> interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', signedUpAt: SIGNED_UP_AT });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(world.toursMap.size).toBe(1);
  });
});
```

1d. `app/test/followUps.test.ts`:
- After the anchor `import { buildFollowUps, FOLLOW_UPS_UNIT_CAP, type FollowUpsDeps } from '../src/services/followUps.js';` add `import { FLYER_SHARE_KEY, flyerAttemptKey } from '../src/lib/shareLedgerKeys.js';`
- Append at end of file:

```ts

describe('flyer-leads D8: a signed_up pair never waits (followUps.ts derives through the one helper)', () => {
  const flyerShare = (at: string) => ({
    [FLYER_SHARE_KEY]: { attempt: flyerAttemptKey(at), state: 'counted' as const, by: 'acceptance' as const, countedAt: at },
  });

  it('a pair whose latest counted entry is the flyer entry is not listed nor counted in byUnit, however quiet; a later broadcast share of a pair lists it as no_reply', async () => {
    const w = emptyWorld();
    w.units.push(unit('u1'));
    w.contacts.push(tenant('c1'), tenant('c2'));
    const signed = ago(2 * DAY);
    const resent = ago(30 * HOUR);
    w.sends.push(
      send('u1', 'c1', signed, { shares: flyerShare(signed) }),
      send('u1', 'c2', resent, {
        shares: { ...flyerShare(signed), b2: { attempt: `${resent}#SM2`, state: 'counted', by: 'acceptance', countedAt: resent } },
      }),
    );
    const out = await buildFollowUps(depsFor(w).deps);
    expect(out.items.map((i) => [i.contactId, i.outcome])).toEqual([['c2', 'no_reply']]);
    expect(out.byUnit).toEqual({ u1: 1 });
  });
});
```

1e. `app/test/broadcastApi.test.ts`:
- After the import anchor `import { createSendMessageService } from '../src/services/sendMessage.js';` add `import { applyFlyerShareEntry } from '../src/services/shareLedger.js';`
- Insert directly BEFORE the anchor `    it('checkedByDefault is the ONE server rule: a seed is checked whatever its flags;` (inside describe `matching-blast-rules D4/D5/D7: the preview review rows`):

```ts
    it('flyer-leads D8 (PIN): a signed_up pair stays checked by default - D5 unchecks only an effective decline (broadcasts.ts derives signed_up for a row whose old decline a later share superseded); a sign-up refused by a CURRENT decline leaves that pair declined and unchecked', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-signed', phone: '+15550302001' });
      seedTenant(world, { contactId: 'c-superseded', phone: '+15550302002' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550302003' });
      const ledger = { listingSends: world.listingSendsRepo, log: createLogger({ level: 'silent' }) };
      const FLYER_AT = '2026-10-03T12:00:00.000Z';
      // An old decline a later share superseded (sentAt after DECLINED_AT), then a sign-up.
      world.listingSends.push({ ...declinedRow('c-superseded'), sentAt: '2026-10-02T18:00:00.000Z' });
      world.listingSends.push(declinedRow('c-declined'));
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-signed', signedUpAt: FLYER_AT })).toBe('written');
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-superseded', signedUpAt: FLYER_AT })).toBe('written');
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-declined', signedUpAt: FLYER_AT })).toBe('declined');
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-signed')).toMatchObject({ checkedByDefault: true, declinedThisProperty: false });
      expect(byId.get('c-superseded')).toMatchObject({ checkedByDefault: true, declinedThisProperty: false });
      expect(byId.get('c-declined')).toMatchObject({ checkedByDefault: false, declinedThisProperty: true });
      expect(res.body.declinedContactIds).toEqual(['c-declined']);
    });

```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendOutcome.test.ts test/listingSendsApi.test.ts test/listingSendOutcomeApi.test.ts test/followUps.test.ts test/broadcastApi.test.ts`

Expected: the `signed_up` derivation cases fail (received `'no_reply'`); the FIRST new listingSendsApi case fails on its `c-1` `signed_up` assertion (received `'no_reply'`) - the second one (a later share returns to `no_reply`) already passes; the outcome-route Undo case fails (received `'no_reply'`); the follow-ups case fails (c1 is listed: received `[['c1','no_reply'],['c2','no_reply']]`). The PIN cases (isWaiting / wireDecline, Interested, the broadcast preview) already pass. Everything else passes.

### Step 3 - implementation (`app/src/lib/listingSendOutcome.ts` only - the five callers already pass the full row, section B)

- Replace the header anchor
  ```
  //   - deriveListingSendOutcome: not_interested > interested > replied >
  //     no_reply, and a non-tenant recipient never reads a tour;
  ```
  with
  ```
  //   - deriveListingSendOutcome: not_interested > interested > replied >
  //     signed_up (flyer-leads D8: the pair's latest counted entry is the
  //     flyer entry) > no_reply, and a non-tenant recipient never reads a tour;
  ```
- After the anchor `import type { TourSignal } from './listingSendTour.js';` add
  `import { FLYER_SHARE_KEY, latestCountedShareKey } from './shareLedgerKeys.js';`
- Replace `export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';` with
  `export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested' | 'signed_up';`
- Replace the anchor
  ```ts
  /**
   * The ONE outcome derivation (spec 5.4). A recipient whose type is not
   * 'tenant' never reads a tour: neither the signal nor its activity (the tours
   * API accepts any contactId, and a converted caseworker keeps tenant-era
   * tours).
   */
  export function deriveListingSendOutcome(input: {
    row: { declined?: DeclineRecord; sentAt?: string };
  ```
  with
  ```ts
  /**
   * The ONE outcome derivation (spec 5.4). A recipient whose type is not
   * 'tenant' never reads a tour: neither the signal nor its activity (the tours
   * API accepts any contactId, and a converted caseworker keeps tenant-era
   * tours). flyer-leads D8: after the decline, the tour and a reply, a pair
   * whose LATEST counted entry is the flyer entry (latestCountedShareKey on
   * the row's stored `shares` - the rule summarize uses, lib/shareLedgerKeys.ts)
   * reads `signed_up`; every caller passes the stored row, so they cannot
   * disagree. Type-blind: the row alone decides.
   */
  export function deriveListingSendOutcome(input: {
    row: { declined?: DeclineRecord; sentAt?: string; shares?: Record<string, { state: string; countedAt?: string }> };
  ```
- Replace the anchor
  ```ts
    if (heardMs !== undefined && sentMs !== undefined && heardMs > sentMs) return 'replied';
    return 'no_reply';
  }
  ```
  with
  ```ts
    if (heardMs !== undefined && sentMs !== undefined && heardMs > sentMs) return 'replied';
    return latestCountedShareKey(input.row.shares) === FLYER_SHARE_KEY ? 'signed_up' : 'no_reply';
  }
  ```
- Replace the isWaiting anchor `  if (input.outcome !== 'no_reply' && input.outcome !== 'replied') return false;` with
  ```ts
    // flyer-leads D8: `signed_up` never waits - the person reached out.
    if (input.outcome !== 'no_reply' && input.outcome !== 'replied') return false;
  ```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendOutcome.test.ts test/listingSendsApi.test.ts test/listingSendOutcomeApi.test.ts test/followUps.test.ts test/followUpsApi.test.ts test/broadcastApi.test.ts test/blastAudienceRules.test.ts test/listingSendRowProjection.test.ts`
All pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` exits 0 (the widened union compiles in `routes/*`, `services/followUps.ts` and `repos/listingSendsRepo.ts` with no edit).

### Step 5 - ASCII

Added-lines check on all six files; each prints `0`.

### Step 6 - commit

Paths: `app/src/lib/listingSendOutcome.ts app/test/listingSendOutcome.test.ts app/test/listingSendsApi.test.ts app/test/listingSendOutcomeApi.test.ts app/test/followUps.test.ts app/test/broadcastApi.test.ts`

Command (repeated `-m`, plan section 0 - no message file):
```
cd "W:/tmp/flyer-leads" && git commit -m "feat(outcome): signed_up send outcome from the latest counted flyer entry (flyer-leads D8)" -m "Plan 2.4: deriveListingSendOutcome reads the stored shares through latestCountedShareKey - decline > tour > replied > signed_up / no_reply. signed_up never waits. Pinned on every caller's wire: units recipients, contact listings-sent, the outcome route, follow-ups and the blast preview." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3.5 - AR13: a resolved recipient with no name is labelled by its formatted phone

Goal: the units recipients projection (and the outcome route's re-projection - the same `projectRecipientRow`) attaches, for a RESOLVED contact with no first / last name, `tenantName = formatPhoneForDisplay(phone) ?? phone` when the contact has a phone (AR13, plan review R1 #1). A missing recipient, or a contact with neither a name nor a phone, still carries no `tenantName`. Why: spec D7 puts EXISTING `unknown` contacts - auto-captured, often nameless - on the property's Sent to card, and D4 never renames them, so the card would print a raw contactId. The contact listings-sent read is unchanged (it never attaches `tenantName` - section B); the rule therefore lives in `units.ts` only, not in a shared helper.

Files: `app/src/routes/units.ts`; `app/src/repos/listingSendsRepo.ts` (the `ListingSendRow.tenantName` wire comment); `app/test/listingSendsApi.test.ts`.

### Step 1 - tests first (`app/test/listingSendsApi.test.ts`; Task 3.4 already imports `seedFlyerSignUp` here)

1a. The two exact-shape pins of a nameless tenant (section B) now expect the phone label:
- Replace the anchor `    seedTenant(world, 'c-x');` with `    const tx = seedTenant(world, 'c-x');`
- Replace the anchor
  `    expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant', interestedMode: 'form', eligible: true });`
  with:
  ```ts
    // flyer-leads AR13: the units side also labels a resolved contact with no
    // name by its phone (seedTenant's phone is not NANP-shaped, so
    // formatPhoneForDisplay passes it through as stored); the contact side
    // never carries tenantName.
    expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant', interestedMode: 'form', eligible: true, tenantName: tx.phone });
    expect(byContact.body.sent[0]).not.toHaveProperty('tenantName');
  ```
- Replace the anchor block
  ```ts
    seedTenant(world, 'c-1');
    seedTenant(world, 'c-2');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-2', sentAt: SENT_AT });
    // c-1 has a scheduled tour on unit-1; c-2 has none.
  ```
  with the same five lines, the first one changed to `    const t1 = seedTenant(world, 'c-1');`
- Replace the anchor
  `    expect(c1).toEqual({ contactId: 'c-1', unitId: 'unit-1', sentAt: c1.sentAt, via: 'broadcast', tour: { tourId: 'tour-c1', state: 'scheduled' }, type: 'tenant', outcome: 'interested', interestedSupported: true, interestedMode: 'form', eligible: true });`
  with:
  ```ts
    // flyer-leads AR13: c-1 has no name, so its label is its phone.
    expect(c1).toEqual({ contactId: 'c-1', unitId: 'unit-1', sentAt: c1.sentAt, via: 'broadcast', tour: { tourId: 'tour-c1', state: 'scheduled' }, type: 'tenant', outcome: 'interested', interestedSupported: true, interestedMode: 'form', eligible: true, tenantName: t1.phone });
  ```

1b. Append at end of file (after Task 3.4's describe):

```ts

describe('flyer-leads AR13: a resolved recipient with no name is labelled by its formatted phone (units recipients only)', () => {
  const get = (app: ReturnType<typeof makeWebhookHarness>['app'], path: string) =>
    request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('a nameless unknown contact a flyer sign-up put on the card carries its formatted phone; a non-NANP phone is shown as stored; a named contact keeps its name; a contact with neither and a missing recipient carry none; the contact listings-sent read is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // An auto-captured contact: no name, never renamed by a sign-up (spec D4).
    world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'active', phone: '+14045550142' } as ContactItem);
    world.contacts.push({ contactId: 'c-intl', type: 'unknown', status: 'active', phone: '+442071838750' } as ContactItem);
    world.contacts.push({ contactId: 'c-bare', type: 'unknown', status: 'active' } as ContactItem);
    const named = seedTenant(world, 'c-named');
    named.firstName = 'Brianna';
    named.lastName = 'Whitfield';
    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-unk', signedUpAt: '2026-06-18T10:00:00.000Z' });
    for (const contactId of ['c-intl', 'c-bare', 'c-named', 'c-gone']) {
      await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
    }

    const units = await get(app, '/api/units/unit-1/recipients');
    expect(units.status).toBe(200);
    const byId = new Map((units.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]));
    expect(byId.get('c-unk')).toMatchObject({ tenantName: '(404) 555-0142', type: 'unknown', outcome: 'signed_up' });
    expect(byId.get('c-intl')).toMatchObject({ tenantName: '+442071838750' });
    expect(byId.get('c-named')).toMatchObject({ tenantName: 'Brianna Whitfield' });
    expect(byId.get('c-bare')).not.toHaveProperty('tenantName');
    expect(byId.get('c-gone')).toMatchObject({ recipientMissing: true });
    expect(byId.get('c-gone')).not.toHaveProperty('tenantName');

    const contact = await get(app, '/api/contacts/c-unk/listings-sent');
    expect(contact.status).toBe(200);
    expect(contact.body.sent[0]).toMatchObject({ unitId: 'unit-1', outcome: 'signed_up' });
    expect(contact.body.sent[0]).not.toHaveProperty('tenantName');
  });

  it('the outcome route answers the same label on its re-projected row (it reuses the recipients projection)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'active', phone: '+14045550142' } as ContactItem);
    await seedFlyerSignUp(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-unk', signedUpAt: '2026-06-18T10:00:00.000Z' });
    const res = await request(app)
      .post('/api/units/unit-1/recipients/c-unk/outcome')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ outcome: 'not_interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ contactId: 'c-unk', outcome: 'not_interested', tenantName: '(404) 555-0142' });
  });
});
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendsApi.test.ts`

Expected: the two edited exact-shape cases fail (the received row has no `tenantName`); in the new describe the first case fails at `c-unk` (`tenantName` absent - today the label is name-only) and the outcome-route case fails the same way. The `c-named`, `c-bare`, `c-gone` and listings-sent assertions would pass on their own; every other case in the file passes.

### Step 3 - implementation

3a. `app/src/routes/units.ts`:
- After the anchor `import { formatAddress } from '../lib/address.js';` add `import { formatPhoneForDisplay } from '../lib/phone.js';`
- Insert directly BEFORE the anchor block (the recipientFactsOf doc comment)
  ```
  /**
   * caseworkers D20 (plan 3.7, ruling R3-F3): a recipients row's contact type and
   * role, from the recipient display projection. `role` only when it holds text;
  ```
  this function:

```ts
/**
 * flyer-leads AR13: the "Sent to" row's label (`tenantName`) for a RESOLVED
 * recipient - the contact's name, else its OWN formatted phone
 * (`formatPhoneForDisplay(phone) ?? phone`, the staff-chrome fallback of
 * lib/groupTitle.ts). An auto-captured `unknown` contact that signed up from
 * a flyer is put on the card (spec D7) and never renamed (D4), so without
 * this the card would print its raw contactId. Staff chrome only - never a
 * message body. undefined when the contact has neither a name nor a phone
 * (the dashboard then falls back to the id, as for a missing recipient).
 */
function recipientLabelOf(contact: RecipientDisplay): string | undefined {
  const name = displayNameOfContact(contact);
  if (name !== undefined) return name;
  const phone = typeof contact.phone === 'string' ? contact.phone : '';
  if (phone.length === 0) return undefined;
  return formatPhoneForDisplay(phone) ?? phone;
}

```

- In `projectRecipientRow`, replace the anchor `  const tenantName = displayNameOfContact(contact);` with `  const tenantName = recipientLabelOf(contact);` (`displayNameOfContact` itself and its seven other callers are unchanged).

3b. `app/src/repos/listingSendsRepo.ts` - replace the wire-comment anchor
```
  /** Denormalized tenant display name, attached by the GET projections (same
   *  contacts join as the roster's `name`). HONEST - absent when the contact is
   *  unknown or has no name; the dashboard then falls back to the id. */
```
with
```
  /** Denormalized recipient label, attached ONLY by the units recipients read
   *  and the outcome route's re-projection (routes/units.ts recipientLabelOf;
   *  the contact listings-sent read never carries it - its contact is the page
   *  owner): the contact's name, else - flyer-leads AR13 - its OWN formatted
   *  phone, because an `unknown` contact a flyer sign-up puts on the card is
   *  never renamed (spec D4, D7). Absent when the contact did not resolve (a
   *  missing recipient) or has neither a name nor a phone; the dashboard then
   *  falls back to the id. Staff chrome only - never a message body. */
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/listingSendsApi.test.ts test/listingSendOutcomeApi.test.ts test/contactsBatchReads.test.ts test/listingSendRowProjection.test.ts`
All pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` exits 0.

### Step 5 - ASCII

Added-lines check on `app/src/routes/units.ts`, `app/src/repos/listingSendsRepo.ts`, `app/test/listingSendsApi.test.ts`; each prints `0`.

### Step 6 - commit

Paths: `app/src/routes/units.ts app/src/repos/listingSendsRepo.ts app/test/listingSendsApi.test.ts`

Command (repeated `-m`, plan section 0 - no message file):
```
cd "W:/tmp/flyer-leads" && git commit -m "feat(units): label a nameless Sent to recipient by its formatted phone (flyer-leads AR13)" -m "The units recipients projection (and the outcome route's re-projection) falls back from the contact's name to formatPhoneForDisplay(phone) ?? phone, so an unknown contact a flyer sign-up puts on the card never shows a raw contactId. A missing recipient keeps no label; the contact listings-sent read is unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## S3 exit check (one commit: the slice report)

1. `cd "W:/tmp/flyer-leads" && npm run db:start`
2. The slice's own files first (fast signal): `cd "W:/tmp/flyer-leads/app" && npx vitest run test/shareLedgerKeys.test.ts test/shareLedger.test.ts test/shareLedgerFlyer.test.ts test/shareAttemptOrder.test.ts test/listingSendsRepo.integration.test.ts test/listingSendsRepoShares.integration.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/listingSendOutcome.test.ts test/listingSendsApi.test.ts test/listingSendOutcomeApi.test.ts test/followUps.test.ts test/followUpsApi.test.ts test/broadcastApi.test.ts test/blastAudienceRules.test.ts test/repairShareOutcomes.test.ts test/contactTimeline.test.ts test/devListingSendFixture.test.ts test/shareAttemptOutcome.test.ts test/broadcastFanOut.test.ts test/listingSendRowProjection.test.ts test/contactsBatchReads.test.ts` - all pass, no `SKIPPED` line.
3. AR15 - the FULL app suite, because S3 edits shared test helpers (the harness's listing-sends fake, `listingSendSeed.ts`) that suites outside this list import. The S6 Task 6.5 pattern, in Git Bash (the Bash tool - not cmd, where `timeout` is `timeout.exe`):
   (a) AWS-credential check FIRST (a diagnostic): `env | grep '^AWS_'`. If ANY `AWS_ACCESS_KEY_ID` prints, the suite command in (c) runs under `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY` (AGENTS.md: an exported key collapses every app test file onto one DynamoDB Local database).
   (b) `mkdir -p "W:/tmp/flyer-leads/.superpowers/sdd/gates"` (gitignored).
   (c) In the BACKGROUND (Bash tool `run_in_background: true`), as its own bare command - output REDIRECTED to the log (a redirect is not a pipe), never piped, never `;`-chained, under a hard outer timeout:
       `cd "W:/tmp/flyer-leads/app" && timeout 1500 npx vitest run > "W:/tmp/flyer-leads/.superpowers/sdd/gates/s3-app-suite.log" 2>&1`
       (key check positive: `cd "W:/tmp/flyer-leads/app" && timeout 1500 env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx vitest run > "W:/tmp/flyer-leads/.superpowers/sdd/gates/s3-app-suite.log" 2>&1`)
       Wait for the completion notice; do not poll, and do not edit or commit meanwhile.
   (d) After it finishes, read and QUOTE its real exit code from the notice: `0` passes; `124` is the timeout firing (a hang to report, never a pass); anything else is a failure. Then read the captured log: `grep -nE "Test Files|Tests  |FAIL|SKIPPED|\[dynamoAdmin\]" "W:/tmp/flyer-leads/.superpowers/sdd/gates/s3-app-suite.log"` - the `Test Files` line has no `failed`, no `FAIL` line, no `SKIPPED - no DynamoDB Local` line.
   (e) A red DynamoDB Local suite is adjudicated by AGENTS.md's re-run-and-compare rule (re-run each failing FILE alone, more than once: `cd "W:/tmp/flyer-leads/app" && npx vitest run test/<file>`; compare failing FILES against a run at the merge base; report both runs) - never by the old `AWS_ACCESS_KEY_ID` recipe. Any `[dynamoAdmin]` line is one real container fault: capture that run's `err.$metadata.httpStatusCode` and `attempts` and report it. Any other failure is a regression to diagnose (there is no named-flake list).
4. `cd "W:/tmp/flyer-leads" && npm run typecheck` - exit 0.
5. `cd "W:/tmp/flyer-leads" && npx eslint app/src/lib/shareLedgerKeys.ts app/src/services/shareLedger.ts app/src/lib/shareAttemptOrder.ts app/src/lib/listingSendOutcome.ts app/src/repos/listingSendsRepo.ts app/src/routes/units.ts app/test/shareLedgerKeys.test.ts app/test/shareLedgerFlyer.test.ts app/test/shareLedger.test.ts app/test/listingSendsRepo.integration.test.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/helpers/listingSendSeed.ts app/test/repairShareOutcomes.test.ts app/test/contactTimeline.test.ts app/test/listingSendOutcome.test.ts app/test/listingSendsApi.test.ts app/test/listingSendOutcomeApi.test.ts app/test/followUps.test.ts app/test/broadcastApi.test.ts` - no NEW error (attribute any error by the AGENTS.md baseline comparison at `main`).
6. ASCII on every S3 file (section C commands) - all `0`.
7. `cd "W:/tmp/flyer-leads" && git status` - clean; `git log --oneline -5` shows the five S3 task commits.
8. The slice report (plan section 0): write `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S3-report.md` (create the `slices/` directory if absent) - ASCII, FINDINGS ONLY: what the tree held that this plan got wrong (a stale anchor, a line number, an expected RED that was green or red for another reason), risks seen, any untrimmed typed-input path met in a surface S3 touched (D10), each citing code by `file:line`. If there is nothing, the file is one line: `S3: nothing to report - every task ran as planned.` Do not paste diffs or code. Then the full-file ASCII check on it, a bare `git status` read, the MERGE_HEAD check, `cd "W:/tmp/flyer-leads" && git add docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S3-report.md`, and:
   `cd "W:/tmp/flyer-leads" && git commit -m "docs(records): flyer-leads S3 slice report" -m "Findings from building S3 (ledger keys, flyer apply, decline token O1, signed_up outcome, AR13 recipient label)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
   Then `git status` is clean again.

## D. Spec coverage map (items this slice owns -> task)

- D7 mechanism: a share ENTRY, key `flyer`, attempt `<sign-up ISO>#flyer`, counted by acceptance, countedAt from the key -> 3.1 (keys) + 3.3 (`applyFlyerShareEntry`, "NEW pair" case).
- D7 `summarize` maps `flyer` like `individual` (no broadcastId) -> 3.1 (shareLedger.test.ts case) + 3.3 / 3.4 (wire has no broadcastId).
- D7 "written unless a decline is current; newest counted entry wins"; already-sent / replied pairs become latest -> 3.3 (+ 3.4 for the replied-vs-signed_up outcome).
- D7 "a sign-up never clears a decline": current = `effectiveDecline(row, undefined)`, any decline with no sentAt, decided inside the read-modify-write -> 3.3 (current, uncounted-with-decline, superseded, decline-after-sign-up cases).
- D7 refusal is `flyer` only; a broadcast still supersedes -> 3.3 (PIN) + 3.4 broadcast-preview case.
- D7 O1: `setDeclined` / `clearDeclined` stamp `shares_op`; harness fake; NO-RESET comment -> 3.2; the race itself -> 3.3 (O1 case).
- D7 repeat sign-ups move sentAt forward -> 3.3; AR2 `'refused'` -> 3.3.
- D7 residuals: uncounted pair -> "Property sent" (`contactTimeline.ts:732`) -> 3.3 PIN; repair census -> 3.3 (repairShareOutcomes case); lost write not repaired + its own log line -> 3.3; INFO log on a decline refusal -> 3.3; clock-skew ordering -> documented only (cosmetic, spec).
- D7 `via` untouched / `putShareMemory` unchanged -> 3.3 (no repo writer change; dev fixture and seeds unchanged, section B).
- D7 an `unknown` contact's entry shows on the Sent to card at once -> 3.4 (units recipients wire, `c-unk`) + 3.5 (labelled by its formatted phone, AR13).
- D8 outcome `signed_up`, order decline > tour > replied > signed_up / no_reply, ONE helper -> 3.1 (helper) + 3.4.
- D8 `signed_up` never waiting (Follow up tab, waiting pill) -> 3.4 (isWaiting PIN + followUps case).
- D8 a later counted share returns the pair to normal outcomes -> 3.4 (unit + listingSendsApi + followUps).
- D8 "every caller passes the stored shares"; all five callers -> 3.4 (contacts.ts:1324 and units.ts:240/260 in listingSendsApi; outcome route re-projection in listingSendOutcomeApi; followUps.ts:168 in followUps; broadcasts.ts:612 in broadcastApi).
- D8 action gate: the outcome route accepts any counted row - Interested / Not interested / Undo on a signed_up pair -> 3.4.
- D8 Matching blast keeps a signed_up tenant checked (`blastAudienceRules.ts`) -> 3.4 broadcast-preview PIN.
- Spec section 5 "Ledger and outcome" bullets 1-5 and "O1" / "broadcast supersedes" / "decline after a sign-up" -> 3.3, 3.4.
- Spec section 4 surfaces: `shareAttemptOrder.ts` attempt-key form (doc) -> 3.1; `putShareMemory` signature unchanged -> 3.3.
- AR13 (plan review R1 #1): a resolved nameless recipient on the Sent to card is labelled by its formatted phone; a missing one keeps no label; the wire comment says so -> 3.5 (units recipients GET, outcome-route re-projection, listings-sent unchanged).
- AR15: the full app suite at the slice exit -> S3 exit check step 3. Slice report (plan section 0) -> exit check step 8.
- NOT owned here: the audit `sentSkipped` mapping, the handler, `hasEventSince`, pins (S4); every renderer and the dashboard union (S5); GLOSSARY and e2e (S6).

## E. Notes for other slices

- **S4 calls** `applyFlyerShareEntry(deps, { unitId, contactId, signedUpAt })` from `app/src/services/shareLedger.ts`. `deps` is the existing `ShareLedgerDeps = { listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>; log: Logger }` (plan 2.6's `listingSendsRepo` dep satisfies `listingSends`). Returns `FlyerShareResult` (exported type): `'written'` -> `sentRecorded: true`, no `sentSkipped`; `'declined'` -> `sentSkipped: 'declined'`; `'refused'` -> `sentSkipped: 'refused'` (AR2); `'lost'` -> `sentSkipped: 'lost'`; a THROW -> `sentSkipped: 'error'`. The function already logs its INFO (declined) and ERROR (lost) lines - S4 logs only `housing-fair signup step failed` with `step: 'ledger'` on a throw. Pass `signedUpAt` as the ISO of the handler's ONE clock reading (AR8 #2; ms precision via `new Date(ms).toISOString()`; an equal instant twice answers `'refused'`).
- **New exports S4/S5/S6 may use:** `app/src/lib/shareLedgerKeys.ts` (`INDIVIDUAL_SHARE_KEY`, `FLYER_SHARE_KEY`, `flyerAttemptKey`, `latestCountedShareKey`); test helper `seedFlyerSignUp(repo, { unitId, contactId, signedUpAt })` in `app/test/helpers/listingSendSeed.ts` (throws unless `'written'`).
- **S5 wire facts:** `ListingSendRow.outcome` (units recipients, contact listings-sent, the outcome route's `row`) can now be `'signed_up'`; such a row's `sentAt` is the sign-up instant (render "Signed up from the flyer <date>" from it) and it carries NO `broadcastId` and no `declined`. It can be a tenant, an `unknown` contact (`type: 'unknown'`, `interestedSupported: false`) or a missing recipient (`recipientMissing: true`, `eligible: false`) - file the latter under Not eligible. `FollowUpItem.outcome`'s type widens but a follow-up item never carries `signed_up`. `via` on a flyer-only row is `'broadcast'` (first-write furniture) - never render it.
- **AR13 wire change (Task 3.5), for S5 and S6:** on the units recipients read and the outcome route's `row`, `tenantName` is now ALSO present for a resolved contact with no name - it is the formatted phone (`(404) 555-0142`; a non-NANP number as stored). So `ListingDetail.tsx:1343`'s `row.tenantName ?? row.contactId` shows the phone for a nameless unknown sign-up; no dashboard code change is needed. S5 may mirror the new wire comment on the dashboard `ListingSendRow.tenantName` (`dashboard/src/api/types.ts:3156`) - comment only. S6's flyer e2e can locate a nameless contact's Sent to row by its formatted phone, never by its contactId. The contact page's Properties sent rows carry no `tenantName` (unchanged).
- **Shared files touched by S3 that S4 also edits** (apply on top, never revert): `app/test/helpers/twilioWebhookHarness.ts` (S3: only the listing-sends fake's setDeclined / clearDeclined bodies and their comment, ~`:3638-3660`; S4: public router wiring and the activity-events fake); `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (S3: the `tokenAcrossDecline` builder before `const LS_CASES` and one appended LS case; S4: the activity-events `hasEventSince` cases); `app/test/contactTimeline.test.ts` (S3: one case in the D6 describe and one import line; S4: the `signed_up` mapper cases; S3 does not touch `contactTimeline.ts`).
- **Plan 3.1 Invariant D rows closed here:** decline writers stamp the token (3.2); the flyer writer refuses on the read it writes from (3.3); `blastAudienceRules.ts` excludes only `not_interested` (3.4 PIN); the repair census (3.3); `propertySentWords` residual (3.3).
- `app/test/helpers/listingSendSeed.ts` keeps its own local `INDIVIDUAL_KEY = 'individual'` constant (unchanged; equal to `INDIVIDUAL_SHARE_KEY`) - not worth a touch in this mission.

## 8. S4 - App: activity type + hasEventSince, public router deps + harness, the sign-up handler (D4-D7), the audit (Tasks 4.x)

Slice S4 owns spec D4, D5, D6 and the D7 call site; plan 2.5 and 2.6; AR2's
`refused` audit value and AR3's clock. Tasks: 4.1 the `signed_up` activity
type and `hasEventSince` (real repo, harness fake, conformance, timeline pin);
4.2 the router deps + harness wiring + who-is-existing (D4) + welcome for new
contacts only (D5); 4.3 the pin, the 24-hour repeat check and the unread mark
(D6); 4.4 the flyer share entry call site (D7); 4.5 the audit fields, the
route comment, the backfill pin and the PII test.

Build order (AR4): S1 -> S2 -> S3 -> S4 -> S5 -> S6. S4 needs S3
(`applyFlyerShareEntry` / `FlyerShareResult`, plan 2.2; the O1 decline token
in the harness fake; `seedFlyerSignUp`; the `signed_up` outcome on
`GET /api/contacts/:id/listings-sent`, plan 2.4). The test code below was
written against this worktree at 7ac1f2e3 (S3 not yet built) and has NOT been
executed (plan review R1 #7, a watch item: a compile error surfaces at a
task's Step 2 and is fixed there); every anchor was read from the files.

Plan review round 1 folded in: AR8 (the five issues below, all accepted),
AR11 (the deleted path's `sentSkipped: 'deleted'`), AR12 (`hasEventSince`
reads with `ConsistentRead: true`, pinned by a stub-doc test), R1 #6 (a spy
test pins touch -> increment on an adopted CLOSED thread), AR15 (the exit
check runs the full app suite), and the slice-report and commit-message
ground rules (plan section 0).

## A. CONTRACT ISSUES (for the planner to rule)

None open. Issues 1-5 below were ACCEPTED as AR8 and the tasks implement them
exactly; they are kept for the record.

1. The pin's `at`. Plan 2.6 step 8 does not say what instant the pin is
   recorded with; `record` defaults `at` to the WALL clock
   (`activityEventsRepo.ts:141`). The repeat window (step 7) compares against
   the pin's stored key, and AR3 makes the injected `now` the only time
   source, so a wall-clock pin would sit outside an injected window in every
   test. S4 records the pin with `at: nowIso` (the injected clock). Ruling
   requested: accept.
2. ONE clock reading per request. Plan 2.6 writes `now()` twice (step 7's
   window, step 9's `signedUpAt`) and leaves the touch timestamp to `nowIso`.
   S4 reads `now()` ONCE, right AFTER the welcome step (so in production the
   unread mark's touch follows the welcome's own touch), and derives the
   window start, the pin `at`, the touch `ts` and `signedUpAt` from it.
   Ruling requested: accept.
3. A harness seam for the clock. Plan 2.6 names only `world.activityEventsRepo`,
   `world.listingSendsRepo` and `world.events` for the harness `public:` block.
   Tests need the injected clock too, so S4 adds `HarnessOptions.publicNow?: () => number`
   (beside `toursNow` / `placementsNow` / `relayGroupsNow`) and forwards it as
   the router's `now`. Additive. Ruling requested: accept.
4. A failed pin does NOT skip the unread mark. Plan 2.6 step 8 lists "the pin,
   then touch -> increment -> ONE event" and "each failure logged", but not
   whether a pin failure stops the mark. Spec D6.4 makes every step
   best-effort and D6 wants the sign-up in front of staff, so S4 runs the mark
   whatever the pin did (audit `recorded: false`). Ruling requested: accept.
5. "ONE conversation.updated" scope. For a NEW contact the welcome send
   already emits its own `conversation.updated` (`sendMessage.ts:738`); the
   unread mark adds exactly one more. S4's tests assert exactly one event for
   an existing contact, and for a new contact that the LAST event carries the
   incremented count. Ruling requested: confirm this reading.

## B. Facts the tasks rely on (verified on this worktree)

Router `app/src/routes/public.ts` (carries non-ASCII in pre-existing comments
at lines 1, 5, 14, 68-69, 79, 81, 114-115, 119, 127, 157, 159, 271, 277, 307,
322, 365, 381, 388, 402, 413, 428, 442 - any anchor that crosses one of those
lines is described by its ASCII prefix + line number; copy the exact text from
the file):
- `:13` route doc starts `//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId?, housingAuthority? }`; the block runs to `:24` `//          an existing contact is never changed beyond the welcome flag.)`.
- `:46` `import { SHAREABLE_STATUSES, isDeleted } from '../repos/unitsRepo.js';` - the UNIT `isDeleted` already owns the name, so the contact one must be aliased.
- `:50` `import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';`
- `:51` `import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';`
- `:54` `import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';` (`UnitItem` is already imported).
- `:91` `const MAX_UNIT_ID_LEN = 200;`
- `:133-134` the parser trims `firstName` / `lastName`; `:160-167` `unitId` is NOT trimmed by the parser (see E, whitespace).
- `:201-226` `export interface PublicRouterDeps {` ... `  contactNumber?: string;` / `}`.
- `:228-249` the defaults; `:251` `  const router = Router();`.
- `:310-319` `    let viaFlyer = false;` / `    if (unitId !== undefined) {` / `      const flyerUnit = await units.getById(unitId);` (the unit object is local to the `if`).
- `:321-330` the dedupe block (line 322 non-ASCII): `    // (1) Dedupe by phone. A fair signup for an existing phone must NOT create` ... `    const existing = await contacts.findByPhone(phone);` / `    let contactId: string;` / `    let alreadyWelcomed: boolean;` / `    if (existing) {` / `      contactId = existing.contactId;` / `      alreadyWelcomed = existing['housing_fair_welcomed'] === true;` / `    } else {`.
- `:340` `      const created = await contacts.create({` (unique); `:372-374` `      contactId = created.contactId;` / `      alreadyWelcomed = false;` / `    }`.
- `:376-379` `    // (2) Conversation: create or get the 1:1 tenant thread and link the` / `    // contact, so the welcome text and any reply land on one thread.` / `    const conversation = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');` / `    await conversations.setParticipantsIfAbsent(conversation.conversationId, [{ contactId, phone }]);`.
- `:381-384` (381 non-ASCII) `    // (3) Welcome text` ... / `    // A repeat signup never re-sends (no SMS spend, no spam).` / `    let welcomeSent = false;` / `    if (!alreadyWelcomed) {`.
- `:396-399` `        // Flag the contact so a later signup with the same phone is a no-op` / `        // for the welcome. Best-effort: a failure here only risks ONE possible` / `        // duplicate welcome on a later signup, never a crash.` / `        await contacts.update(contactId, { housing_fair_welcomed: true });`.
- `:413` (non-ASCII) starts `    // (4) Audit (no PII in the payload beyond the marker`; `:420-427` the audit append with `marker, isNew: existing === undefined, welcomeSent, viaFlyer, signupVersion: 2, housingAuthority: housingAuthority ?? null`; `:431-440` the `log.info({ marker, isNew, welcomeSent, viaFlyer, withAuthority }, 'housing-fair signup captured')`; `:442-443` (442 non-ASCII) `    // (5) Minimal response` / `    res.json({ ok: true });`.
- `app/src/app.ts:56` `public?: Omit<PublicRouterDeps, 'logger'>;` and `:192-200` `createPublicRouter({ logger: log, ...contactNumber..., ...deps.public })` - production needs no app.ts change (plan 2.6). `:146` `app.use(trimJsonBody());` trims every JSON string value.

Helpers the handler calls:
- `app/src/repos/contactsRepo.ts:412` `export function isDeleted(contact: Pick<ContactItem, 'deleted_at'>): boolean {`; `:1287` `async findByPhone(phone) {` returns the FIRST byPhone hit, deleted or not; `:54` `export type ContactType = 'tenant' | 'landlord' | 'partner' | 'team_member' | 'unknown';`; `:820` `create(...): Promise<ContactItem>`.
- `app/src/lib/voiceMasking.ts:28` `export function conversationTypeFor(contact: ContactItem | undefined): ConversationType {` (landlord -> landlord_1to1, tenant -> tenant_1to1, partner -> partner_1to1, else unknown_1to1).
- `app/src/lib/address.ts:112` `export function formatAddress(a: Address | string | undefined | null): string {` (total; `''` for none); `formatStreet` joins line1/line2 with a space; city line is `city, state zip`. `app/src/routes/units.ts:1578` `const address = formatAddress(unit.address) || unitId;` is the tour-request fallback the spec cites.
- `app/src/lib/events.ts:89` `export function toConversationUpdatedEvent(item: ConversationItem): ConversationUpdatedEvent {` (`unread_count: item.unread_count ?? 0`); `:334` `export interface EventBus {`; `:378` `export const appEvents: EventBus = createEventBus();`. `emit` isolates listener throws (`:350-360`).
- `app/src/repos/conversationsRepo.ts:670-674` `touchLastActivity(conversationId: string, previewText: string | undefined, ts: string): Promise<ConversationItem>` (an undefined preview leaves the stored one, `:1634-1637`); `:719` `incrementUnread(conversationId: string): Promise<number>`.
- `app/src/services/shareLedger.ts:33-36` `export interface ShareLedgerDeps { listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>; log: Logger; }`. S3 adds (plan 2.2, assumed): `export type FlyerShareResult = 'written' | 'declined' | 'refused' | 'lost';` and `export async function applyFlyerShareEntry(deps: ShareLedgerDeps, args: { unitId: string; contactId: string; signedUpAt: string }): Promise<FlyerShareResult>`; its INFO line `share ledger: flyer entry not written - the pair holds a current decline` and its ERROR line from plan 1.1; an equal or older `signedUpAt` answers `'refused'`. S3 also adds the test helper `seedFlyerSignUp(repo, { unitId, contactId, signedUpAt })` to `app/test/helpers/listingSendSeed.ts` (throws unless `'written'`).
- `app/src/services/sendMessage.ts:472-475` the A2P kill switch refuses with `SmsSendingDisabledError` (code `sms_sending_disabled`) BEFORE any touch when `config.smsSendingEnabled === false`; `:708` the send's own `touchLastActivity(conversationId, body, result.providerTs)`; `:738` its own `conversation.updated` emit.
- `app/src/lib/smsCompliance.ts:91` `export const CONSENT_VERSION = 'ctia-2026-06';` (already imported by public.ts `:43`).
- `app/src/routes/contacts.ts:1295` `GET /:contactId/listings-sent` derives `outcome` per row from the stored row (S3 makes a latest-counted `flyer` entry read `signed_up`).
- `app/src/routes/contactTimeline.ts:678-688` `function toTimelineMilestone(e: ActivityEventItem): TimelineMilestone {` passes `type`, `label`, `refType`, `refId` through for EVERY type; `:1386` only `listing_sent` pins are re-worded. So `signed_up` needs NO contactTimeline.ts source change (plan 2.5's "maps signed_up like the other milestones" is met by the union member alone); S4 pins it with a test.
- `app/scripts/backfill-join-housing-authority.ts:226-229` `const signedUpAgain = events.some((e) => e.event_type === 'housing_fair_signup' && isRecord(e.payload) && e.payload['signupVersion'] === 2);` - reads only `signupVersion`; the new fields cannot change it.

Activity events `app/src/repos/activityEventsRepo.ts` (non-ASCII at 16 pre-existing lines; the anchors below are ASCII):
- `:17` `// are contractual (lib/tables.ts).`; `:23` `import { getDocumentClient } from '../lib/dynamo.js';`
- `:65-66` `  | 'listing_decline_cleared'` / `  | 'listing_interested';` (the union's end).
- `:120-125` `  /** Newest-first page of a contact's milestone log. */` / `  listByContact(` / `    contactId: string,` / `    opts?: ListByContactOptions,` / `  ): Promise<{ items: ActivityEventItem[] }>;` / `}`.
- `:141` `const at = input.at ?? new Date().toISOString();`; `:143` SK = `buildTsEventId(at, eventId)` = `<at>#<eventId>`.
- `:181-184` `      return { items: (Items ?? []) as ActivityEventItem[] };` / `    },` / `  };` / `}`.
- `app/src/lib/dynamoPaging.ts:29` `export async function queryAll<T>(doc, input: QueryCommandInput, opts: { maxPages?: number; logger?: Logger } = {}): Promise<T[]>` - the KEY ends the walk, not the item count.
- `app/src/lib/tables.ts:397-400` `activity_events`: hash `contactId`, range `tsEventId`, no GSIs.
- `app/src/lib/config.ts:512-514` `tableName(base, env)` is `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}${base}`, so `{ TABLE_PREFIX: 'hc-test-x-' }` names the table `hc-test-x-activity_events`.
- The pure stub-doc idiom for a repo's command input: `app/test/contactsRepoConsistentBatchRead.test.ts:30-46` (`function stubDoc(...)` records every `BatchGetCommand` input; `makeRepo(doc)` builds the repo on it); also `app/test/aiRunsRepo.test.ts:479` `expect(getInputs()[0]!.input.ConsistentRead).toBe(true);`. AR12's test follows it for `QueryCommand`.
- Only full implementers of `ActivityEventsRepo`: the real factory and the harness fake (`twilioWebhookHarness.ts:3562`); `lib/personEvents.ts:51` takes `Pick<..., 'record'>`. Adding `hasEventSince` to the interface breaks `tsc` until the fake has it - so the repo, the fake and the conformance cases are ONE task (4.1).
- `app/test/activityEventsRepo.integration.test.ts` (non-ASCII on lines 1 and one more): `:4` `// a different contact are fully isolated (the PK partition).`; `:9-10` `import { randomUUID } from 'node:crypto';` / `import { afterAll, beforeAll, describe, expect, it } from 'vitest';`; `:39-43` `testEnv`, `client`, `doc`, `logger`, `repo` are in scope of the describe; the file ends `:148-151` `    expect(bPage.items.every((e) => e.contactId === b)).toBe(true);` / `  });` / `});`.

Harness `app/test/helpers/twilioWebhookHarness.ts`:
- `:3582-3591` the fake's `listByContact`, ending `        .filter((e) => (opts.before === undefined ? true : e.tsEventId < opts.before))` / `        .sort((a, b) => (a.tsEventId < b.tsEventId ? 1 : -1)) // newest-first` / `        .slice(0, opts.limit ?? 50)` / `        .map((e) => ({ ...e }));` / `      return { items };` / `    },` / `  };` (the `.filter((e) => (opts.before ...` line is unique in the file).
- `:3601-3685` the listing-sends fake (S3 edits `setDeclined` / `clearDeclined` there).
- `:652-669` fake `createOrGetByParticipantPhone` returns the stored OPEN conversation BY REFERENCE, else creates one with the requested `type`; `:673-687` `touchLastActivity` pushes `world.touches`, sets status open, `last_activity_at = ts`, keeps the preview when `previewText` is undefined; `:714-725` `incrementUnread` bumps `unread_count`, sets `unread_flag`, pushes `world.unreadIncrements`; `:615-623` `world.emitted` records every `conversation.updated`; `:2254` fake `findByPhone` returns the first phone match (deleted or not) BY REFERENCE.
- `:300` `touches`, `:304` `unreadIncrements`, `:409` `emitted`, `:424-428` `activityEvents`, `activityEventsRepo`, `listingSends`, `listingSendsRepo` on `FakeWorld`.
- `:5538-5542` `  /**` / `   * Injected clock for the RELAY-GROUP router's standalone-preview quiet-hours` / `   * evaluation (POST /api/relay-groups/preview). Omit to use the wall clock.` / `   */` / `  relayGroupsNow?: () => string;`
- `:5761-5785` the `public:` block; it ends `        auditRepo: world.auditRepo,` / `        events: world.events,` / `      }),` / `    },` / `    webhooks: {` (this 5-line run is unique). The router's logger is the app logger, so router log lines land in `capture.lines`.
- `app/test/helpers/logCapture.ts`: `capture.lines` are parsed pino lines; `level` 30 info, 40 warn, 50 error.
- `app/test/helpers/authSession.ts`: `TEST_SESSION_COOKIE`; authed requests set `x-origin-verify: ORIGIN_SECRET` and `cookie`.
- `app/test/helpers/listingSendSeed.ts`: `seedListingSend(repo, { unitId, contactId, sentAt })` seeds a counted `individual` entry through the ledger.

Conformance `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (ASCII):
- `:26` `// created once per file and never reset.`; `:34` `import { getTableSpec } from '../src/lib/tables.js';`
- `:1078` `// ---- the harness -----------------------------------------------------------`; `:1086` `const realListingSends = createListingSendsRepo({ doc, env: testEnv, logger });`
- `:1169-1176` `expectScripted(realAnswer, expectation, where)`.
- `:1205` and `:1211` `    for (const base of ['messages', 'broadcasts', 'listing_sends'] as const) {` (twice, identical).
- `:1254-1270` the `listingSendsRepo` describe ends `          await ledgerAgree(world, ctx, c.watch, where);` / `        }` / `      }, 60_000);` / `    }` / `  });` / `});` (end of file).

Tests to change:
- `app/test/publicIntake.test.ts` (non-ASCII at 73, 117, 131, 139, 151, 168, 184, 188, 538 and others): `:67` `it('is idempotent on a repeat phone: ...` with `:82` `    expect(world.contacts.length).toBe(contactCount); // no duplicate contact` - stays green under D5 (the second sign-up is existing, so not welcomed) and is EXTENDED in 4.3; `:105-119` the PII test, ending `    expect(capture.lines.some((l) => l['msg'] === 'housing-fair signup captured')).toBe(true);` / `  });`; `:166-185` `it('does not fail the public request when the welcome send is refused (opted-out phone)', ...` (an EXISTING contact - under D5 it would pass vacuously; retargeted in 4.2); `:1161-1182` `it('(PIN) an existing phone never welcomed gets the welcome and its flag, and nothing else', ...` (RED under D5; rewritten in 4.2); exact audit payload `toEqual`s at `:1199-1212`, `:1231-1248`, `:1260-1269`, `:1292-1305` (updated in 4.5).
- `app/test/rateLimitClientKey.test.ts:101-140` posts fresh phones only (new contacts, welcome unchanged) - stays green.
- `app/test/backfillJoinHousingAuthority.test.ts:165-172` `const RESIGNUP_PAYLOAD = { marker: 'mk', isNew: false, welcomeSent: false, viaFlyer: false, signupVersion: 2, housingAuthority: 'DeKalb County Housing Authority' };`; `:72-77` `const event = (event_type, payload?) => ({ entityKey: 'contacts#c-lead', ts: ..., event_type, ...payload })`; `:226-239` the `it('a sign-up after the change (signupVersion 2) leaves the lead out - and wins over an authority history', () => {` case ending `    expect(leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, signupVersion: '2' })])).toBeNull();` / `  });`.
- `app/test/contactTimeline.test.ts` ends `  });` / `});` (`:2577-2578`); it already imports `request`, `makeWebhookHarness`, `ORIGIN_SECRET`, `TEST_SESSION_COOKIE` (`:11-18`). S3 also adds a case and an import there.

Other: `tsconfig.base.json` has `strict` and `noUncheckedIndexedAccess`, no `noUnusedLocals`; the e2e callers of `/public/housing-fair` (`e2e/scenarios/steps.ts:609`, `a2p-compliance.spec.ts`, `settings.spec.ts`, `proof-of-send.spec.ts`) all use fresh phones (see E).

## C. Commands used by every task

All from Git Bash. Never pipe a test or gate command (the ASCII check is not a gate).
- DynamoDB Local must be up for EVERY app vitest run: `cd "W:/tmp/flyer-leads" && npm run db:start` (STARTS it; never restart the shared container).
- Exported AWS keys break `npm test` style runs: `env | grep '^AWS_'`; if anything prints, prefix each vitest command with `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY`.
- App tests: `cd "W:/tmp/flyer-leads/app" && npx vitest run test/<file> [test/<file> ...]`.
- Typecheck (app, all three configs): `cd "W:/tmp/flyer-leads/app" && npm run typecheck`.
- ASCII, pre-existing file: `cd "W:/tmp/flyer-leads" && git diff -U0 -- <path> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`.
- ASCII, new file: `cd "W:/tmp/flyer-leads" && tr -d '\11\12\15\40-\176' < <path> | wc -c` -> `0`.
- After any Edit, confirm no decoded escape: `grep -nF '\u' <path>` shows no line the task added. (Use `-F`: in this Git Bash, plan 0's `grep -n '\\u'` matched lines with no backslash at all.) No S4 code contains a backslash-u.
- Commit, in three separate calls: (1) `cd "W:/tmp/flyer-leads" && git status` (bare; read it: only this task's paths modified); (2) `ls "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD"` -> must answer `No such file or directory`; (3) `cd "W:/tmp/flyer-leads" && git add <explicit paths> && git commit -m "<subject>" -m "<body>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` - repeated `-m` (plan section 0), never a message file inside the worktree. Each Step 6 below gives the `-m` values; none contains a double quote, a backtick or a dollar sign.

## Task 4.1 - The `signed_up` activity type and `hasEventSince` (repo, harness fake, conformance, timeline pin)

Goal: `ActivityEventType` gains `signed_up`; `ActivityEventsRepo.hasEventSince(contactId, type, sinceIso, refId)` answers the D6.1 repeat check (plan 2.5) in the real repo - strongly consistent (AR12) - and in the harness fake, held together by the conformance suite; the timeline passes a `signed_up` pin through (spec D6.2, plan 2.5).

Files: `app/src/repos/activityEventsRepo.ts`; `app/test/activityEventsRepo.integration.test.ts`; NEW `app/test/activityEventsRepoConsistentRead.test.ts`; `app/test/helpers/twilioWebhookHarness.ts`; `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`; `app/test/contactTimeline.test.ts`.

### Step 1 - tests first

1a. `app/test/activityEventsRepo.integration.test.ts`
- After the line `// a different contact are fully isolated (the PK partition).` (line 4) insert:
```ts
// flyer-leads D6 adds hasEventSince, the public sign-up's repeat check: the
// window edge, the type filter, ref vs no ref, the partition, paging to the
// end of the window, and a throw on a DynamoDB error.
```
- Replace `import { randomUUID } from 'node:crypto';` with:
```ts
import { randomUUID } from 'node:crypto';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
```
- Replace the file's last three lines `    expect(bPage.items.every((e) => e.contactId === b)).toBe(true);` / `  });` / `});` with:
```ts
    expect(bPage.items.every((e) => e.contactId === b)).toBe(true);
  });

  // flyer-leads D6: hasEventSince - one pin per contact per source per 24
  // hours. sinceIso bounds the `<ISO at>#<eventId>` key EXCLUSIVELY, so an
  // event AT sinceIso (its key extends the bound) is inside the window and
  // one a millisecond before sinceIso is not.
  describe('hasEventSince (flyer-leads D6)', () => {
    const T0 = '2026-10-21T12:00:00.000Z';
    const BEFORE = '2026-10-21T11:59:59.999Z';
    const AFTER = '2026-10-21T12:00:00.001Z';
    const newContact = (): string => `contact-${randomUUID().slice(0, 8)}`;

    it('the window edge: an event AT sinceIso counts; one a millisecond before sinceIso does not', async () => {
      const contactId = newContact();
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      await repo.record({
        contactId,
        type: 'signed_up',
        label: 'Signed up from the flyer for 1 Main St as Ann Lee',
        refType: 'unit',
        refId: 'unit-1',
        at: T0,
      });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', T0, 'unit-1')).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', AFTER, 'unit-1')).toBe(false);
    });

    it('the type filter: another milestone type with the same ref never counts', async () => {
      const contactId = newContact();
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: T0 });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      expect(await repo.hasEventSince(contactId, 'listing_sent', BEFORE, 'unit-1')).toBe(true);
    });

    it('ref vs no ref: undefined matches only an event with NO refId; a refId matches only its own', async () => {
      const contactId = newContact();
      await repo.record({
        contactId,
        type: 'signed_up',
        label: 'Signed up from the flyer for 2 Elm St as Ann Lee',
        refType: 'unit',
        refId: 'unit-2',
        at: T0,
      });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, undefined)).toBe(false);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-2')).toBe(true);
      await repo.record({ contactId, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: T0 });
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, undefined)).toBe(true);
      expect(await repo.hasEventSince(contactId, 'signed_up', BEFORE, 'unit-1')).toBe(false);
    });

    it('the contact partition: another contact event never counts', async () => {
      const a = newContact();
      const b = newContact();
      await repo.record({ contactId: a, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: T0 });
      expect(await repo.hasEventSince(b, 'signed_up', BEFORE, undefined)).toBe(false);
      expect(await repo.hasEventSince(a, 'signed_up', BEFORE, undefined)).toBe(true);
    });

    it('pages to the END of the window: a match between filtered-out rows is found at one row per page', async () => {
      const contactId = newContact();
      const at = (second: number): string => `2026-10-21T12:00:0${second}.000Z`;
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: at(1) });
      await repo.record({ contactId, type: 'stage_changed', label: 's', at: at(2) });
      await repo.record({ contactId, type: 'signed_up', label: 'Signed up on the join page as Ann Lee', at: at(3) });
      await repo.record({ contactId, type: 'listing_sent', label: 'Property sent', refType: 'unit', refId: 'unit-1', at: at(4) });
      await repo.record({ contactId, type: 'stage_changed', label: 's', at: at(5) });
      // Limit 1 on EVERY Query the repo sends: a read that stops after one
      // page sees only the first (or, newest-first, the last) row - neither
      // matches - and answers false. The match is the third row.
      let queries = 0;
      const onePerPageDoc = {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            queries += 1;
            return doc.send(new QueryCommand({ ...command.input, Limit: 1 }));
          }
          return doc.send(command as never);
        },
      } as unknown as DynamoDBDocumentClient;
      const pagingRepo = createActivityEventsRepo({ doc: onePerPageDoc, env: testEnv, logger });
      expect(await pagingRepo.hasEventSince(contactId, 'signed_up', T0, undefined)).toBe(true);
      expect(queries).toBeGreaterThanOrEqual(3);
    });

    it('throws on a DynamoDB error (the sign-up handler is the one that fails open)', async () => {
      const failingDoc = {
        send: async () => {
          throw new Error('dynamo unavailable');
        },
      } as unknown as DynamoDBDocumentClient;
      const failingRepo = createActivityEventsRepo({ doc: failingDoc, env: testEnv, logger });
      await expect(failingRepo.hasEventSince('contact-x', 'signed_up', T0, undefined)).rejects.toThrow('dynamo unavailable');
    });
  });
});
```

1b. `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`
- After `// created once per file and never reset.` (line 26) insert:
```ts
//
// flyer-leads D6 adds the activity-events fake's hasEventSince (the public
// sign-up's repeat check): the window edge, the type filter, ref vs no ref
// and the contact partition, script against script.
```
- After `import { getTableSpec } from '../src/lib/tables.js';` insert:
```ts
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
  type ActivityEventType,
} from '../src/repos/activityEventsRepo.js';
```
- Immediately ABOVE `// ---- the harness -----------------------------------------------------------` insert:
```ts
// ===========================================================================
// activityEventsRepo (flyer-leads D6): hasEventSince, the public sign-up's
// repeat check - the window edge, the type filter, ref vs no ref, the
// contact partition
// ===========================================================================

interface AeCtx {
  id: string;
}

interface AeStep {
  label: string;
  run: (repo: ActivityEventsRepo, ctx: AeCtx) => Promise<unknown>;
  /** What the REAL answer must be (toBe for a primitive). */
  expect?: unknown;
}

interface AeCase {
  name: string;
  steps: AeStep[];
}

const aeContact = (ctx: AeCtx, name: string): string => `c-${ctx.id}-${name}`;
const AE_T0 = '2026-10-21T12:00:00.000Z';
const AE_BEFORE = '2026-10-21T11:59:59.999Z';
const AE_AFTER = '2026-10-21T12:00:00.001Z';

/** record() at a fixed instant; answers the stored item minus its random id and wall clock. */
const aeRecord = (contact: string, type: ActivityEventType, at: string, refId?: string): AeStep => ({
  label: `record ${contact} ${type} at=${at} ref=${refId ?? '(none)'}`,
  run: async (repo, ctx) => {
    const item = await repo.record({
      contactId: aeContact(ctx, contact),
      type,
      label: 'Signed up on the join page as Parity Probe',
      at,
      ...(refId !== undefined && { refType: 'unit' as const, refId }),
    });
    return {
      contactId: item.contactId,
      type: item.type,
      at: item.at,
      refType: item.refType,
      refId: item.refId,
      keyedAt: item.tsEventId.startsWith(`${at}#`),
    };
  },
});

const aeSince = (contact: string, type: ActivityEventType, sinceIso: string, refId: string | undefined, expected: boolean): AeStep => ({
  label: `hasEventSince ${contact} ${type} since=${sinceIso} ref=${refId ?? '(none)'}`,
  run: async (repo, ctx) => repo.hasEventSince(aeContact(ctx, contact), type, sinceIso, refId),
  expect: expected,
});

const AE_CASES: AeCase[] = [
  {
    name: 'hasEventSince: the window edge - an event AT sinceIso counts, one a millisecond before it does not',
    steps: [
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', false),
      aeRecord('a', 'signed_up', AE_T0, 'unit-1'),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', true),
      aeSince('a', 'signed_up', AE_T0, 'unit-1', true),
      aeSince('a', 'signed_up', AE_AFTER, 'unit-1', false),
    ],
  },
  {
    name: 'hasEventSince: the type filter - another milestone type on the same ref never counts',
    steps: [
      aeRecord('a', 'listing_sent', AE_T0, 'unit-1'),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', false),
      aeSince('a', 'listing_sent', AE_BEFORE, 'unit-1', true),
    ],
  },
  {
    name: 'hasEventSince: ref vs no ref - undefined matches only an event with NO refId, a refId only its own',
    steps: [
      aeRecord('a', 'signed_up', AE_T0, 'unit-2'),
      aeSince('a', 'signed_up', AE_BEFORE, undefined, false),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', false),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-2', true),
      aeRecord('a', 'signed_up', AE_T0),
      aeSince('a', 'signed_up', AE_BEFORE, undefined, true),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', false),
    ],
  },
  {
    name: 'hasEventSince: the contact partition - another contact event never counts',
    steps: [
      aeRecord('a', 'signed_up', AE_T0, 'unit-1'),
      aeSince('b', 'signed_up', AE_BEFORE, 'unit-1', false),
      aeSince('a', 'signed_up', AE_BEFORE, 'unit-1', true),
    ],
  },
];

```
- Replace `const realListingSends = createListingSendsRepo({ doc, env: testEnv, logger });` with:
```ts
const realListingSends = createListingSendsRepo({ doc, env: testEnv, logger });
const realActivityEvents = createActivityEventsRepo({ doc, env: testEnv, logger });
```
- Replace BOTH occurrences (Edit with replace_all) of `['messages', 'broadcasts', 'listing_sends'] as const` with `['messages', 'broadcasts', 'listing_sends', 'activity_events'] as const`.
- Replace the file's last six lines `          await ledgerAgree(world, ctx, c.watch, where);` / `        }` / `      }, 60_000);` / `    }` / `  });` / `});` (re-read: S3 may have changed the lines above them, not these) with:
```ts
          await ledgerAgree(world, ctx, c.watch, where);
        }
      }, 60_000);
    }
  });

  describe('activityEventsRepo', () => {
    for (const [caseNo, c] of AE_CASES.entries()) {
      it(c.name, async () => {
        const ctx: AeCtx = { id: `${caseNo}-${randomUUID().slice(0, 8)}` };
        const world = createFakeWorld();
        for (const [stepNo, step] of c.steps.entries()) {
          const where = `${c.name} / step ${stepNo} ${step.label}`;
          const realAnswer = await step.run(realActivityEvents, ctx);
          const fakeAnswer = await step.run(world.activityEventsRepo, ctx);
          expect(fakeAnswer, `${where}: result`).toStrictEqual(realAnswer);
          expectScripted(realAnswer, step.expect, where);
        }
      }, 60_000);
    }
  });
});
```

1c. `app/test/contactTimeline.test.ts` - append at the END of the file (after S3's additions, if any):
```ts

describe('flyer-leads D6: a signed_up pin passes through the timeline', () => {
  it('(PIN) keeps its label and its unit ref; a ref-less sign-up pin carries no ref', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c-signup', type: 'tenant', status: 'searching', phone: '+15550109001' });
    await world.activityEventsRepo.record({
      contactId: 'c-signup',
      type: 'signed_up',
      label: 'Signed up from the flyer for 12 Oak St as Ann Lee',
      refType: 'unit',
      refId: 'unit-1',
      at: '2026-10-21T12:00:00.000Z',
    });
    await world.activityEventsRepo.record({
      contactId: 'c-signup',
      type: 'signed_up',
      label: 'Signed up on the join page as Ann Lee',
      at: '2026-10-21T13:00:00.000Z',
    });

    const res = await request(app)
      .get('/api/contacts/c-signup/timeline?kinds=milestone')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    const pins = (res.body.items as Array<Record<string, unknown>>).filter((i) => i['type'] === 'signed_up');
    expect(pins).toEqual([
      expect.objectContaining({
        kind: 'milestone',
        at: '2026-10-21T12:00:00.000Z',
        label: 'Signed up from the flyer for 12 Oak St as Ann Lee',
        refType: 'unit',
        refId: 'unit-1',
      }),
      expect.objectContaining({ kind: 'milestone', at: '2026-10-21T13:00:00.000Z', label: 'Signed up on the join page as Ann Lee' }),
    ]);
    expect(pins[1]).not.toHaveProperty('refType');
    expect(pins[1]).not.toHaveProperty('refId');
  });
});
```

1d. NEW `app/test/activityEventsRepoConsistentRead.test.ts` (AR12):
```ts
// flyer-leads AR12 (plan 2.5, plan review R1 #5): hasEventSince - the public
// sign-up's repeat check - reads STRONGLY CONSISTENT, so two quick sign-ups
// see each other's pin (an eventually consistent Query could miss the first
// pin and let both pin and bump). Every page of the walk carries it.
//
// Pure: a stub DocumentClient records every QueryCommand input (the
// contactsRepoConsistentBatchRead.test.ts pattern). DynamoDB Local's
// acceptance of the consistent Query is exercised by
// activityEventsRepo.integration.test.ts.
import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createActivityEventsRepo } from '../src/repos/activityEventsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const SINCE = '2026-10-20T12:00:00.000Z';
const CURSOR = { contactId: 'c-1', tsEventId: '2026-10-21T12:00:00.000Z#evt-x' };

/** A table that answers two pages: an EMPTY first page that still carries a cursor, then nothing. */
function stubDoc() {
  const requests: QueryCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (!(command instanceof QueryCommand)) throw new Error('stub: expected a QueryCommand');
      requests.push(command.input);
      return requests.length === 1 ? { Items: [], LastEvaluatedKey: CURSOR } : { Items: [] };
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, requests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const logger = createLogger({ destination: createLogCapture().stream });
  return createActivityEventsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger });
}

describe('activityEventsRepo.hasEventSince - ConsistentRead (flyer-leads AR12)', () => {
  it('every page of the window read is strongly consistent, on the key-range query plan 2.5 binds', async () => {
    const { doc, requests } = stubDoc();

    expect(await makeRepo(doc).hasEventSince('c-1', 'signed_up', SINCE, 'unit-1')).toBe(false);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        TableName: 'hc-test-x-activity_events',
        ConsistentRead: true,
        KeyConditionExpression: 'contactId = :c AND tsEventId > :since',
        FilterExpression: '#type = :type AND refId = :ref',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':c': 'c-1', ':since': SINCE, ':type': 'signed_up', ':ref': 'unit-1' },
      });
    }
    expect(requests[1]?.ExclusiveStartKey).toEqual(CURSOR);
  });

  it('the no-ref source filters on attribute_not_exists(refId), binds no :ref, and is consistent too', async () => {
    const { doc, requests } = stubDoc();

    await makeRepo(doc).hasEventSince('c-1', 'signed_up', SINCE, undefined);

    expect(requests[0]).toMatchObject({
      ConsistentRead: true,
      FilterExpression: '#type = :type AND attribute_not_exists(refId)',
    });
    expect(requests[0]?.ExpressionAttributeValues).not.toHaveProperty(':ref');
  });
});
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/activityEventsRepo.integration.test.ts test/activityEventsRepoConsistentRead.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/contactTimeline.test.ts`

Expected: the six `hasEventSince (flyer-leads D6)` cases, the two `ConsistentRead (flyer-leads AR12)` cases and the four `activityEventsRepo` conformance cases fail with `TypeError: ... hasEventSince is not a function` (the conformance cases fail on the REAL step, which runs first). The timeline `(PIN)` case passes (the mapper is generic). Every pre-existing case passes. (If 3a were later written without `ConsistentRead`, only the AR12 file would stay red - that is its job.)

### Step 3 - implementation

3a. `app/src/repos/activityEventsRepo.ts`
- After the header line `// are contractual (lib/tables.ts).` insert:
```ts
//
// flyer-leads D6: hasEventSince is the public sign-up's repeat check - one
// key-range Query on the contact's partition (`tsEventId > :since`), filtered
// to one type and one ref (or no ref), walked to the end of the window.
```
- Replace `import { getDocumentClient } from '../lib/dynamo.js';` with:
```ts
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
```
- Replace `  | 'listing_decline_cleared'` / `  | 'listing_interested';` with:
```ts
  | 'listing_decline_cleared'
  | 'listing_interested'
  // flyer-leads D6: a public sign-up (the flyer's sign-up box or /join) by an
  // existing or new contact, pinned in its thread. refType 'unit' + refId the
  // unitId when the flyer's property was shareable; NO ref for /join and any
  // other flyer - the one shared "no property" source of the 24-hour repeat
  // check (hasEventSince).
  | 'signed_up';
```
- Replace the interface tail `  ): Promise<{ items: ActivityEventItem[] }>;` / `}` (the end of `listByContact` in `export interface ActivityEventsRepo`) with:
```ts
  ): Promise<{ items: ActivityEventItem[] }>;
  /**
   * flyer-leads D6: whether the contact has an event of `type` recorded at or
   * after `sinceIso` whose refId is `refId` (undefined = an event with NO
   * refId). Query PK contactId, KeyCondition `tsEventId > :since` (sinceIso as
   * the bound), FilterExpression on `#type = :type` and on the ref
   * (`refId = :ref` or `attribute_not_exists(refId)`), `ConsistentRead: true`
   * (AR12 - two quick sign-ups must see each other's pin), paginated to the end
   * of the window (lib/dynamoPaging queryAll). Throws on a DynamoDB error.
   */
  hasEventSince(
    contactId: string,
    type: ActivityEventType,
    sinceIso: string,
    refId: string | undefined,
  ): Promise<boolean>;
}
```
- Replace the factory tail `      return { items: (Items ?? []) as ActivityEventItem[] };` / `    },` / `  };` / `}` with:
```ts
      return { items: (Items ?? []) as ActivityEventItem[] };
    },

    async hasEventSince(contactId, type, sinceIso, refId) {
      // flyer-leads D6. The bare ISO bounds `<ISO at>#<eventId>` keys, so an
      // event AT sinceIso is inside the window. A FilterExpression is applied
      // after each page is read, so the walk follows the cursor to the end
      // (queryAll) and never stops at an empty or filtered-out page. AR12:
      // strongly consistent (a base-table Query allows it), so a second
      // sign-up moments after the first sees the first one's pin. `type` is
      // a DynamoDB reserved word, hence #type. PII (doc section 9): no label is
      // read into a log line.
      const items = await queryAll<ActivityEventItem>(
        doc,
        {
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: 'contactId = :c AND tsEventId > :since',
          FilterExpression:
            refId === undefined
              ? '#type = :type AND attribute_not_exists(refId)'
              : '#type = :type AND refId = :ref',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':c': contactId,
            ':since': sinceIso,
            ':type': type,
            ...(refId !== undefined && { ':ref': refId }),
          },
        },
        { logger: log },
      );
      return items.length > 0;
    },
  };
}
```

3b. `app/test/helpers/twilioWebhookHarness.ts` - replace the fake's `listByContact` tail (anchor starts at the unique line `        .filter((e) => (opts.before === undefined ? true : e.tsEventId < opts.before))`):
```ts
        .filter((e) => (opts.before === undefined ? true : e.tsEventId < opts.before))
        .sort((a, b) => (a.tsEventId < b.tsEventId ? 1 : -1)) // newest-first
        .slice(0, opts.limit ?? 50)
        .map((e) => ({ ...e }));
      return { items };
    },
  };
```
with:
```ts
        .filter((e) => (opts.before === undefined ? true : e.tsEventId < opts.before))
        .sort((a, b) => (a.tsEventId < b.tsEventId ? 1 : -1)) // newest-first
        .slice(0, opts.limit ?? 50)
        .map((e) => ({ ...e }));
      return { items };
    },
    // flyer-leads D6: the repeat-check read, modelled on the real key-range
    // Query - the event's SK strictly after sinceIso (so an event AT sinceIso
    // counts: its `<at>#<eventId>` key extends the bound), its type, and its
    // ref: refId undefined matches only an event with NO refId. The array is
    // strongly consistent by construction, like the real read (AR12). Held to
    // the real repo by twilioWebhookHarnessRepoAdditions.integration.test.ts.
    async hasEventSince(contactId, type, sinceIso, refId) {
      return activityEvents.some(
        (e) =>
          e.contactId === contactId &&
          e.tsEventId > sinceIso &&
          e.type === type &&
          (refId === undefined ? e.refId === undefined : e.refId === refId),
      );
    },
  };
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/activityEventsRepo.integration.test.ts test/activityEventsRepoConsistentRead.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/contactTimeline.test.ts` -> all pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` -> exit 0.

### Step 5 - ASCII

New file: `app/test/activityEventsRepoConsistentRead.test.ts` -> `0`. Pre-existing-file check on `app/src/repos/activityEventsRepo.ts`, `app/test/activityEventsRepo.integration.test.ts`, `app/test/helpers/twilioWebhookHarness.ts`, `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`, `app/test/contactTimeline.test.ts` -> each `0`.

### Step 6 - commit

Paths: `app/src/repos/activityEventsRepo.ts app/test/activityEventsRepo.integration.test.ts app/test/activityEventsRepoConsistentRead.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts app/test/contactTimeline.test.ts`

`-m` values, in order:
1. `feat(activity): signed_up milestone type and the hasEventSince window read (flyer-leads D6)`
2. `The public sign-up's repeat check: a strongly consistent key-range Query on the contact's partition (tsEventId > since), filtered to one type and one ref or no ref, walked to the end of the window (AR12). The harness fake mirrors it and the conformance suite holds the two together (window edge, type filter, ref vs no ref, partition). The timeline already passes the new type through.`
3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Task 4.2 - Router deps + harness wiring; who counts as existing (D4); the welcome for new contacts only (D5)

Goal: `PublicRouterDeps` gains the four plan 2.6 deps (wired in the harness, plus the `publicNow` seam - AR8 point 3); the handler keeps `findByPhone` as its one lookup, sends a soft-deleted holder down the deleted path, never changes or welcomes an existing contact, and types a missing thread with `conversationTypeFor` (spec D4, D5; plan 2.6 steps 2-6).

Files: `app/src/routes/public.ts`; `app/test/helpers/twilioWebhookHarness.ts`; NEW `app/test/publicSignupLeads.test.ts`; `app/test/publicIntake.test.ts`.

### Step 1 - tests first

1a. NEW `app/test/publicSignupLeads.test.ts`:
```ts
// flyer-leads D4-D7 (plan section 8): POST /public/housing-fair for EXISTING
// and NEW contacts - who counts as existing (findByPhone, the deleted path),
// the welcome for new contacts only, the signed_up thread pin and its 24-hour
// repeat check, the unread mark (touch -> increment -> ONE event), the flyer
// share entry and the audit fields. Harness world fakes (no DynamoDB), with
// the public router's injected clock (plan 2.6, AR3) driven by `clock.ms`.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';
import type { ConversationType } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const FAIR = '/public/housing-fair';
/** signupBody's phone, normalized. */
const PHONE = '+15550102000';
const T0_ISO = '2026-10-21T15:00:00.000Z';
const T0 = Date.parse(T0_ISO);
const HOUR_MS = 3_600_000;

function signupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { firstName: 'Keisha', lastName: 'Jones', phone: '(555) 010-2000', smsConsent: true, ...overrides };
}

/** A harness whose public router reads `clock.ms` (plan 2.6 `now`), with a rate limit no case reaches. */
function harness(env: Record<string, string> = {}) {
  const clock = { ms: T0 };
  const h = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100', ...env }, publicNow: () => clock.ms });
  return { ...h, clock };
}

const post = (app: App, body: Record<string, unknown>) =>
  request(app).post(FAIR).set('x-origin-verify', ORIGIN_SECRET).send(body);

function seedUnit(world: FakeWorld, unitId = 'unit-1', over: Partial<UnitItem> = {}): UnitItem {
  const unit: UnitItem = {
    unitId,
    landlordId: 'll-1',
    status: 'available',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
    ...over,
  };
  world.units.set(unitId, unit);
  return unit;
}

/** An existing contact on PHONE (a welcomed, searching tenant unless overridden). */
function seedContact(world: FakeWorld, over: Partial<ContactItem> = {}): ContactItem {
  const contact = {
    contactId: 'c-1',
    type: 'tenant',
    status: 'searching',
    phone: PHONE,
    firstName: 'Tia',
    lastName: 'Moss',
    housing_fair_welcomed: true,
    ...over,
  } as ContactItem;
  world.contacts.push(contact);
  return contact;
}

const signupAudits = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup');

describe('who counts as an existing contact (D4) and the welcome for new contacts only (D5)', () => {
  it('an existing contact is never changed: no field written (consent included), no welcome, findByPhone the one lookup', async () => {
    const { app, world } = harness();
    seedUnit(world);
    // Never welcomed and no recorded consent: today's rule would have welcomed it and set the flag.
    seedContact(world, { status: 'needs_review', housing_fair_welcomed: false });
    const before = structuredClone(world.contacts);
    const update = vi.spyOn(world.contactsRepo, 'update');
    const create = vi.spyOn(world.contactsRepo, 'create');
    const findOne = vi.spyOn(world.contactsRepo, 'findByPhone');
    const findAll = vi.spyOn(world.contactsRepo, 'findAllByPhone');

    const res = await post(app, signupBody({ unitId: 'unit-1', voucherSize: 3 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(world.contacts).toStrictEqual(before);
    expect(world.contacts[0]).not.toHaveProperty('consent_method');
  });

  const THREAD_TYPES: Array<[ContactType, ConversationType]> = [
    ['landlord', 'landlord_1to1'],
    ['partner', 'partner_1to1'],
    ['unknown', 'unknown_1to1'],
  ];

  it.each(THREAD_TYPES)('an existing %s with no thread gets a %s thread and no welcome', async (type, threadType) => {
    const { app, world } = harness();
    seedContact(world, { type, housing_fair_welcomed: undefined });

    const res = await post(app, signupBody());

    expect(res.status).toBe(200);
    expect([...world.conversations.values()].map((c) => [c.participant_phone, c.type])).toEqual([[PHONE, threadType]]);
    expect(world.sent).toHaveLength(0);
  });

  it('(PIN) a NEW contact gets a tenant_1to1 thread and exactly one welcome, and its flag', async () => {
    const { app, world } = harness();

    const res = await post(app, signupBody());

    expect(res.status).toBe(200);
    expect([...world.conversations.values()].map((c) => c.type)).toEqual(['tenant_1to1']);
    expect(world.sent).toHaveLength(1);
    expect(world.contacts.find((c) => c.phone === PHONE)?.housing_fair_welcomed).toBe(true);
  });

  it('a soft-deleted holder takes the deleted path: no conversation, no send, no new contact, no write - only the audit, on THAT contact', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-del', deleted_at: '2026-10-01T00:00:00.000Z', housing_fair_welcomed: false });
    const before = structuredClone(world.contacts);
    const createOrGet = vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone');

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(createOrGet).not.toHaveBeenCalled();
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.contacts).toStrictEqual(before);
    expect(world.activityEvents).toHaveLength(0);
    expect(world.listingSends).toHaveLength(0);
    expect(world.unreadIncrements).toHaveLength(0);
    expect(signupAudits(world).map((e) => e.entityKey)).toEqual(['contacts#c-del']);
  });
});
```

1b. `app/test/publicIntake.test.ts`
- Replace the WHOLE `it(...)` block that starts at line 166 `  it('does not fail the public request when the welcome send is refused (opted-out phone)', async () => {` and ends at its closing `  });` (line 185; lines 168 and 184 carry non-ASCII dashes - copy them from the file) with:
```ts
  it('an EXISTING opted-out contact gets no welcome attempt at all (flyer-leads D5): nothing refused, nothing sent', async () => {
    const { app, world, capture } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'c-optout',
      type: 'tenant',
      status: 'active',
      phone: '+15550104000',
      sms_opt_out: true,
    } as ContactItem);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '+15550104000' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    // Not refused - never attempted: only a contact this request created is welcomed.
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair welcome text refused')).toBe(false);
  });

  it('does not fail the public request when the welcome send to a NEW contact is refused (the SMS kill switch)', async () => {
    const { app, world, capture } = makeWebhookHarness({ env: { SMS_SENDING_ENABLED: 'false' } });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '+15550104001' }));

    expect(res.status).toBe(200); // signup still succeeds
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0); // refused - no text sent
    expect(world.contacts.find((c) => c.phone === '+15550104001')?.housing_fair_welcomed).toBe(false);
    expect(
      capture.lines.some((l) => l['msg'] === 'housing-fair welcome text refused' && l['code'] === 'sms_sending_disabled'),
    ).toBe(true);
  });
```
- Replace the WHOLE block from `  it('(PIN) an existing phone never welcomed gets the welcome and its flag, and nothing else', async () => {` (line 1161) to its closing `  });` (line 1182; ASCII) with:
```ts
  it('an existing phone never welcomed is NOT welcomed now (flyer-leads D5), and nothing is written to it', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'needs_review',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      capture_source: 'housing_fair',
      housing_fair_welcomed: false,
    } as ContactItem);
    const neverWelcomed = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.sent).toHaveLength(0);
    expect(world.contacts).toEqual([neverWelcomed]);
  });
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts`

Expected RED: "an existing contact is never changed" (`world.sent` has 1, `update` was called); the three thread-type cases (`tenant_1to1` instead, and a welcome sent); the deleted-holder case (`createOrGetByParticipantPhone` was called, a conversation exists); publicIntake's "an EXISTING opted-out contact gets no welcome attempt" (the refused WARN line is present today); publicIntake's "never welcomed is NOT welcomed now" (`world.sent` has 1). The `(PIN)` new-contact case and the kill-switch case pass already. (Vitest ignores the not-yet-declared `publicNow` option at runtime.)

### Step 3 - implementation

3a. `app/src/routes/public.ts` - imports. Replace
`import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';`
with
```ts
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createContactsRepo, isDeleted as isContactDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
```
and replace `import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';` with
```ts
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import type { ListingSendsRepo } from '../repos/listingSendsRepo.js';
```
and replace `import { resolveUnitMedia } from '../lib/unitMedia.js';` with
```ts
import { resolveUnitMedia } from '../lib/unitMedia.js';
import type { EventBus } from '../lib/events.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
```

3b. `PublicRouterDeps` - replace
```ts
  contactNumber?: string;
}

export function createPublicRouter(deps: PublicRouterDeps = {}): Router {
```
with
```ts
  contactNumber?: string;
  /**
   * flyer-leads D6 (plan 2.6): the sign-up's `signed_up` thread pin and its
   * 24-hour repeat read (hasEventSince). Default createActivityEventsRepo().
   */
  activityEventsRepo?: Pick<ActivityEventsRepo, 'record' | 'hasEventSince'>;
  /**
   * flyer-leads D7 (plan 2.6): the properties-sent ledger a flyer sign-up's
   * `flyer` share entry is written through (services/shareLedger.ts
   * applyFlyerShareEntry). Default createListingSendsRepo().
   */
  listingSendsRepo?: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>;
  /**
   * flyer-leads D6: the bus the sign-up's unread mark emits its ONE
   * conversation.updated on, so open dashboards re-sort the bumped row.
   * Default appEvents (the process-wide bus the SSE route listens on).
   */
  events?: EventBus;
  /**
   * flyer-leads AR3: the clock (epoch ms) - the ONLY time source for the
   * 24-hour repeat window, the pin and touch instant and the flyer attempt
   * key, so tests are deterministic. Default Date.now.
   */
  now?: () => number;
}

export function createPublicRouter(deps: PublicRouterDeps = {}): Router {
```

3c. The lookup and the deleted path. Replace the region from line 321 `    // (1) Dedupe by phone. A fair signup for an existing phone must NOT create` through line 330 `    } else {` (line 322 carries a non-ASCII dash; the region ends with the `} else {` that opens the create branch) with:
```ts
    // (1) Who is signing up (flyer-leads D4). contacts.findByPhone stays the
    // ONE lookup - the same routing read the inbox, the unread feed and a
    // staff reply's gates use - so the thread pin, the unread mark and those
    // gates always judge the SAME contact. A live holder (any type) is an
    // EXISTING contact and is never changed by a sign-up (no name, type,
    // status, voucher size, housing authority, consent or welcome flag); a
    // soft-deleted holder takes the deleted path below; no holder creates a
    // new tenant, as before.
    const existing = await contacts.findByPhone(phone);

    // (1a) The deleted path (D4): no conversation, no send, no pin, no unread
    // mark, no sent-list entry - only the audit event on THAT contact (the
    // trace docs/issues/deleted-contact-web-signup-silent.md relies on) and
    // the generic { ok: true }.
    if (existing !== undefined && isContactDeleted(existing)) {
      await audit.append(`contacts#${existing.contactId}`, 'housing_fair_signup', {
        marker,
        isNew: false,
        welcomeSent: false,
        viaFlyer,
        signupVersion: 2,
        housingAuthority: housingAuthority ?? null,
      });
      log.info(
        { marker, isNew: false, welcomeSent: false, viaFlyer, withAuthority: housingAuthority !== undefined },
        'housing-fair signup captured',
      );
      res.json({ ok: true });
      return;
    }

    const isNew = existing === undefined;
    let contact: ContactItem;
    if (existing !== undefined) {
      contact = existing;
    } else {
```
Then replace `      const created = await contacts.create({` with `      contact = await contacts.create({`.

3d. The conversation. Replace
```ts
      contactId = created.contactId;
      alreadyWelcomed = false;
    }

    // (2) Conversation: create or get the 1:1 tenant thread and link the
    // contact, so the welcome text and any reply land on one thread.
    const conversation = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');
```
with
```ts
    }
    const contactId = contact.contactId;

    // (2) Conversation: create or get the contact's 1:1 thread, TYPED for the
    // contact (D6: conversationTypeFor - a landlord, partner or unknown
    // contact with no thread yet gets a correctly typed one; a new contact is
    // a tenant, so tenant_1to1 as before), and link the contact, so the
    // welcome text, any reply and the sign-up's unread mark land on one thread.
    const conversation = await conversations.createOrGetByParticipantPhone(phone, conversationTypeFor(contact));
```

3e. The welcome. Replace the four lines 381-384 - from the line that starts `    // (3) Welcome text` (non-ASCII dash) through `    if (!alreadyWelcomed) {` - with:
```ts
    // (3) Welcome text - ONLY when this request CREATED the contact (D5). An
    // existing contact never gets it, from either form, whatever
    // housing_fair_welcomed says (that rule texted landlords, caseworkers and
    // long-time tenants the tenant welcome mid-conversation). A new contact
    // whose welcome fails is not re-welcomed by a later sign-up.
    let welcomeSent = false;
    if (isNew) {
```
Then replace
```ts
        // Flag the contact so a later signup with the same phone is a no-op
        // for the welcome. Best-effort: a failure here only risks ONE possible
        // duplicate welcome on a later signup, never a crash.
```
with
```ts
        // D5: still recorded after a successful welcome. It no longer gates a
        // later welcome (no existing contact is ever welcomed); a failure here
        // lands in the catch below and costs only the flag.
```
(The audit and log lines below keep `isNew: existing === undefined` for now - still correct; Task 4.5 replaces them.)

3f. `app/test/helpers/twilioWebhookHarness.ts`
- HarnessOptions: replace
```ts
   * evaluation (POST /api/relay-groups/preview). Omit to use the wall clock.
   */
  relayGroupsNow?: () => string;
```
with
```ts
   * evaluation (POST /api/relay-groups/preview). Omit to use the wall clock.
   */
  relayGroupsNow?: () => string;
  /**
   * flyer-leads (plan 2.6, AR3): the injected clock (epoch ms) for
   * POST /public/housing-fair - the 24-hour repeat window, the pin and touch
   * instant and the flyer attempt key. Omit to use the wall clock.
   */
  publicNow?: () => number;
```
- The `public:` block: replace
```ts
        auditRepo: world.auditRepo,
        events: world.events,
      }),
    },
    webhooks: {
```
with
```ts
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      // flyer-leads D6/D7 (plan 2.6): the sign-up's thread pin and repeat
      // read, its flyer share entry and its unread-mark event go through the
      // SAME world fakes and bus the /api routers read.
      activityEventsRepo: world.activityEventsRepo,
      listingSendsRepo: world.listingSendsRepo,
      events: world.events,
      ...(opts.publicNow !== undefined && { now: opts.publicNow }),
    },
    webhooks: {
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts test/rateLimitClientKey.test.ts` -> all pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` -> exit 0.

### Step 5 - ASCII

New file: `app/test/publicSignupLeads.test.ts` -> `0`. Pre-existing: `app/src/routes/public.ts`, `app/test/publicIntake.test.ts`, `app/test/helpers/twilioWebhookHarness.ts` -> each `0`.

### Step 6 - commit

Paths: `app/src/routes/public.ts app/test/helpers/twilioWebhookHarness.ts app/test/publicSignupLeads.test.ts app/test/publicIntake.test.ts`

`-m` values, in order:
1. `feat(public): sign-up resolves deleted holders and welcomes new contacts only (flyer-leads D4, D5)`
2. `findByPhone stays the one lookup. A soft-deleted holder writes only its audit event; an existing contact is never changed or welcomed; a missing thread is typed for the contact. The router gains the activity, ledger, events and clock deps (plan 2.6, AR8), wired to the harness world with the publicNow seam.`
3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Task 4.3 - The pin, the 24-hour repeat check and the unread mark (D6)

Goal: every live contact's sign-up records a `signed_up` pin (labels plan 1.1) and marks its 1:1 thread unread (touch -> increment -> ONE `conversation.updated`), at most once per contact per source per 24 hours (existing contacts only read the window), every step best-effort with the plan 1.1 log line (spec D6.1-D6.4; plan 2.6 steps 7-8; AR3; contract issues 1, 2, 4, 5).

Files: `app/src/routes/public.ts`; `app/test/publicSignupLeads.test.ts`; `app/test/publicIntake.test.ts`.

### Step 1 - tests first

1a. `app/test/publicSignupLeads.test.ts`
- Replace `import type { ConversationType } from '../src/repos/conversationsRepo.js';` with
```ts
import { toConversationUpdatedEvent } from '../src/lib/events.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';
```
- Replace `import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';` with
```ts
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
```
- Replace `const signupAudits = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup');` with:
```ts
const signupAudits = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup');
const pins = (world: FakeWorld) => world.activityEvents.filter((e) => e.type === 'signed_up');
const convUpdates = (world: FakeWorld) =>
  world.emitted.filter((e) => e.event === 'conversation.updated').map((e) => e.payload as Record<string, unknown>);
const stepFailures = (capture: { lines: Record<string, unknown>[] }) =>
  capture.lines.filter((l) => l['msg'] === 'housing-fair signup step failed');
const captured = (capture: { lines: Record<string, unknown>[] }) =>
  capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');

/** Plan 1.1 labels for signupBody's name. */
const FLYER_LABEL = 'Signed up from the flyer for 12 Oak St, Atlanta, GA 30303 as Keisha Jones';
const A_FLYER_LABEL = 'Signed up from a flyer as Keisha Jones';
const JOIN_LABEL = 'Signed up on the join page as Keisha Jones';

/** The existing contact's open 1:1 thread, read and quiet. */
function seedThread(world: FakeWorld, over: Partial<ConversationItem> = {}): ConversationItem {
  const conv: ConversationItem = {
    conversationId: 'conv-1',
    participant_phone: PHONE,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    last_activity_at: '2026-10-01T10:00:00.000Z',
    last_message_preview: 'Is the place on Oak still open?',
    unread_count: 0,
    participants: [{ contactId: 'c-1', phone: PHONE }],
    created_at: '2026-10-01T10:00:00.000Z',
    ...over,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}
```
- Append at the end of the file:
```ts

describe('the signed_up pin and the unread mark (D6)', () => {
  it('an existing tenant on a flyer: no text, ONE pin with the flyer label and the unit ref, the thread touched then unread, ONE event with the new count', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: FLYER_LABEL, refType: 'unit', refId: 'unit-1', at: T0_ISO }),
    ]);
    // ONE touch at the sign-up instant with the preview untouched (the order is pinned by the next case).
    expect(world.touches).toEqual([{ conversationId: 'conv-1', previewText: undefined, ts: T0_ISO }]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.conversations.get('conv-1')).toMatchObject({
      status: 'open',
      last_activity_at: T0_ISO,
      last_message_preview: 'Is the place on Oak still open?',
      unread_count: 1,
      unread_flag: 'unread',
    });
    expect(convUpdates(world)).toEqual([
      expect.objectContaining({
        conversationId: 'conv-1',
        last_activity_at: T0_ISO,
        unread_count: 1,
        type: 'tenant_1to1',
        preview: 'Is the place on Oak still open?',
      }),
    ]);
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: true })]);
  });

  it('an existing contact on a CLOSED thread: touch (which reopens it) runs BEFORE the increment, and the ONE event is built from the touched image', async () => {
    // The harness fake reuses only OPEN threads while the real repo adopts a closed one (its phone claim), so the adoption is stubbed and the order pinned by spies.
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    const closed = seedThread(world, { status: 'closed' });
    vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockResolvedValue(closed);
    const touch = vi.spyOn(world.conversationsRepo, 'touchLastActivity');
    const increment = vi.spyOn(world.conversationsRepo, 'incrementUnread');

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(touch).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledTimes(1);
    expect(touch.mock.invocationCallOrder[0]).toBeLessThan(increment.mock.invocationCallOrder[0] ?? 0);
    const touched = (await touch.mock.results[0]?.value) as ConversationItem;
    expect(touched).toMatchObject({ conversationId: 'conv-1', status: 'open', last_activity_at: T0_ISO });
    expect(world.conversations.get('conv-1')).toMatchObject({ status: 'open', unread_count: 1 });
    expect(convUpdates(world)).toEqual([{ ...toConversationUpdatedEvent(touched), unread_count: 1 }]);
  });

  it('the flyer label falls back to the unitId when the property has no address, and carries the TRIMMED typed name', async () => {
    const { app, world } = harness();
    seedUnit(world, 'unit-bare', { address: undefined });
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-bare', firstName: '  Keisha ', lastName: ' Jones  ' }));

    expect(pins(world).map((p) => [p.label, p.refType, p.refId])).toEqual([
      ['Signed up from the flyer for unit-bare as Keisha Jones', 'unit', 'unit-bare'],
    ]);
  });

  it('/join: the join-page label and no ref', async () => {
    const { app, world } = harness();
    seedContact(world);

    await post(app, signupBody());

    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-1', label: JOIN_LABEL, at: T0_ISO })]);
    expect(pins(world)[0]).not.toHaveProperty('refType');
    expect(pins(world)[0]).not.toHaveProperty('refId');
  });

  it.each([
    ['a placed property', 'unit-placed'],
    ['a deleted property', 'unit-deleted'],
    ['a made-up unitId', 'no-such-unit'],
  ])('a flyer for %s: the "from a flyer" label and no ref', async (_what, unitId) => {
    const { app, world } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedUnit(world, 'unit-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' });
    seedContact(world);

    await post(app, signupBody({ unitId }));

    expect(pins(world)).toEqual([expect.objectContaining({ label: A_FLYER_LABEL })]);
    expect(pins(world)[0]).not.toHaveProperty('refId');
  });

  it('an existing landlord with no thread: a landlord_1to1 thread gets the pin and the unread mark, and no welcome', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect([...world.conversations.values()].map((c) => [c.type, c.unread_count])).toEqual([['landlord_1to1', 1]]);
    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-ll', label: FLYER_LABEL, refId: 'unit-1' })]);
    expect(world.sent).toHaveLength(0);
  });

  it('a NEW contact on a flyer: the welcome first, then the pin and the unread mark - and no repeat read', async () => {
    const { app, world } = harness();
    seedUnit(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');

    await post(app, signupBody({ unitId: 'unit-1' }));

    const contact = world.contacts.find((c) => c.phone === PHONE);
    expect(world.sent).toHaveLength(1);
    expect(since).not.toHaveBeenCalled();
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: contact?.contactId, label: FLYER_LABEL, refId: 'unit-1', at: T0_ISO }),
    ]);
    // The welcome's own touch carries its body; the mark's touch comes AFTER it and carries none.
    expect(world.touches.map((t) => t.previewText === undefined)).toEqual([false, true]);
    expect(world.touches.at(-1)?.ts).toBe(T0_ISO);
    const thread = [...world.conversations.values()][0];
    expect(thread).toMatchObject({ type: 'tenant_1to1', unread_count: 1 });
    expect(convUpdates(world).at(-1)).toMatchObject({ conversationId: thread?.conversationId, unread_count: 1 });
  });

  it('a NEW contact whose welcome is refused still gets the pin and the unread mark', async () => {
    const { app, world } = harness({ SMS_SENDING_ENABLED: 'false' });

    await post(app, signupBody());

    expect(world.sent).toHaveLength(0);
    expect(pins(world)).toEqual([expect.objectContaining({ label: JOIN_LABEL })]);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
  });

  it('the pin reaches the contact timeline with its label and its unit ref', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));
    const res = await request(app)
      .get('/api/contacts/c-1/timeline?kinds=milestone')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ kind: 'milestone', type: 'signed_up', at: T0_ISO, label: FLYER_LABEL, refType: 'unit', refId: 'unit-1' }),
    ]);
  });
});

describe('the repeat check: one pin and one bump per contact per source per 24 hours (D6.1)', () => {
  it('the SAME property: no second pin or bump within 24 hours; after 24 hours both again', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');

    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + 23 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(convUpdates(world)).toHaveLength(1);

    clock.ms = T0 + 25 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    // The window is the 24 hours before THIS sign-up, on this property's source.
    expect(since).toHaveBeenLastCalledWith('c-1', 'signed_up', new Date(T0 + HOUR_MS).toISOString(), 'unit-1');
    expect(pins(world).map((p) => p.at)).toEqual([T0_ISO, new Date(T0 + 25 * HOUR_MS).toISOString()]);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(2);
    expect(convUpdates(world)).toHaveLength(2);
  });

  it('a DIFFERENT property within 24 hours records its own pin and bump', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-1');
    seedUnit(world, 'unit-2', { address: { line1: '9 Pine Rd', city: 'Decatur', state: 'GA' } });
    seedContact(world);
    seedThread(world);

    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-2' }));

    expect(pins(world).map((p) => [p.refId, p.label])).toEqual([
      ['unit-1', FLYER_LABEL],
      ['unit-2', 'Signed up from the flyer for 9 Pine Rd, Decatur, GA as Keisha Jones'],
    ]);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(2);
  });

  it('/join twice within 24 hours: one pin and one bump', async () => {
    const { app, world, clock } = harness();
    seedContact(world);
    seedThread(world);

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody());

    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual(['conv-1']);
  });

  it('/join, then a flyer for an unavailable property within 24 hours: one pin (the shared no-property source)', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world);
    seedThread(world);

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-placed' }));

    expect(pins(world).map((p) => p.label)).toEqual([JOIN_LABEL]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
  });

  it('made-up unitIds all share the no-property source: one pin, read with no ref', async () => {
    const { app, world, clock } = harness();
    seedContact(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');

    await post(app, signupBody({ unitId: 'no-such-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'no-such-2' }));
    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody());

    expect(pins(world).map((p) => p.label)).toEqual([A_FLYER_LABEL]);
    expect(since.mock.calls.map((c) => c[3])).toEqual([undefined, undefined, undefined]);
  });
});

describe('the pin and the unread mark are best-effort (D6.4)', () => {
  function existingOnFlyer() {
    const h = harness();
    seedUnit(h.world);
    seedContact(h.world);
    seedThread(h.world);
    return h;
  }

  it('a failed repeat read fails OPEN: the pin and the unread mark are recorded; WARN step repeat_check', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.activityEventsRepo, 'hasEventSince').mockRejectedValue(new Error('activity read down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toHaveLength(1);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'repeat_check', level: 40 })]);
  });

  it('a failed pin still marks the thread unread with one event; ERROR step pin', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(convUpdates(world)).toHaveLength(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'pin', level: 50 })]);
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: false })]);
  });

  it('a failed touch: no increment and no event; ERROR step touch', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'touchLastActivity').mockRejectedValue(new Error('touch down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual([]);
    expect(convUpdates(world)).toEqual([]);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'touch', level: 50 })]);
  });

  it('a failed increment still emits ONE conversation.updated from the touched image; ERROR step increment', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockRejectedValue(new Error('increment down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(convUpdates(world)).toEqual([
      expect.objectContaining({ conversationId: 'conv-1', last_activity_at: T0_ISO, unread_count: 0 }),
    ]);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'increment', level: 50 })]);
  });

  it('the event carries the count incrementUnread RETURNS, not the touched image count', async () => {
    const { app, world } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockResolvedValue(7);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(convUpdates(world)).toEqual([expect.objectContaining({ conversationId: 'conv-1', unread_count: 7 })]);
  });
});
```

1b. `app/test/publicIntake.test.ts` - in `it('is idempotent on a repeat phone: ...`, replace
`    expect(world.contacts.length).toBe(contactCount); // no duplicate contact`
with
```ts
    expect(world.contacts.length).toBe(contactCount); // no duplicate contact
    // flyer-leads D6: the repeat falls inside the 24-hour window of the first
    // sign-up's pin (the same /join source), so it adds no second pin or bump.
    expect(world.activityEvents.filter((e) => e.type === 'signed_up')).toHaveLength(1);
    expect(world.unreadIncrements).toHaveLength(1);
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts`

Expected RED: every case in the three new describes fails, because each asserts at least one thing nothing writes yet - a `signed_up` pin (`pins(world)` is `[]`), a touch / increment / event (`world.touches`, `world.unreadIncrements`, `convUpdates` are empty), a `housing-fair signup step failed` line, or a timeline milestone (`items` is `[]`). publicIntake "is idempotent on a repeat phone" fails (`signed_up` pins: 0, expected 1). Task 4.2's cases stay green.

### Step 3 - implementation (`app/src/routes/public.ts`)

3a. Imports. Replace `import type { EventBus } from '../lib/events.js';` with
```ts
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { formatAddress } from '../lib/address.js';
```
Replace `import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';` with `import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';`.
Replace `import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';` with `import { createConversationsRepo, type ConversationItem, type ConversationsRepo } from '../repos/conversationsRepo.js';`.

3b. Module constants and the label. Replace `const MAX_UNIT_ID_LEN = 200;` with:
```ts
const MAX_UNIT_ID_LEN = 200;

/** flyer-leads D6.1: one pin and one inbox bump per contact per source per 24 hours. */
const SIGNUP_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** flyer-leads plan 1.1: the log line of every failed best-effort sign-up step (with { marker, step }). */
const SIGNUP_STEP_FAILED = 'housing-fair signup step failed';

/**
 * flyer-leads D6.2 (plan 1.1): the signed_up pin's words - inline staff copy,
 * the "Property sent" convention (the message catalog holds outbound sends
 * only). The name is the one TYPED on the form (trimmed by the app-wide body
 * trim and by the parser): the contact itself is never renamed, and an
 * auto-captured unknown contact has no other name. The address is
 * formatAddress, falling back to the unitId, as the tour-request label does.
 */
function signupPinLabel(args: {
  unitId: string | undefined;
  flyerUnit: UnitItem | undefined;
  viaFlyer: boolean;
  firstName: string;
  lastName: string;
}): string {
  const name = `${args.firstName} ${args.lastName}`;
  if (args.unitId === undefined) return `Signed up on the join page as ${name}`;
  if (!args.viaFlyer || args.flyerUnit === undefined) return `Signed up from a flyer as ${name}`;
  return `Signed up from the flyer for ${formatAddress(args.flyerUnit.address) || args.unitId} as ${name}`;
}
```

3c. Router locals and the unread mark. `  const router = Router();` occurs TWICE in the file (`:251` and `:494`), so the anchor is it plus the blank line and the comment line after it (all ASCII). Replace
```ts
  const router = Router();

  // The opaque 404 - IDENTICAL for missing, soft-deleted, and not-shareable (no
```
with:
```ts
  // flyer-leads D6 (plan 2.6): the sign-up's thread pin and its 24-hour repeat
  // read, the bus its unread mark emits on, and the injected clock (AR3) - the
  // ONE time source for the repeat window, the pin and touch instant and the
  // flyer attempt key.
  const activity = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const now = deps.now ?? (() => Date.now());

  /**
   * flyer-leads D6.3: bump the contact's 1:1 thread to the top of the inbox and
   * mark it unread. touchLastActivity FIRST (status open, last_activity_at =
   * the sign-up instant, preview untouched - the inbox preview stays the newest
   * MESSAGE), then incrementUnread, then ONE conversation.updated built from
   * the touched image with unread_count replaced by the count the increment
   * returned. A failed increment still emits from the touched image as it is,
   * so open dashboards re-sort the bumped row; a failed touch means no
   * increment and no event, so a closed thread is never left flagged unread
   * but invisible. Best-effort: each failure is logged (marker + step, no PII)
   * and never reaches the public answer.
   */
  async function markSignupUnread(conversationId: string, atIso: string, marker: string): Promise<void> {
    let touched: ConversationItem;
    try {
      touched = await conversations.touchLastActivity(conversationId, undefined, atIso);
    } catch (err) {
      log.error({ marker, step: 'touch', err }, SIGNUP_STEP_FAILED);
      return;
    }
    let count: number | undefined;
    try {
      count = await conversations.incrementUnread(conversationId);
    } catch (err) {
      log.error({ marker, step: 'increment', err }, SIGNUP_STEP_FAILED);
    }
    const event = toConversationUpdatedEvent(touched);
    events.emit('conversation.updated', count === undefined ? event : { ...event, unread_count: count });
  }

  const router = Router();

  // The opaque 404 - IDENTICAL for missing, soft-deleted, and not-shareable (no
```

3d. Keep the flyer unit for the label. Replace
```ts
    let viaFlyer = false;
    if (unitId !== undefined) {
      const flyerUnit = await units.getById(unitId);
```
with
```ts
    let viaFlyer = false;
    // flyer-leads D6.2: the unit is kept for the sign-up pin's address label.
    let flyerUnit: UnitItem | undefined;
    if (unitId !== undefined) {
      flyerUnit = await units.getById(unitId);
```

3e. The repeat check, the pin and the mark. The Edit `old_string` is the ASCII prefix `    // (4) Audit (no PII in the payload beyond the marker` of line ~413 (the rest of that line is untouched); `new_string` is the block below followed by the same prefix:
```ts
    // (3a) One clock reading (AR3), taken AFTER the welcome so the unread
    // mark's touch follows the welcome in the thread. Then the repeat check
    // (D6.1): one pin and one inbox bump per contact per SOURCE per 24 hours.
    // The source is the shareable flyer's unit (the pin's unitId ref), or the
    // ONE shared "no property" source (/join, and a flyer whose unit is
    // missing, deleted, unavailable or made up - no ref), so made-up unitIds
    // cannot multiply pins. A brand-new contact has no earlier pin and skips
    // the read. A failed read FAILS OPEN: the pin and the bump are recorded.
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const sourceRefId = viaFlyer ? unitId : undefined;
    let isRepeat = false;
    if (!isNew) {
      try {
        isRepeat = await activity.hasEventSince(
          contactId,
          'signed_up',
          new Date(nowMs - SIGNUP_REPEAT_WINDOW_MS).toISOString(),
          sourceRefId,
        );
      } catch (err) {
        log.warn({ marker, step: 'repeat_check', err }, SIGNUP_STEP_FAILED);
      }
    }

    // (3b) The pin and the unread mark (D6.2, D6.3), for every live contact -
    // a new one too, AFTER its welcome, so its new thread ends with the
    // welcome as the newest message and is unread and on top. Both skipped on
    // a repeat. Each is best-effort, and a failed pin still marks the thread.
    let recorded = false;
    if (!isRepeat) {
      try {
        await activity.record({
          contactId,
          type: 'signed_up',
          label: signupPinLabel({ unitId, flyerUnit, viaFlyer, firstName, lastName }),
          ...(sourceRefId !== undefined && { refType: 'unit' as const, refId: sourceRefId }),
          at: nowIso,
        });
        recorded = true;
      } catch (err) {
        log.error({ marker, step: 'pin', err }, SIGNUP_STEP_FAILED);
      }
      await markSignupUnread(conversation.conversationId, nowIso, marker);
    }

    // (4) Audit (no PII in the payload beyond the marker
```

3f. The log line carries `recorded`. Replace (the normal path's block, 8/6/6-space indentation - the deleted path's log is a one-line object and does not match)
```ts
        withAuthority: housingAuthority !== undefined,
      },
      'housing-fair signup captured',
```
with
```ts
        withAuthority: housingAuthority !== undefined,
        recorded,
      },
      'housing-fair signup captured',
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts test/rateLimitClientKey.test.ts` -> all pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` -> exit 0.

### Step 5 - ASCII

Pre-existing-file check on `app/src/routes/public.ts`, `app/test/publicSignupLeads.test.ts`, `app/test/publicIntake.test.ts` -> each `0`.

### Step 6 - commit

Paths: `app/src/routes/public.ts app/test/publicSignupLeads.test.ts app/test/publicIntake.test.ts`

`-m` values, in order:
1. `feat(public): sign-up pin, 24-hour repeat check and unread mark (flyer-leads D6)`
2. `Every live contact's sign-up records a signed_up pin in its thread and marks its 1:1 conversation unread (touch, then increment, then one conversation.updated with the new count), at most once per contact per source per 24 hours. Each step is best-effort and logs its step without PII; a failed pin still marks. One clock reading after the welcome drives the window, the pin, the touch and the attempt key (AR8).`
3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Task 4.4 - The flyer share entry call site (D7)

Goal: a flyer sign-up for a shareable unit by a `tenant` or `unknown` contact (new or existing, sent before or not) calls `applyFlyerShareEntry` with `signedUpAt = nowIso` on EVERY sign-up it applies to (the 24-hour cap governs the pin and bump only); a throw is `'error'` with the step `ledger` log (spec D7; plan 2.6 step 9).

Files: `app/src/routes/public.ts`; `app/test/publicSignupLeads.test.ts`.

### Step 1 - tests first

`app/test/publicSignupLeads.test.ts`
- Replace `import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';` with
```ts
import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
```
- Replace `const JOIN_LABEL = 'Signed up on the join page as Keisha Jones';` with:
```ts
const JOIN_LABEL = 'Signed up on the join page as Keisha Jones';

/** An earlier counted send of unit-1 to c-1. */
const SENT_AT = '2026-10-01T10:00:00.000Z';
/** Plan 2.2: the flyer entry a sign-up at `iso` writes. */
const flyerEntry = (iso: string) => ({ attempt: `${iso}#flyer`, state: 'counted', by: 'acceptance', countedAt: iso });
const ledgerRow = (world: FakeWorld, unitId = 'unit-1', contactId = 'c-1') =>
  world.listingSendsRepo.getByKeyConsistent(unitId, contactId);

/** The pair's outcome on the contact page's Properties sent read (S3 derives signed_up). */
async function outcomeOf(app: App, contactId = 'c-1', unitId = 'unit-1'): Promise<string | undefined> {
  const res = await request(app)
    .get(`/api/contacts/${contactId}/listings-sent`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
  expect(res.status).toBe(200);
  return (res.body.sent as Array<{ unitId: string; outcome: string }>).find((r) => r.unitId === unitId)?.outcome;
}
```
- Append at the end of the file:
```ts

describe('a flyer sign-up puts the property on the properties-sent list (D7)', () => {
  it('an existing tenant never sent the property: ONE counted flyer entry at the sign-up instant, and the pair reads signed_up', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect(row).toMatchObject({ counted: true, sentAt: T0_ISO });
    expect(row?.broadcastId).toBeUndefined();
    expect(await outcomeOf(app)).toBe('signed_up');
    // No "Property sent" milestone for it: the signed_up pin names the flyer.
    expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: true })]);
    expect(captured(capture)[0]).not.toHaveProperty('sentSkipped');
  });

  const ALREADY_SENT: Array<[string, Partial<ContactItem>, string]> = [
    ['no reply', {}, 'no_reply'],
    ['a reply', { last_heard_from_at: '2026-10-02T10:00:00.000Z' }, 'replied'],
  ];

  it.each(ALREADY_SENT)('a pair already sent, with %s, reads signed_up after the sign-up', async (_what, contactOver, before) => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, contactOver);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    expect(await outcomeOf(app)).toBe(before);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO));
    expect(row?.sentAt).toBe(T0_ISO);
    expect(await outcomeOf(app)).toBe('signed_up');
  });

  it('a CURRENT decline holds: no flyer entry, still not_interested - and the pin and the unread mark are still recorded', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    expect(await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-10-05T10:00:00.000Z', by: 'staff', staffId: 'usr-1' })).toBe('ok');

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toBeUndefined();
    expect(row?.sentAt).toBe(SENT_AT);
    expect(await outcomeOf(app)).toBe('not_interested');
    expect(pins(world)).toHaveLength(1);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(capture.lines.some((l) => l['msg'] === 'share ledger: flyer entry not written - the pair holds a current decline')).toBe(true);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'declined' })]);
  });

  it('a decline recorded AFTER a sign-up holds against a second sign-up', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    expect(await outcomeOf(app)).toBe('signed_up');
    expect(
      await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: new Date(T0 + HOUR_MS).toISOString(), by: 'staff', staffId: 'usr-1' }),
    ).toBe('ok');

    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO)); // the FIRST sign-up's entry, never a newer one
    expect(row?.sentAt).toBe(T0_ISO);
    expect(await outcomeOf(app)).toBe('not_interested');
  });

  it('a pair with a tour stays interested', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await world.toursRepo.create({
      tourId: 't-1',
      tenantId: 'c-1',
      unitId: 'unit-1',
      tourType: 'self_guided',
      status: 'scheduled',
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    expect(await outcomeOf(app)).toBe('interested');

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect((await ledgerRow(world))?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO));
    expect(await outcomeOf(app)).toBe('interested');
  });

  it('a repeat inside the 24-hour cap still writes a NEWER flyer entry: the cap governs the pin and the bump only', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    const later = new Date(T0 + HOUR_MS).toISOString();
    expect(pins(world)).toHaveLength(1);
    expect((await ledgerRow(world))?.shares?.['flyer']).toEqual(flyerEntry(later));
    expect((await ledgerRow(world))?.sentAt).toBe(later);
  });

  it('a DIFFERENT property within 24 hours gets its own flyer entry', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-1');
    seedUnit(world, 'unit-2');
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-2' }));

    expect((await ledgerRow(world, 'unit-1'))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect((await ledgerRow(world, 'unit-2'))?.shares).toEqual({ flyer: flyerEntry(new Date(T0 + HOUR_MS).toISOString()) });
  });

  it('an existing unknown contact gets the entry, and the property Sent to read lists it', async () => {
    const { app, world } = harness();
    seedUnit(world);
    world.contacts.push({ contactId: 'c-u', type: 'unknown', status: 'needs_review', phone: PHONE } as ContactItem);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect((await ledgerRow(world, 'unit-1', 'c-u'))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect((await world.listingSendsRepo.listByUnit('unit-1')).map((r) => r.contactId)).toEqual(['c-u']);
  });

  const NON_TENANTS: ContactType[] = ['landlord', 'partner'];

  it.each(NON_TENANTS)('an existing %s gets the pin and the unread mark but no entry', async (type) => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, { type });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(world.listingSends).toHaveLength(0);
    expect(pins(world)).toHaveLength(1);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'not_tenant' })]);
  });

  it('/join, an unavailable property and a made-up unitId never touch the ledger', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world);
    const read = vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent');
    const write = vi.spyOn(world.listingSendsRepo, 'putShareMemory');

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-placed' }));
    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody({ unitId: 'no-such-unit' }));

    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(world.listingSends).toHaveLength(0);
  });

  it('a NEW contact on a flyer: the welcome, the pin, the unread mark and the flyer entry', async () => {
    const { app, world } = harness();
    seedUnit(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const contact = world.contacts.find((c) => c.phone === PHONE);
    expect(world.sent).toHaveLength(1);
    expect(pins(world)).toHaveLength(1);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
    expect((await ledgerRow(world, 'unit-1', contact?.contactId ?? ''))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
  });

  it('a failed ledger write still answers { ok: true }: no entry, the pin kept, ERROR step ledger', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.listingSends).toHaveLength(0);
    expect(pins(world)).toHaveLength(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'ledger', level: 50 })]);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'error' })]);
  });
});
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts`

Expected RED: the D7 cases that expect an entry fail (`ledgerRow` is `undefined` or has no `flyer` key; `outcomeOf` is `undefined` / `no_reply` / `replied`); the decline / non-tenant / ledger-failure cases fail on their `captured(...)` log assertion (no `sentRecorded` / `sentSkipped` field yet) and the failure case on its missing `ledger` step line. The "never touch the ledger" case passes already (PIN). Tasks 4.2-4.3 stay green.

### Step 3 - implementation (`app/src/routes/public.ts`)

3a. Imports. Replace `import type { ListingSendsRepo } from '../repos/listingSendsRepo.js';` with `import { createListingSendsRepo, type ListingSendsRepo } from '../repos/listingSendsRepo.js';`. At the end of the import block, replace
```ts
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';
```
with
```ts
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';
import { applyFlyerShareEntry, type FlyerShareResult } from '../services/shareLedger.js';
```

3b. The skip reason type. Replace `const SIGNUP_STEP_FAILED = 'housing-fair signup step failed';` with:
```ts
const SIGNUP_STEP_FAILED = 'housing-fair signup step failed';

/**
 * flyer-leads D6 / AR2 / AR11: why a sign-up wrote no flyer entry (the
 * audit's sentSkipped, absent ONLY when an entry was written): a soft-deleted
 * holder (the deleted path); no unitId; a unitId that is not a shareable
 * unit; a contact type the sent list is not for; the ledger's own refusals (a
 * current decline, the order rule, token retries exhausted); or a throw.
 */
type SignupSentSkipped =
  | 'deleted'
  | 'not_flyer'
  | 'not_shareable'
  | 'not_tenant'
  | Exclude<FlyerShareResult, 'written'>
  | 'error';
```

3c. The ledger dep. Replace `  const now = deps.now ?? (() => Date.now());` with:
```ts
  const now = deps.now ?? (() => Date.now());
  // flyer-leads D7: the ledger a flyer sign-up's share entry goes through.
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
```

3d. The entry. Same Edit technique as Task 4.3 3e: `old_string` = the ASCII prefix `    // (4) Audit (no PII in the payload beyond the marker`, `new_string` = the block below followed by that prefix:
```ts
    // (3c) The flyer share entry (D7): a flyer of a shareable unit puts that
    // property on a tenant's or an unknown contact's properties-sent list -
    // new or existing, sent before or not - through the share ledger
    // (applyFlyerShareEntry: key 'flyer', counted by acceptance at the sign-up
    // instant), unless the pair holds a CURRENT decline, decided inside the
    // ledger's conditional write (a sign-up never clears a decline). Written
    // on EVERY sign-up it applies to: the 24-hour cap governs the pin and the
    // bump only. Landlords, partners and other types get the pin and the bump
    // but no entry (the list records homes offered to someone looking for
    // one). Best-effort: a throw is logged (step ledger) and recorded as
    // 'error'; the ledger logs its own decline (INFO) and lost (ERROR) lines.
    let sentRecorded = false;
    let sentSkipped: SignupSentSkipped | undefined;
    if (unitId === undefined) {
      sentSkipped = 'not_flyer';
    } else if (!viaFlyer) {
      sentSkipped = 'not_shareable';
    } else if (contact.type !== 'tenant' && contact.type !== 'unknown') {
      sentSkipped = 'not_tenant';
    } else {
      try {
        const result = await applyFlyerShareEntry({ listingSends, log }, { unitId, contactId, signedUpAt: nowIso });
        if (result === 'written') sentRecorded = true;
        else sentSkipped = result;
      } catch (err) {
        sentSkipped = 'error';
        log.error({ marker, step: 'ledger', err }, SIGNUP_STEP_FAILED);
      }
    }

    // (4) Audit (no PII in the payload beyond the marker
```

3e. The log line. Replace
```ts
        withAuthority: housingAuthority !== undefined,
        recorded,
      },
```
with
```ts
        withAuthority: housingAuthority !== undefined,
        recorded,
        sentRecorded,
        ...(sentSkipped !== undefined && { sentSkipped }),
      },
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts test/rateLimitClientKey.test.ts` -> all pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` -> exit 0.

### Step 5 - ASCII

Pre-existing-file check on `app/src/routes/public.ts`, `app/test/publicSignupLeads.test.ts` -> each `0`.

### Step 6 - commit

Paths: `app/src/routes/public.ts app/test/publicSignupLeads.test.ts`

`-m` values, in order:
1. `feat(public): flyer sign-up writes the flyer share entry (flyer-leads D7)`
2. `A flyer sign-up for a shareable unit by a tenant or unknown contact puts the property on the contact's properties-sent list through applyFlyerShareEntry, on every sign-up (the 24-hour cap governs the pin only). A current decline holds; landlords and partners get no entry; a ledger failure is logged and never reaches the public answer.`
3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Task 4.5 - The audit fields, the route comment, the backfill pin and the PII test

Goal: the `housing_fair_signup` audit gains `existingContact`, `deletedContact`, `recorded`, `sentRecorded`, `sentSkipped` (incl. AR2 `refused`, and AR11 `deleted` on the deleted path - so `sentSkipped` is absent ONLY when an entry was written) and `consentVersion` (spec D6, plan 2.6), the log line mirrors them, the route comment describes D4-D7, the backfill reader is pinned, and the never-log-PII test covers every new step.

Files: `app/src/routes/public.ts`; `app/test/publicSignupLeads.test.ts`; `app/test/publicIntake.test.ts`; `app/test/backfillJoinHousingAuthority.test.ts`.

### Step 1 - tests first

1a. `app/test/publicSignupLeads.test.ts`
- Replace `import { seedListingSend } from './helpers/listingSendSeed.js';` with `import { seedFlyerSignUp, seedListingSend } from './helpers/listingSendSeed.js';` (S3 adds `seedFlyerSignUp`).
- Append at the end of the file:
```ts

describe('the housing_fair_signup audit fields (D6, plan 2.6)', () => {
  type Harness = ReturnType<typeof harness>;

  it('an existing tenant on a flyer, entry written: the full payload (no sentSkipped) and the matching log fields', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world)).toEqual([
      {
        entityKey: 'contacts#c-1',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: true,
          signupVersion: 2,
          housingAuthority: null,
          existingContact: true,
          deletedContact: false,
          recorded: true,
          sentRecorded: true,
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);
    expect(captured(capture)).toEqual([
      expect.objectContaining({ isNew: false, viaFlyer: true, existingContact: true, deletedContact: false, recorded: true, sentRecorded: true }),
    ]);
  });

  it('a soft-deleted holder (AR11): the event lands on THAT contact with deletedContact true, recorded and sentRecorded false, sentSkipped deleted', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-del', deleted_at: '2026-10-01T00:00:00.000Z' });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world)).toEqual([
      {
        entityKey: 'contacts#c-del',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: true,
          signupVersion: 2,
          housingAuthority: null,
          existingContact: false,
          deletedContact: true,
          recorded: false,
          sentRecorded: false,
          sentSkipped: 'deleted',
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);
    expect(captured(capture)).toEqual([
      expect.objectContaining({ existingContact: false, deletedContact: true, recorded: false, sentRecorded: false, sentSkipped: 'deleted' }),
    ]);
  });

  const SKIP_CASES: Array<{ skipped: string; arrange: (h: Harness) => Promise<Record<string, unknown>> }> = [
    {
      skipped: 'not_flyer',
      arrange: async (h) => {
        seedContact(h.world);
        return signupBody();
      },
    },
    {
      skipped: 'not_shareable',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world, 'unit-placed', { status: 'placed' });
        return signupBody({ unitId: 'unit-placed' });
      },
    },
    {
      skipped: 'not_tenant',
      arrange: async (h) => {
        seedContact(h.world, { type: 'landlord' });
        seedUnit(h.world);
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'declined',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        await seedListingSend(h.world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
        await h.world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-10-05T10:00:00.000Z', by: 'staff', staffId: 'usr-1' });
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      // AR2: a NEWER flyer entry is already stored (two sign-ups inside two app
      // instances' clock skew), so the order rule keeps it.
      skipped: 'refused',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        await seedFlyerSignUp(h.world.listingSendsRepo, {
          unitId: 'unit-1',
          contactId: 'c-1',
          signedUpAt: new Date(T0 + HOUR_MS).toISOString(),
        });
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'lost',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        vi.spyOn(h.world.listingSendsRepo, 'putShareMemory').mockResolvedValue(false);
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'error',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        vi.spyOn(h.world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));
        return signupBody({ unitId: 'unit-1' });
      },
    },
  ];

  it.each(SKIP_CASES)('sentSkipped $skipped: sentRecorded false, and the pin still recorded', async ({ skipped, arrange }) => {
    const h = harness();
    const body = await arrange(h);

    const res = await post(h.app, body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(signupAudits(h.world).map((e) => e.payload)).toEqual([
      expect.objectContaining({ existingContact: true, deletedContact: false, recorded: true, sentRecorded: false, sentSkipped: skipped }),
    ]);
  });

  it('a decline recorded AFTER a sign-up: the second sign-up audits sentSkipped declined', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: new Date(T0 + HOUR_MS).toISOString(), by: 'staff', staffId: 'usr-1' });
    clock.ms = T0 + 2 * HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world).map((e) => [e.payload?.['sentRecorded'], e.payload?.['sentSkipped']])).toEqual([
      [true, undefined],
      [false, 'declined'],
    ]);
  });

  it('recorded is false on a repeat inside the 24-hour cap and when the pin write fails; the flyer entry is still recorded', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));
    clock.ms = T0 + 25 * HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world).map((e) => [e.payload?.['recorded'], e.payload?.['sentRecorded']])).toEqual([
      [true, true],
      [false, true],
      [false, true],
    ]);
  });
});
```

1b. `app/test/publicIntake.test.ts` - the four exact audit payloads (all anchors ASCII):
- In `it('a new /join contact with an authority: ...` replace
```ts
          isNew: true,
          welcomeSent: true,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
        },
```
with
```ts
          isNew: true,
          welcomeSent: true,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
          // flyer-leads D6: a new /join contact - its pin written, no flyer entry.
          existingContact: false,
          deletedContact: false,
          recorded: true,
          sentRecorded: false,
          sentSkipped: 'not_flyer',
          consentVersion: 'ctia-2026-06',
        },
```
- In `it('no authority (absent or null): ...` replace the whole
```ts
    expect(payloads).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
      },
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
      },
    ]);
```
with
```ts
    // flyer-leads D6: two new /join contacts - each pin written, no flyer entry.
    const joinFields = {
      existingContact: false,
      deletedContact: false,
      recorded: true,
      sentRecorded: false,
      sentSkipped: 'not_flyer',
      consentVersion: 'ctia-2026-06',
    };
    expect(payloads).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
        ...joinFields,
      },
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
        ...joinFields,
      },
    ]);
```
- In `it('a flyer sign-up: viaFlyer true, signupVersion 2, housingAuthority null', ...` replace
```ts
        viaFlyer: true,
        signupVersion: 2,
        housingAuthority: null,
      },
```
with
```ts
        viaFlyer: true,
        signupVersion: 2,
        housingAuthority: null,
        // flyer-leads D6/D7: a new tenant on a shareable flyer - pin and flyer entry written.
        existingContact: false,
        deletedContact: false,
        recorded: true,
        sentRecorded: true,
        consentVersion: 'ctia-2026-06',
      },
```
- In `it('an existing phone: the audit records the answer it was sent, ...` replace
```ts
          isNew: false,
          welcomeSent: false,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
        },
```
with
```ts
          isNew: false,
          welcomeSent: false,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
          // flyer-leads D6: an existing contact - never welcomed, its pin written, no flyer entry.
          existingContact: true,
          deletedContact: false,
          recorded: true,
          sentRecorded: false,
          sentSkipped: 'not_flyer',
          consentVersion: 'ctia-2026-06',
        },
```
- The PII test: replace
```ts
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair signup captured')).toBe(true);
  });
```
(the end of `it('NEVER logs PII: no log line contains the phone or the name', ...`) with:
```ts
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair signup captured')).toBe(true);
  });

  it('(PIN) NEVER logs PII on the existing-contact path either: the pin, the unread mark, the ledger and every failed step', async () => {
    const { app, world, capture } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    world.units.set('unit-pii', {
      unitId: 'unit-pii',
      landlordId: 'll-1',
      status: 'available',
      address: { line1: '77 Unique Ave', city: 'Atlanta', state: 'GA' },
    });
    world.contacts.push({
      contactId: 'c-pii',
      type: 'tenant',
      status: 'searching',
      phone: '+15550103334',
      firstName: 'Stored1st',
      lastName: 'Stored2nd',
    } as ContactItem);
    const body = { firstName: 'Unique1stName', lastName: 'Unique2ndName', phone: '+15550103334', smsConsent: true, unitId: 'unit-pii' };
    const send = () => request(app).post(FAIR).set('x-origin-verify', SECRET).send(body);

    // A clean pass: the pin, the mark and the flyer entry are all written.
    expect((await send()).status).toBe(200);
    // Then every best-effort step fails, across two passes (a failed touch skips the increment).
    vi.spyOn(world.activityEventsRepo, 'hasEventSince').mockRejectedValue(new Error('repeat read down'));
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockRejectedValue(new Error('increment down'));
    vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));
    expect((await send()).status).toBe(200);
    vi.spyOn(world.conversationsRepo, 'touchLastActivity').mockRejectedValue(new Error('touch down'));
    expect((await send()).status).toBe(200);

    const steps = capture.lines.filter((l) => l['msg'] === 'housing-fair signup step failed').map((l) => l['step']);
    expect(new Set(steps)).toEqual(new Set(['repeat_check', 'pin', 'touch', 'increment', 'ledger']));
    const serialized = JSON.stringify(capture.lines);
    for (const pii of ['Unique1stName', 'Unique2ndName', 'Stored1st', 'Stored2nd', '+15550103334', '5550103334', 'Signed up from', '77 Unique Ave']) {
      expect(serialized, pii).not.toContain(pii);
    }
  });
```

1c. `app/test/backfillJoinHousingAuthority.test.ts` - replace
```ts
    expect(leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, signupVersion: '2' })])).toBeNull();
  });
```
with
```ts
    expect(leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, signupVersion: '2' })])).toBeNull();
  });

  it('(PIN) flyer-leads D6: a sign-up event carrying the new audit fields still leaves the lead out', () => {
    const flyerLeadsPayload = {
      ...RESIGNUP_PAYLOAD,
      existingContact: true,
      deletedContact: false,
      recorded: true,
      sentRecorded: false,
      sentSkipped: 'not_flyer',
      consentVersion: 'ctia-2026-06',
    };
    expect(leftOutReasonFromAudit([event('housing_fair_signup', flyerLeadsPayload)])).toBe('signed_up_again');
    // The deleted path's event too (it is on the deleted contact's entity; AR11).
    expect(
      leftOutReasonFromAudit([
        event('housing_fair_signup', {
          ...flyerLeadsPayload,
          existingContact: false,
          deletedContact: true,
          recorded: false,
          sentSkipped: 'deleted',
        }),
      ]),
    ).toBe('signed_up_again');
  });
```

### Step 2 - run RED

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts test/backfillJoinHousingAuthority.test.ts`

Expected RED: the new audit describe (every case: the payload has no `existingContact` / `deletedContact` / `recorded` / `sentRecorded` / `sentSkipped` / `consentVersion`; the log lines lack `existingContact` / `deletedContact`); the four updated publicIntake payload `toEqual`s (missing keys). The backfill `(PIN)` and the publicIntake PII `(PIN)` pass already; every other case stays green.

### Step 3 - implementation (`app/src/routes/public.ts`)

3a. The route doc. Replace the comment lines 13-24 - from `//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId?, housingAuthority? }` through `//          an existing contact is never changed beyond the welcome flag.)` (line 14 carries a non-ASCII arrow; copy it from the file) - with:
```ts
//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId?, housingAuthority? }
//        -> 200 { ok: true }   (leaks NO internal IDs/PII). The phone is looked
//          up with contacts.findByPhone - the ONE routing read (flyer-leads D4):
//          - no holder: a NEW tenant contact is created and gets the welcome
//            text (the only sign-up that does, D5). A present + shareable
//            unitId stamps capture_source:'flyer' + unit_of_interest instead of
//            'housing_fair'. A request with NO unitId starts 'onboarding' and
//            holds the housing authority; WITH a unitId it starts
//            'needs_review'. Every new contact carries housing_fair_signup_v2.
//          - a live holder (any type): an EXISTING contact - never changed and
//            never welcomed.
//          - a soft-deleted holder: no conversation, send, pin, unread mark or
//            sent-list entry; only the housing_fair_signup audit, on it
//            (sentSkipped 'deleted').
//          Every live contact (new or existing) then gets, best-effort (D6): a
//          'signed_up' pin in its thread and an unread mark on its 1:1
//          conversation (touch -> incrementUnread -> ONE conversation.updated),
//          at most once per contact per source (a shareable flyer's unit, or
//          the one "no property" source) per 24 hours; and, for a flyer of a
//          shareable unit and a tenant or unknown contact, a 'flyer' entry on
//          the properties-sent ledger unless the pair holds a current decline
//          (D7). A failed step is logged without PII and the answer is still
//          { ok: true }. join-housing-authority: housingAuthority (absent/null
//          = none) must be the exact name of a listed housing authority, else
//          400 housing_authority_not_listed; sent WITH a unitId it is the
//          generic 400.)
```

3b. The deleted path's audit and log. Replace (inside `if (existing !== undefined && isContactDeleted(existing)) {`)
```ts
      await audit.append(`contacts#${existing.contactId}`, 'housing_fair_signup', {
        marker,
        isNew: false,
        welcomeSent: false,
        viaFlyer,
        signupVersion: 2,
        housingAuthority: housingAuthority ?? null,
      });
      log.info(
        { marker, isNew: false, welcomeSent: false, viaFlyer, withAuthority: housingAuthority !== undefined },
        'housing-fair signup captured',
      );
```
with
```ts
      await audit.append(`contacts#${existing.contactId}`, 'housing_fair_signup', {
        marker,
        isNew: false,
        welcomeSent: false,
        viaFlyer,
        signupVersion: 2,
        housingAuthority: housingAuthority ?? null,
        existingContact: false,
        deletedContact: true,
        recorded: false,
        sentRecorded: false,
        // AR11: sentSkipped is absent ONLY when an entry was written.
        sentSkipped: 'deleted' satisfies SignupSentSkipped,
        consentVersion: CONSENT_VERSION,
      });
      log.info(
        {
          marker,
          isNew: false,
          welcomeSent: false,
          viaFlyer,
          withAuthority: housingAuthority !== undefined,
          existingContact: false,
          deletedContact: true,
          recorded: false,
          sentRecorded: false,
          sentSkipped: 'deleted' satisfies SignupSentSkipped,
        },
        'housing-fair signup captured',
      );
```
(`satisfies` - TypeScript 5.9.3 here, already used at `jobs/broadcastFanOut.ts:1177` - ties the literal to the union Task 4.4 declared, so the two cannot drift.)

3c. The normal path's audit, log and response. Replace the region from the line that starts `    // (4) Audit (no PII in the payload beyond the marker` (non-ASCII further along that line) through the 4-space `    res.json({ ok: true });` that ends the handler (the region includes the non-ASCII lines `    // Log a hashed marker only` and `    // (5) Minimal response`; copy them from the file) with:
```ts
    // (4) Audit (no PII in the payload beyond the marker - the contactId is an
    // internal id, fine for the audit trail but NOT returned to the public).
    // join-housing-authority D7: every event carries signupVersion 2 (the lead
    // backfill reads it - scripts/backfill-join-housing-authority.ts) and the
    // authority the REQUEST carried, else null. flyer-leads D6 adds, still with
    // no PII: existingContact (a live holder), deletedContact (false here - the
    // deleted path writes its own event above), recorded (the pin was written),
    // sentRecorded (the flyer entry was written), sentSkipped (why no entry was
    // written: not_flyer, not_shareable, not_tenant, declined, refused, lost or
    // error - and deleted on the deleted path, AR11; absent ONLY when one was)
    // and consentVersion (the consent disclosure version in force -
    // CONSENT_VERSION, smsCompliance.ts:91 - which ships with the form;
    // evidence only, never stamped on an existing contact).
    await audit.append(`contacts#${contactId}`, 'housing_fair_signup', {
      marker,
      isNew,
      welcomeSent,
      viaFlyer,
      signupVersion: 2,
      housingAuthority: housingAuthority ?? null,
      existingContact: !isNew,
      deletedContact: false,
      recorded,
      sentRecorded,
      ...(sentSkipped !== undefined && { sentSkipped }),
      consentVersion: CONSENT_VERSION,
    });
    // Log a hashed marker only - NEVER the name or phone (doc section 9). Every
    // other field is a non-PII boolean or enum; withAuthority (D7) stands in
    // for the authority's name.
    log.info(
      {
        marker,
        isNew,
        welcomeSent,
        viaFlyer,
        withAuthority: housingAuthority !== undefined,
        existingContact: !isNew,
        deletedContact: false,
        recorded,
        sentRecorded,
        ...(sentSkipped !== undefined && { sentSkipped }),
      },
      'housing-fair signup captured',
    );

    // (5) Minimal response - do NOT leak internal IDs or PII to the public.
    res.json({ ok: true });
```

### Step 4 - run GREEN

`cd "W:/tmp/flyer-leads/app" && npx vitest run test/publicSignupLeads.test.ts test/publicIntake.test.ts test/backfillJoinHousingAuthority.test.ts test/rateLimitClientKey.test.ts` -> all pass. Then `cd "W:/tmp/flyer-leads/app" && npm run typecheck` -> exit 0.

### Step 5 - ASCII

Pre-existing-file check on `app/src/routes/public.ts`, `app/test/publicSignupLeads.test.ts`, `app/test/publicIntake.test.ts`, `app/test/backfillJoinHousingAuthority.test.ts` -> each `0`.

### Step 6 - commit

Paths: `app/src/routes/public.ts app/test/publicSignupLeads.test.ts app/test/publicIntake.test.ts app/test/backfillJoinHousingAuthority.test.ts`

`-m` values, in order:
1. `feat(public): housing_fair_signup audit fields and route notes (flyer-leads D6)`
2. `The sign-up audit gains existingContact, deletedContact, recorded, sentRecorded, sentSkipped (including refused, AR2, and deleted for a soft-deleted holder, AR11) and consentVersion, with no PII; the log line mirrors them. The route comment describes D4-D7, the lead backfill's reader is pinned, and the never-log-PII test covers every new step.`
3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## S4 exit check (commits ONLY the slice report)

1. The FULL app suite (AR15 - S4 edits the shared harness fakes), the S6 Task 6.5 pattern. Git Bash (the Bash tool), each command bare - never piped, never `;`-chained.
   a. AWS-credential check FIRST (a diagnostic, not a gate): `env | grep '^AWS_'`. If any `AWS_ACCESS_KEY_ID` prints, step b runs under `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY` (AGENTS.md: an exported key collapses every app test file onto one DynamoDB Local database).
   b. Run it in the BACKGROUND (Bash tool `run_in_background: true` - the tool's 120 s foreground default would kill it), with a hard outer timeout and the output REDIRECTED (a redirect is not a pipe) to a log under the gitignored `.superpowers/sdd/`:
      `mkdir -p "W:/tmp/flyer-leads/.superpowers/sdd/gates"` (foreground, once), then
      `cd "W:/tmp/flyer-leads/app" && timeout 1500 npx vitest run > "W:/tmp/flyer-leads/.superpowers/sdd/gates/s4-app-suite.log" 2>&1`
      (with the step-a prefix when needed: `cd "W:/tmp/flyer-leads/app" && timeout 1500 env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx vitest run > "W:/tmp/flyer-leads/.superpowers/sdd/gates/s4-app-suite.log" 2>&1`). Wait for the completion notice; do not poll; never edit source or commit while it runs.
   c. After it finishes, read the EXIT CODE from the completion notice (expected `0`; `124` = the cap fired - report it, do not call it green), then read the log: `grep -nE "Test Files|Tests  |FAIL|\[dynamoAdmin\]" "W:/tmp/flyer-leads/.superpowers/sdd/gates/s4-app-suite.log"`. Expected: a `Test Files` line with no `failed`, no `FAIL`. Any `[dynamoAdmin]` line is one real container fault - capture that run's `err.$metadata.httpStatusCode` and `attempts` and report it. A red DynamoDB Local file is adjudicated by AGENTS.md's re-run-and-compare (re-run the failing FILE alone, more than once, `cd "W:/tmp/flyer-leads/app" && npx vitest run test/<file>`; compare failing FILES at the merge base) before it is called S4's; any other failure is a regression to fix.
2. `cd "W:/tmp/flyer-leads" && npm run typecheck` -> exit 0.
3. `cd "W:/tmp/flyer-leads" && npm run smoke` -> exit 0 (public.ts gained runtime imports: lib/address, lib/events, lib/voiceMasking, repos/activityEventsRepo, repos/listingSendsRepo, services/shareLedger).
4. `cd "W:/tmp/flyer-leads" && npx eslint app/src/routes/public.ts app/src/repos/activityEventsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts app/test/activityEventsRepo.integration.test.ts app/test/activityEventsRepoConsistentRead.test.ts app/test/contactTimeline.test.ts app/test/publicSignupLeads.test.ts app/test/publicIntake.test.ts app/test/backfillJoinHousingAuthority.test.ts` -> no errors (none of these files is in the pre-existing lint backlog, which is dashboard react-hooks only).
5. `cd "W:/tmp/flyer-leads" && git status` -> clean; `git log --oneline -6` shows the five S4 task commits on top of S3's.
6. The slice report (plan section 0): write `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S4-report.md` (create the `slices/` directory if absent) - ASCII, FINDINGS ONLY (what the tree held that the plan got wrong, risks, untrimmed paths), each citing code by `file:line` as the tree stands at the end of S4; if there is nothing to report, one line saying so. Re-verify before writing, and include only what still holds; the candidates this draft already knows of (section E): `unitId` not trimmed by `parseHousingFairBody` itself (`app/src/routes/public.ts` parser, relying on `app/src/app.ts:146`); the harness `createOrGetByParticipantPhone` reusing only OPEN threads (`app/test/helpers/twilioWebhookHarness.ts:652-669`); the audit not telling a repeat from a failed pin (`recorded: false` both); plus anything a task's Step 2 or Step 4 surfaced (e.g. a compile fix the S4 test code needed - R1 #7). Check it: `cd "W:/tmp/flyer-leads" && tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S4-report.md | wc -c` -> `0`. Commit it alone, in the three calls of section C, with paths `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S4-report.md` and `-m` values: 1. `docs(records): flyer-leads S4 slice report` 2. `Findings from building S4 (the activity type, the sign-up handler D4-D7 and its audit), cited by file and line.` 3. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Then `git status` -> clean.

## D. Spec coverage map

| Spec / plan item (S4-owned) | Task |
|---|---|
| D4 findByPhone stays the one lookup | 4.2 (spy: `findByPhone` once, `findAllByPhone` never) |
| D4 live holder of any type = existing; deleted holder = deleted path; none = create | 4.2 |
| D4 deleted path: no conversation, send, pin, unread, sent row; audit on that contact with `deletedContact: true`, `recorded: false`, `sentRecorded: false`, `sentSkipped: 'deleted'` (AR11); `{ ok: true }` | 4.2 (no writes), 4.4 (`'deleted'` in the union), 4.5 (payload + log) |
| D4 an existing contact is never changed (consent included) - Invariant B | 4.2 (byte-identical `toStrictEqual`, no `update` / `create`) |
| D5 welcome only when this request created the contact; flag still set | 4.2 |
| D6.1 repeat check per contact per source per 24h, shared no-property source, new contacts skip the read, fails OPEN - Invariant C | 4.3 (+ 4.1 for the read) |
| D6.2 pin labels (plan 1.1), unit ref only on a shareable flyer, typed name trimmed | 4.3 |
| D6.3 touch -> increment -> ONE event with the returned count; failed increment still emits; failed touch no increment/no event; typed thread via conversationTypeFor; `events` dep - Invariant E | 4.2 (thread type, dep), 4.3 |
| R1 #6: an existing contact on a CLOSED thread - spies pin touch before increment and the event built from the touched image (status `open`) | 4.3 |
| AR8 (S4 issues 1-5): pin `at: nowIso`; ONE clock reading after the welcome feeding window start, pin `at`, touch `ts`, `signedUpAt`; `HarnessOptions.publicNow`; a failed pin still marks; one event for an existing contact, the LAST event carries the count for a new one | 4.2 (seam), 4.3 (clock, pin, mark, event counts), 4.4 (`signedUpAt`) |
| AR12 `hasEventSince` `ConsistentRead: true`, asserted on the command | 4.1 (`activityEventsRepoConsistentRead.test.ts`) |
| AR15 full app suite at the slice end; plan 0 slice report | S4 exit check |
| D6.4 every post-contact step best-effort, logged with marker + step, `{ ok: true }` | 4.3 (repeat, pin, touch, increment), 4.4 (ledger), 4.5 (honest audit flags) |
| D6 new contacts: welcome, then pin + unread; refused welcome still pin + unread | 4.3 |
| D6 audit fields incl. AR2 `refused`, `consentVersion` | 4.5 |
| D7 call site: tenant / unknown, shareable flyer, every sign-up, landlord / partner none, decline holds (S3 decides) | 4.4 |
| Plan 2.5 `signed_up` type + `hasEventSince` (real, fake, conformance: window edge, type filter, ref vs no ref) | 4.1 |
| Plan 2.5 contactTimeline passes `signed_up` through | 4.1 (PIN), 4.3 (end-to-end timeline) |
| Plan 2.6 deps + defaults, harness `public:` wiring | 4.2 (+ 4.3 / 4.4 locals) |
| AR3 injected clock | 4.2 (seam), 4.3 (use) |
| Spec 5 "existing tenant on the flyer" (no text, one pin, unit ref, touched, unread, one event, counted entry) | 4.3 + 4.4 |
| Spec 5 already-sent no reply / replied -> signed_up; current decline -> not_interested + pin + unread; tour -> interested | 4.4 |
| Spec 5 decline after a sign-up, then a second sign-up -> decline holds, `sentSkipped: 'declined'` | 4.4 + 4.5 |
| Spec 5 /join label, no ledger | 4.3 + 4.4 |
| Spec 5 existing landlord with no thread -> landlord_1to1, pin, unread, no welcome, no ledger | 4.2 + 4.3 + 4.4 |
| Spec 5 soft-deleted holder | 4.2 + 4.5 |
| Spec 5 no write to an existing contact, consent included | 4.2 |
| Spec 5 new contact on the flyer; welcome refused | 4.3 + 4.4 |
| Spec 5 same property within / after 24h; different property; /join twice; /join then unavailable flyer; made-up unitIds | 4.3 (+ 4.4 for the entries) |
| Spec 5 each best-effort step failing -> `{ ok: true }`, honest flags, failed increment emits once | 4.3, 4.4, 4.5 |
| Spec 5 existing pins that expected an existing contact to be welcomed | 4.2 (publicIntake 166, 1161), 4.3 ("is idempotent"), 4.5 (payloads) |
| Spec 4 audit reader `backfill-join-housing-authority.ts:226` still works | 4.5 (PIN) |
| Never-log-PII extended to the new steps | 4.5 (PIN) |
| Top-of-file route comment | 4.5 |
| NOT S4: O1 race, broadcast-supersedes-decline, the outcome derivation and its callers (S3); dashboard renderers (S5); e2e, GLOSSARY (S6) | - |

## E. Notes for other slices

Names S4 creates:
- `ActivityEventType` member `'signed_up'`; `ActivityEventsRepo.hasEventSince(contactId, type, sinceIso, refId)` (plan 2.5, exact; a strongly consistent read, AR12).
- Audit `sentSkipped` values: `deleted` (AR11), `not_flyer`, `not_shareable`, `not_tenant`, `declined`, `refused` (AR2), `lost`, `error`; absent ONLY when a flyer entry was written.
- `PublicRouterDeps.activityEventsRepo | listingSendsRepo | events | now` (plan 2.6, exact).
- `HarnessOptions.publicNow?: () => number` (AR8 point 3).
- Private to `routes/public.ts`: `SIGNUP_REPEAT_WINDOW_MS`, `SIGNUP_STEP_FAILED`, `SignupSentSkipped`, `signupPinLabel`, `markSignupUnread`; contactsRepo's `isDeleted` imported as `isContactDeleted` (the unit `isDeleted` already holds the name).
- NEW test files `app/test/publicSignupLeads.test.ts` and `app/test/activityEventsRepoConsistentRead.test.ts`; the slice report `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S4-report.md`.
- S6 Task 6.4 (R1 #8) rewrites `docs/issues/deleted-contact-web-signup-silent.md`: after S4 the deleted path writes NO welcome-refused WARN; its only trace is the `housing_fair_signup` audit on the deleted contact (`deletedContact: true`, `sentSkipped: 'deleted'`) and the `housing-fair signup captured` log line carrying the same booleans.

S4 relies on S3 (plan 2.2 / 2.4 / O1): `applyFlyerShareEntry`, `FlyerShareResult` (incl. `'refused'`), its INFO decline line and ERROR lost line, the `<iso>#flyer` attempt key and the `flyer` entry shape `{ attempt, state: 'counted', by: 'acceptance', countedAt }`, the test helper `seedFlyerSignUp`, the harness fake's token-stamping `setDeclined`, and `outcome: 'signed_up'` on `GET /api/contacts/:id/listings-sent`. Note S3's own warning: an EQUAL `signedUpAt` twice answers `'refused'` - every S4 test advances `clock.ms` between two flyer sign-ups on one pair.

Files other slices also touch (apply on top, never revert): `app/test/helpers/twilioWebhookHarness.ts` (S3: listing-sends fake decline writers; S4: activity fake, HarnessOptions, `public:` block); `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (S3: decline-token builder + LS case; S4: the AE section, the table list, the AE describe); `app/test/contactTimeline.test.ts` (S3: one case + an import; S4: one describe at EOF); `app/test/publicIntake.test.ts` (S1: only the `GET .../flyer` describe; S4: the `POST /public/housing-fair` describes); `app/test/helpers/listingSendSeed.ts` (S3 only; S4 imports from it).

S5 can rely on: the pin's `type: 'signed_up'`, its label text exactly as plan 1.1 (rendered verbatim), `refType: 'unit'` + `refId` = the unitId only for a shareable flyer, no ref otherwise; `GET /api/contacts/:id/timeline` passes them through unchanged.

S6 (e2e) can rely on:
- An existing tenant's flyer sign-up: no new outbound text; its inbox row unread and on top (preview still the newest message); the thread pin `Signed up from the flyer for <formatAddress> as <First Last>`; the property on its Properties sent list reading "Signed up from the flyer <date>".
- An existing contact's /join sign-up: the pin `Signed up on the join page as <First Last>`, unread, no outbound text.
- EVERY sign-up of a FRESH phone now also leaves its new conversation UNREAD with a `signed_up` pin (after the welcome). Specs that sign up fresh phones (`a2p-compliance.spec.ts`, `settings.spec.ts`, `proof-of-send.spec.ts`, `tenant-onboarding.spec.ts` via `e2e/scenarios/steps.ts:609`, `public-pages.spec.ts`) keep their welcome, but any assertion on inbox unread counts or timeline milestone counts after such a sign-up may shift. No existing e2e caller signs up an EXISTING phone expecting a welcome (grep of `e2e/`; S6 to confirm).
- The 24-hour cap runs on the server clock (no e2e seam): one phone signing up twice from the same source in one run gets ONE pin and ONE bump.

Watch items / residuals observed:
- The audit cannot tell a repeat skip from a failed pin (both `recorded: false`); only a failure writes the `housing-fair signup step failed` line (`step: 'pin'`). Spec-defined fields; no change proposed.
- Production ordering: a new contact's welcome touch uses the provider's whole-second timestamp; the mark's touch uses the app clock read just after the welcome. If the provider clock runs ahead, `last_activity_at` can step back by under a second. Cosmetic (the row is still on top).
- Harness divergence (pre-existing, not changed): the fake `createOrGetByParticipantPhone` reuses only an OPEN thread, while the real repo adopts a closed one through its phone claim. Task 4.3 therefore STUBS the adoption (`createOrGetByParticipantPhone` resolves the seeded closed thread) and pins touch -> increment with spies, plus the touched image's `status: 'open'` (R1 #6). The real `touchLastActivity` writes `status = 'open'`, which is what D6.3's touch-first rule relies on.
- Whitespace (D10): the pin label uses the parser-trimmed names (and the app-wide trim). `unitId` is NOT trimmed by `parseHousingFairBody` itself (`public.ts:160-167`); it relies on the app-wide `trimJsonBody` (`app.ts:146`, JSON bodies only). A non-JSON body cannot reach the handler past the boolean consent gate (`smsConsent !== true` refuses a urlencoded `'true'`), so no untrimmed unitId reaches the pin ref, the repeat source or the ledger. Reported, not changed.

## 9. S5 - Dashboard renderers of D6 (the pin) and D8 (the signed_up outcome) (Tasks 5.x)

Plan section 9, Tasks 5.x. Binding: plan sections 0-4 (2.7 minus the flyer /
tag items, which S2 owns; AR9 and AR13 for this slice). Build order (AR4):
S1 -> S2 -> S3 -> S4 -> S5 -> S6, so S1-S4 are on the branch when S5 starts.
S5 depends on S3 (the app outcome union, and AR13's `tenantName` label) and
S4 (the app activity type); the dashboard mirrors both unions by hand (there
is no mirror test for either - `grep -rn "listing_decline_cleared" app
dashboard e2e` finds no cross-workspace test).

Verification note: every test and edit below was run in an isolated copy of the
dashboard (scratch dir, main @b7959e2a sources, the worktree's node_modules
copied) - RED for the stated reason, then GREEN, `tsc -p tsconfig.json --noEmit`
exit 0, the full dashboard suite green (263 files / 5361 tests), and eslint on
the touched files showing only the one pre-existing error named in the exit
check. The AR13 PIN (Task 5.3 step 1c) was run the same way, green with the
Task 5.2 gate in place. Nothing was run inside W:\tmp\flyer-leads.

## A. CONTRACT ISSUES - RULED (AR9, 2026-10-21; nothing open)

1. FollowUpView session-only state: ACCEPTED as pinned. The server never
   serves a `signed_up` item (D8, not waiting), but an Undo (clear) can
   ANSWER one when the person signed up from the flyer meanwhile. FollowUpView
   resolves only `interested` / `not_interested` answers
   (`FollowUpView.tsx:83-85`, `else onUnresolve()`), so the row shows its
   waiting display ("No reply yet, N days", counted) until the next load
   drops it. Task 5.2 step 1d pins it.
2. No endpoint change: nothing in `endpoints.ts` validates or maps an outcome
   (`getUnitRecipients` `:1179-1188` and `getContactListingsSent`
   `:1530-1539` return rows as-is; `setListingSendOutcome` `:1195-1199` POSTs
   only `'interested' | 'not_interested' | 'clear'`). Task 5.2 step 1c keeps
   the pass-through PIN.
3. The `signed_up` pin is GREEN (`styles.green`, the existing positive
   family `tour_scheduled` / `tour_took_place` / `tour_outcome` /
   `placement_closed` use; AR9 replaces 2.7's "neutral or positive").

## B. Facts the tasks rely on (verified on this worktree, main @b7959e2a)

- F1 `dashboard/src/api/types.ts:2929-2932` - the milestone union ends
  `// last-heard-from spec 5.4: mirrors the server union (activityEventsRepo.ts).`
  / `| 'listing_declined'` / `| 'listing_decline_cleared'` / `| 'listing_interested';`
  (union name `TimelineMilestoneType`, declared at `:2904`).
- F2 `types.ts:3148-3150` - `/** last-heard-from spec 5.4 - hand-mirrored from app/src/lib/listingSendOutcome.ts`
  / ` *  (independent types; the lockstep pin is each side's tsc plus the route tests). */`
  / `export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';`.
  Used by `ListingSendRow.outcome` (`:3174`) and `FollowUpItem.outcome` (`:3727`).
- F3 No `Record<ListingSendOutcome, ...>` or `Record<TimelineMilestoneType, ...>`
  exists in the dashboard (`tourActivityFormat.ts:68` is `Record<string, TimelineMilestoneType>`),
  so adding the union members raises NO typecheck error anywhere: every
  renderer must be found by reading, done below.
- F4 Every dashboard reader of an outcome (grep `no_reply|not_interested|'replied'|\.outcome\b`
  over non-test `dashboard/src`):
  - `Card.tsx:266-288` `OutcomeChip` - a `switch (row.outcome)` with
    `default: return null;` (so `signed_up` today renders NO chip);
  - `Card.tsx:345-349` - `const sent = formatHeardFrom(row.sentAt, now);` ...
    `const waiting = row.outcome === 'no_reply' || row.outcome === 'replied';`
    and `const canInterested = waiting && row.interestedSupported && ...`;
  - `Card.tsx:361` - `<span {...(sent.title !== '' && { title: sent.title })}>Sent {sent.label}</span>`;
  - `Card.tsx:381` - `{waiting && !row.interestedSupported && requestTourTo !== undefined ? (`
    (Request a tour) and `:391` `{waiting ? (` (Not interested);
    `:402` `{row.outcome === 'not_interested' ? (` (Undo);
  - `listingFormat.ts:345-350` `groupSendRows` `indexOf`: `recipientMissing`
    -> 3, `interested` -> 1, `not_interested` -> 2, else
    `return r.eligible === true ? 0 : 3;` (so `signed_up` today files under
    Waiting);
  - `FollowUpView.tsx:34-37` `waitingChip` (`item.outcome === 'replied' ? ... : 'No reply yet, ...'`)
    and `:83-85` (resolve on `interested` / `not_interested`, else `onUnresolve()`);
  - `ContactDetail.tsx:705-708` `onListingOutcome` and `ListingDetail.tsx:473-476`
    `onRecipientOutcome` only pass the route's `{ row }` through - no switch;
  - `useFollowUps.ts:16` `FollowUpResolution` (interested / not_interested) - no outcome read;
  - `endpoints.ts` - see A2 (AR9-2).
  No other file switches on or maps the outcome.
- F5 The SendRosterRow hosts: `TenantFile.tsx:334-359` (contact page,
  "Properties sent"; no `requestTourTo` - B8), `PartnerFile.tsx:193-197`
  (partners; D7 never writes a flyer entry for one), `ListingDetail.tsx:1333-1366`
  (property page "Sent to"; `requestTourTo` only when `row.type === 'partner'`,
  `:1359-1362`). `UnknownFile` has no Properties sent card (spec D7: an
  unknown contact's entry shows on the contact page only after triage).
- F6 `interestedSupported` is `contact.type === 'tenant'` on every wire
  (`app/src/routes/units.ts:276`, `app/src/routes/contacts.ts:1337`,
  `app/src/services/followUps.ts:188`). So an UNKNOWN contact's signed_up row
  shows Not interested only; a tenant's shows Interested + Not interested.
- F7 `Timeline.tsx:451-467` `milestoneVariant`: `case 'tour_scheduled':` /
  `case 'tour_took_place':` / `case 'tour_outcome':` / `case 'placement_closed':`
  / `return styles.green ?? '';`, `default: return styles.neutral ?? '';`.
  `Timeline.tsx:472-488` `milestoneHref` already maps `case 'unit': return \`/listings/${ms.refId}\`;`
  and returns null when `!ms.refId` - so a `signed_up` pin with refType
  `unit` links to the property with NO code change, and a ref-less pin renders
  `<span className={styles.pill}>` (`:490-504`). Wire type
  `TimelineMilestone.refType` already allows `'unit'` (`types.ts:3086`).
- F8 CSS modules in vitest: `vite.config.ts:147` `css: false`; class names
  come out hashed but contain the key (observed: `'_evt_c819bb _neutral_c819bb'`),
  which is why existing tests assert `className).toContain('purple')`
  (`Timeline.test.tsx:420`). `Card.module.css:280` `.chipPositive` and
  `Timeline.module.css:485` `.green .pill` exist - no new token.
- F9 Test clock: `dashboard/src/test/setup.ts` pins `Date` to
  `2026-07-01T12:00:00Z` (`vi.setSystemTime`, real timers). Host pages build
  `now` from `new Date()` (e.g. `ListingDetail.tsx:294`), so host tests
  assert the date part by regex `/^Signed up from the flyer /`; the exact
  label is pinned in the unit test with `formatHeardFrom(sentAt, NOW)`.
- F10 The Matching blast default (spec D8 last bullet): no dashboard code
  filters recipients by outcome. `RecipientPreview.tsx:139-143` takes the
  server's `checkedByDefault` verbatim ("the dashboard never recomputes it",
  `types.ts:3656-3660`), and its decline label reads `declinedContactIds`.
  So "a signed_up tenant stays checked" is decided only in
  `app/src/lib/blastAudienceRules.ts` (S3's pin); S5 has nothing to change or pin.
- F11 No dashboard code reads `ListingSendRow.via` or `.broadcastId`
  (grep `\.via\b|broadcastId` over non-test `dashboard/src/routes`, outside
  `broadcasts/`, finds only `OrgPicker.tsx`'s unrelated `option.via`), so the
  flyer entry's first-write `via` (spec D7) renders nowhere.
- F12 ASCII: of the 11 files S5 touches, only `SendRosterRow.test.tsx` and
  `FollowUpView.test.tsx` are ASCII-clean today; `types.ts` (449 non-ASCII
  bytes), `Timeline.tsx` (172), `ContactDetail.test.tsx` (260),
  `Timeline.test.tsx` (75), `ListingDetail.test.tsx` (39), `listingFormat.ts`
  (33), `Card.tsx` (32), `listingFormat.test.ts` (21), `endpoints.test.ts` (6)
  are not - so use the ADDED-lines check for every file. No edit below touches
  a line carrying non-ASCII (e.g. the arrow in the `Timeline.tsx:447` doc
  comment "Milestone kind ... pin color variant" is left alone).
- F13 Baseline counts (main): `Timeline.test.tsx` 164 tests,
  `SendRosterRow.test.tsx` 22, `FollowUpView.test.tsx` 22; all S5 files green.
- F14 Lint baseline: `npx eslint dashboard/src/routes/contact/Timeline.tsx`
  reports ONE pre-existing error at main - `1618:7 react-hooks/set-state-in-effect`
  on `setNow(fresh);`. After Task 5.1 adds 3 lines above it, it reports at
  `1621:7`. Not S5's; name it in the handback. Every other touched file lints clean.

- F15 `tenantName` (AR13). Its one producer is the units recipients
  projection: `app/src/routes/units.ts:268-271`
  `const tenantName = displayNameOfContact(contact);` /
  `...(tenantName !== undefined && { tenantName }),` (no other app route sets
  it; the contact page's listings-sent rows carry none). S3 makes a RESOLVED
  nameless contact carry `formatPhoneForDisplay(phone) ?? phone` there
  (`app/src/lib/phone.ts:73-77`, NANP -> `(470) 555-0182`). The dashboard
  wire comment, `dashboard/src/api/types.ts:3154-3155`:
  `/** Denormalized tenant display name (server contacts join). HONEST - absent`
  / ` *  when the contact is unknown or nameless; render the id as the fallback. */`
  - "or nameless" becomes wrong, so Task 5.3 updates it. The one dashboard
  reader is `ListingDetail.tsx:1343`
  `const name = row.tenantName ?? row.contactId;` - pure rendering, NO
  dashboard logic change is needed: a phone in `tenantName` is shown as the
  identity link and used in the action names. A resolved unknown row is
  labelled `Unknown` by `sendRowKindLabel` (`CONTACT_TYPE_LABEL.unknown`,
  `contactProfile.ts:55`).

Every anchor quoted below was checked unique in its file on this worktree.

## C. Commands used by every task

All in the Bash tool (Git Bash). Never pipe a test or gate command; redirect to
a file and read it afterwards if the output is long. Dashboard tests need NO
DynamoDB.

- Run tests (from the dashboard workspace):
  `cd /w/tmp/flyer-leads/dashboard && npx vitest run <files...>`
  (one test by name: add `-t "<substring>"`).
- Typecheck the dashboard (per task):
  `cd /w/tmp/flyer-leads/dashboard && npm run typecheck`
  (the workspace script `tsc -p tsconfig.json --noEmit`; test files ARE in
  its `include`, so a typed fixture with `'signed_up'` fails it until the
  union has the member).
- ASCII check, per touched file, BEFORE staging (plan 0):
  `cd /w/tmp/flyer-leads && git diff -U0 -- <FILE> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints `0` for each file.
- Commit (plan 0), each step its own call:
  1. `cd /w/tmp/flyer-leads && git status` (bare; read it: only the task's files modified);
  2. `test -e "/w/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge`
     must print `no-merge`;
  3. `cd /w/tmp/flyer-leads && git add <explicit paths>` (never `-A`);
  4. `cd /w/tmp/flyer-leads && git commit -m '<subject>' -m '<body paragraph>' ... -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'`
     - repeated `-m` arguments (plan 0, R1 #15), never a message file inside
     the worktree. Each task gives its exact command. The arguments are
     single-quoted and contain no apostrophe; the last `-m` is the trailer.
  5. `cd /w/tmp/flyer-leads && git status` again - the task's paths are gone
     from it.
- Never edit dashboard source while this worktree's e2e suite runs; never commit during it.
- S1-S4 are on the branch (AR4). If an earlier slice (S2 is the only other
  dashboard slice) already changed a file named here, re-read it and apply the
  edit on top; the quoted anchor is the authority, not the line number.

## Task 5.1 - The `signed_up` thread pin (D6)

Goal: the contact thread renders the new `signed_up` milestone as a green pin;
a unit-ref pin links to the property, a ref-less pin is plain text (spec D6
step 2, plan 2.7 `MilestonePin`).

Files:
- `dashboard/src/api/types.ts` (the `TimelineMilestoneType` union)
- `dashboard/src/routes/contact/Timeline.tsx` (`milestoneVariant`)
- `dashboard/src/routes/contact/Timeline.test.tsx`

### Step 1 - tests (write first)

`Timeline.test.tsx`: insert the two tests below IMMEDIATELY BEFORE the anchor
line (`:443`, inside `describe('Timeline', ...)`):

```
  it('hides milestones when "Comms only" is toggled', () => {
```

Text to insert (the anchor line stays, after it):

```tsx
  // flyer-leads D6: the sign-up pin. A flyer sign-up for a shareable property
  // carries refType 'unit', so the generic unit deep-link makes the pin a link
  // to the property page. Its colour is the existing green (a positive lead
  // signal) - no new token.
  it('renders a signed_up milestone with a unit ref as a green pin linking to the property', () => {
    const signedUp: TimelineItem = {
      kind: 'milestone',
      id: 'ms-signed-up',
      at: '2026-06-08T08:00:00',
      type: 'signed_up',
      label: 'Signed up from the flyer for 12 Oak St as Tia Moss',
      refType: 'unit',
      refId: 'u1',
    };
    renderTimeline({ items: [signedUp] });
    const link = screen.getByRole('link', { name: 'Signed up from the flyer for 12 Oak St as Tia Moss' });
    expect(link).toHaveAttribute('href', '/listings/u1');
    expect(link.parentElement?.className).toContain('green');
  });

  // flyer-leads D6: the /join pin and the not-shareable flyer pin carry no
  // ref - a plain (non-link) green pin showing the server's label verbatim.
  it('renders a signed_up milestone with no ref as a plain green pin', () => {
    const joined: TimelineItem = {
      kind: 'milestone',
      id: 'ms-joined',
      at: '2026-06-08T08:00:00',
      type: 'signed_up',
      label: 'Signed up on the join page as Tia Moss',
    };
    renderTimeline({ items: [joined] });
    const text = screen.getByText('Signed up on the join page as Tia Moss');
    expect(text.closest('a')).toBeNull();
    // pillText span -> pill span -> the event div that carries the variant.
    expect(text.parentElement?.parentElement?.className).toContain('green');
  });

```

(`TimelineItem`, `renderTimeline`, `screen` are already imported/defined at
the top of the file.)

### Step 2 - run RED

`cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/Timeline.test.tsx -t "signed_up"`

Expected: `2 failed | 164 skipped`, both with
`AssertionError: expected '_evt_<hash> _neutral_<hash>' to contain 'green'`
(the href assertion already PASSES - the generic `unit` deep-link, F7; it is
the regression pin for "the pin links to the property").

`cd /w/tmp/flyer-leads/dashboard && npm run typecheck` - expected to FAIL with
TS2322 on the two `type: 'signed_up'` lines in `Timeline.test.tsx`
(`'"signed_up"' is not assignable to type 'TimelineMilestoneType'`).

### Step 3 - implementation

3a. `dashboard/src/api/types.ts` - anchor (`:2931-2932`):

```
  | 'listing_decline_cleared'
  | 'listing_interested';
```

Replace with:

```
  | 'listing_decline_cleared'
  | 'listing_interested'
  // flyer-leads D6: mirrors the server union (activityEventsRepo.ts) - a flyer
  // or /join sign-up pin; a shareable flyer's pin carries refType 'unit'.
  | 'signed_up';
```

3b. `dashboard/src/routes/contact/Timeline.tsx` - anchor (`:461-463`, inside
`milestoneVariant`):

```
    case 'tour_outcome':
    case 'placement_closed':
      return styles.green ?? '';
```

Replace with:

```
    case 'tour_outcome':
    case 'placement_closed':
    // flyer-leads D6: a flyer / join sign-up is a positive lead signal - the
    // existing green colour, no new token.
    case 'signed_up':
      return styles.green ?? '';
```

No change to `milestoneHref` or `MilestonePin` (F7).

### Step 4 - run GREEN

- `cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/Timeline.test.tsx`
  -> 1 file passed, 166 tests passed (164 + 2).
- `cd /w/tmp/flyer-leads/dashboard && npm run typecheck` -> exit 0.

### Step 5 - ASCII check

Run the C command for `dashboard/src/api/types.ts`,
`dashboard/src/routes/contact/Timeline.tsx`,
`dashboard/src/routes/contact/Timeline.test.tsx` - each prints `0`.

### Step 6 - commit

Paths: `dashboard/src/api/types.ts dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx`

After the C steps 1-3 (`git add` of exactly those three paths):

```
cd /w/tmp/flyer-leads && git commit -m 'feat(dashboard): signed_up thread pin - green milestone, unit ref links to the property' -m 'flyer-leads D6 (plan Task 5.1). TimelineMilestoneType mirrors the new app activity type signed_up. milestoneVariant files it with the green (positive) family (AR9); the existing unit deep-link makes the pin of a shareable flyer a link to the property, and a /join or not-shareable pin stays plain text.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## Task 5.2 - The `signed_up` outcome on the send roster (D8)

Goal: the wire outcome union gains `signed_up`; `SendRosterRow` (contact page
and property page) reads "Signed up from the flyer <date>" in place of
"Sent <date>", chips "Signed up", and offers the waiting actions (spec D8
Renderers bullets 1-3, plan 1.1 "Send roster", plan 2.7 `Card.tsx`). Pins the
pass-through endpoints (AR9-2) and the FollowUpView answer path (AR9-1).

Files:
- `dashboard/src/api/types.ts` (`ListingSendOutcome`)
- `dashboard/src/routes/contact/Card.tsx` (`OutcomeChip`, `SendRosterRow`)
- `dashboard/src/routes/contact/SendRosterRow.test.tsx`
- `dashboard/src/routes/contact/ContactDetail.test.tsx`
- `dashboard/src/api/endpoints.test.ts`
- `dashboard/src/routes/broadcasts/FollowUpView.test.tsx`

### Step 1 - tests (write first)

1a. `SendRosterRow.test.tsx` - insert a new describe IMMEDIATELY BEFORE the
anchor (`:161`):

```
describe('SendRosterRow - actions', () => {
```

Text to insert:

```tsx
// flyer-leads D8: a pair whose latest counted entry is a flyer sign-up.
describe('SendRosterRow - signed_up (flyer-leads D8)', () => {
  const SIGNED_UP_AT = '2026-10-11T16:30:00.000Z';
  const SIGNED_UP: Partial<ListingSendRow> = { outcome: 'signed_up', sentAt: SIGNED_UP_AT };

  it('reads "Signed up from the flyer <date>" in place of "Sent <date>" - the same date label and title', () => {
    renderRow(SIGNED_UP);
    const sent = formatHeardFrom(SIGNED_UP_AT, NOW);
    expect(sent.title).not.toBe('');
    expect(screen.getByText(`Signed up from the flyer ${sent.label}`)).toHaveAttribute('title', sent.title);
    expect(screen.queryByText(/^Sent /)).not.toBeInTheDocument();
    // The Last heard from half is unchanged.
    expect(screen.getByText(`Last heard from ${formatHeardFrom(undefined, NOW).label}`)).toBeInTheDocument();
  });

  it('the outcome chip reads "Signed up", in the positive chip colour', () => {
    renderRow(SIGNED_UP);
    expect(screen.getByText('Signed up', { exact: true }).className).toContain('chipPositive');
  });

  it('offers the waiting actions - Interested and Not interested - and no Undo', () => {
    renderRow(SIGNED_UP);
    expect(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toHaveTextContent('Interested');
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toHaveTextContent('Not interested');
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });

  it('Not interested calls the outcome route', async () => {
    const { onOutcome } = renderRow(SIGNED_UP);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' }));
    expect(onOutcome).toHaveBeenCalledWith('not_interested');
  });

  // An unknown contact's flyer row (interestedSupported false; the hosts pass
  // requestTourTo for a PARTNER only): Not interested alone.
  it('an unknown-contact row offers Not interested only - no Interested, no Request a tour', () => {
    renderRow({ ...SIGNED_UP, interestedSupported: false });
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mark Tia Moss interested in/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
  });

  it('a deleted property keeps the words and the chip but drops every action', () => {
    renderRow(SIGNED_UP, { actionsDisabled: true });
    expect(screen.getByText(`Signed up from the flyer ${formatHeardFrom(SIGNED_UP_AT, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByText('Signed up', { exact: true })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

```

(`renderRow`, `NOW`, `ROW`, `formatHeardFrom`, `userEvent`, `ListingSendRow`
are already in the file. `getByText('Signed up', { exact: true })` matches the
chip only - the words span's full text is longer.)

1b. `ContactDetail.test.tsx` - insert IMMEDIATELY BEFORE the anchor (`:1145`,
inside `describe('ContactDetail', ...)`):

```
  it("a failed listings-sent read shows \"We couldn't load properties sent.\" (not the pending panel)", async () => {
```

Text to insert:

```tsx
  // flyer-leads D8: the contact page's Properties sent row for a flyer sign-up.
  it('a signed_up Properties sent row reads "Signed up from the flyer <date>", chips "Signed up" and offers Interested / Not interested', async () => {
    getContact.mockResolvedValue(TENANT);
    getAllUnits.mockResolvedValue([{ unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd', tour_type: 'self_guided' }]);
    getContactListingsSent.mockResolvedValue([
      { contactId: 'k1', unitId: 'u1', sentAt: '2026-06-30T15:00:00.000Z', via: 'broadcast', outcome: 'signed_up', interestedSupported: true },
    ]);
    renderAt('k1');
    const list = await screen.findByRole('list', { name: 'Properties sent' });
    const row = within(list).getByRole('listitem');
    expect(within(row).getByText(/^Signed up from the flyer /)).toBeInTheDocument();
    expect(within(row).queryByText(/^Sent /)).not.toBeInTheDocument();
    expect(within(row).getByText('Signed up', { exact: true })).toBeInTheDocument();
    expect(await within(row).findByRole('button', { name: 'Mark Tasha Williams interested in 1450 Joseph Blvd' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Mark Tasha Williams not interested in 1450 Joseph Blvd' })).toBeInTheDocument();
  });

```

(`TENANT` = Tasha Williams / `k1` at `:243`; the mocks are plain `vi.fn()`s at
`:25-28`; the `findByRole` on Interested waits for the units read, which gates
`actionsDisabled` in `TenantFile.tsx:349`.)

1c. `endpoints.test.ts` (PIN, AR9-2) - three edits.

Import list anchor (`:44-46`):

```
  getContact,
  getContactVocabulary,
  getFollowUps,
```

Replace with:

```
  getContact,
  getContactListingsSent,
  getContactVocabulary,
  getFollowUps,
  getUnitRecipients,
```

Type import anchor (`:62`):

```
import type { ApplyRequirementsBody, ContactPatch, RosterView, UnitItem } from './types.js';
```

Replace with:

```
import type { ApplyRequirementsBody, ContactPatch, ListingSendRow, RosterView, UnitItem } from './types.js';
```

Then insert IMMEDIATELY BEFORE the anchor (`:835`):

```
it('getFollowUps GETs the waiting list and forwards the abort signal (last-heard-from 5.6)', async () => {
```

Text to insert:

```ts
// flyer-leads D8 (plan 2.7), PIN: the two roster reads never validate or remap
// the wire outcome - a signed_up row arrives as-is. The typed fixture is the
// compile-time half (npm run typecheck).
it('getContactListingsSent and getUnitRecipients pass a signed_up row through as-is', async () => {
  const row: ListingSendRow = {
    contactId: 'c1',
    unitId: 'u1',
    sentAt: '2026-10-11T16:30:00.000Z',
    via: 'broadcast',
    outcome: 'signed_up',
    interestedSupported: true,
  };
  vi.mocked(request).mockResolvedValueOnce({ sent: [row] });
  await expect(getContactListingsSent('c1')).resolves.toEqual([row]);
  expect(request).toHaveBeenLastCalledWith('/api/contacts/c1/listings-sent', {});
  vi.mocked(request).mockResolvedValueOnce({ recipients: [row] });
  await expect(getUnitRecipients('u1')).resolves.toEqual([row]);
  expect(request).toHaveBeenLastCalledWith('/api/units/u1/recipients', {});
});

```

1d. `FollowUpView.test.tsx` (PIN, AR9-1) - insert IMMEDIATELY BEFORE the anchor
(`:229`, inside `describe('FollowUpView - actions', ...)`):

```
  // Review B R2-5: the property lost its tour_type since the list loaded -
```

Text to insert:

```tsx
  // flyer-leads D8, PIN: the server never serves a signed_up row (it is not
  // waiting), but an action can ANSWER signed_up - an Undo (clear) on a pair
  // whose latest counted entry is a flyer sign-up. Like any answer that is
  // neither interested nor not_interested, the row goes back to its waiting
  // display for the session and leaves the list on the next load.
  it('an Undo answered signed_up un-resolves the row back to its waiting display', async () => {
    const u = userEvent.setup();
    setListingSendOutcome
      .mockResolvedValueOnce({ row: { outcome: 'not_interested' } })
      .mockResolvedValueOnce({ row: { outcome: 'signed_up' } });
    renderView([item()]);
    await u.click(await screen.findByRole('button', { name: 'Mark Dario Vance not interested in 672 Cameron Alexander Blvd A' }));
    const row = rowOf('Dario Vance');
    await u.click(await within(row).findByRole('button', { name: 'Undo not interested for Dario Vance' }));
    expect(setListingSendOutcome).toHaveBeenLastCalledWith('u1', 'c1', 'clear');
    expect(await within(row).findByText('No reply yet, 10 days')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Mark Dario Vance not interested in 672 Cameron Alexander Blvd A' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('1 waiting');
  });

```

(AR9-1 accepted this behavior; the PIN records it.)

### Step 2 - run RED

`cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/SendRosterRow.test.tsx src/routes/contact/ContactDetail.test.tsx src/api/endpoints.test.ts src/routes/broadcasts/FollowUpView.test.tsx`

Expected: `2 failed | 2 passed` files, `7 failed` tests - the 6 new
SendRosterRow cases and the new ContactDetail case - each a
`TestingLibraryElementError`:
- `Unable to find an element with the text: Signed up from the flyer <label>`
  / `.../^Signed up from the flyer /` (the row still reads "Sent ...");
- `Unable to find an element with the text: Signed up` (`OutcomeChip` returns
  null for an unknown outcome, F4);
- `Unable to find an accessible element with the role "button" and name "Mark Tia Moss interested in 12 Oak St"`
  / `... not interested ...` (the `waiting` gate excludes `signed_up`).
The endpoints and FollowUpView cases PASS (PINs - current code already
behaves so).

`cd /w/tmp/flyer-leads/dashboard && npm run typecheck` - expected to FAIL with
TS2322 on `outcome: 'signed_up'` in `SendRosterRow.test.tsx` (the `SIGNED_UP`
const) and `endpoints.test.ts` (the typed `row`).

### Step 3 - implementation

3a. `dashboard/src/api/types.ts` - anchor (`:3149-3150`):

```
 *  (independent types; the lockstep pin is each side's tsc plus the route tests). */
export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';
```

Replace with:

```
 *  (independent types; the lockstep pin is each side's tsc plus the route tests).
 *  flyer-leads D8 adds `signed_up`: the pair's latest counted entry is a flyer
 *  sign-up. It is never waiting, so a Follow up item never carries it. */
export type ListingSendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested' | 'signed_up';
```

3b. `dashboard/src/routes/contact/Card.tsx` - five edits.

(i) `OutcomeChip`, anchor (`:272-273`):

```
    case 'replied':
      return <span className={`${chip} ${styles.chipPositive ?? ''}`}>Replied</span>;
```

Replace with:

```
    case 'replied':
      return <span className={`${chip} ${styles.chipPositive ?? ''}`}>Replied</span>;
    case 'signed_up':
      // flyer-leads D8: the pair's latest counted entry is a flyer sign-up.
      return <span className={`${chip} ${styles.chipPositive ?? ''}`}>Signed up</span>;
```

(ii) The `SendRosterRow` doc comment, anchor (`:304-305`):

```
 *  link (+ kind) and the muted "Sent <date> - Last heard from <date>"; line
 *  two is the outcome chip and the outcome's actions. The root is an `<li>`
```

Replace with:

```
 *  link (+ kind) and the muted "Sent <date> - Last heard from <date>" (a
 *  signed_up row reads "Signed up from the flyer <date>", flyer-leads D8); line
 *  two is the outcome chip and the outcome's actions. The root is an `<li>`
```

(iii) The words and the action gate, anchor (`:345-349`):

```
  const sent = formatHeardFrom(row.sentAt, now);
  const heard = formatHeardFrom(row.lastHeardFromAt, now);
  const showActions = !actionsDisabled && row.recipientMissing !== true;
  const waiting = row.outcome === 'no_reply' || row.outcome === 'replied';
  const canInterested = waiting && row.interestedSupported && (interestedMode === 'route' || onOpenTourForm !== undefined);
```

Replace with:

```
  const sent = formatHeardFrom(row.sentAt, now);
  // flyer-leads D8: a flyer sign-up's sentAt is the sign-up instant.
  const sentWords = row.outcome === 'signed_up' ? 'Signed up from the flyer' : 'Sent';
  const heard = formatHeardFrom(row.lastHeardFromAt, now);
  const showActions = !actionsDisabled && row.recipientMissing !== true;
  // The waiting outcomes' actions. flyer-leads D8: a signed_up row offers the
  // same ones (signed_up is never "waiting" on the server - isWaiting - but it
  // is still an open lead); Request a tour keeps its host-side partner-only rule.
  const actionable = row.outcome === 'no_reply' || row.outcome === 'replied' || row.outcome === 'signed_up';
  const canInterested = actionable && row.interestedSupported && (interestedMode === 'route' || onOpenTourForm !== undefined);
```

(iv) The date span, anchor (`:361`):

```
          <span {...(sent.title !== '' && { title: sent.title })}>Sent {sent.label}</span>
```

Replace with:

```
          <span {...(sent.title !== '' && { title: sent.title })}>
            {sentWords} {sent.label}
          </span>
```

(Same `sent` label and title for both words - the date is formatted exactly
as "Sent <date>" is, plan 1.1.)

(v) The two remaining gate uses - anchor (`:381`):

```
            {waiting && !row.interestedSupported && requestTourTo !== undefined ? (
```

Replace with:

```
            {actionable && !row.interestedSupported && requestTourTo !== undefined ? (
```

and anchor (`:391`):

```
            {waiting ? (
```

Replace with:

```
            {actionable ? (
```

After (v), `grep -n "\bwaiting\b" dashboard/src/routes/contact/Card.tsx` must
show only the two new comment lines (no code use of `waiting` remains - tsc
would otherwise fail on the removed const). The Undo gate (`row.outcome === 'not_interested'`)
is unchanged.

### Step 4 - run GREEN

- `cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/SendRosterRow.test.tsx src/routes/contact/ContactDetail.test.tsx src/api/endpoints.test.ts src/routes/broadcasts/FollowUpView.test.tsx`
  -> 4 files passed, 0 failed.
- Regression over the other SendRosterRow hosts:
  `cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/files.test.tsx src/routes/listing/ListingDetail.test.tsx`
  -> 2 files passed (the existing `Sent <date>` assertions still hold: the
  `{sentWords} {sent.label}` span keeps the text "Sent <label>").
- `cd /w/tmp/flyer-leads/dashboard && npm run typecheck` -> exit 0.

### Step 5 - ASCII check

Run the C command for each of the six files - each prints `0`.

### Step 6 - commit

Paths: `dashboard/src/api/types.ts dashboard/src/routes/contact/Card.tsx dashboard/src/routes/contact/SendRosterRow.test.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/api/endpoints.test.ts dashboard/src/routes/broadcasts/FollowUpView.test.tsx`

After the C steps 1-3 (`git add` of exactly those six paths):

```
cd /w/tmp/flyer-leads && git commit -m 'feat(dashboard): signed_up send outcome - "Signed up from the flyer" row, chip and actions' -m 'flyer-leads D8 (plan Task 5.2). ListingSendOutcome mirrors the new app outcome signed_up. SendRosterRow (contact page Properties sent, property page Sent to) reads "Signed up from the flyer <date>" in place of "Sent <date>" with the same date label and title, chips "Signed up", and offers the waiting actions (Interested / Not interested; Request a tour keeps its partner-only host rule).' -m 'Pins (AR9): the roster endpoints pass the outcome through, and a FollowUpView Undo answered signed_up returns the row to its waiting display until the next load.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## Task 5.3 - The property "Sent to" card files `signed_up` (D8)

Goal: `groupSendRows` files a `signed_up` row under Interested when the
recipient is eligible and under Not eligible otherwise, like a waiting outcome
(spec D8 Renderers bullet 4, plan 2.7 `listingFormat.ts`, AR7 item 3). Also
AR13's dashboard half: the `tenantName` wire comment, and a PIN that a
nameless resolved recipient renders the phone label the server sends (no
dashboard logic change - F15).

Files:
- `dashboard/src/routes/listing/listingFormat.ts`
- `dashboard/src/routes/listing/listingFormat.test.ts`
- `dashboard/src/routes/listing/ListingDetail.test.tsx`
- `dashboard/src/api/types.ts` (the `ListingSendRow.tenantName` comment only)

### Step 1 - tests (write first)

1a. `listingFormat.test.ts` - inside `describe('groupSendRows - the four groups that cover every row (spec 5.5)', ...)`,
anchor (`:424-425`):

```
    expect(groups.map((g) => g.rows.length)).toEqual([0, 0, 0, 1]);
  });
```

Replace with (the anchor kept, the new test after it):

```ts
    expect(groups.map((g) => g.rows.length)).toEqual([0, 0, 0, 1]);
  });

  // flyer-leads D8: a signed_up row is filed like a waiting outcome, except
  // that an ELIGIBLE recipient goes under Interested (the person reached out).
  // Not eligible otherwise: eligible false or absent, or the contact missing.
  it('signed_up: Interested when eligible; Not eligible when not, when the flag is absent, or when the contact is missing', () => {
    const groups = groupSendRows([
      row('su-ok', '2026-10-05T00:00:00.000Z', { outcome: 'signed_up' }),
      row('su-ne', '2026-10-06T00:00:00.000Z', { outcome: 'signed_up', eligible: false }),
      row('su-unset', '2026-10-04T00:00:00.000Z', { outcome: 'signed_up', eligible: undefined }),
      row('su-missing', '2026-10-07T00:00:00.000Z', { outcome: 'signed_up', recipientMissing: true }),
      row('int', '2026-10-03T00:00:00.000Z', { outcome: 'interested' }),
    ]);
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.contactId)])).toEqual([
      ['waiting', []],
      ['interested', ['su-ok', 'int']],
      ['not_interested', []],
      ['not_eligible', ['su-missing', 'su-ne', 'su-unset']],
    ]);
  });
```

(The describe's `row()` helper defaults `eligible: true`, so `su-missing` is
eligible but missing - the missing rule wins.)

1b. `ListingDetail.test.tsx` - inside `describe('ListingDetail - "Sent to" outcomes (last-heard-from spec 5.5)', ...)`,
insert IMMEDIATELY BEFORE the anchor (`:3115`):

```
  it('Not interested calls the route and applies the returned { row } through setRecipientRow', async () => {
```

Text to insert:

```tsx
  // flyer-leads D8: a flyer sign-up on the property page - an eligible
  // recipient files under Interested with the waiting actions; an ineligible
  // one under Not eligible.
  it('a signed_up row files under Interested with "Signed up from the flyer <date>", the "Signed up" chip and both actions', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [sent({ outcome: 'signed_up' }), sent({ contactId: 'c-ne', tenantName: 'Ned Ineligible', outcome: 'signed_up', eligible: false })],
      },
    });
    renderAt();
    expect(within(card()).getAllByRole('list').map((l) => l.getAttribute('aria-label'))).toEqual(['Interested', 'Not eligible']);
    const li = within(within(card()).getByRole('list', { name: 'Interested' })).getByRole('listitem');
    expect(within(li).getByRole('link', { name: 'Tia Moss' })).toHaveAttribute('href', '/contacts/c-1');
    expect(within(li).getByText(/^Signed up from the flyer /)).toBeInTheDocument();
    expect(within(li).getByText('Signed up', { exact: true })).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(within(card()).getByRole('list', { name: 'Not eligible' })).getByRole('link', { name: 'Ned Ineligible' })).toBeInTheDocument();
  });

```

(`unit`, `sent()`, `card()` are the describe's own helpers at `:3064-3069`;
`sent()` defaults `eligible: true`, `interestedMode: 'route'`, `tenantName: 'Tia Moss'`.)

1c. `ListingDetail.test.tsx` (PIN, AR13) - insert directly AFTER the 1b test,
i.e. also IMMEDIATELY BEFORE the same anchor
`  it('Not interested calls the route and applies the returned { row } through setRecipientRow', async () => {`:

```tsx
  // flyer-leads AR13, PIN (pure rendering - the app projection owns the
  // label): a RESOLVED contact with no name (an auto-captured unknown sign-up)
  // arrives with its formatted phone in tenantName, and the row is named by
  // it - never by the raw contactId. A MISSING contact still has no
  // tenantName and keeps the contactId fallback (ListingDetail.tsx:1343).
  it('a nameless resolved recipient is labelled by the phone the server sends in tenantName; a missing one keeps the id', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ contactId: 'c-unk', tenantName: '(470) 555-0182', type: 'unknown', interestedSupported: false, outcome: 'signed_up' }),
          sent({ contactId: 'c-gone', tenantName: undefined, interestedSupported: false, eligible: false, recipientMissing: true }),
        ],
      },
    });
    renderAt();
    const link = within(card()).getByRole('link', { name: '(470) 555-0182' });
    expect(link).toHaveAttribute('href', '/contacts/c-unk');
    const li = link.closest('li') as HTMLElement;
    expect(within(li).getByText('Unknown')).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark (470) 555-0182 not interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(card()).queryByText('c-unk')).not.toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: 'c-gone' })).toHaveAttribute('href', '/contacts/c-gone');
  });

```

(It asserts no group on purpose - 1b owns the grouping - so it is green both
before and after step 3: a PIN. The Not interested button exists because Task
5.2's gate is in. `Unknown` is the kind label, F15.)

### Step 2 - run RED

`cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/listing/listingFormat.test.ts src/routes/listing/ListingDetail.test.tsx -t "signed_up"`

Expected: `2 failed`:
- listingFormat: `AssertionError: expected [ [ 'waiting', [ 'su-ok' ] ], ...(3) ] to deeply equal [ [ 'waiting', [] ], ...(3) ]`
  (today `signed_up` falls through to `eligible === true ? 0 : 3`, F4);
- ListingDetail: `AssertionError: expected [ 'Waiting', 'Not eligible' ] to deeply equal [ 'Interested', 'Not eligible' ]`.
(Task 5.2 is already in, so the words / chip / buttons exist; only the group is wrong.)

Then the PIN alone:
`cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx -t "nameless"`
-> `1 passed` (expected green - PIN).

`npm run typecheck` is already green here (Task 5.2 added the union member;
these fixtures are `Partial<ListingSendRow>` / untyped).

### Step 3 - implementation

3a. `dashboard/src/routes/listing/listingFormat.ts` - `indexOf` in
`groupSendRows`, anchor (`:348-349`):

```
    if (r.outcome === 'not_interested') return 2;
    return r.eligible === true ? 0 : 3;
```

Replace with:

```
    if (r.outcome === 'not_interested') return 2;
    // flyer-leads D8: a flyer sign-up is never waiting - the person reached
    // out - so an eligible recipient files under Interested.
    if (r.outcome === 'signed_up') return r.eligible === true ? 1 : 3;
    return r.eligible === true ? 0 : 3;
```

(The `recipientMissing` line above stays first, so a missing contact is Not
eligible whatever its outcome.)

3b. The `groupSendRows` doc comment, anchor (`:334-336`):

```
 * lookback/quiet thresholds), Interested, Not interested, Not eligible (a
 * waiting outcome on an ineligible recipient, and EVERY row whose contact is
 * missing). `eligible` absent counts as not eligible.
```

Replace with:

```
 * lookback/quiet thresholds), Interested (and, flyer-leads D8, signed_up on an
 * ELIGIBLE recipient), Not interested, Not eligible (a waiting or signed_up
 * outcome on an ineligible recipient, and EVERY row whose contact is
 * missing). `eligible` absent counts as not eligible.
```

`SendRowGroup`'s key / label unions are unchanged (still four groups).

3c. `dashboard/src/api/types.ts` (AR13, comment only) - anchor
(`:3154-3156`, in `interface ListingSendRow`; re-read it first - Task 5.2
edited lines just above it):

```
  /** Denormalized tenant display name (server contacts join). HONEST - absent
   *  when the contact is unknown or nameless; render the id as the fallback. */
  tenantName?: string;
```

Replace with:

```
  /** Denormalized recipient display name (server contacts join; only the
   *  property "Sent to" rows carry it). A RESOLVED contact with no first or
   *  last name carries its formatted phone instead (flyer-leads AR13), so a
   *  contact that exists is never shown by its raw id. HONEST - absent when
   *  the contact did not resolve (recipientMissing), or has neither a name nor
   *  a phone; render the id as the fallback. */
  tenantName?: string;
```

No other dashboard change for AR13: `ListingDetail.tsx:1343`
`row.tenantName ?? row.contactId` already renders whatever label arrives.

### Step 4 - run GREEN

- `cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/listing/listingFormat.test.ts src/routes/listing/ListingDetail.test.tsx`
  -> 2 files passed, 0 failed.
- `cd /w/tmp/flyer-leads/dashboard && npm run typecheck` -> exit 0.

### Step 5 - ASCII check

Run the C command for the four files - each prints `0`.

### Step 6 - commit

Paths: `dashboard/src/routes/listing/listingFormat.ts dashboard/src/routes/listing/listingFormat.test.ts dashboard/src/routes/listing/ListingDetail.test.tsx dashboard/src/api/types.ts`

After the C steps 1-3 (`git add` of exactly those four paths):

```
cd /w/tmp/flyer-leads && git commit -m 'feat(dashboard): property Sent to card files a signed_up row under Interested' -m 'flyer-leads D8 (plan Task 5.3). groupSendRows files a flyer sign-up under Interested when the recipient is eligible and under Not eligible otherwise (eligible false or absent, or the contact missing) - never Waiting.' -m 'AR13: the ListingSendRow.tenantName comment now says a resolved nameless contact carries its formatted phone; a PIN shows the Sent to card renders that label, and a missing contact keeps the id fallback.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## S5 exit check (ends with the slice report commit)

1. `cd /w/tmp/flyer-leads/dashboard && npx vitest run src/routes/contact/Timeline.test.tsx src/routes/contact/SendRosterRow.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/files.test.tsx src/api/endpoints.test.ts src/routes/broadcasts/FollowUpView.test.tsx src/routes/listing/listingFormat.test.ts src/routes/listing/ListingDetail.test.tsx`
   -> 8 files passed, 0 failed.
2. `cd /w/tmp/flyer-leads && npm run typecheck` (root: every workspace,
   including S3/S4's app changes) -> exit 0.
3. Lint preview of gate 5 for S5's files:
   `cd /w/tmp/flyer-leads && npx eslint dashboard/src/api/types.ts dashboard/src/api/endpoints.test.ts dashboard/src/routes/broadcasts/FollowUpView.test.tsx dashboard/src/routes/contact/Card.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/routes/contact/SendRosterRow.test.tsx dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx dashboard/src/routes/listing/ListingDetail.test.tsx dashboard/src/routes/listing/listingFormat.test.ts dashboard/src/routes/listing/listingFormat.ts`
   -> exactly ONE error, pre-existing (F14): `Timeline.tsx` `react-hooks/set-state-in-effect`
   on `setNow(fresh);` (1618 at main, 1621 after Task 5.1). Anything else is
   S5's and blocking. Name the pre-existing one in the slice report.
4. MANDATORY - the full DASHBOARD suite, because S5 edits shared modules
   (the `types.ts` unions, the `Card.tsx` action gate used by every
   SendRosterRow host, `groupSendRows`). Run it bare from `dashboard/` with a
   hard outer timeout, never piped. It can take longer than two minutes, so
   run it in the background with the Bash tool (`run_in_background`) and its
   log under `.superpowers/sdd/` (gitignored run state, never committed):
   `cd /w/tmp/flyer-leads/dashboard && timeout 1200 npx vitest run > /w/tmp/flyer-leads/.superpowers/sdd/S5-dashboard-suite.log 2>&1; echo "exit=$?" >> /w/tmp/flyer-leads/.superpowers/sdd/S5-dashboard-suite.log`
   Wait for the completion notice, then read the log's last lines and its
   `exit=` line. `exit=0` with `Test Files  N passed (N)` and no failed test
   is the pass (263 files / 5361 tests with S5 alone on main sources; S1-S4
   may add files). `exit=124` means the timeout fired - a FAIL to diagnose,
   never a pass. Any other non-zero exit: read the failing files in the log
   and fix S5's cause before step 5. Never run it at the same time as an e2e
   run in this worktree.
5. `cd /w/tmp/flyer-leads && git status` -> no S5 path modified or untracked
   (Tasks 5.1-5.3 are committed).
6. The slice report (plan 0): write
   `W:\tmp\flyer-leads\docs\superpowers\reviews\2026-10-21-flyer-leads\slices\S5-report.md`
   (create the `slices` folder if S1-S4 have not), ASCII, FINDINGS ONLY, each
   citing code by `file:line`: what the tree held that this plan got wrong,
   risks, and any untrimmed typed-input path met in a surface S5 touched
   (D10). It always names the pre-existing lint error from step 3
   (`dashboard/src/routes/contact/Timeline.tsx:<line>` `react-hooks/set-state-in-effect`,
   not S5's) so gate 5 is not re-diagnosed. If there is nothing else, that
   one line is the report. No narrative, no copy of the plan.
   - ASCII: `cd /w/tmp/flyer-leads && tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S5-report.md | wc -c` prints `0`.
   - Commit it with the C steps 1-3 (`git add docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S5-report.md` only), then:
     `cd /w/tmp/flyer-leads && git commit -m 'docs(records): flyer-leads S5 slice report' -m 'Findings from building plan section 9 (Tasks 5.1-5.3), cited by file:line.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'`
   - `cd /w/tmp/flyer-leads && git status` -> clean for S5.

## D. Spec coverage map (S5's items -> task)

| Spec item | Where |
|---|---|
| D6 step 2: `signed_up` renders as a pin in the thread (`MilestonePin`) | 5.1 |
| D6 step 2: a shareable flyer's pin (refType `unit`) links to the property | 5.1 (pinned; existing generic link, F7) |
| D6 step 2: /join and not-shareable pins (no ref) render plain | 5.1 |
| Spec 4 "The dashboard: the activity-type union and `MilestonePin`" | 5.1 |
| Plan 2.7 / AR9-3: `MilestonePin` colour, the existing green | 5.1 |
| Spec 4 / plan 2.7: wire outcome union in `types.ts` | 5.2 |
| Spec 4 / plan 2.7 / AR9-2: `endpoints.ts` | 5.2 (no change - pass-through PIN) |
| D8 renderer: roster row "Signed up from the flyer <date>" in place of "Sent <date>" (plan 1.1: same date format) | 5.2 |
| D8 renderer: chip "Signed up" | 5.2 |
| D8 renderer: the row offers Interested / Not interested; the action gate adds `signed_up`; Request a tour stays partner-only | 5.2 |
| D8 renderer: both hosts (contact page and property page) | 5.2 (contact page host test), 5.3 (property page host test) |
| D7: an unknown contact's row on the property's Sent to card | 5.2 (unknown-row case: Not interested only), 5.3 (grouping) |
| D8 renderer: property card files `signed_up` under Interested if eligible, else Not eligible | 5.3 |
| D8: `signed_up` never waiting / not on Follow up - dashboard side | 5.2 (FollowUpView answer PIN; AR9-1). The list and the "<n> waiting" pill read the server (S3) |
| AR7-3: a missing recipient or an unknown contact reading `signed_up` files under Not eligible when ineligible / missing | 5.3 |
| AR13 (dashboard half): the `ListingSendRow.tenantName` comment; a nameless resolved recipient shows the phone label it receives; a missing one keeps the id | 5.3 (comment step 3c; PIN 1c - no logic change) |
| Spec 4: `ContactDetail.tsx`, `ListingDetail.tsx`, `FollowUpView.tsx` | Verified no outcome switch (F4); host tests in 5.2 / 5.3 |
| D8: the Matching blast keeps the tenant checked by default | No dashboard code (F10) - S3's `blastAudienceRules.ts` pin |
| Spec 5 Tests: "the dashboard row and chip read ..." / "offers Interested / Not interested" / "files it under Interested when eligible, Not eligible when not" | 5.2, 5.2, 5.3 |

## E. Notes for other slices

- Names S5 creates: the union members `'signed_up'` in `TimelineMilestoneType`
  and in `ListingSendOutcome` (dashboard `types.ts`); locals `sentWords` and
  `actionable` inside `SendRosterRow` (`Card.tsx`; `waiting` is gone). No new
  export, no new CSS class, no new design token.
- S5 relies on: S4's app activity type `signed_up` with the pin labels of plan
  1.1 and refType `unit` / refId the unitId on a shareable flyer; the
  `routes/contactTimeline.ts` mapper passing `label` / `refType` / `refId`
  through. S3's wire `outcome: 'signed_up'` on `GET /api/contacts/:id/listings-sent`,
  `GET /api/units/:id/recipients` and the outcome route's `{ row }` answer, and
  never on `GET /api/broadcasts/follow-ups`. `interestedSupported` /
  `eligible` keep their current meaning (F6).
- Files other slices also touch: `dashboard/src/api/types.ts` (S2 is not
  expected to - `PublicFlyer` lives in `publicApi.ts` - but if it does,
  re-read and apply on top). No other S5 file is named by S2. S6 owns
  `documentation/GLOSSARY.md` (the `signed_up` pin and outcome terms) and
  `e2e/support/selectors.md`.
- Watch (no change; for S6's e2e and the reviewer): the contact page's
  "Schedule a tour" dialog pre-commits the property of
  `file.listingsSent.rows[0]` (`ContactDetail.tsx:1436`, the newest `sentAt`).
  A flyer sign-up moves the pair's `sentAt` to the sign-up (D7), so the
  signed-up property becomes that default - consistent with intent.
- Accessible names / text S6's e2e can select by (accessibility-first):
  - Thread pin, shareable flyer: `getByRole('link', { name: 'Signed up from the flyer for <address> as <First Last>' })`,
    `href` `/listings/<unitId>`. Not-shareable flyer:
    `getByText('Signed up from a flyer as <First Last>')` (no link). /join:
    `getByText('Signed up on the join page as <First Last>')` (no link).
    `<address>` is `formatAddress(unit.address)` from the app (plan 1.1).
  - Contact page: `getByRole('list', { name: 'Properties sent' })` ->
    the `listitem` whose text matches `/^Signed up from the flyer /` (the date
    is `formatHeardFrom`'s label: "Today 2:14 PM" on the same day, else
    "Yesterday", else "Sep 12" (or "Sep 12, 2025" in another year) - match by
    regex, never the exact date); chip `getByText('Signed up', { exact: true })` within it;
    buttons `Mark <name> interested in <address>` (tenant only) and
    `Mark <name> not interested in <address>`. The identity link's name is the
    property's label. There is no "Sent " text in that row.
  - Property page: the "Sent to" card (`getByRole('heading', { name: /^Sent to\b/ })`
    -> its `section`), list `getByRole('list', { name: 'Interested' })` for an
    eligible recipient (`'Not eligible'` otherwise), the identity link named by
    the recipient's name, the same row text / chip / buttons as above. An
    UNKNOWN contact's row carries the kind label `Unknown` beside the name and
    offers only `Mark <name> not interested in <address>`. AR13: a nameless
    contact (an auto-captured unknown sign-up) is named by its formatted
    phone, e.g. `(470) 555-0182` - the identity link, and `<name>` in the
    button, are that phone, never the contactId.
  - The Follow up tab never lists the pair (server rule).

## 10. S6 - e2e repairs, the flyer-leads spec, docs, completion gates (Tasks 6.x)

Slice S6 is built LAST, after S1-S5 are committed (plan section 3 and AR4:
build order S1 -> S2 -> S3 -> S4 -> S5 -> S6). It edits ONLY e2e specs,
docs (selectors.md, GLOSSARY.md, the issue registry) and the mission
records; it never edits app or dashboard source, except the scratch
mutation in Task 6.2 that the builder reverts in the same task.

## A. CONTRACT ISSUES (for the planner to rule)

RULED: all three ACCEPTED as AR10 (plan section 4). Kept below for the record.

1. Ground rule 0 says every task has a real RED case. Tasks 6.3 and 6.4
   (selectors.md, GLOSSARY.md) are docs and Task 6.5 is the gates: none has
   an executable RED. Proposed ruling: docs and gates tasks are exempt; they
   are verified by their grep / ASCII checks and by the gates' own exits.
   (Task 6.1's RED is the unrepaired specs failing on the S1-S5 tree; Task
   6.2's RED is the scratch mutation.)
2. Main sync timing. AGENTS.md: sync `main` ONCE, at the final pre-handback
   step. Task 6.5 does that sync, but the mission pipeline runs an
   independent review and possibly a fix wave AFTER the build. Proposed
   ruling: Task 6.5 is the single sync; a later fix wave re-runs the five
   gates WITHOUT a second sync and reports any newer `main` drift instead of
   chasing it.
3. (For the record, no deviation.) Spec section 4 "Docs" names only lease
   terms, pets and deposit as staff only for GLOSSARY.md, but D1 also trims
   rent and accessibility. Task 6.4 documents all five; confirm.

## B. Facts the tasks rely on (verified on this worktree, main @b7959e2a + plan commit 7ac1f2e3)

Lean world and isolation
- B1. The lean seed has NO Available property: `app/src/lib/seed/lean.ts:221`
  `status: 'under_application', // byStatus` (unit-0001) and `:243`
  `status: 'occupied',` (unit-0002); `e2e/tests/dashboard-next/public-pages.spec.ts:46`
  "No seeded unit is `available`, so the spec CREATES its own shareable unit".
  Every spec here therefore creates its own property and publishes it.
- B2. Never sign up a SEEDED contact: a pin, a sent-list row and an unread
  thread would land on records other specs read.
  `e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts:80-81` "A FRESH
  contact per case - never the shared seeded tenant
  (docs/issues/inbox-specs-flaky-shared-tasha-state.md)." The new spec mints
  run-unique contacts and does NOT reseed (the lean / full profile choice
  never arises; nothing here reads the full demo profile).
- B3. The lane runs one worker, in file order, no retries:
  `e2e/playwright.config.ts:115` `const DEFAULT_TEST_TIMEOUT_MS = 60_000;`,
  `:135` `expect: { timeout: 15_000 },`, `:140` `fullyParallel: false,`,
  `:141` `workers: 1,`, `:143` `retries: 0,`.
- B4. The public endpoint's rate limit is lifted on a lane:
  `scripts/e2e-session.mjs:172` `PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX ?? '100000',`.

Setup through the real routes
- B5. dev-login: `e2e/tests/dashboard-next/property-requirements.spec.ts:75-80`
  POSTs `${NEXT}/auth/dev-login` with `{ data: { email: 'va@example.com' } }`
  through `page.request`, then `expectTodayReady(page)` (`e2e/support/today.ts`).
- B6. Contact create answers 201 `{ contact: { contactId } }` and takes
  consent and status: `property-requirements.spec.ts:127-139`
  (`status: 'searching', consent_method: 'verbal_in_person', consent_at: ...`,
  `expect(res.status(), ...).toBe(201)`).
- B7. Unit create answers 201 and publish is the transition route:
  `property-requirements.spec.ts:286-300` (POST `${NEXT}/api/units` ...
  `toBe(201)`), `:112-117` (`/listing-status`, `{ toStatus: 'available', source: 'manual' }`).
- B8. A unit create refuses an authority that is not on the list:
  `app/src/routes/units.ts:916-928` (`orgNames.checkList('accepted_authorities', ...)`,
  422 on a miss). The seeded name is `app/src/lib/seed/orgList.ts:31`
  `atlanta: 'Atlanta Housing Authority',`.
- B9. A unit holding both deposit forms is a 400: `app/src/routes/units.ts:906`
  `if (depositConflictAfter(undefined, validation.fields)) {`. The spec sets
  `deposit` + `deposit_flexible` only.
- B10. Every field the spec writes is a known unit key: `app/src/lib/unitFields.ts:62`
  `address`, `:67-69` `beds` / `baths` / `area`, `:73` `rent_min`, `:82`
  `deposit`, `:102` `listing_link`, `:137` `pet_fee`, `:139`
  `deposit_flexible`, `:143` `washer_dryer`.

Observing sends, inbox state, the thread and the sent list
- B11. Outbound proof: `e2e/fixtures/fakeTwilio.ts:201-211` `getOutboundTo(request, { to, since? })`
  (every outbound the fake received for `to`). An inbound needs the number
  registered first: `:220-231` `registerParty(request, { label, role, number })`,
  `:233-251` `sendAsParty(request, { from, body })`.
- B12. The welcome is sent IN the request: `app/src/routes/public.ts:390`
  `await sendMessage({`; `e2e/tests/flows/proof-of-send.spec.ts:17` "A
  housing-fair signup sends a welcome SMS synchronously (in-request)." So
  once the visitor sees the thank-you, a welcome (if any) is already in the
  fake's store.
- B13. Today's rule (the mutation target): `app/src/routes/public.ts:324`
  `const existing = await contacts.findByPhone(phone);` and `:329`
  `alreadyWelcomed = existing['housing_fair_welcomed'] === true;` - an
  existing contact who was never welcomed gets the welcome. A contact made by
  `POST /api/contacts` has no `housing_fair_welcomed`, so reverting D5 makes
  the spec's existing contacts receive a text.
- B14. Inbox unread through the API and the row:
  `inbox-mark-unread-header.spec.ts:100` GET `${NEXT}/api/inbox?filter=${filter}&limit=50`
  -> `rows: InboxRowWire[]` with `contactId` / `unreadCount` (`:57-63`);
  `:152` POST `${NEXT}/api/inbox/${contactId}/read`; `:179`
  `backRow.getByLabel('1 unread')`. selectors.md:20 "Inbox | a conversation row |
  `getByRole('link').filter({ hasText: <preview/name> })`".
- B15. The contact page READS every thread of the contact on mount:
  `dashboard/src/routes/contact/useMarkContactRead.ts:1-2` "marks a contact's
  comms READ while the contact page is OPEN and the tab is VISIBLE";
  `dashboard/src/routes/contact/ContactDetail.tsx:382`
  `const autoRead = useMarkContactRead(contactId);`. Unread is therefore
  asserted BEFORE the contact page is opened, and the visit is the clean-up.
- B16. The timeline region and pins: `e2e/tests/dashboard-next/contact-detail.spec.ts:260`
  `page.getByRole('region', { name: 'Communications and activity' })`;
  `dashboard/src/routes/contact/Timeline.tsx:477-478` (`case 'unit':` returns
  the path `/listings/${ms.refId}`)
  and `:490-500` MilestonePin renders the label inside a `<Link>` when the
  pin has a ref, else a plain `<span>`. The timeline API:
  `e2e/tests/dashboard-next/share-sent-outcome.spec.ts:373`
  GET `${NEXT}/api/contacts/${contactId}/timeline?kinds=milestone` ->
  `items[]` with `kind`, `type`, `refType`, `refId`, `label`.
- B17. The sent-list API carries the derived outcome:
  `app/src/routes/contacts.ts:1320-1336` `res.json({ sent: rows.map((row) => { ... const outcome = deriveListingSendOutcome({ ... }) ... outcome, ...`.
- B18. The Properties sent card and row: `dashboard/src/routes/contact/TenantFile.tsx:316-317`
  `<Card title="Properties sent"`, `:334` `<SendRosterList label="Properties sent">`;
  `dashboard/src/routes/contact/Card.tsx:361` `<span ...>Sent {sent.label}</span>`,
  `:374` aria-label `Mark ${name} interested in ${address}`, `:395`
  aria-label `Mark ${name} not interested in ${address}`. The row's
  identity link and `address` are the DASHBOARD `formatAddress`
  (`dashboard/src/routes/contact/format.ts:104-113`: line1, line2,
  "city, state", zip joined by ", " -> `<line1>, Atlanta, GA, 30314`), so the
  spec matches them by a `^<line1>` prefix.
- B19. The pin's `<address>` is the APP `formatAddress`
  (`app/src/lib/address.ts:112-126`: street, then `city, state zip` ->
  `<line1>, Atlanta, GA 30314`), one comma fewer than B18.
- B20. The row's date label: `dashboard/src/lib/heardFrom.ts:35-44`
  "Today 2:14 PM" / "Yesterday" / "Sep 12"; `dashboard/src/routes/inbox/inboxTime.ts:55`
  `plainSpaces(TIME_FMT.format(d))` (ASCII spaces).
- B21. The public form's labels: `public-pages.spec.ts:159-165`
  (`getByLabel('First name')`, `'Last name'`, `'Phone number'`,
  `getByRole('checkbox', { name: /I agree to receive/i })`); /join's button
  `Sign me up` (`:422`) and thank-you `/you're signed up/i` (`:425`); /join's
  select waits for its list: `:456` `await expect(authority).toBeEnabled();`.

The flyer and the tags today (what S2 replaces)
- B22. `dashboard/src/routes/public/FlyerPage.tsx:302`
  `<h1 className={styles.title}>{hood ?? 'A home for you'}</h1>`; `:343-345`
  the address link `target="_blank" rel="noreferrer"` with
  `<span className={styles.srOnly}> - open in Google Maps</span>`; `:459`
  `<IntakeForm onSubmit={handleIntakeSubmit} submitLabel="I'm interested" />`.
- B23. The Maps href form: `public-pages.spec.ts:228-238`
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([line1, city, state, zip].join(', '))}`.
- B24. Tags: `dashboard/src/routes/listing/FlyerTag.tsx:21-24`
  `flyerTagText` -> `'Staff only'` / `'On property flyers'` / `'On flyer'`
  (the span's whole text); `dashboard/src/routes/listing/TaggedField.tsx:16`
  `export const PUBLIC_FLYER_NOTE = 'Tenants see this on the public flyer.';`;
  `dashboard/src/routes/listing/UnitCreateForm.tsx:522` `label="Rent min"`,
  `:535` `label="Rent max"`, `:663-666` `label="Tenant-paid utilities"` ...
  `publicNote`, `:680` `label="Accessibility"` ... `publicNote`, `:693`
  `label="Lease terms"` ... `publicNote`. The landlord form renders only
  RequirementsFields tags (one tag per field, `RequirementsFields.tsx:61-120`),
  so after D2 it holds exactly two `On property flyers` spans.
- B25. `<dt>` is the ARIA role `term` in this Playwright (1.61.0):
  `node_modules/playwright-core/lib/coreBundle.js` maps `DT:()=>"term"`, so
  `getByRole('term')` lists the detail-row labels in DOM order.
- B26. `e2e/support/viewport.ts:33` `WIDE_RESTORE`, `:73`
  `expectNoHorizontalOverflow(page, where)`, `:107`
  `expectNoHorizontalOverflowIn(surface, where)`; the public shell has a
  `<main>`: `dashboard/src/routes/public/PublicLayout.tsx:15`.

Running one spec, and why a mutation needs a fresh stack
- B27. One npm hop into the e2e workspace: `e2e/README.md:191-193`
  "`npm run e2e -w @housingchoice/e2e -- --grep "<name>"` ... the root
  `npm run e2e -- --grep` form is a double hop that drops the flag and runs
  EVERYTHING". Root `package.json:41` `"e2e": "npm run e2e -w @housingchoice/e2e",`;
  `e2e/package.json:7` `"e2e": "playwright test",`. A spec PATH after `--`
  reaches Playwright the same way.
- B28. The app runs under tsx, loaded once at boot (no watch):
  `scripts/e2e-session.mjs:460` `spawnNode('app', ['--import', 'tsx', path.join('app', 'src', 'index.ts')]);`.
  AGENTS.md: `reuseExistingServer` adopts a running stack on a COMMIT match
  alone - an uncommitted scratch edit does not change the commit, so a live
  session would run the UNMUTATED code. Task 6.2 therefore proves no stack is
  up before the mutation run.

Existing assertions this change breaks (S6 repairs them)
- B29. `public-pages.spec.ts:217` `page.getByRole('heading', { name: new RegExp(unit.area) })`
  (the h1 is now the address); `:219` the rent fact; `:239-240` Deposit;
  `:244-249` Pets / Accessibility / Lease terms; `:285`
  `page.getByRole('button', { name: /I'm interested/i })`.
- B30. `listing-photos.spec.ts:242` `page.getByRole('button', { name: /I'm interested/i })`.
- B31. `property-requirements.spec.ts:262` `Pet fee` ... `toHaveAccessibleDescription(/On flyer/)`;
  `:383` the flyer's deposit row; `:386` `getByText('No pets', { exact: true })).toBeVisible()`;
  `:406-417` the flyer JSON `toMatchObject({ no_pets: true, pets: null, ... deposit: null, ...`.
- B32. `contact-detail.spec.ts:187` `Pet fee` ... `toHaveAccessibleDescription(/On property flyers/)`.
- B33. A grep of `e2e/tests` and `e2e/scenarios` for `A home for you`,
  `I'm interested`, `Interested in this home`, `team member will`,
  `Share your info`, `On flyer/)`, `On property flyers/)`, the trimmed flyer
  rows and rent on the flyer finds only B29-B32 plus comments (public-pages
  `:7`, `:14`) and the `?cta=text` prefill regex (`:350`, unchanged). No
  e2e path signs up an EXISTING contact and expects a welcome:
  `scenarios/steps.ts:609` (tenantSelfServes) is only called first in
  `tests/scenarios/tenant-onboarding.spec.ts:186` on a fresh tenant; the
  other housing-fair posts (`a2p-compliance.spec.ts:156-172`,
  `settings.spec.ts:112`, `flows/proof-of-send.spec.ts:23`) use fresh
  phones. Every spec that counts unread rows lane-wide reseeds first
  (`call-inbox-unread.spec.ts:109-110`, `inbox-nav-badge.spec.ts:202-206`,
  `inbox-mark-unread-header.spec.ts:129-131`); the others assert one named
  row. So new sign-ups leaving an unread row (Cameron's D6 call) break no
  existing spec.

Records and git
- B34. Mission records: `docs/superpowers/reviews/2026-10-21-flyer-leads/`
  (exists: `intent.md`, `design-review/`). Gate logs go to the gitignored
  `.superpowers/sdd/gates/`.
- B35. `git rev-parse --git-dir` from the worktree:
  `W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads`;
  `git merge-tree --write-tree` is available (git 2.56.0.windows.2).

## C. Commands used by every task (exact; Git Bash = the Bash tool; every command starts with an explicit `cd`)

C1. Logs directory (once):

```bash
mkdir -p "W:/tmp/flyer-leads/.superpowers/sdd/gates"
```

C2. No e2e stack is up for this worktree (before EVERY e2e run):

```bash
cd "W:/tmp/flyer-leads" && test -f e2e/.artifacts/session.pid && echo "SESSION_PID $(cat e2e/.artifacts/session.pid)" || echo no-session-pid
```

If a pid prints and that process is alive (`MSYS_NO_PATHCONV=1 tasklist /FI "PID eq <pid>"`):
when it is a session THIS builder started, `cd "W:/tmp/flyer-leads" && npm run e2e:stop`;
otherwise STOP and report (never stop another agent's session). Then the
lane's ports must be free:

```bash
cd "W:/tmp/flyer-leads" && test -f e2e/.artifacts/lane.json && node -e "const l=require('./e2e/.artifacts/lane.json');console.log(Object.values(l.ports).join(' '))"
```

```bash
netstat -ano | grep LISTENING | grep -E ":(P1|P2|P3|P4) "
```

(replace P1-P4 with the four printed ports; a diagnostic, so the pipe is
fine). Expected: no output. Never touch `:5174` / `:8080`.

C3. Run named spec files through the e2e workspace (one hop; Playwright
cold-boots the hermetic stack and tears it down). Run it in the BACKGROUND
(Bash tool `run_in_background: true`), wait for the completion notice, do
not poll, and never edit source or commit while it runs:

```bash
cd "W:/tmp/flyer-leads" && timeout 1500 npm run e2e -w @housingchoice/e2e -- <spec paths, space-separated> > .superpowers/sdd/gates/<log name>.log 2>&1
```

Never the root `npm run e2e -- ...` form for a subset (B27). The exit code
is the tool's own (no `; echo`). Exit 124 = the cap fired: run
`cd "W:/tmp/flyer-leads" && npm run e2e:stop`, then C2's port check. Read the
result afterwards:

```bash
grep -nE "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^\s+[0-9]+\) |Error: |Expected|Received" "W:/tmp/flyer-leads/.superpowers/sdd/gates/<log name>.log"
```

On a failure, FIRST copy `e2e/.artifacts/test-results` to
`.superpowers/sdd/gates/<log name>-results/` (a re-run overwrites it).

C4. Quick static checks before any e2e run:

```bash
cd "W:/tmp/flyer-leads" && npm run typecheck -w @housingchoice/e2e
```

```bash
cd "W:/tmp/flyer-leads" && npx eslint <the .ts spec paths this task touched>
```

Expected: both exit 0.

C5. ASCII. A NEW file:

```bash
tr -d '\11\12\15\40-\176' < "W:/tmp/flyer-leads/<FILE>" | wc -c
```

A pre-existing file (only ADDED lines must be ASCII - contact-detail.spec.ts,
selectors.md and GLOSSARY.md already carry non-ASCII):

```bash
git -C "W:/tmp/flyer-leads" diff -U0 -- <FILE> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: `0` each. Also `grep -n '\\u' <FILE>` on any file written with the
Write/Edit tools: no NEW hit (those tools decode `\u` escapes).

C6. Commit (never while an e2e run is live). First, as SEPARATE commands:

```bash
git -C "W:/tmp/flyer-leads" status
```

```bash
test -f "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD" && echo MERGE_IN_PROGRESS || echo no-merge
```

Read both: only this task's paths modified/new, and `no-merge` (except Task
6.5's own merge). Then explicit paths only (never `git add -A`):

```bash
git -C "W:/tmp/flyer-leads" add <paths>
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Commit messages are ASCII and use repeated `-m` arguments as above (plan
section 0, R1 #15); a longer message may instead come from a message file
OUTSIDE the worktree (e.g. the session scratchpad) with `-F <path>` - never
a file inside the worktree, which would show in `git status`.

## Task 6.1 - Repair the existing e2e assertions the change breaks

Goal: public-pages, listing-photos, property-requirements and contact-detail
assert the NEW truth (spec D1-D3, plan 1.1): the h1 is the address, the
area is the line under it, the flyer's sign-up button is `Sign up`, the
trimmed rows are gone, and Pets / Deposit / Rent / Accessibility / Lease
terms are tagged Staff only. Nothing else in those specs changes.

Files:
- Modify: `e2e/tests/dashboard-next/public-pages.spec.ts`
- Modify: `e2e/tests/dashboard-next/listing-photos.spec.ts`
- Modify: `e2e/tests/dashboard-next/property-requirements.spec.ts`
- Modify: `e2e/tests/dashboard-next/contact-detail.spec.ts`

Step 1 (RED). With S1-S5 committed and the four specs UNCHANGED, run them
(C2 first, then C3):

```bash
cd "W:/tmp/flyer-leads" && timeout 1500 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/public-pages.spec.ts tests/dashboard-next/listing-photos.spec.ts tests/dashboard-next/property-requirements.spec.ts tests/dashboard-next/contact-detail.spec.ts > .superpowers/sdd/gates/s6-repairs-red.log 2>&1
```

Expected: non-zero exit, `5 failed`, `15 passed` (20 tests), failing exactly at:
- `public-pages.spec.ts:217` (the area heading - the h1 is the address now);
- `public-pages.spec.ts:285` (no `I'm interested` button);
- `listing-photos.spec.ts:242` (no `I'm interested` button);
- `property-requirements.spec.ts:262` (Pet fee's description reads `Staff only`);
- `contact-detail.spec.ts:187` (Pet fee's description reads `Staff only`).
Any OTHER failure: if it is a stale assertion about the trimmed flyer or the
tags, repair it here and say so in the slice report; otherwise diagnose and
report (a named-spec failure is a regression, never a flake).

Also confirm the grep inventory (B33) is still complete on the built tree:

```bash
cd "W:/tmp/flyer-leads" && grep -rnE "A home for you|I'm interested|Interested in this home|team member will|Share your info|On flyer/\)|On property flyers/\)" e2e/tests e2e/scenarios
```

Expected hits only: public-pages.spec.ts `:7`, `:14` (comments), `:285`;
listing-photos.spec.ts `:242`; property-requirements.spec.ts `:262`;
contact-detail.spec.ts `:187`.

Step 2 (edits). Apply each edit with the Edit tool; the quoted text is the
anchor (old_string), replace it with the new text exactly.

2a. `public-pages.spec.ts` - the header's point 1. Old:

```ts
//   1. Full info is public with NO gate - address/deposit/fee/utilities/pets/
//      accessibility/lease-terms/RTA/video all render upfront; the intake form is
//      present; no login redirect. Plus a raw flyer-API sanity check (contact_number).
//      The address is a Google Maps link - href only, never clicked (it leaves the app).
```

New:

```ts
//   1. Full info is public with NO gate - the address heading (a Google Maps
//      link - href only, never clicked: it leaves the app), the area, beds and
//      the fee/utilities/RTA/video rows all render upfront; the intake form is
//      present; no login redirect. Plus a raw flyer-API sanity check
//      (contact_number). Rent, deposit, pets, accessibility and lease terms are
//      staff only since flyer-leads (2026-10-21): flyer-leads.spec.ts proves
//      them absent.
```

2b. `public-pages.spec.ts` - the key facts. Old:

```ts
    // Key facts: neighborhood heading + beds + rent.
    await expect(page.getByRole('heading', { name: new RegExp(unit.area) })).toBeVisible();
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();
    await expect(page.getByText(`$${unit.rent}`, { exact: false }).first()).toBeVisible();
```

New:

```ts
    // Key facts (flyer-leads D3): the ADDRESS is the heading, the neighborhood
    // is the line under it, then beds. Rent is staff only now.
    await expect(page.getByRole('heading', { level: 1, name: unit.addressLine1 })).toBeVisible();
    await expect(page.getByText(unit.area, { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();
```

2c. `public-pages.spec.ts` - delete the Deposit pair. Old:

```ts
    await expect(page.getByText('Deposit')).toBeVisible();
    await expect(page.getByText(`$${unit.deposit}`)).toBeVisible();
    await expect(page.getByText('Application fee')).toBeVisible();
```

New:

```ts
    await expect(page.getByText('Application fee')).toBeVisible();
```

2d. `public-pages.spec.ts` - delete the Pets / Accessibility / Lease rows. Old:

```ts
    await expect(page.getByText(unit.utilities)).toBeVisible();
    await expect(page.getByText('Pets')).toBeVisible();
    await expect(page.getByText(unit.pets)).toBeVisible();
    await expect(page.getByText('Accessibility')).toBeVisible();
    await expect(page.getByText(unit.accessibility)).toBeVisible();
    await expect(page.getByText('Lease terms')).toBeVisible();
    await expect(page.getByText(unit.leaseTerms)).toBeVisible();
    await expect(page.getByText('Same-day RTA')).toBeVisible();
```

New:

```ts
    await expect(page.getByText(unit.utilities)).toBeVisible();
    await expect(page.getByText('Same-day RTA')).toBeVisible();
```

(The unit is still CREATED with rent, deposit, pets, accessibility and lease
terms - `createShareableUnit` is unchanged - so those `ShareableUnit` fields
stay used and the staff record stays realistic.)

2e. `public-pages.spec.ts` - the flyer's submit button. Old:

```ts
    await page.getByRole('button', { name: /I'm interested/i }).click();
```

New:

```ts
    // flyer-leads D3: the bare-link flyer's sign-up button reads "Sign up".
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
```

2f. `listing-photos.spec.ts`. Old:

```ts
    await expect(page.getByRole('button', { name: /I'm interested/i })).toBeVisible();
```

New:

```ts
    // flyer-leads D3: the bare-link flyer's sign-up button reads "Sign up".
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();
```

2g. `property-requirements.spec.ts` - the header's points 3 and 4. Old:

```ts
//      unchecked; checked and updated, its flyer reads "No pets", never
//      "No pets (Cats OK)" (Cameron's O1);
//   4. that flyer shows the public items and none of the staff-only ones (D11);
```

New:

```ts
//      unchecked; checked and updated, it records "No pets" with no details,
//      never "No pets (Cats OK)" (Cameron's O1);
//   4. that flyer shows the public items and none of the staff-only ones (D11;
//      since flyer-leads, 2026-10-21, rent, accessibility, lease terms, pets
//      and deposit are staff only too, and the New form's tags say so);
```

2h. `property-requirements.spec.ts` - a second never-on-flyer list. Old:

```ts
  'notes',
  'requirement_sources',
] as const;
```

New:

```ts
  'notes',
  'requirement_sources',
] as const;

/** Keys flyer-leads D1 (2026-10-21) removed from the public flyer projection:
 *  they stay on the property, staff only. */
const TRIMMED_FROM_FLYER = [
  'rent_min',
  'rent_max',
  'lease_terms',
  'accessibility',
  'pets',
  'no_pets',
  'pet_fee',
  'deposit',
  'deposit_one_month',
  'deposit_flexible',
] as const;
```

2i. `property-requirements.spec.ts` - the New form's tags. Old:

```ts
      await expect(dialog.getByLabel('Credit score', { exact: true })).toHaveAccessibleDescription(/Staff only/);
      await expect(dialog.getByLabel('Pet fee', { exact: true })).toHaveAccessibleDescription(/On flyer/);
      await expect(dialog.getByLabel('Subzone', { exact: true })).toHaveAccessibleDescription(/Staff only/);
```

New:

```ts
      await expect(dialog.getByLabel('Credit score', { exact: true })).toHaveAccessibleDescription(/Staff only/);
      await expect(dialog.getByLabel('Subzone', { exact: true })).toHaveAccessibleDescription(/Staff only/);
      // flyer-leads D2 (2026-10-21): rent, accessibility, lease terms and every
      // field of the Pets and Deposit items are Staff only; the application fee
      // pair and tenant-paid utilities stay On flyer.
      for (const label of [
        'Rent min',
        'Rent max',
        'Accessibility',
        'Lease terms',
        'No pets',
        'Pets (details)',
        'Pet fee',
        "One month's rent",
        'Fixed amount',
        'Flexible / payment terms available',
      ]) {
        await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/Staff only/);
      }
      for (const label of ['No application fee', 'Application fee', 'Tenant-paid utilities']) {
        await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/On flyer/);
      }
      // D2: the public note shows only under an On flyer field - on this form,
      // Tenant-paid utilities alone (never under a Staff only field).
      await expect(dialog.getByText('Tenants see this on the public flyer.', { exact: true })).toHaveCount(1);
```

2j. `property-requirements.spec.ts` - step 4, C's flyer. Old:

```ts
  // --- 4. C's flyer. The deposit row exists only since Apply, so it proves
  // this load carries the applied values before the absences are read. ---
  await page.goto(`${NEXT}/p/${unitC}`);
  await expect(page.getByText("One month's rent, flexible / payment plan available", { exact: true })).toBeVisible();
  // O1: "No pets", never "No pets (Cats OK)" - the details were copied too.
  await expect(page.getByText('Cats OK')).toHaveCount(0);
  await expect(page.getByText('No pets', { exact: true })).toBeVisible();
  await expect(page.getByText('No application fee', { exact: true })).toBeVisible();
  await expect(page.getByText('Fits a 2- or 3-bedroom voucher')).toBeVisible();
  await expect(page.getByText('Hookups', { exact: true })).toBeVisible();
```

New:

```ts
  // --- 4. C's flyer. C was created with no application fee, so the "No
  // application fee" row exists only since Apply: it proves this load carries
  // the applied values before the absences are read. Pets and Deposit are
  // staff only since flyer-leads (D1/D2, 2026-10-21), so neither the copied
  // "No pets" nor the deposit reaches the flyer; step 5 reads them on the
  // property. ---
  await page.goto(`${NEXT}/p/${unitC}`);
  await expect(page.getByText('No application fee', { exact: true })).toBeVisible();
  await expect(page.getByText('Fits a 2- or 3-bedroom voucher')).toBeVisible();
  await expect(page.getByText('Hookups', { exact: true })).toBeVisible();
  for (const gone of ['Pets', 'No pets', 'Pet fee', 'Deposit', "One month's rent, flexible / payment plan available"]) {
    await expect(page.getByText(gone, { exact: true }), gone).toHaveCount(0);
  }
  await expect(page.getByText('Cats OK')).toHaveCount(0);
```

2k. `property-requirements.spec.ts` - the flyer JSON. Old:

```ts
  expect(flyer).toMatchObject({
    no_pets: true,
    pets: null,
    pet_fee: null,
    deposit_one_month: true,
    deposit_flexible: true,
    deposit: null,
    application_fee: 0,
    washer_dryer: 'hookups',
    voucher_sizes: [2, 3],
    voucher_size: 2,
  });
  for (const key of NEVER_ON_FLYER) expect(Object.keys(flyer), key).not.toContain(key);
```

New:

```ts
  expect(flyer).toMatchObject({
    application_fee: 0,
    washer_dryer: 'hookups',
    voucher_sizes: [2, 3],
    voucher_size: 2,
  });
  for (const key of [...NEVER_ON_FLYER, ...TRIMMED_FROM_FLYER]) expect(Object.keys(flyer), key).not.toContain(key);
```

2l. `property-requirements.spec.ts` - step 5, O1 on the record. Old:

```ts
  expect('pets' in appliedC).toBe(false);
```

New:

```ts
  expect('pets' in appliedC).toBe(false);
  // O1, on the record now that pets are staff only (flyer-leads D1): the
  // copied item is "No pets" with no details, and the deposit was copied too.
  expect(appliedC['no_pets']).toBe(true);
  expect(appliedC['deposit_one_month']).toBe(true);
```

2m. `contact-detail.spec.ts` - the landlord form's tags. Old:

```ts
    await expect(dialog.getByLabel('Pet fee', { exact: true })).toHaveAccessibleDescription(/On property flyers/);
    await expect(dialog.getByLabel('Credit score', { exact: true })).toHaveAccessibleDescription(/Staff only/);
```

New:

```ts
    // flyer-leads D2 (2026-10-21): only the application fee pair still
    // reaches a property's flyer; every Pets and Deposit field is Staff only.
    await expect(dialog.getByText('On property flyers', { exact: true })).toHaveCount(2);
    for (const label of ['No application fee', 'Application fee']) {
      await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/On property flyers/);
    }
    for (const label of [
      'Credit score',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]) {
      await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/Staff only/);
    }
```

Step 3 (GREEN). C4 on the four files, C2, then:

```bash
cd "W:/tmp/flyer-leads" && timeout 1500 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/public-pages.spec.ts tests/dashboard-next/listing-photos.spec.ts tests/dashboard-next/property-requirements.spec.ts tests/dashboard-next/contact-detail.spec.ts > .superpowers/sdd/gates/s6-repairs-green.log 2>&1
```

Expected: exit 0, `20 passed`. Re-run Step 1's grep: the only hits left are
public-pages.spec.ts `:7` and `:14` (comments about the old funnel and the
`?cta=text` link) and the `/On flyer/` / `/On property flyers/` lines inside
the new loops.

Step 4. C5 on the four files (contact-detail.spec.ts with the diff form;
the other three are ASCII files today, so either form).

Step 5. C6, then:

```bash
git -C "W:/tmp/flyer-leads" add e2e/tests/dashboard-next/public-pages.spec.ts e2e/tests/dashboard-next/listing-photos.spec.ts e2e/tests/dashboard-next/property-requirements.spec.ts e2e/tests/dashboard-next/contact-detail.spec.ts
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "test(e2e): repair flyer and tag assertions for flyer-leads (address heading, Sign up, staff-only rows and tags)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6.2 - The new spec `e2e/tests/dashboard-next/flyer-leads.spec.ts`, proven by a mutation

Goal: spec section 5 "e2e" end to end: (1) the new flyer layout and none of
the removed rows; (2) an EXISTING tenant's flyer sign-up - no text, unread
inbox row, the pin, and the Signed up row on Properties sent; (3) an
EXISTING contact on /join - pin and unread, no text; plus (4) a NEW
contact's flyer sign-up - welcome, then pin, unread and the Signed up entry
(the positive control for the "no text" observation, and Cameron's
2026-10-21 "new sign-ups unread too"). The RED is a scratch revert of D5.

Files:
- Create: `e2e/tests/dashboard-next/flyer-leads.spec.ts`
- Create: `docs/superpowers/reviews/2026-10-21-flyer-leads/S6-mutation-check.md`
- Scratch only (reverted in this task): `app/src/routes/public.ts`

Step 1. Write the spec, exactly:

```ts
// e2e/tests/dashboard-next/flyer-leads.spec.ts
//
// Flyer trim and flyer / join leads (design
// docs/superpowers/specs/2026-10-21-flyer-leads-design.md, section 5 "e2e";
// Sam's 2026-10-21 feedback and Improvements Tracker #13), end to end against
// the real backend:
//   1. the flyer's new layout (D1, D3): the address is the page heading and a
//      Google Maps link, the area is the line under it, "Same-day tours
//      available" shows, the detail rows are Application fee / Tenant pays /
//      Washer / dryer / Same-day RTA / Video tour / Listing in that order, and
//      no rent, deposit, pets, pet fee, accessibility, lease terms or address
//      row renders - nor reaches the public JSON - although the property
//      records every one of them; the sign-up box asks for alerts, not a
//      tour; nothing overflows at 320px;
//   2. an EXISTING tenant signing up from the flyer (D4-D8): no text goes out,
//      the inbox row is unread, the thread shows the sign-up pin with the
//      TYPED name (the contact keeps its own), and the property is on the
//      Properties sent card reading "Signed up from the flyer <date>" with the
//      "Signed up" chip and the waiting row's actions;
//   3. an EXISTING contact - a landlord with no thread yet - on /join (D4-D6):
//      the join pin and the unread mark, no text, the contact unchanged;
//   4. a NEW contact on the flyer (D5, D6 - Cameron 2026-10-21): the welcome
//      is sent, then the pin, the unread mark and the Signed up entry.
//
// ISOLATION: every record is RUN-UNIQUE and made through the real routes.
// The lean world has no Available property (app/src/lib/seed/lean.ts:
// unit-0001 is under_application, unit-0002 occupied), and a sign-up from a
// SEEDED contact would leave a pin, a sent-list row and an unread thread on
// records other specs read (docs/issues/inbox-specs-flaky-shared-tasha-state.md).
// Nothing is reseeded. Every case leaves its threads READ, so no later spec
// inherits an unread row.
//
// ORDER MATTERS on the inbox checks: the contact page marks every thread of
// the contact read on mount (dashboard useMarkContactRead), so unread is
// asserted on /inbox and through the API BEFORE the contact page is opened -
// and that visit is then the clean-up.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT, a local
// devLogin, raw page.request for setup, accessibility-first locators. The
// public visitor is a SEPARATE browser context with no session.
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';
import { WIDE_RESTORE, expectNoHorizontalOverflow, expectNoHorizontalOverflowIn } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
/** A seeded housing authority NAME (app/src/lib/seed/orgList.ts); a unit
 *  create refuses an authority that is not on the list. */
const ATLANTA = 'Atlanta Housing Authority';
const CITY = 'Atlanta';
const STATE = 'GA';
const ZIP = '30314';
/** The flyer heading's second line for that address (plan 1.1). */
const CITY_LINE = `${CITY}, ${STATE} ${ZIP}`;
/** The ten keys flyer-leads D1 removes from the public flyer payload. */
const TRIMMED_KEYS = [
  'rent_min',
  'rent_max',
  'lease_terms',
  'accessibility',
  'pets',
  'no_pets',
  'pet_fee',
  'deposit',
  'deposit_one_month',
  'deposit_flexible',
] as const;
/** What every property here records but the flyer must never show (D1). */
const STAFF_ONLY = {
  rent: 1725,
  deposit: 1500,
  pets: 'Cats only',
  petFee: '$300',
  accessibility: 'Ground floor',
  leaseTerms: '12-month minimum',
} as const;

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

interface Person {
  contactId: string;
  phone: string;
  firstName: string;
  lastName: string;
  /** The display name the dashboard shows: "First Last". */
  name: string;
}

/** A contact through the real create route; `consent` records verbal
 *  consent, as a staff-entered tenant carries it. */
async function createContact(
  api: APIRequestContext,
  opts: { type: 'tenant' | 'landlord'; firstName: string; lastName: string; status?: string; consent?: boolean },
): Promise<Person> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: opts.type,
      firstName: opts.firstName,
      lastName: opts.lastName,
      phone,
      ...(opts.status !== undefined && { status: opts.status }),
      ...(opts.consent === true && { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return {
    contactId: contact.contactId,
    phone,
    firstName: opts.firstName,
    lastName: opts.lastName,
    name: `${opts.firstName} ${opts.lastName}`,
  };
}

async function getContact(api: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

async function getUnit(api: APIRequestContext, unitId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: Record<string, unknown> }).unit;
}

interface FlyerUnit {
  unitId: string;
  line1: string;
  area: string;
  videoUrl: string;
  listingUrl: string;
}

/** An AVAILABLE (shareable) property holding every public field AND every
 *  field D1 took off the flyer. Create lands in setup; status moves only
 *  through the listing-status transition. */
async function createAvailableUnit(
  api: APIRequestContext,
  opts: { landlordId: string; line1: string; area: string; stamp: string },
): Promise<FlyerUnit> {
  const videoUrl = `https://tours.example.com/flyer-leads-${opts.stamp}`;
  const listingUrl = `https://listings.example.com/flyer-leads-${opts.stamp}`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: opts.landlordId,
      accepted_authorities: [ATLANTA],
      beds: 2,
      baths: 1,
      area: opts.area,
      address: { line1: opts.line1, city: CITY, state: STATE, zip: ZIP },
      application_fee: 45,
      utilities: 'Electric and gas',
      washer_dryer: 'hookups',
      same_day_rta: true,
      video_url: videoUrl,
      listing_link: listingUrl,
      // Staff only since flyer-leads D1/D2: recorded, never published.
      rent_min: STAFF_ONLY.rent,
      rent_max: STAFF_ONLY.rent,
      deposit: STAFF_ONLY.deposit,
      deposit_flexible: true,
      pets: STAFF_ONLY.pets,
      pet_fee: STAFF_ONLY.petFee,
      accessibility: STAFF_ONLY.accessibility,
      lease_terms: STAFF_ONLY.leaseTerms,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const published = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  return { unitId, line1: opts.line1, area: opts.area, videoUrl, listingUrl };
}

/** A public visitor: a fresh browser context with no session or cookies. */
async function openVisitor(browser: Browser): Promise<{ visitor: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  return { visitor, close: () => context.close() };
}

/** Fill the public sign-up form (the flyer's and /join's share these fields). */
async function fillSignUp(visitor: Page, p: { firstName: string; lastName: string; phone: string }): Promise<void> {
  await visitor.getByLabel('First name').fill(p.firstName);
  await visitor.getByLabel('Last name').fill(p.lastName);
  await visitor.getByLabel('Phone number').fill(p.phone);
  // A2P/CTIA: the consent box is required and starts unchecked.
  await visitor.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

/** The contact's unread count as the SERVER sees it (0 when the row is absent
 *  from the unread feed), so a green UI check can never be an optimistic patch. */
async function serverUnread(api: APIRequestContext, contactId: string): Promise<number> {
  const res = await api.get(`${NEXT}/api/inbox?filter=unread&limit=100`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { rows } = (await res.json()) as { rows: Array<{ contactId?: string; unreadCount: number }> };
  return rows.find((r) => r.contactId === contactId)?.unreadCount ?? 0;
}

/** The contact's signed_up pins, each as "label|refType|refId" ('' for an absent ref). */
async function signedUpPins(api: APIRequestContext, contactId: string): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/timeline?kinds=milestone`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { items } = (await res.json()) as {
    items: Array<{ kind: string; type?: string; refType?: string; refId?: string; label?: string }>;
  };
  return items
    .filter((i) => i.kind === 'milestone' && i.type === 'signed_up')
    .map((i) => `${i.label ?? ''}|${i.refType ?? ''}|${i.refId ?? ''}`);
}

/** The derived send outcome of the (unit, contact) pair on the contact's sent list. */
async function sentOutcome(api: APIRequestContext, contactId: string, unitId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/listings-sent`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { sent } = (await res.json()) as { sent: Array<{ unitId: string; outcome?: string }> };
  return sent.find((s) => s.unitId === unitId)?.outcome;
}

/** The contact a public sign-up created, found by its phone. */
async function contactIdByPhone(api: APIRequestContext, phone: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        id = ((await res.json()) as { contacts: Array<{ contactId: string }> }).contacts[0]?.contactId;
        return id !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return id!;
}

test('the flyer: the address heading links to Maps, the area sits under it, Same-day tours available, and no staff-only row or key', async ({
  page,
  browser,
  request,
}) => {
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Layout' });
  // A street line long enough to wrap at 320px (D3).
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Martin Luther King Jr Drive Southwest`,
    area: `Flyerhood ${stamp}`,
    stamp,
  });

  // D1: off the flyer, NOT out of the system - the property keeps every value.
  expect(await getUnit(api, unit.unitId)).toMatchObject({
    rent_min: STAFF_ONLY.rent,
    rent_max: STAFF_ONLY.rent,
    deposit: STAFF_ONLY.deposit,
    deposit_flexible: true,
    pets: STAFF_ONLY.pets,
    pet_fee: STAFF_ONLY.petFee,
    accessibility: STAFF_ONLY.accessibility,
    lease_terms: STAFF_ONLY.leaseTerms,
  });

  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);

  // D3 item 2: the street line is the one h1, INSIDE the Google Maps link; the
  // city line is the link's second line; the sr-only suffix ends its name.
  const mapsLink = visitor.getByRole('link', { name: /open in Google Maps$/ });
  const heading = mapsLink.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(unit.line1);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(mapsLink).toHaveAccessibleName(new RegExp(`^${unit.line1}`));
  await expect(mapsLink.getByText(CITY_LINE, { exact: true })).toBeVisible();
  await expect(mapsLink).toHaveAttribute(
    'href',
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([unit.line1, CITY, STATE, ZIP].join(', '))}`,
  );
  await expect(mapsLink).toHaveAttribute('target', '_blank');
  await expect(mapsLink).toHaveAttribute('rel', 'noreferrer');

  // D3 item 3: the area is the line under the heading, never the heading.
  await expect(visitor.getByText(unit.area, { exact: true })).toBeVisible();
  // D3 item 4: static copy on every flyer - not the per-property Same-day RTA row.
  await expect(visitor.getByText('Same-day tours available', { exact: true })).toBeVisible();
  // D3 items 5-6: beds, baths and the voucher phrase (no rent fact), then the
  // authority line (wording unchanged).
  await expect(visitor.getByText(/^2\s*beds$/)).toBeVisible();
  await expect(visitor.getByText(/^1\s*bath$/)).toBeVisible();
  await expect(visitor.getByText('Fits a 2-bedroom voucher')).toBeVisible();
  await expect(visitor.getByText(`Accepts: ${ATLANTA}`, { exact: true })).toBeVisible();
  // D3 item 7: the detail rows, in this order, each because it is recorded.
  await expect(visitor.getByRole('term')).toHaveText([
    'Application fee',
    'Tenant pays',
    'Washer / dryer',
    'Same-day RTA',
    'Video tour',
    'Listing',
  ]);
  await expect(visitor.getByText('$45', { exact: true })).toBeVisible();
  await expect(visitor.getByText('Electric and gas', { exact: true })).toBeVisible();
  await expect(visitor.getByText('Hookups', { exact: true })).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Watch the tour' })).toHaveAttribute('href', unit.videoUrl);
  await expect(visitor.getByRole('link', { name: 'See the full listing' })).toHaveAttribute('href', unit.listingUrl);

  // Gone, although the property records each (D1; D3 item 7) - asserted after
  // the positive checks on this same load.
  for (const gone of [
    'Address',
    'Deposit',
    'Pets',
    'Pet fee',
    'Accessibility',
    'Lease terms',
    STAFF_ONLY.pets,
    STAFF_ONLY.petFee,
    STAFF_ONLY.accessibility,
    STAFF_ONLY.leaseTerms,
    'A home for you',
    'Home for rent',
    'Interested in this home?',
  ]) {
    await expect(visitor.getByText(gone, { exact: true }), gone).toHaveCount(0);
  }
  // The rent ($1,725 and "/mo"), the deposit ($1,500, "payment plan") and the
  // old "a team member will..." promise.
  await expect(visitor.getByText(/\$1,?725|\/mo\b|\$1,?500|payment plan|team member/i)).toHaveCount(0);

  // D1: the public JSON carries none of the ten keys (absent, not null).
  const flyerRes = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
  expect(flyerRes.ok(), await flyerRes.text()).toBeTruthy();
  const { flyer } = (await flyerRes.json()) as { flyer: Record<string, unknown> };
  expect(flyer['application_fee']).toBe(45);
  for (const key of TRIMMED_KEYS) expect(Object.keys(flyer), key).not.toContain(key);

  // D3 item 8: the sign-up box asks for alerts and says it books no tour.
  await expect(visitor.getByRole('heading', { name: 'Sign up for home alerts', exact: true })).toBeVisible();
  await expect(
    visitor.getByText(
      "We'll text you about this home and others that fit your voucher. Signing up does not book a tour.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();

  // D3: at 320px the heading wraps and nothing overflows its card; the whole
  // heading block is the tap target (the link's box holds the h1's).
  await visitor.setViewportSize({ width: 320, height: 800 });
  await expect(heading).toBeVisible();
  await expectNoHorizontalOverflow(visitor, 'the flyer at 320px');
  await expectNoHorizontalOverflowIn(
    visitor.locator('section').filter({ has: visitor.getByRole('heading', { level: 1 }) }),
    'the flyer card at 320px',
  );
  await expectNoHorizontalOverflowIn(heading, 'the address heading at 320px');
  const linkBox = await mapsLink.boundingBox();
  const headingBox = await heading.boundingBox();
  if (linkBox === null || headingBox === null) throw new Error('the heading link or the heading has no box');
  expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(320 + 1);
  expect(headingBox.x).toBeGreaterThanOrEqual(linkBox.x - 1);
  expect(headingBox.y).toBeGreaterThanOrEqual(linkBox.y - 1);
  expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width + 1);
  expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(linkBox.y + linkBox.height + 1);
  await visitor.setViewportSize(WIDE_RESTORE);
  await close();
});

test('an existing tenant signs up from the flyer: no text, an unread inbox row, the pin, and a Signed up row on Properties sent', async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // an inbound, a public sign-up, the inbox and the contact page
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Existing' });
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Existing Way`,
    area: `Existhood ${stamp}`,
    stamp,
  });
  const tenant = await createContact(api, {
    type: 'tenant',
    firstName: `Flyerexist${stamp}`,
    lastName: 'Tenant',
    status: 'searching',
    consent: true,
  });

  // An ongoing conversation: the tenant texted in earlier and staff read it.
  const inbound = `Still looking for a 2 bedroom ${stamp}`;
  await registerParty(request, { label: tenant.name, role: 'tenant', number: tenant.phone });
  await sendAsParty(request, { from: tenant.phone, body: inbound });
  await expect
    .poll(() => serverUnread(api, tenant.contactId), {
      timeout: 20_000,
      message: 'the inbound never made the thread unread',
    })
    .toBe(1);
  const read = await api.post(`${NEXT}/api/inbox/${tenant.contactId}/read`);
  expect(read.ok(), await read.text()).toBeTruthy();
  await expect.poll(() => serverUnread(api, tenant.contactId)).toBe(0);
  expect(await getOutboundTo(request, { to: tenant.phone })).toHaveLength(0);

  // The sign-up: a visitor with no session, under a name of their own (D6
  // pins the TYPED name; D4 never renames the contact).
  const typed = { firstName: `Typed${stamp}`, lastName: 'Signup' };
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);
  await fillSignUp(visitor, { ...typed, phone: tenant.phone });
  await visitor.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(visitor.getByRole('heading', { name: /you're all set/i })).toBeVisible();
  await expect(
    visitor.getByText("We'll text you about this home and others that fit your voucher.", { exact: true }),
  ).toBeVisible();
  await close();

  // Server truth (D6-D8): ONE pin with the unit ref, the thread unread, the pair signed_up.
  const pinLabel = `Signed up from the flyer for ${unit.line1}, ${CITY_LINE} as ${typed.firstName} ${typed.lastName}`;
  await expect
    .poll(() => signedUpPins(api, tenant.contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}|unit|${unit.unitId}`]);
  await expect.poll(() => serverUnread(api, tenant.contactId), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => sentOutcome(api, tenant.contactId, unit.unitId), { timeout: 15_000 }).toBe('signed_up');

  // D5: an existing contact never gets the welcome text (it is sent in-request,
  // so it would already be in the fake's store).
  expect(await getOutboundTo(request, { to: tenant.phone })).toHaveLength(0);

  // The inbox, BEFORE the contact page (which reads the thread on open): the
  // row is unread, and its preview is still the tenant's own last message.
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link').filter({ hasText: tenant.name });
  await expect(row.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(inbound);

  // The thread pin links to the property.
  await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  const pin = timeline.getByRole('link', { name: pinLabel, exact: true });
  await expect(pin).toBeVisible({ timeout: 15_000 });
  await expect(pin).toHaveAttribute('href', `/listings/${unit.unitId}`);

  // Properties sent (D7, D8): the flyer row, its words, its chip, and the
  // waiting row's actions.
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Properties sent/ }) });
  const sentRow = card
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${unit.line1}`) }) });
  await expect(sentRow.getByText(/^Signed up from the flyer (Today \d{1,2}:\d{2}\s[AP]M|Yesterday)$/)).toBeVisible();
  await expect(sentRow.getByText('Signed up', { exact: true })).toBeVisible();
  await expect(sentRow.getByText(/^Sent /)).toHaveCount(0);
  await expect(
    sentRow.getByRole('button', { name: new RegExp(`^Mark ${tenant.name} interested in ${unit.line1}`) }),
  ).toBeVisible();
  await expect(
    sentRow.getByRole('button', { name: new RegExp(`^Mark ${tenant.name} not interested in ${unit.line1}`) }),
  ).toBeVisible();

  // D4: nothing about the contact changed; the typed name lives only on the pin.
  const after = await getContact(api, tenant.contactId);
  expect(after).toMatchObject({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    type: 'tenant',
    status: 'searching',
    consent_method: 'verbal_in_person',
  });
  expect(after['capture_source']).not.toBe('flyer');
  expect(after['unit_of_interest']).toBeUndefined();

  // The open contact page read the thread: nothing stays unread for later specs.
  await expect.poll(() => serverUnread(api, tenant.contactId), { timeout: 15_000 }).toBe(0);
});

test('an existing landlord on /join: the join pin and an unread inbox row, no text, and the contact unchanged', async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // a public sign-up, the inbox and the contact page
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  // No thread yet: the sign-up makes the landlord's own (D6 conversationTypeFor).
  const landlord = await createContact(api, { type: 'landlord', firstName: `Joinexist${stamp}`, lastName: 'Landlord' });

  const typed = { firstName: `Joiner${stamp}`, lastName: 'Typed' };
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/join`);
  await expect(visitor.getByRole('combobox', { name: 'Housing authority' })).toBeEnabled();
  await fillSignUp(visitor, { ...typed, phone: landlord.phone });
  await visitor.getByRole('button', { name: 'Sign me up' }).click();
  await expect(visitor.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
  await close();

  // Server truth (D6): ONE join pin with no ref, and the new thread unread.
  const pinLabel = `Signed up on the join page as ${typed.firstName} ${typed.lastName}`;
  await expect
    .poll(() => signedUpPins(api, landlord.contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}||`]);
  await expect.poll(() => serverUnread(api, landlord.contactId), { timeout: 15_000 }).toBe(1);
  // D5: no welcome for an existing contact.
  expect(await getOutboundTo(request, { to: landlord.phone })).toHaveLength(0);

  // The inbox, BEFORE the contact page.
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link').filter({ hasText: landlord.name });
  await expect(row.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });

  // The pin is plain text (no ref, so no link).
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  await expect(timeline.getByText(pinLabel, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(timeline.getByRole('link', { name: pinLabel })).toHaveCount(0);

  // D4: still a landlord with its own name, and no housing authority or
  // consent picked up from the form.
  const after = await getContact(api, landlord.contactId);
  expect(after).toMatchObject({ type: 'landlord', firstName: landlord.firstName, lastName: landlord.lastName });
  expect(after['housingAuthority']).toBeUndefined();
  expect(after['consent_method']).toBeUndefined();

  await expect.poll(() => serverUnread(api, landlord.contactId), { timeout: 15_000 }).toBe(0);
});

test('a NEW contact on the flyer gets the welcome, then the pin, the unread mark and the Signed up entry', async ({
  page,
  browser,
  request,
}) => {
  test.slow(); // a public sign-up and four server reads
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createContact(api, { type: 'landlord', firstName: `Flyerowner${stamp}`, lastName: 'Newlead' });
  const unit = await createAvailableUnit(api, {
    landlordId: landlord.contactId,
    line1: `${stamp} Flyerlead Newlead Ct`,
    area: `Newhood ${stamp}`,
    stamp,
  });

  const phone = uniquePhone();
  const person = { firstName: `Flyernew${stamp}`, lastName: 'Lead' };
  const { visitor, close } = await openVisitor(browser);
  await visitor.goto(`${NEXT}/p/${unit.unitId}`);
  await fillSignUp(visitor, { ...person, phone });
  await visitor.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(visitor.getByRole('heading', { name: /you're all set/i })).toBeVisible();
  await close();

  // D5: a contact this request created gets the welcome - exactly once. This
  // is also the positive control for the other cases' "no text" checks.
  await expect
    .poll(async () => (await getOutboundTo(request, { to: phone })).length, { timeout: 15_000 })
    .toBe(1);
  const contactId = await contactIdByPhone(api, phone);
  const pinLabel = `Signed up from the flyer for ${unit.line1}, ${CITY_LINE} as ${person.firstName} ${person.lastName}`;
  await expect
    .poll(() => signedUpPins(api, contactId), { timeout: 15_000, message: 'no signed_up pin' })
    .toEqual([`${pinLabel}|unit|${unit.unitId}`]);
  // Cameron 2026-10-21: a new sign-up shows in the inbox as unread too.
  await expect.poll(() => serverUnread(api, contactId), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => sentOutcome(api, contactId, unit.unitId), { timeout: 15_000 }).toBe('signed_up');

  // Leave the thread read for later specs.
  const read = await api.post(`${NEXT}/api/inbox/${contactId}/read`);
  expect(read.ok(), await read.text()).toBeTruthy();
});
```

Then C4 (`npm run typecheck -w @housingchoice/e2e`; `npx eslint
e2e/tests/dashboard-next/flyer-leads.spec.ts`): both exit 0.

Step 2 (RED - the mutation). Show the spec FAILS when D5 is reverted:

2a. `public.ts` must hold no uncommitted work (so the restore below cannot
lose any):

```bash
git -C "W:/tmp/flyer-leads" status --short -- app/src/routes/public.ts
```

Expected: no output.

2b. Find the welcome send and the D5 guard S4 built (plan 2.6 step 6:
"Welcome: only when `isNew`"):

```bash
grep -n "welcome.sms\|isNew" "W:/tmp/flyer-leads/app/src/routes/public.ts"
```

With the Edit tool, replace ONLY the guard's condition (the expression that
decides whether the welcome is sent - `isNew` in plan 2.6) with `true`, so
an existing contact is welcomed again (pre-D5 behavior). Confirm the scratch
diff is that one line:

```bash
git -C "W:/tmp/flyer-leads" diff -- app/src/routes/public.ts
```

2c. C2 (no stack may be up: B28 - a live stack would run the UNMUTATED
code), then C3:

```bash
cd "W:/tmp/flyer-leads" && timeout 1500 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/flyer-leads.spec.ts > .superpowers/sdd/gates/s6-flyer-leads-mutation.log 2>&1
```

Expected: non-zero exit, `2 failed`, `2 passed`. The two failures are the
existing-tenant test at the `expect(await getOutboundTo(request, { to: tenant.phone })).toHaveLength(0);`
line AFTER the sign-up, and the existing-landlord test at its
`toHaveLength(0)` line, each reading `Expected length: 0` / `Received length: 1`.
The layout and new-contact tests pass. If a test fails EARLIER, read the log:
the cause must still be the reverted welcome (e.g. the welcome as the inbox
preview); record it as such. A failure with any other cause, or a run with
fewer than two failures, means the spec is not isolating D5 - diagnose
before going on.

2d. Restore and prove it:

```bash
git -C "W:/tmp/flyer-leads" restore -- app/src/routes/public.ts
```

```bash
git -C "W:/tmp/flyer-leads" status --short -- app/src/routes/public.ts
```

Expected: no output. Then C2's port check (the Playwright-managed stack
must be gone before the next boot).

Step 3 (GREEN):

```bash
cd "W:/tmp/flyer-leads" && timeout 1500 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/flyer-leads.spec.ts > .superpowers/sdd/gates/s6-flyer-leads-green.log 2>&1
```

Expected: exit 0, `4 passed`. If test 3 is red at the inbox row while its
server polls were green, that is a real D6 defect (the inbox not listing a
new landlord thread with no message yet): report it to the slice owner (S4),
never weaken the test.

Step 3b. Write the record `docs/superpowers/reviews/2026-10-21-flyer-leads/S6-mutation-check.md`
(fill every `<...>` from the two logs; ASCII only):

```
# S6 mutation check - e2e/tests/dashboard-next/flyer-leads.spec.ts

Date: <YYYY-MM-DD>. Branch tip: <git rev-parse --short HEAD>.

Mutation (scratch, reverted in the same task): app/src/routes/public.ts - the
condition guarding the welcome send (D5: only a contact this request created)
replaced by `true`, so an existing contact is welcomed again.

RED: npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/flyer-leads.spec.ts
exit <code>; <n> passed, <n> failed.
- <test title>: flyer-leads.spec.ts:<line> - Expected length: 0, Received length: 1
- <test title>: flyer-leads.spec.ts:<line> - Expected length: 0, Received length: 1

Restored: git restore -- app/src/routes/public.ts; `git status --short -- app/src/routes/public.ts` printed nothing.

GREEN: the same command, exit <code>; <n> passed.
```

Step 4. C5 (new-file form) on both new files; `grep -n '\\u'
e2e/tests/dashboard-next/flyer-leads.spec.ts` prints nothing.

Step 5. C6 (`git status` must show ONLY the two new files - in particular
NOT `app/src/routes/public.ts`), then:

```bash
git -C "W:/tmp/flyer-leads" add e2e/tests/dashboard-next/flyer-leads.spec.ts docs/superpowers/reviews/2026-10-21-flyer-leads/S6-mutation-check.md
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "test(e2e): flyer-leads spec - the new flyer layout, and existing-contact sign-ups pin and mark unread without a text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6.3 - `e2e/support/selectors.md`

Goal: record the selector conventions S6 relies on, and retire the ones the
change made false (selectors.md:43 and :137 describe the old flyer).
Verification is the grep + ASCII check (AR10.1).

Files: Modify `e2e/support/selectors.md`.

Step 1. Edits (Edit tool; quoted old text is the anchor).

1a. Insert a row ABOVE the filter-tabs row. Old: `| Inbox | filter tabs | `
New (the new row, a newline, then the old text unchanged):

```
| Inbox | a 1:1 row's unread count | the count span INSIDE the row: `getByRole('link').filter({ hasText: <run-unique name> }).getByLabel('1 unread')` (never a bare `getByLabel` - the nav badge carries the same name, see the App frame row). Server truth: `GET /api/inbox?filter=unread&limit=100` -> `rows[]` with `contactId` and `unreadCount` (a row absent from the unread feed is 0). Assert unread BEFORE opening that contact's page: the contact page marks every thread of the contact read on mount (`useMarkContactRead`), so a check after the visit reads 0 whatever happened. `flyer-leads.spec.ts` uses that visit as its clean-up |
| Inbox | filter tabs | 
```

1b. Replace the submit row. Old (the whole line):

```
| Public form | submit | `getByRole('button', { name: 'Sign me up' })` |
```

New:

```
| Public form | submit | `/join`: `getByRole('button', { name: 'Sign me up' })`. The bare-link flyer (`/p/:unitId`): `getByRole('button', { name: 'Sign up', exact: true })` under the heading `Sign up for home alerts` (flyer-leads D3, 2026-10-21; it read `I'm interested` before). Pass `exact`: on `/join` the thank-you's `Sign up another person` substring-matches `Sign up`. The `?cta=text` flyer has no form, only the `I'm interested - text us` link (href only, never clicked) |
```

1c. Replace the success row. Old (the whole line):

```
| Public form | success | `/join`: `getByRole('heading', { name: /you're signed up/i })`; the flyer's in-place thank-you: `getByRole('heading', { name: /you're all set/i })` |
```

New:

```
| Public form | success | `/join`: `getByRole('heading', { name: /you're signed up/i })`; the flyer's in-place thank-you: `getByRole('heading', { name: /you're all set/i })`, its text `We'll text you about this home and others that fit your voucher.` (exact; the box before submit reads the same sentence plus ` Signing up does not book a tour.`) |
```

1d. Insert the pin row ABOVE the bubble meta-reveal row. Old:
`| Thread (any multi-party bubble) | the bubble's meta reveal | `
New (the new row, a newline, then the old text unchanged):

```
| Contact page (timeline) | a sign-up pin (flyer-leads D6) | `getByRole('region', { name: 'Communications and activity' }).getByRole('link', { name: 'Signed up from the flyer for <address> as <First Last>', exact: true })` -> href `/listings/<unitId>`. `<address>` is the APP's `formatAddress` (`<line1>, <City>, <ST> <zip>`), NOT the dashboard's (`<line1>, <City>, <ST>, <zip>`, which the Properties sent row link uses); `<First Last>` is the name TYPED on the form - a sign-up never renames the contact, so the pin and the header can differ. A flyer for a property that is not shareable pins `Signed up from a flyer as <First Last>` and `/join` pins `Signed up on the join page as <First Last>`: plain text with no ref and no link - `getByText(<label>, { exact: true })`. At most one pin per contact per property (or per the shared no-property source) per 24 hours, so sign up a run-unique contact. Server precondition: `GET /api/contacts/:id/timeline?kinds=milestone` -> an item with `type: 'signed_up'` |
| Thread (any multi-party bubble) | the bubble's meta reveal | 
```

1e. Extend the property-forms tag row. Old:

```
assert it with `toHaveAccessibleDescription(/On flyer/)`, never as part of the name.
```

New:

```
assert it with `toHaveAccessibleDescription(/On flyer/)`, never as part of the name. Since flyer-leads (D2, 2026-10-21) `Rent min`, `Rent max`, `Accessibility`, `Lease terms` and every Pets and Deposit field read `Staff only`; the landlord form's `On property flyers` tag sits only on the application-fee pair (count the spans with `getByText('On property flyers', { exact: true })`); and the note `Tenants see this on the public flyer.` renders only under an On flyer field (on the property forms, Tenant-paid utilities alone).
```

1f. Replace the public flyer row. Old (the whole line, selectors.md:137 -
it starts `| Public flyer (`/p/:unitId`) | requirement rows |` and ends
`only after a positive assertion on the same load |`). New:

```
| Public flyer (`/p/:unitId`) | heading, highlight line, detail rows | Since flyer-leads (D1, D3, 2026-10-21). The ADDRESS is the page's one `level: 1` heading and sits INSIDE the Google Maps link: `getByRole('link', { name: /open in Google Maps$/ })` (href `https://www.google.com/maps/search/?api=1&query=<the address, ", "-joined and URI-encoded>`, `target="_blank"`, `rel="noreferrer"`; its name is the street line, then the `City, ST zip` line, then the sr-only ` - open in Google Maps`), and `getByRole('heading', { level: 1 })` reads the street line ALONE (`line1`, `, line2`) - the `City, ST zip` line is its own element in the same link. Fallbacks: the city line (no second line), else the area as plain text, else `Home for rent`; `A home for you` is gone. The area is its own line under the heading: `getByText(<area>, { exact: true })`. `getByText('Same-day tours available', { exact: true })` is on EVERY flyer - static copy, not the per-property `Same-day RTA` row. Detail rows are `<dt>`/`<dd>` pairs: `getByRole('term')` lists the labels in order - `Application fee`, `Tenant pays`, `Washer / dryer`, `Same-day RTA`, `Video tour`, `Listing`, each only when recorded (assert the order with `toHaveText([...])`); read values by exact text: Application fee `No application fee` or `$N`, Washer / dryer `Hookups` / `Washer and dryer included` / `No hookups`, and `Fits a 2- or 3-bedroom voucher` (`Fits an ...` when the phrase starts with 8 or 11, e.g. `Fits an 8-bedroom voucher`). There is NO rent fact and NO Address, Deposit, Pets, Pet fee, Accessibility or Lease terms row, and the public JSON carries none of `rent_min`, `rent_max`, `lease_terms`, `accessibility`, `pets`, `no_pets`, `pet_fee`, `deposit`, `deposit_one_month`, `deposit_flexible` (absent, not null): they stay on the property, staff only. With a $0 fee `getByText('Application fee')` matches the label AND the value `No application fee` (strict-mode violation): pass `exact: true`. Prove a staff-only value absent with `toHaveCount(0)` only after a positive assertion on the same load |
```

1g. Extend the send-roster row (selectors.md:154). Old:

```
use `getByText('No reply', { exact: true })` |
```

New:

```
use `getByText('No reply', { exact: true })`. Since flyer-leads (D8, 2026-10-21) a pair whose latest counted share entry is a flyer sign-up reads the chip `Signed up` (match it `exact` - the row's dates line also starts with those words) and its dates line reads `Signed up from the flyer <date>` in place of `Sent <date>` (`<date>` as the Sent line formats it: `Today 2:14 PM`, `Yesterday`, `Sep 12`); it offers the waiting row's actions (`Mark <name> interested in <address>` / `Mark <name> not interested in <address>`) but never waits (no Follow up row, no `<n> waiting`), and the property card files it under `Interested` when the recipient is eligible, else `Not eligible`. A spec reads the pair first through `GET /api/contacts/:id/listings-sent` -> `sent[].outcome === 'signed_up'` |
```

Step 2. Check:

```bash
cd "W:/tmp/flyer-leads" && grep -nE "Sign up', exact: true|Signed up from the flyer for|a 1:1 row's unread count|getByRole\('term'\)|Since flyer-leads \(D2|Since flyer-leads \(D8" e2e/support/selectors.md
```

Expected: at least one hit per edit (1a, 1b, 1d, 1e, 1f, 1g). And the old
flyer row is gone - this prints nothing:

```bash
cd "W:/tmp/flyer-leads" && grep -nF "| Public flyer (\`/p/:unitId\`) | requirement rows |" e2e/support/selectors.md
```

Step 3. C5 (the diff form - selectors.md carries non-ASCII today).

Step 4. C6, then:

```bash
git -C "W:/tmp/flyer-leads" add e2e/support/selectors.md
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "docs(e2e): selectors for the flyer address heading, Sign up, the sign-up pin and the Signed up row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6.4 - `documentation/GLOSSARY.md` and the issue registry

Goal (spec section 4 "Docs", AR10.3): rent, accessibility, lease terms,
pets and deposit are staff only; the area is the line under the flyer's
address heading; new terms: the `signed_up` pin and outcome, and the
`flyer` share entry. Also (plan review R1 #8) the open issue
`deleted-contact-web-signup-silent` stops describing a welcome attempt the
new deleted path never makes. Verification is grep + the ASCII check
(AR10.1).

Files:
- Modify `documentation/GLOSSARY.md`
- Modify `docs/issues/deleted-contact-web-signup-silent.md`

Step 1. Edits (Edit tool).

1a. Old (GLOSSARY.md:198-201):

```
  Rent fields), not on the person. `lease_terms` is PUBLIC: the flyer shows
  it as "Lease terms". `subzone` (Sam's area codes, e.g. E8) is STAFF ONLY:
  it is on the New and Edit forms and the property page, never on the
  flyer, whose neighborhood line is `area` alone.
```

New:

```
  Rent fields), not on the person. `lease_terms` is STAFF ONLY since
  flyer-leads (2026-10-21; the flyer showed it as "Lease terms" before), and
  so are `rent_min` / `rent_max` and `accessibility`: Sam talks rent and
  lease terms through with each tenant. They stay on the forms and the
  property page. `subzone` (Sam's area codes, e.g. E8) is STAFF ONLY too: it
  is on the New and Edit forms and the property page, never on the flyer.
  The flyer's neighborhood line is `area` alone, and since flyer-leads it is
  the line directly under the flyer's address heading (the address is the
  heading and links to Google Maps; the area is the heading only when no
  address is recorded).
```

1b. Old (GLOSSARY.md:218-222):

```
  `dashboard/src/routes/listing/requirements.ts`, same test cases). Only
  the Pets item, the deposit's one month's rent / fixed amount / flexible
  fields and the application fee reach the public flyer; screening, the
  deposit notes and touring are staff only, and so are qualifications
  (Cameron, 2026-10-20). Nothing filters or ranks on them yet (Work Package
```

New:

```
  `dashboard/src/routes/listing/requirements.ts`, same test cases). Only
  the application fee ("No application fee" for 0) reaches the public
  flyer. Screening, touring and qualifications are staff only (Cameron,
  2026-10-20), and so are the whole Pets item (No pets, Pets (details), Pet
  fee) and the whole Deposit item since flyer-leads (2026-10-21; Sam talks
  them through with each tenant). Nothing filters or ranks on them yet (Work Package
```

1c. Old (GLOSSARY.md:616-617):

```
- **send outcome** (last-heard-from, 2026-10-12) - per property sent to a
  contact: No reply yet / Replied / Interested / Not interested. Interested =
```

New:

```
- **send outcome** (last-heard-from, 2026-10-12) - per property sent to a
  contact: No reply yet / Replied / Interested / Not interested, plus Signed
  up since flyer-leads (2026-10-21; see **signed up** below). Interested =
```

1d. Old (GLOSSARY.md:623-624):

```
  after the send; otherwise No reply yet. Precedence: Not interested >
  Interested > Replied > No reply yet. DERIVED, never stored, except the
```

New:

```
  after the send; otherwise Signed up when the pair's latest counted share
  entry is the flyer entry, else No reply yet. Precedence: Not interested >
  Interested > Replied > Signed up / No reply yet. DERIVED, never stored, except the
```

1e. Old (GLOSSARY.md:636):

```
  property, and counted as "<n> waiting" on the Properties list.
```

New (the waiting entry's last sentence, then two new entries; the blank
lines are part of the text):

```
  property, and counted as "<n> waiting" on the Properties list. A Signed
  up pair never waits: the person reached out, and the sign-up already
  marked their thread unread.

- **flyer share entry** (flyer-leads, 2026-10-21) - what a flyer sign-up
  writes to a contact's properties-sent list: ONE entry with share key
  `flyer` in the (property, contact) pair's `listing_sends.shares` map,
  counted at the sign-up instant (attempt key `<sign-up ISO>#flyer`, by
  `acceptance`), through the same ledger path every share uses. It is a
  share ENTRY, not a new row kind, and not a send: no text goes out, it has
  no broadcast, and no "Property sent" pin is written. It is written only
  for a shareable property and a `tenant` or `unknown` contact, and never
  while the pair holds a current decline (a sign-up never clears a
  decline). Code: `FLYER_SHARE_KEY` in `app/src/lib/shareLedgerKeys.ts`.

- **signed up** (the pin and the outcome; flyer-leads, 2026-10-21) - a
  sign-up on the flyer or on /join from a live contact records an activity
  event of type `signed_up`, shown as a pin in the contact's thread:
  "Signed up from the flyer for `<address>` as `<First Last>`" (linked to
  the property), "Signed up from a flyer as `<First Last>`" (the property
  is not shareable) or "Signed up on the join page as `<First Last>`".
  `<First Last>` is the name typed on the form: a sign-up never changes an
  existing contact (no name, type, status, voucher size, housing authority
  or consent), and only a contact the sign-up CREATED gets the welcome
  text. The sign-up also bumps the contact's 1:1 thread to the top of the
  inbox and marks it unread - at most one pin and one bump per contact per
  property (or per the shared "no property" source) per 24 hours. The send
  outcome `signed_up` - staff copy "Signed up", the row reading "Signed up
  from the flyer <date>" in place of "Sent <date>" - is a pair whose latest
  counted share entry is the flyer entry (see **send outcome**). A sign-up
  does not move **last heard from**.
```

1f. `docs/issues/deleted-contact-web-signup-silent.md` (plan review R1 #8).
Read the WHOLE file first. Its point 3 says the welcome is attempted,
refused `contact_deleted` and warn-logged, and its "Net" paragraph says the
only traces are the audit entry and a warn log; spec D4 + AR11 remove that
attempt. First confirm the BUILT deleted path (S4) matches what the update
will say:

```bash
grep -n "deletedContact\|sentSkipped\|housing-fair signup captured" "W:/tmp/flyer-leads/app/src/routes/public.ts"
```

Expected: the deleted branch writes the audit with `deletedContact: true`,
`recorded: false`, `sentRecorded: false`, `sentSkipped: 'deleted'`, logs
the INFO line `housing-fair signup captured` with `deletedContact: true`
(S4 section E), and returns before any conversation call or send. If the
built code differs, write what the code DOES and record the gap in the S6
slice report.

Keep the frontmatter's `id`, `type`, `severity`, `status: open`, `area`,
`created` and `refs` as they are; add one optional line (docs/issues/README.md:52
`updated: 2026-06-18            # optional`) right after `created: 2026-08-03`:

```
updated: <the build date, YYYY-MM-DD>
```

Then insert this paragraph between the "Net:" paragraph (it ends `the
public flow's handling of it is not.`) and `**Suggested fix.**`, as its own
paragraph (the repo's `**Update (<date>, <branch>): ...**` convention, e.g.
`docs/issues/auto-routing-changes-not-named.md:62`); the original points
stay as the historical record:

```
**Update (2026-10-21, `feat/flyer-leads`): the deleted path is now explicit,
and quieter.** Point 3 and the last line of the "Net" paragraph no longer
hold. POST /public/housing-fair still resolves the phone with
contacts.findByPhone (point 1), and a SOFT-DELETED holder is still neither
restored nor given the form's consent (point 2). But since flyer-leads
(spec docs/superpowers/specs/2026-10-21-flyer-leads-design.md D4, D5) the
route stops at that holder: it writes no conversation, attempts no send -
so there is no contact_deleted refusal and no welcome-refused WARN line any
more; only a contact the request CREATED is ever welcomed - and records no
sign-up pin, unread mark or properties-sent entry. It still answers
{ ok: true } (the visitor sees the normal thank-you; the flyer's button
reads "Sign up" now) and still writes the housing_fair_signup audit event
on that contact's entity (contacts#<id>), now with deletedContact: true,
recorded: false, sentRecorded: false and sentSkipped: 'deleted', and it logs
the INFO line "housing-fair signup captured" with deletedContact: true.
That audit row and that log line are the only traces - nothing reaches the
dashboard; point 4 stands (no inbox row, no Deleted chip). On a
legacy phone shared with a live contact, a deleted FIRST holder takes this
path too (spec D4 residual). A LIVE contact's sign-up, by contrast, now pins
"Signed up ..." in their thread and marks it unread (GLOSSARY "signed up"),
so option (b) below has a ready mechanism; flyer-leads deliberately left the
deleted case to this issue.
```

Step 2. Check:

```bash
cd "W:/tmp/flyer-leads" && grep -nE "lease_terms. is PUBLIC|flyer share entry|\*\*signed up\*\*|Signed up / No reply yet|address heading" documentation/GLOSSARY.md
```

Expected: no `is PUBLIC` hit; one hit each for `flyer share entry`,
`**signed up**`, `Signed up / No reply yet`, `address heading`. And
`grep -n "the Pets item, the deposit" documentation/GLOSSARY.md` prints nothing.

```bash
cd "W:/tmp/flyer-leads" && grep -nE "^updated: |^status: open|Update \(2026-10-21, .feat/flyer-leads.\)|sentSkipped: 'deleted'" docs/issues/deleted-contact-web-signup-silent.md
```

Expected: one hit each (the `updated:` line, `status: open` unchanged, the
Update heading, the audit fields).

Step 3. C5: the diff form for GLOSSARY.md (it carries non-ASCII today) and
for deleted-contact-web-signup-silent.md.

Step 4. C6, then:

```bash
git -C "W:/tmp/flyer-leads" add documentation/GLOSSARY.md docs/issues/deleted-contact-web-signup-silent.md
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "docs(glossary,issues): flyer-leads - staff-only flyer fields, the address heading, signed_up, the flyer share entry; the deleted sign-up path" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6.5 - FINAL: sync `main` once, then the five completion gates

AGENTS.md "Required completion gates". Everything runs from the worktree
in Git Bash (the Bash tool - NOT cmd, where `timeout` is `timeout.exe`,
which just waits), each gate its OWN bare command: never piped, never
`;`-chained behind another command. Long gates run in the background with
output REDIRECTED to a file (a redirect is not a pipe); read the output
after the command exits. Quote every real exit code. Never edit source or
commit while gate 4 runs.

Files:
- (a merge commit, unless `main` has not moved)
- Create: `docs/superpowers/reviews/2026-10-21-flyer-leads/S6-gates.md`
- Create: `docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S6-report.md` (the slice report, plan section 0)

AR10.2: this is the branch's ONE main sync. A later review fix wave re-runs
Steps 5-9 (the five gates) WITHOUT re-running Step 2, and reports any newer
`main` drift instead of chasing it.

Step 1. State: C6's two reads. Expected `On branch feat/flyer-leads`,
`nothing to commit, working tree clean`, and `no-merge`. Then C2 (no e2e
session or suite live; the lane's ports free; never adopt an orphaned
stack).

Step 2. Sync `main` ONCE:

```bash
git -C "W:/tmp/flyer-leads" rev-list --count HEAD..main
```

If `0`: record "main already merged" and go to Step 3. Otherwise preview:

```bash
git -C "W:/tmp/flyer-leads" log --oneline HEAD..main
```

```bash
git -C "W:/tmp/flyer-leads" merge-tree --write-tree HEAD main
```

Exit 0 = merges clean -> merge:

```bash
git -C "W:/tmp/flyer-leads" merge --no-ff main -m "Merge main into feat/flyer-leads (pre-handback sync)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Exit 1 = conflicts. AGENTS.md: when syncing could conflict with active work,
ASK before doing it - STOP and report the conflicting paths (the
`merge-tree` output's conflict lines) to the orchestrator; do not merge.
If the orchestrator relays the human's go: merge as above, resolve each
conflict preserving BOTH sides' intent, `git add` the explicit resolved
paths, `git -C "W:/tmp/flyer-leads" commit --no-edit`; and on a conflict in
a file whose meaning this branch changed (`app/src/routes/public.ts`,
`app/src/services/shareLedger.ts`, `app/src/repos/listingSendsRepo.ts`,
`app/src/lib/listingSendOutcome.ts`, `app/src/lib/unitFields.ts`,
`app/src/lib/requirements.ts`, `dashboard/src/routes/public/FlyerPage.tsx`,
`dashboard/src/routes/contact/Card.tsx`) whose right resolution is not
obvious, `git -C "W:/tmp/flyer-leads" merge --abort` and report.

After a merge, did it move dependencies?

```bash
git -C "W:/tmp/flyer-leads" diff --name-only HEAD^1 HEAD -- package-lock.json package.json app/package.json dashboard/package.json e2e/package.json fake-twilio/package.json
```

Non-empty -> `cd "W:/tmp/flyer-leads" && npm install` before the gates.

Step 3. The lean seed stays byte-stable (spec section 4: the seeds are
unchanged):

```bash
git -C "W:/tmp/flyer-leads" diff --name-only main...HEAD -- app/src/lib/seed app/src/lib/seedData.ts
```

Expected: NO output. Any path is a violation - stop and report.

Step 4. Pre-gate environment:

```bash
cd "W:/tmp/flyer-leads" && npm run db:start
```

Expected: already running, or started (it never restarts a running
container; never stop or restart the shared container).

```bash
env | grep '^AWS_'
```

(A diagnostic, not a gate.) If any `AWS_ACCESS_KEY_ID` prints, gate 2 runs
as `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` (AGENTS.md:
an exported key collapses every app test file onto one DynamoDB Local
database).

Step 5. Gate 1 - typecheck (foreground):

```bash
cd "W:/tmp/flyer-leads" && npm run typecheck
```

Expected: exit 0, no `error TS` in any workspace.

Step 6. Gate 2 - unit and integration tests (background, redirected):

```bash
cd "W:/tmp/flyer-leads" && npm test > .superpowers/sdd/gates/npm-test.log 2>&1
```

Expected: exit 0. Read it:

```bash
grep -nE "Test Files|Tests  |FAIL|\[dynamoAdmin\]" "W:/tmp/flyer-leads/.superpowers/sdd/gates/npm-test.log"
```

Every workspace's `Test Files` line without `failed`; no `FAIL`. ANY
`[dynamoAdmin]` line is one real container fault: capture that run's
`err.$metadata.httpStatusCode` and `attempts` and report it
(`docs/issues/dynamo-local-control-plane-fault-shape-unverified.md`). Red on
DynamoDB Local suites: adjudicate by re-run-and-compare, never the old
`AWS_ACCESS_KEY_ID` recipe - re-run each failing FILE alone more than once
(`cd "W:/tmp/flyer-leads/app" && npx vitest run test/<file>`), run the full
suite at the merge base, compare failing FILES (not cases) and report both
runs. There is no named-flake list: any other failure is a regression.

Step 7. Gate 3 - smoke (foreground):

```bash
cd "W:/tmp/flyer-leads" && npm run smoke
```

Expected: exit 0 (every import in the compiled `app/dist` resolves under plain node).

Step 8. Gate 4 - e2e, the FULL suite, under the hard outer cap (background,
redirected; C2 first):

```bash
cd "W:/tmp/flyer-leads" && timeout 2700 npm run e2e > .superpowers/sdd/gates/e2e.log 2>&1
```

Expected: exit 0. Exit 124 = the 45-minute cap fired = a gate FAILURE to
report (run `npm run e2e:stop` and C2's port check; do not raise the cap).
Read it:

```bash
grep -nE "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)" "W:/tmp/flyer-leads/.superpowers/sdd/gates/e2e.log"
```

Expected: `N passed`, no `failed`. On a failure: FIRST copy
`e2e/.artifacts/test-results` to `.superpowers/sdd/gates/e2e-results-1/`,
confirm the ports are free, isolate the failing FILE with C3 before any
full re-run, and diagnose to root cause (a named-spec failure is a
regression). For a CONTENT symptom (a missing row, a wrong payload) re-run
that file with `E2E_CHILD_LOG_DIR=.artifacts/child-logs`; for a TIMING
symptom (a hang, a budget) use `E2E_TRACE=1` instead - never the child-log
flag, which changes the timings.

Step 9. Gate 5 - lint the files this branch touched. First the list (it
must NOT be empty - this branch touches many `.ts` / `.tsx` files; an empty
list means the merge base is wrong, so stop, and never run `npx eslint`
with no paths - that lints the whole repo):

```bash
cd "W:/tmp/flyer-leads" && git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'
```

Then the gate exactly as AGENTS.md states it, output kept:

```bash
cd "W:/tmp/flyer-leads" && npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') > .superpowers/sdd/gates/lint-head.txt 2>&1
```

Exit 0 -> done. Errors -> attribute by BASELINE comparison, never by line
number (deleting the last use of an import fires `no-unused-vars` on the
import line, which the diff never touched). Lint the SAME paths at the merge
base (a diagnostic, so its pipe is fine):

```bash
cd "W:/tmp/flyer-leads" && BASE=$(git merge-base main HEAD) && : > .superpowers/sdd/gates/lint-base.txt && for f in $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'); do if git cat-file -e "$BASE:$f" 2>/dev/null; then echo "== $f" >> .superpowers/sdd/gates/lint-base.txt; git show "$BASE:$f" | npx eslint --stdin --stdin-filename "$f" >> .superpowers/sdd/gates/lint-base.txt 2>&1; else echo "== $f (NEW on this branch: no baseline - every error in it is ours)" >> .superpowers/sdd/gates/lint-base.txt; fi; done; echo baseline-done
```

Compare `lint-head.txt` with `lint-base.txt` per FILE by rule id and
message, ignoring line:column: anything in head and not in base is OURS and
BLOCKING - fix it, re-run gates 1 and 5 (and the touched workspace's tests),
and commit the fix with explicit paths. The rest is pre-existing (as of
2026-10-07: 23 errors, all `react-hooks/*`, in 18 dashboard files): leave it
and NAME each in the record. Known hole: the config lints `.ts` / `.tsx`
only, so a green result on a `.mjs` / `.js` path checked nothing.

Step 10. Write `docs/superpowers/reviews/2026-10-21-flyer-leads/S6-gates.md`
(fill every `<...>` with the real value; ASCII only):

```
# S6 completion gates - feat/flyer-leads

Branch tip: <git rev-parse --short HEAD>
main merged: <the merge commit's short sha, or "main already merged at <sha>">
Lean seed diff vs main: empty

| gate | command | exit |
|---|---|---|
| 1 typecheck | npm run typecheck | <code> |
| 2 test | npm test | <code> (<each workspace's Test Files line>) |
| 3 smoke | npm run smoke | <code> |
| 4 e2e | timeout 2700 npm run e2e | <code> (<N passed / failed>) |
| 5 lint | npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') | <code> |

Pre-existing lint errors in touched files (baseline-matched, not ours):
<file: rule - message, one per line, or "none">
```

Step 11. The slice report (plan section 0). Gate 4 has exited, so no e2e
run is live (never write source or commit while one runs). Create
`docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S6-report.md`
(`mkdir -p` the `slices/` directory if it is absent): ASCII, FINDINGS ONLY,
each citing code by `file:line` - never a recap of the tasks. What belongs
there: anything the tree held that this plan got wrong (an anchor that had
moved or changed, an extra stale assertion Task 6.1 had to repair, a
mutation run whose first failure differed from Task 6.2's expectation, a
built deleted path that differs from the issue update), risks and regressions found while running the
specs or gates, and any untrimmed typed-input path seen in a surface this
plan touches (plan section 0, D10). It MAY also name pre-existing lint
errors in files this slice touched (plan section 0); `S6-gates.md` stays
the authority for gate 5's baseline attribution and for the gate exit
codes. With nothing to report, the file is the single line:

```
S6: nothing to report - every anchor, expectation and citation held as planned.
```

Step 12. C5 (new-file form) on both records, C6 (only the two record files
are new; no merge in progress), then:

```bash
git -C "W:/tmp/flyer-leads" add docs/superpowers/reviews/2026-10-21-flyer-leads/S6-gates.md docs/superpowers/reviews/2026-10-21-flyer-leads/slices/S6-report.md
```

```bash
git -C "W:/tmp/flyer-leads" commit -m "docs(records): flyer-leads S6 completion gates and slice report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## D. Spec coverage map (items this slice owns -> task)

| Spec item | Task |
|---|---|
| s5 e2e: the flyer page shows the new layout (address heading link with the sr-only suffix, area line, Same-day tours available, row order) and none of the removed rows | 6.2 test 1 (+ 6.1 public-pages / property-requirements repairs) |
| D1: the ten keys absent from the public JSON (not null); the values stay on the property | 6.2 test 1, 6.1 (2h, 2k, 2l) |
| D3: "A home for you" nowhere; new sign-up box copy, button and thank-you text | 6.2 tests 1-2, 6.1 (2e, 2f) |
| D3: at 320px the heading wraps, nothing overflows, the heading block is the tap target (only a real browser can prove it) | 6.2 test 1 |
| s5 e2e: an existing tenant's flyer sign-up - no outbound text, unread inbox row, the pin, on Properties sent as "Signed up from the flyer <date>" with the "Signed up" chip | 6.2 test 2 |
| D8: the Signed up row offers Interested / Not interested | 6.2 test 2 |
| D4: an existing contact is never changed (name, type, status, consent, housing authority, capture fields) | 6.2 tests 2-3 |
| s5 e2e: an existing contact on /join - the pin and the unread mark, no outbound text | 6.2 test 3 (a landlord with no thread: also D6's correctly typed new thread reaching the inbox) |
| D5 + Cameron 2026-10-21: a NEW contact keeps the welcome and is marked unread too (the positive control) | 6.2 test 4 |
| Mutation: the spec fails when D5 is reverted | 6.2 Step 2 |
| s4 surfaces, e2e: public-pages (incl. the area-heading assertion), property-requirements (tags and flyer rows), contact-detail (landlord Pet fee tag), listing-photos ("I'm interested" button) | 6.1 |
| s5 Tags (e2e half): Pets / Deposit / Rent / Accessibility / Lease Staff only on the New property form; landlord form "On property flyers" only on the application-fee pair; the public note never on a Staff only field | 6.1 (2i, 2m). The Edit form's tags are S2's unit tests. |
| s5 e2e: specs follow selectors.md; selectors.md updated | 6.2, 6.3 |
| s4 Docs: GLOSSARY (staff-only fields, the area under the address heading, signed_up pin and outcome, the flyer share entry) | 6.4 |
| Plan review R1 #8: `docs/issues/deleted-contact-web-signup-silent.md` describes the deleted path as built (no send, no WARN, the audit with `deletedContact: true` and AR11's `sentSkipped: 'deleted'`) | 6.4 Step 1f |
| AGENTS.md completion gates (main sync once - AR10.2 - and the five gates) | 6.5 |
| Plan section 0: the S6 slice report | 6.5 Steps 11-12 |

Not owned here (app / dashboard tests in S1-S5): every s5 "Sign-up (app,
fake world)" case (repeat window, declines, O1, deleted holder, failures,
audit flags), the ledger and outcome unit cases, the subzone cases.

## E. Notes for other slices (names and DOM facts S6 relies on - please check they match)

S2 (FlyerPage, tags):
- E1. The ready flyer has exactly ONE `<h1>`; its text is EXACTLY the street
  line (`line1`, plus `, line2` when recorded; no city, no suffix) and it is
  a DESCENDANT of the Google Maps `<a>`. The `<a>` is a block-level box that
  contains the h1's box (spec D3 "the whole heading block is the tap target").
- E2. That `<a>`: `href` = today's `mapsHref` string unchanged (B23),
  `target="_blank"`, `rel="noreferrer"`, and its accessible name ENDS with
  `open in Google Maps` (the sr-only span ` - open in Google Maps` inside it).
- E3. The `City, ST zip` line is its own element inside the link with exact
  text `Atlanta, GA 30314` for city Atlanta / state GA / zip 30314.
- E4. The area line is its own element whose exact text is the area; the
  `Same-day tours available` line is its own element with that exact text.
- E5. Detail rows stay `<dt>` (role `term`) with today's labels; no other
  `<dt>` on the page. Facts keep the `2 beds` / `1 bath` text and
  `Fits a 2-bedroom voucher`; the authority line reads exactly
  `Accepts: Atlanta Housing Authority`.
- E6. The sign-up box heading's accessible name is exactly
  `Sign up for home alerts`; its text sits in ONE element; IntakeForm's
  submit's accessible name is exactly `Sign up` (`submitLabel="Sign up"`);
  the thank-you text sits in ONE element.
- E7. At 320px nothing overflows the document, the `<main>`, the card
  `<section>` or the h1 (`scrollWidth <= clientWidth + 1`); the h1 wraps
  rather than clipping (no `nowrap` + `overflow: hidden`).
- E8. A Staff only field's accessible description contains `Staff only`;
  `Tenants see this on the public flyer.` appears exactly ONCE in the New
  property dialog (under Tenant-paid utilities); the landlord form shows
  exactly TWO `On property flyers` tag spans (the application-fee pair).

S4 (the handler):
- E9. Pin labels exactly as plan 1.1; the shareable-flyer pin carries
  `refType: 'unit'` and `refId` = the unitId on the timeline wire
  (`GET /api/contacts/:id/timeline?kinds=milestone`, item `type: 'signed_up'`);
  the /join pin carries NO `refType` and NO `refId` on that wire.
- E10. One sign-up on a read thread leaves `unreadCount === 1` on
  `GET /api/inbox?filter=unread`; an existing tenant's sign-up reuses the
  thread its earlier inbound created (the inbox preview stays that inbound);
  a landlord with no thread gets a thread the inbox LISTS although it has no
  message yet.
- E11. An existing contact gets NO outbound; a new one gets exactly ONE (the
  welcome). The existing contact's stored `firstName`, `lastName`, `type`,
  `status`, `consent_method`, `capture_source`, `unit_of_interest` and
  `housingAuthority` are untouched.

S3 / S5 (ledger, outcome, renderers):
- E12. `GET /api/contacts/:id/listings-sent` returns a pair whose ONLY entry
  is the flyer entry (the row must count as listed), with
  `outcome: 'signed_up'` and `sentAt` at the sign-up.
- E13. `Card.tsx` on a `signed_up` row: the dates line's first span has the
  exact text `Signed up from the flyer <formatHeardFrom label>` (no `Sent`
  span on that row), the chip's exact text is `Signed up`, and the
  Interested / Not interested buttons keep the aria-labels
  `Mark <name> interested in <address>` / `Mark <name> not interested in <address>`
  (`<address>` = the dashboard row label, B18).
- E14. The dashboard milestone union includes `'signed_up'` and
  `MilestonePin` renders it as a link for a `unit` ref (`milestoneHref` is
  type-agnostic today, B16).
