# WP1 matching charter - design review round 5, reviewer B

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md at
5e85b185, read whole and cold. Also read: adjudications.md, r1-r4
reviewer A, my own r1. Code read read-only in W:/tmp/wp1-matching-charter.
I read nothing else in the reviews folder.

Tags: DECISION = changes what gets built, adds or removes a surface, or
moves an invariant. PRECISION = wording, or detail a slice spec would
settle. Severity = consequence if it ships unfixed.

---

## 1. [HIGH] [DECISION] Ranking jobs on the shared SQS consumer block every other job while they run

What is wrong. 10.2 puts Rank on `jobs.enqueue`, with batches in parallel
and a per-call timeout "that keeps the job under the visibility timeout"
(120 s). The jobs consumer handles each receive batch with
`await Promise.all(messages.map(handleMessage))` and does not call
ReceiveMessage again until EVERY message in the batch has finished
(app/src/adapters/sqsJobConsumer.ts:126-129). So a ranking job of 30-110 s
holds up every job behind it for that long: relay group fan-out
(jobs/relayFanOut.ts, a queue job per registerHandlers.ts:34-43),
broadcast sends, retries, send reconcile and tour reminders. No job on
that queue runs this long today. Extraction, the only other model caller,
does not use the queue. It runs on its own worker poll loop with state in
DynamoDB (app/src/worker.ts:439-465).

What it implies. Each Rank press can delay live group texts and sends by
up to two minutes. The charter has to pick one of two options. (a) Run
ranking the way extraction runs: due-row state plus its own poll loop.
This needs no new infrastructure. (b) Keep every queue job short, for
example one batch per message with a continuation, and accept that the
lease and claim design in 10.2 then covers several messages. Round 3
(R3-2) and round 4 (R4-2) settled at-least-once delivery and the claim,
but neither looked at what a long job does to the consumer it shares.

## 2. [HIGH] [DECISION] The credit and income carve-out goes by field name, so the model still reads that content and the cap still enforces it

What is wrong. 6.1 keeps the unit's `credit_requirements` and
`income_requirements` and the tenant's `lifEligible` off the cards (M20).
But the property card still includes `qualifications` (long text),
`notes`, `deposit_notes`, `application_process` and `lease_terms`, and the
tenant card includes `customFields` by default (6.1 L230-231). Any of those
can say "600 credit, 3x income". `qualifications` is a recorded
requirement key (lib/requirements.ts:79-81), so 7.4's cap will land a pair
in Weak when the model reports it failed. The tenant has no income facts
(6.4 never extracts them), so 7.2's "uncertainty is scored as uncertainty"
turns an income clause into a lower score. Separately, the Move-in costs
keys (`deposit`, `deposit_one_month`, `application_fee`;
requirements.ts:95-105) are also cap-eligible "recorded requirements".
That makes being unable to pay a deposit or fee a deterministic Weak.

What it implies. A1 excludes "using credit or income requirements to rank
or exclude tenants", wherever those requirements are written. The charter
needs:

- a rubric rule that credit or income content in ANY field is disregarded
  and never reported in `failedRequirements`;
- an explicit list of cap-eligible keys, such as Screening and Pets. Move-in
  costs and Touring are not tenant qualifications.

Without those, M20's fix is plausible but not correct.

## 3. [MEDIUM] [DECISION] An unlawful flag lifts the cap only for the pair that raised it, yet an unlawful rule is defined as property-wide

What is wrong. 7.2 defines UNLAWFUL as "unacceptable for every tenant".
7.4 ignores a failed key only when it "is not in the SAME PAIR's
`fairHousingFlags`". The model reports per candidate and across batches of
40 (7.1). If it flags `qualifications` ("no kids") as unlawful for tenant A
and omits the flag for tenant B while listing the key as failed, B is
capped on the very rule the charter says is never applied. R2-3 made the
check per call, R2-4 made it per candidate, and R4-3 rightly kept
accommodation flags per pair. Nobody changed the unlawful half back to
property-wide.

What it implies. The cap check should treat a key as lawful-to-enforce
only when no pair in the ranking (the merged unlawful set, by property and
field) flagged it unlawful. Ideally the check also covers flags still
current on that property's other stored matches. Accommodation flags stay
per pair.

