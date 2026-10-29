# WP1 B2a Ranking engine - design review round 1, reviewer A

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md (rev 1, dc8025cc)
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md (through section 20 item 13)
Tree read: W:\tmp\wp1-b2-ranking-engine at dc8025cc. Read-only; no tests, servers or model calls run.

Severity is consequence if shipped unfixed. Every code claim cites a line read in this tree;
anything not verified is marked UNVERIFIED.

---

## F1. [HIGH] A bare new send changes the tenant-card fingerprint (properties-seen order and bound)

What is wrong. Charter 10.3 (and 6.2) guarantees "A bare new send does not [make a match out of
date] (B2 leaves sends with no outcome out of the tenant card's fingerprint)". The spec's
mechanism does not deliver it:

- D2.3: `propertiesSeen` is "newest first, bounded to RANKING_SEEN_MAX (default 8) entries", and a
  Notes line that names a seen entry is moved OUT of `notes` and under that entry.
- D13: the fingerprint is "the tenant card as sent EXCEPT" the `sends` lists and
  `daysSinceLastSend`, and entries with no decline, tour or feedback line are dropped.

The ordering and the bound are applied to the card AS SENT, before the fingerprint projection.
So:

1. Re-send (bare) of a property the tenant already declined or toured: its newest-send date moves,
   the entry moves to the top, the entry ORDER of the projected card changes, the serialization
   changes, every match of that tenant reads `outOfDate: card`. No bound needed for this one.
2. Bare send of a NEW property to a tenant with 8 seen entries: the new entry takes slot 1 and the
   9th (oldest) entry falls off. If that entry had a decline, tour or feedback line, the
   projected card loses it; and its feedback lines, which no longer match any seen entry, fall
   back into `notes` (D2.3 "every other line stays in notes"). Fingerprint changes.

Evidence: spec D2.3 (lines 256-288), D13 (lines 708-714); charter 10.3 (charter lines 784-797).

Implies: the one fingerprint rule the charter calls out by name fails in the common case (any
re-send, any tenant with a long send history). Sam sees "out of date" after every send from the
composer (B3/B4 one-step send, charter 13.5 "the send alone does not make the match out of date").
The fingerprint must be computed over a canonical, send-independent projection: entries sorted by
a stable key (unit id or label, not send date), and the bound/attach decision taken on the
outcome-bearing set, not on a newest-send window that a bare send can shift. The spec must also say
what happens to the card itself at the bound (which entries a bare send may evict), because the
model input and the fingerprint must still agree.

---

## F2. [HIGH] Unlawful flags on checkbox (and non-text) fields are accepted and become durable property records that suppress a lawful cap

What is wrong. Charter 7.2: an UNLAWFUL flag "may name any FREE-TEXT requirement or field on the
property card ... never a checkbox: No pets and No evictions on the program are lawful on their
face". The spec:

- D5 flag field enum = "every free-text field on the property card PLUS the requirement keys". The
  15 `REQUIREMENT_UNIT_KEYS` (app/src/lib/requirements.ts:70-117) include checkboxes `no_pets`,
  `no_evictions_on_program`, `deposit_one_month`, `deposit_flexible`, money keys `deposit` and
  `application_fee`, the `tour_type` enum, and `credit_requirements` / `income_requirements`, which
  are not on the card at all (D2.1 excludes them).
- The schema has one `field` enum for both kinds, so it cannot express "unlawful only on text".
- D5 parsing drops only unknown enum values; D10 writes a `uflag#<unitId>#<field>` record from any
  unlawful flag; D9 suppresses the cap on that field while the flag is open; D10 closes a flag only
  when the field's text hash changes; flags have no TTL; charter 7.2 makes Dismiss display-only
  with the cap still suppressed.
- D4's rubric list does not tell the model "never a checkbox" either.

Consequence: one model error naming `unlawful` on `no_pets` (for example on an assistance-animal
pair where the model confuses the two kinds) writes a property-level record that disables the
No pets cap for EVERY tenant of that property. `no_pets` is stored as `true`
(app/src/repos/unitsRepo.ts no_pets?: true), so its "text" never changes; staff cannot "edit the
text to read lawfully" (charter 7.2's only remedy) short of unchecking a lawful requirement. The
flag also surfaces (B4) as "remove this requirement from the record" for a lawful checkbox.

Implies: code must drop an unlawful flag whose field is not a free-text field on the card (and
must drop any flag naming a field not on the card), before D10 writes anything; the rubric must
state the never-a-checkbox rule; a test must pin both. The hash rule also needs a definition for
non-string values if any non-text field remains in the enum.

---

## F3. [HIGH] The counterfactual merge gate tests only one ranking direction

What is wrong. D17.2 describes swaps of TENANT attributes (name, address, household facts, a credit
or income line in the Notes box, religion, disability, SOGI) and says "the swapped candidate never
sits beside its twin". The swapped record is a CANDIDATE, so the check runs the property-anchor
direction (tenants as candidates). Nothing in D17 runs the tenant-anchor direction, where the
tenant carrying the protected characteristic is the ANCHOR and every property in the batch is
scored against that one card.

Charter 7.2 states the guarantee for the ranking, not for one direction, and the check is the
merge gate because "ranking turns on in production when Cameron deploys" (charter 7.2 AMENDED
2026-10-28; section 20 item 12). On deploy, the Rankings page ranks BOTH anchor kinds (spec D18
"pick a property or a tenant"), and B3 - the tenant-anchor composer - ships first (charter 15.2).
A listwise call where the protected fact sits in the shared anchor card can shift every score in
the batch together; the property-anchor test cannot see that.

Evidence: spec D17.2 (lines 780-801), D18 (lines 825-831); charter 7.2 (lines 533-546), 15.2
(lines 1036-1043).

Implies: the gate must also score each base and variant tenant as the ANCHOR of a property batch
(a few synthetic properties), with the same tolerance; the offline stub tests (D17 last paragraph)
must cover both directions.

---

## F4. [MEDIUM] The counterfactual tolerance can fail on noise, and the spec gives no rule that separates noise from bias

What is wrong. Q5 / D17.2 tolerance: mean moves at most 5 points, "the band of the mean is
unchanged", and "the cap result is the same in every run". Three runs per arm.

- A base pair whose mean sits near a band boundary (79 vs 80, 59 vs 60, 39 vs 40) changes band on a
  1-point wobble that is within the 5-point allowance. The spec does not require base pairs to sit
  away from boundaries.
- "Cap result is the same in every run" is a per-run equality over a model-reported
  `failedRequirements` list. One base run that reports a cap-eligible failure and one variant run
  that does not fails the gate even when the swap has no effect.
- The base-versus-base spread is only "reported", never used in the verdict.

Implies: a merge gate that can go red on sampling noise, which (per charter 7.2) blocks every
production run until "Cameron decides". Either design the base pairs mid-band and with an
unambiguous cap state, or define the verdict against the measured base-vs-base spread, or both;
state it in the spec.

---

## F5. [MEDIUM] The schema invites the model to report credit and income requirements as failed

What is wrong. D5: "Requirement key enum: the 15 REQUIREMENT_UNIT_KEYS". That list includes
`credit_requirements` and `income_requirements` (app/src/lib/requirements.ts:76-81, 115-117).
Charter 7.2: a requirement about credit or income "is disregarded and never reported failed (A1)".
D2.1 removes both fields from the card, but the schema still offers them as legal
`failedRequirements` values, the parser keeps any in-enum value, D8 stores `failedRequirements[]`
on the match, and D18's run detail displays the pair's output.

Implies: a stored, displayed "failed: credit_requirements" on a match is exactly the A1 breach the
charter rules out, even though the cap ignores it. Narrow the enum to the requirement keys that are
on the card and not credit/income (or drop those two in the parser), and pin it in
rankingSchema.test.ts.

---

## F6. [MEDIUM] The rubric content (D4) omits charter rules the cap and flags depend on

What is wrong. D4 enumerates what RUBRIC_TEXT states. Missing against the charter:

- Charter 7.4: "A credit, income or move-in-cost clause inside a cap-eligible key never counts as
  failed." D4 covers credit/income generally but says nothing about a move-in-cost clause inside
  `qualifications` / `evictions_notes` / `pets`. Code caps on the model's report alone (D9), so a
  `qualifications` text such as "first and last month up front" reported failed caps the pair -
  the cap then enforces a move-in cost, which charter 7.4 says can never cap.
- Charter 4: the rubric "tells the model to land that pair in the Weak band with the failure as the
  first reason against".
- Charter 7.2: unlawful flags "never a checkbox" (see F2).

Evidence: spec D4 (lines 344-365); charter 4 (lines 128-135), 7.2 (lines 508-516), 7.4 (lines
578-590). 7.2 and 7.4 are compliance decisions no slice may reopen (charter 15.4).

Implies: list these in D4 so the builder writes them and a test can pin RUBRIC_TEXT for them; add a
worked example (D4 examples) for the move-in-cost-inside-qualifications case.

---

## F7. [MEDIUM] Legacy boolean `pets` on units is passed raw; the cap and completeness misread a legacy No pets

What is wrong. A unit may still store a legacy bare boolean `pets`
(app/src/repos/unitsRepo.ts `pets?: string | boolean`; comment "Old data may still hold a legacy
bare boolean: read it through lib/requirements.ts unitItemValue"). `unitItemValue`
(app/src/lib/requirements.ts:188-198) maps `pets: false` to `no_pets: true`.

The spec: D2.1 copies stored keys "as stored" (D2.2 "Free text is passed as stored, except that
each value is trimmed"); D9 caps only when the failed key "is recorded on that property's current
card"; D3 marks `pets` missing when "none of no_pets, pets, pet_fee". For a legacy `pets: false`
unit, `no_pets` is absent from the card, so a model-reported `no_pets` failure is NOT capped, and
the card shows the model a bare `false` under "pets" rather than "No pets". The fake driver's "a
recorded No pets" rule has the same gap.

Implies: build the property card's requirement values through `unitItemValue` (the documented
reader), not raw keys, and test a legacy-boolean unit for card, completeness and cap. Production
prevalence UNVERIFIED.

---

## F8. [MEDIUM] "Never spelled out" contradicts the type-level registry, and B1's reader test does not police ranking

What is wrong. D2.1: the tenant card's B1 inputs are "read from that list, never spelled out, so a
source moving to Notes changes one list; B1's reader test keeps policing it". D2.4.1: the
registries are typed `Record<KnownKeys<ContactItem>, ...>`. But `ContactItem extends
TenantMatchingInputValues` (app/src/repos/contactsRepo.ts:122; lib/tenantMatchingInputs.ts
TenantMatchingInputValues), so `KnownKeys<ContactItem>` contains `area_preference`,
`max_tenant_portion`, `accessibility_need`, `preferences_constraints` and the registry must spell
all four as keys or it does not compile.

And B1's reader test (app/test/tenantMatchingInputsReaders.test.ts:13-24) scans a fixed list of
EXTRACTION files only; it polices nothing in services/ranking/.

Implies: the builder must choose between violating "never spelled out" and weakening the type
check, with no guidance. State the type (for example the known keys minus
`TenantMatchingInputKey`, with the four classified by iterating the list) and add the ranking
files to the reader test's READERS, or drop the claim.

---

## F9. [MEDIUM] Seed and legacy tenant attributes the spec never classifies are left to the builder

What is wrong. D2.4.3 asserts every attribute on every seeded tenant and unit is classified, and
charter 6.1 says each such field is "a decision rather than drift". The spec's include/exclude
lists do not name attributes the seeds and older writers carry, some of them plainly matching
facts:

- `preferences_notes` (app/src/lib/seed/lean.ts:122, cast.ts:453, cast.ts:736, matrix.ts:832) - a
  tenant preference text.
- `voucher_program` (lean.ts, cast.ts), `rta_expiration_date` (lean.ts) - voucher facts.
- `caseworker` (lean.ts; "caseworker fields" is not a key list), `ai_mode`, `lead_status`,
  `origin` (contactsRepo listByType filter), `*_source` provenance keys other than the three named.

The classification test will force a choice for each; the spec gives none, so a builder decides
what the model reads about real tenants (include `rta_expiration_date`? `preferences_notes`?).
Whether production contacts carry these is UNVERIFIED.

Implies: enumerate the seed-world and known-legacy attributes in D2.1 with a decision each, or
state the default (exclude, and list it for Cameron) so the builder is not making card decisions.

---

## F10. [MEDIUM] Q4's premise is wrong: the unit's `lif` is a landlord incentive fee, not an income program

What is wrong. Spec D2.1 / Q4: "`lif` (Q4: an income-program attribute, excluded with the tenant's
`lifEligible`)". The code defines it as "Landlord incentive fee (LIF)"
(app/src/repos/unitsRepo.ts:433-434), a dollar amount on the unit (`lif: 'number'`,
app/src/lib/unitFields.ts:87). The tenant's `lifEligible` is a separate boolean
(contactsRepo.ts:351) the charter classes as income; the placement's `lif` is a checklist boolean
(placementsRepo.ts:162-165).

Implies: Cameron is asked to rule at the spec gate on a misdescribed field. Restate Q4 with the
code's definition (an incentive paid to the landlord; arguably neither fit nor A1 income) and let
him decide on that.

---

## F11. [MEDIUM] The console driver fabricates scores and is allowed in production; fake/console matches are indistinguishable by version

What is wrong. D6: the console driver "scores with the fake rules and records driver console (so
local dev without a key still ranks)"; only `fake` is refused in production. Charter 7.4: "A default
or guessed score is never written." A console-driven match is a fabricated score written to the
real matches store and shown to staff; nothing stops `RANKING_DRIVER=console` on a deployed stack
(both run NODE_ENV=production, config.ts comment at the messaging driver default). Contrast the
extraction console driver, which returns nothing (RUNBOOK.md:1466).

