# Seed now-relative plausibility — implementation plan

Executes `docs/superpowers/specs/2026-07-03-seed-now-relative-plausibility-design.md` (source of
truth). Grounding: `.superpowers/sdd/seed-plausibility-findings.md` (every violation + rules).

## Global Constraints (bind every task)
- **`lean.ts` and `live.ts` are UNTOUCHABLE.** Lean is the e2e byte-stable regression gate; live is
  already correct. Only `matrix.ts` (+ its tests, + the `matrixItems` call site in `index.ts` to
  thread `now`) changes.
- **Now-relative + deterministic:** `matrixItems(now: Date)` derives every date from `now`; given a
  fixed `now`, output is identical across runs. No `Math.random()`. Mirror `live.ts`'s pattern.
- **Import the model, never hardcode:** `PLACEMENT_STAGES`, `STAGE_PHASE`, `STAGE_STUCK_THRESHOLDS`,
  `deriveStatuses`, `TENANT/LANDLORD/LISTING/TOUR_STATUSES`.
- **Coherence invariants (assert in tests):** `next_deadline_at ≥ stage_entered_at`; deadline type
  ∈ phase-valid set and NEVER `tour_reminder` on a placement; `created_at ≤ stage_entered_at`;
  moved_in `created_at ≤ lease_date ≤ move_in_date ≤ now`; tours `createdAt ≤ scheduledAt`; per
  reminder `createdAt ≤ dueAt ≤ (sentAt ?? canceledAt)`; **no pending reminder with `dueAt < now`**;
  `requested` ⇒ 0 reminders.
- **Coverage preserved:** every stage/status ×2; deadline-type coverage retained (matrix covers
  phase-valid types; `tour_reminder` stays covered by lean's pinned placement — update any coverage
  test that assumed the matrix supplies `tour_reminder`).
- **Interaction with merged history.ts:** do NOT edit `history.ts`; it follows `stage_entered_at`.
  Verify coherence in Task 3.
- Verify with REAL exit codes (write to file + `echo EXIT=$?`; never pipe through tail). Stage
  EXPLICIT paths; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  NEVER deploy/terraform/secrets/.env/.docx. Do NOT merge.

---

## Task 1: Now-relative threading + coherent PLACEMENTS (deadlines, dates, attention, moved_in)

**Files:** `app/src/lib/seed/matrix.ts` (add now-relative date helpers; change `matrixItems()` →
`matrixItems(now: Date)`; rewrite `buildPlacementsMatrix` + the deadline/attention/date helpers),
`app/src/lib/seed/index.ts` (pass the seed clock to `matrixItems` in the full branch — mirror how
`seedLive(endpoint, now)` is called). Tests: new `app/test/seedMatrixCoherence.test.ts`.

Read findings §"Key dates", §A (all), the deadline-type-by-phase table, §"Correct-by-construction
rules", §Interaction; `live.ts` (how it takes/uses `now`); `index.ts` `seedAll` (full-profile
assembly + `seedLive` call). Build a small deterministic date toolkit on `now` (`daysAgo`,
`daysFromNow`, `hoursFromNow`, `journeyStart(now, stage)` = subtract `Σ STAGE_STUCK_THRESHOLDS(prior
stages)`) and **consume it immediately** in the placements rewrite (no unused helpers). Then per
spec §3:
- Phase→valid-deadline-type mapping (`Record<PlacementPhase, DeadlineType[]>` so a new phase is a
  typecheck concern); pick a deterministic type per placement from its phase's set; **drop
  `tour_reminder` entirely from placement selection.**
- `stage_entered_at = now − daysInStage(stage)`; `created_at = journeyStart(now, stage)`; deadline
  date per type (rta_window +48h, stuck +threshold, follow_up +~2-3d, voucher future);
  attention-flagged placements → deadline a few days PAST now (overdue); others upcoming.
- Phase-scoped attention reasons; moved_in/lost coherent recent-past ordering (incl. the linked
  tenant's `move_in_date`/`consent_at`). Keep `deriveStatuses` statuses + rent/voucher fields as-is.
- Leave `buildToursMatrix` using its existing `pastDate` for now (Task 2 rewrites it) — the seed
  must still build/seed without error after this task.

**Tests (the point):** determinism (`matrixItems(fixedNow)` deep-equals a second call); every
matrix placement satisfies the coherence invariants (deadline type ∈ phase set, never
tour_reminder; `next_deadline_at ≥ stage_entered_at`; `created_at ≤ stage_entered_at`, strict for
non-first stage; moved_in ordering; attention reason ∈ phase set); every stage still ×2; each
phase-valid deadline type still appears; assert the previously-broken cases now pass (a
`collect_rta` placement has an RTA-valid, correctly-dated deadline; NO placement has
`tour_reminder`).

Verify: typecheck; `npm test -w app`; scripted `seedAll(_,'full')` against DynamoDB Local → read a
`collect_rta` placement back and confirm a sane deadline.

---

## Task 2: Coherent now-relative TOURS + reminders; history coherence check; full gates

**Files:** `app/src/lib/seed/matrix.ts` (`buildToursMatrix`); tests in the coherence test file.
Read findings §B (all) + spec §4–5; `toursModel.ts` (convertible semantics); `tourReminders.ts`
(`computeDueAt`/kinds); `tourRemindersRepo.ts:113-147` (`listDue` — the live-fire mechanism);
`today.ts` (tours_today window).

Implement per spec §4:
- `requested` unchanged (timeless, 0 reminders).
- `scheduled`/`confirmed` → upcoming (`scheduledAt = now + Ndays`); `day_before` **pending** with
  `dueAt = scheduledAt − 24h` (≥ now); `confirmation` sent.
- `toured`/`no_show`/`canceled`/`closed` → recent past; all reminders terminal; dates derived from
  `scheduledAt` by real arithmetic (no `pastDate(counter±N)` — kills wraparound); `no_show_checkin`
  = scheduledAt+30m sent; `canceled` canceledAt between createdAt and scheduledAt.
- Unify `convertible` across toured/closed to match what the UI/conversion reads.

**Tests:** the §4 invariants — especially **NO pending reminder has `dueAt < now`** (the live-fire
regression) and `createdAt ≤ scheduledAt` (wraparound regression); `requested` ⇒ 0 reminders;
every tour status ×2.

**History coherence check (no history.ts edit):** add a test (or extend one) seeding the full
profile and asserting a sample placement's generated `placements#<id>` history trail + its tenant
timeline are now-relative and consistent with the placement's now-relative `stage_entered_at`
(final hop == stage_entered_at, all hops < now).

**Full gates (REAL exit codes):** typecheck; `npm test -w app`; `npm test -w dashboard` (untouched
— confirm); e2e FULL (`npm run db:start && npm run s3:start`, then `npm run e2e:stop` then
`npm run e2e`) — green = the lean-regression proof (matrix is full-only; e2e seeds lean).

---

## Task 3: Final review + orchestrator UI verification

Whole-branch adversarial review (coherence invariants hold; lean/live untouched; determinism; no
`tour_reminder` on placements; no live-fire reminders; coverage retained). Fix loop for
Critical/Important. **Then the orchestrator boots `npm run dev -- --local --seeded` and personally
clicks the previously-broken surfaces** (the `collect_rta` placement, /tours Scheduled/Confirmed
columns, a placement History panel) to confirm they read sensibly before declaring done. Leave
branch ready — do NOT merge.
