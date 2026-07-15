# Post-Tour & Application Sequence — Overview (Phase 1)

Companion notes for `post-tour-application-sequence.mermaid`. This covers the first
half of a placement's open lifetime: from the tenant's "yes, I want to move in
here" (the Tours exit gate) to the landlord submitting the RTA to the housing
authority. The second half — the ~4-week authority window through move-in — is the
separate **Approval & Move-in** sequence (not yet authored).

**Why the split at RTA submission (founder-approved 2026-07-02):** that is the
moment the deal leaves our actors' hands and enters housing-authority land. The
cast changes (the authority walks on stage), the cadence changes (a 48-hour
paperwork sprint becomes a 4-week shepherding marathon), and the built placement
ladder breaks naturally there (`Awaiting landlord submission` →
`Awaiting authority approval`).

**Scoping rule used here (founder, 2026-07-02):** the happy path is required, and
deviations that pull off it are *marked* — shown with their exit, not elaborated.
Unwieldy branches become their own sequences later. In this diagram three
deviations are marked (landlord denies the application, the 48-hour RTA window
blows, a party backs out entirely) and one is deliberately deferred to a future
sequence of its own (tenant stalls / goes cold mid-application — partially
mitigated by the auto nudge ladder anyway).

## How to read the diagram

Same participants and rules as the other sequences: Tenant / Housing Choice App /
Team / Landlord-PM; the app owns the phone number and every message relays through
it; `[AUTO]` is app automation, `[MANUAL]` is the team acting by hand.

One channel rule specific to this sequence: **the masked relay group created for
the tour carries over to the placement and remains the channel throughout.** No
new group text is formed and nothing is unmasked. (The source docs' Track 6
"create group text once the RTA is submitted" — the *real*, visible-numbers group
text — is **deferred**; the relay continues for now, per founder 2026-07-02.)

## Where this sits

- **Upstream:** the **Tours** sequence ends at the exit gate — which (since
  2026-07-15) converts in the same step, so this sequence's entry state is the
  freshly created placement (born at `Send application`).
- **The spine:** the placement and its stage ladder (`statusModel.ts`,
  `documentation/STATUS-MODEL.md`). Stages name the *next outstanding action*.
  This sequence walks the **Application** block (`Send application` →
  `Awaiting receipt` → `Awaiting completion` → `Awaiting approval`) and the
  first four **RTA** stages (`Collect RTA` → `Review RTA` →
  `Send RTA to landlord` → `Awaiting landlord submission`).
- **Every stage transition is stamped in the diagram, in ladder order** —
  placement born at `Send application`, through to `Awaiting authority
  approval`. This is a test requirement (founder, 2026-07-03): the e2e suite
  must move the placement into and out of **each** stage, skipping none. Two
  transition gates the stamps encode: `Awaiting completion → Awaiting approval`
  only after the completed application is confirmed **in the landlord's hands**,
  and `Awaiting landlord submission` is what arms the 48-hour clock.
- **Downstream:** recording the landlord's submission moves the placement to
  `Awaiting authority approval` — the first stage of **Approval & Move-in**.

## The flow, stage by stage

### 1. Conversion — quiet record-keeping

When the tenant says yes, the team **converts the tour into a placement** — same
tenant + unit, linked back to the originating tour. This is deliberately **quiet**:
no announcement is made; the landlord first hears about it when the application
starts moving (founder decision, 2026-07-02).

Conversion side effects (the feature to build — deferred out of the Tours build):
- The placement is created with `fromTourId`; the tour closes as converted.
- The tenant moves `Searching → Placing`; the property derives `Under application`.
- The tour's masked relay thread **rebinds** to the placement (the owner-agnostic
  thread machinery built in the Tours feature anticipated exactly this).
- The dead `tour_took_place` activity milestone gets re-wired here, off tour
  status events (`docs/issues/tour-took-place-milestone.md`).

### 2. Application — one uniform flow, per-property specifics

**How** an application moves is never standardized — it follows the property's
`application_process` captured at landlord onboarding (an online portal, a PDF, a
PM system…). The diagram models the **uniform shape** with the process as a note,
rather than branching by type (founder-approved; fits the happy-path-first rule).
The stamped stage walk:

