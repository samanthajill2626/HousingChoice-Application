# Planner verdict - retry-send adoption (send-outcome Stage 1b)

Date: 2026-09-28 (overnight run, autonomous; launch gate pre-answered by
Cameron as AUTO with a 30-minute watchdog). Planner: Claude Fable 5.1 (the
mission's planner session). Branch `feat/retry-send-adoption` at
`W:\tmp\retry-send-adoption`, cut from `main@3dbb5740`; main has not moved
(0 behind). Code final at aae99caa (fix wave 3; before it 56f1d757 and 1b5ddb01); the
orchestrator's handback at 217b19dc; the planner's review records and this verdict are docs-only commits
on top.

## Verdict

**MERGE-READY.** The branch closes `retry-send-lost-under-job-marker`: the
one-to-one 30003 automatic retry claims a send-attempt record instead of the
run-once marker, hands an unknown outcome to `send.reconcile` (which adopts
the retry row with its lineage, root and share attribution, re-drives once
inside the window, or closes it `unresolved` with the retried row marked
"retry not confirmed" and no Retry button), and every retry row - automatic,
adopted, manual - carries `retry_root` and `broadcast_id` for share-skip
Branch B. Every residue the four spec rounds, three plan rounds, two
orchestrator review rounds and my two reviewers found is filed or recorded;
one decision is Cameron's (below); nothing infra is owed.

## Gates - my own runs, bare, on a quiet tree, DynamoDB Local restarted first, exit codes read straight after

Logs under `.superpowers/planner-gates/` (run 1, on 95edb0b6, before fix wave
2), `.superpowers/planner-gates-2/` (run 2, on 82ad5e3a = code 56f1d757, before
fix wave 3) and `.superpowers/planner-gates-3/` (run 3, on 217b19dc = the final
code aae99caa); gitignored run state. Three full batteries, three DynamoDB Local
restarts, no reviewer test beside any of them.

| gate | run 1 @95edb0b6 | run 2 @82ad5e3a (code 56f1d757) | run 3 @217b19dc (FINAL code aae99caa) |
|---|---|---|---|
| `npm run typecheck` | `TYPECHECK_EXIT=0`, 0 `error TS` | `TYPECHECK_EXIT=0`, 0 `error TS` | `TYPECHECK_EXIT=0`, 0 `error TS` |
| `npm run smoke` | `SMOKE_EXIT=0` | `SMOKE_EXIT=0` | `SMOKE_EXIT=0` |
| `npx eslint <40 branch files>` | `LINT_EXIT=1`: ONE error, `Timeline.tsx:1595` set-state-in-effect = the SAME error at the merge base (`:1580`, my baseline run in the main checkout at 3dbb5740) - **0 new** | `LINT_EXIT=1`: 1 problem, **0 new** messages against the merge-base baseline (`comm` of the message sets) | `LINT_EXIT=1`: **0** new messages against the baseline |
| `npm test` | `NPMTEST_EXIT=0`, 0 `[dynamoAdmin]` lines | `NPMTEST_EXIT=0`, 0 `[dynamoAdmin]` lines | `NPMTEST_EXIT=0`, 0 `[dynamoAdmin]` lines |
| `timeout 1800 npm run e2e` | `E2E_EXIT=0`, **300 passed (21.0 m)** | `E2E_EXIT=0`, **300 passed (20.9 m)** | `E2E_EXIT=0`, **300 passed (20.9 m)** |

The orchestrator's own batteries (its handback, section 2 and 10): all five
green at a67376d3 (300/300 in 20.9 m); the fast gates + touched suites green
at 56f1d757 (FW2) and at aae99caa (FW3, 375 touched-suite tests). No reviewer ran a test beside either of my e2e runs.

## Reviews

The orchestrator's own: build research (two delta readers, a 27-item
worklist), round 1 (conformance 119/6/0/12 + a plan-blind adversarial: no
blocking/high), fix wave 1 (eight items, every behavior fix red-with-revert),
round 2 (a fresh reviewer: seven LOW/NOTE, converged) - `code-review/`.

Mine, on the handed-back branch (`planner-review/`):

- **Conformance** (`conformance.md`): 107 CONFORMS / 13 DEVIATES-DECLARED /
  0 undeclared / 0 MISSING; five LOW (all filed residues or spec errata).
  Every ruling holds: Q1 (unresolved -> "retry not confirmed", withdrawn, no
  Retry), Q2 (`twilio.ts` changed by exactly one line, ASCII-ized), Branch
  B's `broadcast_id` + `retry_root` on all three appends, the wontfix
  untouched; the fences hold; the marker is only ever read.
