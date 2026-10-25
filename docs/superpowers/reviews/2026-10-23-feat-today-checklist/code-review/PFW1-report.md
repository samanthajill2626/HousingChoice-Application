# PFW1 report - feat/today-checklist (tracker #31), planner fix wave 1

Implementer: the PFW1 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
PFW1-1 (ADV-1), PFW1-2 (ADV-4) and PFW1-3 (ADV-5, ADV-7) of
`planner-review/adjudications.md`; every other finding there is NO CHANGE
and was not touched. Base ae3257d6. Commits: 48a6c8f2 (PFW1-1), f941b098
(PFW1-2), 0826ba2b (PFW1-3), then this report. RED first for PFW1-1 and
PFW1-2: each new test was run RED for the reason stated below.

## PFW1-1 (ADV-1) - a truncated Quiet shares read is never "All caught up"

Changed:
- `dashboard/src/routes/today/Today.tsx`: `quietTruncated`
  (`quietShares.status === 'ok' && quietShares.truncated`, :513);
  `allCaughtUp` also requires `!quietTruncated` (:539); the comment above it
  and the file header (:25) say why.
- `dashboard/src/routes/today/QuietShares.tsx`: the early return is now
  `properties.length === 0 && !quiet.truncated` (:189), so a truncated read
  with zero property lines renders the section; the list renders only when
  there are lines (:201); the note is `QUIET_SHARES_TRUNCATED_NOTE` (:38),
  "Only the first 100 available properties were checked.", in the Follow up
  tab's markup - `<p className={styles.note} role="status">` (:220), as
  FollowUpView.tsx:230-233. A complete empty read still renders nothing.
- Two comments that quoted the old copy now quote the new one:
  `dashboard/src/api/types.ts:555` and `Today.module.css:496`.

Tests (new):
- `Today.test.tsx:527` - a truncated read with no property lines: no "All
  caught up"; the Quiet shares section shows the note and no list; control:
  the same load with `truncated: false` reads "All caught up" and has no
  Quiet shares heading.
- `QuietShares.test.tsx:214` - a truncated read with NO property lines shows
  the heading (bare), the help line and a `role="status"` note with the new
  copy; no list, no button.

RED (before the source edit; QuietShares.test + Today.test): 3 failed, 70
passed (73):
- Today.test:527 - "expected document not to contain element, found <p
  ...>All caught up</p>" (ADV-1 consequence 1);
- QuietShares.test:214 - "Unable to find an accessible element with the
  role "heading" and name "Quiet shares"" (the section returned null);
- QuietShares.test:202 (the changed pin, below) - "Unable to find an element
  with the text: Only the first 100 available properties were checked."
GREEN: `src/routes/today` 8 files / 148 passed (146 before; +2); dashboard
tsc 0; eslint 0.

Existing test changed: `QuietShares.test.tsx:202` (was ~199-205), the pin
of the old copy. Its title and its two strings change from "Showing the
first 100 properties" to "Only the first 100 available properties were
checked." - deliberately, per the ruling's (c); the assertions are the same
two (shown when truncated, absent when not). No other existing assertion
changed.

Spec copy note: spec r8 section 3
(`docs/superpowers/specs/2026-10-23-today-checklist-design.md:196`) still
names the old copy, "Showing the first 100 properties". Not edited (the
planner owns the spec). The code now differs from that line on the
planner's ruling ADV-1 (c): the old copy read as if up to 100 property lines
were on screen; the new copy states what was read, in the Follow up tab's
wording.

## PFW1-2 (ADV-4) - the W3 stamp is the last post-send step

Changed `app/src/services/sendEmailMessage.ts`: the `recordStaffOutreach`
call moved from right after `adapter.send` (old :484-489, before step (a))
to the end of the post-send bookkeeping as step (e) (:543-552), after (a)
the SES-id alias, (b) queued->sent, (c) the parked-event apply and (d) the
lastSeen bump and the sent emit. The ONE `contact.updated` still follows it
(:553) as the send's last event, only when the stamp was written; the
stamp still never throws (no try needed: `recordStaffOutreach` catches),
and nothing after `adapter.send` can skip it (steps (a)-(d) are each
log-and-continue).

Tests (new, `app/test/sendEmailMessage.test.ts`, W3 describe):
- :541 the ordering case (call-order spies): the alias, queued->sent, the
  parked apply, touchEmailLastSeen, touchLastActivity, the 'sent'
  message.persisted and conversation.updated emits all before the stamp;
  contact.updated after it and last.
