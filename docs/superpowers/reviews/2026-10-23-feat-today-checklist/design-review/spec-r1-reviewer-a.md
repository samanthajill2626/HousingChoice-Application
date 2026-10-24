# Spec review r1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` (draft at f58d7b71).
Repo read at `W:\tmp\today-checklist` (branch feat/today-checklist, cut from 970a29b9).
Method: every claim below about current behavior cites a file:line I read. Anything
I could not verify is marked UNVERIFIED. No code, test or server was run.

Severity = consequence if it ships unfixed.

---

## F1. HIGH - Section 8's live-update premise is false; Tours to book and quiet-share drop-offs do not refresh live

The spec says (5.4) "Live refresh: tour.updated already triggers a Today refetch"
and (8) the existing triggers cover the new sections, listing "tour.updated
(Interested, a tour created, a tour booked)" and "conversation and message events
(a message either way)". It then decides "No new event is added (deliberate)".

What the code does:

- Tour CREATE emits no `tour.updated`. POST /api/tours ends at
  `app/src/routes/tours.ts:407-418`: it emits only `scheduled.updated` (and only
  for a scheduled create), and the comment says a requested create "emits
  nothing". Every `tour.updated` emitter in the app is a status change on an
  existing tour: `routes/tours.ts:1051,1656,1719`, `jobs/rosterActions.ts:161`,
  `jobs/tourAutoClose.ts:138`, `routes/placements.ts:904`,
  `services/rosterProvision.ts:511`.
- The Interested route creates the requested tour at `app/src/routes/units.ts`
  (outcome route, `tours.create({... status: 'requested' })`, ~1654) and
  `routes/units.ts` contains no `events.emit` at all. The spec contradicts itself
  here: section 8 lists Interested under tour.updated and, two sentences later,
  says the Interested route "emits no live event today" (the second is true).
- `useToday` subscribes to placement/conversation/suggestion/tour/contact events
  only (`dashboard/src/routes/today/useToday.ts:144-160`); it does NOT subscribe
  to `onMessagePersisted` (`dashboard/src/api/EventStreamProvider.tsx:45`). So
  "message events" are not a Today trigger.
- Two of the new STAMP writers emit no `conversation.updated`: the queued relay
  post W5 (`app/src/routes/api.ts:1971-1990`, deliberately no
  touchLastActivity) and the outbound call W7
  (`app/src/services/originateCall.ts:191-205`, deliberately no conversation
  stamp, only `message.persisted`).
- A property going unavailable (one of 6.1's drop-off rules) is not among the
  subscribed events (UNVERIFIED which event, if any, the listing-status PATCH
  emits; Today does not subscribe to a unit event in any case).

Consequence: the spec's own user story is two people (Sam and the VA) working
the same checklist. A tour requested in one session, or a quiet share cleared by
a call or queued relay post, does not appear/disappear in the other's open
Today. "Tours to book" - the section that exists precisely so a yes does not
fall off the checklist (5.4 rationale) - never appears live for anyone. The
"deliberate" no-new-event decision rests on a premise the code does not hold.
Fix: either add the events (tour create on both paths; a contact or Today hint
when last_reached_out_at moves) or state honestly that these sections refresh
only on remount/unrelated events and drop the 5.4 "Live refresh" line.

## F2. HIGH - Unknown contacts in Quiet shares cannot be cleared from the page the row opens

6.2 justifies "NO Interested / Not interested buttons on Today" because "the
contact page's Properties sent list already has the buttons". 6.1 puts unknowns
in scope (flyer leads; Follow up tab lists them, `services/followUps.ts:84-95`).

The unknown contact page has no Properties sent list: `UnknownFile.tsx:1-9`
"Deliberately omits the tenant cards (voucher / housing authority /
listings-sent / tours)", rendered for `kind === 'unknown'` at
`dashboard/src/routes/contact/ContactDetail.tsx:1302-1323`. Only TenantFile and
PartnerFile render the Properties sent rows (`PartnerFile.tsx:175-192`, Card.tsx
actions ~358-410).

