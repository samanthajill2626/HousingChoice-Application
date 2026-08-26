---
id: inbox-filter-tabs-full-walk
title: The Unknown inbox tab walks every open conversation, unbounded, when matches are sparse
type: debt
severity: high
status: open
area: app
created: 2026-08-03
updated: 2026-08-25
refs: app/src/routes/inbox.ts, app/src/lib/tables.ts, app/src/routes/contacts.ts, dashboard/src/routes/inbox/useInbox.ts
---

**Problem.** `filter=unknown` is the ONLY read left on `GET /api/inbox` with no
budget, no cap, and no `truncated` flag. The pager walks the `byLastActivity`
`open` partition in chunks (`app/src/routes/inbox.ts:1474-1528`) and exits only
when the page fills or the stream is exhausted, so when untriaged numbers are
sparse it walks the entire partition. Every sibling filter is bounded: `all`
stops after one page, `groups` pages its own partition through a tagged cursor,
and `unread` reads the sparse `byUnread` index under `UNREAD_WALK_LIMIT`
(`app/src/lib/unreadFeed.ts:46`) and reports `truncated` when it stops early
(`app/src/routes/inbox.ts:147-152`). This one has no ceiling and no way to tell
the client that anything was withheld, which also means it has no forward path
if it ever does get slow enough to time out.

The cost per NON-MATCHING conversation is ONE `contacts.findByPhone` Query - not
the 4-6 calls this issue claimed until 2026-08-25. See the cost-model correction
below before costing any work here. At the 649 open threads recorded for prod in
`app/src/lib/tables.ts:193`, one Unknown page is roughly 22 chunk Queries plus
~649 SERIAL contact Queries: about 671 round trips.

It is also re-issued on every debounced `conversation.updated` while an operator
sits on the tab. `dashboard/src/routes/inbox/useInbox.ts:376` wires
`onConversationUpdated` to a 300ms-debounced refetch of the CURRENT filter's
first page, so any inbound traffic anywhere in the org re-runs the walk, once
per connected dashboard parked on Unknown. Same amplification shape as the
resolved [`inbox-unread-sse-full-walk`](inbox-unread-sse-full-walk.md), narrowed
to one tab a human has to be looking at. Latency only: the tab's answer is
complete and correct, just slow.

**Cost-model correction (2026-08-25) - READ THIS BEFORE COSTING WORK HERE.** The
original body said the pager applies `passesFilter` AFTER fully hydrating each
row (contact lookup, the contact's conversations, latest message, placement
label - "about 4-6 DynamoDB calls per conversation", "roughly 4-6k queries" for
a 1,000-conversation walk). That has been FALSE since `39c1aa41` "fix(inbox):
reject nonmatching rows before hydration" (2026-08-14), which moved the role
check AHEAD of hydration (`app/src/routes/inbox.ts:896-901`):

```
    // A resolved contact's role is enough to reject it from Unknown. Keep this
    // ahead of conversation, message, and placement hydration; only type=unknown
    // contacts can produce a known-contact row for this filter.
    const role = roleFromContact(contact);
    if (filter === 'unknown' && role !== 'unknown') return dropped('unknownFilterRole');
```

It is pinned by `app/test/inboxFeed.test.ts:736-766`, which asserts exactly one
`findByPhone` and ZERO conversation, message, and placement reads for a resolved
non-unknown contact. So the walk is still O(open conversations), but in contact
Queries, not in hydration.

THE TRAP, named so the next reader does not inherit it again: this issue's own
"Update (2026-08-16)" below declared the unknown half "unchanged" TWO DAYS AFTER
that fix landed. It was written from the 2026-08-03 body rather than from the
then-current code, which is how a figure that was already ~1.5 orders of
magnitude too high survived nine more days. Do not re-derive a cost from this
file's prose; re-read the code.

**Disproven remedy (2026-08-25) - do NOT build a sparse triage index.** The
previous suggested fix named "a sparse GSI (or denormalized triage flag on the
conversation)" as the escalation for `unknown`. It would ship a correctness
regression, for two reasons.

First, it is the wrong derivation class, and the repo has already ruled on it.
`unread_flag` works because it is a SAME-ITEM function of `unread_count`, owned
end to end by four repo methods. `needsTriage` is a function of the CONTACT's
`type` - a different item. `app/src/lib/tables.ts:177-179`, the `byUnread`
design note, says so directly:

```
      // The HASH value is the CONSTANT string 'unread' - encoding
      // status/type into it would obligate every lifecycle writer to maintain
      // the attribute; readers filter the projected live status/type instead.
```

