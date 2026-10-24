# Today as the daily checklist - design (tracker #31)

Status: r8 (2026-10-24, Cameron at the launch gate: no counts in section
headings; a Retry or Send now of anything automated from its first send
never counts as staff outreach). r7. Design review closed after round 3; Cameron passed the spec gate
2026-10-24 and added the backfill (7.5), reviewed in round 4 (folded in). r7
(2026-10-24, plan review): four precision refinements from the plan's
rulings PR88, PR91, PR93 - the W2 row (a Retry of an automated row does not
stamp), the W4 row (a provider-accepted stranded leg stamps), the 7.3
one-event rule (per fan-out pass), and 7.5 (manual retries, reconcile
relay legs) - listed for Cameron at the launch gate. Branch `feat/today-checklist`,
cut from `main` @970a29b9. Tracker: HousingChoice Improvements Tracker item #31
(Oct 16 meeting with Sam, Oct 18 and Oct 23 decisions). Mockups shared with
Sam (Design canvas https://claude.ai/artifact/673Q7i9fjQ7zWAH1XydJ5v); Sam
picked quiet-shares option C on 2026-10-23. Review adjudications:
`docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/adjudications.md`.

This spec supersedes the "Today action queue" grouping rules in
`docs/superpowers/specs/2026-06-16-new-dashboard-design.md`, which
`app/src/routes/today.ts` says it must match; the build updates that header
comment to point here.

## 1. Goal

Sam and her new virtual assistant (VA) use Today as their start-of-day and
end-of-day checklist. Two rules decide what is on the page (Cameron,
2026-10-23):

1. Today holds only things that must happen today - no FYIs, nothing that can
   wait.
2. Everything that must happen today is on it, with two deliberate exceptions
   that have their own badges: replies from known contacts (the Inbox badge)
   and unmatched email (its own nav badge).

Two reference items stay, in a small lower section that never counts toward
"done": Tours today (Sam likes it at a glance) and AI suggestions, collapsed to
one line. The lower section is kept small by the 5-row limit and the collapsed
AI line.

The VA uses a normal staff login. No roles or permissions change.

### 1.1 Non-goals

- The Matching page's Follow up tab, its 24-hour rule and its wire shape.
- "Last heard from" and `last_heard_from_at` (inbound only, unchanged).
- Showing `last_reached_out_at` anywhere.
- Interested / Not interested actions on Today rows.
- A Properties sent list on the unknown contact page.
- New roles or permissions for the VA.
- An agent that sends as staff (future; only the hook point is designed).

## 2. The page, top to bottom

The page has two parts: the checklist, then a dashed divider and the
"At a glance" section.

| # | Section (heading) | Source | Order (the first 5 shown) |
|---|---|---|---|
| 1 | Needs you now | server group `needs_you_now` | unchanged (most urgent first) |
| 2 | Identify these contacts | server group `identify` (NEW, split from needs_you_now) | oldest contact first (5.2) |
| 3 | Past tours needing an outcome | client, the Past tab's loader | OLDEST tour first (5.3) |
| 4 | Tours to book | server group `tours_to_book` (NEW) | oldest request first (5.4) |
| 5 | Quiet shares | server field `quietShares` (NEW) | section 6 |
| 6 | Relay groups to close | server list `relayCloseNags` (moved down) | unchanged |
| 7 | Placements | server group `follow_ups` (heading renamed from "Follow-ups due") | unchanged |
| - | At a glance: Tours today | server group `tours_today` (moved down, compact rows) | by time (2.4) |
| - | At a glance: AI suggestions | server group `ai_suggestions` (one collapsed line) | unchanged |

Removed: the Unreplied section (Oct 16: the Inbox badge already covers it).
Not added: unmatched email (it has its own nav badge).

Page subtitle: "Clear every section above the line and today's checklist is
done. New messages are in the Inbox." (replaces "What needs you, across every
placement and contact.").

Rejected layouts, so nobody re-proposes them: a jump row of section links at
the top (Cameron: it reads as a filter bar); chips or badges per person in
quiet shares (Cameron: "All of those badges look terrible").

Each section is a `<section>` with an `<h2>` heading and a list whose
accessible name is the heading text (the existing Today pattern), so tests
select by `getByRole('list', { name: <heading> })`.

### 2.1 Every section shows 5 rows

- Each section shows its first 5 rows. The heading carries NO count
  (Cameron, 2026-10-24: "We can probably remove those unless there's a
  specific reason to keep them"); the "Show all N" button names the full
  count.
- When a section has more than 5, a "Show all N" button under the list expands
  it in place. Once expanded, the button reads "Show fewer". Expansion is
  per-viewer page state only (lost on reload; not stored).
- Past tours keeps its existing "See all N on the Past tab" / "Open the Past
  tab" link as well, beside its Show all button.
- Quiet shares applies the limit to PROPERTY lines, not people (6.3).
- An empty section is not rendered (unchanged rule).
- Server-capped sections count what the server returns: Identify's two reads
  are capped at 100 each (5.2) and AI suggestions at 20 contacts (2.4). At
  today's volumes (8 and 22) the caps are not reached.

### 2.2 Help lines

Each checklist section that needs one has a short help line under its
heading, written for the VA:

- Identify these contacts: "We don't know yet who these are. Call each one;
  after about a week with no contact, mark them Inactive."
- Tours to book: "Said yes to a property; the tour has no date yet. Oldest
  first."
- Quiet shares: "Properties sent in the last 14 days. Replied and then went
  quiet for 2+ days, or never replied in 5+ days. A message or call from
  either side restarts the clock; sending another property does not."
- Needs you now, Past tours, Relay groups to close and Placements: no help
  line (their rows already say why).

### 2.3 All caught up

"All caught up" shows when every CHECKLIST section (1-7) is empty and
settled. The At a glance section still renders below the message. Tours today
and AI suggestions never keep the page from reading as done.

- A section that failed to load is not empty: it shows its own error, and the
  page does not claim "All caught up" (2.5).
- The existing settle rule stays: the message waits for the past-tours section
  to settle so it never flashes above rows about to appear.

### 2.4 At a glance

Below a dashed divider, headed "At a glance":

- Tours today: compact rows - the time (local, from the row's `at`), the
  tenant, the property (`unitLabel`) - ordered by time, then tenant name, then
  tourId. Same source and status rule as today's group. Same 5-row limit.
- AI suggestions: ONE line, "AI suggestions for N contacts", collapsed by
  default (a button with `aria-expanded`). Opening it shows the rows with the
  same 5-row limit and Show all. N is the server's contact-row count (capped at
  20, unchanged). The list is not in the accessibility tree until opened.
- When both are empty the At a glance section is not rendered.

### 2.5 Section failures

- The route answers 200 whenever its core reads succeed. Quiet shares and
  Tours to book are each computed inside their own try/catch: ANY throw in
  that computation (a units walk, a per-unit read, a contacts batch, the
  tours read) makes that one section unavailable, logs at WARN with ids and
  counts only, and leaves the rest of the page intact. A failed unit LABEL
  lookup is not a failure: the row shows the unitId (section 3).
- The dashboard shows "We couldn't load <section>." in place of an unavailable
  section (the past-tours error pattern) and withholds "All caught up". On the
  fallback (3.1) it shows one line instead, "Some sections can't load right
  now.", not an error per section.

## 3. Wire contract (GET /api/today)

`TodayGroup` becomes:
`'needs_you_now' | 'identify' | 'tours_to_book' | 'tours_today' | 'follow_ups' | 'ai_suggestions'`.
`unreplied` is removed from the server and the dashboard types.

`TodayItem` gains two optional fields, set only on tour rows:

```
at?: string;         // ISO. tours_today: scheduledAt. tours_to_book: the tour's createdAt.
unitLabel?: string;  // the property, formatAddress(unit.address) || unitId (the server formatter)
```

The Today router gains a units repo dependency for these labels (point reads,
memoized per request like the contact cache). A failed unit lookup degrades to
the unitId (never a 500); for Tours to book it does not make the section
unavailable.

`TodayResponse` gains:

```
quietShares:
  | { status: 'ok'; properties: QuietShareProperty[]; truncated: boolean }
  | { status: 'unavailable' }
toursToBook: 'ok' | 'unavailable'    // whether the tours_to_book group was computed

QuietShareProperty {
  unitId: string;
  unitLabel: string;          // the Follow up tab's formatter
  people: QuietSharePerson[]; // order in 6.2
}
QuietSharePerson {
  contactId: string;
  name: string;               // the Follow up tab's name rule
  type: string;
  role?: string;              // as on the Follow up tab
  state: 'replied' | 'no_reply';
  quietSince: string;         // ISO; the clock in 6.1
}
```

A person waiting on two properties has a row under each property. (r8: no
distinct-people count is sent; headings carry no count.) `truncated` is the Follow up builder's flag (more than 100
available properties); the dashboard shows "Showing the first 100 properties"
under the section when it is true.

### 3.1 The client-side fallback

`dashboard/src/routes/today/buildToday.ts` runs only when GET /api/today 404s.
It stops emitting `unreplied`. Its existing unknown_1to1 rows are emitted in
the `identify` group (so both paths render them in the same place; their copy
and unread rule stay the fallback's own). It assembles no `tours_to_book` and
no quiet shares, and `useToday` treats a fallback load as quiet shares and
Tours to book UNAVAILABLE - so the fallback never shows "All caught up".

## 4. Unreplied removal and the unread pass

- The Unreplied group is gone. Known contacts' unread threads appear only in
  the Inbox (and its badge).
- The unread index walk in `app/src/routes/today.ts` now exists only to find
  Identify rows. In its collect loop the FIRST test is the type filter: keep
  only `unknown_1to1` threads, before the deleted-contact skip (so a known
  thread costs no contact read) and before the 100-row cap (so known threads
  cannot spend cap slots).
- After the deleted-contact skip, the owner test from 5.2 applies (it replaces
  #30's narrower Inactive skip, which it contains).
- The comment saying Inactive tenants' typed threads "feed Unreplied (tracker
  #31 owns that section)" is updated: they feed only the Inbox now.

## 5. Sections in detail

### 5.1 Needs you now

What stays: due hard clocks (RTA window closing, voucher expiring), escalated
placements, relay opt-out attention rows. Order unchanged. The "New unknown
contact" rows leave for Identify.

### 5.2 Identify these contacts (new group `identify`)

Identify lists contacts we do not yet know: contacts whose type is `unknown`
(Cameron, 2026-10-23).

- Sources (unchanged reads, new owner rule):
  - the unread unknown_1to1 pass (section 4): a row only when the thread's
    owner contact is type `unknown` and its status is not `inactive`. A thread
    whose owner cannot be resolved keeps today's behavior (a row only when the
    roster is linked, else deferred to the triage pass). Threads owned by a
    team member, tenant, caseworker or any other type emit NO Today row; they
    stay in the Inbox. This closes the Today half of
    `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`
    (update the issue).
  - the (unknown, needs_review) triage partition, with the existing
    group-detection-stub exclusion and de-dupe by phone against the unread
    rows.
- Row text unchanged: who + "New unknown contact"; links to the contact page.
- Order: oldest first by the contact's `created_at`; a contact with no
  `created_at` sorts last; ties by refId. The two reads are capped at 100 each
  and are not recency ordered past the cap (the triage partition's range key is
  constant), so "oldest" is over what was read. Prod holds 8 today.

### 5.3 Past tours needing an outcome

- Source unchanged: the Past tab's rows as its loader returns them
  (`usePastTours`: the in-range rows plus the appended off-range rows), with
  deleted tenants skipped.
- Order on Today only: in-range rows by OLDEST `scheduledAt` first (ties by
  tourId), then the off-range rows (undated, or dated after today) in the
  loader's own order, last. This reverses the Sep 29 "five most recent" ruling
  (Cameron, 2026-10-23) so the oldest tours do not wait for the two-week
  auto-close. The Past tab's own order is unchanged.
- The section labels EVERY Past row (point reads of tenant and property,
  memoized as now), not only the first five, so "Show
  all N" counts the rows Today actually qualifies (deleted tenants excluded). The
  "See all N on the Past tab" link keeps the Past tab's own count. Prod: about
  23 rows. Cost: a live reload (tour.updated, now also fired on tour create)
  re-reads every listed tenant for its delete state, about 23 point reads,
  debounced; properties stay memoized. The "All caught up" settle wait covers
  this labeling, which is only ever reached when the rest of the checklist is
  empty.

### 5.4 Tours to book (new group `tours_to_book`)

- Rows: every tour in status `requested` - the Tours page's Needs booking list
  - read server-side with `tours.listByStatus('requested')`. Deleted tenants
  skipped (the Today rule). No age limit and no tenant-status filter: an
  unbooked request needs a decision (book it or cancel it), however old, and
  that is the work this section exists for. Prod today: 13 requests; ages 0-9
  days for 11, plus one at 17 and one at 64 days.
- Row: who = tenant; why = `unitLabel`; urgency = "Requested today" /
  "Requested N days ago" from `at`; links to the tour page.
- Order: oldest `createdAt` first, ties by tourId.
- A tour drops off when its status leaves `requested` (booked, canceled,
  closed). When a requested tour is canceled, the pair's share outcome returns
  to replied / no_reply (`app/src/lib/listingSendTour.ts`: a canceled tour is
  no signal), so the person can reappear in Quiet shares. That is intended -
  they no longer have a tour.

Why this section exists: Interested creates a requested tour with no date, and
creating a tour removes the person from Quiet shares. Without this section, a
tenant who says yes falls off the checklist at the moment they need booking.

### 5.5 Relay groups to close

Unchanged rows, Close / Keep-open card and behavior; moves from the top of the
page to position 6 and takes the 5-row limit.

### 5.6 Placements

The `follow_ups` group (due follow-up deadlines and derived "Stuck - needs a
check" rows), unchanged, under the heading "Placements".

## 6. Quiet shares

### 6.1 The rule

Candidates are exactly the rows the Follow up tab can list
(`app/src/services/followUps.ts` `buildFollowUps`): listed sends on available
properties, sent within the last 14 days (FOLLOW_UP_LOOKBACK_MS), outcome
`no_reply` or `replied`, recipient eligible (`isEligibleRecipient`). Every
contact type the Follow up tab lists is in scope (tenants, caseworkers,
unknowns) - Cameron, 2026-10-23.

For each candidate:

```
quietSince = the latest of:
               sentAt,
               last_heard_from_at,   when later than sentAt,
               last_reached_out_at,  when later than sentAt
threshold  = 2 days  when outcome = replied   (they replied, then went quiet)
             5 days  when outcome = no_reply  (never replied)
shown      = now - quietSince >= threshold
```

- Days are fixed durations (48h and 120h), like the existing 24h and 14-day
  constants; not calendar days.
- `state` is the outcome. A person who never replied stays `no_reply` after
  staff reach out; outreach restarts the clock but does not change the state.
- Each share has its own clock from its own `sentAt`. Sending someone another
  property does not restart the clock on the properties they were sent before
  (Cameron, 2026-10-23), because shares do not move `last_reached_out_at`
  (7.2).
- Subset: every Today row is also a Follow up tab row, because Today's clock is
  never earlier than the tab's (`waitingSince` = max of sentAt and heard) and
  both thresholds exceed the tab's 24 hours. Nobody should "fix" Today to show
  rows the tab does not.

Mechanism: `buildFollowUps` is split into an internal core that returns the
waiting rows together with each row's recipient (the projection it already
reads, now including `last_reached_out_at`), and the existing Follow up
projection on top of it. The Follow up route's output stays byte-for-byte the
same; Today applies the rule above to the core's rows. One contacts read, not
two. Today's call passes `consistentRead: true` to that contacts batch, so a
refetch triggered by a stamp's event sees the stamp; the Follow up tab keeps
its current read. `getRecipientDisplaysByIds` takes only `requireComplete`
today, so this is an interface change: the option is added there (the
underlying batch walk already supports ConsistentRead), passed through
`FollowUpsDeps`, and added to the test fakes.

A person drops off when any of these happens:

- staff mark them Interested or Not interested, or a tour is created for them
  on that property (existing outcome rules);
- they send a message, call or email (`last_heard_from_at` moves), or staff
  message, email or call them (`last_reached_out_at` moves, 7.2) - this
  restarts the clock, so they come back if the quiet continues;
- the send passes 14 days old;
- they become ineligible (opted out, unreachable, Inactive, placed, deleted, no
  phone) or the property stops being available.

### 6.2 What a person row shows

- Name, a role tag for a caseworker, then the quiet text and a state tag:
  - replied: "Replied, then quiet N days", tag "Replied";
  - no_reply: "No reply in N days", tag "No reply yet".
  N = whole days since quietSince, rounded down.
- The row opens the contact's page. NO Interested / Not interested buttons on
  Today (Cameron, 2026-10-23): deciding needs the conversation in view. For a
  tenant or caseworker, the contact page's Properties sent list has the
  buttons. An unknown contact's page has no such list
  (`dashboard/src/routes/contact/UnknownFile.tsx`): an unknown leaves Quiet
  shares when staff reach them (restarting the clock) or mark them Inactive.
  Identifying them as a tenant does not by itself remove the row; it makes the
  tenant page's buttons reachable.
- Inside a property: `replied` people first, then `no_reply`; within each,
  the longest quiet first (oldest quietSince); ties by contactId.

### 6.3 Layout: option C, grouped by property (Sam, 2026-10-23)

- One expandable line per property: the address, then a summary such as
  "7 people: 2 replied, then quiet - 5 never replied". A zero part is left out
  ("3 people: 3 never replied"); one person reads "1 person: ...".
- Properties are ordered by their longest-quiet person (oldest quietSince
  first); ties by unitId.
- Opening: when the section first renders with at least one property, the
  first property in order is open and the rest are folded. After that, the
  viewer's choices are kept by unitId across live refetches; a property that
  appears later starts folded. Per-viewer page state only.
- The 5-row limit counts property lines: with more than 5 properties, "Show
  all N properties" expands in place. An open property shows all its people.
- The heading carries no count (2.1).
- Each property line is a button with `aria-expanded`; its people list has an
  accessible name naming the property.

Prod volume (read-only replay, 2026-10-23): about 17-26 people a day since
Oct 16 across about 5 properties; peak 44 on Oct 12, left over from a blast. In
the last 14 days all 116 shares went to one person each.

### 6.4 The Follow up tab is unchanged

The Follow up tab keeps its 24-hour rule and its inbound-only clock. Its wire
shape and rows do not change. "Last heard from" anywhere in the app keeps
meaning inbound only.

### 6.5 Cost

Each Today load now also runs the Follow up core: the available-properties
walk (capped at 100 properties), two Queries per property with recent sends at
10-way concurrency, and one contacts BatchGet. Prod has tens of available
properties, so this is tens of small Queries per load. Today refetches on live
events debounced by 300 ms. No cache is added; if load grows, a short-lived
cache of the core is the follow-up (record it as a `docs/issues/` entry).

## 7. The new signal: `last_reached_out_at`

### 7.1 What it is

A per-contact ISO timestamp on the contact item: the latest instant staff
followed up with that contact. Outbound only. It sits beside
`last_heard_from_at` (inbound only), which must NOT move on our outbound
(Cameron: "We don't want our message outbound to a tenant to restart that
clock"). "Last communication either way" is the later of the two, so no
combined field is stored.

### 7.2 What counts (Cameron, 2026-10-23)

- Counts: messages (SMS/MMS), emails and calls that staff send themselves, in
  any thread - one-to-one, relay groups and group texts.
- A call counts on any attempt to reach the CONTACT, answered or not: it
  counts once the contact's leg is dialed, not when only the staff member's own
  cell has rung.
- A staff post in a relay group counts for every contact member it is sent
  to.
- Does NOT count:
  - property shares and broadcasts (a share starts its own clock; Cameron,
    2026-10-23);
  - automated sends: tour reminders, nudges, auto-replies, opt-in and opt-out
    confirmations, missed-call texts, welcome texts, relay system
    announcements, and any message the system sends on its own;
  - machine resends of a staff message that already counted;
  - a staff Retry or Send now of anything that was automated from its first
    send: an automated text, a tour reminder or a placement nudge (sent on
    its own or through Send now), and any later Retry of one (Cameron,
    2026-10-24: "it was supposed to be automated from the first part").
- Future: an agent that sends "as staff" will count when built. It calls the
  same helper (7.3).

### 7.3 How it is written

- A repo method `touchLastReachedOut(contactId, at)` beside
  `touchLastHeardFrom` (`app/src/repos/contactsRepo.ts`), copying it exactly:
  the pointer-row guard, the instant normalization, the conditional
  forward-only UpdateItem (`attribute_exists(contactId) AND
  (attribute_not_exists(f) OR f < :at)`), the `'written' | 'skipped' |
  'failed'` result, never throwing.
- One shared helper, for example `recordStaffOutreach({ contacts, log },
  contactIds, at)`: awaited inside try/catch, ERROR log on 'failed' (ids
  only), best-effort (a failed stamp never fails, delays or retries the send).
  It returns whether any stamp was 'written'. Its doc comment says every new
  outbound writer must decide stamp or no stamp explicitly.
- ONE live event per send operation, after its stamps: a one-to-one send,
  email or call emits `contact.updated` for its contact when its stamp was
  written; a relay or group post emits nothing per member and instead ONE
  `conversation.updated` for the thread after its fan-out loop finishes, when
  any member's stamp was written (r7: one per fan-out PASS - a continuation
  pass for deferred members is its own job and emits its own). That event's payload is built from a FRESH,
  consistent read of the thread at emit time, never from the job's
  start-of-run snapshot: two dashboard consumers set `unread_count` straight
  from the event (`ThreadUnreadToggle.tsx`, `ContactDetail.tsx`), so a stale
  payload would mark a reply that arrived mid-fan-out as read. It does not
  call `touchLastActivity`. `jobs/relayFanOut.ts` has no event bus today; it
  gains one through the existing worker-to-API bridge (`eventBridge.ts`).
  Where a writer already emits `conversation.updated` AFTER its stamp point,
  it adds no event: W5 (`groupSend.ts`) stamps BEFORE its existing emit. W7
  (`sendRelayAnnouncement`) emits before its member loop, so it takes the
  same after-loop fresh-read event as W4. Today subscribes to both. This bounds the
  extra events at one per staff send (not one per relay leg); the
  `ContactUpdatedEvent` doc comment (`app/src/lib/events.ts`) is updated to
  name this new emitter. Every client that hears `contact.updated` (Today,
  Inbox, the open contact page) already refetches on it; at one event per
  staff send this is the same order of load as the send's own
  `conversation.updated`.
- The instant is the outbound row's own timestamp (or, for a call, the dial
  instant), not the request time.
- The field is server-owned, in all four places `last_heard_from_at` sits: the
  `ContactItem` type, the `RecipientDisplay` type, the recipient projection
  (`getRecipientDisplaysByIds`), and `SERVER_OWNED_CONTACT_FIELDS` in
  `app/src/routes/contacts.ts` (read by both the create and PATCH parsers).

`system_copy` (r8): a boolean on the message row, `true` when a person pressed
send but the copy is the system's. Written by tour reminder and placement
nudge Send now (`jobs/tourReminders.ts` forceSendReminder,
`jobs/placementNudges.ts` forceSendNudge) and by a staff Retry of a row that
is `automated: true` or `system_copy: true`. It changes no gating (the row
stays `automated: false`, a person's send); only W2 and the backfill read it.

The stamp sits at each writer, not in `messagesRepo.append`: no stored field
separates staff from automated sends. Automated sends also carry
`author 'teammate'`, the `automated` flag describes how a send is gated, and no
message row stores the sending user's id.

Writers that STAMP:

| # | Writer | Where the stamp goes | Contact(s) stamped |
|---|---|---|---|
| W1 | One-to-one SMS/MMS send, POST /api/conversations/:id/messages (`routes/api.ts` -> `services/sendMessage.ts`) | inside `sendMessage`, after the row is persisted, when the caller passes a staff-outreach option (only W1 and W2 pass it). The service owns the judged recipient (`heldRecipient ?? phoneContact`), which its outcome does not return | the judged recipient |
| W2 | Staff Retry button, POST .../messages/:sid/retry | as W1, EXCEPT it does not stamp when the retried row is a share text (it carries `broadcast_id`, `routes/api.ts` ~1880), automated (`automated: true`) or system copy (`system_copy: true`, 7.3): shares and automated copy do not count (7.2). The new row inherits `system_copy: true` when the retried row is automated or system copy, so a Retry of a Retry is judged by the first send (r8) | as W1 |
| W3 | Email send, POST .../email (`services/sendEmailMessage.ts`) | after SES accepts the message | the addressed contact |
| W4 | Relay group team post (`sendRelayTeamMessage` in `routes/api.ts`, open or still connecting) | in the relay fan-out LOOP (`jobs/relayFanOut.ts`, around the `sendOneRelayLeg` call ~1535), when a leg of a team post comes back sent or `sent_unrecorded`, or (r7) `stranded` after the provider accepted it (`afterSend`) - NOT inside `sendOneRelayLeg`, which the 30003 retry rung also calls (`relayRetryLeg.ts`). The instant is the leg's send time, so a post queued while the group connects stamps when its legs actually go out. A suppressed member gets no leg and no stamp. The reconcile's relay-leg adoption does not stamp (a rare recovery path; best-effort) | each member whose leg was sent and who has a contactId |
| W5 | Native group text post (`services/groupSend.ts`) | after the post succeeds (the row is written only then) | every resolved member contact EXCEPT members whose slot is seeded `excluded` (suppressed, `groupSend.ts` ~607-637) |
| W6 | Outbound call (`services/originateCall.ts` + `routes/webhooks/voice.ts`) | in the outbound whisper-gate branch (`POST /voice/whisper-gate`, outbound=1), only when it returns the `<Dial>` to the target (after the DNC re-check passes), and AFTER the TwiML response is sent - never between press-1 and the `<Dial>`, where the file forbids awaited work because a slow answer drops the call. The target resolution (`resolveOutboundTarget`) must also carry the contactId the stamp needs. Not at originate (that rings the staff cell first) | the called contact |
| W7 | Relay group intro whose body staff wrote (`intro_body`, set on the create routes for relay groups, tours and placements) | in `sendRelayAnnouncement`'s own member loop (`services/relayAnnouncements.ts` ~266-321, called from `jobs/relayFanOut.ts` ~1124), gated on the announcement kind being the intro AND the body being the staff-edited `intro_body`. Every other announcement through that loop (default intro, member added, group closed, tour reminder) does not stamp | each member the intro was sent to, with a contactId |
| W8 | Dev seams that write outbound rows: `/__dev/voice/transcript-fixture` and `/__dev/extraction/message-fixture` (`routes/dev.ts`) | as their inbound twin `touchFixtureHeardFrom` does, when the fixture row is outbound | the fixture's contact |

Writers that do NOT stamp:

| Writer | Why |
|---|---|
| Share fan-out sends and their reconcile adoption (`jobs/broadcastFanOut.ts`, `jobs/sendReconcile.ts`), including broadcasts with no property | shares and broadcasts do not count (7.2) |
| Automatic 30003 retry job (`jobs/retrySend.ts`) and the reconcile's retry adoption | machine resend of a staff message that already stamped |
| Relay 30003 retry rung (`webhooks/twilio.ts`) | machine resend to one member |
| Tour reminder and placement nudge "Send now" | staff pick only the time; the copy is the automated reminder or nudge, even though the row carries `automated:false`. r8: the row is written with `system_copy: true`, so a later staff Retry of it does not stamp either |
| Missed-call auto text, housing-fair welcome text, tour reminder poll, nudge poll | automated |
| Relay announcements with system copy (default intro, member added, group closed, group tour reminder) | system messages |
| Quo importer (`lib/import/apply.ts`) | historical data with no staff/automated split; Quo rows are older than the backfill window (7.5) anyway |
| Reseed (lean, full) and the performance seed | no seeded contact carries the field; tests that need it drive a real staff send (9) |

Edge rules:

- Failed sends: no row (or no leg) means no stamp. An SMS the provider accepts
  and that fails later keeps its stamp - staff did reach out, and a max field
  cannot be un-stamped.
- A member or contact with no contactId is skipped: there is no contact item
  to stamp, and quiet shares are keyed by contactId.

### 7.4 No display

The field is not shown anywhere in this mission; it only feeds the quiet
clock.

### 7.5 Backfill (Cameron, 2026-10-24)

A one-time script seeds `last_reached_out_at` from recent message history, so
people staff followed up with before the deploy do not show as quiet early.

- Script: `app/scripts/backfill-last-reached-out.ts`, built on
  `app/scripts/backfill-last-heard-from.ts` (same shape): `--env
  local|dev|prod` through `scripts/lib/stageClient.ts`, DRY RUN by default,
  `--apply` writes, counts-and-ids-only logging (never a name, phone or
  body), abort with a partial report and exit 1 on a 'failed' touch.
- Window: outbound rows from the last 14 days only. A stamp matters only when
  it is later than a share's `sentAt`, and every candidate share is at most 14
  days old (FOLLOW_UP_LOOKBACK_MS), so older rows can never change a row.
- Read: the last-heard-from script's skeleton (scan every conversation,
  pointer rows skipped), but each thread is read with a KEY-CONDITION Query on
  the window (`tsMsgId >= <floor>`, `tsMsgId` = providerTs#sid, with a small
  margin and a `normalizeInstant` re-check of each row), not its full history.
  No pre-filter on `last_activity_at`: calls and queued relay posts do not
  move it.
- Writes: the latest qualifying instant per contact across threads, then ONE
  `touchLastReachedOut` per contact. The writer is forward-only, so a value a
  live send wrote after the scan is never moved back and a second run writes
  nothing. It emits no live events. Run it AFTER the deploy: a run before it
  would leave the sends between the run and the deploy stamped by nothing.
- Which historical rows count. The rows carry no "who started this" marker
  (7.3), so the script applies the 7.2 rules through the fields each writer
  leaves behind. The plan verifies every filter against the writer's real row
  shape, and the dry run reports a count per category. Every category
  requires `direction` outbound, `author` 'teammate' and no `imported_from`
  (Quo rows never count, whatever their date):
  - one-to-one text and email: `type` sms, mms or email; `automated` not
    true; no `broadcast_id` (shares and their retries); no automatic-retry
    fields (`retry_attempt` / `retry_window_start`); an email only once it
    left for SES (not failed, and not still queued); no `system_copy`; (r8)
    a manual retry (`retry_of`) does not count when its retried row or its
    chain root (`retry_root`) is in the thread's window and is automated,
    system copy or a Send-now row (the body rules below), while one whose
    retried row and root are both outside the window counts (residue,
    reported);
  - relay posts: rows with `relay_sender_key` 'team', not relay retry rows
    (`relay_retry_of`); a member counts only when their slot shows the leg
    was SENT (the slot's sid / sent instant - not its status, which can stay
    'queued' after a successful send). (r7) Legs the send reconcile adopted
    count (they were staff posts); a provider-accepted stranded leg with no
    slot sid cannot be seen and is not counted;
  - group-text posts: `relay_sender_key` 'team' on a group_text thread; each
    member slot is keyed by phone, so it is resolved to a contact by phone;
    slots whose transport state is 'excluded' (suppressed) are skipped;
  - calls: `type` 'call' with evidence the contact's leg was dialed - an
    `answered_at` (stamped at press-1) or a `call_outcome`. A call the staff
    member never accepted stays 'ringing' with neither, and does not count;
  - staff-edited relay intros: stored with `author` 'system', so the plan
    picks one rule - match the row body against the thread's `intro_body`, or
    skip them (an approximation that ages out in 14 days) - and the dry run
    reports which;
  - tour reminder and placement nudge "Send now" rows carry no marker. The
    plan picks one rule - an approximate join of each reminder or nudge's
    sent instant to the thread's row, or count them - and the dry run reports
    how many it could not tell apart.
- Recipient: the row's `recipient_contact_id` when present, else the
  one-to-one thread's contact; group rows as above.
- Who runs it: an agent runs it only against a hermetic e2e lane (`--env local
  --lane <L>`). Cameron runs it against dev and prod after the deploy, dry run
  first. A RUNBOOK entry gives the commands, and the handback lists it as a
  post-merge obligation.
- Tests: the classification per category (each counted and each skipped kind),
  the 14-day window, latest-per-contact across threads, the forward-only
  re-run writing nothing, and the abort on 'failed'.

## 8. Live updates

- Today already refetches (debounced 300 ms) on placement, conversation,
  suggestion, tour and contact events.
- A staff send that stamps `last_reached_out_at` emits one event after its
  stamps (7.3), which covers calls (they emit no `conversation.updated`) and
  closes the race with the send's earlier event; Today reads the contacts
  consistently (6.1), so the refetch sees the stamp.
- An inbound message moves `last_heard_from_at` before its
  `conversation.updated` fires (UNVERIFIED for every inbound path; the plan
  checks each and adds the same post-stamp `contact.updated` where the order is
  wrong).
- Tour CREATE emits no event today, on both POST /api/tours (a requested
  create) and the Interested outcome route (`routes/units.ts`). This mission
  adds a `tour.updated` emit to both, so a new request appears in Tours to book
  and the person leaves Quiet shares live.
- Not interested emits no event. Staff mark it on the contact page, and
  returning to Today remounts and refetches it; a second open Today tab picks
  it up on its next refetch. No event is added (Cameron, spec gate 2026-10-24).
- Rows that appear only because time passes (a share crossing 2 or 5 days, a
  property becoming unavailable) show on the next refetch or reload, as due
  deadlines already do.

## 9. Testing

- Server route tests (`app/test/todayApi.test.ts` and siblings): Unreplied
  gone; the type filter runs first in the unread pass; identify rows only for
  unknown-type owners, their order and the triage partition; tours_to_book rows,
  deleted-tenant skip, order and `at` / `unitLabel`; tours_today `at`,
  `unitLabel` and time order; quiet shares at both thresholds and both
  boundaries, each drop-off, staff outreach restarting the clock, a second
  share NOT restarting the first, property grouping and ordering; quiet
  shares and tours to book each unavailable on a
  thrown read while the route answers 200.
- The Follow up tab: its route output is unchanged when `last_reached_out_at`
  is set (regression).
- Writers: each W1-W8 has a test that it moves the field and that its send
  emits exactly one post-stamp event (7.3); each no-stamp writer (including a
  Retry of a share text, a 30003 relay retry rung and non-intro announcements)
  has a test that it does not move it. The W6 stamp is asserted to run after
  the TwiML is sent, through a seam the test can await (supertest resolves
  when the response ends, so an immediate assertion would race the
  post-response work).
  The PATCH and create parsers refuse the field.
- Dashboard: section order, help lines, the 5-row limit and Show all / Show
  fewer, quiet-shares property lines (first open, others folded, choices kept
  across a refetch, a later property folded), All caught up ignoring At a
  glance and withheld for an unavailable section and for the fallback, the AI
  suggestions collapsed line, Tours today compact rows.
- e2e: extend the Today coverage (lean seed) for the section order, a quiet
  share that drops off after a staff message, and Tours to book. Seeding a
  quiet share needs the listing-send fixture (`/__dev/listing-send-fixture`)
  plus a way to set `last_heard_from_at` for the replied case; the plan names
  it.
- Existing tests that pin the old page and must be updated deliberately (do
  not weaken them to make them pass):
  - `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts` (row in Needs you
    now -> Identify)
  - `e2e/tests/dashboard-next/unknown-inactive.spec.ts` (Needs you now server
    truth and DOM -> Identify)
  - `app/test/todayApi.test.ts` #30 pins that an ACTIVE team member's
    unknown_1to1 thread keeps its row (~1037, ~1089): these are INVERTED, not
    moved - under 5.2 that thread emits no Today row
  - `e2e/tests/flows/conversation-fact-extraction.spec.ts` (the "AI
    suggestions to review" list is now behind the collapsed line)
  - `e2e/tests/dashboard-next/caseworkers.spec.ts`
  - `e2e/tests/scenarios/participant-names.spec.ts` (Unreplied)
  - `e2e/scenarios/steps.ts` ("Needs you now", "Follow-ups due")
  - `e2e/performance/routes.ts` (headings and "All caught up")
  - `app/test/todayApi.test.ts`, `app/test/todayUnmatchedNonRegression.test.ts`
  - the dashboard `buildToday`, `Today`, `useToday` and `useTodayPastTours`
    tests
  The plan re-greps for every reader of the old headings, groups and copy;
  this list is a floor, not the full set.

## 10. Docs

- GLOSSARY.md: "Quiet shares" (the Today section), `last_reached_out_at`
  (staff follow-up clock; shares do not move it), "At a glance".
- `docs/superpowers/specs/2026-06-16-new-dashboard-design.md` "Today action
  queue": a short note that this spec supersedes its grouping rules.
- `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`:
  record that Today no longer shows those rows (5.2).
- `docs/issues/`: a new entry for the Today quiet-shares read cost (6.5).
- RUNBOOK.md: the backfill commands (7.5), dry run first.
- Tracker #31: record the Oct 23 decisions and Sam's option C pick when the
  build ends.

## 11. Spec gate

Both settled at the spec gate (Cameron, 2026-10-24): a backfill of
`last_reached_out_at` runs once (7.5); Not interested adds no live event (8).
