# D7-S7 findings - plan section 11 (S7 e2e, gates, command sheet)

Reader D7-S7 checked plan lines 1-515 (binding sections 0-4) and 15790-16062
(S7: S7.1-S7.6 and the coverage table) against the worktree at branch HEAD
ede08552, whose app/, dashboard/, e2e/, scripts/ and package.json are
byte-identical to main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those
paths is empty; `main` has not moved). Cross-read for selectors: S1.3 mirror
(1620-1877), S1.4 edit form (1900-2219), S1.5 intake rows/chips (2222-2652),
S2.2/S2.3 checkbox, row and pill (3079-3526), S3.4 drop (4864-5016), S3.8
marker (5578-5711), S4.2 filterNoteLines (6185-6370), S4.5 and S5.8 "Notes
lines" region (7302-7450, 10474-10723), S4.7 e2e payloads (7581-7644), S5
propertyLabel / block / counts (8120-8192, 8790-8897), and the S6 gate-run
subsection (15549-15637). Read: e2e/README.md, e2e/support/selectors.md,
e2e/support/preflight.ts, e2e/playwright.config.ts, scripts/e2e-session.mjs,
every helper S7 names, and the dashboard/app code the specs drive. Nothing was
run. Six MINOR findings and four NOTEs; no BLOCKER.

## D7-S7-1 - MINOR - S7.2 test 2's "no chip shows" after the write run is vacuous

- Plan location: Task S7.2, test 2 (plan lines 15908-15913); focus item (e).
- What the plan says: PATCH `area_preference` to `Marietta`; send
  `op: 'write', value: 'Decatur'`; "after the tick the row still reads
  `Marietta` and no chip shows"; then a `suggest` run shows the chip.
- What the tree holds: the page's suggestions are a SEPARATE fetch that starts
  as an empty list (`dashboard/src/routes/contact/useSuggestions.ts:51-72`,
  state initialised `{ suggestions: [] }` at :52), while the row value comes
  with the contact. So `toHaveCount(0)` on `AI suggestion for area preference`
  passes the instant the row renders, before the suggestions request lands -
  it would pass even if apply had (wrongly) turned the write into a
  suggestion, which is exactly the regression S3.4 guards. `tick.processed >= 1`
  does not close the gap either: a malformed or ignored marker is still a
  processed run with an empty result (`app/src/adapters/extractionFake.ts:104-109`).
  And the later `suggest` run cannot discriminate: a wrongly-created
  `Decatur` suggestion from run 1 and the correct one from run 2 render the
  same chip. The file's own tombstone test solves the same problem with a
  sentinel (`e2e/tests/flows/conversation-fact-extraction.spec.ts:478-498`), and
  manual-extraction-trigger.spec.ts:157-163 records the vacuous-absence trap.
