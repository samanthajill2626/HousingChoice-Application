# WP1 B2a - Cameron's real-model runs (the merge gate)

B2a is handed back "merge-ready PENDING Cameron's real-model runs" (plan
PR1, spec D17): no agent ran either script against a model, read the
testing key or wrote the record. Run them at the end of the build, before
merge. They never stop the build; a failure blocks the merge (and with it
every production ranking) until it passes or you decide (charter 7.2).

- Branch `feat/wp1-b2-ranking-engine`, worktree `W:\tmp\wp1-b2-ranking-engine`,
  measured at commit `45fc3326` (the last code commit, after the planner's
  fix wave PFW1; every later commit on the branch is records or docs only.
  PFW1 changed no rubric, example, schema, card or prompt byte, so the
  fingerprint below is unchanged from 7fb7b723). Any rubric, examples,
  schema, card or model change after a passing run needs a new run.
- Prompt fingerprint
  `33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9`
  (rubric r1, examples e1); the dry run prints the one you are about to
  measure. Re-checked by the orchestrator's dry run (key unset) at 11fd9407
  (2026-10-29) and again at 2c4894ad after PFW1 (2026-10-30): the same
  fingerprint, 28926 system characters, stage one 414 calls (estimated
  $16.80), stage two at most 660 more (at most $26.78).

## Before you start

