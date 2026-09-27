# Build research R4 - dashboard, seeds, issues: live-tree drift FINDINGS

Read-only drift check of plan revision 4
(`docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md`) Tasks 13, 14
and 15 against the worktree `W:\tmp\send-outcome-reconcile` at HEAD 1280058f,
2026-09-26. The code is identical to a9f411f3 (`git diff --stat a9f411f3 HEAD --
app dashboard fake-twilio e2e scripts` is empty), so every plan anchor was
checked against the live file. Spec read for intent: revision 11, D20-D23, Sec 9.

This file holds FINDINGS only: where the plan's instructions, code or test
sketches would not work as written against the live tree, or omit something.
Byte-exact quotes (real signatures, fixture and helper shapes, the red-pin
lines, the issue frontmatter, the reader sweep with dispositions, the verified
commands) are in the gitignored reference
`.superpowers/sdd/build-dashboard-issues-reference.md`.

Severity: BLOCKING = the task cannot be executed as written or would fail its
gate; FIX = a wrong name, anchor, pin or omission the implementer must be told;
NOTE = a risk or awareness item.

Totals: 0 BLOCKING, 9 FIX, 13 NOTE.

## Task 13 - codes, copy, D20a aging, rollup K/J, the join, the mirror

**T13-1 FIX - the D20a sketch names fixtures that are not where it puts them.**
`L0` and `NOW` are consts LOCAL to the describe `isStaleLeg / canEverGoStale -
the S3 eligibility table` (`dashboard/src/routes/contact/deliveryStatus.test.ts:101-285`,
declared at `:104-105`); every other describe declares its own clock (`R0` at
`:473`, `P0` at `:965`, `V0` at `:1195`). `STALE_QUEUED_EXPECTATION` exists
nowhere in the dashboard. Written as a new top-level describe, the sketch throws
a ReferenceError at Step 1 (a false "FAIL") and fails
`npm run typecheck -w @housingchoice/dashboard` at Step 3.
Corrected instruction: add the three D20a cases INSIDE the S3 describe, before
its closing `});` at `:285` (`L0`, `NOW`, `QUIET`, `FRESH`, `ANCIENT_MS` are in
scope there); write the stale expectation as the file's inline literal
`{ label: 'Queued - not confirmed', tone: 'danger', isFailure: false }` (the
idiom at `:1055-1060`); add the new row to the S3 table comment at `:91-100`
and a `canEverGoStale` true case beside `:174-181`.

**T13-2 FIX - "notConfirmedLegs includes any leg with it" leaves R untouched,
which breaks K/R/J disjointness in one shape.** The join's live-rung step keeps
the ORIGINAL's code (`dashboard/src/routes/contact/relayRetryJoin.ts:386`,
`return { ...slot, retryState: 'retrying' };`), and R is
`retryStateOf(s) === 'retrying'` (`deliveryStatus.ts:490`). A leg carrying both
`send_unconfirmed` and `retrying` would count in R and, with a code-first J, in
J - "1 retrying, 1 not confirmed" for one member - while its row, whose new arm
sits before the retry states (`:689-700` then `:725`), reads "Not confirmed".
The file calls the disjointness load-bearing (`:507-513`). Unreachable today (a
rung is claimed off a 30003 status callback, which needs a SID an unresolved
close never has), hence FIX, not BLOCKING.
Corrected instruction: K (`:483`) gains
`if (s.errorCode === SEND_UNCONFIRMED_CODE) return false;` as its FIRST line;
R (`:490`) becomes
`fanned.filter((s) => s.errorCode !== SEND_UNCONFIRMED_CODE && retryStateOf(s) === 'retrying')`;
J (`:499-500`) gains `if (s.errorCode === SEND_UNCONFIRMED_CODE) return true;`
as its FIRST line, before `retryStateOf` (code alone: no clock, no
`retryAware`, the same precedence as the row presenter); the branch-2 reason
filter (`:567-569`) as planned.

