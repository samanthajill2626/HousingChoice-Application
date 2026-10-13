# R1 - spec-conformance review (round 1) - feat/join-housing-authority

- Reviewer: spec-conformance reviewer (Claude Opus 5.5), 2026-10-12. Read-only on the
  source tree; mutation checks run after `.superpowers/sdd/gates/run1-e2e.exit` appeared.
- Tree: feat/join-housing-authority @67cd745c (merge base main @5c0d3f6a).
- Contract: spec rev 4 (`docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`);
  plan sections 0-4 (section 4 assembly rulings win); build-research adjudications
  (S3-F1..INV-F1); slice reports unit1-unit4. The live files were read, not only the
  diff package.
- Grades: CONFORMS / PARTIAL / MISSING / DEVIATES. "impl" and "test" cite file:line on
  the reviewed tree. App tests are under `app/test/`, dashboard tests under
  `dashboard/src/routes/public/`. "backfill" = `app/scripts/backfill-join-housing-authority.ts`,
  "bf-test" = `app/test/backfillJoinHousingAuthority.test.ts`, "PI" =
  `app/test/publicIntake.test.ts`, "HFI" = `HousingFairIntake`.
- Copy strings: every /join string in plan section 1 was compared byte-for-byte against
  the spec (line-joined) and the source (`HousingAuthoritySelect.tsx:21-29`,
  `HousingFairIntake.tsx:53-55,166`): label "Housing authority", help "The organization
  that runs your voucher.", "Not sure", "Loading..." (three ASCII dots), "Choose one",
  "The list of housing authorities could not be loaded.", "The housing authority list
  was updated. Choose the housing authority again.", "Too many sign-ups from this
  network in the last minute. Wait a minute, then send again.", "Sign up another
  person", default "Atlanta Housing Authority", timeout 10 000 ms. All match exactly.
  The thank-you heading is now `&mdash;` (HousingFairIntake.tsx:160): renders the same
  U+2014, pinned by HousingFairIntake.test.tsx:123 and HousingFairIntake.another.test.tsx:85.
- Hygiene: 0 non-ASCII characters and 0 literal backslash-u sequences on added lines
  (feature diff, docs/superpowers excluded).
- Gate evidence used: run1-test.exit `exit=0` (npm test, includes the unchanged
  `app/test/cloudfrontBehaviors.test.ts` edge guard); run1-e2e.log shows
  `public-pages.spec.ts:430` (the new /join case, `ok 174`) and the self-serve scenario
  (`tenant-onboarding.spec.ts:178`, `ok 327`) passing. The run as a whole exited 1 on
  one unrelated-looking spec (R1-C7), not graded here.

## Mutation checks (run after run1-e2e.exit appeared)

Procedure per mutation: confirm the file equals HEAD, back it up to the reviewer's
scratch dir, apply ONE literal edit, run only the named test file(s), restore from the
backup, confirm `git diff --quiet HEAD` and a byte compare. Every restore was
byte-exact; `git status --short` afterwards showed nothing of this reviewer's (only
the pre-existing untracked `code-review/` dir holding another reviewer's file). No
zz-review test file was needed or created.

| Id | Mutation | Ran | Result |
|---|---|---|---|
| M1 | public.ts:491 - add the 60/min limiter at ROUTER level (every /public request counts against it) | PI + router test | KILLED by PI:755 (the exhausted list limit then blocks POST /housing-fair: 429 for 400) |
| M2 | IntakeForm.tsx:100 - remove `if (submitBlocked) return;` | IntakeForm.props + HFI + HFI.recovery | SURVIVED (3 files green) - see R1-C3 |
| M3 | HousingFairIntake.tsx:109 - drop the aborted-signal check on the rejection path | HFI + HFI.recovery + HFI.another | KILLED by HousingFairIntake.test.tsx:334 (StrictMode) |
| M4 | HousingFairIntake.tsx:151 - re-read the list on every "Sign up another person" | HFI.another | KILLED by HousingFairIntake.another.test.tsx:93, :130, :163 |
| M5 | public.ts:293 - run the D3 list check for NEW phones only | PI | KILLED by PI:891 |
| M6 | backfill:497 - drop the `{ attr: 'type', value: 'tenant' }` guard | bf-test (DynamoDB Local, not skipped) | KILLED by bf-test:849 (exact update args) and :910 (c-mid written instead of skipped) |
| M7 | backfill:452 - read ONE audit page only | bf-test | KILLED by bf-test:574 and :669 (null instead of authority_history) |
| M8 | IntakeForm.tsx:133 - map a 429 to the /join copy with no parent errorMessage | FlyerPage + IntakeForm.props | KILLED by FlyerPage.test.tsx:343 and IntakeForm.props.test.tsx:45 |
| M9 | HousingFairIntake.tsx:172 - "Choose one" no longer blocks send | HFI.recovery | KILLED by HousingFairIntake.recovery.test.tsx:90, :143 |

