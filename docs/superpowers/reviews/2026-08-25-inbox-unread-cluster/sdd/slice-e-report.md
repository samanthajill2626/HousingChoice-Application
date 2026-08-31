# Slice E (T8 + T9) - e2e proof and the in-repo record - implementer report

Two commits, in order, both on `feat/inbox-unread-cluster`:

| task | commit | subject |
| --- | --- | --- |
| T8 | **f9a5132d64ab1e9b04d9e936c735dc9d4f5cbc70** | `test(e2e): Unknown tab shows the captured caller and an honest empty state` |
| T9 | **8a27ecb339091b97398c67b2b00ccf017c107cdf** | `docs(issues): unknown-tab walk resolved by the contact-side read; section-5 safety net deferred with its gate named` |

Both carry `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, verified by
`git log -1 --format=%B`. Both staged explicit single paths. Bare `git status`
read before each commit: clean apart from the one intended file, no merge in
progress (no `MERGE_HEAD` line, `On branch feat/inbox-unread-cluster`). Tree is
clean after T9.

## Exit codes

- `cd W:\tmp\inbox-unread-cluster` then `npm run typecheck` (bare, not piped, not
  chained) -> **EXIT 0**. All five workspaces ran, including
  `@housingchoice/e2e typecheck` which is the one that covers the new spec.
- `cd W:\tmp\inbox-unread-cluster` then `npm run issues` (bare) -> **EXIT 0**.
  Output: `258 open, 143 closed, 401 total`, `10 high / 108 med / 140 low`, and
  ONE warning that is pre-existing and unrelated to this branch:
  `perf-selfqa-route-contract-drift.md: unknown severity "medium"`.
  `docs/issues/INDEX.md` is gitignored and was NOT staged (it does not even
  appear in `git status`).

**NO e2e suite, NO session, NO lane, NO server, NO container was started.** The
only commands run in this slice were `git`, `grep`/`sed` reads, `npm run
typecheck` and `npm run issues`.

## T8 - the e2e spec

`e2e/tests/dashboard-next/unknown-caller-triage.spec.ts`, +42 lines, one
appended `test(...)`. The plan's Step 1 snippet was used essentially verbatim.

**Every e2e helper matched the research file exactly.** Verified by reading the
whole 114-line file before editing, not by trusting the report:

| claimed | found | line |
| --- | --- | --- |
| `placeCall` from `../../fixtures/fakeVoice.js` | exact | 19 |
| `reseed` imported, used in `test.beforeEach` | exact | 20, 34-36 |
| `uniqueVoicePhone`, `NEXT` from `voiceSetup.js` | exact | 21 |
| local `async function devLogin(page: Page)` | exact | 27-32 |
| `const BUSINESS = '+15550009999';` | exact | 25 |
| the `a[href="/contacts/<id>"]` + `/needs triage/i` pair | exact, at 102-104 | - |
| `GET /api/contacts?type=unknown` returning `{ contacts: [...] }` | already polled by the shipping test at 50-63 | - |

Nothing drifted; there was nothing to stop and report on.

The poll idiom in the new test is copied from the shipping test's shape
(`expect.poll` with `{ timeout: 10_000 }`, `res.ok()` guard, destructured
`{ contacts }`), so the two sites stay consistent. Selectors are
accessibility-first where the plan uses them (`getByRole('tab', { name:
'Unknown' })`, `getByText('No unknown numbers')`, `getByRole('alert')`); the raw
`a[href=...]` locator is kept ONLY where identity by `contactId` is the point,
matching the in-file precedent.

**One deviation, additive and comment-only:** step (1)'s comment gained a
sentence naming WHY the empty state is meaningful rather than vacuous - the lean
seed holds exactly three contacts (tenant / landlord / partner) and zero
unknowns. That is the orchestrator's binding correction written into the test so
a future reader cannot mistake the assertion for a tautology. No assertion was
added, removed or changed.

ASCII: `LC_ALL=C grep '[^ -~\t]'` over the whole file -> no matches.

## T9 - the issue record

`docs/issues/inbox-filter-tabs-full-walk.md`, +117 / -11.

### The nested `CORRECTED 2026-08-25` sub-bullet - before and after

This was the trap, and it was handled by REWRITING the parent bullet in place
and KEEPING the sub-bullet nested underneath it, reconciled with what shipped.

**BEFORE (lines 153-163):**

```
- **UNKNOWN: STILL OPEN.** `filter=unknown` still walks `byLastActivity` and
  still needs the contact to decide `needsTriage`, so its walk is still
  O(open conversations) when matches are sparse. This issue tracks the unknown
  tab from here on.
  - **CORRECTED 2026-08-25.** This bullet originally read "STILL OPEN,
    unchanged" and repeated the "hydrates every open conversation" cost. Both
    were already wrong when written: `39c1aa41` had moved the role check ahead
    of hydration two days earlier, on 2026-08-14. The walk survives; the
    hydration does not. See the cost-model correction above. The bullet's
    closing claim - that "a triage flag or second sparse index remains the
    escalation" - is disproven above and must not be built.
