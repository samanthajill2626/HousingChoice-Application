---
id: tenant-timeline-property-sent-milestone-after-failed-delivery
title: The tenant timeline's "Property sent" milestone stays after the text's delivery fails
type: bug
severity: low
status: resolved
area: app/broadcasts
created: 2026-09-25
updated: 2026-09-28
resolved: 2026-09-28
refs: app/src/jobs/broadcastFanOut.ts, app/src/routes/contactTimeline.ts
---

**RESOLVED 2026-09-28 (branch `feat/share-sent-outcome`, share-skip Branch B;
UNMERGED at this writing - the merge closes it).** Spec
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` D6 (the
milestone carries its share id and takes its words from the pair's ledger
entry for THAT share, at read time: "Property sent" for a counted entry or a
pending one whose promise is live, "Property sent - not confirmed", "Property
text failed") and D7 (the ledger follows the rule: only reached attempts
count, a failure un-counts the pair, and "Properties sent" drops it by the
sparse index). The milestone is still written at carrier acceptance; its
words follow what happened after.

- The ledger's per-share memory and `counted` flag (T3 `3c885850`); the pass
  and the adoption write an ENTRY and the milestone carries `broadcastId` (T7
  `3a68c164`); every later attempt and an original row's receipt move the
  entry (T4 `71a57f58`, T5 `7a23711e`, T6 `ad45ef4a`); the timeline composes
  the words (T12 `417b16d6`); the repair rebuilds the ledger from the slot
  for history (T13 `5005a606`); e2e (b) pins "Property text failed" and the
  property gone from "Properties sent" (T14 `329d136a`).

**Residuals, by decision:** a pending entry reads "Property sent" while its
promise is live (spec D6 verbatim; the adversarial review's ADV-3 was
rejected on it); a milestone written before this branch (no share id) reads
from the pair's row (D6's pair rule); a unit-less share's milestone keeps its
stored words (a non-goal); a ledger write lost past its re-read bound is
healed only by a repair re-run
([share-retry-rollup-lost-past-reread-bound](./share-retry-rollup-lost-past-reread-bound.md)).

**Problem.** When a property-targeted broadcast text is accepted by the carrier,
the fan-out records a `listing_sent` milestone ("Property sent") on the tenant's
activity timeline. A later delivery failure (carrier callback: undelivered or
failed) does not touch the milestone, so the timeline says the property was sent
while the failed message bubble on the same timeline says it was not. Found
during the share-skip-fix design (2026-09-24).

**Suggested fix.** Branch B of share-skip-fix
(`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`) defines one
"counted as sent" rule across retries; the milestone should follow it (record on
a counted outcome, or retract on a final failure) rather than on carrier
acceptance. Filed so the gap is tracked until that branch lands.
