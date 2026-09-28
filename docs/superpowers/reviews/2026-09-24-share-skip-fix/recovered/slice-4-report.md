> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/slice-4-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Slice 4 report - Tasks 10 + 11 (dashboard reasons; "Not sent" label)

Run state (git-ignored, not committed). Worktree `W:\tmp\share-skip-fix`,
branch `feat/share-skip-fix`, started at HEAD `ea0f5318`, merge base `bbaad87d`.

Commits:
- `e4fb6085` feat(dashboard): a reason on every skipped and failed share row (spec D7)
- `3d644264` feat(dashboard): an all-skipped share reads Not sent (spec D6)

Trailer on both: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
(the session's attribution reminder names that model).

Baseline before any edit: `npx vitest run src/routes/broadcasts` -> 11 files,
147 tests passed, exit 0.

## Pins checked before building (no STOP condition hit)

- `deliveryReason(errorCode: string | undefined, opts: DeliveryReasonOptions = {}): string | undefined`
  - matches the plan. Outputs pinned by the new test and seen green:
  `30007` -> `Carrier filtered the message (error 30007)`; `transient_cap` ->
  `Sending gave up after repeated carrier deferrals`; `enqueue_failed` ->
  `Sending could not be scheduled`; `30003` starts `Phone unreachable`.
- Own-property helper is `ownReason(map: Record<string, string>, code: string): string | undefined`,
  module-private function declaration (hoisted) - same name/shape as the plan.
- `BroadcastResults.tsx` renders the pill inside `<header className={styles.header}>`
  (in `div.headTop` beside the h1). Confirmed.

## Task 10 - every skipped and failed row says why (spec D7) -> e4fb6085

Files: `dashboard/src/routes/contact/deliveryStatus.ts` (SHARE_SKIP_REASONS,
LEGACY_SHARE_SKIP_REASON, exported `shareSkipReason`, inserted right after
INTERNAL_CODE_REASONS, reads through the existing `ownReason`; additions only,
numstat 31/0), `dashboard/src/routes/broadcasts/broadcastFormat.ts`
(`shareRecipientReason` after `presentRecipientStatus`; imports `deliveryReason` +
`shareSkipReason`), `DeliveryBadge.tsx` (reason = `shareRecipientReason(status, errorCode)`;
import of `deliveryReason` replaced by `import type { DeliveryTone }` + `shareRecipientReason`),
`broadcastFormat.test.ts` (import adds ONLY `shareRecipientReason`), `StatChips.test.tsx`.

Not touched (forbidden): `deliveryReason`, its options/order, the 30003 wording,
INTERNAL_CODE_REASONS, the message catalog. `presentShareLabel` NOT imported in Task 10.

Red seen (`npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/StatChips.test.tsx`, exit 1):
- broadcastFormat.test.ts: 4 failed, each `TypeError: (0 , shareRecipientReason) is not a function`.
- StatChips.test.tsx: 2 failed:
  - `share-skip-fix D7: a skipped row appends its reason, ...` ->
    `Unable to find an element with the text: /Automatic texts were off for this conversation/.`
  - `share-skip-fix D7: a failed row with no code reads Delivery failed ...` ->
    `Unable to find an element with the text: /Delivery failed/.`
- Replaced test: `shows just the Failed label when no error code is supplied`
  (was at StatChips.test.tsx:161-165 - slice 2's skipped_other chip test pushed it
  down from the plan's :154-158; replaced by title). Note: its two assertions
  (`getByText('Failed')`, no `/error/i`) would still have passed after the change -
  only its title became false. The real red-to-green is the replacement test, which
  keeps the `/error/i` absence check and failed on `/Delivery failed/` before the
  implementation.

Green:
- Two files: 2 files, 29 tests passed, exit 0.
- Folder `src/routes/broadcasts`: 11 files, 152 tests passed, exit 0.
- `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped`:
  passed (verbose run of StatChips.test.tsx, 13/13, exit 0).
- Neighbour `src/routes/contact/deliveryStatus.test.ts`: 137 passed, exit 0.
- `npm run typecheck`: exit 0.
- `npx eslint <the 5 Task 10 files>`: exit 0, no output.

## Task 11 - a share that reached nobody reads "Not sent" (spec D6) -> 3d644264

Files: `broadcastFormat.ts` (`BroadcastStats` added to the type import;
`presentShareLabel` placed right after BROADCAST_STATUS_TONE),
`BroadcastStatusPill.tsx` (optional `stats` prop, delegates to `presentShareLabel`),
`BroadcastsList.tsx:144` (`stats={row.stats}`), `BroadcastResults.tsx:138`
(`stats={results.stats}`), `broadcastFormat.test.ts`, `StatChips.test.tsx`.

Red seen (same two-file command, exit 1; `Tests 3 failed | 29 passed (32)`):
- broadcastFormat.test.ts: 2 failed, each `TypeError: (0 , presentShareLabel) is not a function`.
- StatChips.test.tsx: 1 failed (`share-skip-fix D6: with stats, ...`) ->
  `Unable to find an element with the text: Not sent.` (the pill had no `stats` prop).

Green:
- Two files: 2 files, 32 tests passed, exit 0.
- Folder `src/routes/broadcasts`: 11 files, 155 tests passed, exit 0 (the existing
  pill test renders without `stats` and still sees the four plain labels).
- `npm run typecheck`: exit 0.
- `npx eslint <the 6 Task 11 files>`: exit 0, no output.

## Slice gates (after both commits)

- `npm run typecheck` -> 0 (post-Task-11 run; tree identical to 3d644264).
- `npm run smoke` -> 0: `smoke-dist: OK - 1413 import specifier(s) across 248 emitted file(s) resolve under plain Node.`
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  (35 files; main = cd8e8ddd, merge base bbaad87d) -> exit 1, output verbatim
  except the summary line's leading non-ASCII cross mark, dropped here:
  ```
  W:\tmp\share-skip-fix\app\src\lib\seed\matrix.ts
    134:7  error  'DEADLINE_TYPES' is assigned a value but only used as a type. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

  W:\tmp\share-skip-fix\app\test\importApply.integration.test.ts
    745:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
    824:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

  3 problems (3 errors, 0 warnings)
  ```
  All three are the brief's named pre-existing errors; none is on a slice-4 file.
- ASCII, `git diff -U0 bbaad87d..HEAD -- <file> | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c`:
  0 for each of deliveryStatus.ts, broadcastFormat.ts, broadcastFormat.test.ts,
  DeliveryBadge.tsx, StatChips.test.tsx, BroadcastStatusPill.tsx, BroadcastsList.tsx,
  BroadcastResults.tsx.
- Not run (per brief): full `npm test`, `npm run e2e`, `npm run e2e:session`.
- `git status` clean after the second commit; `.git/MERGE_HEAD` absent before both commits.

## Deviations (all adjudicated or cosmetic)

- N4 (Task 10): rewrote `DeliveryBadge.tsx` errorCode prop doc (was :24-25, "Absent ->
  just the status label") and `broadcastFormat.ts` :83-86 ("`skipped` has no comms
  equivalent (opted out between resolve + send)"), both ASCII. The new broadcastFormat
  wording says a skip means nothing was sent (a fan-out fence or the send wrapper
  refused the recipient) and points at shareRecipientReason.
- DeliveryBadge header (plan: lines 1-5) rewritten whole in ASCII with the
  "plus the reason a skipped or failed recipient was not reached" clause; "colour"
  became "color" in those rewritten lines (American spelling). Rendered text is
  unchanged: the " \u2014 <reason>" em dash at DeliveryBadge.tsx:35 was NOT touched
  (Task 14's e2e reads "Skipped/Failed \u2014 <reason>").
- N5 (Task 11): did not paste the plan's full-file BroadcastStatusPill listing; kept
  the header - line 1 ASCII (em dash -> hyphen), line 4 extended plus one new line:
  "With `stats`, an all-skipped finished share reads "Not sent" (share-skip-fix D6)."
  Lines 2-3 unchanged (ASCII already). The code below the header is the plan's listing.
- broadcastFormat.test.ts: `BroadcastStats` added to the existing
  `import type { BroadcastRecipient }` line rather than a second import line (worklist
  preference); `stats()` helper + describe appended as written.

## Noticed, not changed (outside this slice's files or forbidden)

- `dashboard/src/api/types.ts:2954` - `BroadcastRecipient.errorCode` doc still says
  "Twilio error class on a failure (mapped to a reason for display)"; since Task 6 it
  also carries skip codes. Same file :2900 - `skipped_opted_out` doc says "opted out
  between resolve + send"; it now also holds reason-less legacy skips. Doc-only drift
  in a Task 6 file.
- `dashboard/src/routes/contact/deliveryStatus.ts` - the ERROR_CODE_REASONS doc
  (:772-776) and deliveryReason's doc (:937-941) say an absent code means the caller
  shows just "Failed". Still true for the Timeline callers; the share badge now shows
  "Delivery failed" via shareRecipientReason. Left alone (deliveryReason is RSW/SOR's
  merge point and forbidden here).
- DeliveryBadge now also sets the `title` attribute on skipped rows (the existing
  `reason && { title: reason }` spread) - intended, noted for the reviewer.
- A failed row with `contact_opted_out` would read INTERNAL_CODE_REASONS' group
  sentence ("Everyone here has opted out - nothing was sent") via deliveryReason; the
  fan-out records opt-out refusals as SKIPPED, so a share row should never hit that
  path. Plan contract followed as written.
