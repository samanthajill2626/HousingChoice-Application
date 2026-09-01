# Spec adversarial review - round 4 adjudications (TERMINAL)

Reviewer A, continued. Report: `spec-r4-reviewer-a.md`. 10 findings, an
audit, and one item addressed to the human.

**Verdict: TERMINAL.** The reviewer was asked to state explicitly whether
the round changed a decision, and answered (A): every finding is a
determinate one-line completion, none needs a person to settle. Under the
skill's stop rule a round of precision edits alone is the terminal round -
fold them in and stop. **No round 5.**

**Outcome: 10 ACCEPT, 0 rejected.** All ten applied to the spec (now v5).

## Accepted

| # | finding | verdict |
|---|---|---|
| 1 | The retry BOUNDS (4 attempts, `attempt * 250ms`) existed in v2, were lost when v3 replaced the Mechanism section, and v4 never restored them - the shared helper has no specified attempt count or backoff anywhere | ACCEPT. A regression introduced by my own rewrite and missed by two rounds, including the one that audited for exactly this. Restored verbatim. |
| 2 | Answer to my question (b): the hook contract IS behaviourally identical for `db-update-gsis` (`:97-100`), but the local-endpoint GATE is not - `ensureGsis` is ungated today (`:200-242`; the guard is on the CLI at `:261-270`) and v2's reconciling sentence was dropped in v3 | ACCEPT, and it answers the thing I said I was least sure of. Moving `ensureGsis` onto the shared helper puts it behind the endpoint gate for the first time. That is a tightening and is now stated as intended, with acceptance case 8 pinned to a LOCAL endpoint so the case cannot pass for the wrong reason. |
| 3 | The verification hook's RETURN contract is still unspecified after three revisions - only the throw case is defined, so a builder could invert fail-closed into fail-open while satisfying every sentence | ACCEPT. Full four-row table added (`true` / `false` / throws / absent). Three revisions defined what happens when the hook fails and never what happens when it succeeds. |
| 4 | The positive control that replaced the decoy can itself pass vacuously - `express.static` misses fall through to a 200 SPA shell, so a status check is satisfied by the exact regression it exists to catch | ACCEPT, and it is the sharpest finding of the round: the replacement for a vacuous assertion was itself vacuous. It must assert the asset's BODY. |
| 5 | The fixture's NEGATIVE content constraint is missing, and dropping the decoy made it load-bearing - the traversal assertions now read the fixture's own `index.html`, which must not contain `"version"`, `"private"` or `root:`. Raised as B20 in round 1 and never reached the document | ACCEPT. A round-1 finding that survived four revisions because each rewrite re-derived the section from the previous one rather than from the findings list. |
| 6 | The newly specified poll-exhaustion path has no acceptance case - the same gap that created case 5 | ACCEPT. Added as case 10. Specifying an error path without a case for it is how the original inertness hole appeared. |
| 7 | Two v4 rules meet on `dynamoAdmin.ts:128-131` and appear to disagree - `DescribeTimeToLive` is "covered" as the pre-send guard and "never retried" as the hook | ACCEPT. They are two call sites, not one contradiction; now said so explicitly. |
| 8 | Answer to my question (a): KEEP the probes - they pin OUR composition, not `send`'s internals - but v4's own paragraph argues the opposite, and two of its facts are wrong (`send` decodes, not Express; the observable is the 200 fallthrough, not a bare 403) | ACCEPT. Both facts corrected and the paragraph now argues for keeping them, which is what the surrounding decision already did. A rationale that contradicts its own conclusion is worse than none. |
| 9 | The 10s poll ceiling is justified against "a 60s hook budget per call", but `importApply:75-77`, `groupConvert:122-124` and `globalSetup:117` (~23 tables) call `ensureTable` in LOOPS | ACCEPT. The ceiling is now argued from DynamoDB Local's own 10s lock timeout, which is per-operation and does not divide. |
| 10 | Residual: case 8 is two cases under one number; case 7 pins the predicate rather than the integration and should say so | ACCEPT. Split into 8 and 9; case 7 relabelled as the positive half of the gate proof. |

## The audit (finding 11)

All ten round-3 accepts implemented in substance, two better than asked -
the decoy dropped rather than relocated, and the fail-open sub-case added
to case 8. Findings 1 and 2 are older regressions from v3's rewrite that
the reviewer notes it failed to catch in round 3.

That failure mode is now the round's most transferable lesson and it
appears three times (findings 1, 2 and 5): **each revision was written from
the previous revision rather than from the findings list, so accepted
content silently fell out.** Round 1's B20 survived four revisions this
way. A rewrite is not a safe operation on a document that has already been
adjudicated.

## Raised for the human, not a spec defect (finding 12)

The reviewer flags that item 1A has no recorded sighting to cure, and item
1D forbids a mixed contended/quiet pair from closing the anchor - so **the
most likely honest outcome is that the anchor issue stays OPEN**, while the
two mediums close cleanly. Locked decision 1 says "close on evidence", and
this is what that decision looks like when the evidence does not arrive.

Added to the spec's Deliverables as a stated expected outcome, and raised
with the human directly rather than left to surface at handback.

## Convergence

| round | reviewers | findings | accepted | decisions changed |
|---|---|---|---|---|
| 1 | 2, independent | 45 | 45 | yes, all three items |
| 2 | 1, continued | 18 | 18 | yes, incl. one BLOCKING inversion |
| 3 | 1, continued | 10 | 10 | yes, three |
| 4 | 1, continued | 10 | 10 | **no - TERMINAL** |

Monotone decline in both volume and consequence, ending in a round of pure
precision. Design review closes here.