```

**AFTER (lines 153-178):** the parent became
`- **UNKNOWN: RESOLVED 2026-08-25 by the contact-side read.** ...` (addition 1,
full text in the file), ending with "This issue still tracks the unknown tab:
what the branch deliberately did NOT close is in the RESOLVED block at the end
of this file." The sub-bullet stayed NESTED under it, with three changes:

```
  - **CORRECTED 2026-08-25, kept for the record.** This bullet ORIGINALLY read
    "STILL OPEN, unchanged" and repeated the "hydrates every open conversation"
    cost; the corrected STILL-OPEN wording that replaced it is in turn what the
    resolution above replaced. Both original claims were already wrong when
    written: `39c1aa41` had moved the role check ahead of hydration two days
    earlier, on 2026-08-14. The walk survived that correction; the hydration did
    not. See the cost-model correction above. The bullet's closing claim - that
    "a triage flag or second sparse index remains the escalation" - is disproven
    above and must not be built. That instruction still stands, and the shipped
    fix honours it: the contact-side read adds no triage flag and no second
    index, it reads a CONTACTS partition that already existed.
```

The three changes, and why:

1. Title gained ", kept for the record" - it is now a historical note under a
   RESOLVED parent, not a live correction to a live claim.
2. The history was made a TWO-STEP account. A one-step "this bullet read X"
   would have been false: the bullet's immediately-previous text was the
   CORRECTED STILL-OPEN wording, not the original "STILL OPEN, unchanged". Both
   revisions are now named in order.
3. The live "must not be built" instruction is PRESERVED VERBATIM and then
   reconciled: it still stands, and the shipped fix honours it, because the
   contact-side read adds no triage flag and no second index - it reads a
   CONTACTS partition that already existed. That is the reconciliation the
   orchestrator asked for; the instruction is neither dangling nor deleted.

Tense in the surviving prose was moved to past where the sentence describes a
state the flip ended ("The walk survived that correction"), since a
present-tense "the walk survives" under a RESOLVED parent would now read as a
claim that the walk is still there.

### Additions 2, 3, 4 - placement

Appended as ONE new dated block at the END of the file, after the
"Re-adjudicated 2026-08-25" paragraph, opened with `---` and headed
`**RESOLVED 2026-08-25 - the rulings, the remainder, and one deferral.**` This
matches the file's own idiom (`**MEASURED 2026-08-25 ...**`,
`**RE-MEASURED 2026-08-25 ...**`, `**Drift audit, same day ...**`) and is what
the parent bullet's forward reference points at.

- **Addition 2 (class (c) ruling)** complements rather than duplicates the
  file's existing latent-`team_member`-bug paragraph, which it references
  explicitly. Records that `UNKNOWN_TAB_TYPE_DECISIONS` DERIVES
  `UNKNOWN_QUEUE_TYPES`, so the ruling is enforced rather than decorative.
- **Addition 3 (the deliberate remainder)** keeps the TWO cuts as two separate
  bullets, with an explicit "Do not read the window cut's newest-first reasoning
  onto this one". The WINDOW cut is newest-first (assembled rows sort newest
  displayed activity first, so the cut is at the OLD end and triage drains
  toward the remainder); the COLLECTOR cap (`UNKNOWN_QUEUE_MAX_ROWS` 200) cuts
  in INDEX order with no recency guarantee, so past ~200 untriaged contacts the
  newest inbound can be among the hidden rows. Both are WARNed; neither has a
  Load-more (the branch mints no cursor). Class (e), measured zero, is named as
  All-tab-only. Then the SWEEP numbers (O(visible unread), one contact read per
  visible unread index item, `UNREAD_WALK_LIMIT` 2000 raw items per page load,
  crossover ~700 visible unread threads against the ~684-lookup walk removed,
  worst case ~3x, accepted because unread drains with triage while the open
  partition only grows; signals = the unconditional `sweepScanned` field and the
  shared 500-item tripwire `UNREAD_WALK_WARN`). Then the capped-sweep RESIDUAL,
  attributed to requirements 2 and 5 JOINTLY, with the exact reason the wire
  must not carry `truncated` (`serverEndedEarlyEmpty`, `Inbox.tsx:42`, banner at
  `:183`), the two log fields as the only signals, and a **Reopen this issue
  here** sentence naming the three trades that would trigger it.
- **Addition 4 (the deferral)** records section 5's open-partition safety net as
  DEFERRED, not dropped, by human ruling 2026-08-25; names its unsolved gate (a
  budget-stopped ZERO-ROW `filter=all` page carrying `truncated` lights the
  non-filter-gated banner on an org where nothing failed, and the spec says
  solve that FIRST); and lists BOTH review-found traps (the empty-page invariant
  nulls the cursor so Load-more cannot be the affordance in exactly that state;
  and replacing the pager loop's tail orphans the `moreChunks` binding, a gate-5
  `no-unused-vars` error unless deleted with it). Closes by distinguishing the
  scopes: the unbounded read this issue was filed for is gone from
  `filter=unknown`; the safety net is about `filter=all` and is still owed.

### The OPTIONAL `update(..., { status: null })` note - INCLUDED

Included as one clause at the end of addition 2's paragraph, which is where it
has a natural home (that paragraph is already about what does and does not land
in the `(type='unknown')` partition). Worded exactly as the sweep found it: a
legal, index-dropping write that no caller performs today, so "no caller nulls
status", NOT "impossible", and explicitly "not a shipping defect".

### Docs describe the CODE, not the plan

Every constant, log field and WARN string in the new prose was read out of the
shipped source before being written down, per slice C's report:

- `UNKNOWN_QUEUE_PAGE_SIZE` 100, `UNKNOWN_QUEUE_MAX_PAGES` 10,
  `UNKNOWN_QUEUE_MAX_ROWS` 200, `UNKNOWN_TAB_TYPE_DECISIONS` ->
  `UNKNOWN_QUEUE_TYPES` (`app/src/lib/unknownQueue.ts:41/48/56/75/84`).
- `sweepScanned` (unconditional), `resurfaceTruncated`, `resurfaceCapped`,
  `queueContacts`, `queuePages`, `threadReadFailures` on the
  `inbox feed assembled` line (`app/src/routes/inbox.ts:1751-1761`).
- The two WARN strings quoted are the real ones ("the unknown tab could not show
  every triage row - the queue is a floor" at `:1741`; "the unknown-tab
  resurfacing sweep stopped early - the deleted-row set is a floor" at `:1707`).
- The claim "the WARN copy carries the index-order caveat" was CHECKED against
  `unknownQueue.ts:173`, which does say "the cut is in index order, so the
  newest untriaged contact may be among the hidden rows".
- `UNREAD_WALK_LIMIT = 2000` and `UNREAD_WALK_WARN = 500`
  (`app/src/lib/unreadFeed.ts:46/49`).
- `moreChunks` is cited at its POST-FLIP lines - binding `inbox.ts:1799`, its
  only reader at `:1840` - and labelled "post-flip", NOT at the plan's pre-flip
  `:1481` / `:1522`. A stale self-citation is the exact failure this file's
  correction blocks exist to prevent.

ASCII: `LC_ALL=C grep '[^ -~\t]'` over the WHOLE file -> no matches. No smart
quotes, em dashes, arrows or non-breaking spaces were introduced; the file uses
`->` and `x` throughout, and so do the additions.

## `e2e/README.md` verdict: NO EDIT, and none was made

The check was performed (lines 180-207 read in full), and the file was NOT
staged.

Nothing there is made false by the flip:

- Line 193's profiled shape `GET /api/inbox?filter=unknown&limit=30` is
  unchanged - the branch takes the same `filter` + `limit` tuple.
- Line 194 already says "with no cursor accepted as profiler evidence", which
  the flip makes MORE true, not less.
- Lines 198-202's one-terminal-branch rule (populated Conversations list, that
  filter's exact empty copy, or error alert) is exactly what requirement 5
  preserves.
- Line 202's "never ... click Load more" describes what the sample does NOT do;
  it does not assert that a Load more exists on this tab, so the missing
  affordance does not falsify it.

## Deviations, in full

1. **T8, additive comment** (described above): step (1)'s comment names the
   three-contact lean seed so the empty-state assertion cannot be read as
   vacuous. Assertions unchanged.
2. **T9, sub-bullet tense and two-step history** (described above): required to
   keep the surviving prose true under a RESOLVED parent.
3. **T9, `moreChunks` line numbers re-derived** to post-flip `:1799` / `:1840`
   instead of copying the plan's `:1481` / `:1522`.
4. **Frontmatter NOT touched.** `status: open`, `severity: high` and
   `updated: 2026-08-25` are unchanged. The plan specifies exactly four
   additions and none of them is a frontmatter change; the issue also still
   carries a live remainder and a live deferral with a "Reopen this issue here"
   trigger, so flipping it to `resolved` would be wrong today, and the branch is
   not merged. Flagging for the orchestrator in case the mission wants
   `updated:` bumped to 2026-08-26 or the status moved at merge time - I did not
   invent either.

## Surprises

1. **None in the e2e surface.** This is worth stating plainly because the slice
   was scoped with a stop-and-report rule for it: every import, helper, route
   and selector matched the research file byte-for-byte, so no workaround and no
   lane was needed.
2. **The nested sub-bullet had a second, subtler trap than the one named.** The
   briefed trap was orphaning it. The one I hit while writing was TENSE and
   HISTORY: the sub-bullet's own narrative ("this bullet originally read X") is
   about a text that has now been superseded TWICE, and its "The walk survives"
   is present-tense about a walk the flip removed. Keeping the sub-bullet
   nested but unedited would have left both defects; keeping it verbatim was not
   an option. The "must not be built" sentence itself is preserved word for
   word.
3. **The collector's cap WARN already carries the index-order caveat**, so
   addition 3's claim that it does is a statement about shipped code rather than
   an aspiration. Good outcome, but it was checked, not assumed - the plan's
   phrasing ("with the index-order caveat in the copy") reads like an
   instruction to a future author, not a report on the present.
4. **`npm run issues` emits a pre-existing warning** on an unrelated file
   (`perf-selfqa-route-contract-drift.md: unknown severity "medium"` - the
   schema wants `med`). Exit code is still 0. NOT this branch's file and NOT
   touched; noting it so the gates task does not read it as new.

## Nothing found contradicting the spec

No shipped behaviour was found that contradicts
`docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`. The spec
was NOT edited (it is human-gated) and was not staged.

## What this slice did NOT touch

`app/src/**`, `app/test/**`, `dashboard/**`, `e2e/README.md`, any other e2e
spec, `RUNBOOK.md`, `docs/issues/INDEX.md` (gitignored, regenerated only), and
the gated spec. Two files changed in total across two commits.
