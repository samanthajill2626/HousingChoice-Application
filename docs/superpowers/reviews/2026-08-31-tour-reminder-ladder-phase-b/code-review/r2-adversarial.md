# Reviewer B - round 2, adversarial (read-only)

Branch `feat/tour-reminder-ladder-phase-b` @9b6d972c. Inputs: the fix-wave diff
package (4d78d0ea..adf4feeb), `adjudications-r1.md`, and the branch working tree.
No Playwright, no suites run (the orchestrator's e2e is live in this worktree).
Every `file:line` is against the BRANCH TREE at 9b6d972c, not the diff package.

Counts: **BLOCKING 0, MUST-FIX 2, SHOULD 0, NOTE 6.**

Both MUST-FIX items are IN THE FIX WAVE ITSELF - new code written to satisfy R1.
Neither is a re-litigation of a ruling. The ten R1 items are otherwise real
fixes: eight closed, one narrowed (B-N1), one closed-but-over-corrected (B-S5,
which is MF-R2-2 below). Verdict table is section 4.

---

## 1. MUST-FIX

### MF-R2-1 - the A-M2 placement e2e reads a `phone` field the roster wire shape does not have, so `rosterPhones` returns `[]` and the leg-arrival half of A-M2 never executes

**Claim.** The new placement walk's `rosterPhones` helper types the roster
response as `{ members: { phone?: string }[] }` and maps `m.phone`. The route it
calls answers `RosterView`, whose members carry `phoneLast4` and NEVER a full
`phone` - deliberately; it is the PII rule for that shape. So `rosterPhones`
returns the empty array on every call: the equality assertion fails, and the
`for (const phone of phones)` loop - the ONLY leg-arrival assertion in the whole
placement walk, i.e. the entire substance of A-M2 - has nothing to iterate.

**Evidence.**
- `e2e/tests/relay-intro-variants.spec.ts:178-183`:
  `const { members } = (await res.json()) as { members: { phone?: string }[] };`
  then `members.map((m) => m.phone).filter(...)`.
- `ownerPath` is `/api/placements/${placementId}`
  (`e2e/tests/relay-intro-variants.spec.ts:336`), so the GET lands on
  `app/src/routes/placements.ts:889-903`, which answers `describeRoster`'s
  `RosterView` (`app/src/lib/rosterResolution.ts:403-417`).
- `RosterMemberView` (`app/src/lib/rosterResolution.ts:341-358`) is
  `memberKey | contactId | phoneLast4 | name | role | reachability |
  sharesPhoneWithName`. There is no `phone`.
- The builder confirms it: `app/src/lib/rosterResolution.ts:577-586` emits
  `phoneLast4 = last4(phone)` and never the number.
- The rule is stated at `app/src/lib/rosterResolution.ts:332-339`: "a
  CONTACT-BACKED row carries no phone anywhere - `phoneLast4` is the only digits
  it exposes". The `phone:<E164>` memberKey escape applies only to bare-phone
  rows; BOTH members here are contact-backed (`createContact` ->
  `createPlacement`), so their `memberKey` is a `contactId`.

**Why the gates missed it.** The `as` cast is an assertion, not a check, so
`cd e2e && npx tsc --noEmit -p .` exits 0 on a field that does not exist. The
wave's own record flags this file as unexecuted and names `rosterPhones` as one
of the two things with no precedent (`build/fix-wave-1.md`, open worry 4) - the
worry is correct and this is the defect it was worrying about.

**Reproduce.** `e2e/tests/relay-intro-variants.spec.ts:359-360` - `phones` is
`[]`, so `expect([].sort()).toEqual([owner.phone, tenant.phone].sort())` fails
with `[] vs [2 items]`, and `:361-363` never runs. Had the equality been written
loosely it would instead have passed vacuously with zero legs asserted, which is
the worse half of this bug.

**Proposed fix.** Assert the legs against the phones the walk MINTED - the tour
walk already does exactly that at
`e2e/tests/relay-intro-variants.spec.ts:258-259`
(`expectExactSentTo(req, tenant.phone, introBody)` / `owner.phone`). If the
"server's own roster, not a list this spec assembled" property is worth keeping,
read `members[].phoneLast4` from the same route and assert it equals
`phone.slice(-4)` for each minted phone - that keeps the server as the source of
MEMBERSHIP while the numbers stay local.

---

### MF-R2-2 - the B-S5 per-row catch now swallows WRITE failures too, so a sweep that wrote nothing exits 0 and logs "done"

**Claim.** The fix wrapped the whole per-row body - plan AND write - in one
catch that counts `failed` and continues. The inner conditional-write catch
re-throws every non-`ConditionalCheckFailedException`, and that throw is now
absorbed by the outer catch instead of aborting. Nothing then escapes
`scanAndRetire`, so the top-level `.then` runs and `process.exitCode` stays 0.
A run against prod with a missing `dynamodb:UpdateItem`, a wrong `TABLE_PREFIX`,
or sustained throttling therefore reports `tourAlreadyPassed: 0,
kindRetired: 0, failed: <every row>`, logs `- done`, and **exits 0** - while the
RUNBOOK tells the operator a non-zero `failed` is "not a reason to stop".

**Evidence.**
- `app/scripts/retire-paused-tour-reminders.ts:232-233` - inner catch:
  `if (!(err instanceof ConditionalCheckFailedException)) throw err;`
- `app/scripts/retire-paused-tour-reminders.ts:240-247` - outer catch:
  `result.failed += 1;` + `logger.error(...)` + fall through to the next row.
  The two are nested, so the inner re-throw lands in the outer counter.
- `app/scripts/retire-paused-tour-reminders.ts:259-272` - `.then` logs `done`
  unconditionally; `process.exitCode = 1` lives only in the `.catch`, which no
  per-row failure can reach any more.
- `RUNBOOK.md:297` - "`failed` is rows the run could not decide (a malformed row
  is stepped over and logged by `reminderId`, never allowed to abort the sweep) -
  a non-zero `failed` is worth investigating before the apply, not a reason to
  stop." That sentence describes the PLAN-failure half only and advises the
  operator past the write-failure half it now also silently covers.