**T13-3 FIX - doc claims this task falsifies that the plan does not list.** The
plan names only the S3 table row and the `:213-224` rationale. Also false after
T13: `deliveryStatus.ts:150-156` (the RelayDeliverySlot doc names two clocks;
add `attemptedAt` = OUR attempt clock, best-effort, never a provider
timestamp); `:296-301` ("Every ageing clock here is the PROVIDER's" -
`attemptedAt` is our server clock; the futurity reasoning holds, the sentence
does not); `:417-425` (K and J disjoint "by construction", and "with `nowMs`
undefined this cannot select the not-confirmed branches at all" - a
`send_unconfirmed` leg now selects J with no clock); `:451-456` (`retryAware`
off "collapse to exactly the two"); `:507-513` (the disjointness rationale);
`dashboard/src/routes/contact/Timeline.tsx:810-812` (ticker clause 2: "a
`queued` leg with no `sentAt` is BOTH for ever" - now only with no
`attemptedAt` either) and `:820-821` (clause 5: "the ageing clocks are the
PROVIDER's"). `Timeline.tsx` is not in T13's file list: either amend those two
comments and add the path to the commit, or leave them and name them in the
handback. Also qualify the test title at `deliveryStatus.test.ts:613` ("cannot
select the not-confirmed branches at all when the clock is withheld") - still
green, but no longer true for a code-carrying leg. Every line named here is
ASCII.

**T13-4 NOTE - the mirror sketch drops the precedent's non-vacuity floor.**
`relayWindowCloseMirror.test.ts:32-39` asserts the app value is a non-empty
string and that a sibling code is not answered alike. Add
`expect(typeof APP_X).toBe('string')` and `expect(APP_X.length).toBeGreaterThan(0)`
for each of the four app constants in `sendOutcomeCodesMirror.test.ts`.

**T13-5 NOTE - K/J pair coverage is thin (prior research C1).** The planned
unit case is `failed` with no clock and no `retryAware`; the join's real shape
(`undelivered`, `retryState: 'terminal'`, clock on, `retryAware` on) is covered
only through the DOM three-position case. Add one `presentRelayDelivery` case in
the retry-aware describe (`deliveryStatus.test.ts:1193`, its `RETRY_OPTS`,
`NOW`, `MSG_AT`) with a leg
`{ status: 'undelivered', errorCode: 'send_unconfirmed', retryState: 'terminal' }`
expecting `delivered 1/2 - 1 not confirmed` and no `failed` in the label.

**T13-6 NOTE - ASCII on touched lines.** Every T13 code edit point in
`deliveryStatus.ts` is ASCII. Nearby non-ASCII lines are docblocks: `:28` (the
`isFailure` doc, U+2014), `:403-409` (the presentRelayDelivery rules, U+2192 /
U+2014 / U+21D2), `:992-994` (the deliveryReason doc, U+21D2); and
`dashboard/src/api/types.ts:1754` (the RelayRecipientDelivery mirror comment the
plan says to touch, U+2014). Add new doc lines beside them; do not rewrite them.
The T13 test files are ASCII except `deliveryStatus.test.ts:29, :44, :48, :297,
:313, :435, :945`, none of which is a pin T13 moves.

## Task 14 - the bucket, chip, badge, hint and seeds

**T14-1 FIX - wrong seed anchors.** `app/src/lib/seed/matrix.ts:1229-1231` is the
`recipients` block and `:1252` is `recipients: {},`. Live: the
`broadcast-mx-sent-01` stats literal is `:1219-1228` (add `unconfirmed: 0,`
after `queued: 0,` at `:1227`); the draft's one-line stats is `:1251`. The two
`body_template` lines, `:1218` and `:1250`, carry U+2014 - do not touch them.
`app/src/lib/seed/performance.ts:995-1009` is correct.

**T14-2 FIX - the StatChips sketch uses helpers that do not exist or do not
return what it expects.** There is no `labels()` helper (the order is read
inline at `dashboard/src/routes/broadcasts/StatChips.test.tsx:78-80`); `list` is
never declared (the idiom is `const list = screen.getByLabelText('Delivery stats')`);
`chipValue(list, label)` (`:26-28`) returns the chip div's `textContent` STRING,
label included ("Not confirmed1"), so `.toBe(1)` fails for ever - use
`expect(chipValue(list, 'Not confirmed')).toContain('1')` (the idiom at
`:66-72`). The "danger only above zero" and "no danger class" halves need
`import styles from './StatChips.module.css'` and `toHaveClass(styles.danger!)` /
`not.toHaveClass(styles.danger!)` on
`within(list).getByText('Not confirmed').closest('div')` (precedent
`dashboard/src/app/AppFrame.test.tsx:9`, `:115-116`). `stats()` defaults
`sent: 2` and `queued: 2` (`:12-23`), so
`stats({ audience: 4, delivered: 2, failed: 1, unconfirmed: 1 })` sums to 8, not
4 - pass `sent: 0, queued: 0` if the title keeps "keeps the audience sum". The
order test's title at `:75` lists the old order; retitle it with the pin.

**T14-3 FIX - `skippedTotal` is not imported.**
`dashboard/src/routes/broadcasts/broadcastFormat.test.ts` imports eight helpers
at `:6-15`, not `skippedTotal`; the sketch's `skippedTotal never includes
unconfirmed` is a ReferenceError and a typecheck error until it is added to
that import list. The file's own `stats()` (`:170-172`, zero skip buckets)
makes the expected 0 hold.

**T14-4 FIX - the BroadcastResults sketch has three traps.** (a) The page
renders "Not confirmed" twice - the StatChips `<dt>` and the badge label - so
`screen.getByText('Not confirmed')` throws a multiple-match error; scope every
row read to `within(await screen.findByRole('list', { name: 'Recipients' }))`
(the file's idiom; the same collision is recorded for "Sending" and "Sent" at
`dashboard/src/routes/broadcasts/BroadcastResults.test.tsx:184-189`, `:206-208`).
(b) With `{ c1: unconfirmed, c2: delivered }` insertion order already puts c1
first, so "c1 sorted first" proves nothing: insert the delivered row first
(`{ c2: { status: 'delivered' }, c1: { status: 'failed', errorCode: 'send_unconfirmed', firstName: 'Ana' } }`)
and assert the first `listitem` holds 'Ana'. (c)
`queryByRole('link', { name: /open conversation to retry/i })` is also null when
the row stops being a link at all: pair it with
`getByRole('link', { name: /Ana/ })` having `href` `/contacts/c1` (D22: the row
stays a link). For "keeps the failed styling", assert the `li` has
`styles.recipientFailed` (import `./BroadcastResults.module.css`).

**T14-5 NOTE - BroadcastResults.tsx has no sort.** The failures-first sort is
`toRecipientViews` (`dashboard/src/routes/broadcasts/broadcastFormat.ts:206-210`),
keyed on `status === 'failed'`, which the unconfirmed row keeps; no sort edit is
needed anywhere. The only RecipientRow change is the hint condition: keep
`failed` (`BroadcastResults.tsx:48`) for the class at `:73` and `:85`, add
`const showRetryHint = failed && row.errorCode !== SEND_UNCONFIRMED_CODE && row.contactId !== undefined;`
and use it at `:63` (ASCII). Import `SEND_UNCONFIRMED_CODE` from
`'../contact/deliveryStatus.js'` rather than writing the literal
`'send_unconfirmed'` (declared deviation 2). A `failedStyle` alias left unused
trips `no-unused-vars` at gate 5. Do not touch `:66` (U+2197; the hint is the
link's accessible name) or the doc lines `:9-10`, `:45`, `:74-75` (non-ASCII).

**T14-6 NOTE - doc lines the plan does not name.** `StatChips.tsx:2` (the chip
list) gains "Not confirmed" beside the `:5-6` balance line the plan names (both
ASCII; `:1` and `:16` are not). `dashboard/src/api/types.ts:2907-2908` (the
BroadcastStats bucket-sum doc) gains `+ unconfirmed` (ASCII). The
presentRecipientStatus docblock `broadcastFormat.ts:113-125` has non-ASCII at
`:121`, `:123`, `:124`: the new errorCode parameter, its first-line arm and any
doc go on NEW lines, and `:136` / `:140` (`'Sending'` + U+2026) stay untouched.

**T14-7 NOTE - app bucket-sum proofs outside the plan.** `bucketsSumToAudience`
(`app/test/broadcastFanOut.test.ts:1117-1129`, used at `:1147`, `:1189`, `:1205`)
and the S4 sum (`app/test/broadcastApi.test.ts:386-397`) omit `unconfirmed`; the
plan extends only `app/test/deriveBroadcastStats.test.ts:93-123`. They stay
green on today's fixtures but stop proving D22's audience sum, and any T7 test
that runs `bucketsSumToAudience` over an emit carrying a
`failed`/`send_unconfirmed` slot FAILS. Owner T6/T7: add `(s.unconfirmed ?? 0)`
to both sums.

**T14-8 NOTE - the app run needs DynamoDB Local.**
`cd app; npx vitest run test/performanceSeed.test.ts test/deriveBroadcastStats.test.ts`
runs `app/test/globalSetup.ts`, which THROWS when DynamoDB Local is unreachable,
even for these two pure files. Have `npm run db:start` up (T5/T6 need it anyway)
or prefix `ALLOW_SKIP_DYNAMO_TESTS=1` for this non-gate run.

**T14-9 NOTE - one token, two sentences on one results page.** A SKIPPED
`sms_sending_disabled` row reads 'Texting is turned off' (`SHARE_SKIP_REASONS`,
`deliveryStatus.ts:980`, pinned at `broadcastFormat.test.ts:142`, reached first
through `shareSkipReason` at `broadcastFormat.ts:155`); a FAILED one (the
adapter kill switch, which T1 classifies `rejected` with that code) will read
'SMS sending is switched off, so nothing was sent' from the new internal entry.
Spec D23 chose the wording; awareness for review only.

**T14-10 NOTE - e2e reads.** `statValue(page, label)`
(`e2e/tests/dashboard-next/broadcasts.spec.ts:269-276`) matches the `<dt>`
exactly inside the `Delivery stats` dl, so the new chip collides with no
existing read, and no e2e spec pins any copy T13/T14 change. A T12 or T16 read
of a ROW's "Not confirmed" must be scoped to the `Recipients` list: the chip
label is the same text and Playwright strict mode would match both.

## Task 15 - the issue registry

**T15-1 FIX - a tenth file is owed:
`docs/issues/relay-staleness-alarm-assumed-not-built.md`** (filed by this branch
at 34b4fd47, status open). T13 deletes the exact sentence it is about
(`deliveryStatus.ts:221-223`; its refs cite `:202`, `:217`, `:221`) and builds
its D20a half, and the issue itself says correcting the comment "is the cheap
first step". Add a dated section: the comment is corrected at HEAD (cite the new
lines); a CLAIMED relay leg now ages from `attemptedAt`; a never-claimed leg
(the fan-out never ran) still never ages; the alarm stays with the sweeper;
status stays open. Add the path to T15's `git add`.

**T15-2 FIX - `docs/issues/relay-continuation-early-return-strands-slots.md:24-27`
becomes partly false.** It says the carried slots "never age to 'Queued - not
confirmed'" because they have no `sentAt`. After T13 a carried member that was
claimed keeps `attemptedAt` on a VERSIONED row (child-field write
`applyRecipientSendResult`, `app/src/jobs/relayFanOut.ts:1655`) and ages after
15 minutes; a LEGACY row's whole-slot write (`markRecipient` ->
`setRecipientDelivery`, `relayFanOut.ts:1651-1653`, `:1673`) erases it and it
still never ages. The dated note must narrow that sentence as well as record
the re-drive change the plan names.

**T15-3 NOTE - `docs/issues/send-attempt-sweeper.md` needs more than the
planned additions.** `:47-50` quote the dashboard comment T13 deletes (its
frontmatter refs `deliveryStatus.ts:221`), and the fourth bullet (`:30-34`: a
failure-arm write that fails leaves the record `attempting` and the slot as it
was) is superseded by `guardWrite` plus the stranded defer. The dated section
should say both.

**T15-4 NOTE - `npm run issues` cannot fail on content.** `scripts/issues.mjs`
only PRINTS `[issues] N warning(s)` (`:99-102`) and exits 0, so "must exit 0"
proves nothing: read its output. Baseline at HEAD: 508 issue files, 0 warnings
(a read-only replica of its checks). Its parser takes one scalar `key: value`
per line (`:25-36`), so keep `refs:` on one line. Set `updated: <date>` on each
touched file (optional field; `manual-retry-double-send-residual-windows` and
`throw-for-redelivery-defeated-by-job-marker` already carry one). All nine
planned files EXIST (none is created from `_TEMPLATE.md`), all are
`status: open`, and all are pure ASCII today, so the whole-file `tr` check is
valid on each after the edit.

**T15-5 NOTE - "the TODO(throw-for-redelivery-defeated-by-job-marker) markers are
gone".** At HEAD there is exactly ONE such marker,
`app/src/jobs/broadcastFanOut.ts:609`, plus a prose mention in a docblock at
`:285`; `relayFanOut.ts` and `relayRetryLeg.ts` carry none (the issue's refs
point at the throws, not at markers). Before writing the sentence, run
`grep -rn "throw-for-redelivery-defeated-by-job-marker" app/src` and state what
it returns.

**T15-6 NOTE - other issue files that name this branch.** 25 files in
`docs/issues/` name `send-outcome-reconcile`, `send_unconfirmed`,
`send-attempt-sweeper`, `throw-for-redelivery` or `send.reconcile` (list with
statuses in the reference). Beyond T15-1 to T15-3, none is contradicted by
T13-T15. Two may want an optional dated line: `no-contact-code-renders-as-carrier-error.md`
(its share-row half is already fixed at HEAD by Branch A,
`broadcastFormat.ts:157`; the relay `send_failed` half at
`app/src/services/relayAnnouncements.ts:367` remains, so it stays open) and
`broadcast-skip-code-drift-guard.md:34-35` (land its union AFTER this branch;
T13's `sendOutcomeCodesMirror.test.ts` now pins the four SOR codes).