## 4. [MEDIUM] [DECISION] The claim lease does not cover the time a job sits in the queue, and nothing stops a superseded job from running

What is wrong. 10.2: the app claims the anchor, then enqueues. "The claim
carries a lease that the job renews while it runs; an expired lease means
the job died". From claim until the worker picks up the message, nobody
renews. The queue is shared and can back up behind continuations and
paced sends (finding 1 makes this worse). If that wait outlasts the lease,
the next press takes over and enqueues a second job. When the first job
finally runs, nothing in the charter makes it check that it still holds
the claim. Both jobs pay for the model, and both write every pair. A failed
enqueue after a successful claim also leaves the anchor showing "queued"
until the lease runs out.

What it implies. Add a claim generation (fencing token) to the claim. The
job checks it before each model call and each write, and exits quietly
when it has been superseded. Also set the queued period's expiry
separately from the running lease, or start the lease only when the job
starts. These choices define what "join" means, so they are charter-level.

## 5. [MEDIUM] [DECISION] The never-extracted list leaves out disability and medical facts, and 7.2 still calls the accessibility need disability's "one use"

What is wrong. 6.4's never-extracted list covers race, color, religion,
sex, national origin, familial facts beyond household size, and income
and credit. It does not cover disability or health, so the live, open
"anything that might matter" instruction will write diagnoses and
conditions as matching facts on the tenant card. 7.2 still says "The one
use of disability is a tenant's own stated accessibility need", but the
ACCOMMODATION flag added in R3-1 (assistance animal against No pets) is a
second use.

What it implies. Add "disability or medical facts, other than the stated
accessibility need and an assistance animal" to the never-extracted list
and to B1's test, and fix the "one use" sentence.

## 6. [MEDIUM] [DECISION] Both fair-housing tests produce a record, but nothing says what a failure stops

What is wrong. 7.2: B2's counterfactual check is compared "against a
tolerance B2 sets, and the result is a mission record". 6.4: B1's
never-extracted test runs on the testing key. Neither says what happens if
it fails: whether it blocks B2 or B1 from merging, blocks Sam's acceptance
pass, or blocks turning the feature on. Both are live-model checks that
are not in `npm test`, so no gate runs them. The counterfactual also swaps
"address", which is a legitimate input (6.1 passes it whole; area
preference is weighed against it). A score that moves on an address swap
is therefore expected, and the tolerance cannot separate a proxy effect
from fit.

What it implies. State the consequence of a failure (for example: no
production enablement until it passes, or Cameron decides). Hold area
inputs fixed when swapping addresses, or swap only between addresses that
are equivalent for the tenant's stated area. Otherwise the guarantee
section 7.2 adds is still only stated, not tested.

## 7. [MEDIUM] [PRECISION] Polling stops on "done" but the property side reads through an eventually consistent index

