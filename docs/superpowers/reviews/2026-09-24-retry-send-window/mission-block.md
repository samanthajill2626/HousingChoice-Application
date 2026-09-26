# MISSION: Retry send window (feat/retry-send-window)

Worktree: W:\tmp\retry-send-window  Branch: feat/retry-send-window  (cut from main @685f2ede; main merged ONCE at f49a2fe9 = main @da04d0cb)
Profile: W:\AI Projects\Housing Choice\HC Application\.claude\feature-mission.profile.md
Spec: W:\tmp\retry-send-window\docs\superpowers\specs\2026-09-24-retry-send-window-design.md (draft 7.2 or later)
Plan: W:\tmp\retry-send-window\docs\superpowers\plans\2026-09-25-retry-send-window.md (latest committed version; 21 tasks)
Design review: spec R4 (closed at draft 5); drafts 6-7.2 reviewed inside the plan review; plan reviewed R1 + later rounds - adjudications at W:\tmp\retry-send-window\docs\superpowers\reviews\2026-09-24-retry-send-window\plan-review-r*-adjudications.md

Work map (build strictly in task order, one writer on the tree):
  S1 foundation: T1 window module (Step 0: npm ci + npm run db:start), T2 repository fields + harness twins
  S2 relay: T3 shared gate evaluator, T4 claim decides at once (declines appended closed), T5 job window gate, T6 bounded acquire
  S3 one-to-one server: T7 refusal preview + parity, T8 sendMessage flags + lineage, T9 backoff seam, T10 decision before the status write, T11 retrySend job, T12 manual Retry 409 + recipient, T13 timeline projection
  S4 dashboard: T14 server clock + promise helper, T15 deliveryReason, T16 relay join, T17 Timeline, T18 other readers
  S5 close: T19 e2e (fresh lane), T20 docs/issues, T21 final gates + main re-sync if moved + build handback

Watch items:
  - The plan's "Slices, order and the mid-build states" section states three deliberate mid-build states - do not "fix" them early; the named red dashboard tests close in Tasks 17-18.
  - DynamoDB Local must be up for EVERY app vitest run (globalSetup is fail-loud). Docker is running (hc-dynamodb-local).
  - The e2e lane must be booted FRESH after Task 9 (e2e:restart keeps the old childEnv). Never touch :5174 / :8080.
  - Never use conv-0002 / contact-tenant-0002 (Dario) for any automated text or retry.
  - Line numbers are at f49a2fe9; anchor every edit on its quoted old text. Regions with pre-existing non-ASCII are named by line range - select, never retype; check only ADDED lines for ASCII there.
  - Gate 5 pre-existing error: dashboard/src/routes/contact/Timeline.tsx:1495 (react-hooks/set-state-in-effect) on main - attribute by baseline, name it in the handback.
  - Main sync (Cameron, 2026-09-25): merge main again in Task 21 ONLY if it moved since f49a2fe9, then re-run every gate. Another session has an open worktree (feat/inbox-rows-timestamps); main may move overnight.
  - timeout 1500 for the e2e gate (Git Bash); after any aborted run prove the lane's ports are free before another.
  - Cameron is ASLEEP until morning. Do not stop on a question the plan or spec already answers. For a code-level call, decide per the plan and record it. Raise STATUS: QUESTION only for a genuine product decision; the planner answers it.
  - Task 21 writes the build handback with a "Facts for the planner's Relay for SOR" section; the planner writes the final relay.

Gates (bare, from the worktree root, never piped; output redirected to logs under .superpowers/):
  npm run typecheck
  npm test
  npm run smoke
  timeout 1500 npm run e2e
  npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')   (baseline attribution against the merge base)

Post-merge obligations already known: none expected (no infra, deploy, secrets, flags, migration or dependency change).
