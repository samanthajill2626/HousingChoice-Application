---
id: composer-org-422-offer-renamed-entry
title: "Blast composer: a filter member whose housing authority was RENAMED is removed with 'is no longer on the organization list' instead of offering the new name"
type: improvement
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-07
updated: 2026-10-18
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:62-67, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:245-268, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:533-538, app/src/routes/broadcasts.ts:643-679
---

**Problem.** A blast draft stores its housing authority filter as a list of exact list names
(matching-blast-rules D2). When one of those entries is renamed in Settings, the old name
becomes one of its spellings, and Preview re-checks every member of the stored filter (spec
D7): the server answers 422 `org_not_on_list` for the first member that is no longer a name,
with the renamed entry as the ONE candidate - deliberately, so the composer can offer it
(`storedFilterRefusal`, `app/src/routes/broadcasts.ts:643-679`). The composer reads only the
refused member's `text` from the body: since matching-blast-rules D3b it removes THAT member
alone (the rest of the filter stays) and says "<text> is no longer on the organization list,
so it was removed from the filter." under the picker
(`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:62-67`, `:245-268`; the Preview path
`:533-538`), although the entry was renamed, not removed, and the operator has to find it
again under its new name and pick it. This conforms to spec D7 and to matching-blast-rules
D3b (a 422 removes only the named member), so it is a missed shortcut, not a defect. Code
review R1-ADV-FE-10
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R1-ADV-FE.md`), ruled to
file. Filed during the clean-org-names build (`feat/clean-org-names`), when the 422 cleared
the whole filter with "That housing authority is no longer on the list - pick it again";
refreshed 2026-10-18 for the one-member removal (`feat/matching-blast-rules`, tracker #6).

**Suggested fix.** When the 422 carries exactly one candidate, put that name in place of the
removed member (a re-pick) with a notice that names the rename (for example "Now listed as
Atlanta Housing Authority - check the filter and preview again"), or offer "Use <name>"
beside the picker. Keep today's remove-the-member path for no candidate or several. Put the
copy in the dashboard's org copy (`dashboard/src/routes/orgs/orgCopy.ts`).
