---
id: intake-card-hides-pending-suggestions
title: Eligibility-intake card hides when empty - swallowing its pending suggestion chips
type: bug
severity: low
status: resolved
resolved: 2026-08-03
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

**Resolution (2026-08-03) - fixed by the general always-render rule.** Both
structured-intake cards now render EVERY field always, with an em-dash placeholder
for anything unrecorded, per
`docs/superpowers/specs/2026-08-03-intake-cards-show-all-fields-design.md`. Because
chips hang off rows, always-present rows mean a pending suggestion always has a row
to attach to. This supersedes the narrower fix shape proposed above ("render the card
when EITHER intake content exists OR a pending suggestion targets one of its fields"),
which would have surfaced the card but still needed per-row special-casing for the
suggested field. Human decision (Cameron, 2026-08-03) to resolve it this way. Pinned by
the `regression: intake-card-hides-pending-suggestions` case in
`dashboard/src/routes/contact/EligibilityIntakeCard.test.tsx`.
