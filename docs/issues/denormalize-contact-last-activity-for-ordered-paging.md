---
id: denormalize-contact-last-activity-for-ordered-paging
title: Denormalize a last_activity_at onto the contact record (plus a GSI) so contact-side feeds can page in activity order
type: improvement
severity: low
status: open
area: app
created: 2026-08-26
refs: app/src/repos/contactsRepo.ts, app/src/repos/conversationsRepo.ts:1541, app/src/lib/tables.ts, app/src/lib/unknownQueue.ts, app/src/routes/inbox.ts
---

**Problem.** `ContactItem` carries NO activity or recency attribute of any kind -
activity lives only on conversations. Every contact-side feed therefore has a
hard ceiling on what it can do: to present contacts in "most recent first"
order, it must resolve EVERY candidate contact's threads before it can order
anything, which means reading the whole set before rendering the first row. That
is what forces a bound.

Said plainly: **a fixed cap is the price of an activity sort on a contact-side
read.** The Unknown inbox tab hit this directly (see
[`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md) and
[`unknown-queue-cap-starves-needs-review`](unknown-queue-cap-starves-needs-review.md)).
It was resolved 2026-08-26 by DROPPING the global activity sort - the tab now
pages in queue order (untriaged block first, then reviewed, human ruling) using
the index's own cursor, which is unbounded and cheap. That is the right answer
for a triage QUEUE, where completeness matters more than recency.

It is not the right answer everywhere. Any future contact-side surface that
genuinely wants newest-first ordering will hit the same wall and face the same
choice: cap it, or drop the sort.

**Suggested fix.** Denormalize `last_activity_at` onto the contact and index it,
so `(type, last_activity_at)` is directly queryable and pageable.

**Feasibility, measured 2026-08-26 - the cheap part.** The contact record is
COLD today. Every write is one of: creation (`createIfAbsent` / `create`), a
ONE-TIME stamp, an operator action (triage PATCH, edit, opt-out toggle,
delete/restore, phone edits), a lifecycle transition (`statusTransition`), an
import, or AI extraction. Notably the three writes that DO sit on the
message/call hot path - `routes/webhooks/twilio.ts:855`, `twilio.ts:896`,
`routes/webhooks/voice.ts:611` - are ALL guarded by `!consent_method`, so they
fire once per contact ever and never again. **Nothing in the system currently
writes a contact per message.**

So this change makes the contact record hot for the first time. The cost itself
is negligible at this scale (one small write per 1:1 message), and there is ONE
natural home for it: `conversationsRepo` already has a single method that stamps
the conversation's `status` + `last_activity_at` + preview per message
(`conversationsRepo.ts:1541`). A contact bump belongs beside that, not scattered
across callers.

**THE TRAP, and it is the same one this cluster just shipped a fix for.** A GSI
keyed on `(type, last_activity_at)` will NOT index a contact missing that
attribute - a sparse index skips items lacking a key attribute. So:

1. **Backfill is MANDATORY, not optional.** Every contact that exists before
   this lands is invisible to the new index until backfilled from its
   conversations.
2. **It needs the same index-key guard** being added for
   `status` (2026-08-26): any write path that removes or omits the attribute
   silently drops the contact out of the feed with no error, no log and no
   counter. That is exactly the defect pattern behind the status-less-contact
   finding; do not re-ship it one attribute over.

**The reassuring half:** a STALE `last_activity_at` mis-ORDERS a row, it never
HIDES one. That is a materially safer failure mode than the sparse-index one,
so a best-effort bump that occasionally fails is tolerable in a way a missing
attribute is not.

**Open questions for whoever specs this:**

- Do GROUP messages count as activity for a member contact, or only 1:1? The
  triage queue only cares about 1:1, but "last heard from" on a contact list
  probably wants both.
- Is the bump best-effort (fails silently, mis-sorts) or does it share the
  message write's failure handling?
- Does it move FORWARD ONLY, like the importer's conversation stamp
  (`lib/import/apply.ts:1098-1101`) already does? An out-of-order webhook or a
  backfill racing a live message would otherwise walk it backwards.

**Why it is worth doing anyway.** It is useful well beyond this one tab - a
"last heard from" column on the contact list, stale-contact sweeps, and any
future contact-side feed that wants recency ordering. That breadth is the
argument for specing it properly rather than bolting it on as a sort key for one
page.

**Not urgent.** The Unknown tab is fully correct and unbounded without it. This
buys back global newest-first ordering, which the human ruled 2026-08-26 is not
what a triage queue wants in the first place.
