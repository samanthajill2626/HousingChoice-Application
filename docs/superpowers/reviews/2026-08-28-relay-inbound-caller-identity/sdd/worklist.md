# Live-tree worklist: relay inbound caller identity

Generated from the approved spec and plan plus direct repository inspection on
2026-08-28. Anchors are against feat/relay-inbound-caller-identity at e6c92101.

## Routing and persistence authority

1. app/src/routes/webhooks/voice.ts:479-504 is the pool-number inbound entry.
   It obtains groups by unchanged raw To, calls resolveRelayInbound(groups, From),
   and gives the selected group to handleMaskedInbound. Do not change resolver
   selection, all-closed non-member fallthrough, or From-comparison semantics.
2. voice.ts:874-939 is the sole selected-group refusal writer. Its existing
   reason union is closed_thread | non_member | no_callee | no_pool_number.
   Add identity facts only after that union and only for reason === non_member.
   Do not alter the condition, precedence, append catch/event, Say/Hangup response,
   or no-Dial behavior.
3. voice.ts:904-920 already makes non-members author unknown with no relay sender
   key. It must add only optional external identity facts. The member bridge at
   voice.ts:952-1030 must remain byte-for-byte behaviorally unchanged.
4. Extend voice imports: normalizeToE164 beside formatPhoneForDisplay at line 46,
   and canonical isDeleted beside ContactsRepo at lines 57-60. findByPhone at
   app/src/repos/contactsRepo.ts:1009-1035 can return deleted contacts, so
   retain a contact ID only after !isDeleted(matched). A lookup failure logs no
   phone/input/error and still appends phone-only facts.

## Durable shape: every writer and reader

1. app/src/repos/messagesRepo.ts NewMessage at 601-815 receives exactly:
   relayRefusalReason?: 'non_member';
   relayExternalCallerPhone?: string;
   relayExternalCallerContactId?: string;
2. MessageItem at 817-1000 receives exactly:
   relay_refusal_reason?: 'non_member';
   relay_external_caller_phone?: string;
   relay_external_caller_contact_id?: string;
3. createMessagesRepo append at 1865-1944 is the only typed durable writer.
   Before key/item construction, any supplied new field must require type call,
   direction inbound, masked true, reason non_member, author unknown, and absent
   relaySenderKey. A supplied phone must pass isE164; a supplied contact ID
   requires a phone. This guard must not load a conversation, inspect roster,
   derive a reason, or decide routing.
4. Map only supplied camel-case fields beside voice mapping at 1906-1919. The
   CallSid pointer transaction at 1945-1965 remains the immutable first-append
   boundary; no lifecycle/status updater writes these fields.
5. Narrow raw-counterpart comments at 694-699 and 897-913 without weakening
   protections for call_party_label, roster keys, recordings, transcripts,
   or participant surfaces. The explicit normalized external phone is a staff-only
   exception.
6. app/test/helpers/twilioWebhookHarness.ts:1054-1130 is the strict append fake
   and must copy the same three fields. Existing getByProviderSid, listByConversation,
   getByTsMsgId, status, recording, and transcript methods remain neutral.
7. Other readers that remain neutral: extraction/fan-out/receipt jobs and
   app/src/routes/contactTimeline.ts, which excludes relay groups and explicitly
   projects known call fields.

## Authenticated read and deletion fence

1. ContactDisplayItem at app/src/repos/contactsRepo.ts:296-301 gains deleted_at?:
   string. Its one shared projection at 854-863 adds only deleted_at; getDisplayById
   and getDisplaysByIds then inherit it. Do not widen this display read.
2. app/src/routes/api.ts:2112-2132 is the authenticated message page. api.ts
   already has canonical isDeleted (line 66) and the injected shared contacts repo
   (line 627). From just the current page, collect unique non-empty external
   contact IDs, call getDisplaysByIds once only if non-empty, and map copies.
3. Hydrate only a current non-deleted display with a trimmed first/last name into
   response-only relay_external_caller_display_name. No read-time phone lookup.
   On batch failure, log conversationId plus count only and send the complete
   unhydrated HTTP 200 page. Missing/unprocessed/deleted displays omit the name.
