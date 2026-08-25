---
id: unread-deleted-contact-probed-twice-per-page
title: A resurface-eligible deleted contact costs two message probes per unread page request
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-16
updated: 2026-08-25
refs: app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts
---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces exactly as filed; what changed is the COST claim (it over-stated the
saving) and the "Suggested fix" (it was under-specified in two ways a literal
implementation would get wrong). Both are corrected in place below.

**The 2026-08-21 BatchGetItem sweep did NOT touch this path** - do not
re-diagnose this as already fixed. That sweep
([`contacts-batchget-amplified-reads`](./contacts-batchget-amplified-reads.md),
resolved 2026-08-21) scoped the unread collector back OUT of its own scope on
that date, because BatchGetItem cannot read a GSI - and it addressed CONTACT
reads in any case, while this issue is about MESSAGE probes.
`app/src/lib/unreadFeed.ts` carries no commit after the
`feat/inbox-unread-index` fix waves.

**Problem.** Filed from the spec-conformance review of
`feat/inbox-unread-index` (finding 4 - spec-conformant, so a follow-up rather
than a defect in the shipped work).

Layer 2 (`collectUnreadRows`) probes `messages.listByConversation(convId,
{limit: 1})` to decide whether a deleted contact's thread resurfaces, and then
DISCARDS the result. `buildContactRow`'s own resurfacing loop probes again
through `latestMessageOf`. Spec 4.5 says presentation "reuses maxConv's latest
message as today" - inside `buildContactRow` it does, but the collector's probe
is not threaded into hydration.

Cost: ONE EXTRA message read per resurface-eligible deleted contact per page
request - not "two instead of one". Hydration's first read is
`latestMessageOf(maxConv.conversationId)` at the top of `buildContactRow`
(`app/src/routes/inbox.ts:756`), and EVERY contact row pays it, deleted or live;
it is presentation, not resurfacing. The collector's probe is the extra read, and
it is removable only in the common shape where the index-offered thread IS
`maxConv`. When the two differ, hydration still has to read `maxConv` for
presentation, and the resurfacing loop can break there before the offered thread
is ever consulted - so the saving is that one Query in the common shape, not a
halving of the path.

THE BADGE GAINS NOTHING FROM FIXING THIS. `countUnreadRows` collects candidates
and hydrates none (`app/src/routes/inbox.ts:1666-1669`: "NO HYDRATION: no
previews, no placement labels, no latest-message reads"), so the duplicate exists
on the PAGE path only. The app's highest-frequency request is unaffected either
way, which is most of why this stays `low`.

The two probes can also DISAGREE, because they are differently
scoped - the collector probes the thread the INDEX yielded, hydration probes the
contact's participant-GSI threads (see also adversarial finding 5, the badge /
page hydration-disagreement note). A disagreement is a drop-and-refill, not a
correctness bug: the row simply does not render and the fill loop replaces it.

**Suggested fix.** Thread the collector's probe result through the candidate into
hydration so `buildContactRow` reuses it instead of re-reading.

WHAT MAKES THIS WORKABLE AT ALL: `deriveLatest` accepts a STRUCTURAL SUBSET of
`MessageItem` (`app/src/routes/inbox.ts:456-471`), and the collector already
holds the whole `page[0]` (`app/src/lib/unreadFeed.ts:575-576`). So one threaded
message can serve BOTH the presentation derivation and the resurfacing
predicate - no second shape, no projection to invent.

TWO CONDITIONS, NEITHER SKIPPABLE. A literal reading of "thread the probe
result" - one `MessageItem | undefined` slot on the candidate - gets both wrong,
and each failure mode is silent.

1. **Key the carrier by `conversationId`.** The collector evaluates PER THREAD,
   not once per contact (`app/src/lib/unreadFeed.ts:622-637`, "PER-THREAD
   evaluation (plan-review A6)"), so one candidate can accumulate several probe
   results. Hydration needs the one matching the conversation it is about to
   read - `maxConv`, or the specific `c` in the loop at
   `app/src/routes/inbox.ts:780-789`. A single unkeyed slot is either unusable or
   gets reused for the WRONG conversation, which renders the row with another
   thread's preview.
2. **Never collapse "empty thread" into "read failed".** `threadResurfaces`
   returns `false` for three different facts: the thread qualifies not, the
   thread has no readable message (`page[0] === undefined`), and the read THREW
   (caught at `app/src/lib/unreadFeed.ts:583-592`). A `MessageItem | undefined`
   carrier cannot tell "not probed" from "no messages" from "read failed", so it
   would cache an ABSENCE produced by a failure. What the reader DOES with that
   absence is the damage: `deriveLatest(undefined, conv)` returns the
   conversation's fallback preview with NO `createdAt`
   (`app/src/routes/inbox.ts:472-476`), and an absent `createdAt` can BY
   DEFINITION never count as fresh (`app/src/routes/inbox.ts:770-777`) - so that
   thread can never resurface the contact. The resulting drop is classified
   `lagged: false` (`app/src/routes/inbox.ts:1185-1187`), so it is never retried
   and never marks the page truncated: the row is simply gone. Today hydration's
   independent read is an accidental RETRY of a failed collector probe; caching
   the failure removes it. Carry SUCCESSFUL probes only, or make the carrier
   three-state.

Also worth doing consciously rather than by accident: this relaxes the layer
boundary `app/src/lib/unreadFeed.ts:472-476` states outright ("NO unread sums and
NO hydration happen here ... the ONE message read this layer performs is the
deleted-contact resurfacing probe, which is a VISIBILITY rule rather than
hydration"), and it weakens the wording at `app/src/routes/inbox.ts:1185-1186`
("decided against fresh message reads"). Amend both comments in the same change.
And add a `listByConversation` call-count assertion for the deleted-resurfacing
shape - `app/test/inboxFeed.test.ts` pins that count for the live-contact and
zero-unread shapes (e.g. `:701`, `:727-733`) but NOT for this one, so nothing
today would catch a regression back into the duplicate read.

Same function, same file as
[`unread-fill-loop-query-amplification`](./unread-fill-loop-query-amplification.md),
so the two can share one change; verified independent, though - that one moves
the collector's Query page sizing and budget accounting, this one moves the
candidate payload. Neither blocks the other.
