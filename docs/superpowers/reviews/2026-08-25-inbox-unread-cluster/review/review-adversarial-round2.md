# Adversarial re-review, round 2 - feat/inbox-unread-cluster @ a544fa1a

READ-ONLY. Nothing in the repo was modified, no commit made. Evidence: three
throwaway tsx probes outside the repo (D/E/F/G below), a vitest run of the six
suites that touch the changed fake (116/116 green), and line-by-line reads of the
fix diff, the adjudications, and every consumer re-swept.

A note on labels: the charge refers to fixes "A1-A4, B, C, D, E1-E3". No file in
`.superpowers/review/` defines that key (only `adjudications.md`,
`diff-package.md` and the two review files are present), so section 4 gives a
verdict per ADJUDICATED FINDING instead. Same information, different index.

---

# 1. NEW FINDINGS

Six. Two are consequences of the sort order that nobody has stated, one is a
defect introduced BY the fix wave, one refutes a justification the fix wave left
standing beside the thing it corrected, one is a missing guard the module applies
in its own sibling loop, and one is a record gap the HIGH-1 ruling now rests on.

## N1. MED - the corrected MED-4 comment replaces an understatement with an over-claim, and the over-claim forecloses the saving

**Where:** `app/src/routes/inbox.ts:1532-1541` (the corrected block).

The fix correctly changed "pays per row RETURNED" to "per row COLLECTED -
bounded by UNKNOWN_QUEUE_MAX_ROWS". Then it added a justification that is false:

> That ordering is REQUIRED and is not a defect to restructure away: the sort key
> is the hydrated activity, so the window cannot be applied before the rows exist.

The sort key is `row.lastActivityAt`, which `buildContactRow` takes verbatim from
`maxConv.last_activity_at` (`inbox.ts:872`) - a CONVERSATION field, produced by
`resolveOpenThreads`. It does not come from `latestMessageOf`, and it does not
come from `placementLabel`. Those two are pure presentation
(`channel` / `direction` / `preview` / `placementContext`) and are NOT sort
inputs. Only the thread resolution must precede the sort; the message read and
the placement read must not.

This matters because the sentence closes the question. The previous comment was
merely wrong about a number; this one instructs the next reader that the
available saving does not exist.

**Evidence - probe D**, driving the real `aggregateInbox` with a 5-contact queue
and `limit: 2`:

```
queue size 5, request limit 2 -> rows returned: 2
findByParticipantPhone (needed for the sort key): 5
listByConversation  (PRESENTATION only, not a sort input): 5  - 2 would suffice
getPlacementById    (PRESENTATION only, not a sort input): 5  - 2 would suffice
```

Scaled to the bound the corrected comment itself names: a cap-full queue at the
dashboard's `limit=30` pays 200 message reads and up to 200 placement reads where
30 of each would do - roughly 340 discarded serial round trips, in the same
request that the comment says cannot be restructured.

Note the deleted-row (sweep) path IS different: there `latestMessageOf` is a
VISIBILITY predicate (resurfacing), so it must run before the row is known to
exist. That path is not cap-bound. The over-claim is specific to the queue path.

**Direction.** Say what is true: the THREAD resolution must precede the sort;
the presentation hydration need not and could move after `slice(0, limit)` for
the `deleted=false` path. Then either take the saving or record it as a knowing
deferral - but do not tell the reader it is impossible.

## N2. MED - the new truncation WARN copy asserts a composition it cannot know, and is false in a reachable state

**Where:** `app/src/lib/unknownQueue.ts:212-215` (the WARN message).

The copy went from `"the cut is in index order, so the newest untriaged contact
may be among the hidden rows"` (vague, hedged, safe) to:

> "the cut is in status order (active before needs_review), so the hidden rows
> are the ones nobody has reviewed yet"

The first clause is now correct. The second is an unconditional claim about WHICH
rows were hidden, and it is only true when the cut lands inside the
`needs_review` block. When the partition holds no `needs_review` row at all - or
enough `active` rows that the cut lands inside the `active` block - every hidden
row is one somebody DID review, and the WARN says the opposite.

**Evidence - probe F**, a 4-row all-`active` partition with `maxRows: 2`:

```
partition statuses: active
kept:   c-a0(active), c-a1(active)
hidden: c-a2(active), c-a3(active)   <- nobody-unreviewed was hidden
WARN:   ...the cut is in status order (active before needs_review), so the
        hidden rows are the ones nobody has reviewed yet
```

