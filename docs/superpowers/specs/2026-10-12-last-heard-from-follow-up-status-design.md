<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-10-13).** This document describes how
> this work was *designed at the time of writing*. The work shipped to `main` (release 1.5.4,
> deployed to dev and prod 2026-10-13) and its feature branch + worktree were deleted during
> cleanup. **This file is NOT current documentation and the live code may have drifted from it -
> do not treat it as authoritative guidance on how the system should be built or behaves today.**
> For current truth read the code and the living docs (`RUNBOOK.md`, `documentation/GLOSSARY.md`,
> `e2e/README.md`). Kept only as a point-in-time record of intent; the review record is in
> `docs/superpowers/reviews/2026-10-12-last-heard-from/`.

# Last heard from, follow-up status for shared properties, and the off-screen contact search

Date: 2026-10-12
Status: APPROVED revision 6 - design review CLOSED after round 3; D11-D14
and the partner recommendation confirmed by Cameron 2026-10-12; Sam's mockup
answers folded in 2026-10-13 (section 9); approved at Cameron's spec gate
2026-10-13; revision 6 adds section 14, the plan-research amendments
(2026-10-13, tree at f6aba402 with main merged). WHERE SECTION 14 AND AN
EARLIER SECTION DISAGREE, SECTION 14 WINS.
Branch: feat/last-heard-from (worktree W:\tmp\last-heard-from, cut from main
@19607658)
Tracker: Sam's improvements #3 ("Most interested tenants" view, 5-8 hrs) and
#27 (Follow-up status for shared properties, 2-4 hrs provisional), plus
`docs/issues/contact-search-popover-below-viewport.md` (C6)
Design review: round 1 adjudications at
`docs/superpowers/reviews/2026-10-12-last-heard-from/design-review/adjudications.md`

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
  or email, does nothing for a contact with no `phones[]`, and is stamped
  with a fake "now" when the phones array is first materialized from the
  legacy scalar (`contactsRepo.ts:442-450`), so it is not a recency fact.
- The Tenants tab (`dashboard/src/routes/contacts/ContactsList.tsx`) loads
  every tenant through `fetchAllPages` and filters client-side, with no sort
  of any kind (rows keep `useContacts`'s map order). That order is the
  `byTypeStatus` GSI's range key, so rows come out in byte order of status:
  inactive, needs_review, on_hold, onboarding, placed, placing, searching
  (`app/src/repos/contactsRepo.ts:1292-1332`, `app/src/lib/tables.ts:88-94`).
  There is no status filter on screen.
- Matching's Review recipients step (`RecipientPreview.tsx:403-453`) shows a
  checkbox, name, phone and tags. `voucherSize` and `housingAuthority` arrive
  from the preview endpoint but are not rendered; tenant status is not sent.
  Rows keep the resolver's status order
  (`app/src/services/audienceResolution.ts:129-138`).
- The property page's "Sent to" card and the contact page's "Properties
  sent" card render a name and a derived tour chip
  (`dashboard/src/routes/contact/Card.tsx:218-247`,
  `app/src/lib/listingSendTour.ts`): no date, nothing about replies, and the
  property card's rows are in contactId order.
- Nothing records a tenant declining a property. A per-send `response` label
  ('no_reply' | 'interested' | 'not_a_fit') was REMOVED on 2026-07-10
  (`docs/superpowers/specs/2026-07-10-listing-response-tour-chip-design.md`)
  because "interested" duplicated creating a tour, "no_reply" went stale, and
  nothing read "not_a_fit". Stray `response` attributes may still sit on
  production `listing_sends` rows (no migration was done), so that field name
  is not reused.
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
  outcome, including a refused masked call) or inbound email from that
  contact. Outbound and automated sends never move it. It only moves
  forward. Existing history is backfilled under the SAME attribution rule the
  live paths use (section 5.1, "one rule").
- G2. The Tenants tab shows last heard from on every row, sorts by it (most
  recent first, never-heard last) by default, offers a Name sort, and gains
  an on-screen status filter that defaults to the active statuses (every
  tenant status except Inactive and Placed). Inactive and placed tenants no
  longer come first.
- G3. Matching's Review recipients rows show tenant status, housing authority
  and last heard from, ordered most recent first. A tenant who declined this
  property is labeled "Not interested" wherever the row appears (the
  audience, a hand-added row, the "Add a tenant" search result); a
  filter-proposed declined row starts unchecked, and a hand-picked one stays
  checked because the pick was deliberate and the search result warned first.
- G4. Each property sent to a contact has an outcome: No reply yet, Replied
  (derived), Interested (derived from a tour), or Not interested (stored).
  The property's "Sent to" card and the contact's "Properties sent" card show
  the sent date, last heard from, and the outcome, with Interested and Not
  interested actions on the row. Interested creates the tour request with
  one click (the tenant lands on Needs booking) and never creates a second
  tour while any qualifying tour exists.
- G5. One list across properties of sends still waiting on a reply, excluding
  Inactive and Placed tenants and anyone who cannot be texted. Its location,
  contents and thresholds are decided WITH Sam from mockups (section 9); the
  build waits for that.
- G6. The contact search list stays within the viewport (C6 applied; issue
  closed in this branch).
- G7. The outcome record is engine-ready: a stored decline names who set it
  (staff or engine) and when, and every derivation is a pure function with
  one home.

## 3. Non-goals

- #6's audience rules (status and tour exclusions on filter-resolved blasts)
  and Work Package 1's ranking. The resolver's FILTERS do not change; its
  candidate projection does (section 5.3), which is a shape change, not a
  rule change.
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
- Decline-awareness on the send route's legacy no-body filter-resolve path
  (`routes/broadcasts.ts:895-925`, path (c)): the dashboard never uses it,
  and Work Package 3's engine must not either; noted, not changed.

## 4. Decisions

Answers Cameron gave on 2026-10-12, recorded as the design's fixed points:

- D1. The waiting list is designed with Sam from mockups (section 9), not
  decided here. Today is a candidate on equal footing with the Matching page
  and the property card. Wherever it lives, Inactive and Placed tenants are
  left out. DECIDED 2026-10-13 from Sam's answers (section 9): option A (a
  Follow up tab on Matching) plus option C's count on the Properties list;
  24 hours of quiet; 14 days back; replied-then-quiet rows included.
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
  link that opens the tour form on the property with the tenant to be
  picked.
- D8. The outcome actions show on the contact page's "Properties sent" card
  too, not only on the property's "Sent to" card: Sam is usually on the
  tenant page when the tenant says no.
- D9. The Tenants tab gets an on-screen status filter defaulting to the
  active statuses.
- D10. The duplicate tour request bug (two clicks on `POST /api/tours`
  create two tours) is filed as its own issue and fixed only on the
  Interested path.

Added after design review round 1 (adjudications file, section 1):

- D11. A decline is superseded by whichever comes LATER: a counted share
  (`sentAt`) or tour ACTIVITY on the pair - the latest instant any
  qualifying tour for the pair was created, rescheduled or reopened
  (`max(createdAt, lastMarkedAt)` over every qualifying tour, not the chip
  winner's `createdAt`: the chip winner is the most PROGRESSED tour, and a
  revived tour keeps its original `createdAt`, `toursModel.ts:214-218`;
  never `updatedAt`, which any automated write bumps, `toursRepo.ts:559`).
  A tour created or revived by a PERSON after a decline means the tenant
  changed their mind, from any tour-creating path.
- D12. The joins that feed an outcome are REQUIRED on the endpoints that
  serve outcomes, read with `requireComplete` so a partial batch is
  detected. A failed join is an error response, never a wrong outcome with
  live buttons; the surface that shows the error is named per endpoint.
- D13. The lean seed changes deliberately: seeded contacts get
  `last_heard_from_at` derived from their seeded inbound rows by the same
  rule the backfill uses, so every seeded demo world (lean, full) is
  self-consistent. The performance world (`/__dev/performance/reseed`) is a
  load fixture, not a demo world, and is excluded on purpose.

Added after round 2 (adjudications file, section 2):

- D14. The Interested button commits a tour type only when the property
  carries a STRUCTURED `unit.tour_type`. `tourType` cannot be edited after
  creation (`routes/tours.ts:157`, the PATCH allowlist) and routes every
  reminder (`tourReminders.ts:1062-1068`: non-self-guided tours remind in
  the landlord group thread, self-guided in the tenant 1:1), so an unseen
  keyword guess over free-text `tour_process` is not acceptable. When
  `tour_type` is absent, the button opens the Schedule tour form prefilled
  (tenant, property, no time) so the guess is seen and correctable before
  the tour exists. This amends D6's "picks the tour type itself" to "picks it
  when the property says what it is".

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
 *  when the contact row does not exist or its stored value is already later.
 *  Never throws to the caller's message path - logs at error and returns
 *  false on any other failure. */
