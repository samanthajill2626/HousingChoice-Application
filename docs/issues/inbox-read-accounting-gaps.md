---
id: inbox-read-accounting-gaps
title: The inbox read accounting covers the open-partition pager only, so the unread and groups feeds keep the ambiguity it removed
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-24
refs: app/src/routes/inbox.ts
---

**Problem.** `aggregateInbox` gained `rawScanned` / `rawQueries` / `drops` on
2026-08-24 so that a zero-row answer could say WHICH zero it was - an empty
partition, or a partition whose rows assembly consumed. That closed a real
diagnostic gap: three e2e sightings of an empty inbox had been undiagnosable
because nothing server-side recorded the difference
([`call-inbox-unread-detached-node-flake`](./call-inbox-unread-detached-node-flake.md)).

It was added to the OPEN-PARTITION pager only - filters `all` and `unknown`.
There are three `'inbox feed assembled'` log lines, and the other two carry
none of it:

- **`filter=unread`** returns from the index-backed branch with `count`,
  `scanned`, `seen`. `scanned` is `startingBudget - remainingBudget` - BUDGET
  UNITS, not rows - so `count: 0, scanned: 0` still cannot distinguish "the
  index held nothing" from "everything the index offered was dropped in
  hydration". That is the same ambiguity, on the feed the C1 mission is named
  after.
- **`filter=groups`** logs a bare count with no accounting at all.

Found by the adversarial review of `feat/inbox-unread-read-path`, which noted
the omission is conspicuous on a branch about the unread read path. The
rationale given for adding the fields ("the same ambiguity exists in every
deployed environment") applies verbatim to both omitted lines.

**Suggested fix.** Give the unread branch an honest row-level pair - items
offered by the index vs candidates dropped, by reason (the hydration path
already discriminates `lagged` from authoritative drops, and those reasons are
the interesting ones) - and keep `scanned` as the budget figure it actually is,
renamed so nobody reads it as rows. The groups branch needs only the count of
items the partition returned versus rows emitted.

**These two halves have different costs, and only one of them needs to wait.**

- The `scanned` RENAME does depend on the C1 fill-loop work
  ([`unread-fill-loop-query-amplification`](./unread-fill-loop-query-amplification.md)),
  which rewrites that budget accounting - naming the field twice is wasted
  motion, so defer it.
- The DROP-REASON map does not depend on it at all. The hydration path already
  discriminates a `lagged` drop from an authoritative one; emitting those counts
  is a log-line change, not an accounting change. That is also the half that
  actually breaks the ambiguity on the unread feed. Do not defer it a second
  time on the other half's reasoning - which is what the first version of this
  issue did.

**Not in scope, deliberately.** `rawQueries` is not a request round-trip count
and is documented in place as not being one. The badge's round-trip acceptance
criterion in cluster C1 needs its own measurement, not this field.
