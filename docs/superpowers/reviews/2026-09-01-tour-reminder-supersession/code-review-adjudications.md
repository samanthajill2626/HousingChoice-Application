# Code-review adjudications - phase 4, round 1

Reviews: `code-review-conformance.md` (1 MINOR, 6 NOTE), `code-review-adversarial.md`
(1 BLOCKING, 3 MAJOR, 4 MINOR, 5 NOTE). Adjudicated by the orchestrator against the
live tree; fix wave dispatched with this list. Verdicts: ACCEPT-FIX (fix wave),
ACCEPT-RECORD (accepted residue, named in the handback), FOLD (subsumed by another).

## Must-fix

**B1 (BLOCKING) - generation-blind sweep can delete the concurrent winner's fresh
ladder. ACCEPT-FIX.** Reproduced interleaving: A patch, B patch+sweep+arm+CAS-win,
A sweep (deletes B's ladder), A arm, A CAS-lose. End: pointer names a ladder with
zero rows; two 200s; only the loser's log. Fix: an OWNERSHIP CHECK immediately
before each sweep - re-read the tour; if `currentLadderId` no longer holds the
rotation this request wrote (re-arm path) or the finalize's rotation (conversion
path), a concurrent writer owns the ladder: skip sweep AND arm, log at error, and
return the winner's stored state. Repo signature unchanged. The residual ms-window
(a full competing request landing between the ownership read and the sweep) is
accepted: its end state fires nothing, one side logs at error, and the next
reschedule repairs it - document in the spec. Regression test = the reviewer's
interleaving, parking A at its SWEEP (the existing test at `toursApi.test.ts:1850`
parks A past it and covers only the benign half - keep both).

**M3 (MAJOR) - any unrelated PATCH on an already-terminal tour rotates + sweeps,
destroying pre-migration reminder history. ACCEPT-FIX.** Reproduced. Fix: the
terminal branch fires only on an EXPLICIT terminal `patch['status']` (a
transition), never on `effectiveStatus` inherited from an already-terminal tour.
Test: PATCH `{outcome, moveForward}` on a toured tour holding a legacy canceledAt
row + a sent row -> rows untouched, pointer untouched, no `scheduled.updated`.

**M2 / conformance F2 (MAJOR) - `conversion_stalled` grace measured from `dueAt`
retires a long-deferred rung instantly under a false reason. ACCEPT-FIX.** Fix:
measure from `max(Date.parse(row.dueAt), Date.parse(tour.updatedAt))` -
`claimConversion` bumps `updatedAt` when it writes the sentinel, so a fresh claim
always gets the full hour; any later tour edit only EXTENDS the deferral (the safe
direction); a crashed claim on an untouched tour still expires an hour after the
claim. Tests: rung 5h overdue + claim written now -> deferred; claim 2h stale ->
retired.

**M1 (MAJOR) - Send now ignores the `pending:` conversion sentinel the poll defers
on (a regression of the S8 reordering). ACCEPT-FIX, narrowed.** Fix: after the
hoisted tour read, `forceSendReminder` refuses a claim-in-flight tour with a new
`ForceSendRefusal` token `conversion_in_progress` (+ its own
`SEND_NOW_ERROR_COPY` sentence + hand-list test entries; NOT in
`ReminderSkipReason` - the poll never stamps it; not permanent - not in
PERMANENT_REFUSALS). The three preview surfaces are NOT changed: they display,
they do not enforce; the promise-during-claim window is milliseconds on the happy
path and capped by the grace window on a crashed one. ACCEPT-RECORD that residue.

**m1 - PATCH/send-now echoes recompose a superseded rung's body against the
current schedule. ACCEPT-FIX.** In the two single-row responses, when
`isSupersededRung(after, tour)`, build the echoed view's body from `sentBody`
only (empty/omitted otherwise) instead of `bodyFor`.

**m2 / conformance F7 - anchor desync when the Upcoming block unmounts under the
operator. ACCEPT-FIX** via the reviewer's cheap direction (key the layout effect
on the block's presence, or re-derive the anchor at effect top). Must not
reintroduce the `upcoming`-array-identity dep.

**m3 - matrix seeds a state production cannot produce (canceledAt rung on a
superseded generation). ACCEPT-FIX**: omit that row for canceled matrix tours
(production deletes it at the terminal transition) and add the missing coherence
invariant pairing every seeded row's `ladderId` with its tour's pointer.

**m4 + conformance F5 - stale prose. ACCEPT-FIX**: `retire-paused-tour-reminders.ts`
comment set (deleted is now a fourth outcome; the `attribute_exists` clause is now
load-bearing), `tourRemindersRepo.ts:3,8` header, `e2e/support/selectors.md:73-75`
(third aria sentence + suppression-reason line), the two issue docs naming
`cancelForTour` / cancel-stamps.

**Conformance F1 - the re-arm sweep's failure leaves the interruption state
without its spec-required log. FOLD into B1**: the ownership-check refactor wraps
the sweep call; give the throw path `log.error({ err, tourId }, ...)` before the
rethrow.

**N5 - no RUNBOOK entry. ACCEPT-FIX** (orchestrator owns RUNBOOK): deploy note -
no backfill (pre-migration exemption), the one-time Phase B retire sweep and this
branch's hard delete are independent.

## Accepted / recorded (no fix)

- **M1's preview-surface half** - see above. Promise-during-claim staleness capped
  by the grace window; refetch corrects.
- **N1** - the retire script stamps a superseded past-tour survivor
  `tour_already_passed`, not `superseded`. Cosmetic; retired either way.
- **N2** - a half-swept ladder returns 200 and reads as history. Per-row errors
  are logged; the pointer keeps missed rows harmless. Accepted posture (S9 ruling).
- **N3** - unpaginated `listByTour` now feeds a delete. Spec non-goal 5; risk
  class reduced overall (row count now bounded). Recorded.
- **N4** - a zero-row arm after a sweep leaves an empty, unexplained panel.
  Narrow reachability (every kind must hit the SILENT past-dueAt drop). Recorded.
- **Conformance F2** = M2 (fixed). **F3** fixed by committing slice reports
  (@4272c88d). **F4** acceptance 5 true by construction - accepted. **F6**
  acceptance 16's contact-thread half is unit-only - covered in phase 5 live QA.
- **S5 residual** (`names_unavailable` on a tours-table outage in send-now) -
  imperfect token, honest outcome; recorded.

## Spec amendments (spec-first, committed with this file)

1. 3.2: the sweep is OWNERSHIP-GUARDED on both writer paths; the residual
   ownership-read-to-sweep window is named and accepted.
2. 3.3: the deferral grace runs from `max(dueAt, tour.updatedAt)`; Send now
   refuses a claim-in-flight tour with `conversion_in_progress`; the
   preview-surface residue is named.
3. Acceptance 8 gains: "and no interleaving deletes the winner's freshly armed
   rows".
