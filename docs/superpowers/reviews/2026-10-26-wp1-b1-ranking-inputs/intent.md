# Intent record - WP1 B1 Ranking inputs

Mission: Amendment No. 1 Work Package 1, slice B1 of 4 ("Ranking inputs").
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(section 15.1 B1 row; details in 6.3, 6.4, 7.3, 9.2). Charter decisions
bind; a change goes to Cameron and is recorded in the charter (section 20).

Planner session: 16d60dc4-e0e1-44a2-956e-9be4142cab3b (Claude Opus 5.5).
Worktree: W:\tmp\wp1-b1-ranking-inputs, branch feat/wp1-b1-ranking-inputs,
cut from main @d0e2c2d8.

## STATE

Phase: SPEC GATE. Spec rev 4 (1f63fddf) after 3 design-review rounds
(terminal round 3; 40 findings, all accepted). Waiting on Cameron: pass
the spec gate and answer Q1-Q3 (section 8 of the spec). Next after his
answers: fold them in, offer compaction gate A, write the plan, plan
review, mission block, launch gate. Nothing in flight.

## What Cameron asked for (verbatim where wording matters)

2026-10-26 (intake): "Charter decisions bind (sections 0 and 15.4). If one
needs to change, bring it to me; do not change it in the slice spec.
Estimate is 8-10 of my hands-on hours, and this slice is how we measure
real hours against the charter's estimates, so keep the estimate honest at
plan time."

2026-10-26, on the restatement's two questions:
- "No, I don't think that the never-written list should cover new
  free-text fields too."
- "I actually think that I want to get rid of the switch since we're not
  using it to actually send anything directly. We don't need that switch.
  It's just an extra headache. Let me know if I need to go back to the
  Charter agent and have that updated in the charter." -> planner amends
  the charter on this branch (section 20); the never-written test becomes
  B1's merge gate in place of the switch.

2026-10-26, on the never-written list: asked to confirm it means "certain
things that we're never going to write to notes". Answered: kinds of facts
EXTRACTION never writes as a Notes line or reaction text; staff may type
anything. He then said:
"I think that there's a larger question here around data extraction in
general. It seems like we're not doing this correctly because we have
multiple different places where data exists that's not part of the person.
These additional fields that we're trying to add on a tenant, I'm pretty
sure they should all just sit in notes. What I don't want is for this to
stop us progressing on this B1 slice. However, I think eventually what I'm
going to do is change the way that the extraction runs. All of these extra
fields will end up being extracted into notes rather than put into specific
fields on a tenant, like location or matched rent amount, etc. We need to
build this in such a way that the inputs to our matcher model can be easily
adjusted, and the source of information, like area preferences, can be
easily changed from a specific field to just existing in the notes
section."

2026-10-26: "Okay, go. Let's cut the work tree, commit the charter
amendment, and then file the issue and write the spec."

## Why

Preference data should start accumulating before anything ranks (charter
15.2). B1 also measures Cameron's real hands-on hours against the charter
estimate (8-10) before the WP1 scope question is revisited.

## Preferences and taste calls

- Keep the four fields because A1 names them, but build them thin and
  behind ONE list of tenant matching inputs with their sources, so moving a
  fact to notes is a one-place change (planner proposal, accepted with the
  go).
- No switches that protect nothing: extraction sends nothing, so the merge
  gate is the protection.

## Rejected options

- Extending the never-written list and its test to the free-text fixed
  fields (Cameron: no).
- `AI_MATCHING_NOTES_ENABLED` (Cameron: dropped).
- Dropping the four fields from B1 now: departs from A1's signed text;
  retired later through extraction-fields-to-notes instead.

## Explicit NOs

- No charter decision changed inside the slice spec.
- No infra, deploys, or live-stack testing; hermetic e2e only.
- Never-written test uses SYNTHETIC conversations on the testing key only.

## Open questions / assumptions

- EXTRACTION_FACT_MIN_CONFIDENCE default: set in the slice spec.
- The hours estimate is firmed at plan time.