Not mutation-checked (no doubt that a cited test fails): the D1 kind filter, the sort
tie-break, Cache-Control, the D3 exact match and agency refusal, the D5 status and
marker expressions, the D7 payload and log key, the D8 timeout constant, and the
remaining backfill guards and refusals - each is pinned by an exact-value assertion
cited in the tables. The e2e specs were not mutated (no suite runs allowed); their
GREEN is taken from the run1 gate log.

## A. Spec section 3 decisions

| Item | Grade | impl | test (would FAIL on regression) |
|---|---|---|---|
| D1 GET /public/housing-authorities -> 200 { names }: exact stored name of every housing_authority entry | CONFORMS | app/src/routes/public.ts:492-499; app/src/services/publicOrgList.ts:41-50 (KINDS_FOR_FIELD.housingAuthority = ['housing_authority'], app/src/lib/orgNames.ts:30) | PI:684, PI:693; app/test/publicHousingAuthoritiesRouter.test.ts:46; app/test/publicOrgList.test.ts:53 |
| D1 sorted case-insensitively (English collation), no duplicates | CONFORMS | publicOrgList.ts:43-49 (Set; localeCompare 'en' base, code-unit tie-break) | publicOrgList.test.ts:53, :64, :75; PI:693 |
| D1 no ids, spellings, notes, audit fields or agencies | CONFORMS | publicOrgList.ts:44-46 (names only) | PI:693 (serialized-body leak check incl. spelling/notes/agency/createdBy) |
| D1 peek(), else buildStartingEntries in memory; never writes | CONFORMS | publicOrgList.ts:24-31 | publicOrgList.test.ts:97, :104 (get/mutate/putForSeed spies, store still empty); PI:684, PI:693 |
| D1 any read failure = generic 500 | CONFORMS | public.ts:497 (rejection reaches the Express 5 error handler) | PI:723 (body `internal server error`); router test :62 |
| D1 Cache-Control: no-store | CONFORMS | public.ts:496 | PI:684; router test :46; e2e/tests/dashboard-next/public-pages.spec.ts:438 |
| D2 own fixed-window per-IP limit 60/60 s, hard-coded, no env var | CONFORMS | publicOrgList.ts:18; public.ts:494 (createRateLimit default keyOf clientIpOf, app/src/middleware/rateLimit.ts:84) | publicOrgList.test.ts:46; router test :70; PI:755 |
| D2 a second router, app.use('/public') immediately BEFORE the existing mount, GET only, limiter on that route alone | CONFORMS | app/src/app.ts:178-184 (the shared mount follows at :185); public.ts:488-501 | router test :55; PI:776 (other methods fall through to the shared limiter); PI:755 (an exhausted list limiter blocks no other route - see M1) |
| D2 the list read never consumes, and is never blocked by, the shared 5/min limit | CONFORMS | as above | PI:738 (shared exhausted, list readable, shared window untouched); PI:755 (61 list reads leave both shared slots) |
| D2 no new prefix: edge guard and CloudFront unchanged | CONFORMS | app.ts:178-184 under '/public' | app/test/cloudfrontBehaviors.test.ts:137-149 (`app\.use\(\s*'` matches the multi-line mount); unchanged, green in run1-test |
| D2 precision note: OPTIONS answered by Express (200 Allow: GET, HEAD), passes neither limiter | CONFORMS (untested; no task, AR-4) | Express default | none (none required) |
| D3 optional housingAuthority; absent or null = none | CONFORMS | public.ts:174-181 | PI:979, PI:1023, PI:1210 (absent and null) |
| D3 shape: string of 1-120 chars after the body trim, else generic 400 (checked while parsing) | CONFORMS | public.ts:175-179 (ORG_NAME_MAX) | PI:798 (42, true, array, object, '', '   ', 121 chars); PI:867 ('A' x 120 passes the shape, boundary); PI:1057 |
| D3 list check before any write, new and existing phone alike | CONFORMS | public.ts:293-299 (before the unit read :310 and findByPhone :321) | PI:867; PI:891 (existing phone: no thread, welcome, audit or change - see M5) |
| D3 reads the list ONLY when an authority is sent | CONFORMS | public.ts:293 | PI:979 (PIN, peek never called); PI:944 (exactly one peek) |
| D3 exact name of a housing_authority entry; no case, spelling or agency resolution | CONFORMS | public.ts:295 (isOnListFor, never resolveOrgText) | PI:867 (unlisted, spelling 'AHA', lower case, agency 'Step Up'); PI:916 (stored list governs) |
| D3 refusal `400 { error: 'housing_authority_not_listed' }` | CONFORMS | public.ts:296; publicOrgList.ts:21 | PI:867, PI:891, PI:916 |
| D3 list read failure = generic 500 | CONFORMS | public.ts:294 (propagates) | PI:965 (nothing written) |
| D4 unitId (present, non-null) + housingAuthority (present, non-null) -> generic 400 whatever the unit's state; keyed on presence | CONFORMS | public.ts:187-189 (in the parser, before getById) | PI:822 (shareable, missing, non-shareable identical; getById never called); PI:1042 and PI:1113 (null on either side is not a refusal) |
| D5 EVERY new contact (/join and flyer) carries housing_fair_signup_v2: true | CONFORMS | public.ts:361 | PI:30, PI:998, PI:1023, PI:1069, PI:1089, PI:1113; e2e public-pages.spec.ts:496-513 (real repo + API projection) |
| D5 new contact from a request with NO unitId starts `onboarding` | CONFORMS | public.ts:339 | PI:30, PI:998, PI:1023, PI:1042; e2e public-pages.spec.ts:501, :511; e2e/tests/scenarios/tenant-onboarding.spec.ts:200 |
| D5 ... and holds the given housingAuthority, if any | CONFORMS | public.ts:347 | PI:998, PI:1042, PI:1057; e2e public-pages.spec.ts:502, :512 |
| D5 a request WITH a unitId: needs_review, no authority, also for a missing / unshareable unit stamped housing_fair | CONFORMS | public.ts:339, :347 | PI:1069, PI:1089, PI:1113 |
| D5 capture_source, consent fields and welcome text unchanged | CONFORMS | public.ts:349-370 (untouched) | PI:30, PI:998 (welcome body), PI:1069 |
| D6 existing phone: no housingAuthority, status or marker write; today's welcome rule unchanged | CONFORMS | public.ts:318-323 (existing branch untouched; the new fields are create-only) | PI:1126 (PIN, contact toEqual before), PI:1151 (PIN, only the welcome flag), PI:1264 |
| D7 every housing_fair_signup event: signupVersion 2 + housingAuthority (the requested name, else null), existing contact too | CONFORMS | public.ts:417-424 | PI:1180, PI:1210, PI:1243, PI:1264 (exact payload toEqual) |
| D7 log line gains boolean withAuthority; no new PII | CONFORMS | public.ts:428-437 | PI:1180 (name absent from the line), PI:1210, PI:1243, PI:1264 |
| D8 select "Housing authority" + help text, after "Voucher size", before the consent box; options = D1 order then "Not sure" | CONFORMS | HousingAuthoritySelect.tsx:21-22, :63-75, :100-127; IntakeForm.tsx:256 | HousingAuthoritySelect.test.tsx:32; HousingFairIntake.test.tsx:188, :199; IntakeForm.props.test.tsx:74; e2e public-pages.spec.ts:455-462 |
| D8 default: Atlanta Housing Authority when that exact name is listed, else "Not sure" | CONFORMS | HousingAuthoritySelect.tsx:29, :46-48; HousingFairIntake.tsx:106 | HousingFairIntake.test.tsx:188, :209, :244; HousingAuthoritySelect.test.tsx:96; e2e public-pages.spec.ts:458 |
| D8 while loading: select disabled showing "Loading...", submit disabled; the read gives up after 10 s | CONFORMS | HousingAuthoritySelect.tsx:64-66, :109; HousingFairIntake.tsx:51, :94-100, :172; IntakeForm.tsx:100, :289 | HousingFairIntake.test.tsx:257, :291 (fake timers 9 999 + 1 ms; signal aborted) |
| D8 failed or timed out (any error, 429 included): only "Not sure", a note, sign-up works with no authority | CONFORMS | HousingAuthoritySelect.tsx:67-69, :121-125, :53-56; HousingFairIntake.tsx:107-113 | HousingFairIntake.test.tsx:269 (429), :291; HousingAuthoritySelect.test.tsx:59 |
| D8 "Not sure" sends no housingAuthority; any other choice sends the exact name; HousingFairInput + submitHousingFair gain the field | CONFORMS | dashboard/src/routes/public/publicApi.ts:66-69, :99; HousingFairIntake.tsx:131-134 | publicApi.test.ts:37, :47; HousingFairIntake.test.tsx:209, :220, :232 |
| D8 housing_authority_not_listed: re-read; keep every typed field + consent; pick NO value ("Choose one" ahead of names and "Not sure"); send blocked until a choice; exact message; a failed re-read = the failed state | CONFORMS | HousingFairIntake.tsx:53, :61, :106, :135-143, :172; HousingAuthoritySelect.tsx:71 | HousingFairIntake.recovery.test.tsx:90 (Atlanta still listed but NOT picked), :143, :164 |
| D8 429 on the sign-up: the 429 message; every other failure keeps today's message | CONFORMS | HousingFairIntake.tsx:54-64; IntakeForm.tsx:133 | HousingFairIntake.recovery.test.tsx:192, :212 (500, network, 400) |
| D8 flyer: no select, never sends housingAuthority, messages exactly as today; IntakeForm renders the select/messages only when the parent supplies them | CONFORMS | FlyerPage.tsx unchanged; IntakeForm.tsx:43-49, :133 | FlyerPage.test.tsx:343; IntakeForm.props.test.tsx:29, :45 |
| D9 thank-you keeps its heading and text and adds "Sign up another person" | CONFORMS | HousingFairIntake.tsx:156-169 | HousingFairIntake.another.test.tsx:79; HousingFairIntake.test.tsx:115 (PIN) |
| D9 returns an EMPTY form (names, phone, voucher blank, consent unchecked), select kept on the previous choice, focus to First name | CONFORMS | HousingFairIntake.tsx:148-154, :181, :189; IntakeForm.tsx:64-67 | HousingFairIntake.another.test.tsx:93, :130, :180 (PIN: first visit does not move focus); e2e public-pages.spec.ts:474-491 (DeKalb kept, not reset to the default) |
| D9 the list is not read again unless the last read failed; then it is read again and the default rule applies | CONFORMS | HousingFairIntake.tsx:151 | HousingFairIntake.another.test.tsx:93, :143, :163 (StrictMode); e2e public-pages.spec.ts:522 |
| D10 the script, following clean-org-names + stageClient | CONFORMS | backfill:48-70, :671-713 | bf-test:1193-1388 |
| D10 --env local|dev|prod, --lane local only, dry run default, --apply, --skip list; unknown or repeated args = exit 2, nothing run | CONFORMS | backfill:634-650, :678-683 (app/scripts/lib/stageClient.ts:186-212) | bf-test:1159, :1183, :1194 (resolveStage never called), :1376 (child process) |
| D10 the list: stored item via peek(), never created; refuse (exit 1, nothing written) on no item / Atlanta not an exact HA name / --apply while a rewrite runs by isOrgRewriteRunning (stale = free); never takes the lock | CONFORMS | backfill:335-359 | bf-test:524, :529 (dry run refuses too), :547 (renamed, case, agency, spelling-only, deleted), :555, :563 (stale, done, failed), :1074 (one GetCommand, nothing written), :1104 (lastRewrite unchanged), :1287, :1356 |
| D10 candidates: base table, pointer rows skipped, capture_source housing_fair, tenant, not deleted, no housingAuthority attribute, no marker; status not a condition | CONFORMS | backfill:104-112, :415-429 | bf-test:173, :182 (one condition each, marker of any value), :598 (DynamoDB Local, pointer rows, order) |
| D10 left out: --skip | CONFORMS | backfill:465 (before any history read) | bf-test:579, :817, :849 |
| D10 left out: a housing_fair_signup event with signupVersion 2 (printed reason "signed up again after the change") | CONFORMS | backfill:154-158, :214 | bf-test:216 (number 2 only), :652, :817 |
| D10 left out: housingAuthority ever SET or REMOVED, per the six enumerated event types | CONFORMS | backfill:127-145 (shapes verified against routes/contacts.ts:1950, services/caseworkerConversion.ts:426, services/extraction/apply.ts:505, services/suggestionResolution.ts, services/orgRecords.ts:620, scripts/clean-org-names.ts:734) | bf-test:205 (all six types incl. the caseworker conversion), :212, :231, :652 (through the store) |
| D10 whole history: page backward with `before` = oldest ts until an empty page | CONFORMS | backfill:437-454 | bf-test:669 (an event on the oldest page counts; the `before` sequence pinned), :574 |
| D10 an unknown --skip id is reported, otherwise ignored | CONFORMS | backfill:571, :263-265 | bf-test:817 |
| D10 dry run writes nothing; prints name, sign-up date (captured_at else created_at), status, contactId, oldest first, then the count, then the left-out leads with the reason; names never in log lines | CONFORMS | backfill:226-268, :384-403, :593-596 | bf-test:273, :817 (only Scan/Query/Get sent, one list read, three tables unchanged), :966 (no name in any log line) |
| D10 apply: ONE contactsRepo.update with expect housingAuthority null + type tenant + notDeleted; one housing_authority_backfill event {field, from:'', to}, no actor; lost condition = skipped; status and every other field left alone | CONFORMS | backfill:489-523 | bf-test:849 (the exact update args, c-old toEqual before + authority, payload, no actorId), :910 (each guard on its own - see M6) |
| D10 after an apply, read the list again; warn when Atlanta is no longer an exact HA name | DEVIATES (harmless, plan-copied; R1-C2) | backfill:530-549, :601 (only when written > 0) | bf-test:1029, :1054 |
| D10 safe to re-run, either order around the deploy | CONFORMS | candidate + left-out rules above | bf-test:849 (a re-run writes nothing new) |
| D10 exit codes 0 / 1 (refused, failures, target unresolved) / 2 usage | CONFORMS | backfill:271-273, :671-713 | bf-test:340, :1194, :1219, :1268, :1287, :1338-1373, :1376 |
| D10 no agent runs it against dev or prod; tests write pre-change leads directly | CONFORMS, with R1-C1 | bf-test seeds leads directly (:461) | the child-process case spawns the real CLI with `--env dev --bogus` (bf-test:1380) - safe only because parsing refuses first; see R1-C1 |
| D11 RUNBOOK entry: owed dev + prod after deploy; dry run, read the list, --skip, apply, dev before prod; no Terraform / secrets / schema / index | CONFORMS | RUNBOOK.md:450-487 | docs (no test) |

