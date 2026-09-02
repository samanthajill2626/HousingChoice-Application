# Mission record - message transport fidelity (`feat/message-transport-fidelity`)

Merged to `main` in TWO merges: `80f448bb` (2026-09-02 09:06) and `a2602e32`
(09:57), the second carrying a post-main-sync review round that ran after the
first. The design and plan are frozen at
[`2026-08-31-message-transport-fidelity-design.md`](../../specs/2026-08-31-message-transport-fidelity-design.md)
and [`2026-09-01-message-transport-fidelity.md`](../../plans/2026-09-01-message-transport-fidelity.md).
For current truth read the code.

## What shipped

Requested-versus-actual transport fidelity end to end. A message now carries what
transport was REQUESTED and what the carrier ACTUALLY used, as separate facts,
across eleven slices: the domain and evidence layer (D1), narrow
`CarrierMessageSender` / `GroupMessageSender` adapter contracts with frozen
serializable intents and late preparation (D2), conditional persistence (P1),
direct/inbound/status webhooks (W1), relay and announcements (W2), native Group
MMS (W3), imports/seeds/dev fixtures/the fake (W4), projections, types and hooks
(R1), the chip and recipient presentation (U1), and a hermetic browser proof
(E1). The Twilio adapter owns normalization and conflict warnings; the console
adapter returns its immutable request as actual rather than fabricating Twilio
evidence. Net delta at handback: 153 files, +12995/-411.

Nothing is owed after merge - no dependency, migration, backfill, feature flag,
infrastructure, Twilio configuration, or RCS enablement.

## Two things a later reader must not re-litigate

- **The relay fan-out cap race is DEFERRED BY EXPLICIT HUMAN SCOPE, not waived.**
  The post-main-sync adversarial review found, and a two-job barrier test
  reproduced, a capped duplicate closing an active relay pass with a false
  `transient_cap` while the winning provider send was still blocked. It is a
  concurrency gap in main's durable fan-out counter, not a transport rule, and it
  affects legacy and transport-schema-v1 rows alike. Human direction on
  2026-09-02 was to commit the sync and hand it to a separate mission. Tracked at
  [`relay-fanout-active-pass-cap-close-race`](../../../issues/relay-fanout-active-pass-cap-close-race.md);
  full evidence and the REJECTED remedies are in
  [`post-main-sync-adversarial.md`](post-main-sync-adversarial.md). **The
  investigative red test was deliberately not committed** - an intentionally
  failing test would have made the branch incomplete and invalidated its gates.
  The follow-up mission recreates it first for its own TDD red proof.
- **The full E2E gate was never run to a natural exit, by human direction.** Both
  batteries were stopped: the first when the human stopped a constrained machine
  after three failures (reached test 205), the post-sync one at a human-directed
  15-minute watchdog (reached test 207 of 266). The mandated isolated follow-ups
  passed. The one substantive failure,
  `e2e/tests/dashboard-next/outbound-mms.spec.ts:247` - a scroll-preservation
  assertion at line 463, expected top 512, received 500, with the send, media
  record and rendered image all complete - is now owned by
  `fix/outbound-mms-scroll-flake`. Non-browser gates were EXIT 0 throughout.

Also of record: touched-file ESLint reported 10 errors and 9 warnings across 83
paths, and every one reproduces at the merge base on the 70 paths that existed
there. The 13 new paths had zero errors. No lint finding belongs to this branch.

## Added at retirement (2026-09-02)

The mission committed 71 review files itself, but the tracked set was assembled
by hand and had real gaps. Rescued from the worktree's gitignored
`.superpowers/sdd/` before deletion:

| added | why |
|---|---|
| `handback.md` | **was never committed at all** - the mission's own work map and final evidence existed only in ignored space |
| `worktree-records/` (72 files, 221KB, ASCII, ~0-8% code blocks) | the implementer-facing half of the record |

What `worktree-records/` fills in, specifically:

- **7 of the 13 fix-wave rounds had no tracked record.** Only task-3 (waves 1-2)
  and task-11 (waves 1-4) were committed; task-1, task-4, task-5, task-8,
  task-10, task-11-wave-5 and task-12 fix waves were not.
- **Task 6, 7, 8 and 9 reviews were absent** - the tracked directory carries
  slice reports for those tasks but no review findings.
- **The 15 task and fix-wave briefs** - where each slice's scope was decided.
- `final-adversarial.md` and `final-spec-conformance.md`, the ORCHESTRATOR's own
  final reviewers. These are distinct from the tracked `parent-final-*` files,
  which are the PLANNER's cold reviewers - both rounds happened.
- `phase1-live-worklist.md`, `task-13-invariant-audit.md` and the three task-13
  correction reports.

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `.superpowers/review/*.md` - **1.4MB of diff packages**, including an 883KB
  `final-transport-fidelity-diff-package.md` and per-task diffs up to 67KB, each
  named for the two commits it spans. Git regenerates every byte.
- `sdd/research-{app-domain,dashboard-e2e,relay-nonlive}-reference.md` - the
  mission split findings from byte-exact quotation at authorship and named these
  halves `-reference`.
- `sdd/final-gates/*` and the other `.log`/`.exit` captures - gate output. The
  verdicts, with quoted counts, are in the handback and
  [`post-main-sync-gates.md`](post-main-sync-gates.md).
- `sdd/*.ps1`, `sdd/task-1-review-probe.mjs` - gate runners and a probe script.
- `sdd/progress.md`, `heartbeat.log` - the dispatch ledger and run state.
