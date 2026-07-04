<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Implementation plan — Placement deadline model refactor

- **Status:** DRAFT — for review (2026-07-03)
- **Spec (authoritative):** [docs/superpowers/specs/2026-07-03-placement-deadline-model-design.md](../specs/2026-07-03-placement-deadline-model-design.md)
- **Base:** `main` @ 988473e. Line numbers verified against the current tree.
- **Resolves:** [docs/issues/case-single-next-deadline-slot.md](../../issues/case-single-next-deadline-slot.md)

The refactor: promote placement deadlines to a first-class `placementDeadlines` table (one item per `(placement, type)`, deterministic id, fixed-partition `byDueAt` GSI); retire the overloaded single `next_deadline` slot + `byNextDeadline` GSI; derive the internal stuck **flag** from time-in-stage; materialize `voucher_expiration` from a new staff-set contact field; retire `tour_reminder`; keep `follow_up`; rename internal "stuck nudge" → "stuck flag" (leave external `placementNudges` alone).

## Wire-shape decision (drives dashboard scope)

The dashboard consumes **flat** `next_deadline_type` + `next_deadline_at` on `PlacementItem` (`types.ts:599-601`, `DeadlineChip.tsx:13`, `buildToday.ts:173,193`) and on `PlacementUpdatedEvent` (`events.ts:149-150`, `types.ts:739-740`). **Keep the flat shape; only move the source from a stored field to a computed one** (soonest of a placement's deadline items). This makes Phase C a label/enum-only diff. No nested `next_deadline` object.

## Phase graph

```
Phase 0  Foundation (BLOCKING)
    │
    ├── Phase A  transition + today + placement serializer + events
    ├── Phase B  contact voucher field + inline sync         (∥ A)
    ├── Phase C  dashboard (shape-preserving)                 (∥ once wire-shape confirmed — it is)
    └── Phase D  seeds                                        (∥, needs 0)
                 │
                 └── Phase E  e2e + docs (after A–D)
```
Phase 0 must land (in the shared worktree) before A/B/C/D: they import the narrowed `PlacementDeadlineType` union and the new repo type. A/B are disjoint except the create-path voucher arm (owned by A). C/D start once the flat wire-shape is confirmed (done here).

---

## Phase 0 — table + repo + narrowed types (BLOCKING)

**`app/src/lib/tables.ts`**
- **Add** `placementDeadlines` after the `placementNudges` entry (~L373), cloning the `placementNudges`/`tours` `byDueAt` shape:
  ```ts
  {
    baseName: 'placementDeadlines',
    hashKey: { name: 'deadlineId', type: 'S' },      // `${placementId}#${type}`
    gsis: [
      { indexName: 'byPlacement', hashKey: { name: 'placementId', type: 'S' } },
      { indexName: 'byDueAt',
        hashKey: { name: '_deadlinePartition', type: 'S' },   // fixed 'deadlines'
        rangeKey: { name: 'at', type: 'S' } },
    ],
  },
  ```
- **Remove** the `byNextDeadline` GSI (L182-189) from the `placements` entry; keep `byTenant`/`byUnit`/`byStage`/`byTourDate`. Scrub the `byNextDeadline`/`next_deadline_*` header comments (L30-34).
- **Regenerate tfvars:** `npm run gen:tables` → rewrites `infra/envs/{dev,prod}/tables.auto.tfvars.json`. Commit both with `tables.ts`. `npm run plan`'s `gen-tables --check` fails if stale.

**New `app/src/repos/placementDeadlinesRepo.ts`** (factory shape identical to `placementNudgesRepo`):
```ts
export interface PlacementDeadlineItem {
  deadlineId: string;              // PK `${placementId}#${type}`
  placementId: string;             // byPlacement hash
  type: PlacementDeadlineType;     // import narrowed union from placementsRepo
  at: string;                      // ISO 8601, byDueAt range
  _deadlinePartition: 'deadlines'; // byDueAt hash (fixed)
  createdAt: string; updatedAt: string;
  [key: string]: unknown;
}
```
| Method | Access |
|---|---|
| `arm(placementId, type, at)` | `PutCommand` (idempotent upsert, **no** condition) |
| `retire(placementId, type)` | `DeleteCommand` by `deadlineId` (no-op if absent) |
| `listByPlacement(placementId)` | Query `byPlacement` `#p = :p` |
| `clearForPlacement(placementId)` | `listByPlacement` → `Promise.allSettled(Delete…)` (mirror `cancelForPlacement`) |
| `listDue(now, opts?)` | Query `byDueAt` `#dp = :dp AND #at <= :now`, `ScanIndexForward:true`, paginate |
| `listAllPending(opts?)` | Query `byDueAt` `#dp = :dp` only, paginate |

