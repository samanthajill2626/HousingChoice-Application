# Intent record - WP1 B2 Ranking engine

Mission: Amendment No. 1 Work Package 1, slice B2 of 4 ("Ranking engine").
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(section 15.1 B2 row; amended through section 20 item 12). Charter
decisions bind (sections 0 and 15.4); a change goes to Cameron and is
recorded in the charter (section 20).

Planner session: 1f0c0695-9acd-40ad-b991-190e2c6c0770 (Claude Opus 5.5).
Worktree: W:\tmp\wp1-b2-ranking-engine, branch feat/wp1-b2-ranking-engine,
cut from main @404e039d.

## STATE

Phase: RESTATEMENT (2026-10-28). Charter amendment 12 committed on this
branch. Waiting on Cameron's split call and the brainstorm questions.
NEXT: record his answers here, then write the spec.

## What Cameron asked for (verbatim where wording matters)

2026-10-28 (intake): "One charter change to record first, as section 20
item 12: AI_RANKING_ENABLED is dropped. Cameron 2026-10-28: "you can drop
the ai ranking enabled switch, the switch will be when I deploy." Same
reasoning as B1 dropping AI_MATCHING_NOTES_ENABLED: the counterfactual
fair-housing check becomes B2's merge gate (B2 is not handed back
merge-ready until it passes, or Cameron decides), and the switch-off
behavior goes away. Amend every place the charter names the switch,
marked AMENDED with the date."

2026-10-28: "B2 builds on its list of tenant matching inputs and their
sources, the shared property label function, feedback lines in the Notes
box and the Notes confidence floor. Read B1's handback ... and the issues
filed for B2: notes-guard-stale-reread-vs-flip-back,
extraction-note-line-break-unprefixed-continuation,
contact-edit-form-notes-save-drops-auto-lines, and
wp3-property-feedback-redesign (keep the attach step minimal). B1's first
gate run failed on the structured-output grammar size limit, so the
ranking schema follows RUNBOOK "Changing a structured-output schema" and
its compile check from the start."

2026-10-28: "Charter decisions bind (sections 0 and 15.4); bring any other
change to me. Estimate is 33-42 of my hands-on hours, the largest slice.
At the restatement, before the spec, put one call to me: whether to split
B2 into two branches (engine plus fair-housing check plus a Rankings page
with "Rank this anchor", then the review records, example promotion,
export and evaluation script), with a recommendation."

2026-10-28: "Please start with brainstorming anything we need to know for
B2, else move directly to writing the spec."

## Why

B2 is the engine every later slice shows: B3 and B4 put its rankings in
the composer. B2 itself reaches production only through the admin
Rankings page and its "Rank this anchor" action.

## Preferences and taste calls

- No switches that protect nothing (B1 item 1, B2 item 12): a merge gate
  replaces a production switch.
- Keep the feedback-line attach step minimal and easy to delete (WP3
  redesigns it).

## Rejected options

- `AI_RANKING_ENABLED` and its switch-off composer (Cameron, 2026-10-28).

## Explicit NOs

- No charter decision changed inside the slice spec.
- No infra, deploys, or live-stack testing; hermetic e2e only.
- Real-model runs use SYNTHETIC records on the testing key only; no
  identified client record is committed.

## Open questions / assumptions

- The split (Cameron's call at the restatement).
- Who runs the real-model commands (B1 precedent: Cameron).
