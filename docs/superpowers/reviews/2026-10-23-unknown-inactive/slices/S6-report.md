# S6 slice report - e2e spec, docs, W3 (tracker #30)

Branch feat/unknown-inactive. Commits: 5809b2ad (S6.1 spec + selector rows),
8152f3bf (S6.2 STATUS-MODEL section 5b), 6e0b23d9 (S6.3 GLOSSARY), plus this
report. No app or dashboard source is changed by S6: every RED edit below was
made and undone with the Edit tool, and the tree was clean after each restore.

## W3 - the dashboard Today fallback (buildToday.ts): UNCHANGED, as spec D5 rules

- It runs only when GET /api/today answers 404
  (dashboard/src/routes/today/useToday.ts:57-59; the fallback assembly is
  :60-72, buildTodayFromSources at :67).
- The router is mounted unconditionally, at the top level of
  createApiRouter (app/src/routes/api.ts:1285-1286). Its only handler
  (app/src/routes/today.ts:331) answers 200 or 400 (:338, :347). The file
  has no other `res.status(` and no 404.
- So against this backend the fallback never runs. It would run only
  against an app build with no Today router, i.e. a dashboard deployed
  ahead of a much older app.
- In that case it would still list an Inactive unknown contact's thread as
  "New inbound - untriaged" (dashboard/src/routes/today/buildToday.ts:287-299;
  the source string carries an em dash). ConversationSummary
  (dashboard/src/api/types.ts:561-580) carries no contact status.
- Plan anchor drift only: the api.ts mount is :1285-1286 (plan :1284-1285)
  and buildToday.ts is :287-299 (plan :286-299). No new 404 path and no
  conditional mount, so no STOP.

## e2e runs

Each run used `bash .superpowers/s6/run-spec.sh <tag> <specs>` through the e2e
workspace, launched with the Bash tool's run_in_background and waited on
in-turn. The verdicts below are quoted from `<tag>.log`; the exit codes are
from `<tag>.exit`. Every run booted its own lane 4 (ports 9401 / 9411 / 9421 /
9431); this machine boots it in about 10 s.

| Run | Tree | Exit | Log verdict | Wall (UTC) |
|---|---|---|---|---|
| green1 | as committed | 0 | `1 passed (13.1s)` (test 2.1s) | 20:54:12-20:54:26 |
| red1 | AR8 `continue` commented out, app/src/routes/today.ts:768 | 1 | `1 failed` (test 11.6s) | 20:55:16-20:55:38 |
| red2 | useInbox.ts:176 Unknown arm uses compareByActivity | 1 | `1 failed` (test 1.6s) | 20:56:15-20:56:28 |
| green2 | restored; six files | 0 | `36 passed (42.7s)` | 20:56:58-20:57:41 |
| red3 (extra) | ContactsList.tsx:280 returns `queried` for Unknown | 1 | `1 failed` (test 2.1s) | 21:01:38-21:01:51 |
| green3 | restored; the spec alone | 0 | `1 passed (12.0s)` (test 2.0s) | 21:02:20-21:02:32 |

- red1 failed in step (9), exactly as planned, at
  e2e/tests/dashboard-next/unknown-inactive.spec.ts:324 (the toPass at
  :326): `expect(received).not.toContain(expected)`, "Expected value: not
  <idA>", "Received array: [<idA>, <idB>]", "Timeout 10000ms exceeded while
  waiting on the predicate". Steps (1)-(8) passed.
- red2 failed in step (7) at spec:298: "Needs review must sort above
  Inactive: [<A href>, <B href>]", `Expected: < 0`, `Received: 1`. So atB
  was 1 and atA was 0. Steps (1)-(6) passed, OR-1's assertion included.
- red3 is NOT in the plan. I added it because OR-1's new e2e assertion had
  never been seen to fail. It failed in step (6) at spec:280: "Needs review
  must list above Inactive: [<A href>, <B href>]", `Expected: < 0`,
  `Received: 1`. That proves the assertion discriminates. It also confirms
  OR-1's premise through the real stack: without `inactiveLast`, the
  server's byTypeStatus answer lists the Inactive contact first.
- green2, test by test: ai-run-log 9/9, caseworkers 6/6,
  inbox-rows-timestamps 6/6, unknown-caller-triage 2/2, unknown-inactive
  1/1, conversation-fact-extraction 12/12. No pinned spec failed, so no
  green2-artifacts copy or alone re-run was needed. The red1 and red2
  failure artifacts are kept, gitignored, under
  `.superpowers/s6/red1-artifacts/` and `red2-artifacts/`.
- Restores: after each RED, `git diff --exit-code -- <file>` exited 0 for
  today.ts, useInbox.ts and ContactsList.tsx. The bare `git status` then
  showed only the uncommitted S6.1 files (before green2) or a clean tree
  (before green3).
- green3 re-proves the final source after red3's restore. Only docs
  commits landed after green2.
