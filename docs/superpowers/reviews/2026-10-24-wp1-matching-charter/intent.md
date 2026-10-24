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

## Decisions, round 4 (Cameron, 2026-10-24)

- D-on-demand: a ranking is NOT computed automatically on page open. A
  button fires it. When the stored ranking's anchor or candidates have
  changed since, the page shows an out-of-date warning (per candidate where
  only candidates changed: "this ranking of this candidate is out of
  date") with a button to update. Reasons: "It's not just firing off LLM
  calls, which costs money" and avoiding the latency when "we might have
  just been wanting to go back to the page where everything already
  existed just fine."
- D-cache: change-driven, by fingerprint: anchor changed -> full re-rank
  offered; only candidates changed -> single-candidate re-score offered
  per changed candidate (existing scores as context, one output); new
  eligible candidate = insertion; candidate leaving eligibility = dropped,
  no call; drift guard = full re-rank after N incremental updates or when
  the ranking is older than a week. Cameron: "that's probably right."
- Nightly blanket pass: NOT in WP1 and not wanted - Cameron did not intend
  it ("I don't ever think that a nightly blanket pass was something we
  talked about"); the planner had read it out of his round-3 line "a
  blanket model for everybody once a day". Dropped. WP3 may want a
  scheduled caller of the same engine; the charter may mention the seam
  only.

## Decisions, round 5 (Cameron, 2026-10-24)

- D-pool-final: the pool is ELIGIBILITY ONLY - tenant status searching,
  voucher size the property takes, housing authority the property accepts,
  property available and not committed to another placement. Send history
  (sent date, no reply, not interested with extracted nuance, interested
  with a tour pending) and tour outcomes are MODEL INPUTS and UI chips,
  never pool rules.
- D-sent-visible: a property already sent to a tenant stays in that
  tenant's ranked list with its chip. Cameron's case: the tenant said
  "Yeah, maybe, but I want to see other properties first", Sam marks Not
  interested; the extracted nuance should make that property "bubble up to
  the top after a while of sending other properties, since they said
  maybe to it". So the ranking reads BOTH the recorded outcome and the
  extracted nuance, and the passage of time since the send matters.
- Prod pool count: APPROVED (read-only). "The number of properties in here
  isn't really that big, and the number of tenants isn't really that big,
  but we got to think about scale in general, just not now."

## Decisions, round 6 (Cameron, 2026-10-24, after the prod pool count)

- D-no-dormant: NO input is designed as dormant. "We shouldn't build or
  make the charter treat anything as dormant when, in reality, it's Sam's
  responsibility to make sure that we have captured all the data properly.
  It's our responsibility to make sure that missing data doesn't break the
  whole system." Rent, payment standard, tenant portion: built fully; the
  completeness pass handles absence without breaking; the UI must push
  Sam to add the data ("force Sam to actually add the data") - e.g. a
  property's ranking view names what is missing with a link to fill it.
- D-priority: on/off, USED by the ranking; nothing to migrate (no prod
  values) - "it's just not filled out right now."
- D-staleness: last heard from is BOTH a pool rule (a longer period, 90
  days, configurable, toggle to include older) AND a model input that helps
  rank within the window. "if it's 90 days old ... they're just going to be
  noise." Future automation (WP3-era): reach out to tenants going dormant
  ("still looking?"); a reply refreshes last heard from, no reply moves
  them to inactive or the proper status. Not WP1.
- Prod facts to carry into the charter: 670 searching / 22 live available;
  property-side pools ~100 median, ~500 worst as recorded; tenant-side at
  most 10; no rent/payment standard/subzone/priority on any available
  unit; 10 of 22 live available lack a voucher size list; 29 searching
  tenants carry voucher size 10 (ask Sam); `matches` table (tenantId,
  unitId, byUnit, TTL) exists everywhere, unused.

## Decisions, round 7 (Cameron, 2026-10-24)

- D-pair-score: ONE score per tenant-property pair, shared by both
  directions: "that way we don't have to duplicate any of the work ... if
  we go in the opposite direction, that data is already there and can get
  fed into the model to rank everybody else, if that anchor/tenant data
  hasn't changed."
- D-score: 0 to 100 shown as a match percentage, 0 bad, 100 good. Bands
  computed in code (Strong 80+, Good 60+, Possible 40+, Weak below 40 as
  the starting values; tunable without a prompt change).
- D-reasons: reasons are PHRASES or single words ("stairs"), not
  sentences; up to three for and three against, each tagged with its
  source input. Missing information is a SEPARATE list from reasons
  (Cameron: "I agree with your differentiation").
- Priority: Cameron leans deterministic sort but expects pushback from
  Sam; floated deterministic base PLUS a marginal model input; asked to be
  talked out of it. Planner position (this turn): deterministic only, with
  a configurable STRENGTH (within band / one band up / always first) so
  Sam's pushback is answered by a setting, not by the model. See the
  message of 2026-10-24 for the two reasons. Pending Cameron's call.

## Questions for Sam (running list)

- Priority strength default: within band, one band up, or always first?
  And confirm that the flag is about filling a property first, not fit.
- Voucher size "10" on 29 searching tenants - a code, or data errors?
- Will she fill voucher sizes (10 of 22 live available lack them), rent
  and the payment standard on properties? Does she fill the Payment
  standard field today, and where does she get the number?
- Hard exclusion wording in A1 vs the soft demotion built: a tenant who
  fails a requirement still appears, at the bottom, with the reason.

## Decisions, round 8 (Cameron, 2026-10-24)

- D-priority-final: priority is DETERMINISTIC ONLY; "the model never sees
  the priority tag." Two mechanisms: (1) a strength setting that moves
  priority properties between bands (within band / one band up / always
  first - default is Sam's call); (2) a priority-only VIEW on the ranked
  list that "shows only the priority properties and basically hides
  everything else that has been matched and sorted", so she sees the
  highest-ranked priority property while everything is still ranked.
  Applies where properties are the candidates (a tenant's find-properties
  view). A cross-property "which priority property has the best tenants"
  view is not WP1.

## Decisions, round 9 (Cameron, 2026-10-24)

- D-rankings-page: KEEP the staff Rankings page ("I like the rankings
  page").
- D-entry-points: the ranking opens from a "Send property" action in both
  places, replacing the blast as the way to send: "instead of a blast, we
  would basically go to the properties page and click 'Send Property' in
  order to send it to tenants, and that would bring up this matching. The
  opposite way: from the tenants page, click 'Send Property', and that
  would bring up the matching." The thing sent is always a property; the
  verb is the same on both records. B4 = Send property from a property
  (ranked tenants); B3 = Send property from a tenant (ranked properties).
- Pair rows: Cameron did not follow the storage explanation; shown with a
  worked example in the message of 2026-10-24; pending his read.

## Decisions, round 10 (Cameron, 2026-10-24)

- D-record: pair rows ADOPTED ("We do want pairs"). The confusion was the
  word "matches table": the planner meant the DynamoDB table `matches`;
  Cameron read the Matching page's on-screen table. GLOSSARY TRAP for the
  charter: "Matching" = the feature/page; "ranking" = the ranked list for
  one anchor; "match" = one pair's score (the match %); the DynamoDB
  table is only ever "the matches store" in prose, never "the matches
  table" near UI text.
- Cameron confirms the two send surfaces are the property record and the
  tenant record ("those are the two pages that I think we'll be able to
  send this from"). Open: where the ranked list is displayed (next
  question).
