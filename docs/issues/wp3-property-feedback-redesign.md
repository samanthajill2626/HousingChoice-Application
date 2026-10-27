---
id: wp3-property-feedback-redesign
title: Redesign property feedback from the ground up in WP3 - pair it with the send at capture, not by matching addresses in Notes text
type: decision
severity: med
status: deferred
area: app/extraction, app/matching
created: 2026-10-26
refs: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md, docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md, app/src/repos/listingSendsRepo.ts:486
---

**Problem.** WP1 records what a tenant thought about a property sent to
them as a free-form Notes line that names the property by its address
label (B1, charter 6.4 as amended 2026-10-26). B2's tenant card then
pairs each line with a property by finding that label in the line's text
(`labelMatches`, charter 6.2). That pairing is a guess made after the
fact, and it is fragile:

- it depends on the model copying an address exactly; a line that names
  the home some other way is not attached and reads as general feedback
  on EVERY property;
- a later edit to the property's address detaches every earlier line;
- whole lines move, so a staff-typed line that mentions a home carries
  its unrelated facts with it;
- two units with identical labels share lines.

The root cause: nothing in the system ties a tenant's reply to the share
it answers, so feedback has to be recovered from text. Cameron
(2026-10-26, at the B1 spec gate): "When we get to work package 3 we need
a much better way of pairing the property with feedback about the
property. This all seems so fragile and really not the best design. It's
for sure like we're shoehorning this whole thing into the existing
system. Instead I think we need to re-design from the ground up on shared
property feedback."

**Suggested fix (WP3, designed with sharing).** WP3 shares properties from
the system, so a reply arrives in a conversation the system started about
a known send. Capture feedback AGAINST THAT SEND at the moment it is read:
a first-class feedback record per tenant-property pair (what the tenant
said, the sentiment, including "unsure / maybe", the source message, who
or what recorded it), visible and correctable by staff where the pair is
shown. WP3's signed text already has the engine reading declines in the
conversation into WP1's decline tracking; this is the same capture,
widened to all feedback. The ranker's tenant card then reads properties
seen from those records instead of from address-matched Notes lines.

**What WP1 does meanwhile, and how to retire it.** B1 builds the feedback
lines (prompt guidance, the PROPERTIES SENT block given to extraction,
`propertyLabel` / `labelMatches`, the `feedbackLines` and
`unlabeledAddressLines` counts). B2 keeps its attach step MINIMAL and
easy to delete (flagged in the B1 spec, D5.4). Retiring it: the WP3
records replace the attach step as the source of each property's
feedback on the card; existing feedback lines stay in the Notes box as
history Sam can read. Whether to backfill records from old lines is
WP3's call.
