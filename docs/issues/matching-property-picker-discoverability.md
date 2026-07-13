---
id: matching-property-picker-discoverability
title: Matching composer's Property picker looks absent until you type (bare "Send a property" flow)
type: bug
severity: med
status: open
area: dashboard/matching
created: 2026-07-13
refs: dashboard/src/routes/contact/UnitSearchField.tsx, dashboard/src/routes/broadcasts/BroadcastComposer.tsx
---

**Problem.** From the Matching home page, "Send a property" opens the bare
composer (/broadcasts/new, no params). The Property typeahead IS rendered there
and the full flow works end to end (verified live 2026-07-13: type an address
fragment, pick, the property attaches - bedroom-size prefill, flyer note,
availability banner all fire). But the field is UNDISCOVERABLE:

- UnitSearchField's filterCandidates returns [] for an empty query, so
  clicking/focusing the field shows NO options.
- The input has NO placeholder and no other affordance that typing searches
  the property roster.

Net effect: staff click "Send a property", see a dead-looking empty "Property"
text box with no dropdown, and reasonably conclude there is no way to select a
property from this flow (reported by Cameron exactly this way).

**Suggested fix.** Make the picker discoverable without changing the flow:

1. On focus with an EMPTY query, show the first MAX_SHOWN candidates (a
   browse-able starter list) instead of nothing; typing then filters as today.
2. Add a placeholder to the input, e.g. "Search properties by address...".

Both belong in UnitSearchField (its ContactSearchField sibling has the same
empty-query behavior; decide there whether tenants/members want the same
focus-time starter list, or scope the change to UnitSearchField via a prop).
Cover with a component test (focus -> options visible before any typing) and
extend the matching-entry-points e2e's picker step to pick WITHOUT typing.
