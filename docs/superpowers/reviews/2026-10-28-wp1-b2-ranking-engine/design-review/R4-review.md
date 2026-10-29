# WP1 B2a Ranking engine - design review round 4, final (reviewer A)

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md, rev 4 at d1121031
(diff read: `git diff 985af124 d1121031 -- docs/superpowers/specs/`). Adjudications: "Round 3" in
design-review/adjudications.md. Read-only; no tests, servers or model calls were run.

Result: no new [DECISION] finding. The rev-4 changes hold against their mechanisms. Three
[PRECISION] items remain. One of them (R4-1) concerns the wording of Q7, which already goes to
Cameron: Q7 presents two options when a third exists, and Cameron should see it before he
answers.

---

## R4-1. [LOW] [PRECISION] Q7 offers a false choice; a third option keeps charter 10.3 exact

Q7 (rev 4) says: "Keeping the rule exact would mean leaving that home's label and summary out of
the fingerprint, so edits to a seen home would never refresh the tenant's matches." That is not
the only way. The edge comes from counting an ATTACHED FEEDBACK LINE as an outcome for the
fingerprint (D13: "carries an outcome (a decline, a tour or an attached feedback line)").

Feedback lines are already in the tenant hash through "the Notes box text as stored" (D13). So
the fingerprint could take `{ unitId, label, summary, declined, tours }` only for seen homes
with a DECLINE or a TOUR. Feedback-only homes would still be listed in the prompt (D2.3 is
unchanged), but would not be hashed as entries. Then:
- The first send of a home that a Notes line already names changes nothing, so charter 10.3 is
  exact.
- Edits to declined or toured homes still refresh the tenant's matches.
- The only loss is that an edit to a home the tenant has only talked about (no decline, no tour)
  does not refresh the tenant's other matches.

This changes nothing unless Cameron picks it. Q7 should list it as an option beside "accept the
edge", with that cost stated.

## R4-2. [LOW] [PRECISION] A single incomplete seen-property read hides the whole ranking (503)

D2.3 (rev 4): an incomplete `getManyByIds` read "answers the ranking read with 503". Refusing to
read a short map as "not on file" is the right call (it would change the card and its
fingerprint). But the consequence is broader than it needs to be. On a property anchor the read
does one seen-set read per candidate tenant (up to 150-300). One throttled key among them
withholds every stored score, even though scores and bands do not depend on that read; only that
candidate's `card` out-of-date test does. Charter 10.3 says "an out-of-date list is still shown".

A narrower failure mode keeps the invariant: serve the rows and mark only the affected candidates
"freshness unknown" (or "out of date: read failed"). The job's behavior (fail before any model
call, D7) is right as written, because the cards it would send are incomplete. Rare under the
repo's retries. Decide it in the plan or leave it, but the B3/B4 composer inherits the choice.
Also, the job's message "Could not read every property this tenant was sent" names "this
tenant", which is ambiguous on a property-anchor job with many tenants. It should name the
tenant, or say "a tenant".

## R4-3. [LOW] [PRECISION] D17 does not say which base runs the swap comparison uses

Rev 4 adds a noise check that scores each base as two groups of three runs (six runs, and
sixteen after stage two). The swap rule still says "three runs each of base and variant", and its
stage two re-runs "five more times each". The spec does not say whether a swap compares its
variant against base group A, against both groups (six runs), or against fresh base runs. That
choice changes both cost and the false-fail rate. The natural reading, and the cheapest: compare
against all base runs available for that pair and direction, and never re-run the base for a
swap's stage two when the noise check has already given it eight or more runs. State it, and
recheck "under ten dollars" against the base run count. The cost figure is UNVERIFIED.

---

## Rev-4 changes checked and found sound

- D2.3 `unitsRepo.getManyByIds(ids, { requireComplete: true })`. It is a new full-item reader;
  the existing getDisplaysByIds returns only id and address (app/src/repos/unitsRepo.ts:653-656,
  672-688). The job fails before any model call, because D7 builds every card before batching,
  so no spend is wasted. The placeholder is used only after a COMPLETE read, so the fingerprint
  cannot flap on a transient read. Section 5 now names the new reader.
- One tour projection (`status`, `outcome`, scheduled time) is used for the cards, D2.5's pair
  history and both D13 hashes. TourItem's roster, rosterVersion and currentLadderId
  (toursRepo.ts:68-132) are now out of every hash.
- D7 conditions. The expiry write requires `status = queued AND generation = :listed AND
  queuedExpiresAt <= :now`, and the claim requires `queuedExpiresAt > :now`. The two are
  mutually exclusive on the same record, so a just-claimed job can no longer be failed, and an
  expired record can no longer be started. A press's reclaim (new generation, new expiry) still
  defeats both poll writes.
- D17 noise check. The spread is the difference of two independent group means: standard
  deviation about 0.82 s at three runs and 0.5 s at eight. With the same two stages the
  per-base false INCONCLUSIVE rate is well under 1% at a run-to-run standard deviation of 3, and
  about 25% gate-wide at 5. The gate is usable unless the model is noisy, and when it is noisy,
  "decide" is the honest answer.
- D2.1 keys. The property card is keyed by attribute name, which matches the D5 enums; the four
  B1 inputs on the tenant card are keyed by label. Only examples.ts is exempt from the scan; that
  exemption is harmless but not needed if its cards use labels. The fake driver is outside the
  scan and finds the dollars input by `kind`. Finding "area preference" among three text entries
  still needs its key or label; that is acceptable outside the scan.
- Q2 now states that a home past the bound loses its decline and tours from the card, while its
  feedback stays in notes and the scored pair keeps its own history.
- Adjudications: I contest none. The R2-2 reversal into Q7 is the right home for the edge,
  subject to R4-1's wording.
