# Intent record - landlord requirements and property fields (tracker #11 + #12)

## STATE (replace on every move)

- Phase: HANDBACK REVIEW (planner) - the orchestrator returned DONE
  2026-10-21 ~11:37 UTC: MERGE-READY @e59362bb (tip f61b310b = handback
  record), 0 behind main @3df43172, failure budget 0 of 2 used. Handback at
  `<records>/handback.md`. Mirror stopped; watchdog not re-armed (no build in
  flight). In flight now: the planner's own gate run (script in the planner
  scratchpad, logs `.superpowers/gates/planner/`), then two read-only opus
  reviewers (spec-conformance; plan-blind adversarial) - static first, any
  test they want waits until the gates end (continue them by SendMessage).
- NEXT STEP: conversation checklist (replay re-read), read the riskiest
  diffs (Apply dialog carry OR-17/32/34/35, the OR-29 fence, toUnitFlyer
  staff-only leak, the Apply route), short live QA on a hermetic lane after
  the gates, adjudicate, fix wave if needed (via a fresh foreground child or
  a re-dispatched orchestrator), verdict with the conversation checklist +
  merge command, UNMERGED.
- (previous) BUILD (AUTO) - dispatched 2026-10-20 ~21:32 UTC after compaction
  gate B (441k -> 23k). In flight: the build-orchestrator (background
  agent af0697670f3a44739, prompt = mission-block.md verbatim), the
  watchdog (CHECKPOINT 3300 s, STALL 1500 s quiet; exactly one), and the
  live mirror into `.superpowers/sdd/live.log`. Failure budget: 0 of 2
  consumed (one free INFRA correction already used: the drafters' ENOTFOUND).
- NEXT STEP: supervise. On each watchdog wake: CHECKPOINT -> ledger tail,
  one **Checkpoint:** line, re-arm; STALL -> ladder rung 0 (transcript
  probe); TERMINAL -> DONE = handback review (replay the WHOLE
  conversation, build the conversation checklist, run the 5 gates myself on
  a quiet tree, two read-only opus reviewers: spec-conformance + plan-blind
  adversarial), QUESTION = relay to Cameron, BLOCKED = investigate. On a
  re-dispatch, start a new mirror appending to the same live.log.
- (previous) LAUNCH GATE PASSED - Cameron picked AUTO (2026-10-20: "Go auto
  with 55 minute watchdog timers"). Then COMPACTION GATE B. Plan v3 FINAL
  @687f3a14; plan review CLOSED after 2 rounds
  (12 unique findings: 11 accepted, 1 rejected). Mission block at
  `<records>/mission-block.md`.
- (previous NEXT STEP, done) after the compaction, or on skip: dispatch the agent
  `abt:build-orchestrator` (Agent tool, run_in_background true, prompt = the
  mission block file's content VERBATIM; model from its definition). Then arm
  the watchdog with the CHECKPOINT at 3300 s (Cameron's 55-minute timer;
  the 25-minute quiet STALL rule stays) and start the live mirror
  (transcript-tail.mjs from the skill's CURRENT base dir; source =
  ~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl,
  NOT the temp dir; verify live.log grows within a minute) into
  `W:\tmp\property-requirements\.superpowers\sdd\live.log`. Every
  checkpoint status starts with **Checkpoint:**. Failure budget 2
  (budget-consuming tier); infra misfires get one free correction each.
- Reviewer A (ab45379e71f894ef4) and the slice writers are done; they are
  not needed after dispatch (the orchestrator runs its own children).
- (previous) PLAN REVIEW round 2 (round 1 closed: 10 unique findings, all
  accepted, 3 changed decisions; plan v2 @51893e3a).
- (previous) PLAN REVIEW round 1 (compaction A done 2026-10-20, 558k -> 18k).
  Plan v1 assembled at `docs/superpowers/plans/2026-10-20-property-requirements.md`
  (26k lines: sections 0-3 planner-written, section 4 = assembly rulings
  AR1-AR48 over the drafts' contract issues, sections 5-11 = the seven opus
  slice drafts S1-S7 verbatim; drafts also under `.superpowers/sdd/plan-drafts/`).
  One infra failure during drafting: all seven drafters died on a network
  ENOTFOUND and were resumed by SendMessage (free INFRA correction).
  In flight: two fresh opus plan reviewers (PLAN brief), reports to
  `<records>/plan-review/R1-reviewer-{a,b}.md`. Then adjudicate into
  `<records>/plan-review/adjudications.md` + plan section 4.1; rounds 2+
  continue the better reviewer; cap 4. Then mission block + LAUNCH GATE.
  `npm ci` done in the worktree (exit 0).
- (previous) SPEC APPROVED (Cameron, 2026-10-20) -> COMPACTION GATE A -> PLAN.
- Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`
  revision 6 APPROVED, commit c41b9b90 on `feat/property-requirements`
  (worktree `W:\tmp\property-requirements`, cut from main @1d7a4667).
  Review: 4 rounds (cap), 62 findings, adjudications in
  `design-review/adjudications.md` (incl. the spec-gate decisions O1/O2).
- Launch mode: not chosen yet (launch gate comes after the plan).
- In flight: nothing. The spec reviewer (agent a8cb23799391f4617) is done;
  the plan gets its own fresh pair of plan reviewers (round 1), then the
  better one continues.
- Side artifacts: Sam's preview of the property edit form,
  https://claude.ai/artifact/5R3RhAD2BbALdMH2qc7ZTZ (shared with anyone with
  the link by Cameron; a sticky note carries 5 questions for Sam, incl. where
  subzone codes come from). Brainstorm mockups (local, ignored):
  `W:\AI Projects\Housing Choice\HC Application\.superpowers\brainstorm\626-1792507721\`.
- NEXT STEP: write the detailed TDD implementation plan at
  `docs/superpowers/plans/2026-10-20-property-requirements.md` (zero-context
  builder; slices app -> dashboard -> e2e; INVARIANT RULE: enumerate every
  mutation surface AND every reader of the requirement keys,
  `requirement_sources`, `voucher_size_accepted` and the audience
  `bedroomSizes` as tasks or watch items - the spec's section 7 is the
  starting list); then plan design review (two opus reviewers with the
  spec, PLAN brief from design-review-briefs.md; rounds 2+ continue the
  better one; cap 4); then the mission block and the LAUNCH GATE
  (AskUserQuestion: Go AUTO / Go MANUAL / Revise), compaction gate B, dispatch.

## What Cameron asked for (2026-10-20, quoted where wording matters)

Intake: build tracker #12 (Property page fields) and #11 (Landlord
requirements and qualifications) together; every "Decided" line and dated
note in the tracker is a requirement; carry the voucher-size multi-select
through #1 (Properties filter), #28 / the Oct 12 note (flyer + Matching
pre-fill) and #6 (matching blast rules). "The checkbox label stays 'No
evictions while on the program'; a tenant's eviction history is free text and
the AI ranking weighs the two."

Decisions in the conversation:

- Blast any-of: "For Blast, yes. If there are multiple allowed options on a
  property, it should be looking for anyone that read that matches any of
  those voucher sizes." (He allowed deferring it to WP1 if it were a lot of
  work; it is not, so it is in.)
- Flyer wording: "Fits a 2- or 3-bedroom voucher" approved; "Instead of saying
  'fits a 0-bedroom voucher,' 'fits a studio voucher' is probably better."
- Public flyer data: agreed with the proposal (public: washer/dryer, deposit
  checkboxes, No application fee, pets + pet fee; internal: evictions, credit,
  income, qualifications, deposit notes). Later: subzone STAFF ONLY.
- Apply to all: "should give you an option to override properties with
  deliberate exceptions. Let's give an option to select which properties want
  to be copied over. I think that that's the easiest way to do this, to make
  sure it's actually usable."
- Copy at create: "Yes, copy at create. The create form will fill in info
  from the landlord so they can see that. It just becomes the default when
  creating a property and can be edited before it gets saved."
- "I think a blank landlord value does count as differing."
- Existing pets values: agreed (stored "not allowed" -> No pets ticked, text
  -> details, no backfill). $0 application fee = "No application fee": yes.
  Tour: "let's copy both" (tour process AND tour type).
- Voucher sizes: "whatever data does exist knowingly on both the property as
  well as the tenant. The landlord doesn't have an accepted voucher size
  because that should really only live on the property. Filters can show up
  to 4+ or whatever we decide, but if somebody has a 6-bedroom voucher, that 6
  needs to live on the tenant." Then: "through 12 needs to be able to be
  represented on a property as well." Property range = Studio..12 (the tenant
  range).
- "we do need to fix the matching 4+ bedroom chip because 4+ should be
  anything greater than 4" (read as 4 or more; stated back, not objected).
- Requirements get their own section on the landlord page.
- Copy only: "For property values, I think copy only is the right way to go.
  ... If you clear something on the landlord that says, 'Hey, I don't really
  know what their stance is on pets,' then it should clear the property value
  too, if you want it to." -> Apply can copy a BLANK item when staff check it.
- Big-size prefill: a 5-only property pre-filling 4+ is fine ("There's no
  real data for those sizes").
- Apply dialog: layout B (one screen, fields left, properties right).
- Remember where values came from: "Yes, let's remember."
- Property page: layout A (tag + small landlord line).
- Tag naming: purple "Set on this property"; orange renamed - "what we need
  to see is that it's an out-of-date value because it wasn't set on this
  property, and the landlord version was updated" -> "Landlord updated".
- "set on this property is what we should do for values that exist today."
- Cameron caught a flaw: a COPIED blank (unchecked No pets) that the landlord
  later changes must show "Landlord updated", not the blank/no-tag case.
  Copying records blanks too; only never-touched blanks are "not set yet".
- Voucher picker: B (Studio..4 + "More sizes (5-12)"), not A.
- Area: "where does area fit? I don't think that that was part of our
  requirements" -> not added to forms (a per-property free-text area would
  need renaming property by property).
- Wanted a shareable artifact for Sam with the edit page and the picker, to
  get her feedback (built; Cameron shared it).
- Flyer clarity on the edit page: "I want to make it clear on the edit page
  which pieces of information actually show on the flyer ... I'm worried
  about admins accidentally putting information that is not private from a
  legal standpoint, but damaging ... in that text field." -> On flyer / Staff
  only tags on every field, a legend, and a warning line under public
  free-text boxes.
- Subzone: "subzone should be staff only. Add that as a question in the
  artifact notes ... about where those subzones came from." (Done.)

Spec-gate decisions (2026-10-20, after review round 4 hit the cap):

- Pets coupling: "I agree with your point about pets. There are probably
  other areas where details are added in a free text field, but maybe not
  those that apply on the flyer. If they don't apply on the flyer, then maybe
  we need to look at them anyway because we may still have an internal
  situation (like the no pets but cats okay issue that you point out, just
  not on the flyer). It'll be shown on the property." -> every checkbox or
  choice plus its details is ONE item (Evictions, Pets, Deposit, Touring).
- Blank landlord tags: "I still want the original call for the tags when the
  landlord field is blank. Right now, that'll continue to help us identify
  which landlords probably need to be updated. If it says 'set on this
  property' and the landlord is blank, that's sort of a subtle hint that we
  need to go back to the landlord and add that data in." (Planner lesson:
  round 3's R3-6 adjudication narrowed an explicit Cameron call without
  asking; a reviewer's UX concern about a human decision goes back to the
  human.)
- "Other than that, the spec looks good, and we should be able to move on."

## Why

These records feed Work Package 1's AI ranking (decided Oct 18: AI ranking
only), and they are what Sam checks by hand today. Exceptions on a property
are usually discovered only after a denial (tracker #11, Sep 30), so Apply
must protect them by default.

## Preferences and taste calls

- One screen, nothing hidden (Apply dialog B), see the landlord's value
  without hovering (layout A).
- Usability over cleverness: "make sure it's actually usable".
- Legal/reputational caution on anything tenant-facing.
- American English; plain staff-facing copy.

## Rejected options (do not re-propose)

- Fall back to the landlord's value at read time (rejected for copy only).
- Apply copying only filled-in fields (rejected: a blank can be applied).
- Apply dialogs A (two steps) and C (grid); property-page layouts B (side by
  side) and C (hover dot); voucher pickers A (all 13 chips) and C (dropdown).
- "Differs from landlord" as the orange label.
- Existing values counted as out of date (rejected: they are set on this
  property).
- Studio..6 limit on property sizes; Area on the forms; subzone on the flyer.
- No tag against a blank landlord item (round-3 planner change; reversed by
  Cameron at the spec gate).
- Separate items for a checkbox/choice and its details (No pets vs details
  vs pet fee; No evictions vs details; tour type vs tour process).
- Select all in the Apply dialog (planner addition, removed in review).
- Per-property, per-item choices in Apply (the grid, C).

## Explicit NOs

- No rule-based matching on requirements; no blast filtering on No pets /
  No evictions (WP1 is AI ranking only).
- Credit and income are notes only (fair-housing question open).
- No backfill.

## Open questions / assumptions made on Cameron's behalf

- Planner calls marked in the spec as mine: server classifies copied vs set
  here by comparing with the landlord at write time; landlord change on a
  property empties the source records; Apply route with an `expected`
  compare-and-set and per-unit conditional writes; "Has its own value" row
  label; Select all; tag wording "On property flyers" on the landlord form;
  "One month's rent" disables the fixed amount; legacy `pets: true` reads as
  details "Allowed"; flyer three-size wording with a serial comma.
- Sam's feedback on the preview may change form layout; the subzone code
  source is a question for Sam.
