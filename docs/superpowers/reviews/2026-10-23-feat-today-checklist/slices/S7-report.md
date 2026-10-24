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
nothing to stop" and removed both files. Every later run in this slice left
the same two stale files (always lane 12, launcher dead, ports free); each
was cleared the same way before the next run.

## S7.2 - today-checklist.spec.ts, the shared helpers, the selector rows

As planned, with these differences (each a worklist item or a
strengthening; nothing weakened):

- WL-20: `openWatchingToday` also waits for the tab's first
  `GET /api/today` (registered before `goto`, awaited after the event
  stream opens), and test 4 asserts the positive control
  `todayList(today, 'Placements')` visible (lean placement-0001 is always a
  derived stuck row: stage_entered_at 2026-06-01 at
  `app/src/lib/seed/lean.ts:465`, the 10-day awaiting_inspection threshold
  at `app/src/lib/statusModel.ts:387`) BEFORE
  the empty Tours to book and the two creates. RED B below fails
  deterministically with it.
- WL-16: `e2e/support/selectors.md:18` and the `e2e/support/today.ts`
  module header now say `Tours today` is an `<h3>` under the `At a glance`
  `<h2>` (an `<h2>` before tracker #31); the substring-trap advice is
  unchanged. The comment-only `<h2>Tours today</h2>` in
  `e2e/tests/tour-roster.spec.ts:73` is fixed in this commit too (comment
  only); tours-page's go with S7.10.
- `expectNoAiSuggestionFor` (support/today.ts) gains one gate the plan's
  text lacks: after the page's `/api/today` response lands it waits for the
  Today page spinner inside `<main>` (`role="status"`, name `Loading`,
  `dashboard/src/ui/Spinner.tsx:20`) to be gone, so the "line absent" branch
  cannot pass on a page that has not drawn the queue yet (the spinner is
  mounted before the fetch goes out, so its absence after the response
  means the response was rendered).
- `followUpFixtures.ts` keeps `plantListedSend`'s one-line signature exactly
  as `follow-up-tab.spec.ts:92` had it (the plan's text wraps it); the
  bodies are byte-for-byte the moved ones.
- selectors.md's three new Today rows carry the as-built accessible names
  (the property line's `<unitLabel>, <summary>` aria-label, the person
  link's `<name>, <quiet text>`, the AI line's aria-hidden Show/Hide word,
  `Show all N properties`, and the scope-to-the-section note for two
  sections both reading `Show all 6`).

Typecheck `npm run typecheck -w @housingchoice/e2e`: exit 0. eslint on the
five touched e2e .ts files: exit 0, no output.

## RED evidence (S7.2)

| Tag | Files / grep | Exit | Result line | Notes |
|---|---|---|---|---|
| s72-green1 | today-checklist + follow-up-tab | 0 | `6 passed (21.7s)` | green on arrival (S1-S6 built) |
| s72-redA | today-checklist, `--grep "staff text"` | 1 | `1 failed` | `app/src/routes/api.ts:1589` (`...(i === 0 && { staffOutreach: true as const })`) deleted; failed at the server-truth poll (`today-checklist.spec.ts:463`): "the staff text never took the person off Quiet shares", received both contactIds after 15 s. Restored with `git checkout -- app/src/routes/api.ts` (status clean) |
| s72-redB | today-checklist, `--grep "requested tours appear live"` (WL-21) | 1 | `1 failed` (no passed line) | the POST /api/tours emit at `app/src/routes/tours.ts:421` commented out; failed at `await expect(list.getByRole('link')).toHaveCount(2)` (:503), received 0 (33 polls, 15 s). Restored with `git checkout -- app/src/routes/tours.ts` (status clean) |
| s72-green2 | today-checklist + follow-up-tab | 0 | `6 passed (20.2s)` | the restored tree |

Artifacts of both REDs: `.superpowers/s7/s72-redA-artifacts/`,
`.superpowers/s7/s72-redB-artifacts/`.

## S7.3-S7.10 - the existing pins, updated deliberately

Each task: the edits, `npm run typecheck -w @housingchoice/e2e` (exit 0),
eslint on the touched file (exit 0, no output), the ASCII check on added
lines (0), its RED and GREEN as below, one commit. No app, dashboard or
seed file is changed by S7a (the two RED A/B breaks were reverted with
`git checkout` before any commit).

| Task | Commit | RED | GREEN |
|---|---|---|---|
| S7.3 unknown-caller-triage | 866cb846 | baseline: `expect(row!.group).toBe('needs_you_now')` received `identify` | s73: exit 0, `2 passed (12.6s)` |
| S7.4 unknown-inactive | 90e668ec | baseline: step (3) no `Needs you now` row | s74: exit 0, `1 passed (14.0s)` |
| S7.5 conversation-fact-extraction | d1bc799a | baseline ("Today tile", the missing list) + s75-probe: exit 1, `1 failed` at the probe line (:338) "contact <id> still has an AI suggestions row on Today" (server truth, 10 s) | s75: exit 0, `12 passed (19.3s)` |
| S7.6 caseworkers | 6f5ac427 | s76-probe: exit 1, `1 failed` at the probe line (:522), same message | s76: exit 0, `6 passed (16.0s)` |
| S7.7 participant-names | 0250089d | s77-probe: exit 1, `1 failed` at the probe line (:53): expected substring `PNTenant188993 Tester`, received `PNTenant188993X Renamed188722 Sender Way NW, Atlanta, GA 30314Requested today` | s77: exit 0, `1 passed (15.5s)` |
| S7.8 today-past-tours | ec25c948 | baseline: `expect(hrefs)` received oldest first | s78: exit 0, `1 passed (13.6s)` |
| S7.9 steps.ts + email-triage | bb277f37 | baseline: `expectPlacementStuckInFollowUps` found no `Follow-ups due` list | s79 (post-tour-application + email-triage): exit 0, `9 passed (41.4s)` |
| S7.10 tours-page | 017b9d8e | s710-probe (the reordered test with the OLD page-wide locator): exit 1, `1 failed` / `5 passed`, `toHaveCount(0)` received 1 at :289 (the Tours to book link) | s710: exit 0, `6 passed (15.2s)` |

Every probe line was removed or restored before its commit (`grep -n "RED
PROBE"` printed nothing). Probe artifacts: `.superpowers/s7/s7<n>-probe-artifacts/`.

Combined run at 017b9d8e (tag `s7a-final`): the 12 behavior-changed files
(today-checklist, follow-up-tab, unknown-caller-triage, unknown-inactive,
conversation-fact-extraction, caseworkers, participant-names,
today-past-tours, post-tour-application, tours-page, relay-number-lifecycle,
email-triage) in one lane: exit 0, `50 passed (2.0m)`.

AI line branch actually taken (the server's per-load `ai_suggestions`
count in the run log): conversation-fact-extraction's two clears-review
tests and caseworkers' Unknown-card test ran with 0 AI rows, so
`expectNoAiSuggestionFor` took the "line ABSENT" branch; the Today tile
test saw 1 AI row (well inside the opened list's five).

### Deviations from the plan text (each a strengthening or a worklist item)

- S7.4: the plan's check `grep -n "needsYouNow\|Needs you now\|needs_you_now"`
  "prints nothing" cannot hold: the plan's own Edit 1 replacement writes
  "rows moved there from Needs you now in tracker #31"
  (`unknown-inactive.spec.ts:8`, a history clause). That one hit is the
  only one.
- S7.7: the negative check and the RED probe use the contact's display name
  before the rename, `${tenant.firstName} ${tenant.lastName}`, not the plan's
  `tenant.name`: `freshContact` (`e2e/scenarios/steps.ts:88-96`) sets `name`
  to a label (`<label> <stamp>-<seq>`) that is never rendered, so
  `not.toContainText(tenant.name)` could never fail and the plan's probe
  would have failed for the wrong reason. The probe above shows the row
  carries only the new name.
- S7.9 (WL-21): `expectRtaDeadlineOnBoard` / `expectVoucherDeadlineOnBoard`
  expand Needs you now (`showAllIn`) and match the list `exact`;
  `expectPlacementGoneFromBoard` polls GET /api/today (a non-200 throws)
  until no item of any group has refType `placement` and that refId, then
  keeps its DOM count; email-triage's check (b) waits for the page's own
  `/api/today` response, asserts no item's `who` or `why` matches the
  stranger address (`who` per WL-21; `why` added - stricter), then keeps its
  DOM count. These are pins (green before and after; no RED of their own).
- S7.10: the positive Tours to book check is asserted BEFORE the
  `hasTodaySection` probe (the plan put it after the absence block, at the
  "Additional" comment). Reason: `isVisible()` does not wait, and in the
  baseline it ran before the queue had loaded (see the baseline section), so
  the absence check was skipped; a visible Tours to book row comes from the
  same GET /api/today as Tours today, so the probe now reads a loaded page.
  The s710-probe run shows `hasTodaySection` is then true on this file's
  lane (the first test's noon tour) and the old page-wide locator fails.
- WL-16 comment fixes: `tours-page.spec.ts:46,182-183,259` (in the S7.10
  commit) and `tour-roster.spec.ts:73` (in the S7.2 commit) now say
  `<h3>Tours today</h3>`; the lines carrying an em dash or box-drawing
  characters were left untouched.

### Deliberate test changes (named; no assertion weakened)

- unknown-caller-triage: the row's group `needs_you_now` -> `identify`; NEW
  exactly-one-row-per-contact check; the DOM list `Needs you now` ->
  `Identify these contacts` (exact).
- unknown-inactive: `needsYouNowIds` -> `identifyIds` (group `identify`);
  `todayRow` reads `Identify these contacts` (exact); header, comments and
  the test title follow.
- conversation-fact-extraction: the Today tile test asserts the AI line
  closed by default (`aria-expanded="false"`, its list absent) and opens it
  before the three row assertions; the two clears-review tests replace the
  vacuous hidden-list count with `expectNoAiSuggestionFor`; the test title
  "...AI-suggestions-to-review group" -> "...AI suggestions line".
- caseworkers: the Unknown card's hidden-list count -> `expectNoAiSuggestionFor`;
  the dead `todayReview` constant removed.
- participant-names: the unread-text vehicle (`flow.tenantTexts` into
  Unreplied) is dropped; the renamed name is asserted on the flow's own
  requested tour's row in Tours to book (by tour href), with the old display
  name absent; the reload loop is gone (the tour exists before the load).
- today-past-tours: order oldest first (three rows, then seven); NEW: no
  Show all at three rows; five rows then `Show all 7` (aria-expanded
  false) -> seven rows in order -> `Show fewer` (aria-expanded true) -> five;
  the Past-tab link is `Open the Past tab` (PAST_TAB_LINK_AT_SEVEN, PR76) and
  still lands on seven Past rows. As-built S5 matched PR67 (no S5
  deviation).
- steps.ts: `Follow-ups due` -> `Placements` (exact) after `showAllIn`; the
  step name and docblock follow; the method keeps its name
  (`expectPlacementStuckInFollowUps`); plus the WL-21 hardenings above.
- email-triage: check (b) gains the server-truth read (above).
- tours-page: the absence is scoped to the Tours today list; NEW positive
  Tours to book check (asserted first, above).
- follow-up-tab: its five fixtures moved verbatim to
  `e2e/support/followUpFixtures.ts` (imports only; behavior unchanged, green
  in s72-green1/2).

### Left for the second S7 implementer / the planner

- S7.11-S7.15 and S7.17 (second implementer); S7.16 orchestrator-owned
  (Phase 5, WL-22).
- `dashboard/src/routes/today/useToday.test.tsx:190` stale test title
  (recorded in the re-grep above; not an e2e file).
- `e2e/support/today.ts` gains `todayList`, `todaySection`, `showAllIn`,
  `aiSuggestionsLine`, `openAiSuggestions`, `expectNoAiSuggestionFor`,
  `AI_SUGGESTIONS_LIST`; `showAllIn` is section-scoped and would be
  ambiguous for the AI list (its Show all sits in the At a glance section,
  beside Tours today's) - not needed today (at most one AI row in these
  worlds).
- Lane hygiene: every run here left `e2e/.artifacts/session.pid` and
  `lane.json` behind with the launcher already dead and the ports free;
  `npm run e2e:stop` cleared them each time ("retained state is stale or
  absent"). Worth knowing for S7.15's session work.
