# Plan review B - adversarial, code-level

Plan: `docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md`
Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`
Tree: worktree `W:\tmp\participant-snapshot-refresh` @ `5f6bccaa`.
`git diff b702a81c HEAD -- app/ e2e/ dashboard/` is EMPTY, so every line number
the plan cites was checked against a tree identical to its stated base.

Byte-exact quotation and the compiler transcript: `.superpowers/sdd/plan-review-B-reference.md`.

Verdict: a no-context builder executing this literally does NOT produce the spec.
Task 1 does not compile, Task 3's tests are written against a harness that does
not exist, Task 2's close-nag test can never go green, Task 9's third assertion
can never match, and the read budget the plan is named for is exceeded on three
of the surfaces it changes.

---

## BLOCKING

### B1. Task 1 Step 3 breaks `npm run typecheck` at every existing caller

The widened parameter `{ firstName?: unknown; lastName?: unknown } | undefined`
is a TypeScript WEAK TYPE. `ContactItem` declares neither `firstName` nor
`lastName` (they ride the index signature at `app/src/repos/contactsRepo.ts:292`),
so it has NO properties in common with the target and every existing caller
fails with TS2559 / TS2345.

Proven by compiling a faithful probe with the repo's own tsc and flags; output in
the reference file (R1). Breaks:
`app/src/routes/webhooks/twilio.ts:314`, `:1042`, `:2284`;
`app/src/routes/webhooks/voice.ts:155`;
`app/test/contactName.test.ts:96`, `:101`, `:102`, `:105`, `:106`, `:107`
(its `contact()` helper at `:90-92` returns `ContactItem`, and
`app/tsconfig.test.json` puts `test/` inside the typecheck gate);
and the plan's OWN Task 7 replacement of `pushSenderLabel`, which calls
`contactDisplayName(senderContact)` with the same type.

So Task 1 Step 5 ("PASS, typecheck exit 0") and Task 7 Step 4 are both false, and
the branch cannot reach gate 1 until this is fixed.

The repo already solved this exact problem and wrote down why:
`app/src/routes/units.ts:113-122` adds a `contactId: string` anchor to the same
minimal shape with the comment "`contactId` is here only as the anchor that keeps
TypeScript's weak-type check honest". The plan's signature drops that anchor. The
fix is to add `contactId: string` (or keep an explicit `ContactItem | ContactDisplayItem`
union); the plan's docblock even quotes units.ts's wording while omitting the one
field that makes it compile.

Note the plan's Task 1 Step 2 red-step reasoning is inverted: it predicts
"`ContactDisplayItem` is not assignable to `ContactItem`" (true, and the correct
red) but never considers the reverse direction, which is what the green step
introduces.

### B2. Task 3's inbox tests call a harness `inboxGroups.test.ts` does not have

The plan's two new tests use `get(deps, '/api/inbox?filter=groups')`,
`res.body.rows`, `groupText(id, participants)` and `relayGroup(id, participants)`,
and instruct the builder to "reuse their helpers verbatim (they exist under some
name; do not invent a parallel harness)". None of them exist. The file drives
`aggregateInbox({ filter, limit }, deps)` directly and asserts `page.rows`; its
only fixture factory is `groupConv({ conversationId, last_activity_at, ... })`
(`app/test/inboxGroups.test.ts:132`), relay rows are inline literals cast
`as ConversationItem` (`:396-406`), and there is no supertest import anywhere in
the file. A literal builder is blocked, and the instruction actively forbids the
only correct move.

### B3. Task 2's close-nag test seeds a `relay_status` the fake never matches

The test writes `relay_status: 'open'`. The FakeWorld double filters on
`c.relay_status === 'relay_group#' + status` (`app/test/helpers/twilioWebhookHarness.ts:777-779`),
faithfully mirroring the sparse byRelayStatus GSI. The same file's own relay
seeder writes `relay_status: 'relay_group#' + o.status` (`app/test/todayApi.test.ts:179`).
So the seeded group is invisible to `listRelayGroups('open')`, `nag` is
`undefined`, and `expect(nag?.memberNames).toEqual([...])` fails BEFORE and AFTER
the implementation - a red step that stays red for a reason unrelated to names.
The plan's hedge ("keep that attribute") does not name the prefixed key.

### B4. Task 9 Step 2's third assertion can never match

`await expect(page.getByRole('heading', { name: new RegExp(renamed.firstName) }))`
targets the relay thread header. That header is
`<div className={styles.facts}>{identityFacts}</div>`
(`dashboard/src/routes/conversation/ConversationDetail.tsx:406`), and the file
contains no `h1`/`h2`/`h3` at all. The DATA path is fine - `identityFacts` is
built from `members`, which is replaced by the `/members` fetch Task 5 hydrates
(`:180`, `:386-393`) - only the selector is impossible. The spec's own e2e
requirement ("the group thread header after reload") is therefore unmet, and the
failure will read as "Task 5 did not work".

### B5. Task 5 Step 5's "Expected: PASS" is false - two existing pins are reversed, not one

`app/test/relayApi.test.ts:427` ("GET roster drops the creation-time name when
the current contact is unnamed") and `:450` ("GET roster falls back to the roster
phone, not a stale name, when contact lookup fails") both pin
`[{ contactId: 'c-alice', phone: ALICE }]` on rosters created with
`name: 'Old roster name'`. Task 5 deliberately keeps that stored name, so BOTH
go red. The plan states this as a singular conditional ("If an existing
members-route test asserted..."), which will read to a builder as an unlikely
edge case rather than a certainty; the second one is a named anti-stale-name
rule, so re-baselining it silently would erase a deliberate decision.

---

## HIGH

### H1. Task 3's `:1418` edit puts a batch read inside a PER-ROW loop

`hydrateUnread` is awaited once per candidate in a serial loop
(`app/src/routes/inbox.ts:1462-1463`), and `:1418` is its multi-party arm. The
plan's `const names = await resolveRosterNames([fresh], contacts, log);` therefore
issues ONE `getDisplaysByIds` BatchGet PER unread relay/group row, sequentially,
on `filter=unread` - up to `limit` extra round trips on the hottest inbox route,
where the count today is zero. That is the exact shape the plan's Goal line
("at most one batched contact read per page") and Global Constraint 2 exist to
forbid. The spec sanctions it obliquely ("the two single-row callers batch over
one") without noticing that one of the two is inside a loop. Hoist the batch
above the candidate loop, or skip hydration on this arm.

### H2. Task 4's relay-groups edit lands INSIDE the three-status loop - 3 batches, not 1

The `for (const conv of items)` the plan replaces is nested inside
`for (const status of ['open', 'connecting', 'closed'] as const)`
(`app/src/routes/contacts.ts:1188-1198`). Applied literally, `mine` and `names`
are recomputed per status, so the contact page pays three `getDisplaysByIds`
calls per request. The spec's Scope table says "1 batch per card". Collect across
all three partitions first, then batch once.

### H3. `filter=all` pays two batches per request and double-reads shared contacts

The plan hoists one batch at `:2293` (relay merge) and another at `:2358` (group
merge); both are in the `filter=all` path (`app/src/routes/inbox.ts:2349-2356`
states the other filters return earlier). A contact on both a relay roster and a
group roster is fetched twice in one request. The spec's own summary line - "Net
request-path cost: one batch read on the inbox page" - is not what the plan
produces. One collect over `relayItems.concat(page.items)` would honour it.

### H4. `withLiveNames` cannot distinguish "no name" from "not read", and the
plan's relay-members change bakes that in as the ONLY behavior

Task 5 removes `delete memberWithoutStoredName.name` and replaces the per-member
`getById` with a batch. A short/empty map (throttle, TypeError on a fake without
the method, or a genuinely unnamed contact) is indistinguishable from a
deliberately CLEARED name, so a name an operator just deleted keeps rendering.
The spec names this as a known limit ("Stated, not fixed"), but the plan hands
the builder no assertion pinning it, and B5's second test - the one that
currently proves the read-failure rung - becomes green-by-construction once
re-baselined, because its injected failure targets `getById`, which the new code
never calls. Net effect: the branch DELETES the only regression test covering a
failed contact read on this route.

---

## MEDIUM

### M1. Four of the plan's new tests are green-by-construction; the stated red steps are wrong

- Task 2 test 3 ("an unreadable contact keeps the stored name") passes today:
  `participant_display_name` already wins at `app/src/routes/today.ts:1076`.
- Task 2 test 4 ("resolving names adds NO contact reads") passes today: the
  deleted-check at `:743` already makes exactly one memoized `getById`.
- Task 4 test 2 ("ids are batched only for groups this contact is in") passes
  today: before the change nothing calls `getDisplaysByIds`, so `batches` is
  empty and `.not.toContain('c-out')` holds vacuously.
- Task 5's re-baselined `relayApi.test.ts:450` (see H4).

Only Task 2 tests 1-2, Task 4 tests 1 and 3, and Task 5/6/7's assertions are
genuinely red. The plan's Step-2 "Expected: FAIL" lines name failures that will
not occur, which trains a builder to accept a green red-step.

### M2. Spec S3's `rosterEdits.ts` docblock amendment is orphaned

Spec section 5 S3 requires "Amend `rosterEdits.ts:425-441`, which says recipients
carry 'backfilled' names" - and the docblock really does say that
(`app/src/services/rosterEdits.ts:439-441`). The plan's Global Constraints forbid
editing `services/rosterEdits.ts` source, and no task carries the amendment. The
plan's Self-review claims full S3 coverage. Either lift the constraint for that
comment or record the deviation.

### M3. Task 7 Step 1's group-push test is a placeholder

"the group-push test in whichever file covers `emitMessagePush` for group threads
(`grep -rln ...`)" plus "Copy that file's existing group-push test and change the
two names" is a discovery step with no file, no fixture and no assertion - and it
is the ONLY coverage the plan gives the `pushSenderLabel` flip, which is a
spec-listed surface (S4). The plan's Self-review asserts "Placeholders. None."

### M4. The plan pins CALL COUNT where the spec explicitly forbids it

Spec section 6: "Inbox, contact cards, relay members, calls passthrough: ...
assert UNIQUE ID count passed to `getDisplaysByIds`, not call count." Task 3
asserts `expect(calls.displayBatches).toHaveLength(1)` and Task 5 asserts
`expect(batches).toHaveLength(1)`. Beyond the spec deviation, a call-count pin is
what would have caught H1/H2/H3 - and in H2's case the plan's own test would have
gone red on the plan's own implementation had it been written this way at the
contact-card site.

### M5. `withLiveNames`'s swallow-and-warn is endorsed as a substitute for wiring the fakes

Task 3 Step 4 tells the builder that a sibling suite whose fake lacks
`getDisplaysByIds` "is ALSO tolerated" because the `TypeError` lands inside the
try. That is true, but it means a suite can go green while the production path
resolves zero names, and each occurrence emits a `log.warn` into suites that
assert on log output. Add the method to every inbox-adjacent fake as a required
step, not an optional one.

---

## LOW

### L1. Three line-range slips that damage code if applied literally

- `rosterResolution.ts` "556-565" swallows `let sharesPhoneWithName: string | undefined;`
  at `:565`, used at `:570`/`:572`.
- The Task 4 group-threads snippet re-declares `const groups: GroupThreadRow[]`,
  which already exists at `app/src/routes/contacts.ts:1278`, while naming the
  range `:1279-1300`.
- `today.ts` "1072-1080" starts on a blank line (`whoOfConversation` is
  `:1073-1080`).

### L2. The `ContactItem` import in `contactName.ts` becomes unused - a gate-5 error

After the widening, `app/src/lib/contactName.ts:7` is dead. `tsconfig.base.json`
sets no `noUnusedLocals`, so typecheck stays quiet and only gate 5 (`npx eslint`
over the branch's touched files) fails - on a file this branch touched, so it is
attributable and BLOCKING at gate time. The plan raises it as a rhetorical
question ("still used by `parseContactName`'s neighbours?") rather than a step.

### L3. Task 1's new docblock under-counts its own consumers

It enumerates consumers "as of 2026-09-01" as the pushes plus
`lib/participantNames.ts`, but Task 8 adds `lib/rosterDriftTally.ts` as a fifth
importer of `contactDisplayName`. Same drift the docblock exists to prevent.

### L4. `rosterResolution.test.ts` has no `describeRoster` describe block

Task 6 Step 1 says "in the `describeRoster` describe block". The file's describes
are `resolveRoster - ...` x4, `isOnRoster`, `rosterEquals`, and
`describeRosterActions - historical rows cost NOTHING to serve` (`:522`). The
test itself is correct (`contact()` yields lastName `'Person'`, and
`RosterResolutionDeps.actions` is optional), only its placement instruction
points at nothing.

### L5. Task 9 calls a private method and hedges instead of deciding

`requireActiveTourGroup` is `private` (`e2e/scenarios/steps.ts:3765`). The spec
body calls `flow.requireActiveTourGroup()` from outside the class, then adds "if
so, expose a one-line public `activeTourGroupId()`". Decide it in the plan; a
conditional here is a compile error the builder meets at run time.

### L6. The worktree has no `node_modules`

`W:\tmp\participant-snapshot-refresh\node_modules` and `app/node_modules` do not
exist. Task 1 Step 2's first command is `cd app && npx vitest run ...`, which
will try to fetch vitest from the network rather than fail loudly. No task
installs dependencies.

---

## Scope check (clean)

Nothing in the plan touches `jobs/relayFanOut.ts`, `services/relayAnnouncements.ts`,
`lib/unreadFeed.ts`, `jobs/tourReminders.ts`, `routes/api.ts` `GET /conversations/:id`
(`:2004`) or `GET /group-members` (`:2020`). `participants[].phone` is never
written - `withLiveNames` only ever rewrites `name`, and the relay-members
replacement drops the `delete ... .name` line without touching `phone`. Client
change is confined to `dashboard/src/routes/today/buildToday.ts:106`, which the
spec's Out list explicitly carves out. The one scope defect is the opposite of
creep: M2, a spec-required source edit the plan forbids itself from making.
