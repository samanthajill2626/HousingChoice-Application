# WP1 matching charter - design review round 8 (last), reviewer B

Spec: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md at
c5247b84, read whole and cold. I also read the 734a6e31..c5247b84 diff
and the round-7 adjudications. I compared the slice table against the
round-1 text at 94951d54. Code was read read-only. Nothing else in the
reviews folder was read.

DECISION = changes what gets built, adds or removes a surface, moves an
invariant, or needs Cameron's call. PRECISION = something a slice spec
would settle.

---

## 1. [HIGH] [DECISION] The slice hours have not moved through eight rounds that added most of the build

What is wrong. At 94951d54 the slices were B1 7-9, B2 20-24, B3 9-11 and
B4 11-13 hours, 47-57 in total. At c5247b84 they are B1 6-8, B2 21-25,
B3 9-11 and B4 11-13: still 47-57 against 52 contracted. The only change
is the card fingerprint helpers moving from B1 to B2 (M27). Since then
the body has added, with no hours:

- B1: the never-extracted list and its live-model test over synthetic
  conversations, covering facts and reactions (R2-11, R3-7, R6); the facts
  display, remove control and suppression record (R5-11); keys that make
  retries write nothing (R5-8); version-conditional writes and a bounded
  list (R7); reactions that join the `shares_op` protocol on listing_sends
  (R2-7, R4-4); `AI_MATCHING_FACTS_ENABLED`. B1 now has fewer hours than at
  round 1 while carrying UI, a new write protocol and a paid test harness.
- B2: the whole job architecture, which was a single "one ranking in
  flight per anchor" sentence at round 1. It is now its own poll loop,
  byEntity queued and running families, claim generation, queued expiry,
  lease renewal, one takeover then failed, and carried correlation and
  trace restore (R3-2, R4-2, R5-1, R6, R7). B2 also gained the cap with
  the cap-eligible list; accommodation and unlawful flags with a
  property-level hash-closing record and admin Dismiss; the counterfactual
  check on synthetic pairs; review records as their own records; the
  runtime allowlist with its classification test; base-table reads after
  done; a failed-batch list; the version rule; and `AI_RANKING_ENABLED`.
  All of that cost one hour.
- B4: unchecked selection defaults with a Select all rule, hand-picks kept,
  the tour-hold chip and confirm, the old-filter-draft path, the partner
  flow kept, the Similar relabel, and the property-record flag display
  (7.2, "B4"). Hours unchanged.

What it implies. A1 section 7: "Developer will notify Client promptly if
the actual or projected hours for any work package begin to exceed its
estimate". On this evidence the projection exceeds 52. Cameron has two
options: cut scope back to the contracted description (the 17 list shows
where the charter reaches beyond it, for example the WP3 reaction reading),
or re-estimate the slices and notify Sam before B1 starts. Leaving the
table as it is carries an estimate the body no longer supports into the
gate.

## 2. [MEDIUM] [DECISION] The rubric's forced-Weak rule is wider than the cap, so move-in costs and touring still force Weak

What is wrong. Section 4: "A tenant who fails a recorded requirement (no
evictions on program, no pets, a free-text note) ... the rubric tells the
model to land that pair in the Weak band"; 7.2 repeats "the demotion rule
for recorded requirement failures". Deposit, application fee, pet fee,
tour type and tour process are recorded requirements in the registry
(lib/requirements.ts:85-108). R5-2 decided that move-in costs and touring
"never cap" (7.4) so that being unable to pay a deposit is not a forced
Weak. But only the CODE cap was narrowed. The rubric still tells the model
to put a deposit failure in Weak, so it lands there by score anyway. 7.4's
"so the cap can never enforce a requirement the rubric disregards" covers
credit and income only. The rubric never disregards move-in costs.

What it implies. Limit the section 4 and 7.2 forced landing to the same
cap-eligible keys (evictions, qualifications, pets). Move-in costs and
touring become inputs the model weighs, like a declined send. As written,
R5-2's fix is half applied.

## 3. [MEDIUM] [DECISION] An unlawful flag on a checkbox requirement can never be cleared, so one model error removes that cap for good

