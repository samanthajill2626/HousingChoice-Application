# S7 report - e2e, backfill lane rehearsal, docs

Branch feat/today-checklist. S7 starts at 04307931 (the S6 report). Part
one (S7a: Tasks S7.1-S7.10) is written by the first S7 implementer; the
second S7 implementer appends S7.11-S7.15 and S7.17. S7.16 (live self-QA)
is orchestrator-owned (Phase 5, WL-22). Line numbers are at 04307931 unless
a section says otherwise. Every e2e run goes through
`.superpowers/s7/run-spec.sh` (gitignored; a cold boot through the e2e
workspace, `timeout 2700 npm run e2e -w @housingchoice/e2e -- <args>`).

## Re-grep of the old Today page's readers (S7.1)

Commands: plan S7.1 step 2, with "Needs you now" added to the app/dashboard
grep (WL-10's note). e2e hits and their disposition (every hit the grep
found, plus the rows WL-16 and WL-21 add):

| Hit | Disposition |
|---|---|
| `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:7,66-67,74,76,87,90` | S7.3 |
| `e2e/tests/dashboard-next/unknown-inactive.spec.ts:6,10,19,51-52,129,132-133,135,161,189,321` | S7.4 |
| `e2e/tests/flows/conversation-fact-extraction.spec.ts:19,357,402,430` | S7.5 |
| `e2e/tests/dashboard-next/caseworkers.spec.ts:88` (the `todayReview` constant read at :551; :213 is an unrelated "AI suggestions" docblock) | S7.6 |
| `e2e/tests/scenarios/participant-names.spec.ts:46` | S7.7 |
| `e2e/tests/dashboard-next/today-past-tours.spec.ts:1,31` | S7.8 |
| `e2e/scenarios/steps.ts:3190` (Follow-ups due) | S7.9 |
| `e2e/scenarios/steps.ts:3087,3153` (expectRtaDeadlineOnBoard / expectVoucherDeadlineOnBoard read 'Needs you now') | S7.9 per WL-21: `showAllIn(page, 'Needs you now')` first, list `{ exact: true }` (the rows stay needs_you_now, spec 5.1; the 5-row limit can hide a row on this no-reseed scenario lane) |
| `e2e/scenarios/steps.ts:3100-3116` (expectPlacementGoneFromBoard, a page-wide `a[href="/placements/<id>"]` count) | S7.9 per WL-21 / E2-1: GET /api/today server truth first, then the DOM count |
| `e2e/tests/flows/email-triage.spec.ts:64-66` (check (b), a DOM-only `getByText(/stranger\.caller/)` count; not matched by the grep patterns) | S7.9 per WL-21 / E2-1: server truth after the Today fetch landed, then the DOM count |
| `e2e/scenarios/steps.ts:550,3077,3143,3146,3182` | stay (comments; the needs_you_now rows are still needs_you_now, and the `Tours today` substring trap is still true) |
| `e2e/performance/routes.ts:268,274,396-402,622`; `routes.test.ts:73`; `collect.ts:69`; `templates.ts:30` | S7.11 (second implementer; `:396-402` and the `'/'` terminal citation). The `/api/today` shapes stay: the Today fetch still sends `day`, `toursFrom`, `toursTo` (`dashboard/src/api/endpoints.ts:161-162`) |
| `e2e/support/selectors.md:65` | S7.2 (the AI list row replaced by three Today rows) |
| `e2e/support/selectors.md:18`, `e2e/support/today.ts:11` (say `Tours today` is an `<h2>`) | S7.2 per WL-16: rewritten - `Tours today` is an `<h3>` under the `At a glance` `<h2>` since tracker #31 (`dashboard/src/routes/today/Today.tsx:355-357`); the substring-trap advice is unchanged |
| `e2e/tests/dashboard-next/tours-page.spec.ts:255-273` | S7.10 (C1) |
| `e2e/tests/dashboard-next/tours-page.spec.ts:46,183-184,259` and `e2e/tests/tour-roster.spec.ts:73` (comment-only `<h2>Tours today</h2>`) | fixed per WL-16: tours-page in the S7.10 commit, tour-roster in the S7.2 commit (with selectors.md:18 / today.ts:11) |
| `e2e/tests/dashboard-next/tours-page.spec.ts:7,88,178,187-188` | stay (Tours today is still a list named `Tours today`) |
| `e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts:25,367,374-375,378` | stay; pin in S7.17 (the full world seeds one past-due nag; the regex heading matches the bare heading) |
| `contact-create-relay-group.spec.ts:101`, `deleted-contact-resurfacing.spec.ts:29`, `outbound-mms.spec.ts:64`, `scenarios/post-tour-application.spec.ts:238` | comments, still true; stay |
| `e2e/tests/dashboard-next/org-lists.spec.ts:20` (in the plan's table) | no hit in the tree: :18-22 are an "AI suggestions (D8)" docblock about the org picker, unrelated to Today; its only Today use is `expectTodayReady` (:47, :102, :545). Stays |

app/src, app/test, dashboard/src (patterns "unreplied|Unreplied|Follow-ups
due|AI suggestions to review|What needs you|Group texts to close|Needs you
now"):

- app/src: NO hit. WL-10's two comments are already rewritten by S4
  (`app/src/lib/statusModel.ts:208` and `app/src/lib/unknownQueue.ts:64`
  now say "Today's Identify these contacts").
- Live dashboard code: only the CURRENT section label 'Needs you now'
  (`dashboard/src/routes/today/Today.tsx:3,47,57`) - correct, the section
  stays (spec 5.1). No leftover group value, heading or copy.
- Test files recording a removal (history, recorded only):
  `app/test/todayApi.test.ts:7,316,340,371,716,873,1038,1961,2351,2369`;
  `dashboard/src/routes/today/buildToday.test.ts:139,202,204,378`;
  `dashboard/src/routes/today/Today.test.tsx:204-205,209-210,330,350,369,383,386`
  (the bare-heading pins, the Unreplied/Follow-ups absence and the old
  subtitle's absence).
- For the planner (not an S7 edit - no dashboard change is mine):
  `dashboard/src/routes/today/useToday.test.tsx:190` keeps the title
  "refetches when a contact.updated event arrives (a contact marked Inactive
  leaves Needs you now)"; its assertions are group-agnostic (the S5 report
  says so). A stale TITLE only: the contact now leaves Identify these
  contacts.

Docs hits (plan S7.1 step 2, case-insensitive): `documentation/GLOSSARY.md:700-701,720,725,728`
and `documentation/STATUS-MODEL.md:232,283-284,289,292` (S7.13);
`docs/issues/public-signup-abuse-hardening.md:122,142,172-173` (S7.14);
`docs/issues/fact-extraction-spec-vacuous-today-absence-checks.md:15`
(OPEN; S7.14 resolves it per WL-21 once S7.5/S7.6 land); the resolved
issues `inbound-calls-invisible-in-inbox.md:127` and
`today-shows-phone-instead-of-name.md:35` (history - stay).
`docs/issues/relay-groups-ignore-member-deletion.md` and
`case-single-next-deadline-slot.md` did not match these patterns.

Other greps: `toursFrom|toursTo` - the Today fetch still sends both
(`dashboard/src/api/endpoints.ts:161-162`). The page error reads `We
couldn&apos;t load your queue. Please try again.` in the TSX source
(`dashboard/src/routes/today/Today.tsx:450`), so the literal grep for
`We couldn't load your queue` misses it - rendered text unchanged (PR97's
apostrophe note for S7.11); `All caught up` at `Today.tsx:460`.

As-built names (S7.1 step 3): all present, as the S5 report lists them, with
these differences from the plan's Cross-slice notes (the plan's spec text
selects by the as-built names below; each is handled where noted, no `UI`
constant changed so far):

