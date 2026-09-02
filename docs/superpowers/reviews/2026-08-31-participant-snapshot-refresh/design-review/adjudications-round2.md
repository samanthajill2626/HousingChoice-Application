# Spec design review - round 2 adjudications

Spec v2 @8053bbea. Reviewer: B continued (same agent, same context), given the
re-review charge, v2, the round-1 adjudications, and reviewer A's report.
Findings at `../spec-review-round2-findings.md`.

22 findings, 3 BLOCKING. **19 ACCEPT, 1 REJECT, 2 DEFER**, plus one scope fork
escalated to Cameron.

**Round 2 changed MORE decisions than round 1, not fewer.** That is recorded
plainly because it is the signal that matters: the design is not converging by
patching, and the reason is legible in the findings themselves.

---

## The finding that inverts a round-1 fix

### ACCEPT - R1 (BLOCKING). Planner-verified in the code.

v2's 5.4 put `requireComplete` on the relay intro and member-added jobs so a
throttled batch would "fail the job, so redelivery retries". **It does not
retry.** `jobs/relayFanOut.ts:615-622` stamps the job-execution marker BEFORE
reading the roster at `:626` and composing at `:633-634`. A throw after the
stamp leaves the marker written; SQS redelivers,
`putJobExecutionMarker` returns false, and the handler RETURNS WITHOUT
SENDING. `messagesRepo.ts:1264-1268` states that contract. The member-added
job has the identical shape at `:671-678`.

The intro is the A2P first-contact message carrying the brand and the STOP
instruction (`relayFanOut.ts:213-215`). So round 1's B4 traded a shortened
connection sentence for a **permanently absent legally-required message**.

I verified the ordering myself before adjudicating. It is exactly as reported.

DECISION CHANGED, and it is the second time this decision has moved. The fix
is NOT another patch to the absence rule - see the escalation below.

### ACCEPT - R2 (BLOCKING)

`requireComplete` is an option on `getManyByIds` only
(`contactsRepo.ts:611-614`). v2's rung 2 is a separate capped serial mechanism,
so a member resolvable only by phone who falls past the cap is dropped from
`composeConnectionSentence` exactly as B4 described - the same failure reached
through the cap instead of the throttle, invisible to `requireComplete`.
Reinforced by `lib/import/apply.ts:1075`, which writes imported rosters as
`{contactId, phone}` with NO name: imported rosters are nameless by
construction, which is the population most exposed to this.

### ACCEPT - R3 (BLOCKING)

`routes/webhooks/twilio.ts:398-402` states that the push promise is
deliberately NOT awaited so a slow push can never delay or fail the webhook
ack. v2's S5 computes the TITLE synchronously outside that boundary, so
hydrating `:727` and `:1810` puts an awaited batch read ON the ack path.

R3's second half is the useful one: the other three S5 sites are FREE.
`pushSenderLabel` is already handed `senderContact` (`:728`, `:1814-1818`) and
`maskedPartyLabel` is already handed the matching contact
(`voice.ts:980-982`, `:990`). Pricing free precedence flips together with two
costly title reads hid that. S5 splits.

---

## Accepted - claims about existing behavior

