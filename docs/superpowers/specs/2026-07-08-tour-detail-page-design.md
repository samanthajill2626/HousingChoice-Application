# Tour detail page redesign

Date: 2026-07-08
Status: Approved design, ready for implementation
Branch: feat/tour-detail-page (worktree w:/tmp/tour-page)
Author: Claude (brainstormed with Cameron)

NOTE ON TEXT: this spec and ALL new code, comments, UI copy, and docs written
for this feature must be plain ASCII (no em dashes, curly quotes, arrows, or
other non-ASCII characters) unless a hard requirement forces otherwise.

## 1. Problem

The Tour detail page (/tours/:tourId, dashboard/src/routes/tours/TourDetail.tsx)
is the only page in the app with no stylesheet at all: raw h1/dl/bare-button
HTML, ten ungrouped buttons, inline forms. It fetches only the tour row, so it
shows ids instead of the tenant, property, landlord, or property manager, and
it has no history of its own lifecycle. Meanwhile the tours sequence diagram
(documentation/tours-sequence.mermaid + writeup) defines a rich VA adjudication
workflow - scheduling coordination inside the masked group thread, a reminder
ladder, a self-guided ID gate, attendance, an exit gate, and conversion - none
of which the page supports as a coherent surface.

## 2. Decisions (Cameron, 2026-07-08)

1. Two-pane page on the shared shell: conversation LEFT, tour file RIGHT.
2. LEFT pane is a THREE-CHANNEL switcher: Group text, Tenant 1:1,
   Landlord 1:1 - all three always present as tabs; never auto-switched.
3. Guided next-step action model: one primary status-aware CTA in the header
   plus a "..." menu for branches; inputs in Modals.
4. Right column order (option A): Schedule, People, Reminders, Guidance,
   Outcome, Activity.
5. Self-guided ID gate: guidance card only (no new backend gate state);
   file a follow-up issue for tracked gate state.
6. REMOVE the "confirmed" tour status entirely (scheduled and confirmed are
   the same step; the booking-time [AUTO] text already says "confirmed").
7. Mobile (M1): the contact-page pattern - a segmented "Details | Conversation"
   toggle at narrow widths with the channel tabs inside Conversation; the
   INITIAL mobile view is DETAILS (unlike the contact page, which leads with
   comms).
8. ASCII-only text rule (see note above).

## 3. Shell and header

Rebuild the page on dashboard/src/ui/twoPaneShell.module.css (the shell shared
by ContactDetail and ConversationDetail). Delete the current unstyled markup
wholesale; add a TourDetail.module.css for page-specific decoration only.

Header band:
- Back crumb to /tours.
- Identity: "Tour - <property address>" (address from the unit; fall back to
  the unitId while loading). Address is the headline because tours are
  property-events; the tenant is in the facts line and People card.
- Tour StatusBadge: add a tour tone map to dashboard/src/ui/StatusBadge.tsx
  (requested = attention/amber, scheduled = active/blue, toured = progress,
  closed = neutral, canceled/no_show = danger/muted). No plain-text statuses.
- Facts line: "<when or 'Not booked'> - <type label> - <tenant name> ->
  <address>" plus "created <date>".
- PRIMARY CTA (status-aware happy path):
    requested  -> "Book tour"       (Modal: datetime; PATCH scheduledAt+status)
    scheduled  -> "Mark toured"     (PATCH status toured)
    toured     -> "Record outcome"  (Modal: exit gate, see 7)
    convertible and not converted -> "Start placement" (POST from-tour, then
                                     navigate to the new placement)
    converted  -> "View placement" (link button to /placements/:id)
    closed/canceled/no_show -> no primary CTA (menu only)
- "..." menu (kebab, Button primitive + the existing menu pattern):
  Reschedule (statuses per canReschedule), Cancel, Mark no-show
  (scheduled only), Open group text (when no group and tour not dead).
  Menu items open Modals where input is needed; all mutations use the
  existing PATCH /api/tours/:id and POST /api/tours/:id/relay endpoints.
- Actions wrap to their own row at narrow widths (shell behavior).

## 4. LEFT pane: three-channel conversation switcher

A tab rail at the top of the conversation pane with exactly three channels:

  [ Group text ] [ Tenant - <first name> ] [ Landlord - <first name> ]

(The third tab label uses "PM" / the property-manager display label when
tourType = pm_team; Phase 1 models the PM as the unit's landlord-slot contact,
so it is the same person record either way.)

Behaviors:
- All three tabs always render. NEVER auto-switch after initial load.
- Initial tab: Group when tour.groupThreadId exists, else Tenant. On mobile
  the page opens on the Details panel regardless (see 9).
- Unread dot per tab: dot shown when that channel's conversation has
  unread_count > 0. Viewing a tab marks it read via the existing
  POST /api/conversations/:id/read (we know each conversationId; do NOT use
  the inbox per-contact fan-out read, which would clear other conversations).
- Transcript: reuse the Timeline component for all three channels (it already
  renders milestone pins, delivery/opt-out annotations, and media). Group tab
  = the relay transcript with delivered N/M (same as ConversationDetail's
  pane); 1:1 tabs = the contact conversation scoped to that single
  conversation.
