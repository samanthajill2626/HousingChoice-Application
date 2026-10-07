# Build research - e2e, perf registry and docs: live-tree drift worklist (tour list)

- Reader: e2e / perf / docs build-research reader (read-only), 2026-10-06.
- Tree: `W:\tmp\tour-list` @ b3ac0306 (feat/tour-list). Every code and doc file
  cited here is identical to base main @d839494a (the branch so far adds only
  docs). main is now a5eabcb3 (+2 commits: dashboard Timeline / twoPaneShell CSS,
  a new `e2e/tests/dashboard-next/stream-hidden-label-overflow.spec.ts`, one
  issue) - no overlap with the S8-e2e / S13 / S14 files.
- Plan: `docs/superpowers/plans/2026-10-06-tour-list.md` v3 - sections 0-2, S8's
  e2e part (1608-1629), S10's perf edit (2093-2099), S13 (3038-3172), S14
  (3176-3243), S15 (3246-3314), section 16.
- Byte-exact quotes backing every citation:
  `.superpowers/sdd/build-research/e2e-docs-reference.md` (gitignored).
- Method: every file:line the plan cites in these slices was opened in the live
  tree; helpers and endpoints were checked against `app/src/routes/tours.ts`,
  `app/src/routes/dev.ts`, `app/src/lib/seed/lean.ts` and the dashboard sources;
  the gate-5 baseline was measured with a read-only `npx eslint -f json` (no
  --fix). Nothing was edited; no vitest, playwright, npm test or e2e was run.

Totals: 28 items - 20 corrections (C1-C10, C12, C13, C15, C16, C19, C20, C22,
C24, C25, C26) and 8 guards / info (C11, C14, C17, C18, C21, C23, C27, C28).
Can break a test or a gate if the plan is followed as written: C6 (gate 5),
C7 and C9 (strict-mode failures), C12 (preflight STALE-server error), C22 (ASCII
rule on the new issue files). False green: C2, C8.

---

## 8.1 - S8's e2e text edits (plan 1608-1629)

Anchors verified (all at the cited lines today): `tours-page.spec.ts:238-239`
(the split "Not" / "booked" comment), `:242` (`detailHeader.getByText('Not booked')`);
`steps.ts:1147` (doc comment), `:1168-1169` (split comment; U+00B7 on 1168),
`:1176` (`toursCard.getByText('Not booked')`), `:1854` (comment), `:1856`
(`tourHeader().getByText('Not booked')`); `tours.spec.ts:417` (comment). Spec
P7's "steps.ts:1854-1856" includes `:1855` (`tourStatusBadge('Requested')`,
unchanged).

C1. `e2e/scenarios/steps.ts:1853`. Plan: edits :1854 and :1856 only. Tree:
:1853 reads "Requested + not booked - the rebuilt page shows the tour
StatusBadge in" (lower case). Fix: rewrite :1853 as well ("Requested + Needs
booking - ..."), the same edit the plan makes at `tours.spec.ts:417`.

C2. [false green] The final check (plan 1625)
`git grep -n "Not booked" -- dashboard/src e2e app/src` is case-sensitive: it
misses `steps.ts:1853` and `tours-page.spec.ts:479` ("(requested, not
booked)"), and it skips `documentation/` (S14 fixes
`sequence-diagram-to-test.md:262-263` later). Fix: decide :479 (recommend
"(requested, needs booking)"; the plan research left it optional), then use
`git grep -n -i "not booked" -- dashboard/src e2e app/src` (expect empty), and
after S14 the same over `documentation`.

C3. Split comments: rewriting `steps.ts:1168-1169` and
`tours-page.spec.ts:238-239`, keep "Needs booking" on ONE line (a new "Needs" /
"booking" split defeats the phrase grep exactly as today). `steps.ts:1168` must
lose its U+00B7 and should describe the row as rendered: `TenantFile.tsx:334-338`
builds the label `<unit label> - <date or 'Not booked'>` with the status label
on the right, so "<unit> - Needs booking", 'Requested' on the right. Neighbours
that carry non-ASCII and must NOT be reflowed: `steps.ts:1143` and `:1148` (the
:1147 docblock; U+2014 / U+2192), `tours-page.spec.ts:237` (box-drawing).

Strict mode after the switch (verified, no change needed): the tenant file's
Tours card and the tour header each hold exactly one "Needs booking" for a
request - the row label / the facts line; the header's other texts are
"Tour - <address>", the badge "Requested" and the CTA "Schedule tour"
(`TourDetail.tsx:620-625, 686-691`) - so the substring `getByText` at
`tours-page.spec.ts:242`, `steps.ts:1176` and `:1856` keeps today's cardinality.

Load-bearing note: `steps.ts:1856` runs inside `teamCreatesTourFromInterest`,
called 20 times in 10 spec files (`tests/scenarios/tours.spec.ts` x9,
`sending-unit` x2, `approval-and-move-in`, `participant-names`,
`post-tour-application`, `quiet-hours`, `scheduled-visibility`,
`dashboard-next/relay-number-lifecycle`, `tests/tour-no-show-checkin`), and
`steps.ts:1176` inside `expectHandoffToTours` (`sending-unit.spec.ts:101, 124`).
Nothing runs them before S15 - see R1.