| # | finding | disposition |
|---|---|---|
| R4 (HIGH) | Section 3's justification for reversing `relayGroups.ts:474-476` MISREADS the comment. Its second clause is not precedence - "otherwise the dashboard uses this current roster phone as its fallback" is the read-failure branch, implemented at `:482-489` and client-side at `recipientLabel.ts:121`, with `:95-99` stating "must not be 'fixed' in either direction". | ACCEPT. My reading was wrong and I argued it to Cameron as settled. The reversal may still be his call - he made it knowingly - but the spec must state the trade honestly (an actionable number traded for a possibly-wrong assertion, on the surface where an operator picks relay recipients) and must say what `recipientLabel.ts:95-99` now means. **Re-surfaced to Cameron with the corrected reading.** |
| R5 (HIGH) | Decision 2 says "never one read per member"; `relayGroups.ts:468-492` is a `Promise.all` of per-member `getById` that v2 puts in scope and leaves unbatched. | ACCEPT. Batch it with `getDisplaysByIds`. |
| R6 (HIGH) | 4.1's writer table is short: `contacts.ts:1909-1912` and `inboundEmail.ts:909-917` write via `createOrGetByParticipantEmail`'s `opts.displayName` (`conversationsRepo.ts:587-594`), which a literal grep misses. | ACCEPT. Both added, and both are also census entries for section 9. R6's closing point is the one to take: a table that ASSERTS completeness and is short on its first row is worse than one that does not, because the next reviewer stops looking. The completeness claim is downgraded to "every line was opened; the tables are not asserted exhaustive". |
| R7 (HIGH) | The deferral basis "neither deferred reader shares a rendered thread with a hydrated surface" is false for BOTH. `relayGroupDuplicates.ts:128-132` rides the SAME `RosterPreview` object S4 hydrates (`rosterEdits.ts:478-481`, `:535-536`) - one dialog, two name sources. | ACCEPT. `relayGroupDuplicates` moves IN scope. `poolNumbersAdmin` stays deferred but on an honest basis (a different page, not a different thread). |
| R8 (HIGH) | 4.2's table says `resolveRoster` is fixed by S3; S3's text leaves it unchanged. The row matters because `rosterProvision.ts:106-121` `provisionMembersOf` copies `member.name` into a NEW thread's roster (`:117`) - a name WRITE. | ACCEPT. Contradiction resolved explicitly. R8 also verifies the count/phone claim IS correct for `rosterActions` and `placementNudges`. |
| R9 (HIGH) | Rung 2 can attach the WRONG person's name: `contactsRepo.ts:1011-1016` documents that duplicate phones return the FIRST GSI item in arbitrary order, and names imports as the population. v2 routes that into delivered SMS (S4) and push titles (S5). | ACCEPT, and it is decisive. "Wrong name in a panel a navigator can correct" and "wrong name texted to a tenant" are not the same risk. See the escalation. |
| R10 (HIGH) | Rung 2's cost is understated ~2x and is serial: `findByPhone` is a GSI Query, and a phone-pointer hit issues a SECOND read (`contactsRepo.ts:1031-1035`). A cap of 25 authorises up to 50 sequential round trips on `GET /api/inbox`. | ACCEPT. The mechanism introduced to prevent an amplification class reintroduced it. |
| R11 (MEDIUM) | The cap of 25 is fixed against the distribution S6 exists to measure, and fires for every bare-phone member, not only the triage-stub case. | ACCEPT. |
| R12 (MEDIUM) | Section 11's "bare-phone member untouched" test contradicts 5.1's rung 2; the v1 rule was dropped when rung 2 was added but its test was carried forward. | ACCEPT - a real self-contradiction I introduced by editing around a test list instead of through it. |
| R13 (MEDIUM) | `requireComplete` on the two PREVIEW composers converts a transient throttle into a blocked operator workflow: `rosterEdits.ts:529-531` deliberately does not catch, so the operator cannot open the group at all. A preview is not once-only and can be retried by clicking again. | ACCEPT. B4's argument was specific to a once-only send behind an idempotency marker and I over-applied it. |
| R14 (MEDIUM) | S4 overturns a THIRD documented design silently: `rosterEdits.ts:437-441`, `:425-426`, `:500-506` all become wrong. | ACCEPT, including its meta-point: three instances of "inverts a commented rule without naming the comment" is a checklist item, not three one-offs. Added as a standing requirement in the spec. |
| R15 (MEDIUM) | S1 splits Today's own naming rule: `contactDisplayName` trims each part before joining, `today.ts:224-226` joins first and trims the outside, so a padded first name renders one way in Unreplied and another in Follow-ups ON THE SAME PAGE. Created by two separately-correct accepted findings interacting. | ACCEPT. Resolution: S1 uses `nameFromContact`, the file's own helper - `today.ts` holds a full `ContactItem` from its memo, so nothing forces the canonical helper here. This also shrinks the `contactName.ts` change. |
| R16 (MEDIUM) | S5 does not say which helper `maskedPartyLabel` adopts, and its output is PERSISTED as `call_party_label` (`voice.ts:993-1002`). The surface has a documented MASKED posture (`:144-146`) and a purpose-built masked helper `contactShortName` ("First L."). | ACCEPT. It adopts the MASKED helper. This is a data change, not a render change, and "all five adopt the section-3 rule" was too coarse to say so. |
| R17 (MEDIUM) | An accepted round-1 item did not land: A2's `GroupTextView.tsx:191-211` convergence outcome is still unstated. | ACCEPT. A genuine miss in my v2 edit, caught because the reviewer held its round-1 context. |
| R18 (MEDIUM) | 4.2's client list misses `dashboard/src/lib/recipientLabel.ts:101-139`, whose docblock carries the "must not be fixed in either direction" invariant - precisely the case R4's reversal changes. | ACCEPT. Not incidental; it is the same invariant as R4. |
| R19 (MEDIUM) | 4.2's writer list misses `rosterProvision.ts:106-121`, which is the EVIDENCE for S4's own cost/benefit argument. | ACCEPT. |
| R20 (LOW) | `collectRosterKeys` returning `phones` eagerly is unusable - rung-1 misses are unknown until after the batch. | ACCEPT (moot if rung 2 goes; see escalation). |
| R21 (LOW) | Two signature mismatches: `getDisplaysByIds` returns `Map<string, ContactDisplayItem>` with no `undefined` values; `findByPhone` returns `ContactItem`, not `ContactDisplayItem`. | ACCEPT. R21 also independently re-verified 5.2's widening claim as correct. |
| R22 (LOW) | 4.1 omits `measure-unread-contact-coverage.ts:545-546` as a reader, in the file S6 edits. | ACCEPT. |

