# S4 report - Tasks 13 and 14 (Slice E): the dashboard

Dispatch S4 of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, base f01dd7d8, HEAD b78186e6; tree
clean; every gate green.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its own checkpoint appended, per AGENTS.md.

## Commits (on top of f01dd7d8)

- `8defb6c8 feat(dashboard): Not confirmed by code alone, the new internal codes' copy, and a queued leg that ages from its attempt clock` - Task 13 (D20, D20a, D21, D23, the mirror test, the A6 comments in `Timeline.tsx`).
- `216f2fd6 feat(dashboard): the Not confirmed bucket and chip, the unconfirmed recipient row without a retry hint, seeds carry the bucket` - Task 14 (D22).
- `b78186e6 test(dashboard): S4 mutant pass - Not confirmed is keyed on the code on every roster, not only relay` - one extra test killing the only survivor.
- Totals: 18 files, 918 insertions, 65 deletions. Every commit has the
  Co-Authored-By trailer; bare `git status` read first, no MERGE_HEAD,
  explicit paths only, 0 non-ASCII bytes in added lines.

## What was built (line numbers at b78186e6)

**D20 - "Not confirmed" decided by the code alone**
- The dashboard copies of the four codes: `dashboard/src/routes/contact/deliveryStatus.ts:101-104` (deviation 2).
- `SEND_UNCONFIRMED_REASON` is one string at `:109`, shared by the
  presentation and the reason map so the two cannot drift.
- `NOT_CONFIRMED_PRESENTATION` (exported) at `:122`: label `Not confirmed`,
  tone `danger`, `isFailure: false`, reason `Couldn't confirm whether this text
  went out` with no trailing period.
- `presentLegDelivery` checks the code first at `:803`, right after the
  `contact_opted_out` arm and before the retry states and staleness; it
  applies to any status and any roster kind, and carries its own reason.
- The broadcast recipient row: `presentRecipientStatus` takes `errorCode` as
  a new third parameter (`dashboard/src/routes/broadcasts/broadcastFormat.ts:133`)
  and checks the code first (`:140`); `DeliveryBadge.tsx:35` passes the code
  through.
- `relayRetryJoin.ts` needed no logic change; tests pin that the join
  projects the code with the original's status, and that the identity
  projection keeps `attemptedAt`.

**D20a - a queued leg ages from our attempt clock**
- `stalenessClockMs` queued arm (`deliveryStatus.ts:301`): `legClock ??
  parseWireClock(slot.attemptedAt)`. The provider's `sentAt` wins; with
  neither clock the leg never ages; a `sentAt` that does not parse falls
  through to `attemptedAt` (pinned).
- `attemptedAt?` added to `RelayDeliverySlot` (`:211`) and to the dashboard
  `RelayRecipientDelivery` type (`dashboard/src/api/types.ts:1777`).
- Comment rewrites: the S3 table (`:251-252`) and its explanation (`:272-282`)
  - the false "the server's own staleness alarm covers it" sentence is gone;
  the comment now cites `docs/issues/relay-staleness-alarm-assumed-not-built.md`;
  the slot doc (`:193-205`) and the futurity doc (`:357-360`);
  `Timeline.tsx` ticker clause 2 (`:810-817`) and clause 5 (`:823-824`), per
  ruling A6.

**D21 - the relay rollup (T13-2)**
- K (failed) excludes the code on its first line (`:560`); R (retrying)
  excludes it (`:571`); J (not confirmed) includes it on its first line
  (`:586`), with no clock and no `retryAware` needed; the branch-2 reason join
  includes the code (`:661`). The related doc claims were amended (the K/J
  "disjoint by construction" text, the withheld-clock text, the `retryAware`
  collapse, the disjointness comment).

**D22 - the broadcast bucket and row**
- `BroadcastStats.unconfirmed?` at `types.ts:2925`; the bucket-sum doc names it.
- `StatChips.tsx:38`: a "Not confirmed" chip right after Failed, read as
  `?? 0`, danger-toned only above zero; the header doc updated (T14-6).
