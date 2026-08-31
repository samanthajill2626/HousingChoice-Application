# Fix wave 2 - round-2 corrective implementation report

Branch: `feat/inbox-unread-cluster`. Worktree: `W:\tmp\inbox-unread-cluster`.
Base of this wave: `a544fa1a`.

Commit: `1d3ba6ca` - "fix(inbox): correct the fix wave's own false claims and
guard the partition loop" (10 files changed, 391 insertions, 42 deletions).
Working tree clean after the commit.

Scope document: the "# Round 2 - adjudicating the re-review" section of
`.superpowers/review/adjudications.md`. Evidence base:
`.superpowers/review/review-adversarial-round2.md`.

**Exactly one item moved production behaviour: N5, one line plus a regression
test.** Everything else is comments, WARN copy, log fields, an output-line
suppression, and the issue registry. Nothing else in the wave changes what the
service does.

---

## Per item

### N1 - the corrected MED-4 comment asserted a false justification

`app/src/routes/inbox.ts`, the `filter=unknown` header block (the old
"That ordering is REQUIRED ... the sort key is the hydrated activity" sentence).

VERIFIED FIRST, in `buildContactRow` (`app/src/routes/inbox.ts:782-876`): the
row's sort key is `lastActivityAt: maxConv.last_activity_at` (`:872`) - a
CONVERSATION field, and `maxConv` is chosen by `newestOf(open)` over what
`resolveOpenThreads` returned. `latestMessageOf` (`:796`, yielding
channel/direction/preview/createdAt) and `placementLabel` (`:840`) feed only
presentation fields. Neither is a sort input. The reviewer's claim is correct.

Replaced the false sentence with three paragraphs:

1. only the THREAD resolution must precede the sort; the presentation hydration
   need not, and on the `deleted=false` path could move after
   `slice(0, limit)`;
2. the saving is a KNOWING DEFERRAL - named in the comment, with its size (up to
   200 message reads and up to 200 placement reads to render 30, roughly 340
   discarded serial round trips at the cap), why it was not taken here (a
   performance change with its own test surface; this branch's fix waves are
   chartered not to move behaviour), and a pointer to the issue;
3. the SWEEP path is genuinely different and must not be "optimised" the same
   way - there `latestMessageOf` is a VISIBILITY predicate deciding whether the
   resurfaced row exists at all, and that path is not cap-bound.

**The saving was NOT taken.** No hydration call moved.

Recorded in `docs/issues/inbox-filter-tabs-full-walk.md` as a new
"DEFERRED, not dropped (2026-08-26, round-2 finding N1)" block immediately
before the existing section-5 deferral, carrying the same three points plus the
correction of what the code used to claim.

### N2 - the truncation WARN asserted a composition it cannot know

`app/src/lib/unknownQueue.ts`, the truncation WARN in
`collectUnknownTriageQueue`.

Two changes, as ruled, plus one adjacent honesty fix in the same string:

- **Mechanism, not outcome.** The message no longer says "the hidden rows are
  the ones nobody has reviewed yet". It now states the ordering, which is true
  in every composition, with the direction the right way round - ASCENDING means
  `active` is KEPT and `needs_review` is CUT:

  `'inbox: the unknown-queue walk ended with rows still behind it - the cut is status-ascending, so active rows are kept and needs_review rows are cut FIRST; the needsReview counts say which block the cut landed in'`

- **Composition in the FIELDS.** `{ pages, kept, collected }` gained
  `keptNeedsReview` and `collectedNeedsReview`, computed by a local
  `needsReview()` reducer over `contacts` and `collected`. A reader can now see
  which block the cut landed in: `keptNeedsReview 0 / collectedNeedsReview 0` is
  an all-`active` partition; `keptNeedsReview 0 / collectedNeedsReview > 0` is
  the starvation shape.

- **ADJACENT FIX, flagged rather than smuggled:** the message's LEAD phrase also
  read "ended with untriaged contacts still behind it", which is the same class
  of false claim (on an all-`active` partition the rows behind it are not
  untriaged). Changed to "ended with rows still behind it". This moved one
  existing pin - see below - and one quotation in the issue file
  (`docs/issues/inbox-filter-tabs-full-walk.md`, the collector-truncation
  residual block).

