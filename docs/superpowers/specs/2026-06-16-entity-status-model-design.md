<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-20).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-20. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** The
> LIVING source of truth for the status model is `documentation/STATUS-MODEL.md`; also read
> the code. Kept only as a point-in-time record of intent.
# Entity Status Model — Tenant, Listing, Case

**Date:** 2026-06-16
**Status:** Draft for review. The **case spine has founder-pending refinements** (see §3.2) — those refine the ladder later but do not change the shape of this model. Do NOT start an implementation plan until the founder answers land and this spec is re-confirmed.

---

## 1. Purpose & scope

Define the enumerated **status labels** for the three workflow entities — **tenant**, **listing** (unit), and **case** — the workflow that moves them from onboarding to placed, and how each status transition is **sourced and audited**.

Goals (from the brainstorming):
- A label set that is genuinely **useful at a glance** ("where is this person / unit / deal?"), not a pile of statuses.
- The labels actively **help move entities through** the process (the case spine drives the others).
- **Provenance on every transition** — to see *how* an entity reached a state, debug, adjust, and audit movement through the system.

In scope: the status enums for all three entities, the relationship/derivation between them, and the transition-log/provenance design.

Out of scope (separate work): the dashboard UI for any of this; the data migration mechanics; the relay media fan-out follow-up; Phase-2 matching/AI internals (this spec only reserves the *hook* for them).

---

## 2. The model — three layers

### 2.1 Cardinality (settled)

"Mostly one, sometimes a few." A tenant may fan out across a few listings early (interest / touring), then **converges to one primary deal once a case reaches `applied`**. So tenant- and listing-level status are **rollups** early and track the **primary case** once it converges. A unit likewise can have several interested tenants until one converges.

### 2.2 The three layers

1. **Case = the spine.** The `case` is the fine-grained ladder for *one tenant↔listing deal*. It is the only place the step-by-step detail lives, and it is what *defines the workflow* — the other two entities use it as context and are moved by it.
2. **Tenant and Listing each own a lifecycle.** Not mirrors of a case: each has a **pre-case phase** (tenant onboarding / listing setup), a **case-driven middle** (derived from the primary case), and a **terminal**. Deliberately **coarser** than case stages — the case answers "where's *this* deal?"; the entity status answers "where's this *person/unit* overall?".
3. **Every status carries provenance** (§7). A status is a value plus *who/what set it, when, and why*. This is the Phase-2 hook: AI/automation become additional transition **sources** writing through the same path, with no rework.

```
            ┌─ pre-case ─┐   ┌──── case-driven middle (derived) ────┐   ┌ terminal ┐
TENANT:   needs_review→onboarding→ searching → in_process ───────────────→ placed | inactive
                                       │                                        ▲
CASE:        interested→touring→applied→rta_submitted→inspection→             │
                          rent_determined→approved→lease_signed→ moved_in ─────┘ | lost
                                       │
LISTING:   setup → available → under_application → lease_signed → occupied | off_market
           └─ pre-case ─┘   └──────── derived from its primary case ───────┘
```

---

## 3. Case stages (the spine)

### 3.1 The ladder

