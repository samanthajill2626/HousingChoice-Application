# WP1 Matching Charter - design decisions for "Matching tenants and properties"

Date: 2026-10-24
Status: DRAFT charter, awaiting Cameron's whole-spec re-read, then the
adversarial document review, then his spec gate.
Mission: Amendment No. 1 Work Package 1 (signed; Cameron 2026-10-20, Sam
2026-10-21). 52 contracted hours.
Records: docs/superpowers/reviews/2026-10-24-wp1-matching-charter/
(intent.md holds the brainstorm decisions verbatim; prod-pool-count.md
holds the production numbers this charter leans on).

## 0. How to read this document

This is a CHARTER, not a build spec. It settles the decisions that cut
across all of Work Package 1 so that the four build slices (section 15) do
not re-decide them. Each slice gets its own short design spec and plan,
written just before it starts and citing this document by section number.

Rule for slices: a slice spec may refine a charter decision (add detail,
name files, pick exact copy) but may NOT reverse one. A slice that finds a
charter decision wrong stops and brings it to Cameron; the charter is
amended here, with a dated note, and the slice continues. The list of
decisions that may not be reopened is in section 15.4.

Hours in this document are Cameron's hands-on hours, not agent wall time.

## 1. What WP1 is for

Sam matches by hand: she filters the tenant list by voucher size and
housing authority, opens a browser tab per tenant, reads each conversation,
and keeps a per-property sticky note of who looked interested. WP1 replaces
that with a ranking in both directions. From a property, Sam sees the
tenants who fit it, best first, with a match percentage and the reasons,
and sends it to the ones she picks. From a tenant, she sees the properties
that fit them, best first, and sends one. Every ranking is recorded so she
can review how the AI read her clients and her properties.

Signed scope (A1 section 4, WP1): AI ranking only, no rule-based scorer;
inputs voucher size, housing authority, rent against the payment standard,
area, pets, accessibility, stated preferences, and (tenant side) last heard
from; a priority on/off flag on properties; a "find properties" view on the
tenant record with a one-step send and the outcome recorded; a directed
send from a property with ranked tenants, match percentage and reasons
replacing the filter-only audience, and a "find tenants" action on the
property record; new tenant preference fields (area, maximum tenant
portion, free-text constraints) on the record, the edit form and the AI
reading layer. Not included: several properties per message, priority
levels beyond on/off, background re-ranking, the platform choosing tenants
by itself, credit or income used to rank or exclude.

Two places where this charter deliberately reads the signed text loosely
are listed in section 17 for Sam to hear.

## 2. Production facts the design rests on (2026-10-24, read-only count)

- 878 tenant contacts; 670 searching; 385 of the searching have not been
  heard from in 90 days or ever; 45 lack a voucher size or an authority.
- 138 units; 34 marked available, of which 12 are soft-deleted, so 22 live.
  10 of the 22 record no accepted voucher size; 14 accept Atlanta Housing,
  which 486 searching tenants hold.
- NO available unit carries rent_min, rent_max, final_rent,
  payment_standard, subzone or priority. The requirement checkboxes are set
  on one or two.
- Pool per live available property, searching tenants eligible as
  recorded: median 104, worst 493. With a 90-day last-heard-from window:
  median 57, worst 199. Pool per searching tenant: median 8, max 10.
- A DynamoDB table `matches` (hash tenantId, range unitId, GSI byUnit, TTL
  expires_at) exists in every environment from the Phase 0 design, with no
  rows and no repository.

## 3. Vocabulary (add to GLOSSARY.md in B2)

- **Matching** - the feature and its page (the composer).
- **Ranking** - the ordered list of candidates for one anchor, at one
  moment. "Rank" is the verb for producing it.
- **Anchor** - the record a ranking is for: a property (candidates are
  tenants) or a tenant (candidates are properties).
- **Candidate** - a record in the anchor's pool.
- **Pool** - the candidates that pass the eligibility rules (section 5).
  Being out of the pool is the ONLY exclusion in WP1.
- **Match** - one tenant-property pair's score and reasons. Shown as the
  match percentage. One match per pair, shared by both directions.
- **Band** - Strong / Good / Possible / Weak, derived from the score in
  code.
- **Reason** - a phrase for or against a match, tagged with the input it
  came from. **Missing** - an input the match could not use because the
  record lacks it. Reasons and missing are never mixed.
