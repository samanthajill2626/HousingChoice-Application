# WP1 matching charter - adversarial design review, round 1, reviewer B

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
(read at b1ee9394). Contract: A1 Work Package 1 text (signed copy).
Code read read-only in W:/tmp/wp1-matching-charter. I did not read the
design-conversation records. Production numbers in spec section 2 are
UNVERIFIED (no prod access, by instruction).

Severity is the consequence if the charter ships unfixed.

---

## 1. [BLOCKING] The pool's voucher-size and authority rules contradict the one server reader of a unit's sizes and authorities

What is wrong. Section 5 says the property side of the pool follows "the
blast rule: any-of; the 4 chip means 4 or more; an empty list on the
property takes every size". A property does not store chips and does not
have "an empty list" in the sense the charter uses:

- A unit's accepted sizes are `voucher_size_accepted`, a list of integers
  0..12, not chips 0..4 (app/src/lib/unitFields.ts:40, 117-124, 182).
- Server code reads a unit's sizes ONLY through `acceptedVoucherSizes`,
  which falls back to the unit's `beds` when nothing is recorded
  (unitFields.ts:454-478, "Server code reads a unit's voucher size ONLY
  through this function"). The existing composer prefill uses exactly that
  reader (dashboard/src/routes/broadcasts/BroadcastComposer.tsx:208,
  broadcastFormat.ts:80-82). So today a property with no recorded size and
  3 beds reaches 3-BR tenants, not every tenant.
- Applying `voucherSizeMatches` (lib/blastAudienceRules.ts:238-243) to a
  raw unit list breaks for 5+ BR units: list [5], tenant 5 -> tenantSize >=
  4 -> `sizes.includes(4)` is false -> no match. It only works if the list
  is first clamped through `bedroomSizesOfFilter`, which in turn makes a
  4-BR unit take every voucher 4..12 (including the 29 "size 10" tenants
  of 16.5).
- Authorities: a unit's list is read through `authoritiesOf`, which
  synthesizes a one-member list from a legacy `jurisdiction` string
  (unitFields.ts:433-452). A builder who reads `accepted_authorities` raw,
  as section 5 implies, turns every legacy-only unit into "accepts every
  authority".

Section 2's "10 of the 22 record no accepted voucher size" reads the RAW
field. Under the charter's empty-list rule those 10 take every size; under
the server reader they take their beds. The spec does not say which rule
produced its pool counts (median 104 / 57, per-tenant 8-10), so the
numbers the window and cost envelope rest on are of unknown provenance.

What it implies. Section 5 is on the 15.4 no-reopen list, and it is the
ONLY exclusion in WP1. B2 must either break the "only through
acceptedVoucherSizes" invariant or contradict the charter. The charter
must name the readers (`acceptedVoucherSizes`, `authoritiesOf`), say
whether the beds fallback counts as "recorded" (it also decides whether
7.3 flags the size as Missing), state how 5+ BR lists compare, and say
which rule section 2's counts used.

## 2. [HIGH] "Nothing else removes a candidate" drops the existing TCPA, consent, deleted and no-phone fences

What is wrong. Section 5: "A candidate is in the pool when ALL of these
hold. Nothing else removes a candidate." Today's property send excludes,
at resolution, opted-out (`sms_opt_out`) and unreachable
(`sms_unreachable`) tenants as "the first TCPA fence", and any tenant with
no phone (app/src/services/audienceResolution.ts:8-10, 196-199), and it
reads only non-deleted contacts (contactsRepo.ts:1394-1400). The fan-out
then skips no-consent recipients (jobs/broadcastFanOut.ts:15-19), and the
review step never checks a no-consent row by default
(blastAudienceRules.ts:178-183). The pool rules name none of these, and
the property-anchor rules do not even say "not soft-deleted" (the tenant
anchor does say it for units).

What it implies. As written, B2 ranks (and pays to rank) STOP'd,
unreachable, phoneless and soft-deleted tenants, and B4 "replaces the
filter-only audience" with a pool that has lost the first fence. Either
these are pool rules (reachability is a fact about whether a lease could
happen through this channel, like the others) or the charter must say
explicitly that they are display fences applied after ranking, and that
the send path keeps them. Silence here is a compliance regression.

## 3. [HIGH] Excluding onboarding tenants contradicts the signed text and removes reach that ships today, undisclosed

What is wrong. Section 5: "Tenant status is `searching`. Not onboarding."
A1 WP1: "Tenants are excluded when they are not in Onboarding or
Searching" - onboarding is IN. Today's property send reads both
partitions (blastAudienceRules.ts:21-22, audienceResolution.ts:12-18).
The stated reason ("those records lack the information to rank")
contradicts 7.3 and 13.4 ("Missing data never breaks a ranking ...
nothing refuses to rank"). Section 17 does not list this deviation.

What it implies. After B4 removes the filter audience, Sam can no longer
send a property to onboarding tenants from the property side at all -
a regression of shipped behavior and a departure from the description
the 30-day defect clause is measured against. Either include onboarding
or list it in section 17 and section 16 for Sam.

## 4. [HIGH] Section 17 is not a complete list of where the charter departs from the signed text

What is wrong. Section 1 says "Two places ... are listed in section 17";
section 17 lists three. More importantly, these departures are not listed
at all:

- A1 (property side): tenants are excluded when they "have an upcoming
  tour or a past tour without an outcome, are already in a placement,
  have already been sent the property or declined it". Charter 5: tour
  outcomes, already sent and Not interested are explicitly NOT pool
  rules; 13.3 only hides already-sent-and-not-replied behind a chip and
  SHOWS Not interested tenants. Today's composer at least leaves held,
  sent and declined tenants unchecked (blastAudienceRules.ts:178-183).
- A1 (tenant side): properties are "excluded or demoted automatically
  when ... already sent to that tenant, declined by that tenant". Charter
  4: a declined pair is "never forced into Weak"; whether it moves at all
  is the model's call. Neither excluded nor automatically demoted.
- A1: priority lets Client "push a property to the top of every ranking
  it qualifies for". Charter 9.2 default `within_band` does not put it at
  the top. Section 16.1 asks Sam, but 17 does not flag it as a loosening.
- Onboarding (finding 3).
- Scope: B1's open "matching facts" list and per-send reaction reading
  go beyond WP1's delivered list ("new tenant preference fields ... so
  preferences learned in conversation are captured") into WP3's
  "Reactions such as 'too far' ... are read and recorded". Billing that
  to WP1's 52 hours is a scope choice Sam has not seen.

What it implies. Completion is a good-faith agreement measured against
the WP1 description. Sam is being asked (16.2, 17) about one exclusion
change while at least five others ship unannounced. Section 17 and 16
need the full list.

## 5. [HIGH] The D1 forced-Weak rule applies to credit and income requirements, which A1 forbids using to rank

What is wrong. Section 4: "A tenant who fails a recorded requirement (no
evictions on program, no pets, a free-text note) ... the rubric tells the
model to land that pair in the Weak band". `credit_requirements` and
`income_requirements` are recorded requirement keys on every unit
(unitFields.ts:136-138, lib/requirements.ts) and 6.2 puts them on the
property card. A1 NOT INCLUDED: "Using credit or income requirements to
rank or exclude tenants; staff see those as notes only." The open
matching-facts extraction (6.4: "anything that might matter") will also
harvest tenant income statements, so the model will have both halves of
an income comparison.

What it implies. As written, D1 instructs the model to do exactly what
the contract excludes. The charter must carve credit and income out of
the D1 rule by name, decide whether those notes reach the model at all
("staff see those as notes only" reads as display-only), and decide
whether income facts are extracted.

## 6. [HIGH] Priority strength defeats the D1 demotion, and the demotion itself is only a prompt instruction

What is wrong. Two mechanisms collide on the tenant anchor. D1 lands a
requirement-failing pair in Weak "at the bottom" (section 4; 16.2 tells
Sam "demotes to the bottom"). D6 `one_band_up` sorts a priority property
"as if one band higher" and `always_first` puts it first (9.2). A
priority property that fails "no pets" for a tenant with a cat sorts as
Possible, or at the TOP of that tenant's list. A1 itself says "every
ranking it QUALIFIES for".

Separately, the landing is not enforced: band is computed in code from
the model's score (7.4, 8), and nothing in code checks that a failing
pair scored under 40 or that the failure is the first reason against.
Structured failures (unit `no_pets` / `no_evictions_on_program` against
tenant `pets` / `evictions`) could be checked in code; the charter
chooses not to and still calls the landing "forced".

What it implies. Decide whether priority may lift a requirement-failing
pair, and either enforce the Weak landing for structured requirements in
code or stop promising Sam "the bottom".

## 7. [HIGH] "Pair history" has no home, and the per-send outcome it reads does not exist in the data model

What is wrong. 6.3 and 6.4 define pair history as "every send (date, the
recorded outcome, and the extracted reaction ...)", and B1 writes the
per-send reaction "to the pair history". No section says where pair
history is stored. The data that exists:

- `listing_sends` holds ONE row per unit-contact pair with ONE `declined`
  record; "A cleared decline's history lives in the activity / audit
  events, never on the row" (repos/listingSendsRepo.ts:9-31, 158-170).
- The outcome is DERIVED per pair at read time, not recorded per send
  (lib/listingSendOutcome.ts:62-85): not_interested > interested (a tour
  exists) > replied (heard from after sentAt) > signed_up > no_reply.

So "the recorded outcome" of each earlier send is not stored anywhere
except, partially, in audit events. B1 ships to production first and
writes reactions before any reader or store is defined, and 12 forbids a
new table without Cameron's ask.

What it implies. The charter must decide the pair-history store (fields
on the `listing_sends` row, the matches row, or audit events) and what a
"per-send outcome" means given the outcome is derived. Without that, B1
cannot write the reaction and B2 cannot fingerprint it.

## 8. [HIGH] The fingerprint rules contradict the existing outcome derivation and extraction writes

What is wrong. 9.1: "a new text from a tenant never makes their matches
out of date". 10.3: a new send alone does not make a match out of date;
"an outcome" on the pair history does. Against the code:

- A tenant's next inbound text moves `last_heard_from_at` past `sentAt`,
  which flips the derived outcome from no_reply to replied
  (listingSendOutcome.ts:79-84). If outcome is fingerprinted, every text
  after a send invalidates that pair.
