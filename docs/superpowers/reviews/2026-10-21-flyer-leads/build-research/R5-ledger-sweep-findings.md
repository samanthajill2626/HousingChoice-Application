# R5 - invariant sweep: listing_sends, ListingSendOutcome, activity_events, conversation unread state

Reader R5, build research for feat/flyer-leads, 2026-10-21. Read-only sweep of
app/, dashboard/, e2e/, scripts/, app/scripts/ and fake-twilio/ on
W:\tmp\flyer-leads @031a46d6 (code identical to main @b7959e2a), against plan
sections 0-4 (3.1 above all) and slices S3-S6 where they touch these surfaces.
The full writer / reader inventory is in the reference file
(.superpowers/sdd/research/R5-ledger-sweep-reference.md); this file holds only
what the plan or spec gets wrong or omits.

Counts: BLOCKER 0, MAJOR 1, MINOR 0, NOTE 6.

Confirmed and NOT findings (detail in the reference): every listing_sends
writer and reader is named in plan 3.1 or a task, except the benign
ContactDetail.tsx:1434 tour-form default; no code outside summarize iterates
`shares` keys or counts rows by broadcastId; nothing reads `via`; the only
shares_op consumers are the ledger loop, the create-only dev fixture and the
tests the plan already edits (O1 breaks no other caller, and every
conformance LS case re-reads the token after a decline step); the app has no
switch or map over ListingSendOutcome or ActivityEventType; the only
ActivityEventsRepo literals are the real factory and the harness fake.

---

## F1 (MAJOR) The unread mark writes to whatever thread the phone resolves to; a relay pool number resolves to a relay_group, which the touch can reopen

Plan location: plan 2.6 step 8 and Task 4.3 step 3c (`markSignupUnread`);
plan 3.1 Invariant E (readers listed for 1:1 threads only); spec D6.3.

Evidence:
- `createOrGetByParticipantPhone` returns the first OPEN item on the
  byParticipantPhone GSI for the phone (app/src/repos/conversationsRepo.ts:1279-1289);
  its `type` argument is used only on create. A relay_group stores its POOL
  number as `participant_phone` (conversationsRepo.ts:1987-1992, :2221).
- The public form accepts any NANP number (app/src/routes/public.ts:142-144);
  a pool number has no contact holder, so today the route already creates a
  junk tenant holding it and its welcome is refused `relay_not_supported`
  (app/src/services/sendMessage.ts:478-484) - pre-existing and harmless.
- NEW with Task 4.3: `touchLastActivity` on that relay_group passes its
  condition (only group_text is exempt) and SETs `status = 'open'`
  (conversationsRepo.ts:1626-1650), then `incrementUnread` and one
  `conversation.updated` with relay fields. The repo's own D16 doc names this
  exact hazard for relay touches: "Bumping through that method would
  therefore resurrect a group closed during the backoff ... re-arming every
  open-gated path" (conversationsRepo.ts:676-683). The 1:1 send wrapper
  refuses relay and group threads for the same reason (sendMessage.ts:174-187,
  invariant 13.6 at :197); the new 1:1 writer does not.

Scenario: anyone who knows a relay group's pool number (every member gets
texts from it) signs up on any flyer or /join with that number. The open relay
group jumps to the top of the inbox, unread, with no new message. If staff
closed the group within the GSI's replication lag, the stale OPEN image is
returned and the touch writes `status = 'open'`: the closed group is live
again for the tour-reminder gate (app/src/jobs/tourReminders.ts:1511), the
roster-action gate (app/src/jobs/rosterActions.ts:347, :394) and relay fan-out.
Low reachability, but it is a write to a relay thread from the
unauthenticated surface that no slice, test or watch item covers.

Correction (Task 4.3, one guard + one test):
- `markSignupUnread` takes the resolved conversation (or its type) and
  returns early when `!isOneToOneBucket(conversation)` (app/src/lib/unreadFeed.ts:295),
  logging WARN `{ marker, step: 'touch' }` with a non-PII reason; the pin,
  the ledger write and the audit are unaffected.
- Test in `app/test/publicSignupLeads.test.ts`: seed an open `relay_group`
  whose `participant_phone` is P in `world.conversations` (the fake fast path
  mirrors the real one, app/test/helpers/twilioWebhookHarness.ts:653-655),
  sign up with P, assert the relay row's status, unread_count and
  last_activity_at are unchanged, `world.touches` has no entry for it, and no
  `conversation.updated` names it.