---

## 13.1 - new `e2e/tests/dashboard-next/tours-all.spec.ts` (plan 3040-3144)

Anchors verified:

- `tours-past.spec.ts`: NEXT :32, TENANT_ID / UNIT_A / UNIT_B :33-35, `pastAt`
  :44-50 (local hour via setDate / setHours), `devLogin` :58-62, `createTour`
  :64-70 (POST /api/tours with tenantId, unitId, scheduledAt, tourType
  'self_guided'; returns `.tour.tourId`), `patchStatus` :72-75 (`{ status }`),
  beforeAll reseed :77-80 (bare `request`, POST `${NEXT}/__dev/reseed`),
  `test.slow()` :84, "wait before a negative count" :96-105, tabs scoped to the
  'Tours view' nav :108-112, `rowFor` :115-117, undated create without
  scheduledAt :253-256, wire check :259-262.
- `today-past-tours.spec.ts`: `created` :50-52, `createTour` pushes :54-62,
  `patchTour(page, id, data)` :64-67, `decide` :70-76 (GET; PATCH
  `{ status: 'toured' }` unless toured; then `{ outcome: 'not_a_fit',
  moveForward: false }` unless an outcome exists), beforeAll :78-81,
  `decideQuietly` :84-90, describe + afterEach `created.splice(0)` :92-95,
  `test.slow()` :100.
- `tours-page.spec.ts:411-420` (dated canceled: POST scheduled, PATCH
  `{ status: 'canceled' }`); `tour-comms-pane.spec.ts:202-207`;
  `environment-identity.spec.ts:61` (`toBeFocused()`); `steps.ts:3768-3770`
  (`tourHeader()` = header filtered by text 'Tour -');
  `playwright.config.ts:140-141` (`fullyParallel: false`, `workers: 1`).
- devLogin: the UI button `/Continue as dev user/i` is "Continue as dev user
  (seeded VA)" (`Login.tsx:81-90`) -> POST /auth/dev-login as va@example.com
  (`Login.tsx:24`), role va (`dev.ts:181-184, 296`); then `expectTodayReady`
  (`support/today.ts`). The cookie lives in the browser context, so
  `page.request` carries it; the bare `request` fixture does not (401 - house
  note `tours-page.spec.ts:308-309`). VA can use every tours route (no admin
  gate, `tours.ts:1-3`).
- Reseed: POST /__dev/reseed defaults to lean (`dev.ts:325-333`) and logs the
  browser out (`e2e/README.md:579`); it runs before any devLogin. After a
  failure Playwright starts a fresh worker that re-runs beforeAll
  (`tours-past.spec.ts:243-244`), so each test's own devLogin is required - the
  plan has it.
- Lean seed: `contact-tenant-0001` = Tasha / Nguyen (`lean.ts:40, 115-116`);
  `unit-0001` address "1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314"
  (`lean.ts:43, 223`); `unit-0002` "88 Sycamore St, Decatur, GA 30030"
  (`lean.ts:44, 246`). The lean SEED has no tours collection (top-level keys
  `lean.ts:87-534`; `seed/index.ts:112-125` adds cast / matrix only for 'full').
- PATCH /api/tours/:tourId (`tours.ts:986-1473`): allowlist scheduledAt / status
  / outcome / moveForward (`:146`, `:996-999`). `{ status: 'no_show' }` on a
  scheduled tour is allowed (only requested -> no_show is refused,
  `:1067-1088`); `{ status: 'canceled' }` is allowed from anything but closed
  (`:1054-1058`); `{ status: 'toured' }` on a requested tour is allowed and
  silent (`:1067-1083`); `{ outcome, moveForward }` only on a TOURED tour, else
  409 illegal_exit_gate (`:1124-1127`), and it sets outcome / moveForward /
  convertible without changing status (`:1150-1155`) - the plan's "stays toured,
  not closed" holds. POST (`tours.ts:265-361`): tenantId, unitId, tourType
  required, scheduledAt optional, no duplicate guard, 201 `{ tour }`.
- Selectors against the DOM: nav 'Tours view' of `Link` tabs, `aria-current`
  "page" on the current one (`ToursPage.tsx:708-719`); the back arrow's
  aria-label is "Back to tours" unless the target is '/' (`TourDetail.tsx:126-129,
  683`); the ChipGroup to be copied is role="group" aria-labelledby its visible
  label, aria-pressed buttons named by their label, Clear named
  `Clear <label lower-cased> filter` (`ListingsList.tsx:133-185`) - so group
  "Status", Clear "Clear status filter"; #1's search is an input type="search"
  with a label (`ListingsList.tsx:377-396`) - role searchbox, name "Search"; the
  app shell has no other searchbox.