## Rejected

**R11's sequencing demand, REJECTED IN PART.** "Sequence S6's group pass BEFORE
fixing the cap" is right if the cap survives, but it inverts the mission's
dependency order: S6 is a deliverable OF this branch, so gating a design
constant on it stalls the build behind its own output. If a cap survives it is
stated as PROVISIONAL with the metric that would revise it - which is R11's own
fallback and is accepted. The sequencing half is rejected.

## Deferred

1. **R7's `poolNumbersAdmin.ts:109`** - stays deferred, on the corrected basis.
2. **R9's duplicate-phone hazard as a general problem** - the arbitrary
   tiebreak at `contactsRepo.ts:1011-1016` predates this branch and is tracked
   by the M1.6 import dedupe. Not this branch's to fix; this branch's job is to
   not DEPEND on it.

---

## The escalation: this is a scope fork, not another patch

Three of round 2's findings (R1, R2, R9) and two of round 1's (B4, A11) are all
the same shape: **the outbound-message half of this bundle is materially harder
and riskier than the display half, and every patch to it has produced a new
defect.**

- B4: a throttled batch permanently shortens a delivered SMS.
- R1: the fix for B4 permanently SUPPRESSES that SMS instead.
- R2: the fix does not even cover the phone rung.
- R9: the phone rung can name the WRONG PERSON in that SMS.
- A11 (round 1, accepted): the drift these sites actually catch is NARROW,
  because `resolveMemberName` writes those rosters from the live contact on the
  add path itself.

So the half with the highest risk has the lowest measured value, and it is the
half driving the complexity in 5.1, 5.4, S4 and S5.

Meanwhile the display half - Today, inbox rows, the cards, the thread header,
`describeRoster`, and the two FREE precedence flips - is cheap, safe, needs no
phone rung, and **closes both founder-observed symptoms**.

Put to Cameron as a scope decision rather than adjudicated, per the skill's
rule that a design still changing decisions is a decision for the human. The
recommendation, and the corrected R4 reading he decided on, go to him together.
