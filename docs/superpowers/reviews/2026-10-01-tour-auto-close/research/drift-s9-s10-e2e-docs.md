# Drift check - S9 (e2e), S10 (docs, issues, RUNBOOK), Task 8.8 seed comments, e2e blast radius

- Mission: feat/tour-auto-close (W:\tmp\tour-auto-close). Checked 2026-10-02 against
  HEAD f319a306 = main @ae04122d + 5 docs-only commits; `git diff --stat ae04122d HEAD
  -- app dashboard e2e scripts RUNBOOK.md documentation docs/issues` is empty, so every
  citation below is main's code.
- Plan v4: S9 :1688-1759, S10 :1763-1813, S11 :1817-1846, Task 8.8 :1669-1684, and the
  Task 5.4 doc lines :1255-1257. Spec sections 9.3, 9.4, 11, 12, 13, 15.
- Byte-exact quotes for everything cited here live in the gitignored reference
  `.superpowers/sdd/research/ref-s9-s10-e2e-docs.md` (sections 1-12).
- Read-only: no source, test or doc was edited; no test suite or e2e command was run.
  One read-only lint for a gate-5 baseline: `npx eslint
  e2e/tests/dashboard-next/today-past-tours.spec.ts` -> exit 0.

Verdict: 13 plan corrections, none STOP-worthy (every S9/S10 task is doable once
corrected). Only ONE existing e2e spec breaks under the new behavior -
today-past-tours.spec.ts, which Task 9.1 already rewrites.

## 1. Plan corrections

1. Task 9.1 - the negative no-show assertion is not named.
   Plan lists the count, link and order changes. Tree:
   e2e/tests/dashboard-next/today-past-tours.spec.ts:121-122 asserts that
   `a[href^="/tours/<noShowId>"]` has count 0 on Today ("nowhere on Today"); it FAILS
   as soon as Today lists no-shows. Instruction: delete :121-122 and assert the row:
   link name `/^Tour for Tasha Nguyen at .* on .*, No show$/` (built at
   dashboard/src/routes/today/Today.tsx:196-205 from pastState, useTours.ts:271), and
   add `/tours/<noShowId>` (no `?outcome=1`, Today.tsx:202) as the third href at :118.

