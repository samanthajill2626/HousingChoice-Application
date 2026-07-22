---
id: suggestion-dismissals-not-sticky
title: Dismissed AI suggestions come back on every re-run while the source content is in the window
type: bug
severity: medium
status: open
area: app
created: 2026-07-21
refs: app/src/services/extraction/apply.ts, app/src/routes/suggestions.ts
---

**Problem (observed live on dev, 2026-07-21).** Dismissing a suggestion
deletes its row and audits `ai_suggestion_dismissed` - nothing remembers
WHAT was dismissed. The next extraction run re-reads the same transcript
window (newest 50 / 30 days), the model sees the same conflict against the
profile, and `putSuggestion` upserts the identical suggestion again.
Repro: contact renamed after a voicemail said "Cameron Apt"; the name
suggestion was dismissed; the next inbound message brought it straight
back. This repeats on EVERY run until the source content ages out of the
window - staff can be nagged by the same rejected suggestion for up to 30
days.

**Expected.** A dismissal is a human decision about a specific proposed
value; the pipeline should honor it.

**Suggested fix - dismissal tombstones.** On dismiss, keep the row (or a
sibling `dism#<contactId>#<target>` item) recording the dismissed
`suggestedValue` (and `suggestedAddress` for the compound target) instead
of deleting outright. In apply's suggest path, skip when the new
suggestedValue NORMALIZED-equals a tombstoned value for that target - a
DIFFERENT proposed value still suggests (new information beats an old
dismissal). Clear the target's tombstone when a human PATCH changes the
field (the human re-engaged with the field; the world moved). Accept flow
unchanged. Today-page pending counts must exclude tombstones (sparse
`_pendingPartition` already handles this if tombstones drop it).

**Note.** The same loop applies to the `status` target while a tenant sits
in `onboarding` (the only stage that ever produces a status suggestion) -
one tombstone mechanism covers all targets.
