# INV findings - plan-independent invariant sweep (build research)

Area: INV (the six protected-state sweeps: contact housingAuthority writers vs
the D10 audit list, capture_source 'housing_fair', the housing_fair_signup_v2
marker, status readers, the org-list item, the /public surface).
Tree: feat/join-housing-authority @34e79ec7 (code identical to main @5c0d3f6a).
Evidence and the full enumeration: `.superpowers/sdd/build-research/INV-reference.md`
(gitignored reference).

Summary: no BLOCKER, no MAJOR. The D10 audit event list is complete against
the live code (every REMOVE path is audited with a listed type and a payload
key that names the field); `public.ts:268` is the only `housing_fair` creator;
no code path can drop the marker; the public list read and the sign-up check
never write the org-list item; the edge guard and CloudFront need no change.
One MINOR unlisted consequence follows.

## INV-F1 (MINOR) - unlisted consequence: /join leads change position in the unfiltered tenant list

- Plan task / line: none (the spec's section 4 "Consequences to know",
  spec lines 265-297; the plan copies the spec at plan section 1).
- Live code:
  - `app/src/lib/tables.ts:91-93` - the byTypeStatus GSI range key is `status`.
  - `app/src/repos/contactsRepo.ts:1292-1331` - `listByType` queries that GSI
    with no `ScanIndexForward`, so rows come back in ascending status order:
    inactive, needs_review, on_hold, onboarding, placed, placing, searching.
  - `app/src/routes/contacts.ts:1092-1099` - `GET /api/contacts?type=tenant`
    returns that page order unchanged.
  - `dashboard/src/routes/contacts/ContactsList.tsx`, `useContacts.ts` - no
    client-side sort; rows render in server order.
- What is wrong: section 4 says new /join leads lose the Needs review status
  FILTER, but not that they also move in the UNFILTERED Contacts > Tenants
  list: today they sit right after Inactive tenants (the needs_review block);
  after the change a new lead sits after On hold, among Onboarding tenants.
  Behavior is otherwise correct and no invariant breaks - this is a
  display-order consequence for a /join lead that section 4 does not list
  (this sweep's brief treats every unlisted change as a finding).
- Correction (doc only, no code): add one line to the handback (and, if the
  orchestrator keeps spec notes, to spec section 4): "In the unfiltered
  Contacts > Tenants list, which is ordered by status, a new /join lead now
  appears among Onboarding tenants (after On hold), not among Needs review
  tenants near the top."
