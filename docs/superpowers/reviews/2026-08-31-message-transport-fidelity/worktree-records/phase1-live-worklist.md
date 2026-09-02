# Phase 1 live worklist - Message transport fidelity

## Live domain contracts

`app/src/repos/messagesRepo.ts:34-35`

```ts
export type MessageType = 'sms' | 'mms' | 'call' | 'email';
export type MessageDirection = 'inbound' | 'outbound';
```

`app/src/repos/messagesRepo.ts:142-149`

```ts
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}
```

The new versioned facts remain additive. `MessageType` continues to govern content,
media and non-carrier modality. `delivery_recipients` is a durable reader and writer
contract, so every field mutation and every projection is in scope.

## Mutation surfaces

| Area | Live writer / reader locations | Required version-1 treatment |
| --- | --- | --- |
| Direct, broadcast and retry | `app/src/services/sendMessage.ts:269-431`; retry re-enters through `app/src/jobs/retrySend.ts` | Adapter classifies immutable request before prepare/send. Append request and returned actual with existing content `type`; retry gets a new intent and never copies actual. |
| Inbound carrier rows | `app/src/routes/webhooks/twilio.ts:589-606,719,961-978,1035,1704,1804,2108-2125,2275` | All new carrier rows write schema version 1 and normalized actual only. No request on inbound and no inference from content or media. Native-group envelope is actual MMS. |
| Native-group outbound | `app/src/services/groupSend.ts:595-686` | Keep `type: 'sms'`; adapter-owned Group MMS intent/result produce requested and actual MMS plus planned/attempted/excluded slots. |
| Relay source append and held release | `app/src/routes/api.ts:1697-1823`; `app/src/services/relayQueuedMessages.ts:93-103` | Newly created sources/slots retain requested intent. A schema-absent source, held release, continuation and in-flight job stay on the exact legacy path. |
| Relay fanout and continuation | `app/src/jobs/relayFanOut.ts:328-598` | Branch immediately after source load. Preflight exactly the existing sender- and continuation-filtered eligible set, initialize missing slots, reconcile only never-attempted planned slots, mark attempted immediately before provider call, and update result child fields only. |
| Persisted announcement | `app/src/services/relayAnnouncements.ts:183-315` | Persisted source follows the same planned/attempted/excluded/result contract. `persist:false` remains legs-only and creates no transport fiction. |
| Status and receipt updates | `app/src/routes/webhooks/twilio.ts:2330-2520`; `app/src/services/groupReceipts.ts:371-474` | Resolve stored direct row or relay slot request before normalizing status evidence. Status and actual update independently. Group receipt may corroborate but never originate Group MMS evidence. |
| Repository operations and fakes | `app/src/repos/messagesRepo.ts:602-659,846-906,1318-1363,1900-1928,2766-2888`; `app/test/helpers/twilioWebhookHarness.ts:1337-1369` | Initial append remains atomic; later update expressions target only relevant child fields and classify conditional races. Replace whole-slot result writes so SID/time/error/status/actual never discard requested or concurrent state. |
| Non-live writers | `app/src/lib/import/apply.ts`; `app/src/lib/seed/{lean,cast,history,live,matrix,media,performance}.ts`; `app/src/lib/performanceSeed.ts`; `app/src/routes/dev.ts:817-826`; fake `engine.ts`, `signer.ts`, `types.ts`, `routes/control.ts`; `e2e/fixtures/fakeTwilio.ts` | Imports remain schema-absent absent source evidence. Seed and dev scenarios declare normalized facts explicitly. Fake status/inbound controls preserve signed end-to-end shape and never fabricate SMS/MMS `ChannelPrefix`. |

## Reader and renderer surfaces

| Area | Locations | Required treatment |
| --- | --- | --- |
| Server projections | `app/src/routes/contactTimeline.ts:151-188,397-425`; raw conversation API in `app/src/routes/api.ts` | Copy message and recipient facts presence-for-presence. No normalization or fallback. |
| Dashboard contract | `dashboard/src/api/types.ts:1614-1620,2124-2145,2310-2353` | Mirror app unions/fields. `optimistic` exists only on local `TimelineMessage`. |
| Bubble mappers | `dashboard/src/routes/contact/buildTimelineFallback.ts:64-88`; `dashboard/src/routes/conversation/useRelayThread.ts:69-125`; `useGroupThread.ts`; `useContactTimeline.ts` | Preserve all persisted facts; every carrier optimistic constructor stamps `optimistic: true`, and POST success retains it until refetch. |
| Presentation and delivery denominator | `dashboard/src/routes/contact/Timeline.tsx:778-907`; `dashboard/src/routes/contact/deliveryStatus.ts:147-260` | Replace inline `type.toUpperCase()` with one pure presenter. Share the included-recipient filter across rollup, rows, opt-out count and ticker. Hide only excluded without suppression code; retain state-absent source slots and opted-out explanation. Allow inbound relay disclosure while keeping its main chip actual-only. |
| Browser proof | `e2e/fixtures/fakeTwilio.ts:54-78,287+`; `e2e/support/selectors.md:49`; group delivery e2e anchors | Drive all provider facts through signed fake controls or explicitly gated dev fixture, then prove accessibility-first direct, relay, native-group and optimistic states on a hermetic lane. |

## Importer and opaque-reader sweep

`MessageType`, `MessageItem` and `delivery_recipients` also feed inbox, extraction,
unread, media, AI-run and group-staleness code. These consumers remain raw or
opaque; no message-shape reconstruction may omit the three message fields or the
three slot fields. The final audit greps all append, update, mapper and presenter
references before gates.

## Current-main compatibility state

`HEAD` is based at `5ce9912f`; current `main` is ahead and changes planned files:
`relayFanOut.ts`, `relayAnnouncements.ts`, `api.ts`, `contactTimeline.ts`, `dev.ts`,
`seed/lean.ts`, `seed/live.ts`, `seed/matrix.ts`, `dashboard/api/types.ts`,
`dashboard/api/types.test.ts`, and relay E2E coverage. The file paths and contracts
in the approved plan remain valid. Do not sync now: at the one allowed final sync,
merge these current-main changes with the versioned transport work and rerun every
gate on that commit.

## Rulings

- No new dependency or local-parity uncertainty exists; no spike is required.
- No product/spec/plan contradiction was found. The worklist adds current-main merge
  awareness and reader coverage, not feature scope.
- The unavailability of a third research slot was infrastructure capacity only; the
  orchestrator completed the dashboard/e2e map locally.
