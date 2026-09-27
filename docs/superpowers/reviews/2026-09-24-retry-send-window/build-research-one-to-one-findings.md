# Build research - one-to-one server slice (plan Tasks 7-13): findings

Branch `feat/retry-send-window` @ `6fb365dd`; its code is identical to
`f49a2fe9` (`git diff --stat f49a2fe9 HEAD -- app dashboard scripts e2e` is
empty), so every plan citation was checked against the live tree as-is. Plan
lines are cited as `plan:N` (`docs/superpowers/plans/2026-09-25-retry-send-window.md`).
Read-only research: no source edited, no suite run. The byte-exact quotations,
the caller lists, the live gate order and the sweep tables are in the gitignored
reference `.superpowers/sdd/build-research-one-to-one-reference.md`.

**Totals: 0 blocker, 2 must-fix, 5 note.**

What checked out (no finding): every other `file:line` and quoted old text in
Tasks 7-13 resolves byte-for-byte and is unique in its file; the ten
`sendMessage` call sites match spec D14's list exactly (none missed, every one
passes `automated` explicitly, only `broadcastFanOut.ts:464-473` passes
`recipient`); `enqueueSendRetry` has one caller (`twilio.ts:3364`) and no
mock or fake; `previewSendRefusal` checks the same five predicates as
`sendMessage.ts:298-373`, in the same order, and omits only the documented
exceptions (conversation read `:290-291`, channel guards `:309-314`, breaker
`:374-390`); the harness fakes the new decision reads
(`twilioWebhookHarness.ts:525-527`, `:1884-1906`) return `undefined` and never
throw, so no existing test silently takes the fail-open path; the only suite
that drives the one-to-one 30003 arm is `app/test/twilioStatusWebhook.test.ts`,
and every existing case there keeps passing once Task 10 moves `seedOutbound`
to a realistic send time.

## 1. must-fix - Task 10 Step 8b: a test title that does not parse

- Where: `plan:6247`, the "Review Focus 4" case added to
  `app/test/oneToOneRetryDecision.test.ts`.
- Fact: the `it(...)` title is a single-quoted string that contains the
  apostrophe of "person's". The string ends at that apostrophe, so the file
  fails to parse: every case in the decision suite fails to load, and
  `npm run typecheck` fails. It is the only such line in Tasks 7-13 (every
  other title with an apostrophe is double-quoted: `plan:5137`, `:5145`,
  `:5721`, `:6562`).
- Correction: put that title in double quotes (or drop the apostrophe).

## 2. must-fix - Task 10 Step 7 (A) and (E): old text that Task 9 and Task 4 have already replaced

- Where: (A) `plan:5916-5934` (the `../../jobs/retrySend.js` import,
  `twilio.ts:119-122`); (E) `plan:6056-6065` (the enqueue call and `break;`,
  `twilio.ts:3364-3369`).
- Fact: Task 9 Step 4 always runs first and rewrites both regions:
  `plan:4774-4791` adds `resolveSendRetryBackoffMs` to the import, and
  `plan:4793-4816` replaces the call with a two-line comment (`plan:4806-4807`)
  followed by a two-argument call (`plan:4808-4815`). Task 4 always adds an import from
  `../../lib/retrySendWindow.js` (`plan:2464`). So when Task 10 runs, neither
  quoted old text exists. (A) handles this only with conditionals ("if Task 9
  added...", "If Task 4 already imports...") that are always true, and its
  replacement block still shows a second `retrySendWindow.js` import. (E)'s
  prose names only "the `enqueueSendRetry(...)` call and the `break;`", so a
  builder who follows it leaves Task 9's comment ("The retry runs one resolved
  backoff from now ... scheduled at exactly that instant.") above the new
  decline branch, where it no longer describes the code.
- Correction: quote the post-Task-9 text. (A): the old text is the import with
  three names; the new text is `enqueueSendRetry` alone, and
  `RETRY_PROMISE_WITHDRAWN_AT` is folded into Task 4's existing
  `retrySendWindow.js` import. No conditional is needed. (E): the old text is
  Task 9's two comment lines, its two-argument `await enqueueSendRetry(...)`
  and the `break;`.

## 3. note - Task 10: the decision comment says it runs "the send path's own gates, as it runs them"

- Where: `plan:5290-5303` (the header of `oneToOneRetryDecision.ts`).
- Fact: the send path checks the kill switch (`sendMessage.ts:298-301`)
  before its channel guards (`:309-314`; relay_group at `:309` before
  group_text at `:310`). The decision instead checks conversation
  missing -> group_text -> relay_group/no phone -> kill switch (inside
  `previewSendRefusal`). This follows spec D3a (group_text is step 1; the
  refusals are step 2), and step 2 matches the send path gate for gate. The
  only effect: on a group_text, relay or phone-less thread with the kill
  switch off, the logged reason is the channel reason and not
  `sms_sending_disabled`. Both are WARN, with no stamp.
- Correction: reword the comment, for example "channel checks first (D3a step
  1, D11), then the send path's previewable gates in the send path's own
  order". No code change.