- A new counted send supersedes an effective decline
  (listingSendOutcome.ts:52-60) and replaces a flyer `signed_up`
  (listingSendOutcome.ts:84). So a new send ALONE changes the outcome.
- Each inbound triggers extraction (aiRunsRepo.ts:23 triggers), which
  appends "[Auto - <date>]" lines to `notes` and writes empty fields
  (services/extraction/apply.ts:1-8) and, after B1, writes matching facts
  live. All of those are on the tenant card under 6.1's "everything except
  the exclusions", so the card fingerprint changes on most texts.

What it implies. The stated guarantee is false under the proposed
mechanism. The charter must say which outcome values are fingerprinted
(replied? signed_up? superseded declines?) and whether AI-appended notes
and facts are fingerprinted, or drop the "never out of date on a text"
promise.

## 9. [HIGH] A 25-35 second ranking cannot run as a plain request behind CloudFront's 30 second origin timeout; where it runs is undecided

What is wrong. 19 estimates a stage-one call at 25-35 s for ~57
candidates (and batches of 40 for pools up to 493 with the toggle on).
CloudFront's origin read timeout is 30 s
(infra/modules/cloudfront/main.tf:114). 10.2's "a second press joins it"
and 19's "streams rows as they arrive" both assume an execution venue the
charter never picks: an HTTP request (needs bytes inside 30 s, and an
in-process join only works on one process), or a job on the worker via
`jobs.enqueue()` (AGENTS.md: all job traffic goes through it) with
results pushed over the existing SSE. Raising the CloudFront timeout is
infrastructure, which the charter rules out (19).

What it implies. This is a decision, not file detail: it changes the
"in flight per anchor" mechanism, the streaming UI, error handling and
whether a ranking survives a closed tab. Decide it in the charter.

