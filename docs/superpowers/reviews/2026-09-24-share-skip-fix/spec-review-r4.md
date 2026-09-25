# Spec review r4 (reviewer B, terminal round) - share-skip-fix design v4

Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` at 7ac57f31
(v4). Also read: the round-3 adjudications. Read-only; every claim below was
checked in this worktree.

Scope is unchanged from earlier rounds: this is a top-level spec review, so no
implementation steps or code are proposed. Paths are under `app/src/` and
`dashboard/src/` unless stated otherwise.

**Decision impact.** Two findings would each ADD a decision:

- F1: a write rule for the widened repair, and I9's reach over it.
- F3: when the repair runs relative to deploy.

No finding reverses an existing decision. F2 and F4 are precision fixes.

## Answers to the coordinator's two mechanism questions

### 1. Can the repair identify historical retries from lineage alone?

Mostly yes, with one gap.

**Where lineage is sound:**

- A staff Retry writes `retry_of` in the same write as the message
  (services/sendMessage.ts:425-427, fed by routes/api.ts:1651).
- An automatic retry's lineage (`retry_of`, `retry_attempt`) points at the
  previous attempt, not at the root. The repair must therefore walk forward from
  the share's original, whose message key is on the recipient slot
  (jobs/broadcastFanOut.ts:430-434).

**The gap:**

- An automatic retry gets its lineage from a SEPARATE write after the send
  (jobs/retrySend.ts:221-229).
- A crash or a failed write between the two leaves a sent retry that no lineage
  reaches. The repair and D1 cannot see it.
- Rare. Going forward it cannot happen, because the retry will carry the share
  at send time.
- How often it happened in production is UNVERIFIED.

### 2. Can the bounded per-recipient record deliver "any delivered attempt dominates"?

The record holds the newest attempt and a delivered flag.

**Sequential chains: yes.**

- A retry exists only after the previous attempt failed. So an older attempt is
  terminal before a newer one is recorded.
- Delivery status is forward-only per message (repos/messagesRepo.ts:133-142).
- Duplicate callbacks are dropped by the transition gate
  (routes/webhooks/twilio.ts:3303).

**Overlapping attempts: not as specified (F2).** Overlap means a staff Retry
during the backoff, or a double Retry.

- Today's rollup matches a callback only to the recorded (conversationId,
  tsMsgId) and drops the rest (twilio.ts:3591-3611).
- With only the newest attempt recorded, an older in-flight attempt's
  "delivered" has nothing to match.

---

## F1 [MEDIUM] The widened repair is not bound by I9 or by any concurrency rule, although it now writes records the live system also writes

**What is wrong.**

- v4 makes the post-deploy repair a writer of historical shares' recorded
  attempts as well as the ledger (D6 last bullet; I7; section 5).
- Two things are missing:
  - **I9 contradicts the repair's purpose.** I9 says a recorded outcome "leaves
    `failed` only through a newly sent attempt". The repair moves historical
    `failed` records to delivered using attempts sent weeks earlier, not newly
    sent ones.
  - **Nothing stops the repair erasing live state.** I9 forbids a later attempt
    from erasing a recorded delivery, but says nothing about the repair.
- After deploy, the live system writes the same historical records:
  - The results page sends staff to Retry any failed row
    (broadcasts/BroadcastResults.tsx:63-67).
  - The Retry route accepts an old failed message "indefinitely"
    (api.ts:1558-1560, 1589-1595).
  - v4 makes that Retry carry the share and record an attempt (section 5).
  - A new share of the same property refreshes the ledger pair.
- So a repair that writes from a read taken earlier - including a dry run whose
  plan is later applied - can overwrite a live attempt or a live delivery flag.
  That breaks I9's core promise, through the one production writer I7 blesses.
- D2 states its concurrency rule ("every write is conditional on the row still
  being ... so a re-run or a concurrent change is safe"). The repair, now with a
  wider remit, states none.

**Implies (decision).** Say that the repair records a historical attempt only
where the record is unchanged since its read and never erases a recorded
delivery. Reword I9 so recording an attempt that was sent in the past is
explicitly allowed.

---

## F2 [LOW] The bounded record cannot deliver v4's own sentence about an older attempt, unless the spec states how an attempt finds its recipient

**What is wrong.**

- D5 says: "An older attempt still `sent` beside a newer failed one keeps the
  recipient eligible: if it delivers, they count."
- The same section bounds the record to "the newest attempt and whether any
  attempt delivered - never a list of attempts".
- Today's rollup finds a recipient only by the recorded attempt's identity, and
  drops any callback it cannot match (twilio.ts:3591-3611). The same limit
  applies to a retry writer looking for the attempt it retried.
- So in the overlap case, the older attempt's delivery is never recorded, and
  the tenant who received the property reads not sent.

**Only one mechanism can work:** attribute an attempt to its recipient by the
message's share stamp plus its conversation. Each recipient normally has its own
conversation.

**That mechanism is ambiguous in one case.** Two recipients of one share can
share a conversation: duplicate contacts on one phone, which section 8 already
notes.

**Implies.** The spec should state the attribution rule, and what happens to
recipients who share a conversation. Overlap is rare, which is why this is LOW.

---

## F3 [LOW] Between deploy and the repair, "Already sent" regresses for historical delivered-on-retry tenants

**What is wrong.**

- Today's union flags every recipient of a sent or sending share, whatever the
  slot says (repos/broadcastsRepo.ts:536-538). A tenant whose share text failed
  and was later delivered by a pre-branch retry is flagged today.
- From deploy, D5 reads only recorded attempts. Those tenants' historical retries
  are recorded only when the repair runs.
- Section 6 runs the repair "after Cameron merges and deploys ... on his go",
  with no bound on the gap.
- For that whole window:
  - "Already sent" and the D5(c)/(d)/(e) surfaces call these tenants not sent,
    while the ledger still lists them;
  - in a blast they come back pre-checked, so a share of that property texts
    them a second time.
- Small population (D1 now sizes it), but it is a regression the spec does not
  acknowledge.

**Implies (decision).** Either run the repair's history step immediately after
deploy as part of the rollout, or accept the window explicitly in section 8.

---

## F4 [LOW] D5(e)'s three-value label rule has no carve-out for drafts and no precedence

**What is wrong.**

- **Drafts.** A draft's recipient map is empty until send (repos/broadcastsRepo.ts:490;
  markSending at 552-578). "Sent when any recipient counts; otherwise Not sent"
  therefore labels every draft "Not sent" in the list. Draft rows keep their
  Delete action and link back to the composer
  (broadcasts/BroadcastsList.tsx:30-33, 144, 156-168).
- **Precedence.** A `sending` share with queued recipients satisfies both
  "Sending" and "Sent", because D5 counts queued recipients while the share is
  `sending`. The rule does not say which wins.

---

## Contested adjudications

None.

On R3-5, the adjudication cites "out of scope per non-goals" for keeping today's
gates on the automatic retry. No listed non-goal covers retry gates: the
non-goals cover retry policy, the timeline Retry affordance and the switch
redesign. The decision is still defensible as scope control. The consequence -
a Do Not Contact set on the recipient contact is missed by a retry when a
duplicate is phone-first (sendMessage.ts:307-318; routes/contacts.ts:1934-1940)
- is pre-existing for every one-to-one retry. Not contested.

---

## Are the round-3 fixes correct?

| Item | Verdict | Notes |
|---|---|---|
| R3-1: the repair records historical attempts | Correct direction | Write rule and I9 reach: F1. Deploy-to-repair window: F3. Lineage gap for automatic retries: answer 1 above (rare). |
| R3-2: labels Sending / Sent / Not sent | Correct | Drafts and precedence: F4. The "Not sent during the retry wait" window is accepted by design; see section 8. |
| R3-3: exhausted 30003 wording | Correct | Exhaustion matches the webhook's own decision, which uses the failed message's `retry_attempt` (twilio.ts:3353-3362). A staff Retry message carries no `retry_attempt`, so its 30003 starts a new chain and correctly reads "will retry". The new label must be ASCII per AGENTS.md; the existing "will retry" string (deliveryStatus.ts:778) keeps its em dash untouched. |
| R3-4: the outcome that decides the count; I9 no-erase | Correct in the rule | Needs an attribution rule: F2. |
| R3-5: automatic retry keeps today's gates; claim 2 on Do Not Contact | Correct | Claim 2 could also name the import, which likewise sets only the contact flag (lib/import/apply.ts:1029-1033). Trivial. |
| R3-6: Select all keeps seeded rows checked | Correct | Today's Select all is RecipientPreview.tsx:149-155. |
| R3-7: stored alert suppressed only on "Sent"; queued slot of a non-sending share reads "Not sent" | Correct | Resolves the enqueue-failure case (broadcasts.ts:756-770). |
| R3-8: bounded record | Correct on the byte budget | Its consequence for the overlap case: F2. |
