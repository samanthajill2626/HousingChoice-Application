# R1 adversarial code review - feat/today-checklist

Reviewer: R1 adversarial (plan-blind: code, tests and repo only; nothing under
docs/superpowers was read). Branch feat/today-checklist at c7705789, base main
970a29b9. Diff package: .superpowers/review/r1/code-diff.txt.

Gate battery observed before any test was run (.superpowers/gates/run1):
typecheck 0, npm test 0, smoke 0, e2e 0 (376 passed, 17.8m).

Every throwaway test named below was created beside its suite, run bare, quoted
here, and deleted. `git status --short` was empty afterwards.

Counts: HIGH 0, MEDIUM 0, LOW 4, INFO 2.

---

## R1A-1 - LOW - CONFIRMED - one person listed twice in a Today list (duplicate row keys)

Location:
- app/src/routes/today.ts:966 (unread-pass dedupe keeps the NEWEST thread),
  :1010 (emittedUnknownPhones is fed only from the kept thread's
  participant_phone), :1113 (the triage pass dedupes by PHONE only)
- app/src/routes/today.ts:791-834 (relay opt-out pass: one row per group, no
  dedupe set)
- dashboard/src/routes/today/TodaySection.tsx:73 (Fragment key) with
  dashboard/src/routes/today/Today.tsx:86-88 (key = refType:refId)