This is the exact shape the charge warned about: a wave that replaces a false
claim with a subtly different false claim, which reads as freshly verified
because it is specific. And it lands in the ONE artifact an operator or
on-call reader sees.

**Direction.** State the mechanism, not the outcome: `"...the cut is in status
order, so needs_review rows are hidden before active ones"`. That is true in
every composition. Cheaper still, add the composition to the WARN's FIELDS
(`{ pages, kept, collected }` could carry `keptNeedsReview` / `collectedNeedsReview`)
and let the reader see it rather than being told.

## N3. MED - the class (f) justification the fix wave left standing cites a create path the dashboard cannot reach

**Where:** `app/src/lib/unknownQueue.ts:25-28`, immediately above the corrected
MED-3 block.

The fix wave rewrote the sentence after it but left this one:

> `NOT COPIED - status: 'needs_review'`: a contact CREATED as unknown defaults to
> status 'active' (routes/contacts.ts:881-884), so (unknown, active) is the
> DEFAULT, not an edge case - class f.

`POST /api/contacts` does default an `unknown` create to `'active'`
(`contacts.ts:881-884`). But no operator can perform that create.
`KindPicker` - the single control both the create dialog and the edit form use
(`ContactEditForm.tsx:452-456`) - offers exactly five segments, `tenant`,
`landlord`, `partner`, `pm`, `other` (`KindPicker.tsx:23,128-138`), and `other`
resolves to one of the three base types
(`KindPicker.tsx:107-112`). `unknown` is not selectable, so the dashboard can
neither create a `type:'unknown'` contact nor re-type one back to it. Every
production writer that mints an `unknown` sets `needs_review`
(`contactCapture.ts:79-80`, `groupMembers.ts:111-112`, `groupConvert.ts:339-340`,
both seeds), and the importer's `deriveStatus` returns `'needs_review'` for
`unknown` unconditionally (`lib/import/status.ts:67`).

That is consistent with the measurement the issue leans on - ZERO `(unknown,
active)` rows in dev and prod. The cited justification is not the operative one;
the operative one is the status-only PATCH the same file now documents eleven
lines below. Class f's DECISION may well still be right (it costs nothing and it
closes a real hole), but its stated reason is API-only, and the fix wave passed
directly over it while rewriting its neighbour.

**Direction.** Point the class-f justification at the mechanism that actually
produces the population (`the status-only triage PATCH`, already documented
below it), and mark the create default as API-only.

## N4. MED - `audienceResolution` is the third `byTypeStatus` reader and it carries the same unstated assumption, with product consequences

**Where:** `app/src/services/audienceResolution.ts:129-136` (the walk),
`:78-79` (`DEFAULT_MAX_PAGES = 50`, `DEFAULT_PAGE_SIZE = 200`), `:170-179`
(the truncation WARN).

The charge asked whether any OTHER reader of `byTypeStatus` carries the same
assumption. I swept all four. Three are clean, one is not:

- `today.ts:865-870` - narrows on `status: 'needs_review'`, so the cross-status
  bias cannot arise, and its own comment already names the within-status
  consequence ("there is NO recency ordering... past the page limit, genuinely
  new unknown contacts became permanently invisible here"). CLEAN, and it is the
  model for how the fact should be written down.
- `routes/contacts.ts:1003` + `dashboard/.../useContacts.ts:7-10` - the list
  route pages via cursor and the hook walks EVERY page (`getAllContacts`), a
  property the earlier pagination sweep put there deliberately. No truncation, so
  no bias. CLEAN.
- `lib/import/apply.ts` - writes, does not bound-read. CLEAN.
- **`audienceResolution.ts:129` - NOT clean.** The no-housing-authority path
  (i.e. a broadcast to all tenants) walks `listByType('tenant')` bounded at
  `maxPages * pageSize`. `TENANT_STATUSES` ascending is
  `inactive, needs_review, on_hold, onboarding, placed, placing, searching` - so
  a truncated audience keeps `inactive` tenants and drops **`searching`
  tenants first**, which is precisely the population a property-match send
  exists to reach. The WARN at `:176-179` says "audience may be truncated" and
  names `maxPages` and `resolved`; it does not say WHICH tenants were dropped,
  and the non-obvious part is exactly that.

**Live impact today: none** - the bound is 10,000 against ~641 tenants, 15x more
headroom than the unknown queue has, and the `byHousingAuthority` path (a
hash-only GSI, no range key) has no ordering at all. But it is the same defect
in a place with worse consequences than a triage tab, and it is now the only
reader where the fact is unwritten.

**Direction.** One comment at `:129` and one clause in the WARN copy. No
behaviour change. If the human takes the `ScanIndexForward` option for the
unknown queue, this is the second caller that has to be considered, and the
issue's "shared read" argument should name it alongside `today.ts` (which it
currently does not - `docs/issues/inbox-filter-tabs-full-walk.md` lists
`today.ts`, `GET /api/contacts?type=`, and "the importer").

