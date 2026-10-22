# S6 slice report - flyer-leads (Tasks 6.1-6.4; worklist OR-2..OR-4, OR-20..OR-24)

Branch feat/flyer-leads. Commits, oldest first: 93b02a36 (Task 6.1),
70a71482 (Task 6.2), d75a567a (Task 6.3), 74e664cf (Task 6.4). They sit
directly on S5's report commit d94a5213. Task 6.5 (the main sync and the five
gates) is the orchestrator's (OR-25) and was not run here. Findings only;
cited by `file:line` at 74e664cf.

## Contract deviations

- OR-24 shape (worklist-driven, test-local). The existing-tenant case
  (e2e/tests/dashboard-next/flyer-leads.spec.ts:398-523) no longer signs up
  through the visitor form the plan wrote. It opens /inbox first, awaits the
  page's `/api/events` response (:438-443), sets a window marker (:446-448),
  and clears the open row with an API mark-read (:452-455). That clear proves
  a conversation.updated reaches the page before the sign-up. Then it posts
  the sign-up with the bare `request` fixture (:461-465). The body is the
  flyer form's own (dashboard/src/routes/public/publicApi.ts:92-103). The row
  then turns unread in place (:473) with the preview unchanged (:474), the
  marker still set (:475) and the URL still /inbox (:476).
- The plan's test 2 held the only assertion of the thank-you TEXT. With no
  visitor form in that case, the assertion moved to the new-contact case
  (:601-604), so the copy stays pinned. Test 2 no longer takes the `browser`
  fixture.
- Otherwise none. Every plan 1.1 string the specs assert matched the build
  as written.

## Plan corrections

- Task 6.1 held as planned. All 13 anchors were verbatim (R4), and no OR-1
  escape or indent fix was needed.
  - RED was exactly 5 failed / 15 passed, failing at the plan's five lines:
    public-pages.spec.ts:217 and :285, listing-photos.spec.ts:242,
    property-requirements.spec.ts:262 and contact-detail.spec.ts:187.
  - No other stale assertion turned up.
  - The B33 grep found the six planned hits before the repair. After it, the
    only hits are public-pages.spec.ts:7 and :14 (comments) and the two loop
    lines, contact-detail.spec.ts:191 and property-requirements.spec.ts:298.
- Task 6.2's failing lines moved with OR-24. The mutation failures sit at
  flyer-leads.spec.ts:469 (tenant) and :553 (landlord). The plan names those
  lines by content only. Both read `Expected length: 0` /
  `Received length: 1`, with the welcome body as the received text.
- Run order. A pre-mutation sanity run (4 passed) went first, so a bug in
  the spec could not pass for a mutation effect. Then came the mutation, the
  restore, and four GREEN runs. The plan orders the mutation first; the
  extra run only adds evidence. Mutation record:
  docs/superpowers/reviews/2026-10-21-flyer-leads/S6-mutation-check.md.
- Task 6.3 has two additions beyond the plan's text. Both document what the
  new spec relies on:
  - e2e/support/selectors.md:21 (the 1a row) records the live-update
    recipe: open /inbox, await /api/events, set a window marker, use an API
    mark-read as the proof;
  - selectors.md:44 (the 1b row) records the API sign-up body
    `{ firstName, lastName, phone, smsConsent: true, unitId }`.

  The other plan rows are as written: :45, :52, :136, :139 and :156. The old
  `| requirement rows |` flyer row is gone.
- Task 6.4, GLOSSARY:
  - documentation/GLOSSARY.md:202-205 adds OR-21's sentence: rent still
    reaches tenants through `[Rent]` in `DEFAULT_SEND_TEMPLATE`
    (dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31, pre-filled at
    BroadcastComposer.tsx:447). The block is re-wrapped so "address heading"
    stays on one line (:209), which the plan's own Step 2 grep needs.
  - GLOSSARY.md:678-686 adds OR-23: a later inbound turns the pair into
    Replied, back on Follow up once quiet, unknown contacts included. It also
    places the sign-up on Today: tenant, landlord and partner threads under
    Unreplied as "<name> - Unreplied"; an existing unknown contact under
    Needs you now as "New unknown contact" (app/src/routes/today.ts:784-836).
    It adds OR-18's blank-preview new thread too.
  - Step 2 counts:
    - `**signed up**`: 2 hits, per OR-20 - the cross-reference at :628 and
      the entry at :663. `^- \*\*signed up\*\*` finds 1;
    - `flyer share entry` (:652), `Signed up / No reply yet` (:636) and
      `address heading` (:209): one hit each;
    - no `is PUBLIC` hit, and no "the Pets item, the deposit" hit.
  - OR-22: docs/issues/public-welcome-text-global-cap.md:13 now reads
    "Sign up". The GLOSSARY holds no text on the uncounted-pair residual, so
    OR-22's second half had nothing to apply.
- Task 6.4, deleted-contact-web-signup-silent.md:
  - the built deleted path is app/src/routes/public.ts:477-509. It writes
    the audit with `deletedContact: true`, `recorded: false`,
    `sentRecorded: false` and `sentSkipped: 'deleted'`, logs the INFO line
    `housing-fair signup captured`, and returns before the conversation call
    at :566;
  - that matches the plan's update paragraph, which was used as written
    (docs/issues/deleted-contact-web-signup-silent.md:47-68), with
    `updated: 2026-10-21` at :9;
  - `npm run issues` exited 0, so the frontmatter parses (INDEX.md is
    gitignored).
