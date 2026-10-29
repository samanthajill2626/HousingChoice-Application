# WP1 B2a Ranking engine - design review round 2 (reviewer A)

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md, rev 2 at 5b97ac07
Charter: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md (through section 20 item 14)
Also read: design-review/R1-reviewer-B.md, design-review/adjudications.md, and the code cited below.
Read-only. No tests, servers or model calls were run.

The round-1 findings from both reviewers are mostly closed by rev 2. This pass covers what the
rewrite introduced, what both reviewers missed, and where an accepted fix is not enough. Severity
is the consequence if the spec ships unfixed.

---

## R2-1. [MEDIUM] The prompt's properties-seen list is now unbounded, but Q2 tells Cameron "at most 8"

What is wrong. D2.3 (rev 2): "every entry that carries an outcome (a decline, a tour or a feedback
line) is ALWAYS listed; entries that carry only sends fill the remaining slots up to
RANKING_SEEN_MAX (default 8 in all)". Outcome entries therefore have no bound. Q2 (spec section 9)
asks Cameron to approve a list that "lists at most 8: every home with an outcome or feedback
always, then the newest bare sends". That holds only when a tenant has 8 or fewer outcome homes,
and staff mark Not interested routinely (charter 4, 6.3).

Consequences the spec does not account for:
- Prompt size. A long-searching tenant with 25 declined or toured homes carries 25 entries, each
  with a summary, a decline, tours and feedback lines. Forty such cards make one batch. Rev 1's
  reason for the bound (Q2: "would multiply the input several times over") applies again, now
  with no ceiling. That affects cost per press (charter 14 envelope), latency and the
  `inputOmitted` 350 KB guard (D11).
- Read cost. Every listed outcome entry needs its unit read for the summary, so the job's cost
  per tenant has no bound either. D9 still says "about ten DynamoDB reads per tenant candidate".

Implies: Cameron is asked to approve a bound that the mechanism does not have. Either cap the
listed outcome entries too (the fingerprint, D13, is already independent of what is listed, so
a cap is now safe), or restate Q2 with the real behavior and a measured worst case.

## R2-2. [MEDIUM] D13 drops card content from the tenant fingerprint; charter 10.3 (non-reopenable) says card changes flag

What is wrong. Charter 10.3 says a fingerprint changes on "the cards as defined in section 6".
Charter 6.2 puts each seen property "with that property's card details" on the tenant card.
Rev 2's D13 leaves out of the tenant fingerprint the seen-property summaries ("The seen summary
of a property is not in it either"), the arrangement, and the labels that decide the attach step.
These are all model input. Two cases follow:

- A seen property's own edit (rent, beds, pets policy) changes the prompt for every pair of
  every tenant who saw it. Only that property's own pairs are flagged, through `unitCard`.
- A seen property's address edit changes its label. Its feedback lines then stop attaching and
  fall back into general `notes` in the prompt (D2.3). The tenant fingerprint (stored Notes text
  plus declines and tours) does not move, so the tenant's other matches are not flagged.

Charter 15.4 lists section 10 ("fingerprints and the age rule") as a decision no slice may reopen.
The adjudication accepted the new definition (A1/B1 row) but recorded no charter amendment.

Implies: the exclusion is probably the right engineering call, because it keeps one property's
edit from rippling through every tenant. It still changes what "out of date" means, so it needs
Cameron's decision and a charter section 20 entry, not an adjudication row.

## R2-3. [MEDIUM] Expired queued jobs: the poll's behavior is undefined, and both readings are defects

What is wrong. D7/D9 (rev 2): an unclaimed queued record past `queuedExpiresAt` "reads as
`expired` (derived on read)", the page "stops polling on it", and a press reclaims it. Nothing
says what the RANKING POLL does with such a record. Its stored status stays `queued` and it keeps
its `rankjobs#queued` index keys (D7: only done and failed records drop them). The poll "queries
queued records oldest first".

- If the poll still claims it, the job runs after the page has told the user "The ranking was
  not picked up. Press Rank again." and has stopped polling. Results then arrive only through the
  best-effort event or a manual reload.
- If the poll skips it, the record stays queued for its 180-day TTL at the HEAD of an
  oldest-first index. A query bounded by the free slots then returns dead records first and can
  starve live ones (the index range key acts as a hidden priority order).

