---
id: inbox-filter-tabs-full-walk
title: The Unknown inbox tab walks every open conversation, unbounded, when matches are sparse
type: debt
severity: high
status: open
area: app
created: 2026-08-03
updated: 2026-08-26
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
  and - since the 2026-08-26 rework - PAGED: one bounded Query per status BLOCK
  (`UNKNOWN_QUEUE_BLOCKS`, `needs_review` first), rolling block to block, with
  the index's own cursor on the wire and a per-request SCAN BUDGET
  (`UNKNOWN_QUEUE_SCAN_BUDGET`, 1000 raw rows) in place of the original bounded
  fill loop (10 x 100), hard result cap (200) and truncation WARN. The read
  applies NO `excludeOrigin` (spec section 3, class a) and every legal status is
  a block, so class f is covered too; since the 2026-08-26 ruling below there is
  NO `byUnread` sweep either - the block Queries are the branch's only read.
  This issue still tracks the unknown tab:
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

**BOTH CUTS ARE GONE - the tab is PAGED and UNBOUNDED (human ruling
2026-08-26).** This section used to describe two deliberate cuts with no
Load-more affordance: a WINDOW cut at the request `limit`, and the COLLECTOR cap
(`UNKNOWN_QUEUE_MAX_ROWS`, 200, plus a 10 x 100 page budget) that cut in
status-ascending order and starved `needs_review`. Both were deleted with the
sort that forced them.

The ruling: **drop the global activity sort and page in QUEUE ORDER instead -
untriaged block first, then reviewed** - using the index's own cursor. The read
issues one bounded Query per status BLOCK (`UNKNOWN_QUEUE_BLOCKS`), rolls to the
next block when one exhausts, and mints a `{q,b,k}` cursor from the last row it
served; `nextCursor` is null only when every block is exhausted. `hasMore` in
`useInbox` is `cursor !== null`, so Load more lights up with no dashboard
change. A per-request SCAN BUDGET (1000 raw index rows) bounds the cost of
walking soft-deleted residue and returns a SHORT page WITH its cursor rather
than truncating - the wire `truncated` flag is still never set here, because it
renders the dashboard's failure banner and this feed has nothing to fail about.

What that trades away, stated plainly rather than buried: the sort is now
PER PAGE, so the total order across pages is queue order, not activity order.
Page 2 can carry a row newer than anything on page 1. Recency is what the All
and Unread tabs are for; global newest-first comes back if
[`denormalize-contact-last-activity-for-ordered-paging`](denormalize-contact-last-activity-for-ordered-paging.md)
is ever built, and `UNKNOWN_QUEUE_BLOCKS` is the single thing it would replace.

The STATUS-ONLY triage PATCH is still real and still relevant, just no longer
harmful here (corrected 2026-08-25, adversarial MED-3):
`PATCH /api/contacts/:id` supports `'status' in patch && !('type' in patch)`,
re-validated against `statusAllowlistFor(stored.type)` -
`['needs_review','active']` for `unknown` - and the dashboard's contact edit form
reaches it. An operator can mark an unknown contact `active` while it stays
`type='unknown'`; it leaves Today's triage block (which DOES narrow on
`needs_review`) but it never leaves this queue. Only a type change or a
soft-delete drains a row. Under the old reader those rows sorted FIRST and
crowded out the front door; under this one they are simply the second block.

Contactless conversations - class (e), measured at ZERO rows in dev and prod -
surface on the All tab only.

**CLASS (d) RESOLVES ON THE ALL AND UNREAD TABS, NOT HERE - human ruling
2026-08-26, and the resurfacing sweep is DELETED.** A soft-deleted unknown
contact who texts back no longer reappears on the Unknown tab.

The product requirement is that the CONVERSATION resurfaces in the inbox, not
that the deleted CONTACT re-enters the triage queue - and both halves of that
already hold with no sweep, verified rather than assumed:

- the `filter=all` pager resurfaces the row through `buildContactRow`'s
  resurfacing predicate (untouched by this branch), and the Unread tab gets the
  same predicate through the unread walk; and
- `GET /api/contacts/:contactId` does NOT 404 a soft-deleted contact (it 404s a
  missing contact or a phone-pointer record), so clicking the row opens the
  contact page normally.

**The durable reason is the product one, not the cost one.** A contact you
deliberately deleted is one you have ALREADY TRIAGED - you decided it was spam.
Putting it back into the queue of "people I have not identified yet" is the
wrong behaviour. The message still needs attention, which is what All and Unread
are for.

The cost that went with it: one `collectUnreadRows` walk over `byUnread` per
Unknown page load, up to `UNREAD_WALK_LIMIT` (2000) raw index items with one
contact lookup per visible item, re-paid on every debounced refetch.

