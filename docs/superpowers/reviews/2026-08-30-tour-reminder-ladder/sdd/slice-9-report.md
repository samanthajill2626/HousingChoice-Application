# Slice S9 report - Task 10: seeds, prose, and the issue registry

Branch `feat/tour-reminder-ladder`, worktree `W:\tmp\tour-reminder-ladder`.
Base at slice start: `0f30c9b5` (clean). ONE commit produced: **`6e34c95d`**.
11 files changed, 388 insertions, 63 deletions.

Scope delivered: the plan's Task 10 Steps 1-8 in full, plus worklist addendum
items A10-1 through A10-10 (A10-11 was delivered by S1).

---

## Per step - what changed and where

### Step 1: `app/src/lib/seed/matrix.ts`

- **Imports** (`app/src/lib/seed/matrix.ts:27-29`): added
  `DEFAULT_ORG_SETTINGS` from `'../../repos/settingsRepo.js'`,
  `{ instantAtLocalTime, localDateOf }` from `'../quietHours.js'`, and
  `{ shiftLocalDate }` from `'../localTime.js'`. Relative paths match the
  existing `'../../repos/placementDeadlinesRepo.js'` style at `:26`; there was
  no in-seed precedent for `DEFAULT_ORG_SETTINGS` (research-6 B1 confirmed no
  seed file imports it today).
- **The `day_before` parity site** (`:960-969`, formerly the single-line `:958`):
  replaced `iso(scheduledMs - 24 * HOUR_MS)` with the plan's 19:30-org-local
  computation, under the plan's parity comment verbatim.
- **The pending-branch comment** (formerly `:984-985`, now `:995-998`,
  correction C11): rewritten - it said the dueAt was `scheduledAt - 24h`. Now
  states 19:30 org-local the evening before and why a 3-5-day-out tour still
  cannot live-fire. `:991`'s "sentAt / canceledAt absent = pending" comment is
  still true and was left alone.
- **THE CANCELED-ROW ORDERING TRAP** (`:1006-1014`): applied the plan's
  `Math.max` fix verbatim, with the plan's comment. The invariant
  `createdAt <= dueAt <= canceledAt` now holds BY CONSTRUCTION at any reseed
  wall clock, not only at the coherence test's pinned 08:00 EDT.
- `grep -n "dayBefore" app/test` returned pins only in `seedLive.test.ts`,
  `seedMatrixCoherence.test.ts` and `tourReminders.test.ts`. The coherence
  test's only `day_before` assertions are structural (`pending`,
  `dueAt > NOW_MS`), not literal instants, so nothing needed re-deriving. The
  other two files belong to earlier slices and were not touched.

### Step 2: `app/src/lib/seed/cast.ts`

- `day_before` dueAt/sentAt `'2026-05-09T18:00:00.000Z'` ->
  **`'2026-05-09T23:30:00.000Z'`** (19:30 EDT May 9), `:794` / `:796`.
- `morning_of` dueAt/sentAt `'2026-05-10T08:00:00.000Z'` ->
  **`'2026-05-10T14:00:00.000Z'`** (T-4h), `:803` / `:805`.
  Ordering re-checked: `CW` (May 8 10:05Z) <= May 9 23:30Z <= May 10 14:00Z <=
  scheduledAt (May 10 18:00Z).
- `:768`'s comment updated to name the two retimed instants and the retiming
  date, and to carry the `sentBody` DECISION (see below), at `:768-780`.

### Step 3: `app/src/lib/seed/live.ts` (prose only - the arming CODE is untouched)

- `:9-13` header: "Full 5-rung reminder ladder" -> the four auto-armed rungs
  named with their new timings, plus "no_show_checkin is a MANUAL send and
  never auto-arms".
- `:369` TOUR-B inline comment: "full reminder ladder" -> "all four auto-armed
  rungs".
- `:504-513` TOUR-A: rewritten. The old text said the near rungs are "skipped
  if their dueAt < now"; they are now retired as VISIBLE `booked_too_late`
  rows, which is what `seedLive.test.ts` already asserts.
- `:522-527` TOUR-B and `:536-537` TOUR-C: "all 5 rungs should arm" -> "all
  FOUR auto-armed rungs arm", with the new timings named on TOUR-B.
- Post-edit `grep -n "5 rungs\|five rungs\|5-rung\|ladder"` returns only
  accurate lines.

