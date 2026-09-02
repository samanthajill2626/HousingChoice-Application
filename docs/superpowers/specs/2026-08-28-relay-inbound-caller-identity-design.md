<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-01).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). The mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-28-relay-inbound-caller-identity/`.

# Relay inbound non-member caller identity - design spec

Date: 2026-08-28
Branch: `feat/relay-inbound-caller-identity`
Worktree: `W:\tmp\relay-inbound-caller-identity`
Base: `main` @ `70705b1c`
Status: adversarial review complete; awaiting human spec approval

## 1. Problem

When a person calls a Twilio-owned relay number, Twilio sends HousingChoice an
inbound voice webhook containing the call facts. HousingChoice then decides
whether to create an outbound participant leg. The caller is inbound; Twilio is
not calling the relay number.

For a current relay participant, the open-group path identifies the caller,
bridges to the other participant or participants, and stores enough identity for
the dashboard to render a summary such as `Alice Adams called Bob Brown`.

For a caller who is not a participant in any open group on that relay number,
`resolveRelayInbound` selects the newest open group and `handleMaskedInbound`
refuses the call. It creates no participant leg, but it does store a masked call
row on that selected group. Today the refusal row deliberately drops the inbound
phone number, has no `relay_sender_key`, and renders as the generic `Incoming
call` with a `Missed` outcome. Staff cannot tell whether this was a known contact,
a wrong number, or a caller using an unexpected phone.

That generic presentation also makes a false implication. No relay participant
was dialed, so nobody missed an opportunity to answer. The call was refused
before a bridge and is better described as `Not connected`.

The existing omission is intentional privacy behavior, not a broken renderer.
This mission changes the privacy and retention contract for new non-member relay
calls while preserving the masked bridge and every participant-facing safeguard.

## 2. Goal

For each new call from a non-member to a relay number that is recorded on an open
relay group, give an authenticated staff user enough information to understand
what happened:

- show the current name when the number matched an existing, non-deleted contact
  when the call arrived;
- otherwise show the formatted caller number when usable caller ID was supplied;
- otherwise show `unknown caller`;
- state `Not connected`, because the system created no participant leg;
- reveal the phone, contact link or no-link explanation, non-member explanation,
  and precise time from a real `Details` control; and
- never create a contact, change the relay roster, bridge the call, or expose the
  identity on a participant-facing surface.

## 3. Locked product decisions

These decisions were approved by the human on 2026-08-28.

### D1. Identity is visible on the card face

The primary line is one of:

- `Morgan Lee tried to call this relay number`
- `(617) 555-0198 tried to call this relay number`
- `An unknown caller tried to call this relay number`

The identity is plain text on the face. A matched contact link appears only in
the expanded details, so the card does not turn its primary reading surface into
an accidental navigation target.

The copy says `this relay number`, not `this relay group`. One relay number can
front several groups, and the non-member resolver selects the newest open group
only for the record. The system knows which number was called and where it filed
the row; it does not know which group the caller intended.

### D2. `Not connected` replaces `Missed` for this state

Only a row carrying the machine-readable non-member refusal reason receives the
`Not connected` presentation. Existing member calls and other call types retain
their existing presenter and outcome vocabulary.

The stored lifecycle facts may remain `call_status: 'no-answer'` and
`call_outcome: 'missed'` for compatibility. The explicit refusal reason is the
stronger fact for the card; the UI must not parse `call_party_label` text to
infer it.

### D3. Secondary facts are behind `Details`

The visible card retains its existing time at minute precision. A real button,
with `aria-expanded` and a card-specific accessible name, reveals:

- the formatted caller phone, or `Caller ID unavailable`;
- `Not a participant in this relay group`;
- `View contact` when the stored contact ID still resolves to a non-deleted
  display name;
- otherwise `No linked contact`; and
- the full local date and time including seconds.

Add `formatDateTimeWithSeconds` beside the existing Timeline formatters. It
normalizes a clean ISO instant or `<ISO>#<suffix>` through `isoOf`, then uses
the viewer's local timezone with `en-US` month, day, year, hour, minute, and
second fields (for example `Aug 28, 2026, 12:21:16 PM`). An unparseable instant
returns the visible fallback `Time unavailable`; it must never render an empty
detail row or the opaque message ID as a human-facing time.

The expanded facts are staff-facing. The existing decorative direction arrow
remains hidden from assistive technology.

### D4. Match once at arrival; never create or retroactively link

For a valid E.164 caller number, the webhook performs the existing indexed phone
lookup. It stores a contact ID only when that lookup returns a non-deleted
contact. It does not require a particular domain `status`; `deleted_at` is the
deletion fence.

