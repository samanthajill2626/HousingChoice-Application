---
id: extraction-fake-driver-object-fields-shape
title: The fake extraction driver and the e2e markers still use the old object-shaped fields, so no hermetic path runs the shipped list shape
type: debt
severity: low
status: open
area: app/extraction
created: 2026-10-28
refs: app/src/adapters/extractionFake.ts:103, e2e/tests/ai-run-log.spec.ts:155
---

**Problem.** WP1 B1 changed the model's wire shape for `fields` from one named
object per field to ONE list of `{ field, op, value, reason }` entries,
because twelve named objects exceed the structured-output grammar limit
(app/src/services/extraction/schema.ts, rawFieldOps). The parsers read both
shapes. The fake driver, though, passes its `EXTRACT:` marker payload straight
through as the result (it never runs the parser), and the fake's documented
examples, the e2e marker builder and the adapter tests all use the object
shape. So no hermetic test runs a list-shaped payload end to end, and an e2e
marker written in the list shape (the shape the prompt now asks for) applies
nothing: apply reads `fields` as a keyed object, while the run log's ops view
still sees the write, so the run records an unexplained drop.

**Suggested fix.** In the fake driver, fold a list-shaped `fields` through the
same rawFieldOps rule before returning the result (export it from schema.ts),
and switch at least one e2e marker and one adapter test to the list shape.
Found by the WP1 B1 plan-blind re-review (PA-S-1).