**How many rows it was actually buying, stated precisely** (corrected
2026-08-26; the earlier wording here said "both environments measured ZERO
soft-deleted unknown contacts", which conflates two different quantities and
sits in plain contradiction with the spec's own "prod 4"). Prod has **4**
soft-deleted unknown contacts with an open thread. But RESURFACING additionally
requires an unread post-deletion INBOUND, and prod carries **one** unread
conversation in total (dev: zero) - so the sweep was buying **at most one row,
probably none**.

That is the honest number, and the ruling does not rest on it either way: the
sweep was deleted because of WHERE the row belongs - the conversation surfaces
on All and Unread, and a contact you deliberately deleted is one you have
already triaged - not because the count was small.

**Three passages that stood here are DELETED, not merely superseded**, because
they describe code that no longer exists: the sweep's ceiling-and-crossover
note, the argument for why the sweep was paid even at a measured population of
zero, and the capped-sweep residual (its floor WARN "the unknown-tab resurfacing
sweep stopped early" and the `resurfaceCapped` / `resurfaceTruncated` /
`sweepScanned` log fields are all gone - an old log query for them returns
nothing rather than zeroes). The COLLECTOR-truncation residual below is a
different mechanism and still stands.

**The "~700 crossover" figure is retracted, and not merely because it is now
moot.** It claimed the tab began costing more contact reads than the ~684-lookup
walk it replaced past roughly 700 visible unread threads. It was wrong ON ITS
OWN TERMS: it priced one page LOAD against one walk, while
`dashboard/src/routes/inbox/useInbox.ts` refetches the current filter's first
page on every debounced `conversation.updated`, so the sweep was re-paid per
INBOUND MESSAGE, not per navigation - the same amplification this issue's own
opening section documents for the original walk. Do not resurrect the number in
a corrected form; there is no sweep left to price.

**Reopen this issue here** if the remaining trade goes wrong: an empty state an
operator hits that is not actually the end of the queue.

**The BUDGET-STOPPED EMPTY PAGE - what the collector-truncation residual became**
(added 2026-08-25 as adversarial MED-5; rewritten 2026-08-26 when the cap and
the page budget were replaced by a scan budget). A request whose scan budget
expires while every page it read was soft-deleted residue assembles ZERO rows.
It still does NOT set the wire `truncated` (that flag renders the dashboard's
failure banner, and this tab's normal state is an empty queue) - but it is no
longer silent OR incomplete: the response carries the CURSOR the request stopped
at, so the dashboard shows its ordinary empty state PLUS a live Load more, and
continuing reaches the rows behind the residue. `budgetStopped` on the
`inbox feed assembled` line names it for an operator. The remaining oddity is
cosmetic - "nothing here" next to a Load more button - and it is the honest
rendering. **Reopen here** if that shape is confusing enough in practice to want
a dedicated affordance.

**CLOSED 2026-08-26: the cap starves `needs_review`** (found 2026-08-25 by
adversarial review, HIGH-1; recorded here rather than fixed at the time, then
fixed by the block rework - see
[`unknown-queue-cap-starves-needs-review`](unknown-queue-cap-starves-needs-review.md),
now `resolved`). The mechanism below is still true OF THE INDEX; what is gone is
the cap that turned it into starvation. The blocks are now read
untriaged-first, and the untriaged block is exhausted before the reviewed one is
queried.

> **TRACKED SEPARATELY, and that file is the authority:**
> [`unknown-queue-cap-starves-needs-review`](unknown-queue-cap-starves-needs-review.md)
> (filed 2026-08-26). It carries the frontmatter, the severity and the reopen
> triggers, so it shows up in triage; this section stays because the decision
> only makes sense beside the coverage-class record it belongs to. If the two
> ever disagree, the standalone issue wins.

`byTypeStatus` is `(hash: type, range: status)` and `contactsRepo.listByType`
sets **no `ScanIndexForward`**, so an UN-NARROWED Query returns the partition
ASCENDING by `status`. Within `type='unknown'` the only legal statuses are
`needs_review` and `active` (`NON_TENANT_STATUSES`), and
`'active' < 'needs_review'` lexicographically. **Every `active` unknown is
therefore returned before any `needs_review` one.** So the cap and the page
budget did not cut a recency-arbitrary slice - they cut STATUS-FIRST and
deterministically, keeping rows somebody already reviewed and discarding the
ones nobody has looked at. The order is stable, so the same rows were hidden on
every render. (Fixed 2026-08-26: the reader no longer issues an un-narrowed
Query at all. It queries `status='needs_review'` to exhaustion, THEN
`status='active'`, so the ascending range key never decides what an operator
sees.)

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

**Live impact today: none.** Measured 2026-08-25 with
`--audit-triage-partition --no-status-narrow` on
`app/scripts/measure-unread-contact-coverage.ts`: 16 unknown contacts in dev, 7
in prod, with ZERO `(unknown, active)` in either - two orders of magnitude from
the cap. This is a latent-behaviour and design-record item.

**The flag is not a footnote, it is what makes the zero mean anything** (added
2026-08-26, round-2 finding N6). `--audit-triage-partition` WITHOUT
`--no-status-narrow` queries `status: 'needs_review'`, so it reports zero
`active` rows in every possible world, including one full of them. The
`(unknown, active)` count is the single figure that makes this reopen point
LATENT rather than LIVE, and it is the one figure a narrowed run structurally
cannot produce - which is why this file records the flag alongside the number.
Same discipline this file already states above: "every figure published before
this flag existed priced the narrowed shape".

**THE MITIGATION, and why it was NOT taken on this branch.** Pass
`ScanIndexForward: false` on the `listByType` Query (or add it as an option and
have the unknown queue opt in), which would reverse the partition and put
`needs_review` first. It was not done here because `listByType` is a **shared
read** - `today.ts`'s triage block, `GET /api/contacts?type=`, the importer, and
**`app/src/services/audienceResolution.ts`** all use it - so changing its
direction, even behind an option, is a repo-wide change with its own review, and
the spec that governs this branch is human-gated. It is the human's call. Two
alternatives if the option is
unattractive: query the two statuses explicitly and interleave
(`needs_review` first, two bounded Queries), or make the cut status-aware rather
than positional.

**THE FIX, taken 2026-08-26:** alternative 2 from the list above - query the
statuses explicitly, untriaged block first. `listByType` was NOT reversed, so
the shared-read objection never had to be answered and the sibling caller below
is untouched. The pins moved with it:
`app/test/unknownQueue.test.ts` ("the UNTRIAGED block is exhausted BEFORE the
reviewed block is read") asserts the ordering structurally,
`app/test/inboxUnknownTab.test.ts` ("THE FULL WALK") asserts the union of all
pages is the whole queue, and `app/test/inbox.integration.test.ts` walks the
real index across the block boundary. The old pin ("THE CAP STARVES
needs_review") is deleted - it asserted the defect as a fact.
`app/test/helpers/contactsPartitionFake.ts` rule 6 still models the range-key
sort; without it none of this was expressible.

There is no bound left to compare a partition size against, so the old two-number
reopen check retires with the cap. The `--audit-triage-partition
--no-status-narrow` breakdown is still the way to see the partition's shape, and
the `(unknown, active)` count is still the number that says whether the reviewed
block is growing - it just no longer threatens anything.

**THE SAME UNSTATED SORT LIVES IN THE BROADCAST AUDIENCE WALK**, filed
separately as
[`broadcast-audience-truncation-drops-searching-tenants`](broadcast-audience-truncation-drops-searching-tenants.md)
(2026-08-26, round-2 finding N4). `app/src/services/audienceResolution.ts`
bound-walks the same `byTypeStatus` index for `type='tenant'`, where ascending
`TENANT_STATUSES` starts at `inactive` and ends at `searching` - so a truncated
audience keeps inactive tenants and drops `searching` ones first. Latent today
(10,000 bound vs ~641 tenants). It is named here because it is the SECOND caller
that has to be considered if the `ScanIndexForward: false` mitigation above is
taken, and because the flip helps the two callers in opposite senses.

**CLOSED 2026-08-26 (was: DEFERRED, round-2 finding N1): the unknown tab
hydrated up to the CAP to render one WINDOW.** `buildContactRow` used to run
inside the collection loop while the window `slice(0, limit)` happened AFTER the
sort, so a cap-full queue paid hydration for up to 200 rows to render the
dashboard's 30 - roughly 340 discarded serial round trips per request.

The analysis was that only PART of that hydration had to precede the sort: the
sort key is `row.lastActivityAt`, copied verbatim from
`maxConv.last_activity_at`, a CONVERSATION field produced by the thread
resolution, while `latestMessageOf` (channel / direction / preview) and
`placementLabel` are PRESENTATION ONLY. That is what the block rework took.
There is no window now, so the branch resolves threads for the rows it CONSUMES
and hydrates exactly the rows it RETURNS. Pinned by
`app/test/inboxUnknownTab.test.ts` ("THE COST IS THE PAGE, NOT THE PARTITION"),
which is the hydration-count pin whose absence was the stated reason for
deferring.

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