Consequence: an unknown recipient who will never be interested sits in a
CHECKLIST section (it counts toward "done", 2.3) and the VA's only exits are to
text/call them (restarting the clock, which just defers the row 2-5 days) or to
find the Matching Follow up tab, which the spec never points to. Rule 2 ("clearing
the checklist means the day's follow-ups are done") cannot be met for these rows
from Today's own links. Also note for non-tenants Interested is never offered
(`followUps.ts:189` `interestedSupported: contact.type === 'tenant'`), so a
caseworker or unknown who says yes also has no exit except Not interested. The
spec must either route these rows to a surface with the action, add the
Properties sent card to UnknownFile (a scope change to name), or exclude
unknowns.

## F3. HIGH - Tours to book has no age bound and requested tours never auto-close; oldest-first surfaces the stalest

5.4: rows are every tour in status `requested`, oldest `createdAt` first, only
deleted tenants skipped; a tour drops off only on a status change.

- Requested tours never auto-close: `AUTO_CLOSE_STATUSES = ['scheduled',
  'toured', 'no_show']` (`app/src/lib/toursModel.ts:166`), consumed by
  `jobs/tourAutoClose.ts:26`.
- The read is the unbounded `listByStatus('requested')` walk
  (`app/src/routes/tours.ts:452`, `repos/toursRepo.ts:442`), no lookback.
- Nothing filters a placed or Inactive tenant, a soft-deleted or no-longer
  available property, or a tenant who already has a later scheduled tour for
  the same unit.

Consequence: every abandoned Interested click accumulates forever, and
oldest-first guarantees the first 5 rows are the least actionable ones. Rule 1
("only things that must happen today") is violated by construction, and "All
caught up" becomes reachable only by manually canceling historical requests.
Prod count of requested tours is UNVERIFIED - the spec cites prod volume for
quiet shares but not for this section. Needs: a prod count, and an explicit
staleness/eligibility rule (or a deliberate "no bound" ruling with the count
that justifies it).

## F4. MEDIUM - "Tours today" compact rows need time and property, which the wire does not carry

2.4: compact rows "(time, tenant, property)", "Same source and rule". The
server row is `{ who: tenant, why: 'Tour today', tag: 'Tour' }`
(`app/src/routes/today.ts:556-563`); `TodayItem` has no time or property field
(`today.ts:98-107`), and section 3's wire contract adds none. The server also
orders by tenant name, not time (`today.ts:1071-1081`), so a time column would
render out of order with "unchanged" ordering. The builder must invent a wire
change (or extra client fetches) the spec does not authorize. Specify the
fields and the order.

## F5. MEDIUM - The per-contact outreach clock lets any share or broadcast hide every other quiet share for that person

`last_reached_out_at` is per contact (7.1) and stamps on every share (W8) and
every staff message in any thread. quietSince takes the max over it (6.1).
Consequences the spec does not confront:

- A tenant who is sent a new property every 4 days and never replies is never
  `no_reply`-quiet for 5 days on ANY property, so never appears - the person
  rule 2 most needs is the one the mechanism hides.
- The fan-out path W8 is also used for unit-less broadcasts: `broadcast.unitId`
  is optional (`app/src/routes/broadcasts.ts:6`, fan-out at
  `jobs/broadcastFanOut.ts:486-489`), and the stamp sits at the same send
  call (`broadcastFanOut.ts:923-944`). One general announcement to all tenants
  would empty Quiet shares for 2-5 days. The spec names only "shares".
- W8 says "every share, whatever its automated flag", while 7.2 says automated
  sends do not count; `automated` is `created_via !== 'dashboard'`
  (`broadcastFanOut.ts:929`). The two rules disagree for any non-dashboard
  share (none exist today per `repos/broadcastsRepo.ts:214`, so the conflict
  is latent).
- The replay figure "staff outreach removed only 0-3 rows a day" is UNVERIFIED
  and it is not stated whether the replay counted shares and broadcasts as
  outreach. If it did not, the number does not support the design.

Either make the clock per (contact, unit) for shares, exclude shares/broadcasts
from the restart, or record the ruling with these consequences stated.

## F6. MEDIUM - The call stamp at originate fires when only the navigator's own cell rang

W7 stamps at `services/originateCall.ts ~171` "on any attempt". The row there is
written right after `adapter.initiateCall` rings the NAVIGATOR's cell
(`originateCall.ts:153-160`), before the target is dialed; the code's own
comment says a never-accepted originate (unanswered cell, whisper timeout, DNC
re-check) "emits no <Dial>" (`originateCall.ts:192-198`). So a call the contact
never received restarts their quiet clock. 7.2 says "a call counts on ANY
attempt, answered or not" - an attempt to reach the CONTACT. The mechanism
should stamp where the target is actually dialed (the <Dial action> / status
path the comment names), or the ruling should say navigator-leg attempts count.

## F7. MEDIUM - Staff-composed relay intros are classed as system messages

The "do not stamp" table lists relay announcements (intro) as `author 'system'`.
But the intro body is staff-composed: `introBody` is accepted on POST
/relay-groups (`app/src/routes/relayGroups.ts:435-479`), POST
/tours/:id/relay (`routes/tours.ts:1843-1852`) and POST /placements/:id/relay
(`routes/placements.ts:1595-1603`), stored as `intro_body`
(`repos/conversationsRepo.ts:2022`). Creating a relay group with a written
intro is a staff message to every member, by 7.2's own definition ("messages
... that staff send themselves, in any thread"). Decide it explicitly.

## F8. MEDIUM - Past tours: heading count, Show all and the new order do not agree with the loader

- 5.3 says the heading count is "the existing `total`". `total` is the Past
  tab's row count including deleted tenants' tours that Today skips
  (`dashboard/src/routes/today/useTodayPastTours.ts:51-55, 167-174`). So
  "Show all N" can expand to fewer than N rows, and the count can be non-zero
  while `rows` is empty.
- The source is not only `selectPastTours`: it is
  `[...selectPastTours(rows), ...selectOffRangeTours(toured)]`
  (`dashboard/src/routes/tours/useTours.ts:324`). Off-range rows are UNDATED or
  FUTURE-dated toured tours (`useTours.ts:217-246`). "OLDEST scheduledAt first,
  ties by tourId" does not say where undated rows go (an empty-string compare
  would put them FIRST) or that future-dated rows go last. Specify.
