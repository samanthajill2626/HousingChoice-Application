# Plan review r1-b: share-sent-outcome implementation plan, revision 1

Reviewer: adversarial plan reviewer (read-only). Date: 2026-09-28.
Plan: `docs/superpowers/plans/2026-09-28-share-sent-outcome.md` (rev 1, 31ea4e7b).
Spec: `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`.
Tree: `W:\tmp\share-sent-outcome` at HEAD 31ea4e7b. Nothing was run; every code
claim below cites a file:line read on this tree. Plan citations are "plan:NNN"
(line numbers of the plan file).

Question asked: if a builder with no context executes this plan literally, do
they produce the spec? Mostly yes, but not literally: one task rests on a false
premise about the webhook, two tasks choose error handling the spec rejects,
several test sketches contradict the rules they sit beside, and the harness
wiring the new code needs is not enumerated. Findings are ordered by severity.

---

## 1. [HIGH] Task 5 reads a stale `retry_due_at`: the "post-write row" it relies on does not exist

What is wrong. Task 5 tells the builder to take the promise from
`message.retry_due_at`, "the post-write row so `retry_due_at` is the value the
30003 arm just wrote" (plan:1438), and says the value is right because the
status write precedes the rollup (plan:1439). It uses that value in three
places: the retry path's `outcomeOf(..., message.retry_due_at)` (plan:1533),
the original row's ledger write (plan:1509), and the new `retryDueAt`
parameter of `rollIntoBroadcast` that decides `retry_pending: 1` on the emit
(plan:1440, plan:1540).

Evidence. The webhook reads the row ONCE, before the write:
`let message = await messages.getByProviderSid(MessageSid);`
(`app/src/routes/webhooks/twilio.ts:3346`, re-read only on the unknown-SID miss
at `:3367`). The promise is written by `updateDeliveryStatus(..., { retryDueAt:
oneToOneRetry.runAt.toISOString() })` (`twilio.ts:3462-3467`), which returns a
boolean; nothing re-reads the row afterwards. So at `:3520` `message.retry_due_at`
is the PRE-write value: undefined for a first 30003 failure (a failed row is
terminal, so it never held one).

What it implies. Built literally: the rollup never emits `retry_pending: 1`
(D4's "the list and results pages read Sending from the very event that starts
the retry" is lost), an original row's 30003-with-promise writes a `failed`
ledger entry instead of `pending`, and a retry row's 30003-with-promise does the
same through `applyLaterAttempt` - so D6 reads "Property text failed" for the
whole backoff although RSW still promises a retry. The plan's own Task 5 test
("retry_pending 1 ... the ledger entry is pending", plan:1471-1476) goes red and
the plan offers no correct fix. The value is in scope already: when
`oneToOneRetry?.kind === 'retry'`, `oneToOneRetry.runAt.toISOString()` is
exactly what the same conditional write stored (`twilio.ts:3452-3467`). A
builder guessing a fix may instead add an eventually consistent re-read
(`getByProviderSid`), which can return the pre-write image and flake.

---

## 2. [MEDIUM] Task 6 swallows slot-write throws at the reconcile sites, defeating the re-apply the spec depends on

What is wrong. Site 5 (the adoption hook) is "Wrapped in try/catch: ONE ERROR,
the close proceeds" (plan:1567, plan:1643-1652). Sites 1/2 (the unresolved
close) are also try/catch, continuing to the WITHDRAW (plan:1568,
plan:1655-1665).

Evidence. Spec D2: the adoption hook "is placed BEFORE the reconcile closes the
record, so a crash leaves the record open and the redelivered check re-finds
the row through its own child pointer and re-runs the hook ... after the close
nothing re-applies an `adopted` outcome" (spec:316-321). Spec section 0: "at
the reconcile's close the call rides 1b's own re-apply" (spec:113). The
reconcile's re-apply exists only when a check FAILS and is redelivered
(`sendReconcile.ts:12-19`, superseded exit `:528-532`; the WITHDRAW throws on
purpose to get it, `:1366-1370`). Spec section 8 accepts a dropped slot write
only "at one of the job's two arms" (spec:782-788), not at the reconcile.