- Tours today is an h3 inside the At a glance `<section>`
  (`Today.tsx:355-357`), not an h2 (WL-16; the plan's S7.1 table said
  ":18 stays true").
- Quiet shares property line: a button whose accessible name is its
  aria-label `<unitLabel>, <summary>` (`QuietShares.tsx:112`); the name still
  STARTS with the street line (the unitLabel begins with it), so the plan's
  `/^<line1>/` locator holds; the visible text also carries the summary
  (`:116`), so `toContainText(summary)` holds.
- Quiet shares person row: a link whose accessible name is its aria-label
  `<name>, <quiet text>` (`, Caseworker,` between for a caseworker,
  `QuietShares.tsx:75`); the quiet text and the tag are separate spans
  (`:80`, `:83-85`), so the plan's exact `getByText` reads hold.
- AI line: a button whose accessible name is `AI suggestions for N
  contact(s)` (its visible Show/Hide word is aria-hidden,
  `Today.tsx:368-378`); its opened list is named `AI suggestions` and sits in
  a `<div>`, not a `<section>`, inside the At a glance section.
- Tours today rows: links whose aria-label is `Tour for <who> at
  <unitLabel>, <time>` (`Today.tsx:326-335`).
- Server (S4): `'identify'` / `'tours_to_book'` groups, `Requested today`
  (`app/src/routes/today.ts:349`), `quietShares` / `toursToBook` on the
  response (`:1303-1304`), as planned. The quiet-shares wire has no
  top-level `people` (PR103; the Cross-slice note's `people` is wrong, WL-21
  - no deviation recorded).
