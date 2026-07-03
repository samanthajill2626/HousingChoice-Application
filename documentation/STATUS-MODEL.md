# Entity Lifecycle & Status Model

> **LIVING DOCUMENT — canonical, evolving.** This is the source of truth for how the
> three core entities move through the HousingChoice process. It is **not** a dated
> spec and must **not** be stamped HISTORICAL — expect tweaks and additions over time.
> When the model changes, edit this file in place (like its sibling
> [GLOSSARY.md](GLOSSARY.md)). Last substantive update: **2026-06-19**.
>
> Naming follows the glossary: the dwelling is a **`unit`** in code/data, shown as
> **home** to tenants and **property** to landlords/staff. The workflow record is a
> **`placement`** in code, data, and UI — the original `case`/`cases` naming was
> renamed to `placement`/`placements` throughout (the API path is `/api/placements`,
> the DynamoDB table is `placements`, the PK is `placementId`).

---

## 1. What this models

Three entities move together from onboarding to a tenant placed, a placement closed,
and a property moved into:

- **Placement** — the **spine**. The fine-grained workflow ladder for getting one
  tenant into one specific unit. It begins **after a tour, once the tenant affirms a
  specific unit** (interest and touring happen earlier, on the tenant — see below).
- **Tenant** — a **coarser** lifecycle for where the *person* is, independent of any
  one unit. Starts before any placement, ends after.
- **Property** (the `unit`) — a **coarser** lifecycle for where the *unit* is. Mostly
  **derived** from its committed placement.

The placement is authoritative; the tenant and property lifecycles are largely
read-throughs of it (see §6).

---

## 2. Design principles (why the labels read the way they do)

1. **Stages name the next outstanding action — not what's been completed.** A status
   answers *"what are we waiting on / what's the next move?"*, so it can never be
   misread as ✓-done. The **only** past-tense labels in the whole system are the two
   terminals: **Moved in** and **Lost**.