- OR-2: every backslash-u check used `grep -F`, with no hit in any added
  line. OR-3: every commit used single-quoted `-m` arguments. OR-4: every
  e2e run went to the background with the EXIT line, and was waited on
  in-turn.
- Static checks at 74e664cf:
  - `npm run typecheck -w @housingchoice/e2e`: EXIT:0
    (s6-final-typecheck.log; also after 6.1 and 6.2);
  - `npx eslint` on the five touched specs: EXIT:0, no output
    (s6-final-eslint.log);
  - the added-lines ASCII check prints 0 for all ten files S6 changed.

## e2e runs

Logs are under .superpowers/sdd/gates/ (gitignored). Every run used lane 13
(10301 / 10311 / 10321 / 10331), each a cold boot after a clean C2.

| Run | Log | Counts | EXIT line |
|---|---|---|---|
| 6.1 RED, 4 unchanged specs | s6-repairs-red.log | 5 failed / 15 passed (2.6m) | EXIT:1 |
| 6.1 GREEN | s6-repairs-green.log | 20 passed (28.4s) | EXIT:0 |
| 6.2 pre-mutation | s6-flyer-leads-precheck.log | 4 passed (14.0s) | EXIT:0 |
| 6.2 mutation RED | s6-flyer-leads-mutation.log | 2 failed / 2 passed (13.7s) | EXIT:1 |
| 6.2 GREEN 1 | s6-flyer-leads-green.log | 4 passed (14.9s) | missing (see risks) |
| 6.2 GREEN 2 | s6-flyer-leads-green-2.log | 4 passed (14.0s) | EXIT:0 |
| 6.2 GREEN 3 | s6-flyer-leads-green-3.log | 4 passed (14.0s) | EXIT:0 |
| 6.2 GREEN 4 | s6-flyer-leads-green-4.log | 4 passed (14.0s) | EXIT:0 |
| Combined: 4 repaired specs + flyer-leads | s6-combined.log | 24 passed (33.8s) | EXIT:0 |

The test-results of both RED runs were copied first, to
s6-repairs-red-results/ and s6-flyer-leads-mutation-results/.

## Risks and residuals

- GREEN 1 lost its EXIT line, and its stack outlived the completion notice.
  - Right after the notice, C2 found the launcher (session pid 22112) alive,
    with 10311 and 10321 still LISTENING. Both were gone a minute later, and
    GREEN 2 started only after that.
  - The log's last line is the summary, with no `npm error` and no failure
    line. Most likely a write from that run's teardown overwrote the EXIT
    line: C3's `> LOG` redirect does not append, while OR-4's `>> LOG` line
    does.
  - It happened in 1 of 9 runs. The verdict comes from the summary.
  - For Task 6.5: run C2 after every completion notice before trusting
    "stack down". Optionally, truncate the log with `: > LOG` and run the
    gate with `>> LOG`, so every write appends.
- Every run left a stale e2e/.artifacts/session.pid naming a dead launcher.
  The e2e README says an ordinary shutdown removes it; under Playwright's
  webServer teardown it stays. C2's liveness check covers this, but a pid
  check alone can be fooled because Windows reuses pids.
  - At hand-off the file names 50032. That pid now belongs to an unrelated
    `sleep.exe`, not a node launcher.
  - The lane 13 ports are free: no stack, no session.
  - So a C2 that sees a live pid should also check the image name and the
    four ports before it STOPs.
- OR-24's live check is a UI proxy. The open inbox re-reads its first page
  on ANY conversation.updated (dashboard/src/routes/inbox/useInbox.ts:563),
  so an unrelated emission in the 15 s window could hide a missing sign-up
  event.
  - On the existing-contact path the mark is the only emitter: there is no
    welcome, and the pin, the ledger and the audit emit nothing.
  - A solo run has no other traffic.
  - A stricter pin would open its own EventSource and wait for the tenant
    thread's event (the e2e/tests/flows/event-bridge.spec.ts:91-141
    pattern). Not built.
- OR-24 held in all six passing runs that include the spec (precheck,
  GREEN 1-4, combined), so the reload fallback was not needed. OR-17 is now
  pinned at the boundary: the router's default `appEvents` is what turns the
  open row unread.
- B28: the mutation ran on a cold-booted stack (C2 clean beforehand), and
  the restore was confirmed before the next boot:
  - `git status --short -- app/src/routes/public.ts` printed nothing, and
    the diff was empty;
  - `git diff --name-only d94a5213..HEAD -- app dashboard` is empty: S6
    changed no app or dashboard file.
- OR-18 (Today, the blank preview) is documented in the GLOSSARY, not
  asserted in e2e. Test 3 does show a landlord thread with no message
  reaching the inbox as `1 unread` (flyer-leads.spec.ts:556-558); the blank
  preview itself is not asserted.
- D10: no untrimmed typed-input path in the surfaces S6 touched (specs and
  docs only).

## Pre-existing lint

None. eslint exits 0 on all five touched spec files.
