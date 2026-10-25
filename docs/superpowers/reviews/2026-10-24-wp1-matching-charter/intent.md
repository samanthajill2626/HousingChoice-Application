# Intent record - WP1 matching charter

Mission: Amendment No. 1 Work Package 1, "Matching tenants and properties" -
the CHARTER only. A decision-level design spec that the four build slices
(B1 Ranking inputs, B2 Ranking engine, B3 Find properties, B4 Find tenants)
cite instead of re-deciding. No plan, no build in this mission.

Planner session: 85fa9966-6850-4ae9-83c5-7049190fea14 (Claude Fable 5.1).
Worktree: W:\tmp\wp1-matching-charter, branch feat/wp1-matching-charter,
cut from main @970a29b9. Docs only.

## STATE

If you are reading this after a compaction: re-invoke the Skill
abt:feature-mission with the argument "RESUME WP1 charter", read this file
and the pool-count record, run the replay (command in the feature-mission
skill, output W:/tmp/wp1-matching-charter/.superpowers/sdd/conversation.md)
and READ ALL OF IT, report back in one line, then continue below. (Cameron
gave his go on 2026-10-25; the earlier wait-for-go rule is spent.)

Phase: SPEC WRITTEN and sent to Cameron for his WHOLE-SPEC RE-READ
(2026-10-24) - docs/superpowers/specs/2026-10-24-wp1-matching-charter-
design.md, 19 sections, committed (18445409). Brainstorm closed after 14
rounds, all recorded below. Launch mode: none - this mission stops after
Cameron's spec gate; spec + records merge as a docs-only branch. Nothing
in flight. Worktree W:/tmp/wp1-matching-charter, branch
feat/wp1-matching-charter from main 970a29b9; the shared checkout stays
on main.

WHOLE-SPEC RE-READ CLOSED (2026-10-25), rounds 15-16 below.
DESIGN REVIEW ROUND 1 DONE (2026-10-25): reviewers A (23) and B (27),
merged to 28 findings in design-review/adjudications.md; 26 accepted, 3
partly rejected; folded into the spec. Planner defaults awaiting Cameron
at the gate: M5 anonymized examples, M7 no auto-decline in WP1, M8 B4
keeps hand-picks/tour-hold default/old drafts/partner flow, M10 the B2
counterfactual fair-housing check, M22 staff notes off the card. ROUND 2 DONE: 22 findings, all accepted and folded; new planner defaults:
ranked rows start unchecked (R2-2), examples written from scratch with no
export (R2-13/14, replaces M5), notes off the card. ROUNDS 1-4 DONE, cap reached (design-review/adjudications.md). Cameron
2026-10-25: "Because this is so large, let's keep going with the
adversarial reviewers. Let's do another max of 4 rounds." Phase now:
REVIEW ROUNDS 5-8. ROUND 5 DONE: 23 findings (A 7, B 16), 20 rulings all
accepted, 6 decisions changed (ranking off the SQS queue onto its own poll
loop like extraction; credit/income in any field, cap-eligible keys;
unlawful flags property-wide; claim generation and queued expiry;
disability facts never extracted; fair-housing test failure blocks
production enablement). ROUND 6 DONE: 9 accepted, 4 decisions (carried trace and the named
AGENTS.md exception; property-level unlawful flags staff resolve; reaction
text under the never-extracted list; roles: Rank for admin+va, Rankings
page admin only - planner default). ROUND 7 DONE: 6 accepted, 2 narrow decisions (Dismiss display-only and
admin-only; one automatic takeover then failed). Round 8 - LAST - goes to
reviewer B. Round 7 continued reviewer B. Round 5 was both reviewers continued (A and B, outputs
design-review/r5-reviewer-a.md, r5-reviewer-b.md); later rounds continue
the better one; stop when a round changes no decision; hard cap round 8,
then the spec gate with the five planner defaults (staff notes off; no
auto-decline; examples from scratch, no export; counterfactual on
synthetic pairs plus the never-extracted test; ranked rows unchecked with
the B4 keep-list).

NEXT STEP: the ADVERSARIAL DOCUMENT REVIEW: round 1
= two independent Opus reviewers in parallel, same brief
(W:/AI Projects/claude-plugins/abt/skills/feature-mission/design-review-briefs.md),
spec + repo only, blind to this file and the brainstorm; adjudicate every
finding (accept/reject/defer), write
docs/superpowers/reviews/2026-10-24-wp1-matching-charter/design-review/adjudications.md
and commit; rounds 2+ continue the better reviewer with SendMessage;
stop when a round changes no decision, cap 4. Then Cameron's spec gate
(show counts and every REJECT inline). Then: merge command for the
docs-only branch (he merges), register-session --off, memory update. No
plan, no build in this mission. Cameron's list: testing API key from
Sam (before B2); WP1 hours log.

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

## Decisions, round 11 (Cameron, 2026-10-24)

- D-composer: ONE composer, TWO anchors - the existing Matching composer
  (dashboard/src/routes/broadcasts) becomes the ranking surface. Send
  property on a property record opens it anchored on the property (ranked
  tenants replace the filter-only audience; pick one, a few or many);
  Send property on a tenant record opens it anchored on the tenant (ranked
  properties; pick one). Matching nav entry stays and asks which record to
  start from. Cameron: "That matches what we're using right now for the
  matching page today, although it really has been more focused on the
  one-to-one sending. This can still be used the same way, but just has an
  automated matching process."
