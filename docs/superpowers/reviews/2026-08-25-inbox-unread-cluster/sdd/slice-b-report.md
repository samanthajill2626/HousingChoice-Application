# Slice B report - T4, the unknown-queue collector

Branch: `feat/inbox-unread-cluster`
Worktree: `W:\tmp\inbox-unread-cluster`
Commit: **ffb1c8d7** - `feat(inbox): bounded unknown-triage-queue collector with fill loop, cap, and WARN`
Files (both NEW, nothing else touched):

- `app/src/lib/unknownQueue.ts`
- `app/test/unknownQueue.test.ts`

## 1. The red run (test written first, module absent)

`cd W:\tmp\inbox-unread-cluster\app` then `npx vitest run test/unknownQueue.test.ts`

```
FAIL  test/unknownQueue.test.ts [ test/unknownQueue.test.ts ]
Error: Cannot find module '../src/lib/unknownQueue.js' imported from
  'W:/tmp/inbox-unread-cluster/app/test/unknownQueue.test.ts'
 test/unknownQueue.test.ts:6:1
Caused by: Error: Failed to load url ../src/lib/unknownQueue.js
  (resolved id: ../src/lib/unknownQueue.js) ... Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

Exactly the failure the plan predicted - a suite-load failure on the missing
module, not an assertion failure. Nothing collected, so no test could have
passed vacuously.

## 2. The green run

Same command, after writing the module:

```
 v test/unknownQueue.test.ts (8 tests) 14ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  19.87s
```

**8 passed, 0 failed, 0 skipped** - the plan's expected count.

Every pin the plan predicted held on the FIRST green run. No pin was adjusted,
weakened, or re-derived. Named explicitly because the prompt flagged them as
stop-and-report triggers:

- residue-fill test: `pagesWalked` **4** (predicted 4)
- page-budget test: `pagesWalked` **3** (predicted 3), `truncated` true,
  `warn` called once with `{ pages: 3, kept: 0 }`
- exact-page-multiple test: `truncated` **true** (the conservative floor)
- drains-below-page-size test: `truncated` **false**, no WARN

The LEK rule ("Limit reached", not "rows remain") is what produces the 4 in the
first of those, and the slice-A fake implements it, so the two agree without any
intervention.

## 3. Regression check - slice A suites

`npx vitest run test/contactsPartitionFake.test.ts test/inboxUnknownParity.test.ts`

```
 v test/contactsPartitionFake.test.ts (7 tests) 6ms
 v test/inboxUnknownParity.test.ts (7 tests) 11ms

 Test Files  2 passed (2)
      Tests  14 passed (14)
```

Unchanged - this module lands standalone and is imported by nothing yet.

## 4. Typecheck

`cd W:\tmp\inbox-unread-cluster` then `npm run typecheck` - **exit 0**, all five
workspaces (app / dashboard / e2e / fake-twilio / fake-twilio-web). Run bare, exit
code read directly (no pipe, no chain).

This is the gate that actually checks the `as const satisfies
Record<ContactType, 'queried' | 'excluded'>` map and the `Pick<ContactsRepo,
'listByType'>` deps shape; vitest's esbuild strips both without checking.

## 5. Extra check (not required by the task, cheap and clean)

`npx eslint app/src/lib/unknownQueue.ts app/test/unknownQueue.test.ts` - **exit
0**, no output. Both files are `.ts`, so unlike a `.mjs` path this is a real
lint pass, not the known empty-config hole. Gate 5 for this slice's own files is
therefore already satisfied.

## 6. Deviations from the plan's literal code

**NONE.** Both files are the plan's Task 4 code transcribed verbatim - every
comment, doc block, constant, log string, and assertion. Nothing was renamed,
reordered, shortened, or "improved". Specifically preserved on purpose:

- the multi-partition NOTE comment inside `collectUnknownTriageQueue`, kept
  verbatim even though the second-partition path is unexercised today (it is the
  instruction for whoever maps a second `queried` type, not dead-code cruft);
- the LOUD BY CONTRACT doc block - the collector does not catch, so a failed
  partition Query propagates rather than degrading to an empty queue;
- both NOT-COPIED rationales (`status: 'needs_review'` narrowing and
  `excludeOrigin`), which are the design record for the two protections this
  reader deliberately drops.

Both files are ASCII-only. No file outside the two was read-modified;
`twilioWebhookHarness.ts` and `contactsPartitionFake.ts` were read only.

## 7. Surprises, and pins I had to think about

- **No surprises in the run.** The one place I stopped and hand-simulated before
  running was the pair of `pagesWalked` pins, because the prompt named them as
  the encoding of the LEK rule and told me not to repin them. Hand-tracing the
  residue-fill case against `contactsPartitionFake.ts`: page 1 `[001,002]` both
  deleted -> empty page + LEK; page 2 `[003,004]` same; page 3 `[005,006]` live
  AT the Limit -> two rows + LEK; page 4 `slice(6,8)` = `[]`, `page.length (0)
  === limit (2)` is false so NO LEK -> `exhausted`. Four. The run agreed. Worth
  recording that the fourth Query is a **provably empty read** whose only job is
  to prove the stream ended - that is the extra round trip an items-remaining
  fake would have hidden.
- **The `deleted` option is BINARY, not tri-state.** Confirmed against the
  research file's byte-exact `listByType` body (`opts.deleted === true ?
  attribute_exists : attribute_not_exists`, FilterExpression ALWAYS present). Per
  the orchestrator's instruction I did NOT edit the spec or the plan, and nothing
  in the module depends on which wording is used - the collector passes no
  `deleted` at all, which the first test pins (`calls[0].deleted` undefined).
- **Two mutation probes verified as non-vacuous, not just present.** The slice-A
  fake honours `opts.status` (as a partition-level key condition) and
  `opts.excludeOrigin` (as a page-level filter), so re-adding either narrow to
  the collector would both empty the first test's row set AND flip its
  `toBeUndefined()` pins. The probes can go red. The `unk(2, { status: 'active'
  })` and `unk(3, { origin: 'group_detection' })` fixtures are exactly the rows
  that would disappear.
- **`as never` on the logger fake is load-bearing**, per the research file: a
  structural `{ info, warn, error, debug }` does not satisfy pino's `Logger`
  (which carries `child`, `bindings`, `level`, EventEmitter members). The cast is
  required, not stylistic - and typecheck would have caught its removal.
- **`warn(obj, msg)` argument order matters** for
  `warn.mock.calls[0][0]` to be the fields object. pino's `LogFn` also has a
  string-first overload, so writing `log.warn('message')` would compile and
  silently break that assertion. The module uses the fields-first house style.

## 8. Scope boundary

`app/src/routes/inbox.ts` is UNTOUCHED - the flip is Task 5. This module is
currently imported by nothing except its own test, which is the intended landing
state for this slice.
