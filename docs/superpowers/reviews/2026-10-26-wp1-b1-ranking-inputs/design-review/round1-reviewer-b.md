# WP1 B1 Ranking inputs - design review round 1, reviewer B

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 1)
Charter checked: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
Branch head read: 1d86f59f. Read-only review; nothing run.

Code citations below were read at the cited lines. Claims I could not verify
are marked UNVERIFIED.

Verified as stated (no finding): apply.ts:666 (system note line), apply.ts:713-751
(notes ignore demotion), apply.ts:731-740 (retry guard), contacts.ts:1939-1947
(provenance clear), contactsRepo.ts:286-287, listingSendsRepo.ts:235 (isListed),
shareLedger.ts:205-224 (applyLedgerLoop, MAX_REAPPLY = 3 at :50),
journalSweep.ts:84-86, AiRunDetail.tsx:40-44, unitFields.ts:116 and :359,
schema.ts:8-13, prompt.ts:107-109, adapters/extraction.ts:184, RUNBOOK.md:1465,
routes/aiRuns.ts:257-259, lib/caseworkers.ts:42-82, e2e/scenarios/steps.ts:930,
jobs/extraction.ts:635-636, fake driver bypasses parseExtractionText
(extractionFake.ts: `result: { fields: {}, ...partial }`). The four-type
skip in jobs/extraction.ts:457 confirms extraction runs on tenant and unknown only.

---

## 1. [HIGH] The scalar write/suggest reconciliation is applied unchanged to two ACCUMULATING free-text fields, and the model's 300-char cap is below staff's 500 - a model write overwrites or truncates staff text

What is wrong. D3 says the four fields "follow the existing reconciliation
unchanged: op write when empty or the same fact, suggest when it conflicts".
That rule was built for scalar facts (voucher size, pets, tenure). Two of the
four are lists of facts by their own definition:

- `preferences_constraints`: "anything else the tenant states they want or
  cannot accept in a home (bedrooms beyond the voucher, school, yard, move-in
  date, 'no apartments')" (D3 prompt guidance) - many independent facts that
  arrive over many messages.
- `area_preference`: "neighborhoods, cities, zips" - plural by definition.

A NEW preference on a non-empty field is neither "empty", nor "the same fact in
a better form", nor a "conflict" (prompt.ts:33-41). The model must pick one of
three wrong answers:

- `none`: the fact is lost (it is also not a Notes line - D4 sends only facts
  "that no field ... covers" to noteLines).
- `write`: apply honors the op without checking emptiness
  (apply.ts:299-316 writes whenever `op === 'write'` and the run is not
  demoted), so the stored value is REPLACED by whatever the model emitted. If
  the model drops a staff-typed clause, it is gone, live, with only an
  AutoBadge to show for it.
- `suggest`: one pending suggestion per target (putSuggestion displaces the
  prior one - apply.ts:353-355, noteDisplaced), so each new preference
  displaces the last unaccepted one; accepting writes the WHOLE value.

The caps make the write case strictly destructive: D2 lets staff store up to 500
characters, D3 cuts model values at 300 "at a word boundary" and then WRITES
them. A "same fact, better form" write on a 450-character staff value
therefore silently truncates staff text by a third.

Evidence: apply.ts:299-316 (write path trusts op), apply.ts:343-355 (single
pending suggestion, displacement), prompt.ts:33-41 (the three ops), spec D2
"at most 500 characters", spec D3 "at most 300 characters from the model
(longer is cut at a word boundary)".

What it implies. The build will ship a live writer that can erase staff-entered
matching inputs - exactly the inputs B2's completeness pass and ranker read.
The spec must decide the merge semantics for the accumulating fields (for
example: the model always emits the full merged value; a write on a non-empty
field is demoted to a suggestion; or the model may only append), and must make
the model cap >= the staff cap, or refuse (drop, not truncate) a model value
that would shorten a stored value.

---

## 2. [HIGH] Reactions are written live with no surface where staff can see, verify or remove them; Q3's premise ("visible in the AI run detail's raw output") does not hold

What is wrong. D5 "Read surface": reactions are not on the wire
(`toListingSendRow` unchanged) and "nothing in the dashboard shows them until
B3 ... They are visible in the AI run detail's raw output. See Q3."

The run detail shows `rawText` and `rawResult` verbatim
(dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:87-88). What the model
emits is `{ property: "p2", message: "m5", ... }`. Neither handle is resolvable
from the run record:

- the PROPERTIES SENT block is only fingerprinted (`sentPropertiesFingerprint`,
  D5), so which unit "p2" was is not recorded;
