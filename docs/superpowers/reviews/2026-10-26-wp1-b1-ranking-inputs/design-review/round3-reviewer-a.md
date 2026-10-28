# WP1 B1 Ranking inputs - design review round 3, reviewer A

Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md rev 3
(cf4ce3da), read against the rev-2 diff and the adjudications. Read-only
review; nothing run.

Withdrawing the new-messages-only rule closes my round-2 A1 and A2 for
calls and for transient failures. I accept that. The rest of this review is
the rev-3 material.

---

## 1. [HIGH] D3's two bullets contradict each other, and the "better form" path still lets the model rewrite staff text live

What is wrong. D3 bullet 1: all four fields follow the pets/tenure rule,
"op `write` when the field is empty OR the value is the same fact in a
better form". D3 bullet 2: "A field op on a non-empty text field is only
for a contradiction", "So the model never rewrites staff text". Both cannot
hold. A non-empty field written by a better-form `write` is a field op on a
non-empty field that is not a contradiction.

Apply cannot tell the cases apart. It honors `op === 'write'` whenever the
run is not demoted, with no emptiness check (apply.ts:299-316). It overwrites
the stored value in one batched update (apply.ts:498-500) and stamps `ai`
provenance. A staff-typed 450-character "Preferences and constraints" can be
replaced live by the model's "tidier" rendering, which may drop clauses. The
only trace is the AutoBadge and the `ai_extraction_applied` audit row.

This is round-1 B1's HIGH coming back in a new form. Rev 2's fix was "a write
lands only when the field is EMPTY", which is a mechanism. Rev 3 replaced it
with a prompt instruction, which is a hope.

Implies. Enforce it in apply: a model `write` on a NON-EMPTY text-kind field
becomes a suggestion (no direct write). Keep the scalar rule for `dollars`.
Rev 2 already had this mechanism. Rev 3 only needed to keep it while sending
additive facts to Notes. Then delete "same fact in a better form" for text
fields from bullet 1.

## 2. [MEDIUM] The prompt routes additive facts to Notes lines while D4 still tells the model Notes are for facts no field covers, and accessibility is caught in both rules

What is wrong. D3 bullet 2 sends "a new fact that ADDS to a non-empty text
field" to a Notes line. D4 bullet 1 still defines noteLines as facts "that
no field or other output covers". A second neighborhood is a fact the
`area_preference` field covers, so the model gets two instructions that
disagree. The spec does not give the reconciled prompt wording.

Accessibility is worse. A second need ("also needs grab bars") on a
non-empty `accessibility_need` must, under D3, become a Notes line. D4's
never-written list forbids lines stating "disability or medical facts other
than the stated accessibility need (which goes in its field, D3)". The
parenthesis tells the model accessibility needs belong in the field, never
in a line. The model must break one rule or the other, or drop the fact.

The gate is affected too. D7's disability case banned terms will plausibly
include need words such as wheelchair or stairs. A correct additive need
line would then fail the gate, or the banned list gets weakened to let it
through.

Implies. Write the reconciled wording into D3/D4: Notes lines are for facts
no output covers, OR facts that add to a non-empty text field. Say that a
bare additional accessibility need, with no diagnosis, is an allowed line.
Keep D7's disability banned terms to diagnosis and medical terms, and give
an additive bare-need control case.

## 3. [MEDIUM] Re-reported reactions use up the 5-per-run cap, and new reactions starve

What is wrong. Rev 3 lets any window message react. It relies on the prompt
rule "never re-report a reaction the block already shows" and on writer-side
dedupe. Three facts make re-reports routine, not rare:

- The block shows only the newest 3 reactions per property (D5.3).
  Reactions 4..N, with their messages still in the 30-day window, are not
  shown, so the model re-reports them on every run.
- Dedupe by `sourceMsgId` happens in the writer, against the row (D5.5 and
  D5.6). The 5-per-run cap is applied earlier, in `filterReactions`, "floor
  first, then the cap" (D5.5).
- So already-stored reactions fill the 5 slots, and a genuinely new
  reaction from today's message is dropped, run after run, until the old
  messages age out.

The same order problem exists for Notes lines. The five-line cap
(apply.ts:723) runs before the verbatim retry guard (apply.ts:738-740), so
lines that are already present use up slots. Today that path is rare.
Under the widened instruction and seen-message re-reading it is less rare.

Implies. Give `filterReactions` the qualifying rows' stored `sourceMsgId`
sets (the job already has the rows from `listByContact`) and drop stored
messages BEFORE the per-run cap. The writer's dedupe stays as the race
guard. For Notes, apply the retry guard before the cap. Add a test with 6
re-reported plus 1 new reaction, where the new one is written.

