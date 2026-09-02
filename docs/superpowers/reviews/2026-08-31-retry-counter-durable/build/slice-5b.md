# Slice 5b - the two app-invented close codes, registered BEFORE they exist

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `6cc7e9c9` (main already merged at `8c8b7100`; no further
sync performed).

Commits:

- `0d031710` feat(dashboard): register the two fan-out close codes as operator prose
- `5298bbcb` test(dashboard): the two close codes read as prose in all FOUR positions
- `8ffbfce6` docs(e2e): the two tailless close codes in the row-string contract
- (this report, committed separately)

Dashboard-only. No `app/src` change; nothing emits either code yet - slices 2
and 3 do. 5b runs first so the raw token is never reachable in the product.

---

## 1. What shipped

### `dashboard/src/routes/contact/deliveryStatus.ts`

- `:628` and `:629` - the two new `INTERNAL_CODE_REASONS` entries, beside the
  pre-existing `contact_opted_out` at `:627`. The map literal is `:626-630`.
- `:609-624` - the header comment gained three paragraphs: what the two codes
  mean and which job writes each, why they stay distinct (D10), why
  `enqueue_failed` names no cause, and why - unlike `contact_opted_out` - they
  get no per-position interception, so one sentence has to serve four surfaces.

The exact strings, verbatim:

    transient_cap:  Sending gave up after repeated carrier deferrals
    enqueue_failed: Sending could not be scheduled

Both are the worklist RULING's copy, taken unchanged. They match the
neighbouring entry's register (a plain sentence, no terminal period, ASCII
hyphen if a separator is ever needed) and read correctly in every position:

- rollup - `delivered 1/3 - 2 failed - Sending gave up after repeated carrier deferrals`
- row - `Failed - Sending could not be scheduled`
- recital - `Lars Landlord: Failed, Sending gave up after repeated carrier deferrals.`
- badge - `Failed <em dash> Sending could not be scheduled`

**No code was added for the missing tail.** `deliveryReason` consults
`INTERNAL_CODE_REASONS` first and EARLY-RETURNS (`deliveryStatus.ts:650-651`),
so a registered code skips the `(error <code>)` template and the `media` chain
by construction. Adding a branch would have been a second, weaker mechanism for
something the file already guarantees.

`ERROR_CODE_REASONS` and `MMS_ERROR_CODE_REASONS` were NOT touched - that is
slice 5a. The em dash on the 1:1 30003 entry (`:544`) and the one in
`DeliveryBadge.tsx:35` are untouched and were not copied; every added line in
this slice is ASCII, verified by a codepoint scan of the diff's `+` lines (178
added lines, zero above U+007F).

### `e2e/support/selectors.md`

One sentence appended to the per-recipient-row row (`:49`). That line is the
harness's single source for what a failed row reads and it promised "the reason
and raw code appended" on every failure - now false for these two codes, which
render with NO tail. **It did need the change**: a spec written against the old
contract would look for a code that is deliberately absent. The note names both
codes, both strings, and says the tailless reading holds equally on the rollup,
the recital and the badge.

---

## 2. The four positions, each proven

Research finding F3 is right that the plan's test line under-counts: the codes
are written into recipient SLOTS, so they surface at four sites, not three.

| # | position | site | test file : name |
|---|---|---|---|
| 1 | relay/broadcast rollup | `deliveryStatus.ts:416` | `deliveryStatus.test.ts:350` "summarises a capped fan-out in operator prose, with no carrier-code tail" and `:367` "summarises a never-scheduled fan-out distinctly from a capped one" |
| 2 | accessible-name recital | `Timeline.tsx:582` | `Timeline.delivery.test.tsx:372` / `:403` - the `toHaveAccessibleName` assertion inside each |
| 3 | per-recipient row | `Timeline.tsx:1045` | `Timeline.delivery.test.tsx:372` "reads a CAPPED fan-out row as operator prose, with no carrier-code tail" and `:403` "reads a NEVER-SCHEDULED fan-out row distinctly, also without a tail" |
| 4 | broadcast results badge | `DeliveryBadge.tsx:31` | `StatChips.test.tsx:127` "renders the two fan-out close codes as prose, never as an error number" (there is no `DeliveryBadge.test.tsx`; the badge's tests live here) |

Positions 2 and 3 are asserted in the SAME test on purpose - one slot code feeds
both, and the file's existing media test pins them together the same way.

Base-level coverage, `deliveryStatus.test.ts`: `:670` "renders the two fan-out
close codes as operator prose, never as an error number" (exact strings, no
`(error `, no raw token, and the two do not converge - D10) and `:687` "reads
the close codes identically on an attachment leg" (the early return makes them
immune to the MMS hedge; a ladder close is our reason, not the carrier's).

