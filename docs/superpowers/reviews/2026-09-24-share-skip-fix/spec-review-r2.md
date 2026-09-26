# Spec review r2 (reviewer B) - share-skip-fix design v2

Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` at 479e0841
(v2). Also read: the WP2 issue as amended in the same commit, the round-1
adjudications, and reviewer A's round-1 report. Read-only; every claim below
was checked in this worktree. Scope as in round 1: wrong current-behavior
claims, wrong / missing / ambiguous / contradictory decisions, guarantees the
mechanism cannot deliver, and unaccounted writers or readers. No implementation
steps are proposed.

Paths are under `app/src/` and `dashboard/src/` unless stated otherwise.

Most of what is new here sits in the v2 retry rule (D5, D5(d), D6, section 5's
new retry writers). That rule was written to close round-1 M1. It depends on a
fact the one-to-one retry chain never records, it reverses an invariant it does
not mention, and its presentation contradicts its own states.

---

## F1 [HIGH] "Retry pending" has no durable end in the one-to-one retry chain, so D5's fourth counted state and D6's un-count trigger cannot be delivered as written

**What is wrong.** D5 counts a recipient while the latest attempt is "`failed`
with an automatic retry still pending". D6 un-counts only on "a failure with no
retry pending". Both treat "a retry is pending" as a fact the system can read,
and then read again when it stops being true.

The one-to-one retry chain records no end on most of its exits:

- **Refusal.** The job catches every refusal (opt-out, deleted, kill switch,
  breaker, `manual_mode`), logs it, and returns. Nothing is written
  (jobs/retrySend.ts:208-217).
- **Enqueue failure.** The status webhook enqueues the retry inside the
  side-effect `try` (routes/webhooks/twilio.ts:3343-3369). A throw is caught
  and logged (twilio.ts:3524-3528). No retry exists, and nothing records that.
- **Job error after the execution marker.** The marker is written before the
  send (retrySend.ts:129-138). A later throw (retrySend.ts:218) triggers a
  redelivery, and the marker suppresses it. This is the open, high-severity
  issue `docs/issues/throw-for-redelivery-defeated-by-job-marker.md`.
- **Original not found.** The job returns silently (retrySend.ts:112-116).
- **Exhausted.** Only this end can be derived, from the failed message's
  `retry_attempt` (twilio.ts:3354-3362).

The relay product hit this exact gap. Its design records that "relayFanOut
closes on enqueue_failed while retrySend does nothing"
(`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md:413-416`).
To make "retrying" a closable state it needed:

- a durable retry row and a claim (twilio.ts:3102-3146);
- per-refusal close codes with operator copy (deliveryStatus.ts:917-934);
- an "unconfirmed" state for a ladder that goes quiet (deliveryStatus.ts:745-764).

**Consequences as specified.** Section 5 adds "the automatic 30003 retry and the
staff Retry" as outcome writers, but none of the silent exits above. A builder
who closes "pending" only on the next attempt's outcome leaves the recipient
counted as sent forever on every one of those exits:

- the review list flags "Already sent" (I4);
- the ledger never un-counts (D6);
- the share never reads "Not sent" (D7).

That is exactly Sam's #5 symptom ("the recipient review marks the tenant 'Already
sent'" for a tenant who never got the text). The cleanest reproduction is a
breaker-stopped conversation: its automatic retry is certain to be refused, and
D5 still calls it "on its way".

**Section 8 contradicts D5.** Its last bullet says a recipient "forever for a
retry the switch refuses ... reads not sent". That presumes the refusal is
recorded, which the mechanism does not do. It also contradicts D5, which counts
the same recipient during the pending window. Its opening clause, "Until the
retry rule is built", describes no window in production: slice 1 ships before
the rule, but in that period today's union still flags every recipient of a sent
share whatever happened to them (broadcastsRepo.ts:536-538).

**Implies.** The spec must own the product rule for how a pending retry ends:

- a recorded end on every exit, or a time bound (the chain's window plus slack),
  or both;
- whether the conversation's switch is consulted when calling a retry "pending";
- what the recipient reads when a chain goes quiet (not counted, or an
  "unconfirmed" state as in relay).

Without that, two builders diverge, and the obvious build reintroduces the bug
this branch exists to fix.

---

## F2 [MEDIUM] Retries as slot writers reverse a documented slot invariant the spec never mentions, and collide with finalize's stored lifecycle

**What is wrong.** D5(d) ("a delivered retry reads delivered, not the original
failure") and section 5 (retries are outcome writers) require a `failed` slot to
move to a later attempt's state. Today that is forbidden in two places:

- The rollup's rule is that "a terminal slot (delivered/failed/skipped) never
  regresses" (twilio.ts:3537-3548, enforced at 3613-3617 and by the conditional
  write at 3653-3662). That rule is what keeps stats exactly-once under
  out-of-order and duplicate callbacks.
- The fan-out treats `failed` as terminal for its own idempotency
  (jobs/broadcastFanOut.ts:132-137).

The spec neither states the new invariant nor accounts for its most visible
reader, finalize:

- Finalize stores the share `failed` with `last_error` "all recipients failed"
  whenever the persisted failed counter reaches the total
  (broadcastFanOut.ts:690-693).
- For a one-recipient share - the flow this spec is about - a 30003 that lands
  before finalize produces exactly that.
- When the automatic retry then delivers, every D5 surface counts the tenant, but
  the share keeps:
  - its "Failed" pill (broadcasts/broadcastFormat.ts:66-71);
  - its "Failed" tab;
  - an "all recipients failed" alert on the results page
    (broadcasts/BroadcastResults.tsx:141-145).
- D7's presentation override only replaces "Sent" with "Not sent". Nothing
  covers a `failed` share that has a counted recipient.

**This race is concrete in the hermetic stack.** The fake emits a failure
callback about 300ms after the send (`fake-twilio/src/engine/delivery.ts:18-19,
29-31`). For one recipient, the fan-out's post-send work before finalize is about
seven DynamoDB round trips plus a token acquire (broadcastFanOut.ts:430-489,
631, 667-693). So section 7's own acceptance scenario ("a share text that fails
30003 and delivers on retry counts") will sometimes finalize `failed` and
sometimes `sent`. That is a timing-dependent outcome in the gate suite.

**Implies.** State the new slot invariant: a slot may leave `failed` only via a
recorded attempt of the same recipient. Then decide what a `failed` share with a
counted recipient shows, and whether finalize's lifecycle decision should wait
for the retry chain or be superseded by the live rule.

---

## F3 [MEDIUM] D5 separates "retry pending" from "finally failed", but D5(d)/D7 render both identically, promising a retry that may never come and inviting a double send

**What is wrong.** D5(d) says the results row shows the latest attempt's outcome,
using "the existing carrier-code wording" (D7 table).

- For 30003 that wording is "Phone unreachable - will retry"
  (routes/contact/deliveryStatus.ts:777-778), and it appears on every 30003
  failure:
  - the last, exhausted attempt (twilio.ts:3354-3362);
  - a retry the switch refused (retrySend.ts:208-217);
  - a breaker-stopped conversation.
- The D7 table has no row for "retry pending", "retries exhausted" or "retry
  refused". G4's "real reason" fails for exactly the states v2 introduced.
- A failed row also carries "open conversation to retry"
  (BroadcastResults.tsx:63-67). The Retry route accepts any failed or
  undelivered message, even while an automatic retry is pending
  (routes/api.ts:1589-1595). The one-to-one timeline still offers Retry on the
  failed tail of a chain (routes/contact/Timeline.tsx:1969-1984).
- So during the window D5 calls "still on its way", the page staff decide from
  shows a plain failure and points at a button that sends the property a second
  time.
- The relay product withholds Retry in exactly this state: "offering one while a
  rung is in flight is the double-send this feature exists to prevent"
  (deliveryStatus.ts:702-712).
- The same page contradicts itself numerically: the Failed chip counts the
  pending-retry recipient (derived stats file it under `failed`,
  broadcastsRepo.ts:246-247), while D7's pill reads "Sent" because a pending
  retry counts.

**Implies.** The spec should own how a share row presents pending, exhausted and
refused retries, and whether the retry hint shows while a retry is pending. Copy
and the affordance are both in scope, because D5(d) and D7 already define this
row.

---

## F4 [MEDIUM] Section 9 lets Cameron cut the retry rule, but D6 is only correct with it

**What is wrong.**

- Section 9 lists "D5(d)/the retry rule (retries follow the share)" under
  "Confirm or cut each".
- D6's un-count ("a failure with no retry pending un-counts the pair") and its
  repair ("honors retries: a pair whose text was delivered on a retry stays
  counted") are defined in terms of that rule.
- Cut the rule and D6 keeps un-counting on the original's failure. That restores
  round-1 M1 exactly: delivered-on-retry pairs dropped from "Properties sent" and
  "Sent to tenants" (today they are kept), and the post-deploy repair deleting
  those rows from history.
- The spec gives no fallback.

**Implies.** Either the retry rule is not optional, or the spec states what D6
does without it. For example: never un-count a failure that scheduled an
automatic retry, and have the repair skip pairs whose text has any retry.

---

## F5 [LOW] "Latest attempt" is the wrong aggregation when attempts overlap

**What is wrong.** D5: "A share recipient's outcome follows their LATEST
attempt ... never counts when ... the latest attempt failed with no retry
pending."

Attempts can overlap:

- The Retry route re-sends any failed message "indefinitely" (api.ts:1558-1560,
  1589-1595).
- It runs alongside the automatic chain. F3 describes how staff are invited to
  press it while a retry is pending.

A delivered staff Retry followed by a later automatic attempt that fails again
leaves the latest attempt failed. D5 then says not counted, D6 un-counts, and
D5(d) shows failed - although the tenant received the property. The D6 repair
applies the same rule to history.

**Implies.** A delivered attempt should dominate: counted if any attempt
delivered, or if the latest is queued, sent or retry-pending. Rare, but it is
the rule's definition.

---

## F6 [LOW] D5(a) and I4 contradict themselves for tenants added by hand

**What is wrong.** D5(a) says two things about the same row:

- "the default-unchecked state in a blast, including tenants added by hand";
- "A seeded row - the one-to-one tenant, or a hand-picked tenant - stays
  pre-checked".

In the code a tenant added by hand starts unchecked when already sent
(broadcasts/RecipientPreview.tsx:199-213). It is also persisted into the draft's
seed list (RecipientPreview.tsx:215-220). On any re-preview it returns as a
seeded row (routes/broadcasts.ts:497-499, 548) and pre-checks
(RecipientPreview.tsx:76-79).

The two sentences encode today's unchecked-then-checked flip across a reload
rather than a decision. I4 ("leaves them unchecked in a blast ... a seeded row
stays checked") inherits the same contradiction. This was the M4 fix, and it is
only partly right.

---

## F7 [LOW] D6's revised wording disagrees with D5 in two places

**What is wrong.**

- **"never a share whose attempt failed".** D6 says a counted pair describes its
  latest counted share, "never a share whose attempt failed". D5 counts a share
  whose latest attempt failed with a retry pending. When that is the pair's only
  counted share, the pair counts but has no share it may describe.
- **"a delivered retry" re-counts.** D6 says "A later counted attempt - a
  delivered retry, or a new share - re-counts it". D5 counts a retry once it is
  `sent` (handed to the carrier), and D6 itself says the ledger is "judged from
  carrier acceptance onward". Two builders will re-count at different moments.

This was the M12 fix, and it is only partly right.

---

## F8 [LOW] I8 fixes one of three phone-first gates, and is silent on the staff Retry of a share message

**What is wrong.**

- **The deleted gate has the same defect.** The wrapper's deleted-contact gate
  reads the same first-hit phone lookup that I8 overrides for consent
  (services/sendMessage.ts:307, 324-327; repos/contactsRepo.ts:1011-1037).
  Soft-delete keeps every field, including the phone, so a deleted duplicate
  stays in the phone index (contactsRepo.ts:650-657, 1220-1234). A soft-deleted
  duplicate returned first refuses a share to a live recipient, and D7 now
  labels it "Contact was deleted".
- **Opt-out is different.** The opt-out gate is legitimately number-scoped
  (services/numberSuppression.ts:1-19), so the spec should say which gates are
  per-number and which are per-recipient.
- **The staff Retry of a share message.** D5 says "every attempt belongs to the
  share that started it". But the staff Retry goes through the generic route with
  `automated: false`, so it reaches the same consent gate by phone (api.ts:1642-1652).
  I8 does not say whether it covers that attempt. The route cannot know the
  recipient contact without following the share lineage.

This was the M7 fix, and it is only partly right.

---

## F9 [LOW] Section 7's retry acceptance needs a test seam the spec never lists

**What is wrong.**

- The e2e case "a share text that fails 30003 and delivers on retry counts" runs
  through the one-to-one retry job.
- That job's backoff is a bare 60/120/240s function with no override
  (retrySend.ts:39-42, 73-77).
- The relay feature had to inject its backoff for the same kind of test, and says
  plainly that there was no precedent seam
  (relay-30003-retry-lineage-design.md:827-834).

Without a seam the e2e case waits at least 60s of real time per run. Adding a
seam is a new dev/test surface, and section 5 lists none.

---

## F10 [LOW] D4 does not say how a users-table read failure is treated

**What is wrong.**

- D4 adds a read on the send path: "the creator is staff when it resolves to a
  record in the users table", and "Unrecognized means automated".
- A transient read failure is not the same thing as "unresolvable" (the
  batch-read absence lesson). Each obvious choice has a cost:
  - **Treat it as unrecognized.** A staff share is silently sent as automated, so
    breaker-stopped conversations refuse it.
  - **Let it throw.** The job's execution marker is written before any send
    (broadcastFanOut.ts:228-238). A throw is then suppressed on redelivery, the
    share is stranded `sending`, and every recipient counts as sent under D5's
    accepted stuck case (broadcastFanOut.ts:553-564).
- The premises of the rule itself check out:
  - users are `invited | active` and removal is a hard delete
    (repos/usersRepo.ts:49-54, 448-451);
  - the draft route stamps the session user (broadcasts.ts:369, 448-449), and the
    session middleware re-checks that the user exists (middleware/auth.ts:182-195);
  - the worker container shares the instance role that covers every table
    (`infra/modules/ec2/main.tf:1, 45-61`).

---

## F11 [LOW] "until someone closes it" names a remedy that does not exist

**What is wrong.**

- D5's known-and-accepted stuck share "count[s] until someone closes it". No
  route closes a stuck `sending` share: patch and delete are draft-only
  (broadcasts.ts:837-900).
- I7 forbids a production write outside D2 and the D6 repair.
- So those tenants stay "Already sent" for that property permanently. The
  accepted risk should say so.

---

## F12 [LOW] The amended WP2 issue contradicts D4, and uses the shorthand the spec just banned from issue copy

**What is wrong.**

- The issue now says "staff-created" in its problem paragraph, but still says
  "shares that staff start" in the interim-state paragraph and in item 2
  (docs/issues/ai-mode-switch-gates-all-automation.md:45-46, 55-56).
- Creator versus starter is the exact ambiguity D4 settled, and the issue is what
  WP2 and WP3 will build from.
- Items 2 and 8 also use "share" and "share send job". That breaks v2's own rule
  that the shorthand is "never UI, RUNBOOK or issue copy", in the same commit
  that introduced the rule.

---

## Contested adjudications

- **M13 (my B6): conceded.** v2 states "wire and log only; no new chip", that the
  Skipped chip sums every bucket, and that the finalize log reports every skip.
  That settles the ambiguity. One nit remains: "every other skip goes to its own
  bucket" reads as one bucket per reason rather than the single "other skipped"
  bucket the adjudication describes. It is wire-only, so not contested.
- **M15 (my B14): conceded** on the GLOSSARY change. The replacement rule is
  already broken in the same commit (F12), but that is a new finding, not a
  contest.
- **M11 (reviewer A's A10): not contested.** The stated reason (I7) covers
  history only; new shares could be filed at finalize without a production
  rewrite. Presentation-only still stands, because D5's outcome keeps changing
  after finalize (retries, late callbacks). F2 adds a third case the accepted
  split does not cover: a "Failed" share with a counted recipient.

---

## Are the accepted round-1 fixes correct?

| Item | Verdict | Notes |
|---|---|---|
| M1 (retry rule) | Direction right; mechanism not deliverable as written | See F1-F5 and F9. |
| M2 (D5(c) render-time count) | Correct | The stated cost holds. The contact timeline does not subscribe to share updates (only BroadcastResults and the list do: api/EventStreamProvider.tsx:194-197). |
| M3 (queued only while sending) | Correct | F11 is a nit. |
| M4 (seeded rows) | Partly correct | See F6. |
| M5 (issue item 8) | Correct in the spec | Issue wording: F12. |
| M6 (users-table rule) | Correct | Premises verified (F10). Read-failure handling is open. |
| M7 (I8) | Partly correct | See F8. |
| M8 (negative population) | Correct | The only non-conversation items in the table are phone/email claims and token pointers (repos/conversationsRepo.ts:510-526). None carries `ai_mode`, so the `manual` condition keeps them out. |
| M9, M14, M16 | Correct | Claim 3 still says "after creation only the breaker writes it" in the same sentence that notes the import writes existing rows lacking the field. Trivial. |
| M10 (reason copy) | Correct for the codes listed | The retry states are missing: F3. |
| M12 (latest counted share) | Partly correct | See F7. |

---

## Section 1 claims changed in v2 - verification

- **Claim 2, consent checks the phone lookup's first contact: VERIFIED.**
  sendMessage.ts:307, 338-344; contactsRepo.ts:1011-1037. The lookup can also
  hop through a phone pointer to a different contact.
- **Claim 3, the if-absent write also lands on existing rows: VERIFIED.**
  lib/import/apply.ts:1093.
- **Claim 7, a `failed` share is excluded: VERIFIED.** broadcastsRepo.ts:537.
- **Claim 8, one row per pair refreshed to the latest share: VERIFIED.**
  repos/listingSendsRepo.ts:136-178.
- **Claim 11, retries send a new message with no share id: VERIFIED.**
  - Three retries at 60s, 120s and 240s: retrySend.ts:36-42 and
    twilio.ts:3350-3369.
  - Neither retry path carries the share id: retrySend.ts:200-207 and
    api.ts:1642-1652.
  - The results page points staff at Retry: BroadcastResults.tsx:63-67.
  - The rollup only follows stamped messages (twilio.ts:3312); the only reader of
    a message's `broadcast_id` is the rollup.
- **Section 1 prose, the architecture doc wording: UNVERIFIED by me.** It is a
  .docx; reviewer A extracted the text.