touchLastHeardFrom(contactId: string, at: string): Promise<boolean>;
```

UpdateItem on the contacts table, key `{ contactId }`, `SET
last_heard_from_at = :at`, condition
`attribute_exists(contactId) AND (attribute_not_exists(last_heard_from_at) OR
last_heard_from_at < :at)`. The `attribute_exists` guard is load-bearing: an
UpdateItem on an absent key CREATES the item, and touch targets come from
rosters and stored sender keys that can outlive a contact (the import retract
hard-deletes contacts, `app/src/lib/import/apply.ts:776-783`; the hazard is
documented at `apply.ts:663-686`). Every other contacts writer carries the
same guard (`contactsRepo.ts:1086`, `:1405`, `:1433`). A
`ConditionalCheckFailedException` covers both "no such contact" and "already
later" and is swallowed silently (a debug log). Pointer rows (`phoneref#`,
`emailref#`) are never touch targets. It is not an index key attribute, so no
`INDEX_KEY_ATTRIBUTES` guard applies.

Failure posture: best-effort, the `touchPhoneLastSeen` shape at
`twilio.ts:2569-2578`. The message is already persisted when the touch runs;
a failed touch logs `last_heard_from touch failed - message persisted,
last_heard_from stale` and the webhook still returns its normal response. A
stale value mis-sorts a row; it never hides one.

The instant written is the message row's own timestamp: the `providerTs`
prefix of the APPENDED row's `tsMsgId` (`messagesRepo.ts:207-213`,
`splitTsMsgId`). On every live SMS and voice path that prefix is the server
clock at FIRST arrival (`twilio.ts:906`, `:2469`; `voice.ts:777`), not a
carrier timestamp; the point is that a redelivery must not move the value
past the first delivery, which the stored prefix guarantees.

The value is normalized INSIDE `touchLastHeardFrom` (`Date.parse` to a
canonical ISO string, refusing an unparseable input with a logged no-op)
because the DynamoDB condition compares stored strings lexically and the
importer stores the export's raw `createdAt` (`apply.ts:448-449`). The one
writer normalizes; no caller has to.

