# Implementation plan - inbox mark-unread (REBASED onto the delivered row half)

Spec: `docs/superpowers/specs/2026-08-17-inbox-mark-unread-design.md`
Worktree: `W:\tmp\inbox-mark-unread`   Branch: `feat/inbox-mark-unread`
Base: `main` @aa62b493, then MERGED `feat/call-inbox-unread` @e4890b98
(that branch is FROZEN by the human, 2026-08-17 - it will not move again).
Design review: spec R3 terminal, plan R4 terminal, then REBASED after the merge.
Adjudications: `.superpowers/design-review/adjudications.md`.

Assume ZERO context. Paths are repo-relative from the worktree root. Every task
is TDD: write the failing test, watch it fail for the RIGHT reason, then
implement.

---

## READ THIS FIRST: half of the original plan is already built

`feat/call-inbox-unread` delivered the inbox-ROW half of this feature and has
been merged into this branch. It is tested (route matrix in
`app/test/inboxApi.test.ts`, row cases in `InboxRow.test.tsx`, an e2e round trip
in `e2e/tests/dashboard-next/call-inbox-unread.spec.ts`) and it survived five
adversarial review rounds on its own branch.

**DO NOT REBUILD ANY OF IT.** What exists:

- **Three routes**, all live:
  - `POST /api/conversations/:id/unread` (`app/src/routes/api.ts:2058`) -
    MULTI-PARTY ONLY; a 1:1 gets `409 not_a_group_thread` on purpose, so 1:1
    threads cannot route around the contact-level rules.
  - `POST /api/inbox/unread { phone }` (`app/src/routes/inbox.ts:1790`).
  - `POST /api/inbox/:contactId/unread` (`app/src/routes/inbox.ts:1817`).
- **`flagUnread`**, the shared route helper (`inbox.ts`, just above `/unread`):
  `isUnreadVisible` pre-check -> already-unread no-op -> `incrementUnread` ->
  emit `conversation.updated` built from the write's own return.
- **Fan-in selection**: `newestOf(...)` over
  `conversationsForContact(...).filter(c => c.status === 'open' && c.type !== 'relay_group')`.
- **Client**: `markConversationUnread` / `markInboxUnread`
  (`dashboard/src/api/endpoints.ts`), `useInbox.markUnread`, and the row toggle
  in `InboxRow.tsx` - ONE action, "Mark read" while unread, "Mark unread" while
  read, guarded by `!row.deleted && row.status !== 'closed'`.
- **`useMarkContactRead`** already has generation / mounted / trailing
  machinery, including a per-contact reset keyed on an ACTUAL contact change
  (StrictMode-safe). This independently solves the "latch never resets across a
  contact switch" bug plan review found in the original S6 - build ON it.

Two label facts the builder must not "tidy":

- The row's unread action is `aria-label="Mark <name> as unread"` - "as" is
  deliberate, so the two labels are not substrings of each other for assistive
  tech and selectors. Keep that shape on the new surfaces.
- `markConversationUnread` returns `Promise<void>`; the routes return no count.
  That is FINE and no route needs changing: every live count in this plan comes
  from the `conversation.updated` SSE event, not from a response body.

## What is LEFT to build

| Slice | Status |
|---|---|
| H1 | NEW - harden the write (human ruling) |
| H2 | NEW - close the MU-2 gap (human ruling) |
| S6 | REDUCED - latch + drain on existing machinery |
| S7 | UNBUILT - the header toggle (D6) + navigate-back |
| S8 | UNBUILT - the Unread truncation notice |
| S9 | Extend e2e for the header half |
| S10 | Close out |

Original S1-S5 are delivered. S4's client functions exist. S5 is done.

## Global constraints (from the spec - do not re-derive)

