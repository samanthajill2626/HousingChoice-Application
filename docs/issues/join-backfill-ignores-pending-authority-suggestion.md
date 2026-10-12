---
id: join-backfill-ignores-pending-authority-suggestion
title: The /join lead backfill gives Atlanta Housing Authority to a lead with a pending AI housing authority suggestion, and the report does not say so
type: improvement
severity: low
status: open
area: app/scripts
created: 2026-10-12
refs: app/scripts/backfill-join-housing-authority.ts, app/src/services/extraction/apply.ts:256-282, app/src/services/extraction/apply.ts:290-327, app/src/repos/extractionRepo.ts:234-240
---

**Problem.** The backfill (spec 2026-10-12 D10) leaves a candidate out only for `--skip`, a
post-change re-sign-up, or an audit history of the authority being set or removed. AI
extraction SUGGESTS rather than writes an authority it hears on an empty field when the
name is not an exact or unique list match (for example an ambiguous "AHA", or a name heard
on a call), so a pre-change lead can hold a pending housing authority suggestion (say,
DeKalb) and still be a plain target: the dry run lists it with no hint, and `--apply`
writes Atlanta beside the pending suggestion. The operator's `--skip` review (RUNBOOK step
2) is where a wrong Atlanta is meant to be caught, and it cannot see this. Not data loss:
the suggestion survives, and accepting it overwrites Atlanta. Found by the
join-housing-authority R2 review (R2-N2, 2026-10-12); reasoned from the code, not
reproduced. Expected to be rare (an exact list match is written, not suggested).

**Suggested fix.** In the backfill's per-candidate read, also read
`getSuggestion(contactId, 'housingAuthority')` (one GetItem per candidate); when one is
pending and its value is not exactly "Atlanta Housing Authority", either leave the lead out
with that reason or print the suggested value on its target line so the operator decides.
A product call for Cameron before the first dev run (raised as an open question in the
mission handback).
