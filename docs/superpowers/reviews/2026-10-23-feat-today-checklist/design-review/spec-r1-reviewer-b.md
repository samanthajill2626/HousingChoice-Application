# Spec review r1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` (branch
`feat/today-checklist`, read at f58d7b71). Repo read-only; no tests run.
Every code claim below cites a line I read. UNVERIFIED marks what I could
not confirm.

Severity = consequence if shipped unfixed.

---

## 1. [HIGH] Identify help copy tells the VA to mark known tenants and team members Inactive, and the Inactive mark does not clear their row

Spec 5.2 keeps "exactly the rows that today render ... as New unknown contact",
and 2.2 gives the section the help line "We don't know yet who these are. Call
each one; after about a week with no contact, mark them Inactive."

The unread pass emits that row for ANY `unknown_1to1` thread, decided by THREAD
type, not contact type (`app/src/routes/today.ts:818-839`). The importer mints
every imported 1:1 thread `unknown_1to1` whatever the contact's type, and a
tenant's or caseworker's second number can keep one (comment at
`today.ts:752-762`; open issue
`docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`). An Active
`team_member`'s thread is also `unknown_1to1` and deliberately keeps its row
(`today.ts:745-749`).

So Identify will list real tenants (any imported tenant who replies, e.g. to a
property share) and team members under copy instructing the VA to mark them
Inactive. Consequences:

- Inactive drops the contact from every share audience and quiet-share
  eligibility (`app/src/lib/listingSendOutcome.ts:119` `isEligibleRecipient`).
  The spec is handing a new, untrained user a destructive instruction for rows
  it knows can be misclassified.
- The Inactive skip only applies when the owner is `unknown` or `team_member`
  (`today.ts:766-773`). A tenant marked Inactive keeps the row; the only thing
  that clears it is someone reading the thread. The section's own clearing
  instruction does not work for these rows.

Before this spec the misleading label was a low-severity issue (the issue file
says severity low). Moving the row under an action-directing help line raises
the stakes, and the spec does not mention the issue. Either fix the
thread-type decision (emit Identify only when the owner contact is `unknown`)
or change the copy. The spec has to pick one.

## 2. [HIGH] Tours today "time, tenant, property" and Tours to book "property's address" need wire fields section 3 does not define

Section 2.4: Tours today renders "compact rows (time, tenant, property)".
Section 5.4: a Tours to book row's `why` is "the property's address".

The wire row is `TodayItem` (`app/src/routes/today.ts:96-105`,
`dashboard/src/api/types.ts:494-503`): who, why, urgency, tag, refs. No time,
no property. Today's tours_today row sets `why: 'Tour today'` and nothing else
(`today.ts:532-539`). Section 3 claims to be the wire contract and changes only
`TodayGroup` plus `quietShares`.

The today router also has no units repo (`today.ts:136-155`; wiring at
`app/src/routes/api.ts:1285-1300`), so the server cannot get an address
without a new dependency the spec does not list. Nor does the spec say which
formatter: `services/followUps.ts:52-56` records that the server `formatAddress`
and the dashboard `shortAddress` disagree.

As written, a builder either invents a wire change the reviewers never saw or
renders rows without time and address. Tours today also stays sorted by tenant
NAME (`today.ts:1006-1016`, "Order: unchanged" in the table). A row that shows
a time but is not in time order reads as a bug. Decide the order explicitly.

## 3. [MEDIUM] Section 8 misdescribes current events: Interested and tour CREATE emit no `tour.updated`

Section 8 says the existing triggers cover the new sections, listing
"tour.updated (Interested, a tour created, a tour booked)". 5.4 says "Live
refresh: tour.updated already triggers a Today refetch."

In the code:
- `POST /api/tours` emits no `tour.updated`. It emits only `scheduled.updated`
  on a scheduled create, and nothing on a requested create
  (`app/src/routes/tours.ts:404-418`).
- The Interested route creates the requested tour with `tours.create` and
  emits no event (`app/src/routes/units.ts:1564` onward, create at ~1654; the
  route has no `events.emit`).
- `tour.updated` is emitted only on cancel / patch / reopen
  (`tours.ts:1051,1656,1719`), auto-close, roster actions and placement close.

So a new Tours to book row does not appear live in another tab or for the
other user (Sam and the VA share the page; that is the point of the feature).
The quiet-share drop-off on Interested is not live either. Section 8 even
contradicts itself: it lists Interested under tour.updated, then two sentences
later says "The Interested / Not interested route emits no live event today."
Open question 2 covers only Interested / Not interested. It needs to cover
tour create too, or the spec should add the emit.