- Composer targets the ACTIVE tab: group tab posts a team reply (existing
  relay fan-out via POST /api/conversations/:id/messages); 1:1 tabs send an
  ordinary message to that conversation. Optimistic send per Timeline's
  add/resolve/fail pattern.
- Empty states render IN PLACE (no dead tabs):
    Group, none exists: "No group text yet" + an [Open group text] Button
      (POST /api/tours/:tourId/relay; also present in the kebab). If the tour
      is canceled/closed the button is disabled with a short note.
    Tenant/Landlord 1:1, no conversation yet: "No messages with <name> yet"
      + a live composer; create-on-demand via the existing
      POST /api/contacts/:contactId/conversation (ensureContactConversation),
      then send.
- Group tab when the group is closed: transcript read-only note (composer
  disabled), matching ConversationDetail's closed behavior.
- Lazy-load: fetch the active tab's messages on first view (do not fetch all
  three transcripts up front); unread state comes from the conversation rows,
  which are cheap.

Data plumbing: a useTourChannels(tour) hook resolves the three conversation
ids (group = tour.groupThreadId; tenant/landlord = each contact's primary
conversation, resolved via the existing contact-conversation lookup) and each
channel's unread count; SSE (conversation.updated / message events) keeps
unread dots and the open transcript live, same mechanisms the contact page
and ConversationDetail already use.

## 5. RIGHT column: the tour file (order A)

All cards use the Card/KV/Row/EmptyRow primitives from
dashboard/src/routes/contact/Card.tsx.

1. Schedule
   - When: formatted scheduledAt or "Not booked".
   - Type: label (Self-guided / Landlord-led / PM team) + a routing chip
     showing where reminders go ("reminders -> group" or
     "reminders -> tenant 1:1"). If a landlord-led/pm tour has NO usable
     group, show the fallback warning chip "no group - reminders -> 1:1"
     (this is a coordination smell the VA should see).
   - Card action: Reschedule (same Modal as the kebab item).
2. People
   - Tenant: name link to /contacts/:id + chips (contact status label,
     voucher size if present).
   - Landlord (or "Property manager" label when pm_team): name link + phone.
   - Property: address link to /listings/:unitId + chips (beds, rent).
   - Source: unit.landlordId -> contact; roster role labels from the unit
     where applicable. Missing data degrades to EmptyRow, never blank.
3. Reminders
   - The existing RemindersPanel content restyled INTO a Card (keep its
     rung/next/suppression logic and tests; adjust wrapper classes only).
4. Guidance (type-aware)
   - Self-guided: title "Self-guided tour"; first line, bolded:
     "Photo ID before lockbox code - always." Then the unit's tour_process
     and application_process free text (KV rows). This is procedural
     guidance only; no new backend state.
   - Landlord-led / PM team: title "Landlord-led tour" / "PM-team tour";
     the unit's tour_process + application_process text.
5. Outcome
   - Before the exit gate: PendingPanel text "Records after the tour:
     moving forward starts a placement; not a fit closes the tour."
   - After: KV rows for Outcome (label), Moving forward (yes/no), and either
     the [Start placement] Button (convertible, not yet converted) or a
     Row linking to the converted placement.
6. Activity
   - The tour's OWN lifecycle history, newest-first, mirroring the placement
     HistoryPanel pattern (load-more). Rows: created/booked/rescheduled/
     toured/no-show/canceled/outcome/group-opened/converted, each with
     actor and timestamp where known. Source: new endpoint (see 7).

## 6. Status model change: remove "confirmed"

- Enum becomes: requested, scheduled, toured, no_show, canceled, closed.
- app/src/lib/toursModel.ts: drop from TOUR_STATUSES, TOUR_STATUS_LABELS,
  RESCHEDULABLE; adjust the lifecycle comment.
- app/src/routes/tours.ts transition guards: remove confirmed branches;
  scheduled -> toured|no_show|canceled|scheduled(reschedule) directly.
  PATCHing status "confirmed" returns the existing 409 invalid-transition
  error shape.
- Today board (app/src/routes/today.ts + buildToday): tours_today filter
  becomes status = scheduled only.
- Dashboard mirrors: types.ts TourStatus, TOUR_STATUS_LABELS, the new badge
  tone map, ToursPage groupings, ScheduleTourForm if it references confirmed.
- Seeds: remove/replace every confirmed-status tour (matrix enum-loops all
  statuses; also check cast/live/history). Seed counts change; keep lean
  byte-stable EXCEPT where it contains a confirmed tour (if lean has none,
  it stays byte-identical - verify).
- e2e: scenario specs and steps.ts verbs that drive or assert confirmed;
  dashboard-next specs (tours-page, today, listing-activity) as needed.
- documentation/tours-sequence.mermaid + tours-sequence-writeup.md: update the
  lifecycle to match (this is a deliberate doc edit, not drift; note the
  2026-07-08 decision inline).
