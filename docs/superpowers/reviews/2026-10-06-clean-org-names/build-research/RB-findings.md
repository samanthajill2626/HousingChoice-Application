# RB findings - build research, feat/clean-org-names

- Reader: RB (opus), 2026-10-06, read-only on the repository.
- Plan range: S4, S5, S6 - plan lines 6907-10227 of
  `docs/superpowers/plans/2026-10-06-clean-org-names.md` (plus sections 0-3
  and section 12; S1-S3 code read where S4-S6 call it).
- Counts: BLOCKER 0, MAJOR 0, MINOR 4.

## What was checked, and how

1. ANCHORS. Every create / append / replace / insert-before in Tasks 4.1-6.5
   was REPLAYED mechanically on scratch copies (session scratchpad, not a
   repo path), in plan order, on top of RA's replayed S1-S3 end state (so the
   harness and `unitsRepo.ts` carry their S2/S3 edits), asserting each
   old_string occurs EXACTLY once at that moment: 57 operations, 19 files,
   ALL UNIQUE. Every MISSING row of the anchor check in this range (plan
   7271, 7339, 7985, 8126, 8153, 8167, 8325, 8349, 8575, 9399, 9959, 10088,
   10101) is a byte-exact copy of the earlier task's new text, indentation
   included. MULTI-IN-FILE plan 9260 (`accepted_authorities: ['Fulton
   County'],`, unitsApi.test.ts :46 and :56): exactly 2 hits, the plan's
   `replace_all: true` is right and leaves the `jurisdiction: 'Fulton
   County'` tombstones (:492, :510) alone. SEVERAL-FILES rows (7823, 7874,
   7979, 9016, 9038, 9051, 9807) are unique inside the file the plan names.
   The two "Before `  return router;` insert" anchors (5.2, 5.3) and the
   unlisted anchors (6.4's last four lines of broadcastApi.test.ts - `});` at
   column 0 occurs only at :2071) are unique. Base line numbers cited in the
   range are accurate at 93c3c65b.
2. SYMBOLS. Every existing symbol used exists with a compatible signature
   (table below). The final S4-S6 state of all 19 files was TYPECHECKED in a
   scratch overlay of the full app tree (RA's overlay, tsconfig.test.json
   options): the error list is IDENTICAL to RA's S1-S3 baseline (39 errors,
   all in base files importing modules the overlay omits - app/scripts,
   dashboard, root scripts, e2e fixtures, fake-twilio's fast-xml-parser);
   ZERO errors in any file this range touches.
3. CONTRACTS. S4/S5/S6 match plan 3.4b (factories, the composition root
   building `orgListRepo` once and `orgNames` / `orgRecords` / `orgRewrite`
   over it, the router dep keys `orgNamesService` / `orgRecordsService` /
   `orgRewriteService`, the harness `api:` key `orgListRepo:
   world.orgListRepo`), 3.5 (every status/body), 3.6 (all 11 endpoints, admin
   split), 3.9 (`ORG_REWRITE_JOB` re-exported, `{ jobId }` payload, current-run
   check incl. the cleanup lock, one pass per stored field, never rethrows,
   `lock_lost` without finish, registration + pinned name list). Calls into
   S3 use the shapes S3's code defines (typecheck above).