Add a shared pure helper `soonestDeadline(items): {type; at} | null` (min by `Date.parse(at)`, tie-break by type for determinism) — co-locate here or in a small `deadlineCompute.ts`.

**`app/src/repos/placementsRepo.ts`**
- Shrink `PLACEMENT_DEADLINE_TYPES` → `['rta_window','voucher_expiration','follow_up']`; keep `isPlacementDeadlineType`.
- **Delete** `setNextDeadline`, `listByNextDeadline`, `ListByNextDeadlineOpts`, `PlacementDeadline`, the `update`-guard throw (L319-325), and the `next_deadline_type`/`next_deadline_at` item fields.

**Acceptance:** `npm run gen:tables --check` clean; `tables.test.ts` + `genTables.test.ts` updated (has `placementDeadlines`, no `placements.byNextDeadline`); app `npm run typecheck` (downstream breaks expected, fixed in A/B).

---

## Phase A — transition service, Today, placement serializer, events

**`app/src/services/statusTransition.ts`**
- Add dep `placementDeadlinesRepo` to `StatusTransitionDeps` (+ destructure); inject at every constructor site.
- **Delete** `HARD_CLOCK_DEADLINE_TYPES` (L39-44) and the entire `scheduleStuckNudge` (L244-269).
- **Replace** step-6 (L368-408) with independent item calls — no pre-clear dance:
  ```ts
  if (TERMINAL_STAGES.has(toStage)) {
    await placementDeadlinesRepo.clearForPlacement(placementId);   // replaces terminal-clear
  } else if (toStage === 'awaiting_landlord_submission') {
    await placementDeadlinesRepo.arm(placementId, 'rta_window',
      new Date(Date.parse(now) + RTA_WINDOW_MS).toISOString());
  } else if (from === 'awaiting_landlord_submission') {
    await placementDeadlinesRepo.retire(placementId, 'rta_window');
  }
  // stuck is DERIVED in today.ts — nothing armed here
  ```
- Emit (L433): compute soonest and attach — `const ds = await placementDeadlinesRepo.listByPlacement(placementId); events.emit('placement.updated', toPlacementUpdatedEvent(final, soonestDeadline(ds)))`.

**`app/src/lib/events.ts`** — `toPlacementUpdatedEvent(item, next?: {type;at}|null)`; keep flat wire fields but source from `next`: `next_deadline_type: next?.type ?? null`, `next_deadline_at: next?.at ?? null`.

**`app/src/routes/placements.ts`**
- Add deps `placementDeadlinesRepo` (+ `contactsRepo` already present).
- **List** serializer (`GET /` L428-431): one `listAllPending()` → `Map<placementId, soonest>` → map items to `{ ...p, next_deadline_type, next_deadline_at }`.
- **Detail** (`GET /:id` L661): `listByPlacement(id)` → soonest → attach.
- **Create voucher arm** (both `POST /` ~L466 and `POST /from-tour` ~L595): read tenant contact `voucher_expiration_date`; if present `arm(created.placementId,'voucher_expiration',date)` (best-effort); compute soonest for the emit.
- **Manual deadline route** `POST /:id/deadline`: `validateDeadline` restricted to `follow_up` (+`{clear:true}`); route calls `arm`/`retire`, not `setNextDeadline`.
- **Retire** the `?deadlineType=`/`?before=` filter branch (L386-407) — no consumer.

**`app/src/routes/today.ts`**
- Add dep `placementDeadlinesRepo`.
- Replace the two per-type `listByNextDeadline` loops (L301-324, L400-423) with **one** `listDue(nowIso, {limit: GROUP_FETCH_LIMIT})`; for each due item join its placement (new bounded `getPlacement` cache), skip `TERMINAL_STAGES` + deleted contacts, bucket: `rta_window`/`voucher_expiration` → `needs_you_now`, `follow_up` → `follow_ups`. Urgency reads `d.at`.
- **`deriveStuckFlags`:** fold into the existing `byStage` attention scan (L337-369) — for each active placement, if `stage_entered_at` + `STAGE_STUCK_THRESHOLDS[stage]` (import from `statusModel`) is past `now`, push a `follow_ups` row (`why:'Stuck — needs a check'`).
- `DEADLINE_WHY` → 3 live types only; delete `HARD_CLOCK_DEADLINE_TYPES`/`FOLLOW_UP_DEADLINE_TYPES` arrays.
- **Dedup per-group** (not cross-group): a placement MAY now appear in `needs_you_now` AND `follow_ups` — the intended fix. Keep `tours_today`/unreplied unchanged.