### Step 4: `documentation/tours-sequence-writeup.md`

- Ladder table (`:112-116`): rewritten to the plan's table verbatim
  (`confirmation` immediate, `day_before` 19:30 org-local the evening before,
  `morning_of` 4 hours before with the staff label, `en_route` 1h before,
  `no_show_checkin` +30m manual send).
- Paragraph below (`:118-135`): kept the durability/reschedule sentences,
  removed the false "Rungs whose time is already past when armed are skipped",
  and added two paragraphs - the booked-too-late rules (both stated against the
  RAW offsets and the ARM instant, matching `armTourReminders`'s pass-2 rule
  list), which retirements are VISIBLE vs the single SILENT one, and the fact
  that the ladder is PAUSED (manual-only, 2026-08-20).

### Step 5: issue registry - see the A10 confirmations and the Phase B section below.

### Step 6: `npm run issues`

Ran, exit 0. `docs/issues/INDEX.md` regenerated and NOT staged (gitignored,
confirmed absent from `git status`). Output:
`257 open, 152 closed, 409 total`, `open by severity: 9 high, 112 med, 136 low`,
1 warning - `perf-selfqa-route-contract-drift.md: unknown severity "medium"`,
PRE-EXISTING and unrelated to this slice (that file is untouched here). Zero
warnings for any file this slice created or edited, which is also the proof the
A10-3 frontmatter fix parses.

### Step 7: verification - below.

### Step 8: commit - `6e34c95d`, explicit paths, message per the plan.

---

## A10-1 .. A10-10 confirmations (A10-11 was S1's)

| id | done | evidence |
| --- | --- | --- |
| **A10-1** | YES | `docs/issues/scheduled-message-visibility.md:32-33` no longer states the three false timings inline; a dated correction block sits at `:37-45` giving the CURRENT ladder, the four-auto-armed-rungs fact and the pause, and saying explicitly that none of it changes what Part A/B built. |
| **A10-2** | YES | `docs/issues/tour-reminders-panel-e2e-flake.md`. The label quote is `:119` with the bracketed rename note at `:120`. The root-cause narrative at `:133-142` was moved to past tense (it is a record of 2026-08-04, not current behaviour). A new block at `:148-163` states the INVERSION in four bullets: `morning_of` is now a pure `scheduledAt - 4h` offset and cannot recur in the midnight-08:00 band; `day_before` at 19:30 org-local took over the wall-clock sensitivity; `booked_too_late` makes short-horizon ladders LONGER; the label is `4 hours before`. The suggested next step at `:167-179` was REWRITTEN - its old (b) told a future reader to drop the `morning_of` assertion as the wall-clock-dependent one, which is now exactly backwards; the new (b) names `day_before` and points at the read-the-armed-dueAt-back fix Task 9 shipped. `status: resolved` unchanged; `updated:` bumped to `2026-08-26`. |
| **A10-3** | YES | The missing delimiter is restored: `docs/issues/tour-reminders-panel-e2e-flake.md:12` is now `---`, immediately after `refs:` at `:11`. The stray `---` that used to sit below the "Remaining scope" paragraph was removed (it was also turning that paragraph into a setext H2). A comment at `:14-21` records why. All body edits are below the old `:28`. Verified by `npm run issues` emitting no warning for this file. |
| **A10-4** | YES | Both "all 5 rungs should arm" sites fixed - `app/src/lib/seed/live.ts:526` (TOUR-B) and `:536-537` (TOUR-C) - plus the header `:9` and the TOUR-A block `:504-513` that the plan's literal grep also missed. |
| **A10-5** | YES | `app/src/lib/seed/cast.ts:753-754`: "(no reminder rows - all sent already)" replaced with "Its three reminder rows sit just below and are ALL history (every one already sent)." Fixed alongside `:768`. |
| **A10-6** | YES | `documentation/tours-sequence-writeup.md:97-101` blockquote: the "already says 'confirmed'" claim is corrected - the booking text is `Hey, your tour is set for {when} at {where}.`, so it states the booked slot back rather than using the literal word. And `:131-132`: "Rungs whose time is already past when armed are skipped" is gone; the replacement names the two visible booked-too-late rules and says the one SILENT retirement is a clamped time already behind `now`, reaching only `en_route` and clamped rungs. |
| **A10-7** | YES | `docs/issues/tourcopy-messageid-cast-unguarded.md:50-55`: the Suggested fix is headed `(SUPERSEDED 2026-08-26 - read the Resolution below first)` and explains that the `tour.<kind>_no_address` twins it is written against were removed by spec 6.4, so a parity test over them would assert nothing. The two original paragraphs are preserved verbatim as a blockquote for the record. |
| **A10-8** | YES | `docs/research/message-catalog-worklist.md:12` - one-line dated stale banner, scoped to the tour rungs, pointing at `app/src/messages/catalog.ts`. Nothing else in that research artifact was rewritten. |
| **A10-9** | YES - SDK already in the graph, repo imported as planned. See below. |
| **A10-10** | YES | `docs/issues/tour-reminder-zero-primary-e2e-gap.md` carries THREE numbered bullets (`:19`, `:30`, `:43`) and the title names all three: "Three tour-reminder paths the e2e harness cannot reach - the zero-primary property-contact fallback, the landlord-led en_route body, and any SKIPPED rung". Bullet (c) records that `expectReminderRung`'s state union has no `'skipped'` member, so `booked_too_late` has no e2e verb - and notes the gap is wider than one token (every visible skip row is invisible to the Scenario vocabulary). The Suggested fix orders them cheapest-first, with the lean-seed change last and flagged as its own decision. |

