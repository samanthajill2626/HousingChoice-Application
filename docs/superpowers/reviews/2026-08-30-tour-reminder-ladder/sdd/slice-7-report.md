# Slice S7 report - Task 8: relabel "Morning of" to "4 hours before"

Branch `feat/tour-reminder-ladder`, worktree `W:\tmp\tour-reminder-ladder`.
Base commit at slice start: `f2908b1a` (clean, no `.git/MERGE_HEAD`).

Scope delivered: the plan's Task 8, Steps 1 through 6, complete, in ONE commit.

---

## 1. Step 1 - the RED, quoted

Test edits landed first (label pins + both aria sentences), source untouched.

```
cd W:/tmp/tour-reminder-ladder/dashboard
npx vitest run src/routes/tours/RemindersPanel.test.tsx      EXIT=1

 Test Files  1 failed (1)
      Tests  9 failed | 25 passed (34)
```

The nine failures, verbatim:

```
 x RemindersPanel > highlights the NEXT rung with aria-current and a "Next" tag
   -> Unable to find an element with the text: 4 hours before. This could be
      because the text is broken up by multiple elements. ...
 x RemindersPanel > keeps Send now on a paused rung (the whole point of leaving it pending)
   -> Unable to find an accessible element with the role "button" and name
      `/Send the Day before reminder now/i`
 x RemindersPanel - dueAt-anchored self-refetch > Cancel on an upcoming rung PATCHes
   {canceled:true} and refetches; Restore reverses it
   -> Unable to find role="button" and name "Cancel the Day before reminder"
 x RemindersPanel - Send now > offers Send now on an upcoming rung only (not sent/canceled/skipped)
   -> Unable to find role="button" and name "Send the Day before reminder now"
 x RemindersPanel - Send now > Send now POSTs for that rung and refetches the honest ladder
   -> Unable to find role="button" and name "Send the Day before reminder now"
 x RemindersPanel - Send now > a 409 shows readable inline copy beside the rung, keeps
   the ladder, and re-enables
   -> Unable to find role="button" and name "Send the Day before reminder now"
 x RemindersPanel - Send now > a contact_deleted 409 tells the navigator to restore the contact
   -> Unable to find role="button" and name "Send the Day before reminder now"
 x RemindersPanel - Send now > an unmapped refusal code still says something human
   -> Unable to find role="button" and name "Send the Day before reminder now"
 x RemindersPanel - Send now > an empty body renders the "Preview unavailable" note,
   not bare emptiness
   -> Unable to find an accessible element with the role "button" and name
      "Send the Day before reminder now"
```

Note the SECOND failure above is C6 / A8-1 proving itself: that test's matcher is
the regex the plan claimed "keeps working". It is `/Send the Day before reminder
now/i` only because I edited it per C6; had it been left as
`/Send Day before reminder now/i` it would have gone red at Step 3 instead, since
the produced accessible name no longer contains that substring. Only
`:542`'s anchored `/reminder now$/` count matcher genuinely needed no edit, and it
was left alone.

Raw log: scratchpad `s7-step1-red.txt`.

---

## 2. Complete list of edited string sites (file:line, POST-edit line numbers)

Line numbers in the plan and in research-4/5 predate Tasks 4-7; every site below
was located by NAME/STRING as instructed. The `git diff --numstat` for the commit
is 7 files, +55 / -23.

### Source (the producers)

| file:line | change |
| --- | --- |
| `dashboard/src/api/types.ts:1248` | `morning_of: 'Morning of'` -> `morning_of: '4 hours before'`, with the plan's two-line rationale comment at `:1246-1247` |
| `dashboard/src/routes/tours/RemindersPanel.tsx:353` | aria template #1: `` `Send ${kindLabel} reminder now` `` -> `` `Send the ${kindLabel} reminder now` `` |
| `dashboard/src/routes/tours/RemindersPanel.tsx:364` | aria template #2: `` `${... ? 'Cancel' : 'Restore'} ${kindLabel} reminder` `` -> `` `... the ${kindLabel} reminder` `` |
| `dashboard/src/routes/tours/RemindersPanel.tsx:339-346` | extended the existing accessible-name comment to say why the "the" is load-bearing |