Dedupe: on the SMS and voice paths the touch runs on BOTH the fresh and the
deduped branch, the way the 1:1 webhook deliberately re-runs its idempotent
side effects on a redelivery (`twilio.ts:2501-2545`, "Dedupe must NOT skip
the side effects below") and the native group path states for its own
("DELIBERATELY NOT GATED ON `appended.deduped`", `twilio.ts:2190-2200`). A
crash between the append and the touch is then repaired by the redelivery.
On the deduped branch the instant comes from the persisted row's key
(`appended.tsMsgId` is the first delivery's key), and the touch is skipped
when the persisted row is not inbound (the echo-of-our-own-send dedupe).
The email path is different by design: its deduped branch returns early
because "the winner runs the side effects" (`inboundEmail.ts:735-742`), so
the touch sits with the winner's side effects and is not re-run.

ONE ATTRIBUTION RULE. `attributeInbound(row, thread, lookup)` in
`app/src/lib/heardFrom.ts` is the single definition of "which contact this
inbound row is FROM". It is deterministic over its inputs but NOT pure: the
rule needs phone and email lookups, so it takes an injected
`lookup: { byPhone(e164), byEmail(address) }` - async over `contactsRepo`
for the live paths, the backfill and the importer; synchronous over the
seed's own contact items for the seed derivation. The live paths may pass
the contact they already resolved, but the plan's conformance tests prove
each live path's answer equals the function's answer on the row it wrote.
The rule, discriminated by THREAD TYPE (never by which fields a row
happens to carry):

- A `relay_retry_of` row is never attributed (a retry copies the original's
  `direction`, `twilio.ts:2953-2989`).
- Thread type `relay_group` or a native group thread: a `relay_sender_key`
  of `team` is never attributed; a bare contactId key is that contact; a
  `phone#<E164>` key resolves through the thread's `participants[]` by
  phone, then `lookup.byPhone` (deleted contacts included - `findByPhone`
  ignores deletion, and a restored contact keeps its value). A row with NO
  sender key on such a thread (a refused masked call from a non-member,
  which carries `relay_external_caller_contact_id` /
  `relay_external_caller_phone` instead, `voice.ts:1048-1054`) resolves by
  `relay_external_caller_contact_id`, else `relay_external_caller_phone ->
  lookup.byPhone`; any other keyless inbound row on a group thread (an
  imported group call) is not attributed and is counted in the backfill
  report. A group thread's roster member is never the fallback.
- Any other thread (1:1 of any type): the thread's participant contact
  (`participants[0].contactId`), else `participant_phone -> findByPhone`,
  else `participant_email -> findByEmail` (the `unreadFeed.ts:534-546`
  precedent, through `lookup`) - EXCEPT an email row carrying
  `email_new_address: true` (`inboundEmail.ts:729`, `:871`: the sender's
  address is not on any contact; on the live path that is `threadContact ===
  undefined`), which is not attributed until staff link the address. NOT
  `author: 'unknown'`, which the tree also writes for a verified sender whose
  contact is an unknown-typed stub or a team member (`inboundEmail.ts:381-383`)
  - those are real contacts and count. The thread fields are
  `thread.participant_phone` / `thread.participant_email` (they live on the
  conversation, not the message), and a `participants[]` entry with an empty
  `contactId` counts as absent (phone-only relay members, imported group
  rosters and email-only threads all carry `''`). Imported call rows in a
  1:1 carry no sender fields and are attributed by this branch like any
  other row.

Call sites - every live inbound write. The touch follows the `append` on
each path with the contactId the path resolved, which the rule above must
reproduce:

| # | Path | Append | Contact the path already holds |
|---|------|--------|--------------------------------|
| 1 | 1:1 SMS/MMS | `twilio.ts:2470` | `effectiveContact` (after `captureContact`, `:2553`) |
| 2 | Relay group, open thread, member or non-member | `twilio.ts:913` | the roster sender (`:897`); a NON-member (today a `phone#From` key and no contact) is resolved with `findByPhone` for the touch, per the rule |
| 3 | Closed relay group late text (filed into the sender's 1:1) | `twilio.ts:1288` | the contact from `:1280`; no `captureContact` on this path, so an unknown phone has no contact and no touch |
| 4 | Native group text | `twilio.ts:2026` | the sender resolved at `:2001` (roster by phone, else `findByPhone`) |
| 5 | Business-line inbound call (founder bridge) | `voice.ts:779` | the caller's contact; today `captureContact`'s return is DISCARDED at `:748`, so the plan keeps it and touches with the captured id |
| 6 | Masked relay call, refused (closed thread, non-member, or any other refusal reason, `voice.ts:1006-1055`) | `voice.ts:1036` | a member caller's roster contact (`relaySenderKey`); a non-member's `relayExternalCallerContactId`, or `findByPhone` when that is unset because the match was soft-deleted (`:1023-1025`) |
| 7 | Masked relay call, bridged (member) | `voice.ts:1112` | the member's contactId from the roster |
| 8 | Inbound email | `inboundEmail.ts:734` | `threadContact`; NO touch when the row's `author` is `'unknown'` (`:867`) |

Rules the plan carries as explicit checks:

- A call touches at the row's instant (ring time), whatever the outcome. A
  missed call, a voicemail, an answered call and a refused masked call all
  mean the contact reached out.
- A STOP or other keyword text is inbound and counts. Opt-out is a separate,
  visible fact; last heard from does not try to be a consent signal (the
  waiting list excludes opted-out contacts on its own, section 5.6).
- Staff texting a group from another org number is stored as inbound
  (`twilio.ts:1943-1966`). It touches whatever contact that number resolves
  to, which is never a tenant or partner in practice; no special case.
- Dev seams that append inbound rows directly - `/__dev/voice/transcript-fixture`
  and `/__dev/extraction/message-fixture` (`app/src/routes/dev.ts:794-860`,
  `:897-1060`) - call the touch too, so e2e state built through them obeys
  the rule.
- Historical writers go through the same rule: the import tool
  (`lib/import/apply.ts:436-484`) stamps each contact after its message pass
  from the latest attributed inbound row it wrote, through
  `touchLastHeardFrom`. Seeds: `deriveSeedHeardFrom(messages, conversations,
  contacts)` in the seed package runs in `seed/index.ts` over the MERGED
  items of whichever profile is loading (lean, or lean + cast), calling
  `attributeInbound` with a synchronous lookup over the seed's own contact
  items, and stamps the contact items before the Put loop, so the value
  always matches the seeded threads. This changes the lean world's contact
  items deliberately (D13); the lean message rows are untouched.
  `/__dev/reseed` re-Puts those items, which restores the derived value, not
  an absent one. The performance world is excluded (D13). Seed rows carry
  `ts` rather than `provider_ts`; the derivation and the backfill both read
  the instant from the `tsMsgId` prefix, which every row has.

Readers (every place that renders or sorts on the value): the contacts list
endpoint already returns raw items (`routes/contacts.ts:1098-1099`), so the
Tenants tab needs no API change; the preview candidate projection
(section 5.3); the recipient display projection used by the property
recipients route (`RECIPIENT_PROJECTION`, `contactsRepo.ts:1018`, used at
`units.ts:1029`) gains `last_heard_from_at` and `status`; the contact
listings-sent route reads the contact it already loads; the waiting list
(section 5.6); the contact detail header (section 5.7). The dashboard
`Contact` type (`dashboard/src/api/types.ts`) mirrors the field as
`last_heard_from_at?: string`.

Display: a shared `formatHeardFrom(iso, now)` in
`dashboard/src/lib/heardFrom.ts` renders "Today 2:14 PM" (a wrapper: the
inbox formatter returns a bare "2:14 PM" for today, `inboxTime.ts:52-60`),
"Yesterday", "Oct 3" or "Oct 3, 2025", with the full stamp as the hover
title, and "Never" when absent. One formatter, every surface.

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
3. Attribute each row with `attributeInbound(row, thread)` (section 5.1). A
   1:1 thread stops at its first ATTRIBUTED inbound (an unknown-author email
   is skipped, not stopped on); a group thread pages until every roster
   member has a value or the partition is exhausted.
4. The instant is the `tsMsgId` prefix (`splitTsMsgId`), normalized through
   `Date.parse` before the planner compares instants across threads (the
   writer normalizes again on its own, section 5.1). Keep the max per
   contact across threads, then one `touchLastHeardFrom` per contact.
   Idempotent: a second run writes nothing.
5. Report: conversations walked, messages read, contacts planned / written /
   skipped (no row, or already later), unattributed inbound rows (count +
   a sample of conversationIds, no bodies or phones).

Unit test: an exported pure planner (the `backfill-unread-flag.ts` shape)
over fixture rows covering each attribution branch, the retry exclusion, the
unknown-author skip, the imported-call branches and the forward-only
condition.

### 5.3 Matching - Review recipients

The resolver's candidate projection `ResolvedContact`
(`app/src/services/audienceResolution.ts:30-48`) is a fixed field list with
no status and no contact reference, and `resolveSeeds`
(`routes/broadcasts.ts:440-473`) builds the same shape by hand. Both gain:

```
status?: string;            // the contact's lifecycle status, TENANT rows only
lastHeardFromAt?: string;   // contact.last_heard_from_at, any type
```

`status` is omitted for a partner seed (a partner's `needs_review | active`
is not a tenant status and `StatusBadge kind="tenant"` must never see it).
This is a projection change in the resolver's push at `:158-168`; its
filters are untouched (section 3). `ResolvedContact` also feeds the send
path; the plan greps every consumer that snapshots or serializes it
(`broadcastsRepo` recipients map, `broadcastFanOut`) and proves the two new
fields are not persisted onto the broadcast item.

The preview response (`POST /api/broadcasts/:id/preview`,
`routes/broadcasts.ts:710-756`) gains, per candidate, `status?`,
`lastHeardFromAt?` and `declinedThisProperty: boolean`, AND a top-level
`declinedContactIds: string[]` - the analog of `priorRecipientContactIds`,
which exists precisely so a hand-added row outside the audience can be
annotated client-side (`RecipientPreview.tsx:110-113`, `:225`). An id is in
the list only when its decline is EFFECTIVE under D11, so the handler reads,
when the draft has a unit: `listingSends.listByUnit(unitId)`, then for the
rows that carry a `declined` record only, `tours.listByUnit(unitId)` and
`contacts.getManyByIds(declinedRowIds, { requireComplete: true })` for
their types, and runs `deriveSendOutcome`. Both lists are empty when the
draft has no unit. These reads serve labels, not outcomes with buttons, so
D12's 503 does not apply: when any of them fails, the preview still serves
its candidates with NO decline labels and `declineLabelsUnavailable: true`,
and the review step shows one line above the list ("Couldn't load
not-interested labels - a tenant who said no may be checked; sends still
work") rather than hiding the failure. The wording is honest: in this state
a declined tenant who is not also already sent starts CHECKED.

The dashboard row (`RecipientPreview.tsx`) renders, in this order: checkbox;
name (link, new tab as today); phone; status badge (`StatusBadge
kind="tenant"`, the Tenants tab's component; omitted when `status` is
absent); housing authority; last heard from (`formatHeardFrom`); tags. On
panes 768px and wider these are columns under a header row (Name, Status,
Housing authority, Last heard from); below that the row stacks: name and
phone on the first line, status + authority + last heard from on a second,
tags on a third. The stacked layout keeps the existing selectors the
mobile composer spec pins (`e2e/tests/dashboard-next/composer-mobile.spec.ts`,
if it touches the review step - the plan checks).

Order: the dashboard sorts the COMBINED list (audience rows and added rows
alike) by `lastHeardFromAt` descending, absent values last, ties by name.
One rule in one place (a `sortByHeardFrom` helper in
`dashboard/src/lib/heardFrom.ts`, shared with the Tenants tab); the server's
order stops mattering. An added row therefore slots into place rather than
appending at the end; it keeps its "Added" tag, and the list scrolls the
new row into view on add so a long list still confirms the pick.

Declined rows: a row whose contactId is in `declinedContactIds` (audience or
added) starts UNCHECKED unless it was hand-picked, carries a "Not
interested" tag in the same tone as "Already sent", and "Select all" skips
it exactly as it skips unpicked already-sent rows (`:79-93, 165-169`). Its
checkbox stays enabled. A declined row is USUALLY also already sent, but
not necessarily: "Already sent" is derived best-effort from broadcast
records (`shareRecipientState.ts:249-268`) while a listed send can be legacy
or individual with no broadcast behind it (`listingSendsRepo.ts:51`), so the
declined-unchecked rule stands on its own. Accessible name: `<name> -
already sent, not interested` when both tags apply, `<name> - not
interested` when only the decline applies. The e2e specs that select by
`already sent` are updated knowingly.

"Add a tenant": `ContactSearchField` gains an optional `annotate?: (c:
Contact) => string | undefined` prop that renders a muted suffix inside the
option (outside the committed `name`, per the component's own header rule at
`ContactSearchField.tsx:13`). The recipient preview passes one that returns
"Not interested" for a contactId in `declinedContactIds` and "Already sent"
for one in `priorRecipientContactIds`. This lands as its own commit AFTER
the verbatim C6 patch (section 5.8) and does not touch the C6 geometry code.

The send endpoint does not change: the dashboard's send carries an explicit
selection, so an unchecked row is not sent, and a deliberate check overrides
it (D4). The legacy no-body filter-resolve path is a stated non-goal.

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

The name is `declined`, never `response` (section 1).

Writers: `listingSendsRepo.setDeclined(unitId, contactId, record)` and
`clearDeclined(unitId, contactId)`, each an UpdateItem that SETs or REMOVEs
only `declined` (and `updated_at`), conditioned on
`attribute_exists(unitId)`. `putShareMemory` is already an UpdateItem that
SETs only its own attributes (`listingSendsRepo.ts:277-280`), so the two
writers never clobber each other. The NO-RESET invariant in the repo header
extends to `declined`: no writer resets it except `clearDeclined`. History
of a cleared decline lives in the activity and audit events below, not on
the row.

Effective decline (pure, `app/src/lib/sendOutcome.ts`), D11:

```
effectiveDecline(row, tour) =
     row.declined !== undefined
  && (row.sentAt === undefined || row.declined.at >= row.sentAt)
  && (tour === undefined || row.declined.at >= tour.latestActivityAt)
```

A decline is superseded by whatever comes later: a counted share (the row's
`sentAt` follows the latest counted share, `shareLedger.ts:112-120`) or tour
activity after it - a qualifying tour created, rescheduled or reopened, from
ANY tour-creating path (the Schedule tour form, the Tours page, the contact
page, the Interested action). Either means the tenant changed their mind. A
superseded `declined` record stays on the row and is simply ineffective.
Note: an acceptance-counted share that later fails moves `sentAt` back
(`listingSendsRepo.ts:56`), which can make a share-superseded decline
effective again; that is the honest reading (the superseding send never
arrived) and needs no handling.

A sibling pure function in `lib/listingSendTour.ts`,
`deriveTourActivityAt(tours): string | undefined`, returns the max over
EVERY qualifying tour for the pair of `max(createdAt, lastMarkedAt)` (the
model's own "last time a person marked / rescheduled / reopened it",
`toursModel.ts:214-218`; `lastMarkedAt` is absent until a person acts, so
`createdAt` carries a fresh tour). It is a SEPARATE function, not a field on
`deriveTourSignal`'s result, because that result IS the wire `tour` field
and route tests pin it with `toEqual({ tourId, state })`. NOT `updatedAt`:
that is last-touched-by-anything (`toursRepo.ts:559`) - opening a relay
group or a conversion claim bumps it - and would let an automated write undo
a decline. `lastMarkedAt` is stamped on ANY person-made status change or new
time (`routes/tours.ts:1328-1338`), including marking a tour Toured; so a
tenant who declined and whose tour is later recorded as Toured reads
Interested/Toured - accepted: the visit happened, and that is the honest
reading. It is
deliberately not the chip winner's own timestamp: the winner is the most
PROGRESSED tour (`listingSendTour.ts:41-45`), so a months-old toured tour
would otherwise hide a request made after the decline. A `requested`,
`scheduled`, `toured`, converted or auto-closed-from-toured tour qualifies,
exactly as for the chip; a canceled, no-show or not-a-fit tour yields no
signal and contributes no activity.

Derived outcome (same module, pure, every outcome-serving endpoint calls it):

```
export type SendOutcome = 'no_reply' | 'replied' | 'interested' | 'not_interested';

deriveSendOutcome({ row, recipientType, lastHeardFromAt, tour }):
  tourSignal = recipientType === 'tenant' ? tour : undefined   // partner rows never read a tour
  if effectiveDecline(row, tourSignal)          -> 'not_interested'
  else if tourSignal !== undefined              -> 'interested'
  else if lastHeardFromAt > row.sentAt          -> 'replied'
  else                                          -> 'no_reply'
```

`recipientType` matters: the tours API accepts any contactId as `tenantId`
and a tenant converted to a caseworker keeps tenant-era tours, so a partner
row CAN carry a tour signal in data; the function ignores it, and
`interestedSupported` below is derived from the same type.

Partner rows (D7). Tours require `tenantId` (`routes/tours.ts:325-327`) and
the caseworkers design keeps the tour relationship tenant-only, so "a tour
exists" is not a partner fact. Two options were weighed:

- Derive Interested for a partner from a tour on this property whose tenant
  lists the partner in `relationships[]` with a `contactId`. Rejected: the
  link is optional, usually name-only (`lib/contactProfile.ts:9-24` accepts
  a relationship with no contactId), and lives on the tenant, so the
  derivation would be silently absent for most caseworkers and would read
  as "not interested" when it is really "we do not know".
- RECOMMENDED: partner rows derive Replied / No reply yet / Not interested
  only, carry the Not interested action, and show a "Request a tour" link
  in place of the Interested button. The link navigates to the PROPERTY
  page with `?tour=new`, which opens the property page's existing Schedule
  tour host (`ListingDetail.tsx:1304-1312`) with the unit pre-committed and
  the tenant picker EMPTY - the contact-page host cannot be used because it
  locks `tenantId` to the page's contact (`ContactDetail.tsx:1306-1313`),
  which on a partner page is the caseworker. A caseworker's yes is always a
  yes for a specific client whom staff must name; the resulting tour then
  shows as Interested on THAT TENANT's row. The wire row carries
  `interestedSupported: false` for partner rows so the dashboard needs no
  type logic of its own. `POST /api/tours` ALREADY refuses a non-tenant
  `tenantId` since the caseworker-integrity merge (404 `tenant_not_found`,
  409 `{ error: 'contact_not_tenant', contactKind }`, `routes/tours.ts:350-359`
  via `services/contactTypeGuards.ts` `requireTenantContact`), and the
  Schedule tour form's picker offers tenants only (`ScheduleTourForm.tsx:180`);
  nothing new is needed there. The Interested route must call the SAME
  `requireTenantContact` before its own `toursRepo.create` (section 14).

Audit, dual-written like tours (`tours.ts:298-307`, `:392-396`):

- Contact timeline: new `ActivityEventType` members `listing_declined`,
  `listing_decline_cleared` and `listing_interested` (the one-click create's
  provenance, since a timeless tour create records no event today,
  `tours.ts:397-401`, and `TourItem` has no provenance field). The dashboard
  mirrors the union verbatim (`activityEventsRepo.ts:27-31`,
  `dashboard/src/api/types.ts:2703`) and the Timeline's variant switch
  (`Timeline.tsx:428-444`) gets labels: "Not interested in <address>",
  "Not interested cleared for <address>", "Interested in <address> - tour
  requested".
- Property Activity: `activity_events` is keyed per contact
  (`tables.ts:397-401`) and the property card reads the unit AUDIT trail
  (`units#<unitId>`, `units.ts:183-246`), so the same three events are also
  appended to the unit audit with the fixed-key whitelist projection and a
  humanized label ("<name> not interested", etc.). The dashboard's open-set
  rule ("Unknown types must still render (humanized), never blank",
  `types.ts:3119`) means an unlabeled type would show its raw name, not
  nothing; the labels are added.

Outcome endpoint - ONE route, the only way outcomes change:

```
POST /api/units/:unitId/recipients/:contactId/outcome
  { outcome: 'interested' | 'not_interested' | 'clear' }
  -> 200 { row: ListingSendRow }       (the row re-projected, with its new outcome)
  -> 404 { error: 'send_not_found' }   (no LISTED listing_sends row for the pair)
  -> 400 { error: 'interested_unsupported' }  (interested on a non-tenant row)
  -> 404 { error: 'unit_not_found' }
  -> 503 { error: 'outcome_unavailable' }     (a required join failed, D12)
```

- `not_interested`: `setDeclined` with `{ at: now, by: 'staff', staffId }`,
  then the two audit writes. Idempotent (a second call rewrites the same
  shape with a new `at`).
- `clear`: `clearDeclined`, then the audit writes. Idempotent.
- `interested` on a tenant row, in this order: (1) read the pair's tours
  (`tours.listByTenant(contactId)` filtered to `unitId`) and run
  `deriveTourSignal`; if ANY qualifying tour exists (the same set the chip
  uses - requested, scheduled, toured, converted, auto-closed-from-toured),
  no tour is created; (2) if no qualifying tour exists and the unit has no
  structured `tour_type`, refuse with 409 `tour_type_required` (D14: the
  dashboard never sends this request in that case - see the button rule
  below - so the refusal is a guard, not a flow); (3) if an effective
  decline exists, `clearDeclined` (the record is REMOVED; the
  `listing_decline_cleared` event is its history); (4) if no qualifying tour
  existed, create a `requested` tour through `toursRepo.create` with
  `tourType = unit.tour_type`, and ONLY then write `listing_interested` to
  both audit surfaces (a click that found an existing tour writes no event,
  and a retry after a failure is therefore not double-recorded); (5) return
  the re-projected row. A failure after step 3 leaves the row at Replied /
  No reply yet with its buttons back, which is recoverable by a second
  click. A failure in step 5 (the re-projection's join) after a successful
  write returns 503 with `saved: true`, and the row shows "Saved - reload to
  see the change" rather than claiming nothing changed.
- Audit writes (activity event + unit audit) are best-effort through the
  same shared writer tours use (`tours.ts:298-307`): a failed audit write is
  logged and never fails the route.
- The Interested BUTTON (D14): when the property has a structured
  `tour_type`, one click calls the route. When it does not, the click opens
  the Schedule tour form (`ScheduleTourForm`, which creates a timeless
  `requested` tour when the date is left empty, `ScheduleTourForm.tsx:3`,
  `:310-318`) with the tenant and property pre-committed, the guessed type
  shown with its existing "check it" caption, and no time; submitting it
  creates the tour through `POST /api/tours` as today (and navigates to the
  new tour's page, as both existing hosts do - acceptable: the tour exists,
  and Back returns to the card, which reads Interested on load through
  D11). `deriveTourType` stays where it is; nothing moves to the app. The
  hosts need these changes, which the plan carries as tasks:
  - the contact page's host pre-commits the LATEST sent property
    (`ContactDetail.tsx:1306-1313`); it gains a per-click `initialUnitId`
    override so the clicked row's property is the one pre-committed;
  - the property page's host passes no `tenantId`
    (`ListingDetail.tsx:1304-1312`); it gains a per-click `tenantId` from
    the clicked row, and the `?tour=new` entry (partner link, section 5.4)
    opens it with no tenant, while `?tour=new&tenantId=<id>` opens it with
    one;
  - the waiting list has no form host: its Interested action on a
    no-tour-type property navigates to the property page with
    `?tour=new&tenantId=<id>`. Every outcome-serving row therefore carries
    `interestedMode: 'route' | 'form'` (from the unit's `tour_type`), so no
    surface guesses.
- The `by: 'engine'` value is reserved for Work Package 3. This route always
  writes `staff`.

Outcome-serving endpoints and their joins (D12): `GET
/api/units/:unitId/recipients`, `GET /api/contacts/:id/listings-sent`, the
waiting list, and the outcome route all need the tours join and the
contacts join to derive a truthful outcome. Today both GET projections treat
those joins as best-effort (`units.ts:1002-1034`, `contacts.ts:1229-1248`)
because a missing chip or name was harmless, and the display batch read
silently DROPS keys it could not fetch (`contactsRepo.ts:943-951`,
`:986-998`) unless `requireComplete` is passed. An outcome drives buttons
and a to-do list, so on these endpoints:

- the contacts join is read with `requireComplete: true` (the display
  projection gains a `requireComplete` option, or the route uses
  `getManyByIds` with it), and a thrown tours query or an incomplete batch
  is a 503 `outcome_unavailable`; no row is ever served with a guessed
  outcome.
- a contact that is genuinely MISSING (a hard-deleted contact behind a
  listed row) is not "incomplete": the row is served with the id as its
  name, `recipientMissing: true`, its outcome `not_interested` when the row
  carries a decline not superseded by a later share, else `no_reply` (no
  type means no tour signal is read and no reply can be known),
  `interestedSupported: false`, no actions, and it falls in the property
  card's NOT ELIGIBLE group.
- the error surface per endpoint: the property card shows its error row
  ("We couldn't load recipients.", `ListingDetail.tsx:1057-1058`); the
  contact cards today render ANY non-ready slice as the pending panel
  ("Arrives with the backend.", `useContactFile.ts:51-61`,
  `ContactDetail.tsx:1134`, `Card.tsx:79-82`), so `listingsSent` gains an
  `error` rendering ("We couldn't load properties sent.") distinct from
  pending; the waiting list shows an error line in place of its rows; under
  option B the Today section degrades on its own (an error line in that
  section, the rest of Today served), never the whole Today payload.

Each listed GET projection gains, per row:

```
lastHeardFromAt?: string;
outcome: SendOutcome;
declined?: { at: string; by: 'staff' | 'engine' };   // present when effective
interestedSupported: boolean;                        // false on a partner row
```

The contact endpoint already does its tour join (`contacts.ts:1229-1248`,
one `tours.listByTenant` grouped by unitId - no second query); it adds the
contact's own `last_heard_from_at` and type (the contact is already loaded)
and the derivation. The wire type `ListingSendRow` in
`dashboard/src/api/types.ts:2943` mirrors the additions.

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
  interested" (muted) with the date in its title; "(auto)" appended when
  `declined.by` is `engine`.
- Line two, right, the actions, which depend on the outcome:
  - `no_reply` or `replied`: two small buttons, "Interested" (tenant rows
    only; partner rows show the "Request a tour" link) and "Not interested".
  - `interested`: no buttons (the tour chip links to the tour; cancel or
    close the tour there).
  - `not_interested`: one "Undo" button.
  Each action calls the outcome endpoint, disables itself while the call is
  in flight, and replaces the row with the returned one; a failure shows an
  inline error on the row and leaves it unchanged. Accessible names: "Mark
  <name> interested in <address>", "Mark <name> not interested in
  <address>", "Undo not interested for <name>"; the contact page's card uses
  the same shape with the property's short address.
- The property card's rows sort into four groups that together cover every
  row: WAITING (`no_reply` or `replied` on an ELIGIBLE recipient - section
  5.6's eligibility half only: not deleted, opted out or unreachable, not an
  inactive or placed tenant; the LOOKBACK and QUIET thresholds do not apply
  to the card), newest `sentAt` first; then `interested`; then
  `not_interested`; then NOT ELIGIBLE (a waiting outcome on a recipient who
  fails the eligibility half), each with its outcome chip and the same
  actions as its outcome (staff may still record Not interested on an
  inactive tenant). The units recipients projection therefore carries
  `deleted_at`, `sms_opt_out` and `sms_unreachable` as well as `status`,
  and the wire row carries `eligible: boolean`. Under section 9's option C
  this card IS the list, so the grouping honors D1 here too. The contact
  card keeps its newest-first order and shows the outcome on each row.
- Partner rows on the property card keep their kind label; partner pages'
  "Properties sent" rows now show the outcome chip and actions. A partner
  row never renders a tour chip (`deriveSendOutcome` ignores tours for it),
  which keeps the caseworkers ruling R3-F5.

### 5.6 The waiting list - the "Follow up" tab on Matching, plus a count on the Properties list

Decided 2026-10-13 (section 9): the list is option A, a "Follow up" tab on
the Matching page next to the send-history tabs (`BroadcastsList.tsx`
FILTERS), with a count in the tab label, grouped by property (the short
address as the group heading with its own waiting count), longest-waiting
first within a group and groups ordered by their oldest waiting row. Each
row: name (link to the contact), Sent <date>, Last heard from
<formatHeardFrom>, the outcome chip ("No reply yet, N days" / "Replied,
quiet N days"), and the actions Interested / Not interested / Text. Sam's
reading of the two chips is the design intent: Replied-then-quiet rows are
the ones she texts again; No reply yet rows are the ones she calls to learn
whether the tenant is still looking (the name link lands on the contact
page, where the call action lives; the list adds no Call action). Option
C's count comes with it: the Properties list's Available view shows "<n>
waiting" on each available property with waiting rows, from the same
response's `byUnit` map, so it costs one extra request per Properties list
load and no second walk. Option B (Today) is not built.

Mechanism:

1. Candidate sends: every LISTED `listing_sends` row on every unit in
   status `available` (`unitsRepo.listByStatus('available')`, then
   `listingSends.listByUnit` per unit). No new index: Sam's available
   properties number in the tens, so this is tens of Queries per request,
   cached per request and capped at 100 units (a WARN past the cap,
   `truncated: true` on the wire).
2. Join (required, D12): one `getManyByIds` batch for the contacts (status,
   type, name, `deleted_at`, `sms_opt_out`, `sms_unreachable`,
   `last_heard_from_at`), one `tours.listByUnit` per unit for the tour
   signal.
3. Keep a row when ALL hold. The first three are the ELIGIBILITY half
   (`isEligibleRecipient(contact)` in `sendOutcome.ts`, shared with 5.5's
   card grouping); the last two are the list's own thresholds:
   - outcome is `no_reply` or `replied` (not `interested`, not
     `not_interested`);
   - the contact is not deleted, not opted out, not unreachable, and has a
     phone (the resolver's own hard exclusions,
     `audienceResolution.ts:146-154`), so every row's Text action can work;
   - the contact is not a tenant in `inactive` or `placed` (D1);
   - `sentAt` is within the LOOKBACK window;
   - the contact has been quiet for at least the QUIET threshold, measured
     from `max(sentAt, lastHeardFromAt)`.
4. Order: longest-waiting first (oldest `max(sentAt, lastHeardFromAt)`).

Endpoint: `GET /api/broadcasts/follow-ups` (registered on the broadcasts
router, which owns Matching and is mounted at `/`; no new mount prefix, so
no CloudFront change - `/api/*` already has an all-methods behavior)
returning
`{ items: FollowUpItem[], byUnit: Record<string, number>, truncated: boolean }`
(`byUnit` = waiting rows per unitId, for the Properties list count) where

```
FollowUpItem {
  unitId, unitLabel,            // formatAddress(unit.address) || unitId, server-side (app/src/lib/address.ts)
  contactId, name, type, role?, // the recipient
  sentAt, lastHeardFromAt?, outcome, declined?, interestedSupported, interestedMode,
  waitingSince                  // max(sentAt, lastHeardFromAt)
}
```

No `conversationId` on the wire: the Text action calls the existing
idempotent `ensureContactConversation` (POST `/api/contacts/:id/conversation`)
and navigates to the returned thread. "N days" on a chip is
`floor((now - waitingSince) / 86400000)` on the browser's clock.

Thresholds, set from Sam's answers (section 9): QUIET = 24 hours (she asked
for "24 hours of silence at any stage"), LOOKBACK = 14 days. Both are
constants in `app/src/lib/sendOutcome.ts` (`FOLLOW_UP_QUIET_MS`,
`FOLLOW_UP_LOOKBACK_MS`).

Row actions on the list: Interested / Not interested / Undo as on the
cards, plus "Text" (opens the 1:1 conversation).

### 5.7 Tenants tab

`ContactsList.tsx` (filter = tenant only; the other contact views do not
change):

- Each row's meta line gains "Last heard from <formatHeardFrom>" after the
  facts span; "Never" when absent.
- A sort control (a labeled `<select>`, "Sort by": "Last heard from" |
  "Name"), URL state `?sort=heard|name`, default `heard` (no param). `heard`
  = `sortByHeardFrom` (most recent first, absent last, ties by the name
  comparator); `name` = case-insensitive `localeCompare` on last name, then
  first name, then the display fallback (phone or id). There is no existing
  sort to preserve; today's order is GSI byte order (section 1).
- A status filter chip group ("Status", the `FilterChips` component used by
  voucher and authority) listing the seven tenant statuses by their
  `StatusBadge` labels. This facet inverts the others' "empty =
  unconstrained" convention (`tenantFacets.ts:57-62`) and says so in code:
  - URL state: repeated `?status=<value>`; NO `status` param = the DEFAULT
    set (every status except `inactive` and `placed`); the sentinel
    `?status=_empty` = the EMPTY selection (zero rows, the ordinary "no
    tenants match" line), so deselection never locks - the chip contract at
    `ContactsList.tsx:216-218` holds for the last lit chip too. The
    sentinel is spelled unlike the module's existing `NONE_KEY`
    (`__none__`, "no voucher size", a different concept) on purpose. A URL
    carrying the sentinel AND status values reads as the values; the
    sentinel is dropped. "All seven on" is the way to see everyone.
  - Only a selection that differs from the default is written to the URL;
    selecting exactly the default set removes the param. A URL whose
    `status` values are all invalid prunes to the default, not to empty.
  - "Clear" for this facet returns to the DEFAULT set and is shown only
    while the selection differs from the default (`ChipGroup` gains a
    `baseline` prop so Clear is never a dead control; the other facets keep
    their empty baseline).
  - Status enters `buildFacets` like the other facets: voucher and authority
    chip counts reflect the status selection, and each status chip's count
    reflects the voucher and authority selection, so "a chip's number always
    states what clicking it does" (`tenantFacets.ts:217-226`) still holds.
    The `facetProbe` prune (`ContactsList.tsx:197-243`) drops invalid status
    values.
  - Search and status: the search box keeps filtering the visible list. When
    a query has no matches among the visible statuses but WOULD match a
    hidden one, the no-match line reads "No matches for <q> among the
    statuses shown" with a "Show all statuses" action that lights all seven
    chips; otherwise it reads as today.
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
verbatim (`git apply`) as its own commit, which changes only
`dashboard/src/routes/contact/ContactSearchField.tsx` and its test: the
fixed portal opens ABOVE the input when its contents do not fit below and
more room exists above, and its max height is bounded by the available
space with no 9rem floor. The three new unit tests it adds were proven red
on the old source and green on the new. All ten `ContactSearchField` render
sites inherit the fix. The `annotate` prop (section 5.3) is a later, separate
commit on the same file. Then: re-run the populated Matching case
(`e2e/tests/dashboard-next/matching-entry-points.spec.ts:228`) against the
reworked Review recipients step (section 5.3 changes the row height, so the
geometry must be re-proven, not assumed), and mark the issue resolved with
the date and commit.

## 6. Invariants and their surfaces

I1. `last_heard_from_at` never moves backward. Writers: `touchLastHeardFrom`
(the only live writer), the backfill and the importer (through it), the
seed derivation (direct, before the Put loop; `/__dev/reseed` re-Puts the
same derived items). Any other contact write (`statusTransition`, PATCH,
phone edits, caseworker conversion, soft-delete / restore) must not SET or
REMOVE it; the plan greps every `UpdateExpression` on the contacts table and
the PATCH allowlist (`routes/contacts.ts:706`, `:898`) to prove it is
neither accepted from a client nor cleared. Readers: section 5.1's list.

I2. The outcome is derived, never stored, except `declined`. No table, seed
or dev seam writes an `outcome` attribute. Writers of `declined`: the
outcome route only (`setDeclined` / `clearDeclined`); `putShareMemory`
never touches it. Readers: the two listed GET projections, the preview's
`declinedThisProperty` / `declinedContactIds`, the waiting list, the
activity and audit events.

I3. A pair has at most one open tour from the Interested action. The route
checks the full qualifying set before it creates; a concurrent double click
can still race two creates through `toursRepo.create` (no conditional write
on the pair, filed in section 11); the dashboard disables the button while
a call is in flight, which closes the practical case.

I4. Every seeded world is self-consistent: a seeded contact's
`last_heard_from_at` equals what the backfill would compute from its seeded
rows (one pure rule). The lean world's contact items change for this (D13);
e2e specs that assert "Never" or ordering on lean contacts are updated to
the derived values, and specs that need a fresh value send an inbound
through the fake carrier.

## 7. Edge cases

- A contact deleted then restored keeps the value (no writer clears it).
- A phone-only recipient (`phone#E164` recipient key, no contact) has no
  outcome row and no last heard from; the preview flags it as today.
- A send whose row is not LISTED (no share counted yet: pending, unconfirmed
  or failed) has no outcome; the outcome route returns 404 for it.
- A tenant converted to a caseworker keeps their tenant-era rows and tours;
  those rows report `interestedSupported: false` and ignore the tour signal
  because the contact's type is partner at read time.
- Two properties sent in one blast to one tenant: two rows, two outcomes;
  one reply marks both Replied. That is the D2 definition, stated on the
  mockups so Sam sees it.
- A tenant who texted STOP after a send reads Replied on the card (D2) and
  is left off the waiting list and the card's waiting group (5.6's
  recipient rule).
- Time zones: all comparisons are on ISO instants normalized through
  `Date.parse`; day thresholds are `ms >= N * 86400000`, not calendar days.

## 8. Verification

Unit (app): `touchLastHeardFrom` guard + forward-only + normalization +
swallow; each of the eight inbound paths touches (SMS and voice on both the
fresh and the deduped branch; email with the winner) and the dev fixture
seams touch; retry rows, the echo dedupe and an unknown-author email do
not; `attributeInbound` branch table including the keyless non-member
refused call and the never-a-roster-member fallback, and a conformance test
that each live path's touched id equals `attributeInbound` on the row it
wrote; `deriveSendOutcome` precedence table including the
partner-ignores-tour case; `effectiveDecline` supersession by share, by a
NEW tour behind an older toured tour, and by a rescheduled or reopened
tour; the outcome route's branches (existing tour, `tour_type_required`,
create, `listing_interested` written only on create, 503 with `saved`), and
the 503 on an incomplete batch; the backfill planner's attribution branches;
the seed derivation; the follow-ups builder's eligibility and thresholds and
ordering; preview `declinedContactIds` under D11 and its degraded flag;
`POST /api/tours` `tenant_required`.

Unit (dashboard): `sortByHeardFrom` and the name comparator; Tenants tab
default status set, Clear, counts, the hidden-match hint, sort and URL round
trip; `RecipientPreview` declined-row defaults, "Select all", the combined
accessible name and the added-row annotation; `ContactSearchField`
`annotate`; `SendRosterRow` outcome rendering, the four-group cover, and action
callbacks including the no-tour-type path opening the form; the contact
card's error rendering; the C6 tests; `formatHeardFrom`.

E2E (new or extended specs, accessibility-first selectors): (1) an inbound
text, a relay-group text, a call and an email each move last heard from on
the contact page; an outbound text does not. (2) Tenants tab: default
excludes an inactive and a placed tenant; the status chips bring them back;
the hidden-match hint; sort by last heard from orders a just-replied tenant
first; reload keeps the URL state. (3) Matching: columns present; order by
last heard from; a declined tenant shows unchecked with "Not interested",
both in the audience and when hand-added; checking and sending works. (4)
Property card: Interested creates exactly one tour, the tenant appears on
Needs booking, the row shows Tour requested; Not interested then Undo; a
tour scheduled from the Tours page after a decline flips the row to Tour
scheduled; the contact card mirrors the row. (5) The populated Matching
hand-pick case (C6) passes with ordinary clicks. (6) The Follow up tab: a
send older than 24 hours with no reply appears under its property with the
count in the tab; a reply through the fake carrier removes it; Not
interested removes it; the Properties list shows the "<n> waiting" count.
Gates per `AGENTS.md`.

## 9. Mockups for Sam (the waiting list, and the row design) - ANSWERED

Cameron showed Sam the mockups and brought back her answers on 2026-10-13.
The mockups are a static HTML page committed with this mission's records
(`docs/superpowers/reviews/2026-10-12-last-heard-from/mockups.html`) and
published privately for sharing. They show real-looking rows with the same
example data in each option, so the comparison is about place and shape,
not content. Each option states the rules in plain words (what counts as a
reply, when a send appears, who is left out).

Sam's answers and Cameron's rulings (the decisions the build honors):

1. Where: "Options A and C would both work." Ruling: build A (the Follow up
   tab) plus C's count on the Properties list; not B.
2. When a tenant appears: "after 24 hours of silence at any stage." Ruling:
   QUIET = 24 hours.
3. How far back: 14 days. Ruling: LOOKBACK = 14 days.
4. Replied-then-quiet: "really the goal of my list ... the ones I am looking
   for"; never-responded tenants "need a call ... to see if they are still
   looking." Ruling: both kinds appear, distinguished by the outcome chip
   (section 5.6).
5. Row contents / more outcomes: Sam proposed waiting until she has used
   Matching, and adding outcomes such as Maybe, Touring, Maybe after
   touring. Cameron's ruling (2026-10-13): build now - the work is what lets
   her run her current matching process on the platform, and #6 follows
   right after; and the outcomes stay the four, because "maybe" states are
   a mental burden applied inconsistently and each one lands in Interested,
   Not interested or unknown anyway. Sam's point that a touring tenant
   stays `searching` is correct and unaffected: a searching tenant with a
   tour still receives properties; nothing here changes statuses.

The original questions, kept for the record:

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
card groups waiting rows first (section 5.5 already does this) and the
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

Her answers are folded into sections 5.6 and 9 (5.5's row content stands as
proposed); the build no longer waits on Sam.

## 10. Estimates (Cameron's hours)

- #3: 5-8 hrs holds (field + 8 touch points + the one-rule conformance,
  backfill, seed derivation, Tenants tab incl. the status filter, Review
  recipients columns, roster card dates).
- #27: 3-5 hrs (outcome record + route + dual audit + cards + preview tags
  + waiting list); the tracker's 2-4 was provisional and did not include
  the waiting list's own screen.
- C6: 0.5 hr.
- Post-merge, Cameron's: run the backfill on dev then prod (dry run, then
  apply), per the RUNBOOK section the plan adds.

## 11. Filed alongside

- `docs/issues/tour-create-no-dedupe.md` (filed 2026-10-12, med):
  `POST /api/tours` creates a second `requested` tour for the same tenant
  and unit on a second click; no existence check and no conditional write.
  Fixed on the Interested path only (section 5.4); the Schedule tour form
  and the API's dedupe stay as they are (the `tenant_required` check is a
  type guard, not dedupe).
- `docs/issues/contact-search-popover-below-viewport.md`: resolved in this
  branch (section 5.8).
- `docs/issues/denormalize-contact-last-activity-for-ordered-paging.md`:
  this spec delivers the attribute (as `last_heard_from_at`, inbound-only)
  without the GSI; the issue stays open for the paged-feed half and gains a
  note pointing here.

## 12. Open questions

None. Sam's five are answered (section 9). Cameron confirmed D11, D12, D13,
D14 and the partner recommendation (section 5.4, D7) on 2026-10-12.

## 14. Plan-research amendments (revision 6, 2026-10-13; the tree at f6aba402)

Four readers checked every section against the merged tree
(`docs/superpowers/reviews/2026-10-12-last-heard-from/plan-research/*-findings.md`).
Each amendment below is a ruling on a finding; the finding ids are theirs.
Where an amendment contradicts an earlier section, the amendment wins.

14.1 Names and modules (matching A1). `app/src/lib/sendOutcome.ts` and the
type name `SendOutcome` already exist (the Twilio send-failure vocabulary,
`adapters/webPush.ts:28`). The new module is `app/src/lib/listingSendOutcome.ts`
(test `app/test/listingSendOutcome.test.ts`); the type is
`ListingSendOutcome`; the constants are `FOLLOW_UP_QUIET_MS` and
`FOLLOW_UP_LOOKBACK_MS` in that module. Every earlier mention reads as this.

14.2 Inbound attribution (inbound F1-F14):
- The email exception keys on `email_new_address: true` (section 5.1 as
  amended), never on `author`.
- `attributeInbound(row, thread, lookup)` is always ASYNC; `lookup.byPhone`
  / `lookup.byEmail` may return `T | Promise<T>`. Each live path computes its
  touch target by calling `attributeInbound` itself, passing the contacts it
  already resolved as a lookup cache; conformance is then true by
  construction rather than tested after the fact. Attribution and the
  touch use the PERSISTED thread (a deduped row may live on another
  conversation; the 1:1 path adopts it at `twilio.ts:2523`).
- The echo-dedupe direction check exists only where the persisted row is
  read back (the 1:1 and native group paths). On the relay, closed-late-text
  and three voice paths an echo cannot reach the append (voice drops a From
  equal to our own or a pool number, `voice.ts:574-584`; relay legs are sent
  from the pool number), so those paths touch on the deduped branch without
  the check. On the voice paths the touch sits INSIDE each try after the
  append. The two founder-path refusals that return before any append (no
  holder, self-call) leave no row and no touch; G1's "any outcome" means any
  outcome that produced a call row.
- Phone-only relay members (`relay_sender_key` = `phone#From`) resolve
  through `findByPhone` on paths 2, 6 and 7.
- `touchLastHeardFrom` returns `'written' | 'skipped' | 'failed'` and never
  throws; the CALLER logs a failure (the `touchPhoneLastSeen` shape, where
  the webhook owns the log line); the backfill counts all three and ABORTS
  on `failed` like the other ops scripts.
- The backfill walks group partitions to exhaustion (no roster early stop:
  non-members, staff from another org number, removed members and refused
  callers all sit below it). The agent-run proof is `--env local --lane <L>`
  only; bare `--env local` is the human's live stack.
- Seed derivation: runs in `seed/index.ts` AFTER the matrix merge (the full
  profile is lean + cast + matrix; matrix adds no messages so values are
  unchanged), returns COPIES of the contact items (the SEED and cast literals
  are shared with four tests and matrix), skips `phone#` claim rows, the
  `sid#` pointer row and the `phoneref#` contact row. Exact lean values:
  `contact-tenant-0001` = `2026-06-01T14:02:10.000Z`, `contact-landlord-0001`
  = `2026-06-01T13:45:00.000Z`; the other two lean contacts get none.
- Dev seams: both write branches of the message fixture (the append AND the
  direct Put) and the transcript fixture touch; `DevRouterDeps` gains the
  contacts and conversations repos it needs.
- Importer: `runApply` creates a `contactsRepo` from its `doc`; the stamp
  runs after `messageBatch.flush()`, is skipped on `dryRun`, resolves phones
  through the in-memory `contactIdByPhone` map (the byPhone GSI lags a fresh
  upsert, `twilio.ts:1972-1986`), and `ApplyReport` gains `lastHeardFromStamps`.
- I1's grep scope also covers `suggestionResolutionRepo.ts:872-1069`,
  `extractionRepo.ts:792` and `import/apply.ts:684-693, :798-804, :1181-1191`.

14.3 The outcome record and route (outcome A1-A7, B1-B12):
- `tenant_required` is DROPPED (A1). The Interested route calls
  `requireTenantContact(contacts, contactId)` before `toursRepo.create` and
  maps its errors exactly as `POST /api/tours` does (404 `tenant_not_found`,
  409 `contact_not_tenant`).
- `deriveTourActivityAt` is the sibling function (A4, section 5.4 as
  amended). Marking a tour Toured after a decline supersedes it (A3,
  accepted).
- Audit events get their OWN writer, `recordListingOutcomeEvent` in
  `app/src/lib/listingOutcomeEvents.ts` (A5): the tours writer needs a
  tourId and copies the landlord. Rules: the CONTACT's timeline only (no
  landlord copy - a decline is not deal news for the landlord), `refType:
  'unit'` with `refId: unitId` for all three events (`listing_declined`,
  `listing_decline_cleared`, `listing_interested`), and the unit-audit
  payload is `{ contactId, actor }` plus `tourId` on `listing_interested` so
  the Activity row links the tour. `by: 'engine'` is NOT whitelisted onto the
  property Activity wire; "(auto)" renders on the cards only. The route
  writes the timeline LABEL itself (`Timeline.tsx` renders the server label
  verbatim, `:467-469`) using `formatAddress` on the unit it already reads;
  the property Activity labels are added to `describeUnitActivity`
  (`listingFormat.ts:170-232`).