---

## A10-9: the SDK-graph finding

**Finding: the AWS SDK was ALREADY in `seedMatrixCoherence.test.ts`'s module
graph before this change, so importing `settingsRepo` adds no new class of
dependency. The repo import was made as planned; the timezone constant was NOT
hoisted.**

Chain, verified by source inspection:
`app/test/seedMatrixCoherence.test.ts` imports `matrixItems` and calls it at
MODULE TOP LEVEL with no Docker and no `skipIf` -> `app/src/lib/seed/matrix.ts:26`
value-imports `deadlineIdFor` from `'../../repos/placementDeadlinesRepo.js'` ->
`app/src/repos/placementDeadlinesRepo.ts:19-23` value-imports
`DeleteCommand, PutCommand, QueryCommand` from `@aws-sdk/lib-dynamodb` and
`getDocumentClient` from `../lib/dynamo.js`.

The newly added `app/src/repos/settingsRepo.ts` brings
`@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` + `getDocumentClient` -
the same lazy-client shape, no top-level side effects. Its own transitive
imports (`lib/config`, `lib/dynamo`, `lib/logger`, `lib/quietHours`,
`lib/smsCompliance`, `services/groupIdentityFingerprint` -> `node:crypto`) add
nothing that touches the network at import time.

Empirically confirmed: `npx vitest run test/seedMatrixCoherence.test.ts` after
the edit - **38/38 passed in 20ms of test time**, no module-load error.

---

## The Phase B ledger - verification

**File: `docs/issues/tour-reminder-ladder-phase-b.md`**, created. Frontmatter:
`id: tour-reminder-ladder-phase-b`, `type: improvement`, `severity: med`,
`status: open`, `area: app/jobs`, `created: 2026-08-26`, `refs:` naming
`app/src/jobs/tourReminders.ts`, `app/src/messages/tourCopy.ts`,
`app/src/repos/tourRemindersRepo.ts` and the spec path.

**SLUG MATCH CONFIRMED.** The already-shipped code comment is
`app/src/messages/tourCopy.ts:172`:
`TODO(tour-reminder-ladder-phase-b): the day a generic override map lands,`
- the slug is `tour-reminder-ladder-phase-b`, and the filename created is
`docs/issues/tour-reminder-ladder-phase-b.md`. They match, so the marker is no
longer dangling. (Note for the record: the mission block said S4's dangling
reference lived in `app/src/jobs/tourReminders.ts`. The slug-bearing marker is
in fact in `tourCopy.ts:172`; `tourReminders.ts:1204` carries the prose
reference "it is item (7) of the Phase B ledger issue, which is what gets read
at unpause" with no slug. BOTH are now satisfied by this file, and item (7) is
the one that comment points at. A third prose reference at
`e2e/scenarios/steps.ts:3595` names
`docs/issues/tour-reminder-zero-primary-e2e-gap.md` by full path - also now
created, also no longer dangling.)

**ALL NINE ITEMS PRESENT**, numbered 1-9 in the body:

1. The one-time retirement sweep as Phase B's FIRST task - criterion is THE
   TOUR IS PAST, not the dueAt; never stamped `past_event`; needs its own
   reason token; proven on real dev data (spec 9.6).
2. Empty `MANUAL_ONLY_REMINDER_KINDS` and in the SAME change remove
   `confirmation` from `REMINDER_KINDS` only, correcting the then-dead
   manual-only entry and its comment (spec 9.5).
3. The harness needs a replacement immediate-send vehicle FIRST (~40 unit
   sites + ~14 e2e sites ride confirmation's `dueAt = now`; no armed rung can
   substitute; likely a dev seam arming an arbitrary dueAt).
4. The quiet-hours exemption hook from spec 7.3, at BOTH sites (arm-time clamp
   AND fire-time backstop), cut from Phase A.
5. The founder's open `en_route`-exemption question (spec 12.1), recorded here
   as the registry entry spec 12 asks for.
6. In-flight rows armed under the OLD timings begin firing on unpause
   (spec 9.3).
7. **THE UNBOUNDED NAMES-READ RE-LIST - NOT DROPPED, and written as the one
   real hazard rather than a chore.** States that a rung whose name resolution
   keeps failing is left UNCLAIMED with NO self-clearing bound; contrasts it
   with `roster_unavailable`, which the repo bounded precisely because "a rung
   that re-lists forever is never sent and never says so"; states the
   acceptance is valid ONLY while the manual-only filter keeps the poll off
   those rows and that **the acceptance EXPIRES WITH THE PAUSE**; and requires
   Phase B to either bound it (needs a new skip-reason ruling, since 8.2
   granted exactly one token and it is not this) or re-accept it explicitly in
   writing.
8. The cosmetic superseded-by-a-skipped-rung chip: `supersededBySlot` consults
   clamped dueAts without asking whether the later rung was itself retired;
   PRE-EXISTING (seedLive already pinned a confirmation superseded by a
   silently-dropped morning_of), just easier to notice now; a fix needs the
   later rung to be genuinely armable, which spec 8.1 put out of scope.
9. The failure-scope derivation reads catalog DEFAULTS only (`reminderNamesUsed`
   in `messages/tourCopy.ts`, with the matching TODO on its docblock): safe
   while no `tour.*` override can exist, but
   `ComposeTourReminderInput.overrides` already exists on the signature, so the
   day a generic override map lands the derivation must widen to the EFFECTIVE
   template.

The closing "Suggested fix" fixes the front-of-queue ordering: 1 before 2,
3 before 2, and 7 decided before the pause lifts.

Fact-checks done while writing it, so the ledger is not repeating stale claims:
`settingsToOverrides` (`app/src/messages/resolve.ts:74-79`) does map exactly two
non-tour ids (`welcome.sms`, `missed_call.autotext`) - item 9's premise holds.
`app/src/repos/tourRemindersRepo.ts`'s `roster_unavailable` docblock does carry
the "never sent and never says so" sentence item 7 quotes.

---

## The `sentBody` DECISION (spec 13 asked for a decision, not a restatement)

**DECIDED: seeds continue to write NO `sentBody`, here or anywhere.**

Consequence, accepted knowingly: a read path renders a stored `sentBody` only
when one exists and otherwise RECOMPOSES from the live catalog, so every seeded
"already sent" reminder row re-renders in TODAY's copy - the demo world shows
tours from months ago quoting wording that did not exist then.

Chosen over the alternative (backfilling synthetic `sentBody` snapshots),
because that would fabricate send history in a store whose entire purpose is
recording what actually went out. A wrong-but-plausible snapshot is worse than
an anachronistic re-render, because only the snapshot can be mistaken for
evidence.

Recorded in the tree as a one-line-titled comment block beside the cast rows:
`app/src/lib/seed/cast.ts:774-780`.

---

## Verification

| gate | command | result |
| --- | --- | --- |
| coherence test (post-matrix-edit) | `cd app && npx vitest run test/seedMatrixCoherence.test.ts` | **exit 0** - `Test Files 1 passed (1)`, `Tests 38 passed (38)`, 1.24s |
| typecheck | `npm run typecheck` (bare, from the worktree root) | **exit 0** - all five workspaces (app x3 projects, dashboard, e2e, fake-twilio, fake-twilio-web) |
| full app suite | `cd app && npx vitest run` | **exit 1** - `Test Files 1 failed | 337 passed | 1 skipped (339)`, `Tests 1 failed | 6033 passed | 9 skipped (6043)`, 488.35s |
| known-noise re-run | `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run test/messaging.integration.test.ts` | **exit 0** - `Test Files 1 passed (1)`, `Tests 18 passed (18)`, 4.56s |
| issue index | `npm run issues` | **exit 0**, 1 pre-existing unrelated warning |

