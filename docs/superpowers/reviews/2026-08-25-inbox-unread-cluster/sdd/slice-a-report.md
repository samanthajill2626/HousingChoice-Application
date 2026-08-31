# Slice A report - test fixtures and the parity baseline (T1, T2, T3)

Worktree `W:\tmp\inbox-unread-cluster`, branch `feat/inbox-unread-cluster`.
Base at slice start: `1dde0bc9`. Working tree clean at start and at finish.
No production code touched; `app/src/**` is byte-identical to the base commit.
`app/test/helpers/twilioWebhookHarness.ts` NOT touched (frozen by the plan).

All three tasks landed GREEN. Nothing was bent to fit. No stop-and-report
condition was hit.

---

## T1 - `listByTypeFromContacts` shared fake

Commit: **`17579b57e03f4e2796b8a55854d80658a4941e85`**
Message: `test(inbox): DynamoDB-faithful listByType fake for the unknown-queue work`

Files created:
- `app/test/helpers/contactsPartitionFake.ts`
- `app/test/contactsPartitionFake.test.ts`

Verify: `cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/contactsPartitionFake.test.ts`

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Exit code 0. Expected 7 passed, got 7 passed.

### Deviation applied (orchestrator ruling C1) - the LEK shape

The plan mints `lastEvaluatedKey: { contactId: last.contactId }`. As directed,
the helper instead emits the full GSI key shape the real repo returns:

```ts
lastEvaluatedKey: {
  type: last.type,
  status: last.status,
  contactId: last.contactId,
}
```

Verified against `contactsRepo.ts:1021-1025` in this worktree: the repo hands
back DynamoDB's raw `LastEvaluatedKey` from a `byTypeStatus` GSI Query, so the
key carries the index keys plus the table key.

RESUMING is unchanged and still reads `contactId` only
(`partition.findIndex((c) => c.contactId === opts.exclusiveStartKey?.['contactId']) + 1`).
Both facts are stated in the file's header comment under a `KEY SHAPE` block.

The three LEK assertions in `contactsPartitionFake.test.ts` were changed from
`toEqual({ contactId: 'x' })` to `toMatchObject({ contactId: 'x' })`, so they
still pin the resume POSITION without re-pinning a key shape production never
emits. A short comment at the top of the test file says why.

Functionally inert, as predicted: no caller inspects the key, and the fake's own
resume path reads one field of it.

### Other, smaller deviation

The plan's helper comment and one test comment cite
`helpers/unreadIndexFake.ts:104-116`. Per worklist item A.4 / research D-2 the
doc block actually closes at **117**, so both new citations were written as
`104-117`. This only affects two comment strings in files I created.

---

## T2 - both aggregator fakes learn `listByType` (inert)

Commit: **`e3d949471b30f66c99945427a4bc93c43e1e2b90`**
Message: `test(inbox): fakes learn listByType (inert) ahead of the unknown-tab flip`

Files modified (32 insertions, 0 deletions - purely additive):
- `app/test/inboxFeed.test.ts`
- `app/test/inboxGroups.test.ts`

Verify: `cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/inboxFeed.test.ts test/inboxGroups.test.ts`

```
 Test Files  2 passed (2)
      Tests  80 passed (80)
```

Exit code 0. (62 from inboxFeed, 18 from inboxGroups.)

### What was added

`inboxFeed.test.ts`:
1. Import of `listByTypeFromContacts` from `./helpers/contactsPartitionFake.js`,
   placed directly above the existing `unreadIndexFake.js` import.
2. `InboxCallCounts` gained `listByType: number` and `listByLastActivity: number`;
   `emptyCallCounts()` gained their zeros.
3. `conversationsRepo.listByLastActivity` gained
   `if (calls !== undefined) calls.listByLastActivity += 1;` as the first line of
   its body.
4. `contactsRepo` gained `listByType` after `getById`, with the plan's comment.

`inboxGroups.test.ts`:
1. The same import.
2. `contactsRepo` gained `listByType` after `getById`, using the
   `(seed.contacts ?? []) as never` cast the plan specifies, with a comment
   recording WHY the partition is provably empty here (GroupSeed contacts carry
   neither `type` nor `status`, so the helper filters them out twice over).

### The grep was run, as instructed - and it agrees with the worklist

`rg` over `expect\(calls\)\.toEqual` in `inboxFeed.test.ts` returned exactly
FOUR hits, at lines **647, 727, 759, 800** (pre-edit numbering) - matching the
worklist and research section A.3 exactly. A second grep over `filter: 'unknown'`
returned exactly FIVE hits, at **407, 433, 539, 610, 739**, again matching.

Of the four `toEqual` sites, only the one at 759 sits inside a `filter: 'unknown'`
test (`rejects a resolved non-unknown contact before conversation and message
hydration`). The other three are `filter: 'unread'` tests.

### The four transcribed `listByLastActivity` counts - MEASURED, not guessed

I added the two counter fields to the fake FIRST, ran the suite, and read the
four actual values out of vitest's own diff output before writing any literal.
The failing run reported (post-edit line numbers in parentheses):

