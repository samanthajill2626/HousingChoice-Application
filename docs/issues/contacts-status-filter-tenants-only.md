---
id: contacts-status-filter-tenants-only
title: The Contacts list has a status filter on the Tenants view only - Landlords, Caseworkers, Unknown and All have none
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-23
refs: dashboard/src/routes/contacts/ContactsList.tsx:217, dashboard/src/routes/contacts/tenantFacets.ts:69
---

**Problem.** The Contacts page has six views (All, Tenants, Landlords,
Caseworkers, Unknown, Deleted). Only the Tenants view has a status filter
(`isTenantView` gates the facets, `ContactsList.tsx:217`), and it hides
Inactive and Placed tenants by default (`tenantFacets.ts:69`). Every other
view lists every contact of its type whatever its status, with no way to
narrow by status.

This matters more once tracker #30 lands: caseworkers, team members and
unknown contacts gain an Inactive status, and landlords already have Parked.
Staff can set those statuses, but the Landlords, Caseworkers and Unknown views
cannot hide or isolate them. On the Unknown view, Inactive contacts now list
after the Needs review ones (tracker #30) but still show there; the
Caseworkers view sorts by name, so a retired caseworker stays mixed in with
the ones staff are working.

Raised by Cameron 2026-10-23 during the #30 scoping and kept out of #30 on
purpose ("that's a hole that needs an issue filed, but let's not add it in
this tracked improvement number 30").

**Suggested fix.** Give each typed view a status filter built from that type's
own status list (`statusAllowlistFor` in `app/src/lib/statusModel.ts`), the
same way the Tenants view uses `TENANT_STATUSES`. Decide per view whether the
retired status (Inactive / Parked) is hidden by default, matching the Tenants
view's rule. The All view mixes types, so its filter needs a separate
decision.