- :571 a guard (green on both orders, not a RED test): every bookkeeping
  step failing at once still stamps once at the row instant, never marks
  failed, and still ends with the one contact.updated.
RED: 1 failed, 37 passed (38) - "AssertionError: expected 222 to be less
than 221" at :554 (the alias write ran after the stamp).
GREEN: sendEmailMessage.test.ts 38 passed; with emailEvents.test.ts and
emailRoute.test.ts (the other suites over the real service) 3 files / 64
passed; app tsc (src, scripts, test) 0; eslint 0. Every existing W3 and
sendEmailMessage test is unchanged and green.

## PFW1-3 (docs) - ADV-5 and ADV-7

- `docs/issues/pane-override-stale-refetch-race.md:37` - one paragraph
  naming ADV-5's trigger: every staff text, email or outbound call from the
  contact page now emits contact.updated (W1 / W3 / W6), the page re-reads
  the open contact on it (useContact.ts ~75), and a re-read in flight when
  the operator then edits an email address can land stale and clear the
  pane override (ContactCommsPane.tsx:109) until the next refetch.
- `docs/issues/today-quiet-shares-read-cost.md:40` - ADV-7's two points:
  useToday aborts the in-flight GET on each debounced refetch (fetchNow)
  while the server keeps computing the aborted load (today.ts never checks
  for a closed request); Tours to book's per-row reads - the tenant (one
  memoized read serves its delete check and its label), then the unit
  label - are awaited one row at a time (today.ts:730-752), so a slower
  Today widens that window.
Frontmatter unchanged and valid (neither file carries `updated`, so none
was bumped). `npm run issues` (bare): exit 0, "440 open, 214 closed, 654
total", no warning naming either file. INDEX.md stays gitignored and
uncommitted.

## Verification (after the last code commit f941b098; tree at 0826ba2b)

- `npm run typecheck` (bare, root): exit 0, all 5 workspaces.
- App (`cd app; npx vitest run`, redirected): exit 0; Test Files 533 passed
  (533); Tests 11408 passed | 1 skipped (11409); S8 had 11406 + 1 skipped,
  +2 = PFW1-2. No `[dynamoAdmin]` line.
- Dashboard (`cd dashboard; npx vitest run`, redirected): exit 0; Test
  Files 270 passed (270); Tests 5575 passed (5575); S8 had 5573, +2 =
  PFW1-1.
- eslint on the 7 .ts/.tsx files PFW1 touched (`git diff --name-only
  --diff-filter=d ae3257d6..HEAD`): exit 0, no output. Today.module.css is
  not linted (CSS).
- ASCII: 0 non-ASCII bytes on every added line of every touched file and in
  every commit message; no `\u` escape in any touched file before or after.
- e2e: `npm run e2e:stop` first (exit 0, "no running session found"; the
  stale lane.json / session.pid from the planner's gate run were cleared; no
  listener on 10201 / 10211 / 10221 / 10231), then `run-spec.sh pfw1` (cold
  boot, lane 12, fresh dashboard build of the tree at 0826ba2b;
  today-checklist.spec.ts + today-past-tours.spec.ts): exit 0, "6 passed
  (19.0s)". Then `npm run e2e:stop` exit 0 ("no running session found"); no
  listener on the lane ports, no session.pid or lane.json, no node process
  under the worktree.

## Found that the ruling did not cover

1. Help line in the truncated-empty state: the section keeps its normal
   frame, so the VA help line shows above the note (pinned by
   QuietShares.test:214). The unavailable branch keeps its bare heading
   (spec 2.5). Dropping the help there is one prop on TodaySection.
2. `settling` (Today.tsx:546) is unchanged: while past tours are still
   loading, a page whose only content is a truncated-empty Quiet shares
   section shows the spinner beside it until past tours settle - the same
   transient shape FW1-1's refresh note already has. Folding
   `!quietTruncated` into `queueEmpty` would drop that spinner; not done
   (beyond the ruling).
3. The Follow up tab has the same shape: FollowUpView.tsx:221-227 returns
   "Nothing waiting on a reply." before its truncated note at :230, so a
   truncated read with no waiting rows says nothing about the cap. Out of
   scope (spec 6.4: the Follow up tab is unchanged); not touched.
4. The pane-override issue's code quote (its :19) cites
   ContactCommsPane.tsx:107; the line is now :109. Left as is (outside the
   one-line scope); the new paragraph cites :109.
