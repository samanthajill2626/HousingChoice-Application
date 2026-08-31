# Rework slice 2 - delete the Unknown tab's resurfacing sweep

Branch: `feat/inbox-unread-cluster`
Worktree: `W:\tmp\inbox-unread-cluster`
Commit: **3029fe63** `perf(inbox): delete the unknown tab's deleted-contact resurfacing sweep`
(5 files changed, 215 insertions, 317 deletions)

---

## 1. What was deleted

All of it from the `filter === 'unknown'` branch in
`W:\tmp\inbox-unread-cluster\app\src\routes\inbox.ts`:

- The `const sweepBudget = deps.unknownSweepBudget ?? UNREAD_WALK_LIMIT;` line.
- The `collectUnreadRows({ conversations, contacts, messages, logger: log },
  { maxRows: sweepBudget, budget: sweepBudget })` call.
- Its `warnDeletedProbes(...)` and `warnUnreadScanned(...)` calls.
- The whole resurfacing candidate loop over `collected.candidates` - the
  `kind !== 'contact'` skip, the `UNKNOWN_QUEUE_TYPES` membership test, the
  `isDeleted` test, the `emitted` belt, the thread resolution, and the
  `resurfaceNoOpenThread` / `deletedNoUnread` / `resurfaceHidden` drops inside it.
- The `if (collected.truncated || collected.capped)` floor WARN
  ("inbox: the unknown-tab resurfacing sweep stopped early - the deleted-row set
  is a floor").
- The three log fields on the `inbox feed assembled` line that only described it:
  `sweepScanned` (unconditional), `resurfaceTruncated`, `resurfaceCapped`.
- The `unknownSweepBudget?: number` test seam from `InboxRouterDeps`.

Replaced by a comment block stating the 2026-08-26 ruling, the product reason
(a deleted contact is one you have ALREADY triaged), and the two facts the
ruling rests on.

### KEPT, as instructed

The `if (emitted.has(contact.contactId)) continue;` guard in the partition loop
is untouched. Its comment was rewritten because it previously justified itself by
pointing at "the sweep loop below"; it now states plainly that it guards the
PARTITION read against the mid-walk `status`-flip duplicate and names its own
regression test. Its test (`a DUPLICATED queue item ships ONE row`) still passes.

### Comments corrected in the same file (they described deleted code)

- The read-accounting block's `unknown`-branch bullet (it listed `sweepScanned` /
  `resurfaceTruncated` / `resurfaceCapped` as fields the branch emits). Now says
  they are GONE, so an old log query returns nothing rather than zeroes.
- The branch header's "THE SWEEP PATH IS GENUINELY DIFFERENT and must not be
  optimised the same way" carve-out - there is one hydration path now.
- `rowForConversation`'s `deletedNoUnread` fast-path comment, which said the
  equivalent guard "now lives in the unknown branch's resurfacing loop".

## 2. Import audit - all six named symbols, plus a seventh nobody named

Checked by grep over the post-deletion file for every remaining use.

| symbol | verdict | surviving users |
| --- | --- | --- |
| `collectUnreadRows` | **STAYS** | `filter=unread` branch (`inbox.ts:1314`), badge `countUnreadRows` (`:2039`) |
| `UNREAD_WALK_LIMIT` | **STAYS** | unread branch budget (`:1145`), badge (`:2043`, `:2061`) |
| `warnDeletedProbes` | **STAYS** | unread branch (`:1414`), badge (`:2049`) |
| `warnUnreadScanned` | **STAYS** | unread branch (`:1419`) - this was the closest call, the sweep was one of only two callers |
| `isDeleted` | **STAYS** | `buildContactRow` caller (`:969`), unread hydration (`:1251`), relay owner check (`:2309`), mark-unread (`:2336`) |
| `BADGE_COUNT_CAP` | **STAYS** | badge `maxRows` (`:2042`) and the `InboxUnreadCount` docblock |
| **`UNKNOWN_QUEUE_TYPES`** | **DELETED - orphaned** | none. It was imported from `lib/unknownQueue.js` for the sweep loop's type-membership test ONLY, and the sweep was its single call site. Not on the named list; found by auditing the file rather than the list. |

`npx eslint app/src/routes/inbox.ts` exits 0 (no output). Run again over all four
touched `.ts` files together - also clean, exit 0.

## 3. The class (d) premise - PROVEN, not assumed

I wrote the new parity assertion FIRST, ordered the `filter: 'all'` half BEFORE
the absence half, and ran it against the UNCHANGED `inbox.ts` (sweep still
present). That makes the `all` half a standalone proof rather than a footnote to
a passing test.

The assertion, in `app/test/inboxUnknownParity.test.ts`:

```ts
    const all = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(world));
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]).toMatchObject({ contactId: 'c-del', deleted: true, needsTriage: true });
```

