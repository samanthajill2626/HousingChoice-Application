# Plan review - round 2, reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md` (r2)
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Read this round: the rewritten plan in full, the adjudications, reviewer A's r1
report, and every file:line cited below. Focus per the dispatch: T8.3 and S8
first, then the rewritten tasks cold, then the adjudications.

Round-1 fixes verified as correctly landed before the findings: T1.4's raw
`GetCommand` assertion (closes my F10 exactly - `listByTour` named as vacuous
with the right reason); T1.5's do-not-copy-the-`pending`-filter clause
(`tourRemindersRepo.ts:412-414` is the filter, correctly excluded); T1.6's
three-part fake instruction including the `create`-drops-`ladderId` hazard the
scar comment at `twilioWebhookHarness.ts:2939-2946` documents; T5.1's two-union
statement with the `discontinued` short-circuit precedent (the pattern is real -
`routes/contactTimeline.ts:1029-1031`, `routes/tourReminders.ts:642-655`
short-circuit ahead of the evaluator); T5.4's `pending:` prefix
(`placements.ts:699`) and the string-predicate warning (the `:669` fast path is
exactly the trap named); T6's pre-migration exemption; T7.4's collapsed default;
T10.5's six-writer table with `scrollToBottom :1840-1846`; T10.4's unconditional
sentinel; T10.7's `NARROW_360` + mechanism-assertion reframe; T10.8/T10.9; T3.6;
S11 reopened with a grep instruction.

---

## F1 (BLOCKING) - T8.3 contradicts the spec the plan exists to deliver, and the spec was not amended

The plan's header says the builder's deliverable is the spec. The spec says, in
the section that governs exactly this path:

- Spec 3.2, line 88: "**Conversion** (`routes/placements.ts:716`) does NOT
  touch the pointer." Lines 88-100 then argue the position at length (the
  reversible claim marker, the deferral, "the sweep runs only after the
  FINALIZE succeeds").
- Spec section 4, line 273: "Writers of the tour row: `currentLadderId`,
  written by the CALLER (D3a) on create, on re-arm, and rotated on terminal
  transitions." Conversion is not in the list.

T8.3 says: "ROTATE the pointer with the sweep, after finalize." Both documents
are handed to a no-context builder as authorities; they give opposite
instructions on the same write. This is not pedantry - the spec's paragraph is
a REASONED argument against touching the pointer here, so a conscientious
builder who reads it will conclude T8.3 is the error and skip it, silently
reopening PB-2. The same drift exists in three more load-bearing places:

- Spec 3.2's deferral is "bounded - the claim either finalizes ... or is
  released ... so nothing re-lists forever" and acceptance 7 says a claim-window
  rung is "deferred, not retired". T5.4's new grace-window RETIRE (correct in
  substance - see F4) does something the spec's own acceptance wording forbids.
