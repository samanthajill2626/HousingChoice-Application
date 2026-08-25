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

**The root cause is the divergence this issue already names, now sized.** Only
17 of ~627 open `unknown_1to1` conversations actually need triage - so roughly
610 carry a conversation `type` that says "unknown" while their contact has long
since been typed. The walk is expensive precisely BECAUSE `conv.type` is stale:
it cannot serve as a cheap pre-filter when 90% of the partition wrongly claims
to be unknown.

That reframes the remedy. Two shapes are now worth designing against, and
neither is the one originally filed:

1. **Fix the divergence and let `conv.type` become a usable pre-filter.** Retype
   the conversation when its contact is typed - which `POST /api/contacts`
   already fails to do, one of the three divergence sites named below. This
   fixes a correctness bug and the read cost together, with no new index. It
   needs the invariant maintained in BOTH directions before the pager may trust
   it, and a backfill for the ~610 stale rows.
2. **A correctly-maintained sparse `needs_triage` flag with its own GSI** - the
   same shape as `byUnread`, turning 693 lookups into one Query returning 17
   items. Note the earlier objection to a denormalized hint was that
   `conv.type` is ALREADY that denormalization and is already broken; a new
   attribute maintained by the contact-type write path is a different
   proposition, but it carries the full invariant-enumeration burden.

Part (A) of the earlier remedy (budget + cursor + `truncated`) still bounds the
damage and needs no schema change, but note what it does to the operator with
these numbers: a budget would return a handful of rows and a cursor, making them
page repeatedly through a tab that has 17 rows in it. Bounding an unbounded read
is right; it is not by itself a fix.

---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The unbounded
`filter=unknown` walk still reproduces and the severity rises low -> medium, but
the stale 4-6-calls-per-conversation cost model was rewritten in place, the
sparse-triage-index remedy was disproven against three live `conv.type` /
`needsTriage` divergences, and the suggested fix is now a walk bound plus a ride
on the approved `contactId` denormalization.