An unmatched number remains unmatched forever. Creating a contact with that
number later does not rewrite or reinterpret the historical call. The read path
resolves a name only from the stored contact ID and must never match by the
stored phone.

A matched contact is also not made a relay participant. `author` remains
`unknown`, `relay_sender_key` remains absent, no roster write occurs, and no
bridge is attempted.

The existing voice handler remains the sole owner of membership and routing.
After that handler has already derived `reason === 'non_member'`, it normalizes
the webhook `From`, performs the contact lookup and deletion check, and supplies
those persistence facts to the existing `messages.append` call. No second
operation re-resolves the relay, derives a refusal reason, or decides whether to
bridge.

### D5. Store facts, not rendered copy

The actual call item in the DynamoDB messages table stores the refusal reason,
normalized phone when available, and optional matched contact ID. It does not
store a name, formatted phone, sentence, outcome label, or details copy.

The authenticated read path hydrates the current contact display name from the
stored ID. A later contact rename therefore updates the displayed name. A
missing display record falls back to the stored phone, then to `unknown caller`.

If that contact is soft-deleted after the call, the card also falls back to the
stored phone and omits `View contact`; ordinary staff lists already treat the
deletion fence as absence. If the contact is later restored, its current name
and link return because the historical call still holds the original contact
ID. The display projection must therefore include `deleted_at` even though no
name or deletion flag is persisted on the call item.

### D6. Staff/developer disclosure is allowed; participant disclosure is not

The external number is operational data. It may appear in:

- the DynamoDB call item;
- authenticated staff APIs and dashboard UI;
- developer logs and internal events when independently useful; and
- staff-facing notifications or messages.

It must not appear in:

- the TwiML `<Say>` response;
- any participant dial target other than the existing intended bridge behavior;
- bridged-leg caller ID;
- SMS, MMS, email, voice announcements, or notifications sent to relay
  participants or the external caller; or
- public or unauthenticated responses.

Permission to include the number on an internal surface is not a requirement to
copy it there. This mission adds no new log, event, notification, or outbound
message payload merely to duplicate the stored value.

### D7. Forward only

Only calls ingested after deployment gain these facts and the new presentation.
There is no backfill, inference from logs, production script, migration, or
attempt to alter the existing generic rows.

## 4. Load-bearing invariants

### I1. Resolution does not prove intent

`resolveRelayInbound(groups, From)` deliberately selects the newest open group
for a non-member caller. That selection determines where the record lives, not
which group the caller intended to reach. Copy may say the call came into the
relay number and that the caller was not a participant in the selected group;
it may not claim the caller targeted that group.

### I2. A non-member call never creates a participant leg

The existing refusal response remains a masked `<Say>` plus `<Hangup>` with no
`<Dial>`. Contact matching is display-only and must run after the routing
decision. Finding a HousingChoice contact by phone must never promote the result
to `open_member`, mutate the roster, or bridge the call.

### I3. The roster identity key keeps one meaning

`relay_sender_key` identifies a current relay roster member. The feature must
not put `phone#<external number>` or a matched external contact ID into that
field. New identity belongs in explicit non-member fields so existing member
attribution cannot mistake a contact match for relay membership.

### I4. Existing relay-member cards do not change

Rows without `relay_refusal_reason: 'non_member'` continue through
`relayCallSummary` and `presentCallState` unchanged. In particular, the existing
`Alice called Bob` behavior, bridge status updates, duration, member-name
hydration, recording prohibition, and legacy fallback remain intact.

### I5. Only normalized phone data is durable

The stored external caller phone is the result of `normalizeToE164(From)`. A
withheld, anonymous, malformed, or otherwise non-normalizable `From` value is
not copied into the call item. The refusal reason is still stored, allowing the
UI to render `unknown caller` and `Caller ID unavailable`.

### I6. Display hydration is ID-only and bounded

The messages endpoint collects unique stored external contact IDs from the
current page and calls `contacts.getDisplaysByIds` once. It performs no N+1
reads and no phone lookups. Missing or unprocessed display rows degrade to the
stored phone. A page with no external contact IDs performs no display read.

The display projection includes `deleted_at`, and hydration ignores a display
row for which `isDeleted` is true. The batch read is optional enrichment, not a
new availability dependency: if `getDisplaysByIds` rejects, the route catches
and logs that failure and returns the unhydrated message page with its persisted
phone fallback. A contact-table read failure must never turn the relay timeline
into a 500.

### I7. Masked calls remain content-free

The new fields are metadata. A masked relay call still has no recording,
transcript, media, or participant content, and `useRelayThread` continues to
strip those fields defensively. The new phone and contact fields are carried
only because this mission explicitly permits them for authenticated staff.