- `unread_count = 1` on a read thread; an ALREADY-unread thread is left alone.
- MU-1: only where `isUnreadVisible({ ...c, unread_count: 1 })` holds.
- MU-2: refused when the target thread's contact is soft-deleted.
- `last_activity_at` is NEVER written by this feature.
- D6: every surface is a TOGGLE - exactly one of "Mark read" / "Mark unread".
- D2: "Mark unread" navigates to `/inbox`; "Mark read" does NOT navigate.
- ASCII only in new/touched lines, comments and test names included.
- Explicit-path commits; a bare `git status` is a SEPARATE read before each one.
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Repo facts (verified - do not re-derive)

1. App tests live in `app/test/`. Dashboard tests sit beside sources.
2. The unread integration suite is `app/test/unreadIndexRepo.integration.test.ts`.
   Its `byUnread` describe (line ~51) creates rows THROUGH THE REPO and has no
   raw-seed helper; `doc`, `table`, `rawItem`, `unreadIds` are in scope. Raw
   `PutCommand` seeds elsewhere in the file belong to other describes with
   DIFFERENT table variables.
3. **That suite SELF-SKIPS when DynamoDB Local is unreachable.** A green run
   without Docker means SKIPPED. `npm run db:start` first, and confirm it
   actually executes.
4. Per-slice commands must target a workspace - root `npm test -- <path>`
   forwards to every workspace and fails:
   `npm test -w app -- test/<file>` / `npm test -w dashboard -- src/routes/<path>`
5. **The worktree has NO `node_modules`.** `npm install` before anything.
6. `isDeleted` exists (`app/src/repos/contactsRepo.ts:297`) and is already
   imported into both `app/src/routes/api.ts` and `app/src/routes/inbox.ts`.
7. `ConversationUpdatedEvent` carries `unread_count`
   (`dashboard/src/api/types.ts:1488`, built `?? 0` at `app/src/lib/events.ts:89`).
   This is the live-count source for D6.

## Verification

Per-slice: the workspace-scoped commands above. Slice gate: `npm run typecheck`.
Final gates, BARE from the worktree root, never piped: `npm run typecheck`,
`npm test`, `npm run e2e`.

## Slice order

H1 -> H2 -> S6 -> S7 -> S8 -> S9 -> S10.
**S6 MUST precede S7** - S7's actions call the handle S6 creates.

---

# H1 - Harden the write: move the precondition into the condition

Human ruling 2026-08-17. The delivered routes read the row, check
`isUnreadVisible` and `unread_count === 0`, then call `incrementUnread`. That is
a TOCTOU: a relay close committing between the check and the write re-flags a
CLOSED group unread, planting a permanently invisible `byUnread` resident -
the same bug class as the open issue
`docs/issues/inbound-reflags-closed-relay-group.md`.

Behavior does not change. The guarantee does.

## H1.1 Add `setUnread` to the repo

`app/src/repos/conversationsRepo.ts`. Export
`export type UnreadBucket = 'relay_group' | 'group_text' | 'one_to_one';`,
declare on the `ConversationsRepo` interface after `resetUnread`, and implement
after the `resetUnread` implementation (~`:1561`).

ONE `UpdateCommand`: `SET unread_count = :one, unread_flag = :flag`
(`:one = 1`, `:flag = UNREAD_FLAG_VALUE`), `ReturnValues: 'ALL_NEW'`,
`ConditionExpression` = three clauses ANDed:

1. `attribute_exists(conversationId)`
2. the bucket predicate:
   - `relay_group`: `#type = :type AND #s IN (:open, :connecting)`
   - `group_text`: `#type = :type AND #s = :groupOpen` (`GROUP_TEXT_STATUS`)
   - `one_to_one`: `(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText)) AND #s = :open`
3. `(attribute_not_exists(unread_count) OR unread_count = :zero)`

Comments to carry:
- EVERY bucket has a type clause, not only `one_to_one`. Without it the
  `relay_group` predicate is satisfied by any open 1:1, and the only separator
  would be the route's own type read - the value this condition exists to
  distrust. Safe today only because `convertRelayGroupToGroupText` also moves
  status out of the admitted set; do not depend on that.
- Clause 3's `attribute_not_exists` half is LOAD-BEARING: `unread_count` is
  genuinely sparse, so a thread that never received an inbound has never had it
  written, and a bare `= :zero` would refuse that whole class forever.