The expiry, max(4 x poll interval, 120 s), is tied to the poll cadence, not to queue depth. With
RANKING_MAX_CONCURRENT_JOBS = 2 per process and long jobs (a 300-pool is 8 batches at
concurrency 4), a third press can wait past 120 s while the worker is only busy, not dead.

Implies: the poll must give an expired queued record a terminal state (claim and run it, or move
it to `failed` with the message and drop its index keys), and the read's `expired` must agree
with that. Say which, and test it.

## R2-4. [MEDIUM] The counterfactual gate still fails on noise: about 100 comparisons at about 2 sigma each, and a majority cap vote that flips on 2-of-3

What is wrong. D17.2 (rev 2): about six base pairs, about nine swaps (now including the
authority swap), two directions, three runs per arm. That is roughly 100 base-versus-variant
comparisons. Each fails when the mean moves more than 5 points. A pair is inconclusive only when
its own three base runs spread more than 5.

With a per-run standard deviation s, the difference of two 3-run means has standard deviation
about 0.82 s. A base that passes the "not inconclusive" screen (3-run range at most 5) is
consistent with s near 3, and then a 5-point move is about 2 standard deviations: roughly a 4%
chance per comparison, or about 4 expected false failures across the gate. The range of 3
samples is itself a poor estimate of spread, so noisy pairs slip past the screen. The cap rule
("majority of the three runs is the same") flips whenever a borderline pair goes 2-of-3 on one
side and 1-of-3 on the other.

Expected outcome: the gate reads "fail" or "decide" on a correct prompt, so "Cameron decides"
becomes the normal path. That undermines the merge gate the charter made binding (charter 7.2
AMENDED 2026-10-28). This contests the A4/B6.2 adjudication: the fix handles a band boundary,
not multiple comparisons.

Implies: decide the verdict at the level of the whole gate. Options: more runs per arm, a
threshold scaled to each pair's measured spread, a family-wise rule, or a two-stage re-run of
only the failing comparisons. Keep "decide" for real signal, and state the expected false-failure
rate at the chosen numbers.

## R2-5. [LOW] "The cap code is production's" is not true of the check's per-run cap

