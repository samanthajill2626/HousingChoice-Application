---
id: perf-cli-configuration-invalid-swallows-reason
title: perf:pages collapses every parse error into a bare "configuration_invalid"
type: debt
severity: low
status: resolved
area: e2e/performance
created: 2026-08-24
updated: 2026-08-24
refs: e2e/performance/cli.ts, e2e/performance/config.ts
---

**RESOLVED 2026-08-24 (branch `fix/perf-selfqa-route-contract`).** Parse
failures now print the parser's reason after the `configuration_invalid`
token, gated by a conservative charset/length check so option VALUES (and
hostile option-name text) still never reach stderr - the cli.test.ts sentinel
pin proves the no-leak property and now also pins the surfaced reason. The
locked self-QA invocation was added to `renderProfilerHelp`'s examples.

Original issue text below, kept for history.

**Problem.** `runProfiler`'s parse wrapper catches every error from
`parseProfilerArgs` and prints only `configuration_invalid` (`cli.ts:254-257`),
discarding the precise message the parser threw. Observed 2026-08-24: a bare
`npm run perf:pages` and a `-- hermetic --self-qa=full` invocation both printed
the same opaque line, hiding "target must be hermetic, local, or hosted-dev"
and "--self-qa requires default scale 1 and one cold and warm repeat"
respectively. The operator had to read `config.ts` to discover the locked
diagnostic mode needs explicit `--cold-repeats=1 --warm-repeats=1`.

**Fix sketch.** Print the thrown message (they are all static, operator-safe
strings) after the `configuration_invalid` token, and add the self-QA
invocation to `renderProfilerHelp`'s examples:
`npm run perf:pages -- hermetic --self-qa=full --cold-repeats=1 --warm-repeats=1`.
