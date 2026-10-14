# Adversarial code review - feat/last-heard-from @8bec5de1 (base 8a56128c)

Reviewer: plan-blind adversarial (diff + repository only; no spec, plan or
review records read). Read-only; no tests or commands run besides git/grep/read.

Scope swept: every app/src file in the diff, plus the consumers and mutators of
the touched state outside it: contactsRepo write paths (update, create,
createIfAbsent, flags, soft delete/restore, phones/emails pointers),
listingSendsRepo.putShareMemory and shareLedger.mayReplace, toursRepo
(create, autoCloseIf, reopenIf, listByUnit/listByTenant), routes/tours.ts
POST, contactTimeline.ts (activity milestones, landlord audit interleave),
units.ts GET /:unitId/activity, contactCapture.ts, inboundEmail.ts tier 5/6
routing, the importer contact upsert, seedAll/seedLive, the dashboard hosts
(useContacts, useContactFile, useListing, Card.tsx SendRosterRow,
FollowUpView, RecipientPreview, ContactsList/tenantFacets,
ContactSearchField, BroadcastsList), and the terraform GSI projection.

Totals: 0 BLOCKING, 0 HIGH, 2 MEDIUM, 4 LOW.

---

## 1. [MEDIUM] Follow-ups: an un-lookback-filtered fan-out on every Properties and Matching mount, and one incomplete batch 503s the whole list

Where:
- app/src/services/followUps.ts:128-139 - for EVERY kept available unit (up
  to 100), `listingSends.listByUnit` (full items, `shares` maps included) and,
  when the unit has any listed row at all, `tours.listByUnit`.
- app/src/services/followUps.ts:144-145 - ONE `getRecipientDisplaysByIds`
  over the contactIds of EVERY listed row of every such unit, with
  `requireComplete: true`.
- app/src/services/followUps.ts:152-170 - the 14-day LOOKBACK (isWaiting,
  lib/listingSendOutcome.ts:120-121) is applied only AFTER all of the above.
- app/src/repos/contactsRepo.ts:995-1020 - the batch is serial 100-key chunks,
  4 attempts each (~175 ms total backoff), then IncompleteBatchReadError.
- Callers: dashboard/src/routes/listings/useFollowUpCounts.ts:14-25 (every
  Properties list mount) and dashboard/src/routes/broadcasts/useFollowUps.ts:63-77
  (every Matching mount, whatever tab is active).

Failure scenario: 30 available properties, each shared via broadcasts over
their listing life (MAX_BROADCAST_RECIPIENTS = 1000, broadcastsRepo.ts:75), say
300 recipients apiece. Every Properties-list visit and every Matching visit
reads ~9,000 listing_sends items, 30 tours queries, and a de-duped contacts
batch of perhaps 1,500-3,000 ids in 15-30 SERIAL BatchGet round trips - even
though only sends from the last 14 days can ever be listed. The cost grows with
the age of the inventory, not with the size of the answer. Because the batch is
`requireComplete`, a single key left unprocessed after the short retry budget
(a throttled burst) turns the whole response into 503 outcome_unavailable: the
Follow up tab shows its error state and the Properties pill silently vanishes.

Fix shape: filter `rows` to `now - sentAt <= FOLLOW_UPS_LOOKBACK_MS` right after
listByUnit (before deciding to query tours and before collecting ids); a unit
with no in-window row then costs one Query and nothing else. Consider a short
server-side cache or a cheaper counts-only path for the Properties pill.

## 2. [MEDIUM] Inbound auto-replies (email out-of-office) move last_heard_from_at: a false "Replied" and a reset quiet window

Where:
- app/src/services/inboundEmail.ts:815-843 - every threaded inbound email whose
  sender is verified (not `email_new_address`) touches the thread contact.
- No auto-reply detection exists anywhere on the inbound email path (no
  Auto-Submitted / X-Autoreply / Precedence handling - grep of
  services/inboundEmail.ts and lib/ finds none).
- The field's own contract says otherwise: app/src/repos/contactsRepo.ts:225-229
  "outbound and automated traffic never moves it".
