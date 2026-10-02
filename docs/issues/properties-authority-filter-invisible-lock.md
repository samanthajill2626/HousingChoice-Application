---
id: properties-authority-filter-invisible-lock
title: The properties-list authority filter keeps filtering after its chips and Clear disappear
type: bug
severity: med
status: resolved
resolved: 2026-10-01
area: dashboard
created: 2026-08-10
refs: dashboard/src/routes/listings/ListingsList.tsx, dashboard/src/routes/listings/propertyFacets.ts, dashboard/src/routes/listings/ListingsList.test.tsx
---

**Resolution (2026-10-01).** Fixed on `feat/properties-available-view` (tracker #1), which
moved the whole properties-list filter state into the URL and copied the tenant list's prune.
Two independent defenses now hold: (1) the Active/Deleted tab links carry no query (only the
current tab's own link keeps it), so switching views starts from a clean selection; (2)
`propertyFacets.pruneSelection` drops any authority key no chip shows - including a stale or
hand-typed `?ha=` - before anything filters, and the authority group renders whenever the view
has units (a Not recorded chip joins it when some unit lists no authority), so every surviving
selection is a lit chip with a Clear. Pinned by `ListingsList.test.tsx` ("an authority picked
on Active never filters the Deleted tab", "a stale authority key in a link does not empty the
list"); disabling the prune fails the second one. The original report follows.

**Problem.** On the properties list, `selectedHAs` is component `useState` (never in the URL),
and BOTH the authority chip group and its per-facet Clear button are gated on
`housingAuthorities.length > 0`, while the filter predicate runs unconditionally. So a selection
can stay ACTIVE after the only controls that could reveal or clear it have vanished.

Reachable in one session, without touching the URL:

1. On the Active status view, select an authority chip.
2. Click the Deleted status view. Deleted units exist, but if none of them carries an authority,
   `housingAuthorities` is empty.
3. The chip group and its Clear button both disappear, the still-active `selectedHAs` filters the
   list to zero rows, and there is no control left to undo it.

The reviewer established that the component genuinely stays mounted across the switch two ways:
the sibling routes in `dashboard/src/App.tsx:149-150` follow the same pattern that
`ContactsList.tsx:141-144` documents as staying mounted, and `useListings`' `forDeleted`
derive-loading machinery only exists BECAUSE there is no remount.

**PRE-EXISTING**, not introduced by the tenant-list-visibility feature: that feature changed only
how the options are DERIVED (now from `authoritiesOf()` with normalized-key grouping) and left
the state model and the render gate untouched. It is filed rather than fixed because repairing it
means changing the properties list's state model or its gate, which is its own change with its
own test surface (`ListingsList.test.tsx:118,121,126,140,141` pin the current chip and label
shape).

**Suggested fix.** The tenant list solved exactly this class in the same feature and is the
pattern to copy - see `dashboard/src/routes/contacts/ContactsList.tsx` (the selection prune
around `:157-194`) and its rationale comment: a selection the user can neither SEE nor CLEAR
must not filter. Concretely, prune `selectedHAs` to the keys actually present in the rendered
option list before applying it, or keep the group rendered whenever a selection is non-empty so
the Clear button survives. Pin whichever with a test that fails first: select an authority, swap
to a status view whose units carry none, assert the rows are not filtered to zero.

Found by the adversarial reviewer (round 2, finding R2-1) during the tenant-list-visibility
mission.
