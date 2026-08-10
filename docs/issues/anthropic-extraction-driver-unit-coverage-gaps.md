---
id: anthropic-extraction-driver-unit-coverage-gaps
title: Three AnthropicExtractionDriver failure arms and the whole request shape are still unpinned
type: debt
severity: med
status: open
area: app/extraction
created: 2026-08-09
refs: app/src/adapters/extraction.ts:203, app/src/adapters/extraction.ts:232, app/src/adapters/extraction.ts:248, app/src/adapters/extraction.ts:196, app/test/extractionAdapter.test.ts:257
---

**Problem.** The real driver used to have no unit coverage at all. The fix wave
closed most of that: `app/test/extractionAdapter.test.ts:8-14` stubs
`@anthropic-ai/sdk` with a class whose `messages.create` returns a
test-controlled reply, and the `anthropic driver - malformed SDK responses (F9)`
block at `:257-304` now instantiates the REAL `AnthropicExtractionDriver` and
pins four arms: no-`usage` -> `driver` (`:265`), no-`content`-array -> `driver`
(`:273`), the well-formed success path with `usage` and `rawText` (`:281`), and
the spec-6.4 rule that **`rawText` survives a parse failure** (`:293`).

What is still unpinned, all on `app/src/adapters/extraction.ts`:

- **SDK throw -> `driver` failure** (`:203-205`). The stub's `create` never
  rejects, so the one arm that a real outage actually takes is untested. It is
  also the arm whose message is derived from an arbitrary thrown value
  (`err instanceof Error ? err.message : String(err)`).
- **Refusal** (`:232-237`). No test sets `stop_reason: 'refusal'`, so
  `failure: 'refusal'` from the real driver is never observed; only the fake's
  simulated refusal is (`extractionAdapter.test.ts:238`). This is the arm that
  decides whether an operator sees "the model declined" or a generic failure.
- **Content array with no text block** (`:248-253`). A reply of only non-text
  blocks returns `driver`; untested.
- **Request shape** (`:196-202`). The stub ignores its argument entirely, so
  nothing asserts that the driver sends `model`, `max_tokens`,
  `output_config.format.type === 'json_schema'` with `EXTRACTION_SCHEMA`, the
  system prompt, or the built user content. A regression here would ship
  silently.
- **Anthropic-driver meta identity** (`:189-193`). `meta.model` and
  `meta.promptFingerprint` are asserted for the fake driver but never for the
  real one, even though the run log records both.

**Suggested fix.** Extend the existing `anthropic driver` describe block, which
already has the stubbing strategy in place. Give the hoisted stub an optional
`throws` field so `create` can reject; add cases for reject -> `driver`,
`stop_reason: 'refusal'` -> `refusal`, and a content array with only a non-text
block -> `driver`. Capture the argument passed to `create` in the stub and
assert the request shape once. Finally assert `meta.model` and
`meta.promptFingerprint` on one anthropic success, matching
`extractionPromptFingerprint()` the way the fake tests do.
