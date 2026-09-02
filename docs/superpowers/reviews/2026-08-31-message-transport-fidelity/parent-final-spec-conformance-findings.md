# Parent final spec-conformance review

Date: 2026-09-01

Reviewed head: `c3aa8d05` (`feat/message-transport-fidelity`)

Scope: independent, plan-aware review of the approved transport-fidelity
contract against `main...HEAD`. This review was read-only except for this
durable findings record. It did not run a broad suite or browser test, so it
would not contend with the active final validation lane.

## Verdict

PASS - 0 P1, 0 P2, 0 P3 findings.

## Attacked surfaces and evidence

1. Provider evidence is normalized only at adapter/webhook boundaries. The
   normalizer accepts documented RCS channel evidence before SM/MM evidence,
   treats unknown or contradictory provider-shaped evidence as missing with safe
   facts, requires an E.164 inbound endpoint for SID classification, and fences
   RCS-requested SM/MM fallback behind a non-channel E.164 `From`
   (`app/src/adapters/twilioMessageTransport.ts:99`). The direct adapter passes
   only provider result facts into that normalizer (`app/src/adapters/messaging.ts:719`),
   while inbound and status webhook paths do the same after signature handling
   (`app/src/routes/webhooks/twilio.ts:1963`, `app/src/routes/webhooks/twilio.ts:2452`,
   `app/src/routes/webhooks/twilio.ts:2596`). No UI, media, or legacy `type`
   inference was found on this path.

2. Versioned persistence is additive and legacy-safe. New-message validation
   prohibits carrier transport facts without version 1 and prohibits requested
   transport on inbound rows (`app/src/repos/messagesRepo.ts:886`). Conditional
   actual writes are explicitly version-gated and preserve only the allowed
   RCS-to-SMS/MMS refinement (`app/src/repos/messagesRepo.ts:2963`,
   `app/src/repos/messagesRepo.ts:3139`). Schema-absent Relay sources branch to
   the legacy execution before any transport preflight or write
   (`app/src/jobs/relayFanOut.ts:784`), preserving queued jobs, continuations,
   and held-source behavior.

3. Requested and actual values stay independent of status transitions. The
   result updater accepts an equal queued result and can independently add SID,
   send time, actual transport, and eligible error cleanup without replacing the
   recipient object (`app/src/repos/messagesRepo.ts:3209`). The direct status
   and Relay-pointer callback routes apply actual transport independently of the
   forward-only delivery status transition and emit a refetch event for either
   move (`app/src/routes/webhooks/twilio.ts:2466`,
   `app/src/routes/webhooks/twilio.ts:2612`).

4. All current runtime writers in the approved scope were traced. Direct,
   broadcast, and retry traffic inherit adapter intent and result persistence
   through `sendMessage` (`app/src/services/sendMessage.ts:384`). Relay sources
   pre-seed requested intent and the Relay worker preflights current-roster
   versioned slots before each attempt (`app/src/jobs/relayFanOut.ts:1020`,
   `app/src/jobs/relayFanOut.ts:1264`). Persisted announcements seed and update
   the same facts (`app/src/services/relayAnnouncements.ts:215`,
   `app/src/services/relayAnnouncements.ts:390`). The native Conversations rail
   supplies Group MMS as its adapter-authoritative actual transport
   (`app/src/adapters/groupConversations.ts:806`), and the group source plus
   non-suppressed slots record that fact (`app/src/services/groupSend.ts:624`).
   The native inbound envelope records the same rail fact at the provider
   boundary (`app/src/routes/webhooks/twilio.ts:1749`).

5. The reader contract preserves the requested/actual presentation matrix. The
   presenter returns legacy uppercase `type` only when the discriminator is
   absent, returns inbound actual only or `Unknown`, hides optimistic carrier
   rows, and computes `Mixed` solely from complete attempted recipient evidence
   (`dashboard/src/lib/messageTransport.ts:38`,
   `dashboard/src/lib/messageTransport.ts:111`). Timeline delegates all chip
   copy to that module and shows recipient transport beside existing delivery
   state (`dashboard/src/routes/contact/Timeline.tsx:836`,
   `dashboard/src/routes/contact/Timeline.tsx:1094`). Projection hooks preserve
   optional fields rather than synthesizing defaults (`app/src/routes/contactTimeline.ts:423`,
   `dashboard/src/routes/conversation/useRelayThread.ts:106`).

6. Recipient exclusion is consistent across aggregate, rows, and timers. A
   removed never-attempted excluded slot is filtered, while an opted-out slot
   remains present with requested-only copy (`dashboard/src/lib/messageTransport.ts:38`).
   Timeline uses that common filtered collection for both rendering and tick
   eligibility (`dashboard/src/routes/contact/Timeline.tsx:795`,
   `dashboard/src/routes/contact/Timeline.tsx:885`).

7. Explicit fixtures and seed support were included without a migration or
   legacy reclassification. The branch adds seed transport declarations
   (`app/src/lib/seed/messageTransport.ts:1`), a controlled dev fixture path
   (`app/src/routes/dev.ts:992`), and fake-provider controls that reject
   fabricated SMS/MMS `ChannelPrefix` evidence (`e2e/fixtures/fakeTwilio.ts:39`).
   No migration or history-backfill code was introduced in the diff.

## Confirmed non-findings

- The retained `type: 'sms'` on native group persistence is not a chip source:
  versioned requested/actual Group MMS facts take precedence. This satisfies the
  approved content-modality compatibility rule.
- RCS remains a modeled request/actual value without enabling RCS sending. The
  still-unknown live fallback callback shape remains deferred by the existing
  issue rather than being fabricated in the normalizer or fake provider.
- Calls and email remain outside carrier transport fields and continue to use
  their existing labels.