- Spec 3.6 still enumerates FIVE scroll writers ("The spec's earlier drafts
  specified one of five"); T10.5 now converts SIX. The spec's list is the one a
  builder will treat as the checklist.
- Spec R5's claim that "the pointer check lowers a missed row's consequence
  from 'sends' to 'appears in earlier'" is true at conversion ONLY because of
  T8.3 - a task the spec's own text says not to perform.

What it implies: amend the spec (3.2's conversion paragraph, the section-4
writer list, acceptance 7's wording, 3.6's count) or put an explicit
"plan supersedes spec on these four points" note in both documents. Until one
of those happens, a literal builder cannot produce "the spec" because the spec
disagrees with itself-as-extended-by-the-plan. I agree with the ADJUDICATION's
reasoning (rotation was only unsafe pre-finalize, where reversibility
mattered - R5-5's objection was to irreversible claim-skips and to a
pointer-restore dance, neither of which exists post-finalize); the defect is
that the reasoning lives only in the adjudication file.

## F2 (HIGH) - T8.3 as a SEPARATE write keeps a slice of the very gap it closes; fold the rotation into the finalize patch

The finalize is one `tours.patch(tour.tourId, { status: 'closed',
convertedPlacementId: created.placementId })` (`placements.ts:758`), and
`tours.patch` takes an arbitrary updates dict (`toursRepo.ts:319-347`). The
rotation can ride it: `currentLadderId: <fresh UUID>` in the SAME patch. As
written, T8.3 is a write AFTER finalize, which leaves:

- **The gap, still open.** T5.4's deferral ends the instant finalize replaces
  the sentinel; until the separate rotation lands, the rungs are due-eligible,
  pointer-MATCHED, undeferred - a poll tick in that window sends on a converted
  tour. Smaller than the r1 hole, same species. The plan's slice-order
  guarantee ("every armed rung either sends correctly or is refused") is still
  false at S8 for that window, and the guarantee is stated as absolute.
- **A rotation-failure branch T8.4 does not cover.** T8.4 gives the SWEEP a
  failure posture and says "the rotated pointer from T8.3 is what keeps a
  missed row harmless" - but if the rotation itself throws after finalize, the
  pointer matches forever, the sweep's own posture is irrelevant, and we are
  back at PB-2 verbatim. Folding makes rotation-failure identical to
  finalize-failure: claim released, tour still armed, retryable - the exact
  posture T8.2 already tests.
- **An unstated order.** "Rotate the pointer WITH the sweep" - which first?
  Sweep-then-rotate, with the rotation failing, deletes rows while the
  survivors still match the pointer. Spec 3.2's other paths are explicit
  (rotate, THEN sweep); T8.3 must be too if it stays a separate write.

The fold is the plan's own idiom - T3.2/R4-5 exist precisely because "riding
the patch ALREADY being written" closes a stale-pointer window and saves a
write. Applying it here eliminates the gap, the failure branch, and the
ordering question in one sentence.

## F3 (HIGH) - T5.4 has no position in `processReminderRow`, and one wrong position re-creates R5-5's irreversibility through a different token

T5.3 got a "Placement matters" note; T5.4 - in the same function, with the same
hazard - got none. The ladder as it stands: tour read (`:1049`), past-tour gate
(`:1058`, claim-skips `tour_already_passed`), release supersession
(`:1086-1099`, claim-skips `quiet_hours_superseded`), quiet backstop (`:1116`),
target resolution (`:1128`, claim-skips), roster gates.

Place the deferral check below `:1086` and a converting tour with two rungs due
in one catch-up batch gets its earlier rung claim-skipped
`quiet_hours_superseded` DURING the claim window - a TERMINAL stamp
(`tourRemindersRepo.ts:361`) that releasing the claim can never undo. That is
R5-5's exact defect, reintroduced through a stamp the deferral was invented to
prevent, and acceptance 7 ("NONE of them stamped") fails only if the test
happens to put two rungs in one batch - which no planned test does.

The deferral must run after the tour read at `:1049` and ABOVE `:1086`. Its
position relative to the past-tour gate is arguable (that stamp is honest
regardless of the conversion's outcome, and the gate would restamp next tick
after any release) - fine, but the plan must SAY where it goes and why, in a
function whose own comment says position is behaviour.

## F4 (HIGH) - T5.4's grace-window retire names no skip token, and every existing token is a lie

The bounded-wait pattern the task cites retires with a SPECIFIC token -
`roster_unavailable` at `:1204`, `names_unavailable` at the twin site - and the
panel renders that token through the census surfaces. T5.4 says "retire the
rung visibly rather than deferring again, and log" and stops. The builder's
options:

- `superseded` - false (nothing superseded this ladder; the pointer still
  matches) and terminal on a ladder that is still nominally current;
- `tour_already_passed` / any other existing token - false;
- a NEW token - correct, but that is a new `ReminderSkipReason` member that
  re-runs the entire T5.2 census (labels, mirror, hand-lists, possibly
  `SEND_NOW_ERROR_COPY`), and the plan does not say so.

Name the token (something like `conversion_stuck`, wording to taste), say it is
poll-only like `roster_unavailable`, and fold it into T5.2's census explicitly.
Note this is also half of F1: the spec's acceptance 7 wording currently forbids
ANY claim-window retire, so the token needs a spec-side sentence too.

## F5 (HIGH) - T1.3 widens `ToursRepo`, and the harness fakes THAT repo too - the exact trap T1.6 just fixed, one interface over

`app/test/helpers/twilioWebhookHarness.ts:2801`:
`const toursRepo: ToursRepo = { ... }` - an explicit annotation, same as the
reminders fake at `:2930`. T1.3 adds a value-guarded write to `ToursRepo`
(method or `patch` option). Either way the tours fake must change: a new
interface method fails S1's typecheck gate exactly as T1.6 item 1 describes
for the reminders fake; a `patch` option is quieter but the fake's `patch`
must then IMPLEMENT the compare-or-refuse semantics, or every route-level
suite that exercises T3.3's logic (they run on `makeWebhookHarness` -
`toursApi.test.ts:1255`) is testing against a fake that never refuses.
Neither T1.3 nor T1.6 mentions the tours fake. One clause in T1.3: "the
harness's `toursRepo` fake (`twilioWebhookHarness.ts:2801`) gains the same
guarded write with real compare semantics; the DynamoDB-Local test remains the
proof of the real ConditionExpression."

## F6 (MEDIUM) - T7.6 delegates the decision it was created to make

R1's finding was that the plan lacked one sentence of specification: after
T7.1's partition, where does the `superseded` annotation render? T7.6 now
answers: "Decide and state which view carries what." That is an instruction to
the builder to write the missing sentence, not the sentence. Acceptance 4
already forces the answer: the panel must render a sweep-missed rung
"suppressed `superseded`", and after the partition that rung lives ONLY in
`earlier[]` - so the earlier view carries `suppression`, and the disclosure
renderer shows the chip on its `upcoming` (sweep-miss) rows. Write that into
T7.6 and delete "decide".