- The 404 `send_not_found` uses the exported `ledgerRowCounted`
  (`services/shareLedger.ts:102-104`) so an uncounted row is not declinable
  (B5); `setDeclined` / `clearDeclined` additionally condition on the row
  being counted (`counted <> :false`).
- D12's error-surface fix on the contact page is a PROP change (A7):
  `useContactFile` already yields `'error'` distinct from `'pending'`; the
  cards receive the slice status instead of a collapsed boolean.
- `UnitsRouterDeps` gains `activityEventsRepo` and `auditRepo` as needed;
  `api.ts` passes the shared instances (B1).
- `interestedMode` is server-provided where the unit is known (the units
  recipients route, the follow-ups list) and CLIENT-derived on the contact
  page from `file.units` (already loaded), so the contact listings-sent
  route gains no units join (B2).
- One wire contract per endpoint (B3), the full response list (B4), one
  eligibility rule including has-a-phone (B6), a `requireComplete` option on
  `getRecipientDisplaysByIds` (B7), per-row setters on `useListing` and
  `useContactFile` mirroring `setUnit`'s `forId` guard (B8), `ListingDetail`
  reads `?tour=new` / `?tenantId=` with `useSearchParams`, reacts while
  mounted and clears the params on close; the pre-committed tenant is LOCKED
  in the form (intended) (B9): all stated in the plan's contracts section.