An **ordered list, not a strict state machine** (matches today's design: a hand-touched parity process, with `lost` reachable from any stage).

| # | Stage | Meaning |
|---|---|---|
| 1 | `interested` | Tenant is interested in *this* unit — the case is born here (promoted from a match/share). |
| 2 | `touring` | Tour scheduled / happened. |
| 3 | `applied` | Landlord-side application/screening phase. **Placeholder — to be split into the founder's visible application rungs (2–4 stages); one stage until then.** |
| 4 | `rta_submitted` | Request for Tenancy Approval submitted to the housing authority. |
| 5 | `inspection` | HQS inspection. |
| 6 | `rent_determined` | Rent reasonableness + tenant portion / HAP determined. |
| 7 | `approved` | Housing authority has approved everything; cleared to sign — lease not yet signed. |
| 8 | `lease_signed` | Lease (+ HAP contract) signed; **move-in still pending**. |
| 9 | `moved_in` | Tenant moved in. **Terminal — success.** |
| 10 | `lost` | Deal died (reachable from *any* stage); reason captured in the transition log (§7). **Terminal — closed.** |

**Case flag, not a stage:** `portability_required` (boolean) — when a voucher must port to another authority, the HUD paperwork track runs *in parallel* with its own clock (deadlines), surfaced as a flag/badge on the case. It is never a position in the linear ladder.

**Changes from the current 10-stage ladder** (`interested → porting → touring → applied → rta_submitted → inspection → rent_determined → lease → moved_in | lost`):
- **Removed** `porting` as a linear stage → it becomes the `portability_required` flag.
- **`applied`** is flagged to split into the founder's visible application rungs (kept as one placeholder stage now).
- **Added** `approved` before signing.
- **Renamed** `lease` → `lease_signed` (the old name over-reads as "done"; signing ≠ moved in).

### 3.2 Deferred to the founder (refines this ladder; does not change the model)

Captured in the founder question list; each only adjusts the spine's granularity:
1. The actual application rungs that split `applied` into 2–4 visible stages.
2. Whether `inspection` / `rent_determined` are sequential or parallel.
3. Whether the HAP contract is tracked separately from the lease (could split `lease_signed`).
4. The common reasons a deal dies (the `lost` reason vocabulary — captured as transition-log reasons, not extra terminals).

---

## 4. Tenant lifecycle

The tenant's `status` **is** its lifecycle — there is no separate identity-triage axis. `needs_review` is simply the first value (the universal entry for any captured contact), so we do not add a redundant `new` state. A tenant has **one coarse `in_process`** for the whole case-driven middle (the case shows the detail); we can split it later if needed.

| Status | Phase | Meaning | Set by |
|---|---|---|---|
| `needs_review` | pre-case (entry) | Captured but unconfirmed — what auto-capture drops an inbound stranger into. The triage queue. | manual / import / auto-capture |
| `onboarding` | pre-case | Confirmed tenant; gathering voucher size/program/authority, **RTA in hand + expiration**, prescreen, preferences. Not yet search-ready. | manual |
| `searching` | case-context | Onboarded + voucher-ready; being matched / shown listings. Early-interest cases may exist but none has converged. | derived (onboarding done) / manual |
| `in_process` | case-driven | Has a **primary case at `applied` or beyond** — an active deal moving through application / RTA / inspection / approval / lease. | **derived** from the case |
| `placed` | terminal ✓ | Moved into a unit (a case reached `moved_in`). | **derived** from the case |
| `on_hold` | override | Paused by an actor (voucher issue, traveling, medical). Wins over derived; reversible. | manual / *(Phase 2: ai)* |
| `inactive` | terminal ✕ | Closed without placement — voucher expired, withdrew, unreachable, placed elsewhere. Reason in the transition log. | manual |

**Notes / existing-system reconciliation:**
- This **replaces** the contact's current `status` value set (`needs_review | active`): `needs_review` stays as the entry; `active` is absorbed (being in `onboarding`+ implies confirmed). The `byTypeStatus` GSI still serves the triage queue — it is the `(type, status=needs_review)` partition — and the inbox "needs review" cue is unchanged.
- `contact.type` (`tenant | landlord | pm | team_member | unknown`) is a **separate** axis and is unchanged. This lifecycle is the tenant reading of `status`; landlords get their own lifecycle off the same shared `needs_review` entry in later work.
- Derivation never auto-sets `on_hold` or `inactive` (an actor does). A `lost` primary case with no other active case returns the tenant to `searching` (still looking), not auto-`inactive`.

---

## 5. Listing (unit) lifecycle

Proposed to **replace/extend the current `unit.status`** (`available | placed | inactive`) — keeps the `byStatus` GSI for board queries; a small value migration (see §8). Mirrors the tenant through the same case.

| Status | Phase | Meaning | Set by |
|---|---|---|---|
| `setup` | pre-case | Landlord registered the unit; details / photos / accepted-programs / listing-link being gathered. Not shareable yet. | manual |
| `available` | case-context | Live + shareable (broadcasts, flyer); open to interest. | manual / derived |
| `under_application` | case-driven | A tenant's case on it converged (`applied`+, through `approved`) — spoken-for, off the open market pending that deal. | **derived** from the case |
| `lease_signed` | case-driven | Lease / HAP signed (case `lease_signed`); awaiting move-in. | **derived** from the case |
| `occupied` | terminal ✓ | Tenant moved in (case `moved_in`). The listing's "moved into" end. | **derived** from the case |
| `on_hold` | override | Temporarily not shown — under repair, landlord paused. | manual / *(Phase 2: ai)* |
| `off_market` | terminal ✕ | Withdrawn / no longer offered. | manual |

**Note:** a listing can re-enter the cycle later (a lease ends → operator returns it to `setup`/`available`); `occupied`/`off_market` are the success/closed *ends of this placement*, not permanently terminal records.

---

## 6. Derivation map (case → tenant + listing)

The **primary case** (the converged case at `applied`+; before convergence the most-advanced active case on the entity) drives the case-driven middle of both other entities. The symmetry is intentional — one case event moves both sides.

| Primary case stage | → Tenant | → Listing |
|---|---|---|
| `interested`, `touring` | `searching` | `available` |
| `applied` → `rta_submitted` → `inspection` → `rent_determined` → `approved` | `in_process` | `under_application` |
| `lease_signed` | `in_process` | `lease_signed` |
| `moved_in` | `placed` | `occupied` |
| `lost` (no other active case) | back to `searching` | back to `available` |

**Override precedence (§7):** derivation only advances a status whose current source is `derived`. An explicit `manual` / `ai` / `automation` value (e.g. tenant `on_hold`, listing `off_market`) **pins** and is never overwritten by derivation until an actor clears it.

---

## 7. Provenance & transition log

### 7.1 Current value lives on the entity (reads never scan)

Each entity stores its **current** status plus denormalized provenance for display:

```
status        (the value above)         — case uses `stage`
status_source 'derived'|'manual'|'ai'|'automation'|'import'
status_at     ISO 8601
status_by     userId | system component | ai-agent id | null
```

Every "what state is this in?" read — boards, lists, filters — hits the **entity directly** (or its `byStage` / `byStatus` / `byTypeStatus` GSI). **No audit-table involvement, ever.**

### 7.2 History lives in `audit_events` (append-only, per-entity query)

Reuse the existing **`audit_events`** table (append-only, PITR'd, PK `entityKey` = `<table>#<id>`, SK `ts`, `byActor` GSI; it already emits `case.stage_changed`). Every status change appends one event **in addition to** updating the entity:

```
event_type: 'status_changed'
entityKey:  'cases#…' | 'contacts#…' | 'units#…'
ts:         ISO 8601
actorId:    (hoisted to the byActor GSI)
payload:    { from, to, source, reason?, correlationId? }
```

- A status change is a **dual write**: update the entity's current value **and** append the transition event.
- Reading an entity's **history** (its case / contact / listing page timeline) is a single-partition **Query by `entityKey`** — returns just that entity's events in time order. Never a full-table scan.
- `reason` carries free text (the `lost` reason, "voucher expired", "landlord declined") and flows to the case + contact pages.
- `correlationId` ties the transition to the request / job / case event that caused it, for debugging.

### 7.3 Precedence & Phase-2

- **`derived` is the lowest priority** — auto-derivation only advances a status whose current `source` is `derived`, so it never stomps an explicit write.
- **`manual` / `ai` / `automation` win** and stick (last-writer-wins; the log shows who + when). To "un-pin," an actor moves it back to a derived-eligible state.
- **Phase 2** AI and automation are simply two more `source` values writing through this exact path — no rework. (`import` covers data-migration writes.)

---

## 8. Data-model touchpoints (for the implementation plan)

Light list; the plan details migrations and tests.

- `contactsRepo` — `ContactItem.status` value set becomes the tenant lifecycle (§4). `byTypeStatus` GSI unchanged (still keys on `(type, status)`).
- `unitsRepo` — `UNIT_STATUSES` becomes the listing lifecycle (§5). Value migration: `available` stays, `placed → occupied`, `inactive → off_market`; add `setup`, `under_application`, `lease_signed`, `on_hold`. `byStatus` GSI unchanged.
- `casesRepo` — `CASE_STAGES` updated to the §3 ladder (remove `porting`, add `approved`, rename `lease → lease_signed`); add the `portability_required` flag; `TERMINAL_STAGES` = `{ moved_in, lost }` (unchanged). `byStage` GSI unchanged.
- New denormalized fields on all three: `status_source` / `status_at` / `status_by` (case: `stage_source` / … or reuse the same names).
- `auditRepo` / `audit_events` — new `status_changed` event type (no schema change; flexible payload).
- A small **status-transition service** is the single writer that does the dual write (entity + audit event) and enforces the derive/override precedence — so every path (manual route, derivation, future AI/automation) goes through one place.

---

## 9. Changeability — adding / removing / reordering stages

Changing the stage/status sets is **expected**, and it is a small, localized edit — **not a rewrite** — by three deliberate properties:

1. **Flexible-document storage.** `stage` / `status` are plain string attributes, not schema columns. Adding a value needs **no migration** — it's just a newly-allowed string, and the `byStage` / `byStatus` GSIs key on the value, so a new value simply forms a new partition (no index change).
2. **Single source of truth per enum.** Each set is one `const [...] as const` array (the existing pattern) that derives the TypeScript type. Editing the array *is* the change; the compiler then flags every place that must keep up.
3. **Ordered list, not a strict state machine.** There is no transition matrix to maintain (the board is hand-touched; an operator may move a case to any stage), so adding or reordering does not require rewriting allowed-transition rules.

**Cost by change type:**

| Change | What it touches | Data migration? |
|---|---|---|
| **Add** a stage/status | the enum array; the derivation map (if it affects derivation); the label/order map | **None** — the new value is immediately storable + queryable |
| **Reorder** | the enum array order (drives display order + any "is X before Y" check) | None |
| **Rename** | the enum array; derivation + label maps; a one-off backfill of rows carrying the old value | One-off backfill script (bounded; flexible-doc update) |
| **Remove** | the enum array; re-point its derivation/labels; backfill existing rows to a replacement value | One-off backfill script |

**The discipline that keeps it cheap:** keep ALL stage knowledge in a few central places — the enum array, the **derivation map** (§6), the **label/display-order map**, and the **terminal set** — and route every status write through the **single status-transition service** (§8). Then a stage change touches 1–3 known files plus tests, never scattered `if (stage === …)` conditionals. Do not hard-code stage names in UI components, routes, or jobs — read them from the central maps.

**Future option (not now):** if you ever want non-engineers to add/reorder stages **without a deploy**, the enum can move from code into a small config record (a `workflow_config` item) the app reads at boot. That's a deliberate later upgrade; for Phase 1, code-defined enums are cheaper to reason about, type-safe, and testable, and a stage edit is a one-line PR + deploy.

## 10. Open questions / not-yet-decided

1. **Founder-pending** case refinements (§3.2) — block finalizing the exact `applied` split and PHA sequence.
2. The **status-transition service** boundary and whether case→entity derivation runs synchronously on a case-stage write or via the event bus (decide in the plan).
3. Migration sequencing for the existing `unit.status` values and any in-flight cases (decide in the plan).
