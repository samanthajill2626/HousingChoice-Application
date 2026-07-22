---
id: intake-card-hides-pending-suggestions
title: Eligibility-intake card hides when empty - swallowing its pending suggestion chips
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-21
refs: dashboard/src/routes/contact/EligibilityIntakeCard.tsx
---

**Problem (found while pinning dismissal tombstones in e2e).** The
Eligibility-intake card does not render when the contact has no intake
content - and its suggestion chips vanish with it. A pending AI suggestion
for an intake target (pets/evictions/tenure/...) on an otherwise-empty
contact is therefore INVISIBLE inline: it exists in the store, counts on
the Today page, but staff cannot see or act on it from the contact page.
Reproduced: an extraction suggested `evictions` on a contact with no
intake fields; the API returned the pending suggestion; the page showed no
card and no chip.

**Fix shape.** Render the card when EITHER intake content exists OR a
pending suggestion targets one of its fields (the suggestions list is
already passed down for the chips).
