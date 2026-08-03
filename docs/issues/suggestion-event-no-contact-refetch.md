---
id: suggestion-event-no-contact-refetch
title: suggestion.updated refreshes the chips but NOT the contact's field values
type: bug
severity: low
status: resolved
area: dashboard
created: 2026-07-21
resolved: 2026-08-03
refs: dashboard/src/routes/contact/useSuggestions.ts, dashboard/src/routes/contact/useContact.ts
---

**Resolution (2026-08-03).** Fixed on `feat/suggestion-tombstones`, now MERGED to main
(branch + worktree deleted during cleanup). `useContact` now live-refetches the contact
record in place when a `suggestion.updated` event names the viewed contact
(`dashboard/src/routes/contact/useContact.ts:52`), so direct-written fields and their Auto
badges appear without a manual reload - matching the chip refresh `useSuggestions` already did.

**Problem (observed live on dev, 2026-07-21).** The event-bridge made the
worker's `suggestion.updated` emit reach the browser, and
`useSuggestions` live-refetches the CHIPS on it - but nothing refetches
the CONTACT record itself. An extraction run that DIRECT-writes fields
(voucherSize, housingAuthority, pets, address, ...) therefore updates the
chips live while the Details panel keeps showing the stale field values
(and no Auto badges) until a manual page reload. Observed on the
Natalie/voicemail retest: extraction wrote 4+ fields; the open contact
page needed a refresh to show them.

**Fix shape.** On `suggestion.updated` for the viewed contact, also
refetch the contact (or have ContactDetail subscribe alongside
useSuggestions and call its existing reload). The event already fires for
every apply outcome (writes, suggestions, or notes), so it is the right
signal; payload is `{ contactId }` - cheap targeted refetch, same pattern
useSuggestions already uses.

**Related.** [[patch-supersession-no-suggestion-event]] (PATCH emits no
event at all) - fixing both makes the contact page fully live for the
extraction loop.
