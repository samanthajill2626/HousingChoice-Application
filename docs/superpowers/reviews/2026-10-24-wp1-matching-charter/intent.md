# Intent record - WP1 matching charter

Mission: Amendment No. 1 Work Package 1, "Matching tenants and properties" -
the CHARTER only. A decision-level design spec that the four build slices
(B1 Ranking inputs, B2 Ranking engine, B3 Find properties, B4 Find tenants)
cite instead of re-deciding. No plan, no build in this mission.

Planner session: 85fa9966-6850-4ae9-83c5-7049190fea14 (Claude Fable 5.1).
Worktree: W:\tmp\wp1-matching-charter, branch feat/wp1-matching-charter,
cut from main @970a29b9. Docs only.

## STATE

Phase: brainstorm (one question at a time), not yet started on the spec.
Launch mode: none - this mission stops after Cameron's spec gate; the spec
and these records merge as a docs-only branch. Nothing in flight.
NEXT STEP: ask the first brainstorm question (ranking approach: LLM judgment
vs a reranking model, after Cameron clarifies what "JEV" meant), then work
through the charter questions below, write
docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md, do a
whole-spec re-read with Cameron BEFORE the adversarial document review (his
request), then the review, then his gate.

## What Cameron asked for (verbatim where wording matters)

2026-10-23: "We've been approved to get started on the work packages laid
out in Amendment 1 that was recently just signed. Lets figure out what we
need to do to get started working on work package 1."

2026-10-23: "I agree that this feature seemed to large to run even the full
plan in one feature branch so I do want to make sure that we don't bite off
more than a single spec can chew." -> one short charter, then one spec and
one branch per slice. Agreed shape: "Ok I like that plan."

2026-10-23 (mid-turn): "we need to use the /abt:feature-mission skill"

2026-10-24, on the restatement (Go, with decisions):
- Hard rules vs AI judgment: "the signed contract was a little bit too
  harsh. What we do want is that AI takes in all the information and doesn't
  necessarily disqualify people, but would put them really low on the list
  if they're otherwise perfect but have an eviction or pets that should be
  excluded." "I don't think hard rules are ever going to be the answer ...
  we should really go with soft rules and AI judgment separately over the
  whole thing."
- Model choice: "we should not just think about using the current LLM
  models to do this. I'm wondering if something like JEV is going to be a
  better use because we're literally trying to rank these." (JEV = unclear,
  likely a dictation slip; to clarify.)
- Inputs: "I'm wondering if any of the messaging or messages themselves
  should be read. Maybe not, because that'll inflate this matching algorithm
  pretty significantly in terms of tokens. That means we probably need to
  think about how this affects our data extraction ... area accessibility,
  stated preferences, and other pieces of information".
- Candidate pool: "we can't use all of the candidates, so we have to filter
  them ... only the ones who are actually searching. They have to be in the
  right phase, they have to have the right voucher size, they have to be in
  the right housing authority, and then they enter the ranking list ... let's
  start there and figure out how big the pool we're talking about would be."
- Process: "the pipeline should run up until the gate spec is done ...
  Before we run the adversarial document review as we normally would, let's
  take a second and then relook at the spec as a whole." Separate worktree:
  "that's fine". #31 (Today checklist) is finishing in parallel and will be
  pulled into main; the charter does not wait for it.
- Asked for a very short email to Sam asking for console access to create
  temporary testing keys himself, or a separate API key for testing.

## Why

Sam matches by hand (tenant list filters, a browser tab per tenant, a sticky
note per property). WP1 gives her a ranked list in both directions with a
match percentage and reasons, a one-step send, and a record of every ranking
so she can review the AI's reading of her clients. Priorities: ranking
quality Sam trusts, then her review of it, then the two views.

## Decisions so far

- D-soft: requirement failures (no evictions, no pets, free-text notes)
  DEMOTE strongly; they do not exclude. The AI reads them. NOTE: the signed
  text says "excluded"; Sam should hear that a failing tenant still appears,
  at the bottom with the reason. Flag in the spec, not a blocker.
- D-pool: the candidate pool is an eligibility pre-filter, not a rule
  score: tenant in a searching phase (status), voucher size fits, housing
  authority accepted. Other shrinkers (already sent, declined, committed to
  another placement, unavailable) to be decided per direction.
