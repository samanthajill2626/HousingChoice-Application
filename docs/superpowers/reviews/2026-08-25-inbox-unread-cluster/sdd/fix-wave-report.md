# Fix-wave report - feat/inbox-unread-cluster

Implementer: fix-wave agent. Scope document:
`.superpowers/review/adjudications.md`. Every ruling implemented; nothing
declined was implemented.

**NO PRODUCTION BEHAVIOUR CHANGED.** The only non-comment line in `app/src/`
that this wave touched is one WARN message string (ruled in A1). Verified
mechanically:

```
git diff app/src/ | grep -E '^[+-]' | grep -v '^[+-][+-]' \
  | grep -vE '^[+-]\s*(//|\*|/\*)' | grep -vE "^[+-]\s*$"
```

returns exactly the two WARN-copy lines and nothing else. No query option, no
returned shape, no rendered row moved.

## Commit

- `a544fa1a` - single commit, code + tests + docs (it did not grow unwieldy).
  7 files changed, 390 insertions(+), 61 deletions(-).
  Files: `app/src/lib/unknownQueue.ts`, `app/src/routes/inbox.ts`,
  `app/test/helpers/contactsPartitionFake.ts`,
  `app/test/contactsPartitionFake.test.ts`, `app/test/unknownQueue.test.ts`,
  `app/test/inboxUnknownTab.test.ts`,
  `docs/issues/inbox-filter-tabs-full-walk.md`.
- `docs/issues/INDEX.md` regenerated but NOT staged (gitignored, confirmed with
  `git check-ignore`). This report is also gitignored (`.superpowers/`).

## Facts verified independently before writing anything

- **HIGH-1 ordering.** `app/src/lib/tables.ts:90-93` declares `byTypeStatus` as
  `hashKey type` / `rangeKey status`. `app/src/repos/contactsRepo.ts:1009-1020`
  builds the `QueryCommandInput` with `TableName`, `IndexName`,
  `KeyConditionExpression`, `FilterExpression`, the two expression maps, and
  optional `Limit` / `ExclusiveStartKey` - there is NO `ScanIndexForward` key,
  so the Query is ascending on the range key. `NON_TENANT_STATUSES` is
  `['needs_review','active']` (`app/src/lib/statusModel.ts:194`) and
  `'active' < 'needs_review'`. CONFIRMED as reported.
- **MED-3 status-only triage.** `app/src/routes/contacts.ts` contains
  `if ('status' in parsed.patch && !('type' in parsed.patch))`, which 404s an
  unknown contact and otherwise validates against `statusAllowlistFor(stored.type)`;
  `statusAllowlistFor` returns `NON_TENANT_STATUSES` for a non-tenant
  (`statusModel.ts:204-207`). So `(unknown, active)` is reachable and never
  leaves the partition. CONFIRMED.
- **MED-4 hydration before the window.** `buildContactRow` is called inside the
  `for (const contact of queue.contacts)` loop; `slice(0, limit)` runs after
  `unknownRows.sort(...)`. CONFIRMED.
- **MED-2 unreachable guard.** `listByType` hashes on `type`, so a returned item
  necessarily carries `type === 'unknown'`, which is the attribute
  `roleFromContact` reads. CONFIRMED.

## Per finding

### A1 - correct every "arbitrary / index order / recency-blind" comment

Four sites, all corrected to state the ACTUAL order (status-ascending, `active`
first, `needs_review` starved):

1. `app/src/lib/unknownQueue.ts` - the `UnknownQueueResult.contacts` doc. The
   sentence "the cut is ARBITRARY with respect to recency" is replaced by the
   full mechanism: index shape, missing `ScanIndexForward`, the lexicographic
   comparison, and the consequence that the cut is status-first and
   DETERMINISTIC rather than arbitrary. Names the test that pins it and the
   issue reopen point.
2. `app/src/lib/unknownQueue.ts` - the comment above the truncation WARN. It
   said the hidden rows "were chosen by index order"; it now says they were
   chosen by the range key `status`, ascending, and says why "index order" is
   the wrong word to leave in place (it reads as harmless).
