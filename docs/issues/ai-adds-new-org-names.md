---
id: ai-adds-new-org-names
title: The AI cannot add a confirmed-new housing authority or agency to the list itself (Work Package 2)
type: improvement
severity: low
status: open
area: app/extraction
created: 2026-10-07
refs: app/src/services/extraction/apply.ts, app/src/lib/orgNames.ts
---

**Problem.** When a conversation names a housing authority that is not on the
organization list, extraction only SUGGESTS it (clean-org-names, spec D8): staff open the
suggestion, and "Is this really new?" lets them add the name before accepting. The AI
never adds a name to the list on its own - deliberately, for now: an unchecked add is
how one authority ends up with two names. Sam asked (tracker #2) that the AI make the
same is-it-really-new check staff make, so a genuinely new authority or agency would not
wait on a person.

**Suggested fix.** In Work Package 2, let the AI PROPOSE a new entry with its evidence
(the closest list names and why the text is different - the same close-name rules as
`closeNames` in `app/src/lib/orgNames.ts`, and the D13 limits), held for one-click staff
confirmation and never applied automatically, and record the proposal in the AI run
log. A spec non-goal for clean-org-names (section 2).
