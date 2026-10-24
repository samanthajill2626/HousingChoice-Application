# Build worklist - today-checklist (tracker #31), Phase 1 delta research

Status: BINDING for every implementer. Adjudicated by the build orchestrator
2026-10-24 from nine read-only readers (D1-D7 = one per plan slice S1-S7,
E1 = whole-app writer sweep, E2 = whole-app reader/consumer sweep) run
against the tree at main @970a29b9. Sources, one per reader, in this
directory: `D1-S1-findings.md` ... `D7-S7-findings.md`,
`E1-writers-findings.md`, `E2-readers-findings.md`. Read the source entry
for the exact replacement text where an item below says "per <id>".

Precedence: where an item here and the plan disagree, THIS WORKLIST WINS.
Plan section 4 (rulings PR1-PR108) still binds everything this worklist
does not explicitly amend. No item below changes product behavior the spec
r8 states; every behavior question found is either a test/verification fix
or recorded residue (section "Recorded, no code").

Totals: 40 raised (3 BLOCKER, 2 MAJOR, 35 MINOR). 22 build items (WL-1 ..
WL-22) cover 31 of them; 1 is orchestrator-owned (D7-3); 7 are recorded
residue only (E1-2, E1-4 .. E1-8, E2-8); 1 is open for Cameron (E1-3,
non-blocking, built per spec as written). All three BLOCKERs were
spot-checked by the orchestrator against the tree and the plan text.

## S1 - the signal

- WL-1 (D1-1, MINOR) S1.6 Step 2: before RED, create
  `app/src/services/staffOutreach.ts` as a STUB (the `StaffOutreachStamp`
  interface and a `recordStaffOutreach` that returns `[]` and touches
  nothing; type-only imports as Step 3). RED then runs per case: six cases
  fail on their assertions; 'no stamps ...' and "'skipped' ..." stay green
  as PINs on the stub. Then write the Step 3 body. The stub is never
  committed on its own. Exact case list per D1-1.

Verified clean by D1 (no re-check needed): the fake/literal compile list
(5 ContactsRepo, 4 ConversationsRepo literals incl. the harness), the
S1.7 world.emitted pins (only contactTriage.test.ts:151 and :357), the
harness twins, the parity file's tables and helpers, per-commit typecheck.

## S2 - system_copy and direct writers

- WL-2 (D2-1, BLOCKER) S2.2 Step 1 adds edit "1a2":
  `app/test/groupSendRoute.test.ts:185` exact pin
  `expect(oneToOneCalls).toEqual([{ conversationId: 'conv-1', body: 'hello', automated: false }]);`
  gains `staffOutreach: true` (with a one-line ASCII comment citing W1 /
  PR10). It is a deliberate test change like PR50: list it in Step 2's RED,
  Files, Step 5 ASCII paths, Step 6 `git add`, C5/PR50's pin list, and the
  S2 report's "Deliberate test changes".