- Run from the feature worktree (it has its own `node_modules`).
- Check `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are NOT set. The
  counterfactual check prints the endpoint host it will use and whether a
  token is set; the compile check prints no such line (its SDK still honors
  `ANTHROPIC_BASE_URL`). So read it on the dry run, the first command, which
  runs in the same shell as the compile check: it should say
  `endpoint default; ANTHROPIC_AUTH_TOKEN set: no`. If it does not, clear
  the one that is set for this shell (`Remove-Item Env:ANTHROPIC_BASE_URL`,
  `Remove-Item Env:ANTHROPIC_AUTH_TOKEN`) and run the dry run again.
- Run the commands one after the other, never in parallel.

## The commands (PowerShell, one per line)

```powershell
cd W:\tmp\wp1-b2-ranking-engine
npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --dry-run
$env:ANTHROPIC_API_KEY = '<the TESTING key>'
npx tsx app/scripts/extraction-schema-compile-check.ts --model claude-sonnet-5-5
npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --out docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/counterfactual-check.md
npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --timing --out docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/counterfactual-check.md
Remove-Item Env:ANTHROPIC_API_KEY
```

1. The dry run is free (no call, no key read, nothing written): it prints
   the suite, the planned stage-one calls (414) with a cost estimate, the
   worst-case stage-two count (660) and the prompt fingerprint. Read it
   before spending. On this build its plan lines read:

   ```
   Planned calls, stage one: 414 (estimated $16.80 on claude-sonnet-5-5)
   Stage two, only for misses: at most 660 more calls (estimated at most $26.78)
   Dry run: no call made.
   ```
2. The compile check is five tiny calls; all five must say COMPILES (exit
   0) before the paid runs - both `ranking-off` and `ranking-on` included
   (the ranking schema with `RANKING_LANDLORD_CARD` off and on). Run it on
   `claude-sonnet-5-5` only: it compiles through extraction's thinking-off
   client, which `claude-opus-5-5` does not accept, so it CANNOT validate
   opus (FB23). If you ever move ranking to opus, the counterfactual check
   run with `--model claude-opus-5-5` is the only validation of its
   grammar.
3. The counterfactual check is the gate: exit 0 is PASS; exit 1 is FAIL or
   DECIDE (the record's verdict line says which); exit 2 is a usage error,
   no key, or an `--out` the record cannot be written to. It APPENDS a
   dated section to the record; the latest full section counts. Before the
   first call it checks the record: the directory must exist and the file
   must open for append (a missing file is created empty), or it exits 2
   having called nothing. If the append still fails after the calls, it
   prints the verdict and then the whole record to the terminal and exits
   1, even on a PASS: paste that into the record file - the paid run is not
   lost.
4. The timing run scores one synthetic 40-candidate batch three times, one
   call at a time, and appends a "Batch timing" section (latency and
   tokens) to the same record; exit 0 when all three calls answered, else
   1. It is not a gate; B3 uses the number for its loading pattern.

## Calls and cost (rough; the dry run prints the estimate for your build)

| Command | Calls | Est. cost on claude-sonnet-5-5 ($2 / $10 per MTok) |
|---|---|---|
| compile check | 5 | cents |
| counterfactual, stage one | 414 (6 pairs x 2 directions x (6 base runs + 9 swaps x 3) + 3 controls x 2 directions x 3) | about $16.80 by the dry run's estimate (spec D17: 10-20 dollars) |
| counterfactual, stage two | only for misses: at most 660 more | scales with misses; at most about $26.78 |
| timing | 3 calls of 40 candidates | about $0.15 estimated; under $0.60 even if every call writes its whole 16,000-token output budget |

## Reading the record

1. The Verdict line: PASS; FAIL with each reason (an ungraded run, a swap
   beyond the tolerance, a control not met); or DECIDE (a base pair whose
   own runs spread more than 5 points - its swaps are reported but do not
   decide; you decide).
2. Per base pair and direction: group A and group B scores, the noise
   spread, and one row per swap (stage, base and variant scores, mean
   move, base and variant cap COUNTS, verdict). The record holds every
   run's score and each group's cap count; a swap row carries no per-run
   cap and no flags, so an unexpected flag on a base or variant run does
   not appear in it. A band change within 5 points is never a failure.
3. Controls (per control and direction: every run's score, how many runs
   raised the expected flag, how many were capped): C1 (assistance animal
   against No pets) must be graded in all three runs, flagged as an
   accommodation in at least two of three and never capped; C2 ("no kids"
   in qualifications) flagged unlawful in at least two of three and never
   capped; C3 (assistance animal against "No pets" written only in
   qualifications, PR41) flagged as an accommodation in at least two of
   three and never capped - in EACH direction.
4. Ungraded runs: any call that failed (a refusal, a timeout, a
   truncation, a driver error) or did not score its subject fails the gate.
   A transient one (an API hiccup) is a re-run of the whole command, not a
   fix.
5. Write your sign-off on the `Cameron:` line of the latest section (PASS,
   or your decision with the date), then commit the record with an explicit
   path: `git -C W:/tmp/wp1-b2-ranking-engine add docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/counterfactual-check.md`.

## Choices the build made (plan section 12 C2-C9; PR25 ruled the first two)

- Controls run in BOTH directions and must pass in each (the spec names no
  direction for them).
- Every call is the subject plus the same two fixed fillers (so "otherwise
  identical batches" holds and a twin never sits beside its twin).
- One ungraded run fails the gate; there is no automatic retry.
- The credit and income swap is one Notes line naming both (nine swaps, as
  the spec counts).
- The cost estimate assumes 2,500 output tokens a call; the record carries
  the actual tokens and cost.
- The assistance-animal control's property records the Pets item in two
  keys (No pets and pets details), and the control passes whatever Pets key
  the model flags (PR29 / PR40: for an accommodation flag the cap matches by
  requirement item).
- The record is checked before the first call (exit 2, nothing spent) and
  created empty when missing; an append that fails after the calls prints
  the record to the terminal and exits 1 (build worklist WL-S8-12).

## Before the deploy (PR35)

These runs need no deploy. When B2a ships, RUNBOOK "AI ranking (WP1 B2a)"
has the checklist: after `npm run secrets:sync -- <env>`, every new ranking
key (the `RANKING_*` lines, `AI_RANKING_MODEL`, `AI_PRICE_TABLE` and
`RATE_LIMIT_RANK_PER_MIN`) sits in `.env.<env>` with an EMPTY value, which
`secrets:push`, `secrets:check` and the deploy gate refuse - give each the
value its example line carries (or delete the line) before pushing; never
push a blank.
