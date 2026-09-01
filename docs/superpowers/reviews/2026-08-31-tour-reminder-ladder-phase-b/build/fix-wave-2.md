# Fix wave 2 - round-2 adjudications (9 FIX items + the R2-S4 docblock)

Every row in `adjudications-r2.md`'s "Fix wave 2 (FIX)" table is implemented,
plus the one-sentence docblock addition ruled under RECORD R2-S4. Nothing else
ruled RECORD was touched. Started from a clean `git status` at @f0c57238;
`.git/MERGE_HEAD` absent before each commit.

## Red-first evidence

`.superpowers/sdd/logs/w2-red-1.log` - exit 1, **7 failed** / 235 passed:

| item | the red, and that it is the RIGHT red |
|---|---|
| R2-S1 | `expected 'tour_today' to be 'naked'` |
| R2-M1 (write) | `promise resolved "{ scanned: 5, ...}" instead of rejecting`, with `failed: 2` - i.e. the exact defect: both writes swallowed, run resolves |
| R2-M1 (exit code) | `reportRetirementRun is not a function` (x2 - the rule had no home) |
| R2-S3 | the thread-read spy counted a read that should not happen |
| B NOTE-4 | `expected false to be true` (offset-bearing `now`) and the unparseable-`now` case |

`.superpowers/sdd/logs/w2-green-1.log` - exit 0, 242 passed, same four files.

R2-S2's new test passed on first run and that is expected: it is a STRUCTURAL
guard, not a behaviour change. `DISCONTINUED_REMINDER_KINDS` holds exactly
`confirmation` today, so the literal and the set agree; the test asserts the
SOURCE, so it turns red the day a second kind is discontinued and the sweep is
not updated - which is the latent divergence R2-S2 is about.

## Per item

