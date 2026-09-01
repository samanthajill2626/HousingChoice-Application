# Slice 4 report - Task 7 (DISCONTINUED + the unpause) + Task 8 (discontinued read surfaces)

STATUS: both tasks SHIPPED. Two commits, every required check green.

## Commits

| hash | subject |
|---|---|
| `cfaf453b` | feat(reminders): discontinued-kind guard; MANUAL_ONLY emptied - the unpause |
| `6328970e` | feat(reminders): discontinued reads on all read surfaces |

## Tests / gates run (exit codes + counts)

| command | exit | result |
|---|---|---|
| `app$ npx vitest run test/tourReminders.test.ts` (T7, first run) | 1 | 94 pass / **2 fail** - guards g3/g3b, see DIVERGENCE 1 |
| `app$ npx vitest run test/tourReminders.test.ts` (after g3/g3b) | 0 | 96 passed |
| `app$ npx vitest run test/devGating.test.ts` | 0 | 41 passed |
| `app$ npx vitest run test/tourRemindersApi.test.ts` (T7) | 0 | 39 passed |
| `app$ npx vitest run test/contactTimeline.test.ts` (T7) | 0 | 48 passed |
| `e2e$ npx tsc --noEmit -p .` (T7) | 0 | clean |
| root `npm run typecheck` (T7) | 0 | clean |
| **`app$ npx vitest run` FULL (T7)** | **0** | **6321 passed / 9 skipped, 347 files + 1 skipped** |
| `npx eslint <11 touched files>` (T7) | 0 | 0 errors, 2 pre-existing warnings (`quiet-hours.spec.ts:273,277` unused no-console disables - slices 2 and 3 recorded the same two) |
| `app$ npx vitest run tourRemindersApi + contactTimeline + relayApi` (T8, first) | 1 | 142 pass / 2 fail (both mine, fixed - see below) |
| same three files (T8, after) | 0 | 144 passed |
| **`dashboard$ npx vitest run` FULL** | **0** | **2864 passed, 183 files** |
| root `npm run typecheck` (T8) | 0 | clean |
| `e2e$ npx tsc --noEmit -p .` (T8) | 0 | clean |
| **`app$ npx vitest run` FULL (T8)** | **0** | **6328 passed / 9 skipped, 347 files + 1 skipped** |
| `npx eslint <15 touched files>` (T8) | 1 | **2 errors, BOTH PRE-EXISTING** - see "gate 5 attribution" |

Logs under `.superpowers/sdd/logs/s4-*.log`. No Playwright run (orchestrator owns e2e).

### Gate 5 attribution (baseline-compared, not read off line numbers)

`npx eslint` on the branch's touched files reports exactly two errors, and BOTH
are present at the unmodified baseline (verified by stashing only those two files
and re-running - `s4-lint-base.log`):

- `app/src/routes/relayGroups.ts:60` - `'resolveMessage' is defined but never used`.
- `dashboard/src/routes/contact/ScheduledCard.tsx` - `react-hooks/purity` on
  `now = Date.now()` in the component signature (line number shifts with my
  edit; the error is identical and pre-existing).

Neither is mine and neither is fixed here (fixing unrelated errors in a shared
repo is its own change). NAMED so the next person does not re-diagnose them.

## Task 7 - what shipped

