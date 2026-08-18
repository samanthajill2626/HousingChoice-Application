---
id: partner-widening-consumer-test-gap
title: The partner widening has consumer coverage on only two of eight surfaces
type: debt
severity: low
status: open
area: dashboard/contacts
created: 2026-08-18
refs: dashboard/src/routes/contacts/useContacts.ts:57-70, dashboard/src/routes/shared/PeopleCard.tsx:732
---

**Problem.** `TYPES_FOR.all` (and `TYPES_FOR.deleted`) gained `'partner'` on the
contact-create-relay-group branch, so a partner - a caseworker or agency contact
- is now a candidate on EVERY surface that reads `useContacts('all')`. That is
eight call sites, and only two have a test that a partner really comes back:

- `useContacts.test.tsx` - the hook itself: the fan-out asks for the partner
  type and the row survives into the returned list.
- `CreateRelayGroupModal.test.tsx` - one consumer: a `PARTNER` fixture is
  searchable, pickable, and lands in the posted members array.

The other six read the same widened list with no partner assertion of their own:

- `shared/PeopleCard.tsx:732` - the tour/placement ROSTER picker, the most
  consequential of the six: whoever it offers can be added to a live relay group
  and texted. It is also the one surface with its own filtering layer on top
  (roster membership, reachability), so a partner reaching the list is not proof
  a partner reaches the dropdown.
- `email/EmailTriage.tsx:238` - the link-to-contact picker.
- `conversation/ConversationDetail.tsx:191` - its test mock deliberately returns
  candidates for the TENANT fan-out only, so the partner leg is not exercised.
- `tours/ToursPage.tsx:181,185` - both the live and deleted lists.
- `listing/ListingDetail.tsx:184,185` - both lists.
- `contacts/ContactsList.tsx:137` - the All tab itself, where a partner row must
  render with the right kind label and survive the search filter.

Nothing here is known to be broken. The gap is that a regression narrowing the
fan-out again - or a per-surface filter that silently drops the new type - would
be caught by two tests on one flow rather than by the surfaces that show it.

**Suggested fix.** Add a partner fixture to the existing suites for the six
surfaces, asserting the candidate renders and survives that surface's own
filter. `PeopleCard` first: it is the one whose dropdown ends in a live send.
