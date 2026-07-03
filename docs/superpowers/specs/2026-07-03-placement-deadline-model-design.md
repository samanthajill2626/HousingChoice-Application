# Placement deadline model: first-class deadline items + derived stuck flag

- **Status:** DRAFT — for review (2026-07-03)
- **Area:** app (status model / placements / Today queue) + dashboard + infra (new table, retire a GSI)
- **Resolves:** [docs/issues/case-single-next-deadline-slot.md](../../issues/case-single-next-deadline-slot.md)
- **Related:** [docs/issues/stuck-case-thresholds-need-tuning.md](../../issues/stuck-case-thresholds-need-tuning.md), [documentation/STATUS-MODEL.md](../../../documentation/STATUS-MODEL.md) §8, [documentation/GLOSSARY.md](../../../documentation/GLOSSARY.md)
- **Author:** Claude (orchestrator), from Cameron's direction

---

## 1. Problem

A placement carries exactly **one** `next_deadline` slot (`next_deadline_type` + `next_deadline_at`, a sparse composite `byNextDeadline` GSI key, written both‑or‑neither via `placementsRepo.setNextDeadline`). That single slot is **overloaded** to mean two different things:

1. **A real due‑date** — a hard clock where something must actually be done by an instant: `rta_window` (landlord submits the RTA within 48h), `voucher_expiration` (the tenant's voucher expires), `follow_up` (a staff member set a "come back to this by X" reminder).
2. **A "resurface this placement" hook** — the internal **stuck flag** (`stuck_placement`) piggybacks on the same slot purely because the `byNextDeadline` GSI is the only rail that lands a placement in the Today queue.

Because there is only one slot, the transition service refs a collision: `scheduleStuckNudge` **defers** the stuck flag whenever a hard clock holds the slot ([statusTransition.ts:244‑269](../../../app/src/services/statusTransition.ts#L244-L269)), and the `rta_window` setter needs a bespoke direct‑write + stage‑scoped pre‑clear ([:368‑408](../../../app/src/services/statusTransition.ts#L368-L408)) to dodge the same clobber. A placement that is *both* on a hard clock *and* going stale never surfaces as stuck until the clock clears — the accepted‑but‑wrong Phase‑1 contention in [case-single-next-deadline-slot.md](../../issues/case-single-next-deadline-slot.md).

**The conceptual bug:** a stuck flag is an *internal* "we should check on this" signal — not a deadline. It only lives in the deadline slot because reusing the GSI was cheap. Deadlines and the stuck flag are different concerns and must stop competing for one slot; and a placement should be able to track **several** real deadlines at once, surfacing whichever is soonest.

### Vocabulary (locked — see [GLOSSARY.md](../../../documentation/GLOSSARY.md))

| Term | Audience | Meaning | Mechanism |
|---|---|---|---|
| **Deadline** | — | A real due‑date: something must be done by an instant. | First‑class `placementDeadlines` items (§3). |
| **Flag** | Staff (internal) | "This placement has gone quiet — *we* should look at it." | Derived from time‑in‑stage (§5). |
| **Nudge** | External (tenant/landlord) | An SMS to get *them* to act (submit RTA, complete inspection). | `placementNudges` ladder — **already separate, untouched** (§7). |

**Naming consequence (this change):** the internal path currently misuses "nudge" (`scheduleStuckNudge`, "stuck nudge" comments, the dashboard `"Stuck — needs a nudge"` label). Rename the **internal** case to **flag** (§8). The **external** `placementNudges`/`armStageNudge`/`NUDGE_RUNGS` system keeps "nudge" — that is the correct usage.

## 2. Goals / non‑goals

**Goals**

- Promote deadlines to a **first‑class `placementDeadlines` table** (one item per `(placement, type)`), queryable via a fixed‑partition **`byDueAt`** GSI so the Today queue fetches all due deadlines in **one query** and picks each placement's soonest in memory.
- **Retire the overloaded single slot** — drop `placementsRepo.setNextDeadline`, the `next_deadline_type`/`next_deadline_at` fields as a stored slot, and the `byNextDeadline` GSI.
- Move the internal **stuck flag out of deadlines** and **derive** it from time‑in‑stage, so flags and deadlines never suppress each other.
- Wire the first tenant‑level hard clock: **`voucher_expiration`**, materialized from a new staff‑set contact field `voucher_expiration_date` (ISO) and kept in sync on edit.
- **Retire `tour_reminder`** as a placement deadline (tours are first‑class); **keep `follow_up`** as a manual staff deadline.
- **Rename** internal "stuck nudge" → "stuck flag" throughout (leave external `placementNudges` alone).

**Non‑goals**

- Do **not** touch the external `placementNudges` SMS ladder (provably independent — §7).
- No change to `STAGE_STUCK_THRESHOLDS` values.
- No public/tenant intake for the voucher date — staff forms only.
- No voice/masked‑calling changes.

## 3. Core design — the `placementDeadlines` table

### 3.1 Table shape (mirrors `placementNudges` / `tours`)

A new table defined in [tables.ts](../../../app/src/lib/tables.ts) (terraform is generated from it), cloning the proven fixed‑partition `byDueAt` shape:

```
placementDeadlines
  item:   { deadlineId, placementId, type, at /*ISO*/, _deadlinePartition }
  hashKey: deadlineId          // DETERMINISTIC: `${placementId}#${type}`
  GSIs:
    byPlacement  (hash placementId)                 // all deadlines for a placement (display, terminal clear)
    byDueAt      (hash _deadlinePartition, range at) // all due deadlines, one query, sorted by urgency
```

**Deterministic `deadlineId = ${placementId}#${type}`** means a placement has **at most one deadline per type**, arming is an idempotent upsert (a `PutItem` overwrites), and retiring is a `DeleteItem` by key — no duplicates, no read‑before‑write to find the row. `_deadlinePartition` is a constant string (single hot partition is fine at our scale, exactly like `placementNudges.byDueAt` and `tours.byDueAt`). The item deliberately does **not** denormalize `stage`/`tenantId` — readers join to the placement (which Today already loads), so a stage change never has to rewrite deadline rows.

### 3.2 Repo — `placementDeadlinesRepo`

```ts
arm(placementId, type, at): Promise<PlacementDeadlineItem>   // idempotent upsert by (placementId,type)
retire(placementId, type): Promise<void>                      // delete by (placementId,type)
listByPlacement(placementId): Promise<PlacementDeadlineItem[]>
clearForPlacement(placementId): Promise<void>                 // delete all (terminal close)
listDue(now, opts?): Promise<PlacementDeadlineItem[]>         // byDueAt where at <= now, soonest-first
listAllPending(opts?): Promise<PlacementDeadlineItem[]>       // byDueAt full scan of the partition (for card display join)
```

### 3.3 Reads — one query for Today, computed attach for cards

- **Today queue** ([today.ts](../../../app/src/routes/today.ts)): `listDue(now)` returns every due deadline across all placements in one query, soonest‑first. Join each to its placement (skip `TERMINAL_STAGES` — the read‑time guard that also neutralizes any straggler row), then bucket by type: `rta_window`/`voucher_expiration` → **needs_you_now**; `follow_up` → **follow_ups**. Add derived‑stuck rows (§5) to **follow_ups**. Dedup by `placementId` within a group.
- **Placement card / detail display:** the placement serializer computes a `next_deadline: { type, at } | null` = the soonest of that placement's deadline items, at **serialization time** (no stored slot). For the placements **list**, do it with a single `listAllPending()` → `placementId → soonest` map (no per‑row query); for **detail**/SSE, a `listByPlacement(id)`.
- **SSE `placement.updated`:** the event payload attaches the same computed `next_deadline`. After any deadline arm/retire, emit a `placement.updated` for that placement so the dashboard refreshes. (The dashboard keeps consuming a `next_deadline` shape — see §9 — so its card/detail rendering barely changes; only the source moves from a stored field to a computed one.)

### 3.4 What gets retired

- `placementsRepo.setNextDeadline`, the `update`‑guard that forces writes through it, and `listByNextDeadline`.
- The `next_deadline_type` / `next_deadline_at` **stored** fields and the **`byNextDeadline` GSI** (removed from `tables.ts` + generated tfvars → a table update on apply). The API/SSE `next_deadline` shape survives as a **computed** field (§3.3).
- `scheduleStuckNudge` (superseded by `clearForPlacement` on terminal + derived stuck) — see §5, §8.

## 4. Arming / retiring rules per deadline type

| Type | Armed | Retired | Source |
|---|---|---|---|
| `rta_window` | Entering `awaiting_landlord_submission` → `arm(id,'rta_window', stage_entered_at + 48h)` | Leaving the stage → `retire(id,'rta_window')`; terminal → `clearForPlacement` | Stage clock (mirror the merged RTA setter, minus the slot‑clobber workarounds) |
| `voucher_expiration` | Placement create (from tenant contact date) **and** on contact `voucher_expiration_date` edit → upsert on the tenant's active placements | Contact date cleared → `retire` on active placements; terminal → `clearForPlacement` | Tenant contact field (§6); tenant‑level, **not** stage‑scoped |
| `follow_up` | Manual API sets it | Manual API clears it; terminal → `clearForPlacement` | Staff (arbitrary) |
| `stuck_placement` | — (removed) | — | **Derived** from `stage_entered_at` (§5) |
| `tour_reminder` | — (retired) | — | Gone (tours are first‑class) |

Because each type is its own item, arming/retiring one **never** touches another — the old "don't clobber the slot" arbitration is gone entirely.

## 5. The stuck flag — derived, not stored

Remove `stuck_placement` from deadlines. Recompute the "stuck" portion of Today's `follow_ups` from time‑in‑stage, already fully supported:

- `stage_entered_at` is stamped on every stage move ([placementsRepo.ts:140](../../../app/src/repos/placementsRepo.ts#L140); written at [statusTransition.ts:285](../../../app/src/services/statusTransition.ts#L285) and the create paths).
- `STAGE_STUCK_THRESHOLDS` ([statusModel.ts:323‑341](../../../app/src/lib/statusModel.ts#L323-L341)) gives the per‑stage dwell budget.
- The `byStage` GSI already exists and `today.ts` already scans it for its attention group ([today.ts:337‑338](../../../app/src/routes/today.ts#L337-L338)).

**Derivation:** a non‑terminal placement is *stuck* iff `now − Date.parse(stage_entered_at) ≥ STAGE_STUCK_THRESHOLDS[stage]`. A new `deriveStuckFlags` helper builds these rows from `listByStage` + dwell filter. Stuck becomes a pure function of state — no stored artifact to drift, and it **fires regardless of any real deadline** (Cameron's model).

## 6. `voucher_expiration` source field (contact)

Add a staff‑set tenant field `voucher_expiration_date` (ISO‑8601), mirroring the `consent_at` precedent:

- **Repo:** typed optional `string` on `ContactItem` near `consent_at` ([contactsRepo.ts:143‑144](../../../app/src/repos/contactsRepo.ts#L143-L144)) — flexible doc, no repo logic change.
- **Route allowlist (the real gate):** add to `parseTriageBody` (~[contacts.ts:471](../../../app/src/routes/contacts.ts#L471)) and `parseCreateBody` (~[contacts.ts:650](../../../app/src/routes/contacts.ts#L650)). Validate + **canonicalize** with the placements idiom (`Number.isNaN(Date.parse(x))` → 400; else `new Date(x).toISOString()` — [placements.ts:297‑301](../../../app/src/routes/placements.ts#L297-L301)). Not type‑gated (repo convention); tenant‑only stays a UI guarantee.
- **The sync (inline, ~10 lines — NOT a service):** when `parseTriageBody` changes `voucher_expiration_date`, upsert/retire the `voucher_expiration` deadline on the tenant's active (non‑terminal) placements — `placementsRepo.listByTenant(tenantId)` → `arm`/`retire` per placement. Best‑effort after the contact write so a placement hiccup never fails the PATCH. Also arm at placement create.
- **Dashboard:** `voucher_expiration_date?` on `Contact`/`ContactPatch`/`ContactCreate`; a `type="date"` input gated by `isTenant` in `ContactEditForm.tsx` + `ContactCreateForm.tsx` (convert `YYYY‑MM‑DD`→ISO via `consentAtFromDate()` [consentCopy.ts:69‑74](../../../dashboard/src/lib/consentCopy.ts#L69-L74)); a "Voucher expires" row in `EligibilityIntakeCard.tsx`.

Naming: snake_case `voucher_expiration_date` (matches `consent_at`; distinct from deadline **type** `voucher_expiration` and the unrelated camelCase `voucherSize`).

## 7. External nudge ladder — untouched (boundary proof)

The outbound SMS ladder (`jobs/placementNudges.ts` + `placementNudgesRepo`, its own `byDueAt` table) is keyed on `placement.stage`/`dueAt` and **never reads `next_deadline_*`** (grep = zero hits). It is wired only through the best‑effort `armStageNudge` hook at transition step 7. **This spec does not touch it**, and it keeps its (correct) "nudge" naming.

## 8. Rename: internal "nudge" → "flag"

Most of this falls out of the refactor (the stuck‑arming logic is being removed anyway):

- `scheduleStuckNudge` → gone; its terminal‑clear becomes `placementDeadlinesRepo.clearForPlacement`; its stuck‑arming is replaced by `deriveStuckFlags` in `today.ts`.
- Comments/labels: "stuck nudge" → "stuck flag"; dashboard `"Stuck — needs a nudge"` → e.g. `"Stuck — needs a check"`; test descriptions.
- **Leave untouched:** `placementNudges`, `placementNudgesRepo`, `armStageNudge`, `NUDGE_RUNGS`, `jobs/placementNudges.ts` (correct external usage).
- Add a one‑line **flag vs nudge** note to [GLOSSARY.md](../../../documentation/GLOSSARY.md).

## 9. Blast radius (from the three sweeps) — files to change

**Backend**
- **New:** `app/src/repos/placementDeadlinesRepo.ts` (+ `tables.ts` table def + generated tfvars); optional shared `computePlacementDeadline(placement, deadlines)` for the serializer.
- `app/src/lib/tables.ts` — add `placementDeadlines`; **remove** `byNextDeadline` GSI from placements; regenerate tfvars.
- `app/src/repos/placementsRepo.ts` — drop `setNextDeadline` / `listByNextDeadline` / the `update`‑guard / `next_deadline_*` fields; shrink `PLACEMENT_DEADLINE_TYPES` (`{rta_window, voucher_expiration, follow_up}`); the type set moves to the deadlines repo.
- `app/src/services/statusTransition.ts` — delete `scheduleStuckNudge`; on terminal → `clearForPlacement`; rewrite the `rta_window` step‑6 block to `arm`/`retire` items (no pre‑clear dance); arm `voucher_expiration` at the relevant create/transition; drop `HARD_CLOCK_DEADLINE_TYPES` (no longer needed for slot protection).
- `app/src/routes/today.ts` — build `needs_you_now`/`follow_ups` from `listDue` + `deriveStuckFlags`; drop the two `HARD_CLOCK`/`FOLLOW_UP` slot lists; update `DEADLINE_WHY`.
- `app/src/routes/placements.ts` — serializer computes `next_deadline`; create‑path voucher arming; manual deadline route now arms/retires a `follow_up` item (scope: system‑managed `rta_window`/`voucher_expiration` off‑limits to manual set — see §12); update `?deadlineType=` filter (or retire it).
- `app/src/routes/contacts.ts` — allowlist `voucher_expiration_date`; inline voucher sync on change.
- `app/src/lib/events.ts` — `toPlacementUpdatedEvent` attaches computed `next_deadline` instead of copying stored fields.
- Seeds (`lean.ts`/`live.ts`/`matrix.ts`) — emit `placementDeadlines` items instead of `next_deadline_*`; drop `tour_reminder`/`stuck_placement` fixtures (or seed an old `stage_entered_at` for derived‑stuck coverage).

**Dashboard**
- `dashboard/src/api/types.ts` — `voucher_expiration_date` on contact types; shrink `PlacementDeadlineType`; keep the `next_deadline` shape on the placement (now computed server‑side).
- `dashboard/src/routes/today/buildToday.ts` — mirror grouping (drop `stuck_placement`/`tour_reminder`; derived‑stuck; flag rename label).
- `ContactEditForm.tsx` / `ContactCreateForm.tsx` / `EligibilityIntakeCard.tsx` — voucher date input + display.
- `placementsFormat.ts` / `DeadlineChip.tsx` / `PlacementDetail.tsx` / `usePlacements.ts` — drop retired labels; consume computed `next_deadline` (shape unchanged).

## 10. Invariants & tests

**Unit (`app/test`)**
- **Soonest‑wins:** two deadline items on a placement → serializer/Today pick the soonest; retire it → the next surfaces; retire all → `next_deadline` null.
- **Independent arm/retire:** arming `voucher_expiration` never disturbs a pending `rta_window` and vice‑versa; re‑arming a type upserts in place (deterministic id → no duplicate).
- **Clear‑on‑terminal:** move to `moved_in`/`lost` → `clearForPlacement` removes all items; the placement leaves every Today deadline group.
- **Stuck is derived & independent:** a placement on a hard clock that is *also* past its stage threshold appears in `follow_ups` **and** `needs_you_now` (the fix); no‑deadline‑but‑stale still appears in `follow_ups`.
- **`voucher_expiration` sync:** contact with the date set → placement gains the item (create + on edit); date cleared → item retired on active placements only; new voucher test block mirroring the RTA "Task 5" block ([statusTransition.test.ts:704‑915](../../../app/test/statusTransition.test.ts#L704-L915)).
- **Retirements:** `tour_reminder`/`stuck_placement` no longer valid deadline types; `byNextDeadline`/`setNextDeadline` gone (tables + repo tests updated).

**E2E (`e2e`)**
- Walk a placement: set a tenant voucher date via the staff contact form → assert it surfaces in Today `needs_you_now`; advance into `awaiting_landlord_submission` → assert the sooner `rta_window` shows; clear it → assert voucher re‑surfaces; and a stuck placement appears in `follow_ups` regardless of a pending hard clock.

## 11. Deployment notes

- **Infra (post‑merge ops — I will NOT run these; they are triggered explicitly):**
  - `terraform apply` to **dev** to (a) create `placementDeadlines` and (b) drop the `byNextDeadline` GSI from placements (a safe table update; base data untouched). **prod** rides the M1.11 cutover.
  - Re‑seed dev to populate the new `placementDeadlines` items.
- Removing a GSI and stored fields is safe on flexible‑doc items (old `next_deadline_*` attributes on any existing rows simply go unread). Dev has no legacy prod placement data; status‑model backfill was already WAIVED.
- App code + dashboard ship as an ordinary deploy after the dev apply.

## 12. Open decisions for the architect / reviewer

1. **Card/SSE deadline source** — compute `next_deadline` at serialization time (recommended, no drift) vs a write‑through display cache on the placement. Recommend computed; adversarial review should confirm the list‑view join (`listAllPending` → map) is cheap enough.
2. **Manual deadline API scope** — restrict `POST /placements/:id/deadline` to `follow_up` only (system‑managed `rta_window`/`voucher_expiration` off‑limits to manual set) vs allow all. Recommend `follow_up`‑only.
3. **`?deadlineType=` filter** — re‑implement over `placementDeadlines` vs retire it. Recommend retire unless a consumer needs it (sweep found none).
4. **`_deadlinePartition` hot‑partition** — constant single partition (matches `placementNudges`/`tours`; fine at our scale) vs shard. Recommend constant, consistent with precedent.
5. **`voucher_expiration` arming trigger set** — create + contact‑edit sync (recommended) vs also re‑arm on each transition (belt‑and‑suspenders, more writes). Recommend create + edit‑sync only.
