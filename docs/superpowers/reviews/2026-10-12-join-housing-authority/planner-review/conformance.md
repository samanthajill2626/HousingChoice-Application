# join-housing-authority - spec-conformance review (planner)

- Contract: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md` (rev 4)
- Code reviewed: `git diff main...15c1676f -- . ":!docs/superpowers"` (35 files). The worktree
  HEAD (7d5e36c6) carries no code change after 15c1676f (`git diff --stat 15c1676f HEAD`
  outside `docs/superpowers` is empty), so every `file:line` below is valid at both.
- Method: I read the code, not the commit messages or the mission's reports. I ran nothing:
  no tests, scripts, e2e, database or network. Test evidence below means that a test exists
  and asserts the behavior. Whether it passes comes from the mission's own gate record,
  which this review did not re-run.

## Verdict counts

63 rows: **62 CONFORMS, 1 DEVIATES (immaterial), 0 MISSING.** Nothing is blocking. The
findings are LOW: one immaterial narrowing, and scope additions that are all harmless.

## Table

### Decisions D1-D11

| # | Spec item | Verdict | Code | Test |
|---|---|---|---|---|
| 1 | D1 list read: `200 { names }`, exact stored names of `housing_authority` entries only, case-insensitive en collation, deduped, no ids/spellings/notes/audit/agencies; `peek()` else the starting list in memory, never writes; read failure = generic 500; `Cache-Control: no-store` | CONFORMS | `app/src/services/publicOrgList.ts:24-31` (peek, else `buildStartingEntries`), `:41-50` (KINDS_FOR_FIELD.housingAuthority = `['housing_authority']` per `app/src/lib/orgNames.ts:30`; Set dedupe; `localeCompare('en',{sensitivity:'base'})` + code-unit tiebreak); `app/src/routes/public.ts:491-505` (no-store, `{ names }`; Express 5 forwards the async throw to the generic 500) | `app/test/publicIntake.test.ts:684` (empty store: starting names, no-store, `peek()` still null), `:693` (stored list, no leak, `get`/`mutate`/`putForSeed` never called), `:723` (500); `app/test/publicOrgList.test.ts:53,64,75,104,120`; `app/test/publicHousingAuthoritiesRouter.test.ts:46,62` |
| 2 | D2: own fixed-window per-IP limit 60/60s, hard-coded, no env var; second router `app.use('/public', ...)` IMMEDIATELY before the shared mount, limiter on that route alone; everything else falls through to the shared 5/min limiter; no new prefix | CONFORMS | `app/src/services/publicOrgList.ts:18`; `app/src/app.ts:178-184` (directly before the shared mount at `:185-201`); `app/src/routes/public.ts:495-498` (limiter on the GET route only, default client-IP key like the shared limiter) | `app/test/publicIntake.test.ts:738` (shared exhausted, list still 200, shared window untouched), `:755` (60 ok, 61st 429, shared slots intact), `:776` (another method falls through to the shared limiter); `app/test/publicHousingAuthoritiesRouter.test.ts:55,70,83`; edge guard `app/test/cloudfrontBehaviors.test.ts:137-147` (unchanged; its `app\.use\(\s*'` regex matches the multi-line mount, prefix `/public` already classified) |
| 3 | D3 shape: optional `housingAuthority`; absent/null = none; string of 1-120 chars (ORG_NAME_MAX) after the body trim, parsed with the other fields, else generic `400 invalid request` | CONFORMS | `app/src/routes/public.ts:174-181` | `app/test/publicIntake.test.ts:798` (number, boolean, array, object, `''`, blank, 121 chars) |
| 4 | D3 list check: before any write, new and existing phone alike; list read ONLY when an authority is sent; exact name of a `housing_authority` entry (no case/spelling/agency resolution); else `400 housing_authority_not_listed`; read failure = generic 500 | CONFORMS | `app/src/routes/public.ts:296-302` (before the unit read at `:312` and `findByPhone` at `:324`; `isOnListFor` is exact `e.name === value`, `app/src/lib/orgNames.ts:72-78`) | `app/test/publicIntake.test.ts:867` (unlisted, spelling `AHA`, lower case, agency `Step Up`; nothing written; list not created), `:891` (existing phone: nothing changes), `:916` (stored list wins), `:944` (one `peek`, no `get`), `:965` (500, nothing written), `:979` (no list read when absent/null) |
| 5 | D4: `unitId` (present, not null) + `housingAuthority` (present, not null) = generic 400 whatever the unit's state, keyed on presence | CONFORMS | `app/src/routes/public.ts:187-189` (in the parser, before the unit is read; an empty or non-string `unitId` is already the generic 400 at `:158-165`) | `app/test/publicIntake.test.ts:822` (shareable, missing, placed: identical bodies; `unitsRepo.getById` never called) |
| 6 | D5: EVERY new contact gets `housing_fair_signup_v2: true`; a no-`unitId` create starts `onboarding` and holds the given authority; a `unitId` request otherwise as today (`needs_review`, no authority, `housing_fair` for a missing/unshareable unit); capture_source, consent, welcome unchanged | CONFORMS | `app/src/routes/public.ts:340-370` (status at `:342`, authority at `:350`, marker at `:364`, `capture_source` `:355` and consent `:368-370` unchanged) | `app/test/publicIntake.test.ts:998, 1023, 1042, 1069, 1089, 1113` |
| 7 | D6: an existing contact gets no `housingAuthority`, `status` or marker write; welcome rule unchanged | CONFORMS | `app/src/routes/public.ts:327-329` (existing branch writes nothing); the only write to an existing contact stays the welcome flag `:399` | `app/test/publicIntake.test.ts:1126` (already welcomed: contact deep-equal), `:1151` (never welcomed: welcome + flag only) |
| 8 | D7: every `housing_fair_signup` event gains `signupVersion: 2` and `housingAuthority` (the requested name, else null), existing contacts included; the log line gains boolean `withAuthority`; no new PII | CONFORMS | `app/src/routes/public.ts:420-427`, `:431-441` | `app/test/publicIntake.test.ts:1180, 1210, 1243, 1264` |
| 9 | D8 select: label "Housing authority", help "The organization that runs your voucher.", after "Voucher size" and before the consent box; options = D1 names in order, then "Not sure" | CONFORMS (exact copy) | `dashboard/src/routes/public/HousingAuthoritySelect.tsx:21-23, 64-78, 98-127`; slot `dashboard/src/routes/public/IntakeForm.tsx:256` | `HousingFairIntake.test.tsx:188,199`; `HousingAuthoritySelect.test.tsx:32`; `IntakeForm.props.test.tsx:74` |
| 10 | D8 default: "Atlanta Housing Authority" when that exact name is listed, else "Not sure" | CONFORMS | `HousingAuthoritySelect.tsx:29, 46-48`; applied `HousingFairIntake.tsx:106` | `HousingFairIntake.test.tsx:209,244`; `HousingAuthoritySelect.test.tsx:96` |
| 11 | D8 loading: select disabled showing "Loading...", submit disabled | CONFORMS | `HousingAuthoritySelect.tsx:24, 65-67, 109`; `HousingFairIntake.tsx:172`; `IntakeForm.tsx:100, 289` | `HousingFairIntake.test.tsx:257`; `IntakeForm.props.test.tsx:94,112` |
| 12 | D8 failure/timeout: 10 s give-up; any error (429 included) leaves only "Not sure" plus a note that the list could not be loaded; sign-up still works with no authority | CONFORMS | `HousingFairIntake.tsx:51, 95-115`; `HousingAuthoritySelect.tsx:26, 68-70, 120-124`; `publicApi.ts:121-128` | `HousingFairIntake.test.tsx:269,291,324,334`; `publicApi.test.ts:82,89` |
| 13 | D8 send: "Not sure" sends no `housingAuthority`; any other choice sends that exact name; `HousingFairInput` / `submitHousingFair` gain the field | CONFORMS | `HousingAuthoritySelect.tsx:53-56`; `HousingFairIntake.tsx:131-134`; `publicApi.ts:69, 99` | `HousingFairIntake.test.tsx:220,232`; `publicApi.test.ts:37,47`; `HousingAuthoritySelect.test.tsx:106` |
| 14 | D8 not-listed recovery: re-read the list, keep typed fields and the consent box, show "Choose one" ahead of names and "Not sure", send blocked until a choice; exact message; failed re-read = failed state | CONFORMS (exact copy) | `HousingFairIntake.tsx:53, 61, 123-126, 135-142, 172`; `HousingAuthoritySelect.tsx:25, 35, 71`; `IntakeForm.tsx:133` (form not remounted, so fields and consent persist) | `HousingFairIntake.recovery.test.tsx:90,143,164` |
| 15 | D8 429 on the sign-up: "Too many sign-ups from this network in the last minute. Wait a minute, then send again."; every other failure keeps today's message | CONFORMS (exact copy) | `HousingFairIntake.tsx:54-55, 59-64`; `IntakeForm.tsx:133` | `HousingFairIntake.recovery.test.tsx:192,212` |
| 16 | D8 flyer: no select, never sends `housingAuthority`, error copy exactly as today; IntakeForm renders the select/messages only when its parent supplies them | CONFORMS | `FlyerPage.tsx` untouched (`git diff main...15c1676f` empty for it); IntakeForm's new props are optional with no-op defaults (`IntakeForm.tsx:44-49`); `onSubmit` input type omits `housingAuthority` (`:23`) | `FlyerPage.test.tsx:343`; `IntakeForm.props.test.tsx:29,45` |
| 17 | D9: thank-you keeps heading and text, adds "Sign up another person"; empty form (names, phone, voucher blank, consent unchecked); select keeps the previous choice; focus to "First name"; list re-read only if the last read failed (default rule then) | CONFORMS (exact copy) | `HousingFairIntake.tsx:148-171` (heading/text unchanged; `&mdash;` renders the same character as main's literal dash), `:179-189` (`key={round}` remount, `autoFocusFirstName={round > 0}`); `IntakeForm.tsx:64-67, 182` | `HousingFairIntake.test.tsx:115`; `HousingFairIntake.another.test.tsx:79,93,130,143,163,180` |
| 18 | D10 CLI: file name and pattern (clean-org-names + stageClient); `--env local\|dev\|prod`, `--lane` local only, dry run default, `--apply`, `--skip a,b`; unknown or repeated args = exit 2, nothing run | CONFORMS | `app/scripts/backfill-join-housing-authority.ts:667, 673-677, 704-716`; `app/scripts/lib/stageClient.ts:186-212` (repeat at `:196`, unknown at `:203`, lane with non-local at `:208`) | `app/test/backfillJoinHousingAuthority.test.ts:1239,1263,1274,1456` |
| 19 | D10 list: stored item via `peek()` (never created); refuse (exit 1, nothing written) on no item, on AHA not an exact `housing_authority` name, and, for `--apply` only, while `isOrgRewriteRunning` (15-minute stale rule); never takes the lock | CONFORMS | `backfill...ts:368-393` (uses `item.lastRewrite` with `isOrgRewriteRunning`, `app/src/services/orgNames.ts:153-156`); no lock write anywhere in the script | `backfill test:604,609,627,635,643,1154` (refusal sends only one GetCommand; nothing changes), `:1184` (stale lock: apply goes ahead, lock untouched) |
| 20 | D10 candidates: base table, pointer rows skipped; `capture_source === 'housing_fair'`, tenant, not deleted, no `housingAuthority` attribute, no marker; status not a condition | CONFORMS | `backfill...ts:104-112, 395-414` (ConsistentRead Scan), `:448-462` | `backfill test:173,182` (each condition, the marker of any value included), `:678` (through the store, pointer rows skipped, oldest first) |
| 21 | D10 left out with reason: `--skip`; a `housing_fair_signup` with `signupVersion: 2` ("signed up again after the change"); an authority SET or REMOVED per the enumerated event types; whole history paged backward with `before` = oldest `ts` until an empty page; unknown `--skip` id reported, otherwise ignored | CONFORMS | `backfill...ts:127-148` (contact_updated `fields`, ai_extraction_applied `fields[].field`, ai_suggestion_accepted `target`, org_name_rewrite / org_name_cleanup `field`, own `housing_authority_backfill`), `:154-160`, `:212-216` (reason copy exact), `:470-488` (`before` is the full `ts` SK including its uuid suffix, exclusive per `app/src/repos/auditRepo.ts:122-137`, so no same-ms gap), `:493-500`, `:604` | `backfill test:200,205,212,216,231,654,659,732,749,897` |
| 22 | D10 dry run: writes nothing; one line per target (first and last name, sign-up date from `captured_at` else `created_at`, status, contactId), oldest first, then the count; then left-out the same way with the reason; names only in the printed report, never in log lines | CONFORMS | `backfill...ts:263-301, 417-439`; log lines carry contactIds and counts only (`:607-660`) | `backfill test:273,314,330,897` ("NOTHING written, not even the list item"), `:1046` (no name in any log line) |
| 23 | D10 apply: one conditional `contactsRepo.update` with `expect` `[housingAuthority null, type tenant]` + `notDeleted`; one `housing_authority_backfill` event `{ field, from: '', to }`, no actor; a lost condition = skipped, not failed; status and every other field untouched | CONFORMS | `backfill...ts:522-557` (repo semantics: `null` = `attribute_not_exists`, `app/src/repos/contactsRepo.ts:1550-1563`; the update stamps no other attribute) | `backfill test:929` (one guarded write and one event each, nothing else changed), `:990` (each guard loses: skipped) |
| 24 | D10 after an apply: read the list again; warn when AHA is no longer an exact `housing_authority` name | DEVIATES (immaterial) | `backfill...ts:563-585` runs only `if (opts.apply && report.written > 0)` (`:634`). An apply that wrote nothing skips the re-read. The warning is about the records written, so nothing is lost. See F1. | `backfill test:1109,1134` |
| 25 | D10 safe to re-run in any order around the deploy; never touches a contact holding an authority, the marker, a post-change sign-up, or an authority history | CONFORMS | follows from rows 20, 21 and 23 | `backfill test:929` (re-run writes nothing new) |
| 26 | D10 exit codes: 0 clean; 1 refused, completed with failures, or target unresolved; 2 usage | CONFORMS | `backfill...ts:304-306, 704-743` | `backfill test:421,1274,1299,1348,1367,1419,1436,1456` |
| 27 | D10 agent rule: no agent runs it on dev/prod; rehearsal only on a hermetic `--env local --lane <L>` lane with pre-change-shaped leads written directly; no app path or seed creates a candidate | CONFORMS | script header `backfill...ts:35-38`; RUNBOOK.md:488; no seed or app path writes `capture_source: 'housing_fair'` except `public.ts:355` (grep of `app/src`), and that create always carries the marker | rehearsal record exists (`docs/superpowers/reviews/2026-10-12-join-housing-authority/backfill-rehearsal.md`, not re-verified) |
| 28 | D11 RUNBOOK: owed on dev and prod once deployed; dry run, read the list (`--skip` non-Atlanta holders), apply, dev before prod; no Terraform/secrets/schema/index change | CONFORMS | `RUNBOOK.md:450-488` (owed line `:452`, steps 1-5 `:476-484`, "No Terraform, no secrets, no env var, no schema or index change" `:452`) | n/a (doc) |

### Section 4 - consequences (checked against the code; none needs code of its own)

| # | Consequence | Verdict | Evidence |
|---|---|---|---|
| 29 | Authority, not status, decides blast reach today | CONFORMS | `audienceResolution.ts` untouched; the new and backfilled contacts carry the `housingAuthority` attribute it filters on (`public.ts:350`, `backfill...ts:524-527`) |
| 30 | Backfill has no status condition (On hold / Inactive leads get AHA) | CONFORMS | `backfill...ts:104-112`; test `:173` |
| 31 | A post-deploy no-authority sign-up is never backfilled | CONFORMS | marker `public.ts:364` + `backfill...ts:111` |
| 32 | Backfilled leads keep their status | CONFORMS | patch is `{ housingAuthority }` only (`backfill...ts:524-527`) |
| 33 | `/join` leads stay on tenant threads | CONFORMS | `public.ts` conversation path unchanged (`createOrGetByParticipantPhone(phone, 'tenant_1to1')`) |
| 34 | A member of the public leaving the select gets AHA + Onboarding | CONFORMS | rows 6, 10 |
| 35 | AI extraction only suggests over a held value | CONFORMS | extraction code untouched |
| 36 | Onboarding tenants are eligible for the Searching suggestion | CONFORMS | `extraction/apply.ts` untouched |
| 37 | Consent record unchanged (`web_form`) | CONFORMS | `public.ts:368` unchanged |
| 38 | 5-per-minute sign-up limit unchanged | CONFORMS | `app.ts:185-190` (`config.publicRateLimitMax` / window) unchanged |

### Section 6 - testing

| # | Spec bullet | Verdict | Test |
|---|---|---|---|
| 39 | `/join` with a listed authority -> onboarding tenant holding it + marker; none -> onboarding + marker, no authority | CONFORMS | `publicIntake.test.ts:998, 1023` |
| 40 | padded text trimmed by the middleware, then accepted | CONFORMS | `publicIntake.test.ts:1057` |
| 41 | unlisted / spelling / case / agency -> not_listed, nothing written; non-string / empty / over-long -> generic 400 | CONFORMS | `publicIntake.test.ts:867, 798` |
| 42 | `unitId` + authority -> generic 400 for shareable, missing, non-shareable | CONFORMS | `publicIntake.test.ts:822` |
| 43 | flyer sign-up without authority as today, plus the marker on a new contact | CONFORMS | `publicIntake.test.ts:1069, 1089, 1113` |
| 44 | existing phone + valid authority: no touched field changes; audit records the answer with `signupVersion: 2` | CONFORMS | `publicIntake.test.ts:1126, 1151, 1264` |
| 45 | list read: names only, sorted, never writes, limit independent both ways; edge-guard test still passes | CONFORMS | rows 1-2; `cloudfrontBehaviors.test.ts` unchanged and still matches |
| 46 | backfill: every listed case (selection incl. marker, re-sign-up, each event type, `--skip`, dry run, apply, changed-between, each refusal incl. stale lock, rename warning, re-run) | CONFORMS | `backfillJoinHousingAuthority.test.ts:173-231, 604-659, 678-749, 897-1184` |
| 47 | Dashboard: preselects AHA | CONFORMS | `HousingFairIntake.test.tsx:188, 209` |
| 48 | Dashboard: "Not sure" sends no authority | CONFORMS | `HousingFairIntake.test.tsx:232` |
| 49 | Dashboard: loading, timeout, failed-list states | CONFORMS | `HousingFairIntake.test.tsx:257, 291, 269` |
| 50 | Dashboard: not_listed recovery keeps fields, picks no value, blocks send until a choice | CONFORMS | `HousingFairIntake.recovery.test.tsx:90, 143, 164` |
| 51 | Dashboard: the 429 message | CONFORMS | `HousingFairIntake.recovery.test.tsx:192` |
| 52 | Dashboard: "Sign up another person" clears person fields + consent, keeps the authority, re-reads a failed list | CONFORMS | `HousingFairIntake.another.test.tsx:93, 130, 143` |
| 53 | Dashboard: flyer renders no select and keeps its messages | CONFORMS | `FlyerPage.test.tsx:343`; `IntakeForm.props.test.tsx:29, 45` |
| 54 | E2E: `/join` shows AHA preselected; two sign-ups in a row via "Sign up another person"; each contact Onboarding + its authority via the authenticated API | CONFORMS | `e2e/tests/dashboard-next/public-pages.spec.ts:430-523` (also checks no second list read, consent unchecked, focus, marker) |

### Section 7 - places the build must also update

| # | Place | Verdict | Evidence |
|---|---|---|---|
| 55 | `publicApi.ts`: `HousingFairInput`, `submitHousingFair`, a list-read function | CONFORMS | `dashboard/src/routes/public/publicApi.ts:69, 99, 121-128` |
| 56 | `public.ts` route header and create comment | CONFORMS | `app/src/routes/public.ts:13-33`, `:331-339` |
| 57 | `e2e/scenarios/steps.ts` housing-fair step description | CONFORMS | `e2e/scenarios/steps.ts:979-982` (plus the field type at `:574-576` and `expectOnboarding` at `:974-976`) |
| 58 | `tenant-onboarding.spec.ts` note | CONFORMS | `e2e/tests/scenarios/tenant-onboarding.spec.ts:182-209` (note rewritten; now sends and asserts the authority and Onboarding) |
| 59 | `STATUS-MODEL.md` Needs review section | CONFORMS | `documentation/STATUS-MODEL.md:161-166` (and the landlord-lifecycle bullet `:194-197`) |
| 60 | `sequence-diagram-to-test.md` self-serve note | CONFORMS | `documentation/sequence-diagram-to-test.md:108-114` |
| 61 | existing assertion in `publicIntake.test.ts` | CONFORMS | `app/test/publicIntake.test.ts:30` (now asserts onboarding + the marker) |
| 62 | `e2e/performance/templates.ts`: declare the GET only if a measured page requests it | CONFORMS (condition not met) | `/join` is excluded from measurement (`e2e/performance/routes.ts:118`, `APP_ROUTE_EXCLUSIONS` reason `public`), so no measured page requests it and no template is owed |
| 63 | `RUNBOOK.md` D11 entry | CONFORMS | row 28 |

## Boundaries the spec draws (checked explicitly)

- **Flyer page unchanged:** `FlyerPage.tsx` has no diff. On the flyer, IntakeForm gets none
  of the new props, so the button-disable expression reduces to `pending` and the catch
  reduces to today's message (`IntakeForm.tsx:44-49, 133, 289`). The flyer submit type
  cannot carry `housingAuthority` (`IntakeForm.tsx:23`). PIN tests: `FlyerPage.test.tsx:343`
  and `IntakeForm.props.test.tsx:29, 45`.
- **D6, no write to an existing contact:** in the existing-contact branch the only contact
  write is the pre-existing welcome flag (`public.ts:327-329, 399`). The deep-equal PIN is
  `publicIntake.test.ts:1126`.
- **D1, no list-item write from the public surface:** both public reads go through
  `loadPublicOrgEntries` (`peek` only). The tests spy on `get`, `mutate` and `putForSeed`,
  and check that `peek()` still returns null afterwards (`publicIntake.test.ts:684, 693,
  867, 944`).
- **D10 guards and refusals:** see rows 19-24. The refusal runs before any contact read; a
  test records the sent commands, which are exactly `['GetCommand']` (`backfill test:1154`).
- **D11 RUNBOOK steps:** see row 28.

## Findings

**F1 [LOW] - The post-apply list re-read runs only when the apply wrote at least one record
(DEVIATES, immaterial).** D10 says "After an apply, the run reads the list again". The code
(`backfill-join-housing-authority.ts:634`) re-reads only when `report.written > 0`. The
warning exists to tell the operator that the written records now show under "Not on the
list". With zero writes there are no such records, so skipping the read loses nothing. No
code change is needed. Optionally, amend the spec to say "after an apply that wrote".

**F2 [LOW] - Scope addition: the /join select is disabled while a sign-up is sending.** This
is `HousingFairIntake.tsx:185` (`disabled={sending}`) through
`HousingAuthoritySelect.tsx:109`, tested at `HousingFairIntake.test.tsx:364`. The spec does
not ask for it. It matches IntakeForm disabling its own inputs while a send is pending, and
it stops the choice from changing mid-send. It is harmless and arguably part of
"keeps ... as they are".

**F3 [LOW] - Scope additions in the backfill beyond D10.** All are defensive and tested, and
none changes a specified outcome:
- (a) Every Cc/Cf/Zl/Zp character in a printed name is shown escaped
  (`backfill...ts:231-261`). Names come from the public form, so this stops a name from
  forging or reordering a report line.
- (b) An empty id in `--skip` (an empty value or a stray comma) is a usage error, exit 2
  (`:673-677`).
- (c) There are two WARNING kinds the spec does not list: the post-apply list could not be
  re-read (`:566-574`), and the audit append failed after the write landed (`:546-553`).
  Both exit 0. The spec does not say whether a missing audit event is a "failure". Exit 0
  is defensible, because a re-run finds the lead holding an authority and cannot touch it.
  The human may still want to know it is not exit 1.
- (d) A store whose audit pages do not move backward throws instead of looping
  (`:482-484`).

**F4 [LOW] - Scope addition: documentation beyond section 7.** These changes are
documentation only and accurate:
- `e2e/support/selectors.md:44-46`: new rows for the select and the button. It also
  corrects a stale `/join` success-text row that predates this branch.
- `scripts/e2e-session.mjs:143-150`: a comment only, explaining that the list limit is not
  raised by `PUBLIC_RATE_LIMIT_MAX`.
- The `STATUS-MODEL.md` landlord-lifecycle Needs review bullet and its update date.
- Four new `docs/issues/` entries plus two sighting appends. These record known gaps the
  spec accepted or left out of scope:
  - `join-not-listed-error-on-wrong-fields`
  - `join-repeat-signup-answer-unreachable`
  - `join-backfill-ignores-pending-authority-suggestion`
  - `public-rate-limit-key-spoofable-xff`

**F5 [LOW, informational] - A request carrying `unitId` + `housingAuthority` but no consent
gets `400 consent_required`, not the generic `400 invalid request`.** The consent gate
predates this branch and runs first (`public.ts:129-131`); the D4 refusal is at `:187`.
D4's wording is "refused with the generic 400". This reveals nothing about the unit, since
both checks run before the unit is read, and the flyer form always sends consent. Not worth
a change; it is recorded so nobody reads it as a D4 gap later.

No BLOCKING, HIGH or MEDIUM findings. No spec bullet is MISSING.
