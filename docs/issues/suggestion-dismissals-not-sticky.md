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

**Fix - dismissal tombstones (Cameron's ruling 2026-07-21).** On dismiss,
write a tombstone item recording the dismissed target + NORMALIZED
suggestedValue (per-value, so several rejected values can accumulate per
target). In apply's suggest path, skip when the proposed value
normalized-equals a tombstoned value for that target - a DIFFERENT
proposed value still suggests (new information beats an old dismissal).
Tombstones are PERMANENT: a human edit of the field does NOT clear them -
a dismissal means "this value is wrong for this contact" and that judgment
does not expire (accepted trade: future genuine re-evidence of the same
value stays suppressed; staff see those conversations themselves). Accept
flow unchanged. Tombstones must not appear in pending lists or Today
counts (keep them out of the byOwner/byPending GSIs).

**Note.** The same loop applies to the `status` target while a tenant sits
in `onboarding` (the only stage that ever produces a status suggestion) -
one tombstone mechanism covers all targets.
