---
id: possible-caseworkers-and-roster-refusal-scans
title: The Possible caseworkers read scans three contact partitions, and the conversion's roster refusal scans every unit inside an interactive action
type: improvement
severity: low
status: open
area: app/contacts
created: 2026-10-08
refs: app/src/services/possibleCaseworkers.ts, app/src/services/caseworkerConversion.ts, docs/issues/tours-tabs-load-every-contact-for-names.md, docs/issues/perf-pages-contacts-caseworkers-surface.md
---

**Problem.** Two reads added by `feat/caseworkers` (spec D19) have no index
behind them. `GET /api/contacts/possible-caseworkers` reads the WHOLE
tenant, landlord and partner partitions of the contacts table on every load
of Contacts > Caseworkers (its signals - a role, a notes line, a
relationship row, a partner with no role - are not indexed), then filters in
memory. And the caseworker conversion's roster refusal - is this contact on
any property's contact list? - is one Scan of every unit, deleted units
included, inside the interactive preview and the Make caseworker click.
Both are fine at today's counts; both grow linearly with the data, the
`tours-tabs-load-every-contact-for-names` cost class. The page is also not
profiled (`perf-pages-contacts-caseworkers-surface`).

**Suggested fix.** Revisit when the contact or unit count grows: a sparse
GSI on a server-computed `caseworker_candidate` attribute (written on the
writes that change a signal) for the Possible list; a contact-to-units
roster index (or a reverse `rosterUnitIds` attribute maintained by the
roster routes) for the refusal. Profile the page first.
