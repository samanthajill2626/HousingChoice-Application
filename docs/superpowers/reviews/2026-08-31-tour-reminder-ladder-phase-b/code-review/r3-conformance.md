# Reviewer A - SPEC CONFORMANCE, ROUND 3 (read-only)

Branch `feat/tour-reminder-ladder-phase-b` @`ee873111`. Confined to fix wave 2
(`4d928b46` code + `ee873111` docs). No Playwright, no suites started. Nothing
edited but this file; `git status` clean.

| rank | count |
|---|---|
| BLOCKING | 0 |
| MUST-FIX | 0 |
| SHOULD | 1 |
| NOTE | 4 |

All six of my R2 items are closed. The wave-2 code is correct as far as static
review can establish, its red-first evidence is real for every behavioural fix,
and I withdraw my dry-run exit-code disagreement (section 3).

---

## 1. The two sweep-failure classes, and the e2e phone fix

### The plan/write split is sound

`app/scripts/retire-paused-tour-reminders.ts:230-277`. The PLAN try/catch now
wraps `tourFor()` + `planReminderRetirement()` ONLY (`:232-244`); the write sits
outside it (`:264-276`) with the conditional check as the single non-aborting
error. I probed the split for a misclassified case and found none that is
reachable:

- **A row-local WRITE failure would be misclassified as systemic** - the one
  shape that would break the rule. The candidate is a malformed KEY, exactly the
  shape the plan side steps over. It is unreachable: `reminderId` is the table's
  partition key, so no item can lack it, and `ensureTable` types it `S`, so no
  item can carry it as another type. Every remaining write error really is
  environmental. The split holds.
- **A systemic PLAN failure would be misclassified as row-local** - e.g. the
  `tours` table unreadable. It is classified `failed` per row, but rule (c)
  catches it: the run exits 1 at WARN, so the operator is still told. No hole.
- **Counter reconciliation** still exact: every row lands in exactly one of
  `skipped` / `tourAlreadyPassed` / `kindRetired` / `skippedOnCondition.*` /
  `failed`, summing to `scanned`.
- **An abort loses no counters.** `scanAndRetire` accumulates into the caller's
  `result` (`:216`), the wrapper logs PARTIAL and re-throws (`:113-127`), and the
  per-row write is one atomic `UpdateExpression` setting `skippedAt` and
  `skipReason` together (`:145`), so no half-written row can exist.

Two things the split does not cover are recorded as R3-N1 and R3-N2 below;
neither is a defect in the code.

### The e2e phone fix

`e2e/tests/relay-intro-variants.spec.ts:346-357`. `rosterPhones` and its `as {
members: { phone?: string }[] }` cast are gone, and the walk asserts against the
two minted phones through `expectExactSentFromPool` - the idiom the green tour
walk already uses. The comment records the cause correctly (`RosterView` carries
`phoneLast4`, never `phone`).

Checked cold:

- **Coverage is not reduced.** The adjudication requires "every member's fake
  thread". The placement's default roster is the tenant plus the unit's
  landlord-of-record (`app/src/lib/rosterResolution.ts:271-301`), and this walk
  mints exactly those two, so the literal pair IS every member. The comment says
  so and it is true.
- **No orphaned import.** `APIRequestContext` is still used by `createContact`,
  `createAvailableUnit`, `createPlacement`, `openRelay`,
  `expectExactSentTo` and `expectExactSentFromPool`; eslint over the wave's
  touched files is clean (`w2-eslint.log`, zero findings).
- The `poolNumber` assertion, the `driveConnectingGroupToOpen` return shape and
  the `201 {conversation}` carrying `pool_number` were all verified in R2 and are
  untouched. The residual risk is unchanged and correctly stated by the fixer:
  the walk's first real execution is the orchestrator's e2e.

### `steps.ts` helper dedupe (B NOTE-6)

`e2e/scenarios/steps.ts:2097-2150`. One private `expectRungsSkipped(kinds,
skipReason, because)` behind the two named verbs. `requireActiveTour()` is still
called synchronously before `step(...)`, so the eager-throw behaviour is
unchanged, and the empty-list throw now names the reason. The
`expectRungsRetiredPastTour` docblock above it (`:2081-2095`) remains accurate.

---

## 2. The new code, cold

### Correct