## N5. LOW - the partition loop has no `emitted` guard, so a duplicated queue item ships two identical wire rows

**Where:** `app/src/routes/inbox.ts:1601-1651` (the loop `ADDS` to `emitted` at
`:1649` and never consults it), against the sibling sweep loop at `:1710`, which
does (`if (emitted.has(candidate.contact.contactId)) continue;` - described in
its own comment as "a belt").

**Evidence - probe E**, driving `aggregateInbox` with a queue containing one
contact twice:

```
rows: c-dup, c-dup
distinct contactIds: 1 vs rows: 2
```

Two identical `kind: 'contact'` rows on the wire, which the dashboard keys
identically (`rowKey` -> `c:c-dup`, `useInbox.ts:104-108`) - a duplicate React
key and a doubled row.

**Reachability is narrow and I will not overstate it.** A DynamoDB Query with an
`ExclusiveStartKey` cannot re-serve an item unless the item's index key MOVED. It
can move here: `status` IS the range key, so a contact whose status flips
`active -> needs_review` between two pages of the SAME walk moves FORWARD past
the cursor and is read twice. That flip is reachable
(`contacts.ts:1459-1470` maps a re-type to `unknown` back to `needs_review`, and
the edit form can set it directly), but it must land inside a multi-page walk -
which needs >100 unknown contacts - within the milliseconds between two
sequential Queries. The mirror case (`needs_review -> active`, the common
direction) moves the row BACKWARD and silently SKIPS it, which is invisible.

I report it because the guard is one line, the module already applies it three
statements later for a case its own comment calls merely a belt, and the
asymmetry reads as an oversight rather than a decision.

## N6. LOW - the number the whole HIGH-1 ruling rests on is recorded without naming the run that can produce it

**Where:** `docs/issues/inbox-filter-tabs-full-walk.md`, the HIGH-1 reopen block:
"**Live impact today: none.** Measured 2026-08-25: 16 unknown contacts in dev, 7
in prod, with ZERO `(unknown, active)` in either".

The `(unknown, active)` count is what turns HIGH-1 from live to latent, and it is
the only figure in the block that a NARROWED measurement structurally cannot
produce: `--audit-triage-partition` without `--no-status-narrow` queries
`status: 'needs_review'` and therefore reports zero `active` rows in every world,
including a world full of them. This same file already records that "every figure
published before this flag existed priced the narrowed shape"
(`measure-unread-contact-coverage.ts:601-608`), and the branch added the flag for
exactly that reason.

The claim is CONSISTENT with the branch's own history (commit `1a959e72`,
"re-measure on the corrected query shape - widening cost nothing"), so I am not
saying it is wrong. I am saying the one number that decides the severity is
stated without citing the flag that makes it meaningful, in a file that elsewhere
insists on precisely that discipline.

**Direction.** One clause: "measured with `--no-status-narrow`". And add the
`(unknown, active)` count to the things to re-check at the reopen point, since it
is now half the trigger.

---

# 2. ADJUDICATIONS I CONTEST

Three, all narrow. I accept the LOW-8 declination and the HIGH-1 record-only
ruling without argument.

## C1. LOW-10 declined - the reason answers "do not change the instrument", but half the finding was "label the instrument"

**Ruling:** "The instrument is the evidence base for the spec's numbers and for
the post-merge verification the handback OFFERS, so changing it now would
invalidate the comparison the human is being asked to run."

That argument is sound for the instrument's BEHAVIOUR and I withdraw any
suggestion of changing what it measures. It does not reach either half of what I
filed:

