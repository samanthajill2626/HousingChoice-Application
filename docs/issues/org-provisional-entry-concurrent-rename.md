---
id: org-provisional-entry-concurrent-rename
title: An org picker's provisional entry from "Is this really new?" outlives a concurrent rename - the picker offers the stale name until the dialog closes
type: bug
severity: low
status: open
area: dashboard/orgs
created: 2026-10-07
refs: dashboard/src/routes/orgs/useOrgList.ts:88, dashboard/src/routes/orgs/useOrgList.ts:127, dashboard/src/routes/orgs/useOrgList.ts:136-145, app/src/lib/orgNames.ts:258-272, app/src/repos/orgListRepo.ts:162
---

**Problem.** When "Is this really new?" settles on an entry ("Use <name>", "Yes, add it"),
`noteAdded` keeps that entry as a PROVISIONAL one beside the list read, so a renamed entry
used from the dialog never reads "Not on the list" while the re-read is in flight (code
review R2-FE-7, fix B16). The provisional entry is dropped only by a read carrying the
SAME orgId AND name (`dashboard/src/routes/orgs/useOrgList.ts:88`); a later `noteAdded`
for the same orgId is ignored (`:127`); and while it lives, its name and kind override the
read's copy (`:136-145`). So when an admin renames that entry again while a VA's dialog is
open - Settings exists to clean names, so concurrent edits are the use case - the server's
name moves on and the provisional entry never yields: for the dialog's life the picker
offers the stale name, and a later "Use <the current name>" (a fresh check) is ignored,
its chip reading "Not on the list". Saving the stale name loses nothing: D5 stores the old
name, now a spelling of the renamed entry, as that entry's exact name
(`app/src/lib/orgNames.ts:258-272`). Code review R3-FE-2
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R3-FE.md`; the mechanism
reproduced on the hook, the trigger plausible), ruled to file rather than fix
(`R3-adjudications.md` there). Filed during the clean-org-names build
(`feat/clean-org-names`).

**Suggested fix.** The list read is one strongly consistent, uncached GetItem
(`app/src/repos/orgListRepo.ts:162`), so a read that STARTED after the answer is at least
as new as it. Tag each provisional entry with the load `noteAdded` starts; let it override
only data from an older read, and drop it when any read started at or after its load
lands, whatever the name. Let a newer `noteAdded` for the same orgId replace the older
one. R2-FE-7 stays fixed: a read that predates the answer still cannot undo it.