What is wrong. 7.2 (round 7): an unlawful flag closes on read when the
field's text no longer matches its hash, Dismiss is display-only, and "A
requirement Sam believes lawful is made to read lawfully by editing its
text". Two of the five cap-eligible keys are checkboxes, `no_pets` and
`no_evictions_on_program` (requirements.ts:71-73, 88-90), and a stored
checkbox is always `true`. There is no text to reword. Unchecking it
removes the requirement. Re-checking it restores the same value, the hash
matches again, and the flag is open again, because the state is derived
from the hash on every read. So if the model once calls "No pets" unlawful
(an easy confusion next to the assistance-animal accommodation, 7.2), the
No-pets cap is gone for that property for as long as the requirement
exists, and Sam has no remedy.

What it implies. Pick one:

- (a) An unlawful flag may name only a free-text field. The two checkboxes
  are lawful categories by construction, and their per-tenant exceptions
  are what ACCOMMODATION exists for.
- (b) An admin "lawful" ruling for structured keys only, which restores
  the cap.

Option (a) needs no new control and matches R7's "never tell the model to
apply what it judged unlawful", because the model would never be allowed
to judge a checkbox unlawful.

## 4. [MEDIUM] [DECISION] Section 15.4 does not protect the compliance decisions the body now depends on

What is wrong. Section 0 says a slice "may NOT reverse" a charter decision
but points to 15.4 as "the list of decisions that may not be reopened",
which implies everything else may be. 15.4 lists 4, 5, 6.1, 7.1, 8, 9, 10
(pair rows, on demand, fingerprints, one button), 11, 12, 13.1 (one
composer, two anchors), 14 and 15.2. It leaves out:

- 6.4: the never-extracted list and test, and the facts switch;
- 7.2: the fair-housing rules, the credit-or-income rule, examples written
  from scratch, and the counterfactual that blocks enabling;
- 7.4: the cap and its key list;
- 6.3: hard_no does not set a decline in WP1;
- 10.2: no SQS queue, and the takeover cap;
- 13.1: the unchecked default and the Select all guard against re-texting
  decliners.

Under the hour pressure of finding 1, these are the decisions a slice is
most likely to trim, and they carry the fair-housing, A1 and TCPA
obligations.

What it implies. Add them to 15.4, or have section 0 say plainly that
every charter decision is non-reversible and 15.4 only highlights some.

## 5. [LOW] [PRECISION] The counterfactual must pass before the switch is first turned on, not "before Sam's acceptance pass"

7.2 runs the counterfactual "before Sam's acceptance pass", which comes
after B3 and B4 (12). But 11 has the engine "live-tested in production
before the composer views exist", which needs `AI_RANKING_ENABLED` on in
production during B2, and 7.2 says a failed check blocks exactly that
switch. Say: before `AI_RANKING_ENABLED` is first turned on in production.
Also name what triggers a ranking on the Rankings page during that live
test. 10.2 says Rank is pressed "in the composer", which does not exist
until B3, and no slice owns a Rank control on the Rankings page.

## 6. [LOW] [PRECISION] The slice rows miss surfaces the body assigns

- The property-record flag display is "(B4)" in 7.2, but it is not in
  B4's row. The admin Dismiss control appears both on that record and in
  the composer, but the only owner listed is B2 ("the record with
  Dismiss").
- The switch-off composer (10.2: unscored pool, no Rank button) is in
  neither B3's row nor B4's.
- 6.4 does not say whether reactions sit behind `AI_MATCHING_FACTS_ENABLED`,
  or whether a reaction failure in B1's test blocks reactions as well as
  facts.
- 6.4 does not say what happens when a version-conditional facts write
  loses. It should re-read and re-apply, never drop a live fact. It also
  does not say what the bound on the list evicts.

---

Round-7 fixes checked: the hash-closing flag record and display-only,
admin-only Dismiss are coherent for free-text fields (finding 3 is the
checkbox gap). The running records in the poll family, ordered by lease
expiry, make takeover findable. One takeover and then failed, with the
attempt count stored, matches the extraction precedent
(extractionRepo.ts:78, 169-192). Version-conditional facts writes close
the remove race. The switch-off composer is defined. No other
contradictions found on the cold read.
