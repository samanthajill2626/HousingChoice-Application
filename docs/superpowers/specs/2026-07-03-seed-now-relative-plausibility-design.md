# Seed data — now-relative, plausibility-coherent matrix

**Date:** 2026-07-03 · **Status:** design (audit-driven; user-approved direction: now-relative)
**Follows:** the merged clean-slate seed + history work (`app/src/lib/seed/*`). **Fixes:** the
`matrixItems()` generator, whose index-driven, fixed-past field assignment produces internally
contradictory, stale entities. **Grounding:** `.superpowers/sdd/seed-plausibility-findings.md`
(consolidated audit — exact file:line, every violation, correct-by-construction rules).

## 1. Why

A human opened the seeded dashboard and the **first** placement clicked was nonsense: Chloe
Dupont in stage `collect_rta` (RTA phase) with a `tour_reminder` deadline overdue from Jan 10 —
130 days *before* she entered the stage. Two audits confirmed this is systemic: `matrix.ts`
assigns deadline type/date, attention reason, `created_at`, and tour/reminder dates by independent
`counter % N` round-robins over fixed Jan–May 2026 date pools, decoupled from each entity's phase
and lifecycle. Relative to today (2026-07-03) the whole matrix world is also 1–6 months stale, so
every active placement reads as overdue (now amplified by main's new deadline urgency chip).

`live.ts` already models the correct pattern (now-relative, phase-appropriate, coherent). This
change brings that discipline to the whole matrix.

## 2. Decisions

1. **Now-relative (user-approved).** `matrixItems()` takes `now: Date` (as `seedLive` does) and
   derives every date from it. Deterministic given `now`. The FULL profile is not part of the
   byte-stable e2e gate (that's lean), so now-relative output is fine — mirrors `live.ts`.
2. **Coherent by construction.** Field values are derived from the entity's stage/phase and a
   single per-entity clock, not independent round-robins.
3. **`lean` and `live.ts` are untouched.** Lean is the e2e regression gate (byte-identical). Live
   is already correct.
4. **No behavior/schema/route change.** Only the seed generator (+ its tests) changes.

## 3. Placement model (now-relative)

For each matrix placement in stage `S` (phase `P`):
- `stage_entered_at = now − daysInStage(S)` — a small, plausible time in the current stage.
- `created_at = stage_entered_at − Σ STAGE_STUCK_THRESHOLDS(prior stages)` — a realistic backdated
  journey. Only `send_application` keeps `created_at == stage_entered_at`.
- `next_deadline_type` ∈ the **phase-appropriate set** (spec table in findings §A). **Never
  `tour_reminder` on a placement.** `rta_window` only in the RTA phase.
- `next_deadline_at`:
  - `rta_window` → `stage_entered_at + 48h`
  - `stuck_placement` → `stage_entered_at + STAGE_STUCK_THRESHOLDS[S]`
  - `follow_up` → `stage_entered_at + ~2–3d`
  - `voucher_expiration` → a future date (weeks out)
  - **Invariant `next_deadline_at ≥ stage_entered_at`.**
  - The **`attention`-flagged placements** get a deadline a few days *past now* (genuinely
    overdue → needs_you_now / follow_ups coverage); others land upcoming. This preserves the
    coverage goal of populating attention/overdue states, but realistically (days, not months).
- `attention.reason` from a **phase-scoped** reason set (findings §A5).
- `moved_in`: derive `lease_date`/`move_in_date`/tenant `move_in_date`/`consent_at` from
  `created_at` with `created_at ≤ lease_date ≤ move_in_date ≤ now`.
- Linked tenant/unit statuses stay `deriveStatuses(stage)` (already correct); their date anchors
  (`consent_at`, `created_at`) follow the placement clock.

Coverage preserved: every stage ×2, every deadline TYPE (matrix covers the phase-valid ones;
`tour_reminder` covered by lean's pinned placement — findings "Coverage note").

## 4. Tour model (now-relative)

- `requested`: timeless, no `scheduledAt`, zero reminders (invariant — unchanged).
- `scheduled` / `confirmed` (**upcoming**): `scheduledAt = now + Ndays`; `createdAt = now − few
  days`; `confirmation` reminder terminal (sent at createdAt); `day_before` reminder **pending**
  with `dueAt = scheduledAt − 24h` (≥ now → **no live-fire**).
- `toured` / `no_show` / `canceled` / `closed` (**recent past**): `scheduledAt = now − Ndays`; all
  reminders terminal (`sentAt` or `canceledAt`); `day_before.dueAt = scheduledAt − 24h` (sent);
  `no_show_checkin.dueAt = scheduledAt + 30m` (sent); `canceled`: `createdAt ≤ canceledAt ≤
  scheduledAt`.
- Per-tour timeline computed by real date arithmetic from one base instant — **no
  `pastDate(counter±N)` index reuse** (kills the wraparound: no_show-02, canceled-01).
- `convertible`: one representation applied consistently to `toured` and `closed` (match what the
  UI/conversion code reads — verify `toursModel.ts`).
- Invariants asserted by tests: `requested` ⇒ 0 reminders; **no pending reminder with `dueAt <
  now`**; per reminder `createdAt ≤ dueAt ≤ (sentAt ?? canceledAt)`; `createdAt ≤ scheduledAt`.

## 5. Interaction with merged history.ts

`history.ts` walks backward from each entity's `stage_entered_at`; making that now-relative makes
the audit trails + activity milestones now-relative automatically (no history.ts change). Its
entity-scoped dedupe already supersedes matrix's audit/activity rows. Post-fix VERIFY: a
placement's History panel, Property Activity card, and Contact Timeline read as one coherent
now-relative story.

## 6. Tests

- Placement coherence (per matrix placement): `next_deadline_at ≥ stage_entered_at`;
  `next_deadline_type` ∈ phase-valid set and **never `tour_reminder`**; `created_at ≤
  stage_entered_at` (`<` for non-first stage); moved_in ordering; attention reason ∈ phase set.
- Tour/reminder coherence: the §4 invariants, especially **no pending reminder with `dueAt < now`**
  (the live-fire regression) and `createdAt ≤ scheduledAt` (the wraparound regression).
- Coverage retained: every stage/status ×2; deadline-type coverage (via matrix + lean).
- **Lean untouched:** existing lean/`seedData.test.ts` contract green UNCHANGED.
- Determinism: `matrixItems(now)` given a fixed `now` produces identical output twice.
- Full gates: typecheck, app suite, dashboard, **e2e full** (lean-regression proof), and **I
  (orchestrator) verify the seeded UI myself** — boot `--seeded`, click the previously-broken
  surfaces, confirm deadlines/tours read sensibly.

## 7. Out of scope

- `lean` / `live.ts` changes; any route/schema/worker behavior change.
- Relay `groupThreadId` back-ref on matrix tours (optional; note only).
- Reworking broadcasts/invoices/listing_sends (audit found them coherent).
