# WP1 B2a Ranking engine - design review round 3 (reviewer A)

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md, rev 3 at 985af124
(diff read: `git diff 5b97ac07 985af124 -- docs/superpowers/specs/`). Adjudications: design-review/
adjudications.md, "Round 2". Read-only; no tests, servers or model calls were run.

Each finding is tagged:
- [DECISION]: fixing it changes what gets built, a surface or an invariant.
- [PRECISION]: wording or mechanism detail only.

Severity is the consequence if the spec ships unfixed.

Summary: 2 MEDIUM [DECISION], 5 LOW [PRECISION]. Most of rev 3's fixes hold (see the end). The
two DECISION items are both in rev 3's new material: the seen-set read the new fingerprint
depends on, and the gate's INCONCLUSIVE rule, which rev 3 left untouched while fixing the stage
rule around it.

---

## R3-1. [MEDIUM] [DECISION] The fingerprint now depends on a units batch read the spec leaves best-effort, and no existing reader returns the summary fields

What is wrong. Rev 3's D13 puts `{ unitId, label, summary, declined, tours }` for every
outcome-bearing seen property into the tenant fingerprint. Rev 3's D2.3 says the seen set is read
with "one units BatchGet for the whole set (100 keys per call)". A unit that cannot be found
becomes "a property no longer on file", with the placeholder label, no summary and its feedback
lines back in `notes`.

The only existing units batch reader, `unitsRepo.getDisplaysByIds`
(app/src/repos/unitsRepo.ts:672-688), has two problems here:
- It is BEST-EFFORT by default. Keys still unprocessed after retries, or a chunk whose request
  failed, are dropped with a WARN, and "a short map is a missing LABEL, never an error".
- It returns only `unitId` and `address` (UnitDisplayItem, unitsRepo.ts:653-656). It has none
  of the summary fields D2.3 needs (beds, baths, rent, area, subzone, voucher sizes, pets).

Consequence. One throttled or unprocessed key turns a seen home into the placeholder on that
read only. The tenant fingerprint changes (label and summary differ from the stored hash), and
every match of that tenant reads out of date until the next clean read. The prompt card built by
the job has the same failure, but there it silently changes model input and scoring. This is the
batch-read-absence rule the repo already encodes: `requireComplete` exists for exactly this
reason, and only the extraction PROPERTIES SENT read passes it today (unitsRepo.ts:679-686).

Implies (DECISION: a surface and an invariant). Name a full-item batch reader, or widen the
existing one to return the summary fields. Require `requireComplete` on every seen-set read, in
both the job and the read. Specify that an incomplete read FAILS the job (or the read) instead of
using the placeholder. Keep the placeholder for a key the read completed without finding.

## R3-2. [MEDIUM] [DECISION] The INCONCLUSIVE rule, unchanged in rev 3, now decides the gate; at plausible noise it fires on most runs

What is wrong. Rev 3 replaced the swap rule with a two-stage rule (D17.2). It kept: "measures the
base-versus-base re-run spread for every base pair; when that spread exceeds 5 points the pair's
result is INCONCLUSIVE, which fails the gate as 'decide'". Two problems:

1. "Spread" is undefined: the range of the three base runs, or the difference between two base
   means. It is also unclear whether it is measured per direction (about 12 base measurements:
   6 pairs x 2 directions) or per pair.
2. On either reading it fires often. Take the range of three runs and a per-run standard
   deviation s:
   - The expected range is about 1.7 s, so at s = 3 about half of all base measurements exceed
     5 points.
   - At s = 2 about 10% do, which across 12 base measurements is still about a 70% chance that
     at least one is INCONCLUSIVE.
   - Taking the spread as the difference of two 3-run means, at s = 3 each base has about a 4%
     chance, about 40% across 12.

   The model's real run-to-run noise is UNVERIFIED, but 2-5 points on a 0-100 score is a normal
   expectation.

Consequence. The two-stage rule fixes false FAILS (my R2-4). The gate still exits non-zero as
"decide" on a correct prompt most of the time, so "Cameron decides" stays the normal path of a
merge gate that charter 7.2 made binding. This contests the R2-4 adjudication as incomplete.

Implies (DECISION: the gate rule). Define spread precisely. Apply the stage-two idea to it too:
a base whose stage-one spread exceeds the threshold is re-run (it has eight runs in stage two
anyway), and it is INCONCLUSIVE only if its eight-run spread still exceeds the tolerance.
Alternatively, scale the swap tolerance to the measured base spread. Either way, state the
expected decide rate at the chosen numbers so Cameron reads Q5 with it.

## R3-3. [LOW] [PRECISION] The expiry write is conditioned "on the generation" only, which can fail a job that another process just started

