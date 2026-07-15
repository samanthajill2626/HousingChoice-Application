# Placement Detail Hub - Design

- Date: 2026-07-15
- Status: DESIGN APPROVED (Cameron, 2026-07-15) - not yet implemented
- Owner surface: dashboard `/placements/:placementId` + app placements API

## Goal

Remake the placement detail page the way the tour detail page was remade:
from an info-only, single-column page into a two-pane info + communications
hub where everything you need to do with respect to a placement can be done
in one place.

## Locked decisions (validated with mockups 2026-07-15)

1. Left pane carries the FULL 3-channel switcher (Group text / Tenant 1:1 /
   Landlord 1:1), mirroring the tour page.
2. Right pane uses the WORKFLOW-FIRST card order: Now card, Deadlines and
   nudges, People and provenance, Placement facts, History.
3. Header primary CTA is "Advance to <next stage>"; the any-stage "Move
   to..." menu, Mark lost, Open group text, and Set follow-up live in the
   header kebab.
4. Placement nudges get a visible panel WITH per-nudge Cancel/Restore.
5. Date vocabulary: a date never stands alone; it always rides a verb
   phrase (see Date vocabulary below).
6. Mobile parity is a requirement, not a nice-to-have (see Mobile and
   responsive requirements below).
7. Build on what exists: the shared twoPaneShell, the tour page's tab-rail
   pattern, Timeline, Card primitives, and the existing gated transition
   pipeline are the standard. No re-invented shells, tabs, or transcripts.

## 1. Page shape and header

- Adopt the shared `dashboard/src/ui/twoPaneShell.module.css`: comms left
  (flex 1.4), placement file right (flex 1), dark header band, and the
  mobile segmented toggle. Mobile default pane: Details (matches the tour
  page).
- Header content:
  - Back crumb to /placements.
  - Title: "Placement - <tenant name> -> <property address>" plus the
    stage pill.
  - Facts line using the date vocabulary, e.g. "Inspection phase - in
    stage since Jul 12 (3 days) - voucher expires Aug 2 (18 days) -
    converted from tour toured Jul 8".
  - Actions: primary button "Advance to <next stage>" driving the
    existing gated transition pipeline (gateFor modals - lost reason,
    final rent, inspection outcome/date, rent determined, move-in ready -
    still apply). Kebab menu: Move to... (the existing gated StatusMenu,
    unchanged), Mark lost, Open group text (hidden when a group exists),
    Set follow-up.
- "Advance" targets the next rung of the PLACEMENT_STAGES ladder. Terminal
  stages (moved_in, lost) show no Advance button.

## 2. Left pane - communications hub

New `PlacementConversation` + `usePlacementChannels`, structural mirrors of
`TourConversation` + `useTourChannels`:

- Channels: group = `placement.group_thread`; tenant 1:1 via
  `placement.tenantId`; landlord 1:1 via `unit.landlordId` (same person
  the nudge router resolves).
- Tab rail reuses the tour page's pill styling and label format ("Group
  text", "Tenant - <first>", "Landlord - <first>"), unread dots, per-tab
  mark-read of the single viewed conversation, lazy one-transcript-at-a-
  time mounting, remount-on-switch so drafts never leak across parties.
- Group empty state: "No group text yet" + an Open group text button wired
  to the existing `POST /api/placements/:id/relay` (endpoint exists today
  with no UI). On success, inject the new conversation id so the thread
  mounts immediately (setConversationId pattern).
- Consent gate: 1:1 sends refused server-side with 409 contact_no_consent
  reuse the ConsentCaptureModal hold-and-retry flow from the tour page.
- Scheduled-send visibility: placement nudges route to 1:1s (never the
  masked group - founder decision 2026-07-02), so the pinned Upcoming
  buckets on the tenant/landlord 1:1 transcripts already show them. The
  group tab's Upcoming bucket is legitimately empty for placements; no
  change to GET /conversations/:id/scheduled.

## 3. Right pane - the placement file (workflow-first order)

### 3.1 Now card (new)

Driven by a static per-stage descriptor map (one file, one entry for each
of the 18 stages; a unit test asserts completeness). Anatomy:

1. Stage + phase, always present.
2. Gate line: amber "Waiting on: <who/what>" when someone else holds the
   ball; blue "Our move: <task>" when we do. Includes the relevant date
   under the vocabulary ("scheduled for ...", "waiting since ...", or
   "no date recorded" when an expected date is missing).
3. Safety-net line, only when the system is chasing: armed nudge ("nudge
   sends Thu 6:15am (in 12h)") and/or RTA window ("closes in 21h").
4. Record: the stage-scoped fields, absorbing today's StageDataCard
   (inspection date, inspection outcome, rent determined, accepted rent)
   and PaperworkCard (lease signed / move-in details / LIF when
   lifEligible). Reads "Record: nothing at this stage" when empty so
   silence is deliberate.
5. Advance button, same action as the header CTA.

### 3.2 Deadlines and nudges card (new)

- Deadlines: voucher expiration, RTA window (system-managed, read-only),
  and the manual follow-up with Set / clear controls wired to the existing
  `POST /api/placements/:id/deadline` (endpoint exists today with no UI).
- Nudges: the armed nudge (and recent sent/canceled rows) with per-nudge
  Cancel / Restore mirroring the tour Reminders panel (busy single-flight,
  409 = refetch honest state). UI copy must state the re-arm semantic: a
  stage move cancels-then-arms that stage's nudge, so a cancel holds only
  within the current stage.

### 3.3 People and provenance

Tenant, Landlord, Property links (Card/KV/Chips primitives) plus the
source tour: "converted from tour toured Jul 8 ->" linking /tours/:id via
`placement.fromTourId` (line absent when there is no source tour).

### 3.4 Placement facts

The remaining read-only fields from today's Placement card (stage dates,
determined/final rent, tag, lost reason, notes), reworded under the date
vocabulary.