3. `app/src/lib/unknownQueue.ts` - the WARN MESSAGE STRING itself. Was
   `"... the cut is in index order, so the newest untriaged contact may be among
   the hidden rows"`; now `"... the cut is in status order (active before
   needs_review), so the hidden rows are the ones nobody has reviewed yet"`.
   ASCII, counts-only fields unchanged, no PII. This is the one non-comment
   source change in the wave. The existing pin
   (`inboxUnknownTab.test.ts`, `includes('untriaged contacts still behind it')`)
   matches the substring that survived, and stays green.
4. `app/src/routes/inbox.ts` - the branch's sort/window comment block at the
   `unknownRows.sort(...)` site. The "hidden rows are arbitrary with respect to
   recency" claim is replaced by a numbered two-cut block: cut 1 (window) really
   is newest-first; cut 2 (collector) is status-ascending and deterministically
   starves `needs_review`.

Also corrected, same class of claim, in a test comment:
`app/test/inboxUnknownTab.test.ts` - the cap-cut test's title said "the cut is
INDEX order"; it now says "PARTITION order", and its body explains that this
fixture is SINGLE-STATUS (so the range-key sort ties and falls back to
`contactId`), pointing at the collector suite for the mixed-status case. Without
that note the fixture silently looks like it disproves HIGH-1.

### A2 - the fake models the range-key sort

`app/test/helpers/contactsPartitionFake.ts`:

- Added **rule 6** to the numbered header list: the partition is sorted by the
  range key `status` ascending, then the table key `contactId` as the tie-break
  (DynamoDB orders items sharing a GSI range-key value by their table key), with
  the citation to `contactsRepo.ts:1009-1020` for the absent `ScanIndexForward`.
- The rule carries **the reason**, as instructed: seed-array order made the
  partition's most consequential property inexpressible, which is exactly why no
  existing test could catch HIGH-1. It names the lexicographic comparison and
  points at the pinning test.
- Implementation: a `.slice().sort(...)` on `(status, contactId)` inserted after
  the sparse/type/status filters and before `exclusiveStartKey` resolution - so
  paging, Limit, and the FilterExpressions all operate on the sorted partition,
  which is the production order of operations.

Its own suite gained a pin (see moved pins below) and stays green: 8 tests.

### A3 - the ordering fact pinned as a test

`app/test/unknownQueue.test.ts`, new test:

> `THE CAP STARVES needs_review: the partition is status-ordered, so a cut keeps
> the ALREADY-REVIEWED rows and discards the front door`

A partition of 4 (two `needs_review`, two `active`) driven through the real
`collectUnknownTriageQueue` with `maxRows: 2`. Asserts the survivors are exactly
`['c-unk-003','c-unk-004']`, that both are `active`, that NO `needs_review` row
survived, and that `truncated` is true. The comment states it pins CURRENT
behaviour rather than a regression, and carries A4's note.

A second, narrower pin lives in the fake's own suite (rule 6, below), which
proves the sort at the fake layer independent of the collector.

### A4 - the mitigation is named and explicitly not taken

Recorded in three places, each aimed at a different reader:

- `unknownQueue.ts`'s `UnknownQueueResult.contacts` doc ("NOT MITIGATED HERE,
  deliberately").
- `inbox.ts`'s two-cut comment block, under cut 2.
- The new test's comment.

All three give the same reason: the fix is a `ScanIndexForward: false` option on
the repo read; `listByType` is a SHARED read that `today.ts`'s triage block also
uses; reversing its direction is repo-wide and therefore the human's call. Each
points at `docs/issues/inbox-filter-tabs-full-walk.md` as the reopen point.

### B - MED-2, the unreachable live TYPE re-check

Guard KEPT, unchanged, as ruled. Three claim sites fixed:

1. `app/src/routes/inbox.ts` - the guard's own comment. Opens with "UNREACHABLE
   FROM A REAL QUERY - a belt, not a check", explains why (hash key IS `type`,
   and `roleFromContact` reads that same attribute off that same image),
   explicitly retracts the stale-index rationale (a stale entry stays keyed
   `type='unknown'` with its projected `type` stale to match, so it PASSES the
   guard), states that `unknownQueueRetyped` cannot appear on a real log line,
   and records the two reasons it is kept anyway (a second type mapped
   `queried`; a caller that reads via the base table / BatchGet / elsewhere).