- Correction (replace test 2's text):
  "2. `text field: a write on a filled field is dropped, a suggest becomes a
  chip` - `devLogin`; a fresh tenant (`createTenant(page.request, { firstName:
  'AreaFilled' })`); PATCH `${NEXT}/api/contacts/${contactId}` with
  `{ area_preference: 'Marietta' }` (expect ok). Run 1: `sendExtractSms(request,
  phone, { fields: { area_preference: { op: 'write', value: 'Decatur', reason:
  'said Decatur' }, voucherSize: { op: 'suggest', value: '3', reason:
  'sentinel fact' } } })`; tick, `processed >= 1`. Server truth first:
  `GET ${NEXT}/api/contacts/${contactId}/suggestions` -> `suggestions[].target`
  contains `voucherSize` and does NOT contain `area_preference`
  (app/src/routes/suggestions.ts:116-130, no role guard, so the VA login
  reads it); `readContact(page.request, contactId)['area_preference']` is
  `'Marietta'`. Page: open `/contacts/<id>`; FIRST expect
  `getByRole('group', { name: 'AI suggestion for voucher size' })` visible
  (the run applied and the separately fetched suggestions are in), THEN the
  Eligibility intake row reads `Marietta` and
  `getByRole('group', { name: 'AI suggestion for area preference' })` has
  count 0. Run 2: `op: 'suggest', value: 'Decatur'`; tick; reload; the chip
  `AI suggestion for area preference` shows `AI heard "Decatur"`."

## D7-S7-2 - MINOR - S7.3's flyer check (WI12) passes on the "unavailable" page unless the unit is published first

- Plan location: Task S7.3, last sentence of "Test" (plan lines 15973-15975);
  focus item (f).
- What the plan says: "Also assert the public flyer page for that unit (if
  the existing specs open one for an available unit, follow that pattern)
  carries no 'Priority' text (WI12)." No publish step and no position in the
  flow.
- What the tree holds: a unit made by the New property form starts in
  `setup` (`app/src/routes/units.ts:979-987`); the flyer endpoint answers the
  same opaque 404 for any unit not in `SHAREABLE_STATUSES`, which is
  `available` only (`app/src/routes/public.ts:842-849`,
  `app/src/repos/unitsRepo.ts:56`, :64); the property page itself says "The
  public flyer goes live when this property is Available."
  (`dashboard/src/routes/listing/ListingDetail.tsx` flyer block, ~:899-916).
  So `/p/<unitId>` of a fresh form-created unit renders the unavailable state
  and "no Priority text" is green on an empty page. Second trap: the flyer's
  h1 and the property page's h1 are the street line, so a test address
  containing the word "Priority" would make a non-exact `getByText('Priority')`
  match the address. The pattern the plan asks for exists:
  property-requirements.spec.ts publishes through the transition route
  (`publish`, :129-134) and then opens `/p/<id>` and the JSON (:425-455);
  flyer-leads.spec.ts asserts a positive on the same load before absences
  (:342-349, :386-404).
- Correction (append to S7.3's "Test" text): "Choose a street line that does
  not contain the word Priority (e.g. `${stamp} Pswitch Ave`). Do the flyer
  check while Priority is ON (after the first save, before Edit): publish
  with `PATCH ${NEXT}/api/units/${unitId}/listing-status` and body
  `{ toStatus: 'available', source: 'manual' }` (expect ok), as
  property-requirements.spec.ts:129-134 does; `GET ${NEXT}/public/units/${unitId}/flyer`
  is 200 and `Object.keys(flyer)` does not contain `priority`; open
  `${NEXT}/p/${unitId}`, assert a positive on that load FIRST
  (`getByRole('heading', { level: 1 })` has text `line1`, flyer-leads.spec.ts:345-349),
  then `getByText('Priority')` has count 0. Then return to
  `/listings/<unitId>` for the Edit / uncheck half (the header pill is read
  with an exact match inside the page `<header>`)."

## D7-S7-3 - MINOR - S7.1's BLANK rows need the em dash, which the ASCII rule forbids typing; S7 runs no ASCII check

- Plan location: Task S7.1 steps 1 and 5 ("each BLANK", "the row is blank",
  plan lines 15866-15879); section 0 ASCII rule (52-57) and its `\u` warning
  (59-60); S7.1-S7.3 commit steps (15890-15894, 15959-15962, 15985-15988).
- What the plan says: the four rows are "each BLANK"; a cleared row "is
  blank". No ASCII check step in S7.1-S7.4.
- What the tree holds: BLANK is U+2014 (`dashboard/src/routes/contact/Card.tsx:138`,
  `export const BLANK = '\u2014'`); no e2e spec asserts it today (no
  `u2014` or BLANK assertion anywhere under e2e/). Typing the character
  breaks the ASCII rule, and section 0 warns that a `\u` escape typed through
  the Write/Edit tools can be decoded into the literal character (then only a
  grep catches it). Both new spec files and
  the modified conversation-fact-extraction.spec.ts are pure ASCII today
  (0 non-ASCII bytes).
- Correction: in S7.1 add "Declare
  `const BLANK = String.fromCharCode(0x2014); // the dashboard's BLANK, Card.tsx:138`
  and read a row through its label span's parent, e.g.
  `intake.getByText('Area preference', { exact: true }).locator('..')`
  `toHaveText(`Area preference${BLANK}`)`." And add to the S7 sequence step 4
  (before the first S7 commit): "ASCII check, each prints 0:
  `tr -d '\11\12\15\40-\176' < W:/tmp/wp1-b1-ranking-inputs/e2e/tests/dashboard-next/tenant-matching-inputs.spec.ts | wc -c`,
  the same for `e2e/tests/dashboard-next/property-priority.spec.ts` and for
  `e2e/tests/flows/conversation-fact-extraction.spec.ts`."

## D7-S7-4 - MINOR - The "shared helpers" are file-local; the two NEW spec files cannot reuse them, and S7.2's new import can collide

- Plan location: S7 preamble "Shared e2e helpers (already in the tree, reuse
  them, add none unless a task says so)" (plan lines 15797-15808); S7.1
  (15865), S7.3 (15968-15970), S7.2 test 4 (15919-15920).
