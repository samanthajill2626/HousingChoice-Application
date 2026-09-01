# Plan adversarial review - round 3 adjudications

Reviewer C, continued. Report: `plan-r3-reviewer-c.md`. 12 findings.

**Outcome: 12 ACCEPT, 0 rejected.** The reviewer's verdict was (B) NOT
TERMINAL, with the qualification that only two findings sit above LOW, both
are mechanical one-liners in text v3 ADDED, nothing needs a human decision,
and fixing those two would make the next revision terminal without another
full pass.

## The two above LOW

**#1 - S5's TTL probe has no drop between arms, so both arms report
ENABLED.** ACCEPT, and it is **the third consecutive instance of this
round's running theme: a fix introducing a defect of the class it closed.**
Round 2 replaced an unrunnable probe with a runnable one; the replacement
produces a FALSE CONTRAST. `ensureTable` short-circuits on
`ResourceInUseException`, and with `DYNAMO_DISABLE_TTL=1` it skips
`enableTtlIfNeeded` entirely (`dynamoAdmin.ts:116-119`) - so arm 2
describes a table arm 1 already enabled TTL on. Both arms read ENABLED, the
contrast is meaningless, and S7.2's issue would have been filed on it.

A drop between arms is now mandatory, and the reason is written down so it
cannot be optimised away by someone tidying the script.

**#2 - "count the marker files with a plain directory listing" OVER-counts
neighbours.** ACCEPT. The marker filename is the pid
(`testRunRegistry.ts:66`) and dead markers are pruned only by
`otherLiveRuns` (`:93-122`), which round 1 forbade calling because it
mutates machine-global state. So the read-only replacement is wrong in the
other direction - it counts corpses.

This matters more than a counting bug: an over-count labels a QUIET run as
contended, and that label is exactly what the anchor's one use restriction
turns on. Fixed by checking each pid's liveness without pruning.

## Accepted - the rest

| # | finding | verdict |
|---|---|---|
| 3 | S7.2 still says "file two NEW issues" and lists the built-dashboard one that S3.3 now files in S3 - a literal builder creates a duplicate registry entry | ACCEPT. The round-2 fix moved the filing and did not update its destination. |
| 4 | Every TTL case reaches `UpdateTimeToLive` only through the `DescribeTimeToLive` guard at `:131`; **case 6 passes with ZERO sends if the guard short-circuits**, and per-command counters cannot express "hook called N times" | ACCEPT. Case 6 exists to stop a hook that always returns `false` passing everything - and it could itself have passed while proving nothing. The stub's first guard read must report DISABLED, and hook calls need their own counter. |
| 5 | The poll's endpoint gate is UNREACHABLE through `ensureTable` (`retried` implies local), and case 17 - its only possible caller - does not say what endpoint the direct call gets | ACCEPT. The gate is removed rather than kept: dead code that reads as a live safeguard is worse than no code, because the next reader trusts it. Case 17 now names a local client. |
| 6 | S5's probe mutates then drops this worktree's shared `hc-local-` tables with no sequencing against S5's own four full runs | ACCEPT. Ordered after them, and the script is run state (`.superpowers/sdd/`), not committed. |
| 7 | v3 dropped v2's "a literal `<slug>` must not reach the shipped string" while still quoting a message containing `<slug>` | ACCEPT. A guardrail deleted by a rewrite - the same mechanism that lost the retry bounds during the spec review. Restored. |
| 8 | The S3 assignment table still routes `HousingChoice` to (a) after S3.1 replaced it with a distinctive marker | ACCEPT. Two parts of one slice disagreeing after a partial edit. |
| 9 | "Restructure both describes" over-prescribes - the second (`:177-215`) already builds per test and needs only the file-scoped `distDir` | ACCEPT. Over-prescription costs real work and invites a builder to break something that already works. |
| 10 | S1.2 calls the predicate "local to `dynamoAdmin.ts`" 44 lines after declaring it EXPORTED | ACCEPT. |
| 11 | S2.1 now measures three checker sites but S2.2's decision tree names no destination for `:106` | ACCEPT. Naming a measurement site with no destination turns measurement into ceremony - which is precisely what the spec review's one rejection was about. `:106` now has a stated destination (report as a decision; no pre-committed remedy). |
| 12 | `globalSetup.ts:216` should be `:214` (the reviewer's own round-2 error, self-corrected), and the throwaway probe script belongs in `.superpowers/sdd/` | ACCEPT. A reviewer correcting its own earlier citation unprompted is worth more than the citation. |

## Status

All twelve applied. Round 4 is a confirmation pass and the HARD CAP. The
reviewer has stated the two substantive fixes should make it terminal; if
it is not, the skill's rule applies - stop and put the open findings to the
human rather than continuing.