## 4. [MEDIUM] The default-suite gate "branch may not score worse than main on any case" is undefined under sampling noise

What is wrong. D7 now makes the probe's default suite part of the merge
gate: "the branch may not score worse than main on any case". The probe runs
each case `--runs` times (default 5) against a stochastic model, with
verdicts ok, missed, wrong and failed (extraction-prompt-probe.ts:16-35).
"Worse" is not defined: more `wrong`? fewer `ok`? `missed` counted? The
number of runs is not fixed, and there is no tolerance. With per-case
comparison across about 10+ cases at 5 runs each, a one-run difference on
any case fails the gate by chance. A gate that flakes gets waived.

Implies. Define it: a fixed number of runs, the metric (count of `wrong`
plus `failed` per case), and the rule (for example, branch total `wrong`
no greater than main's, and no case going from 0 `wrong` to 2 or more).
Record both runs' raw verdict tables.

## 5. [MEDIUM] Q1's "a reaction is only delayed, not lost" is still not what the mechanism does

What is wrong. Q1 now says a reaction in a demoted window "is only delayed,
not lost, while its message stays in the window". Demotion lasts while the
unattributed call is in the window, which is up to 30 days (Q1(a)). Take a
message sent d days after that call. It is still in the window for only d
more days once the call ages out. Within those d days a run must happen.

Automatic runs need a new client message (`hasNewClient`,
jobs/extraction.ts:517-525). Up to 50 messages are fetched per run
(jobs/extraction.ts:56, :469), so a busy thread pushes the message out
sooner. A reaction stated the day after an unattributed call is therefore
read only if the tenant writes again on day 30 or 31. Otherwise it is lost.
A manual run (no age floor, 200 messages) can recover it if staff press it.

Implies. Q1 is a spec-gate question, so its premise must be accurate:
"delayed, and lost unless a run happens in the short gap after demotion
lifts; staff can recover it with a manual run".

## 6. [LOW] Q3 soft-remove design: projection scope and cap accounting

- `toListingSendRow` is shared by the contact's listings-sent read
  (routes/contacts.ts:1349) and the units recipients and outcome
  re-projection (routes/units.ts:278, :299). "Gains a `reactions`
  projection" would put tenant reactions on the property's Sent-to roster
  and in outcome responses unless the change is scoped to the contact read.
  Say which.
- Removed items stay on the row and count toward the 50-per-row cap with no
  eviction (D5.5). A pair that has had many removals stops recording. Say
  whether removed items count.
- The audit payload copies the removed text, so text that breaks the
  never-written list persists in audit as well as on the row. That is
  acceptable (neither is read by the ranker), but say it.

## 7. [LOW] The floor and the shared filters are not plumbed into the deps the spec names

- `ApplyDeps` carries no config (apply.ts:34-44). The floor must reach
  `applyExtraction` and the probe as a value. D5.7 names only `listingSends`
  and `units` as new deps. Name the floor too. The probe must parse it with
  the same config function, not a literal.
- `coerceField` is module-private (apply.ts:100). "The D3 field coercion"
  that the probe runs needs an export.
- The probe never runs apply's write/suggest reconciliation (the empty
  check, the D3 additive rule), so "every value written to the four fields"
  in the record is really "every value PROPOSED, after coercion". Label it
  that way.

## 8. [LOW] A legacy row's "first send" is its latest send

D5.5 uses "`sentAt` on a legacy row" as the first send. `sentAt` follows the
latest counted share. The ledger's legacy seeding also stamps `countedAt:
row.sentAt` (shareLedger.ts:80-83), so a legacy row once touched by the
ledger has no earlier instant either. A re-sent legacy pair rejects replies
to the original send. This is a known approximation. Say so in one line.

---

## Fixes checked (round 2 items)

- R2 A1/A2 (new-only rule withdrawn): correct. One reaction per source
  message with no eviction keeps re-reads safe. Starvation is finding 3.
- R2 A3 (accumulation): churn and the dismissal bypass are closed. The
  replacement introduces findings 1 and 2.
- R2 A4 (default suite in the gate): right idea, undefined rule (finding 4).
- R2 A5/A6 (pure filters shared by apply and probe; the fake runs them):
  correct. Plumbing is finding 7.
- R2 A7 (first send = earliest counted non-flyer `countedAt`): correct for
  ledger rows (shareLedger.ts:77-84). Legacy caveat is finding 8.
- R2 A8 (`handle?` on the utterance, no new mark): correct.
- R2 A9 (Q3 design): now designed. Scope points are finding 6.
- R2 A10: correct.

## Adjudications

None rejected; I contest none.
