# Spec-conformance review - `feat/inbox-unread-cluster` (Unknown tab contact-side read)

Reviewer: spec-conformance (read-only). Nothing in the worktree was modified.
Evidence: the live tree, the branch diff against `main`, the gate logs in
`.superpowers/sdd/`, and one targeted vitest run (four new suites, 34 tests,
all green - no `npm test`, no e2e, no server started).

Targeted run performed:
`cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/contactsPartitionFake.test.ts`
-> 4 files passed, 34 tests passed.

---

## 1. Work map (10 tasks)

| # | Task | Verdict | Citation |
| --- | --- | --- | --- |
| T1 | DynamoDB-faithful `listByType` test fake | CONFORMS | `app/test/helpers/contactsPartitionFake.ts:49-86`; suite `app/test/contactsPartitionFake.test.ts` (7 tests, green). Sparse-index rule `:58`, key-condition `status` `:60`, Limit-before-filter `:66-69`, LEK-on-limit-reached `:74`. Orchestrator adjudication C1 applied: the LEK carries the full GSI key `{type,status,contactId}` (`:79-83`) with the reason stated at `:20-27`. |
| T2 | Two aggregator fakes learn `listByType` (inert) | CONFORMS | `app/test/inboxFeed.test.ts:216-221` (+ counters `:70-71`, `:81-82`, `listByLastActivity` counted `:144`); `app/test/inboxGroups.test.ts:110-116`. Landed inert in commit `e3d94947`, before the flip. |
| T3 | Parity baseline committed GREEN pre-flip | CONFORMS | `app/test/inboxUnknownParity.test.ts` created in `c92767f3`; `git log main..HEAD -- app/src/routes/inbox.ts` returns ONLY `66989d6f`, so the baseline predates any change to the aggregator. 7 class-by-class pins. |
| T4 | `app/src/lib/unknownQueue.ts` collector | CONFORMS | Page size `:41`, page budget `:48`, result cap `:56`, fill loop `:142-157` (break on rows KEPT `:156`), result slice `:165`, truncation WARN `:167-175`. Suite `app/test/unknownQueue.test.ts` (8 tests, green). |
| T5 | The flip: `filter=unknown` branch + resurfacing sweep | CONFORMS | Branch `app/src/routes/inbox.ts:1519-1772`; cursor gate narrowed to `all` `:598-599`; test seams `app/src/routes/inbox.ts:195-212`. Comment retirement: all EIGHT sites the worklist named are done (see section 6, note A for one deliberate, in-code-flagged deviation). |
| T6 | Integration repin (real DynamoDB) + perf-seed verification | CONFORMS | `app/test/inbox.integration.test.ts:323-335` (class e repin) and `:436-465` (real-index queue test, added last, with the shared-world caveat comment `:436-438`). Perf seed run UNCHANGED and green in isolation: `.superpowers/sdd/gate2-isolation.log` (`Test Files 2 passed`, `test/performanceSeed.integration.test.ts` present). |
| T7 | Dashboard: empty Unknown tab is an empty state | CONFORMS | `dashboard/src/routes/inbox/Inbox.test.tsx:390-408` - both pins (honest empty copy with no `alert`; the `truncated` dependency test that documents why the server must never set the flag). |
| T8 | E2E: extend `unknown-caller-triage.spec.ts` | CONFORMS | `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:115-155`. Executed in gate 4: `.superpowers/sdd/gate4-e2e.log` line 27168, `ok 162 ... unknown-caller-triage.spec.ts:115:1`. |
| T9 | Docs: close the item, record ruling / remainder / deferral | CONFORMS | `docs/issues/inbox-filter-tabs-full-walk.md` - UNKNOWN bullet flipped to RESOLVED (diff hunk at `@@ -150,27 +150,49`); class (c) ruling, the TWO-cut remainder, the sweep ceiling/crossover, the capped-sweep residual, and the section-5 DEFERRAL with its unsolved gate and two traps, all in the RESOLVED block appended at the end of the file. |
| T10 | Gates | CONFORMS (with notes) | gate1 typecheck clean (`gate1-typecheck.log`); gate3 smoke `smoke-dist: OK - 1343 import specifier(s)`; gate4 `255 passed (23.9m)`; gate5 one error, verified PRE-EXISTING (see note C). gate2 see note D. Local-main sync present as merge commit `c3a45d32`. |

---

## 2. Spec section 4 - the five numbered requirements

