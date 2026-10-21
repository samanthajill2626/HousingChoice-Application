# S4b slice report - flyer-leads (Tasks 4.3-4.5; worklist OR-14..OR-16, OR-18, OR-19)

Branch feat/flyer-leads. Commits, oldest first: ad6997ac (Task 4.3),
c26d6f76 (Task 4.4), 67e210bc (Task 4.5). They sit directly on S4a's report
commit 9f008da6. Findings only; code cited by `file:line` at 67e210bc.

## Contract deviations

None against plan 1.1 / 2.6 or the worklist. As built:
- app/src/routes/public.ts:341-345, the four router defaults:
  `createActivityEventsRepo({ logger: deps.logger })`, `appEvents`,
  `() => Date.now()` (plan 2.6 writes `Date.now`, the same clock) and
  `createListingSendsRepo({ logger: deps.logger })`.
- public.ts:115 `SIGNUP_REPEAT_WINDOW_MS`; :118 `SIGNUP_STEP_FAILED` (the
  plan 1.1 text); :127 `SignupSentSkipped`; :143 `signupPinLabel` (the three
  plan 1.1 labels, verbatim).
- AR8 #2: ONE `now()` read, after the welcome (public.ts:612). It feeds the
  window start (:621), the pin `at` (:641), the touch `ts` (:647, used at
  :376) and `signedUpAt` (:671).
- The audit and the log line: the normal path at public.ts:693-724; the
  deleted path at :478-507 (AR11, `'deleted' satisfies SignupSentSkipped`).

Worklist-driven shape changes, private or test-local:
- OR-14: `markSignupUnread` takes the resolved `ConversationItem`
  (public.ts:368), not plan 8 Task 4.3 3c's `conversationId: string`, so the
  guard can read the thread's type. The guard `!isOneToOneBucket(conversation)`
  (:369-372; import :65) logs exactly the OR-14 line at WARN. That line
  carries one non-PII field beyond plan 1.1's `{ marker, step }`:
  `reason: 'group_thread'`.
- OR-16: `harness()` also returns `now`, the `vi.fn` clock
  (app/test/publicSignupLeads.test.ts:37).

## Plan corrections

- No compile fix was needed. The 4.3-4.5 test code compiled and ran as
  written; typecheck EXIT:0 after each task.
- Anchors: every quoted anchor matched once. The exception is
  `    res.json({ ok: true });`, which occurs twice: 4.5 used its multi-line
  region, as ruled. Before 4.5, the `(4) Audit` prefix sat at public.ts:680
  (plan :413) and the handler's last response at :713.
- OR-14 test (publicSignupLeads.test.ts:316-351), an it.each over two holders:
  - a NEW holder, the realistic first sign-up: no contact holds a pool
    number, so a junk tenant is created and its welcome is refused;
  - an EXISTING holder: that junk contact on a later sign-up.

  The relay row is seeded with members, so `setParticipantsIfAbsent` leaves
  it alone. The case was RED before 4.3's code (no group_thread WARN). It was
  then RED again against the plan's UNGUARDED code: the relay row was touched
  and marked (:321; .superpowers/sdd/S4b-4.3-noguard.log). Only then did the
  guard go in. In 4.4 the case also asserts the flyer entry is written.
- OR-15:
  - the 4.3 refused-welcome case is a flyer case
    (publicSignupLeads.test.ts:381);
  - 4.4's new-contact case is an it.each over a sent and a refused welcome
    (:745-761), each asserting the flyer entry at T0.
- OR-16:
  - existing contact (publicSignupLeads.test.ts:233-234): one clock call per
    post;
  - new contact (:371-378): one call, after the welcome's provider send and
    after the welcome's own touch, and before the mark's touch.

  The provider-send spy is `world.adapter.sendPreparedMessage`, the method
  the send service calls (app/src/services/sendMessage.ts:633).
- OR-19, Task 4.4 Step 2 RED, case by case:
  - the CURRENT-decline case failed on the S3 INFO-line assertion
    (publicSignupLeads.test.ts:626), as ruled;
  - the non-tenant cases failed on `captured(...)`;
  - the ledger-failure case failed on its `ledger` step line;
  - the never-touch-the-ledger case passed (PIN).

  The backfill `event` helper nests `payload`
  (app/test/backfillJoinHousingAuthority.test.ts:72-77), and Task 4.5's code
  was used as written.
- Task 4.5's replacement text is ASCII. So the rewritten route comment and
  the (4) / (5) comments lost their pre-existing non-ASCII: the old :14 arrow,
  the em dashes and the section sign in "doc section 9". The added-lines
  check prints 0 for all four files. OR-2: `grep -nF '\u'` finds no hit in
  any of them.
- Plan 8's exit check names `slices/S4-report.md` and
  `.superpowers/sdd/gates/s4-app-suite.log`. The brief binds
  `slices/S4b-report.md` and `.superpowers/sdd/S4b-app-suite.log`; those were
  used.
- Counts:

  | Task | RED | GREEN |
  |---|---|---|
  | 4.3 | 24 failed / 64 passed (2 files) | 3 files, 103 tests |
  | 4.4 | 16 failed / 28 passed (1 file) | 3 files, 118 tests |
  | 4.5 | 15 failed / 209 passed (3 files) | 4 files, 239 tests |

  - 4.3 RED: every new case asserted something nothing wrote yet (a pin, a
    touch, an increment, an event, a step line, a timeline item). The
    publicIntake "is idempotent" case had 0 pins.
  - 4.5 RED: the audit describe and the four publicIntake payload `toEqual`s
    failed on missing keys. The backfill (PIN) and the publicIntake PII (PIN)
    passed.