2. Task 9.1 - exact edit map (the plan's list is right but loose).
   Change: header :1-20 (:2, :11-13, :16-18); title :95; comment :101-102; :115 2->3;
   :118 add the no-show href; :121-122 per item 1; :123-124 'See all 3 on the Past tab'
   -> 'Open the Past tab' (href stays /tours/past, Today.tsx:255-256); :128 2->3
   (360px); :133 comment "Two cards" -> "Three cards"; :136 2->3 (880px - this count is
   `list.getByRole('link')`, not listitems); :163 2->3; :167 1->2; :170 comment "six"
   -> "seven"; :177-178 expected order -> [notMarked, noShow, ...older.slice(0, 3)];
   :179 comment. UNCHANGED although the plan restates them: :180-185 already read
   'See all 7 on the Past tab' and 7 Past rows (Past = notMarked + noShow + 5 older;
   the decided needs-outcome tour is toured WITH an outcome and is dropped,
   useTours.ts:203). Also unchanged: :113-114, :119-120, :152-161, :166, :168, :187-192.
   Change map + draft lines: reference section 1b.

3. Task 9.2 - the landlord phone needs two reads.
   Plan: read the phones "through GET /api/contacts/:id / GET /api/units/:id". Tree:
   the unit read returns `{ unit: { ...unit, contacts, mediaDisplay } }`
   (app/src/routes/units.ts:483) and roster rows carry no phone (UnitContact,
   app/src/repos/unitsRepo.ts:67-74). Instruction: GET /api/units/unit-0001 ->
   `unit.landlordId` -> GET /api/contacts/<landlordId> -> `contact.phone`; tenant =
   GET /api/contacts/contact-tenant-0001 -> `contact.phone`. Lean values:
   +15550100001 (lean.ts:102); contact-landlord-0001 (lean.ts:41, :207) with
   +15550100002 (lean.ts:139). Precedent tours-past.spec.ts:36-37 hard-codes both, so
   "never hard-code" is this plan's own rule - fine, it just needs the second hop.

4. Task 9.2 - the copied cleanup must skip closed tours.
   Plan: copy "the quiet cleanup pattern" and "for every created tour that is not
   closed, decide it". Tree: today-past-tours decide() (:67-74) PATCHes
   {status:'toured'} whenever status !== 'toured'; a closed tour answers 409
   illegal_status_transition (app/src/routes/tours.ts:1076-1079) and decideQuietly
   (:81-88) swallows it. Tests 1 and 2 end closed. Instruction: in the copied
   decide(), return early when the GET shows status 'closed' (test 3 ends toured with
   no outcome after Cancel and is decided normally).

5. Task 9.2 - text locators need exact or scoped forms (strict-mode trap).
   Plan names the texts only. Tree: the tour page renders the tour's activity twice -
   the conversation transcript (dashboard/src/routes/tours/TourDetail.tsx:243) and the
   Activity card (:877) - and Task 8.8 adds the label "Closed automatically: no outcome
   recorded after two weeks", which case-insensitively CONTAINS both "No outcome
   recorded" and "Closed automatically". Playwright getByText(string) is a
   case-insensitive substring match. Instruction: on the tour page scope to the
   Outcome card (`page.locator('section').filter({ has: page.getByRole('heading',
   { name: 'Outcome' }) })`, e2e/scenarios/steps.ts:2550-2552) and use
   `getByText('No outcome recorded', { exact: true })` and the literal string
   'Closed automatically on' - never `/Closed automatically/`. Header badge:
   `page.locator('header').filter({ hasText: 'Tour -' }).getByText('Scheduled',
   { exact: true })` (steps.ts:3768-3776). Closed tab: `page.getByRole('region',
   { name: 'Closed tours' }).locator('a[href="/tours/<id>"]')` + exact text
   (tours-page.spec.ts:441-444) - unscoped, the new Closed intro ("... closed as not a
   fit, closed automatically with no outcome, ...") also substring-matches. Past tab:
   the 'Past tours' region row filter (tours-past.spec.ts:115-117, :126). The "Reopen
   tour" button by role is safe: no existing e2e locator names a bare "open".

6. Task 9.2 - make the "nothing sent" read non-vacuous.
   getOutboundTo(request, { to, since }) (e2e/fixtures/fakeTwilio.ts:201-211) returns
   outbound messages of the thread whose partyNumber EQUALS `to`, filtered by
   `createdAt >= since` (string compare). Read immediately after the tick it proves
   little about an async send. Precedent tours-past.spec.ts:190-197 waits 2 s, then
   reads per party. Instruction: same settle (or read after the tour-page
   navigation). Cheap belt and braces - the sweep has no messaging deps (spec 6.5).

7. Tasks 9.1 / 9.2 - "run it alone": README:55 is the wrong form.
   Plan: "see e2e/README.md for running one spec against a lane". Tree: there is no such
   README section. e2e/README.md:55 documents `npm run e2e -- --grep "<name>"` at the
   ROOT, whose script is a second npm hop (`npm run e2e -w @housingchoice/e2e`,
   package.json:41); that hop consumes `--grep` and Playwright then runs the WHOLE
   suite (project memory isolate-failing-test-first) - 20-35 minutes against a lane
   that serves source live. Instruction: from W:/tmp/tour-auto-close run
   `npm run e2e -- tests/dashboard-next/today-past-tours.spec.ts` (a positional path
   survives; README:68 shape) or the single hop
   `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/tour-auto-close.spec.ts`;
   use `--grep` ONLY in the single-hop form. A live e2e:session in this worktree is
   reused automatically (e2e/playwright.config.ts:26-51); otherwise a lane cold-boots
   (webServer timeout 180 s, :204) and is torn down.

8. Task 10.2 - resolution and update block format; the dates.
   Plan: "status: resolved; append a RESOLVED (2026-10-01) block". Tree convention:
   `status: resolved` plus a `resolved: YYYY-MM-DD` frontmatter line
   (docs/issues/README.md:53 schema, :85-87 lifecycle; _TEMPLATE.md:25-26; example
   past-tab-timeless-toured-tours.md:6-7) and a closing paragraph titled
   `**Resolution (YYYY-MM-DD, <branch>).**` (84 occurrences of
   `**Resolution (DATE).**`, branch-suffixed variants common, one `**RESOLVED ...**`
   outlier). Instruction: add `resolved:` right under `status:` and title the block
   `**Resolution (<date>, feat/tour-auto-close).**`. Update blocks:
   tours-scheduled-range-query-unpaginated.md already uses `**Update 2026-09-30.**`
   (:39) - follow it; tours-patch-status-precondition.md has none - use
   `**Update (<date>, feat/tour-auto-close).**`; `updated:` is optional (README.md:52).
   The clock is past midnight: stamp `resolved:` / `created:` with the day S10 runs
   (2026-10-02 or later), not the plan's literal 2026-10-01; the feature date in
   headings (GLOSSARY, RUNBOOK) can stay 2026-10-01.

9. Task 10.2 - the new issue file.
   Slug `tour-relay-open-vs-auto-close-race` is free. The validator
   (scripts/issues.mjs:15-18) requires id/title/type/severity/status, checks the
   enums (debt / low are valid) and id == filename (:49), and never exits non-zero -
   read its warning lines. Delete the template's comment block (_TEMPLATE.md:12-19 says
   to). Refs (live): the guard is a status READ
   (app/src/services/rosterProvision.ts:150-164 tourOpenGuard); the claim call (:335)
   carries no status condition (app/src/repos/toursRepo.ts:432-446:
   `attribute_exists(tourId) AND attribute_not_exists(#gt)`); two callers -
   app/src/routes/tours.ts:1594 (immediate open) and app/src/jobs/rosterActions.ts:156
   (deferred quiet-hours open; its closed check :170 is also a read). routes/tours.ts
   lines move during S3-S6: cite symbols or re-derive the numbers at S10. Spec 6.6's
   claim is verified.

10. Task 10.3 - RUNBOOK has no "deploy notes" section.
    Tree: no heading contains "deploy note" (case-insensitive grep). Per-feature
    deploy notes are `###` entries under `## Daily operations` (RUNBOOK.md:21), between
    `### DynamoDB schema changes ...` (:111) and `### Promote to prod ...` (:449), not
    in date order. Model: :405 `### Tour reminder supersession (2026-09-01): NOTHING is
    owed - no backfill, no Terraform, no sweep`, a bold lead sentence (:407), bullets
    (:409-412). Instruction: insert `### Tour auto-close (2026-10-01): NOTHING is owed
    - ...` immediately before :405 (keeps the tour entries adjacent), same shape (bold
    lead, then BEFORE / WHAT HAPPENS / AFTER); ASCII-only added lines.

11. Task 8.8 - the seed-comment sweep misses four stale claims (no test goes RED).
    Plan: reword history.ts ~:79-96, seedTourTrails.test.ts ~:53-69 and the title
    ~:134, seedHistory.test.ts ~:858-861. Tree also has: the title at
    app/test/seedTourTrails.test.ts:463 ('every live tour trail type is one of the
    pinned 8 dashboard label keys'); app/src/lib/seed/history.ts:697-700 ("in the LIVE
    writers' full vocabulary", seven kinds listed); :843-845 ("FAITHFUL MIRROR of the
    live writer's event vocabulary"); :81-82 ("MIRRORS the live writer's
    recordTourEvent set") - all false once the shared writer emits tour_auto_closed and
    tour_reopened. Instruction: reword these too - the seeded kinds are a SUBSET of both
    the dashboard labels and the live vocabulary; the two new kinds are live-only and
    never seeded (history.ts:564-568 lists seeded kinds and may stay). Nothing goes
    RED: every pin is a membership check (seedTourTrails.test.ts:139, :467;
    app/test/seedHistory.test.ts:873) and TOUR_EVENT_LABELS is not exported
    (tourActivityFormat.ts:14). history.ts:1107 (the supersede filter) needs no change.

12. Task 10.1 - GLOSSARY entry shape and spot.
    Tree: `## Feature & label notes` (documentation/GLOSSARY.md:115); entries are
    `- **<term>** (<context>, <date>[, Sam's item N]) - <definition>`, ~80-column
    wrap, blank line between (model: Staff notes :141-149, "(contact `staff_notes`,
    2026-09-26, Sam's item 22)"); order is topical, not by date; the list ends at :310,
    then `---` at :312. Instruction: append after :310; write the parenthetical as
    "(tour auto-close, 2026-10-01, Sam's item 18)" - the plan's draft puts the item
    before the date; name the staff labels ("No outcome recorded", "Reopen tour",
    "Closed automatically on <date>") and the code/data names. ASCII-only added lines
    (the file has non-ASCII, e.g. :128).

13. Task 5.4 doc lines (feed S9) - selectors.md has table rows, not a list.
    Plan: e2e/support/selectors.md "lists the tick seams (around :101-108)". Tree:
    "Dev seam" TABLE rows at :100 (logtail), :101 (group-guardrails tick), :102
    (staleness check), :108 (roster-actions tick), :109 (message fixture), with Fake
    Twilio rows :103-107 between them; README's list is e2e/README.md:588-589.
    Instruction: add one `| Dev seam | ... |` row after :108 and extend :588-589
    (drafts: reference section 5). Pre-existing, out of scope: both lists and
    RUNBOOK.md:1119 omit the journal-sweep poll/tick (app/src/worker.ts:520,
    app/src/routes/dev.ts:555) - leave it.

## 2. E2E blast radius (Today lists no-shows; Closed badge; intros; auto-close exists)

Breaks: ONLY today-past-tours.spec.ts - :115, :118, :121-122, :124, :128, :136, :163,
:167, :178 (items 1-2). Everything else in the sweep survives:

- tours-past.spec.ts:113 `getByText(/^Last 90 days:/)` - the appended sentence keeps
  the prefix (PAGE_INTRO.past, dashboard/src/routes/tours/ToursPage.tsx:593, one <p>
  at :695). Its no-show row (:118-132) lives on the Past tab, whose selection is
  unchanged.
- tours-page.spec.ts:389-453 (Closed tab) - the not-a-fit closed row gains a "Not a
  fit" badge; `closedRow.getByText('Closed', { exact: true })` (:444) and the canceled
  row (:447) stay unique (canceled rows get no badge under plan 8.6's guard).
- "All caught up": only today-past-tours (:12, :114 count 0 - still true). "Open the
  Past tab", "Tours that ended": no hits. "See all": today-past-tours :13, :17, :124,
  :180 (only :124 changes) plus an unrelated inbox row (selectors.md:23).
  "/tours/past" and "/tours/closed" hits keep their meaning.
- no_show hits outside the two tours specs are the no_show_checkin reminder kind
  (scenarios/scheduled-visibility.spec.ts:126-143, tour-no-show-checkin.spec.ts) or a
  no-show rescheduled into the future (scenarios/tours.spec.ts:277-330) - never on
  Past or Today. tour-reminders/tick hits (scheduled-visibility.spec.ts:14,
  scenarios/tours.spec.ts:25, tour-roster.spec.ts:522) are unaffected.
- Leftover state: tours-past.spec.ts never cleans up (its no-show, :92-94, stays); it
  will now also show on Today until the next reseed, which the next file does
  (unknown-caller-triage.spec.ts:34-35, beforeEach). No Today assertion in between.
- Run order (workers 1, path order): today-past-tours < tour-auto-close <
  tour-comms-pane < tours-page < tours-past. tour-comms-pane does not reseed but mints
  its own entities (:31-33); tours-page reseeds (:53-56).
- Name collisions: "Reopen tour" contains "open"; every existing locator uses a
  longer name ('Open relay group', 'Open the relay group?', 'Open navigation',
  /Open their page/i) - no hit. Scenario steps on closed tours assert only the badge
  or the Outcome card (steps.ts:2546-2553, :2566-2580, :2586-2602) - they survive the
  new Reopen CTA.

Auto-close vs the lane's REAL worker (spec 11.3 claim verified):

- No client can set createdAt: the POST allowlist is tenantId/unitId/scheduledAt/
  tourType (routes/tours.ts:142; 400 on anything else, :300-302), the route passes only
  those (:335-342), the repo stamps createdAt = now (toursRepo.ts:295);
  routes/tours.ts:335 is the ONLY create call site; no dev seam writes tours.
- listing-activity.spec.ts:118 (2026-09-15) and landlord-activity.spec.ts:97
  (2026-09-20) are canceled at once (:122 / :101) - never candidates.
  listing-activity.spec.ts:237 (2026-10-01T15:00Z) stays scheduled and is never
  cleaned up: due 14 days after its creation. These are FIXED dates - from 2026-10-15
  that scheduledAt is itself more than 14 days old, so the createdAt floor is what
  keeps it open; a clock that lost the floor would surface as a worker close at the
  suite's 15- and 30-minute marks.
- First sweep timing: startPoll is setInterval-only (app/src/jobs/pollLoop.ts:53-73),
  so the worker's first auto-close run is 15 minutes after it starts, and the
  launcher's clean-slate reseed runs right after the worker starts
  (scripts/e2e-session.mjs:749-763) - stale lane rows never meet a sweep.
- Full-profile reseeds (composer-mobile.spec.ts:41, group-text-stop.spec.ts:34,
  outbound-mms.spec.ts:1061, relay-group-view.spec.ts:38,
  relay-number-lifecycle.spec.ts:65, voice-transcription.spec.ts:255): the earliest
  full-world tour is due 9d 30m after the reseed, so nothing closes mid-run and no
  close-nag is armed. The perf world (app/src/lib/seed/performance.ts:645-666) has
  nothing due at seed time either.
- Quiet-worker reliance: none. /__dev/logtail holds APP-process WARN+ERROR only
  (e2e/README.md:582-587); worker lines never reach it and the tick logs at info.
  ERROR reads are windowed and filtered (group-text-reply-all.spec.ts:84 clear + :140
  message filter; group-text-conversion.spec.ts:144 since + conversationId). No spec
  reads the worker's poll list. mutationCatalog.ts catalogs no /__dev route, so the
  new tick needs no catalog row.

## 3. Docs-format notes the plan lacks

a. RUNBOOK worker docs (optional; Claude owns RUNBOOK): RUNBOOK.md:1117-1121 says "One
   interval drives five due-row polls" (worker.ts already starts six, :349-520). The
   auto-close poll does NOT use WORKER_POLL_INTERVAL_MS (own 15-minute constant). One
   sentence there and a bullet under `#### Worker clock polls (durable-row ladders)`
   (:1173-1208: the poll, the seam `POST /__dev/tour-auto-close/tick { now?, tourIds? }`,
   the failure line `<pollName> poll error` from jobs/pollLoop.ts:69) keep the operator
   section true.
b. documentation/tours-sequence-writeup.md (:149-169, no-show and exit gate) does not
   mention auto-close or reopen - optional one line. e2e/scenarios/steps.ts:2584-2585
   calls the not-a-fit tour "(terminal)" - optional comment touch.
c. Spec 12's seed note is incomplete (matters only if the RUNBOOK entry or the
   handback repeats it). Besides the matrix no-shows (+9d 30m and +11d 30m after a full
   reseed), the matrix's two scheduled tours (+17d, +19d; matrix.ts:907-910, :953-956,
   :995) and live.ts's three scheduled tours (about +14d / +15d / +16d;
   live.ts:357-395; two own the live relay group, so their close also arms its
   close-nag) auto-close if a worker runs and nobody marks them. lean has no `tours`
   table (lean.ts:87-534); cast's two tours are non-candidates (cast.ts:546-560
   requested; :797-818 toured + move_forward + convertible). No seed change is
   planned - this is wording accuracy only.
