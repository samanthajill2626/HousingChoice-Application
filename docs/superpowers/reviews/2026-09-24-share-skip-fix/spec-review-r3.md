# Spec review r3 (reviewer B) - share-skip-fix design v3

Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` at fc89dd0a
(v3). Also read: the WP2 issue as amended in that commit and the round-2
adjudications. Read-only; every claim below was checked in this worktree.

Scope is unchanged from rounds 1 and 2. A finding is one of:

- a current-behavior claim the code contradicts;
- a decision that is wrong, missing, ambiguous or contradictory;
- a guarantee the proposed mechanism cannot deliver;
- a writer or reader the spec does not account for.

No implementation steps are proposed. Paths are under `app/src/` and
`dashboard/src/` unless stated otherwise.

## Answers to the coordinator's four mechanism questions

1. **Can D5 be delivered from recorded facts alone?** Going forward, yes. The
   durable fact "a text was actually sent carrying the share" is the message row,
   which the send wrapper appends with the share id before it returns
   (services/sendMessage.ts:398-428). Once both retry paths pass the share id,
   every attempt is recorded on the same terms as the fan-out's original.
   **For history, no - see F1.** Pre-branch retries carry no share id, so their
   outcomes exist only in retry lineage on the message rows. Only the D6 repair
   reads that lineage.
2. **Do "any delivered attempt dominates" and I9 hold under out-of-order and
   duplicate callbacks?**
   - Within one attempt, yes. Message delivery status is forward-only
     (repos/messagesRepo.ts:133-142), and the share rollup runs only on a real
     transition (routes/webhooks/twilio.ts:3303).
   - Across attempts, only if every attempt's identity stays matchable. Today a
     callback is matched to exactly one (conversationId, tsMsgId) per slot, and
     an unmatched one is dropped (twilio.ts:3591-3611).
   - I9 does not state that a recorded delivery survives a later attempt. See F4.
3. **Does D4's creation-time record cover every draft path that exists today?**
   Yes.
   - The only runtime creator of share rows is the draft route
     (routes/broadcasts.ts:448).
   - `/api` is behind `requireAuth` (app.ts:223), and every user role is staff:
     `admin | va` (repos/usersRepo.ts:40).
   - No dev route creates shares.
   - Seeds and the performance world write raw rows
     (lib/seed/matrix.ts:1203-1249; lib/performanceSeed.ts:178-200). Section 5
     already requires the record where a test sends a seeded share.
   - Drafts saved before deploy are automated, as D4 states. That is fine after D2
     except on breaker-stopped conversations.
4. **Does D5(e) have a reader that still shows the stored status?**
   - Displays of the stored status: only the pill on the results page and the
     list (BroadcastResults.tsx:138; BroadcastsList.tsx:144, both via
     BroadcastStatusPill.tsx:16-19), the list tabs (accepted split), and the
     stored `last_error` alert (BroadcastResults.tsx:141-145).
   - Stored-status readers that are not displays: results polling stops once the
     stored status is terminal (useBroadcastResults.ts:147-157). Post-finalize
     changes (a retry sent from the worker, or its callback in the app) therefore
     reach the page only through live events. That is fine as long as both retry
     writers emit events.
   - Both live overlays copy `status` and `stats` only
     (useBroadcastResults.ts:121-134; useBroadcastsList.ts:111-124). So the
     derived label must be computable from `stats`.
   - One stored-status reader D5(e) mishandles: the enqueue-failure alert (F7).

---

## F1 [MEDIUM] Historical retries were never recorded against their shares, so after the D6 repair the ledger and every other surface disagree for pre-branch delivered-on-retry recipients

**What is wrong.**

- D5 derives (a) "Already sent", (c) the activity count, (d) the results row and
  (e) the label from "the share's stored outcomes". D5(c) promises that this is
  "right for shares already on record ... and after later attempts".
- Before this branch, both retry paths sent a NEW message with no share id
  (spec claim 11; jobs/retrySend.ts:200-207; routes/api.ts:1642-1652). The
  share's stored outcome for such a recipient is the original's `failed`,
  forever.
- Their real outcomes exist only as retry lineage on message rows: `retry_of`
  and `retry_attempt` (retrySend.ts:226-229; api.ts:1651).
- The D6 repair "judges by attempts: a pair whose text was delivered on a retry
  stays counted". So it walks that lineage, but it writes only the ledger.
  Section 5 lists the repair as a ledger writer, never a recipient-outcome
  writer.

**Consequence.** For every pre-branch recipient whose share text failed and was
then delivered by the automatic 30003 retry, or by a staff Retry (which the
results page has always pointed staff to, BroadcastResults.tsx:63-67):

- After the repair, "Properties sent" and "Sent to tenants" list the property.
- The review list says NOT already sent and pre-checks them in a blast, so they
  would be texted again.
- The activity count excludes them, the results row still shows the original
  failure, and a one-recipient share reads "Not sent".

G3 and I3 fail for history, in the direction that double-texts a tenant.

Historical retries are plausible only on conversations whose switch was already
on: imported conversations refused them as `manual_mode`. How many exist in
production is UNVERIFIED, and D1 does not size it.

**Implies (decision).** Choose one:

- the D6 repair, which already walks the lineage and is an allowed production
  writer under I7, also records those historical attempts against their shares;
- or the spec states the divergence for history as accepted, and D1 counts it.

---

## F2 [MEDIUM] During every 30003 retry backoff, the derived label says "Not sent" while the row promises "will retry"; D5(e)'s rule is also underdefined

**What is wrong.**

- v3 removes the pending state. A recipient whose newest attempt failed does not
  count during the backoff (D5; section 8: "reads not sent everywhere").
- D5(e) then gives a one-recipient share the label "Not sent". Meanwhile D5(d)
  and the D7 table keep the row's "will retry" wording and the retry hint for
  the same recipient on the same page (deliveryStatus.ts:777-778;
  BroadcastResults.tsx:63-67).
- The two derive opposite messages from the same recorded fact (a 30003 on the
  newest attempt). This is not the chip/pill contradiction the adjudication
  retired; it is a new pill/row one.
- The only text that could reconcile them is D5(e)'s condition "Not sent when no
  recipient counts **and none is in flight**". Under v3's rule, everything in
  flight (newest attempt queued while sending, or sent) already counts, so the
  clause is either redundant or means "a retry is scheduled" - the pending state
  v3 removed.
- D5(e) also lists a "Failed" label but never says when it applies. By the stated
  rule, a share whose every recipient failed inside the send job would read "Not
  sent", and "Failed" would never appear. D7's last bullet files that share under
  the "Failed" tab without naming its label.

**Why it matters.** On a one-to-one share, "Not sent" is exactly the signal that
sends Sam to paste the flyer link by hand (her documented workaround in #5). If
the retry then delivers, the tenant is texted twice. Section 8 accepts double
texts only for "a second share started in that window". This path goes through
the label this branch introduces, and it is the likelier one.

**Implies (decision).** Define the three labels completely. Decide what a share
reads while its newest failure is a 30003 below the retry cap. That depth is a
recorded fact, and D5(d) already relies on it to promise a retry.

---

## F3 [MEDIUM] (contests round-2 adjudication R2-3) Exhaustion is derivable, yet every exhausted 30003 row keeps a false "will retry"

**What is wrong.**

- D5(d) and the D7 table keep "the existing carrier-code wording (30003 keeps
  'will retry')" on every 30003 row.
- The adjudication rejected new copy because "a refused retry is unrecorded, so
  truthful wording is not derivable". That holds for refusals and for retries
  that were never scheduled. It does not hold for exhaustion, and v3's own claim
  11 says so: "only exhaustion is derivable".
- The chain's depth is recorded on every retry message: `retry_attempt`
  (retrySend.ts:226-229). The webhook decides exhaustion from it
  (twilio.ts:3353-3362). With v3's attempts recorded against the share, it is
  also derivable as the count of the recipient's recorded retries.
- Exhaustion is the normal end of a chain for a handset that stays off past
  about seven minutes. On that row, "Phone unreachable - will retry"
  (deliveryStatus.ts:777-778) is permanently false. It may make staff wait for a
  send that will never come, while the label says "Not sent".
- Truthful copy already exists: the relay override "Phone unreachable", which
  drops the promise where no retry follows (deliveryStatus.ts:820-861).
- The timeline's matching wording is a non-goal and can stay. The share row is
  this spec's own D7 surface.

**Implies (decision).** Show the non-promising 30003 copy when the newest failed
attempt is at the retry cap. Keep "will retry" only below the cap, where v3
accepts unrecorded refusals.

---

## F4 [LOW] Overlapping attempts expose three gaps in the attempts rule

Section 8 accepts that a staff Retry pressed during the automatic backoff can
double-text. The Retry route accepts the same failed message "indefinitely"
(api.ts:1558-1560, 1589-1595). With two attempts overlapping:

- **The counting rule has no answer when an older attempt is still `sent` and
  the newest has failed.** "Any delivered" and "newest queued/sent" are both
  false, so the recipient does not count, although "every attempt failed" is also
  false. I4 promises to flag a tenant whose text is "on its way", and this one is
  not flagged.
- **D5(d) disagrees with the counting rule.** It shows the NEWEST attempt's
  outcome, so a recipient who counts through an earlier delivered attempt shows a
  failed row (with the retry hint) under a "Sent" label.
- **I9 protects only leaving `failed`.** The dominance rule also needs "a
  recorded delivery is never lost to a later attempt". The rollup today matches
  one (conversationId, tsMsgId) per slot and drops what it cannot match
  (twilio.ts:3591-3611). A record that tracks only the current attempt loses the
  earlier attempt's later delivery callback.

---

## F5 [LOW] I8 is ambiguous for the automatic retry, and claim 2 overstates "opt-out is per number"

**What is wrong.**

- **The automatic retry.** I8 covers "a share's own sends" and states that a
  staff Retry uses today's gates. It does not say which rule the automatic retry
  follows, although v3 makes it an attempt of the share.
- **Today's opt-out check reads only the conversation flag and the phone-first
  contact** (services/sendMessage.ts:307-318).
  - STOP always writes the conversation flag (twilio.ts:1071-1073), so it is per
    number.
  - Do Not Contact writes only the chosen contact's flag. The code states
    "Conversation-level denorm isn't propagated here"
    (routes/contacts.ts:1934-1940, 1960-1961). The import does the same
    (lib/import/apply.ts:1029-1033).
- **Consequence.** With duplicates, a Do Not Contact or imported opt-out on the
  recipient contact is invisible to the wrapper when the other contact is
  returned first.
  - The original text is still protected by the fan-out's own first fence on the
    recipient (jobs/broadcastFanOut.ts:381-390).
  - An automatic retry on today's gates is not. That contradicts I8's "either
    contact's opt-out refuses" for an attempt of the share.
- **Claim 2 overstates.** Its new wording, "opt-out is per number by design", is
  true only for STOP and 21610.

---

## F6 [LOW] "A seeded row stays checked" (D5(a), I4) contradicts Select all

**What is wrong.**

- Select all sets every row to `hasConsent && !alreadySentThisProperty`, and that
  includes seeded rows (broadcasts/RecipientPreview.tsx:149-155).
- In the one-to-one flow it unchecks the only row. That trips the resolved-mode
  Send block and its "This message was written for ..." note
  (RecipientPreview.tsx:119-124, 455-461).
- D5(a) now pre-checks hand-picked tenants on add, which makes the Select all
  exception the only path that still unchecks a seeded row. The spec does not say
  whether Select all keeps its behavior.

---

## F7 [LOW] A share whose send never started reads "Not sent" while its rows read "Sending...", and D5(e) replaces its only true explanation

**What is wrong.**

- After an enqueue failure, every slot stays `queued` in a stored-`failed` share
  (routes/broadcasts.ts:756-770). D5 does not count those slots, so D5(e) derives
  "Not sent".
- Each row still presents `queued` as in flight: "Sending..."
  (broadcasts/broadcastFormat.ts:106-109; routes/contact/deliveryStatus.ts:52).
- The one accurate explanation is the stored alert "enqueue failed"
  (broadcasts.ts:764, shown at BroadcastResults.tsx:141-145). D5(e) says the
  results page's failure alert must "derive from its recipients, not its stored
  status", and these recipients carry no reason at all.
- Two builders diverge on whether that alert survives.

---

## F8 [LOW] Recording attempts on the share item changes the byte budget the recipient cap was sized for

**What is wrong.**

- The recipients map lives on the share item. MAX_BROADCAST_RECIPIENTS = 1500 was
  sized at about 200 bytes per recipient slot, so the map "can never overflow the
  item" (repos/broadcastsRepo.ts:13-18, 56-67).
- D5 records up to four attempts per recipient (the original and three retries)
  "against that share". Each retry adds its own message key, status and reason.
- The spec does not say whether attempts stay within the existing bound, or
  whether the cap is revisited. At the ceiling, an attempt write fails. D5's "every
  text actually sent ... is an attempt recorded against that share" then silently
  does not hold.
- Unlikely in practice: it needs many 30003 retries in a near-cap blast. It is
  still an invariant the change touches without accounting for it.

---

## Contested adjudications

- **R2-3: contested in part (F3).** Refusals and unscheduled retries are
  unrecorded, so I concede those. Exhaustion is recorded, and v3's claim 11 says
  it is derivable (retrySend.ts:226-229; twilio.ts:3353-3362). Non-promising copy
  already exists (deliveryStatus.ts:859-861). "Pre-existing on the conversation
  timeline" is a reason to leave the timeline alone (a non-goal). It is not a
  reason for this spec's own D7 row to repeat a false promise it can derive.
- **All other round-2 adjudications: accepted.**

---

## Are the round-2 fixes correct?

| Item | Verdict | Notes |
|---|---|---|
| R2-1 (attempts, no pending state) | Correct going forward | History: F1. Label versus row: F2. Exhausted copy: F3. |
| R2-2 (I9, D5(e), section 7 rule) | Correct in intent | I9 gap: F4. Enqueue-failure case: F7. The section 7 rule against asserting stored status is right: the fake emits a failure about 300ms after send (`fake-twilio/src/engine/delivery.ts:18-31`). |
| R2-4 (retry rule not optional) | Correct | |
| R2-5 (any delivered dominates) | Correct in the rule | D5(d) still says "newest attempt's outcome": F4. |
| R2-6 (hand-picked pre-checked on add) | Correct | Select all: F6. |
| R2-7 (D6 in D5's terms) | Correct | |
| R2-8 (I8 widened) | Partly correct | Automatic retry and the opt-out overstatement: F5. |
| R2-9 (retry-backoff seam listed) | Correct | "As the relay retry ladder's is" adopts relay's configuration posture (relay-30003-retry-lineage-design.md:827-834), which is acceptable. |
| R2-10 (creation-time record) | Correct | Verified: answer 3 above. |
| R2-11, R2-12, M13 nit, claim-3 nit | Correct | One residual: the WP2 issue's problem paragraph still says "after creation only the breaker writes it" (issue lines 23-24), the wording the spec fixed in claim 3. Trivial. |

---

## Section 1 claims changed in v3 - verification

- **Claim 2: VERIFIED for the deleted and consent gates; OVERSTATED for opt-out
  (F5).**
  - Deleted and consent read the phone-first contact: sendMessage.ts:307,
    324-327, 338-344; repos/contactsRepo.ts:1011-1037.
  - The deleted-contact overstatement is still live, because soft-delete keeps
    the phone in the index (contactsRepo.ts:1220-1234).
- **Claim 6: VERIFIED.** broadcastFanOut.ts:690-693, and the alert at
  BroadcastResults.tsx:141-145.
- **Claim 11: VERIFIED.**
  - Refusal is silent: retrySend.ts:208-217.
  - An unscheduled retry is only logged: twilio.ts:3364-3368, 3524-3528.
  - An errored job is suppressed: retrySend.ts:129-138, 218.
  - Exhaustion is derivable: twilio.ts:3353-3362.
  - The forward-only rule: twilio.ts:3537-3548.
