# Spec review r3-b - tour auto-close and reopen (DRAFT 3 @579a810b)

- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` @ 579a810b
- Inputs: the diff 87d4bf2e..579a810b, `adjudications.md` (Spec round 2)
- Method: read-only; every claim checked in the worktree. The plan was read
  only to confirm it implements 5.3 as written (`docs/superpowers/plans/2026-10-01-tour-auto-close-reopen.md:270`).

## Verdict

Nothing in draft 3 should change what gets built at MEDIUM or above. The
three findings below are LOW. Two are optional changes to what gets built;
the third is text only.

## The updatedAt writer walk (the round's main question)

Question: can any writer of `updatedAt` on a tour row keep a candidate open
forever, or close one early, under the 5.3 floor ("the mark is
`lastMarkedAt` when present, otherwise `updatedAt`")?

| writer | where | who triggers it | effect on a candidate with no `lastMarkedAt` |
|---|---|---|---|
| `create` | `app/src/repos/toursRepo.ts:293-323` | POST /api/tours (`tours.ts:335`) | mark = creation (equal to `createdAt`) |
| `patch` | `toursRepo.ts:387-430` (stamp `:410-412`) | PATCH route (`tours.ts:1239`); create's pointer write (`:360`, at create); conversion finalize (`placements.ts:771`); group stamp (`rosterProvision.ts:398`) | a status/time PATCH stamps `lastMarkedAt` in the same write (8.4); an outcome/moveForward-only PATCH bumps it; finalize only touches `convertible: true` tours (gate `placements.ts:661`), which are never candidates |
| `claimGroupThread` / `releaseGroupThreadClaim` | `toursRepo.ts:432-470` | relay open (`rosterProvision.ts:335`, `:364`, `:401`): the route, or the roster-actions job applying a deferral a person confirmed | bump (postpone) |
| `claimConversion` / `releaseConversionClaim` | `toursRepo.ts:472-525` | `placements.ts:716`, `:750`, `:778`, only after `convertible === true` | never a candidate |
| `setLadderIdIf` | `toursRepo.ts:527-560` | `tours.ts:1300`, inside a reschedule | the same request stamps `lastMarkedAt` |
| `setRoster` / `clearRoster` | `toursRepo.ts:562-621` | plan edits (`tours.ts:632-633`, `:742`; only before a thread exists); consume at open (`rosterProvision.ts:424`) | bump (postpone) |
| background jobs | reminder poll `jobs/tourReminders.ts:1051`, `:1128`, `:1802`; relay fan-out `jobs/relayFanOut.ts:460` | timers | READ only. The armer stamps reminder rows, not the tour (`tourReminders.ts:452`). The roster-actions job writes only through the relay-open row above, once per deferred action |
| scripts | `app/scripts/*` | humans | none writes a tour row (grep of every tours-repo write) |

Result: no writer recurs without a person, so nothing keeps a candidate open
forever. Each bump is a deliberate edit that grants 14 days, which is the
stated rule. Every write stamps the wall clock
(`new Date().toISOString()`), and `lastMarkedAt` is the router's clock - the
same instant in production. The floor therefore never moves earlier, and
nothing closes a candidate early. The transition from "no `lastMarkedAt`" to
"has `lastMarkedAt`" cannot lower the floor either: the mark's own write sets
`updatedAt` to the same instant. Seeds write explicit values; the matrix
no-show's `updatedAt` is the mark (`matrix.ts:1071`), consistent with 12's
"about 9 and 11 days". The accepted residual (6.3: an unrelated write that
races the close is not detected) is stated correctly. Its worst case, a relay
group opened in the same instant, is the already-deferred 6.6 item.

## Findings

### R3-1 [LOW] The `updatedAt` stand-in is not legacy-only: it governs every post-deploy tour until its first mark

**What is wrong.** 5.3's rationale frames the stand-in as being for rows "written before this feature ships". POST create does not write `lastMarkedAt` (5.2: "staff PATCH, reopen"). So every tour CREATED after the deploy and never PATCHed with a status or time uses `updatedAt` permanently. That is the booked-ahead, never-marked "Not marked" population - most of what the sweep closes. The spec's own consequence line says this ("a tour nobody has marked since the deploy"), but the rationale does not.

**Evidence.** Spec 5.2, 5.3 rationale paragraph, 8.4; `app/src/routes/tours.ts:335-342` (create passes no such field).

**What it implies.** The rule is asymmetric. Opening a relay group (or editing the roster) after the date postpones the close of a never-marked tour, but not of an identical tour that was once rescheduled. Behavior is safe (it only postpones). Two options: stamp `lastMarkedAt` at create, which leaves every other clock result unchanged and confines the stand-in to true pre-deploy rows; or say in 5.3 that the stand-in applies to every never-marked tour.

### R3-2 [LOW] D14's own rationale applies to the Reschedule and Cancel dialogs, which keep "please try again"

**What is wrong.** D14 remaps a 409 only in the Record outcome dialog because "the auto-close makes that refusal likelier at the two-week boundary". Decision 5 puts no-shows on Today for up to 14 days. Staff then open them to Reschedule exactly as they near that boundary. "Not marked" rows can also be canceled or rescheduled at the same edge. After a close, both dialogs get a 409 that a retry cannot fix.

**Evidence.** `dashboard/src/routes/tours/TourModals.tsx:150`, `:167` ("Couldn't schedule/reschedule the tour - please try again.", shared `DateTimeModal` catch at `:84-88`) and `:378` ("Couldn't cancel the tour - please try again."); spec 9.2 "other tour dialogs are unchanged".

**What it implies.** Inconsistent copy for the same refusal. Either apply the same 409 mapping in `DateTimeModal` and `CancelTourModal` (small), or narrow D14's rationale.

### R3-3 [LOW] The section 13 preview overstates what the tour page shows ("the tour page's history does")

**What is wrong.** The preview tells the operator to read an undated row's "last changed" date from the tour page's history. With no `lastMarkedAt`, that date is `updatedAt`. The Activity card lists only the tour's lifecycle audit rows. Roster plan edits, an outcome/moveForward-only PATCH, and a failed relay open all bump `updatedAt` but write no history row.

**Evidence.** `app/src/routes/tours.ts:445-447` (the `tours#` trail's event types); `rosterProvision.ts:440` (only a successful open writes `tour_group_opened`); `setRoster` / `clearRoster` write no audit row.

**What it implies.** Text only. When the history understates the last change, the preview predicts a close that does not happen - the safe direction. Say "its last lifecycle event (a later edit can keep it open)", or leave it.

## Adjudication contests

None. All six round-2 rulings deliver what was asked. R3-2 extends R2-6's
fix rather than contesting it.

## Fixes checked (correct, not just plausible)

- R2-1, legacy floor: correct (the walk above). The plan implements it exactly
  (`plan:270`) and already flags the harness clock trap (`plan:966-971`).
- R2-2: `isAutoCloseDue` plus the up-front guard in `autoCloseIf`. With the
  `status = <read>` condition, a non-candidate can no longer be closed through
  any path.
- R2-4: the new intro copy matches 5.3.
- R2-5: one placement per state is complete. A closed tour's ladder can hold
  only "View placement" (no Reopen) or "Start placement" (Reopen in the kebab);
  otherwise Reopen is primary. "Yes, reopen" does not contain "Reopen tour", so
  default substring matching cannot collide. The kebab item is a `menuitem`
  (`TourActionsMenu.tsx` items are `role="menuitem"`), so tests must query it
  by that role. The menu's null guard (`TourActionsMenu.tsx:79-89`) must count
  the new flag, or the kebab renders nothing in exactly the state that needs it.
- R2-6: only PATCH errors reach the Record outcome dialog. A failed chained
  conversion is caught in `confirmOutcome` and goes to the header
  (`TourDetail.tsx:549-557`), so mapping every 409 there to "changed since the
  page loaded" is accurate.
- R2-3 (seed text) and the 8.3 note on `client.ts:75-83`: accurate.
- UNVERIFIED: "the Past tab is live in production since Sep 28" (13). It is
  cited from the tracker; the repo holds no deploy record.