## B. Spec section 6 test bullets

| Bullet | Grade | test |
|---|---|---|
| App: /join + listed authority -> onboarding tenant holding it + marker; no authority -> onboarding + marker, no authority | CONFORMS | PI:998, PI:1023, PI:30 |
| App: padded text trimmed by the middleware and accepted | CONFORMS | PI:1057 |
| App: unlisted / spelling / other case / agency -> not_listed, nothing written; non-string / empty / over-long -> generic 400 | CONFORMS | PI:867, PI:798 |
| App: unitId + authority -> generic 400 for a shareable, a missing and a non-shareable unit | CONFORMS | PI:822 |
| App: flyer sign-up without an authority behaves as today except the marker | CONFORMS | PI:1069, PI:1089, PI:1113, PI:1243 |
| App: existing phone + valid authority changes no field; audit records the answer with signupVersion 2 | CONFORMS | PI:1126, PI:1151, PI:1264 |
| App: list read names only, sorted, never writes; limit independent both directions; edge guard passes | CONFORMS | PI:684, :693, :738, :755, :776; router test :46-92; publicOrgList.test.ts; cloudfrontBehaviors.test.ts (run1-test exit 0) |
| App backfill: candidate selection, each condition incl. the marker | CONFORMS | bf-test:182, :598 |
| App backfill: post-change re-sign-up exclusion | CONFORMS | bf-test:216, :652, :817 |
| App backfill: left-out audit-history rule for each enumerated event type | CONFORMS | bf-test:205, :652 |
| App backfill: --skip | CONFORMS | bf-test:579, :817, :849 |
| App backfill: dry run writes nothing | CONFORMS | bf-test:817 |
| App backfill: apply writes only where every condition still holds, one audit event each | CONFORMS | bf-test:849 |
| App backfill: a contact changed between read and write is skipped | CONFORMS | bf-test:910 |
| App backfill: each refusal, the stale-lock case included | CONFORMS | bf-test:529, :547, :555, :563, :1074, :1104 |
| App backfill: the post-apply rename warning | CONFORMS | bf-test:1029 |
| App backfill: a re-run writes nothing new | CONFORMS | bf-test:849 |
| Dashboard: /join preselects Atlanta Housing Authority | CONFORMS | HousingFairIntake.test.tsx:188 |
| Dashboard: "Not sure" sends no authority | CONFORMS | HousingFairIntake.test.tsx:232 |
| Dashboard: loading, timeout and failed-list states | CONFORMS | HousingFairIntake.test.tsx:257, :291, :269 |
| Dashboard: not_listed recovery keeps the typed fields, picks no value, blocks send until a choice | CONFORMS | HousingFairIntake.recovery.test.tsx:90, :143, :164 |
| Dashboard: the 429 message | CONFORMS | HousingFairIntake.recovery.test.tsx:192 |
| Dashboard: "Sign up another person" clears the person fields and consent, keeps the authority, re-reads a failed list | CONFORMS | HousingFairIntake.another.test.tsx:93, :130, :143 |
| Dashboard: the flyer form renders no select and keeps its messages | CONFORMS | FlyerPage.test.tsx:343; IntakeForm.props.test.tsx:29, :45 |
| E2E: /join shows Atlanta preselected; two sign-ups in a row via "Sign up another person"; each new contact holds its authority and status Onboarding, read through the authenticated API | CONFORMS | e2e/tests/dashboard-next/public-pages.spec.ts:430-523 (passed in the run1 gate: "ok 174") |

