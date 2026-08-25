---
id: mark-read-fanout-stale-gsi-skip
title: The mark-read fan-outs skip genuinely-unread threads on a stale GSI image
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-17
updated: 2026-08-25
refs: app/src/routes/inbox.ts:1822, app/src/routes/inbox.ts:1855, app/src/routes/contacts.ts:2040, app/src/lib/contactThreads.ts, app/src/repos/conversationsRepo.ts:1640
---

<!--
  MERGED 2026-08-21. `markread-fanout-depends-on-stale-participant-gsi` (med,
  filed 2026-08-16 from the plan-blind adversarial review of
  feat/inbox-unread-index, finding 2 tail) described the same two fan-outs, the
  same filter, and the same fix. Its file was deleted and its distinct content -
  the two route paths, the byParticipantEmail leg, the operator-visible symptom,
  and the emit-gate alternative - folded in below. Do not re-file it.
-->

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces and the filter is byte-identical to the day it was filed, but three
things in the original text did not survive re-reading the code: the severity
(the "permanent" claim below was wrong - these two fan-outs ARE re-driven, so
this is now `med`), one of the two route paths (it is `POST /api/inbox/read`
with a `{ phone }` body, never `/unknown/:phone/read`), and the suggested fix's
cost accounting. All are corrected in place below.

**Problem.** Both mark-READ fan-outs filter their candidate list on the count
they just read:

```ts
all.filter((c) => unreadOf(c) > 0).map((c) => conversations.resetUnread(c.conversationId))
```

The two call sites:

- `POST /api/inbox/read` with a `{ phone }` BODY (the unknown-number row; NOT a
  path parameter) filters `findByParticipantPhone` output - `inbox.ts:1820-1832`.
- `POST /api/inbox/:contactId/read` filters `conversationsForContact` output
  (`app/src/lib/contactThreads.ts`) - `inbox.ts:1853-1865`.

Both lists resolve through the EVENTUALLY CONSISTENT `byParticipantPhone` /
`byParticipantEmail` GSIs, which lag INDEPENDENTLY of `byUnread`, and both GSIs
project ALL (`app/src/lib/dynamoAdmin.ts:56`), so the projected copy carries a
stale `unread_count` rather than omitting it. A stale ZERO for a thread that is
genuinely unread therefore skips that thread entirely: no `resetUnread`, no
`conversation.updated`, and the row stays in the sparse `byUnread` index.

The same lag shape is already diagnosed inside `inbox.ts` itself, on the READ
path: the unread-feed hydrator's comment at `app/src/routes/inbox.ts:1138-1146` records
that "the window where byUnread carries the increment and byParticipantPhone
does not shows the thread PRESENT with its PRE-increment `unread_count: 0`", and
closes it with an authoritative base-table point read (`inbox.ts:1161`). The
WRITE path - these two fan-outs - never got the same treatment. That asymmetry
is the whole issue.

The window is not incidental. The inbound webhook writes `incrementUnread` to the
BASE table and pushes `message.persisted`; `useMarkContactRead` subscribes to that
event payload-blind and POSTs the fan-out milliseconds later - i.e. inside GSI
replication lag by design, not by accident.

**Two distinct consequences.**