| # | Requirement | Verdict | Citation |
| --- | --- | --- | --- |
| 1 | Query `type=unknown`, NO status narrowing, do NOT copy `excludeOrigin`; take the fill loop, result cap and truncation WARN; NAME page size and cap; live TYPE check replaces the status re-check | CONFORMS | Query issues only `limit` + `exclusiveStartKey` - no `status`, no `excludeOrigin`, no `deleted` (`app/src/lib/unknownQueue.ts:144-147`). Named constants `:41` (100), `:48` (10), `:56` (200), pinned by `app/test/unknownQueue.test.ts:139-143`. Live type check `app/src/routes/inbox.ts:1592-1595` (`roleFromContact(contact) !== 'unknown'` -> `unknownQueueRetyped`), pinned `app/test/inboxUnknownTab.test.ts:464-480`. Non-copy probes `app/test/unknownQueue.test.ts:64-66` (non-vacuous - see hard check 2). |
| 2 | Read the WHOLE capped queue, sort in memory, do not page in activity order, WARN when the cap truncates | CONFORMS | Collector returns the whole capped queue; the branch sorts in memory `app/src/routes/inbox.ts:1728-1730`, windows to `limit` `:1739`, WARNs on the window cut `:1740-1745` and the collector WARNs on its own cut `app/src/lib/unknownQueue.ts:171-174`. `nextCursor: null` `:1771`. The two cuts are explicitly distinguished (window = newest-first, collector = index order) at `:1717-1727` and pinned by `app/test/inboxUnknownTab.test.ts:182-223` and `:225-248`. |
| 3 | Resurfacing via `byUnread`, not a second `deleted:true` walk; reuse the unread branch's budget and `truncated` contract; do not invent a second bound | CONFORMS | One `collectUnreadRows` sweep `app/src/routes/inbox.ts:1645-1649` with `maxRows` PINNED to the budget (`{ maxRows: sweepBudget, budget: sweepBudget }`), default `UNREAD_WALK_LIMIT` `:1645`. No `deleted:true` query exists anywhere on the branch (`listByType` is called only from `unknownQueue.ts:144`). Probe tripwire reused `:1650-1654`, scan tripwire `:1661`. The extra `unknownSweepBudget` name is a TEST SEAM only, defaulting to the same production bound, with its reason at `:206-211`. |
| 4 | Discriminate a FAILED thread read from an EMPTY one; not via `contactConversations` | CONFORMS | `resolveOpenThreads` calls `conversationsForContact` DIRECTLY with a local try/catch (`app/src/routes/inbox.ts:1563-1578`): `undefined` = threw (own WARN + `unknownThreadReadFailed`), `[]` = genuinely empty (`unknownNoOpenThread` at `:1602-1605`). Neither swallows nor throws outward. Pinned `app/test/inboxUnknownTab.test.ts:261-289`, which asserts BOTH drop counters on the same page - a build routed through the best-effort seam collapses them and goes red. The partition read itself stays LOUD (`app/src/lib/unknownQueue.ts:112-120`), pinned `app/test/inboxUnknownTab.test.ts:372-388`. |
| 5 | The empty state must not look like a failure | CONFORMS | The branch returns `{ rows, nextCursor: null }` and never the wire `truncated` (`app/src/routes/inbox.ts:1766-1771`); pinned server-side `app/test/inboxUnknownTab.test.ts:216-217`, client-side `dashboard/src/routes/inbox/Inbox.test.tsx:391-408`, and end-to-end `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:126-129`. |

---

## 3. Spec section 3 - the seven coverage classes

