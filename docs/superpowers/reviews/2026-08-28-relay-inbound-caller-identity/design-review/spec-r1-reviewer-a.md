# Adversarial review: Relay inbound non-member caller identity

## 1. [HIGH] The `non_member`-only storage rule has no enforcement boundary

### What is wrong

The spec calls this a load-bearing invariant: external caller phone/contact facts are allowed only with `relay_refusal_reason: 'non_member'` (I3; section 5, lines 266-274). Its stated mechanism, however, is only that the one refusal handler will write them correctly. That is not an invariant. `NewMessage` is the generic write contract for every caller of `messages.append`; the proposed shape makes `relayRefusalReason`, `relayExternalCallerPhone`, and `relayExternalCallerContactId` three independent optional properties. The repository's existing append mapper accepts arbitrary optional fields from that generic object and writes them directly to the flexible message item (the established pattern is visible at `app/src/repos/messagesRepo.ts:1865-1905`). There is no proposed discriminated write type, runtime validation in `messages.append`, or dedicated non-member-refusal append primitive to reject a `closed_thread`/`no_callee`/ordinary call carrying one of the new fields.

### Evidence

- Spec I3 prohibits putting an external identity into the roster identity and section 5 says the external fields are allowed only for `non_member`: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:179-184,266-274`.
- `NewMessage` is exported as the broad append input, not a voice-refusal-only type: `app/src/repos/messagesRepo.ts:601-718`.
- `messages.append` constructs a stored item by conditionally copying each supplied generic write field; it is the sole durable write funnel and currently has no cross-field validation: `app/src/repos/messagesRepo.ts:1865-1905`.
- The current handler's four reasons are merely local control flow, including `closed_thread`, `non_member`, `no_callee`, and `no_pool_number`: `app/src/routes/webhooks/voice.ts:887-920`.

### What it implies

An innocuous later caller or a maintenance path can attach the number/contact ID to a different masked call while typechecking and while all tests described in section 10 still pass. That breaks the promised privacy boundary and makes the card's interpretation dependent on an undocumented writer convention. The design must make illegal states unrepresentable at the append boundary (or reject them there), and test the rejected/omitted combinations, before implementation begins.

## 2. [HIGH] The required fallback turns an optional name read into a timeline-breaking dependency

### What is wrong

Sections 2, 4/I6, and 7 require a stored-phone/unknown fallback when display hydration is missing or unprocessed. They do not specify failure handling for the batch display read. The proposed `GET /api/conversations/:conversationId/messages` change puts `contacts.getDisplaysByIds` in the core transcript request. In current code that endpoint simply awaits `messages.listByConversation` and sends the response; there is no local error isolation. `getDisplaysByIds` is a DynamoDB BatchGet operation. It may return a partial map after retries, but a failed request still rejects. Under the specified mechanism, a contacts-table read outage makes the entire authenticated relay transcript 500 instead of returning the persisted phone and `No linked contact`.

### Evidence

- The spec promises page-bounded ID hydration and degradation for missing/unprocessed display rows: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:200-205,309-323`.
- The live endpoint has no hydration/error boundary today; the awaited list call is followed immediately by `res.json`: `app/src/routes/api.ts:2112-2132`.
- The repo contract exposes `getDisplaysByIds` as a normal Promise with no best-effort/fallback option: `app/src/repos/contactsRepo.ts:589-603`.
- Its shared BatchGet helper explicitly throws when the DynamoDB request itself fails, while partial/unprocessed results are a separate path: `app/src/repos/contactsRepo.ts:846-851,1075-1077`.

### What it implies

The new privacy metadata can make the main staff relay view unavailable during an unrelated contact-read incident. The spec must require catching/logging this optional hydration failure and returning unhydrated stored rows (or introduce an explicitly best-effort repository API); the implementation tests must cover a rejected batch read, not only a short map.

## 3. [HIGH] The deletion semantics for a stored contact ID are contradictory and the proposed projection cannot implement either safe choice

### What is wrong

The write rule says match only a non-deleted contact (D5), while the read rule says a stored ID is hydrated to the current display name and gets `View contact` whenever it resolves (D4/D6). It never says whether a contact deleted after the call is still eligible for name/link disclosure. That is not an academic ambiguity: the current display batch projection deliberately omits `deleted_at`, and it returns a display for soft-deleted contacts. Therefore the specified `getDisplaysByIds` mechanism cannot distinguish a currently active contact from one deliberately removed from normal staff views. A builder following it will expose the deleted contact's current name/link; a builder trying to honor the normal deletion fence has no field to do so.

### Evidence

- The spec requires a non-deleted contact at arrival, then says current read hydration uses only the stored ID and adds `View contact` when it resolves: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:108-132,94-103,314-319`.
- Soft deletion is a durable `deleted_at` fence: `app/src/repos/contactsRepo.ts:304-309`; normal staff lists explicitly hide such contacts: `app/src/repos/contactsRepo.ts:1094-1100`.
- The exact display projection contains only ID, names, and phone, not `deleted_at`: `app/src/repos/contactsRepo.ts:854-863`; `getDisplaysByIds` uses that projection unchanged: `app/src/repos/contactsRepo.ts:1075-1077`.
- The direct contact route describes deletion as hiding the record from contact lists, Inbox, Today, and broadcasts while retaining the data: `app/src/routes/contacts.ts:2055-2059`.

### What it implies

This feature either silently resurrects a deleted person's identity in a new staff surface or silently gives different semantics to deletion without an approved decision. The design must state the post-arrival delete/restore behavior and alter the projection/response policy accordingly; verification needs delete-after-call and restore-after-call cases. Until then the `View contact` contract cannot be implemented consistently.

## 4. [MEDIUM] The proposed exact-time detail is underspecified against the existing formatter and gives builders two incompatible renderings

### What is wrong

D4 requires the expanded Details area to show the full local date and time including seconds. Section 8.3 instead refers to the existing seconds-precision timestamp, which is currently used only for an accessible name. The live `formatTimeWithSeconds` call is not an expanded human-facing full date/time formatter, and the spec neither names a new formatter nor specifies invalid-timestamp behavior for the visible Details value. A builder can satisfy the existing implementation reference with time-only text and still fail D4.

### Evidence

- D4 requires the full local date and time with seconds: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:94-103`.
- Section 8.3 names only the existing seconds-precision timestamp for the card accessible name: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:369-372`.
- The live card uses `formatTimeWithSeconds` solely in `cardName`; face time uses `formatTime`: `dashboard/src/routes/contact/Timeline.tsx:1249-1263`.

### What it implies

The contractual visible detail is not precise enough to build or test consistently. Specify a named full-date-and-seconds formatter (including the unparseable-`at` fallback) and make the E2E/unit assertions prove the visible expanded value, not merely the control's accessible name.
