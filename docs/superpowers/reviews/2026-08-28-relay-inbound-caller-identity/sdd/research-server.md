# Phase 1 server/data worklist - relay inbound caller identity

## Scope and live-tree result

Read on 2026-08-28 against `feat/relay-inbound-caller-identity`. The approved
spec and plan match the live server topology: `/webhooks/twilio/voice` resolves
the pool-number call, then calls the existing `handleMaskedInbound`; that
handler alone derives `reason === 'non_member'`, appends the refusal row, and
returns the unchanged `Say` plus `Hangup` TwiML. No refusal recorder exists or
is needed.

The only plan corrections needed at this surface are implementation detail:

1. `voice.ts` currently imports only `formatPhoneForDisplay` from `lib/phone`.
   The implementation needs `normalizeToE164` there and `isDeleted` from
   `contactsRepo`; neither helper is otherwise locally available.
2. `api.ts` already imports `isDeleted` at line 66 and constructs the shared
   `contacts` repo at line 627. The messages-route hydration needs no new repo
   factory, dependency field, or import for deletion checking.
3. The existing fake message append and display projection are deliberately
   narrow mirrors of production. Both must gain the same new fields, including
   `deleted_at`, or the route tests would prove a fake-only contract.

## Authoritative write path

### W1. Existing route and refusal authority

- `app/src/routes/webhooks/voice.ts:443-504` validates `CallSid` and `From`,
  runs the echo guard, obtains all pool-number groups, then calls
  `resolveRelayInbound(groups, From)`.
- `voice.ts:494-499` sends `open_member`, `closed_member`, and
  `non_member_open` through exactly one call to `handleMaskedInbound`. An
  all-closed non-member intentionally falls through to founder triage and must
  not get the new relay fields.
- `voice.ts:874-939` is the only selected-group refusal writer. Its existing
  condition at line 892 derives the exact union at lines 893-899:
  `closed_thread | non_member | no_callee | no_pool_number`.
- The new lookup must sit only after that union is calculated and only when
  `reason === 'non_member'`. Do not re-run relay resolution, re-check the
  roster, or change the condition, `reason` precedence, TwiML, bridge code, or
  event behavior.
- The current append at `voice.ts:904-920` is the one to extend. It already
  writes `type: 'call'`, `direction: 'inbound'`, `author` from the existing
  roster member (therefore `unknown` for non-members), `masked: true`,
  `callStatus: 'no-answer'`, and `callOutcome: 'missed'`. It conditionally
  writes `relaySenderKey` only when `caller !== undefined`, so the non-member
  row has no sender key.
- Preserve `voice.ts:929-939`: its append failure catch logs only `err`,
  `callSid`, and `reason`, and it still replies with the existing masked
  `voice.thread_closed` Say/Hangup response. The new lookup error should use
  the same no-phone logging discipline and leave a normalized-phone/no-contact
  append attempt in place.

### W2. Contact lookup and deletion fence

- `app/src/lib/phone.ts:19-60` defines the exact helpers: `normalizeToE164` is
  pure and returns `string | undefined`; `isE164` accepts exactly a plus and
  2-15 digits with a nonzero first digit.
- `contactsRepo.findByPhone` at `app/src/repos/contactsRepo.ts:1009-1035` is
  pointer-aware but intentionally returns a soft-deleted owner too. It is not
  itself a deletion fence.
- `isDeleted` at `contactsRepo.ts:308-310` is the canonical non-empty
  `deleted_at` test. The write path must apply it before storing the contact
  ID. A deleted match stores neither an ID nor a name, while retaining the
  normalized phone.
- Required imports in `voice.ts`: extend line 46 to include
  `normalizeToE164`; extend lines 57-60 to include `isDeleted`.
- Best-effort sequence: initialize no identity facts; normalize `From`; when a
  normalized phone exists, `try await contacts.findByPhone(phone)`; retain the
  contact ID only if the result exists and `!isDeleted(result)`; on error log
  no raw phone and retain phone only. The append still supplies the refusal
  reason when `From` is withheld/malformed.

### W3. Message persistence contract and all mutation surfaces

- `NewMessage` is at `app/src/repos/messagesRepo.ts:601-815`; its current
  voice-only section is `694-718`.
