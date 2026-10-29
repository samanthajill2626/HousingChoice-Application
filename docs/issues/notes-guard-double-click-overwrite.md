---
id: notes-guard-double-click-overwrite
title: A double-click on Save after a stale notes refusal overwrites the current notes before the user sees them
type: bug
severity: low
status: open
area: dashboard/contact
created: 2026-10-29
refs: dashboard/src/routes/contact/ContactEditForm.tsx:707, dashboard/src/routes/contact/ContactEditForm.tsx:750, dashboard/src/routes/contact/ContactEditForm.tsx:764, dashboard/src/routes/contact/StaffNotesCard.tsx:146, dashboard/src/routes/contact/StaffNotesCard.tsx:217
---

**Problem.** Both Notes stale-save guards - the contact edit form's Notes
box (WP1 B2a spec D14.3) and the Staff notes card (spec
2026-09-26-staff-notes-past-tours-design.md section 3.9) - rest on one
premise: after a 409 refusal the user has SEEN the current notes, so the next
Save is "a deliberate overwrite of notes the user has now seen". One gesture
breaks it. Click 1 sends the stale save; the 409 (`notes_stale` /
`staff_notes_stale`) answers, the form re-bases its baseline on the CURRENT
stamp (ContactEditForm.tsx:707 onward; StaffNotesCard.tsx:136-143) and turns
Save back on (`setSaving(false)`, ContactEditForm.tsx:750 with `canSave` at
:764; StaffNotesCard.tsx:146 with the button at :217). If the 409 lands inside
the double-click interval - a PATCH round trip is roughly 60-150 ms through
CloudFront, a habitual double-click 100-250 ms - click 2 submits the box
again with the re-based stamp, and it lands: the colleague's lines, or
extraction's `[Auto - ...]` lines, are replaced although the conflict panel
was never seen.

Found by the WP1 B2a code review round 2 (reviewer R2-dashboard, finding
R2-dashboard-1): CONFIRMED in jsdom for the edit form (a throwaway test: an
update that rejects once with 409 notes_stale and its contact, then
resolves; one `userEvent.dblClick` on Save sent TWO PATCHes, the second with
`notes_expected_updated_at` = THEIR stamp, and `onSaved` ran once). The real
timing is plausible, not measured; the Staff notes card has the same shape
but was not run.

Why it matters: it is the one path left by which either card drops Notes
lines silently, and since B2a the contact Notes box is ranking evidence (the
tenant card and its feedback lines). Bounded: it needs a stale form AND a
double-click AND a fast 409, and the outcome equals the behavior before the
guards existed.

**Suggested fix.** After a stale refusal, ignore submits for a short settle
window (for example keep Save disabled about 750 ms after the conflict panel
renders), or make the overwrite a distinct control ("Replace the current
notes") that only a fresh click after the panel renders can press. Apply the
same to both cards. Test: the reproduction inverted - one double-click on a
stale form sends ONE PATCH and leaves the panel showing (both cards).

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R2-dashboard.md (R2-dashboard-1) and R2-adjudications.md.