- **The docblock.** `measure-unread-contact-coverage.ts:309-326` says
  `--audit-unknown-page` is "THE measurement for `inbox-filter-tabs-full-walk`"
  and "replicates the pager: same partition, same order, same per-conversation
  contact resolution, same break condition". Adding one HISTORICAL line above
  that changes no measurement and invalidates no comparison. A comparison run
  needs the numbers to be stable, not the prose.
- **The misleading output line, `:676`.** Under `--no-status-narrow` the script
  prints `status mismatch 0 (should be 0 - the range key is the status)` from a
  counter guarded on `narrow` and therefore never incremented (`:628`). A human
  running the offered verification reads a `0` next to "should be 0" as a passed
  check. This is INSIDE the comparison's own output, and per N6 above,
  `--no-status-narrow` is now the run the HIGH-1 ruling depends on. Suppressing
  one line when the counter is inert changes no measured value.

**Requested:** reinstate the second half at LOW and take the docblock line.

## C2. LOW-9 declined - the outcome is right, the stated reason is not

**Ruling:** a bounded `deleted:true` probe to skip the sweep "is a design change
to an approved requirement 3".

Requirement 3, as the code records it (`inbox.ts:1653-1663`), is that the sweep
carries NO SECOND BOUND - `maxRows` is pinned to the budget so no candidate cap
can crowd class-(d) rows out. A pre-check that decides whether to RUN the sweep
adds no bound to it: when the deleted-unknown partition is empty, the sweep's
complete answer and its skipped answer are the same empty set, so the property
requirement 3 protects is untouched.

The real objection - which is better than the one given - is that the probe
cannot cheaply answer "zero". `listByType('unknown', { deleted: true })` is
itself a filter-after-limit read over a partition the module argues accumulates
residue forever, so a bounded probe can return "none found" while truncated, and
skipping on that answer would reintroduce exactly the "missing for two different
reasons" ambiguity this whole branch is built to avoid.

**Requested:** keep the handback, replace the reason. As written it teaches the
next person that requirement 3 forbids something it does not, which will block a
sound optimisation later.

## C3. MED-6 harness half declined - freezing the fake does not require the new coverage to depend on it

**Ruling:** `twilioWebhookHarness.ts`'s fake is "frozen because the `today.ts`
triage pins are calibrated against its semantics. Not fixed; named in the
handback."

Agreed on the fake. But the finding was not only "change the fake" - it was that
`inboxApi.test.ts`'s NEW `filter=unknown` assertions run THROUGH it, so the one
route-level test of the new branch is backed by a fake that models neither the
sparse index nor filter-after-limit nor limit-reached LEK - and, since a544fa1a,
not the range-key sort either. That last one is new and widens the gap the fix
wave just closed elsewhere: `contactsPartitionFake` now sorts, the harness fake
does not, so two suites exercising the same branch disagree about partition
order.

Nothing about that requires unfreezing the harness. Two options, both free:
move the unknown-tab assertions onto the shared helper, or add one line to
`twilioWebhookHarness.ts:1684` saying "frozen for the today.ts triage pins; do
not add `filter=unknown` coverage here - use `test/helpers/contactsPartitionFake.ts`".

**Requested:** the one-line comment, at minimum. The handback naming it is not
the same as the next author seeing it at the call site.

---

# 3. THE FIX IMPLEMENTER'S CLAIM ABOUT MED-3 - VERIFIED, AND STRONGER THAN ARGUED

The claim: the status-only triage PATCH is the MECHANISM that manufactures the
`(unknown, active)` population that HIGH-1's ordering then starves, so "measured
zero today" is a starting condition, not a steady state.

**Verified, and it is the ONLY UI-reachable manufacturer** - which the
implementer did not claim and which makes the point sharper:

| path | reachable? | produces `(unknown, active)`? |
| --- | --- | --- |
| `POST /api/contacts` type=unknown -> default `'active'` (`contacts.ts:881-884`) | **API only** - `KindPicker.tsx:23,128-138` has no `unknown` segment | yes, but no operator can do it |
| `PATCH /api/contacts/:id` status-only (`contacts.ts:1414-1424`, allowlist `['needs_review','active']`) | **YES** - `ContactEditForm.buildPatch` sends `type` ONLY when it changed (`:236`) and `status` for any non-tenant (`:248-250`); the modal opens from the Unknown contact file (`ContactDetail.tsx:1044`) | **yes - this is the one** |
| importer | operator-driven, one-off | `deriveStatus` returns `needs_review` for unknown unconditionally (`import/status.ts:67`); `apply.ts:884-887` honours an explicit `active` typed into the review workbook, so a bulk import could mint many at once |
| auto-advance on re-type (`contacts.ts:1441-1444`) | n/a | `convType` is undefined for `unknown`, so it never fires |

