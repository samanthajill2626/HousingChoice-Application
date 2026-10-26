# WP1 matching charter - design review round 3, reviewer A

Spec reviewed at eadf0913 (cited as "spec L<n>"). I read the bea01549 to
eadf0913 diff and the round-2 adjudications. Code was read at the worktree
head. ASCII only.

Stop rule. Findings 1 to 3 change what gets built, or move an invariant.
Findings 4 to 7 are precision edits only. I accept every round-2
acceptance as the right fix, and I contest none of the adjudications.

---

## 1. [HIGH] The cap and the "remove from the record" flag treat a per-tenant fair-housing accommodation as a property-wide requirement

What is wrong. The new mechanism (spec 7.4) caps a pair at Weak when the
model names a recorded requirement key it judged failed, unless the same
pair's `fairHousingFlags` names that key. The section 7.2 flag tells Sam to
REMOVE the requirement from the record. Both assume a requirement is either
lawful for every tenant or unlawful for every tenant. The canonical
fair-housing case is neither.

The case: a lawful "No pets" rule (requirements.ts:87-92; `no_pets` is a
checkbox) does not apply to a tenant's assistance animal, which is a
disability accommodation.

What happens under each branch:
- The model lists `no_pets` in failedRequirements and not in
  fairHousingFlags. Code caps a disabled tenant at Weak. That is the
  discrimination section 7.2 promises never happens, and it is now enforced
  deterministically.
- The model lists `no_pets` in fairHousingFlags. The composer tells Sam to
  remove a lawful No pets rule from the property (spec 7.2: "a flag naming
  that requirement as one to remove from the record").

The rubric's single use of disability, "a tenant's own stated accessibility
need matched to the property" (7.2), does not cover a pet-rule
accommodation. The counterfactual check swaps name, address and household
facts, so it would not catch either branch.

Related gap. The flags are "keys of requirements". Unlawful text in a
non-requirement field the property card carries, such as the unit's
`notes`, `lease_terms` or `application_process` (unitFields.ts:84-87, 89-93,
119), cannot be flagged at all.

What it implies. The charter needs a per-pair flag kind, "this requirement
does not apply to this tenant (accommodation)": it suppresses the cap and
does NOT ask for the record to change. It is distinct from the record-level
"unlawful, remove it" flag. The rubric and the counterfactual set should
include an assistance-animal pair. Flags should be allowed on any
free-text field on the property card, not only on requirement keys.

## 2. [MEDIUM] The job design ignores SQS at-least-once delivery and has no persisted job state

What is wrong. Section 10.2 makes Rank a job (`jobs.enqueue`) with batches
persisted as they finish, a GET re-read and polling. The claims built on it
are: "a second press ... joins that job rather than paying twice"; "If the
organization list cannot be read, the ranking fails with a message" (5); and
a failed batch leaves existing matches untouched until the next Update
(7.4).

Evidence.
- The jobs queue is SQS with a 120-second visibility timeout
  (infra/modules/jobs/main.tf:36).
- A handler that throws is not deleted. It is redelivered, up to
  maxReceiveCount 5, and then dead-lettered with the DLQ alarm paging
  (sqsJobConsumer.ts:11-17).
- A job that overruns the visibility timeout is delivered twice (L12).
- jobs.enqueue only sends an SQS message (jobs.ts:107-131). It records no
  job state anywhere.

What it implies.
- A ranking job that throws on a model error or an org-list failure is
  re-run, and re-paid, up to five times, then pages.
- A large pool (the window toggle on: worst 158 candidates, 4 batches) that
  runs past 120 seconds is scored twice in parallel, with two writers on
  the same pairs.
- "Join" needs a durable in-flight marker the APP process can read before
  it enqueues. Polling needs a terminal state (done, failed with a
  message) to stop on.

None of this has a home, and section 12 already spends the "existing table
only" rule on reviews. The charter should state four things: the handler
never throws on a model or batch failure; the job is idempotent on
redelivery (a run claim); its runtime bound sits below the visibility
timeout; and where the anchor's job status lives.

## 3. [MEDIUM] "A contact created by the import" has no predicate that works on this data

What is wrong. Section 5 says an import-created contact does not use the
created_at fallback. The import writes `imported_from` and `imported_at` on
EVERY contact it touches, including one staff created before the import
matched it. It writes `created_at` only `if_not_exists` (import/apply.ts:
1146-1159).

What it implies. The two obvious predicates both fail:
- "has imported_from" wrongly drops staff-added tenants the import later
  matched.
- "created_at equals imported_at" stops holding for import-created contacts
  after any re-run, because imported_at moves and created_at does not. A
  re-run then puts every never-heard imported tenant back into the window,
  dated to the first import.

The charter should name the predicate, for example "created_at <=
first-import instant and imported_from present". Or it should drop the
fallback for any contact with `imported_from`, accept the first error, and
say so.

## 4. [LOW] A capped pair's display and sort are undefined

A pair capped at Weak keeps its model score. The sort is "band, then score"
(9.2), so a capped 85 sorts to the TOP of Weak, above genuine Weak pairs,
and its row reads "Weak, 85%". That contradicts section 4's "Sam sees the
pair, at the bottom". Pick one: sort capped pairs last within Weak, or show
the score as capped.

## 5. [LOW] "Only a pair that has a row, because it was sent" mixes two conditions

A listing_sends row exists for un-counted (pending or failed) shares and
for flyer sign-ups (listingSendsRepo.ts:36-43; shareLedgerKeys.ts:8-17). It
is LISTED only when `counted !== false && sentAt` (listingSendsRepo.ts:
231-236). State the reaction rule as "a listed row with a counted send
share", not row existence.

## 6. [LOW] "Select all" today re-applies the server default, which is now "unchecked"

RecipientPreview.tsx:9-15: Select all re-applies checkedByDefault. With
ranked rows unchecked by default (13.1), that Select all would uncheck every
ranked row. Define it for the ranked pool: does it check capped pairs and
tour-held rows (one confirm, or one per row), or skip them?

## 7. [LOW] The never-extracted test's "must write no fact" is too strict for its own list

Section 6.4 allows household size ("familial facts beyond household size")
and B1 adds a maximum tenant portion field. A synthetic "single mother of
three" conversation lawfully yields household size 4. The test should
assert that no fact of an EXCLUDED kind is written, not that no fact is
written.
