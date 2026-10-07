---
id: org-settings-notice-stale-after-add
title: "Settings > Housing authorities & agencies: a 'Not kept as a spelling' notice from an earlier rename survives a later Add"
type: bug
severity: low
status: open
area: dashboard/settings
created: 2026-10-07
refs: dashboard/src/routes/settings/OrgListSection.tsx:307-310, dashboard/src/routes/settings/OrgListSection.tsx:168-172
---

**Problem.** Settings > Housing authorities & agencies keeps one page notice for a result
staff should see (the `notice` state in `OrgListSection`,
`dashboard/src/routes/settings/OrgListSection.tsx:143`): the "Not kept as a spelling: ..."
notice a rename or a "Not on the list" action leaves when spellings were skipped (spec
D12), or the copy of a failed Run again. Worklist item RE2-3
(`docs/superpowers/reviews/2026-10-06-clean-org-names/build-research/worklist.md`) made a
later successful action clear it, but only in two places: `closeAndReload` (the notes,
spellings, merge, change-kind and delete dialogs) calls `setNotice(null)`, and `onRenamed`
sets the notice to its own result or `null`. The `onAdded` handler of the "Is this really
new?" dialog that the section's Add buttons open (`:307-310`) does not clear it - it only
closes the dialog and reloads the list. So after a rename that skipped a spelling, adding
a name leaves "Not kept as a spelling: ..." on the page, describing an action that is no
longer the latest. Cosmetic: no stored data is wrong, and the next other successful
action, or a page reload, clears it. Filed during the clean-org-names build
(`feat/clean-org-names`).

**Suggested fix.** Call `setNotice(null)` in the Settings `onAdded` handler, as
`closeAndReload` does, and pin it in `dashboard/src/routes/settings/OrgListSection.test.tsx`:
a rename that skips a spelling shows the notice, and a following Add removes it.
