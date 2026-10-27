# Intent record - WP1 B1 Ranking inputs

Mission: Amendment No. 1 Work Package 1, slice B1 of 4 ("Ranking inputs").
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(section 15.1 B1 row; details in 6.3, 6.4, 7.3, 9.2). Charter decisions
bind; a change goes to Cameron and is recorded in the charter (section 20).

Planner session: 16d60dc4-e0e1-44a2-956e-9be4142cab3b (Claude Opus 5.5).
Worktree: W:\tmp\wp1-b1-ranking-inputs, branch feat/wp1-b1-ranking-inputs,
cut from main @d0e2c2d8.

## STATE

Phase: LAUNCH GATE again (2026-10-27), after Cameron's revision: spec
rev 9 (22b562bc), charter 20 items 9-10, plan v6 (S5.5 deletes the
no-address bullet; S6 redrafted for a model grader; PR50-PR57). Plan
review round 4 (the cap): 5 findings, all accepted. OPEN for Cameron at
the gate (PR54): the grader's NOT EXCLUDED defaults (pronoun for the
tenant, household members by relationship, a mobility aid stated for the
need) and whether "sex" covers sexual orientation and gender identity
(planner recommends yes, in the prompt's never-written list AND the
grader description; that is a charter 6.4 list change). His answer is
written into S6.1 (and S4.6 + charter 6.4 if orientation is added)
before dispatch. Ask as TEXT: Go AUTO / Go MANUAL / Revise, plus those
answers. Nothing in flight.
Next on a Go: compaction gate B, then AUTO dispatch of
abt:build-orchestrator with mission-block.md verbatim (or MANUAL prompt).
Registered with compact-resume (--persist) until mission end.

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

2026-10-26, at the spec gate (spec rev 4):
- Q1: "For Q1, yes, we should keep the rule." (demoted runs append no lines)
- Q2: "For Q2, I can run the gate command. That's fine. Before we do the
  merge, we're going to use Claude Sonic 5.5 like we've been doing for
  everything else." -> the gate runs on claude-sonnet-5-5 ("Sonic" is a
  dictation slip); production extraction runs claude-sonnet-5-5; RUNBOOK's
  claude-sonnet-5 line is stale and B1 fixes it.
- On reactions: "I just want the reaction to a property, any property, to
  be fed into the model for any other property. If we have somebody say
  something like, 'Yeah, I don't like that part of town,' that gets flagged
  and shown to the new model for ranking purposes."
- Q3 / redesign: "I don't understand the display and remove control.
  That's what prompted this to begin with, so I think we need to redesign
  how we're thinking about this reaction to a property. ... 1. What
  information from a response to a property needs to go in 2. Tracking that
  information. For now, maybe the best thing to do is just use the 'not
  interested' or 'interested' tags, plus the property address and all of
  its information, in order to flag what the person has already seen and
  why they don't like that. The whole point of this is to build up an
  understanding of what this person is interested in. Every time they give
  us feedback on a property, that should change how we rank properties with
  respect to them."
- The maybe case: "we would have to track them in the system as not
  interested in order for them to move on, because we're not creating a
  tour. We don't want to look at just the not interested tag. We want to
  make sure that that's very clearly shown as a maybe, and then after a
  certain amount of time, that property would bubble back up because we do
  know that they're at least a little bit interested in the property."
- Accepted the planner's design: "Yeah, I like the way that we have
  updated this. Let's amend the charter and cut the spec down." ->
  reaction LINES in the Notes box (fixed shape: address, city, one of
  interested / maybe / not interested / question, reason); no stored
  reactions, no remove control; PROPERTIES SEEN on the tenant card (B2);
  staff Not interested + a maybe line reads as a maybe; no Maybe button.
  Charter section 20 items 4-6.

- On the fixed reaction-line shape (after rev 6): "Why do we care if the
  "maybe" is lowercase and in the fixed shape? I thought the whole point
  was to use llm capabilities to save info about the response to a
  property, and use that info in future rankings. Saying we need to
  exactly include notes a specific way, that's a bad idea imho."
- On what reaches the ranker: "we don't really care what properties a
  tenant has seen if it doesn't include any info about what they thought
  about the property. So just a list of properties they've seen is
  useless to us. There's an issue with the way we're looking at all this
  information making it into the agent."
- "It's incohesive to have the notes box include the property and the
  maybe tag, and the properties seen much later. We need a way to have a
  more cohesive information list for the ranker." Then, of the planner's
  proposal (feedback lines are free-form Notes lines naming the home; the
  card puts each under that home in properties seen): "I agree with your
  thoughts here." -> charter section 20 item 7, spec rev 7.
- Asked whether "card" maps to a UI element: it does not; it is the
  charter's word for all of one record's information as given to the
  ranker (charter section 3, now stated there).

- On the address-matched pairing (after rev 8): "When we get to work
  package 3 we need a much better way of pairing the property with
  feedback about the property. This all seems so fragile and really not
  hte best design. It's for sure like we're shoehorning this whole thing
  into the existing system. Instead I think we need to re-design from the
  ground up on shared property feedback. Do you think we need another
  review round?" Planner: no round 6. Then Cameron: "yes file an issue
  for wp3, pass rev 8, and flag it for b2" -> SPEC GATE PASSED on rev 8;
  docs/issues/wp3-property-feedback-redesign.md filed; charter section 20
  item 8; flag in spec D5.4.

- At the launch gate (2026-10-27), on the no-address rule and the banned
  terms: "Talk to me about the no-address rule. I think that might be an
  old rule rooted in something that we don't need anymore. Is there a
  strict shared banned list of words? I don't think that we should have
  a strict list of banned words for exactly the reason that you point
  out, and because the intelligence lives in the model. That's what
  we're trying to lean into." Planner: the rule dates from 16f09095
  (2026-07-20) and only de-duplicated the tenant's own address; the word
  lists live only in the test scorer; proposed deleting the prompt
  bullet (keep the postal filter and the address-output rule) and a
  model grader. Cameron: "For the no address rule, I agree with your
  recommendation. ... If you want to change that to a model grader, I
  think that that's fine because a plain description of the forbidden
  fact is good. It makes it easy for us to look and say, 'Yes, it caught
  the right thing,' or 'No, it's thinking that this unrelated fact is
  actually banned.' Let's make both those changes." -> charter section 20
  items 9-10, spec rev 9.

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

- A fixed-shape reaction line with four reaction words, a lowercase rule
  and label-matching drops (spec rev 6): Cameron, a bad idea; the model
  words the feedback, and only naming the home is required.
- Properties seen as a bare list of homes and outcomes, with the
  feedback elsewhere in the Notes box: incohesive and useless to the
  ranker (Cameron).

- Stored per-pair reactions on listing_sends with a writer, handles and a
  staff remove control (spec revs 1-4): Cameron did not want a new hidden
  store needing its own display and correction path.
- A Maybe button beside Not interested (declined again; extraction's
  maybe line carries it, the button only if extraction misses maybes).
- A per-pair-only reaction scope: feedback on one property must reach
  every ranking for that tenant.

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
