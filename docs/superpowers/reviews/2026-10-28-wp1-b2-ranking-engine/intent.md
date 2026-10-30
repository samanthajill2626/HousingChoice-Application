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

UPDATE 2026-10-30 - Phase: VERDICT DELIVERED. MERGE-READY at bb7a4819 PENDING
Cameron's real-model runs (planner-verdict.md; planner gates all 0, e2e 392
passed). Nothing in flight. NEXT: Cameron runs gate-run-commands.md, then
merges; on merge, unregister compact-resume (--off). Never merge.

Earlier: UPDATE 2026-10-29 23:40Z - Phase: HANDBACK REVIEW (planner). Orchestrator
DONE: handback.md at ba234628, MERGE-READY @542e6874 (final gates all 0,
e2e 391 passed) PENDING Cameron's real-model runs and his answer to Q1
(the unlawful-flag reason source, spec D10; options 1 = fixed sentence
RECOMMENDED, 2 = keep D10; relayed to Cameron 21:45Z, unanswered).
Watchdog and mirror stopped. Planner review in flight: two read-only
reviewers (spec-conformance; plan-blind adversarial), reports to
code-review/planner-*.md. NEXT: on Q1 = 1, a micro fix wave
(flags.ts flagReason + rankingFlags.test.ts, spec D10 text amended);
then the five gates bare on a quiet tree; adjudicate the reviews; verdict
"merge-ready PENDING Cameron's real-model runs" with the merge command.
Never merge. (The BUILD entry below is history.)

Phase: BUILD (AUTO) - launched 2026-10-29. Plan v5 FINAL (d391a016; 85
tasks, rulings PR1-PR45; review closed after 4 rounds, 81/81 accepted).
Mission block: mission-block.md (dispatched verbatim).
In flight: abt:build-orchestrator (background, model opus); watchdog
(50-MINUTE checkpoints, `-ge 3000`: Cameron asked for 55 at launch, then
moved the default to 50-52 the same day so a wake lands before idle
compaction's ~54 min; skill v1.2.6; terminal and 25-min stall exits as the
skill); live.log mirror at
.superpowers/sdd/live.log. Agent id and task ids: see the ledger
(.superpowers/sdd/progress.md) and the planner's latest status line.
Gate B: replay proven 2026-10-29 13:55 (last HUMAN = the Go); context
142k after the 13:54 auto compaction, so no /compact offered.
NEXT: supervise (wake on TERMINAL / STALL / CHECKPOINT, one status line
per wake starting "**Checkpoint:**", re-arm one watchdog). On DONE:
re-ground in the WHOLE replay, run the five gates on a quiet tree,
dispatch the spec-conformance and plan-blind adversarial reviewers
(model opus), self-QA, verdict "merge-ready PENDING Cameron's real-model
runs" with the merge command. Never merge.

Launch gate (2026-10-29), Cameron verbatim: "Okay, that looks good. Let's
go auto with 55-minute watchdog timers." He approved PR18, PR30, PR37,
PR39 and PR45 with that Go. Before it he asked whether the prompt
fingerprint is the extraction or the matching model's: "we don't want the
extraction model format change to mark matches out of date." Answer: it is
the MATCHING model's only, and no prompt fingerprint feeds the out-of-date
test (cards, pair history, rubric/examples version, model, age do); an
extraction change makes a match stale only when it writes different data
onto a record. Reviewers at handback check this holds.

Earlier phase: SPEC APPROVED -> COMPACTION GATE A (2026-10-28). Cameron passed the
spec gate on rev 6 (answers: spec section 10 and below). Charter
amendments 12, 13, 14 and Sam question 9 committed on this branch. This
branch is B2a (the engine); B2b (the review dataset) gets its own spec and
branch after B2a merges.
Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md
(APPROVED rev 6). Design review closed (63/63 accepted;
design-review/adjudications.md).
Nothing in flight.
NEXT: compaction gate A (register compact-resume, prove the replay, start
the watcher, offer /compact). Then write the implementation plan (TDD,
zero-context builder; invariant rule: enumerate every writer and reader
of the matches store, the AI runs families, notes / notes_updated_at and
the fingerprints), then its adversarial review (two opus reviewers,
plan + spec), then the mission block and launch gate.

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

