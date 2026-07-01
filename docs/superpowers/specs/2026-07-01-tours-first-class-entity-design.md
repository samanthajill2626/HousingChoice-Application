# Tours — first-class Tour entity (feature design)

**Date:** 2026-07-01
**Status:** Draft for review → then implementation plan
**Related:** `docs/issues/tour-scheduling-off-placement.md`, `documentation/sending-unit-sequence.mermaid` (upstream), Post-Tour & Application (downstream, not yet designed). The Tours **sequence diagram + writeup are DEFERRED** — authored after this feature is built. (An earlier draft was struck as inaccurate: it under-modeled the tenant↔landlord relay-group back-and-forth needed just to *schedule* a tour.)

## Goal

Make **Tours** a first-class entity, fully separate from placements. A tenant can have
many tours; at most one converts into a placement when the tenant confirms they want to
move forward. This replaces today's model, where tours live as a `tours[]` array on a
placement — a remnant of the old "one record from tour-interest onward" consolidation,
which no longer fits now that a placement should represent a **committed deal** created
*after* the tour.

This spec covers the **build** (the Tour entity + its machinery + dashboard surfaces).
The Tours sequence diagram + writeup and the e2e scenario suite are written **after** this
ships, against the real built system (the earlier diagram draft was struck as inaccurate —
the scheduling itself is a real tenant↔landlord relay negotiation that the draft flattened).

## Settled decisions (from founder/product discussion, 2026-07-01)

1. **Tours and placements are separate entities.** Not a stage on a placement.
2. **Many tours → one placement.** A tenant tours several units; at most one converts.
3. **During touring the tenant stays `searching`.** No placement exists yet, so tours do
   NOT drive tenant status. The placement (and the move to `placing`) happens on conversion.
4. **The placement is created post-tour, on the tenant's "yes, move forward."** A tour →
   placement **conversion** creates the placement for the same tenant + unit and links back
   to the originating tour.
5. **Group threads are owner-agnostic.** A masked relay/group thread can belong to a
   **tour**, a **placement**, or **stand alone** (rebindable). A tour *likely* has its own
   group thread; a placement *usually* has one but it is **not a hard gate**. On conversion,
   the winning tour's group thread carries over to the placement.
6. **`placement.tours[]` is legacy** — migrate its concept to the Tour entity and retire it
   (it is currently read by the tenant/landlord "Tours" card via `buildContactFile`, so this
   is a migration + repoint, not a delete).
7. **Auto-reminders are the one `[AUTO]` piece.** The app arms + sends the tour-reminder
   ladder as texts; everything else (scheduling, ID review, coordination, feedback) is
   Team-manual in Phase 1.

## Architecture

### The Tour entity (new)
A tour record, keyed by `tourId`, holding at least:
- `tenantId`, `unitId` (the tenant + property being toured)
- `scheduledAt` (datetime; same-day allowed), `tourType` (self_guided | landlord_led |
  pm_team — derived from the property's `tour_process`)
- `status` (e.g. `scheduled → confirmed → toured | no_show | canceled | converted`) — exact
  enum is an open question below
- `groupThreadId?` (optional link to a relay/group thread)
- `outcome?` / feedback, `convertedPlacementId?` (set on conversion)
- reminder bookkeeping (scheduled reminder handles, for cancel/re-arm on reschedule)
- GSIs: `byTenant`, `byUnit`, and a sparse `byScheduledAt` (the "tours today" view / the
  reminder + no-show clock).

New: `toursRepo`, `/api/tours` routes (create/schedule, get, list by tenant/unit/date,
update status/outcome, reschedule, cancel, convert). Tenant status is untouched (stays
`searching`).

### Relay group / group thread — generalize ownership
Today the masked relay is **pool-number-per-placement**. Generalize so a group thread has
an **optional, rebindable owner** (`tour | placement | none`). Needed for: a tour's group
thread during `searching` (no placement), standalone group threads, and **re-parenting** the
winning tour's thread to the placement on conversion (other tours' threads close). This is
the most delicate change — it touches the existing relay design, not just a new field.

### Exit gate (in scope) vs. tour → placement conversion (DEFERRED downstream)
The tenant's **"yes/no, move forward"** answer is the exit of the tour loop and lives in
THIS feature: capture it, set the tour outcome/status (`toured` + a move-forward flag on
"yes"; closed/declined + re-match on "no"). That convertible state **is the gate** between
this sequence and Post-Tour & Application.

