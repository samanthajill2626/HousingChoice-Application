---
id: matching-composer-422-unmatched-member-clears-filter
title: A 422 naming a housing authority the blast composer does not show empties the WHOLE authority filter, widening the blast
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx:256-268, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:213-220, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:65-67, dashboard/src/routes/broadcasts/useComposerDraft.ts:198, app/src/routes/broadcasts.ts:658-681, docs/superpowers/plans/2026-10-14-matching-blast-rules.md:6582
---

**Problem.** When a 422 `org_not_on_list` from the draft create or from
Preview names a `text` that matches no housing authority on screen (or
carries no `text`), `rejectAuthority` empties the WHOLE filter
(`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:256-268`; the
`next = kept.length < current.length ? kept : []` line, `:265`). An empty list
is no housing authority filter (`:213-220`), the broadest audience, and the
notice names only the refused text (`authorityLeftTheList`, `:65-67`).

This is the designed fallback, not an accident: the plan's S3 design note
(`docs/superpowers/plans/2026-10-14-matching-blast-rules.md:6582`) empties the
list instead of leaving the composer stuck on a filter the server refuses -
without it the same draft would answer 422 on every Preview. It is the one
exception to spec D3b (a 422 removes THAT member only and keeps the others),
noted by the conformance review as CONF-4.

Trigger (rare - the organization list must change twice while one composer
stays open):

1. the composer reads the list with entry X;
2. an admin renames X to Y (X becomes a spelling of Y);
3. the draft create sends X and the server stores Y (`checkListWrite`
   resolves the spelling) while the screen still says X;
4. an admin renames or deletes Y;
5. Preview's `storedFilterRefusal` (`app/src/routes/broadcasts.ts:658-681`)
   answers 422 with `text: 'Y'`;
6. Y matches nothing on screen, so every member is dropped and the next draft
   reaches every housing authority.

The cleared chips, the notice and the reach count are visible. Code review R1
ADV-4 (`docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/r1-adversarial.md`)
and CONF-4 (`r1-conformance.md`, same folder), ruled FILE in
`r1-adjudications.md`: not widening the audience needs new recreate
machinery - the draft hook makes no new draft while its material inputs are
unchanged (`dashboard/src/routes/broadcasts/useComposerDraft.ts:198`).

**Suggested fix.** The review's alternatives; never widen the audience as a
fallback:

- On a refusal whose text is not on screen, keep the on-screen list and force
  a recreate from it - the server re-resolves each on-screen name at create,
  so the stale stored name is replaced (needs a way to force a recreate with
  unchanged inputs).
- Or, safe but stuck: on a refusal whose text is not on screen, keep the
  on-screen list (never widen) and show the notice; staff remove a chip by
  hand, which recreates the draft. (Mapping the stored name back through the
  422's `candidates` does NOT work for this trigger: `storedFilterRefusal`
  lists the entry the STORED text resolves to - forward, never back to the
  on-screen name - so a deleted Y gives `candidates: []` and a Y renamed to Z
  gives `[Z]`; code review R2 FW-1.)

Either way drop the "never expected" comment and add the review's regression
test (ADV-422-fallback): a Preview 422 for a stored name the screen does not
hold keeps the members on screen (today the recreated draft carries no
`housing_authorities`). Related:
[composer-org-422-offer-renamed-entry](./composer-org-422-offer-renamed-entry.md)
(offer the renamed entry instead of removing the member).