2. `app/src/routes/inbox.ts` - the "FOR THE LOG READER" note on the dead
   `unknownFilterRole` arm. It used to send operators to `unknownQueueRetyped`.
   It now says there is NO replacement counter, that what replaced the rejection
   is the partition Query excluding non-unknown contacts by construction before
   any row exists to count, and points at `queueContacts` / `queuePages` as the
   fields that actually carry what the queue read saw.
3. `app/test/inboxUnknownTab.test.ts` - the guard's test. Renamed to
   `the type guard drops a non-unknown row - reached ONLY through an override,
   because no real Query can produce one`, with a "READ THIS BEFORE TRUSTING THE
   PIN" body saying plainly that `listByTypeOverride` is the only way to drive
   the arm and that it supplies an item shape the DynamoDB-faithful fake would
   never emit. Assertions unchanged.

### C - MED-3, "triage retypes the contact out of the partition" is false

Both leaning sites fixed, plus the compounding effect recorded at each:

1. `app/src/lib/unknownQueue.ts` - the NOT-COPIED-status block. The false
   sentence is removed and explicitly flagged as removed. Replaced by the
   verified mechanism: the status-only PATCH shape, `statusAllowlistFor` giving
   `['needs_review','active']` for `unknown`, the dashboard form reaching it,
   and the conclusion that the row leaves Today's triage block but NEVER this
   queue - only a RE-TYPE drains a row. Then the compounding note: a status-only
   triage moves the row into the `active` block, which the ascending Query
   returns FIRST, so a half-triaged row is promoted to the front of the read and
   crowds out rows nobody has looked at.
2. `app/src/routes/inbox.ts` - the window comment, which used the false claim as
   the justification for shipping no cursor. Now says "RE-TYPED, not merely
   triaged", carries the same mechanism, repeats the promotion effect, and
   states that until a type change happens the rows past `limit` have no
   affordance that reaches them.

### D - MED-4, "pays per row RETURNED" is false

`app/src/routes/inbox.ts`, the branch header comment. Now reads "pays per row
COLLECTED - bounded by `UNKNOWN_QUEUE_MAX_ROWS`, NOT by the `limit` the caller
asked for", names the correction, and states the concrete consequence (a
cap-full queue hydrates up to 200 rows serially to render 30). Per the ruling it
also records that the ordering is REQUIRED and must not be restructured away,
because the sort key is the hydrated activity. No code moved.

### E1 - MED-5, the collector-truncation residual

`docs/issues/inbox-filter-tabs-full-walk.md`, new block immediately after the
capped-sweep residual: "The COLLECTOR-truncation residual - the SAME shape as
the capped-sweep one, and likelier". States the `{ contacts: [], truncated: true }`
result, that requirement 5 forbids the wire flag, that the dashboard therefore
renders the ordinary "No unknown numbers" empty state over a live queue, and -
the point a sweep-only reader misses - that the signals are a DIFFERENT WARN and
a DIFFERENT log field (`queueTruncated`) from the sweep's. Argues the likelihood
from the module's own "accumulates FOREVER" premise plus the ordering defect.
Same reopen trigger.

### E2 - MED-7, the class (c) wording

Same file, the class (c) ruling block. Heading now reads "enforced for TAB
MEMBERSHIP ONLY". A new paragraph states exactly what shipped: `roleFromContact`
(`inbox.ts:422-429`) is UNTOUCHED, still falls `team_member` through to
`'unknown'`, so `needsTriage: true` (`inbox.ts:873`) and the "Needs triage" chip
still ship on the All and Unread tabs; the "one-line fix" this file said would be
needed is still needed for the labelling half. Records that widening
`roleFromContact` was deliberately NOT done (wire change, `role` union reaches
`dashboard/src/api/types.ts`, its own blast radius) and names the smaller
alternative (narrow `needsTriage` to `contact.type === 'unknown'`). Notes zero
measured rows, so it is a half-fixed mechanism, not a live defect.

Also corrected in the same block: the stale `roleFromContact (inbox.ts:396-403)`
reference the adversarial reviewer flagged as a nit. Verified with
`grep -n "function roleFromContact"` - it is at `422-429` on this branch. The
correction is written as "an earlier note in this file cited `:396-403`, which is
stale" so the old reference is not silently rewritten out of the record.

`roleFromContact` itself was NOT widened, per the ruling.

### E3 - HIGH-1 as a named reopen point