- Outcome rules that read it: lib/listingSendOutcome.ts:79-81 (`replied` when
  heard > sentAt) and :114-118 (quiet window restarts at the heard instant).

Failure scenario (reachable): staff email a tenant from the contact page
(email channel; the outbound Reply-To is relay+<token>, conversationsRepo.ts
email_reply_token). The tenant has a vacation responder. The auto-reply arrives
FROM the tenant's known address via the token, so tier 5 marks it known
(inboundEmail.ts:887-904) and attributeInbound credits the tenant. Every
property sent to that tenant before that instant now reads "Replied" on the
property "Sent to" card and the contact's Properties sent card, the Follow up
row's quiet clock restarts (the tenant drops off the waiting list for 24 h),
and the Tenants list sorts them to the top as recently heard from - all
without a human ever replying. Staff reading "Replied" will reasonably assume
there is a reply to act on. The backfill (app/scripts/backfill-last-heard-from.ts)
will bake historical auto-replies in the same way.

Fix shape: carry an auto-reply flag on the persisted email row (RFC 3834
`Auto-Submitted` other than `no`, plus the common `X-Autoreply` /
`X-Autorespond` / `Precedence: auto_reply|bulk|junk`) and have attributeInbound
skip it, so the live path, the backfill and the seed agree.

## 3. [LOW] Per-click outcome audit rows crowd the cursorless property Activity card and widen the landlord-timeline paging gap

Where:
- lib/listingOutcomeEvents.ts:42-46 appends one `units#<unitId>` audit row per
  outcome click (decline, clear, interested).
- app/src/routes/units.ts:1822 - GET /:unitId/activity reads the newest
  `limit` (default 50, no cursor - units.ts:375 and the route header).
- app/src/routes/contactTimeline.ts:1435-1447 - the landlord timeline reads the
  newest `limit + 1` rows of each owned unit's audit partition and THEN drops
  everything outside LANDLORD_FEED_TYPES (contactTimeline.ts:331-336).

Failure scenarios: (a) a Follow up session that triages 40 recipients of one
property pushes that property's `broadcast_sent` and `listing_status_changed`
rows out of the 50-row Activity card with no way to page back to them. (b) The
landlord interleave already has a gap shape - feed rows older than the
(limit+1)th audit row but newer than the merged page's last item are read on
neither page (page 2 reads `before` the page cursor) - because the filter runs
after the limit. Tour events already make the partition noisier than the feed;
outcome clicks add more non-feed rows, so the gap is hit more often. Pre-existing
mechanism, amplified here.

## 4. [LOW] 1:1 attribution takes the first participant with any contactId, not the participant for the thread's phone (UNVERIFIED reachability)

Where: app/src/lib/heardFrom.ts:91-92 picks
`participants.find((p) => nonEmpty(p.contactId))`. The capture service that
owns those links deliberately does the opposite: app/src/services/contactCapture.ts:136-143
matches by PHONE and warns that "adopting participants[0] blindly would link
the WRONG contact" for a roster carrying an entry for another phone (the
relay-group seam / bad data it names).

Scenario: a 1:1 thread whose participants array carries an entry for a
different phone ahead of (or instead of) the thread phone's own entry - the
exact state contactCapture refuses to trust - credits that other contact with
every inbound on the thread, and the backfill propagates it. I could not prove
a live writer produces that state today, hence LOW. Matching the 1:1 branch to
`participant_phone` (and the email address for email threads) when present
would keep the two rules from drifting.

## 5. [LOW] Compare-and-clear protects only the server's read-to-write window, not the stale page the click came from

Where: app/src/routes/units.ts:1395-1410 (clear) and :1360-1365 (interested)
compare against `row.declined.at` as read by the ROUTE; the client sends only
`{ outcome }` (dashboard/src/api/endpoints.ts setListingSendOutcome).
dashboard/src/routes/contact/Card.tsx shows Undo on any not_interested row.