The spec also does not say what `model` a fake or console match records. D9's version rule flags a
match whose model differs from the current one; if fake/console rows carry `AI_RANKING_MODEL`, a
switch back to `anthropic` leaves them reading current.

Implies: refuse `console` in production as `fake` is (or make console score nothing), and record a
model value on fake/console rows (`fake`, `console`) so the version rule always flags them.

---

## F12. [MEDIUM] e2e: the real worker's always-on ranking poll races the tick seam; the e2e child env is an unenumerated surface

What is wrong. The hermetic lane spawns a REAL worker alongside the app (scripts/e2e-session.mjs
around 254-258 "passed to BOTH the app and worker"). The ranking poll is "always started; there is
no switch" (D7). Unlike extraction, whose rows are due only after a debounce the dev tick jumps
past (scripts/e2e-session.mjs:289-293 explains why the worker cadence is NOT lowered: "a fast
cadence would let the worker race tick-driven specs for due rows"), a queued ranking job is due
the moment it is written. The worker claims it on its next 30 s tick. Section 6's e2e "a
not-ranked-yet row before the tick" and any count of tick-processed jobs are therefore
nondeterministic.

Also: e2e runs NODE_ENV=development (e2e-session.mjs:252), so `RANKING_DRIVER` defaults to
`console`, not `fake` (D6). The spec says the fake driver is "used by every e2e spec and the
hermetic stack" and relies on `[fake:...]` seams, but section 5 never names
scripts/e2e-session.mjs, and D6 does not say console honors the seams.

Implies: name the e2e child env (RANKING_DRIVER=fake) as a surface, and design the race out (for
example a lane-only way to keep the worker's ranking poll from claiming, or specs that do not
assert pre-tick state). AGENTS.md treats a named-spec failure as a regression, so a racy spec is a
cost, not a nuisance.

---

## F13. [MEDIUM] The replaced lean seed match row is permanently out of date and not in any pool

What is wrong. D8: the lean legacy row (lean.ts:445-457) is replaced by a `schema: 2` row "scored by
the fake rules with current versions and fingerprints computed from the seeded cards, so the
hermetic world opens with one stored match".

- The lean world is byte-stable on fixed timestamps (lean.ts:5, 18-19: T0 = 2026-06-01). A fixed
  `computedAt` is always older than RANKING_MAX_AGE_DAYS (7), so the row reads `outOfDate: age`
  forever; a wall-clock `computedAt` breaks byte-stability.
- The tenant card carries `lastHeardFrom` as a bucket computed "with the clock" (D2.1, D2.2 ctx).
  A fingerprint computed at seed time drifts as wall-clock buckets roll, so the row also reads
  `outOfDate: card`.
- The seeded tenant is `status: 'placing'` (lean.ts:101), so it is in NO property's pool (D1
  requires `searching`); the row only appears on a tenant-anchor read, and only if unitA is
  available with no other tenant's placement.

