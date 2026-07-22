# Manual "Send no-show check-in" (de-automate the no-show reschedule text)

Date: 2026-07-21
Status: design approved, pending spec review

## Problem

The tour reminder ladder auto-sends a `no_show_checkin` SMS to the tenant at
`scheduledAt + 30min`: "Hi! We noticed you may have missed your tour. Want to
reschedule?" ([app/src/jobs/tourReminders.ts:57-76](../../../app/src/jobs/tourReminders.ts#L57-L76),
armed via `REMINDER_KINDS` at [tourReminders.ts:78-84](../../../app/src/jobs/tourReminders.ts#L78-L84),
dispatched by the 60s worker poll).

Unlike every other rung (confirmation, day_before, morning_of, en_route), which
fire on time facts the system knows for certain, `no_show_checkin` is a
*conclusion the system cannot verify*. It is inferred purely from "tour start
time + 30min elapsed," which is wrong in the common cases:

- the tenant is simply running late and still shows up;
- the tour happened but staff have not tapped "Toured" yet (the rung only
  auto-cancels if status flips to toured/canceled/closed in time -- a race
  against a busy human);
- staff are on-site handling it and an automated "did you miss it?" undercuts
  them.

Auto-sending 30 minutes out risks telling a tenant they missed a tour they did
not miss -- a trust-eroding false accusation. Whether a no-show happened is a
human judgment call, so the message should not be automated.

## Decision

De-automate this one rung. Stop auto-arming `no_show_checkin`. Give staff a
manual "Send no-show check-in" action that opens the tenant's 1:1 composer
pre-filled with the (editable) template, so a human decides a genuine no-show
happened, reviews/edits the copy, and sends. Nothing else in the ladder changes.

This is a "for now" scope: the lightest change that puts a human in the loop.
A tracked held-rung workflow ("Send now" button inside the Reminders card with a
new `awaiting_manual` state) was considered and deferred -- it is more machinery
(new reminder state + repo op + route + UI) than the concern warrants right now.

## Scope / non-goals

- No new reminder state machine. Rung states stay `upcoming | sent | canceled |
  skipped`.
- No proactive cancellation of already-armed `no_show_checkin` rows. Prod SMS is
  gated off (`SMS_SENDING_ENABLED` false until A2P) and dev reseeds clear the
  table, so there is no live rung to worry about. (If we later decide to sweep
  them, add a one-time cancel -- out of scope here.)
- No change to the other four rungs.

## Design

### 1. Backend -- stop auto-arming