| Class | Decision in the spec | Verdict | Citation |
| --- | --- | --- | --- |
| (a) group-detection stubs; `excludeOrigin` must NOT be copied | Do not copy | CONFORMS | No `excludeOrigin` in the query (`app/src/lib/unknownQueue.ts:144-147`), reason recorded `:30-36`. Row-level pin: `app/test/inboxUnknownParity.test.ts` class-a test (a `origin: 'group_detection'` stub that texted IS a row, must survive the flip - unchanged across the flip diff). Collector-level pin `app/test/unknownQueue.test.ts:49,53,65`. |
| (b) relay-group-or-closed-only threads | Handled by the existing seam | CONFORMS | `app/src/routes/inbox.ts:1568` filters `status === 'open' && c.type !== 'relay_group'`; no new work. Pinned `app/test/inboxUnknownTab.test.ts:291-300`. |
| (c) `team_member` ruled out; today's tab carrying them was the bug | Excluded by construction | CONFORMS | `UNKNOWN_TAB_TYPE_DECISIONS` marks `team_member: 'excluded'` (`app/src/lib/unknownQueue.ts:79`); the sweep's side door is closed by type membership, NOT `roleFromContact` (`app/src/routes/inbox.ts:1671`). Pins: parity class-c (flipped to `[]`), and the deleted-`team_member` side-door probe `app/test/inboxUnknownTab.test.ts:307-311,324-326`. Recorded in the issue registry, not only the design doc. |
| (d) soft-deleted under the resurfacing rule | Handled explicitly | CONFORMS | Sweep loop `app/src/routes/inbox.ts:1662-1700` (deleted-only `:1675`, unread-still-live `:1689`, `resurfaceNoOpenThread` counted `:1683`). Pinned `app/test/inboxUnknownParity.test.ts` class-d (unchanged across the flip) and `app/test/inboxUnknownTab.test.ts:302-327`. |
| (e) contactless conversations | Accepted as lost, mitigated by the All tab | CONFORMS | Four pins, each asserting BOTH halves (leaves unknown, stays on all): `app/test/inboxUnknownParity.test.ts` class-e; `app/test/inboxFeed.test.ts:631-639`; `app/test/inboxApi.test.ts:214-231`; `app/test/inbox.integration.test.ts:323-335`. Behaviour also documented at the source of the equivalence, `app/src/routes/inbox.ts:842-855`. |
| (f) `type=unknown` with a status other than `needs_review` | Must be returned | CONFORMS | No `status` in the query (`app/src/lib/unknownQueue.ts:144-147`); an `active` unknown is kept (`app/test/unknownQueue.test.ts:48,53`) and rendered (`app/test/inboxUnknownParity.test.ts` class-f pin, unchanged across the flip; also `app/test/inboxUnknownTab.test.ts:229`). |
| (g) the RULE - a NEW `ContactType` must fail loudly | Compile-time + enforced | CONFORMS | `as const satisfies Record<ContactType, ...>` (`app/src/lib/unknownQueue.ts:81`) makes a new member a TYPECHECK failure; `UNKNOWN_QUEUE_TYPES` is DERIVED from the map (`:84-88`) and is what the collector queries (`:144`) and what the sweep admits (`app/src/routes/inbox.ts:1671`), so the decision cannot be decorative. Pinned `app/test/unknownQueue.test.ts:145-157` plus the "queried partitions == UNKNOWN_QUEUE_TYPES" assertion `:60`. |

---

## 4. Spec section 6 - the six testing demands

| Demand | Verdict | Citation |
| --- | --- | --- |
| The regression test STARVES the filter (many open conversations, few matches) | CONFORMS | `app/test/inboxUnknownTab.test.ts:148-180`: 40 open tenant threads + 1 unknown; asserts `listByType 1`, `listByLastActivity 0`, `findByPhone 0`. Second starved pin at `app/test/inboxFeed.test.ts:764-806` (whole-object `toEqual` on the counters). |
| Reads asserted, never wall-clock | CONFORMS | Every cost pin is a call counter (`app/test/inboxUnknownTab.test.ts:174-179`, `:422-434`; `app/test/unknownQueue.test.ts:55,92,102`). No timing assertion exists in any of the new suites. |
| Every coverage class pinned | CONFORMS | a/c/d/e/f in `inboxUnknownParity.test.ts`; b/c/d in `inboxUnknownTab.test.ts:291,302`; f in `unknownQueue.test.ts:48`; g in `unknownQueue.test.ts:145`. |
| The LOUD failure posture pinned | CONFORMS | Two distinct pins: a thrown THREAD read withholds one row loudly (`app/test/inboxUnknownTab.test.ts:261-289`), a thrown PARTITION query propagates (`:372-388`). |
| A PARITY BASELINE taken before switching sources | CONFORMS | `app/test/inboxUnknownParity.test.ts` committed at `c92767f3`; `inbox.ts` first touched at `66989d6f`. |
| Mutation probes that can actually go red | CONFORMS | See hard checks 1 and 2 - both verified against the fixtures and the fake, not the test names. |

---

## 5. The four hard checks

### 5.1 `capped` MASKS `truncated` - does the branch read BOTH?

YES. `app/src/routes/inbox.ts:1701`:

```
    if (collected.truncated || collected.capped) {
```