**Acceptance:** `statusTransition.test.ts`, `todayApi.test.ts`, `placementsApi.test.ts`, `placementsRepo.test.ts` green + new invariant tests (Phase E list).

---

## Phase B — contact `voucher_expiration_date` field + inline sync

**Voucher arming model (read this — it disambiguates "arm"/"transition"):** "arming" a voucher deadline just means **writing the `placementDeadlines` row** (an idempotent upsert on the deterministic `${placementId}#voucher_expiration` id). There are exactly **two** triggers that write/rewrite it, and **neither is a placement stage transition**:

| Event | Voucher row action |
|---|---|
| Placement **created** | If the tenant contact has `voucher_expiration_date`, `arm` the row. |
| Contact's `voucher_expiration_date` **edited** | Re-arm (upsert) / retire on the tenant's **active** placements — the inline sync below. |
| Placement changes **stage** | **Nothing** — the voucher date didn't change, so no re-read/re-arm. |

The contact edit **is** a re-arm; we deliberately do *not* additionally re-arm on every stage transition (redundant write amplification for a value that only changes on the two events above). Terminal close clears it via `clearForPlacement`.

**`app/src/repos/contactsRepo.ts`** — typed optional `voucher_expiration_date?: string` beside `consent_at` (L144). No logic change.

**`app/src/routes/contacts.ts`**
- Allowlist in **both** parsers (`parseTriageBody` ~L471, `parseCreateBody` ~L650), canonicalizing like placements (`Number.isNaN(Date.parse(v))` → 400 else `new Date(v).toISOString()`; `''`/`null` → clear). Not type-gated.
- **Inline sync** in the PATCH handler after `contacts.update` (~L1137), best-effort (never fail the PATCH): when `voucher_expiration_date` changed, page `placements.listByTenant(contactId)`, and per non-terminal placement `arm`/`retire('voucher_expiration')`; emit `placement.updated` (recomputed soonest) per touched placement. `log.warn` on failure.
- New deps on `ContactsRouterDeps`: `placementsRepo`, `placementDeadlinesRepo`, `events`.

**Acceptance:** new contact-voucher unit tests + sync-block tests.

---

## Phase C — dashboard (shape-preserving)

- `dashboard/src/api/types.ts` — add `voucher_expiration_date?` to `Contact`/`ContactPatch`/`ContactCreate`; shrink `PlacementDeadlineType` union (drop `tour_reminder`/`stuck_placement`); **keep** flat `next_deadline_*` (now computed server-side).
- `routes/today/buildToday.ts` — drop `stuck_placement`/`tour_reminder`; mirror derived-stuck grouping; label `'Stuck — needs a nudge'` → `'Stuck — needs a check'`.
- `routes/placements/{placementsFormat.ts, DeadlineChip.tsx, PlacementDetail.tsx, usePlacements.ts}` — drop retired labels; consume computed flat `next_deadline_*` (unchanged shape).
- `routes/contact/{ContactEditForm.tsx, ContactCreateForm.tsx}` — `type="date"` input gated by existing `isTenant`; submit converts `YYYY-MM-DD`→ISO via `consentAtFromDate()` (`consentCopy.ts:69-74`); empty → `null`.
- `routes/contact/EligibilityIntakeCard.tsx` — `voucher_expiration_date` prop + "Voucher expires" `KV` row; widen the `Pick<Contact,…>`.

**Acceptance:** dashboard `npm test` incl. `buildToday.test.ts`, `useToday.test.tsx`, `PlacementDetail.test.tsx`, `usePlacements.test.tsx`, `ContactEditForm.test.tsx`, `EligibilityIntakeCard.test.tsx`.

---

## Phase D — seeds

- `lean.ts:214-215` — remove the raw `tour_reminder` slot write (retired). **Lean byte-stability gate:** `npm run e2e:reseed` item count unchanged except the intended delta (lean is the regression pin).
- `live.ts:346-347/359-360` — after the placement Put, `arm(id,'rta_window',overdueAt)` / `arm(id,'follow_up',followUpAt)` via the repo; keep `stage_entered_at`; optionally seed one placement with an OLD `stage_entered_at` to exercise `deriveStuckFlags`.
- `matrix.ts:117` `DEADLINE_TYPES` → 3 live types; `:216-217` write items via the repo; add `voucher_expiration_date` on some tenant contacts to cover the sync.
- `app/scripts/db-seed.ts` — construct/inject the new repo where repos are wired.

**Acceptance:** `seedMatrix.test.ts`, `seedLive.test.ts`; lean byte-stability.

---

## Phase E — e2e + docs