Result of that pre-deletion run: **PASSED.** The test failed only at line 169 -
the `expect(unknown.rows).toEqual([])` line, which cannot pass until the sweep is
removed - and the reported received value proves the All row exists:

```
 FAIL  test/inboxUnknownParity.test.ts > class d: ...
 AssertionError: expected [ { kind: 'contact', ... } ] to deeply equal []
 ...
 test/inboxUnknownParity.test.ts:169:26
   169|     expect(unknown.rows).toEqual([]);
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Vitest evaluates assertions in order, so lines 165-166 (`all.rows`) both ran and
both passed before line 169 threw. The premise holds: with the sweep in place or
not, `filter: 'all'` surfaces `c-del` with `deleted: true, needsTriage: true`,
channel `sms`, direction `inbound`, preview `hello?`.

The second half of the premise (`GET /api/contacts/:contactId` does not 404 a
soft-deleted contact) was given to me as already verified by the caller; I did
not re-derive it, and I recorded it in the code comment and the issue file as a
stated fact rather than as something this slice proved.

## 4. Tests: deleted vs rewritten

### `app/test/inboxUnknownParity.test.ts` - REWRITTEN (class d)

Was: "a soft-deleted unknown ... resurfaces, deleted:true (must survive the
flip)". Now: "... leaves the triage queue (RULED 2026-08-26) but resurfaces on
All - the accepted trade". Same fixture, hoisted into a `World` so both filters
run against the same world. Now the same SHAPE as the class (e) pin: absent from
the queue, present on All. The comment says outright that a red `all` assertion
means the ruling's premise is wrong.

### `app/test/inboxUnknownTab.test.ts`

**DELETED (2), both sweep-only:**

1. `class d via byUnread: a soft-deleted unknown ... resurfaces; outbound-only
   does not; a deleted team_member NEVER does`. Every assertion was about what
   the sweep admitted. The surviving class (d) statement is the parity pin.
2. `a CAPPED sweep is a floor and says so - capped MASKS truncated in
   CollectResult, so the branch must read both flags`. Pinned the `|| capped`
   read on a `CollectResult` the branch no longer produces; it also used the
   `unknownSweepBudget` seam that no longer exists.

A short comment stands where they were, naming both and pointing at the parity
file, so their absence reads as a decision rather than an omission.

**REWRITTEN (1) - the cost pin, `THE READ THAT SHIPS`.** Rewritten rather than
deleted for exactly the reason given: a cost claim with no test is how the old
walk survived. Same unread-heavy fixture, new title
(`ONE partition Query and nothing else - no byUnread walk, no contact read per
unread item`).

| assertion | before | after |
| --- | --- | --- |
| rows | `['c-unk', 'c-del']` | `['c-unk']` |
| `listByType` | 1 | 1 |
| `listByLastActivity` | 0 | 0 |
| `queryUnreadPage` | **1** (one index page) | **0** (byUnread never touched) |
| `findByPhone` | **3** (one per VISIBLE UNREAD ITEM - the accepted O(all unread) term) | **0** |
| `findByParticipantPhone` | 2 (queue row + resurfaced row) | 1 (queue row) |
| `listByConversation` | 3 (resurfacing probe + 2 rendered rows) | 1 (one rendered row) |
| log | `assembled.sweepScanned === 3` | `expect(assembled).not.toHaveProperty('sweepScanned')` |

The field is asserted ABSENT rather than 0 on purpose: a zeroed field would let
an old log query keep "working" while meaning nothing.

**ADJUSTED (3), not sweep-only:**

- `costs one partition Query, never the open-partition walk...`:
  `queryUnreadPage` 1 -> 0, and the comment explaining why the fixture is
  deliberately read-only now says that reason expired (the rewritten cost pin
  above proves unread-independence outright on an unread-heavy fixture).
- `sorts partition rows and resurfaced rows together...` -> `sorts the triage
  rows newest displayed activity first - and the soft-deleted unknown between
  them is simply not there`. Expected `['c-new','c-mid','c-old']` ->
  `['c-new','c-old']`. **I kept `c-mid` in the fixture deliberately** - it is a
  soft-deleted unknown with a fresh post-deletion inbound sitting BETWEEN the two
  live rows by activity, so any future re-admission of deleted contacts trips
  this pin in the middle of the list rather than at an edge.
- `a DUPLICATED queue item ships ONE row`: comment only. It said the sweep loop
  "three statements later" was the guard's sibling; it now says the sweep was the
  only reader of `emitted` before the guard landed and that the guard is not the
  sweep's leftover.

### `app/test/inboxFeed.test.ts` - ADJUSTED (1)

`filter=unknown never walks the open partition: a tenant world costs one
listByType and nothing per-conversation` asserted `queryUnreadPage: 1` inside a
whole-object `toEqual`. **This is the one failure that was not predicted by my
scope**, and I checked it against the stop-condition: it is squarely ABOUT the
sweep (the comment on the line reads "One byUnread probe: the
deleted-resurfacing sweep (class d) rides the sparse index"), so it is an
expected repin, not a hidden coupling. Changed to `queryUnreadPage: 0`; the
fixture's `unread_count: 0` comment was likewise marked as an expired reason
rather than silently left.

## 5. Record update - `docs/issues/inbox-filter-tabs-full-walk.md`

- The `UNKNOWN: RESOLVED 2026-08-25` bullet no longer describes resurfacing
  "through ONE budget-bounded byUnread sweep whose two stop flags ... are BOTH
  floor signals". It now says the triage partition Query is the branch's only
  read, and points at the ruling.
- **Three passages deleted outright** and replaced by one dated ruling block
  (`CLASS (d) RESOLVES ON THE ALL AND UNREAD TABS, NOT HERE`): the sweep's
  ceiling-and-crossover note, the "why the sweep is paid even at a measured
  population of zero" argument, and the capped-sweep residual. The new block
  states the product reason, the two facts the ruling rests on, the cost that
  went away, and names the deleted WARN and log fields so a reader searching for
  them learns they are gone rather than concluding the logging broke.
- **The `~700 crossover` figure is RETRACTED, not corrected.** The issue file now
  records that it was wrong on its own terms - it priced one page LOAD against
  one walk while `useInbox` refetches on every debounced `conversation.updated`,
  so the sweep was re-paid per INBOUND MESSAGE - and says explicitly not to
  resurrect it in a corrected form, because there is no sweep left to price. No
  replacement number was published.
- The COLLECTOR-truncation residual, which was written as the second half of a
  pair, now reads as the only residual of its shape and carries its own reopen
  trigger (it previously said "same reopen trigger as the sweep residual").
- The round-2 N1 hydration deferral lost its "leave the SWEEP path alone"
  carve-out, marked as superseded rather than silently dropped.

## 6. Verify output

All bare, no pipes into the gate command itself.

```
cd W:/tmp/inbox-unread-cluster/app
npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts \
  test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts \
  test/unknownQueue.test.ts test/contactsPartitionFake.test.ts

 Test Files  7 passed (7)
      Tests  168 passed (168)
   Duration  4.74s
