# Inbox unread read path (cluster C1) - design

Status: **SPLIT.** Section 2 (the diagnosis and its fix) SHIPPED on
`feat/inbox-unread-read-path`. Sections 3 through 7 - the two highs and the
riders - are DRAFT and have not passed the human's spec gate; they are a
separate branch's work.

The split was the human's call once the diagnosis landed: the `useInbox` fix is
self-contained and verified (250/250 on the spec that reproduced at 1-in-38),
and holding it behind a twelve-issue build would both delay an
operator-visible fix and produce a diff too large to review well.

Branch: `feat/inbox-unread-read-path`, cut from `main` @5355b7ae.
Cluster: [`docs/issues/_CLUSTERS.md`](../../issues/_CLUSTERS.md) section C1.

## 1. What this mission is

Cluster C1 is one read path seen from several angles: the sparse `byUnread`
index walk that backs the nav badge and the Unread tab, the two mark-read
fan-outs that maintain it, and the open-partition pager that backs every other
tab. The human scoped this mission to sweep the WHOLE cluster rather than the
two highs alone.

Thirteen issues were listed under C1. One
(`unread-index-integration-coverage-requires-local-dynamo`) is already
`status: resolved` - closed 2026-08-21 by the `globalSetup` throw - so the
cluster table's row for it is stale and is corrected as part of this work.
Twelve remain, plus the diagnosis below.

## 2. The diagnosis that came first, and what it changed

The mission opened with a diagnosis phase because two of the four candidate
explanations for the routed e2e evidence would have changed what gets built.
It is complete, and the answer was none of the four hypotheses that implicated
the read path.

**Root cause: `useInbox` installed a page fetched for a filter the operator had
already left.** `scheduleRefetch` closes over the `fetchFirstPage` of whichever
filter was active when the SSE event arrived; nothing cancelled it on a filter
change (the clearing effect had empty deps, so it ran only on unmount), and
`fetchFirstPage` committed whatever it fetched with no filter-identity check.
Mark-read on Unread fires `conversation.updated`; the operator switches to All
inside the 300ms debounce; the stale reconcile lands, and because mark-read has
just emptied the unread feed it installs ZERO rows. One bad page sticks until
the next event happens to arrive.

Evidence, from a reproduction on iteration 38 of a 150-repeat soak on a quiet
machine, with the read accounting added in `360c5a6d`:

```
-28553ms  ASSEMBLED all     count=4 rawScanned=2   <- All tab fetch; row visible
-28395ms  ASSEMBLED unread  count=0                <- lands INTO the All tab
   ...    28 seconds of silence, then the click times out
```

Every `filter=all` response in the failing iteration carried a full page. The
emptying request came from the browser (Chrome user-agent), not the test's API
helper. Fixed in `52ebafc8`; verification is a re-soak of the same spec.

**What this changes for the rest of the mission.** The two highs are real and
are built exactly as their issues prescribe - but they were not what made the
row vanish, and the mission must not claim otherwise. Specifically:

- `call-inbox-unread-detached-node-flake` closes on the `useInbox` fix. Its
  three sightings are ONE defect: the detached-node shape and the
  ready-and-empty shape are the same event, because the node detaches when the
  list is replaced by an empty one. The reproduction exhibits both signatures
  at once.
- `inbox-row-appearance-e2e-flake` is NOT closed on a guess. Its
  `inbox-markread.spec.ts` half is plausibly the same defect - that spec
  switches tabs with inbound traffic in flight, and a stale ALL page installed
  on the Unread tab is then narrowed client-side to unread rows only, which
  reproduces "the row did not appear". Its `deleted-contact-resurfacing.spec.ts`
  half uses full page loads, where no timer survives the mount, and is not
  explained by this mechanism. It has not reproduced in 8+ full runs, so
  neither half can be verified directly. The issue is updated with both
  findings and stays open.
- The routed issues' shared premise - "a whole open-partition read answered
  EMPTY" - is disproven and is corrected in both files. The inference was
  reasonable from browser-side artifacts alone; it did not survive a
  server-side log.

## 3. The two highs

### 3.1 mark-read-fanout-stale-gsi-skip (high)

Both mark-READ fan-outs filter their candidate list on the unread count they
just read through the eventually-consistent `byParticipantPhone` /
`byParticipantEmail` GSIs, which lag independently of `byUnread`. A stale ZERO
skips a genuinely unread thread: no `resetUnread`, no `conversation.updated`,
and the row stays in the sparse index. For the LAST message of a thread it
never heals, so the thread becomes a permanent `byUnread` resident that costs a
resurfacing probe on every badge request - which is how it feeds the other high.