with the reason at `:1702-1706`. The masking is real: `app/src/lib/unreadFeed.ts:709`
computes `truncated: !capped && !state.scanExhausted`, so `truncated` is FALSE
in every capped case, unconditionally.

Does a test prove it, and would it fail if `|| capped` were dropped? YES, and I
verified this from the fixture rather than the name.
`app/test/inboxUnknownTab.test.ts:329-370`:

- The fixture seeds THREE unread threads and sets `unknownSweepBudget: 2`
  (`:358`). The sweep pins `maxRows` to the budget (`inbox.ts:1648`), so the two
  visible tenant candidates fill `maxRows` and `collectUnreadRows` breaks at
  `unreadFeed.ts:673-677` with `capped = true`; `scanExhausted` is false but
  irrelevant, because `truncated = !capped && ...` is then FALSE by definition.
- The test asserts `page.rows` is `[]` (`:361`) - the deleted unknown really is
  past the cap - and that `assembled.resurfaceCapped === true` (`:369`), which is
  only emitted from `collected.capped` (`inbox.ts:1761`). That assertion PROVES
  the capped branch of the disjunction is the live one in this fixture.
- The decisive pin is `:364-367`: it locates the WARN by its message and then
  asserts `floorWarn?.[0]` matches `{ capped: true }`. With `|| capped` removed
  the `if` never fires, `floorWarn` is `undefined`, and `expect(undefined).toMatchObject(...)`
  throws. The probe is NON-VACUOUS.

### 5.2 Are the two "do not copy" probes non-vacuous?

YES. `app/test/helpers/contactsPartitionFake.ts` honours both options:

- `status` as a KEY condition on the partition: `:60`
  `.filter((c) => (opts.status === undefined ? true : c.status === opts.status))`
- `excludeOrigin` as a page-level FilterExpression: `:69`
  `.filter((c) => opts.excludeOrigin === undefined || c.origin !== opts.excludeOrigin)`

Both are independently pinned by the fake's own suite
(`app/test/contactsPartitionFake.test.ts`, the "status narrows the PARTITION" and
"excludeOrigin filters the PAGE" cases - both green in my run).

Consequently the probes in `app/test/unknownQueue.test.ts:45-68` bite twice over:
the seed carries `unk(2, { status: 'active' })` and `unk(3, { origin: 'group_detection' })`
(`:48-49`), so re-adding either narrow changes the ROW SET pinned at `:53` as
well as flipping the direct option assertions at `:64-65`. The class (a) and
class (f) parity pins add a third, route-level red.

### 5.3 Does the unknown branch ever set the wire `truncated`?

NO. The branch's single return is `app/src/routes/inbox.ts:1771`:

```
    return { rows: windowed, nextCursor: null };
```

preceded by the reason at `:1766-1770`. There is no other `return` inside
`if (filter === 'unknown') { ... }` (`:1528-1772`) apart from the
`InboxBadRequestError` throw at `:1534`. Truncation on this branch is expressed
only as WARNs (`:1707-1714`, `:1741-1744`, and the collector's at
`unknownQueue.ts:171`) and as log fields on the assembled line (`:1753`,
`:1760-1761`). Pinned by `app/test/inboxUnknownTab.test.ts:216-217`
(`'truncated' in page` is `false`, and `'groupsTruncated' in page` too) in a test
whose queue was ACTUALLY cap-cut, i.e. the exact state a naive build would flag.

### 5.4 The parity file - exactly TWO pins changed?

CONFIRMED, exactly two. `git diff c92767f3 HEAD -- app/test/inboxUnknownParity.test.ts`
returns a single hunk containing two edits:

- class (e): title reworded, and `expect(unknown.rows.map(r => r.phone)).toEqual(['+14049824978'])`
  -> `expect(unknown.rows).toEqual([])`. The mitigation assertion on the `all`
  tab is UNCHANGED and still runs.
- class (c): title reworded, and `expect(page.rows.map(r => r.contactId)).toEqual(['c-team'])`
  -> `expect(page.rows).toEqual([])`.

No other pin was weakened, renamed, deleted, skipped or `.only`-d: the core
`type=unknown` row pin, class (f), class (a), class (d) and the
tenant/landlord/partner exclusion are byte-identical to the baseline commit, and
the file still runs 7 tests (verified green in my run). Both changed pins are
strictly the spec's two ruled behaviour changes; neither loosened a surviving
assertion (both went from a specific row list to an exact-empty `toEqual([])`,
which is a STRONGER shape than `toHaveLength(0)`).

