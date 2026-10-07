---
id: org-spellings-patch-blind-replace
title: "Settings > Housing authorities & agencies: saving an entry's spellings replaces the whole list blind, so a stale editor drops spellings the server added since"
type: bug
severity: low
status: open
area: app/organizations
created: 2026-10-07
refs: app/src/services/orgNames.ts:303, app/src/routes/organizations.ts:255, app/src/routes/organizations.ts:132, app/src/services/orgRewrite.ts:276-286, app/src/services/orgRewrite.ts:423-435
---

**Problem.** PATCH /api/organizations/:orgId with `{ spellings }` (admin) replaces the
entry's WHOLE spelling list with the list in the request (`OrgNamesService.updateSpellings`,
`app/src/services/orgNames.ts:303`). GET /api/organizations returns the item's `version`
(`app/src/routes/organizations.ts:132`), but no write checks one. So a save from an editor
opened before the server added a spelling silently drops that spelling: the old name a
rename keeps as a spelling (`app/src/services/orgRewrite.ts:276-286`), a value settled with
"Use" and "Remember this spelling" (`:423-435`), or the names and spellings a merge moves
onto its target. The dropped text then stops resolving: the AI list block, the importer, the
D5 form checks and "Not on the list" all treat it as unknown, and records still holding it
show up in "Not on the list" again. It takes two admins, or one admin with two tabs, editing
the same entry around a rewrite, so it is rare. Code review R1-ADV-BE-3
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R1-ADV-BE.md`) reproduced
it: read Atlanta's spellings, rename Atlanta (the old name is kept as a spelling), then save
the list as loaded plus one new spelling - the old name is gone. Filed during the
clean-org-names build (`feat/clean-org-names`).

**Suggested fix.** Either accept `expectedVersion` on PATCH /:orgId and refuse 409
`org_list_changed` on a mismatch (the dashboard reloads the entry and shows what changed), or
send spelling additions and removals instead of the whole list, so additions made meanwhile
survive. The version check is the smaller change.