## 10. [HIGH] Worked examples built from Sam's real reviews put production tenant data into a repo file and test environments

What is wrong. 7.2 and 12: Sam's reviewed matches become worked examples
in "a separate versioned file" beside the rubric, "a versioned prompt
file in the app workspace" - i.e. committed to git and loaded in every
environment. The cards carry names and whole addresses (6.1, 7.2). A1
section 6 restates Agreement 7.3: real tenant data is prohibited in
development and test environments; only ANONYMIZED test conversations
are permitted in the repository, and "Nothing in this Amendment permits
Client data to be used to train any AI model". The charter calls the
reviews a "TRAINING SET" (12). Dev runs with the anthropic driver would
send those real examples on the testing key.

What it implies. The charter must require anonymization (names,
addresses, phone-free is not enough) before a review becomes an example,
and should stop calling it training. As written it directs a contract
breach.

## 11. [MEDIUM] Card-by-exclusion over a flexible document: the drift test cannot see stored-but-untyped attributes, and real fields are unclassified

What is wrong. 6.1 projects "the FULL record" through one exclusion list
and promises "a test that fails when a new record field is neither
included nor listed". `ContactItem` and `UnitItem` are flexible documents
(`[key: string]: unknown`, contactsRepo.ts:378); legacy attributes are
explicitly left on rows to "go unread" (contactsRepo.ts:372-377), and
`jurisdiction`/`accepted_programs` stay on units (unitFields.ts:161-172).
A test over typed keys cannot see those, so they flow to the model
unreviewed. Fields that exist today and are neither named in 6.2 nor
excluded in 6.1: `relationships` (role and name of household members -
familial status), `customFields`, `notes` (AI-appended lines),
`consent_*`, `lifEligible`, `voucher_expiration_date` (a date: is it an
excluded "timestamp"?), `organization`, `park_reason`, unit `lif`,
`lease_terms`, `washer_dryer`, `listing_link`, `video_url`, `final_rent`.
6.2's "which today means" lists are therefore wrong.

What it implies. Decide allowlist vs exclusion for flexible documents
(an exclusion list over unknown keys cannot be made a decision each
time), and classify the fields above, `relationships` first.

## 12. [MEDIUM] Putting staff notes on the card reverses a documented invariant without saying so

What is wrong. 6.2 puts "staff notes" on the tenant card. The field's
contract: "NOTHING machine-writes or machine-reads THIS field ... not
extraction" (contactsRepo.ts:162-168); staff-notes spec section 3.4 "The
AI neither reads nor writes it", with issue
`extraction-prompt-read-staff-notes` filed for later. Staff have written
those notes on the premise that no AI reads them.

What it implies. Name the reversal, update the invariant comment and the
issue in B2, and tell Sam (her notes go to the model).

## 13. [MEDIUM] The fair-housing guarantee is a prompt line, and the extraction widening harvests protected-class facts with no gate

What is wrong. 7.2: protected characteristics "never lower a score".
Mechanism: one rubric sentence. Meanwhile 6.4 instructs extraction to
pull "anything that might matter to matching this person with a home",
written LIVE with no approval, which will capture children, pregnancy,
disability, religion and national-origin cues; names stay on the cards
(a known proxy for race, sex and national origin); `relationships`
(finding 11) may ride along. WP1 plans no fair-housing test of the ranker
(A1's fair-housing test set is WP2's, for the conversation engine).

What it implies. Decide at least: which fact labels extraction must not
write, and how the "never lowers a score" claim is checked (a paired
name-swap or attribute-swap check in the fake/live test plan). Otherwise
the guarantee is unverifiable.

## 14. [MEDIUM] Review storage is decided twice, and "writes every pair fresh" destroys it

What is wrong. 10.1 lists `review` as a field on the pair row; 12 says
"Where the snapshots are stored is B2's call". 10.3 says Update "writes
every pair fresh" - a Put would erase the review and re-add `expires_at`,
breaking both "survives a re-score" and "a reviewed match never expires"
(TTL is table-wide on `expires_at`, lib/tables.ts:238-252). Two anchors
can also re-score the same pair concurrently (the join is per anchor
only). And one snapshot per pair loses Sam's earlier verdict when she
reviews again after a re-score, which shrinks the training set the
charter depends on.