What is wrong. 10.2: batches persist, an event says "batch n done", the
composer re-reads by GET, and "polling stops on done or failed". A
property anchor reads its pairs through the `byUnit` GSI
(lib/tables.ts:240-252). That index is eventually consistent, and
BatchGetItem cannot read an index. So the final GET can return pre-run
rows, and once polling stops the composer shows stale scores without
flagging them out of date (the old rows' fingerprints still match).

What it implies. Either the read after "done" fetches the matches by the
keys the run recorded (11: "the ids of the matches it wrote") from the
base table, or polling continues until every row carries the run's
`runId`. B2 can choose; the charter should name the hazard.

## 8. [MEDIUM] [PRECISION] Extraction retries will duplicate live facts and reactions

What is wrong. Extraction runs `applyExtraction` before `repo.complete()`.
A failed `complete()` re-runs the SAME window, which is why note lines
carry a verbatim-duplicate guard (services/extraction/apply.ts:725-735).
6.4's live matching facts and 6.3's reaction list ("at, kind, text, source
message, run id") have no identity rule against a retry. A retry gets a
new run id, so it appends a second copy of the same reaction to the
listing_sends row. That changes the pair-history fingerprint and turns
the pair out of date for no reason.

What it implies. Key a reaction by source message and kind, and a fact by
label, value and source message, so a re-applied window writes nothing new.

## 9. [MEDIUM] [PRECISION] Contest M19: "no field is read until classified" and "projected through ONE exclusion list" still disagree at runtime

What is wrong. 6.1 says both. On flexible documents, an exclusion
projection passes any stored key the list does not name. That includes
legacy attributes left on contacts to "go unread"
(contactsRepo.ts:372-377), the tombstoned `jurisdiction` and
`accepted_programs` still stored on units (unitFields.ts:161-172), and
import riders such as `quo_contact_ids`. The B2 test sees typed keys, not
stored ones.

What it implies. Say that the card function drops any stored key that is
not classified (a runtime allowlist built from the classified set). That
is what "no field is read until classified" has to mean for the promise
to hold.

## 10. [LOW] [DECISION] The landlord card switch carries the landlord's credit and income defaults

When `RANKING_LANDLORD_CARD` is on, 6.2 adds "the landlord-of-record's
recorded requirements". Those include `req_credit_requirements` and
`req_income_requirements` (contactsRepo.ts:362-363). 6.1 excludes only
the unit's copies. Exclude the landlord's credit and income keys as well,
and apply finding 2's content rule to the landlord's free text.

## 11. [LOW] [PRECISION] The "include older tenants" toggle and the per-anchor join interact

The pool depends on the toggle (5, 9.1), but the claim is per anchor
(10.2). A press with the toggle on that arrives while a windowed job runs
joins that job and silently gets the narrower pool. The claim or job
record should carry the pool scope, and a press for a different scope
should either wait or say so.

## 12. [LOW] [PRECISION] The adjudicated "never" bucket was not written into the spec

R2-9 rules that the never-heard-from bucket is "never". 9.1 still lists
only four buckets ("this week, this month, one to three months, older"),
and the property-anchor tie order ("most recently heard from") does not
say where a tenant admitted through the created_at fallback sorts. Add the
bucket and the tie position.

## 13. [LOW] [PRECISION] "A new text never makes a match out of date" is still false

9.1 and 10.3 promise this because the derived outcome is not
fingerprinted (M6). But a text that extraction turns into a written field,
a matching fact or a reaction changes the tenant card or the pair history,
which does make the match out of date. That is correct behavior and only
the promise is wrong. Reword it to "a text that adds nothing to the record
does not".

## 14. [LOW] [PRECISION] "Left untouched and flagged out of date" needs stored state

7.4 says a failed batch's existing matches are "left untouched and flagged
out of date". Their fingerprints and age are unchanged, so the read rule
in 10.3 will not flag them. Either the failure writes a marker on the row,
or the read joins the anchor's last job record. Pick one.

## 15. [LOW] [PRECISION] Authority mapping when only some names map, plus leftovers

5 covers only the case where none of a property's authorities map.
`prefillAuthorities` drops unmapped members when others do map
(dashboard/src/routes/broadcasts/authorityPrefill.ts:21-31). That property
is then limited to its mapped authorities, and tenants of the unmapped
ones are excluded. The behavior is the same as today and 7.3 shows the
gap, but say so in 5. Leftovers:

- 5 cites the fences as audienceResolution.ts:189-193; they are at
  196-199.
- 7.2 still says "never trained against" after M5 removed the training
  framing.

## 16. [LOW] [PRECISION] Contest M3: section 17 still leaves out the WP3 scope pulled into B1

My r1 finding 4 listed B1's open matching-facts list and per-send reaction
reading as going beyond WP1's "preference fields ... captured" and into
WP3's "Reactions such as 'too far' ... are read and recorded". M3 accepted
that finding but did not rule on this bullet, and section 17 ("every
place where this charter departs") does not list it. It is billed to WP1,
so Sam should hear it.

---

Fixes I checked and found correct as built: the size and authority
readers (5, M1); the sendability fences with consent kept as a flag
(R2-8, matching audienceResolution.ts:70-80 and broadcastFanOut.ts:276);
the imported_from predicate (import/apply.ts:1149-1159); reactions on the
listing_sends row under `shares_op`, with projections that do not leak
them (routes/units.ts:1519 `projectRecipientRow`); Select all following
today's default (broadcasts.ts:1196-1202 confirms explicit selection never
re-excludes declined rows); and separate run-log keys.