| Site (post-edit line) | Test | filter | `listByType` | `listByLastActivity` |
|---|---|---|---|---|
| 661 | a read no-contact row is not in the unread index | `unread` | 0 | **0** |
| 741 | a fully-read contact is not in the unread index | `unread` | 0 | **0** |
| 773 | rejects a resolved non-unknown contact before hydration | `unknown` | 0 | **1** |
| 814 | keeps a failed contact-conversation lookup excluded from unread | `unread` | 0 | **0** |

`listByType` is 0 at all four sites, which is the direct proof that the T2
addition is inert: nothing in `aggregateInbox` calls it yet.

The measured values happen to match the plan's prediction (0 for the three
unread tests, 1 for the unknown test that walks the pager once today), but they
were read off the run, not copied from the plan.

The `listByLastActivity: 1` literal carries a two-line comment noting that the
unknown filter walks the open-partition pager once today and that this pin is
what will show the contact-side read replacing that walk.

### The five `filter: 'unknown'` sites all stayed green untouched

None of the five call sites (407, 433, 539, 610, 739 pre-edit) needed an edit,
and none went red. The fake is inert by construction, as required.

---

## T3 - parity baseline against the CURRENT pager

Commit: **`c92767f3ccdd35cbb73e1338be5c78f884c85c06`**
Message: `test(inbox): parity baseline for the unknown tab, class by class, pre-flip`

File created: `app/test/inboxUnknownParity.test.ts` (185 lines).

Verify: `cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/inboxUnknownParity.test.ts`

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Exit code 0. Expected 7 passed, got 7 passed.

Written from the plan's Task 3 code verbatim. **No assertion was changed, and no
observed row set disagreed with the plan's expectation** - every one of the seven
classes behaved exactly as the plan predicted against the current code,
including the class (d) resurfacing case, which passed first try (no fixture
adjustment to `latestMessage.created_at` or `unread_count` was needed).

The two pins the flip will amend are marked in place with `// FLIP:` comments and
their class letters:
- class e (contactless unknown number): `['+14049824978']` becomes `[]` on the
  unknown tab; the `filter: 'all'` half of that test is the mitigation and must
  survive.
- class c (`team_member`): `['c-team']` becomes `[]`.

---

## Gate: typecheck

`cd W:\tmp\inbox-unread-cluster` then `npm run typecheck` - run bare, not piped,
not `;`-chained.

All five workspaces (app, dashboard, e2e, fake-twilio, fake-twilio-web) compiled
clean. **Exit code 0.** The app workspace runs three project configs including
`tsconfig.test.json`, so the new test files and the new helper are all covered.

---

## Surprises and notes for the next slice

1. **The `as never` cast in `inboxGroups.test.ts` is load-bearing and correct.**
   `GroupSeed.contacts` is `{ contactId, phone, name? }[]`, which is not
   assignable to `readonly ContactItem[]`. The cast sits inside the fake's
   existing `as unknown as NonNullable<...>` envelope, and the helper then
   filters every element out twice (no `status`, no `type`). Typecheck is clean.

2. **No lint gate was run for this slice**, per scope. Gate 5 is the
   orchestrator's, and it should be run against the branch's own files with the
   `main...HEAD` form. The three files this slice added/modified are all `.ts`,
   so they are genuinely lint-covered (not in the `.mjs`/`.js` blind spot AGENTS.md
   warns about).

3. **No tripwire-warn assertion was written anywhere.** As directed, nothing in
   T1-T3 asserts on `warnUnreadScanned` / `warnDeletedProbes`, and no test in
   these three files touches a module-scope limiter.

4. **`app/test/inboxFeed.test.ts` emits several `level: 40` warn lines** during
   its run (`inbox: contact conversations lookup failed (best-effort)`,
   `inbox: lag discriminator read failed (best-effort)`,
   `inbox: unread point read failed (best-effort)`). These are PRE-EXISTING and
   deliberate - they come from tests that inject `participantConversationLookupError`
   and `getByIdError` to prove best-effort degradation. They are noise on the
   console, not failures, and they predate this slice. Flagging only so nobody
   reads them as new.

5. **`.git` in this worktree is a FILE (a gitdir pointer), not a directory**, so
   `ls .git/MERGE_HEAD` returns "Not a directory" rather than "No such file".
   Merge state was confirmed instead via bare `git status`, which reported a
   clean tree with no merge in progress before each of the three commits.

6. **Shell trap worth recording:** the first T1 commit was made through the Bash
   tool using PowerShell here-string syntax (`-m @'...'@`), which Bash does not
   interpret - the literal `@` became the first line of the commit message. It
   was caught immediately by reading `git log -1 --format=%B` and fixed with
   `git commit --amend`, which is why T1's hash is `17579b57` and not the
   `b3193657` from the first attempt. T2 and T3 used a plain double-quoted `-m`
   with an embedded newline. No other commit was affected; the tree content was
   never wrong.

7. **Nothing in the plan's Tasks 1-3 needed re-litigating.** The research file's
   byte-exact anchors (A.1 `InboxCallCounts` at 63-79, A.2 `contactsRepo` at
   190-210, `listByLastActivity` at 131-151, B.1 `contactsRepo` at 101-109) were
   all still accurate in the live tree today.