- **Plan-blind adversarial** (`adversarial.md`): 2 MEDIUM, 6 LOW. The one
  that changed code: **the job's step 4a and the reconcile's `never_sent`
  ruling ignored the `retrychild#` pointer that proves THIS attempt already
  produced a row** - a re-driven attempt could send again beside its own row
  (a slow provider request that lands after the reconcile's two-sided window,
  a takeover by the SQS redelivery, `never_sent`, re-drive). The spec's 4a
  carve-out ("an automatic child does not trigger it") was wrong for a child
  of this attempt: four spec rounds and three plan rounds missed it; the
  plan-blind reviewer found it. **Fix wave 2** (56f1d757, three commits): the
  job declines before the claim on its own child (`already_sent`); the
  reconcile's lookup answers `found` from that row before the sender/digest
  checks and the provider list; one vacuous ASCII assertion made real. Every
  fix red with the fix reverted. Re-review of the fix diff by the same
  reviewer (`adversarial-r2.md`): both belts CORRECT, not merely plausible
  (no wrong-row adoption or decline from a replayed check, a forked chain or a
  different recipient key; no strand or double close); one medium CONTEST of
  the rollup deferral (an attribution field other than `broadcast_id`) rejected
  as a change to Cameron's verbatim ruling and folded into decision 1; two LOW
  accepted into **fix wave 3** (aae99caa: step 1 refuses a payload whose
  attempt is not `(retried.retry_attempt ?? 0) + 1` - the invariant that makes
  the 4a other-attempt carve-out unreachable; the legacy root walk's own bound
  `RETRY_ROOT_WALK_MAX_HOPS = 12` so a pre-deploy chain a manual Retry extended
  resolves its true root); one LOW filed (`already_sent` on a `done/refused`
  record means the text exists - the sweeper note). Every FW3 fix red with the
  fix reverted.
- Spec revision 6 adds section 8 "Errata as built" (21 items) - the rules
  Branch B builds on.

## Decisions for Cameron

1. **The rollup one-liner (his fence).** As ruled (Q2), the rollup's give-up
   line is INFO. Both my adversarial reviewer and the orchestrator's round 2
   note the cost that ruling accepts: every receipt of a share-RETRY row (it
   now carries `broadcast_id`) takes the rollup's miss path - a 2.5 s sleep
   and two broadcast reads per callback, twice for a delivered text - and the
   INFO level also silences a GENUINE slot miss on a share's own row. A
   different single line at the call site (`twilio.ts:3529`: skip the rollup
   when `message.retry_of` is set, and put the give-up line back to WARN)
   removes all of it and keeps real misses loud. It is a different fenced line
   from the one approved, so the build kept the approved one. Recommendation:
   take the one-liner as a small post-merge fix (Branch B removes the guard
   when it teaches the rollup); not blocking.
2. **The legacy root walk's bound.** `RETRY_ROOT_WALK_MAX_HOPS = 12` covers
   three manual retries each with a full ladder; a pre-deploy chain whose ROOT
   also ran its own ladder before the first manual retry is 15 hops deep and
   stops at the last row read (section 0's stated rule). Only pre-deploy rows
   pay the walk; every new row carries `retry_root`. Raising it to 16 is one
   constant plus its stop test; I kept 12 (the chain shape is essentially
   nonexistent in this data and the wrong root only touches Branch B's routing
   of such a legacy chain). Yours if you want it.
3. **The in-flight overlap** (`manual-retry-double-send-residual-windows`):
   a manual press whose send is in flight (or ends unknown) while a late
   automatic job passes 4a and claims - two texts, two rare events at once.
   A route-side conditional write on the record would close it at the cost
   that a refused press also ends the automatic attempt. A product call;
   filed, not built.

## Residues filed (all in `docs/issues/`, committed c998412b and the fix-wave notes)

`send-attempt-sweeper` (the `retry_send` strand cases, the 30-day TTL belt,
FW1's relay twin), `send-reconcile-job-residues` (the lineage reads, the
longer promise tails, pre-deploy children, the two-sources-of-truth facts,
the legacy walk bound on deep pre-deploy chains), `manual-retry-double-send-residual-windows`
(the gap map), `broadcast-30003-retry-never-updates-slot` (attribution
landed, the interim rollup cost, deviation 7), `send-reconcile-hosted-dev-checks`
(this owner rides the same lookup - item 1 is a precondition),
`retry-promise-write-replay-skips-rerender` (new, low), a second sighting on
`tour-reminders-earlier-tie-break-test-ms-race`. `one-to-one-retry-promise-outlives-job-decline`
untouched (wontfix).

## Merge (the human merges)

```
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/retry-send-adoption
```

At merge: set `docs/issues/retry-send-lost-under-job-marker.md` to resolved.
No infrastructure, deploy, flag, secret or schema action is owed. DEPLOY
NOTE: deploy when the worker log shows no `retrySend` failure in the preceding
~10 minutes (the read-only marker belt covers the window either way; remove
the belt after the first deploy plus one SQS redelivery window - a dated
TODO). ROLLBACK NOTE: drain `send.reconcile` before rolling back (pre-branch
code cannot read a `retry_send` owner). Before relying on any reconcile in
production: `send-reconcile-hosted-dev-checks` items 1-5. Next: share-skip
Branch B (reads spec R10 and section 8).

## Live QA

The three new e2e specs (spec items 17-19: adopted at check 0; never_sent
re-driven once; unresolved -> "retry not confirmed" with no Retry and 409
`retry_unresolved`) drive the real hermetic lane end to end and passed in all
three of my full batteries; the orchestrator's committed self-QA (`self-qa.md`,
screenshots under `.playwright-mcp/qa-rsa-*.png`) drove items 19 and 17 by
hand on a fresh lane, watched an open page re-render over SSE from "will
retry" to "retry not confirmed", and confirmed the route's guard order live.
I did not repeat the manual drive: the project Playwright MCP needs a browser
download (`chromium-1246`) that only the human approves (handback section 8,
item 6), and the specs cover the same paths under assertion.

## Run health

Failure budget 0 of 2 used; infra recoveries 0; no stall, no misfire, no
usage-limit death. 6.5 hours from dispatch to the first handback; fix wave 2
and the re-gate on top. Every slice, review round, fix wave and self-QA is a
committed record under `docs/superpowers/reviews/2026-09-27-retry-send-adoption/`.
