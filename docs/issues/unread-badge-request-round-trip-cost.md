---
id: unread-badge-request-round-trip-cost
title: The unread badge pays one contact Query per 1:1 index item SCANNED, unbounded to 2,000
type: debt
severity: high
status: open
area: app/inbox
created: 2026-08-21
updated: 2026-08-25
refs: app/src/lib/unreadFeed.ts:534, app/src/lib/unreadFeed.ts:568, app/src/routes/inbox.ts:1674, app/src/repos/contactsRepo.ts:912, app/src/repos/contactsRepo.ts:941, app/src/repos/conversationsRepo.ts:179, app/src/routes/today.ts:1086
---

**Re-adjudicated 2026-08-25 against `main` @88ac7b36.** The premise that blocked
this issue - "the conversation item carries no `contactId`" - is DISPROVEN, so
the spec gate is gone and the read-through below is approved for direct build;
the second amplification this file used to own belongs to a different endpoint
and is demoted to a cross-reference.

**Problem.** `GET /api/inbox/unread-count` is the app's highest-frequency
authed request: once per SPA boot plus once per debounced `conversation.updated`,
per connected dashboard. The `feat/inbox-unread-index` feature (merged
2026-08-17) made the WALK proportional to actual unread rows - it closed
[`inbox-unread-sse-full-walk`](inbox-unread-sse-full-walk.md) and removed the
O(open conversations) scan. It did not make the request cheap. ONE amplification
remains inside the walk, and nothing bounds it.

**The defect - one contact lookup per 1:1 index item SCANNED.**
`collectUnreadRows` calls `contacts.findByPhone(item.participant_phone)` and
falls back to `contacts.findByEmail(item.participant_email)` for every 1:1 item
it SCANS, not every row it returns (unreadFeed.ts:534, called unconditionally at
:607, awaited one at a time at :670). `countUnreadRows` (inbox.ts:1674) makes
exactly ONE `collectUnreadRows` call with `maxRows = BADGE_COUNT_CAP`, so this
IS the badge's whole index cost. A capped badge request costs ~100 contact
Queries; inside a "residue wall" of hidden deleted-contact index rows it reaches
the `UNREAD_WALK_LIMIT` ceiling of ~2,000. The reviewer measured 2,046 serial
round trips - 2,000 of them `findByPhone` - for a badge that answers ZERO,
because a hidden deleted-contact thread passes `isUnreadVisible` and the contact
lookup is exactly how the collector discovers that it is hidden.

NEITHER EXISTING BOUND TOUCHES IT, which is why the ceiling is reachable rather
than theoretical. The row cap cannot fire: a hidden deleted contact never pushes
a candidate, so `candidates.length >= opts.maxRows` (unreadFeed.ts:674) is never
true inside a wall. The deleted-probe bound stops MESSAGE reads only - it lives
inside `threadResurfaces` (unreadFeed.ts:569), which `consume` reaches only
AFTER `resolveContact` has already paid its Query.

2,046 is also a FLOOR for a second reason the original filing missed:
`findByPhone` is pointer-aware, so a NON-PRIMARY number costs a Query PLUS a
`getById` hop to its owner (contactsRepo.ts:932-937). A badge over multi-number
contacts pays up to twice the stated round trips.

Two remedies are already ruled out, and should not be re-litigated:

- A per-collect memo keyed on the participant key was implemented and REMOVED
  (review fix wave 2, adversarial r2 finding 3). The claim arbiters
  (`phone#<E164>` / `claimEmail`) guarantee at most one OPEN conversation per
  participant key, and `isUnreadVisible` requires `status === 'open'` for the
  1:1 bucket, so the memo can never hit. It hit zero times in production shapes.
- Bounding contact resolution re-creates the walk-stop class that round 2
  blocked: any bound past which live rows go uncounted makes the badge lie.
  Stop-the-walk hid live work; stop-the-lookups leaked deleted rows.