- D-shape: charter now; B1 -> B2 -> B3 -> B4 sequential; B3/B4 never in
  parallel (both touch dashboard/src/routes/broadcasts).

## Rejected options

- One 52-hour branch (pipeline has never carried it; Sam sees nothing until
  the end). One WP1-wide detailed spec (too much for one spec).
- Hard rule-based scorer (Cameron, Oct 18 and Oct 24).
- Reusing the Similar-units weighted scorer as the ranker (shape reference
  only).

## Explicit NOs

- No plan, no worktree build, no code in this mission.
- Never move HEAD in the shared main checkout; never touch :5174/:8080.
- No prod data reads without Cameron's explicit go (pool sizing needs one).
- American English; ASCII in specs and records.

## Open questions / assumptions

- What "JEV" meant (reranker? embeddings?) - ask first.
- Pool size on real data: needs a go for a read-only prod count.
- Testing API key from Sam: on Cameron's list; needed before B2.
- Assumed: the AI call stays on Anthropic (A1 section 6 and 8 price it on
  Sonnet 5 and bill Sam's account) unless the model question changes it.

## Decisions, round 2 (Cameron, 2026-10-24)

- D-model: a regular LLM is the ranker. "JEV" was a reranking/relevance
  scorer idea; Cameron: "It sounds like this is really used more for RAG
  situations than what we're talking about ... if a regular LLM is still the
  way to go here, then that's fine." Amendment pricing is NOT a constraint
  at charter level: "we're still talking about the top level here. We can
  deal with the last parts of that afterward."
- D-pool-status: SEARCHING ONLY. "the matching that we're doing
  automatically needs to be just the people that are in the right category,
  which is, in this case, searching." Onboarding tenants lack the
  information; WP2 automates hello -> onboarded -> searching. (The Matching
  page blast rules include onboarding only because a human is in the loop.)
- D-declined: a "not interested" send outcome does NOT remove a tenant from
  the pool; it changes the ranking. Nuance comes from extraction: "have the
  AI extraction tool pull that information out of the conversation where it
  says ... marked as not interested, but maybe they could be convinced. That
  would bump them back up in the rankings." No "maybe" button (Sam asked;
  Cameron declined - it would conflate the outcome).
- D-missing-info: the ranker must be able to say it lacks information for a
  candidate (example: property without rent or payment standard vs a tenant
  with "$300 a month to cover my part"), rather than guess. How (flags vs
  the model asking for more via tools) is the call-shape brainstorm.
- Call shape is a LARGER design question, not listwise vs pointwise only:
  "turn-based ... score a bunch and then maybe a few more ... some type of
  rebalancing"; the model asking for more information; flagging unsure
  candidates.
- Still open: the go for a read-only prod count to size the pools.

## Decisions, round 3 (Cameron, 2026-10-24)

- D-no-tools: the model asking for more information (tool use) is NOT part
  of WP1. Revisit after sharing exists: "work package 3: there's going to
  be sharing ... questions that come back to us from a tenant asking about
  the property. That's when we can start thinking about the tooling."
- D-staged: the ranking engine is a staged pipeline. Stage one = one
  listwise scoring call per ranking (anchor + all eligible candidates,
  batched near 40), with a code-side completeness pass marking each
  candidate's missing data before the call and the model scoring gaps as
  uncertainty, streamed so rows fill in. Stage two = top-K refinement
  (about 12) with full reasons. Cameron: two stages are "fine (as long as
  the spec includes knowledge that that's the ultimate goal, so that we can
  build in a forward-looking way)". Planner reading: the charter defines
  both stages as the target; WP1 builds stage one and the seam (record
  store holds both stages' output); stage two is the first addition once
  Sam's review shows the top of the list needs it.
- Budget and cache check accepted: about 600 rankings a month, ~5 cents
  each on Sonnet 5.5, only if a ranking is reused rather than recomputed
  on every open.
- Cameron's re-rank idea (to settle): anchor-side change -> full re-rank;
  one candidate changes -> re-score that candidate alone "using the rest
  of the information as context and have it output only for that person".
  He also floated "a blanket model for everybody once a day" (NOTE: the
  signed A1 lists background re-rank as NOT included; WP1 is computed on
  open).
