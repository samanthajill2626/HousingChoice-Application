---
id: tenant-support-contacts-structured
title: Structured tenant-side support contacts (replace the free-text caseworker field)
type: improvement
severity: med
status: open
area: app
created: 2026-08-05
refs:
---

**Problem.** The tenant's support circle (caseworker, family member, advocate)
lives in a free-text `caseworker` field today. The contact-rosters feature
surfaces it as a read-only hint on the tour People card, but free text cannot
be rostered onto a group text, called through, or deduped against real
contacts - so the one person a tenant most wants in the loop is the one the
roster model cannot hold. Filed per the contact-rosters spec (section 12).

**Suggested fix.** Model tenant-side support contacts as real contact links
(contactId + relationship label) on the tenant record, so the roster
suggestion engine can offer them ("On this tenant's team: ...") exactly like
property-side members. Migration: keep rendering the legacy free-text value
until a structured link exists, then hide it.
