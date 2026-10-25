# Whole-spec re-read (planner, 2026-10-25)

Cameron asked (2026-10-24) to "relook at the spec as a whole" before the
adversarial review: "Let's see if there are any questions or things that we
missed, or ways that we can make it better and more efficient." This is the
planner's pass over the charter at commit 18445409, after replaying the
whole conversation. Nothing here is folded in yet; each item waits for
Cameron's call.

Code facts checked for this pass:
- last_heard_from_at is written on every attributed inbound message
  (app/src/lib/heardFrom.ts:1, one shared rule for every writer).
- Extraction applies each target as op write / suggest / none; a suggestion
  waits for staff (app/src/services/extraction/schema.ts:58,
  app/src/services/extraction/apply.ts:318).
- No fair-housing guidance exists anywhere in the repo (grep, 2026-10-25).

## A. Decisions for Cameron (each changes what gets built)

A1. Fair housing. The tenant card carries the tenant's name, and nothing
tells the model which characteristics it must never weigh. A name can proxy
race, national origin or sex. Proposal: names out of the cards (the model
sees per-call handles); the rubric states that protected characteristics
(race, color, religion, sex, national origin, familial status, disability)
never lower a score, the one use of disability being a tenant's own stated
accessibility need matched to the property; a landlord requirement note that
targets a protected class (for example "no kids") is not applied and is
flagged on the row instead. Sections 6.1, 7.2.

A2. Section 4 forces "Not interested" into the Weak band, alongside
requirement failures. That contradicts round 5: a "maybe, but show me
others first" must be able to "bubble up to the top after a while".
Proposal: only a recorded requirement failure forces Weak; Not interested,
an unmet accessibility need and a rent gap over the stated portion are
strong reasons against, weighed by the rubric. Sections 4, 7.2.

A3. Time-varying inputs either churn or freeze the fingerprints.
- last heard from changes on every inbound text, so every match with that
  tenant would go out of date after each message.
- time since the last send never changes the fingerprint, so a "maybe"
  never rises unless something else re-scores it.
- section 9.1 puts last heard from on the tenant card only on the property
  anchor, so the same pair is scored from two different cards depending on
  direction, which breaks "one match per pair".
Proposal: one tenant card in both directions; recency enters as a bucket
(this week / this month / one to three months) and only the bucket is
fingerprinted; a send is fingerprinted by its date, outcome and extracted
reaction; the 7-day full re-rank offer (drift guard) is the stated
mechanism that lets elapsed time move a score. Sections 6.3, 9.1, 10.3.

A4. Sam's reviews expire and get overwritten. The 180-day TTL deletes a
reviewed row, and a re-score overwrites it, yet reviews are named as the
source of future examples. Proposal (promoted from the B2 note): a review
keeps the score and rubric version it judged and survives a re-score
("reviewed at 62, now 71"); a reviewed row does not expire. Sections 10.1,
12.

A5. Matching facts: live or suggested. Section 6.4 sends them "through the
existing suggestion flow", where each one waits for Sam to accept. With an
open-ended list that is a queue she will not keep up with, and pending facts
would not reach the ranker. Proposal: facts are written live with their
source message, shown on the record, and dismissible; a dismissed fact is
never written again. Section 6.4.

A6. Anchor eligibility is unstated. The pool rules apply to candidates; the
charter does not say what happens when Sam presses Send property on an
onboarding tenant or a property still in setup. Proposal: any anchor can be
ranked; the composer shows a banner when the anchor itself is not searching
or not available. Sections 5, 13.1.

A7. Tenant address. Section 6.1 passes it as city and zip only; that was a
planner instinct, not a decision, and it runs against "include everything".
Proposal: pass the address whole; leave phone and email out as having no
matching value. Section 6.1.

## B. Efficiency

B1. Insertion calls are nearly as expensive as a full ranking. Section 10.3
sends every other candidate with its score as context; on a property with
199 tenants that is most of a full call's input to score one tenant.
Because scores are absolute against the rubric anchors, the context only
needs a calibration sample: about ten existing matches spanning the bands.
Also name prompt caching: the rubric, examples and anchor are a shared
prefix across batches and insertions. Sections 7.1, 10.3, 14.

B2. Fingerprint helpers move from B1 to B2. B1 has no card definition to
fingerprint; the cards are defined in B2 by the exclusion list. B1 7-9
becomes 6-8, B2 20-24 becomes 21-25. Section 15.1.

B3. The release valve for B2. If B2 runs long, the Rankings page moves to
B3; the cost is no production view of the engine before the composer.
Named in 15.1 so the B2 planner does not invent a different cut.

## C. Precision edits (fold in unless Cameron objects)

C1. State that scores are absolute against the rubric anchors; the listwise
call buys consistency and cost, and batching and reuse across directions
rely on it (7.2).
C2. Two sort orders, one per anchor; 9.2 mixes them. Property anchor: band,
score, last heard from. Tenant anchor: band after priority strength,
priority, score. Pool members with no match yet show "not ranked yet" at
the bottom.
C3. Rank scores only pairs with no current match; Update re-scores flagged
ones; a full re-rank is its own explicit action (10.2, 10.3).
C4. Drift guard source: "the newest full ranking" per anchor is read from
the run log. The limit counts both candidates changed now and insertions
since the last full ranking, as round 4 had it (10.3).
C5. A candidate the model did not return, or a failed batch, gets no match
and shows "not scored, retry"; never a default score. candidateId values
are per-call handles mapped in code, since ids are excluded from cards
(7.4).
C6. Section 13.5 contradicts 10.3: a send changes the pair-history
fingerprint, which 10.3 flags as out of date, while 13.5 says it shows "as
sent, not stale". Resolved by A3's fingerprint rule plus the chip being
derived on read.
C7. One ranking in flight per anchor, so a double press does not double
spend (10.2).
C8. The priority boolean is set on the property edit form and shown on the
record (B1, 9.2).
C9. Run log retention is 90 days, pair rows 180: an older match's runId can
point at an expired run. Accepted; say so (11).
