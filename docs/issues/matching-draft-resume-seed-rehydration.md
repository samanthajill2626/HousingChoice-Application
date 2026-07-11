---
id: matching-draft-resume-seed-rehydration
title: Matching-send draft resume does not rehydrate body/seeds; first keystroke recreates the draft
type: debt
severity: low
status: open
area: dashboard/broadcasts
created: 2026-07-10
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx, dashboard/src/routes/broadcasts/RecipientPreview.tsx, dashboard/src/routes/broadcasts/useComposerDraft.ts
---

**Problem.** Hand-picked seeds ARE persisted to the draft record: RecipientPreview
PATCHes each add-a-tenant back to the draft's seed list (updateBroadcastSeeds,
best-effort). But that persistence does not survive a ?draftId= resume in practice,
so the spec claim "so they survive ?draftId= resume" is not actually delivered:

- Resume (`/broadcasts/new?draftId=<id>`) only adopts the draft ID
  (`draft.adoptDraftId`). It never rehydrates the composer's in-memory state:
  `bodyTemplate` stays `''`, the seed list, `unitId`, and `audience_mode` are not
  read back from the resumed draft record.
- The composer's throwaway-draft machinery (useComposerDraft) recreates a fresh
  draft on the first material change. So the operator's FIRST keystroke in a
  resumed draft creates a NEW draft (and deletes the resumed one), discarding the
  persisted seeds along with it.
- A resumed seeds_only (1:1 entry) draft also recreates in filter-mode, because the
  seeds-only `audience_mode` is not carried over on adopt, so the resumed compose
  is no longer the seeds-only pipeline it was saved as.

Net effect: persisted seeds do not survive resume, and the intended "resume a
matching draft" round-trip is broken even though the write side works. Severity is
low: the primary entry points (tenant-file 1:1, property-page filtered) do not
depend on resume, and draft resume is a secondary convenience.

**Suggested fix.** On adopt (`?draftId=` resume), fetch the draft record and
rehydrate the composer from it before the throwaway-draft machinery can fire:
seed `bodyTemplate` from `body_template`, the hand-picked seeds from
`seed_contact_ids`, and `unitId` from the draft's unit. Carry `audience_mode`
(seeds_only vs filter) so a resumed seeds-only draft stays in the 1:1 pipeline.
Suppress the recreate-on-first-change until the adopted state is applied (treat the
rehydrated values as the baseline, not a material change), so the first keystroke
edits the resumed draft instead of replacing it.