- The sibling this fix cites as its model does the opposite - `RUNBOOK.md:95`:
  "A missing `s3:PutObject` aborts on the FIRST attachment and the dry run
  cannot pre-detect it, so the run logs a PARTIAL report ... before the error and
  exits 1."

**Second half: the PARTIAL wrapper is now nearly unreachable.** With every
per-row throw absorbed, the only things that can still escape `scanAndRetire`
and trigger the PARTIAL log
(`app/scripts/retire-paused-tour-reminders.ts:131-140`) are the `ScanCommand`
itself (`:200`) and the construction calls at `:150-155`. The corrupt-row and
write-failure cases the PARTIAL report was built around cannot reach it. The two
halves of the B-S5 fix are largely mutually exclusive, and neither the wave
record nor the RUNBOOK notices.

**Does the corrupt-row test reach the failure I described in R1?** Yes -
verified. `app/test/retirePausedTourReminders.test.ts:291` writes a raw
`PutCommand` row with no `tourId`; that reaches `tourFor(undefined)`
(`app/scripts/retire-paused-tour-reminders.ts:216`) ->
`toursRepo.get(undefined)` (`app/src/repos/toursRepo.ts:266-268`) -> a
`GetCommand` whose Key marshals EMPTY under `removeUndefinedValues: true`
(`app/src/lib/dynamo.ts:87`) -> `ValidationException`. The counter
reconciliation is honest too (`scanned 6 = 1+1+3+1`). But it exercises the
PLAN-failure half only: there is no write-failure case and no exit-code
assertion anywhere in the file.