## 4. [MEDIUM] W7 stamps outreach when the NAVIGATOR's own cell rings, before the contact is dialed

W7 stamps "the called contact, on any attempt", "AFTER the message or call row
is persisted". In `app/src/services/originateCall.ts:158-189` the row is
appended right after `adapter.initiateCall({ to: navigator.cell })`, which
rings STAFF first. The contact is dialed only if the navigator answers and
passes the whisper / press-1 gate (header `originateCall.ts:1-6`; the comment
at :193-199 says a never-accepted originate "emits no <Dial>").

Cameron's rule is "any attempt" to the contact. If the navigator misses their
own ring, declines it, or hangs up at the whisper, the contact was never
called. The row exists anyway, the stamp lands, and the quiet share is hidden
for 2-5 days. That breaks goal rule 2 silently. The honest signal is where the
target is actually dialed (the `<Dial action>` / `/voice/status` path the
comment names). The spec should either stamp there or explicitly accept a
false stamp on an abandoned navigator leg.

## 5. [MEDIUM] Stamps land AFTER the SSE that triggers the refetch; calls trigger no Today refetch at all

- W1 stamps "at the call site", after `sendMessage` returns. But `sendMessage`
  emits `conversation.updated` INSIDE the service, before it returns
  (`app/src/services/sendMessage.ts:732-733`). Today refetches on that event
  after a 300 ms debounce (`dashboard/src/routes/today/useToday.ts:43,145-147`),
  so the refetch races the stamp. The quiet-share read is a BatchGet
  (`getRecipientDisplaysByIds`, eventually consistent by default; UNVERIFIED
  whether it passes ConsistentRead), so a landed stamp can still be missed.
  No later event follows to correct it. W3 has the same order (the
  `emitPersisted` helper at `sendEmailMessage.ts:410-421`).
- W7 (calls) emits only `message.persisted` (`originateCall.ts:200-205`), which
  `useToday` does not subscribe to (`useToday.ts:150-166`). After a staff call,
  the quiet share stays on screen until some unrelated event.
- The stamp itself emits nothing (not proposed).

So section 8's "a message either way" claim fails for calls, and is racy for
sends. Section 9's e2e "a quiet share ... dropping off after a staff message"
will be flaky by construction. Either emit an event after the stamp (for
example `contact.updated`, which Today already hears) or say the drop-off is
eventually visible.

## 6. [MEDIUM] Quiet shares cannot be computed from `buildFollowUps` without changing the Follow up wire, which 6.5 forbids

6.1 says candidates are "exactly the rows" `buildFollowUps` lists. 7.3 adds
`last_reached_out_at` to the recipient projection "the Follow up builder
reads". But `buildFollowUps` returns `FollowUpItem`
(`app/src/services/followUps.ts:46-69`), which carries `lastHeardFromAt` and no
`last_reached_out_at`. The contact map it reads (`followUps.ts:162`) is local
to the function.

To compute `quietSince` Today must do one of three things:
- add a field to `FollowUpItem`. 6.5 says "Its wire shape and rows do not
  change", and the route serializes `out` directly (`routes/broadcasts.ts:1415`).
- do a second contacts read, a second requireComplete failure point.
- refactor the builder into an internal core plus two projections.

The spec picks none. A builder will take the first, cheapest path and break
6.5. Name the mechanism.

The subset reasoning does hold: the Follow up 24h inbound-only filter
(`listingSendOutcome.ts:153-158`) is a superset of the Today 48h/120h rule,
because quietSince >= waitingSince. Say so in the spec so nobody "fixes" it.

## 7. [MEDIUM] 6.4 scopes failure isolation to the contacts read; the Follow up route 503s on ANY throw

6.4: "The Follow up tab answers 503 when its required contacts read is
incomplete. On Today that failure must not fail the page."

The route catches EVERY throw from `buildFollowUps` (units walk, per-unit
listing_sends and tours reads, the batch) and answers 503
(`app/src/routes/broadcasts.ts:1409-1419`). The Today route has no try/catch
of its own around its reads (`today.ts:331-1047`). A builder who isolates only
the incomplete-batch error leaves any units or tours throttle to 500 the whole
Today page, the opposite of 6.4's intent. Make the rule "any failure in the
quiet-shares computation".

The same applies to the new `tours_to_book` read: the spec gives it no
failure posture, so by default it takes the page down.

## 8. [MEDIUM] Past tours "oldest scheduledAt first" ignores the Past tab's off-range rows (undated and future-dated toured tours)