- Pointer-partition rows (MU-1's first clause) are deliberately NOT in the
  condition: `conversationId` is the table key and cannot change, so the route
  pre-check cannot be raced.
- Accepted risk, same class documented at `:1541-1543`: `SET` is
  last-write-wins against an in-flight inbound `ADD`.

Also update the `unread_flag` contract comment at `:172-178` - `setUnread` is
now a THIRD writer alongside `incrementUnread` / `resetUnread`.

## H1.2 Update every full-literal repo fake (SAME commit)

A required interface method breaks typecheck in each. Derive the list:

```
grep -rln "resetUnread" app --include=*.ts | grep -v node_modules
```

Classify each hit: full literal -> add `setUnread`; injects the real repo -> no
change; `Pick<>` -> no change. Known full literals:
`app/test/helpers/twilioWebhookHarness.ts`, `app/test/contactCapture.test.ts`,
`app/test/scheduledSendSuppression.test.ts`, `app/test/sendMessage.test.ts`.
Verify rather than assume.

**The harness fake's `setUnread` must implement BOTH halves.** *Refusal*: throw
`ConditionalCheckFailedException` when the row is absent, the bucket predicate
fails, or `unread_count > 0` - a fake that always succeeds makes the route tests
vacuous. *Write*: set `unread_count = 1` AND `unread_flag`; setting only the
count leaves the modelled index wrong, because the index filters on
`unread_flag` alone.

## H1.3 Tests (RED first; Docker up)

In the `byUnread` describe of `app/test/unreadIndexRepo.integration.test.ts`,
add a local seed helper - there is none in that describe:

```ts
  async function seedRaw(item: Record<string, unknown>): Promise<string> {
    const conversationId = `conv-${randomUUID()}`;
    await doc.send(
      new PutCommand({
        TableName: table,
        // last_activity_at is the byUnread RANGE key (tables.ts:182-186). A row
        // seeded without it writes fine and setUnread SUCCEEDS, but never enters
        // the index - so the round-trip assertions fail against CORRECT code,
        // with a symptom reading as "setUnread does not index".
        Item: { conversationId, last_activity_at: new Date().toISOString(), ...item },
      }),
    );
    return conversationId;
  }
```

Cases: read 1:1 -> count 1 + flag + present in `unreadIds`; **no `unread_count`
attribute at all -> ACCEPTED**; already-unread at 5 -> throws and stays 5;
unknown id -> throws; `one_to_one` refuses `closed` and refuses `type:
relay_group` and ACCEPTS a legacy no-`type` row; `relay_group` accepts `open`
and `connecting`, refuses `closed`, and **refuses an OPEN 1:1** (the type
clause); `group_text` accepts `group_open` and refuses plain `open`; round trip
via `unreadIds` before/after `resetUnread`.

## H1.4 Point the routes at it

`flagUnread` (`inbox.ts`) and the conversation route (`api.ts:2058`) keep their
pre-checks (fast, specific errors) but replace `incrementUnread` with
`setUnread(id, { bucket })`, where `bucket` comes from the item's type
(`relay_group` / `group_text` / else `one_to_one`).

Wrap the call. On `ConditionalCheckFailedException`, re-read ONCE and classify -
**eligibility BEFORE count**, because an ineligible-AND-unread thread is a real
state (a closed relay group re-flagged by an inbound) and count-first would
report success for exactly that residue row:

- absent -> conversation route `404 conversation_not_found`; the two fan-in
  routes `409 thread_closed` (the client named a contact or phone, never this
  conversation, and the contact demonstrably exists - the route loaded it).
- ineligible -> `409 thread_closed` (keep the delivered code; do not invent a
  new one).
- eligible and `unread_count > 0` -> SUCCESS, no write, no emit. Same outcome
  the delivered no-op path already produces.
- eligible and read -> RACED: retry `setUnread` ONCE, recomputing the bucket
  from the re-read (a stale bucket wastes the retry in the one case - a type
  transition - where a fresh one succeeds). If it fails again, classify once
  more without a second retry.

Emit `conversation.updated` ONLY on a real write, exactly as `flagUnread` does
today, and keep building the emitted image from the write's own return.

## H1.5 Route tests

Extend `app/test/inboxApi.test.ts` and the conversation-route tests. The
existing matrix must stay green unchanged - that is the proof H1 is a hardening
and not a behavior change. Add, per route:

- a `raced` case (arm the fake's one-shot; assert the route RETRIES and
  succeeds, and that the retry used a bucket recomputed from the re-read),
- a twice-raced case (assert the terminal mapping; no third write),
- a `gone` case (404 on the conversation route, 409 on the fan-in routes),
- an ineligible-AND-unread case -> 409, never success (the ORDER test).

**A correct condition can never produce `raced` on its own.** Give the harness
fake's `setUnread` a test-only COUNTER of how many next calls must throw
regardless of state, decremented per throw - a counter, not a self-clearing
one-shot, because the twice-raced case needs two consecutive failures from one
seam. Name it clearly test-only.

## H1.6 Verify

`npm test -w app -- test/unreadIndexRepo.integration.test.ts` (Docker up),
`npm test -w app -- test/inboxApi.test.ts`, `npm run typecheck`. Commit.

---

# H2 - Close the MU-2 gap on the by-phone route

Human ruling 2026-08-17. `POST /api/inbox/unread { phone }`
(`inbox.ts:1790`) never resolves the contact, so a soft-deleted contact's number
can be flagged unread through it. The other two routes refuse that
(`/:contactId/unread` via `isDeleted`, and 1:1s cannot reach the conversation
route at all). Both spec reviewers found this independently; the spec makes MU-2
a server-side guarantee on ALL routes.

Its `/read` sibling deliberately has NO such check - zeroing unread on a deleted
contact is harmless, SETTING it is what MU-2 forbids. Do not "make them
consistent" by removing this one.

After the E.164 validation and before `flagUnread`: `contacts.findByPhone(phone)`;
if a contact is found AND `isDeleted(contact)`, respond
`409 contact_deleted` (the code the contact route already uses). A phone with NO
contact record is NOT deleted - an untriaged unknown number stays markable.

Tests in `app/test/inboxApi.test.ts`: 409 `contact_deleted` for a deleted
contact's number; still 200 for a live contact's number; still 200 for a number
with no contact record at all.

`npm test -w app -- test/inboxApi.test.ts`, `npm run typecheck`. Commit.

---

# S6 - Auto-read latch and drain (REDUCED)

Files: `dashboard/src/routes/contact/useMarkContactRead.ts`,
`dashboard/src/routes/conversation/useMarkThreadRead.ts` (new),
`ConversationDetail.tsx` (its local `RelayGroupView`), `GroupTextView.tsx`.

Navigating away is not enough on its own: `useMarkContactRead` fires uncancelled
on mount, on `visibilitychange`, and on every org-wide `message.persisted`
event, and the two group views fire the same way from a mount effect.
Unmounting stops future triggers, not one already in flight or one firing during
the await - so the action would intermittently no-op with a success response,
the worst failure shape for a to-do affordance.

Both hooks return:

```ts
export interface AutoReadHandle {
  /** Suppress auto-read for the CURRENT identity, then wait for any in-flight
   *  auto-read to settle. Await BEFORE issuing a mark-unread POST. */
  suppressAndDrain: () => Promise<void>;
}
```

**Memoize it** (`useMemo` over a `useCallback`). An unstable identity flows into
consumer effect deps and POST-loops - the hazard `UnreadContext.tsx:82-88`
records.

## S6.1 `useMarkContactRead`

It currently returns `void`. Return the handle. **Build on what is there** - it
already has `inFlight`, `trailing`, `generation`, `mounted` and `ownerContactId`
with a StrictMode-safe per-contact reset. Add only:

- `suppressedFor: useRef<string | null>(null)`. `markRead` returns early when
  `suppressedFor.current === contactId`. Clear it in the EXISTING
  `ownerContactId` reset effect - that effect already fires on an actual contact
  change, which is exactly the reset semantics needed, and reusing it keeps one
  reset path instead of two that can disagree.
- `inFlightPromise: useRef<{ id: string; promise: Promise<unknown> } | null>`,
  set when `markRead` issues its POST and cleared in the existing `finally`,
  keyed by contact so the drain never awaits a previous contact's request.
- `suppressAndDrain`: set the latch, then await the in-flight promise for THIS
  contact, BOUNDED by `Promise.race` against
  `AUTO_READ_DRAIN_TIMEOUT_MS = 2000` (module scope).

Also suppress the TRAILING re-fire: with the latch set, the `finally` must not
re-enter `markRead`. Otherwise the coalescing machinery re-marks read exactly
when the operator has just asked for unread.

Await, do not abort: a client abort does not stop the server committing the
`resetUnread`, so it would hide the race rather than close it. Bound it: the
request has no timeout of its own and the auto-read passes no signal, so an
unbounded await makes the button look dead - worse and likelier than the narrow
tail race. On timeout proceed; the latch still suppresses the late response.

## S6.2 `useMarkThreadRead` (new)

`ConversationDetail.tsx:238-242` and `GroupTextView.tsx:259-263` hold the SAME
inline mount effect. Extract it with the same latch/drain keyed on
`conversationId`.

**Move the MOUNT EFFECT ONLY** - no `visibilitychange`, no `onMessagePersisted`.
Those belong to the contact page's model; adding them here changes shipped
behavior and breaks a pinned ruling.

**Preserve the existing comment block verbatim** - it records that this read is
deliberately UNWIRED from the badge's optimistic layer, pinned by regression
spies (`GroupTextView.test.tsx:27-31`, `ConversationDetail.test.tsx:149-151`).

**No identity reset here, and say why in a comment.** `ConversationDetail`
renders its loading branch (`:107-113`) while a new header loads, which unmounts
the child, so a `conversationId` change already gives the hook a fresh mount.
That is a load-bearing property of an unrelated component - an optimization that
keeps the child mounted would silently resurrect the suppressed-forever bug.

## S6.3 Tests

- TRIGGER: after `suppressAndDrain()`, a `message.persisted` event does NOT
  issue `markInboxRead`; and the TRAILING re-fire does not either.
- **DRAIN - assert ORDER.** With a deferred in-flight fan-out,
  `suppressAndDrain()` does not resolve until it settles. A trigger-only test
  stays green while the ordering bug ships; this is the test that matters.
- BOUNDED: with an auto-read that never settles, it still resolves after the
  timeout (fake timers).
- The EXISTING `useMarkContactRead.test.tsx` cases (generation, StrictMode,
  trailing) must stay green unchanged.
- The existing `noteRowsCleared` spies must stay green.

`npm test -w dashboard -- src/routes/contact src/routes/conversation`;
`npm run typecheck`. Commit.

---

# S7 - The header toggle (D6)

Files: `ConversationDetail.tsx` (its local `RelayGroupView` - props `:169`,
definition `:175`, render `:141`; **NOT a file, do not extract**),
`GroupTextView.tsx`, `ContactDetail.tsx`, `ContactActionsMenu.tsx`.

Each surface shows exactly one of "Mark read" / "Mark unread", chosen by a LIVE
count - never both, never "Mark unread" on an already-unread thread. Mirror the
row's labels, including `aria-label="Mark <name> as unread"`.

**The live count comes from the SSE event, not a re-fetch.**

- **Group views**: seed from the mount header's raw `unread_count` - it rides
  `ConversationHeader`'s INDEX SIGNATURE and is NOT a typed field, so read it
  defensively and treat absent as 0, never `NaN` - then update on
  `onConversationUpdated` for this `conversationId`. The mount auto-read emits
  that event itself, which is how the page learns its post-read count without a
  re-fetch. Do NOT gate on the seed alone: it is deterministically PRE-auto-read
  (`ConversationDetail.tsx:81-87`, `:107-113`, `:148-151` - nothing re-reads
  it), which is the frozen-header trap.
- **Contact page**: no unread datum exists and none is added. Derive - the mount
  fan-out marks EVERY thread of the contact read, so a successful fan-out means
  read. Track `hasUnread`: false on fan-out success, true on any
  `onConversationUpdated` with `unread_count > 0` whose `conversationId` is in
  the contact's timeline. A SKIPPED (background tab) or FAILED fan-out leaves
  state UNKNOWN -> show "Mark unread" (safe default; the server refuses if
  wrong).

**Flow.** "Mark unread": `await handle.suppressAndDrain()`, then the POST, then
`navigate('/inbox')`. "Mark read": the EXISTING `markConversationRead` /
`markInboxRead`, and it does NOT navigate - marking read while reading is not a
departure. Render a pending state while outstanding. On failure stay put.

**Error copy is NEW UI** - neither surface has an existing inline treatment for
these codes. A `409` renders "Could not mark unread - try again" and LEAVES THE
ACTION AVAILABLE (the participant-GSI-lag path is expected and retryable, not an
error the operator must reason about). Other failures use the same treatment.

Placement:
- **Group views**: the toggle in the header. HIDDEN entirely for a closed relay
  group - unlike the row, this guard IS live here (reachable by deep link and
  from the contact's relay-groups card). Use `markConversationUnread` /
  `markConversationRead`.
- **Contact page**: a toggle ITEM in `ContactActionsMenu` (the kebab at
  `ContactDetail.tsx:658`), label swapping with state, calling
  `markInboxUnread({ contactId })` / `markInboxRead({ contactId })`. Hidden for a
  soft-deleted contact. In the MENU, and specifically NOT in `ContactCommsPane` -
  that pane is shared with the tour and placement 1:1 tabs
  (`TourConversation.tsx:263`, `PlacementConversation.tsx:260`), so putting it
  there leaks the action onto surfaces the spec's non-goal 5 excludes.
  `ContactActionsMenu` gains required props - update every render site
  (`grep -rn "<ContactActionsMenu" dashboard/src`) in the same commit.

**Neither surface touches `UnreadContext`.** Neither auto-read records a clear,
so there is nothing to roll back. `ContactDetail.test.tsx` has NO `UnreadContext`
mock today - ADD a spy there rather than "extending an existing" one.

## S7 tests

1. **Calls `suppressAndDrain` BEFORE the POST** (mark-unread only). Assert
   ORDER. Without this, S6 can be perfect and S7 still fail to call it.
2. "Mark unread" navigates to `/inbox` on success; "Mark read" does not.
3. Neither navigates on rejection.
4. **The toggle, BOTH directions**: at count 0, "Mark unread" present and "Mark
   read" absent; at > 0, the reverse. An absence-only assertion goes vacuous
   rather than red.
5. **The count is LIVE**: seeded at 0, an `onConversationUpdated` carrying
   `unread_count: 3` flips to "Mark read" with NO re-fetch. This is what proves
   the toggle is not reading the frozen seed.
6. Group views survive an ABSENT `unread_count` on the mount header (0, never
   `NaN`).
7. Contact page: successful fan-out -> "Mark unread"; skipped/failed -> "Mark
   unread"; an `onConversationUpdated` with `unread_count > 0` for a timeline
   conversation -> "Mark read".
8. Pending state renders while outstanding.
9. A `409` renders the retryable message and leaves the action available.
10. Visibility: absent for a closed relay group; absent for a soft-deleted
    contact.
11. Neither surface calls into `UnreadContext`.

---

# S8 - The Unread list truncation notice

Files: `dashboard/src/routes/inbox/Inbox.tsx`, `Inbox.test.tsx`.

A truncated NON-EMPTY unread page ends silently today: `hasMore` is false so no
"Load more" renders, and the truncation banner is gated on the page having come
back EMPTY - so a capped list looks exactly like the end of the feed. In scope by
the human's ruling at the spec gate: a cap is acceptable only if the list says
it is capped.

Render when `inbox.status === 'ready' && inbox.truncated && inbox.serverRowCount > 0`,
reusing `styles.notice` (the group-text truncation treatment at
`Inbox.tsx:88-116`). Copy, with NO count:
"Showing the most recent unread. There are older unread threads not shown here."

Gate on `serverRowCount`, NOT `rows.length` - both `truncated` and that count
describe the SERVER page, while `rows` is the client-filtered list the Unread tab
empties as rows are marked read, so a rows-keyed notice vanishes mid-triage. The
condition is the exact complement of `serverEndedEarlyEmpty`, so the two can
never render together. No count in the copy because the operator clears rows
while the flag stands, so any number reaches zero with the notice still up.

Tests: renders on a non-empty truncated page; not on an untruncated page; not
alongside the empty/error surface; and **stays rendered after every visible row
is marked read** (a `rows`-keyed test would pass while the regression ships).

---

# S9 - e2e for the header half

`e2e/tests/dashboard-next/call-inbox-unread.spec.ts` already covers the ROW
round trip. Do not duplicate it. Add header coverage - extend that spec or add
`inbox-mark-unread-header.spec.ts`, whichever keeps the files coherent.

Starting state: lean seeds every conversation `unread_count: 0`
(`app/src/lib/seed/lean.ts:23-25`), so MANUFACTURE unread with the fake-Twilio
inbound fixture (`sendAsParty`), as the existing specs do.

Anchoring: a row's count carries `aria-label="<n> unread"`
(`InboxRow.tsx:107-111`), the SAME accessible name as the nav badge
(`NavContents.tsx:66`); a bare `getByLabel('1 unread')` matches both and fails
strict mode (`inbox-nav-badge.spec.ts:15-21`). Address rows by href.

1. Open a read thread from the inbox; from the contact page kebab click
   "Mark unread"; assert the browser lands on `/inbox` with that row unread.
2. Open a relay-group or group-text thread; assert the header shows "Mark
   unread" (it was just auto-read), click it, assert the same round trip.
3. Assert the toggle's other half: on a thread that is unread on arrival, the
   header offers "Mark read".

---

# S10 - Close out

1. **No main sync is owed** - merging `feat/call-inbox-unread` (which had
   already merged main) brought `main` in at @e4890b98. Report later drift; do
   not chase it. `feat/call-inbox-unread` is FROZEN and will not move.
2. Gates BARE from the worktree, never piped: `npm run typecheck`, `npm test`,
   `npm run e2e`. Re-run either known flake once before blaming this change and
   report BOTH runs: `tour-reminders-panel-e2e-flake`,
   `conversationdetail-members-mock-suite-flake`.
3. `npm run issues` if any `docs/issues/` file was added.
4. Handback to `.superpowers/sdd/handback.md`: per-spec-item status, quoted exit
   codes on the final commit, drift, owed post-merge ops (expected: NONE - no
   dependency, schema, GSI, infra, config or backfill).

## Watch items

- **`npm install` first** - the worktree has no `node_modules`.
- **Docker up for H1** or its red step is meaningless (the suite self-skips).
- **Do not rebuild the row half or the three routes.** They are delivered,
  tested and frozen. H1 changes HOW they write, not what they do; the existing
  route matrix must stay green unchanged.
- **Do not "fix" the relay close path.** It already zeroes unread and drops the
  flag inside `setRelayStatus` (`conversationsRepo.ts:1877-1878`).
- **`RelayGroupView` is NOT a file** - a local function in
  `ConversationDetail.tsx:175`. Edit in place.
- **`unread_count` is sparse** - the `attribute_not_exists` clause is not padding.
- **`seedRaw` must seed `last_activity_at`** or correct code fails the index
  assertions.
- Do not add an optimistic-increment layer to `UnreadContext`; do not touch
  `last_activity_at`; do not put the contact action in `ContactCommsPane`; do
  not add visibility/SSE triggers to the conversation-page read.
- **D6 is the one part of this design no adversarial reviewer has seen** - it
  was ruled after the review loop closed. Treat its live-count mechanism as the
  highest-risk area in review.