What it implies. A transient DynamoDB error on the share read/write in the
Site 5 hook is logged, the record closes `adopted`, and nothing ever re-applies
it: the slot keeps the retried failure although the retry row exists (the
recipient reads failed or unconfirmed, the pair is not counted) until someone
re-runs the repair. At Sites 1/2 the same throw is re-applied only if the
WITHDRAW also fails. Both are residues the spec does not accept. Letting the
slot error propagate (after the WITHDRAW at Sites 1/2) keeps the spec's design;
the plan must at least declare the deviation.

---

## 3. [MEDIUM] Task 4's `originalRowLedgerWrite` test contradicts Task 3's ledger rule

What is wrong. The test writes a `pending` entry for attempt ROOT, then a
`delivered` outcome for the SAME attempt ROOT, and expects
`{ state: 'counted', by: 'delivery' }` (plan:1295-1298).

Evidence. Task 3's `mayReplace` for the same attempt allows from `pending` only
`failed` (plan:1112); spec D7 lists the same-attempt forward moves as
"counted by acceptance may become counted by delivery, pending or failed;
pending may become failed; nothing moves back" (spec:499-502). The message
machine also forbids it (delivered's priors are queued|sent,
`app/src/repos/messagesRepo.ts:140`).

What it implies. The test is red by construction. A builder "keeping the tests
as the contract" (plan:1145) is pushed to weaken D7's rule to make it pass. The
test must use a fresh row or a newer attempt.

---

## 4. [MEDIUM] Harness and test wiring the new code needs is not enumerated (three unlisted surfaces)

What is wrong. The plan adds dependencies and a stored field but never wires
the in-memory doubles into the entry points the tests drive, and the task file
lists and `git add` lists omit the files that must change.

Evidence.
- Webhook: Task 5 adds `listingSendsRepo?` to `TwilioWebhookDeps` with a real
  default (plan:1439, plan:1496). `makeWebhookHarness` passes the world's repos
  to the webhook explicitly and has no `listingSendsRepo` there
  (`app/test/helpers/twilioWebhookHarness.ts:5110-5140`), so every webhook test
  builds a REAL ledger repo. The Task 5 tests assert on
  `h.world.listingSendsRepo` (plan:1457, 1475, 1479) and would see nothing,
  while real DynamoDB calls throw into ERROR lines that existing pins count.
  Task 5's files and commit omit the harness.
- Retry job: Task 6 adds `broadcastsRepo?` / `listingSendsRepo?` built lazily
  (plan:1569, plan:1671). The job test's `wire()` passes "every dep it reads (a
  missing one would lazily build a REAL DynamoDB repo)" and passes neither
  (`app/test/retrySendAttempt.test.ts:96-118`). The new "still ONE close
  ERROR" test (plan:1610-1615) then counts the real repo's failure.
- Activity events: Task 7 asserts the milestone carries `broadcastId`
  (plan:1724), but the harness double builds the item from a fixed field list
  and drops it (`twilioWebhookHarness.ts:3056-3073`). Spec section 5 names "their
  harness doubles" as a surface (spec:648-653). Task 7 lists neither the harness
  nor any other double.

What it implies. Three red suites whose cause is not in the plan, and commits
built from the plan's explicit `git add` lists would leave the fixes
uncommitted.

---

## 5. [MEDIUM] Task 10 omits `DeliveryBadge.tsx`, the only renderer of the row reason: "will retry" never reaches the results row

What is wrong. Task 10 changes `shareRecipientReason` to take the promise facts
(plan:1956, plan:1987-1997) and wires the hint in `BroadcastResults.tsx`, but
never names `DeliveryBadge.tsx`.

