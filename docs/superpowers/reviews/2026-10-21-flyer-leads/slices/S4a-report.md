# S4a slice report - flyer-leads (Tasks 4.1-4.2; worklist OR-1..OR-4, OR-19)

Branch feat/flyer-leads. Commits, oldest first: 614eab0f (Task 4.1),
2f7fd187 (Task 4.2). They sit directly on S3's report commit 1efa6872.
Findings only; code cited by `file:line` at 2f7fd187. Tasks 4.3-4.5 are
S4b's.

## Contract deviations

None. Plan 2.5 and the Task 4.2 part of plan 2.6 are as written:
- app/src/repos/activityEventsRepo.ts:
  - :77 `'signed_up'` ends the `ActivityEventType` union;
  - :145 `hasEventSince(contactId, type, sinceIso, refId): Promise<boolean>`
    on the interface;
  - :210-240 the read: ONE queryAll walk (import :28), `ConsistentRead: true`
    (:223), KeyCondition `contactId = :c AND tsEventId > :since`,
    FilterExpression `#type = :type AND refId = :ref` or
    `#type = :type AND attribute_not_exists(refId)`; `:ref` is bound only
    when a ref is given; a DynamoDB error propagates (no catch).
- The harness fake: app/test/helpers/twilioWebhookHarness.ts:3597
  `hasEventSince`, the same rule over the in-memory array.
- app/src/routes/public.ts:234, :240, :246, :252 `PublicRouterDeps`
  gains `activityEventsRepo` (Pick record | hasEventSince), `listingSendsRepo`
  (Pick getByKeyConsistent | putShareMemory), `events?: EventBus` and
  `now?: () => number`; each doc comment names its plan 2.6 default.
