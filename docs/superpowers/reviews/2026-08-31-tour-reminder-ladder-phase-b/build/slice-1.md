# Slice 1 report - Task 1 (single-pass interpolate) + Task 2 (three tokens x six sites)

Branch `feat/tour-reminder-ladder-phase-b`, worktree `W:\tmp\tour-reminder-ladder-phase-b`.
Base at slice start: `040465c8`. Status: **BOTH TASKS SHIPPED, all named tests green,
typecheck green.**

---

## Task 1 - single-pass `interpolate` (spec 11) - SHIPPED

All six plan steps done.

**Step 1 (tests first).** Appended TWO `describe` blocks to
`app/test/messages/resolve.test.ts` - no imports added (worklist T1 delta / report C D7:
`describe/expect/it`, `resolveMessage` and `MESSAGE_CATALOG` are already imported at
`:5-8`). Every one of the file's 13 pre-existing cases kept, untouched.

- `describe('interpolate is single-pass')` - the plan's five cases verbatim, probing
  `relay.member_added` (declares `['joined','members']`, `editable:false`) exactly as the
  brief directed, with the plan's one-line comment saying Task 14 switches the probe to
  `relay.member_added_role`.
- `describe('catalog token charset (structural guard for the interpolate regex)')` - the
  plan's step-3 structural test: iterates `MESSAGE_CATALOG` (`catalog.ts:105`) and asserts
  every declared var of every entry matches `/^[A-Za-z][A-Za-z0-9_]*$/`. Written as its own
  describe rather than inside the single-pass one, since it guards the regex, not the pass.

**Step 2 (RED confirmed).** `cd app && npx vitest run test/messages/resolve.test.ts` ->
exit 1, **1 failed | 19 passed (20)**. The one failure is exactly the predicted one:

```
expected 'Hey! A SECRET LIST joined this group ...' to contain 'A {members} joined this group chat.'
```

As the plan predicted, the `$&`/`$1`/`` $` `` case passed pre-fix (split/join is immune to
`$`-patterns) - kept as the regression pin that stops the callback being turned back into a
string replacement. The last three cases passed pre-fix; they pin preserved behaviour.

**Step 3 (implementation).** Replaced the per-token `split/join` loop in
`app/src/messages/resolve.ts` with one `template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
callback)` pass, verbatim from the plan. Existing docblock KEPT in full; appended one
paragraph covering single-pass, the callback-not-string reason, and the structural charset
guard, citing the issue slug. `resolveMessage` untouched; `interpolate`'s signature
unchanged. Added lines are ASCII (the file is pre-existing non-ASCII - em dashes on
`:14/:20` - which I did not touch).

**Step 4 (GREEN).** `cd app && npx vitest run test/messages/ test/tourCopy.test.ts` ->
**exit 0, 3 files / 55 tests passed**.

**Step 5 (commit).** `acad6bbb` `fix(messages): single-pass interpolate - substituted values
are never rescanned`.

**Step 6 (issue closed).** `docs/issues/message-interpolate-token-reexpansion.md`:
front-matter `status: resolved` + `resolved: 2026-08-31`, plus a `**Resolution
(2026-08-31).**` paragraph directly under the front matter naming the callback reason, both
preserved behaviours, the structural catalog test, and the decision to leave the
`inertName` stopgap in `lib/tourContacts.ts` in place. Commit `b168bf30`
`docs(issues): close message-interpolate-token-reexpansion`.

---

## Task 2 - three skip tokens across all six sites (spec 4.3, 7.2) - SHIPPED

All five plan steps done.

**Step 1.** `SKIP_REASONS` in `dashboard/src/api/types.test.ts` gains
`tour_already_passed`, `kind_retired`, `names_unavailable`.

**Step 2.** New `describe('SEND_NOW_ERROR_COPY')` with `PERMANENT_REFUSALS =
['tour_already_passed','kind_retired']`, asserting through the exported
`sendNowErrorMessage` (the map is module-private). **Per R13 / the brief's delta, its
comment says `names_unavailable` KEEPS its existing cause-agnostic copy because retrying is
the right advice** - it does NOT claim the key is absent, and I did not add or alter that
key. (The plan's own draft comment said "deliberately absent"; that would have been false
against `types.ts`. This is the one intentional wording divergence from the plan text, and
it is the ruling.)

**RED confirmed:** `cd dashboard && npx vitest run src/api/types.test.ts` -> exit 1,
**3 failed | 8 passed (11)** - the two label tests plus the new send-now test, i.e. site 4
enforcing sites 2-3 and site 6 newly enforced.

**Step 3 - all six sites.**

1. `app/src/repos/tourRemindersRepo.ts` - `ReminderSkipReason` gains the three members with
   the plan's docblocks verbatim (`tour_already_passed` / `kind_retired` /
   `names_unavailable`), appended after `booked_too_late`.
2. `app/src/jobs/tourReminders.ts` - `ForceSendRefusal` gains **only**
   `'tour_already_passed' | 'kind_retired'` with one-line docblocks noting both are
   PERMANENT (never a retry). `names_unavailable` was already a member at
   `:1326-1329`-ish and was left exactly as it is. Union anchor confirmed at the file's
   `export type ForceSendRefusal =` (the worklist's 1299-1329, not the plan's 1317-1330).
3. `dashboard/src/api/types.ts` - `TourReminderView.skipReason` wire union gains the three,
   each with a short comment.
4. `REMINDER_SKIP_REASON_LABELS` gains the three labels EXACTLY as the plan's Interfaces
   block gives them: `the tour had already happened`, `this reminder is no longer sent`,
   `couldn't look up the names`. All underscore-free (the "never a machine token" test).