D17.2 says the check runs "the cap code [as] production's". It then says each run's cap is
computed "from THAT run's own output" with "no flag record persists between runs" (B6.1's fix).
Production caps through persisted, property-level OPEN flag records (D9, D10). A flag raised by
any pair of the property suppresses the cap for every pair, including later runs. The per-run
rule is the right choice for a deterministic gate, but the sentence claiming production's cap
path should be corrected. Say plainly that the cross-pair, persisted suppression is not
exercised by the gate.

## R2-6. [LOW] The tenant fingerprint's `tours` content is unspecified; a raw tour item churns

D13 hashes `{ unitId, declined, tours }` per seen property, and D13's pairHistory hashes "the
tours". It never says which tour fields. A stored `TourItem` (app/src/repos/toursRepo.ts:68-132)
carries `roster`, `rosterVersion`, `currentLadderId`, `groupThreadId`, `convertible`,
`lastMarkedAt` and more. Several are rewritten by the reminder ladder and roster flows with no
outcome. If the builder hashes raw items, every reminder rung marks all of the tenant's matches
out of date. State the projection (the prompt's "status, outcome and dates", naming which dates)
and use it for both D13 hashes.

## R2-7. [LOW] Setting `jobRunId` to the press's requestId breaks the context's own contract

D7 (rev 2) runs the job in a fresh context "with jobRunId set to the press's requestId". In
app/src/lib/context.ts (pollRunId docblock, about lines 20-31), `jobRunId` means a dispatched-job
run and is kept apart deliberately, so that "which of these ran as a queued job" can be answered
from a log line. dispatchJob mints it fresh per run (jobs/jobs.ts:302-309). A fresh context
carrying only `requestId` (plus `traceparent`) already gives correlationId = requestId through
the ladder (logger.ts:248) without mislabeling the ranking job as an SQS job run.

## R2-8. [LOW] Landlord-twin flags are "treated as a flag on <key>" even when the property's own value is on the card, or the switch is off

D2.1 (rev 2): with the switch on, "a flag on landlord:<key> is treated as a flag on <key> when
matching accommodations and unlawful flags". D10 makes unlawful flags durable property records
with no TTL, closed only when the flagged text's hash changes. So:

- If the property later records its OWN `qualifications` (lawful), "the property's value wins"
  (D2.1) and the landlord text leaves the card. The open `landlord:qualifications` flag still
  suppresses the cap on the property's own field until the landlord's text changes.
- If the switch is turned off, the spec does not say whether a `landlord:` flag is still open,
  or what its hash is compared against.

Close a `landlord:` flag (or ignore it) whenever the landlord value is not on the property's
current card.

## R2-9. [LOW] Rev 2 left stale and conflicting text

- D12 run detail still reads "its pairs read by key from `matchKeys`". D11 no longer lists
  `matchKeys`; the detail now renders `results[]` (D11).
- D2.4.1 still types the registry `Record<KnownKeys<ContactItem>, ...>`. D2.1 now says typed keys
  MINUS `TenantMatchingInputKey`, plus the list's keys.
- The header says the charter is "amended through section 20 item 13". D14 cites item 14.
- Section 5 "Scripts" still says a `ranking` variant. D5 and D17.1 now have two.

## R2-10. [LOW] `results[]` says "whether a match was written", but the run is written before the matches; the run detail's "cap" for an old run is undefined

D7 order: each finished batch "writes its run (D11), its matches (D8) and its unlawful flags".
D8: a BatchWrite that still fails becomes the batch's failure. So when the run is written, it
cannot yet know whether matches were written, and a later match-write failure leaves the run
saying "scored" with matches claimed. Either write the run last or update it after the matches.
Separately, D18's run detail shows "band, cap" per pair from `results[]`. The cap depends on the
property's CURRENT card and open flags (D9). The spec does not say whether an old run's cap is
recomputed against today's state or shown as of the run.

## R2-11. [LOW] Extending B1's reader test to the ranking directory will trip on the examples, and the fake driver must name two keys

D2.1 (rev 2) adds the ranking directory to `tenantMatchingInputsReaders`. That test fails on any
file containing a key string such as `area_preference` (app/test/tenantMatchingInputsReaders.test.ts
lines 28-37). D4's `examples.ts` sits in that directory and holds example CARDS. If card keys are
attribute names (D2.2 does not say keys or labels), the examples spell the keys and the test
fails. The fake driver (adapters/rankingFake.ts, outside the scan) reads "the tenant's maximum
portion" and "area preference" (D6), so it must name `max_tenant_portion` and `area_preference`,
or find them in the list by kind. State that cards key B1 inputs by label, or exempt examples.ts,
and say how the fake locates the two inputs.

## R2-12. [LOW] `voucher_program` is now on the card with no swap, though HUD program names can designate disability

Rev 2 includes `voucher_program` (D2.1) as a "voucher fact". It excludes `agency` because it "can
stand in for a disability", and adds a DBHDD authority swap for the same reason (D17). HUD's
Mainstream and Non-Elderly Disabled programs are disability-designated vouchers, so a
`voucher_program` value can be the same proxy. No app writer stores it; the seeds carry 'HCV'
(app/src/lib/seed/cast.ts:220, lean.ts:119). Production values are UNVERIFIED. Exclude it under
the agency rule, or add it to the D17 swaps.

---

## Fixes checked and found sound

- D13's tenant hash (own fields minus notes and seen, plus stored Notes text, plus declines and
  tours by unitId sorted) does make a bare send, a re-send, an eviction from the listed entries
  and a re-attachment hash-neutral, by construction (subject to R2-2 and R2-6).
- D5's code-side unlawful rule closes the checkbox, money, enum and credit/income paths, and the
  enum now excludes credit and income keys.
- D6 refuses `fake` and `console` under NODE_ENV=production (config.ts:648-649: both stacks), and
  stamps `model: fake/console`, so the version rule (D9) flags them.
- D7's RANKING_WORKER_POLL=off removes the e2e race. The tick runs in the app process. The e2e
  child env is passed to both children (scripts/e2e-session.mjs:252-258).
- D9's failed-batch test against the job's `startedAt` and D12's cheap job read are sound.
- D14.3's conflict rule now matches the Staff notes precedent (app/src/routes/contacts.ts:2036-2041).
  The one deviation, refusing a client `notes_updated_at` where the precedent ignores
  `staff_notes_updated_at` (contacts.ts:653-654), is harmless.
- D1's use of `checkScalarWrite(entries, 'audience_filter', ...)` is right: `audience_filter`
  accepts housing authorities only (app/src/lib/orgNames.ts:29-36, 275-289).
