Checked (D7, read-only): plan S7.1-S7.17 (plan lines 21172-24717) against spec r8, plan sections 0-4 (PR39, PR73-PR79, PR89, PR95, PR97, PR102, PR103) and the live tree at main @970a29b9: every anchor in follow-up-tab, today.ts, selectors.md, unknown-caller-triage, unknown-inactive, conversation-fact-extraction, caseworkers, participant-names, today-past-tours, scenarios/steps.ts, tours-page, performance/routes.ts + routes.test.ts, app/src/lib/events.ts, GLOSSARY, STATUS-MODEL, the 2026-06-16 spec and both issue files (all present; steps.ts and tours-page line hints are off by 1 and 5, quoted text matches); a re-grep of every e2e reader of the old Today page (the S7.1 table is complete); the lean seed (no tours, listing sends, unknown contacts or relay nags; placement-0001 is always a derived stuck row); the dev seams (listing-send-fixture 201 {row}, any unit status; message-fixture 200, inbound moves last_heard_from_at via touchFixtureHeardFrom); POST /api/tours without scheduledAt (201, requested); the booking flow; run-spec.sh vs e2e/package.json; stageClient --env local --lane, lane.json fields and the PR78 guard; scripts/issues.mjs schema; mutationCatalog (no new dashboard mutation); e2e tsconfig and eslint (no new type or lint error found).

## D7-1 - BLOCKER - the session "ready" wait matches "already running"

- Plan: S7.15 step 2 (plan 24336-24337), reused by S7.16 step 1 (plan 24479-24481).
- Plan says: start `npm run e2e:session` in the background, wait with a Monitor until-loop for `grep -q "ready" .../session.log`, then read lane.json and run the step 3 hermetic checks (the ping must answer `"dev":true`); any failed check means stop, `npm run e2e:stop`, report to the planner.
- Tree: step 2 runs `npm run db:start` first, so the launcher's own first action `await ensureDbStarted()` (scripts/e2e-session.mjs:780) prints `db:start - <container> already running` (scripts/db.mjs:198; the file has an em dash). "already" contains "ready", so the grep is true about a second after launch. `fake-twilio ready (:<port>)` (scripts/e2e-session.mjs:813) is also printed before the app, worker and dashboard start; the stack is up only at :832 (`[e2e-session] ready` + em dash + ` app :<port>`). Step 3's `curl <DASH>/__dev/ping` then gets no answer and the HARD RULES stop the rehearsal, deterministically.
- Correction: wait for the launcher's own anchored ready line: `grep -q '^\[e2e-session\] ready ' W:/tmp/today-checklist/.superpowers/s7/session.log` (log prefix at scripts/e2e-session.mjs:345-347), or the ASCII line that follows it, `grep -q 'filtered runs reuse this session automatically' W:/tmp/today-checklist/.superpowers/s7/session.log` (:837). Use the same wait in S7.16 step 1.

## D7-2 - MAJOR - Tours to book "appear live" can pass from the initial load; RED B can stay green

- Plan: S7.2 step 4, `openWatchingToday` (plan 22054-22068) as used by test 4 (plan 22321-22348); S7.2 step 8 RED B (plan 22433-22443).
- Plan says: test 4 opens a watching Today tab, asserts `await expect(list).toHaveCount(0)` on Tours to book, creates two requested tours, and expects both links on the open page via the PR16 create emit; RED B comments that emit out and expects the `toHaveCount(2)` to fail.
- Tree: openWatchingToday waits only for the h1 (`expectTodayReady`, e2e/support/today.ts:43-46) and the /api/events response, never for the page's first GET /api/today, which useToday issues on mount (dashboard/src/routes/today/useToday.ts:119-125) and which S4 computes with the requested-tours read placed late in the handler, after the tours_today block (plan 13358-13379). The two POST /api/tours calls run while that GET is in flight, so its tours read can already see one or both tours: `toHaveCount(0)` passes during loading, `toHaveCount(2)` can be satisfied by the initial load (no live event proven), and RED B can run green. The unknown-inactive idiom this copies waits for visible rows before acting (e2e/tests/dashboard-next/unknown-inactive.spec.ts:228-233); test 3 does too (`toHaveCount(2)` on the people list); test 4 does not.
- Correction: in openWatchingToday register `const loaded = today.waitForResponse((r) => new URL(r.url()).pathname === '/api/today' && r.status() === 200);` before `today.goto`, and `await loaded;` after `await streamOpen;`. In test 4, before the two `requestTour` calls, prove the first load rendered with a positive control, `await expect(todayList(today, UI.placements)).toBeVisible();` (lean placement-0001 is always a derived stuck row: app/src/lib/seed/lean.ts:464-465 with app/src/lib/statusModel.ts:386), and only then `await expect(list).toHaveCount(0);`. RED B then fails deterministically at `toHaveCount(2)`.

