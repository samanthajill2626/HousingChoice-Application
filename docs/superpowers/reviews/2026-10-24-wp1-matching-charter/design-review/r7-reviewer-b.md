# WP1 matching charter - design review round 7, reviewer B

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md at
734a6e31. I read the whole spec again cold, then the e03dc05d..734a6e31
diff and the round-6 adjudications. I read the code read-only. I read
nothing else in the reviews folder.

DECISION = changes what gets built, adds or removes a surface, or moves an
invariant. PRECISION = something a slice spec would settle.

---

## 1. [MEDIUM] [DECISION] Dismiss has no effect on the model, and any VA can press it

What is wrong. 7.2 says Dismiss ("this is lawful") closes an unlawful flag,
so that field caps pairs again and stops being flagged until its text
changes. But the cap fires only when the model lists the key in
`failedRequirements` (7.4), and the rubric tells the model to disregard a
requirement it judges unlawful and to report it (7.2). After Dismiss the
model still sees the same text and the same rubric. So it will keep
disregarding the field, keep leaving it out of `failedRequirements`, and
keep raising a flag that code now drops. The cap Dismiss is meant to
restore never fires.

Separately, Dismiss is a fair-housing judgment that brings back
deterministic enforcement of a rule the model called discriminatory. 10.2
opens "Rank, Update and the review controls" to `admin` and `va`
(broadcasts.ts:1-4) and does not say who may Dismiss. A1 leaves lawful
operation with Client ("Client remains responsible for lawful operation").

What it implies. Pick one of two designs:

- (a) Dismiss is display-only. It hides the banner while the model goes on
  disregarding the field. The cap stays suppressed, which is the safe side
  ("a false flag costs a cap, never a tenant").
- (b) Dismiss puts the staff ruling on the property card ("staff reviewed:
  lawful") so the model applies the requirement. That changes the card and
  its fingerprint.

Either way, restrict Dismiss to admin and audit who dismissed what, with
the text at that moment.

## 2. [MEDIUM] [DECISION] Poll takeover re-runs without limit, so a crash loop keeps paying with nobody pressing

What is wrong. 10.2 now has the poll itself take over an expired lease
"with a new generation and re-run it, with no new press needed". There is
no attempt count. A job that dies the same way every time (the worker
process crashes or is OOM-killed on a large pool, or a hang outlives the
lease) is taken over again after every lease expiry and pays for the model
each time. Extraction, the precedent the charter cites, counts attempts,
backs off and parks (repos/extractionRepo.ts:78, 169-172, 192). A ranking
re-run that no person caused is also close to the "background re-ranking"
A1 excludes.

What it implies. Cap takeovers: one automatic takeover, enough to cover a
redeploy, then `failed` with a message that a new press clears. Store the
attempt count on the ranking-job record.

## 3. [MEDIUM] [PRECISION] The poll cannot find an expired running job the way 10.2 indexes records

What is wrong. 10.2: "Queued records carry a byEntity key family that the
poll queries". If the claim removes the index keys (extraction's pattern,
extractionRepo.ts:14-16), a running record is no longer in any index. A
running record whose lease expired is then invisible to the poll, so the
takeover in 10.2 cannot find what it is meant to take over. On a
hash-only table (lib/tables.ts:645-655) the only other way is a Scan.

What it implies. Running records also need a `byEntity` entry, for example
a running partition with `sortKey` = lease expiry, so the poll can query
for leases that have run out. The slice can choose the exact keys, but the
charter's "queued records" wording rules this out.

## 4. [MEDIUM] [PRECISION] The property-level flag record has no stated home, and "removing the text closes it" has many writers

What is wrong. 7.2 adds a property-level unlawful-flag record (field,
reason, run) that is open until staff resolve it, and says "removing the
text closes it". It does not say where the record lives. If it lives on
the unit item (the flexible document), 6.1's classification must exclude
it. Otherwise opening or closing a flag changes the unit card and its
fingerprint, marks every pair of that property out of date, and feeds the
model its own earlier flags. "Removing the text closes it" also implies
every unit writer closes flags: the units PATCH, the landlord "Apply to
properties" copy (routes/contactRequirementsApply.ts:1-16), and the
import's unit writes.

What it implies. Name the store. Close a flag on read by comparing a hash
of the field's text stored with the flag against the current text, which
also gives Dismiss's "until its text changes" for free, so no writer
changes. Say which slice shows the flag on the property record: B2 owns
the record, but the property page is B4's surface.

## 5. [LOW] [PRECISION] Matching facts as a contact attribute: write races and growth

6.4 now stores facts "as a list on the tenant contact". Two things for B1:

- Extraction writes facts live while Sam's remove control writes the same
  attribute. A whole-list read-modify-write loses one of the two writes.
  That is the race the notes box accepts (services/extraction/apply.ts:
  725-730), but here a lost removal means a wrong fact keeps feeding the
  ranker. A map keyed by the fact key (SET or REMOVE on one key at a time)
  or a version condition closes it.
- Nothing bounds the list. Facts are written on every inbound text, and
  each fact is on the card of every batch the tenant appears in. A per-label
  rule (the latest value wins) or a cap keeps card size and cost bounded.
  The suppression record's home is also unstated.

## 6. [LOW] [PRECISION] What `AI_RANKING_ENABLED` off means for the composer B3 and B4 ship

B4 removes the filter-only audience. If the switch is off, for example
because the counterfactual check failed, the composer should still list
the pool unranked ("not ranked yet") with send working and only Rank
hidden. Otherwise B3 and B4 cannot ship to production ahead of the switch.
Say so, and say whether the ranking poll loop starts only when the switch
is on, as extraction's does (worker.ts:450).

---

Fixes I checked and found correct: the credit-or-income wording now
separates rent, the payment standard and the tenant's portion; reaction
text under the never-extracted list and the test; the named AGENTS.md
exception, with the request's correlation id and traceparent carried on
the record and restored (jobs.ts:96-192 shows what the queue carries);
pickup allowing for the shared interval; the accepted superseded-batch
write; the record TTL of at least `RANKING_MAX_AGE_DAYS`; admin-only
Rankings page (routes/aiRuns.ts:137); and the B1/B2 rows and the 6.1 and
15.4 wording.