Implies: the row demonstrates nothing and pins nothing. Either drop the claim ("opens with one
stored match"), or seed a row whose freshness is not wall-clock dependent and assert explicitly
what state it is in. Note also the lean comment says 2026-09-01 but MATCH_EXPIRES_AT 1787270400 is
2026-08-21 (the spec copied the comment); harmless.

---

## F14. [MEDIUM] Run detail shows the current pair rows, which later presses overwrite

What is wrong. D12 / D18: `GET /api/admin/rankings/runs/:runId` returns "its pairs read by key from
matchKeys", and the run detail shows "its pairs: candidate, score, band, cap, reasons ...". The
matches store holds ONE row per pair, overwritten by every later press from either anchor (D8;
charter 7.2 "another anchor's Update rewrites a shared pair"). Opening an older run therefore shows
another run's scores and reasons under this run's header.

Charter 11/17: the run log is how "each ranking [is] recorded so Client can review it" ("matches
overwritten on each press plus the run log kept 180 days"). The run already stores `rawText` (D11),
which is what this run actually said.

Implies: the run detail must render the run's own output (parse `rawText` with the run's handle
map, which must then be stored on the run) or at least mark pairs whose `match.runId !== runId` as
"since re-scored". As written it is a misleading forensic surface.

---

## F15. [MEDIUM] The GET read recomputes the whole pool and every candidate card on each open and every 5 s poll

What is wrong. D9: "The read computes the current pool and cards". For a property anchor each tenant
card needs `listing_sends.listByContact`, `tours.listByTenant` and the seen units (D2.3), so a
150-tenant pool is several hundred DynamoDB reads per GET, behind the 30 s CloudFront origin
timeout the charter cites (charter 10.2, infra/modules/cloudfront/main.tf:114, not re-read here).
D12/D18: the Rankings page re-reads by GET on every event AND polls every 5 s while a job is queued
or running (one to two minutes), repeating the full computation each time. The spec defers the
cost to "the plan measures"; it states no bound and no fallback if the measurement is bad, and
RANKING_MAX_POOL (300) is enforced only in the job (D1), not on the read.

Implies: a build that is correct but slow has no designed exit. State the budget, what the read
does over it (for example skip candidate-card fingerprints while a job runs, or cache per
generation), and whether the pool ceiling applies to the read.

---

## F16. [LOW] "Restore the record's correlationId" names a field the context does not have

`CorrelationContext` (app/src/lib/context.ts:6-51) has no `correlationId`; the logger derives it as
`jobRunId ?? pollRunId ?? requestId ?? bootId` (app/src/lib/logger.ts:248). Run inside the tick
(which sets pollRunId, jobs/pollLoop.ts:68-72), a restored `requestId` loses to `pollRunId`, so the
job's lines do not join the press. `traceparent` in the ALS context is only copied into job
envelopes (jobs/jobs.ts:192, 309); nothing shown makes it the parent of OTel spans, so "spans join
the press" (D7) is UNVERIFIED and likely false. Say which fields the record stores and that the job
runs in a fresh context without pollRunId/jobRunId. Separately, ticks overlap (spec section 2), so
`RANKING_MAX_CONCURRENT_JOBS` "per worker process" needs an in-process counter the spec should name.

## F17. [LOW] Reusing the AI run repo's pointer helpers would break the Rankings list

`aiRunsRepo.listByEntity` BatchGets `run#<runId>` for each pointer (repos/aiRunsRepo.ts:160,
304-379) and renders a miss as `expired`; `runExpiresAt` is 90 days (aiRunsRepo.ts:178-180;
tables.ts ai_runs comment "TTL: 90 days on BOTH row kinds"). D11 stores runs as `rrun#` with a
180-day TTL and does not give the pointers' `expires_at`. A builder reusing the helpers gets every
ranking entry rendered expired and pointers that vanish at 90 days (charter 11: kept 180 days).
State that ranking listing is its own reader and the pointer TTL.

## F18. [LOW] Notes guard: the test list contradicts D14.3; "the seeds" are not Notes writers

D14.3: "a refusal caused by the Notes stamp answers 409 notes_stale". Section 6 tests: "mixed guards
answer contact_changed". The existing staff-notes rule (app/src/routes/contacts.ts:2027-2049)
re-reads and reports the notes error whenever its stamp actually moved, even with other guards
present. Say which rule Notes follows. Also D14.3 and section 5 list "the seeds" as Notes writers;
no seed writes a contact `notes` (grep of app/src/lib/seed shows only `preferences_notes`), so
there is nothing to stamp - harmless, but the writer list should be exact.

## F19. [LOW] "Listed by its last label" cannot be implemented

D2.3: a seen unit that cannot be read "is still listed by its last label ... with label: 'a property
no longer on file'". `ListingSendItem` stores no label snapshot (repos/listingSendsRepo.ts:86-125),
so there is no last label; the two halves of the sentence also contradict each other. And units are
soft-deleted (`deleted_at`), so a deleted unit is usually still readable - say whether a
soft-deleted seen unit shows its label or the placeholder.

## F20. [LOW] A failed-batch flag outlives a successful re-score from the other anchor

D9 marks `outOfDate: failedBatch` (and `notScored`) from "the anchor's last job" record. If the pair
was rewritten successfully afterwards by the OTHER anchor's job, the read still flags it. Compare
`match.computedAt` (or `runId`) with the failed job before flagging.

## F21. [LOW] The landlord-defaults switch leaves the cap and accommodation matching undefined

With `RANKING_LANDLORD_CARD` on, a requirement may exist only as a landlord default
(`landlord:<key>` in the flag enum, D5). D9's "recorded on that property's current card" does not
say whether a landlord default counts, and an accommodation flag on `landlord:no_pets` will not
equal a `failedRequirements` value `no_pets` (that enum has unit keys only), so the cap would apply
despite the accommodation. The schema enum also changes with the switch, and the compile check
covers one variant. Default off, so LOW; decide it before the switch is ever turned on.

## F22. [LOW] The Notes changes alter charter 6.4 without a section 20 entry; one duplicate can follow deploy

Charter 6.4 says the append path "and its retry guard ... are kept as they are", and charter 15.4
lists 6.4. D14.1-2 change `filterNoteLines` (Cameron approved in intent.md, but the spec header
says a change "is recorded in charter section 20" and none is). Also: after the collapse a retried
pre-deploy window whose multi-line note is stored as separate physical lines yields "a / b", which
the whole-line guard (services/extraction/apply.ts:318-357) no longer matches - one duplicate line
per such retry.

## F23. [LOW] The compile check cannot run "at the spec gate against the draft schema"

D17.1 hands Cameron `extraction-schema-compile-check.ts --model claude-sonnet-5-5` at the spec gate,
but the `ranking` variant is new code (the script's VARIANTS today are extraction and grader only,
app/scripts/extraction-schema-compile-check.ts:1-60). Either the planner writes a throwaway variant
for the gate (say so) or the gate-time run does not exist. The script also sends through the
extraction structured-output client (thinking off), not the ranking request (adaptive thinking,
effort) - grammar compile is probably independent of that, UNVERIFIED.

## F24. [LOW] The Opus price is unverified and the default table invents a row

D6 defaults `claude-opus-5-5` to $4 / $20 per million tokens. The only existing table
(app/scripts/extractionProbeNeverWritten.ts:439-446) has no Opus 5.5 row and marks every price
"unverified - Cameron confirms at the launch gate". Since a missing price stops startup and every
run records cost, mark the defaults unverified and add them to Cameron's gate list. Prices
UNVERIFIED here.

---

## Claims in spec section 2 checked and found accurate

extractionRepo.claim has no reclaim (repos/extractionRepo.ts:410-445); pollLoop mints pollRunId per
tick on an unref'd setInterval (jobs/pollLoop.ts:55-76); WORKER_POLL_INTERVAL_MS default 30000
(lib/config.ts:630-646); the Anthropic client has no timeout and default retries
(adapters/extraction.ts:259-261), MAX_OUTPUT_TOKENS 4096 (:226); aiRuns list scope pattern and
`run#` detail (routes/aiRuns.ts:30-31, 228-233, repos/aiRunsRepo.ts:160); matches table keys
(lib/tables.ts:238-252); staff_notes guard (routes/contacts.ts:1950-1952, 2007-2049);
filterNoteLines and toSingleLine (services/extraction/apply.ts:318, prompt.ts:231-233);
requireAuth / requireRole (app.ts:243, routes/aiRuns.ts:137); settleTypedOrgText ambiguity and
resolveOrgText first-name match (dashboard/src/routes/orgs/orgCopy.ts:248-259,
app/src/lib/orgNames.ts:95-113); voucher twin (lib/blastAudienceRules.ts:210-238); TERMINAL_STAGES
(lib/statusModel.ts:118-121); staff_notes comment location (repos/contactsRepo.ts:171-178).
The new routes sit under /api/*, which already admits POST at the edge (routes/internal.ts:6-7), so
"no infrastructure change" holds for the endpoints.