## C. Spec section 7 "places the build must also update"

| Place | Grade | where |
|---|---|---|
| publicApi.ts: HousingFairInput, submitHousingFair, a list-read function | CONFORMS | dashboard/src/routes/public/publicApi.ts:66-69, :99, :121-128 |
| public.ts route header | CONFORMS | app/src/routes/public.ts:13-33 |
| public.ts create comment | CONFORMS | app/src/routes/public.ts:328-337 |
| e2e/scenarios/steps.ts, the housing-fair step's description | CONFORMS | the needs_review claim lived in `openSelfServedContact`'s docblock, not in `tenantSelfServes` (plan S5 cross-slice note 4); fixed at e2e/scenarios/steps.ts:980-981; `tenantSelfServes` also takes housingAuthority (:574-576) |
| tenant-onboarding.spec.ts, the "no housing authority field" note | CONFORMS | e2e/tests/scenarios/tenant-onboarding.spec.ts:182-191 (note rewritten; the scenario now sends and verifies the authority and the Onboarding start, :200, :205) |
| documentation/STATUS-MODEL.md, the Needs review section | CONFORMS | documentation/STATUS-MODEL.md:161-166 (see R1-C5 for :194) |
| documentation/sequence-diagram-to-test.md, the self-serve portal note | CONFORMS | documentation/sequence-diagram-to-test.md:108-114 |
| app/test/publicIntake.test.ts, the existing needs_review assertion | CONFORMS | PI:30-52 |
| e2e/performance/templates.ts, if a measured page requests the GET | CONFORMS (condition not met) | /join is excluded from the measured registry (e2e/performance/routes.ts:118); AR-3; Task 5.3 ran the inventory tests (unit4 report) |
| RUNBOOK.md, the D11 entry | CONFORMS | RUNBOOK.md:450-487 |

