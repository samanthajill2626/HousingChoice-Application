# Planner verdict - feat/last-heard-from

Date: 2026-10-13. Planner independent review of the build handback (8bec5de1)
plus the planner fix wave (8d365094, 814cc258) and records (6f0673c9,
c86fe28c, this file).

**VERDICT: MERGE-READY at the commit that adds this file, subject to ONE
decision of Cameron's: approve spec 14.7 (durable tour supersession + the
Interested write order). UNMERGED (human gate).**

## Gates (planner's own runs, bare, from the worktree, quiet tree)

Run 1 on 8bec5de1 (the build handback):

| gate | exit | counts |
|---|---|---|
| 1 typecheck | 0 | - |
| 2 npm test | 0 | app 475 files / 9978 + 1 skipped; dashboard 248 / 4697; e2e 22 / 508; fake-twilio 34 / 275; fake-twilio-web 13 / 111; zero `[dynamoAdmin]` lines |
| 3 smoke | 0 | 1695 import specifiers across 294 emitted files resolve |
| 4 `timeout 2400 npm run e2e` | 0 | 359 passed (21.0m) |
| 5 eslint (120 branch files) | 1 | ONE error, pre-existing: `ContactsList.tsx:208` react-hooks/set-state-in-effect; the same error is at `:184` at the merge base 8a56128c (baseline run) |

Run 2 on 814cc258 (after the planner fix wave; code identical to the final
commit, later commits are records only):

| gate | exit | counts |
|---|---|---|
| 1 typecheck | 0 | - |
| 2 npm test | 0 | app 9980 + 1 skipped (the two new follow-ups cases); dashboard 4697; e2e 508; fake-twilio 275; fake-twilio-web 111; zero `[dynamoAdmin]` |
| 3 smoke | 0 | 1695 specifiers resolve |
| 4 `timeout 2400 npm run e2e` | 0 | 359 passed (22.1m) |
| 5 eslint | 1 | re-run over the full 120-file branch diff against the original base 8a56128c (main had moved to 8bec5de1 mid-run, which shrank `main...HEAD` to 3 files - that 3-file run's exit 0 is void): ONE error, the same pre-existing one |

## Reviews

- Spec conformance: "matches the spec"; 0 BLOCKING / 0 HIGH. Round 2: nothing
  new.
- Plan-blind adversarial: 0 BLOCKING / 0 HIGH / 2 MEDIUM / 4 LOW; round 2: the
  fix is correct, one new LOW, all rulings conceded.
- Adjudications: `adjudications.md`. Fixed: A1 (follow-ups lookback before
  any join), C3 (e2e proves the placed tenant comes back). Filed: auto-reply
  email (med), Review-recipients column labels, outcome-join duplication,
  Interested tour missing from the Tours card until reload (all low).

## Live QA (hermetic lane 10, app commit c86fe28c)

API: follow-ups excluded a 20-day-old send and listed the 3- and 2-day ones
(no reply, correct waiting-since); Interested twice created exactly ONE
self-guided requested tour; Not interested -> Undo -> Undo (no-op) held; the
dev seam answered 409 `send_exists` on a duplicate pair. Browser: the Follow
up tab (one group, "1 waiting", "No reply yet, 2 days", tab count 1) and the
property's Sent to card (Waiting / Interested / Not interested groups, Tours
card shows the requested tour, Activity shows the four outcome events) -
`qa/last-heard-from-planner-1-follow-up.png`, `qa/last-heard-from-planner-2-sent-to.png`.
Lane stopped; ports free.

## Main drift

`main` was fast-forwarded to 8bec5de1 at 2026-10-13 20:39:47 (reflog
"merge feat/last-heard-from") after an earlier merge-and-reset at 20:13-20:14.
The branch is therefore 0 behind main and 5 ahead (the planner's commits);
the merge is a fast-forward. `16ca96cc` (the 1.5.3 RUNBOOK line) is inside
the branch, so main keeps it.

## Owed after merge (Cameron)

Deploy, then run the backfill per RUNBOOK "Last heard from: the backfill":
`npx tsx app/scripts/backfill-last-heard-from.ts --env dev` (dry run), then
`--apply`; the same with `--env prod`. Until then every existing contact
reads "Last heard from Never". No terraform / SSM / secrets / table change.
