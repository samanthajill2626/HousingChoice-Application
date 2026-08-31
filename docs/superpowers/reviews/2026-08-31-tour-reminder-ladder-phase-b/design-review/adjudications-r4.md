# Spec design review - round 4 adjudications (TERMINAL)

Continues R1/R2/R3. Reviewer B continued a third time.

**7 findings - 7 ACCEPTED. NO BLOCKING. Nothing reversed a decision.**

## This is the terminal round

The stop rule is "a round of precision edits alone is the TERMINAL round - fold
them in and stop." That is this round. No finding altered what gets built, added
or removed a surface, or moved an invariant; all seven are corrections to how
rulings were STATED, plus one readability call.

Both mechanism-interaction questions I put to the reviewer came back clean: the
widened supersession predicate (6.2) and the past-tour gate (6.1a) do not
disagree about any input, and neither makes the other unreachable. Those
derivations are in the report.

| round | BLOCKING | HIGH | total | new design directions |
|---|---|---|---|---|
| R1 (two reviewers) | 3 | 6 | 19 merged | 2 |
| R2 | 2 | 4 | 14 | 2 |
| R3 | 0 | 4 | 13 | 0 |
| R4 | 0 | 1 | 7 | 0 |

## R4-1. ACCEPT [HIGH] - the precedence list named the wrong gates

6.1a listed only gates from `:956` down, so "most-specific first" naturally puts
the new gate BELOW `supersededInBatch` (`:888`) and `isQuietTime` (`:910`) - the
two that actually run first.

Below `supersededInBatch` the gate creates a NEW panel falsehood on the routine
path it exists for. On a post-tour catch-up batch both `morning_of` and
`en_route` are due and both are past-tour; `supersededInBatch` carries no
armability check, so `morning_of` is retired "superseded by a later reminder"
citing an `en_route` the gate then retires "the tour had already happened".

**Section 12's disposition of ledger item 8 survives** - its criterion is cost in
MESSAGES, and a per-tour gate kills both rungs identically, so nothing is lost.
What does not survive is its REACHABILITY estimate: the chip-level instance would
need only worker downtime, not the three-way coincidence section 12 describes.
Placing the gate first closes it for free.

**Spec change.** Full five-gate precedence table, past-tour gate FIRST, with the
`supersededInBatch` and `isQuietTime` reasoning stated.

## R4-2. ACCEPT [MEDIUM] - the sweep and the gate disagreed about the same row

6.1a narrowed the gate's predicate to rungs whose dueAt precedes the tour;
section 4.2 population A still said "any kind". Two enforcements of one rule that
disagree.

**Spec change.** Population A carries the identical predicate, and the spec asks
the plan to pin the agreement with a SHARED helper rather than two hand-written
conditions - which is the only durable fix for a rule enforced in two places.

## R4-3. ACCEPT [MEDIUM] - the force-send exception was a name in a list

6.1a's force-send rule hard-coded "EXCEPT `no_show_checkin`" - the exact style
its own poll rule had just been rewritten to reject - and the exception is
unreachable today, since `no_show_checkin` is never auto-armed.

**Spec change.** Force-send uses the SAME predicate as the poll gate. An
unreachable hard-coded exception is one that rots unnoticed; a derived one stays
correct if that ever changes.

## R4-4. ACCEPT [MEDIUM] - site 6 is the one site nothing enforces

`SEND_NOW_ERROR_COPY` is a `Record<string, string>` with no completeness test, so
a missing entry compiles and ships. Sites 1-5 fail loudly if forgotten; site 6
does not, and it is the one whose generic default 4.3 calls ACTIVELY WRONG.
Presenting a six-site inventory implied enforcement that does not exist.

**Spec change.** The plan adds a completeness test for it, modelled on the label
test in `dashboard/src/api/types.test.ts`.

## R4-5. ACCEPT [MEDIUM] - "above the shared ladder" was ambiguous where it matters most

3.1a said discontinued is "evaluated ABOVE the shared suppression ladder" without
saying where in the code. `suppressionOf` is only BUILT for `self_guided` tours
with an upcoming rung (`routes/tourReminders.ts:506`), and `:576-584` already
documents that a kind-level fact routed through it is lost for every
group-routed tour. So the ambiguous reading reintroduces "sending shortly" on
landlord-led tours - the tours most likely to have a relay group.

**Spec change.** Stated precisely: the same position as today's `paused`
fallback, at `:590-597`, as a branch ahead of the `suppressionOf !== undefined`
test - not threaded through the evaluator the way `paused` is.

## R4-6. ACCEPT [MEDIUM] - the spec had become an argument with its own drafts

51 lines carried review back-references, and two passages stated a withdrawn rule
in full beside the live one. Four rounds of adversarial editing produced a
document that is correct and hard to read - and the records are committed
separately, so the spec does not need to carry the archaeology.

**Spec change.** All inline `(design review Rn, Mn)` tags removed; a single
provenance note in the header points at this directory. The
withdrawn-rule-in-full passages are rewritten as forward instructions ("do not
simplify this to cover all kinds, because...") rather than as accounts of what a
previous draft said. Where an "earlier draft" note warns a reader off a
NATURAL-but-wrong reading it is kept - that is instruction, not archaeology.

## R4-7. ACCEPT [LOW] - absent vs unparseable `scheduledAt`

The gate's absent-`scheduledAt` rule should read "absent OR unparseable". The
present-but-unparseable case exists in fixtures and today only behaves by
lexicographic accident, so the gate must test parseability rather than presence.

## Loop closed

Four rounds, one reviewer continued across three of them. 53 findings total,
51 accepted, 1 split, 1 conceded by the reviewer, 0 rejected outright.

The reusable lesson, which held in R2 and R3 and finally stopped in R4: the
worst findings of each round were in mechanisms invented during the PREVIOUS
round's adjudication. Adjudication writes new, unreviewed design under time
pressure and is the least-reviewed text in the document. A review loop that
stops after one round ships exactly those defects.

Next: the human's spec gate.