Every one of the seven new cases asserts the absence of the literal substring
`(error ` and of the raw token in the rendered output. Row and rollup
assertions use EXACT text, never a substring, matching the file's own stated
rule - the question is WHICH sentence renders.

---

## 3. TDD - the RED run

Tests were written first and run against the unmapped map.

    .superpowers/gates/s5b-red.log   exit 1
    Test Files  3 failed (3)
    Tests  7 failed | 101 passed (108)

Every failure printed the D22 defect verbatim. From the log, the rendered row:

    Failed - Delivery failed (error transient_cap)
    Failed - Delivery failed (error enqueue_failed)

The seven RED failures were exactly the seven new cases; no pre-existing case
moved. Implementation then landed and the same three files went green.

---

## 4. Gates

Fast gates only, per the slice dispatch. No `npm test`, no `npm run e2e`.

    npm run typecheck  (worktree root)          exit 0
      .superpowers/gates/s5b-typecheck.log - all six workspaces, no output

    npx vitest run <the three touched files>    exit 0
      .superpowers/gates/s5b-green.log
      "Test Files  3 passed (3)"
      "Tests  108 passed (108)"

Gate 5 (eslint) was not run: it is the orchestrator's branch-level gate and the
touched-file list is the branch's, not this slice's.

---

## 5. Deviations

**None from the worklist ruling.** The copy is the ruling's, unchanged.

Two judgement calls worth naming:

- **Commit order is implementation-then-tests**, matching the branch's own
  precedent (`1dd28853` then `18e4a00b`), so every commit on the branch is
  green. The TDD ORDER was honoured in execution - RED captured in
  `s5b-red.log` before the implementation existed - which is what the evidence
  is for. A knowingly-red commit would poison bisect on a shared branch.
- **No new branch was added for the missing tail.** See section 1.

---

## 6. What slices 2 and 3 must know

1. **Use these two codes EXACTLY, lowercase, underscored:** `transient_cap` and
   `enqueue_failed`. They are map KEYS now. A near-miss (`transientCap`,
   `enqueue-failed`) silently falls through to
   `Delivery failed (error <token>)` - the defect this slice removes - and no
   test in this slice would catch it, because these tests assert the presenter,
   not the emitter. Assert the literal code in the job tests.
2. **The distinction is load-bearing (D10).** `transient_cap` is "the ladder
   spent its passes with legs still deferred"; `enqueue_failed` is "the
   continuation was never scheduled". Close A and close B both take
   `transient_cap`; only the enqueue try/catch (close C) takes
   `enqueue_failed`. Writing `transient_cap` on a scheduling failure tells an
   operator retries ran when none did, and the copy now states that difference
   out loud.
3. **`enqueue_failed`'s copy promises no cause on purpose** (worklist RULING
   broadcast #8): the same close fires from the MAX_HOP_COUNT and no-adapter
   guards in `jobs.ts`, not only from a dead queue. Do not "improve" it later to
   name the queue.
4. **The codes must land on the recipient SLOT** (`recordRecipient` /
   `markRecipient`) with `status: 'failed'`. That is what makes
   `presentDeliveryStatus` return `isFailure: true` and the reason render at all
   four positions. A code written to the message-level `error_code` instead
   would reach a FIFTH position (`Timeline.tsx:849`) that nothing here covers.
5. **No dashboard type change was needed and none was made** - confirmed, not
   assumed (research F9). `fanout_attempt` is a top-level app-item attribute
   (D2/D3), never a slot field, and the dashboard's `Message` /
   `TimelineMessage` are hand-mirrored subsets, so an extra wire property is
   invisible to `npm run typecheck`.
6. **5a has not run.** `ERROR_CODE_REASONS` still reads
   "Phone unreachable <em dash> will retry" for 30003, and that line is
   byte-untouched here.