The actual **conversion is NOT built here** — creating the placement (same tenant + unit),
`placement.fromTourId`, moving the tenant `searching → placing`, and re-parenting the tour's
group thread to the placement all belong to the **downstream** Post-Tour & Application
sequence. This feature's only obligation toward it: leave the tour convertible, and make the
group thread **re-parentable** (owner generalization below) so the downstream can carry the
same number/thread over.

### Auto-reminders (the `[AUTO]` build) — durable rows + worker poller
A scheduled-text reminder ladder armed off a tour: booking confirmation → day-before →
morning-of → "text me when you're on the way", plus a no-show check-in when no
on-the-way + no outcome by the window. **Mechanism (decided): durable reminder ROWS in
DynamoDB (one per pending send, each with a `dueAt`), fired by a worker poll tick** — the
same DynamoDB-deadline pattern the architecture doc uses for every business clock (RTA 48h,
voucher expiry, stuck alerts). Durable across an EC2 restart (state is in DynamoDB, never in
process), hermetically testable against DynamoDB Local (no fake-AWS seam needed), and
cancel/re-arm is just writing/deleting rows (no lingering EventBridge schedules). Reschedule
(incl. from `canceled`/`no_show`) rewrites the rows; convert/cancel deletes them. Needs a
reliable worker tick + a DLQ/worker-health alarm. Follow the `missedCallAutoText` job as the
send pattern. (EventBridge Scheduler is the escalation only if second-precision or
fire-while-app-down is ever required — not the case for a single-EC2 tour-reminder use.)

### Dashboard surfaces
- A **Tours** view: a tenant's tours (list + detail), schedule/reschedule/cancel, log
  outcome, the tour's group thread. Repoint the existing tenant/landlord "Tours" card from
  `placement.tours[]` to the Tour entity.
- Tour-type routing is display/coordination only (Phase-1 manual); no lockbox vendor UI.

## What's reused vs. new
- **Reused:** masked relay/group-text feature (generalized for ownership), messaging +
  **inbound MMS** (the ID-gate photo review already works — Team reviews it in the thread),
  contacts/units, the `missedCallAutoText` scheduler pattern.
- **New:** the Tour entity + repo + routes, the reminder scheduler/ladder, the group-thread
  owner generalization, the tour→placement conversion, the Tours dashboard surface, and the
  `placement.tours[]` migration/retirement.

## Non-goals
- No lockbox **vendor** integration (Igloohome dropped — self-guided is a manual ID review +
  Team texts a landlord-provided code).
- No **email** channel (separate; `email-as-first-class-channel`).
- **Post-Tour & Application** (application ladder, RTA) is a separate downstream sequence.
- Matching / property-sending is upstream (Sending Unit), unchanged.
- The e2e scenario suite is a **follow-on** (built against this feature via the playbook).

## Resolved decisions (2026-07-01)
1. **Tour `status`** — `scheduled → confirmed → toured → (feedback) closed`, with
   `canceled`/`no_show` **reschedulable** (return to `scheduled`), and a move-forward flag
   set on a "yes". Not terminal except the closed/declined end.
2. **Group-thread ownership** — one pool number that **rebinds** tour→placement on
   conversion (continuity, fewer numbers). The rebind action itself is downstream.
3. **Reminder scheduler** — durable DynamoDB reminder rows + worker poller (see the
   auto-reminders section). NOT EventBridge for now.
4. **`placement.tours[]`** — no real data exists → clean repoint of the "Tours" card to the
   Tour entity + retire the field. No data migration.
5. **Exit gate vs. conversion** — the "yes/no, move forward" gate is in scope; the
   tour→placement conversion is **deferred** to Post-Tour & Application.

## Out of scope, but documented
- **Group-thread management across multiple concurrent tours.** A tenant may have several
  tours scheduled at once, each potentially with its own group thread / pool number — how
  those are presented, numbered, and reconciled (and which becomes the placement thread on
  conversion) is a **bigger question deferred out of this scope**. Tracked in
  `docs/issues/group-threads-across-multiple-tours.md`. This feature builds owner-agnostic
  group threads (tour | placement | standalone); the multi-tour UX/numbering strategy is not
  decided here.

## Downstream: diagram + tests
After this ships: **author** the Tours sequence diagram + writeup against the real entities
(the earlier draft was struck — it missed the tenant↔landlord relay-group back-and-forth
needed to even schedule a tour), then write `e2e/tests/scenarios/tours.spec.ts` via the
playbook (audit → verbs → green), and update the sending-unit suite's placeholder
`expectHandoffToTours` to assert the real tour handoff.
