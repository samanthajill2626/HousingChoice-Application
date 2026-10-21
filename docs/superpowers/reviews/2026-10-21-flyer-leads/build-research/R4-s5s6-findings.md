# R4 delta findings - S5 (plan section 9, Tasks 5.1-5.3) and S6 (plan section 10, Tasks 6.1-6.5)

Reader: R4 (build research, phase 1). Live tree: W:\tmp\flyer-leads
(feat/flyer-leads @031a46d6; app, dashboard and e2e code identical to
main @b7959e2a). Rules: .superpowers/sdd/research/RESEARCH-RULES.md.
Byte-exact live regions, wire facts and the escape demonstrations:
.superpowers/sdd/research/R4-s5s6-reference.md.
Read: spec rev 6; plan sections 0-4; plan section 9 (S5) and section 10 (S6)
line by line; S2 Tasks 2.4-2.6 (the flyer DOM S6 asserts); S4 Task 4.2 and
section E (the handler S6 drives and mutates); R3-s4 and R6-public-sweep
findings (to avoid duplicates).

Counts: BLOCKER 0, MAJOR 0, MINOR 3, NOTE 3.

What was checked and holds (no finding):

- S5, every anchor: all quoted regions exist verbatim and once in the live
  files (types.ts:2931-2932, :3149-3150, :3154-3156; Timeline.tsx:460-462;
  Card.tsx:271-272, :303-304, :345-349, :361, :381, :391; listingFormat.ts:334-336,
  :348-349; the six test-file anchors), each inside the describe the plan
  names. Every helper, mock, fixture and class the new tests use exists
  (`renderTimeline`, `renderRow`/`NOW`/`ROW`, ContactDetail's `getContact` /
  `getAllUnits` / `getContactListingsSent` / `TENANT` / `renderAt`,
  endpoints' mocked `request` + `beforeEach` reset, FollowUpView's `item` /
  `rowOf` / `renderView`, listingFormat's `row()` defaulting `eligible: true`,
  ListingDetail's `READY` / `unit` / `sent()` / `card()`); `styles.green`
  (Timeline.module.css:485) and `styles.chipPositive` (Card.module.css:280)
  exist, no new token. Expected RED reasons and counts are consistent
  (6 + 1 failing cases in 5.2; SendRosterRow 22 / FollowUpView 22 baselines).
- S5, union readers: no `Record<ListingSendOutcome | TimelineMilestoneType, ...>`,
  `satisfies Record<...>` or exhaustive outcome array exists anywhere in
  dashboard/src, app/src or app/test, so TypeScript forces no arm; by reading,
  every dashboard reader is either edited by S5 (OutcomeChip switch with a
  `default: null`, the `waiting` gate, `groupSendRows`, `milestoneVariant`) or
  provably safe (FollowUpView only ever receives server-waiting items and
  resolves only interested / not_interested - S5's PIN; ContactDetail /
  ListingDetail / endpoints pass the row through; `milestoneHref` keys on
  refType; tourActivityFormat's map is over tour audit kinds;
  listingFormat.ts:216-220 OUTCOME_LABELS is over UNIT AUDIT types). The
  SendRosterRow hosts are exactly TenantFile, PartnerFile and ListingDetail.
  F14 re-run read-only: `npx eslint` on S5's 11 files reports exactly
  `Timeline.tsx:1618:7 react-hooks/set-state-in-effect`.
- S6 Task 6.1: all 13 anchors exist verbatim (quoted with line numbers in the
  reference). The RED arithmetic holds: 7 + 3 + 2 + 8 = 20 tests, no serial
  describes, first failures exactly at public-pages :217 and :285,
  listing-photos :242, property-requirements :262, contact-detail :187. The
  repaired lines hold against S2's markup (the h1 inside the Maps link is the
  only element `getByText(unit.addressLine1)` resolves to; the landlord form
  carries exactly two `On property flyers` spans; `Tenants see this on the
  public flyer.` renders once in the New property dialog), and 2j / 2l are
  backed by the live setup (unit C has no application fee until Apply; the
  landlord's req_ keys make `no_pets` and `deposit_one_month` true on C).
  The B33 inventory grep returns exactly the six hits the plan lists.
- S6 sweep of all e2e specs (tests/** and scenarios/**): every other caller of
  POST /public/housing-fair signs up a FRESH phone and keeps its welcome
  (a2p-compliance, settings, proof-of-send, tenant-onboarding via
  scenarios/steps.ts:609, public-pages); no spec asserts flyer rent / deposit /
  pets / accessibility / lease / address rows, the old sign-up or thank-you
  copy, or `On flyer` tags beyond the four repaired files; every spec that
  counts unread lane-wide or reads Today's board content reseeds first or
  targets one run-unique row; no spec relies on a thread staying closed or
  reads send outcomes for a flyer-signed-up pair. Agrees with R6 F7.
- S6 Task 6.2 (new spec): every import, helper and wire it uses exists as
  written (reference section 3): dev-login, contact create with
  `status: 'searching'` and verbal consent, landlord create without a status,
  unit create by authority NAME with `pet_fee` as text and `deposit` +
  `deposit_flexible` (no conflict), publish via listing-status without media,
  `GET /api/inbox?filter=unread&limit=100` (100 = MAX_INBOX_LIMIT), the
  timeline and listings-sent wires, the fake-twilio control helpers, the
  viewport helpers. The lean world has only unit-0001 (under_application) and
  unit-0002 (occupied), and the spec creates its own Available property; it
  does not reseed (preflight.ts:150 reseeds once per suite). The pin label's
  address matches app `formatAddress` (`<line1>, Atlanta, GA 30314`); the row
  link uses the dashboard one, which the spec matches by `^<line1>` prefix.
  The contact page has exactly one `Communications and activity` region and
  Card `<section>`s only. A thread with no message still gets an inbox row
  and an unread-feed row (only soft-deleted contacts drop). The mutation is
  executable as written: the edit precedes the run, the restore follows it,
  C2 guards against adopting a stack; reverting D5 welcomes BOTH existing
  contacts (automated sends skip the consent gate, sendMessage.ts:542-557;
  new threads are ai_mode 'auto', conversationsRepo.ts:1291-1300), so the
  `2 failed / 2 passed` expectation and its failure lines hold. The Write tool
  keeps the spec's `\$`, `\/`, `\b`, `\d`, `\s` and public-pages' `\\s`
  (checked on a scratch file; only `\u` is decoded, as plan section 0 says).
- S6 Tasks 6.3 / 6.4 anchors: selectors.md :21, :43, :44, :51, :134, :137,
  :154; GLOSSARY.md :198-201, :218-222, :616-617, :623-624, :636;
  docs/issues/deleted-contact-web-signup-silent.md frontmatter `created:` line,
  the "Net:" paragraph ending and `**Suggested fix.**` - all verbatim.
- S6 Task 6.5: the MERGE_HEAD path the plan hard-codes equals
  `git rev-parse --git-path MERGE_HEAD` from the worktree
  (`W:/AI Projects/Housing Choice/HC Application/.git/worktrees/flyer-leads/MERGE_HEAD`;
  `.git` here is a file); `git merge-tree --write-tree` exists (git 2.56.0);
  multiple `-m` on `git merge` concatenate as paragraphs; the gate-5 command
  and its empty-list guard match AGENTS.md; `npm run db:start` is idempotent
  (scripts/db.mjs:179-198); `npm run e2e:stop`, `typecheck`, `smoke`, `test`
  exist at the root.

## 1. MINOR - the `grep -n '\\u'` checks hit every line that contains a "u"

Plan location: section 10 C5 ("Also `grep -n '\\u' <FILE>` on any file
written with the Write/Edit tools: no NEW hit") and Task 6.2 Step 4
("`grep -n '\\u' e2e/tests/dashboard-next/flyer-leads.spec.ts` prints
nothing"); the same command is in plan section 0 (:39-40) and S3's
section C (:3635).

Evidence: typed in a Bash tool call, the doubled backslash reaches bash as
ONE (`printf '%s\n' 'A:\\s'` printed `A:\s`), and GNU grep reads an unknown
`\u` escape as a plain `u`. On a 2-line scratch file (one real backslash-u,
one plain line) `grep -c '\\u'` counted 2, `grep -cF '\u'` counted 1
(reference section 4). The plan's own S2 note already says so
(Task 2.4, plan :2799-2801: "use -F: without it Git Bash's grep reads the
pattern as a plain 'u'"). So Step 4's "prints nothing" can never hold for a
TypeScript spec, and C5's "no NEW hit" cannot be judged.

Correction: in C5, Task 6.2 Step 4 (and section 0, :3635) use
`grep -nF '\u' <FILE>`; expected for flyer-leads.spec.ts: no output (the spec
contains no backslash-u).

## 2. MINOR - Task 6.4 Step 2 expects one `**signed up**` hit in GLOSSARY.md; the edits produce two

Plan location: section 10 Task 6.4 Step 2 ("one hit each for
`flyer share entry`, `**signed up**`, `Signed up / No reply yet`,
`address heading`").

Evidence: step 1c's replacement line reads
"up since flyer-leads (2026-10-21; see **signed up** below). Interested ="
and step 1e adds the entry line "- **signed up** (the pin and the outcome;
...". GLOSSARY.md has no `**signed up**` today, so the grep prints two lines
after a correct build. The other three counts are right.

Correction: expect two hits for `\*\*signed up\*\*` (the 1c cross-reference
and the 1e entry), or check the entry alone with `^- \*\*signed up\*\*`.

## 3. MINOR - Task 6.5 Step 6 runs `npm test` with no hard outer timeout

Plan location: section 10 Task 6.5 Step 6
(`cd "W:/tmp/flyer-leads" && npm test > .superpowers/sdd/gates/npm-test.log 2>&1`,
run in the background).

Evidence: AGENTS.md "Required completion gates": "Use a hard outer timeout
for a suite that can wedge, then inspect/filter its captured output after the
command finishes." Step 8 caps the e2e gate (`timeout 2700`) and S5's exit
check caps its dashboard run (`timeout 1200`), but gate 2 - the DynamoDB
Local suite with the known contention history - has no cap, and a
backgrounded Bash tool command has no implicit limit.

Correction: `cd "W:/tmp/flyer-leads" && timeout 3600 npm test > .superpowers/sdd/gates/npm-test.log 2>&1`
(and the same cap on the `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test`
variant); exit 124 = the cap fired = a FAILURE to diagnose (stop any
leftover vitest workers), never a pass - as Step 8 already says for e2e.

## 4. NOTE - take the recorded gate exit codes from the logs, not from the background completion notice

Plan location: section 10 C3 ("The exit code is the tool's own (no `; echo`)");
Task 6.1 Steps 1/3 and Task 6.2 Steps 2c/3 ("Expected: non-zero exit" /
"exit 0"); Task 6.5 ("Quote every real exit code"; the S6-gates.md `exit`
column for gates 2 and 4, which run in the background).

Evidence: the user's standing lesson
(`C:\Users\Cameron\.claude\projects\W--AI-Projects-Housing-Choice-HC-Application\memory\never-pipe-gate-commands.md`):
on 2026-08-20 and 2026-09-02, four backgrounded gate runs notified
"completed (exit code 0)" while their logs ended in `npm error code 1` with
failed specs - "treat the notification's exit code as carrying NO
information about the gate". The plan's pass / fail VERDICTS already come
from the logs (C3's read grep, Steps 6 and 8's greps), which is right; only
the quoted exit codes are exposed.

Correction: in C3 and Task 6.5 Step 10, derive each recorded code from the
log - the `npm error code <n>` line (absent = 0) plus the Playwright /
vitest summary - or append `$?` to the log inside the same shell the way
S5's exit check writes its `exit=` line; never copy the notification's code
into S6-gates.md.

## 5. NOTE - Task 6.5 Step 2's dependency check omits one workspace

Plan location: section 10 Task 6.5 Step 2 (`git diff --name-only HEAD^1 HEAD -- package-lock.json package.json app/package.json dashboard/package.json e2e/package.json fake-twilio/package.json`).

Evidence: root package.json:9-15 lists five workspaces, including
`fake-twilio/web` (its own package.json with `test` and `typecheck`
scripts). Low risk - a dependency change there also changes
package-lock.json, which is in the list.

Correction (optional): add `fake-twilio/web/package.json` to the path list.

## 6. NOTE - R3 #7 and R6 F2 (Today) cite the client FALLBACK; the live Today is app/src/routes/today.ts

Plan location: plan 3.1 Invariant E (readers "inbox, unread feed"); the
adjudication of R3-s4 #7 and R6-public-sweep F2, which both cite
`dashboard/src/routes/today/buildToday.ts:287-316`.

Evidence: buildToday.ts is "the CLIENT-SIDE FALLBACK ... When GET
/api/today 404s" (buildToday.ts:1-5, :22-24; useToday.ts:54-67 falls back
only on a 404). The live board is GET /api/today
(app/src/routes/today.ts, router :331, mounted api.ts:1285): it walks the
same unread index as the inbox (iterateUnreadConversations from
lib/unreadFeed.ts, :704-760, cap TODAY_UNREAD_CAP 100 at :182) and emits each
unread tenant / landlord / partner 1:1 as `group: 'unreplied'` with
`why: 'Unreplied'` and `who` = the contact's live name, else the stored
display name, else the formatted phone (:819-836, whoOfConversation
:1089-1096); an unread `unknown_1to1` with a linked contact becomes
needs_you_now "New unknown contact" (:784-810). So the substance of both
findings stands - every sign-up, new or existing, appears on Today under
Unreplied, and an existing unknown contact's sign-up under Needs you now -
but R6 F2's scenario of the welcome text (or staff's last text) shown as the
reason line, and "every OPEN unknown_1to1 whatever its unread count", are
fallback-only behavior; the live row reads "<name> - Unreplied". No e2e
breaks: the only Today-content assertion outside reseeding specs,
scenarios/participant-names.spec.ts:46, reads the newest row under a cap of
100.

Correction: whoever rules on R3 #7 / R6 F2 cites today.ts:704-836 as the
live reader, and any GLOSSARY / handback sentence describes the live row
("a sign-up shows on Today under Unreplied as '<name> - Unreplied'").