- `MessageItem` is at `messagesRepo.ts:817-1000`; its current persisted
  voice-only section is `897-913`.
- Add exactly these optional `NewMessage` fields beside the voice properties:
  `relayRefusalReason?: 'non_member'`,
  `relayExternalCallerPhone?: string`, and
  `relayExternalCallerContactId?: string`.
- Add exactly these optional `MessageItem` attributes beside the persisted
  voice properties:
  `relay_refusal_reason?: 'non_member'`,
  `relay_external_caller_phone?: string`, and
  `relay_external_caller_contact_id?: string`.
- `createMessagesRepo(...).append` at `messagesRepo.ts:1865-1944` is the only
  generic durable writer for typed call messages. Add its storage-shape guard
  immediately before building `item`, then map the three camel-case values to
  the snake-case item attributes near the other voice fields.
- A guard must treat any one of the three new input properties as feature
  usage and reject unless all of these facts are true: `type === 'call'`,
  `direction === 'inbound'`, `masked === true`, `author === 'unknown'`,
  `relaySenderKey === undefined`, and `relayRefusalReason === 'non_member'`.
  Reject a supplied phone unless `isE164(phone)` and reject a supplied contact
  ID when no phone is supplied. This is storage-shape validation only; do not
  read conversations, load a roster, derive a refusal reason, or make routing
  decisions in the repo.
- `messagesRepo.ts:694-699`, `715-718`, and `897-913` have broad comments that
  say a masked counterpart phone is never stored. Narrow their wording rather
  than weakening the existing protections for `call_party_label`, sender keys,
  recordings, or transcripts; the explicit normalized external-caller field is
  the approved staff-only exception.
- The append's CallSid pointer transaction at `messagesRepo.ts:1945-1965` is
  unchanged. It keeps the first successful append immutable across webhook
  redelivery; do not add update/enrichment behavior.
- Relevant reads that must remain behaviorally neutral:
  `getByProviderSid` (`messagesRepo.ts:1689-1699`),
  `listByConversation` (`2677-2693`),
  `getByTsMsgId` (`2695-2699`), and status/recording/transcript update methods
  in the same repo. Only `append` maps these fields; no lifecycle updater should
  write them.

## Authenticated read and non-participant disclosure boundary

### R1. Messages page hydration

- `app/src/routes/api.ts:2112-2132` is the authenticated newest-first messages
  API. Today it returns the `listByConversation` rows verbatim.
- `api.ts:66` already imports `isDeleted`; `api.ts:627` has the shared
  `contacts` instance. After the page read at lines 2127-2130, collect unique,
  non-empty `relay_external_caller_contact_id` strings, perform exactly one
  `contacts.getDisplaysByIds(ids)` read when the set is non-empty, and map into
  new response objects rather than mutating the repo-owned page items.
- The hydration has to catch a thrown batch read, warn only with operational
  identifiers/count, and send the full unhydrated `200` page. `getDisplaysByIds`
  itself is normally best-effort/short-map, but a fake or future implementation
  can reject.
- Ignore missing rows and rows where `isDeleted(display)` is true. Derive the
  response-only `relay_external_caller_display_name` from trimmed, non-empty
  `firstName`/`lastName`; do not phone-match on read. The stored ID supports
  current renames/restores; phone is the fallback only at the dashboard.
- `GET /api/calls/:callId` at `api.ts:2134-2158` deliberately returns the raw
  authenticated call. It is staff-only; retain that behavior and update the
  stale comment at `2138-2140` so it does not falsely claim every call has no
  raw phone. It is not the messages-page hydration endpoint.

### R2. Display projection

- `ContactDisplayItem` is at `app/src/repos/contactsRepo.ts:296-301`; add
  `deleted_at?: string` there.
- `DISPLAY_PROJECTION` at `contactsRepo.ts:854-863` is shared by both display
  APIs. Extend its `ProjectionExpression` and `ExpressionAttributeNames` with
  `#deletedAt: 'deleted_at'`. Do not widen it to whole contacts.
- `getDisplayById` at `1068-1073` and `getDisplaysByIds` at `1075-1077` both
  reuse that object, so the one extension covers all live display readers.