## D7-3 - MINOR - the self-QA world opens the wrong property

- Plan: S7.16 step 3 world (plan 24524-24534, the line at 24525) and step 4 (plan 24566-24570).
- Plan says: quiet shares on u1 (Noreply sent 6 days ago; Replied sent 5, heard 3) and u2 (Later sent 7 days ago), "the first opens, the second starts folded"; step 4 expects the first property line open with 2 people and the second folded ("1 person: 1 never replied").
- Spec/tree: spec 6.3 (spec lines 385-386) orders properties by their longest-quiet person, oldest quietSince first; S5 renders the server order unchanged (plan 16761). Later (7 days) is older than Noreply (6 days), so u2 is first and open and u1 is folded - the opposite of step 4, which would be recorded as a false S5 defect.
- Correction: plant Later at 5 days (`[u2, 'Later', 5, null]`; 120 h plus the 60 s pad still qualifies) so u1 leads ("2 people: 1 replied, then quiet - 1 never replied", open) and u2 reads "1 person: 1 never replied" (folded; "No reply in 5 days" when opened). Or keep 7 days and swap the step 4 expectation.

## D7-4 - MINOR - "Tours today" is an h3 now; selectors.md:18 and support/today.ts:11 are left saying h2

- Plan: S7.1 step 2 table (plan 21450-21451); S7.2 step 5 (plan 22381-22396).
- Plan says: selectors.md:18 "stays true (Tours today is still an `<h2>`)"; e2e/support/today.ts:11 "stays (true)"; step 5 replaces only selectors.md:65.
- Tree: S5 renders Tours today as `<TodaySection label={TOURS_TODAY_LABEL} level={3}>` inside the "At a glance" h2 (PR65, plan 625-627; plan 18381), and S5 hands S7 this exact edit ("e2e/support/selectors.md rows to update: line 18 ... now an `<h3>`", plan 14521-14523). selectors.md:18 says "`Tours today` group `<h2>`"; e2e/support/today.ts:11 says "(an <h2>)".
- Correction: S7.2 step 5 also rewrites selectors.md:18 to say the `Tours today` heading is an `<h3>` under the `At a glance` `<h2>` (the substring trap and `expectTodayReady` are unchanged), and S7.2 step 3 edits the e2e/support/today.ts:11 comment to "(an <h3> under At a glance since tracker #31)". Record the comment-only `<h2>Tours today</h2>` mentions (tours-page.spec.ts:46,183,259, tour-roster.spec.ts:73) in the S7.1 table as stale-but-harmless, or fix them in the same commits.

## D7-5 - MINOR - an open issue S7 fixes is left open; the imported-unknown title stays false

- Plan: S7.1 step 2 "Expected docs hits" (plan 21464-21470); S7.14 (plan 24023-24244).
- Plan says: the docs hits are GLOSSARY, STATUS-MODEL, public-signup-abuse-hardening, relay-groups-ignore-member-deletion (stays) and three resolved issues; S7.14 edits only the imported-unknown and public-signup issues.
- Tree: the S7.1 docs grep also hits the OPEN docs/issues/fact-extraction-spec-vacuous-today-absence-checks.md (status open; refs conversation-fact-extraction.spec.ts:350, :395), whose whole problem is the vacuous "AI suggestions to review" absence checks that S7.5 replaces with expectNoAiSuggestionFor (server truth first, then a page whose /api/today response has landed). After S7.5 it describes a list that no longer exists and a defect that is fixed. Separately, imported-unknown-threads-surface-as-unknown-on-today.md keeps the title "... shows on Today as a new unknown contact, whatever the contact's type" although S7.14's own update says Today no longer shows those rows.
- Correction: S7.14 also resolves fact-extraction-spec-vacuous-today-absence-checks.md (status: resolved, `updated: 2026-10-24`, a closing paragraph naming expectNoAiSuggestionFor in e2e/support/today.ts and its S7.5/S7.6 call sites) and adds that path to the S7.14 commit's explicit `git add`; and retitles the imported-unknown issue to its remaining problem (the threads stay unknown_1to1; only the 404 fallback Today still lists them, under Identify these contacts).

## D7-6 - MINOR - `npm run issues` prints no per-issue summary