| item | verdict | evidence |
|---|---|---|
| Population B reads the shared set | CORRECT | `retire-paused-tour-reminders.ts:89` `DISCONTINUED_REMINDER_KINDS.has(row.kind)`, imported at `:55`. |
| Boundary flip to `<=` | CORRECT | `relayFanOut.ts:410` `startedAt <= Date.parse(nowIso)`, now identical in effect to `retiredByTourStart`'s `nowMs >= start` (`tourReminders.ts:200`). Both docblocks now cross-reference each other and say "one instant, one answer". |
| `retiredByTourStart` parses `now` | CORRECT | `tourReminders.ts:194-200`; all three operands are instants, unparseable `now` -> false, matching the other two. Behaviourally identical on canonical input (checked at t-1ms, t, t+1ms). |
| `hasUpcoming` excludes discontinued | CORRECT, and provably behaviour-neutral | `routes/tourReminders.ts:520-522`. `hasUpcoming` has exactly ONE consumer, the `self_guided && hasUpcoming` gate at `:531` (grep confirms no other reference, no response field, no log). Whenever a non-discontinued upcoming rung exists the flag is still true, so the estimate is built exactly when it is read. |
| Precedence-1 comment (B NOTE-1) | ACCURATE - verified, not assumed | `relayFanOut.ts:352-359` claims a quiet-hours deferral "drops the edit entirely (routes/tours.ts)". True: `routes/tours.ts:1391-1397` upserts the pending open with no `introBody`, and `parseIntroBody` is not reached until `:1406`, after the deferral returns. (This is the class of claim that was FALSE in wave 1's devGating comments; this one holds.) |
| Fail-open comment (B NOTE-5) | ACCURATE | `relayFanOut.ts:401-407`; `Number.isFinite` guards make an unparseable `nowIso` leave the guard off, and every production caller supplies an ISO instant. |
| R2-S4 docblock (RECORD) | DONE as ruled | `RemindersPanel.tsx:68-73` states the rendering-vs-wire-union distinction in one sentence. |
| RUNBOOK three exits | CORRECT | `RUNBOOK.md:297` now tells `failed`-and-finished, ABORT-with-PARTIAL and clean apart, and the "not a reason to stop" sentence my R2-M1 quoted is gone. |
| Test honesty (red-first) | VERIFIED REAL | `w2-red-1.log` carries the right failure for every behavioural fix: `expected 'tour_today' to be 'naked'` (R2-S1), `promise resolved "{ scanned: 5, ...}" instead of rejecting` (the WRITE abort), `expected false to be true` and `expected true to be false` (both `now`-normalization cases), `expected 1 to be +0` on `threadReads` (R2-S3). Gates re-run: app 6401/347 exit 0 (+6 tests, matching the six added cases exactly), dashboard 2871/183, typecheck 0, smoke 0, e2e tsc 0, eslint clean. |

### Test design worth naming

The WRITE-abort test (`app/test/retirePausedTourReminders.test.ts:322-345`)
intercepts only `UpdateCommand` and passes everything else to the real client,
so the scan and tour reads behave normally and the write is the sole novelty; it
then asserts BOTH planned rows are unstamped, which is order-independent under an
unordered Scan. The conditional-write counterpart at `:347-372` races a real
`claimSend` between the scan and the plan, deterministically, because an unbounded
Scan returns one page. Both are honest constructions, not mocks that assert
themselves.

---

## 3. The dry-run exit-code disagreement - I WITHDRAW

The fixer resolved it in favour of the adjudication (`reportRetirementRun`
returns 1 on `failed > 0`, dry runs included) and flags it as worry 3. I do not
contest it, and the reason is specific rather than deferential.

My R2 objection was not "a dry run should never exit 1"; it was that
`exitCode = 1` would contradict the RUNBOOK, which at the time read (old
`RUNBOOK.md:297`) "a non-zero `failed` is worth investigating before the apply,
**not a reason to stop**". A script exiting 1 while its own runbook says the
condition is not a stop is the incoherence I was objecting to.

The same adjudication deleted that sentence. `RUNBOOK.md:297` now reads
"**`failed` > 0 means the run exits 1 and logs `COMPLETED WITH FAILURES` at WARN,
dry runs included: investigate the logged `reminderId`s, then re-run**", and
`retire-paused-tour-reminders.ts:284-306` matches it exactly. With the
contradiction removed the ruling is not merely coherent, it is better than my
alternative: the dry run is the step whose entire purpose is to surface what the
apply would meet, so an undecidable row surfacing there - loudly - is the point.
No change wanted.

The exported `reportRetirementRun` (`:298-306`) is the right shape for it:
`process.exitCode` lives in the CLI block no test can reach, so returning the
code makes the rule assertable, and three call sites now assert it (`:406-411`,
`:371`). The docblock says plainly that this is why it exists.

---

## 4. Are my R2 items closed?

| id | closed? | evidence |
|---|---|---|
| **R2-B1** | **YES** (static; execution is the orchestrator's e2e) | `relay-intro-variants.spec.ts:346-357` - the impossible read and its `as` cast are deleted, both minted phones are asserted through `expectExactSentFromPool`, and the comment records the `phoneLast4` cause. The roster-shape failure mode is gone by construction. |
| **R2-M1** | **YES** | Three-part fix, all present: PLAN failure -> `failed` + continue (`:232-244`); WRITE failure other than a lost conditional -> re-throw, PARTIAL report, exit 1 (`:264-276`, `:113-127`); complete-with-`failed` -> WARN + exit 1 (`:298-306`), wired at `:320`. RUNBOOK realigned. Two new integration tests, both observed red first. |
| **R2-S1** | **YES, as I preferred** | `relayFanOut.ts:410` flipped to `<=`; the comment no longer claims kinship with a gate it contradicted and now states the shared boundary; `tourReminders.ts:171-174` cross-references back. The boundary test is inverted and renamed, and adds a t-1ms case - `TOUR_AT` is `2026-09-08T19:00:00.000Z` and the probe is `...T18:59:59.999Z`, so "one millisecond earlier" is literally true. |
| **R2-S2** | **YES** (see R3-N3 on the test's reach) | `retire-paused-tour-reminders.ts:89`. |
| **R2-S3** | **YES** | `routes/tourReminders.ts:520-522`, with a no-IO test that spies `findByParticipantPhone` and carries an anti-vacuity half proving the spy fires on a live rung. |
| **R2-S4** | **CLOSED as RECORD** | Docblock sentence added; I do not contest the ruling - the distinction it draws (surface-specific rendering vs a pure helper on the shared wire union) is the right one. |

---

## Findings

### SHOULD

**R3-S1 - one non-ASCII character in a committed mission record, and the ASCII
check that was supposed to catch it could not have.**
`docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/build/fix-wave-2.md:70`
contains U+2026 (`...`) in "``(..., true) === 1``". AGENTS.md makes added lines in
specs/plans/prompts/issues ASCII-only, and mission records are committed
documents under that rule.

The verification matters more than the character. The fix-wave-2 report states
"ASCII: `git diff -- '*.ts' '*.tsx' '*.md' | grep '^+' | LC_ALL=C grep '[^ -~\t]'`
-> empty". A **bare `git diff` lists UNSTAGED changes**, and at report time the
tree was clean - so that command inspected nothing and returned empty regardless
of content. This is verbatim the trap AGENTS.md documents for gate 5 ("at gate
time your branch is committed and clean, so it returns NOTHING and the gate
passes having checked zero files"), reappearing on the ASCII check. The same
command shape appears in the wave-1 report.

Audited properly, over the range: `git diff ec32170a...HEAD | grep '^+' |
LC_ALL=C grep -c '[^ -~\t]'` -> **1**, the character above, and it is the ONLY
one on the whole branch. So the code and every other document are genuinely
clean; one character in one record needs replacing with `...`, and the check in
both wave reports should be re-run as a range diff.

### NOTE

**R3-N1 - the dry run cannot exercise the WRITE class at all.** By construction
it issues no `UpdateCommand` (`:255-262` returns before the write), so a missing
`dynamodb:UpdateItem`, a wrong `TABLE_PREFIX` write path or rotated write
credentials cannot surface until the apply - mid-run, after a partial write, as
an ABORT. The behaviour is right and RUNBOOK step 4 already says re-running is
safe; recording it because step 2's "read the report before applying" can read as
though a clean dry run de-risks the apply, and for the write class it cannot. One
clause in step 3 would close it.

**R3-N2 - a THROWN tour read is not cached, unlike `undefined`.** `tourFor`
(`:131-140`) caches only on success, and its docblock says "`undefined` is CACHED
too - a missing tour is a stable answer, not a retry" without mentioning the
throw path. A throwing tour is therefore re-read once per rung, and each rung is
counted `failed` separately - so `failed` counts ROWS, not tours, which is worth
knowing for an operator told to "investigate the logged `reminderId`s". Bounded
by row count and arguably the right behaviour for a transient read; the docblock
is what is incomplete.

**R3-N3 - R2-S2's regression test cannot fail today.** `population B is driven by
DISCONTINUED_REMINDER_KINDS` (`app/test/retirePausedTourReminders.test.ts:86-96`)
iterates a set whose only member is `confirmation` - the same value the deleted
literal matched - so it passes against both implementations, which is why
`w2-red-1.log` shows no red for it (correctly, none was claimed). The closure
rests on reading `retire-paused-tour-reminders.ts:89`, which I did. The test
becomes load-bearing the day a second kind is discontinued, which is exactly when
it matters, so this is a limit to record rather than a gap to fill.

**R3-N4 - the deferred relay open silently discards an operator-edited intro.**
Verified while checking B NOTE-1's comment: `routes/tours.ts:1391-1397` upserts
the pending open with no `introBody`, and `parseIntroBody` is only reached at
`:1406`, after the deferral has returned 202. So an operator who edits the intro
in the confirm dialog during quiet hours loses those words, and the group opens
at quiet-end with composed copy. Pre-existing and outside the wave-2 diff, so not
a finding against this wave - but this branch now has a comment relying on the
behaviour, which makes it the right moment to put it in the handback.
