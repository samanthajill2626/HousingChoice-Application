---
id: composer-org-422-offer-renamed-entry
title: "Blast composer: a draft whose housing authority was RENAMED is cleared with 'no longer on the list - pick it again' instead of offering the new name"
type: improvement
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-07
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:117-130, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:342-345, app/src/routes/broadcasts.ts:467
---

**Problem.** A blast draft stores its housing authority filter as the exact list name. When
that entry is renamed in Settings, the old name becomes one of its spellings, and Preview
re-checks the stored filter (spec D7): the server answers 422 `org_not_on_list` with the
renamed entry as the ONE candidate - deliberately, so the composer can offer it
(`storedFilterRefusal`, `app/src/routes/broadcasts.ts:467`). The composer ignores the body:
it clears the pick and says "That housing authority is no longer on the list - pick it
again" (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:117-130`, `:342-345`),
although the entry was renamed, not removed, and the operator has to find it again under its
new name. This conforms to spec D7 (a 422 "asks for a new pick"), so it is a missed
shortcut, not a defect. Code review R1-ADV-FE-10
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R1-ADV-FE.md`), ruled to
file. Filed during the clean-org-names build (`feat/clean-org-names`).

**Suggested fix.** When the 422 carries exactly one candidate, re-pick it with a notice that
names the rename (for example "Now listed as Atlanta Housing Authority - check the filter and
preview again"), or offer "Use <name>" beside the cleared picker. Keep the clear-and-ask path
for no candidate or several. Put the copy in the dashboard's org copy
(`dashboard/src/routes/orgs/orgCopy.ts`).
