# Today as the daily checklist - design (tracker #31)

Status: DRAFT for review. Branch `feat/today-checklist`, cut from `main` @970a29b9.
Tracker: HousingChoice Improvements Tracker item #31 (Oct 16 meeting with Sam,
Oct 18 and Oct 23 decisions). Mockups shared with Sam (Design canvas
https://claude.ai/artifact/673Q7i9fjQ7zWAH1XydJ5v); Sam picked quiet-shares
option C on 2026-10-23.

## 1. Goal

Sam and her new virtual assistant (VA) use Today as their start-of-day and
end-of-day checklist. Two rules decide what is on the page (Cameron,
2026-10-23):

1. Today holds only things that must happen today - no FYIs, nothing that can
   wait.
2. Everything that must happen today is on it. Clearing the checklist means
   the day's follow-ups are done.

Two reference items stay, in a small lower section that never counts toward
"done": Tours today (Sam likes it at a glance) and AI suggestions, collapsed to
one line. The lower section must never be the largest part of the page.

The VA uses a normal staff login. No roles or permissions change.

### 1.1 Non-goals

- The Matching page's Follow up tab, its 24-hour rule and its wire shape.
- "Last heard from" and `last_heard_from_at` (inbound only, unchanged).
- Showing `last_reached_out_at` anywhere, or a backfill of it.
- Interested / Not interested actions on Today rows.
- New roles or permissions for the VA.
- An agent that sends as staff (future; only the hook point is designed).

## 2. The page, top to bottom

The page has two parts: the checklist, then a dashed divider and the
"At a glance" section.

| # | Section (heading) | Source | Order (the first 5 shown) |
|---|---|---|---|
| 1 | Needs you now | server group `needs_you_now` | unchanged (most urgent first) |
| 2 | Identify these contacts | server group `identify` (NEW, split from needs_you_now) | oldest contact first (section 5.2) |
| 3 | Past tours needing an outcome | client, Past tab loader (unchanged source) | OLDEST tour first (changed, section 5.3) |
| 4 | Tours to book | server group `tours_to_book` (NEW) | oldest request first |
| 5 | Quiet shares | server list `quietShares` (NEW) | section 6 |
| 6 | Relay groups to close | server list `relayCloseNags` (moved down) | unchanged |
| 7 | Placements | server group `follow_ups` (heading renamed from "Follow-ups due") | unchanged |
| - | At a glance: Tours today | server group `tours_today` (moved down, compact rows) | unchanged |
| - | At a glance: AI suggestions | server group `ai_suggestions` (one collapsed line) | unchanged |

Removed: the Unreplied section (Oct 16: the Inbox badge already covers it).
Not added: unmatched email (it has its own nav badge, the same reason
Unreplied goes).

Page subtitle: "Clear every section above the line and the day's follow-ups
are done." (The current subtitle "What needs you, across every placement and
contact." is replaced.)

Rejected layouts, so nobody re-proposes them: a jump row of section links at
the top (Cameron: it reads as a filter bar); chips or badges per person in
quiet shares (Cameron: "All of those badges look terrible").

### 2.1 Every section shows 5 rows

- Each section shows its first 5 rows. The heading carries the section's full
  count.
- When a section has more than 5, a "Show all N" button under the list expands
  it in place. Once expanded, the button reads "Show fewer" and collapses it.
  Expansion is per-viewer page state only (lost on reload; not stored).
- Past tours keeps its existing "See all N on the Past tab" / "Open the Past
  tab" link as well, beside its Show all button.
- Quiet shares applies the limit to PROPERTY lines, not people (section 6.3).
- An empty section is not rendered (unchanged rule), so an empty checklist
  section takes no space.

### 2.2 Help lines

Each checklist section has one short help line under its heading, written for
the VA (copy as in the mockups):

- Identify these contacts: "We don't know yet who these are. Call each one;
  after about a week with no contact, mark them Inactive."
- Tours to book: "Said yes to a property; the tour has no date yet. Oldest
  first."
- Quiet shares: "Properties sent in the last 14 days. Replied and then went
  quiet for 2+ days, or never replied in 5+ days. A message or call either way
  restarts the clock."
- Needs you now, Past tours, Relay groups to close and Placements: no help
  line (their rows already say why).

### 2.3 All caught up

"All caught up" shows when every CHECKLIST section (1-7) is empty and settled.
The At a glance section still renders below the message. Tours today and AI
suggestions never keep the page from reading as done.

- A section that failed to load is not empty: it shows its own error, and the
  page does not claim "All caught up".
- The existing settle rule stays: the message waits for the past-tours section
  to settle so it never flashes above rows about to appear.

### 2.4 At a glance

Below a dashed divider, headed "At a glance":

- Tours today: compact rows (time, tenant, property), same 5-row limit. Same
  source and rule as today's Tours today group.
- AI suggestions: ONE line, "AI suggestions for N contacts", collapsed by
  default. Opening it shows the rows (same 5-row limit and Show all). N is the
  server's contact-row count (capped at 20 today, unchanged).
- When both are empty the At a glance section is not rendered.

## 3. Wire contract (GET /api/today)

`TodayGroup` becomes:
`'needs_you_now' | 'identify' | 'tours_to_book' | 'tours_today' | 'follow_ups' | 'ai_suggestions'`.

- `unreplied` is removed from the server, the dashboard types and the
  client-side fallback (`dashboard/src/routes/today/buildToday.ts`).
- The fallback (used only when GET /api/today 404s) assembles no `identify`,
  `tours_to_book` or quiet shares, the same way it already assembles no
  `ai_suggestions`. Its unknown_1to1 rows move from `needs_you_now` to
  `identify` so both paths agree on where they render.

`TodayResponse` gains one field:

```
quietShares:
  | { status: 'ok'; properties: QuietShareProperty[]; people: number }
  | { status: 'unavailable' }

QuietShareProperty {
  unitId: string;
  unitLabel: string;          // same formatter as the Follow up tab
  people: QuietSharePerson[]; // replied first, then never replied (6.2)
}
QuietSharePerson {
  contactId: string;
  name: string;               // same name rule as the Follow up tab
  type: string;
  role?: string;              // caseworker role, as on the Follow up tab
  state: 'replied' | 'no_reply';
  quietSince: string;         // ISO; the clock in section 6.1
}
```

`people` is the number of DISTINCT contacts across all properties (the heading
count). A person waiting on two properties is one person in the count and a
row under each property.

## 4. Unreplied removal and the unread pass

- The Unreplied group is gone. Known one-to-one unread threads appear only in
  the Inbox (and its badge).
- The unread index walk in `app/src/routes/today.ts` now exists only to find
  unknown_1to1 threads for Identify. Its collect loop keeps only
  `unknown_1to1` threads BEFORE the 100-row cap, so known threads that would
  emit nothing cannot spend cap slots (the filter-then-cap rule already
  documented there). The deleted-contact skip and the #30 Inactive skip stay
  where they are, ahead of the cap.
- #30 (feat/unknown-inactive) is already on main: an Inactive unknown or team
  member's unknown thread is skipped there, and `isEligibleRecipient` drops
  every Inactive contact. This design keeps both behaviors unchanged. The code
  comment that says Inactive tenants' typed threads "feed Unreplied (tracker
  #31 owns that section)" is updated: they now feed only the Inbox.

## 5. Sections in detail

### 5.1 Needs you now

What stays: due hard clocks (RTA window closing, voucher expiring), escalated
placements, relay opt-out attention rows. Order unchanged. The "New unknown
contact" rows leave for Identify.

### 5.2 Identify these contacts (new group `identify`)

- Rows: exactly the rows that today render in Needs you now as "New unknown
  contact" - from the unread unknown_1to1 pass and from the
  (unknown, needs_review) triage partition, with the existing de-dupe by phone,
  group-detection-stub exclusion and #30 Inactive skip. Only the group changes.
- Row text unchanged: who + "New unknown contact"; links to the contact page.
- Order: oldest contact first by the contact's `created_at` (Cameron's ruling
  that every limited section lists oldest or most urgent first; oldest
  unknowns are the ones due a call or an Inactive mark). A row whose contact
  has no `created_at` sorts last, then by refId.