**A note on the ruling, since the charge invites it.** The over-correction is
traceable to the adjudication text, not only to the implementer:
`adjudications-r1.md:30` says "Per-row try/catch -> `failed` counter
(+ `reminderId` logged), continue" with no scoping to the plan half. My own R1
wording was equally unscoped. Flagged so the fix is not read as the implementer
exceeding the ruling.

**Proposed fix (three lines).**
1. `.then((result) => { ...; if (result.failed > 0) process.exitCode = 1; })`.
2. Keep the two causes distinguishable - a separate `writeFailed` counter, or
   let a non-conditional WRITE error escape. The PLAN half is what must not
   abort; a write failing systemically should.
3. Reword `RUNBOOK.md:297` so "not a reason to stop" is scoped to the dry run,
   and say that a non-zero `failed` on an APPLY run means those rows were not
   written.

---

## 2. What round 1 missed - re-swept with the fix diff in hand

Nothing new at MUST-FIX or SHOULD. Sweeps performed and cleared:

- **`next` consumers.** The B-MF2 exclusion has exactly two readers -
  `dashboard/src/routes/tours/RemindersPanel.tsx:210` and the e2e
  `expectReminderRung(k,'next')` locator (`e2e/scenarios/steps.ts:3655,3662`),
  used at `e2e/tests/scenarios/scheduled-visibility.spec.ts:117,269` on
  `day_before`. `confirmation` no longer arms in the lean world, so the
  exclusion changes nothing there. No third consumer.
- **A standalone relay create cannot carry an owner.** I chased a possible
  preview/send ENTRY mismatch (a standalone preview is unconditionally naked):
  `POST /api/relay-groups` (`app/src/routes/relayGroups.ts:396-465`) parses
  `members | tag | introBody` only and provisions "no tour, no placement, no
  owner row" (`:425-428`). `buildStandaloneOpenPreview`'s naked preview and the
  job's naked send agree by construction. Cleared.
- **The quiet-hours DEFERRED open drops the operator's edit entirely**, so the
  deferral path always takes the composed route and B-MF1's guard covers it:
  `app/src/routes/tours.ts:1391` `upsertPending({...})` carries no `introBody`,
  and `parseIntroBody` is not reached until `:1406` on the immediate path. (That
  the edit is silently lost on defer is pre-existing and out of scope.)
- **The lean seed holds no pending `confirmation`** - `app/src/lib/seed/lean.ts`
  seeds no `tourReminders` rows at all, so no e2e lane carries a discontinued
  rung by default. The `full`-profile rows are `sentAt`-terminal
  (`app/src/lib/seed/matrix.ts:993-1001`, `app/src/lib/seed/cast.ts:781-789`).
- **A-S5 introduces no regression for existing rows** - every `dueAt`
  `computeDueAt` writes, and every seeded/e2e row, is already canonical, so
  `due < start` (`app/src/jobs/tourReminders.ts:194`) and the old
  `row.dueAt < startIso` agree on all of them.
- **`forceSendReminder`'s clock is canonical** -
  `app/src/routes/tourReminders.ts:456` passes `new Date().toISOString()`, which
  settles NOTE-4 below as unreachable rather than latent-and-live.

## 3. Rulings challenged

Only one, and mildly: **B-S5's ruling text** (`adjudications-r1.md:30`) is the
proximate cause of MF-R2-2, as set out above. It should be re-issued with the
plan/write split named.