5.3 says order is "OLDEST scheduledAt first, ties by tourId", with source
unchanged. But the Past rows are TWO lists concatenated
(`dashboard/src/routes/tours/useTours.ts:317-321`): the range rows by
scheduledAt descending, then `selectOffRangeTours` (undated, or dated after
today) by last-touched, appended LAST (`useTours.ts:226-252`).

Undated rows have no `scheduledAt`. Reversing the array puts the off-range
rows FIRST. Sorting by `scheduledAt ?? ''` ascending also puts undated rows
first. Future-dated toured rows sort last, or first, depending on how it is
done. The spec has to say where these rows go.

## 9. [MEDIUM] Past tours heading count and "Show all N" count rows Today never shows

2.1: "The heading carries the section's full count", with "Show all N".
5.3: "The heading count is the Past tab's row count (the existing total)."

The hook documents that `total` INCLUDES deleted tenants' tours, which Today
skips: "It includes what Today leaves out (a deleted tenant's tours), so it can
exceed rows.length even when Today lists everything it qualifies"
(`dashboard/src/routes/today/useTodayPastTours.ts:52-56`). So "Show all 7" can
expand to 5 rows, and the checklist heading claims work that does not exist.
The existing link copy is honest because it names the Past tab. A section
heading on Today is not.

## 10. [MEDIUM] Tours to book is unbounded and never ages out, which the codebase has already ruled against

5.4 lists "every tour in status `requested`" via `listByStatus`. That read
walks every page of the requested partition with no limit
(`app/src/repos/toursRepo.ts:442-466`). The blast-rules code bounds this exact
partition to 14 days, because "it grows with every unbooked request"
(`app/src/routes/broadcasts.ts:707-725`, matching-blast-rules D4/D5). A request
older than 14 days is no longer treated as a live hold.

Under rule 2 every stale request stays on the daily checklist forever, until
someone cancels it. The spec gives no prod count for the requested partition
(UNVERIFIED volume), and it does not exclude placed or Inactive tenants (only
deleted ones). If the backlog is large, "All caught up" is unreachable on day
one and Tours to book buries the 5-row view. Measure it, or state an age rule.

## 11. [MEDIUM] Unknown contacts are in scope for quiet shares, but their contact page has no Properties sent list

