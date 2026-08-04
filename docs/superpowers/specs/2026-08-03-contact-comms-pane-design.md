# Contact comms pane - person-centric 1:1 tabs on tour and placement pages

- Date: 2026-08-03 (v3 - revised after adversarial spec review + its v2
  addendum, see .superpowers/review/spec-adversarial.md; earlier versions
  superseded in-place)
- Status: approved (Cameron, this session)
- Branch: feat/contact-comms-pane  Worktree: w:/tmp/contact-comms-pane

## Problem

The Tenant and Landlord/PM 1:1 tabs on the tour page (TourConversation) and the
placement page (PlacementConversation) are NOT the contact page's comms pane,
even though staff expect them to be. They are single-conversation transcripts
built on useRelayThread, whose mapper `toTimelineMessage` drops `type: 'email'`
and `type: 'call'` rows by design (correct for relay groups, wrong for 1:1s),
and whose channel resolution binds each tab to ONE arbitrary conversation (the
contact's first non-relay conversation on the inbox page).

Observed + latent bugs this causes on those tabs:

1. Emails invisible (reported). Inbound email threads into the contact's phone
   1:1 server-side (tier 6 in inboundEmail.ts), lands in exactly the fetched
   conversation, and is then dropped client-side. Worse variant: a contact
   whose email arrived before any text has a SEPARATE email-keyed conversation
   the tab never fetches.
2. Calls invisible - same drop line (sibling of the open
   `inbound-calls-invisible-in-inbox` issue; this spec fixes the tour/placement
   surfaces, not the inbox surface).
3. Multi-phone contacts: each phone number is its own conversation by design;
   texts from the non-bound number are invisible.
4. The tab shows an unread dot for messages the transcript never displays
   (inbound email bumps unread_count).
5. No Upcoming section: 1:1-routed tour reminders do not show on the tour page
   itself (useRelayThread's scheduled bucket is empty for 1:1s by design).
6. Missing composer features: no reply-target picker, no email compose, no
   retry-failed-send.

Additionally (surfaced by the adversarial review, B1): the person milestone
feed is INCOMPLETE on the write side. Tour/placement lifecycle events are
recorded against the TENANT only (tours.ts recordTourEvent, placements.ts
recordPlacementMilestone); `tour_group_opened` and `tour_converted` exist only
on the tour's own `tours#<tourId>` audit trail and never reach any person
feed; the landlord's only tour pins come from a degraded property-audit
interleave (landlord-TYPED contacts only, generic labels, 25-unit cap).

## Decision (approved by Cameron, 2026-08-03)

1. PURE PARITY: the tenant/landlord 1:1 tabs on tour and placement pages
   become the SAME person-centric comms pane as the contact page - full
   timeline (messages, calls, emails, milestones, upcoming), extracted from
   ContactDetail into a shared `ContactCommsPane`. Cameron's ruling: "all
   that activity data should be on EVERY 1:1 timeline panel" - historical
   activity from the person's other tours/placements showing on a tour page's
   tab is accepted, including on the LANDLORD tab (that landlord's whole
   cross-property history: other tenants' tour pins, broadcast pins). The
   existing "Comms only" toggle is the quieting mechanism.
2. WRITE-SIDE COMPLETION (in scope, load-bearing for 1): fill the person-feed
   gaps so parity loses nothing - record tour/placement lifecycle events
   against the LANDLORD contact too, and record `tour_group_opened` /
   `tour_converted` as person activity events for both parties. Forward-only:
   there is NO production history to backfill (M1.11 cutover has not
   happened); dev/demo worlds regenerate via reseed.
3. The client-side this-tour milestone injection is removed from the 1:1 tabs
   (the person feed now genuinely carries those events; keeping both would
   double-pin). The GROUP tab keeps the injection (relay threads are excluded
   from the person feed on purpose).
4. The v1 `scope: '1to1'` server change is DROPPED (review M3: relay groups
   carry the pool number as participant_phone, so `conversationsForContact`
   can never return one - the invariant holds structurally). Zero mark-read
   server changes; the invariant gets a pinning unit test instead.

Rejected alternatives:
- Just stop dropping email/call in useRelayThread: leaves bugs 3-6 and the
  arbitrary-conversation binding in place.
- Client-side multi-conversation merge in the tour hooks: reimplements the
  /timeline endpoint, badly.
- Comms-parity + keep this-tour pin injection (no write-side work): rejected
  by Cameron - the goal is tour/placement activity interleaved with comms on
  every 1:1 panel, owned by the person feed itself.
- Parity + injection + client dedup: fragile by construction (same event from
  two write paths with non-identical timestamps).

## Design

### 1. Write-side completion (server)

New `ActivityEventType` members: `tour_group_opened`, `tour_converted`
(app/src/repos/activityEventsRepo.ts:31). Dashboard: add both to the
TimelineMilestoneType union and the milestoneVariant + milestoneHref
mappings in Timeline.tsx. Labels are SERVER-owned (MilestonePin renders
`ms.label` verbatim) and both mappings have `default:` branches, so this
dashboard work is cosmetic-only and cannot block (addendum A-m2).

LANDLORD RESOLUTION RULE (addendum A-M3, decided): events are recorded
against whoever `unit.landlordId` resolves to AT EVENT TIME (point-in-time
ownership - a later unit re-assignment neither transfers pin history to the
new landlord nor strips it from the old one). This deliberately differs from
the property-audit interleave's retroactive current-owner walk, which after
this change carries only broadcast/status/contact pins. Mechanics: the
recorders gain the unitId (already in scope at every call site) and one
best-effort `units.getById` per recorded event; a resolve failure or a
landlord-less unit skips the landlord write silently and NEVER fails the
route. `tours.ts` and `placements.ts` already inject `units`; the
transition service (below) gains a `unitsRepo` dependency in
StatusTransitionDeps.

Write sites:

- `recordTourEvent` (app/src/routes/tours.ts:208): in addition to the tenant
  activity event, record the SAME event against the unit's landlord contact
  (resolve unit.landlordId at event time; skip silently when the unit has no
  landlord). Best-effort guarded like the existing three writes. Call sites
  (all inherit): tours.ts:306 (create-scheduled), 629 (scheduled), 631
  (rescheduled), 634 (took place), 637 (no-show), 640 (canceled), 648
  (outcome).
- Group-open route (tours.ts:882, currently `tours#` audit only): also record
  `tour_group_opened` person events for tenant AND landlord (label "Group
  text opened", refType 'tour'). Update the in-code comment at
  tours.ts:877-879 in the same change (it currently documents the OPPOSITE
  decision - "the tenant timeline ... deliberately do NOT carry it").
  Connect-when-ready nuance (addendum A-m3): the pin fires at open time even
  when the group is still `connecting` (no pool number yet) - accepted; the
  tour Activity card already shows the event for that case, so this is
  parity, not a new claim.
- Tour conversion (placements.ts:736, currently `tours#` audit only): also
  record `tour_converted` person events for tenant AND landlord (label
  "Converted to placement", refType 'tour'; the placement_opened event
  already fires separately).
- `recordPlacementMilestone` (placements.ts:436): record against the
  placement's unit landlord too. Call sites: placements.ts:565, 750,
  855-871. NOTE: these stage/closed sites belong to the raw PATCH handler
  the dashboard does NOT use; they are kept dual-party for consistency, but
  the operative writer is the next item.
- THE REAL PLACEMENT-STAGE WRITER (addendum A-B1): the dashboard moves
  stages via POST /api/placements/:id/transition ->
  `services/statusTransition.ts` transitionPlacement, which records
  `placement_closed` / `stage_changed` against the tenant at
  statusTransition.ts:224/226. BOTH of those writes gain the dual-party
  landlord recording (resolve via placement.unitId -> units.getById; add
  `unitsRepo` to StatusTransitionDeps and inject it where the service is
  constructed). The two writers serve different routes, so no single
  operation double-writes; each route records once, dual-party.
  `setTenantStatus` / `deriveTenantStatus` stay tenant-only
  (contact_status_changed is inherently per-person).
- The `tours#<tourId>` and `units#<unitId>` audit writes are UNCHANGED (the
  tour page's own activity card and the property activity card keep their
  sources).
- Known pre-existing duplicate, accepted (addendum A-m4): the legacy
  `tour_date` PATCH path (placements.ts:871) writes a `tour_scheduled` pin
  with refType 'placement' while first-class tours write the same-typed pin
  with refType 'tour'; dual-party recording copies that duplicate to the
  landlord feed IF that legacy path is ever driven. Not fixed here - noted
  as a watch item, file an issue if observed in practice.

Dedup at the read side: remove the tour_* members from `LANDLORD_FEED_TYPES`
(app/src/routes/contactTimeline.ts:228) so a landlord-typed contact does not
get the same tour twice (direct event + property-audit interleave). ALSO
delete the now-unreachable tour branches in `unitAuditToMilestone`
(contactTimeline.ts:505-517) so no reader assumes the interleave still
carries tours (addendum A-m6). `broadcast_sent`, `listing_status_changed`,
`unit_contact_added/removed` stay interleaved (no direct-event equivalent).
Consequence, accepted: pre-change tours stop showing on landlord contact
pages (their pins exist only as audit rows) - dev-only history, regenerated
on reseed. The de-facto regression proof for this swap is
e2e/tests/dashboard-next/landlord-activity.spec.ts:66-131 (labels + hrefs of
the direct writer match the interleave's, so it must pass UNCHANGED -
addendum A-m5).

Seeds (scope corrected by addendum A-M1/A-m1): the target is VOCABULARY
PARITY WITH THE LIVE WRITERS FOR BOTH PARTIES, not just the two new types.
`tourMilestones` (history.ts:670-694) today emits only tour_scheduled +
tour_took_place, tenant-only, while `tourTrail` models the full vocabulary -
once the injection is removed, seeded no-show/canceled/outcome tours would
lose their pins in the demo world. Extend `tourMilestones` to the full
vocabulary (scheduled / rescheduled / took_place / no_show / canceled /
outcome / group_opened / converted) for tenant AND landlord, and
`placementMilestones` (history.ts:632) to cover the landlord. Blast-radius
fact: `historyItems` runs in the FULL profile only (seed/index.ts:119-138)
and e2e reseeds default to LEAN - so history.ts changes have ZERO e2e blast
radius; the seed work is demo/live-QA-world only. The standing rule is
simply: do not add activity events to lean.ts.

### 2. New shared component: `ContactCommsPane`

Location: `dashboard/src/routes/contact/ContactCommsPane.tsx`.

Owns everything between "I have a contact + a timeline state" and "a working
comms pane". Moves IN from ContactDetail (move-shaped extraction - the logic
already exists and is hook/util-factored):

- Reply-target resolution (`buildReplyTargets`, selected target state, default
  target, `replyToPhone` + `replyToLabel` footer values, `canSend`).
- Optimistic SMS/MMS send (`postSend` + `onSend`): ensureContactConversation
  create-on-demand for a contact with no thread yet, addOptimistic /
  resolveOptimistic / failOptimistic, synchronous draft clear.
- Email compose + send (`onSendEmail`): existing-email-thread preference,
  phone-thread fallback, `ensureEmailConversation` fallback for phoneless
  contacts, optimistic EmailCard.
- Retry-failed-send (`onRetry`).
- Just-in-time consent gate: 409 `contact_no_consent` -> ConsentCaptureModal
  holding the pending send, deferred retry via `deferredSend`, internal
  clear-draft signal on success. After consent is recorded the pane applies
  the modal's updated Contact to its LOCAL contact override (below).
- The composer-triggered "Manage email" dialog (EmailManager). On save the
  pane (a) updates its local contact override, (b) calls
  `timeline.refetch()` (parity with ContactDetail.tsx:843 - the email_added
  milestone), and (c) fires optional `onContactUpdated(updated)` so a caller
  that owns page-level contact state (ContactDetail -> setContact) can sync;
  tour/placement pages omit the callback (review M2 - no refetch seam exists
  there, and none is needed).
- The `<Timeline>` invocation with the FULL current prop surface (review m2):
  key, status, items, upcoming, source, replyToPhone,
  replyToLabel=defaultPhoneLabel(phones), replyTargets,
  selectedConversationId, onSelectTarget, canSend, onSend, onRetry, optedOut,
  clearDraftSignal, resetScrollKey, emailChannel {emails, onSendEmail,
  onManageEmails, suppressed} - plus optional `emptyLabel` passthrough
  (review M6: the tour/placement tabs pass "No messages with <name> yet",
  preserving today's copy and TourDetail.test.tsx:1045).
- "Comms only" toggle persistence (addendum A-M2): Timeline's `commsOnly` is
  per-mount state today, and this design remounts the pane on every tab
  switch / seed nonce - the quieting mechanism the parity decision leans on
  must survive that. Timeline gains an optional CONTROLLED pair
  (`commsOnly` / `onCommsOnlyChange`); the pane passes them through; tour
  and placement pages hold ONE toggle state per page visit, shared by both
  1:1 tabs, above the remount boundary. ContactDetail stays uncontrolled
  (per-mount default off, today's behavior). Accepted residual (watch item):
  a landlord feed heavy with pins can fill the 50-item first page with no
  messages until the operator toggles Comms only - the toggle now at least
  stays put; a client `limit` bump or default kinds filter is the future
  lever if live QA shows it hurting.

Local contact override: the pane holds `effectiveContact` (prop, overridden
by EmailManager/consent updates); phones/emails/optedOut/emailSuppressed
derive from it. The keyed remount on contact change resets it.

Props (the boundary):

- `contact: Contact` (never null - callers gate on loaded contact).
- `timeline: ContactTimelineState` - the CALLER provides the hook state (see
  section 3 for who runs the hook where).
- `initialDraft?` / `onDraftSeeded?` (no-show check-in seed), `emptyLabel?`,
  `resetScrollKey`, `onContactUpdated?`.

NOT in the pane (stays in ContactDetail): header band, file pane, suggestion
chips, status pill, opt-out toggles, phone manager, the file-pane "Manage
email" entry, page-level useMarkContactRead, media gallery, delete/restore,
edit form, and all six external `timeline.refetch()` call sites
(ContactDetail.tsx:433/448/479/527/831 stay; :843 moves in).

### 3. Hook ownership (review B2)

- ContactDetail KEEPS the caller-owned `useContactTimeline` (it derives
  media-from-comms and calls refetch after on-page mutations) and passes the
  state down.
- Tour/placement pages must NOT hook at page level (the group tab has no 1:1
  contact; PlacementDetail passes a placeholder `tenantId: ''` while loading;
  `useContactTimeline('')` falls into the fetch-the-whole-inbox fallback).
  Instead a thin wrapper - `ContactCommsTab` (same file or sibling) - is
  MOUNTED ONLY when its 1:1 tab is active AND its contact is loaded; it runs
  `useContactTimeline(contact.contactId)` and renders the pane. Lazy
  single-tab mount is preserved. HARD RULE: `useContactTimeline` is never
  called with an empty/unresolved contactId.

### 4. Tour and placement pages

- TourConversation / PlacementConversation keep the three-tab rail, the group
  tab (unchanged: useRelayThread + roster + closed state + this-tour
  milestone interleave via withMilestones), the initial-tab rule, and lazy
  mount of only the active tab.
- Tenant/Landlord tabs render `<ContactCommsTab>` for the tab's contact.
  Keying (review M1): the tenant pane's key is `${contactId}:${seedKey}` so
  BOTH a contact change AND a no-show seed nonce remount it (pressing "Send
  no-show check-in" while ALREADY on the Tenant tab must still seed the
  composer - initialDraft is mount-only); the landlord pane keys on
  contactId alone. Draft isolation across tab switches is preserved by the
  remount.
- `ContactThread`, `NewContactThread`, and the duplicated pendingConsent +
  ConsentCaptureModal plumbing in BOTH files are deleted (the pane owns
  consent). The "no thread yet" special case disappears: the pane handles
  zero-conversation contacts (first send creates the thread).
- The this-tour milestone injection is REMOVED from the 1:1 tabs on the tour
  page (PlacementConversation's 1:1 tabs inject none today); the person feed
  now carries the events (section 1). The GROUP tab keeps the injection on
  both pages.
- Landlord-unresolved and contact-load-failure states: keep an empty-state
  message in the tab (the pane requires a loaded contact).

### 5. Unread dots + mark-read (reviews M3/M4/M5)

- Channel-state SHAPE (review M5), stated explicitly: `group` keeps
  `{conversationId, unread}` with today's resolution/merge/forId semantics;
  `tenant` and `landlord` become `{unread}` ONLY (no conversationId - the
  pane does not need one). `setConversationId` narrows to the `'group'` key;
  its 1:1 call sites die with the deleted create-on-demand plumbing. All
  `active.conversationId` consumer branches in TourConversation /
  PlacementConversation are rewritten for the new shape (the old `!== null`
  branch must not silently route 1:1 tabs anywhere).
- Tab unread = SUM of `unread_count` across the contact's non-relay
  conversations on the inbox page (same `getConversations` source, sum
  instead of first-match). HONEST LIMITATION (review m4): the inbox page is
  the first 50 OPEN conversations; a thread off that page is invisible to
  the dot (strictly more likely for a sum than for first-match, accepted;
  closed threads never count). SSE-debounced refetch keeps dots live,
  unchanged.
- Mark-read stays in the channels hooks, NOT the pane (review M4): a
  `markPersonRead(key, contactId, unread)` that (a) no-ops unless
  unread > 0, (b) zeroes the tab's unread LOCALLY so the dot clears
  instantly, (c) calls the EXISTING `markInboxRead({contactId})` fan-out -
  no server change, no options bag on useMarkContactRead (which remains
  contact-page-only). The group tab keeps `markConversationRead`
  (single-conversation), exactly as today.
- BEHAVIOR CHANGE, stated plainly: viewing a 1:1 tab now clears unread on
  ALL of that person's 1:1 threads (every phone + email thread = their whole
  inbox row), where today it cleared exactly one conversation. This is
  contact-page parity. The relay group's unread is untouched - guaranteed
  structurally (relay groups carry the pool number as participant_phone and
  no participant_email, so `conversationsForContact` cannot return them);
  pinned by a new unit test on conversationsForContact/inbox route rather
  than by a scope flag (review M3).

### 6. Honesty cleanup

`useRelayThread` returns to being genuinely relay-only. Update its email/call
drop comment to state the invariant plainly (relay threads never carry
email/call 1:1 content). No behavior change in that file. Close
`docs/issues/tour-1to1-optimistic-team-label.md` at handback - the pane uses
useContactTimeline.addOptimistic, which never stamps relay_sender_key
(review m9).

## Performance note (review M7, accepted)

Every 1:1 tab activation fetches `GET /api/contacts/:id/timeline` - an N+1
endpoint (one messages Query per conversation; for landlord-typed contacts up
to 25 unit-audit Queries; scheduled gather on page 1). Today a tab switch
costs one messages Query. Accepted at staff-dashboard scale (per-contact
conversation counts are small); lazy single-tab mount means one contact's
fetch at a time; switch-back refetches (no cache - YAGNI). Recorded as a
watch item; if it ever hurts, the fix is a small per-contact cache or keeping
both tabs mounted, not a new endpoint.

## Invariant surfaces (enumerated per the pipeline rule)

Protected state A: conversation `unread_count`.
- Mutators: inbound SMS/MMS append (twilio webhook), inbound email append
  (inboundEmail.ts), call rows (voice webhooks), single-conversation read
  (POST /api/conversations/:id/read), contact fan-out read
  (POST /api/inbox/:contactId/read - now called from tour/placement tabs),
  unknown-number fan-out read (POST /api/inbox/read), reseed.
- Readers/renderers: inbox rows + filters, nav unread badge, tour tab dots
  (useTourChannels - MODIFIED), placement tab dots (usePlacementChannels -
  MODIFIED), contact page useMarkContactRead (unchanged), SSE
  conversation.updated consumers.

Protected state B: 1:1 comms visibility (which surfaces render a person's
messages/calls/emails).
- Renderers: contact page pane (MODIFIED - extraction, must not regress),
  tour 1:1 tabs (MODIFIED), placement 1:1 tabs (MODIFIED), relay-group view
  ConversationDetail (must stay relay-only; inbox routes 1:1 rows to the
  contact page, verified), inbox row last-message previews (untouched), Today
  page reads (untouched).

Protected state C (new): person activity-event completeness.
- Mutators: tours.ts recordTourEvent + group-open route (MODIFIED),
  placements.ts recordPlacementMilestone + conversion (MODIFIED),
  services/statusTransition.ts transitionPlacement stage/closed recorders
  (MODIFIED - the writer the dashboard actually drives, addendum A-B1; its
  setTenantStatus/deriveTenantStatus contact-status recorders UNTOUCHED),
  contacts.ts / relayGroups.ts / broadcastFanOut.ts / suggestions.ts
  recorders (UNTOUCHED - assert no change), seed history.ts (MODIFIED).
- Readers/renderers: contactTimeline.ts merge + LANDLORD_FEED_TYPES
  interleave (MODIFIED - tour_* removed), dashboard Timeline milestone
  variant/label/link mapping (MODIFIED - two new types), tour page activity
  card (tours# trail - UNTOUCHED), property Activity card (units# audit -
  UNTOUCHED), Today page (assert unaffected by new event types).

Plan rule: every MODIFIED surface above gets an explicit task or watch item;
the untouched ones get a no-change assertion in review.

## Testing (Cameron: "significant testing to make sure we don't lose
functionality")

Gates: `npm run typecheck` + `npm test` + `timeout 1500 npm run e2e`, bare,
from the worktree, green on current main at handback.

Unit:
- ContactCommsPane: port/adapt ContactDetail's existing comms-pane tests
  (send, email send + fallbacks, retry, consent 409 flow incl. post-consent
  contact override, reply targets, canSend for zero-conversation contacts,
  EmailManager save -> refetch + override). NEW: a two-conversation contact
  (two phones, or phone + email-keyed) renders both threads' messages and
  offers the right reply targets (review m7 - the multi-phone assertion
  lives HERE, on the pane, not on the unchanged endpoint).
- ContactDetail: page still composes header/file/pane; media-from-comms and
  refetch-after-mutation work against the caller-owned hook.
- ContactCommsTab wrapper: mounts hook only with a loaded contact; never
  calls useContactTimeline with ''.
- useTourChannels / usePlacementChannels: aggregate unread sums across
  multiple non-relay conversations (incl. an email-keyed one), group channel
  untouched, markPersonRead gating + local zeroing, new state shape.
- TourConversation / PlacementConversation: tab switching, no-show seed
  INCLUDING the nonce-while-already-on-Tenant-tab case (review M1), empty
  states, emptyLabel copy.
- Server: recordTourEvent/recordPlacementMilestone dual-party recording
  (landlord resolved, landlord absent, resolve failure best-effort);
  transitionPlacement stage/closed dual-party recording (addendum A-B1 -
  drive the TRANSITION route, not the raw PATCH, in at least one test);
  group-open + conversion person events; LANDLORD_FEED_TYPES no longer
  interleaves tour_* and the dead unitAuditToMilestone tour branches are
  gone; new-type wire mapping; seed tourMilestones/placementMilestones
  vocabulary parity for both parties. Pinning test (review M3):
  conversationsForContact can never return a relay_group (pool-number
  participant_phone), so the mark-read fan-out cannot touch the group.
- Timeline controlled commsOnly: toggle state survives a pane remount on
  tour/placement pages; ContactDetail behavior unchanged.
- inbox route: fan-out behavior byte-for-byte unchanged (no scope flag).

E2e (extend existing specs; the email fixtures live in
flows/email-inbound.spec.ts / flows/email-outbound.spec.ts):
1. An email exchanged with a tenant is visible in the tour page Tenant tab
   and in the placement page tab (EmailCard rendered).
2. Viewing the Tenant tab clears the tenant's whole inbox row (all their 1:1
   threads) while the Group tab dot and the inbox group row survive (the
   REAL new mark-read behavior - review M3).
3. The tour page Tenant tab shows the tour's own upcoming reminders - use a
   SELF-GUIDED tour fixture (review m1: group-routed rungs are correctly
   absent from the person feed's upcoming bucket).
4. Sending SMS from a tour 1:1 tab still works end-to-end (outbox
   assertion), including for a tenant with no prior conversation.
5. Tour page tabs show this tour's lifecycle pins sourced from the person
   feed (post write-side): schedule -> pin appears on Tenant tab AND
   Landlord tab; group-open pin appears on both.
6. Contact page comms regression net (review m6 - the honest list):
   dashboard-next/contact-detail.spec.ts, dashboard-next/inbox-comms.spec.ts,
   flows/email-inbound.spec.ts, flows/email-outbound.spec.ts,
   dashboard-next/outbound-mms.spec.ts, dashboard-next/a2p-compliance.spec.ts
   (consent modal) - all pass unchanged. The reply-target picker and onRetry
   have UNIT coverage only; live-QA covers them by hand.
7. dashboard-next/landlord-activity.spec.ts passes UNCHANGED - the named
   proof that the LANDLORD_FEED_TYPES swap dropped no landlord tour pins
   (addendum A-m5).

Live self-QA (harness per profile): drive a tour page - email + call rows
render in the Tenant tab, tab dots behave (group dot survives), composer
targets correct, landlord tab shows cross-property history as accepted,
group tab unchanged; ALSO check the tour page comms pane at 360x640 (review
m5: docs/issues/comms-pane-overflows-on-short-viewports.md - the pane adds a
channel toggle, target picker row, and Upcoming section to a pane that
already overflows short viewports; note findings on that issue). Screenshot
evidence.

Known flakes to honor (re-run before blaming; report both): tour-reminders-
panel-e2e-flake, conversationdetail-members-mock-suite-flake,
tourdetail-composer-footer-suite-flake, inbox-specs-flaky-shared-tasha-state
(review m8).

## Watch items for the plan (from review NOTEs)

- n1: buildReplyTargets can default an SMS send into an EMAIL-keyed
  conversation when it is the contact's only thread (pre-existing on the
  contact page; newly reachable from tour/placement). Watch, do not fix
  silently - file an issue if observed.
- n2: stale selectedConvId after a phone-suggestion accept (pre-existing;
  moves into the pane unchanged; suggestion accepts stay in ContactDetail).
- n4: a 1:1 conversation with no participants roster (untriaged unknown
  thread pre-capture) stays invisible to the tab dot - same as today.
- Seed guard: history.ts is full-profile-only (zero e2e blast radius) - the
  rule is simply never add activity events to lean.ts (addendum A-m1).
- A-m4: the legacy tour_date PATCH duplicate tour_scheduled pin (see
  section 1) - watch, file an issue if observed.
- A-M2 residual: landlord-feed pin volume vs the 50-item first page (see
  section 2) - check during live QA.
- Build order (review n5, adapted): (1) server write-side + types + seeds +
  dashboard type mapping; (2) extract ContactCommsPane with ContactDetail
  behavior-identical (its existing test suite is the net); (3) channel hooks
  -> aggregate unread + markPersonRead + state shape; (4) tour/placement
  consumers + wrapper; (5) the 1:1 injection removal LAST, in its own commit
  (independently revertible).

## Out of scope

- ConversationDetail / relay-group rendering (correct today).
- Inbox surfacing of calls (`inbound-calls-invisible-in-inbox` stays open for
  the inbox; note this spec on it at handback).
- Server-side email threading rules, quiet hours, anything in worker jobs.
- Pagination of the channel hooks beyond inbox page 1 (pre-existing).
- Backfill of historical activity events (no prod history exists;
  dev regenerates on reseed).

## Post-merge obligations

None expected (no deps, no infra, no schema/GSI change - activity events are
schemaless rows in an existing table; new event types only).