5. `SEND_NOW_ERROR_COPY` gains the two permanent-refusal entries verbatim from the plan,
   with the plan's two-line comment, placed right after `tenant_not_on_roster`.

**Step 4 (GREEN).** `cd dashboard && npx vitest run src/api/types.test.ts` -> **exit 0,
11/11 passed**. `npm run typecheck` from the worktree ROOT -> **exit 0** (all five
workspaces: app x3 projects, dashboard, e2e, fake-twilio, fake-twilio-web). Nothing else in
the tree has an exhaustive `Record<ReminderSkipReason, ...>` that the widening broke - tsc
proves it across app + dashboard + e2e.

**Step 5 (commit).** `26f73e3b` `feat(reminders): three Phase B skip/refusal tokens across
all six sites`.

---

## Commits (3)

| hash | message |
|---|---|
| `acad6bbb` | fix(messages): single-pass interpolate - substituted values are never rescanned |
| `b168bf30` | docs(issues): close message-interpolate-token-reexpansion |
| `26f73e3b` | feat(reminders): three Phase B skip/refusal tokens across all six sites |

Every commit carries `Co-Authored-By: Claude Opus <noreply@anthropic.com>`. Bare
`git status` read before each; `MERGE_HEAD` absent each time (note: this is a WORKTREE, so
the path is `.git/worktrees/tour-reminder-ladder-phase-b/MERGE_HEAD`, not `.git/MERGE_HEAD`
- the latter always errors "Not a directory" here and is NOT evidence). Explicit paths
staged; no `git add -A`.

## Commands run (none piped; all redirected to `.superpowers/sdd/logs/`)

| command | exit | result |
|---|---|---|
| `app$ npx vitest run test/messages/resolve.test.ts` (pre-fix) | 1 | 1 failed / 19 passed (20) - intended RED |
| `app$ npx vitest run test/messages/ test/tourCopy.test.ts` | 0 | 3 files, 55 passed |
| `dashboard$ npx vitest run src/api/types.test.ts` (pre-impl) | 1 | 3 failed / 8 passed (11) - intended RED |
| `dashboard$ npx vitest run src/api/types.test.ts` | 0 | 11 passed |
| `npm run typecheck` (root) | 0 | all workspaces clean |
| `npx eslint <6 touched files>` | 1 | ONE error, pre-existing - see below |

Logs: `slice1-t1.log`, `slice1-t2-red.log`, `slice1-t2-green.log`,
`slice1-typecheck.log`, `slice1-eslint.log`.

## Divergences from plan / worklist

1. **T2 step 2 comment wording** (deliberate, per R13 and the slice brief) - see Task 2
   step 2 above. The plan's literal comment text would have asserted something false.
2. **T1 structural charset test placed in its own `describe`** rather than appended into
   the single-pass block. Cosmetic; the brief said "append the `describe` blocks" (plural).
3. Nothing else. No file outside the slice's seven-file scope was touched (the seventh,
   `app/src/jobs/tourReminders.ts`, was touched ONLY inside the `ForceSendRefusal` union).

## Open worries - not blocking, your eye

- **Gate 5 pre-existing lint error, attributed by baseline.**
  `app/src/repos/tourRemindersRepo.ts:14` - `'GetCommand' is defined but never used`. It is
  PRE-EXISTING: `git show main:app/src/repos/tourRemindersRepo.ts` contains `GetCommand`
  exactly ONCE (the import itself), so it was already unused on main and my change (three
  union members ~65 lines below) neither introduced it nor deleted its last use. The other
  five touched files lint clean. Name it in the handback so nobody re-diagnoses it; it
  belongs to `lint-backlog-repo-wide`.
- The new charset test iterates `MESSAGE_CATALOG` and therefore covers Task 13's five new
  relay ids the moment they land - `names` and `role` both match the charset (report C s1),
  so T13 should not see it go red. If it ever does, the fix is the token name, not the test.
- `catalog.test.ts:23`'s `tokensIn` still uses `\w` (broader than interpolate's charset).
  Left alone per the worklist T1 delta; the new structural test is what closes that gap.
- The two new `ForceSendRefusal` members have no PRODUCER yet - Tasks 3 and 7 add them.
  Until then nothing can emit them, which is expected and is why the union landed here.
