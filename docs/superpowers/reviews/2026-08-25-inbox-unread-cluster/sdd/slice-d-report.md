# Slice D (T6 + T7) - integration repin + dashboard empty-state pin - implementer report

Branch `feat/inbox-unread-cluster`, worktree `W:\tmp\inbox-unread-cluster`.

## Commits

| task | hash | subject |
| --- | --- | --- |
| T6 | **2dbc0ae16dce6b4bde5952147dba437bccb7d5da** | `test(inbox): integration pins for the contact-side unknown tab on the real index` |
| T7 | **99ed025b52d20505f3252ae743e71535e97ec8ed** | `test(dashboard): pin the Unknown tab's empty-state-vs-banner gate (requirement 5)` |

Both carry `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (verified with
`git log -1 --format=%B`, the Bash tool's plain quoted `-m`, no here-string).
Bare `git status` read before each commit: T6 showed exactly
`modified: app/test/inbox.integration.test.ts` and nothing else; T7 showed
exactly `modified: dashboard/src/routes/inbox/Inbox.test.tsx` and nothing else.
Neither status reported a merge in progress. Each commit staged ONE explicit
path. Tree clean after both.

Files changed: T6 = 1 file, 39 insertions, 4 deletions. T7 = 1 file, 20
insertions, 0 deletions. Nothing under `app/src/**`, `inboxFilters.ts`,
`twilioWebhookHarness.ts`, or `e2e/**` was touched.

## Run results (all four, plus a baseline)

| # | command | result | exit |
| --- | --- | --- | --- |
| 0 (baseline, before any edit) | `npx vitest run test/inbox.integration.test.ts` | 1 file failed, **1 failed / 8 passed (9)** | non-zero |
| 1 | `npm run db:start` (repo root) | `hc-dynamodb-local already running`, `ready at http://localhost:8000` | 0 |
| 2 | `npx vitest run test/inbox.integration.test.ts` (after T6 edit) | 1 file passed, **10 passed (10)**, 4.55s | 0 |
| 3 | `npx vitest run test/performanceSeed.integration.test.ts` (UNCHANGED) | 1 file passed, **12 passed (12)**, 149.21s | 0 |
| 4 | `npx vitest run src/routes/inbox/Inbox.test.tsx` (dashboard, after T7 edit) | 1 file passed, **31 passed (31)**, 12.35s | 0 |
| 5 | `npm run typecheck` (repo root, bare) | all five workspaces clean | **0** |

Run 5's exit code was read from a bare invocation
(`npm run typecheck > /dev/null 2>&1; echo "EXIT=$?"` -> `EXIT=0`); the gate
command itself was never piped into a filter whose status could mask it.

No test was skipped, retried, or run with a modified `AWS_ACCESS_KEY_ID`. The
environmental clean-key path was NOT needed - see "Environmental check" below.

### Baseline red, for the record

Before the T6 edit the suite failed exactly once, and for exactly the right
reason:

```
x filter=unknown returns only needsTriage rows
  -> AssertionError: expected [] to have a length of 1 but got +0
     at test/inbox.integration.test.ts:328:18
```

That is the class-(e) equivalence being retired by the flip: the contactless
number `+15561001005` no longer appears under `filter=unknown`. The other 8
tests were green pre-edit, so the flip moved ONE integration pin and no more.

## T6 - what changed in `app/test/inbox.integration.test.ts`

1. **Repin (was lines 323-330).** `filter=unknown returns only needsTriage rows`
   became `filter=unknown no longer lists the contactless number - it stays on
   the All tab (class e, design 2026-08-25)`, verbatim from plan Task 6 Step 2.
   It now asserts `rows` is `[]` AND that the same number is still reachable on
   the All tab as `kind === 'unknown'` - so the repin proves the row MOVED
   rather than merely proving it vanished.
2. **New test appended between old lines 430 and 431**, i.e. after the last
   `it` (`POST /read returns 404 when no conversation exists for the phone`) and
   before the `describe`'s closing `});` - exactly as binding correction 1
   specified. Plan code used verbatim, including the three-line
   "LAST ON PURPOSE" comment explaining that it mutates the shared world while
   the split-proof paging test above pins exact page counts.

The new test creates `it-contact-unk` (`type: 'unknown'`,
`status: 'needs_review'`, phone `+15561001099`), seeds one open
`unknown_1to1` thread with `unread: 1`, and pins the wire response against the
REAL `byTypeStatus` GSI:

```
rows.length === 1
rows[0] matches { kind: 'contact', contactId: 'it-contact-unk', role: 'unknown',
                  needsTriage: true, phone: '+15561001099' }
nextCursor === null
```

**All five field pins passed on the real index on the first run.** This is the
first proof in the branch that the flip's `role`/`needsTriage`/`kind` shape
survives a real DynamoDB GSI query rather than a fake, and that the queue's
`nextCursor` is genuinely null on a one-row page.

Scaffolding checks done before writing: `contacts.createIfAbsent(item:
ContactItem)` takes a single object and `firstName`/`lastName` are optional;
`seedConv` takes one options object with `type?: string` and `unread?: number`;
`PHONE_UNK2 = '+15561001099'` does not collide with the five existing
`PHONE_*` consts (`...001` through `...005`). All matched the research file.

## T6 Step 5 - the perf-seed verdict: **PASS, as predicted**

`app/test/performanceSeed.integration.test.ts` was run **completely unchanged**
(the file is byte-identical to its committed state; `git status` never listed
it). **12 tests, 12 passed, exit 0.**

- **Line 414 (`expect(unknown.rows.length).toBeGreaterThan(0)`) SURVIVED the
  flip.** It lives inside `replaces lean group fixtures with exact generated
  native and relay workloads in its own lane`, which passed (126.6s of the
  149.2s run). The default manifest's single unknown contact
  (`perf-contact-00095`, `floor(100/100) = 1`) is contact-backed, carries
  `status: 'needs_review'`, is not soft-deleted, and has open non-relay 1:1
  threads - so the contact-side read finds it. The margin is genuinely one row,
  exactly as the worklist warned; nothing was weakened, relaxed, or edited to
  get there.
- **Line 282 (the DECOY) behaved exactly as predicted.**
  `expect((await readers.contacts.listByType('unknown', { limit: 20 })).items)
  .toEqual([])` passed. It sits in `keeps all injected route readers on the
  supplied namespace and reseeds deterministically`, hits `contactsRepo`
  DIRECTLY (never `aggregateInbox`), and describes the 22-contact manifest where
  `floor(22/100) = 0`. Untouched by the flip, not alarming, not "fixed".

No STOP condition fired.

## T7 - what changed in `dashboard/src/routes/inbox/Inbox.test.tsx`

One `describe` appended at the very end of the file (after the existing final
`});` at line 388), containing the plan's two tests verbatim, including the
four-line comment that names the DEPENDENCY on the server rule and points at
`Inbox.tsx:42` and the unknown branch's return in `routes/inbox.ts`.

**Scaffolding matched the plan's assumptions exactly - both of them, confirmed
by reading the file, not by trusting the research note:**

- `baseState(over: Partial<InboxState> = {})` at line 14 with `...over` at line
  28, so `baseState({ truncated: true })` is valid. The idiom is already used
  four times in the file.
- `renderInbox(entry = '/inbox')` at line 58 takes a URL STRING and wraps
  `<Inbox />` in a `MemoryRouter` with `initialEntries: [entry]`, so
  `renderInbox('/inbox?filter=unknown')` is the existing idiom.
- Required imports (`describe`, `it`, `expect`, `screen`) were all already
  present; no import line was added.
- `beforeEach` resets `state = baseState()` so the first test's explicit
  `state = baseState()` is redundant-but-harmless; kept verbatim per the plan.

No production dashboard code was changed. Test count went 29 -> 31.

Both tests passed on the first run, which is the expected outcome: the client
behaviour already exists. The VALUE is the pin plus the pointer - if a future
change makes the unknown branch set `truncated`, the second test is the place
that explains why the "We couldn't load your inbox." banner suddenly appears on
a cleared triage queue.

## Environmental check (the DynamoDB contention failure mode)

Not triggered. Both DynamoDB-backed files ran green on the FIRST attempt under
the normal access key, and the only pre-edit failure carried a real ASSERTION
message (`expected [] to have a length of 1`), not a timeout or a SQLite
write-lock error. Per AGENTS.md that rules out the environmental signature, so
`AWS_ACCESS_KEY_ID=hccleanrun001` was never used. `globalSetup` reported
`22 created, 0 already existed` and `globalTeardown` dropped 23 tables on each
app-workspace run, so no residue was left behind by this slice.

## Deviations

**None from the plan's code.** Both snippets were used verbatim, at the exact
insert points binding correction 1 and the research file specify. No assertion
was adjusted to match observed behaviour - every pin the plan predicted was
already what the real index and the real component produced.

Two things done BEYOND the assigned steps, both read-only or self-cleaning:

1. **A baseline run before editing** (run 0 above), to prove the class-(e)
   repin was fixing a real red rather than repinning a test that already
   passed.
2. **`npx eslint` on the two touched files** - not one of my assigned verify
   commands, run as a cheap orphan-import check. See the next section; it found
   one PRE-EXISTING error and nothing of mine. The baseline comparison used a
   temp copy under `app/test/.baseline-tmp/` which was deleted in the same
   command; `git status` afterwards is clean.

## Gate-5 note for whoever runs the completion gates (T10)

`npx eslint app/test/inbox.integration.test.ts` reports ONE error:

```
app/test/inbox.integration.test.ts
  200:7  error  'convBId' is assigned a value but never used.
                Allowed unused vars must match /^_/u   @typescript-eslint/no-unused-vars
```

**It is PRE-EXISTING and NOT this slice's.** Attributed by BASELINE COMPARISON,
not by line number, exactly as AGENTS.md demands: `git show
main:app/test/inbox.integration.test.ts` was written to a temp path and linted
under the same config, and it reports the SAME single error at the same
location. `convBId` has exactly two occurrences in both versions (declaration at
:200, assignment at :243, never read), so my edit did not delete its last use.
`dashboard/src/routes/inbox/Inbox.test.tsx` lints clean (0 problems).

Name it in the handback so nobody re-diagnoses it as branch debt.

## ASCII check

`LC_ALL=C grep -n '[^ -~\t]'` over both touched files:

- `Inbox.test.tsx` - **no matches at all**, exit 1. Fully ASCII.
- `inbox.integration.test.ts` - 11 matching lines, ALL pre-existing (em-dashes
  and arrows in the file header at :1/:9, the skip message at :47, the topology
  comment block at :172-186, the preview-path comment at :250, and the paging
  test's own title at :340 and comment at :367). **Zero matches inside either of
  my two edited ranges.** Nothing non-ASCII was retyped or introduced.

## Surprises

1. **There were essentially none, and that is itself the finding.** Every
   anchor, signature, and predicted assertion in the plan, the worklist and the
   research file matched the live tree byte-for-byte: the insert point at
   430/431, `seedConv`'s options-object signature, `PHONE_UNK2` not colliding,
   `baseState`'s override parameter, `renderInbox`'s URL string, and the
   perf-seed's one-row margin. After slice C's forced TS2367 deviation, this
   slice needed zero adaptation.
2. **The perf-seed run is SLOW - 149s, of which 126.6s is the single
   `replaces lean group fixtures...` test.** That is normal for this file (it
   reseeds a 100-contact world into its own lane) but it is worth knowing before
   T10 budgets the gate run, and it is long enough that a reader watching the
   console can mistake it for a hang.
3. **The pre-edit red was ONE test, not two.** I expected the possibility that
   the mark-read tests at 379-420 (which zero out unread on conv-A1, conv-A2 and
   conv-UNK before my new test runs) might disturb the new test's
   `toHaveLength(1)`. They did not - the research file's note that conv-C's
   contact is a live tenant excluded by both the type check and the `isDeleted`
   check held exactly, and the new contact's own unread thread is untouched by
   any earlier test.
4. **Confirmation for the record: the resurfacing sweep did not leak the
   contactless number back in.** The repinned class-(e) test asserts
   `rows).toEqual([])` on a world that still contains an open, unread,
   contactless `unknown` conversation. Under the real index that came back
   genuinely empty - so the sweep resurfaces CONTACTS only, and a contactless
   number is not one. That is the design decision, proven on real data rather
   than against a fake, and it is the single most reviewable line in this slice.

## What this slice did NOT touch

`app/src/**`, `dashboard/src/routes/inbox/inboxFilters.ts`,
`dashboard/src/routes/inbox/Inbox.tsx`, `dashboard/src/routes/inbox/useInbox.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/performanceSeed.integration.test.ts` (RUN, never edited), and
everything under `e2e/**` (including `e2e/performance/routes.ts`'s
`inboxTerminal`, the third independent enforcement of "never `truncated` on
unknown", which remains a later slice's business).

No server, no Vite, no `npm run e2e`, no `npm test`, no live port touched.