### 5.3 Past tours needing an outcome

- Source unchanged: the Past tab's rows (`selectPastTours`), deleted tenants
  skipped.
- Order changes on Today only: OLDEST scheduledAt first, ties by tourId. This
  reverses the Sep 29 "five most recent" ruling (Cameron, 2026-10-23) so the
  oldest tours do not wait for the two-week auto-close. The Past tab's own
  order (most recent first) is unchanged.
- Show all labels the remaining rows on demand (the section point-reads names
  only for rows it shows, as now).
- The heading count is the Past tab's row count (the existing `total`).

### 5.4 Tours to book (new group `tours_to_book`)

- Rows: every tour in status `requested` - the Tours page's Needs booking list
  (`getTours({ status: 'requested' })`), read server-side through the same
  repo query. Deleted tenants skipped (the Today rule).
- Order: oldest `createdAt` first (as Needs booking).
- Row: who = tenant name; why = the property's address; links to the tour
  page. A tour drops off when it gets a date, is canceled or closed - any
  status change away from `requested`.
- Live refresh: tour.updated already triggers a Today refetch.

Why this section exists: Interested creates a requested tour with no date, and
creating a tour removes the tenant from quiet shares (section 6). Without this
section, a tenant who says yes falls off the checklist entirely at the moment
they need booking.