Evidence. The badge is the one caller: `const reason =
shareRecipientReason(status, errorCode);`
(`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:34-37`); `BroadcastResults`
renders `<DeliveryBadge status carrierSentAt errorCode />` only
(`BroadcastResults.tsx:64-68`). The new `opts` are optional, so everything
compiles and the unit tests on `shareRecipientReason` pass while the rendered
row keeps the plain 30003 copy. Relatedly, the plan calls
`StatChips.test.tsx:178` a chip pin that flips (plan:1965); it is a DeliveryBadge
render test (`StatChips.test.tsx:177-181`) and, with the omission, stays green.

What it implies. Spec D3's "will retry" on the results row is undelivered until
e2e (a) fails at Task 14. Task 10 must add DeliveryBadge (props plus its test)
to its files and commit.

---

## 6. [MEDIUM] Task 10 misstates which label pins flip; three flip, one is told to be kept

What is wrong. The plan says `broadcastFormat.test.ts:224` "(sent + skipped +
failed = 'Sent') stays TRUE under the new rule (sent > 0) - keep" (plan:1964).

Evidence. Line 224 is `presentShareLabel('sent', stats({ audience: 2,
skipped_other: 1, failed: 1 }))` expecting `Sent`
(`dashboard/src/routes/broadcasts/broadcastFormat.test.ts:224`). There is no
`sent` in the fixture; under the plan's rule (plan:1976-1985) it reads
`Not sent` (danger). Spec section 7 names exactly this test as a pin to REWRITE
("the label-table test that reads sent + skipped + failed as 'Sent'",
spec:743). Two more flip and are not listed: `:228` (`'sent', stats()`,
audience 0, expects `Sent`; the new rule gives `Not sent`) and `:242` (sent,
skipped 1 + unconfirmed 1, expects `Sent`; the new rule gives `Not confirmed`).

What it implies. The builder meets three reds, one of which the plan told them
to keep. The instruction contradicts both the new rule and the spec.

---

## 7. [MEDIUM] The results page's pill and Retrying chip never re-judge the promise on the clock

What is wrong. Task 10's ticker re-judges only the row (hint and reason:
"BroadcastResults snapshots serverNowMs() and re-judges every 60 s", plan:1958).
The pill and chips derive from `stats.retry_pending` as the route computed it at
fetch time (plan:1954-1955).

Evidence. Spec D4 accepts staleness ONLY on the list: "What remains stale on the
list: a promise that lapses with NO event at all ... reads Sending until the page
is reopened. Accepted: the list is a summary, and the results page ticks."
(spec:405-410). With no event, the results page does not refetch
(`useBroadcastResults.ts:118-138` refetches on SSE only; the 2 s poll runs only
while `sending`).

What it implies. On the results page a share whose only promise lapsed with no
event keeps reading "Sending" with a Retrying chip while its own row already
shows the hint - the header contradicts the rows, which is the case the spec
says the results page does not have. The pill and chips need to recount
`retry_pending` from the recipients' `retryDueAt` on the same ticker (or the
ticker must trigger a stats refetch).

---

## 8. [MEDIUM] Task 13's `brokenLineage` rule is undefined and, read literally, skips healthy slots

What is wrong. The census pages the conversation newest-first down to the
original and keeps "rows whose `retry_of` chain leads to the original (walk
`retry_of` through the collected rows; a break -> unjudgeable.brokenLineage,
skip the slot)" (plan:2192).

Evidence. The collected rows are the whole thread after the original: other
shares' texts, one-to-one texts, and other chains' retries (manual Retries of
other rows, retries of messages older than the original). Most of those walk
to a row outside the collection or to a non-share row, which is not a "break"
of THIS chain but is indistinguishable from one under the plan's wording. The
spec's own rule is lineage from THIS original (spec:534-539); pre-1b rows carry
no `retrychild#` pointers or `retry_root` to disambiguate
(`messagesRepo.ts:1536-1544` comment: rows before the family have no pointer).
The sketched test for a broken link has no fixture (plan:2224).