Scenario: staff A records Not interested; staff B, on a page loaded earlier,
also records Not interested (overwrites `at` and staffId - setDeclined is
unconditional on the record, listingSendsRepo.ts:368-395). A then clicks Undo
on the row A is looking at; the route reads B's newer decline and clears it.
The protection described in the route header ("a decline another staff member
records meanwhile survives") holds only for a decline landing in the
milliseconds between the route's own read and write. Low impact (both meant
"not interested"), but the guarantee is narrower than stated; sending the
displayed `declined.at` as an expected value would make it real.

## 6. [LOW] Maintainability: the outcome join is assembled four times, plus duplicated constants

- The deriveListingSendOutcome input (tours grouped by tenant, recipient type,
  last heard from, tour signal, tour activity) is built separately in
  routes/units.ts:232-282 (projectRecipientRow), routes/contacts.ts:1241-1276,
  routes/broadcasts.ts:462-489 (effectiveDeclines) and services/followUps.ts:152-163,
  with three copies of the group-tours-by-tenant loop (units.ts:216,
  broadcasts.ts:469-474, followUps.ts:92). They agree today (missing-contact
  rows read no tours everywhere); a fifth surface or a rule change has to find
  all four.
- GROUP_THREAD_TYPES is re-declared in app/scripts/backfill-last-heard-from.ts:53
  instead of imported from lib/heardFrom.ts:44; TEAM_SENDER_KEY is a third local
  literal (lib/heardFrom.ts:46) with no pin test (the importer's copy has one).
  Harmless now ('team' only ever rides outbound rows, which step 1 drops), but
  it is drift waiting to happen.

---

## Checked and clean

- touchLastHeardFrom (contactsRepo.ts:1949-1985): attribute_exists guard stops
  UpdateItem minting a contact; pointer ids refused; normalized ISO makes the
  lexical `<` sound; ConditionalCheckFailed vs other errors split correctly;
  never throws. No contact writer is a whole-item Put of a read copy (update is
  SET/REMOVE; importer upsert is an UpdateCommand), so no writer can clobber or
  roll back the field.
- Instants: every live writer uses the server receipt time (twilio/voice
  providerTs, email receivedAt - not the sender-controlled Date header), and
  redeliveries reuse the persisted key, so a redelivery never moves the value.
- Redelivery / dedupe on every webhook path (1:1, relay, closed-group, native
  group, voice 1:1, masked refused/bridged, email winner-only): persisted row
  decides on a dedupe; best-effort wrappers never 5xx a webhook; PII-safe logs.
- setDeclined / clearDeclined vs putShareMemory: disjoint attributes (only
  `updated_at` shared, and nothing reads it as a token); putShareMemory never
  touches `declined`; byContact GSI projects ALL (infra/modules/dynamodb/main.tf:57)
  so the contact page sees `declined`.
- Outcome route: staff auth (api.ts /units mount), body allowlist, unit-deleted
  and counted-row gates, the tour create path matches POST /api/tours for a
  timeless request (no reminders, no event), tour_type validated at write
  (unitFields.ts:194-207), saved:true semantics consistent; the double-click /
  GSI-lag duplicate tour is the already-accepted I3.
- deriveTourActivityAt: no automated writer stamps lastMarkedAt (autoCloseIf
  conditions on it but never sets it; reopenIf is route-only).
- Unit / contact timeline consumers of the new ActivityEventType values:
  dashboard union updated, Timeline default colour, landlord feed whitelist
  keeps outcome rows off the landlord timeline.
- Server-owned field refusal: dashboard ContactPatch is an explicit interface,
  so no client round-trips last_heard_from_at into a 400.
- Dev seams (/__dev/listing-send-fixture, fixture touches) live in the
  dev router only; create-only; no threshold override.
- Seed derivation returns copies (no shared-literal mutation); seedLive adds no
  inbound messages. Importer stamps after the message flush through the one
  writer. Backfill: dry run default, forward-only conditional writes safe
  against live traffic, pointer partitions skipped, abort-on-failed.
- Tenants facet model, sort and URL state; RecipientPreview default-check and
  Select-all rules (declined rows unchecked unless seeded; send posts the exact
  checked ids); Follow up route ordering above /broadcasts/:broadcastId routes.