- Soft-deleted property (B10): the cards show outcomes but NO actions on a
  deleted property, and the outcome route answers 409 `unit_deleted` for
  every outcome there. A soft-deleted tenant passes `requireTenantContact`
  by design and is simply NOT ELIGIBLE on the cards.
- The server stops attaching `tour` to partner rows on both GET projections
  (it knows the type now) (B11); PartnerFile's client-side drop becomes
  redundant and stays harmless.
- `Card.module.css` gains the two-line row, small-button and inline-error
  classes (B12). The tests at `listingSendsApi.test.ts` and
  `ListingDetail.test.tsx` that the change inverts (outcome C1, C2) are
  rewritten knowingly, never deleted; the PATCH-404 pin stays.

14.4 Matching (matching A2-A5, B1-B14, C1):
- A hand-picked declined row stays CHECKED and tagged (G3 as amended).
- The Follow up tab is its own view component and hook (`FollowUpView.tsx`,
  `useFollowUps.ts`), NOT a `BroadcastsFilter` value (the list hook sends
  every non-all filter as `?status=` and the server 400s). Tab state gains a
  URL: `?tab=follow-up` on `/broadcasts`, so the Properties pill can link
  there; the count fetch runs on Matching mount whatever tab is active; the
  tabs gain `aria-controls` / a `tabpanel` while they are touched.