- WL-3 (D2-2, MINOR) S2.2 Step 2 expected RED reason for the three 1f
  cases and the 1k / 1m Send-now cases: they fail FIRST on the response
  status (500, not 201 / 200). Before 3a the /api default send service
  builds its own real contacts repo and its findByPhone throws under the
  harness (SendNotAttemptedError 'send not attempted: contact read
  failed'). That is the PR9 wiring gap these cases exist to catch: do NOT
  seed DynamoDB, inject a spy or change an assertion. After 3a they reach
  the stamp / marker assertions; green after 3b, 3c and 3c2.
- WL-4 (E1-1, MINOR) S2.6: the bridged masked relay call test (PR15(b))
  also asserts `world.reachedOutTouches` is empty for every callee (a
  member-to-member bridge is not staff outreach; spec 7.2 "calls that staff
  send themselves"). The S2 report adds a no-stamp row: "masked relay
  member-to-member bridge (voice.ts ~1243): no stamp". The relayed member
  TEXT is already pinned by S3's PR21 member-inbound-relay case.

## S3 - relay and group writers

- WL-5 (D3-1, MINOR) S3.1 1a and S3.3 1a each gain one case: stamps are
  collected but every touch is 'skipped' (no contact items seeded) -> zero
  after-loop `conversation.updated` and NO `getByIdConsistent` call. Exact
  cases, assertions and RED reasons per D3-1. S3.4's WI4 bullet cites these
  two test names for "zero when nothing was written".
- WL-6 (D3-2, MINOR) S3.3 1a's first relayAnnouncements case: the
  `sendPreparedMessage` spy returns a FIXED provider instant per leg; the
  test asserts the stamps equal those instants (not `legAt(...)`), so
  `at: providerTs` (the row's own same-named const,
  relayAnnouncements.ts:214) cannot pass in place of `result.providerTs`.
  Per D3-2.

## S4 - Today server

- WL-7 (D4-1, BLOCKER) S4.5 Step 3g new-text line 2 becomes
  `// PR26). The known-contact unread section is gone: a known contact's unread thread feeds only`
  and S4.5 Step 3k's second new-text line becomes
  `// AI-suggestions (spec 2026-10-23 2).`
  so the S4.5 Step 4 sweep (expects NO output) and the S4.8 Step 1 sweep
  (expects exactly ONE hit) hold as written.
- WL-8 (D4-2, MINOR) S4.7 Step 1f: the non-regression beforeAll also
  creates one AVAILABLE unit on the suite prefix with no sends (a separate
  id, e.g. 'unit-nonregression-avail'), so the Follow up core really calls
  listingSends.listByUnit on THIS prefix and a mis-wired listingSendsRepo
  goes red. quietShares stays { status: 'ok', properties: [], truncated:
  false }. Per D4-2.
- WL-9 (D4-3, MINOR) S4.4 Step 1 retitles three D5 cases whose assertions
  now read identify: todayApi.test.ts:1020, :1029, :1050 (titles per D4-3,
  ASCII).
- WL-10 (E2-4, MINOR) S4.5 also rewrites two app comments that still put
  unknown contacts on "Today's Needs you now" (comment-only):
  `app/src/lib/statusModel.ts:207-208` and `app/src/lib/unknownQueue.ts:63-65`
  -> "Today's Identify these contacts", and the unknownQueue comment
  describes the owner rule (PR26), not the removed Inactive skip. Add the
  two files to S4.5's Files and `git add`. (S7.1's app/src re-grep also
  adds the pattern "Needs you now".)
- WL-11 (E2-5, MINOR) S4.6 / S4.8 header text: the planned today.ts
  header must NOT list `tours listByStatus('requested')` under "every list
  read is a bounded Query". Word it honestly: "Tours to book pages the
  whole requested partition - uncapped by design (spec 5.4; prod 13)". No
  cap, no WARN, no row dropped. S7.14's quiet-shares cost issue names this
  read too.
- WL-12 (E2-6, MINOR) Wherever the plan states "listing sends is a
  base-table Query" as outside the eventual-consistency residue (PR90/WI8,
  the S4 route comment, the S4 report, the S7 cost issue), say instead:
  "listing sends is a base-table Query read WITHOUT ConsistentRead, so the
  Not interested drop-off (no event; the remount refetch) can read the
  pre-decline row once - same residue class". No code change.

## S5 - dashboard Today

- WL-13 (D5-1, MINOR) S5.6 Step 2 RED list exceptions: 'no At a glance
  section when both of its parts are empty' is GREEN on the old page (a
  pin of the new rule, not a RED); 'a failed section load says so in the
  section and leaves the rest of Today alone' IS RED on the old page (the
  old GROUP_META never renders its identify fixture).
- WL-14 (D5-2, MINOR) S5.7 Step 4 (and S8 gate 5): expect exactly ONE
  lint error, pre-existing at main @970a29b9:
  `dashboard/src/routes/tours/useTours.ts:128 react-hooks/set-state-in-effect`
  (useClosedTours, not touched by S5). Confirm it by baseline (lint the
  merge-base copy), name it in the S5 report, leave it. Any other error is
  S5's and blocking.