Same file, new block: "NAMED REOPEN POINT: the cap starves `needs_review`". The
full mechanism, the compounding with status-only triage, two concrete failure
shapes (200+ `(unknown, active)` fills the cap; 1000+ residue rows expire the
page budget into the empty state), the measured live impact (16 dev / 7 prod,
zero `(unknown, active)`, two orders of magnitude from the cap), and the
MITIGATION with the reason it was not taken (`listByType` is shared with
`today.ts`, `GET /api/contacts?type=`, and the importer) plus two alternatives.
Closes by naming the two artifacts that keep the fact from being rediscovered.

Additionally, the RESOLVED block's existing "COLLECTOR cap" bullet said it "cuts
in INDEX order, with NO recency guarantee". That is the same false-reassurance
wording A1 targets, in the registry rather than the code, so it was corrected in
place to "status-ascending order, and it starves `needs_review`", pointing at the
new reopen block. The adjacent WINDOW-cut bullet said the rows "become reachable
as triage drains the queue" - the MED-3 claim - and was corrected there too.

## Pins that moved because of A2, and why

Two, both predicted from the sort before running, both confirmed by the run.

**1. `app/test/unknownQueue.test.ts` - "one Query when the partition fits a page
- and it narrows on NOTHING".**
Was `['c-unk-001','c-unk-002','c-unk-003']`, now
`['c-unk-002','c-unk-001','c-unk-003']`.
Explanation: the seed is `unk(1)` (`needs_review`), `unk(2, {status:'active'})`,
`unk(3, {origin:'group_detection'})` (`needs_review`), plus a tenant. Under the
range-key sort the single `active` row sorts ahead of both `needs_review` rows
(`'active' < 'needs_review'`), and the two `needs_review` rows keep their
relative order by the `contactId` tie-break (`c-unk-001 < c-unk-003`). This is
exactly the order production would produce for this partition. The ROW SET is
unchanged - all three unknowns are still present and the tenant is still absent -
so both "do not copy" mutation probes remain non-vacuous. Repinned with a
comment naming the reason.

**2. `app/test/contactsPartitionFake.test.ts` - "excludeOrigin filters the PAGE
(spends slots), like the real FilterExpression".**
The fixture, not the assertion, was changed: contact id `real` renamed to
`s3-real`.
Explanation: all three rows share `status: 'needs_review'`, so the tie-break is
`contactId` ascending and `'real' < 's1' < 's2'`. The sorted partition became
`[real, s1, s2]`, so `limit: 2` returned the page `[real, s1]`, `real` survived
the `excludeOrigin` filter, and the test's assertion (`items` empty, LEK at `s2`)
no longer described what it was written to describe. That is a FIXTURE artifact,
not a finding: the test's subject is "an excluded row still spends its page
slot", which requires both stubs to occupy the first page. Renaming the third row
so it sorts last restores the intended arrangement, and the assertions are
byte-identical to before. A comment now records that ids in this file encode
SORT position, not seed position, so the trap does not recur.

No other pin moved. I checked the remaining consumers and each is
order-insensitive for a reason I can state:

- `inboxUnknownParity.test.ts` - every world holds at most ONE queue contact, so
  there is nothing to order. All 7 pins byte-identical, still green.