6.1 puts unknowns in scope, and 6.2 justifies leaving the buttons off Today by
saying "the contact page's Properties sent list already has the buttons." The
unknown contact pane deliberately omits listings-sent:
`dashboard/src/routes/contact/UnknownFile.tsx:7-9` ("Deliberately omits the
tenant cards (voucher / housing authority / listings-sent / tours)").

For an unknown contact, the Today row opens a page where Not interested cannot
be recorded. The row can be cleared only by contacting them (which comes back
in 5 days), by typing them, or by marking them Inactive. The justification is
false for one of the three named types.

## 12. [MEDIUM] Section 9 does not enumerate the existing e2e and unit readers the renames and collapses break

The spec renames "Follow-ups due" to "Placements", moves "New unknown contact"
rows out of "Needs you now", deletes Unreplied, collapses AI suggestions behind
one line, and hides rows past 5. Existing readers bound to the old DOM or wire:

- `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:76-90` (row in the
  "Needs you now" list)
- `e2e/tests/dashboard-next/unknown-inactive.spec.ts:51-52,129-189,321` (Needs
  you now server truth and DOM)
- `e2e/tests/flows/conversation-fact-extraction.spec.ts:357,402,430` (list
  "AI suggestions to review", which is now collapsed by default, so the list
  is not in the a11y tree until opened)
- `e2e/tests/dashboard-next/caseworkers.spec.ts:88`
- `e2e/tests/scenarios/participant-names.spec.ts:46` (Unreplied)
- `e2e/scenarios/steps.ts:3087,3153,3190` ("Needs you now", "Follow-ups due")
- `e2e/performance/routes.ts:398-401` (headings and "All caught up")
- `app/test/todayApi.test.ts`, `app/test/todayUnmatchedNonRegression.test.ts`,
  and the dashboard `buildToday` / `Today` / `useToday` tests

Any of these that finds a row among more than 5 now fails because the row is
hidden. Section 9 says only "extend the Today spec". List the breakage so the
plan budgets for it, and so nobody "fixes" a red spec by weakening it.

## 13. [MEDIUM] Today's per-refetch cost grows by the whole Follow up computation plus an unbounded tours walk

Today refetches on every placement / conversation / suggestion / tour /
contact event, from every open dashboard (`useToday.ts:150-166`). Each refetch
now also runs `buildFollowUps`: up to 100 available units paged, two Queries
per unit at 10-way concurrency, and one requireComplete BatchGet
(`followUps.ts:101-162`). It also runs the unbounded requested-tours walk
(finding 10).

A share fan-out emits `conversation.updated` per recipient (`sendMessage.ts:733`
via `broadcastFanOut.ts:925`), so a blast drives repeated full recomputes, and
the debounce only coalesces within 300 ms. The spec does not mention cost,
caching, or the `truncated` flag: past 100 available properties, quiet shares
truncate with only a server WARN (`followUps.ts:96-98`), contradicting "the
heading carries the full count". At minimum, state the read budget and the
truncation posture.

## 14. [LOW] W8 "whatever its automated flag" contradicts 7.2 "automated sends do not count"

7.2 says no automated send counts. W8 stamps every share "whatever its
`automated` flag", although a non-dashboard share is automated by definition
(`broadcastFanOut.ts:28-31,929`; `broadcastsRepo.ts:413-417`: "a future engine"
creates automated shares). The A1 contract's WP1 is AI ranking, so an engine
share path is plausible. Either carve shares out of 7.2 by rule or stamp only
`created_via === 'dashboard'`.

## 15. [LOW] W11 seed derivation contradicts the spec's own claim that stored rows cannot tell staff from automated

7.3 says the stamp must sit at call sites because "no stored field separates
staff from automated sends". W11 then derives the field from "the seeded
outbound rows". A sibling of `deriveSeedHeardFrom`
(`app/src/lib/seed/heardFrom.ts:59-89`) has only the stored rows, so it will
count seeded reminders and announcements (or needs a hand list). It also
cannot reuse `attributeInbound`, which is inbound-only and attributes
relay/group rows by sender key (`lib/heardFrom.ts:41-60`). Relay member
fan-out (W4's "every participant") needs its own rule. Specify it.

## 16. [LOW] Identify "oldest first" only orders an arbitrary 100-row sample; heading counts are capped counts

The triage read is capped at 100, and its GSI range key is the status, so the
sample has no recency order (`today.ts:965-972,914-918`). The unread side keeps
the NEWEST 100 (`today.ts:640-649`). Past 100, the oldest unknowns, the ones
5.2 says are "due a call or an Inactive mark", may not be in the result at
all, and 2.1's "full count" is the cap. Pre-existing cap, but the new ordering
claim is false past it. Say so.

## 17. [LOW] The 404 fallback cannot keep the "both paths agree" promise

The fallback's unknown row uses different copy ("New inbound - untriaged",
`dashboard/src/routes/today/buildToday.ts:290-301`). It emits EVERY
`unknown_1to1` thread whether unread or not (no unread check at :287), and it
has no contact `created_at` to order by. With no quiet shares and no
tours_to_book, "All caught up" on the fallback claims a done day it never
checked. 2.3 withholds the message for an unavailable section, and the
fallback should count as unavailable for both.

## 18. [LOW] Per-contact clock: a share of property B restarts property A's quiet clock

`last_reached_out_at` is per contact, and W8 stamps every share. Sharing a
second property, including a blast, resets the clock on every other pending
share for that person, without anyone following up on property A. That is
consistent with "any message either way", but 6.1's drop-off list should name
it, because it is the most common way a person will silently leave Quiet
shares.

## 19. [LOW] Small contract nits

- 7.3 says to copy `touchLastHeardFrom`, returning 'moved' / 'skipped' /
  'failed'. The real one returns 'written' / 'skipped' / 'failed'
  (`app/src/repos/contactsRepo.ts:982`).
- Quiet shares appear only by the passage of time (a threshold crossing). No
  event fires for that, so an open page never shows a share crossing the line
  until an unrelated event. Pre-existing pattern for due deadlines; worth one
  sentence.
- 6.3 "the first property is open by default" vs "a newly appearing property
  starts folded": on a page that mounts with zero quiet shares, it is undefined
  whether the first property to arrive opens.
- Canceling a requested tour makes the pair's outcome revert to replied /
  no_reply (`app/src/lib/listingSendTour.ts:20-22`, canceled yields no signal),
  so a canceled Tours to book row can reappear at once in Quiet shares. The
  6.1 drop-off list should say whether that is intended.
- The new subtitle "Clear every section above the line and the day's follow-ups
  are done" is false for an unanswered known-contact text, which by section 4
  is now only in the Inbox. It is a deliberate choice, but the copy overclaims.