- `test.slow()` precedents: `tours-past.spec.ts:84`, `today-past-tours.spec.ts:100`,
  `tour-comms-pane.spec.ts:193`.

C4. The house-pattern citation `tours-past.spec.ts:58-116` omits what the new
spec copies first - NEXT / TENANT_ID / UNIT_A / UNIT_B (:32-35) and `pastAt`
(:44-50). Fix: cite `tours-past.spec.ts:32-117`.

C5. No future-date helper exists in the tours specs:
`tour-comms-pane.spec.ts:202-207` is "now + 48 h" (not 10:00 local),
`tours-page.spec.ts:394` is "now + 24 h", and `tours-page.spec.ts:35-41`
(`localDatetimeAt`) builds a datetime-local INPUT string, not an ISO instant.
Fix: name the helper - `futureAt(daysAhead, hour)` mirroring `pastAt`
(setDate +n, setHours(hour, 0, 0, 0), toISOString) for upcomingId (+3 d) and
canceledId (+1 d). The precedent's point still holds: a tour 3 days out at
10:00 arms day_before at 19:30 org-local two days later, morning_of at -4 h,
en_route at -1 h (`tourReminders.ts:125-164`), `confirmation` is discontinued
(`tourReminders.ts:307-314`), so nothing sends during the run; the canceled
tour's rungs are swept by its terminal PATCH (`tours.ts:1186-1210, 1360-1371`).

C6. [gate 5] Every declared constant and helper must be used.
`eslint.config.mjs` lints e2e `.ts` with `@typescript-eslint/no-unused-vars` as
an ERROR (only `_`-prefixed names exempt); `tours-page.spec.ts:27`
(UNIT_A_ADDRESS) is exactly this error, pre-existing. The plan declares UNIT_A,
UNIT_B, `pastAt`, `createTour`, `patchTour`, `closeOut`, `closeOutQuietly`; if
every create uses UNIT_A, UNIT_B is a NEW error in a touched file and gate 5
blocks. Fix: use both units (e.g. the request and the undated toured on
UNIT_B) or drop UNIT_B.

C7. [strict mode] Scope EVERY status word, not only "Needs booking". The chips
are Needs booking / Scheduled / Toured / No show / Canceled / Closed; the rows'
badges come from `tourStatusLabel` (`types.ts:890-912`), so "Scheduled", "No
show", "Canceled", "Closed" exist twice on the page, and the When options share
words with the tabs ("Past"). "The canceled row present with its Canceled
badge" must be read inside that row (precedent `tours-page.spec.ts:445-447`).
Also: an undated toured row's badge is "Toured - needs outcome"
(`types.ts:907-908`), not "Toured"; a closed-out (decided) row reads "Toured".

C8. [false green] Absence must follow presence. "The request, the no-show and
the undated toured rows absent" passes vacuously while the list is still
loading (S12 shows a Spinner and no list). Precedent `tours-past.spec.ts:96-98`.
Fix: in each step first assert this step's present row(s) visible (every list
in this file is complete on page 1 - at most 12 tours), or wait for the
complete count line by text (`N match` / `N matches`, not "so far"; the count
line is role="status" without a name, plan 2593-2594).

C9. [strict mode] Exact names where substrings collide: Clear filters vs the
chip group's "Clear status filter" (both contain "Clear"); searchbox
`{ name: 'Search', exact: true }` (precedent
`properties-available-view.spec.ts:174`); heading "All tours" exact; group
"Status" exact (as planned); tabs only inside the 'Tours view' nav.

C10. URL checks per parameter, never a literal query string (the serializer
fixes the order, S9 / S12, not S13). Precedent
`properties-available-view.spec.ts:180-181` (`[?&]name=value(&|$)` regexes).

C11. (info) Prefer `${NEXT}/api/tours/list?limit=2` over the relative form.
Both work (`page.request` resolves relative URLs against `use.baseURL` = the
lane dashboard, `playwright.config.ts:153`); every tours spec uses `${NEXT}`.

C12. [breaks the run] Session plus commit. `e2e/support/preflight.ts:96-128`
throws "a STALE server is being reused" when the reused session's app
(`/__dev/ping` appCommit) or Vite meta was booted at a commit other than
`git rev-parse --short HEAD`; the launcher stamps E2E_APP_COMMIT once at start
(`scripts/e2e-session.mjs:104, 243`) and `e2e:restart` does not re-stamp. A TDD
"commit, then run against the live session" fails preflight. Fix: start
`npm run e2e:session` only after the last commit the run should test, run the
spec uncommitted, commit after green; after any commit run `npm run e2e:stop`,
confirm the lane ports are free, start a new session. Alternative without a
session: `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/tours-all.spec.ts`
cold-boots its own stack and tears it down (`playwright.config.ts:183-207`).