d. ASCII: GLOSSARY, RUNBOOK, e2e/README.md and _TEMPLATE.md carry non-ASCII; only the
   added lines must be ASCII - do not copy the template's em dashes.
e. Gates over these files: ESLint covers e2e/**/*.ts (eslint.config.mjs:15) and the e2e
   workspace typecheck includes tests/**/*.ts (e2e/tsconfig.json:8), so both specs are
   gate-1 and gate-5 subjects; today-past-tours.spec.ts lints clean today. The catalog
   unit run is `npm run test -w @housingchoice/e2e -- performance/mutationCatalog.test.ts`
   (README:67 shape; the pin is mutationCatalog.test.ts:375 = 110).
f. S11 live self-QA: on 2026-09-30 the Playwright MCP browser was missing on this PC
   (project memory today-past-tours); `.mcp.json` runs `@playwright/mcp@latest --browser
   chromium` and ms-playwright now holds chromium-1228 and chromium-1247. If the MCP
   cannot launch, the previous fallback was a throwaway spec run through the single-hop
   grep form (item 7).

## 4. Verified as planned (no change needed)

- Task 9.1 numbers: first visit 3 rows in date order; the Today link rule
  `more = total > rows.length` (Today.tsx:241, :256) with total = the Past count
  (useTodayPastTours.ts:148, :160) -> "Open the Past tab" at 3 of 3, "See all 7 on the
  Past tab" at 5 of 7; pastState(no_show) = 'No show' (useTours.ts:271); a no-show
  href has no ?outcome=1 (Today.tsx:197, :202).
- The live drop waits through Playwright's auto-retrying toHaveCount (expect timeout
  15 s, playwright.config.ts:135) on the tour.updated reload (300 ms debounce,
  useTodayPastTours.ts:59, :172-180); the no-show only shifts the counts. The overflow
  checks (:127-129 at 360px; :134-150 at 880px) gain a third card with the same
  address as notMarked and a shorter chip - no new clipping risk.
- Tour header badge: StatusBadge maps scheduled -> 'Scheduled'
  (dashboard/src/ui/StatusBadge.tsx:92, api/types.ts:890-897).
- e2e workspace name @housingchoice/e2e (e2e/package.json:2); its vitest scope is
  performance/** and support/** (e2e/vitest.config.ts:8).
- The three edited issues carry id/title/type/severity/status/area/created/refs and
  no resolved/updated; docs/issues/INDEX.md is gitignored (.gitignore:62).
- Spec 12: lean seeds no tours; the matrix no-shows are due about 9 and 11 days after a
  full reseed; the cast's convertible tour is excluded.
