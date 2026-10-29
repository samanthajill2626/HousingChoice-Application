# WP1 B2a ranking engine - design review round 1, reviewer B

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md (rev 1, dc8025cc)
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md (through section 20 item 13)
Method: adversarial read of the spec against the charter and the tree at the
branch head. Every code claim below cites a line I read. UNVERIFIED marks a
claim I could not check from the repository.

Summary: 2 HIGH, 8 MEDIUM, 7 LOW. No BLOCKING. Most of section 2's code
readings hold (pollLoop.ts:69-77, config.ts:640, contacts.ts:1950-2049,
apply.ts:318/339/931-966, prompt.ts:231-233, tables.ts:238-252 and 625-656,
lean.ts:445-457, aiRuns.ts:30-31/137/228-230, CloudFront /api/* at
infra/modules/cloudfront/main.tf:158). The findings are about mechanisms that
do not deliver the guarantees the spec states.

---

## F1 [HIGH] The properties-seen bound and its newest-first order make a bare send change the tenant fingerprint

What is wrong. Charter 10.3 and 13.5 (binding, 15.4 section 10) say a new send
ALONE never makes a match out of date. D13 tries to deliver that by dropping
`sends` / `daysSinceLastSend` from the tenant-card fingerprint and dropping
entries with no decline, tour or feedback line. But D2.3 builds
`propertiesSeen` NEWEST FIRST and BOUNDED to `RANKING_SEEN_MAX` (8), and D2.3's
attach step moves Notes lines only under LISTED entries. Three bare-send paths
change the fingerprint anyway:

1. Re-order. A tenant has seen A (declined) and B (toured); a re-send of A
   (bare) moves A ahead of B. The fingerprint keeps both entries in card order,
   so the hash changes.
2. Eviction. With 8 entries, a bare send to a 9th property pushes the oldest
   entry (which may carry a decline, a tour or feedback) off the card. Its
   entry vanishes from the fingerprint and its feedback lines fall back into
   `notes`, which also changes.
3. Re-attachment. A first send of P, when Notes already holds a line naming
   P's label (a flyer conversation, a tenant asking about P before it was
   sent), moves that line out of `notes` and under P's new entry. P's entry now
   has feedback and enters the fingerprint; `notes` changed too.

Evidence: spec D2.3 (bound, newest first, attach only to "a seen entry"),
D13 (drop rules, no mention of order or the bound), charter 10.3 lines
784-797, charter 13.5 lines 968-971. Sends are frequent: B3's one-step send and
every blast write `listing_sends` rows (listingSendsRepo.ts:486-498 is the
reader the spec uses).

What it implies. The stated guarantee is false by construction, and the
failure grows with send volume: once B3/B4 ship, every send re-sorts or evicts
and the tenant's whole list reads out of date. Fix in the spec: fingerprint
over the outcome-bearing entries in a CANONICAL order (for example by unitId),
computed over ALL seen properties before the bound is applied; decide whether
the attach step matches against all seen labels or only the listed ones, and
state that the fingerprint uses the unbounded set. Add the three cases to the
section 6 "a bare send changes nothing" test.

## F2 [HIGH] The unlawful-flag field enum admits checkboxes, so one model claim permanently disables a cap the charter says must hold

What is wrong. Charter 7.2 (lines 508-517): an UNLAWFUL flag may name any
free-text field, "never a checkbox: No pets and No evictions on the program are
lawful on their face". D5 makes the flag field enum "every free-text field on
the property card plus the requirement keys" with no per-kind restriction, and
parsing drops only unknown enum values. The 15 requirement keys include the
checkboxes `no_evictions_on_program`, `no_pets`, `deposit_one_month`,
`deposit_flexible`, the money fields `deposit`, `application_fee`, the enum
`tour_type`, and the excluded `credit_requirements` / `income_requirements`
(requirements.ts:70-117).

The mechanism then amplifies a single error. D10 writes a property-level flag
record with NO TTL; it closes only when the field's "text" stops hashing to
`textHash`. A checkbox's value does not change while it stays checked, so an
unlawful flag on `no_pets` or `no_evictions_on_program` never closes. D9's cap
test skips any key with an open unlawful flag on that property. One model
answer in one batch therefore removes the eviction or pets cap from EVERY pair
of that property, indefinitely, with no display or dismiss until B4. For
`credit_requirements` / `income_requirements` the record hashes text the model
was never shown (D2.1 excludes both from the card).

What it implies. The cap can be silently and durably defeated, which is the
section 4 / 7.4 guarantee charter 15.4 lists as non-reopenable. Fix: the
parser drops an `unlawful` flag whose field is a checkbox, money, enum or
credit/income key (accommodation flags may keep requirement keys); or split
the schema into two field enums. Add a parse test and a flags test for it, and
say how `textHash` is computed only for string fields.

## F3 [MEDIUM] failedRequirements may carry credit and income keys the charter says are never reported failed

What is wrong. D5: "Requirement key enum: the 15 REQUIREMENT_UNIT_KEYS". That
set includes `credit_requirements` and `income_requirements`
(requirements.ts:76-81, 115-117). Charter 7.2 (lines 495-497): a credit or
income requirement "is disregarded and never reported failed". D2.1 excludes
both from the card, yet the output grammar invites the model to report them,
and D8 stores `failedRequirements[]` verbatim on the match. The cap ignores
them (not cap-eligible), but the stored row will say the tenant failed a
credit requirement, and B3/B4 render what the row holds.

What it implies. A stored record that contradicts A1 and the rubric, and a
grammar that suggests to the model a judgment it is told never to make. Fix:
enum = the 13 keys minus credit and income (and arguably only the keys present
on the property card), with a schema test pinning their absence.

## F4 [MEDIUM] The cap is undefined for landlord defaults and for "recorded" checkboxes

What is wrong. D9: capped when the key "is recorded on that property's current
card". Two cases are not decided:

- Landlord switch on (D2.1, charter 6.2). Landlord requirement values sit on
  the card under `landlordDefaults`; the flag field enum gets `landlord:<key>`
  twins (D5), but `failedRequirements` has no landlord form. If the model
  fails a tenant on the landlord's No pets, it reports `no_pets`; the property
  itself records no `no_pets`, so the cap is "ignored" (charter 7.4 "a key
  failing any test is ignored"). An accommodation flag `landlord:no_pets`
  never matches the cap key `no_pets` either. Either the landlord's screening
  requirements never cap (a decision the charter does not make), or they do
  through a rule the spec does not state.
- "Recorded" for a checkbox stored `false`, and for the legacy boolean `pets`
  (requirements.ts:91-93 comment). D3's completeness `pets` test ("none of
  no_pets, pets, pet_fee") has the same ambiguity.

What it implies. The builder picks. Fix: define "recorded" (checkbox true;
text non-empty after trim; legacy `pets: true` counts or not) and state whether
a landlord default can cap, with the accommodation-field matching rule.

## F5 [MEDIUM] Run detail shows pairs another run wrote, attributed to this run

What is wrong. D11/D12: the run detail reads "its pairs read by key from
`matchKeys`". `matches` holds one row per pair, overwritten by every later
ranking from either side (charter 7.2 lines 486-488, D8). Opening last week's
run shows today's scores, reasons and run id under last week's run. The
spec's Rankings page is where Sam reviews how the AI read a record (charter
11), and B2b builds review on the pair view.

What it implies. A review surface that silently misreports what a run
produced. Fix: the detail renders the run's own parsed `rawText` (stored on
the run, D11) mapped back through its handle map, and shows the current row
only when its `runId` equals this run, otherwise "re-scored since by run X".
That needs the handle-to-record map stored on the run, which D11 does not
list.

## F6 [MEDIUM] The counterfactual merge gate cannot be read as specified

What is wrong, three ways:

1. The cap result depends on persisted state. D9 suppresses a cap while an
   OPEN unlawful flag record exists (D10), including in runs where the model
   missed it. D17's control "qualifications say 'no kids' ... flagged unlawful
   in at least two of three runs and never cap" and the swap rule "the cap
   result is the same in every run" do not say whether the script persists
   flags between runs (production behavior) or caps from each run alone. In
   the second reading the third run caps whenever the model fails to flag and
   reports `qualifications` failed; in the first, the order of runs decides.
2. "The band of the mean is unchanged" flaps on noise at a band boundary: a
   base mean of 79.4 and a variant of 80.1 is a 0.7-point move that fails the
   gate. The spec does not require base pairs to sit mid-band.
3. A disability proxy the card carries is never swapped. The tenant card
   includes `housingAuthority` (D2.1) and the property card its authorities.
   The org list ships "Georgia Housing Voucher Program (DBHDD)", a supportive
   housing voucher run by the Department of Behavioral Health and
   Developmental Disabilities (orgStartingList.ts:26-30). The pool already
   enforces the authority match, so the name adds little fit signal, but it
   tells the model the tenant likely has a disability. D17 swaps a
   "disability with no accessibility bearing" in text, not this.

What it implies. The merge gate can fail for reasons unrelated to fairness, or
pass while not testing what production does. Fix: state the script's flag
model (recommend: cap computed per run from that run's own flags plus a
separate "flag raised" tally); require base pairs whose base mean is at least
the tolerance away from a band edge, or compare bands per run; add an
authority swap (GHVP vs another authority) against a property that accepts
both. The last is a test of the existing guarantee, not new scope.

## F7 [MEDIUM] Hosted dev is "production" to config, and the spec never says what ranking does there

What is wrong. Both AWS stacks run NODE_ENV=production (config.ts:648-649
comment, and the messaging default beside it). D6 keys every default on
"production": `RANKING_DRIVER` defaults to `anthropic`, `fake` is refused, and
`ANTHROPIC_API_KEY` becomes required "whatever AI_EXTRACTION_ENABLED says" -
a new unconditional boot requirement (today the key is required only when
extraction is enabled, config.ts:887-892). Section 7 says only "Production
already holds ANTHROPIC_API_KEY". Whether hosted dev holds a key, and WHICH
key (the testing key would bill A1 section 8; the production key would put
dev presses on operating cost), is not in the repository (secrets come from
.env.dev via secrets:push) - UNVERIFIED.

What it implies. Deploying B2a to dev can stop the dev boot, or start spending
on an unnamed ledger the moment anyone presses Rank there. Fix: say what dev
runs (anthropic on which key, or `console` set explicitly in dev params), and
put the key check in the deploy checklist.

## F8 [MEDIUM] The console driver logs PII and writes fake scores as real matches, and is legal in production

What is wrong. D6: the console driver "logs ... the first candidates' cards at
debug level, then scores with the fake rules". Cards carry names, whole
addresses, the Notes box and Staff notes. The house rule is never to log
names, phones or bodies (placementsRepo.ts:28; the extraction console driver
logs only lengths and contact type, extraction.ts:270-279). Unlike `fake`,
`console` is not refused under NODE_ENV=production, so it is settable on a
hosted stack, where it would write fake-rule scores into the real matches
store. The spec never says what `model` a console or fake run stamps on a
match; if it is `AI_RANKING_MODEL`, the version rule (D9) treats fake scores
as current.

What it implies. A log-hygiene regression and a path to plausible-looking
fake rankings in a shared store. Fix: the console driver logs counts and
sizes only; console and fake stamp `model: 'console'` / `'fake'` so D9's
version rule marks them out of date anywhere a real model is configured; and
either refuse `console` in production or state why it is allowed.

## F9 [MEDIUM] The e2e plan races the worker and has no data to rank

What is wrong.

- The hermetic stack runs the real worker with the default 30 s poll
  (scripts/e2e-session.mjs:464, 289). A ranking job is due the moment it is
  queued, so the worker's own `startPoll('ranking')` (D7, "always started")
  can run it before the spec's `POST /__dev/ranking/tick`. Section 6's "a
  not-ranked-yet row before the tick" is a race. The extraction tick avoids
  this with a due time and a domain clock (worker.ts:483 comment); ranking has
  neither.
- e2e-session.mjs sets EXTRACTION_DRIVER=fake explicitly (line 258) because
  the non-production default is console. Ranking defaults to console too
  (D6), so the same edit is needed for "fake ... used by every e2e spec" and
  the `[fake:...]` seams; section 5 does not list e2e-session.mjs.
- The lean world has no `available` unit (unitA `under_application`, unitB
  `occupied`, lean.ts:222, 244) and one searching tenant (lean.ts:191). The
  specs listed (a ranked table, a capped pair, a failed batch, a tenant
  anchor ranking properties) need fixtures; the spec does not say whether
  they are API-built per spec or a lean-seed change (which moves the
  byte-stable world).

What it implies. Flaky or impossible e2e as written. Fix: a dev seam or config
that keeps the worker's ranking poll from claiming in e2e (or make the spec
assert only after the tick and drop the pre-tick assertion), add
`RANKING_DRIVER: 'fake'` to e2e-session.mjs in section 5, and state where the
e2e ranking fixtures come from.

## F10 [MEDIUM] Every read recomputes the pool and every candidate card, and the Rankings page repeats it every 5 seconds

What is wrong. D9: the GET computes the current pool and all candidate cards
(the out-of-date test needs them). A tenant card needs `listByContact`, the
tenant's tours, and up to 8 seen units (D2.3), so about 10 reads per tenant
before the match BatchGet and the per-property flag queries. A property pool
with the window off was 158 at worst (charter 2), roughly 1,600 reads per
GET. D12/D18 then re-run this GET on every `ranking.updated` event AND every 5
seconds while a job is queued or running, i.e. for the whole 25-35 s per batch
the charter estimates (charter 19), so several full recomputes per press,
possibly overlapping. The CloudFront origin read timeout is 30 s
(infra/modules/cloudfront/main.tf:114).

What it implies. Read cost and latency scale with polling, not with change.
Fix: poll a cheap job-status read (the job record only) and re-run the full
GET once per finished batch and at done; state a budget the plan's
150-tenant measurement must meet.

## F11 [LOW] Section 2 misdescribes the server org-name mapping; the port adds a third rule

What is wrong. Section 2 says the server has no equivalent of
`prefillAuthorities` and that `resolveOrgText` "takes the FIRST match".
`resolveOrgText` returns `ambiguous` when more than one entry carries the
spelling (orgNames.ts:105-107); only the by-name branch takes the first,
and names are unique by construction. `checkScalarWrite` (orgNames.ts:275-289)
is the server mapping of a filter member, and the dashboard prefill's own
header says it maps "the way the server maps a filter member (app/src/lib/
orgNames.ts checkScalarWrite)" (authorityPrefill.ts:1-6). Separately, the
spec compares the tenant's authority with `normalizeOrgText` on both sides;
today's send-time filter compares trimmed values exactly
(audienceResolution.ts:144-147, 206-209).

What it implies. A new `mapAuthoritiesToList` ported from the client is a
third implementation to keep in step. Use `checkScalarWrite(entries,
'audience_filter', name, undefined)` per name, and say the normalized tenant
compare is a deliberate widening.

## F12 [LOW] The replacement lean-seed match is in no pool and cannot be current

What is wrong. D8 replaces lean.ts:445-457 with a schema-2 row "so the
hermetic world opens with one stored match", fingerprinted from the seeded
cards. That pair is the lean tenant (status `placing`, lean.ts:101) and unitA
(`under_application`, lean.ts:222): neither direction's pool contains it
(D1), so no read shows it. Its fingerprints depend on the clock (the
`lastHeardFrom` bucket), so they are either not byte-stable or wrong by read
time, and a fixed `computedAt` is out of date by age within 7 days anyway.

What it implies. Work with no reader, and a seed that imports ranking code.
Drop the legacy row (charter 2 only requires that B2 replaces it; a removal
plus "readers ignore rows without schema 2" satisfies that), or say what reads
it.

## F13 [LOW] An expired queued job never ends; a join can return a finished job

What is wrong. D7 lets a new press reclaim a queued record past
`queuedExpiresAt`, but nothing turns an unclaimed queued record terminal and
D9 reports `status` as stored. If no worker takes it, the Rankings page shows
"queued" and polls every 5 s forever. Also, a press that loses the claim then
"reads the record" to join; if the job finished in between, the read shows
`done` and the press "joins" a finished job instead of claiming again. And
the 409 on a different `includeOlder` applies to tenant anchors, where the
window does not exist.

What it implies. Minor dead ends. Fix: D9 derives `expired` from
`queuedExpiresAt`; a losing press that reads `done`/`failed` retries the
claim once; ignore `includeOlder` for tenant anchors.

## F14 [LOW] The Notes guard's conflict code is stated two ways, and one named writer does not exist

What is wrong. D14.3: "a refusal caused by the Notes stamp answers 409
`notes_stale` ... otherwise `contact_changed`". Section 6: "mixed guards
answer `contact_changed`". The Staff notes precedent answers the note code
whenever its stamp moved, even with other guards present (contacts.ts:2036-
2041). The edit form's PATCH can carry other guards. Separately, D14.3 lists
"the seeds" as a Notes writer that must stamp; no seed writes a contact
`notes` attribute (no match in app/src/lib/seed/*.ts).

What it implies. The builder picks one of two conflict rules. State the
precedent's rule (stamp moved => `notes_stale`) and drop "the seeds".

## F15 [LOW] Classification text that does not match the stored world

- `agency` is listed as landlord-only or partner. The importer writes it on
  tenants from the voucher program (import/apply.ts:1003-1012), and the org
  list's agencies include behavioral-health providers
  (orgStartingList.ts:77-80). Excluding it is right; the stated reason is
  wrong, so a later reader may "fix" it.
- The seed worlds carry `preferences_notes` on tenants (lean.ts:122,
  cast.ts:453 "uses a walker", matrix.ts:832), read and written nowhere else
  in app/src. D2.4's seed-world source will demand a classification the spec
  does not give.
- D2.3: a seen unit that cannot be read "is still listed by its last label";
  the send row stores no label (listingSendsRepo.ts:86-125), and the same
  paragraph then sets a constant label. A soft-deleted unit is still readable.
- D7/D10 add `entityKey`/`sortKey` to `rjob#` and `uflag#` rows; the ai_runs
  table comment states only `ptr#` rows carry them (tables.ts:627-629). Update
  the comment with the change.

## F16 [LOW] The compile check does not exercise the ranking request, and the default prices are unverified

What is wrong. D5/D17 add a `ranking` variant to
extraction-schema-compile-check.ts, which sends through the extraction
structured-output client with thinking pinned off (extraction-schema-compile-
check.ts:4-6; extraction.ts:254-256, 490-492). Ranking calls run adaptive
thinking with an effort (D6). The flag enum also differs with
`RANKING_LANDLORD_CARD` on (`landlord:<key>` values), and the check must
compile the larger variant. The `AI_PRICE_TABLE` defaults are presented as
facts; the only table in the repo marks Sonnet 5.5 at 2/10 "unverified -
Cameron confirms" and has no `claude-opus-5-5` row
(extractionProbeNeverWritten.ts:439-447). The opus 4/20 figure is UNVERIFIED.

What it implies. Say the check compiles both enum variants, that the first
real ranking request shape is proven by D17.2, and carry the "unverified"
marking onto the price defaults.

## F17 [LOW] D14.1 changes the extraction transcript and the guard's matching of old lines

What is wrong. D14.1 extracts the collapse into one helper "both use" and
widens it to U+2028/U+2029. `toSingleLine` renders every transcript line of
the extraction prompt (prompt.ts:225-233), so transcripts containing those
characters change, contrary to section 5's "B2a does not change the
extraction prompt". Separately, a multi-line model line appended before B2a
is stored as two physical lines; after B2a the same candidate collapses to
"a / b", which the whole-line guard (apply.ts:318-330) no longer matches, so
a retried window appends it once more.

What it implies. Both are small; say so in the spec (the U+2028 widening is a
hardening of the injection fence, worth keeping) rather than claim no change.