- D-rerun: re-running on the same property shows tenants already sent and
  not yet replied as such: "Either they're not a fit, or we're filtering
  them from the list on that matching page." Planner reading, pending his
  flip: on the PROPERTY anchor the composer hides already-sent-awaiting-
  reply tenants by default behind a counted filter chip ("7 already sent -
  show"); on the TENANT anchor already-sent properties stay visible with
  their chip (round 5). Send history remains a model input either way.

## Decisions, round 12 (Cameron, 2026-10-24)

- D-model: Sonnet 5.5 for stage one ("probably the way to go for right
  now"), model name per stage in configuration like the extraction model;
  Opus 5.5 is the default for the refinement stage when it is added;
  Haiku 5.5 stays out of WP1 (a cost cut to prove under the A1 section 9
  model-comparison option first). Deterministic fake driver for e2e,
  modeled on the extraction fake. Every run records cost from a price
  table in configuration.

## Decisions, round 13 (Cameron, 2026-10-24)

- D-cards-denylist: the tenant and property cards are EVERYTHING on the
  record except an explicit exclusion list - "include everything we can as
  information and let the LLM sort it out." Excluded: priority (decided),
  raw/direct messages, other people's data on a record (e.g. the other
  tenants a property was sent to - "unaffiliated people"; pair history is
  scoped to THIS pair), and internal plumbing (ids, media, status_source,
  import bookkeeping).
- HOLE named by Cameron: facts learned in LANDLORD conversations
  (accessibility, washer/dryer hookups) have no path onto the property
  card. Verified: extraction writes only contact-level targets (8 tenant
  profile fields + address/status/type/phone); nothing writes a unit; the
  landlord requirement keys reach a property only by staff "Apply to
  properties" (copy-only rule, GLOSSARY). Proposal in the message of
  2026-10-24: (b) WP1 property card also carries the landlord-of-record's
  facts; (a) landlord-conversation extraction targeting the property is
  a scope addition for Cameron to place (B1, or priced separately).
- D-extraction-open: extraction gets AUTONOMY to pull "anything that might
  matter to the matcher" - an open list of matching facts (label, value,
  confidence, source) - IN ADDITION to the fixed fields the system needs
  structurally (max tenant portion as a number for the completeness pass
  and the edit form). Cameron: "The former is really what we need to do
  because we can't think of all of the pieces of information that might be
  relevant."

## Decisions, round 14 (Cameron, 2026-10-24)

- D-landlord-card-seam: NOT built in WP1 either way. "We build it so that
  we can add the landlord card in if we decide to after we talk to Sam" -
  the property card has a switch (config) that, when on, appends the
  landlord-of-record's recorded requirements, notes and matching facts.
  Off by default; Sam question added.
- D-file-landlord-extraction: landlord-conversation extraction targeting
  the property is FILED, not built:
  docs/issues/landlord-conversation-extraction-to-property.md (deferred;
  "part of the landlord onboarding or the property onboarding step, and
  possibly part of the sharing step ... work package 3 and work package
  4").

## Decisions, round 15 (Cameron, 2026-10-25, on the whole-spec re-read)

- Fair housing: the rubric line "protected traits never lower a score" is
  fine; names STAY on the cards ("I don't know if we need to go as far as
  taking the tenant's name off"). His priority: "we are not using a
  protected trait to fully disqualify somebody from the pool list". He
  questioned whether familial status is protected and whether fair housing
  bears on ranking at all - answered 2026-10-25, his call pending on the
  landlord "no kids" note flag.
- Not interested: never forced into Weak, stays in the pool; "we need to
  make sure that we're not specifying how the LLM is supposed to treat
  these." A hard no stays recorded as Not interested; a "maybe" from
  context should weigh only as a weak reason against (planner reading of
  "forced as a 'weak against'", to confirm).
- Recency: "We don't want any new text to make a contact go out of date"
  - bucket adopted. Single shared match per pair confirmed; two different
  UIs are fine.
- Anchor: any status, affirmative choice; banner, "definitely not a full
  bar on that feature".
- Tenant address: whole ("either pass everything or pass nothing"); phone
  and email out.
- Efficiency: later, after the engine exists. He floated ONE Update button
  that re-scores the whole ranking, no per-candidate re-score, and asked
  whether prompt caching then matters. Pending.
- Reviews: wants them kept but "part of a training set that lives outside
  the application"; asked whether review is continuous or a set period.
  Pending.
- Matching facts: unclear what "written live" meant; floated a Today-page
  queue with the 5-item cap and a More items line. Pending.
- Precision edits: "Let's have you include them." Folded, except the two
  that depend on the one-button question (Rank scoring only unmatched
  pairs; the drift-guard source).

## Decisions, round 16 (Cameron, 2026-10-25, closing the re-read)

- Fair housing: a requirement that is "very clearly unacceptable by Fair
  Housing standards" is "not a thing that we should be trying to train the
  model against. That's something for Sam" - not applied, flagged to Sam
  as a requirement to remove.
- "Weak against" meant a slight reason against, not the Weak band. "I
  definitely don't want them to be placed in a specific band because they
  said 'not interested.'"
- Age rule: "a 7-day rule is fine" - a match older than 7 days is out of
  date, so a "maybe" can bubble up. Chosen over a time-since-send bucket.
- Reviews: continuous capture; "If anything is agreed or disagreed with, we
  don't want an automatic expiration"; unreviewed matches expire normally.
  Reviews are a training set outside the app (round 15).
- Matching facts: written live, no approval ("We don't want approval to be
  shoved into the process where no approval exists today"), with a
  confidence floor below which a fact is not written at all. Note for B1:
  today's extraction is mixed - some targets write directly, some become
  suggestions (app/src/services/extraction/apply.ts:318); matching facts
  follow the write path.
- One Update button re-scoring the whole pool; prompt caching left to B2
  ("let's go with your solution").
