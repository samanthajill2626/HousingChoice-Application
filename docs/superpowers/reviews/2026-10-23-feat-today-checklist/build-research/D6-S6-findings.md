D6 checked plan section 10 (S6, lines 18867-21171) against plan sections 0-4 (PR38, PR70-PR72, PR93, PR105), spec r8 7.2/7.3/7.5 and the live tree @970a29b9. I walked every backfill filter against the code that writes each row: sendMessage.ts + messagesRepo.ts append, retrySend.ts, the api.ts Retry route and relay team send, lib/import/apply.ts, sendEmailMessage.ts + recordProviderSidAlias + emailEvents.ts, originateCall.ts + voice.ts whisper-gate and /status, relayFanOut.ts (slot record, persistRelayRecipientResult, intro and member-added jobs), relayRetryLeg.ts, the twilio.ts relay retry append and receipt writes, sendReconcile.ts (adoptRelay, adoptRetry), groupSend.ts, relayAnnouncements.ts, tourReminders.ts, placementNudges.ts, tourRemindersRepo.ts, messages/catalog.ts + resolve.ts, heardFrom.ts, stageClient.ts (lane key and region), the twin script and its test. I also traced all 31 test cases (25 planner, 6 runner) through the plan's code by hand, and checked the two Edit anchors, the RUNBOOK anchor (line 553), typecheck coverage (app/tsconfig.scripts.json and tsconfig.test.json), the vitest default include, eslint.config.mjs, and the ASCII of the slice. Every case comes out green as written. No filter lets a real row through or catches the wrong row. The --lane path uses the hclane<L> key, region us-east-1, and the hc-local-<L>- prefix. Two recording-accuracy items follow.

## D6-1 - MINOR - the recipient divergence from live stamps is recorded for email and call only, but texts, group texts and calls diverge the same way

Plan location: section 10, "Contradictions" C2 (line 18913); PR71 (line 642); Task S6.4 Step 5, the C2 bullet (line 21095).

What the plan says: C2/PR71 frames the divergence as email/call rows with no recipient_contact_id, so the backfill names "the thread's contact". It says the two agree "except on a thread whose participant is a different contact than the one addressed (a shared address)". The "Checked" list says the live writers' instants match. It says nothing about whether the recipients match for texts, group texts or calls.

What the tree holds:
- PR38's recipient order is roster/participants contactId first, then findByPhone (plan planOneToOneRow via attributeInbound, heardFrom.ts:94-104; plan planGroupTextSlots, roster first).
- The live writers judge the phone's CURRENT holder instead:
  - W1: `contact = heldRecipient ?? phoneContact`, where phoneContact = findByPhone(participant_phone) (sendMessage.ts:493, :511).
  - W5: `resolved` = findByPhone(member.phone) per member (groupSend.ts:322-324).
  - W6: resolveOutboundTarget = findByPhone(participant_phone) (voice.ts:1315).
- A 1:1 thread's participants are written once (setParticipantsIfAbsent, conversationsRepo.ts:1711) and never refreshed. So when a number is later held by a different contact (duplicate contacts on one phone, or a phone edit), the backfill stamps the stale participant. The live send stamps the current holder.
- This is rare, and the order is binding (PR38). No code change is needed.

Correction (worklist text): "S6.4 Step 5, C2 bullet. Extend it to: the backfill names the thread's write-once participants contactId first (heardFrom.ts:94-104). The live writers judge the phone's current holder: W1 sendMessage.ts:493/:511, W5 groupSend.ts:322-324, W6 voice.ts:1315. So staff texts with no recipient_contact_id, group-text members and calls can be stamped on a different contact than live when participants are stale. The 'shared address' case covers email only. Accepted approximation (PR38 order); record it, no code change."

## D6-2 - MINOR - the answered_at citation for outbound calls in the "Checked" list points at the inbound accept branch

Plan location: section 10, "Checked, NOT contradictions", last bullet (lines 18964-18969). S6.4 Step 5 (line 21103) copies that list "with its file:line evidence" into the committed S6 report.

What the plan says: "W6 the press-1 instant, which is answered_at (routes/webhooks/voice.ts:1676, :1747)".

What the tree holds:
- voice.ts:1747 is the `digits === '1'` NON-outbound branch, the founder/callee accept for inbound and masked bridges. It never writes an outbound call row.
- An outbound call row gets answered_at in two places:
  - voice.ts:1676, the outbound press-1 accept, just before the <Dial>.
  - voice.ts:1961, the /status Dial in-progress summary (`stampAnsweredAt`, :1904). This is the fallback when the best-effort press-1 write failed, and its instant is the bridge-connect time, not the press-1 instant.
- The backfill's rule (answered_at when present) is unaffected.

Correction (worklist text): "In the S6 report's checked list, cite voice.ts:1676 (outbound press-1) and voice.ts:1961 (the Dial in-progress summary fallback, a later instant) as the outbound answered_at writers. Drop :1747 (inbound accept)."