4. FALLOUT. Grepped app, dashboard, e2e, fake-twilio, scripts:
   - registerAllJobHandlers gains `org.rewrite`: the only pin is
     `registerHandlers.test.ts:19-36` (named); `relayRetryLeg.test.ts:2149`
     and `mediaMirrorJob.test.ts:94` call the registrar / use `toContain` and
     are unaffected (registration is lazy, no repo is built until a dispatch).
   - `ApiRouterDeps.orgListRepo` / router deps keys: all optional; only the
     harness builds the api deps (`buildApp` direct callers - apiRoutes,
     app, auth, ... - pass no org fields and default-construct with no I/O).
   - `UnitsRepo.getById` gains an optional `opts`: the harness fake
     (`twilioWebhookHarness.ts:2709`), `placementNudges.test.ts:179` (cast) and
     the five tests that reassign `world.unitsRepo.getById` (contactTimeline
     :2513, placementsVoiceRouting :216, statusTransition :1053,
     tourReminders :4693, toursApi :1027/:3449) all stay assignable; no
     `getById` is passed as a map callback anywhere.
   - contacts PATCH D5: the only app tests that send `housingAuthority` /
     `agency` through the PATCH are contactTriage (:462 `dekalb_housing`, :492
     `''`, :569 `5`), contactIntakeFields (:95/:125 `Hope Atlanta`, :152 `7`)
     and trimStrings (:85 `' atlanta_housing '`) - every value resolves or
     stays a 400/clear; the three expectations that change are named.
     aiRunVerdicts `'Metro HA'` goes through the suggestion accept, not the
     PATCH (S7 names it, plan 12716).
   - units POST/PATCH D5: only unitsApi.test.ts sends `accepted_authorities`
     through the routes (named); every other suite seeds units straight into
     the world. No contacts/units/broadcasts getById call-arg pin exists on
     these routes (`toHaveBeenCalledWith` sites are other services).
   - broadcasts: no app test sends `audience_filter.housing_authority`
     (broadcastApi, contactsBatchReads, contactsBatchIncomplete,
     rateLimit); no test pins the exact 201 body (the two `toEqual` bodies at
     broadcastApi :1894/:1932 are the PATCH route); the fan-out job never
     re-reads `audience_filter`.
   - e2e: every S6-affected spec R4 8.1 lists is named in S14 (a2p-compliance,
     contact-detail, contacts-list-facets, properties-available-view,
     tenant-onboarding, sending-unit, the 17 `['atlanta_housing']` unit POSTs
     via steps.ts). The e2e-workspace mutation catalog scans dashboard/src
     only; CloudFront `/api/*` already allows every method
     (`infra/modules/cloudfront/main.tf:158`). Clean.
5. TDD VALIDITY. Every RED is red for the stated reason (missing module, a
   missing export surfacing as "not a function", 404 for an unmounted route,
   the old raw value stored / 200 instead of 422); every (PIN) in the range
   passes on unchanged code; all run commands use existing paths and the
   right cwd. Executed on a vitest-like shim (scratch, plain node, no
   DynamoDB, no repo writes): `orgRewriteJob.test.ts` 10/10 GREEN (incl. the
   registration describe, the 25 s takeover, the concurrent duplicate run)
   with S3's suites still 68/68 GREEN; `organizationsApi.test.ts` 25/25 GREEN
   against the plan's router mounted in a real Express 5 app via supertest,
   the S3 services, the S4 handler and an in-process queue stub. Mutants
   were killed in both (counts lost on abort; requireRole dropped from
   merge; the 200-char limit off by one). The S6 route suites need the full
   app and were traced by reading; every D4 outcome they rely on was
   computed with the S1 code over the starting list (all as the tests
   expect, e.g. `MHA` -> Marietta + Macon-Bibb, `Fulton` unknown with close
   [Fulton County Housing Authority], `atlanta_housing` not on the list for
   the filter but resolving to Atlanta Housing Authority).
6. SPEC. D5 (only changed scalars; clears; held members trimmed; legacy
   jurisdiction only while no stored list), D7 (draft preview + filter-send
   re-check, curated send and seeds_only exempt, sent shares untouched),
   D10 (everyone views/adds/notes, admin for the rest), D11 (job semantics),
   section 6 (200-char check) and section 9 (every writer in this range) all
   conform. No contradiction found.

## Findings

### RB-1 | Task 6.4 RED, plan 9680-9683 | MINOR

- Evidence: the instruction reads "Replace with those same first three
  lines, then the block below, then the final `});`", but the fenced block
  (plan 9683-9789) already BEGINS with those three lines and ENDS with the
  final `});`. Read literally, the three lines and the `});` are written
  twice and the file no longer parses (the RED then fails for the wrong
  reason).
- Correction: old_string = the four-line block at plan 9673-9678; new_string
  = the fenced block at plan 9683-9789 VERBATIM, nothing added before or
  after it. (Replayed: unique, parses, typechecks.)