1. Team **sends the application to the tenant** → stage `Send application →
   Awaiting receipt`.
2. Tenant **confirms they got it** → `Awaiting receipt → Awaiting completion`.
3. Tenant **completes it**, and the team **sends the completed application to
   the landlord** (per the property's process) — only once the landlord confirms
   it is in their hands does the stage move: `Awaiting completion → Awaiting
   approval`. (Order matters: `Awaiting approval` must never be reached before
   the landlord has the application.)
4. Landlord **approves** → `Awaiting approval → Collect RTA`.

**`[AUTO]` piece #1 — the application follow-up ladder.** Sending the application
arms scheduled nudges keyed to whatever the current stage awaits (*received?
completed? landlord received? approved?*) with stall escalation; stalls surface on
the Today board. This is in scope for this build (founder chose the larger
automation scope).

**Marked deviation — landlord denies:** placement LOST; tenant returns to
`Searching` and re-matches (back to Sending Unit); property returns to
`Available`. Full denial handling is a future sequence if needed.

### 3. RTA — collect, review, send, and the 48-hour clock

The RTA here is the **per-unit Request for Tenancy Approval cycle** — distinct
from the tenant-level "RTA in hand" gate back in tenant onboarding. The stamped
stage walk:

5. Team asks the tenant for the paperwork; tenant sends it (photos/files over
   MMS) → `Collect RTA → Review RTA`.
6. Team **reviews that all documents are in order** → `Review RTA → Send RTA to
   landlord`.
7. Team sends the package to the landlord → `Send RTA to landlord → Awaiting
   landlord submission`. The landlord must **submit it to the housing authority
   within 48 hours** (the commitment captured at landlord onboarding).
8. Landlord confirms submission → `Awaiting landlord submission → Awaiting
   authority approval` — the handoff.

**`[AUTO]` piece #2 — the 48-hour submission clock.** Entering `Awaiting landlord
submission` arms a 48-hour deadline on the placement — surfacing on the Today
board via the existing next-deadline machinery, with an alert + nudge as it
approaches or blows.

**Marked deviation — 48 hours blown:** the deadline alert fires, the team nudges
the landlord to recommit; late submission or LOST. Full escalation handling is a
future sequence if needed.

### Marked deviation — a party backs out (any stage)

`Lost` is reachable from any stage. Tenant returns to `Searching` (re-match),
property returns to `Available`, the relay thread closes. Shown once, globally,
rather than per-stage.

## Known gaps this diagram intentionally surfaces

For the e2e conformance audit (per `documentation/sequence-diagram-to-test.md`):

1. **Tour → placement conversion does not exist.** The exit gate leaves a tour
   `convertible`; nothing creates a placement from it. Needs: create-from-tour
   (placement + `fromTourId`, tenant `Searching → Placing`, tour → closed/converted,
   thread rebind via the existing owner-agnostic relay machinery), plus the
   `tour_took_place` milestone re-wire.
2. **The application follow-up ladder** (four rungs, scheduled nudges, stall
   escalation) is not built — Phase-1 posture was manual; the founder pulled it
   into scope for this build. The durable-rows + worker-poll pattern from tour
   reminders is the template.
3. **The RTA 48-hour clock** — arming a placement deadline when the RTA goes to
   the landlord. The next-deadline machinery exists; the arming/alert/nudge wiring
   for this specific clock needs the audit to confirm what is missing.

## Out of scope, but documented

- **Approval & Move-in** — everything after RTA submission (authority approval,
  inspection, rent determination, LIF, lease, move-in + final inspection).
- **Tenant stalls / goes cold** mid-application — deferred to its own future
  sequence; the nudge ladder partially covers it meanwhile.
- **Unmasked "real" group text** (source docs Track 6 Phase 1) — deferred; the
  masked relay continues as the channel.
- **Invoicing** (Track 7) — fires at move-in; its own tiny sequence later.
- **Multi-tour convergence** — several convertible tours converging to one
  placement: `docs/issues/group-threads-across-multiple-tours.md` still governs
  the thread question; conversion here assumes the chosen tour.