Second, that denormalization ALREADY EXISTS as `conversation.type ===
'unknown_1to1'`, and it is already divergent from `needsTriage` (which the inbox
derives from the contact at `app/src/routes/inbox.ts:825`) at three reachable
write sites. Indexing it, or indexing a new attribute fed by the same single
fan-out, ships those divergences as the tab's contents:

1. **Non-primary phone threads are never fanned out.** The only type-flip in the
   codebase is the triage PATCH (`app/src/routes/contacts.ts:1614-1649`), and it
   gathers threads from the SCALAR PRIMARY phone plus every email address
   (`contacts.ts:1615`, `:1627-1631`). It never iterates `contact.phones[]`, so a
   multi-number contact triaged to tenant leaves its secondary threads
   `unknown_1to1` while `needsTriage` is false for all of them.
2. **`POST /api/contacts` retypes nothing.** The create route
   (`app/src/routes/contacts.ts:1016-1080`) creates the contact, audits, writes
   vocabulary, and responds 201 without reading or writing any conversation.
   Creating a tenant record for a number that already has an `unknown_1to1`
   thread - the natural flow from an inbox unknown row, which links to
   `/contacts/unknown?phone=...` (`dashboard/src/routes/inbox/InboxRow.tsx:47`) -
   leaves that thread `unknown_1to1` permanently.
3. **Demotion never flips back.** `conversationTypeFor`
   (`app/src/routes/contacts.ts:457-463`) returns `undefined` for `team_member`
   and `unknown`, so `convType` is undefined (`contacts.ts:1407`) and `flipType`
   is false (`contacts.ts:1641`). But `roleFromContact` maps both to `'unknown'`
   -> `needsTriage: true`. PATCHing a tenant to `team_member` puts the row BACK
   on the Unknown tab while its thread stays `tenant_1to1`.

Sites 1 and 2 would surface rows the tab does not show; site 3 would MISS rows
the tab does show. Note also that `setType` (`conversationsRepo.ts:617`) has zero
callers outside the repo, so site 1's `applyTriage` call really is the only
post-creation type writer in the system - there is no second fan-out to lean on.

**Suggested fix (rewritten 2026-08-25).** Two parts, in order, and neither is a
triage index.

- **(A) Give the `unknown` pager the budget + cursor + `truncated` contract the
  `unread` branch already has.** Cheap, no schema change, and every piece exists:
  the wire field is already declared (`app/src/routes/inbox.ts:147-152`), the
  client already handles it, and the pager already mints an exact mid-chunk
  resume cursor (`inbox.ts:1498-1518`). A walk budget that mints the cursor it
  stopped at and sets `truncated` turns an unbounded read into a bounded,
  resumable, honest one. This does NOT re-create the "a bound makes the badge
  lie" class that
  [`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md)
  rules out for the badge: a count cannot page, a list can, so the tab stays
  complete via Load more. Do this first - it is the part that stops the cost
  growing without a ceiling.
- **(B) Fold the contact lookups into the approved `contactId` denormalization.**
  The per-conversation `findByPhone` is the actual cost (~649 of the ~671 round
  trips), and the schema change that kills it is already approved for
  [`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md):
  stamp `contactId` onto the conversation item and BatchGet the contacts. Applied
  here it collapses this tab's per-conversation Queries into roughly one BatchGet
  per 30-row chunk, and it carries NO derived-state fan-out - `contactId` is a
  stable identity fact, not a triage state that must be recomputed on every type
  change. This tab rides that change rather than needing its own.

Step B does not bound the WALK, only the lookups, which is why step A is still
worth doing and should land first.

**Update (2026-08-16) - HALF of this is fixed; the issue STAYS OPEN for the
other half.**

- **UNREAD: RESOLVED.** The inbox-unread-index feature
  (`docs/superpowers/specs/2026-08-16-inbox-unread-index-design.md`, branch
  `feat/inbox-unread-index`) took the escalation rather than the cheap
  pre-filter: `filter=unread` no longer walks `byLastActivity` at all. It reads
  the new sparse `byUnread` GSI, so the tab hydrates only rows that are actually
  unread. Same read model backs the nav badge and Today's unread sections.
