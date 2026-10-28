# WP1 B1 Ranking inputs - design review round 5, reviewer A

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md rev 7
and charter amendment 7 (20f2fd2b), read with
`git diff 5136f332 20f2fd2b -- docs/superpowers/specs/`. Read-only review;
nothing run.

## Leftovers from the fixed shape (checked)

I grepped both files for "reaction line", "reaction word", "reactionLines",
"unmatched", "lowercase", "interested|maybe" and "four words". The only hits
are the withdrawal statements, plus two stale passages (finding 9). Section 4
(surfaces), section 5 (tests), e2e and docs name feedback lines and
`feedbackLines` only. The rev-6 "no address" D7 control and the unmatched
drop are gone, consistently.

## Answers to the coordinator's direct questions

- Does B1 still need the block? Yes. Free-form lines attach in B2 only when
  they contain the exact label, and the block is the model's only source of
  that exact string. Share texts in the transcript, if they carry an address
  at all, do not carry `propertyLabel`'s form.
- Is the 4,000-char budget right? It is harmless but effectively dead. With
  20 rows of about 40-70 chars ("<label> - sent <date>"), the block is about
  800-1,400 chars. The budget path only runs on pathological addresses.
  Keep it as a backstop; nothing to change.
- Is the gate still real? Yes for the never-written list: mechanical banned
  terms plus sign-off, unchanged. The feedback part is a weaker automated
  check (it only checks naming) plus a human read of 9 lines (3 controls x 3
  runs). That is acceptable at this size. Findings 1 and 4 affect what the
  automated half certifies.
- Does the address leak matter? See finding 8. The tenant's own address in a
  line does not change what the ranker sees, because charter 6.1 passes
  addresses whole on both cards. The block does add a new path for the
  address TARGET.

---

## 1. [MEDIUM] labelMatches is an unanchored substring test with no punctuation folding, so it both over-matches and under-matches

What is wrong. D5.1: `labelMatches(line, label)` is "true when the line
contains the label after folding case and collapsing whitespace". The label
ends with ", <city>", which anchors the right edge. The left edge is not
anchored, and punctuation is not folded.