- WL-15 (D5-3, MINOR) S5.7 Step 1's expected grep hits in
  buildToday.test.ts also include the S5.4 1f comment ("Was a tenant_1to1
  Unreplied row; ...") - it records the removal; not a defect.
- WL-16 (D7-4, E2-2, MINOR) The S5 cross-slice note wins over S7.1: Tours
  today is an h3 under the At a glance h2 (PR65). S7 rewrites
  `e2e/support/selectors.md:18` and the `e2e/support/today.ts:11` comment
  to say so (substring-trap advice unchanged); the stale comment-only
  `<h2>Tours today</h2>` mentions (tours-page.spec.ts:46,183,259,
  tour-roster.spec.ts:73) are fixed in the same commits or recorded as
  stale-but-harmless in the S7.1 table.

## S6 - backfill

- WL-17 (D6-1, D6-2, MINOR, report text only) S6.4 Step 5: extend the C2
  bullet - the backfill names the thread's write-once participants
  contactId first (heardFrom.ts:94-104); live W1 (sendMessage.ts:493/:511),
  W5 (groupSend.ts:322-324) and W6 (voice.ts:1315) judge the phone's CURRENT
  holder, so with stale participants a text, group-text member or call can
  be stamped on a different contact than live; accepted approximation
  (PR38 order). In the checked list cite voice.ts:1676 (outbound press-1)
  and voice.ts:1961 (Dial in-progress fallback, later instant) as the
  outbound answered_at writers; drop :1747 (inbound accept).
- WL-18 (E2-7, MINOR) S6.3 RUNBOOK entry gains one step BEFORE the dry
  run: "After the deploy, reload every open dashboard tab (Sam, the VA): a
  tab loaded before the deploy runs the old Today page, which drops the new
  Identify these contacts and Tours to book rows." The S8 handback repeats
  it.

## S7 - e2e, rehearsal, docs

(WL-16 above is an S7 edit too.)

- WL-19 (D7-1, BLOCKER) S7.15 step 2 (and the orchestrator's S7.16 step
  1): wait for the launcher's anchored ready line,
  `grep -q '^\[e2e-session\] ready ' <session.log>` (scripts/e2e-session.mjs
  :832 via the log prefix ~:345), never `grep -q "ready"` (matches
  "db:start - ... already running" and "fake-twilio ready").
- WL-20 (D7-2, MAJOR) S7.2: `openWatchingToday` registers
  `today.waitForResponse((r) => new URL(r.url()).pathname === '/api/today' && r.status() === 200)`
  BEFORE `goto` and awaits it after the event stream opens; test 4 asserts a
  positive control (the Placements list visible - lean placement-0001 is
  always a derived stuck row) and only then `toHaveCount(0)` on Tours to
  book, before creating the tours. RED B then fails deterministically.
- WL-21 (D7-5, D7-6, D7-7, D7-9, D7-10/E2-1, D7-11/E2-3, MINOR) S7 edits:
  - S7.14 also RESOLVES `docs/issues/fact-extraction-spec-vacuous-today-absence-checks.md`
    (status resolved + the resolved date + a Resolution paragraph naming
    expectNoAiSuggestionFor and its S7.5/S7.6 call sites - follow
    docs/issues/README.md / scripts/issues.mjs for the exact fields; never
    `closed`), adds it to the S7.14 `git add`, and RETITLES
    `imported-unknown-threads-surface-as-unknown-on-today.md` to its
    remaining problem (the threads stay unknown_1to1; only the 404 fallback
    still lists them, under Identify these contacts).
  - S7.14 step 7: `npm run issues` prints totals only; check the open total
    rose by one, no warning names today-quiet-shares-read-cost.md, and
    `grep -n "today-quiet-shares-read-cost" docs/issues/INDEX.md` prints one
    `| low | improvement | open |` row (INDEX.md is gitignored; never commit
    it).
  - S7.2 step 8 RED B: `--grep "requested tours appear live"` (test 4 only);
    expected `1 failed`, no passed line.
  - The S4 cross-slice note (plan ~21322) is wrong after PR103: the as-built
    check compares against `quietShares: { status: 'ok', properties:
    [{ unitId, unitLabel, people: [...] }], truncated }` - no top-level
    `people`. Do not record a deviation for it.
  - S7.9 also: `expectRtaDeadlineOnBoard` and `expectVoucherDeadlineOnBoard`
    (e2e/scenarios/steps.ts ~3087, ~3153) call `showAllIn(page, 'Needs you
    now')` first and select the list with `{ name: 'Needs you now', exact:
    true }`; `expectPlacementGoneFromBoard` (~3103-3116) first asserts on
    GET /api/today server truth that no items[] row has refType 'placement'
    and refId = the id (a non-200 throws), then keeps its DOM count.
    `e2e/tests/flows/email-triage.spec.ts:64-66` check (b) asserts, after
    the Today fetch has landed, that no /api/today items[] row's `who`
    matches the stranger address (server truth first), then keeps its DOM
    count. Add both files to the S7.1 table.
  - S7.11 step 4 also re-cites `CONTRACT_SOURCE_LEDGER.background.today`
    (e2e/performance/routes.ts ~872) to the as-built REFETCH_DEBOUNCE_MS
    line and useEventStream block in useToday.ts, updates the exact pin at
    `e2e/performance/collect.test.ts:371` to the same string, and adds that
    file to the S7.11 files and `git add`.
- WL-22 (D7-8, MINOR) S7.15 ENDS by stopping its lane (`npm run e2e:stop`,
  then prove the lane ports free) BEFORE committing its report section.
  S7.16 (live self-QA) is NOT the implementer's: the orchestrator runs it
  later on a fresh lane at the final commit. The implementer skips S7.16
  entirely and writes "S7.16: orchestrator-owned (Phase 5)" in the S7
  report.

## Orchestrator-owned (not in any implementer brief)

- S7.16 self-QA world (D7-3): plant Later at 5 days, not 7 (spec 6.3 orders
  properties by the oldest quietSince; 7 days would put u2 first and open).
  Expect u1 open ("2 people: 1 replied, then quiet - 1 never replied") and
  u2 folded ("1 person: 1 never replied").

## Recorded, no code (each goes in the named slice report; the handback lists them)

- R-1 (E1-2) W2 gate keeps `original.automated !== true` (matches spec 7.5's
  backfill "automated not true"). Residue, recorded beside PR108 in the S2
  report: a failed automated row written before retry-send-window
  (2026-09-24) carries no `automated` field, so a staff Retry of it after
  this deploy stamps, and so does a Retry of that Retry. Rare (Retry only on
  failed chain-newest rows; every such row predates 2026-09-24) and ages out
  of Quiet shares in 14 days.
- R-2 (E1-4) W6 stamps the contact `findByPhone` resolves for the target
  phone (first match on a duplicated number - findByPhone's documented
  risk, the same ambiguity W1 has). Not changed: writing
  recipient_contact_id on call rows would change how call rows attribute
  on shared threads, outside this spec. S2 report.
- R-3 (E1-5) Staff Do Not Contact toggle, phone add/edit/remove, the
  /status 30005/30006/21610 flags and the share fan-out's unreachable flag
  make a quiet-share person ineligible with no event Today hears. Same
  reasoning as spec 8's Not interested ruling (made on the contact page;
  returning to Today remounts and refetches; another open tab catches up on
  its next refetch); no wrong send can follow (the send gates refuse). No
  event added. S4 report.
