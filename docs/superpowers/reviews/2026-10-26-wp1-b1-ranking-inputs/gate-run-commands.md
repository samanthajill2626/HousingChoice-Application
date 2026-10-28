# WP1 B1 - the never-written gate run (Cameron's commands)

B1 is handed back "merge-ready PENDING the never-written gate run" (plan PR1,
spec D7): no agent ran the probe against a real model or read the key. This
sheet is plan section 10's "Gate-run commands" updated to the script as
built after review rounds R1-R4 and fix waves FW1-FW4.

- Branch `feat/wp1-b1-ranking-inputs`, worktree `W:\tmp\wp1-b1-ranking-inputs`.
- The five repo gates ran green at commit 89016353 (the S7 report quotes
  them) and again, after the planner's retry-guard fix PF-1 (68168b4c,
  Cameron's handback ruling; it changes the extraction prompt), at a0371f40
  (planner-review/adjudications.md). Commits after 68168b4c are records
  only, so the code you measure is 68168b4c's; run on it or later. The dry run below prints the extraction prompt
  fingerprint and the grader prompt fingerprint the record will carry (the
  extraction prompt changed in the fix waves after the first review, so an
  older fingerprint you may have seen no longer applies). Any extraction
  prompt, grader prompt, case or model change after a passing run needs a
  new run (spec D7).
- The gate is BOTH commands: the never-written suite AND the `--baseline`
  comparison of the default suite (branch vs main). Both must pass on the
  final prompt.

## Before you start

- Run from the feature worktree, which has its own `node_modules`. The
  comparison loads main's code from the shared main checkout
  `W:\AI Projects\Housing Choice\HC Application`, which must have its
  `node_modules` and be ON `main`
  (`git -C "W:\AI Projects\Housing Choice\HC Application" rev-parse --abbrev-ref HEAD`
  prints `main`). The record names both commits.
- git must be able to read both checkouts: a run whose commit git cannot
  read stops BEFORE any paid call ("git could not read the commit ... - no
  certificate"; FW3-3, FW4-1). If that happens on the mapped W: drive, fix
  git's access (for example `safe.directory`) and re-run - nothing was spent.
- Run the two real commands ONE AFTER THE OTHER, never in parallel, and
  commit the record only after both finish (the runs read the commit before
  the first call and after the last; FW-6, FW2-3).
- Check `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are not set in the
  shell: each command prints the API endpoint host it will use and whether an
  auth token is set (FW-8); it should say the default host and "no".
- Keep `EXTRACTION_FACT_MIN_CONFIDENCE` unset (or 0.7, the production
  default): the record prints the floor it used.

## The commands (PowerShell, one per line)

```powershell
cd W:\tmp\wp1-b1-ranking-inputs
npx tsx app/scripts/extraction-prompt-probe.ts --suite never-written --model claude-sonnet-5-5 --dry-run
$env:ANTHROPIC_API_KEY = '<the TESTING key>'
npx tsx app/scripts/extraction-prompt-probe.ts --suite never-written --model claude-sonnet-5-5 --out docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md
npx tsx app/scripts/extraction-prompt-probe.ts --model claude-sonnet-5-5 --baseline "W:\AI Projects\Housing Choice\HC Application" --out docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md
Remove-Item Env:ANTHROPIC_API_KEY
```

The dry run is free (no call, no key) and prints every case with its planted
fact, its expectation and its content hash, the grader's whole system prompt
(the nine excluded-kind descriptions and the NOT EXCLUDED list), both
fingerprints and the API endpoint line - read it before spending anything.
Each real command prints the key's last four characters only, a PASS/FAIL
line per case or attempt, and APPENDS a dated section to the one record;
exit 0 is a pass of the automatic checks. Do not use `--case` for the gate:
a one-case section is marked PARTIAL and never counts (FW-3).

## Calls and cost (rough; prices unverified, PR39)

| Command | Calls | Est. cost on claude-sonnet-5-5 ($2 / $10 per MTok, unverified) |
|---|---|---|
| never-written | 29 cases x 3 = 87 extraction calls, plus one grader call per run that wrote a line or proposed a field value (up to 87) | about $2.50 |
| --baseline comparison | 10 cases x 3 x 2 sides = 60; 120 if the first comparison fails and re-runs (no grader) | about $1.40; about $2.80 with the re-run |
| Total | up to 234 to 294 | about $4 to $5.50 |

A prompt fix and a second full run doubles it.

## Reading the record

1. The never-written section: the verdict, zero lines judged excluded, zero
   cases "not measured" (each needs 2 of 3 runs both scored and graded),
   every control met, zero truncations. The Verdict line also states any
   ungraded runs and how many lines they hold (FW-7).
2. "Grader verdicts to review": each excluded verdict with its kind and
   reason. A LINE judged excluded fails its case; a FIELD value judged
   excluded is reported only (the four tenant matching fields are outside
   the never-written list by your charter decision, spec D3 / charter
   20.2). Then skim the excluded cases' runs for CLEAN verdicts on lines
   that do carry the planted fact. An entry the grader marked excluded
   inside an otherwise malformed answer still counts (FW-2); a run's raw
   grader answer is printed when the run is ungraded.
3. "Lines the grader did not judge" (PR55): every line there is unjudged;
   a leak in one fails the gate by your reading.
4. Each feedback control: the lines written against "Gist expected" - an
   unsure tenant must read as unsure, not as a no.
5. The `--baseline` section: per-case ok counts on both sides; it FAILS when
   a case is not measured on either side (fewer than 2 of 3 calls returned
   a result - an expired key or a wrong model fails here, FW-1), a case is 2
   or more below main, the total is more than 2 below main, or the branch
   truncates.
6. A truncation: raise `MAX_OUTPUT_TOKENS` (the `const MAX_OUTPUT_TOKENS`
   line in app/src/adapters/extraction.ts) on the branch and re-run both
   commands (a new commit, so the record's commit changes too).
7. Write the sign-off on the `Cameron:` line of the latest never-written
   section (PASS or your decision, with the date). To overrule a grader
   verdict either way, name the case, run and item and say which way; that
   ruling stands for the gate (spec D7).
8. Commit the record with an explicit path (you, or the planner on your go):
   `git -C W:/tmp/wp1-b1-ranking-inputs add docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md`
   then commit it.

## Deviations from the spec text to rule on at sign-off

- FW-9: the assistance-animal CONTROL tells the grader the excluded fact its
  message carries (the therapist who wrote the letter) instead of "none";
  spec D7 says controls plant none. It stays scored as a control (the dog
  line must be written in 2 of 3 runs). Overrule if you want "none" back.
- The gate has no case that sees a change of mind (no case carries earlier
  Notes lines), so it does not measure the change-of-mind wording FW3-2
  added to the prompt, nor the any-date retry guard (PF-1); both are pinned
  by unit tests only.