- `HarnessOptions.publicNow?: () => number`
  (twilioWebhookHarness.ts:5568, AR8 #3) is forwarded as the router's `now`
  (:5817). The `public:` block passes `world.activityEventsRepo`,
  `world.listingSendsRepo` and `world.events` (:5814-5816).

For S4b - the state at 2f7fd187 and the names S4a created:
- The four deps are DECLARED and harness-wired, but the router does NOT
  read them yet. The plan builds the locals in Task 4.3 3c (`activity`,
  `events`, `now`: createActivityEventsRepo({ logger: deps.logger }),
  appEvents, Date.now) and in Task 4.4 3c (`listingSends`:
  createListingSendsRepo({ logger: deps.logger })). Until then no default
  is constructed.
- public.ts imports:
  - contactsRepo's `isDeleted` as `isContactDeleted`, with `ContactItem`
    (:53);
  - type-only `EventBus` (:49), `ActivityEventsRepo` (:52) and
    `ListingSendsRepo` (:55), the exact lines 4.3 3a and 4.4 3a replace;
  - `conversationTypeFor` (:50).
- public.ts handler locals:
  - `existing` (:356);
  - the deleted path at :362-377 (audit, log, `res.json`, `return`);
  - `isNew` (:379), `contact: ContactItem` (:380), and
    `const contactId = contact.contactId` (:426, now a const after the
    branch);
  - `conversation` (:433) and `welcomeSent` (:441).

  `alreadyWelcomed` and `created` are gone. The normal-path audit and log
  still carry `isNew: existing === undefined` (:480, :492); Task 4.5 replaces
  them, as the plan says.
- Every anchor Tasks 4.3-4.5 quote in public.ts and in
  publicSignupLeads.test.ts occurs exactly once at 2f7fd187 (grep -cF). The
  one exception is `    res.json({ ok: true });`, which occurs twice, as
  R3's reference predicts: use 4.5's multi-line region.
- NEW app/test/publicSignupLeads.test.ts:
  - module helpers: type `App` (:14); `FAIR` (:16); `PHONE`
    '+15550102000' (:18); `T0_ISO` '2026-10-21T15:00:00.000Z' (:19); `T0`
    (:20); `HOUR_MS` (:21, declared for 4.3, unused until then);
    `signupBody(overrides)` (:23);
  - `harness(env)` (:28) returns `{ ...makeWebhookHarness(...), clock }`
    with `clock.ms = T0` and `publicNow: () => clock.ms`. OR-16's
    `vi.fn(() => clock.ms)` is a 4.3 edit;
  - `post(app, body)` (:34);
  - `seedUnit(world, unitId = 'unit-1', over)` (:37): available, 12 Oak St,
    Atlanta, GA 30303;
  - `seedContact(world, over)` (:50): c-1, tenant, searching, PHONE, Tia
    Moss, housing_fair_welcomed true;
  - `signupAudits(world)` (:65);
  - one describe (:67) of 6 cases, the it.each over landlord / partner /
    unknown included.
- NEW app/test/activityEventsRepoConsistentRead.test.ts (AR12):
  `stubDoc()` (:20) and `makeRepo(doc)` (:32).
- app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts:
  - the AE section above the harness block: `AeCtx` (:1129), `AeStep`,
    `AeCase`, `aeContact`, `AE_T0` / `AE_BEFORE` / `AE_AFTER`, `aeRecord`
    (:1151), `aeSince` (:1172), `AE_CASES` (:1178);
  - `realActivityEvents` (:1228);
  - 'activity_events' in both table lists (:1347, :1353);
  - `describe('activityEventsRepo', ...)` (:1413).

## Plan corrections

- No compile fix was needed. The 4.1 and 4.2 test code compiled and ran as
  written: typecheck EXIT:0 after each task, and every RED failure was
  behavioral.
- Line-number hints that moved; every quoted anchor matched verbatim, once:
  - publicIntake.test.ts: the never-welcomed PIN sat at :1176 (plan
    :1161; S1 added lines). The opted-out case was at :166, as planned;
  - the harness `public:` block tail sat at :5802-5806 (plan :5761-5785);
  - the conformance file, where S3's O1 case moved the plan's lines:

    | Anchor | Tree | Plan |
    |---|---|---|
    | `// ---- the harness` | :1114 | :1078 |
    | `realListingSends` | :1122 | :1086 |
    | the two table lists | :1241, :1247 | :1205, :1211 |
    | the LS describe end | :1301-1306 | :1254-1270 |

  - contactTimeline.test.ts ended at :2593-2595 (plan :2577-2578; S3 added
    a case).
- OR-1: every S4a block was used verbatim at its own indent; nothing was
  stripped. OR-2: `grep -nF '\u'` found no new hit. OR-3: single-quoted
  `-m` arguments, or double quotes around a body holding no double quote,
  backtick or dollar sign.
- `npm run db:start` was NOT run (rules file). Every DynamoDB suite ran for
  real: no "no DynamoDB Local" SKIPPED line in any run.
- Typecheck was run as the root `npm run typecheck` (all workspaces,
  including the app's tsconfig.test.json). The plan's step says
  `cd app && npm run typecheck`; the root run covers it.
- Counts:

  | Task | RED | GREEN |
  |---|---|---|
  | 4.1 | 12 failed / 98 passed (4 files) | 4 files, 110 tests |
  | 4.2 | 7 failed / 58 passed (2 files) | 3 files, 80 tests |

  - 4.1 RED: every failure was `hasEventSince is not a function` (6
    integration, 2 AR12, 4 conformance). The timeline (PIN) passed at RED,
    as planned.
  - 4.2 RED: every failure was for the plan's stated reason. The (PIN)
    new-contact case and the kill-switch case passed. The 4.2 GREEN run
    includes rateLimitClientKey.test.ts.
- Exit check:
  - the 7 S4a test files together: 190 tests, EXIT:0
    (.superpowers/sdd/S4a-slice-files.log);
  - `npm run typecheck`: EXIT:0 (.superpowers/sdd/S4a-typecheck.log);
  - the FULL app suite (background, `timeout 1500`,
    .superpowers/sdd/S4a-app-suite.log): `Test Files 526 passed (526)`,
    `Tests 10972 passed | 1 skipped (10973)`, `EXIT:0`, 49.7 s. No
    `[dynamoAdmin]` line, no DynamoDB skip, no failure. The one skip is the
    pre-existing built-dashboard identity diagnostic. `env | grep '^AWS_'`
    printed nothing.

## Risks and residuals

- Interim state at 2f7fd187, until S4b lands 4.3-4.5. A live existing
  contact's sign-up writes only its audit, plus a new typed thread with no
  message when the phone had no open thread. It gets no welcome, pin, unread
  mark or ledger entry. A new contact behaves as before (welcome and flag).
  Do not e2e or self-QA the sign-up flows at this tip expecting D6 / D7.
- Thread typing, real vs fake. conversationTypeFor types a NEW thread only:
  - the real createOrGetByParticipantPhone returns the first OPEN item for
    the phone, whatever its type (app/src/repos/conversationsRepo.ts:1288-1289);
  - past a phone claim, it adopts the claimed conversation even when closed
    (:1319-1330), with its stored type;
  - the fake reuses an OPEN thread by phone only
    (app/test/helpers/twilioWebhookHarness.ts:655), else creates one of the
    requested type.

  So a legacy landlord with an open tenant_1to1 thread keeps that thread.
  OR-14's relay-group guard is S4b's (Task 4.3).
- team_member contacts. conversationTypeFor's default branch
  (app/src/lib/voiceMasking.ts:36) gives an existing team_member contact
  with no thread an `unknown_1to1` thread. An inbound SMS from that phone
  gets the same type. Once 4.3 marks the thread unread, the live Today files
  it under Needs you now as "New unknown contact"
  (app/src/routes/today.ts:784-806). This is an edge case (a staff member
  signing up their own phone), defined by the spec's
  conversationTypeFor rule. No change.
- OR-19, informational; S4b builds the code. The 24-hour cap reads
  `signed_up` PINS through hasEventSince, so the cap is keyed on the pin,
  not the bump. A written pin with a failed touch suppresses the bump for 24
  hours, and only the `step: 'touch'` line records it. S4b's report should
  carry this with its code citation. OR-18 is S4b's too: it needs the mark.
- hasEventSince walks the WHOLE window, with no early exit on a first
  match, as plan 2.5 binds ("paginated to the end of the window"). It reads
  every event in the contact's partition after sinceIso (the
  FilterExpression applies after the read), up to queryAll's 100-page cap
  with its WARN (app/src/lib/dynamoPaging.ts:20, :55). Negligible for one
  contact's day of milestones.
- D10: S4a stores no new typed input. `unitId` is not trimmed by
  parseHousingFairBody (app/src/routes/public.ts:164-171); it relies on the
  app-wide trimJsonBody (app/src/app.ts:146). At 2f7fd187 it reaches only
  `units.getById` (:339) and `unit_of_interest` on create (:409), as before.
  From 4.3 on it also reaches the pin ref and the repeat source (plan 8 E's
  note).
- Transient lint. `npx eslint` on the 9 S4a code files reports ONE error:
  app/test/publicSignupLeads.test.ts:21:7 `'HOUR_MS' is assigned a value but
  never used` (@typescript-eslint/no-unused-vars). The plan's 4.2 file
  declares `HOUR_MS` for Task 4.3 (`clock.ms = T0 + 23 * HOUR_MS`), so it is
  kept verbatim for 4.3's text, and 4.3 clears it. The other 8 files lint
  clean.

## Pre-existing lint

None in the files S4a touched. The only error is the transient `HOUR_MS`
above, which is S4a's own.