---

## 6. MISSING / PARTIAL, and other findings

No work-map item is MISSING. No requirement, coverage class or testing demand is
PARTIAL. Every deliverable named in the plan exists in the tree and is exercised
by a test that is currently green.

The following are notes, not verdicts. None of them changes a verdict above.

**A. One plan instruction the build could NOT honour - and it DID flag it.**
Plan T5 step 6 item 4 told the builder to KEEP the group-source gate
`filter !== 'unknown'` as belt-and-braces and merely re-word its comment. The
build REMOVED the term (`app/src/routes/inbox.ts:1934`, now a bare
`if (startKey === undefined) {`) and states why in the replacement comment at
`:1923-1933`: with `groups`, `unread` and now `unknown` all returning from their
own branches, `filter` is narrowed to the literal `'all'` at that line and `tsc`
rejects the comparison (TS2367, no overlap). The comment also tells a future
filter's author to decide its group posture at that site. This is the correct
handling of an instruction the type system made impossible, and it is flagged in
the place the next reader will look. Recording it here only because it is a
visible deviation from the written plan.

**B. A stale factual wording in two NEW comment lines.** `app/src/routes/inbox.ts:1620`
and the plan's facts block describe `listByType`'s `deleted` option as a
"TRI-STATE". Read against `app/src/repos/contactsRepo.ts:477-482`, the option is
BINARY (`omitted/false` -> exclude deleted; `true` -> only deleted), and the
FilterExpression is always present. The orchestrator already adjudicated this
(worklist C2): the operative claim - "all unknown contacts, deleted included, is
not expressible in one Query" - is TRUE either way, the spec is gated and must
not be edited, and nothing in the design or the code moves. Inert; noted so it
is not rediscovered as a defect.

**C. Gate 5 reports one error, and it is PRE-EXISTING.** `.superpowers/sdd/gate5-lint.log`:
`app/test/inbox.integration.test.ts:200:7 error 'convBId' is assigned a value but
never used`. I attributed it by comparing revisions rather than by line number:
`convBId` is declared at `:200` and assigned at `:243` in BOTH `main` and `HEAD`
(`git show main:app/test/inbox.integration.test.ts | grep -n convBId` returns the
identical two lines), and the branch's only edits to that file are the class-e
repin at `:323` and the appended test at `:436`. Not this branch's error;
blocking nothing, but it must be NAMED in the handback so the next person does
not re-diagnose it.

**D. Gate 2 has never produced a single all-green run, though nothing points at
this branch.** The full run (`gate2-test.log`) ends `2 failed | 338 passed | 1
skipped`: `test/otel.test.ts` (a child-process boot case) and
`test/performanceSeed.integration.test.ts:378` (a TIMEOUT, `onTimeoutError`, on
the group-fixture test - NOT the `unknown.rows.length > 0` assertion at `:414`
that this branch put at risk). The clean-access-key re-run
(`gate2-cleankey.log`) ends `1 failed | 339 passed`, failing a DIFFERENT file
(`test/logCallSiteGuard.test.ts`) - the classic environmental signature. Both
isolation re-runs are green (`gate2-isolation.log`: 2 files passed, including
`performanceSeed.integration.test.ts`; `gate2-isolation2.log`:
`logCallSiteGuard.test.ts` passed in 179s), and the last is filed as an issue on
this branch (`41cd101c`, `docs/issues/...-callsiteguard-hook-budget-equals-its-own-cost.md`).
For MY charge this matters in one place only, and it lands clean: T6 step 5's
perf-seed requirement is satisfied - the suite is unedited and green in
isolation, and its failure in the full run was a timeout on an unrelated test.

**E. Known dead code, disclosed in-code, not a finding.** The collector's
multi-partition loop and its cap-with-types-remaining guard
(`app/src/lib/unknownQueue.ts:138-163`) are unexercised with exactly one
`queried` type today; `:127-134` says so and tells a future author what to add.
Deliberate.

**F. Process artifact, outside the spec.** `.superpowers/sdd/progress.md` is
stale: every one of the ten tasks still reads `pending` with no commit hash, and
its final line says `STATUS: WAITING gate4`. The work itself is complete and
committed (T1-T10 map cleanly onto commits `17579b57` through `8a27ecb3`, plus
the main merge `c3a45d32` and the issue file `41cd101c`), and no handback
document exists yet in `.superpowers/`. Ledger hygiene only; it has no bearing on
conformance.
