# WP1 Matching Charter - design decisions for "Matching tenants and properties"

Date: 2026-10-24
Status: APPROVED charter (Cameron passed the spec gate 2026-10-26). Whole-spec re-read 2026-10-25 folded in; design
review rounds 1 to 8 folded in (records: design-review/adjudications.md);
review closed at its cap; Cameron's spec-gate answers (2026-10-26)
folded in: staff notes and the Notes box on the card, matching facts as
Notes lines, declines left to WP3, the review dataset (section 12), and
the planner defaults confirmed. Hours: no cut; B1 measures them
(section 15.1). AMENDED 2026-10-26 at the B1 slice restatement (section
20): `AI_MATCHING_NOTES_ENABLED` dropped, the never-written test made
B1's merge gate, the fixed tenant fields built to move into notes later.
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
amended here, with a dated note, and the slice continues. EVERY decision
in this charter binds the slices; section 15.4 names the ones most likely
to be argued, not the only ones.

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

Every place where this charter departs from the signed text is listed in
section 17 for Sam to hear.

## 2. Production facts the design rests on (2026-10-24, read-only count)

- 878 tenant contacts; 670 searching; 385 of the searching have not been
  heard from in 90 days or ever; 45 lack a voucher size or an authority.
- 138 units; 34 marked available, of which 12 are soft-deleted, so 22 live.
  10 of the 22 record no accepted voucher size; 14 accept Atlanta Housing,
  which 486 searching tenants hold.
- NO available unit carries rent_min, rent_max, final_rent,
  payment_standard, subzone or priority. The requirement checkboxes are set
  on one or two.
- Pool per live available property, searching tenants eligible by the
  code's own rule (a unit with no recorded voucher size takes its bedroom
  count, section 5): median 104, worst 158. With the 90-day window: median
  50, worst 64. Pool per searching tenant: at most 5. (Read as "an empty
  list takes every size", the worst case was 493; that reading is NOT the
  rule.)
- A DynamoDB table `matches` (hash tenantId, range unitId, GSI byUnit, TTL
  expires_at) exists in every environment from the Phase 0 design, with no
  repository. Production rows: none counted. The lean seed writes one
  legacy-shape row (app/src/lib/seed/lean.ts:444-456), which B2 replaces.

## 3. Vocabulary (each slice adds the nouns it introduces to GLOSSARY.md in the same change)

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
- The property page's Similar panel shows a rule-based number today
  (ListingDetail.tsx:1502). It is "similarity", never "match"; B4 relabels
  it so the page never shows two match percentages.

## 4. D1 - Soft rules: the model judges, nothing but eligibility excludes

The ranking is one AI judgment over everything on the two cards. A tenant
who fails a recorded SCREENING or PETS requirement (the cap-eligible keys
of section 7.4: no evictions on program, evictions notes, qualifications,
no pets, pets) is NOT removed; the rubric tells the model to land that
pair in the Weak band with the failure as the first reason against. A
deposit, fee or touring requirement the tenant may not meet is a reason
the model weighs, never a forced landing. Sam
sees the pair, at the bottom, with the reason.

That forced landing applies to cap-eligible requirement failures ONLY. A "Not
interested" send outcome, an accessibility need the property cannot meet,
or a rent above the tenant's stated portion are inputs the model weighs,
not rules the rubric dictates. A pair marked Not interested stays in the
pool and is never forced into Weak; the recorded outcome and the extracted
reaction (a hard no, or "maybe, but show me others first") are both on the
pair history for the model to read (Cameron 2026-10-25). A "maybe" read
from context weighs only as a slight reason against, and the age rule in
section 10.3 lets it rise again as time passes.

Why: Cameron 2026-10-24: "the signed contract was a little bit too harsh
... I don't think hard rules are ever going to be the answer." The free
text on both sides (requirement notes, preferences, the Notes box)
cannot be matched by rules at all, and a demoted pair with a reason is
reviewable where an excluded one is invisible.

The only deterministic parts are: the pool (section 5), the completeness
pass (section 7.3), band thresholds and priority (sections 8 and 9), the
Weak cap applied from the model's own report (section 7.4), the selection
defaults (section 13.1), and tie order (section 9.2). None of them is a
fit judgment.

## 5. D2 - The pool: eligibility only

A candidate is in the pool when ALL of these hold. Nothing else removes a
candidate.

Property anchor (candidates are tenants):

- Tenant status is `searching`. Not onboarding: those records lack the
  information to rank, and Work Package 2 moves tenants to searching. Sam
  still reaches an onboarding tenant by hand-adding them (section 13.1).
- Sendable: not opted out, not unreachable, has a phone, not
  soft-deleted: the pre-exclusions the audience resolver applies today
  (audienceResolution.ts:196-199). A candidate who can never be texted is
  never ranked or paid for. Missing SMS consent is NOT a pool rule: as
  today it is a per-candidate flag (audienceResolution.ts:77), shown as
  "consent not recorded" so staff can fix it, and the fan-out still
  refuses that send (broadcastFanOut.ts:276).
- Voucher size: the property's sizes are read ONLY through
  `acceptedVoucherSizes` (app/src/lib/unitFields.ts:453-478: the
  recorded list, otherwise the bedroom count), clamped to the 0-4 chips
  exactly as today's composer prefill does, then compared any-of with 4
  meaning 4 or more. A tenant with no voucher size never matches a
  non-empty list; a unit with neither sizes nor beds takes every size.
- Housing authority: the property's list is read through `authoritiesOf`
  and mapped through the organization list exactly as today's composer
  prefill does (dashboard/src/routes/broadcasts/authorityPrefill.ts); the
  tenant's authority must equal one mapped canonical name. A property
  with no recorded authority takes every authority. A property whose
  recorded authorities do not map is, as today, not limited by authority;
  one where only some map is limited to the mapped ones, as today
  (authorityPrefill.ts:21-31); either way the gap is shown to Sam
  (section 7.3). If the organization list
  cannot be read, the ranking fails with a message; it never runs
  unlimited.