## 4. note - Task 10: a failed contact read also skips refusals that need no contact

- Where: `plan:5305-5311` (comment) and `plan:5367-5390` (code).
- Fact: when `findByPhone` or the recorded-recipient `getById` throws,
  `previewSendRefusal` is skipped entirely. That also skips the kill switch,
  the conversation's `sms_opt_out` and manual mode, all of which were already
  known from config and the conversation read. The comment says "the checks it
  would have fed are skipped", which describes less than the code skips. The
  code stays within spec D3a's failure semantics and section 9's accepted
  residual ("one D3a let through on a failed read that the job then refuses").
- Correction: make the comment match the code (every send-path refusal is
  skipped on any failed read), or accept as is.

## 5. note - Task 10 (C): new reads before the status write, outside the arm's catch

- Where: `plan:6001-6032` -> `twilio.ts:3251`.
- Fact: today only the message lookups (`twilio.ts:3151-3174`) come before
  the status write. The conversation is read only after the write
  (`flagPlacementAttention`, `:553-555`, called at `:3338-3340`; the
  30005/30006 and 21610 arms, `:3421`, `:3476`). Task 10 adds a conversation
  read, `findByPhone` and, when a recipient was recorded, `getById`, all
  before the write. They run on every failed or undelivered 30003 callback,
  including redeliveries and out-of-order callbacks that will not transition
  (Review Focus 1 proves that no line is logged, not that no read happens).
  The awaited decision also sits outside the arm's try/catch
  (`:3348`, `:3524-3528`). Its reads are caught inside the decision, but any
  other throw from it would now fail the callback with a 5xx before the
  status write. The spec requires this placement (D3a), so this is a risk,
  not a defect.
- Correction: none required. If wanted, a Review Focus-style test that a
  throwing decision still writes the status.

## 6. note - Task 10 Step 5 (e): the `contact_deleted` webhook row does not test the recorded-recipient path

- Where: `plan:5639-5654`.
- Fact: the soft-deleted `c-gone` is the only contact on `TENANT_PHONE`, so it
  is also the phone-matched contact. The row passes even with a decision that
  ignores `recipient_contact_id`. The recipient path is pinned elsewhere (the
  unit row at `plan:5068-5076` and the acceptance test at `plan:5742-5768`),
  so the suite as a whole does test it.
- Correction: optional. To make this row prove the recipient path, push a
  live, consenting contact on the same phone before `c-gone`.

## 7. note - Global Constraints: the wrong line is cited for "e2e:restart keeps the old childEnv"

- Where: `plan:30`, citing `scripts/e2e-session.mjs:502`.
- Fact: `:502` is `runOnce`, which starts the one-shot seed and build children.
  The long-lived app, worker and fake-twilio are started again by
  `restartBackend` (`:589-616`) through `startApp`/`startWorker`
  (`:396-401`) -> `spawnNode`. `spawnNode` passes the launcher's
  module-level `childEnv` (`:323-324`), which is built once at `:109`. The
  conclusion is right: after Task 9, only a fresh launcher picks up
  `E2E_SEND_RETRY_BACKOFF_MS`.
- Correction: cite `:323-324` and `:589-616` in place of `:502`.