2. **Verb vs. `Awaiting` split.** A stage is a **verb** when the next move is *ours*
   (`Send …`, `Review …`, `Schedule …`, `Determine …`) and **`Awaiting …`** when we're
   blocked on someone else (`Awaiting approval`, `Awaiting authority approval`). This
   quietly conveys whose court the ball is in **without** a separate owner field
   (there deliberately isn't one — ownership is too back-and-forth to be useful).
3. **Phase = where we are; stage = what's outstanding.** The **phase** is the
   glance-level board column ("which part of the process"); the **stage** is the
   single outstanding thing within it.
4. **Glance-useful AND action-driving.** The model exists to both show stage at a
   glance *and* push entities forward — not to accumulate statuses for their own sake.

### Naming conventions

- **Phases are Title Case** (`Rent Determination`, `Application`). `RTA` and `HAP` are
  acronyms and stay all-caps.
- **Stages are sentence-case** (`Awaiting authority approval`, `Send RTA to landlord`).
- **Terminals** are marked **✓** (success) / **✕** (exit).

---

## 3. The big picture

```
╔═══════════════════════════════════════════════════════════════════════════════════╗
║  PLACEMENT  (the spine)                                                             ║
╚═══════════════════════════════════════════════════════════════════════════════════╝

 APPLICATION        RTA                    INSPECTION      RENT DETERMINATION
 ┌──────────────┐   ┌────────────────────┐ ┌────────────┐ ┌──────────────────────┐
 │ Send         │   │ Collect RTA        │ │ Schedule   │ │ Determine rent       │
 │  application │──▶│ Review RTA         │▶│  inspection│▶│ Awaiting rent        │
 │ Awaiting     │   │ Send RTA to        │ │ Awaiting   │ │  acceptance          │
 │  receipt     │   │  landlord          │ │  inspection│ └──────────┬───────────┘
 │ Awaiting     │   │ Awaiting landlord  │ └────────────┘            │
 │  completion  │   │  submission        │                           ▼
 │ Awaiting     │   │ Awaiting authority │           CONTRACT     ADMINISTRATIVE
 │  approval    │   │  approval          │           ┌──────────┐ ┌──────────────────┐
 └──────────────┘   └────────────────────┘           │ Awaiting │ │ Complete         │
                                                      │  HAP     │▶│  paperwork       │
                                                      │  contract│ │  ☐ lease signed  │
                                                      └──────────┘ │  ☐ LIF           │
                                                                   │  ☐ move-in deets │
                                                                   └────────┬─────────┘
                                                                            ▼
                                                                      CLOSURE
                                                                   ┌──────────────────┐
                                                                   │ Awaiting move-in │
                                                                   └────────┬─────────┘
                                                            ┌───────────────┴────────┐
                                                            ▼                         ▼
                                                       ✓ MOVED IN                ✕ LOST
                                                                          (from any stage)

╔═══════════════════════════════════════════════════════════════════════════════════╗
║  TENANT                                                  ║  PROPERTY                ║
╠══════════════════════════════════════════════════════════╬══════════════════════════╣
║                                                          ║                          ║
║  Needs review                                            ║   Setup                  ║
║      │                                                   ║     │                    ║
║      ▼                                                   ║     ▼                    ║
║  Onboarding ──(RTA in hand; porting flag clear)──┐       ║   Available              ║
║      │                                           │       ║     │                    ║
║      ▼                                           ▼       ║     ▼                    ║
║  Searching ───────────────────────────────▶ Placing     ║   Under application      ║
║   (interest + touring)                           │       ║     │                    ║
║                                                  ▼       ║     ▼                    ║
║                                              Placed ✓    ║   Finalizing             ║
║                                                          ║     │                    ║
║   overrides:  On hold      terminal:  Inactive           ║     ▼                    ║
║   flag:       porting                                    ║   Occupied ✓             ║
║                                                          ║   ovr: On hold           ║
║                                                          ║   term: Off market       ║
╚══════════════════════════════════════════════════════════╩══════════════════════════╝
```

---

## 4. Placement — the spine

The full ladder. Phase = board column; stage = the single outstanding thing.

| Phase | Stages |
|---|---|
| **Application** | `Send application` · `Awaiting receipt` · `Awaiting completion` · `Awaiting approval` |
| **RTA** | `Collect RTA` · `Review RTA` · `Send RTA to landlord` · `Awaiting landlord submission` · `Awaiting authority approval` |
| **Inspection** | `Schedule inspection` · `Awaiting inspection` |
| **Rent Determination** | `Determine rent` · `Awaiting rent acceptance` |
| **Contract** | `Awaiting HAP contract` |
| **Administrative** | `Complete paperwork` |
| **Closure** | `Awaiting move-in` → **`Moved in`** ✓ · **`Lost`** ✕ |

Notes per phase:

- **RTA** is the per-unit Request for Tenancy Approval cycle (distinct from the
  tenant-level "RTA in hand" gate in §5). `Send RTA to landlord` → landlord submits to
  the authority (`Awaiting landlord submission`) → authority accepts
  (`Awaiting authority approval`).
- **Inspection** carries a **date** and a pass/fail **outcome**. A failed inspection
  routes to reschedule or to `Lost`.
- **Rent Determination** — when `Awaiting rent acceptance` clears (the **landlord**
  accepts the determined rent), the accepted amount is written onto the property as
  **`final_rent`** (used for billing).
- **Contract** — the **HAP** contract is executed between the **authority and the
  landlord**; its own single stage, no substeps. This is where the property flips to
  `Finalizing`.
- **Administrative** is **one** stage holding an **unordered checklist** — all three
  required, any order: **lease signed**, **LIF** document, **move-in details shared**.
- **Closure / `Lost`** is reachable **from any stage** and carries a reason (§7).

---

## 5. Tenant — coarse lifecycle

Where the *person* is, regardless of unit.

```
Needs review → Onboarding → Searching → Placing → Placed
   overrides: On hold        terminal: Inactive        flag: porting
```

- **`Needs review`** — the single front door. Every new contact lands here; there is
  no separate triage state and no `new` status.
- **`Onboarding` → `Searching`** — RTA-in-hand is a **business** prerequisite to move
  forward, but it is **not an app-enforced gate** (2026-06-19 decision). The app does not
  track an `rta_in_hand` boolean and does not block the transition; the **admin advances**
  the tenant to `Searching` when RTA is in hand (we assume everyone has it unless we know
  otherwise) and moves them to **`On hold`** when they don't. The **`porting` flag**
  (voucher/RTA being moved between jurisdictions = "not ready") is an **informational**
  signal on the tenant — it does **not** hard-block `Searching` (a porting tenant is
  typically parked via `On hold`). **Porting lives on the tenant, never as a placement
  stage.**
- **`Searching`** absorbs interest **and** touring — all the pre-placement activity.
- **`Placing`** — one coarse "we are actively placing this tenant" state. It does
  **not** mirror the placement's fine stages; the spine carries that detail.
- **`Placed`** ✓ is the win. **`Inactive`** ✕ is the terminal exit. **`On hold`** is a
  pause that doesn't lose their spot.

---

## 6. Property — coarse lifecycle (derived)

Where the *unit* is. Extends today's `unit.status` rather than replacing it.

```
Setup → Available → Under application → Finalizing → Occupied
   overrides: On hold        terminal: Off market
```

- **`Setup`** — being prepped; not yet shareable.
- **`Available`** — the **only publicly-shareable** state (gates the public flyer), as
  today.
- **`Under application` / `Finalizing` / `Occupied`** are **derived** from the
  committed placement (see §7). **`Off market`** replaces today's `inactive`.

---

## 7. How the three align (derivation)

The placement spine drives the tenant and property lifecycles. The derived value is the
**lowest-precedence** input — a manual / AI / automation write still wins (§8).

| Placement is in… | → Tenant | → Property |
|---|---|---|
| *(none yet)* | `Needs review` / `Onboarding` / `Searching` | `Setup` → `Available` |
| **Application** → **Rent Determination** | `Placing` | `Under application` |
| **Contract** + **Administrative** + **Closure** (`Awaiting move-in`) | `Placing` | `Finalizing` |
| **Closure → Moved in** ✓ | `Placed` | `Occupied` |
| **Lost** ✕ *(no other active placement)* | back to `Searching` | back to `Available` |

So a placement sitting at `RTA / Awaiting authority approval` reads as: **tenant
`Placing`, property `Under application`**, and the spine pinpoints the blocker — the
housing authority.

**Tenant drop-out is manual for now.** A `Lost` placement automatically bounces the
tenant back to `Searching` (they still have a voucher). If a tenant genuinely drops out
(ghosting, voucher expired, etc.), staff **manually** move them to `Inactive` — we are
not auto-dropping tenants yet.

---

## 8. Cross-cutting rules

- **Cardinality — mostly one.** Early interest can be many units, but a tenant
  converges to **one primary placement** by the Application phase.
- **Source of truth — derive + state-based override.** The coarse tenant/property
  status is normally **derived** from the committed placement (§7). Whether a derived
  write may move an entity is gated on its **current state**, not on who last wrote it:
  derivation freely drives the **baseline progression** states forward — property
  `Setup → Available → Under application → Finalizing → Occupied`, tenant
  `Needs review → Onboarding → Searching → Placing → Placed` — *regardless of source*,
  but it is **blocked (pinned)** when the entity currently sits in an **override / exit
  state**: property **`On hold`** / **`Off market`**, tenant **`On hold`** / **`Inactive`**.
  Those override states are reached only by an explicit (`manual` / `ai` / `automation` /
  `import`) write and stick until a human/automation explicitly moves the entity back out
  — then derivation resumes on the baseline. Explicit writes always apply (last-writer
  wins among them); the future AI/automation layer is just more `source` values driving
  the same transitions. The `source` is retained for **provenance/audit** only — it no
  longer decides whether a baseline status can be overwritten. (Rationale and the prior
  source-precedence design this replaced: `docs/issues/status-pin-vs-terminal-derivation.md`.)
- **Provenance.** Every status/stage transition records `{ from, to, source, reason? }`.
  The **current** value is denormalized on the entity (so "what state now?" is a cheap
  read, never a scan); **history** is an append-only per-entity log queried by entity.
- **Time in stage.** Each entity records when it entered its current stage, so
  time-in-stage is computable. Per-stage thresholds drive **"stuck too long" flags** —
  the dominant reason placements die. A **flag** is an *internal, staff-facing* signal
  DERIVED from time-in-stage (`stage_entered_at` vs `STAGE_STUCK_THRESHOLDS`), not a
  stored artifact and not an external SMS **nudge** (the `placementNudges` ladder is a
  separate system — see [GLOSSARY.md](GLOSSARY.md) → "deadline, flag, nudge").
- **Deadlines — first-class, one per type.** A placement's real due-dates are
  first-class **`placementDeadlines`** items (one per `(placement, type)`:
  `rta_window`, `voucher_expiration`, `follow_up`), not a single overloaded
  `next_deadline` slot. Each type is armed/retired independently, and the placement
  surfaces whichever is **soonest** (computed at read time; the flat
  `next_deadline_type`/`next_deadline_at` wire shape is preserved as a computed
  projection). Because the stuck **flag** is derived (above) rather than occupying a
  deadline slot, a placement that is *both* on a hard clock *and* going stale now
  surfaces on both queues at once — the two signals no longer suppress each other.
  Full design: [placement-deadline-model spec](../docs/superpowers/specs/2026-07-03-placement-deadline-model-design.md).
- **Lost reason — pick or write.** Choose a category
  (`stalled`, `no_contact`, `landlord_lost_rent`, `landlord_lost_inspection`,
  `tenant_withdrew`, `voucher_expired`, `other`) **or** free-write one (always
  available). Stored as category + free text; surfaces on the placement and tenant.

---

## 9. How this will change (and stay cheap to change)

This model **will** be tweaked and extended. It is designed so most changes are cheap:

- **Adding or reordering stages** needs no data migration — storage is flexible-document,
  stage knowledge lives in a single ordered list, and this is **not** a strict state
  machine (stages can be skipped/jumped).
- **Renaming or removing** a stage needs a bounded one-off backfill.
- Keep all stage knowledge **centralized** (the ordered stage list, the derivation map,
  the display-label map, the terminal set) and route transitions through **one** service,
  so a change lands in one place.
- A future option, if non-engineers should edit stages without a deploy: move the stage
  list into a config record.

---

## 10. Status — what's settled vs. open

**Settled:** the three lifecycles, all stage/phase labels above, the verb/`Awaiting`
framing, no owner field, porting as an informational tenant flag, RTA-in-hand as a
**manual** prerequisite (admin-advanced, **not** an app-enforced gate — 2026-06-19),
`final_rent` on rent acceptance, `inspection_outcome` (pass/fail) captured on the
inspection-complete move, state-based derivation gating (only override/exit states pin —
see §8), `Finalizing` anchored at Contract, `Lost` bouncing the tenant to `Searching`,
manual tenant drop-out, and the `case`/`cases` → `placement`/`placements` rename
(now complete across code, data, and UI — the workflow entity is `placement`
everywhere).

**Open / future:**
- Implementation (data fields, the transition service, derivation, UI) is a separate
  effort, to be planned when we build it — this doc captures the *model*, not the build.