### I8. The participant-facing surface remains phone-free

The refusal TwiML, caller ID masking, and no-bridge behavior are unchanged and
covered by tests. No formatter used by the participant whisper or announcement
may consume the external caller fields. Existing role/name-only
`call_party_label` and `maskedPartyLabel` contracts remain phone-free.

### I9. The first successful append is history

The CallSid remains the append idempotency key. A redelivered webhook may repeat
the contact lookup, but a deduped append does not enrich or rewrite the original
call item. This preserves the match-at-arrival rule and prevents webhook timing
from silently changing history.

### I10. Identity lookup is best-effort; call recording is not

Failure of the new non-member `findByPhone` lookup must not stop the existing
refusal TwiML or prevent the call row from being recorded. On that new lookup
failure, persist the normalized phone without a contact ID and log the
operational error. The existing roster-member lookup and every other refusal
path remain outside this feature and keep their current behavior. The UI
truthfully says `No linked contact`; it does not assert that no contact existed.

### I11. Append enforces the new storage shape, not routing

`NewMessage` exposes the three new optional persistence facts. The generic
`messages.append` boundary rejects them unless the row is a masked inbound call
with `relayRefusalReason: 'non_member'`, `author: 'unknown'`, and no
`relaySenderKey`. Any stored phone must pass `isE164`, and a contact ID requires
a phone. These are storage-shape checks only. The append path does not load a
conversation, inspect a roster, derive a refusal reason, or choose bridge versus
hangup; the existing voice handler remains authoritative for those decisions.

## 5. Data model

No DynamoDB table, index, migration, or backfill is required. The messages table
already stores flexible call-item attributes.

Add three optional write-shape facts to `NewMessage`:

```ts
relayRefusalReason?: 'non_member';
relayExternalCallerPhone?: string;
relayExternalCallerContactId?: string;
```

Add their persisted `MessageItem` forms:

```ts
relay_refusal_reason?: 'non_member';
relay_external_caller_phone?: string;
relay_external_caller_contact_id?: string;
```

`messages.append` maps the camel-case facts onto the snake-case attributes after
performing the I11 storage-shape checks. The voice handler supplies them only in
its existing `reason === 'non_member'` refusal branch. Closed-thread,
no-callee, and no-pool-number rows do not gain the reason or identity fields and
keep their current write behavior.

The persisted fields stay optional because DynamoDB rows are flexible and old
rows contain none of them.

The general comments that currently say a masked call can never carry a raw
counterpart phone must be narrowed. `call_party_label`, `relay_sender_key`,
whisper labels, recordings, and transcripts remain protected; the explicit
normalized external-caller field is the one approved exception.

The authenticated messages response may add this response-only field:

```ts
relay_external_caller_display_name?: string;
```

It is derived from the current `firstName` and `lastName` returned for the stored
contact ID. It is never written back to DynamoDB. A blank, missing, or currently
soft-deleted contact omits the response field. `ContactDisplayItem` and its
shared projection gain optional `deleted_at` so this policy is implementable;
existing display consumers may ignore the additional projected attribute.

The dashboard `Message` and `TimelineCall` types declare the persisted fields
and the response-only display name. The call-card renderer receives no freeform
precomposed sentence from the server.

## 6. Write path

The change stays inside the existing refusal arm in
`app/src/routes/webhooks/voice.ts`. The current handler continues to compute
`isClosed`, `caller`, `callees`, and `reason`, decide that the call will not
bridge, and return the existing masked refusal TwiML.

Only after `reason` has already been computed:

1. Initialize no external caller facts.
2. If and only if `reason === 'non_member'`, normalize `From`.
3. If the normalized phone exists, call `contacts.findByPhone(phone)` inside a
   best-effort error boundary.
4. Store the returned contact ID only when the matched contact is not deleted.
5. If the lookup throws, warn and retain the normalized phone only.
6. Call the existing `messages.append` with its current fields plus
   `relayRefusalReason: 'non_member'` and the optional phone/contact ID.
7. Preserve the current append catch, event emission, log, and `Say` plus
   `Hangup` response.

There is no second operation that resolves the relay, checks membership, derives
the refusal reason, or decides whether to bridge. No changes are made to
`resolveRelayInbound`, the routing ladder, caller/callee selection, the refusal
branch condition, reason precedence, bridge TwiML, refusal TwiML, caller ID,
call status/outcome, `callPartyLabel`, `author`, `relay_sender_key`, the
closed-thread flag, or any participant-facing action. A matched contact is
display metadata only.

## 7. Authenticated read path