- **UNKNOWN: RESOLVED 2026-08-25 by the contact-side read.** `filter=unknown` no
  longer walks `byLastActivity` and no longer resolves a contact per open
  conversation. It reads the `(type='unknown')` contacts `byTypeStatus`
  partition - the repo's own "human triage queue" - through the collector in
  `app/src/lib/unknownQueue.ts` (branch `feat/inbox-unread-cluster`, design
  [`2026-08-25-inbox-unknown-tab-walk-design.md`](../superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md)):
  a bounded fill loop (`UNKNOWN_QUEUE_MAX_PAGES` 10 x `UNKNOWN_QUEUE_PAGE_SIZE`
  100), a hard result cap (`UNKNOWN_QUEUE_MAX_ROWS` 200), a truncation WARN, and
  deleted-contact resurfacing through ONE budget-bounded `byUnread` sweep whose
  two stop flags - `capped` and `truncated` - are BOTH floor signals (`capped`
  masks `truncated` in `CollectResult`, so reading either one alone
  under-reports). The read applies NO `status` narrowing and NO `excludeOrigin`
  (spec section 3, classes f and a). This issue still tracks the unknown tab:
  what the branch deliberately did NOT close is in the RESOLVED block at the end
  of this file.
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

**MEASURED 2026-08-25 on both deployed environments. It is worse than filed,
and `medium` -> `high`.** One Unknown-tab page render, replicating the pager
exactly (`--audit-unknown-page` on
`app/scripts/measure-unread-contact-coverage.ts`):

| env | scanned | contact lookups PAID | matching rows (UPPER BOUND) | outcome |
| --- | --- | --- | --- | --- |
| dev | 637 | 636 | 12 | partition EXHAUSTED before filling |
| prod | 693 | 684 | 8 | partition EXHAUSTED before filling |

**RE-MEASURED 2026-08-25 after the instrument was corrected.** The first numbers
published here (13 and 17 matching rows) came from a version that did not
replicate the pager - it counted relay groups as matches, used the wrong
resolver and chunk size, and counted per conversation rather than per contact.
The COST figure survived that correction; the match counts did not, and they are
an upper bound even now.

**The partition is exhausted on EVERY render.** The unbounded walk is not a
worst case reached by unlucky data - it is the steady state, and `useInbox`
re-issues it on every debounced `conversation.updated` while an operator sits on
the tab.

**Drift audit, same day (`--audit-denorm`), which sized the fix and shrank it:**

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| thread type stale "unknown" | 621 | 619 |
| thread claims resolved but contact is `unknown` | 0 | 0 |
| display name missing though contact has one | 592 | 579 |

Three things follow, and two of them REMOVE work:

- The stale-`unknown` count confirms the ~610 figure derived independently from
  the walk measurement. A `type`-only backfill is real work.
- **The name denormalization is LATENT.** Nothing renders
  `participant_display_name` - the inbox row's name comes from the hydrated
  CONTACT. So ~580 missing names cost nothing today and are OUT of scope. Do not
  "tidy" them into sync; that would buy invariant surface with no reader.
- **Zero rows have a thread claiming a resolved identity while the contact is
  `unknown` or `team_member`.** So a `conv.type` pre-filter would not hide a
  single row that appears today, and the demotion hole - reachable, verified
  through the API - is a FORWARD guard rather than a repair.

**The cost inverts with triage quality, which is why nobody would predict it.**
The pager breaks when the page FILLS, so a backlogged tab is cheap (30 rows, 30
lookups) and a CLEARED tab is expensive (scan everything, find almost nothing).
Good triage discipline makes this read worse. The planner predicted "cheap,
probably ~30 lookups" from the fact that 627 of 693 open rows are typed
`unknown_1to1`, and the measurement refuted it outright.

**The walk is expensive because it must hydrate a contact per conversation to
decide anything.** `needsTriage` is `roleFromContact(contact) === 'unknown'` - a
fact that lives on the CONTACT, not the thread - so the pager resolves a contact
for every open row and discards almost all of them. At most 8 rows survive in
prod, out of 684 lookups.

**BOTH remedies previously proposed here are WITHDRAWN.** They are recorded
because someone will otherwise re-propose them:

1. ~~Retype conversations so `conv.type` becomes a usable pre-filter.~~
   WITHDRAWN. `today.ts:779` already branches on `conv.type`, so the backfill it
   needs is an operator-visible product change, not a repair. It also makes a
   denormalization load-bearing for what an operator sees, where a skipped row
   fails SILENTLY, and it optimises the constant on a partition that never
   shrinks - nothing closes a 1:1 thread.
2. ~~A sparse `needs_triage` flag with its own GSI.~~ WITHDRAWN as unnecessary,
   not as unsound: it would add an attribute and an index to reproduce a
   partition the CONTACTS table already has.