- Exit check (logs under .superpowers/sdd/):
  - the 8 S4 test files (S4a's 7 plus the backfill test): 349 tests, EXIT:0
    (S4b-slice-files.log);
  - `npx eslint` on the 10 S4 files of plan 8's list: EXIT:0, no output
    (S4b-eslint.log). S4a's transient HOUR_MS error is gone;
  - `npm run typecheck`: EXIT:0 (S4b-typecheck.log);
  - `npm run smoke`: EXIT:0, "1729 import specifier(s) across 301 emitted
    file(s) resolve under plain Node." (S4b-smoke.log). This is plan 8 exit
    step 3: public.ts gained runtime imports;
  - the FULL app suite, background, `timeout 1500` (S4b-app-suite.log):
    `Test Files 526 passed (526)`,
    `Tests 11023 passed | 1 skipped (11024)`, `EXIT:0`, 50.57 s. That is S4a's
    10972 plus the 51 cases S4b added.
    - No FAIL, no `[dynamoAdmin]` line and no DynamoDB skip.
    - The one skip is the pre-existing built-dashboard identity diagnostic.
    - The log's ProvisionedThroughputExceededException ERROR lines are
      errors thrown by test fakes (importConvertGroups.test.ts:122,
      groupConvert.test.ts:119 and :334), not container faults.
    - `env | grep '^AWS_'` printed nothing.

## Risks and residuals

- OR-19: the 24-hour cap is keyed on the PIN, not the bump.
  - The repeat read (public.ts:618-622) looks for a `signed_up` pin. The
    pin (:636-645) and the mark (:647) are independent best-effort steps
    (AR8 #4).
  - A written pin with a failed touch (:376-379) suppresses the bump for
    every same-source sign-up for 24 hours. Only the `step: 'touch'` ERROR
    line records it; the audit has no mark field.
  - The converse: a failed pin with a written mark lets the next
    same-source sign-up bump again.
  - The audit cannot tell a repeat skip from a failed pin: both write
    `recorded: false` (:702). Only a failure writes a `step: 'pin'` line.
- OR-18, Today (record only, no code). The live Today walks the unread
  threads (app/src/routes/today.ts:704) and keeps 1:1 threads only (:709):
  - tenant, landlord and partner threads go under Unreplied (:815-835,
    `why: 'Unreplied'`, rendered "<name> - Unreplied"). Every NEW sign-up
    lands here (tenant_1to1);
  - an existing unknown contact's unknown_1to1 thread goes under Needs you
    now (:784-803, `why: 'New unknown contact'`).
- OR-18, the blank preview (record only, no code). A thread the sign-up
  CREATES has no message: an existing contact whose phone had no open thread
  gets one at public.ts:566.
  - The mark's touch passes no preview (:376), so the inbox row falls back
    to '' (app/src/routes/inbox.ts:678-681): bold, unread, blank.
  - It is the contact's newest conversation (inbox.ts:946), so it heads that
    contact's inbox row even when an older thread holds the history.
- OR-14 residual: the guard covers the mark only. A sign-up typed with a
  relay pool number still creates a junk tenant holding the pool number, and
  its welcome is refused (RelaySendNotSupportedError,
  app/src/services/sendMessage.ts:180, :483). Both are pre-existing.
  - Since S4 that junk contact also gets the `signed_up` pin.
  - On a shareable flyer it also gets a flyer entry (public.ts:671), so it
    shows on that property's Sent to card.
  - The relay row itself is untouched.

  Low reachability.
- OR-17: the four router defaults (public.ts:341-345) are what production
  runs, since app/src/index.ts:112 injects no public deps. No app test
  reaches them; S6's live-inbox e2e (OR-24) is their pin.
- OR-19 / R1 #6: no code closes a 1:1 thread (app/src/routes/contacts.ts:1350).
  The CLOSED-thread case (publicSignupLeads.test.ts:237) stays as a
  defensive pin of touch-before-increment. It stubs the adoption because the
  fake reuses only OPEN threads (app/test/helpers/twilioWebhookHarness.ts:655),
  while the real repo adopts a claimed closed one.
- Production ordering (plan 8 E):
  - a new contact's welcome touch uses the provider timestamp
    (sendMessage.ts:708);
  - the mark's touch uses the app clock, read after it;
  - so a provider clock running ahead can step `last_activity_at` back by
    under a second. Cosmetic.
- D10: S4b stores no untrimmed typed input.
  - The pin label uses the parser-trimmed names (public.ts:196-197).
  - `unitId` is not trimmed by parseHousingFairBody (:223-229); it relies on
    the app-wide trimJsonBody (app/src/app.ts:146).
  - A padded id that got past the trim would miss `units.getById`. So it
    would reach neither the pin ref (:614), the repeat source nor the ledger
    (:671), which are all gated on `viaFlyer`. It would only pick the "from
    a flyer" label.

## Pre-existing lint

None in the files S4b touched (eslint EXIT:0 on all 10 S4 files).
