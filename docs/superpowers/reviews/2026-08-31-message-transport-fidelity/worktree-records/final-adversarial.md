# Final adversarial review - message transport fidelity

Reviewer: plan-blind adversarial pass. Scope was the final diff package and live code/tests only; no feature spec, plan, worklist, or prior review report was read. No test suite was launched.

## Verdict

PASS - no confirmed must-fix findings.

## Evidence sweep

- Normalization and evidence conflict handling: `app/src/adapters/twilioMessageTransport.ts:99-171` accepts only authenticated, provider-shaped evidence; it leaves unknown/contradictory evidence non-authoritative and logs safe facts. The inbound and status routes use this normalizer after Twilio signature verification at `app/src/routes/webhooks/twilio.ts:1951-1977` and `app/src/routes/webhooks/twilio.ts:2425-2465` / `2595-2621`.
- Actual-transport persistence is monotonic for the relevant fallback ordering. `app/src/lib/messageTransport.ts:24-45` permits RCS to become its carrier fallback, rejects contradictory stable facts, and recognizes a late RCS callback as stale. The DynamoDB conditions match that rule at `app/src/repos/messagesRepo.ts:2963-3023` and `3139-3206`; the race probe in `app/test/messagesRepo.transport.test.ts:212-229` exercises concurrent RCS/SMS recipient observations and leaves SMS durable.
- The relay send/callback interleaving does not overwrite transport facts. The send-side child-field conditional patch is at `app/src/repos/messagesRepo.ts:3209-3348`, the callback writes recipient actual transport at `app/src/routes/webhooks/twilio.ts:2442-2482`, and a late send-side patch preserves an already-won status/actual field. The existing lookup retry explicitly covers the pointer-after-send race at `app/src/routes/webhooks/twilio.ts:2531-2557`.
- Native-group receipts copy the source row's rail-authoritative actual transport only into the matching member slot, rather than treating a receipt channel SID as a replacement authority: `app/src/services/groupReceipts.ts:394-443`. The following status update changes child fields rather than replacing the whole slot at `app/src/repos/messagesRepo.ts:3374-3447`, so the just-written actual transport survives a concurrent receipt/status update.
- Projection and presentation retain the version gate. App API projection is explicit at `app/src/routes/contactTimeline.ts:404-462`; the conversation hooks carry the same fields (`dashboard/src/routes/conversation/useRelayThread.ts:111-125` and `dashboard/src/routes/conversation/useGroupThread.ts:187`); and the dashboard shows versioned inbound/outbound and per-recipient facts without changing legacy labels at `dashboard/src/lib/messageTransport.ts:59-131` and `dashboard/src/routes/contact/Timeline.tsx:835-851`, `1094-1123`.
- Mutation-surface sweep covered direct send (`app/src/services/sendMessage.ts:418-420`), group send (`app/src/services/groupSend.ts:624-677`), relay announcements (`app/src/services/relayAnnouncements.ts:221-238`, `348-349`), relay fan-out (`app/src/jobs/relayFanOut.ts:1031-1047`, `1185-1202`, `1256-1321`), all inbound filing branches (`app/src/routes/webhooks/twilio.ts:588-650`, `971-1029`, `1749-1762`, `2193-2218`), and dev/seed-only fixture validation (`app/src/routes/dev.ts:870-1054`, `app/src/lib/seed/messageTransport.ts`). No alternative writer or reader bypassing the schema-version and field-projection contracts was found.

## Adversarial checks considered

- Security: the newly consumed webhook evidence remains behind `verifySignature`; conflict logging carries IDs/safe schemes, not message bodies. Dev fixture transport input remains within the structural dev-only route.
- Concurrency: examined direct send/append callback outrun, relay pointer-after-send outrun, concurrent RCS-to-carrier observation, and group receipt/status ordering. The conditional writes and established retry/parking paths preserve the durable winner rather than reverting it.
- Unintended UI effects: versionless rows continue to render their original `SMS`/`MMS` type labels, while optimistic carrier rows remain label-free until a persisted result arrives. Recipient aggregates exclude intentionally excluded recipients and only declare a uniform actual rail after every attempted member has one.

No findings were filed.
