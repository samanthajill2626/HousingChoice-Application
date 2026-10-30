---
id: ranking-stored-input-retention
title: Tenant free text sent to the ranker is copied per pair and per run for 180 days, with no purge on edit or delete
type: decision
severity: med
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/services/ranking/cardFields.ts:118, app/src/services/ranking/cardFields.ts:133, app/src/services/ranking/runBatch.ts:145, app/src/services/ranking/runLog.ts:114, app/src/repos/matchesRepo.ts:76, app/src/repos/contactsRepo.ts:181
---

**Problem.** The tenant card carries the tenant's name, address, Notes box,
Staff notes, Preferences notes and custom fields (cardFields.ts:118-134).
Two copies of what was sent are kept:

- every match row stores `inputSnapshot`, the gzipped input of THAT pair
  (runBatch.ts:145; matchesRepo.ts:76-78, 180-day TTL) - B2b's seam for the
  review dataset; nothing in B2a reads it (written, never decoded);
- every run stores `inputGzip`, the whole user message of its batch (up to 40
  candidates; runLog.ts:114), also for 180 days.

So one tenant's text is copied into one match row per property it is paired
with plus one run record per batch. When staff later clear a Staff note, edit
the Notes box, or a contact is soft-deleted, retyped or hard-deleted (an
import retract), every copy survives until its TTL; there is no purge path.
`staff_notes` was documented as a field "machine-reads nothing" before B2a
(contactsRepo.ts:181; B2a spec D15 changed that comment), so staff may have
written things there (for example "DV survivor, do not share address") they
would not expect to leave the record.

Extends the B2a code review round 1 note A1-12 (matches and runs of a
hard-deleted contact keep its name and card for up to 180 days; `uflag#` rows
have no TTL). Found by the B2a planner's plan-blind review (PA-4, MEDIUM,
CONFIRMED).

**Decision for Cameron** (raised at the B2a handback).

- Confirm the client-data clause of the signed agreement covers Staff notes
  reaching the model provider and these stored copies.
- Store less: a hash of the pair's input instead of `inputSnapshot` until
  B2b reads it (or B2b keeps its own copy only for promoted examples).
- A purge path: drop a contact's ranking copies (its match rows' snapshots,
  or the rows) when its notes are cleared, or it is deleted or retyped.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-4), planner-adjudications.md and R1-adjudications.md
(A1-12).
