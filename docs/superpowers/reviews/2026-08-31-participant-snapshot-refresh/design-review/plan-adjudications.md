# Plan review - round 1 adjudications

Plan: `docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md` @5f6bccaa
Reviewers: A and B, fresh (no prior context), both `opus`, both given plan +
spec + repo. Findings at `../plan-review-A-findings.md` (22) and
`../plan-review-B-findings.md` (20). 30 distinct after merging.

**28 ACCEPT, 0 REJECT, 2 spec amendments.** Every blocking finding was
verified by the planner against the tree before acceptance.

## What the plan got wrong, in one sentence

I wrote test code against helper names I had not opened. Both reviewers
independently found the same three: the inbox suite has no HTTP layer
(`aggregateInbox` + `groupConv`, not `get()`/`res.body`), the e2e flow never
creates a tour before opening its group, and the relay header has no heading
element. A builder executing literally would have stopped at Task 3.

## Blocking - accepted, all verified

| # | finding | fix in plan v2 |
|---|---|---|
| A1/B2 | Task 3 tests use `get()`, `groupText()`, `relayGroup()`, `res.body.rows` - none exist; the suite drives `aggregateInbox()` directly with `groupConv()` (`inboxGroups.test.ts:132`, `:195`) | rewritten against `aggregateInbox` / `page.rows` / `groupConv` / inline relay literal |
| A2 | Task 9 calls `teamOpensTourGroup` with no tour; `requireActiveTour` throws (`steps.ts:3725`) | `teamCreatesTourFromInterest(unit, 'Landlord-led')` inserted; default (naked) variant |
| A3/B4 | Task 9's `getByRole('heading')` cannot match - names render in `div.facts` (`ConversationDetail.tsx:406`) | assert `getByText(/^With .*<name>/)`; note it exercises Task 5's `/members` route |
| A4/B3 | Task 2 close-nag fixture sets `relay_status: 'open'`; the fake filters on `relay_group#open` (`harness:777-779`) | `relay_status: 'relay_group#open'` |
| A5 | Task 5 uses `POOL`/`CAROL` which do not exist at module scope in `relayApi.test.ts` | local constants |
| A6/B5/B9 | Task 5 certainly breaks `relayApi.test.ts:427` and `:450`, one titled "not a stale name" - the ruling this branch reverses - and the plan hedged it as a maybe; the `:450` rewrite must inject the throw into `getDisplaysByIds`, since `getById` is no longer called | both tests rewritten IN the plan with new titles; commit body must name the reversal |
| B1 | `contactDisplayName`'s widened `{ firstName?: unknown; lastName?: unknown }` is a WEAK TYPE - every existing `ContactItem` caller fails TS2559; `units.ts:113-122` documents the `contactId` anchor for exactly this | signature gains `contactId: string` |
| B20 | The worktree has no `node_modules`; Task 1 Step 2 has nothing to run | Task 0: `npm install` |

## High - accepted

| # | finding | fix |
|---|---|---|
| A7/B11 | Spec S3 requires amending `rosterEdits.ts:439-441`/`:455` comments; the plan's do-not-edit line forbids the file | Global Constraints carve out COMMENT-ONLY edits to those two docblocks; Task 6 carries them |
| A8/B7 | Task 4's batch sits inside the three-status loop: 3 batches per relay card | hoist: read all three partitions, filter once, batch once |
| B6 | Task 3's `:1418` edit batches per unread candidate | ACCEPTED AS A COST, not restructured: that loop already point-reads each candidate one at a time by design; adding one batch beside each is the same order, bounded by the page limit. Spec row amended to say so rather than claim "one per page" there |
| B8 | `filter=all` pays two batches (`:2293` relay, `:2358` group) | ACCEPTED AS A COST: the two reads sit ~50 lines apart with the 1:1 pager between them; merging means moving a partition read. Two batches on one filter, stated in the spec row |
| A13 | Task 7's mask also changes the SPOKEN whisper (`voice.ts:1044` `callerLabel` -> `/whisper` `gather.say` `:1307`) | one function, one rule; the whisper URL label is PINNED in the test and spec S4 says the whisper moves too. The label is a name rendered, not message content |

## Medium and low - accepted

A9 (`:785` is `auditTabVsPartition`, a different mode - spec table error, spec
row corrected to `:510` only). A10 (tally skips soft-deleted contacts, own
counter). A11 (audit prints requested-vs-returned id delta). A12 (sourcing
extracted to `collectGroupRosters(repo)` and tested with fakes). A14/B13
(unique-id set asserted in Tasks 3, 4, 5). A15 (spec's merge-base run DROPPED
- see amendments). A16/B10 (green-by-construction tests labelled as pins, not
reds). A17 (`ownerId` note was the wrong loop; local `const`). A18/B16 (delete
the `ContactItem` import, stated). A19 (Task 1 red needs typecheck in the
command). A20/B19 (`activeTourGroupId()` accessor in Step 1). A21 (unlinked
-> phone test added). A22/B12 (group-push test named:
`inboundMessagePush.test.ts:495-524`, written out). B14 (sibling fakes get an
explicit `getDisplaysByIds`; named files). B15 (line slips: `:556-564` not
`:565`; `const groups` not re-declared; `today.ts:1073`). B17 (docblock says
"consumers include"). B18 (new `describe` block, named).

## Spec amendments (two)

1. **S5's "run at the merge base and at handback"** - DROPPED. This branch
   changes no stored data, so the audit's numbers are identical before and
   after; the run SIZES the stale population the read path now masks, once.
   A before/after was a leftover from the refresh-on-write design.
2. **Read-cost rows** - the inbox `filter=all` page costs TWO batches (relay +
   group partitions), and the `unread` filter costs one batch per multi-party
   row beside its existing per-row point read. Stated, not hidden.

Plus S4 names the whisper, and S5's second citation is removed.

## Convergence

No finding faulted the DESIGN or the spec's decisions. Every accepted item is
plan-text: wrong helper names, wrong fixture values, an unsound type, missed
cost accounting, and a scope line that contradicted its own spec. One round
with two fresh reviewers; the fixes are mechanical and verified. Terminal.
