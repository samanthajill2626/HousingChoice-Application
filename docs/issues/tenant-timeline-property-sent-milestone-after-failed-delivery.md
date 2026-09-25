---
id: tenant-timeline-property-sent-milestone-after-failed-delivery
title: The tenant timeline's "Property sent" milestone stays after the text's delivery fails
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-25
refs: app/src/jobs/broadcastFanOut.ts, app/src/routes/contactTimeline.ts
---

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
