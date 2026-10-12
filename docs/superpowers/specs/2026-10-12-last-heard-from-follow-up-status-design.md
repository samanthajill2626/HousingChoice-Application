# Last heard from, follow-up status for shared properties, and the off-screen contact search

Date: 2026-10-12
Status: DRAFT - design review pending, then Cameron's spec gate, then Sam's
mockup feedback (section 9) before the build launches
Branch: feat/last-heard-from (worktree W:\tmp\last-heard-from, cut from main
@19607658)
Tracker: Sam's improvements #3 ("Most interested tenants" view, 5-8 hrs) and
#27 (Follow-up status for shared properties, 2-4 hrs provisional), plus
`docs/issues/contact-search-popover-below-viewport.md` (C6)

## 1. Why

Sam places tenants property-first. When a property comes in (or comes back),
she opens the Tenants tab, filters by voucher size and housing authority,
opens each tenant in a browser tab to read the thread, and sends the property.
She keeps a sticky note per property of who responded or showed interest and
goes back to it all week to chase whoever went quiet. She wants tenants who
already said no left out, and whoever reached out in the last couple of days
first. (Workflow review, 2026-10-06; tracker #3 and #27.)

The platform has nothing for either half today:

- No contact carries a recency field. A conversation's `last_activity_at`
  moves on outbound and automated sends too
  (`app/src/repos/conversationsRepo.ts:1624` and its callers in
  `sendMessage.ts`, `groupSend.ts`, `relayAnnouncements.ts`,
  `sendEmailMessage.ts`, `broadcastFanOut.ts`). The per-phone
  `phones[].lastSeenAt` is bumped only by 1:1 and native-group SMS
  (`app/src/routes/webhooks/twilio.ts:2571`, `:2104`), never by relay, voice
  or email, does nothing for a contact with no `phones[]`, and is reset when
  staff edit a phone (`contactsRepo.ts:435-454`).
- The Tenants tab (`dashboard/src/routes/contacts/ContactsList.tsx`) loads
  every tenant through `fetchAllPages` and filters client-side, with no sort
  control. Its order is the `byTypeStatus` GSI's range key, so rows come out
  in byte order of status: inactive, needs_review, on_hold, onboarding,
  placed, placing, searching (`app/src/repos/contactsRepo.ts:1292-1332`,
  `app/src/lib/tables.ts:88-94`). There is no status filter on screen.
- Matching's Review recipients step (`RecipientPreview.tsx:403-453`) shows a
  checkbox, name, phone and tags. `voucherSize` and `housingAuthority` arrive
  from the preview endpoint but are not rendered; tenant status is not sent.
  Rows keep the resolver's status order (`audienceResolution.ts:129-138`).
- The property page's "Sent to" card and the contact page's "Properties
  sent" card render a name and a derived tour chip
  (`dashboard/src/routes/contact/Card.tsx:218-247`,
  `app/src/lib/listingSendTour.ts`): no date, nothing about replies, and the
  property card's rows are in contactId order.
- Nothing records a tenant declining a property. A per-send `response` label
  ('no_reply' | 'interested' | 'not_a_fit') was REMOVED on 2026-07-10
  (`docs/superpowers/specs/2026-07-10-listing-response-tour-chip-design.md`)
  because "interested" duplicated creating a tour, "no_reply" went stale, and
  nothing read "not_a_fit". Stray `response` attributes still sit on
  production `listing_sends` rows (no migration was done), so that field name
  is not reusable.
- The contact search list used by "Add a tenant" on Review recipients can
  open entirely below the viewport (`docs/issues/contact-search-popover-below-viewport.md`).
  A verified fix was drafted on the caseworkers mission and never applied
  (`docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`;
  it applies cleanly to main @19607658).

Amendment No. 1's Work Package 1 promises "recording the outcome of each
send" and uses declines to leave tenants out of a property's ranking; Work
Package 3 later sets these outcomes automatically. This work builds THE
send-outcome record those packages read and write, so the design below is
shaped for an engine writer as much as for a staff click.

## 2. Goals

- G1. Every contact carries `last_heard_from_at`: the instant of the most
  recent inbound text (1:1, relay or native group thread), inbound call (any
  outcome) or inbound email from that contact. Outbound and automated sends
  never move it. It only moves forward. Existing history is backfilled.
- G2. The Tenants tab shows last heard from on every row, sorts by it (most
  recent first, never-heard last) by default, offers a Name sort, and gains
  an on-screen status filter that defaults to the active statuses (every
  tenant status except Inactive and Placed). Inactive and placed tenants no
  longer come first.
- G3. Matching's Review recipients rows show tenant status, housing authority
  and last heard from, ordered most recent first. A tenant who declined this
  property shows unchecked and labeled "Not interested".
- G4. Each property sent to a contact has an outcome: No reply yet, Replied
  (derived), Interested (derived from a tour), or Not interested (stored).
  The property's "Sent to" card and the contact's "Properties sent" card show
  the sent date, last heard from, and the outcome, with Interested and Not
  interested actions on the row. Interested creates the tour request with
  one click (the tenant lands on Needs booking) and never creates a second
  tour.
- G5. One list across properties of sends still waiting on a reply, excluding
  Inactive and Placed tenants. Its location, contents and thresholds are
  decided WITH Sam from mockups (section 9); the build waits for that.
- G6. The contact search list stays within the viewport (C6 applied; issue
  closed in this branch).
- G7. The outcome record is engine-ready: a stored decline names who set it
  (staff or engine) and when, and the derivations are pure functions with
  one home each.

## 3. Non-goals

- #6's audience rules (status and tour exclusions on filter-resolved blasts)
  and Work Package 1's ranking. The resolver's filters do not change.
- Recovering the properties Sam sent by copy-paste during the skip bug.
- Live updates on the Tenants tab or the roster cards (they refresh on
  navigation, as today).
- Converting the Tenants tab into a full sortable table (deferred on
  2026-09-30 until Sam has used the Matching page).
- Showing WHAT the contact said. "Replied" is a pointer to go read the
  thread, not a summary.
- Any Twilio, SES, terraform or table-schema change. No new table or GSI.
- Fixing the duplicate-tour hole in `POST /api/tours` generally; it is filed
  (section 11) and closed only on the Interested path.
- Partner rows gaining an Interested action (section 5.4 explains).

## 4. Decisions

Answers Cameron gave on 2026-10-12, recorded as the design's fixed points:

- D1. The waiting list is designed with Sam from mockups (section 9), not
  decided here. Today is a candidate on equal footing with the Matching page
  and the property card. Wherever it lives, Inactive and Placed tenants are
  left out.
- D2. Replied = any inbound contact from the recipient after the send, in any
  thread: a text in their 1:1, in a relay group or in a native group, a call,
  or an email. Engagement with us in any context counts. Merely receiving a
  group message does not. This is the same definition as last heard from, so
  the two columns can never disagree: Replied is `last_heard_from_at >
  sentAt`.
- D3. Blast sends and direct shares are the same mechanically (one-to-many vs
  one-to-one), so every send gets the same outcomes, the same decline
  handling and the same place on the waiting list.
- D4. Declined recipients are NOT hidden from Review recipients. They show
  unchecked with a "Not interested" tag, exactly like "Already sent" rows, so
  a missing name never reads as a bug. Hand-checking one still sends.
- D5. C6 is applied as proposed and the issue is closed in this branch.
- D6. Interested is DERIVED: it means a qualifying tour exists for this
  recipient and property. Only Not interested is stored (who, when, staff or
  engine). The Interested action picks the tour type itself and never creates
  a second tour.
- D7. Partner rows (caseworkers, #19) get the same outcomes and actions as
  tenant rows wherever the mechanism allows, on both cards. Tours are
  tenant-only, so Interested on a partner row needs a definition: section
  5.4 recommends Replied and Not interested only, plus a "Request a tour"
  link that opens the existing tour form on the property.
- D8. The outcome actions show on the contact page's "Properties sent" card
  too, not only on the property's "Sent to" card: Sam is usually on the
  tenant page when the tenant says no.
- D9. The Tenants tab gets an on-screen status filter defaulting to the
  active statuses.
- D10. The duplicate tour request bug (two clicks on `POST /api/tours`
  create two tours) is filed as its own issue and fixed only on the
  Interested path.

## 5. Design

### 5.1 `last_heard_from_at` on the contact

A new optional attribute on `ContactItem` (`app/src/repos/contactsRepo.ts`):

```
/** ISO 8601 - the most recent inbound text, call or email FROM this contact
 *  in any thread. Forward-only; outbound and automated traffic never moves it.
 *  Absent = never heard from (or not yet backfilled). */
last_heard_from_at?: string;
```

Writer: one new repo method, the only place that writes the attribute.

```
/** Forward-only, best-effort bump of last_heard_from_at. A no-op (no error)
 *  when the stored value is already later; never throws to the caller's
 *  message path - logs at error and returns false. */
touchLastHeardFrom(contactId: string, at: string): Promise<boolean>;
```

UpdateItem with `SET last_heard_from_at = :at` under the condition
`attribute_not_exists(last_heard_from_at) OR last_heard_from_at < :at`
(the importer's `last_activity_at` pattern, `app/src/lib/import/apply.ts:1352-1362`).
A `ConditionalCheckFailedException` is the normal "already later" case and
is swallowed silently. It is NOT an index key attribute, so no
`INDEX_KEY_ATTRIBUTES` guard applies.

Failure posture: best-effort, exactly like `touchPhoneLastSeen` at
`twilio.ts:2571-2577`. The message is already persisted when the touch runs;
a failed touch logs `last_heard_from touch failed - message persisted,
last_heard_from stale` and the webhook still returns its normal response. A
stale value mis-sorts a row; it never hides one.

The instant written is the inbound's `provider_ts` (the message row's own
timestamp, `messagesRepo.ts:211`), not `now`, so a webhook retry or a
re-ingested email cannot move the value past the message it describes.

Call sites - every live inbound write. The touch follows the `append` on
each path and runs only when a sender contact has resolved:

| # | Path | Append | Sender contact |
|---|------|--------|----------------|
| 1 | 1:1 SMS/MMS | `twilio.ts:2470` | `effectiveContact` (after `captureContact`, `:2553`) |
| 2 | Relay group member or non-member (open group) | `twilio.ts:913` | the resolved sender (`:897`); skipped for the `team` sentinel and for a `phone#` key with no contact |
| 3 | Closed relay group late text (filed into the sender's 1:1) | `twilio.ts:1288` | the contact from `:1280`; this path has no `captureContact`, so an unknown phone has no contact and no touch |
| 4 | Native group text | `twilio.ts:2026` | the sender resolved at `:2001` (roster by phone, else `findByPhone`) |
| 5 | Business-line inbound call (founder bridge) | `voice.ts:779` | the caller's contact; today `captureContact`'s return is DISCARDED at `:748`, so the plan keeps it and touches with the captured id |
| 6 | Masked relay call, refused (non-member) | `voice.ts:1036` | `relay_external_caller_contact_id` when set |
| 7 | Masked relay call, bridged (member) | `voice.ts:1112` | the member's contactId from the roster |
| 8 | Inbound email | `inboundEmail.ts:734` | `threadContact`; NO touch when the sender is `author: 'unknown'` (`:867`), since the mail is not attributed to that contact yet |

Rules the plan carries as explicit checks:

- A relay RETRY row copies `direction: 'inbound'` from the original
  (`twilio.ts:2953-2989`). Retries never touch; the original did.
- A call touches at RING time (the row's `provider_ts`), whatever the
  outcome. A missed call, a voicemail and an answered call all mean the
  contact reached out.
- A STOP or other keyword text is inbound and counts. Opt-out is a separate,
  visible fact; last heard from does not try to be a consent signal.
- Staff texting a group from another org number is stored as inbound
  (`twilio.ts:1943-1966`). It touches whatever contact that number resolves
  to, which is never a tenant or partner in practice; no special case.
- Dedupe: a deduplicated inbound (the `sid#` pointer already exists) does not
  touch. The touch sits after a successful, non-deduped append.
- Historical writers: the import tool (`lib/import/apply.ts:436-484`) writes
  message and call rows directly. After its message pass it stamps
  `last_heard_from_at` per imported contact from the latest imported inbound
  row it wrote (1:1 rows by `imported_sender_phone`, group rows by
  `relay_sender_key`), through the same forward-only write. The full seed
  (`app/src/lib/seed/history.ts`) stamps the contacts it writes inbound
  messages for, so the demo world shows real values; the lean seed is left
  as is (its two tenants carry no inbound history, and e2e specs create
  their own).

Readers (every place that renders or sorts on the value): the contacts list
endpoint already returns raw items (`routes/contacts.ts:1098-1099`), so the
Tenants tab needs no API change; the preview candidate projection
(section 5.3); the recipient display projection used by both roster cards
(`RECIPIENT_PROJECTION`, `contactsRepo.ts:1018`) gains `last_heard_from_at`
and `status`; the waiting list (section 5.6); the contact detail header
(section 5.7). The dashboard `Contact` type (`dashboard/src/api/types.ts`)
mirrors the field as `last_heard_from_at?: string`.

Display: a shared `formatHeardFrom(iso, now)` in
`dashboard/src/lib/heardFrom.ts` renders "Today 2:14 PM", "Yesterday",
"Oct 3" or "Oct 3, 2025" (reusing `formatInboxTime` from
`routes/inbox/inboxTime.ts`), with the full stamp as the hover title, and
"Never" when absent. One formatter, every surface.

### 5.2 Backfill

`app/scripts/backfill-last-heard-from.ts`, in the
`enable-conversation-automation.ts` convention: `--env local|dev|prod`
through `app/scripts/lib/stageClient.ts`, dry run by default, `--apply`
writes. An agent runs it only with `--env local`; Cameron runs dev and prod
after the merge (RUNBOOK section added by the plan).

Algorithm (no GSI exists on messages, `tables.ts:208`):

1. Scan `conversations`, skipping pointer rows (`phone#`, `email#`, `token#`
   keys - the `backfill-unread-flag.ts:59-60` skip).
2. Per conversation, Query `messages` by PK newest-first with the filter
   `direction = 'inbound' AND attribute_not_exists(relay_retry_of)`.
3. Attribute each inbound row to a contact: 1:1 threads by
   `participants[0].contactId`, else `participant_phone -> findByPhone`,
   else `participant_email -> findByEmail` (the `unreadFeed.ts:534-546`
   precedent); relay threads by `relay_sender_key` when it is a contactId,
   else by phone against the roster then `findByPhone`; native group threads
   by the `phone#E164` key against `thread.participants`, then `findByPhone`.
   A 1:1 thread stops at its first inbound; a group thread pages until every
   roster member has a value or the partition is exhausted.
4. Keep the max `provider_ts` per contact across threads, then one
   forward-only conditional write per contact. Idempotent: a second run
   writes nothing.
5. Report: conversations walked, messages read, contacts planned / written /
   skipped-already-later, unattributed inbound rows (count + a sample of
   conversationIds, no bodies or phones).

Unit test: an exported pure planner (the `backfill-unread-flag.ts` shape)
over fixture rows covering each attribution branch, the retry exclusion and
the forward-only condition.

### 5.3 Matching - Review recipients

Preview candidates (`POST /api/broadcasts/:id/preview`,
`routes/broadcasts.ts:710-735`) gain three fields:

```
status?: string;            // the tenant's lifecycle status; absent on a partner seed
lastHeardFromAt?: string;   // contact.last_heard_from_at
declinedThisProperty: boolean;
```

`declinedThisProperty` comes from ONE `listingSends.listByUnit(unitId)` read
in the preview handler (rows with an effective decline, section 5.4), matched
by contactId; false when the draft has no unit. The audience resolver is not
touched (no #6 overlap): the resolver's candidate projection already carries
the contact, so `status` and `lastHeardFromAt` are copied from it.

The dashboard row (`RecipientPreview.tsx`) renders, in this order: checkbox;
name (link, new tab as today); phone; status badge (`StatusBadge
kind="tenant"`, the Tenants tab's component); housing authority; last heard
from; tags. On panes 768px and wider these are columns under a header row
(Name, Status, Housing authority, Last heard from); below that the row
stacks: name and phone on the first line, status + authority + last heard
from on a second, tags on a third.

Order: the dashboard sorts the COMBINED list (audience rows and added rows
alike) by `lastHeardFromAt` descending, absent values last, ties by name.
One rule in one place (a `sortByHeardFrom` helper shared with the Tenants
tab); the server's order stops mattering. An added row therefore slots into
place rather than appending at the end; it keeps its "Added" tag.

Declined rows: a `declinedThisProperty` row starts UNCHECKED unless it was
hand-picked, carries a "Not interested" tag in the same tone as "Already
sent", and "Select all" skips it exactly as it skips unpicked already-sent
rows (`:79-93, 165-169`). Its checkbox stays enabled. The accessible name
becomes `<name> - not interested`. A row that is both already sent and
declined shows both tags, "Not interested" first. The ContactSearchField
result for a declined tenant also shows "Not interested" after the name, so
a hand-pick is informed.

The send endpoint does not change: it already takes an explicit selection, so
"declined rows start unchecked" IS the exclusion for a filter-resolved blast,
and a deliberate check overrides it (D4).

Mobile is a second-class surface here (Sam matches on desktop, per the
2026-09-30 decision), but the stacked layout must not break the existing
mobile e2e pins in `broadcasts.spec.ts`.

### 5.4 The send outcome

Stored, on the `listing_sends` row (PK unitId, SK contactId;
`listingSendsRepo.ts:71-97`):

```
/** A recorded "not interested". Absent = not declined. */
declined?: {
  at: string;                   // ISO 8601
  by: 'staff' | 'engine';       // who recorded it
  staffId?: string;             // the dashboard user, when by = 'staff'
};
```

The name is `declined`, never `response`: production rows still carry stale
`response` attributes from the removed 2026-07-10 field, and
`ListingSendItem` tolerates them (`[key: string]: unknown`).

Writer: `listingSendsRepo.setDeclined(unitId, contactId, record)` and
`clearDeclined(unitId, contactId)`, each an UpdateItem that SETs or REMOVEs
only `declined` (and `updated_at`), conditioned on the row existing
(`attribute_exists(unitId)`). `putShareMemory` is already an UpdateItem that
SETs only its own attributes (`listingSendsRepo.ts:277-280`), so the two
writers never clobber each other. The NO-RESET invariant in the repo header
extends to `declined`: no writer resets it except `clearDeclined`.

Effective decline (pure, `app/src/lib/sendOutcome.ts`):

```
effectiveDecline(row) = row.declined !== undefined
                     && (row.sentAt === undefined || row.declined.at >= row.sentAt)
```

A counted share AFTER the decline supersedes it: the row's `sentAt` follows
the latest counted share (`shareLedger.ts:112-120`), so re-sending the
property to a tenant who changed their mind restarts the outcome at No reply
yet with no writer coordination. The stale `declined` record stays on the
row as history.

Derived outcome (same module, pure, both GET projections call it):

```
export type SendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';

deriveSendOutcome({ row, lastHeardFromAt, tour }):
  if effectiveDecline(row)                      -> 'not_interested'
  else if tour !== undefined                    -> 'interested'
  else if lastHeardFromAt > row.sentAt          -> 'replied'
  else                                          -> 'no_reply'
```

`tour` is the existing `deriveTourSignal` result for the pairing
(`lib/listingSendTour.ts`): requested, scheduled or toured all read as
Interested; a canceled, no-show or not-a-fit tour yields no signal, so the
row falls through to Replied / No reply yet. Precedence is deliberate: a
recorded no beats a stale tour chip (staff closing a tour as not a fit and
then marking Not interested should read as Not interested); a tour beats a
reply (the tour IS the stronger signal); a reply beats silence.

Partner rows (D7). Tours require `tenantId` (`routes/tours.ts:325-327`) and
the caseworkers design keeps the tour relationship tenant-only, so "a tour
exists" cannot be true for a partner. Two options were weighed:

- Derive Interested for a partner from a tour on this property whose tenant
  lists the partner in `relationships[]` with a `contactId`. Rejected: the
  link is optional, usually name-only (`lib/contactProfile.ts:9-24` accepts
  a relationship with no contactId), and lives on the tenant, so the
  derivation would be silently absent for most caseworkers and would read
  as "not interested" when it is really "we do not know".
- RECOMMENDED: partner rows derive Replied / No reply yet / Not interested
  only, carry the Not interested action, and show a "Request a tour" link
  in place of the Interested button. The link opens the existing tour form
  (`ScheduleTourForm`, which takes `initialUnitId`) on the property with the
  tenant picker empty, because a caseworker's yes is always a yes for a
  specific client whom staff must name. The resulting tour then shows as
  Interested on THAT TENANT's row, which is where it belongs. The wire row
  carries `interestedSupported: false` for partner rows so the dashboard
  needs no type logic of its own.

Audit: a `listing_declined` activity event (new `ActivityEventType` member,
`activityEventsRepo.ts:31`) is recorded best-effort on set, and a
`listing_decline_cleared` on undo, each with the unitId and contactId, so
the contact timeline and the property Activity show "Not interested in
<address>" / "<name> not interested" the way `listing_sent` shows a share.
Unknown event types already render nothing (the 2026-07-10 `listing_response_set`
precedent), so no other renderer changes.

Outcome endpoint - ONE route, the only way outcomes change:

```
POST /api/units/:unitId/recipients/:contactId/outcome
  { outcome: 'interested' | 'not_interested' | 'clear' }
  -> 200 { row: ListingSendRow }       (the row re-projected, with its new outcome)
  -> 404 { error: 'send_not_found' }   (no LISTED listing_sends row for the pair)
  -> 400 { error: 'interested_unsupported' }  (interested on a non-tenant row)
  -> 404 { error: 'unit_not_found' }
```

- `not_interested`: `setDeclined` with `{ at: now, by: 'staff', staffId }`.
  Idempotent (a second call rewrites the same shape with a new `at`).
- `clear`: `clearDeclined`. Idempotent.
- `interested` on a tenant row: if a tour for (tenantId, unitId) exists in
  status `requested` or `scheduled` (one `tours.listByTenant` filtered by
  unitId), return the row with that tour; otherwise create a `requested`
  tour through the same `toursRepo.create` path `POST /api/tours` uses,
  with `tourType = unit.tour_type ?? deriveTourType(unit.tour_process) ??
  'self_guided'`, where `deriveTourType` moves from
  `ScheduleTourForm.tsx:84-114` into a shared pure module the app imports
  (`app/src/lib/tourType.ts`, mirrored or imported by the dashboard - the
  plan decides the import path). The tour's `created_via: 'send_outcome'`
  is stamped if `TourItem` has a provenance field; otherwise the activity
  event carries it. An existing effective decline is cleared by Interested
  (the tenant changed their mind; the stale record stays as history).
- The `by: 'engine'` value is reserved for Work Package 3. This route always
  writes `staff`.

The listed GET projections (`GET /api/units/:unitId/recipients`,
`GET /api/contacts/:id/listings-sent`) each gain, per row:

```
lastHeardFromAt?: string;
outcome: SendOutcome;
declined?: { at: string; by: 'staff' | 'engine' };   // present when effective
interestedSupported: boolean;                        // false on a partner row
```

The contact endpoint today returns rows with no name, type or role
(`routes/contacts.ts:1219-1250`); it gains the contact's own
`last_heard_from_at` (one read, the contact is already loaded) and the tour
join the units endpoint already does (one `tours.listByTenant`, grouped by
unitId). The wire type `ListingSendRow` in `dashboard/src/api/types.ts:2943`
mirrors the additions.

### 5.5 The roster cards

Both cards (`ListingDetail.tsx` "Sent to", `TenantFile.tsx` and
`PartnerFile.tsx` "Properties sent") render the shared `SendRosterRow`
(`Card.tsx:218-247`), which grows into:

```
[identity link] [kind]          Sent Oct 3 - Last heard from Oct 10
                                [outcome]  [actions]
```

- Line one: the identity link and the kind label as today, then a muted
  "Sent <date>" and "Last heard from <formatHeardFrom>" on the right; on a
  narrow card they wrap under the identity.
- Line two, left: the outcome as a chip. `no_reply` = "No reply yet"
  (neutral), `replied` = "Replied" (positive), `interested` = the existing
  TourChip (Tour requested / Tour scheduled / Toured - the tour IS the
  interested signal, so no second chip), `not_interested` = "Not
  interested" (muted) with the date in its title.
- Line two, right, the actions, which depend on the outcome:
  - `no_reply` or `replied`: two small buttons, "Interested" (tenant rows
    only; partner rows show the "Request a tour" link) and "Not interested".
  - `interested`: no buttons (the tour chip links to the tour; cancel or
    close the tour there).
  - `not_interested`: one "Undo" button.
  Each action calls the outcome endpoint and replaces the row with the
  returned one; a failure shows an inline error on the row and leaves it
  unchanged. Accessible names: "Mark <name> interested in <address>",
  "Mark <name> not interested in <address>", "Undo not interested for
  <name>" - the contact page's card uses the same shape with the property's
  short address.
- The property card's rows sort by outcome group then recency: waiting
  (`no_reply`, `replied`) first, newest `sentAt` first within the group;
  then `interested`; then `not_interested`. The contact card keeps its
  newest-first order and shows the outcome on each row.
- Partner rows on the property card keep their kind label; partner pages'
  "Properties sent" rows now show the outcome chip and actions (the
  caseworkers ruling R3-F5 that hid tour chips on partner pages stands: a
  partner row never has a tour chip, because it never has a tour).

### 5.6 The waiting list (pending Sam)

Mechanism, independent of where it lives:

1. Candidate sends: every LISTED `listing_sends` row on every unit in
   status `available` (`unitsRepo.listByStatus('available')`, then
   `listingSends.listByUnit` per unit). No new index: Sam's available
   properties number in the tens, so this is tens of Queries per request,
   cached per request and capped at 100 units (a WARN past the cap).
2. Join: one `getRecipientDisplaysByIds` batch for the contacts (status,
   type, name, `last_heard_from_at`), one `tours.listByUnit` per unit for
   the tour signal (the recipients endpoint's own join).
3. Keep a row when ALL hold:
   - outcome is `no_reply` or `replied` (not `interested`, not
     `not_interested`);
   - the contact is not a tenant in `inactive` or `placed` (D1);
   - `sentAt` is within the LOOKBACK window;
   - the contact has been quiet for at least the QUIET threshold, measured
     from `max(sentAt, lastHeardFromAt)`.
4. Order: longest-waiting first (oldest `max(sentAt, lastHeardFromAt)`).

Endpoint: `GET /api/matching/follow-ups` returning
`{ items: FollowUpItem[], truncated: boolean }` where

```
FollowUpItem {
  unitId, unitLabel,            // the short address
  contactId, name, type, role?, // the recipient
  sentAt, lastHeardFromAt?, outcome, interestedSupported,
  conversationId?,              // the recipient's 1:1 thread, for the Text action
  waitingSince                  // max(sentAt, lastHeardFromAt)
}
```

Defaults proposed to Sam: QUIET = 2 days (her "last couple of days"),
LOOKBACK = 14 days. Both are constants in `app/src/lib/sendOutcome.ts`, set
once Sam answers. The Today option (section 9, option B) reuses this
endpoint's builder inside `GET /api/today` rather than adding a second
walk.

Row actions on the list, wherever it lives: Interested / Not interested /
Undo as on the cards, plus "Text" (opens the 1:1 conversation).

### 5.7 Tenants tab

`ContactsList.tsx` (filter = tenant only; the other contact views do not
change):

- Each row's meta line gains "Last heard from <formatHeardFrom>" after the
  facts span; "Never" when absent.
- A sort control (a labeled `<select>`, "Sort by": "Last heard from" |
  "Name"), URL state `?sort=heard|name`, default `heard`. `heard` = most
  recent first, absent last, ties by name; `name` = last name, first name,
  the existing display order. The `applyToParams` helper in
  `tenantFacets.ts:139-172` learns the new key alongside the three it owns.
- A status filter chip group ("Status", the `FilterChips` component used by
  voucher and authority) listing the seven tenant statuses by their
  `StatusBadge` labels, URL state as repeated `?status=`. Default (no
  `status` param) = every status except `inactive` and `placed`. The chips
  show which are on; "All" is reached by turning the two back on. An explicit
  `?status=` set is honored as given, including an empty set meaning "none".
  The pruning rules at `ContactsList.tsx:203-230` extend to invalid status
  values.
- Filtering and sorting stay client-side over the fully loaded list (the
  5,000-row `fetchAllPages` ceiling, `api/paging.ts:56-85`, is unchanged;
  prod has ~640 tenants).
- `useContacts('all')` is shared by six other screens
  (`PeopleCard.tsx:732`, `ListingDetail.tsx:194`, `ToursPage.tsx:663`,
  `ContactDetail.tsx:539`, `EmailTriage.tsx:238`, `ConversationDetail.tsx:192`);
  the sort lives in `ContactsList`'s `visible` memo, never in the hook.
- The contact detail header (`ContactDetail.tsx`) shows "Last heard from
  <value>" beside the status, for every contact type, so the value Sam
  sorts by is visible on the page she lands on.

### 5.8 C6 - contact search list within the viewport

Apply `docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`
verbatim (`git apply`), which changes only
`dashboard/src/routes/contact/ContactSearchField.tsx` and its test: the
fixed portal opens ABOVE the input when its contents do not fit below and
more room exists above, and its max height is bounded by the available
space with no 9rem floor. The three new unit tests it adds were proven red
on the old source and green on the new. All twelve `ContactSearchField`
callers inherit the fix. Then: re-run the populated Matching case
(`e2e/tests/dashboard-next/matching-entry-points.spec.ts:228`) against the
reworked Review recipients step (section 5.3 changes the row height, so the
geometry must be re-proven, not assumed), and mark the issue resolved with
the date and commit.

## 6. Invariants and their surfaces

I1. `last_heard_from_at` never moves backward. Writers: `touchLastHeardFrom`
(the only one), the backfill (through it), the importer (through it), the
full seed (direct, from seed history). Any other contact write
(`statusTransition`, PATCH, phone edits, caseworker conversion, soft-delete /
restore) must not SET or REMOVE it; the plan greps every `UpdateExpression`
on the contacts table and the PATCH allowlist
(`routes/contacts.ts:706`, `:898`) to prove it is neither accepted from a
client nor cleared. Readers: section 5.1's list.

I2. The outcome is derived, never stored, except `declined`. No table, seed
or dev seam writes an `outcome` attribute. Writers of `declined`: the
outcome route only (`setDeclined` / `clearDeclined`); `putShareMemory`
never touches it. Readers: the two listed GET projections, the preview's
`declinedThisProperty`, the waiting list, the activity events.

I3. A pair has at most one open tour from the Interested action. The route
checks before it creates; a concurrent double click can still race two
creates through `toursRepo.create` (no conditional write on the pair, filed
in section 11); the dashboard disables the button while a call is in
flight, which closes the practical case.

I4. The lean seed stays byte-stable. No lean contact gains
`last_heard_from_at` by seeding; e2e specs that need a value send an inbound
through the fake carrier and assert the result.

## 7. Edge cases

- A contact deleted then restored keeps the value (no writer clears it).
- A phone-only recipient (`phone#E164` recipient key, no contact) has no
  outcome row and no last heard from; the preview flags it as today.
- A send whose row is not LISTED (no share counted yet: pending, unconfirmed
  or failed) has no outcome; the outcome route returns 404 for it.
- A tenant converted to a caseworker keeps their tenant-era rows; those rows
  now report `interestedSupported: false` because the contact's type is
  partner at read time.
- Two properties sent in one blast to one tenant: two rows, two outcomes;
  one reply marks both Replied. That is the D2 definition, stated on the
  mockups so Sam sees it.
- The engine value `by: 'engine'` renders as "Not interested (auto)" when it
  appears; nothing writes it yet.
- Time zones: all comparisons are on ISO instants; day thresholds are
  `ms >= N * 86400000`, not calendar days.

## 8. Verification

Unit (app): `touchLastHeardFrom` forward-only + swallow; each of the eight
inbound paths touches (route tests with the fake repos); retry, dedupe and
unknown-email-sender do not; `deriveSendOutcome` precedence table;
`effectiveDecline` supersession; the outcome route's four branches and the
no-second-tour check; the backfill planner's attribution branches; the
follow-ups builder's four filters and ordering; preview `declinedThisProperty`.

Unit (dashboard): `sortByHeardFrom`; Tenants tab default status set, sort
and URL round trip; `RecipientPreview` declined-row defaults and "Select
all"; `SendRosterRow` outcome rendering and action callbacks; the C6 tests;
`formatHeardFrom`.

E2E (new or extended specs, accessibility-first selectors): (1) an inbound
text, a relay-group text, a call and an email each move last heard from on
the contact page; an outbound text does not. (2) Tenants tab: default
excludes an inactive and a placed tenant; the status chips bring them back;
sort by last heard from orders a just-replied tenant first; reload keeps the
URL state. (3) Matching: columns present; order by last heard from; a
declined tenant shows unchecked with "Not interested"; checking and sending
works. (4) Property card: Interested creates exactly one tour, the tenant
appears on Needs booking, the row shows Tour requested; Not interested then
Undo; the contact card mirrors the row. (5) The populated Matching
hand-pick case (C6) passes with ordinary clicks. (6) The waiting list, once
its home is chosen. Gates per `AGENTS.md`.

## 9. Mockups for Sam (the waiting list, and the row design)

Cameron shows Sam two or three options and brings back her choice before
the build launches. The mockups are a static HTML page committed with this
mission's records (`docs/superpowers/reviews/2026-10-12-last-heard-from/mockups.html`)
and published privately for sharing. They show real-looking rows with the
same data in each option, so the comparison is about place and shape, not
content. Each option states the rules in plain words (what counts as a
reply, when a send appears, who is left out).

Option A - a "Follow up" tab on the Matching page. Next to the send history
tabs, with a count. Grouped by property (address as the group heading, the
property's own waiting rows under it), longest-waiting first. Row: tenant
name, Sent <date>, Last heard from <date>, outcome chip, actions
(Interested / Not interested / Text). Argument: it sits where sends start
and where Sam is told to go for matching; the per-property grouping matches
her sticky-note-per-property habit.

Option B - a "Waiting on a reply" section on Today. One flat list under
Unreplied, each row "<tenant> - sent <address> <n> days ago - last heard
from <date>", same actions. Argument: Today is the page built for "what
needs me now", and Cameron's job includes moving Sam onto it; the list
reads as a to-do list rather than a report.

Option C - on each property, no separate list. The property's "Sent to"
card sorts waiting rows first (section 5.5 already does this) and the
Properties list shows a "<n> waiting" count on each available property.
Argument: Sam already works property by property; a count on the list tells
her which property needs chasing without a new page.

Questions the mockups ask Sam, with the proposed defaults:

1. Where should the list live - A, B or C (or A plus the C count)?
2. How long after a send with no reply should a tenant appear? Proposed:
   2 days of quiet.
3. How far back should it look? Proposed: 14 days; older sends drop off.
4. Should a tenant who replied but has gone quiet since appear too?
   Proposed: yes (the Asia case), shown as Replied.
5. What belongs on a row? Proposed: name, property, sent date, last heard
   from, outcome, Interested / Not interested / Text.

The build launches once her answers are folded into sections 5.6 and 9 and
the spec is re-committed. Everything in sections 5.1-5.5, 5.7 and 5.8 is
independent of those answers.

## 10. Estimates (Cameron's hours)

- #3: 5-8 hrs holds (field + 8 touch points, backfill, Tenants tab incl.
  the status filter, Review recipients columns, roster card dates).
- #27: 3-5 hrs (outcome record + route + cards + preview tag + waiting
  list); the tracker's 2-4 was provisional and did not include the waiting
  list's own screen.
- C6: 0.5 hr.
- Post-merge, Cameron's: run the backfill on dev then prod (dry run, then
  apply), per the RUNBOOK section the plan adds.

## 11. Filed alongside

- `docs/issues/tour-create-no-dedupe.md` (new, med): `POST /api/tours`
  creates a second `requested` tour for the same tenant and unit on a second
  click; no existence check and no conditional write. Fixed on the Interested
  path only (section 5.4); the Schedule tour form and the API stay as they
  are.
- `docs/issues/contact-search-popover-below-viewport.md`: resolved in this
  branch (section 5.8).
- `docs/issues/denormalize-contact-last-activity-for-ordered-paging.md`:
  this spec delivers the attribute (as `last_heard_from_at`, inbound-only)
  without the GSI; the issue stays open for the paged-feed half and gains a
  note pointing here.

## 12. Open questions

- For Sam: section 9's five questions.
- For Cameron: none blocking. The partner recommendation (section 5.4, D7)
  is his to confirm at the spec gate.

## 13. Glossary additions

`documentation/GLOSSARY.md` gains: "last heard from" (the most recent
inbound text, call or email from a contact, any thread); "send outcome" (No
reply yet / Replied / Interested / Not interested, per property sent to a
contact; Interested = a tour exists, Not interested = a recorded decline);
"waiting on a reply" (a send with no outcome whose recipient has been quiet
past the threshold).