- E2E (6) gets a hermetic dev seam: `POST /__dev/listing-send-fixture`
  (`{ unitId, contactId, sentAt }`, hermetic-local only like `/__dev/reseed`)
  that writes a LISTED, counted row with the given `sentAt` through
  `putShareMemory`. No threshold override on the endpoint.
- `BroadcastsRouterDeps` gains `listingSendsRepo` and `toursRepo`; `api.ts`
  passes the shared instances (A5).
- Hand-added rows take status, housing authority and last heard from from
  `tenantCandidates` (the raw contacts); partner seeds show a blank
  authority column (B6).
- Accessible names use ASCII " - " for all three tags (already sent, consent
  not recorded, not interested); the visible no-consent TAG keeps its text
  (B7). The 768px columns use `container-type: inline-size` on `.preview`
  with a header OUTSIDE the `<ul>` (every row stays one `li`, no header
  checkbox) and `scrollbar-gutter: stable` (B8). The `composer-mobile.spec.ts`
  hedge is dropped (B9). The added row scrolls with `scrollIntoView({ block:
  'nearest' })` (B10). Select-all: `seeded || (!alreadySent && !declined)`
  (B11).
- The 100-unit walk follows `lastEvaluatedKey` until 100 KEPT units or
  exhaustion (`byStatus` is hash-only; soft-delete filtering shortens pages)
  (B5).