- "Show all labels the remaining rows on demand" - `labelRows` stops at
  TODAY_PAST_TOURS_CAP (`useTodayPastTours.ts:116`) and the cap is a shared
  export also pinned by `useTours.test.ts:298-300`; the spec should say
  whether the cap changes or a second labeling pass is added.

## F9. MEDIUM - The Identify help line tells the VA to mark people Inactive who are not unknowns

Identify takes "exactly the rows that today render ... as New unknown contact"
(5.2). Those include:

- Active team members: their threads are `unknown_1to1`
  (`app/src/lib/voiceMasking.ts:28-38` default branch;
  `routes/today.ts:756-758` "team_member threads are unknown_1to1 too and an
  Active team member keeps today's row").
- Typed contacts holding an `unknown_1to1` thread: every imported 1:1 thread is
  minted unknown_1to1 and a second number can keep one (`today.ts:761-768`;
  `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`).

The new copy "We don't know yet who these are. Call each one; after about a
week with no contact, mark them Inactive" is wrong for both. For a typed tenant
it is harmful: the Inactive skip only applies to unknown/team_member owners
(`today.ts:773-781`), so the row stays, while Inactive makes the tenant
ineligible for every share (`lib/listingSendOutcome.ts:116-128`). The spec must
either exclude these rows from Identify or reword the help line; a label change
that issues instructions has to be true for every row it covers.

## F10. MEDIUM - Existing tests that pin the old page are not enumerated

Section 9 lists new tests only. These existing specs assert the shape this
change removes or moves, and will fail:

- `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:74,87`
  (group `needs_you_now`, list "Needs you now" for a New unknown contact).
- `e2e/tests/dashboard-next/unknown-inactive.spec.ts:135` (server truth reads
  `needs_you_now` contact rows) and its narrative lines 6-19, 321.
- `e2e/tests/scenarios/participant-names.spec.ts:46` (Unreplied).
- `e2e/tests/flows/conversation-fact-extraction.spec.ts:357,402,430` and
  `e2e/tests/dashboard-next/caseworkers.spec.ts:88` (list "AI suggestions to
  review" - now renamed AND collapsed by default, so the list is not in the DOM
  until opened).
- `e2e/tests/dashboard-next/tours-page.spec.ts:188,267` (list "Tours today").
- Unit: `dashboard/src/routes/today/Today.test.tsx`, `buildToday.test.ts`,
  `useTodayPastTours.test.tsx`, `dashboard/src/routes/tours/useTours.test.ts`
  (cap), and the today route tests.

The spec also never states the accessible names (heading / list `aria-label`)
of the new and renamed sections - Today.tsx uses the heading text as the list
name (`Today.tsx:322-324`), and the e2e selector policy is
accessibility-first. Name them so the spec updates are deterministic.

## F11. MEDIUM - Running buildFollowUps on every /api/today load is an unexamined cost

`buildFollowUps` walks available units (cap 100), then two Queries per unit
with recent sends, then a requireComplete contacts batch
(`app/src/services/followUps.ts:110-163`). Today is refetched on every
conversation/placement/tour/contact/suggestion event, per connected dashboard,
debounced only 300 ms (`useToday.ts:41,131-160`). A share fan-out emits a
`conversation.updated` per recipient (`services/sendMessage.ts:723`), so a blast
re-runs the whole follow-ups read per tick per open Today. The Follow up tab
pays this only when opened. The spec does not discuss read amplification or
caching. Separately, 6.4 narrows the failure to "the required contacts read is
incomplete", but the existing route 503s on ANY rejection of buildFollowUps
(`routes/broadcasts.ts:1410-1418`); the Today wrapper must catch all of them
(units walk, listByUnit, tours.listByUnit), and the wire has no `truncated`
flag although the builder can truncate at FOLLOW_UPS_UNIT_CAP
(`followUps.ts:37,126-128`).

## F12. LOW - W1 cannot stamp "the recipient the send judged" at the call site without changing the service contract

The judged recipient (`heldRecipient ?? phoneContact`) is local to the service
(`services/sendMessage.ts:493-511`); `SendMessageOutcome` returns only
conversationId/providerSid/tsMsgId/status (`sendMessage.ts:400-405`). The route
(`routes/api.ts:1564`) cannot know it. The spec should say the outcome gains
the recipient id. Also, the service emits `conversation.updated` before
returning (`sendMessage.ts:723`), so a route-level stamp lands after the event
that triggers the Today refetch; the 300 ms debounce usually hides this race,
it does not close it.

## F13. LOW - The seed derivation (W11) contradicts 7.3's own premise

7.3 argues the stamp must be at call sites because "no stored field separates
staff from automated sends". W11 then derives the field from seeded outbound
rows, which carry exactly the stored fields 7.3 says are insufficient; the
lean seed's outbound rows carry no `automated` flag at all (grep of
`app/src/lib/seed/lean.ts`). Say which seeded rows count, or derive only from
an explicit per-row seed marker.

