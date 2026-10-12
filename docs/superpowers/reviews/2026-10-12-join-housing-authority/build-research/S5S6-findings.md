# S5S6 build research - findings (e2e, stale docs, completion)

Scope: plan Tasks 5.1-5.3, 6.1, 6.2, 6.3a, 6.3 (plan lines 7325-8555) and binding
sections 0-4, checked against the live tree at 34e79ec7 (source unchanged since
469241f7). Evidence: `.superpowers/sdd/build-research/S5S6-reference.md`.

Result: every Edit anchor in S5 is FOUND-ONCE; every API, import path and helper
the S5 tests and the 6.3a seed script use exists with the assumed shape (the seed
script's seven imports and its top-level await were executed in a scratch probe
with `npx tsx` from the worktree root); no other e2e spec breaks or counts a
status/authority that the change moves. Three MINOR items, none blocking.

## S5S6-F1 - MINOR - MERGE_HEAD path does not exist relative to the worktree

- Plan: section 0 (line 27-28) and Task 6.1 step 4 (line 8156-8157):
  "check `.git/worktrees/join-housing-authority/MERGE_HEAD` is absent / exists".
- Live: `W:/tmp/join-housing-authority/.git` is a FILE
  (`gitdir: W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority`);
  `git rev-parse --git-dir` = that absolute path. Read relative to the worktree (where every
  command runs), the plan's path never exists, so the 6.1 step 4 check ("MERGE_HEAD exists"
  while resolving a conflict) would wrongly report no merge in progress.
- Correction: use the form the plan already uses in Tasks 1.x (e.g. line 337):
  `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT" || echo "no merge in progress"`
  (or `git -C W:/tmp/join-housing-authority rev-parse -q --verify MERGE_HEAD`, as Tasks 5.1-5.3 do).

## S5S6-F2 - MINOR - backslash worktree paths in Tasks 6.1/6.2 break under Git Bash

- Plan: Task 6.1 lines 8136, 8137, 8139, 8140, 8143, 8146 and Task 6.2 step 5 line 8210
  write `git -C W:\tmp\join-housing-authority ...`, while 6.2 gate 4 (`timeout 2700`) and the
  gate-5 baseline (`git show "$(git merge-base main HEAD):<path>" | npx eslint --stdin ...`)
  are bash, and the plan's lane rules say "Run it from Git Bash".
- Live: in Git Bash an unquoted backslash is an escape; verified
  `git -C W:\tmp\join-housing-authority log --oneline -1 main` ->
  `fatal: cannot change to 'W:tmpjoin-housing-authority': No such file or directory`.
  (No damage - it fails loudly - but the gate-5 file list would come back empty-with-error,
  next to an instruction that an EMPTY list means SKIP the gate.)
- Correction: write those commands with forward slashes, `git -C W:/tmp/join-housing-authority ...`,
  which works in both PowerShell and Git Bash (as Tasks 5.1-5.3 already do).

## S5S6-F3 - MINOR - e2e:stop drops the lane's tables; 6.3a Step 9.3 says the rows stay

- Plan: Task 6.3a Step 9.3 (line 8527): "The rehearsal rows live only in lane `<L>`'s
  database until its next reseed; leave them." Step 9.4 (line 8528) then runs
  `npm run e2e:stop`.
- Live: `scripts/e2e-stop.mjs:84-128` - a stop of a LIVE session runs
  `app/scripts/db-create.ts --drop` with the lane's key and prefix ("dropped lane <L> tables"),
  so the rehearsal rows (and the lane's whole database) are gone at Step 9.4, not at the
  next reseed. Related: e2e-stop.mjs removes an unchanged `lane.json` on both its paths
  (41-50, 142-148), so 6.2 gate 4's "if `e2e/.artifacts/lane.json` still exists, tree-kill its
  launcherPid" (line 8200) is reached only when the file changed during the stop - correct
  as a fallback, just rarely live.
- Correction: reword Step 9.3 to "The rehearsal rows live only in lane `<L>`'s database;
  the Step 9.4 `npm run e2e:stop` drops that lane's tables (scripts/e2e-stop.mjs:84-128)."
  No behavior change is needed.