## F7 (MEDIUM) - T3.2 leaves the existing cancel call's fate unstated for five slices, and both misreadings break the guarantee

T3.2: "Rotate the pointer ... Then sweep (S9), arm, then T3.3." The existing
`cancelTourReminders` at `tours.ts:1190` is not mentioned. Between S3 and S9 it
is the ONLY thing retiring the old generation (refusal does not exist until
S5). A builder who deletes it at S3 (reading the task's four-step sequence as
the complete new body) leaves the old generation live and due - both
generations SEND between S3 and S5. A builder who reads "(S9)" as "call the
sweep now, it exists since S1" deletes before refusal - the exact thing the
slice table forbids. One sentence: "the existing `cancelTourReminders` call
stays exactly where it is until S9 swaps it; do not remove or reorder it in
this slice."

## F8 (MEDIUM) - T5.2's census method has one probe for two unions

"Grep for every map and union keyed by an existing reason token
(`discontinued` is the best probe)" - `discontinued` exists only in the
SUPPRESSION union and finds only its surfaces (`scheduledSendSuppression.ts:9-11`,
`types.ts:1147/1286/1184`, `ScheduledCard.tsx:19`, `DeadlinesNudgesCard.tsx:64`,
`types.test.ts:157`). The SKIP-side surfaces - `REMINDER_SKIP_REASON_LABELS`
(`types.ts:1301`), the mirrored skipReason union (`:1223`), `SKIP_REASONS`
(`types.test.ts:98`), and the 409-code side (`ForceSendRefusal`,
`jobs/tourReminders.ts:1538-1574`, plus `SEND_NOW_ERROR_COPY`) - are invisible
to that probe. Name a second probe that lives in all of them:
`tour_already_passed` appears in the skip union, its labels, the hand-list,
`ForceSendRefusal` (`:1570`) and `SEND_NOW_ERROR_COPY` (`types.ts:1366`). Two
probes, one per union, and the method actually terminates the census.

## F9 (LOW) - T4.1's "inline" pointer write still glosses a real ordering question

`live.ts:490-492`: seedAll's Put loop persists the tours BEFORE `seedLive`
arms. So "set `currentLadderId` inline from each arm's returned `ladderId`"
is either a post-arm patch of an already-written row or a reorder (arm first -
legal, `armTourReminders` takes the in-memory `TourItem` and never reads the
table - then write the tour rows carrying the pointer). Either works; the task
should pick one so two builders do not pick both.

## F10 (LOW) - Conversion still emits no `scheduled.updated`; post-T8.1 the buckets go stale against DELETED rows

`placements.ts` emits only `placement.updated` (`:461`, `:1447`) and
`tour.updated` (`:849`); the tours.ts ladder paths emit `scheduled.updated` on
every ladder change (`tours.ts:1214-1216`). Today's conversion cancel path has
the same silence, so this is parity, not regression - but after S8 the stale
promise is backed by rows that no longer EXIST rather than canceled ones.
Accepted staleness should be a stated one-liner in S8, not an accident.

---

## Adjudication contests

- **PB-2's remedy record**: the reasoning ("rotation was only unsafe BEFORE
  finalize") is sound and I accept it - but the record does not note that spec
  3.2/section-4 text now argues against the accepted fix. That is F1; the
  adjudication should carry the spec-amendment as an owed item, or the next
  cold reader of the spec re-raises R5-5 against T8.3 in good faith.
- **PA-6/PB-8's "bounded by the documented grace-window pattern"**: adopted
  the pattern minus its load-bearing half - the token and its copy surfaces -
  and minus the acceptance-7 conflict. Partial, not complete (F4).
- Everything else I re-checked stands, including the ones where the
  coordinator conceded error (R2-5, R2-10, PA-2/PB-1): the concessions match
  the code.

## The slice-order guarantee, re-tested end to end

S1 inert (with F5's caveat that typecheck forces the tours fake too). S2 no
readers. S3 safe IF the old cancel stays (F7). S4 before S5, correctly forced.
S5-S7 refuse/group while the old cancel path still stamps: safe. S8: the
guarantee now holds up to the finalize-to-rotation write gap and the
rotation-failure branch - both eliminated by F2's fold, neither eliminated as
written. S9 safe given S1+S5. S10/S11 independent. Verdict: the guarantee is
one folded write away from true, and is currently overstated.

## The plain answer

If a builder with no context executed this plan literally today, would they
produce the spec? **No - and the task that stops them is T8.3.** Not because
its mechanism is wrong (it is right), but because the spec it is ordered to
deliver still says, in a reasoned paragraph, "Conversion does NOT touch the
pointer" (spec 3.2:88) - a literal builder either follows the spec and
silently reopens PB-2, or follows the plan and ships something the
authoritative document forbids; nothing in either file tells them which wins.
Behind that, T5.4 (F3/F4) is the only task a diligent builder cannot complete
without inventing policy: an unspecified position in a position-is-behaviour
function, and a retire with no token to retire WITH. Everything else in the
plan is now executable as written.
