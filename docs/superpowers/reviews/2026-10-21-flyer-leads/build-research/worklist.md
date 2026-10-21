# Build worklist - flyer-leads (orchestrator rulings OR-1..OR-26)

Phase 1 of the build (2026-10-21). Six read-only opus readers checked plan v3
FINAL (@981eba1c) against the live tree (feat/flyer-leads @031a46d6, code
identical to main @b7959e2a):

| Reader | Charge | BLOCKER | MAJOR | MINOR | NOTE |
|---|---|---|---|---|---|
| R1 | S1 + S2 anchors / compile / still-compiles | 1 | 0 | 3 | 4 |
| R2 | S3 anchors / compile / callers | 0 | 0 | 1 | 5 |
| R3 | S4 static compile + logic (never dry-run) | 0 | 0 | 3 | 5 |
| R4 | S5 + S6 anchors, e2e sweep | 0 | 0 | 3 | 3 |
| R5 | invariant sweep: listing_sends, outcome, activity_events, unread | 0 | 1 | 0 | 6 |
| R6 | invariant sweep: public exposure, tags, sign-up routing, subzone | 0 | 2 | 1 | 4 |

Findings files: `R1-s1s2-findings.md`, `R2-s3-findings.md`,
`R3-s4-findings.md`, `R4-s5s6-findings.md`, `R5-ledger-sweep-findings.md`,
`R6-public-sweep-findings.md` (this directory). The three MAJORs and the
BLOCKER were re-verified by the orchestrator in the live tree before ruling.

**Binding:** this worklist binds every implementer. Where it and the plan
disagree, the worklist wins; where it is silent, the plan (section 4 over the
slice text) wins. Cite rulings by number in slice reports.

## General (every slice)