## D. Plan tasks 1.1-5.3

| Task | Commit | Grade | impl | proving test |
|---|---|---|---|---|
| 1.1 publicOrgList (peek + starting-list fallback, never writes) | 96fcef2d | CONFORMS | app/src/services/publicOrgList.ts:18-50 | app/test/publicOrgList.test.ts:45-130 |
| 1.2 list router, own 60/min limiter | 5540ab1c | CONFORMS | app/src/routes/public.ts:465-501 | app/test/publicHousingAuthoritiesRouter.test.ts:45-93 |
| 1.3 mount BEFORE the shared /public mount; harness wiring (AR-1); edge guard green | bab94cc0 | CONFORMS | app/src/app.ts:32-36, :169-184; app/test/helpers/twilioWebhookHarness.ts:5436-5440 | PI:653-791; cloudfrontBehaviors.test.ts:137 |
| 2.1 housingAuthority shape + unitId refusal | 3d2a0633 | CONFORMS | public.ts:169-190 | PI:798, PI:822 |
| 2.2 exact-list check, housing_authority_not_listed | 6b4bb4e4 | CONFORMS | public.ts:284-299 | PI:849-991 |
| 2.3 onboarding for no-unitId creates, the marker on every new contact, stale comments | 7936881b | CONFORMS | public.ts:13-24, :328-361 | PI:30, PI:993-1173 |
| 2.4 audit signupVersion 2 + requested name; withAuthority | a4212c0e | CONFORMS | public.ts:410-437 | PI:1175-1293 |
| 3.1 publicApi | daf0d211 | CONFORMS | publicApi.ts:12, :66-69, :99-128 | publicApi.test.ts:36-104 |
| 3.2 IntakeForm optional props (flyer unchanged) | 5914d349 | CONFORMS | IntakeForm.tsx:20-67, :100, :133, :182, :256, :289 | IntakeForm.props.test.tsx:28-144; FlyerPage.test.tsx:343 |
| 3.3 HousingAuthoritySelect | 411b100d | CONFORMS | HousingAuthoritySelect.tsx:1-128 | HousingAuthoritySelect.test.tsx:31-122 |
| 3.4 /join list read: default, loading, 10 s timeout, failed, StrictMode, abort on unmount | 2b5cbe92 | CONFORMS | HousingFairIntake.tsx:75-126, :172-190 | HousingFairIntake.test.tsx:187-379 |
| 3.5 not-listed recovery + 429 copy | d5ad3ea0 | CONFORMS | HousingFairIntake.tsx:53-64, :128-146 | HousingFairIntake.recovery.test.tsx:89-230 |
| 3.6 Sign up another person | 30248100 | CONFORMS | HousingFairIntake.tsx:148-169 | HousingFairIntake.another.test.tsx:78-184 |
| 4.1 candidate + audit-history rules | e5df123c | CONFORMS | backfill:76-160 | bf-test:165-240 |
| 4.2 operator report + exit code | 1bb3a8c0 | CONFORMS | backfill:166-273 | bf-test:272-346 |
| 4.3 reads: list refusals, candidate Scan, whole-history paging | 59cf393c | CONFORMS | backfill:279-468 | bf-test:501-705 |
| 4.4 run: dry run, guarded apply, audit events, post-apply warning | 59bab925 | CONFORMS | backfill:474-627 | bf-test:817-1114 |
| 4.5 CLI main with executed exit codes | 58dd1734 | CONFORMS (see R1-C1) | backfill:629-727 | bf-test:1158-1388 |
| 4.6 RUNBOOK entry | 74080f5e | CONFORMS | RUNBOOK.md:450-487 (S4-F2 cost wording at :485) | docs |
| 5.1 /join e2e: two sign-ups, Onboarding + authority + marker | 6f8ca2d1 | CONFORMS | e2e/tests/dashboard-next/public-pages.spec.ts:36-40, :55-59, :168-198, :430-523; e2e/support/selectors.md:44-46 | itself (gate run1: ok 174) |
| 5.2 self-serve scenario sends the authority, checks Onboarding | 1e2aa7fc | CONFORMS | e2e/scenarios/steps.ts:574-576, :972-981; e2e/tests/scenarios/tenant-onboarding.spec.ts:182-207 | itself (unit4: RED by mutation, then GREEN) |
| 5.3 stale docs, launcher note, perf inventory check | 8cb22537 | CONFORMS | documentation/STATUS-MODEL.md:7, :161-166; documentation/sequence-diagram-to-test.md:108-114; scripts/e2e-session.mjs:143-150 | n/a (docs); perf inventory tests per unit4 |