- R-4 (E1-6) A re-share of the same property updates the pair's sentAt
  after the share text's conversation.updated; an open Today can keep the
  row until its next refetch. Narrow race; re-share is unchecked by
  default. S4 report.
- R-5 (E1-7) A multi-batch relay MMS (api.ts ~1439-1482) is N fan-out jobs,
  so W4 emits N after-loop events (forward-only stamps, harmless). WI4
  table in the S3 report.
- R-6 (E1-8) On the four "touch first" inbound paths (twilio.ts 1:1, relay,
  group, closed group) the conversation.updated fires only on a fresh
  append with a successful touchLastActivity; a heard-from touch on a
  redelivery or a failed touchLastActivity has no event. Pre-existing; the
  S2 inbound-order table records it.
- R-7 (E2-8) The worker's after-loop conversation.updated is built fresh but
  delivered over the fire-and-forget bridge, so an API-side event can
  overtake it; ThreadUnreadToggle / ContactDetail set unread from the
  payload. The fresh read narrows, not closes, the window - same residue as
  the existing worker emits. S3 report.
- R-8 (E2-6) see WL-12 (listing sends not ConsistentRead).
- R-9 (E2-7) see WL-18 (reload open dashboards after the deploy).
- R-10 (E1-1) team_member contact on a relay roster calling / texting from
  their own cell is staff reaching contacts and is not stamped. Rare. S3
  report.
- R-11 (E2 item 2c) the Tours page and the contact Tours card do not
  subscribe to tour.updated, so a create does not live-update them -
  pre-existing, not this mission's surface. Handback note only.

## Open for Cameron (non-blocking; built per spec as written)

- Q-1 (E1-3, raised MAJOR) W3 stamps only the To contact ("the addressed
  contact", spec 7.3). A contact on CC (sendEmailMessage.ts ~282-287,
  ~450) receives the staff email but is not stamped, so a CC'd caseworker
  with a quiet share stays listed. Built as specced (the safe direction for
  a checklist: the row stays visible). If Cameron wants CC to count, it is
  a small follow-up (resolve each CC by findByEmail, stamp in the same
  recordStaffOutreach call, one contact.updated per written id) plus the
  matching backfill rule for `email_cc`.