Nothing was piped. Every command was redirected to a file and the exit code read
separately.

**The single app-suite failure is the KNOWN ENVIRONMENTAL SIGNATURE the mission
block names**, exactly:

```
FAIL test/messaging.integration.test.ts > messaging repos against DynamoDB Local
     (throwaway prefix) > messagesRepo > getManyByTsMsgIds chunks past the
     100-key BatchGetItem limit
Error: Test timed out in 60000ms.
```

ZERO assertion failures. The same FILE alone under the clean access key passed
18/18 in **3.35s of test time** against a 60s timeout in the contended run -
a >18x margin, which is the contention signature, not a threshold miss. It has
failed this way in every prior slice.

**Nothing self-skipped that should have run.** The one skipped file is
`test/staticSmoke.test.ts` (9 tests), gated on `describe.skipIf(!built)` - a
built-dashboard-dist precondition, NOT the DynamoDB reachability skip. No suite
printed a DynamoDB `SKIPPED` warning.

**No seed-adjacent test needed re-deriving.** The full suite is green apart from
the environmental failure above, so the matrix/cast/live edits moved nothing.
`grep` for the two changed cast instants across `app`, `dashboard` and `e2e`
returns only `cast.ts` itself - no test pins them.

**ASCII:** every ADDED line across all 11 files verified ASCII-only
(`git diff` added lines filtered through `LC_ALL=C grep '[^ -~\t]'` - no hits).
`matrix.ts`, `cast.ts`, `live.ts`, the writeup and two of the issue files are
pre-existing non-ASCII files; their untouched lines were left alone per the
ratchet rule.

---

## Commit

**`6e34c95d`** - `docs(tours): seeds, sequence writeup and issue registry follow the retimed ladder`

Bare `git status` read before staging; `.git/MERGE_HEAD` confirmed ABSENT;
explicit paths only, no `git add -A`; `docs/issues/INDEX.md` not staged
(gitignored). Trailer:
`Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>` - matching every
prior commit on this branch. Tree clean after commit.

Staged paths (11):

```
app/src/lib/seed/matrix.ts
app/src/lib/seed/cast.ts
app/src/lib/seed/live.ts
documentation/tours-sequence-writeup.md
docs/issues/tourcopy-messageid-cast-unguarded.md
docs/issues/founder-message-template-updates-owed.md
docs/issues/tour-reminders-panel-e2e-flake.md
docs/issues/scheduled-message-visibility.md          (A10-1, not in the plan's list)
docs/research/message-catalog-worklist.md            (A10-8, not in the plan's list)
docs/issues/tour-reminder-zero-primary-e2e-gap.md    (new)
docs/issues/tour-reminder-ladder-phase-b.md          (new)
```

---

## Deviations from the plan, with reasoning

1. **The first commit attempt used a PowerShell here-string (`@'...'@`) inside a
   Bash call**, which put a literal `@` at the front of the subject line
   (`c98270ba`). AMENDED immediately with a heredoc to `6e34c95d`, same tree,
   correct subject. Nothing was pushed in between. Flagged because the hash in
   any earlier scrollback is wrong.

2. **The `git add` list is two paths longer than the plan's Step 8** -
   `docs/issues/scheduled-message-visibility.md` (A10-1) and
   `docs/research/message-catalog-worklist.md` (A10-8). Both are worklist
   additions the plan's own enumeration missed; the plan's list is not a
   whitelist.

3. **`documentation/tours-sequence-writeup.md:150-153` also fixed**, beyond
   A10-6's two named sites. It described the no-show check-in as an `[AUTO]`
   send. That is false (manual-only) and, more to the point, my own Step 4 edit
   put "(manual send)" in the ladder table two paragraphs above it - shipping
   the table without this would have made the document contradict itself inside
   one section. One-sentence correction.

