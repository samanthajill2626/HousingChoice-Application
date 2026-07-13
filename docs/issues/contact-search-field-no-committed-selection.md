---
id: contact-search-field-no-committed-selection
title: ContactSearchField has no committed-selection state (list lingers after pick; typing silently unlinks)
type: bug
severity: med
status: resolved
area: dashboard
created: 2026-07-13
resolved: 2026-07-13
refs: dashboard/src/routes/contact/ContactSearchField.tsx:56, dashboard/src/routes/contact/UnitSearchField.tsx
---

**Problem.** ContactSearchField is a line-for-line sibling of UnitSearchField
and shares the defect Cameron reported against the unit typeahead on the
schedule-tour form (fixed on `fix/unit-search-committed-state`): after picking
a candidate, the suggestion list stays open (the picked label still matches its
own candidate), and the input stays free-text, so further typing silently drops
`contactId` with no visual feedback. Affected editable surfaces: ScheduleTourForm
tenant side (when opened from /tours), PlacementCreateForm tenant side,
UnitCreateForm owning-landlord picker, ConversationDetail add-member.

**Suggested fix.** Mirror the UnitSearchField committed-selection state: when
`value.contactId` is set, hide the list, render the input read-only, and show a
Clear button that resets to `{ name: '' }` and refocuses. CAUTION - two
consumers need per-surface review before mirroring blindly:

- RelationshipsEditor binds rows loaded from the server, so every already-linked
  relationship row would render locked-with-Clear. Probably the right UX
  (linked = locked; Clear to unlink and retype) but it changes an existing edit
  surface and its tests.
- ConversationDetail's add-member hint says "Search a contact, or type a phone
  number" - free-typed phone entry must stay possible when nothing is picked
  (it is: committed state only engages after a pick).
- RecipientPreview add-a-tenant clears the field on every successful pick, so
  the committed state never renders there; unaffected.

**Resolution (2026-07-13).** Mirrored the UnitSearchField committed-selection
state into ContactSearchField on the same branch (fix/unit-search-committed-state):
list gated on `!isSelected`, input readOnly when linked, "Clear <inputLabel>"
button resets to `{ name: '' }` and refocuses. RelationshipsEditor linked rows
now render locked-with-Clear (Clear unlinks: empty name, contactId key absent -
the free-type unlink test was rewritten to the Clear path, and an unlinked-row
free-typing test keeps the pre-pick contract pinned). ConversationDetail's
free-typed-phone entry is unaffected (committed state only engages after a pick);
RecipientPreview never stores the pick, so it never renders committed.