- What the plan says: reuse `createTenant` / `devLogin` / `readContact` "at
  the top of" conversation-fact-extraction.spec.ts; add no helpers.
- What the tree holds: those three are NOT exported
  (`e2e/tests/flows/conversation-fact-extraction.spec.ts:31-35`, :47-65,
  :86-93), and importing one spec file into another would re-register its
  tests anyway. No exported devLogin exists in e2e/ (the dashboard-next
  dialect is a local `NEXT` + local `devLogin` per file, selectors.md and
  `e2e/tests/dashboard-next/property-requirements.spec.ts:36`, :92-97). The
  only exported tenant creator is `createTenant` in
  `e2e/support/followUpFixtures.ts:21` - S7.2 test 4 must import from that
  module (`createUnitViaApi`, `plantListedSend`, `daysAgo`), and importing its
  `createTenant` too would clash with the file's local `createTenant` (:47;
  TS2440, a red e2e typecheck). S7.3's pattern helpers (`createLandlord`
  :106-114, `getUnit` :122-126, `publish` :129-134,
  `addPropertyFromLandlordPage` :172-200) are file-local as well.
- Correction (replace the preamble's "reuse them, add none unless a task says
  so"): "The conversation-fact-extraction helpers are file-local: S7.2 uses
  them in place. Each NEW file (S7.1, S7.3) declares its own
  `const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';`
  and a local `devLogin` (property-requirements.spec.ts:92-97, VA). S7.1 may
  import `createTenant` from `../../support/followUpFixtures.js` (returns
  `{ contactId, firstName, name, phone }`; it also records consent, harmless).
  S7.3 copies `createLandlord`, `getUnit`, `publish` and
  `addPropertyFromLandlordPage` locally from property-requirements.spec.ts.
  S7.2 adds exactly `import { createUnitViaApi, daysAgo, plantListedSend } from
  '../../support/followUpFixtures.js';` - never `createTenant` from there."

## D7-S7-5 - MINOR - The session must be started in the background and be `ready` before the first spec run

- Plan location: S7 sequence step 1 (plan lines 15824-15828) and step 2
  (15829-15838).
- What the plan says: "start ONE session and leave it running" with
  `cd W:/tmp/wp1-b1-ranking-inputs; npm run e2e:session`, then run each spec.
- What the tree holds: the session never exits on its own, so a foreground
  call blocks until the tool timeout kills it. README's agent workflow says
  "Start the stack in the background ... (wait for `ready`)" (e2e/README.md:709);
  the ready line is `ready - app :<port> ...` (scripts/e2e-session.mjs:832).
  A spec run started during boot finds the lane (lane.json and session.pid are
  written BEFORE the children start, e2e-session.mjs:770), adopts it
  (e2e/playwright.config.ts:26-51), finds the dashboard URL not answering, so
  the webServer (reuseExistingServer only reuses a URL that answers,
  :183-217) launches a second `node scripts/e2e-session.mjs` on that lane with
  the session's token - whose SELF-HEAL kills the live session's launcher
  tree (e2e-session.mjs:717-726). The "one session" then silently becomes
  per-run stacks.
- Correction (step 1): "Start it with the shell tool's background mode (never
  in the foreground) and wait until its output shows the launcher's
  `ready - app :...` line (scripts/e2e-session.mjs:832; e2e/README.md:709)
  before the first spec run. If a run prints that it is booting a stack
  rather than `[playwright] reusing the live e2e:session on lane N`, stop and
  restart the sequence from step 1."

## D7-S7-6 - MINOR - S7.5's self-qa.md and S7.6's gate-run sheet have no commit step

- Plan location: Task S7.5 (plan lines 16033-16035), Task S7.6 (16039-16044),
  S7 close (16046-16048).
- What the plan says: S7.5 records checks "in ... self-qa.md"; S7.6 writes
  "gate-run-commands.md ... with the branch's final commit"; only the S7
  report is "committed with explicit paths".