- message handles are added "at prompt assembly" and are NOT recorded (D5:
  `renderUtteranceLine` and the per-message hash stay unchanged), and the
  numbering rule is not specified (see finding 3);
- the run record gains only `reactionsWritten` / `reactionsDropped` COUNTS,
  not what was written where.

So "visible in the AI run detail" means an opaque handle, and Q3 asks Cameron
to accept "shown nowhere" on the understanding that there is a fallback view.
There is none.

The consequence is not cosmetic. The charter's safety story for Notes lines is
"Sam fixes or removes a wrong line by editing the Notes box" (charter 6.4). The
reaction `text` is governed by the same never-written list (D5, charter 6.3),
written live with no approval (charter 6.4), stored on the pair row, and read
by B2's ranker (charter 6.3 "every extracted reaction"). For reactions there is
no view, no edit and no remove path at all - not in B1 and not in B3 per the
spec's own out-of-scope list ("showing reactions anywhere (B3)" names display
only). A reaction that violates the never-written list in production cannot be
found by a person, cannot be removed, and flows into the ranker.

Also: D5 e2e "a reaction lands on a sent pair (asserted through a dev read or
the AI run detail)". The run detail shows MODEL OUTPUT, not the write; it can
never prove the row was written. "A dev read" of a listing_sends row does not
exist today (the only listing-send dev seam is the create-only fixture,
routes/dev.ts:1470-1517); it is an unenumerated new dev surface.

What it implies. Either B1 records the resolved reactions (unitId, sourceMsgId,
kind, text) in the run record so the run detail can show them, or Q3 must be
re-asked honestly ("reactions will be invisible and unremovable until B3"), and
the spec must name the removal path for a wrong or prohibited reaction before
B2 reads them. The e2e assertion needs a named read surface.

---

## 3. [MEDIUM] Message handles are minted inside prompt assembly (in the driver) but resolved in apply - no single owner of the handle map, and the numbering is unspecified