**R2-B1 / MF-R2-1 - the placement e2e's phone read. FIXED.**
`rosterPhones` and its `as { members: { phone?: string }[] }` cast are DELETED.
The walk now asserts leg arrival against the two phones it MINTED, exactly the
tour walk's idiom at `:258-259`, via the existing `expectExactSentFromPool`
(so the pool-number pin survives). The comment in place records why: the roster
route answers `RosterView`, whose rows carry `phoneLast4` and never a full
`phone`, so the read returned `[]` and the loop that is the entire substance of
A-M2 had nothing to iterate.
Trade-off, recorded deliberately: the "server names its own members" property is
gone. Reviewer B offered a `phoneLast4`-vs-`slice(-4)` variant that keeps it, but
the ruling says to delete the helper and assert the minted phones, and this walk
gets exactly one real execution (the orchestrator's e2e) - so the version with
the fewest new moving parts is the right one. What is asserted is now STRONGER
per member (both members' threads must carry the byte-exact body from the pool
number); what is lost is only "and no sixth member was addressed", which the
tour walk never asserted either. A one-line comment names the default roster
(tenant + landlord-of-record) so "these two ARE every member" is checkable.

**R2-M1 / MF-R2-2 - the sweep's two failure classes. FIXED, all three parts.**
`app/scripts/retire-paused-tour-reminders.ts`:
- (a) PLAN side - `tourFor` + `planReminderRetirement` sit in their own
  try/catch; a throw counts `failed`, logs `{err, reminderId, tourId}` and
  `continue`s. The write is no longer inside that catch.
- (b) WRITE side - only `ConditionalCheckFailedException` is caught (still
  counted `skippedOnCondition`, unchanged). Anything else propagates out of the
  paging loop, so the wrapper logs the PARTIAL counters and the CLI exits 1.
  This also puts the PARTIAL report back within reach: reviewer B's "nearly
  unreachable" observation was correct, and the write path is what re-arms it.
- (c) A COMPLETE run with `failed > 0` now exits 1. The rule lives in a new
  exported `reportRetirementRun(result, dryRun): 0 | 1` - the CLI's `.then` is
  untestable, so the decision was moved somewhere a test can reach it. It logs
  `COMPLETED WITH FAILURES` at WARN and returns 1; a clean run logs `done` at
  INFO and returns 0.
  Dry runs included, deliberately - the dry run is exactly where an undecidable
  row should surface. (Reviewer A raised this as the orchestrator's call; the
  ruling deletes the "not a reason to stop" language outright, so uniform is the
  reading that matches it. Said explicitly in the RUNBOOK and in the docblock.)
Tests, both new: "a WRITE failure ABORTS the run" (injects a `doc` whose `send`
rejects on `UpdateCommand`; asserts the promise REJECTS and that NEITHER planned
row was stamped - i.e. it aborted rather than continuing) and the corrupt-row
case extended with `reportRetirementRun(result, false) === 1` and `(..., true) === 1`.
A third test pins the boundary the other way: "a lost CONDITIONAL write is still
not an abort", so "a write failure aborts" cannot be misread as "any write error
aborts".
RUNBOOK step 2 rewritten: `failed` > 0 exits 1, investigate then re-run; and the
three exits (clean 0 / `failed` 1 / ABORT + PARTIAL 1) are now told apart.

**R2-S1 - boundary flipped to `<=`. FIXED.**
`relayFanOut.ts` now drops `scheduledAt` when `startedAt <= Date.parse(nowIso)`,
matching `retiredByTourStart`'s inclusive `now >= start`. The comment no longer
claims kinship it did not have; `retiredByTourStart`'s own docblock gained the
reciprocal sentence so the two sites point at each other. Test renamed and
inverted ("the boundary is INCLUSIVE: at exactly the start instant the tour copy
is already stale") and given a one-millisecond-earlier control that still
resolves `tour_today`, so the flip is pinned from both sides.

**R2-S2 - population B reads the set. FIXED.**
`DISCONTINUED_REMINDER_KINDS.has(row.kind)` replaces the `'confirmation'`
literal; the import joins `retiredByTourStart` on the same line. Planner
expectations unchanged, as ruled. New structural test iterates the set.

**R2-S3 - `hasUpcoming` excludes discontinued. FIXED.**
`routes/tourReminders.ts` - `stateOf(r) === 'upcoming' && !DISCONTINUED_REMINDER_KINDS.has(r.kind)`.
Test spies on `conversationsRepo.findByParticipantPhone` (reached ONLY through
the suppression estimate - `composeInputsOf` reads the tenant contact but never
the thread) and asserts zero reads on a tour whose only pending rung is a
`confirmation`, that the `discontinued` chip is still correct, and - the
anti-vacuity half - that adding a live `day_before` to the same tour makes the
count non-zero. The spy is restored in a `finally`.

**B NOTE-4 - `now` parsed. FIXED.**
All three operands of `retiredByTourStart` are now instants; unparseable `now`
-> `false`, matching the other two. Two tests: an offset-bearing `now`
(`...T11:00:00-05:00` IS 16:00Z, so the gate must fire where text order said no)
and the unparseable case.

**B NOTE-1 - precedence 1 exemption. FIXED (comment).**
The resolver docblock's unconditional sentence now says the guard governs the
COMPOSED variants (precedence 2-4) only, that an operator-edited `intro_body`
still sends verbatim by design ("a human chose those words"), and that the only
reachable case is a `connecting` group whose number purchase straddles the start
- the deferral path drops the edit.

**B NOTE-5 - fail-open stated. FIXED (comment).**
The tour branch now says an unparseable `nowIso` leaves the guard off and the
tour variant composes, and that this is a deliberate fail-OPEN for a resolver
whose first duty is never to throw and never to lose an intro.

**B NOTE-6 - the cloned step helper. FIXED.**
`e2e/scenarios/steps.ts` gains one private `expectRungsSkipped(kinds, skipReason,
because)` carrying the shared body (the empty-list throw, the API read, the
per-kind assertions). `expectRungsRetiredPastTour` and `expectRungsSuperseded`
stay as thin named wrappers - the smaller change than updating call sites, and a
call site reading `expectRungsSuperseded` names the MECHANISM the walk is
asserting, which a bare reason string in an argument list does not. Both call
sites unchanged.

**R2-S4 (RECORD) - the principle written down. DONE.**
`nextReminderRefetchDelay`'s docblock gains the sentence reconciling the two
rulings: the A-S6 revert concerned surface-specific RENDERING of copy a
placement writer can never produce; this is a pure helper keyed on the shared
WIRE UNION that the tour panel needs. Different rule, same wave. No behaviour
change.

## Gates (bare, unpiped - logs redirected only)

| gate | exit | counts |
|---|---|---|
| `cd app && npx vitest run` | **0** | 347 files passed, 1 skipped; **6401** passed, 9 skipped |
| `cd dashboard && npx vitest run` | **0** | 183 files; **2871** passed |
| `npm run typecheck` (root) | **0** | all five workspaces |
| `npm run smoke` | **0** | 1365 specifiers across 239 files |
| `cd e2e && npx tsc --noEmit -p .` | **0** | - |
| `npx eslint <11 touched ts/tsx>` | **0** | **CLEAN - zero findings, no baseline needed** |

Logs: `w2-app-full.log`, `w2-dash-full.log`, `w2-typecheck.log`, `w2-smoke.log`,
`w2-eslint.log` under `.superpowers/sdd/logs/`.

Gate 5 is genuinely clean this wave: `app/src/repos/tourRemindersRepo.ts` (the
file carrying the inherited `GetCommand` error) is NOT in this wave's touched
set, so nothing pre-existing is even in scope. That error is still live on the
branch and still belongs in the handback - R2-N3 confirmed it inherited.

ASCII: `git diff -- '*.ts' '*.tsx' '*.md' | grep '^+' | LC_ALL=C grep '[^ -~\t]'`
-> empty.

Playwright was NOT run. The sweep script was NOT executed against anything -
only its suite ran, against per-case hermetic `hc-test-*` tables.

## Open worries - not blocking, your eye

1. **R2-B1 is still unexecuted here.** The fix removes the impossible read and
   the walk now uses only idioms the green tour walk already exercises
   (`expectExactSentFromPool` on a minted phone), but your e2e is its first real
   run. If it fails now it will be on the placement RELAY OPEN or the pool
   number, not on the roster shape.
2. **`reportRetirementRun` returns the code; the CLI assigns it.** That keeps
   the rule testable, but it does mean the exit code is proven by a unit
   assertion rather than by running the script. Running the script for real is
   forbidden outside a hermetic lane, so this is the closest reachable proof.
3. **Dry-run + `failed` now exits 1.** This is the one place I resolved a live
   disagreement between the reviewers (A wanted it scoped away from dry runs) in
   favour of the adjudication's text. If you prefer A's reading it is a one-line
   change in `reportRetirementRun` plus the RUNBOOK sentence.
4. **B NOTE-3 remains an accepted residual**, as ruled - the double conversation
   read in the member_added path is untouched.
