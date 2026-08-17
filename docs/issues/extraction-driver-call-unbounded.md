---
id: extraction-driver-call-unbounded
title: The extraction driver's Anthropic call is unbounded, holding a claim for ~30 minutes
type: debt
severity: med
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/adapters/extraction.ts:218, app/src/repos/extractionRepo.ts:315, app/src/jobs/extraction.ts:400
---

**Pre-existing.** This is NOT created by the manual-extraction-trigger feature. It
was found while specifying the withdrawn in-process runner (design section 9, item
1) and is filed rather than fixed, because with that runner withdrawn nothing in
the feature depends on the bound.

**Problem.** The Anthropic client is constructed with no `timeout` and no
`maxRetries`:

```
app/src/adapters/extraction.ts:218
this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.apiBaseUrl ? { baseURL: opts.apiBaseUrl } : {}) });
```

It therefore inherits the SDK's defaults. The installed `@anthropic-ai/sdk`
(`^0.112.3`) documents them in its own typings: `opts.timeout=10 minutes`,
`opts.maxRetries=2`, and, verbatim, "Note that request timeouts are retried by
default, so in a worst-case scenario you may wait much longer than this timeout
before the promise succeeds or fails."

Three ten-minute attempts is roughly thirty minutes of wall clock for a single
model call. For that entire window the extraction row stays CLAIMED: `claim`
REMOVEs `_duePartition` and `dueAt` (`app/src/repos/extractionRepo.ts:315-345`),
so the row is out of the `byDueAt` index and no poll can list it. The job awaits
the driver inline in its per-row body (`app/src/jobs/extraction.ts:400` claims,
then runs), so the poll pass itself is held open too.

Interacts with two siblings: [`extraction-stranded-claim-no-reaper`](./extraction-stranded-claim-no-reaper.md)
(if the process dies inside that half hour the row is stranded permanently) and
[`extraction-claimedat-stamped-from-poll-clock`](./extraction-claimedat-stamped-from-poll-clock.md)
(the timestamp that a staleness reaper would want to read is not trustworthy).

**Suggested fix.** Pass an explicit `timeout` and `maxRetries` when constructing
the client, sized from observed p99 run duration rather than from the SDK
default, and make both configurable. Decide deliberately whether a timed-out
extraction should be retried by the SDK at all, given the job already has its own
attempts/backoff/park ladder around the same call - two retry layers multiply.