Everything ruled RECORD I re-checked and agree with:
- **B-N3** (`viewOf`'s `overdue` unread) - the PATCH response really is
  discarded (`dashboard/src/routes/tours/RemindersPanel.tsx:284-291`).
  Wire-shape consistency is a fair reason to keep it. No contest.
- **B-N5** (pollLoop overlap) - `app/src/jobs/pollLoop.ts:53-75` is unchanged
  and every write remains conditional. No contest.
- **B-N6** (zero-others "1 other person") - pinned at
  `app/test/relayFanOut.test.ts:832`. No contest.
- **A-N7** (force-send refuses `names_unavailable` before the past-tour gate) -
  confirmed structurally forced: the gate needs `target.tour`
  (`app/src/jobs/tourReminders.ts:1681`) and the contained target read
  (`:1651`) necessarily precedes it. No contest.
- **A-N8**, **A-N9** - re-checked. The timeline's upcoming bucket carries PENDING
  rungs only, so a swept row leaves the bucket rather than rendering an
  unlabelled reason. No contest.
- **A-S6 / B-N2** - the revert is right and B-N2 is genuinely moot: with the chip
  branch gone (`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:103-110`)
  the muted-tone fork has nothing to fork on. See NOTE-2 for its counterpart.

## 4. Are the R1 items really closed?

| id | verdict | evidence |
|---|---|---|
| B-MF1 | **CLOSED** for the composed path | `app/src/jobs/relayFanOut.ts:389-390` drops a past `scheduledAt`; the pre-existing spec-9.5 return does the rest. Three real tests: `app/test/relayFanOut.test.ts:1159` (the same-local-day case the "is it today" test cannot catch, the dated case, AND that the resolved names survive the degrade), `:1179` (strict boundary), and `app/test/toursApi.test.ts:4117` through the REAL route. Residual: NOTE-1. |
| B-MF2 | **CLOSED** | `app/src/routes/tourReminders.ts:677-679`. `app/test/tourRemindersApi.test.ts:775` carries a genuine anti-vacuity block (the excluded rung is asserted still `reminders[0]`, still `upcoming`, still chipped `discontinued`). |
| B-S1 | **CLOSED** | `dashboard/src/routes/tours/RemindersPanel.tsx:390` gate; the discontinued test extended with `queryByRole(/Send the/) -> null` plus `getByRole(/Cancel the/)`, and a new anti-vacuity case at `RemindersPanel.test.tsx:311`. Keeping Cancel/Restore is the right call. |
| B-S2 | **CLOSED** | `dashboard/src/routes/tours/RemindersPanel.tsx:78` skip; two pure cases (`RemindersPanel.test.tsx:537,552`), the second pinning both the shadowing case and that a `paused` rung is NOT skipped. See NOTE-2. |
| B-S3 | **CLOSED** | `app/src/repos/tourRemindersRepo.ts:171-179` names both gates and says the Restore button is offered on rows that clear neither - which was the half that mattered. |
| B-S4 | **CLOSED** | Both sites reworded (`app/src/services/rosterEdits.ts:26` and `:580`), with the concrete 23:00-preview / 08:00-send example. The preview clock was NOT threaded into the job, which is correct. |
| B-S5 | **PARTIAL** | Per-row isolation and the PARTIAL wrapper landed and the corrupt-row test is real - but see MF-R2-2. |
| B-S6 | **CLOSED, and better than asked** | `founder-handback-items.md` item 9 also tells her the send path already supports per-recipient bodies (member_added uses it), turning a disclosure into a decision she can act on. |
| B-N1 | **NARROWED, not closed** | See NOTE-3. |
| B-N4 | **CLOSED** | `app/src/jobs/tourReminders.ts:739-741`; the test's real assertion is the reconciliation `manualOnly + discontinued === heldBack` (`app/test/tourReminders.test.ts:3813-3815`), which is order-independent and would have read 2x under the bug. |

## 5. NOTE

- **NOTE-1 - B-MF1 guards precedence 2-4 only; an operator-EDITED `intro_body`
  still sends verbatim past the tour.** `app/src/jobs/relayFanOut.ts:987` applies
  `edited` before any owner read. The deferral path is safe (the edit is dropped
  at `app/src/routes/tours.ts:1391`, above), so the only reachable case is a
  `connecting` group whose number purchase straddles the tour start with an
  edited body - very narrow, and defensible under precedence 1's "a human chose
  it" rule. Recorded because the new docblock at
  `app/src/jobs/relayFanOut.ts:349-351` reads unconditional ("A tour that has
  ALREADY STARTED is treated exactly as a tour with no time at all - naked") and
  is not.
- **NOTE-2 - the wave applies opposite policies to the same excluded surface, in
  one commit.** A-S6 REVERTED the `discontinued` chip branch from
  `DeadlinesNudgesCard` because "the placement card is an EXCLUDED surface ...
  unreachable code widening a surface the spec narrowed on purpose"
  (`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:103-110`). B-S2 then
  gave `nextReminderRefetchDelay` a `discontinued` skip
  (`dashboard/src/routes/tours/RemindersPanel.tsx:78`) whose docblock (`:65-67`)
  advertises the placement sharing as the reason for the wider parameter type -
  and `dashboard/src/routes/placements/usePlacementNudges.ts:109` does call it,
  so placement nudges now get the discontinued behaviour the chip revert
  removed. Harmless (nothing emits it) and the tour behaviour is needed, but the
  two comments now argue with each other.
- **NOTE-3 - B-N1 is narrowed, not closed: `added` and `bodyFor` are decided
  from TWO DIFFERENT reads of the conversation.** The handler reads it at
  `app/src/jobs/relayFanOut.ts:1048`; `sendRelayAnnouncement` reads it AGAIN at
  `app/src/services/relayAnnouncements.ts:178` and applies `bodyFor` to THAT
  roster. A remove landing between the two still produces the original defect
  (handler sees the joiner -> persists `newMemberBody`; the announcement's
  roster does not -> no leg carries it), and the converse is newly possible. The
  fix's comment at `app/src/jobs/relayFanOut.ts:1082-1086` states an invariant
  the double read does not guarantee. Much narrower than before and still only a
  NOTE; the honest close would key the persisted body off whether `bodyFor` ever
  matched.
- **NOTE-4 - `retiredByTourStart` now has a MIXED contract: two operands are
  instants, one is a string.** `app/src/jobs/tourReminders.ts:194` compares
  `due < start` by instant but `now >= startIso` by text. NOT reachable today -
  every caller passes a canonical string
  (`app/src/jobs/pollLoop.ts:59` for the poll, the dev route's normalized tick
  echo, `app/src/routes/tourReminders.ts:456` for force-send, and the sweep's
  own default at `app/scripts/retire-paused-tour-reminders.ts:154`) - and the
  wave recorded the choice deliberately (open worry 2). My only objection is
  shape: A-S5 was raised precisely because a half-normalized comparison is
  invisible, and an exported predicate whose three operands follow two different
  rules is where the next one hides. One line closes it.
- **NOTE-5 - an unparseable `deps.nowIso` silently disables the past-tour gate.**
  `app/src/jobs/relayFanOut.ts:390`: `startedAt < Date.parse(nowIso)` is `false`
  when `Date.parse(nowIso)` is `NaN`, so the tour variant composes. Not reachable
  in production (`quiet.nowIso` and the job default are both ISO-produced), and
  failing OPEN is arguably right for a copy resolver that must never throw.
  Recorded so it reads as a choice rather than an accident.
- **NOTE-6 - `expectRungsSuperseded` is a verbatim clone of
  `expectRungsRetiredPastTour`.** `e2e/scenarios/steps.ts:2128-2151` vs
  `:2096-2120` differ only in the expected `skipReason` and two error messages.
  The assertion itself is sound and I traced the call site: at
  `justAfter(times.enRoute)` on a +48h booking the batch is
  `{morning_of, en_route}`, `now < scheduledAt` so the past-tour gate does not
  pre-empt it, and `day_before` fired earlier and is out - so
  `quiet_hours_superseded` on `morning_of` is the right expectation
  (`e2e/tests/scenarios/tours.spec.ts:271`). Only the duplication is worth a
  word; one helper taking the reason would do.