- `DISCONTINUED_REMINDER_KINDS` holding `confirmation`, with the plan's docblock,
  amended in the T8 commit to name FIVE surfaces rather than four (R3 added
  `routes/relayGroups.ts`; the plan's text predates the ruling).
- `MANUAL_ONLY_REMINDER_KINDS` emptied; whole docblock rewritten per plan T7
  step 2 (what the set is FOR, the empty-idle state, the 2026-08-20..08-31 pause
  as history with Cameron's and Sam's attributions kept, "TO PAUSE AGAIN", and
  the pointer to the new set).
- Poll filter is `manualOnly.has(r.kind) || DISCONTINUED_REMINDER_KINDS.has(r.kind)`,
  held-back log line kept, both causes counted separately
  (`heldBackManualOnly` / `heldBackDiscontinued`) with a comment saying why the
  split matters (a manual-only count is a queue to work; a discontinued count is
  rows the sweep has not reached).
- `forceSendReminder` refuses INLINE right after the not-pending check (R4), with
  its own warn line matching `refuse`'s wording.
- `routes/dev.ts`: the TOUR tick's divergence block and `manualOnlyKinds: new Set()`
  deleted; the placement-nudge twin untouched. I did NOT touch the neighbouring
  "60s" comment - it belongs to the placement block, which is out of scope.
- Four seam docblocks rewritten (`routes/api.ts`, `routes/contactTimeline.ts`,
  `routes/tourReminders.ts`, `test/helpers/twilioWebhookHarness.ts`) plus the
  `manualOnlyKinds?` dep docblock in `RunDueTourRemindersDeps`, all saying the
  seam is now how a TEST injects pause-mode, and that none of them reach the
  discontinued set.
- Both `NO_MANUAL_HOLD_BACK` wrappers deleted; `previewHarness()` deleted with
  them (it was the same no-op in harness form) and its 9 call sites are now plain
  `makeWebhookHarness()`.
- Paused coverage PRESERVED via injection (R5) in `tourReminders.test.ts`,
  `tourRemindersApi.test.ts` and `contactTimeline.test.ts`; three new pins assert
  the production default is EMPTY so no `paused` case can be green while
  production silently holds everything back.

## Task 8 - what shipped

Union widened in both mirrors; the app-side declaration carries a comment saying
`discontinued` is in the union but never produced by the evaluator. Three
exhaustive Records got `turned off`; three label FUNCTIONS got an explicit
`discontinued` branch ABOVE `paused` (R15 note about `overdue` going below it is
on the RemindersPanel branch and in its test). Route chip branch, timeline
short-circuit and the relayGroups projection are as ruled. R2 re-points done on
both suites, plus one opted-out-reads-discontinued case per surface with the
opt-out proven live on a sibling rung.

## DIVERGENCES - read these

1. **I did R7 (guards g3/g3b) here, not in T9 as the worklist assigns.** T7 is
   what breaks them, not T9: once `confirmation` is discontinued, force-send
   refuses `kind_retired` above the compose gate, so both guards went red the
   moment the set landed and the slice could not be green otherwise. R7's
   derivation, run: `reminderNamesUsed` says `confirmation` is the **only** kind
   rendering no name (checked all 5 kinds x 3 tour types), so there was no live
   kind to retarget the "renders no name" half to. But that half is ALREADY
   pinned, better, at unit level - `tourCopy.test.ts` has "confirmation is never
   blocked - its untouched copy renders no name" with all three reads thrown at
   once, plus the derived-table tripwire. So I retargeted g3/g3b to `day_before`
   (which names the tenant and nothing else), keeping the half that could not
   survive elsewhere: that a force-send is NOT blocked by a name read the copy
   never needed. They are now the force-send twins of g1/g2, and both gained a
   body assertion they lacked. Comment at the site records the whole derivation.
   **T9's builder owes nothing further on R7.**

2. **e2e `quiet-hours.spec.ts` test (3) is NOT the exact inversion the brief and
   report D specify - and asserting QUIET_NOTE there would be a coin flip on the
   hour.** Test (2) IS inverted as instructed (QUIET_NOTE visible, PAUSED_NOTE
   absent) and is deterministic: its window is `QUIET_AROUND_DAY_BEFORE`
   (17:30-21:30 org-local) which contains the rung's fixed 19:30 dueAt at every
   wall clock. Test (3) is different: it keeps `windowAroundNow()` (a 4h window
   on the CLOCK) while its day_before rung is ~1.8 days out at a fixed 19:30
   org-local. The panel's estimate for a FUTURE rung is
   `dueAt > now && isQuietTime(dueAt, window)` - so 19:30 is inside a clock-
   anchored window only when the suite runs between 17:30 and 21:30 org-local.
   **This assertion was silently broken by the 2026-08-26 retiming and the pause
   has been masking it**: before that, day_before was sched-24h and landed at the
   same local time of day as `windowAroundNow()`, which is exactly the trick the
   file's own header says "died with the sched-24h offset". Test (3) now asserts
   the honest, deterministic thing - the rung is `upcoming` with NO note, and
   PAUSED_NOTE absent (a pause note there would mean a silent re-pause) - and
   keeps its real subject, the wall-clock Send-now bypass. A long comment at the
   site explains why it is not test (2)'s inversion, so nobody "fixes" it back.
   **Orchestrator: this is the one thing in the slice I could not prove by
   running it (no Playwright here). Worth an eye on the first full e2e.**

3. **`tourRemindersApi.test.ts` "a terminal rung carries no estimate at all"
   changed KIND, not just harness.** It seeded a SENT `confirmation`, which after
   T8 would carry no estimate for the wrong reason (terminal AND discontinued
   both suppress it). It now seeds a SENT `day_before` under the injected pause
   set, so `state !== 'upcoming'` is genuinely the only thing stopping the chip.
   T8 adds a separate case for the terminal-discontinued combination.

4. **`ScheduledCard.tsx`'s note TONE fork gained `discontinued` (muted).** Report
   B flags that this fork was `quiet_hours` ONLY and "already asymmetric with the
   panel". I added `discontinued` to both surfaces' muted set on the same
   argument the panel already makes for `paused`: it is a settled decision, not
   something to act on, and it recurs on every pause-era rung - an always-amber
   surface stops reading as a warning. Not asked for by the plan; say the word
   and it is a one-line revert.

5. **`devGating.test.ts` "fires the due rows ... exactly once" gained a THIRD
   tick.** The old shape proved "never re-sends" by ticking twice at different
   instants and asserting two different bodies. With the first tick now a no-op,
   that structure could not carry the idempotence half, so a third tick repeats
   the day_before instant and asserts the count does not move. `CONFIRMATION_BODY`
   is gone (it would have been an unused const = a gate-5 error) and a new
   `DAY_BEFORE_DUE` const replaces the hand-typed twin of that instant; the
   ms-normalization comment is re-derived and its assertion gained a line proving
   the normalized `now` really is past the rung.

6. **`contactTimeline.test.ts` gained a `MORNING_OF_BODY` const.** The two-rung
   sort case asserted `up[0].body === CONFIRMATION_BODY` and `suppression ===
   undefined` on every item, so re-pointing it needed the matching composed body.
   `CONFIRMATION_BODY` is still used (the uncomposable-tour case), so nothing
   went unused.

## Open worries - not blocking, your eye

- **`scheduled-visibility.spec.ts:188`'s comment is now stale** ("Since the
  2026-08-20 hold-back that line reads 'Paused' rather than a fire time"). It is
  a COMMENT, not an assertion - `expectUpcomingItem`'s regex accepts
  `sends |sending shortly|Paused`, so the spec stays green either way. Worklist
  T9 owns that file; flagging so it is not read as a T7 miss.
- **`steps.ts` `expectUpcomingItem`'s regex comment** has the same staleness for
  the same reason. Worklist T8 explicitly says LEAVE the regex ("a discontinued
  card now fails loudly") and I did.
- **`heldBackManualOnly` + `heldBackDiscontinued` can double-count** a kind that
  somehow sits in BOTH sets. That is a misconfiguration, the `heldBack` total is
  still correct, and I did not add code to guard it.
- **`routes/dev.ts:~415` comment about the placement-nudge tick's "60s"** is
  still wrong (the poll is 30s, worklist global correction). I did not touch that
  line because the whole placement block is explicitly not mine.
- The `RemindersPanel` and `DeadlinesNudgesCard` discontinued chips reuse
  `styles.paused` for their CSS class (there is no `styles.discontinued`). The
  visual treatment is therefore identical to Paused while the TEXT differs. If
  the design wants them visually distinct, that is a CSS module addition nobody
  asked for yet.