The comment above the WARN now records why the copy is written this way, with
the false version quoted so it is not reintroduced.

Tests updated:

- `app/test/unknownQueue.test.ts`, "the page budget bounds a partition made
  entirely of residue": the field assertion now also pins `collected: 0`,
  `keptNeedsReview: 0`, `collectedNeedsReview: 0`.
- `app/test/unknownQueue.test.ts`, "THE CAP STARVES needs_review": now captures
  the logger and asserts `kept: 2, collected: 4, keptNeedsReview: 0,
  collectedNeedsReview: 2` - the starvation is READABLE off the fields, which is
  the point of moving it there - plus a negative assertion that the copy does
  NOT contain "nobody has reviewed".
- `app/test/inboxUnknownTab.test.ts`, the cap-cut test: the WARN substring match
  moved from `'untriaged contacts still behind it'` to
  `'needs_review rows are cut FIRST'`. **This pin moved for exactly one reason -
  the copy it matches was rewritten by this item.** It still asserts the same
  thing (the collector's truncation WARN fired and carries the ordering caveat).

### N3 - the class-(f) justification cited an API-only path

`app/src/lib/unknownQueue.ts`, the module header's
"NOT COPIED - `status: 'needs_review'`" block.

VERIFIED FIRST, in `dashboard/src/routes/contact/KindPicker.tsx`: the primary
segment bar is `['tenant','landlord','partner','pm','other']` (`:23`, `:128`),
`pm` resolves to `{type:'landlord', role:PM_ROLE}`, and `other` reveals a base
sub-choice restricted to `BASE_OPTIONS` = tenant | landlord (`:28-39`). There is
no `unknown` segment and no path to one, so no operator can create a contact
into this partition or re-type one back into it. Confirmed.

The justification now points at the **status-only triage PATCH** documented in
the block immediately below it as the mechanism that manufactures
`(unknown, active)`, and marks the `POST /api/contacts` default as API-ONLY,
naming KindPicker as the reason. It also records that every production writer
that mints an `unknown` sets `needs_review`, which is why both environments
measure zero today.

**The class-(f) DECISION is explicitly NOT reopened** - the new text says so in
those words. Only its stated reason changed.

### N4 - `audienceResolution.ts`: filed, marked, cross-referenced; NOT fixed

Verified the mechanism directly: `TENANT_STATUSES`
(`app/src/lib/statusModel.ts:140-148`) sorted ascending is
`inactive, needs_review, on_hold, onboarding, placed, placing, searching`, so
`searching` sorts LAST and is cut first; the walk at
`app/src/services/audienceResolution.ts:129-136` is bounded by
`DEFAULT_MAX_PAGES` 50 x `DEFAULT_PAGE_SIZE` 200 (`:78-79`) and the truncation
WARN (`:170-179`) names only `maxPages` and `resolved`.

Three deliverables, all done:

1. **New issue** `docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`
   (copied from `_TEMPLATE.md`, `type: bug`, `severity: med`, `status: open`).
   It carries the mechanism, why the consequence is worse than a triage tab (an
   outbound SEND that silently missed its target population, with no second
   render and no operator review of the omission, versus a delayed triage on a
   tab that will be reloaded), the measured headroom (10,000 bound vs ~641
   tenants, so latent not live), that `byHousingAuthority` is clean (hash-only
   GSI), and three ranked fixes - including the note that the shared
   `ScanIndexForward: false` mitigation helps this caller and the unknown queue
   in OPPOSITE senses and must be verified against both.
2. **Tier-1 marker at the walk**: a
   `TODO(broadcast-audience-truncation-drops-searching-tenants):` comment block
   immediately above the `listByType('tenant', ...)` call. **COMMENT ONLY - no
   logic in that file changed** (`git diff` on that file is comment lines only;
   `test/audienceResolution.test.ts` 10/10 still green).
3. **Named in the shared-read argument** of
   `docs/issues/inbox-filter-tabs-full-walk.md`: added to the mitigation block's
   list of `listByType` callers (which previously read "today.ts's triage block,
   `GET /api/contacts?type=`, and the importer"), and given its own cross-
   reference paragraph after the reopen list.

### N5 - THE ONE BEHAVIOUR CHANGE: the partition loop now consults `emitted`

`app/src/routes/inbox.ts`, the `for (const contact of queue.contacts)` loop.
Added, immediately after the `roleFromContact` guard and before
`resolveOpenThreads` - the same position the sibling sweep loop uses:

```ts
if (emitted.has(contact.contactId)) continue;
```

The comment above it mirrors the sibling's "belt" framing and states the
reachability HONESTLY rather than implying it is common: a Query resuming from
an `ExclusiveStartKey` cannot re-serve an item unless the item's index key
MOVED, `status` IS the range key, so an `active -> needs_review` flip between
two pages of the SAME walk moves the row forward past the cursor - which needs a
multi-page walk (>`UNKNOWN_QUEUE_PAGE_SIZE` unknown contacts) AND a write
landing between two sequential Queries, and "is not a state anyone hits this
week". It also records that the mirror flip skips a row invisibly and that no
guard here can see that.

Regression test: `app/test/inboxUnknownTab.test.ts`, "a DUPLICATED queue item
ships ONE row: the partition loop consults `emitted`, like its sibling sweep
loop". It drives the real `aggregateInbox` with `listByTypeOverride` returning
the same contact twice (the DynamoDB-faithful fake pages a static array and
cannot race itself, so the override is the only way to produce the shape) and
asserts one row plus distinct-ids-equals-row-count.

#### RED-then-GREEN evidence

Guard reverted (line replaced with a marker comment), test run:

```
FAIL test/inboxUnknownTab.test.ts > filter=unknown - the contact-side read >
  a DUPLICATED queue item ships ONE row: the partition loop consults `emitted`,
  like its sibling sweep loop
AssertionError: expected [ 'c-dup', 'c-dup' ] to deeply equal [ 'c-dup' ]

- Expected
+ Received
  [
    "c-dup",
+   "c-dup",
  ]

 Test Files  1 failed (1)
      Tests  1 failed | 12 skipped (13)
```

Guard restored, same command:

```
 ✓ test/inboxUnknownTab.test.ts (13 tests | 12 skipped) 5ms
 Test Files  1 passed (1)
      Tests  1 passed | 12 skipped (13)
```

The failure is the exact defect the reviewer's probe E reported (two identical
wire rows for one contact), so the test fails for the stated reason.

### N6 - the `(unknown, active)` zero, and the run that can produce it

`docs/issues/inbox-filter-tabs-full-walk.md`, the HIGH-1 reopen block.

- The "Live impact today: none" sentence now cites the run:
  "Measured 2026-08-25 with `--audit-triage-partition --no-status-narrow` on
  `app/scripts/measure-unread-contact-coverage.ts`".
- A following paragraph explains why the flag is load-bearing rather than a
  footnote: a narrowed run queries `status: 'needs_review'` and therefore reports
  zero `active` rows in EVERY possible world, so the one figure that makes this
  reopen point latent is the one figure a narrowed measurement structurally
  cannot produce.
- The reopen trigger is now an explicit TWO-number re-check list: the partition
  SIZE against both bounds, and the `(unknown, active)` COUNT - with the note
  that the `active` block fills the cap first, so it can starve the queue long
  before the partition as a whole looks large, and that a narrowed run is not
  evidence of anything.

### C1 (reversed ruling) - the measure script, both halves

`app/scripts/measure-unread-contact-coverage.ts`.

- **Docblock, `--audit-unknown-page`**: added a
  "HISTORICAL AS OF `feat/inbox-unread-cluster`" paragraph saying the app no
  longer performs this read, that the mode is retained UNCHANGED so the
  before/after comparison runs against the same instrument that produced the
  published figures, that it must not be "modernised" to match the new read, and
  where to look for the current cost (`--audit-triage-partition` with
  `--no-status-narrow`). **No measurement changed.**
- **The misleading output line**: `status mismatch N (should be 0 - the range
  key is the status)` is now emitted through a conditional spread guarded on
  `narrow`, matching the guard on the counter's only increment
  (`if (narrow && c.status !== 'needs_review')`). Under `--no-status-narrow` the
  line is omitted entirely instead of printing an inert `0` next to the words
  "should be 0" inside the output of the verification the handback offers. The
  comment records why.

**No measured value and no flag semantics changed.** The only difference in
output is one line that is absent when it could not have meant anything.

### C3 (reversed in part) - the harness fake, COMMENT ONLY

`app/test/helpers/twilioWebhookHarness.ts`, at the `listByType` fake. No line of
its logic was touched (`git diff` on this file is comment lines only; the two
`today*` suites are 56/56 green).

Two comment additions:

- Above `async listByType`: it is FROZEN because the `today.ts` triage pins are
  calibrated against its semantics, and new `filter=unknown` / unknown-queue
  coverage belongs on `app/test/helpers/contactsPartitionFake.ts`, with that
  helper's four modelled properties named so the reader knows what they get by
  moving.
- At the "MODELS `Limit` AS DYNAMODB APPLIES IT" claim: qualified to
  `excludeOrigin` ONLY, and corrected for the other two - `deleted` and `status`
  are filtered ABOVE the slice, so this fake charges no page slot for a
  soft-deleted or wrong-status row where DynamoDB would. Also records the newly
  widened gap: it does not model the range-key SORT the shared helper gained at
  `a544fa1a`, so this partition comes back in seed-array order.

### V1 - the fake's rule 6 tie-break

`app/test/helpers/contactsPartitionFake.ts`, rule 6 in the header.

The `status` half keeps rules 1-5's confidence and is now explicitly labelled as
doing so. The parenthetical asserting that "DynamoDB orders items sharing a GSI
range-key value by their table key" is gone, replaced with an
OBSERVED-NOT-CONTRACTED paragraph: AWS documents ordering by the sort-key VALUE
and that a GSI index key need not be unique, but specifies no order among items
that SHARE one; ordering by `contactId` is what the storage layout produces and
what DynamoDB Local does; STABLE is all any pin here needs. It cites
`today.ts:844-853` as the correct register one file over ("intra-partition order
is stable... ", deliberately not "ascending by contactId") and closes with "Four
pins lean on this tie-break; NOTHING in production may."

**The fake's behaviour is unchanged** - the sort comparator was not touched, and
`contactsPartitionFake.test.ts` is 8/8 green.

### MED-3 residual - "only a type change ... drains a row"

Two sites, because the same incomplete sentence appears in both:

- `app/src/routes/inbox.ts`, the WINDOW-cut comment: now "Only a TYPE change -
  to any other ContactType, team_member included - or a SOFT-DELETE actually
  drains a row", with the correction noted inline.
- `app/src/lib/unknownQueue.ts`, the header's "Only a RE-TYPE drains a row":
  same completion. **Flagged as slightly beyond the letter of the ruling** (which
  named `inbox.ts:1774` only) - it is the identical claim in the file the
  `inbox.ts` comment points at, and leaving one half corrected would have been
  worse than correcting both.

---

## Verification (all bare, from the worktree)

### Suites

`cd W:\tmp\inbox-unread-cluster\app` then
`npx vitest run test/contactsPartitionFake.test.ts test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts`

```
 ✓ test/unknownQueue.test.ts (9 tests) 14ms
 ✓ test/contactsPartitionFake.test.ts (8 tests) 7ms
 ✓ test/inboxUnknownParity.test.ts (7 tests) 9ms
 ✓ test/inboxUnknownTab.test.ts (13 tests) 14ms
 ✓ test/inboxGroups.test.ts (18 tests) 14ms
 ✓ test/inboxFeed.test.ts (62 tests) 122ms
 ✓ test/inboxApi.test.ts (53 tests) 451ms

 Test Files  7 passed (7)
      Tests  170 passed (170)
```

169 before this wave; the 170th is the N5 regression test.

Two extra suites run because this wave touched files they depend on (both
comment-only changes):

```
npx vitest run test/todayApi.test.ts test/todayUnmatchedNonRegression.test.ts
 Test Files  2 passed (2)
      Tests  56 passed (56)

npx vitest run test/audienceResolution.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### typecheck

`cd W:\tmp\inbox-unread-cluster` then `npm run typecheck` - exit 0, all five
workspaces (app incl. `tsconfig.scripts.json` and `tsconfig.test.json`,
dashboard, e2e, fake-twilio, fake-twilio-web).

### issues index

`cd W:\tmp\inbox-unread-cluster` then `npm run issues`:

```
[issues] 257 open, 151 closed, 408 total -> docs/issues/INDEX.md
[issues] open by severity: 9 high - 112 med - 136 low
[issues] 1 warning(s):
  - perf-selfqa-route-contract-drift.md: unknown severity "medium"
```

The new issue parsed cleanly. The single warning is PRE-EXISTING and belongs to
an unrelated file this wave did not touch. `INDEX.md` is gitignored and was NOT
staged.

### lint (gate 5, touched files only)

```
npx eslint app/src/routes/inbox.ts app/src/lib/unknownQueue.ts \
  app/src/services/audienceResolution.ts \
  app/scripts/measure-unread-contact-coverage.ts \
  app/test/helpers/contactsPartitionFake.ts \
  app/test/helpers/twilioWebhookHarness.ts \
  app/test/unknownQueue.test.ts app/test/inboxUnknownTab.test.ts
ESLINT EXIT: 0
```

No output, exit 0. No baseline comparison was needed - nothing was reported.

### ASCII

`git diff -U0 | grep "^+" | LC_ALL=C grep "[^ -~]"` returns nothing (exit 1), and
the same scan over the new untracked issue file returns nothing. All added lines
are ASCII.

---

## Disagreements, deviations, and things the next reader should know

1. **No disagreement with any ruling.** All ten items were implemented as ruled.

2. **Two additions beyond the literal instruction, both flagged above, neither
   behavioural:**
   - N2's WARN LEAD phrase ("ended with untriaged contacts still behind it") was
     corrected along with the clause the ruling named. It is the same false
     claim in the same string - on an all-`active` partition the rows still
     behind the walk are not untriaged. This is what moved the
     `inboxUnknownTab.test.ts` substring pin and the quotation in the issue file.
   - The MED-3 residual was completed at BOTH sites (`inbox.ts` and the
     `unknownQueue.ts` header), not only the one the ruling cited.

3. **C2 was not in my work list and I did not act on it.** The adjudication
   records "outcome UPHELD, my REASON withdrawn - record THAT reason" for LOW-9
   (the `deleted:true` pre-check), but the charge's "The work" section did not
   include it and LOW-9 is a handback item rather than a repo artifact. If the
   corrected reason (a bounded `deleted:true` probe is itself a
   filter-after-limit read over a partition that accumulates residue forever, so
   it can answer "none found" while truncated) is meant to land in the repo, it
   is still owed - most naturally as a bullet in
   `docs/issues/inbox-filter-tabs-full-walk.md`.

4. **One pin moved, for one reason I can state**: the WARN substring in
   `inboxUnknownTab.test.ts`, because item N2 rewrote the string it matched. No
   other assertion changed meaning; the two `unknownQueue.test.ts` field
   assertions were EXTENDED with the new fields, not relaxed.

5. **`docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
   still quotes the ORIGINAL WARN copy** (the pre-`a544fa1a` "the cut is in
   index order" version). It is off-limits to this wave and is a historical plan
   record, so it was left alone - noting it here so the next reader does not
   read it as current.

6. **N1's saving was recorded, not taken**, and the issue block says so with the
   reason. The sweep-path caveat is written down in both the code and the issue,
   because that is the trap someone taking the saving would fall into.
