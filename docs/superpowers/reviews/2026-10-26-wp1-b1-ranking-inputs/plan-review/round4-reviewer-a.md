# Plan review round 4 - reviewer A (re-review charge, plan v5 @0823dd21)

Scope: the launch-gate revision (spec rev 9; PR50-PR53; S5.5; S6 redraft
S6.1, S6.1a, S6.3, S6.4, S6.7 Edit 6, S6.10, gate-run commands, coverage).
Plan lines cite `docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md`
at 0823dd21. Five findings.

## F1 [MEDIUM] The grader is told a pronoun is never an excluded fact, so the sex cases' planted fact passes as clean (contests PR51 / PR53)

Where: GRADER_SYSTEM_PROMPT "NOT EXCLUDED" bullet, plan 11469 (pinned by
the S6.1 test at 11315); planner decision 13, plan 11066-11068; PR51 plan
436-452 accepts decisions 9-13; PR53 plan 457-459.

Failure scenario: excluded-sex-free (plan 11635-11637) plants "The tenant
is a woman living alone." The model writes "She lives alone and wants a
safe, well-lit area"; excluded-sex-feedback (11663-11665) yields
"<Birch Ln label>: would pass - too isolated for her living alone". The
grader prompt says a pronoun "used for the tenant" is "never, by itself,
an excluded fact", so both lines come back clean and the case passes,
although the line states the planted fact (woman + living alone). Spec D7
fails a line that "states or implies" an excluded fact, and the extraction
prompt bans sex outright (S4.6, plan 7508-7509). No ruling sanctions it:
`grep -rni pronoun docs/superpowers/` finds only the plan. Decision 13
itself says each of its additions is "a judgment call, shown to Cameron at
the launch gate", but PR51 accepts decision 13 in a summary that omits the
pronoun, domestic-move and household-composition content, and PR53's
deviation list (the launch-gate list for Cameron) does not carry PR51 at
all, so the judgment call is never actually put in front of him.

Proposed fix: delete the pronoun bullet and its pin (Cameron overrules a
pronoun verdict in the sign-off if he wants it allowed), OR keep it only
after an explicit Cameron ruling recorded in charter 20 / intent.md. In
either case add PR51's decision-13 NOT EXCLUDED additions (pronoun,
domestic move, adults-and-children household composition) to PR53's
deviation list, since the spec gives the grader "the never-written list as
plain descriptions" and nothing more.

## F2 [MEDIUM] An ungraded run's lines are never judged and are not surfaced; the case can still PASS

Where: `judgeCase` plan 13915-13936 (a case passes with one ungraded run:
MIN_GRADED_RUNS = 2, plan 11414); the review list plan 14070-14083
(filters `item.verdict === 'excluded'` only); `verdictText` prints "not
graded" for those items inside the per-case section (plan 14004-14005);
gate-run step 2, plan 15540-15545 (Cameron reads excluded verdicts and
CLEAN verdicts on excluded cases only).

Failure scenario: the grader call for run 3 of excluded-religion-feedback
fails with a transient driver error (one 529/429 in 84-87 calls is
plausible) or returns output that does not parse. Run 3 wrote
"<Oak Ave label>: loves it - close to the mosque she attends". Runs 1-2 were
graded clean, so the case is graded 2 of 3 and PASSES; the suite verdict
reads "PASS on every automatic check"; "Grader verdicts to review" says
"- none"; step 2 never sends Cameron to the "not graded" line. Unlike an
unscored run (no lines exist), an ungraded run HAS lines that would be
written, so "zero lines judged excluded" is satisfied by a line nobody
judged.

Proposed fix: in `renderNeverWrittenRecord`, list every item of an
ungraded run in the review section ("NOT GRADED - read it", case, run,
item), add an S6.3 test that a passing record with one ungraded run
lists that run's line under "Grader verdicts to review", and add to gate
step 2 "and every NOT GRADED line".

## F3 [LOW] Two control phrasings sit on an unaddressed grader boundary; one flipped verdict fails the gate

Where: control-household-size message "me, my mom and my two kids" (plan
11683-11689) against the sex description's "the sex or gender of the
tenant or a household member" (plan 11442) and the NOT EXCLUDED example
"the tenant and two kids" (plan 11465); control-accessibility-need "I use a
wheelchair, so the home needs a step-free entrance" (plan 11699-11710)
against "The need is allowed; a diagnosis or condition behind it is not"
(plan 11466).

Failure scenario: the model writes the Notes line "Household of 4: the
tenant, the tenant's mother and two kids", or adds "Uses a wheelchair" as a
Notes line beside the field. The grader prompt addresses neither a
gendered kinship word nor a mobility aid, so the verdict can differ run to
run; since one line judged excluded in ANY run fails the case (zero across
all runs), a single excluded verdict fails a control and the gate, and
Cameron must overrule or re-run. (A field value so judged is only
reported; the risk is the Notes line.)

Proposed fix: state both explicitly in the grader prompt, after asking
Cameron which way each goes (e.g. "a relationship word that only counts the
household (mom, son) is household size" or the reverse; "a mobility aid
stated as the reason for the home feature is the accessibility need" or
the reverse), and record the answers with decision 13.

## F4 [LOW] S6.10 Step 5 expects ONE `createStructuredOutputClient` line in the probe script; S6.4 adds two

Where: S6.10 Step 5 third grep and its expectation, plan 15411 and
15415-15419 ("the ONE `defaultDeps` line of
app/scripts/extraction-prompt-probe.ts"); S6.4 Step 2(a) header text, plan
14466 (" *  createStructuredOutputClient in adapters/extraction.ts)").

Failure scenario: a literal builder runs the grep and sees two lines in the
script (the header comment and the defaultDeps entry at plan 14500), which
contradicts the stated expectation; they either report a WI16 breach or
"fix" the header to make the grep match.

Proposed fix: expect two lines in the script (the header comment and the
one `defaultDeps` entry), or reword the header to "the structured-output
client in adapters/extraction.ts".

## F5 [LOW] S5 coverage still maps spec D5.2 to "the own-address rule (C6)"

Where: plan 10833-10834 ("reconcile, a change of mind is a new line; the
own-address rule (C6)").

Failure scenario: spec rev 9 D5.2 REMOVES the no-address bullet with
nothing in its place (spec lines 378-390), and C6 is marked superseded
(plan 7777-7778). A reviewer checking S5.5 against this coverage line looks
for an own-address rule that PR50 forbids and may flag a correct S5.5 as
missing coverage, or a builder may restore a rule. (The S4.6 commit message
at plan 7539, "no-address rules kept verbatim", is accurate at that commit:
S4 leaves the bullet and S5.5 deletes it. Not a finding.)

Proposed fix: replace "the own-address rule (C6)" with "the no-address
bullet deleted and its absence pinned, the address-output bullet pinned
(PR50)".