- Recency: heard from within the pool window (section 9.1), 90 days by
  default, configurable. A tenant never heard from counts from created_at, except a contact
  carrying `imported_from`, which never uses that fallback: the import
  stamps that on every contact it touches and created_at only if absent
  (import/apply.ts:1146-1159). A staff-added tenant the import later
  matched is therefore left out until heard from; an accepted error. The composer has a toggle to include older
  tenants.

Tenant anchor (candidates are properties):

- Property status is `available`, the unit is not soft-deleted, and it is
  not committed to another placement (an active placement on the unit for
  a different tenant).
- The size and authority rules above, read from the property's side.

The pool rules apply to CANDIDATES only. The anchor can be any tenant or
property, whatever its status: pressing Send property is Sam's affirmative
choice of that record. When the anchor is not searching or not sendable
(a tenant) or not available (a property), the composer shows a banner
saying so and ranks anyway (Cameron 2026-10-25). A property that is not available still cannot
be SENT: the existing send-time guard (broadcasts.ts:1181-1192) and its
make-available dialog stay, and the banner says so.

Explicitly NOT pool rules, by Cameron's decision: already sent, no reply,
Not interested, Interested, tour outcomes, requirement failures. These are
inputs (section 6.3) and UI chips (section 13.3).

Why: these are facts about whether a lease or a send could happen at all,
not judgments about fit, and they bring the median property-side pool
from about 100 to about 50 (section 2). Everything else is the model's to
weigh.

## 6. D3 - What the model reads: the cards

### 6.1 Definition by classification

Each card is the record projected through ONE classification. No field is
read until it is classified, and at runtime the card function drops every
stored key that is not classified (legacy and tombstoned attributes
included), so it is an allowlist built from the classified set: the slice spec for B2 writes the list as
code, one function per card, with a test that fails when a record field is
neither included nor excluded, so every new field is a decision rather
than drift. Excluded:

- `priority` (section 9 - the model never sees it).
- Raw messages and conversation text (extraction is the reading layer,
  section 6.4).
- Other people's data on the record: the property's contacts list, the
  other tenants it was sent to, placements with other tenants, the
  tenant's `relationships`.
- Credit and income: the unit's credit and income requirement notes and
  the tenant's `lifEligible` flag. A1 excludes credit or income from
  ranking ("staff see those as notes only"), so the model never sees them.
- Internal plumbing: ids, media, status_source and status history, import
  bookkeeping, consent fields, provenance maps, flyer settings, and every
  timestamp except created (last heard from enters only as its bucket,
  section 9.1).
- Phone numbers and email addresses (no matching value). Addresses are
  passed whole on both cards (Cameron 2026-10-25: pass everything or
  nothing, never city and zip only).

Included by default when B2 classifies them: `customFields`,
`voucher_expiration_date`.

Included by decision (Cameron 2026-10-26): the tenant's Notes box
(`notes`), where extraction appends its dated lines and staff also type,
and the tenant's Staff notes (`staff_notes`). Both exist to help staff
understand and match the tenant; Staff notes is a second box only so that
nothing machine-WRITES to it. Its code comment (contactsRepo.ts:161-168)
also says nothing machine-reads it, which was never the intent; B2
corrects the comment. Credit and income facts written in either box are
disregarded by the rubric (section 7.2), as A1 requires.

### 6.2 The two cards

Tenant card: everything on the tenant contact except the exclusions, which
today means name, address, voucher size, housing authority, porting,
tenure, pets, evictions, status, voucher expiration, custom fields, last
heard from as a recency bucket (section 9.1), the B1 fields (area
preference, maximum tenant portion, accessibility need, preferences and
constraints), the Notes box with extraction's matching lines (section
6.4), and Staff notes.

Property card: everything on the unit except the exclusions, which today
means address, beds, baths, rent range, payment standard, accepted voucher
sizes, accepted authorities, pets, accessibility, utilities the tenant
pays, deposit, application fee, same-day RTA, tour type and process,
application process, notes, the requirement checkboxes and every
free-text requirement note except credit and income (section 6.1).

ONE card per record, whichever side the ranking starts from. A pair
scored from a property's page and the same pair read on the tenant's page
were scored from the same two cards, which is what makes one match per
pair true. The two composer views may DISPLAY different things; the
model's input never differs by direction.

Landlord card switch (`RANKING_LANDLORD_CARD`, default off): when on, the
property card also carries the landlord-of-record's recorded requirements
(except credit and income, section 6.1) and notes, labeled as the
landlord's defaults; where the
property records its own value, the property's value wins (requirements
reach a property only by staff "Apply", a copy). Built in B2; turned on
when Sam decides (section 16). While it is off, a landlord requirement
never applied to the property is unread (section 17).

### 6.3 Pair history

Scoped to THIS tenant and THIS property only, and built from STORED facts,
never from the derived outcome: the date of every counted send (the
listing_sends row's shares, telling a flyer sign-up, which is the
tenant's own interest, apart from a send, and falling back to `sentAt` on
a legacy row with no shares), the declined record with who set it and when,
tour requests and outcomes between the two, and every extracted reaction.
The derived outcome (listingSendOutcome.ts:74-91) is not used: it flips
on a new text or a new send, and a re-send supersedes a decline in it,
while the model must still see that the tenant once said no. Time since
the last send is passed explicitly, so a "maybe" from weeks ago can rise
again.