D7 (rev 3): each tick "marks such records failed ... (a conditional update on the generation that
also removes the index keys)". The poll's claim moves a record from queued to running WITHOUT
changing its generation (D7: "conditional update `status = queued AND generation = :listed` to
`running`"; only a takeover mints a new generation). Two ticks can overlap: in the same process,
or in another worker process that listed the record before expiry and claimed it at the boundary.
If they do, a generation-only expiry write lands on a RUNNING job. It marks the job failed and
strips the `rankjobs#running` index keys, while the job keeps running, keeps passing its
generation checks and renewals, and later writes `done`.

The expiry update must condition on `status = queued AND generation = :listed AND
queuedExpiresAt <= now`. The claim must condition on `queuedExpiresAt > now`, so that "the poll
never starts a queued record past its expiry" is enforced by the write, not by the order of
steps within a tick.

## R3-4. [LOW] [PRECISION] The tour projection covers the tenant hash but not the pair-history hash

R2-6 was accepted as "D13: status, outcome, scheduled time only". Rev 3 states that projection
inside the `tenantCard` bullet only. The `pairHistory` bullet still hashes "the declined record
and the tours", with no projection. A stored TourItem's roster, rosterVersion and currentLadderId
(app/src/repos/toursRepo.ts:68-132) change on reminder rungs and roster edits with no outcome.
If raw tours are hashed, that pair reads out of date on every rung. Section 6's "a tour's
reminder or roster change does not" test is written against the tenant hash only. Apply the same
projection to `pairHistory`, and to the prompt's own `tours` (D2.3 "status, outcome and dates"),
so all three agree.

## R3-5. [LOW] [PRECISION] Card key naming is now mixed, and the flag enum depends on which names the property card uses

Rev 3's D2.1 keys the four B1 inputs "by the list entry's `label`, not its attribute name". The
spec does not say how every other card field is keyed (D2.2 says only "fixed key order"). D5's
flag-field enum and the failedRequirements enum are attribute names (`qualifications`,
`no_pets`, ...). The model can only name a field by what it sees on the property card. So the
property card must be keyed by attribute names (or the enum by labels). State the rule per card:
property card keyed by attribute name to match the enums; tenant card by attribute name except
the four B1 inputs by label.

The rev-3 scan exemption is also partly moot:
- The fake driver lives in app/src/adapters/rankingFake.ts (D6). That is outside "the ranking
  directory" the reader test gains, so it is never scanned.
- examples.ts "uses the labels anyway", so it needs no exemption unless its prose spells a key.

Exempting files from a drift test should be the last resort. Better: exempt nothing, have
examples.ts use labels, and have the fake find the two inputs through the list (by `kind:
'dollars'` and the list entry). Then the test keeps policing both files.

## R3-6. [LOW] [PRECISION] Contest R2-2's "no charter amendment needed" for the first-send edge

Rev 3's D13 accepts that "the FIRST send of a property that a Notes line already names ...
changes the fingerprint once". Charter 10.3 says a new send ALONE does not make a match out of
date, and charter 13.5 repeats it ("the send alone does not make the match out of date"). Charter
15.4 lists section 10 as non-reopenable, and the spec header says "a change goes to Cameron and
is recorded in charter section 20". The edge is rare, and the engineering call is sound: the
line's meaning on the card really does change. But the charter's two rules collide here (6.2's
attach rule against 10.3's send rule), and the spec resolves that collision on its own. One line
in section 9 or a section 20 entry closes it. It changes nothing built.

## R3-7. [LOW] [PRECISION] An outcome entry past the bound loses its decline and tours from the prompt, and Q2 does not say so

Rev 3's D2.3: past the bound of 8, an outcome entry "is not listed, and its feedback lines go back
into the card's notes, so no feedback is lost". Its decline and its tours ARE lost from the
prompt, because they live only on the entry. Q2 (rev 3) tells Cameron "feedback on a home past
the 8 stays in the card's general notes", which is true but incomplete. For the pair being scored
the decline and tours still reach the model through `pairHistory` (D2.5). What the model loses is
"this tenant turned down 12 homes" context beyond the newest 8. That is likely acceptable;
Cameron should approve it knowingly. A count of unlisted outcome entries ("4 more homes declined
or toured") on the card would keep the signal at almost no cost; that is a suggestion, not a
requirement.

---

## Rev-3 fixes checked and found sound

- D2.3's bound of 8 with outcome entries first: the prompt is bounded again. With D13
  independent of the arrangement, bare sends, re-sends and evictions stay hash-neutral.
- D13's new content: outcome-bearing entries now carry label and summary, which restores charter
  10.3's "the cards ... change the fingerprint" for everything except send-only facts. It depends
  on R3-1 being fixed.
- D7: a ten-minute queue expiry plus a tick-first "mark expired failed" with index-key removal
  stops dead records from heading the queue (subject to R3-3). The "Waiting for a free slot" copy
  fits the wait.
- D7: a fresh context carrying requestId and no jobRunId gives correlationId = requestId through
  the logger ladder (app/src/lib/logger.ts:248) without breaking the context.ts contract.
- D10: "open only while the field is on the current card" closes landlord flags on switch-off and
  when the property records its own value.
- D11: `cappedAtRun`, computed from the run's own output and the flags open then, plus
  `matchesWritten` set by a second conditional update, resolve R2-10.
- D17's two-stage swap rule: with eight runs the difference of means has standard deviation
  about 0.5 s, and conditioning on a stage-one miss still leaves a per-comparison false-fail rate
  well under 1% at s = 3. That is an adequate fix for the swap test, but see R3-2. "Under ten
  dollars" for stage two included is plausible (UNVERIFIED).
- D2.1: `voucher_program` is excluded with agency's reason, and the registry type in D2.4.1 now
  matches D2.1.