- **Matches store** - the DynamoDB table `matches`. Never "the matches
  table" in prose near UI text: the Matching page also shows a table.
- **Card** - the projection of a record the model reads (section 6).
- **Fingerprint** - a hash of a card or of a pair's history, stored with
  the match, compared on read to detect change (section 10).
- Human copy: tenant-facing "home", landlord and staff "property", code
  `unit`, per GLOSSARY.md.

## 4. D1 - Soft rules: the model judges, nothing but eligibility excludes

The ranking is one AI judgment over everything on the two cards. A tenant
who fails a recorded requirement (no evictions on program, no pets, a
free-text note) is NOT removed; the rubric tells the model to land that
pair in the Weak band with the failure as the first reason against. The
same holds for a "Not interested" send outcome, an accessibility need the
property cannot meet, or a rent above the tenant's stated portion. Sam
sees the pair, at the bottom, with the reason.

Why: Cameron 2026-10-24: "the signed contract was a little bit too harsh
... I don't think hard rules are ever going to be the answer." The free
text on both sides (requirement notes, preferences, extracted facts)
cannot be matched by rules at all, and a demoted pair with a reason is
reviewable where an excluded one is invisible.

The only deterministic parts are: the pool (section 5), the completeness
pass (section 7.3), band thresholds and priority (sections 8 and 9), and
tie order (section 9.2). None of them is a fit judgment.

## 5. D2 - The pool: eligibility only

A candidate is in the pool when ALL of these hold. Nothing else removes a
candidate.

Property anchor (candidates are tenants):

- Tenant status is `searching`. Not onboarding: those records lack the
  information to rank, and Work Package 2 moves tenants to searching.
- The tenant's voucher size is one the property takes, by the blast rule:
  any-of; the 4 chip means 4 or more; an empty list on the property takes
  every size; a tenant with no voucher size never matches a non-empty
  list.
- The tenant's housing authority is one the property accepts, same any-of
  and empty-list rules, compared trimmed and case-insensitive.
- The tenant was heard from within the pool window (section 9.1), 90 days
  by default, configurable; the composer has a toggle to include older
  tenants.

Tenant anchor (candidates are properties):

- Property status is `available`, the unit is not soft-deleted, and it is
  not committed to another placement (an active placement on the unit for
  a different tenant).
- The size and authority rules above, read from the property's side.

Explicitly NOT pool rules, by Cameron's decision: already sent, no reply,
Not interested, Interested, tour outcomes, requirement failures. These are
inputs (section 6.3) and UI chips (section 13.3).

Why: these are facts about whether a lease could happen at all, not
judgments about fit, and they are what bring the property-side pool from
~500 to ~60 (section 2). Everything else is the model's to weigh.

## 6. D3 - What the model reads: the cards

### 6.1 Definition by exclusion

Each card is the FULL record projected through ONE exclusion list, so any
field added to a record later is read automatically. Excluded:

- `priority` (section 9 - the model never sees it).
- Raw messages and conversation text (extraction is the reading layer,
  section 6.4).
- Other people's data on the record: the property's contacts list, the
  other tenants it was sent to, placements with other tenants.
- Internal plumbing: ids, media, status_source and status history, import
  bookkeeping, timestamps other than created and last heard from,
  provenance maps, flyer settings.
