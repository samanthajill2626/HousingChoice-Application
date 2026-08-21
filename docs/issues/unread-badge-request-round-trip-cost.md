---
id: unread-badge-request-round-trip-cost
title: The unread badge request still costs hundreds of round trips - two contributors, and the obvious remedy for one is not buildable
type: debt
severity: high
status: open
area: app/inbox
created: 2026-08-21
refs: app/src/lib/unreadFeed.ts:534, app/src/lib/unreadFeed.ts:568, app/src/routes/inbox.ts, app/src/repos/contactsRepo.ts:778, app/src/repos/contactsRepo.ts:807
---

**Problem.** `GET /api/inbox/unread-count` is the app's highest-frequency
authed request: once per SPA boot plus once per debounced `conversation.updated`,
per connected dashboard. The `feat/inbox-unread-index` feature (merged
2026-08-17) made the WALK proportional to actual unread rows - it closed
[`inbox-unread-sse-full-walk`](inbox-unread-sse-full-walk.md) and removed the
O(open conversations) scan. It did not make the request cheap. Two separate
amplifications remain inside the walk, and they multiply the same request.

This issue exists because they were filed apart, are in the same function, and
cannot sensibly be fixed apart: remedying either one alone still leaves a badge
request issuing hundreds of round trips, which would let us declare the badge
fixed while it is still slow.

**Contributor 1 - one contact lookup per 1:1 index item walked.**
`collectUnreadRows` calls `contacts.findByPhone(item.participant_phone)` and
falls back to `contacts.findByEmail(item.participant_email)` for every 1:1 item
it SCANS, not every row it returns (unreadFeed.ts:534). A capped badge request
costs ~100 contact Queries; inside a "residue wall" of hidden deleted-contact
index rows it reaches the `UNREAD_WALK_LIMIT` ceiling of ~2,000. The reviewer
measured 2,046 serial round trips - 2,000 of them `findByPhone` - for a badge
that answers ZERO, because a hidden deleted-contact thread passes
`isUnreadVisible` and the contact lookup is exactly how the collector discovers
that it is hidden.

Two remedies are already ruled out, and should not be re-litigated:

- A per-collect memo keyed on the participant key was implemented and REMOVED
  (review fix wave 2, adversarial r2 finding 3). The claim arbiters
  (`phone#<E164>` / `claimEmail`) guarantee at most one OPEN conversation per
  participant key, and `isUnreadVisible` requires `status === 'open'` for the
  1:1 bucket, so the memo can never hit. It hit zero times in production shapes.
- Bounding contact resolution re-creates the walk-stop class that round 2
  blocked: any bound past which live rows go uncounted makes the badge lie.
  Stop-the-walk hid live work; stop-the-lookups leaked deleted rows.

**And BatchGet - the remedy the old issue prescribed - is not buildable here.**
`findByPhone` / `findByEmail` are Queries against the `byPhone` / `byEmail`
GSIs (contactsRepo.ts:778, :807; both GSIs are hash-only on `phone` / `email`,
see infra/envs/*/tables.auto.tfvars.json). **BatchGetItem cannot read a GSI** -
`KeysAndAttributes` has no `IndexName`, batch reads address base-table primary
keys only. And the conversation item carries `participant_phone` /
`participant_email` with no `contactId`, so there is no base-table key to batch
with. The two real options:

1. **Parallelize** the per-item Queries with bounded concurrency. No schema
   change, real latency win - but the round-trip COUNT is unchanged, and round
   trips are the actual cost driver here. This is a latency fix, and calling it
   a read-amplification fix would be dishonest.
2. **Denormalize `contactId` onto the conversation item** at claim time, then
   `contacts.getManyByIds` (see
   [`contacts-batchget-amplified-reads`](contacts-batchget-amplified-reads.md))
   collapses ~100 Queries into ~1 BatchGet. This is the real fix and it is a
   schema change: a new write-path invariant (who stamps it, and what happens on
   contact merge, soft-delete, restore, and reassignment - the pointer-aware
   `phone_ref -> phone_ref_owner` hop means one conversation's phone can resolve
   to a different owner over time) plus a backfill of every existing
   conversation, plus a read path that tolerates un-backfilled rows.

Option 2 needs a spec. That is the decision this issue is asking for.

**Contributor 2 - the fill loop re-queries the index per collect.** Tracked in
full at
[`unread-fill-loop-query-amplification`](unread-fill-loop-query-amplification.md)
(med, open) and summarized here because it shares the request. Each iteration of
the fill-or-exhaust loop builds a NEW `collectUnreadRows`, hence a new iterator,
hence a new `queryUnreadPage` from `scanPosition`, whose internal page size
ignores `maxRows` - so a collect that will consume ONE item still fetches up to
100. Measured: `limit=1` produced 601 Queries and 55,050 items read for zero
rows; the `UNREAD_WALK_LIMIT` ceiling is roughly 2,000 Queries and ~180k item
reads. The scanned-items tripwire counts CONSUMED items, so it can under-report
the real index read by ~90x and stays quiet through exactly the pathology it
exists to catch.

This one is CHEAP - bounding the internal page by the consumer's appetite is a
few lines - and it is the larger win of the two. Sequence it first.

**Suggested fix.** Treat as one mission with a spec gate on the option-1 vs
option-2 call:

1. Fix contributor 2 first (page-size bound + honest budget accounting). Cheap,
   no schema change, biggest single reduction. Re-measure the badge after it -
   the remaining contact-lookup cost should be re-quantified against the fixed
   loop before designing for it, because the residue-wall ceiling shrinks once
   the loop stops over-fetching.
2. Then decide contributor 1 on that fresh evidence. If the measured cost after
   step 1 is acceptable, option 1 (parallelize) may be enough and the schema
   change is not earned. If not, option 2 with a full spec.

Related on the same path, all currently separate:
[`unread-deleted-contact-probed-twice-per-page`](unread-deleted-contact-probed-twice-per-page.md)
(low), [`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md) (low),
[`unread-budget-truncation-has-no-forward-path`](unread-budget-truncation-has-no-forward-path.md)
(med).

Acceptance is round-trip COUNT, not wall-clock: local DynamoDB timings are
emulator-bound (a Query costs ~24ms regardless of what it returns, scaling with
table size). Prove reductions with call-count assertions, as
`app/test/inboxFeed.test.ts` already does for the WARN tripwire.