4. **`tourcopy-messageid-cast-unguarded.md` gained `updated: 2026-08-26` and one
   extra ref** (`app/test/tourCopy.test.ts`) on top of the plan's `status` /
   `resolved` / Resolution. `updated:` is optional per the schema; the ref is
   the test the Resolution cites, so a reader can find it.
   `founder-message-template-updates-owed.md` and
   `tour-reminders-panel-e2e-flake.md` likewise gained/bumped `updated:`.

5. **The A10-7 Suggested fix was PRESERVED as a blockquote rather than deleted.**
   The addendum allowed "strike or annotate". Blockquoting under an explicit
   SUPERSEDED heading annotates it without destroying the record of what was
   originally proposed - and the second paragraph (the
   `Record<ReminderKind, ...>` alternative) is close to what actually shipped,
   so it has archival value.

6. **A10-2's root-cause narrative was moved to past tense rather than rewritten
   or deleted.** It is a dated forensic record of a real 2026-08-04 run,
   including a quoted app log line. Deleting it would destroy the evidence; the
   danger the addendum names is a reader taking it as CURRENT, which the tense
   change plus the explicit "THE MECHANISM ABOVE IS HISTORY" block closes. The
   forward-looking half - the suggested next step - was rewritten outright,
   because that is instruction, not record.

7. **The writeup's booked-too-late paragraph was rewritten once after first
   drafting.** My first draft said a rung clamped at/past the tour start is
   "dropped silently". That is wrong - rule (b) `past_event` writes a VISIBLE
   row; the ONE silent retirement is a clamped dueAt already behind `now`.
   Corrected against `armTourReminders`'s pass-2 rule list before committing.
   Recorded because the same mistake is easy to make from the spec alone.

---

## Stop conditions - none hit

- No seed-adjacent test broke in a way the plan or research-6 did not predict
  (none broke at all).
- The coherence invariant PASSED after the `Math.max` fix.
- **No SIXTH reminder-row writer was found.** Re-ran the enumeration
  independently:
  `grep -rn "_reminderPartition\|reminderId\|tourReminders" app/src/lib/seed/`
  returns the same set research-6 B4 found - `cast.ts` (one writer, 3 rows),
  `matrix.ts` (three writers: confirmation, and the pending/canceled/sent
  `day_before` branches), and `live.ts` (three indirect `armTourReminders`
  calls, no literals). `lean.ts`, `history.ts`, `performance.ts`, `media.ts`,
  `types.ts`, `index.ts` and `app/src/lib/seedData.ts` write none.

---

## Noticed and NOT fixed

- **`perf-selfqa-route-contract-drift.md` has `severity: medium`**, which is not
  in the schema's `high|med|low`. `npm run issues` warns on it every run. Not
  mine, one-word fix, but it is an unrelated file and fixing other people's
  registry entries mid-slice is scope creep. Worth a drive-by on some other
  branch.
- **`documentation/tours-sequence-writeup.md:147-149`** ("On the way. The
  en-route nudge...") reads slightly oddly now that `en_route` is described as
  1h before rather than 2h, but it states no timing, so there is nothing false
  to fix. Left alone deliberately.
- **The `docs/research/scheduled-message-visibility/*` files** (four of them,
  per research-6 C2) still quote the old ladder timings and the old catalog
  bodies. They are frozen research artifacts under `docs/research/`, and the
  addendum only asked for a banner on `message-catalog-worklist.md`. If the
  project wants the whole `docs/research/` tree banner-stamped, that is its own
  small change. Also stale for the same reason:
  `docs/issues/tour-times-assume-org-timezone.md:50` (cites "morning_of's 08:00
  anchor") and `docs/issues/_CLUSTERS.md:359,:363` (cite "a deterministic
  pre-08:00" / "00:00-08:00 wall-clock flake"). `_CLUSTERS.md` in particular is
  a live registry index whose summary of the flake issue is now doubly stale -
  it was already stale per AGENTS.md, and the retime makes its mechanism
  description wrong as well. NOT touched: `_CLUSTERS.md` is cross-cutting and
  regenerating/reconciling it is a separate job.
- **The `docs/issues/scheduled-message-visibility.md` heading still says "a full
  5-rung ladder is armed on scheduling"** at `:31-32`. Only FOUR rungs auto-arm.
  The correction block immediately below says so explicitly rather than
  rewriting the original sentence, on the same
  preserve-the-record principle as A10-2. Flagging it so a reader who greps for
  "5-rung" and stops at the first hit knows the correction is four lines down.