### Dashboard test pins (13 literals in one file)

| file:line | change |
| --- | --- |
| `RemindersPanel.test.tsx:207` | `getByText('Morning of')` -> `getByText('4 hours before')` |
| `RemindersPanel.test.tsx:208` | `getByText('Morning of').closest('li')` -> `'4 hours before'` |
| `RemindersPanel.test.tsx:286` | `/Send Day before reminder now/i` -> `/Send the Day before reminder now/i` (C6) |
| `RemindersPanel.test.tsx:443` | `'Cancel Day before reminder'` -> `'Cancel the Day before reminder'` |
| `RemindersPanel.test.tsx:449` | `'Restore Day before reminder'` -> `'Restore the Day before reminder'` |
| `RemindersPanel.test.tsx:458` | `'Cancel Day before reminder'` -> `'Cancel the Day before reminder'` |
| `RemindersPanel.test.tsx:541` | `'Send Day before reminder now'` -> `'Send the Day before reminder now'` |
| `RemindersPanel.test.tsx:565` | same |
| `RemindersPanel.test.tsx:587` | same |
| `RemindersPanel.test.tsx:596` | same |
| `RemindersPanel.test.tsx:611` | same |
| `RemindersPanel.test.tsx:628` | same |
| `RemindersPanel.test.tsx:651` | same - **an EIGHTH send-now site the plan and research-4 do not list** (both enumerate seven). It was added by an earlier slice (the "an empty body renders the 'Preview unavailable' note" test, i.e. Task 5's withheld-preview pin). See deviation D1. |

Unchanged and verified still correct:
`RemindersPanel.test.tsx:542` (`/reminder now$/`, anchored suffix) and
`:470` (`/Cancel|Restore/`, substring).

### e2e harness and pins

| file:line | change |
| --- | --- |
| `e2e/scenarios/steps.ts:248` | `morning_of: 'Morning of'` -> `'4 hours before'` in `REMINDER_KIND_LABELS` |
| `e2e/scenarios/steps.ts:234-243` | docblock: added the LOCKSTEP paragraph (why the verbatim mirror must move with the dashboard map, and that drift fails as a silent no-match rather than a compile error) plus the dated relabel note |
| `e2e/scenarios/steps.ts:3450-3461` | `expectReminderRung` docblock: the A8-4 COLLISION PROFILE paragraph |
| `e2e/tests/scenarios/quiet-hours.spec.ts:348` | `'Send Day before reminder now'` -> `'Send the Day before reminder now'` (the only pinned reminder aria name in `e2e/`) |
| `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:40-42` | A8-2: PROSE reworded to `"Send the <Kind label> reminder now"`. Not a locator; not treated as a pin |
| `e2e/support/selectors.md:72` | the pinned contract: pattern -> `Send the <Kind label> reminder now`, example -> `Send the Day before reminder now`, kind-label list -> `Confirmation, Day before, 4 hours before, En route, No-show check-in`, plus a sentence recording why the `the` is load-bearing |
| `e2e/support/selectors.md:73` | NEW row documenting the second (Cancel/Restore) reminder aria template. See deviation D2 |

---

## 3. Coverage grep - proof the sweep is complete

```
$ cd W:/tmp/tour-reminder-ladder && grep -rn "Morning of" dashboard/src e2e/ app/
e2e/.artifacts/results.json:11100:  "title": "App: Reminders panel shows 'Morning of' as upcoming",
e2e/scenarios/steps.ts:242: *  morning_of relabelled 'Morning of' -> '4 hours before' on 2026-08-26: the
e2e/scenarios/steps.ts:3454:   * 'Morning of' was shaped so that no body could contain it; its replacement
e2e/support/selectors.md:72: ... the label was relabelled from `Morning of` to `4 hours before` on 2026-08-26 ...
```

Every remaining hit accounted for, and NONE is a live pin:

1. `e2e/.artifacts/results.json` - a Playwright run artifact, **gitignored**
   (`git check-ignore -v` -> `.gitignore:32:e2e/.artifacts/`). It is a stale
   recording of a previous run's step title, not source, and it is regenerated
   by the next run.
2. `steps.ts:242`, `steps.ts:3454`, `selectors.md:72` - my own three DELIBERATE
   HISTORICAL references, each of the form "relabelled from X to Y on
   2026-08-26". They are the audit trail the change is supposed to leave.

Outside the swept trees, one hit remains and it is **Task 10's, per A8-5**:

```
$ grep -rn "Morning of" docs/issues/
docs/issues/tour-reminders-panel-e2e-flake.md:112:
    "App: Reminders panel shows 'Morning of' as upcoming"   (spec line 98)
```

Not pulled forward. Between this commit and Task 10 the tree carries that one
stale quote in a registry file; the plan's shape accepts that (A8-5).

The `"reminder now"` grep, all live sites now correct:

```
$ grep -rn "reminder now" dashboard/src e2e/ app/
dashboard/src/routes/tours/RemindersPanel.test.tsx:286:  /Send the Day before reminder now/i
dashboard/src/routes/tours/RemindersPanel.test.tsx:541:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:542:  /reminder now$/            <- survives unchanged, by design
dashboard/src/routes/tours/RemindersPanel.test.tsx:565:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:587:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:596:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:611:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:628:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.test.tsx:651:  'Send the Day before reminder now'
dashboard/src/routes/tours/RemindersPanel.tsx:345:  ...comment: "Send 4 hours before reminder now"
dashboard/src/routes/tours/RemindersPanel.tsx:353:  aria-label={`Send the ${kindLabel} reminder now`}     <- the PRODUCER
e2e/support/selectors.md:72:                             the pinned contract
e2e/tests/dashboard-next/tour-comms-pane.spec.ts:42:     prose, reworded (A8-2)
e2e/tests/scenarios/quiet-hours.spec.ts:348:             'Send the Day before reminder now'
```

The A4 greps, run to confirm coverage as instructed:

```
$ grep -rnE "Cancel Day before|Restore Day before" dashboard/src e2e/ app/
(no output)
```

Zero hits - the old bare forms are gone from the dashboard tests and never
existed in `e2e/`. A4 predicted these greps would return only NUDGE hits; in this
tree they return nothing at all for those exact phrases, because the nudge panel's
labels are `Receipt check` etc., not `Day before`. The broader `Restore` sweep is
covered in section 4 below.

---

## 4. A3 confirmation - the nudge strings found and DELIBERATELY left

I found every nudge accessible-name site and edited **none** of them:

- `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:273` -
  `` aria-label={`Send ${label} nudge now`} `` - the send-now producer, LEFT.
- `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:284` -
  `` aria-label={`${nudge.state === 'upcoming' ? 'Cancel' : 'Restore'} ${label} nudge`} ``
  - the cancel/restore producer, LEFT.
- `dashboard/src/routes/placements/DeadlinesNudgesCard.test.tsx:309`, `:319` -
  `'Send Receipt check nudge now'`, LEFT.
- `e2e/tests/dashboard-next/placements-page.spec.ts:219`, `:225` -
  `'Restore Receipt check nudge'`, LEFT (and `:213`'s prose, LEFT).
- `e2e/support/selectors.md:74` (was `:73` before my new row) -
  `Send <Kind label> nudge now`, LEFT.

Per A3 this is a DECISION, not a missed sweep: the knock-on belongs to the rung
whose LABEL changed, and no nudge label changed. `selectors.md` already pinned
`Send the relay group now` before today, so the two grammars coexisting in that
file is house-acceptable and pre-existing, not new inconsistency introduced here.
A reviewer reading `Send the <Kind label> reminder now` one row above
`Send <Kind label> nudge now` is seeing the adjudicated outcome.

Also LEFT, unrelated despite matching the `Restore` grep:
`deleted-contact-resurfacing.spec.ts:145` (`'Restore contact'`),
`TourConversation.test.tsx:569`, `PlacementConversation.test.tsx:292` (same),
and ~20 `mockRestore()` / "Restore the lean baseline" hits.

## 4b. A8-4 - the changed collision profile, verified

`expectReminderRung` (`steps.ts:3462`) filters reminder rows with Playwright
`hasText: REMINDER_KIND_LABELS[kind]`, a SUBSTRING match over the whole
`listitem` - which carries the label, the state chip, the suppression note AND
the composed body. `'Morning of'` could not collide with body copy;
`'4 hours before'` is prose-shaped and could. Verified at the relabel:

```
$ grep -cin "hour" app/src/messages/catalog.ts
0
```

Zero occurrences of "hour" anywhere in the catalog, so no `tour.*` default -
current or twin - can contribute "4 hours" to a row. The nearest string rendered
anywhere in that panel's chrome is `REMINDER_SKIP_REASON_LABELS.roster_unavailable`
(`types.ts:1278`, "gave up after an hour"), which does not contain "4 hours". The
only "4 hours"-adjacent literal in the dashboard is
`RecentErrors.tsx:35` (`'Last 24 hours'`), on a different page entirely.

The finding is recorded as a permanent comment in the `expectReminderRung`
docblock, naming what would re-open the hazard (a copy edit that puts an hours
phrase in a reminder body) and what the fix would be then (narrow the filter to
the label element - do NOT rename the label back).

---

## 5. Verification

```
$ cd W:/tmp/tour-reminder-ladder && npm run typecheck
EXIT=0
```

(app `tsconfig.json` + `tsconfig.scripts.json` + `tsconfig.test.json`, dashboard,
**e2e workspace**, fake-twilio, fake-twilio-web - all clean. The e2e leg matters
here: `steps.ts` and both spec edits compile.)

Targeted dashboard suite, Step 3:

```
$ cd W:/tmp/tour-reminder-ladder/dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx
EXIT=0
 Test Files  1 passed (1)
      Tests  34 passed (34)
```

FULL dashboard suite:

```
$ cd W:/tmp/tour-reminder-ladder/dashboard && npx vitest run
EXIT=0
 Test Files  175 passed (175)
      Tests  2725 passed (2725)
   Duration  53.27s
```

Extra, not required by the mission but cheap and in the spirit of gate 5
(`npx eslint` on exactly the files this slice touched):

```
EXIT=0
W:\tmp\tour-reminder-ladder\e2e\tests\scenarios\quiet-hours.spec.ts
  229:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
  233:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
x 2 problems (0 errors, 2 warnings)
```

Zero errors. The two warnings are on `:229` / `:233`, which this slice did not
touch (my only edit in that file is `:348`) - pre-existing, not attributable here.

ASCII check on every ADDED line: `git diff -U0 | grep "^+" | grep '[^ -~]'`
returns nothing.

**NOT run, deliberately, per the mission block:** `npm run e2e` / any Playwright
command (the e2e suite is RED from Task 6's retiming until Task 9 repairs it),
`npm test`, `npm run smoke`.

---

## 6. Commit

`7cbbe7d3` - `feat(dashboard): relabel morning_of to '4 hours before'; aria sentence carries it`
(7 files changed, +55 / -23; tree clean after.)

Bare `git status` read before staging; `.git/MERGE_HEAD` confirmed absent;
seven explicit paths staged, no `git add -A`. One commit, as scoped.

One process note, recorded for honesty: the first attempt (`db8b005f`) used a
PowerShell here-string (`@'...'@`) inside the bash tool, which is not
here-string syntax there - bash took the leading `@` as the literal first line
of the message, giving a subject of `@` and pushing the real subject to line 2.
Caught immediately on reading `git log -1 --format=%B | cat -A`, and fixed with
`git commit --amend -F <file>`. The TREE was correct in both; only the message
was wrong, and `db8b005f` was never pushed or shared. `7cbbe7d3` is the commit.

---

## 7. Deviations from the plan, with reasoning

**D1. An EIGHTH send-now pin, not in the plan or research-4.** Both enumerate
seven `'Send Day before reminder now'` sites and call the list "COMPLETE and
exact"; the live tree has eight. The extra one is
`RemindersPanel.test.tsx:651`, inside the "an empty body renders the 'Preview
unavailable' note, not bare emptiness" test - a test that did not exist when
research-4 was written, added by Task 5 (withheld previews). I edited it.
Leaving it would have left Step 3 red. This is the plan's own list going stale
against work landed between planning and this slice, exactly the failure mode
the mission's "locate by NAME/STRING, the line numbers predate Tasks 4 and 5"
instruction anticipates - it was a COUNT that drifted, not only line numbers.

**D2. I added a NEW `selectors.md` row for the Cancel/Restore reminder aria
template** (`:73`). The plan's Step 5 names only the Send-now row, and
research-4 correctly reports that no e2e spec pins Cancel/Restore today. I added
the row anyway because Step 2 changes BOTH templates and only one was documented;
the next person to write a Cancel-a-rung spec would otherwise guess the bare form
and get a silent no-match. The row says explicitly that nothing pins it today, so
it cannot be misread as a contract e2e already relies on. Additive to a doc
table; no code or test consequence.

**D3. The plan's Step 4 grep instruction was executed but its predicted output
did not materialise for `"Cancel Day before"` / `"Restore"`.** A4 already
adjudicated that those greps return only nudge hits; in this tree the exact
phrases return ZERO hits (the nudge labels are `Receipt check` etc.), and the
bare `Restore` sweep returns only nudge sites, `Restore contact` sites, and
`mockRestore()` noise. Recorded rather than acted on, per A3/A4.

**D4. I extended two comments the plan does not mention editing** - the
accessible-name comment in `RemindersPanel.tsx` (`:339-346`) and the
`REMINDER_KIND_LABELS` docblock in `steps.ts` (`:234-243`). The second is
mandated by the mission block ("say in a comment why it must move in lockstep");
the first is its dashboard-side counterpart, so the producer of the sentence
explains itself rather than only the mirror. Comment-only.

**Nothing else deviates.** No nudge string touched (A3). `MANUAL_ONLY_REMINDER_KINDS`
and `REMINDER_KINDS` untouched - the ladder is still paused. The persisted
`ReminderKind` `morning_of` is unchanged; only the label moved. No e2e repair
attempted (Task 9's). `docs/issues/tour-reminders-panel-e2e-flake.md` not
touched (Task 10's, A8-5).

---

## 8. Noticed and NOT fixed

- **`e2e/.artifacts/results.json` carries the old step title** `"App: Reminders
  panel shows 'Morning of' as upcoming"`. Gitignored run artifact; it will be
  overwritten by the next suite run. Flagged only because it is the one hit in
  the coverage grep that could be mistaken for a missed source pin.
- **Two `REMINDER_KIND_LABELS` maps stay hand-duplicated with nothing enforcing
  agreement** (`dashboard/src/api/types.ts` and `e2e/scenarios/steps.ts`). I
  documented the hazard in the harness docblock but did not build a guard.
  Worth noting that the dashboard has the right idiom for this already -
  A10-11 asks Task 10 to add exactly that kind of literal-enumeration coverage
  test to `dashboard/src/api/types.test.ts` for the SKIP-REASON map. The kind
  LABEL mirror has no equivalent and no owner in this plan. A drifted mirror
  fails as a silent Playwright no-match, i.e. as a mystery "rung missing"
  failure in some later slice, not as a compile error. Out of scope here; a
  candidate for the registry if the reviewer agrees.
- **`dashboard/src/api/types.ts:2391`, `TimelineScheduled.reminderKind`, is a
  THIRD hand-duplicated kind union.** Already on the worklist's out-of-scope
  list (R4 G10); it carries no LABEL, so this relabel does not touch it.
  Re-confirmed still true, not fixed.
- **`RemindersPanel.test.tsx:542`'s `/reminder now$/` count matcher now passes
  for a slightly different reason than it reads.** It counts buttons whose
  accessible name ENDS in "reminder now", which is still exactly the pending
  send-now buttons - correct, and deliberately left unedited per the plan. Noted
  only because it is the one matcher in that file whose text no longer literally
  appears in the aria template it guards.
