# Plan review A - adversarial, plan-vs-tree

Plan: `docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md`
Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`
Tree read at worktree HEAD `5f6bccaa` (plan claims line numbers as of `b702a81c`;
every source line number the plan cites was re-checked and matched unless noted).

Question answered: if a builder with no context executes this literally, do they
produce the spec? Not yet. Three steps cannot run at all, one test cannot go red
for the stated reason, and one spec requirement is both undelivered and forbidden
by the plan's own constraints.

---

## BLOCKING

### 1. Task 3's test code is written against a harness that does not exist

`app/test/inboxGroups.test.ts` drives the aggregator DIRECTLY - there is no
Express app, no supertest, no `res.body`. Every existing test is
`const page = await aggregateInbox({ filter, limit }, deps)` then `page.rows`
(`app/test/inboxGroups.test.ts:195`, `:233`, `:409`, `:422`).

The plan's Task 3 Step 1 code calls `await get(deps, '/api/inbox?filter=groups')`
and reads `res.body.rows`, and builds fixtures with `groupText(...)` and
`relayGroup(...)`. Against the tree:

- `get(...)` does not exist in that file in any form.
- `relayGroup(...)` does not exist; relay rows are seeded as raw object literals
  cast `as ConversationItem` (`app/test/inboxGroups.test.ts:396-406`).
- the group builder is `groupConv(...)` (`app/test/inboxGroups.test.ts:132`), not
  `groupText(...)`.

The plan explicitly instructs "reuse their helpers verbatim (they exist under
some name; do not invent a parallel harness)". Two of the three do not exist
under any name. A literal execution produces a `ReferenceError`, and the Step 2
"Expected: FAIL with `'With Old A & (555) 010-0002'`" is unreachable - the
builder learns nothing about whether the change works.

Implies: rewrite Task 3 Step 1 against `aggregateInbox`/`page.rows` and
`groupConv`, and state the relay seed shape (`status`, `relay_status`,
`pool_number`) inline, since the fake's `listRelayGroups` reads `relay_status`
(see finding 4).

### 2. Task 9's e2e flow throws before it reaches any assertion

`teamOpensTourGroup` opens with `const tour = this.requireActiveTour();`
(`e2e/scenarios/steps.ts:1859-1861`), and `requireActiveTour`
(`e2e/scenarios/steps.ts:3725-3728`) throws
`no active tour - call teamCreatesTourFromInterest first` when `activeTour` is
unset. `activeTour` is only written by `teamCreatesTourFromInterest`
(`e2e/scenarios/steps.ts:1830`).

The plan's spec goes `tenantAsksToTour(unit)` -> `teamOpensTourGroup('tour')`.
`tenantAsksToTour` (`e2e/scenarios/steps.ts:1759-1774`) only sends an inbound SMS
and asserts it on the timeline; it creates no tour. The spec throws on its fourth
step.

Implies: insert `await flow.teamCreatesTourFromInterest(unit, <type>)` (and, if
the `'tour'` intro variant is really wanted, whatever books a time), or drop to a
variant the flow can actually reach.

### 3. Task 9's group-header assertion can never pass

The relay group view renders the literal string `Relay group` in a `<span>`
(`dashboard/src/routes/conversation/ConversationDetail.tsx:403`) and the member
names in a plain `<div className={styles.facts}>` (`:406`, value computed at
`:390-393`). Nothing on that page carries `role="heading"` with a member name in
its accessible name.

The plan asserts
`page.getByRole('heading', { name: new RegExp(renamed.firstName) })`. That
matches zero elements regardless of whether the implementation is correct, so the
one surface the founder actually reported ("group titles do not change") is
asserted by a selector that cannot see it.

Implies: assert on the facts line by text, or add a real heading, and say which.
Note also that on this view the names arrive from `/members`
(`ConversationDetail.tsx:198-206`) - i.e. Task 5's route - not from the thread
header the spec excludes, so the assertion is testing Task 5 whatever selector is
used. Say so, or the e2e proves less than it appears to.

---

## HIGH

### 4. Task 2's close-nag fixture is invisible to the fake it must be found by

The plan's `seedConversation` fixture sets `relay_status: 'open'`. The fake's
`listRelayGroups` filters on `c.relay_status === 'relay_group#' + status`
(`app/test/helpers/twilioWebhookHarness.ts:777-779`) - deliberately, with a long
docblock at `:757-776` about the drift that filtering on `status` used to hide.
`'open' !== 'relay_group#open'`, so the row never reaches the close-nag block and
`body.relayCloseNags` is empty.

The test therefore fails identically before and after the implementation, with
`nag === undefined` rather than the stated `'Old Nag'`. The plan gestures at the
right check ("if the harness's `listRelayGroups('open')` needs `relay_status`
... check `grep -n listRelayGroups ...`") while supplying the wrong value, which
is worse than supplying none: a builder who reads the hedge as already-done will
chase the empty array into `today.ts`.

Implies: `relay_status: 'relay_group#open'`. The correct shape is already modelled
in `app/test/contactRelayGroups.test.ts:89` with the reasoning attached.

### 5. Task 5's relayApi test references constants that do not exist

The plan says "`ALICE`, `BOB`, `CAROL`, `POOL` exist near its top - confirm with
grep". The file declares `ALICE` and `BOB` only
(`app/test/relayApi.test.ts:34-35`). `CAROL` exists solely as a `const` inside a
nested describe (`app/test/relayApi.test.ts:1076`) and is not in scope at the
insertion point. `POOL` does not appear in the file at all.

The pasted test does not compile. Implies: declare the two phones locally, or use
`ALICE`/`BOB` plus a literal.

### 6. Task 5 definitely breaks two named existing tests; the plan treats it as a maybe

Task 5 deletes the `delete memberWithoutStoredName.name` behavior, so a member
whose contact is unnamed or unreadable now keeps the stored roster name. Two
existing tests pin the opposite, by construction and by title:

- `app/test/relayApi.test.ts:427` "GET roster drops the creation-time name when
  the current contact is unnamed" - expects `[{ contactId, phone }]`, will get
  `name: 'Old roster name'`.
- `app/test/relayApi.test.ts:450` "GET roster falls back to the roster phone, NOT
  a stale name, when contact lookup fails" - same expectation, and its title is
  the exact product ruling this branch reverses.

The plan's only coverage is a conditional aside in Task 5 Step 5 ("If an existing
members-route test asserted ... update that expectation"). That is not a
discovery; it is a certainty, it is two tests, and one of them is a deliberate
prior decision. A conditional invites a builder to "fix the test" without
noticing they overturned a ruling.

Implies: name both tests in Task 5, state that the second's TITLE and comment
must be rewritten (not just its expectation), and require the reversal in the
commit body and the handback.

### 7. Spec S3's `rosterEdits.ts` amendment is undelivered and forbidden by the plan's own constraints

Spec section 5 S3 requires: "Amend `rosterEdits.ts:425-441`, which says recipients
carry 'backfilled' names." The comment is real -
`app/src/services/rosterEdits.ts:441` ("... may be backfilled from the contact and
so differ from the body name"), and a second instance at `:455`. After Task 6 the
precedence inverts, so the comment becomes wrong.

No task amends it. Worse, the plan's Global Constraints (plan `:19`) say
"Do not edit: ... `services/rosterEdits.ts` source (its test pins may move)".
A builder following the plan literally is *forbidden* from delivering a spec
requirement. The plan's own Self-review claims full S3 coverage.

Implies: either carve the comment out of the do-not-edit line, or drop the
requirement from the spec - but the two documents cannot both stand.

---

## MEDIUM

### 8. Task 4 makes three batch reads per relay card, not the "1 batch per card" the spec promises

The relay-groups route wraps its match loop in
`for (const status of ['open', 'connecting', 'closed'] as const)`
(`app/src/routes/contacts.ts:1189`). The plan's replacement puts
`const mine = ...` and `const names = await resolveRosterNames(mine, contacts, log)`
INSIDE that loop, so the card costs up to three `getDisplaysByIds` round trips.
The spec's section-3 table row says "1 batch per card, ids collected AFTER the
membership filter" and the net-cost sentence beneath it is priced on one.

Not a correctness bug, but the plan's Task 4 test asserts only that `'c-out'` is
absent, so nothing catches the drift, and the handback will claim a cost the code
does not have.

Implies: hoist the three partition reads, filter once, batch once - or amend the
spec row to "up to 3".

### 9. Spec S5 names two audit sites; Task 8 touches one

Spec section 3 row S5 cites `scripts/measure-unread-contact-coverage.ts:510` and
`:785`. `:510` is `auditDenorm`'s group skip
(`app/scripts/measure-unread-contact-coverage.ts:473`, skip at `:509-510`); `:785`
is the identical skip inside a DIFFERENT mode, `auditTabVsPartition`
(`app/scripts/measure-unread-contact-coverage.ts:763`). Task 8 modifies
`auditDenorm` only and never mentions `:785`.

Implies: either deliver it or record in the plan that `:785` is out and why (spec
section 5 describes only the denorm walk, so this may be a spec table error - but
the plan must say which).

### 10. Task 8's tally ignores `deleted_at`, so its headline number overstates the branch

`tallyRosterDrift` classifies purely on `contactDisplayName(contact)` vs the
stored name. The display projection carries `deleted_at`
(`app/src/repos/contactsRepo.ts:301`, fake at
`app/test/helpers/twilioWebhookHarness.ts:1664`), and this branch's own chain
(plan Global Constraints `:17`, `withLiveNames`) says a soft-deleted contact
supplies NO name - the stored snapshot stands.

So every roster member whose contact is soft-deleted and renamed counts as
`nameDrift` in the audit while the branch deliberately changes nothing for them.
That number goes in the handback as the evidence for the whole mission.

Implies: skip `isDeleted(contact)` members, or give them their own counter.

### 11. Task 8's audit cannot tell a throttled read from a dangling contactId

The plan states in two places that `getDisplaysByIds` returns a SHORT map on
throttle and that the repo swallows a thrown chunk (plan `:236`, spec `:99-101`).
`auditGroupRosters` folds every chunk into one map and hands it to
`tallyRosterDrift`, which reports `contacts.get(id) === undefined` as
`danglingContactId`. A partial read is reported as data corruption, silently, in
a number the handback publishes.

Implies: count requested ids vs returned entries and print the delta, or fail the
audit loudly when they differ.

### 12. Nothing tests the part of S5 that was actually broken

Spec section 6: "Audit: group pass counts a seeded stale roster from BOTH
sources." The whole point of S5 is that the existing walk reads the `'open'`
partition and therefore never sees a `group_text` (status `group_open`) or a
closed relay. Task 8's only test exercises the PURE `tallyRosterDrift` against
hand-built arrays; nothing exercises the `listGroupTexts` + `listRelayGroups`
sourcing that is the defect. The one-off lane run in Step 5 asserts only "the two
blocks print and it exits 0".

Implies: a test (or a scripted lane check with expected counts) that seeds one
group_text and one closed relay and proves both are counted.

### 13. Task 7 changes SPOKEN outbound content, which spec decision 6 puts out of scope

`maskedPartyLabel` feeds two consumers, not one. `calleeLabel` becomes the
persisted `call_party_label` (`app/src/routes/webhooks/voice.ts:985-986`,
`:1011`), but `callerLabel` (`:991`) rides the whisper URL and is SPOKEN to the
callee before the bridge (`:1029-1033` and the whisper handler). Masking the
stored roster name therefore changes what a real person hears - "Bob B." where
they used to hear "Bob Builder".

Spec decision 6 says "Outbound message content is out". Spec S4 authorizes the
mask for the persisted label and never mentions the whisper. Task 7 has no test
pinning the whisper text and no note that it moved.

Implies: state the whisper change explicitly and pin it, or restrict the mask to
the persisted label.

### 14. Spec section 6 asks for unique-id assertions; the plan asserts call counts

Spec: "assert UNIQUE ID count passed to `getDisplaysByIds`, not call count."
Task 3 asserts `expect(calls.displayBatches).toHaveLength(1)` and Task 5 asserts
`expect(batches).toHaveLength(1)`. Both are call counts. (Task 3 does also assert
the id set; Task 5 does not.) Given finding 8, a call-count assertion is exactly
the pin that would have caught the three-batch relay card - and it is absent from
the one task that needed it.

### 15. The merge-base audit run is not in the plan

Spec section 5 S5: "Run at the merge base and at handback; both numbers go in the
handback." Task 8 Step 5 runs the script once against a seeded e2e lane;
Task 11 Step 3 asks for "the audit numbers from Task 8 Step 5" - singular. There
is no merge-base run anywhere, so the before/after comparison the spec asks for
cannot be produced.

---

## LOW

### 16. Two of Task 2's five tests are green before the implementation

- "an unreadable contact keeps the stored name": today `whoOfConversation` already
  returns `participant_display_name` (`app/src/routes/today.ts:1075-1079`), so
  `'Stored Name'` is what HEAD returns.
- "resolving names adds NO contact reads": `isDeletedContact`
  (`app/src/routes/today.ts:377-380`) already goes through the memoized
  `getContact` (`:357-369`) and is called once per unread 1:1 (`:743`), so the
  distinct-read count is already 1.

Both are legitimate regression pins, but the plan's Step 2 says "Expected: FAIL"
and names only three failures. Spec section 6 opens "TDD, red before green".
Label them as pins so a builder does not go hunting for a red that cannot happen.

### 17. Task 2's `ownerId` note points at the wrong loop

The plan says "(`ownerId` may already be declared in that loop from the deleted
check at `:742`; if so, reuse it and drop the redeclaration.)". `:742` is inside
the unread-INDEX walk that fills `unreadOneToOne`; the `who` call site at `:778`
is inside the later `for (const conv of unreadOneToOne)` loop. They are different
scopes. A builder who "reuses" it as instructed gets an undefined identifier.

### 18. Task 1's `ContactItem` import question has one answer, not two

`app/src/lib/contactName.ts:7` imports `ContactItem`, and its only use is
`contactDisplayName`'s parameter at `:67`. The widening therefore ALWAYS orphans
that import and always trips gate 5 on a file the branch touched. The plan poses
it as a check ("Check: if `ContactItem` is now unused, delete the import line").
Just say delete it.

### 19. Task 1 Step 2's stated red is half unreachable by its own command

The appended `contactName.test.ts` case passes at RUNTIME today - vitest strips
types via esbuild and `contactDisplayName` reads `contact['firstName']`. Only
`npm run typecheck` is red, and Step 2's command is `npx vitest run ...` with no
typecheck. As written the builder sees one failure (unresolved module) and a
green contactName file, then reads the step's prose as if that were the plan.

### 20. Task 9's spec body uses a private method the trailing note says to replace

The spec calls `flow.requireActiveTourGroup().groupThreadId`;
`requireActiveTourGroup` is `private` (`e2e/scenarios/steps.ts:3765`). The
trailing note says "if so, expose a one-line public `activeTourGroupId()`" - so
the code as pasted does not compile, and Step 1's "Files: one new public step"
undercounts the steps.ts edit. Put the accessor in Step 1.

### 21. Spec section 6's "unlinked renders phone" Today case has no test

Spec section 6 lists four Today cases: renamed contact renders new name;
unreadable contact renders stored; UNLINKED renders phone; `getById` count
unchanged. Task 2 delivers the first, second and fourth plus a
"no stored name + named contact" case. Nothing covers a thread with no
`contactId` at all falling through to `formatPhoneForDisplay` - the exact rung the
founder symptom ("Today shows a phone number") lives on.

### 22. Task 7 never names the group-push test file

Task 7 Step 1 outsources it to `grep -rln "pushSenderLabel\|group.*push" app/test`.
`pushSenderLabel` is a private function in
`app/src/routes/webhooks/twilio.ts:307` and appears in no test, so only the loose
half of the alternation does any work; it returns four files. The target is
`app/test/inboundMessagePush.test.ts:495-524` (the two native-group cases pinning
`'(555) 010-0001: ...'` and `'Ana Reyes: ...'`). Name it.

---

## Checked and clean (recorded so the next reviewer does not redo it)

- Every source line number the plan cites matched: `today.ts:1075` / `:994` /
  `:1000` / `:357` / `:222` / `:1086`; `inbox.ts:1154` / `:1190` / `:1237` /
  `:1418` / `:2293` / `:2358`, all four call sites inside `aggregateInbox`
  (`:709`) where `contacts` (`:715`) and `log` (`:713`) are in scope;
  `contacts.ts:1204` / `:1294` with `contacts`/`log` at `:918-919`;
  `relayGroups.ts` members route `:467-505` with `nameFromContact` used only at
  `:491` (import at `:39` will orphan, as the plan says);
  `api.ts:2185`/`:2201` with `contacts` at `:635` and `log` at `:558`;
  `rosterResolution.ts:561-562`; `twilio.ts:301-316`; `voice.ts:109-121`;
  `buildToday.ts:102-106`.
- `ContactDisplayItem` (`contactsRepo.ts:296-302`) has `firstName?: unknown`,
  `lastName?: unknown`, `deleted_at?: string`, so the plan's `display()` helper
  typechecks and `isDeleted` (`:309`) accepts it.
- The widened `contactDisplayName` signature accepts a whole `ContactItem`: the
  same `{ firstName?: unknown; lastName?: unknown }` shape already compiles
  against `ContactItem` at
  `app/scripts/measure-unread-contact-coverage.ts:483`.
- `app/tsconfig.test.json` includes `test`, so the typecheck gate does cover the
  new test files.
- Task 1's `participantNames.test.ts` expectations are arithmetically right
  against the module as written (trimming, empty-live-name fallback, deleted
  contact, bare phone, partial map, throw-to-empty-map, no-ids-no-call).
- Task 6's helpers all exist with the used shapes (`makeDeps` `:41`, `TOUR` `:74`,
  `contact()` `:81` returning `lastName: 'Person'`, `relayGroup()` `:91`), and
  `['Tina Person', 'Gone Person']` is what the new expression yields.
- Existing label pins survive: `inboxApi.test.ts:316` `'With Dana & Rex'`
  (c-tenant is Dana Doe, c-other has no contact); `inboxFeed.test.ts:485` and
  `inboxUnreadParity.test.ts:317`/`:328` use fakes with no `getDisplaysByIds`;
  `voiceWebhook.test.ts:113`/`:915` `'Bob'` is a single token so
  `shortNameFromFull` returns it unchanged; `inboundMessagePush.test.ts:361`
  `'Alice: ...'` seeds no contact for `c-alice`.
- The `Synthetic tenant` / `Synthetic participant` / `Synthetic landlord`
  fixtures (`app/src/lib/seed/performance.ts:842`, `:857-858`, `:890`) are
  asserted nowhere in `app/test`, `e2e` or `app/scripts` - the plan's Task 10
  Step 1 claim holds.
- All five issue files Task 10 stamps exist; `staff-only-roster-name-readers-stale`
  is correctly listed as a create.
- The dashboard DOES mount `/conversations/:conversationId`
  (`dashboard/src/App.tsx:251`), despite the stale comment at
  `app/src/routes/today.ts:788` - Task 9's `page.goto` target is real.
- 1:1 push and voice push titles already resolve contact-first
  (`twilio.ts:1042-1046`, `:2284-2288`; `voice.ts:154-162`), so they are not an
  unenumerated gap.
- `resolveRosterNames`'s try/catch does swallow a missing `getDisplaysByIds`
  method as a `TypeError`, as Task 3 Step 4 claims.