Build the conditional write the issue prescribes, not the `contacts.ts`
filter-removal: add `resetUnreadIfUnread` to `conversationsRepo` with
`ConditionExpression: attribute_exists(unread_flag)`, call it UNFILTERED from
both fan-outs, treat `ConditionalCheckFailedException` as "already read", and
emit `conversation.updated` only when a write actually happened. That keeps the
SSE volume the filter was protecting while making the WRITE, not a lagging
read, the authority - the same correction `setUnread` already made on the
mark-unread side.

The two call sites: `POST /api/inbox/unknown/:phone/read` over
`findByParticipantPhone`, and `POST /api/inbox/:contactId/read` over
`conversationsForContact`.

Regression test: the `stalePositiveOnFirstRead` seam in
`app/test/inboxApi.test.ts` already stages a stale image; point it at the read
routes with a stale ZERO and assert on `world.unreadResets`. Mutation-probe by
restoring the filter.

### 3.2 unread-badge-request-round-trip-cost (high)

Two amplifications in one request. Sequenced as the issue directs, with the
human's ruling at the spec gate: **measure, then decide by rule.**

**Contributor 2 first** (`unread-fill-loop-query-amplification`, med): each
iteration of the fill-or-exhaust loop builds a new `collectUnreadRows`, hence a
new iterator, hence a new `queryUnreadPage` whose internal page size ignores
`maxRows` - so a collect that will consume ONE item still fetches up to 100.
Measured: `limit=1` produced 601 Queries and 55,050 items read for zero rows.
Take remedies 1 and 2 together - bound the internal page by the consumer's
appetite, and count FETCHED rather than CONSUMED items against the budget so
the ceiling and the `warnUnreadScanned` tripwire stop under-reporting the real
index read by ~90x. Remedy 3 (one iterator threaded through the loop) is the
structural fix and is NOT taken here; it is filed if the measurement says the
first two are not enough.

**Then re-measure, then decide contributor 1 by this rule.** After contributor
2 lands, measure the badge's round-trip COUNT on a realistic shape and on a
residue-wall shape, with call-count assertions as `app/test/inboxFeed.test.ts`
already does. If the badge costs at most a small constant number of round
trips, stop: file the remainder and say so. If it still costs hundreds,
ESCALATE TO THE HUMAN with the numbers before touching the schema - do not
start option 2 unprompted.

Contributor 1's options, for that escalation: (1) parallelize the per-item
Queries with bounded concurrency - a latency fix that leaves the round-trip
count unchanged, and calling it a read-amplification fix would be dishonest;
(2) denormalize `contactId` onto the conversation item at claim time and
collapse ~100 Queries into ~1 BatchGet - the real fix, and a schema change
carrying a new write-path invariant plus a backfill.

Two remedies are already ruled out and must not be re-litigated: the
per-collect memo (implemented and removed - it can never hit, because the claim
arbiters guarantee at most one OPEN conversation per participant key), and
bounding contact resolution (re-creates the walk-stop class that makes the
badge lie). BatchGetItem cannot read a GSI, so the old issue's prescribed
`findByPhones` was never buildable.

**Acceptance is round-trip COUNT, not wall-clock.** Local DynamoDB timings are
emulator-bound.

## 4. The riders

Ordered so that a red gate stays attributable: each slice is its own commit,
and the slices that share a function are sequenced rather than interleaved.

| # | issue | sev | change |
|---|---|---|---|
| R1 | unread-fill-loop-query-amplification | med | see 3.2; lands with the high |
| R2 | unread-load-more-empty-on-exact-multiple | low | report `scanExhausted` INDEPENDENTLY of `capped`, so a page that fills AND exhausts supply takes the natural-end arm: no cursor, no `truncated`. Tests at `unreadWorld(120)` limit 30 (120/120, `truncated === undefined`) and `unreadWorld(60)` limit 30 (page 2 mints no cursor) - the existing 101/130 tests bracket this boundary and miss it |
| R3 | unread-deleted-contact-probed-twice-per-page | low | thread the collector's resurfacing probe through the candidate into hydration so `buildContactRow` reuses it instead of re-reading. Same path as R1, so it lands with it |
| R4 | seen-set-max-equals-max-inbox-limit | low | raise `SEEN_SET_MAX` above `MAX_INBOX_LIMIT` so at least one more page is always reachable at the advertised maximum limit, and cross-reference both constants' comments |
| R5 | inbox-truncated-flag-two-meanings | med | split the wire signal: keep `truncated` as "this page ended early" and add `truncatedUnreachable`, set ONLY by the depth cap and the unresolved-drop path, never by the budget exit. Client renders the capped notice on the unreachable flag alone |
| R6 | unread-budget-truncation-has-no-forward-path | med | remaining half only: surface `truncated` in `UnreadContext` and give `NavContents` an indeterminate marker, so a truncated zero stops looking exactly like "all caught up". Depends on R5 for the honest signal |
| R7 | inbox-group-truncation-notice-not-reset | low | gate the group-truncation notice on `inbox.status === 'ready'` - the smaller change, and it matches what the notice means (a statement about the page currently rendered) |
| R8 | inbox-parselimit-empty-one-row | low | adopt the aiRuns variant: `if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_INBOX_LIMIT;` plus a test that `?limit=` answers the default. Remove the now-obsolete do-not-re-sync warning in `aiRuns.ts` |
| R9 | inbox-imported-call-outcome-normalization | low | promote `normalizeCallOutcome` and the `call_duration_seconds` fallback out of `contactTimeline.ts` into a shared module both read surfaces import; fix `formatCallDuration`'s guard from `< 0` to `<= 0`. Normalization sits INSIDE the derive path and must not override stored previews |
| R10 | inbox-filter-tabs-full-walk | low | DEFERRED BY RULE - see below |
| R11 | thread-hooks-refetch-whole-page-per-event | med | inbox half only - see below |

