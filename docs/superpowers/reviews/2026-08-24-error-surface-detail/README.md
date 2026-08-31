# Mission record - error surface detail (`feat/error-surface-detail`)

Preserved 2026-08-27 from the worktree's gitignored `.superpowers/`. This mission
predates records being written to a tracked path, so these files existed only in
`W:\tmp\error-surface-detail`.

**This is a point-in-time record, not current documentation.** For current truth
read the code and `RUNBOOK.md`, whose alarm-response table now routes operators
to **Settings -> System status -> Recent errors** for exactly this feature.

## What it is

Settings -> System status -> Recent errors gained a **Show all** control that
expands the COMPLETE CloudWatch log record behind an error row - every field,
including `err.message` and the stack - and a **Trace** pivot to the surrounding
lines sharing that row's `requestId`, `pollRunId` or `correlationId`.

The reframe that drove the design: **the data was never missing.** pino already
wrote `err.message` / `err.stack` to CloudWatch and `dispatchJob` already logged
`jobName`. `projectErrorEvent` was a four-field PII allowlist throwing it away.
The projection is a DISPLAY control, not a storage control.

## Still owed - operator action

`terraform plan` + `apply`, **dev AND prod**, before the deploy. The branch adds
a scoped `SystemStatusGetLogRecord` IAM statement
(`infra/modules/ec2/main.tf:312`, committed). **Until it is applied, "Show all"
403s and degrades.** After applying, click "Show all" on a real dev error row to
confirm.

Also open: the feature issues one Insights query per Trace click with no spend
fence - unmetered cost per click.

## AWS facts established here - do NOT re-derive, they cost real spike time

- `@ptr` survives the full 7-day window and is BYTE-STABLE across separate
  queries. That stability - not uniqueness - is what lets it serve as both
  dedup identity and React key.
- **Insights `endTime` is INCLUSIVE.** A query with
  `startTime == endTime == floor(eventMs/1000)` returns that second's events.
  This is what makes the trace's disjoint floor / floor+1 split correct; an
  adversarial reviewer argued a 999ms hole in it and was wrong.

## Layout

| directory | what is in it |
|---|---|
| `design-review/` | spec rounds 1-5 and plan round 1 - including a deliberately COLD plan reviewer paired with the continuing one - plus the planner's adjudications |
| `review/` | spec-conformance, adversarial, the re-review of the fix diff, and the adjudication |
| `sdd/` | seven slice reports (A-G), the fix-wave report, `worklist.md`, `handback.md` |

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `review/diff-package.txt` and `review/fix-diff-package.txt` - raw branch
  diffs git already holds.
- `sdd/progress.md` - the timestamped dispatch ledger. Run state.

## Character set

Two files carry a few non-ASCII characters (18 total) in authored review prose,
preserved verbatim rather than edited - the ASCII rule governs newly authored
repo text, not a frozen record of what someone wrote.

## Lessons this mission is cited for

- **Pair a COLD reviewer with the continuing one.** `plan-r1-cold.md` is that
  reviewer; the continuing reviewer had absorbed the author's framing.
- **A correctness test cannot see a perf defect.** The suite was green while the
  unmetered per-click query cost went unnoticed.