What it implies. Decide: review on the row or elsewhere, merge-write not
Put, one snapshot or an append-only list.

## 15. [MEDIUM] "Every score in a ranking is computed together" and "70 means the same everywhere" do not survive cross-anchor writes or rubric changes

What is wrong. One row per pair is shared by both directions (10.1). A
tenant-anchor Update rewrites pairs that a property ranking computed
earlier, from a different listwise prompt, and those pairs are not flagged
on the property page (fingerprints match, computedAt is fresh). 10.3 also
does not flag a match out of date when `rubricVersion`, the examples file
or the model changes, so a page can mix scores from two rubrics with no
warning, while 7.2 says batching and reuse "all rely on a 70 meaning the
same thing everywhere".

What it implies. Add rubric/examples/model version to the out-of-date
rule, and either accept and say that a ranking may hold pairs from other
anchors' calls, or drop the "computed together" claim.

## 16. [MEDIUM] The cost and budget statements misread A1 section 8

What is wrong. A1 section 8's $750 covers TESTING before a capability
goes live, on the testing key; "It does not cover the ongoing cost of the
AI system once a capability is running". Charter 10.3 says the per-press
cost "stays inside the A1 budget", 11 says the production Rankings page
is where Cameron and Sam "watch the A1 section 8 matching budget", and 14
compares ~$30/month of production use to "A1 matching budget lines total
60-100 dollars". The section 8 table's extracted text is column-shifted;
reading the estimates in item order (they sum to the stated $345-620),
"Matching ranking checks" is $20-40, and $40-60 belongs to "Simulated
conversations" (my reading of a garbled table - verify against the PDF).

What it implies. Separate testing spend (testing key, counts against
$750 and the notify-before-exceeding duty) from production operating
cost (outside A1), fix the figure, and say which key production rankings
use.

## 17. [MEDIUM] Composer surfaces the charter changes but never enumerates

What is wrong. 13.1 rewires the composer around two anchors and B4
removes the filter audience. Surfaces not mentioned:

- The partner entry "Send a property to this partner"
  (dashboard/src/routes/contact/PartnerFile.tsx:178) shares the same
  `?contactId=` route as the tenant entry
  (ContactDetail.tsx:1286, 1361; BroadcastComposer.tsx:13-15). A tenant
  anchor for `?contactId=` must not swallow partners.
- Draft resume `?draftId=` (BroadcastsList.tsx:39): stored drafts carry
  an `audience_filter` that is required on create
  (repos/broadcastsRepo.ts:226-227, 400-404).
- The Matching nav entry today lands on the send history list
  (App.tsx:185, BroadcastsList.tsx:129) with drafts, Results and
  FollowUpView; 13.1 replaces that landing with "which record to start
  from" and says nothing of the list.
- Hand-picking a tenant outside the pool ("Add a tenant") and the
  existing default-check rule (consent, sent, declined, tour hold;
  blastAudienceRules.ts:169-183) are not kept or retired.

What it implies. Each needs a keep/retire decision at charter level,
since 13.1 is no-reopen.

## 18. [MEDIUM] Section 7.2 tells the rubric to demote declined sends; section 4 says it never does

What is wrong. 7.2: the rubric states "the demotion rule for requirement
failures and declined sends". Section 4: a Not interested pair is "never
forced into Weak ... inputs the model weighs, not rules the rubric
dictates".

What it implies. One of the two is wrong; a builder writing the rubric
cannot satisfy both.

## 19. [MEDIUM] "A removed fact is not written again" cannot hold for an open-vocabulary fact list

What is wrong. 6.4: facts are `{label, value, confidence, source}` with
model-chosen labels; Sam removes a wrong one and it "is not written
again". The existing dismissal tombstone keys on a fixed field target
(`hasDismissal`, services/extraction/apply.ts:38). With free labels, the
next run's "Animals: one cat" does not match the removed "Pets: has a
cat", so the fact returns.