- **OR-1 (R2 #1, R3 #4, R1 N4) Code-block indentation and inline escapes.**
  Plan section 0's "strip the bullet indent" applies ONLY to a block that
  actually carries it. Before using any block as an Edit anchor, compare its
  first line with the live text; the live file's own indentation is the
  authority. Known cases: ALL of S4's blocks are already at the target
  indent (use verbatim); S3's Task 3.2 step 1a replacement, Task 3.2 step 3c's
  two body anchors and replacements, and Task 3.5 step 1a's three blocks are
  at the target indent (do NOT strip). INLINE anchors (in prose) can carry
  presentation escapes the files do not hold - a backslash before a backtick
  or a double quote, a literal `\n` standing for a line break: strip them.
- **OR-2 (R4 #1) Backslash-u check.** Every `grep -n '\\u' <FILE>` in the plan
  is replaced by `grep -nF '\u' <FILE>` (fixed string; the regex form matches
  every "u" in Git Bash). Expected: no NEW hit.
- **OR-3 (R1 F2) Commit messages.** Never double-quote a `-m` body that
  contains double quotes. Use single-quoted `-m` arguments, or a message file
  OUTSIDE the worktree (the session scratchpad). Plan section 0 otherwise
  stands (gating `git status`, MERGE_HEAD check via
  `git rev-parse --git-path MERGE_HEAD`, explicit paths, trailer).
- **OR-4 (R4 #3, R4 N4) Long suites.** Any full-suite run (the S3 / S4 / S5
  exit checks, the gates) runs in the background with a hard outer `timeout`,
  the gate as the last command on its line and `echo "EXIT:$?"` on the next
  line into the log; the verdict and the exit code come from the LOG, never
  from the background-task notification. Exit 124 = the cap fired = a
  failure to diagnose. A child waits for its own background run IN-TURN
  (sliced foreground waits on the log's EXIT line); it never ends its turn
  with a suite running.

## S1 (Tasks 1.1-1.2)

- **OR-5 (R6 F5)** Task 1.1 also makes a comment-only edit to
  `app/src/lib/address.ts:110`: the clause saying the flyer never shows the
  street address is stale (D3 makes the address the flyer's heading; the
  flyer formats its own address client-side). The file carries non-ASCII: use
  the added-lines ASCII check. No test change.

## S2 (Tasks 2.1-2.6)

- **OR-6 (R1 F1, BLOCKER) The dashboard requirements.test.ts holds a SECOND
  verbatim copy of the app cases** (header at
  `dashboard/src/routes/listing/requirements.test.ts:307-316`: "When an app
  case changes, copy the change here"). Task 2.2, same commit, also:
  - applies S1 Task 1.1 Step 1a's replacement to the rows at :369-374 (the
    six Pets / Deposit tuples become `'staff_only'`, with 1a's comment line);
  - inserts S1 Task 1.1 Step 1b's new case ('flyer-leads D2: Application fee
    is the only requirement field On flyer') verbatim directly before :382
    (`it('flattens the 15 unit keys and the 15 req_ keys in item, then field, order', ...`);
  - applies S1 Task 1.1 Step 1c's three replacements at :601-602 (Rent min /
    max, with the two-line comment), :608-609 (Accessibility / Lease terms)
    and :618-623 (the six Pets / Deposit rows).
  The Step 2 RED list gains these three cases (requirements.test.ts fails 5,
  not 2). Copy the text from the S1 commit on the branch, not from the plan.
- **OR-7 (R1 F3, R6 F3)** Task 2.3 adds a comment-only step to
  `dashboard/src/api/types.ts` (the `Unit` wire type comments at :2570-2571
  `lease_terms`, :2607 `no_pets`, :2609 `pet_fee`, :2611 `deposit_one_month`,
  :2613 `deposit_flexible`): each "on the flyer" claim becomes
  `Staff only (flyer-leads D2).`, mirroring S1's app-side wording. Add the
  file to the task's `git add`; types.ts carries non-ASCII (added-lines
  check). S5 later edits the same file's unions: re-read it, never revert.
- **OR-8 (R1 F4)** Task 2.4 step 3(c) also rewrites the stale sentence in the
  `mapsHref` doc (`FlyerPage.tsx:93-95`, the one that explains the ', ' join
  against the DISPLAYED ' - ' string `addressLines` produced), e.g. "The parts
  are joined with ', ' into one free-text query; the heading shows the same
  parts as a street line and a city line." Comment-only.
- **OR-9 (R1 N2, N3)** Task 2.4 also (a) makes the stale-payload case assert
  the exact `dt` list, so no Address row appears under a hand-fed stale
  payload either (spec 5 "no ... address row, even when a stale payload is
  hand-fed those keys"), and (b) pins the smaller city line in
  `FlyerPage.styles.test.ts`: `.subline`'s font-size is `var(--fs-sm)` or
  `var(--fs-md)` (spec D3 item 2 "a second, smaller line").
- **OR-10 (R1 N1) /join shares the flyer stylesheet.**
  `HousingFairIntake.tsx:48` imports `FlyerPage.module.css` and uses
  `.title`, `.card`, `.muted`, `.cta`; Task 2.4(i)'s `.title` change reaches
  it (harmless). Never scope `.title` to the flyer without checking /join.
  R1 N4's count slip (Task 2.3(d) "four Pets cases": the range holds three
  plus the legacy-boolean and blank-pet-fee cases) - the line range is right.

## S3 (Tasks 3.1-3.5)

- **OR-11 (R2 #4)** Two comment-only fixes: the `ledgerEntryCounts` doc
  (`app/src/services/shareLedger.ts:92`) points at `latestCountedShareKey`
  (lib/shareLedgerKeys.ts) as the summary's rule; the harness fake's
  `putShareMemory` comment (`app/test/helpers/twilioWebhookHarness.ts:3612-3614`)
  says a tokenless write needs "an absent row, or a seeded row nobody has
  written memory or a decline on" (after O1 a declined seeded row carries a
  token).
- **OR-12 (R5 F5)** Task 3.4 adds one PIN to `app/test/followUps.test.ts`: a
  flyer-latest pair (via `seedFlyerSignUp`) whose contact has a
  `last_heard_from_at` after the sign-up and past QUIET is listed on Follow up
  as `replied` - with an `unknown` contact as the recipient (decision, not
  accident: a reply after a sign-up puts the pair back on Follow up, unknown
  contacts included). GLOSSARY line in Task 6.4 (OR-23).
- **OR-13 (R2 #3, #6) Record in the S3 slice report, no code change:**
  - the broadcasts.ts caller case is the D5-default PIN (green before and
    after); four callers carry a real `signed_up` wire pin;
  - residual (i): O1 closes the decline-then-flyer race; the reverse window
    remains - the outcome route takes its decline instant before its write
    (`app/src/routes/units.ts:1577` `const at = ...`, setDeclined ~:1671), so
    a flyer write landing inside that window makes the new decline
    born-superseded; the route's own re-projection answers `signed_up`, staff
    see it, a second click sticks. The orchestrator adjudicates it at review
    (fix or file an issue);
  - residual (ii): DynamoDB does not promise map key order, so on an exact
    countedAt tie the write-time summary and the read-time outcome can pick
    different entries (cosmetic, the spec's whole-second class).

## S4 (Tasks 4.1-4.5; built as two children: S4a = 4.1-4.2, S4b = 4.3-4.5)

- **OR-14 (R5 F1, MAJOR) The unread mark applies to a 1:1 thread only.**
  `createOrGetByParticipantPhone` returns the first OPEN item for the phone
  whatever its type (`conversationsRepo.ts:1279-1289`), and a relay group
  stores its POOL number as `participant_phone` (`:1987-1992`). So a sign-up
  typed with a relay group's pool number resolves to the relay group, and the
  touch would bump it (and could reopen one closed within the GSI lag -
  `touchLastActivity` guards only group_text, `:1626-1650`; the repo's own
  D16 note at `:676-683` names this hazard). In Task 4.3, the mark (touch ->
  increment -> event) is skipped when `!isOneToOneBucket(conversation)`
  (`app/src/lib/unreadFeed.ts:295`), logged
  `log.warn({ marker, step: 'touch', reason: 'group_thread' }, 'housing-fair signup step failed')`.
  The pin, the ledger write and the audit are unaffected (the audit has no
  mark field). Spec D6.3 already says "the contact's 1:1 conversation" - this
  is the guard that makes the code say it. Test (publicSignupLeads): seed an
  open `relay_group` whose `participant_phone` is P (the fake's fast path
  mirrors the real one, harness :653-669), sign up with P; the relay row's
  status, unread_count and last_activity_at are unchanged, `world.touches`
  has no entry for it, no `conversation.updated` names it, and the response
  is `{ ok: true }`.
- **OR-15 (R3 #2)** Task 4.3's case 'a NEW contact whose welcome is refused
  still gets the pin and the unread mark' becomes a FLYER case
  (`seedUnit(world)` + `signupBody({ unitId: 'unit-1' })`, expecting the
  flyer pin with refType `unit` / refId `unit-1`); Task 4.4 asserts the
  `flyer` entry is written whether the welcome was sent or refused (an
  `it.each` over the two welcome outcomes, or one extra case).
- **OR-16 (R3 #6)** Task 4.3 pins AR8 #2 (one clock reading): the harness
  clock is `vi.fn(() => clock.ms)`; for an existing contact's flyer sign-up
  assert exactly ONE call per post; for a new contact assert one call and,
  where a spy on the welcome send is straightforward, that the clock call
  comes after it (`mock.invocationCallOrder`).
- **OR-17 (R3 #5)** The router's production defaults (`appEvents` above all)
  are not exercised by app tests. Pinned instead at the boundary: S6's
  existing-tenant e2e test opens /inbox BEFORE the sign-up and asserts the
  row turns unread live, with a window marker proving no reload (OR-24); the
  orchestrator's self-QA repeats it. Reviewers check the four default
  expressions against plan 2.6.
- **OR-18 (R3 #7, R6 F2, R4 N6, R5 F3) Today and the blank preview: accept and
  document, no code change.** The live Today (`app/src/routes/today.ts`,
  :704-836; buildToday.ts is only the 404 fallback) lists every unread
  sign-up thread under Unreplied as "<name> - Unreplied", and an existing
  unknown contact's under Needs you now ("New unknown contact"). A thread
  created by the sign-up (an existing contact whose phone had none) has no
  message, so its inbox row is bold with a blank preview, and it is the
  contact's newest conversation, so it heads the contact's inbox row.
  Consistent with D6.3 ("unread and on top"); named in the GLOSSARY
  (OR-23), the S4 slice report and the handback; self-QA looks at both.
- **OR-19 (R3 #1, #3, #8; R5 F2, F6) Informational, no code change:**
  - Task 4.4 Step 2: the CURRENT-decline case goes red first on the S3 INFO
    line assertion, not on `captured(...)`;
  - plan 8 B misquotes the backfill test's `event` helper (it nests
    `payload`); Task 4.5's code is right;
  - record in the S4 slice report: the 24-hour cap is keyed on the PIN, so a
    written pin with a failed touch suppresses the bump for 24 hours (only the
    `step: 'touch'` line records it);
  - no code ever closes a 1:1 thread (`routes/contacts.ts:1349-1351`); R1 #6's
    closed-thread spy test stays as a defensive pin;
  - other readers of the touched state, unaffected by construction: the
    roster removal scan (`jobs/rosterActions.ts:230-301`, 250-event cap), the
    timeline merge, the nav badge, the hub channel dots, the contact page's
    unread state and ThreadUnreadToggle, Today (OR-18).

## S5 (Tasks 5.1-5.3)

No new ruling: R4 found every anchor verbatim and every union reader edited
or safe. `types.ts` was edited by S2 (OR-7) - re-read before editing.

## S6 (Tasks 6.1-6.4 by the S6 child; Task 6.5 by the orchestrator)

- **OR-20 (R4 #2)** Task 6.4 Step 2 expects TWO `**signed up**` hits (the 1c
  cross-reference and the 1e entry); check the entry with
  `grep -n '^- \*\*signed up\*\*'`.
- **OR-21 (R6 F1, part)** Task 6.4 step 1a's "STAFF ONLY ... rent_min /
  rent_max" sentence adds that rent still reaches tenants through `[Rent]` in
  the Matching blast default text (the property legend's ruling is OR-26).
- **OR-22 (R6 F6, R2 #5)** Task 6.4 also: `docs/issues/public-welcome-text-global-cap.md:13`
  names the flyer form by its button "Sign up" (not "I'm interested"); any
  GLOSSARY text on the uncounted-pair residual says "a pre-branch pin (no
  share id), or a pin whose share has no entry, reads the pair" - not "its
  old Property text failed pin reads Property sent".
- **OR-23 (R5 F5, OR-18)** GLOSSARY "signed up" entry (Task 6.4 1e) also
  says: a later inbound makes the pair `replied`, back on Follow up once
  quiet (unknown contacts included); a sign-up shows on Today under Unreplied
  ("<name> - Unreplied"; an unknown contact under Needs you now).
- **OR-24 (R3 #5)** Task 6.2's existing-tenant test opens `/inbox` BEFORE the
  public sign-up (posted through the API), sets a window marker, and asserts
  the tenant's row becomes unread WITHOUT a reload (marker still set), then
  continues as written. If that live assertion is flaky (fails in any of
  three consecutive runs while the server-side unread is right), fall back
  to the reload form and report it.
- **OR-25 (R4 #3, N4, N5)** Task 6.5 (the ONE main sync and the five gates)
  is run by the ORCHESTRATOR, not the S6 child. `npm test` gets a hard outer
  timeout; exit codes come from the logs; the dependency check also lists
  `fake-twilio/web/package.json`.

## Cameron (non-blocking; built per the approved spec meanwhile)

- **OR-26 (R6 F1, MAJOR) The rent legend.** After D2, Rent min / Rent max are
  tagged Staff only under the property legend "Staff only - never leaves the
  dashboard." (`dashboard/src/routes/listing/FlyerTag.tsx:36`), while the
  Matching blast default ("... is available for [Rent]/mo ...",
  `dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`, pre-filled at
  `BroadcastComposer.tsx:447`) still texts the rent. Built as the spec says
  (option c: keep both, document it - OR-21). Options for Cameron before the
  merge: (a) reword the property legend line (e.g. "Staff only - not on the
  public flyer."; pins in FlyerTag.test.tsx, ListingEditForm.test.tsx,
  UnitCreateForm.test.tsx, e2e property-requirements.spec.ts); (b) take
  `[Rent]` out of the blast DEFAULT only (the merge field stays available).
- **OR-26b (R5 F4) Row words for a flyer-latest pair with another outcome.**
  Spec D8 defines "Signed up from the flyer <date>" for the `signed_up`
  outcome only; when a decline, tour or reply outranks it, the row reads
  "Sent <date>" with the SIGN-UP date, for a property that may never have
  been texted. Built per spec. Alternative for Cameron: a wire flag from
  `latestCountedShareKey` that the row words key on.
