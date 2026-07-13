---
id: matching-property-picker-discoverability
title: Matching composer's Property picker looks absent until you type (bare "Send a property" flow)
type: bug
severity: med
status: resolved
area: dashboard/matching
created: 2026-07-13
resolved: 2026-07-13
refs: dashboard/src/routes/contact/UnitSearchField.tsx, dashboard/src/routes/broadcasts/BroadcastComposer.tsx
---

**Problem.** From the Matching home page, "Send a property" opened the bare
composer with an inline Property typeahead that showed NO options on focus
(empty-query filter returns []), so the flow read as missing even though it
worked once you typed. Reported by Cameron 2026-07-13.

**Resolution (2026-07-13).** Superseded by the property-first composer
(feat/matching-property-first, spec amendment of the same date): a send now
STARTS on a dedicated property-selection step - a browsable candidate list
plus search - before the message or audience sections exist, for bare, tenant-
seeded, and every other no-unit entry. There is no longer a property-less
compose to discover a picker inside. (Note: this file may exist as `status:
open` on the fix/sent-to-tenants-row branch, filed before the redesign - the
resolved version is current.)
