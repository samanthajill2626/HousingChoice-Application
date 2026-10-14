---
id: matching-add-recipient-search-caseworkers
title: Matching composer's "Add a tenant" search cannot add a caseworker to a blast by hand
type: improvement
severity: low
status: deferred
area: dashboard/matching
created: 2026-10-14
refs: dashboard/src/routes/broadcasts/RecipientPreview.tsx:73, dashboard/src/routes/broadcasts/RecipientPreview.tsx:604, app/src/routes/broadcasts.ts:352-361
---

**Problem.** Cameron's rule (2026-10-14, tracker #6 intake): a caseworker is
never included in a Matching blast automatically, just because they are a
caseworker; staff add one by hand or send them a property directly. Direct
send works today ("Send a property" on the caseworker's own page opens the
composer seeded with that contact). Adding one by hand does not: the
recipient review's "Add a tenant" search lists tenants only
(`getContacts({type:'tenant'})`), so a caseworker cannot join a blast that
started from the Matching page.

The server already accepts it: an explicitly checked recipient or a seed may
be a tenant OR a partner (`isDirectShareRecipientType`, spec 2026-10-06 D20),
so this is a dashboard-only change.

**Suggested fix.** Let the search also return partner (caseworker) contacts,
labeled as caseworkers, and persist the pick as a seed like any hand-added
tenant. Hand-picks skip the tracker #6 audience rules, so no hold or status
rule applies to the added row. Check the row's empty Voucher and Housing
authority cells and the partner-share e2e expectations.

Deferred by Cameron 2026-10-14: "it should, but we can leave it out of #6 for
now since we can direct send to them which is the most relevant use case."