**A latent bug this work uncovered, recorded here so it does not ride only on a
design doc.** `roleFromContact` (`inbox.ts:396-403`) returns `'unknown'` for any
contact type that is not tenant, landlord or partner - so `team_member` falls
through, `needsTriage` is true, and an INTERNAL STAFF member's 1:1 thread sits
in the operator's triage queue. `team_member` is the internal-staff bucket
(`lib/seed/lean.ts:158`: "excluded from audience fan-out, no 1:1 lifecycle");
outside people who are neither tenants nor landlords are `partner`.

The founder ruled 2026-08-25 that team members do not belong in a triage queue.
Measured at ZERO rows in dev and prod, so there is nothing to clean up - but the
mechanism is live. The contact-side redesign fixes it by construction, because
`listByType('unknown')` cannot return a `team_member`. If that design does not
land, this stays broken and wants its own one-line fix.

**The current design reads the triage queue directly** - the contacts
`byTypeStatus` partition, which the repo already documents as "the human triage
queue". Measured at 7 rows in ONE Query in prod against 684 lookups across 24
Queries today. See
[`2026-08-25-inbox-unknown-tab-walk-design.md`](../superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md);
it is on draft 3 and carries the five coverage classes that switch entails.

The budget + cursor + `truncated` bound still belongs on the existing pager as a
safety net - an unbounded read should not exist even when it is cheap - but with
a queue of 8 rows it would page an operator through almost nothing, so it is not
a fix by itself.

---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The unbounded
`filter=unknown` walk still reproduces and the severity rises low -> medium, but
the stale 4-6-calls-per-conversation cost model was rewritten in place, the
sparse-triage-index remedy was disproven against three live `conv.type` /
`needsTriage` divergences, and the suggested fix is now a walk bound plus a ride
on the approved `contactId` denormalization.

---

**RESOLVED 2026-08-25 - the rulings, the remainder, and one deferral.** Branch
`feat/inbox-unread-cluster`, design
[`2026-08-25-inbox-unknown-tab-walk-design.md`](../superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md).
The unbounded walk is gone (see the UNKNOWN bullet above). Everything below is
recorded HERE, in the registry, so that none of it rides only on a design doc.

**The class (c) ruling: internal staff are not triage - enforced for TAB
MEMBERSHIP ONLY.** A `team_member` contact no longer appears on the Unknown tab.
`roleFromContact` falls every type that is not tenant / landlord / partner
through to `'unknown'`, which put colleagues in the operator's triage queue -
the latent bug recorded above. It was RULED 2026-08-25 that team members do not
belong there, and the contact-side read excludes them from the QUEUE by
construction: it queries the CONTACTS partition, and `listByType('unknown')`
cannot return a `team_member`.

**What shipped is narrower than "the mechanism is closed", and this block used
to imply otherwise (corrected 2026-08-25, adversarial MED-7).**
`roleFromContact` (`app/src/routes/inbox.ts:422-429` - an earlier note in this
file cited `:396-403`, which is stale) is UNTOUCHED. It still falls
`team_member` through to `'unknown'`, so on the **All** and **Unread** tabs a
team member's 1:1 row still ships `role: 'unknown'` and `needsTriage: true`
(`inbox.ts:873`) and the dashboard still renders the "Needs triage" chip on it
(`dashboard/src/routes/inbox/InboxRow.tsx`). The "one-line fix" this file said
would be needed "if that design does not land" is therefore STILL NEEDED for the
labelling half; only the queue half is closed.

Widening `roleFromContact` was deliberately NOT done on this branch: it is a
WIRE change (the `role` union reaches `dashboard/src/api/types.ts`) with its own
blast radius across every tab, and it wants its own change. The alternative
shape, if someone prefers the smaller one, is to narrow `needsTriage` to
`contact.type === 'unknown'` and leave `role` alone. Impact today is ZERO rows
in both environments (measured), so this is a half-fixed mechanism and a
record-accuracy item, not a live defect.

The queue-side decision is enforced
rather than decorative - `UNKNOWN_TAB_TYPE_DECISIONS` in
`app/src/lib/unknownQueue.ts` is the table of per-type rulings, and the list of
types actually queried is DERIVED from it, so a future type cannot be added to
one without an answer in the other. One clause for whoever next touches contact
writes: `contactsRepo.update`'s documented `null -> REMOVE` convention makes
`update(id, { status: null })` a legal, index-dropping write that would silently
drop a contact out of the sparse `byTypeStatus` partition and off this tab; no
caller nulls status today, so this is not a shipping defect - but "no caller
does it" is the accurate wording, not "impossible".

