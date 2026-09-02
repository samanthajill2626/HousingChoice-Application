# Mission record - npm test soundness, M7 (`feat/npm-test-soundness`)

**Most of this record was committed by the mission itself** - the design and code
review rounds, the adjudications, the handback, and the distilled measurements
all landed with the work. This README and the three directories it names were
added on 2026-09-02 when the branch was retired.

The design and plan are frozen at
[`2026-08-31-npm-test-soundness-design.md`](../../specs/2026-08-31-npm-test-soundness-design.md)
and [`2026-09-01-npm-test-soundness.md`](../../plans/2026-09-01-npm-test-soundness.md).
For current truth read the code.

## What shipped

Every mutating send in `app/src/lib/dynamoAdmin.ts` now retries `InternalFailure`
/ `InternalServerError` behind a fail-closed local-endpoint gate, with a
verification hook for non-idempotent sends (**a failed RESPONSE is not a failed
REQUEST**), a per-send 20s deadline, and a 25-case no-container acceptance suite
(`app/test/dynamoAdminRetry.test.ts`). `db-update-gsis.ts`'s existing retry moved
onto the same helper, and cases 15/16 prove the move did not disarm it.

## The evidence discipline is the point

The mission **refused to close its own anchor issue**. No sighting of the target
signature occurred during the work - three contended baseline runs at `5ce9912f`
(580/452/463s) and three quiet post-fix runs at `b4ba463a` (238/223/254s), all
EXIT 0 with zero failing files - so there was nothing to point at as cured, and
its own protocol forbade closing on a contended-vs-quiet pair. It shipped the fix
and left the issue open. `npm-test-dynamodb-local-contention` was closed later,
on 2026-09-02, separately.

That is also why `measurements/` is tracked: the numbers are the deliverable.

## Added at retirement

| directory | what |
|---|---|
| `review-evidence/` | the nine `*-evidence.md` files backing each review round (12-21% of lines in code blocks - prose citing code, kept whole) |
| `briefs/` | the six implementer and fix-wave briefs - where scope was decided |
| `worklist-drift-findings.md` | the DRIFT FLAGS section of `sdd/worklist.md` |

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- **The reference half of `sdd/worklist.md`.** Its own header says "every
  quotation below is byte-exact from the live tree at the stated `file:line`";
  it ran 61KB at 36% inside code blocks, with `## 0. DRIFT FLAGS` on top at 12%.
  Findings kept, quotation dropped.
- `sdd/spec-r*-code-reference.md` - **the mission had already split these
  itself**, naming them `-code-reference` and leaving them in ignored space.
- `sdd/reports/s2-timing-raw.md` - self-labelled "gitignored reference",
  byte-for-byte captured output. Its distillation is tracked at
  `measurements/s2-guard-cost.md`.
- `sdd/drafts/s7-texts.md` - self-labelled "orchestrator scratch - NOT committed
  as-is", with ALL-CAPS placeholders still unfilled.
- `sdd/handback.md` - the worktree copy is an EARLIER, smaller draft (12.7KB)
  than the committed `handback.md` (17.7KB). The tracked one wins; the draft was
  not copied over it.
- `sdd/progress.md` - the dispatch ledger. Run state.