- `skippedTotal` unchanged; its doc says the bucket never joins it
  (`broadcastFormat.ts:113`).
- `BroadcastResults.tsx:55-57` adds `showRetryHint`, used at `:71`; the failed
  styling (`:81`, `:93`) and the sort in `toRecipientViews` still key on
  `status === 'failed'`; the row stays a link to the contact.
- Seeds get `unconfirmed: 0`: `app/src/lib/seed/matrix.ts:1228` and `:1252`,
  `app/src/lib/seed/performance.ts:1006`; the U+2014 lines `:1218` / `:1250`
  are untouched.

**D23 - new codes read as prose**
- `INTERNAL_CODE_REASONS`: `transient_cap` now "Sending gave up after repeated
  temporary errors" (`:1044`); new entries for `send_unconfirmed`,
  `redrive_refused` and `sms_sending_disabled` (`:1047-1049`), keyed by the
  copied constants.
- `deliveryReason` returns nothing for `send_retryable` via an explicit early
  return (`:1134`); an unmapped provider code still renders `Delivery failed
  (error 21211)`.

**Mirror test** - new `dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts`
pins the four codes to `app/src/lib/sendOutcome.ts`, with the T13-4
non-vacuity floor (each value a non-empty string, the four distinct, the
`_other` sibling code not answered the same way).

Findings applied: T13-1 through T13-6 and T14-1 through T14-6 (T14-7 was done
by S1c; T14-8 through T14-10 awareness only).

## Deviations

1. The two broadcast `transient_cap` copy pins (`StatChips.test.tsx:152`,
   `broadcastFormat.test.ts:153`) went into the Task 13 commit instead of Task
   14, so each commit is green on its own.
2. The mirror test also pins the `transient_cap` and `enqueue_failed` prose to
   the app's `TRANSIENT_CAP_CODE` and `ENQUEUE_FAILED_CODE`; no dashboard
   constants were added for those two.
3. The three new reason-map keys use the copied constants as computed keys.
4. Tests beyond the plan: the direct-slot three-position case (a relay leg's
   own unresolved close, not only the join); a three-position DOM case for
   D20a; the badge, the sort, `presentShareLabel`, and a group-text row.
5. Assertions on the "Sending..." label compare against the same leg with no
   code, or match `/^Sending/`, instead of a `\u2026` escape: the edit tool
   decoded `\u2026` into the literal character, and the staged ASCII check
   caught it before the first commit.

## Red to green

- Task 13: red 32 failed / 297 passed (329) across 6 files; after
  implementation 329/329. The three route dirs were then 84 files / 1643 tests.
- Task 14: red 6 failed / 161 passed (167) in broadcasts (the other new T14
  cases were already green because they pin behavior that already holds);
  after implementation the three route dirs were 84 files / 1652 tests, and
  the app tests 3 files / 208.

## Mutant spot-check