Behavior: the Identify rows come from two passes. The unread pass dedupes a
person's several unknown_1to1 threads and keeps the newest one; it then
records that thread's participant_phone so the triage pass can skip the same
person. The triage pass skips a needs_review contact only when contact.phone is
in that set. When the kept thread is an EMAIL thread (no participant_phone) -
because the person's email is their newest activity, or they only have an
email thread - nothing is recorded, and the triage pass emits the same contact
a second time. Both rows carry refType 'contact' and the same refId, so the
Identify list renders two rows for one person under one React key, and its
"Show all N" counts the person twice. The same shape exists in Needs you now:
a member opted out of two open relay groups gets one row per group with the
same contact refId. The Today.tsx comment and the existing test (todayApi
"an unknown contact with an unread PHONE thread AND an unread EMAIL thread
yields exactly ONE identify row") only hold when the PHONE thread is newest.
The dedupe logic is pre-existing (it fed needs_you_now on main); this branch
moved it into the new Identify section and into the new LimitedList, which
keys rows by refType:refId.

Evidence: app/test/zz-r1adv-1.test.ts (deleted), on the harness world:

    x identify: an unknown contact whose NEWEST unread thread is its email thread is listed once
      -> expected [ 'contact:c-dupe', 'contact:c-dupe' ] to deeply equal [ 'contact:c-dupe' ]
    x identify: an unknown contact with ONLY an unread email thread is listed once
      -> expected [ 'contact:c-mail', 'contact:c-mail' ] to deeply equal [ 'contact:c-mail' ]
    x needs_you_now: a member opted out of TWO open relay groups is listed once
      -> expected [ 'contact:c-opt', 'contact:c-opt' ] to deeply equal [ 'contact:c-opt' ]
    Tests 3 failed (3)

Fix: dedupe by the emitted identity, not by phone. Keep one Set of emitted
`identify:contact:<id>` keys shared by the unread pass and the triage pass (the
triage pass skips a contactId already emitted, whatever its phone), and give
the relay opt-out pass a contact-ref set (one Needs you now row per member,
optionally naming how many groups). Add the "email thread is newest" case next
to the existing phone-newest pin.

---

## R1A-2 - LOW - CONFIRMED - one failed live refetch wipes the viewer's Today state; Quiet shares re-seeds

Location:
- dashboard/src/routes/today/useToday.ts:155 (a failed refetch sets
  status 'error' while keeping the data)
- dashboard/src/routes/today/Today.tsx:448-454 (the whole checklist renders
  only while status === 'ready')
- dashboard/src/routes/today/QuietShares.tsx:148-157 (seeded / openByUnit are
  component state); dashboard/src/routes/today/TodaySection.tsx:65 (expanded)

Behavior: QuietShares.tsx promises "After that the viewer's choices are kept
by unitId across live refetches". Today refetches on every
conversation.updated / contact.updated / tour.updated (300 ms debounce), so a
transient 5xx or a network blip on any one of those refetches is ordinary.
That refetch flips status to 'error'; Today.tsx then unmounts every section
(QuietSharesSection and every LimitedList with it). When the next refetch
succeeds the sections remount with fresh state: Quiet shares re-opens the first
property and folds the rest (overriding what the viewer chose), and every
"Show all N" / "Show fewer" expansion resets. Blanking the page on a failed
refetch is pre-existing; the per-viewer state that does not survive it is new
in this branch.

Evidence: dashboard/src/routes/today/zz-r1adv-2.test.tsx (deleted). Fold u1,
open u2, expand Needs you now, then one refetch fails (status 'error', same
data) and the next succeeds with the SAME data:

    x R1A-2 Today state across a failed refetch > keeps the viewer's Quiet shares
      choices and Show all expansion after one refetch fails and the next succeeds
      -> expect(element).toHaveAttribute("aria-expanded", "false")
         Received: aria-expanded="true"      (u1, re-seeded open)
    Tests 1 failed (1)

Fix: on a failed REFETCH keep rendering the last good load and show a small
"Could not refresh - reload to see the latest" notice (the useTodayPastTours
reloadFailed pattern), reserving the full error state for the first load; or
lift `seeded` / `openByUnit` and the section expansions into useToday / Today
so they outlive the status branch.

---

## R1A-3 - LOW - CONFIRMED - past tours: every Past row's tenant and property is point-read on every load and every tour.updated

Location:
- dashboard/src/routes/today/useTodayPastTours.ts:115-140 (labelRows reads
  every row's tenant and unit at once), :117 (tenant cache is per pass), :188
  (every tour.updated reloads)
- the Past window is PAST_TAB_DAYS = 90 (dashboard/src/routes/tours/useTours.ts:160)
- new tour.updated emitters: app/src/routes/tours.ts:421 (every create),
  app/src/routes/units.ts:1669 (every Interested create)

Behavior: main labeled at most TODAY_PAST_TOURS_CAP (5) rows (walking past
deleted tenants only as far as needed). This branch labels EVERY Past row
"so Show all N counts the rows Today qualifies": one GET /api/contacts/:id per
distinct tenant and one GET /api/units/:id per distinct property, all in
flight together, on every Today mount; and on every tour.updated it re-reads
every tenant (units are cached, tenants deliberately are not). The Past list
spans 90 days of undecided tours (scheduled-not-marked, toured-without-outcome,
no-shows, needs-placement), so the cost grows with exactly the backlog the
section exists to show. This branch also makes every tour CREATE emit
tour.updated - including requested tours, which can never be Past rows - so
each Interested click on the Follow up tab and each tour create re-reads the
whole tenant list in every open Today tab. On an HTTP/1.1 connection these
requests also queue ahead of the page's other reads.

Evidence: dashboard/src/routes/today/zz-r1adv-3.test.tsx (deleted), 60 Past
rows, then one tour.updated for a new requested tour:

    x R1A-3 past-tours labeling cost > a Past list of 60 rows costs no more than
      a handful of point reads per load / per tour.updated
      - "loadContacts": 5,  "loadUnits": 5,  "reloadContacts": 5,
      + "loadContacts": 60, "loadUnits": 60, "reloadContacts": 60,
        "reloadUnits": 0,
    Tests 1 failed (1)

Fix: label lazily (the 5 shown rows, the rest when "Show all" is pressed), or
have the server return the Past rows already named and filtered for deleted
tenants (the Today route already memoizes contact reads); at minimum skip the
reload for a tour.updated whose tourId is not on screen and whose status is
'requested' (it cannot enter Past), and keep tenant labels across passes with a
consistent re-read only for the deleted check.

---

## R1A-4 - LOW - CONFIRMED - the two halves of the quiet clock can land on different contacts; the backfill disagrees with the live stamp

Location:
- live W1: app/src/services/sendMessage.ts:514, :532, :770 (stamps
  `heldRecipient ?? phoneContact`, i.e. contacts.findByPhone)
- live W6: app/src/routes/webhooks/voice.ts:1347, :1354 (stamps
  contacts.findByPhone(participant_phone))
- inbound half: app/src/routes/webhooks/twilio.ts:955 etc. ->
  app/src/lib/heardFrom.ts:108 (attributeInbound: roster contact FIRST)
- backfill: app/scripts/backfill-last-reached-out.ts:453-455, :470-472
  (recipient_contact_id, else attributeInbound order: roster first)
- dev W8: app/src/routes/dev.ts touchFixtureReachedOut (oneToOneThreadContactId,
  roster first)
- findByPhone on a duplicated number answers "the FIRST item the GSI yields
  (arbitrary order)" (app/src/repos/contactsRepo.ts:1319-1332)

Behavior: Quiet shares reads last_heard_from_at and last_reached_out_at off
the share recipient's contact and takes the later one. On a one-to-one thread
whose roster contact is not the number's first byPhone holder (a household or
shared number, a number held as one contact's primary and another's pointer,
a number that moved), an inbound reply is attributed to the roster contact
while a staff text or call is stamped on the phone holder. For the roster
contact staff follow-up then never restarts the clock (they reappear in Quiet
shares 2 or 5 days after their last reply although staff texted since); for the
phone holder replies never do. The one-time backfill uses the roster-first rule
for the same rows, so it writes a different contact than the live path does,
although the RUNBOOK says it "applies the same rules the live sends follow" and
its list of accepted differences does not name this one.

Evidence: app/test/zz-r1adv-4.test.ts (deleted). One thread, roster
c-roster, the number's first holder c-holder; a staff text through the real
route and default send service, then planThreadPage over the stored row:

    x R1A-4 live stamp vs backfill attribution > a staff text is attributed to
      the same contact live and in the backfill
      "backfill": [ - "c-holder", + "c-roster" ],
      "live": [ "c-holder" ]
    Tests 1 failed (1)

Fix: attribute outbound staff outreach with the SAME rule as the inbound half
(oneToOneThreadContactId(thread): roster, then phone, then email) in W1 and W6
- the gates can keep judging the phone holder - so heard and reached always
name one contact and the backfill matches by construction. If the phone-holder
rule is intended, make the backfill use findByPhone for one-to-one rows and add
the divergence to the RUNBOOK's list.

---

## R1A-5 - INFO - PLAUSIBLE - Tours to book can miss a just-created request (or keep a just-booked one) after its own live event

Location: app/src/routes/today.ts:724 (tours.listByStatus('requested') over
the byStatus GSI, eventually consistent); emitters
app/src/routes/tours.ts:421 and app/src/routes/units.ts:1669 fire immediately
after the write; dashboard/src/routes/today/useToday.ts:52 (300 ms debounce).

Behavior: the tour.updated a create (or a booking PATCH) emits triggers one
Today refetch about 300 ms later. That refetch reads the byStatus GSI, which
can still lack the new requested tour (or still list a just-booked one under
'requested' - the defense-in-depth `t.status !== 'requested'` check at
today.ts:726 reads the same stale projected item). No later event follows, so
the row stays wrong until an unrelated event. The same residue is acknowledged
for Quiet shares' tours byUnit join (today.ts:1218, "a just-written tour can
lag by index replication until the next refetch") but not for Tours to book,
whose e2e live check ("two requested tours appear on an OPEN Today page live")
passes only because DynamoDB Local applies GSI writes synchronously - as does
the harness fake.

Evidence: reasoned (no in-process fake models GSI lag). Interleaving: T0 POST
/api/tours writes the tour and emits tour.updated -> T0+300 ms Today GET ->
byStatus Query returns the pre-write partition -> response without the row ->
no further event.

Fix: schedule one delayed second refetch (for example +2 s) after a
tour.updated, or have the route merge a consistent GetItem for a tourId the
client names; at minimum record the residue beside the Quiet shares note.

---

## R1A-6 - INFO - PLAUSIBLE - transitional mismatch: a post-deploy staff Retry of a pre-deploy Send-now row stamps live but is excluded by the backfill

Location: app/src/routes/api.ts:1911-1920 (the W2 gate and the systemCopy
marker judge only the pressed row's automated / system_copy);
app/scripts/backfill-last-reached-out.ts:415-420 and :283-287 (the backfill
also excludes a Retry whose retried row or root matches a Send-now BODY).

Behavior: a tour reminder / nudge "Send now" sent before the deploy carries
automated:false and no system_copy. If it failed and staff press Retry after
the deploy, the live gate stamps last_reached_out_at (and writes no marker on
the new row, so a later Retry of that Retry stamps too), while the backfill
classifies the same Retry as retry_of_system_copy. Limited to failed pre-deploy
Send-now rows retried inside the 14-day window; harmless in volume but it is
an undocumented live/backfill difference.

Evidence: reasoned from the two code paths above.

Fix: either apply the same body rule in the W2 gate during the window (nudge
catalog bodies and recent reminder sentBody), or list it in the RUNBOOK's
accepted differences.

---

## Swept, no finding

- Writers: every outbound path in app/src enumerated (sendMessage callers in
  routes/api.ts:1578, :1890, jobs/missedCallAutoText.ts:249, jobs/tourReminders.ts:1436,
  :1998, jobs/placementNudges.ts:672, :854, routes/public.ts:652, jobs/broadcastFanOut.ts,
  jobs/retrySend.ts; the email service has one caller, routes/api.ts:1685; group
  send; relay fan-out and announcements; voice originate/press-1). Only staff
  paths pass staffOutreach / staffAuthored; automated, share, machine-retry and
  Send-now paths never stamp. The force-sends add systemCopy only (no gating
  change). No send path's gating, append or return changed.
- recordStaffOutreach (services/staffOutreach.ts:45-70) never throws; per-contact
  latest instant; unparseable instants ordered first. touchLastReachedOut
  (repos/contactsRepo.ts:2073-2110): pointer guard, normalized ISO,
  attribute_exists + forward-only condition, never throws. Every other contact
  writer is a SET/REMOVE UpdateItem or a conditional create, so no whole-item
  write can clobber last_reached_out_at; PATCH/create refuse a client value
  (routes/contacts.ts:314-327).
- Event order: W1 contact.updated after conversation.updated
  (sendMessage.ts:755-778); W3 after the sent emit (sendEmailMessage.ts:541-552);
  W5 stamps before its conversation.updated (groupSend.ts:718-749); W4/W7 one
  fresh consistent-read conversation.updated after the loop
  (relayAnnouncements.ts:194-226; relayFanOut.ts:1696-1702), placed before the
  continuation enqueue. The bus isolates listeners (lib/events.ts:399-411); the
  worker bridge forwards every AppEventMap name (lib/eventBridge.ts:45). Inbound
  SMS paths touch heard-from before their conversation.updated
  (webhooks/twilio.ts:961/1076 etc.); the three paths that did not now emit
  contact.updated only on 'written' (redeliveries emit nothing).
- Today refetch: useToday aborts the in-flight load on each new event, so the
  last fetch always starts after the last event; the Quiet shares contacts batch
  is ConsistentRead (followUps.ts:193-199, contactsRepo.ts:1079).
- Relay fan-out: stamps only team posts, only sent / sent_unrecorded /
  stranded-after-send legs with a contactId (relayFanOut.ts:1589-1599); the
  30003 retry rung never stamps; terminal members are skipped on redelivery;
  every pass (first, continuation, re-drive) announces its own legs once.
- Voice: the press-1 stamp is handed to afterResponse after sendTwiml
  (voice.ts:1794-1799); no new await before the <Dial>; refusal, DNC and
  timeout branches never stamp; the default afterResponse swallows with an
  errName-only log.
- Today route: Tours to book and Quiet shares each have their own try/catch
  (today.ts:723-751, :1231-1245); unit labels degrade to the unitId; ordering
  comparators handle +Infinity ties; the owner test runs before the cap. Other
  sections stay all-or-nothing as on main (by design).
- Backfill targeting: dry run by default; --apply writes only
  contacts.last_reached_out_at through touchLastReachedOut; reads a conversations
  Scan, one messages key-condition Query per conversation (pointer partitions
  are separate PKs, so none is read), a tourReminders Scan and byPhone/byEmail
  lookups; importing backfill-last-heard-from.ts does not start its CLI
  (its invokedDirectly check is false under this script's argv). Classification
  rules (automated, broadcast_id, retry_attempt / retry_window_start,
  system_copy, retry origin/root, imported_from, emails, dialed calls, relay
  sent slots, group slots, edited intro by body, Send-now by body) match the
  live writers except R1A-4 and R1A-6 and the RUNBOOK's documented gaps.
- system_copy: written true-only by messagesRepo.append (:2653-2655) and the
  harness fake; carried by retrySend.ts:567 and sendReconcile.ts adoptRetry
  (both through messages.append); messagesRepo has no projections, so every
  reader sees it.
- attributeInbound refactor (lib/heardFrom.ts:54-120) is behavior-identical
  (group threads return before step 3).
- Dashboard: contact.updated now arrives on every staff send; useContact
  re-reads in place, ContactEditForm seeds at mount, StaffNotesCard holds its
  own draft, ContactDetail resets keyed on contactId, ContactCommsPane's
  override reset is mirrored up first - no draft loss. tour.updated consumers
  other than Today filter by tourId. No stale reader of 'unreplied' or the old
  section names remains in src.
- Auth/PII: no new route; Today stays behind requireAuth; new log lines carry
  ids, counts, sections and error names only.
- Seeds: no last_reached_out_at seed derivation, but the seeded listing sends
  use fixed 2026-04/05 dates, outside the 14-day window, so no seeded Quiet
  shares row is affected.
- Added lines are ASCII (0 non-ASCII bytes in the diff's added lines).