**The deliberate remainder: TWO different cuts, and neither has a Load-more.**
They are separate claims and must not be collapsed into one:

- **The WINDOW cut** - rows past the request `limit` (the dashboard sends 30).
  These are WARNed ("the unknown tab could not show every triage row - the queue
  is a floor") and they become reachable as rows are RE-TYPED away, because the
  assembled rows are sorted newest displayed activity first, so the cut is at
  the OLD end. **RE-TYPED, not merely triaged** (corrected 2026-08-25,
  adversarial MED-3): this bullet used to say "as triage drains the queue", and
  a STATUS-ONLY triage does not drain it. `PATCH /api/contacts/:id` supports
  `'status' in patch && !('type' in patch)`, re-validated against
  `statusAllowlistFor(stored.type)` - `['needs_review','active']` for `unknown`
  - and the dashboard's contact edit form reaches it. An operator can therefore
  mark an unknown contact `active` while it stays `type='unknown'`; it leaves
  Today's triage block (which DOES narrow on `needs_review`) but it never leaves
  this queue. Only a type change drains a row.
- **The COLLECTOR cap** - `UNKNOWN_QUEUE_MAX_ROWS` (200), plus the page budget
  (10 x 100). This one cuts in **status-ascending order, and it starves
  `needs_review`** - see the named reopen point below. It is NOT
  "recency-arbitrary", which is what this bullet said before 2026-08-25. Also
  WARNed. Do not read the window cut's newest-first reasoning onto this one.

Neither cut has a Load-more affordance: the branch mints no cursor and returns
`nextCursor: null` (an offset page over a mutating in-memory sort re-serves and
skips rows). Contactless conversations - class (e), measured at ZERO rows in dev
and prod - surface on the All tab only.

**The sweep's ceiling and crossover, so a future reader comparing "684 before"
finds the after-number.** The deleted-contact resurfacing sweep is
O(visible unread): one contact read per visible unread index item, hard-capped
at `UNREAD_WALK_LIMIT` (2000, `app/src/lib/unreadFeed.ts:46`) raw items per
Unknown page load. So past roughly 700 visible unread threads - the size of the
open partition whose ~684-lookup walk this design removed - the tab costs MORE
contact reads than the read it replaced, worst case about 3x. That trade was
taken deliberately: unread DRAINS with triage, while the open partition only
ever grows, so the new bound rides a self-limiting quantity and the old one did
not. Signals if the assumption breaks: the UNCONDITIONAL `sweepScanned` field on
the `inbox feed assembled` log line (every request, not just past a tripwire),
and the shared 500-item scan tripwire (`UNREAD_WALK_WARN`).

**The capped-sweep residual, forced JOINTLY by approved requirements 2 and 5 and
not fixable here.** A sweep that stops early can leave the tab rendering the
ordinary "No unknown numbers" empty state over a knowingly incomplete answer.
The wire must NOT carry `truncated` on this filter - requirement 5 - because the
dashboard's failure gate is not filter-aware (`serverEndedEarlyEmpty =
serverRowCount === 0 && truncated`, `dashboard/src/routes/inbox/Inbox.tsx:42`,
banner at `:183`), so an empty page carrying the flag would render "We couldn't
load your inbox." over a normal, cleared queue. The floor WARN
("the unknown-tab resurfacing sweep stopped early - the deleted-row set is a
floor") and the `resurfaceCapped` / `resurfaceTruncated` log fields are
therefore the ONLY signals that it happened. **Reopen this issue here** if any
of these three trades goes wrong: a silent incomplete empty state an operator
actually hits, a cap cut that hides new inbound, or a sweep crossover that shows
up in `sweepScanned`.

**The COLLECTOR-truncation residual - the SAME shape as the capped-sweep one,
and likelier** (added 2026-08-25, adversarial MED-5; the block above recorded
only the sweep half). `collectUnknownTriageQueue` can legitimately return
`{ contacts: [], truncated: true }`: the page budget expires while every page it
read was residue. On that result the branch assembles ZERO rows and - by the
same approved requirement 5 - must NOT set the wire `truncated`, so the
dashboard renders the ordinary "No unknown numbers" empty state over a triage
queue that has rows in it. The only signals are the collector's own WARN ("the
unknown-queue walk ended with untriaged contacts still behind it") and the
`queueTruncated` field on the `inbox feed assembled` line - a DIFFERENT WARN and
a DIFFERENT field from the sweep's, so a reader who only knows about the sweep
residual will not think to look. It is the likelier of the two because this
module's own header argues that soft-deleted unknowns "accumulate in this
partition FOREVER", and because of the ordering defect below the `active` block
can consume the whole budget on its own. Same reopen trigger as the sweep
residual.

**NAMED REOPEN POINT: the cap starves `needs_review`** (found 2026-08-25 by
adversarial review, HIGH-1; recorded here rather than fixed, by ruling).

`byTypeStatus` is `(hash: type, range: status)` and `contactsRepo.listByType`
sets **no `ScanIndexForward`**, so the Query returns the partition ASCENDING by
`status`. Within `type='unknown'` the only legal statuses are `needs_review` and
`active` (`NON_TENANT_STATUSES`), and `'active' < 'needs_review'`
lexicographically. **Every `active` unknown is therefore returned before any
`needs_review` one.** So `UNKNOWN_QUEUE_MAX_ROWS` and the page budget do not cut
a recency-arbitrary slice - they cut STATUS-FIRST and deterministically, keeping
rows somebody already reviewed and discarding the ones nobody has looked at. The
order is stable, so the same rows are hidden on every render.

It COMPOUNDS with the status-only-triage fact recorded on the WINDOW cut above:
a status-only triage moves a row into the `active` block, which is the block the
Query returns FIRST - so half-triaged rows are promoted to the front of the read
and crowd out untriaged ones.

Failure shapes to watch for:

- 200+ live `(unknown, active)` contacts with an open thread: the cap fills
  entirely from the `active` block and NO `needs_review` contact can appear on
  the tab at all.
- 1000+ rows of `(unknown, active)` or soft-deleted residue ahead of the
  `needs_review` block: the page budget expires before a single `needs_review`
  row is read, and the tab renders the empty state (the collector-truncation
  residual above) with only a server WARN behind it.

**Live impact today: none.** Measured 2026-08-25: 16 unknown contacts in dev, 7
in prod, with ZERO `(unknown, active)` in either - two orders of magnitude from
the cap. This is a latent-behaviour and design-record item.

**THE MITIGATION, and why it was NOT taken on this branch.** Pass
`ScanIndexForward: false` on the `listByType` Query (or add it as an option and
have the unknown queue opt in), which would reverse the partition and put
`needs_review` first. It was not done here because `listByType` is a **shared
read** - `today.ts`'s triage block, `GET /api/contacts?type=`, and the importer
all use it - so changing its direction, even behind an option, is a repo-wide
change with its own review, and the spec that governs this branch is
human-gated. It is the human's call. Two alternatives if the option is
unattractive: query the two statuses explicitly and interleave
(`needs_review` first, two bounded Queries), or make the cut status-aware rather
than positional.

The fact is PINNED so it cannot be quietly rediscovered or contradicted:
`app/test/unknownQueue.test.ts` ("THE CAP STARVES needs_review") drives the real
collector over a mixed-status partition and asserts the `needs_review` rows are
the ones cut, and `app/test/helpers/contactsPartitionFake.ts` rule 6 models the
range-key sort that makes it expressible at all (its absence is why no test
could catch this before). **Reopen here** if a deployment's unknown partition
approaches either bound, or the moment anyone wants `(unknown, active)` rows to
stop crowding the queue.

**DEFERRED, not dropped (human ruling 2026-08-25): spec section 5's
open-partition safety net.** A raw-scan budget plus cursor plus `truncated`
contract for the `filter=all` pager was NOT built on this branch. The reason is
that section 5 ships its own named gate unsolved: a budget-stopped ZERO-ROW
`filter=all` page carrying `truncated` lights the same non-filter-gated failure
gate above (`Inbox.tsx:42` / `:183`) on an org where nothing failed, and the
spec says that must be solved FIRST. Two traps found in plan review, for whoever
picks it up:

1. The empty-page invariant NULLS the cursor, so "Load more" cannot be the
   affordance in exactly the state that needs one.
2. Replacing the pager loop's tail orphans the `moreChunks` binding
   (`app/src/routes/inbox.ts:1799` post-flip; its ONLY reader is the loop's tail
   at `:1840`), which is a gate-5 `no-unused-vars` error unless the binding is
   deleted along with the tail.

The unbounded read this issue was filed for is gone from `filter=unknown`; the
safety net is about `filter=all`, and it is still owed.