**Drains:** a `type` change to ANY other type, or a soft-delete. Nothing else.
(Note the corrected comment at `inbox.ts:1774` says "Only a type change (to
tenant/landlord/partner) actually drains a row" - incomplete: re-typing to
`team_member` drains it too, and so does deleting. A small inaccuracy in a
freshly-corrected sentence.)

**Growth rate - my honest estimate: slow, but one-way.** The population is
monotonic under the PATCH path: nothing converts `(unknown, active)` back to
`needs_review` except a deliberate re-type, so every "mark reviewed without
typing" gesture is permanent until someone re-types or deletes. But that gesture
competes with two draining gestures the UI foregrounds far more prominently - the
triage type buttons (`ContactDetail.tsx:640`, `updateContact(id, { type })`) and
delete - while the status select is buried in an edit modal behind "Change type".
An operator dismissing spam will almost always delete or retype it.

So: the implementer is RIGHT that the mechanism exists and that zero is a
starting condition; the ceiling is 200; the realistic accrual is a handful per
year unless an operator adopts the status flip as their standard dismiss gesture,
in which case it accrues one per dismissal with no drain at all. **The "live
impact today: none" ruling stands**, and the correct response is the one the
issue already takes - record it and name the reopen trigger - plus N6: cite the
run behind the zero, and re-check the `(unknown, active)` count, not only the
partition size, at the reopen point.

---

# 4. ARE THE FIXES REAL?

Per adjudicated finding (the A1-E3 key is not in the worktree). "Enforced by"
means something fails if the claim stops being true.

| finding | verdict | enforced by |
| --- | --- | --- |
| **HIGH-1 record** (`unknownQueue.ts:106-138`, `inbox.ts:1753-1772`, issue block) | **REAL.** Every "arbitrary"/"index order" claim is gone and replaced with the mechanism, the two failure shapes, the measurement, and why the mitigation was not taken. Accurate as written. | prose only, but see the pin below |
| **HIGH-1 fake sort** (`contactsPartitionFake.ts:12-30,77-87`) | **REAL, with one over-stated rule** - see V1 below. Paging still resumes correctly through it (probe G: 4 rows / 5 pages / correct full-key cursors / no skips or duplicates), and `.filter()` already returns a fresh array so nothing the caller owns is mutated. | its own suite's new rule-6 pin |
| **HIGH-1 pin** (`unknownQueue.test.ts`, "THE CAP STARVES needs_review") | **REAL and it passes for the stated reason.** I traced it: `pageSize 10 > partition 4`, so the walk exhausts in one Query and the cut is the final `slice(0, maxRows)` over a status-ordered `collected` - which is the claim. It would go red if the sort were removed. | itself |
| **MED-2 guard label** (`inbox.ts:1601-1625`) | **REAL.** Says plainly it is unreachable, why the stale-index case does not reach it either, and why it is kept. Accurate. | nothing (a comment), unavoidably |
| **MED-2 log-reader note** (`inbox.ts:958-968`) | **REAL.** No longer points at `unknownQueueRetyped`; correctly redirects to `queueContacts` / `queuePages` and says rejections are now invisible because they never happen. | nothing |
| **MED-2 test honesty** (`inboxUnknownTab.test.ts`, renamed pin) | **REAL** - the test now leads with "reached ONLY through an override, because no real Query can produce one". A reader can no longer mistake it for coverage. | itself |
| **MED-3** (`unknownQueue.ts:27-45`, `inbox.ts:1774-1786`, issue WINDOW bullet) | **REAL**, and correct on the mechanism, the allowlist, and the compounding with HIGH-1. One inaccuracy: "Only a type change (to tenant/landlord/partner)" omits `team_member` and soft-delete. | nothing |
| **MED-4** (`inbox.ts:1532-1541`) | **HALF REAL - see N1.** The corrected number is right; the appended justification is false and forecloses the saving. | nothing; and no test pins the hydration count for this branch |
| **MED-5** (issue, COLLECTOR-truncation residual) | **REAL** and better than filed - it names the different WARN and the different field, and says why a sweep-only reader would miss it. | nothing (it is a record item by ruling) |
| **MED-6 fake-sort half** | **REAL** (see HIGH-1 fake sort). Harness half declined - contested at C3. | - |
| **MED-7** (issue, class (c)) | **REAL.** Says exactly what shipped, names both fix shapes with their blast radius, and corrects the stale `:396-403` line reference in the same breath. | nothing |
| **LOW-8 / LOW-9 / LOW-10** | not fixed by ruling; LOW-9 and LOW-10 contested at C2/C1. | - |