Extracted reactions live on the existing listing_sends pair row as a list
(at, kind, text, source message, run id); no new table. Only a pair whose
listing_sends row is listed with a counted send share, or is a legacy row
with `sentAt` and no shares (the same fallback the pair history uses),
gets reactions; a pending or failed share or a flyer sign-up alone does
not; a reaction about a
property never sent becomes a Notes line instead. The reaction writer
joins the row's change-token protocol (`shares_op`) and the repo
header's list of writers. Kinds are interested, maybe, hard_no and
question, so a WP3 hard_no maps one to one onto a DeclineRecord.
Reactions are written for tenant rows only. WP1 records the reaction and
the ranker reads it; it never sets a status. Recording an engine-read
decline is WP3's deliverable (A1 WP3: "Declines the engine reads in the
conversation are recorded in the decline tracking from Work Package 1"),
through the existing `by: 'engine'` decline; staff mark Not interested
as today.

### 6.4 Extraction is the reading layer (B1)

The ranker never reads conversations. Extraction does, and WP1 widens it
as follows:

- Fixed fields the system needs structurally: area preference (text),
  maximum tenant portion (dollars per month), accessibility need (text),
  preferences and constraints (text). Fixed because the completeness pass
  and the edit form must be able to ask Sam for them, and because A1 names
  them ("new tenant preference fields ... on the record, the edit form and
  the AI reading layer"). AMENDED 2026-10-26: Cameron expects these facts
  to move into the Notes box later, as part of a wider change to how
  extraction stores what it learns
  (docs/issues/extraction-fields-to-notes.md). B1 and B2 build so that
  move is a change in ONE place: a single list in code names each tenant
  matching input and its source; extraction's field entries and B2's
  completeness pass read that list, and the card already carries the
  Notes box, so the ranker needs no change when a source moves.
- MATCHING FACTS go where extraction already puts secondary facts: the
  tenant's Notes box, as its dated `[Auto - <date>]` lines
  (prompt.ts:107-111, apply.ts:713-745). No separate facts list. B1 widens
  the noteLines instruction from "secondary facts" to anything that might
  matter to matching this person with a home (Cameron: "we can't think of
  all of the pieces of information that might be relevant"), and the
  ranker reads the box (section 6.1). The append path, its five-line
  cap per run and its retry guard (apply.ts:731-740, which drops a line
  already present so a re-applied window appends nothing) are kept as
  they are.
- Written LIVE, as notes are today: no approval step is added where none
  exists (Cameron 2026-10-25). Each line carries a confidence; a line
  below `EXTRACTION_FACT_MIN_CONFIDENCE` (default set in B1) is not
  appended and never reaches Sam or the ranker. A run demoted for an
  unknown speaker (apply.ts:158-160) appends no lines, the same demotion
  its field writes get (a change from today, where such a run still
  appends). Sam fixes or removes a wrong line by editing the Notes box,
  as today; a line removed by hand can return only if a later message
  states it again.
- Never written as a Notes line: race, color, religion, sex, national
  origin, familial facts beyond household size, and disability or
  medical facts other than the stated accessibility need and an
  assistance animal. The same list governs the text of every extracted
  reaction (section 6.3). Screening facts the box carries today (utility
  debt and the like) stay, because Sam uses them; the
  ranker disregards their credit and income content (section 7.2). B1
  tests the list: synthetic conversations stating each excluded kind of
  fact, run on the testing key, must append no line and write no reaction
  of an excluded kind (household size and tenant portion remain allowed).
  The test is B1's MERGE GATE: B1 is not handed back merge-ready until it
  passes on the widened prompt, or Cameron decides. AMENDED 2026-10-26:
  there is no production switch for the widened instruction and the
  reactions (the `AI_MATCHING_NOTES_ENABLED` this bullet named is
  dropped); extraction writes only to the record and sends nothing, so
  Cameron judged a switch an extra code path that protects nothing the
  merge gate does not. The list governs Notes lines and reaction text
  only; the fixed free-text fields above are not covered by it or by the
  test (Cameron 2026-10-26).
- One reading per send: the tenant's reaction to the specific property
  named, written to the pair history (section 6.3).

The landlord-side counterpart is filed,
not built: docs/issues/landlord-conversation-extraction-to-property.md.

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
inputs and how each bears on fit, the demotion rule for cap-eligible
requirement failures (section 4; other requirements and declined sends
are weighed, never forced), what the percentage means at anchor points
(100 nothing against and preferences met; 80 strong fit with minor
compromises; 60 workable with a real compromise; 40 unlikely; 0 cannot
work), the reasons format (phrases or single words, each tagged with its
source input), and the rule that uncertainty is scored as uncertainty, not
guessed away. Scores are ABSOLUTE against those anchor points, not
relative to the other candidates in the call: the listwise call buys
consistency and cost, and batching and reuse across directions rely on a
70 meaning the same thing everywhere. A ranking may therefore hold matches
written by different presses (another anchor's Update rewrites a shared
pair); that mixed provenance is accepted.

Fair housing: the rubric states that protected characteristics (race,
color, religion, sex, national origin, familial status, disability) never
lower a score. Disability enters only for the tenant's benefit: their own
stated accessibility need matched to the property, and an accommodation
(below) that lifts a requirement. A requirement about the tenant's credit or
income, in ANY field (qualifications, notes, deposit notes, application
process, custom fields), is disregarded and never reported failed (A1).
So is a tenant's credit or income fact wherever it is written (the Notes
box, Staff notes, custom fields). Rent, the payment standard and the
tenant's maximum portion are not credit or income and stay inputs. Names stay on the cards
(Cameron 2026-10-25); the pool (section 5) uses no protected
characteristic. A landlord or property requirement that is unacceptable
under fair housing (for example "no kids", which discriminates on
familial status) is NOT applied: the model is
told to disregard it and to report it, and the composer shows Sam a flag
naming that requirement as one to remove from the record (section 7.4).

Two kinds of flag, never confused. UNLAWFUL: the requirement or text is
unacceptable for every tenant, so Sam removes it from the record; it may
name any FREE-TEXT requirement or field on the property card (notes,
lease terms, application process, qualifications, details fields), never
a checkbox: No pets and No evictions on the program are lawful on their
face, and a tenant they must not apply to is an accommodation. ACCOMMODATION: a lawful
requirement that does not apply to THIS tenant, for example No pets
against an assistance animal; it suppresses the cap for that pair and
asks for no record change. Only an unlawful flag ever asks Sam to change a
record.

An unlawful flag becomes a PROPERTY-level record (field, a hash of the
field's text, the model's reason, the run that raised it), kept in the AI
runs table under a per-property key family and shown on the property
record (B4) and in the composer. It closes on read as soon as the field's
text no longer matches the hash, so no unit writer has to know about it.
While it is open, that field caps no pair of that property, including
pairs where the model missed it: a false flag costs a cap, never a
tenant. Dismiss is DISPLAY-ONLY: it hides the banner, the cap stays
suppressed, and only an admin can press it, audited with the text at that
moment. A requirement Sam believes lawful is made to read lawfully by
editing its text, which closes the flag; the model is never told to apply
a requirement it judged unlawful (Cameron 2026-10-25: an unlawful
requirement "is something for Sam").

The guarantee is tested, not only stated: before `AI_RANKING_ENABLED` is
first turned on in production (B2's own live test included), B2 runs a counterfactual check on the testing key over SYNTHETIC pairs
(made-up tenants and properties, never real records), swapping name,
address, household facts and any credit or income line (an address swapped only for one equivalent
for the tenant's stated area, so a fit change cannot pass for a proxy)
and including an assistance-animal tenant against a No pets property; scores and the Weak cap (section 7.4) are
compared against a tolerance B2 sets, and the result is a mission record.
A failure blocks turning ranking on in production (`AI_RANKING_ENABLED`,
default off) until it passes or Cameron decides (Cameron 2026-10-26).

The rubric version is stored on every match and run. Worked examples are
versioned separately (`examplesVersion`) and grow from synthetic to real
as section 12 describes.

### 7.3 The completeness pass

Before the call, code marks each card's gaps against a fixed list: on a
property, rent, payment standard, accepted voucher sizes (a size inferred
from beds counts as missing), recorded authorities that do not map to
the organization list, pets, accessibility; on a tenant, voucher size, authority, area preference,
maximum tenant portion. The flags go to the model with the card and come
back on the match as the Missing list (merged with the model's own
uncertainty notes, de-duplicated). Missing data never breaks a ranking and
is never silently tolerated: it is shown (section 13.4).

### 7.4 Output contract

Structured output (`output_config.format`), all keys required, sentinels
for "none", clamped on parse, exactly as the extraction schema does. Per
candidate: `candidateId`, `score` 0-100, `for[]`, `against[]`, each
`{text, source}`, `unknowns[]`, `failedRequirements[]` (keys of
recorded requirements the model judged failed), `fairHousingFlags[]`
(each `{kind: unlawful | accommodation, field}`, where field is a
requirement key or a free-text field on the property card, section 7.2;
per candidate, so a flag names the property whose record holds it, and
unlawful flags merged across batches by property and field; accommodation
flags stay per pair). Code reads those two lists to cap a band and raise a flag;
band, priority, tie order and chips are otherwise computed in code from
the score.

A pair is capped at Weak in code, whatever its score, when its
`failedRequirements` holds a CAP-ELIGIBLE key (no_evictions_on_program,
evictions_notes, qualifications, no_pets, pets; requirements.ts:69-108)
that is a recorded requirement on that property's card, is not in the
same pair's accommodation flags, and has no open unlawful flag on that
property (section 7.2); a key failing any test is ignored. A credit,
income or move-in-cost clause inside a cap-eligible key never counts as
failed. Move-in costs, touring, credit and income never cap, so the cap can never enforce a
requirement the rubric disregards. A capped pair gets no priority
treatment at all (section 9.2), sorts last within Weak, and its row reads
"requirement not met" beside the score. This
enforces the section 4 landing from the model's own report; code does not
compare free text itself (tenant pets and evictions are free text).

`candidateId` is a per-call handle (c1, c2, ...) mapped back to the
record in code, since ids are not on the cards. A candidate the model did
not return, returned twice or under an unknown handle, and every candidate
of a failed batch (API error, refusal, truncation) gets NO new match: an
existing match is left untouched and flagged out of date (the read joins
the anchor's last ranking-job record, which lists its failed batches),
and a candidate with no match shows "not scored - retry". The next Update re-scores the
whole pool. A default or guessed score is never written.

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

Three roles:

- Pool window (property anchor only, where tenants are candidates):
  tenants heard from within `RANKING_POOL_WINDOW_DAYS` (default 90) are
  in the pool; the composer toggle shows the rest.
- Model input, in BOTH directions (one card per record, section 6.2): a
  recency BUCKET (this week, this month, one to three months, older,
  never), not the timestamp. Only the bucket is fingerprinted, so a text
  that adds nothing to the record never makes a match out of date;
  crossing into another bucket does (Cameron 2026-10-25).
- Tie order (property anchor only): equal scores order by most recently
  heard from, falling back to created_at for a tenant admitted on that
  fallback.

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
  Sam picks the default (section 16). No lift and no priority tie
  preference apply to a capped pair (section 7.4): A1 gives priority "every ranking it
  qualifies for".
- A priority-only view in the composer that hides every non-priority
  candidate while the full ranking stays computed underneath.

Sort order on read, one per anchor:

- Property anchor (candidates are tenants): band, then score, then last
  heard from. Priority does not apply; it is the anchor's own attribute.
- Tenant anchor (candidates are properties): band after the priority
  strength, then priority on before off, then score, then property address.
  A Priority badge on the row.

In both, pool members with no match yet sort last, shown "not ranked
yet".

Priority is an on/off boolean on the unit (`priority`), set on the
property edit form and shown on the property record. The existing
free-form string field is unused in production (0 values); B1 replaces it
with the boolean and drops the string without migration.

## 10. D7 - The match record and when it is computed

### 10.1 Pair rows in the matches store

One row per tenant-property pair in the DynamoDB table `matches` (hash
tenantId, range unitId, GSI byUnit for the property side, TTL
expires_at). Fields: score; for[]; against[]; missing[];
failedRequirements[]; fairHousingFlags[]; stage (1 now); rubricVersion;
examplesVersion; model; runId;
computedAt; anchorSide (which side's call produced it, for the run log
only); fingerprints: tenantCard, unitCard, pairHistory. TTL
`RANKING_PAIR_TTL_DAYS` default 180. Reviews are NOT a field on this row
(section 12), so a rewrite never erases one. Rows without this shape (the
legacy seed row) are ignored by the reader.

Not stored: band, priority effect, chips, sort position - all derived on
read, so a threshold or setting change needs no re-rank.

Why pair rows: both pages read the same facts; work done from a property's
page is shown on each of its tenants' pages with no new call while it is
current; staleness is per pair; the table already exists (A1: no new
infrastructure).

### 10.2 On demand, never on open

A ranking is computed when a human presses Rank (or Update) in the
composer. Opening a page reads stored rows and makes no model call.

Where it runs: ranking runs the way extraction does, on its OWN worker
poll loop over due ranking-job records (the extraction precedent,
worker.ts:436-466), never on the SQS jobs queue. That consumer awaits a
whole receive batch before it receives again (sqsJobConsumer.ts:126-129),
so a one-to-two-minute ranking there would hold up group-text fan-out
and sends. This is a named exception to AGENTS.md's "all job traffic
goes through jobs.enqueue()", on the extraction precedent and for that
reason. A poll tick starts a fresh context (pollLoop.ts:54-77), so the
queued record carries the Rank request's correlation id and traceparent,
and the poll restores both before it runs the job. Queued and running
records carry a byEntity key family (lib/tables.ts:645-655) that the poll
queries, running ones sorted by lease expiry so an expired lease is
found;
pickup waits up to the shared poll interval (config.ts:608-612), which
the queued record's expiry allows for.

The claim: pressing Rank makes the app write the anchor's ranking-job
record as queued, one conditional write that succeeds only when no live
job holds the anchor, carrying a new claim generation; a press that loses
the write joins the job that won, unless its window setting differs, in
which case it is refused with "a ranking is running". A queued record
expires on its own short timer if no poller takes it. The poll loop
claims a queued record with a lease it renews while running; an expired
lease means the job died, and the poll itself takes the record over
with a new generation and re-runs it ONCE, enough to cover a redeploy;
a second expiry marks it failed with a message that a new press clears.
The attempt count is on the record, as extraction counts and parks
(extractionRepo.ts:76-80, 169-192). The job
checks its generation before every model call and every write and exits
quietly if it has been superseded. It never throws on a model, batch or
organization-list failure: it records the failure on the record and
finishes. The generation check before a write is not atomic with the
match write, so a superseded job can still write the batch it had in
flight; the newer job rewrites every pair, so this is accepted. Its batches run in parallel with a per-call timeout. Status:
queued, running, done, failed with a message, and the list of failed
batches.

Results: each batch's matches are persisted as it finishes; a server-sent
event says only "anchor, batch n done" (never scores: the stream reaches
every dashboard), and the composer re-reads by GET, polling as a
fallback, because the worker-to-app bridge is best-effort by design
(lib/eventBridge.ts:1-11). After done, it reads the run's matches by key
from the base table, never through the eventually consistent byUnit
index. So the 30-second CloudFront origin timeout
(infra/modules/cloudfront/main.tf:114) never applies to a model call.
Rank, Update and the review controls are open to admin and va, as the
composer is today (broadcasts.ts:1-4): VAs see and use everything in
the composer, scores included; only the Rankings page is admin-only
(Cameron 2026-10-26). Rank gets its own
per-user rate-limit knob, parsed fail-fast like the
existing cost-route knobs (app/src/lib/config.ts:1021-1040). The
ranking-job record lives in the AI runs table in its own key family with
a TTL of at least `RANKING_MAX_AGE_DAYS` (its failed-batch list must outlive
the matches it flags), and the run listing and run-detail readers (routes/aiRuns.ts:
139-140, 228-249) never return it.
With `AI_RANKING_ENABLED` off, the ranking poll does not start and the
composer shows the pool unscored, in its deterministic order, with no
Rank button.

Background or scheduled ranking is out of WP1 (A1 excludes it); the engine
is one function so a scheduled caller (WP3 era) would be configuration,
not a redesign. One ranking job is in flight per anchor at a time
(the claim above).

### 10.3 Fingerprints and what "out of date" means

On read, the engine compares each stored match's fingerprints with the
current cards and pair history, and checks its age:

- A card or the pair history changed: that match is flagged "this
  candidate's match is out of date". When the anchor's own card changed,
  the ranking as a whole is flagged.
- Age: a match computed more than `RANKING_MAX_AGE_DAYS` (default 7) ago
  is flagged out of date even when nothing changed, because elapsed time
  is itself an input: a "maybe" from three weeks ago must be able to rise
  (Cameron 2026-10-25).
- Version: a match scored under a rubric version, worked-examples version
  or model other than the current one is flagged out of date.
- A candidate newly in the pool has no match yet ("not ranked yet"); one
  that left the pool is not shown.

ONE button. Rank, or Update when anything is flagged, re-scores the WHOLE
pool of the anchor as one ranking (batched as in section 7.1) and writes
every pair fresh. There is no per-candidate re-score and no insertion call
(Cameron 2026-10-25). Cost per press is in section 14.

What changes a fingerprint, and what does not: the cards as defined in
section 6 (recency only as its bucket); on the pair history (section 6.3),
the declined record, a tour, or an extracted reaction. A new send ALONE
does not make a match out of date, and neither does a text that adds
nothing to the record: the derived outcome is never fingerprinted. A text
that extraction turns into a field, Notes line or reaction does,
correctly, and so does a staff edit to either notes box. The Already sent and outcome
chips are derived on read and show at once.

Sam decides whether to update; an out-of-date list is still shown.

## 11. D8 - The run log, cost, and the Rankings page

Every model call is a run in the existing AI runs table, under its OWN
entity keys and scope: the extraction run log and its readers
(routes/aiRuns.ts, the 'global' index) never list ranking runs, the
run-detail route (routes/aiRuns.ts:228-249) refuses a ranking run by kind,
and a ranking run carries no conversation. A run holds: anchor, direction,
candidate count, batch index, model, rubric version, input and output
tokens, cost in dollars from a price table in configuration, latency, the
raw structured output, and the ids of the matches it wrote. Ranking runs
are kept 180 days, the same as matches, so every ranking stays recorded
for Sam's review period (A1: "Each ranking is recorded so Client can
review it").

The Rankings page (admin only, like the AI runs page, routes/aiRuns.ts:137;
Cameron 2026-10-26; B2) lists runs newest first with anchor,
direction, model, candidates, cost and time, filters by date and anchor,
totals cost by week and by environment, and opens a run into its pairs.
It also lists Sam's reviews, promotes a review to a worked example, and
downloads the review export (section 12).
It is where the engine is live-tested in production before the composer
views exist: B2 gives it
a staff-only "Rank this anchor" action, so a ranking can be run before
B3's composer. Spend is two ledgers: testing-key spend counts against the A1
section 8 testing budget ($750 overall, matching checks $20-40), which
Cameron watches, enforces with an account spend limit on the testing key
(A1 allows Developer to set one), and must notify Sam before exceeding; production ranking
spend is an operating cost on the production key, outside A1 section 8.

## 12. D9 - Sam's review

Capture is continuous: where she reads a ranking is where she reviews it.
Each row in the composer carries agree / disagree and an optional note; a
disagree also says which way ("should be higher" or "should be lower"),
because a bare disagree cannot tell a rubric change whether it helped.
Each review is its OWN record, every one kept, never expiring: verdict,
direction, note, by, at, plus a snapshot of the match she judged (score,
reasons, missing, rubric version, examples version, model) AND of the
exact model input (both cards and the pair history as sent), so the pair
can be re-scored later under a new rubric. A later re-score never touches
it, so the row can show "reviewed at 62, now 71". Reviews live in an
EXISTING table (B2 picks it and proposes the key; A1 allows no new
infrastructure).

The review dataset (Cameron 2026-10-26). The reviews are the dataset, used
two ways: worked examples in the prompt, and an evaluation set that tests
a rubric change against Sam's judgments. It grows from synthetic to real:

- Day zero (B2): about ten SYNTHETIC worked examples spread across the
  bands, including a capped pair, an accommodation pair and a pair with
  missing inputs, and about thirty synthetic evaluation pairs with the band
  each should land in. They live in the repository. Cameron checks them;
  Sam is asked to glance at the bands.
- From Sam's acceptance pass on: every review is a real labeled pair.
  An admin promotes chosen reviews to worked examples on the Rankings page;
  promoted examples are stored in production in the same existing table,
  and each promotion makes a new `examplesVersion`. The production prompt
  reads the synthetic file plus the promoted set.
- Export: an admin download on the Rankings page. By default it is
  DE-IDENTIFIED: names, phone numbers, emails and street lines are
  replaced with consistent stand-ins, while area and zip stay so area fit
  still reads. An identified export is built only after Sam approves it
  in writing.
- Growing it, per rubric revision: export (or work from the Rankings
  page), pick examples, edit the rubric, then run the EVALUATION: a script
  on the testing key that re-scores every pair in the set from its
  snapshot under the current and the candidate rubric and examples, and
  reports agreement with Sam (an agreed pair should keep its band; a
  "higher" or "lower" pair should move that way). A candidate ships only
  if agreement does not fall and the counterfactual check (section 7.2)
  still passes; the new version then flags every older match out of date
  (section 10.3). The run is a mission record.

The app never reads reviews to score; their path to the model is a
promoted example or a rubric change a person makes after an evaluation.

Contract basis (Development Agreement, read 2026-10-26): improving a
model operated within Client's own approved environment with Client data
is permitted (section 7.3); real tenant or landlord data may not be used
in development or test environments, which may hold synthetic or
de-identified data (sections 7.3 and 2); copying production tenant or
landlord data to a local or external environment needs Client's written
approval (section 2). The de-identified export and the synthetic set
satisfy the first two; the identified export waits on the third. No
identified client record is ever committed to the repository.

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
- Any record can be the anchor (section 5); a banner says when it is not
  searching, not sendable or not available. Ranking is never blocked; sending a
  non-available property stays refused by the existing guard.
- The Send entries already exist ("Send a property to this tenant",
  TenantFile.tsx:320; the property page's send, ListingDetail.tsx:438).
  B3 and B4 re-point them; they are not new.
- A partner record's "Send a property to this partner"
  (PartnerFile.tsx:178) keeps today's seeds-only flow, with no ranking.

The existing filter-only audience (status, authority, voucher size) is
removed from the composer in B4; the pool rules and the window toggle
replace it. What that path carries today, and what happens to each:

- Selection default: ranked rows start UNCHECKED; Sam picks one, a few or
  many (A1). Today's default checks every eligible row
  (blastAudienceRules.ts:178-182), which on a ranked pool would text Weak
  and capped pairs with one press (Cameron 2026-10-26).
- Select all checks only the rows today's default would check (consent
  recorded, not already sent, not Not interested, not tour-held,
  blastAudienceRules.ts:178-182) and that are not capped; Sam checks
  everything else one at a time, the tour-held ones with the confirm. The
  explicit-selection send path never re-excludes already-sent rows
  (broadcasts.ts:1196-1202), so this default is the guard against
  re-texting a tenant who declined.
- Hand-picks and "Add a tenant" stay beside the ranked pool and start
  checked, as today (Cameron 2026-10-26). This is how Sam still sends to an onboarding tenant
  or a partner.
- The tour-hold rule (an upcoming tour or a past tour with no outcome,
  blastAudienceRules.ts:59-165) becomes a chip on the row and a confirm
  when such a row is checked. It never removes a candidate.
- Drafts saved with a filter audience before B4 resume with their filter
  UI until sent or deleted; new drafts never show it.
- Follow-ups are untouched.

The composer is dashboard/src/routes/broadcasts; B3 and B4 both edit it
and never run in parallel.

### 13.2 The ranked row (built once, B3)

Band and score, the Priority badge, reasons for and against as chips with
their source on hover, Missing as its own chip group, the fair-housing
flag where raised, outcome chips using the shipped outcomes
(listingSendOutcome.ts:22: Already sent with date, No reply, Replied,
Interested, Not interested, Signed up), the out-of-date warning (the single Update button sits on the composer,
section 10.3), the select
control, and agree / disagree.

### 13.3 History on the rows

Tenant anchor: already-sent properties stay in the list with their chips
(Cameron: the "maybe, but show me others first" case must be able to rise
again). Property anchor: tenants already sent this property whose
outcome is No reply are hidden by default behind a counted filter chip
("7 already sent - show"); every other outcome shows with its chip. Send history is a model input in both directions regardless.

### 13.4 Completeness banner

When the anchor is missing inputs from the section 7.3 list, the composer
shows a banner naming them ("This property is missing rent and payment
standard. Rankings are weaker.") with a link into the edit form. The same
on a candidate row through its Missing chips. This is how Sam is pushed to
complete records; nothing refuses to rank.

### 13.5 One-step send and the outcome

Sending from the composer records the send on the pair (listing sends,
tracker #27 shape). The row shows Already sent at once; the send alone does
not make the match out of date (section 10.3). A later decline, tour or
extracted reaction does. The outcome controls (No
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
- Cost envelope (section 2 pools, Sonnet, one press re-scores the whole
  pool): a typical property ranking ~8 cents, worst ~10 cents, a tenant
  ranking ~2 cents; about 100 property and 500 tenant rankings a month is
  about 20 dollars of production operating cost (section 11). Testing
  spend is separate and counts against A1 section 8.
- Prompt caching: not designed in. With one button the only repeated
  prompt prefix is between the batches of one large ranking, worth about
  a cent; B2 may switch it on if a measurement shows it pays.
- Testing key: a key separate from production on Sam's Anthropic account
  (A1 section 6), needed before B2 calls the model. Cameron's item.

## 15. D12 - Build order and slice boundaries

### 15.1 The slices

| Slice | Owns | Hours |
|---|---|---|
| B1 Ranking inputs | Tenant fields area preference, maximum tenant portion, accessibility need, preferences and constraints on the record and edit form; `priority` boolean on the unit, its edit-form control and record display; extraction schema widened (fixed fields; the noteLines instruction widened to matching facts, each line with a confidence and the floor, no lines from unknown-speaker runs, the never-written list; per-send reaction stored on the listing_sends row under shares_op); the never-written test covering Notes lines and reactions, run as B1's merge gate (no production switch, amended 2026-10-26); the one list of tenant matching inputs and their sources (section 6.4). Ships to production first. | 8-10 |
| B2 Ranking engine | Pool in both directions with the window and the sendability fences; cards by classification with the runtime allowlist and the landlord switch; card fingerprint helpers; completeness pass; rubric, examples, structured output; anthropic/fake/console drivers; the ranking poll loop and the ranking-job record (claim generation, lease, one takeover, failed batches, carried trace); persisted batches, event hint, GET and base-table re-read; matches with the out-of-date, age and version rules and the one-button whole-pool re-score; the lean seed row replaced; review records with direction and input snapshots, the in-app review list, example promotion and `examplesVersion`, the synthetic examples and evaluation set, the de-identified export, the evaluation script; the Staff notes comment corrected; the cap with its key list, accommodation flags and the property-level unlawful-flag record; the counterfactual fair-housing check on synthetic pairs; the Rank rate-limit knob and roles; `AI_RANKING_ENABLED`; run log under its own keys with cost by environment; band and priority policy on read; endpoints: rank, read ranking by anchor, review a pair; the Rankings page with "Rank this anchor". | 33-42 |
| B3 Send property from a tenant | The ranked row; the composer's tenant anchor; priority-only view; completeness banner; Rank/Update; one-step send with the outcome on the pair; agree/disagree with the disagree direction; the tenant record's Send re-pointed. | 10-12 |
| B4 Send property from a property | The composer's property anchor; ranked tenants replacing the filter-only audience, the window toggle, rows unchecked by default and Select all, with hand-picks, the tour-hold chip and confirm, old filter drafts and the partner flow kept (section 13.1); already-sent No reply filter chip; pick one, a few or many; the switch-off composer; the unlawful-flag display on the property record with the admin Dismiss; the Matching nav entry asking which record to start from; the property page's Send re-pointed; the Similar panel relabeled "similarity". | 13-16 |

RE-ESTIMATE (2026-10-25, after the eight-round review; revised
2026-10-26 for the gate answers): 64-80 hours against the 52 contracted.
The review added most of the build: B2's job architecture and
fair-housing records; B4's selection and flag surfaces. The gate answers
moved matching facts into the Notes box (B1 down 2-3) and added the review
dataset (B2 up 3-4). A1 section 7 makes the hours an estimate; going over
is Cameron's call to cut scope or to tell Sam before the hours are spent.
Cameron 2026-10-26: no scope cut now; he expects the gap to be smaller
than estimated, and B1 runs first to measure real hours against its
estimate before the scope question is revisited. All four bill to WP1.

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

Sections 4 (soft rules), 5 (pool), 6.1 (cards by classification), 7.1 (staged
pipeline, stage one listwise, no tools), 8 (score, bands, reasons,
missing), 9 (priority never a model input; last heard from roles), 10
(pair rows; on demand; fingerprints and the age rule; one button, whole
pool), 11 (run log with cost; Rankings page), 12 (continuous review;
every review kept as its own record with its input snapshot; the dataset
from synthetic to real; no identified client record committed), 13.1 (one composer, two anchors; Send property on both records),
14 (model per stage; fake driver), 15.2 (order), and the compliance
decisions: 6.3 (reactions recorded, declines left to WP3), 6.4 (matching
facts as Notes lines, the never-written list, its test as B1's merge gate), 7.2 (fair housing,
credit and income, the counterfactual gate), 7.4 (the cap and its key
list), 10.2 (no SQS queue for ranking; one automatic takeover), 13.1
(selection defaults). A slice that needs one changed brings it to
Cameron.

## 16. Questions for Sam (before or during B2)

1. Priority strength default: within band, one band up, or always first?
   And confirm priority means "fill this property first", not fit.
2. The signed text excludes in several places where the build demotes or
   only weighs (section 17). OK?
3. The ranking is computed when she presses Rank, not on opening a page,
   and tells her when it is out of date. OK?
4. Will she fill accepted voucher sizes (10 of 22 live available lack
   them), rent and the payment standard on properties? Does she use the
   Payment standard field today, and where does the number come from?
5. 29 searching tenants carry voucher size 10 - a code or data errors?
6. Landlord card in the property card: on or off to start?
7. Should the 90-day window be a different number?
8. A landlord requirement that fair housing does not allow (for example
   "no kids") is flagged to her, not applied. Will she remove those from
   the records when flagged?

## 17. Where this charter departs from the signed text

Each is a deliberate call, listed so Sam hears all of them (section 16.2).

- Requirement failures: "excluded" in the signed text; built as a demotion
  to Weak with the reason shown (section 4). Cameron 2026-10-24.
- "Every available property" ranked, with voucher size and housing
  authority as inputs: the pool makes a size or authority mismatch a hard
  exclusion, and also a tenant who can never be texted (opted out,
  unreachable, no phone), because no lease or send could follow
  (section 5).
- Already sent and declined: "excluded or demoted automatically"; built as
  inputs the model weighs, with chips, never forced (sections 4, 5, 13.3).
  On the property anchor, sent-with-no-reply tenants are hidden by default.
- Onboarding tenants: the signed text keeps them in the tenant ranking;
  the pool is searching only, and Sam reaches an onboarding tenant by hand
  (sections 5, 13.1).
- Tours: tenants with an upcoming tour or a past tour without an outcome
  are "excluded"; built as a model input plus a chip and a confirm when
  such a row is checked (section 13.1).
- Last heard from: the signed text uses it to rank; the build also uses a
  90-day window that hides quieter tenants by default, with a toggle
  (section 9.1).
- Priority: "push a property to the top of every ranking it qualifies
  for"; built with a strength setting whose proposed default sorts first
  only inside its band; always first is one setting away (section 9.2).
- Landlord requirement notes: read only when the landlord card switch is
  on; until Sam turns it on, a landlord requirement never applied to the
  property is unread (section 6.2).
- Each ranking recorded: built as matches overwritten on each press plus
  the run log kept 180 days, and every review kept (sections 10, 11, 12).
- Scope reaching into WP3: the signed WP3 text reads tenant reactions
  ("too far") during sharing; B1 builds the per-send reaction reading and
  the widened Notes instruction now and bills them to WP1, because the
  ranking reads them (section 6.4).
- "Computed on open" / no background re-rank: built as computed on
  request with stored rankings shown on open (section 10.2). Still no
  background work; one more click, far less spend.
- "Find tenants" action on the property record and "find properties" view
  on the tenant record: both are the Send property action opening the
  composer (section 13.1). The amendment's views exist; they share one
  surface.

## 18. Explicitly later (not WP1)

Stage two refinement (7.1). Landlord-conversation extraction to the
property (issue filed). An extracted "hard no" setting a decline (WP3,
section 6.3). Tools for the model
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
- Latency: a stage-one batch of 40 is estimated at 25-35 seconds on
  Sonnet; batches run in parallel inside the job (section 10.2) and the
  composer shows the pool while results arrive (in last-heard-from order
  on the property anchor).
  B2's plan measures it on the testing key before the UI commits to a
  loading pattern.
- Server-sent events from the worker are best-effort (section 10.2): B2
  proves the GET re-read and the polling fallback, not the bridge.
- `matches` TTL semantics ("volatile, bulk-regenerated") predate this
  design; B2 confirms the TTL attribute and GSI match section 10.1 and
  files an infra note only if a change is needed (no infra without
  Cameron's explicit ask).

## 20. Amendments

Each entry is a decision Cameron changed after the charter gate, per
section 0. Earlier text is edited in place and marked AMENDED with the
date; this list is the index.

- 2026-10-26, at the B1 slice restatement (records:
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/intent.md):
  1. `AI_MATCHING_NOTES_ENABLED` is dropped. Cameron: the switch is "just
     an extra headache" because extraction is not "used to actually send
     anything directly". The never-written test becomes B1's merge gate
     instead (sections 6.4, 15.1, 15.4).
  2. The never-written list stays limited to Notes lines and reaction
     text; the fixed free-text tenant fields are not added to it or to its
     test (section 6.4).
  3. The fixed tenant fields are expected to move into the Notes box
     later. B1 and B2 build so that is a one-place change: one list of
     tenant matching inputs and their sources (sections 6.4, 15.1).
     Wider direction filed: docs/issues/extraction-fields-to-notes.md.