**R10 is deferred to the 3.2 decision, by the human's ruling.** Its remaining
half is the Unknown tab, which must hydrate a contact to decide `needsTriage`
and so cannot pre-filter on the conversation item. Its only remedy is a
denormalized triage hint or a second sparse GSI. If 3.2 escalates to option 2,
the same write-path invariant and backfill carry a triage hint too - one schema
change instead of two. If 3.2 does NOT escalate, R10 closes as accepted with its
escalation trigger documented, and the mission says so plainly rather than
claiming a fix.

**R11 is the inbox list only.** Merge the refetched page onto the existing rows
by `rowKey` so an unchanged row keeps its DOM node, instead of replacing every
row on every event. The three conversation hooks the filed issue actually names
(`useRelayThread`, `useGroupThread`, `useContactTimeline`) are OUT of scope by
the human's ruling; that issue is updated to record the inbox fix as the
reference implementation and to note it now covers those three only.

Note R11 is no longer load-bearing for the e2e evidence - the `useInbox` fix in
section 2 is what stops the row vanishing. R11 is now what it always was on its
own merits: the list should not re-render wholesale to deliver one changed row.

## 5. Invariant surfaces

Per the planner's invariant rule, the one design element that moves an
invariant is 3.1: the authority for "is this thread unread" moves from a READ
(the fan-out's filter) to a WRITE (the conditional expression). Every mutation
surface of `unread_flag`, and every reader of it, is enumerated so none is
missed:

WRITERS: `incrementUnread`, `resetUnread`, the new `resetUnreadIfUnread`,
`setUnread` (`lib/markUnread.ts`), the relay-close reset that clears
`unread_flag` in the same write as the status flip, the contact soft-delete
fan-out in `routes/contacts.ts`, the seed (`seedUnreadFlag`), and the backfill
(`backfillUnreadFlag`).

READERS: `collectUnreadRows` / `queryUnreadPage` (the index walk),
`countUnreadRows` (the badge), the `filter=unread` branch, `unreadOf` on every
pager row, `isUnreadVisible`, and the two fan-outs' own filters (which is what
3.1 removes).

If option 2 of 3.2 is taken, the enumeration widens to every surface that
writes `contactId` onto a conversation: claim, merge, soft-delete, restore,
reassignment, and the pointer-aware `phone_ref -> phone_ref_owner` hop, plus a
backfill and a read path that tolerates un-backfilled rows. That is why it is a
spec gate and not an implementation detail.

## 6. Testing

- Every check added is mutation-probed: the defect it claims to catch is
  reintroduced and the check must fail. Where a guard cannot be made to fail,
  that is stated in place rather than papered over (see the `activeFilterRef`
  comment in `useInbox.ts` for the precedent set in this mission).
- `app/test/unreadIndexFakeMirror.integration.test.ts` runs the byUnread fake
  and the REAL repo over identical inputs. Any new index semantics are added
  there rather than trusted to the fake, which has drifted before. The fake
  THROWS on a resume inside a `last_activity_at` tie - the one input where fake
  and service diverge.
- `app/test/updateCallStatus.integration.test.ts` is the pin-the-real-repo
  pattern for DynamoDB semantics the fakes cannot carry;
  `resetUnreadIfUnread`'s conditional-failure behaviour is proved there.
- The `useInbox` fix's acceptance is a soak of
  `call-inbox-unread.spec.ts`, which reproduced at 1-in-38 pre-fix.
- Four gates bare from the worktree at handback: typecheck, test, smoke, e2e.

## 7. Out of scope

- The three conversation hooks of `thread-hooks-refetch-whole-page-per-event`.
- Remedy 3 of the fill loop (one iterator threaded through), unless the
  measurement demands it.
- Re-litigating the accepted trade that Retry is ineffective on a truncated
  page (review round 4 ruling), or the silent undercount inside the residue
  wall past the probe bound.
- A pre-existing lint error in `app/src/routes/inbox.ts` (`ConversationParticipant`
  declared but never used) that is present on `main` and is not this mission's
  to fix silently.