4. api.ts:2134-2158 remains the authenticated raw call endpoint. Update its
   stale no-raw-phone comment; do not add name hydration.
5. harness projectDisplay at app/test/helpers/twilioWebhookHarness.ts:1642-1655
   copies only a non-empty deleted_at as well, keeping both fake display methods
   at 1681-1691 parallel with production.

## Dashboard contract: every reader and renderer

1. The only staff chain is dashboard/src/api/types.ts:2102-2163 Message ->
   dashboard/src/routes/conversation/useRelayThread.ts:66-116 toTimelineMessage ->
   dashboard/src/api/types.ts:2338-2371 TimelineCall ->
   dashboard/src/routes/contact/Timeline.tsx:1195-1315 CallCard.
   Both types receive persisted fields and response-only display name. Mapper
   forwards refusal reason only when exactly non_member and other fields only
   when strings, retaining its no provider/media/recording/transcript policy.
2. Create pure dashboard/src/routes/contact/presentRelayExternalCaller.ts.
   It returns undefined except exact non_member. Its precedence: trimmed hydrated
   name only with stored contact ID, then formatted stored E.164, then exact
   An unknown caller tried to call this relay number with Caller ID unavailable.
   It never reads roster or phone-matches.
3. Timeline.tsx:1161-1193 relayCallSummary stays member fallback. New presenter
   must win in CallCard so a current roster phone match never becomes A called B.
4. presentCallState.ts:42-185 gains relayRefusalReason?: 'non_member' and an
   initial exact-non_member clause returning Not connected, danger. All absent
   reason inputs retain current matrix behavior.
5. format.ts:13-53 gains formatDateTimeWithSeconds beside compact
   formatTimeWithSeconds. It normalizes isoOf, renders local en-US full date/time
   with seconds, and returns Time unavailable for invalid input. Do not alter
   compact formatter invalid => empty contract, which guards accessible-name
   collisions.
6. External CallCard always shows Details, approved summary/chip/minute time, and
   phone label, participant explanation, View contact or No linked contact, and
   full time. Existing cardMeta/cardRevealed CSS at Timeline.module.css:492-505
   suffices unless visual QA proves row spacing needs a change. Other call detail,
   recording, transcript, and duration conditions stay unchanged.
7. Accessibility: role group card name remains summary plus seconds/ID fallback
   at Timeline.tsx:1249-1287. Details for <cardName> stays unique with
   aria-expanded at 1299-1312; decorative arrow is aria-hidden.

## Test map

1. app/test/repos.test.ts:77-180: full and reason-only valid storage mapping,
   no feature fields on ordinary call/SMS, and every illegal shape rejects before
   document send.
2. app/test/voiceWebhook.test.ts current refusal block: matched/unmatched/deleted/
   anonymous/lookup-failure/redelivery, untouched other refusal reasons, no Dial/
   phone leak, and no contact/roster mutation.
3. app/test/contactsRepo.integration.test.ts:94-117: deletion projection. app/test/
   conversationHubApi.test.ts:255-294: one deduped batch, zero-ID no read, missing/
   deleted/restored displays, batch failure returns unhydrated 200, no mutation.
4. Dashboard: extend mapper test at useRelayThread.test.tsx:56-90; create pure
   identity presenter test; extend state/format tests; extend Timeline.test.tsx:
   1919-2238 with name, phone, unknown, stale-ID, roster collision, card-specific
   accessibility, and ordinary/member regressions. Vitest does not apply CSS, so
   collapse/reveal proof is aria-expanded plus cardRevealed, not visibility.
5. New e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts uses
   createGroupOpen (relayConnect.ts:158-185), placeCall/listCalls
   (fakeVoice.ts:34-49), and legPhones (voiceSetup.ts:98-102). Lean-reseed/login,
   third external E.164 to real pool, zero legs, API polling, region-scoped card
   and details, no-contact query, shared formatter import, and lean restore.

## Research result

No dependency, infrastructure, migration, backfill, or local-parity spike is required.
The only plan-detail correction is that voice.ts imports normalizeToE164 and isDeleted;
api.ts already owns the shared contacts repo and deletion helper.
