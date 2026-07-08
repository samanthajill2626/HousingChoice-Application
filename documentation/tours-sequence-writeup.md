# Tours Sequence — Overview (Phase 1)

Companion notes for `tours-sequence.mermaid`. This explains how a tenant who has
said "yes, I want to see that one" gets from an interested nod to a decision we
can act on. It covers Phase 1 only: the app automates the deterministic,
repeatable pieces (the reminder ladder), while the team handles the actual
communication.

This diagram was authored **after** the Tours feature was built, against the real
entities and a fresh re-read of the source documents (Process Flow Track 4/5,
Product Framework F4.x/F5.x, the Architecture & Build Plan's Figure 3 tour
sequence). Two earlier drafts were struck for the same root mistake: they
under-modeled the tenant↔landlord negotiation that *is* scheduling. The flow
below is the founder-confirmed current workflow — see "How this evolves the
source documents" for where it deliberately departs from the older docs.

## How to read the diagram

The diagram has four participants:

- **Tenant** — the prospect, still `searching`.
- **Housing Choice App** — owns the phone number and sits in the middle of every
  exchange.
- **Team** — the housing coordinators.
- **Landlord/PM** — the property owner or their property-management team.

The key design rule is the same as the other sequences: **the app owns the phone
number, so every message flows Tenant → App → Team and Landlord → App → Team and
back.** No one contacts anyone directly. The twist here is the **masked relay
group**: a pool number that connects the tenant, the landlord/PM, and the team on
one relayed thread, so the two sides can talk without ever seeing each other's
real numbers.

Notes on the app carry one of two tags:

- **[AUTO]** — the app does this automatically (the reminder ladder, the group
  intro messages).
- **[MANUAL]** — a person on the team does this by hand today (creating the tour,
  opening the group, booking the time, reviewing an ID, logging the outcome).
  These are the natural candidates for automation later.

## Where this sits in the bigger picture

- **Upstream:** the **Sending Unit** sequence ends when the tenant says YES to
  touring a *specific* unit. That is where this picks up.
- **This sequence is about tours only.** Tours are a **first-class entity, fully
  separate from placements**. A tenant can have many tours; **at most one** will
  later convert into a placement. During touring the tenant **stays `searching`** —
  no placement exists yet, and tours do not drive tenant status.
- **Downstream:** the exit gate ("yes, move forward") marks a tour **convertible**
  and hands off to **Post-Tour & Application**, where the placement is actually
  created. That conversion is deliberately **not** part of this sequence.

## The flow, stage by stage

### 1. Tour interest → create the tour record (no time yet)

The tenant says, in the 1:1 thread, that they want to tour a specific unit. The
team **creates the tour record right then — tenant + unit, with no tour time
yet**. The record is the anchor everything else hangs off: the group thread is
owned by it, the eventual booking sets its time, reminders arm off it, and the
outcome lands on it.

The unit's `tour_process` (`self_guided` / `landlord_led` / `pm_team`, captured at
landlord onboarding, never standardized across properties) is already known, and
it decides how scheduling works. One rule cuts across all types: **masked group
threads are always set up by the team by hand — never auto-created in Phase 1.**

(Other arrangements exist in the real world — e.g. a Housing Choice team member
showing a unit — but Phase 1 models only these three.)

### 2. Scheduling coordination, by tour type

**Landlord-led / PM-team — a person shows the unit.** A mutual meeting time has to
be agreed, and that negotiation happens **inside the masked group thread**, so the
group comes before any time is set. The team opens the masked relay group **on the
tour** (Tenant + Landlord + Team, or Tenant + PM + Team); the app sends `[AUTO]`
intro messages naming everyone connected. The tenant and the landlord/PM then
propose and counter times in that thread, each message relayed (masked) through
the app. It is **not** the team pinging each side separately and uniting them —
that older description is struck. PM-team is the same shape with the PM in the
landlord's place; the slot may also live in the PM's own scheduling system.

**Self-guided — lockbox.** There is **no mutual meeting time**, so there is usually
**no group thread** (the admin may hand-create one if coordination calls for it).
The team offers tour windows in the tenant's 1:1 thread and the tenant picks one.
The landlord provides the lockbox code to the team ahead of time.

### 3. Booking — set the time, arm the ladder

Once a time is agreed, the team **sets the date/time on the tour record**. That is
the booking (same-day is fine), and it is the moment automation kicks in: the
booking-confirmation text goes out and the reminder ladder arms off the booked
time. Booking stamps the tour `scheduled` - that IS the confirmed state.

> 2026-07-08: the `confirmed` tour status was removed - `scheduled` covers it
> (scheduled and confirmed were the same step; the booking-time [AUTO] text
> already says "confirmed"). The `confirmation` reminder RUNG below is a
> message, not a status, and stays. Where the architecture doc's Figure 3 says
> the tour is stamped "confirmed" once the slot is coordinated, the built
> status for that moment is `scheduled`.

**Reminder routing (founder decision, 2026-07-02):** reminders go to the **group
thread** for landlord-led and PM tours — the landlord/PM should see them too — and
to the tenant's **1:1 thread** for self-guided tours.