- No `[dynamoAdmin]` line in any of the six logs (0 each). No exit 124.
- The dashboard e2e build is `vite build` with no tsc step
  (scripts/e2e-session.mjs:518-532), so red2's now-unused
  `compareUnknownTabRows` import still built.

## Contradiction 1 and AR19 pins

- caseworkers.spec.ts: no edit needed (plan S6 Contradiction 1 held). All 6
  passed in green2, including :503 (Mark as Caseworker on an inbound unknown's
  "Needs triage" card -> Active) and :229 (the conversion).
- ai-run-log.spec.ts:66-70 creates an unknown contact with no status, which
  is now needs_review rather than active. All 9 passed in green2.

## As-built names

Every name matched the plan's `UI` object, so the object is unchanged:
- ContactDetail.tsx:1031-1040: StatusMenu, `label="Contact status"`.
- StatusMenu.tsx: the trigger's aria-label is `${label}: ${currentLabel}`;
  the menu is role=menu with aria-label `label`; the items are
  menuitemradio.
- UnknownFile.tsx:104: the card title.
- InboxRow.tsx:137: a plain span reading `Inactive`.
- Inbox.tsx:382: `aria-label="Conversations"`.
- useInbox.ts:176: compareUnknownTabRows.
- ContactsList.tsx:280: inactiveLast.
- today.ts:763-769: the AR8 skip.

## Divergences from the plan text

- Spec:
  - A `rowHrefs` helper (spec:157) serves both step (6) and step (7). It
    replaces step (7)'s inline evaluateAll; the technique is the same.
  - The header comment names the Contacts > Unknown order.
  - The step (6) comment says "labeled".
- run-spec.sh uses /w/tmp paths and also writes `<tag>.start` / `<tag>.end`.
  Launch was by the Bash tool's run_in_background (per the dispatch), not
  nohup/disown.
- STATUS-MODEL 5b:
  - "A save or PATCH that keeps the contact's current type is not a type
    change: it moves no status on its own", where the plan said "leaves
    the status alone". A same-type PATCH that carries an explicit status
    still writes it.
  - "(unknown, active) is refused by every status writer" now carries a
    pointer to docs/issues/import-bypasses-contact-type-rules.md. The
    import re-type keeps a staff-set status, so it can still store the
    pair: app/src/lib/import/apply.ts:1142-1146 and :1165-1166 against
    :1218-1223 (S1 report item 3).
  - Adds "Contacts > Unknown likewise lists its Needs review contacts
    before its Inactive ones" (OR-1 changed that view).
- GLOSSARY:
  - The "signed up" entry also gains "(unknown contacts included; never an
    **Inactive** contact, see **waiting on a reply**)" at :698-699. D4.1
    made "back on Follow up once quiet (unknown contacts included)"
    incomplete for an Inactive unknown.
  - The Inactive entry carries OR-1 and OR-16.

## WORKLIST items

- OR-1: step (6) asserts the Needs review row above the Inactive row on
  Contacts > Unknown (spec:276-280), the same href-order technique as step
  (7). RED-proven by red3.
- OR-15: no British spelling in any added line. A case-insensitive grep for
  the British spellings of color, labeled, behavior, favor and organize
  prints 0 for the spec, selectors.md, STATUS-MODEL.md and GLOSSARY.md. The
  plan text spelled two words the British way (S6.2 items 4 and 5, and the
  spec's step (6) comment); they are written "color" and "labeled".
- OR-16: STATUS-MODEL 5b's second difference and the GLOSSARY Inactive entry
  both say two things. An Inactive team member leaves Needs you now: its 1:1
  threads are unknown_1to1, and the skip keys on `conv.type`
  (app/src/routes/today.ts:763-769). An Inactive tenant's or partner's
  unread text still shows under Unreplied (the tenant_1to1 / partner_1to1
  arm, today.ts:837-839, :853).
- OR-17: the Unknown-feed unread poll follows the step (8) Unread poll
  (spec:310-313). It passed in every run (step (8) also passed in red1).
- OR-18: the stack-free check ran before every run.
  - Before green1 there was no session.pid or lane.json (this worktree had
    no prior e2e run).
  - Each finished run left a stale session.pid and lane.json.
    `npm run e2e:stop` answered "no running session found; retained state
    is stale or absent" and removed both.
  - Then `Get-NetTCPConnection -State Listen` found no listener on 9401,
    9411, 9421 or 9431. That held before red1, red2, green2, red3 and
    green3, and after green3.
- OR-20: the added lines against 916258ae have 0 non-ASCII bytes in
  selectors.md, STATUS-MODEL.md and GLOSSARY.md. The new spec and this
  report have 0.
- OR-22: I read a bare `git status` before every `git add`. Nothing was
  staged that I had not staged.

Other checks:
- e2e workspace `tsc -p tsconfig.json`: exit 0.
- `npx eslint e2e/tests/dashboard-next/unknown-inactive.spec.ts`: exit 0.
  The config covers it (`**/*.ts` and `**/*.spec.{ts,tsx}`; print-config
  returns rules).
- Untrimmed input paths: none (no input added).
