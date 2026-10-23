# Build research - s5-s6-inbox-e2e findings (plan sections 9 and 10)

Reader: s5-s6-inbox-e2e (Phase 1, read-only). Tree: W:\tmp\unknown-inactive
@ fd0bd61e (code identical to main @916258ae). Counts: 0 BLOCKER, 0 MAJOR,
5 MINOR.

Checked and found correct (no action): every S5 Edit anchor is byte-exact
and unique (InboxRow.tsx:132-133, InboxRow.module.css:103-105 and :170-176,
InboxRow.styles.test.ts:48, api/types.ts:3806-3807, inboxListMerge.ts:50-54,
inboxListMerge.test.ts:3-12, useInbox.ts:39-47, :148-153, :718); the
useInbox.test.tsx harness (getInbox, sse, mkRow, pageOf, Probe with the
ids/status/hasMore/count testids and the `more` button) and the
ConversationUpdatedEvent literal in the flip case typecheck; every stated RED
and PIN in S5.1-S5.3 holds on the current code (vitest 3.2 resolves a
missing named export to undefined, so S5.2 fails per case, not per file);
the Unknown filter literal is 'unknown' (api/types.ts:3775); no snapshot or
second copy of the comparator exists; `sortByActivity` has no other importer
(the one app comment, app/src/routes/inbox.ts:2298, is removed by S3.4
Edit C). S6.1: every fixture, helper, route and selector exists with the
shape the draft uses (fixtures/fakeTwilio.ts:62-100 postInboundSms needs no
persona; fixtures/reseed.ts; support/today.ts; ui/StatusMenu.tsx:263-301
names; Inbox.tsx:380 `Conversations`; ContactsList.tsx:369 list name;
today.ts:845-944 keeps a READ Needs review unknown on Needs you now, so step
(3) holds after step (2)'s mark-read; today.ts:704-842 is the source the AR8
skip gates for step (9)); the lean seed holds zero unknown contacts
(app/src/lib/seed/lean.ts:91-191); the live drop in step (5) discriminates
S2 (useToday.ts:142-153 has no poll, inbox.ts:2836-2848 emits only for an
unread thread, so no other event refetches Today). S6.2/S6.3 anchors are
byte-exact and unique (STATUS-MODEL.md:7, :212-215; GLOSSARY.md:642-645,
:699-700, :702-705). No existing e2e spec is put at risk (see the reference
file for the file:line sweep).

1. MINOR - S6.2 Edit 2, the 5b replacement text (plan line 9428):
   "4. **The same muted status colour.**" lands in a living doc
   (documentation/STATUS-MODEL.md) and breaks Cameron's American-English
   rule (memory american-english-spelling: "color" not "colour").
   Correction: write "4. **The same muted status color.**". Out-of-area
   aside for the S4 reader: the S4.x test comment at plan line 6097
   ("the same muted colour") has the same problem.

2. MINOR - S6.2 Edit 2 (plan 9436-9442, "Two differences remain") and S6.3
   Edit 3 (plan 9552-9556, the new Inactive entry) state the Today rule only
   as "Inactive unknown contact: not on Needs you now; Inactive tenant:
   still on Unreplied". An Inactive TEAM MEMBER is also dropped: its
   threads are unknown_1to1 (spec D5; S3.3's test comment, plan 4627-4630)
   and app/src/routes/today.ts:784 sends every unknown_1to1 thread to
   needs_you_now, which the AR8 skip gates on the owner's status, while a
   partner_1to1 thread feeds Unreplied (today.ts:815-817). Correction: in
   5b say "an Inactive unknown contact's or team member's unread text (their
   threads are unknown threads) does NOT show in Needs you now", and in the
   GLOSSARY entry "an unknown contact or team member marked Inactive leaves
   Today's Needs you now ... ; an Inactive tenant's or partner's unread text
   still shows under Unreplied".

3. MINOR - S6 coverage (plan 9672-9677) says the e2e re-proves test 5
   "unread on All/Unread/Unknown". The draft checks unread on All and Unread
   only (step 8, plan 9128-9137); its Unknown-tab checks (step 7) run BEFORE
   the second inbound, while A's thread is read. Correction: after the step
   (8) unread poll add
   `await expect.poll(async () => (await inboxWireRow(api, 'unknown', idA))?.unreadCount ?? 0, { timeout: 15_000 }).toBe(1);`
   or drop "Unknown" from the coverage sentence.

4. MINOR - S6.1 Step 4 (plan 9225-9231) proves no stack of this worktree is
   alive only "Before the first run", and Step 9 only at the end. green1,
   red1, red2 and green2 all run on ONE commit (the RED edits are
   uncommitted), so if any run ends abnormally - the `timeout 1500` kill
   (exit 124) or a crash - its orphaned stack is adopted by the next run's
   `reuseExistingServer` on that commit match alone (AGENTS.md "adopts an
   orphaned stack on a commit match alone"; e2e/playwright.config.ts
   reuseExistingServer), e.g. green2 against red2's swapped-sort build.
   Correction: repeat the step-4 check (session.pid, lane.json ports,
   Get-NetTCPConnection) before each of red1, red2 and green2, and treat an
   exit file of 124 as an aborted run (stop, prove the ports free, re-run).

5. MINOR - dashboard/src/routes/inbox/Inbox.tsx:1-4 (header comment) still
   says the list is "newest-activity-first, with All (default) / Unread /
   Unknown / Groups filters"; after S5.3 the Unknown tab renders Needs review
   first. S5's Files list excludes Inbox.tsx. Correction: either add the
   one-line comment fix to S5.3 (file in the commit and the S5.4 lint list)
   or name the stale comment in the S5 report.