`GET /api/conversations/:conversationId/messages` currently returns a page of
stored rows. Before responding:

1. collect unique, non-empty `relay_external_caller_contact_id` values;
2. batch-read their display projections with `contacts.getDisplaysByIds` inside
   a best-effort error boundary;
3. ignore missing, unprocessed, and soft-deleted display rows;
4. derive a trimmed first/last display name when possible;
5. add `relay_external_caller_display_name` to only the corresponding response
   objects; and
6. leave the stored rows untouched.

This hydration happens independently for each page, works for the initial page
and `Load older`, and degrades to the stored phone if a display row is absent.
If the batch call rejects, warn with operational context and return the whole
page unhydrated. The endpoint is authenticated; no public route gains these
fields.

`GET /api/calls/:callId` may continue returning the authenticated raw call item,
including the newly persisted facts. It does not need name hydration for this
dashboard flow.

## 8. Dashboard mapping and presentation

### 8.1 Relay-thread mapping

`useRelayThread.toTimelineMessage` carries the following safe staff metadata
onto `TimelineCall` when present:

- `relay_refusal_reason`
- `relay_external_caller_phone`
- `relay_external_caller_contact_id`
- `relay_external_caller_display_name`

It continues dropping recordings, transcripts, provider IDs, and media for all
masked relay calls.

### 8.2 Identity presenter

Add a small pure presenter for a non-member refusal with this precedence:

1. non-empty hydrated display name;
2. formatted stored E.164 phone;
3. `unknown caller`.

The presenter is reachable only when
`relay_refusal_reason === 'non_member'`. It returns the primary copy and the
detail facts; it never examines the current relay roster or matches a contact by
phone.

### 8.3 Call card

For a non-member refusal:

- `callWho` is `<presented identity> tried to call this relay number`, except
  the unavailable-identity form is `An unknown caller tried to call this relay
  number`;
- the chip is `Not connected` with the existing non-success tone;
- duration is omitted when absent as today;
- the minute-level time remains on the face;
- `Details` is always present because even the caller-ID-unavailable state has
  meaningful refusal and precise-time facts; and
- expansion renders the D3 facts.

The visible precise-time detail uses `formatDateTimeWithSeconds(call.at)` and
therefore renders a full local date/time or `Time unavailable`. It is distinct
from `formatTimeWithSeconds`, which remains the compact accessible-name clock.

The card's accessible group name uses the same primary identity plus the
existing seconds-precision timestamp or row-ID fallback. The Details button's
accessible name remains card-specific. Tests must prove two calls in one minute
remain independently addressable.

For every other call, the current summary, state presenter, details behavior,
recording, and transcript rendering are unchanged.

## 9. State matrix

| New inbound state | Card face | Chip | Expanded identity |
| --- | --- | --- | --- |
| Current relay member | Existing `A called B` | Existing call state | Existing behavior |
| Non-member, stored contact ID resolves to `Morgan Lee` | `Morgan Lee tried to call this relay number` | `Not connected` | Phone, `View contact`, non-member note, precise time |
| Non-member, usable phone, no stored contact ID | `(617) 555-0198 tried to call this relay number` | `Not connected` | Phone, `No linked contact`, non-member note, precise time |
| Non-member, stored contact ID is missing or soft-deleted | Formatted phone plus `tried to call this relay number`, else the unknown-caller copy | `Not connected` | No link, non-member note, precise time |
| Non-member, stored contact ID is restored | Current contact name | `Not connected` | Phone, `View contact`, non-member note, precise time |
| Non-member, caller ID unavailable | `An unknown caller tried to call this relay number` | `Not connected` | `Caller ID unavailable`, `No linked contact`, non-member note, precise time |
| Any historical row without the new reason | Existing presentation | Existing call state | Existing behavior |

## 10. Verification design

Implementation follows test-driven development.

### 10.1 Server unit and route coverage

Extend the real signed-webhook suite to prove:

- a non-member valid phone is stored with `relay_refusal_reason: 'non_member'`;
- a matching non-deleted contact adds the stored contact ID but remains
  `author: 'unknown'` with no `relay_sender_key`;
- an unmatched number stores the phone and no contact ID;
- a deleted contact is not linked;
- a non-normalizable caller stores neither phone nor contact ID;
- a new `findByPhone` failure still records the phone-only call and returns the
  existing refusal TwiML;
- `messages.append` rejects, before any DynamoDB write, external identity on a
  non-call, outbound, unmasked, or missing/non-`non_member` refusal; a non-E.164
  phone; a contact ID without a phone; and a non-member refusal with a
  `relay_sender_key` or non-`unknown` author;