What it implies. Decide the identity of a fact (normalized label set,
source-message scope, or semantic de-dup by the model) or soften the
promise.

## 20. [MEDIUM] The per-send reaction ignores the existing engine-decline seam

What is wrong. The decline record already has `by: 'staff' | 'engine'`
(lib/listingSendOutcome.ts:31-35) and the dashboard already renders "Not
interested (auto)" for an engine decline
(dashboard/src/routes/contact/Card.tsx:284). 6.4 invents a separate
"extracted reaction" on an unnamed pair history and never says whether a
hard-no reaction writes an engine decline (driving the existing outcome,
chips, follow-ups and supersession) or stays model-only.

What it implies. Decide the relationship, or two "declined" signals will
disagree on the same row.

## 21. [MEDIUM] The 90-day window hides every tenant never heard from, including brand-new ones

What is wrong. 5 and 9.1 admit a tenant only when heard from within the
window; `last_heard_from_at` is absent for "never heard from (or not yet
backfilled)" and moves only on inbound traffic (contactsRepo.ts:233-237).
A tenant staff added after a phone or in-person intake, an imported
tenant, or a web-form sign-up who has not yet texted is out of every
property's default pool on day one. 385 of 670 searching tenants are
"not heard from in 90 days or ever" (section 2, UNVERIFIED), so the
"ever" share is material.

What it implies. Decide whether `created_at` (or consent_at) inside the
window counts, or accept and tell Sam that new tenants need the toggle.

## 22. [LOW] Outcome chip vocabulary does not match the shipped outcomes

13.2 lists "Already sent, No reply, Interested, Not interested, Tour
pending". The shipped set is no_reply, replied, interested,
not_interested, signed_up (listingSendOutcome.ts:22), and "interested" IS
the tour signal (listingSendOutcome.ts:78-79; listingSendTour.ts), so
"Interested" and "Tour pending" are the same fact twice while "Replied"
and "Signed up" are missing. 13.5's "No reply yet / Interested / Not
interested" controls: Interested is a tour-create action, not a stored
outcome (interestedModeFor, listingSendOutcome.ts:124-127).

## 23. [LOW] The landlord card switch feeds copy-only defaults the property may have diverged from

Landlord `req_*` fields are copy-only defaults; "a property keeps its own
copy (UnitItem) and changes only through Apply to properties"
(contactsRepo.ts:341-350). With `RANKING_LANDLORD_CARD` on, the model
sees both the landlord default and the property's own, possibly
deliberately different, value. Say which wins.

## 24. [LOW] "Trimmed and case-insensitive" is not the blast rule

Section 5 calls the authority compare "same ... rules"; the blast compares
trimmed values by exact `Set.has` (audienceResolution.ts:143-146,
205-210). Harmless if intended; say it is a change.

## 25. [LOW] Slice ownership out of order

B1 owns "card fingerprint helpers" but the cards are defined in B2
(15.1), so B1 fingerprints a card that does not exist yet. Section 3
defers GLOSSARY entries to B2, while AGENTS.md requires the GLOSSARY
update in the same change that adds a domain noun (B1 adds area
preference, maximum tenant portion, matching facts).

## 26. [LOW] A money-spending Rank endpoint with no rate limit or spend ceiling

The repo rate-limits every authenticated cost route per user
(lib/config.ts:1021-1040). 10.2 bounds concurrent presses per anchor only;
nothing bounds presses per user or spend per day.

## 27. [LOW] Small internal inconsistencies

- Section 4 cites tie order as 9.2; it is defined in 9.1.
- Tenant-anchor sort has no tie-breaker after score (9.2); equal scores
  order nondeterministically.
- Section 5 "~500 to ~60" mixes the worst case (493) with the windowed
  median (57).
- 7.4 "Nothing else is trusted from the model" versus 7.2's fair-housing
  report added to the output contract.
- 6.1 keeps "last heard from" as a timestamp; 9.1 passes only a bucket.
- 6.2 "the requirement-relevant history" is undefined.