- The Properties count lives in its own hook `listings/useFollowUpCounts.ts`
  (never in `useListings`, which ToursPage shares); the pill renders inside
  the row link's `.meta` on `status === 'available'` rows with a count > 0;
  a failed count fetch shows no pill and no error (B14).
- The preview's degraded flag is tested by making the reads reject (the
  harness ignores `requireComplete`) (B13).

14.5 Tenants tab and e2e (tenants F1-F18):
- A tenant with NO status or an off-list status is never hidden by the
  status facet and counts under no chip (F1).
- The perf harness's `resolveContactDetail` binds a default-VISIBLE tenant
  (not the first in GSI order, which is inactive) - a plan task (F2).
- `listing-activity.spec.ts:231, :261` (`/No reply/i` count 0) are rewritten
  to assert the absence of the retired response CONTROL, knowingly (F4).
- The contact header refreshes on navigation (no live update; E2E (1) reloads
  in a retry loop or reads `GET /api/contacts/:id`, and uses a fresh tenant
  per channel) (F5). The header line is its own span on the FACTS line with
  the header tokens, never appended to `buildFacts()`'s pinned string (F6).
- `formatHeardFrom(iso, now)` returns `{ label, title }`; an unparseable
  value renders "Never" (F7). `sortByHeardFrom(rows, { heardAt, name })`
  takes accessor functions so Contacts (`last_heard_from_at`, snake) and
  preview rows (`lastHeardFromAt`, camel) share ONE comparator (F8). Name
  order: last name, first name, formatted phone, contactId as the stable key
  (case-insensitive `localeCompare`; an absent last name sorts first) (F10).