- `e2e/scenarios/steps.ts` — `expectRtaClockArmed` (2030-2041) still valid (flat wire preserved). `expectRtaClockCleared` (2050-2063): after leaving the stage, assert `next_deadline_type` null/absent (stuck is derived, not a deadline) AND the stuck row appears in Today `follow_ups`. `devBlowRtaWindow` (2077-2079): repoint off the manual `/deadline` route (now `follow_up`-only) to seed/overwrite the `rta_window` item directly via a dev seam (risk H-7).
- `e2e/tests/scenarios/post-tour-application.spec.ts:167-234` — update assertions/comments: leaving retires `rta_window` (no `stuck_placement` deadline); stuck shows via derivation.
- **New e2e:** set tenant voucher date via the staff contact form → surfaces in `needs_you_now`; advance into `awaiting_landlord_submission` → sooner `rta_window` shows; clear it → voucher re-surfaces; a stuck placement shows in `follow_ups` regardless of a pending hard clock.
- Docs: `GLOSSARY.md` (add **flag** internal-derived vs **nudge** external-SMS row); `STATUS-MODEL.md` §8 (deadline-slot prose → first-class items); `docs/issues/case-single-next-deadline-slot.md` → mark resolved.

**Acceptance:** `npm run e2e` on a **fresh** stack (`e2e:stop` first — GSI change means lane tables must recreate, else spurious GSI-missing failures; see stale-lane-schema footgun).

---

## New invariant tests (Phase A/E)
1. **Soonest-wins** — two items → serializer + Today pick soonest; retire it → next surfaces; retire all → `next_deadline_type` null.
2. **Independent arm/retire** — arming `voucher_expiration` leaves a pending `rta_window` intact; re-arm same type upserts (single row).
3. **Clear-on-terminal** — `moved_in`/`lost` → `clearForPlacement` empties items; placement leaves every Today group.
4. **Derived-stuck coexists with hard clock** — placement past threshold AND with due `rta_window` appears in **both** groups; no-deadline stale placement appears only in `follow_ups`.
5. **Voucher sync** — contact date set → item armed on active placements (create + edit); cleared → retired on active only (terminal untouched).

## Migration / deploy (post-merge ops — Cameron runs; builders do NOT)
- **No data migration.** Old `next_deadline_*` attributes on any existing dev rows simply go unread (flexible doc); nothing to backfill or transform. Dev has no legacy prod placement data; status-model backfill was WAIVED. So this is a plain infra receipt, not a migration procedure.
- `tables.ts` diff = one add + one GSI removal → regenerated tfvars.
- **Receipt (Cameron executes post-merge):** dev `terraform apply` (create `placementDeadlines`; drop `placements.byNextDeadline` — a safe table update, base data untouched), then a dev reseed to populate the new items. **prod rides M1.11.** Recorded in RUNBOOK "post-merge ops" as *what's needed*, not as permission.

## Risk register (mitigations baked into the phases)
1. **Straggler items on terminal placements** → `clearForPlacement` on terminal + read-time `TERMINAL_STAGES` skip (belt-and-suspenders). Test #3.
2. **Deterministic-id upsert** → type is in the key; double-arm idempotent. Test #2.
3. **List-view join cost — negligible, noted only for the record.** The placements list adds exactly **one** `listAllPending()` query per render (not one per placement) → in-memory `placementId → soonest` map. The Today `needs_you_now` path adds one `listDue()` query plus a bounded set of cheap cached placement point-reads. Trivial at our scale (hundreds of small items, single-hot-partition precedent from `placementNudges`/`tours`). Escalation path if we ever hit 10k+ placements: shard the partition or write-through a display cache — out of scope now.
4. **SSE freshness** → every arm/retire path (transition, create arm, contact-edit sync, manual route) must emit `placement.updated` with recomputed soonest. Adversarial-review checklist.
5. **Voucher edit-sync failure** → best-effort + `log.warn`; create-path arm covers the common case; note in issue registry.
6. **`deriveStuckFlags` needs `stage_entered_at`** → create paths stamp it; seeds must set it.
7. **`devBlowRtaWindow` used the manual route** → repoint to a dev seed seam.
8. **Cross-group double-appearance** is deliberate (the fix) → assert in test #4, call out in PR.

## Rename checklist (leave external `placementNudges` alone)
`scheduleStuckNudge` deleted (→ `clearForPlacement` + `deriveStuckFlags`); `buildToday.ts:52` label; "stuck nudge"/"HARD_CLOCK slot" comments; GLOSSARY flag-vs-nudge row; STATUS-MODEL §8. **Untouched:** `placementNudges`, `placementNudgesRepo`, `armStageNudge`, `NUDGE_RUNGS`, `jobs/placementNudges.ts`.