C13. The root-npm note (plan 3138-3140) is half right: the double npm hop (root
`e2e` = `npm run e2e -w @housingchoice/e2e`) eats `--flags` (`--grep`,
`--headed`), but a POSITIONAL spec path survives - `e2e/README.md:68` documents
`npm run e2e -- tests/dashboard-next/maintenance-page.spec.ts`
(`e2e/README.md:55`'s own `--grep` example is the broken form). The plan's
single-hop command is right; fix the wording only.

---

## 13.2 - perf registry (plan 3146-3172) and S10's exclusion (plan 2093-2099)

Anchors verified: `routes.test.ts:287` ("has exactly 31 ..."), `:348-391` (the
App-route pin), `:376-385` (`excluded`), `:381` (the comment naming
perf-pages-tours-past-surface), `:422-455` (citation test); `routes.ts:126`
(CONTRACT_SOURCES.registry), `:282-290`, `:614-615`, `:616-627` (KNOWN GAP),
`:716`, `:724-725`, `:753-755`, `:778-779`, `:797`, `:803`, `:886-891`;
`e2e/README.md:83-86`.

What fails without the exclusion: in "mechanically matches App route elements
and proves generated placeholders are empty" (`routes.test.ts:348`) the regex
at `:362` collects every Route path attribute from App.tsx (the attribute must
precede the first `>` of the tag - the plan's `tours/all` route puts it first),
prefixes '/', and `:386-387` asserts that set minus `excluded` equals the
non-inbox EXPECTED_KEYS plus '/inbox'. An unexcluded '/tours/all' is an extra
member, so that toEqual fails under root `npm test` (the e2e workspace's
`vitest run` includes `performance/**/*.test.ts`, `e2e/vitest.config.ts:8`).

C14. (guard) Do NOT add '/tours/all' to `routes.ts` APP_ROUTE_EXCLUSIONS
(`:116-123`): `routes.test.ts:291-298` pins that list exactly (it holds neither
'/tours/past' nor '/quick-reply/:callId'). The exclusion goes only in the
test's local `excluded` set.

C15. GET-contract wording (KNOWN GAP comment, README paragraph, widened issue):
"GET /api/tours/list?limit=50" under-states it in the registry's path +
query-KEY model (`routes.ts` endpoint(): template + sorted keys). The client
always sends `when` and `sort` (TourListParams requires both; `client.ts:51-60`
drops only undefined), so the default first page is
`/api/tours/list?when=any&sort=latest&limit=50` - keys {limit, sort, when};
follow / Load more / Keep checking add `cursor` at limit 50 (plan 2447, 2488);
a search walk or a restore uses limit 100; filters add status / type / from /
to. Fix: "GET /api/tours/list?when&sort&limit for the first page, the same plus
cursor after it".

C16. The ledger refresh list misses citations into files S8 edits. Each S8 file
gains one line in its multi-line api-barrel import (`Today.tsx:17-23`,
`TenantFile.tsx:9-22`, `ListingDetail.tsx:16-32`), shifting every later line by
+1, and the ledger cites them: `routes.ts:770` (Today.tsx 35-47, 225-260,
277-290), `:795` (TenantFile.tsx 152), `:742` (ListingDetail.tsx 184-185),
`:796` (ListingDetail.tsx 1180-1187). Gate-neutral (the test checks format
only), but step 3 exists for accuracy. Fix: add them to step 3. Optional
pre-existing drift: `:131` and `:724-725` cite useTours.ts 47-133 (useTours is
56-107, useClosedTours 121-153), `:806` cites 46-81, the `:1120` comment cites
46-51 (toursDateRange is 48-54). Leave the endpoints.ts citations (`:741`,
`:812`, `:813` - already stale on main; S9 inserts listTours after line 2716,
so it moves none of them).

C17. (info) Today's values for the re-points (S10 / S12 move them):
`ToursPage.tsx` hooks :621-635, crossRef / loading / error :637-658, render
:696-822 (Spinner :721, alert :723-727, Active :729-781, Past mount :783-787,
Closed :789-810, dialog :812-820); `useTours.ts` usePastTours :293-340
(docblock :290-292) for `:716`; `TourDetail.tsx` back Link :683 for `:797`;
`App.tsx` tours routes :237-245 inside the authed Routes :138-268 for `:803` /
`:126`. Format (`routes.test.ts:423`): `<path>.ts|tsx:N[-M][,N[-M]...]`, files
joined by "; ", no space after a comma, no parentheses, ts / tsx targets only;
warm classification reasons must keep ending "passive navigation work."
(`:441`).

C18. (guard) `e2e/performance/config.test.ts:365-368` parses EVERY
`e2e/README.md` line that begins "npm run perf:pages -- " with
parseProfilerArgs. Keep the Known-gap rewrite prose-only (the current :83-86
is).

C19. [merge friction] feat/clean-org-names (its plan Task 11.18, lines
24801-24924, read via git show) edits the SAME hunks: it inserts
'/settings/organizations' plus a comment right after `routes.test.ts:381-382`,
quoting our :381 comment verbatim as its "Current"; it appends a second Known
gap paragraph after `e2e/README.md:83-86`, quoting the paragraph verbatim; it
adds a KNOWN GAP comment after `routes.ts:642` and a Settings route in App.tsx
(moving the ledger's App.tsx citation again). Plan S15 step 1 names none of
these. Fix: keep :381 verbatim and ADD a separate comment line plus
'/tours/all' (instead of rewriting :381 to "New list views, ..."); change
README:83-86 minimally or append a sentence; add `routes.test.ts`,
`e2e/README.md` and `routes.ts` to S15's expected-conflict list (keep both
exclusions and both gap notes).

---

## 14.1 - GLOSSARY and the sequence-diagram doc (plan 3178-3204)

Anchors verified: "## Feature & label notes" at `GLOSSARY.md:115`; entries are
`- **term** (context, date) - text` bullets separated by blank lines; the LAST
entry is "Tour auto-close / "No outcome recorded" / Reopen" `:335-353`, then a
blank `:354`, `---` `:355`, "## For the future AI layer" `:357`. No entry for
Requested / Needs booking / Undated / Not booked exists. `:335-357` are ASCII.
`sequence-diagram-to-test.md:262-263` hold "Rows render 'Not booked'/'Not yet"
/ "booked' <U+2014> assert the label 'Requested', never the raw enum."; of the
two only :263 is non-ASCII; the same bullet's :259 and :261 carry U+2192.

C20. Entry format: the plan's text has "(tour list, 2026-10-06, Sam's item 18):
a requested tour" - a colon no entry uses; the house form (`:312`, `:335-336`)
is ") - text". Fix: ") - a `requested` tour ...", inserted after :353 with one
blank line before the `---`.

C21. (guard) Rewrite `sequence-diagram-to-test.md:262-263` only; do not reflow
:259-261 (non-ASCII arrows). "Not yet booked" exists nowhere else in the repo -
drop it.

---

## 14.2 - issue registry (plan 3206-3243)

Anchors verified: `docs/issues/README.md:41-56` (frontmatter; id / title / type
/ severity / status required, resolved optional), `:61-66` (type bug | security
| debt | improvement | decision; severity high | med | low; status open |
in-progress | deferred | resolved | wontfix), `:83-87` (close = status +
resolved + a Resolution paragraph, keep the file); `scripts/issues.mjs:15-19`
(same lists). Resolution headings: `**Resolution (YYYY-MM-DD).**` (template
`:26`, 85 uses) and `**Resolution (YYYY-MM-DD, <branch>).**` (about 30 uses) are
both house forms. `tours-scheduled-range-query-unpaginated.md` (open :6),
`undated-tour-wording.md` (open :6; its title :3 still says "Not booked"),
`perf-pages-tours-past-surface.md` (open; the slug is referenced at
`routes.ts:616`, `:627`, `routes.test.ts:381`, `e2e/README.md:86` - exactly
those four outside docs/superpowers), `tour-no-show-without-date.md` (open;
stays). The two new slugs do not exist yet.

C22. [ASCII rule] `docs/issues/_TEMPLATE.md` is not ASCII: `:13` (inside the
comment block) and `:23` ("**Suggested fix.** Optional <U+2014> ...") carry
U+2014. A copy that keeps either fails the new-file check. Fix: delete the
comment block (the template says to) and rewrite :23.

C23. (guard) `npm run issues` always exits 0; frontmatter problems print as
"[issues] N warning(s)" lines (`scripts/issues.mjs:93-96`). Read the output:
none may name a touched file.

C24. `undated-tour-wording.md`'s Suggested fix (`:30`) keeps "Not booked" for a
request. The Resolution should state the shipped words ("Needs booking" for a
request, "Undated" otherwise - D8 at the spec gate) so the record is not read
as the design. Its refs (`:9`) are pre-change lines - leave them as the record.

C25. The widened perf issue names "the alert" as the All view's error terminal,
but plan 12.1 gives the first-page failure no role="alert" (the named views do,
`ToursPage.tsx:724`). Either S12 renders it with role="alert" or the issue
names what S12 renders. Low; flag to the S12 implementer.

---

## 15 - gates and self-QA (plan 3246-3314)

Anchors verified (root `package.json:16-75`): `typecheck` = every workspace's
typecheck (e2e: `tsc -p tsconfig.json`, which includes `tests/**`, strict +
noUncheckedIndexedAccess); `test` = `npm run test --workspaces --if-present` ->
app, dashboard, e2e (performance/** and support/** only), fake-twilio,
fake-twilio/web; `smoke` = build app + `scripts/smoke-dist.mjs`; `lint` =
`eslint .` (not a gate); `e2e` = `npm run e2e -w @housingchoice/e2e` ->
`playwright test`; `e2e:session|restart|reseed|stop` = `scripts/e2e-*.mjs`;
`perf:pages` = `tsx e2e/performance/cli.ts`; `issues` = `scripts/issues.mjs`.
The plan's five gate commands match AGENTS.md "Required completion gates".

C26. Gate 4: the full suite is about 18 min idle and was measured near 35 min
(AGENTS.md); the Bash tool's foreground cap is 10 min, so run it in the
background under an outer `timeout`, output redirected to a file (a redirect,
never a pipe). Before it, `npm run e2e:stop` any session in this worktree (an
older-commit session fails preflight - C12; a same-commit one would be
adopted, and AGENTS.md forbids a suite plus a session). After a kill,
`npm run e2e:stop` and confirm the lane ports are free (AGENTS.md
reuseExistingServer note).

C27. (info) Gate 5 baseline, measured now (HEAD == base for these files): 9
errors + 2 warnings already sit in files the plan edits -
`app/src/lib/seed/cast.ts` 79:7, 109:7, 110:7, 434:7 and `matrix.ts` 134:7
(no-unused-vars); `dashboard/src/routes/contact/TenantFile.tsx` 15:8
(no-unused-vars); `dashboard/src/routes/tours/TourDetail.tsx` 327:85
(react-hooks/purity, Date.now); `e2e/tests/dashboard-next/tours-page.spec.ts`
27:7, 269:11 (no-unused-vars); `e2e/tests/scenarios/tours.spec.ts` 57:5, 61:5
(warnings, unused eslint-disable). The other 30 existing touched files are
clean (list in the reference, section 8). Compare by (file, ruleId, message)
multiset, not by line - S2 / S8 / S12 shift these lines. `-f json` exists
(eslint 9.39.4).

C28. (info) Self-QA: launch the session at the final HEAD (C12) and stop it
before any later gate-4 run. Future-dated tours less than about a day out arm
rungs that can send to the FAKE during QA; keep future rows 2+ days out
(harmless on the hermetic lane, but it keeps the fake's thread store quiet).

---

## Pinned contracts the S10 split must keep (perf registry)

| surface | source (routes.ts) | GET contract | unit-test pin |
|---|---|---|---|
| /tours | Today nav link "Tours" (`:614`) | TOUR_LIST_ACTIVE_GETS `:282-289`: required /api/tours?from&to; required /api/tours?status; required /api/contacts?limit&type + conditional ?cursor&limit&type; required /api/contacts?deleted&limit&type + conditional ?cursor&deleted&limit&type; required /api/units?limit + conditional ?cursor&limit; required /api/units?deleted&limit + conditional ?cursor&deleted&limit | `routes.test.ts:84-87` (warm) |
| /tours/closed | /tours, heading "Tours" exact (L.tours `:380`), link '/tours/closed' (`:615`) | TOUR_LIST_CLOSED_GETS = the same (`:290`); WARM: all conditional except /api/tours?status (`:886-891`) | `routes.test.ts:88-94` |
| /tours/:tourId | /tours, L.tours, link to the resolved row (`:645`) | TOUR_DETAIL_BASE_GETS `:346-352` + GROUP_THREAD_GETS `:360-363` or PERSON_THREAD_GETS `:364-367` by branch (`:865-868`) | `routes.test.ts:137+` |
| cold (all) | - | COLD_SHELL_GETS `:237-245` (/app-identity/config.json, /auth/me, /api/inbox/unread-count, /api/unmatched-email?filter) are prepended (`:893`) | - |

| surface | terminal (routes.ts) |
|---|---|
| /tours | TOUR_ACTIVE_TERMINAL `:412-419`: structure region "Upcoming tours" + region "Needs booking"; populated (any) a list inside either region; empty (all) text "No tours scheduled in the next 30 days." + "No unbooked tour requests."; error role alert. Shape pinned `routes.test.ts:457-462`. |
| /tours/closed | TOUR_CLOSED_TERMINAL `:420`: list "Closed tours list" / text "No closed or canceled tours yet." / alert |
| /tours/:tourId | TOUR_DETAIL_TERMINAL `:497`: link "Back to tours" / alert |

The split must keep: h1 "Tours" on /tours (L.tours is exact), the region and
list names above, the Closed tab's href '/tours/closed', the Active rows' href
'/tours/<id>' (the resolver clicks it), and ONE mounted component across
Active / Past / Closed (the warm /tours/closed contract treats the walks as
conditional because they do not refetch).

Mutation catalog: GETs are never cataloged - `mutationCatalog.test.ts:323-328`
drops `:GET` discoveries; `methodClassFor` (`:180-182`) defaults to GET when the
options object has no `method`. The plan's `listTours` (plan 1714-1732: an
object literal with `query` and a `signal` spread behind `&&`) classifies as
request:GET (the `&&` spread resolves through `:118-119` to an object without
method). The count 111 (`:376`) is unchanged. Keep the options argument an
object literal (a bare variable throws unprovable_method, `:129`, test
`:353-361`).

---

## Run-command facts

- Playwright (`e2e/playwright.config.ts`): testDir ./tests; workers 1,
  fullyParallel false (`:140-141`); retries 0 (`:143`); forbidOnly in CI;
  per-test timeout 60 s (`:115`, `:121`; `test.slow()` triples it); expect 15 s
  (`:135`); navigationTimeout 15 s (`:170`); webServer timeout 180 s (`:204`),
  reuseExistingServer when not CI (`:203`); trace 'on-first-retry' collects
  nothing with retries 0, `E2E_TRACE=1` switches to retain-on-failure (`:167`);
  screenshot only-on-failure, video retain-on-failure; baseURL = the lane
  dashboard (`:153`); globalSetup `support/preflight.ts` (stack identity, the
  stale-commit guard of C12, clean-slate reset).
- Lanes: lane 0 (8080 / 5174 / 8889 / 5173) is never used by e2e; lane L is
  9001+100L (+0 app, +10 dashboard, +20 fake, +30 public base); this worktree
  hashes to lane 7 (9701 / 9711 / 9721 / 9731, prefix hc-local-7-, key
  hclane7) unless occupied. `e2e/.artifacts/lane.json` is a routing record, not
  liveness (`e2e/README.md:513-539`). The config adopts a LIVE session of this
  worktree (pid + lease, `playwright.config.ts:26-51`) and prints
  "[playwright] reusing the live e2e:session on lane N".
- `npm run e2e:session`: long-lived, run in the background, logs a `ready` line
  with the app / web ports (`scripts/e2e-session.mjs:765`); `e2e:restart` =
  app + worker only (Vite keeps serving source live); `e2e:reseed` = POST
  /__dev/reseed after a lane identity ping (logs the browser out); `e2e:stop` =
  reap the launcher and lane ports, clear state - then confirm the ports free.
- One spec: `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/tours-all.spec.ts`
  (with a live same-commit session it reuses the lane; without one it boots
  and tears down its own). Flags need this single hop.
- `E2E_CHILD_LOG_DIR=<dir>` appends app / worker / Vite / fake logs - for
  CONTENT symptoms only; it changes timings (AGENTS.md).
- Perf registry unit run: `cd "W:/tmp/tour-list/e2e"; npx vitest run performance/routes.test.ts`
  (resolves the root vitest 3.2.6; the house form).
- `npm run perf:pages`: not required by the plan; agents may run only the
  hermetic target (`npm run perf:pages -- hermetic --scale=10`, README `:92`;
  `--self-qa=narrow|full` at scale 1, `:139`); it refuses while this worktree
  has a live session or suite (`:424-427`); local / hosted-dev are human-only.
- `npm run issues` regenerates the gitignored `docs/issues/INDEX.md`
  (`.gitignore:62`); exit 0 always (C23).
- Worktree files are LF (`.gitattributes` `* text=auto eol=lf`), so `$`-anchored
  greps behave normally; the plan's `git grep -n -i -E "not$"` check was run and
  finds `steps.ts:1168` and `tours-page.spec.ts:238` (plus unrelated prose hits
  at steps.ts:320, 3648, 3814, 3895).

---

## Invariant sweep (whole repo outside docs/superpowers; raw output in the reference, section 6)

"Not booked" / "not booked" / "Not yet booked" (case-insensitive, plus the
split-line form):

| file:line | what | covered |
|---|---|---|
| dashboard/src/routes/tours/TourDetail.tsx:312 | literal | S8 yes |
| dashboard/src/routes/contact/TenantFile.tsx:337 | literal | S8 yes |
| dashboard/src/routes/contact/LandlordFile.tsx:217 | literal | S8 yes |
| dashboard/src/routes/listing/ListingDetail.tsx:1084 | literal | S8 yes |
| dashboard/src/routes/tours/TourModals.tsx:203 | comment | S8 yes (-> "Undated") |
| dashboard/src/routes/tours/TourDetail.test.tsx:307-308 | comment + regex | S8 RED 2 yes |
| dashboard/src/routes/contact/files.test.tsx:266, 278, 458, 470 | titles + regexes | S8 RED 3 yes |
| dashboard/src/routes/listing/ListingDetail.test.tsx:432-433 | comment + regex | S8 RED 4 yes |
| e2e/scenarios/steps.ts:1147 | doc comment | S8 yes |
| e2e/scenarios/steps.ts:1168-1169 | split comment | S8 yes |
| e2e/scenarios/steps.ts:1176 | assertion | S8 yes |
| e2e/scenarios/steps.ts:1853 | "Requested + not booked" comment | NO - C1 |
| e2e/scenarios/steps.ts:1854, 1856 | comment, assertion | S8 yes |
| e2e/tests/dashboard-next/tours-page.spec.ts:238-239 | split comment | S8 yes |
| e2e/tests/dashboard-next/tours-page.spec.ts:242 | assertion | S8 yes |
| e2e/tests/dashboard-next/tours-page.spec.ts:479 | "(requested, not booked)" | NO - optional, C2 |
| e2e/tests/scenarios/tours.spec.ts:417 | comment | S8 yes |
| documentation/sequence-diagram-to-test.md:262-263 | split, living doc | S14.1 yes |
| docs/issues/undated-tour-wording.md:3, 19, 22, 24, 30 | the issue record | S14.2 resolves; text stays (C24) |

"Undated" / "undated":

| file:line | what | covered |
|---|---|---|
| dashboard/src/routes/tours/ToursPage.tsx:206 | Past row literal | S8 -> helper, output unchanged |
| dashboard/src/routes/tours/ToursPage.tsx:185-189, 202-203, 207 | comments; ", undated" in the name | unchanged, still true |
| dashboard/src/routes/today/Today.tsx:215 | literal | S8 -> helper |
| dashboard/src/routes/today/Today.tsx:201 | ", undated" in the name | unchanged (plan says so) |
| dashboard/src/routes/today/Today.test.tsx:356, 360, 361 | pin | S8 RED 7 (PIN) |
| dashboard/src/routes/tours/ToursPage.test.tsx:1216, 1223, 1225, 1227 | pin | S8 RED 5 (PIN) |
| dashboard/src/routes/tours/tourTime.ts:85; tourTime.test.ts:112 | whenLabel gives '' for undated | unchanged (All rows call it only when dated) |
| dashboard/src/routes/tours/useTours.ts:17, 216, 224, 230, 243, 280; useTours.test.ts:352, 402, 421 | internal term (isUndated) | unchanged |
| e2e/tests/dashboard-next/tours-past.spec.ts:242, 245, 257-282 | Past e2e: 'Undated' and ", undated, Needs outcome" | output unchanged - must stay green |
| app/src/services/relayInboundResolution.ts:37-38 | relay rows | unrelated |
| docs/issues/past-tab-timeless-toured-tours.md:34-41; perf-pages-tours-past-surface.md:46; tour-no-show-without-date.md:24; tours-scheduled-range-query-unpaginated.md:52; undated-tour-wording.md | records | n/a or S14.2 |

"Needs booking" today: every e2e use is the Active region by role
(`tours-past.spec.ts:102`, `tours-page.spec.ts:248, 288`) and the perf terminal
(`routes.ts:413, 416`) - unaffected (Active's request rows use timeDisplay
'none', no date column).

Out of scope, dated records: "not booked" in
docs/superpowers/plans/2026-07-02-tours-sequence-e2e.md and
specs/2026-07-08-tour-detail-page-design.md; "undated" in 27
staff-notes-past-tours / tour-auto-close records and specs (plus this
feature's own spec, plan and reviews).

---

## Gaps, risks, decisions

R1. S8's e2e edits first run at S15 (gate 4). Have the S13 lane run also take
`tests/scenarios/tours.spec.ts` (9 call sites of the changed step) or at least
`tests/tour-no-show-checkin.spec.ts` + `tests/scenarios/sending-unit.spec.ts`,
plus `tours-page.spec.ts` and `tours-past.spec.ts` (the renamed :242, the Past
pins :274-276, the tab strip after S10) - an early signal for little cost.

R2. `e2e/support/selectors.md` has no Tours row; the house adds selector rows
with a new surface's spec (#1 did, commit ddeb6b58). Suggest one row for the All
tab: list "All tours list", chips exact inside group "Status", "Clear status
filter" vs "Clear filters", the three-way "Needs booking" collision, the count
line read by text.

R3. Spec 10 defers two items no issue tracks: server-side search for the All
tab (spec 6 cites typeahead-scale-needs-server-side-search.md only as a
precedent) and live updates of the All list. AGENTS.md routes deferrals to
docs/issues/.

R4. Test 3 is the only end-to-end proof of "return with a restore record AND an
adopted search" (unit cases 12.4-2 and 12.4-7 cover restore without a search
and a blur mid-restore). By the plan's hook it works: a complete first page
leaves autoMode null and restoreOutcome 'reached' (plan 2513-2520), and the
click that navigates back fires before the view's listeners mount. Any click or
keypress after "Back to tours" and before `toBeFocused()` trips the user-intent
guard (plan 2994-3004) - assertions only until focus is checked.

R5. File order: tours-all runs after today-* and before tours-page / tours-past
(both reseed). Its leftovers cannot disturb a later non-reseeding spec: none is
dated today (no "Tours today" heading), and closed-out rows (toured + outcome)
are off Past and Today (`useTours.ts:205, 244`).

R6. Disclosure: to read the lane I ran `node e2e/support/lane.mjs` once. It
wrote a RESERVED lease `%TEMP%\hc-e2e-lanes\lane-7.json` (reserver pid already
dead) at 20:45:19Z, reclaimable after the 240 s grace (`laneLease.mjs:50,
137-148`) - long expired before any build step. No session was started and no
`e2e/.artifacts` state was written.

Decisions for the orchestrator (the first two act before S13 - in S8 and S10):

- D1 (S8): fix `steps.ts:1853`, decide `tours-page.spec.ts:479`, and make the S8
  check case-insensitive (C1, C2).
- D2 (S10 / S13): edit `routes.test.ts:381` and `e2e/README.md:83-86` by
  ADDING lines, and add the three e2e/perf files to S15's conflict list (C19).
- D3 (S13): run mode - a session started after the last commit with the spec
  run uncommitted, or the single cold-boot `-w` run (C12).
- D4 (S14.2): file the two spec-10 deferrals or record them in the handback
  (R3); add a selectors.md row (R2).