29 one-line mutants: 28 died on the existing tests, 1 survived and was killed
by a new test. After every mutant the original bytes were restored and
confirmed identical with `cmp`. Runner and results in the session scratchpad
`S4\mut\`.

| Mutant | Change | Killed by |
|---|---|---|
| M01 | `presentLegDelivery` code arm deleted | presents-by-code-alone, plus the two three-position DOM tests |
| M02 | arm only when there is no retryState | K/R/J-disjoint test |
| M03 | arm returns `isFailure: true` | presents-by-code-alone |
| M04 | arm carries no reason | presents-by-code-alone |
| M05 | arm limited to the relay roster | survived; killed by the new group-text row test (b78186e6) |
| M06 | K code exclusion deleted | the join-shape test (T13-5) |
| M07 | R code exclusion deleted | K/R/J-disjoint test |
| M08 | J code inclusion deleted | T13-5 |
| M09 | J inclusion only under retryAware | rollup test with no clock and no retryAware |
| M10 | K exclusion only under retryAware | same rollup test |
| M11 | branch-2 reason join reverted | T13-5 |
| M12 | queued arm reverted | the S3 unit table, the D20a DOM test and the ticker's arming case |
| M13 | `attemptedAt` wins over `sentAt` | sentAt-wins test |
| M14 | queued arm falls back to the message clock | never-stales-queued (the old test) |
| M15 | `attemptedAt` leaks into the sent arm | reads-attemptedAt-ONLY-on-queued |
| M16 | `send_retryable` early return deleted | the D23 `send_retryable` test |
| M17 | `send_unconfirmed` map entry deleted | T13-5 and the DOM tests |
| M18 | trailing period added to `redrive_refused` | the D23 table |
| M19 | `transient_cap` copy reverted | capped-fan-out rollup |
| M20 | `SEND_UNCONFIRMED_CODE` value drift | mirror test and 12 others |
| M21 | `SEND_RETRYABLE_CODE` value drift | D23 test and mirror |
| M22 | `presentRecipientStatus` arm deleted | keys-on-send_unconfirmed-before-status |
| M23 | that arm limited to status failed | same test |
| M24 | `skippedTotal` includes unconfirmed | skippedTotal-never-includes |
| M25 | chip loses its danger tone | chip test (danger only above zero) |
| M26 | chip's missing-bucket default is 1 | legacy-stats test (shows 0) |
| M27 | retry hint ignores the code | unconfirmed-row test |
| M28 | failed row class keyed on the hint | unconfirmed-row test |
| M29 | badge does not pass the code | unconfirmed-row test |

## Gates (exit codes)

- Three dashboard route dirs (`npm run test -w @housingchoice/dashboard --
  src/routes/contact src/routes/conversation src/routes/broadcasts`): exit 0,
  84 files / 1653 tests.
- Whole dashboard workspace (`timeout 590 npm run test -w
  @housingchoice/dashboard`): exit 0, 204 files / 3403 tests.
- App tests (`cd app && npx vitest run test/performanceSeed.test.ts
  test/deriveBroadcastStats.test.ts test/broadcastApi.test.ts`): exit 0, 3
  files / 208 tests, no `[dynamoAdmin]` line.
- Typecheck: exit 0, 0 `error TS`, all five workspaces.
- Lint (`npx eslint` on the 18 touched .ts/.tsx files): exit 1 with exactly
  two errors, both already on HEAD (confirmed by `git show f01dd7d8:<file> |
  npx eslint --stdin`); nothing new: `app/src/lib/seed/matrix.ts:134`
  `DEADLINE_TYPES` unused; `dashboard/src/routes/contact/Timeline.tsx:1580`
  react-hooks set-state-in-effect (it was `:1577` at HEAD; the new comment
  lines shifted it by 3).
- ASCII: 0 non-ASCII bytes in added lines and 0 in removed lines across
  f01dd7d8..HEAD (no pre-existing non-ASCII line touched); the new mirror file
  is 0 as well.

## Contract for downstream (Task 12 e2e and self-QA)

**Relay bubble**
- Rollup chip (role `img`): visible text `delivered 1/2 - 1 not confirmed -
  Couldn't confirm whether this text went out`. Accessible name for the direct
  slot with no `sentAt` (exact): `delivered 1 of 2, 1 not confirmed, Couldn't
  confirm whether this text went out. Keisha Kane: Delivered. Lars Landlord:
  Not confirmed, Couldn't confirm whether this text went out.` When the slot
  has a `sentAt` (the join case keeps the original's), `, <time>` is appended
  to that member's clause.
- Recipient rows: revealed by clicking the bubble body, in `getByRole('list',
  { name: 'Delivery by recipient' })`. The `listitem` accessible name is its
  aria-label `<Name> - Not confirmed - Couldn't confirm whether this text went
  out[ - <time>]`; the state span text is exactly `Not confirmed - Couldn't
  confirm whether this text went out`.
- Inbound relay source: a hidden `group` named `Delivery by recipient. ...`
  recites the same `<Name>: Not confirmed, ...`.
- D20a: a `queued` slot with no `sentAt` and an `attemptedAt` older than 15
  minutes on the browser clock shows row state `Queued - not confirmed`, row
  aria-label `<Name> - Queued - not confirmed` (no time), chip `delivered N/M
  - K not confirmed` with no reason, recital `<Name>: Queued, not confirmed.`;
  on an already-open page the ticker flips it when the 15 minutes pass.
- No position shows `Failed`, `Undelivered`, `Retrying` or `(error
  send_unconfirmed)` for the code.
- Case trap: the chip says lowercase `not confirmed` and the row says `Not
  confirmed`; a case-sensitive `/not confirmed/` does not match the row.

**Broadcast results page**
- Chip: `<dt>` exactly `Not confirmed` (role `term`) with the count in `<dd>`
  (role `definition`), inside `getByLabel('Delivery stats')`. Order:
  Recipients, Delivered, Sent, Sending, Queued, Failed, Not confirmed,
  Skipped. `statValue(page, 'Not confirmed')` works.
- Row, in `getByRole('list', { name: 'Recipients' })`: the badge text is `Not
  confirmed`, followed by the pre-existing U+2014 separator and the reason
  (match the reason by substring); the badge `title` is `Couldn't confirm
  whether this text went out`; the row is a link to `/contacts/<id>` whose name
  contains the tenant name; there is no link named `open conversation to
  retry`; the row is sorted first and keeps the failed class.
- Collision: `Not confirmed` appears both as the chip `<dt>` and as the row
  badge. Scope row reads to the Recipients list and chip reads to the Delivery
  stats list (Playwright strict mode would match both).
- An all-unconfirmed share reads "Failed" on its pill, with `last_error`
  "Couldn't confirm any text went out" (written on the app side, T7).

## Residues and concerns

1. Unreachable double count: a `delivered` status with the `send_unconfirmed`
   code cannot happen today (`ALLOWED_PRIOR` never moves `failed` to
   `delivered`, and the join clears the code on delivered-on-retry); if it
   ever did, the chip would count that member as both delivered and not
   confirmed, because the `delivered` count does not check the code. Not
   changed (outside the plan's K/R/J rule).
2. Mixed chip reason (for confirmation): when a real failure sits beside an
   unconfirmed leg, the chip keeps the existing rule and shows only the failed
   legs' reason, so the D20 sentence is not on that chip (the row carries it).
   This matches the plan, which widens only the branch-2 join, but D20 says
   the chip carries the reason too.
3. Stale doc left alone: the `DeliveryPresentation.reason` doc
   (`deliveryStatus.ts:30-36`) was already false before this work (Retrying,
   internal codes) and is also false now for Not confirmed; not on T13-3's
   list, so not edited.
4. For S6 (Task 15): the corrected comment that
   `relay-staleness-alarm-assumed-not-built` is about is now at
   `deliveryStatus.ts:251-252` (table) and `:272-282` (explanation); the issue
   refs still point at the old `:202`, `:217`, `:221`. The refs in
   `send-attempt-sweeper` (`:221`) and
   `relay-continuation-early-return-strands-slots` (`:202`) are stale the same
   way.
5. Same token, two sentences: a failed `sms_sending_disabled` row reads "SMS
   sending is switched off, so nothing was sent", while a skipped one reads
   "Texting is turned off" (the wording the spec chose, T14-9).

## Orchestrator checkpoint

Verified at b78186e6: protected files untouched; 0 non-ASCII bytes in the
added AND removed lines; `npm run typecheck` EXIT=0 with 0 `error TS`; the
three dashboard route dirs re-run EXIT=0 (84 files, 1653 tests). Concern 2
(mixed chip reason) goes to the review phase as item R-d; concern 4 is handed
to S6 (Task 15). Gate 5 note: the two lint errors are pre-existing
(`matrix.ts:134`, `Timeline.tsx` set-state-in-effect) and will be attributed
by baseline comparison at the final gate.