## E. Counts

| Section | Rows | CONFORMS | PARTIAL | MISSING | DEVIATES |
|---|---|---|---|---|---|
| A. Decisions D1-D11 (each bullet / sub-bullet) | 54 | 53 | 0 | 0 | 1 (R1-C2, harmless) |
| B. Spec section 6 test bullets | 25 | 25 | 0 | 0 | 0 |
| C. Spec section 7 places | 10 | 10 | 0 | 0 | 0 |
| D. Plan tasks 1.1-5.3 | 22 | 22 | 0 | 0 | 0 |
| Total | 111 | 110 | 0 | 0 | 1 |

Notes on CONFORMS rows that carry a qualifier: D2 OPTIONS (untested, no task - AR-4);
D10 "no agent runs it against dev or prod" and Task 4.5 (R1-C1); section 7 perf
templates (the condition is not met). Copy strings: 10 of 10 exact. Mutations: 9 run,
8 killed, 1 survived (M2, R1-C3).

Spec points the plan got wrong and the build copied: one - the D10 post-apply re-read
is narrowed to an apply that wrote (R1-C2); there the spec wording is the imprecise
side. One spec POINTER was wrong and the plan corrected it rather than copying it:
section 7 names the steps.ts housing-fair step, but the needs_review statement lived in
openSelfServedContact (plan S5 cross-slice note 4; fixed at steps.ts:980-981). No spec
decision looks wrong.