- No data migration: no prod tours exist (prod rides M1.11); dev reseeds.
- Resolve docs/issues/tour-reschedule-of-confirmed-not-surfaced.md as
  obsolete (the status is gone) with a dated resolution note.

## 7. Backend slices

1. Tour-keyed activity (resolves
   docs/issues/tour-activity-no-tour-page-surface.md):
   - recordTourEvent (app/src/routes/tours.ts) additionally appends the same
     event to audit entityKey "tours#<tourId>" (third write alongside the
     tenant activity event and the units#<unitId> audit row; keep all
     best-effort).
   - Also record milestones for group-opened (POST /:tourId/relay success)
     and converted (in the from-tour flow) so the Activity card tells the
     whole story.
   - New GET /api/tours/:tourId/activity -> { events: [...] } via
     auditRepo.listByEntity("tours#" + tourId), shaped like
     GET /api/units/:id/activity (cursor/limit paging included).
   - Backfill: none (forward-only, same policy as the unit activity card).
2. The exit gate stays as-is (PATCH with outcome/moveForward; 409 unless
   status = toured). The Record-outcome Modal drives it: radio move-forward /
   not-a-fit; not-a-fit also sets status closed (existing behavior).
3. No other backend changes. No schema/table/GSI changes (audit table
   already keys by entityKey). No terraform.

## 8. Data fetching

A useTour(tourId) bundle hook (pattern: listing's useListing + Slice):
- Required: GET /api/tours/:tourId (404 -> not-found panel).
- Parallel best-effort slices: unit (GET /api/units/:unitId), tenant contact,
  landlord contact (from unit.landlordId), activity
  (GET /api/tours/:id/activity), reminders (existing hook), channel
  conversation rows (see 4). Each slice degrades independently
  (loading/pending/ready/error), page never hard-fails on a join.
- SSE: refetch tour + activity on relevant events (the existing events bus);
  transcripts/dots live-update per 4.

## 9. Mobile (<= 860px)

- The shared shell's segmented toggle, relabeled "Details | Conversation",
  with DETAILS as the initial pane on narrow widths (per Cameron; the shell
  currently defaults to the left pane, so the tour page passes its own
  initial-pane choice - keep ContactDetail's behavior unchanged).
- Channel tabs live inside the Conversation pane, full width.
- Header condenses per the shell (facts wrap, actions drop to their own row);
  the primary CTA must remain visible without horizontal scroll on a 360px
  viewport.
- Panes scroll independently; composer reachable (min-height:0 behavior comes
  with the shell).

## 10. Issues to file / resolve in this branch

File:
- tour-id-gate-tracked-state (improvement, low): tracked id_verified_at /
  code_sent_at fields + checklist UI for the self-guided gate; deferred by
  the 2026-07-08 guidance-card-only decision.
Resolve (with dated notes):
- tour-activity-no-tour-page-surface (fixed by 7.1).
- tour-reschedule-of-confirmed-not-surfaced (obsolete via 6).
Check-and-update if their described behavior changed:
- today-next-tour-reminder-from-ladder, tours-list-unresolved-name-address,
  tours-dialog-unit-label-glossary (leave open unless this work happens to
  resolve them; do not scope-creep into them).

## 11. Testing

- Unit (dashboard): header CTA ladder per status; kebab guards; channel-tab
  switching, unread dots, composer targeting, empty states (open-group,
  create-on-demand 1:1); right-column cards incl. reminder routing chip +
  fallback warning; mobile initial pane = Details; StatusBadge tour tones.
- Unit (app): tours#<id> audit writes for every recordTourEvent call site +
  group-opened + converted; GET /api/tours/:id/activity shape/paging;
  transition guards without confirmed (409 on PATCH confirmed).
- e2e (extend e2e/tests/scenarios/tours.spec.ts + a dashboard-next spec):
  walk the sequence-diagram arc THROUGH THE PAGE - create requested, Book via
  CTA modal, group tab shows the thread + send fans out (assert outbox),
  tenant tab shows 1:1, Mark toured, Record outcome (both branches), Start
  placement navigates and the tour shows the placement link; self-guided tour
  defaults to Tenant tab and shows the ID-gate guidance card; Activity card
  lists the walked history. Update scenario specs for the removed confirmed
  status. Accessibility-first selectors throughout.
- Self-QA with the Playwright harness (e2e:session + MCP) before handoff,
  including a 360px-wide mobile pass.

## 12. Risks

- Removing "confirmed" fans out (seeds, e2e verbs, Today, docs); the guard
  is the typecheck + full suites, and the no-prod-data window makes it safe
  NOW in a way it will not be after M1.11.
- Three transcripts on one page: lazy-load inactive tabs; do not triple-fetch
  on mount.
- Unread-dot correctness: mark-read must target the single conversation
  (POST /api/conversations/:id/read), never the contact-wide fan-out.
- Shell reuse must not regress ContactDetail/ConversationDetail (shared
  module changes are additive only; the initial-pane choice is a per-page
  prop, defaulting to existing behavior).
- The relay-group machinery (open group, closed-group composer, delivered
  N/M) is freshly merged; reuse its components rather than re-implementing.