- `TenantFacetModel` gains `status: FacetOption[]`; `TenantSelection` gains
  `status` (the three literals are updated); `applyToParams` writes `status`
  default-aware and `_empty`; `?sort=` has its own writer that merges into
  existing params like `updateSelection`; `NO_SELECTION`'s status is the
  full seven for the probe (F9).
- Hidden-match hint: shown only when the query matches a tenant that passes
  voucher, authority and porting but fails the status facet; a `<button>`
  "Show all statuses" (F11). Chips in `TENANT_STATUSES` order; the status
  group never uses `emptyLine`; `ChipGroup`'s `baseline` is optional and its
  Clear rule REPLACES `selected.size > 0` with "differs from baseline" (F12).
- The row line sits AFTER the Porting chip, with an explicit `flex: 0 0
  auto` and `.facts` staying the one compressible child; `Row` gets a
  `showHeardFrom` prop driven by `filter === 'tenant'` (F13). The sort
  `<select>` sits in TenantFilters' controls row, Tenants view only, after
  load (F14).
- E2E (1)'s call is the business-line miss (`placeCall` with `digit: null`);
  no e2e drives a member's relay call (unit-tested instead) (F18). The C6
  re-proof counts only in the full `npm run e2e` run (F17).

14.6 Plan-review amendments (2026-10-13, plan review round 1):
- Voice path 6 (a refused masked call): a non-member calling a pool number
  whose groups are all CLOSED never reaches the masked refusal handler - the
  router sends that caller to founder triage, i.e. path 5
  (`relayInboundResolution.ts:89-96`; plan review round 2) - so the
  "closed_thread non-member row with no fields" is unreachable today and
  path 6 is NOT changed. Path 5's tests pin the reachable case (a
  non-member whose groups are closed is triaged and touched). If the router
  ever routes such a caller to the masked handler, the external-caller
  fields must be written for any non-member regardless of refusal reason.
- `clear` on a row that carries NO `declined` record answers 200 and writes
  NO `listing_decline_cleared` event (a retry or a double click must not pin
  "cleared" on a timeline where nothing was declined); section 5.4's
  unconditional "then the audit writes" is narrowed accordingly.
- Known limit: an email row flagged `email_new_address` stays unattributed
  after staff link the address (the flag stays on the row); the contact's
  NEXT inbound counts, history is not rewritten.
- Accepted non-superseding tour writes: the placement conversion and an
  outcome-only close do not stamp `lastMarkedAt` and so never supersede a
  decline on their own; a converted tour already reads Interested through
  `deriveTourSignal`, and an outcome-only close yields no signal by design.

14.7 Build code-review amendments (2026-10-13, the build orchestrator, recorded in
`docs/superpowers/reviews/2026-10-12-last-heard-from/code-review/adjudications-round2.md`;
Cameron may reverse the first one - it is one function):
- Tour supersession of a decline is DURABLE (D11's intent: "a tour created ...
  by a PERSON after a decline means the tenant changed their mind, from any
  tour-creating path"). `deriveTourActivityAt` counts the `createdAt` of EVERY
  tour for the pair, qualifying or not, and the `lastMarkedAt` of QUALIFYING
  tours only. So a tour created after a decline keeps it superseded even after
  that tour is canceled, marked no-show or closed not-a-fit, whichever path
  created it (before this, a decline came back after the cancel on the Tours
  page path but not on the Interested path, which deletes the record - review
  round 2). A cancel / no-show / not-a-fit MARK never supersedes on its own:
  staff canceling a tour BECAUSE the tenant declined leaves the decline
  effective. Section 5.4's "a canceled, no-show or not-a-fit tour ... contributes
  no activity" is narrowed to its `lastMarkedAt`.
- The Interested route creates the tour BEFORE it clears the decline (5.4 steps
  (3) and (4) reversed), clears the decline record it READ whatever its
  effectiveness (compare-and-clear on its `at`, so a decline another staff
  member records meanwhile survives), records `listing_decline_cleared` only
  when that decline was effective, and answers 503 `{ error:
  'outcome_unavailable', saved: true }` for any failure after a write; `saved`
  is never sent when the click wrote nothing (an Interested that found a tour,
  an Undo with nothing to undo).
- Undo (`clear`) is the same compare-and-clear (review round 3, B R3-1): it
  removes the decline record it READ (conditioned on its `at`), and when it
  read none it writes nothing. A decline another staff member records while the
  Undo is in flight survives. Known limit (A R3-1, round 3): a STALE card's Undo
  or Interested still acts on the decline the server reads, not the one the
  card showed; closing that needs the client to send the decline `at` it
  displayed (a contract addition, filed as
  `docs/issues/outcome-actions-act-on-server-read-decline.md`).
- Known limits of durable supersession (review round 3): only a tour's CREATION
  is durable. A qualifying tour that was rescheduled or reopened after a decline
  supersedes it while it qualifies, but `lastMarkedAt` is one field, so a later
  cancel / no-show / not-a-fit mark overwrites the reschedule and the decline is
  effective again (A R3-1; a durable revival would need the tours PATCH to
  clear the decline - a product call). And a recipient whose type changes from
  tenant (a caseworker conversion) reads no tours at all (the "a non-tenant
  never reads a tour" rule), so a decline its tenant-era tour superseded is
  effective again (B R3-2).

## 13. Glossary additions

`documentation/GLOSSARY.md` gains: "last heard from" (the most recent
inbound text, call or email from a contact, any thread); "send outcome" (No
reply yet / Replied / Interested / Not interested, per property sent to a
contact; Interested = a qualifying tour exists, Not interested = a recorded
decline not superseded by a later send or tour); "waiting on a reply" (a
send at No reply yet or Replied whose recipient can be texted and has been
quiet past the threshold).
