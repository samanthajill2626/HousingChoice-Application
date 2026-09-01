# Slice T2 report - Today `who` + relay close-nag names

Commit: `cde72c74` (3 files, 114 insertions, 10 deletions).

## Files

- Modified `app/src/routes/today.ts` (import of `../lib/participantNames.js`
  beside the other `../lib/` imports; `whoOfConversation` + docblock -> the
  two-argument version; the `unreadOneToOne` emit-loop call site; the close-nag
  loop -> `dueGroups` filter + one `hydrateConversationRosters`)
- Modified `app/test/todayApi.test.ts` (one `describe('participant names
  resolve on read (M1)')` block appended inside the top-level describe)
- Modified `dashboard/src/routes/today/buildToday.ts` (`conversationWho`
  non-empty guard)

## RED evidence

`cd app && npx vitest run test/todayApi.test.ts -t "participant names"`
(exit 1):

```
   x RED: a stale participant_display_name loses to the contact name
     -> expected 'Old Name' to be 'Renata New'
   x RED: no stored name plus a named contact shows the contact
     -> expected '(555) 010-7777' to be 'Renata New'
   v PIN: an unreadable contact keeps the stored name
   v PIN: an unlinked thread (no contactId) still renders the formatted phone
   v PIN: resolving names adds NO contact reads - the deleted-check already memoized them
   x RED: relay close-nag member names come from the contacts
     -> expected [ 'Old Nag', '(555) 010-0012' ] to deeply equal [ 'Nadia Nag', '(555) 010-0012' ]
 Test Files  1 failed (1)
      Tests  3 failed | 3 passed | 55 skipped (61)
```

The three RED values are exactly the ones the plan predicted; all three PINs
were green before the change.

## GREEN evidence

`cd app && npx vitest run test/todayApi.test.ts` - **exit 0**:

```
 v test/todayApi.test.ts (61 tests) 500ms
 Test Files  1 passed (1)
      Tests  61 passed (61)
```

(Re-run after the temporary instrumentation was removed; same 61/61, exit 0.)

`cd dashboard && npx vitest run src/routes/today/buildToday.test.ts` -
**exit 0**:

```
 v src/routes/today/buildToday.test.ts (21 tests) 9ms
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

`npm run typecheck` from the worktree root, run bare: **exit 0** (all five
workspaces).

## Contact-read count (for the T10 issue stamp)

In the PIN read-count test's `/api/today` request, `contactsRepo.getById`
received **1 distinct contact id (1 call total)** - measured with a temporary
`console.log` in the test, identical before and after the change. The thread's
contact is read once by the deleted-contact gate; `whoOfConversation` adds
none. The instrumentation was removed before the commit.

## Divergences from the plan

1. **No `as ConversationItem` cast** on either new fixture. The worklist's
   reading held: `seedConversation` takes a full `ConversationItem` and every
   field the fixtures use (`relay_status`, `close_nag_next_at`, `pool_number`,
   `unread_count`) is declared, so typecheck is clean without one.
2. **Fixture comment cites `twilioWebhookHarness.ts:777-781`** (the worklist's
   correction), not the plan's bare `:777`.
3. **Two comments kept/added, no code difference.** The close-nag loop's
   original "Only groups with a DUE nag (<= now)" comment was moved onto the
   new `dueGroups` filter (plus one line naming the pool-number drop) rather
   than deleted with the lines it described; `conversationWho` in buildToday.ts
   keeps its existing `?? ''` comment and gains one sentence saying why the
   stored name must be non-empty. Both are the plan's code verbatim otherwise.

Nothing else. The implementation blocks and all six tests are the plan's text.

## Open worries

1. **The close-nag batch is unasserted as a BATCH.** The RED test proves the
   names resolve, but the harness fake would satisfy it just as well with a
   per-member read; nothing pins that exactly one `getDisplaysByIds` call
   happens for the page. T1's open worry 1 (a fake missing the method degrades
   silently to "no names resolved") does not bite here - the harness fake at
   `twilioWebhookHarness.ts:1695` implements it - but a call-count assertion is
   the only thing that would keep a future refactor honest.
2. **`hydrateConversationRosters` normalizes `participants` to `[]`.** Only the
   due relay groups are hydrated and `memberNames` already used
   `conv.participants ?? []`, so nothing on the wire changes; the hydrated rows
   are local to the loop and never serialized.
3. **`whoOfConversation` is now only correct where the contact is memoized.**
   It has exactly one call site (the unread emit loop), where the deleted-check
   at `:743` guarantees the memo hit. A second caller that skips `getContact`
   would silently pay a new read - the docblock says so, but nothing enforces
   it.
4. **Not run in this slice** (orchestrator-owned gates): `npm test`,
   `npm run smoke`, `npm run e2e`, eslint.