1. *Operator-visible, retryable.* The nav badge and the fan-out now read
   DIFFERENT indexes and can disagree. The badge counts the row through
   `byUnread` while the fan-out declines to clear it, so the operator clicks
   "Mark read", the optimistic decrement expires
   (`dashboard/src/routes/inbox/useInbox.ts:457-461`), and the badge comes back
   up. Annoying, but retryable. (Before the sparse index this could not happen: a
   badge computed from the same participant/open-partition reads would have
   agreed with the fan-out's view.)
2. *Sticky, and permanent only in the tail.* The skipped row stays in `byUnread`
   until the next mark-read gesture that touches that contact or thread, and for
   as long as it sits there it costs a resurfacing probe on every badge
   request - i.e. it feeds
   [`unread-badge-request-round-trip-cost`](./unread-badge-request-round-trip-cost.md).

   CORRECTED 2026-08-25 - the original text claimed this was PERMANENT because
   "nothing fires again". That is false for these two routes. FIVE later events
   re-drive the same reset against a by-then-fresh index, and any one of them
   clears the row:

   - contact-page mount / contact change
     (`dashboard/src/routes/contact/useMarkContactRead.ts:195-197`);
   - tab re-focus while parked on that page (`useMarkContactRead.ts:200-207`);
   - ANY subsequent org-wide `message.persisted` with that page open - the
     payload-blind subscription cuts both ways (`useMarkContactRead.ts:210`);
   - the inbox row's own Mark-read (`useInbox.ts:428`);
   - opening the thread, which resets BY conversationId with no GSI in the path
     (`app/src/routes/api.ts:2318`).

   The stranded row also stays VISIBLE while it waits: the unread-feed hydrator
   re-reads the base table and renders a genuinely-unread row
   (`app/src/routes/inbox.ts:1159-1171`), so the operator keeps both the signal
   (badge + Unread tab) and the affordance (Mark read) to retry, and the retry
   succeeds. A truly permanent `byUnread` resident needs the tail case where
   nobody ever revisits that contact AND the thread never receives another
   message. That tail is why this is still worth fixing; it is not why it was
   `high`, and the severity is now `med`.

This class has already been ruled on in this repo. `app/src/routes/contacts.ts`
removed the identical filter over the identical GSI, citing a prior adversarial
finding: a stale image reporting 0 for a thread that IS unread made the reset skip
that thread forever, and the filter was only an optimization
(`contacts.ts:2007-2019`, reset at `:2040`). The fix was applied there, with a
stale-image regression test (`app/test/contactSoftDelete.test.ts:235-269`), and
the two inbox fan-outs were deliberately left alone by that fix wave.

**Do not carry that precedent's PERMANENCE argument over to these routes** - it
is the one thing about the two cases that genuinely differs. The `contacts.ts`
fan-out runs once per contact soft-delete and NOTHING re-runs it for an
already-deleted contact, so a miss there really is unrecoverable; that is what
forced the unconditional reset. Here, the five re-drives above exist. The
correctness defect is the same; the blast radius is not.

Found by the plan-blind adversarial reviewer during the `inbox-mark-unread`
mission (round 2), which hardened the mark-UNREAD write against the mirror-image
race (stale POSITIVE) but deliberately did not touch the mark-READ path: this is
pre-existing behavior, and the human authorized exactly two hardening items on
that mission.

**Suggested fix.** Do NOT copy `contacts.ts` verbatim - that fan-out runs once per
contact delete, while these two run whenever a contact page is open and any
org-wide message lands, so simply dropping the filter multiplies `resetUnread`
writes and `conversation.updated` SSE volume (one event per already-read thread of
the contact, fanned out to every connected dashboard's debounced refetch).

The shape this repo has already established for exactly this problem is a
conditional write: add `resetUnreadIfUnread` to `conversationsRepo`, call it
unfiltered from both fan-outs, catch `ConditionalCheckFailedException` as
"already read - nothing to do", and emit `conversation.updated` only when a write
actually happened. That makes the WRITE, not a lagging read, the authority - the
same correction `setUnread` made on the mark-unread side
(`app/src/lib/markUnread.ts`) - because a `ConditionExpression` is evaluated
against the BASE table item at write time, where no GSI lag exists.

Write the condition as BOTH clauses:

```
ConditionExpression: 'attribute_exists(conversationId) AND attribute_exists(unread_flag)'
```

`attribute_exists(unread_flag)` ALONE is not enough, and the difference is not
cosmetic: on a row that does not exist that single clause also fails, so a
MISSING conversation and an ALREADY-READ one collapse into one indistinguishable
`ConditionalCheckFailedException`. Both call sites already swallow CCF as "race:
already gone", so the miss would be silent. Keeping
`attribute_exists(conversationId)` preserves the distinction the rest of the repo
relies on (see `conversationsRepo.ts:1607-1611`, which disambiguates a CCF with a
follow-up read); use `ReturnValuesOnConditionCheckFailure` if the caller wants to
act on it.

Keying on `unread_flag` is safe because that attribute and `unread_count` ride
ONE `UpdateExpression` in every writer, so "genuinely unread" and "the flag
exists" are the same predicate for any row this system wrote:
`incrementUnread` (`conversationsRepo.ts:1631`), `resetUnread` (`:1653`),
`setUnread` (`:1699`), and the relay close (`:2068`). The invariant is stated at
`app/src/lib/tables.ts:173-176`.

**What this costs, stated honestly (an earlier revision of this section got it
wrong).** The conditional write is still the right call, but it does not come
free:

- It does NOT save write capacity. A conditional `UpdateItem` whose condition
  evaluates false still consumes WCUs. What it genuinely saves is the item
  mutation, the resulting `NEW_AND_OLD_IMAGES` stream record, and the
  `conversation.updated` SSE fan-out - the expensive half, and the half the
  filter was actually protecting. Do not plan capacity against a "spends
  nothing" claim; the earlier text's "the conditional write spends neither" was
  false and has been removed.
- It turns a zero-write request into an N-write request. Today, when a contact's
  threads are all read, the POST issues NO DynamoDB writes at all. Unfiltered,
  it issues one conditional write per thread the union returns - and that POST
  fires on EVERY org-wide `message.persisted` for every dashboard with a contact
  page open (`useMarkContactRead.ts:210` subscribes payload-blind), plus once per
  mount and per tab re-focus. So the multiplier is
  (threads per contact) x (org inbound rate) x (open dashboards). Still far
  cheaper than the SSE storm a verbatim `contacts.ts` copy would cause, but it is
  a real new cost. The cheapest complementary fix is on the CLIENT: make
  `onMessagePersisted` payload-AWARE so an unrelated contact's message stops
  triggering this contact's fan-out at all. That belongs in its own item, not
  folded in here.

**The counter-only-row risk, and what was actually measured.** A spec reviewer
argued that a flag-conditional write would STRAND any legacy row carrying
`unread_count > 0` with no `unread_flag`: today's filter plus the unconditional
`resetUnread` would zero such a row whenever the GSI image happened to show its
nonzero count, whereas the conditional write refuses it forever - re-creating,
for that class, exactly the permanent skip this issue objects to. The class is
real enough that a repair script exists for it
(`app/scripts/backfill-unread-flag.ts:399`, whose planner condition is
`attribute_exists(conversationId) AND attribute_not_exists(unread_flag) AND unread_count > :zero`).

It is EMPIRICALLY EMPTY in the deployed environments. `RUNBOOK.md` (the "Inbox
unread index schema" section) records the 2026-08-17 rollout: the backfill dry
run reported zero rows to stamp/remove/reset in BOTH environments - "dev 771/771
skipped, prod 786/786 skipped" - so the live backfill was never needed and is not
owed. Every runtime writer since then maintains the flag atomically (the four
above), and both seed profiles stay inside the invariant (`seed/lean.ts:253`,
`seed/live.ts:264` and siblings write `unread_count: 0` with no flag;
`seed/performance.ts:1086-1091` ASSERTS "performance conversation must carry
unread_flag iff unread_count > 0"). No importer or ops script writes either
attribute. So the class is closed by construction going forward.

UNVERIFIED EXPOSURE, stated so a builder adds the guard consciously rather than
by omission: the founder's LOCAL imported dataset (`TABLE_PREFIX=hc-local-`).
`RUNBOOK.md` still lists it as needing `db:update-gsis` plus the same backfill
"if/when it is used with the new code", and nothing in the repo records an
outcome. That is the one place counter-only rows could still exist. A builder
should either confirm that backfill ran, or accept that a local-only dataset can
strand such a row and say so in the handback - not discover it as a surprise.

There is also a collateral IMPROVEMENT worth keeping: the mirror-image residue
`{ unread_count: 0, unread_flag: 'unread' }` (backfill rule 5, cleaned by
`backfill-unread-flag.ts:411-412`) is SKIPPED by today's `unreadOf(c) > 0` filter
and would be cleaned by the conditional write, since `attribute_exists(unread_flag)`
is true for it. Those rows are pure badge-walk waste.

The cheaper variant, if the conditional write is not wanted: reset every thread
the lookup returns (`resetUnread` is idempotent and already conditional on
`attribute_exists(conversationId)`) and keep the existing filter as a pure EMIT
gate. That fixes correctness at the same write cost as the conditional version,
but it also mutates the item and cuts a stream record for every already-read
thread, which the conditional version avoids.

A regression test is cheap, and there are two seams. The closer template is
`app/test/contactSoftDelete.test.ts:235-269` ("STALE GSI: resets a flagged thread
whose participant-GSI image still says read"), which proxies
`findByParticipantPhone` to return `{ ...c, unread_count: 0, unread_flag: undefined }`
for EVERY call and asserts on `world.unreadResets` - point it at the two read
routes. `stalePositiveOnFirstRead` (`app/test/inboxApi.test.ts:716-733`) also
stages a stale image but stales only `unread_count` and hands out exactly ONE per
wrapped read. Either way, a fake `resetUnreadIfUnread` must evaluate its
condition against the STORED map (`world.conversations.get(id)`), never against
the projected copy, or the test is vacuous; the existing fakes already model the
atomic flag+counter write correctly
(`app/test/helpers/twilioWebhookHarness.ts:526-546`).

Two existing pins should stay green without being rewritten, and are a good
check that the remedy is the right shape:
`app/test/inboxApi.test.ts:364-380` ("skips conversations already at unread 0 (no
redundant emit)") - a refused conditional write returns no `ALL_NEW` attributes,
so no emit; and the relay-group exclusion pin at `inboxApi.test.ts:397-407`,
which is STRUCTURAL (a relay group fronts the pool number and carries no
`participant_email`) and is unaffected because the remedy changes the write, not
the lookup.