- Plan: S7.14 step 7 (plan 24210-24219).
- Plan says: "the summary lists `today-quiet-shares-read-cost` (open, low)".
- Tree: scripts/issues.mjs:90-95 prints only `[issues] N open, M closed, T total -> docs/issues/INDEX.md`, the open-by-severity line and warnings; the per-issue rows go only to the gitignored docs/issues/INDEX.md.
- Correction: expect the open total one higher than before S7.14, no `warning(s)` line naming today-quiet-shares-read-cost.md, and `grep -n "today-quiet-shares-read-cost" docs/issues/INDEX.md` printing one `| low | improvement | open |` row.

## D7-7 - MINOR - RED B's grep also selects test 1

- Plan: S7.2 step 8 (plan 22439-22443).
- Plan says: `--grep "Tours to book"`; expected `1 failed`.
- Tree: test 1's title "reads top to bottom: Identify, Tours to book, Quiet shares, ..." (plan 22111) also matches; test 1 reloads the page and passes with the emit removed, so the log shows 1 failed and 1 passed.
- Correction: `--grep "requested tours appear live"` (test 4 only); expected `1 failed`, no passed line.

## D7-8 - MINOR - the S7.15 commit makes S7.16's session reuse impossible

- Plan: S7.15 step 8 (plan 24456-24468) with S7.16 step 1 (plan 24479-24481).
- Plan says: leave the session running for S7.16 and commit the S7 report now; S7.16 reuses it after re-running the S7.15 step 3 checks, which require the ping's `appCommit` to equal `git rev-parse --short HEAD`.
- Tree: the launcher stamps its boot commit once (scripts/e2e-session.mjs:135, :282 E2E_APP_COMMIT); the S7.15 commit moves HEAD, so the S7.16 re-check always fails.
- Correction: either stop the lane at the end of S7.15 and boot a fresh one in S7.16, or hold the S7.15 report commit until S7.16 ends and commit both report sections after `npm run e2e:stop`. Say which.

## D7-9 - MINOR - the cross-slice note still carries the removed top-level `people`

- Plan: Cross-slice notes, the S4 bullet (plan 21322-21323).
- Plan says: S4 answers `quietShares: { status: 'ok', properties: [...], people }`.
- Rulings/tree: PR103 (plan 776-780) removed `people`; the S7.2 spec itself asserts `not.toHaveProperty('people')`. S7.1 step 3 tells the builder to record every as-built difference from these notes, so this line produces a false deviation.
- Correction: the note reads `quietShares: { status: 'ok', properties: [{ unitId, unitLabel, people: [{ contactId, state }] }], truncated }`.

## D7-10 - MINOR - Needs you now readers and a page-wide absence check under the 5-row limit

- Plan: Cross-slice notes (plan 21346-21348); S7.9 (plan 23325-23409).
- Plan says: steps.ts :3087 and :3153 (Needs you now) stay valid unchanged; only :3190 gets `showAllIn` "because the 5-row limit can hide a row on a shared lane where these specs do not reseed".
- Tree: the same reasoning applies to Needs you now. post-tour-application.spec.ts does no reseed (:24), every section now renders 5 rows, and needs_you_now sorts by deadline instant ascending (app/src/routes/today.ts:451-460, :1066-1070), so a newer clock sits after older due clocks a lane may hold. expectPlacementGoneFromBoard (e2e/scenarios/steps.ts:3103-3116) is a page-wide `a[href="/placements/<id>"]` `toHaveCount(0)` that passes vacuously for a row hidden past the fifth. Low likelihood on today's suite.
- Correction: in expectRtaDeadlineOnBoard and expectVoucherDeadlineOnBoard add `await showAllIn(this.page, 'Needs you now');` before the list locator and make it `{ name: 'Needs you now', exact: true }`; in expectPlacementGoneFromBoard first poll server truth (GET /api/today has no item with refType 'placement' and refId id) or expand Needs you now and Placements before the page-wide count. Extend the S7.9 edit list and commit.

## D7-11 - MINOR - the background citation for Today goes stale

- Plan: S7.11 step 4 (plan 23634-23653).
- Plan says: re-cite the '/' terminal citation and, where S5 moved them, the '/' endpoint base.
- Tree: CONTRACT_SOURCE_LEDGER.background.today (e2e/performance/routes.ts:872) cites `dashboard/src/routes/today/useToday.ts:39,126-153` (REFETCH_DEBOUNCE_MS and the useEventStream block), which S5's useToday edits shift (new TodayState fields, QUIET_SHARES_UNAVAILABLE, the loadToday returns; plan 16053-16140). collect.ts:69 consumes it and collect.test.ts:371 pins the exact string, so nothing fails and the stale citation ships silently.
- Correction: S7.11 step 4 also re-cites background.today to the as-built debounce-constant line and useEventStream block, updates the collect.test.ts:371 pin to the same string, and adds e2e/performance/collect.test.ts to the S7.11 files and `git add`.