## F. Findings

| Id | Severity | file:line | One line |
|---|---|---|---|
| R1-C1 | LOW | app/test/backfillJoinHousingAuthority.test.ts:1380 | The child-process test spawns the real CLI with `--env dev --bogus`; only the parser refusing first keeps npm test from a real dev dry run |
| R1-C2 | INFO | app/scripts/backfill-join-housing-authority.ts:601 | Post-apply list re-read only after an apply that wrote (plan narrowing of D10); harmless |
| R1-C3 | INFO | dashboard/src/routes/public/IntakeForm.tsx:100 | The submitBlocked submit guard survives deletion (M2); its Enter-key test proves only the disabled button |
| R1-C4 | INFO | app/src/routes/public.ts:209-214 | Comment says both routers share "the SAME repo"; true only when injected |
| R1-C5 | INFO | (several) | Scope beyond the spec, none contradicting it (select disabled while sending, invalid_response, empty --skip id, audit-append warning, selectors and launcher notes) |
| R1-C6 | INFO | documentation/STATUS-MODEL.md:194 | The Landlord section still implies every tenant lands at Needs review |
| R1-C7 | INFO | e2e gate run1 | run1 e2e exit=1: landlord-onboarding.spec.ts:190 Unknown-tab step failed; not a surface this branch changes; orchestrator to adjudicate |

No HIGH or MEDIUM finding. Nothing the spec asks for is missing.

### R1-C1 - LOW - app/test/backfillJoinHousingAuthority.test.ts:1380

- What: the child-process entry-point test spawns the REAL CLI with
  `--env dev --bogus`. It exits 2 today only because `parseStageArgs` refuses the
  unknown `--bogus` before `main` resolves a target
  (app/scripts/backfill-join-housing-authority.ts:678-683,
  app/scripts/lib/stageClient.ts:203).
- Evidence: the test's safety rests entirely on that refusal ordering. If argument
  parsing ever tolerated unknown flags, every `npm test` would run a real `--env dev`
  dry run from the test suite: the account guard on the `housingchoice` profile, then
  a consistent Scan of dev contacts plus per-lead audit Queries. Read-only, but
  exactly the "an agent runs it against dev" that spec D10 (last bullet) forbids. The
  unit3 report raised the same point and left it to review.
- Suggested fix: use an argv that cannot name a deployed target even if parsing
  loosens - `['--bogus']` (no `--env` is itself a usage error) or
  `['--env', 'local', '--lane', '99', '--bogus']` - and keep the exit-2 and stderr
  usage-text assertions.

### R1-C2 - INFO - app/scripts/backfill-join-housing-authority.ts:601

