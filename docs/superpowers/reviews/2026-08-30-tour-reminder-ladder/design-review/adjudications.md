# Design review adjudications - tour reminder ladder

Planner: this session. Human: Cameron.
Docs: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`,
`docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md`.

## Process note - read this before round 2

This record is written RETROACTIVELY. Round 1 was run before the
feature-mission skill was loaded, so it deviated from the documented process
in ways round 2 must account for:

- Reviewers used planner-authored briefs, not `design-review-briefs.md`. The
  briefs were LONGER than the skill's, which the charter notes say does not
  improve recall - it only shifts which finding classes surface. Treat round 1
  recall as unrepresentative, not as a ceiling.
- The PLAN got ONE reviewer where the skill requires TWO in round 1. Its recall
  is single-sample and therefore high-variance. A second reviewer is being
  dispatched in round 2 with the skill's brief to recover that coverage.
- Reviewers returned long prose rather than the skill's numbered
  severity-labelled list written to an OUT PATH. Their findings are recorded
  below in the planner's words, which is itself a fidelity risk.

MOST IMPORTANT: the planner ACCEPTED essentially every finding across all three
reports. The skill warns that a document which accepts everything has no author.
That accept rate is a signal to probe, not a badge. Round 2's job includes
asking whether any of these accepts were WRONG - an accepted-but-mistaken
finding is now baked into the spec and the plan, and no one has challenged it.

Severity labels below are the REVIEWERS' own. Per the skill they do not drive
the round loop; whether a DECISION CHANGED is the planner's call, recorded in
the Decision column.

---

## Round 1 - SPEC - Reviewer A (adversarial, cold-build lens)

| # | Finding | Ruling | Decision changed |
| --- | --- | --- | --- |
| B1 | The ladder is already manual-only; the spec is written as if retiming changes send timing | ACCEPT | YES - reshaped the whole document. New section 2; Cameron ruled the pause holds for Phase A |
| B2 | Skip rule `dueAt` ambiguous (raw vs clamped); the "same instant" equivalence is false | ACCEPT | YES - section 8 now pins RAW explicitly and deletes the false claim |
| B3 | Section 7 contradicts itself on skipped-row visibility; no skip reason exists | ACCEPT | YES - section 8.1 decides visible rows; 8.2 adds `booked_too_late` |
| B4 | The MessageId cast is unguarded and this change makes it live in three places | ACCEPT | YES - section 9.1 plus an exhaustive matrix test |
| B5 | 19:30 is silently killed by `staleDayBefore` when quiet hours start <= 19:30 | ACCEPT | YES - section 7.1, warn plus a required test |
| H1 | Exemption hook specified against the wrong function; second fire-time site missed | ACCEPT, then ESCALATED to DEFER | YES - initially corrected, later CUT from Phase A entirely (see plan H3) |
| H2 | Property-contact resolution re-specified instead of reused; zero-primary case missed | ACCEPT | YES - section 6.1 now reuses the established resolver |
| H3 | New contact reads have no failure semantics on read paths | ACCEPT | YES - section 6.3 splits absence from read failure |
| H4 | `no_show_checkin` short-circuits above the vars; adding a token throws | ACCEPT | YES - section 9.2 |
| H5 | "The booking instant" is wrong; it is the arm instant, and reschedules re-arm | ACCEPT | YES - section 8 preamble |
| H6 | Test suite list incomplete; e2e blast radius understated | ACCEPT | YES - section 13 |
| M1 | A short-notice booking can produce an all-skipped ladder | ACCEPT | NO - stated as a consequence, no mechanism change |
| M2 | The "Morning of" operator label becomes a lie | ACCEPT | YES - relabel decided in section 11 |
| M3 | No segment-length budget on the new copy | ACCEPT (as a measurement obligation, not a spec constraint) | NO - measured at gate time, not designed against |
| M4 | `sameDay` timezone unstated; DST edge uncovered | ACCEPT | YES - section 8 binds the zone; section 13 owes a DST test |
| M5 | The e2e marker invariant is restated in its pre-change form | ACCEPT | YES - section 13 |
| M6 | In-flight rows keep old dueAts; never decided | ACCEPT | YES - section 9.3 |
| M7 | Unstated whether entries still declare `when`/`time` they no longer use | ACCEPT | YES - section 6 says declare |
| M8 | `confirmation`'s `MANUAL_ONLY_REMINDER_KINDS` rationale becomes false | ACCEPT | YES - section 9.4 |

## Round 1 - SPEC - Reviewer B (factual verification)

Reviewer B CONFIRMED, against file:line: the interpolation semantics; that
`ReminderKind` is persisted and `MessageId` is not; `resolveQuietHoursTimezone`
and the D8 rule; `instantAtLocalTime`; the `seedLive` drift guard; the routing
section; and that the transcribed founder copy is character-exact. Those are not
findings and needed no ruling.

| # | Finding | Ruling | Decision changed |
| --- | --- | --- | --- |
| A | Exemption hook: wrong function, and a second kind-blind gate exists | ACCEPT (duplicate of A/H1) | YES |
| B | `no_show_checkin` has TWO throw sites, one bypassing the composer | ACCEPT | YES - section 9.2 names both |
| C | The call-site guard test does not enforce what the spec claimed, and whitelists the bypass | ACCEPT | YES - section 10 |
| D | Call-site count is four in src plus the harness, not six | ACCEPT | YES - section 10 corrected |
| E | Two arm-time skip postures exist; past-dueAt writes NO row | ACCEPT | YES - section 8.1 |
| F | Property contact resolves from the roster flag, NOT the `primary_contact` scalar | ACCEPT | YES - section 6.1 |
| G | `no_show_checkin`'s `computeDueAt` case is never reached in production | ACCEPT | NO - clarifying note only |
| - | The section 13 pipe anecdote was UNSOURCED | ACCEPT | YES - reattributed to the session it happened in |

## Round 1 - PLAN - Reviewer C

| # | Finding | Ruling | Decision changed |
| --- | --- | --- | --- |
| B1 | Task 1's test contradicts Task 1's own implementation | ACCEPT | YES - helper narrowed; surname fallback explicitly refused |
| B2 | `computeDueAt` is not exported; Task 5 could not run | ACCEPT | YES - export is now an explicit step |
| B3 | `npm run typecheck` typechecks tests; eight test call sites break | ACCEPT | YES - folded into the signature task |
| B4 | `failed` is produced, tested, then never consumed | ACCEPT | YES - now its own task with tests |
| B5 | The e2e ladder mirror is the hardest change and got one clause | ACCEPT | YES - its own task, gated by e2e |
| H1 | The arm loop discards raw dueAts; rules would compare clamped | ACCEPT | YES - task now requires a second raw map |
| H2 | Task 6 named ~11 undefined identifiers and no concrete instants | ACCEPT | YES - concrete fixtures written |
| H3 | The exemption hook is not writable as specified; no injection points | ACCEPT, ESCALATED | YES - hook CUT from Phase A; spec 7.3 amended. Building an unreachable, untestable hook to make a later one-liner easier is not worth the surface |
| H4 | No calendar-day helper exists | ACCEPT | YES - `shiftLocalDate` is now its own task |
| H5 | Double unit reads; the spec's batching requirement had no task | ACCEPT | YES - folded into the failure-semantics task |
| M1 | `seedLive` breaks in three ways and no task owned it | ACCEPT | YES - assigned explicitly |
| M2 | `idFor`'s code block cannot implement the sentence beneath it | ACCEPT | YES - signature takes the resolved name |
| M3 | Token rule over-applies; the no-declare assertion was missing | ACCEPT | YES - both twins excluded; assertion added |
| M4 | No task closes the issue registry entries | ACCEPT | YES - now Task 12 |
| M5 | Task 8's second test is in the wrong file | ACCEPT | YES |
| M6 | The no-show draft route needs plumbing the plan did not mention | ACCEPT | YES |
| M7 | Reschedule path and the read/write failure split had no tests | ACCEPT | YES |
| - | Task 4 prose acceptable; Task 9 prose not, but scope is the reason | ACCEPT | YES - Task 9 split into a sweep and a dedicated e2e task |

Reviewer C also independently CONFIRMED the composer call-site enumeration, the
Task 5 arithmetic (including the DST case), the Task 6 boundary reasoning, the
`tourScheduleFullLadder` re-derivation, and that the pause is adequately fenced
in Global Constraints.

---

## Standing open questions for round 2

1. Which of the above ACCEPTS were wrong? Nothing has challenged a single one.
2. The spec and plan were both rewritten wholesale after round 1. That new prose
   has never been reviewed by anyone.
3. Does cutting the exemption hook leave the spec self-consistent? Section 7.3
   was amended but section 12's open items were not re-read against it.
4. Round 1 used non-standard briefs; a finding class the skill's briefs target -
   unenumerated mutation surfaces AND readers - may be under-covered.

---

# ROUND 2

Three reports, ~51 findings, 10 of them BLOCKING. Full text on disk:
`spec-r2-adversarial.md`, `plan-r2-continued.md`, `plan-r1b-fresh.md`.

Round 2 is NOT terminal: ten blocking findings changed decisions. Round 3 follows.

## Process observations that outrank individual findings

1. THE FRESH PLAN REVIEWER FOUND FOUR BLOCKERS THE CONTINUED ONE MISSED, and
   vice versa. Overlap was partial. This is the exact recall variance the
   two-reviewer round-1 rule exists for, and round 1 skipping it cost a round.
2. TWO FINDINGS ARE SELF-INFLICTED BY THE ROUND-1 REVISION: plan line 286 tells
   the builder to copy tests "verbatim from the previous plan revision" (a doc
   they do not have), and Tasks 6 and 9 contradict each other on seedLive. Both
   were introduced by the rewrite that fixed round 1. CONSEQUENCE: round 3 uses
   SURGICAL EDITS, not another wholesale rewrite. Two rewrites, two new defect
   classes, is enough evidence.
3. THE CONTINUED PLAN REVIEWER CONCEDED ONE OF ITS OWN ROUND-1 FINDINGS (M3,
   accepted on a wrong premise). That is the re-review charge working; the
   correction is folded in below.
4. ONE ROUND-1 ACCEPT WAS MISTAKEN and is now reversed (spec 6.2, below). It
   would have shipped as a spec instruction to violate a documented scope guard.

## Rulings

ACCEPTED - blocking, each changed a decision:

- pm_team was DELETED from the spec by the round-1 rewrite. Restored. It is 1/3
  of demo tours (`seed/matrix.ts:930`) and the lean seed has none, so e2e
  structurally cannot catch its absence.
- Spec 6.2 named a first-name helper that does not exist in `contactName.ts`,
  which carries an explicit scope guard ("consumed by PUSH-COPY sites only ...
  do not re-point them here as a drive-by") and a tracking issue. REVERSES a
  round-1 ACCEPT. The helper goes elsewhere; the guard is honoured.
- Skip-rule precedence over past-dueAt was specified for rule 1 only; rule 2 has
  the identical overlap, so the MOST-late booking still vanishes silently.
- `confirmation` is load-bearing in the harness: the e2e suite's only
  "fire a reminder now" vehicle (14 sites / 3 specs) and ~40 structural sites in
  `tourReminders.test.ts`.
- Task 8's TDD red state was already GREEN: `resolveReminderTarget:646` has no
  try/catch, so today's behaviour already satisfies the test. `failed` would
  have shipped dead behind a passing gate.
- Plan line 286 references a document the builder does not have.
- Tasks 6 and 9 contradict each other on `seedLive.test.ts`.
- The 19:30 org-local rung breaks `quiet-hours.spec.ts`'s explicit
  "deterministic at ANY wall clock" contract, reintroducing the documented
  time-of-day flake class. The plan framed this as arithmetic.

ACCEPTED - high/medium, each changed a decision:

- `forceSendReminder` is unnamed in the failure-semantics task, and in Phase A
  it is the ONLY live send path.
- "Resolve contacts once per request" is the WRONG key: the property contact
  varies per tour, so the stated optimisation would stamp one person's name onto
  every tour's preview.
- `tourCopy.test.ts:115` already HARD-GATES `segments === 1`. "Measure and
  report" was wrong; this is a design constraint on the founder's wording with a
  ~19-character margin.
- A THIRD hardcoded `scheduledAt - 24h` exists at `seed/matrix.ts:958` carrying a
  parity comment this change falsifies.
- Unenumerated surfaces: `documentation/tours-sequence-writeup.md:110`,
  `seed/live.ts`, `e2e/support/selectors.md:72`, `tour-comms-pane.spec.ts`,
  `tour-roster.spec.ts`, `relayGroups.ts:243` (composes inside a synchronous
  `.map()`).
- Spec section 12 still claimed the hook "is built here" - the contradiction the
  round-1 adjudications PREDICTED and the rewrite failed to fix.
- The hook-cut CONCLUSION stands (reachability independently verified) but the
  stated JUSTIFICATION is over-broad: site 1, the arm-time clamp, IS reachable.
  The written reason is what survives, so it is corrected.
- The rule-1 ordering labelled CRITICAL is exercised by NO fixture; both
  boundary tests pass either way.
- Task 5's red state is type-only, so vitest strips it and it is never red.
- Nine skip reasons exist, not eight (`invalid_schedule`); the app and dashboard
  unions are hand-duplicated, so omitting the dashboard half degrades silently.
- `booked_too_late` makes near-term ladders LONGER, not shorter.
- `shiftLocalDate` misses NaN; `nonEmpty()` guard dropped from the reused rule.

REJECTED:

- "The '4 hours before' label is falsified by clamping for early tours" (spec
  r2 #12, LOW). REJECT. Every rung label is nominal under clamping - "Day
  before" has always had the same property - and the panel renders the ACTUAL
  dueAt beside the label, so the operator is never misled in practice. A
  clamp-aware label would be less legible, not more honest. The relabel from
  "Morning of" stands because that name was wrong at EVERY setting, not only
  under a clamp.

DEFERRED:

- "The zero-primary leg of the property-contact fallback has no e2e path" (spec
  r2 #14, LOW). DEFER. Giving it one means changing the lean seed, which is a
  byte-stable shared fixture and its own change. The owed unit test is the
  guard; filing a registry note instead.
- "`booked_too_late`'s genuine-ABSENCE test may be unreachable on the 1:1 poll
  path" (plan r1b #15, MEDIUM). DEFER pending verification during the build -
  the reviewer marked it "may be" and it is cheaper to settle with the code in
  front of you than to design around it now.
