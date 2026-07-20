---
id: patch-supersession-no-suggestion-event
title: Human-edit suggestion supersession emits no suggestion.updated - open pages keep stale chips
type: bug
severity: low
status: open
area: app
created: 2026-07-20
refs: app/src/routes/contacts.ts:1255, dashboard/src/routes/contact/useSuggestions.ts:65, dashboard/src/routes/today/useToday.ts:145
---

**Problem.** The contacts PATCH supersession loop deletes every pending
suggestion whose target is a changed field, but emits NO
`suggestion.updated` event (grep: routes/contacts.ts emits only
placement/conversation events). The dashboard IS wired for the push -
EventStreamProvider dispatches `suggestion.updated` to
`useSuggestions` (refetch) and `useToday` (scheduleRefetch) - and the
accept/dismiss routes DO emit it. Net effect: after a human edits a field
with a pending AI suggestion, the OPEN contact page keeps rendering the
stale chip (and Today keeps its count) until a manual reload, even though
the server deleted the suggestion. Verified live 2026-07-20 during
address-extraction self-QA: human address edit -> `address_source`
cleared and suggestion deleted server-side (API shows `suggestions: []`),
badge disappears in place, but the address chip stayed visible until
reload. The gap is target-generic (pets/voucherSize/etc. behave the same)
and predates the address slice - the edit form's `onSaved` only does
`setContact(updated)`, by design, expecting the SSE push to prune chips.

**Suggested fix.** In the PATCH handler, after the supersession loop (and
only when at least one deleteSuggestion succeeded, or unconditionally -
the consumers just refetch), emit `events.emit('suggestion.updated',
{ contactId })` exactly as routes/suggestions.ts does on accept/dismiss.
One line plus a route test asserting the emit on a superseding PATCH.
