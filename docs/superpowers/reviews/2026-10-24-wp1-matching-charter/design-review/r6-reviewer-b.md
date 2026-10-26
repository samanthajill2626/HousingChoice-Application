# WP1 matching charter - design review round 6, reviewer B

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md at
e03dc05d. I read the whole spec again cold, then the 5e85b185..e03dc05d
diff, the round-5 adjudications and r5-reviewer-a.md. I read the code
read-only in W:/tmp/wp1-matching-charter. I read nothing else in the
reviews folder.

DECISION = changes what gets built, adds or removes a surface, or moves an
invariant. PRECISION = wording, or detail a slice spec would settle.

---

## 1. [MEDIUM] [DECISION] The poll loop drops the press's correlation and trace, and the spec claims the opposite

What is wrong. AGENTS.md: "All job traffic goes through `jobs.enqueue()` /
`defineJobHandler()` so correlation and trace context are preserved". The
producer gate stamps the caller's correlation context and a W3C
traceparent into the envelope (app/src/jobs/jobs.ts:96, 173, 192). A poll
tick inherits nothing from the press that caused the work. `startPoll`
gives each tick a fresh `pollRunId` and nothing else
(app/src/jobs/pollLoop.ts:54-80), and the correlation type documents
that ticks are deliberately not jobs (lib/context.ts:21-31). No poll
carries a traceparent: grep finds trace handling only in jobs.ts and
jobs/types.ts. So 10.2's "The poll carries its own correlation and trace
context, as the extraction poll does" is half false. There is no trace
context, and the tick's own id cannot be tied back to the Rank request.
Extraction is a precedent for a poll loop, but it is not a precedent for
keeping request lineage. Its due rows come from webhooks, and nobody
traces a person's click through them.

What it implies. Moving off `jobs.enqueue` was right (R5-1), but it is an
exception to an AGENTS.md rule, and the charter should say so. The fix
that keeps the rule's intent: the Rank request writes its correlation id
and traceparent onto the queued ranking-job record, and the poll rehydrates
them around that job's run, the way `dispatchJob` does for an envelope.
Without that, a slow or failed ranking cannot be followed from the click
to the model calls.

## 2. [MEDIUM] [PRECISION] The poll needs a way to find due records, and its interval adds up to 30 s before anything starts

What is wrong. Extraction finds due work through a sparse `byDueAt` GSI on
its own table, and REMOVEs the index keys on claim
(repos/extractionRepo.ts:5-16, 178-188). The AI runs table, where 10.2
puts the ranking-job record, has a hash-only primary key (`itemId`) and
one sparse GSI, `byEntity` (lib/tables.ts:645-655). "Its own key family"
in `itemId` cannot be listed without a Scan. The workable form needs no
new infrastructure: give a queued record its own `byEntity` partition
(for example `entityKey = rankjob#queued`), REMOVE the keys on claim as
extraction does, and stay outside the `scope` pattern the run readers
accept (routes/aiRuns.ts:30-31). The charter names none of this.

Separately, every poll uses the shared `WORKER_POLL_INTERVAL_MS`, 30 s by
default (lib/config.ts:608-612; the deployed value is set explicitly,
UNVERIFIED). That adds 0-30 s of pickup on top of 25-35 s per batch for an
interactive button, and the hermetic e2e worker has the same wait. The
"short timer" on a queued record (10.2) must also be longer than that
interval, or presses expire before any tick sees them. A dedicated
interval has a precedent: the tour auto-close poll passes its own
(pollLoop.ts:25-27).

What it implies. Name the due-index form, state the queued expiry in
terms of the poll interval, and decide the ranking poll's interval
(shared or its own). Then include pickup time in B2's latency spike.

## 3. [MEDIUM] [DECISION] A single false "unlawful" flag switches off a lawful requirement for every tenant of the property, permanently

What is wrong. R5-3 made unlawful flags property-wide: "not flagged
unlawful on ANY pair of that property" (7.4). Three problems with how
that works:

- Which pairs count is undefined. On a tenant anchor each property appears
  once in the ranking, so "any pair" inside the ranking is that one pair:
  the rule collapses back to per pair unless the read also loads the
  property's other stored matches (through `byUnit`). Band and cap are
  computed on read (10.1), so this is a read-time join on every tenant
  page.
- If stored matches count, a flag lives as long as any row carries it
  (TTL 180 days, 10.1), including rows scored against an older version of
  the property's text. A stale flag keeps suppressing the cap after Sam
  has changed the field.