- Over-match. "12 Main St, Decatur" is contained in "112 Main St, Decatur",
  and "2 Oak Ave, Tucker" in "102 Oak Ave, Tucker". A line about 112 Main
  attaches under 12 Main too (D5.4: "A line naming two seen properties
  attaches under both"). Both must have been sent to the same tenant, which
  is plausible within a neighborhood. The same false match passes a D7
  feedback control that names the wrong home.
- Under-match. "123 Main St." vs "123 Main St", "123 Main Street", "#2" vs
  "Apt 2", and "123 Main St, Apt 2, Decatur" (an extra comma) against the
  label "123 Main St Apt 2, Decatur" all fail. The model is told to copy the
  label (D5.2), but nothing checks it did (no shape check, by decision), and
  the count `feedbackLines` only counts successes.
- The over-match check is UNVERIFIED against production data: I did not
  count street-number collisions. The mechanism is certain.

Implies. Require a boundary before the match: line start, or a character
that is not a letter or digit. Fold punctuation (".", ",", "#") and runs of
whitespace the same way on both sides. Add tests for 12 vs 112 Main, "St." vs
"St", and the extra-comma line-2 form. B2 attaches with the same function, so
this is fixed once, in B1.

## 2. [MEDIUM] A missed attach now turns feedback about one home into feedback on every home, and the label is not stable over time

What is wrong. Rev 6 DROPPED a reaction line naming no sent property. Rev 7
keeps every line. Charter 6.2 (amended) says a line that names no seen
property "stays in the Notes section and bears on every property". So every
attach miss (finding 1), every line where the model named the home its own
way, and every line about a home outside B1's 20-row list or outside B2's
newest-first bound becomes general feedback. "Not interested - too far from
work", meant for one home, is read against every candidate.

The label is also derived from the unit's CURRENT address (D5.1), while the
line is frozen text. When staff correct a typo or add a line 2 after
feedback was written (a unit PATCH of `address`, unitFields.ts WRITABLE
`address`), every earlier line about that home silently stops matching and
becomes general.

B1 measures only the matches (`feedbackLines`, D5.3). A run that wrote a
feedback-like line naming no label is invisible.

Implies. This is the cost of the free-form decision and is acceptable
only if it is visible. B1 should:

- record the lines that look like feedback but match no label (for example,
  any appended line containing a street number followed by a word), as a
  run-record count;
- state in D5.4's note for B2 that a label changes when a unit's address is
  edited, so B2 should also match against the label as of the line's date or
  accept the drift knowingly.

## 3. [MEDIUM] "A failed units read FAILS THE RUN" cannot be built on the read the spec names

What is wrong. D5.1 gets addresses from "the units repo's existing BatchGet
projection (unitsRepo.ts:1293)". That method is `getDisplaysByIds`,
documented as BEST-EFFORT (unitsRepo.ts:663-668). It catches a failed chunk
and logs it ("BatchGet chunk failed - keys dropped", unitsRepo.ts:1303-1305).
It leaves unprocessed keys absent after retries (unitsRepo.ts:1306-1310) and
never throws. A dropped key is indistinguishable from "a unit that no longer
resolves is skipped". So a throttled read silently drops properties from the
block, and feedback on them goes unattached (finding 2). Meanwhile the spec
claims the run fails. This is the batch-read absence ambiguity the codebase
already guards elsewhere with `requireComplete` (unitsRepo.ts:271-275).

Implies. Specify a complete read: a `requireComplete` option, or a variant
that throws or returns `{ ok: false }` when any key is unprocessed or a
chunk failed. Fail the run on that result. Add a test that an unprocessed
key fails the run instead of dropping the property.

## 4. [MEDIUM] D7's "no" control contradicts D5.2's rule for feedback about a place

What is wrong. D5.2: "Feedback about a place rather than one home ('doesn't
like that part of town') is an ordinary line; it names a sent property only
when the tenant tied it to one." D7's feedback control for a no is "a no
with its reason ('I don't like that part of town')", and the automated check
passes it only "when a written line names the right property". A model that
follows the prompt and writes a general line fails the control. A model that
names the property passes against its own instructions. Either way the gate
rewards the behavior D5.2 forbids.

Implies. Reword the case so the tenant ties the reason to the home ("No to
the Oak Ave one, I don't like that part of town"), or grade the case as a
general line. Better: keep both cases, one tied and one untied. The untied
case must produce a line that names NO sent property.

## 5. [MEDIUM] Attaching at the line level moves whole staff-typed or mixed lines under one home (charter 6.2 consequence for B2)

What is wrong. Charter 6.2 (amended): every Notes line that names a seen
property is shown under it "and not repeated in the card's Notes section".
`labelMatches` works on a whole line and cannot tell an `[Auto - ...]` line
from a staff-typed one. Staff lines are long and mixed. In "Called 10/3,
prefers 3BR, no stairs; showed her 123 Main St, Decatur", the general facts
(3BR, no stairs) become property-scoped and leave the general section the
ranker weighs against every home. Note also that `notes` is split on line
breaks, so a staff paragraph typed without breaks is one "line".

Implies. This is a charter decision, so I am not re-litigating it, but B1
ships the function contract B2 will use. D5.4's note for B2 should say
this. Options are to attach only `[Auto - ...]` lines, or to keep an
attached line in the general section too, with the choice raised to Cameron
at B2. Without that note, B2 inherits the behavior unknowingly.

## 6. [LOW] Label edge cases are unspecified

- Empty city or empty line 1. `propertyLabel` would give "123 Main St, " or
  ", Decatur". After trimming, a bare ", decatur" matches almost every line
  that mentions the city. Say what happens: no label, so the property is
  left out of the block and never attached.
- "Two rows whose labels are identical are rendered once" (D5.1). If they
  are two DIFFERENT units (line 2 not recorded on either), every line about
  either attaches under both in B2. Say so in the B2 note, or render
  identical labels with a distinguishing suffix.

## 7. [LOW] The fail-the-run rationale names the wrong mechanism and omits a cost

D5.1 justifies failing the run because "the retry guard would then keep that
unattachable line". The retry guard only drops candidate lines already
present (apply.ts:738-740). What suppresses a later, properly named line is
the prompt's reconcile rule (prompt.ts:112-115). With free-form lines, the
model can also still name the home from the transcript, just not in label
form.

Not stated: a persistent listing_sends or units failure now parks the whole
conversation's extraction after MAX_EXTRACTION_ATTEMPTS (jobs/extraction.ts:54,
:759), including field and Notes extraction. Say both.

## 8. [LOW] Address exposure: the line leak does not matter, but the block adds a path into the address field

A tenant's own address in a feedback line changes nothing the ranker sees,
because charter 6.1 passes addresses whole on both cards. The postal filter
(apply.ts:720-722) remains the only mechanical guard, and that is enough.

What is new: every tenant and unknown prompt now lists up to 20 property
addresses ABOVE the transcript. The address target writes directly to an
EMPTY tenant address (apply.ts:414-433). The prompt forbids a sent
property's address there (prompt.ts:126-131), but D7 has no control for it.
Add one: a tenant with no stored address who talks about a sent home must
produce no address op.

## 9. [LOW] Two stale passages

- Spec lines 12-14 say rev 7 "gets no further design-review round (the cap
  is reached)". This round contradicts that; update the status line.
- Charter item 6 (charter :1152) still says "with a `maybe` reaction line",
  and item 7 says it supersedes the shape in item 4 only. Add "and the
  wording of item 6" to item 7, or edit item 6 in place with an AMENDED
  mark as the other sections were.

---

## Charter edits checked for contradictions

Sections 3, 4, 6.2, 6.3, 6.4, 10.3, 13.5, 15.1, 15.4 and 17 are consistent
with each other and with the spec, apart from the item 6 wording (finding 9).
Charter 6.4's label description, "(address line 1, address line 2 when
present, city)", matches `propertyLabel`'s `<line1>[ <line2>], <city>`.
Charter 6.2's "matched with case and spacing folded" matches `labelMatches`
as written. Finding 1 asks that both be tightened together.