Follow-up 2026-10-28, Cameron verbatim: "For Q4, Lets just keep it off hte
cards and make sure we ask sam about lif. For q2, I need to ask some
questions. when you say the charter requires one card per record so full
cards cant be used for a tenant anchor, I don't understand what that
means. For a tenant anchor we're at least going to use the tenant card AND
every property card from the pool we can match with. So that's obviously
more than 1 card. So what does that mean? Secondly, the whole point of
having knowledge that someone doesn't like a property is the specific info
about the property. Something like oh the bedrooms are too small in that
house. If we don't have the square footage info for that property we
can't really figure out the average sqft per bathroom and see if that's an
issue for any other property. Further, if we end up with 0.65 per
property, I'm not necessarily worried if that's the case. But if it is,
that means we need to bring back the re-run per person instead of the
whole batch match. That would remove much of the cost."

- Q4: SETTLED - both LIF fields stay off the cards; the question is added
  to charter section 16 as item 9 for Sam.
- Q2: still OPEN. Cameron's taste: past-home feedback is only useful with
  the specific facts of that home; he is not worried by about 65 cents a
  ranking, but would reopen per-person re-scoring if cost bit. Planner's
  answer: "one card per record" means one DEFINITION per record, the same
  card whichever side it is on; proposed full cards for past homes, each
  distinct home written ONCE per call and referenced by handle, which
  keeps the cost near the summary's without reopening charter 10.3's
  whole-pool re-score.

Follow-up 2026-10-28, Cameron verbatim: "I understand, and i agree, that
the tenant card should be a single card, and that it should include all
the properties they've seen and their details. so that when a tenant as
the anchor needs to be matched to all the other properties, it obviously
should include the information about how the properties that were sent
actually matched with the tenant. if a model needs to get more information
about a property or search the internet (like our conversations here), can
the agent we're talking about doing the matching actually run that? For
instance if we have a previous property that the tenant said was in the
wrong neighborhood and they want to be near something or in a different
area, can the agent look up which properties are close to that area?"

- Q2: SETTLED - full property cards for homes seen, each distinct home
  written once per call by handle (spec rev 6).
- New question (understanding, not yet a decision): tools for the ranker
  (web search, a "properties near X" lookup). Charter 7.1 and 15.4 say
  no tools in WP1; the planner answered with the trade-offs and the
  in-scope alternative, and waits on Cameron.

Final 2026-10-28, Cameron verbatim: "Alright lets try that and we'll have
to do testing to see how that all works. If it becomes a bigger issue we
can retest that."
- Read as: no tools for the ranker in WP1 (charter 7.1 stands); test how
  rankings handle location; revisit if it becomes a bigger issue. Filed
  docs/issues/ranking-location-distance-on-cards.md (deferred).
- SPEC GATE PASSED on rev 6.

## Handback-review rulings (2026-10-29)

Cameron, verbatim: "Are we saying that a staff member can input an
unlawful requirement on a property (fine), but then it's only flagged
when it tries to rank a tenant against it? If so fine, but it doesn't
need to show in a million places, just on the property page itself. Then,
if the requirement is changed, that flag should be dropped immediately.
Does that make sense?"

Cameron, verbatim: "Showing it on the rankings page, which is only the
admin page, that's fine, against just the property, not the tenants. It
should show on the actual property page too though, otherwise I'm not
sure it's easy for anyone to realize that it's an issue. Why do you want
to wait for b4 to make the showing on hte property page amendment? And
yes the send composer doesn't show it"

Cameron, verbatim (on the read-only property-page notice in B2a now):
"Yes, add it now"

- Q1 (flag reason): the fixed sentence. Planner proposed it as change 1
  of three and then stated it as settled; Cameron did not object and
  answered the rest. Charter item 15.
- Display: property-page read-only notice in B2a, all staff roles that
  can open the property; Rankings page shows flags only on the
  property's own ranking and runs; composer never; B4 keeps only the
  admin Dismiss. Charter item 16. Close-on-edit already holds (open is
  derived on read from the text hash).
- Taste: flags should be visible where the property is managed, not
  spread across every ranking.

## After the first counterfactual run (2026-10-30)

Cameron ran the gate sheet; the compile check passed (5/5, key ...SgAA, the
testing key) and the counterfactual check FAILED (6 swaps beyond the
tolerance; record committed 2d004c9b). B2a was ALREADY MERGED to main
(002e4363) before the run, so the check is now the DEPLOY gate: do not
deploy B2a until it passes. Cameron asked whether landlords can still
require income for utilities and deposits; answered: yes on the record and
at application, the ranker weighs affordability only through rent, payment
standard, tenant-paid utilities and Maximum tenant portion (A1 scope). He
then said, verbatim: "Ok fine. Go ahead and make the other fixes you were
talking about" - the rubric r2 fix (two-way rules, authority adds nothing
to fit beyond the unmapped case, one rent-gap worked example; examples e2),
charter item 17. Open for Sam: does a payment standard depend on the
issuing authority (DBHDD)?
