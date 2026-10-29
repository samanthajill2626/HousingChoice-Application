# Intent record - WP1 B2 Ranking engine

Mission: Amendment No. 1 Work Package 1, slice B2 of 4 ("Ranking engine").
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(section 15.1 B2 row; amended through section 20 item 14). Charter
decisions bind (sections 0 and 15.4); a change goes to Cameron and is
recorded in the charter (section 20).

Planner session: 1f0c0695-9acd-40ad-b991-190e2c6c0770 (Claude Opus 5.5).
Worktree: W:\tmp\wp1-b2-ranking-engine, branch feat/wp1-b2-ranking-engine,
cut from main @404e039d.

## STATE

Phase: SPEC GATE (2026-10-28). Charter amendments 12, 13 (the split) and
14 (Notes line breaks and drop count) committed on this branch. This
branch is B2a (the engine); B2b (the review dataset) gets its own spec
and branch after B2a merges.
Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md,
rev 5. Design review CLOSED after round 4 (63 findings, 63 accepted, 0
rejected; design-review/adjudications.md).
Spec gate PARTLY answered (2026-10-28): Q1, Q3, Q5, Q6, Q7 settled (see
"Spec-gate answers" below). WAITING ON: Q2 (summary vs full card for
homes the tenant was sent - Cameron asked why) and Q4 (what LIF is -
Cameron's understanding differs from the code's label; he may ask Sam).
Nothing in flight.
NEXT: record his answers here and in the spec (section 10, spec-gate
answers), then compaction gate A (register compact-resume, prove the
replay, offer /compact), then the plan.

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

## Restatement answers (2026-10-28)

Cameron 2026-10-28, verbatim: "ok splitting it is fine. if you want to add
the notes change issue to b2a that's fine. Keep the real model runs mine.
Those will only happen at the end of each build before we merge though,
right? i don't want them to stop you from building all the way through.
Take the defaults you mention here for those 3 bulleted items"

What that settles:

- SPLIT into two branches.
  - B2a, the engine (this branch): pool, cards, missing-info marks, rubric
    plus about 10 synthetic worked examples, ranking schema, drivers, the
    ranking poll loop with claim/lease/takeover, the job record, matches
    rows and staleness, the Weak cap, fair-housing flags and the
    unlawful-flag record, run log and cost, rate limit, rank and read
    endpoints, and the admin Rankings page with "Rank this anchor". The
    counterfactual fair-housing check is B2a's merge gate. B2a's spec
    reserves the seams B2b needs: the exact model input kept on each run
    and an examples version from day one.
  - B2b, the review dataset (next branch): review records with input
    snapshots, the review-a-pair endpoint, agree/disagree on the Rankings
    page's pair view, the review list, promotion and examples-version
    growth, the 30-pair evaluation set, the de-identified export, the
    evaluation script.
  - Order becomes B2a, B2b, B3, B4 (B3's agree/disagree needs B2b's
    review endpoint).
- contact-edit-form-notes-save-drops-auto-lines is FOLDED INTO B2a: the
  contact edit form's Notes save gets a stale-save guard copying the Staff
  notes guard (409 plus a reload message that keeps the typed text).
- Real-model runs stay CAMERON'S (B1 PR1 precedent: no agent runs a real
  model or reads the testing key). They happen at the END of each build,
  before merge, and must NOT stop the build from running all the way
  through. The build hands back with the real-model runs as the last
  pre-merge step. The compile check is not a mid-build stop either: its
  command goes to Cameron at the spec gate (where he already is) and the
  plan does not wait on it; the build also carries an offline schema-shape
  test so the known grammar limit is caught without a real call.
- Defaults TAKEN (Cameron 2026-10-28):
  1. AI Notes lines containing line breaks are collapsed into one line
     (filterNoteLines), in B2a.
  2. The retry guard's repeated-line drops are counted on the run record
     (notesDuplicate), in B2a.
  3. The any-date retry-guard ruling stands; no compare-with-latest-line
     work (WP3 replaces it).

## Open questions / assumptions

- None open with Cameron. Planner-level spec details (tolerance, anchor
  picker UI, properties-seen bound, run-input storage) are decided in the
  spec and surfaced at the spec gate.

## Spec-gate answers (2026-10-28)

Cameron 2026-10-28, verbatim: "For 1, keep that recommendation. for 2, Why
are we trying to only use a summary for each property instead of the full
property card? I assumed we'd need all the info for each property to
really make a good match? For 3 Pool limit at 300 is fine for now, may
have to change later. For 4 The way LIF is used for Sam, as i understand
it, is the tenant is eligible for the housing authority to pay their down
payment too. Is that not right? If it isn't I'll have to ask sam about
that one. For 5, sure, keep those numbers. For 6, confirmed. For 7, Agreed
with your reocmmendation."

- Q1 (whole Notes lines move under a home, staff lines included): KEEP.
- Q2 (summary of homes seen vs full card): OPEN - Cameron asked why; the
  planner answered (the home being scored always gets its full card; the
  summary is only for OTHER homes the tenant was sent; size and cost) and
  waits on his call.
- Q3 (pool ceiling 300): KEEP, "may have to change later" (it is config,
  RANKING_MAX_POOL).
- Q4 (`lif`): OPEN - Cameron understands LIF as the tenant being eligible
  for the housing authority to pay their deposit; the code labels the
  unit's `lif` a "Landlord incentive fee" dollar amount. Both LIF fields
  stay off the cards until the meaning is settled (possibly with Sam).
- Q5 (counterfactual tolerance numbers): KEEP.
- Q6 (prices $2/$10 Sonnet 5.5, $4/$20 Opus 5.5): CONFIRMED by Cameron;
  no longer unverified.
- Q7 (fingerprint seen homes only with a decline or tour; no charter
  amendment): AGREED.