- What the tree holds: AGENTS.md "Mission reasoning is version-controlled ...
  self-QA and the handback ... committed AS PRODUCED" and
  documentation/FEATURE-DEVELOPMENT-WORKFLOW.md section 8 ("Commit each record
  AS IT IS PRODUCED", self-QA listed as a tracked record). Also, a sheet
  committed after the gates cannot name its own commit as "the branch's final
  commit".
- Correction: S7.5, after `npm run e2e:stop`: "commit the record in the S7
  form (status, MERGE_HEAD check, `git -C W:/tmp/wp1-b1-ranking-inputs add
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/self-qa.md`,
  message `docs(records): b1 live self-QA (B1 S7.5)` plus the trailer)." S7.6:
  "the sheet names the commit the S7.4 gates ran at; commit it the same way
  (path `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/gate-run-commands.md`,
  message `docs(records): b1 never-written gate-run command sheet (B1 S7.6)`)."

## D7-S7-7 - NOTE - S7.4: a merge that changes the lockfile needs `npm ci` before the gates

- Plan location: Task S7.4 step 1-2 (plan lines 15992-16016).
- Note: `main` == d0e2c2d8 today, so the merge is a no-op now. If main moves
  with a `package-lock.json` change, the gates run on stale node_modules.
  Suggested line after the merge: "if `git -C W:/tmp/wp1-b1-ranking-inputs
  diff --name-only HEAD@{1} HEAD -- package-lock.json` lists the lockfile, run
  `npm ci` at the worktree root (bare) before step 2."

## D7-S7-8 - NOTE - S7.3 and S7.2 test 4 are long single tests under a 60 s cap

- Plan location: S7.3 (15966-15975), S7.2 test 4 (15919-15948).
- Note: the per-test cap is 60 s (e2e/playwright.config.ts:115-121). S7.3
  drives the New form, a publish, the flyer, the Edit form and several page
  loads; property-requirements.spec.ts marks a single New-form test
  `test.slow()` (:499). S7.2 test 4 does two logins, unit + send setup, a
  tick and the run log. Suggest `test.slow();` at the top of both.

## D7-S7-9 - NOTE - S7.5: the MCP browser cannot use the signed inbound helper

- Plan location: S7.5 "drive one fake extraction run with a feedback line"
  (16025-16026).
- Note: `sendExtractSms` posts a Twilio-signed webhook from the test runner
  (e2e/fixtures/fakeTwilio.ts:89-91), which an MCP page cannot do. A route
  that works from the logged-in page via fetch: create the unit (`POST
  /api/units`, as createUnitViaApi does, then the listing-status PATCH),
  `POST /__dev/listing-send-fixture`, resolve the conversation (`POST
  /api/contacts/:id/conversation`), plant the `EXTRACT:` text with `POST
  /__dev/extraction/message-fixture` (`direction: 'inbound'`, `createdAt`
  now; app/src/routes/dev.ts:966-1187 - it does NOT schedule a run), then the
  contact page's More actions > "Run AI extraction" and `POST
  /__dev/extraction/tick` (manual-extraction-trigger.spec.ts:189-197). The
  fake-phones UI is the other route.

## D7-S7-10 - NOTE - selectors.md does not list the new chip labels or the "Notes lines" region

- Plan location: S6 docs scope (RUNBOOK, GLOSSARY, env examples) and S7.
- Note: e2e/support/selectors.md:59 enumerates the review-chip labels
  (`voucher size` ... `type`); `area preference`, `maximum tenant portion`,
  `accessibility need`, `preferences and constraints`, the `Notes lines`
  region and the `Priority` checkbox/pill are new selectors S7 relies on.
  Optional doc line; no gate depends on it.

## Verified with no finding

- `e2e/fixtures/extraction.ts`: `sendExtractSms(request, phone, payload:
  Record<string, unknown>)` posts `EXTRACT:` + `JSON.stringify(payload)` on one
  line (:50-62); `extractionTick(request)` returns `{ processed, failed }`
  (:14-31), which the dev route sends (app/src/routes/dev.ts:778-783).
- `e2e/support/followUpFixtures.ts`: `createUnitViaApi(api, stamp, tourType?)`
  -> `{ unitId, line1 }`, line1 `${stamp}NN Heardfrom Ave`, city `Atlanta`,
  flipped to available (:48-75); `plantListedSend(api, unitId, contactId,
  sentAt): Promise<void>` expects 201 (:79-82); `daysAgo(n)` ISO (:85-87); a VA
  login may call all three (follow-up-tab.spec.ts:74-81).
- `/__dev/listing-send-fixture` writes `counted: true` + `sentAt`
  (dev.ts:1468-1519), so `isListed` keeps it (listingSendsRepo.ts:235-237) and
  `listByContact` returns it (:486-498); the units display read projects
  `address` (unitsRepo.ts:1276-1299).
- conversation-fact-extraction.spec.ts has `NEXT` (:29), `type Page` (:1),
  `expectTodayReady` (:8, exported at support/today.ts:45); its `devLogin`
  signs in as the seeded VA (Login.tsx:87-89; dev.ts:326); founder dev-login
  is admin (dev.ts:211-214); the run log is admin-only (aiRuns.ts:137); the
  plan's `devLoginAs` equals ai-run-log.spec.ts:18-25; the run-detail flow
  equals ai-run-log.spec.ts:207-222.
- Accessible names: AutoBadge `role="img"` name `Auto` (AutoBadge.tsx:24-27);
  chip `role="group"` `AI suggestion for <label>` with own text node
  `AI heard "<value>"` (SuggestionChip.tsx:40-43); S1.3 spreads each
  `chipLabel` into SUGGESTION_TARGET_LABEL (plan 1875) and S1.5 passes the
  formatted value, a text value trimmed raw (plan 2581, 2616-2632); region
  `AI run detail` (AiRunDetail.tsx:69); list `AI runs` (AiRunList.tsx:53);
  S4.5 `<section aria-label="Notes lines">` is a named region inside it (plan
  7406, 7423); S5.8 items read `Feedback lines: N` / `Unlabeled address
  lines: N` (plan 10685-10686) and the guard renders them (plan 10665-10668).
- Edit form: S1.4 labels sit outside the controls via `htmlFor`, exact names
  `Area preference`, `Maximum tenant portion`, `Accessibility need`,
  `Preferences and constraints` (plan 2145-2181); dialog `Edit contact`
  (ContactEditForm.tsx:655); a `{ error }` from buildPatch is shown in the
  `role="alert"` paragraph (:544-545, :1145); S7.1 step 4's sentence equals
  `tenantMatchingDollarsInvalid` (plan 1682-1684); step 3's `$1,200 / month`
  equals `formatTenantMatchingValue` (plan 1689-1703).
- Priority: TaggedCheckbox's accessible name is the label only, the tag is its
  description (TaggedField.tsx:93-104), so `checkbox 'Priority'` is exact on
  both forms; the KV `Priority` Yes/No is in the Property details card and
  the pill sits in the page `<header>` title row (plan 3448-3488;
  ListingDetail.tsx:866-886); GET /api/units/:id returns the raw unit
  (units.ts:1025-1038).
- WI11 in e2e: no existing non-exact `getByLabel` collides with the four labels
  or `Priority` (the only `Tenant` one is the placement dialog,
  placement-create.spec.ts:132); the intake card always renders
  (EligibilityIntakeCard.tsx:64-68; issue intake-card-hides-pending-suggestions
  resolved 2026-08-03).
- GET /api/contacts/:id returns the raw item (contacts.ts:1277-1299), so a
  REMOVEd key is absent (S7.1 step 5).
- Feedback label (focus d): `propertyLabel({ line1, city: 'Atlanta' })` is
  `<line1>, Atlanta` (plan 8146-8154); `labelMatches` folds case, `.,#` and
  spacing and matches the S7.2 line at index 0 with `:` after the needle
  (plan 8157-8174); the postal filter drops only lines starting "current
  address" with a digit (plan 6344), so the feedback line survives;
  `countFeedbackLines` counts it once and not as unlabeled (plan 8885-8896).
- Fake driver payloads: `{ fields: {}, ...partial }` pass-through
  (extractionFake.ts:103); fields in the internal `{ op, value, reason }`
  shape; noteLines `{ text, confidence }` after S4; an inbound SMS is speaker
  `client` (jobs/extraction.ts:223, :233), so these runs are never demoted
  (:547) and S4.7's unknown-contact payloads still append.
- S4.7 anchors are verbatim and unique: caseworkers.spec.ts:517,
  conversation-fact-extraction.spec.ts:332 and :377, ai-run-log.spec.ts:177,
  extractionFake.ts:7-11; those four are the only e2e noteLines payloads
  (repo-wide git grep).
- Commands (focus c): the one-hop `npm run e2e -w @housingchoice/e2e --
  tests/<path>.spec.ts` matches README:191 (e2e/package.json `"e2e":
  "playwright test"`, testDir `./tests`); the preflight compares the short
  HEAD sha with the app stamp and the dashboard meta (preflight.ts:96-135),
  stamped at launch (e2e-session.mjs:128-135, :279-283), so uncommitted spec
  files never trip it; every run reseeds first (preflight.ts:150).
- Gate 5 (S7.4) is AGENTS.md's command with the git call pinned by `-C`;
  the `main...HEAD` list is non-empty for this branch.
- e2e/performance/mutationCatalog.test.ts (part of root `npm test`) inventories
  dashboard API call sites; B1 adds no dashboard endpoint function, so it stays
  green.
- S7.6's source subsection exists (plan 15549-15637); the S7 plan range is
  ASCII.