## F14. LOW - Section 3 contradicts itself about the fallback, and leaves its quiet-shares state undefined

"The fallback ... assembles no `identify`, `tours_to_book` or quiet shares" is
followed by "Its unknown_1to1 rows move from `needs_you_now` to `identify`".
Both cannot hold. The fallback also emits every unknown_1to1 conversation
regardless of unread (`dashboard/src/routes/today/buildToday.ts:300-317`),
unlike the server. And 2.3 withholds "All caught up" when quiet shares is
unavailable, but the fallback returns no `quietShares` at all
(`useToday.ts:75-79`) - say whether absent means unavailable.

## F15. LOW - Where the new unknown-only filter sits relative to the deleted-contact skip is unspecified

Section 4 says keep only unknown_1to1 "BEFORE the 100-row cap" and that the
deleted-contact and Inactive skips "stay where they are". The deleted skip does
a memoized `getById` for every walked 1:1 item (`routes/today.ts:743-747`,
cost comment 731-742). If the new type filter is placed after it, every known
thread still costs a contact read for a row that now emits nothing. Put the
type filter first and say so.

## F16. LOW - "Oldest contact first" is computed over capped, unordered reads

Identify's two sources are the newest-activity-first unread walk capped at 100
kept rows (`today.ts:704-787`) and the (unknown, needs_review) partition read,
whose range key is constant so the order is not recency (`today.ts:883-893,
945-949`), filled to 100. Sorting the union by created_at shows the oldest of
an arbitrary subset, and the heading's "full count" is a capped count. Fine at
small volume; state the cap so nobody reads it as exhaustive.

## F17. LOW - Two slogans the mechanism does not deliver

- Subtitle "Clear every section above the line and the day's follow-ups are
  done" and rule 2 ("Everything that must happen today is on it") while known
  1:1 unread replies (Unreplied removed, section 4) and unmatched email are
  deliberately off the page. The ruling is the human's; the copy should not
  claim completeness it excludes by design.
- "The lower section must never be the largest part of the page" (1) is not
  enforced by anything and is false whenever the checklist is empty and Tours
  today has rows (2.3 renders At a glance under "All caught up").

## F18. LOW - Small inaccuracies a builder will trip on

- `touchLastHeardFrom` returns `'written' | 'skipped' | 'failed'`
  (`repos/contactsRepo.ts:982, 2034`), not 'moved'. Its pointer-row guard
  (`contactsRepo.ts:2008-2012`) must be copied too.
- "the same three places last_heard_from_at sits": it sits in the ContactItem
  type (`contactsRepo.ts:234`), RecipientDisplay (`:406`), the projection
  (`:1106`) and SERVER_OWNED_CONTACT_FIELDS (`routes/contacts.ts:312-317`,
  used by both create and PATCH parsers at `:576,:868`) - four, and the create
  path is the one most easily forgotten.
- W4 stamps every member with a contactId at post time, including a member
  suppressed per-phone (`isMemberSuppressed`, the secondary-number STOP case
  `today.ts:615-629`) whose leg is never sent and who can still be an eligible
  quiet-share candidate (contact flag unset).
- `routes/today.ts:6-11` says the grouping rules MUST match
  `docs/superpowers/specs/2026-06-16-new-dashboard-design.md` "Today action
  queue"; section 10 does not update or supersede it.
