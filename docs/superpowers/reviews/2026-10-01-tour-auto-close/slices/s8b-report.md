# Slice report - S8b (dashboard: tour page wiring, Tours page, Today, labels)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 04e5a084 (S8a report commit).
- Scope: the second half of S8 - Tasks 8.5 (tour page wiring + Outcome card),
  8.6 (Tours page), 8.7 (Today lists no-shows), 8.8 (activity labels + the app
  seed-vocabulary comments). One commit per task, then this report.
- Sources followed: plan sections 0, 1 and S8 Tasks 8.5-8.8; spec 9.2-9.5,
  10.1, 12; the S8a contract (`slices/s8a-report.md` section 6) and the reopen
  route contract (`slices/s6-s7-report.md` section 6); the binding corrections
  in `research/drift-s8-dashboard.md` (1, 12-18, section 2, section 3 risks
  4-5, section 4's stale-comment list), correction 11 of
  `research/drift-s9-s10-e2e-docs.md`, and rulings D-j, D-k, F9, F10 in
  `research/worklist.md`; the reference quotes in
  `.superpowers/sdd/research/ref-s8-dashboard.md` and `ref-s9-s10-e2e-docs.md`
  section 12.
- No STOP condition was hit: no unexpected importer (`selectTodayPastTours`
  had exactly the two importers the plan names - `useTodayPastTours.ts` and
  `useTours.test.ts`), no contract mismatch with the S8a / S6-S7 reports
  (`ReopenTourModal` props, `reopenTargetOf`, `TourActionsMenu`'s
  `canReopen` / `onReopen`, `reopenTour` all matched), and no existing test
  turned red that the plan did not predict.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| e6dfa8a7 | 8.5 | feat(tours): tour page offers Reopen - one control per state, guarded hand-off |
| f65eb32d | 8.6 | feat(tours): Closed rows carry the outcome badge; intros name auto-close |
| 04e88501 | 8.7 | feat(today): Today lists the Past tab's no-shows too |
| f766acad | 8.8 | feat(tours): label tour_auto_closed and tour_reopened on tour + property |
| (this) | records | docs(records): tour auto-close S8b slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD` - `.git` is a file in a
worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude Opus
5.5` trailer, committed through Bash with a heredoc.

Files (exactly the brief's list, nothing else):
`dashboard/src/routes/tours/` TourDetail.tsx, TourDetail.test.tsx,
ToursPage.tsx, ToursPage.test.tsx, useTours.ts, useTours.test.ts,
tourActivityFormat.ts, tourActivityFormat.test.ts;
`dashboard/src/routes/today/` useTodayPastTours.ts, useTodayPastTours.test.tsx,
Today.tsx, Today.test.tsx; `dashboard/src/routes/listing/` listingFormat.ts,
listingFormat.test.ts; `app/src/lib/seed/history.ts` (comments only),
`app/test/seedTourTrails.test.ts` (comments + two titles),
`app/test/seedHistory.test.ts` (comments only).

## 2. Per task: RED reason, GREEN result

Pre-edit baseline (04e5a084): the seven dashboard files 250 passed
(TourDetail 102, ToursPage 41, useTours 33, tourActivityFormat 9,
useTodayPastTours 12, Today 27, listingFormat 26); the two app seed files 64
passed (seedTourTrails 24, seedHistory 40).

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 8.5 | TourDetail.test.tsx: 11 failed / 108 passed (119). 8x `Unable to find ... role "button" and name "Reopen tour"` (the four CTA states, confirm into toured, confirm into no_show, the 409 case, Cancel); 1x `... name "More actions"` (closed + convertible: no kebab yet); 1x `Unable to find an element with the text: Closed automatically on Jun 24`; 1x `expected document not to contain element, found <span` (the "Moving forward" KV on a no_outcome tour). The 6 other new cases passed on unchanged code - PINs (converted / pending:x / closed-without-provenance / canceled: no Reopen anywhere; converted keeps "View placement"; every other outcome unchanged) | TourDetail 119 passed (102 + 17 new) |
| 8.6 | ToursPage.test.tsx: 3 failed / 41 passed (44): `Unable to find an element with the text: No outcome recorded` (no badge), the new Closed intro, the updated Past intro (exact pin). The canceled no-badge case passed on unchanged code - PIN | ToursPage 44, useTours 33, TourDetail 119 (196) |
| 8.7 | useTodayPastTours.test.tsx + Today.test.tsx: 1 failed / 39 passed (40): `expected [ 'new', 'old' ] to deeply equal [ 'new', 'ns', 'old' ]` (the no-show filter). The new Today no-show row case passed on unchanged code - PIN (spec: Today.tsx already renders any row it is given) | Today 28, useTours 30 (33 minus the 3 deleted selector cases), ToursPage 44, useTodayPastTours 12 (114) |
| 8.8 | tourActivityFormat.test.ts + listingFormat.test.ts: 3 failed / 35 passed (38): `expected { label: 'Tour auto closed' } to deeply equal ...` on the tour page and on the property (the humanize fallback, no link), and the milestone falling to `stage_changed`. App seed tests: comment-only edits, membership checks - 64 passed before and after (no RED possible, by correction 11) | tourActivityFormat 11, listingFormat 27 (38); app seed 64 |

Final run on the committed tree: the seven dashboard files 271 passed, exit 0
(TourDetail 119, ToursPage 44, useTours 30, tourActivityFormat 11,
useTodayPastTours 12, Today 28, listingFormat 27; 250 + 17 + 3 - 3 + 2 + 1 +
1 = 271). App seed files 64 passed, exit 0, no `[dynamoAdmin]` line. The one
React act() warning in the output is the pre-existing "debounces" case in
useTodayPastTours.test.tsx (present at baseline, unchanged).

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after 8.5, 8.6, 8.7, 8.8 and on the final tree.
- Lint baseline, BEFORE any edit, on all 17 files of the brief: exit 1, two
  pre-existing errors - `TourDetail.tsx:311:85 react-hooks/purity`
  (`Date.now()` in the `startPassed` guard; the one the brief names) AND
  `useTours.ts:126:5 react-hooks/set-state-in-effect` (`setState({ status:
  'loading', closed: [] })` in useClosedTours; NOT named in the brief).
- Final lint, same 17 files: exit 1, the same two errors only, at shifted
  lines `TourDetail.tsx:326:85` and `useTours.ts:128:5`. Both lines are
  untouched by this slice (`git blame`: 23f7d568 2026-07-22 and aec497d0
  2026-07-15); the shift is the comment/code lines added above them. No new
  error on any touched line. Per task: 8.5's two files - the purity error
  only; 8.6's three files - the set-state error only; 8.7's six files - the
  set-state error only; 8.8's seven files - exit 0.
- ASCII: after every edit the added lines of `git diff -U0 -- <file>` were
  checked; a final scan of every added line of `git diff -U0 04e5a084..HEAD`
  printed nothing. No file in scope has a CR. Untouched non-ASCII lines remain
  (TourDetail.tsx's `interleave` comment, the em dashes / arrows in
  useTours.ts :1, :48, :111-112, ToursPage.tsx :5-6 and :38, Today.tsx :1,
  seedHistory.test.ts :482, etc.) - the ratchet allows them. The literal
  `'\u2190'` escape (now TourDetail.tsx:683) was never in an Edit string and
  is intact.
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.

## 4. Divergences from the plan, and why

Binding corrections applied: drift #1 (fixtures against the pinned 2026-07-01
clock; no fake timers needed), #12 / D-j (the date line is ONE `<p
className={styles.subtle}>`, midday-UTC fixtures), #13 / D-j (`reopenTour`
added to the barrel mock + factory), #14 (ToursPage header :26 rewritten
ASCII), #15 (the useClosedTours "closed (terminal)" doc reworded in 8.6), #16
/ D-k (`:90` flipped, `:77` retitled, file header fixed), #17 / D-k (the cap
pin kept in its own describe, the rest deleted, the import removed), #18
(`past` passed directly, `useMemo` dropped, the import trimmed), F9 (badges
found by text inside the row), F10 (the no-badge case uses the canceled
fixture), drift-s9-s10 #11 (the four extra stale seed claims).

Within the brief's latitude - each a deliberate choice:

1. 8.5 tests beyond the plan's matrix (additive): each CTA-state case also
   opens the dialog and asserts `REOPEN_BODY[target]` (the snapshot target
   reaches the dialog); a canceled tour (kebab present: Reschedule) has no
   Reopen item; the converted tour keeps "View placement"; a 409 on confirm
   keeps the dialog open with TOUR_CHANGED_COPY and the tour closed (proves
   `confirmReopen` lets the throw reach the dialog); Cancel closes and
   reopens nothing; the kebab path confirms through to Record outcome; a
   no_outcome tour WITHOUT `autoClosedAt` shows the label, no date line and
   no "Moving forward"; every other outcome renders as before (PIN).
2. 8.5 header: besides the new Reopen paragraph, the existing mutation list
   (:9-10) gained `POST /:id/reopen` - it enumerates the page's mutations and
   would otherwise be stale.
3. 8.5 Outcome card: for `no_outcome` without an `autoClosedAt` string,
   nothing renders in place of "Moving forward" (the plan's "when
   autoClosedAt is a string"); the converted / convertible rows after it are
   unchanged for every outcome.
4. 8.5: the guarded-close test waits one tick inside `act()` (no act warning)
   and also asserts the badge reads "Toured".
5. 8.6: an extra fixture `TOUR_CANCELED_DECIDED` (a canceled tour carrying
   `move_forward`). It is reachable through the API - PATCH does not refuse
   toured -> canceled (`routes/tours.ts` transition guard) - and it is the
   ONLY fixture that can kill mutant (c): the plain canceled fixture carries
   no outcome. The badge order (status, outcome, type) is pinned with a
   `toHaveTextContent` regex on the row.
6. 8.6: `ToursPage.test.tsx:472-473` ("terminal closed tour", drift section
   4) reworded; its em dash replaced. In `useTours.ts:108-118` only the
   useClosedTours doc carried the terminal claim and was reworded; the
   ClosedToursState doc (:111-112) makes no such claim and was left as is.
7. 8.6: the Closed intro moved to its own line in PAGE_INTRO (length); the
   Past intro stays one line, as before.
8. 8.7: the rule the deleted selector's doc held now lives on
   `TODAY_PAST_TOURS_CAP`'s doc (spec 9.4: the comments "around the removed
   selector"): Today lists the Past rows as they are, no-shows included,
   why, and "change the Past tab and Today follows".
9. 8.7: `useTodayPastTours.ts` also reworded the "what refetches" note
   (:15-16 - the sweep and a reopen emit `tour.updated` too) and the `total`
   doc ("a deleted tenant's tours"); Today.tsx reworded its header, the
   PastTourRow doc (:188-192 - a no-show's next step is Reschedule / the
   check-in on the tour page) and the section doc (:220-224).
10. 8.7: `Today.test.tsx:421` retitled "(a deleted tenant's tour)" - the only
   remaining reason the Past count exceeds the rows under the cap. The new
   Today PIN also clicks through and checks the probe: empty search,
   `state.back` = '/'.
11. 8.7: `useTodayPastTours.test.tsx:90` FLIPPED (not dropped) and a
   `rows[1]` label assertion added for the no-show.
12. 8.8: `TOUR_EVENT_LABELS`' doc says the sweep and the reopen route write
   through the same shared writer; `TOUR_LABELS`' doc says listing a kind is
   what keeps its link. One extra assertion: a `tour_reopened` milestone has
   no `refType` (no self-link on the tour page).
13. 8.8 seed comments (now at): history.ts :79-89 (TOUR_EVENT_TYPES, incl. the
   old :81-82), :699-706 (tourMilestones), :845-857 (the tour-trail header,
   reflowed); seedTourTrails.test.ts :53-62 and the titles at :137 and :466;
   seedHistory.test.ts :858-863. `history.ts:564-571` (the seeded-kinds list)
   left, as correction 11 allows. No string, value, set or assertion changed.

## 5. Mutant check (applied with Edit, reverted with Edit; `git diff --quiet` clean after each)

| id | mutant | result |
|---|---|---|
| a | Reopen dialog `onClose={() => setModal(null)}` (flat close) | KILLED by 2: "confirm into toured ... (the guarded close)" and "closed + convertible ... ONE kebab item" - `Unable to find role="dialog" and name "Record outcome"` |
| b | kebab `canReopen={reopenTarget !== null}` (convertible dropped) | KILLED by 5: the four CTA-state one-control cases and the pre-existing pin "a closed tour with a group has no kebab at all" |
| c | badge for `(closed \|\| canceled) && outcome` | KILLED by 1: "a canceled tour carries no outcome badge, even one that recorded a decision" (only the decided-canceled fixture can see it) |
| d | `labelRows(past.filter((t) => t.status !== 'no_show'), ...)` | KILLED by 1: `expected [ 'new', 'old' ] to deeply equal [ 'new', 'ns', 'old' ]` |
| e | `TOUR_LABELS` without `tour_reopened` | KILLED by 1 - by the `to: '/tours/t3'` assertion ONLY: `humanize('tour_reopened')` is also "Tour reopened", so a label-only test would let it survive |
| f (extra) | CTA: the convertible rung skipped for closed tours (Reopen CTA beside the kebab item) | KILLED: the convertible-state case found a header "Reopen tour" button |
| g (extra) | the date line rendered as `<KV k="Closed automatically on" ...>` | KILLED: the Outcome-card case (text split across two spans) |
| h (extra) | `confirmReopen` without `setModal('outcome')` | KILLED by the same 2 as (a) |
| i (extra) | `MILESTONE_TYPE.tour_reopened = 'stage_changed'` | KILLED: the same-named milestone case |
| j (extra) | Today: a no-show row links with `?outcome=1` | KILLED: the new Today no-show PIN (href) |

Totals: 10 mutants (5 required + 5 extra), 10 killed, 0 survivors - nothing
needed a new pin. After the last revert: tree clean, the seven dashboard files
271 passed, typecheck exit 0, lint = baseline only.

## 6. What the e2e slice (S9) drives - exact names and texts

Tour page (`/tours/<id>`):

- Header CTA on a closed, unconverted, reopenable, NOT convertible tour
  (auto-closed from scheduled / toured / no_show, or a person's not-a-fit):
  `getByRole('button', { name: 'Reopen tour' })`. No kebab renders there
  (`button` "More actions" absent).
- Closed + convertible + unconverted: the CTA is `button` "Start placement"
  (the Outcome card has a second one); Reopen is ONLY the kebab item - open
  `button` "More actions", then `getByRole('menuitem', { name: 'Reopen tour'
  })`. A `button` query never sees a menuitem.
- Converted (incl. a `pending:` claim): `link` "View placement"; no Reopen.
- The confirm: `getByRole('dialog', { name: 'Reopen tour' })`; its buttons
  `Cancel` and `Yes, reopen` (busy label `Reopening...`), plus the Modal's
  `Close` X. Use exact names - a `/reopen/i` regex matches both the CTA and
  "Yes, reopen". Bodies, by target:
  - toured: "This tour goes back to Toured so you can record a different
    outcome. Nothing is sent."
  - no_show: "This tour goes back to No show so you can reschedule it.
    Nothing is sent."
  - scheduled: "This tour goes back to Not marked so you can mark it toured
    or a no-show, or reschedule it. Nothing is sent."
- Dialog errors (`role="alert"` inside the dialog, which stays open): any 409
  "This tour changed since the page loaded - reload and try again."; anything
  else "Couldn't reopen the tour - please try again."
- After "Yes, reopen" into toured: `dialog` "Record outcome" opens and stays
  (form `Record outcome form`); the header CTA reads `button` "Record
  outcome"; the status badge reads "Toured". Into no_show: no dialog, badge
  "No show" (the kebab then offers Reschedule / Send no-show check-in). Into
  scheduled: badge "Scheduled", CTA "Mark toured".
- Status badge on a closed tour: "Closed".
- Outcome card of an auto-closed tour: KV `Outcome` / "No outcome recorded",
  then ONE `<p>` "Closed automatically on <date>" where `<date>` is
  `shortDate(autoClosedAt)` - LOCAL time, month and day, no year (e.g. "Jun
  24"); no "Moving forward" row. On the lane, compute the date the same way or
  match `/^Closed automatically on [A-Z][a-z]{2} \d{1,2}$/`.
- Activity card / transcript pins: "Closed automatically: no outcome recorded
  after two weeks", "Tour reopened".

Tours page:

- Closed tab (`/tours/closed`): each row is a `link` whose accessible name is
  its `aria-label` "Tour for <tenant> at <property>" - the badges are NOT part
  of it. Find the badge by text inside the row (e.g. `row.getByText('No
  outcome recorded', { exact: true })`). Badge order: date, status ("Closed" /
  "Canceled"), outcome ("No outcome recorded" / "Not a fit" / "Move
  forward"), type. A canceled row never carries an outcome badge.
- Closed intro: "Tours that ended - converted into a placement, closed as not
  a fit, closed automatically with no outcome, or canceled."
- Past intro: "Last 90 days: tours that were never marked toured, toured
  tours still waiting on an outcome or a placement, and no-shows. Tours with
  no outcome close on their own two weeks after their date or their last
  update." (the `/^Last 90 days:/` prefix in tours-past.spec.ts:113 holds).

Today (`/`):

- Section `h2` and list `aria-label`: "Past tours needing an outcome"
  (unchanged).
- A no-show row is a `link` named `Tour for <tenant> at <property> on
  <whenLabel>, No show` - e.g. "Tour for Tasha Nguyen at 88 Sycamore St on Sep
  24, 2026, 2:30 PM, No show"; an undated one "Tour for <tenant> at
  <property>, undated, No show"; match with `/, No show$/`. Its href is
  `/tours/<tourId>` with NO `?outcome=1`, and it carries `state.back` = '/'.
  A Needs-outcome row still links `/tours/<id>?outcome=1`.
- The footer link reads "See all N on the Past tab" only when the Past tab
  holds more rows than Today lists (past the cap of 5, or a deleted tenant's
  tour); otherwise "Open the Past tab". While a no-show is listed, "All caught
  up" does not show (spec 9.4's accepted consequence).

Property page Activity: "Tour closed automatically: no outcome recorded after
two weeks" and "Tour reopened", each linking to `/tours/<id>`. Person
timeline labels are server-owned (S3) and unchanged here.

## 7. Observations for the orchestrator (no action taken)

- Removing `selectTodayPastTours` removed the last code reference to
  `docs/issues/past-tab-no-show-rows-need-an-exit.md` (still open) - S10 Task
  10.2 owns resolving it.
- The gate-5 baseline has a SECOND pre-existing error the brief did not name:
  `useTours.ts:126:5` (now `:128:5`) react-hooks/set-state-in-effect
  (aec497d0). The final gate run will show it again on this branch; attribute
  it by baseline, as here.
- `app/test/seedHistory.test.ts:482-483` and `:515` still say recordTourEvent
  is "in routes/tours.ts" - S3 moved the writer to `lib/tourEvents.ts`. The
  labels are still passed from the routes/tours.ts call sites, so these are
  location notes, not vocabulary claims; left untouched (outside the
  vocabulary sweep; :482 also carries a non-ASCII arrow).
- A canceled tour can carry an outcome through the API (PATCH allows toured
  -> canceled); the Closed tab's status guard keeps the badge off and is now
  pinned (mutant c).
- F6 stands: after a reopen, a `tour.updated` refetch through the eventually
  consistent GET can briefly repaint the pre-reopen row; S9 assertions should
  auto-retry.
- The "Reopen tour" CTA is not disabled while `busy` - the same as the other
  modal-opening CTAs ("Schedule tour", "Record outcome"); the dialog has its
  own busy state.
- S9 Task 9.1 (today-past-tours.spec.ts) must flip its no-show assertions:
  Today now lists no-shows, so "All caught up" no longer shows while one is
  inside the window.