- Phone numbers, emails and street numbers are passed only where the model
  needs them (the property address is passed whole for area reasoning; the
  tenant's address is passed as city/zip only).

The slice spec for B2 lists the exclusion as code, one function per card,
with a test that fails when a new record field is neither included nor
listed, so the list is a decision each time rather than drift.

### 6.2 The two cards

Tenant card: everything on the tenant contact except the exclusions, which
today means name, voucher size, housing authority, porting, tenure, pets,
evictions, status and last heard from, the B1 fields (area preference,
maximum tenant portion, accessibility need, preferences and constraints),
the extracted matching facts (section 6.4), staff notes, and the
requirement-relevant history.

Property card: everything on the unit except the exclusions, which today
means address, beds, baths, rent range, payment standard, accepted voucher
sizes, accepted authorities, pets, accessibility, utilities the tenant
pays, deposit, application fee, same-day RTA, tour type and process,
application process, notes, the requirement checkboxes and every
free-text requirement note (credit and income notes included - read as
context the tenant may or may not meet, never to rank or exclude, A1).

Landlord card switch (`RANKING_LANDLORD_CARD`, default off): when on, the
property card also carries the landlord-of-record's recorded requirements,
notes and matching facts. Built as a switch in B2, decided with Sam.

### 6.3 Pair history

Scoped to THIS tenant and THIS property only: every send (date, the
recorded outcome, and the extracted reaction such as "said maybe, wanted to
see others first"), tour requests and outcomes between the two. Time since
the last send is passed explicitly, so a "maybe" from weeks ago can rise
again.

### 6.4 Extraction is the reading layer (B1)

The ranker never reads conversations. Extraction does, and WP1 widens it
in two ways:

- Fixed fields the system needs structurally: area preference (text),
  maximum tenant portion (dollars per month), accessibility need (text),
  preferences and constraints (text). Fixed because the completeness pass
  and the edit form must be able to ask Sam for them.
- An open list of MATCHING FACTS per tenant: `{label, value, confidence,
  source message}`, with the instruction to pull anything that might
  matter to matching this person with a home. Cameron: "we can't think of
  all of the pieces of information that might be relevant."
- One reading per send: the tenant's reaction to the specific property
  named, written to the pair history (section 6.3).

Facts show on the record where Sam can dismiss a wrong one, through the
existing suggestion flow. The landlord-side counterpart is filed, not
built: docs/issues/landlord-conversation-extraction-to-property.md.

## 7. D4 - The ranker

### 7.1 Shape: a staged pipeline, stage one in WP1

Stage one (WP1): one listwise call per ranking. The prompt carries the
rubric, the structured-output schema, a small set of worked examples, the
anchor card, and every pool candidate's card with its pair history and
completeness flags. The model returns, per candidate, a score, reasons for,
reasons against, and its own uncertainty notes. Pools above
`RANKING_BATCH_SIZE` (default 40) are split into batches sharing the same
rubric and anchor; batch results merge by score.

Stage two (NOT WP1, designed for): a refinement call over the top
`RANKING_REFINE_TOP` (default 12) with fuller reasons. The matches store
holds a stage field so adding it changes nothing downstream. It is the
first addition if Sam's review shows the top of the list is where quality
falls short.

Not in WP1: the model asking for more information through tools. Revisit
once sharing (WP3) produces tenant questions about properties.

Why not pointwise (one call per candidate): scores would not be relative,
and thinking is paid once per call. Why not a reranking model: it returns a
bare relevance score and cannot produce reasons or weigh a requirement
note; a shortlisting stage would only earn its place at pools in the
hundreds, which the window removes.

### 7.2 The rubric

The rubric is a versioned prompt file in the app workspace. It states the
inputs and how each bears on fit, the demotion rule for requirement
failures and declined sends, what the percentage means at anchor points
(100 nothing against and preferences met; 80 strong fit with minor
compromises; 60 workable with a real compromise; 40 unlikely; 0 cannot
work), the reasons format (phrases or single words, each tagged with its
source input), and the rule that uncertainty is scored as uncertainty, not
guessed away. The rubric version is stored on every match and run. Worked
examples are a separate versioned file; Sam's reviewed matches (section
12) are the source of new examples.

### 7.3 The completeness pass

Before the call, code marks each card's gaps against a fixed list: on a
property, rent, payment standard, accepted voucher sizes, pets,
accessibility; on a tenant, voucher size, authority, area preference,
maximum tenant portion. The flags go to the model with the card and come
back on the match as the Missing list (merged with the model's own
uncertainty notes, de-duplicated). Missing data never breaks a ranking and
is never silently tolerated: it is shown (section 13.4).

### 7.4 Output contract

Structured output (`output_config.format`), all keys required, sentinels
for "none", clamped on parse, exactly as the extraction schema does. Per
candidate: `candidateId`, `score` 0-100, `for[]`, `against[]`, each
`{text, source}`, `unknowns[]`. Nothing else is trusted from the model;
band, priority, tie order and chips are computed in code.

## 8. D5 - What a match is

- Score 0 to 100, shown as a match percentage. 0 bad, 100 good.
- Bands from the score, in code: Strong 80-100, Good 60-79, Possible
  40-59, Weak 0-39. Starting values, tunable without a prompt change;
  changing them re-ranks nothing.
- Reasons: up to three for, up to three against, phrases or single words
  ("stairs", "no pets, has a cat", "sent 3 wks ago, no reply"), each
  tagged with the input it came from.
- Missing: a separate list (section 7.3). Never shown as a reason.
- One match per tenant-property pair, shared by both directions (section
  10). The score is a property of the pair, not of the page.

## 9. D6 - Priority and last heard from

### 9.1 Last heard from

Three roles, all on the property anchor (on the tenant anchor the tenant
is the anchor and it does not apply):

- Pool window: tenants heard from within `RANKING_POOL_WINDOW_DAYS`
  (default 90) are in the pool; the composer toggle shows the rest.
- Model input: recency inside the window is on the card as a signal of
  active search.
- Tie order: equal scores order by most recently heard from.

Later (not WP1, WP3 era): outreach to tenants approaching the window
("still looking?"); a reply refreshes last heard from, silence moves them
to inactive or the proper status.

### 9.2 Priority

Priority is Sam's instruction to fill a property first. It is NOT fit, so
the model never sees it and it never changes a score. Two deterministic
mechanisms, both where properties are the candidates (a tenant's ranking):

- Strength setting `RANKING_PRIORITY_STRENGTH`: `within_band` (default -
  priority properties sort first inside their band), `one_band_up`
  (sorts as if one band higher, score shown unchanged), `always_first`.
  Sam picks the default (section 16).
- A priority-only view in the composer that hides every non-priority
  candidate while the full ranking stays computed underneath.

Sort order on read: band (after the priority strength), then priority on
before off, then score, then last heard from. A Priority badge on the row.

Priority is an on/off boolean on the unit (`priority`). The existing
free-form string field is unused in production (0 values); B1 replaces it
with the boolean and drops the string without migration.

## 10. D7 - The match record and when it is computed

### 10.1 Pair rows in the matches store

One row per tenant-property pair in the DynamoDB table `matches` (hash
tenantId, range unitId, GSI byUnit for the property side, TTL
expires_at). Fields: score; for[]; against[]; missing[]; stage (1 now);
rubricVersion; model; runId; computedAt; anchorSide (which side's call
produced it, for the run log only); fingerprints: tenantCard, unitCard,
pairHistory; review (section 12). TTL `RANKING_PAIR_TTL_DAYS` default 180.

Not stored: band, priority effect, chips, sort position - all derived on
read, so a threshold or setting change needs no re-rank.

Why pair rows: both pages read the same facts; work done from a property's
page is reused on each of its tenants' pages when fingerprints still
match; staleness is per pair; Sam's review attaches to the pair; the table
already exists.

### 10.2 On demand, never on open

A ranking is computed when a human presses Rank (or Update) in the
composer. Opening a page reads stored rows and makes no model call.
Background or scheduled ranking is out of WP1 (A1 excludes it); the engine
is one function so a scheduled caller (WP3 era) would be configuration,
not a redesign.

### 10.3 Fingerprints and what "out of date" means

On read, the engine compares each stored row's fingerprints with the
current cards and history:

- Anchor card changed -> the ranking is out of date as a whole; the
  composer says so and offers a full re-rank.
- Only some candidates changed (card or pair history) -> those rows are
  flagged "this candidate's match is out of date"; Update re-scores only
  them, each by an insertion call (rubric, anchor, the other candidates
  with their existing scores as context, output for the changed candidate
  only). A candidate newly in the pool is an insertion; one that left the
  pool is dropped with no call.
- Drift guard: a full re-rank is offered instead of insertions when more
  than `RANKING_INCREMENTAL_LIMIT` (default 10) candidates changed, or the
  newest full ranking is older than `RANKING_FULL_RERANK_DAYS` (default 7).

Sam decides whether to update; an out-of-date list is still shown.

## 11. D8 - The run log, cost, and the Rankings page

Every model call is a run in the existing AI runs store (same pattern and
the same 90-day retention as extraction): anchor, direction, candidate
count, batch index, model, rubric version, input and output tokens, cost
in dollars from a price table in configuration, latency, the raw
structured output, and the ids of the rows it wrote.

The Rankings page (staff only, B2) lists runs newest first with anchor,
direction, model, candidates, cost and time, filters by date and anchor,
totals cost by week, and opens a run into its pairs. It is where the engine
is live-tested in production before the composer views exist, and where
Cameron and Sam watch the A1 section 8 matching budget.

## 12. D9 - Sam's review

Where she reads a ranking is where she reviews it: each row in the composer
carries agree / disagree and an optional note, stored on the pair row as
`review {verdict, note, by, at}`. The Rankings page shows review counts per
run. Reviewed pairs are the source of new worked examples for the rubric
(section 7.2); turning a review into an example is a human step in a later
rubric revision, not an automatic one.

A1 acceptance: Sam opens twenty real tenants and ten real properties in
production and finds the rankings useful. B3 provides the tenant half, B4
the property half.

## 13. D10 - Surfaces: one composer, two anchors

### 13.1 Entry points

- Property record: a **Send property** action opens the Matching composer
  anchored on the property. Candidates are ranked tenants; Sam picks one, a
  few or many, writes or accepts the message, sends (the existing path).
- Tenant record: a **Send property** action opens the same composer
  anchored on the tenant. Candidates are ranked properties; Sam picks one
  and sends it (one property per message, A1).
- The Matching navigation entry stays and first asks which record to start
  from.

The existing filter-only audience (status, authority, voucher size) is
removed in B4; the pool rules and the window toggle replace it. The
composer is dashboard/src/routes/broadcasts; B3 and B4 both edit it and
never run in parallel.

### 13.2 The ranked row (built once, B3)

Band and score, the Priority badge, reasons for and against as chips with
their source on hover, Missing as its own chip group, outcome chips
(Already sent with date, No reply, Interested, Not interested, Tour
pending), the out-of-date warning with its Update button, the select
control, and agree / disagree.

### 13.3 History on the rows

Tenant anchor: already-sent properties stay in the list with their chips
(Cameron: the "maybe, but show me others first" case must be able to rise
again). Property anchor: tenants already sent this property and not yet
replied are hidden by default behind a counted filter chip ("7 already
sent - show"); Not interested and Interested tenants show with their
chips. Send history is a model input in both directions regardless.

### 13.4 Completeness banner

When the anchor is missing inputs from the section 7.3 list, the composer
shows a banner naming them ("This property is missing rent and payment
standard. Rankings are weaker.") with a link into the edit form. The same
on a candidate row through its Missing chips. This is how Sam is pushed to
complete records; nothing refuses to rank.

### 13.5 One-step send and the outcome

Sending from the composer records the send on the pair (listing sends,
tracker #27 shape) and the match row's pair-history fingerprint changes, so
the next read shows the row as sent, not stale. The outcome controls (No
reply yet / Interested / Not interested) remain where they are today.

## 14. D11 - Models, drivers and configuration

- Stage one: `AI_RANKING_MODEL`, default `claude-sonnet-5-5` (the
  extraction model; A1 prices on Sonnet). Stage two: `AI_RANKING_REFINE_MODEL`,
  default `claude-opus-5-5` when the stage is added. Haiku stays out of
  WP1; a Haiku coarse pass is proven under the A1 section 9 model-comparison
  option first if cost ever matters.
- Drivers: `anthropic` (structured outputs, adaptive thinking at effort
  low unless the slice spec measures otherwise, the per-model thinking
  trap honored as in extraction), `fake` (deterministic scorer from the
  cards, fixed rules, no network - used by every e2e spec and the hermetic
  stack), `console`. The ranking driver lives beside the extraction
  driver in app/src/adapters; the only Anthropic SDK imports stay there.
- Price table in configuration (dollars per million input and output
  tokens per model) so a run's cost is recorded at the time of the call.
- Cost envelope (section 2 pools, Sonnet): a typical property ranking ~9
  cents, worst ~31 cents, a tenant ranking ~3 cents; about 100 property and
  500 tenant rankings a month is ~30 dollars, falling with pair reuse. The
  A1 matching budget lines total 60-100 dollars.
- Testing key: a key separate from production on Sam's Anthropic account
  (A1 section 6), needed before B2 calls the model. Cameron's item.

## 15. D12 - Build order and slice boundaries

### 15.1 The slices

| Slice | Owns | Hours |
|---|---|---|
| B1 Ranking inputs | Tenant fields area preference, maximum tenant portion, accessibility need, preferences and constraints on the record and edit form; `priority` boolean on the unit; extraction schema widened (fixed fields, matching facts list, per-send reaction); card fingerprint helpers. Ships to production first. | 7-9 |
| B2 Ranking engine | Pool in both directions with the window; cards by exclusion list with the landlord switch; completeness pass; stage-one call, rubric, examples, structured output; anthropic/fake/console drivers; pair rows with reuse, insertion, drift guard; run log with cost; band and priority policy on read; endpoints: rank, read ranking by anchor, review a pair; the Rankings page; GLOSSARY entries. | 20-24 |
| B3 Send property from a tenant | The ranked row; the composer's tenant anchor; priority-only view; window toggle; completeness banner; Rank/Update; one-step send with the outcome on the pair; agree/disagree; Send property action on the tenant record. | 9-11 |
| B4 Send property from a property | The composer's property anchor; ranked tenants replacing the filter-only audience; already-sent-awaiting-reply filter chip; pick one, a few or many; the Matching nav entry asking which record to start from; Send property action on the property record. | 11-13 |

Total 47-57 against 52 contracted, Sam's acceptance pass inside it. All
four bill to WP1.

### 15.2 Order

Strictly B1 -> B2 -> B3 -> B4. B1 first so preference data accumulates
before anything ranks. B3 before B4 so Sam reviews tenant-side rankings in
production while B4 builds. B3 and B4 both edit the composer: never in
parallel worktrees.

### 15.3 Each slice is its own feature mission

Brainstorm, spec, plan, launch gate, build-orchestrator in its own worktree
under W:\tmp, independent review, Cameron merges. Each spec opens by
citing this charter and lists which sections it implements.

### 15.4 Decisions no slice may reopen

Sections 4 (soft rules), 5 (pool), 6.1 (cards by exclusion), 7.1 (staged
pipeline, stage one listwise, no tools), 8 (score, bands, reasons,
missing), 9 (priority never a model input; last heard from roles), 10
(pair rows; on demand; fingerprints), 11 (run log with cost; Rankings
page), 13.1 (one composer, two anchors; Send property on both records),
14 (model per stage; fake driver), 15.2 (order). A slice that needs one
changed brings it to Cameron.

## 16. Questions for Sam (before or during B2)

1. Priority strength default: within band, one band up, or always first?
   And confirm priority means "fill this property first", not fit.
2. The signed text says a tenant who fails a requirement is excluded; the
   build demotes to the bottom with the reason instead. OK?
3. The ranking is computed when she presses Rank, not on opening a page,
   and tells her when it is out of date. OK?
4. Will she fill accepted voucher sizes (10 of 22 live available lack
   them), rent and the payment standard on properties? Does she use the
   Payment standard field today, and where does the number come from?
5. 29 searching tenants carry voucher size 10 - a code or data errors?
6. Landlord card in the property card: on or off to start?
7. Should the 90-day window be a different number?

## 17. Where this charter reads the signed text loosely

- "A property is also excluded when the tenant's record shows the tenant
  does not meet a requirement": built as a demotion to Weak with the
  reason shown (section 4), Cameron's call 2026-10-24, to be confirmed
  with Sam (16.2).
- "Computed on open" / no background re-rank: built as computed on
  request with stored rankings shown on open (section 10.2). Still no
  background work; one more click, far less spend.
- "Find tenants" action on the property record and "find properties" view
  on the tenant record: both are the Send property action opening the
  composer (section 13.1). The amendment's views exist; they share one
  surface.

## 18. Explicitly later (not WP1)

Stage two refinement (7.1). Landlord card switched on (6.2). Landlord-
conversation extraction to the property (issue filed). Tools for the model
to ask for more (7.1). Any scheduled or background caller of the engine
(10.2). Dormant-tenant outreach (9.1). An authority-by-bedroom payment
standard table: WP1 reads the per-property Payment standard field as
entered; a table is a later improvement if Sam's numbers come from one.
Cross-property "which priority property has the best tenants" view.
Several properties per message. Priority levels beyond on/off. Credit or
income used to rank or exclude.

## 19. Open items and assumptions

- Hours log: A1 invoices monthly by work package; every slice's hours are
  logged against WP1 from B1's first hour.
- Testing key from Sam before B2 (14).
- The 24-optional-parameter cap in structured outputs applies to the
  ranking schema as it did to extraction; B2 designs the per-candidate
  object all-required with sentinels.
- Latency: a full stage-one call over ~57 candidates is estimated at 25-35
  seconds on Sonnet; B2 streams rows as they arrive and shows the pool in
  last-heard-from order while scores load. B2's plan includes a measured
  spike before the UI commits to a loading pattern.
- `matches` TTL semantics ("volatile, bulk-regenerated") predate this
  design; B2 confirms the TTL attribute and GSI match section 10.1 and
  files an infra note only if a change is needed (no infra without
  Cameron's explicit ask).
