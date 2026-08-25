---
id: cloudwatch-log-cp1252-mojibake
title: Em-dashes in log strings reach CloudWatch as a lone CP1252 0x97 byte
type: bug
severity: low
status: open
area: app
created: 2026-08-24
refs: app/src/index.ts:162, app/src/worker.ts:530
---

**Problem.** Log lines reach CloudWatch Logs with CP1252-encoded em-dashes.
`app/src/index.ts:162` (the app's "shutdown signal received" line) and
`app/src/worker.ts:530` (the worker's) each separate their two clauses with an
em-dash. Both hold a CORRECT UTF-8 em-dash in source (bytes `E2 80 94`; this
file is deliberately ASCII, so the character itself is described rather than
quoted - see the source lines for the literal). The STORED log event, however,
contains a lone `0x97` byte instead. `0x97` is the CP1252 encoding of the same
character and is not valid UTF-8 on its own, so every UTF-8 consumer renders it
as a replacement character - including the admin System Status "Recent errors"
panel, which is where this was spotted.

The two refs above are the reproducing examples, not the full extent: any
non-ASCII character in a runtime log string is exposed to the same conversion.

**Not a display artifact.** Isolated past two plausible innocent explanations:

- the PowerShell console encoding (the reading terminal), and
- the AWS CLI's own stdout encoding - re-run under `PYTHONIOENCODING=utf-8`,
  which still reproduced the lone `0x97`.

Both eliminated, so this is a genuine defect AT REST somewhere in the
build / runtime / ingest path (the compiled output, the Node process's stdout
encoding, the Docker log driver, or the CloudWatch agent's ingest), not in the
tools used to look at it. Which of those four converts the byte is not yet
established; that is the first thing to find out.

**Why it is only `low`.** Nothing functional depends on the character. The cost
is cosmetic-plus: mojibake in the operator-facing panel, and a stored log event
whose bytes are not valid UTF-8, which can trip a strict parser downstream.

**Suggested fix.** Find the converting layer first (compare the byte in the
compiled `dist/` output, in the container's raw stdout, and in the stored
CloudWatch event), then fix it there rather than at the call sites. The
belt-and-braces alternative is the repo's existing ASCII-only rule for new log
strings, which prevents new instances but does not fix the mechanism.

**Origin.** Found during the `error-surface-detail` spike and recorded in
section 9 of
`docs/superpowers/specs/2026-08-24-error-surface-detail-design.md`, which
explicitly puts the general fix OUT of that mission's scope. The specific lines
that mission's S1 slice edited were ASCII-ised as part of S1; the two refs above
were not among them and still carry a real em-dash.
