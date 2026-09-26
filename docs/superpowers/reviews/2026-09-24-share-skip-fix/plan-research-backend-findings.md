# Plan research (backend) - findings against spec D4-D7

Date: 2026-09-25. Branch: `feat/share-skip-fix` at `409540ac`.
Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A, v7).
Source: a read-only research pass for the implementation plan. The byte-exact
reference it produced is in the gitignored
`.superpowers/sdd/backend-reference.md`. This file holds findings only.
It cites code by `file:line`.

Scope: only claims in D4-D7 (and the invariants and section 5 surfaces they
feed) that the code contradicts, or writers and readers they miss. Four items.
None blocks the plan. Each one needs a wording change or a planner decision.

---

## F1 [LOW-MEDIUM] I3 still says a skipped recipient "never makes a share read Sent"; R5-3 narrowed only G4

**What the spec says.** I3 (spec lines 287-288): "A `skipped` recipient is
never 'Already sent' and never makes a share read 'Sent'." D6 (lines 210-217)
relabels only a share in which EVERY recipient was skipped.

**What the code does.**

- finalize marks a share `failed` only when the persisted `failed` count
  reaches the recipient total. Otherwise it marks it `sent`
  (`app/src/jobs/broadcastFanOut.ts:690-693`).
- Skipped slots never add to `failed`. They bump skip counters instead
  (`broadcastFanOut.ts:386`, `:402`, `:499`).
- Some recipients fail before any send:
  - `no_contact` (`:368`);
  - the cap and enqueue closes (`:283`, called from `:348`, `:593`, `:602`,
    `:623`);
  - provider errors thrown by the send call (`:507`, `:518`).
- So take a two-recipient share: one recipient skipped, the other failed
  before send. It finalizes `sent`.
- Without the skipped recipient, the same share finalizes `failed`.
- D6 does not relabel it, because not every recipient was skipped. The share
  reads "Sent", and the skipped recipient is the reason.

**History.** Round 5 raised this for G4 (`spec-review-r5-cut.md:166-186`, F3).
R5-3 (`spec-review-r5-cut-adjudications.md:12`) reworded G4 to D6's scope and
rejected widening D6. I3's second clause was not narrowed to match.

**Implies.** If R5-3 stands, narrow I3's second clause to D6's scope: "a share
in which every recipient was skipped never reads 'Sent'". Otherwise a final
review can cite I3 against the shipped code.

---

## F2 [LOW] D5's reason for counting `failed` does not hold for recipients that failed before any send

**What the spec says.** D5 (lines 196-200): `failed` keeps counting "because
a failed text may have been delivered by a retry the share never hears about".
Its reason for excluding `skipped` is that "no text was attempted for them".

**What the code does.**

- Four fan-out failure paths run before any message is persisted:
  - `no_contact` (`broadcastFanOut.ts:368`);
  - `transient_cap` and `enqueue_failed` from `closeBroadcast` (`:283`). These
    are recipients whose every attempt threw 429/30022;
  - codes thrown by the send call: 30007 (`:507`) and 30005/30006 (`:518`).
- The last two throw inside `adapter.sendPreparedMessage`
  (`app/src/services/sendMessage.ts:394`), before `messages.append` (`:398`).
- The 30003 automatic retry is started only by the status webhook, for a
  message that was persisted (`app/src/jobs/retrySend.ts:1-5`).
- So these slots have no text and no retry. By D5's own test they are the
  same as `skipped`. D5 still flags them "Already sent", which repeats Sam's
  complaint through a different code.
- The stored slots already tell the two kinds apart:
  - a fan-out failure writes `{ status: 'failed', errorCode }` with no
    `conversationId` and no `tsMsgId`;
  - a webhook failure spreads `...slot`, so it keeps both
    (`app/src/routes/webhooks/twilio.ts:3653-3662`).

**Implies.** Planner/Cameron choice; Branch B replaces the rule either way.
Pick one:

- keep counting every `failed` slot and restate the D5 reason, since it is
  accepted interim debt; or
- count a `failed` slot only when it carries a `tsMsgId`, meaning a message
  was actually attempted. This is one extra predicate in
  `priorRecipientContactIds` and needs no new data.

---

## F3 [LOW] Section 5's stats writers leave out the counters that the finalize log line actually reads

**What the spec says.**

- Section 5 (lines 314-316): "Recipient reason and stats. Writers: the
  fan-out's first-fence skips (D7). Readers: ... the finalize log line ...".
- D7 (line 251): "the finalize log line reports every skip".

**What the code does.**

- The finalize log line prints the PERSISTED counters
  (`finalItem.stats.sent/failed/skipped_opted_out`,
  `broadcastFanOut.ts:697-700`). It does not print derived stats.
- Two writers bump the persisted `skipped_opted_out`:
  - the first fence (`:386`);
  - the SendRefusedError branch (`:499`), for EVERY refusal code:
    `manual_mode`, `breaker_open`, `contact_deleted`, `sms_sending_disabled`,
    `contact_opted_out`, and so on.
- The persisted `skipped_no_consent` (`:402`) never reaches the log line.
- So a plan that changes only the listed writer (first-fence skips) leaves the
  listed reader wrong.

**History.** This extends r1-b F6 and M13
(`spec-review-r1-b.md:180-199`, `spec-review-r1-adjudications.md:24`). Those
named the log line as a reader but not that it reads persisted counters.

**Implies.** Either:

- have the log line read `deriveBroadcastStats(finalItem)`. It is already
  computed for the emit at `:696`, and it moves with the new buckets
  automatically; or
- add the `:402` and `:499` bumps to section 5's writer list.

SOR rebuilds finalize (spec section 6), so whichever branch lands second
inherits this.

---

## F4 [INFO] D4's "the session middleware has just verified that user exists" holds only on an epoch-cache miss

**What the spec says.** D4 (lines 171-173): the draft route "can only be called
by an authenticated staff session (the session middleware has just verified
that user exists)".

**What the code does.**

- `sessionMiddleware` reads the users table only when the in-process epoch
  cache has no entry (`app/src/middleware/auth.ts:182-193`).
- The cache TTL is 60s (`auth.ts:36-37`, `:111-135`). On a cache hit there is
  no read.
- So a user deleted within the last 60s or less still authenticates. The file
  header states this ~60s revocation bound (`auth.ts:12-16`).
- `requireAuth` then checks only that `req.user` is present
  (`auth.ts:219-227`).

**Implies.** No design impact: the record still means "created through an
authenticated staff session". Reword the parenthetical to "a staff session the
middleware accepted (existence re-checked at least once a minute)". The plan
must not add a test or doc line that asserts a per-request existence check.
