# R1 spec-conformance review - feat/today-checklist (tracker #31)

Reviewer: R1 spec-conformance (Claude Opus 5.5), 2026-10-24/25.
Tree: `W:\tmp\today-checklist`, branch `feat/today-checklist`, HEAD c7705789,
base main @970a29b9 (merge base = main, not advanced).
Contract: spec r8 (`docs/superpowers/specs/2026-10-23-today-checklist-design.md`),
plan sections 0-4 (rulings PR1-PR108), the build WORKLIST (WL-1..WL-22,
R-1..R-11, Q-1), the mission block work map. Slice reports S1-S7 were read as
claims and checked against the tree; the diff packages were used as an index
only.

Method: every spec section with a requirement, every behavior-changing ruling,
every WL item, every work-map line and the watch items WI1-WI13 were checked
against the live tree (file:line below). Every PARTIAL was probed with a
throwaway test (`zz-r1sc-<n>`), run bare after the orchestrator's gate battery
finished (`.superpowers/gates/run1/ALL.done`), output captured below, then
deleted. No existing file was edited and nothing was committed; this record is
the only file written to the tree.

Observed while here (context, not findings):
- Gate battery run1 at c7705789: typecheck exit 0; `npm test` exit 0 (app 533
  files / 11389 passed, 1 skipped; dashboard 268 / 5544; e2e workspace 22 /
  509; fake-twilio 34 / 275; fake-twilio-web 13 / 111); smoke exit 0 ("1747
  import specifier(s) across 303 emitted file(s)"); `npm run e2e` exit 0, "376
  passed (17.8m)".
- Gate 5, run by this reviewer for WL-14 (eslint on the 111 branch .ts/.tsx
  files, `970a29b9...HEAD`): exactly 1 error,
  `dashboard/src/routes/tours/useTours.ts:128:5 react-hooks/set-state-in-effect`;
  the merge-base copy (`--stdin --stdin-filename`) reports the identical error.
  No new lint error.
- ASCII: 0 non-ASCII bytes on every added line of `970a29b9..HEAD`.
  Co-Authored-By trailer on 90 / 90 branch commits.
- The gate's e2e run left `e2e/.artifacts/session.pid` (62020) and `lane.json`
  (lane 12) behind; pid 62020 is not running and the lane-12 ports have no
  listener (the known stale-file pattern, S7 report). Not touched.
- While this review ran, another reviewer's untracked throwaways
  (`app/test/zz-r1adv-1.test.ts`, `dashboard/src/routes/today/zz-r1adv-2.test.tsx`,
  `zz-r1adv-3.test.tsx`) were present; not touched, and gone by the end. At
  the end `git status --short` lists only this record's folder
  (`?? docs/superpowers/reviews/2026-10-23-feat-today-checklist/code-review/`).

## Totals

- Verdicts (each ruling PR1-PR108 counted on its own; the tables below group
  some): 174 CONFORMS, 6 PARTIAL, 0 MISSING, plus 5 not applicable (S8 not
  yet run, PR85 due at S8, PR64 / PR91 / PR100 superseded). By table: work map
  6 C / 1 P; spec sections 25 C / 3 P; rulings 102 C / 2 P; worklist 22 C;
  watch items 13 C; deliberate inversions 6 C.
- Findings: 4 - HIGH 0, MEDIUM 0, LOW 2, INFO 2.

## Findings (PARTIAL / MISSING)

### R1SC-1 - LOW - CONFIRMED - per-viewer page state is lost when one live refetch fails

- Reference: spec 6.3 ("After that, the viewer's choices are kept by unitId
  across live refetches"), spec 2.1 ("Expansion is per-viewer page state only
  (lost on reload; not stored)"), plan PR34 ("survives refetches").
- What the tree does: `useToday` keeps the last load but sets
  `status: 'error'` when a refetch fails (`dashboard/src/routes/today/useToday.ts:151-156`).
  `Today.tsx` renders the checklist and At a glance only while
  `status === 'ready'` (`dashboard/src/routes/today/Today.tsx:448-493`), so the
  error render UNMOUNTS `QuietSharesSection` (its `openByUnit` / `seeded`
  state, `QuietShares.tsx:147-157`), every `LimitedList` (`expanded`,
  `TodaySection.tsx:65`) and `AtAGlance` (`aiOpen`, `Today.tsx:349`). The next
  successful refetch remounts them: the first property is re-seeded open and
  the viewer's other choices fold, every "Show all N" collapses back to five
  rows, and the AI line closes (the AI line by the same unmount - not probed
  on its own). Any transient GET /api/today failure (a deploy
  restart, a network blip) followed by the next event-driven refetch does it.
  No wrong data; it recovers on the next good load; Sam / the VA lose what
  they had opened.
- Proof (throwaway `dashboard/src/routes/today/zz-r1sc-1.test.tsx`, mocked
  `useToday` as `Today.test.tsx` does; run
  `cd W:/tmp/today-checklist/dashboard && npx vitest run src/routes/today/zz-r1sc-1.test.tsx`):
  case 1 folds property A, opens B, then status ready -> error -> ready;
  case 2 expands a 7-row Placements section, then the same round trip.
  ```
  x quiet-share open/folded choices survive a failed-then-successful live refetch (spec 6.3)
    -> expect(element).toHaveAttribute("aria-expanded", "false")
       Received: aria-expanded="true"      (zz-r1sc-1.test.tsx:85:21)
  x a Show all expansion survives a failed-then-successful live refetch (spec 2.1: lost only on reload)
    -> Unable to find an accessible element with the role "button" and name "Show fewer"
                                          (zz-r1sc-1.test.tsx:101:19; the pre-error check at :94 passed)
  Test Files  1 failed (1)
       Tests  2 failed (2)
  ```
- Fix: keep the ready content mounted after a first successful load. For
  example, `useToday` tracks that a load has landed and, on a later refetch
  failure, keeps `status: 'ready'` with a `refreshFailed` flag (the
  `usePastTours` / `reloadFailed` pattern this page already uses for past
  tours); `Today.tsx` then shows a small role="alert" note ("Could not refresh
  Today. Reload the page to see the latest.") above the sections instead of
  replacing them, and the full-page error stays for a FIRST-load failure only.
  Both probe cases then pass. Add them as committed cases.

### R1SC-2 - LOW - CONFIRMED (by search; the behavior holds) - four no-stamp writers have no pin

- Reference: spec 9 ("each no-stamp writer ... has a test that it does not
  move it"); spec 7.3 no-stamp table.
- What the tree does: these rows of the 7.3 no-stamp table have no committed
  test that they leave `last_reached_out_at` alone:
  1. the reconcile's SHARE (broadcast) adoption (`app/src/jobs/sendReconcile.ts:840`
     `adopt`) - the two `world.reachedOutTouches` assertions in
     `app/test/sendReconcile.test.ts` are the relay-leg adoption (:2224) and
     the retry adoption (:3144);
  2. "including broadcasts with no property" - the one share case,
     `app/test/broadcastFanOut.test.ts:272-284`, seeds a unit;
  3. the Quo importer (`app/src/lib/import/apply.ts`) - no import test names
     the field;
  4. the reseed (lean, full) and the performance seed - no seed test names it.
  By construction none of them can stamp: none names the field or the helper.
- Proof: `grep -lE "last_reached_out_at|reachedOutTouches|touchLastReachedOut"`
  over `app/test/*import*`, `*seed*`, `*Seed*` prints nothing. Throwaway
  `app/test/zz-r1sc-2.test.ts` pins the behavior (no lean or cast seeded
  contact carries the field; no seed module, `performanceSeed.ts`,
  `lib/import/apply.ts` or `jobs/sendReconcile.ts` names
  `touchLastReachedOut|recordStaffOutreach|last_reached_out_at|staffOutreach`)
  and PASSES - so this is a missing pin, not a defect:
  ```
  v test/zz-r1sc-2.test.ts (2 tests) 9ms
  Test Files  1 passed (1)
       Tests  2 passed (2)
  ```
- Fix: add the pins - a share-adoption case beside sendReconcile.test.ts
  case 2 asserting `world.reachedOutTouches` empty, a no-property broadcast
  beside broadcastFanOut.test.ts:272, an importer case in
  importApply.integration.test.ts, and a seed case (lean + cast + the
  performance generator) that no contact carries the field.

### R1SC-3 - INFO - CONFIRMED (by search; the behavior holds) - three 6.1 drop-offs are not pinned on the Today route

- Reference: spec 9 ("quiet shares ... each drop-off"), spec 6.1 drop-off list
  ("they become ineligible (opted out, unreachable, Inactive, placed, deleted,
  no phone)").
- What the tree does: the route table `app/test/todayApi.test.ts:2603-2627`
  pins reply, staff outreach, tour created, Not interested, 14 days, opt out,
  Inactive, deleted and property unavailable, but not unreachable, placed or
  no phone. All three ride the shared `isEligibleRecipient`
  (`app/src/lib/listingSendOutcome.ts:108-122`), which IS pinned for each
  (`app/test/listingSendOutcome.test.ts:181-190`).
- Proof: throwaway `app/test/zz-r1sc-3.test.ts` (harness route test: a quiet
  share, then `sms_unreachable`, tenant `placed`, phone removed) PASSES:
  ```
  v test/zz-r1sc-3.test.ts (3 tests) 50ms
       Tests  3 passed (3)
  ```
- Fix: add the three rows to the `dropOffs` table. Optional.

### R1SC-4 - INFO - CONFIRMED - the section-failure WARNs carry no count (PR58)

- Reference: plan PR58 ("The new throw-path WARNs carry `err` plus section and
  counts, like their siblings"); spec 2.5 ("logs at WARN with ids and counts
  only").
- What the tree does: `log.warn({ err, section: 'tours_to_book' }, ...)`
  (`app/src/routes/today.ts:750`) and `log.warn({ err, section: 'quiet_shares' }, ...)`
  (`:1244`) - no count field. The spec's PII limit holds (no name; the route
  tests assert it, `todayApi.test.ts:2665-2668`).
- Proof: throwaway `app/test/zz-r1sc-4.test.ts` (both reads throw, then read
  the two WARN lines' numeric fields):
  ```
  x each throw-path WARN carries err, section AND a count
    -> ["level","time","pid","hostname","requestId","userId","correlationId","err","section","msg"]:
       expected [] to not deeply equal []
  Tests  1 failed (1)
  ```
- Fix: add a count where one exists (e.g. the requested tours read before the
  throw), or record that PR58's "counts" means the spec's PII limit. No
  behavior impact.

## Verdict table - work map (mission block)

| Item | Verdict | Evidence |
|---|---|---|
| S1 the signal | CONFORMS | contactsRepo.ts:240, :414, :785-788, :1006, :1126/:1133, :1396-1407, :2073-2110; contacts.ts:319; staffOutreach.ts:45-70; conversationsRepo.ts:570, :1139, :1293; harness fakes per S1 report |
| S2 system_copy + W1/W2/W3/W6/W8, no-stamp, inbound, tour.updated | CONFORMS | messagesRepo.ts:777, :1090, :2655; sendMessage.ts:409, :416, :708, :770-778; api.ts:700-711, :1589, :1906-1920; sendEmailMessage.ts:489, :552; voice.ts:362, :396, :863, :1154, :1255, :1354, :1366, :1737, :1799; dev.ts:856-878, :950, :1182, :1213; inboundEmail.ts:840; tours.ts:421; units.ts:174, :1669 |
| S3 W4/W5/W7, after-loop fresh read | CONFORMS | relayFanOut.ts:974, :1083, :1110-1161, :1553-1599, :1696-1702, :1855, :2306, :2368, :2370; relayAnnouncements.ts:133, :194-226, :332, :391-392, :458; groupSend.ts:614-631, :718-725 (before :749) |
| S4 Today server | CONFORMS | today.ts:108-200, :520-537, :686-751, :899-1129, :1230-1306; followUps.ts:139-261; quietShares.ts:26-113 (R1SC-3, R1SC-4 are test / log nits) |
| S5 dashboard Today | PARTIAL | R1SC-1; otherwise TodaySection.tsx:20-94, QuietShares.tsx:25-197, Today.tsx:47-496, useToday.ts:61-201, buildToday.ts:43-50, :263-282, useTodayPastTours.ts:115-200 |
| S6 backfill + RUNBOOK | CONFORMS | app/scripts/backfill-last-reached-out.ts; app/test/backfillLastReachedOut.test.ts (31 cases); RUNBOOK.md:553-587 |
| S7 e2e, rehearsal, docs | CONFORMS | e2e/tests/dashboard-next/today-checklist.spec.ts; the updated specs (S7 table); perf routes.ts:396-415; GLOSSARY.md:739, :758, :775; issues; events.ts:314-337 |
| S8 sync + gates + handback | N/A | orchestrator-owned, not yet run (gates 1-4 observed green at c7705789; gate 5 checked above) |

## Verdict table - spec sections

| Spec | Verdict | Evidence |
|---|---|---|
| 2 page order, Unreplied removed, no unmatched email, subtitle, section/h2/list name | CONFORMS | Today.tsx:441-444 (subtitle exact), :465-491 (order 1-7 then At a glance), TodaySection.tsx:32-41, :71; Today.test.tsx:326, :344; e2e today-checklist.spec.ts:338-352 |
| 2.1 5 rows, Show all N / Show fewer, no heading count, Past-tab link beside, property lines, empty not rendered | PARTIAL | R1SC-1 (expansion lost on a failed refetch); otherwise TodaySection.tsx:20, :36, :66-87; Today.tsx:135, :305-309; QuietShares.tsx:184; 2026-08-03 pins byte-identical (Today.test.tsx:202-205, :565) |
| 2.2 help lines (exact; none on the other four) | CONFORMS | Today.tsx:59-61, :469, :474; QuietShares.tsx:28-30, :179; Today.test.tsx:353; e2e :353-355 |
| 2.3 All caught up (checklist only, settle rule, withheld on failure) | CONFORMS | Today.tsx:419-437, :458-463; Today.test.tsx:482-533, :736-753 |
| 2.4 At a glance (dashed divider, compact Tours today, one collapsed AI line, absent when empty) | CONFORMS | Today.tsx:323-394; Today.module.css:506-510; today.ts:1261-1265 (time, tenant, tourId); Today.test.tsx:231-261, :495 |
| 2.5 section failures (own try/catch, 200, unavailable copy, fallback one line) | CONFORMS | today.ts:721-751, :1230-1245, label degrade :520-537; Today.tsx:145-153, :456, :471-476; QuietShares.tsx:159-167; todayApi.test.ts:2443, :2652-2681; Today.test.tsx:502-533 |
| 3 wire contract | CONFORMS | today.ts:108-114, :129-131, :157-200; api.ts:1303-1307 (units, listing sends); dashboard types.ts:492-570 (PR31 optional fields) |
| 3.1 client fallback | CONFORMS | buildToday.ts:43-50, :263-282 (identify, own copy, no unreplied); useToday.ts:83-113 (404 only; both sections unavailable); Today.test.tsx:516-533; useToday.test.tsx:249 |
| 4 Unreplied removal; type filter first; owner test after the deleted skip | CONFORMS | today.ts:891-899, :933-937, :959-964; no `unreplied` in app/src or dashboard src (grep); todayApi.test.ts:2254, :2351 |
| 5.1 Needs you now | CONFORMS | today.ts:576-676, :776-837 unchanged; unknown rows moved to identify (:1012-1023, :1116-1127) |
| 5.2 Identify (owner rule, triage partition, stub exclusion, phone de-dupe, oldest first) | CONFORMS | today.ts:316-320, :959-964, :1031-1129, :1257; todayApi.test.ts:976-1163, :2165-2233, :2302-2323 |
| 5.3 Past tours (label every row, oldest first, off-range last, Past tab order unchanged) | CONFORMS | useTodayPastTours.ts:115-156, :175; useTours.ts:227, :254 (shared split; selectPastTours unchanged); useTodayPastTours.test.tsx:81-143; e2e today-past-tours.spec.ts |
| 5.4 Tours to book | CONFORMS | today.ts:346-352, :721-751, :1259; toursRepo.ts:442-465 (pages to completion); Today.tsx:94, :101; todayApi.test.ts:2374-2464; e2e today-checklist.spec.ts:481-540 |
| 5.5 Relay groups to close | CONFORMS | Today.tsx:477-488; Today.test.tsx:397 |
| 5.6 Placements | CONFORMS | Today.tsx:52, :489; the follow_ups group unchanged |
| 6.1 the quiet rule (both thresholds, both boundaries, candidates = core, consistent batch) | CONFORMS | quietShares.ts:26-28, :63-74; followUps.ts:139-243, :195-198; today.ts:1232-1235; quietShares.test.ts:67-158; todayApi.test.ts:2525-2627 |
| 6.2 person row (copy, tags, caseworker role tag, opens contact page, no Interested buttons, order) | CONFORMS | QuietShares.tsx:49-90; quietShares.ts:95-100; QuietShares.test.tsx:73-159; e2e :404-414 |
| 6.3 option C (property line + summary, order, first open, choices kept, Show all N properties, aria) | PARTIAL | R1SC-1 (choices lost on a failed refetch); otherwise QuietShares.tsx:37-45, :92-134, :147-157, :184; quietShares.ts:102-104 |
| 6.4 Follow up tab unchanged | CONFORMS | followUps.ts:248-261 (same sort / byUnit; batch opts exactly `{ requireComplete: true }`); followUps.test.ts:480; followUpsApi.test.ts:83 |
| 6.5 cost + issue | CONFORMS | docs/issues/today-quiet-shares-read-cost.md; todayApi.test.ts:2685-2737 (WI7 counts) |
| 7.1 the field; last_heard_from_at never moved by outbound | CONFORMS | contactsRepo.ts:235-240; e2e today-checklist.spec.ts:465 |
| 7.2 what counts (incl. r8 Send now / Retry of automated copy) | CONFORMS | api.ts:1906-1920; tourReminders.ts:2008; placementNudges.ts:864; retrySend.ts:567; sendReconcile.ts:947; only W1-W8 call the helper (grep) |
| 7.3 repo twin, helper, one event per send, W1-W8, server-owned in 4 places, system_copy | CONFORMS | contactsRepo.ts:2073-2110 vs :2035-2071; staffOutreach.ts:45-70; sendMessage.ts:761 then :776; groupSend.ts:725 before :749; relayAnnouncements.ts:194-226; contacts.ts:319; events.ts:314-337; writer tests per S2 / S3 WI4 tables (present) |
| 7.4 never displayed | CONFORMS | no dashboard reader (grep: one comment, useToday.ts:198) |
| 7.5 backfill (flags, dry-run default, PII-free logs, window Query, categories, one forward-only touch, abort, RUNBOOK) | CONFORMS | backfill-last-reached-out.ts:88-95, :223-229, :306-460, :626-627, :668-677, :698; backfillLastReachedOut.test.ts:175-995; RUNBOOK.md:553-587 (WL-18 step 2 at :568); S7 lane rehearsal (lane 13, apply 1 written 1, apply 2 written 0) |
| 8 live updates | CONFORMS | useToday.ts:182-201; inbound post-touch contact.updated inboundEmail.ts:840, voice.ts:863, :1154, :1255; tour.updated on both creates tours.ts:421, units.ts:1669; Not interested emits none (S2 WI4 row; units.ts diff adds only the Interested emit) |
| 9 testing | PARTIAL | R1SC-2, R1SC-3; otherwise server route tests (todayApi.test.ts:2165-2737, quietShares.test.ts), Follow up regression (followUpsApi.test.ts:83), W1-W8 stamp + event-count tests, W6 seam (voiceOutbound.test.ts:1471), parsers refuse (contactsCrud.test.ts:557-583), dashboard tests, e2e today-checklist.spec.ts and every listed old pin updated |
| 10 docs | CONFORMS | GLOSSARY.md:628, :739, :758, :775; 2026-06-16 spec :57-63; imported-unknown-threads issue Update + retitle; today-quiet-shares-read-cost.md; RUNBOOK.md:553-587; tracker #31 record is planner-owned after the build (mission block post-merge obligation) |

## Verdict table - planner rulings (section 4)

| Ruling(s) | Verdict | Evidence |
|---|---|---|
| PR1 field in ContactItem / RecipientDisplay / projection; parity pin updated | CONFORMS | contactsRepo.ts:240, :414, :1126, :1133; caseworkerRepoParity.integration.test.ts:446-473 |
| PR2 touchLastReachedOut | CONFORMS | contactsRepo.ts:1006, :2073-2110 |
| PR3 consistentRead option, negative pin kept | CONFORMS | contactsRepo.ts:785-788, :1396-1400; contactsRepoConsistentBatchRead.test.ts |
| PR4 SERVER_OWNED | CONFORMS | contacts.ts:319; contactsCrud.test.ts:557 |
| PR5 / PR44 recordStaffOutreach signature, latest per contact, never throws | CONFORMS | staffOutreach.ts:45-70; staffOutreach.test.ts |
| PR6 / PR45 getByIdConsistent | CONFORMS | conversationsRepo.ts:562-570, :1139-1144, :1293 |
| PR7 / PR41 / PR42 fakes; harness records contact.updated | CONFORMS | S1 report C1/C2 (five ContactsRepo literals, four ConversationsRepo literals); harness :540, :546-549, :644 |
| PR8 contact.updated only when written | CONFORMS | sendMessage.ts:775-776; sendEmailMessage.ts:552; voice.ts:1366-1384; dev.ts:871 |
| PR9 staffOutreach option; contacts wiring moved | CONFORMS | sendMessage.ts:409, :770-778; api.ts:700-711 (WI2 recorded) |
| PR10 first batch only | CONFORMS | api.ts:1589; apiRoutes.test.ts (split-send case) |
| PR11 (as amended by PR104) W2 gate | CONFORMS | api.ts:1917-1920 |
| PR12 W3 | CONFORMS | sendEmailMessage.ts:484-489, :550-552 |
| PR13 / PR48 / PR87 W6 after the TwiML, afterResponse seam | CONFORMS | voice.ts:362, :396-405, :1339-1354, :1366-1384, :1737-1744, :1794-1799; voiceOutbound.test.ts:1471-1491 |
| PR14 / PR46 / PR47 W8, shared helper | CONFORMS | dev.ts:162, :856-878; heardFrom.ts:103-119 |
| PR15 / PR81 inbound post-touch events | CONFORMS | inboundEmail.ts:840; voice.ts:863, :1154, :1255; S2 inbound-order table |
| PR16 / PR52 tour.updated on both creates | CONFORMS | tours.ts:421; units.ts:174, :603, :1669; api.ts:1034 |
| PR17 / PR55 / PR93 W4 loop stamps, sentAt arms, after-loop event | CONFORMS | relayFanOut.ts:1553-1599, :1696-1702, :1849-1855, :2306, :2368, :2370 |
| PR18 / PR54 bus defaulted to appEvents, no worker edit | CONFORMS | relayFanOut.ts:901, :974, :1083, :1255 |
| PR19 W5 before the existing emit, excluded slots skipped | CONFORMS | groupSend.ts:614, :631, :718-725, :749 |
| PR20 W7 staffAuthored on the edited branch only | CONFORMS | relayFanOut.ts:1110-1161; relayAnnouncements.ts:133, :332, :391-392, :458 |
| PR21 / PR56 S3 no-stamp tests; recorded residue | CONFORMS | relayRetryLeg.test.ts:736; relayAnnouncements.test.ts:674, :688; relayFanOut.test.ts:3878, :3897, :4108, :4121, :4133; sendReconcile.test.ts:2209 |
| PR22 core split | CONFORMS | followUps.ts:139-243, :248-261 |
| PR23 / PR103 builder, no people count | CONFORMS | quietShares.ts:58-113; today.ts:179-186 |
| PR24 / PR57 / PR96 router deps, non-regression tables | CONFORMS | today.ts:215-217, :423-424; api.ts:1303-1307; todayUnmatchedNonRegression.test.ts:108-173 |
| PR25 / PR86 unit labels | CONFORMS | today.ts:520-537; todayApi.test.ts:2106-2149 |
| PR26 / PR61 unread pass | CONFORMS | today.ts:899, :933-964; no isOneToOneBucket import |
| PR27 identify rows and sort | CONFORMS | today.ts:316-320, :1012-1023, :1116-1127, :1257 |
| PR28 tours_to_book | CONFORMS | today.ts:346-352, :721-751 |
| PR29 tours_today at / unitLabel / time order | CONFORMS | today.ts:694-708, :1261-1265 |
| PR30 quiet shares in the route, item order, header | CONFORMS | today.ts:9-14, :1230-1245, :1275-1282 |
| PR31 / PR32 dashboard types, useToday statuses | CONFORMS | types.ts:492-570; useToday.ts:23-48, :73-113 |
| PR33 / PR65 shared section component, levels, labels | CONFORMS | TodaySection.tsx:20-94; Today.tsx:47-55, :355-383 |
| PR34 option C UI | PARTIAL | R1SC-1 ("survives refetches" fails on a failed refetch); otherwise QuietShares.tsx:92-197 |
| PR35 / PR63 / PR67 / PR80 past tours | CONFORMS | useTodayPastTours.ts:115-178; useTours.ts:227, :254; Today.tsx:297-308 |
| PR36 fallback | CONFORMS | buildToday.ts:43-50, :263-282 |
| PR37 shared files | CONFORMS | api.ts edits anchored on current text (S2/S4 reports) |
| PR38 / PR70 / PR71 / PR72 backfill rule picks | CONFORMS | backfill-last-reached-out.ts:94-95, :306-460 |
| PR39 / PR73-PR77 e2e | CONFORMS | today-checklist.spec.ts; tours-page.spec.ts:255-289; participant-names.spec.ts; support/today.ts:121; routes.ts:396-415 |
| PR40 / PR59 server test inversions | CONFORMS | todayApi.test.ts:1016, :1059-1098, :1110-1153, :1157-1163; re-expressed cases per S4 report |
| PR43 contactTriage pins (stricter) | CONFORMS | contactTriage.test.ts:155-167, :361-365 |
| PR49 tour.updated count pins | CONFORMS | toursApi.test.ts:585-589, :1399-1406, :1418-1420; toursReopenApi.test.ts:492-493 |
| PR50 call-shape pins gain staffOutreach | CONFORMS | apiRoutes.test.ts:85, :735, :890 |
| PR51 stamp at result.providerTs | CONFORMS | sendMessage.ts:772-773 |
| PR53 poll cases assert at the input seam | CONFORMS | tourRemindersApi.test.ts, placementNudgesApi.test.ts (poll cases) |
| PR58 throw-path WARNs carry counts | PARTIAL | R1SC-4 |
| PR60 / PR82 / PR101 recipientDisplayCalls read via opts | CONFORMS | todayApi.test.ts:2566-2567; followUpsApi.test.ts:83 |
| PR62 read-budget counts | CONFORMS | todayApi.test.ts:2718-2736 |
| PR64 heading counts | N/A | superseded by PR102 |
| PR66 generatedAt clock | CONFORMS | useToday.ts:81, :111; Today.tsx:476; today.ts:443-444 |
| PR68 spec copy over mockup | CONFORMS | copy checked line by line (spec 2, 2.2, 2.4, 2.5, 5.4, 6.2, 6.3) |
| PR69 transitional union | CONFORMS | no `'unreplied'` left in dashboard (grep) |
| PR78 lane-only helper, guard | CONFORMS | S7 report (guard refusals proven on probe copies; helper under .superpowers/) |
| PR79 extra drift fixes | CONFORMS | GLOSSARY.md, STATUS-MODEL.md:232-233, :282-287, public-signup-abuse-hardening.md update |
| PR83 / PR94 / PR97 / PR98 process rulings | CONFORMS | slice reports; spec header r7/r8 |
| PR84 harness default-send-path suites | CONFORMS | S2 WI2 list; harness comment :5645-5654 |
| PR85 handback lines | N/A | due at S8 (orchestrator) |
| PR88 one event per fan-out pass | CONFORMS | relayFanOut.test.ts:4009 (WI5) |
| PR89 / PR95 error terminals | CONFORMS | e2e/performance/routes.ts:411-415 |
| PR90 / WL-12 consistency residue recorded | CONFORMS | today.ts:1216-1222; S4 report WI8; cost issue |
| PR91 / PR100 | N/A | superseded by PR104 / PR105 |
| PR92 unread walk recorded | CONFORMS | S4 report WI7; cost issue |
| PR99 events doc comment | CONFORMS | events.ts:314-337 |
| PR102 no heading counts | CONFORMS | TodaySection.tsx:36; Today.test.tsx:202-205 unchanged |
| PR104 system_copy marker and W2 gate | CONFORMS | messagesRepo.ts:777, :1090, :2655; sendMessage.ts:416, :708; api.ts:1906-1920; tourReminders.ts:2008; placementNudges.ts:864 |
| PR105 backfill system-copy and retry-chain rules | CONFORMS | backfill-last-reached-out.ts:283-295, :408-422; backfillLastReachedOut.test.ts:237, :282 |
| PR106 harness maps system_copy | CONFORMS | S2 report (harness :1330; twilioWebhookHarnessRetryFields.test.ts) |
| PR107 marker carried by machine resends | CONFORMS | retrySend.ts:567; sendReconcile.ts:947; retrySendAttempt.test.ts PR107 cases |
| PR108 residue recorded | CONFORMS | S2 report |

## Verdict table - worklist WL-1..WL-22

| Item | Verdict | Evidence |
|---|---|---|
| WL-1 stub never committed | CONFORMS | `git log -- app/src/services/staffOutreach.ts` = 06f173da only |
| WL-2 groupSendRoute pin | CONFORMS | groupSendRoute.test.ts:185-186 (ASCII comment + staffOutreach) |
| WL-3 RED reason | CONFORMS | S2 report (probe recorded, no assertion change) |
| WL-4 bridged masked call stamps no callee | CONFORMS | voiceWebhook.test.ts:898-901 |
| WL-5 all-skipped cases | CONFORMS | relayFanOut.test.ts:4068; relayAnnouncements.test.ts:657 |
| WL-6 fixed provider instants | CONFORMS | relayAnnouncements.test.ts:586 |
| WL-7 comment wording / sweeps | CONFORMS | today.ts:892, :1272-1274 |
| WL-8 available unit on the prefix | CONFORMS | todayUnmatchedNonRegression.test.ts:147-151, :173 |
| WL-9 retitles | CONFORMS | todayApi.test.ts:995, :1004, :1030 |
| WL-10 comment rewrites | CONFORMS | statusModel.ts:207-209; unknownQueue.ts:64-68 |
| WL-11 honest header | CONFORMS | today.ts:33-48 |
| WL-12 listing-sends wording | CONFORMS | today.ts:1220-1222; cost issue; S4 report |
| WL-13 RED list | CONFORMS | S5 report |
| WL-14 one pre-existing lint error | CONFORMS | re-run here: only useTours.ts:128:5, identical at the merge base |
| WL-15 comment hit | CONFORMS | buildToday.test.ts:378 |
| WL-16 Tours today is an h3 | CONFORMS | selectors.md:18; support/today.ts:11-12; tours-page.spec.ts:46, :183, :261; tour-roster.spec.ts:73 |
| WL-17 report text | CONFORMS | S6 report C2 (voice.ts lines re-checked) |
| WL-18 reload step | CONFORMS | RUNBOOK.md:568 (S8 repeat pending) |
| WL-19 anchored ready wait | CONFORMS | S7 report rehearsal |
| WL-20 openWatchingToday + positive control | CONFORMS | today-checklist.spec.ts:211-227, :495-497 |
| WL-21 S7 edits | CONFORMS | fact-extraction issue resolved; imported-unknown retitled; steps.ts:3089, :3107-3126, :3176, :3217; email-triage.spec.ts:64-81; collect.test.ts:371; routes.ts:885 |
| WL-22 lane stopped; S7.16 orchestrator-owned | CONFORMS | S7 report |

## Verdict table - watch items

| Item | Verdict | Evidence |
|---|---|---|
| WI1 Follow up byte-identity | CONFORMS | followUps.test.ts:480; followUpsApi.test.ts:83; mutation check in S4 report |
| WI2 contacts wiring | CONFORMS | api.ts:700-711; S2 before/after |
| WI3 whisper-gate no-await | CONFORMS | voice.ts:1737-1799 read line by line: only `const dialAt` added before sendTwiml; stamp handed off after :1794 |
| WI4 one event per send | CONFORMS | S2 / S3 WI4 tables; counted assertions present |
| WI5 continuation passes | CONFORMS | relayFanOut.test.ts:4009 |
| WI6 re-drive stamps, rung does not | CONFORMS | relayFanOut.test.ts:3978; relayRetryLeg.test.ts:736 |
| WI7 read budget | CONFORMS | todayApi.test.ts:2685-2737 |
| WI8 consistency residue | CONFORMS | S4 report; cost issue |
| WI9 no seed edit | CONFORMS | `git diff --name-only 970a29b9 HEAD -- app/src/lib/seed app/src/lib/performanceSeed.ts app/scripts/db-seed.ts app/src/lib/seedData.ts` = empty |
| WI10 TODAY_PAST_TOURS_CAP removed with its pin | CONFORMS | only a comment remains (useTours.test.ts:320) |
| WI11 fallback only on 404, never All caught up | CONFORMS | useToday.ts:86; Today.tsx:428-434 |
| WI12 backfill only on a lane | CONFORMS | S7 rehearsal on lane 13; RUNBOOK.md:553, :587 |
| WI13 no named-flake re-runs | CONFORMS | S7 report; gate e2e green on its first run here |

## Verdict table - deliberate test inversions

All six are real inversions of an old pin to the new spec; none is weakened.

| Item | Verdict | Evidence |
|---|---|---|
| PR40 | CONFORMS | the #30 "keeps its row" pins now assert strict absence (`toEqual([])`, `not.toContain`): todayApi.test.ts:1016-1023, :1093-1097, :1139-1152, :1157-1163 |
| PR43 | CONFORMS | exact lists grew to name the PATCH's contact.updated: contactTriage.test.ts:155-167, :365 (stricter) |
| PR49 | CONFORMS | create emit pinned by exact payload (toursApi.test.ts:585-589, :1399-1402, :1435-1447); toursReopenApi.test.ts:492-493 stays a count (it was a count), 1 -> 2 |
| PR50 | CONFORMS | exact call shapes gained `staffOutreach: true` (apiRoutes.test.ts:85, :735, :890) |
| PR59 | CONFORMS | Unreplied-only cases re-expressed on unknown_1to1 threads with identify assertions (S4 report list; e.g. todayApi.test.ts:743, :783, :826-915, :1779-1930, :1965-2025) |
| WL-2 | CONFORMS | groupSendRoute.test.ts:186 exact pin gains the field |

## Recorded residue and open items (built per spec; not findings)

- Q-1 (open for Cameron): W3 stamps only the To contact
  (`sendEmailMessage.ts:489`), exactly spec 7.3 "the addressed contact"; a
  CC'd contact is not stamped.
- R-1..R-7 and R-10 are recorded in the S2 / S3 / S4 reports as worded in
  the worklist; R-8 and R-9 are WL-12 and WL-18 (above); R-11 is a handback
  note. PR56 (lost hand-off after a known send)
  and PR108 (pre-deploy rows carry no marker) are recorded in S3 / S2. The S3
  finding that a staff-edited intro leg is stamped before its slot write is in
  the RUNBOOK entry (RUNBOOK.md:563).
- Due at S8 (orchestrator): PR85's two handback lines and WL-18's reload
  line; tracker #31's record of the Oct 23 decisions and option C (spec 10).