### RB-2 | Task 6.1 Step 0 item 4, plan 8726-8749 | MINOR

- Evidence: the fallback edit is dead after Task 5.1, and harmful if applied.
  Task 5.1 (plan 7953-7967) already threads `orgListRepo: world.orgListRepo`
  into the harness `api: {` block, right after `contactVocabularyRepo`, and
  the fallback's anchor pair (`settingsRepo: world.settingsRepo,` +
  `contactVocabularyRepo: world.vocabularyRepo,`) is STILL present there
  (replay: found once after Task 5.1). Applying the fallback would add a
  second `orgListRepo` key to the same object literal - TS1117, a red
  typecheck.
- Correction: run the item-4 grep; it prints the Task 5.1 line, so skip the
  fallback, and do not stage `app/test/helpers/twilioWebhookHarness.ts` with
  Task 6.1.

### RB-3 | Tasks 4.1, 4.2, 5.1, 5.2, 5.3 commit steps (plan 7247, 7472, 7972, 8318, 8667) | MINOR

- Evidence: plan section 0 and AGENTS.md require explicit staging paths; S6
  lists them per task, S4/S5 do not.
- Correction: 4.1 -> `app/src/jobs/orgRewrite.ts`,
  `app/test/orgRewriteJob.test.ts`; 4.2 -> those two plus
  `app/src/jobs/registerHandlers.ts`, `app/test/registerHandlers.test.ts`;
  5.1 -> `app/src/routes/organizations.ts`, `app/src/routes/api.ts`,
  `app/test/helpers/twilioWebhookHarness.ts`,
  `app/test/organizationsApi.test.ts`; 5.2 and 5.3 ->
  `app/src/routes/organizations.ts`, `app/test/organizationsApi.test.ts`.

### RB-4 | Tasks 6.1-6.4 vs plan section 12 accepted races (plan 30402-30409) | MINOR (documentation)

- Evidence: every S6 writer reads the list (`checkScalar` / `checkList`,
  e.g. the D5 block of plan 9091-9111) and writes the record in a separate
  step. A rename, merge or delete committed in between - with the rewrite
  pass already past that record - leaves it holding the old exact name, off
  the list, until "Not on the list" settles it. Spec D11's "a record written
  in the moment before a rewrite ... can be missed" covers the outcome, but
  section 12's accepted-race bullet names only the PATCH "unchanged" re-send
  and delete/kind change. Same class as RG-3 (stale-list writers).
- Correction: no code change; when RG-3's edit to the section 12 race bullet
  is applied, name the S6 writers' check-then-write window in the same
  sentence.

## Clean checks (one line each)

- Anchors: all unique and byte-exact by mechanical replay; base line numbers
  accurate.
- Symbols: clean (table below); typecheck of the final state: 0 new errors.
- Contracts with section 3: clean.
- Fallout: clean - the plan's named fallout is complete for app/test; e2e is
  S14's and named there.
- TDD validity: clean (S4 and S5 suites executed GREEN on the shim).
- Spec conformance: clean.
- ASCII: plan lines 6907-10227 contain no non-ASCII byte and no `\u`
  escape; no edit touches the pre-existing non-ASCII lines
  (registerHandlers.ts header, broadcasts.ts :6-11, contactTriage.test.ts
  :448).
- Lint (gate 5, tseslint recommended + the repo's no-unused-vars options,
  run on scratch copies with a canary proving the config fires): 0 messages
  in all 19 files' final state (0 before, too).

## Symbols the range uses (base tree unless noted, all compatible)