What it implies. A literal builder marks many slots unjudgeable (and moves
nothing for them), or silently invents a definition. The plan must define a
break precisely (for example: a row whose `retry_root` or `broadcast_id` names
this share/original but whose `retry_of` walk misses; everything else is simply
another chain) and test it.

---

## 9. [MEDIUM] Task 6's tests do not pin what the spec requires of the five sites

What is wrong. The job tests are titled "the original slot reads
send_unconfirmed BEFORE the record closes" (plan:1610) but assert only the end
state and an ERROR count; no call-order assertion. No test shows "a later
adoption supersedes the unconfirmed slot". The reconcile test "a deduped
re-adoption re-runs the hook as a refused no-op" runs the second check after
the record is already `done` (plan:1581-1583), which takes the superseded exit
(`sendReconcile.ts:518-533`: `adopted` has no `slotCloseOf` re-apply,
`:1315-1326`), so the hook never runs again.

Evidence. Spec section 7 requires "the slot-first order at the job's arms (a
later adoption supersedes the unconfirmed slot)" (spec:693-695) and the D2
adoption crash window (spec:316-321). The repo's idiom for order is
`invocationCallOrder` (`app/test/broadcastFanOut.test.ts:2500-2503`).

What it implies. A builder can place the job-arm call after the close, or break
the crash-window re-run, and every Task 6 test stays green. The regression the
task risks is not caught.

---

## 10. [LOW] Task 1 breaks the `deriveBroadcastStats` identity pin while Step 10 expects PASS

`deriveBroadcastStats` returns `b.stats` itself for an empty map
(`app/src/repos/broadcastsRepo.ts:275`), pinned by
`expect(out).toBe(persisted)` (`app/test/deriveBroadcastStats.test.ts:26`). The
plan's `return { ...b.stats, ...pending }` (plan:405) always allocates, so the
pin goes red although plan:502 says the file passes. Return `b.stats` unchanged
when no count is supplied, or list the pin as rewritten.

## 11. [LOW] Test and code sketches name APIs that do not exist as written

- `createTwilioWebhookHarness` (plan:1190, 1202): the helper exports
  `createFakeWorld` and `makeWebhookHarness` (`twilioWebhookHarness.ts:504`,
  `:4932`); `Harness` has no `events` (it is `world.events`, `:4923-4930`, `:378`).
- `capture.logger` (plan:626-631, 1021, 1065, 1206): `createLogCapture()` returns
  `{ stream, lines, atLevel }` only (`app/test/helpers/logCapture.ts:14-38`); the
  idiom is `createLogger({ destination: capture.stream })`.
- `zeroStats(1)` (plan:320, 350, 491): `zeroStats()` takes no argument
  (`broadcastsRepo.ts:328`); `seedBroadcast` does not exist in
  `broadcastsRepo.integration.test.ts` (its setup uses the repos directly, `:53-70`).
- `BroadcastItem` literals in Task 4 omit `created_by`, `audience_filter`,
  `body_template` (required, `broadcastsRepo.ts:168-214`); typecheck covers tests.
- The Task 3 fake does `delete row.sentAt` (plan:1015) on `sentAt: string`
  (required, `listingSendsRepo.ts:42`): TS2790 under the test typecheck unless
  the type changes; the plan REMOVEs `sentAt` from stored rows but never makes the
  field optional, so the stored shape and the type disagree.
- The webhook sketch builds the repo with `{ doc, env: process.env, ... }`
  (plan:1496); the router has no `doc` in scope and builds repos as
  `createXRepo({ logger: deps.logger })` (`twilio.ts:562-570`).
- The Retrying chip's `tone: 'progress'` (plan:1998) is not in `Chip.tone`
  (`'success' | 'danger'`, `StatChips.tsx:24-28`) and has no CSS class.
The plan's "read the file first" covers fixture names, not these API facts.

## 12. [LOW] The seeded ledger rows without `updated_at` can never be written

