# Slice T1 report - participantNames + contactDisplayName

Commit: `8902089e` (4 files, 226 insertions, 18 deletions).

## Files

- Created `app/src/lib/participantNames.ts`
- Modified `app/src/lib/contactName.ts` (deleted the `ContactItem` type import at
  :7; replaced the docblock + function at :50-73)
- Created `app/test/participantNames.test.ts`
- Modified `app/test/contactName.test.ts` (`ContactDisplayItem` added to the
  existing type import at :9; one describe block appended)

## RED evidence

`cd app && npx vitest run test/participantNames.test.ts` (exit 1):

```
FAIL test/participantNames.test.ts [ test/participantNames.test.ts ]
Error: Cannot find module '../src/lib/participantNames.js' imported from
'W:/tmp/participant-snapshot-refresh/app/test/participantNames.test.ts'
 Test Files  1 failed (1)
      Tests  no tests
```

`npm run typecheck` from the worktree root (exit 2):

```
test/contactName.test.ts(117,31): error TS2345: Argument of type 'ContactDisplayItem' is not assignable to parameter of type 'ContactItem'.
  Property 'type' is missing in type 'ContactDisplayItem' but required in type 'ContactItem'.
test/participantNames.test.ts(7,8): error TS2307: Cannot find module '../src/lib/participantNames.js' or its corresponding type declarations.
test/participantNames.test.ts(49,21): error TS7006: Parameter 'p' implicitly has an 'any' type.
```

(plus four more TS7006 at :55, :82, :90, :101 - all downstream of the
unresolved module; every one cleared once the module existed.)

## GREEN evidence

`cd app && npx vitest run test/participantNames.test.ts test/contactName.test.ts`
(exit 0):

```
 v test/contactName.test.ts (46 tests) 6ms
 v test/participantNames.test.ts (9 tests) 11ms
 Test Files  2 passed (2)
      Tests  55 passed (55)
```

`npm run typecheck` from the worktree root, run bare: **exit 0**.

Importers, `cd app && npx vitest run test/voiceWebhook.test.ts test/inboundMessagePush.test.ts`
(exit 0):

```
 v test/voiceWebhook.test.ts (40 tests) 677ms
 v test/inboundMessagePush.test.ts (20 tests) 1678ms
 Test Files  2 passed (2)
      Tests  60 passed (60)
```

Extra (not required by the slice): `npx eslint` on the four touched files,
exit 0, zero output.

## Divergences from the plan

1. **D-F5 comment added** (worklist directive, not in the plan text): three
   comment lines above the "a throwing batch..." test stating that the real
   `getDisplaysByIds` never rejects (it swallows a failed chunk and returns a
   SHORT map, `contactsRepo.ts:824-852`) and that the test guards the module's
   never-reject contract against a fake or future repo that does throw.
2. **Commit-message repair.** The first commit attempt passed a PowerShell
   here-string to a bash shell; the message was mangled (`de84d8dd`, subject
   prefixed with a stray `@`, body truncated, trailer lost). Amended
   immediately to `8902089e`. The tree content was correct on both; only the
   message changed. `de84d8dd` exists only in the reflog.

Nothing else. Both test files and both implementation blocks are the plan's
text verbatim.

## Exported contract for downstream slices

`app/src/lib/participantNames.ts`:

```ts
export type NameSource = Pick<ContactsRepo, 'getDisplaysByIds'>;

export function collectRosterContactIds(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): string[]

export async function resolveRosterNames(
  convs: readonly Pick<ConversationItem, 'participants'>[],
  contacts: NameSource,
  log: Logger,
): Promise<ReadonlyMap<string, ContactDisplayItem>>

export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  names: ReadonlyMap<string, ContactDisplayItem>,
): ConversationParticipant[]

export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: NameSource,
  log: Logger,
): Promise<T[]>
```

`app/src/lib/contactName.ts`:

```ts
export function contactDisplayName(
  contact: { contactId: string; firstName?: unknown; lastName?: unknown } | undefined,
): string | undefined
```

## Open worries

1. **A fake without `getDisplaysByIds` makes a green test vacuous.**
   `resolveRosterNames` catches EVERY throw, so a contacts fake missing the
   method raises a runtime TypeError that is swallowed into an empty map -
   every member keeps its stored name and the assertion passes for the wrong
   reason. T3 (inboxGroups/inboxFeed/inboxUnreadParity fakes) and T5 must add
   the method, and should assert the batch was CALLED, not only that names
   resolved. The worklist already flags the T3 fakes; this is why it matters.
2. **`hydrateConversationRosters` always writes a `participants` array.** A row
   whose `participants` is `undefined` comes out with `participants: []`, not
   `undefined`, because `withLiveNames` normalizes. Harmless for group/relay
   rows (the intended callers) but a serialized 1:1 payload would gain an empty
   array if a caller hydrates rows indiscriminately. Hydrate multi-party rows
   only, or accept the new key.
3. **Spec-stated limit, unchanged:** the chain cannot tell "read failed" from
   "contact has no name", so a deliberately cleared contact name keeps showing
   the stored snapshot.
4. Nothing calls the new module yet, so T1 is behavior-neutral by construction;
   the first real behavior evidence lands in T2/T3.