## V1 - the fake's new rule 6 states an AWS guarantee that AWS does not give

`contactsPartitionFake.ts:12-16`:

> The partition is SORTED BY THE RANGE KEY, ascending: `status` first, then the
> table key `contactId` as the tie-break (**DynamoDB orders items sharing a GSI
> range-key value by their table key**).

The first half is documented and correct: a Query returns results ordered by the
sort key, and `listByType` sets no `ScanIndexForward`. The parenthetical is not.
AWS documents that GSI query results are sorted by the sort key value and that a
GSI's index key need not be unique; it does not specify the order among items
that SHARE a sort-key value. The behaviour the rule describes is what the storage
layout produces and what DynamoDB Local does, but it is observed, not contracted.

It also is not needed. HIGH-1 turns entirely on the `status` ordering; the
tie-break only decides order WITHIN a status block. Yet four pins now depend on
it - the `excludeOrigin` LEK (`s2`), the limit-reached LEK (`b`), the cap-cut
`['c-u1','c-u0']`, and the new starvation pin's `['c-unk-003','c-unk-004']`.

This is worth calibrating because the repo already gets it right one file over:
`today.ts:846-852` says only that "intra-partition order is stable and the same
100 rows come back every time" - stable, deliberately not "ascending by
contactId". Rule 6 should carry rules 1-5's confidence for the status half and
that weaker wording for the tie-break, so nobody later builds a production
decision (an ordering guarantee, a cursor scheme) on a fake's assertion.

## V2 - two pins moved; both moved for the stated reason

- `contactsPartitionFake.test.ts` "excludeOrigin filters the PAGE": `'real'` ->
  `'s3-real'`. Correct and honestly explained. Without it the row would have
  sorted FIRST (`'real' < 's1'`) and the assertion `items).toEqual([])` would
  have gone RED, not silently passed - so the rename restores the original
  intent rather than papering over a change of meaning.
- `unknownQueue.test.ts` "one Query when the partition fits a page":
  `['c-unk-001','c-unk-002','c-unk-003']` -> `['c-unk-002','c-unk-001','c-unk-003']`.
  Correct: `c-unk-002` is the `active` row and now sorts first. The rest of that
  test (the narrowing probes, the `UNKNOWN_QUEUE_TYPES` pin, the warn assertion)
  is untouched and still tests what it says.

I audited every other seed reaching `listByTypeFromContacts` for a silent change
of meaning - the residue/page-budget/cap/exact-multiple pins in
`unknownQueue.test.ts` (all single-status, ids already ascending), the cap-cut
and window pins in `inboxUnknownTab.test.ts` (single-status), "THE READ THAT
SHIPS" (`c-del` now sorts ahead of `c-unk` but is filtered as deleted, so every
call count is unchanged), "sorts partition rows and resurfaced rows together"
(reordered in the partition, re-sorted by activity afterwards, same output), the
parity worlds, and `inboxFeed.test.ts` / `inboxGroups.test.ts`. **No pin now
passes for a different reason than before.** All six suites green, 116/116.

---

# VERDICT

The fix wave does what it was chartered to do, and the record corrections are
better than the minimum - the issue's HIGH-1 block in particular is the kind of
entry that stops a rediscovery. It carries one real defect of its own (N1, the
MED-4 justification), one bad WARN string (N2), and one over-confident claim in
the fake's header (V1). Nothing in it changes production behaviour, and nothing
in it is a regression to the code under test.

The two findings I would act on before merge are **N1** and **N2** - both are
single-sentence edits, and both are cases where a corrected artifact now asserts
something false with more confidence than the thing it replaced. **N4** is the
one worth carrying into the handback: the same index sort, unwritten, in the
broadcast audience walk, where the rows it drops first are the tenants a
property send is for.
