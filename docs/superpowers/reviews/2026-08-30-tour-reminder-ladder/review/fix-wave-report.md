# Fix-wave report - feat/tour-reminder-ladder, review round 1

Base: `268554ef` (merge of main). One commit: **`b208285d`**
(`b208285dad1700f058156727e5090887286abf66`).
Tree clean before and after. `.git/MERGE_HEAD` absent at both points.
10 files staged by explicit path; no `git add -A`.

Scope applied: exactly the seven adjudicated actions. B6 and B7 untouched, as
ruled. `MANUAL_ONLY_REMINDER_KINDS` / `REMINDER_KINDS` untouched - the ladder is
still PAUSED. `app/src/messages/resolve.ts` untouched. No `{where}` declaration
removed. `supersededBySlot` and the rule ordering in `armTourReminders` are
byte-identical to `268554ef`.

---

## Action 1 (B1) - Phase B ledger item 8 rewritten

File: `W:\tmp\tour-reminder-ladder\docs\issues\tour-reminder-ladder-phase-b.md`

Item is still numbered **8** (other documents reference the numbering). The
false "PRE-EXISTING behaviour" justification and its `seedLive.test.ts` citation
are gone. New text:

> 8. **NEW IN PHASE A, NOT INHERITED - a `confirmation` retired citing a rung
>    that never armed.** Read this item as a consequence PHASE A INTRODUCED. An
>    earlier draft of this ledger (and the plan it came from) called it
>    PRE-EXISTING, justified by "`app/test/seedLive.test.ts` already pinned a
>    `confirmation` superseded by a silently-dropped `morning_of`". That
>    justification was checked at the merge base and is FALSE; it is corrected
>    here so Phase B does not file this under old news.
>
>    THE DEFECT. `supersededBySlot` (`app/src/jobs/tourReminders.ts`) asks only
>    whether a LATER rung's CLAMPED dueAt equals mine and lands before the tour
>    start. It cannot see that the later rung was itself retired by the new rule
>    (e), so the earlier rung is retired `quiet_hours_superseded` - the panel chip
>    "superseded by a later reminder" - while the rung it names sits beside it
>    reading "booked too late for this reminder".
>
>    WHY IT COULD NOT ARISE AT THE MERGE BASE `440dc75e`, so nobody re-derives it:
>    `git show 440dc75e:app/test/seedLive.test.ts` pins TOUR-A's pending set as
>    `['en_route', 'morning_of']` and asserts `morningOf.skippedAt` is
>    `toBeUndefined()` - that superseder was ALIVE and would have fired. Nor could
>    the general case happen there: `confirmation`'s raw dueAt is `now` and
>    clamping only moves it FORWARD, so its clamped dueAt is always `>= now`,
>    while the base's only silent drop (the past-dueAt branch) always has
>    `dueAt < now` - the two can never be equal - and `supersededBySlot` already
>    excludes `past_event` rungs. So before rule (e), a confirmation retired
>    `quiet_hours_superseded` ALWAYS cited a rung that really armed.
>
>    REACHABLE BAND: arming inside the org quiet window, on the TOUR'S OWN local
>    date (so between local midnight and the window's end), for a tour starting
>    roughly 08:00-12:00 local, booked under six hours out. Both `confirmation`
>    and `morning_of` clamp to the same window-end slot; `morning_of` is then
>    retired `booked_too_late`, and the confirmation has already been retired
>    citing it. The evening side of the window is safe - `localDateOf(now)` is
>    then the day BEFORE the tour, so rule (e) does not fire for `morning_of`.
>
>    WHY IT SHIPPED UNFIXED: spec 8.1 puts the cross-rung supersession machinery
>    OUT OF SCOPE for Phase A in terms, and the fix - requiring a superseder to be
>    genuinely armable - reorders rule evaluation, which is exactly the change
>    spec 8.1 warns reopens the vanishing-row problem the precedence exists to
>    solve. That belongs in a Phase B design with its own review, not bolted on at
>    a Phase A handback.
>
>    PHASE A IMPACT IS BOUNDED BY THE PAUSE. Nothing auto-sends, so what is lost
>    today is a chip naming the wrong cause plus the Send now button on that
>    confirmation (a skipped row is terminal: `forceSendReminder` returns
>    `not_pending`). Note the interaction with item 2 - removing `confirmation`
>    from `REMINDER_KINDS` at unpause retires THIS case, because a rung that never
>    arms cannot be superseded. That is not a fix to the machinery, and Phase B
>    should say which of the two it is doing rather than let the symptom
>    disappear and the predicate stay wrong.

**Prominence.** The adjudication also asked to raise item 8 in the item
ordering, but the work order requires the number to stay 8. I honoured both by
pulling it out of the "any order" tail of the closing `**Suggested fix.**`
paragraph, which now reads:

> **Suggested fix.** Phase B is its own feature mission. Order matters at the
> front: item 1 before item 2, item 3 before item 2, and item 7 decided (bounded
> or re-accepted in writing) before the pause lifts. Item 8 is the one entry here
> that Phase A INTRODUCED rather than inherited, and it must be DECIDED alongside
> item 2 - not left to be silenced by it - so give it a real slot rather than
> leaving it in the tail. Items 4, 5 and 9 can land in any order but should each
> be closed or explicitly re-deferred in the Phase B handback rather than silently
> inherited a third time.

**One derivation of mine, flagged for your check.** The claim that item 2
(removing `confirmation` from `REMINDER_KINDS`) retires this CASE is my
reasoning, not the adjudication's. It follows because `supersededBySlot`
iterates `REMINDER_KINDS`, so an unarmed `confirmation` cannot be retired at
all. I also satisfied myself that `confirmation` is the only reachable victim:
for `day_before` to reach the supersession check it must NOT be
`booked_too_late`, i.e. `now <= dayBefore_raw - 4h` (about 15:30 org-local on
D-1), while `morning_of` being `booked_too_late` requires
`localDateOf(now) == tourLocalDate` (D). Those cannot both hold. I did not put
that second derivation in the ledger - only the confirmation framing the
adjudication gave.

## Action 2 (B2) - braces stripped from resolved names

File: `W:\tmp\tour-reminder-ladder\app\src\lib\tourContacts.ts`

New module-private helper `inertName(raw)` = `raw.replace(/[{}]/g, '').trim()`,
called from **this module's own** `firstNameOf` and `fullNameOf` in place of the
bare `.trim()` (three call sites: firstName in each helper, lastName in
`fullNameOf`). The existing "reads are defensive: a non-string must never reach
`.trim()`" comment was updated to name `inertName()` instead.

The docblock states WHY: names are user-supplied - staff free text, AI
extraction, and the UNAUTHENTICATED `POST /public/housing-fair`, which takes
`firstName` as an arbitrary trimmed, length-capped string - and the shared
`interpolate` substitutes DECLARED tokens in sequence, so a value carrying
`{anotherDeclaredToken}` is re-expanded by a later pass, with every tour entry
declaring six to eight tokens (the six of `TOUR_NAME_VARS` plus `where` /
`addressLine`), name tokens first. It also records that sanitizing here avoids
touching the shared interpolator and points at the filed issue.

`app/src/messages/resolve.ts` was NOT touched. Behaviour note: a name that is
nothing but braces now collapses to `''` and reads as ABSENCE, which the
docblock states explicitly and a test pins.

## Action 2, test

File: `W:\tmp\tour-reminder-ladder\app\test\tourContacts.test.ts` - two new
cases, inserted before the existing `a supplied tenantContact skips the tenant
read`:

- `BRACES are stripped: a name of "{where}" comes back inert, so no token can
  re-open` - tenant `firstName: '{where}'`, `lastName: '{addressLine}'`,
  landlord `firstName: '{propertyContactName}'`. Asserts `'where'`,
  `'where addressLine'`, `'propertyContactName'`, plus
  `expect(Object.values(r.names).join(' ')).not.toMatch(/[{}]/)`.
- `a name that is NOTHING but braces reads as absence, not an empty name` -
  `firstName: '{ }'` yields both name fields `undefined` with
  `tenantReadFailed === false`.

Result: `10 passed (10)`, was 8. Log quoted under Verification.

## Action 3 (B2, second half) - interpolator weakness filed

New issue slug: **`message-interpolate-token-reexpansion`**
(`W:\tmp\tour-reminder-ladder\docs\issues\message-interpolate-token-reexpansion.md`)
- `type: bug`, `severity: med`, `status: open`, `area: app/messages`,
`created: 2026-08-31`.

States the mechanism (declaration-order iteration, one `split(needle).join(value)`
pass per token, so an early value containing another declared token is
re-expanded), the unauthenticated reachability via `POST /public/housing-fair`,
why it is currently narrow, that the tour path is sanitized at its source as a
STOPGAP that closes nothing else, and that the real fix is single-pass
interpolation preserving both current behaviours (undeclared token left literal;
declared-but-missing throws in a default, degrades to empty in an override) -
explicitly not a drive-by, because it changes every message in the app.

**Correction I made to the reviewer's evidence:** the review and the
adjudication both name `notification.attachment` `{name}` as one of the two
single-token entries carrying a contact-supplied name. **That message id does
not exist** anywhere in the repo. The entry meant is `relay.media_only`
(`'{name} sent an attachment.'`, `vars: ['name']`,
`app/src/messages/catalog.ts:309`). The issue names `relay.media_only` and
records the misnaming in one line so the next reader is not sent hunting.
`welcome.sms` `vars: ['firstName']` checks out as stated.

## Action 4 (B3) - `{where}` re-add hazard filed

New issue slug: **`tour-copy-where-token-declared-not-passed`**
(`W:\tmp\tour-reminder-ladder\docs\issues\tour-copy-where-token-declared-not-passed.md`)
- `type: debt`, `severity: low`, `status: open`, `area: app/messages`,
`created: 2026-08-31`.

Records that the declaration is spec-mandated (section 6) and explicitly does
NOT ask for its removal; that `composeTourReminderBody`
(`app/src/messages/tourCopy.ts:118`) passes `where` only when the street is
non-empty; that re-adding `{where}` to one of the four defaults throws
`Error('resolveMessage: missing interpolation var "where"')`
(`app/src/messages/resolve.ts:37`), which is neither `UncomposableReminderError`
nor `ReminderNamesUnavailableError` and therefore escapes to a 500 on three read
routes and to a forever-re-listing rung in the job; and that the `tourCopy.test.ts`
no-address matrix is the existing mitigation (why it is LOW). Suggested fix is
pass-unconditionally or a compose-time guard, keeping the declarations, with
`tour.confirmation*` explicitly out of scope.

Cross-referenced from Phase B ledger item 9, appended as a new paragraph:

> SAME CLASS OF HAZARD, filed separately and worth taking in the same pass:
> [`tour-copy-where-token-declared-not-passed`](./tour-copy-where-token-declared-not-passed.md).
> There the mismatch runs the other way - `{where}` is DECLARED on the four
> twin-less tour entries but the composer passes it only when a street exists,
> so putting `{where}` back into one of those defaults throws a bare `Error`
> past every containment block for an addressless unit. Both items are a
> declaration the surrounding code does not honor for every input.

Note: routes/job line numbers were deliberately NOT pinned in the issue refs -
`app/src/jobs/tourReminders.ts` line numbers shifted by this commit's own
comment edit. Files and symbols only.

## Action 5 (B4) - misquoted comment fixed

File: `W:\tmp\tour-reminder-ladder\app\src\jobs\tourReminders.ts`, the comment
above the `bookedTooLate` branch. Removed
"`spec 11 - which is why the operator label says the reminder was armed too
late, not that the operator was slow`" and replaced it with the verbatim shipped
label:

```
    // moment (spec 11). The shipped operator label is
    // 'booked too late for this reminder' (REMINDER_SKIP_REASON_LABELS in
    // dashboard/src/api/types.ts) - on a reschedule or a revival the "booking"
    // it names is the RE-ARM, not the original creation, so the row can read
    // "booked too late" on a tour first booked days earlier. Spec 11 accepts
    // that and rules only that the wording must not ACCUSE the operator; if the
    // phrasing is ever revisited, change the label, not this precedence.
```

Behaviour and the label itself are unchanged (spec 11 accepted). Verified the
quoted string against `dashboard/src/api/types.ts:1280`.

## Action 6 (B5) - three stale timing comments fixed

1. `W:\tmp\tour-reminder-ladder\app\src\repos\settingsRepo.ts` (`timezone` on
   `OrgSettings`) - now names **`day_before`** as the tour rung that reads the
   org timezone (19:30 org-local the evening before the tour's local date) and
   records that morning_of used to be that rung at 08:00 org-local and is now a
   pure `scheduledAt - 4h` offset reading no timezone. The
   `resolveQuietHoursTimezone` sentence is preserved.
2. `W:\tmp\tour-reminder-ladder\dashboard\src\api\types.ts:125` - the duplicated
   sentence, corrected the same way; the "Displayed read-only in the UI this
   phase" clause preserved.
3. `W:\tmp\tour-reminder-ladder\e2e\tests\scenarios\scheduled-visibility.spec.ts:87`
   - the `bookedSelfGuidedTour` booking comment. It no longer explains the fixed
   14:00 hour by the retired past_event mechanism. It now says that mechanism
   CANNOT recur since the 2026-08-26 retiming, states what the fixed hour buys
   today (identical rung instants run to run: day_before 19:30 D-1 < morning_of
   10:00 D < en_route 13:00 D < start 14:00 D, which the quiet-hours case anchors
   its stored window to; and it keeps `day_before`, the rung that inherited the
   wall-clock sensitivity, off the suite's clock), and points at
   `tourScheduleFullLadder`'s docblock in `e2e/scenarios/steps.ts` for the full
   history. Content derived from `e2e/scenarios/steps.ts:308-334`, which the
   review named as the place that documents the real current reason.

## Action 7 (A-G1) - comment nesting restored

File: `W:\tmp\tour-reminder-ladder\docs\issues\tour-reminders-panel-e2e-flake.md`

Inserted a blank line and a fresh `<!--` opener between the FRONTMATTER
DELIMITER note's `-->` (`:21`) and the TITLE CORRECTED note, and the previously
orphaned `-->` now correctly closes the second block. Result, lines 14-31:

```
<!--
  FRONTMATTER DELIMITER RESTORED 2026-08-26. ...
-->

<!--
  TITLE CORRECTED 2026-08-21. ...
-->
```

Both notes are hidden again; no orphaned `-->` and no stray body prose. The
frontmatter delimiter at `:12` is untouched and `npm run issues` still parses
the file (it appears in the regenerated index).

---

## Verification

All commands run bare from `W:\tmp\tour-reminder-ladder`, output redirected to a
file (never piped), exit code read from `$?`. All were re-run AFTER the final
comment reflow in `tourContacts.ts`.

**`cd W:\tmp\tour-reminder-ladder\app && npx vitest run test/tourContacts.test.ts`** - `EXIT=0`

```
 v test/tourContacts.test.ts (10 tests) 19ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

(Two `tour names: ... read failed` warn lines in the log are the pre-existing
throwing-repo cases asserting their own logging; not new.)

**Affected tour suites, run as a cheap regression check on the name change**
(`npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts test/tourCopy.test.ts`) - `EXIT=0`

```
 Test Files  3 passed (3)
      Tests  143 passed (143)
```

**`npm run typecheck`** - `TYPECHECK_EXIT=0`

```
> housingchoice@0.1.0 typecheck
> npm run typecheck --workspaces --if-present

> @housingchoice/app@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json
> @housingchoice/dashboard@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
> @housingchoice/e2e@0.1.0 typecheck
> tsc -p tsconfig.json
> @housingchoice/fake-twilio@0.0.0 typecheck
> tsc --noEmit
> @housingchoice/fake-twilio-web@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit
```

**`npm run issues`** - `EXIT=0`

```
[issues] 268 open, 155 closed, 423 total -> docs/issues/INDEX.md
[issues] open by severity: 11 high . 116 med . 141 low
[issues] 1 warning(s):
  - perf-selfqa-route-contract-drift.md: unknown severity "medium"
```

That single warning is PRE-EXISTING and is not one of my files
(`perf-selfqa-route-contract-drift.md` carries `severity: medium`, which is not
in the taxonomy). Both new issues parsed with the intended fields:

```
| med | bug  | open | message-interpolate-token-reexpansion       | ... | app/messages |
| low | debt | open | tour-copy-where-token-declared-not-passed   | ... | app/messages |
```

`docs/issues/INDEX.md` is gitignored (`.gitignore:62`) and was NOT staged; I
confirmed with `git check-ignore -v`.

**`npx eslint app/src/lib/tourContacts.ts app/test/tourContacts.test.ts app/src/jobs/tourReminders.ts app/src/repos/settingsRepo.ts dashboard/src/api/types.ts e2e/tests/scenarios/scheduled-visibility.spec.ts`** - `ESLINT_EXIT=0`

```
W:\tmp\tour-reminder-ladder\e2e\tests\scenarios\scheduled-visibility.spec.ts
  52:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  56:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')

x 2 problems (0 errors, 2 warnings)
```

**Zero errors, so zero new errors.** The two warnings are pre-existing and no
baseline run was needed to attribute them: they sit at `:52` and `:56`, and my
only edit to that file is at `:87`, below both - their line numbers are
unchanged from `268554ef`. Review A's gate-5 note already lists "two e2e warning
line numbers" among the pre-existing baseline differences.

**ASCII.** Verified twice: `rg '[^\x00-\x7F]'` over both new issue files, the two
modified issue files, `tourContacts.ts` and `tourContacts.test.ts` - no matches;
and `LC_ALL=C grep '^+.*[^ -~\t]'` over the `git diff` of the four remaining code
files - no matches on any ADDED line. (`scheduled-visibility.spec.ts` carries a
pre-existing em dash in a test title, untouched.)

**Commit discipline.** Bare `git status` read immediately before staging
(8 modified, 2 untracked, nothing else); `.git/MERGE_HEAD` confirmed absent; ten
explicit paths staged, no `git add -A`; one commit, trailer
`Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`. Tree clean after:
`nothing to commit, working tree clean`. `git log --oneline -2`:

```
b208285d fix(tours): apply adjudicated review findings for the reminder ladder
268554ef Merge branch 'main' into feat/tour-reminder-ladder
```

No source file was rewritten with a PowerShell `Get-Content | -replace |
Set-Content` pipeline; every change went through the edit tool.

---

## Deliberately NOT done

- `supersededBySlot` and the rule ordering in `armTourReminders` - unchanged
  (spec 8.1, out of scope for Phase A). B1 answered with documentation only.
- `app/src/messages/resolve.ts` - unchanged.
- `{where}` declarations on the four twin-less entries - kept.
- B6 (resolver names the unit's primary contact) - REJECTED, no action.
- B7 (skipped-row accumulation) - inherent to spec 8.1's visible-rows ruling,
  no action.
- `MANUAL_ONLY_REMINDER_KINDS` / `REMINDER_KINDS` - untouched; the ladder is
  still PAUSED.

## Noticed and NOT fixed - for you to route

1. **`notification.attachment` does not exist.** Both the adversarial review and
   the adjudication cite it as the second single-token contact-name entry. The
   real entry is `relay.media_only` (`app/src/messages/catalog.ts:309`). The
   substance of the finding is unaffected - it does declare exactly one token,
   `name` - but the citation is wrong wherever it is repeated. I corrected it in
   the new issue and am reporting it rather than editing the review documents.
2. **B7(b), the dead `TourTimes.morningOf` mirror**, is still dead:
   `e2e/scenarios/steps.ts:346` assigns it and nothing reads it (the adjudication
   only addressed B7(a), the skipped-row accumulation, and ruled no action on the
   branch). The docblock that reintroduced the field explains that the previous
   removal happened precisely because "a wrong answer waiting to be used" is
   worse than nothing. Worth an explicit keep-or-drop call in the handback; it
   is a one-line deletion if you want it gone.
3. **`perf-selfqa-route-contract-drift.md` has `severity: medium`**, which is not
   in the `high | med | low` taxonomy, so `npm run issues` warns on every run and
   the file is presumably mis-bucketed in the index. Pre-existing, unrelated to
   this branch, not touched.
4. **The Phase B ledger's frontmatter title still says "the nine things owed"**
   and there are still nine items, so it remains accurate - but item 8 is now
   described as a Phase A regression rather than inherited debt, which sits a
   little oddly under a title framed entirely as pre-existing obligations. Left
   as-is because other documents reference both the title and the numbering.