`putShareMemory` conditions on `attribute_not_exists(unitId)` whenever the read
row has no `updated_at` (plan:954-958, `expect: { updatedAt: row?.updated_at }`
plan:1137). The full-world matrix seed rows carry `created_at` only
(`app/src/lib/seed/matrix.ts:1261-1285`), so any ledger write for those three
pairs loses its condition four times and logs the ERROR "lost" forever. The spec
says the full world's rows need no seed change (spec:655-657); the token must
fall back to `attribute_not_exists(updated_at)` for an existing row without one.
(Also: a millisecond ISO `updated_at` is a weak change token - two writes in the
same millisecond from two processes can ABA; a version counter would not.)

## 13. [LOW] `registerHandlers.ts` does not pass the repos the plan says it does

Plan:1686 says "the reconcile registration already passes both (:59 region)".
`registerAllJobHandlers` passes only `sendAttemptsRepo` to every handler
(`app/src/jobs/registerHandlers.ts:59-72`); each job builds its repos lazily.
The Task 6 edit to this file is unnecessary and its premise is false; a builder
may construct repos there for no reason.

## 14. [LOW] Task 7's "keep their assertions" breaks the swallowed-ledger pin

The pin stubs `world.listingSendsRepo.recordSend` to throw and matches an ERROR
containing "listing-send row failed" (`app/test/broadcastFanOut.test.ts:1054-1083`).
After Task 7 the fan-out never calls `recordSend` and logs "recording listing-send
entry failed" (plan:1773). The pin must move its stub to
`putShareMemory`/`getByKeyConsistent` and its match to the new text.

## 15. [LOW] Reads the list and stats paths do not need, and sequential reads on the polled results path

`resolveRecipientStates` also performs the D1 record reads (one keyed read per
`queued` slot of a finished share younger than 30 days, plan:792-800). The list
route and `?view=stats` call it only for `retry_pending` (plan:1868-1869,
1910-1912), which needs row reads only; the record reads there are waste. All
reads are sequential per slot (plan:780-800) and the results page polls every
~2 s while sending, so a blast with many young 30003 failures re-reads every
row on every poll and every SSE refetch.

## 16. [LOW] Outcome mapping loses facts the existing adoption keeps

- The adoption hook maps an adopted `sent` to `{ kind: 'sent' }` with no
  `carrierSentAt` (plan:1567); the share adoption sets `carrierSentAt` from the
  provider's `date_sent` (`broadcastFanOut.ts:1415`), which spec D2 says the hook
  mirrors ("as the share adoption maps it today", spec:313-314). The slot reads
  "Sending..." until a terminal receipt that may never come.
- A code-less adopted failure becomes the invented code `adopted_failed`
  (plan:1567), rendered as "Delivery failed (error adopted_failed)".
- `outcomeOf` maps every non-terminal transition to `{ kind: 'sent',
  carrierSentAt: now }` (plan:1519-1523), including `queued`, which the old
  rollup ignored (`twilio.ts:3872-3878`); spec D2 names only confirmed-sent,
  delivered and failed (spec:311-313).
- `nextSlot` keeps the previous attempt's `carrierSentAt` on a newer delivered
  attempt (plan:1349); spec D2: a newer attempt "replaces ... carrier instant".

## 17. [LOW] The pair's contact is chosen with the precedence reversed

`applyLaterAttempt` uses `input.recipientContactId ?? (contactKey when not phone#)`
(plan:1178, 1396), preferring the retry ROW's recipient over the slot key. Spec D7:
"today's key: the slot's key when it is a contact id, else the contact that held
the number at send time ... A number that has since moved to another contact is a
named residual: the entry lands on the send-time contact's row" (spec:516-520).
When a retry row's recipient differs from a contact-keyed slot, the plan writes a
second ledger row for a different contact, contrary to the stated residual.

## 18. [LOW] Section 7 tests the plan does not carry

- D8 "refuses the wrong account" (spec:709-711): absent from Task 13's list
  (plan:2204-2226).