- `batchGetByIds` at `809-851` already de-duplicates and safely returns an
  empty map for an empty input. The route must still skip calling it for an
  empty feature-ID set, because call-count/no-read is part of the contract.

### R3. Other MessageItem readers are safe by explicit projection

- `app/src/routes/contactTimeline.ts:1046-1093` excludes `relay_group`
  conversations before listing messages. Its `toTimelineCall` mapper at
  `566-618` explicitly projects only known call fields and therefore does not
  disclose the new raw fields to that contact timeline.
- Jobs such as extraction, relay fan-out, receipts, and voice transcript read
  `MessageItem` but only use their existing explicit fields. No new field is a
  job input or event payload.
- The old participant-facing protection therefore remains: the refusal TwiML
  at `voice.ts:935-938` is unchanged, the no-bridge path has no `<Dial>`, and
  the contact timeline cannot inline relay-group call records.

## Required parallel fakes and focused tests

### T1. Repo storage guard

- `app/test/repos.test.ts:77-180` is the existing focused fake-document-client
  append suite. Extend it with an inspecting `TransactWriteCommand` fake to
  prove a valid non-member shape persists all three snake-case attributes and
  rejected shapes issue no Dynamo transaction.
- Minimum rejected cases: a phone without the reason; reason on an outbound,
  unmasked, non-call, known-author, or sender-key row; malformed phone; and
  contact ID without phone. Retain the existing dedupe tests.

### T2. Real signed refusal behavior

- `app/test/voiceWebhook.test.ts:292-317` already drives the real signed
  removed-member refusal. Extend this case to prove `<Dial>` is absent, existing
  TwiML contains no caller number, persisted reason is exactly `non_member`,
  normalized phone is stored, `relay_sender_key` and external contact ID are
  absent for an unmatched caller, and redelivery does not overwrite the first
  facts.
- Add focused cases in the same describe for matched non-deleted contact,
  deleted contact (phone retained/no ID), malformed or withheld-style From
  (reason only/no stored phone), and a forced `findByPhone` rejection (phone
  retained/no ID and TwiML still succeeds). Assert closed-thread, no-callee,
  and no-pool-number refusal rows do not gain any of the new fields.
- The shared fake implementation at
  `app/test/helpers/twilioWebhookHarness.ts:1054-1130` mirrors the real
  `MessagesRepo.append`. Add the three mappings at the corresponding voice
  section or every webhook/API test will write rows that production would not.

### T3. Display projection and API cases

- `app/test/contactsRepo.integration.test.ts:94-117` is the existing real
  DynamoDB display-projection test. Extend it to soft-delete a contact and
  assert both `getDisplayById` and `getDisplaysByIds` include `deleted_at`,
  without returning unrelated fields.
- The harness display fake is deliberately strict at
  `app/test/helpers/twilioWebhookHarness.ts:1642-1655`; add only a non-empty
  `deleted_at` property to `projectDisplay`. Both fake display methods at
  `1681-1691` then stay parallel with the real projection.
- `app/test/conversationHubApi.test.ts:255-294` is the messages-page describe.
  Add page-local cases with `vi.spyOn(world.contactsRepo, 'getDisplaysByIds')`:
  one de-duplicated batched lookup and trimmed current name; zero IDs means no
  call; missing display means no display-name property; a soft-deleted display
  is ignored and restoration returns the name on the next request; rejection
  still returns full `200` page; and `world.messages` remains unmodified.
- The harness supports soft delete/restore at
  `twilioWebhookHarness.ts:1791-1798`, so use that rather than hand-editing a
  shape if the test needs lifecycle realism.

## Live-tree drift / implementation cautions

- There is no current append validation helper in `messagesRepo.ts`; the new
  guard is a new small local function/branch, not an extension point to search
  for.
- `findByPhone` only accepts normalized keys in production. Normalize before
  calling it. `From` remains deliberately used raw by the existing relay
  resolution and must not be normalized there in this mission.
- `api.ts` uses the same `contacts` object as its other staff routes. Do not
  construct a second repo, or injected route fakes will silently stop working.
- Do not change the status callback: the refusal row remains stored as
  `call_status: 'no-answer'` / `call_outcome: 'missed'`; only the new explicit
  reason enables the dashboard to present `Not connected`.