- `closed_thread`, `no_callee`, and `no_pool_number` writes remain unchanged and gain
  none of the new fields;
- redelivery does not rewrite an earlier unmatched call;
- no refusal response contains the caller, pool, or participant phone and no
  `<Dial>` is emitted; and
- no contact or roster mutation occurs.

Extend repository tests to prove the three optional facts map to the correct
snake-case attributes, remain absent when inapplicable, and reject every I11
illegal storage shape.

Extend the authenticated messages API tests to prove:

- one batch display read hydrates all unique contact IDs on a page;
- duplicate IDs do not create duplicate reads;
- no IDs means no display read;
- missing display rows fall back by omitting the response-only name;
- a rejected batch display read returns the full unhydrated page rather than a
  500;
- a contact deleted after the call loses its name/link and a later restore
  returns them;
- deleted display rows are not hydrated; and
- stored repository objects are not mutated by response hydration.

### 10.2 Dashboard unit coverage

Extend `useRelayThread` and Timeline tests for every row in the state matrix,
including:

- name, phone, and unknown-caller precedence;
- `Not connected` only for the non-member reason;
- no current-roster inference for a non-member refusal;
- no phone-based contact hydration;
- plain-text identity on the face and contact link only in Details;
- Details collapsed by default, correct `aria-expanded`, precise time, phone or
  unavailable copy, non-member note, and no-link state;
- `formatDateTimeWithSeconds` renders the full local date/time and the visible
  `Time unavailable` fallback without changing the compact accessible clock;
- existing member `A called B` and ordinary inbound `Missed` behavior unchanged;
- masked media/transcript fields still dropped; and
- two same-minute cards retain unique accessible names and controls.

### 10.3 Focused end-to-end proof

Add or extend a dashboard-next Relay spec using the fake Twilio voice control
API and the hermetic stack:

1. reseed a deterministic world with one target open relay group;
2. place a real fake inbound call from a valid non-member phone to its pool
   number;
3. prove the fake received refusal without creating a participant leg;
4. open the relay group as an authenticated staff user;
5. assert the number-facing card and `Not connected` chip;
6. expand Details and assert the phone, no-link state, non-member explanation,
   and precise time; and
7. prove no contact was created.

A second focused path may use a seeded non-roster contact to exercise current
name hydration and the `View contact` link if the existing seed exposes that
state without expanding the fixture surface. Otherwise the real server and UI
unit suites cover that branch.

The implementation plan must name exact targeted checks for each slice. Final
feature-mission completion still requires the repository's full bare gates,
touched-file ESLint ratchet, independent review, and live hermetic UI QA.

## 11. Deployment and compatibility

The optional fields are forward-compatible in either application order:

- old dashboard plus new server ignores the new attributes;
- new dashboard plus old server sees no refusal reason and retains the current
  generic presentation.

No feature flag, environment variable, infrastructure mutation, table change,
or production backfill is required. Deployment and any production validation
remain human-owned.

## 12. Non-goals

- Backfilling or changing the two existing production rows.
- Creating an `unknown` contact or offering a `Create contact` action.
- Matching a historical unmatched call after a contact is later created.
- Adding an external caller to the relay roster.
- Moving, duplicating, or revalidating the existing membership, routing, or
  refusal decision outside the voice handler.
- Bridging a non-member call or changing `resolveRelayInbound` selection policy.
- Persisting a new reason for any refusal other than `non_member`.
- Changing all-closed non-member fallthrough to founder triage.
- Reverse lookup, spam scoring, number-owner discovery, or previous-owner logic.
- Changing relay inbox preview copy, unread behavior, or last-activity rules.
- Adding the phone to logs, events, push notifications, or outbound messages.
- Changing the presentation of closed-thread, no-callee, or no-pool refusals.
- Changing masked recording/transcription behavior.
- Changing retention, encryption, or access-control policy outside the explicit
  authenticated staff fields in this spec.

## 13. Files expected to change

The plan must verify exact paths against the live tree, but the expected surface
is:

- `app/src/repos/messagesRepo.ts`
- `app/src/routes/webhooks/voice.ts`
- `app/src/routes/api.ts`
- `app/test/voiceWebhook.test.ts`
- the messages repository and relay API test files selected during planning
- `dashboard/src/api/types.ts`
- `dashboard/src/routes/conversation/useRelayThread.ts`
- `dashboard/src/routes/conversation/useRelayThread.test.tsx`
- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.module.css` only if the existing detail
  layout cannot express the approved content
- `dashboard/src/routes/contact/Timeline.test.tsx`
- one focused `e2e/tests/dashboard-next/*.spec.ts` Relay voice/UI path

No new runtime dependency is expected.