- D6 words for a REFRESHED and a WITHDRAWN pending row (spec:707-708): Task 12
  covers live and lapsed only (plan:2115-2120).
- The sparse index "and its return" (spec:706): Task 3 shows the drop, never a
  re-count re-entering `byContact` (plan:886-897).
- E2E (b) "on the list (the row refetch)" (spec:722-723): Task 14 navigates to
  the list after the chain ends (plan:2294), which reads the route fresh and never
  exercises the SSE refetch.
- The phone-keyed Review Focus 1 test (plan:1259-1270) never shows an entry
  landing on `recipient_contact_id`: its second call is refused at the delivered
  slot before the ledger is reached.

## 19. [LOW] Spec-mandated first-task verification of 1b's four facts is not a task

Spec sections 6 and 8 say "the plan's first task verifies the code against
section 0's four facts ... and, on a mismatch, corrects it before anything else"
(spec:664-667, spec:808-814). Task 1 is the order key. The verification exists
in research (`research-1b-as-built-findings.md:17-54`, "All four facts HOLD as
built") but the plan never cites it as satisfying that requirement.

## 20. [LOW] The `individual` ledger key is contradictory and leaks into the wire shape

Task 3's service writes a hack, then says "the builder simplifies it" so
`summarize` returns the key `individual` as `broadcastId` (plan:1134-1145). The
row's `broadcastId` then reads `individual` and `toListingSendRow` puts it on
the C4 wire (`listingSendsRepo.ts:104-118`, `ListingSendRow.broadcastId`).
Harmless to today's dashboard (no reader of that field), but it is a fake share
id in a public shape, and the plan ships two incompatible versions of the code.

## 21. [LOW] Smaller rule and cost gaps

- `getByIds` drops keys still unprocessed after one retry (plan:467-474). Full
  share items run to ~300 KB, so a page of `limit` shares can exceed BatchGet's
  16 MB response; a dropped id silently relabels an existing share with the
  stored count. Spec D5 asks for a "projected batch read" (spec:418-419).
- D4's `Not confirmed` label counts only `send_unconfirmed` slots
  (`stats.unconfirmed`); a slot whose row says `retry_outcome: unconfirmed`
  inside the bound (the dropped-write residue) is counted in `failed` and the
  share reads Not sent, while D1 calls it unconfirmed.
- D2 says FROM `failed` or `sent` only; `allowed()` refuses only
  `delivered`/`skipped` (plan:1356), so `queued` is implicitly admitted.
- Slice 1 is labeled "no behavior change on any surface" (plan:94) but lowers the
  send cap to 1000 (a user-visible refusal change).
- Between Task 5 and Task 7 the pass still calls `recordSend`, which re-SETs
  `sentAt` on a `counted: false` row (`listingSendsRepo.ts:144-171`), putting it
  back into `byContact` under a filter; harmless because slices are declared
  non-shippable, but any test in that window that drives a pass plus a failure
  callback sees an inconsistent row.

---

## Coverage walk (for the record)

Delivered as specified: D1 state table and bounds (T2), the two readings (T2),
D2 order key and primitive (T1, T4), the five 1b insertion points at the correct
lines (`retrySend.ts:798-800`, `:859-860`; `sendReconcile.ts:541-542`,
`:1366`; the superseded exit re-apply `:528-532`), I7's guardWrite at the job
arms, D3 route fields (T9), D4 label table (T10, modulo findings 6 and 7), the
stats-only query flag (T9, Cameron's ruling), D5 (T11), D6 (T12), D7 memory,
counted flag and sparse index (T3), D8 shape (T13, modulo finding 8), D9 (T15),
the cap (T1). The retired `priorRecipientContactIds` has no caller outside the
route, the harness mirror and tests (grep of app, dashboard, e2e, scripts); the
dashboard uses only the unchanged wire field. `BroadcastsRepo` and
`ListingSendsRepo` have no implementation besides the real repos and the harness
doubles, so the interface additions break nothing else.
