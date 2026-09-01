# T3 - Inbox group and relay rows

Commit: `5e4416e5` feat(inbox): group and relay row titles resolve names with one batch per page

## Red

`cd app && npx vitest run test/inboxGroups.test.ts -t "resolve on read"`

```
 x roster names resolve on read (M1) > titles group rows from the CONTACT names, one batch per page
   -> expected [ 'With Ann & (404) 555-0112', ...(1) ] to deeply equal [ 'With Annika & Marc', ...(1) ]
 x roster names resolve on read (M1) > titles a relay row from the contact name
   -> expected 'With Ann Tenant' to be 'With Annika'

- Expected
+ Received
  [
-   "With Annika & Marc",
-   "With Annika & Marc",
+   "With Ann & (404) 555-0112",
+   "With Ann & Marcus",
  ]

 Test Files  1 failed (1)
      Tests  2 failed | 18 skipped (20)
```

Matches the worklist's corrected red values exactly (not the plan's, which
predicted `'With Ann'` for relay and did not account for gt-2 keeping the
default roster).

## Green

`cd app && npx vitest run test/inboxGroups.test.ts test/inboxApi.test.ts test/inboxFeed.test.ts test/inboxUnreadParity.test.ts`

```
 Test Files  4 passed (4)
      Tests  141 passed (141)
```
exit 0

`npm run typecheck` (BARE, from the worktree root): exit 0. All five workspaces
compiled (app x3 tsconfigs, dashboard, e2e, fake-twilio, fake-twilio-web).

## Batches per filter, as implemented

| filter | batches | where |
|---|---|---|
| `groups` | 1 | `inbox.ts:1250` above `page.items.map` |
| `all` | 2 | `:2315` (relay partition, above the loop) + `:2386` (group partition) |
| `unread` | 1 per multi-party candidate | `:1435`, beside that arm's existing point read |
| `unknown` | 0 | returns from its own branch before either merge |

No per-member read added; no `getById`, `findByPhone` or `requireComplete`
introduced. `participants[].phone` untouched - `withLiveNames` only ever
rewrites `name`. `groupThreadLabel` / `relayThreadLabel` unchanged.

## Divergences from the plan

1. `ContactDisplayItem` went into the EXISTING `../repos/contactsRepo.js` import
   block (`:70-76`) rather than the plan's separate `import type` line. Same
   symbol, one import statement instead of two; that block already imports
   `isDeleted` and two other types from the same module.
2. The `:1418` arm's row expression is wrapped across four lines rather than the
   plan's single line - the two-arg calls push it past the print width and
   prettier/eslint would reflow it anyway.
3. Comments added at each of the four batch sites and both builders naming the
   batch posture. The plan only specified the two builder comments.

Nothing else diverges. All plan anchors matched the tree.

## Open worries

1. **The `unread` arm is the one uncapped-looking cost.** It is bounded by the
   page limit and rides beside a point read that arm already does per row, so it
   adds no round-trip class that was not already there - but it is N batches per
   page where the other filters pay 1. The spec's cost row accepts this; a
   reviewer who has not read that row will flag it.
2. **`filter=all` pays two batches and they can overlap.** A contact in both a
   relay roster and a group roster is fetched twice on one page. Merging them
   would mean hoisting one read above the 1:1 pager and holding the map across
   ~50 lines of unrelated logic; the plan chose the two reads deliberately.
3. **`inboxFeed` and `inboxUnreadParity` now resolve zero names by construction**
   (their explicit `getDisplaysByIds` returns an empty map). That is honest -
   those suites pin pre-existing behavior, and an empty map means every member
   keeps its stored name - but it also means neither suite would notice a
   regression in the name chain. `inboxGroups` is the only guard.
4. The `displayBatches` assertion proves the batch was CALLED and with which
   ids, but nothing in this slice pins the batch COUNT for `filter=all` (2) or
   for `unread` (N). If the cost rows matter to someone downstream, they are
   currently documented, not tested.