- What: spec D10 says "After an apply, the run reads the list again"; the build
  re-reads only after an apply that WROTE (`opts.apply && report.written > 0`). The
  narrowing is the plan's (Task 4.4 text, plan lines 5078, 6646, 6721), copied
  faithfully.
- Evidence: with nothing written there is no record to strand under "Not on the
  list", so the warning would carry no meaning. Harmless; arguably the better rule.
- Suggested fix: none in code. Accept it, and when the spec is next touched say "after
  an apply that wrote". Recorded so the deviation is not silent.

### R1-C3 - INFO - dashboard/src/routes/public/IntakeForm.tsx:100 (test: IntakeForm.props.test.tsx:94)

- What: the `if (submitBlocked) return;` guard in IntakeForm's submit handler is not
  proven by any test.
- Evidence: mutation M2 removed it; IntakeForm.props.test.tsx,
  HousingFairIntake.test.tsx and HousingFairIntake.recovery.test.tsx all stayed green.
  The props test's "an Enter in a field sends nothing" passes because jsdom/user-event,
  like browsers (HTML implicit submission), never submits a form whose default button
  is disabled. The spec requirement ("send stays blocked") is met and tested through
  the disabled button; the guard is redundant defense whose claimed coverage is not
  real.
- Suggested fix: add one assertion that submits the form directly while blocked
  (`fireEvent.submit(form)` with `submitBlocked`) and expects `onSubmit` not called -
  or drop the Enter-key claim from the test name.

### R1-C4 - INFO - app/src/routes/public.ts:209-214

- What: the `PublicRouterDeps.orgListRepo` doc comment says app.ts hands "the SAME
  repo" to `createPublicHousingAuthoritiesRouter`.
- Evidence: true only when a repo is injected (the test harness). In production
  app.ts:181 passes none and each router builds its own `createOrgListRepo`
  (public.ts:234 and :490). Both are stateless `peek()` readers with no cache, so
  behavior is identical; only the wording overstates it (also unit1 remark 1).
- Suggested fix: "the same repo when one is injected; otherwise each builds the
  default".

### R1-C5 - INFO - scope beyond the spec (no contradiction; listed so none is silent)

- dashboard/src/routes/public/HousingFairIntake.tsx:185 - the select is disabled while
  a sign-up is sending (test HousingFairIntake.test.tsx:364). Not asked; harmless.
- dashboard/src/routes/public/publicApi.ts:121-128 - a malformed list body is
  `ApiError(0, 'invalid_response')`, so it lands in the D8 failed state (AR-2).
- app/scripts/backfill-join-housing-authority.ts:640-644 - an empty id in `--skip` (an
  empty value, a stray comma) is a usage error: stricter than the spec's "unknown or
  repeated arguments". Reasonable.
- app/scripts/backfill-join-housing-authority.ts:513-520 - a
  `housing_authority_backfill` append that fails after the write landed is a WARNING
  and exit 0. The spec's exit-code list does not name this case. Consequence: that
  lead now holds an authority (no longer a candidate), so the missing event cannot
  cause a re-write; only its audit trail is short. Acceptable, but a conscious call.
- e2e/support/selectors.md:44-46 (also replaces a stale pre-existing "Thanks, we'll
  text you!" success row) and scripts/e2e-session.mjs:143-150 (the list-limit note) -
  plan Tasks 5.1 and 5.3, not spec section 7. Accurate.
- documentation/STATUS-MODEL.md:7 - "Last substantive update" bumped to 2026-10-12.

### R1-C6 - INFO - documentation/STATUS-MODEL.md:194

- What: the Landlord section still calls Needs review "the auto-capture/triage front
  door (same front door tenants and untriaged contacts land at)".
- Evidence: spec section 7 names only the Needs review section (fixed at :161-166), and
  the phrase is not false for auto-captured tenants, but after this change a reader
  can take it as "every tenant". The unit4 report noted it too.
- Suggested fix (optional): "same front door auto-captured tenants and untriaged
  contacts land at".

### R1-C7 - INFO - gate observation, outside this review's grading

- run1-e2e.exit is `exit=1 dur=1314s`: 339 passed, 1 failed -
  `tests/scenarios/landlord-onboarding.spec.ts:190` "inbound text -> not a fit ->
  parked (reason)", step "App relays the lead to Team (Unknown tab, by phone)"
  (e2e/scenarios/steps.ts:627: the Unknown-tab link for the lead's phone was not
  visible within 15 s). The Unknown tab lists `type=unknown` contacts; this branch
  changes tenant sign-ups only, and the new /join case (`ok 174`) and the self-serve
  scenario (`ok 327`) passed. Not attributed here; the orchestrator owns adjudication
  (re-run that file alone, compare at the merge base). Per AGENTS.md a named-spec
  failure is a regression to diagnose, not a flake to excuse.

