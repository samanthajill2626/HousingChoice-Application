# Mission ledger - Unknown inbox tab, contact-side triage read

Worktree: `W:\tmp\inbox-unread-cluster`   Branch: `feat/inbox-unread-cluster`
Base at start: `1dde0bc9` (docs only - spec + plan committed, no code yet)
Mode: MANUAL (top-level session; scope forks go to the human via AskUserQuestion)

Spec:  docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md (draft 4, gated)
Plan:  docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md (final)

## Phases

- [x] Phase 0 - setup (worktree confirmed, deps present, settings.local.json present)
- [x] Phase 1 - research fan-out (3 readers) merged into
      `.superpowers/sdd/worklist.md`. VERDICT: plan BUILDABLE. Deltas: insert
      point confirmed 1454/1456; inboxGroups test is 367 not 357; inboxFeed has
      FIVE unknown call sites not two; comment retirement is EIGHT sites not
      four; fake LEK shape corrected to the real GSI key; perf seed + dashboard
      cursor + every e2e assumption confirmed safe.
- [ ] Phase 2 - build, sequential slices
- [ ] Phase 3 - gates
- [ ] Phase 4 - review (2 parallel readers) + one fix wave + re-review
- [ ] Phase 5 - live self-QA
- [ ] Phase 6 - main sync, re-green, handback

## Work map (10 tasks, one commit each)

| # | task | state | commit |
| --- | --- | --- | --- |
| T1 | DynamoDB-faithful listByType fake (shared helper) | DONE | 17579b57 |
| T2 | inboxFeed/inboxGroups fakes learn listByType (inert) | DONE | e3d94947 |
| T3 | Parity baseline - pin the OLD Unknown tab, GREEN pre-flip | DONE | c92767f3 |
| T4 | app/src/lib/unknownQueue.ts collector | DONE | ffb1c8d7 |
| T5 | THE FLIP - filter=unknown branch + sweep + tests | DONE | 66989d6f |
| T6 | Integration repin (real DynamoDB) + perf-seed verify | DONE | 2dbc0ae1 |
| T7 | Dashboard - empty Unknown tab is an empty state | DONE | 99ed025b |
| T8 | E2E - extend unknown-caller-triage.spec.ts | DONE | f9a5132d |
| T9 | Docs - issue resolution, ruling, remainder, deferral | DONE | 8a27ecb3 |
| T10 | Gates (after local-main sync) | RE-RUN PENDING on final commit | |

Beyond the work map:
- `c3a45d32` - the ONE mainline sync (merge local `main`, zero conflicts)
- `41cd101c` - orchestrator-filed issue: logCallSiteGuard's hook budget
- `a544fa1a` - the review fix wave (no production behaviour change)

## Watch items (from the mission block)

- T3 committed GREEN before inbox.ts is touched. Only guard against a triage row
  silently disappearing.
- Do NOT copy excludeOrigin; do NOT narrow on status. Their probes must be able
  to go red.
- `capped` MASKS `truncated` in collectUnreadRows. Sweep pins maxRows to budget.
- Four existing pins change deliberately (inboxFeed x2, inboxApi, parity).
- T10 syncs LOCAL main (origin/main is ~83 behind).
- Never commit while `npm run e2e` runs. Gates bare, verdict read from the log.

## Recovery tally

ZERO budget-consuming recoveries. Zero cold-dispatch misfires, zero agent deaths, zero background-completion non-wakes, zero re-dispatches. Eight children, all fresh foreground dispatches except one review CONTINUATION (manual mode lifts the resume ban).

## Next step

Phase 1 research fan-out.

STATUS: RUNNING phase2-rework (findings 1-3 from the second review round)