**BatchGet cannot read the `byPhone` / `byEmail` GSIs - and it does not need to.**
`findByPhone` / `findByEmail` are Queries against those GSIs
(contactsRepo.ts:912, :941; both hash-only on `phone` / `email`, see
infra/envs/*/tables.auto.tfvars.json). **BatchGetItem cannot read a GSI** -
`KeysAndAttributes` has no `IndexName`, batch reads address base-table primary
keys only. That half stands, re-verified 2026-08-25.

**STRICKEN 2026-08-25. This file previously continued: "the conversation item
carries `participant_phone` / `participant_email` with no `contactId`, so there
is no base-table key to batch with." THAT SENTENCE IS FALSE. It is recorded here
only so nobody re-derives it; do not scope work off it.** The base-table key is
already on the item, and the batch primitive already exists:

- `ConversationItem.participants` (conversationsRepo.ts:179) is an array of
  `{ contactId, phone }`, and `contactId` IS the contacts base-table hash key.
- It is written BEFORE the row can reach the byUnread index. The inbound 1:1 SMS
  webhook calls `captureContact` at webhooks/twilio.ts:2187, which claims the
  link via `setParticipantsIfAbsent` (contactCapture.ts:152, :177); the
  `incrementUnread` that puts the thread on the index is at twilio.ts:2258.
  Inbound voice does the same at webhooks/voice.ts:606. An email-only thread
  seeds the roster at creation when the contact is known
  (conversationsRepo.ts:1353-1358).
- THIS SAME WALK ALREADY READS IT. `today.ts:1086` `oneToOneContactId` takes
  `conv.participants?.[0]?.contactId` off items yielded by
  `iterateUnreadConversations` (today.ts:703) - the identical layer-1 iterator
  `collectUnreadRows` drives - and pays zero contact Queries for it. The same
  read appears at jobs/extraction.ts:423 and services/inboundEmail.ts:851.
- AND THE BATCH PRIMITIVE SHIPPED. `contacts.getManyByIds`
  (contactsRepo.ts:982, alongside `getDisplaysByIds` at :978) landed with
  [`contacts-batchget-amplified-reads`](contacts-batchget-amplified-reads.md) on
  2026-08-21 - the same day this file said the tool did not exist.

So there is no new write-path invariant to invent and no backfill of every
conversation to schedule. What remains is a READ-THROUGH with a fallback and one
staleness ruling. The old option 1 - parallelize the per-item Queries with
bounded concurrency - is still only a latency fix (the round-trip COUNT is
unchanged, and round trips are the cost driver) and is NOT the remedy.

**Not in this request: the fill-loop re-query.** This file used to carry a second
contributor - the fill-or-exhaust loop building a fresh `collectUnreadRows`,
hence a fresh iterator and a fresh `queryUnreadPage`, per iteration, with an
internal page size that ignores `maxRows`. It is real and it still reproduces,
but NOT on the badge: `countUnreadRows` (inbox.ts:1674) makes exactly one
collect, while the fill loop is in `aggregateInbox`'s `filter === 'unread'`
branch (inbox.ts:1245), i.e. `GET /api/inbox?filter=unread`. It is owned in full
by
[`unread-fill-loop-query-amplification`](unread-fill-loop-query-amplification.md)
(med, open) and must be measured and fixed there. Bounding its internal page by
the consumer's appetite cannot reduce the badge at all - the badge's `maxRows`
is `BADGE_COUNT_CAP` (100) and the page size is already 100, so any
"re-measure the badge after that lands" instruction returns an unchanged number.

**Suggested fix - APPROVED 2026-08-25, build directly, no measurement gate.**
Resolve the 1:1 contact from the conversation item and batch the resulting
base-table reads. All five conditions below are load-bearing; each names a way
this fix goes wrong.

1. **Match by PHONE, never `participants[0]`.** contactCapture.ts:140-141 states
   the rule and its reason - "never participants[0]: an entry for another phone
   is someone else's contact". `today.ts:1086` uses `[0]`; do not copy it here.
   Resolve
   `item.participants?.find((p) => p.phone === item.participant_phone)`, and for
   an email-only thread match the roster entry the email path seeded (its
   `phone` is the empty string, conversationsRepo.ts:1353-1358).
2. **Keep `findByPhone` / `findByEmail` as the FALLBACK.** The link is absent in
   real states, not only theoretical ones: a phone conversation is created
   WITHOUT `participants` (conversationsRepo.ts:1235-1243) and backfilled
   moments later, and a capture failure is logged and swallowed
   (twilio.ts:2189-2192), leaving an indexed thread with no link. A miss must
   degrade to today's Query - never to a dropped row and never to a phantom
   `unknown`.
3. **Rule on STALENESS explicitly, in the spec text, before building.**
   `setParticipantsIfAbsent` is write-once
   (`attribute_not_exists(participants)`, conversationsRepo.ts:1599) and nothing
   updates it, while `findByPhone` hops `phone_ref -> phone_ref_owner`
   (contactsRepo.ts:932-937) to the CURRENT owner. After a contact merge or a
   number reassignment the two disagree, and the badge would attribute a row to
   the old contact while the unread PAGE's `hydrateUnread` still resolves the
   other way. The badge and the page disagreeing about what a row IS is exactly
   what the two-layer design exists to prevent (unreadFeed.ts:8-16). Decide
   which source wins, whether a disagreement is detectable at all, and write it
   down.
4. **Bound the LOOK-AHEAD.** Batching needs several items in hand before it can
   issue one read, and the module header (unreadFeed.ts:18-27) makes the lazy
   pull-based contract load-bearing: "Any change here that buffers ahead of the
   consumer silently undoes that, so the unit tests assert on the NUMBER OF
   queryUnreadPage CALLS". Bound the buffer by `maxRows - candidates.length` so
   a badge that needs 5 more rows never resolves 100.
5. **Decide what a FAILED batch means, and pin it in a test.**
   `resolveContact` (unreadFeed.ts:537-545) degrades a THROW to "no contact",
   which for a phone thread emits an `unknown` row. Batched, one failure covers
   up to 100 keys, so that same degradation would flip a wall of NAMED rows to
   unknown instead of blanking one. This is the absence-vs-failure trap
   `contacts-batchget-amplified-reads` already paid for once; `getManyByIds`
   carries `{ requireComplete }` for it.

The deleted-contact resurfacing rule needs the whole `ContactItem` (it reads
`deleted_at`, unreadFeed.ts:645), so the batched read is `getManyByIds`, not the
`getDisplaysByIds` projection.

Related on the same path, all currently separate:
[`unread-deleted-contact-probed-twice-per-page`](unread-deleted-contact-probed-twice-per-page.md)
(low), [`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md) (low -
noted 2026-08-25 as reaching the same contact-resolution remedy from the other
end; its own file owns that detail and this one makes no claim about the
order the two land in),
[`unread-budget-truncation-has-no-forward-path`](unread-budget-truncation-has-no-forward-path.md)
(med).

Acceptance is round-trip COUNT, not wall-clock: local DynamoDB timings are
emulator-bound (a Query costs ~24ms regardless of what it returns, scaling with
table size). Prove reductions with call-count assertions, as
`app/test/inboxFeed.test.ts` already does for the WARN tripwire. Specifically,
pin the per-request `findByPhone` count in the residue-wall world that file
ALREADY builds - `wallOfHiddenDeleted(27, 5)` at inboxFeed.test.ts:1594, whose
badge case today asserts the rows and the probe WARN but never the lookup count,
which is why 32 contact Queries to answer 5 passes as green.