- There is no staff override. A model false positive (an ordinary "no
  evictions on program" judged unlawful once) lifts that requirement's
  cap for every tenant of that property, keeps telling Sam to "remove it
  from the record", and Sam has no way to say "this is lawful".

What it implies. Define the set as: unlawful flags on that property's
stored matches whose `unitCard` fingerprint is current. Add a staff
dismissal ("reviewed, lawful") keyed by property and field that clears
both the suppression and the banner. Without a dismissal, a property-wide
rule turns one hallucination into a lasting hole in the cap.

## 4. [MEDIUM] [PRECISION] "Credit or income content in ANY field is disregarded" can switch off two contracted inputs

What is wrong. 7.2 now tells the rubric to disregard credit or income
content in any field. But section 4 has the model weigh "a rent above the
tenant's stated portion", and A1's inputs include "rent against the
payment standard" and the new "maximum tenant portion" field. A tenant
portion is derived from income, and the payment-standard comparison is
about what the tenant can pay. A model following the new line literally
may discard both.

What it implies. Name the exceptions in the rubric line: maximum tenant
portion, rent, the payment standard and their comparison stay inputs.
Only credit and income requirements, wherever written, are disregarded.

## 5. [LOW] [DECISION] Reaction text is outside the never-extracted rule and its test

6.4's never-extracted list and B1's test cover matching facts. The
per-send reaction carries free `text` (6.3) that the ranker also reads
(pair history, 7.1). "Too far from my mosque" or "the stairs are hard with
my condition" would reach the model through the reaction instead. Apply
the same list and the same test to reaction text, or have the reaction
store only its kind.

## 6. [LOW] [PRECISION] Ranking-job record states that need wording

- A job whose lease has expired, with nobody pressing again, stays in
  `running`. The composer should read an expired lease as failed. The
  spec should also say whether the poll may take over an expired record
  by itself (a re-run nobody pressed, paid again) or only a new press may.
- "Checks its generation before every write" is check-then-act across two
  tables (ai_runs and matches). A superseded job can still write after
  its check. That is harmless under the accepted mixed provenance (7.2),
  but it should be stated as accepted, not implied to be fenced.
- The failed-batch list that the out-of-date read joins (7.4) lives on a
  record with a TTL, and the next press overwrites it. Set that TTL to at
  least `RANKING_MAX_AGE_DAYS`, so a pair left untouched by a failed batch
  is not shown as current once the record is gone.

## 7. [LOW] [PRECISION] Production switches are referred to but not named

"A failure blocks turning ranking on in production" (7.2) and "blocks
turning the matching facts on in production" (6.4) both assume switches
that section 14 does not list (extraction's precedent is
`aiExtractionEnabled`, worker.ts:450). Name them, give their defaults
(off in production), and say whether the reaction reading sits behind the
facts switch.

## 8. [LOW] [DECISION] Roles for Rank, reviews and the Rankings page

There are two roles, `admin` and `va` (repos/usersRepo.ts:40). The
composer router is open to VAs (routes/broadcasts.ts:1519), and the
existing AI runs page is admin-only (routes/aiRuns.ts:137). The charter
says the Rankings page is "staff only" and does not say who may press
Rank (which spends money) or whose agree/disagree enters the review set
that A1 acceptance and the worked examples rest on. One line settles it.

## 9. [LOW] [PRECISION] Left over from earlier rounds

- The 6.1 heading, 15.4 ("cards by exclusion") and the B2 row ("cards by
  exclusion list") still say exclusion; 6.1 is now an allowlist built from
  the classification.
- The B1 row in 15.1 still omits the work R5-11 gave B1: the facts
  display, the remove control and its suppression record. Its hours are
  unchanged. Where matching facts are stored is still unstated, and B2's
  card allowlist and fingerprint depend on it.
- 7.4's cap-eligible `qualifications` is free text. The rubric excludes
  credit and income content but not a move-in cost written there ("two
  months deposit"), which would cap through `qualifications` although
  move-in costs "never cap". Extend the content rule to move-in costs.

---

Fixes I checked and found correct: the cap-eligible key list against the
registry (requirements.ts:69-108); credit and income excluded from the
landlord card (contactsRepo.ts:362-363); disability added to the
never-extracted list, and the accommodation wording; the runtime
allowlist; the base-table read after done (BatchGet supports a consistent
read and the run lists the keys it wrote, section 11); retry idempotency
keys for facts and reactions; the "never" bucket and its tie order;
refusing a press whose window setting differs; and the architectural move
off the SQS queue (sqsJobConsumer.ts:126-129; worker.ts:436-466).