### 5.5 Relay groups to close

Unchanged rows, Close / Keep-open card and behavior; it moves from the top of
the page to position 6 and takes the 5-row limit.

### 5.6 Placements

The `follow_ups` group (due follow-up deadlines and derived "Stuck - needs a
check" rows), unchanged, under the heading "Placements".

## 6. Quiet shares

### 6.1 The rule

Candidates are exactly the rows the Matching page's Follow up tab can list
(`app/src/services/followUps.ts` `buildFollowUps`): listed sends on available
properties, sent within the last 14 days (FOLLOW_UP_LOOKBACK_MS), outcome
`no_reply` or `replied`, recipient eligible (`isEligibleRecipient`). Every
contact type the Follow up tab lists is in scope (tenants, caseworkers,
unknowns) - Cameron, 2026-10-23.

For each candidate:

```
quietSince = max(sentAt,
                 last_heard_from_at   if later than sentAt,
                 last_reached_out_at  if later than sentAt)
threshold  = 2 days  when outcome = replied   (they replied, then went quiet)
             5 days  when outcome = no_reply  (never replied)
shown      = now - quietSince >= threshold
```

- Days are fixed durations (48h and 120h), matching how the existing 24h and
  14-day constants work; not calendar days.
- `state` on the wire is the outcome (`replied` / `no_reply`). A person who
  never replied keeps `no_reply` even after staff reached out again; staff
  outreach restarts the clock but does not change the state.

A person drops off when any of these happens (all but the clock are existing
Follow up tab rules):

- staff mark them Interested or Not interested, or a tour is created for them
  on that property;
- any new message, call or email either way restarts the clock (inbound moves
  `last_heard_from_at`; staff outbound moves the new `last_reached_out_at`,
  section 7);
- the send passes 14 days old;
- they become ineligible (opted out, unreachable, Inactive, placed, deleted,
  no phone) or the property stops being available.

### 6.2 What a person row shows

- Name (the Follow up tab's name rule, so unknown contacts show their phone),
  a role tag for a caseworker, then the quiet text and a state tag:
  - replied: "Replied, then quiet N days", tag "Replied";
  - no_reply: "No reply in N days", tag "No reply yet".
  N = whole days since quietSince, rounded down.
- The row opens the contact's page. NO Interested / Not interested buttons on
  Today (Cameron, 2026-10-23): deciding needs the conversation in view, and
  the contact page's Properties sent list already has the buttons.
- Inside a property: `replied` people first, then `no_reply`; within each,
  the longest quiet first (oldest quietSince); ties by contactId.

### 6.3 Layout: option C, grouped by property (Sam, 2026-10-23)

- One expandable line per property: the address, then a summary such as
  "7 people: 2 replied, then quiet - 5 never replied". A zero part is left out
  ("3 people: 3 never replied"); one person reads "1 person: ...".
- Properties are ordered by their longest-quiet person (oldest quietSince
  first); ties by unitId.
- The first property is open by default; the rest are folded. Opening and
  folding is per-viewer page state; a live refetch keeps the viewer's choices
  by unitId, and a newly appearing property starts folded.
- The 5-row limit counts property lines: with more than 5 properties, "Show
  all N properties" expands in place. An open property shows all its people.
- The heading count is `people` (distinct contacts).
- Each property line is a button with `aria-expanded`; the people list is a
  list with an accessible name naming the property.

Prod volume (read-only replay, 2026-10-23): about 17-26 people a day since
Oct 16 across about 5 properties; peak 44 on Oct 12, left over from a blast. In
the last 14 days all 116 shares went to one person each. A normal day fits in
the 5 property lines without Show all.

### 6.4 Failure isolation

The Follow up tab answers 503 when its required contacts read is incomplete.
On Today that failure must not fail the page: the route still answers 200 with
`quietShares: { status: 'unavailable' }`, logs the failure (ids and counts
only), and the section shows "We couldn't load quiet shares." with a retry by
reload, like the past-tours section error. "All caught up" is withheld while
quiet shares is unavailable.

### 6.5 The Follow up tab is unchanged

The Follow up tab keeps its 24-hour quiet rule and its inbound-only clock
(`last_heard_from_at`). Its wire shape and rows do not change. "Last heard
from" anywhere in the app keeps meaning inbound only.

## 7. The new signal: `last_reached_out_at`

### 7.1 What it is

A per-contact ISO timestamp on the contact item: the latest instant staff
reached out to that contact. Outbound only. It sits beside
`last_heard_from_at` (inbound only), which must NOT move on our outbound
(Cameron: "We don't want our message outbound to a tenant to restart that
clock"). Together the two give "last communication either way" as the later
of the two, so no combined field is stored.

### 7.2 What counts (Cameron, 2026-10-23)

- Counts: messages (SMS/MMS), emails and calls that staff send themselves, in
  any thread - one-to-one and relay groups. Property shares count (a share is
  a staff-sent message).
- A call counts on ANY attempt, answered or not.
- A staff post in a relay group counts for EVERY contact member of the group.
- Does not count: automated sends - tour reminders, auto-replies, opt-in and
  opt-out confirmations, system notices, scheduled ladder messages and any
  other message the system sends on its own.
- Future: an agent that sends "as staff" will count when it is built. The
  write goes through one shared helper (7.3) so that path only has to call it.

### 7.3 How it is written

Mechanism: copy `last_heard_from_at`'s writer.

- A new repo method `touchLastReachedOut(contactId, at)` beside
  `touchLastHeardFrom` (`app/src/repos/contactsRepo.ts` ~2007): a conditional
  UpdateItem, forward-only (`attribute_exists(contactId) AND
  (attribute_not_exists(f) OR f < :at)`), the instant normalized the same way,
  returning 'moved' / 'skipped' / 'failed' and never throwing.
- One shared helper (for example `recordStaffOutreach(contacts, contactIds,
  at, log)`) that every staff writer calls, awaited inline AFTER the message or
  call row is persisted, inside try/catch, logging ERROR on 'failed' (ids
  only). Best-effort: a failed stamp never fails or retries the send. The future
  "agent as staff" sender calls the same helper.
- The instant is the outbound row's own timestamp (the time the message or
  call was created), not the request time.
- The field is server-owned: add it to the contact PATCH's server-owned list
  (`app/src/routes/contacts.ts` ~312), the contact type, and the recipient
  projection the Follow up builder reads (`getRecipientDisplaysByIds`,
  contactsRepo ~401 and ~1098), the same three places `last_heard_from_at`
  sits.

The stamp goes at each CALL SITE, not in `messagesRepo.append`: no stored
field separates staff from automated sends. Automated sends also carry
`author 'teammate'`, and the `automated` flag describes how a send is gated
(quiet hours, consent), not who started it. No message row stores the sending
user's id.

Writers that STAMP (staff outreach):

| # | Writer | Contact(s) stamped |
|---|---|---|
| W1 | One-to-one SMS/MMS send, POST /api/conversations/:id/messages (`routes/api.ts` ~1564 -> `services/sendMessage.ts`) | the recipient the send judged (`heldRecipient ?? phoneContact`) |
| W2 | Staff Retry button, POST .../messages/:sid/retry (`api.ts` ~1872) | the retried row's recipient |
| W3 | Email send, POST .../email (`api.ts` ~1667 -> `services/sendEmailMessage.ts`) | the addressed contact; only once SES accepts it |
| W4 | Relay group team post, group open (`api.ts` ~2042 `sendRelayTeamMessage`) | every participant with a contactId |
| W5 | Relay group team post while the group is still connecting (`api.ts` ~1950, queued_pending) | every participant with a contactId, at compose time |
| W6 | Native group text post (`services/groupSend.ts` ~651) | every resolved member contact; only after the post succeeds (the row is written only then) |
| W7 | Outbound call, POST /:contactId/call (`services/originateCall.ts` ~171) | the called contact, on any attempt |
| W8 | Share fan-out send, one per recipient (`jobs/broadcastFanOut.ts` ~925) | the recipient - every share, whatever its `automated` flag |
| W9 | Share adoption by the reconcile (`broadcastFanOut.ts` ~1409 via `jobs/sendReconcile.ts` ~843) | the recipient, unless the adopted row is failed |
| W10 | Dev seams that write outbound rows: `/__dev/voice/transcript-fixture` (`routes/dev.ts` ~904) and `/__dev/extraction/message-fixture` (dev.ts ~1112, ~1177) | as their inbound twin `touchFixtureHeardFrom` (dev.ts ~821) does |
| W11 | Reseed: a sibling of `deriveSeedHeardFrom` (`lib/seed/heardFrom.ts` ~59) derives the field from the seeded outbound rows (lean and full) | seeded contacts |

Writers that do NOT stamp, and why:

| Writer | Why not |
|---|---|
| Automatic 30003 retry job (`jobs/retrySend.ts` ~551) and the reconcile's retry adoption (`sendReconcile.ts` ~923) | A machine resend of a staff message that already stamped. Told apart from a manual Retry by `retryAttempt` / `retry_window_start` |
| Relay 30003 retry rung (`webhooks/twilio.ts` ~3077) | A machine resend to one member of a post that already stamped |
| Tour reminder and placement nudge "Send now" (`jobs/tourReminders.ts` ~1998, ~1646; `jobs/placementNudges.ts` ~854) | Staff only pick the time; the copy is the automated reminder or nudge (ruling: reminders do not count), even though the row carries `automated:false` |
| Missed-call auto text, housing-fair welcome text, tour reminder poll, nudge poll | Automated |
| Relay announcements (intro, member added, group closed, group tour reminder; `services/relayAnnouncements.ts` ~229) | System messages (`author 'system'`) |
| Quo importer (`lib/import/apply.ts` ~468, ~504) | Historical data with no staff/automated split; consistent with no backfill (7.4) |
| Performance seed | Load data only; it derives no heard-from either |

Edge rules:

- Failed sends: no row means no stamp. An SMS the provider accepts and that
  fails later keeps its stamp (a max field cannot be un-stamped, and staff
  did reach out). Email stamps only after SES accepts; an adopted row that is
  failed does not stamp.
- A relay or group member with no contactId (a phone-only member) is skipped:
  there is no contact item to stamp, and such a member cannot be a quiet-share
  candidate keyed by contactId.
- A queued relay post (W5) stamps at compose time even though it leaves when
  the group connects, usually within minutes. A group that never connects is
  a failure surfaced elsewhere.
- New outbound writers added later must decide stamp / no stamp explicitly;
  the GLOSSARY entry and the helper's doc comment say so.

### 7.4 No display, no backfill

- The field is not shown anywhere in this mission; it only feeds the quiet
  clock.
- No backfill (recommended; Cameron to confirm at the spec gate). The replay
  showed staff outreach removed only 0-3 rows a day historically, and every
  candidate share ages out in 14 days, so the gap closes on its own two weeks
  after deploy. A backfill would be an ops script run against prod.

## 8. Live updates

The existing Today refetch triggers cover the new sections: conversation and
message events (a message either way), tour.updated (Interested, a tour
created, a tour booked), contact.updated (a status change), placement and
suggestion events. The Interested / Not interested route emits no live event
today; staff mark those on the contact page, and returning to Today remounts
and refetches it. A second open Today tab picks up a Not interested on its next
refetch. No new event is added (deliberate; see open questions).

## 9. Testing

- Server route tests (`app/src/routes/today.ts`): Unreplied gone; the unread
  pass keeps only unknown_1to1 rows ahead of the cap; identify grouping and
  order; tours_to_book rows, deleted tenant skip and order; quiet shares rule
  at both thresholds and both boundaries, each drop-off, the outbound restart,
  property grouping, ordering and distinct-people count; unavailable path
  answers 200.
- The Follow up tab: a regression test that its rows are unchanged when
  `last_reached_out_at` is set.
- Writers: every writer in 7.3 has a test that it moves the field, and every
  automated sender listed there has a test that it does not.
- Dashboard: section order, the 5-row limit and Show all / Show fewer, the
  quiet-shares property lines (first open, others folded, toggles kept across a
  refetch), All caught up ignoring At a glance and withheld on a section error,
  the AI suggestions collapsed line.
- e2e: extend the Today spec (lean seed) for the new section order, a quiet
  share appearing and dropping off after a staff message, and Tours to book.

## 10. Docs

- GLOSSARY.md: "Quiet shares" (the Today section), `last_reached_out_at`
  (staff outbound clock), "At a glance".
- Tracker #31: record the Oct 23 decisions and Sam's option C pick when the
  build ends.

## 11. Open questions for the spec gate

1. No backfill of `last_reached_out_at` (7.4) - confirm.
2. No live event from Interested / Not interested (8) - confirm.
</content>
</invoke>
