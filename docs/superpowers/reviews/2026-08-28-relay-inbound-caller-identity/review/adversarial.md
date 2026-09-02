# Adversarial review - relay inbound caller identity

Reviewed commit range `70705b1c45fdf7b8550775293f3d38516b1ad57f..1065acce7eee7d8340df0ed84700d854e4a3b9a2` plan-blind. Product files were not edited.

## Findings

### MUST-FIX - a real matched contact without a name is rendered as "No linked contact"

- **Evidence:** [`app/src/routes/contacts.ts:731-767`](../../../AI%20Projects/Housing%20Choice/HC%20Application/app/src/routes/contacts.ts) makes both name components optional for a normal manual contact. The newly added API hydration computes a name only from non-empty `firstName`/`lastName` at `app/src/routes/api.ts:2147-2156`. When neither exists, it deliberately returns the stored `relay_external_caller_contact_id` but no `relay_external_caller_display_name`. The new presenter only supplies `linkedContactId` when *both* are present (`dashboard/src/routes/contact/presentRelayExternalCaller.ts:17-27`), and the card then emits `No linked contact` at `dashboard/src/routes/contact/Timeline.tsx:1324-1329`.
- **Reproduction:** create an active contact with `type` and a valid phone but no `firstName`/`lastName` (accepted by the cited create parser); call an open relay number from that phone while the contact is not a relay participant. The webhook stores that contact ID (`app/src/routes/webhooks/voice.ts:906-943`). `GET /api/conversations/:id/messages` has the ID but no hydrated name; the timeline takes the phone fallback and falsely says `No linked contact`, with no `View contact` control.
- **Required regression:** route + Timeline/presenter coverage for an active matched phone-only contact. It must retain truthful phone fallback *and* expose a valid contact link (while preserving the existing deleted/missing-contact no-link behavior). This requires an explicit current-linkability contract or an API projection that lets the client distinguish an active nameless contact from deleted/missing; tying linkability to name is not sufficient.

## Attacked but not broken

- **Write invariant / alternate writers:** the only new writer is the inbound masked-refusal arm. `assertRelayExternalCallerShape` (`app/src/repos/messagesRepo.ts:826-844`) rejects non-call, outbound, unmasked, non-unknown, sender-keyed, malformed-phone, and contact-ID-without-phone shapes before the DynamoDB transaction. Other append callers cannot attach the facts without satisfying that guard.
- **Other inbound voice branches:** founder triage, all-closed non-member fallthrough, closed-thread, no-callee, and missing-pool branches do not meet `reason === 'non_member'`; no changed routing, TwiML, dial, contact-capture, or push path was found. The post-write path emits only existing IDs/timestamps (`app/src/routes/webhooks/voice.ts:893-963`).
- **Redelivery/concurrency:** a retry may repeat the best-effort contact read, but `messages.append` retains its CallSid conditional dedupe. No new mutation occurs after the lookup, so a later contact change cannot rewrite a persisted refusal row.
- **Reader/persistence boundaries:** the raw number is emitted only by existing `/api` endpoints protected by `requireAuth` (`app/src/app.ts:223-224`); the public/webhook routes do not expose it. The relay mapper still drops provider IDs, recordings, transcripts, and media (`dashboard/src/routes/conversation/useRelayThread.ts:66-99`).
- **Deleted contact behavior:** the read path projects `deleted_at` and suppresses display-name hydration; because the presenter requires a display name to create a link, the existing deleted-contact no-link behavior is preserved.
- **Cross-consumer impact of the expanded display projection:** existing `getDisplaysByIds` consumers receive only an additional optional attribute and retain their previous first/last/phone treatment. No consumer was found that serializes all projection fields into an external/public response.

## Review scope and proof notes

Read the complete diff package and swept repository readers/writers of the new fields, the shared contact display projection, `findByPhone`, inbound voice routing, the messages API, `GET /api/calls/:callId`, relay timeline mapping, and call-card rendering. The concrete reproduction above is derived from the live create parser and the exact post-webhook/read/render dataflow; no product or test files were modified by this review.