What is wrong. D5: "each transcript line in the PROMPT gains a handle m1..mN
... The handle is added at prompt assembly". Prompt assembly is
`buildExtractionUserContent`, which the anthropic DRIVER calls with the
`ExtractionInput` (prompt.ts:183-196; the job passes only `{ transcript,
profile, orgListBlock }` at jobs/extraction.ts:586). Apply, which must "drop an
item whose ... message handle is unknown" and map a handle to `tsMsgId` and
`at`, never sees the prompt. The job and apply must therefore recompute the same
map independently - the exact divergence renderUtteranceLine's comment forbids
for the hash ("Reconstructing this format anywhere else would guarantee a
permanent false hash mismatch", prompt.ts:169-175).

Unspecified: is m1 the oldest or newest; does numbering follow the
globally-sorted utterance order (prompt.ts:189) or the message list; are
messages with zero utterances (call without transcript, runWindow noContent)
skipped. The fake driver never sees the prompt either (it receives the raw
transcript), so an e2e author writing `EXTRACT:{"reactions":[{"message":"m3"}]}`
must guess the numbering - and the marker message itself is one of the
numbered messages.

Related: "whose message is not a client utterance" is ambiguous for a call,
whose utterances share one handle and mix Staff and Client lines
(jobs/extraction.ts:194-217).

What it implies. The spec must name one pure function that builds BOTH the
p- and m-handle maps from the job's inputs, used by prompt assembly and by
apply (and by the D7 script), define the numbering, and define the client test
for a multi-speaker message (for example "has at least one client utterance").

---

## 4. [MEDIUM] The dedupe key (sourceMsgId, kind) contradicts the spec's own "one item per message per property" and does not stop re-read churn across the 30-day window

What is wrong. Every run re-sends up to 30 days / 50 messages of already-read
messages as reconciliation context (jobs/extraction.ts:493-546; "seen" tier).
So the same tenant message is shown to the model on every later run in that
conversation. The PROPERTIES SENT block shows existing reactions as "kind and
short text" only - no message reference - so the model cannot tell which
message an existing reaction came from. The guard is the dedupe on
`(sourceMsgId, kind)`: a later run that reads the same old message as `maybe`
instead of `interested`, or as `question`, appends a SECOND reaction for that
message and property. The prompt rule says "one item per message per
property"; the dedupe key permits up to four per message per property.

The 50-per-row cap compounds it: dropping the oldest reactions also drops the
dedupe memory for them, so a still-in-window message can be re-read and
re-appended.

Evidence: spec D5 "Dedupe", "Row cap", "Prompt rules"; jobs/extraction.ts:533-546
(seen-tier messages stay in the transcript).

What it implies. Pick one rule and make the mechanism enforce it: dedupe on
`sourceMsgId` per row (one reaction per message per property, matching the
prompt), and/or accept reactions only from post-cursor ("new" tier) messages,
and render the source message handle beside each existing reaction when that
message is in the window. Also decide whether a message older than the
property's first counted send may react to it at all (apply has no such check).

---

## 5. [MEDIUM] The merge gate checks literal banned terms only; "a real-model test proving the never-written list holds" is not what the mechanism proves

What is wrong. D7 pass = "zero banned-term hits across all runs" with
"banned terms (case-insensitive) that must not appear". A paraphrase passes:
the spec's own example "it's close to my mosque" is defeated by "near a place
of worship" or "near a religious center"; "pregnant" by "expecting in March";
a national-origin fact by naming a language or a country's food. The record
"lists EVERY line ... so a person can read them", but the exit code - the gate -
is mechanical, and nothing in D7 requires a person to read the record before
the gate counts as passed.

Second blind spot, within the charter's decision: the charter excludes the four
free-text fields from the list and the test (charter 6.4, amendment 2). The
spec's own prompt makes those fields the natural landing place for an excluded
fact once noteLines are forbidden to carry it ("near my mosque" is a
"preference ... they want in a home", D3), and B2 reads the fields. The test
record does not even list field values, so a reader of the record cannot see
the relocation happen.

What it implies. Either the pass criterion includes a human sign-off on the
listed lines (or a judged check), or the spec stops calling it proof. Within
the charter decision, the record should at least list the four field values
written per case so Cameron sees whether excluded facts moved into fields;
whether to act on that stays Cameron's call (charter section 20).

---

## 6. [MEDIUM] A run whose only output is reactions is recorded `no_op` and reported to staff as "nothing new to extract"

What is wrong. `touched` is `wrote || suggested || notedLines`
(jobs/extraction.ts:639-640) and decides outcome `applied` vs `no_op`; the
`ai_run.completed` event carries wrote/suggested/notedLines only
(jobs/extraction.ts:791-802); `suggestion.updated` fires on the same three
(apply.ts:754-756). The manual-run banner turns zero/zero/zero into "Ran -
nothing new to extract." (dashboard/src/routes/contact/ContactDetail.tsx:1597-1604)
- and that code's comment explains why note lines were added to `touched`: so
the banner would not "contradict the run log". The spec adds
`reactionsWritten` to the run record but touches none of these three
surfaces.

What it implies. Enumerate `touched`, the event payload and the banner copy as
D5 surfaces (or state deliberately that reactions do not count, and accept a
run log that says `no_op` for a run that wrote).

---

## 7. [MEDIUM] The parser caps noteLines at 5 BEFORE the floor exists, so above-floor lines are discarded and the below-floor count is wrong

What is wrong. parseExtractionText filters, then `slice(0, MAX_NOTE_LINES)`,
then clamps (schema.ts:268-273). The floor is a runtime config value and D4
puts it in apply ("Enforced in APPLY, not only in the parser"). If the model
emits seven lines of which the first five are below the floor, the parser keeps
those five, apply drops all five, and the two qualifying lines never reach
apply. `notesBelowFloor` then counts 5, not the true number. Apply also slices
to 5 after appending system lines (apply.ts:720-723). The spec says the
five-line cap is "kept as is" without ordering it against the floor, and
"not only in the parser" leaves it unclear whether the pure parser (which has
no config) filters at all.

What it implies. State the order: floor first, then the per-run cap, in every
place a cap applies (parser and apply), or move the cap out of the parser for
noteLines and reactions.

---

## 8. [MEDIUM] PROPERTIES SENT block: no size budget, no rule for unrenderable or injected text, a missing repo dependency, and unspecified failure handling

What is wrong.

- Budget. 20 properties x up to 50 stored reactions x ~200 characters is about
  200,000 characters re-sent on every run, outside WINDOW_CHAR_BUDGET
  (jobs/extraction.ts:83). The org list block it claims to be "built like" has a
  16,000-character budget and WARNs on drops (orgListBlock.ts:19-23, :34-35);
  D5 names none.
- Unrenderable text. "never containing the word TRANSCRIPT" is asserted but no
  rule says what happens to an address or a stored reaction text that contains
  it (the org block drops such entries as `unrenderable`, orgListBlock.ts:48-52).
  Reaction text is model-written from tenant words and is re-rendered ABOVE the
  TRANSCRIPT header; without newline flattening (the toSingleLine defense,
  prompt.ts:157-167) it is a prompt-injection path that bypasses the transcript
  line discipline.
- Dependency. Each line carries "the address line and city", which live on the
  unit, not the listing_sends row (ListingSendItem, listingSendsRepo.ts:86-126).
  D5 "Dependencies" adds only `listingSends`; the job also needs the units repo
  (worker.ts, routes/dev.ts, test harnesses). A unit that no longer resolves is
  unhandled.
- Failure. A failed org-list read fails the run and burns an attempt
  (jobs/extraction.ts:563-568). The spec does not say whether a failed
  `listByContact` / unit read fails the whole extraction (losing field and note
  extraction for a secondary input) or renders "none".
- Unknown contacts: D5 says they get "no block" while also defining "An empty
  block reads 'PROPERTIES SENT: none'". Which one an unknown contact's prompt
  carries matters to the system prompt text and the fingerprint.

What it implies. Add a budget (for example newest N reactions per property),
the unrenderable/flattening rule, the units dependency, and the failure rule.

---

## 9. [LOW] appendReactions' condition does not match "listed", and the retry check names the wrong predicate

What is wrong. "Listed" is `counted !== false AND typeof sentAt === 'string'`
(listingSendsRepo.ts:235-237). The spec's condition is token AND "`counted`
absent or not false" - no `attribute_exists(unitId)` and no `sentAt` test. With
no token (`attribute_not_exists(shares_op)`) and `counted` absent, an
UpdateCommand on an absent key CREATES an item holding only `reactions`;
setDeclined guards exactly this with `attribute_exists(#unitId)`
(listingSendsRepo.ts:389). Separately, the job's qualifying rule is stricter
than "listed" (a counted NON-flyer share, or legacy); a row whose broadcast
share failed but whose flyer entry still counts stays listed, so "a row no
longer listed is logged and the reaction dropped" lets a reaction land on a
flyer-only pair on retry. The retry must re-apply the qualifying rule, not
only the listed rule.

---

## 10. [LOW] A fresh shares_op on every reaction write adds contention to ledger writers whose flyer loss is never repaired

The charter mandates joining the token protocol (charter 6.3), so this is a
stated cost, not a reversal: each reaction write invalidates any in-flight
ledger read, and a flyer entry that loses its condition past MAX_REAPPLY (3) is
"not repaired (the repair walks broadcast slots only)" (shareLedger.ts:280-287,
:50). Unlikely in practice; the spec's section 4 should name it as a watch item
rather than "every existing token-conditioned writer must re-read and retry ...
as today".

---

## 11. [LOW] Stale statements the spec does not list for update

- RUNBOOK.md:1457 states "additive `notes` appends are not field writes and are
  never demoted" - false after D4. Section 6 names RUNBOOK only for the env var.
- The model-facing prompt says "every one of the eight field entries"
  (prompt.ts:43-44); schema.ts:23 says "The eight client-profile fields". D3's
  count-update list names "twelve"/"eleven" and SWEEP_MAX_ATTEMPTS_PER_CALL but
  not the field count 8 -> 12, and a stale "eight" in the system prompt is a
  contradictory instruction to the model.
- The system prompt's user-message description (prompt.ts:20-23) and the
  transcript line format sentence (prompt.ts:23) both change with the new block
  and the m-handles; D5 does not say so.

---

## 12. [LOW] The D7 model default can silently be a model production does not run

D7: "`--model`, default `AI_EXTRACTION_MODEL`". When that variable is unset,
config falls back to `claude-opus-4-8` (config.ts:888), which is neither
candidate in Q2. A gate run from a shell without the variable passes on the
wrong model. The script should require `--model` (or refuse when the variable
is unset) and print the model in the record.

---

## 13. [LOW] Suggestion chip labels and values for the new fields

SUGGESTION_TARGET_LABEL is lowercase by convention and forms the chip's
accessible name "AI suggestion for <label>"
(dashboard/src/routes/contact/suggestionTargets.ts:1-22); D2 fills it "from the
mirror", whose labels are title case ("Area preference"). The dollars chip will
show the coerced string "1200" while the row shows "$1,200 / month". Minor, but
e2e selectors key on these names.

---

## 14. [LOW] "A later change is a value edit" is not what the mechanism delivers

D1 claims moving a fact to notes is "a value edit"; its own "Why" lists two
edits (the entry and the dashboard mirror). A move also shrinks
EXTRACTABLE_FIELDS, DECISION_TARGETS (display order and historic run decisions
keyed by the removed target), TENANT_ONLY_TARGETS and PROVENANCE_FIELDS, and
leaves stored values and any pending suggestion for that target with no reader.
B1 need not build the move, but the claim should be stated as what it is, and
the spec should say the stored values are then orphaned (or migrated by that
later change).