### 3.5 History

The existing HistoryPanel (placements# audit trail, load more), unchanged.

## 4. Backend additions

The ONLY new API surface is nudge visibility/control:

- `GET /api/placements/:placementId/nudges` - the placement's nudge rows
  (armed + recent sent/canceled), newest-first.
- `PATCH /api/placements/:placementId/nudges/:nudgeId {canceled: boolean}`
  - atomic cancel/uncancel mirroring tourRemindersRepo cancel/uncancel
  exactly: conditional writes racing the send poll resolve to exactly one
  outcome; lost race returns 409 with the honestly re-read row; success
  emits `scheduled.updated` keyed on the recipient contact.
- Everything else already exists; the dashboard gains bindings for relay
  provisioning, deadline set/clear, and the two nudge endpoints.

## 5. Live updates

- `placement.updated` refetches the placement bundle + history (already
  wired on the current page; keep).
- Transcripts ride `useRelayThread`'s existing message.persisted /
  conversation.updated / scheduled.updated handling.
- The Deadlines and nudges card listens to `scheduled.updated` AND runs a
  dueAt-anchored self-refetch timer (nextReminderRefetchDelay pattern from
  RemindersPanel), because nudge sends happen in the worker process whose
  events never reach app SSE clients.

## 6. Date vocabulary (page-wide)

A date never stands alone. One verb phrase per date kind; near-future adds
relative time in parens; elapsed says "since".

| Date kind          | Verb phrase              | Example                                    |
|--------------------|--------------------------|--------------------------------------------|
| Future appointment | scheduled for X (in N)   | inspection scheduled for Thu Jul 17 (in 2d) |
| Deadline           | expires / closes X (in N)| voucher expires Aug 2 (18 days)            |
| Automated send     | sends X (in N)           | nudge sends Thu 6:15am (in 12h)            |
| Elapsed / stuck    | since X (N ago)          | in stage since Jul 12 (3 days)             |
| Past milestone     | past-tense verb + X      | toured Jul 8; moved in Aug 1               |
| Overdue            | was due X (N overdue)    | follow-up was due Mon (2 days overdue)     |

Reuse the existing formatters (placementsFormat deadline/overdue helpers,
the shared sendRelative "sends in N" wording) rather than new ones; extend
them where a verb phrase is missing.

## 7. Mobile and responsive requirements (explicit)

All NEW pieces must be mobile-friendly and responsive, verified at both
desktop and narrow widths (the twoPaneShell 860px breakpoint) before the
work is called done:

- The segmented Details/Conversation toggle governs the panes on mobile;
  Details is the default pane.
- The header must tolerate the LONGER stage verbiage this design adds:
  the title row, stage pill, facts line, and Advance CTA wrap gracefully
  at narrow widths - no clipped stage names, no horizontal scroll. Stage
  labels ("Awaiting landlord submission") and the Advance button's
  "Advance to <next stage>" text must wrap or truncate deliberately,
  never overflow.
- The Now card's gate line, safety-net line, and Record fields wrap
  cleanly; the channel pill rail scrolls horizontally if it cannot fit.
- Live QA includes a narrow-viewport pass (playwright MCP browser_resize)
  on the header, Now card, and comms pane, at minimum at a phone width.

## 8. Testing

- App: route tests for the two nudge endpoints (cancel, restore, 409 lost
  race, 404s); descriptor-map completeness test (every PLACEMENT_STAGES
  entry present); nudge repo cancel/uncancel conditional tests.
- Dashboard: Now card in its three shapes (waiting / our-move / recording,
  plus empty-Record wording); Deadlines and nudges card cancel/restore and
  follow-up set/clear; usePlacementChannels resolution; header CTA state
  (next-stage label, hidden at terminals).
- E2e: extend the placements scenario - open the group text from the empty
  state, advance a stage via the CTA (gate modal path), see the armed
  nudge in the Deadlines card and in the tenant 1:1 Upcoming bucket,
  cancel and restore it.
- Full gates (typecheck + unit + e2e, run bare from the worktree root) and
  live QA on a hermetic lane, including the narrow-viewport pass.

## Out of scope (explicitly not in this build)

- Canceling nudges from the 1:1 timeline Upcoming cards (management lives
  in the Deadlines and nudges card).
- Any change to nudge ROUTING (1:1-only stays; founder decision).
- Multi-tour history on a placement (only fromTourId provenance).
- Client-side trim-on-blur cosmetics (declined 2026-07-14).
- Changes to the placements LIST page.