- `inboxUnknownTab.test.ts` - the cap-cut (`c-u0..c-u3`) and window
  (`c-w0..c-w4`) fixtures are single-status, so the sort ties and falls back to
  `contactId`, which is already the seed order. The mixed-status fixture ("sorts
  partition rows and resurfaced rows together") reorders in the PARTITION
  (`c-new` is `active` and now comes first) but its assertion is on the ACTIVITY
  sort applied afterwards, which is unaffected - and its `c-mid` row is
  soft-deleted, so it never came from the partition read at all.
- `inboxFeed.test.ts`, `inboxGroups.test.ts`, `inboxApi.test.ts` - green
  unchanged; their `listByType` fixtures are single-status or single-row.

Nothing moved that I could not explain by the sort, so there was nothing to
stop and report under that rule.

## Verify outputs

All run bare, no pipes, no `;`-chaining of gate commands.

1. **Targeted suites** -
   `cd W:\tmp\inbox-unread-cluster\app` then
   `npx vitest run test/contactsPartitionFake.test.ts test/unknownQueue.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts`

   ```
   Test Files  7 passed (7)
        Tests  169 passed (169)
   ```

   Exit 0. Counts by file: `contactsPartitionFake` 8 (was 7, +1 for rule 6),
   `unknownQueue` 9 (was 8, +1 for the starvation pin), `inboxUnknownTab` 11,
   `inboxUnknownParity` 7, `inboxFeed` 62, `inboxGroups` 29, `inboxApi` 53.
   Net +2 tests, both added by this wave.

   An intermediate run before the repins showed exactly the 2 predicted failures
   and no others - recorded here because "only the predicted pins moved" is the
   load-bearing claim of section A2.

2. **Integration (real DynamoDB Local)** -
   `cd W:\tmp\inbox-unread-cluster\app` then
   `npx vitest run test/inbox.integration.test.ts`

   ```
   Test Files  1 passed (1)
        Tests  10 passed (10)
   ```

   Exit 0. `hc-dynamodb-local` was already running; `npm run db:start` was not
   needed.

3. **Typecheck** - `cd W:\tmp\inbox-unread-cluster` then `npm run typecheck`.
   Exit 0. All five workspaces (app x3 tsconfigs, dashboard, e2e, fake-twilio,
   fake-twilio-web) clean, no output beyond the script banners.

4. **Lint (gate 5, scoped to touched files)** -
   `npx eslint app/src/lib/unknownQueue.ts app/src/routes/inbox.ts app/test/contactsPartitionFake.test.ts app/test/helpers/contactsPartitionFake.ts app/test/inboxUnknownTab.test.ts app/test/unknownQueue.test.ts`
   Exit 0, no output. The Markdown file was excluded from the argument list on
   purpose (the AGENTS.md extension filter), and the list was non-empty, so the
   repo-wide trap did not apply.

5. **Issue index** - `cd W:\tmp\inbox-unread-cluster` then `npm run issues`.
   Exit 0: `256 open, 151 closed, 407 total`. One warning,
   `perf-selfqa-route-contract-drift.md: unknown severity "medium"` - PRE-EXISTING
   and in a file this wave did not touch. `docs/issues/INDEX.md` regenerated and
   NOT staged (`git check-ignore` confirms `.gitignore:62`).

6. **ASCII check on added lines** -
   `git diff -U0 | grep '^+' | grep -n '[^ -~\t]'` returns nothing. All new
   comment, string, issue and test-name text is ASCII: no smart quotes, no em
   dashes, no arrows.

7. **Pre-commit hygiene** - bare `git status` showed exactly the seven intended
   files and nothing else; `git rev-parse -q --verify MERGE_HEAD` reported no
   MERGE_HEAD. Staged by explicit path, never `git add -A`.

## Rulings I disagree with

None. Every ruling matched what I verified in the tree, and the two I
re-derived independently (HIGH-1's ordering and MED-3's status-only PATCH) came
out exactly as adjudicated.

Two observations offered as information, NOT as deviations - nothing was done
about either:

1. **The HIGH-1 ruling is right for this branch, and I want to record why the
   record-only outcome is not merely deferral.** The starvation is latent only
   because `(unknown, active)` is measured at zero in both environments. But
   MED-3 is the mechanism that MANUFACTURES that population: every status-only
   triage creates one, permanently, at the front of the read. So the two
   findings together describe a population that grows monotonically with normal
   operator use from a base of zero. That does not change what this wave should
   do - the mitigation genuinely is a shared-read change and genuinely is the
   human's call - but the human deciding it should know the empty-today number
   is a starting condition, not a steady state. This reasoning is recorded in
   the issue's reopen block, not only here.

2. **LOW-10 was declined for a reason that expires.** The measure script is
   frozen because it is the evidence base for a verification the human is about
   to run. Once that verification is done, the script still describes a read the
   application no longer performs, and the next person to reach for it will be
   misled. Flagging so the handback can carry it forward rather than losing it
   with this wave. I did not touch
   `app/scripts/measure-unread-contact-coverage.ts`.

Also untouched as instructed and confirmed absent from `git status`:
`app/test/helpers/twilioWebhookHarness.ts` (frozen; its divergence from the new
fake is now larger, since only the new fake models the sort - already recorded in
the plan's Global Constraints and re-flagged here) and everything under
`docs/superpowers/specs/` (human-gated).