```

```
cd W:/tmp/inbox-unread-cluster/app
npx vitest run test/inbox.integration.test.ts     (after npm run db:start)

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  5.00s
```

```
cd W:/tmp/inbox-unread-cluster
npm run typecheck

app / dashboard / e2e / fake-twilio / fake-twilio-web  - all clean, exit 0
```

```
cd W:/tmp/inbox-unread-cluster
npx eslint app/src/routes/inbox.ts
  -> no output, exit 0

npx eslint app/src/routes/inbox.ts app/test/inboxUnknownTab.test.ts \
  app/test/inboxUnknownParity.test.ts app/test/inboxFeed.test.ts
  -> no output, exit 0
```

ASCII check on the diff's ADDED lines: `git diff -U0 | grep '^+' |
LC_ALL=C grep -n '[^ -~\t]'` returned nothing.

Not run, per scope: `npm test` (full), `npm run smoke`, `npm run e2e`.

## 7. Surprising / worth knowing

1. **A seventh orphan the brief did not name.** `UNKNOWN_QUEUE_TYPES` was
   imported for the sweep loop's type-membership test and had no other user. The
   six named symbols all survived; the one that actually died was outside the
   list. Auditing the FILE rather than the list is what caught it - and
   `no-unused-vars` would have caught it too, which is the point of running the
   lint rather than reasoning about it.
2. **`warnUnreadScanned` came within one call site of dying.** The sweep was one
   of exactly two callers in `inbox.ts`; the unread branch is the other. Had this
   slice also touched the unread branch, it would have orphaned.
3. **One out-of-file repin.** `inboxFeed.test.ts` carried a whole-object
   `toEqual` call-count pin for `filter=unknown` that included the sweep's index
   Query. It was not in the named test files, and a whole-object `toEqual` is
   exactly the shape that surfaces such couplings loudly - which is a point in
   its favour, not against it.
4. **The sweep's cost was understated in the record, not overstated.** The
   retracted crossover analysis compared per-page-load cost to the old walk, but
   the Unknown tab refetches on every debounced `conversation.updated`. So the
   sweep was O(all visible unread) per INBOUND MESSAGE while an operator sat on
   the tab - and it was buying resurfacing for a population measured at ZERO in
   both dev and prod.
5. **Class (d) and class (e) are now the same shape**, which is a tidier record
   than before: two coverage classes that leave the triage queue and are held
   honest by an `all`-tab assertion in the same world.