- S2: `staffOutreach` at `app/src/routes/api.ts:1589` (the 1:1 route,
  `i === 0`) and `:1920` (the Retry route); POST /api/tours emits
  `tour.updated` at `app/src/routes/tours.ts:421`.
- S6: `app/scripts/backfill-last-reached-out.ts` counters `planned`,
  `written`, `skipped`, `failed` (`:493-497`), usage `--env local|dev|prod
  [--lane <L>] [--apply]` (`:692`) - as planned.

## Baseline run on the S1-S6 tree (S7.1 step 4)

Tag `baseline`, HEAD 04307931, 11 files: the plan's ten plus
`tests/flows/email-triage.spec.ts` (WL-21 adds it to S7.9). Exit `1`;
`5 failed`, `41 passed (2.4m)`. Every failure is one the plan predicted, at
the predicted assertion (artifacts copied to
`.superpowers/s7/baseline-artifacts/`):

- today-past-tours.spec.ts:97 - `expect(hrefs).toEqual(...)` at :121:
  received the OLDEST first (no-show, needs-outcome, not-marked) where the
  spec expects most recent first.
- unknown-caller-triage.spec.ts:38 - `expect(row!.group).toBe('needs_you_now')`
  at :74, received `identify`. Test 2 (:115) passed.
- unknown-inactive.spec.ts:189 - step (3), `todayRow(today, phoneA)`
  toBeVisible at :228: `getByRole('list', { name: 'Needs you now' })` holds
  no such row (element(s) not found, 15 s).
- conversation-fact-extraction.spec.ts:408 ("Today tile") - `group`
  toBeVisible at :431: no list named `AI suggestions to review` (10 s).
- post-tour-application.spec.ts:270 - `expectPlacementStuckInFollowUps`
  (steps.ts:3192): no `Follow-ups due` list holds the row (10 s).

Passing tests this slice changes, and why they passed:

- conversation-fact-extraction.spec.ts:315 and :363 (the two "clears Today
  review" tests) - VACUOUS (C3): the counted list is not in the
  accessibility tree until the AI line opens.
- caseworkers.spec.ts:503 (the Unknown card) - VACUOUS (C3), same reason.
- participant-names.spec.ts:21 - ACCIDENTAL (C2): `getByText(renamed.name).first()`
  now finds the name on the flow's own requested tour in Tours to book.
- tours-page.spec.ts:195 ("schedule WITHOUT a time") - VACUOUS:
  `hasTodaySection` was FALSE. The probe is `toursTodayList.isVisible()`
  (:268), which does not wait, right after `expectTodayReady` (the h1); had
  the Tours today list been rendered, the same /api/today response would
  have rendered the Tours to book link and the page-wide count at :270 would
  have read 1. So the absence check never ran (S7.10).
- post-tour-application.spec.ts:210 (the overdue RTA on Needs you now, then
  gone from the board) and email-triage.spec.ts:42 (check (b)) - valid on
  this lane, but their reads were DOM-only (S7.9 adds server truth first).
- relay-number-lifecycle.spec.ts (all 6), follow-up-tab.spec.ts (both),
  caseworkers' other 5, tours-page's other 5, email-triage's other 3, the
  rest of conversation-fact-extraction (9 of 12) and of post-tour-application
  (:105, :181, :249) - valid.

Lane note: the run left `e2e/.artifacts/session.pid` and `lane.json`
(lane 12, ports 10201/10211/10221/10231) behind with the launcher (pid
55264) already dead and no listener on the four ports; `npm run e2e:stop`
answered "no running session found; retained state is stale or absent -
nothing to stop" and removed both files.