- Spec D6.3 / plan 3.1 Invariant E: say the mark applies to a 1:1 thread only.

## F2 (NOTE) No writer ever closes a 1:1 thread, so the "reopen a closed thread" reasoning guards a state the tree cannot produce

Plan location: spec D6.3 ("Touching first means a failure can never leave a
closed thread flagged unread but invisible"); plan Task 4.3 / S4 E watch item
and plan review R1 #6 (the stubbed CLOSED-thread spy test); R6 F2's bullet
that "an existing unknown contact's closed thread re-enters" Today.

Evidence: the only conversation status writers are touchLastActivity ('open',
conversationsRepo.ts:1626-1684), createConversationRow ('open'), the importer
(1:1 = 'open', app/src/lib/import/apply.ts:1293), and relay / group_text-only
writers (setRelayStatus :2156, assignPoolNumberAndOpen :2205,
createGroupTextThread :2437, convertRelayGroupToGroupText :2663).
app/src/routes/contacts.ts:1349-1351 states it: "1:1 threads only ever write
'open', so the 'closed' partition is relays-only".

Consequence: touch-before-increment is harmless and the R1 #6 test is a fine
defensive pin, but no 1:1 thread is ever reopened by a sign-up (only a
hand-edited legacy row could be closed). The one real reopen risk is a relay
group (F1). No build change; record it so nobody designs around "reopening".

## F3 (NOTE) The blank inbox preview also hits contacts WITH history: the inbox row follows the contact's newest conversation

Plan location: spec D6.3 ("The inbox preview still shows the newest
message"); plan 2.6 step 5 (`conversationTypeFor` creates a first thread);
extends R6 F2's inbox bullet.

Evidence: a sign-up phone with no thread gets a new empty one (plan Task 4.2
step 3d); its preview falls back to '' with direction 'inbound'
(app/src/routes/inbox.ts:677-682). The inbox row for a contact is built from
its NEWEST conversation (inbox.ts:946-951, :1039), which is that just-touched
empty thread.

Scenario: a tenant with months of texts on their primary number signs up with
their second number (findByPhone resolves pointers to the owner,
app/src/repos/contactsRepo.ts:1303-1312). The new empty thread is the newest,
so the inbox row reads bold and blank instead of the tenant's last message.
Same for staff-created, imported and partner contacts that never texted (the
S6 landlord /join test is this shape and asserts only the badge, so it stays
green).

Correction: none required to go green; fold into R6 F2's ruling (document it,
or give the touch a preview).

## F4 (NOTE) "Sent <date>" is printed for flyer-latest pairs whose outcome is not signed_up; the date is the sign-up and the property may never have been sent

Plan location: spec D8 "Renderers" (words defined for `signed_up` only);
plan Task 5.2 step 3b(iii) (`sentWords` keyed on `row.outcome === 'signed_up'`);
FollowUpView is not touched.

Evidence: `summarize` moves sentAt to the flyer entry (plan 2.1 / Task 3.1),
and decline > tour > replied all outrank signed_up (plan 2.4). The roster row
prints "Sent" for every other outcome (dashboard/src/routes/contact/Card.tsx:361
after the S5 gate) and FollowUpView always prints "Sent"
(dashboard/src/routes/broadcasts/FollowUpView.tsx:118-120). The wire carries
no field that says the latest entry is the flyer one.

Scenario: a new lead signs up on the flyer (never texted the property); staff
mark them Not interested, or they book a tour, or they reply: the row reads
"Sent Oct 21 - Not interested" / "Interested" / "Replied" for a property
nobody sent. For a pair that WAS sent earlier, the date shown is the sign-up,
not the send.

Correction: a copy decision for Cameron, outside the plan's power: accept and
note it in the GLOSSARY entry (Task 6.4), or add a wire flag (for example
`signedUpFromFlyer`, from `latestCountedShareKey`) that the row words key on
instead of the outcome. No stored field is needed either way.

## F5 (NOTE) A flyer pair returns to Follow up after ANY later inbound - including UNKNOWN contacts, which Follow up never listed before

Plan location: spec D8 ("signed_up is never waiting ... not on the Follow up
tab and not in the '<n> waiting' pill"); plan Task 3.4 pins only the
derivation ("a reply AFTER it -> replied").

Evidence: replied outranks signed_up (plan 2.4); isWaiting keeps `replied`
(app/src/lib/listingSendOutcome.ts:123); every inbound on a 1:1 thread stamps
its participant's last_heard_from_at (app/src/lib/heardFrom.ts:94-95);
isEligibleRecipient applies the status gate to tenants only
(listingSendOutcome.ts:103-107); followUps keeps any eligible typed contact
(app/src/services/followUps.ts:161-191). Before this branch only broadcasts,
seeds and the dev fixture wrote listing_sends, so an `unknown` contact never
had a pair.

Scenario: a fresh phone signs up on the flyer and gets the welcome, which ends
"Reply STOP to unsubscribe, HELP for help" (app/src/lib/smsCompliance.ts:133).
They reply "thanks". 24 hours later the pair is on the Follow up tab and in
the property's waiting pill as "Sent <sign-up date> - Replied, quiet 1 day";
an existing UNKNOWN contact that signed up and then texted shows there the
same way (with Not interested and Text only).

Correction: consistent with the approved D8 order, so no logic change. Make
it a decision rather than an accident: add a PIN case to
`app/test/followUps.test.ts` in Task 3.4 (flyer-latest pair + a later
last_heard_from_at, past QUIET -> listed as `replied`, an unknown contact
included) and one GLOSSARY sentence in Task 6.4.

## F6 (NOTE) Invariants C and E list one reader each; the other readers of activity_events and of the unread state are unaffected but unnamed

Plan location: plan 3.1 Invariant C ("Reader: hasEventSince") and Invariant E
("Readers: inbox, unread feed").

Evidence and verdict, per reader:
- activity_events, `jobs/rosterActions.ts:230-301` (the removal scan): reads
  newest-first, 25 events x 10 pages, and REFUSES the deferred roster add when
  the cap is hit before the row's createdAt (:290-296). signed_up pins are
  bounded to (available properties + 1) per contact per 24 hours, so a planted
  flood cannot reach 250 events inside a pending window at today's portfolio
  size. No change.
- activity_events, `routes/contactTimeline.ts:1376-1389`: every type passes
  through `toTimelineMilestone` (:678-688); only listing_sent is re-worded
  (:1386). No change.
- Unread state: besides the inbox and the unread feed, the nav badge
  (dashboard/src/app/UnreadContext.tsx:286-292), the tour / placement hub
  channel dots (tours/useTourChannels.ts:256-262,
  placements/usePlacementChannels.ts:264-270), the contact page's unread
  state (contact/ContactDetail.tsx:416-425) and ThreadUnreadToggle
  (conversation/ThreadUnreadToggle.tsx:63-76) all show the bump by
  construction; Today is R6 F2. The contact page auto-read fires on mount,
  visibilitychange and every org-wide message.persisted, never on
  conversation.updated (contact/useMarkContactRead.ts:200-210), so an
  already-open contact page keeps the mark until the next such trigger.
- last_activity_at: every existing touch stamps the message's own instant,
  and the late writers use a "never backwards" read-then-write guard
  (app/src/jobs/broadcastFanOut.ts:1486, app/src/jobs/sendReconcile.ts:973,
  :1090). The mark's blind touch at the app clock can step a thread back by
  under a second against a concurrent inbound too, not only against the
  welcome (S4 E watch item). Cosmetic, as the plan already rules.

Correction: name these readers in plan 3.1 as watch items (no task change).

## F7 (NOTE) Invariant D sweep: applyFlyerShareEntry is the only path from a sign-up to a pair's decline state

Plan location: plan 3.1 Invariant D; spec D7.

Evidence: a pair leaves not_interested only through a later counted share
(sentAt), tenant tour activity, or the staff outcome route
(listingSendOutcome.ts:47-59; routes/units.ts:1540-1746). POST
/public/housing-fair writes listing_sends only through the flyer apply, creates
no tour, never writes last_heard_from_at (which moves only `replied`), and
never reaches the outcome route. O1 is sound: the decline writers are called
only from units.ts:1656, :1671, :1700, and no other code reads shares_op.

One adjacent residual, already inside D4: when findByPhone misses
(a dangling pointer, byPhone GSI lag, or a double submit of a fresh phone -
`contactsRepo.create` has no phone condition, contactsRepo.ts:1447-1464), the
sign-up creates a second contact whose pair carries no decline. That is not
an override of the original pair, and the duplicate is already checked by
default in a blast today without any listing_sends row. No change.