| Rung | When it fires | Purpose |
|------|---------------|---------|
| `confirmation` | immediately, at booking | "Your tour is confirmed." |
| `day_before` | 24h before | day-before reminder |
| `morning_of` | 08:00 UTC on the tour day | morning-of reminder |
| `en_route` | 2h before | asks the tenant to text when on the way |
| `no_show_checkin` | 30m **after** the scheduled time | check-in if they may have missed it |

The ladder is **durable** (reminder rows in the database, fired by a worker poll —
not in-process timers), so it survives restarts. Rescheduling **cancels and
re-arms** the ladder; canceling or closing the tour **cancels** it. Rungs whose
time is already past when armed are skipped (except `confirmation`, which is
always "now").

### 4. Tour day

- **Self-guided only — the ID gate, before access.** Ahead of the tour window the
  team asks for a photo ID; the tenant sends it as a picture message (MMS); the
  team reviews it. **No ID, no code — ever.** Only then is the lockbox code sent,
  in real time. (No lockbox-vendor integration; a manual review plus a team-sent
  code.)
- **On the way.** The en-route nudge invites the tenant to text when heading out.
  For landlord-led/PM tours that lands in the group thread, so the landlord/PM
  gets the en-route heads-up (Figure 3's step 11) without a separate step.
- The tenant tours the unit; the team **logs the outcome** (`toured`).
- **No-show:** if the tenant never shows, the `[AUTO]` no-show check-in asks
  whether they want to reschedule. The team either **reschedules** (cancels and
  re-arms the ladder) or logs a **no-show**. Both `canceled` and `no_show` tours
  remain reschedulable back to `scheduled`.

### 5. Post-tour feedback and the exit gate

The team asks, through the app: *what did you think — want to move forward?* The
answer is relayed back and recorded. This is the **exit gate**, the boundary of
this sequence:

- **Yes — move forward.** Outcome `move_forward`; the tour becomes
  **`convertible`**. **No placement is created here and the tenant stays
  `searching`.** Hand off to **Post-Tour & Application**, where the placement is
  created from the convertible tour and this masked tour thread carries over.
- **No — not a fit.** Outcome `not_a_fit`; the tour closes. The tenant stays
  `searching`; hand back to **Sending Unit** to share a new property and restart
  the loop.

## How this evolves the source documents

The workflow is evolving faster than the planning docs, so this diagram encodes
the **founder-confirmed current process** and departs from the older documents in
three deliberate ways:

1. **The masked relay group forms at touring, not later.** Process Flow Track 6
   ("group text formation once the RTA is submitted") refers to something else:
   the **real** group text where tenant and landlord finally see each other's
   actual phone numbers, formed downstream once the RTA is in. The
   tour-coordination thread in this diagram is the **masked relay** (pool number,
   real numbers hidden) and it forms as soon as tour coordination starts.
2. **"Coordinate separately, then combine" is struck.** Product spec F4.2
   described the VA syncing tenant and landlord separately and then uniting them.
   The actual flow is one masked group thread from the start, with the
   negotiation happening inside it.
3. **The tour record precedes the time.** Figure 3 shows the tour created once
   the slot is confirmed. The refinement: the record is created **at tour
   interest, with no time**, so it can own the group thread during coordination;
   *booking* = setting the time on it, and that is still the moment the
   confirmation + reminder ladder fire (Figure 3's semantics preserved).

## Known gaps this diagram intentionally surfaces

The diagram documents the **intended** flow. Where intent runs ahead of the built
system, the e2e conformance audit (see `documentation/sequence-diagram-to-test.md`)
formalizes the gap and the build closes it:

1. **Create a tour without a time.** `POST /api/tours` currently requires
   `scheduledAt` and arms the reminder ladder immediately at create. The flow
   needs a timeless create (the coordination-anchor state), with the ladder armed
   only when the time is first set. May need a pre-`scheduled` status label —
   decided at build time.
2. **Reminder routing to the group thread.** The built ladder always texts the
   tenant's 1:1 thread. Per the founder decision above, tours with a group thread
   (landlord-led / PM) should get their reminders in the group instead.
3. **Mark-toured / mark-no-show controls.** The transitions into `toured` /
   `no_show` are API-supported (`PATCH { status }`) but do not yet all have
   dedicated dashboard controls (TourDetail has reschedule, cancel, and the
   exit gate). (2026-07-08: the `confirmed` status - and with it any Confirm
   control - was removed; `scheduled` covers it.)

## Out of scope, but documented

- **Group threads across multiple concurrent tours** — presentation, numbering,
  and which thread survives conversion: `docs/issues/group-threads-across-multiple-tours.md`.
- **The tour → placement conversion** (creating the placement, `searching →
  placing`, carrying the thread over) belongs to **Post-Tour & Application**.
- **The Track-6 real group text** (visible numbers, post-RTA) is downstream of
  conversion and not part of this sequence.
- **The `tour_took_place` activity milestone** no longer fires after
  `placement.tours[]` was retired — `docs/issues/tour-took-place-milestone.md`.