| symbol | where | used as |
|---|---|---|
| `defineJobHandler`, `registeredJobNames`, `dispatchJob`, `_resetForTests`, `configureJobsLogger`, `configureOutboundQueue`, `configureScheduler`, `enqueue` | `app/src/jobs/jobs.ts:199`, `:206`, `:290`, `:346`, `:82`, `:77`, `:67`, `:107` | S4 registrar/tests; S5 Task 5.3 |
| envelope-less dispatch (synthesized context, runs the handler) | `jobs.ts:249-284` (`validateEnvelope`) | Task 4.2 test's `as never` event |
| `JobEnvelope` | `app/src/jobs/types.ts:7` | Task 5.3 recorder |
| `InMemorySchedulerAdapter`, `InProcessOutboundQueueAdapter({ dispatch })`, `.settle()` | `app/src/adapters/scheduler.ts:81`, `:137`, `:212` | Task 5.3 |
| `OutboundQueueAdapter.enqueue(envelope, opts?)` | `scheduler.ts:63-70` | Task 5.3 literal adapters |
| `createLogger({ destination })`, `createLogCapture().atLevel(n)` (exact level) | `app/src/lib/logger.ts:178`, `app/test/helpers/logCapture.ts:14-38` | Task 4.2 |
| `requireRole(role)` -> 401 / 403 `{ error: 'forbidden' }`, `AuthedRequest { user?: SessionUser }` | `app/src/middleware/auth.ts:235-247`, `:46` | S5 router |
| Express 5 (async rejections forwarded) | `app/package.json:36` (`^5.2.1`) | `handle()` rethrow |
| `TEST_SESSION_COOKIE` / `TEST_ADMIN_COOKIE` / `TEST_SESSION_USER` / `TEST_ADMIN_USER` | `app/test/helpers/authSession.ts:112`, `:115`, `:22`, `:33` | S5 tests |
| `makeWebhookHarness`, `ORIGIN_SECRET`, `Harness`, `createFakeWorld`, `FakeWorld` | `twilioWebhookHarness.ts:5072`, `:223`, `:5063`, `:507`, `:241` | S4-S6 tests |
| harness `api:` block | `twilioWebhookHarness.ts:5127` onward (`settingsRepo` :5143) | Task 5.1 |
| `buildApp` api deps = `Omit<ApiRouterDeps, 'config' \| 'logger'>`; `trimJsonBody` mounted app-wide | `app/src/app.ts:46`, `:142` | |
| composition-root locals `contacts`, `units`, `audit` declared before `const router = Router()` | `app/src/routes/api.ts:656`, `:633`, `:586`, `:698` | Task 5.1 |
| `ContactsRepo.getById(id, { consistentRead? })` | `contactsRepo.ts:632` | Task 6.1 |
| `parseTriageBody` -> `{ patch: Record<string, unknown>, changedFields }`; `housingAuthority ''` -> null, `agency` as sent | `app/src/routes/contacts.ts:487-500`, `:631-645` | Task 6.1 |
| `validateUnitBody(body, mode)` -> `{ ok: true; fields: Record<string, unknown> }`; error `accepted_authorities must be an array of strings` | `app/src/lib/unitFields.ts:139-218` | Tasks 6.2, 6.3 |
| `parseAudienceFilter` (trims; `AudienceFilter` mutable) | `app/src/routes/broadcasts.ts:106-136`; `app/src/repos/broadcastsRepo.ts:84-90` | Task 6.4 |
| `BroadcastItem.audience_mode`, `.seed_contact_ids` | `broadcastsRepo.ts:222-223` | Task 6.5 tests |
| preview body `{ count, truncated, candidates, ... }`; send body `{ broadcastId, status, count }` | `broadcasts.ts:644-651`, `:861` | Task 6.5 tests |
| `world.sent`, `world.broadcasts` | `twilioWebhookHarness.ts:301`, `:404` | Task 6.5 tests |
| S1-S3 symbols (`checkScalarWrite`, `isOnListFor`, `KINDS_FOR_FIELD` incl. `audience_filter`, `OrgNotOnList`, `OrgHttpError`, `asOrgHttpError`, the three factories and services, `OrgRewriteAbortedError` / `OrgRewriteLockLostError` with `.counts`, `ORG_REWRITE_JOB`, `OrgRewritePayload`, `orgFixtures`, `orgListFake`) | plan Tasks 1.1, 1.3, 3.1, 3.4-3.10, 2.1, 2.3 | as defined there (typecheck) |