Remove `'no_show_checkin'` from the `REMINDER_KINDS` auto-arm list
([tourReminders.ts:78-84](../../../app/src/jobs/tourReminders.ts#L78-L84)). That
list is the only thing that arms rungs. Everything else about the kind stays
valid and is deliberately kept:

- the `ReminderKind` union ([app/src/repos/tourRemindersRepo.ts:29-34](../../../app/src/repos/tourRemindersRepo.ts#L29-L34)),
- the `computeDueAt` case for `no_show_checkin` (keeps the switch exhaustive),
- the catalog entry `tour.no_show_checkin` ([app/src/messages/catalog.ts:127-134](../../../app/src/messages/catalog.ts#L127-L134)),
- the dashboard `ReminderKind` / `REMINDER_KIND_LABELS`.

So the kind remains fully usable for a manual send; it just never arms itself.

Tests to flip (they currently assert it IS armed):

- [app/test/tourReminders.test.ts](../../../app/test/tourReminders.test.ts) --
  lines ~143-144, 372-374, 446-447 (incl. `expect(kinds).toContain('no_show_checkin')`
  and the "all 5 kinds armed" comment): change to 4 kinds armed / does NOT
  contain `no_show_checkin`.
- [app/test/toursApi.test.ts](../../../app/test/toursApi.test.ts) -- lines
  ~1163-1164, 1195-1196, 1275-1276, 1975 (`byKind['no_show_checkin']?.dueAt`
  after arm/book/reschedule): assert it is absent.

### 2. Backend -- expose the copy

The templated body is only reachable client-side via an *armed* rung today
(the reminders route resolves `body: resolveMessage(`tour.${row.kind}`)` per
row, [app/src/routes/tourReminders.ts:200](../../../app/src/routes/tourReminders.ts#L200)).
We are de-arming it, so there is no row to read from.

Add a tiny allowlisted read endpoint that returns
`resolveMessage('tour.no_show_checkin')` (only that id permitted). Reusing
`resolveMessage` means the prefill respects the `editable: true` copy if it is
ever overridden, rather than hardcoding a string that silently drifts. One-line
handler. The copy has `vars: []`, so no interpolation is needed.

### 3. Frontend -- the action + prefill

Composer prefill plumbing:

- The tour page's composer is the shared `Timeline`
  ([dashboard/src/routes/contact/Timeline.tsx](../../../dashboard/src/routes/contact/Timeline.tsx)),
  mounted via `TourConversation`'s Tenant 1:1 channel
  ([dashboard/src/routes/tours/TourConversation.tsx](../../../dashboard/src/routes/tours/TourConversation.tsx)).
  It owns its draft as local state (`const [draft, setDraft] = useState('')`,
  Timeline.tsx:791) and has no prefill prop today.
- Add a new `initialDraft` prop threaded `TourConversation ->
  ContactThread / NewContactThread -> Timeline`, seeding `draft`. Respect the
  existing keyed-remount discipline (`resetScrollKey`) so a seeded draft can
  never leak across conversations -- seed only for the intended tenant channel.

The action (kebab, but decoupled so it can move):

- "Send no-show check-in" is added to the tour header kebab
  ([dashboard/src/routes/tours/TourActionsMenu.tsx](../../../dashboard/src/routes/tours/TourActionsMenu.tsx)),
  as a sibling of "Mark no-show" -- the natural home now that the rung is gone
  from the Reminders card.
- IMPORTANT (movability): the click behavior is owned by `TourDetail` and passed
  into the kebab as an `onSendNoShowCheckin` callback -- the kebab only renders a
  menu item that calls it. Relocating the trigger later (e.g. to a standalone
  button) is just re-mounting the trigger; no behavior is rewired.
- The handler: (1) switch `TourConversation` to the Tenant 1:1 tab, (2) fetch +
  seed the templated body into the composer via `initialDraft`, (3) focus the
  composer. On mobile it also flips the segmented Details|Conversation toggle to
  Conversation so the seeded composer is on screen (the shell already has the
  860px breakpoint + toggle at [twoPaneShell.module.css:126-169](../../../dashboard/src/ui/twoPaneShell.module.css#L126-L169);
  we just drive the existing `'details' | 'conversation'` state).

Gating: the action is visible once the tour's start time has passed --
`status === 'scheduled'` and now past `scheduledAt`, or `status === 'no_show'`.
Hidden for canceled / toured / closed.

Responsiveness: verified the tour detail shell is already responsive (header
wraps, actions become a full-width row, body switches row->column with one pane
visible at <=860px). The only responsive work is driving the pane toggle to
Conversation when the action fires on narrow widths.

## Testing

- Unit: the flipped arm assertions (section 1) + the new copy endpoint
  (returns the resolved body; rejects other ids).
- Component: `TourConversation` / `Timeline` seed the composer from
  `initialDraft` and clear correctly on channel switch (no cross-conversation
  leak).
- E2E (accessibility-first selectors): land a tour past its start time, open the
  kebab, click "Send no-show check-in", assert the Tenant 1:1 composer is seeded
  with the template copy, send it, assert `GET /__dev/outbox` shows exactly that
  message -- AND assert the worker poll did NOT auto-send a no_show_checkin
  (nothing in the outbox until the manual send).

## Open items / follow-ups

- If we later want the no-show check-in tracked in the Reminders ladder rather
  than sent ad hoc, that is the deferred held-rung / "Send now" workflow.
- Decide (later, not now) whether to sweep pre-existing armed `no_show_checkin`
  rows in any environment where SMS is enabled.
